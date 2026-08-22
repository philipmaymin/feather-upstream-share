import { appBasePath } from './appPath.js'

const ROOT_KEY = 'feather-message-outbox-v1'
const MESSAGE_ID = /^[a-zA-Z0-9_-]{8,128}$/

export function messageOutboxKey(pathname = globalThis.location?.pathname || '/') {
  const base = appBasePath(pathname)
  return base ? `${ROOT_KEY}:${encodeURIComponent(base)}` : ROOT_KEY
}

function validate(record) {
  const valid = record && typeof record === 'object' &&
    typeof record.id === 'string' && MESSAGE_ID.test(record.id) &&
    typeof record.sessionId === 'string' && record.sessionId.length > 0 &&
    typeof record.text === 'string' && record.text.trim().length > 0 &&
    Number.isFinite(record.createdAt) && Number.isInteger(record.attempts) && record.attempts >= 0
  if (!valid) throw new Error('Invalid pending message record')
  return record
}

function read(storage, pathname) {
  const raw = storage.getItem(messageOutboxKey(pathname))
  if (!raw) return []
  let parsed
  try { parsed = JSON.parse(raw) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  return parsed.filter(record => {
    try { validate(record); return true } catch { return false }
  }).sort((a, b) => a.createdAt - b.createdAt)
}

function write(storage, pathname, records) {
  const key = messageOutboxKey(pathname)
  if (records.length) storage.setItem(key, JSON.stringify(records))
  else storage.removeItem(key)
}

export function listPendingMessages(storage = globalThis.localStorage, pathname) {
  return read(storage, pathname)
}

export function putPendingMessage(record, storage = globalThis.localStorage, pathname) {
  const next = validate({ ...record, attempts: record.attempts || 0 })
  const records = read(storage, pathname)
  const index = records.findIndex(item => item.id === next.id)
  if (index >= 0) {
    if (records[index].sessionId !== next.sessionId || records[index].text !== next.text) {
      throw new Error('Pending message id already belongs to different content')
    }
    records[index] = { ...records[index], ...next }
  } else {
    records.push(next)
  }
  write(storage, pathname, records)
  return next
}

export function patchPendingMessage(id, patch, storage = globalThis.localStorage, pathname) {
  const records = read(storage, pathname)
  const index = records.findIndex(item => item.id === id)
  if (index < 0) return null
  const next = validate({ ...records[index], ...patch, id })
  records[index] = next
  write(storage, pathname, records)
  return next
}

export function deletePendingMessage(id, storage = globalThis.localStorage, pathname) {
  const records = read(storage, pathname)
  write(storage, pathname, records.filter(item => item.id !== id))
}
