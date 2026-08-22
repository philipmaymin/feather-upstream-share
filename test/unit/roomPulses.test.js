import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'

import { encodeProjectPath } from '../../lib/rooms.js'

const roots = []
afterEach(() => { while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true }) })

function sessionLine(id, cwd, text) {
  return JSON.stringify({
    type: 'user', uuid: `${id}-message`, cwd, timestamp: new Date().toISOString(),
    isMeta: false, isSidechain: false, message: { role: 'user', content: text },
  }) + '\n'
}

describe('Room keep-working scheduler', () => {
  it('skips a live room and launches exactly one autonomous OMP run for a due idle room', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-room-pulse-'))
    roots.push(root)
    const home = path.join(root, 'home')
    const stateDir = path.join(root, 'state')
    const binDir = path.join(root, 'bin')
    const tmuxLog = path.join(root, 'tmux.log')
    const activeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const rooms = ['active', 'idle', 'broken']
    fs.mkdirSync(path.join(home, '.feather'), { recursive: true })
    fs.mkdirSync(stateDir, { recursive: true })
    fs.mkdirSync(binDir, { recursive: true })
    for (const name of rooms) {
      const roomDir = path.join(home, 'rooms', name)
      fs.mkdirSync(roomDir, { recursive: true })
      fs.writeFileSync(path.join(roomDir, 'AGENTS.md'), `# Room: #${name}\n`)
      fs.writeFileSync(path.join(roomDir, 'notes.md'), `# #${name} — notes\n`)
    }
    const activeProject = path.join(home, '.claude/projects', encodeProjectPath(path.join(home, 'rooms/active')))
    fs.mkdirSync(activeProject, { recursive: true })
    fs.writeFileSync(path.join(activeProject, `${activeId}.jsonl`), sessionLine(activeId, path.join(home, 'rooms/active'), 'still working'))
    const due = (sessionId = null) => ({ enabled: true, status: 'waiting', lastRunAt: null, nextRunAtMs: 1, sessionId, error: null })
    fs.writeFileSync(path.join(home, '.feather/room-pulses.json'), JSON.stringify({ active: due(), idle: due(), broken: due() }))
    fs.writeFileSync(path.join(binDir, 'tmux'), `#!/bin/sh\nif [ "$1" = list-sessions ]; then printf 'f-aaaaaaaa|%s\\n' "$(date +%s)"; exit 0; fi\nif [ "$1" = has-session ] && [ "$3" = f-aaaaaaaa ]; then exit 0; fi\nif [ "$1" = new-session ]; then case "$*" in *rooms/broken*) exit 1;; esac; printf '%s\\n' "$*" >>"$TMUX_TEST_LOG"; exit 0; fi\nexit 1\n`)
    fs.chmodSync(path.join(binDir, 'tmux'), 0o755)

    const port = 29_000 + (process.pid % 1000)
    const child = spawn(process.execPath, ['server-single.js'], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env: {
        ...process.env, HOME: home, FEATHER_STATE_DIR: stateDir, PORT: String(port),
        FEATHER_ROOM_PULSE_CHECK_MS: '50', FEATHER_ROOM_PULSE_INTERVAL_MS: '60000',
        PATH: `${binDir}:${process.env.PATH}`, TMUX_TEST_LOG: tmuxLog,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    try {
      let state
      for (let attempt = 0; attempt < 100; attempt++) {
        try { state = JSON.parse(fs.readFileSync(path.join(home, '.feather/room-pulses.json'), 'utf8')) } catch {}
        if (state?.idle?.status === 'working' && state?.broken?.status === 'error' && state?.active?.nextRunAtMs > Date.now() && fs.existsSync(tmuxLog)) break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert.equal(state?.idle?.status, 'working', stderr)
      assert.match(state.idle.sessionId, /^[0-9a-f-]{36}$/)
      assert.equal(state.active.status, 'waiting')
      assert.equal(state.broken.status, 'error')
      assert.match(state.broken.error, /Command failed/)
      assert.ok(state.active.nextRunAtMs > Date.now())
      const launches = fs.readFileSync(tmuxLog, 'utf8').trim().split('\n')
      assert.equal(launches.length, 1)
      assert.match(launches[0], /omp -p --auto-approve .*pulse\.md/)
      assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.feather/room-sessions.json'), 'utf8'))[state.idle.sessionId], 'idle')

    } finally {
      child.kill('SIGTERM')
      await new Promise((resolve) => child.once('exit', resolve))
    }
  })
})
