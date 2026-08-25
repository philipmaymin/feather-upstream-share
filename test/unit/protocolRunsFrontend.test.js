import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createProtocolRunsState,
  protocolRunView,
  reduceProtocolRunSnapshot,
  runsForInvocation,
} from '../../frontend/src/lib/protocolRuns.js'

const CREATED_AT = '2026-08-24T12:00:00.000Z'

function roleRecords(count = 4) {
  const roles = ['Advocate', 'Skeptic', 'Operator', 'Contrarian']
  return Array.from({ length: count }, (_, index) => ({
    seatId: `candidate-${index + 1}`,
    role: roles[index] || `Independent ${index + 1}`,
  }))
}

function candidate(number, status, extra = {}) {
  return {
    seatId: `candidate-${number}`,
    stageId: 'candidates',
    role: roleRecords(Math.max(4, number))[number - 1].role,
    attempt: 1,
    status,
    evidenceIds: [],
    ...extra,
  }
}

function makeRun(overrides = {}) {
  const candidateCount = overrides.candidateCount ?? 4
  return {
    schemaVersion: 1,
    sessionId: 'session-1',
    runId: 'run-1',
    protocol: 'advisory',
    status: 'running',
    lastSeq: 5,
    invocationMessageId: 'message-1',
    actionId: 'action-1',
    ownerExecutionId: 'execution-1',
    question: 'Which approach should we take?',
    candidateCount,
    roles: roleRecords(candidateCount),
    roleMode: 'diverse',
    timeoutMs: 600000,
    stages: [],
    seats: [],
    evidence: [],
    verdict: null,
    verdictEvidenceId: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  }
}

function candidateStage(status, seats) {
  return { stageId: 'candidates', status, attempts: [{ attempt: 1, status, seats }] }
}

function judgeStage(status, attempts) {
  return { stageId: 'judge', status, attempts }
}

describe('Council protocol run reducer', () => {
  it('applies only newer lastSeq snapshots and remains idempotent on replay', () => {
    const starting = makeRun({ status: 'starting', lastSeq: 0 })
    const first = reduceProtocolRunSnapshot(createProtocolRunsState(), starting)
    const replay = reduceProtocolRunSnapshot(first, { ...starting, status: 'start_failed' })
    const advanced = reduceProtocolRunSnapshot(replay, { ...starting, status: 'start_failed', error: 'send failed', lastSeq: 1 })
    const stale = reduceProtocolRunSnapshot(advanced, { ...starting, status: 'running', lastSeq: 0 })

    assert.strictEqual(replay, first)
    assert.strictEqual(stale, advanced)
    assert.equal(advanced.order.length, 1)
    assert.equal(advanced.byId['run-1'].status, 'start_failed')
    assert.equal(advanced.byId['run-1'].lastSeq, 1)
  })
})

describe('Council launch and run presentations', () => {
  it('renders durable Starting and Start failed launch states', () => {
    const starting = protocolRunView(makeRun({ status: 'starting', lastSeq: 0 }))
    const failed = protocolRunView(makeRun({ status: 'start_failed', lastSeq: 1, error: 'OMP send failed' }))

    assert.equal(starting.statusLabel, 'Starting')
    assert.equal(starting.summary, 'Starting Advisory…')
    assert.equal(starting.candidates.length, 4)
    assert.deepEqual(starting.candidates.map(seat => seat.role), ['Advocate', 'Skeptic', 'Operator', 'Contrarian'])
    assert.equal(failed.statusLabel, 'Start failed')
    assert.match(failed.summary, /OMP send failed/)
  })


  it('renders active partial progress without dropping a failed seat', () => {
    const seats = [
      candidate(1, 'succeeded', { evidenceIds: ['evidence-1'], ompChildId: 'child-1' }),
      candidate(2, 'failed', { reason: 'invalid_output' }),
      candidate(3, 'running', { ompChildId: 'child-3' }),
      candidate(4, 'pending'),
    ]
    const run = makeRun({
      stages: [candidateStage('running', seats)],
      seats,
      evidence: [{ evidenceId: 'evidence-1', kind: 'candidate_answer', content: 'Answer one', stageId: 'candidates', seatId: 'candidate-1', attempt: 1 }],
    })
    const view = protocolRunView(run)

    assert.equal(view.stage, 'candidates')
    assert.deepEqual(view.counts, { total: 4, successful: 1, failed: 1, complete: 2, running: 2 })
    assert.equal(view.failures[0].seatId, 'candidate-2')
    assert.equal(view.candidateEvidence.length, 1)
    assert.deepEqual(view.stages.map(stage => stage.id), ['candidates', 'judge'])
  })

  it('renders Judge as the second active stage after a partial candidate barrier', () => {
    const candidates = [candidate(1, 'succeeded'), candidate(2, 'failed', { reason: 'timeout' })]
    const judge = { seatId: 'judge-1', stageId: 'judge', role: 'Judge', attempt: 1, status: 'running', evidenceIds: [], ompChildId: 'judge-child' }
    const run = makeRun({
      candidateCount: 2,
      roles: roleRecords(2),
      stages: [candidateStage('succeeded', candidates), judgeStage('running', [{ attempt: 1, status: 'running', seats: [judge] }])],
      seats: [...candidates, judge],
      evidence: [{ evidenceId: 'evidence-1', kind: 'candidate_answer', content: 'Useful answer', stageId: 'candidates', seatId: 'candidate-1', attempt: 1 }],
    })
    const view = protocolRunView(run)

    assert.equal(view.stage, 'judge')
    assert.equal(view.summary, 'Judge synthesizing · 1/2 candidates complete')
    assert.equal(view.judges[0].seatId, 'judge-1')
    assert.deepEqual(view.stages.map(stage => stage.status), ['succeeded', 'running'])
  })

  it('renders zero-success failure without a Judge or verdict', () => {
    const seats = [candidate(1, 'failed', { reason: 'spawn_failed' }), candidate(2, 'timed_out', { reason: 'timeout' })]
    const view = protocolRunView(makeRun({
      candidateCount: 2,
      roles: roleRecords(2),
      status: 'failed',
      stages: [candidateStage('failed', seats)],
      seats,
      finishedAt: '2026-08-24T12:02:00.000Z',
    }))

    assert.equal(view.summary, 'No candidate answers succeeded')
    assert.equal(view.judges.length, 0)
    assert.equal(view.verdict, null)
    assert.equal(view.failures.length, 2)
  })

  it('renders cancelled, interrupted, and exhausted-Judge failures with retained evidence but no false verdict', () => {
    const succeeded = candidate(1, 'succeeded', { evidenceIds: ['evidence-1'] })
    const failed = candidate(2, 'cancelled', { reason: 'user_stop' })
    const evidence = [{ evidenceId: 'evidence-1', kind: 'candidate_answer', content: 'Retained answer', stageId: 'candidates', seatId: 'candidate-1', attempt: 1 }]
    const base = { candidateCount: 2, roles: roleRecords(2), seats: [succeeded, failed], evidence }

    const cancelled = protocolRunView(makeRun({ ...base, status: 'cancelled', reason: 'user_stop' }))
    const interrupted = protocolRunView(makeRun({ ...base, status: 'interrupted', reason: 'owner_ended' }))
    const judgeOne = { seatId: 'judge-1', stageId: 'judge', role: 'Judge', attempt: 1, status: 'failed', evidenceIds: [], reason: 'invalid_output' }
    const judgeTwo = { seatId: 'judge-2', stageId: 'judge', role: 'Judge', attempt: 2, status: 'failed', evidenceIds: [], reason: 'transport' }
    const exhausted = protocolRunView(makeRun({
      ...base,
      status: 'failed',
      stages: [candidateStage('succeeded', [succeeded, candidate(2, 'failed')]), judgeStage('failed', [
        { attempt: 1, status: 'failed', seats: [judgeOne] },
        { attempt: 2, status: 'failed', seats: [judgeTwo] },
      ])],
      seats: [succeeded, candidate(2, 'failed'), judgeOne, judgeTwo],
    }))

    assert.match(cancelled.summary, /^Stopped/)
    assert.match(interrupted.summary, /^Interrupted/)
    assert.match(exhausted.summary, /^Judge failed/)
    assert.equal(cancelled.verdict, null)
    assert.equal(interrupted.verdict, null)
    assert.equal(exhausted.verdict, null)
    assert.equal(exhausted.judges.length, 2)
  })

  it('renders every structured verdict field exactly for a succeeded run', () => {
    const verdict = {
      ranking: [
        { seatId: 'candidate-2', rationale: 'Strongest executable plan' },
        { seatId: 'candidate-1', rationale: 'Best risk analysis' },
      ],
      recommendation: 'Use the bounded rollout with a reversible first step.',
      disagreements: [{ summary: 'Whether to default the feature on', evidenceIds: ['evidence-1'] }],
      confidence: 'high',
      citedEvidenceIds: ['evidence-1', 'evidence-2'],
    }
    const candidates = [candidate(1, 'succeeded'), candidate(2, 'succeeded')]
    const judge = { seatId: 'judge-1', stageId: 'judge', role: 'Judge', attempt: 1, status: 'succeeded', evidenceIds: ['verdict-1'] }
    const run = makeRun({
      candidateCount: 2,
      roles: roleRecords(2),
      status: 'succeeded',
      stages: [candidateStage('succeeded', candidates), judgeStage('succeeded', [{ attempt: 1, status: 'succeeded', seats: [judge] }])],
      seats: [...candidates, judge],
      evidence: [
        { evidenceId: 'evidence-1', kind: 'candidate_answer', content: 'One', stageId: 'candidates', seatId: 'candidate-1', attempt: 1 },
        { evidenceId: 'evidence-2', kind: 'candidate_answer', content: 'Two', stageId: 'candidates', seatId: 'candidate-2', attempt: 1 },
        { evidenceId: 'verdict-1', kind: 'judge_verdict', content: verdict, stageId: 'judge', seatId: 'judge-1', attempt: 1 },
      ],
      verdict,
      verdictEvidenceId: 'verdict-1',
      finishedAt: '2026-08-24T12:03:00.000Z',
    })

    assert.equal(protocolRunView(run).summary, 'Verdict ready · 2/2 candidates succeeded')
  })
})

describe('Council invocation chronology', () => {
  it('selects only runs anchored to one invocation message', () => {
    const run = makeRun({ invocationMessageId: 'message-1' })
    const unrelated = makeRun({ runId: 'run-2', invocationMessageId: 'missing-message' })
    assert.deepEqual(runsForInvocation([run, unrelated], 'message-1').map(item => item.runId), ['run-1'])
  })
})
