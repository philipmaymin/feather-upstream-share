import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { deriveTodoSnapshot, reduceTodoSnapshot, todoSnapshotFromMessage } from '../../frontend/src/lib/ompTodo.js'

const todoMessage = (phases) => ({
  role: 'assistant',
  content: [{ type: 'tool_result', name: 'todo', details: { phases } }],
})

describe('OMP Todo snapshots', () => {
  it('normalizes progress totals and the active task', () => {
    const snapshot = todoSnapshotFromMessage(todoMessage([
      { name: 'Build', tasks: [
        { content: 'Wire bridge', status: 'completed' },
        { content: 'Render stream', status: 'in_progress' },
      ] },
      { name: 'Verify', tasks: [{ content: 'Run smoke', status: 'pending' }] },
    ]))

    assert.deepEqual(snapshot, {
      phases: [
        { name: 'Build', tasks: [
          { content: 'Wire bridge', status: 'completed' },
          { content: 'Render stream', status: 'in_progress' },
        ] },
        { name: 'Verify', tasks: [{ content: 'Run smoke', status: 'pending' }] },
      ],
      completed: 1,
      total: 3,
      active: 'Render stream',
    })
  })

  it('keeps the latest valid Todo result and ignores unrelated tools', () => {
    const first = todoMessage([{ name: 'Build', tasks: [{ content: 'One', status: 'in_progress' }] }])
    const unrelated = { role: 'assistant', content: [{ type: 'tool_result', name: 'bash', details: { phases: [] } }] }
    const latest = todoMessage([{ name: 'Build', tasks: [{ content: 'One', status: 'completed' }] }])

    assert.equal(todoSnapshotFromMessage(unrelated), undefined)
    assert.deepEqual(deriveTodoSnapshot([first, unrelated, latest]), {
      phases: [{ name: 'Build', tasks: [{ content: 'One', status: 'completed' }] }],
      completed: 1,
      total: 1,
      active: null,
    })
  })

  it('resets Todo history at a new user turn', () => {
    const previous = todoMessage([{ name: 'Previous', tasks: [{ content: 'Must not leak', status: 'completed' }] }])
    const currentUser = { role: 'user', content: [{ type: 'text', text: 'Answer directly.' }] }
    const currentAnswer = { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }

    assert.equal(deriveTodoSnapshot([previous, currentUser, currentAnswer]), null)
  })

  it('applies the same reset to live user messages while preserving unrelated updates', () => {
    const previous = todoSnapshotFromMessage(todoMessage([
      { name: 'Previous', tasks: [{ content: 'Must not leak', status: 'completed' }] },
    ]))
    const unrelated = { role: 'assistant', content: [{ type: 'text', text: 'Still working.' }] }
    const currentUser = { role: 'user', content: [{ type: 'text', text: 'Start fresh.' }] }

    assert.equal(reduceTodoSnapshot(previous, unrelated), previous)
    assert.equal(reduceTodoSnapshot(previous, currentUser), null)
  })
})
