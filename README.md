# Feather

**A lightweight, mobile-first viewer and controller for AI coding agents.**

Open any Claude Code session on your phone. Read the conversation. Send messages. Watch the terminal. Resume old sessions or spawn new ones — instantly.

<p align="center"><img src="docs/screenshots/session.png" alt="A Claude Code session rendered like a texting app, on mobile" width="320" /></p>

## Sidecars — multi-agent, built in

Spin up a **second agent** with its own context, paired to your current session, and chat with it both ways. It's a Feather session like any other — persistent, resumable, visible in the UI — so you can read the conversation, jump in, or let two agents work it out.

![Two agents collaborating in the Sidecar tab](docs/screenshots/sidecar.png)

- **`/sidecar <task>`** — spawn a peer thread (Claude *or* Codex) and talk to it through the `sidecar` CLI. Messages are brokered by Feather and injected into each agent's tmux; a per-session lock prevents two senders from garbling a pane. → [`skills/sidecar`](skills/sidecar/SKILL.md)

Agents talk over a tiny CLI — messages are recorded to a file and injected into the peer's session:

```bash
# from inside any agent session:
sidecar post --to peer "Please review the current approach."
sidecar read        # print the whole thread
# the peer's reply is injected straight back into your session.
```

The peer works in an independent context while sharing a visible, durable thread with the primary session.

## Make it yours

The whole thing is a handful of files — one backend (`server-single.js` + focused `lib/` modules), one app shell, a renderer, and a terminal. Point Claude (or any AI agent) at this repo and tell it what you want:

- *"Add a cost tracker that shows tokens and dollars per session"*
- *"Add push notifications when an agent needs my attention"*
- *"Show me a diff view when Claude edits a file"*
- *"Add a dark/light theme toggle"*
- *"Group consecutive tool calls into a collapsible block"*
- *"Add Codex support — here's how their session files work"*
- *"Add a search bar that filters across all sessions"*
- *"Show a green typing indicator when Claude is responding"*
- *"Add keyboard shortcuts — j/k to navigate sessions, Enter to open"*

No abstractions to learn. No plugin API to read. One backend, one app shell, one renderer. You describe it, the agent builds it.

## Fork and share

Feather is designed to diverge. Fork it, make it yours, share what you build.

```bash
# Fork on GitHub, then:
git clone https://github.com/YOU/feather.git && cd feather
npm install && npm start
# hack away
```

**Pulling from other forks:**

```bash
# Add someone's fork as a remote
git remote add phil https://github.com/phil/feather.git
git fetch phil

# See what they've been up to
git log phil/main --oneline

# Grab specific commits
git cherry-pick <sha>

# Or merge everything
git merge phil/main
```

**Contributing back:**

Open a PR to `inceptel/feather` from your fork. Or don't — your fork is yours.

## Why

You're running Claude Code on a remote machine. You want to check on it from your phone, your iPad, another laptop. You want to send a follow-up message without SSH-ing in. You want to see the conversation rendered beautifully — like a texting app, not a terminal dump.

Feather reads Claude's raw JSONL session files, streams updates via SSE, and connects to tmux sessions via WebSocket terminals. No database. No build pipeline beyond Vite. Just `node server-single.js`.

### OMP live execution mirror

OMP sessions remain normal interactive TUI processes in tmux, so Terminal mode
is always available for direct intervention. A bounded protocol-v4 extension
mirrors live reasoning, tool start/update/end events, Todo state, approvals,
jobs, and nested subagent events into Chat. **Details** renders the parent run as
one chronological timeline; each subagent is a selectable child with its own
Todo and execution inspector. Current state is replayed after browser reconnects,
while the durable JSONL transcript remains the historical source of truth.

## Rooms — durable workspaces

A Room is a folder under `~/rooms/` that gives related Feather chats a shared
working directory and durable knowledge. Each contains `AGENTS.md`, a matching
`CLAUDE.md` symlink, `notes.md` for working evidence, and curated `wiki/` pages.
Rooms do not impose a generic agent persona: start or resume the Claude, Codex,
or OMP sessions that fit the work.

Each Room has one durable **Leader**: the single user-facing conversation that
answers directly or synthesizes contributions from the Room. Tapping the Room
always opens that Leader. A missing, archived, or otherwise stale Leader is
repaired to a compatible durable session rather than silently routing the user
to whichever chat spoke most recently.

Rooms may also keep permanent **residents** with named roles and harness/model
choices. The resident roster survives process restarts and is synchronized into
the Room's durable Sidecar group. Leader-to-resident and resident-to-Leader
messages use that visible thread, so agent-to-agent delivery has one canonical,
human-readable record rather than a hidden parallel channel.

By default, the caretaker checks each inactive Room every 15 minutes. It records
evidence for what it actually inspected, repairs stale leadership, and distills
durable meaning from `notes.md`, Room events, updates, and session history into
the Wiki. Pause or resume caretaker work from the Room or with `room pause` and
`room wake`.

The standalone Room **Updates** tab and unread badge are retired; their content
is folded into the curated Wiki. `updates.jsonl`, the Room updates API, and
`room update`/`room updates` remain supported because Fledge consumes
timeline-ready Room dispatches. Agents should keep raw working evidence in
`notes.md` and let the caretaker maintain the human-facing synthesis.

Agents can run `room complain "..."` to append recurring annoyances to
`#friction`; `#meta` remains separate for lessons shared across Rooms. Optional
delegation commands include `room council`, `room lookup`,
`room second-opinion`, and `room spawn`.

On `app.feather.plus`, Fledge remains the landing surface and keeps feed
reactions and comments in `feed-interactions.json`. Other hosts remain
Rooms-first.

For finite autonomous work in Codex, the recommended path is `$goal-prep`
followed by `/goal`: prepare a bounded, verifiable goal, then let the Codex goal
session run it.

## Agent capabilities

Install Feather and Sidecar for Claude and Codex, Council plus Feather protocol
tools for OMP, and the `room`, `sidecar`, `refeather`, `refeather-fleet`, and
`feather-instance` CLIs through the guarded installer. Point all managed links
at the stable `current` release so one promotion updates server and agent
capabilities together:

```bash
bin/refeather install-capabilities \
  --release /opt/feather/releases/<commit> \
  --target-root /opt/feather/current
```

The installer is idempotent. It never overwrites a file or foreign symlink;
conflicts are copied to a timestamped evidence directory and installation
stops with cleanup guidance. Ensure `~/.local/bin` is on the environment used
to spawn Claude, Codex, and OMP sessions.

- [`/sidecar`](skills/sidecar/SKILL.md) — spawn a paired peer agent thread and chat both ways.
- [`/feather`](skills/feather/SKILL.md) — manage the running Feather server (status, logs, quick links, deploy).

## Quick start

```bash
npm install inceptel/feather
cd node_modules/feather && npm start
```

Or from source:

```bash
git clone https://github.com/inceptel/feather.git && cd feather
npm install    # installs deps + builds frontend automatically
npm start      # → Feather on http://localhost:4870
```

## Persistent state

By default this single-server build keeps instance metadata under `~/.feather`
and uploads under `~/feather-uploads`, preserving its established layout. Set
`FEATHER_STATE_DIR` to an absolute path to consolidate both beneath one durable
root and make release checkouts disposable:

```bash
FEATHER_STATE_DIR=/srv/feather/state npm start
```

The configured state root owns only these instance assets:

| Asset | Contents |
|------|----------|
| `boxes.json` | Remote-box endpoints and credentials (secret, enforced `0600`) |
| `sharing.json` | Peer grants and credentials (secret, enforced `0600`) |
| `session-meta.json` | Per-session names, archive state, and sharing metadata |
| `project-labels.json` | Project display labels |
| `feed-interactions.json` | Fledge reactions, comments, and bounded source snapshots |
| `quick-links.json` | Saved navigation links |
| `starred.json` | Starred sessions |
| `muted.json` | Muted notification sessions |
| `push-keys.json` | Push signing credentials |
| `push-subscriptions.json` | Browser push subscriptions |
| `uploads/` | Uploaded attachments |

Everything else keeps its existing owner: release assets (`static/`,
`version.json`, and the bridge extension) stay in the checkout; Room
assignments, durable Leaders, residents, caretaker state, Sidecar threads,
access logs, and OMP state stay under `~/.feather`; Claude and Codex session
stores stay under their harness homes; Rooms and their Wiki stay under
`~/rooms`; and tmux/process/temp state remains runtime-managed. A new writable
path must be classified into one of those groups before it is added.

For a migration, stop all Feather writers, copy and validate the instance
assets, then start one release with `FEATHER_STATE_DIR`. Deployment tooling may
create checkout-local compatibility symlinks for older releases, but it must
only create missing links: an existing file or a link to another target is a
hard conflict and must never be replaced automatically. `boxes.json` and
`sharing.json` targets must remain owner-only through that process.

The current JSON files retain their existing unversioned shapes. A release that
changes a state shape must introduce an explicit schema/version and document its
downgrade behavior before writing it. Rollback after new writes must use the
compatible current state or a tested downgrade adapter; restoring a pre-upgrade
copy at that point would lose work. Do not run incompatible writers against the
same root.

Durable JSON writes use a same-directory fsynced temporary file and atomic
rename, retain a `.last-good` recovery copy, and fail closed on malformed
existing state. Defaults and rollback compatibility are recorded in
[`docs/state-compatibility.md`](docs/state-compatibility.md).

## Architecture

```
┌─────────────────────────────────────────┐
│  iPhone / Browser                       │
│  SolidJS SPA                            │
│  ├── MessageView (markdown, bubbles)    │
│  ├── Terminal (xterm.js + WebSocket)    │
│  └── Chat input (auto-grow textarea)   │
└──────────┬──────────────────────────────┘
           │ HTTP + SSE + WS
           ▼
┌──────────────────────────────────────────┐
│  Express server                          │
│  ├── JSONL parser (parseMessage)        │
│  ├── Session discovery (2-phase scan)   │
│  ├── SSE broadcaster (byte-offset IDs)  │
│  ├── fs.watch (inotify, per-directory)  │
│  ├── tmux manager (spawn/resume/send)   │
│  └── WebSocket terminal (node-pty)      │
└──────────┬──────────────────────────────┘
           │ filesystem
           ▼
  ~/.claude/projects/<hash>/<session>.jsonl
  tmux sessions: f-<8chars>
```

## Files

| File | Purpose |
|------|---------|
| `server-single.js` | Entire backend: API, SSE, WebSocket, JSONL parsing, tmux |
| `frontend/src/App.tsx` | UI shell — sidebar, header, tabs, input bar |
| `frontend/src/api.ts` | REST + SSE client, types |
| `frontend/src/components/MessageView.tsx` | Chat bubbles with markdown rendering |
| `frontend/src/components/Sidecar.tsx` | Sidecar panel — paired-agent thread view |
| `frontend/src/components/Terminal.tsx` | xterm.js + WebSocket terminal |
| `frontend/src/index.tsx` | SolidJS mount point |

## Design decisions

- **No database.** Read JSONL directly. The filesystem is the source of truth.
- **No polling.** `fs.watch` → SSE push. Client generates session UUID upfront (ClOrdId pattern).
- **tmux as the process manager.** Every Claude session runs in a named tmux session. Terminal tab attaches to it. Chat input sends keystrokes via `send-keys` / `paste-buffer`.
- **Two-phase session discovery.** Stat-only scan + sort by mtime → read first 4KB of top N for titles. 7000+ sessions in 75ms.
- **Byte-offset SSE IDs.** Enables resumable streams and gap-free message delivery.
- **Mobile-first.** `--vh` viewport fix, safe-area insets, `-webkit-overflow-scrolling: touch`, PWA meta tags.

## Releasing changes

```bash
cd ~/feather
npm run deploy    # stages an immutable release; does not restart anything
```

Promotion is a separate guarded operation with explicit current-link, service,
and mounted health inputs. It owns a host lock, journals every phase, verifies
the expected build version, and restores the prior release on failure. See
[`docs/runbooks/refeather.md`](docs/runbooks/refeather.md).

Both backend (`/api/health`) and frontend (tab bar) show the promoted version.

## Deployment

### systemd

```bash
# Create a service file pointing to server-single.js
sudo systemctl enable --now feather-next
```

For Supervisor, customize [`infra/feather.supervisor.conf`](infra/feather.supervisor.conf).
Production should execute one stable `current` link and keep mutable metadata
in `FEATHER_STATE_DIR`, never in a personalized source checkout.

### Reverse proxy (Caddy)

```
handle /api/sessions/*/stream {
    reverse_proxy localhost:4870 {
        flush_interval -1    # required for SSE
    }
}
handle {
    reverse_proxy localhost:4870
}
```

## Dependencies

**Backend:** express, compression, node-pty, ws
**Frontend:** solid-js, ghostty-web, marked, highlight.js, dompurify, html-to-image

## License

[Elastic License 2.0](LICENSE) — free to use, modify, and distribute. Cannot be offered as a hosted service.
