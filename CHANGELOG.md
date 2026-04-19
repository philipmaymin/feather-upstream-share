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
