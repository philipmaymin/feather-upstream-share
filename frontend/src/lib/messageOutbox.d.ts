export interface PendingMessageRecord {
  id: string
  sessionId: string
  text: string
  createdAt: number
  attempts: number
  error?: string
  lastAttemptAt?: number
}

export function messageOutboxKey(pathname?: string): string
export function listPendingMessages(storage?: Storage, pathname?: string): PendingMessageRecord[]
export function putPendingMessage(record: PendingMessageRecord, storage?: Storage, pathname?: string): PendingMessageRecord
export function patchPendingMessage(id: string, patch: Partial<PendingMessageRecord>, storage?: Storage, pathname?: string): PendingMessageRecord | null
export function deletePendingMessage(id: string, storage?: Storage, pathname?: string): void
