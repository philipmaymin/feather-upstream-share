// Agent TUIs use different prompt glyphs. Keeping prompt recognition pure
// makes resume readiness testable without launching a real terminal session.
export function paneHasReadyPrompt(content, agent = 'claude') {
  const lines = String(content || '').trimEnd().split('\n');
  const first = Math.max(0, lines.length - 12);
  for (let i = lines.length - 1; i >= first; i--) {
    const line = lines[i];
    if (agent === 'codex') {
      // Codex keeps a › composer visible when it is ready to accept or queue
      // the next message, including after a resumed transcript is restored.
      if (/^\s*›(?:\s|$)/.test(line)) return true;
      continue;
    }
    // Claude Code prompt, including its welcome-screen suggestion.
    if (/^\s*[>❯]\s*$/.test(line)) return true;
    if (/^\s*[>❯]\s+Try\s+"/.test(line)) return true;
  }
  return false;
}
