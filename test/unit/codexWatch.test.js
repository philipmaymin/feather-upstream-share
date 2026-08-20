import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveCodexWatchId } from '../../lib/codex-watch.js'

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
