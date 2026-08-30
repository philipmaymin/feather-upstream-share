# Feather Terminal Capture — game plan

*2026-07-12. Drafted by Claude (Fable 5) + adversarial review by GPT 5.6 Soul via /sidecar (group acbcbfd8, thread in ~/.feather/sidecars/).*

## The idea

Every CLI agent (Claude Code, Codex, Gemini CLI, anything) renders through a terminal
framebuffer. Host each session in a virtual terminal we own, capture the byte stream
server-side, forward it to the web, and render it on the frontend **either** as a
faithful terminal (xterm.js) **or** re-assembled semantically however the user wants
(thinking tokens tinted, tool calls collapsed, custom layouts).

## Core architectural invariant (non-negotiable)

**Two projections of one session, both immutable at capture; interpretations are
derived and versioned.**

- **Terminal projection** — the raw PTY byte stream. Authoritative for "what the user
  saw", input, and replay.
- **Transcript projection** — the agent's own structured log (Claude Code `.jsonl`,
  Codex equivalent). Authoritative for semantics (thinking / tool_use / text).
  Feather already parses these — reader mode *evolves the existing transcript view*,
  it is not new.
- **Never join them to construct semantic blocks.** Timestamp/content joins break on
  buffering, redraws, wrapping, spinners, undisplayed events. Correlation is
  best-effort + confidence-scored, used **only for navigation** (click a transcript
  block → seek terminal replay to that moment). Timeline-level coupling only;
  cell-level provenance deferred until proven valuable.
- Derived artifacts (screen checkpoints, semantic blocks, presentation) reference
  source seq ranges and carry `parser_version`; re-enrichment is always possible.

## Event model (kept deliberately small — no Phase-0 scaffolding)

One TypeScript discriminated union, `schema_version: 1`, append-only JSONL metadata +
raw binary chunk sidecar per session:

```
{seq, monotonic_ns, wall_time, source: pty|transcript|control, kind, payload}
```

Record **every resize** (effective rows/cols) — replay is non-deterministic otherwise.
Periodic VT-emulator checkpoints stored separately so late joiners / reconnects get
checkpoint + subsequent bytes, never full replay. asciicast v2 is an **export format**,
not the internal log.

`CaptureBackend` interface from day one: `spawn/attach, output, input, resize,
snapshot, exit`. tmux backend first; node-pty backend later if tmux fails the gate.

## Transport

One WS per session. Ordered raw bytes, coalesced ~8–16 ms, binary frames, seq numbers.
Bounded per-client queues; never block the PTY on a slow viewer — drop deltas and force
checkpoint resync. Reader-mode clients subscribe to semantic events only, not
framebuffer churn. Reconnect-from-seq matters a lot: iOS Safari backgrounds tabs
constantly.

## Scoping decisions (single-user, self-hosted, behind Authelia)

- No spectator fleets, no controller audit trails, no retention machinery.
- **Keep**: controller-vs-spectator size ownership (iPad + desktop simultaneously is
  real; one controller by explicit choice or most-recent interaction; spectators can't
  resize), bounded-queue resync, note that PTY logs contain pasted secrets.
- Renderer plugins as plain local ES modules (Allan running his own JS in his own
  app). The real injection boundary is **terminal content**: allowlist escape
  sequences at ingest, render text as text, sanitize OSC.

## Phases

**SPIKE — tmux capture viability (S) — do first, architecture gate.**
Throwaway slice against a real running Claude Code session: attach mid-session,
bootstrap current screen (capture-pane) + stream bytes (pipe-pane vs control mode),
send keys/paste, resize, reconnect from mobile Safari, survive alt-screen redraw.
Instrument bytes/sec, attach gap, CPU, checkpoint-replay fidelity.
*Exit criteria — choose tmux iff:* (1) attach without missing bytes, (2) exact-enough
screen bootstrap, (3) interactive behavior/resizes preserved, (4) recovery after iOS
suspension via checkpoint+seq. If any fail systematically, don't patch around tmux —
own the PTY via node-pty. Everything above survives either answer.

**Phase 1 — Live terminal projection + thin input (M).**
tmux CaptureBackend, server-side VT model, checkpoint + coalesced binary deltas,
xterm.js tab in Feather, reconnect/resync, resize events, and *minimal typing* (the
real vertical slice is "see + type", not read-only).
*Done when:* open any existing tmux agent session from iPad, correct live terminal,
background/foreground without corruption.

**Phase 2 — Drive from browser, for real (M) — highest product value.**
Special keys, mobile IME/keyboard, bracketed paste, clipboard, Ctrl/Alt/Esc
affordances, controller/spectator ownership.
*Done when:* Allan completes a full Claude Code approval/edit cycle from the iPad
without SSH.

**Phase 3 — Durable replay + navigation (M).**
Checkpoints, seek by time/seq, replay speed / live-follow, asciicast export.
Correlate transcript timestamps to nearest PTY seq ranges; ship "click reader block →
seek terminal replay" (S, high confidence). Scrub terminal → highlight nearby
transcript event. No cell-hover provenance yet.

**Phase 4 — Presentation rules over the existing reader (S/M).**
Stable semantic block schema + CSS classes, declarative rules (match predicate →
collapse/hide/accent/density), persisted config, live preview. Adapters versioned per
agent/transcript schema. Explicit "unstructured terminal segment" blocks where the
transcript has gaps — never splice terminal guesses into structured turns.

**Phase 5 — Renderer ES-module plugins + OSC (M).**
Narrow versioned renderer contract; safe text/DOM APIs; allowlisted control sequences.
OSC 133/633-style stable-ID/boundary marks as an experimental adapter capability (and
possibly a tiny published spec) — not a prerequisite.

## Riskiest bet

That tmux is a lossless, non-perturbing capture/input boundary for already-running
agent TUIs. The spike answers it in a day or two; the CaptureBackend interface makes
the fallback (own PTY) cheap.
