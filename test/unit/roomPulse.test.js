import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'

const roots = []
const servers = []

afterEach(async () => {
  while (servers.length) {
    const child = servers.pop()
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('exit', resolve))
  }
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true })
})

describe('room pulse API', () => {
  it('lets a pulse pause itself without killing its caller', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-room-self-pause-'))
    roots.push(root)
    const stateDir = path.join(root, 'state')
    const roomDir = path.join(root, 'rooms/demo')
    const featherDir = path.join(root, '.feather')
    const binDir = path.join(root, 'bin')
    const tmuxLog = path.join(root, 'tmux.log')
    fs.mkdirSync(stateDir, { recursive: true })
    fs.mkdirSync(roomDir, { recursive: true })
    fs.mkdirSync(featherDir, { recursive: true })
    fs.mkdirSync(binDir, { recursive: true })
    fs.writeFileSync(path.join(roomDir, 'AGENTS.md'), '# Room: #demo\n')
    fs.writeFileSync(path.join(roomDir, 'notes.md'), '# notes\n')

    const sessionId = '11111111-1111-4111-8111-111111111111'
    fs.writeFileSync(path.join(featherDir, 'room-pulses.json'), JSON.stringify({
      demo: {
        enabled: true,
        status: 'working',
        lastRunAt: '2026-08-30T13:00:00Z',
        nextRunAtMs: Date.now() + 60_000,
        sessionId,
        error: null,
      },
    }))
    const fakeTmux = path.join(binDir, 'tmux')
    fs.writeFileSync(fakeTmux, '#!/bin/sh\nprintf "%s\\n" "$*" >>"$TMUX_TEST_LOG"\n')
    fs.chmodSync(fakeTmux, 0o755)

    const port = 32_000 + (process.pid % 1000)
    const base = `http://127.0.0.1:${port}`
    const child = spawn(process.execPath, ['server-single.js'], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env: {
        ...process.env,
        HOME: root,
        FEATHER_STATE_DIR: stateDir,
        FEATHER_ROOM_PULSES: '0',
        PORT: String(port),
        PATH: `${binDir}:${process.env.PATH}`,
        TMUX_TEST_LOG: tmuxLog,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    servers.push(child)
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })

    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) {
          ready = true
          break
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    assert.equal(ready, true, stderr)
    fs.writeFileSync(tmuxLog, '')

    const selfPause = await fetch(`${base}/api/rooms/demo/pulse`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Feather-Session-ID': sessionId,
      },
      body: JSON.stringify({ enabled: false }),
    })
    assert.equal(selfPause.status, 200, stderr)
    const selfBody = await selfPause.json()
    assert.equal(selfBody.pulse.enabled, false)
    assert.equal(selfBody.pulse.status, 'paused')
    assert.equal(selfBody.pulse.nextRunAt, null)
    assert.equal(fs.readFileSync(tmuxLog, 'utf8'), '')

    const saved = JSON.parse(fs.readFileSync(path.join(featherDir, 'room-pulses.json'), 'utf8'))
    assert.equal(saved.demo.enabled, false)
    assert.equal(saved.demo.nextRunAtMs, null)

    assert.equal((await fetch(`${base}/api/rooms/demo/pulse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })).status, 200)
    fs.writeFileSync(tmuxLog, '')
    assert.equal((await fetch(`${base}/api/rooms/demo/pulse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })).status, 200)
    assert.match(fs.readFileSync(tmuxLog, 'utf8'), /kill-session/)
  })
})
