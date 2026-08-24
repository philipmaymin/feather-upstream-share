export function toolIntentMessage(message) {
  if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) return null
  for (const block of message.content) {
    if (block?.type !== 'tool_use') continue
    const intent = typeof block.intent === 'string' ? block.intent.trim() : ''
    const inputIntent = typeof block.input?.i === 'string' ? block.input.i.trim() : ''
    if (intent || inputIntent) return intent || inputIntent
  }
  return null
}

export function isFinalAssistantMessage(message) {
  if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) return false
  const hasText = message.content.some(block => block?.type === 'text' && block.text?.trim())
  const hasTool = message.content.some(block => block?.type === 'tool_use' || block?.type === 'tool_result')
  return hasText && !hasTool
}

export function toolIntentTransition(currentState, message) {
  const state = currentState || { status: '', history: [], working: false }
  if (message?.role === 'user') return { status: '', history: [], working: true }
  const update = toolIntentMessage(message)
  if (update) {
    const history = state.history.at(-1) === update ? state.history : [...state.history, update].slice(-20)
    return { status: update, history, working: true }
  }
  if (isFinalAssistantMessage(message)) return { status: '', history: [], working: false }
  const hasTrace = message?.role === 'assistant' && Array.isArray(message.content) &&
    message.content.some(block =>
      block?.type === 'thinking' || block?.type === 'tool_use' || block?.type === 'tool_result'
    )
  return { ...state, working: hasTrace ? true : state.working }
}

export function deriveToolIntentState(messages) {
  let state = { status: '', history: [], working: false }
  for (const message of messages || []) state = toolIntentTransition(state, message)
  return state
}
