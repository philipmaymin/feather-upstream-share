// OMP may prepend mutable metadata records (for example `type: "title"`) before
// the stable session header. Resume must search the bounded transcript head for
// the exact session id; it must never guess via `omp --continue`.
export function ompSessionIdFromHead(head) {
  for (const line of String(head || '').split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      if (entry?.type === 'session' && typeof entry.id === 'string' && entry.id) return entry.id
    } catch {
      // A truncated final line in the bounded head is expected; earlier complete
      // records are still safe to inspect.
    }
  }
  return null
}
