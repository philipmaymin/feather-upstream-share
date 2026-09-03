import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { ChannelStore } from '../../lib/channels.js'

const roots = []
const servers = []

afterEach(async () => {
  while (servers.length) {
    const child = servers.pop()
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
  }
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true })
})

async function startServer({ failTmuxSpawn = false, sharedRoot = null } = {}) {
  const root = sharedRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'feather-channels-api-'))
  if (!sharedRoot) {
    roots.push(root)
    const home = path.join(root, 'home')
    const state = path.join(root, 'state')
    const bin = path.join(root, 'bin')
    fs.mkdirSync(home)
    fs.mkdirSync(state)
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh
[ "$1" = "has-session" ] && exit 1
${failTmuxSpawn ? '[ "$1" = "new-session" ] && exit 1' : ''}
exit 0
`)
    fs.chmodSync(path.join(bin, 'tmux'), 0o755)
  }
  const home = path.join(root, 'home')
  const state = path.join(root, 'state')
  const bin = path.join(root, 'bin')
  const port = 47_000 + Math.floor(Math.random() * 1_000)
  const base = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, ['server-single.js'], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: {
      ...process.env,
      HOME: home,
      FEATHER_STATE_DIR: state,
      FEATHER_CHANNEL_RUNTIME: '0',
      FEATHER_PUSH_POLL: '0',
      FEATHER_ROOM_PULSES: '0',
      PORT: String(port),
      PATH: `${bin}:${process.env.PATH}`,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  servers.push(child)
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return { root, home, base, port, child, stderr: () => stderr }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error(`server did not start: ${stderr}`)
}

function headers(username = 'philip') {
  return {
    Host: 'app.feather.plus',
    'X-Feather-Surface': 'shared',
    'Remote-User': username,
    'Content-Type': 'application/json',
  }
}

async function body(response) {
  return response.json().catch(() => ({}))
}

describe('shared channels API', () => {
  it('bootstraps Films 7 without a legacy Room and exposes no agent session ids', async () => {
    const { base, home, stderr } = await startServer()
    const response = await fetch(`${base}/api/channels/bootstrap-films7`, {
      method: 'POST',
      headers: headers(),
    })
    assert.equal(response.status, 200, stderr())
    const payload = await body(response)
    assert.equal(payload.channel.slug, 'films7')
    assert.deepEqual(payload.channel.members.filter(member => member.kind === 'agent').map(member => member.username), ['caretaker', 'coordinator'])
    assert.ok(payload.channel.members.every(member => !('sessionId' in member)))
    assert.equal(fs.existsSync(path.join(home, 'rooms', 'films7')), false)
    assert.equal(fs.statSync(path.join(home, '.feather', 'channels-v1.sqlite3')).mode & 0o777, 0o600)

    const messages = await body(await fetch(`${base}/api/channels/${payload.channel.id}/messages`, { headers: headers() }))
    assert.equal(messages.messages.length, 1)
    assert.equal(messages.messages[0].messageType, 'system')
    assert.equal(messages.messages[0].metadata.access, 'read-only')
  })

  it('creates channels with a stable Coordinator and Caretaker', async () => {
    const { base, stderr } = await startServer()
    const requestHeaders = { ...headers(), 'Idempotency-Key': 'api:create:fairfield' }
    const firstResponse = await fetch(`${base}/api/channels`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({ slug: 'fairfield', title: 'Fairfield' }),
    })
    assert.equal(firstResponse.status, 201, stderr())
    const first = await body(firstResponse)
    assert.equal(first.staffing.status, 'ready')
    assert.deepEqual(first.staffing.agents.map(agent => agent.username).sort(), ['fairfield-caretaker', 'fairfield-coordinator'])
    assert.deepEqual(first.channel.members.filter(member => member.kind === 'agent').map(member => member.displayName).sort(), ['Caretaker', 'Coordinator'])
    const coordinator = first.channel.members.find(member => member.displayName === 'Coordinator')
    assert.equal(first.channel.defaultAgentId, coordinator.id)
    assert.ok(first.channel.members.every(member => !('sessionId' in member)))
    assert.ok(first.staffing.agents.every(agent => !('sessionId' in agent)))

    const replayResponse = await fetch(`${base}/api/channels`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({ slug: 'fairfield', title: 'Fairfield' }),
    })
    assert.equal(replayResponse.status, 201, stderr())
    const replay = await body(replayResponse)
    assert.equal(replay.channel.id, first.channel.id)
    assert.deepEqual(replay.channel.members.map(member => member.id).sort(), first.channel.members.map(member => member.id).sort())
  })

  it('exposes a membership-scoped read-only peek without leaking agent session ids', async () => {
    const { base, home } = await startServer()
    const created = await body(await fetch(`${base}/api/channels`, {
      method: 'POST',
      headers: { ...headers(), 'Idempotency-Key': 'api:create:peek' },
      body: JSON.stringify({ slug: 'peek-room', title: 'Peek Room' }),
    }))
    const store = new ChannelStore({ file: path.join(home, '.feather', 'channels-v1.sqlite3') })
    try {
      const owner = store.ensureHuman({ username: 'philip', displayName: 'Philip' })
      store.postMessage({
        channelId: created.channel.id,
        authorId: owner.id,
        content: 'Start work that I can inspect.',
        messageType: 'human',
        idempotencyKey: 'client:peek:start',
      })
      const dispatch = store.claimDispatch()
      assert.ok(dispatch)

      const response = await fetch(`${base}/api/channels/executions/${dispatch.executionId}/peek`, { headers: headers() })
      assert.equal(response.status, 200)
      const peek = await body(response)
      assert.equal(peek.execution.id, dispatch.executionId)
      assert.equal(peek.execution.state, 'running')
      assert.match(peek.activity, /Starting/)
      assert.equal(JSON.stringify(peek).includes(dispatch.agent.sessionId), false)
      assert.equal((await fetch(`${base}/api/channels/executions/${dispatch.executionId}/peek`, { headers: headers('maya') })).status, 403)
    } finally {
      store.close()
    }
  })

  it('notifies one server when another process changes the shared channel database', async () => {
    const first = await startServer()
    const second = await startServer({ sharedRoot: first.root })
    assert.notEqual(first.port, second.port)
    assert.equal(first.child.exitCode, null, `first server exited: ${first.stderr()}`)
    const controller = new AbortController()
    const stream = await fetch(`${first.base}/api/channels/stream`, { headers: headers(), signal: controller.signal })
    assert.equal(stream.status, 200)
    const reader = stream.body.getReader()
    const decoder = new TextDecoder()
    const connected = await reader.read()
    assert.match(decoder.decode(connected.value), /event: connected/)

    const created = await fetch(`${second.base}/api/channels`, {
      method: 'POST',
      headers: { ...headers(), 'Idempotency-Key': 'api:cross-process-channel' },
      body: JSON.stringify({ slug: 'cross-process', title: 'Cross Process' }),
    })
    assert.equal(created.status, 201, second.stderr())

    let events = ''
    let timeout
    const failed = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('cross-process channel change was not delivered')), 4_000)
    })
    try {
      await Promise.race([
        (async () => {
          while (!events.includes('event: channel')) {
            const chunk = await reader.read()
            if (chunk.done) throw new Error('channel stream ended before durable change notification')
            events += decoder.decode(chunk.value, { stream: true })
          }
        })(),
        failed,
      ])
    } finally {
      clearTimeout(timeout)
    }
    assert.match(events, /"channelId":null/)
    controller.abort()
  })

  it('creates Rooms with an assigned OMP Leader and Caretaker', async () => {
    const { base, stderr } = await startServer()
    const response = await fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ name: 'staffed-room' }),
    })
    assert.equal(response.status, 201, stderr())
    const created = await body(response)
    assert.equal(created.staffing.status, 'ready')
    assert.deepEqual(created.staffing.agents.map(agent => agent.role), ['leader', 'caretaker'])
    assert.ok(created.staffing.agents.every(agent => agent.agent === 'omp'))
    assert.equal(new Set(created.staffing.agents.map(agent => agent.sessionId)).size, 2)

    const listed = await body(await fetch(`${base}/api/rooms`, { headers: headers() }))
    const room = listed.rooms.find(candidate => candidate.name === 'staffed-room')
    assert.equal(room.leaderSessionId, created.staffing.agents[0].sessionId)
    const caretakerResident = room.residents.find(resident => resident.role === 'caretaker')
    assert.ok(caretakerResident)
    assert.equal(caretakerResident.sessionId, created.staffing.agents[1].sessionId)
  })

  it('keeps a new Room visible but rolls back agent registries when staffing fails', async () => {
    const { base, stderr } = await startServer({ failTmuxSpawn: true })
    const response = await fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ name: 'partial-room' }),
    })
    assert.equal(response.status, 201, stderr())
    const created = await body(response)
    assert.equal(created.staffing.status, 'failed')
    assert.match(created.staffing.error, /tmux/)
    assert.deepEqual(created.staffing.agents, [])

    const listed = await body(await fetch(`${base}/api/rooms`, { headers: headers() }))
    const room = listed.rooms.find(candidate => candidate.name === 'partial-room')
    assert.ok(room)
    assert.equal(room.leaderSessionId, null)
    assert.deepEqual(room.residents, [])
  })

  it('keeps shared membership and Activity isolated from personal Feather APIs', async () => {
    const { base, stderr } = await startServer()
    const boot = await body(await fetch(`${base}/api/channels/bootstrap-films7`, { method: 'POST', headers: headers() }))
    const channelId = boot.channel.id

    const invited = await fetch(`${base}/api/channels/${channelId}/members`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ username: 'maya' }),
    })
    assert.equal(invited.status, 201, stderr())

    const mayaChannels = await body(await fetch(`${base}/api/channels`, { headers: headers('maya') }))
    assert.equal(mayaChannels.channels[0].slug, 'films7')
    assert.equal((await fetch(`${base}/api/sessions`, { headers: headers('maya') })).status, 403)
    assert.equal((await fetch(`${base}/api/rooms`, { headers: headers('maya') })).status, 403)

    const posted = await fetch(`${base}/api/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { ...headers(), 'Idempotency-Key': 'api:mention-maya' },
      body: JSON.stringify({ content: '@maya The first cut is ready for your review.' }),
    })
    assert.equal(posted.status, 201, stderr())
    const activity = await body(await fetch(`${base}/api/channels/activity`, { headers: headers('maya') }))
    assert.equal(activity.unread, 1)
    assert.equal(activity.items[0].kind, 'mention')
    assert.match(activity.items[0].reason, /Philip mentioned you/)
    assert.equal(activity.items[0].actor.kind, 'human')
  })

  it('creates a conventional private conversation only with a shared principal', async () => {
    const { base, stderr } = await startServer()
    const boot = await body(await fetch(`${base}/api/channels/bootstrap-films7`, { method: 'POST', headers: headers() }))
    const caretaker = boot.channel.members.find(member => member.username === 'caretaker')
    const dmResponse = await fetch(`${base}/api/channels/dms`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ principalId: caretaker.id }),
    })
    assert.equal(dmResponse.status, 201, stderr())
    const dm = (await body(dmResponse)).channel
    assert.equal(dm.type, 'dm')
    assert.equal(dm.defaultAgentId, caretaker.id)

    const forbidden = await fetch(`${base}/api/channels/dms`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ principalId: 'human:not-a-member' }),
    })
    assert.equal(forbidden.status, 403)
  })

  it('stores channel images behind membership-scoped URLs', async () => {
    const { base, stderr } = await startServer()
    const boot = await body(await fetch(`${base}/api/channels/bootstrap-films7`, { method: 'POST', headers: headers() }))
    const channelId = boot.channel.id
    const attachmentId = randomUUID()
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4])
    const uploaded = await fetch(`${base}/api/channels/${channelId}/attachments`, {
      method: 'POST',
      headers: {
        ...headers('maya'),
        'Content-Type': 'image/png',
        'X-Filename': encodeURIComponent('pasted frame.png'),
        'X-Upload-ID': attachmentId,
      },
      body: bytes,
    })
    assert.equal(uploaded.status, 201, stderr())
    const attachment = (await body(uploaded)).attachment
    assert.equal(attachment.id, attachmentId)
    assert.equal(attachment.filename, 'pasted frame.png')
    assert.equal(attachment.byteSize, bytes.length)
    assert.match(attachment.url, new RegExp(`/api/channels/${channelId}/attachments/${attachmentId}$`))

    const fetched = await fetch(`${base}${attachment.url}`, { headers: headers('maya') })
    assert.equal(fetched.status, 200)
    assert.equal(fetched.headers.get('content-type'), 'image/png')
    assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), bytes)
    assert.equal((await fetch(`${base}${attachment.url}`, { headers: headers('zoe') })).status, 403)

    const conflict = await fetch(`${base}/api/channels/${channelId}/attachments`, {
      method: 'POST',
      headers: {
        ...headers('maya'),
        'Content-Type': 'image/png',
        'X-Filename': encodeURIComponent('different.png'),
        'X-Upload-ID': attachmentId,
      },
      body: Buffer.from([9, 9, 9]),
    })
    assert.equal(conflict.status, 409)
    assert.equal((await fetch(`${base}/api/channels/${channelId}/attachments`, {
      method: 'POST',
      headers: { ...headers('maya'), 'Content-Type': 'image/svg+xml', 'X-Upload-ID': randomUUID() },
      body: '<svg/>',
    })).status, 415)
  })
})
