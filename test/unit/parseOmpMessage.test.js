import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseOmpMessage } from '../../lib/parse.js'

// Helper to build an OMP JSONL line
function omp(overrides) {
  return JSON.stringify({
    type: 'message',
    id: 'abc123',
    parentId: 'parent1',
    timestamp: '2026-04-02T14:00:00Z',
    message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ...overrides,
  })
}

// ── Basic parsing ───────────────────────────────────────────────────────────

describe('parseOmpMessage: basic parsing', () => {
  it('parses a user text message', () => {
    const msg = parseOmpMessage(omp())
    assert.ok(msg)
    assert.equal(msg.role, 'user')
    assert.equal(msg.uuid, 'abc123')
    assert.equal(msg.timestamp, '2026-04-02T14:00:00Z')
    assert.deepEqual(msg.content, [{ type: 'text', text: 'hello' }])
  })

  it('parses an assistant message with text and thinking', () => {
    const msg = parseOmpMessage(omp({
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'let me think...' },
          { type: 'text', text: 'Here is my answer.' },
        ],
      },
    }))
    assert.ok(msg)
    assert.equal(msg.role, 'assistant')
    assert.equal(msg.content.length, 2)
    assert.equal(msg.content[0].type, 'thinking')
    assert.equal(msg.content[1].type, 'text')
  })
})

// ── toolCall normalization ──────────────────────────────────────────────────

describe('parseOmpMessage: toolCall → tool_use normalization', () => {
  it('normalizes toolCall blocks to tool_use', () => {
    const msg = parseOmpMessage(omp({
      message: {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'toolu_001',
          name: 'bash',
          arguments: { command: 'ls -la', _i: 'listing files' },
          intent: 'listing files',
        }],
      },
    }))
    assert.ok(msg)
    assert.equal(msg.content.length, 1)
    const b = msg.content[0]
    assert.equal(b.type, 'tool_use')
    assert.equal(b.id, 'toolu_001')
    assert.equal(b.name, 'bash')
    assert.deepEqual(b.input, { command: 'ls -la', _i: 'listing files' })
  })

  it('parses assistant message with only toolCall blocks (previously dropped)', () => {
    const msg = parseOmpMessage(omp({
      message: {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'tc1', name: 'read', arguments: { file_path: '/a.ts' } },
          { type: 'toolCall', id: 'tc2', name: 'grep', arguments: { pattern: 'foo' } },
        ],
      },
    }))
    assert.ok(msg, 'should NOT be dropped')
    assert.equal(msg.content.length, 2)
    assert.equal(msg.content[0].type, 'tool_use')
    assert.equal(msg.content[1].type, 'tool_use')
  })

  it('normalizes toolCall mixed with text', () => {
    const msg = parseOmpMessage(omp({
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Running command...' },
          { type: 'toolCall', id: 'tc1', name: 'bash', arguments: { command: 'echo hi' } },
        ],
      },
    }))
    assert.ok(msg)
    assert.equal(msg.content[0].type, 'text')
    assert.equal(msg.content[1].type, 'tool_use')
    assert.equal(msg.content[1].name, 'bash')
  })
})

// ── toolResult handling ─────────────────────────────────────────────────────

describe('parseOmpMessage: toolResult role', () => {
  it('parses toolResult role into tool_result block', () => {
    const msg = parseOmpMessage(omp({
      message: {
        role: 'toolResult',
        toolCallId: 'toolu_001',
        toolName: 'bash',
        content: [{ type: 'text', text: 'total 42\ndrwxr-xr-x 5 user user 4096' }],
        isError: false,
        timestamp: 1712345678000,
      },
    }))
    assert.ok(msg, 'toolResult messages should be parsed')
    assert.equal(msg.role, 'assistant') // normalized to assistant for rendering
    assert.equal(msg.content.length, 1)
    const b = msg.content[0]
    assert.equal(b.type, 'tool_result')
    assert.equal(b.tool_use_id, 'toolu_001')
    assert.ok(b.content.includes('total 42'))
    assert.equal(b.is_error, false)
  })

  it('parses error toolResult with is_error flag', () => {
    const msg = parseOmpMessage(omp({
      message: {
        role: 'toolResult',
        toolCallId: 'toolu_err',
        toolName: 'web_search',
        content: [{ type: 'text', text: 'Network timeout' }],
        isError: true,
        timestamp: 1712345678000,
      },
    }))
    assert.ok(msg)
    assert.equal(msg.content[0].is_error, true)
    assert.equal(msg.content[0].content, 'Network timeout')
  })

  it('handles toolResult with string content', () => {
    const msg = parseOmpMessage(omp({
      message: {
        role: 'toolResult',
        toolCallId: 'tc1',
        toolName: 'read',
        content: 'file contents here',
        isError: false,
        timestamp: 1712345678000,
      },
    }))
    assert.ok(msg)
    assert.equal(msg.content[0].content, 'file contents here')
  })

  it('handles toolResult with multiple text blocks', () => {
    const msg = parseOmpMessage(omp({
      message: {
        role: 'toolResult',
        toolCallId: 'tc1',
        toolName: 'bash',
        content: [
          { type: 'text', text: 'line 1' },
          { type: 'text', text: 'line 2' },
        ],
        isError: false,
        timestamp: 1712345678000,
      },
    }))
    assert.ok(msg)
    assert.equal(msg.content[0].content, 'line 1\nline 2')
  })
})

// ── Filtering ───────────────────────────────────────────────────────────────

describe('parseOmpMessage: filtering', () => {
  it('filters non-message types (session, model_change, etc.)', () => {
    assert.equal(parseOmpMessage(JSON.stringify({ type: 'session', version: 3, id: 'x' })), null)
    assert.equal(parseOmpMessage(JSON.stringify({ type: 'model_change', model: 'opus' })), null)
    assert.equal(parseOmpMessage(JSON.stringify({ type: 'thinking_level_change', thinkingLevel: 'high' })), null)
  })

  it('filters unknown roles', () => {
    const msg = parseOmpMessage(omp({ message: { role: 'fileMention', content: [{ type: 'text', text: 'x' }] } }))
    assert.equal(msg, null)
  })

  it('filters empty content', () => {
    assert.equal(parseOmpMessage(omp({ message: { role: 'user', content: [] } })), null)
    assert.equal(parseOmpMessage(omp({ message: { role: 'user', content: '' } })), null)
    assert.equal(parseOmpMessage(omp({ message: { role: 'user', content: '   ' } })), null)
  })

  it('filters invisible-only blocks', () => {
    // A message with only an unknown block type should be filtered
    const msg = parseOmpMessage(omp({
      message: { role: 'assistant', content: [{ type: 'future_unknown', data: 'x' }] },
    }))
    assert.equal(msg, null)
  })

  it('returns null for invalid JSON', () => {
    assert.equal(parseOmpMessage('not json'), null)
    assert.equal(parseOmpMessage(''), null)
  })
})

// ── Timestamp handling ──────────────────────────────────────────────────────

describe('parseOmpMessage: timestamps', () => {
  it('uses entry timestamp when available', () => {
    const msg = parseOmpMessage(omp({ timestamp: '2026-04-02T12:00:00Z' }))
    assert.equal(msg.timestamp, '2026-04-02T12:00:00Z')
  })

  it('falls back to message.timestamp (epoch ms) when entry timestamp missing', () => {
    const msg = parseOmpMessage(omp({
      timestamp: undefined,
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1712345678000 },
    }))
    assert.ok(msg)
    assert.ok(msg.timestamp.includes('2024')) // epoch 1712345678000 is in 2024
  })
})
