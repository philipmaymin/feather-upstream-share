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
