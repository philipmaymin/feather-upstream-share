export function todoSnapshotFromDetails(details) {
  if (!details || typeof details !== 'object' || !Array.isArray(details.phases)) return null
  const phases = details.phases.map(phase => {
    if (!phase || typeof phase !== 'object' || typeof phase.name !== 'string' || !Array.isArray(phase.tasks)) return null
    const tasks = phase.tasks.map(task => {
      if (!task || typeof task !== 'object' || typeof task.content !== 'string' || typeof task.status !== 'string') return null
      return { content: task.content, status: task.status }
    }).filter(Boolean)
    return { name: phase.name, tasks }
  }).filter(Boolean)
  if (phases.length === 0) return null
  const tasks = phases.flatMap(phase => phase.tasks)
  return {
    phases,
    completed: tasks.filter(task => task.status === 'completed').length,
    total: tasks.length,
    active: tasks.find(task => task.status === 'in_progress')?.content || null,
  }
}

export function todoSnapshotFromMessage(message) {
  if (!message || !Array.isArray(message.content)) return undefined
  for (const block of message.content) {
    if (block?.type !== 'tool_result' || block.name !== 'todo') continue
    return todoSnapshotFromDetails(block.details)
  }
  return undefined
}

export function reduceTodoSnapshot(current, message) {
  if (message?.role === 'user') return null
  const next = todoSnapshotFromMessage(message)
  return next === undefined ? current : next
}

export function deriveTodoSnapshot(messages) {
  let snapshot = null
  for (const message of messages || []) snapshot = reduceTodoSnapshot(snapshot, message)
  return snapshot
}
