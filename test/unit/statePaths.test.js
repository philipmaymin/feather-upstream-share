import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'

import {
  createLegacyStateSymlinks,
  ensureOwnerOnlyFile,
  ensureStateLayout,
  resolveStatePaths,
} from '../../lib/state-paths.js'

const roots = []

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  roots.push(dir)
  return dir
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true })
})

describe('state path classification', () => {
  it('preserves legacy checkout-local paths while keeping feed feedback mutable', () => {
    const releaseDir = '/opt/feather/current'
    const homeDir = '/home/zak'
    const paths = resolveStatePaths({ releaseDir, homeDir })

    assert.equal(paths.instance.external, false)
    assert.equal(paths.instance.root, releaseDir)
    assert.equal(paths.instance.boxesFile, `${releaseDir}/boxes.json`)
    assert.equal(paths.instance.sharingFile, `${releaseDir}/sharing.json`)
    assert.equal(paths.instance.metaFile, `${releaseDir}/session-meta.json`)
    assert.equal(paths.instance.uploadsDir, `${releaseDir}/uploads`)
    assert.equal(paths.instance.projectLabelsFile, `${releaseDir}/project-labels.json`)
    assert.equal(paths.instance.feedInteractionsFile, `${homeDir}/.feather/feed-interactions.json`)
    assert.equal(paths.instance.quickLinksFile, `${releaseDir}/quick-links.json`)
    assert.equal(paths.instance.starredFile, `${releaseDir}/starred.json`)
  })

  it('moves only instance state under the configured root', () => {
    const paths = resolveStatePaths({
      releaseDir: '/opt/feather/releases/a',
      stateDir: '/srv/feather/state',
      homeDir: '/home/zak',
    })

    assert.equal(paths.instance.external, true)
    assert.equal(paths.instance.metaFile, '/srv/feather/state/session-meta.json')
    assert.equal(paths.instance.uploadsDir, '/srv/feather/state/uploads')
    assert.equal(paths.instance.feedInteractionsFile, '/srv/feather/state/feed-interactions.json')
    assert.equal(paths.release.staticDir, '/opt/feather/releases/a/static')
    assert.equal(paths.coordination.sidecarsDir, '/home/zak/.feather/sidecars')
    assert.equal(paths.coordination.roomAssignmentsFile, '/home/zak/.feather/room-sessions.json')
    assert.equal(paths.coordination.roomLeadersFile, '/home/zak/.feather/room-mains.json')
    assert.equal(paths.coordination.roomResidentsFile, '/home/zak/.feather/room-residents.json')
    assert.equal(paths.coordination.roomPulsesFile, '/home/zak/.feather/room-pulses.json')
    assert.equal(paths.coordination.channelsDbFile, '/home/zak/.feather/channels-v1.sqlite3')
    assert.equal(paths.coordination.channelUploadsDir, '/home/zak/.feather/channel-uploads')
    assert.equal(paths.harness.claudeProjectsDir, '/home/zak/.claude/projects')
    assert.equal(paths.harness.ompSessionsDir, '/home/zak/.feather/omp-sessions')
    assert.equal(paths.harness.codexSessionsDir, '/home/zak/.codex/sessions')
    assert.equal(paths.workspace.roomsDir, '/home/zak/rooms')
    assert.equal(paths.workspace.channelWorkspacesDir, '/home/zak/.feather/channel-workspaces')
    assert.deepEqual(paths.runtime, { managedExternally: ['process', 'tmux', 'temporary-files'] })
  })

  it('rejects a relative FEATHER_STATE_DIR', () => {
    assert.throws(
      () => resolveStatePaths({ releaseDir: '/opt/feather/current', stateDir: 'relative/state' }),
      /must be an absolute path/,
    )
  })
})

describe('state layout safety', () => {
  it('creates an external root and uploads directory without replacing existing nodes', () => {
    const base = tempDir('feather-state-')
    const releaseDir = path.join(base, 'release')
    const stateDir = path.join(base, 'state')
    fs.mkdirSync(releaseDir)
    const paths = resolveStatePaths({ releaseDir, stateDir, homeDir: base })

    ensureStateLayout(paths)
    assert.ok(fs.statSync(stateDir).isDirectory())
    assert.ok(fs.statSync(paths.instance.uploadsDir).isDirectory())
    assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700)

    const badRoot = path.join(base, 'not-a-directory')
    fs.writeFileSync(badRoot, 'keep me')
    assert.throws(
      () => ensureStateLayout(resolveStatePaths({ releaseDir, stateDir: badRoot, homeDir: base })),
      /not a directory/,
    )
    assert.equal(fs.readFileSync(badRoot, 'utf8'), 'keep me')

    const partialRoot = path.join(base, 'partial-state')
    fs.mkdirSync(partialRoot)
    fs.writeFileSync(path.join(partialRoot, 'uploads'), 'also keep me')
    assert.throws(
      () => ensureStateLayout(resolveStatePaths({ releaseDir, stateDir: partialRoot, homeDir: base })),
      /not a directory/,
    )
    assert.equal(fs.readFileSync(path.join(partialRoot, 'uploads'), 'utf8'), 'also keep me')
  })

  it('keeps a valid directory symlink rather than replacing it', () => {
    const base = tempDir('feather-state-link-')
    const target = path.join(base, 'target')
    const link = path.join(base, 'state')
    fs.mkdirSync(target)
    fs.symlinkSync(target, link, 'dir')
    const paths = resolveStatePaths({ releaseDir: path.join(base, 'release'), stateDir: link, homeDir: base })

    ensureStateLayout(paths)
    assert.ok(fs.lstatSync(link).isSymbolicLink())
    assert.ok(fs.statSync(path.join(target, 'uploads')).isDirectory())
  })

  it('enforces owner-only permissions for existing and newly written secret files', () => {
    const base = tempDir('feather-secret-')
    const secret = path.join(base, 'sharing.json')
    fs.writeFileSync(secret, '{}', { mode: 0o644 })

    ensureOwnerOnlyFile(secret)
    assert.equal(fs.statSync(secret).mode & 0o777, 0o600)
  })
})

describe('legacy compatibility symlinks', () => {
  it('creates links to external state and is idempotent', () => {
    const base = tempDir('feather-legacy-')
    const releaseDir = path.join(base, 'release')
    const stateDir = path.join(base, 'state')
    fs.mkdirSync(releaseDir)
    const paths = resolveStatePaths({ releaseDir, stateDir, homeDir: base })
    ensureStateLayout(paths)

    createLegacyStateSymlinks(paths)
    createLegacyStateSymlinks(paths)

    assert.ok(fs.lstatSync(path.join(releaseDir, 'sharing.json')).isSymbolicLink())
    assert.equal(
      path.resolve(releaseDir, fs.readlinkSync(path.join(releaseDir, 'sharing.json'))),
      paths.instance.sharingFile,
    )
    assert.ok(fs.statSync(path.join(releaseDir, 'uploads')).isDirectory())
  })

  it('refuses to replace a legacy file or a link to a different target', () => {
    const base = tempDir('feather-legacy-conflict-')
    const releaseDir = path.join(base, 'release')
    const stateDir = path.join(base, 'state')
    fs.mkdirSync(releaseDir)
    fs.writeFileSync(path.join(releaseDir, 'boxes.json'), '{"keep":true}')
    const paths = resolveStatePaths({ releaseDir, stateDir, homeDir: base })
    ensureStateLayout(paths)

    assert.throws(() => createLegacyStateSymlinks(paths), /refusing to replace/)
    assert.equal(fs.readFileSync(path.join(releaseDir, 'boxes.json'), 'utf8'), '{"keep":true}')

    fs.unlinkSync(path.join(releaseDir, 'boxes.json'))
    fs.symlinkSync(path.join(base, 'elsewhere.json'), path.join(releaseDir, 'boxes.json'))
    assert.throws(() => createLegacyStateSymlinks(paths), /different target/)
  })
})

describe('server state integration', () => {
  it('reads and writes instance state only in FEATHER_STATE_DIR', async () => {
    const base = tempDir('feather-server-state-')
    const stateDir = path.join(base, 'state')
    const homeDir = path.join(base, 'home')
    fs.mkdirSync(stateDir)
    fs.mkdirSync(homeDir)
    fs.writeFileSync(path.join(stateDir, 'quick-links.json'), JSON.stringify([{ label: 'existing', url: '/existing' }]))
    const port = 49_000 + Math.floor(Math.random() * 500)
    const child = spawn(process.execPath, ['server-single.js'], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env: { ...process.env, HOME: homeDir, FEATHER_STATE_DIR: stateDir, PORT: String(port) },
      stdio: 'ignore',
    })
    try {
      let healthy = false
      for (let attempt = 0; attempt < 40; attempt++) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/health`)
          if (response.ok) { healthy = true; break }
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      assert.equal(healthy, true, 'temporary server did not become healthy')
      const before = await (await fetch(`http://127.0.0.1:${port}/api/quick-links`)).json()
      assert.equal(before[0].label, 'existing', 'existing copied state must remain readable')
      const next = [{ label: 'updated', url: '/updated' }]
      const written = await fetch(`http://127.0.0.1:${port}/api/quick-links`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next),
      })
      assert.equal(written.status, 200)
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, 'quick-links.json'), 'utf8')), next)
      assert.ok(fs.statSync(path.join(stateDir, 'uploads')).isDirectory())
      assert.equal(fs.existsSync(path.join(homeDir, '.feather', 'quick-links.json')), false)
    } finally {
      child.kill('SIGTERM')
    }
  }, { timeout: 10_000 })

  it('rejects malformed feed interaction state during startup', async () => {
    const base = tempDir('feather-feed-state-')
    const stateDir = path.join(base, 'state')
    const homeDir = path.join(base, 'home')
    fs.mkdirSync(stateDir)
    fs.mkdirSync(homeDir)
    fs.writeFileSync(path.join(stateDir, 'feed-interactions.json'), JSON.stringify({ schema: 2, posts: {} }))
    const child = spawn(process.execPath, ['server-single.js'], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env: {
        ...process.env,
        HOME: homeDir,
        FEATHER_STATE_DIR: stateDir,
        PORT: String(49_500 + Math.floor(Math.random() * 400)),
      },
      stdio: 'ignore',
    })
    const exitCode = await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(() => resolve(null), 2_000)),
    ])
    if (exitCode === null) child.kill('SIGKILL')
    assert.notEqual(exitCode, null, 'server accepted malformed feed interaction state')
    assert.notEqual(exitCode, 0)
  })
})
