const DB_NAME = 'feather-media-outbox'
const STORE = 'items'

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'))
  })
}

export function openMediaOutbox() {
  if (!globalThis.indexedDB) return Promise.reject(new Error('IndexedDB is unavailable'))
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: 'id' })
      store.createIndex('scope', ['boxId', 'sessionId'])
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Could not open media recovery storage'))
  })
}

async function withStore(mode, run) {
  const db = await openMediaOutbox()
  try {
    const tx = db.transaction(STORE, mode)
    const result = await run(tx.objectStore(STORE))
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'))
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'))
    })
    return result
  } finally {
    db.close()
  }
}

export function putMediaRecord(record) {
  return withStore('readwrite', store => requestResult(store.put({ ...record, updatedAt: Date.now() })))
}

export async function patchMediaRecord(id, patch) {
  return withStore('readwrite', async store => {
    const current = await requestResult(store.get(id))
    if (!current) return null
    const next = { ...current, ...patch, id, updatedAt: Date.now() }
    await requestResult(store.put(next))
    return next
  })
}

export function deleteMediaRecord(id) {
  return withStore('readwrite', store => requestResult(store.delete(id)))
}

export function listMediaRecords(boxId, sessionId) {
  return withStore('readonly', store => requestResult(store.index('scope').getAll([boxId, sessionId])))
}
