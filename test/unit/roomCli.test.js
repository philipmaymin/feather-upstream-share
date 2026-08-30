import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'

const run = promisify(execFile)

const runWithInput = (file, args, options, input) => new Promise((resolve, reject) => {
  const child = execFile(file, args, options, (error, stdout, stderr) => {
    if (error) {
      error.stdout = stdout
      error.stderr = stderr
      reject(error)
    } else {
      resolve({ stdout, stderr })
    }
  })
  child.stdin.end(input)
})
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
      // Each complaint also fires a detached, best-effort `room wake` for
      // #friction so a paused queue resumes; those POSTs land asynchronously.
      for (let i = 0; i < 200 && requests.filter((r) => r.url === '/api/rooms/friction/pulse').length < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      const notes = fs.readFileSync(path.join(roomsDir, 'friction/notes.md'), 'utf8')
      assert.match(notes, /Complaint from #health: The upload button loses my file/)
      assert.match(notes, /Complaint from #health: The table gets crushed on mobile/)
      // Explicit pause then wake on #health are ordered and exact.
      assert.deepEqual(requests.filter((r) => r.url === '/api/rooms/health/pulse'), [
        { url: '/api/rooms/health/pulse', body: { enabled: false } },
        { url: '/api/rooms/health/pulse', body: { enabled: true } },
      ])
      // Both complaints woke #friction.
      const frictionWakes = requests.filter((r) => r.url === '/api/rooms/friction/pulse')
      assert.equal(frictionWakes.length, 2)
      assert.ok(frictionWakes.every((r) => r.body.enabled === true))
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('deduplicates native-tool complaints by tool-call id', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-room-complaint-id-'))
    roots.push(root)
    const roomsDir = path.join(root, 'rooms')
    const roomDir = path.join(roomsDir, 'health')
    fs.mkdirSync(roomDir, { recursive: true })
    fs.writeFileSync(path.join(roomDir, 'AGENTS.md'), '# Room: #health\n')
    fs.writeFileSync(path.join(roomDir, 'notes.md'), '# notes\n')
    const env = {
      ...process.env, HOME: root, ROOMS_DIR: roomsDir,
      // Detached wake is best-effort; point it at a closed local port so this
      // unit test never touches the live Feather server.
      FEATHER_URL: 'http://127.0.0.1:1',
    }
    const cli = path.resolve(import.meta.dirname, '../../bin/room')

    const first = await run(cli, ['complain', '--id', 'tool-call-123', 'Repeated browser failure'], { cwd: roomDir, env })
    const retry = await run(cli, ['complain', '--id', 'tool-call-123', 'Repeated browser failure'], { cwd: roomDir, env })
    assert.match(first.stdout, /flagged in #friction/)
    assert.match(retry.stdout, /already flagged in #friction/)
    let notes = fs.readFileSync(path.join(roomsDir, 'friction/notes.md'), 'utf8')
    assert.equal(notes.split('[id:tool-call-123]').length - 1, 1)

    const frictionDir = path.join(roomsDir, 'friction')
    const self = await run(cli, ['complain', '--id', 'self-tool-123', 'Triage loop failure'], { cwd: frictionDir, env })
    const selfRetry = await run(cli, ['complain', '--id', 'self-tool-123', 'Triage loop failure'], { cwd: frictionDir, env })
    assert.match(self.stdout, /wake skipped/)
    assert.match(selfRetry.stdout, /already flagged.*wake skipped/)
    notes = fs.readFileSync(path.join(frictionDir, 'notes.md'), 'utf8')
    assert.equal(notes.split('[id:self-tool-123]').length - 1, 1)

    const outsideDir = path.join(root, 'plain-project')
    fs.mkdirSync(outsideDir)
    await run(cli, ['complain', '--id', 'outside-tool-123', '--source', 'plain-project', 'Outside Room failure'], { cwd: outsideDir, env })
    notes = fs.readFileSync(path.join(frictionDir, 'notes.md'), 'utf8')
    assert.match(notes, /Complaint from #plain-project: Outside Room failure/)

    const notesPath = path.join(frictionDir, 'notes.md')
    fs.chmodSync(notesPath, 0o444)
    try {
      await assert.rejects(
        run(cli, ['complain', '--id', 'unwritable-tool-123', 'Must not acknowledge'], { cwd: roomDir, env }),
        /could not record complaint/,
      )
    } finally {
      fs.chmodSync(notesPath, 0o644)
    }

    await assert.rejects(
      run(cli, ['complain', '--id', 'bad id', 'Nope'], { cwd: roomDir, env }),
      /invalid complaint id/,
    )
    await assert.rejects(
      run(cli, ['complain', '--source', 'bad source', 'Nope'], { cwd: outsideDir, env }),
      /invalid complaint source/,
    )
  })

  it('preserves literal note and update text from stdin or a file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-room-literal-input-'))
    roots.push(root)
    const roomsDir = path.join(root, 'rooms')
    const roomDir = path.join(roomsDir, 'space')
    fs.mkdirSync(roomDir, { recursive: true })
    fs.writeFileSync(path.join(roomDir, 'AGENTS.md'), '# Room: #space\n')
    fs.writeFileSync(path.join(roomDir, 'notes.md'), '# notes\n')
    const env = { ...process.env, HOME: root, ROOMS_DIR: roomsDir }
    const cli = path.resolve(import.meta.dirname, '../../bin/room')
    const literal = 'Feel the Heat $250; `Gateway` $69\nkeep $(date) literal\n'

    await runWithInput(cli, ['note', '--stdin'], { cwd: roomDir, env }, literal)
    const notesPath = path.join(roomDir, 'notes.md')
    assert.match(fs.readFileSync(notesPath, 'utf8'), new RegExp(
      literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    ))

    const textFile = path.join(root, 'briefing.txt')
    fs.writeFileSync(textFile, literal)
    await run(cli, ['update', '--file', textFile], { cwd: roomDir, env })
    const updatesPath = path.join(roomDir, 'updates.jsonl')
    const updates = fs.readFileSync(updatesPath, 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(updates[0].text, literal)

    await run(cli, ['note', '--', '--stdin'], { cwd: roomDir, env })
    assert.match(fs.readFileSync(notesPath, 'utf8'), /--stdin/)
    const notesBeforeRejectedInput = fs.readFileSync(notesPath, 'utf8')
    const updatesBeforeRejectedInput = fs.readFileSync(updatesPath, 'utf8')
    await assert.rejects(
      run(cli, ['note', '--stdin', 'ambiguous'], { cwd: roomDir, env }),
      /cannot combine|usage/,
    )
    await assert.rejects(
      run(cli, ['update', '--file', textFile, 'ambiguous'], { cwd: roomDir, env }),
      /no positional text/,
    )
    await assert.rejects(
      run(cli, ['note', 'split', 'text'], { cwd: roomDir, env }),
      /usage/,
    )
    assert.equal(fs.readFileSync(notesPath, 'utf8'), notesBeforeRejectedInput)
    assert.equal(fs.readFileSync(updatesPath, 'utf8'), updatesBeforeRejectedInput)
  })
})
