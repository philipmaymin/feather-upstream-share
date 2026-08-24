function ompSessionRecordFromHead(head) {
  for (const line of String(head || '').split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      if (entry?.type === 'session') return entry
    } catch {
      // A truncated final line in the bounded head is expected; earlier complete
      // records are still safe to inspect.
    }
  }
  return null
}

// OMP may prepend mutable metadata records (for example `type: "title"`) before
// the stable session header. Resume must search the bounded transcript head for
// the exact session data; it must never guess via `omp --continue`.
export function ompSessionIdFromHead(head) {
  const id = ompSessionRecordFromHead(head)?.id
  return typeof id === 'string' && id ? id : null
}

export function ompSessionCwdFromHead(head) {
  const cwd = ompSessionRecordFromHead(head)?.cwd
  return typeof cwd === 'string' && cwd.startsWith('/') ? cwd : null
}

// The durable stop record is the first safe point for replacing a pre-bridge
// OMP process. A queued/new user turn cancels that pending migration.
export function ompTurnBoundaryFromLine(line) {
  try {
    const entry = JSON.parse(line)
    if (entry?.type !== 'message' || !entry.message) return null
    const message = entry.message
    if (message.role === 'user') return 'active'
    if (message.role === 'toolResult') return 'active'
    if (message.role !== 'assistant') return null
    const hasToolCall = Array.isArray(message.content) && message.content.some(block => block?.type === 'toolCall')
    return message.stopReason === 'stop' && !hasToolCall ? 'completed' : 'active'
  } catch {
    return null
  }
}
