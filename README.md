# Feather

**A lightweight, mobile-first viewer and controller for AI coding agents.**

Open any Claude Code session on your phone. Read the conversation. Send messages. Watch the terminal. Resume old sessions or spawn new ones — instantly.

## Make it yours

The entire app is 6 files. Point Claude (or any AI agent) at this repo and tell it what you want:

- *"Add a cost tracker that shows tokens and dollars per session"*
- *"Add push notifications when an agent needs my attention"*
- *"Show me a diff view when Claude edits a file"*
- *"Add a dark/light theme toggle"*
- *"Group consecutive tool calls into a collapsible block"*
- *"Add Codex support — here's how their session files work"*
- *"Add a search bar that filters across all sessions"*
- *"Show a green typing indicator when Claude is responding"*
- *"Add keyboard shortcuts — j/k to navigate sessions, Enter to open"*

No abstractions to learn. No plugin API to read. One server file, one app shell, one message renderer. You describe it, the agent builds it.

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

## Rooms — durable workspaces

A Room is a folder under `~/rooms/` that gives related Feather chats a shared
working directory and durable notes. The Rooms home groups Claude, Codex, and
oh-my-pi sessions by working directory, and lets you create or explicitly assign
chats without maintaining a separate Projects tree.

Each room contains an `AGENTS.md`, a matching `CLAUDE.md` symlink, and a
`notes.md` working memory. From a room chat, `room note "..."` appends a durable
decision or open thread. The optional `room` CLI also supports lookups, sealed
councils, second opinions, spawned sessions, and handoffs.

Feather's former Auto surface is retired. Existing `~/auto-*` directories are
left untouched.

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
| `quick-links.json` | Saved navigation links |
| `starred.json` | Starred sessions |
| `muted.json` | Muted notification sessions |
| `push-keys.json` | Push signing credentials |
| `push-subscriptions.json` | Browser push subscriptions |
| `uploads/` | Uploaded attachments |

Everything else keeps its existing owner: release assets (`static/`,
`version.json`, and the bridge extension) stay in the checkout; sidecars, Room
assignments, access logs, and OMP state stay under `~/.feather`; Claude and Codex
session stores stay under their harness homes; Rooms stay under `~/rooms`; and
tmux/process/temp state remains runtime-managed. A new writable path must be
classified into one of those groups before it is added.

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
| `frontend/src/components/Terminal.tsx` | xterm.js + WebSocket terminal |
| `frontend/src/index.tsx` | SolidJS mount point |

## Design decisions

- **No database.** Read JSONL directly. The filesystem is the source of truth.
- **No polling.** `fs.watch` → SSE push. Client generates session UUID upfront (ClOrdId pattern).
- **tmux as the process manager.** Every Claude session runs in a named tmux session. Terminal tab attaches to it. Chat input sends keystrokes via `send-keys` / `paste-buffer`.
- **Two-phase session discovery.** Stat-only scan + sort by mtime → read first 4KB of top N for titles. 7000+ sessions in 75ms.
- **Byte-offset SSE IDs.** Enables resumable streams and gap-free message delivery.
- **Mobile-first.** `--vh` viewport fix, safe-area insets, `-webkit-overflow-scrolling: touch`, PWA meta tags.

## Deploying changes

```bash
cd ~/feather
npm run deploy    # stamps version.json, builds frontend, restarts server
```

Both backend (`/api/health`) and frontend (tab bar) show the same version timestamp.

## Deployment

### systemd

```bash
# Create a service file pointing to server-single.js
sudo systemctl enable --now feather-next
```

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
