# Plan 003: Delete a complete session identity without leaving ghost Rooms

> **Executor instructions**: Execute in order, verify every step, modify only Scope, and stop rather than guessing about ownership. Commit in the isolated worktree. Do not update the plan index.
>
> **Drift check**: `git diff --stat ef32c25..HEAD -- server-single.js lib/json-state.js test/unit/rooms.test.js test/unit/readOnlyCanary.test.js`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `ef32c25`, 2026-08-30

## Why this matters

Deleting an OMP chat currently removes one rollout and metadata but leaves older rollouts, its session directory, Room assignment, Leader/resident/pulse pointers, and Sidecar membership. Four live non-controller assignments already point to no discoverable chat. A deleted Leader can remain valid synthetically, block replacement, or reappear from an older rollout.

## Current state

- `server-single.js:5048-5070` deletes one `findJsonlPath`, metadata, receipts, and bridge runtime only.
- `server-single.js:459-467` returns only the newest OMP rollout from a directory that can hold several.
- Room coordination lives in `ROOM_ASSIGN_STATE`, `ROOM_LEADERS_STATE`, `ROOM_RESIDENTS_STATE`, and `ROOM_PULSES_STATE`; updates use the established validated JSON-state convention.
- `server-single.js:2944-2959` can validate a Leader from assignment plus remaining OMP directory/discovery.
- Live state contained four non-current-controller assignments that resolve to no session and an empty-success transcript.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Install/build | `npm ci` | exit 0 |
| Room identity tests | `node --test test/unit/rooms.test.js test/unit/readOnlyCanary.test.js` | all pass |
| API suite | `node --test test/unit/api.test.js` | all pass |
| Syntax | `node --check server-single.js` | exit 0 |

## Scope

**In scope**:
- `server-single.js`
- `lib/json-state.js` only if a reusable conditional mutation primitive is required
- `test/unit/rooms.test.js`
- `test/unit/readOnlyCanary.test.js`
- `test/unit/api.test.js`

**Out of scope**:
- bulk cleanup of unrelated filesystem paths
- UI redesign
- changing Room move/detach semantics
- deleting another session’s shared state

## Required invariant

Deletion is by Feather session identity, not by one transcript path. It must remove only pointers whose current value still names the deleted ID. If another operation replaced a Leader/pulse/resident before cleanup, deletion must preserve the replacement. Failure must be explicit; do not return success after partial durable cleanup.

## Steps

### Step 1: Add identity-complete deletion fixtures

Seed an OMP session with two rollout files, assignment, Leader pointer, resident pointer in another fixture Room, pulse ownership, Sidecar membership, metadata, receipt, bridge token, and tmux fixture. Delete it through the API. Assert every identity reference and the entire OMP session directory are gone, a replacement Leader remains appointable, and the UUID can be freshly created. Add Claude and Codex deletion cases that remove their mapped transcript without touching unrelated files.

**Verify**: focused tests fail on current code.

### Step 2: Implement ownership-aware coordination cleanup

Before removing transcripts, update assignments, Leaders, residents, and pulses with conditional key/value removal. Remove a pulse record only when `sessionId` matches; otherwise preserve its replacement. Remove affected Sidecar member/group state through existing Sidecar APIs rather than editing its JSON format ad hoc. Keep each document valid under its current validator.

**Verify**: Room tests pass and replacement pointers survive.

### Step 3: Remove the complete harness-owned transcript identity

- OMP: remove the Feather-owned `OMP_SESSIONS/<id>` directory recursively after validating it is exactly beneath the configured OMP root.
- Claude: remove only the exact `<id>.jsonl` returned by the Claude resolver.
- Codex: remove only the mapped exact rollout and clear mapping metadata.

Then clear metadata, receipts, bridge/protocol runtime, offsets, watchers, and caches. Order the operation so a failed transcript removal cannot be reported as success with pointers already silently lost; use explicit error reporting/rollback where needed.

**Verify**: all harness cases pass and unrelated fixture files remain byte-identical.

### Step 4: Reject unknown assignments and missing transcripts explicitly

At `/api/rooms/:name/assign`, require a known discoverable or explicit pending-bootstrap session. Unknown IDs must not become durable assignments. For `/messages`, distinguish a missing session identity from a valid empty/pending session; return an explicit 404 or typed pending response rather than generic empty success.

**Verify**: unknown assignment/message tests pass; a fresh transcriptless designated Leader remains a valid pending case.

### Step 5: Add a guarded reconciliation command/path for existing ghosts

Implement a dry-run-first reconciliation function that reports assignments/designations whose IDs are neither discoverable nor valid pending/controller identities. Applying cleanup must require explicit operator invocation and recheck ownership immediately before mutation. Do not auto-delete on snapshot read.

**Verify**: dry run identifies seeded ghosts without mutation; apply removes only them.

## Test plan

- Two-rollout OMP deletion.
- Leader/resident/pulse/assignment/Sidecar cleanup.
- Concurrent replacement pointer preserved.
- Claude/Codex exact deletion.
- Unknown assignment rejected.
- Missing identity differs from valid empty bootstrap.
- Dry-run reconciliation is nonmutating.

## Done criteria

- [ ] Deleted IDs cannot reappear or block recreation.
- [ ] No current replacement pointer is removed.
- [ ] Entire OMP identity directory is gone.
- [ ] Unknown assignments cannot be persisted.
- [ ] Missing messages are explicit, not empty success.
- [ ] Focused suites and syntax pass with no Scope violations.

## STOP conditions

- An OMP directory resolves outside the configured root.
- Codex mapping is ambiguous.
- Sidecar state has no ownership-aware removal API and adding one exceeds Scope.
- Atomic multi-document failure handling cannot be made explicit; report the needed transaction boundary.

## Maintenance notes

Every future durable session-owned store must join the same deletion contract and regression fixture. Reviewers should scrutinize path containment, conditional ownership checks, and partial-failure behavior.
