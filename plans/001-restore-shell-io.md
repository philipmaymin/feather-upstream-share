# Plan 001: Restore usable shell I/O and test the real interaction

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving on. Touch only files listed in Scope. If a STOP condition occurs, stop and report; do not improvise. Commit the work in the isolated worktree. Do not update `plans/README.md`; the reviewer owns it.
>
> **Drift check (run first)**: `git diff --stat ef32c25..HEAD -- server-single.js test/unit/readOnlyCanary.test.js test/e2e/mountedPrefix.spec.js`
> If any in-scope file changed, compare the Current state below with live code. A mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug, tests
- **Planned at**: commit `ef32c25`, 2026-08-30

## Why this matters

The live `/api/shell` WebSocket upgrades and then closes with code 1011, while `/api/health` advertises `shell: true`. Existing tests certify only a 101 upgrade. A release can therefore pass its checks while a human-visible terminal surface is unusable and an abandoned bash PTY may be spawned.

## Current state

- `server-single.js:5955-5972` has one `if (isShell)` block that spawns bash, then falls through into the session-terminal checks and tmux attach. The missing boundary is the defect.
- `test/unit/readOnlyCanary.test.js:294-296` checks only that the socket opens in writable mode.
- `test/e2e/mountedPrefix.spec.js:261-267` opens `/api/shell`, closes it immediately, and asserts only proxy status 101.
- The established server convention is one PTY per socket, killed from the existing `ws.on('close')` handler. Preserve that convention; do not add another shell transport.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install/build | `npm ci` | exit 0; frontend build completes |
| Focused unit | `node --test test/unit/readOnlyCanary.test.js` | all tests pass |
| Mounted-prefix browser | `npx playwright test test/e2e/mountedPrefix.spec.js --grep "production prefix"` | 1 test passes |
| Syntax | `node --check server-single.js` | exit 0 |

## Scope

**In scope**:
- `server-single.js`
- `test/unit/readOnlyCanary.test.js`
- `test/e2e/mountedPrefix.spec.js`

**Out of scope**:
- `frontend/src/components/Terminal.tsx`
- tmux terminal reconnect/replay behavior
- release scripts and health schema
- shell command features beyond existing login bash

## Git workflow

- Branch: `advisor/001-restore-shell-io`
- One commit: `Fix shell WebSocket I/O`
- Do not push.

## Steps

### Step 1: Make shell and session-terminal startup mutually exclusive

In `startTerminal`, retain the existing bash spawn for `isShell`. Put the `sessionId` validation, tmux readiness preparation, and tmux PTY spawn in the mutually exclusive non-shell branch. A shell connection must never require a session ID or create a tmux attachment. Do not duplicate the shared `onData`, `onExit`, queued-input, or close cleanup handlers.

**Verify**: `node --check server-single.js` → exit 0.

### Step 2: Replace handshake-only unit coverage with a nonce round trip

Extend the writable-mode WebSocket helper/test in `test/unit/readOnlyCanary.test.js`: connect to `/api/shell`, send a harmless `printf` command containing a unique nonce, collect output until the nonce appears, close, and assert a normal usable exchange. The test must fail on the current fall-through implementation. Keep the existing read-only rejection assertions.

**Verify**: `node --test test/unit/readOnlyCanary.test.js` → all pass.

### Step 3: Prove mounted-prefix shell I/O

Update the `/feather2/api/shell` section in `mountedPrefix.spec.js` to send and observe a unique nonce through the proxied WebSocket before closing. Keep the 101 routing assertion, but make nonce output the behavioral gate.

**Verify**: `npx playwright test test/e2e/mountedPrefix.spec.js --grep "production prefix"` → 1 pass.

## Test plan

- Writable `/api/shell` emits command output.
- Mounted-prefix `/feather2/api/shell` emits command output.
- Read-only shell still rejects.
- Near-match WebSocket paths still reject.
- Tests must fail when the non-shell branch is allowed to execute after bash spawn.

## Done criteria

- [ ] Shell and tmux startup are mutually exclusive.
- [ ] A nonce round trip passes in unit and mounted-prefix coverage.
- [ ] `node --check server-single.js` exits 0.
- [ ] No files outside Scope changed.

## STOP conditions

- Current `startTerminal` no longer matches the described fall-through shape.
- A nonce test requires changing client Terminal code or protocol framing.
- The writable fixture cannot execute a harmless command without changing global machine state.
- Any scoped verification fails twice.

## Maintenance notes

Review for exactly one PTY lifetime per socket. Future shell tests must verify output, not merely WebSocket upgrade. Terminal replay/resume is a separate, higher-risk concern and must not be folded into this fix.
