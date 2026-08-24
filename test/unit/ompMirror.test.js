import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OMP_CHILD_LIMIT, OMP_WORK_LIMIT, createOmpMirrorState, reduceOmpMirrorState } from '../../frontend/src/lib/ompMirror.js'

function reduce(events) {
  return events.reduce(reduceOmpMirrorState, createOmpMirrorState())
}

describe('OMP mirror reducer', () => {
  it('immutably reconciles a parent tool lifecycle without changing its order or regressing on replay', () => {
    const initial = createOmpMirrorState()
    const started = reduceOmpMirrorState(initial, {
      type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read',
      args: { path: '/tmp/state' }, intent: 'Reading state',
    })
    const updated = reduceOmpMirrorState(started, {
      type: 'tool_execution_update', toolCallId: 'read-1', toolName: 'read', partialResult: 'half',
    })
    const ended = reduceOmpMirrorState(updated, {
      type: 'tool_execution_end', toolCallId: 'read-1', toolName: 'read', result: 'done', isError: false,
    })
    const replayed = reduceOmpMirrorState(ended, {
      type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read', intent: 'Reading state',
    })

    assert.deepEqual(initial, createOmpMirrorState())
    assert.equal(replayed.parent.timeline.length, 1)
    assert.deepEqual(replayed.parent.timeline[0], {
      key: 'tool:read-1', kind: 'tool', toolCallId: 'read-1', toolName: 'read', status: 'success',
      args: { path: '/tmp/state' }, intent: 'Reading state', partialResult: 'half', result: 'done', isError: false,
    })
  })

  it('keeps normal tool-call segment boundaries running and distinguishes real cancellation', () => {
    const running = reduce([
      { type: 'agent_start' },
      { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read' },
      { type: 'assistant_cancel', messageId: 'segment-1', willContinue: true },
    ])
    assert.equal(running.parent.runStatus, 'running')
    assert.equal(running.parent.timeline[0].status, 'running')

    const cancelled = reduceOmpMirrorState(running, { type: 'assistant_cancel' })
    assert.equal(cancelled.parent.runStatus, 'cancelled')
    assert.equal(cancelled.parent.timeline[0].status, 'cancelled')
  })

  it('routes child work, answer text, and Todo away from the parent while retaining lifecycle identity', () => {
    const state = reduce([
      { type: 'subagent_lifecycle', id: 'child-1', agent: 'scout', agentSource: 'task', status: 'started', index: 0, assignment: 'Map bridge events', resolvedModel: 'gpt-5.6', parentToolCallId: 'spawn-1' },
      { type: 'assistant_snapshot', subagentId: 'child-1', messageId: 'child-msg', text: 'Child answer is streaming.' },
      { type: 'todo', subagentId: 'child-1', phases: [{ name: 'Inspect', tasks: [{ content: 'Read bridge', status: 'in_progress' }] }] },
      { type: 'work_snapshot', subagentId: 'child-1', messageId: 'child-msg', blocks: [{ type: 'thinking', thinking: 'Tracing nested events.' }] },
      { type: 'tool_execution_start', subagentId: 'child-1', toolCallId: 'child-read', toolName: 'read', intent: 'Reading nested event fixture' },
      { type: 'tool_execution_start', toolCallId: 'parent-read', toolName: 'read', intent: 'Reading parent fixture' },
    ])

    assert.equal(state.parent.timeline.length, 1)
    assert.equal(state.parent.timeline[0].toolCallId, 'parent-read')
    assert.equal(state.parent.todo, null)
    assert.deepEqual(state.childOrder, ['child-1'])
    assert.equal(state.children['child-1'].assignment, 'Map bridge events')
    assert.equal(state.children['child-1'].assistantText, 'Child answer is streaming.')
    assert.equal(state.children['child-1'].todo.active, 'Read bridge')
    assert.deepEqual(state.children['child-1'].timeline.map(item => item.key), ['thinking:child-msg:0', 'tool:child-read'])

    const progressed = reduceOmpMirrorState(state, {
      type: 'subagent_progress', id: 'child-1', agent: 'scout', status: 'running', index: 0, toolCount: 1,
    })
    assert.equal(progressed.children['child-1'].timeline.length, 2)
  })


  it('reconciles authoritative snapshots and bounds chronology', () => {
    const events = [
      { type: 'work_snapshot', messageId: 'answer-1', blocks: [{ type: 'thinking', thinking: 'First pass' }, { type: 'tool_use', id: 'tool-1', name: 'read', intent: 'Reading fixture' }] },
      { type: 'work_snapshot', messageId: 'answer-1', blocks: [{ type: 'thinking', thinking: 'Refined pass' }, { type: 'tool_use', id: 'tool-1', name: 'read', intent: 'Reading fixture' }, { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok', is_error: false }] },
      ...Array.from({ length: OMP_WORK_LIMIT + 5 }, (_, index) => ({ type: 'tool_execution_start', toolCallId: `bounded-${index}`, toolName: 'read' })),
    ]
    const state = reduce(events)

    assert.equal(state.parent.timeline.length, OMP_WORK_LIMIT)
    assert.equal(state.parent.timeline.at(-1).toolCallId, `bounded-${OMP_WORK_LIMIT + 4}`)
    assert.equal(state.parent.timeline.some(item => item.key === 'tool:bounded-0'), false)
  })

  it('resets settled children at a new parent turn and bounds live child cardinality', () => {
    const events = Array.from({ length: OMP_CHILD_LIMIT + 5 }, (_, index) => ({
      type: 'subagent_lifecycle', id: `child-${index}`, agent: 'scout', status: 'completed', index,
    }))
    const bounded = reduce(events)
    assert.equal(bounded.childOrder.length, OMP_CHILD_LIMIT)
    const reset = reduceOmpMirrorState(bounded, { type: 'agent_start' })
    assert.deepEqual(reset.childOrder, [])
    assert.deepEqual(reset.children, {})
  })
})
