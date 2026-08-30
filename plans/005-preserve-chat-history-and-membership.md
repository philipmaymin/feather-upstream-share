# Plan 005: Make Room creation, resume, search, and deep links tell the truth

> **Executor instructions**: Follow the focused steps, modify only Scope, and stop on contract drift. Commit in the isolated worktree; do not update the plan index.
>
> **Drift check**: `git diff --stat ef32c25..HEAD -- frontend/src/App.tsx frontend/src/RoomsHome.tsx frontend/src/api.ts test/e2e/session-selection-race.spec.js test/e2e/rooms.spec.js test/e2e/feather.spec.js`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug, tests
- **Planned at**: commit `ef32c25`, 2026-08-30

## Why this matters

Five frontend divergences lie about identity or availability: Room creation swallows assignment failure but opens the chat as a member; send-triggered resume can repaint inactive from a stale list; an old search response can replace newer results; the advertised “Search all chats” invokes an 11-second Claude-only synchronous backend path; and a bounded-list refresh can regress exact deep-link metadata to `New session`.

## Current state

- `frontend/src/RoomsHome.tsx:141-154` uses `assignSessionToRoom(...).catch(() => {})`, then always opens.
- `frontend/src/App.tsx:1144-1162` correctly preserves explicit Resume acknowledgement; `1333-1341` resumes during outbox send then applies a stale session list without that preservation.
- `frontend/src/App.tsx:1075-1085` has no generation/abort guard for search. Its `searchSessions` transport calls Claude-only `/api/search`; live OMP title search returned nothing and blocked `/api/health` for roughly 11 seconds.
- `frontend/src/App.tsx:444-451,908-920` performs an exact lookup for deep links, but bounded-list replacement can still leave a generic fallback authoritative during races.
- Established convention: selection, Room Wiki, and Room refresh use generation IDs and latest-request-wins. Reuse it; do not add a state framework.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Install/build | `npm ci` | exit 0 |
| Selection/resume | `npx playwright test test/e2e/session-selection-race.spec.js` | all pass |
| Room journey | `npx playwright test test/e2e/rooms.spec.js` | all pass |
| Search/deep-link | `npx playwright test test/e2e/feather.spec.js --grep "search|deep-linked"` | focused tests pass |

## Scope

**In scope**:
- `frontend/src/App.tsx`
- `frontend/src/RoomsHome.tsx`
- `frontend/src/api.ts`
- `test/e2e/session-selection-race.spec.js`
- `test/e2e/rooms.spec.js`
- `test/e2e/feather.spec.js`

**Out of scope**:
- backend search performance/coverage (Plan 002)
- durable history cursor/pagination (deferred until Plan 002 contract)
- outbox storage format
- Room/Leader persistence schema
- broad App refactor

## Steps

### Step 1: Make Room creation membership truthful

Remove the swallowed assignment rejection. After session creation but failed assignment, do not call the normal successful open path or imply membership. Preserve the created ID and show a concrete recovery error/action allowing the human to open the ungrouped chat explicitly. Leader creation remains atomic through `roomRole`.

**Verify**: mock successful creation plus failed assignment; assert the chat is absent from Room history, the failure is visible with the created ID/recovery action, and normal success navigation did not run.

### Step 2: Reuse one resume acknowledgement transition

Extract the existing explicit Resume update into a small helper used by both explicit Resume and implicit outbox send. Mark the exact session active before stale fetch results can downgrade it. A stale list may refresh metadata but must not erase an acknowledged active state for the current identity.

**Verify**: send to an inactive chat, return a stale inactive list, and assert header/status remain active and the POST targets the exact selected ID.

### Step 3: Make sidebar search fast, truthful, and latest-query-wins

Until Plan 002 ships the complete index, stop calling the synchronous `/api/search` path from the sidebar. Search the existing all-harness recent session catalog through `/api/sessions?q=...&limit=300`, adapt result rendering to session-title matches, and change the placeholder/empty copy from “all chats” to “recent chat titles.” Do not claim message-content or complete-history coverage. Add an AbortController or monotonic generation so changing/closing search invalidates prior work and only the active query may update results/loading.

**Verify**: a current OMP title appears; no `/api/search` request occurs; copy says recent titles; resolving an older request after a newer one cannot replace results.

### Step 4: Preserve exact deep-link metadata

Once `findSessionMeta(id)` returns exact metadata for a selected ID, retain it until an equal-ID authoritative list entry replaces it. A list refresh that omits the selected ID must not regress title/agent/cwd to `New session` or another chat. Keep selection generation checks.

**Verify**: deep-link an older/pending chat, race exact metadata against bounded-list refreshes, and assert title/agent/cwd stay exact.

## Test plan

- failed Room assignment after creation is explicit/recoverable.
- explicit and implicit resume share acknowledgement semantics.
- search uses recent all-harness titles, is labeled honestly, never calls blocking `/api/search`, and is latest-query-wins.
- exact deep-link metadata survives omitted/stale list refresh.
- existing cross-chat selection lock still passes.

## Done criteria

- [ ] Room assignment failures are never swallowed.
- [ ] One helper owns Resume and send-triggered resume acknowledgement.
- [ ] Sidebar search is fast recent-title search across all harnesses, labeled honestly, with no `/api/search` call.
- [ ] Exact metadata cannot regress to generic fallback after list omission.
- [ ] Focused browser suites pass.
- [ ] No Scope violations.

## STOP conditions

- Assignment API does not preserve the created ID on failure; report the required backend contract.
- Resume semantics differ materially by harness.
- Fix requires a global state-management rewrite.
- Adapting result rendering requires source files outside Scope.

## Maintenance notes

Keep durable identity separate from bounded list presence. History pagination remains a verified defect: rendered `messages().length` includes optimistic rows and must be replaced only when Plan 002 provides an explicit durable cursor contract.
