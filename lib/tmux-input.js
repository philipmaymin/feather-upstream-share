// Codex's TUI explicitly requests terminal bracketed-paste mode. tmux only
// emits the bracket control sequences when paste-buffer is given -p. Without
// them, a large paste is delivered as ordinary keystrokes in chunks and the
// following Enter can be consumed before the paste has finished.
//
// -r preserves linefeeds inside the bracketed paste instead of translating
// them into carriage returns that look like individual Enter keypresses.
export function codexPasteBufferArgs(target) {
  return ['paste-buffer', '-p', '-r', '-t', target]
}
