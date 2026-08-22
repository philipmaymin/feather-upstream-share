import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, spawnSync } from 'child_process'

import { JsonStateError, createJsonState } from '../../lib/json-state.js'

const roots = []

function fixture(prefix = 'feather-json-state-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  roots.push(root)
  return { root, file: path.join(root, 'state.json') }
}

function objectStore(file, root, options = {}) {
  return createJsonState({
    file,
    root,
    document: 'test state',
    defaultValue: {},
    validate: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
    ...options,
  })
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true })
})

describe('JSON state defaults and validation', () => {
  it('returns a fresh documented default only when the file is missing', () => {
    const { root, file } = fixture()
    const store = objectStore(file, root)

    const first = store.read()
    first.changed = true
    assert.deepEqual(store.read(), {})
    assert.equal(fs.existsSync(file), false)
  })

  it('fails closed on malformed existing JSON and never overwrites it', () => {
    const { root, file } = fixture()
    fs.writeFileSync(file, '{broken')
    const store = objectStore(file, root)

    assert.throws(() => store.read(), (error) => error instanceof JsonStateError && /malformed/.test(error.message))
    assert.throws(() => store.write({ replacement: true }), /malformed/)
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken')
  })

  it('rejects a complete JSON value with the wrong document shape', () => {
    const { root, file } = fixture()
    const store = objectStore(file, root)
    assert.throws(() => store.write([]), /invalid test state/)
    assert.equal(fs.existsSync(file), false)
  })
})

describe('atomic replacement and recovery', () => {
  it('retries an interrupted first write and never acknowledges state without a recovery copy', () => {
    const { root, file } = fixture()
    let interruptBackup = true
    const store = objectStore(file, root, {
      faultInjector(stage, { kind }) {
        if (interruptBackup && stage === 'after-rename' && kind === 'backup') {
          interruptBackup = false
          throw new Error('injected first-write backup failure')
        }
      },
    })

    assert.throws(() => store.write({ installed: true }), /injected first-write backup failure/)
    assert.equal(fs.existsSync(file), false)
    assert.equal(fs.existsSync(`${file}.last-good`), false)

    store.write({ installed: true })
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { installed: true })
    assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.last-good`, 'utf8')), { installed: true })

    fs.writeFileSync(file, '{corrupt')
    assert.deepEqual(store.recover(), { installed: true })
  })

  it('repairs a missing recovery copy before skipping an identical write', () => {
    const { root, file } = fixture()
    fs.writeFileSync(file, JSON.stringify({ installed: true }, null, 2))
    const store = objectStore(file, root)

    store.write({ installed: true })

    assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.last-good`, 'utf8')), { installed: true })
  })

  it('fsyncs a same-directory temp, atomically replaces, preserves mode, and keeps the prior value', () => {
    const { root, file } = fixture()
    fs.writeFileSync(file, '{"old":true}\n', { mode: 0o640 })
    const stages = []
    const store = objectStore(file, root, {
      faultInjector: (stage, context) => stages.push({ stage, ...context }),
    })

    store.write({ next: true })

    assert.deepEqual(store.read(), { next: true })
    assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.last-good`, 'utf8')), { old: true })
    assert.equal(fs.statSync(file).mode & 0o777, 0o640)
    assert.equal(fs.statSync(`${file}.last-good`).mode & 0o777, 0o640)
    const tempStages = stages.filter(({ stage }) => stage === 'after-temp-fsync')
    assert.ok(tempStages.length >= 2)
    assert.ok(tempStages.every(({ tempFile }) => path.dirname(tempFile) === root))
    assert.ok(stages.some(({ stage }) => stage === 'after-directory-fsync'))
  })

  it('applies an explicit secret mode to the document and recovery copy', () => {
    const { root, file } = fixture()
    fs.writeFileSync(file, '{"token":"old"}', { mode: 0o644 })
    const store = objectStore(file, root, { mode: 0o600 })

    store.write({ token: 'new' })

    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.equal(fs.statSync(`${file}.last-good`).mode & 0o777, 0o600)
  })

  it('leaves the prior document readable when failure occurs before replacement', () => {
    const { root, file } = fixture()
    fs.writeFileSync(file, '{"old":true}')
    const store = objectStore(file, root, {
      faultInjector(stage, { kind }) {
        if (stage === 'after-temp-fsync' && kind === 'target') throw new Error('injected pre-rename failure')
      },
    })

    assert.throws(() => store.write({ next: true }), /injected pre-rename failure/)
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { old: true })
    assert.equal(fs.readdirSync(root).some((name) => name.includes('.json-state-')), false)
  })

  it('leaves a complete new document and recoverable prior value on failure after replacement', () => {
    const { root, file } = fixture()
    fs.writeFileSync(file, '{"old":true}')
    const store = objectStore(file, root, {
      faultInjector(stage, { kind }) {
        if (stage === 'after-rename' && kind === 'target') throw new Error('injected post-rename failure')
      },
    })

    assert.throws(() => store.write({ next: true }), /injected post-rename failure/)
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { next: true })
    assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.last-good`, 'utf8')), { old: true })
  })

  it('restores last-known-good state only through an explicit recovery operation', () => {
    const { root, file } = fixture()
    fs.writeFileSync(file, '{"old":true}')
    const store = objectStore(file, root)
    store.write({ next: true })
    fs.writeFileSync(file, '{corrupt')

    assert.throws(() => store.read(), /malformed/)
    assert.deepEqual(store.recover(), { old: true })
    assert.deepEqual(store.read(), { old: true })
  })
})

describe('path and in-process mutation safety', () => {
  it('updates a symlink target inside the recorded root without replacing the link', () => {
    const { root } = fixture()
    const target = path.join(root, 'actual.json')
    const link = path.join(root, 'legacy.json')
    fs.writeFileSync(target, '{"old":true}', { mode: 0o600 })
    fs.symlinkSync(target, link)
    const store = objectStore(link, root)

    store.update((state) => ({ ...state, next: true }))

    assert.ok(fs.lstatSync(link).isSymbolicLink())
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { old: true, next: true })
    assert.equal(fs.statSync(target).mode & 0o777, 0o600)
  })

  it('rejects a symlink target outside the recorded root', () => {
    const { root } = fixture()
    const outside = fixture('feather-json-outside-')
    fs.writeFileSync(outside.file, '{}')
    const link = path.join(root, 'escape.json')
    fs.symlinkSync(outside.file, link)

    assert.throws(() => objectStore(link, root).read(), /outside recorded state root/)
  })

  it('serializes updates and rejects a reentrant mutation of the same document', () => {
    const { root, file } = fixture()
    const store = objectStore(file, root)
    store.write({ count: 0, futureField: { keep: true } })

    assert.throws(() => store.update((state) => {
      store.update((nested) => nested)
      return state
    }), /mutation already in progress/)

    store.update((state) => ({ ...state, count: state.count + 1 }))
    assert.deepEqual(store.read(), { count: 1, futureField: { keep: true } })
  })

  it('skips writes for reference-identical and serialized-identical updates', () => {
    const { root, file } = fixture()
    let writes = 0
    const store = objectStore(file, root, {
      faultInjector(stage) { if (stage === 'after-rename') writes++ },
    })
    store.write({ count: 1 })
    writes = 0

    store.update((state) => state)
    store.update((state) => ({ ...state }))

    assert.equal(writes, 0)
    assert.deepEqual(store.read(), { count: 1 })
  })
})

describe('server and rollback integration', () => {
  it('keeps compatible document shapes across representative API mutations', async () => {
    const { root } = fixture('feather-json-api-')
    const stateDir = path.join(root, 'state')
    const homeDir = path.join(root, 'home')
    const roomDir = path.join(homeDir, 'rooms/marriage')
    fs.mkdirSync(stateDir)
    fs.mkdirSync(roomDir, { recursive: true })
    fs.mkdirSync(path.join(homeDir, '.feather'), { recursive: true })
    fs.writeFileSync(path.join(roomDir, 'AGENTS.md'), '# marriage')
    fs.writeFileSync(path.join(stateDir, 'session-meta.json'), JSON.stringify({
      session1: { agent: 'claude', futureSessionField: { keep: true } },
      futureDocumentField: { keep: true },
    }))
    fs.writeFileSync(path.join(stateDir, 'quick-links.json'), '[]')
    fs.writeFileSync(path.join(stateDir, 'starred.json'), '{}')
    fs.writeFileSync(path.join(homeDir, '.feather/room-sessions.json'), JSON.stringify({ existing: 'marriage' }))

    const port = 20_000 + (process.pid % 20_000)
    const child = spawn(process.execPath, ['server-single.js'], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env: { ...process.env, HOME: homeDir, FEATHER_STATE_DIR: stateDir, PORT: String(port) },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    try {
      let ready = false
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/health`)
          if (response.ok) { ready = true; break }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      assert.equal(ready, true, stderr || 'server did not become ready')

      const post = (url, body) => fetch(`http://127.0.0.1:${port}${url}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      assert.equal((await post('/api/sessions/session1/rename', { title: 'renamed' })).status, 200)
      assert.equal((await post('/api/quick-links', [{ label: 'Docs', url: '/docs', futureLinkField: 3 }])).status, 200)
      assert.equal((await post('/api/starred', { entries: [], futureDocumentField: { keep: true } })).status, 200)
      assert.equal((await post('/api/rooms/marriage/assign', { sessionId: 'session2' })).status, 200)

      const meta = JSON.parse(fs.readFileSync(path.join(stateDir, 'session-meta.json'), 'utf8'))
      assert.deepEqual(meta.futureDocumentField, { keep: true })
      assert.deepEqual(meta.session1.futureSessionField, { keep: true })
      assert.equal(meta.session1.title, 'renamed')
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, 'quick-links.json'), 'utf8')), [
        { label: 'Docs', url: '/docs', futureLinkField: 3 },
      ])
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, 'starred.json'), 'utf8')).futureDocumentField, { keep: true })
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(homeDir, '.feather/room-sessions.json'), 'utf8')), {
        existing: 'marriage', session2: 'marriage',
      })
    } finally {
      child.kill('SIGTERM')
      if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve))
    }
  })

  it('blocks server startup when any durable JSON document is malformed', () => {
    const { root } = fixture('feather-json-server-')
    const stateDir = path.join(root, 'state')
    const homeDir = path.join(root, 'home')
    fs.mkdirSync(stateDir)
    fs.mkdirSync(homeDir)
    const linksFile = path.join(stateDir, 'quick-links.json')
    fs.writeFileSync(linksFile, '{broken')

    const result = spawnSync(process.execPath, ['server-single.js'], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env: { ...process.env, HOME: homeDir, FEATHER_STATE_DIR: stateDir },
      encoding: 'utf8',
      timeout: 10_000,
    })

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /malformed quick links/)
    assert.equal(fs.readFileSync(linksFile, 'utf8'), '{broken')
  })

  it('rehearses the pre-atomic release against an unchanged v0 state shape', async (t) => {
    const { root } = fixture('feather-json-rollback-')
    const repo = path.resolve(import.meta.dirname, '../..')
    const release = path.join(root, 'old-release')
    const homeDir = path.join(root, 'home')
    fs.mkdirSync(release)
    fs.mkdirSync(homeDir)

    const archive = spawnSync('git', ['archive', '--format=tar', '2bc8628'], {
      cwd: repo,
      maxBuffer: 20 * 1024 * 1024,
    })
    if (archive.status !== 0) {
      t.skip('pre-atomic rollback ref is unavailable in this checkout')
      return
    }
    const extract = spawnSync('tar', ['-xf', '-', '-C', release], { input: archive.stdout })
    assert.equal(extract.status, 0, extract.stderr?.toString())
    fs.symlinkSync(path.join(repo, 'node_modules'), path.join(release, 'node_modules'), 'dir')

    const stateDir = path.join(root, 'state')
    const projectDir = path.join(homeDir, '.claude/projects/test-project')
    fs.mkdirSync(stateDir)
    fs.mkdirSync(projectDir, { recursive: true })
    const labelsFile = path.join(stateDir, 'project-labels.json')
    fs.writeFileSync(labelsFile, JSON.stringify({ futureDocumentField: { keep: true } }))
    const port = 25_000 + (process.pid % 20_000)
    const child = spawn(process.execPath, ['server-single.js'], {
      cwd: release,
      env: { ...process.env, HOME: homeDir, FEATHER_STATE_DIR: stateDir, PORT: String(port) },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    try {
      let ready = false
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/health`)
          if (response.ok) { ready = true; break }
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      assert.equal(ready, true, stderr || 'pre-atomic server did not become ready')
      const response = await fetch(`http://127.0.0.1:${port}/api/projects/test-project/label`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'Rollback' }),
      })
      assert.equal(response.status, 200)
      const mutated = JSON.parse(fs.readFileSync(labelsFile, 'utf8'))
      assert.deepEqual(mutated.futureDocumentField, { keep: true })
      assert.equal(mutated['test-project'], 'Rollback')
    } finally {
      child.kill('SIGTERM')
      if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve))
    }
  }, { timeout: 10_000 })
})
