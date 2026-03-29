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
