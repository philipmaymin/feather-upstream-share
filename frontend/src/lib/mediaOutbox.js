const DB_NAME = 'feather-media-outbox'
const STORE = 'items'
const KINDS = new Set(['file', 'image', 'audio'])
const FILE_STATUSES = new Set(['draft', 'uploading', 'uploaded', 'failed'])
const AUDIO_STATUSES = new Set(['transcribing', 'failed'])

function validateMediaRecord(record) {
  const valid = record && typeof record === 'object' &&
    typeof record.id === 'string' && typeof record.boxId === 'string' &&
    typeof record.sessionId === 'string' && typeof record.name === 'string' &&
    KINDS.has(record.kind) && record.blob instanceof Blob &&
    (record.kind === 'audio' ? AUDIO_STATUSES : FILE_STATUSES).has(record.status)
  if (!valid) throw new Error('Invalid media recovery record')
  return record
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'))
  })
}

let databasePromise = null

function openMediaOutbox() {
  if (!globalThis.indexedDB) return Promise.reject(new Error('IndexedDB is unavailable'))
  if (databasePromise) return databasePromise
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: 'id' })
      store.createIndex('scope', ['boxId', 'sessionId'])
    }
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => { db.close(); databasePromise = null }
      db.onclose = () => { databasePromise = null }
      resolve(db)
    }
    request.onerror = () => {
      databasePromise = null
      reject(request.error || new Error('Could not open media recovery storage'))
    }
  })
  return databasePromise
}

async function withStore(mode, run, retryClosed = true) {
  const db = await openMediaOutbox()
  let tx
  try {
    tx = db.transaction(STORE, mode)
  } catch (error) {
    if (retryClosed && error?.name === 'InvalidStateError') {
      databasePromise = null
      return withStore(mode, run, false)
    }
    throw error
  }
  const result = await run(tx.objectStore(STORE))
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'))
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'))
  })
  return result
}

export function putMediaRecord(record) {
  const next = validateMediaRecord({ ...record, updatedAt: Date.now() })
  return withStore('readwrite', store => requestResult(store.put(next)))
}

export async function patchMediaRecord(id, patch) {
  return withStore('readwrite', async store => {
    const current = await requestResult(store.get(id))
    if (!current) return null
    const next = validateMediaRecord({ ...current, ...patch, id, updatedAt: Date.now() })
    await requestResult(store.put(next))
    return next
  })
}

export function deleteMediaRecord(id) {
  return withStore('readwrite', store => requestResult(store.delete(id)))
}

export function listMediaRecords(boxId, sessionId) {
  return withStore('readonly', async store => {
    const records = await requestResult(store.index('scope').getAll([boxId, sessionId]))
    return records.map(validateMediaRecord)
  })
}
