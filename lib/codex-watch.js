export function resolveCodexWatchId(uuid, meta = {}) {
  for (const [featherId, entry] of Object.entries(meta)) {
    if (entry?.agent === 'codex' && entry.codexUuid === uuid) return featherId
  }
  return uuid
}
