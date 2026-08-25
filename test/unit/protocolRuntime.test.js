import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import protocolToolsExtension, {
  loadBridgeConfig,
  ownerExecutionIdFromContext,
  sanitizeReceipt,
  validateAdvisoryInput,
  validateCandidateAnswer,
  validateProtocolEvent,
} from '../../omp-tools/feather-protocol-tools.js'
import featherBridgeExtension from '../../omp-extensions/feather-bridge.js'

const RUN_ID = '11111111-1111-4111-8111-111111111111'
const EVENT_ID = '22222222-2222-4222-8222-222222222222'
const ACTION_ID = '33333333-3333-4333-8333-333333333333'
const BRIDGE_URL = 'http://feather.test/mounted/api/internal/sessions/session-1/events'

class FakeSchema {
  constructor() { this.refinements = [] }
  min() { return this }
  max() { return this }
  int() { return this }
  optional() { return this }
  strict() { return this }
  uuid() { return this }
  superRefine(refinement) { this.refinements.push(refinement); return this }
  refinementIssues(value) {
    const issues = []
    for (const refinement of this.refinements) refinement(value, { addIssue: (issue) => issues.push(issue) })
    return issues
  }
}

function fakeZod() {
  const schema = () => new FakeSchema()
  return {
    string: schema,
    number: schema,
    unknown: schema,
    literal: schema,
    enum: schema,
    object: schema,
    array: schema,
    union: schema,
  }
}

function toolHarness() {
  const tools = new Map()
  return {
    pi: {
      zod: fakeZod(),
      registerTool(tool) { tools.set(tool.name, tool) },
    },
    tools,
  }
}

function parentContext(sessionDir = null) {
  const sessionFile = sessionDir ? path.join(sessionDir, 'omp-session.jsonl') : '/tmp/omp-session.jsonl'
  return {
    sessionManager: {
      getSessionFile: () => sessionFile,
      getBranch: () => [
        { type: 'message', id: 'older-turn', message: { role: 'user', content: 'Earlier' } },
        { type: 'message', id: 'current-turn', message: { role: 'user', content: 'Run Advisory' } },
        { type: 'message', id: 'assistant-tool', message: { role: 'assistant', content: [] } },
      ],
    },
  }
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function installEnv(t, values = {}) {
  const prior = {
    FEATHER_BRIDGE_URL: process.env.FEATHER_BRIDGE_URL,
    FEATHER_BRIDGE_TOKEN: process.env.FEATHER_BRIDGE_TOKEN,
    FEATHER_SESSION_ID: process.env.FEATHER_SESSION_ID,
  }
  process.env.FEATHER_BRIDGE_URL = values.url ?? BRIDGE_URL
  process.env.FEATHER_BRIDGE_TOKEN = values.token ?? 'bridge-secret'
  process.env.FEATHER_SESSION_ID = values.sessionId ?? 'session-1'
  t.after(() => Object.entries(prior).forEach(([name, value]) => restoreEnv(name, value)))
}

function parseToolResult(result) {
  return JSON.parse(result.content[0].text)
}

function runStartedEvent(overrides = {}) {
  const roles = ['Advocate', 'Skeptic', 'Operator', 'Contrarian'].map((role, index) => ({ seatId: `candidate-${index + 1}`, role }))
  return {
    schemaVersion: 1,
    eventId: EVENT_ID,
    runId: RUN_ID,
    type: 'run_started',
    payload: {
      protocol: 'advisory',
      invocationMessageId: 'current-turn',
      actionId: ACTION_ID,
      question: 'Which migration is safer?',
      candidateCount: 4,
      roles,
      roleMode: 'diverse',
      timeoutMs: 600_000,
    },
    ...overrides,
  }
}

describe('Feather protocol tools', () => {
  it('loads and uses stored bridge config when launch environment is unavailable', async (t) => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protocol-config-'))
    fs.writeFileSync(path.join(sessionDir, '.feather-bridge.json'), JSON.stringify({
      url: BRIDGE_URL,
      token: 'stored-secret',
      sessionId: 'session-1',
    }))
    const priorEnv = {
      FEATHER_BRIDGE_URL: process.env.FEATHER_BRIDGE_URL,
      FEATHER_BRIDGE_TOKEN: process.env.FEATHER_BRIDGE_TOKEN,
      FEATHER_SESSION_ID: process.env.FEATHER_SESSION_ID,
    }
    const priorArgv = [...process.argv]
    delete process.env.FEATHER_BRIDGE_URL
    delete process.env.FEATHER_BRIDGE_TOKEN
    delete process.env.FEATHER_SESSION_ID
    process.argv.push('--session-dir', sessionDir)
    const requests = []
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      requests.push({ url: String(url), options, body: JSON.parse(options.body) })
      return new Response(JSON.stringify({ envelope: { runId: RUN_ID } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    t.after(() => {
      Object.entries(priorEnv).forEach(([name, value]) => restoreEnv(name, value))
      process.argv.splice(0, process.argv.length, ...priorArgv)
      fs.rmSync(sessionDir, { recursive: true, force: true })
    })

    const config = loadBridgeConfig({}, ['omp', '--session-dir', sessionDir])
    assert.deepEqual(config, { url: BRIDGE_URL, token: 'stored-secret', sessionId: 'session-1', sessionDir })
    const harness = toolHarness()
    protocolToolsExtension(harness.pi)
    await harness.tools.get('protocol_claim').execute('stored-claim', {}, undefined, undefined, parentContext(sessionDir))
    assert.equal(requests[0].options.headers['X-Feather-Bridge-Token'], 'stored-secret')
    assert.equal(requests[0].body.ownerExecutionId, 'current-turn')
  })

  it('derives the current parent execution from the latest user branch entry', () => {
    assert.equal(ownerExecutionIdFromContext(parentContext()), 'current-turn')
  })

  it('claims with bridge authentication and returns a stable token-free receipt', async (t) => {
    installEnv(t)
    const requests = []
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      requests.push({ url: String(url), options, body: JSON.parse(options.body) })
      return new Response(JSON.stringify({ envelope: {
        runId: RUN_ID,
        actionId: ACTION_ID,
        invocationMessageId: 'current-turn',
        token: 'server-token',
        note: 'bridge-secret must not escape',
      } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    const harness = toolHarness()
    protocolToolsExtension(harness.pi)
    const result = await harness.tools.get('protocol_claim').execute('call-1', {}, undefined, undefined, parentContext())

    assert.equal(requests[0].url, 'http://feather.test/mounted/api/internal/sessions/session-1/protocol-runs/claim')
    assert.equal(requests[0].options.headers['X-Feather-Bridge-Token'], 'bridge-secret')
    assert.deepEqual(requests[0].body, { ownerExecutionId: 'current-turn', invocationMessageId: 'current-turn' })
    assert.equal('token' in requests[0].body, false)
    const receipt = parseToolResult(result)
    assert.equal(receipt.operation, 'protocol_claim')
    assert.equal(receipt.runId, RUN_ID)
    assert.doesNotMatch(JSON.stringify(result), /bridge-secret|server-token/)
  })

  it('posts an authenticated wrapped event and returns only its stable receipt', async (t) => {
    installEnv(t)
    const requests = []
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      requests.push({ url: String(url), options, body: JSON.parse(options.body) })
      return new Response(JSON.stringify({ ok: true, seq: 7, duplicate: true, run: { token: 'server-token' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    const harness = toolHarness()
    protocolToolsExtension(harness.pi)
    const event = {
      schemaVersion: 1,
      eventId: EVENT_ID,
      runId: RUN_ID,
      type: 'stage_started',
      stageId: 'candidates',
      attempt: 1,
      payload: {},
    }
    const result = await harness.tools.get('protocol_event').execute('call-2', event, undefined, undefined, parentContext())

    assert.equal(requests[0].url, `http://feather.test/mounted/api/internal/sessions/session-1/protocol-runs/${RUN_ID}/events`)
    assert.equal(requests[0].options.headers['X-Feather-Bridge-Token'], 'bridge-secret')
    assert.deepEqual(requests[0].body, { ownerExecutionId: 'current-turn', event })
    assert.deepEqual(parseToolResult(result), {
      ok: true,
      operation: 'protocol_event',
      runId: RUN_ID,
      eventId: EVENT_ID,
      seq: 7,
      duplicate: true,
    })
    assert.doesNotMatch(JSON.stringify(result), /bridge-secret|server-token/)
  })

  it('rejects child runtimes before making an authenticated call', async (t) => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protocol-parent-'))
    const priorArgv = [...process.argv]
    process.argv.push('--session-dir', sessionDir)
    installEnv(t)
    let calls = 0
    t.mock.method(globalThis, 'fetch', async () => { calls += 1; return new Response('{}') })
    t.after(() => {
      process.argv.splice(0, process.argv.length, ...priorArgv)
      fs.rmSync(sessionDir, { recursive: true, force: true })
    })
    const harness = toolHarness()
    protocolToolsExtension(harness.pi)
    const child = { sessionManager: { getSessionFile: () => undefined, getBranch: () => [] } }
    await assert.rejects(
      harness.tools.get('protocol_claim').execute('call-child', {}, undefined, undefined, child),
      /parent-only/,
    )
    assert.equal(calls, 0)
  })

  it('enforces decoded UTF-8 limits during execution validation', () => {
    assert.throws(() => validateAdvisoryInput({ question: '😀'.repeat(5_001) }), /20000 decoded UTF-8 bytes/)
    assert.throws(() => validateAdvisoryInput({ question: 'ok', rubric: '😀'.repeat(2_001) }), /8000 decoded UTF-8 bytes/)
    assert.throws(() => validateCandidateAnswer({ answer: '😀'.repeat(3_001) }), /12000 decoded UTF-8 bytes/)
    const escapedButDecodedWithinLimit = runStartedEvent()
    escapedButDecodedWithinLimit.payload.question = '\\'.repeat(20_000)
    escapedButDecodedWithinLimit.payload.candidateCount = 2
    escapedButDecodedWithinLimit.payload.roles = [{ seatId: 'candidate-1', role: 'Advocate' }, { seatId: 'candidate-2', role: 'Skeptic' }]
    assert.doesNotThrow(() => validateProtocolEvent(escapedButDecodedWithinLimit))
    const oversizedPayload = {
      schemaVersion: 1,
      eventId: EVENT_ID,
      runId: RUN_ID,
      type: 'evidence_added',
      stageId: 'candidates',
      seatId: 'candidate-1',
      attempt: 1,
      payload: {
        evidenceId: 'evidence-candidate-1',
        kind: 'candidate_answer',
        content: 'x'.repeat(4_000),
        artifactReferences: Array.from({ length: 16 }, (_, index) => `${index}-${'x'.repeat(1_900)}`),
      },
    }
    assert.throws(() => validateProtocolEvent(oversizedPayload), /32000 decoded UTF-8 bytes/)

  })

  it('validates exact run event placement and deterministic role materialization', () => {
    assert.equal(validateProtocolEvent(runStartedEvent()).type, 'run_started')
    assert.throws(() => validateProtocolEvent(runStartedEvent({ stageId: 'candidates' })), /stageId is forbidden/)
    const bad = runStartedEvent()
    bad.payload.roles[1].seatId = 'candidate-8'
    assert.throws(() => validateProtocolEvent(bad), /deterministic candidate seat order/)
  })

  it('redacts sensitive keys and literal secrets at every receipt depth', () => {
    const clean = sanitizeReceipt({ token: 'a', bridgeToken: 'c', nested: { authorization: 'b', text: 'prefix-secret-suffix' } }, ['secret'])
    assert.deepEqual(clean, { nested: { text: 'prefix-[redacted]-suffix' } })
  })
})


describe('Bridge lifecycle ownership enrichment', () => {
  it('adds ownerExecutionId only to parent assistant and agent terminal events', async (t) => {
    installEnv(t)
    const handlers = new Map()
    const requests = []
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      requests.push({ url: String(url), body: JSON.parse(options.body) })
      return new Response(null, { status: 204 })
    })
    const pi = {
      on(name, handler) { handlers.set(name, handler) },
      events: { on() { return () => {} } },
      getServiceTiers: () => ({}),
      getThinkingLevel: () => undefined,
      logger: { warn() {} },
    }
    const ctx = {
      ...parentContext(),
      setTimeout(callback) { callback(); return 1 },
      setInterval() { return 1 },
      clearTimer() {},
      getContextUsage: () => undefined,
      getAsyncJobSnapshot: () => null,
    }
    featherBridgeExtension(pi)
    handlers.get('message_start')({ message: { role: 'assistant', content: [{ type: 'text', text: 'Verdict' }] } }, ctx)
    handlers.get('message_end')({ message: { role: 'assistant', content: [{ type: 'text', text: 'Verdict' }], stopReason: 'stop' } }, ctx)
    handlers.get('agent_end')({ type: 'agent_end', willContinue: false }, ctx)
    await new Promise((resolve) => setImmediate(resolve))

    const events = requests.flatMap((request) => request.body.events)
    const assistantEnd = events.find((event) => event.type === 'assistant_end')
    const agentEnd = events.find((event) => event.type === 'agent_end')
    assert.equal(assistantEnd.ownerExecutionId, 'current-turn')
    assert.equal(agentEnd.ownerExecutionId, 'current-turn')
  })
})
