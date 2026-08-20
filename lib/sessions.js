// Session list helpers shared by server.js and its tests.

// A finished session's tmux pane lingers up to the idle-reaper window (~1h),
// so "tmux is alive" alone is NOT a good signal for the green "active" dot —
// it showed finished sessions as online long after they went idle. Require a
// recent JSONL write too.
export const ACTIVE_MS = 10 * 60 * 1000; // 10 min since last write

// Returns true only when there is a live tmux session for `id` AND its last
// real message was within `activeMs`. `activeTmux` is the Set of 8-char id
// prefixes from getActiveTmuxSessions(); `activityMs`/`now` are epoch millis.
export function sessionIsActive(activeTmux, id, activityMs, now, activeMs = ACTIVE_MS) {
  return activeTmux.has(id.slice(0, 8)) && (now - activityMs) < activeMs;
}

// Returns the epoch-ms timestamp if this parsed JSONL line is a real
// user/assistant message, else null. We deliberately ignore injected meta
// lines and the system/permission bookkeeping lines that a resumed agent
// appends to the JSONL while idle — those bump the file mtime but are not
// activity, and counting them lit the green dot on sessions idle for hours.
export function messageTimestampMs(d, agent) {
  if (!d || typeof d !== 'object') return null;
  const ms = (t) => { const n = Date.parse(t); return Number.isNaN(n) ? null : n; };
  if (agent === 'codex') {
    if (d.type === 'response_item' && d.payload && d.payload.type === 'message'
      && (d.payload.role === 'user' || d.payload.role === 'assistant') && d.timestamp) return ms(d.timestamp);
    return null;
  }
  if (agent === 'omp') {
    if (d.type === 'message' && d.message && (d.message.role === 'user' || d.message.role === 'assistant') && d.timestamp) return ms(d.timestamp);
    return null;
  }
  // claude
  if ((d.type === 'user' || d.type === 'assistant') && !d.isMeta && d.timestamp) return ms(d.timestamp);
  return null;
}

// Scan JSONL text (typically the file's tail) from the end and return the
// epoch-ms of the most recent real message, or null if none is found.
// `droppedLeadingPartial` is true when `text` is a mid-file tail whose first
// line may be a truncated record that must be skipped.
export function lastMessageMs(text, agent, droppedLeadingPartial = false) {
  const lines = text.split('\n');
  const start = droppedLeadingPartial ? 1 : 0;
  for (let i = lines.length - 1; i >= start; i--) {
    if (!lines[i]) continue;
    let d; try { d = JSON.parse(lines[i]); } catch { continue; }
    const t = messageTimestampMs(d, agent);
    if (t) return t;
  }
  return null;
}
