# Plan 002: Make every chat discoverable without blocking Feather

> **Executor instructions**: Follow each step and verification gate. Modify only Scope files. Stop on any STOP condition; do not replace the design with a synchronous scan. Commit in the isolated worktree and do not update the plan index.
>
> **Drift check**: `git diff --stat ef32c25..HEAD -- server-single.js lib frontend/src/App.tsx frontend/src/api.ts test/unit/api.test.js test/e2e/feather.spec.js`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: none
- **Category**: bug, performance
- **Planned at**: commit `ef32c25`, 2026-08-30

## Why this matters

Live `/api/search?q=festher` took about 11 seconds, returned no result for the current OMP chat, and blocked `/api/health` for the same 11 seconds. The sidebar silently caps the catalog at 300 sessions; requested limits above 300 still return 300 with no total/cursor. A human cannot reliably find older OMP/Codex chats, and using search temporarily freezes every chat/stream request.

## Current state

- `server-single.js:4573-4640` synchronously reads every Claude JSONL in full on the Node event loop. It never inspects OMP or Codex stores.
- `server-single.js:1423-1427` stores only `discoverSessions(300, null)` in the shared snapshot.
- `server-single.js:4643-4673` slices that cache and returns `{sessions}` without total, cap, or cursor.
- `server-single.js:1307-1340` applies project filtering before unified discovery, so project-filtered results omit OMP/Codex. Live `films` returned 94 Room chats but project-filtered session lookup returned none.
- `frontend/src/App.tsx:1075-1085` has no generation/abort guard once search starts.
- Existing safe async convention: selection and Room requests use generation IDs and discard stale responses. Reuse it.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Install/build | `npm ci` | exit 0 |
| Server API | `node --test test/unit/api.test.js test/unit/rooms.test.js` | all pass |
| Search E2E | `npx playwright test test/e2e/feather.spec.js --grep "search"` | focused tests pass |
| Syntax | `node --check server-single.js` | exit 0 |

## Scope

**In scope**:
- `server-single.js`
- `lib/session-catalog.js` (new, if needed)
- `lib/session-search-worker.js` (new, if needed)
- `frontend/src/api.ts`
- `frontend/src/App.tsx`
- `test/unit/api.test.js`
- `test/unit/rooms.test.js`
- `test/e2e/feather.spec.js`

**Out of scope**:
- message rendering
- transcript formats or mutation
- Room assignment/Leader semantics
- external search services/databases

## Required design

Build one incremental, all-harness session catalog. It must contain stable identity, harness, cwd/project, title, source path/mtime, and a bounded searchable text representation. Reconcile external files incrementally; do not synchronously traverse/read every historical transcript in an HTTP handler. Heavy initial/reconciliation work must run off the main Node event loop (worker thread or child process) and keep the last good catalog available.

Expose explicit cursor/total semantics for session enumeration. The current 300-entry fast snapshot may remain the startup hot set, but callers asking for older pages must receive deterministic results. Search must cover titles and message text for Claude, OMP, and Codex. Project filtering must apply after all-harness identity derivation.

## Steps

### Step 1: Characterize current breakage

Add fixtures containing Claude, OMP, and Codex sessions in one project plus more sessions than one page. Assert current-style project filtering/search would omit non-Claude chats, and define the new cursor/total response contract. Add an event-loop responsiveness assertion: while a deliberately slow search/reconciliation runs, `/api/health` must answer within a tight local bound.

**Verify**: new tests fail before implementation for the intended reasons.

### Step 2: Introduce the incremental catalog

Implement a single catalog module shared by `/api/sessions`, `/api/search`, Room required-ID lookup, and project filtering. Preserve the existing required-ID escape hatch for old assigned sessions. Catalog refresh must be coalesced, incremental by source path/mtime, and performed outside the request event loop. Parser errors keep the previous valid record and surface diagnostics; they do not erase sessions.

**Verify**: unit fixtures return all three harnesses, stable ordering, no duplicate IDs, and health remains responsive during refresh.

### Step 3: Add explicit pagination and totals

Return `{sessions,total,nextCursor}` (or an equally explicit stable cursor contract) from `/api/sessions`. Reject invalid cursors and limits above the supported maximum instead of silently truncating. Update `fetchSessions` callers without creating a second endpoint.

**Verify**: page through the entire fixture with no gaps/duplicates and exact total.

### Step 4: Replace synchronous global search

Route `/api/search` through the catalog/worker, covering all harnesses and historical pages. Preserve result snippets and match counts where available. Bound query length, result count, indexed text per session, and worker concurrency.

**Verify**: all-harness title/message queries pass; a health request remains responsive during search.

### Step 5: Guard frontend search results

Add a request generation or AbortController in `App.tsx`. Only the latest query may update results/loading. Show whether results are partial while initial catalog reconciliation is still running.

**Verify**: an out-of-order mocked response never replaces the newest query.

## Test plan

- Mixed Claude/OMP/Codex search by title and message.
- Project filter returns all three harnesses.
- Cursor traversal returns every fixture exactly once with total.
- Historical chat beyond hot 300 is discoverable.
- Unknown/excessive cursor/limit is explicit error.
- Search does not block health.
- Stale frontend responses are discarded.

## Done criteria

- [ ] No HTTP handler performs a synchronous all-transcript content scan.
- [ ] Search finds current and historical chats for all supported harnesses.
- [ ] Sessions enumeration has explicit total/cursor and no silent 300 cap.
- [ ] Project filtering includes all harnesses.
- [ ] Latest-query-wins frontend test passes.
- [ ] No Scope violations.

## STOP conditions

- The implementation requires changing transcript files.
- A proposed shortcut keeps synchronous full-history work in the request process.
- Session ordering cannot be made stable without a product decision; report the conflicting orderings.
- Existing required-ID Room history would be lost.

## Maintenance notes

One catalog must serve sidebar, Rooms, Feed, and search; a second independent index recreates today’s drift. Monitor reconciliation duration, indexed count, and last successful refresh in health diagnostics without exposing transcript content.
