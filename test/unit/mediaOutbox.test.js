import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isTerminalMediaRecord, mediaOutboxDatabaseName } from '../../frontend/src/lib/mediaOutbox.js'

describe('media outbox scope', () => {
  it('preserves the legacy root database while isolating mounted applications', () => {
    assert.equal(mediaOutboxDatabaseName('/'), 'feather-media-outbox')
    assert.equal(mediaOutboxDatabaseName('/feather2/'), 'feather-media-outbox:%2Ffeather2')
    assert.equal(mediaOutboxDatabaseName('/canary-zak/'), 'feather-media-outbox:%2Fcanary-zak')
    assert.notEqual(mediaOutboxDatabaseName('/feather2/'), mediaOutboxDatabaseName('/canary-zak/'))
  })

  it('recognizes delivered audio as terminal recovery state', () => {
    assert.equal(isTerminalMediaRecord({ kind: 'audio', status: 'delivered' }), true)
    assert.equal(isTerminalMediaRecord({ kind: 'audio', status: 'failed' }), false)
    assert.equal(isTerminalMediaRecord({ kind: 'file', status: 'delivered' }), false)
  })
})
