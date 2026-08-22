import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'

import { encodeProjectPath, groupRoomSessions } from '../../lib/rooms.js'

const roots = []

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true })
})

function writeClaudeSession(file, { id, cwd, title, timestamp }) {
  fs.writeFileSync(file, JSON.stringify({
    type: 'user', uuid: `${id}-message`, cwd, timestamp,
    isMeta: false, isSidechain: false,
    message: { role: 'user', content: title },
  }) + '\n')
}

describe('portable Room membership', () => {
  it('derives a Room project id from a non-default Rooms root', () => {
    assert.equal(
      encodeProjectPath('/srv/zak/home/rooms/marriage'),
      '-srv-zak-home-rooms-marriage',
    )

    const cwdSession = { id: 'cwd-session', projectId: '-srv-zak-home-rooms-marriage', updatedAt: '2026-01-01T00:00:00Z' }
    const grouped = groupRoomSessions({
      roomNames: ['marriage'],
      roomsRoot: '/srv/zak/home/rooms',
      assignments: {},
      sessions: [cwdSession],
    })
    assert.deepEqual(grouped.get('marriage').map((session) => session.id), ['cwd-session'])
    assert.equal(grouped.get('marriage')[0], cwdSession)
  })

  it('gives explicit assignments precedence and restores cwd membership after detach', () => {
    const sessions = [
      { id: 'newest', projectId: '-srv-home-rooms-marriage', updatedAt: '2026-02-01T00:00:00Z' },
      { id: 'moved', projectId: '-srv-home-rooms-marriage', updatedAt: '2026-01-01T00:00:00Z' },
    ]
    const moved = groupRoomSessions({
      roomNames: ['marriage', 'other'],
      roomsRoot: '/srv/home/rooms',
      assignments: { moved: 'other' },
      sessions,
    })
    assert.deepEqual(moved.get('marriage').map((session) => session.id), ['newest'])
    assert.deepEqual(moved.get('other').map((session) => session.id), ['moved'])
    assert.equal(moved.get('other')[0].roomAssigned, true)

    const detached = groupRoomSessions({
      roomNames: ['marriage', 'other'],
      roomsRoot: '/srv/home/rooms',
      assignments: {},
      sessions: [...sessions, sessions[1]],
    })
    assert.deepEqual(detached.get('marriage').map((session) => session.id), ['newest', 'moved'])
    assert.equal(detached.get('marriage')[1].roomAssigned, undefined)
  })

  it('includes a non-default-home Room session and an assigned session older than the discovery limit', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-rooms-portable-'))
    roots.push(root)
    const home = path.join(root, 'zak-home')
    const stateDir = path.join(root, 'state')
    const projects = path.join(home, '.claude/projects')
    const roomDir = path.join(home, 'rooms/marriage')
    const otherRoomDir = path.join(home, 'rooms/other')
    const ordinaryProject = path.join(projects, encodeProjectPath(path.join(home, 'ordinary')))
    const roomProject = path.join(projects, encodeProjectPath(roomDir))
    fs.mkdirSync(stateDir)
    fs.mkdirSync(ordinaryProject, { recursive: true })
    fs.mkdirSync(roomProject, { recursive: true })
    fs.mkdirSync(path.join(home, '.feather'), { recursive: true })
    fs.mkdirSync(roomDir, { recursive: true })
    fs.mkdirSync(otherRoomDir, { recursive: true })
    fs.writeFileSync(path.join(roomDir, 'AGENTS.md'), '# Room: #marriage\n')
    fs.writeFileSync(path.join(roomDir, 'notes.md'), '# #marriage — notes\n')
    fs.writeFileSync(path.join(otherRoomDir, 'AGENTS.md'), '# Room: #other\n')
    fs.writeFileSync(path.join(otherRoomDir, 'notes.md'), '# #other — notes\n')

    const baseMs = Date.parse('2026-08-22T12:00:00Z')
    for (let index = 0; index < 300; index++) {
      const id = `recent-${String(index).padStart(3, '0')}`
      const file = path.join(ordinaryProject, `${id}.jsonl`)
      writeClaudeSession(file, {
        id, cwd: path.join(home, 'ordinary'), title: `Recent session ${index}`,
        timestamp: new Date(baseMs + index * 1000).toISOString(),
      })
      fs.utimesSync(file, new Date(baseMs + index * 1000), new Date(baseMs + index * 1000))
    }

    const cwdId = 'cwd-marriage-session'
    const cwdFile = path.join(roomProject, `${cwdId}.jsonl`)
    writeClaudeSession(cwdFile, {
      id: cwdId, cwd: roomDir, title: 'Portable marriage session',
      timestamp: new Date(baseMs + 400_000).toISOString(),
    })
    fs.utimesSync(cwdFile, new Date(baseMs + 400_000), new Date(baseMs + 400_000))

    const movedId = 'moved-marriage-session'
    const movedFile = path.join(roomProject, `${movedId}.jsonl`)
    writeClaudeSession(movedFile, {
      id: movedId, cwd: roomDir, title: 'Temporarily moved marriage session',
      timestamp: new Date(baseMs + 500_000).toISOString(),
    })
    fs.utimesSync(movedFile, new Date(baseMs + 500_000), new Date(baseMs + 500_000))

    const oldId = 'historical-marriage-session'
    const oldFile = path.join(ordinaryProject, `${oldId}.jsonl`)
    writeClaudeSession(oldFile, {
      id: oldId, cwd: path.join(home, 'ordinary'), title: 'Historical marriage conversation',
      timestamp: '2020-01-01T00:00:00Z',
    })
    fs.utimesSync(oldFile, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'))
    fs.writeFileSync(path.join(home, '.feather/room-sessions.json'), JSON.stringify({
      [oldId]: 'marriage',
      [movedId]: 'other',
    }))

    const port = 24_000 + (process.pid % 10_000)
    const child = spawn(process.execPath, ['server-single.js'], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env: { ...process.env, HOME: home, FEATHER_STATE_DIR: stateDir, PORT: String(port) },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    try {
      let rooms
      for (let attempt = 0; attempt < 80; attempt++) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/rooms`)
          if (response.ok) { rooms = (await response.json()).rooms; break }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      assert.ok(rooms, stderr || 'server did not become ready')
      const marriage = rooms.find((room) => room.name === 'marriage')
      assert.deepEqual(marriage.sessions.map((session) => session.id), [cwdId, oldId])
      assert.equal(marriage.sessions[1].title, 'Historical marriage conversation')
      assert.equal(marriage.sessions[1].roomAssigned, true)
      assert.deepEqual(rooms.find((room) => room.name === 'other').sessions.map((session) => session.id), [movedId])

      const wrongRoomDetach = await fetch(`http://127.0.0.1:${port}/api/rooms/marriage/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: movedId, remove: true }),
      })
      assert.equal(wrongRoomDetach.status, 409)
      assert.match((await wrongRoomDetach.json()).error, /not assigned to #marriage/)
      rooms = (await (await fetch(`http://127.0.0.1:${port}/api/rooms`)).json()).rooms
      assert.deepEqual(rooms.find((room) => room.name === 'other').sessions.map((session) => session.id), [movedId])

      const detach = await fetch(`http://127.0.0.1:${port}/api/rooms/other/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: movedId, remove: true }),
      })
      assert.equal(detach.status, 200)
      rooms = (await (await fetch(`http://127.0.0.1:${port}/api/rooms`)).json()).rooms
      assert.deepEqual(rooms.find((room) => room.name === 'marriage').sessions.map((session) => session.id), [movedId, cwdId, oldId])
      assert.equal(new Set(rooms.flatMap((room) => room.sessions.map((session) => session.id))).size,
        rooms.flatMap((room) => room.sessions).length)
    } finally {
      child.kill('SIGTERM')
      if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve))
    }
  })
})
