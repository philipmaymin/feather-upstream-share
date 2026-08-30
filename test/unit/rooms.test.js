import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { createHash } from 'crypto'

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

  it('includes old assigned sessions and a freshly spawned transcriptless Leader', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-rooms-portable-'))
    roots.push(root)
    const home = path.join(root, 'zak-home')
    const stateDir = path.join(root, 'state')
    const projects = path.join(home, '.claude/projects')
    const roomDir = path.join(home, 'rooms/marriage')
    const otherRoomDir = path.join(home, 'rooms/other')
    const freshRoomDir = path.join(home, 'rooms/fresh')
    const ordinaryProject = path.join(projects, encodeProjectPath(path.join(home, 'ordinary')))
    const roomProject = path.join(projects, encodeProjectPath(roomDir))
    fs.mkdirSync(stateDir)
    fs.mkdirSync(ordinaryProject, { recursive: true })
    fs.mkdirSync(roomProject, { recursive: true })
    fs.mkdirSync(path.join(home, '.feather'), { recursive: true })
    fs.mkdirSync(roomDir, { recursive: true })
    fs.mkdirSync(otherRoomDir, { recursive: true })
    fs.mkdirSync(freshRoomDir, { recursive: true })
    fs.writeFileSync(path.join(roomDir, 'AGENTS.md'), '# Room: #marriage\n')
    fs.writeFileSync(path.join(roomDir, 'notes.md'), '# #marriage — notes\n')
    fs.writeFileSync(path.join(otherRoomDir, 'AGENTS.md'), '# Room: #other\n')
    fs.writeFileSync(path.join(otherRoomDir, 'notes.md'), '# #other — notes\n')
    fs.writeFileSync(path.join(freshRoomDir, 'AGENTS.md'), '# Room: #fresh\n')
    fs.writeFileSync(path.join(freshRoomDir, 'notes.md'), '# #fresh — notes\n')
    const invalidRoomDir = path.join(home, 'rooms/Bad Room')
    fs.mkdirSync(invalidRoomDir)
    fs.writeFileSync(path.join(invalidRoomDir, 'AGENTS.md'), '# invalid\n')
    fs.symlinkSync('marriage', path.join(home, 'rooms/linked'))

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
    const cwdId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const cwdFile = path.join(roomProject, `${cwdId}.jsonl`)
    writeClaudeSession(cwdFile, {
      id: cwdId, cwd: roomDir, title: 'Portable marriage session',
      timestamp: '2019-01-01T00:00:00Z',
    })
    fs.utimesSync(cwdFile, new Date('2019-01-01T00:00:00Z'), new Date('2019-01-01T00:00:00Z'))

    const movedId = 'moved-marriage-session'
    const movedFile = path.join(roomProject, `${movedId}.jsonl`)
    writeClaudeSession(movedFile, {
      id: movedId, cwd: roomDir, title: 'Temporarily moved marriage session',
      timestamp: new Date(baseMs + 500_000).toISOString(),
    })
    fs.utimesSync(movedFile, new Date(baseMs + 500_000), new Date(baseMs + 500_000))

    const oldId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const oldFile = path.join(ordinaryProject, `${oldId}.jsonl`)
    writeClaudeSession(oldFile, {
      id: oldId, cwd: path.join(home, 'ordinary'), title: 'Historical marriage conversation',
      timestamp: '2020-01-01T00:00:00Z',
    })
    fs.utimesSync(oldFile, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'))

    const residentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const residentFile = path.join(ordinaryProject, `${residentId}.jsonl`)
    writeClaudeSession(residentFile, {
      id: residentId, cwd: path.join(home, 'ordinary'), title: 'Marriage Caretaker',
      timestamp: '2021-01-01T00:00:00Z',
    })
    fs.utimesSync(residentFile, new Date('2021-01-01T00:00:00Z'), new Date('2021-01-01T00:00:00Z'))
    const freshLeaderId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    fs.mkdirSync(path.join(home, '.feather/omp-sessions', freshLeaderId), { recursive: true })
    fs.writeFileSync(path.join(stateDir, 'session-meta.json'), JSON.stringify({
      [freshLeaderId]: { agent: 'omp', cwd: freshRoomDir, title: '#fresh Leader' },
    }))
    fs.writeFileSync(path.join(home, '.feather/room-sessions.json'), JSON.stringify({
      [oldId]: 'marriage',
      [residentId]: 'marriage',
      [movedId]: 'other',
      [freshLeaderId]: 'fresh',
    }))
    fs.writeFileSync(path.join(home, '.feather/room-mains.json'), JSON.stringify({ marriage: oldId, fresh: freshLeaderId }))
    fs.writeFileSync(path.join(home, '.feather/room-residents.json'), JSON.stringify({
      marriage: { caretaker: { sessionId: residentId } },
    }))
    fs.writeFileSync(path.join(home, '.feather/room-pulses.json'), JSON.stringify({
      marriage: {
        enabled: true, status: 'working', lastRunAt: null, nextRunAtMs: Date.now() + 60_000,
        sessionId: cwdId, error: null,
      },
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
      assert.equal(rooms.some((room) => room.name === 'Bad Room' || room.name === 'linked'), false)
      assert.equal(marriage.pulse.enabled, true)
      assert.equal(marriage.pulse.status, 'working')
      assert.equal(marriage.pulse.sessionId, cwdId)
      assert.equal(marriage.leaderSessionId, oldId)
      assert.deepEqual(marriage.sessions.map((session) => session.id), [residentId, oldId, cwdId])
      const historical = marriage.sessions.find((session) => session.id === oldId)
      assert.equal(historical.title, 'Historical marriage conversation')
      assert.equal(historical.roomAssigned, true)
      assert.deepEqual(rooms.find((room) => room.name === 'other').sessions.map((session) => session.id), [movedId])
      assert.deepEqual(marriage.residents.map((resident) => [resident.role, resident.sessionId]), [
        ['leader', oldId],
        ['caretaker', residentId],
      ])
      const fresh = rooms.find((room) => room.name === 'fresh')
      assert.equal(fresh.leaderSessionId, freshLeaderId)
      assert.deepEqual(fresh.sessions.map((session) => session.id), [freshLeaderId])
      assert.equal(fresh.sessions[0].title, '#fresh Leader')
      assert.equal(fresh.sessions[0].roomAssigned, true)
      assert.deepEqual(fresh.residents.map((resident) => [resident.role, resident.sessionId]), [
        ['leader', freshLeaderId],
      ])

      const blockedDetach = await fetch(`http://127.0.0.1:${port}/api/rooms/marriage/assign`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: oldId, remove: true }),
      })
      assert.equal(blockedDetach.status, 409)
      assert.match((await blockedDetach.json()).error, /Leader.*cannot be moved or detached/)
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, '.feather/room-mains.json'), 'utf8')), {
        marriage: oldId,
        fresh: freshLeaderId,
      })
      const blockedResidentDetach = await fetch(`http://127.0.0.1:${port}/api/rooms/marriage/assign`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: residentId, remove: true }),
      })
      assert.equal(blockedResidentDetach.status, 409)
      assert.match((await blockedResidentDetach.json()).error, /resident caretaker.*cannot be moved or detached/)

      const roomSidecar = await (await fetch(`http://127.0.0.1:${port}/api/sidecar/room-marriage`)).json()
      assert.equal(roomSidecar.group.kind, 'room')
      assert.deepEqual(roomSidecar.group.members.map((member) => member.role), ['leader', 'caretaker'])
      const rejectRoomGroupDelete = await fetch(`http://127.0.0.1:${port}/api/sidecar/room-marriage/delete`, { method: 'POST' })
      assert.equal(rejectRoomGroupDelete.status, 409)

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
      assert.deepEqual(rooms.find((room) => room.name === 'marriage').sessions.map((session) => session.id), [movedId, residentId, oldId, cwdId])
      assert.equal(new Set(rooms.flatMap((room) => room.sessions.map((session) => session.id))).size,
        rooms.flatMap((room) => room.sessions).length)

      const pause = await fetch(`http://127.0.0.1:${port}/api/rooms/marriage/pulse`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }),
      })
      assert.equal(pause.status, 200)
      assert.equal((await pause.json()).pulse.enabled, false)
      rooms = (await (await fetch(`http://127.0.0.1:${port}/api/rooms`)).json()).rooms
      assert.equal(rooms.find((room) => room.name === 'marriage').pulse.status, 'paused')
    } finally {
      child.kill('SIGTERM')
      if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve))
    }
  })

  it('deletes a complete OMP identity and reconciles ghosts only on explicit apply', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-rooms-delete-'))
    roots.push(root)
    const home = path.join(root, 'home')
    const stateDir = path.join(root, 'state')
    const featherDir = path.join(home, '.feather')
    const ompRoot = path.join(featherDir, 'omp-sessions')
    const binDir = path.join(root, 'bin')
    fs.mkdirSync(stateDir, { recursive: true })
    fs.mkdirSync(ompRoot, { recursive: true })
    fs.mkdirSync(binDir)
    fs.writeFileSync(path.join(binDir, 'tmux'), `#!/bin/sh
case "$1" in
  list-sessions) exit 0 ;;
  has-session) exit 1 ;;
  new-session|kill-session) exit 0 ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 })

    const deletedId = '40000000-0000-4000-8000-000000000003'
    const replacementLeaderId = '40000000-0000-4000-8000-000000000004'
    const replacementResidentId = '40000000-0000-4000-8000-000000000005'
    const replacementPulseId = '40000000-0000-4000-8000-000000000006'
    const pendingLeaderId = '40000000-0000-4000-8000-000000000007'
    const ghostId = '40000000-0000-4000-8000-000000000008'
    const unknownId = '40000000-0000-4000-8000-000000000009'
    const roomNames = ['alpha', 'beta', 'gamma', 'pending', 'ghost']
    for (const name of roomNames) {
      const roomDir = path.join(home, 'rooms', name)
      fs.mkdirSync(roomDir, { recursive: true })
      fs.writeFileSync(path.join(roomDir, 'AGENTS.md'), `# Room: #${name}\n`)
    }

    const writeOmpIdentity = (id, cwd, rollouts = 1) => {
      const dir = path.join(ompRoot, id)
      fs.mkdirSync(dir, { recursive: true })
      for (let index = 0; index < rollouts; index++) {
        fs.writeFileSync(path.join(dir, `2026-08-30T00-00-0${index}_rollout.jsonl`), [
          JSON.stringify({ type: 'session', version: 3, id: `${id}-${index}`, timestamp: '2026-08-30T00:00:00Z', cwd }),
          JSON.stringify({ type: 'message', message: { role: 'user', content: `rollout ${index}` } }),
        ].join('\n') + '\n')
      }
      return dir
    }
    const deletedDir = writeOmpIdentity(deletedId, path.join(home, 'rooms/alpha'), 2)
    writeOmpIdentity(replacementLeaderId, path.join(home, 'rooms/beta'))
    writeOmpIdentity(replacementResidentId, path.join(home, 'rooms/beta'))
    writeOmpIdentity(replacementPulseId, path.join(home, 'rooms/beta'))
    fs.mkdirSync(path.join(ompRoot, pendingLeaderId))
    const sentinel = path.join(ompRoot, 'unrelated.txt')
    fs.writeFileSync(sentinel, 'preserve')

    fs.writeFileSync(path.join(stateDir, 'session-meta.json'), JSON.stringify({
      [deletedId]: { agent: 'omp', cwd: path.join(home, 'rooms/alpha') },
      [replacementLeaderId]: { agent: 'omp', cwd: path.join(home, 'rooms/beta') },
      [replacementResidentId]: { agent: 'omp', cwd: path.join(home, 'rooms/beta') },
      [replacementPulseId]: { agent: 'omp', cwd: path.join(home, 'rooms/beta') },
      [pendingLeaderId]: { agent: 'omp', cwd: path.join(home, 'rooms/pending'), title: '#pending Leader' },
      untouched: { title: 'preserve' },
    }))
    const assignmentsFile = path.join(featherDir, 'room-sessions.json')
    const leadersFile = path.join(featherDir, 'room-mains.json')
    const residentsFile = path.join(featherDir, 'room-residents.json')
    const pulsesFile = path.join(featherDir, 'room-pulses.json')
    fs.writeFileSync(assignmentsFile, JSON.stringify({
      [deletedId]: 'alpha',
      [replacementLeaderId]: 'beta',
      [replacementResidentId]: 'beta',
      [replacementPulseId]: 'beta',
      [pendingLeaderId]: 'pending',
      [ghostId]: 'ghost',
    }))
    fs.writeFileSync(leadersFile, JSON.stringify({
      alpha: deletedId, beta: replacementLeaderId, pending: pendingLeaderId, ghost: ghostId,
    }))
    fs.writeFileSync(residentsFile, JSON.stringify({
      beta: {
        caretaker: { sessionId: deletedId },
        reviewer: { sessionId: replacementResidentId },
      },
    }))
    const pulse = sessionId => ({
      enabled: true, status: 'waiting', lastRunAt: null, nextRunAtMs: null, sessionId, error: null,
    })
    fs.writeFileSync(pulsesFile, JSON.stringify({
      gamma: pulse(deletedId),
      beta: pulse(replacementPulseId),
    }))

    const receiptsDir = path.join(stateDir, 'uploads')
    fs.mkdirSync(receiptsDir)
    const receiptsFile = path.join(receiptsDir, '.message-receipts.json')
    const receipt = {
      textHash: 'a'.repeat(64),
      response: { ok: true, sentAt: '2026-08-30T00:00:00Z' },
    }
    fs.writeFileSync(receiptsFile, JSON.stringify({
      [deletedId]: { 'delete-receipt': receipt },
      untouched: { 'keep-receipt': receipt },
    }))
    const tokenDir = path.join(ompRoot, '.feather-bridge-tokens')
    fs.mkdirSync(tokenDir)
    const tokenPath = path.join(tokenDir, createHash('sha256').update(deletedId).digest('hex'))
    fs.writeFileSync(tokenPath, 'fixture-token')

    const sidecarDir = path.join(featherDir, 'sidecars')
    fs.mkdirSync(path.join(sidecarDir, 'manual-group'), { recursive: true })
    fs.writeFileSync(path.join(sidecarDir, 'groups.json'), JSON.stringify({
      'manual-group': {
        id: 'manual-group',
        kind: 'sidecar',
        members: [
          { sessionId: deletedId, role: 'driver', spawned: false },
          { sessionId: replacementResidentId, role: 'peer', spawned: true },
        ],
        status: 'active',
        seq: 0,
        createdAt: 1,
      },
    }))

    const port = 26_000 + (process.pid % 10_000)
    const child = spawn(process.execPath, ['server-single.js'], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env: {
        ...process.env,
        HOME: home,
        FEATHER_STATE_DIR: stateDir,
        PORT: String(port),
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    const base = `http://127.0.0.1:${port}`
    try {
      let ready = false
      for (let attempt = 0; attempt < 80; attempt++) {
        try {
          const response = await fetch(`${base}/api/health`)
          if (response.ok) { ready = true; break }
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      assert.equal(ready, true, stderr || 'server did not become ready')

      const beforeDryRun = fs.readFileSync(assignmentsFile, 'utf8')
      const dryRun = await fetch(`${base}/api/rooms/reconcile`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      })
      assert.equal(dryRun.status, 200)
      const dryBody = await dryRun.json()
      assert.equal(dryBody.dryRun, true)
      assert.ok(dryBody.ghosts.some(ghost => ghost.sessionId === ghostId && ghost.kind === 'assignment'))
      assert.equal(dryBody.ghosts.some(ghost => ghost.sessionId === pendingLeaderId), false)
      assert.equal(fs.readFileSync(assignmentsFile, 'utf8'), beforeDryRun)

      const applied = await fetch(`${base}/api/rooms/reconcile`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apply: true }),
      })
      assert.equal(applied.status, 200)
      assert.deepEqual((await applied.json()).removedSessionIds, [ghostId])
      assert.equal(ghostId in JSON.parse(fs.readFileSync(assignmentsFile, 'utf8')), false)
      assert.equal(JSON.parse(fs.readFileSync(leadersFile, 'utf8')).pending, pendingLeaderId)

      const unknownAssignment = await fetch(`${base}/api/rooms/beta/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: unknownId }),
      })
      assert.equal(unknownAssignment.status, 404)
      assert.match((await unknownAssignment.json()).error, /unknown session identity/)
      assert.equal(unknownId in JSON.parse(fs.readFileSync(assignmentsFile, 'utf8')), false)

      const deleted = await fetch(`${base}/api/sessions/${deletedId}/delete`, { method: 'POST' })
      assert.equal(deleted.status, 200, JSON.stringify(await deleted.clone().json()))
      assert.equal(fs.existsSync(deletedDir), false)
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve')
      assert.equal(fs.existsSync(tokenPath), false)
      assert.equal(deletedId in JSON.parse(fs.readFileSync(assignmentsFile, 'utf8')), false)
      assert.equal('alpha' in JSON.parse(fs.readFileSync(leadersFile, 'utf8')), false)
      assert.equal(JSON.parse(fs.readFileSync(leadersFile, 'utf8')).beta, replacementLeaderId)
      assert.equal(JSON.parse(fs.readFileSync(leadersFile, 'utf8')).pending, pendingLeaderId)
      const assignmentsAfterDelete = JSON.parse(fs.readFileSync(assignmentsFile, 'utf8'))
      assert.equal(assignmentsAfterDelete[replacementLeaderId], 'beta')
      assert.equal(assignmentsAfterDelete[pendingLeaderId], 'pending')
      assert.deepEqual(JSON.parse(fs.readFileSync(residentsFile, 'utf8')), {
        beta: { reviewer: { sessionId: replacementResidentId } },
      })
      assert.deepEqual(JSON.parse(fs.readFileSync(pulsesFile, 'utf8')), {
        beta: pulse(replacementPulseId),
      })
      assert.equal(deletedId in JSON.parse(fs.readFileSync(path.join(stateDir, 'session-meta.json'), 'utf8')), false)
      assert.equal(deletedId in JSON.parse(fs.readFileSync(receiptsFile, 'utf8')), false)
      assert.equal('untouched' in JSON.parse(fs.readFileSync(receiptsFile, 'utf8')), true)
      const groups = (await (await fetch(`${base}/api/sidecar`)).json()).groups
      assert.equal(groups.some(group => group.members.some(member => member.sessionId === deletedId)), false)
      assert.ok(groups.find(group => group.id === 'manual-group').members
        .some(member => member.sessionId === replacementResidentId))

      const recreated = await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: deletedId,
          cwd: path.join(home, 'rooms/alpha'),
          agent: 'omp',
          roomRole: 'leader',
          roomName: 'alpha',
        }),
      })
      assert.equal(recreated.status, 200, JSON.stringify(await recreated.clone().json()))
      assert.equal(JSON.parse(fs.readFileSync(leadersFile, 'utf8')).alpha, deletedId)
      assert.equal(fs.existsSync(path.join(ompRoot, deletedId)), true)
    } finally {
      child.kill('SIGTERM')
      if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve))
    }
  })
})
