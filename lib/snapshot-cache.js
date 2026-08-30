// Small stale-while-refresh cache for expensive synchronous snapshots.
// The first read is necessarily synchronous; once warm, stale readers get the
// last good value immediately while one deferred refresh rebuilds the cache.
export function createSnapshotCache(load, {
  ttlMs,
  now = Date.now,
  schedule = (fn) => setTimeout(fn, 100),
  onRefresh,
} = {}) {
  let snapshot;
  let loadedAt = 0;
  let refreshScheduled = false;

  function refresh() {
    try {
      const next = load();
      snapshot = next;
      loadedAt = now();
      onRefresh?.(next);
      return next;
    } finally {
      refreshScheduled = false;
    }
  }

  function scheduleRefresh() {
    if (refreshScheduled) return;
    refreshScheduled = true;
    schedule(() => {
      try { refresh(); }
      catch (error) { console.warn('[snapshot-cache] refresh failed:', error.message); }
    });
  }

  return {
    get() {
      if (snapshot === undefined) return refresh();
      if (now() - loadedAt >= ttlMs) scheduleRefresh();
      return snapshot;
    },
    update(updater) {
      const current = snapshot === undefined ? refresh() : snapshot;
      snapshot = updater(current);
      loadedAt = now();
      return snapshot;
    },
    refresh,
    invalidate() { loadedAt = Number.NEGATIVE_INFINITY; },
  };
}
