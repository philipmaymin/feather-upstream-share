import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sessionIsActive, ACTIVE_MS, messageTimestampMs, lastMessageMs, latestSessionActivityMs } from '../../lib/sessions.js'

// Regression: finished sessions kept showing the green "active" dot because
// isActive was true whenever a feather-* tmux session existed, which lingers up
// to the idle-reaper window (~1h). The fix requires a recent JSONL write too.
describe('sessionIsActive', () => {
  const id = 'abcdef12-3456-7890-abcd-ef1234567890'
  const prefix = id.slice(0, 8) // 'abcdef12'
  const now = 1_000_000_000_000

  it('is active when tmux is alive and the JSONL was written recently', () => {
    const active = new Set([prefix])
    assert.equal(sessionIsActive(active, id, now - 60_000, now), true)
  })

  it('is NOT active when tmux is alive but the last write is older than ACTIVE_MS', () => {
    // This is the exact bug: a lingering tmux pane with no recent activity.
    const active = new Set([prefix])
    assert.equal(sessionIsActive(active, id, now - (ACTIVE_MS + 1), now), false)
  })

  it('is NOT active when there is a recent write but no live tmux session', () => {
    const active = new Set()
    assert.equal(sessionIsActive(active, id, now - 1_000, now), false)
  })

  it('treats the ACTIVE_MS boundary as exclusive', () => {
    const active = new Set([prefix])
    assert.equal(sessionIsActive(active, id, now - ACTIVE_MS, now), false)
    assert.equal(sessionIsActive(active, id, now - (ACTIVE_MS - 1), now), true)
  })
})

describe('latestSessionActivityMs', () => {
  it('protects a newly resumed session whose transcript is old', () => {
    const oldMessage = Date.parse('2026-08-22T12:00:00Z')
    const resumed = Date.parse('2026-08-22T17:00:00Z')
    assert.equal(latestSessionActivityMs(oldMessage, resumed), resumed)
  })

  it('keeps a newer real message authoritative', () => {
    assert.equal(latestSessionActivityMs(200, 100), 200)
  })
})

// Regression: the green dot / sort time must come from the last real message,
// NOT the file mtime. A resumed agent appends system/permission-mode lines to
// the JSONL while idle; those bump mtime but must not count as activity (a
// session idle since 1am was showing a green dot and "1m").
describe('messageTimestampMs', () => {
  const T = '2026-06-27T01:00:00.000Z'
  const ms = Date.parse(T)

  it('counts a real claude user/assistant message', () => {
    assert.equal(messageTimestampMs({ type: 'assistant', timestamp: T, message: {} }, 'claude'), ms)
    assert.equal(messageTimestampMs({ type: 'user', timestamp: T, message: {} }, 'claude'), ms)
  })

  it('ignores claude system / permission-mode / meta lines', () => {
    assert.equal(messageTimestampMs({ type: 'system', timestamp: T }, 'claude'), null)
    assert.equal(messageTimestampMs({ type: 'permission-mode', timestamp: T }, 'claude'), null)
    assert.equal(messageTimestampMs({ type: 'user', isMeta: true, timestamp: T }, 'claude'), null)
  })

  it('counts a real codex message and ignores other event types', () => {
    assert.equal(messageTimestampMs({ type: 'response_item', timestamp: T, payload: { type: 'message', role: 'assistant' } }, 'codex'), ms)
    assert.equal(messageTimestampMs({ type: 'response_item', timestamp: T, payload: { type: 'reasoning' } }, 'codex'), null)
  })
})

describe('lastMessageMs', () => {
  const real = '2026-06-27T01:00:00.000Z'  // ~1am, the actual last message
  const late = '2026-06-27T15:30:00.000Z'  // bookkeeping writes hours later
  const lines = [
    JSON.stringify({ type: 'user', timestamp: real, message: {} }),
    JSON.stringify({ type: 'assistant', timestamp: real, message: {} }),
    JSON.stringify({ type: 'system', timestamp: late }),
    JSON.stringify({ type: 'permission-mode', timestamp: late }),
  ].join('\n')

  it('returns the last REAL message time, ignoring trailing system writes', () => {
    assert.equal(lastMessageMs(lines, 'claude'), Date.parse(real))
  })

  it('skips a truncated leading line when reading a mid-file tail', () => {
    const tail = '{"type":"assist' + '\n' + lines
    assert.equal(lastMessageMs(tail, 'claude', true), Date.parse(real))
  })

  it('returns null when there is no real message', () => {
    const onlySystem = [JSON.stringify({ type: 'system', timestamp: late })].join('\n')
    assert.equal(lastMessageMs(onlySystem, 'claude'), null)
  })
})

// Regression: pi-mono-family agents append an `agent_status` heartbeat every
// ~25s while idle. Those must never count as activity — they kept mtime fresh
// forever, so the idle reaper never killed the tmux session (panes alive for
// 5 days) and the sidebar showed stale sessions as open.
describe('agent_status heartbeats', () => {
  const real = '2026-08-05T21:17:09.040Z'  // the actual last message
  const beat = '2026-08-10T00:23:53.799Z'  // heartbeat five days later

  it('ignores an agent_status line', () => {
    const line = { type: 'agent_status', timestamp: beat, status: { taskState: 'needs_input' } }
    assert.equal(messageTimestampMs(line, 'omp'), null)
  })

  it('counts a real prime message', () => {
    const line = { type: 'message', timestamp: real, message: { role: 'assistant' } }
    assert.equal(messageTimestampMs(line, 'omp'), Date.parse(real))
  })

  it('returns the last real message time across a run of heartbeats', () => {
    const lines = [
      JSON.stringify({ type: 'message', timestamp: real, message: { role: 'assistant' } }),
      ...Array.from({ length: 100 }, () =>
        JSON.stringify({ type: 'agent_status', timestamp: beat, status: { taskState: 'needs_input' } })),
    ].join('\n')
    assert.equal(lastMessageMs(lines, 'omp'), Date.parse(real))
  })
})
