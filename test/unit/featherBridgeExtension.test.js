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
    harness.ctx.sessionManager = { getSessionFile: () => path.join(sessionDir, 'session.jsonl') }
    featherBridgeExtension(harness.pi)
    harness.emit('session_start', { type: 'session_start' })
    harness.emit('agent_start', { type: 'agent_start' })
    await settleDeliveryQueue()

    assert.equal(requests.length, 1)
    const child = createHarness()
    child.ctx.sessionManager = { getSessionFile: () => undefined }
    featherBridgeExtension(child.pi)
    child.emit('session_start', { type: 'session_start' })
    child.emit('agent_start', { type: 'agent_start' })
    await settleDeliveryQueue()
    assert.equal(requests.length, 1, 'in-memory child agents must not post into the parent session')
    assert.equal(requests[0].url, BRIDGE_URL)
    assert.equal(requests[0].options.headers['X-Feather-Bridge-Token'], 'stored-secret')
  })

  it('keeps thinking out of answer snapshots and streams it through work snapshots', async (t) => {
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
    const answerEvents = events.filter(event => event.type !== 'work_snapshot')
    assert.deepEqual(answerEvents.map((event) => [event.type, event.text]), [
      ['assistant_snapshot', 'Hel'],
      ['assistant_snapshot', 'Hello'],
      ['assistant_end', undefined],
    ])
    const workEvents = events.filter(event => event.type === 'work_snapshot')
    assert.equal(workEvents.length, 3)
    assert.deepEqual(workEvents.at(-1).blocks, [{ type: 'thinking', thinking: 'final hidden thought' }])
    assert.equal(new Set(events.map((event) => event.messageId)).size, 1)
    assert.equal(JSON.stringify(answerEvents).includes('private'), false)
    assert.equal(JSON.stringify(answerEvents).includes('hidden thought'), false)
    assert.equal(requests[0].url, BRIDGE_URL)
    assert.equal(requests[0].options.headers['X-Feather-Bridge-Token'], 'bridge-secret')
    assert.deepEqual(Object.keys(requests[0].body), ['version', 'events'])
    assert.equal(requests[0].body.version, 4)
    assert.equal('sessionId' in events[0], false)
  })

  it('streams thinking-only and tool-only work, clears it, and caps aggregate thinking', async (t) => {
    const requests = []
    installRuntime(t, async (...args) => {
      requests.push(parseRequest(...args))
      return { ok: true, status: 200 }
    })
    const harness = createHarness()
    featherBridgeExtension(harness.pi)

    const thinking = assistant([
      { type: 'thinking', thinking: 'a'.repeat(40_000) },
      { type: 'thinking', thinking: 'b'.repeat(40_000) },
    ])
    harness.emit('message_start', { type: 'message_start', message: thinking })
    harness.emit('message_update', { type: 'message_update', message: thinking })
    harness.runNextTimer()
    await settleDeliveryQueue()

    const textOnly = assistant([{ type: 'text', text: 'Now answering' }])
    harness.emit('message_update', { type: 'message_update', message: textOnly })
    harness.runNextTimer()
    await settleDeliveryQueue()
    const toolOnly = assistant([{ type: 'toolCall', id: 'tool-only', name: '', arguments: { path: '/private' } }])
    harness.emit('message_start', { type: 'message_start', message: toolOnly })
    harness.emit('message_update', { type: 'message_update', message: toolOnly })
    harness.runNextTimer()
    await settleDeliveryQueue()

    const workEvents = requests.flatMap(request => request.body.events).filter(event => event.type === 'work_snapshot')
    assert.equal(workEvents[0].blocks.filter(block => block.type === 'thinking').reduce((total, block) => total + block.thinking.length, 0), 3_000)
    assert.deepEqual(workEvents[1].blocks, [])
    assert.deepEqual(workEvents[2].blocks, [{ type: 'tool_use', id: 'tool-only', name: 'tool' }])
    assert.equal(JSON.stringify(workEvents).includes('/private'), false)
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
    const answerEvents = events.filter(event => event.type !== 'work_snapshot')
    assert.deepEqual(answerEvents.map((event) => event.type), [
      'assistant_snapshot',
      'assistant_end',
      'assistant_snapshot',
      'assistant_cancel',
    ])
    assert.equal(answerEvents[0].messageId, answerEvents[1].messageId)
    assert.equal(answerEvents[2].messageId, answerEvents[3].messageId)
    assert.equal(answerEvents[3].willContinue, true)
    assert.notEqual(answerEvents[0].messageId, answerEvents[2].messageId)
    const work = events.find(event => event.type === 'work_snapshot')
    assert.deepEqual(work.blocks, [
      { type: 'thinking', thinking: 'tool rationale' },
      { type: 'tool_use', id: 'call-1', name: 'read' },
    ])
    assert.equal(JSON.stringify(work).includes('secret'), false)
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
  it('falls back to answer-only streaming when a v1 server rejects work events', async (t) => {
    const requests = []
    installRuntime(t, async (...args) => {
      const request = parseRequest(...args)
      requests.push(request)
      const workOnly = request.body.events.every(event => event.type === 'work_snapshot')
      return { ok: !workOnly, status: workOnly ? 400 : 200 }
    })
    const harness = createHarness()
    featherBridgeExtension(harness.pi)

    const finishToolTurn = async (suffix) => {
      const message = assistant([
        { type: 'thinking', thinking: `thinking-${suffix}` },
        { type: 'text', text: `answer-${suffix}` },
        { type: 'toolCall', id: `tool-${suffix}`, name: 'read', arguments: { path: '/private' } },
      ])
      harness.emit('message_start', { type: 'message_start', message })
      harness.emit('message_end', { type: 'message_end', message })
      harness.runNextTimer()
      await settleDeliveryQueue()
      await settleDeliveryQueue()
    }

    await finishToolTurn('one')
    assert.deepEqual(requests[0].body.events.map(event => event.type), ['work_snapshot'])
    assert.deepEqual(requests[1].body.events.map(event => event.type), ['assistant_snapshot', 'assistant_cancel'])

    const requestCount = requests.length
    harness.emit('tool_execution_start', {
      type: 'tool_execution_start',
      toolCallId: 'legacy-hidden-tool',
      toolName: 'read',
      args: { path: '/private' },
    })
    await settleDeliveryQueue()
    assert.equal(requests.length, requestCount, 'v1 fallback must suppress v4 tool events')
    await finishToolTurn('two')
    assert.equal(requests.length, requestCount + 1)
    assert.deepEqual(requests.at(-1).body.events.map(event => event.type), ['assistant_snapshot', 'assistant_cancel'])
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

  it('emits bounded parent tool lifecycle data without spreading raw events', async (t) => {
    const requests = []
    installRuntime(t, async (...args) => {
      requests.push(parseRequest(...args))
      return { ok: true, status: 200 }
    })
    const harness = createHarness()
    featherBridgeExtension(harness.pi)

    let tooDeep = 'leaf'
    for (let index = 0; index < 10; index += 1) tooDeep = { child: tooDeep }
    harness.emit('tool_execution_start', {
      type: 'tool_execution_start',
      toolCallId: 'parent-tool',
      toolName: 'bash',
      args: { huge: 'x'.repeat(50_000), items: Array.from({ length: 150 }, (_, index) => index), tooDeep },
      intent: 'Inspecting bounded state',
      privateProviderPayload: 'must not spread',
    })
    await settleDeliveryQueue()
    harness.emit('tool_execution_update', {
      type: 'tool_execution_update',
      toolCallId: 'parent-tool',
      toolName: 'bash',
      args: { command: 'printf safe' },
      partialResult: { output: 'partial' },
      privateProviderPayload: 'must not spread',
    })
    await settleDeliveryQueue()
    harness.emit('tool_execution_end', {
      type: 'tool_execution_end',
      toolCallId: 'parent-tool',
      toolName: 'bash',
      result: { output: 'done', nested: tooDeep },
      isError: false,
      privateProviderPayload: 'must not spread',
    })
    await settleDeliveryQueue()

    const events = requests.flatMap(request => request.body.events)
    assert.deepEqual(events.map(event => event.type), [
      'tool_execution_start',
      'tool_execution_update',
      'tool_execution_end',
    ])
    assert.equal(events[0].args.huge.length <= 20_000, true)
    assert.equal(events[0].args.items.length, 100)
    assert.equal(events[1].partialResult.output, 'partial')
    assert.equal(events[2].result.output, 'done')
    assert.equal(events[2].isError, false)
    assert.equal(JSON.stringify(events).includes('must not spread'), false)
  })

  it('coalesces queued tool lifecycle without losing earlier fields', async (t) => {
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
    harness.emit('tool_execution_start', {
      type: 'tool_execution_start', toolCallId: 'fast-tool', toolName: 'read',
      args: { path: '/tmp/fast' }, intent: 'Reading fast state',
    })
    harness.emit('tool_execution_update', {
      type: 'tool_execution_update', toolCallId: 'fast-tool', toolName: 'read',
      partialResult: { output: 'partial' },
    })
    harness.emit('tool_execution_end', {
      type: 'tool_execution_end', toolCallId: 'fast-tool', toolName: 'read',
      result: { output: 'done' }, isError: false,
    })
    assert.equal(requests.length, 1)

    releaseFirst({ ok: true, status: 200 })
    await settleDeliveryQueue()
    await settleDeliveryQueue()
    const replayable = requests[1].body.events.find(event => event.toolCallId === 'fast-tool')
    assert.equal(replayable.type, 'tool_execution_end')
    assert.deepEqual(replayable.args, { path: '/tmp/fast' })
    assert.equal(replayable.intent, 'Reading fast state')
    assert.deepEqual(replayable.partialResult, { output: 'partial' })
    assert.deepEqual(replayable.result, { output: 'done' })
  })

  it('translates raw child assistant, tool, and Todo events onto one child timeline', async (t) => {
    const requests = []
    installRuntime(t, async (...args) => {
      requests.push(parseRequest(...args))
      return { ok: true, status: 200 }
    })
    const harness = createHarness()
    featherBridgeExtension(harness.pi)

    harness.emitBus('task:subagent:lifecycle', {
      id: 'child-1',
      agent: 'scout',
      agentSource: 'bundled',
      task: 'Map bridge behavior',
      assignment: 'Inspect event coverage',
      sessionFile: '/tmp/child.jsonl',
      parentToolCallId: 'parent-task',
      status: 'started',
      index: 0,
    })
    harness.emitBus('task:subagent:event', {
      id: 'child-1',
      event: {
        type: 'message_start',
        message: assistant([{ type: 'text', text: 'Investigating' }]),
      },
    })
    harness.emitBus('task:subagent:event', {
      id: 'child-1',
      event: {
        type: 'message_update',
        message: assistant([
          { type: 'thinking', thinking: 'child work' },
          { type: 'text', text: 'Investigating now' },
        ]),
      },
    })
    await settleDeliveryQueue()
    for (const event of [{
      type: 'tool_execution_start',
      toolCallId: 'child-tool',
      toolName: 'read',
      args: { path: '/tmp/input' },
      intent: 'Reading fixture',
    }, {
      type: 'tool_execution_update',
      toolCallId: 'child-tool',
      toolName: 'read',
      args: { path: '/tmp/input' },
      partialResult: { lines: 4 },
    }, {
      type: 'tool_execution_end',
      toolCallId: 'child-tool',
      toolName: 'read',
      result: { text: 'fixture' },
      isError: false,
    }]) {
      harness.emitBus('task:subagent:event', { id: 'child-1', event })
      await settleDeliveryQueue()
    }
    harness.emitBus('task:subagent:event', {
      id: 'child-1',
      event: {
        type: 'message_end',
        message: {
          role: 'toolResult',
          toolName: 'todo',
          details: { phases: [{ name: 'Child', tasks: [{ content: 'Inspect events', status: 'completed' }] }] },
        },
      },
    })
    harness.emitBus('task:subagent:event', {
      id: 'child-1',
      event: {
        type: 'message_end',
        message: assistant([{ type: 'text', text: 'Child complete' }]),
      },
    })
    await settleDeliveryQueue()

    const events = requests.flatMap(request => request.body.events)
    const lifecycle = events.find(event => event.type === 'subagent_lifecycle')
    assert.equal(lifecycle.agentSource, 'bundled')
    assert.equal(lifecycle.parentToolCallId, 'parent-task')
    assert.equal(lifecycle.task, 'Map bridge behavior')
    const childEvents = events.filter(event => event.subagentId === 'child-1')
    assert.ok(childEvents.some(event => event.type === 'assistant_snapshot' && event.text === 'Investigating now'))
    assert.ok(childEvents.some(event => event.type === 'work_snapshot' && event.blocks[0]?.thinking === 'child work'))
    assert.deepEqual(childEvents.filter(event => event.type.startsWith('tool_execution_')).map(event => event.type), [
      'tool_execution_start',
      'tool_execution_update',
      'tool_execution_end',
    ])
    assert.ok(childEvents.some(event => event.type === 'todo' && event.phases[0].tasks[0].status === 'completed'))
    assert.ok(childEvents.some(event => event.type === 'assistant_end' && event.messageId))
  })

  it('restores the latest persisted Todo snapshot from the active session branch', async (t) => {
    const requests = []
    installRuntime(t, async (...args) => {
      requests.push(parseRequest(...args))
      return { ok: true, status: 200 }
    })
    const harness = createHarness()
    const todoEntry = (content) => ({
      type: 'message',
      message: {
        role: 'toolResult',
        toolName: 'todo',
        details: { phases: [{ name: 'Restore', tasks: [{ content, status: 'in_progress' }] }] },
      },
    })
    harness.ctx.sessionManager = {
      getBranch: () => [todoEntry('Older task'), { type: 'message', message: assistant([{ type: 'text', text: 'work' }]) }, todoEntry('Latest task')],
    }
    featherBridgeExtension(harness.pi)
    harness.emit('session_start', { type: 'session_start' })
    await settleDeliveryQueue()

    const todo = requests.flatMap(request => request.body.events).find(event => event.type === 'todo')
    assert.equal(todo.phases[0].tasks[0].content, 'Latest task')
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
