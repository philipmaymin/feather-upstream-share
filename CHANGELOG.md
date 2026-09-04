## 2026-09-04 - Resume unread threads where work changed
- **Opening an unread thread now lands at the first unread message instead of the beginning or end.** Fledge uses each member’s durable read cursor, shows two preceding messages for context, labels the boundary with a prominent `New since your last visit` divider, and reports the unread count in the focused-thread header.
- **Old history no longer blocks the current work.** Earlier read messages collapse behind a counted `Show earlier messages` control; fully read threads open on their five most recent messages, and `Next unread` moves directly to the next unread thread without returning to the channel timeline.

## 2026-09-04 - Attention-first channel triage
- **Every channel now has one-tap `Needs me`, `Open`, and `All` thread views.** Counts stay visible, the chosen view survives channel navigation and reloads through the URL, and empty filters explain what will appear there with a direct path back to all history.
- **Visual weight now follows responsibility without fighting active reading.** Unread replies, decisions, failures, and active agent work retain full contrast with explicit `New` labels and edge emphasis; read threads recede, resolved or done threads recede further while remaining legible, and expanding any thread immediately restores full contrast until it is collapsed again.
- **The same triage model spans channel timelines and the Threads index.** Fledge keeps read separate from done and uses three stable views instead of copying the filter sprawl of general-purpose chat tools.

## 2026-09-04 - Compact threads and stable reply ownership
- **Collapsed channel threads no longer render full-size screenshot previews.** Image Markdown becomes a compact paperclip-style count such as “3 images”; opening replies restores the previews, and hiding replies compacts them again.
- **Rapid follow-ups stay with the same Coordinator.** When Coordinator is still finishing that thread’s prior turn, the next unmentioned reply queues behind it instead of switching identities to Btw; Btw remains available for separate threads while Coordinator is busy.

## 2026-09-04 - Truthful mobile notification badge
- **The Activity count no longer appears over DMs.** The mobile badge was absolutely positioned against the entire navigation bar, so an Activity count of one landed over the DMs icon and looked like a stuck DM unread marker; each navigation button now owns its badge positioning.

## 2026-09-04 - Reliable channel creation
- **New channels no longer fall through to the “Create your first channel” screen.** Fledge now commits the server-confirmed channel to local navigation state before opening it, so overlapping live refreshes cannot invalidate both the creation refresh and the destination transition; direct-message creation uses the same race-safe handoff.

## 2026-09-04 - Long-running channel work
- **Channel agents no longer fail after an arbitrary 15-minute wall-clock deadline.** Turns run until the agent completes or a member stops them; operators can still opt into a hard deadline with `FEATHER_CHANNEL_TURN_LIMIT_MS`, and `/api/health` reports the effective value.

## 2026-09-04 - Direct-message read receipts
- **Opening a direct message now clears its unread notification.** Fledge acknowledges every unread thread shown in the visible DM conversation, then reconciles the Activity, document-title, app, and conversation badges; background tabs and other channel views do not consume unread DMs.

## 2026-08-30 - Fledge agent feed PWA
- **Fledge turns Feather into a feed-first mobile app at `app.feather.plus`.** The installable PWA opens on a live editorial stream of recent agent results, Room briefings, active work, failures, and decisions waiting on Philip; Rooms, search, chat, files, terminal, prompts, updates, approvals, and creation remain inside the same interface.
- **For You explains its ranking and learns from use.** Waiting decisions stay first, failures and active work remain visible, completed posts paginate without gaps, and bounded Room/project affinity adapts within each priority class from opens and thumb feedback. Latest and Needs Me remain deterministic alternatives.
- **Dispatches carry real working artifacts.** Feather's existing sanitized Markdown, math, syntax, table, image, PDF, video, text, and sandboxed interactive-HTML surfaces render in the stream. Public X and TikTok posts use isolated official embeds; arbitrary remote Markdown images require an explicit click.
- **Feedback returns to the originating Feather.** Thumbs up/down persist as preference evidence, failed deliveries remain retryable with exact idempotency markers, and inline comments keep their originating session binding and render the Feather's next human-facing reply beneath the dispatch.
- **Room updates are timeline-ready.** Each briefing stores or derives a concise headline while retaining timestamp, Room/session provenance, Markdown body, and artifact links; autonomous Room prompts now request the same publishable structure.
- **The new surface keeps strict boundaries.** Feather binds to loopback by default behind Authelia, feed state lives outside immutable releases with owner-only permissions, post IDs are opaque, push endpoints are bounded to public HTTPS destinations, social and local HTML run without same-origin privilege, and browser back/forward returns between feed and chat without losing position.
- **The feed is now a compact continuous timeline.** Poster-sized snap cards and numbered gutters are gone; headers, controls, reasons, and reactions use one dense hierarchy, ordinary results preview six lines with in-place expansion, and waiting decisions retain their full highlighted question.
- **Fledge is now an outcome inbox, not an equal-weight activity log.** For You keeps decisions, active work, failures, and at most one recent important completion per Room or project; routine acknowledgements move to compact gray notes in Latest, while meaningful local images and videos receive a large inline hero.
- **Rooms now lead directly to a question.** Each Room exposes one primary Ask Leader action, keeps past chats behind explicit History, and moves standalone-chat and background controls into secondary disclosure.
- **A guarded UX loop now watches Feather before it Refeathers.** Every six hours a deterministic synthetic mobile journey is recorded and reviewed through Gemini's complete-video API; only timestamped, locally reproducible contract failures may produce one isolated candidate change. One full-cycle lock covers recording through release state, real user data never leaves Feather, and Philip promotion remains blocked until the prior 24-hour fleet canary settles.
- **Fleet capability installs preserve each account's ownership.** Root-run promotions now hand newly created Claude, Codex, OMP, extension, and local-bin directories back to the target home owner, preventing a successful release from making that user's next OMP launch fail with `EACCES`.
- **Terminal tabs attach again.** The Fledge merge had dropped the terminal branch that reads a chat's session ID, so every terminal WebSocket failed at startup and retried continuously; the server now restores the session-aware tmux attach path while keeping the separate shell path intact.
- **Room cards reveal their conversations without losing fresh Leaders.** Tapping a Room expands its residents and past chats in place; selecting a row is the explicit navigation step, and a valid newly spawned Leader remains visible before its first transcript record exists.
- **Feather's recovery paths are truthful and responsive again.** Shell input works, recent OMP and Codex chats are discoverable by title without invoking the blocking full-text path, deletion removes the complete session identity and reconciles ghost Room state, Room previews show the newest work with coherent caches, and assignment, resume, and deep-link transitions preserve the identity actually shown.
- **Refeather makes Activity intent-first and response-scoped.** Each response starts clean, keeps tools and Todo chronological across assistant continuations, restores prior Activity when durable queuing fails, and settles replayed tools before continuation.

## 2026-08-30 - Reliable Room self-pause
- **A Room pulse can pause itself cleanly.** The CLI identifies its Feather session, and the server persists the disabled schedule without killing that same worker mid-response; the current handoff finishes, no replacement pulse is queued, while UI and external pauses still terminate in-flight work immediately.

## 2026-08-28 - Readable chat, native math, and bounded browser cleanup
- **LaTeX renders natively in chat.** Inline and display math now use KaTeX, including math-only backtick spans and fenced `math`, `latex`, or `tex` blocks.
- **Execution stays in one compact Details surface.** Parent work, todos, delegated agents, and background jobs share the chronological disclosure beside the answer instead of fragmenting chat across separate Todos and Agents tabs.
- **Long chats load and stay anchored efficiently.** Initial history stops once it reaches the current conversation boundary, older pages remain available on demand, active conversations keep their scroll anchor, and transcript activity refreshes parse only appended bytes.
- **Sent media clears as soon as Feather has durably accepted it.** Upload and transcription state remains scoped to the originating chat, so navigating during an in-flight send cannot clear or attach media in the wrong conversation.
- **Managed browser processes now have bounded cleanup.** The browser reaper removes only old, idle Feather-managed browser trees and ships with a dedicated systemd unit for continuous fleet-safe operation.

## 2026-08-25 - Session-affine local tools
- **Room and sidecar commands target the Feather instance that launched the current OMP session.** The shared resolver now reads the session's bridge metadata before probing default ports, so a concurrent production/canary server cannot make `room pause`, `room wake`, or another local mutation fail as ambiguous or reach the wrong instance. Stale metadata falls back to the existing health-checked probe.
- **Guarded promotion now supports systemd directly.** Repeated `--systemd-unit` options stop and restart every unit sharing a release pointer, and repeated `--health-url` gates require each sibling to report the exact release. The manager, full unit set, and endpoints persist in transaction state so failed starts, partial health, rollback, and crash recovery use systemctl rather than silently falling back to Supervisor.
- **`room update` success now means the owning Feather accepted it.** The CLI resolves the current session's instance and posts through the Room updates API instead of appending the file behind Feather's snapshot cache. Ambiguous routing or a rejected mutation fails loudly; accepted updates invalidate the owner cache immediately.
- **Concurrent Feather instances no longer abort each other’s OMP chats.** Completed-turn bridge migration now respects the durable instance owner before replacing a tmux process, and Resume is idempotent while that exact session is already active.
- **OMP Advisory runs are native and durable.** The Council skill and protocol extension run independent candidate seats plus a fresh judge, persist bounded event logs outside immutable releases, replay progress through SSE, and render a compact Advisory card directly below its invoking prompt.
- **Chat keeps execution compact.** Parent OMP work is a one-line status in Chat; tapping it opens the complete chronological timeline in Agents alongside child-agent inspectors.
- **Secondary users follow Philip after a 24-hour canary window.** A durable systemd-driven watcher detects every Philip release change, publishes the byte-identical tree to the shared store, supersedes the prior schedule, and restarts the window automatically. Due promotion verifies each listener and rolls earlier peers back if a later peer fails.

## 2026-08-23 - Visible harnesses and controllable background work
- **Terminal login links work on phones.** Plain taps now open HTTP(S) and OSC 8 links without a keyboard modifier, long OAuth URLs remain intact across wrapped terminal rows, and a Links drawer exposes every recent URL as a native browser link with a dedicated Copy action.
- **Chat identity is now fail-closed.** Switching chats cancels and invalidates the previous history request and live stream; late responses are discarded, and the composer stays locked until the selected title and rendered transcript are the same chat. This prevents one chat's context from appearing under another title and prevents sends while a transcript is unresolved.
- **OMP, Claude Code, and Codex are visible where chats start.** The Rooms home now has direct launch buttons for all available harnesses, the sidebar no longer hides Claude and Codex under an “Other” menu, and every session row identifies its harness.
- **Room background work can be stopped reliably.** The Rooms home shows a global background-work status and a one-click Stop all control. Pausing an individual Room now terminates an in-flight worker immediately instead of only preventing its next scheduled run.
- **Autonomous pulse workers no longer clutter normal navigation.** Their implementation sessions are excluded from the sidebar, Room chat counts, latest-message snippets, active dots, and tap targets; existing user chat history is unchanged.
- **The Rooms shell is clearer.** The idle header now says Feather instead of the misleading “Select a session,” and Room cards use explicit Start background / Stop background actions.

## 2026-08-22 - Faster Rooms and local Markdown images
- **Rooms stay responsive as chat history grows.** Feather now serves cached room and session snapshots immediately and refreshes stale transcript data in the background, while room and chat mutations still invalidate the cache at once.
- **The Rooms list now feels instant in the browser too.** Feather paints the last good room snapshot immediately while refreshing it quietly, overlaps the first Rooms request with authentication, and keeps fingerprinted frontend bundles cached instead of revalidating them on every reload.
- **New chats stay visible with the warm cache.** Transcripts created outside Feather are patched into the cached session index directly, without waiting for a full history rescan.
- **Local images embedded in Markdown render in chat.** Paths such as `![chart](/home/user/rooms/example/chart.png)` now load through the same safe preview route as the Files tab, open in the image lightbox, and fall back to a clickable path if the image is missing.
- **Codex sessions start with less friction.** Feather suppresses Codex's startup update check for new and resumed sessions.
- **Old Codex chats resume promptly again.** Resume readiness now recognizes Codex's own terminal prompt instead of waiting up to 30 seconds for a Claude-only prompt that can never appear.
- The backend was deployed on 2026-08-22; no machine reboot is required.

## 2026-08-21 - Rooms-first home, shared context, and sidecars
- **Large pasted messages now send reliably to Codex.** Feather now uses the terminal's real bracketed-paste mode and preserves multiline input, so the submit key cannot get swallowed halfway through a long paste and leave the message waiting invisibly in Terminal.
- **Local artifact links open correctly from chat.** Markdown links to files on disk now use the same preview route as the Files tab, including links that carry a source line number.
- **HTML artifacts render when opened from chat.** Links to local `.html` and `.htm` files now open in Feather's sandboxed artifact preview instead of showing the document's source text.
- **Rooms are now the home screen.** A Room is a real folder under `~/rooms/`, with durable `AGENTS.md`/`CLAUDE.md` instructions and `notes.md` memory shared by its Claude, Codex, and oh-my-pi chats.
- **Create rooms and chats from Feather.** Room cards show their latest activity, expand to all chats, and can start a new Claude or Codex session in the room. Explicit assignment covers sessions whose working directory is not yet visible.
- **The old Projects tree and Auto surface are retired.** Existing `~/auto-*` working directories are not touched. The normal Sessions/Links sidebar, Files viewer, search, notifications, usage, staged updater, and terminal controls remain available.
- **Sidecars are nested under their parent chat.** Multi-peer sidecars, durable threads, per-session send locking, and more reliable Codex discovery/activity tracking are included.
- **New `room` and `sidecar` CLIs.** Each deployed account resolves its own Feather port automatically. Backend routes take effect on the next natural service restart; no running service is restarted by this update.

## 2026-06-11 - Files tab: download buttons + real PDF preview
- **Download button on every file row** (Browse and Changed modes, plus the viewer header). Tapping it saves the file directly instead of opening it.
- **PDF preview fixed.** Clicking a file name opens the type-aware viewer again: PDFs render in a real inline viewer (no more garbled byte-dump), images preview inline, other binaries show a download card, text and markdown render as before. This viewer shipped 2026-04-30 but was lost in the 2026-06-06 upstream merge.
- Server: `/api/files/raw` accepts `download=1` to force save-as, and serves PDFs inline so direct links preview properly too. Takes effect on next natural restart.

## 2026-06-06 - Upstream Merge: Codex actually works + oh-my-pi backend
- **Codex now works end to end.** Two bugs had it broken even though the code was there:
  - The server looks up `codex` (and `omp`) through your interactive shell (`~/.bashrc`) now, so it finds binaries installed in `~/.npm-global/bin`. Before, it only searched the login PATH, so the "+ Codex" button never appeared and a spawned Codex session died with "command not found".
  - Live updates are parsed per backend. The streamer used to assume every line was Claude-format, so Codex (and oh-my-pi) messages were silently dropped mid-session and only showed up on reload. They stream live now.
- **oh-my-pi (omp) backend** ported from upstream as a third agent next to Claude and Codex. Sessions live under `~/.feather/omp-sessions/<id>/`. The "+ omp" option only appears once `oh-my-pi` is installed; until then it is listed as unavailable. (We kept this on `server-single.js`; we did not adopt upstream's `server.js` rename, theme-vars refactor, remote-server, or box proxy.)
- **Codex tool rendering** improved: `apply_patch` shows the diff and `write_stdin` shows the piped input as their own colored blocks, matching how Bash/Edit/Read already render.
- **Clickable file paths in tool calls.** File arguments in Bash, Write, Read, apply_patch, and sub-agent tool blocks (and in tool output) are now links, same as paths in chat text.
- **Delete files from the Files tab.** Browse mode gained a trash button on each row (with a confirm prompt). Guarded by the same path-allowlist the rest of the file API uses.
- Server change: takes effect on next natural restart.

## 2026-04-30 - Files tab: type-aware viewer + Download button
- The file viewer modal no longer fetches binary files as text. PDFs previously rendered as a raw byte-dump in a `<pre>` block; they now embed as an inline iframe (same approach as the message-attachment PDF viewer). Images preview inline (`<img>`), other binaries show a download card, text and markdown render as before.
- Every viewer header now has a real **Download** button (uses `<a download>` so it saves to disk regardless of how the server frames the response).
- Sexier title: filename in 14px semibold white, parent dir in dim monospace below, kind pill (TEXT / IMAGE / PDF / BINARY) on the left in a colored badge. Backdrop got a soft blur.

## 2026-04-30 - Auto Tab + File Viewer + Worker Exclusion
- New **Auto** tab in the sidebar: manage autonomous improvement loops without leaving Feather. Create a named instance with a goal, then Start/Stop, Set focus, BTW (heads-up to the next iteration), or Link a Feather chat as the steering wheel. Detail view shows iterations / keeps / reverts / crashes, recent activity, worker sessions, and the rendered program.md. Three default pipelines ship: `simple` (claude, 1 phase), `all-claude` (5 phases + 1/10 reviewer), `claude-codex` (6 phases, claude+codex). Drop a JSON file in `templates/auto/` to add your own.
- New **/auto** skill (`skills/auto/SKILL.md`) — symlink it into `~/.claude/skills/auto` to drive the same endpoints from CLI: `/auto status`, `/auto new`, `/auto start`, `/auto focus`, `/auto btw`, `/auto link`. Uses `localhost:$PORT` (configurable; defaults to 4870).
- **Files tab** now has a Changed / Browse mode toggle. Changed mode shows files touched by tool calls in this session (with action pills). Browse mode is the existing directory tree. Click any file in either mode to open it in an in-app viewer modal (.md rendered with marked, other text shown as monospace pre); previously the only option was opening in a new tab.
- **Sessions list excludes workers** automatically. Auto worker sessions (created under `~/auto-NAME/` or legacy `~/autoweb-NAME/`) used to bury real chats when a loop was busy. They're now filtered out by both project path (`-home-user-auto-*`) and content (the `AUTO_WORKER=TRUE` canary in the prompt).
- Server change: takes effect on next natural restart.

## 2026-04-27 - Textarea Autoresize Fix
- The composer text box now grows to fit its content (up to 120px) when text is set programmatically: draft restore on session select, voice dictation transcripts, and Up/Down arrow history navigation. Previously these paths skipped the autoresize, so a long restored draft would be pinned at 1 row and scroll behind a tiny viewport — you could see only the top 1-2 lines of what was actually there.

## 2026-04-26 - Codex Sessions
- Added Codex (OpenAI) as a second backend alongside Claude Code. A purple "+ Codex" button appears next to "+ New Claude" when codex is installed (run `npm install -g @openai/codex` to enable). Codex sessions show a small "codex" pill in the sidebar.
- Codex sessions live at `~/.codex/sessions/YYYY/MM/DD/rollout-*-<UUID>.jsonl` and are listed alongside Claude sessions in the chat list. Existing rollouts auto-discovered on server start.
- Codex doesn't accept a preset session id (issue openai/codex#15767), so we snapshot existing rollouts on spawn, then poll for the new file and adopt its UUID into session-meta. Codex resume passes `--cd` to skip the cwd picker.
- Codex's tool calls (shell/exec) render the same way as Claude's Bash blocks. The `cmd` array form is normalized to a single command string for display.
- Codex needs paste-buffer for every message — Enter stops submitting after the first turn if you use `send-keys -l`. We route through bracketed paste with a 300ms delay before Enter.
- Server change: takes effect on next natural restart.

## 2026-04-26 - Upstream Merge: PDF Viewer
- PDF attachments in messages now open in an in-app iframe viewer with a close button, instead of the browser trying to navigate to a filesystem path. Other file types still open in a new tab.
- Skipped from upstream (didn't fit our single-user/Authelia architecture): server-single.js to server.js rename, theme-vars refactor, oh-my-pi (omp) multi-backend, remote-server agent, box proxy, batch voice transcription rewrite (we kept our Web Speech API). Voice/editor/inline-image/pinch-zoom features were already integrated in earlier merges.

## 2026-04-19 - Activity Status: Detect Compaction + Queued-Input States
- Status bar now shows "Compacting conversation..." (and other spinner-driven activity) even when the idle ❯ prompt isn't visible. Previously, queued input or a redrawn input area would knock out the anchor extractActivity uses, leaving the status bar stuck on bare "Working".
- Added a fallback bottom-up scan of the last 20 lines for the spinner pattern when no anchor is found.
- Server change — takes effect on next natural restart, not the live session.

## 2026-04-19 - Scroll Flicker Fix (Iter 3)
- Pin writes now happen synchronously inside the ResizeObserver callback (scrollTop assignment, no rAF). ResizeObserver fires after layout and before paint, so the adjusted position lands in the same frame as the size change — the one-frame "content paints at old position, then snaps" flicker is gone.
- Length-change effect no longer calls pinToBottom — ResizeObserver is the single pin writer, removing the double-scroll race when a new message and its ResizeObserver event both arrived in the same frame.

## 2026-04-19 - Scroll Herky-Jerky Fixes (Iter 2)
- Coalesced scroll writers: pin, smooth-jump, and ResizeObserver now all route through a single rAF scheduler with epsilon skip (<2px no-op), killing the double-scroll judder when images and typing indicators changed in the same frame.
- Typing indicator reserves its layout slot even when idle (opacity toggle instead of conditional mount), so the bubble no longer shifts 26px up/down when Claude starts/stops a turn.
- Load-earlier anchors viewport: previously scrolling to the top and clicking "Load earlier" could bounce the viewport. Now the visible content stays put after the prepend.
- Session switch resets pinned state cleanly (sessionId prop) so returning to a session does not get stuck auto-pinning over your saved scroll position.
- Length-change effect decoupled from `pinned()` signal (untrack), so pin decisions no longer re-fire on user scroll.
- DOM-mutation side effects (fixLinks, collapseCodeBlocks) moved from `setTimeout(0)` to `queueMicrotask` to batch with the paint rather than trigger a second layout.

## 2026-04-19 - Scroll Pin Fix + Collapse Compact Summaries
- Scroll stays pinned to the bottom through collapse/expand transitions, async image loads, and typing indicator changes (not just on new-message count). Replaces the rAF-after-length-change approach with a ResizeObserver on the scroll content.
- Context-compaction summaries (the "This session is being continued..." message that Claude Code inserts on auto-compact) now join the tool-steps collapse group instead of rendering as a giant prose wall.

## 2026-04-19 - Upstream Merge: Pinch-Zoom + PDF Viewer + Inline Images
- Pinch-to-zoom and double-tap zoom in the image lightbox (mobile touch)
- PDF attachments open in an in-app viewer (no more download-then-open)
- Tool results that return images (screenshots, plots) render inline instead of as text
- iOS: blocks accidental pinch-zoom of the app chrome and skips viewport resize while zoomed
- Skipped from upstream: theme-vars refactor, oh-my-pi backend, remote-server agent, box proxy, voice batch-transcription rewrite (kept our Web Speech API implementation)

## 2026-04-18 - Instant Send + Hidden Files Toggle + Staging Safety
- Send feels instant: input clears and the optimistic message renders on the first frame, before resume/uploads run. No more 800-1800ms wait to see your own message.
- Files tab: toggle button to show/hide dotfiles (.bashrc, .claude, etc.). Preference persists per browser.
- Fixed latent bug where kids' "Perform Update" could install a broken build (missing assets) and black-screen. /api/update now validates staging before copy and wipes stale assets.

## 2026-04-17 - Resume Race + Question Propagation Fixes
- Fixed Enter not submitting when resuming a stale chat (message sat in input until user pressed Enter manually in terminal tab)
- /resume endpoint now awaits Claude Code TUI ready-state before responding, so the follow-up send does not race the spawn
- waitForClaudeReady requires the input prompt to be stable for 800ms (eliminates false-positive readiness during boot transients)
- sendText now verifies Enter landed: if the typed text is still in the input box, re-sends Enter up to 3 times
- Fixed question banner never firing: pane-stability hash now excludes the live status bar (ctx%, cost, runtime timer) so question detection can reach its 2-poll stability threshold

## 2026-04-16 - Upstream Merge #5: Expanded Editor + Pinch-Zoom
- Expanded editor: tap the new expand icon to get a fullscreen text editor for composing longer messages
- Collapse button and Escape key to return to the normal input bar
- Pinch-to-zoom blocked on iOS (prevents accidental zoom during touch interaction)
- Viewport layout preserved during pinch zoom (no layout reflow)
- Batch voice transcription with recording timer, audio level indicator, and transcribing state
- Table overflow: tables now scroll horizontally on mobile without needing a wrapper div
- File serving: /api/file endpoint for viewing attachments, /api/open-in-editor for code-server
- Batch Deepgram transcription: /api/transcribe endpoint for voice-to-text

## 2026-04-11 - Question Detection False Positives
- QUESTION banner no longer fires on assistant prose that happens to contain a question mark
- Rejects any tail containing the "Send a message" input-box placeholder
- Requires menu options to be short, non-prose phrases (≤80 chars, no sentence breaks)
- Caps question text at 200 chars so chat prose cannot masquerade as a selector prompt

## 2026-04-05 - Upstream Merge #4
- Voice recording: replaced browser SpeechRecognition with MediaRecorder batch transcription (more reliable, works on all browsers)
- Recording UI: audio level meter, recording timer, transcribing indicator
- Inline images: tool_result blocks with base64 images now render inline with click-to-zoom
- PDF viewer: clickable .pdf file paths open in an embedded viewer
- File serving: /api/file endpoint serves any local file (for PDF viewer, etc.)
- Idle session reaper: tmux sessions inactive for 1 hour are automatically cleaned up
- New upstream files: remote-server.js (remote agent), boxes.json (box config), supervisor config
- Visibility refresh: session list auto-refreshes when you switch back to the tab

## 2026-04-03 - Image Auto-Preview
- Image file paths in assistant messages now render an inline preview automatically
- Click the preview to open the full-size lightbox
- No more hunting through the file explorer to see generated images

## 2026-04-01 - Question Popup + Status Cleanup
- Claude's interactive questions (session reload, yes/no prompts) now pop up as a clickable panel above the status bar
- Removed redundant status dot character (e.g. "✻ Reading files") since the orange indicator dot already shows working state
- Single tmux capture shared between activity and question detection (no extra polling cost)

## 2026-03-30 - Link & File Browser Fix
- File paths in inline code (e.g. `/home/user/file.json`) are now clickable links that open in a new tab
- File browser in the Files tab: browse directories, click files to view/download
- File browser shows relative age (e.g. "2h ago", "3d ago") and size for each entry
- File links use `/api/files/raw` endpoint instead of broken open-in-editor handler
- Stop button: tap "Stop" in status bar or red stop button (replaces send) to interrupt Claude on mobile

## 2026-03-29 - Upstream Merge #3
- Version stamping: build time shown from version.json
- Adopted upstream build script with automatic version.json generation
- All upstream UI/performance commits already integrated

## 2026-03-29 - Sweep cleanup + upstream sync
- Search across all chats (magnifying glass in sidebar)
- Deepgram speech-to-text WebSocket proxy
- Scroll-to-bottom button redesign (round circle with unread badge)
- Fixed "Working..." indicator getting stuck when session is done
- Removed dead code: 2 backup files, stale supervisor/launch scripts, unused endpoint
- Removed unused bcryptjs dependency
- Updated README and .gitignore for current architecture

## 2026-03-29 - Upstream Merge #2
- Deepgram speech-to-text WebSocket proxy (/api/stt)
- Scroll-to-bottom button redesign (round circle with unread badge)
- Removed dead /terminal route that blocked SPA catch-all
- Multi-retry Enter key sends on session spawn (3s, 5s, 8s)

## 2026-03-28 - Latest
- Status bar: cwd, model, token counts
- Header shows project label + cwd
- Scroll to previous user message (green button)
- Star navigation in toolbar
- SVG toolbar icons (mic, attach, send)
- Send button hidden on mobile (keyboard has its own)
- Terminal copy/paste toolbar for mobile
- iOS keyboard scroll fix
- Clickable file paths in messages
- Image lightbox for attached images
- Version update indicator (this!)
- Code cleanup: merged duplicate functions, removed dead code
