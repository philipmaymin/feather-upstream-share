import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseCodexMessage, parseMessageForAgent } from '../../lib/parse.js'

function codexResponseItem(payload, timestamp = '2026-04-26T09:00:00.000Z') {
  return JSON.stringify({ timestamp, type: 'response_item', payload })
}

describe('parseCodexMessage: exec command and stdin tools', () => {
  it('parses exec_command function calls into tool_use blocks', () => {
    const msg = parseCodexMessage(codexResponseItem({
      type: 'function_call',
      name: 'exec_command',
      arguments: JSON.stringify({
        cmd: 'npm test',
        workdir: '/home/user/feather-test',
        yield_time_ms: 1000,
        max_output_tokens: 12000,
      }),
      call_id: 'call_exec_123',
    }))

    assert.ok(msg)
    assert.equal(msg.uuid, 'call_exec_123')
    assert.equal(msg.role, 'assistant')
    assert.equal(msg.timestamp, '2026-04-26T09:00:00.000Z')
    assert.deepEqual(msg.content, [{
      type: 'tool_use',
      id: 'call_exec_123',
      name: 'exec_command',
      input: {
        cmd: 'npm test',
        workdir: '/home/user/feather-test',
        yield_time_ms: 1000,
        max_output_tokens: 12000,
      },
    }])
  })

  it('parses write_stdin function calls into tool_use blocks', () => {
    const msg = parseCodexMessage(codexResponseItem({
      type: 'function_call',
      name: 'write_stdin',
      arguments: JSON.stringify({
        session_id: 42,
        chars: 'y\n',
        yield_time_ms: 1000,
        max_output_tokens: 6000,
      }),
      call_id: 'call_stdin_123',
    }))

    assert.ok(msg)
    assert.equal(msg.uuid, 'call_stdin_123')
    assert.equal(msg.role, 'assistant')
    assert.deepEqual(msg.content, [{
      type: 'tool_use',
      id: 'call_stdin_123',
      name: 'write_stdin',
      input: {
        session_id: 42,
        chars: 'y\n',
        yield_time_ms: 1000,
        max_output_tokens: 6000,
      },
    }])
  })

  it('parses exec_command output into a tool_result block', () => {
    const msg = parseCodexMessage(codexResponseItem({
      type: 'function_call_output',
      call_id: 'call_exec_123',
      output: JSON.stringify({
        output: 'Process exited with code 0\nOutput:\nall tests passed\n',
        metadata: { exit_code: 0, duration_seconds: 1.2 },
      }),
    }))

    assert.ok(msg)
    assert.equal(msg.uuid, 'call_exec_123')
    assert.equal(msg.role, 'user')
    assert.deepEqual(msg.content, [{
      type: 'tool_result',
      tool_use_id: 'call_exec_123',
      content: 'Process exited with code 0\nOutput:\nall tests passed\n',
      is_error: false,
    }])
  })

  it('marks non-zero exec_command output as an error', () => {
    const msg = parseCodexMessage(codexResponseItem({
      type: 'function_call_output',
      call_id: 'call_exec_123',
      output: JSON.stringify({
        output: 'Process exited with code 1\nOutput:\nfailed\n',
        metadata: { exit_code: 1, duration_seconds: 0.3 },
      }),
    }))

    assert.ok(msg)
    assert.equal(msg.content[0].is_error, true)
    assert.equal(msg.content[0].content, 'Process exited with code 1\nOutput:\nfailed\n')
  })

  it('dispatches codex agent lines through parseMessageForAgent', () => {
    const msg = parseMessageForAgent(codexResponseItem({
      type: 'function_call',
      name: 'write_stdin',
      arguments: JSON.stringify({ session_id: 7, chars: '\u0003' }),
      call_id: 'call_stdin_interrupt',
    }), 'codex')

    assert.ok(msg)
    assert.equal(msg.content[0].type, 'tool_use')
    assert.equal(msg.content[0].name, 'write_stdin')
    assert.equal(msg.content[0].input.chars, '\u0003')
  })
})
