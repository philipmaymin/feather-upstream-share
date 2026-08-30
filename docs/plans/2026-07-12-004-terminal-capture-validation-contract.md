# Terminal Capture — Validation Contract v2 (ratified)

*2026-07-12. Drafted by Claude (Fable 5); independent draft + 12 amendments by GPT 5.6 Soul
(design peer); adversarial review by a dedicated validation critic. Companion to
[2026-07-12-003-feat-terminal-capture-plan.md](2026-07-12-003-feat-terminal-capture-plan.md).
Sidecar thread: group acbcbfd8, `~/.feather/sidecars/`.*

**Purpose:** the build is fully autonomous — no human babysitting. Progress is defined
*only* by these machine-checkable gates. Agent prose is never completion evidence.

## Code-grounded corrections to the feature plan

1. **Feather already has live see+type.** `server.js:2253–2326` accepts `/api/terminal`
   WS, spawns `node-pty('tmux attach')` (hardcoded 120×30), streams both ways;
   `frontend/src/components/Terminal.tsx` renders via **ghostty-web** (not xterm.js) with
   FitAddon + input + resize. Phase 1 is therefore **"replace the ephemeral per-WS
   attach transport with durable capture/checkpoint/resync"**, not "add live terminal".
   Rediscovering existing behavior is not a win.
2. **Prior art** (`~/cli2html`, `~/cli2html_old`, `~/autoweb-cli2html`): homegrown VT
   emulator + heuristic transform + 32k-line accreted ui.html; 418 keeps then a crash
   death-spiral; screenshot-LLM approval as the keep signal rewarded easy narrow wins
   over the hard TUI goal. Lessons encoded below: mature VT core, protocol fixtures not
   screenshots, hard external evaluator, spiral breaker, module boundaries.
3. **Security finding:** the current WS upgrade path (`server.js:2256`) is
   unauthenticated at the app layer (relies wholly on Authelia). G7 covers it.
4. Existing e2e mutates the real `~/.claude` and requires a manually-running server on
   :4870 — both are babysitting/contamination hazards; G9 fixes them.

## Global rules (apply to every gate)

- **One command:** `npm run gates` (full: `validate:terminal`). Exit 0 ⇔ every blocking
  gate passed. Hermetic: unique tmux socket + session names, temp HOME/data dirs,
  ephemeral free port, managed server boot with health readiness, frontend built, trap
  cleanup; **zero leaked tmux sessions / PTYs / listeners verified at exit**. Never
  touches real user state, credentials, Authelia, network, or live agents.
- **Normative workload:** a deterministic scripted TUI **fixture** emitting a numbered
  protocol corpus (UTF-8/CSI/OSC split across chunk boundaries; wide/combining
  graphemes; 16/256/truecolor SGR; cursor addressing; insert/delete/erase; scroll
  regions; alt-screen enter/exit; DECSC/DECRC; wrap; OSC title; bracketed paste on AND
  off; app-cursor mode; resize/SIGWINCH; CR progress; rapid redraw; input challenge
  nonces) with **named barriers** at which it declares golden canonical states.
- **Oracle hierarchy:** (1) fixture-authored golden cell grids — validated ONCE offline
  against **two independent mature emulators** before being frozen; (2) server VT grid
  == golden AND browser (ghostty) grid == golden, asserted **independently** via
  test-only normalized snapshot APIs; (3) server==client as transport-consistency
  check; (4) `tmux capture-pane -ep` as diagnostic evidence only — never the oracle.
- **Cell equality** = rows×cols of {grapheme, width/continuation, fg, bg, style flags,
  cursor pos/visibility, active buffer, input-relevant modes, title}. Never innerText,
  never pixels. Normalization (default colors, trailing blanks, ambiguous-width policy,
  scrollback in/out, TERM, locale, rows/cols) is written down and versioned.
- **Failure artifacts always:** event log, expected vs actual grid + first differing
  cell, WS seq trace, Playwright trace, process logs, tmux capture, metrics JSON.
- **No retries on correctness gates.** A flaky required gate fails (diagnostic rerun
  allowed, first-run result is the recorded result). Seeds fixed + recorded.
- **Real Claude/Codex never block.** One scheduled live-agent smoke, nonblocking.
- Screenshots / LLM visual judgment are **advisory evidence only**, never a keep signal
  (the cli2html failure mode).

## Feature gates

**G1 Fidelity.** Fixture corpus through capture → server VT and → browser; at every
barrier both grids equal golden per the oracle hierarchy above.

**G2 Capture completeness.** Capture is **always-on from session creation** — viewer
attach/detach must not start/stop it; assert output captured with zero viewers.
Monotonic non-repeating IDs + per-chunk payload hashes/lengths + control/resize event
counts across attach/detach boundaries; byte-for-byte raw comparison where the backend
promises raw; every ID exactly once, ordered — no dupes, no reorders. Blocking: 25
seeded boundary cases with deterministic barriers overlapping attach/bootstrap;
certification/nightly: 100+ randomized (seeds recorded).

**G3 Reconnect.** Kill the actual socket server-side/proxy-side at recorded seq (close
observed before further emission), emit past queue/checkpoint bounds while dead,
reconnect with stale seq. Invariants (not protocol shape): negotiated resume point, no
duplicate seq applied, contiguous accepted stream, final browser grid == golden,
live-follow resumes. Edge cases: stale-seq-before-retention, seq-ahead, malformed seq,
server restart during outage, two racing reconnects.

**G4 Replay determinism.** Baseline = fresh-process full replay from seq 0 with
checkpoints disabled. Checkpoint+suffix replay must equal baseline at many nontrivial
cut points — compared as canonical grids at intermediate barriers (incl. scrollback,
cursor, modes, title), not one opaque final hash. Corrupt/delete a checkpoint →
fallback to earlier checkpoint or seq-0 replay, never a wrong screen. Fresh temp HOME
per replay process. Resize events included. Replay speed/pause/seek→live covered.

**G5 Input bytes.** Raw-mode fixture logs exact bytes received. Playwright (Chromium +
WebKit) drives the real UI: printable, Enter/Esc/Tab/arrows/Ctrl chords, bracketed
paste with mode on and off, synthetic composition events, focus loss/refocus,
huge-paste limits. Assert **exactly-once** byte sequences. Spectator enforcement:
fixture byte log unchanged AND pane dimensions unchanged (server "rejected" response
alone is forgeable). Controller race/transfer/disconnect + resize storms covered.

**G6 Crash recovery.** Fault matrix: metadata record partial, binary chunk partial,
metadata-ahead-of-binary, binary-ahead-of-metadata, partial checkpoint, orphan temp
file, kill between paired writes — every offset for bounded framing records, seeded
samples inside large payloads. **Single required policy: recover the valid prefix**
(explicit typed corruption error only when no valid prefix exists — torn tails must
never brick startup). Post-recovery: seq strictly monotonic, append + replay still
work, no orphan references. No fsync/power-loss durability claims unless the atomic
write protocol itself is tested.

**G7 Security + isolation.** Malicious corpus (OSC 8 `javascript:`/`data:` URLs, OSC 52
clipboard read/write, title floods, window ops, DCS/APC/PM, malformed/unclosed/oversized
OSC, bidi/control chars, HTML/script-looking text) pushed through **every consumer**:
live terminal, checkpoint restore, replay, reader/rules view, plugin boundary, asciicast
export. Assert zero DOM script/navigation/clipboard/network effects anywhere;
allowlisted sequences still function; raw log preserves evidence unchanged. Plus:
app-layer authorization on the WS upgrade path and cross-session isolation (output/
input/checkpoints never cross session IDs).

**G8 Resource invariants (deterministic).** Pathological redraw fixture with defined
byte/event counts, one healthy + one stalled client: producer progress counter reaches
completion under a generous watchdog (never blocked by the stalled client); stalled
client stays under the configured queue byte cap, gets resync, converges; healthy
client contiguous throughout; no fd/timer/process growth across N connect/disconnect
cycles; steady-state heap growth bounded after warmup. Absolute RSS/latency/throughput
numbers are **nonblocking benchmark artifacts** (dedicated runner), never CI gates.
30-min lower-rate soak at certification for leaks.

**G9 Hermetic regression.** All unit tests + Playwright e2e green under the managed
hermetic boot (random port, temp HOME — migrate existing e2e off real `~/.claude`),
`retries: 0` for correctness, logs collected, guaranteed teardown.

**G10 WebKit compatibility + responsive layout** *(renamed honestly — this is not iOS
validation)*. Playwright WebKit project "webkit-mobile-simulation": layout at
phone/tablet viewports, touch event routing, synthetic visualViewport keyboard-safe
layout, forced socket kill while `hidden` → recovery on `pageshow` via G3 path.
**DECIDED 2026-07-12 by Allan: Option B — physical-iOS device-farm gate is blocking.**
A real iPad/iPhone Safari session (BrowserStack/Sauce/Appium-WebDriverAgent) must: open
the app, focus the terminal, type a fixture nonce with the software keyboard, background
10s, resume, assert ACK + resynced checkpoint, rotate, paste. This gate blocks Phase 2
certification. Prerequisite: a device-farm account + credentials (keyvault) and a
tunnel/exposure path for the hermetic test server — provisioning this is part of
Implementation Unit 0. The simulated WebKit tier remains as the fast inner-loop gate;
the device-farm gate runs at phase certification (not per-iteration) to bound cost and
flake exposure, with first-run-fail recorded per the no-retry rule.

**G11 Event schema.** Validation rejects invalid seq/resize/chunk refs; seq unique and
monotonic across restarts and across concurrent sessions.

**G12 Transcript authority.** Terminal capture failure/corruption cannot alter semantic
blocks; serialized source transcript bytes are never mutated by any capture, rules, or
correlation code (property-tested).

**G13 Correlation (Phase 3).** Synthetic transcript + PTY logs with fixed timestamps:
click block → replay seeks within stated tolerance; adversarial cases (duplicate text,
clock skew) yield low-confidence/no-match behavior, never wrong-but-confident jumps;
confidence never affects semantic content. asciicast export→re-import reproduces
text/timing within documented loss bounds.

**G14 Presentation rules (Phase 4).** Table-driven predicate/action/precedence tests;
invalid config → rollback to defaults; persistence across reload/restart; malicious
rule values render as text (no executable DOM); G12 invariant holds.

**G15 Plugins + OSC (Phase 5).** Schema-v1 contract tests; unsupported version rejected
deterministically; plugin throw → fallback UI, session unaffected; OSC stable-ID marks
correlate only marked ranges, unknown OSC handled per written policy; G7 corpus re-run
across the plugin boundary.

**G16 Lifecycle.** tmux session exit/recreate, feather server restart with live
sessions: capture resumes, logs uncorrupted, viewers recover.

**Gate→phase map.** Spike: G1+G2+input/resize subset, output = `backend-decision.json`
with measured pass/fail per criterion per candidate (current attach path tested FIRST,
then pipe-pane/control-mode/owned-PTY as needed — a typed rationale is required to skip
a candidate). P1: G1–G4, G6–G9, G11, G12, G16. P2: G5, G10, ownership. P3: G4, G6, G13.
P4: G14. P5: G15 + G7 expansion. Each phase has an explicit gate→requirement manifest.

## Autonomy harness (autoweb v2)

**H1 Loop.** Fresh worker per iteration; keep ⇔ evaluator-run gates green. Workers
never decide keep/revert.

**H2 External root of trust.** The evaluator (gate runner + fixtures + goldens +
manifest) must be outside the builder's *privilege boundary*, not merely outside its
worktree — a same-Unix-user home-dir evaluator is theater, since a dangerously-
permissioned builder can rewrite or chmod it. Required: a **separate OS principal**
— concretely, a dedicated evaluator container (peer container on the existing
10.88.0.x bridge, or a root-owned read-only mount) that pulls the builder's candidate
commit, runs gates from its own pinned read-only copy of the contract tree, and writes
the keep/revert verdict + receipt somewhere the builder cannot forge. Each receipt
records the isolation mechanism in use. Builder edits to `package.json` scripts,
playwright config, fixtures, or goldens in its worktree are irrelevant — the
evaluator's copies are authoritative. Gate amendments = versioned contract change:
hard stop, meta-review approval, re-pin hash, **re-run all prior gates**. (A checksum
manifest inside the repo is not protection.)

**H3 Anti-death-spiral (self-healing before human).** After 5 consecutive
crashes/reverts: preserve evidence → auto-revert to last green → bounded
diagnosis/replan worker rewrites the iteration focus → resume once. Only if that
recovery also fails: PushNotification to Allan (non-blocking) and pause that phase.
Never burn silently for 100+ iterations (cli2html lesson).

**H4 Anti-accretion by tripwire, not schedule.** Terminal-capture code lives in new
modules behind a boundary (NOT appended to the 2.3k-line server.js). Consolidation
iterations trigger on measured thresholds (duplication, per-module size, complexity,
changed-LOC), skippable only with recorded evidence. No mandatory every-Nth refactor.

**H5 Certification + receipts.** Per iteration: impacted-gate subset + one full
regression, first-run pass. Phase completion: full suite ×3 in fresh hermetic
environments (fixed seed + two rotating recorded seeds), cleanup verified, artifacts
archived. Phase DONE ⇔ `validation/terminal/<phase>.json` receipt validates: git SHA,
pinned gate-tree hash, fixture version + seeds, backend decision, per-gate results,
metrics, artifact paths. Allan gets one digest notification per phase.

**Implementation Unit 0** = build the evaluator + fixture + goldens + hermetic boot
first, gated by its own meta-checks (goldens cross-validated against two independent
emulators; hermeticity proven; leak detection proven by injecting a deliberate leak).

## Ratification

- Design peer (GPT 5.6 Soul): amendments 1–12 incorporated; final objection (H2 needed
  a separate OS principal, not a same-user home-dir evaluator) incorporated → SIGNED.
- Validation critic: v1 rejected; all named blockers (G1 oracle, G2 zero-viewer raw
  completeness, G3 invariants, G4 baseline, G6 single policy, G8 determinism, G9
  isolation/no-retry, external evaluator, missing G11–G16) incorporated in v2 → SIGNED.
- G10 decision: Allan chose **B** (real-device farm, blocking at phase certification)
  on 2026-07-12.
