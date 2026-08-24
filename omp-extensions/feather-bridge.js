import { randomUUID } from 'node:crypto'

const SNAPSHOT_INTERVAL_MS = 50

function assistantText(message) {
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return ''

  // Text is the only assistant content allowed across this bridge. In particular,
  // thinking and redacted-thinking blocks must never enter an event payload.
  return message.content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
}

function hasToolCall(message) {
  return message?.role === 'assistant' &&
    Array.isArray(message.content) &&
    message.content.some((part) => part?.type === 'toolCall')
}

function bridgeConfig(env) {
  const url = env.FEATHER_BRIDGE_URL?.trim()
  const token = env.FEATHER_BRIDGE_TOKEN?.trim()
  const sessionId = env.FEATHER_SESSION_ID?.trim()
  return url && token && sessionId ? { url, token, sessionId } : null
}

function todoDetails(message) {
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
    ...(typeof message.details.op === 'string' ? { op: message.details.op } : {}),
    isError: !!message.isError,
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
  let activeMessage = null
  const pendingTimers = new Set()
  const unsubscribe = []
  const pendingEvents = []
  let delivering = false
  let deliveryController = null
  let shuttingDown = false
  let runtimeTimer = null
  let lastRuntimeState = ''
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
    if (event.type === 'assistant_snapshot') return `${event.type}:${event.messageId}`
    if (event.type === 'subagent_progress') return `${event.type}:${event.id}`
    if (event.type === 'session_state' || event.type === 'async_jobs' || event.type === 'todo') return event.type
    return null
  }

  function enqueue(event) {
    const key = coalesceKey(event)
    if (key) {
      const index = pendingEvents.findLastIndex(candidate => coalesceKey(candidate) === key)
      if (index >= 0) {
        pendingEvents[index] = event
        return
      }
    }
    pendingEvents.push(event)
    if (pendingEvents.length <= 200) return
    const replaceable = pendingEvents.findIndex(candidate => coalesceKey(candidate))
    pendingEvents.splice(replaceable >= 0 ? replaceable : 0, 1)
  }

  async function deliver() {
    if (!config || delivering || shuttingDown) return
    delivering = true
    try {
      while (pendingEvents.length > 0 && !shuttingDown) {
        const events = pendingEvents.splice(0, 50)
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
            body: JSON.stringify({ events }),
            signal,
          })
          if (!response.ok) throw new Error(`HTTP ${response.status ?? 'error'}`)
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
    if (!config || events.length === 0 || shuttingDown) return
    for (const event of events) enqueue(event)
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


  function flushMessage(state) {
    const events = []
    if (state.lastSnapshot !== state.text) {
      events.push({
        type: 'assistant_snapshot',
        messageId: state.messageId,
        text: state.text,
      })
      state.lastSnapshot = state.text
    }

    if (state.terminalType) {
      events.push({
        type: state.terminalType,
        messageId: state.messageId,
      })
      if (activeMessage === state) activeMessage = null
    }

    post(events)
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
      flushMessage(state)
    }, SNAPSHOT_INTERVAL_MS)
    state.timer = timer
    pendingTimers.add(timer)
  }

  pi.on('message_start', (event) => {
    if (event.message?.role !== 'assistant') return

    activeMessage = {
      messageId: randomUUID(),
      text: assistantText(event.message),
      latestMessage: event.message,
      lastSnapshot: null,
      terminalType: null,
      timer: null,
    }
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
    state.terminalType = event.message.stopReason === 'aborted' || hasToolCall(event.message)
      ? 'assistant_cancel'
      : 'assistant_end'

    if (state.timer) return
    if (state.lastSnapshot === state.text) {
      flushMessage(state)
    } else {
      scheduleSnapshot(state, ctx)
    }
  })

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
    unsubscribe.push(taskEvents.on('task:subagent:lifecycle', (event) => post([{
      type: 'subagent_lifecycle',
      id: event.id,
      agent: event.agent,
      status: event.status,
      index: event.index,
      detached: !!event.detached,
      ...(typeof event.description === 'string' ? { description: event.description.slice(0, 300) } : {}),
    }])))
    unsubscribe.push(taskEvents.on('task:subagent:progress', (event) => post([{
      type: 'subagent_progress',
      id: event.progress?.id,
      agent: event.agent,
      status: event.progress?.status,
      index: event.index,
      detached: !!event.detached,
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
  }

  pi.on('session_start', (_event, ctx) => {
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
  })
}
