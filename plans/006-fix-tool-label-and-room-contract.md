# Plan 006: Keep tool filenames visible and align the no-Leader Room test

> **Executor instructions**: Apply only the two focused corrections below in an isolated worktree. Run no validation; reviewer will. Commit and report exact files.
>
> **Drift check**: `git diff --stat d1d1f0a..HEAD -- frontend/src/lib/toolPresentation.js test/unit/toolPresentation.test.js test/e2e/toolImagePreview.spec.js test/e2e/rooms-home.spec.js`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: Plans 001, 003, 004, 005 integrated at `d1d1f0a`
- **Category**: bug, tests
- **Planned at**: commit `d1d1f0a`, 2026-08-30

## Why this matters

The full browser suite exposed two concrete gaps. `view_image` summaries truncate long absolute paths from the left and can hide the basename/extension (`tool-preview.…`), defeating the label’s purpose. The Rooms-home fixture still expects the retired `+ New OMP chat` behavior for a Room with no Leader, while the intentional current contract is explicit `+ Start OMP Leader`.

## Current state

- `frontend/src/lib/toolPresentation.js:93-103` truncates generic strings to the first 80 characters; long paths lose their meaningful filename.
- `toolImagePath` already identifies `view_image` paths at lines 219-227.
- `test/e2e/toolImagePreview.spec.js:43-50` requires the visible summary and preview label to retain `tool-preview.svg`; the integrated candidate fails this.
- `test/e2e/rooms-home.spec.js:61-96` provides only a pulse session/no Leader but expects `+ New OMP chat`; `RoomsHome` correctly renders `+ Start OMP Leader` and creates it atomically with `roomRole: leader`.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Build | `npm ci` | exit 0 |
| Tool unit | `node --test test/unit/toolPresentation.test.js` | all pass |
| Tool browser | `npx playwright test test/e2e/toolImagePreview.spec.js` | 1 pass |
| Room browser | `npx playwright test test/e2e/rooms-home.spec.js --grep "puts OMP"` | 1 pass |

## Scope

- `frontend/src/lib/toolPresentation.js`
- `frontend/src/components/MessageView.tsx`
- `test/unit/toolPresentation.test.js`
- `test/e2e/toolImagePreview.spec.js` only if expectation needs a platform-neutral path case
- `test/e2e/rooms-home.spec.js`

No other source or test files.

## Steps

1. For `view_image`/`viewImage`, present the path basename (platform-neutral `/` or `\\` separators) instead of the generic first-80-character prefix. Keep `toolImagePath` and preview routing unchanged. Add/extend the unit assertion with a deliberately long path whose basename is `tool-preview.svg`.
2. Render the inline `view_image` preview as a semantic button named `Open <basename> full screen`, with a useful image alt, while preserving the exact preview URL, dimensions, zoom affordance, and `onImageClick` lightbox behavior.
3. Update the no-Leader Rooms-home test to expect `+ Start OMP Leader`, click it, and assert the created session request uses OMP plus `roomName` and `roomRole: leader`. Do not change production Room behavior.

## Done criteria

- [ ] Long `view_image` summary contains the complete basename and extension.
- [ ] Existing tool preview is a semantic named button and opens the same local path/lightbox.
- [ ] No-Leader Room test asserts explicit atomic Leader creation.
- [ ] Only Scope files change.

## STOP conditions

- Tool path summary behavior is shared with a public payload rather than presentation only.
- The Room fixture unexpectedly includes a valid Leader.
- Fix requires files outside the expanded Scope.

## Maintenance notes

Human-facing path summaries should preserve the basename; prefix truncation is useful for commands, not filesystem identity. Keep no-Leader creation explicit and atomic.
