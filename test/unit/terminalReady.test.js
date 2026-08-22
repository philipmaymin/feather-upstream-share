import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { paneHasReadyPrompt } from '../../lib/terminal-ready.js'

describe('paneHasReadyPrompt', () => {
  it('recognizes Claude prompts', () => {
    assert.equal(paneHasReadyPrompt('Welcome\n\n❯\n', 'claude'), true)
    assert.equal(paneHasReadyPrompt('❯ Try "explain this code"\n', 'claude'), true)
  })

  it('recognizes the Codex composer after a resumed transcript', () => {
    const pane = '• Restored prior work.\n\n› Run /review on my current changes\n\n  gpt-5.6-sol xhigh · ~\n'
    assert.equal(paneHasReadyPrompt(pane, 'codex'), true)
  })

  it('does not mistake another agent prompt for readiness', () => {
    assert.equal(paneHasReadyPrompt('› Run /review\n', 'claude'), false)
    assert.equal(paneHasReadyPrompt('❯\n', 'codex'), false)
  })

  it('ignores status-only panes', () => {
    assert.equal(paneHasReadyPrompt('Loading conversation…\nWorking\n', 'codex'), false)
  })
})
