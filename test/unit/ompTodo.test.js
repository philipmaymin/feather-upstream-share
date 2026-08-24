import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { deriveTodoSnapshot, todoSnapshotFromMessage } from '../../frontend/src/lib/ompTodo.js'

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
})
