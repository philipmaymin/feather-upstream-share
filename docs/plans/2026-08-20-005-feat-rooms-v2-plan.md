# Rooms v2 — rooms as conventions on existing primitives

Status: SHIPPED 2026-08-20 — CLI, room folders, and rooms-home UI live
Date: 2026-08-20
Supersedes: the Buzz/Centaur multiplayer-room direction (2026-08-12). The
Buzz-backed Rooms tab was removed from main and archived on branch
`archive/buzz-rooms` (2026-08-20).

## The model

Rooms v1 failed because it made agents room *members* (multiplayer). The
correct model is one user's durable workspace with any number of
disposable-or-resumable sessions — and it needs almost no new machinery:

1. **A room is a folder**: `~/rooms/<name>/` with
   - `AGENTS.md` — two-line room identity + "follow ~/rooms/_doctrine.md".
     `CLAUDE.md` is a symlink to it, so Claude, Codex, and other harnesses
     all read the same room guidance. Switching harnesses means starting
     or resuming a chat in the same room; no migration feature is needed.
   - `notes.md` — the room's memory. Write-as-you-go; the chat is not the
     memory. Handoff/brain-swap/new-day are the same operation: distill to
     notes, start a fresh chat in the same cwd.
2. **Room chats use the room folder as their cwd.** Sessions group under
   the room by cwd — for free — and any session can be resumed or replaced.
3. **`~/rooms/_doctrine.md`** — shared workspace guidance: preserve durable
   context in notes, verify mechanically, and use delegation when useful.
   It does not assign a mandatory persona. WORKER-prefixed prompts keep
   focused hands from recursively delegating.

## The `room` CLI (feather/bin/room)

Optional, harness-neutral room and delegation tools. Any agent that can run
bash can use them; native harness tools remain available as a fast path.

- `room new <name>` / `room list`
- `room note "<text>"` — timestamped append to notes.md
- `room lookup "<q>"` — headless Haiku over transcripts + memory.jsonl
- `room council "<task>" [-n N]` — N sealed attempts, alternating
  claude/codex (`claude -p` / `codex exec`), then ONE judge (concurrent
  judges have produced garbage before). Journaled run dir; roll call names
  failures; empty output = FAILED, never "no findings".
- `room second-opinion "<q>"` — the other harness, prompted skeptically
- `room spawn "<task>"` — real Feather session in the room cwd (visible,
  resumable), demoted by a WORKER: prefix
- `room handoff` — distiller appends a validated `## Handoff` section to
  notes.md (degrade-don't-clobber: refuses rather than writes garbage)

**Anti-recursion, two layers:** workers always run in
`~/.feather/room-runs/<room>/<run>/` — outside `~/rooms/`, so they never
inherit AGENTS.md (both harnesses walk ancestor dirs) — and every worker
prompt starts with WORKER:, which the doctrine's first line honors.

## UI (shipped 2026-08-20)

Default view = full-screen rooms home (iMessage model, phone-first): one
card per room from `~/rooms/*/` (a dir with AGENTS.md) — status dot,
latest-message snippet (notes.md tail as fallback), expandable chat list,
new-chat buttons. Tap card → newest chat in the existing session view.
Sidebar untouched (Seats feedback stands); its "Feather" title returns to
the rooms home. Server: `GET /api/rooms` folder scan (sessions grouped by
cwd-derived projectId or `~/.feather/room-sessions.json` assignments),
`POST /api/rooms` scaffold, `POST /api/rooms/:name/assign` to pull an
existing session into a room. No registry, no relay.

## Pilot

`#boat` (created 2026-08-20). One room for a week before the second.

## Out of scope

Centaur/k3s, multi-user identity, Buzz anything (relay + host quadlets
still to be cleaned up separately), sidebar changes, approval gating.
