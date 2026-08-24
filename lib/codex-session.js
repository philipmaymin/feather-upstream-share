// Codex persists every spawned subagent as a normal rollout file beside the
// human-owned thread. They are useful implementation detail, but presenting
// them as independent Feather chats makes one parallel turn look like dozens
// of conversations the user never created.
export function codexSessionIsWorkerFromHead(head) {
  const text = Buffer.isBuffer(head) ? head.toString('utf8') : String(head || '')
  if (text.includes('AUTO_WORKER=TRUE')) return true

  // These fields occur before the potentially large base_instructions value,
  // so this remains reliable even when the bounded head ends mid-record.
  if (/"thread_source"\s*:\s*"subagent"/.test(text)) return true
  if (/"source"\s*:\s*\{\s*"subagent"\s*:/.test(text)) return true

  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      if (entry?.type !== 'session_meta') continue
      const payload = entry.payload || {}
      return payload.thread_source === 'subagent'
        || payload.source === 'subagent'
        || !!payload.source?.subagent
    } catch {
      // A bounded head can end inside a large first record. The metadata regex
      // checks above already handles that expected case.
    }
  }
  return false
}
