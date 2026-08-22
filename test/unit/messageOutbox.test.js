import test from 'node:test'
import assert from 'node:assert/strict'
import {
  deletePendingMessage,
  listPendingMessages,
  messageOutboxKey,
  patchPendingMessage,
  putPendingMessage,
} from '../../frontend/src/lib/messageOutbox.js'

function memoryStorage() {
  const values = new Map()
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  }
}

test('message outbox is scoped to the mounted Feather path', () => {
  assert.equal(messageOutboxKey('/'), 'feather-message-outbox-v1')
  assert.equal(messageOutboxKey('/feather/'), 'feather-message-outbox-v1:%2Ffeather')
  assert.equal(messageOutboxKey('/canary/'), 'feather-message-outbox-v1:%2Fcanary')
})

test('pending messages survive reload-style reads and stay ordered', () => {
  const storage = memoryStorage()
  putPendingMessage({ id: 'message-0002', sessionId: 'room-b', text: 'second', createdAt: 20, attempts: 0 }, storage, '/')
  putPendingMessage({ id: 'message-0001', sessionId: 'room-a', text: 'first', createdAt: 10, attempts: 0 }, storage, '/')
  assert.deepEqual(listPendingMessages(storage, '/').map(item => item.text), ['first', 'second'])

  patchPendingMessage('message-0001', { attempts: 1, error: 'offline' }, storage, '/')
  assert.equal(listPendingMessages(storage, '/')[0].error, 'offline')
  deletePendingMessage('message-0001', storage, '/')
  assert.deepEqual(listPendingMessages(storage, '/').map(item => item.id), ['message-0002'])
})

test('an idempotency key cannot be silently reused for different text', () => {
  const storage = memoryStorage()
  putPendingMessage({ id: 'message-same', sessionId: 'room-a', text: 'original', createdAt: 10, attempts: 0 }, storage, '/')
  assert.throws(() => putPendingMessage({ id: 'message-same', sessionId: 'room-a', text: 'changed', createdAt: 11, attempts: 0 }, storage, '/'), /different content/)
})
