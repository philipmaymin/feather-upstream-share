function messageText(message) {
  return (message.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text || '')
    .join('\n')
    .trim()
}

function canonicalDelivery(text) {
  const match = text.match(/^\[feather-sidecar ([a-z0-9._-]+) ([1-9]\d*) ([A-Za-z0-9._-]+)\](?: (.+))?$/)
  if (!match) return null
  if (match[4] === undefined) return { groupId: match[1], seq: Number(match[2]), from: match[3], text: null }
  try {
    const payload = JSON.parse(match[4])
    return typeof payload === 'string' ? { groupId: match[1], seq: Number(match[2]), from: match[3], text: payload } : null
  } catch {
    return null
  }
}

export function mergeRoomThreadMessages(sessionMessages, thread, groupId) {
  if (!groupId) return sessionMessages
  const visibleSessionMessages = sessionMessages.filter((message) => {
    if (message.role !== 'user') return true
    const delivery = canonicalDelivery(messageText(message))
    if (!delivery || delivery.groupId !== groupId) return true
    return !(thread || []).some((candidate) =>
      candidate.seq === delivery.seq
        && candidate.from === delivery.from
        && (delivery.text === null || candidate.text === delivery.text))
  })
  const sidecarMessages = (thread || []).map((message) => {
    const from = message.from === 'human' ? 'You' : message.from.charAt(0).toUpperCase() + message.from.slice(1)
    const to = message.to.charAt(0).toUpperCase() + message.to.slice(1)
    return {
      uuid: `${groupId}-${message.seq}`,
      role: message.from === 'human' ? 'user' : 'assistant',
      timestamp: new Date(message.ts).toISOString(),
      content: [{ type: 'text', text: `**${from} → ${to}**\n\n${message.text}` }],
      passive: true,
      roomFrom: message.from,
      roomTo: message.to,
    }
  })
  return [...visibleSessionMessages, ...sidecarMessages].sort((a, b) =>
    Date.parse(a.timestamp || '') - Date.parse(b.timestamp || '') || a.uuid.localeCompare(b.uuid))
}
