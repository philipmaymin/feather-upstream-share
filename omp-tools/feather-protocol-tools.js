import { readFileSync } from 'node:fs'
import path from 'node:path'

export const PROTOCOL_LIMITS = Object.freeze({
  questionBytes: 20_000,
  rubricBytes: 8_000,
  candidateAnswerBytes: 12_000,
  aggregateCandidateBytes: 96_000,
  verdictBytes: 24_000,
  recommendationBytes: 12_000,
  disagreementSummaryBytes: 2_000,
  rankingRationaleBytes: 1_000,
  semanticPayloadBytes: 32_000,
  httpBodyBytes: 128_000,
  candidateMin: 2,
  candidateMax: 8,
  timeoutMinMs: 60_000,
  timeoutMaxMs: 30 * 60_000,
  maxDisagreements: 16,
  maxArtifactReferences: 16,
})

const textEncoder = new TextEncoder()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SENSITIVE_KEY = /token|secret|authorization|cookie|password/i
const EVENT_TYPES = new Set([
  'run_started',
  'stage_started',
  'seat_started',
  'evidence_added',
  'seat_terminal',
  'stage_terminal',
  'verdict_recorded',
  'run_terminal',
])

export class ProtocolInputError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ProtocolInputError'
  }
}

export function utf8Bytes(value) {
  return textEncoder.encode(value).byteLength
}

export function decodedJsonBytes(value) {
  const seen = new WeakSet()
  function measure(candidate) {
    if (candidate === null) return 4
    if (typeof candidate === 'string') return utf8Bytes(candidate)
    if (typeof candidate === 'boolean' || typeof candidate === 'number') return utf8Bytes(String(candidate))
    if (!candidate || typeof candidate !== 'object' || seen.has(candidate)) {
      throw new ProtocolInputError('payload must be finite acyclic JSON')
    }
    seen.add(candidate)
    let bytes = 2
    if (Array.isArray(candidate)) {
      for (const item of candidate) bytes += measure(item) + 1
    } else {
      for (const [key, item] of Object.entries(candidate)) bytes += utf8Bytes(key) + measure(item) + 2
    }
    seen.delete(candidate)
    return bytes
  }
  return measure(value)
}

function requirePlainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolInputError(`${name} must be an object`)
  }
  return value
}

function requireString(value, name, { maxBytes, uuid = false } = {}) {
  if (typeof value !== 'string' || !value) throw new ProtocolInputError(`${name} must be a non-empty string`)
  if (maxBytes !== undefined && utf8Bytes(value) > maxBytes) {
    throw new ProtocolInputError(`${name} exceeds ${maxBytes} decoded UTF-8 bytes`)
  }
  if (uuid && !UUID.test(value)) throw new ProtocolInputError(`${name} must be a UUID`)
  return value
}

function requireInteger(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ProtocolInputError(`${name} must be an integer from ${min} through ${max}`)
  }
  return value
}

function requireOnlyKeys(value, name, keys) {
  const allowed = new Set(keys)
  const unexpected = Object.keys(value).find((key) => !allowed.has(key))
  if (unexpected) throw new ProtocolInputError(`${name}.${unexpected} is not allowed`)
}

function optionalBoundedString(value, name, maxBytes) {
  if (value === undefined) return
  requireString(value, name, { maxBytes })
}

export function loadBridgeConfig(env = process.env, argv = process.argv) {
  const sessionDirIndex = argv.indexOf('--session-dir')
  const sessionDir = sessionDirIndex >= 0 && typeof argv[sessionDirIndex + 1] === 'string'
    ? argv[sessionDirIndex + 1]
    : null
  const url = env.FEATHER_BRIDGE_URL?.trim()
  const token = env.FEATHER_BRIDGE_TOKEN?.trim()
  const sessionId = env.FEATHER_SESSION_ID?.trim()
  if (url && token && sessionId) return { url, token, sessionId, sessionDir }
  if (!sessionDir) return null

  try {
    const stored = JSON.parse(readFileSync(path.join(sessionDir, '.feather-bridge.json'), 'utf8'))
    if (typeof stored?.url !== 'string' || !stored.url.trim()
      || typeof stored?.token !== 'string' || !stored.token.trim()
      || typeof stored?.sessionId !== 'string' || !stored.sessionId.trim()) return null
    return {
      url: stored.url.trim(),
      token: stored.token.trim(),
      sessionId: stored.sessionId.trim(),
      sessionDir,
    }
  } catch {
    return null
  }
}

export function protocolRunsUrl(config) {
  let url
  try {
    url = new URL(config.url)
  } catch {
    throw new Error('Feather protocol bridge is misconfigured')
  }
  const suffix = '/events'
  if (!url.pathname.endsWith(suffix)) throw new Error('Feather protocol bridge is misconfigured')
  url.pathname = `${url.pathname.slice(0, -suffix.length)}/protocol-runs`
  url.search = ''
  url.hash = ''
  return url
}

export function isParentRuntime(config, ctx) {
  if (!config?.sessionDir) return true
  const sessionFile = ctx?.sessionManager?.getSessionFile?.()
  if (typeof sessionFile !== 'string' || !sessionFile) return false
  return path.dirname(path.resolve(sessionFile)) === path.resolve(config.sessionDir)
}

export function ownerExecutionIdFromContext(ctx) {
  const branch = ctx?.sessionManager?.getBranch?.()
  if (!Array.isArray(branch)) throw new Error('Feather protocol owner execution is unavailable')
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index]
    if (entry?.type === 'message' && entry.message?.role === 'user' && typeof entry.id === 'string' && entry.id) {
      return entry.id
    }
  }
  throw new Error('Feather protocol owner execution is unavailable')
}

export function validateAdvisoryInput(input) {
  requirePlainObject(input, 'input')
  requireOnlyKeys(input, 'input', ['question', 'candidateCount', 'roleMode', 'timeoutMs', 'rubric'])
  requireString(input.question, 'input.question', { maxBytes: PROTOCOL_LIMITS.questionBytes })
  requireInteger(input.candidateCount ?? 4, 'input.candidateCount', PROTOCOL_LIMITS.candidateMin, PROTOCOL_LIMITS.candidateMax)
  if (input.roleMode !== undefined && input.roleMode !== 'diverse' && input.roleMode !== 'neutral') {
    throw new ProtocolInputError('input.roleMode must be diverse or neutral')
  }
  requireInteger(input.timeoutMs ?? 600_000, 'input.timeoutMs', PROTOCOL_LIMITS.timeoutMinMs, PROTOCOL_LIMITS.timeoutMaxMs)
  optionalBoundedString(input.rubric, 'input.rubric', PROTOCOL_LIMITS.rubricBytes)
  return {
    question: input.question,
    candidateCount: input.candidateCount ?? 4,
    roleMode: input.roleMode ?? 'diverse',
    timeoutMs: input.timeoutMs ?? 600_000,
    ...(input.rubric === undefined ? {} : { rubric: input.rubric }),
  }
}

export function validateClaimRequest(params, fallbackInvocationMessageId) {
  requirePlainObject(params, 'protocol_claim')
  requireOnlyKeys(params, 'protocol_claim', ['mode', 'invocationMessageId', 'input'])
  const mode = params.mode ?? 'claim'
  if (mode !== 'claim' && mode !== 'create') throw new ProtocolInputError('mode must be claim or create')
  const invocationMessageId = params.invocationMessageId ?? fallbackInvocationMessageId
  requireString(invocationMessageId, 'invocationMessageId', { maxBytes: 128 })
  if (mode === 'create' && params.input === undefined) throw new ProtocolInputError('input is required in create mode')
  if (mode === 'claim' && params.input !== undefined) throw new ProtocolInputError('input is forbidden in claim mode')
  return {
    ...(mode === 'create' ? { mode } : {}),
    invocationMessageId,
    ...(params.input === undefined ? {} : { input: validateAdvisoryInput(params.input) }),
  }
}

export function validateCandidateAnswer(value) {
  requirePlainObject(value, 'candidate answer')
  requireOnlyKeys(value, 'candidate answer', ['answer', 'artifactReferences'])
  requireString(value.answer, 'candidate answer.answer', { maxBytes: PROTOCOL_LIMITS.candidateAnswerBytes })
  if (value.artifactReferences !== undefined) {
    if (!Array.isArray(value.artifactReferences) || value.artifactReferences.length > PROTOCOL_LIMITS.maxArtifactReferences) {
      throw new ProtocolInputError(`candidate answer.artifactReferences must contain at most ${PROTOCOL_LIMITS.maxArtifactReferences} items`)
    }
    for (const [index, reference] of value.artifactReferences.entries()) {
      requireString(reference, `candidate answer.artifactReferences[${index}]`, { maxBytes: 2_000 })
    }
  }
  return value
}

export function validateJudgeVerdict(value, successfulSeatIds, evidenceIds) {
  requirePlainObject(value, 'judge verdict')
  requireOnlyKeys(value, 'judge verdict', ['ranking', 'recommendation', 'disagreements', 'confidence', 'citedEvidenceIds'])
  if (!Array.isArray(value.ranking) || value.ranking.length < 1 || value.ranking.length > PROTOCOL_LIMITS.candidateMax) {
    throw new ProtocolInputError(`judge verdict.ranking must contain one through ${PROTOCOL_LIMITS.candidateMax} seats`)
  }
  requireString(value.recommendation, 'judge verdict.recommendation', { maxBytes: PROTOCOL_LIMITS.recommendationBytes })
  if (!Array.isArray(value.disagreements) || value.disagreements.length > PROTOCOL_LIMITS.maxDisagreements) {
    throw new ProtocolInputError(`judge verdict.disagreements must contain at most ${PROTOCOL_LIMITS.maxDisagreements} items`)
  }
  if (!['low', 'medium', 'high'].includes(value.confidence)) {
    throw new ProtocolInputError('judge verdict.confidence must be low, medium, or high')
  }
  if (!Array.isArray(value.citedEvidenceIds)) throw new ProtocolInputError('judge verdict.citedEvidenceIds must be an array')

  const expectedSeats = successfulSeatIds === undefined ? null : new Set(successfulSeatIds)
  const allowedEvidence = evidenceIds === undefined ? null : new Set(evidenceIds)
  const ranked = new Set()
  for (const [index, item] of value.ranking.entries()) {
    requirePlainObject(item, `judge verdict.ranking[${index}]`)
    requireOnlyKeys(item, `judge verdict.ranking[${index}]`, ['seatId', 'rationale'])
    requireString(item.seatId, `judge verdict.ranking[${index}].seatId`, { maxBytes: 128 })
    requireString(item.rationale, `judge verdict.ranking[${index}].rationale`, { maxBytes: PROTOCOL_LIMITS.rankingRationaleBytes })
    if (ranked.has(item.seatId)) throw new ProtocolInputError('judge verdict.ranking contains a duplicate seatId')
    if (expectedSeats && !expectedSeats.has(item.seatId)) throw new ProtocolInputError('judge verdict.ranking contains an unsuccessful seat')
    ranked.add(item.seatId)
  }
  if (expectedSeats && (ranked.size !== expectedSeats.size || [...expectedSeats].some((seatId) => !ranked.has(seatId)))) {
    throw new ProtocolInputError('judge verdict.ranking must contain every successful candidate exactly once')
  }

  const checkEvidenceId = (evidenceId, name) => {
    requireString(evidenceId, name, { maxBytes: 128 })
    if (allowedEvidence && !allowedEvidence.has(evidenceId)) throw new ProtocolInputError(`${name} does not belong to a successful candidate`)
  }
  const cited = new Set()
  for (const [index, evidenceId] of value.citedEvidenceIds.entries()) {
    checkEvidenceId(evidenceId, `judge verdict.citedEvidenceIds[${index}]`)
    if (cited.has(evidenceId)) throw new ProtocolInputError('judge verdict.citedEvidenceIds contains a duplicate')
    cited.add(evidenceId)
  }
  for (const [index, disagreement] of value.disagreements.entries()) {
    requirePlainObject(disagreement, `judge verdict.disagreements[${index}]`)
    requireOnlyKeys(disagreement, `judge verdict.disagreements[${index}]`, ['summary', 'evidenceIds'])
    requireString(disagreement.summary, `judge verdict.disagreements[${index}].summary`, { maxBytes: PROTOCOL_LIMITS.disagreementSummaryBytes })
    if (!Array.isArray(disagreement.evidenceIds)) throw new ProtocolInputError(`judge verdict.disagreements[${index}].evidenceIds must be an array`)
    const disagreementEvidence = new Set()
    for (const [evidenceIndex, evidenceId] of disagreement.evidenceIds.entries()) {
      checkEvidenceId(evidenceId, `judge verdict.disagreements[${index}].evidenceIds[${evidenceIndex}]`)
      if (disagreementEvidence.has(evidenceId)) throw new ProtocolInputError(`judge verdict.disagreements[${index}].evidenceIds contains a duplicate`)
      disagreementEvidence.add(evidenceId)
    }
  }
  if (utf8Bytes(JSON.stringify(value)) > PROTOCOL_LIMITS.verdictBytes) {
    throw new ProtocolInputError(`judge verdict exceeds ${PROTOCOL_LIMITS.verdictBytes} decoded UTF-8 bytes`)
  }
  return value
}

function validateRoles(roles, candidateCount, roleMode) {
  if (!Array.isArray(roles) || roles.length !== candidateCount) {
    throw new ProtocolInputError('payload.roles must contain one resolved role for each candidate')
  }
  const diverse = ['Advocate', 'Skeptic', 'Operator', 'Contrarian']
  const seats = new Set()
  for (const [index, role] of roles.entries()) {
    requirePlainObject(role, `payload.roles[${index}]`)
    requireOnlyKeys(role, `payload.roles[${index}]`, ['seatId', 'role'])
    requireString(role.seatId, `payload.roles[${index}].seatId`, { maxBytes: 128 })
    requireString(role.role, `payload.roles[${index}].role`, { maxBytes: 120 })
    if (role.seatId !== `candidate-${index + 1}`) throw new ProtocolInputError('payload.roles must be in deterministic candidate seat order')
    const expectedRole = roleMode === 'neutral'
      ? `Independent ${index + 1}`
      : (diverse[index] ?? `Independent ${index + 1}`)
    if (role.role !== expectedRole) throw new ProtocolInputError('payload.roles does not match the deterministic role assignment')
    if (seats.has(role.seatId)) throw new ProtocolInputError('payload.roles contains a duplicate seatId')
    seats.add(role.seatId)
  }
}

function validateEventPlacement(event, { stage, seat, attempt }) {
  if (stage === false && event.stageId !== undefined) throw new ProtocolInputError(`stageId is forbidden for ${event.type}`)
  if (stage === true && event.stageId !== 'candidates' && event.stageId !== 'judge') {
    throw new ProtocolInputError(`stageId is required for ${event.type}`)
  }
  if (seat === false && event.seatId !== undefined) throw new ProtocolInputError(`seatId is forbidden for ${event.type}`)
  if (seat === true) requireString(event.seatId, 'seatId', { maxBytes: 128 })
  if (attempt === false && event.attempt !== undefined) throw new ProtocolInputError(`attempt is forbidden for ${event.type}`)
  if (attempt === true) {
    const max = event.stageId === 'judge' ? 2 : 1
    requireInteger(event.attempt, 'attempt', 1, max)
  }
}


function validateSeatBinding(event) {
  if (event.stageId === 'candidates' && !/^candidate-[1-8]$/.test(event.seatId)) {
    throw new ProtocolInputError('candidate stage seatId must be candidate-1 through candidate-8')
  }
  if (event.stageId === 'judge' && event.seatId !== `judge-${event.attempt}`) {
    throw new ProtocolInputError('judge stage seatId must match its attempt')
  }
}
export function validateProtocolEvent(params) {
  const event = requirePlainObject(params, 'protocol_event')
  requireOnlyKeys(event, 'protocol_event', ['schemaVersion', 'eventId', 'runId', 'type', 'attempt', 'stageId', 'seatId', 'payload'])
  if (event.schemaVersion !== 1) throw new ProtocolInputError('schemaVersion must be 1')
  requireString(event.eventId, 'eventId', { uuid: true })
  requireString(event.runId, 'runId', { uuid: true })
  if (!EVENT_TYPES.has(event.type)) throw new ProtocolInputError('type is not a supported protocol event')
  const payload = requirePlainObject(event.payload, 'payload')

  switch (event.type) {
    case 'run_started': {
      validateEventPlacement(event, { stage: false, seat: false, attempt: false })
      requireOnlyKeys(payload, 'payload', ['protocol', 'invocationMessageId', 'actionId', 'question', 'candidateCount', 'roles', 'roleMode', 'timeoutMs', 'rubric', 'sourceRunId'])
      if (payload.protocol !== 'advisory') throw new ProtocolInputError('payload.protocol must be advisory')
      requireString(payload.invocationMessageId, 'payload.invocationMessageId', { maxBytes: 128 })
      requireString(payload.actionId, 'payload.actionId', { uuid: true })
      if (payload.candidateCount === undefined || payload.roleMode === undefined || payload.timeoutMs === undefined) {
        throw new ProtocolInputError('payload.candidateCount, payload.roleMode, and payload.timeoutMs are required')
      }
      const input = validateAdvisoryInput({
        question: payload.question,
        candidateCount: payload.candidateCount,
        roleMode: payload.roleMode,
        timeoutMs: payload.timeoutMs,
        ...(payload.rubric === undefined ? {} : { rubric: payload.rubric }),
      })
      validateRoles(payload.roles, input.candidateCount, input.roleMode)
      if (payload.sourceRunId !== undefined) requireString(payload.sourceRunId, 'payload.sourceRunId', { uuid: true })
      break
    }
    case 'stage_started':
      validateEventPlacement(event, { stage: true, seat: false, attempt: true })
      requireOnlyKeys(payload, 'payload', [])
      break
    case 'seat_started':
      validateEventPlacement(event, { stage: true, seat: true, attempt: true })
      requireOnlyKeys(payload, 'payload', ['role', 'ompChildId'])
      requireString(payload.role, 'payload.role', { maxBytes: 120 })
      requireString(payload.ompChildId, 'payload.ompChildId', { maxBytes: 256 })
      validateSeatBinding(event)
      break
    case 'evidence_added': {
      validateEventPlacement(event, { stage: true, seat: true, attempt: true })
      requireOnlyKeys(payload, 'payload', ['evidenceId', 'kind', 'content', 'artifactReferences'])
      requireString(payload.evidenceId, 'payload.evidenceId', { maxBytes: 128 })
      if (payload.kind !== 'candidate_answer' && payload.kind !== 'judge_verdict') {
        throw new ProtocolInputError('payload.kind must be candidate_answer or judge_verdict')
      }
      validateSeatBinding(event)
      if ((event.stageId === 'candidates') !== (payload.kind === 'candidate_answer')) {
        throw new ProtocolInputError('payload.kind must match the event stage')
      }
      if (payload.kind === 'candidate_answer') {
        requireString(payload.content, 'payload.content', { maxBytes: PROTOCOL_LIMITS.candidateAnswerBytes })
      } else {
        validateJudgeVerdict(payload.content)
      }
      if (payload.artifactReferences !== undefined) {
        if (!Array.isArray(payload.artifactReferences) || payload.artifactReferences.length > PROTOCOL_LIMITS.maxArtifactReferences) {
          throw new ProtocolInputError(`payload.artifactReferences must contain at most ${PROTOCOL_LIMITS.maxArtifactReferences} items`)
        }
        payload.artifactReferences.forEach((reference, index) => requireString(reference, `payload.artifactReferences[${index}]`, { maxBytes: 2_000 }))
      }
      break
    }
    case 'seat_terminal':
      validateEventPlacement(event, { stage: true, seat: true, attempt: true })
      validateSeatBinding(event)
      requireOnlyKeys(payload, 'payload', ['status', 'reason'])
      if (!['succeeded', 'failed', 'timed_out', 'cancelled'].includes(payload.status)) throw new ProtocolInputError('payload.status is not a legal seat terminal status')
      optionalBoundedString(payload.reason, 'payload.reason', 2_000)
      break
    case 'stage_terminal':
      validateEventPlacement(event, { stage: true, seat: false, attempt: true })
      requireOnlyKeys(payload, 'payload', ['status', 'reason'])
      if (!['succeeded', 'failed', 'cancelled', 'interrupted'].includes(payload.status)) throw new ProtocolInputError('payload.status is not a legal stage terminal status')
      optionalBoundedString(payload.reason, 'payload.reason', 2_000)
      break
    case 'verdict_recorded':
      validateEventPlacement(event, { stage: false, seat: false, attempt: false })
      requireOnlyKeys(payload, 'payload', ['evidenceId'])
      requireString(payload.evidenceId, 'payload.evidenceId', { maxBytes: 128 })
      break
    case 'run_terminal':
      validateEventPlacement(event, { stage: false, seat: false, attempt: false })
      requireOnlyKeys(payload, 'payload', ['status', 'reason'])
      if (!['succeeded', 'failed', 'cancelled', 'interrupted'].includes(payload.status)) throw new ProtocolInputError('payload.status is not a legal run terminal status')
      optionalBoundedString(payload.reason, 'payload.reason', 2_000)
      break
  }

  if (decodedJsonBytes(payload) > PROTOCOL_LIMITS.semanticPayloadBytes) {
    throw new ProtocolInputError(`payload exceeds ${PROTOCOL_LIMITS.semanticPayloadBytes} decoded UTF-8 bytes`)
  }
  return event
}

export function sanitizeReceipt(value, secrets = []) {
  const secretValues = secrets.filter((secret) => typeof secret === 'string' && secret)
  const seen = new WeakSet()
  function visit(candidate, depth) {
    if (depth > 8) return null
    if (candidate === null || typeof candidate === 'boolean' || (typeof candidate === 'number' && Number.isFinite(candidate))) return candidate
    if (typeof candidate === 'string') {
      let result = candidate.slice(0, 24_000)
      for (const secret of secretValues) result = result.replaceAll(secret, '[redacted]')
      return result
    }
    if (!candidate || typeof candidate !== 'object' || seen.has(candidate)) return null
    seen.add(candidate)
    if (Array.isArray(candidate)) return candidate.slice(0, 100).map((item) => visit(item, depth + 1))
    const result = {}
    for (const [key, item] of Object.entries(candidate).slice(0, 100)) {
      if (SENSITIVE_KEY.test(key)) continue
      result[key] = visit(item, depth + 1)
    }
    return result
  }
  return visit(value, 0)
}

async function postJson(config, url, body, signal) {
  const encoded = JSON.stringify(body)
  if (utf8Bytes(encoded) > PROTOCOL_LIMITS.httpBodyBytes) {
    throw new ProtocolInputError(`request exceeds ${PROTOCOL_LIMITS.httpBodyBytes} decoded UTF-8 bytes`)
  }
  let response
  try {
    response = await globalThis.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Feather-Bridge-Token': config.token,
      },
      body: encoded,
      signal,
    })
  } catch (error) {
    if (signal?.aborted) throw new Error('Feather protocol request was cancelled')
    throw new Error('Feather protocol bridge is unavailable')
  }
  if (!response.ok) throw new Error(`Feather protocol request failed (HTTP ${response.status})`)
  if (response.status === 204) return {}
  try {
    return await response.json()
  } catch {
    throw new Error('Feather protocol bridge returned an invalid receipt')
  }
}

function safeToolResult(receipt) {
  return {
    content: [{ type: 'text', text: JSON.stringify(receipt) }],
    details: receipt,
  }
}

function requireRuntime(config, ctx) {
  if (!config) throw new Error('Feather protocol bridge is unavailable for this session')
  if (!isParentRuntime(config, ctx)) throw new Error('Feather protocol tools are parent-only')
}

function toolExecutionContext(third, fourth, fifth) {
  if (fourth?.sessionManager) return { ctx: fourth, signal: fifth }
  if (fifth?.sessionManager) return { ctx: fifth, signal: third }
  return { ctx: fourth ?? fifth, signal: fifth instanceof AbortSignal ? fifth : third }
}

export default function protocolToolsExtension(pi) {
  const z = pi.zod
  const config = loadBridgeConfig(process.env)
  const identifier = z.string().min(1).max(128)
  const advisoryInputSchema = z.object({
    question: z.string().min(1),
    candidateCount: z.number().int().min(PROTOCOL_LIMITS.candidateMin).max(PROTOCOL_LIMITS.candidateMax).optional(),
    roleMode: z.enum(['diverse', 'neutral']).optional(),
    timeoutMs: z.number().int().min(PROTOCOL_LIMITS.timeoutMinMs).max(PROTOCOL_LIMITS.timeoutMaxMs).optional(),
    rubric: z.string().min(1).optional(),
  })
  const resolvedRoleSchema = z.object({
    seatId: identifier,
    role: z.string().min(1).max(120),
  })
  const rankingSchema = z.object({
    seatId: identifier,
    rationale: z.string().min(1),
  })
  const disagreementSchema = z.object({
    summary: z.string().min(1),
    evidenceIds: z.array(identifier),
  })
  const judgeVerdictSchema = z.object({
    ranking: z.array(rankingSchema).min(1).max(PROTOCOL_LIMITS.candidateMax),
    recommendation: z.string().min(1),
    disagreements: z.array(disagreementSchema).max(PROTOCOL_LIMITS.maxDisagreements),
    confidence: z.enum(['low', 'medium', 'high']),
    citedEvidenceIds: z.array(identifier),
  })
  const eventPayloadSchema = z.object({
    protocol: z.literal('advisory').optional(),
    invocationMessageId: identifier.optional(),
    actionId: identifier.optional(),
    question: z.string().min(1).optional(),
    candidateCount: z.number().int().min(PROTOCOL_LIMITS.candidateMin).max(PROTOCOL_LIMITS.candidateMax).optional(),
    roles: z.array(resolvedRoleSchema).max(PROTOCOL_LIMITS.candidateMax).optional(),
    roleMode: z.enum(['diverse', 'neutral']).optional(),
    timeoutMs: z.number().int().min(PROTOCOL_LIMITS.timeoutMinMs).max(PROTOCOL_LIMITS.timeoutMaxMs).optional(),
    rubric: z.string().min(1).optional(),
    sourceRunId: identifier.optional(),
    role: z.string().min(1).max(120).optional(),
    ompChildId: z.string().min(1).max(256).optional(),
    evidenceId: identifier.optional(),
    kind: z.enum(['candidate_answer', 'judge_verdict']).optional(),
    content: z.union([z.string(), judgeVerdictSchema]).optional(),
    artifactReferences: z.array(z.string().min(1)).max(PROTOCOL_LIMITS.maxArtifactReferences).optional(),
    status: z.enum(['succeeded', 'failed', 'timed_out', 'cancelled', 'interrupted']).optional(),
    reason: z.string().min(1).optional(),
  })

  pi.registerTool({
    name: 'protocol_claim',
    label: 'Claim Protocol Run',
    description: 'Parent-only. Claim a Feather-issued Advisory launch envelope, or create one for the current Chat invocation. Returns a token-free stable receipt.',
    loadMode: 'essential',
    strict: true,
    parameters: z.object({
      mode: z.enum(['claim', 'create']).optional(),
      invocationMessageId: identifier.optional(),
      input: advisoryInputSchema.optional(),
    }),
    async execute(_toolCallId, params, third, fourth, fifth) {
      const { ctx, signal } = toolExecutionContext(third, fourth, fifth)
      requireRuntime(config, ctx)
      const ownerExecutionId = ownerExecutionIdFromContext(ctx)
      const request = validateClaimRequest(params, ownerExecutionId)
      const url = protocolRunsUrl(config)
      url.pathname += '/claim'
      const response = await postJson(config, url, { ownerExecutionId, ...request }, signal)
      const envelope = sanitizeReceipt(response.envelope ?? response, [config.token])
      const receipt = {
        ok: true,
        operation: 'protocol_claim',
        sessionId: config.sessionId,
        invocationMessageId: request.invocationMessageId,
        ...(typeof envelope?.runId === 'string' ? { runId: envelope.runId } : {}),
        envelope,
      }
      return safeToolResult(receipt)
    },
  })

  pi.registerTool({
    name: 'protocol_event',
    label: 'Record Protocol Event',
    description: 'Parent-only. Append one bounded Advisory lifecycle event to a claimed Feather run. The server assigns sequence and time.',
    loadMode: 'essential',
    strict: true,
    parameters: z.object({
      schemaVersion: z.literal(1),
      eventId: identifier,
      runId: identifier,
      type: z.enum([...EVENT_TYPES]),
      attempt: z.number().int().min(1).max(2).optional(),
      stageId: z.enum(['candidates', 'judge']).optional(),
      seatId: identifier.optional(),
      payload: eventPayloadSchema,
    }),
    async execute(_toolCallId, params, third, fourth, fifth) {
      const { ctx, signal } = toolExecutionContext(third, fourth, fifth)
      requireRuntime(config, ctx)
      const ownerExecutionId = ownerExecutionIdFromContext(ctx)
      const event = validateProtocolEvent(params)
      const base = protocolRunsUrl(config)
      base.pathname += `/${encodeURIComponent(event.runId)}/events`
      const response = sanitizeReceipt(await postJson(config, base, { ownerExecutionId, event }, signal), [config.token])
      const receipt = {
        ok: true,
        operation: 'protocol_event',
        runId: event.runId,
        eventId: event.eventId,
        ...(Number.isSafeInteger(response?.seq) ? { seq: response.seq } : {}),
        duplicate: response?.duplicate === true || response?.idempotent === true,
      }
      return safeToolResult(receipt)
    },
  })
}
