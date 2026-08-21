import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { codexPasteBufferArgs } from '../../lib/tmux-input.js'

describe('Codex tmux input', () => {
  it('uses real bracketed paste and preserves multiline input', () => {
    assert.deepEqual(
      codexPasteBufferArgs('f-session'),
      ['paste-buffer', '-p', '-r', '-t', 'f-session'],
    )
  })
})
