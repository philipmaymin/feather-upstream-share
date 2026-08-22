import fs from 'fs'
import path from 'path'

let tempSequence = 0
const activeMutations = new Set()

export const isJsonRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export class JsonStateError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'JsonStateError'
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function existingRealPath(candidate) {
  try { return fs.realpathSync(candidate) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return null
  }
}

function canonicalMissingPath(candidate) {
  const parent = path.dirname(candidate)
  const realParent = existingRealPath(parent)
  return realParent ? path.join(realParent, path.basename(candidate)) : path.resolve(candidate)
}

function resolveRecordedPath(file, root) {
  const absoluteRoot = path.resolve(root)
  const resolvedRoot = existingRealPath(absoluteRoot) || absoluteRoot
  const absoluteFile = path.resolve(file)
  let resolvedFile = existingRealPath(absoluteFile)

  if (!resolvedFile) {
    try {
      const entry = fs.lstatSync(absoluteFile)
      if (entry.isSymbolicLink()) {
        const linked = path.resolve(path.dirname(absoluteFile), fs.readlinkSync(absoluteFile))
        resolvedFile = canonicalMissingPath(linked)
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  resolvedFile ||= canonicalMissingPath(absoluteFile)

  if (!isInside(resolvedRoot, resolvedFile)) {
    throw new JsonStateError(`${file} resolves outside recorded state root ${root}`)
  }
  return resolvedFile
}

function validateValue(value, { document, validate }) {
  let valid = false
  try { valid = validate(value) !== false } catch (error) {
    throw new JsonStateError(`invalid ${document}: ${error.message}`, { cause: error })
  }
  if (!valid) throw new JsonStateError(`invalid ${document}`)
  return value
}

function parseBytes(bytes, config, source) {
  let value
  try { value = JSON.parse(bytes) } catch (error) {
    throw new JsonStateError(`malformed ${config.document} at ${source}; recover explicitly from ${source}.last-good`, { cause: error })
  }
  return validateValue(value, config)
}

function readExisting(file, config) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const mode = fs.fstatSync(fd).mode & 0o777
    const bytes = fs.readFileSync(fd, 'utf8')
    return { exists: true, bytes, value: parseBytes(bytes, config, file), mode }
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false }
    throw error
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function callFault(config, stage, context) {
  config.faultInjector?.(stage, context)
}

function fsyncDirectory(dir, config, kind) {
  const fd = fs.openSync(dir, 'r')
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  callFault(config, 'after-directory-fsync', { kind, directory: dir })
}

function removeUnpairedBackup(backup) {
  try { fs.unlinkSync(backup) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return
  }
  const fd = fs.openSync(path.dirname(backup), 'r')
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}

function atomicReplace(file, bytes, mode, config, kind) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tempFile = path.join(dir, `.${path.basename(file)}.json-state-${process.pid}-${++tempSequence}.tmp`)
  let fd
  let renamed = false
  try {
    fd = fs.openSync(tempFile, 'wx', mode)
    fs.writeFileSync(fd, bytes)
    fs.fchmodSync(fd, mode)
    fs.fsyncSync(fd)
    callFault(config, 'after-temp-fsync', { kind, file, tempFile })
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(tempFile, file)
    renamed = true
    callFault(config, 'after-rename', { kind, file, tempFile })
    fsyncDirectory(dir, config, kind)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    if (!renamed) {
      try { fs.unlinkSync(tempFile) } catch {}
    }
  }
}

function serialize(value, config) {
  validateValue(value, config)
  let bytes
  try { bytes = JSON.stringify(value, null, 2) } catch (error) {
    throw new JsonStateError(`cannot serialize ${config.document}: ${error.message}`, { cause: error })
  }
  if (bytes === undefined) throw new JsonStateError(`cannot serialize ${config.document}`)
  parseBytes(bytes, config, config.file)
  return bytes
}

function cloneDefault(defaultValue) {
  const value = typeof defaultValue === 'function' ? defaultValue() : defaultValue
  return structuredClone(value)
}

/**
 * A synchronous, process-serialized JSON document store. Missing documents use
 * an in-memory default; malformed or invalid documents always fail closed.
 */
export function createJsonState({
  file,
  root = path.dirname(file),
  document = path.basename(file),
  defaultValue,
  validate = () => true,
  mode,
  defaultMode = 0o644,
  faultInjector,
}) {
  if (!file) throw new TypeError('JSON state file is required')
  const config = { file, document, validate, faultInjector }

  function locations() {
    const target = resolveRecordedPath(file, root)
    return { target, backup: resolveRecordedPath(`${target}.last-good`, root) }
  }

  function readCurrent(target, backup) {
    const current = readExisting(target, config)
    if (!current.exists && fs.existsSync(backup)) {
      throw new JsonStateError(`missing ${document} at ${target} while a recovery copy exists; recover explicitly`)
    }
    return current
  }

  function read() {
    const { target, backup } = locations()
    const current = readCurrent(target, backup)
    return current.exists ? current.value : cloneDefault(defaultValue)
  }

  function commit(value, current, target, backup) {
    const bytes = serialize(value, config)
    const targetMode = mode ?? current.mode ?? defaultMode
    if (current.exists && current.bytes === bytes && current.mode === targetMode) {
      const recovery = readExisting(backup, config)
      if (!recovery.exists) atomicReplace(backup, current.bytes, targetMode, config, 'backup')
      else if (recovery.mode !== targetMode) atomicReplace(backup, recovery.bytes, targetMode, config, 'backup')
      return value
    }
    if (current.exists) {
      atomicReplace(backup, current.bytes, targetMode, config, 'backup')
      atomicReplace(target, bytes, targetMode, config, 'target')
    } else {
      try {
        atomicReplace(backup, bytes, targetMode, config, 'backup')
        atomicReplace(target, bytes, targetMode, config, 'target')
      } catch (error) {
        if (!fs.existsSync(target)) removeUnpairedBackup(backup)
        throw error
      }
    }
    return value
  }

  function mutate(operation) {
    const { target, backup } = locations()
    if (activeMutations.has(target)) throw new JsonStateError(`${document} mutation already in progress`)
    activeMutations.add(target)
    try { return operation(target, backup) }
    finally { activeMutations.delete(target) }
  }

  function write(value) {
    return mutate((target, backup) => {
      const current = readCurrent(target, backup)
      return commit(value, current, target, backup)
    })
  }

  function update(mutator) {
    return mutate((target, backup) => {
      const existing = readCurrent(target, backup)
      const current = existing.exists ? existing.value : cloneDefault(defaultValue)
      const next = mutator(current)
      if (next === current) return current
      return commit(next, existing, target, backup)
    })
  }

  function recover() {
    return mutate((target, backup) => {
      const recovery = readExisting(backup, config)
      if (!recovery.exists) throw new JsonStateError(`no recovery copy exists for ${document}`)
      const targetMode = mode ?? (() => {
        try { return fs.statSync(target).mode & 0o777 } catch { return recovery.mode ?? defaultMode }
      })()
      atomicReplace(target, recovery.bytes, targetMode, config, 'recovery')
      return recovery.value
    })
  }

  return Object.freeze({ read, write, update, recover })
}
