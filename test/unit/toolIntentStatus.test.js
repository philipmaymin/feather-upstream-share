import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { deriveToolIntentState, isFinalAssistantMessage, toolIntentMessage } from '../../frontend/src/lib/toolIntentStatus.js'

const message = (role, content) => ({ role, content })
const text = (value) => ({ type: 'text', text: value })
const thinking = (value) => ({ type: 'thinking', thinking: value })
const tool = (name, input = {}, intent) => ({ type: 'tool_use', name, input, intent })

describe('OMP tool-intent status lifecycle', () => {
  it('uses the native intent field and falls back to the traced i argument', () => {
    assert.equal(toolIntentMessage(message('assistant', [tool('bash', {}, 'Testing mobile layout')])), 'Testing mobile layout')
    assert.equal(toolIntentMessage(message('assistant', [tool('read', { i: 'Reading session state' })])), 'Reading session state')
    assert.equal(toolIntentMessage(message('assistant', [tool('bash', { command: 'npm test' })])), null)
    assert.equal(toolIntentMessage(message('user', [tool('read', {}, 'Nope')])), null)
  })

  it('treats text with optional reasoning as final, but not text accompanying a tool call', () => {
    assert.equal(isFinalAssistantMessage(message('assistant', [thinking('private'), text('Done.')])), true)
    assert.equal(isFinalAssistantMessage(message('assistant', [text('Checking.'), tool('read')])), false)
    assert.equal(isFinalAssistantMessage(message('assistant', [thinking('still working')])), false)
  })

  it('keeps clickable unresolved intent history in the current user turn', () => {
    const messages = [
      message('user', [text('Fix the upload.')]),
      message('assistant', [tool('read', {}, 'Inspecting upload recovery')]),
      message('assistant', [tool('bash', {}, 'Testing the repaired upload')]),
      message('assistant', [text('Checking one more thing.'), tool('bash')]),
    ]
    assert.deepEqual(deriveToolIntentState(messages), {
      status: 'Testing the repaired upload',
      history: ['Inspecting upload recovery', 'Testing the repaired upload'],
      working: true,
    })
  })

  it('clears status on a final answer or a new user turn', () => {
    const working = [
      message('user', [text('Fix it.')]),
      message('assistant', [tool('bash', {}, 'Testing')]),
    ]
    assert.deepEqual(deriveToolIntentState([...working, message('assistant', [thinking('done'), text('Fixed.')])]), {
      status: '', history: [], working: false,
    })
    assert.deepEqual(deriveToolIntentState([...working, message('user', [text('One more thing.')])]), {
      status: '', history: [], working: true,
    })
  })

  it('reconstructs an unresolved working turn before a tool intent arrives', () => {
    assert.deepEqual(deriveToolIntentState([
      message('user', [text('Investigate this.')]),
      message('assistant', [thinking('checking'), tool('read')]),
    ]), { status: '', history: [], working: true })
  })
})
