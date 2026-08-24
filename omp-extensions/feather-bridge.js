import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const SNAPSHOT_INTERVAL_MS = 50
const BRIDGE_VERSION = 4
const MAX_LIVE_THINKING_CHARS = 3_000
const MAX_POST_BYTES = 400_000
const JSON_LIMITS = Object.freeze({
  maxDepth: 6,
  maxNodes: 500,
  maxArrayItems: 100,
  maxObjectKeys: 100,
  maxKeyBytes: 240,
  maxStringBytes: 20_000,
  maxTotalBytes: 80_000,
})
const textEncoder = new TextEncoder()
const SKIP_JSON_VALUE = Symbol('skip-json-value')
const ANSWER_EVENT_TYPES = new Set(['assistant_snapshot', 'assistant_end', 'assistant_cancel'])
const TOOL_EVENT_TYPES = new Set(['tool_execution_start', 'tool_execution_update', 'tool_execution_end'])

function byteLength(value) {
  return textEncoder.encode(value).byteLength
}

function truncateUtf8(value, maxBytes) {
  if (maxBytes <= 0) return ''
  if (byteLength(value) <= maxBytes) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (byteLength(value.slice(0, middle)) <= maxBytes) low = middle
    else high = middle - 1
  }
  return value.slice(0, low)
}

function sanitizeJson(value) {
  const state = { nodes: 0, bytes: 0, seen: new WeakSet() }

  function visit(candidate, depth) {
    if (state.nodes >= JSON_LIMITS.maxNodes || state.bytes >= JSON_LIMITS.maxTotalBytes) return SKIP_JSON_VALUE
    state.nodes += 1
    state.bytes += 8
    if (state.bytes > JSON_LIMITS.maxTotalBytes) return SKIP_JSON_VALUE

    if (candidate === null) return null
    if (typeof candidate === 'boolean') return candidate
    if (typeof candidate === 'number') return Number.isFinite(candidate) ? candidate : null
    if (typeof candidate === 'string') {
      const remaining = Math.max(0, JSON_LIMITS.maxTotalBytes - state.bytes)
      const text = truncateUtf8(candidate, Math.min(JSON_LIMITS.maxStringBytes, remaining))
      state.bytes += byteLength(text)
      return text
    }
    if (typeof candidate === 'bigint') {
      const remaining = Math.max(0, JSON_LIMITS.maxTotalBytes - state.bytes)
      const text = truncateUtf8(String(candidate), Math.min(JSON_LIMITS.maxStringBytes, remaining))
      state.bytes += byteLength(text)
      return text
    }
    if (typeof candidate !== 'object' || depth >= JSON_LIMITS.maxDepth || state.seen.has(candidate)) {
      return null
    }

    state.seen.add(candidate)
    if (Array.isArray(candidate)) {
      const result = []
      const itemCount = Math.min(candidate.length, JSON_LIMITS.maxArrayItems)
      for (let index = 0; index < itemCount; index += 1) {
        const clean = visit(candidate[index], depth + 1)
        if (clean === SKIP_JSON_VALUE) break
        result.push(clean)
      }
      state.seen.delete(candidate)
      return result
    }

    const result = Object.create(null)
    let count = 0
    for (const [rawKey, item] of Object.entries(candidate)) {
      if (count >= JSON_LIMITS.maxObjectKeys) break
      const key = truncateUtf8(rawKey, JSON_LIMITS.maxKeyBytes)
      if (!key) continue
      const keyBytes = byteLength(key)
      if (state.bytes + keyBytes > JSON_LIMITS.maxTotalBytes) break
      state.bytes += keyBytes
      const clean = visit(item, depth + 1)
      if (clean === SKIP_JSON_VALUE) break
      result[key] = clean
      count += 1
    }
    state.seen.delete(candidate)
    return result
  }

  const result = visit(value, 0)
  return result === SKIP_JSON_VALUE ? null : result
}

function assistantText(message) {
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return ''

  // Text is the only assistant content allowed across this bridge. In particular,
  // thinking and redacted-thinking blocks must never enter an event payload.
  return message.content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
}
function assistantWork(message) {
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return []
  const blocks = []
  let remainingThinkingChars = MAX_LIVE_THINKING_CHARS
  const parts = message.content.slice(0, 40)
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index]
    if (part?.type === 'thinking' && typeof part.thinking === 'string' && part.thinking && remainingThinkingChars > 0) {
      const thinking = part.thinking.slice(-remainingThinkingChars)
      remainingThinkingChars -= thinking.length
      blocks.unshift({ type: 'thinking', thinking })
    } else if (part?.type === 'toolCall') {
      blocks.unshift({
        type: 'tool_use',
        id: typeof part.id === 'string' ? part.id.slice(0, 128) : '',
        name: typeof part.name === 'string' && part.name.trim() ? part.name.slice(0, 80) : 'tool',
        ...(typeof part.intent === 'string' ? { intent: part.intent.slice(0, 300) } : {}),
      })
    }
  }
  return blocks
}

function hasToolCall(message) {
  return message?.role === 'assistant' &&
    Array.isArray(message.content) &&
    message.content.some((part) => part?.type === 'toolCall')
}

function bridgeConfig(env, argv = process.argv) {
  const sessionDirIndex = argv.indexOf('--session-dir')
  const sessionDir = sessionDirIndex >= 0 ? argv[sessionDirIndex + 1] : null
  const url = env.FEATHER_BRIDGE_URL?.trim()
  const token = env.FEATHER_BRIDGE_TOKEN?.trim()
  const sessionId = env.FEATHER_SESSION_ID?.trim()
  if (url && token && sessionId) return { url, token, sessionId, sessionDir }

  if (!sessionDir) return null
  try {
    const stored = JSON.parse(readFileSync(path.join(sessionDir, '.feather-bridge.json'), 'utf8'))
    return typeof stored?.url === 'string' && typeof stored?.token === 'string' && typeof stored?.sessionId === 'string'
      ? { url: stored.url, token: stored.token, sessionId: stored.sessionId, sessionDir }
      : null
  } catch {
    return null
  }
}

function todoDetails(message, subagentId) {
  if (message?.role !== 'toolResult' || message.toolName !== 'todo' || !message.details || !Array.isArray(message.details.phases)) return null
  const phases = message.details.phases.slice(0, 30).map((phase) => ({
    name: typeof phase?.name === 'string' ? phase.name.slice(0, 120) : '',
    tasks: Array.isArray(phase?.tasks) ? phase.tasks.slice(0, 200).map((task) => ({
      content: typeof task?.content === 'string' ? task.content.slice(0, 500) : '',
      status: typeof task?.status === 'string' ? task.status : 'pending',
      ...(typeof task?.blocker === 'string' ? { blocker: task.blocker.slice(0, 300) } : {}),
    })).filter((task) => task.content) : [],
  })).filter((phase) => phase.name)
  return {
    type: 'todo',
    phases,
    ...(typeof message.details.op === 'string' ? { op: message.details.op.slice(0, 20) } : {}),
    isError: !!message.isError,
    ...(subagentId ? { subagentId } : {}),
  }
}

function latestTodoFromBranch(sessionManager) {
  const branch = sessionManager?.getBranch?.()
  if (!Array.isArray(branch)) return null
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const todo = todoDetails(branch[index]?.type === 'message' ? branch[index].message : null)
    if (todo) return todo
  }
  return null
}

function toolBridgeEvent(event, subagentId) {
  if (!event || !TOOL_EVENT_TYPES.has(event.type)) return null
  const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId.slice(0, 128) : ''
  const toolName = typeof event.toolName === 'string' && event.toolName.trim() ? event.toolName.slice(0, 80) : ''
  if (!toolCallId || !toolName) return null
  return {
    type: event.type,
    toolCallId,
    toolName,
    ...(event.type !== 'tool_execution_end' && event.args !== undefined ? { args: sanitizeJson(event.args) } : {}),
    ...(typeof event.intent === 'string' ? { intent: event.intent.slice(0, 300) } : {}),
    ...(event.type === 'tool_execution_update' && event.partialResult !== undefined
      ? { partialResult: sanitizeJson(event.partialResult) }
      : {}),
    ...(event.type === 'tool_execution_end' && event.result !== undefined ? { result: sanitizeJson(event.result) } : {}),
    ...(event.type === 'tool_execution_end' ? { isError: !!event.isError } : {}),
    ...(subagentId ? { subagentId } : {}),
  }
}

function asyncJobs(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.running) || !Array.isArray(snapshot.recent)) return null
  const clean = (job) => ({
    id: typeof job?.id === 'string' ? job.id.slice(0, 120) : '',
    type: typeof job?.type === 'string' ? job.type : 'job',
    status: typeof job?.status === 'string' ? job.status : 'running',
    startTime: typeof job?.startTime === 'number' ? job.startTime : 0,
    ...(job?.type === 'task' && typeof job?.label === 'string' ? { label: job.label.slice(0, 160) } : {}),
  })
  return {
    type: 'async_jobs',
    running: snapshot.running.slice(0, 30).map(clean).filter((job) => job.id),
    recent: snapshot.recent.slice(0, 20).map(clean).filter((job) => job.id),
    delivery: {
      queued: Number.isSafeInteger(snapshot.delivery?.queued) ? snapshot.delivery.queued : 0,
      delivering: !!snapshot.delivery?.delivering,
    },
  }
}

export default function featherBridgeExtension(pi) {
  // Read configuration when OMP constructs the extension, not when the module is
  // imported. This keeps each runtime bound to its own session environment.
  const config = bridgeConfig(process.env)
  let enabled = !!config && !config.sessionDir
  let activeMessage = null
  const childMessages = new Map()
  const pendingTimers = new Set()
  const unsubscribe = []
  const pendingEvents = []
  let delivering = false
  let deliveryController = null
  let shuttingDown = false
  let runtimeTimer = null
  let lastRuntimeState = ''
  let richEventsEnabled = true
  let lastJobs = ''

  function logDeliveryFailure(error) {
    try {
      pi.logger.warn('Feather bridge delivery failed', {
        sessionId: config?.sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    } catch {
      // Logging must not turn a best-effort bridge failure into a session failure.
    }
  }

  function coalesceKey(event) {
    const owner = event.subagentId || 'parent'
    if (event.type === 'assistant_snapshot' || event.type === 'work_snapshot') return `${event.type}:${owner}:${event.messageId}`
    if (event.type.startsWith('tool_execution_')) return `tool:${owner}:${event.toolCallId}`
    if (event.type === 'subagent_progress' || event.type === 'subagent_lifecycle') return `subagent:${event.id}`
    if (event.type === 'session_state' || event.type === 'async_jobs') return event.type
    if (event.type === 'todo') return `${event.type}:${owner}`
    return null
  }

  function enqueue(event) {
    const key = coalesceKey(event)
    if (key) {
      const index = pendingEvents.findLastIndex(candidate => coalesceKey(candidate) === key)
      if (index >= 0) {
        const previous = pendingEvents[index]
        const mergePrevious = event.type.startsWith('tool_execution_')
          || event.type === 'subagent_progress'
          || event.type === 'subagent_lifecycle'
        pendingEvents[index] = mergePrevious ? { ...previous, ...event, type: event.type } : event
        return
      }
    }
    pendingEvents.push(event)
    if (pendingEvents.length <= 200) return
    const replaceable = pendingEvents.findIndex(candidate => coalesceKey(candidate))
    pendingEvents.splice(replaceable >= 0 ? replaceable : 0, 1)
  }

  function takeDeliveryBatch() {
    const events = []
    let bytes = 32
    while (pendingEvents.length > 0 && events.length < 50) {
      const candidate = pendingEvents[0]
      const candidateBytes = textEncoder.encode(JSON.stringify(candidate)).byteLength + 1
      if (candidateBytes > MAX_POST_BYTES) {
        pendingEvents.shift()
        logDeliveryFailure(new Error(`Feather bridge event exceeds ${MAX_POST_BYTES} bytes`))
        continue
      }
      if (events.length > 0 && bytes + candidateBytes > MAX_POST_BYTES) break
      pendingEvents.shift()
      events.push(candidate)
      bytes += candidateBytes
    }
    return events
  }

  async function deliver() {
    if (!config || delivering || shuttingDown) return
    delivering = true
    try {
      while (pendingEvents.length > 0 && !shuttingDown) {
        const events = takeDeliveryBatch()
        if (events.length === 0) continue
        deliveryController = new AbortController()
        const timeoutSignal = AbortSignal.timeout?.(5_000)
        const signal = timeoutSignal && AbortSignal.any
          ? AbortSignal.any([deliveryController.signal, timeoutSignal])
          : deliveryController.signal
        try {
          const response = await globalThis.fetch(config.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Feather-Bridge-Token': config.token,
            },
            body: JSON.stringify({ version: BRIDGE_VERSION, events }),
            signal,
          })
          if (!response.ok) {
            if (response.status === 400 && events.every(event => !ANSWER_EVENT_TYPES.has(event.type))) {
              richEventsEnabled = false
              for (let index = pendingEvents.length - 1; index >= 0; index -= 1) {
                if (!ANSWER_EVENT_TYPES.has(pendingEvents[index].type)) pendingEvents.splice(index, 1)
              }
              continue
            }
            throw new Error(`HTTP ${response.status ?? 'error'}`)
          }
        } catch (error) {
          if (!shuttingDown) logDeliveryFailure(error)
        } finally {
          deliveryController = null
        }
      }
    } finally {
      delivering = false
    }
  }

  function post(events) {
    if (!config || !enabled || events.length === 0 || shuttingDown) return
    for (const event of events) {
      if (ANSWER_EVENT_TYPES.has(event.type) || richEventsEnabled) enqueue(event)
    }
    void deliver()
  }
  function postChanged(event, previous, setPrevious) {
    if (!event) return
    const serialized = JSON.stringify(event)
    if (serialized === previous) return
    setPrevious(serialized)
    post([event])
  }

  function emitRuntimeState(ctx) {
    const model = ctx.model || ctx.models?.current?.()
    const usage = ctx.getContextUsage?.()
    const serviceTiers = {}
    for (const [family, tier] of Object.entries(pi.getServiceTiers?.() || {})) {
      if (typeof tier === 'string' || tier === null) serviceTiers[family] = tier
    }
    const thinkingLevel = pi.getThinkingLevel?.()
    if (!model && !usage && typeof thinkingLevel !== 'string' && Object.keys(serviceTiers).length === 0) return
    const event = {
      type: 'session_state',
      ...(typeof model?.provider === 'string' ? { modelProvider: model.provider } : {}),
      ...(typeof model?.id === 'string' ? { modelId: model.id } : {}),
      ...(typeof model?.api === 'string' ? { modelApi: model.api } : {}),
      ...(typeof thinkingLevel === 'string' ? { thinkingLevel } : {}),
      serviceTiers,
      ...(Number.isFinite(usage?.tokens) ? { contextTokens: usage.tokens } : {}),
      ...(Number.isFinite(usage?.contextWindow) ? { contextWindow: usage.contextWindow } : {}),
      ...(Number.isFinite(usage?.percent) ? { contextPercent: usage.percent } : {}),
    }
    postChanged(event, lastRuntimeState, (value) => { lastRuntimeState = value })
  }

  function emitJobs(ctx) {
    const event = asyncJobs(ctx.getAsyncJobSnapshot?.())
    postChanged(event, lastJobs, (value) => { lastJobs = value })
  }


  function createMessageState(message, subagentId) {
    const work = assistantWork(message)
    return {
      messageId: randomUUID(),
      text: assistantText(message),
      work,
      latestMessage: message,
      lastSnapshot: null,
      lastWorkJson: work.length > 0 ? null : '[]',
      terminalType: null,
      willContinue: false,
      timer: null,
      subagentId,
    }
  }

  function flushMessage(state) {
    const owner = state.subagentId ? { subagentId: state.subagentId } : {}
    const answerEvents = []
    if (state.lastSnapshot !== state.text) {
      answerEvents.push({
        type: 'assistant_snapshot',
        messageId: state.messageId,
        text: state.text,
        ...owner,
      })
      state.lastSnapshot = state.text
    }

    const workJson = JSON.stringify(state.work)
    if (state.lastWorkJson !== workJson) {
      post([{
        type: 'work_snapshot',
        messageId: state.messageId,
        blocks: state.work,
        ...owner,
      }])
      state.lastWorkJson = workJson
    }

    if (state.terminalType) {
      answerEvents.push({
        type: state.terminalType,
        messageId: state.messageId,
        ...(state.willContinue ? { willContinue: true } : {}),
        ...owner,
      })
      if (state.subagentId) childMessages.delete(state.subagentId)
      else if (activeMessage === state) activeMessage = null
    }

    post(answerEvents)
  }

  function scheduleSnapshot(state, ctx) {
    if (!config || state.timer) return

    // Every snapshot passes through this single 50 ms gate. Updates replace
    // state.text while the timer is pending, so snapshots are full replacements
    // and can never be emitted more than 20 times per second.
    let timer
    timer = ctx.setTimeout(() => {
      pendingTimers.delete(timer)
      state.timer = null
      state.text = assistantText(state.latestMessage)
      state.work = assistantWork(state.latestMessage)
      flushMessage(state)
    }, SNAPSHOT_INTERVAL_MS)
    state.timer = timer
    pendingTimers.add(timer)
  }

  pi.on('message_start', (event) => {
    if (event.message?.role !== 'assistant') return
    activeMessage = createMessageState(event.message)
  })

  pi.on('message_update', (event, ctx) => {
    if (event.message?.role !== 'assistant' || !activeMessage) return

    activeMessage.latestMessage = event.message
    scheduleSnapshot(activeMessage, ctx)
  })

  pi.on('message_end', (event, ctx) => {
    const todo = todoDetails(event.message)
    if (todo) post([todo])
    emitRuntimeState(ctx)
    emitJobs(ctx)
    if (event.message?.role !== 'assistant' || !activeMessage) return

    const state = activeMessage
    state.latestMessage = event.message
    state.text = assistantText(event.message)
    state.work = assistantWork(event.message)
    const aborted = event.message.stopReason === 'aborted'
    const toolSegment = hasToolCall(event.message)
    state.terminalType = aborted || toolSegment ? 'assistant_cancel' : 'assistant_end'
    state.willContinue = toolSegment && !aborted

    if (state.timer) return
    if (state.lastSnapshot === state.text) {
      flushMessage(state)
    } else {
      scheduleSnapshot(state, ctx)
    }
  })

  for (const eventName of ['tool_execution_start', 'tool_execution_update', 'tool_execution_end']) {
    pi.on(eventName, (event) => {
      const clean = toolBridgeEvent(event)
      if (clean) post([clean])
    })
  }

  function handleChildEvent(payload) {
    const subagentId = typeof payload?.id === 'string' ? payload.id.slice(0, 128) : ''
    const event = payload?.event
    if (!subagentId || !event || typeof event !== 'object') return

    if (event.type === 'message_start' && event.message?.role === 'assistant') {
      childMessages.set(subagentId, createMessageState(event.message, subagentId))
      return
    }
    if (event.type === 'message_update' && event.message?.role === 'assistant') {
      const state = childMessages.get(subagentId)
      if (!state) return
      state.latestMessage = event.message
      state.text = assistantText(event.message)
      state.work = assistantWork(event.message)
      flushMessage(state)
      return
    }
    if (event.type === 'message_end') {
      const todo = todoDetails(event.message, subagentId)
      if (todo) post([todo])
      if (event.message?.role !== 'assistant') return
      const state = childMessages.get(subagentId) || createMessageState(event.message, subagentId)
      state.latestMessage = event.message
      state.text = assistantText(event.message)
      state.work = assistantWork(event.message)
      const aborted = event.message.stopReason === 'aborted'
      const toolSegment = hasToolCall(event.message)
      state.terminalType = aborted || toolSegment ? 'assistant_cancel' : 'assistant_end'
      state.willContinue = toolSegment && !aborted
      flushMessage(state)
      return
    }
    const toolEvent = toolBridgeEvent(event, subagentId)
    if (toolEvent) post([toolEvent])
  }

  // Lifecycle payloads are explicit scalar allowlists. Never spread an OMP
  // event: agent messages, compaction results, retry arrays, and tool data may
  // contain private model content or nested provider payloads.
  const lifecycleHandlers = {
    auto_retry_start: (event) => ({
      type: event.type,
      attempt: event.attempt,
      maxAttempts: event.maxAttempts,
      delayMs: event.delayMs,
      errorMessage: event.errorMessage,
      ...(event.errorId === undefined ? {} : { errorId: event.errorId }),
    }),
    auto_retry_end: (event) => ({
      type: event.type,
      success: event.success,
      attempt: event.attempt,
      ...(event.finalError === undefined ? {} : { finalError: event.finalError }),
    }),
    auto_compaction_start: (event) => ({
      type: event.type,
      reason: event.reason,
      action: event.action,
    }),
    auto_compaction_end: (event) => ({
      type: event.type,
      action: event.action,
      aborted: event.aborted,
      willRetry: event.willRetry,
      ...(event.errorMessage === undefined ? {} : { errorMessage: event.errorMessage }),
      ...(event.skipped === undefined ? {} : { skipped: event.skipped }),
    }),
    credential_disabled: (event) => ({
      type: event.type,
      provider: event.provider,
    }),
    agent_start: (event) => ({ type: event.type }),
    agent_end: (event) => ({
      type: event.type,
      ...(event.willContinue === undefined ? {} : { willContinue: event.willContinue }),
    }),
  }

  for (const [eventName, toBridgeEvent] of Object.entries(lifecycleHandlers)) {
    pi.on(eventName, (event) => post([toBridgeEvent(event)]))
  }

  pi.on('tool_approval_requested', (event) => post([{
    type: event.type,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    approvalMode: event.approvalMode,
    ...(typeof event.reason === 'string' ? { reason: event.reason.slice(0, 500) } : {}),
  }]))

  pi.on('tool_approval_resolved', (event) => post([{
    type: event.type,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    approved: event.approved,
    ...(typeof event.reason === 'string' ? { reason: event.reason.slice(0, 500) } : {}),
  }]))

  const taskEvents = pi.events
  if (taskEvents?.on) {
    const metadata = (event) => ({
      ...(typeof event.agentSource === 'string' ? { agentSource: event.agentSource.slice(0, 20) } : {}),
      ...(typeof event.task === 'string' ? { task: event.task.slice(0, 2_000) } : {}),
      ...(typeof event.assignment === 'string' ? { assignment: event.assignment.slice(0, 1_000) } : {}),
      ...(typeof event.sessionFile === 'string' ? { sessionFile: event.sessionFile.slice(0, 1_000) } : {}),
      ...(typeof event.parentToolCallId === 'string' ? { parentToolCallId: event.parentToolCallId.slice(0, 128) } : {}),
    })
    unsubscribe.push(taskEvents.on('task:subagent:lifecycle', (event) => post([{
      type: 'subagent_lifecycle',
      id: event.id,
      agent: event.agent,
      status: event.status,
      index: event.index,
      detached: !!event.detached,
      ...metadata(event),
      ...(typeof event.description === 'string' ? { description: event.description.slice(0, 300) } : {}),
    }])))
    unsubscribe.push(taskEvents.on('task:subagent:progress', (event) => post([{
      type: 'subagent_progress',
      id: event.progress?.id,
      agent: event.agent,
      status: event.progress?.status,
      index: event.index,
      detached: !!event.detached,
      ...metadata(event),
      toolCount: event.progress?.toolCount,
      requests: event.progress?.requests,
      tokens: event.progress?.tokens,
      durationMs: event.progress?.durationMs,
      ...(typeof event.progress?.description === 'string' ? { description: event.progress.description.slice(0, 300) } : {}),
      ...(typeof event.progress?.lastIntent === 'string' ? { intent: event.progress.lastIntent.slice(0, 300) } : {}),
      ...(typeof event.progress?.resolvedModel === 'string' ? { resolvedModel: event.progress.resolvedModel.slice(0, 160) } : {}),
      ...(Number.isFinite(event.progress?.contextTokens) ? { contextTokens: event.progress.contextTokens } : {}),
      ...(Number.isFinite(event.progress?.contextWindow) ? { contextWindow: event.progress.contextWindow } : {}),
    }])))
    unsubscribe.push(taskEvents.on('task:subagent:event', handleChildEvent))
  }

  pi.on('session_start', (_event, ctx) => {
    if (config?.sessionDir) {
      const sessionFile = ctx.sessionManager?.getSessionFile?.()
      enabled = !!sessionFile && path.dirname(path.resolve(sessionFile)) === path.resolve(config.sessionDir)
    }
    if (!enabled) return
    const todo = latestTodoFromBranch(ctx.sessionManager)
    if (todo) post([todo])
    emitRuntimeState(ctx)
    emitJobs(ctx)
    runtimeTimer = ctx.setInterval(() => {
      emitRuntimeState(ctx)
      emitJobs(ctx)
    }, 2_000)
  })

  pi.on('context', (_event, ctx) => emitRuntimeState(ctx))

  pi.on('session_shutdown', (_event, ctx) => {
    shuttingDown = true
    deliveryController?.abort()
    pendingEvents.length = 0
    for (const timer of pendingTimers) ctx.clearTimer(timer)
    pendingTimers.clear()
    if (runtimeTimer) ctx.clearTimer(runtimeTimer)
    runtimeTimer = null
    for (const stop of unsubscribe) stop()
    activeMessage = null
    childMessages.clear()
  })
}
