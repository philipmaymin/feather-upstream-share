import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { ompSessionIdFromHead } from '../../lib/omp-session.js'

const roots = []
const children = []
afterEach(async () => {
  while (children.length) {
    const child = children.pop()
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await new Promise(resolve => child.once('exit', resolve))
    }
  }
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true })
})

const sessionLine = (id) => JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-08-22T20:06:35.565Z', cwd: '/tmp/project' })

async function waitForServer(base) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return } catch {}
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error('test server did not start')
}

describe('safe OMP resume', () => {
  it('finds a session record after mutable title metadata', () => {
    const head = `${JSON.stringify({ type: 'title', title: 'Rewritten title' })}\n${sessionLine('omp-exact-id')}\n`
    assert.equal(ompSessionIdFromHead(head), 'omp-exact-id')
    assert.equal(ompSessionIdFromHead(`${JSON.stringify({ type: 'title' })}\n`), null)
    assert.equal(ompSessionIdFromHead(`{"truncated"\n${sessionLine('omp-after-malformed')}\n`), 'omp-after-malformed')
  })

  it('resumes the exact embedded OMP id and refuses unsafe continue fallback', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-omp-resume-'))
    roots.push(root)
    const home = path.join(root, 'home')
    const stateDir = path.join(root, 'state')
    const binDir = path.join(root, 'bin')
    const tmuxLog = path.join(root, 'tmux.log')
    fs.mkdirSync(path.join(home, '.feather/omp-sessions'), { recursive: true })
    fs.mkdirSync(stateDir, { recursive: true })
    fs.mkdirSync(binDir, { recursive: true })

    const goodFeatherId = 'resume-good-feather-id'
    const goodDir = path.join(home, '.feather/omp-sessions', goodFeatherId)
    fs.mkdirSync(goodDir)
    fs.writeFileSync(path.join(goodDir, '2026-08-23_good.jsonl'), [
      JSON.stringify({ type: 'title', title: 'Mutable title before session' }),
      sessionLine('omp-exact-resume-id'),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'hello' } }),
    ].join('\n') + '\n')

    const badFeatherId = 'resume-bad-feather-id'
    const badDir = path.join(home, '.feather/omp-sessions', badFeatherId)
    fs.mkdirSync(badDir)
    fs.writeFileSync(path.join(badDir, '2026-08-23_bad.jsonl'), `${JSON.stringify({ type: 'title', title: 'No session record' })}\n`)

    fs.writeFileSync(path.join(binDir, 'tmux'), `#!/bin/sh
printf '%s\\n' "$*" >> "$TMUX_TEST_LOG"
case "$1" in
  list-panes) printf 'omp\\n' ;;
  capture-pane) printf '>\\n' ;;
esac
exit 0
`)
    fs.chmodSync(path.join(binDir, 'tmux'), 0o755)

    const port = 32_000 + (process.pid % 1000)
    const base = `http://127.0.0.1:${port}`
    const child = spawn(process.execPath, ['server-single.js'], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env: {
        ...process.env, HOME: home, FEATHER_STATE_DIR: stateDir, PORT: String(port),
        FEATHER_ROOM_PULSES: '0', PATH: `${binDir}:${process.env.PATH}`, TMUX_TEST_LOG: tmuxLog,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    children.push(child)
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    await waitForServer(base)

    const good = await fetch(`${base}/api/sessions/${goodFeatherId}/resume`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })
    assert.equal(good.status, 200, stderr)
    const logAfterGood = fs.readFileSync(tmuxLog, 'utf8')
    assert.match(logAfterGood, /--resume/)
    assert.match(logAfterGood, /omp-exact-resume-id/)
    assert.doesNotMatch(logAfterGood, /--continue/)

    const bad = await fetch(`${base}/api/sessions/${badFeatherId}/resume`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })
    assert.equal(bad.status, 500)
    assert.match((await bad.json()).error, /exact OMP session id not found/)
    assert.equal(fs.readFileSync(tmuxLog, 'utf8'), logAfterGood, 'failed resume must not launch tmux')
  })
})
