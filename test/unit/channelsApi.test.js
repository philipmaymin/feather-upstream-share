import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { randomUUID } from 'crypto'

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

async function startServer() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-channels-api-'))
  roots.push(root)
  const home = path.join(root, 'home')
  const state = path.join(root, 'state')
  fs.mkdirSync(home)
  fs.mkdirSync(state)
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
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  servers.push(child)
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return { root, home, base, stderr: () => stderr }
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
