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
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${tmuxLog}"\nexit 1\n`, { mode: 0o755 })
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
      if (response.ok) return { base, port }
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

    const readable = [
      '/api/health', '/api/sessions',
      `/api/sessions/${fx.sessionId}/messages`, `/api/sessions/${fx.sessionId}/export`,
      `/api/files/raw?path=${encodeURIComponent(fx.readableFile)}`,
      `/api/files/list?dir=${encodeURIComponent(fx.home)}`,
      '/api/rooms', '/api/sidecar', '/api/sidecar/stale-group',
      '/api/projects', '/api/search?q=fixture', '/api/quick-links', '/api/mute',
      '/api/push/subscribe', '/api/starred', '/api/starred/album', '/api/agents',
      '/api/running', '/api/usage', '/api/digest', '/api/me', '/api/version',
    ]
    for (const endpoint of readable) {
      const response = await fetch(`${base}${endpoint}`)
      assert.equal(response.status, 200, `GET ${endpoint}`)
    }
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
      ['POST', '/api/rooms/test-room/assign', { sessionId: fx.sessionId }],
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
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.deepEqual(inventory(fx.home), beforeHome)
    assert.deepEqual(inventory(fx.state), beforeState)
    const tmuxCalls = fs.existsSync(fx.tmuxLog) ? fs.readFileSync(fx.tmuxLog, 'utf8').trim().split('\n').filter(Boolean) : []
    assert.ok(tmuxCalls.every(call => call.startsWith('list-sessions') || call.startsWith('has-session')), tmuxCalls.join('\n'))
  })

  it('retains mutation behavior when read-only mode is disabled', async () => {
    const fx = fixture()
    fs.mkdirSync(path.join(fx.state, 'uploads'))
    const { base } = await startServer(fx, false)
    const response = await fetch(`${base}/api/quick-links`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ label: 'Normal mode', url: 'https://example.test' }]),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fx.state, 'quick-links.json'), 'utf8')), [{ label: 'Normal mode', url: 'https://example.test' }])
  })
})
