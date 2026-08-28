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
  it('lists a multi-paragraph briefing chronologically', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-room-updates-cli-'))
    roots.push(root)
    const { roomsDir, roomDir } = makeRoom(root, 'demo')
    const env = { ...process.env, HOME: root, ROOMS_DIR: roomsDir }
    const cli = path.resolve(import.meta.dirname, '../../bin/room')
    fs.writeFileSync(path.join(roomDir, 'updates.jsonl'), [
      JSON.stringify({ id: 'a'.repeat(32), ts: '2026-08-25T10:00:00Z', text: 'First outcome.\nWhy it matters: the herd is gone.' }),
      JSON.stringify({ id: 'b'.repeat(32), ts: '2026-08-25T11:00:00Z', text: 'Second outcome.' }),
    ].join('\n') + '\n')

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
    const { roomDir } = makeRoom(root, 'demo')

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

    const cli = path.resolve(import.meta.dirname, '../../bin/room')
    const env = { ...process.env, HOME: root, ROOMS_DIR: path.join(root, 'rooms'), FEATHER_URL: base }
    await run(cli, ['update', 'Shipped the updates feed.\nWhy it matters: you can walk in cold.'], { cwd: roomDir, env })
    const listed = await (await fetch(`${base}/api/rooms/demo/updates`)).json()
    assert.equal(listed.updates.length, 1)
    const postedBody = { update: listed.updates[0] }
    assert.match(postedBody.update.id, /[0-9a-f-]{36}/)
    assert.equal(postedBody.update.text, 'Shipped the updates feed.\nWhy it matters: you can walk in cold.')


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
