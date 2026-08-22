import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'

const run = promisify(execFile)
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

function makeRoom(root, name) {
  const roomsDir = path.join(root, 'rooms')
  const roomDir = path.join(roomsDir, name)
  fs.mkdirSync(roomDir, { recursive: true })
  fs.writeFileSync(path.join(roomDir, 'AGENTS.md'), `# Room: #${name}\n`)
  fs.writeFileSync(path.join(roomDir, 'notes.md'), `# #${name} — notes\n`)
  return { roomsDir, roomDir }
}

describe('room updates CLI', () => {
  it('appends a multi-paragraph briefing and lists entries chronologically', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-room-updates-cli-'))
    roots.push(root)
    const { roomsDir, roomDir } = makeRoom(root, 'demo')
    const env = { ...process.env, HOME: root, ROOMS_DIR: roomsDir }
    const cli = path.resolve(import.meta.dirname, '../../bin/room')

    await run(cli, ['update', 'First outcome.\nWhy it matters: the herd is gone.'], { cwd: roomDir, env })
    await run(cli, ['update', 'Second outcome.'], { cwd: roomDir, env })

    const lines = fs.readFileSync(path.join(roomDir, 'updates.jsonl'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    const first = JSON.parse(lines[0])
    assert.equal(first.text, 'First outcome.\nWhy it matters: the herd is gone.')
    assert.match(first.id, /^[0-9a-f]{32}$/)
    assert.match(first.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)

    const listed = await run(cli, ['updates'], { cwd: roomDir, env })
    const firstAt = listed.stdout.indexOf('First outcome.')
    const secondAt = listed.stdout.indexOf('Second outcome.')
    assert.ok(firstAt >= 0 && secondAt >= 0, listed.stdout)
    assert.ok(firstAt < secondAt, 'entries render oldest-first')
    assert.match(listed.stdout, /Why it matters: the herd is gone\./)
  })

  it('reports an empty feed and refuses an empty update', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-room-updates-empty-'))
    roots.push(root)
    const { roomsDir, roomDir } = makeRoom(root, 'demo')
    const env = { ...process.env, HOME: root, ROOMS_DIR: roomsDir }
    const cli = path.resolve(import.meta.dirname, '../../bin/room')

    const listed = await run(cli, ['updates'], { cwd: roomDir, env })
    assert.match(listed.stdout, /no updates yet in #demo/)
    await assert.rejects(run(cli, ['update'], { cwd: roomDir, env }), /usage: room update/)
    assert.equal(fs.existsSync(path.join(roomDir, 'updates.jsonl')), false)
  })
})

describe('room updates API', () => {
  it('posts, reads back, summarizes in the snapshot, and validates input', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-room-updates-api-'))
    roots.push(root)
    const stateDir = path.join(root, 'state')
    fs.mkdirSync(path.join(root, '.feather'), { recursive: true })
    fs.mkdirSync(stateDir, { recursive: true })
    makeRoom(root, 'demo')

    const port = 31_000 + (process.pid % 1000)
    const base = `http://127.0.0.1:${port}`
    const child = spawn(process.execPath, ['server-single.js'], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env: {
        ...process.env, HOME: root, FEATHER_STATE_DIR: stateDir, PORT: String(port),
        FEATHER_ROOM_PULSES: '0',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    servers.push(child)
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })

    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(`${base}/api/health`)).ok) break } catch {}
      await new Promise((resolve) => setTimeout(resolve, 30))
    }

    const posted = await fetch(`${base}/api/rooms/demo/updates`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Shipped the updates feed.\nWhy it matters: you can walk in cold.' }),
    })
    assert.equal(posted.status, 200, stderr)
    const postedBody = await posted.json()
    assert.equal(postedBody.ok, true)
    assert.match(postedBody.update.id, /[0-9a-f-]{36}/)
    assert.equal(postedBody.update.text, 'Shipped the updates feed.\nWhy it matters: you can walk in cold.')

    const listed = await (await fetch(`${base}/api/rooms/demo/updates`)).json()
    assert.equal(listed.updates.length, 1)
    assert.equal(listed.updates[0].text, 'Shipped the updates feed.\nWhy it matters: you can walk in cold.')

    const snapshot = await (await fetch(`${base}/api/rooms`)).json()
    const demo = snapshot.rooms.find((room) => room.name === 'demo')
    assert.ok(demo, 'demo room present in snapshot')
    assert.equal(demo.updates.count, 1)
    assert.equal(demo.updates.latestAt, postedBody.update.ts)
    assert.match(demo.updates.latest, /Shipped the updates feed\. Why it matters/)

    assert.equal((await fetch(`${base}/api/rooms/demo/updates`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '   ' }),
    })).status, 400)
    assert.equal((await fetch(`${base}/api/rooms/nope/updates`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x' }),
    })).status, 404)
    assert.equal((await fetch(`${base}/api/rooms/nope/updates`)).status, 404)

    const renamed = await fetch(`${base}/api/rooms/demo/rename`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'renamed-demo' }),
    })
    assert.equal(renamed.status, 200, stderr)
    assert.equal(fs.existsSync(path.join(root, 'rooms/demo')), false)
    assert.equal(fs.existsSync(path.join(root, 'rooms/renamed-demo/updates.jsonl')), true)
    assert.match(fs.readFileSync(path.join(root, 'rooms/renamed-demo/AGENTS.md'), 'utf8'), /# Room: #renamed-demo/)
    const afterRename = await (await fetch(`${base}/api/rooms`)).json()
    assert.ok(afterRename.rooms.some(room => room.name === 'renamed-demo'))
    assert.ok(!afterRename.rooms.some(room => room.name === 'demo'))
    assert.equal((await fetch(`${base}/api/rooms/renamed-demo/updates`)).status, 200)
  })
})
