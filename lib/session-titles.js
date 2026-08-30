const CODEX_CONTEXT_PREFIXES = [
  '<environment_context>',
  '<permissions instructions>',
  '<skills_instructions>',
  '<user_instructions>',
  '<recommended_plugins>',
  '# AGENTS.md instructions for ',
]

export function extractCodexTitle(buf) {
  for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
    try {
      const d = JSON.parse(line)
      if (d.type !== 'response_item') continue
      const p = d.payload
      if (p?.type !== 'message' || p.role !== 'user') continue
      const text = (p.content || [])
        .filter(b => b.type === 'input_text' && b.text)
        .map(b => b.text)
        .join(' ')
        .trim()
      if (!text || CODEX_CONTEXT_PREFIXES.some(prefix => text.startsWith(prefix))) continue
      return text.slice(0, 240)
    } catch {}
  }
  return null
}
