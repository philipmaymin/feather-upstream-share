const ACTIVE_RUN_STATUSES = new Set(['starting', 'pending', 'running', 'cancelling'])
const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'interrupted'])
const TERMINAL_SEAT_STATUSES = new Set(['succeeded', 'failed', 'timed_out', 'cancelled'])

export const PROTOCOL_RUN_LIMIT = 50

const DIVERSE_ROLES = ['Advocate', 'Skeptic', 'Operator', 'Contrarian']

function runId(run) {
  return typeof run?.runId === 'string' ? run.runId : ''
}

function sequence(run) {
  const value = Number(run?.lastSeq)
  return Number.isFinite(value) ? value : -1
}

function timestamp(run) {
  const raw = run?.updatedAt || run?.finishedAt || run?.startedAt || run?.createdAt
  const value = raw ? new Date(raw).getTime() : 0
  return Number.isFinite(value) ? value : 0
}

export function createProtocolRunsState() {
  return { byId: {}, order: [] }
}

export function reduceProtocolRunSnapshot(state, incoming) {
  const id = runId(incoming)
  if (!id) return state
  const current = state.byId[id]
  if (current && sequence(incoming) <= sequence(current)) return state

  const byId = { ...state.byId, [id]: incoming }
  const order = current ? [...state.order] : [id, ...state.order]
  order.sort((left, right) => timestamp(byId[right]) - timestamp(byId[left]))
  if (order.length > PROTOCOL_RUN_LIMIT) {
    const removed = order.splice(PROTOCOL_RUN_LIMIT)
    for (const staleId of removed) delete byId[staleId]
  }
  return { byId, order }
}

export function replaceProtocolRuns(runs) {
  return (Array.isArray(runs) ? runs : []).reduce(reduceProtocolRunSnapshot, createProtocolRunsState())
}

export function orderedProtocolRuns(state) {
  return state.order.map(id => state.byId[id]).filter(Boolean)
}



function advisoryRoles(candidateCount, roleMode = 'diverse') {
  const count = Math.max(2, Math.min(8, Number(candidateCount) || 4))
  if (roleMode === 'neutral') return Array.from({ length: count }, (_, index) => `Independent ${index + 1}`)
  return Array.from({ length: count }, (_, index) => DIVERSE_ROLES[index] || `Independent ${index + 1}`)
}

export function protocolSeatId(seat) {
  return String(seat?.seatId || '')
}


function stageId(value) {
  return String(value?.stageId || '')
}

function candidateSeat(seat) {
  return stageId(seat) === 'candidates'
}

function judgeSeat(seat) {
  return stageId(seat) === 'judge'
}

export function candidateSeats(run) {
  const declared = Array.isArray(run?.seats) ? run.seats.filter(candidateSeat) : []
  const byId = new Map(declared.map(seat => [protocolSeatId(seat), seat]))
  const roles = Array.isArray(run?.roles) && run.roles.length
    ? run.roles.map(item => item.role).filter(Boolean)
    : advisoryRoles(run?.candidateCount, run?.roleMode)
  const count = Math.max(roles.length, Number(run?.candidateCount) || 0)
  return Array.from({ length: count }, (_, index) => {
    const id = `candidate-${index + 1}`
    return byId.get(id) || {
      seatId: id,
      stageId: 'candidates',
      attempt: 1,
      role: roles[index] || `Independent ${index + 1}`,
      status: 'pending',
    }
  })
}

export function judgeSeats(run) {
  return (Array.isArray(run?.seats) ? run.seats : []).filter(judgeSeat)
}

function normalizeVerdictContent(content) {
  return content && typeof content === 'object' && !Array.isArray(content) ? content : null
}

export function protocolVerdict(run) {
  const direct = normalizeVerdictContent(run?.verdict)
  if (direct) return direct
  if (!run?.verdictEvidenceId) return null
  const evidence = (Array.isArray(run?.evidence) ? run.evidence : []).find(item => item?.evidenceId === run.verdictEvidenceId)
  return normalizeVerdictContent(evidence?.content)
}

function currentStage(run, candidates, judges) {
  const stages = Array.isArray(run?.stages) ? run.stages : []
  const active = stages.find(stage => ['pending', 'running'].includes(stage?.status))
  if (stageId(active) === 'judge') return 'judge'
  if (stageId(active) === 'candidates') return 'candidates'
  if (stages.some(stage => stageId(stage) === 'candidates' && stage.status === 'succeeded')) return 'judge'
  if (judges.length > 0) return 'judge'
  if (candidates.some(seat => !TERMINAL_SEAT_STATUSES.has(seat?.status))) return 'candidates'
  return run?.status === 'succeeded' ? 'judge' : 'candidates'
}

function normalizedStage(run, id, fallback) {
  const stages = Array.isArray(run?.stages) ? run.stages : []
  const attempts = stages.filter(stage => stageId(stage) === id)
  return attempts.at(-1)?.status || fallback
}

function statusLabel(status) {
  if (status === 'succeeded') return 'Complete'
  if (status === 'failed') return 'Failed'
  if (status === 'timed_out') return 'Timed out'
  if (status === 'cancelled') return 'Cancelled'
  if (status === 'interrupted') return 'Interrupted'
  if (status === 'running') return 'Running'
  return 'Waiting'
}

function runStatusLabel(status) {
  if (status === 'starting') return 'Starting'
  if (status === 'start_failed') return 'Start failed'
  if (status === 'pending') return 'Preparing'
  if (status === 'cancelling') return 'Stopping'
  return statusLabel(status)
}

export function protocolRunView(run) {
  const candidates = candidateSeats(run)
  const judges = judgeSeats(run)
  const successful = candidates.filter(seat => seat?.status === 'succeeded').length
  const failed = candidates.filter(seat => ['failed', 'timed_out', 'cancelled'].includes(seat?.status)).length
  const complete = successful + failed
  const running = candidates.filter(seat => ['pending', 'running'].includes(seat?.status)).length
  const failures = [...candidates, ...judges].filter(seat => ['failed', 'timed_out', 'cancelled'].includes(seat?.status))
  const candidateEvidence = (Array.isArray(run?.evidence) ? run.evidence : []).filter(item => item?.kind === 'candidate_answer')
  const verdict = protocolVerdict(run)
  const stage = currentStage(run, candidates, judges)
  const status = String(run?.status || 'starting')
  const reason = String(run?.reason || run?.error || '').trim()
  let summary

  if (status === 'starting') summary = 'Starting Advisory…'
  else if (status === 'start_failed') summary = reason ? `Could not start · ${reason}` : 'Could not start Advisory'
  else if (status === 'pending') summary = 'Preparing independent candidate seats…'
  else if (status === 'cancelling') summary = 'Stopping active seats…'
  else if (verdict) summary = `Verdict ready · ${successful}/${candidates.length} candidates succeeded`
  else if (status === 'succeeded') summary = `Verdict ready · ${successful}/${candidates.length} candidates succeeded`
  else if (status === 'cancelled') summary = `Stopped · ${candidateEvidence.length} candidate answer${candidateEvidence.length === 1 ? '' : 's'} retained`
  else if (status === 'interrupted') summary = `Interrupted · ${candidateEvidence.length} candidate answer${candidateEvidence.length === 1 ? '' : 's'} retained`
  else if (status === 'failed' && successful === 0) summary = 'No candidate answers succeeded'
  else if (status === 'failed') summary = `Judge failed · ${successful}/${candidates.length} candidate answers retained`
  else if (stage === 'judge') summary = `Judge synthesizing · ${successful}/${candidates.length} candidates complete`
  else summary = `Candidates working · ${complete}/${candidates.length} terminal · ${running} active`

  const candidateStageFallback = complete === candidates.length
    ? (successful > 0 ? 'succeeded' : 'failed')
    : stage === 'candidates' ? 'running' : 'pending'
  const judgeStageFallback = status === 'succeeded'
    ? 'succeeded'
    : stage === 'judge' && ACTIVE_RUN_STATUSES.has(status) ? 'running'
    : status === 'failed' && successful > 0 ? 'failed' : 'pending'

  return {
    state: status,
    statusLabel: runStatusLabel(status),
    summary,
    stage,
    isActive: ACTIVE_RUN_STATUSES.has(status),
    isTerminal: TERMINAL_RUN_STATUSES.has(status),
    candidates,
    judges,
    counts: { total: candidates.length, successful, failed, complete, running },
    candidateEvidence,
    failures,
    verdict,
    disagreementCount: Array.isArray(verdict?.disagreements) ? verdict.disagreements.length : 0,
    stages: [
      { id: 'candidates', label: 'Candidates', status: normalizedStage(run, 'candidates', candidateStageFallback) },
      { id: 'judge', label: 'Judge', status: normalizedStage(run, 'judge', judgeStageFallback) },
    ],
  }
}


export function runsForInvocation(runs, invocationMessageId) {
  return (Array.isArray(runs) ? runs : []).filter(run => run?.invocationMessageId === invocationMessageId)
}

