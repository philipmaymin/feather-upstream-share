import fs from 'fs'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import { isJsonRecord } from './json-state.js'
import { createKeyedLock } from './sendlock.js'

const SCHEMA_VERSION = 1
const MAX_EVENTS = 512
const TRUSTED_TAIL_RESERVE = 11
const MAX_EVENT_PAYLOAD_BYTES = 32_000
const MAX_QUESTION_BYTES = 20_000
const MAX_RUBRIC_BYTES = 8_000
const MAX_CANDIDATE_BYTES = 12_000
const MAX_CANDIDATE_AGGREGATE_BYTES = 96_000
const MAX_VERDICT_BYTES = 24_000
const MAX_REASON_BYTES = 2_000
const DEFAULT_TIMEOUT_MS = 10 * 60_000
const MIN_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 30 * 60_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const TERMINAL_RUNS = new Set(['succeeded', 'failed', 'cancelled', 'interrupted'])
const TERMINAL_SEATS = new Set(['succeeded', 'failed', 'timed_out', 'cancelled'])
const DIVERSE_ROLES = ['Advocate', 'Skeptic', 'Operator', 'Contrarian']

export class ProtocolRunError extends Error {
  constructor(status, message, code = 'PROTOCOL_RUN_ERROR') {
    super(message)
    this.name = 'ProtocolRunError'
    this.status = status
    this.code = code
  }
}

function fail(status, message, code) {
  throw new ProtocolRunError(status, message, code)
}


function bytes(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value))
}

function truncateUtf8(value, maximum) {
  const encoded = Buffer.from(String(value || ''))
  if (encoded.length <= maximum) return encoded.toString() || 'unknown_error'
  let end = maximum
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1
  return encoded.subarray(0, end).toString() || 'unknown_error'
}

function boundedString(value, maximum, name, { optional = false, nonempty = true } = {}) {
  if (value === undefined && optional) return undefined
  if (typeof value !== 'string' || (nonempty && value.length === 0) || bytes(value) > maximum) {
    fail(400, `${name} must be ${optional ? 'an optional ' : 'a '}string of at most ${maximum} UTF-8 bytes`, 'INVALID_PROTOCOL_INPUT')
  }
  return value
}

function exactKeys(value, required, optional = [], name = 'object') {
  if (!isJsonRecord(value)) fail(400, `${name} must be an object`, 'INVALID_PROTOCOL_EVENT')
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(400, `${name} contains unknown field ${key}`, 'INVALID_PROTOCOL_EVENT')
  }
  for (const key of required) {
    if (!(key in value)) fail(400, `${name}.${key} is required`, 'INVALID_PROTOCOL_EVENT')
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isJsonRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function validateUuid(value, name) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail(400, `${name} must be a UUID`, 'INVALID_PROTOCOL_EVENT')
  return value
}

function validateToken(value, name) {
  if (typeof value !== 'string' || !TOKEN_RE.test(value)) fail(400, `${name} is invalid`, 'INVALID_PROTOCOL_EVENT')
  return value
}

function validateSessionId(value) {
  if (typeof value !== 'string' || !SESSION_RE.test(value)) fail(400, 'invalid session id', 'INVALID_SESSION_ID')
  return value
}

function resolvedRoles(candidateCount, roleMode) {
  if (!Number.isSafeInteger(candidateCount) || candidateCount < 2 || candidateCount > 8) {
    fail(400, 'candidateCount must be an integer from 2 through 8', 'INVALID_PROTOCOL_INPUT')
  }
  if (roleMode !== 'diverse' && roleMode !== 'neutral') fail(400, 'roleMode must be diverse or neutral', 'INVALID_PROTOCOL_INPUT')
  return Array.from({ length: candidateCount }, (_, index) => ({
    seatId: `candidate-${index + 1}`,
    role: roleMode === 'neutral'
      ? `Independent ${index + 1}`
      : (index < DIVERSE_ROLES.length ? DIVERSE_ROLES[index] : `Independent ${index + 1}`),
  }))
}

export function normalizeAdvisoryInput(input) {
  exactKeys(input, ['question'], ['protocol', 'candidateCount', 'roleMode', 'rubric', 'timeoutMs', 'actionId'], 'Advisory input')
  if (input.protocol !== undefined && input.protocol !== 'advisory') fail(400, 'protocol must be advisory', 'INVALID_PROTOCOL_INPUT')
  const question = boundedString(input.question, MAX_QUESTION_BYTES, 'question')
  const candidateCount = input.candidateCount === undefined ? 4 : input.candidateCount
  const roleMode = input.roleMode === undefined ? 'diverse' : input.roleMode
  const roles = resolvedRoles(candidateCount, roleMode)
  const timeoutMs = input.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : input.timeoutMs
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    fail(400, 'timeoutMs must be an integer from 60000 through 1800000', 'INVALID_PROTOCOL_INPUT')
  }
  const rubric = boundedString(input.rubric, MAX_RUBRIC_BYTES, 'rubric', { optional: true })
  if (input.actionId !== undefined) validateUuid(input.actionId, 'actionId')
  return {
    protocol: 'advisory',
    question,
    candidateCount,
    roles,
    roleMode,
    timeoutMs,
    ...(rubric !== undefined ? { rubric } : {}),
  }
}

function validateArtifactReferences(value) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 16) fail(400, 'artifactReferences must contain at most 16 entries', 'INVALID_PROTOCOL_EVENT')
  return value.map((reference, index) => boundedString(reference, 2_000, `artifactReferences[${index}]`))
}

function successfulCandidates(snapshot) {
  const stage = snapshot.stages.find(candidate => candidate.stageId === 'candidates')
  return stage?.attempts[0]?.seats.filter(seat => seat.status === 'succeeded') || []
}

function validateVerdict(content, snapshot) {
  exactKeys(content, ['ranking', 'recommendation', 'disagreements', 'confidence', 'citedEvidenceIds'], [], 'judge verdict')
  if (bytes(content) > MAX_VERDICT_BYTES) fail(400, 'judge verdict exceeds 24000 UTF-8 bytes', 'INVALID_OUTPUT')
  const candidates = successfulCandidates(snapshot)
  const candidateIds = new Set(candidates.map(seat => seat.seatId))
  const evidenceIds = new Set(candidates.flatMap(seat => seat.evidenceIds))
  if (!Array.isArray(content.ranking) || content.ranking.length !== candidates.length) fail(400, 'ranking must include every successful candidate exactly once', 'INVALID_OUTPUT')
  const ranked = new Set()
  for (const [index, item] of content.ranking.entries()) {
    exactKeys(item, ['seatId', 'rationale'], [], `ranking[${index}]`)
    validateToken(item.seatId, `ranking[${index}].seatId`)
    boundedString(item.rationale, 1_000, `ranking[${index}].rationale`)
    if (!candidateIds.has(item.seatId) || ranked.has(item.seatId)) fail(400, 'ranking must include every successful candidate exactly once', 'INVALID_OUTPUT')
    ranked.add(item.seatId)
  }
  boundedString(content.recommendation, MAX_CANDIDATE_BYTES, 'recommendation')
  if (!Array.isArray(content.disagreements) || content.disagreements.length > 16) fail(400, 'disagreements must contain at most 16 entries', 'INVALID_OUTPUT')
  for (const [index, disagreement] of content.disagreements.entries()) {
    exactKeys(disagreement, ['summary', 'evidenceIds'], [], `disagreements[${index}]`)
    boundedString(disagreement.summary, MAX_REASON_BYTES, `disagreements[${index}].summary`)
    if (!Array.isArray(disagreement.evidenceIds) || new Set(disagreement.evidenceIds).size !== disagreement.evidenceIds.length || disagreement.evidenceIds.some(id => !evidenceIds.has(id))) {
      fail(400, `disagreements[${index}].evidenceIds must reference candidate evidence`, 'INVALID_OUTPUT')
    }
  }
  if (!['low', 'medium', 'high'].includes(content.confidence)) fail(400, 'confidence is invalid', 'INVALID_OUTPUT')
  if (!Array.isArray(content.citedEvidenceIds) || new Set(content.citedEvidenceIds).size !== content.citedEvidenceIds.length || content.citedEvidenceIds.some(id => !evidenceIds.has(id))) {
    fail(400, 'citedEvidenceIds must reference candidate evidence', 'INVALID_OUTPUT')
  }
}

function eventShape(type) {
  if (type === 'run_started') return { required: [], optional: [], attempt: false, stage: false, seat: false }
  if (type === 'stage_started' || type === 'stage_terminal') return { required: ['attempt', 'stageId'], optional: [], attempt: true, stage: true, seat: false }
  if (type === 'seat_started' || type === 'evidence_added' || type === 'seat_terminal') return { required: ['attempt', 'stageId', 'seatId'], optional: [], attempt: true, stage: true, seat: true }
  if (type === 'cancel_requested' || type === 'verdict_recorded' || type === 'run_terminal') return { required: [], optional: [], attempt: false, stage: false, seat: false }
  fail(400, `unsupported protocol event type ${type}`, 'INVALID_PROTOCOL_EVENT')
}

function validatePayload(type, payload) {
  if (type === 'run_started') {
    exactKeys(payload, ['protocol', 'invocationMessageId', 'actionId', 'question', 'candidateCount', 'roles', 'roleMode', 'timeoutMs'], ['rubric', 'sourceRunId'], 'run_started payload')
    if (payload.protocol !== 'advisory') fail(400, 'protocol must be advisory', 'INVALID_PROTOCOL_EVENT')
    boundedString(payload.invocationMessageId, 128, 'invocationMessageId')
    validateUuid(payload.actionId, 'actionId')
    const normalized = normalizeAdvisoryInput({
      question: payload.question,
      candidateCount: payload.candidateCount,
      roleMode: payload.roleMode,
      timeoutMs: payload.timeoutMs,
      ...(payload.rubric !== undefined ? { rubric: payload.rubric } : {}),
    })
    if (canonical(normalized.roles) !== canonical(payload.roles)) fail(400, 'roles do not match candidateCount and roleMode', 'INVALID_PROTOCOL_EVENT')
    if (payload.sourceRunId !== undefined) validateUuid(payload.sourceRunId, 'sourceRunId')
    return clone(payload)
  }
  if (type === 'stage_started') {
    if (payload !== undefined && (!isJsonRecord(payload) || Object.keys(payload).length !== 0)) fail(400, 'stage_started payload must be empty', 'INVALID_PROTOCOL_EVENT')
    return {}
  }
  if (type === 'seat_started') {
    exactKeys(payload, ['role', 'ompChildId'], [], 'seat_started payload')
    boundedString(payload.role, 120, 'role')
    boundedString(payload.ompChildId, 256, 'ompChildId')
    return clone(payload)
  }
  if (type === 'evidence_added') {
    exactKeys(payload, ['evidenceId', 'kind', 'content'], ['artifactReferences'], 'evidence_added payload')
    boundedString(payload.evidenceId, 128, 'evidenceId')
    if (payload.kind !== 'candidate_answer' && payload.kind !== 'judge_verdict') fail(400, 'invalid evidence kind', 'INVALID_PROTOCOL_EVENT')
    const artifactReferences = validateArtifactReferences(payload.artifactReferences)
    return { evidenceId: payload.evidenceId, kind: payload.kind, content: clone(payload.content), ...(artifactReferences ? { artifactReferences } : {}) }
  }
  if (type === 'seat_terminal') {
    exactKeys(payload, ['status'], ['reason'], 'seat_terminal payload')
    if (!TERMINAL_SEATS.has(payload.status)) fail(400, 'invalid seat terminal status', 'INVALID_PROTOCOL_EVENT')
    const reason = boundedString(payload.reason, MAX_REASON_BYTES, 'reason', { optional: true })
    return { status: payload.status, ...(reason !== undefined ? { reason } : {}) }
  }
  if (type === 'stage_terminal') {
    exactKeys(payload, ['status'], ['reason'], 'stage_terminal payload')
    if (!['succeeded', 'failed', 'cancelled', 'interrupted'].includes(payload.status)) fail(400, 'invalid stage terminal status', 'INVALID_PROTOCOL_EVENT')
    const reason = boundedString(payload.reason, MAX_REASON_BYTES, 'reason', { optional: true })
    return { status: payload.status, ...(reason !== undefined ? { reason } : {}) }
  }
  if (type === 'cancel_requested') {
    exactKeys(payload, ['actionId'], [], 'cancel_requested payload')
    validateUuid(payload.actionId, 'actionId')
    return clone(payload)
  }
  if (type === 'verdict_recorded') {
    exactKeys(payload, ['evidenceId'], [], 'verdict_recorded payload')
    boundedString(payload.evidenceId, 128, 'evidenceId')
    return clone(payload)
  }
  if (type === 'run_terminal') {
    exactKeys(payload, ['status'], ['reason'], 'run_terminal payload')
    if (!TERMINAL_RUNS.has(payload.status)) fail(400, 'invalid run terminal status', 'INVALID_PROTOCOL_EVENT')
    const reason = boundedString(payload.reason, MAX_REASON_BYTES, 'reason', { optional: true })
    return { status: payload.status, ...(reason !== undefined ? { reason } : {}) }
  }
}

export function normalizeProtocolEvent(request) {
  exactKeys(request, ['schemaVersion', 'eventId', 'runId', 'type', 'payload'], ['attempt', 'stageId', 'seatId'], 'protocol event')
  if (request.schemaVersion !== SCHEMA_VERSION) fail(400, 'unsupported protocol event schemaVersion', 'INVALID_PROTOCOL_EVENT')
  validateUuid(request.eventId, 'eventId')
  validateUuid(request.runId, 'runId')
  const shape = eventShape(request.type)
  for (const key of shape.required) if (!(key in request)) fail(400, `${key} is required for ${request.type}`, 'INVALID_PROTOCOL_EVENT')
  if (!shape.attempt && 'attempt' in request) fail(400, `attempt is forbidden for ${request.type}`, 'INVALID_PROTOCOL_EVENT')
  if (!shape.stage && 'stageId' in request) fail(400, `stageId is forbidden for ${request.type}`, 'INVALID_PROTOCOL_EVENT')
  if (!shape.seat && 'seatId' in request) fail(400, `seatId is forbidden for ${request.type}`, 'INVALID_PROTOCOL_EVENT')
  if (shape.attempt && (!Number.isSafeInteger(request.attempt) || request.attempt < 1 || request.attempt > 2)) fail(400, 'attempt must be 1 or 2', 'INVALID_PROTOCOL_EVENT')
  if (shape.stage && !['candidates', 'judge'].includes(request.stageId)) fail(400, 'invalid stageId', 'INVALID_PROTOCOL_EVENT')
  if (shape.seat) validateToken(request.seatId, 'seatId')
  const payload = validatePayload(request.type, request.payload)
  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    eventId: request.eventId,
    runId: request.runId,
    type: request.type,
    ...(shape.attempt ? { attempt: request.attempt } : {}),
    ...(shape.stage ? { stageId: request.stageId } : {}),
    ...(shape.seat ? { seatId: request.seatId } : {}),
    payload,
  }
  if (bytes(payload) > MAX_EVENT_PAYLOAD_BYTES) fail(413, 'protocol event payload exceeds 32000 UTF-8 bytes', 'PROTOCOL_EVENT_TOO_LARGE')
  return normalized
}

function stageFor(snapshot, stageId) {
  return snapshot.stages.find(stage => stage.stageId === stageId)
}

function attemptFor(snapshot, stageId, attempt) {
  return stageFor(snapshot, stageId)?.attempts.find(item => item.attempt === attempt)
}

function seatFor(snapshot, event) {
  return attemptFor(snapshot, event.stageId, event.attempt)?.seats.find(seat => seat.seatId === event.seatId)
}

function ensureActive(snapshot) {
  if (TERMINAL_RUNS.has(snapshot.status)) fail(409, 'protocol run is terminal', 'PROTOCOL_RUN_TERMINAL')
}

function createSnapshot(record) {
  const payload = record.payload
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: record.sessionId,
    runId: record.runId,
    protocol: 'advisory',
    status: 'pending',
    invocationMessageId: payload.invocationMessageId,
    actionId: payload.actionId,
    ownerExecutionId: record.ownerExecutionId,
    question: payload.question,
    candidateCount: payload.candidateCount,
    roles: clone(payload.roles),
    roleMode: payload.roleMode,
    timeoutMs: payload.timeoutMs,
    ...(payload.rubric !== undefined ? { rubric: payload.rubric } : {}),
    ...(payload.sourceRunId !== undefined ? { sourceRunId: payload.sourceRunId } : {}),
    stages: [],
    evidence: [],
    verdict: null,
    verdictEvidenceId: null,
    createdAt: record.at,
    updatedAt: record.at,
    lastSeq: record.seq,
  }
}

function refreshSeats(snapshot) {
  snapshot.seats = snapshot.stages.flatMap(stage => stage.attempts.flatMap(attempt => attempt.seats.map(seat => ({ ...seat, stageId: stage.stageId }))))
}

export function reduceProtocolRecord(previous, record, { trusted = false } = {}) {
  const event = record
  if (event.type === 'run_started') {
    if (previous) fail(409, 'run_started must be the first event', 'ILLEGAL_PROTOCOL_TRANSITION')
    const snapshot = createSnapshot(record)
    refreshSeats(snapshot)
    return snapshot
  }
  if (!previous) fail(409, 'run_started must be the first event', 'ILLEGAL_PROTOCOL_TRANSITION')
  const snapshot = clone(previous)
  ensureActive(snapshot)
  if (snapshot.status === 'cancelling' && !trusted) fail(409, 'protocol run is cancelling', 'PROTOCOL_RUN_CANCELLING')

  if (event.type === 'stage_started') {
    if (event.stageId === 'candidates') {
      if (event.attempt !== 1 || snapshot.status !== 'pending' || snapshot.stages.length !== 0) fail(409, 'Candidates can only start once from pending', 'ILLEGAL_PROTOCOL_TRANSITION')
      snapshot.stages.push({
        stageId: 'candidates', status: 'running',
        attempts: [{ attempt: 1, status: 'running', seats: snapshot.roles.map(({ seatId, role }) => ({ seatId, role, attempt: 1, status: 'pending', evidenceIds: [] })) }],
      })
      snapshot.status = 'running'
    } else {
      const candidates = stageFor(snapshot, 'candidates')
      if (candidates?.status !== 'succeeded') fail(409, 'Judge requires a successful Candidates barrier', 'ILLEGAL_PROTOCOL_TRANSITION')
      let judge = stageFor(snapshot, 'judge')
      if (event.attempt === 1) {
        if (judge) fail(409, 'Judge attempt 1 already exists', 'ILLEGAL_PROTOCOL_TRANSITION')
        judge = { stageId: 'judge', status: 'running', attempts: [] }
        snapshot.stages.push(judge)
      } else {
        const prior = judge?.attempts.find(item => item.attempt === 1)
        const priorSeat = prior?.seats[0]
        if (!judge || prior?.status !== 'running' || !priorSeat || priorSeat.status === 'succeeded' || !TERMINAL_SEATS.has(priorSeat.status) || judge.attempts.some(item => item.attempt === 2) || snapshot.verdict) {
          fail(409, 'Judge attempt 2 requires a failed terminal attempt 1 seat', 'ILLEGAL_PROTOCOL_TRANSITION')
        }
        prior.status = 'failed'
        if (priorSeat.reason !== undefined) prior.reason = priorSeat.reason
        judge.status = 'running'
      }
      judge.attempts.push({ attempt: event.attempt, status: 'running', seats: [{ seatId: `judge-${event.attempt}`, role: 'Judge', attempt: event.attempt, status: 'pending', evidenceIds: [] }] })
    }
  } else if (event.type === 'seat_started') {
    const seat = seatFor(snapshot, event)
    if (!seat || seat.status !== 'pending' || seat.ompChildId) fail(409, 'seat is not pending', 'ILLEGAL_PROTOCOL_TRANSITION')
    if (event.payload.role !== seat.role) fail(409, 'seat role does not match its materialized role', 'ILLEGAL_PROTOCOL_TRANSITION')
    if (snapshot.stages.flatMap(stage => stage.attempts).flatMap(attempt => attempt.seats).some(candidate => candidate.ompChildId === event.payload.ompChildId)) fail(409, 'ompChildId already belongs to a seat', 'ILLEGAL_PROTOCOL_TRANSITION')
    seat.ompChildId = event.payload.ompChildId
    seat.status = 'running'
  } else if (event.type === 'evidence_added') {
    const seat = seatFor(snapshot, event)
    if (!seat || seat.status !== 'running' || !seat.ompChildId) fail(409, 'evidence requires a started exact seat attempt', 'ILLEGAL_PROTOCOL_TRANSITION')
    if (snapshot.evidence.some(item => item.evidenceId === event.payload.evidenceId)) fail(409, 'evidenceId already exists', 'ILLEGAL_PROTOCOL_TRANSITION')
    if (seat.evidenceIds.length > 0) fail(409, 'seat evidence is immutable and may be recorded once', 'ILLEGAL_PROTOCOL_TRANSITION')
    const expectedKind = event.stageId === 'candidates' ? 'candidate_answer' : 'judge_verdict'
    if (event.payload.kind !== expectedKind) fail(400, 'evidence kind does not match stage', 'INVALID_OUTPUT')
    if (expectedKind === 'candidate_answer') {
      boundedString(event.payload.content, MAX_CANDIDATE_BYTES, 'candidate answer')
      const aggregate = snapshot.evidence.filter(item => item.kind === 'candidate_answer').reduce((total, item) => total + bytes(item.content), 0) + bytes(event.payload.content)
      if (aggregate > MAX_CANDIDATE_AGGREGATE_BYTES) fail(413, 'aggregate candidate answers exceed 96000 UTF-8 bytes', 'INVALID_OUTPUT')
    } else {
      validateVerdict(event.payload.content, snapshot)
    }
    snapshot.evidence.push({
      evidenceId: event.payload.evidenceId, kind: event.payload.kind, content: clone(event.payload.content),
      ...(event.payload.artifactReferences ? { artifactReferences: clone(event.payload.artifactReferences) } : {}),
      stageId: event.stageId, seatId: event.seatId, attempt: event.attempt,
    })
    seat.evidenceIds.push(event.payload.evidenceId)
  } else if (event.type === 'seat_terminal') {
    const seat = seatFor(snapshot, event)
    if (!seat || TERMINAL_SEATS.has(seat.status)) fail(409, 'seat is already terminal or missing', 'ILLEGAL_PROTOCOL_TRANSITION')
    if (event.payload.status === 'succeeded') {
      const expectedKind = event.stageId === 'candidates' ? 'candidate_answer' : 'judge_verdict'
      if (!snapshot.evidence.some(item => item.stageId === event.stageId && item.seatId === event.seatId && item.attempt === event.attempt && item.kind === expectedKind)) {
        fail(409, 'successful seat requires exact-attempt evidence first', 'ILLEGAL_PROTOCOL_TRANSITION')
      }
    }
    if (!trusted && seat.status === 'pending' && !(event.payload.status === 'failed' && event.payload.reason === 'spawn_failed')) {
      fail(409, 'a pending seat can only terminalize as failed/spawn_failed', 'ILLEGAL_PROTOCOL_TRANSITION')
    }
    if (event.payload.reason === 'spawn_failed' && seat.ompChildId) fail(409, 'spawn_failed is only legal before seat_started', 'ILLEGAL_PROTOCOL_TRANSITION')
    seat.status = event.payload.status
    if (event.payload.reason !== undefined) seat.reason = event.payload.reason
  } else if (event.type === 'stage_terminal') {
    const stage = stageFor(snapshot, event.stageId)
    const attempt = attemptFor(snapshot, event.stageId, event.attempt)
    if (!stage || !attempt || attempt.status !== 'running' || attempt.seats.some(seat => !TERMINAL_SEATS.has(seat.status))) fail(409, 'stage barrier requires every seat terminal', 'ILLEGAL_PROTOCOL_TRANSITION')
    if (!trusted) {
      if (event.stageId === 'candidates') {
        const successes = attempt.seats.filter(seat => seat.status === 'succeeded').length
        const expected = successes > 0 ? 'succeeded' : 'failed'
        if (event.payload.status !== expected) fail(409, `Candidates must close as ${expected}`, 'ILLEGAL_PROTOCOL_TRANSITION')
      } else {
        const expected = attempt.seats[0].status === 'succeeded' ? 'succeeded' : 'failed'
        if (event.attempt === 1 && expected === 'failed') fail(409, 'failed Judge attempt 1 requires automatic attempt 2', 'ILLEGAL_PROTOCOL_TRANSITION')
        if (event.payload.status !== expected) fail(409, `Judge attempt must close as ${expected}`, 'ILLEGAL_PROTOCOL_TRANSITION')
      }
    }
    attempt.status = event.payload.status
    if (event.payload.reason !== undefined) attempt.reason = event.payload.reason
    stage.status = event.payload.status
    if (event.payload.reason !== undefined) stage.reason = event.payload.reason
  } else if (event.type === 'cancel_requested') {
    if (!trusted) fail(403, 'cancel_requested is server-owned', 'SERVER_EVENT_ONLY')
    if (snapshot.verdictEvidenceId) fail(409, 'a recorded verdict cannot be cancelled', 'PROTOCOL_RUN_TERMINAL')
    snapshot.cancelActionId = event.payload.actionId
    snapshot.status = 'cancelling'
  } else if (event.type === 'verdict_recorded') {
    if (snapshot.verdictEvidenceId) fail(409, 'verdict is already recorded', 'ILLEGAL_PROTOCOL_TRANSITION')
    const judge = stageFor(snapshot, 'judge')
    const evidence = snapshot.evidence.find(item => item.evidenceId === event.payload.evidenceId)
    const successfulAttempt = judge?.attempts.find(item => item.status === 'succeeded')
    const seat = successfulAttempt?.seats[0]
    if (judge?.status !== 'succeeded' || !evidence || evidence.kind !== 'judge_verdict' || evidence.stageId !== 'judge' || evidence.attempt !== successfulAttempt.attempt || evidence.seatId !== seat.seatId || seat.status !== 'succeeded') {
      fail(409, 'verdict must reference successful current Judge evidence', 'ILLEGAL_PROTOCOL_TRANSITION')
    }
    snapshot.verdictEvidenceId = evidence.evidenceId
    snapshot.verdict = clone(evidence.content)
    snapshot.verdictRecordedAt = record.at
  } else if (event.type === 'run_terminal') {
    if (!trusted && (event.payload.status === 'cancelled' || event.payload.status === 'interrupted')) fail(403, 'cancelled and interrupted tails are server-owned', 'SERVER_EVENT_ONLY')
    if (event.payload.status === 'succeeded') {
      if (!snapshot.verdictEvidenceId) fail(409, 'successful run requires a verdict', 'ILLEGAL_PROTOCOL_TRANSITION')
    } else {
      if (snapshot.verdictEvidenceId) fail(409, 'non-success terminal run forbids a verdict', 'ILLEGAL_PROTOCOL_TRANSITION')
      if (!trusted && event.payload.status === 'failed') {
        const candidates = stageFor(snapshot, 'candidates')
        const judge = stageFor(snapshot, 'judge')
        const zeroCandidates = candidates?.status === 'failed' && successfulCandidates(snapshot).length === 0
        const exhaustedJudge = judge?.attempts.length === 2 && judge.attempts[1].status === 'failed'
        if (!zeroCandidates && !exhaustedJudge) fail(409, 'failed run requires zero candidates or two failed Judge attempts', 'ILLEGAL_PROTOCOL_TRANSITION')
      }
    }
    snapshot.status = event.payload.status
    snapshot.finishedAt = record.at
    if (event.payload.reason !== undefined) snapshot.reason = event.payload.reason
  }

  snapshot.updatedAt = record.at
  snapshot.lastSeq = record.seq
  refreshSeats(snapshot)
  return snapshot
}

function persistedRequest(record) {
  const request = {
    schemaVersion: record.schemaVersion,
    eventId: record.eventId,
    runId: record.runId,
    type: record.type,
    ...(record.attempt !== undefined ? { attempt: record.attempt } : {}),
    ...(record.stageId !== undefined ? { stageId: record.stageId } : {}),
    ...(record.seatId !== undefined ? { seatId: record.seatId } : {}),
    payload: record.payload,
  }
  return request
}

function validatePersistedRecord(value, expected, identity) {
  exactKeys(value, ['schemaVersion', 'eventId', 'sessionId', 'ownerExecutionId', 'runId', 'seq', 'at', 'type', 'payload'], ['attempt', 'stageId', 'seatId'], 'persisted protocol event')
  const request = normalizeProtocolEvent(persistedRequest(value))
  if (value.sessionId !== identity.sessionId || value.runId !== identity.runId) fail(500, 'persisted protocol event identity mismatch', 'CORRUPT_PROTOCOL_LOG')
  boundedString(value.ownerExecutionId, 128, 'ownerExecutionId')
  if (!Number.isSafeInteger(value.seq) || value.seq !== expected) fail(500, 'persisted protocol event sequence is corrupt', 'CORRUPT_PROTOCOL_LOG')
  if (typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))) fail(500, 'persisted protocol event timestamp is corrupt', 'CORRUPT_PROTOCOL_LOG')
  return { ...request, sessionId: value.sessionId, ownerExecutionId: value.ownerExecutionId, seq: value.seq, at: value.at }
}

function pendingSnapshot(envelope) {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: envelope.sessionId,
    runId: envelope.runId,
    protocol: 'advisory',
    status: envelope.status,
    invocationMessageId: envelope.invocationMessageId,
    actionId: envelope.actionId,
    ...(envelope.ownerExecutionId ? { ownerExecutionId: envelope.ownerExecutionId } : {}),
    question: envelope.input.question,
    candidateCount: envelope.input.candidateCount,
    roles: clone(envelope.input.roles),
    roleMode: envelope.input.roleMode,
    ...(envelope.deliveryMessageId ? { deliveryMessageId: envelope.deliveryMessageId } : {}),
    timeoutMs: envelope.input.timeoutMs,
    ...(envelope.input.rubric !== undefined ? { rubric: envelope.input.rubric } : {}),
    ...(envelope.sourceRunId ? { sourceRunId: envelope.sourceRunId } : {}),
    ...(envelope.error ? { error: envelope.error } : {}),
    stages: [], seats: [], evidence: [], verdict: null, verdictEvidenceId: null,
    createdAt: envelope.createdAt,
    updatedAt: envelope.updatedAt,
    lastSeq: envelope.status === 'start_failed' ? 1 : 0,
  }
}


export class ProtocolRunStore {
  constructor({ root, onSnapshot = () => {}, now = () => new Date().toISOString(), uuid = randomUUID, readOnly = false } = {}) {
    this.root = root || path.join(process.env.HOME || '/home/user', '.feather', 'protocol-runs')
    this.onSnapshot = onSnapshot
    this.now = now
    this.uuid = uuid
    this.readOnly = readOnly
    this.snapshots = new Map()
    this.envelopes = new Map()
    this.eventIds = new Map()
    this.corrupt = new Map()
    this.withSessionLock = createKeyedLock()
    this.withRunLock = createKeyedLock()
    if (!readOnly) {
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 })
      fs.mkdirSync(this.tombstoneRoot(), { recursive: true, mode: 0o700 })
    }
    if (fs.existsSync(this.root)) this.recover()
  }

  key(sessionId, runId) { return `${sessionId}\u0000${runId}` }
  sessionDir(sessionId) { validateSessionId(sessionId); return path.join(this.root, sessionId) }
  logPath(sessionId, runId) { validateUuid(runId, 'runId'); return path.join(this.sessionDir(sessionId), `${runId}.jsonl`) }
  pendingPath(sessionId, runId) { return path.join(this.sessionDir(sessionId), `${runId}.pending.json`) }
  tombstoneRoot() { return path.join(this.root, '.tombstones') }
  tombstonePath(sessionId) { return path.join(this.tombstoneRoot(), `${createHash('sha256').update(validateSessionId(sessionId)).digest('hex')}.json`) }
  isTombstoned(sessionId) { return fs.existsSync(this.tombstonePath(sessionId)) }

  atomicJson(file, value) {
    if (this.readOnly) fail(403, 'protocol run store is read-only', 'READ_ONLY')
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 })
    const fd = fs.openSync(temporary, 'r')
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    fs.renameSync(temporary, file)
    const directory = fs.openSync(path.dirname(file), 'r')
    try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
  }

  recover() {
    for (const name of fs.readdirSync(this.root)) {
      if (name === '.tombstones') continue
      const dir = path.join(this.root, name)
      let stat
      try { stat = fs.statSync(dir) } catch { continue }
      if (!stat.isDirectory() || !SESSION_RE.test(name) || this.isTombstoned(name)) continue
      for (const file of fs.readdirSync(dir)) {
        const match = file.match(/^([0-9a-f-]{36})\.(pending\.json|jsonl)$/i)
        if (!match || !UUID_RE.test(match[1])) continue
        const runId = match[1]
        const key = this.key(name, runId)
        if (file.endsWith('.pending.json')) {
          try {
            const envelope = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
            this.validateEnvelope(envelope, name, runId)
            this.envelopes.set(key, envelope)
            if (!this.snapshots.has(key)) this.snapshots.set(key, pendingSnapshot(envelope))
          } catch (error) {
            this.corrupt.set(key, error instanceof Error ? error.message : String(error))
          }
        }
      }
      for (const file of fs.readdirSync(dir).filter(item => item.endsWith('.jsonl'))) {
        const runId = file.slice(0, -6)
        if (!UUID_RE.test(runId)) continue
        const key = this.key(name, runId)
        try {
          const loaded = this.loadLog(name, runId)
          if (loaded.snapshot) {
            this.snapshots.set(key, loaded.snapshot)
            if (!this.envelopes.has(key)) {
              const snapshot = loaded.snapshot
              this.envelopes.set(key, {
                schemaVersion: SCHEMA_VERSION,
                sessionId: name,
                runId,
                actionId: snapshot.actionId,
                invocationMessageId: snapshot.invocationMessageId,
                ...(snapshot.deliveryMessageId ? { deliveryMessageId: snapshot.deliveryMessageId } : {}),
                status: 'starting',
                input: {
                  protocol: 'advisory',
                  question: snapshot.question,
                  candidateCount: snapshot.candidateCount,
                  roles: clone(snapshot.roles),
                  roleMode: snapshot.roleMode,
                  timeoutMs: snapshot.timeoutMs,
                  ...(snapshot.rubric !== undefined ? { rubric: snapshot.rubric } : {}),
                },
                ...(snapshot.sourceRunId ? { sourceRunId: snapshot.sourceRunId } : {}),
                ownerExecutionId: snapshot.ownerExecutionId,
                createdAt: snapshot.createdAt,
                updatedAt: snapshot.updatedAt,
              })
            }
          }
          this.eventIds.set(key, loaded.eventIds)
          this.corrupt.delete(key)
        } catch (error) {
          this.snapshots.delete(key)
          this.corrupt.set(key, error instanceof Error ? error.message : String(error))
        }
      }
    }
  }

  validateEnvelope(envelope, sessionId, runId) {
    if (!isJsonRecord(envelope) || envelope.schemaVersion !== SCHEMA_VERSION || envelope.sessionId !== sessionId || envelope.runId !== runId) throw new Error('invalid pending protocol envelope')
    validateUuid(envelope.runId, 'runId')
    validateUuid(envelope.actionId, 'actionId')
    boundedString(envelope.invocationMessageId, 128, 'invocationMessageId')
    if (envelope.deliveryMessageId !== undefined) validateUuid(envelope.deliveryMessageId, 'deliveryMessageId')
    if (!['starting', 'start_failed'].includes(envelope.status)) throw new Error('invalid pending protocol status')
    const normalized = normalizeAdvisoryInput({
      protocol: envelope.input?.protocol,
      question: envelope.input?.question,
      candidateCount: envelope.input?.candidateCount,
      roleMode: envelope.input?.roleMode,
      timeoutMs: envelope.input?.timeoutMs,
      ...(envelope.input?.rubric !== undefined ? { rubric: envelope.input.rubric } : {}),
    })
    if (canonical(normalized) !== canonical(envelope.input)) throw new Error('pending protocol input is not normalized')
    if (envelope.sourceRunId !== undefined) validateUuid(envelope.sourceRunId, 'sourceRunId')
    if (envelope.ownerExecutionId !== undefined) boundedString(envelope.ownerExecutionId, 128, 'ownerExecutionId')
  }

  loadLog(sessionId, runId) {
    const file = this.logPath(sessionId, runId)
    let content = fs.readFileSync(file, 'utf8')
    if (content && !content.endsWith('\n')) {
      const lastNewline = content.lastIndexOf('\n')
      const tail = content.slice(lastNewline + 1)
      try {
        JSON.parse(tail)
        if (!this.readOnly) {
          const fd = fs.openSync(file, 'a')
          try {
            fs.writeSync(fd, '\n')
            fs.fsyncSync(fd)
          } finally { fs.closeSync(fd) }
        }
        content += '\n'
      } catch {
        const safeBytes = lastNewline < 0 ? 0 : Buffer.byteLength(content.slice(0, lastNewline + 1))
        if (!this.readOnly) fs.truncateSync(file, safeBytes)
        content = lastNewline < 0 ? '' : content.slice(0, lastNewline + 1)
      }
    }
    let snapshot = null
    const eventIds = new Map()
    const lines = content.split('\n').filter(Boolean)
    for (let index = 0; index < lines.length; index++) {
      let parsed
      try { parsed = JSON.parse(lines[index]) } catch { fail(500, `protocol log is corrupt before its tail at sequence ${index + 1}`, 'CORRUPT_PROTOCOL_LOG') }
      const record = validatePersistedRecord(parsed, index + 1, { sessionId, runId })
      const body = canonical(persistedRequest(record))
      if (eventIds.has(record.eventId)) fail(500, 'protocol log contains duplicate eventId', 'CORRUPT_PROTOCOL_LOG')
      eventIds.set(record.eventId, { body, seq: record.seq })
      snapshot = reduceProtocolRecord(snapshot, record, { trusted: record.type === 'cancel_requested' || ['cancelled', 'interrupted'].includes(record.payload?.status) })
    }
    if (snapshot) {
      snapshot.startedAt = snapshot.createdAt
      const envelope = this.envelopes.get(this.key(sessionId, runId))
      if (envelope) {
        snapshot.createdAt = envelope.createdAt
        if (envelope.deliveryMessageId) snapshot.deliveryMessageId = envelope.deliveryMessageId
      }
    }
    return { snapshot, eventIds }
  }

  get(sessionId, runId) {
    validateSessionId(sessionId); validateUuid(runId, 'runId')
    const key = this.key(sessionId, runId)
    const error = this.corrupt.get(key)
    if (error) return { schemaVersion: SCHEMA_VERSION, sessionId, runId, protocol: 'advisory', status: 'error', error, stages: [], seats: [], evidence: [], verdict: null, verdictEvidenceId: null, lastSeq: 0 }
    return clone(this.snapshots.get(key) || null)
  }

  list(sessionId, limit = 50) {
    validateSessionId(sessionId)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) fail(400, 'limit must be from 1 through 50', 'INVALID_PROTOCOL_INPUT')
    const snapshots = [...this.snapshots.entries()]
      .filter(([key]) => key.startsWith(`${sessionId}\u0000`))
      .map(([, snapshot]) => snapshot)
    const corrupt = [...this.corrupt.entries()]
      .filter(([key]) => key.startsWith(`${sessionId}\u0000`) && !this.snapshots.has(key))
      .map(([key, error]) => ({ schemaVersion: 1, sessionId, runId: key.split('\u0000')[1], protocol: 'advisory', status: 'error', error, stages: [], seats: [], evidence: [], verdict: null, verdictEvidenceId: null, lastSeq: 0 }))
    return snapshots.concat(corrupt)
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
      .slice(0, limit)
      .map(snapshot => clone(snapshot))
  }

  active() {
    return [...this.snapshots.values()]
      .filter(snapshot => !TERMINAL_RUNS.has(snapshot.status) && snapshot.status !== 'start_failed' && snapshot.status !== 'error')
      .map(snapshot => clone(snapshot))
  }

  unclaimedStarting(sessionId) {
    validateSessionId(sessionId)
    return [...this.snapshots.values()]
      .filter(snapshot => snapshot.sessionId === sessionId && snapshot.status === 'starting' && !snapshot.ownerExecutionId)
      .map(snapshot => clone(snapshot))
  }

  async createPending(sessionId, rawInput, { sourceRunId, runId = this.uuid(), actionId, invocationMessageId = this.uuid() } = {}) {
    validateSessionId(sessionId); validateUuid(runId, 'runId'); boundedString(invocationMessageId, 128, 'invocationMessageId')
    const input = normalizeAdvisoryInput(rawInput)
    const resolvedActionId = actionId || rawInput?.actionId || this.uuid()
    validateUuid(resolvedActionId, 'actionId')
    if (sourceRunId !== undefined) validateUuid(sourceRunId, 'sourceRunId')
    return this.withSessionLock(sessionId, async () => {
      if (this.isTombstoned(sessionId)) fail(410, 'session was deleted', 'PROTOCOL_SESSION_TOMBSTONED')
      const existing = [...this.snapshots.entries()]
        .find(([key, snapshot]) => key.startsWith(`${sessionId}\u0000`) && snapshot.actionId === resolvedActionId)?.[1]
      if (existing) {
        const same = existing.sourceRunId === sourceRunId && existing.question === input.question && existing.candidateCount === input.candidateCount && existing.roleMode === input.roleMode && existing.timeoutMs === input.timeoutMs && existing.rubric === input.rubric
        if (!same) fail(409, 'actionId already used with different launch input', 'PROTOCOL_ACTION_CONFLICT')
        return existing
      }
      const createdAt = this.now()
      const envelope = {
        schemaVersion: SCHEMA_VERSION, sessionId, runId, actionId: resolvedActionId, invocationMessageId,
        ...(UUID_RE.test(invocationMessageId) ? { deliveryMessageId: invocationMessageId } : {}),
        status: 'starting', input, ...(sourceRunId ? { sourceRunId } : {}), createdAt, updatedAt: createdAt,
      }
      this.validateEnvelope(envelope, sessionId, runId)
      fs.mkdirSync(this.sessionDir(sessionId), { recursive: true, mode: 0o700 })
      this.atomicJson(this.pendingPath(sessionId, runId), envelope)
      const key = this.key(sessionId, runId)
      this.envelopes.set(key, envelope)
      const snapshot = pendingSnapshot(envelope)
      this.snapshots.set(key, snapshot)
      this.onSnapshot(sessionId, clone(snapshot))
      return clone(snapshot)
    })
  }

  async markLaunchSent(sessionId, runId) {
    return this.updateEnvelope(sessionId, runId, envelope => ({ ...envelope, updatedAt: this.now() }))
  }

  async markStartFailed(sessionId, runId, reason = 'send_failed') {
    const safeReason = truncateUtf8(reason, MAX_REASON_BYTES)
    return this.updateEnvelope(sessionId, runId, envelope => ({ ...envelope, status: 'start_failed', error: safeReason, updatedAt: this.now() }))
  }

  async updateEnvelope(sessionId, runId, updater) {
    return this.withSessionLock(sessionId, () => this.withRunLock(this.key(sessionId, runId), async () => {
      const key = this.key(sessionId, runId)
      const envelope = this.envelopes.get(key)
      if (!envelope) fail(404, 'pending protocol run not found', 'PROTOCOL_RUN_NOT_FOUND')
      const next = updater(clone(envelope))
      this.atomicJson(this.pendingPath(sessionId, runId), next)
      this.envelopes.set(key, next)
      const current = this.snapshots.get(key)
      if (current?.lastSeq > 0) return clone(current)
      const snapshot = pendingSnapshot(next)
      this.snapshots.set(key, snapshot)
      this.onSnapshot(sessionId, clone(snapshot))
      return clone(snapshot)
    }))
  }

  async claim(sessionId, { ownerExecutionId, invocationMessageId, mode, input } = {}) {
    validateSessionId(sessionId); boundedString(ownerExecutionId, 128, 'ownerExecutionId'); boundedString(invocationMessageId, 128, 'invocationMessageId')
    if (mode !== undefined && mode !== 'create') fail(400, 'claim mode must be create', 'INVALID_PROTOCOL_INPUT')
    if (mode === 'create') {
      if (!input) fail(400, 'input is required for create mode', 'INVALID_PROTOCOL_INPUT')
      await this.createPending(sessionId, input, { invocationMessageId })
    } else if (input !== undefined) {
      fail(400, 'input is only allowed in create mode', 'INVALID_PROTOCOL_INPUT')
    }
    return this.withSessionLock(sessionId, async () => {
      if (this.isTombstoned(sessionId)) fail(410, 'session was deleted', 'PROTOCOL_SESSION_TOMBSTONED')
      let match = [...this.envelopes.values()].find(envelope => envelope.sessionId === sessionId && envelope.invocationMessageId === invocationMessageId)
      let rebound = false
      if (!match && mode !== 'create') {
        const unclaimed = [...this.envelopes.values()].filter(envelope => envelope.sessionId === sessionId && envelope.status === 'starting' && !envelope.ownerExecutionId)
        if (unclaimed.length > 1) fail(409, 'multiple unclaimed launch envelopes are ambiguous', 'PROTOCOL_CLAIM_AMBIGUOUS')
        if (unclaimed.length === 1) {
          match = unclaimed[0]
          rebound = true
        }
      }
      if (!match) fail(404, 'pending launch envelope not found', 'PROTOCOL_RUN_NOT_FOUND')
      if (match.status === 'start_failed') fail(409, 'pending launch has failed', 'PROTOCOL_START_FAILED')
      if (match.ownerExecutionId && match.ownerExecutionId !== ownerExecutionId) fail(409, 'launch envelope belongs to another execution', 'PROTOCOL_OWNER_CONFLICT')
      if (!match.ownerExecutionId) {
        match.ownerExecutionId = ownerExecutionId
        match.updatedAt = this.now()
        if (rebound) match.invocationMessageId = invocationMessageId
        this.atomicJson(this.pendingPath(sessionId, match.runId), match)
        this.envelopes.set(this.key(sessionId, match.runId), match)
        const snapshot = pendingSnapshot(match)
        this.snapshots.set(this.key(sessionId, match.runId), snapshot)
        this.onSnapshot(sessionId, clone(snapshot))
      }
      return clone(match)
    })
  }

  async appendEvent(sessionId, ownerExecutionId, rawEvent) {
    validateSessionId(sessionId); boundedString(ownerExecutionId, 128, 'ownerExecutionId')
    const event = normalizeProtocolEvent(rawEvent)
    return this.withSessionLock(sessionId, () => this.withRunLock(this.key(sessionId, event.runId), () => this.appendLocked(sessionId, ownerExecutionId, event, false)))
  }

  appendLocked(sessionId, ownerExecutionId, event, trusted) {
    if (this.isTombstoned(sessionId)) fail(410, 'session was deleted', 'PROTOCOL_SESSION_TOMBSTONED')
    const key = this.key(sessionId, event.runId)
    if (this.corrupt.has(key)) fail(500, 'protocol log is corrupt', 'CORRUPT_PROTOCOL_LOG')
    const body = canonical(event)
    const previous = this.snapshots.get(key)
    if (!trusted) {
      const boundOwner = previous?.ownerExecutionId || this.envelopes.get(key)?.ownerExecutionId
      if (boundOwner && boundOwner !== ownerExecutionId) fail(403, 'execution does not own this run', 'PROTOCOL_OWNER_CONFLICT')
    }
    const duplicate = this.eventIds.get(key)?.get(event.eventId)
    if (duplicate) {
      if (duplicate.body !== body) fail(409, 'eventId already used with different event body', 'PROTOCOL_EVENT_CONFLICT')
      return { snapshot: clone(this.snapshots.get(key)), seq: duplicate.seq, duplicate: true }
    }
    if (event.type === 'run_started') {
      const envelope = this.envelopes.get(key)
      if (!envelope || envelope.status === 'start_failed') fail(409, 'run_started requires a claimed pending launch', 'ILLEGAL_PROTOCOL_TRANSITION')
      if (envelope.ownerExecutionId !== ownerExecutionId) fail(403, 'execution does not own this run', 'PROTOCOL_OWNER_CONFLICT')
      const expected = {
        protocol: 'advisory', invocationMessageId: envelope.invocationMessageId, actionId: envelope.actionId,
        ...envelope.input, ...(envelope.sourceRunId ? { sourceRunId: envelope.sourceRunId } : {}),
      }
      if (canonical(event.payload) !== canonical(expected)) fail(409, 'run_started does not match claimed launch envelope', 'PROTOCOL_ACTION_CONFLICT')
      if (previous?.lastSeq > 0) fail(409, 'run already started', 'ILLEGAL_PROTOCOL_TRANSITION')
    } else {
      if (!previous || previous.lastSeq === 0) fail(404, 'protocol run has not started', 'PROTOCOL_RUN_NOT_FOUND')
      if (previous.ownerExecutionId !== ownerExecutionId && !trusted) fail(403, 'execution does not own this run', 'PROTOCOL_OWNER_CONFLICT')
    }
    const eventIds = this.eventIds.get(key) || new Map()
    const seq = (previous?.lastSeq || 0) + 1
    if (seq > MAX_EVENTS || (!trusted && seq > MAX_EVENTS - TRUSTED_TAIL_RESERVE)) fail(409, 'protocol run event limit reached', 'PROTOCOL_EVENT_LIMIT')
    const record = { ...event, sessionId, ownerExecutionId: previous?.ownerExecutionId || ownerExecutionId, seq, at: this.now() }
    const next = reduceProtocolRecord(previous?.lastSeq > 0 ? previous : null, record, { trusted })
    if (event.type === 'run_started' && previous) {
      next.createdAt = previous.createdAt
      next.startedAt = record.at
      if (previous.deliveryMessageId) next.deliveryMessageId = previous.deliveryMessageId
    }
    const directoryPath = this.sessionDir(sessionId)
    fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 })
    const logPath = this.logPath(sessionId, event.runId)
    const logExisted = fs.existsSync(logPath)
    const fd = fs.openSync(logPath, 'a', 0o600)
    try {
      fs.writeSync(fd, `${JSON.stringify(record)}\n`)
      fs.fsyncSync(fd)
    } finally { fs.closeSync(fd) }
    if (!logExisted) {
      const directory = fs.openSync(directoryPath, 'r')
      try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
    }
    eventIds.set(event.eventId, { body, seq })
    this.eventIds.set(key, eventIds)
    this.snapshots.set(key, next)
    this.onSnapshot(sessionId, clone(next))
    return { snapshot: clone(next), seq, duplicate: false }
  }

  async cancel(sessionId, runId, actionId) {
    validateSessionId(sessionId); validateUuid(runId, 'runId')
    return this.withSessionLock(sessionId, () => this.withRunLock(this.key(sessionId, runId), async () => {
      const snapshot = this.snapshots.get(this.key(sessionId, runId))
      if (!snapshot) fail(404, 'protocol run not found', 'PROTOCOL_RUN_NOT_FOUND')
      validateUuid(actionId, 'actionId')
      if (snapshot.status === 'cancelling') {
        if (snapshot.cancelActionId !== actionId) fail(409, 'cancel actionId conflicts with the active cancellation', 'PROTOCOL_ACTION_CONFLICT')
        return { run: clone(snapshot), transitioned: false }
      }
      if (TERMINAL_RUNS.has(snapshot.status) || snapshot.verdictEvidenceId) fail(409, 'protocol run cannot be cancelled', 'PROTOCOL_RUN_TERMINAL')
      if (!snapshot.ownerExecutionId || snapshot.lastSeq === 0 || snapshot.status !== 'running') {
        fail(409, 'only an active protocol run can be cancelled', 'ILLEGAL_PROTOCOL_TRANSITION')
      }
      const event = normalizeProtocolEvent({ schemaVersion: 1, eventId: this.uuid(), runId, type: 'cancel_requested', payload: { actionId } })
      return { run: this.appendLocked(sessionId, snapshot.ownerExecutionId, event, true).snapshot, transitioned: true }
    }))
  }

  markStartFailedUnlocked(sessionId, runId, reason) {
    const key = this.key(sessionId, runId)
    const envelope = this.envelopes.get(key)
    if (!envelope) fail(404, 'pending protocol run not found', 'PROTOCOL_RUN_NOT_FOUND')
    const next = { ...envelope, status: 'start_failed', error: reason, updatedAt: this.now() }
    this.atomicJson(this.pendingPath(sessionId, runId), next)
    this.envelopes.set(key, next)
    const snapshot = pendingSnapshot(next)
    this.snapshots.set(key, snapshot)
    this.onSnapshot(sessionId, clone(snapshot))
    return clone(snapshot)
  }

  async ownerTerminated(sessionId, ownerExecutionId, reason = 'owner_execution_terminated') {
    validateSessionId(sessionId); boundedString(ownerExecutionId, 128, 'ownerExecutionId')
    const candidates = [...this.envelopes.values()].filter(envelope => envelope.sessionId === sessionId && envelope.ownerExecutionId === ownerExecutionId)
    const results = []
    for (const envelope of candidates) {
      const result = await this.withSessionLock(sessionId, () => this.withRunLock(this.key(sessionId, envelope.runId), async () => {
        const key = this.key(sessionId, envelope.runId)
        let snapshot = this.snapshots.get(key)
        if (!snapshot || snapshot.status === 'start_failed' || TERMINAL_RUNS.has(snapshot.status)) return clone(snapshot)
        if (snapshot.lastSeq === 0) return this.markStartFailedUnlocked(sessionId, envelope.runId, 'owner_terminated_before_run_started')
        const append = (type, payload, fields = {}) => {
          const event = normalizeProtocolEvent({ schemaVersion: 1, eventId: this.uuid(), runId: envelope.runId, type, ...fields, payload })
          snapshot = this.appendLocked(sessionId, ownerExecutionId, event, true).snapshot
        }
        if (snapshot.verdictEvidenceId && stageFor(snapshot, 'judge')?.status === 'succeeded') {
          append('run_terminal', { status: 'succeeded' })
          return snapshot
        }
        const terminalStatus = snapshot.status === 'cancelling' ? 'cancelled' : 'interrupted'
        const seatReason = terminalStatus === 'cancelled' ? 'cancel_requested' : reason
        for (const stage of snapshot.stages) {
          const attempt = stage.attempts.at(-1)
          if (!attempt || attempt.status !== 'running') continue
          for (const seat of attempt.seats) {
            if (TERMINAL_SEATS.has(seat.status)) continue
            append('seat_terminal', { status: 'cancelled', reason: seatReason }, { attempt: attempt.attempt, stageId: stage.stageId, seatId: seat.seatId })
          }
          append('stage_terminal', { status: terminalStatus, reason: seatReason }, { attempt: attempt.attempt, stageId: stage.stageId })
        }
        append('run_terminal', { status: terminalStatus, reason: seatReason })
        return snapshot
      }))
      results.push(result)
    }
    return results
  }

  async deleteSession(sessionId) {
    validateSessionId(sessionId)
    return this.withSessionLock(sessionId, async () => {
      const tombstone = { schemaVersion: 1, sessionId, deletedAt: this.now() }
      this.atomicJson(this.tombstonePath(sessionId), tombstone)
      fs.rmSync(this.sessionDir(sessionId), { recursive: true, force: true })
      for (const key of [...this.snapshots.keys()]) if (key.startsWith(`${sessionId}\u0000`)) this.snapshots.delete(key)
      for (const key of [...this.envelopes.keys()]) if (key.startsWith(`${sessionId}\u0000`)) this.envelopes.delete(key)
      for (const key of [...this.eventIds.keys()]) if (key.startsWith(`${sessionId}\u0000`)) this.eventIds.delete(key)
      for (const key of [...this.corrupt.keys()]) if (key.startsWith(`${sessionId}\u0000`)) this.corrupt.delete(key)
    })
  }
}

export function createProtocolRunStore(options) {
  return new ProtocolRunStore(options)
}
