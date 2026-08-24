const WORK_LIMIT = 80
const CHILD_LIMIT = 32

function emptyScope() {
  return {
    timeline: [],
    todo: null,
    activeMessageId: null,
    runStatus: 'idle',
    assistantText: '',
    assistantEnded: false,
  }
}

export function createOmpMirrorState() {
  return {
    parent: emptyScope(),
    children: {},
    childOrder: [],
  }
}

function todoSnapshot(phases) {
  if (!Array.isArray(phases)) return null
  const cleanPhases = phases.map(phase => {
    if (!phase || typeof phase.name !== 'string' || !Array.isArray(phase.tasks)) return null
    const tasks = phase.tasks.map(task => {
      if (!task || typeof task.content !== 'string' || typeof task.status !== 'string') return null
      return {
        content: task.content,
        status: task.status,
        ...(typeof task.blocker === 'string' ? { blocker: task.blocker } : {}),
      }
    }).filter(Boolean)
    return { name: phase.name, tasks }
  }).filter(Boolean)
  if (cleanPhases.length === 0) return null
  const tasks = cleanPhases.flatMap(phase => phase.tasks)
  return {
    phases: cleanPhases,
    completed: tasks.filter(task => task.status === 'completed').length,
    total: tasks.length,
    active: tasks.find(task => task.status === 'in_progress')?.content || null,
  }
}

function toolStatus(existing, requested) {
  if (requested === 'error') return 'error'
  if (existing === 'success' || existing === 'error' || existing === 'cancelled') return existing
  return requested
}

function settleThinking(timeline) {
  return timeline.map(item => item.kind === 'thinking' && item.status === 'running'
    ? { ...item, status: 'success' }
    : item)
}

function bound(timeline) {
  return timeline.length > WORK_LIMIT ? timeline.slice(-WORK_LIMIT) : timeline
}

function upsertTimeline(scope, item) {
  const index = scope.timeline.findIndex(entry => entry.key === item.key)
  if (index >= 0) {
    const previous = scope.timeline[index]
    const next = {
      ...previous,
      ...item,
      status: previous.kind === 'tool' ? toolStatus(previous.status, item.status) : item.status,
    }
    return {
      ...scope,
      timeline: scope.timeline.map((entry, entryIndex) => entryIndex === index ? next : entry),
    }
  }
  return {
    ...scope,
    timeline: bound([...settleThinking(scope.timeline), item]),
  }
}

function upsertTool(scope, event, requestedStatus) {
  if (typeof event.toolCallId !== 'string' || !event.toolCallId) return scope
  const previous = scope.timeline.find(item => item.kind === 'tool' && item.toolCallId === event.toolCallId)
  const item = {
    key: `tool:${event.toolCallId}`,
    kind: 'tool',
    toolCallId: event.toolCallId,
    toolName: typeof event.toolName === 'string' && event.toolName ? event.toolName : previous?.toolName || 'Tool',
    status: requestedStatus,
    ...(event.args !== undefined ? { args: event.args } : {}),
    ...(typeof event.intent === 'string' ? { intent: event.intent } : {}),
    ...(event.partialResult !== undefined ? { partialResult: event.partialResult } : {}),
    ...(event.result !== undefined ? { result: event.result } : {}),
    ...(event.isError !== undefined ? { isError: !!event.isError } : {}),
  }
  return upsertTimeline(scope, item)
}

function contentResult(block) {
  if (block.result !== undefined) return block.result
  if (block.content !== undefined) return block.content
  return undefined
}

function applyWorkSnapshot(scope, event) {
  if (!Array.isArray(event.blocks)) return scope
  let next = {
    ...scope,
    activeMessageId: event.blocks.length > 0 && typeof event.messageId === 'string' ? event.messageId : null,
    runStatus: event.blocks.length > 0 ? 'running' : scope.runStatus,
  }
  for (let index = 0; index < event.blocks.length; index++) {
    const block = event.blocks[index]
    if (!block || typeof block !== 'object') continue
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      const keyPart = typeof block.id === 'string' && block.id ? block.id : `${event.messageId || 'snapshot'}:${index}`
      next = upsertTimeline(next, {
        key: `thinking:${keyPart}`,
        kind: 'thinking',
        text: block.thinking,
        status: 'running',
      })
      continue
    }
    if (block.type === 'tool_use') {
      next = upsertTool(next, {
        toolCallId: block.id || block.toolCallId,
        toolName: block.name || block.toolName,
        args: block.input !== undefined ? block.input : block.args,
        intent: block.intent,
      }, 'running')
      continue
    }
    if (block.type === 'tool_result') {
      next = upsertTool(next, {
        toolCallId: block.tool_use_id || block.toolCallId,
        toolName: block.name || block.toolName,
        result: contentResult(block),
        isError: block.is_error ?? block.isError,
      }, (block.is_error ?? block.isError) ? 'error' : 'success')
    }
  }
  return next
}

function settleScope(scope, status, messageId) {
  if (messageId && scope.activeMessageId && messageId !== scope.activeMessageId) return scope
  return {
    ...scope,
    activeMessageId: null,
    runStatus: status,
    timeline: scope.timeline.map(item => item.status === 'running' ? {
      ...item,
      status,
      ...(status === 'error' && item.kind === 'tool' && item.result === undefined ? { result: 'Cancelled' } : {}),
    } : item),
  }
}

function reduceScope(scope, event) {
  switch (event.type) {
    case 'agent_start':
      return { ...scope, timeline: [], activeMessageId: null, runStatus: 'running', assistantText: '', assistantEnded: false }
    case 'agent_end':
      return settleScope(scope, event.success === false ? 'error' : 'success')
    case 'todo':
      return event.phases ? { ...scope, todo: todoSnapshot(event.phases) } : scope
    case 'assistant_snapshot':
      return typeof event.text === 'string' ? {
        ...scope,
        assistantText: event.text,
        assistantEnded: false,
        activeMessageId: typeof event.messageId === 'string' ? event.messageId : scope.activeMessageId,
        runStatus: 'running',
      } : scope
    case 'work_snapshot':
      return applyWorkSnapshot(scope, event)
    case 'tool_execution_start':
      return { ...upsertTool(scope, event, 'running'), runStatus: 'running' }
    case 'tool_execution_update':
      return { ...upsertTool(scope, event, event.isError ? 'error' : 'running'), runStatus: event.isError ? 'error' : 'running' }
    case 'tool_execution_end':
      return { ...upsertTool(scope, event, event.isError ? 'error' : 'success'), runStatus: event.isError ? 'error' : scope.runStatus }
    case 'assistant_end': {
      const settled = settleScope(scope, 'success', event.messageId)
      return settled === scope ? scope : { ...settled, assistantEnded: true }
    }
    case 'assistant_cancel':
      if (event.willContinue) return { ...scope, activeMessageId: null, runStatus: 'running' }
      return { ...settleScope(scope, 'cancelled', event.messageId), assistantEnded: true }
    default:
      return scope
  }
}

function childStatus(status) {
  if (status === 'completed' || status === 'complete' || status === 'succeeded' || status === 'success') return 'success'
  if (status === 'failed' || status === 'error') return 'error'
  if (status === 'cancelled' || status === 'canceled' || status === 'aborted') return 'cancelled'
  if (status === 'running' || status === 'started' || status === 'working') return 'running'
  return 'idle'
}

function defaultChild(id) {
  return {
    ...emptyScope(),
    id,
    agent: 'Agent',
    status: 'running',
    index: Number.MAX_SAFE_INTEGER,
    detached: false,
  }
}

function upsertChildMetadata(state, event) {
  const id = event.id || event.subagentId
  if (typeof id !== 'string' || !id) return state
  const previous = state.children[id] || defaultChild(id)
  const workStatus = childStatus(event.status)
  const restarting = workStatus === 'running' && childStatus(previous.status) !== 'running'
  const next = {
    ...previous,
    ...(typeof event.agent === 'string' ? { agent: event.agent } : {}),
    ...(typeof event.status === 'string' ? { status: event.status } : {}),
    ...(typeof event.index === 'number' ? { index: event.index } : {}),
    ...(event.detached !== undefined ? { detached: !!event.detached } : {}),
    ...(typeof event.description === 'string' ? { description: event.description } : {}),
    ...(typeof event.intent === 'string' ? { intent: event.intent } : {}),
    ...(typeof event.resolvedModel === 'string' ? { resolvedModel: event.resolvedModel } : {}),
    ...(typeof event.agentSource === 'string' ? { agentSource: event.agentSource } : {}),
    ...(typeof event.task === 'string' ? { task: event.task } : {}),
    ...(typeof event.assignment === 'string' ? { assignment: event.assignment } : {}),
    ...(typeof event.sessionFile === 'string' ? { sessionFile: event.sessionFile } : {}),
    ...(typeof event.parentToolCallId === 'string' ? { parentToolCallId: event.parentToolCallId } : {}),
    ...(typeof event.toolCount === 'number' ? { toolCount: event.toolCount } : {}),
    ...(typeof event.requests === 'number' ? { requests: event.requests } : {}),
    ...(typeof event.tokens === 'number' ? { tokens: event.tokens } : {}),
    ...(typeof event.durationMs === 'number' ? { durationMs: event.durationMs } : {}),
    timeline: restarting ? [] : previous.timeline,
    activeMessageId: restarting ? null : previous.activeMessageId,
    assistantText: restarting ? '' : previous.assistantText,
    assistantEnded: restarting ? false : previous.assistantEnded,
  }
  const settled = workStatus === 'success' || workStatus === 'error' || workStatus === 'cancelled'
    ? { ...next, ...settleScope(next, workStatus) }
    : next
  return {
    ...state,
    children: { ...state.children, [id]: settled },
    childOrder: state.childOrder.includes(id) ? state.childOrder : [...state.childOrder, id],
  }
}
function boundChildren(state) {
  if (state.childOrder.length <= CHILD_LIMIT) return state
  const childOrder = state.childOrder.slice(-CHILD_LIMIT)
  const children = Object.fromEntries(childOrder.map(id => [id, state.children[id]]).filter(([, child]) => child))
  return { ...state, children, childOrder }
}

export function reduceOmpMirrorState(state, event) {
  const current = state || createOmpMirrorState()
  if (!event || typeof event.type !== 'string') return current
  if (!event.subagentId && event.type === 'agent_start') {
    const childOrder = current.childOrder
      .filter(id => childStatus(current.children[id]?.status) === 'running')
      .slice(-CHILD_LIMIT)
    const children = Object.fromEntries(childOrder.map(id => [id, current.children[id]]))
    return { ...current, parent: reduceScope(current.parent, event), children, childOrder }
  }
  if (event.type === 'subagent_lifecycle' || event.type === 'subagent_progress') {
    return boundChildren(upsertChildMetadata(current, event))
  }

  const childId = typeof event.subagentId === 'string' && event.subagentId ? event.subagentId : null
  if (!childId) {
    const parent = reduceScope(current.parent, event)
    return parent === current.parent ? current : { ...current, parent }
  }

  const child = current.children[childId] || defaultChild(childId)
  const nextChild = reduceScope(child, event)
  if (nextChild === child && current.children[childId]) return current
  return boundChildren({
    ...current,
    children: { ...current.children, [childId]: { ...child, ...nextChild } },
    childOrder: current.childOrder.includes(childId) ? current.childOrder : [...current.childOrder, childId],
  })
}

export function activeOmpStep(scope) {
  if (!scope || !Array.isArray(scope.timeline)) return ''
  const running = [...scope.timeline].reverse().find(item => item.status === 'running')
  const latest = running || scope.timeline.at(-1)
  if (!latest) return ''
  if (latest.kind === 'thinking') return 'Reasoning'
  return latest.intent || latest.toolName || 'Tool'
}
export { CHILD_LIMIT as OMP_CHILD_LIMIT, WORK_LIMIT as OMP_WORK_LIMIT }
