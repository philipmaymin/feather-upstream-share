// Pure JSONL parsing functions — imported by server.js and tests

const STRIP_TAGS = ['local-command-caveat', 'command-name', 'command-message', 'command-args', 'persisted-output']

export function parseMessage(line) {
  try {
    const d = JSON.parse(line)
    if (d.type !== 'user' && d.type !== 'assistant') return null
    if (d.isSidechain || d.isMeta || !d.message) return null

    const content = d.message.content
    if (!content) return null
    if (Array.isArray(content) && content.length === 0) return null
    if (typeof content === 'string' && content.trim() === '') return null

    let blocks
    if (typeof content === 'string') {
      let text = content
      for (const tag of STRIP_TAGS) {
        text = text.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g'), '')
      }
      text = text.trim()
      if (!text) return null
      blocks = [{ type: 'text', text }]
    } else {
      blocks = content
    }

    // Skip messages where every block is invisible (e.g. empty thinking placeholders)
    const hasVisible = blocks.some(b =>
      (b.type === 'text' && b.text?.trim()) ||
      (b.type === 'thinking' && b.thinking?.trim()) ||
      b.type === 'tool_use' ||
      b.type === 'tool_result'
    )
    if (!hasVisible) return null

    const result = { uuid: d.uuid, role: d.message.role, timestamp: d.timestamp, content: blocks }
    // Pass through stop_reason so frontend can detect turn completion
    const stop = d.message.stop_reason
    if (stop) result.stopReason = stop
    // Pass through metadata
    if (d.cwd) result.cwd = d.cwd
    if (d.message.model) result.model = d.message.model
    if (d.message.usage) result.usage = d.message.usage
    if (d.version) result.version = d.version
    if (d.gitBranch) result.gitBranch = d.gitBranch
    return result
  } catch { return null }
}
