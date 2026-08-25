import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ProtocolRunError, ProtocolRunStore } from '../../lib/protocol-runs.js'

const SESSION = 'protocol-test-session'
const OWNER = '00000000-0000-4000-8000-000000000001'
const RUN = '00000000-0000-4000-8000-000000000002'
const ACTION = '00000000-0000-4000-8000-000000000003'
const MESSAGE = '00000000-0000-4000-8000-000000000004'
const id = number => `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`

let root
let store
let serial
let clock

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'protocol-runs-'))
  serial = 100
  clock = 0
  store = new ProtocolRunStore({
    root,
    uuid: () => id(serial++),
    now: () => new Date(Date.UTC(2026, 7, 24, 12, 0, clock++)).toISOString(),
  })
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

function event(type, fields = {}, payload = {}, eventId = id(serial++)) {
  return { schemaVersion: 1, eventId, runId: RUN, type, ...fields, payload }
}

function emit(type, fields, payload) {
  return store.appendEvent(SESSION, OWNER, event(type, fields, payload))
}

async function rejects(work, status, code) {
  await assert.rejects(work, error => {
    assert.ok(error instanceof ProtocolRunError)
    assert.equal(error.status, status)
    if (code) assert.equal(error.code, code)
    return true
  })
}

async function begin(candidateCount = 2) {
  await store.createPending(SESSION, {
    protocol: 'advisory', question: 'Which option is strongest?', candidateCount, roleMode: 'diverse', timeoutMs: 600_000,
  }, { runId: RUN, actionId: ACTION, invocationMessageId: MESSAGE })
  const envelope = await store.claim(SESSION, { ownerExecutionId: OWNER, invocationMessageId: MESSAGE })
  await emit('run_started', {}, {
    protocol: 'advisory', invocationMessageId: MESSAGE, actionId: ACTION, ...envelope.input,
  })
  await emit('stage_started', { stageId: 'candidates', attempt: 1 }, {})
  return envelope
}

async function candidate(number, status = 'succeeded', reason) {
  const seatId = `candidate-${number}`
  if (status === 'succeeded') {
    const role = store.get(SESSION, RUN).roles[number - 1].role
    await emit('seat_started', { stageId: 'candidates', seatId, attempt: 1 }, { role, ompChildId: `child-${number}` })
    await emit('evidence_added', { stageId: 'candidates', seatId, attempt: 1 }, {
      evidenceId: `evidence-${seatId}`, kind: 'candidate_answer', content: `Answer ${number}`,
    })
    await emit('seat_terminal', { stageId: 'candidates', seatId, attempt: 1 }, { status })
  } else {
    if (reason !== 'spawn_failed') {
      const role = store.get(SESSION, RUN).roles[number - 1].role
      await emit('seat_started', { stageId: 'candidates', seatId, attempt: 1 }, { role, ompChildId: `child-${number}` })
    }
    await emit('seat_terminal', { stageId: 'candidates', seatId, attempt: 1 }, { status, ...(reason ? { reason } : {}) })
  }
}

function verdict(successful) {
  return {
    ranking: successful.map(seatId => ({ seatId, rationale: `${seatId} is useful` })),
    recommendation: 'Use the bounded implementation.',
    disagreements: [],
    confidence: 'high',
    citedEvidenceIds: successful.map(seatId => `evidence-${seatId}`),
  }
}

async function judge(successful, { terminal = true } = {}) {
  await emit('stage_started', { stageId: 'judge', attempt: 1 }, {})
  await emit('seat_started', { stageId: 'judge', seatId: 'judge-1', attempt: 1 }, { role: 'Judge', ompChildId: 'judge-child' })
  const content = verdict(successful)
  await emit('evidence_added', { stageId: 'judge', seatId: 'judge-1', attempt: 1 }, { evidenceId: 'judge-evidence', kind: 'judge_verdict', content })
  await emit('seat_terminal', { stageId: 'judge', seatId: 'judge-1', attempt: 1 }, { status: 'succeeded' })
  await emit('stage_terminal', { stageId: 'judge', attempt: 1 }, { status: 'succeeded' })
  await emit('verdict_recorded', {}, { evidenceId: 'judge-evidence' })
  if (terminal) await emit('run_terminal', {}, { status: 'succeeded' })
  return content
}

describe('durable Advisory reducer', () => {
  it('completes happy success with ordered seats, evidence, verdict, and lastSeq', async () => {
    await begin()
    await candidate(1)
    await candidate(2)
    await emit('stage_terminal', { stageId: 'candidates', attempt: 1 }, { status: 'succeeded' })
    const expected = await judge(['candidate-1', 'candidate-2'])
    const run = store.get(SESSION, RUN)

    assert.equal(run.status, 'succeeded')
    assert.deepEqual(run.verdict, expected)
    assert.equal(run.seats.length, 3)
    assert.equal(run.evidence.length, 3)
    assert.equal(run.lastSeq, 16)
    assert.ok(run.startedAt)
    assert.ok(run.finishedAt)
  })

  it('retains partial candidate failure and passes only successful evidence to Judge validation', async () => {
    await begin(3)
    await candidate(1)
    await candidate(2, 'failed', 'invalid_output')
    await candidate(3)
    await emit('stage_terminal', { stageId: 'candidates', attempt: 1 }, { status: 'succeeded' })
    await judge(['candidate-1', 'candidate-3'])
    const run = store.get(SESSION, RUN)
    assert.equal(run.seats.find(seat => seat.seatId === 'candidate-2').reason, 'invalid_output')
    assert.deepEqual(run.verdict.ranking.map(item => item.seatId), ['candidate-1', 'candidate-3'])
  })

  it('fails on zero success, never starts Judge, and records spawn failure without child id', async () => {
    await begin()
    await candidate(1, 'failed', 'spawn_failed')
    await candidate(2, 'failed', 'transport')
    await emit('stage_terminal', { stageId: 'candidates', attempt: 1 }, { status: 'failed' })
    await emit('run_terminal', {}, { status: 'failed' })
    const run = store.get(SESSION, RUN)
    assert.equal(run.status, 'failed')
    assert.equal(run.seats[0].ompChildId, undefined)
    assert.equal(run.stages.some(stage => stage.stageId === 'judge'), false)
    await rejects(emit('stage_started', { stageId: 'judge', attempt: 1 }, {}), 409, 'PROTOCOL_RUN_TERMINAL')
  })

  it('requires exact-attempt evidence before successful seat terminal', async () => {
    await begin()
    await rejects(
      emit('seat_terminal', { stageId: 'candidates', seatId: 'candidate-1', attempt: 1 }, { status: 'succeeded' }),
      409,
      'ILLEGAL_PROTOCOL_TRANSITION',
    )
    await rejects(
      emit('evidence_added', { stageId: 'candidates', seatId: 'candidate-1', attempt: 2 }, { evidenceId: 'wrong', kind: 'candidate_answer', content: 'Answer' }),
      409,
      'ILLEGAL_PROTOCOL_TRANSITION',
    )
  })

  it('rejects malformed or oversized answers and wrongly ranked verdicts', async () => {
    await begin(8)
    await emit('seat_started', { stageId: 'candidates', seatId: 'candidate-1', attempt: 1 }, { role: 'Advocate', ompChildId: 'child-1' })
    await rejects(
      emit('evidence_added', { stageId: 'candidates', seatId: 'candidate-1', attempt: 1 }, { evidenceId: 'shape', kind: 'candidate_answer', content: { answer: 'object' } }),
      400,
      'INVALID_PROTOCOL_INPUT',
    )
    await rejects(
      emit('evidence_added', { stageId: 'candidates', seatId: 'candidate-1', attempt: 1 }, { evidenceId: 'large', kind: 'candidate_answer', content: 'x'.repeat(12_001) }),
      400,
      'INVALID_PROTOCOL_INPUT',
    )
    await emit('evidence_added', { stageId: 'candidates', seatId: 'candidate-1', attempt: 1 }, { evidenceId: 'evidence-candidate-1', kind: 'candidate_answer', content: 'Answer 1' })
    await emit('seat_terminal', { stageId: 'candidates', seatId: 'candidate-1', attempt: 1 }, { status: 'succeeded' })
    for (let number = 2; number <= 8; number++) await candidate(number, 'failed', 'transport')
    await emit('stage_terminal', { stageId: 'candidates', attempt: 1 }, { status: 'succeeded' })
    await emit('stage_started', { stageId: 'judge', attempt: 1 }, {})
    await emit('seat_started', { stageId: 'judge', seatId: 'judge-1', attempt: 1 }, { role: 'Judge', ompChildId: 'judge-child' })
    await rejects(
      emit('evidence_added', { stageId: 'judge', seatId: 'judge-1', attempt: 1 }, { evidenceId: 'bad-verdict', kind: 'judge_verdict', content: verdict(['candidate-2']) }),
      400,
      'INVALID_OUTPUT',
    )
  })

  it('allows exactly one Judge retry without an attempt-1 stage_terminal', async () => {
    await begin()
    await candidate(1)
    await candidate(2, 'failed')
    await emit('stage_terminal', { stageId: 'candidates', attempt: 1 }, { status: 'succeeded' })
    await emit('stage_started', { stageId: 'judge', attempt: 1 }, {})
    await emit('seat_started', { stageId: 'judge', seatId: 'judge-1', attempt: 1 }, { role: 'Judge', ompChildId: 'judge-child' })
    await emit('seat_terminal', { stageId: 'judge', seatId: 'judge-1', attempt: 1 }, { status: 'failed', reason: 'invalid_output' })
    await rejects(emit('stage_terminal', { stageId: 'judge', attempt: 1 }, { status: 'failed' }), 409, 'ILLEGAL_PROTOCOL_TRANSITION')
    await emit('stage_started', { stageId: 'judge', attempt: 2 }, {})
    assert.equal(store.get(SESSION, RUN).stages[1].attempts[0].status, 'failed')
    await rejects(emit('stage_started', { stageId: 'judge', attempt: 2 }, {}), 409, 'ILLEGAL_PROTOCOL_TRANSITION')
  })

  it('treats identical event IDs as no-op and conflicting canonical bodies as conflict', async () => {
    await store.createPending(SESSION, { question: 'Question' }, { runId: RUN, actionId: ACTION, invocationMessageId: MESSAGE })
    const envelope = await store.claim(SESSION, { ownerExecutionId: OWNER, invocationMessageId: MESSAGE })
    const started = event('run_started', {}, { protocol: 'advisory', invocationMessageId: MESSAGE, actionId: ACTION, ...envelope.input })
    const first = await store.appendEvent(SESSION, OWNER, started)
    const duplicate = await store.appendEvent(SESSION, OWNER, structuredClone(started))
    assert.equal(duplicate.duplicate, true)
    assert.equal(duplicate.seq, first.seq)
    const conflict = structuredClone(started)
    conflict.payload.question = 'Different question'
    await rejects(store.appendEvent(SESSION, OWNER, conflict), 409, 'PROTOCOL_EVENT_CONFLICT')
  })

  it('serializes concurrent transitions into unique increasing sequence numbers', async () => {
    await begin()
    await emit('seat_started', { stageId: 'candidates', seatId: 'candidate-1', attempt: 1 }, { role: 'Advocate', ompChildId: 'child-1' })
    await emit('seat_started', { stageId: 'candidates', seatId: 'candidate-2', attempt: 1 }, { role: 'Skeptic', ompChildId: 'child-2' })
    const one = event('seat_terminal', { stageId: 'candidates', seatId: 'candidate-1', attempt: 1 }, { status: 'failed' })
    const two = event('seat_terminal', { stageId: 'candidates', seatId: 'candidate-2', attempt: 1 }, { status: 'failed' })
    const results = await Promise.all([store.appendEvent(SESSION, OWNER, one), store.appendEvent(SESSION, OWNER, two)])
    assert.deepEqual(results.map(result => result.seq), [5, 6])
  })

  it('serializes cancellation before parent output and emits a complete cancellation tail on owner terminal', async () => {
    await begin()
    const cancellation = await store.cancel(SESSION, RUN, id(900))
    assert.equal(cancellation.run.status, 'cancelling')
    assert.equal(cancellation.transitioned, true)
    assert.equal((await store.cancel(SESSION, RUN, id(900))).transitioned, false)
    await rejects(candidate(1, 'failed'), 409, 'PROTOCOL_RUN_CANCELLING')
    await store.ownerTerminated(SESSION, OWNER)
    const run = store.get(SESSION, RUN)
    assert.equal(run.status, 'cancelled')
    assert.equal(run.stages[0].status, 'cancelled')
    assert.ok(run.seats.every(seat => seat.status === 'cancelled'))
  })

  it('uses interruption before verdict and success-tail recovery after verdict', async () => {
    await begin()
    await candidate(1)
    await store.ownerTerminated(SESSION, OWNER, 'owner_interrupted')
    assert.equal(store.get(SESSION, RUN).status, 'interrupted')

    fs.rmSync(root, { recursive: true, force: true })
    fs.mkdirSync(root, { recursive: true })
    store = new ProtocolRunStore({ root, uuid: () => id(serial++) })
    await begin()
    await candidate(1)
    await candidate(2, 'failed')
    await emit('stage_terminal', { stageId: 'candidates', attempt: 1 }, { status: 'succeeded' })
    await judge(['candidate-1'], { terminal: false })
    await store.ownerTerminated(SESSION, OWNER)
    assert.equal(store.get(SESSION, RUN).status, 'succeeded')
  })

  it('keeps terminal runs immutable', async () => {
    await begin()
    await candidate(1, 'failed')
    await candidate(2, 'failed')
    await emit('stage_terminal', { stageId: 'candidates', attempt: 1 }, { status: 'failed' })
    await emit('run_terminal', {}, { status: 'failed' })
    await rejects(emit('run_terminal', {}, { status: 'failed' }), 409, 'PROTOCOL_RUN_TERMINAL')
    await rejects(store.cancel(SESSION, RUN, id(901)), 409, 'PROTOCOL_RUN_TERMINAL')
  })
})

describe('protocol log and pending-envelope recovery', () => {
  it('truncates only an incomplete crash tail and restores latest snapshot on restart', async () => {
    await begin()
    await candidate(1, 'failed')
    const log = store.logPath(SESSION, RUN)
    fs.appendFileSync(log, '{"partial":')
    const before = fs.statSync(log).size
    const restarted = new ProtocolRunStore({ root })
    assert.equal(restarted.get(SESSION, RUN).lastSeq, 4)
    assert.ok(fs.statSync(log).size < before)
    assert.ok(fs.readFileSync(log, 'utf8').endsWith('\n'))
  })

  it('fails closed on earlier corruption', async () => {
    await begin()
    const log = store.logPath(SESSION, RUN)
    const lines = fs.readFileSync(log, 'utf8').split('\n')
    lines[0] = '{corrupt}'
    fs.writeFileSync(log, lines.join('\n'))
    const restarted = new ProtocolRunStore({ root })
    assert.equal(restarted.get(SESSION, RUN).status, 'error')
    await rejects(restarted.appendEvent(SESSION, OWNER, event('seat_terminal', { stageId: 'candidates', seatId: 'candidate-1', attempt: 1 }, { status: 'failed' })), 500, 'CORRUPT_PROTOCOL_LOG')
  })

  it('persists launch failure with monotonic lastSeq and restores it', async () => {
    await store.createPending(SESSION, { question: 'Cannot send' }, { runId: RUN, actionId: ACTION, invocationMessageId: MESSAGE })
    await store.markStartFailed(SESSION, RUN, 'tmux unavailable')
    const restarted = new ProtocolRunStore({ root })
    assert.equal(restarted.get(SESSION, RUN).status, 'start_failed')
    assert.equal(restarted.get(SESSION, RUN).lastSeq, 1)
  })

  it('atomically rebinds a sole direct-launch envelope to the actual OMP user entry', async () => {
    await store.createPending(SESSION, { question: 'Direct launch' }, { runId: RUN, actionId: ACTION, invocationMessageId: MESSAGE })
    await store.markLaunchSent(SESSION, RUN)
    const actualInvocationMessageId = 'deadbeef'
    const claimed = await store.claim(SESSION, { ownerExecutionId: 'cafebabe', invocationMessageId: actualInvocationMessageId })
    assert.equal(claimed.invocationMessageId, actualInvocationMessageId)
    assert.equal(claimed.deliveryMessageId, MESSAGE)
    assert.equal(store.get(SESSION, RUN).invocationMessageId, actualInvocationMessageId)
    const started = await store.appendEvent(SESSION, 'cafebabe', event('run_started', {}, {
      protocol: 'advisory',
      invocationMessageId: actualInvocationMessageId,
      actionId: ACTION,
      ...claimed.input,
    }))
    assert.equal(started.snapshot.ownerExecutionId, 'cafebabe')
    assert.equal(started.snapshot.invocationMessageId, actualInvocationMessageId)
  })

  it('rejects an ambiguous direct claim instead of guessing between pending envelopes', async () => {
    await store.createPending(SESSION, { question: 'First' }, { runId: RUN, actionId: ACTION, invocationMessageId: MESSAGE })
    await store.createPending(SESSION, { question: 'Second' }, { runId: id(710), actionId: id(711), invocationMessageId: id(712) })
    await rejects(
      store.claim(SESSION, { ownerExecutionId: OWNER, invocationMessageId: id(713) }),
      409,
      'PROTOCOL_CLAIM_AMBIGUOUS',
    )
  })

  it('creates a conversational envelope directly from opaque OMP turn IDs', async () => {
    const envelope = await store.claim(SESSION, {
      ownerExecutionId: 'cafebabe',
      invocationMessageId: 'deadbeef',
      mode: 'create',
      input: { question: 'Conversational Advisory', candidateCount: 2 },
    })
    assert.equal(envelope.invocationMessageId, 'deadbeef')
    assert.equal(envelope.deliveryMessageId, undefined)
    assert.equal(envelope.ownerExecutionId, 'cafebabe')
  })

  it('marks claimed invocation start_failed when owner ends before run_started', async () => {
    await store.createPending(SESSION, { question: 'Claim only' }, { runId: RUN, actionId: ACTION, invocationMessageId: MESSAGE })
    await store.claim(SESSION, { ownerExecutionId: OWNER, invocationMessageId: MESSAGE })
    await store.ownerTerminated(SESSION, OWNER)
    assert.equal(store.get(SESSION, RUN).error, 'owner_terminated_before_run_started')
  })

  it('writes a tombstone before removal and rejects late events without recreating the directory', async () => {
    await begin()
    await store.deleteSession(SESSION)
    await rejects(store.appendEvent(SESSION, OWNER, event('seat_terminal', { stageId: 'candidates', seatId: 'candidate-1', attempt: 1 }, { status: 'failed' })), 410, 'PROTOCOL_SESSION_TOMBSTONED')
    assert.equal(fs.existsSync(store.sessionDir(SESSION)), false)
    assert.equal(store.list(SESSION).length, 0)
  })

  it('creates a linked rerun without mutating the terminal source', async () => {
    await begin()
    await candidate(1, 'failed')
    await candidate(2, 'failed')
    await emit('stage_terminal', { stageId: 'candidates', attempt: 1 }, { status: 'failed' })
    await emit('run_terminal', {}, { status: 'failed' })
    const rerun = await store.createPending(SESSION, { question: 'Which option is strongest?', candidateCount: 2 }, {
      sourceRunId: RUN, runId: id(800), actionId: id(801), invocationMessageId: id(802),
    })
    assert.equal(rerun.sourceRunId, RUN)
    assert.equal(rerun.status, 'starting')
    assert.equal(store.get(SESSION, RUN).status, 'failed')
  })

  it('lists only latest 50 while retaining every durable envelope', async () => {
    for (let number = 0; number < 51; number++) {
      await store.createPending(SESSION, { question: `Question ${number}` }, {
        runId: id(1000 + number * 3), actionId: id(1001 + number * 3), invocationMessageId: id(1002 + number * 3),
      })
    }
    assert.equal(store.list(SESSION).length, 50)
    assert.equal(fs.readdirSync(store.sessionDir(SESSION)).filter(file => file.endsWith('.pending.json')).length, 51)
  })
})
