import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'path'
import fs from 'fs'
import os from 'os'
import net from 'net'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { createHash } from 'crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..')
const EXPECTED_VERSION = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'version.json'), 'utf8')).version
const EXTERNAL_SERVER = process.env.TEST_PORT !== undefined
let BASE
let fixtureRoot
let fixtureHome
let fixturePath
let serverProcess
let serverOutput = ''
let toolFixture

// ── Synthetic session for deterministic testing ─────────────────────────────

const TEST_SESSION_ID = `test-feather-${Date.now()}`
let testSessionDir
let testSessionPath

function writeLine(obj) {
  fs.appendFileSync(testSessionPath, JSON.stringify(obj) + '\n')
}

async function allocatePort() {
  return await new Promise((resolve, reject) => {
    const socket = net.createServer()
    socket.unref()
    socket.once('error', reject)
    socket.listen(0, '127.0.0.1', () => {
      const { port } = socket.address()
      socket.close(error => error ? reject(error) : resolve(port))
    })
  })
}

async function waitForServer() {
  let lastError
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(500) })
      const health = await response.json()
      if (response.ok && health.status === 'ok' && health.version === EXPECTED_VERSION) return
      lastError = new Error(`unexpected health response: HTTP ${response.status} ${JSON.stringify(health)}`)
    } catch (error) {
      lastError = error
    }
    if (serverProcess && (serverProcess.exitCode !== null || serverProcess.signalCode !== null)) {
      throw new Error(`test server exited (${serverProcess.signalCode || `code ${serverProcess.exitCode}`})\n${serverOutput}`)
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`test server did not report exact version ${EXPECTED_VERSION}: ${lastError?.message}\n${serverOutput}`)
}

async function readOmpSseEvents(reader, minimum) {
  const decoder = new TextDecoder()
  let payload = ''
  while ((payload.match(/event: omp_event/g) || []).length < minimum) {
    const read = await Promise.race([
      reader.read(),
      new Promise(resolve => setTimeout(() => resolve(null), 2_000)),
    ])
    if (!read || read.done || !read.value) break
    payload += decoder.decode(read.value)
  }
  const events = payload.split('\n\n').flatMap((frame) => {
    if (!frame.includes('event: omp_event')) return []
    const data = frame.split('\n').find(line => line.startsWith('data: '))
    return data ? [JSON.parse(data.slice(6))] : []
  })
  return { events, payload }
}

before(async () => {
  let port
  let stateDir
  if (EXTERNAL_SERVER) {
    port = Number(process.env.TEST_PORT)
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new Error('TEST_PORT must be an integer from 1 through 65535')
    }
    if (!process.env.TEST_HOME || !path.isAbsolute(process.env.TEST_HOME)) {
      throw new Error('external-server mode requires an absolute TEST_HOME matching the isolated server HOME')
    }
    fixtureHome = process.env.TEST_HOME
    BASE = `http://127.0.0.1:${port}`
  } else {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-api-test-'))
    fixtureHome = path.join(fixtureRoot, 'home')
    stateDir = path.join(fixtureRoot, 'state')
    port = await allocatePort()
    BASE = `http://127.0.0.1:${port}`
    fs.mkdirSync(fixtureHome, { recursive: true })
    const fixtureBin = path.join(fixtureRoot, 'bin')
    fs.mkdirSync(fixtureBin)
    fs.writeFileSync(path.join(fixtureBin, 'tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
    fixturePath = `${fixtureBin}${path.delimiter}${process.env.PATH || ''}`
  }

  const testProjectDir = path.join(fixtureHome, '.claude/projects/-api-test-project')
  fs.mkdirSync(testProjectDir, { recursive: true })

  if (!EXTERNAL_SERVER) {
    serverProcess = spawn(process.execPath, ['server-single.js'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: fixtureHome,
        FEATHER_STATE_DIR: stateDir,
        FEATHER_DEEPGRAM_API_KEY: '',
        PORT: String(port),
        PATH: fixturePath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const captureOutput = chunk => {
      serverOutput = `${serverOutput}${chunk}`.slice(-16_384)
    }
    serverProcess.stdout.on('data', captureOutput)
    serverProcess.stderr.on('data', captureOutput)
  }

  await waitForServer()

  // Create a synthetic session JSONL in the isolated project directory.
  testSessionDir = testProjectDir
  testSessionPath = path.join(testSessionDir, `${TEST_SESSION_ID}.jsonl`)
  toolFixture = path.join(fixtureHome, 'tool-preview.svg')
  fs.writeFileSync(toolFixture, '<svg xmlns="http://www.w3.org/2000/svg"></svg>')

  // Seed with known messages
  writeLine({
    type: 'user', uuid: 'api-test-0001', timestamp: '2025-06-15T12:00:00Z',
    isSidechain: false, isMeta: false,
    message: { role: 'user', content: 'What is the meaning of life?' },
  })
  writeLine({
    type: 'assistant', uuid: 'api-test-0002', timestamp: '2025-06-15T12:00:05Z',
    isSidechain: false, isMeta: false,
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'The answer is **42**, according to Douglas Adams.' },
        { type: 'thinking', thinking: 'Classic reference to Hitchhiker\'s Guide.' },
      ],
    },
  })
  writeLine({
    type: 'assistant', uuid: 'api-test-0003', timestamp: '2025-06-15T12:00:10Z',
    isSidechain: false, isMeta: false,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tool_x', name: 'Read', input: { file_path: '/meaning.txt' } }],
    },
  })
  writeLine({
    type: 'assistant', uuid: 'api-test-0004', timestamp: '2025-06-15T12:00:12Z',
    isSidechain: false, isMeta: false,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_result', tool_use_id: 'tool_x', content: 'forty-two', is_error: false }],
    },
  })

  // Give fs.watch a moment to pick up the new file
  await new Promise(r => setTimeout(r, 500))
})

after(async () => {
  // Clean up synthetic session
  try { fs.unlinkSync(testSessionPath) } catch {}
  try { fs.unlinkSync(toolFixture) } catch {}
  if (serverProcess && serverProcess.exitCode === null && serverProcess.signalCode === null) {
    serverProcess.kill('SIGTERM')
    await Promise.race([
      new Promise(resolve => serverProcess.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 2000)),
    ])
    if (serverProcess.exitCode === null && serverProcess.signalCode === null) {
      serverProcess.kill('SIGKILL')
      await new Promise(resolve => serverProcess.once('exit', resolve))
    }
  }
  if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true })
})

// ── Health ───────────────────────────────────────────────────────────────────

describe('GET /api/health', () => {
  it('returns ok with numeric uptime', async () => {
    const r = await fetch(`${BASE}/api/health`)
    assert.equal(r.status, 200)
    const body = await r.json()
    assert.equal(body.status, 'ok')
    assert.ok(body.uptime > 0)
    assert.equal(body.capabilities.maxUploadBytes, 50 * 1024 * 1024)
    assert.equal(body.capabilities.maxAudioBytes, 25 * 1024 * 1024)
  })
})

// ── Durable/idempotent uploads ─────────────────────────────────────────────

describe('POST /api/upload', () => {
  it('reuses an upload id for identical bytes and rejects conflicting bytes', async () => {
    const uploadId = `testmedia-${Date.now()}`
    const headers = { 'Content-Type': 'text/plain', 'X-Filename': encodeURIComponent('recovery.txt'), 'X-Upload-ID': uploadId }
    let storedPath
    try {
      const first = await fetch(`${BASE}/api/upload`, { method: 'POST', headers, body: 'durable-media' })
      assert.equal(first.status, 200)
      const firstBody = await first.json()
      storedPath = firstBody.path
      assert.equal(fs.readFileSync(storedPath, 'utf8'), 'durable-media')

      const retry = await fetch(`${BASE}/api/upload`, { method: 'POST', headers, body: 'durable-media' })
      assert.equal(retry.status, 200)
      const retryBody = await retry.json()
      assert.equal(retryBody.path, storedPath)
      assert.equal(retryBody.reused, true)

      const conflict = await fetch(`${BASE}/api/upload`, { method: 'POST', headers, body: 'different-media' })
      assert.equal(conflict.status, 409)
      assert.match((await conflict.json()).error, /different content/)
      assert.equal(fs.readFileSync(storedPath, 'utf8'), 'durable-media')
    } finally {
      if (storedPath) try { fs.unlinkSync(storedPath) } catch {}
    }
  })

  it('rejects malformed idempotency keys', async () => {
    const r = await fetch(`${BASE}/api/upload`, { method: 'POST', headers: { 'X-Upload-ID': '../bad' }, body: 'x' })
    assert.equal(r.status, 400)
  })

  it('returns a stable JSON 413 for a declared oversized upload', async () => {
    const r = await fetch(`${BASE}/api/upload`, {
      method: 'POST',
      headers: { 'Content-Length': String((50 * 1024 * 1024) + 1) },
      body: Buffer.alloc((50 * 1024 * 1024) + 1),
    })
    assert.equal(r.status, 413)
    assert.deepEqual(await r.json(), { error: 'upload exceeds 50 MB limit' })
  })
})

// ── Retired surfaces ───────────────────────────────────────────────────────

describe('retired Auto and CoS APIs', () => {
  it('returns a JSON 404 for the exact API root', async () => {
    const r = await fetch(`${BASE}/api`)
    assert.equal(r.status, 404)
    assert.ok(r.headers.get('content-type').includes('application/json'))
    assert.deepEqual(await r.json(), { error: 'not found' })
  })

  for (const endpoint of ['/api/auto/instances', '/api/cos/workstreams']) {
    it(`returns a JSON 404 for GET ${endpoint}`, async () => {
      const r = await fetch(`${BASE}${endpoint}`)
      assert.equal(r.status, 404)
      assert.ok(r.headers.get('content-type').includes('application/json'))
      assert.deepEqual(await r.json(), { error: 'not found' })
    })

    it(`returns a JSON 404 for POST ${endpoint}`, async () => {
      const r = await fetch(`${BASE}${endpoint}`, { method: 'POST' })
      assert.equal(r.status, 404)
      assert.ok(r.headers.get('content-type').includes('application/json'))
      assert.deepEqual(await r.json(), { error: 'not found' })
    })
  }
})

// ── Sessions ────────────────────────────────────────────────────────────────

describe('GET /api/sessions', () => {
  it('returns array of sessions', async () => {
    const r = await fetch(`${BASE}/api/sessions`)
    assert.equal(r.status, 200)
    const { sessions } = await r.json()
    assert.ok(Array.isArray(sessions))
    assert.ok(sessions.length > 0, 'expected at least one session')
  })

  it('every session has id, title, updatedAt, isActive', async () => {
    const { sessions } = await (await fetch(`${BASE}/api/sessions`)).json()
    for (const s of sessions) {
      assert.ok(typeof s.id === 'string' && s.id.length > 0, 'bad id')
      assert.ok(typeof s.title === 'string' && s.title.length > 0, 'bad title')
      assert.ok(typeof s.updatedAt === 'string', 'bad updatedAt')
      assert.ok(!isNaN(new Date(s.updatedAt).getTime()), 'updatedAt not valid ISO date')
      assert.ok(typeof s.isActive === 'boolean', 'isActive not boolean')
    }
  })

  it('limit=3 returns at most 3 sessions', async () => {
    const { sessions } = await (await fetch(`${BASE}/api/sessions?limit=3`)).json()
    assert.ok(sessions.length <= 3)
  })

  it('sessions are sorted by updatedAt descending', async () => {
    const { sessions } = await (await fetch(`${BASE}/api/sessions?limit=20`)).json()
    for (let i = 1; i < sessions.length; i++) {
      const prev = new Date(sessions[i - 1].updatedAt).getTime()
      const curr = new Date(sessions[i].updatedAt).getTime()
      assert.ok(prev >= curr, `sessions not sorted: ${sessions[i-1].updatedAt} < ${sessions[i].updatedAt}`)
    }
  })

  it('our test session appears in the list', async () => {
    const { sessions } = await (await fetch(`${BASE}/api/sessions?limit=50`)).json()
    const found = sessions.find(s => s.id === TEST_SESSION_ID)
    assert.ok(found, `test session ${TEST_SESSION_ID} not found`)
    assert.equal(found.title, 'What is the meaning of life?')
  })

  it('finds an exact session by id for deep-link activity checks', async () => {
    const { sessions } = await (await fetch(`${BASE}/api/sessions?q=${encodeURIComponent(TEST_SESSION_ID)}&limit=5`)).json()
    assert.ok(sessions.some(session => session.id === TEST_SESSION_ID))
  })
})

// ── Messages ────────────────────────────────────────────────────────────────

describe('GET /api/sessions/:id/messages', () => {
  it('returns empty array for nonexistent session', async () => {
    const { messages } = await (await fetch(`${BASE}/api/sessions/no-such-session-ever/messages`)).json()
    assert.deepEqual(messages, [])
  })

  it('returns correct messages for test session', async () => {
    const { messages } = await (await fetch(`${BASE}/api/sessions/${TEST_SESSION_ID}/messages`)).json()
    assert.equal(messages.length, 4)

    // First message: user
    assert.equal(messages[0].uuid, 'api-test-0001')
    assert.equal(messages[0].role, 'user')
    assert.equal(messages[0].content[0].text, 'What is the meaning of life?')

    // Second message: assistant with text + thinking
    assert.equal(messages[1].uuid, 'api-test-0002')
    assert.equal(messages[1].role, 'assistant')
    assert.equal(messages[1].content[0].type, 'text')
    assert.ok(messages[1].content[0].text.includes('**42**'))
    assert.equal(messages[1].content[1].type, 'thinking')

    // Third: tool_use
    assert.equal(messages[2].content[0].type, 'tool_use')
    assert.equal(messages[2].content[0].name, 'Read')

    // Fourth: tool_result
    assert.equal(messages[3].content[0].type, 'tool_result')
    assert.equal(messages[3].content[0].content, 'forty-two')
  })

  it('limit parameter truncates from the front', async () => {
    const { messages } = await (await fetch(`${BASE}/api/sessions/${TEST_SESSION_ID}/messages?limit=2`)).json()
    assert.equal(messages.length, 2)
    // Should be the last 2 messages (tool_use, tool_result)
    assert.equal(messages[0].uuid, 'api-test-0003')
    assert.equal(messages[1].uuid, 'api-test-0004')
  })

  it('messages preserve timestamps', async () => {
    const { messages } = await (await fetch(`${BASE}/api/sessions/${TEST_SESSION_ID}/messages`)).json()
    assert.equal(messages[0].timestamp, '2025-06-15T12:00:00Z')
    assert.equal(messages[1].timestamp, '2025-06-15T12:00:05Z')
  })
})

// ── SSE ─────────────────────────────────────────────────────────────────────

describe('GET /api/sessions/:id/stream (SSE)', () => {
  it('sends connected event on open', async () => {
    const ctrl = new AbortController()
    try {
      const r = await fetch(`${BASE}/api/sessions/${TEST_SESSION_ID}/stream`, {
        signal: ctrl.signal,
        headers: { Accept: 'text/event-stream' },
      })
      assert.equal(r.status, 200)
      assert.ok(r.headers.get('content-type').includes('text/event-stream'))
      assert.equal(r.headers.get('cache-control'), 'no-cache')

      const reader = r.body.getReader()
      const { value } = await reader.read()
      const text = new TextDecoder().decode(value)
      assert.ok(text.includes('event: connected'))
    } finally {
      ctrl.abort()
    }
  })

  it('delivers new messages written to JSONL', async () => {
    // Subscribe to SSE
    const ctrl = new AbortController()
    const receivedMessages = []

    try {
      const r = await fetch(`${BASE}/api/sessions/${TEST_SESSION_ID}/stream`, {
        signal: ctrl.signal,
      })
      const reader = r.body.getReader()
      const decoder = new TextDecoder()

      // Read and discard the "connected" event
      await reader.read()

      // Now append a new message to the JSONL file
      const newUuid = `sse-live-${Date.now()}`
      writeLine({
        type: 'user', uuid: newUuid, timestamp: '2025-06-15T12:01:00Z',
        isSidechain: false, isMeta: false,
        message: { role: 'user', content: 'This message was written during the SSE test' },
      })

      // Read from SSE — should receive the new message
      const deadline = Date.now() + 5000
      let accumulated = ''
      while (Date.now() < deadline) {
        const readPromise = reader.read()
        const timeoutPromise = new Promise(r => setTimeout(() => r({ done: true }), 2000))
        const { value, done } = await Promise.race([readPromise, timeoutPromise])
        if (done || !value) break
        accumulated += decoder.decode(value)
        if (accumulated.includes(newUuid)) break
      }

      assert.ok(accumulated.includes(newUuid), `SSE did not deliver message. Got: ${accumulated.slice(0, 200)}`)
      assert.ok(accumulated.includes('event: message'))

      // Parse the SSE data
      const dataLine = accumulated.split('\n').find(l => l.startsWith('data: ') && l.includes(newUuid))
      assert.ok(dataLine, 'no data line found')
      const parsed = JSON.parse(dataLine.replace('data: ', ''))
      assert.equal(parsed.uuid, newUuid)
      assert.equal(parsed.role, 'user')
      assert.equal(parsed.content[0].text, 'This message was written during the SSE test')
    } finally {
      ctrl.abort()
    }
  })

  it('SSE does not deliver sidechain messages', async () => {
    const ctrl = new AbortController()
    try {
      const r = await fetch(`${BASE}/api/sessions/${TEST_SESSION_ID}/stream`, { signal: ctrl.signal })
      const reader = r.body.getReader()
      const decoder = new TextDecoder()
      await reader.read() // connected

      // Write a sidechain message
      writeLine({
        type: 'assistant', uuid: 'sse-sidechain-test', timestamp: '2025-06-15T12:02:00Z',
        isSidechain: true, isMeta: false,
        message: { role: 'assistant', content: [{ type: 'text', text: 'sidechain noise' }] },
      })

      // Then write a normal message so we know SSE is working
      const markerUuid = `sse-marker-${Date.now()}`
      writeLine({
        type: 'user', uuid: markerUuid, timestamp: '2025-06-15T12:02:01Z',
        isSidechain: false, isMeta: false,
        message: { role: 'user', content: 'marker message' },
      })

      // Read until we see the marker
      let accumulated = ''
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        const readPromise = reader.read()
        const timeoutPromise = new Promise(r => setTimeout(() => r({ done: true }), 2000))
        const { value, done } = await Promise.race([readPromise, timeoutPromise])
        if (done || !value) break
        accumulated += decoder.decode(value)
        if (accumulated.includes(markerUuid)) break
      }

      assert.ok(accumulated.includes(markerUuid), 'marker not received')
      assert.ok(!accumulated.includes('sse-sidechain-test'), 'sidechain message leaked through SSE')
    } finally {
      ctrl.abort()
    }
  })

  it('SSE does not deliver progress/system messages', async () => {
    const ctrl = new AbortController()
    try {
      const r = await fetch(`${BASE}/api/sessions/${TEST_SESSION_ID}/stream`, { signal: ctrl.signal })
      const reader = r.body.getReader()
      const decoder = new TextDecoder()
      await reader.read()

      // Write progress and system messages
      writeLine({ type: 'progress', uuid: 'sse-progress-test', timestamp: '2025-06-15T12:03:00Z', message: null })
      writeLine({ type: 'system', uuid: 'sse-system-test', timestamp: '2025-06-15T12:03:01Z', message: { role: 'system', content: 'init' } })

      // Write marker
      const markerUuid = `sse-marker2-${Date.now()}`
      writeLine({
        type: 'user', uuid: markerUuid, timestamp: '2025-06-15T12:03:02Z',
        isSidechain: false, isMeta: false,
        message: { role: 'user', content: 'marker2' },
      })

      let accumulated = ''
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        const readPromise = reader.read()
        const timeoutPromise = new Promise(r => setTimeout(() => r({ done: true }), 2000))
        const { value, done } = await Promise.race([readPromise, timeoutPromise])
        if (done || !value) break
        accumulated += decoder.decode(value)
        if (accumulated.includes(markerUuid)) break
      }

      assert.ok(accumulated.includes(markerUuid), 'marker not received')
      assert.ok(!accumulated.includes('sse-progress-test'), 'progress message leaked')
      assert.ok(!accumulated.includes('sse-system-test'), 'system message leaked')
    } finally {
      ctrl.abort()
    }
  })

  it('SSE event IDs are byte offsets (monotonically increasing)', async () => {
    const ctrl = new AbortController()
    try {
      const r = await fetch(`${BASE}/api/sessions/${TEST_SESSION_ID}/stream`, { signal: ctrl.signal })
      const reader = r.body.getReader()
      const decoder = new TextDecoder()
      await reader.read()

      // Write two messages rapidly
      writeLine({
        type: 'user', uuid: `sse-offset-a-${Date.now()}`, timestamp: '2025-06-15T12:04:00Z',
        isSidechain: false, isMeta: false,
        message: { role: 'user', content: 'offset test A' },
      })
      writeLine({
        type: 'user', uuid: `sse-offset-b-${Date.now()}`, timestamp: '2025-06-15T12:04:01Z',
        isSidechain: false, isMeta: false,
        message: { role: 'user', content: 'offset test B' },
      })

      let accumulated = ''
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        const readPromise = reader.read()
        const timeoutPromise = new Promise(r => setTimeout(() => r({ done: true }), 2000))
        const { value, done } = await Promise.race([readPromise, timeoutPromise])
        if (done || !value) break
        accumulated += decoder.decode(value)
        if (accumulated.includes('offset test B')) break
      }

      // Extract IDs
      const ids = accumulated.split('\n')
        .filter(l => l.startsWith('id: '))
        .map(l => parseInt(l.replace('id: ', '')))
      assert.ok(ids.length >= 2, `expected >=2 IDs, got ${ids.length}`)
      for (let i = 1; i < ids.length; i++) {
        assert.ok(ids[i] > ids[i - 1], `IDs not monotonically increasing: ${ids[i-1]} >= ${ids[i]}`)
      }
    } finally {
      ctrl.abort()
    }
  })
  it('authenticates, normalizes, and broadcasts OMP bridge events', async () => {
    const sessionId = `omp-bridge-${Date.now()}`
    const token = 'test-bridge-secret'
    const tokenDir = path.join(fixtureHome, '.feather', 'omp-sessions', '.feather-bridge-tokens')
    fs.mkdirSync(tokenDir, { recursive: true })
    const tokenName = createHash('sha256').update(sessionId).digest('hex')
    fs.writeFileSync(path.join(tokenDir, tokenName), token, { mode: 0o600 })

    const denied = await fetch(`${BASE}/api/internal/sessions/${sessionId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Feather-Bridge-Token': 'wrong' },
      body: JSON.stringify({ events: [{ type: 'assistant_snapshot', messageId: 'm1', text: 'Hello' }] }),
    })
    assert.equal(denied.status, 403)

    const ctrl = new AbortController()
    try {
      const stream = await fetch(`${BASE}/api/sessions/${sessionId}/stream`, { signal: ctrl.signal })
      const reader = stream.body.getReader()
      const decoder = new TextDecoder()
      await reader.read()

      const accepted = await fetch(`${BASE}/api/internal/sessions/${sessionId}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Feather-Bridge-Token': token },
        body: JSON.stringify({ version: 4, events: [{
          type: 'assistant_snapshot',
          messageId: 'm1',
          text: 'Hello',
          thinking: 'must not cross the boundary',
        }] }),
      })
      assert.equal(accepted.status, 204)

      const { value } = await reader.read()
      const payload = decoder.decode(value)
      assert.match(payload, /event: omp_event/)
      const dataLine = payload.split('\n').find(line => line.startsWith('data: '))
      assert.deepEqual(JSON.parse(dataLine.replace('data: ', '')), {
        type: 'assistant_snapshot',
        messageId: 'm1',
        text: 'Hello',
      })
      assert.equal(payload.includes('must not cross'), false)
    } finally {
      ctrl.abort()
      try { fs.unlinkSync(path.join(tokenDir, tokenName)) } catch {}
    }
  })

  it('revalidates v4 tool data and replays coalesced parent and child live state', async () => {
    const sessionId = `omp-replay-${Date.now()}`
    const token = 'test-replay-secret'
    const tokenDir = path.join(fixtureHome, '.feather', 'omp-sessions', '.feather-bridge-tokens')
    fs.mkdirSync(tokenDir, { recursive: true })
    const tokenName = createHash('sha256').update(sessionId).digest('hex')
    const tokenPath = path.join(tokenDir, tokenName)
    fs.writeFileSync(tokenPath, token, { mode: 0o600 })
    const post = events => fetch(`${BASE}/api/internal/sessions/${sessionId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Feather-Bridge-Token': token },
      body: JSON.stringify({ version: 4, events }),
    })

    const ctrl = new AbortController()
    const terminalCtrl = new AbortController()
    const continuationCtrl = new AbortController()
    try {
      const accepted = await post([{
        type: 'agent_start',
      }, {
        type: 'assistant_snapshot',
        messageId: 'parent-message',
        text: 'Parent answer',
      }, {
        type: 'work_snapshot',
        messageId: 'parent-message',
        blocks: [{ type: 'thinking', thinking: 'Parent work' }],
      }, {
        type: 'tool_execution_start',
        toolCallId: 'parent-tool',
        toolName: 'bash',
        args: { command: 'printf safe' },
        intent: 'Starting',
        rawProviderEvent: 'must not spread',
      }, {
        type: 'tool_execution_update',
        toolCallId: 'parent-tool',
        toolName: 'bash',
        args: { command: 'printf safe' },
        partialResult: { output: 'partial' },
      }, {
        type: 'todo',
        phases: [{ name: 'Parent', tasks: [{ content: 'Mirror work', status: 'in_progress' }] }],
        isError: false,
      }, {
        type: 'session_state',
        modelProvider: 'openai',
        modelId: 'gpt-5.6',
        serviceTiers: {},
      }, {
        type: 'async_jobs',
        running: [],
        recent: [],
        delivery: { queued: 0, delivering: false },
      }, {
        type: 'tool_approval_requested',
        toolCallId: 'approval-1',
        toolName: 'write',
        approvalMode: 'write',
      }, {
        type: 'subagent_lifecycle',
        id: 'child-1',
        agent: 'scout',
        status: 'started',
        index: 0,
        detached: false,
        agentSource: 'bundled',
        task: 'Inspect bridge',
        assignment: 'Map event flow',
        sessionFile: '/tmp/child.jsonl',
        parentToolCallId: 'parent-task',
      }, {
        type: 'assistant_snapshot',
        messageId: 'child-message',
        text: 'Child answer',
        subagentId: 'child-1',
      }, {
        type: 'work_snapshot',
        messageId: 'child-message',
        blocks: [{ type: 'thinking', thinking: 'Child work' }],
        subagentId: 'child-1',
      }, {
        type: 'tool_execution_start',
        toolCallId: 'child-tool',
        toolName: 'read',
        args: { path: '/tmp/input' },
        subagentId: 'child-1',
      }, {
        type: 'tool_execution_end',
        toolCallId: 'child-tool',
        toolName: 'read',
        result: { text: 'done' },
        isError: false,
        subagentId: 'child-1',
      }, {
        type: 'todo',
        phases: [{ name: 'Child', tasks: [{ content: 'Inspect events', status: 'completed' }] }],
        isError: false,
        subagentId: 'child-1',
      }, {
        type: 'assistant_end',
        messageId: 'child-message',
        subagentId: 'child-1',
      }])
      assert.equal(accepted.status, 204)

      let deep = 'leaf'
      for (let index = 0; index < 8; index += 1) deep = { child: deep }
      const rejected = await post([{
        type: 'tool_execution_start',
        toolCallId: 'invalid-tool',
        toolName: 'read',
        args: { deep, oversized: 'x'.repeat(20_001) },
      }])
      assert.equal(rejected.status, 400)

      const stream = await fetch(`${BASE}/api/sessions/${sessionId}/stream`, { signal: ctrl.signal })
      const replay = await readOmpSseEvents(stream.body.getReader(), 14)
      assert.equal(replay.events.length, 14)
      assert.equal(replay.events[0].type, 'agent_start')
      assert.ok(replay.events.some(event => event.type === 'assistant_snapshot' && event.messageId === 'parent-message'))
      assert.ok(replay.events.some(event => event.type === 'work_snapshot' && !event.subagentId))
      const parentTool = replay.events.find(event => event.toolCallId === 'parent-tool')
      assert.equal(parentTool.type, 'tool_execution_update')
      assert.deepEqual(parentTool.partialResult, { output: 'partial' })
      assert.equal('rawProviderEvent' in parentTool, false)
      assert.ok(replay.events.some(event => event.type === 'todo' && !event.subagentId))
      assert.ok(replay.events.some(event => event.type === 'session_state'))
      assert.ok(replay.events.some(event => event.type === 'async_jobs'))
      assert.ok(replay.events.some(event => event.type === 'tool_approval_requested'))
      const metadata = replay.events.find(event => event.type === 'subagent_lifecycle')
      assert.equal(metadata.agentSource, 'bundled')
      assert.equal(metadata.parentToolCallId, 'parent-task')
      const childEvents = replay.events.filter(event => event.subagentId === 'child-1')
      assert.ok(childEvents.some(event => event.type === 'assistant_snapshot'))
      assert.ok(childEvents.some(event => event.type === 'work_snapshot'))
      assert.ok(childEvents.some(event => event.type === 'tool_execution_end'))
      assert.ok(childEvents.some(event => event.type === 'todo'))
      assert.ok(childEvents.some(event => event.type === 'assistant_end'))
      ctrl.abort()
      const continued = await post([{
        type: 'assistant_cancel',
        messageId: 'parent-message',
        willContinue: true,
      }, {
        type: 'tool_execution_start',
        toolCallId: 'current-tool',
        toolName: 'read',
        args: { path: '/tmp/current' },
        intent: 'Reading current segment',
      }])
      assert.equal(continued.status, 204)
      const continuationStream = await fetch(`${BASE}/api/sessions/${sessionId}/stream`, { signal: continuationCtrl.signal })
      const continuationReplay = await readOmpSseEvents(continuationStream.body.getReader(), 12)
      assert.equal(continuationReplay.events.some(event => event.toolCallId === 'parent-tool'), false)
      assert.equal(continuationReplay.events.some(event => event.type === 'work_snapshot' && !event.subagentId), false)
      assert.ok(continuationReplay.events.some(event => event.toolCallId === 'current-tool'))
      continuationCtrl.abort()


      const ended = await post([{ type: 'assistant_end', messageId: 'parent-message' }])
      assert.equal(ended.status, 204)
      const terminalStream = await fetch(`${BASE}/api/sessions/${sessionId}/stream`, { signal: terminalCtrl.signal })
      const terminalReplay = await readOmpSseEvents(terminalStream.body.getReader(), 12)
      assert.ok(terminalReplay.events.some(event => event.type === 'assistant_end' && !event.subagentId))
      assert.equal(terminalReplay.events.some(event => event.type === 'assistant_snapshot' && !event.subagentId), false)
      assert.equal(terminalReplay.events.some(event => event.type === 'work_snapshot' && !event.subagentId), false)
      assert.equal(terminalReplay.events.some(event => event.toolCallId === 'parent-tool'), false)
      assert.ok(terminalReplay.events.some(event => event.subagentId === 'child-1' && event.type === 'tool_execution_end'))
    } finally {
      ctrl.abort()
      terminalCtrl.abort()
      continuationCtrl.abort()
      try { fs.unlinkSync(tokenPath) } catch {}
    }
  })

})

// ── Error handling ──────────────────────────────────────────────────────────

describe('POST /api/sessions/:id/interrupt', () => {
  it('returns 500 for nonexistent tmux session', async () => {
    const r = await fetch(`${BASE}/api/sessions/no-such-session/interrupt`, { method: 'POST' })
    assert.equal(r.status, 500)
    const body = await r.json()
    assert.ok(body.error)
  })
})

describe('static files', () => {
  it('serves index.html with correct content-type', async () => {
    const staticDir = path.join(__dirname, '..', '..', 'static')
    if (!fs.existsSync(path.join(staticDir, 'index.html'))) return

    const r = await fetch(`${BASE}/`)
    assert.equal(r.status, 200)
    assert.ok(r.headers.get('content-type').includes('text/html'))
    const html = await r.text()
    assert.ok(html.includes('<!DOCTYPE html>') || html.includes('<html'))
    assert.ok(html.includes('</html>'))
  })

  it('serves the SPA shell for nested client routes from a hidden worktree', async () => {
    const staticDir = path.join(__dirname, '..', '..', 'static')
    if (!fs.existsSync(path.join(staticDir, 'index.html'))) return
    const r = await fetch(`${BASE}/feather2/`)
    assert.equal(r.status, 200)
    assert.ok(r.headers.get('content-type').includes('text/html'))
    assert.match(await r.text(), /<html/i)
  })
})

// ── /api/files/raw (serves local files for chat image embeds and links) ─────

describe('GET /api/files/raw', () => {
  it('serves a file by absolute path', async () => {
    assert.ok(fs.existsSync(toolFixture), toolFixture)
    const r = await fetch(`${BASE}/api/files/raw?path=${encodeURIComponent(toolFixture)}`)
    const body = await r.text()
    assert.equal(r.status, 200, body)
    assert.ok(body.includes('<svg'))
  })

  it('normalizes ../ segments instead of passing them to sendFile', async () => {
    const dodgy = path.join(path.dirname(toolFixture), 'nope', '..', path.basename(toolFixture))
    const r = await fetch(`${BASE}/api/files/raw?path=${encodeURIComponent(dodgy)}`)
    const body = await r.text()
    assert.equal(r.status, 200, body)
    assert.ok(body.includes('<svg'))
  })

  it('rejects relative paths', async () => {
    const r = await fetch(`${BASE}/api/files/raw?path=etc/passwd`)
    assert.equal(r.status, 400)
  })

  it('rejects paths containing null bytes', async () => {
    const r = await fetch(`${BASE}/api/files/raw?path=${encodeURIComponent('/etc/passwd\0.png')}`)
    assert.equal(r.status, 400)
  })

  it('rejects repeated path params (array injection)', async () => {
    const r = await fetch(`${BASE}/api/files/raw?path=/etc/hostname&path=/etc/hostname`)
    assert.equal(r.status, 400)
  })

  it('404s for missing files', async () => {
    const r = await fetch(`${BASE}/api/files/raw?path=/tmp/no-such-file-ever.png`)
    assert.equal(r.status, 404)
  })
})

// ── Council protocol runs ───────────────────────────────────────────────────

describe('Council protocol-run APIs', () => {
  const bridgeToken = 'council-test-bridge-token'
  const ownerExecutionId = 'cafebabe'
  const invocationMessageId = 'deadbeef'
  const eventId = number => `20000000-0000-4000-8000-${String(number).padStart(12, '0')}`

  async function postJson(url, body, token) {
    return fetch(`${BASE}${url}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-Feather-Bridge-Token': token } : {}),
      },
      body: JSON.stringify(body),
    })
  }

  before(() => {
    const tokenDir = path.join(fixtureHome, '.feather', 'omp-sessions', '.feather-bridge-tokens')
    fs.mkdirSync(tokenDir, { recursive: true, mode: 0o700 })
    const tokenFile = createHash('sha256').update(TEST_SESSION_ID).digest('hex')
    fs.writeFileSync(path.join(tokenDir, tokenFile), bridgeToken, { mode: 0o600 })
  })

  it('exposes read-only protocol history without a direct-launch endpoint', async () => {
    let response = await fetch(`${BASE}/api/sessions/${TEST_SESSION_ID}/protocol-runs`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { runs: [] })

    response = await fetch(`${BASE}/api/sessions/${TEST_SESSION_ID}/protocol-runs?limit=51`)
    assert.equal(response.status, 400)

    response = await postJson(`/api/sessions/${TEST_SESSION_ID}/protocol-runs`, { protocol: 'advisory', question: 'No direct form' })
    assert.equal(response.status, 404)
  })

  it('enforces bridge authentication, parent-only claims, and exact event route identity', async () => {
    const claimPath = `/api/internal/sessions/${TEST_SESSION_ID}/protocol-runs/claim`
    let response = await postJson(claimPath, { ownerExecutionId, invocationMessageId, mode: 'create', input: { question: 'Choose a plan', candidateCount: 2 } })
    assert.equal(response.status, 403)

    response = await postJson(claimPath, { ownerExecutionId, invocationMessageId, mode: 'create', input: { question: 'Choose a plan', candidateCount: 2 } }, 'wrong-token')
    assert.equal(response.status, 403)

    response = await postJson(claimPath, { ownerExecutionId, invocationMessageId, mode: 'create', input: { question: 'Choose a plan', candidateCount: 2 }, subagentId: 'child-1' }, bridgeToken)
    assert.equal(response.status, 403)

    response = await postJson(claimPath, { ownerExecutionId }, bridgeToken)
    assert.equal(response.status, 400)

    response = await postJson(claimPath, { ownerExecutionId, invocationMessageId, mode: 'create', input: { question: 'Choose a plan', candidateCount: 2 } }, bridgeToken)
    assert.equal(response.status, 200)
    const { envelope } = await response.json()
    assert.equal(envelope.ownerExecutionId, ownerExecutionId)
    assert.deepEqual(envelope.input.roles, [
      { seatId: 'candidate-1', role: 'Advocate' },
      { seatId: 'candidate-2', role: 'Skeptic' },
    ])

    const started = {
      schemaVersion: 1,
      eventId: eventId(10),
      runId: envelope.runId,
      type: 'run_started',
      payload: {
        protocol: 'advisory',
        invocationMessageId,
        actionId: envelope.actionId,
        ...envelope.input,
      },
    }
    const eventsPath = `/api/internal/sessions/${TEST_SESSION_ID}/protocol-runs/${envelope.runId}/events`
    response = await postJson(eventsPath, { ownerExecutionId, event: started })
    assert.equal(response.status, 403)
    response = await postJson(eventsPath, { ownerExecutionId, event: started, unexpected: true }, bridgeToken)
    assert.equal(response.status, 400)
    response = await postJson(`/api/internal/sessions/${TEST_SESSION_ID}/protocol-runs/${eventId(99)}/events`, { ownerExecutionId, event: started }, bridgeToken)
    assert.equal(response.status, 409)

    response = await postJson(eventsPath, { ownerExecutionId, event: started }, bridgeToken)
    assert.equal(response.status, 200)
    const accepted = await response.json()
    assert.equal(accepted.seq, 1)
    assert.equal(accepted.duplicate, false)

    response = await postJson(eventsPath, { ownerExecutionId, event: started }, bridgeToken)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).duplicate, true)

    const conflicting = structuredClone(started)
    conflicting.payload.question = 'Different question'
    response = await postJson(eventsPath, { ownerExecutionId, event: conflicting }, bridgeToken)
    assert.equal(response.status, 409)

    response = await postJson(eventsPath, {
      ownerExecutionId: eventId(77),
      event: {
        schemaVersion: 1,
        eventId: eventId(11),
        runId: envelope.runId,
        type: 'stage_started',
        attempt: 1,
        stageId: 'candidates',
        payload: {},
      },
    }, bridgeToken)
    assert.equal(response.status, 403)
  })

  it('replays the latest snapshot as a named protocol_run SSE event', async () => {
    const controller = new AbortController()
    const response = await fetch(`${BASE}/api/sessions/${TEST_SESSION_ID}/stream`, { signal: controller.signal })
    assert.equal(response.status, 200)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let payload = ''
    for (let index = 0; index < 10 && !payload.includes('event: protocol_run'); index++) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise(resolve => setTimeout(() => resolve(null), 500)),
      ])
      if (chunk?.value) payload += decoder.decode(chunk.value)
    }
    controller.abort()
    assert.match(payload, /event: protocol_run\ndata: /)
    assert.match(payload, /"lastSeq":/)
  })
})
