import type { ProtocolEvidenceSnapshot, ProtocolRunSnapshot, ProtocolSeatSnapshot, ProtocolVerdict } from '../api'

export interface ProtocolRunsState {
  byId: Record<string, ProtocolRunSnapshot>
  order: string[]
}

export const PROTOCOL_RUN_LIMIT: number
export function createProtocolRunsState(): ProtocolRunsState
export function reduceProtocolRunSnapshot(state: ProtocolRunsState, incoming: ProtocolRunSnapshot): ProtocolRunsState
export function replaceProtocolRuns(runs: ProtocolRunSnapshot[]): ProtocolRunsState
export function orderedProtocolRuns(state: ProtocolRunsState): ProtocolRunSnapshot[]
export function protocolRunView(run: ProtocolRunSnapshot): {
  state: ProtocolRunSnapshot['status']
  statusLabel: string
  summary: string
  stage: 'candidates' | 'judge'
  isActive: boolean
  isTerminal: boolean
  candidates: ProtocolSeatSnapshot[]
  judges: ProtocolSeatSnapshot[]
  counts: { total: number; successful: number; failed: number; complete: number; running: number }
  candidateEvidence: ProtocolEvidenceSnapshot[]
  failures: ProtocolSeatSnapshot[]
  verdict: ProtocolVerdict | null
  disagreementCount: number
  stages: Array<{ id: 'candidates' | 'judge'; label: string; status: string }>
}
export function runsForInvocation(runs: ProtocolRunSnapshot[], invocationMessageId: string): ProtocolRunSnapshot[]
