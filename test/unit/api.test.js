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
let htmlFixture
let tmuxFixtureDir
let fixtureState

const FEED_IDS = {
  waiting: `feed-waiting-${Date.now()}`,
  working: `feed-working-${Date.now()}`,
  errored: `feed-errored-${Date.now()}`,
  staleErrored: `feed-stale-errored-${Date.now()}`,
  finished: `feed-finished-${Date.now()}`,
  normalized: `feed-normalized-${Date.now()}`,
  empty: `feed-empty-${Date.now()}`,
}
const feedTimestamps = {}

// ── Synthetic session for deterministic testing ─────────────────────────────

const TEST_SESSION_ID = `test-feather-${Date.now()}`
let testSessionDir
let testSessionPath

function writeLine(obj) {
  fs.appendFileSync(testSessionPath, JSON.stringify(obj) + '\n')
}

function writeFeedSession(projectDir, id, records) {
  fs.writeFileSync(path.join(projectDir, `${id}.jsonl`),
    records.map(record => JSON.stringify(record)).join('\n') + '\n')
}

function claudeFeedMessage(id, timestamp, role, content, extra = {}) {
  return {
    type: role,
    uuid: id,
    timestamp,
    isSidechain: false,
    isMeta: false,
    message: { role, content },
    ...extra,
  }
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
    fixtureState = stateDir
    port = await allocatePort()
    BASE = `http://127.0.0.1:${port}`
    fs.mkdirSync(fixtureHome, { recursive: true })
    const fixtureBin = path.join(fixtureRoot, 'bin')
    fs.mkdirSync(fixtureBin)
    tmuxFixtureDir = path.join(fixtureRoot, 'tmux')
    fs.mkdirSync(tmuxFixtureDir)
    fs.writeFileSync(path.join(fixtureBin, 'tmux'), `#!/bin/sh
state="\${FEATHER_TEST_TMUX_DIR}"
case "$1" in
  list-sessions)
    [ -f "$state/sessions" ] && cat "$state/sessions"
    ;;
  has-session)
    target="\${3#=}"
    [ -f "$state/pane-$target" ]
    ;;
  capture-pane)
    previous=""
    target=""
    for argument in "$@"; do
      if [ "$previous" = "-t" ]; then target="$argument"; break; fi
      previous="$argument"
    done
    [ -f "$state/pane-$target" ] || exit 1
    cat "$state/pane-$target"
    ;;
  new-session)
    [ -f "$state/fail-resume" ] && exit 1
    previous=""
    target=""
    for argument in "$@"; do
      if [ "$previous" = "-s" ]; then target="$argument"; break; fi
      previous="$argument"
    done
    [ -n "$target" ] || exit 1
    printf '❯\n' > "$state/pane-$target"
    printf '%s\n' "$target" >> "$state/resumed"
    ;;
  list-panes)
    printf 'claude\n'
    ;;
  load-buffer)
    cp "$2" "$state/buffer"
    ;;
  paste-buffer)
    previous=""
    target=""
    for argument in "$@"; do
      if [ "$previous" = "-t" ]; then target="$argument"; break; fi
      previous="$argument"
    done
    [ -n "$target" ] && [ ! -f "$state/pane-$target" ] && exit 1
    [ -f "$state/buffer" ] && cat "$state/buffer" >> "$state/sent"
    printf '\n' >> "$state/sent"
    ;;
  send-keys)
    [ -f "$state/fail-send" ] && exit 7
    previous=""
    target=""
    for argument in "$@"; do
      if [ "$previous" = "-t" ]; then target="$argument"; break; fi
      previous="$argument"
    done
    [ -n "$target" ] && [ ! -f "$state/pane-$target" ] && exit 1
    printf '%s\n' "$*" >> "$state/sent"
    ;;
  *)
    exit 1
    ;;
esac
`, { mode: 0o700 })
    fixturePath = `${fixtureBin}${path.delimiter}${process.env.PATH || ''}`
  }

  const testProjectDir = path.join(fixtureHome, '.claude/projects/-api-test-project')
  fs.mkdirSync(testProjectDir, { recursive: true })

  if (!EXTERNAL_SERVER) {
    const now = Date.now()
    Object.assign(feedTimestamps, {
      finished: new Date(now - 10_000).toISOString(),
      update: new Date(now - 20_000).toISOString(),
      errored: new Date(now - 30_000).toISOString(),
      staleErrored: new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString(),
      working: new Date(now - 60_000).toISOString(),
      normalized: new Date(now - 90_000).toISOString(),
      waiting: new Date(now - 120_000).toISOString(),
      excluded: new Date(now - 5_000).toISOString(),
    })
    const seedConversation = (id, timestamp, title, reply) => writeFeedSession(testProjectDir, id, [
      claudeFeedMessage(`${id}-user`, new Date(Date.parse(timestamp) - 1_000).toISOString(), 'user', title),
      claudeFeedMessage(`${id}-assistant`, timestamp, 'assistant', [{ type: 'text', text: reply }]),
    ])
    seedConversation(FEED_IDS.waiting, feedTimestamps.waiting, 'Waiting fixture', 'Waiting assistant response.')
    seedConversation(FEED_IDS.working, feedTimestamps.working, 'Working fixture', 'Working assistant response.')
    seedConversation(FEED_IDS.errored, feedTimestamps.errored, 'Errored fixture', 'API Error: synthetic failure')
    seedConversation(FEED_IDS.staleErrored, feedTimestamps.staleErrored, 'Stale errored fixture', 'API Error: historical synthetic failure')
    seedConversation(FEED_IDS.finished, feedTimestamps.finished, 'Finished fixture', 'Finished assistant response.')
    writeFeedSession(testProjectDir, FEED_IDS.normalized, [
      claudeFeedMessage('feed-normalized-user', new Date(Date.parse(feedTimestamps.normalized) - 1_000).toISOString(), 'user', 'Normalized fixture'),
      claudeFeedMessage('feed-normalized-visible', feedTimestamps.normalized, 'assistant', [{ type: 'text', text: 'Visible **normalized** answer.' }]),
      claudeFeedMessage('feed-normalized-tool', feedTimestamps.excluded, 'assistant', [{ type: 'tool_use', id: 'feed-tool', name: 'Read', input: { path: '/tmp/input' } }]),
      claudeFeedMessage('feed-normalized-result', feedTimestamps.excluded, 'assistant', [{ type: 'tool_result', tool_use_id: 'feed-tool', content: 'internal output' }]),
      claudeFeedMessage('feed-normalized-internal', feedTimestamps.excluded, 'assistant', [{ type: 'text', text: 'Internal compact summary.' }], { isCompactSummary: true }),
      claudeFeedMessage('feed-normalized-empty', feedTimestamps.excluded, 'assistant', '   '),
    ])
    writeFeedSession(testProjectDir, FEED_IDS.empty, [
      claudeFeedMessage('feed-empty-user', new Date(Date.parse(feedTimestamps.normalized) - 2_000).toISOString(), 'user', 'Excluded fixture'),
      claudeFeedMessage('feed-empty-tool', feedTimestamps.excluded, 'assistant', [{ type: 'tool_use', id: 'empty-tool', name: 'Read', input: {} }]),
      claudeFeedMessage('feed-empty-result', feedTimestamps.excluded, 'assistant', [{ type: 'tool_result', tool_use_id: 'empty-tool', content: 'hidden' }]),
      claudeFeedMessage('feed-empty-internal', feedTimestamps.excluded, 'assistant', [{ type: 'text', text: 'Hidden summary.' }], { isCompactSummary: true }),
      claudeFeedMessage('feed-empty-assistant', feedTimestamps.excluded, 'assistant', ''),
    ])

    fs.mkdirSync(stateDir, { recursive: true })
    fs.writeFileSync(path.join(stateDir, 'project-labels.json'), JSON.stringify({ '-api-test-project': 'API Test' }))
    const featherHome = path.join(fixtureHome, '.feather')
    fs.mkdirSync(featherHome, { recursive: true })
    fs.writeFileSync(path.join(featherHome, 'room-sessions.json'), JSON.stringify({ [FEED_IDS.normalized]: 'alpha' }))
    const roomDir = path.join(fixtureHome, 'rooms', 'alpha')
    fs.mkdirSync(roomDir, { recursive: true })
    fs.writeFileSync(path.join(roomDir, 'AGENTS.md'), '# Room: #alpha\n')
    fs.writeFileSync(path.join(roomDir, 'updates.jsonl'), [{
      id: 'feed-room-update',
      ts: feedTimestamps.update,
      text: 'Room update with a human-facing result.',
    }, {
      id: 'feed-room-update-tie',
      ts: feedTimestamps.update,
      text: 'Second update at the exact same time.',
    }].map(update => JSON.stringify(update)).join('\n') + '\n')

    const created = Math.floor(now / 1000)
    fs.writeFileSync(path.join(tmuxFixtureDir, 'sessions'), [
      `f-${FEED_IDS.waiting}|${created}`,
      `f-${FEED_IDS.working}|${created}`,
    ].join('\n') + '\n')
    fs.writeFileSync(path.join(tmuxFixtureDir, `pane-f-${FEED_IDS.waiting}`), 'Deploy this result? (Y/n)\n')
    fs.writeFileSync(path.join(tmuxFixtureDir, `pane-f-${FEED_IDS.working}`), '✻ Working…\n❯\n')
  }

  if (!EXTERNAL_SERVER) {
    serverProcess = spawn(process.execPath, ['server-single.js'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: fixtureHome,
        FEATHER_STATE_DIR: stateDir,
        FEATHER_DEEPGRAM_API_KEY: '',
        FEATHER_TEST_TMUX_DIR: tmuxFixtureDir,
        FEATHER_PUSH_POLL: '0',
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
  htmlFixture = path.join(fixtureHome, 'interactive-preview.html')
  fs.writeFileSync(htmlFixture, '<!doctype html><script>document.body.textContent = "interactive"</script>')

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
  try { fs.unlinkSync(htmlFixture) } catch {}
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
describe('push subscription security', () => {
  const keys = { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) }

  it('returns only aggregate push test and subscription state', async () => {
    let response = await fetch(`${BASE}/api/push/test`, { method: 'POST' })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { total: 0, sent: 0, failed: 0, removed: 0 })
    response = await fetch(`${BASE}/api/push/subscribe`)
    assert.deepEqual(await response.json(), { count: 0 })
  })

  it('accepts only bounded public HTTPS subscriptions', async () => {
    const subscribe = endpoint => fetch(`${BASE}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint, keys }),
    })
    for (const endpoint of [
      'http://push.example.com/sub',
      'https://127.0.0.1/sub',
      'https://10.0.0.1/sub',
      'https://169.254.1.1/sub',
      'https://[::1]/sub',
      `https://push.example.com/${'x'.repeat(2100)}`,
    ]) {
      assert.equal((await subscribe(endpoint)).status, 400, endpoint)
    }
    let response = await fetch(`${BASE}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: 'https://push.example.com/sub',
        keys: { p256dh: 'A'.repeat(257), auth: 'B'.repeat(22) },
      }),
    })
    assert.equal(response.status, 400)

    response = await subscribe('https://push.example.com/sub')
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true, count: 1 })
    assert.deepEqual(await (await fetch(`${BASE}/api/push/subscribe`)).json(), { count: 1 })
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

// ── Feed ────────────────────────────────────────────────────────────────────

describe('GET /api/feed', { skip: EXTERNAL_SERVER }, () => {
  it('ranks waiting before errors, work, and completions in For You', async () => {
    const response = await fetch(`${BASE}/api/feed?mode=for-you&limit=50`, {
      headers: { 'Remote-User': 'Philip' },
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.ok(Number.isFinite(Date.parse(body.generatedAt)))
    assert.ok(body.counts.waiting >= 1)
    assert.ok(body.counts.working >= 1)
    assert.ok(body.counts.errored >= 1)
    assert.ok(body.counts.finished >= 1)

    const positions = Object.fromEntries(['waiting', 'errored', 'working', 'finished'].map(status => {
      const id = FEED_IDS[status]
      return [status, body.posts.findIndex(post => post.sessionId === id)]
    }))
    for (const [status, position] of Object.entries(positions)) {
      assert.ok(position >= 0, `missing ${status} fixture`)
    }
    assert.ok(positions.waiting < positions.errored)
    assert.ok(positions.errored < positions.working)
    assert.ok(positions.working < positions.finished)

    const waiting = body.posts[positions.waiting]
    assert.equal(waiting.status, 'waiting')
    assert.match(waiting.question, /Deploy this result/)
    assert.match(waiting.why, /Waiting for your answer/)
    assert.doesNotMatch(waiting.why, /ETA|minute|hour/i)
    const staleError = body.posts.find(post => post.sessionId === FEED_IDS.staleErrored)
    assert.equal(staleError.status, 'finished')
    assert.match(staleError.why, /Historical error/)
  })

  it('orders Latest chronologically and filters Needs Me to waiting posts', async () => {
    const latest = await (await fetch(`${BASE}/api/feed?mode=latest&limit=50`)).json()
    for (let index = 1; index < latest.posts.length; index++) {
      assert.ok(Date.parse(latest.posts[index - 1].timestamp) >= Date.parse(latest.posts[index].timestamp))
    }
    assert.equal(latest.posts[0].sessionId, FEED_IDS.finished)

    const needsMe = await (await fetch(`${BASE}/api/feed?mode=needs-me&limit=50`)).json()
    assert.ok(needsMe.posts.length > 0)
    assert.ok(needsMe.posts.every(post => post.status === 'waiting'))
    assert.ok(needsMe.posts.some(post => post.sessionId === FEED_IDS.waiting))
  })

  it('uses normalized meaningful assistant messages and links Room updates', async () => {
    const { posts } = await (await fetch(`${BASE}/api/feed?mode=latest&limit=50`)).json()
    const normalized = posts.find(post => post.sessionId === FEED_IDS.normalized && post.kind === 'session')
    assert.ok(normalized)
    assert.equal(normalized.message.uuid, 'feed-normalized-visible')
    assert.deepEqual(normalized.message.content, [{ type: 'text', text: 'Visible **normalized** answer.' }])
    assert.equal(normalized.room, 'alpha')
    assert.equal(normalized.projectId, '-api-test-project')
    assert.equal(normalized.projectLabel, 'API Test')
    assert.equal(posts.some(post => post.sessionId === FEED_IDS.empty), false)

    const update = posts.find(post => post.updateText === 'Room update with a human-facing result.')
    assert.ok(update)
    assert.equal(update.kind, 'room-update')
    assert.equal(update.sessionId, FEED_IDS.normalized)
    assert.equal(update.room, 'alpha')
    assert.equal(update.updateText, 'Room update with a human-facing result.')
    assert.equal(update.title, 'Room update with a human-facing result.')
    assert.equal(update.agent, null)
    assert.equal(update.status, 'finished')
    assert.match(update.id, /^feed_[a-f0-9]{32}$/)
    assert.ok(posts.every(post => /^feed_[a-f0-9]{32}$/.test(post.id)))
  })

  it('paginates pinned For You posts without skipping or repeating completions', async () => {
    const latest = await (await fetch(`${BASE}/api/feed?mode=latest&limit=50`)).json()
    const expectedFinished = latest.posts
      .filter(post => post.status === 'finished')
      .map(post => post.id)

    const first = await (await fetch(`${BASE}/api/feed?mode=for-you&limit=2`)).json()
    assert.deepEqual(first.posts.map(post => post.status), ['waiting', 'errored'])
    assert.match(first.nextBefore, /^f1_/)

    const seen = new Set(first.posts.map(post => post.id))
    const pinnedStatuses = first.posts.map(post => post.status)
    let sawCompletion = false
    let before = first.nextBefore
    for (let pageNumber = 0; before && pageNumber < 10; pageNumber++) {
      const page = await (await fetch(
        `${BASE}/api/feed?mode=for-you&limit=2&before=${encodeURIComponent(before)}`,
      )).json()
      for (const post of page.posts) {
        assert.equal(seen.has(post.id), false, `duplicate post ${post.id}`)
        seen.add(post.id)
        if (post.status === 'finished') {
          sawCompletion = true
        } else {
          assert.equal(sawCompletion, false, 'a pinned post appeared after completions')
          pinnedStatuses.push(post.status)
        }
      }
      before = page.nextBefore
    }
    assert.equal(before, null)
    assert.deepEqual(pinnedStatuses, ['waiting', 'errored', 'working'])
    for (const id of expectedFinished) assert.ok(seen.has(id), `skipped completion ${id}`)
  })

  it('provides stable timestamp pagination and bounds malformed query values', async () => {
    const first = await (await fetch(`${BASE}/api/feed?mode=latest&limit=2`)).json()
    assert.equal(first.posts.length, 2)
    assert.match(first.nextBefore, /^f1_/)
    const second = await (await fetch(
      `${BASE}/api/feed?mode=latest&limit=2&before=${encodeURIComponent(first.nextBefore)}`,
    )).json()
    assert.ok(second.posts.length > 0)
    assert.equal(second.posts.some(post => first.posts.some(previous => previous.id === post.id)), false)
    assert.ok(second.posts.some(post => post.timestamp === first.posts[1].timestamp),
      'opaque cursor skipped a post sharing the boundary timestamp')

    const repeated = await (await fetch(`${BASE}/api/feed?mode=latest&limit=2`)).json()
    assert.deepEqual(repeated.posts.map(post => post.id), first.posts.map(post => post.id))
    const oversized = await (await fetch(`${BASE}/api/feed?limit=999`)).json()
    assert.ok(oversized.posts.length <= 50)
    const negative = await (await fetch(`${BASE}/api/feed?limit=-99`)).json()
    assert.equal(negative.posts.length, 1)
    const malformed = await (await fetch(`${BASE}/api/feed?mode=not-a-mode&limit=nope&before=not-a-date`)).json()
    assert.ok(malformed.posts.length <= 20)
    assert.equal(malformed.posts[0].sessionId, FEED_IDS.waiting)
  })
  it('persists reactions and safely resumes an inactive session exactly once per change', async () => {
    const initial = await (await fetch(`${BASE}/api/feed?mode=latest&limit=50`)).json()
    const post = initial.posts.find(candidate => candidate.sessionId === FEED_IDS.finished)
    assert.ok(post)
    const endpoint = `${BASE}/api/feed/${encodeURIComponent(post.id)}/reaction`
    const putReaction = reaction => fetch(endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Remote-User': 'Philip' },
      body: JSON.stringify({ reaction }),
    })

    let response = await putReaction('like')
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { reaction: 'like', reactionDelivery: 'delivered', changed: true, delivery: 'delivered' })
    assert.match(fs.readFileSync(path.join(tmuxFixtureDir, 'resumed'), 'utf8'), new RegExp(FEED_IDS.finished))
    const interactionFile = path.join(fixtureState, 'feed-interactions.json')
    const likeMessageId = JSON.parse(fs.readFileSync(interactionFile, 'utf8'))
      .posts[post.id].reactionDelivery.messageId

    const liked = (await (await fetch(`${BASE}/api/feed?mode=latest&limit=50`)).json())
      .posts.find(candidate => candidate.id === post.id)
    assert.equal(liked.reaction, 'like')
    assert.equal(liked.reactionDelivery, 'delivered')
    assert.equal(liked.score, post.score + (7 * 24 * 60 * 60))
    assert.match(liked.why, /boosted because you liked this/)
    const deliveriesBeforeRepeat = (fs.readFileSync(path.join(tmuxFixtureDir, 'sent'), 'utf8')
      .match(/\[FLEDGE_REACTION:/g) || []).length

    response = await putReaction('like')
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { reaction: 'like', reactionDelivery: 'delivered', changed: false, delivery: 'not-needed' })
    const deliveriesAfterRepeat = (fs.readFileSync(path.join(tmuxFixtureDir, 'sent'), 'utf8')
      .match(/\[FLEDGE_REACTION:/g) || []).length
    assert.equal(deliveriesAfterRepeat, deliveriesBeforeRepeat)

    response = await putReaction('less')
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { reaction: 'less', reactionDelivery: 'delivered', changed: true, delivery: 'delivered' })
    const lowered = (await (await fetch(`${BASE}/api/feed?mode=latest&limit=50`)).json())
      .posts.find(candidate => candidate.id === post.id)
    assert.equal(lowered.score, post.score - (7 * 24 * 60 * 60))
    assert.match(lowered.why, /lowered because you asked for less/)

    const stored = JSON.parse(fs.readFileSync(interactionFile, 'utf8'))
    assert.equal(stored.schema, 1)
    assert.equal(stored.posts[post.id].reaction, 'less')
    assert.equal(stored.posts[post.id].reactionDelivery.status, 'delivered')
    assert.match(stored.posts[post.id].reactionDelivery.messageId, /^fledge-reaction-/)
    const lessMessageId = stored.posts[post.id].reactionDelivery.messageId
    const sentReactions = fs.readFileSync(path.join(tmuxFixtureDir, 'sent'), 'utf8')
    assert.equal(sentReactions.split(`[FLEDGE_REACTION:${post.id}:like:${likeMessageId}]`).length - 1, 1)
    assert.equal(sentReactions.split(`[FLEDGE_REACTION:${post.id}:less:${lessMessageId}]`).length - 1, 1)
    assert.equal(stored.posts[post.id].snapshot.id, post.id)
    assert.equal(fs.statSync(path.join(fixtureState, 'feed-interactions.json')).mode & 0o777, 0o600)

    response = await putReaction(null)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { reaction: null, reactionDelivery: null, changed: true, delivery: 'not-needed' })
    const cleared = (await (await fetch(`${BASE}/api/feed?mode=latest&limit=50`)).json())
      .posts.find(candidate => candidate.id === post.id)
    assert.equal(cleared.reaction, null)
    assert.equal(cleared.reactionDelivery, null)
    assert.equal(cleared.score, post.score)
  })
  it('retries failed same-reaction delivery with its persisted idempotency key', async () => {
    const feed = await (await fetch(`${BASE}/api/feed?mode=latest&limit=50`)).json()
    const post = feed.posts.find(candidate => candidate.sessionId === FEED_IDS.normalized && candidate.kind === 'session')
    const endpoint = `${BASE}/api/feed/${encodeURIComponent(post.id)}/reaction`
    const putLike = () => fetch(endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reaction: 'like' }),
    })

    fs.writeFileSync(path.join(tmuxFixtureDir, 'fail-resume'), '1')
    let response
    try {
      response = await putLike()
    } finally {
      fs.rmSync(path.join(tmuxFixtureDir, 'fail-resume'), { force: true })
    }
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      reaction: 'like',
      reactionDelivery: 'failed',
      changed: true,
      delivery: 'failed',
    })
    const interactionFile = path.join(fixtureState, 'feed-interactions.json')
    let stored = JSON.parse(fs.readFileSync(interactionFile, 'utf8'))
    const messageId = stored.posts[post.id].reactionDelivery.messageId
    assert.equal(stored.posts[post.id].reactionDelivery.status, 'failed')

    response = await putLike()
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      reaction: 'like',
      reactionDelivery: 'delivered',
      changed: false,
      delivery: 'delivered',
    })
    stored = JSON.parse(fs.readFileSync(interactionFile, 'utf8'))
    assert.equal(stored.posts[post.id].reactionDelivery.messageId, messageId)
    assert.equal(stored.posts[post.id].reactionDelivery.status, 'delivered')
  })


  it('persists comments before delivery and exposes durable inline agent replies', async () => {
    const initial = await (await fetch(`${BASE}/api/feed?mode=latest&limit=50`)).json()
    const post = initial.posts.find(candidate => candidate.sessionId === FEED_IDS.finished)
    const commentId = '20000000-0000-4000-8000-000000000001'
    const endpoint = `${BASE}/api/feed/${encodeURIComponent(post.id)}/comments`
    const postComment = (id, text) => fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Remote-User': 'Philip' },
      body: JSON.stringify({ id, text }),
    })

    let response = await postComment(commentId, 'Can you explain the consequence?')
    assert.equal(response.status, 201)
    let body = await response.json()
    assert.equal(body.comment.id, commentId)
    assert.equal(body.comment.delivery, 'delivered')
    const deliveredLog = fs.readFileSync(path.join(tmuxFixtureDir, 'sent'), 'utf8')
    const commentPrompt = deliveredLog.slice(deliveredLog.lastIndexOf(`[FLEDGE_COMMENT:${commentId}]`))
      .split('\nsend-keys -t ')[0]
    assert.match(commentPrompt, new RegExp(`\\[FLEDGE_COMMENT:${commentId}\\]`))
    assert.match(commentPrompt, /next meaningful human-facing answer will appear as the inline reply/)
    assert.doesNotMatch(commentPrompt, /Finished fixture/)
    assert.doesNotMatch(commentPrompt, new RegExp(FEED_IDS.finished))

    const interactionFile = path.join(fixtureState, 'feed-interactions.json')
    let stored = JSON.parse(fs.readFileSync(interactionFile, 'utf8'))
    assert.equal(stored.posts[post.id].comments[0].delivery, 'delivered')
    assert.equal(stored.posts[post.id].comments[0].text, 'Can you explain the consequence?')

    const replyAt = new Date().toISOString()
    const sessionFile = path.join(testSessionDir, `${FEED_IDS.finished}.jsonl`)
    fs.appendFileSync(sessionFile, [
      JSON.stringify(claudeFeedMessage('feed-comment-user', replyAt, 'user', `[FLEDGE_COMMENT:${commentId}]\nCan you explain the consequence?`)),
      JSON.stringify(claudeFeedMessage('feed-comment-reply', new Date(Date.parse(replyAt) + 1).toISOString(), 'assistant', [
        { type: 'text', text: 'The consequence is **durable and visible inline**.' },
      ])),
    ].join('\n') + '\n')

    await fetch(`${BASE}/api/feed?mode=latest&limit=50`)
    await new Promise(resolve => setTimeout(resolve, 150))
    const refreshed = await (await fetch(`${BASE}/api/feed?mode=latest&limit=50`)).json()
    const interacted = refreshed.posts.find(candidate => candidate.id === post.id)
    assert.ok(interacted, 'interacted snapshot disappeared after a newer assistant answer')
    assert.equal(interacted.comments.length, 1)
    assert.deepEqual(interacted.comments[0].reply, {
      text: 'The consequence is **durable and visible inline**.',
      timestamp: new Date(Date.parse(replyAt) + 1).toISOString(),
    })
    assert.ok(refreshed.posts.some(candidate =>
      candidate.sessionId === FEED_IDS.finished && candidate.id !== post.id))

    response = await postComment(commentId, 'Can you explain the consequence?')
    assert.equal(response.status, 200)
    body = await response.json()
    assert.ok(body.comment.reply)
    stored = JSON.parse(fs.readFileSync(interactionFile, 'utf8'))
    assert.equal(stored.posts[post.id].comments.length, 1)
    assert.ok(stored.posts[post.id].comments[0].reply)
    const commentDeliveries = (fs.readFileSync(path.join(tmuxFixtureDir, 'sent'), 'utf8')
      .match(new RegExp(`\\[FLEDGE_COMMENT:${commentId}\\]`, 'g')) || []).length
    assert.equal(commentDeliveries, 1)
  })

  it('keeps an interacted Room update bound to its stored originating session', async () => {
    let feed = await (await fetch(`${BASE}/api/feed?mode=latest&limit=50`)).json()
    const update = feed.posts.find(post => post.updateText === 'Room update with a human-facing result.')
    const originSessionId = update.sessionId
    const replacementSessionId = originSessionId === FEED_IDS.finished ? FEED_IDS.normalized : FEED_IDS.finished
    const firstId = '20000000-0000-4000-8000-000000000010'
    let response = await fetch(`${BASE}/api/feed/${encodeURIComponent(update.id)}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: firstId, text: 'Keep this bound to the originating chat.' }),
    })
    assert.equal(response.status, 201)
    assert.equal((await response.json()).comment.delivery, 'delivered')

    const assignmentsFile = path.join(fixtureHome, '.feather', 'room-sessions.json')
    const assignments = JSON.parse(fs.readFileSync(assignmentsFile, 'utf8'))
    assignments[replacementSessionId] = 'alpha'
    fs.writeFileSync(assignmentsFile, JSON.stringify(assignments))
    fs.appendFileSync(path.join(testSessionDir, `${replacementSessionId}.jsonl`),
      JSON.stringify(claudeFeedMessage(
        'feed-room-rebind-candidate',
        new Date(Date.now() + 60_000).toISOString(),
        'assistant',
        [{ type: 'text', text: 'Newer Room session that must not steal the stored interaction.' }],
      )) + '\n')
    feed = await (await fetch(`${BASE}/api/feed?mode=latest&limit=50`)).json()
    assert.equal(feed.posts.find(post => post.id === update.id).sessionId, originSessionId)

    const secondId = '20000000-0000-4000-8000-000000000011'
    response = await fetch(`${BASE}/api/feed/${encodeURIComponent(update.id)}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: secondId, text: 'Deliver to the original chat.' }),
    })
    assert.equal(response.status, 201)
    assert.equal((await response.json()).comment.delivery, 'delivered')
    const sent = fs.readFileSync(path.join(tmuxFixtureDir, 'sent'), 'utf8')
    const secondDelivery = sent.slice(sent.lastIndexOf(`[FLEDGE_COMMENT:${secondId}]`))
    assert.match(secondDelivery, new RegExp(`send-keys -t f-${originSessionId} Enter`))
    assert.doesNotMatch(secondDelivery, new RegExp(`send-keys -t f-${replacementSessionId} Enter`))
  })

  it('reports failed inactive-session delivery after durably queueing the comment', async () => {
    const initial = await (await fetch(`${BASE}/api/feed?mode=latest&limit=50`)).json()
    const post = initial.posts.find(candidate => candidate.sessionId === FEED_IDS.errored)
    const commentId = '20000000-0000-4000-8000-000000000002'
    fs.writeFileSync(path.join(tmuxFixtureDir, 'fail-resume'), '1')
    let response
    try {
      response = await fetch(`${BASE}/api/feed/${encodeURIComponent(post.id)}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: commentId, text: 'Please recover this dispatch.' }),
      })
    } finally {
      fs.rmSync(path.join(tmuxFixtureDir, 'fail-resume'), { force: true })
    }
    assert.equal(response.status, 201)
    const { comment } = await response.json()
    assert.equal(comment.delivery, 'failed')
    const interactionFile = path.join(fixtureState, 'feed-interactions.json')
    let stored = JSON.parse(fs.readFileSync(interactionFile, 'utf8'))
    assert.equal(stored.posts[post.id].comments.find(candidate => candidate.id === commentId)?.delivery, 'failed')
    stored.posts[post.id].snapshot.status = 'waiting'
    stored.posts[post.id].snapshot.question = 'Stale question that was answered'
    stored.posts[post.id].snapshot.why = 'Waiting for your answer'
    fs.writeFileSync(interactionFile, JSON.stringify(stored))

    const marker = `[FLEDGE_COMMENT:${commentId}]`
    const answeredAt = new Date().toISOString()
    fs.appendFileSync(path.join(testSessionDir, `${FEED_IDS.errored}.jsonl`), [
      JSON.stringify(claudeFeedMessage('feed-failed-comment-user', answeredAt, 'user', `${marker}\nPlease recover this dispatch.`)),
      JSON.stringify(claudeFeedMessage('feed-failed-comment-answer', new Date(Date.parse(answeredAt) + 1).toISOString(), 'assistant', [
        { type: 'text', text: 'Recovered without leaving a stale question.' },
      ])),
    ].join('\n') + '\n')
    const sendsBeforeReconcile = fs.existsSync(path.join(tmuxFixtureDir, 'sent'))
      ? fs.readFileSync(path.join(tmuxFixtureDir, 'sent'), 'utf8').split(marker).length - 1
      : 0
    response = await fetch(`${BASE}/api/feed/${encodeURIComponent(post.id)}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: commentId, text: 'Please recover this dispatch.' }),
    })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).comment.delivery, 'delivered')
    const sendsAfterReconcile = fs.readFileSync(path.join(tmuxFixtureDir, 'sent'), 'utf8').split(marker).length - 1
    assert.equal(sendsAfterReconcile, sendsBeforeReconcile)

    await fetch(`${BASE}/api/feed?mode=latest&limit=50`)
    await new Promise(resolve => setTimeout(resolve, 150))
    const refreshed = await (await fetch(`${BASE}/api/feed?mode=latest&limit=50`)).json()
    const snapshot = refreshed.posts.find(candidate => candidate.id === post.id)
    assert.equal(snapshot.status, 'finished')
    assert.equal(snapshot.question, undefined)
    assert.match(snapshot.why, /Archived interacted dispatch/)
    const needsMe = await (await fetch(`${BASE}/api/feed?mode=needs-me&limit=50`)).json()
    assert.equal(needsMe.posts.some(candidate => candidate.id === post.id), false)
    assert.match(snapshot.message.content[0].text, /API Error/)
  })

  it('rejects stale posts, malformed feedback, and oversized comments', async () => {
    let response = await fetch(`${BASE}/api/feed/not-a-current-post/reaction`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reaction: 'favorite' }),
    })
    assert.equal(response.status, 400)
    response = await fetch(`${BASE}/api/feed/not-a-current-post/reaction`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reaction: 'like' }),
    })
    assert.equal(response.status, 404)
    response = await fetch(`${BASE}/api/feed/not-a-current-post/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: '20000000-0000-4000-8000-000000000003', text: 'unknown' }),
    })
    assert.equal(response.status, 404)

    const feed = await (await fetch(`${BASE}/api/feed?mode=latest&limit=50`)).json()
    const post = feed.posts.find(candidate => candidate.sessionId === FEED_IDS.normalized)
    response = await fetch(`${BASE}/api/feed/${encodeURIComponent(post.id)}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: '20000000-0000-4000-8000-000000000004',
        text: 'x'.repeat(4001),
      }),
    })
    assert.equal(response.status, 413)
  })
})

describe('GET /api/sessions/:id/room', () => {
  it('resolves exact Room membership without depending on the capped Room snapshot', async () => {
    const missing = await (await fetch(`${BASE}/api/sessions/no-such-session-ever/room`)).json()
    assert.equal(missing.room, null)

    const roomName = `api-room-${Date.now().toString(36)}`
    const created = await fetch(`${BASE}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: roomName }),
    })
    assert.equal(created.status, 200)
    const assigned = await fetch(`${BASE}/api/rooms/${roomName}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: TEST_SESSION_ID }),
    })
    assert.equal(assigned.status, 200)

    const response = await fetch(`${BASE}/api/sessions/${TEST_SESSION_ID}/room`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { room: roomName })
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
          thinking: 'must not cross the answer boundary',
        }, {
          type: 'work_snapshot',
          messageId: 'm1',
          blocks: [
            { type: 'thinking', thinking: 'Live reasoning inside Details.' },
            { type: 'tool_use', id: 'call-1', name: 'bash', intent: 'Checking state', input: { command: 'secret command' } },
          ],
        }] }),
      })
      assert.equal(accepted.status, 204)

      let payload = ''
      while (payload.split('\n').filter(line => line.startsWith('data: ')).length < 2) {
        const { value, done } = await reader.read()
        if (done || !value) break
        payload += decoder.decode(value)
      }
      assert.match(payload, /event: omp_event/)
      const dataLines = payload.split('\n').filter(line => line.startsWith('data: '))
      assert.deepEqual(dataLines.map(line => JSON.parse(line.replace('data: ', ''))), [{
        type: 'assistant_snapshot',
        messageId: 'm1',
        text: 'Hello',
      }, {
        type: 'work_snapshot',
        messageId: 'm1',
        blocks: [
          { type: 'thinking', thinking: 'Live reasoning inside Details.' },
          { type: 'tool_use', id: 'call-1', name: 'bash', intent: 'Checking state' },
        ],
      }])
      assert.equal(payload.includes('must not cross'), false)
      assert.equal(payload.includes('secret command'), false)
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

describe('POST /api/sessions', () => {
  it('rejects non-UUID session ids before they reach tmux or filesystem paths', async () => {
    const response = await fetch(`${BASE}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: '../;touch-pwned', cwd: fixtureHome, agent: 'omp' }),
    })
    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /session id must be a UUID/)
  })

  it('trusts a Claude workspace before launch', async () => {
    const response = await fetch(`${BASE}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: '20000000-0000-4000-8000-000000000321', cwd: fixtureHome, agent: 'claude' }),
    })
    assert.equal(response.status, 200)
    const trust = JSON.parse(fs.readFileSync(path.join(fixtureHome, '.claude.json'), 'utf8'))
    assert.equal(trust.projects[fixtureHome].hasTrustDialogAccepted, true)
  })
})

// ── Error handling ──────────────────────────────────────────────────────────

describe('POST /api/sessions/:id/send', () => {
  it('normalizes process exit codes to a JSON 500 response', async () => {
    fs.writeFileSync(path.join(tmuxFixtureDir, 'fail-send'), '1')
    let response
    try {
      response = await fetch(`${BASE}/api/sessions/${TEST_SESSION_ID}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Feather-Message-ID': 'process-exit-status-0001' },
        body: JSON.stringify({ text: 'must not crash Express status handling' }),
      })
    } finally {
      fs.unlinkSync(path.join(tmuxFixtureDir, 'fail-send'))
    }
    assert.equal(response.status, 500)
    const body = await response.json()
    assert.equal(typeof body.error, 'string')
    assert.ok(body.error.length > 0)
  })
})

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

describe('GET /api/files/html', () => {
  it('runs self-contained scripts in an opaque no-network sandbox', async () => {
    const response = await fetch(`${BASE}/api/files/html?path=${encodeURIComponent(htmlFixture)}`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /^text\/html/)
    const csp = response.headers.get('content-security-policy')
    assert.ok(csp)
    assert.match(csp, /(?:^|; )sandbox allow-scripts(?:;|$)/)
    assert.match(csp, /script-src 'unsafe-inline' data: blob:/)
    assert.match(csp, /connect-src 'none'/)
    assert.match(csp, /form-action 'none'/)
    assert.doesNotMatch(csp, /allow-same-origin|allow-forms|allow-popups|allow-top-navigation/)
    assert.doesNotMatch(csp.match(/script-src ([^;]+)/)?.[1] || '', /https?:/)
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

// ── /api/file (serves local files for chat image embeds and links) ──────────

describe('GET /api/file', () => {

  it('serves a file by absolute path', async () => {
    const r = await fetch(`${BASE}/api/file?path=${encodeURIComponent(toolFixture)}`)
    assert.equal(r.status, 200)
    const body = await r.text()
    assert.ok(body.includes('<svg'))
  })

  it('normalizes ../ segments instead of passing them to sendFile', async () => {
    const dodgy = path.join(path.dirname(toolFixture), 'nope', '..', path.basename(toolFixture))
    const r = await fetch(`${BASE}/api/file?path=${encodeURIComponent(dodgy)}`)
    assert.equal(r.status, 200)
    const body = await r.text()
    assert.ok(body.includes('<svg'))
  })

  it('rejects relative paths', async () => {
    const r = await fetch(`${BASE}/api/file?path=etc/passwd`)
    assert.equal(r.status, 400)
  })

  it('rejects paths containing null bytes', async () => {
    const r = await fetch(`${BASE}/api/file?path=${encodeURIComponent('/etc/passwd\0.png')}`)
    assert.equal(r.status, 400)
  })

  it('rejects repeated path params (array injection)', async () => {
    const r = await fetch(`${BASE}/api/file?path=/etc/hostname&path=/etc/hostname`)
    assert.equal(r.status, 400)
  })

  it('404s for missing files', async () => {
    const r = await fetch(`${BASE}/api/file?path=${encodeURIComponent(path.join(fixtureHome, 'no-such-file-ever.png'))}`)
    assert.equal(r.status, 404)
  })
})

