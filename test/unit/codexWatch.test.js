import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveCodexWatchId, codexAdoptionPending } from '../../lib/codex-watch.js'

describe('resolveCodexWatchId', () => {
  it('restores the Feather session id after a server restart', () => {
    const meta = {
      'feather-session-id': {
        agent: 'codex',
        codexUuid: 'raw-codex-uuid',
      },
    }

    assert.equal(resolveCodexWatchId('raw-codex-uuid', meta), 'feather-session-id')
  })

  it('keeps the raw Codex UUID for sessions without Feather metadata', () => {
    assert.equal(resolveCodexWatchId('unmapped-uuid', {}), 'unmapped-uuid')
  })
})

describe('codexAdoptionPending', () => {
  it('stops adoption after deletion or after a UUID has already been adopted', () => {
    assert.equal(codexAdoptionPending({}, 'local-id'), false)
    assert.equal(codexAdoptionPending({ 'local-id': { agent: 'codex' } }, 'local-id'), true)
    assert.equal(codexAdoptionPending({ 'local-id': { agent: 'codex', codexUuid: 'raw-id' } }, 'local-id'), false)
  })
})
