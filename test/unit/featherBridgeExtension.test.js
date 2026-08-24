import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import featherBridgeExtension from '../../omp-extensions/feather-bridge.js'

const BRIDGE_URL = 'http://feather.test/api/internal/sessions/session-1/events'

function createHarness() {
  const handlers = new Map()
  const timers = []
  const warnings = []
  const eventBusHandlers = new Map()
  const intervals = []

  const pi = {
    on(eventName, handler) {
      handlers.set(eventName, handler)
    },
    events: {
      on(channel, handler) {
        eventBusHandlers.set(channel, handler)
        return () => eventBusHandlers.delete(channel)
      },
    },
    getThinkingLevel() {
      return pi.thinkingLevel
    },
    getServiceTiers() {
      return pi.serviceTiers || {}
    },
    logger: {
      warn(...args) {
        warnings.push(args)
      },
    },
  }

  const ctx = {
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false }
      timers.push(timer)
      return timer
    },
    setInterval(callback, delay) {
      const timer = { callback, delay, cleared: false }
      intervals.push(timer)
      return timer
    },
    clearTimer(timer) {
      timer.cleared = true
    },
    getContextUsage() {
      return ctx.contextUsage
    },
    getAsyncJobSnapshot() {
      return ctx.jobs || null
    },
  }

  return {
    pi,
    warnings,
    timers,
    emit(eventName, event) {
      const handler = handlers.get(eventName)
      assert.ok(handler, `missing ${eventName} handler`)
      return handler(event, ctx)
    },
    emitBus(channel, event) {
      const handler = eventBusHandlers.get(channel)
      assert.ok(handler, `missing ${channel} handler`)
      return handler(event)
    },
    ctx,
    intervals,
    runNextTimer() {
      const timer = timers.find((candidate) => !candidate.cleared && !candidate.ran)
      assert.ok(timer, 'expected a pending timer')
      timer.ran = true
      timer.callback()
      return timer
    },
  }
}

function installRuntime(t, fetchImpl) {
  const previous = {
    url: process.env.FEATHER_BRIDGE_URL,
    token: process.env.FEATHER_BRIDGE_TOKEN,
    sessionId: process.env.FEATHER_SESSION_ID,
  }

  process.env.FEATHER_BRIDGE_URL = BRIDGE_URL
  process.env.FEATHER_BRIDGE_TOKEN = 'bridge-secret'
  process.env.FEATHER_SESSION_ID = 'session-1'
  t.mock.method(globalThis, 'fetch', fetchImpl)
  t.after(() => {
    restoreEnv('FEATHER_BRIDGE_URL', previous.url)
    restoreEnv('FEATHER_BRIDGE_TOKEN', previous.token)
    restoreEnv('FEATHER_SESSION_ID', previous.sessionId)
  })
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function assistant(content) {
  return { role: 'assistant', content }
}

function parseRequest(url, options) {
  return { url, options, body: JSON.parse(options.body) }
}

async function settleDeliveryQueue() {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('Feather OMP bridge extension', () => {
  it('loads per-session bridge config when OMP strips launch environment variables', async (t) => {
    const previousEnv = {
      url: process.env.FEATHER_BRIDGE_URL,
      token: process.env.FEATHER_BRIDGE_TOKEN,
      sessionId: process.env.FEATHER_SESSION_ID,
    }
    const previousArgv = [...process.argv]
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-bridge-config-'))
    fs.writeFileSync(path.join(sessionDir, '.feather-bridge.json'), JSON.stringify({
      url: BRIDGE_URL, token: 'stored-secret', sessionId: 'session-1',
    }))
    delete process.env.FEATHER_BRIDGE_URL
    delete process.env.FEATHER_BRIDGE_TOKEN
    delete process.env.FEATHER_SESSION_ID
    process.argv.push('--session-dir', sessionDir)
    const requests = []
    t.mock.method(globalThis, 'fetch', async (...args) => {
      requests.push(parseRequest(...args))
      return { ok: true, status: 200 }
    })
    t.after(() => {
      restoreEnv('FEATHER_BRIDGE_URL', previousEnv.url)
      restoreEnv('FEATHER_BRIDGE_TOKEN', previousEnv.token)
      restoreEnv('FEATHER_SESSION_ID', previousEnv.sessionId)
      process.argv.splice(0, process.argv.length, ...previousArgv)
      fs.rmSync(sessionDir, { recursive: true, force: true })
    })

    const harness = createHarness()
    featherBridgeExtension(harness.pi)
    harness.emit('agent_start', { type: 'agent_start' })
    await settleDeliveryQueue()

    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, BRIDGE_URL)
    assert.equal(requests[0].options.headers['X-Feather-Bridge-Token'], 'stored-secret')
  })

  it('sends throttled full-text snapshots without leaking thinking', async (t) => {
    const requests = []
    installRuntime(t, async (...args) => {
      requests.push(parseRequest(...args))
      return { ok: true, status: 200 }
    })
    const harness = createHarness()
    featherBridgeExtension(harness.pi)

    harness.emit('message_start', {
      type: 'message_start',
      message: assistant([
        { type: 'thinking', thinking: 'private chain of thought' },
        { type: 'text', text: 'Hel' },
      ]),
    })
    harness.emit('message_update', {
      type: 'message_update',
      message: assistant([
        { type: 'thinking', thinking: 'still private' },
        { type: 'text', text: 'Hel' },
      ]),
    })

    assert.equal(requests.length, 0, 'streaming handlers must not wait for or immediately perform HTTP')
    const firstTimer = harness.runNextTimer()
    assert.equal(firstTimer.delay, 50)
    await settleDeliveryQueue()

    harness.emit('message_update', {
      type: 'message_update',
      message: assistant([
        { type: 'text', text: 'Hello' },
        { type: 'thinking', thinking: 'never send me' },
      ]),
    })
    harness.runNextTimer()
    await settleDeliveryQueue()

    harness.emit('message_end', {
      type: 'message_end',
      message: assistant([
        { type: 'thinking', thinking: 'final hidden thought' },
        { type: 'text', text: 'Hello' },
      ]),
    })
    await settleDeliveryQueue()

    const events = requests.flatMap((request) => request.body.events)
    assert.deepEqual(events.map((event) => [event.type, event.text]), [
      ['assistant_snapshot', 'Hel'],
      ['assistant_snapshot', 'Hello'],
      ['assistant_end', undefined],
    ])
    assert.equal(new Set(events.map((event) => event.messageId)).size, 1)
    assert.equal(JSON.stringify(requests).includes('private'), false)
    assert.equal(JSON.stringify(requests).includes('hidden thought'), false)
    assert.equal(requests[0].url, BRIDGE_URL)
    assert.equal(requests[0].options.headers['X-Feather-Bridge-Token'], 'bridge-secret')
    assert.deepEqual(Object.keys(requests[0].body), ['events'])
    assert.equal('sessionId' in events[0], false)
  })

  it('ends text-only messages and cancels messages containing any tool call', async (t) => {
    const requests = []
    installRuntime(t, async (...args) => {
      requests.push(parseRequest(...args))
      return { ok: true, status: 200 }
    })
    const harness = createHarness()
    featherBridgeExtension(harness.pi)

    const finish = async (content) => {
      const message = assistant(content)
      harness.emit('message_start', { type: 'message_start', message })
      harness.emit('message_end', { type: 'message_end', message })
      harness.runNextTimer()
      await settleDeliveryQueue()
    }

    await finish([{ type: 'text', text: 'Done' }])
    await finish([
      { type: 'thinking', thinking: 'tool rationale' },
      { type: 'text', text: 'I will inspect it.' },
      { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'secret' } },
    ])

    const events = requests.flatMap((request) => request.body.events)
    assert.deepEqual(events.map((event) => event.type), [
      'assistant_snapshot',
      'assistant_end',
      'assistant_snapshot',
      'assistant_cancel',
    ])
    assert.equal(events[0].messageId, events[1].messageId)
    assert.equal(events[2].messageId, events[3].messageId)
    assert.notEqual(events[0].messageId, events[2].messageId)
    assert.equal(JSON.stringify(events).includes('tool rationale'), false)
    assert.equal(JSON.stringify(events).includes('call-1'), false)
  })

  it('coalesces unsent assistant snapshots behind a slow delivery', async (t) => {
    let releaseFirst
    const firstDelivery = new Promise(resolve => { releaseFirst = resolve })
    const requests = []
    installRuntime(t, (...args) => {
      requests.push(parseRequest(...args))
      return requests.length === 1 ? firstDelivery : Promise.resolve({ ok: true, status: 200 })
    })
    const harness = createHarness()
    featherBridgeExtension(harness.pi)

    harness.emit('agent_start', { type: 'agent_start' })
    const first = assistant([{ type: 'text', text: 'First snapshot' }])
    harness.emit('message_start', { type: 'message_start', message: first })
    harness.emit('message_update', { type: 'message_update', message: first })
    harness.runNextTimer()
    const latest = assistant([{ type: 'text', text: 'Latest snapshot' }])
    harness.emit('message_update', { type: 'message_update', message: latest })
    harness.runNextTimer()
    harness.emit('message_end', { type: 'message_end', message: latest })

    assert.equal(requests.length, 1)
    releaseFirst({ ok: true, status: 200 })
    await settleDeliveryQueue()
    await settleDeliveryQueue()

    assert.equal(requests.length, 2)
    assert.deepEqual(requests[1].body.events, [
      { type: 'assistant_snapshot', messageId: requests[1].body.events[0].messageId, text: 'Latest snapshot' },
      { type: 'assistant_end', messageId: requests[1].body.events[0].messageId },
    ])
    assert.equal(JSON.stringify(requests).includes('First snapshot'), false)
  })

  it('serializes posts and recovers after a rejected delivery', async (t) => {
    let rejectFirst
    const firstDelivery = new Promise((_resolve, reject) => { rejectFirst = reject })
    const requests = []
    installRuntime(t, (...args) => {
      requests.push(parseRequest(...args))
      if (requests.length === 1) return firstDelivery
      return Promise.resolve({ ok: true, status: 200 })
    })
    const harness = createHarness()
    featherBridgeExtension(harness.pi)

    assert.equal(harness.emit('agent_start', { type: 'agent_start' }), undefined)
    await settleDeliveryQueue()
    assert.equal(harness.emit('credential_disabled', {
      type: 'credential_disabled',
      provider: 'anthropic',
      disabledCause: 'invalid_grant',
    }), undefined)
    await settleDeliveryQueue()
    assert.equal(requests.length, 1, 'the second POST must wait for the first POST')

    rejectFirst(new Error('bridge unavailable'))
    await settleDeliveryQueue()
    assert.equal(requests.length, 2)
    assert.equal(harness.warnings.length, 1)
    assert.match(harness.warnings[0][1].error, /bridge unavailable/)

    harness.emit('auto_retry_start', {
      type: 'auto_retry_start',
      attempt: 2,
      maxAttempts: 4,
      delayMs: 500,
      errorMessage: 'rate limited',
      errorId: 429,
    })
    await settleDeliveryQueue()
    assert.equal(requests.length, 3, 'a failed POST must not poison later deliveries')
    assert.deepEqual(requests[2].body.events, [{
      type: 'auto_retry_start',
      attempt: 2,
      maxAttempts: 4,
      delayMs: 500,
      errorMessage: 'rate limited',
      errorId: 429,
    }])
  })

  it('forwards native Todo, approval, subagent, job, and runtime state safely', async (t) => {
    const requests = []
    installRuntime(t, async (...args) => {
      requests.push(parseRequest(...args))
      return { ok: true, status: 200 }
    })
    const harness = createHarness()
    harness.pi.thinkingLevel = 'high'
    harness.pi.serviceTiers = { openai: 'priority' }
    harness.ctx.model = { provider: 'openai', id: 'gpt-5.6', api: 'responses' }
    harness.ctx.contextUsage = { tokens: 42_000, contextWindow: 200_000, percent: 21 }
    harness.ctx.jobs = {
      running: [{ id: 'bash-1', type: 'bash', status: 'running', label: 'secret command', startTime: 100 }],
      recent: [{ id: 'task-1', type: 'task', status: 'completed', label: 'Review bridge', startTime: 50 }],
      delivery: { queued: 1, delivering: 0 },
    }
    featherBridgeExtension(harness.pi)

    harness.emit('message_end', {
      type: 'message_end',
      message: {
        role: 'toolResult',
        toolName: 'todo',
        isError: false,
        details: { phases: [{ name: 'Build', tasks: [{ content: 'Wire bridge', status: 'in_progress' }] }], op: 'init' },
      },
    })
    harness.emit('tool_approval_requested', {
      type: 'tool_approval_requested',
      toolCallId: 'call-approval',
      toolName: 'write',
      approvalMode: 'write',
      reason: 'mutates a file',
    })
    harness.emitBus('task:subagent:progress', {
      index: 0,
      agent: 'scout',
      detached: true,
      progress: {
        id: 'agent-1',
        status: 'running',
        description: 'Map events',
        lastIntent: 'Reading event contracts',
        currentToolArgs: 'private nested arguments',
        toolCount: 3,
        requests: 2,
        tokens: 900,
        durationMs: 1200,
        resolvedModel: 'openai/gpt-5.6',
      },
    })
    harness.emit('session_start', { type: 'session_start' })
    await settleDeliveryQueue()

    const events = requests.flatMap(request => request.body.events)
    assert.ok(events.some(event => event.type === 'todo' && event.phases[0].tasks[0].content === 'Wire bridge'))
    assert.ok(events.some(event => event.type === 'tool_approval_requested' && event.toolCallId === 'call-approval'))
    assert.ok(events.some(event => event.type === 'subagent_progress' && event.intent === 'Reading event contracts'))
    assert.ok(events.some(event => event.type === 'session_state' && event.contextPercent === 21 && event.thinkingLevel === 'high'))
    const jobs = events.find(event => event.type === 'async_jobs')
    assert.equal(jobs.running[0].label, undefined, 'bash labels may contain commands and stay hidden')
    assert.equal(jobs.recent[0].label, 'Review bridge')
    assert.equal(JSON.stringify(events).includes('private nested arguments'), false)
    assert.equal(JSON.stringify(events).includes('secret command'), false)
    assert.equal(harness.intervals.length, 1)

    harness.emit('session_shutdown', { type: 'session_shutdown' })
    assert.equal(harness.intervals[0].cleared, true)
  })

  it('clears a pending managed snapshot timer on shutdown', (t) => {
    installRuntime(t, async () => ({ ok: true, status: 200 }))
    const harness = createHarness()
    featherBridgeExtension(harness.pi)
    const message = assistant([{ type: 'text', text: 'partial' }])

    harness.emit('message_start', { type: 'message_start', message })
    harness.emit('message_update', { type: 'message_update', message })
    const timer = harness.timers[0]
    assert.equal(timer.cleared, false)

    harness.emit('session_shutdown', { type: 'session_shutdown' })
    assert.equal(timer.cleared, true)
  })
})
