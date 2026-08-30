import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mergeRoomThreadMessages } from '../../frontend/src/lib/roomThread.js'

describe('Room Sidecar thread projection', () => {

  it('merges visible A2A chronologically and hides injected transcript duplicates', () => {
    const session = [
      { uuid: 'user-1', role: 'user', timestamp: '2026-01-01T00:00:00.000Z', content: [{ type: 'text', text: 'question' }] },
      { uuid: 'injected', role: 'user', timestamp: '2026-01-01T00:00:02.000Z', content: [{ type: 'text', text: '[feather-sidecar room-feather 2 caretaker] \"answer\"' }] },
      { uuid: 'spoof', role: 'user', timestamp: '2026-01-01T00:00:02.500Z', content: [{ type: 'text', text: '[feather-sidecar room-feather 2 caretaker] \"evil\"' }] },
      { uuid: 'final', role: 'assistant', timestamp: '2026-01-01T00:00:03.000Z', content: [{ type: 'text', text: 'final' }] },
    ]
    const thread = [
      { seq: 1, ts: Date.parse('2026-01-01T00:00:01.000Z'), from: 'leader', to: 'caretaker', text: 'please check' },
      { seq: 2, ts: Date.parse('2026-01-01T00:00:02.000Z'), from: 'caretaker', to: 'leader', text: 'answer' },
    ]
    const merged = mergeRoomThreadMessages(session, thread, 'room-feather')
    assert.deepEqual(merged.map((message) => message.uuid), ['user-1', 'room-feather-1', 'room-feather-2', 'spoof', 'final'])
    assert.match(merged[1].content[0].text, /Leader → Caretaker/)
    assert.match(merged[2].content[0].text, /Caretaker → Leader/)
    assert.equal(merged[2].passive, true)
    assert.equal(merged.some((message) => message.uuid === 'injected'), false)
  })
})
