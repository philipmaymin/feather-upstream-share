// Feather chat ids are full UUID-like values. Their first eight characters are
// not unique (UUIDv7 ids created close together commonly share them), so new
// tmux sessions must retain the complete id.
export function tmuxSessionName(id) {
  return `f-${String(id)}`;
}

export function legacyTmuxSessionName(id) {
  return `f-${String(id).slice(0, 8)}`;
}

export function tmuxKeyMatchesSession(key, id) {
  return key === id || key === String(id).slice(0, 8);
}

// Infer the owner of an old f-<id8> session so a production upgrade can rename
// it without restarting the harness. Prefer an exact id present in tmux's
// original launch command; only fall back to the known catalog when unique.
export function inferLegacyTmuxOwner(name, startCommand, knownIds) {
  if (!/^f-[A-Za-z0-9_-]{8}$/.test(String(name))) return null;
  const prefix = String(name).slice(2);
  const candidates = [...new Set([...knownIds].map(String).filter(id => id.startsWith(prefix) && id.length > prefix.length))];
  const commandMatches = candidates.filter(id => String(startCommand || '').includes(id));
  if (commandMatches.length === 1) return commandMatches[0];

  // External Claude/Codex sessions may not have Feather metadata yet, but the
  // full resume id is still visible in pane_start_command.
  const tokens = String(startCommand || '').match(/[A-Za-z0-9][A-Za-z0-9_-]{8,}/g) || [];
  const direct = [...new Set(tokens.filter(token => token.startsWith(prefix) && token.length > prefix.length))];
  if (direct.length === 1) return direct[0];
  return candidates.length === 1 ? candidates[0] : null;
}
