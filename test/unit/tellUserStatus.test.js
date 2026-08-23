import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { deriveTellUserState, isFinalAssistantMessage, tellUserMessage } from '../../frontend/src/lib/tellUserStatus.js'

const message = (role, content) => ({ role, content })
const text = (value) => ({ type: 'text', text: value })
const thinking = (value) => ({ type: 'thinking', thinking: value })
const tool = (name, input = {}) => ({ type: 'tool_use', name, input })

describe('tell_user status lifecycle', () => {
  it('extracts a literal tell_user message and ignores ordinary tools', () => {
    assert.equal(tellUserMessage(message('assistant', [tool('tell_user', { message: '  Testing mobile.  ' })])), 'Testing mobile.')
    assert.equal(tellUserMessage(message('assistant', [tool('bash', { command: 'npm test' })])), null)
    assert.equal(tellUserMessage(message('user', [tool('tell_user', { message: 'Nope' })])), null)
  })

  it('treats text with optional reasoning as final, but not text accompanying a tool call', () => {
    assert.equal(isFinalAssistantMessage(message('assistant', [thinking('private'), text('Done.')])), true)
    assert.equal(isFinalAssistantMessage(message('assistant', [text('Checking.'), tool('read')])), false)
    assert.equal(isFinalAssistantMessage(message('assistant', [thinking('still working')])), false)
  })

  it('keeps only the latest unresolved status in the current user turn', () => {
    const messages = [
      message('user', [text('Fix the upload.')]),
      message('assistant', [tool('tell_user', { message: 'Inspecting upload recovery.' })]),
      message('assistant', [tool('tell_user', { message: 'Testing the repaired upload.' })]),
      message('assistant', [text('Checking one more thing.'), tool('bash')]),
    ]
    assert.deepEqual(deriveTellUserState(messages), {
      status: 'Testing the repaired upload.', working: true,
    })
  })

  it('clears status on a final answer or a new user turn', () => {
    const working = [
      message('user', [text('Fix it.')]),
      message('assistant', [tool('tell_user', { message: 'Testing.' })]),
    ]
    assert.deepEqual(deriveTellUserState([...working, message('assistant', [thinking('done'), text('Fixed.')])]), {
      status: '', working: false,
    })
    assert.deepEqual(deriveTellUserState([...working, message('user', [text('One more thing.')])]), {
      status: '', working: true,
    })
  })

  it('reconstructs an unresolved working turn even before tell_user is called', () => {
    assert.deepEqual(deriveTellUserState([
      message('user', [text('Investigate this.')]),
      message('assistant', [thinking('checking'), tool('read')]),
    ]), { status: '', working: true })
  })
})
