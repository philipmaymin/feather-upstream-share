import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const children = new Set()
const tempRoots = new Set()

afterEach(async () => {
  await Promise.all([...children].map(child => new Promise(resolve => {
    if (child.exitCode !== null) return resolve()
    const forceTimer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 1000)
    forceTimer.unref()
    child.once('exit', () => { clearTimeout(forceTimer); resolve() })
    child.kill('SIGTERM')
  })))
  children.clear()
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true })
  tempRoots.clear()
})

function writeJson(file, value, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode })
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-read-only-'))
  tempRoots.add(root)
  const home = path.join(root, 'home')
  const state = path.join(root, 'state')
  const project = path.join(home, '.claude/projects/-tmp-read-only')
  const sessionId = 'readonly-session-00000000'
  const sessionFile = path.join(project, `${sessionId}.jsonl`)
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(state, { recursive: true })
  fs.writeFileSync(sessionFile, JSON.stringify({
    type: 'user', uuid: 'readonly-message', timestamp: '2026-08-22T00:00:00Z',
    isSidechain: false, isMeta: false, cwd: home,
    message: { role: 'user', content: 'read only fixture' },
  }) + '\n')
  const readableFile = path.join(home, 'readable.txt')
  fs.writeFileSync(readableFile, 'canary-readable')
  writeJson(path.join(state, 'session-meta.json'), {})
  writeJson(path.join(state, 'project-labels.json'), {})
  writeJson(path.join(state, 'quick-links.json'), [])
  writeJson(path.join(state, 'starred.json'), {})
  writeJson(path.join(home, '.feather/room-sessions.json'), {})
  writeJson(path.join(home, '.feather/sidecars/groups.json'), {
    'stale-group': {
      id: 'stale-group', status: 'active', agent: 'claude', createdAt: 1, seq: 0,
      members: [
        { sessionId, role: 'driver', spawned: false },
        { sessionId: 'spawned-peer-00000000', role: 'peer', spawned: true },
      ],
    },
  })
  const room = path.join(home, 'rooms/test-room')
  fs.mkdirSync(room, { recursive: true })
  fs.writeFileSync(path.join(room, 'AGENTS.md'), '# Test room\n')
  fs.writeFileSync(path.join(room, 'notes.md'), '# Notes\n')
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  const tmuxLog = path.join(root, 'tmux.log')
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh
printf '%s\\n' "$*" >> "${tmuxLog}"
case "$1" in
  list-panes) printf 'claude\\n' ;;
  capture-pane) printf '❯\\n' ;;
esac
exit 0
`, { mode: 0o755 })
  return { home, state, sessionId, sessionFile, readableFile, tmuxLog, bin }
}

function inventory(root) {
  if (!fs.existsSync(root)) return []
  const out = []
  const walk = dir => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name)
      const stat = fs.lstatSync(file)
      const relative = path.relative(root, file)
      if (stat.isDirectory()) { out.push([relative, 'dir', stat.mode & 0o777]); walk(file) }
      else if (stat.isSymbolicLink()) out.push([relative, 'link', fs.readlinkSync(file)])
      else out.push([relative, 'file', stat.mode & 0o777, createHash('sha256').update(fs.readFileSync(file)).digest('hex')])
    }
  }
  walk(root)
  return out
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(error => error ? reject(error) : resolve(port))
    })
  })
}

async function startServer(fx, readOnly) {
  const port = await freePort()
  const child = spawn(process.execPath, ['server-single.js'], {
    cwd: REPO,
    env: {
      ...process.env, HOME: fx.home, FEATHER_STATE_DIR: fx.state, PORT: String(port),
      PATH: `${fx.bin}:${process.env.PATH}`, FEATHER_READ_ONLY: readOnly ? '1' : '0',
      FEATHER_DEEPGRAM_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.add(child)
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const base = `http://127.0.0.1:${port}`
  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${output}`)
    try {
      const response = await fetch(`${base}/api/health`)
      if (response.ok) return { base, port, child }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`server did not become ready: ${output}`)
}

function expectRejectedUpgrade(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.once('open', () => reject(new Error('read-only WebSocket unexpectedly opened')))
    ws.once('unexpected-response', (_request, response) => {
      try { assert.equal(response.statusCode, 403); resolve() } catch (error) { reject(error) }
      response.resume()
    })
    ws.once('error', error => {
      if (!/Unexpected server response: 403/.test(error.message)) reject(error)
    })
  })
}

function expectClosedUpgrade(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let settled = false
    const finish = () => { if (!settled) { settled = true; resolve() } }
    ws.once('open', () => reject(new Error(`unexpected WebSocket upgrade: ${url}`)))
    ws.once('unexpected-response', (_request, response) => { response.resume(); finish() })
    ws.once('error', finish)
    ws.once('close', finish)
  })
}

function expectOpenedUpgrade(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.once('open', () => { ws.close(); resolve() })
    ws.once('unexpected-response', (_request, response) => {
      response.resume()
      reject(new Error(`upgrade rejected with ${response.statusCode}: ${url}`))
    })
    ws.once('error', reject)
  })
}

describe('server-enforced read-only canary', () => {
  it('allows the browsing surface while rejecting every mutation and terminal upgrade without state or tmux changes', async () => {
    const fx = fixture()
    const beforeHome = inventory(fx.home)
    const beforeState = inventory(fx.state)
    const { base, port } = await startServer(fx, true)

    const health = await (await fetch(`${base}/api/health`)).json()
    assert.equal(health.capabilities.readOnly, true)
    assert.equal(health.capabilities.mutations, false)
    assert.equal(health.capabilities.terminal, false)
    assert.equal(health.capabilities.backgroundControllers, false)
    assert.equal(health.capabilities.maxUploadBytes, 50 * 1024 * 1024)
    assert.equal(health.capabilities.maxAudioBytes, 25 * 1024 * 1024)

    const readable = [
      '/api/health', '/api/sessions',
      `/api/sessions/${fx.sessionId}/messages`, `/api/sessions/${fx.sessionId}/export`,
      `/api/files/raw?path=${encodeURIComponent(fx.readableFile)}`,
      `/api/files/list?dir=${encodeURIComponent(fx.home)}`,
      '/api/rooms', '/api/rooms/test-room/updates', '/api/sidecar', '/api/sidecar/stale-group',
      '/api/projects', '/api/search?q=fixture', '/api/quick-links', '/api/mute',
      '/api/push/subscribe', '/api/starred', '/api/starred/album', '/api/agents',
      '/api/running', '/api/usage', '/api/digest', '/api/me', '/api/version',
    ]
    for (const endpoint of readable) {
      const response = await fetch(`${base}${endpoint}`)
      assert.equal(response.status, 200, `GET ${endpoint}`)
    }
    const agents = (await (await fetch(`${base}/api/agents`)).json()).agents
    assert.equal(agents.find(agent => agent.id === 'omp')?.default, true)
    assert.equal(agents.find(agent => agent.id === 'claude')?.default, false)
    const mutations = [
      ['GET', '/api/future-side-effect'],
      ['GET', '/api/push/key'],
      ['POST', '/api/sessions', { id: 'new-session', cwd: fx.home }],
      ['POST', `/api/sessions/${fx.sessionId}/send`, { text: 'no' }],
      ['POST', `/api/sessions/${fx.sessionId}/resume`, {}],
      ['POST', `/api/sessions/${fx.sessionId}/interrupt`, {}],
      ['POST', `/api/sessions/${fx.sessionId}/delete`, {}],
      ['POST', `/api/sessions/${fx.sessionId}/rename`, { title: 'changed' }],
      ['POST', `/api/sessions/${fx.sessionId}/fork`, {}],
      ['POST', '/api/sidecar/stale-group/post', { from: 'driver', to: 'peer', text: 'no' }],
      ['POST', '/api/sidecar', { driverSessionId: fx.sessionId }],
      ['POST', '/api/quick-links', []], ['POST', '/api/starred', {}],
      ['POST', '/api/rooms', { name: 'forbidden-room' }],
      ['POST', '/api/rooms/test-room/rename', { name: 'renamed-room' }],
      ['POST', '/api/rooms/test-room/assign', { sessionId: fx.sessionId }],
      ['POST', '/api/rooms/test-room/pulse', { enabled: false }],
      ['POST', '/api/rooms/test-room/updates', { text: 'forbidden' }],
      ['POST', '/api/upload', 'bytes'], ['POST', '/api/transcribe', 'bytes'],
      ['DELETE', `/api/files/delete?path=${encodeURIComponent(fx.sessionFile)}`],
      ['DELETE', '/api/projects/-tmp-read-only'],
      ['POST', '/api/login', {}], ['POST', '/api/logout', {}],
    ]
    for (const [method, endpoint, body] of mutations) {
      const isJson = typeof body !== 'string'
      const response = await fetch(`${base}${endpoint}`, {
        method, headers: isJson ? { 'Content-Type': 'application/json' } : {},
        body: method === 'DELETE' ? undefined : (isJson ? JSON.stringify(body) : body),
      })
      assert.equal(response.status, 403, `${method} ${endpoint}`)
      assert.deepEqual(await response.json(), { error: 'read-only canary', code: 'FEATHER_READ_ONLY' })
    }

    await expectRejectedUpgrade(`ws://127.0.0.1:${port}/api/shell`)
    await expectRejectedUpgrade(`ws://127.0.0.1:${port}/api/terminal?session=${fx.sessionId}`)
    await expectRejectedUpgrade(`ws://127.0.0.1:${port}/api/stt`)
    await expectRejectedUpgrade(`ws://127.0.0.1:${port}/canary/api/shell`)
    await expectRejectedUpgrade(`ws://127.0.0.1:${port}/api/shell/`)
    await expectRejectedUpgrade(`ws://127.0.0.1:${port}/unclassified-upgrade`)
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.deepEqual(inventory(fx.home), beforeHome)
    assert.deepEqual(inventory(fx.state), beforeState)
    const tmuxCalls = fs.existsSync(fx.tmuxLog) ? fs.readFileSync(fx.tmuxLog, 'utf8').trim().split('\n').filter(Boolean) : []
    assert.ok(tmuxCalls.every(call => call.startsWith('list-sessions') || call.startsWith('has-session')), tmuxCalls.join('\n'))
  })

  it('retains mutation behavior when read-only mode is disabled', async () => {
    const fx = fixture()
    fs.mkdirSync(path.join(fx.state, 'uploads'))
    const { base, port } = await startServer(fx, false)
    const response = await fetch(`${base}/api/quick-links`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ label: 'Normal mode', url: 'https://example.test' }]),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fx.state, 'quick-links.json'), 'utf8')), [{ label: 'Normal mode', url: 'https://example.test' }])

    await expectOpenedUpgrade(`ws://127.0.0.1:${port}/api/shell`)
    for (const route of ['/api/shell/', '/api/shell-near-match', '/api/terminal/', '/api/terminal-near-match']) {
      await expectClosedUpgrade(`ws://127.0.0.1:${port}${route}`)
    }
  })

  it('returns stable durable send receipts while preserving unkeyed client behavior', async () => {
    const fx = fixture()
    fs.mkdirSync(path.join(fx.state, 'uploads'))
    let running = await startServer(fx, false)
    let endpoint = `${running.base}/api/sessions/${fx.sessionId}/send`
    const jsonHeaders = { 'Content-Type': 'application/json', 'X-Feather-Message-ID': 'voice-recovery-0001' }

    const first = await fetch(endpoint, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ text: 'deliver once' }) })
    assert.equal(first.status, 200)
    const firstReceipt = await first.json()
    const retry = await fetch(endpoint, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ text: 'deliver once' }) })
    assert.equal(retry.status, 200)
    assert.deepEqual(await retry.json(), firstReceipt)

    running.child.kill('SIGTERM')
    await new Promise(resolve => running.child.once('exit', resolve))
    children.delete(running.child)
    running = await startServer(fx, false)
    endpoint = `${running.base}/api/sessions/${fx.sessionId}/send`
    const restartRetry = await fetch(endpoint, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ text: 'deliver once' }) })
    assert.equal(restartRetry.status, 200)
    assert.deepEqual(await restartRetry.json(), firstReceipt)

    const conflict = await fetch(endpoint, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ text: 'different text' }) })
    assert.equal(conflict.status, 409)
    assert.match((await conflict.json()).error, /different text/)
    const invalid = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Feather-Message-ID': '../bad' },
      body: JSON.stringify({ text: 'invalid key' }),
    })
    assert.equal(invalid.status, 400)

    const unkeyedOne = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'legacy retry' }),
    })
    const unkeyedTwo = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'legacy retry' }),
    })
    assert.equal(unkeyedOne.status, 200)
    assert.equal(unkeyedTwo.status, 200)

    const calls = fs.readFileSync(fx.tmuxLog, 'utf8').trim().split('\n')
    assert.equal(calls.filter(call => call === `send-keys -t f-${fx.sessionId} -l deliver once`).length, 1)
    assert.equal(calls.filter(call => call === `send-keys -t f-${fx.sessionId} -l legacy retry`).length, 2)
    const receiptsFile = path.join(fx.state, 'uploads/.message-receipts.json')
    const stored = JSON.parse(fs.readFileSync(receiptsFile, 'utf8'))
    assert.deepEqual(stored[fx.sessionId]['voice-recovery-0001'].response, firstReceipt)
    assert.equal(stored[fx.sessionId]['voice-recovery-0001'].textHash.length, 64)
    assert.equal(fs.statSync(receiptsFile).mode & 0o777, 0o600)

    const deleted = await fetch(`${running.base}/api/sessions/${fx.sessionId}/delete`, { method: 'POST' })
    assert.equal(deleted.status, 200)
    assert.equal(fx.sessionId in JSON.parse(fs.readFileSync(receiptsFile, 'utf8')), false)
  })

  it('enforces the audio boundary and returns a stable 413 JSON shape', async () => {
    const fx = fixture()
    fs.mkdirSync(path.join(fx.state, 'uploads'))
    const { base } = await startServer(fx, false)
    const exactLimit = Buffer.alloc(25 * 1024 * 1024)
    const boundary = await fetch(`${base}/api/transcribe`, {
      method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: exactLimit,
    })
    const boundaryBody = await boundary.json()
    assert.equal(boundary.status, 500, JSON.stringify(boundaryBody))
    assert.deepEqual(boundaryBody, { error: 'No Deepgram API key configured' })

    const oversized = await fetch(`${base}/api/transcribe`, {
      method: 'POST',
      headers: { 'Content-Length': String((25 * 1024 * 1024) + 1) },
      body: Buffer.alloc((25 * 1024 * 1024) + 1),
    })
    assert.equal(oversized.status, 413)
    assert.deepEqual(await oversized.json(), { error: 'audio exceeds 25 MB limit' })
  })
})
