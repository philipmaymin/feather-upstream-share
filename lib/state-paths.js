import fs from 'fs'
import path from 'path'

const INSTANCE_NAMES = Object.freeze({
  boxesFile: 'boxes.json',
  sharingFile: 'sharing.json',
  metaFile: 'session-meta.json',
  uploadsDir: 'uploads',
  projectLabelsFile: 'project-labels.json',
  feedInteractionsFile: 'feed-interactions.json',
  quickLinksFile: 'quick-links.json',
  starredFile: 'starred.json',
  mutedFile: 'muted.json',
  pushKeysFile: 'push-keys.json',
  pushSubscriptionsFile: 'push-subscriptions.json',
})
const DEFAULT_RELEASE_DIR = path.resolve(import.meta.dirname, '..')

function resolvedRoot(value) {
  return path.resolve(value)
}

/**
 * Classify every persistent path Feather knows about. FEATHER_STATE_DIR only
 * owns per-instance metadata and uploads; agent harnesses, Rooms, sidecars,
 * logs, and process state deliberately remain outside it.
 */
export function resolveStatePaths({
  releaseDir = DEFAULT_RELEASE_DIR,
  stateDir = process.env.FEATHER_STATE_DIR,
  homeDir = process.env.HOME || '/home/user',
} = {}) {
  const releaseRoot = resolvedRoot(releaseDir)
  const configuredStateDir = typeof stateDir === 'string' && stateDir.trim() !== ''
  if (configuredStateDir && !path.isAbsolute(stateDir)) {
    throw new Error('FEATHER_STATE_DIR must be an absolute path')
  }
  const instanceRoot = configuredStateDir ? resolvedRoot(stateDir) : releaseRoot
  const featherHome = path.join(homeDir, '.feather')

  const instance = { root: instanceRoot, external: configuredStateDir }
  for (const [key, name] of Object.entries(INSTANCE_NAMES)) {
    instance[key] = path.join(instanceRoot, name)
  }
  if (!configuredStateDir) instance.feedInteractionsFile = path.join(featherHome, 'feed-interactions.json')

  return {
    release: {
      root: releaseRoot,
      staticDir: path.join(releaseRoot, 'static'),
      versionFile: path.join(releaseRoot, 'version.json'),
      bridgeExtension: path.join(releaseRoot, 'lib/feather-bridge.ts'),
    },
    instance,
    coordination: {
      shareAccessLog: path.join(featherHome, 'share-access.log'),
      roomAssignmentsFile: path.join(featherHome, 'room-sessions.json'),
      // Keep the legacy filename for rollback compatibility; the state now
      // designates each Room's Leader, not a generic "main" chat.
      roomLeadersFile: path.join(featherHome, 'room-mains.json'),
      roomResidentsFile: path.join(featherHome, 'room-residents.json'),
      roomPulsesFile: path.join(featherHome, 'room-pulses.json'),
      sidecarsDir: path.join(featherHome, 'sidecars'),
      channelsDbFile: path.join(featherHome, 'channels-v1.sqlite3'),
      channelUploadsDir: path.join(featherHome, 'channel-uploads'),
    },
    harness: {
      claudeProjectsDir: path.join(homeDir, '.claude/projects'),
      ompSessionsDir: path.join(featherHome, 'omp-sessions'),
      codexSessionsDir: path.join(homeDir, '.codex/sessions'),
    },
    workspace: {
      roomsDir: path.join(homeDir, 'rooms'),
      channelWorkspacesDir: path.join(featherHome, 'channel-workspaces'),
    },
    runtime: { managedExternally: ['process', 'tmux', 'temporary-files'] },
  }
}

function ensureDirectory(dir, { mode } = {}) {
  try {
    const entry = fs.lstatSync(dir)
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      throw new Error(`${dir} exists and is not a directory`)
    }
    if (!fs.statSync(dir).isDirectory()) {
      throw new Error(`${dir} exists and is not a directory`)
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    fs.mkdirSync(dir, { recursive: true, mode })
  }
  if (mode !== undefined) fs.chmodSync(dir, mode)
}

/** Create only missing directories. Existing files and broken links are errors. */
export function ensureStateLayout(paths) {
  const { instance } = paths
  ensureDirectory(instance.root, instance.external ? { mode: 0o700 } : undefined)
  ensureDirectory(instance.uploadsDir, instance.external ? { mode: 0o700 } : undefined)
  ensureOwnerOnlyFile(instance.boxesFile)
  ensureOwnerOnlyFile(instance.sharingFile)
  ensureOwnerOnlyFile(instance.pushKeysFile)
}

/** Tighten an existing secret file. Missing files are intentionally allowed. */
export function ensureOwnerOnlyFile(file) {
  try {
    if (!fs.statSync(file).isFile()) throw new Error(`${file} exists and is not a file`)
    fs.chmodSync(file, 0o600)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

function legacyEntries(paths) {
  return Object.entries(INSTANCE_NAMES).map(([key, name]) => ({
    link: path.join(paths.release.root, name),
    target: paths.instance[key],
    type: key === 'uploadsDir' ? 'dir' : 'file',
  }))
}

function inspectLink({ link, target }) {
  try {
    const entry = fs.lstatSync(link)
    if (!entry.isSymbolicLink()) throw new Error(`refusing to replace existing path: ${link}`)
    const actual = path.resolve(path.dirname(link), fs.readlinkSync(link))
    if (actual !== path.resolve(target)) {
      throw new Error(`legacy link points to a different target: ${link}`)
    }
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

/**
 * Create optional checkout-local compatibility links for migration tooling.
 * The operation preflights every path and never overwrites a file or link.
 */
export function createLegacyStateSymlinks(paths) {
  if (!paths.instance.external) return
  const entries = legacyEntries(paths)
  const existing = entries.map(inspectLink)
  entries.forEach((entry, index) => {
    if (!existing[index]) fs.symlinkSync(entry.target, entry.link, entry.type)
  })
  ensureOwnerOnlyFile(paths.instance.boxesFile)
  ensureOwnerOnlyFile(paths.instance.sharingFile)
  ensureOwnerOnlyFile(paths.instance.pushKeysFile)
}
