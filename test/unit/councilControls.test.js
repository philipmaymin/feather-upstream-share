import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { protocolRunView } from '../../frontend/src/lib/protocolRuns.js'

function cancellingRun() {
  return {
    schemaVersion: 1,
    sessionId: 'session-1',
    runId: 'run-stopping',
    protocol: 'advisory',
    status: 'cancelling',
    lastSeq: 9,
    invocationMessageId: 'message-1',
    actionId: 'action-1',
    cancelActionId: 'cancel-1',
    question: 'Should this run stop?',
    candidateCount: 2,
    roles: [
      { seatId: 'candidate-1', role: 'Advocate' },
      { seatId: 'candidate-2', role: 'Skeptic' },
    ],
    roleMode: 'diverse',
    timeoutMs: 600000,
    stages: [{
      stageId: 'candidates',
      status: 'running',
      attempts: [{
        attempt: 1,
        status: 'running',
        seats: [
          { seatId: 'candidate-1', role: 'Advocate', attempt: 1, status: 'succeeded', evidenceIds: ['evidence-1'] },
          { seatId: 'candidate-2', role: 'Skeptic', attempt: 1, status: 'running', evidenceIds: [], ompChildId: 'child-2' },
        ],
      }],
    }],
    seats: [
      { seatId: 'candidate-1', role: 'Advocate', attempt: 1, status: 'succeeded', evidenceIds: ['evidence-1'] },
      { seatId: 'candidate-2', role: 'Skeptic', attempt: 1, status: 'running', evidenceIds: [], ompChildId: 'child-2' },
    ],
    evidence: [{ evidenceId: 'evidence-1', kind: 'candidate_answer', content: 'Retained', stageId: 'candidates', seatId: 'candidate-1', attempt: 1 }],
    verdict: null,
    verdictEvidenceId: null,
    createdAt: '2026-08-24T12:00:00.000Z',
    updatedAt: '2026-08-24T12:01:00.000Z',
  }
}

describe('Council Stop state', () => {
  it('keeps a cancelling run active and labels the durable stopping state', () => {
    const view = protocolRunView(cancellingRun())
    assert.equal(view.isActive, true)
    assert.equal(view.statusLabel, 'Stopping')
    assert.equal(view.summary, 'Stopping active seats…')
    assert.equal(view.candidateEvidence.length, 1)
    assert.equal(view.verdict, null)
  })
})
