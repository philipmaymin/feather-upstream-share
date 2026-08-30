# Plan 004: Show the newest Room work and keep Room cache coherent

> **Executor instructions**: Follow each step and focused verification. Touch only Scope. Stop on drift or if the fix requires changing status vocabulary. Commit in the isolated worktree; do not update the plan index.
>
> **Drift check**: `git diff --stat ef32c25..HEAD -- server-single.js lib/snapshot-cache.js test/unit/rooms.test.js test/unit/snapshotCache.test.js`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `ef32c25`, 2026-08-30

## Why this matters

Room cards can display and sort by an older Leader even when another Room conversation has newer work. The Room snapshot also depends on a separate stale-while-refresh session cache; a Room refresh can mark itself fresh using stale sessions and ignore the session refresh that finishes afterward. These two defects make Rooms look inactive or outdated while real work exists.

## Current state

- `server-single.js:3264-3266` uses `leaderSession || sessions[0]` for `latest` and `updatedAt`. `sessions` is already ordered by real activity, so Leader identity wrongly overrides recency.
- Live `compelle-validator` returned a newer ordinary session but the Room preview/timestamp came from its older Leader.
- `server-single.js:1423-1428` and `3298` create independent 10-second session and Room snapshot caches.
- `server-single.js:3201-3207` builds Rooms from `sessionsSnapshotCache.get()`. A stale `get()` schedules session refresh but returns old data; the Room loader can then commit that old data as a fresh Room snapshot.
- `lib/snapshot-cache.js` correctly coalesces and preserves last-good values for one cache. Preserve that convention; fix dependency notification rather than introducing a third cache.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Install/build | `npm ci` | exit 0 |
| Focused unit | `node --test test/unit/rooms.test.js test/unit/snapshotCache.test.js` | all pass |
| API regression | `node --test test/unit/api.test.js` | all pass |
| Syntax | `node --check server-single.js` | exit 0 |

## Scope

**In scope**:
- `server-single.js`
- `lib/snapshot-cache.js` only if a reusable successful-refresh callback belongs there
- `test/unit/rooms.test.js`
- `test/unit/snapshotCache.test.js`
- `test/unit/api.test.js`

**Out of scope**:
- Leader/resident designation
- activity/status vocabulary (`working`, `ready`, `idle`)
- frontend layout
- pulse scheduling
- session catalog/search

## Steps

### Step 1: Characterize newer non-Leader activity

Extend the server-backed Room fixture with an older Leader and a newer ordinary or resident chat with distinct final text/timestamps. Assert `leaderSessionId` remains the Leader, while Room `latest`, `updatedAt`, and ordering use the newer human-facing session.

**Verify**: the new assertions fail before implementation.

### Step 2: Derive preview/recency from the newest human-facing session

Use `sessions[0]` for Room `latest` and `updatedAt`; Room grouping already excludes pulse implementation sessions and orders by activity. Continue using `leaderSession` only for Leader/resident/Sidecar identity. Keep notes as fallback when no human chat snippet exists.

**Verify**: `node --test test/unit/rooms.test.js` → all pass.

### Step 3: Add dependent-cache ordering coverage

With controlled scheduler/loader values, warm session and Room snapshots, expire both, trigger a Room read, let Room refresh consume the stale session value before session refresh completes, then finish session refresh. Assert the next Room read receives new session data without waiting a second TTL.

**Verify**: the new regression fails on current independent caches.

### Step 4: Couple successful session refresh to Room invalidation

Choose one existing-style dependency boundary: either give the session cache a successful-refresh callback that invalidates Rooms, or orchestrate session refresh completion in `server-single.js`. Transcript/title/activity mutation paths that invalidate sessions must also ensure the dependent Room snapshot cannot remain freshly stale. Preserve fast stale responses and coalescing.

Do not create a refresh loop: Room reads may use sessions, but Room invalidation must not recursively invalidate sessions.

**Verify**: `node --test test/unit/snapshotCache.test.js test/unit/rooms.test.js test/unit/api.test.js` → all pass.

## Test plan

- Older Leader + newer ordinary chat uses newer preview/timestamp but stable Leader ID.
- Room order follows newest human-facing activity.
- Notes remain fallback for no-chat Rooms.
- Controlled stale dependency ordering refreshes Rooms after sessions complete.
- Repeated reads coalesce and do not loop.

## Done criteria

- [ ] Leader identity no longer controls Room preview recency.
- [ ] A session refresh cannot leave the Room cache fresh with old session data.
- [ ] Existing stale-fast cache semantics remain.
- [ ] Focused tests and syntax pass.
- [ ] No files outside Scope changed.

## STOP conditions

- `sessions[0]` includes pulse/controller implementations in the drifted code.
- Cache coupling causes recursive refresh or synchronous request blocking.
- Fix requires changing status labels or Room identity semantics.
- Any focused test fails twice.

## Maintenance notes

Keep Room recency independent of Leader identity. The separate audited status-vocabulary problem remains deferred: raw tmux presence is still called `working` in some surfaces and must be addressed with a dedicated cross-API lifecycle design, not folded into this low-risk patch.
