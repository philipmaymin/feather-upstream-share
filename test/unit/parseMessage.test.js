import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { parseMessage } from '../../lib/parse.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixturePath = path.join(__dirname, '..', 'fixtures', 'synthetic-session.jsonl')
const lines = fs.readFileSync(fixturePath, 'utf8').split('\n').filter(Boolean)

// Helper to build a JSONL line
function jsonl(overrides) {
  return JSON.stringify({
    type: 'user',
    uuid: 'test-uuid-0001',
    timestamp: '2025-06-15T10:00:00Z',
    isSidechain: false,
    isMeta: false,
    message: { role: 'user', content: 'hello world' },
    ...overrides,
  })
}

// ── Basic parsing ───────────────────────────────────────────────────────────

describe('parseMessage: basic parsing', () => {
  it('parses a plain user message', () => {
    const msg = parseMessage(lines[0])
    assert.ok(msg)
    assert.equal(msg.role, 'user')
    assert.equal(msg.uuid, 'aaaa-1111-bbbb-2222')
    assert.equal(msg.timestamp, '2025-06-15T10:00:00Z')
    assert.equal(msg.content.length, 1)
    assert.equal(msg.content[0].type, 'text')
    assert.equal(msg.content[0].text, 'Hello, can you help me refactor the login page?')
  })

  it('parses assistant message with text + thinking blocks', () => {
    const msg = parseMessage(lines[1])
    assert.ok(msg)
    assert.equal(msg.role, 'assistant')
    assert.equal(msg.content.length, 2)
    assert.equal(msg.content[0].type, 'text')
    assert.equal(msg.content[0].text, 'Sure! Let me look at the current login page first.')
    assert.equal(msg.content[1].type, 'thinking')
    assert.equal(msg.content[1].thinking, 'I should read the login component to understand the current structure before making changes.')
  })

  it('parses tool_use with name and input', () => {
    const msg = parseMessage(lines[2])
    assert.ok(msg)
    assert.equal(msg.content[0].type, 'tool_use')
    assert.equal(msg.content[0].name, 'Read')
    assert.equal(msg.content[0].id, 'tool_001')
    assert.equal(msg.content[0].input.file_path, '/src/pages/Login.tsx')
  })

  it('parses tool_result with content string', () => {
    const msg = parseMessage(lines[3])
    assert.ok(msg)
    assert.equal(msg.content[0].type, 'tool_result')
    assert.equal(msg.content[0].tool_use_id, 'tool_001')
    assert.ok(msg.content[0].content.includes('export function Login'))
  })

  it('parses error tool_result with is_error flag', () => {
    const msg = parseMessage(lines[8])
    assert.ok(msg)
    assert.equal(msg.content[0].type, 'tool_result')
    assert.equal(msg.content[0].is_error, true)
    assert.ok(msg.content[0].content.includes('FAIL'))
  })

  it('preserves markdown formatting in text', () => {
    const msg = parseMessage(lines[4])
    assert.ok(msg)
    assert.ok(msg.content[0].text.includes('**Extract**'))
    assert.ok(msg.content[0].text.includes('**validation**'))
    assert.ok(msg.content[0].text.includes('1.'))
    assert.ok(msg.content[0].text.includes('2.'))
    assert.ok(msg.content[0].text.includes('3.'))
  })

  it('converts string content to [{type: "text", text}] block', () => {
    const msg = parseMessage(lines[17])
    assert.ok(msg)
    assert.equal(msg.content.length, 1)
    assert.equal(msg.content[0].type, 'text')
    assert.equal(msg.content[0].text, 'Simple string content instead of array')
  })

  it('parses user message with markdown inline elements', () => {
    const msg = parseMessage(lines[20])
    assert.ok(msg)
    assert.ok(msg.content[0].text.includes('**bold**'))
    assert.ok(msg.content[0].text.includes('`code`'))
    assert.ok(msg.content[0].text.includes('[link](https://example.com)'))
  })
})

// ── Filtering ───────────────────────────────────────────────────────────────

describe('parseMessage: filtering', () => {
  it('filters out progress type', () => {
    assert.equal(parseMessage(lines[12]), null)
  })

  it('filters out system type', () => {
    assert.equal(parseMessage(lines[13]), null)
  })

  it('filters out sidechain messages', () => {
    assert.equal(parseMessage(lines[14]), null)
  })

  it('filters out isMeta messages', () => {
    const line = jsonl({ isMeta: true })
    assert.equal(parseMessage(line), null)
  })
  it('filters internal Room Sidecar delivery envelopes', () => {
    const line = jsonl({ message: { role: 'user', content: '[feather-sidecar room-feather 42 operator] "internal coordination"' } })
    assert.equal(parseMessage(line), null)
  })


  it('filters out empty string content', () => {
    assert.equal(parseMessage(lines[18]), null)
  })

  it('filters out empty array content', () => {
    assert.equal(parseMessage(lines[19]), null)
  })

  it('filters out null content', () => {
    const line = jsonl({ message: { role: 'user', content: null } })
    assert.equal(parseMessage(line), null)
  })

  it('filters out missing message field', () => {
    const line = JSON.stringify({ type: 'user', uuid: 'x', timestamp: 'x' })
    assert.equal(parseMessage(line), null)
  })

  it('filters out whitespace-only string content', () => {
    const line = jsonl({ message: { role: 'user', content: '   \n\t  ' } })
    assert.equal(parseMessage(line), null)
  })

  it('filters messages where all tags are stripped leaving nothing', () => {
    assert.equal(parseMessage(lines[15]), null)
  })
})

// ── XML tag stripping ───────────────────────────────────────────────────────

describe('parseMessage: tag stripping', () => {
  it('strips local-command-caveat and keeps remaining text', () => {
    const line = jsonl({
      message: { role: 'user', content: '<local-command-caveat>internal</local-command-caveat>visible text' },
    })
    const msg = parseMessage(line)
    assert.ok(msg)
    assert.equal(msg.content[0].text, 'visible text')
  })

  it('strips command-name tags', () => {
    const line = jsonl({
      message: { role: 'user', content: '<command-name>foo</command-name>after' },
    })
    const msg = parseMessage(line)
    assert.equal(msg.content[0].text, 'after')
  })

  it('strips command-message tags', () => {
    const line = jsonl({
      message: { role: 'user', content: 'before<command-message>bar</command-message>after' },
    })
    const msg = parseMessage(line)
    assert.equal(msg.content[0].text, 'beforeafter')
  })

  it('strips command-args tags', () => {
    const line = jsonl({
      message: { role: 'user', content: '<command-args>--flag</command-args>rest' },
    })
    const msg = parseMessage(line)
    assert.equal(msg.content[0].text, 'rest')
  })

  it('strips persisted-output tags', () => {
    const line = jsonl({
      message: { role: 'user', content: '<persisted-output>big blob</persisted-output>clean' },
    })
    const msg = parseMessage(line)
    assert.equal(msg.content[0].text, 'clean')
  })

  it('strips multiple tags in one message', () => {
    const msg = parseMessage(lines[16])
    assert.ok(msg)
    assert.equal(msg.content[0].text, 'real user text here')
  })

  it('strips multiline tag content', () => {
    const line = jsonl({
      message: { role: 'user', content: '<local-command-caveat>line1\nline2\nline3</local-command-caveat>after' },
    })
    const msg = parseMessage(line)
    assert.equal(msg.content[0].text, 'after')
  })

  it('does NOT strip tags in array content (only string content)', () => {
    const line = jsonl({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '<command-name>should remain</command-name>' }],
      },
    })
    const msg = parseMessage(line)
    assert.ok(msg)
    assert.equal(msg.content[0].text, '<command-name>should remain</command-name>')
  })
})

// ── Edge cases ──────────────────────────────────────────────────────────────

describe('parseMessage: edge cases', () => {
  it('returns null for invalid JSON', () => {
    assert.equal(parseMessage('not json'), null)
    assert.equal(parseMessage('{broken'), null)
    assert.equal(parseMessage(''), null)
  })

  it('returns null for valid JSON but wrong structure', () => {
    assert.equal(parseMessage('{"type":"user"}'), null)
    assert.equal(parseMessage('42'), null)
    assert.equal(parseMessage('"string"'), null)
    assert.equal(parseMessage('null'), null)
    assert.equal(parseMessage('[]'), null)
  })

  it('handles very long text content', () => {
    const longText = 'x'.repeat(100000)
    const line = jsonl({ message: { role: 'user', content: longText } })
    const msg = parseMessage(line)
    assert.ok(msg)
    assert.equal(msg.content[0].text.length, 100000)
  })

  it('handles unicode content', () => {
    const line = jsonl({ message: { role: 'user', content: '你好世界 🚀 café naïve' } })
    const msg = parseMessage(line)
    assert.ok(msg)
    assert.equal(msg.content[0].text, '你好世界 🚀 café naïve')
  })

  it('handles content with newlines and tabs', () => {
    const line = jsonl({ message: { role: 'user', content: 'line1\nline2\ttab' } })
    const msg = parseMessage(line)
    assert.ok(msg)
    assert.equal(msg.content[0].text, 'line1\nline2\ttab')
  })

  it('handles both isSidechain=true and isMeta=true', () => {
    const line = jsonl({ isSidechain: true, isMeta: true })
    assert.equal(parseMessage(line), null)
  })

  it('handles missing uuid gracefully', () => {
    const line = JSON.stringify({
      type: 'user', timestamp: '2025-01-01T00:00:00Z',
      isSidechain: false, isMeta: false,
      message: { role: 'user', content: 'no uuid' },
    })
    const msg = parseMessage(line)
    assert.ok(msg)
    assert.equal(msg.uuid, undefined)
    assert.equal(msg.content[0].text, 'no uuid')
  })

  it('handles missing timestamp gracefully', () => {
    const line = JSON.stringify({
      type: 'user', uuid: 'abc',
      isSidechain: false, isMeta: false,
      message: { role: 'user', content: 'no ts' },
    })
    const msg = parseMessage(line)
    assert.ok(msg)
    assert.equal(msg.timestamp, undefined)
  })

  it('handles content array with mixed known and unknown block types', () => {
    const line = jsonl({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'unknown_future_type', data: 'something' },
          { type: 'tool_use', name: 'Read', id: 'x', input: {} },
        ],
      },
    })
    const msg = parseMessage(line)
    assert.ok(msg)
    assert.equal(msg.content.length, 3)
    assert.equal(msg.content[0].type, 'text')
    assert.equal(msg.content[1].type, 'unknown_future_type')
    assert.equal(msg.content[2].type, 'tool_use')
  })
})

// ── Fixture integrity ───────────────────────────────────────────────────────

describe('parseMessage: fixture counts', () => {
  it('fixture has expected number of lines', () => {
    assert.equal(lines.length, 21)
  })

  it('parses exactly 15 valid messages from fixture', () => {
    let count = 0
    for (const line of lines) {
      if (parseMessage(line)) count++
    }
    assert.equal(count, 15)
  })

  it('every parsed message has role, content array', () => {
    for (const line of lines) {
      const msg = parseMessage(line)
      if (!msg) continue
      assert.ok(['user', 'assistant'].includes(msg.role), `bad role: ${msg.role}`)
      assert.ok(Array.isArray(msg.content), `content not array for ${msg.uuid}`)
      assert.ok(msg.content.length > 0, `empty content for ${msg.uuid}`)
    }
  })

  it('content blocks always have a type field', () => {
    for (const line of lines) {
      const msg = parseMessage(line)
      if (!msg) continue
      for (const block of msg.content) {
        assert.ok(block.type, `block missing type in ${msg.uuid}`)
      }
    }
  })
})
