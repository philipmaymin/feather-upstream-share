const TOOL_ALIASES = {
  bash: 'Bash', read: 'Read', write: 'Write', edit: 'Edit',
  exec: 'Exec', exec_command: 'Bash', exec_comman: 'Bash',
  apply_patch: 'Patch', write_stdin: 'Input',
  grep: 'Grep', glob: 'Glob', find: 'Glob',
  task: 'Agent', agent: 'Agent',
  ipython: 'IPython', rlm: 'Subagent',
  webfetch: 'WebFetch', fetch: 'WebFetch',
  websearch: 'WebSearch', web_search: 'WebSearch',
}

const WEB_OPERATIONS = {
  search_query: 'Search',
  image_query: 'Images',
  open: 'Open',
  click: 'Open link',
  find: 'Find',
  screenshot: 'Screenshot',
  finance: 'Finance',
  weather: 'Weather',
  sports: 'Sports',
  time: 'Time',
}

const SUMMARY_META_KEYS = new Set([
  'response_length', 'yield_time_ms', 'max_output_tokens', 'timeout',
])

function titleWords(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, char => char.toUpperCase())
}

function sentenceWords(value) {
  const words = titleWords(value)
  return words ? words.charAt(0).toUpperCase() + words.slice(1).toLowerCase() : ''
}

export function canonicalToolName(raw) {
  if (!raw) return 'tool'
  const stripped = raw.replace(/^mcp__.+?__/, '') || raw
  const leaf = stripped.split('.').pop() || stripped
  return TOOL_ALIASES[stripped.toLowerCase()] || TOOL_ALIASES[leaf.toLowerCase()] || titleWords(stripped)
}

export function commandText(input) {
  return (input?.command || input?.cmd || input?.raw || '').trim()
}

export function patchText(input) {
  return (input?.raw || input?.input || input?.patch || '').trim()
}

export function stdinText(input) {
  return input?.chars || input?.input || ''
}

function patchSummary(input) {
  const text = patchText(input)
  if (!text) return ''
  const firstFile = text.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/m)?.[1]
  const changeCount = (text.match(/^\*\*\* (?:Update|Add|Delete) File: /gm) || []).length
  if (firstFile) {
    const short = firstFile.split('/').slice(-2).join('/')
    return changeCount > 1 ? `${short} +${changeCount - 1}` : short
  }
  const firstLine = text.split('\n').find(Boolean) || ''
  return firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine
}

function stdinSummary(input) {
  const chars = stdinText(input)
  if (!chars) return input?.session_id != null ? `session ${input.session_id}` : ''
  const visible = chars
    .replace(/\u0003/g, '^C')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
  const prefix = input?.session_id != null ? `session ${input.session_id}: ` : ''
  return prefix + (visible.length > 60 ? visible.slice(0, 60) + '…' : visible)
}

function shortValue(value) {
  if (value == null) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const text = String(value).replace(/\s+/g, ' ').trim()
    return text.length > 80 ? text.slice(0, 80) + '…' : text
  }
  if (Array.isArray(value)) return value.length ? shortValue(value[0]) : ''
  if (typeof value === 'object') {
    for (const key of ['location', 'q', 'query', 'ticker', 'team', 'ref_id', 'url', 'path', 'pattern', 'id']) {
      if (value[key] != null) return shortValue(value[key])
    }
  }
  return ''
}

function webSummary(input) {
  const parts = []
  for (const [key, label] of Object.entries(WEB_OPERATIONS)) {
    if (input[key] == null) continue
    const value = shortValue(input[key])
    parts.push(value ? `${label} · ${value}` : label)
  }
  if (!parts.length) return genericSummary(input)
  return parts.length > 1 ? `${parts[0]} +${parts.length - 1}` : parts[0]
}

function genericSummary(input) {
  if (typeof input === 'string') return shortValue(input.split('\n')[0])
  if (!input || typeof input !== 'object') return shortValue(input)

  for (const key of ['command', 'cmd', 'query', 'q', 'url', 'path', 'file_path', 'location', 'description', 'prompt', 'raw']) {
    if (input[key] != null) return shortValue(input[key])
  }

  const entry = Object.entries(input).find(([key]) => !SUMMARY_META_KEYS.has(key))
  if (!entry) return ''
  const [key, value] = entry
  const concise = shortValue(value)
  return concise ? `${sentenceWords(key)} · ${concise}` : sentenceWords(key)
}

function nestedToolCalls(raw) {
  if (typeof raw !== 'string') return []
  const calls = []
  const toolPattern = /tools\.([A-Za-z0-9_]+)\s*\(/g
  let match

  while ((match = toolPattern.exec(raw))) {
    let start = toolPattern.lastIndex
    while (/\s/.test(raw[start] || '')) start++
    if (raw[start] !== '{') continue

    let depth = 0
    let quoted = false
    let escaped = false
    let end = start
    for (; end < raw.length; end++) {
      const char = raw[end]
      if (quoted) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') quoted = false
        continue
      }
      if (char === '"') quoted = true
      else if (char === '{') depth++
      else if (char === '}' && --depth === 0) {
        end++
        break
      }
    }

    try {
      calls.push({ name: match[1], input: JSON.parse(raw.slice(start, end)) })
      toolPattern.lastIndex = end
    } catch {}
  }
  return calls
}

export function toolSummary(name, input) {
  if (!input) return ''
  const fp = input.file_path || input.path || ''
  const short = fp.split('/').slice(-2).join('/')
  switch (name) {
    case 'Read': return short + (input.offset ? ` L${input.offset}` : '')
    case 'Write': return short
    case 'Edit': return short + (input.replace_all ? ' ×all' : '')
    case 'Bash': { const c = commandText(input).split('\n')[0]; return c.length > 80 ? c.slice(0, 80) + '…' : c }
    case 'Patch': return patchSummary(input)
    case 'Input': return stdinSummary(input)
    case 'Grep': return `${input.pattern || ''}${input.path ? ' in ' + input.path : ''}`
    case 'Glob': return input.pattern || ''
    case 'Agent': { const d = input.description || (input.prompt || '').split('\n')[0]; return d ? (d.length > 80 ? d.slice(0, 80) + '…' : d) : '' }
    case 'WebFetch': return input.url || ''
    case 'WebSearch': return input.query || ''
    case 'Web': return webSummary(input)
    default: return genericSummary(input)
  }
}

export function toolPresentation(rawName, input) {
  const storedName = String(rawName || '').toLowerCase()
  if (storedName === 'exec' && input?.raw) {
    const nested = nestedToolCalls(input.raw)
    if (nested.length === 1) return toolPresentation(nested[0].name, nested[0].input)
    if (nested.length > 1) {
      const first = toolPresentation(nested[0].name, nested[0].input)
      const firstCall = first.summary ? `${first.name} · ${first.summary}` : first.name
      return { name: 'Tools', summary: `${nested.length} calls · ${firstCall}` }
    }
  }
  if (storedName === 'exec' && (input?.command || input?.cmd)) {
    return { name: 'Bash', summary: toolSummary('Bash', input) }
  }
  const hasWebOperation = input && typeof input === 'object' &&
    Object.keys(WEB_OPERATIONS).some(key => input[key] != null)
  const name = hasWebOperation && (storedName === 'run' || storedName === 'web.run' || storedName === 'web__run')
    ? 'Web'
    : canonicalToolName(rawName)
  return { name, summary: toolSummary(name, input) }
}

export function toolImagePath(rawName, input) {
  const leaf = String(rawName || '')
    .replace(/^mcp__.+?__/, '')
    .split('.')
    .pop()
    ?.toLowerCase()
  return (leaf === 'view_image' || leaf === 'viewimage') && typeof input?.path === 'string'
    ? input.path
    : ''
}

export function toolInputText(input) {
  if (input == null) return ''
  if (typeof input === 'string') return input
  if (typeof input.raw === 'string' && Object.keys(input).length === 1) return input.raw
  try { return JSON.stringify(input, null, 2) } catch { return String(input) }
}
