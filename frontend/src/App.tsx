declare const __BUILD_TIME__: string
import { createSignal, createEffect, createMemo, onMount, onCleanup, Show, For } from 'solid-js'
import { MessageView } from './components/MessageView'
import { Terminal } from './components/Terminal'
import type { SessionMeta, Message, Project, QuestionData } from './api'
import { fetchSessions, fetchMessages, subscribeMessages, sendInput, createSession, resumeSession, interruptSession, uploadFile, deleteSession, renameSession, forkSession, fetchStarred, saveStarred, exportUrl, fetchProjects, checkAuth, login, logout, searchSessions, answerQuestion } from './api'
import type { SearchResult } from './api'

interface QuickLink { label: string; url: string }

interface PendingFile { name: string; blob: Blob; dataUrl: string; isImage: boolean }

function resizeImage(blob: Blob, maxDim = 1600): Promise<Blob> {
  return new Promise((resolve) => {
    const img = new Image()
    const url = URL.createObjectURL(blob)
    img.onload = () => {
      URL.revokeObjectURL(url)
      const { width: w, height: h } = img
      if (w <= maxDim && h <= maxDim) { resolve(blob); return }
      const scale = Math.min(maxDim / w, maxDim / h)
      const c = document.createElement('canvas')
      c.width = w * scale; c.height = h * scale
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
      c.toBlob(b => resolve(b || blob), 'image/png')
    }
    img.src = url
  })
}

function timeAgo(iso: string) {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

// ── Draft persistence ────────────────────────────────────────────────────
function saveDraft(id: string, val: string) {
  if (val) localStorage.setItem(`feather-draft-${id}`, val)
  else localStorage.removeItem(`feather-draft-${id}`)
}
function loadDraft(id: string): string {
  return localStorage.getItem(`feather-draft-${id}`) || ''
}

// ── Input history ────────────────────────────────────────────────────────
const HISTORY_KEY = 'feather-input-history'
const MAX_HISTORY = 50
function getHistory(): string[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]') }
  catch { return [] }
}
function pushHistory(text: string) {
  const h = getHistory()
  const idx = h.indexOf(text)
  if (idx >= 0) h.splice(idx, 1)
  h.push(text)
  if (h.length > MAX_HISTORY) h.shift()
  localStorage.setItem(HISTORY_KEY, JSON.stringify(h))
}

// ── Dynamic favicon ──────────────────────────────────────────────────────
function setFavicon(color: string) {
  const size = 32, c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')!
  // Draw feather shape
  ctx.save()
  ctx.translate(size * 0.15, size * 0.1)
  ctx.scale(size / 64, size / 64)
  ctx.beginPath()
  // Feather body
  ctx.moveTo(48, 4)
  ctx.bezierCurveTo(36, 12, 28, 24, 20, 40)
  ctx.quadraticCurveTo(18, 44, 16, 52)
  ctx.lineTo(24, 46)
  ctx.bezierCurveTo(28, 43, 32, 39, 35, 34)
  ctx.bezierCurveTo(38, 30, 41, 25, 43, 20)
  ctx.lineTo(45, 14)
  ctx.quadraticCurveTo(46, 11, 48, 4)
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
  // Quill line
  ctx.beginPath()
  ctx.moveTo(20, 40)
  ctx.bezierCurveTo(28, 24, 36, 12, 48, 4)
  ctx.strokeStyle = '#0a0e14'
  ctx.lineWidth = 1.5
  ctx.stroke()
  ctx.restore()
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link) }
  link.href = c.toDataURL()
}

const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)

export default function App() {
  const [authUser, setAuthUser] = createSignal<{ username: string; admin: boolean } | null>(null)
  const [authChecked, setAuthChecked] = createSignal(false)
  const [loginError, setLoginError] = createSignal('')
  const [loginLoading, setLoginLoading] = createSignal(false)

  const [sessions, setSessions] = createSignal<SessionMeta[]>([])
  const [currentId, setCurrentId] = createSignal<string | null>(null)
  const [messages, setMessages] = createSignal<Message[]>([])
  const [sidebar, setSidebar] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [creating, setCreating] = createSignal(false)
  const [text, setText] = createSignal('')
  const [tab, setTab] = createSignal<'chat' | 'files' | 'terminal'>('chat')
  const [files, setFiles] = createSignal<PendingFile[]>([])
  const [uploading, setUploading] = createSignal(false)
  const [working, setWorking] = createSignal(false)
  const [dragging, setDragging] = createSignal(false)
  const [menuOpen, setMenuOpen] = createSignal(false)
  const [historyIdx, setHistoryIdx] = createSignal(-1)
  const [sseStatus, setSSEStatus] = createSignal<'connected' | 'reconnecting'>('connected')
  const [activity, setActivity] = createSignal<string | null>(null)
  const [question, setQuestion] = createSignal<QuestionData | null>(null)
  const [listening, setListening] = createSignal(false)
  const [hasMore, setHasMore] = createSignal(false)
  const [loadingMore, setLoadingMore] = createSignal(false)
  const [renaming, setRenaming] = createSignal(false)
  const [renameText, setRenameText] = createSignal('')
  const [sidebarRenaming, setSidebarRenaming] = createSignal<string | null>(null)
  const [sidebarRenameText, setSidebarRenameText] = createSignal('')
  const [sidebarTab, setSidebarTab] = createSignal<'sessions' | 'links'>('sessions')
  const [projectsExpanded, setProjectsExpanded] = createSignal(true)
  const [links, setLinks] = createSignal<QuickLink[]>([])
  const [starred, setStarred] = createSignal<Record<string, string[]>>({})
  const [projects, setProjects] = createSignal<Project[]>([])
  const [currentProject, setCurrentProject] = createSignal<string | null>(localStorage.getItem('feather-next-project'))
  const [expandedGroups, setExpandedGroups] = createSignal<Record<string, boolean>>(JSON.parse(localStorage.getItem('feather-next-groups') || '{}'))
  const [unreadSessions, setUnreadSessions] = createSignal<Set<string>>(new Set())
  const [searchOpen, setSearchOpen] = createSignal(false)
  const [searchQuery, setSearchQuery] = createSignal('')
  const [searchResults, setSearchResults] = createSignal<SearchResult[]>([])
  const [searching, setSearching] = createSignal(false)
  let searchTimer: ReturnType<typeof setTimeout> | undefined

  // File browser state
  interface DirEntry { name: string; path: string; isDir: boolean; size: number | null; mtime: string }
  const [browseDir, setBrowseDir] = createSignal<string | null>(null)
  const [browseEntries, setBrowseEntries] = createSignal<DirEntry[]>([])
  const [browseParent, setBrowseParent] = createSignal<string | null>(null)
  const [browseLoading, setBrowseLoading] = createSignal(false)

  async function openFileBrowser(dir?: string) {
    const target = dir || sessionStats().cwd || '/home/user'
    setBrowseLoading(true)
    try {
      const base = location.pathname.replace(/\/+$/, '')
      const resp = await fetch(`${base}/api/files/list?dir=${encodeURIComponent(target)}`)
      const data = await resp.json()
      if (resp.ok) {
        setBrowseDir(data.dir)
        setBrowseParent(data.parent !== data.dir ? data.parent : null)
        setBrowseEntries(data.entries)
      }
    } catch {}
    setBrowseLoading(false)
  }

  const lastSeenUpdatedAt = new Map<string, string>() // session ID -> last known updatedAt
  const [updateAvailable, setUpdateAvailable] = createSignal(false)
  const [updateChanges, setUpdateChanges] = createSignal('')
  const [showChangelog, setShowChangelog] = createSignal(false)
  const currentJsFile = document.querySelector<HTMLScriptElement>('script[src*="index-"]')?.src.match(/index-[^.]+\.js/)?.[0] || null

  let cleanupSSE: (() => void) | null = null
  let recognition: any = null
  let textareaRef: HTMLTextAreaElement | undefined
  let fileInputRef: HTMLInputElement | undefined
  let dragCounter = 0

  // Update sessions and detect unread changes
  function updateSessions(newSessions: SessionMeta[]) {
    const active = currentId()
    const unread = new Set(unreadSessions())
    for (const s of newSessions) {
      const prev = lastSeenUpdatedAt.get(s.id)
      if (prev && s.updatedAt !== prev && s.id !== active) {
        unread.add(s.id)
      }
      // Only update lastSeen if this is the current session or first time seeing it
      if (s.id === active || !prev) {
        lastSeenUpdatedAt.set(s.id, s.updatedAt)
      }
    }
    setUnreadSessions(unread)
    setSessions(newSessions)
  }

  // Swipe gesture state
  let touchStartX = 0
  let touchStartY = 0
  let touchTracking = false

  function onTouchStart(e: TouchEvent) {
    const t = e.touches[0]
    touchStartX = t.clientX
    touchStartY = t.clientY
    touchTracking = sidebar() || touchStartX < 30
  }
  function onTouchEnd(e: TouchEvent) {
    if (!touchTracking) return
    const t = e.changedTouches[0]
    const dx = t.clientX - touchStartX
    const dy = Math.abs(t.clientY - touchStartY)
    if (dy > Math.abs(dx)) return
    if (!sidebar() && dx > 60) setSidebar(true)
    if (sidebar() && dx < -60) setSidebar(false)
    touchTracking = false
  }

  async function addFiles(fileList: FileList | File[]) {
    const added: PendingFile[] = []
    for (const f of fileList) {
      const isImage = f.type.startsWith('image/')
      const blob = isImage ? await resizeImage(f) : f
      const dataUrl = await new Promise<string>(r => { const rd = new FileReader(); rd.onload = () => r(rd.result as string); rd.readAsDataURL(blob) })
      added.push({ name: f.name, blob, dataUrl, isImage })
    }
    setFiles(prev => [...prev, ...added])
  }

  function removeFile(idx: number) { setFiles(prev => prev.filter((_, i) => i !== idx)) }

  // Scroll position memory (in-memory, per session)
  const scrollPositions = new Map<string, number>()
  let messageScrollRef: HTMLDivElement | undefined
  let workingTimer: number | undefined
  let assistantDoneTimer: number | undefined

  function startWorkingTimeout() {
    clearTimeout(workingTimer)
    workingTimer = window.setTimeout(() => {
      if (working()) setWorking(false)
    }, 5 * 60 * 1000)
  }

  function onGlobalKeyDown(e: KeyboardEvent) {
    // Ctrl+B / Cmd+B: toggle sidebar
    if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
      e.preventDefault()
      setSidebar(!sidebar())
      return
    }
    // Escape: close sidebar if open, otherwise interrupt active session
    if (e.key === 'Escape') {
      if (sidebar()) { setSidebar(false); return }
      const s = cur()
      if (s?.isActive) handleInterrupt(s.id)
    }
  }

  async function initApp() {
    document.addEventListener('keydown', onGlobalKeyDown)
    updateSessions(await fetchSessions(currentProject()))
    fetchProjects().then(setProjects).catch(() => {})
    const base = location.pathname.replace(/\/+$/, '')
    fetch(`${base}/api/quick-links`).then(r => r.ok ? r.json() : []).then(setLinks).catch(() => {})
    fetchStarred().then(setStarred).catch(() => {})
    const hash = location.hash.slice(1)
    if (hash) select(hash)
  }

  onMount(async () => {
    // Set --vh for iOS keyboard handling
    function setVh() {
      const vh = (window.visualViewport?.height || window.innerHeight) * 0.01
      document.documentElement.style.setProperty('--vh', `${vh}px`)
    }
    setVh()
    window.visualViewport?.addEventListener('resize', setVh)
    window.addEventListener('resize', setVh)

    const user = await checkAuth()
    setAuthChecked(true)
    if (user) {
      setAuthUser(user)
      await initApp()
    }

    // Check for updates every 30 seconds
    async function checkForUpdate() {
      try {
        const r = await fetch(`${location.pathname.replace(/\/+$/, '')}/api/version`)
        if (!r.ok) return
        const { stagingJs, changes } = await r.json()
        if (stagingJs && currentJsFile && stagingJs !== currentJsFile) {
          setUpdateAvailable(true)
          if (changes) setUpdateChanges(changes)
        } else {
          setUpdateAvailable(false)
        }
      } catch {}
    }
    checkForUpdate()
    const versionInterval = setInterval(checkForUpdate, 30000)
    onCleanup(() => clearInterval(versionInterval))
  })
  onCleanup(() => { cleanupSSE?.(); document.removeEventListener('keydown', onGlobalKeyDown) })

  // Re-fetch sessions when project filter changes
  let prevProject = currentProject()
  createEffect(() => {
    const proj = currentProject()
    if (proj !== prevProject) {
      prevProject = proj
      fetchSessions(proj).then(s => updateSessions(s)).catch(() => {})
    }
  })

  async function select(id: string) {
    const prev = currentId()
    if (prev) {
      saveDraft(prev, text())
      // Save scroll position of current session
      if (messageScrollRef) scrollPositions.set(prev, messageScrollRef.scrollTop)
    }
    setCurrentId(id)
    location.hash = id
    setSidebar(false)
    setLoading(true)
    setMessages([])
    setWorking(false)
    setActivity(null)
    setQuestion(null)
    setText(loadDraft(id))
    setHistoryIdx(-1)
    // Clear unread status and update lastSeen timestamp
    const unread = new Set(unreadSessions())
    unread.delete(id)
    setUnreadSessions(unread)
    let s = sessions().find(s => s.id === id)
    if (s) { lastSeenUpdatedAt.set(id, s.updatedAt); setLastSession(s) }
    else {
      setLastSession({ id, title: 'New session', updatedAt: new Date().toISOString(), isActive: true })
      // Session not in filtered list; fetch unfiltered to get full metadata (cwd, title, etc.)
      fetchSessions().then(all => {
        const found = all.find(a => a.id === id)
        if (found) setLastSession(found)
      }).catch(() => {})
    }
    cleanupSSE?.()
    clearTimeout(workingTimer)
    try {
      const result = await fetchMessages(id)
      setMessages(result.messages)
      setHasMore(result.hasMore)
      // Determine working state from loaded messages.
      // Only mark as working if the session is actually active (has a running tmux process).
      // Inactive/timed-out sessions should never show as working.
      const sessionMeta = sessions().find(x => x.id === id) || lastSession()
      const isActive = sessionMeta?.isActive ?? false
      const msgs = result.messages
      if (msgs.length > 0) {
        const last = msgs[msgs.length - 1]
        if (!isActive) setWorking(false)
        else if (last.stopReason === 'end_turn' || last.stopReason === 'stop_sequence') setWorking(false)
        else if (last.role === 'user') setWorking(true)
        else setWorking(false) // assistant mid-stream but no new SSE yet; let SSE update it
        // Extract cwd from last user message and update header
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].cwd) {
            const ls = lastSession()
            if (ls && ls.id === id && !ls.cwd) setLastSession({ ...ls, cwd: msgs[i].cwd })
            break
          }
        }
      }
    } catch {}
    setLoading(false)
    // Restore scroll position if we have one saved
    const savedScroll = scrollPositions.get(id)
    if (savedScroll !== undefined) {
      requestAnimationFrame(() => {
        if (messageScrollRef) messageScrollRef.scrollTop = savedScroll
      })
    }
    setSSEStatus('connected')
    cleanupSSE = subscribeMessages(id, (msg) => {
      // Clear assistant-done debounce on any incoming message
      clearTimeout(assistantDoneTimer)
      // If new content arrives while a question is showing, it was a false positive
      if (question() && msg.role === 'assistant' && !msg.stopReason) setQuestion(null)
      // Use stop_reason to accurately track working state
      if (msg.stopReason === 'end_turn' || msg.stopReason === 'stop_sequence') {
        setWorking(false)
        clearTimeout(workingTimer)
        // Refresh session list to pick up auto-generated title
        const cur = sessions().find(s => s.id === id)
        if (cur && (cur.title === 'New session' || cur.title === id.slice(0, 8))) {
          setTimeout(() => fetchSessions(currentProject()).then(s => updateSessions(s)).catch(() => {}), 3000)
        }
      } else if (msg.role === 'user') {
        setWorking(true)
        startWorkingTimeout()
      } else if (msg.role === 'assistant' && !msg.stopReason) {
        // Assistant message without stop_reason: JSONL may never get end_turn.
        // Debounce: if no more messages arrive in 5s, assume the turn is done.
        assistantDoneTimer = window.setTimeout(() => {
          if (working()) {
            setWorking(false)
            clearTimeout(workingTimer)
          }
        }, 5000)
      }
      // Update session cwd from incoming user messages
      if (msg.cwd && msg.role === 'user') {
        setSessions(prev => prev.map(s => s.id === id ? { ...s, cwd: msg.cwd } : s))
        // Also update lastSession directly in case session isn't in the filtered list
        const ls = lastSession()
        if (ls && ls.id === id && ls.cwd !== msg.cwd) {
          setLastSession({ ...ls, cwd: msg.cwd })
        }
      }
      // Keep lastSeen fresh so the current session doesn't go unread on next poll
      lastSeenUpdatedAt.set(id, new Date().toISOString())
      setMessages(prev => {
        if (prev.some(m => m.uuid === msg.uuid)) return prev
        if (msg.role === 'user') {
          const msgText = msg.content?.find(b => b.type === 'text')?.text || ''
          const idx = prev.findIndex(m =>
            m.uuid.startsWith('optimistic-') &&
            m.content?.[0]?.text === msgText &&
            Math.abs(new Date(m.timestamp).getTime() - new Date(msg.timestamp).getTime()) < 30000
          )
          if (idx >= 0) {
            const updated = [...prev]
            updated[idx] = { ...msg, delivery: 'delivered' }
            return updated
          }
        }
        return [...prev, msg]
      })
    }, setSSEStatus, setActivity, setQuestion)
  }

  function doSearch(query: string) {
    clearTimeout(searchTimer)
    if (query.length < 2) { setSearchResults([]); setSearching(false); return }
    setSearching(true)
    searchTimer = setTimeout(async () => {
      try {
        const results = await searchSessions(query, currentProject())
        setSearchResults(results)
      } catch {}
      setSearching(false)
    }, 300)
  }

  const [starIdx, setStarIdx] = createSignal(-1)

  function jumpToNextStar() {
    if (!messageScrollRef || !currentId()) return
    const starredList = starred()[currentId()!] || []
    if (starredList.length === 0) return
    const next = (starIdx() + 1) % starredList.length
    setStarIdx(next)
    const el = messageScrollRef.querySelector(`[data-uuid="${starredList[next]}"]`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    } else {
      // Message might not be loaded yet, try next
      if (starredList.length > 1) {
        const alt = (next + 1) % starredList.length
        setStarIdx(alt)
        const el2 = messageScrollRef.querySelector(`[data-uuid="${starredList[alt]}"]`)
        el2?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    }
  }

  function scrollToPrevUserMessage() {
    if (!messageScrollRef) return
    const els = messageScrollRef.querySelectorAll('[data-role="user"]')
    if (!els.length) return
    const viewTop = messageScrollRef.getBoundingClientRect().top
    let target: Element | null = null
    for (let i = els.length - 1; i >= 0; i--) {
      if (els[i].getBoundingClientRect().top < viewTop + 5) { target = els[i]; break }
    }
    if (!target) target = els[0]
    const offset = target.getBoundingClientRect().top - viewTop - 16
    messageScrollRef.scrollTo({ top: messageScrollRef.scrollTop + offset })
  }

  async function handleNew(newTab = false) {
    setCreating(true)
    // Open the window synchronously to avoid popup blockers (iOS Safari
    // blocks window.open after an await breaks the user-gesture chain)
    const w = newTab ? window.open('', '_blank') : null
    try {
      const proj = currentProject() ? projects().find(p => p.id === currentProject()) : null
      const id = await createSession(proj?.cwd ?? undefined)
      // Fetch without project filter since the new session has no project yet
      updateSessions(await fetchSessions())
      if (w) {
        w.location.href = `${location.origin}${location.pathname}#${id}`
      } else {
        await select(id)
      }
    } catch {
      if (w) w.close()
    }
    finally { setCreating(false) }
  }

  async function handleResume(id: string) {
    const sess = sessions().find(s => s.id === id)
    await resumeSession(id, sess?.cwd ?? undefined)
    updateSessions(await fetchSessions(currentProject()))
    await select(id)
  }

  async function handleInterrupt(id: string) {
    await interruptSession(id)
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this session?')) return
    setMenuOpen(false)
    await deleteSession(id)
    setCurrentId(null)
    location.hash = ''
    cleanupSSE?.()
    setMessages([])
    updateSessions(await fetchSessions())
  }

  async function doRename(id: string, title: string) {
    if (!title.trim()) { setRenaming(false); setSidebarRenaming(null); return }
    await renameSession(id, title.trim())
    setRenaming(false)
    setMenuOpen(false)
    setSidebarRenaming(null)
    updateSessions(await fetchSessions(currentProject()))
  }

  async function loadEarlier() {
    const id = currentId()
    if (!id || loadingMore()) return
    setLoadingMore(true)
    try {
      const result = await fetchMessages(id, messages().length)
      setMessages(prev => [...result.messages, ...prev])
      setHasMore(result.hasMore)
    } catch {}
    setLoadingMore(false)
  }

  async function toggleStar(sessionId: string, msgUuid: string) {
    const s = { ...starred() }
    const list = s[sessionId] || []
    const idx = list.indexOf(msgUuid)
    if (idx >= 0) list.splice(idx, 1)
    else list.push(msgUuid)
    s[sessionId] = list.filter(Boolean)
    if (s[sessionId].length === 0) delete s[sessionId]
    setStarred(s)
    saveStarred(s).catch(() => {})
  }

  async function handleFork(id: string) {
    setMenuOpen(false)
    await forkSession(id)
    updateSessions(await fetchSessions(currentProject()))
  }

  function toggleVoice() {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) return
    if (listening()) { recognition?.stop(); setListening(false); return }
    recognition = new SR()
    recognition.continuous = true
    recognition.interimResults = false
    recognition.lang = 'en-US'
    recognition.onresult = (e: any) => {
      let t = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) t += e.results[i][0].transcript
      }
      if (t) setText(prev => prev + (prev ? ' ' : '') + t)
    }
    recognition.onend = () => setListening(false)
    recognition.onerror = () => setListening(false)
    recognition.start()
    setListening(true)
  }

  async function handleSend() {
    const val = text().trim()
    const pending = files()
    if (!val && !pending.length) return
    // Auto-create session if none selected
    if (!currentId()) {
      try {
        const id = await createSession()
        updateSessions(await fetchSessions(currentProject()))
        await select(id)
      } catch { return }
    }
    if (!currentId()) return
    // Auto-resume if session is inactive
    const s = cur() || lastSession()
    if (s && !s.isActive) {
      await resumeSession(s.id, s.cwd ?? undefined)
      updateSessions(await fetchSessions(currentProject()))
    }
    setUploading(true)
    setText('')
    setFiles([])
    if (textareaRef) textareaRef.style.height = 'auto'

    const parts: string[] = val ? [val] : []
    for (const f of pending) {
      try {
        const uploadPath = await uploadFile(f.blob, f.name)
        parts.push(f.isImage ? `[Attached image: ${uploadPath}]` : `[Attached file: ${uploadPath}] (${f.name})`)
      } catch { parts.push(`[Upload failed: ${f.name}]`) }
    }
    const fullText = parts.join('\n')
    pushHistory(fullText)
    saveDraft(currentId()!, '')

    const tempId = `optimistic-${Date.now()}`
    setMessages(prev => [...prev, {
      uuid: tempId, role: 'user', timestamp: new Date().toISOString(),
      content: [{ type: 'text', text: fullText }], delivery: 'sent',
    }])
    sendInput(currentId()!, fullText)
    setUploading(false)
    setWorking(true)
    startWorkingTimeout()
  }

  const cur = () => sessions().find(s => s.id === currentId())
  const [lastSession, setLastSession] = createSignal<SessionMeta | null>(null)

  // Derive session stats from loaded messages (memoized to avoid re-iterating on every access)
  const sessionStats = createMemo(() => {
    const msgs = messages()
    let cwd: string | undefined
    let model: string | undefined
    let version: string | undefined
    let totalIn = 0
    let totalOut = 0
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (!cwd && m.cwd) cwd = m.cwd
      if (!model && m.model) model = m.model
      if (!version && m.version) version = m.version
      if (cwd && model && version) break
    }
    for (const m of msgs) {
      if (m.usage) {
        totalIn += (m.usage.input_tokens || 0)
        totalOut += (m.usage.output_tokens || 0)
      }
    }
    return { cwd, model, version, totalIn, totalOut }
  })

  const currentCwd = () => sessionStats().cwd || headerSession()?.cwd || null

  // Keep lastSession in sync - persists even when sessions list doesn't contain the session
  createEffect(() => {
    const s = cur()
    if (s) setLastSession(s)
    else if (!currentId()) setLastSession(null)
  })

  // Effective session for header display (cur() is live, lastSession is fallback)
  const headerSession = () => cur() || lastSession()

  createEffect(() => {
    const s = headerSession()
    const w = working()
    if (!s) setFavicon('#333')
    else if (w) setFavicon('#f5a742')        // Orange when working
    else if (s.isActive) setFavicon('#4aba6a') // Green when ready
    else setFavicon('#666')                    // Gray when inactive
  })

  // Page title: feather icon + status dot + project name
  createEffect(() => {
    const s = headerSession()
    const w = working()
    const unreadCount = unreadSessions().size
    const unreadPrefix = unreadCount > 0 ? `(${unreadCount}) ` : ''
    const dot = w ? '\u25CF' : '\u25CB'
    if (s) {
      const proj = s.projectLabel || projects().find(p => p.id === s.projectId)?.label
      const label = proj || s.title.slice(0, 30)
      document.title = `${unreadPrefix}${dot} ${label}`
    } else {
      document.title = `${unreadPrefix}Feather`
    }
  })

  const touchedFiles = createMemo(() => {
    const files = new Map<string, { actions: Set<string>, lastSeen: string }>()
    for (const msg of messages()) {
      for (const block of msg.content || []) {
        if (block.type !== 'tool_use') continue
        const fp = block.input?.file_path
        if (typeof fp === 'string' && fp.startsWith('/')) {
          const existing = files.get(fp)
          if (existing) { existing.actions.add(block.name || 'tool'); existing.lastSeen = msg.timestamp }
          else files.set(fp, { actions: new Set([block.name || 'tool']), lastSeen: msg.timestamp })
        }
      }
    }
    const actionOrder = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash']
    return [...files.entries()]
      .map(([path, { actions, lastSeen }]) => ({
        path, lastSeen,
        actions: [...actions].sort((a, b) => (actionOrder.indexOf(a) === -1 ? 99 : actionOrder.indexOf(a)) - (actionOrder.indexOf(b) === -1 ? 99 : actionOrder.indexOf(b))),
      }))
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
  })

  const tabStyle = (t: string) => ({
    padding: '6px 16px', border: 'none', 'border-bottom': tab() === t ? '2px solid #4aba6a' : '2px solid transparent',
    background: 'none', color: tab() === t ? '#e5e5e5' : '#666', 'font-size': '13px', 'font-weight': '600', cursor: 'pointer',
    '-webkit-tap-highlight-color': 'transparent',
  })

  async function handleLogin(e: Event) {
    e.preventDefault()
    setLoginLoading(true)
    setLoginError('')
    const form = e.target as HTMLFormElement
    const username = (form.querySelector('[name=username]') as HTMLInputElement).value
    const password = (form.querySelector('[name=password]') as HTMLInputElement).value
    try {
      const result = await login(username, password)
      if (result.ok) {
        const user = await checkAuth()
        if (user) {
          setAuthUser(user)
          await initApp()
        }
      } else {
        setLoginError(result.error || 'Login failed')
      }
    } catch {
      setLoginError('Connection error')
    }
    setLoginLoading(false)
  }

  async function handleLogout() {
    await logout()
    setAuthUser(null)
    setSessions([])
    setCurrentId(null)
    setMessages([])
  }

  // Login screen component
  const LoginScreen = () => (
    <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'center', height: 'calc(var(--vh, 1vh) * 100)', background: '#0a0e14', 'font-family': "-apple-system, BlinkMacSystemFont, 'SF Pro', system-ui, sans-serif", padding: '20px' }}>
      <form onSubmit={handleLogin} action="/api/login" method="POST" style={{ width: '100%', 'max-width': '320px', background: '#0d1117', border: '1px solid #1e1e1e', 'border-radius': '16px', padding: '32px 24px', 'text-align': 'center' }}>
        <div style={{ 'font-size': '40px', 'margin-bottom': '8px' }}>&#x1fab6;</div>
        <h1 style={{ 'font-size': '20px', 'font-weight': '700', color: '#e5e5e5', 'margin-bottom': '24px' }}>Feather</h1>
        <label for="username" style={{ display: 'none' }}>Username</label>
        <input id="username" name="username" type="text" placeholder="Username" autocomplete="username" autofocus
          style={{ width: '100%', padding: '12px 16px', background: '#161b22', border: '1px solid #333', 'border-radius': '8px', color: '#e5e5e5', 'font-size': '15px', 'margin-bottom': '12px', outline: 'none', 'box-sizing': 'border-box' }} />
        <label for="password" style={{ display: 'none' }}>Password</label>
        <input id="password" name="password" type="password" placeholder="Password" autocomplete="current-password"
          style={{ width: '100%', padding: '12px 16px', background: '#161b22', border: '1px solid #333', 'border-radius': '8px', color: '#e5e5e5', 'font-size': '15px', 'margin-bottom': '16px', outline: 'none', 'box-sizing': 'border-box' }} />
        <Show when={loginError()}>
          <div style={{ color: '#d45555', 'font-size': '13px', 'margin-bottom': '12px' }}>{loginError()}</div>
        </Show>
        <button type="submit" disabled={loginLoading()}
          style={{ width: '100%', padding: '12px', background: loginLoading() ? '#1a1a2e' : '#4aba6a', color: loginLoading() ? '#666' : '#000', border: 'none', 'border-radius': '8px', 'font-size': '15px', 'font-weight': '600', cursor: loginLoading() ? 'wait' : 'pointer' }}>
          {loginLoading() ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </div>
  )

  return (
    <>
    <style>{`textarea::-webkit-scrollbar { display: none; }`}</style>
    <Show when={authChecked()} fallback={<div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'center', height: '100vh', background: '#0a0e14', color: '#555', 'font-family': "-apple-system, system-ui, sans-serif" }}>Loading...</div>}>
    <Show when={authUser()} fallback={<LoginScreen />}>
    <div
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onDragEnter={(e) => { e.preventDefault(); dragCounter++; setDragging(true) }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => { dragCounter--; if (dragCounter <= 0) { dragCounter = 0; setDragging(false) } }}
      onDrop={(e) => { e.preventDefault(); dragCounter = 0; setDragging(false); if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files) }}
      style={{ display: 'flex', height: 'calc(var(--vh, 1vh) * 100)', width: '100%', 'font-family': "-apple-system, BlinkMacSystemFont, 'SF Pro', system-ui, sans-serif", position: 'relative', 'overscroll-behavior': 'none' }}>

      {/* Hamburger */}
      <Show when={!sidebar()}>
        <button onClick={() => setSidebar(true)} style={{ position: 'fixed', top: 'max(12px, env(safe-area-inset-top))', left: 'max(12px, env(safe-area-inset-left))', 'z-index': '50', background: '#1a1a2e', border: '1px solid #333', color: '#e5e5e5', width: '36px', height: '36px', 'border-radius': '8px', 'font-size': '18px', cursor: 'pointer', display: 'flex', 'align-items': 'center', 'justify-content': 'center', '-webkit-tap-highlight-color': 'transparent' }}>&#9776;</button>
      </Show>

      {/* Sidebar backdrop */}
      <Show when={sidebar()}>
        <div onClick={() => setSidebar(false)} style={{ position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.5)', 'z-index': '59', '-webkit-tap-highlight-color': 'transparent' }} />
      </Show>

      {/* Sidebar */}
      <div style={{
        position: 'fixed', top: '0', left: '0', bottom: '0', width: '300px', 'max-width': '85vw',
        background: '#0d1117', 'z-index': '60',
        transform: sidebar() ? 'translateX(0)' : 'translateX(-100%)',
        transition: 'transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
        'will-change': 'transform',
        'padding-top': 'env(safe-area-inset-top)', 'padding-left': 'env(safe-area-inset-left)',
      }}>
        <div style={{ display: 'flex', 'flex-direction': 'column', height: '100%' }}>
          <div style={{ padding: '12px 16px', display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', 'border-bottom': '1px solid #1e1e1e' }}>
            <span style={{ 'font-weight': '700', 'font-size': '16px' }}>Feather</span>
            <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
              <span style={{ 'font-size': '12px', color: '#4aba6a', 'font-weight': '500' }}>{authUser()?.username}</span>
              <button onClick={handleLogout} style={{ background: 'none', border: '1px solid #333', color: '#888', 'font-size': '11px', padding: '2px 8px', 'border-radius': '4px', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>Logout</button>
              <button onClick={() => setSidebar(false)} style={{ background: 'none', border: 'none', color: '#666', 'font-size': '20px', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent', padding: '4px 8px' }}>&times;</button>
            </div>
          </div>
          {/* Sidebar tabs */}
          <div style={{ display: 'flex', 'border-bottom': '1px solid #1e1e1e' }}>
            <button onClick={() => setSidebarTab('sessions')} style={{ flex: '1', padding: '8px', border: 'none', 'border-bottom': sidebarTab() === 'sessions' ? '2px solid #4aba6a' : '2px solid transparent', background: 'none', color: sidebarTab() === 'sessions' ? '#e5e5e5' : '#666', 'font-size': '12px', 'font-weight': '600', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>Sessions</button>
            <button onClick={() => setSidebarTab('links')} style={{ flex: '1', padding: '8px', border: 'none', 'border-bottom': sidebarTab() === 'links' ? '2px solid #4aba6a' : '2px solid transparent', background: 'none', color: sidebarTab() === 'links' ? '#e5e5e5' : '#666', 'font-size': '12px', 'font-weight': '600', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>Links</button>
          </div>
          {/* Sessions tab */}
          <Show when={sidebarTab() === 'sessions'}>
            {/* Project tree (collapsed by default, click to expand) */}
            <div style={{ 'border-bottom': '1px solid #1e1e1e', padding: '4px 0' }}>
              <div style={{ display: 'flex', 'align-items': 'center', gap: '6px', padding: '4px 16px' }}>
                <div onClick={() => setProjectsExpanded(!projectsExpanded())}
                  style={{ cursor: 'pointer', 'font-size': '11px', 'font-weight': '600', color: '#777', 'text-transform': 'uppercase', 'letter-spacing': '0.05em', '-webkit-tap-highlight-color': 'transparent', display: 'flex', 'align-items': 'center', gap: '4px' }}>
                  <span style={{ 'font-size': '8px', transition: 'transform 0.15s', transform: projectsExpanded() ? 'rotate(90deg)' : 'none' }}>&#9654;</span>
                  Projects
                </div>
                <Show when={currentProject()}>
                  <span style={{ 'font-size': '11px', color: '#4aba6a', 'font-weight': '600' }}>{projects().find(p => p.id === currentProject())?.label || ''}</span>
                  <span onClick={(e) => { e.stopPropagation(); setCurrentProject(null); localStorage.removeItem('feather-next-project') }}
                    style={{ 'font-size': '10px', color: '#666', cursor: 'pointer', padding: '0 4px' }}>&times;</span>
                </Show>
              </div>
              <Show when={projectsExpanded()}>
              <div style={{ 'max-height': '50vh', 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch' }}>
              {/* All projects button */}
              <div onClick={() => { setCurrentProject(null); localStorage.removeItem('feather-next-project'); setProjectsExpanded(false) }}
                style={{ padding: '4px 16px', cursor: 'pointer', 'font-size': '11px', 'font-weight': '600', color: currentProject() === null ? '#4aba6a' : '#888', '-webkit-tap-highlight-color': 'transparent' }}>
                All
              </div>
              {/* Grouped projects */}
              {(() => {
                const projs = projects()
                const grouped: Record<string, Project[]> = {}
                const ungrouped: Project[] = []
                projs.forEach(p => {
                  const idx = p.label.indexOf(' / ')
                  if (idx >= 0) {
                    const g = p.label.substring(0, idx)
                    if (!grouped[g]) grouped[g] = []
                    grouped[g].push({ ...p, label: p.label.substring(idx + 3) })
                  } else {
                    ungrouped.push(p)
                  }
                })
                const groups = Object.keys(grouped).sort()
                return <>
                  <For each={groups}>{(group) => {
                    const isOpen = () => expandedGroups()[group]
                    const toggle = () => {
                      const next = { ...expandedGroups(), [group]: !isOpen() }
                      setExpandedGroups(next)
                      localStorage.setItem('feather-next-groups', JSON.stringify(next))
                    }
                    return <>
                      <div onClick={toggle} style={{ padding: '4px 16px', cursor: 'pointer', display: 'flex', 'align-items': 'center', gap: '4px', 'font-size': '11px', 'font-weight': '600', color: '#777', 'text-transform': 'uppercase', 'letter-spacing': '0.05em', '-webkit-tap-highlight-color': 'transparent' }}>
                        <span style={{ 'font-size': '8px', transition: 'transform 0.15s', transform: isOpen() ? 'rotate(90deg)' : 'none' }}>&#9654;</span>
                        {group}
                      </div>
                      <Show when={isOpen()}>
                        <For each={grouped[group]}>{(p) => (
                          <div onClick={() => { setCurrentProject(p.id); localStorage.setItem('feather-next-project', p.id) }}
                            style={{ padding: '3px 16px 3px 28px', cursor: 'pointer', 'font-size': '12px', color: currentProject() === p.id ? '#4aba6a' : '#aaa', 'font-weight': currentProject() === p.id ? '600' : '400', '-webkit-tap-highlight-color': 'transparent' }}>
                            {p.label}
                          </div>
                        )}</For>
                      </Show>
                    </>
                  }}</For>
                  <For each={ungrouped}>{(p) => (
                    <div onClick={() => { setCurrentProject(p.id); localStorage.setItem('feather-next-project', p.id) }}
                      style={{ padding: '3px 16px', cursor: 'pointer', 'font-size': '12px', color: currentProject() === p.id ? '#4aba6a' : '#aaa', 'font-weight': currentProject() === p.id ? '600' : '400', '-webkit-tap-highlight-color': 'transparent' }}>
                      {p.label}
                    </div>
                  )}</For>
                </>
              })()}
              </div>
              </Show>
            </div>
            {/* New session + search buttons */}
            <div style={{ padding: '8px 16px', display: 'flex', gap: '8px' }}>
              <button onClick={() => handleNew()} disabled={creating()} style={{ flex: '1', padding: '10px', background: creating() ? '#1a1a2e' : '#4aba6a', color: creating() ? '#666' : '#000', border: 'none', 'border-radius': '8px', 'font-size': '14px', 'font-weight': '600', cursor: creating() ? 'wait' : 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>
                {creating() ? 'Starting...' : '+ New Claude'}
              </button>
              <button onClick={() => handleNew(true)} disabled={creating()} title="Open in new tab" style={{ padding: '10px 12px', background: creating() ? '#1a1a2e' : '#3a9a5a', color: creating() ? '#666' : '#000', border: 'none', 'border-radius': '8px', 'font-size': '14px', 'font-weight': '600', cursor: creating() ? 'wait' : 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>
                &#8599;
              </button>
              <button onClick={() => { setSearchOpen(!searchOpen()); if (!searchOpen()) { setSearchQuery(''); setSearchResults([]) } }} title="Search chats" style={{ padding: '10px 12px', background: searchOpen() ? '#4aba6a' : '#1a1a2e', color: searchOpen() ? '#000' : '#888', border: '1px solid #333', 'border-radius': '8px', 'font-size': '14px', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>
                &#x1F50D;
              </button>
            </div>
            {/* Search input */}
            <Show when={searchOpen()}>
              <div style={{ padding: '0 16px 8px' }}>
                <input
                  placeholder={currentProject() ? 'Search in project...' : 'Search all chats...'}
                  value={searchQuery()}
                  onInput={(e) => { setSearchQuery(e.target.value); doSearch(e.target.value) }}
                  onKeyDown={(e) => { if (e.key === 'Escape') { setSearchOpen(false); setSearchQuery(''); setSearchResults([]) } }}
                  ref={(el) => setTimeout(() => el.focus(), 50)}
                  style={{ width: '100%', padding: '8px 12px', background: '#0e0e14', border: '1px solid #333', 'border-radius': '6px', color: '#e5e5e5', 'font-size': '13px', outline: 'none' }}
                />
              </div>
            </Show>
            {/* Session list (filtered by project, grouped by time) */}
            <div style={{ flex: '1', 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch', 'overscroll-behavior': 'contain', 'padding-bottom': 'env(safe-area-inset-bottom)' }}>
              {/* Search results */}
              <Show when={searchOpen() && searchQuery().length >= 2}>
                <Show when={searching()}>
                  <div style={{ padding: '20px 16px', color: '#555', 'font-size': '13px', 'text-align': 'center' }}>Searching...</div>
                </Show>
                <Show when={!searching() && searchResults().length === 0 && searchQuery().length >= 2}>
                  <div style={{ padding: '20px 16px', color: '#555', 'font-size': '13px', 'text-align': 'center' }}>No results found</div>
                </Show>
                <Show when={!searching() && searchResults().length > 0}>
                  <div style={{ padding: '6px 16px 2px', 'font-size': '10px', 'font-weight': '600', color: '#555', 'text-transform': 'uppercase', 'letter-spacing': '0.05em' }}>{searchResults().length} result{searchResults().length !== 1 ? 's' : ''}</div>
                  <For each={searchResults()}>{(r) => (
                    <div onClick={() => { select(r.id); setSearchOpen(false); setSearchQuery(''); setSearchResults([]) }}
                      style={{ padding: '10px 16px', cursor: 'pointer', 'border-left': r.id === currentId() ? '3px solid #4aba6a' : '3px solid transparent', background: r.id === currentId() ? '#1a1a2e' : 'transparent', 'border-bottom': '1px solid #111', '-webkit-tap-highlight-color': 'transparent' }}>
                      <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
                        <Show when={r.isActive}><span style={{ width: '6px', height: '6px', 'border-radius': '50%', background: '#4aba6a', 'flex-shrink': '0' }} /></Show>
                        <div style={{ flex: '1', 'min-width': '0' }}>
                          <div style={{ 'font-size': '13px', 'font-weight': '500', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{r.title}</div>
                          <Show when={!currentProject() && r.projectLabel}>
                            <div style={{ 'font-size': '10px', color: '#444', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{r.projectLabel}</div>
                          </Show>
                          <div style={{ 'font-size': '11px', color: '#666', 'margin-top': '4px', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{r.snippet}</div>
                        </div>
                        <div style={{ 'flex-shrink': '0', 'text-align': 'right' }}>
                          <div style={{ 'font-size': '11px', color: '#555' }}>{timeAgo(r.updatedAt)}</div>
                          <div style={{ 'font-size': '10px', color: '#444' }}>{r.matchCount} match{r.matchCount !== 1 ? 'es' : ''}</div>
                        </div>
                      </div>
                    </div>
                  )}</For>
                </Show>
              </Show>
              {/* Regular session list */}
              <Show when={!searchOpen() || searchQuery().length < 2}>
              {(() => {
                const filtered = sessions().filter(s => !currentProject() || s.projectId === currentProject())
                const now = new Date()
                const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
                const yesterdayStart = todayStart - 86400000
                const weekStart = todayStart - 6 * 86400000
                const groups: { label: string, items: SessionMeta[] }[] = [
                  { label: 'Today', items: [] },
                  { label: 'Yesterday', items: [] },
                  { label: 'This Week', items: [] },
                  { label: 'Older', items: [] },
                ]
                for (const s of filtered) {
                  const t = new Date(s.updatedAt).getTime()
                  if (t >= todayStart) groups[0].items.push(s)
                  else if (t >= yesterdayStart) groups[1].items.push(s)
                  else if (t >= weekStart) groups[2].items.push(s)
                  else groups[3].items.push(s)
                }
                return <For each={groups.filter(g => g.items.length > 0)}>{(group) => <>
                  <div style={{ padding: '6px 16px 2px', 'font-size': '10px', 'font-weight': '600', color: '#555', 'text-transform': 'uppercase', 'letter-spacing': '0.05em' }}>{group.label}</div>
                  <For each={group.items}>{(s) => (
                    <div onClick={() => { if (sidebarRenaming() !== s.id) select(s.id) }}
                      onDblClick={(e) => { e.preventDefault(); setSidebarRenameText(s.title); setSidebarRenaming(s.id) }}
                      onContextMenu={(e) => { e.preventDefault(); setSidebarRenameText(s.title); setSidebarRenaming(s.id) }}
                      style={{ padding: '10px 16px', cursor: 'pointer', 'border-left': s.id === currentId() ? '3px solid #4aba6a' : '3px solid transparent', background: s.id === currentId() ? '#1a1a2e' : 'transparent', 'border-bottom': '1px solid #111', '-webkit-tap-highlight-color': 'transparent' }}>
                      <Show when={sidebarRenaming() === s.id} fallback={
                        <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
                          <Show when={s.isActive}><span style={{ width: '6px', height: '6px', 'border-radius': '50%', background: '#4aba6a', 'flex-shrink': '0' }} /></Show>
                          <Show when={!s.isActive && unreadSessions().has(s.id)}><span style={{ width: '6px', height: '6px', 'border-radius': '50%', background: '#73b8ff', 'flex-shrink': '0' }} /></Show>
                          <div style={{ flex: '1', 'min-width': '0' }}>
                            <div style={{ 'font-size': '13px', 'font-weight': unreadSessions().has(s.id) ? '700' : '500', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{s.title}</div>
                            <Show when={!currentProject() && s.projectLabel}>
                              <div style={{ 'font-size': '10px', color: '#444', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{s.projectLabel}</div>
                            </Show>
                          </div>
                          <span style={{ 'font-size': '11px', color: '#555', 'flex-shrink': '0' }}>{timeAgo(s.updatedAt)}</span>
                        </div>
                      }>
                        <input
                          value={sidebarRenameText()}
                          onInput={(e) => setSidebarRenameText(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') doRename(s.id, sidebarRenameText()); if (e.key === 'Escape') setSidebarRenaming(null) }}
                          onBlur={() => doRename(s.id, sidebarRenameText())}
                          onClick={(e) => e.stopPropagation()}
                          ref={(el) => setTimeout(() => { el.focus(); el.select() }, 0)}
                          style={{ width: '100%', background: '#1a1a2e', border: '1px solid #4aba6a', 'border-radius': '4px', padding: '2px 6px', color: '#e5e5e5', 'font-size': '13px', outline: 'none' }}
                        />
                      </Show>
                    </div>
                  )}</For>
                </>}</For>
              })()}
              </Show>
            </div>
          </Show>
          {/* Links tab */}
          <Show when={sidebarTab() === 'links'}>
            <div style={{ flex: '1', 'overflow-y': 'auto', padding: '8px 0', '-webkit-overflow-scrolling': 'touch', 'overscroll-behavior': 'contain', 'padding-bottom': 'env(safe-area-inset-bottom)' }}>
              <For each={links()}>{(link) => (
                <a href={link.url} target="_blank" rel="noopener" style={{ display: 'block', padding: '10px 16px', color: '#73b8ff', 'text-decoration': 'none', 'font-size': '13px', 'font-weight': '500', 'border-bottom': '1px solid #111', '-webkit-tap-highlight-color': 'transparent' }}
                  onMouseOver={(e) => (e.currentTarget.style.background = '#1a1a2e')}
                  onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}>
                  {link.label}
                  <span style={{ color: '#444', 'font-size': '11px', 'margin-left': '8px' }}>{link.url}</span>
                </a>
              )}</For>
              <Show when={links().length === 0}>
                <div style={{ padding: '20px 16px', color: '#555', 'font-size': '13px' }}>No quick links yet. Use /feather add link to add some.</div>
              </Show>
            </div>
          </Show>
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: '1', display: 'flex', 'flex-direction': 'column', 'min-width': '0', height: '100%' }}>
        {/* Header */}
        <div style={{ padding: '8px 16px 0 56px', 'padding-top': 'max(8px, env(safe-area-inset-top))', 'border-bottom': '1px solid #1e1e1e', display: 'flex', 'align-items': 'center', gap: '8px', 'min-height': '48px', 'flex-shrink': '0' }}>
          <Show when={headerSession()} fallback={<span style={{ color: '#666', 'font-size': '14px' }}>{currentId() ? 'Loading...' : 'Select a session'}</span>}>
            {(s) => <>
              <Show when={s().isActive}><span style={{ width: '8px', height: '8px', 'border-radius': '50%', background: '#4aba6a', 'flex-shrink': '0' }} /></Show>
              <Show when={renaming()} fallback={
                <div style={{ overflow: 'hidden', 'min-width': '0' }}>
                  <div style={{ 'font-size': '10px', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', display: 'flex', 'align-items': 'center', gap: '4px' }}>
                    <Show when={s().projectLabel || (s().projectId && projects().find(p => p.id === s().projectId)?.label)}>
                      {(label) => <span style={{ color: '#666' }}>{label()}</span>}
                    </Show>
                    <Show when={currentCwd()}>
                      {(cwd) => <>
                        <Show when={s().projectLabel || (s().projectId && projects().find(p => p.id === s().projectId)?.label)}>
                          <span style={{ color: '#333' }}>/</span>
                        </Show>
                        <span style={{ color: '#555' }} title={cwd()}>{cwd().replace(/^\/home\/[^/]+/, '~')}</span>
                      </>}
                    </Show>
                  </div>
                  <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', 'font-size': '14px', 'font-weight': '600', display: 'block' }}>{s().title}</span>
                </div>
              }>
                <input
                  value={renameText()}
                  onInput={(e) => setRenameText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') doRename(s().id, renameText()); if (e.key === 'Escape') setRenaming(false) }}
                  onBlur={() => doRename(s().id, renameText())}
                  ref={(el) => setTimeout(() => el.focus(), 0)}
                  style={{ background: '#1a1a2e', border: '1px solid #4aba6a', 'border-radius': '6px', padding: '2px 8px', color: '#e5e5e5', 'font-size': '14px', 'font-weight': '600', outline: 'none', flex: '1', 'min-width': '0' }}
                />
              </Show>
              <div style={{ flex: '1' }} />
              <div style={{ position: 'relative' }}>
                <button onClick={() => setMenuOpen(!menuOpen())} style={{ background: 'none', border: 'none', color: '#888', 'font-size': '18px', cursor: 'pointer', padding: '4px 6px', '-webkit-tap-highlight-color': 'transparent' }}>{'\u22EE'}</button>
                <Show when={menuOpen()}>
                  <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: '0', 'z-index': '99' }} />
                  <div style={{ position: 'absolute', right: '0', top: '100%', background: '#1a1a2e', border: '1px solid #333', 'border-radius': '8px', 'box-shadow': '0 4px 12px rgba(0,0,0,0.5)', 'z-index': '100', 'min-width': '140px', overflow: 'hidden' }}>
                    <Show when={!s().isActive}>
                      <button onClick={() => { handleResume(s().id); setMenuOpen(false) }}
                        style={{ display: 'block', width: '100%', padding: '10px 16px', background: 'none', border: 'none', 'border-bottom': '1px solid #222', color: '#4aba6a', 'font-size': '13px', 'text-align': 'left', cursor: 'pointer' }}>Resume</button>
                    </Show>
                    <Show when={s().isActive}>
                      <button onClick={() => { handleInterrupt(s().id); setMenuOpen(false) }}
                        style={{ display: 'block', width: '100%', padding: '10px 16px', background: 'none', border: 'none', 'border-bottom': '1px solid #222', color: '#d45555', 'font-size': '13px', 'text-align': 'left', cursor: 'pointer' }}>Stop</button>
                    </Show>
                    <button onClick={() => { setRenameText(s().title); setRenaming(true); setMenuOpen(false) }}
                      style={{ display: 'block', width: '100%', padding: '10px 16px', background: 'none', border: 'none', 'border-bottom': '1px solid #222', color: '#e5e5e5', 'font-size': '13px', 'text-align': 'left', cursor: 'pointer' }}>Rename</button>
                    <button onClick={() => handleFork(s().id)}
                      style={{ display: 'block', width: '100%', padding: '10px 16px', background: 'none', border: 'none', 'border-bottom': '1px solid #222', color: '#e5e5e5', 'font-size': '13px', 'text-align': 'left', cursor: 'pointer' }}>Fork</button>
                    <a href={exportUrl(s().id)} download style={{ display: 'block', width: '100%', padding: '10px 16px', background: 'none', border: 'none', 'border-bottom': '1px solid #222', color: '#e5e5e5', 'font-size': '13px', 'text-align': 'left', cursor: 'pointer', 'text-decoration': 'none' }} onClick={() => setMenuOpen(false)}>Export MD</a>
                    <button onClick={() => handleDelete(s().id)}
                      style={{ display: 'block', width: '100%', padding: '10px 16px', background: 'none', border: 'none', color: '#d45555', 'font-size': '13px', 'text-align': 'left', cursor: 'pointer' }}>Delete</button>
                  </div>
                </Show>
              </div>
            </>}
          </Show>
        </div>

        {/* Tabs */}
        <Show when={currentId()}>
          <div style={{ display: 'flex', 'align-items': 'center', 'border-bottom': '1px solid #1e1e1e', 'padding-left': '16px', 'flex-shrink': '0' }}>
            <button onClick={() => setTab('chat')} style={tabStyle('chat')}>Chat</button>
            <button onClick={() => { setTab('files'); if (!browseDir()) openFileBrowser() }} style={tabStyle('files')}>Files{touchedFiles().length > 0 ? ` (${touchedFiles().length})` : ''}</button>
            <button onClick={() => setTab('terminal')} style={tabStyle('terminal')}>Terminal</button>
            <span style={{ 'margin-left': 'auto', 'padding-right': '12px', 'font-size': '10px', color: '#444' }}>{__BUILD_TIME__}</span>
          </div>
        </Show>

        {/* Reconnecting banner */}
        <Show when={sseStatus() === 'reconnecting' && currentId()}>
          <div style={{ padding: '4px 16px', background: '#c4993a', color: '#000', 'font-size': '12px', 'font-weight': '600', 'text-align': 'center', 'flex-shrink': '0' }}>Reconnecting...</div>
        </Show>

        {/* Content */}
        <div style={{ flex: '1', overflow: 'hidden' }}>
          <Show when={currentId()} fallback={
            <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'center', height: '100%', color: '#555' }}>
              <div style={{ 'text-align': 'center', padding: '20px' }}>
                <div style={{ 'font-size': '48px', 'margin-bottom': '16px', opacity: '0.2' }}>~</div>
                <div style={{ 'font-size': '15px', 'margin-bottom': '16px' }}>Type below to start chatting</div>
                <div style={{ 'font-size': '11px', color: '#333' }}>or open a session from the sidebar</div>
              </div>
            </div>
          }>
            <div style={{ display: tab() === 'chat' ? 'block' : 'none', height: '100%' }}>
              <MessageView messages={messages()} loading={loading()} hasMore={hasMore()} loadingMore={loadingMore()} onLoadEarlier={loadEarlier} onAnswer={(t) => { if (currentId()) sendInput(currentId()!, t) }} starred={new Set(starred()[currentId()!] || [])} onToggleStar={(uuid) => { if (currentId()) toggleStar(currentId()!, uuid) }} working={working()} scrollRefCb={(el) => { messageScrollRef = el }} />
            </div>
            <div style={{ display: tab() === 'files' ? 'flex' : 'none', 'flex-direction': 'column', height: '100%' }}>
              {/* File browser */}
              <Show when={browseDir()}>
                <div style={{ padding: '6px 16px', display: 'flex', 'align-items': 'center', gap: '8px', 'border-bottom': '1px solid #111', 'flex-shrink': '0' }}>
                  <Show when={browseParent()}>
                    <button onClick={() => openFileBrowser(browseParent()!)} style={{ background: 'none', border: 'none', color: '#73b8ff', cursor: 'pointer', 'font-size': '12px', padding: '0', '-webkit-tap-highlight-color': 'transparent' }}>
                      ..
                    </button>
                  </Show>
                  <span style={{ 'font-size': '11px', color: '#888', 'font-family': "'SF Mono', Menlo, monospace", overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', flex: '1' }}>{browseDir()}</span>
                </div>
              </Show>
              <div style={{ flex: '1', 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch' }}>
                <Show when={browseLoading()}>
                  <div style={{ padding: '12px 16px', color: '#555', 'font-size': '12px' }}>Loading...</div>
                </Show>
                <Show when={!browseLoading() && browseDir()}>
                  <For each={browseEntries()}>{(entry) => {
                    const base = location.pathname.replace(/\/+$/, '')
                    const fmtSize = (s: number | null) => {
                      if (s === null) return ''
                      if (s < 1024) return `${s}B`
                      if (s < 1024 * 1024) return `${(s / 1024).toFixed(0)}K`
                      return `${(s / (1024 * 1024)).toFixed(1)}M`
                    }
                    const fmtAge = (mtime: string) => {
                      if (!mtime) return ''
                      const ms = Date.now() - new Date(mtime).getTime()
                      const sec = Math.floor(ms / 1000)
                      if (sec < 60) return 'just now'
                      const min = Math.floor(sec / 60)
                      if (min < 60) return `${min}m ago`
                      const hr = Math.floor(min / 60)
                      if (hr < 24) return `${hr}h ago`
                      const days = Math.floor(hr / 24)
                      if (days < 30) return `${days}d ago`
                      const months = Math.floor(days / 30)
                      if (months < 12) return `${months}mo ago`
                      return `${Math.floor(months / 12)}y ago`
                    }
                    return (
                      <div style={{ padding: '4px 16px', 'font-size': '12px', display: 'flex', 'align-items': 'center', gap: '8px', 'border-bottom': '1px solid #0a0a0a' }}>
                        {entry.isDir ? (
                          <button onClick={() => openFileBrowser(entry.path)} style={{ background: 'none', border: 'none', color: '#c4993a', cursor: 'pointer', 'font-size': '12px', 'font-family': "'SF Mono', Menlo, monospace", padding: '0', 'text-align': 'left', flex: '1', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', '-webkit-tap-highlight-color': 'transparent' }}>
                            {entry.name}/
                          </button>
                        ) : (
                          <a href={`${base}/api/files/raw?path=${encodeURIComponent(entry.path)}`} target="_blank" rel="noopener" style={{ color: '#e5e5e5', 'text-decoration': 'none', 'font-family': "'SF Mono', Menlo, monospace", flex: '1', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>
                            {entry.name}
                          </a>
                        )}
                        <span style={{ color: '#555', 'font-size': '10px', 'flex-shrink': '0' }}>{fmtAge(entry.mtime)}</span>
                        <span style={{ color: '#444', 'font-size': '10px', 'flex-shrink': '0', 'min-width': '30px', 'text-align': 'right' }}>{fmtSize(entry.size)}</span>
                      </div>
                    )
                  }}</For>
                  <Show when={browseEntries().length === 0}>
                    <div style={{ padding: '12px 16px', color: '#444', 'font-size': '12px' }}>Empty directory</div>
                  </Show>
                </Show>
              </div>
            </div>
            <div style={{ display: tab() === 'terminal' ? 'block' : 'none', height: '100%' }}>
              <Terminal sessionId={tab() === 'terminal' ? currentId() : null} />
            </div>
          </Show>
        </div>

        {/* Drag overlay */}
        <Show when={dragging()}>
          <div style={{ position: 'absolute', inset: '0', background: 'rgba(74,186,106,0.1)', border: '2px dashed #4aba6a', 'border-radius': '12px', 'z-index': '100', display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'pointer-events': 'none' }}>
            <span style={{ color: '#4aba6a', 'font-size': '18px', 'font-weight': '600' }}>Drop files to attach</span>
          </div>
        </Show>

        {/* Question popup */}
        <Show when={question() && currentId() && tab() === 'chat'}>
          {(() => {
            const q = question()!
            const handleAnswer = async (type: string, index?: number, text?: string) => {
              const id = currentId()!
              try { await answerQuestion(id, { type, index, text }) } catch {}
              setQuestion(null)
            }
            return (
              <div style={{ padding: '10px 16px', 'border-top': '1px solid #c4993a', background: '#1a1a2e', 'flex-shrink': '0' }}>
                <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center', 'margin-bottom': '6px' }}>
                  <span style={{ color: '#c4993a', 'font-size': '11px', 'font-weight': '600' }}>QUESTION</span>
                  <button onClick={() => setQuestion(null)} style={{ background: 'none', border: 'none', color: '#666', cursor: 'pointer', 'font-size': '14px', padding: '0 4px' }}>&times;</button>
                </div>
                <div style={{ color: '#e5e5e5', 'font-size': '13px', 'margin-bottom': '8px', 'white-space': 'pre-wrap', 'line-height': '1.4' }}>{q.question}</div>
                <Show when={q.type === 'selector' && q.options}>
                  <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                    {q.options!.map((opt, i) => (
                      <button onClick={() => handleAnswer('selector', i)}
                        style={{ background: i === 0 ? '#2a2a4e' : '#1e1e3a', border: '1px solid ' + (i === 0 ? '#c4993a' : '#333'), color: '#e5e5e5', padding: '6px 12px', 'border-radius': '6px', 'font-size': '12px', cursor: 'pointer', 'text-align': 'left' }}>
                        {opt}
                      </button>
                    ))}
                  </div>
                </Show>
                <Show when={q.type === 'numbered' && q.options}>
                  <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                    {q.options!.map((opt, i) => (
                      <button onClick={() => handleAnswer('numbered', i)}
                        style={{ background: '#1e1e3a', border: '1px solid #333', color: '#e5e5e5', padding: '6px 12px', 'border-radius': '6px', 'font-size': '12px', cursor: 'pointer', 'text-align': 'left' }}>
                        {i + 1}. {opt}
                      </button>
                    ))}
                  </div>
                </Show>
                <Show when={q.type === 'yesno'}>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button onClick={() => handleAnswer('yesno', undefined, 'y')}
                      style={{ background: '#2a4a2e', border: '1px solid #4aba6a', color: '#e5e5e5', padding: '6px 16px', 'border-radius': '6px', 'font-size': '12px', cursor: 'pointer' }}>Yes</button>
                    <button onClick={() => handleAnswer('yesno', undefined, 'n')}
                      style={{ background: '#4a2a2e', border: '1px solid #a44', color: '#e5e5e5', padding: '6px 16px', 'border-radius': '6px', 'font-size': '12px', cursor: 'pointer' }}>No</button>
                  </div>
                </Show>
                <Show when={q.type === 'text'}>
                  {(() => {
                    let inputRef: HTMLInputElement | undefined
                    return (
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <input ref={inputRef} type="text" placeholder="Type your answer..."
                          onKeyDown={(e) => { if (e.key === 'Enter' && inputRef?.value) handleAnswer('text', undefined, inputRef.value) }}
                          style={{ flex: '1', background: '#111', border: '1px solid #333', color: '#e5e5e5', padding: '6px 10px', 'border-radius': '6px', 'font-size': '12px', outline: 'none' }} />
                        <button onClick={() => { if (inputRef?.value) handleAnswer('text', undefined, inputRef.value) }}
                          style={{ background: '#333', border: '1px solid #555', color: '#e5e5e5', padding: '6px 12px', 'border-radius': '6px', 'font-size': '12px', cursor: 'pointer' }}>Send</button>
                      </div>
                    )
                  })()}
                </Show>
              </div>
            )
          })()}
        </Show>

        {/* Status bar */}
        <Show when={currentId() && tab() === 'chat'}>
          <div style={{ padding: '2px 16px', 'border-top': '1px solid #1e1e1e', background: '#0a0e14', display: 'flex', 'align-items': 'center', gap: '8px', 'flex-shrink': '0', 'overflow-x': 'auto', 'white-space': 'nowrap' }}>
            {(() => {
              const s = cur()
              const inactive = s && !s.isActive && !working()
              const dotColor = working() ? '#f5a742' : inactive ? '#666' : '#4aba6a'
              const act = activity()?.replace(/^[^a-zA-Z]+/, '')
              const label = working() ? (act || 'Working...') : inactive ? 'Inactive' : 'Ready'
              const labelColor = working() ? '#f5a742' : inactive ? '#666' : '#555'
              return <>
                <span style={{ width: '6px', height: '6px', 'border-radius': '50%', background: dotColor, transition: 'background 0.3s', 'flex-shrink': '0', cursor: working() ? 'pointer' : 'default' }} onClick={() => { if (working() && currentId()) handleInterrupt(currentId()!) }} />
                <span onClick={() => { if (working() && currentId()) handleInterrupt(currentId()!) }} style={{ 'font-size': '10px', color: labelColor, 'font-weight': '500', cursor: working() ? 'pointer' : 'default', '-webkit-tap-highlight-color': 'transparent', 'white-space': 'nowrap', overflow: 'hidden', 'text-overflow': 'ellipsis', 'max-width': '300px' }}>{label}</span>
              </>
            })()}
            {(() => {
              const stats = sessionStats()
              const fmtTokens = (n: number) => n >= 1000 ? (n / 1000).toFixed(0) + 'k' : String(n)
              return <>
                <Show when={stats.cwd}>
                  <span style={{ 'font-size': '10px', color: '#444' }}>{stats.cwd!.replace(/^\/home\/[^/]+/, '~')}</span>
                </Show>
                <Show when={stats.model}>
                  <span style={{ 'font-size': '10px', color: '#444' }}>{stats.model!.replace('claude-', '').replace(/-\d{8}$/, '')}</span>
                </Show>
                <Show when={stats.totalIn > 0 || stats.totalOut > 0}>
                  <span style={{ 'font-size': '10px', color: '#444' }}>{fmtTokens(stats.totalIn)}in / {fmtTokens(stats.totalOut)}out</span>
                </Show>
              </>
            })()}
            <Show when={updateAvailable()}>
              <button onClick={() => setShowChangelog(!showChangelog())}
                style={{ background: showChangelog() ? '#555' : '#4aba6a', color: showChangelog() ? '#ccc' : '#000', border: 'none', 'border-radius': '4px', padding: '1px 8px', 'font-size': '10px', 'font-weight': '600', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent', transition: 'background 0.2s' }}>
                Update Available
              </button>
            </Show>
          </div>
        </Show>
        {/* Changelog + Perform Update panel */}
        <Show when={showChangelog()}>
          <div style={{ padding: '8px 16px', 'border-top': '1px solid #1e1e1e', background: '#0d1117', 'flex-shrink': '0', 'max-height': '200px', 'overflow-y': 'auto' }}>
            <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center', 'margin-bottom': '6px' }}>
              <span style={{ 'font-size': '11px', 'font-weight': '600', color: '#4aba6a' }}>What's New</span>
              <button onClick={async () => {
                try {
                  const r = await fetch(`${location.pathname.replace(/\/+$/, '')}/api/update`, { method: 'POST' })
                  if (r.ok) location.reload()
                } catch {}
              }} style={{ background: '#4aba6a', color: '#000', border: 'none', 'border-radius': '6px', padding: '4px 12px', 'font-size': '11px', 'font-weight': '600', cursor: 'pointer' }}>Perform Update</button>
            </div>
            <Show when={updateChanges()}>
              <pre style={{ 'font-size': '11px', color: '#888', 'white-space': 'pre-wrap', 'word-break': 'break-word', margin: '0', 'font-family': 'inherit' }}>{updateChanges()}</pre>
            </Show>
            <Show when={!updateChanges()}>
              <span style={{ 'font-size': '11px', color: '#666' }}>New build ready. Click Perform Update to apply.</span>
            </Show>
          </div>
        </Show>

        {/* Input (chat tab only) */}
        <Show when={tab() === 'chat' || !currentId()}>
          <input ref={fileInputRef} type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) { addFiles(e.target.files); e.target.value = '' } }} />
          {/* File previews */}
          <Show when={files().length > 0}>
            <div style={{ padding: '6px 12px 0', 'border-top': '1px solid #1e1e1e', background: '#0a0e14', display: 'flex', gap: '8px', 'flex-wrap': 'wrap' }}>
              <For each={files()}>{(f, i) => (
                <div style={{ position: 'relative', background: '#1a1a2e', 'border-radius': '8px', padding: '4px', border: '1px solid #333' }}>
                  {f.isImage
                    ? <img src={f.dataUrl} style={{ height: '56px', 'max-width': '100px', 'border-radius': '6px', 'object-fit': 'cover', display: 'block' }} />
                    : <div style={{ padding: '4px 8px', 'font-size': '11px', color: '#999', 'max-width': '100px', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{f.name}</div>
                  }
                  <button onClick={() => removeFile(i())} style={{ position: 'absolute', top: '-6px', right: '-6px', width: '22px', height: '22px', 'border-radius': '50%', background: '#d45555', color: '#fff', border: 'none', 'font-size': '12px', cursor: 'pointer', display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'line-height': '1' }}>&times;</button>
                </div>
              )}</For>
            </div>
          </Show>
          <div style={{ padding: '8px 12px', 'padding-bottom': 'max(8px, env(safe-area-inset-bottom))', 'border-top': files().length ? 'none' : '1px solid #1e1e1e', background: '#0a0e14', display: 'flex', gap: '6px', 'align-items': 'flex-end', 'flex-shrink': '0', position: 'relative' }}>
            {/* Toolbar icons left of textarea */}
            <div style={{ display: 'flex', 'align-items': 'center', gap: '2px', 'flex-shrink': '0', height: '42px' }}>
              <button onClick={() => fileInputRef?.click()} style={{ background: 'none', border: 'none', color: '#666', cursor: 'pointer', padding: '6px', '-webkit-tap-highlight-color': 'transparent', display: 'flex', 'align-items': 'center', 'justify-content': 'center', width: '32px', height: '32px' }} title="Attach file">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="10" y1="4" x2="10" y2="16" /><line x1="4" y1="10" x2="16" y2="10" /></svg>
              </button>
              <Show when={currentId() && (starred()[currentId()!]?.length || 0) > 0}>
                <button onClick={jumpToNextStar} style={{ background: 'none', border: 'none', color: '#c4993a', cursor: 'pointer', padding: '6px', '-webkit-tap-highlight-color': 'transparent', display: 'flex', 'align-items': 'center', 'justify-content': 'center', gap: '2px', height: '32px' }} title="Jump to starred">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="#c4993a"><path d="M8 1l2.2 4.5 5 .7-3.6 3.5.9 5L8 12.4 3.5 14.7l.9-5L.8 6.2l5-.7z" /></svg>
                  <span style={{ 'font-size': '11px', 'font-weight': '600', color: '#c4993a' }}>{starred()[currentId()!]?.length}</span>
                </button>
              </Show>
              <button onClick={toggleVoice} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '6px', '-webkit-tap-highlight-color': 'transparent', display: 'flex', 'align-items': 'center', 'justify-content': 'center', width: '32px', height: '32px', transition: 'color 0.15s' }} title="Voice input">
                <svg width="14" height="18" viewBox="0 0 14 18" fill="none" stroke={listening() ? '#d45555' : '#666'} stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="1" width="6" height="9" rx="3" fill={listening() ? 'rgba(212,85,85,0.2)' : 'none'} /><path d="M1 7.5a6 6 0 0 0 12 0" /><line x1="7" y1="13.5" x2="7" y2="16" /><line x1="4.5" y1="16" x2="9.5" y2="16" /></svg>
              </button>
            </div>
            {/* Textarea */}
            <div style={{ flex: '1', position: 'relative', 'min-width': '0', display: 'flex', 'flex-direction': 'column', 'justify-content': 'flex-end' }}>
              <textarea ref={textareaRef} value={text()}
                onInput={(e) => { setText(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px' }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
                  if (e.key === 'ArrowUp' && textareaRef?.selectionStart === 0) {
                    const h = getHistory(); if (h.length === 0) return
                    const idx = historyIdx() === -1 ? h.length - 1 : Math.max(0, historyIdx() - 1)
                    setHistoryIdx(idx); setText(h[idx]); e.preventDefault()
                  }
                  if (e.key === 'ArrowDown' && historyIdx() >= 0) {
                    const h = getHistory(); const idx = historyIdx() + 1
                    if (idx >= h.length) { setHistoryIdx(-1); setText(loadDraft(currentId()!) || '') }
                    else { setHistoryIdx(idx); setText(h[idx]) }
                    e.preventDefault()
                  }
                }}
                onPaste={(e) => { const items = e.clipboardData?.items; if (!items) return; const imgs = [...items].filter(i => i.type.startsWith('image/')); if (imgs.length) { e.preventDefault(); addFiles(imgs.map(i => new File([i.getAsFile()!], 'pasted-image.png', { type: i.type }))) } if (isMobile) { const ta = e.currentTarget; setTimeout(() => { ta.blur(); ta.focus() }, 50) } }}
                onFocus={() => { if (messageScrollRef) setTimeout(() => messageScrollRef!.scrollTo({ top: messageScrollRef!.scrollHeight }), 300) }}
                enterkeyhint="send"
                placeholder="Send a message..." rows={1}
                style={{ width: '100%', background: '#1a1a2e', border: '1px solid #333', 'border-radius': '12px', padding: '10px 14px', color: '#e5e5e5', 'font-size': '16px', 'font-family': 'inherit', resize: 'none', outline: 'none', 'line-height': '1.4', 'max-height': '120px', '-webkit-appearance': 'none', 'box-sizing': 'border-box', overflow: 'auto', 'scrollbar-width': 'none' }} />
              <Show when={text().length > 0}>
                <div style={{ position: 'absolute', right: '8px', bottom: '2px', 'font-size': '10px', color: text().length >= 500 ? '#fab283' : '#555', 'line-height': '1', 'pointer-events': 'none' }}>
                  {text().length >= 1000 ? (text().length / 1000).toFixed(1) + 'k' : text().length}
                </div>
              </Show>
            </div>
            {/* Send button (hidden on mobile, keyboard has its own) */}
            <Show when={!isMobile}>
              <div style={{ 'flex-shrink': '0', height: '42px', display: 'flex', 'align-items': 'center' }}>
                <button onClick={handleSend} disabled={uploading()} style={{ background: (text().trim() || files().length) ? '#4aba6a' : '#333', color: (text().trim() || files().length) ? '#000' : '#666', border: 'none', 'border-radius': '50%', padding: '0', width: '36px', height: '36px', cursor: (text().trim() || files().length) ? 'pointer' : 'default', '-webkit-tap-highlight-color': 'transparent', display: 'flex', 'align-items': 'center', 'justify-content': 'center' }}>{uploading() ? '...' : <svg width="14" height="16" viewBox="0 0 14 16" fill="currentColor"><polygon points="0,0 14,8 0,16" /></svg>}</button>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
    </Show>
    </Show>
    </>
  )
}
