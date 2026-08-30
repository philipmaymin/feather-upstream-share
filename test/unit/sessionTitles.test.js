import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { extractCodexTitle } from '../../lib/session-titles.js'

function message(role, text) {
  return JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role,
      content: [{ type: 'input_text', text }],
    },
  })
}

describe('extractCodexTitle', () => {
  it('uses the first real prompt after Codex workspace instructions', () => {
    const buf = Buffer.from([
      message('developer', '<permissions instructions>runtime metadata</permissions instructions>'),
      message('user', '# AGENTS.md instructions for /home/user\n\n<INSTRUCTIONS>\nWorkspace rules\n</INSTRUCTIONS>'),
      message('user', 'Build me a tiny weather app'),
    ].join('\n'))

    assert.equal(extractCodexTitle(buf), 'Build me a tiny weather app')
  })

  it('ignores other user-role bootstrap context', () => {
    const buf = Buffer.from([
      message('user', '<environment_context><cwd>/home/user</cwd></environment_context>'),
      message('user', '<recommended_plugins>plugin catalog</recommended_plugins>'),
      message('user', 'Review the latest dashboard'),
    ].join('\n'))

    assert.equal(extractCodexTitle(buf), 'Review the latest dashboard')
  })
})
