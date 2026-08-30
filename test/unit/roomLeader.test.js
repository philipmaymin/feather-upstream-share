import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ROOM_LEADER_PROMPT_VERSION, roomLeaderPrompt } from '../../lib/room-leader.js'

describe('Room Leader prompt', () => {
  it('names the Room and preserves the leader, A2A, Council, and Caretaker boundaries', () => {
    const prompt = roomLeaderPrompt('feather')
    assert.equal(ROOM_LEADER_PROMPT_VERSION, 2)
    assert.match(prompt, /Room Leader: #feather/)
    assert.match(prompt, /every human message as addressed to the Room/)
    assert.match(prompt, /Agents may communicate explicitly with each other/)
    assert.match(prompt, /own the final Room response/)
    assert.match(prompt, /Council is a separate sealed-independence protocol/)
    assert.match(prompt, /Caretaker is its consolidating writer/)
    assert.match(prompt, /Raw sessions, notes, tools, and legacy updates are evidence/)
    assert.match(prompt, /prefer Sidecar over spawning an equivalent temporary subagent/)
    assert.match(prompt, /sidecar post --to <role>/)
    assert.match(prompt, /Never spawn a generic subagent that duplicates an available resident role/)
  })
})
