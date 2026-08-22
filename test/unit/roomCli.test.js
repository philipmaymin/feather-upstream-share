import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'

const run = promisify(execFile)
const roots = []

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true })
})

describe('room assignment CLI', () => {
  it('attaches and detaches through the Room API with a non-default Rooms root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-room-cli-'))
    roots.push(root)
    const roomsDir = path.join(root, 'workspaces')
    const roomDir = path.join(roomsDir, 'marriage')
    fs.mkdirSync(roomDir, { recursive: true })
    const requests = []
    const server = http.createServer((request, response) => {
      const chunks = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => {
        requests.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks).toString()) })
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end('{"ok":true}')
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    const env = {
      ...process.env,
      HOME: root,
      ROOMS_DIR: roomsDir,
      FEATHER_URL: `http://127.0.0.1:${port}`,
    }
    const cli = path.resolve(import.meta.dirname, '../../bin/room')

    try {
      const attached = await run(cli, ['attach', 'historical-session'], { cwd: roomDir, env })
      const detached = await run(cli, ['detach', 'historical-session'], { cwd: roomDir, env })
      assert.match(attached.stdout, /attached session historical-session to #marriage/)
      assert.match(detached.stdout, /detached session historical-session from #marriage/)
      assert.deepEqual(requests, [
        { url: '/api/rooms/marriage/assign', body: { sessionId: 'historical-session', remove: false } },
        { url: '/api/rooms/marriage/assign', body: { sessionId: 'historical-session', remove: true } },
      ])
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('records complaints in #friction and lets a room pause or wake itself', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-room-feedback-'))
    roots.push(root)
    const roomsDir = path.join(root, 'rooms')
    const roomDir = path.join(roomsDir, 'health')
    fs.mkdirSync(roomDir, { recursive: true })
    fs.writeFileSync(path.join(roomDir, 'AGENTS.md'), '# Room: #health\n')
    fs.writeFileSync(path.join(roomDir, 'notes.md'), '# notes\n')
    const requests = []
    const server = http.createServer((request, response) => {
      const chunks = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => {
        requests.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks).toString()) })
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end('{"ok":true}')
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const env = { ...process.env, HOME: root, ROOMS_DIR: roomsDir, FEATHER_URL: `http://127.0.0.1:${server.address().port}` }
    const cli = path.resolve(import.meta.dirname, '../../bin/room')
    try {
      await Promise.all([
        run(cli, ['complain', 'The upload button loses my file'], { cwd: roomDir, env }),
        run(cli, ['complain', 'The table gets crushed on mobile'], { cwd: roomDir, env }),
      ])
      await run(cli, ['pause'], { cwd: roomDir, env })
      await run(cli, ['wake'], { cwd: roomDir, env })
      for (let attempt = 0; attempt < 200 && requests.filter(request => request.url === '/api/rooms/friction/pulse').length < 2; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      const notes = fs.readFileSync(path.join(roomsDir, 'friction/notes.md'), 'utf8')
      assert.match(notes, /Complaint from #health: The upload button loses my file/)
      assert.match(notes, /Complaint from #health: The table gets crushed on mobile/)
      assert.deepEqual(requests.filter(request => request.url === '/api/rooms/health/pulse'), [
        { url: '/api/rooms/health/pulse', body: { enabled: false } },
        { url: '/api/rooms/health/pulse', body: { enabled: true } },
      ])
      const frictionWakes = requests.filter(request => request.url === '/api/rooms/friction/pulse')
      assert.equal(frictionWakes.length, 2)
      assert.ok(frictionWakes.every(request => request.body.enabled === true))
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
