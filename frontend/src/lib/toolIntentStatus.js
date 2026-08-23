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

export function toolIntentTransition(currentStatus, message) {
  if (message?.role === 'user') return { status: '', working: true }
  const update = toolIntentMessage(message)
  if (update) return { status: update, working: true }
  if (isFinalAssistantMessage(message)) return { status: '', working: false }
  const hasTrace = message?.role === 'assistant' && Array.isArray(message.content) &&
    message.content.some(block =>
      block?.type === 'thinking' || block?.type === 'tool_use' || block?.type === 'tool_result'
    )
  return { status: currentStatus, working: hasTrace ? true : null }
}

export function deriveToolIntentState(messages) {
  let state = { status: '', working: false }
  for (const message of messages || []) {
    const transition = toolIntentTransition(state.status, message)
    state = {
      status: transition.status,
      working: transition.working === null ? state.working : transition.working,
    }
  }
  return state
}
