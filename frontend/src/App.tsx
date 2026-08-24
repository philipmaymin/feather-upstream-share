declare const __BUILD_TIME__: string
declare const __BUILD_VERSION__: string
import { createSignal, createEffect, createMemo, onMount, onCleanup, Show, For } from 'solid-js'
import { marked } from 'marked'
import { MessageView } from './components/MessageView'
import { Terminal } from './components/Terminal'
import { SidecarThread } from './components/Sidecar'
import RoomsHome from './RoomsHome'
import type { SessionMeta, Message, QuestionData, SidecarGroup, RoomUpdate, OmpBridgeEvent, OmpAsyncJob, OmpMirrorState, OmpTodoSnapshot } from './api'
import { fetchSessions, fetchRooms, fetchRoomUpdates, fetchMessages, subscribeMessages, sendInput, sendSessionKeys, createSession, resumeSession, interruptSession, uploadFileWithId, transcribeAudio, deleteSession, renameSession, forkSession, fetchStarred, saveStarred, exportUrl, deletePath, checkAuth, login, logout, searchSessions, answerQuestion, fetchAgents, fetchSidecars, createSidecar } from './api'
import type { SearchResult } from './api'
import { MEDIA_ATTEMPTS, MAX_UPLOAD_BYTES, MAX_AUDIO_BYTES, retryMediaOperation, runMediaOperationOnce, isRetryableVoiceMemo } from './lib/mediaRetry.js'
import { putMediaRecord, patchMediaRecord, deleteMediaRecord, listMediaRecords, isTerminalMediaRecord, withMediaRecordClaim } from './lib/mediaOutbox.js'
import { listPendingMessages, putPendingMessage, patchPendingMessage, deletePendingMessage } from './lib/messageOutbox.js'
import { appUrl } from './lib/appPath.js'
import { deriveToolIntentState, isFinalAssistantMessage, toolIntentTransition } from './lib/toolIntentStatus.js'
import { deriveTodoSnapshot, todoSnapshotFromDetails, todoSnapshotFromMessage } from './lib/ompTodo.js'
import { createOmpMirrorState, reduceOmpMirrorState } from './lib/ompMirror.js'

interface QuickLink { label: string; url: string }
type AgentId = 'claude' | 'codex' | 'omp'

const isRoomPulseSession = (session: Pick<SessionMeta, 'title'>) => /^Keep working: #/.test(session.title || '')
const agentBadgeLabel = (agent?: AgentId) => agent === 'omp' ? 'OMP' : agent === 'codex' ? 'Codex' : 'Claude'
const agentBadgeColors = (agent?: AgentId) => agent === 'omp'
  ? { background: '#3a2a1e', color: '#e0a050' }
  : agent === 'codex'
    ? { background: '#2a1e3a', color: '#c084fc' }
    : { background: '#1e2a3a', color: '#73b8ff' }

type FileStatus = 'draft' | 'uploading' | 'uploaded' | 'failed'
type VoiceStatus = 'transcribing' | 'failed' | 'delivered'
interface PendingFile { id: string; name: string; blob: Blob; dataUrl: string; isImage: boolean; status: FileStatus; attempts: number; error?: string; serverPath?: string; sessionId: string; boxId: 'local' }
interface VoiceMemo { id: string; name: string; blob: Blob; status: VoiceStatus; attempts: number; error?: string; transcript?: string; intent: 'append' | 'send'; capturedText: string; sessionId: string; boxId: 'local' }
interface StoredMediaBase { id: string; boxId: string; sessionId: string; name: string; blob: Blob; attempts: number; error?: string }
interface StoredFileMedia extends StoredMediaBase { kind: 'file' | 'image'; status: FileStatus; serverPath?: string }
interface StoredVoiceMedia extends StoredMediaBase { kind: 'audio'; status: VoiceStatus; transcript?: string; intent?: 'append' | 'send'; capturedText?: string }
type StoredMedia = StoredFileMedia | StoredVoiceMedia
interface PendingMessage { id: string; sessionId: string; text: string; createdAt: number; attempts: number; error?: string }
interface AssistantStream { id: string; text: string; ended: boolean }
interface OmpNotice { kind: 'retry' | 'compaction' | 'credential'; text: string }
interface OmpApproval { toolCallId: string; toolName: string; approvalMode: string; reason?: string }
interface OmpRuntimeState {
  modelProvider?: string
  modelId?: string
  modelApi?: string
  thinkingLevel?: string
  serviceTiers?: Record<string, string | null>
  contextTokens?: number
  contextWindow?: number
  contextPercent?: number
}

function fileStatusLabel(file: PendingFile) {
  if (file.status === 'uploading') return `Uploading · ${Math.min(MEDIA_ATTEMPTS, file.attempts + 1)}/${MEDIA_ATTEMPTS}`
  if (file.status === 'uploaded') return 'Uploaded'
  return file.error || 'Upload failed'
}

function voiceStatusLabel(memo: VoiceMemo) {
  if (memo.status === 'transcribing') return `Transcribing · ${Math.min(MEDIA_ATTEMPTS, memo.attempts + 1)}/${MEDIA_ATTEMPTS}`
  return memo.error || 'Transcription failed'
}

function resizeImage(blob: Blob, maxDim = 1600): Promise<Blob> {
  return new Promise((resolve) => {
    const img = new Image()
    const url = URL.createObjectURL(blob)
    let settled = false
    const finish = (value: Blob) => {
      if (settled) return
      settled = true
      URL.revokeObjectURL(url)
      resolve(value)
    }
    img.onload = () => {
      const { width: w, height: h } = img
      if (w <= maxDim && h <= maxDim) { finish(blob); return }
      const scale = Math.min(maxDim / w, maxDim / h)
      const c = document.createElement('canvas')
      c.width = w * scale; c.height = h * scale
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
      c.toBlob(b => finish(b || blob), 'image/png')
    }
    // A corrupt or mislabeled image should remain attachable instead of
    // leaving addFiles() hung forever waiting for a load event that never fires.
    img.onerror = () => finish(blob)
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
  // The selected chat and the transcript rendered beneath it are separate
  // pieces of state. Never enable message-producing controls until a guarded
  // transcript load has committed for the selected chat.
  const [loadedSessionId, setLoadedSessionId] = createSignal<string | null>(null)
  const [chatLoadError, setChatLoadError] = createSignal('')
  const composerReady = () => currentId() !== null && loadedSessionId() === currentId()
  const [creating, setCreating] = createSignal(false)
  const [resumingId, setResumingId] = createSignal<string | null>(null)
  const [text, setText] = createSignal('')
  const [tab, setTab] = createSignal<'chat' | 'prompts' | 'todos' | 'agents' | 'updates' | 'files' | 'terminal'>('chat')
  const [updatesList, setUpdatesList] = createSignal<RoomUpdate[]>([])
  const [updatesLoading, setUpdatesLoading] = createSignal(false)
  const [updatesError, setUpdatesError] = createSignal<string | null>(null)
  const [updatesRoomName, setUpdatesRoomName] = createSignal<string | null>(null)
  const [filesMode, setFilesMode] = createSignal<'changed' | 'browse'>('browse')
  const TEXT_EXTS = new Set(['.txt', '.md', '.js', '.ts', '.tsx', '.jsx', '.json', '.html', '.css', '.py', '.rb', '.go', '.rs', '.sh', '.yml', '.yaml', '.toml', '.cfg', '.conf', '.ini', '.env', '.sql', '.csv', '.xml', '.log', '.jsonl', '.svelte', '.vue', '.astro', '.mjs', '.cjs'])
  const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'])
  function fileKind(p: string): 'text' | 'image' | 'pdf' | 'binary' {
    const i = p.lastIndexOf('.')
    const ext = i >= 0 ? p.slice(i).toLowerCase() : ''
    if (ext === '.pdf') return 'pdf'
    if (IMAGE_EXTS.has(ext)) return 'image'
    if (TEXT_EXTS.has(ext) || ext === '') return 'text'
    return 'binary'
  }
  const [viewingFile, setViewingFile] = createSignal<{ path: string; kind: 'text' | 'image' | 'pdf' | 'binary'; content: string; blobUrl?: string; size?: number; error?: string } | null>(null)
  function closeViewer() {
    const v = viewingFile()
    if (v?.blobUrl) URL.revokeObjectURL(v.blobUrl)
    setViewingFile(null)
  }
  async function openFile(filePath: string) {
    const kind = fileKind(filePath)
    setViewingFile({ path: filePath, kind, content: '' })
    if (kind === 'text') {
      try {
        const r = await fetch(appUrl(`/api/files/raw?path=${encodeURIComponent(filePath)}`))
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
        const sizeHeader = r.headers.get('content-length')
        setViewingFile({ path: filePath, kind, content: await r.text(), size: sizeHeader ? parseInt(sizeHeader, 10) : undefined })
      } catch (e: any) {
        setViewingFile({ path: filePath, kind, content: '', error: e.message || 'failed to load' })
      }
    } else if (kind === 'pdf') {
      try {
        const r = await fetch(appUrl(`/api/files/raw?path=${encodeURIComponent(filePath)}`))
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
        const buf = await r.arrayBuffer()
        const blobUrl = URL.createObjectURL(new Blob([buf], { type: 'application/pdf' }))
        setViewingFile({ path: filePath, kind, content: '', blobUrl })
      } catch (e: any) {
        setViewingFile({ path: filePath, kind, content: '', error: e.message || 'failed to load' })
      }
    }
  }
  const [files, setFiles] = createSignal<PendingFile[]>([])
  const [voiceMemos, setVoiceMemos] = createSignal<VoiceMemo[]>([])
  const [mediaNotice, setMediaNotice] = createSignal('')
  let mediaNoticeTimer: ReturnType<typeof setTimeout> | undefined
  function dismissMediaNotice() {
    if (mediaNoticeTimer) clearTimeout(mediaNoticeTimer)
    mediaNoticeTimer = undefined
    setMediaNotice('')
  }
  function showMediaNotice(message: string, autoDismissMs = 0) {
    if (mediaNoticeTimer) clearTimeout(mediaNoticeTimer)
    mediaNoticeTimer = undefined
    setMediaNotice(message)
    if (autoDismissMs > 0) {
      mediaNoticeTimer = setTimeout(() => {
        setMediaNotice(current => current === message ? '' : current)
        mediaNoticeTimer = undefined
      }, autoDismissMs)
    }
  }
  const [transcribing, setTranscribing] = createSignal(false)
  const uploadsInFlight = new Map<string, Promise<string>>()
  const voiceMemosInFlight = new Map<string, Promise<void>>()
  const pendingSendsInFlight = new Map<string, Promise<void>>()
  let pendingRetryTimer: ReturnType<typeof setTimeout> | undefined
  const [uploading, setUploading] = createSignal(false)
  const [working, setWorking] = createSignal(false)
  const [toolIntentStatus, setToolIntentStatus] = createSignal('')
  const [dragging, setDragging] = createSignal(false)
  const [toolIntentHistory, setToolIntentHistory] = createSignal<string[]>([])
  const [assistantStream, setAssistantStream] = createSignal<AssistantStream | null>(null)
  const [todoSnapshot, setTodoSnapshot] = createSignal<OmpTodoSnapshot | null>(null)
  const [ompMirror, setOmpMirror] = createSignal<OmpMirrorState>(createOmpMirrorState())
  const [ompNotice, setOmpNotice] = createSignal<OmpNotice | null>(null)
  const [ompApproval, setOmpApproval] = createSignal<OmpApproval | null>(null)
  const [ompJobs, setOmpJobs] = createSignal<OmpAsyncJob[]>([])
  const [ompRuntime, setOmpRuntime] = createSignal<OmpRuntimeState | null>(null)
  let assistantStreamStaleTimer: number | undefined
  function clearAssistantStream() {
    clearTimeout(assistantStreamStaleTimer)
    assistantStreamStaleTimer = undefined
    setAssistantStream(null)
  }
  function clearOmpLiveSurfaces() {
    setTodoSnapshot(null)
    setOmpMirror(createOmpMirrorState())
    setOmpNotice(null)
    setOmpApproval(null)
    setOmpJobs([])
    setOmpRuntime(null)
  }


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
  const [sidecars, setSidecars] = createSignal<SidecarGroup[]>([])
  const [openSidecarId, setOpenSidecarId] = createSignal<string | null>(null)
  const refreshSidecars = async () => {
    try { setSidecars((await fetchSidecars()).groups || []) } catch {}
  }
  onMount(() => {
    refreshSidecars()
    const timer = setInterval(refreshSidecars, 5000)
    onCleanup(() => clearInterval(timer))
  })
  const sidecarsForSession = (sessionId: string) =>
    sidecars().filter(group => group.status === 'active'
      && group.members.some(member => !member.spawned && member.sessionId.slice(0, 8) === sessionId.slice(0, 8)))
  async function spawnSidecarFor(sessionId: string) {
    const task = prompt('Task / opening message for the sidecar (optional):') ?? ''
    const agent = (prompt('Agent for the peer (omp / claude / codex):', 'omp') || 'omp').trim()
    const session = sessions().find(candidate => candidate.id === sessionId) || lastSession()
    try {
      const result = await createSidecar(sessionId, { task, agent, cwd: session?.cwd || undefined })
      await refreshSidecars()
      setOpenSidecarId(result.group.id)
    } catch (error: any) {
      alert('Failed to create sidecar: ' + (error?.message || error))
    }
  }
  const [links, setLinks] = createSignal<QuickLink[]>([])
  const [starred, setStarred] = createSignal<Record<string, string[]>>({})
  const [codexAvailable, setCodexAvailable] = createSignal(false)
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
  const [showHidden, setShowHidden] = createSignal(localStorage.getItem('feather-show-hidden') === '1')

  async function openFileBrowser(dir?: string) {
    const target = dir || browseDir() || sessionStats().cwd || '/home/user'
    setBrowseLoading(true)
    try {
      const hidden = showHidden() ? '&showHidden=1' : ''
      const resp = await fetch(appUrl(`/api/files/list?dir=${encodeURIComponent(target)}${hidden}`))
      const data = await resp.json()
      if (resp.ok) {
        setBrowseDir(data.dir)
        setBrowseParent(data.parent !== data.dir ? data.parent : null)
        setBrowseEntries(data.entries)
      }
    } catch {}
    setBrowseLoading(false)
  }

  function toggleHidden() {
    const next = !showHidden()
    setShowHidden(next)
    localStorage.setItem('feather-show-hidden', next ? '1' : '0')
    if (browseDir()) openFileBrowser(browseDir()!)
  }

  async function deleteBrowseEntry(full: string, name: string, isDir: boolean) {
    const what = isDir ? 'directory (and all its contents)' : 'file'
    if (!confirm(`Delete ${what}?\n\n${full}\n\nThis cannot be undone.`)) return
    try {
      await deletePath(full)
      if (browseDir()) openFileBrowser(browseDir()!)
    } catch (e: any) {
      alert(`Delete failed: ${e.message || e}`)
    }
  }

  const lastSeenUpdatedAt = new Map<string, string>() // session ID -> last known updatedAt
  const [updateAvailable, setUpdateAvailable] = createSignal(false)
  const [updateChanges, setUpdateChanges] = createSignal('')
  const [showChangelog, setShowChangelog] = createSignal(false)
  const currentJsFile = document.querySelector<HTMLScriptElement>('script[src*="index-"]')?.src.match(/index-[^.]+\.js/)?.[0] || null

  let cleanupSSE: (() => void) | null = null
  let selectionGeneration = 0
  let messagesAbortController: AbortController | null = null
  let mediaRecorder: MediaRecorder | null = null
  let mediaStream: MediaStream | null = null
  let audioChunks: Blob[] = []
  let voiceSendAfterStop = false
  let textareaRef: HTMLTextAreaElement | undefined
  let fileInputRef: HTMLInputElement | undefined
  let dragCounter = 0
  let mediaRestoreGeneration = 0
  let updatesGeneration = 0

  function cancelSelectionWork() {
    selectionGeneration++
    updatesGeneration++
    messagesAbortController?.abort()
    messagesAbortController = null
    cleanupSSE?.()
    cleanupSSE = null
    clearTimeout(workingTimer)
    clearTimeout(assistantDoneTimer)
  }

  function isCurrentSelection(id: string, generation: number) {
    return generation === selectionGeneration && currentId() === id
  }

  async function findSessionMeta(id: string, recent: SessionMeta[] = sessions()) {
    const listed = recent.find(session => session.id === id)
    if (listed) return listed
    try {
      return (await fetchSessions(null, id, 5)).find(session => session.id === id)
    } catch {
      return undefined
    }
  }

  // Update sessions and detect unread changes
  function updateSessions(newSessions: SessionMeta[]) {
    const visibleSessions = newSessions.filter(session => !isRoomPulseSession(session))
    const active = currentId()
    const unread = new Set(unreadSessions())
    for (const s of visibleSessions) {
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
    setSessions(visibleSessions)
    if (active && (working() || toolIntentStatus())) {
      const listed = visibleSessions.find(session => session.id === active)
      if (listed && !listed.isActive) {
        setWorking(false)
        setToolIntentStatus('')
        setToolIntentHistory([])
        clearAssistantStream()
      } else if (!listed) {
        findSessionMeta(active, visibleSessions).then(session => {
          if (currentId() === active && session && !session.isActive) {
            setWorking(false)
            setToolIntentStatus('')
            setToolIntentHistory([])
            clearAssistantStream()
          }
        })
      }
    }
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
    if (uploading()) return
    const sessionId = currentId()
    const boxId = 'local' as const
    if (!sessionId || loadedSessionId() !== sessionId) return
    const added: PendingFile[] = []
    for (const f of fileList) {
      if (f.size > MAX_UPLOAD_BYTES) {
        setMediaNotice(`${f.name} is larger than the 50 MB upload limit.`)
        continue
      }
      const isImage = f.type.startsWith('image/')
      const blob = isImage ? await resizeImage(f) : f
      const dataUrl = URL.createObjectURL(blob)
      const id = crypto.randomUUID()
      const record = { id, boxId, sessionId, kind: isImage ? 'image' : 'file', name: f.name, mimeType: blob.type, blob, status: 'draft', attempts: 0, createdAt: Date.now() }
      try { await putMediaRecord(record) }
      catch (e: any) { setMediaNotice(`Recovery storage unavailable: ${e?.message || e}. Keep this tab open or remove/download the file.`) }
      if (currentId() === sessionId) added.push({ id, name: f.name, blob, dataUrl, isImage, status: 'draft', attempts: 0, sessionId, boxId })
      else URL.revokeObjectURL(dataUrl)
    }
    if (currentId() === sessionId) setFiles(prev => [...prev, ...added])
  }

  async function removeFile(idx: number) {
    if (uploading()) return
    const file = files()[idx]
    if (!file) return
    URL.revokeObjectURL(file.dataUrl)
    await deleteMediaRecord(file.id).catch(() => {})
    setFiles(prev => prev.filter((_, i) => i !== idx))
  }

  function updateFile(id: string, patch: Partial<PendingFile>) {
    setFiles(prev => prev.map(file => file.id === id ? { ...file, ...patch } : file))
  }

  function updateVoice(id: string, patch: Partial<VoiceMemo>) {
    setVoiceMemos(prev => prev.map(memo => memo.id === id ? { ...memo, ...patch } : memo))
  }

  function clearPendingMedia() {
    for (const file of files()) URL.revokeObjectURL(file.dataUrl)
    setFiles([])
    setVoiceMemos([])
  }

  async function restoreMedia(sessionId: string) {
    const generation = ++mediaRestoreGeneration
    clearPendingMedia()
    try {
      const records = await listMediaRecords('local', sessionId) as StoredMedia[]
      if (generation !== mediaRestoreGeneration || currentId() !== sessionId) return
      const recoverable = records.filter(record => !isTerminalMediaRecord(record))
      const attachments = recoverable.filter(r => r.kind === 'file' || r.kind === 'image').map(r => ({
        id: r.id, name: r.name, blob: r.blob, dataUrl: URL.createObjectURL(r.blob), isImage: r.kind === 'image',
        status: r.status === 'uploading' ? 'failed' : r.status, attempts: r.attempts || 0,
        error: r.status === 'uploading' ? 'Interrupted before upload completed' : r.error,
        serverPath: r.serverPath, sessionId, boxId: 'local' as const,
      })) as PendingFile[]
      const memos = recoverable.filter(r => r.kind === 'audio').map(r => ({
        id: r.id, name: r.name, blob: r.blob, status: r.status === 'transcribing' ? 'failed' : r.status,
        attempts: r.attempts || 0, error: r.status === 'transcribing' ? 'Interrupted before transcription completed' : r.error,
        transcript: r.transcript, intent: r.intent || 'append', capturedText: r.capturedText || '', sessionId, boxId: 'local',
      })) as VoiceMemo[]
      setFiles(attachments)
      setVoiceMemos(memos)
      if (recoverable.length) setMediaNotice(`Recovered ${recoverable.length} unsent media item${recoverable.length === 1 ? '' : 's'}.`)
      queueMicrotask(() => retryRecoverableMedia())
    } catch (e: any) {
      setMediaNotice(`Media recovery unavailable: ${e?.message || e}`)
    }
  }

  // Scroll position memory (in-memory, per session)
  const scrollPositions = new Map<string, number>()
  let messageScrollRef: HTMLDivElement | undefined
  let workingTimer: number | undefined
  let assistantDoneTimer: number | undefined

  function startWorkingTimeout() {
    clearTimeout(workingTimer)
    workingTimer = window.setTimeout(() => {
      if (working()) {
        setWorking(false)
        setToolIntentStatus('')
        setToolIntentHistory([])
        clearAssistantStream()
      }
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
    updateSessions(await fetchSessions())
    refreshPendingMessages()
    queueMicrotask(() => retryPendingMessages())
    fetchAgents().then(r => {
      setCodexAvailable(r.agents.some(a => a.id === 'codex' && a.available))
    }).catch(() => {})
    fetch(appUrl('/api/quick-links')).then(r => r.ok ? r.json() : []).then(setLinks).catch(() => {})
    fetchStarred().then(setStarred).catch(() => {})
    const hash = location.hash.slice(1)
    if (hash) select(hash)
  }

  onMount(async () => {
    // Expose the immutable build embedded in this resident bundle. Besides
    // making stale-client checks testable, this avoids learning a misleading
    // "baseline" from a server that may already have advanced.
    document.documentElement.dataset.buildVersion = __BUILD_VERSION__
    // Set --vh for iOS keyboard handling
    function setVh() {
      const vh = (window.visualViewport?.height || window.innerHeight) * 0.01
      document.documentElement.style.setProperty('--vh', `${vh}px`)
    }
    setVh()
    window.visualViewport?.addEventListener('resize', setVh)
    window.addEventListener('resize', setVh)
    window.addEventListener('online', retryRecoverableWork)

    // The reverse proxy has already authenticated anyone who can load the app.
    // Warm Rooms alongside /api/me so the first render costs one round trip,
    // not two; fetchRooms coalesces this with RoomsHome's own refresh.
    fetchRooms().catch(() => {})
    const user = await checkAuth()
    setAuthChecked(true)
    if (user) {
      setAuthUser(user)
      await initApp()
    }

    // Check for updates every 30 seconds
    async function checkForUpdate() {
      try {
        const r = await fetch(appUrl('/api/version'))
        if (!r.ok) return
        const { stagingJs, activeJs, changes } = await r.json()
        // A resident mobile/PWA bundle can survive a deployment indefinitely.
        // Reload once when the *active* immutable asset advances. Do not react
        // to stagingJs here: candidates are built and tested before promotion.
        if (activeJs && currentJsFile && activeJs !== currentJsFile) {
          const reloadKey = `feather:asset-reload:${activeJs}`
          try {
            if (sessionStorage.getItem(reloadKey) !== '1') {
              sessionStorage.setItem(reloadKey, '1')
              location.reload()
              return
            }
            console.warn(`Feather bundle ${currentJsFile} still differs from active ${activeJs}; suppressing reload loop`)
          } catch {
            // If storage is unavailable, preserve a usable client and leave the
            // explicit Update Available action as the recovery path.
          }
        } else if (activeJs) {
          try { sessionStorage.removeItem(`feather:asset-reload:${activeJs}`) } catch {}
        }
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
    // Session activity changes even when no transcript is open. Refresh the
    // Rooms cards and sidebar while visible so running dots and ordering stay
    // current without wasting work in a background tab.
    const sessionsInterval = setInterval(() => {
      if (document.hidden || !authUser()) return
      fetchSessions().then(updateSessions).catch(() => {})
    }, 15000)
    onCleanup(() => {
      clearInterval(versionInterval)
      clearInterval(sessionsInterval)
      window.removeEventListener('online', retryRecoverableWork)
      window.visualViewport?.removeEventListener('resize', setVh)
      window.removeEventListener('resize', setVh)
    })
  })
  onCleanup(() => { if (mediaNoticeTimer) clearTimeout(mediaNoticeTimer); if (pendingRetryTimer) clearTimeout(pendingRetryTimer); clearAssistantStream(); clearPendingMedia(); cancelSelectionWork(); document.removeEventListener('keydown', onGlobalKeyDown) })

  // Autoresize textarea on programmatic text changes (draft restore on session
  // select, voice dictation, history navigation). The onInput handler covers
  // typing/pasting; this effect covers the rest. Without it the textarea stays
  // pinned at rows=1 and long restored text scrolls behind a 1-line viewport.
  createEffect(() => {
    text() // subscribe
    if (!textareaRef) return
    queueMicrotask(() => {
      if (!textareaRef) return
      textareaRef.style.height = 'auto'
      textareaRef.style.height = Math.min(textareaRef.scrollHeight, 120) + 'px'
    })
  })

  function handleOmpEvent(event: OmpBridgeEvent) {
    setOmpMirror(current => reduceOmpMirrorState(current, event))

    if (event.type === 'subagent_lifecycle' || event.type === 'subagent_progress') return
    if (event.type === 'todo') {
      if (!event.subagentId && event.phases) setTodoSnapshot(todoSnapshotFromDetails({ phases: event.phases }))
      return
    }
    if (event.type === 'work_snapshot' || event.type === 'tool_execution_start' || event.type === 'tool_execution_update' || event.type === 'tool_execution_end') {
      if (!event.subagentId && event.type !== 'tool_execution_end') setWorking(true)
      return
    }
    if (event.type === 'tool_approval_requested' && event.toolCallId && event.toolName && event.approvalMode) {
      setOmpApproval({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        approvalMode: event.approvalMode,
        reason: event.reason,
      })
      return
    }
    if (event.type === 'tool_approval_resolved') {
      setOmpApproval(current => current?.toolCallId === event.toolCallId ? null : current)
      return
    }
    if (event.type === 'async_jobs' && event.running && event.recent) {
      const seen = new Set(event.running.map(job => job.id))
      setOmpJobs([...event.running, ...event.recent.filter(job => !seen.has(job.id))].slice(0, 20))
      return
    }
    if (event.type === 'session_state') {
      setOmpRuntime({
        modelProvider: event.modelProvider,
        modelId: event.modelId,
        modelApi: event.modelApi,
        thinkingLevel: event.thinkingLevel,
        serviceTiers: event.serviceTiers,
        contextTokens: event.contextTokens,
        contextWindow: event.contextWindow,
        contextPercent: event.contextPercent,
      })
      return
    }
    if (event.subagentId) return
    if (event.type === 'assistant_snapshot' && event.messageId && typeof event.text === 'string') {
      clearTimeout(assistantStreamStaleTimer)
      assistantStreamStaleTimer = undefined
      setAssistantStream({ id: event.messageId, text: event.text, ended: false })
      setWorking(true)
      return
    }
    if (event.type === 'assistant_end' && event.messageId) {
      setAssistantStream(current => current?.id === event.messageId ? { ...current, ended: true } : current)
      setWorking(false)
      clearTimeout(assistantStreamStaleTimer)
      assistantStreamStaleTimer = setTimeout(() => {
        setAssistantStream(current => current?.id === event.messageId && current.ended ? null : current)
        assistantStreamStaleTimer = undefined
      }, 15_000)
      return
    }
    if (event.type === 'assistant_cancel' && event.messageId) {
      setAssistantStream(current => {
        if (current?.id !== event.messageId) return current
        clearTimeout(assistantStreamStaleTimer)
        assistantStreamStaleTimer = undefined
        return null
      })
      if (!event.willContinue) setWorking(false)
      return
    }
    if (event.type === 'agent_start') {
      setWorking(true)
      return
    }
    if (event.type === 'agent_end') {
      if (!event.willContinue) setWorking(false)
      return
    }
    if (event.type === 'auto_retry_start') {
      setOmpNotice({ kind: 'retry', text: `Retrying request · ${event.attempt || 1}/${event.maxAttempts || '?'}` })
      return
    }
    if (event.type === 'auto_retry_end') {
      setOmpNotice(event.success ? null : { kind: 'retry', text: event.finalError || 'Request retry failed' })
      return
    }
    if (event.type === 'auto_compaction_start') {
      setOmpNotice({ kind: 'compaction', text: 'Compacting context' })
      return
    }
    if (event.type === 'auto_compaction_end') {
      setOmpNotice(event.aborted ? { kind: 'compaction', text: event.errorMessage || 'Context compaction stopped' } : null)
      return
    }
    if (event.type === 'credential_disabled') {
      setOmpNotice({ kind: 'credential', text: `${event.provider || 'Provider'} credential disabled` })
    }
  }

  async function select(id: string) {
    const prev = currentId()
    if (prev) {
      saveDraft(prev, text())
      // Save scroll position of current session
      if (messageScrollRef) scrollPositions.set(prev, messageScrollRef.scrollTop)
    }
    cancelSelectionWork()
    const generation = selectionGeneration
    const abortController = new AbortController()
    messagesAbortController = abortController
    dismissMediaNotice()
    setCurrentId(id)
    setLoadedSessionId(null)
    setChatLoadError('')
    location.hash = id
    setSidebar(false)
    setLoading(true)
    setLoadingMore(false)
    setMessages([])
    setHasMore(false)
    setToolIntentStatus('')
    setToolIntentHistory([])
    clearAssistantStream()
    clearOmpLiveSurfaces()
    setActivity(null)
    setQuestion(null)
    setText(loadDraft(id))
    restoreMedia(id)
    setHistoryIdx(-1)
    // Clear unread status and update lastSeen timestamp
    const unread = new Set(unreadSessions())
    unread.delete(id)
    setUnreadSessions(unread)
    let s = sessions().find(s => s.id === id)
    setWorking(!!s?.isActive)
    const sessionMetaPromise = s ? Promise.resolve(s) : findSessionMeta(id)
    if (s) { lastSeenUpdatedAt.set(id, s.updatedAt); setLastSession(s) }
    else {
      setLastSession({ id, title: 'New session', updatedAt: new Date().toISOString(), isActive: true })
      // The selected chat may be older than the bounded sidebar snapshot. Ask
      // for its exact ID instead of scanning every transcript.
      sessionMetaPromise.then(found => {
        if (!isCurrentSelection(id, generation)) return
        if (found) setLastSession(found)
      })
    }
    let result: Awaited<ReturnType<typeof fetchMessages>>
    try {
      result = await fetchMessages(id, 0, abortController.signal)
    } catch (error: any) {
      if (!isCurrentSelection(id, generation)) return
      messagesAbortController = null
      setLoading(false)
      setChatLoadError(error?.name === 'AbortError' ? '' : 'This chat could not be loaded. Sending is locked to protect the wrong chat.')
      return
    }
    if (!isCurrentSelection(id, generation)) return
    messagesAbortController = null
    setMessages(result.messages)
    setHasMore(result.hasMore)
    // Determine working state from loaded messages.
    // Only mark as working if the session is actually active (has a running tmux process).
    // Inactive/timed-out sessions should never show as working.
    const sessionMeta = await sessionMetaPromise
    if (!isCurrentSelection(id, generation)) return
    const isActive = sessionMeta?.isActive ?? false
    const msgs = result.messages
    if (msgs.length > 0) {
      const last = msgs[msgs.length - 1]
      const toolIntentState = deriveToolIntentState(msgs)
      const turnEnded = last.stopReason === 'end_turn' || last.stopReason === 'stop_sequence'
      setToolIntentStatus(!isActive || turnEnded ? '' : toolIntentState.status)
      setToolIntentHistory(!isActive || turnEnded ? [] : toolIntentState.history)
      setTodoSnapshot(deriveTodoSnapshot(msgs))
      if (!isActive || turnEnded) setWorking(false)
      else if (last.role === 'user' || toolIntentState.working) setWorking(true)
      else setWorking(false) // assistant mid-stream but no new SSE yet; let SSE update it
      // Extract cwd from last user message and update header
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].cwd) {
          const ls = lastSession()
          if (ls && ls.id === id && !ls.cwd) setLastSession({ ...ls, cwd: msgs[i].cwd })
          break
        }
      }
    } else {
      setToolIntentStatus('')
      setToolIntentHistory([])
      setTodoSnapshot(null)
      setWorking(isActive)
    }
    appendPendingMessages(id)
    setLoadedSessionId(id)
    setLoading(false)
    // Restore scroll position if we have one saved
    const savedScroll = scrollPositions.get(id)
    if (savedScroll !== undefined) {
      requestAnimationFrame(() => {
        if (isCurrentSelection(id, generation) && messageScrollRef) messageScrollRef.scrollTop = savedScroll
      })
    }
    setSSEStatus('connected')
    const unsubscribe = subscribeMessages(id, (msg) => {
      if (!isCurrentSelection(id, generation) || loadedSessionId() !== id) return
      if (messages().some(existing => existing.uuid === msg.uuid)) return
      // Clear assistant-done debounce on any incoming message
      clearTimeout(assistantDoneTimer)
      // If new content arrives while a question is showing, it was a false positive
      if (question() && msg.role === 'assistant' && !msg.stopReason) setQuestion(null)
      const toolIntentUpdate = toolIntentTransition({
        status: toolIntentStatus(),
        history: toolIntentHistory(),
        working: working(),
      }, msg)
      setToolIntentStatus(toolIntentUpdate.status)
      setToolIntentHistory(toolIntentUpdate.history)
      const todo = todoSnapshotFromMessage(msg)
      if (todo !== undefined) setTodoSnapshot(todo)
      if (isFinalAssistantMessage(msg)) clearAssistantStream()
      // Use stop_reason to accurately track working state
      if (msg.stopReason === 'end_turn' || msg.stopReason === 'stop_sequence') {
        setWorking(false)
        setToolIntentStatus('')
        setToolIntentHistory([])
        clearTimeout(workingTimer)
        // Refresh session list to pick up auto-generated title
        const cur = sessions().find(s => s.id === id)
        if (cur && (cur.title === 'New session' || cur.title === id.slice(0, 8))) {
          setTimeout(() => fetchSessions().then(s => updateSessions(s)).catch(() => {}), 3000)
        }
      } else if (msg.role === 'user') {
        setWorking(true)
        startWorkingTimeout()
      } else if (toolIntentUpdate.working === true) {
        setWorking(true)
        startWorkingTimeout()
      } else if (msg.role === 'assistant' && !msg.stopReason) {
        // Assistant message without stop_reason: JSONL may never get end_turn.
        // Debounce: if no more messages arrive in 5s, assume the turn is done.
        assistantDoneTimer = window.setTimeout(() => {
          if (isCurrentSelection(id, generation) && working()) {
            setWorking(false)
            setToolIntentStatus('')
            setToolIntentHistory([])
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
      let deliveredPendingId: string | undefined
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
            deliveredPendingId = prev[idx].uuid.slice('optimistic-'.length)
            updated[idx] = { ...msg, delivery: 'delivered' }
            return updated
          }
        }
        return [...prev, msg]
      })
      if (deliveredPendingId) {
        deletePendingMessage(deliveredPendingId)
        refreshPendingMessages()
      }
    },
    status => {
      if (!isCurrentSelection(id, generation)) return
      setSSEStatus(status)
      if (status === 'reconnecting') clearAssistantStream()
    },
    activity => { if (isCurrentSelection(id, generation)) setActivity(activity) },
    nextQuestion => { if (isCurrentSelection(id, generation)) setQuestion(nextQuestion) },
    event => { if (isCurrentSelection(id, generation) && loadedSessionId() === id) handleOmpEvent(event) })
    if (!isCurrentSelection(id, generation)) unsubscribe()
    else cleanupSSE = unsubscribe
    queueMicrotask(() => { if (isCurrentSelection(id, generation)) retryPendingMessages(id) })
  }

  function doSearch(query: string) {
    clearTimeout(searchTimer)
    if (query.length < 2) { setSearchResults([]); setSearching(false); return }
    setSearching(true)
    searchTimer = setTimeout(async () => {
      try {
        const results = await searchSessions(query)
        setSearchResults(results.filter(result => !isRoomPulseSession(result)))
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

  async function handleNew(newTab = false, agent: AgentId = 'omp') {
    setCreating(true)
    // Open the window synchronously to avoid popup blockers (iOS Safari
    // blocks window.open after an await breaks the user-gesture chain)
    const w = newTab ? window.open('', '_blank') : null
    try {
      const id = await createSession(undefined, agent)
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
    if (resumingId()) return
    const sess = sessions().find(s => s.id === id)
    setResumingId(id)
    showMediaNotice('Resuming chat…')
    try {
      const response = await resumeSession(id, sess?.cwd ?? undefined)
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}))
        throw new Error(detail.error || `HTTP ${response.status}`)
      }
      // The sessions endpoint deliberately serves a stale snapshot while it
      // refreshes. Preserve the resume acknowledgement instead of immediately
      // painting this chat inactive again.
      const refreshed = (await fetchSessions()).map(item => item.id === id ? { ...item, isActive: true } : item)
      updateSessions(refreshed)
      setLastSession(previous => previous?.id === id ? { ...previous, isActive: true } : previous)
      await select(id)
      showMediaNotice('Chat resumed.', 2500)
    } catch (error: any) {
      showMediaNotice(`Could not resume chat — ${error?.message || error}`)
    } finally {
      setResumingId(null)
    }
  }

  async function handleInterrupt(id: string) {
    await interruptSession(id)
    if (id === currentId()) {
      setWorking(false)
      setToolIntentStatus('')
      setToolIntentHistory([])
      clearAssistantStream()
    }
  }

  function handleInterruptConfirm(id: string) {
    if (confirm('Stop Claude?')) handleInterrupt(id)
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this session?')) return
    setMenuOpen(false)
    await deleteSession(id)
    dismissMediaNotice()
    cancelSelectionWork()
    setCurrentId(null)
    setLoadedSessionId(null)
    setChatLoadError('')
    location.hash = ''
    setMessages([])
    updateSessions(await fetchSessions())
  }

  function goHome() {
    dismissMediaNotice()
    const id = currentId()
    if (id) saveDraft(id, text())
    cancelSelectionWork()
    setCurrentId(null)
    setLoadedSessionId(null)
    setChatLoadError('')
    setLastSession(null)
    setMessages([])
    setWorking(false)
    setToolIntentStatus('')
    setToolIntentHistory([])
    clearAssistantStream()
    clearOmpLiveSurfaces()
    setActivity(null)
    setQuestion(null)
    setSidebar(false)
    location.hash = ''
  }

  async function doRename(id: string, title: string) {
    if (!title.trim()) { setRenaming(false); setSidebarRenaming(null); return }
    await renameSession(id, title.trim())
    setRenaming(false)
    setMenuOpen(false)
    setSidebarRenaming(null)
    updateSessions(await fetchSessions())
  }

  async function loadEarlier() {
    const id = currentId()
    const generation = selectionGeneration
    if (!id || loadedSessionId() !== id || loadingMore()) return
    setLoadingMore(true)
    // Capture viewport anchor so prepending older messages doesn't jump the
    // view. After setMessages resolves on the next frame, we restore by
    // shifting scrollTop by the grown height delta.
    const anchor = messageScrollRef
      ? { scrollTop: messageScrollRef.scrollTop, scrollHeight: messageScrollRef.scrollHeight }
      : null
    try {
      const result = await fetchMessages(id, messages().length)
      if (!isCurrentSelection(id, generation) || loadedSessionId() !== id) return
      setMessages(prev => [...result.messages, ...prev])
      setHasMore(result.hasMore)
      if (anchor && messageScrollRef) {
        const el = messageScrollRef
        requestAnimationFrame(() => {
          el.scrollTop = anchor.scrollTop + (el.scrollHeight - anchor.scrollHeight)
        })
      }
    } catch {}
    if (isCurrentSelection(id, generation)) setLoadingMore(false)
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
    updateSessions(await fetchSessions())
  }

  function stopVoice() {
    setListening(false)
    if (mediaStream) mediaStream.getTracks().forEach(track => track.stop())
    mediaStream = null
    mediaRecorder = null
    audioChunks = []
  }

  async function persistMediaPatch(id: string, patch: Record<string, unknown>) {
    await patchMediaRecord(id, patch).catch((e: any) => setMediaNotice(`Could not update recovery storage: ${e?.message || e}`))
  }

  function refreshPendingMessages() {
    try { return listPendingMessages() as PendingMessage[] }
    catch (error: any) {
      showMediaNotice(`Message recovery storage unavailable: ${error?.message || error}`)
      return []
    }
  }

  function appendPendingMessages(sessionId: string) {
    const allQueued = refreshPendingMessages()
    const queued = allQueued.filter(message => message.sessionId === sessionId)
    if (!queued.length || currentId() !== sessionId) return
    setMessages(previous => {
      const known = new Set(previous.map(message => message.uuid))
      return [...previous, ...queued.filter(message => !known.has(`optimistic-${message.id}`)).map(message => ({
        uuid: `optimistic-${message.id}`,
        role: 'user' as const,
        timestamp: new Date(message.createdAt).toISOString(),
        content: [{ type: 'text', text: message.text }],
        delivery: 'queued' as const,
      }))]
    })
  }

  function schedulePendingRetry() {
    if (pendingRetryTimer) clearTimeout(pendingRetryTimer)
    const queued = refreshPendingMessages()
    if (!queued.length || !navigator.onLine) return
    const attempts = Math.max(...queued.map(message => message.attempts), 0)
    const delay = Math.min(60_000, 2_000 * (2 ** Math.min(attempts, 5)))
    pendingRetryTimer = setTimeout(() => retryPendingMessages(), delay)
  }

  function deliverPendingMessage(record: PendingMessage): Promise<void> {
    const existing = pendingSendsInFlight.get(record.id)
    if (existing) return existing
    const delivery = (async () => {
      const attempt = record.attempts + 1
      patchPendingMessage(record.id, { attempts: attempt, error: undefined, lastAttemptAt: Date.now() })
      refreshPendingMessages()
      try {
        const session = sessions().find(item => item.id === record.sessionId) || (record.sessionId === currentId() ? lastSession() : null)
        if (session && !session.isActive) {
          const response = await resumeSession(session.id, session.cwd ?? undefined)
          if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`)
          updateSessions(await fetchSessions())
        }
        await sendInput(record.sessionId, record.text, record.id)
        deletePendingMessage(record.id)
        refreshPendingMessages()
        pushHistory(record.text)
        if (record.sessionId === currentId()) {
          setMessages(previous => {
            const optimisticId = `optimistic-${record.id}`
            const durableCopyExists = previous.some(message => message.uuid !== optimisticId && !message.uuid.startsWith('optimistic-') &&
              message.role === 'user' && message.content?.some(block => block.type === 'text' && block.text === record.text))
            return durableCopyExists
              ? previous.filter(message => message.uuid !== optimisticId)
              : previous.map(message => message.uuid === optimisticId ? { ...message, delivery: 'sent' as const } : message)
          })
          setWorking(true)
          setToolIntentStatus('')
          setToolIntentHistory([])
          clearAssistantStream()
          startWorkingTimeout()
        }
      } catch (error: any) {
        patchPendingMessage(record.id, { attempts: attempt, error: error?.message || String(error), lastAttemptAt: Date.now() })
        refreshPendingMessages()
        if (record.sessionId === currentId()) showMediaNotice(`Message kept safely and will retry — ${error?.message || error}`)
        schedulePendingRetry()
        throw error
      }
    })().finally(() => pendingSendsInFlight.delete(record.id))
    pendingSendsInFlight.set(record.id, delivery)
    return delivery
  }

  async function retryPendingMessages(sessionId?: string) {
    if (!navigator.onLine) return
    const queued = refreshPendingMessages().filter(message => !sessionId || message.sessionId === sessionId)
    for (const message of queued) await deliverPendingMessage(message).catch(() => {})
  }

  function retryRecoverableWork() {
    retryRecoverableMedia()
    retryPendingMessages()
  }

  function uploadPendingFile(file: PendingFile): Promise<string> {
    return runMediaOperationOnce(uploadsInFlight, file.id, async () => {
      if (file.serverPath) return file.serverPath
      updateFile(file.id, { status: 'uploading', error: undefined })
      await persistMediaPatch(file.id, { status: 'uploading', error: null })
      let lastAttempt = file.attempts
      try {
        const uploadPath = await retryMediaOperation(
          () => uploadFileWithId(file.blob, file.name, file.id, AbortSignal.timeout(90_000)),
          { onAttempt: async (attempt, error: any, willRetry: boolean) => {
            lastAttempt = attempt
            if (willRetry) {
              const patch = { status: 'uploading' as const, attempts: attempt, error: error?.message || String(error) }
              updateFile(file.id, patch)
              await persistMediaPatch(file.id, patch)
            }
          } },
        )
        updateFile(file.id, { status: 'uploaded', serverPath: uploadPath, error: undefined })
        await persistMediaPatch(file.id, { status: 'uploaded', serverPath: uploadPath, error: null })
        return uploadPath
      } catch (error: any) {
        const patch = { status: 'failed' as const, attempts: lastAttempt, error: error?.message || String(error) }
        updateFile(file.id, patch)
        await persistMediaPatch(file.id, patch)
        throw error
      }
    })
  }

  async function sendSessionText(rawText: string, targetId: string, messageId: string = crypto.randomUUID(), onQueued?: () => void) {
    const fullText = rawText.trim()
    if (!fullText) return
    const existing = (listPendingMessages() as PendingMessage[]).find(message => message.id === messageId)
    const record = putPendingMessage({
      id: messageId,
      sessionId: targetId,
      text: fullText,
      createdAt: existing?.createdAt ?? Date.now(),
      attempts: existing?.attempts ?? 0,
      error: existing?.error,
    }) as PendingMessage
    refreshPendingMessages()
    appendPendingMessages(targetId)
    onQueued?.()
    await deliverPendingMessage(record)
  }

  function processVoiceMemo(memo: VoiceMemo): Promise<void> {
    return runMediaOperationOnce(voiceMemosInFlight, memo.id, () => withMediaRecordClaim(memo.id, async () => {
      let transcript = memo.transcript
      let lastAttempt = memo.attempts
      if (!transcript && memo.blob.size < 1000) return
      try {
        if (!transcript) {
          updateVoice(memo.id, { status: 'transcribing', error: undefined })
          await persistMediaPatch(memo.id, { status: 'transcribing', error: null })
          transcript = await retryMediaOperation(
            () => transcribeAudio(memo.blob, AbortSignal.timeout(120_000)),
            { onAttempt: async (attempt, error: any, willRetry: boolean) => {
              lastAttempt = attempt
              if (willRetry) {
                const patch = { status: 'transcribing' as const, attempts: attempt, error: error?.message || String(error) }
                updateVoice(memo.id, patch)
                await persistMediaPatch(memo.id, patch)
              }
            } },
          )
          updateVoice(memo.id, { transcript })
          await persistMediaPatch(memo.id, { transcript })
        }
        if (memo.intent === 'send') {
          const onCurrent = memo.sessionId === currentId()
          // One tap sends the whole composer. Voice previously sent only its
          // transcript and left attached files behind for a surprising second tap.
          const pending = onCurrent ? files() : []
          const parts: string[] = [[memo.capturedText, transcript].filter(Boolean).join(' ')].filter(Boolean)
          for (const file of pending) {
            const uploadPath = await uploadPendingFile(file)
            parts.push(file.isImage ? `[Attached image: ${uploadPath}]` : `[Attached file: ${uploadPath}] (${file.name})`)
          }
          await sendSessionText(parts.join('\n'), memo.sessionId, memo.id)
          for (const file of pending) {
            URL.revokeObjectURL(file.dataUrl)
            await deleteMediaRecord(file.id).catch(() => {})
          }
          if (onCurrent && pending.length) setFiles(previous => previous.filter(file => !pending.some(sent => sent.id === file.id)))
          const draft = onCurrent ? text() : loadDraft(memo.sessionId)
          if (draft === memo.capturedText) {
            saveDraft(memo.sessionId, '')
            if (onCurrent) setText('')
          }
        } else {
          const previous = memo.sessionId === currentId() ? text().trim() : loadDraft(memo.sessionId).trim()
          const next = [previous, transcript].filter(Boolean).join(' ')
          saveDraft(memo.sessionId, next)
          if (memo.sessionId === currentId()) setText(next)
        }
        await patchMediaRecord(memo.id, { status: 'delivered', error: null, deliveredAt: Date.now(), blob: new Blob([], { type: memo.blob.type }) })
        setVoiceMemos(prev => prev.filter(item => item.id !== memo.id))
        if (memo.sessionId === currentId()) showMediaNotice('Voice memo recovered successfully.', 4000)
      } catch (error: any) {
        const message = error?.message || String(error)
        const patch = { status: 'failed' as const, attempts: lastAttempt, error: message, transcript }
        updateVoice(memo.id, patch)
        await persistMediaPatch(memo.id, patch)
        if (memo.sessionId === currentId()) showMediaNotice(`Voice memo retained: ${message}`)
      }
    })) as Promise<void>
  }

  async function retryRecoverableMedia() {
    if (!navigator.onLine) return
    for (const file of files().filter(item => item.status === 'failed')) uploadPendingFile(file).catch(() => {})
    for (const memo of voiceMemos().filter(isRetryableVoiceMemo)) processVoiceMemo(memo)
  }

  function downloadBlob(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  async function removeVoiceMemo(id: string) {
    const memo = voiceMemos().find(item => item.id === id)
    if (memo) await deleteMediaRecord(id).catch(() => {})
    setVoiceMemos(prev => prev.filter(item => item.id !== id))
  }

  async function toggleVoice() {
    if (listening()) {
      voiceSendAfterStop = false
      if (mediaRecorder?.state === 'recording') mediaRecorder.stop()
      else stopVoice()
      return
    }
    const recordingTarget = { sessionId: currentId(), capturedText: text().trim() }
    if (!recordingTarget.sessionId || loadedSessionId() !== recordingTarget.sessionId) return
    try { mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }) }
    catch { return }
    audioChunks = []
    voiceSendAfterStop = false
    const supportedMime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type))
    try { mediaRecorder = supportedMime ? new MediaRecorder(mediaStream, { mimeType: supportedMime }) : new MediaRecorder(mediaStream) }
    catch (e: any) { stopVoice(); setMediaNotice(`Recording is unsupported: ${e?.message || e}`); return }
    const recorder = mediaRecorder
    setListening(true)
    recorder.ondataavailable = event => { if (event.data.size > 0) audioChunks.push(event.data) }
    recorder.onstop = async () => {
      const blob = new Blob(audioChunks, { type: recorder.mimeType })
      const sessionId = recordingTarget.sessionId!
      const id = crypto.randomUUID()
      const name = `voice-memo-${Date.now()}.${blob.type.includes('mp4') ? 'm4a' : 'webm'}`
      const sizeError = blob.size > MAX_AUDIO_BYTES ? 'Voice memo is larger than the 25 MB audio limit' : blob.size < 1000 ? 'Recording was too short to transcribe' : null
      const record = { id, boxId: 'local', sessionId, kind: 'audio', name, mimeType: blob.type, blob, status: sizeError ? 'failed' : 'transcribing', attempts: 0, error: sizeError, intent: voiceSendAfterStop ? 'send' : 'append', capturedText: recordingTarget.capturedText, createdAt: Date.now() }
      try { await putMediaRecord(record) }
      catch (e: any) { setMediaNotice(`Voice recovery storage unavailable: ${e?.message || e}. Download the memo before closing this tab.`) }
      const memo: VoiceMemo = { ...record, status: record.status as VoiceStatus, error: record.error || undefined, intent: record.intent as 'append' | 'send', boxId: 'local' }
      if (sessionId === currentId()) setVoiceMemos(prev => [...prev, memo])
      stopVoice()
      if (sizeError) return
      setTranscribing(true)
      try { await processVoiceMemo(memo) }
      finally { setTranscribing(false) }
    }
    recorder.onerror = (event: any) => {
      setMediaNotice(`Recording failed: ${event?.error?.message || 'unknown recorder error'}`)
      if (recorder.state === 'recording') recorder.stop()
    }
    recorder.start(1000)
  }

  async function sendComposedMessage(rawText: string, pending: PendingFile[] = files()) {
    const val = rawText.trim()
    const selectedId = currentId()
    if ((!val && !pending.length) || !selectedId) return
    if (loadedSessionId() !== selectedId) {
      showMediaNotice('Wait for this chat to finish loading before sending.')
      return
    }
    const targetId = selectedId
    let safelyQueued = false
    setUploading(true)
    setMediaNotice('')
    try {
      const parts: string[] = val ? [val] : []
      for (const file of pending) {
        const uploadPath = await uploadPendingFile(file)
        parts.push(file.isImage ? `[Attached image: ${uploadPath}]` : `[Attached file: ${uploadPath}] (${file.name})`)
      }
      await sendSessionText(parts.join('\n'), targetId, pending[0]?.id || crypto.randomUUID(), () => {
        // Clicking Send transfers ownership from the composer to the durable
        // outbox. Clear only after that synchronous write succeeds.
        safelyQueued = true
        if (targetId === currentId() && text() === rawText) {
          setText('')
          saveDraft(targetId, '')
          if (textareaRef) textareaRef.style.height = 'auto'
        }
      })
      for (const file of pending) {
        URL.revokeObjectURL(file.dataUrl)
        await deleteMediaRecord(file.id).catch(() => {})
      }
      if (targetId === currentId()) {
        setFiles(prev => prev.filter(file => !pending.some(sent => sent.id === file.id)))
        if (textareaRef) textareaRef.style.height = 'auto'
      }
    } catch (e: any) {
      if (targetId === currentId()) setMediaNotice(safelyQueued
        ? pending.length
          ? `Media and message retained — ${e?.message || e}. Feather will retry.`
          : `Message retained — ${e?.message || e}. Feather will retry.`
        : `Could not queue message — ${e?.message || e}. Your draft is still here.`)
    } finally { setUploading(false) }
  }

  async function handleSend() {
    if (listening()) {
      voiceSendAfterStop = true
      if (mediaRecorder?.state === 'recording') mediaRecorder.stop()
      return
    }
    await sendComposedMessage(text(), files())
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
    const session = headerSession()
    if (!loading() && session && !session.isActive) {
      setWorking(false)
      setToolIntentStatus('')
      setToolIntentHistory([])
      clearAssistantStream()
    }
  })

  createEffect(() => {
    const s = headerSession()
    const w = working()
    if (!s) setFavicon('#333')
    else if (w) setFavicon('#f5a742')        // Orange when working
    else if (s.isActive) setFavicon('#4aba6a') // Green when ready
    else setFavicon('#666')                    // Gray when inactive
  })

  // Page title: feather icon + status dot + session label
  createEffect(() => {
    const s = headerSession()
    const w = working()
    const unreadCount = unreadSessions().size
    const unreadPrefix = unreadCount > 0 ? `(${unreadCount}) ` : ''
    const dot = w ? '\u25CF' : '\u25CB'
    if (s) {
      const label = s.projectLabel || s.title.slice(0, 30)
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
    padding: '9px 14px', border: 'none', 'border-bottom': tab() === t ? '2px solid #4aba6a' : '2px solid transparent',
    background: 'none', color: tab() === t ? '#e5e5e5' : '#666', 'font-size': '13px', 'font-weight': '600', cursor: 'pointer',
    '-webkit-tap-highlight-color': 'transparent', 'flex-shrink': '0',
  })

  // User-only transcript view. Tool-result user turns are implementation
  // traffic, not prompts, so include only messages with non-empty text blocks.
  const userPrompts = () => messages().filter(message => message.role === 'user' &&
    (message.content || []).some(block => block.type === 'text' && (block.text || '').trim()))
  const activeTodo = () => ompMirror().parent.todo || todoSnapshot()
  const activeSubagents = () => ompMirror().childOrder.map(id => ompMirror().children[id]).filter(Boolean)
  const promptText = (message: Message) => (message.content || [])
    .filter(block => block.type === 'text').map(block => block.text || '').join('\n').trim()
  const formatFeedTime = (timestamp: string | null | undefined) => {
    if (!timestamp) return ''
    const date = new Date(timestamp)
    if (Number.isNaN(date.getTime())) return ''
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  }
  let promptsScroller: HTMLDivElement | undefined
  createEffect(() => {
    if (tab() !== 'prompts') return
    const scroller = promptsScroller
    if (scroller) requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight })
  })

  async function loadSessionUpdates(id: string, generation: number) {
    setUpdatesLoading(true)
    setUpdatesError(null)
    setUpdatesRoomName(null)
    setUpdatesList([])
    try {
      const rooms = await fetchRooms(1000)
      if (generation !== updatesGeneration || tab() !== 'updates' || currentId() !== id) return
      const room = rooms.find(candidate => candidate.sessions.some(session => session.id === id))
      if (!room) return
      const updates = await fetchRoomUpdates(room.name)
      if (generation !== updatesGeneration || tab() !== 'updates' || currentId() !== id) return
      setUpdatesRoomName(room.name)
      setUpdatesList(updates)
    } catch (error: any) {
      if (generation === updatesGeneration && tab() === 'updates' && currentId() === id) setUpdatesError(error?.message || String(error))
    } finally {
      if (generation === updatesGeneration && tab() === 'updates' && currentId() === id) setUpdatesLoading(false)
    }
  }
  createEffect(() => {
    const id = currentId()
    const active = tab() === 'updates'
    const generation = ++updatesGeneration
    if (active && id) loadSessionUpdates(id, generation)
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
      <form onSubmit={handleLogin} action={appUrl('/api/login')} method="post" style={{ width: '100%', 'max-width': '320px', background: '#0d1117', border: '1px solid #1e1e1e', 'border-radius': '16px', padding: '32px 24px', 'text-align': 'center' }}>
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
        <Show when={currentId()}>
          <button onClick={goHome} title="Rooms home" style={{ position: 'fixed', top: 'max(12px, env(safe-area-inset-top))', left: 'calc(max(12px, env(safe-area-inset-left)) + 44px)', 'z-index': '50', background: '#1a1a2e', border: '1px solid #333', color: '#e5e5e5', width: '36px', height: '36px', 'border-radius': '8px', 'font-size': '20px', cursor: 'pointer', display: 'flex', 'align-items': 'center', 'justify-content': 'center', '-webkit-tap-highlight-color': 'transparent' }}>&#8249;</button>
        </Show>
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
            <span onClick={goHome} style={{ 'font-weight': '700', 'font-size': '16px', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>Feather</span>
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
            {/* New session + search buttons */}
            <div style={{ padding: '8px 16px', display: 'flex', 'flex-direction': 'column', gap: '7px', position: 'relative' }}>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button onClick={() => handleNew()} disabled={creating()} style={{ flex: '1', padding: '10px', background: creating() ? '#1a1a2e' : '#e0a050', color: creating() ? '#666' : '#111', border: 'none', 'border-radius': '8px', 'font-size': '14px', 'font-weight': '700', cursor: creating() ? 'wait' : 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>
                  {creating() ? 'Starting...' : '+ New OMP'}
                </button>
                <button onClick={() => handleNew(true)} disabled={creating()} title="Open new OMP chat in a new tab" style={{ padding: '10px 12px', background: creating() ? '#1a1a2e' : '#b97d32', color: creating() ? '#666' : '#111', border: 'none', 'border-radius': '8px', 'font-size': '14px', 'font-weight': '600', cursor: creating() ? 'wait' : 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>
                  &#8599;
                </button>
                <button onClick={() => { setSearchOpen(!searchOpen()); if (!searchOpen()) { setSearchQuery(''); setSearchResults([]) } }} title="Search chats" style={{ padding: '10px 12px', background: searchOpen() ? '#4aba6a' : '#1a1a2e', color: searchOpen() ? '#000' : '#888', border: '1px solid #333', 'border-radius': '8px', 'font-size': '14px', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>
                  &#x1F50D;
                </button>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button onClick={() => handleNew(false, 'claude')} disabled={creating()} style={{ flex: '1', padding: '7px 9px', background: '#15202a', border: '1px solid #344657', color: '#73b8ff', 'border-radius': '7px', cursor: 'pointer', 'font-size': '12px', 'font-weight': '700' }}>+ Claude Code</button>
                <Show when={codexAvailable()}>
                  <button onClick={() => handleNew(false, 'codex')} disabled={creating()} style={{ flex: '1', padding: '7px 9px', background: '#251b31', border: '1px solid #49345e', color: '#c084fc', 'border-radius': '7px', cursor: 'pointer', 'font-size': '12px', 'font-weight': '700' }}>+ Codex</button>
                </Show>
              </div>
            </div>
            {/* Search input */}
            <Show when={searchOpen()}>
              <div style={{ padding: '0 16px 8px' }}>
                <input
                  placeholder="Search all chats..."
                  value={searchQuery()}
                  onInput={(e) => { setSearchQuery(e.target.value); doSearch(e.target.value) }}
                  onKeyDown={(e) => { if (e.key === 'Escape') { setSearchOpen(false); setSearchQuery(''); setSearchResults([]) } }}
                  ref={(el) => setTimeout(() => el.focus(), 50)}
                  style={{ width: '100%', padding: '8px 12px', background: '#0e0e14', border: '1px solid #333', 'border-radius': '6px', color: '#e5e5e5', 'font-size': '13px', outline: 'none' }}
                />
              </div>
            </Show>
            {/* Session list grouped by time */}
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
                          <Show when={r.projectLabel}>
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
                const filtered = sessions()
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
                            <Show when={s.projectLabel}>
                              <div style={{ 'font-size': '10px', color: '#444', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{s.projectLabel}</div>
                            </Show>
                          </div>
                          <span style={{ 'font-size': '9px', padding: '1px 5px', 'border-radius': '3px', ...agentBadgeColors(s.agent), 'flex-shrink': '0', 'font-weight': '600' }}>{agentBadgeLabel(s.agent)}</span>
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
                      <Show when={sidecarsForSession(s.id).length > 0 || s.id === currentId()}>
                        <div style={{ 'margin-top': '6px', 'padding-left': '14px', display: 'flex', 'flex-direction': 'column', gap: '3px' }}>
                          <For each={sidecarsForSession(s.id)}>{(group) => (
                            <div onClick={(event) => { event.stopPropagation(); setOpenSidecarId(group.id) }}
                              style={{ 'font-size': '11px', color: '#9a9ab0', cursor: 'pointer', display: 'flex', 'align-items': 'center', gap: '5px', '-webkit-tap-highlight-color': 'transparent' }}
                              onMouseOver={(event) => (event.currentTarget.style.color = '#cccccc')}
                              onMouseOut={(event) => (event.currentTarget.style.color = '#9a9ab0')}>
                              <span style={{ color: '#4aba6a' }}>↳</span>
                              <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', flex: '1' }}>
                                {group.members.filter(member => member.spawned).map(member => member.role).join(', ')}
                              </span>
                              <span style={{ color: '#555' }}>{group.members.length}p</span>
                            </div>
                          )}</For>
                          <Show when={s.id === currentId()}>
                            <div onClick={(event) => { event.stopPropagation(); spawnSidecarFor(s.id) }}
                              style={{ 'font-size': '11px', color: '#555', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}
                              onMouseOver={(event) => (event.currentTarget.style.color = '#6aa6e5')}
                              onMouseOut={(event) => (event.currentTarget.style.color = '#555')}>
                              + sidecar
                            </div>
                          </Show>
                        </div>
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

      <Show when={openSidecarId()}>
        <div style={{ position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.55)', 'z-index': '200', display: 'flex', 'justify-content': 'flex-end' }}
          onClick={() => setOpenSidecarId(null)}>
          <div style={{ width: 'min(460px, 100%)', height: '100%', background: '#0d0d12', 'border-left': '1px solid #222' }}
            onClick={(event) => event.stopPropagation()}>
            <SidecarThread
              id={openSidecarId}
              onClose={() => setOpenSidecarId(null)}
              onOpenSession={(id) => { setOpenSidecarId(null); select(id) }}
              onChange={refreshSidecars}
            />
          </div>
        </div>
      </Show>

      {/* Main */}
      <div style={{ flex: '1', display: 'flex', 'flex-direction': 'column', 'min-width': '0', height: '100%', position: 'relative' }}>
        {/* Header */}
        <div style={{ position: 'relative', padding: '8px 16px 0 100px', 'padding-top': 'max(8px, env(safe-area-inset-top))', 'border-bottom': '1px solid #1e1e1e', display: 'flex', 'align-items': 'center', gap: '8px', 'min-height': '48px', 'flex-shrink': '0' }}>
          <span data-testid="build-version" title={`Build ${__BUILD_VERSION__}`} style={{ position: 'absolute', top: '2px', right: '10px', color: '#444', 'font-size': '8px', 'font-family': "'SF Mono', Menlo, monospace", 'line-height': '1', 'letter-spacing': '0.02em', 'white-space': 'nowrap' }}>{__BUILD_TIME__}</span>
          <Show when={headerSession()} fallback={<span style={{ color: '#888', 'font-size': '14px', 'font-weight': '600' }}>{currentId() ? 'Loading...' : 'Feather'}</span>}>
            {(s) => <>
              <Show when={s().isActive}><span style={{ width: '8px', height: '8px', 'border-radius': '50%', background: '#4aba6a', 'flex-shrink': '0' }} /></Show>
              <Show when={renaming()} fallback={
                <div style={{ overflow: 'hidden', 'min-width': '0' }}>
                  <div style={{ 'font-size': '10px', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', display: 'flex', 'align-items': 'center', gap: '4px' }}>
                    <Show when={s().projectLabel}>
                      {(label) => <span style={{ color: '#666' }}>{label()}</span>}
                    </Show>
                    <Show when={currentCwd()}>
                      {(cwd) => <>
                        <Show when={s().projectLabel}>
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
                      <button onClick={() => { handleResume(s().id); setMenuOpen(false) }} disabled={resumingId() === s().id}
                        style={{ display: 'block', width: '100%', padding: '10px 16px', background: 'none', border: 'none', 'border-bottom': '1px solid #222', color: '#4aba6a', 'font-size': '13px', 'text-align': 'left', cursor: resumingId() === s().id ? 'wait' : 'pointer' }}>{resumingId() === s().id ? 'Resuming…' : 'Resume'}</button>
                    </Show>
                    <Show when={s().isActive}>
                      <button onClick={() => { handleInterrupt(s().id); setMenuOpen(false) }}
                        style={{ display: 'block', width: '100%', padding: '10px 16px', background: 'none', border: 'none', 'border-bottom': '1px solid #222', color: '#d45555', 'font-size': '13px', 'text-align': 'left', cursor: 'pointer' }}>Stop</button>
                    </Show>
                    <button onClick={() => { setRenameText(s().title); setRenaming(true); setMenuOpen(false) }}
                      style={{ display: 'block', width: '100%', padding: '10px 16px', background: 'none', border: 'none', 'border-bottom': '1px solid #222', color: '#e5e5e5', 'font-size': '13px', 'text-align': 'left', cursor: 'pointer' }}>Rename</button>
                    <button onClick={() => handleFork(s().id)}
                      style={{ display: 'block', width: '100%', padding: '10px 16px', background: 'none', border: 'none', 'border-bottom': '1px solid #222', color: '#e5e5e5', 'font-size': '13px', 'text-align': 'left', cursor: 'pointer' }}>Fork</button>
                    <a href={exportUrl(s().id)} download="" style={{ display: 'block', width: '100%', padding: '10px 16px', background: 'none', border: 'none', 'border-bottom': '1px solid #222', color: '#e5e5e5', 'font-size': '13px', 'text-align': 'left', cursor: 'pointer', 'text-decoration': 'none' }} onClick={() => setMenuOpen(false)}>Export MD</a>
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
          <div style={{ display: 'flex', 'align-items': 'center', 'border-bottom': '1px solid #1e1e1e', 'padding-left': '16px', 'flex-shrink': '0', 'overflow-x': 'auto', 'scrollbar-width': 'none', '-webkit-overflow-scrolling': 'touch' }}>
            <button onClick={() => setTab('chat')} style={tabStyle('chat')}>Chat</button>
            <button onClick={() => setTab('prompts')} style={tabStyle('prompts')}>Prompts</button>
            <button onClick={() => setTab('todos')} style={tabStyle('todos')}>Todos<Show when={activeTodo()}>{` ${activeTodo()!.completed}/${activeTodo()!.total}`}</Show></button>
            <button onClick={() => setTab('agents')} style={tabStyle('agents')}>Agents<Show when={activeSubagents().length}>{` ${activeSubagents().length}`}</Show></button>
            <button onClick={() => setTab('updates')} style={tabStyle('updates')}>Updates</button>
            <button onClick={() => { setTab('files'); if (!browseDir()) openFileBrowser() }} style={tabStyle('files')}>Files{touchedFiles().length > 0 ? ` (${touchedFiles().length})` : ''}</button>
            <button onClick={() => setTab('terminal')} style={tabStyle('terminal')}>Terminal</button>
          </div>
        </Show>

        {/* Reconnecting banner */}
        <Show when={sseStatus() === 'reconnecting' && currentId()}>
          <div style={{ padding: '4px 16px', background: '#c4993a', color: '#000', 'font-size': '12px', 'font-weight': '600', 'text-align': 'center', 'flex-shrink': '0' }}>Reconnecting...</div>
        </Show>
        <Show when={chatLoadError() && currentId()}>
          <div role="alert" style={{ padding: '7px 12px', background: '#2a1515', color: '#ff9b93', 'font-size': '12px', display: 'flex', 'align-items': 'center', 'justify-content': 'center', gap: '10px', 'flex-shrink': '0' }}>
            <span>{chatLoadError()}</span>
            <button onClick={() => { const id = currentId(); if (id) select(id) }} style={{ background: '#4a2525', border: '1px solid #7b3e3e', color: '#ffd0cc', 'border-radius': '5px', padding: '3px 8px', cursor: 'pointer' }}>Retry</button>
          </div>
        </Show>

        {/* Content */}
        <div style={{ flex: '1', overflow: 'hidden' }}>
          <Show when={currentId()} fallback={
            <RoomsHome
              onOpen={select}
              onNewChat={(agent) => handleNew(false, agent)}
              onSessionsChanged={() => fetchSessions().then(updateSessions).catch(() => {})}
              creating={creating()}
              codexAvailable={codexAvailable()}
            />
          }>
            <div style={{ display: tab() === 'chat' ? 'block' : 'none', height: '100%' }}>
              <MessageView
                messages={messages()}
                loading={loading()}
                hasMore={hasMore()}
                loadingMore={loadingMore()}
                onLoadEarlier={loadEarlier}
                onAnswer={(answer) => { if (composerReady()) sendInput(currentId()!, answer) }}
                onKeys={(keys) => { if (composerReady()) sendSessionKeys(currentId()!, keys).catch(console.error) }}
                starred={new Set(starred()[currentId()!] || [])}
                onToggleStar={(uuid) => { if (loadedSessionId()) toggleStar(loadedSessionId()!, uuid) }}
                working={working()}
                statusText={toolIntentStatus()}
                intentHistory={toolIntentHistory()}
                assistantStream={assistantStream()}
                work={ompMirror().parent}
                notice={ompNotice()}
                approval={ompApproval()}
                subagents={[]}
                jobs={[]}
                runtime={null}
                scrollRefCb={(el) => { messageScrollRef = el }}
                sessionId={loadedSessionId()}
              />
            </div>
            <div style={{ display: tab() === 'files' ? 'flex' : 'none', 'flex-direction': 'column', height: '100%' }}>
              {/* Mode toggle */}
              <div style={{ display: 'flex', gap: '4px', padding: '8px 12px', 'border-bottom': '1px solid #1e1e1e', 'flex-shrink': '0' }}>
                <button onClick={() => setFilesMode('changed')}
                  style={{ background: filesMode() === 'changed' ? '#1e1e1e' : 'transparent', border: '1px solid #333', color: filesMode() === 'changed' ? '#e5e5e5' : '#888', 'font-size': '12px', padding: '4px 10px', 'border-radius': '6px', cursor: 'pointer' }}>
                  Changed{touchedFiles().length > 0 ? ` (${touchedFiles().length})` : ''}
                </button>
                <button onClick={() => setFilesMode('browse')}
                  style={{ background: filesMode() === 'browse' ? '#1e1e1e' : 'transparent', border: '1px solid #333', color: filesMode() === 'browse' ? '#e5e5e5' : '#888', 'font-size': '12px', padding: '4px 10px', 'border-radius': '6px', cursor: 'pointer' }}>
                  Browse
                </button>
              </div>
              {/* Changed mode */}
              <Show when={filesMode() === 'changed'}>
                <div style={{ flex: '1', 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch', padding: '8px 0' }}>
                  <Show when={touchedFiles().length === 0}>
                    <div style={{ color: '#555', 'text-align': 'center', padding: '40px', 'font-size': '13px' }}>No files touched yet</div>
                  </Show>
                  <For each={touchedFiles()}>{(f) => {
                    const short = f.path.split('/').slice(-2).join('/')
                    const actionColors: Record<string, string> = { Read: '#73b8ff', Write: '#4aba6a', Edit: '#c4993a', Grep: '#b48ead', Glob: '#88c0d0' }
                    return (
                      <div onClick={() => openFile(f.path)} style={{ padding: '8px 16px', 'border-bottom': '1px solid #111', 'font-size': '13px', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>
                        <div style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
                          <span style={{ color: '#e5e5e5', 'font-family': "'SF Mono', Menlo, monospace", overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', flex: '1' }} title={f.path}>{short}</span>
                          <For each={f.actions}>{(a) => (
                            <span style={{ 'font-size': '10px', padding: '1px 5px', 'border-radius': '3px', background: 'rgba(255,255,255,0.05)', color: actionColors[a] || '#888' }}>{a}</span>
                          )}</For>
                          <a href={appUrl(`/api/files/raw?path=${encodeURIComponent(f.path)}&download=1`)} download={f.path.split('/').pop()} title={`Download ${f.path.split('/').pop()}`} onClick={(ev) => ev.stopPropagation()} style={{ color: '#73b8ff', display: 'flex', 'align-items': 'center', padding: '0 2px', 'flex-shrink': '0', '-webkit-tap-highlight-color': 'transparent' }}>
                            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8m0 0l-3-3m3 3l3-3M3 13h10" /></svg>
                          </a>
                        </div>
                        <div style={{ color: '#444', 'font-size': '11px', 'font-family': "'SF Mono', Menlo, monospace", 'margin-top': '2px', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{f.path}</div>
                      </div>
                    )
                  }}</For>
                </div>
              </Show>
              {/* Browse mode */}
              <Show when={filesMode() === 'browse'}>
                <Show when={browseDir()}>
                  <div style={{ padding: '6px 16px', display: 'flex', 'align-items': 'center', gap: '8px', 'border-bottom': '1px solid #111', 'flex-shrink': '0' }}>
                    <Show when={browseParent()}>
                      <button onClick={() => openFileBrowser(browseParent()!)} style={{ background: 'none', border: 'none', color: '#73b8ff', cursor: 'pointer', 'font-size': '12px', padding: '0', '-webkit-tap-highlight-color': 'transparent' }}>
                        ..
                      </button>
                    </Show>
                    <span style={{ 'font-size': '11px', color: '#888', 'font-family': "'SF Mono', Menlo, monospace", overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', flex: '1' }}>{browseDir()}</span>
                    <button onClick={toggleHidden} title={showHidden() ? 'Hide dotfiles' : 'Show dotfiles'} style={{ background: showHidden() ? '#1e3a5f' : 'transparent', border: `1px solid ${showHidden() ? '#73b8ff' : '#444'}`, color: showHidden() ? '#73b8ff' : '#999', cursor: 'pointer', 'font-size': '12px', padding: '4px 10px', 'border-radius': '4px', '-webkit-tap-highlight-color': 'transparent', 'flex-shrink': '0', 'font-family': "'SF Mono', Menlo, monospace", 'user-select': 'none' }}>
                      {showHidden() ? '☑ .hidden' : '☐ .hidden'}
                    </button>
                  </div>
                </Show>
                <div style={{ flex: '1', 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch' }}>
                  <Show when={browseLoading()}>
                    <div style={{ padding: '12px 16px', color: '#555', 'font-size': '12px' }}>Loading...</div>
                  </Show>
                  <Show when={!browseLoading() && browseDir()}>
                    <For each={browseEntries()}>{(entry) => {
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
                            <button onClick={() => openFile(entry.path)} style={{ background: 'none', border: 'none', color: '#e5e5e5', cursor: 'pointer', 'font-family': "'SF Mono', Menlo, monospace", padding: '0', 'text-align': 'left', flex: '1', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', 'font-size': '12px', '-webkit-tap-highlight-color': 'transparent' }}>
                              {entry.name}
                            </button>
                          )}
                          <span style={{ color: '#555', 'font-size': '10px', 'flex-shrink': '0' }}>{fmtAge(entry.mtime)}</span>
                          <span style={{ color: '#444', 'font-size': '10px', 'flex-shrink': '0', 'min-width': '30px', 'text-align': 'right' }}>{fmtSize(entry.size)}</span>
                          {entry.isDir ? (
                            <span style={{ width: '17px', 'flex-shrink': '0' }} />
                          ) : (
                            <a href={appUrl(`/api/files/raw?path=${encodeURIComponent(entry.path)}&download=1`)} download={entry.name} title={`Download ${entry.name}`} onClick={(ev) => ev.stopPropagation()} style={{ color: '#73b8ff', display: 'flex', 'align-items': 'center', padding: '0 2px', 'flex-shrink': '0', '-webkit-tap-highlight-color': 'transparent' }}>
                              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8m0 0l-3-3m3 3l3-3M3 13h10" /></svg>
                            </a>
                          )}
                          <button onClick={(ev) => { ev.stopPropagation(); deleteBrowseEntry(entry.path, entry.name, entry.isDir) }} title={`Delete ${entry.name}`} style={{ background: 'none', border: 'none', color: '#664', cursor: 'pointer', 'font-size': '11px', padding: '0 2px', 'flex-shrink': '0', '-webkit-tap-highlight-color': 'transparent' }}>🗑</button>
                        </div>
                      )
                    }}</For>
                    <Show when={browseEntries().length === 0}>
                      <div style={{ padding: '12px 16px', color: '#444', 'font-size': '12px' }}>Empty directory</div>
                    </Show>
                  </Show>
                </div>
              </Show>
            </div>
            <div style={{ display: tab() === 'terminal' ? 'block' : 'none', height: '100%' }}>
              <Terminal sessionId={tab() === 'terminal' ? currentId() : null} />
            </div>
            <div data-testid="prompts-panel" style={{ display: tab() === 'prompts' ? 'flex' : 'none', 'flex-direction': 'column', height: '100%', overflow: 'hidden' }}>
              <div ref={promptsScroller} style={{ flex: '1', 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch', padding: '12px 16px 24px' }}>
                <Show when={hasMore()}>
                  <button onClick={loadEarlier} disabled={loadingMore()} style={{ display: 'block', margin: '0 auto 12px', background: '#1a1a2e', border: '1px solid #333', color: '#aaa', 'border-radius': '7px', padding: '6px 12px', 'font-size': '12px', cursor: loadingMore() ? 'wait' : 'pointer' }}>{loadingMore() ? 'Loading…' : 'Load earlier prompts'}</button>
                </Show>
                <For each={userPrompts()} fallback={<div style={{ color: '#666', 'font-size': '13px', padding: '16px 4px' }}>No prompts yet in this chat.</div>}>
                  {(message) => (
                    <div style={{ 'margin-bottom': '10px', padding: '10px 12px', background: '#0d1117', border: '1px solid #1e1e1e', 'border-radius': '10px' }}>
                      <div style={{ 'font-size': '10px', color: '#5a6472', 'font-family': 'monospace', 'margin-bottom': '4px' }}>{formatFeedTime(message.timestamp)}</div>
                      <div style={{ 'font-size': '14px', color: '#e0e3e8', 'line-height': '1.5', 'white-space': 'pre-wrap', 'word-break': 'break-word' }}>{promptText(message)}</div>
                    </div>
                  )}
                </For>
              </div>
            </div>
            <div data-testid="todos-panel" style={{ display: tab() === 'todos' ? 'flex' : 'none', 'flex-direction': 'column', height: '100%', overflow: 'hidden' }}>
              <div style={{ flex: '1', 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch', padding: '14px 16px 28px' }}>
                <div style={{ 'max-width': '760px', margin: '0 auto' }}>
                  <Show when={activeTodo()} fallback={<div style={{ color: '#666', 'font-size': '13px', padding: '16px 4px' }}>No Todo list in this chat yet.</div>}>
                    {(todo) => <>
                      <div style={{ display: 'flex', 'align-items': 'baseline', 'justify-content': 'space-between', gap: '12px', 'margin-bottom': '14px' }}>
                        <div>
                          <div style={{ color: '#e5e5e5', 'font-size': '18px', 'font-weight': '700' }}>Todos</div>
                          <Show when={todo().active}><div style={{ color: '#999', 'font-size': '12px', 'margin-top': '3px' }}>Current · {todo().active}</div></Show>
                        </div>
                        <span style={{ color: todo().completed === todo().total ? '#4aba6a' : '#999', 'font-size': '12px', 'font-weight': '700', 'font-family': "'SF Mono', Menlo, monospace" }}>{todo().completed}/{todo().total}</span>
                      </div>
                      <For each={todo().phases}>{(phase) => (
                        <section style={{ 'margin-bottom': '12px', padding: '12px 14px', background: '#11151c', border: '1px solid #292936', 'border-radius': '10px' }}>
                          <div style={{ color: '#888', 'font-size': '10px', 'font-weight': '700', 'text-transform': 'uppercase', 'letter-spacing': '0.07em', 'margin-bottom': '7px' }}>{phase.name}</div>
                          <For each={phase.tasks}>{(task) => (
                            <div style={{ display: 'flex', gap: '9px', padding: '5px 0', color: task.status === 'completed' ? '#777' : task.status === 'in_progress' ? '#e5e5e5' : '#aaa', 'font-size': '13px', 'line-height': '1.4', 'text-decoration': task.status === 'abandoned' ? 'line-through' : 'none' }}>
                              <span style={{ color: task.status === 'completed' ? '#4aba6a' : task.status === 'in_progress' ? '#73b8ff' : task.status === 'blocked' ? '#d8a13b' : '#666', width: '14px', 'flex-shrink': '0', 'font-weight': '700' }}>{task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '●' : task.status === 'blocked' ? '!' : task.status === 'abandoned' ? '×' : '○'}</span>
                              <span style={{ 'min-width': '0', 'word-break': 'break-word' }}>
                                {task.content}
                                <Show when={task.blocker}><span style={{ display: 'block', color: '#d8a13b', 'font-size': '11px', 'margin-top': '2px' }}>{task.blocker}</span></Show>
                              </span>
                            </div>
                          )}</For>
                        </section>
                      )}</For>
                    </>}
                  </Show>
                </div>
              </div>
            </div>
            <div data-testid="agents-panel" style={{ display: tab() === 'agents' ? 'block' : 'none', height: '100%', overflow: 'hidden' }}>
              <Show when={activeSubagents().length > 0 || ompJobs().length > 0 || ompRuntime()} fallback={<div style={{ color: '#666', 'font-size': '13px', padding: '30px 20px', 'text-align': 'center' }}>No delegated agents or background jobs in this chat yet.</div>}>
                <MessageView messages={[]} loading={false} subagents={activeSubagents()} jobs={ompJobs()} runtime={ompRuntime()} standaloneAgents />
              </Show>
            </div>
            <div data-testid="updates-panel" style={{ display: tab() === 'updates' ? 'flex' : 'none', 'flex-direction': 'column', height: '100%', overflow: 'hidden' }}>
              <div style={{ flex: '1', 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch', padding: '12px 16px 24px' }}>
                <Show when={updatesError()}><div style={{ color: '#d45555', 'font-size': '13px', padding: '8px 4px' }}>{updatesError()}</div></Show>
                <Show when={updatesLoading()}><div style={{ color: '#666', 'font-size': '13px', padding: '8px 4px' }}>Loading updates…</div></Show>
                <Show when={!updatesLoading() && !updatesError() && !updatesRoomName()}>
                  <div style={{ color: '#666', 'font-size': '13px', padding: '8px 4px', 'line-height': '1.5' }}>This chat isn't in a Room, so it has no Updates feed. Updates live per Room — open the Rooms home screen to see them.</div>
                </Show>
                <Show when={updatesRoomName()}>
                  <div style={{ 'font-size': '12px', color: '#7a8290', 'margin-bottom': '10px' }}>Updates for <span style={{ color: '#9aa4b2', 'font-weight': '600' }}>#{updatesRoomName()}</span></div>
                  <For each={[...updatesList()].reverse()} fallback={<div style={{ color: '#666', 'font-size': '13px', padding: '4px' }}>No updates yet in this Room.</div>}>
                    {(update) => (
                      <div style={{ padding: '9px 0', 'border-bottom': '1px solid #14141c' }}>
                        <div style={{ 'font-size': '10px', color: '#5a6472', 'font-family': 'monospace', 'margin-bottom': '3px' }}>{formatFeedTime(update.ts)}</div>
                        <div style={{ 'font-size': '13px', color: '#d0d4da', 'line-height': '1.5', 'white-space': 'pre-wrap', 'word-break': 'break-word' }}>{update.text}</div>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            </div>
          </Show>
        </div>

        {/* Drag overlay */}
        <Show when={dragging()}>
          <div style={{ position: 'absolute', inset: '0', background: 'rgba(74,186,106,0.1)', border: '2px dashed #4aba6a', 'border-radius': '12px', 'z-index': '100', display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'pointer-events': 'none' }}>
            <span style={{ color: '#4aba6a', 'font-size': '18px', 'font-weight': '600' }}>Drop files to attach</span>
          </div>
        </Show>

        {/* File viewer modal */}
        <Show when={viewingFile()}>
          {(() => {
            const v = viewingFile()!
            const isMd = v.path.toLowerCase().endsWith('.md')
            const slash = v.path.lastIndexOf('/')
            const name = slash >= 0 ? v.path.slice(slash + 1) : v.path
            const dir = slash >= 0 ? v.path.slice(0, slash) : ''
            const rawUrl = appUrl(`/api/files/raw?path=${encodeURIComponent(v.path)}`)
            const kindLabel = v.kind === 'pdf' ? 'PDF' : v.kind === 'image' ? 'IMAGE' : v.kind === 'binary' ? 'BINARY' : 'TEXT'
            const kindColor = v.kind === 'pdf' ? '#e57373' : v.kind === 'image' ? '#81c784' : v.kind === 'binary' ? '#ba68c8' : '#73b8ff'
            return (
              <div onClick={closeViewer} style={{ position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.6)', 'backdrop-filter': 'blur(4px)', 'z-index': '200', display: 'flex', 'align-items': 'stretch', 'justify-content': 'center', padding: 'max(20px, env(safe-area-inset-top)) 16px max(20px, env(safe-area-inset-bottom))' }}>
                <div onClick={(e) => e.stopPropagation()} style={{ background: '#0d1117', border: '1px solid #1e1e1e', 'border-radius': '12px', 'max-width': '900px', width: '100%', display: 'flex', 'flex-direction': 'column', overflow: 'hidden', 'box-shadow': '0 12px 40px rgba(0,0,0,0.5)' }}>
                  <div style={{ display: 'flex', 'align-items': 'center', gap: '10px', padding: '12px 16px', 'border-bottom': '1px solid #1e1e1e', background: 'linear-gradient(180deg, #11161e 0%, #0a0e14 100%)', 'flex-shrink': '0' }}>
                    <span style={{ 'font-size': '9px', 'font-weight': '700', 'letter-spacing': '0.08em', color: kindColor, border: `1px solid ${kindColor}55`, background: `${kindColor}15`, padding: '2px 6px', 'border-radius': '4px', 'flex-shrink': '0' }}>{kindLabel}</span>
                    <div style={{ flex: '1', 'min-width': '0', display: 'flex', 'flex-direction': 'column', gap: '1px' }}>
                      <span style={{ color: '#f0f0f0', 'font-size': '14px', 'font-weight': '600', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }} title={v.path}>{name}</span>
                      <Show when={dir}>
                        <span style={{ color: '#666', 'font-size': '11px', 'font-family': "'SF Mono', Menlo, monospace", overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{dir}</span>
                      </Show>
                    </div>
                    <a href={`${rawUrl}&download=1`} download={name} title="Download" style={{ color: '#73b8ff', 'text-decoration': 'none', 'font-size': '13px', padding: '6px 10px', 'border-radius': '6px', border: '1px solid #1e3a5f', background: '#0e1a2a', display: 'flex', 'align-items': 'center', gap: '4px', 'flex-shrink': '0' }}>↓ Download</a>
                    <button onClick={closeViewer} title="Close" style={{ background: 'transparent', border: 'none', color: '#888', 'font-size': '22px', cursor: 'pointer', padding: '0 4px', 'line-height': '1', 'flex-shrink': '0' }}>&times;</button>
                  </div>
                  <div style={{ 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch', flex: '1' }}>
                    <Show when={v.error}>
                      <div style={{ padding: '20px', color: '#c44', 'font-size': '13px' }}>{v.error}</div>
                    </Show>
                    <Show when={v.kind === 'image' && !v.error}>
                      <div style={{ padding: '16px', display: 'flex', 'align-items': 'center', 'justify-content': 'center', background: '#070a0e' }}>
                        <img src={rawUrl} alt={name} style={{ 'max-width': '100%', 'max-height': '70vh', 'object-fit': 'contain', 'border-radius': '4px' }} />
                      </div>
                    </Show>
                    <Show when={v.kind === 'pdf' && !v.error && !v.blobUrl}>
                      <div style={{ padding: '40px 20px', 'text-align': 'center', color: '#666', 'font-size': '13px' }}>Loading PDF…</div>
                    </Show>
                    <Show when={v.kind === 'pdf' && !v.error && v.blobUrl}>
                      <iframe src={v.blobUrl} style={{ display: 'block', width: '100%', height: '70vh', border: 'none', background: '#fff' }} title={name} />
                    </Show>
                    <Show when={v.kind === 'binary' && !v.error}>
                      <div style={{ padding: '40px 20px', 'text-align': 'center', color: '#aaa' }}>
                        <div style={{ 'font-size': '48px', 'margin-bottom': '12px', opacity: '0.6' }}>📦</div>
                        <div style={{ 'font-size': '14px', 'margin-bottom': '6px', color: '#d0d0d0' }}>{name}</div>
                        <div style={{ 'font-size': '12px', color: '#666', 'margin-bottom': '20px' }}>Binary file. No inline preview available.</div>
                        <a href={`${rawUrl}&download=1`} download={name} style={{ display: 'inline-block', color: '#73b8ff', 'text-decoration': 'none', 'font-size': '13px', padding: '8px 16px', 'border-radius': '6px', border: '1px solid #1e3a5f', background: '#0e1a2a' }}>↓ Download</a>
                      </div>
                    </Show>
                    <Show when={v.kind === 'text' && !v.error && !v.content}>
                      <div style={{ padding: '20px', color: '#666', 'font-size': '13px' }}>Loading…</div>
                    </Show>
                    <Show when={v.kind === 'text' && !v.error && v.content && isMd}>
                      <div class="prose" style={{ padding: '4px 24px', color: '#d0d0d0', 'font-size': '14px', 'line-height': '1.55' }} innerHTML={marked.parse(v.content) as string} />
                    </Show>
                    <Show when={v.kind === 'text' && !v.error && v.content && !isMd}>
                      <pre style={{ margin: '0', padding: '16px 20px', color: '#d0d0d0', 'font-size': '12px', 'font-family': "'SF Mono', Menlo, monospace", 'white-space': 'pre-wrap', 'word-break': 'break-word' }}>{v.content}</pre>
                    </Show>
                  </div>
                </div>
              </div>
            )
          })()}
        </Show>

        {/* Question popup */}
        <Show when={question() && composerReady() && tab() === 'chat'}>
          {(() => {
            const q = question()!
            const handleAnswer = async (type: string, index?: number, text?: string) => {
              if (!composerReady()) return
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
              const label = working() ? (toolIntentStatus() || act || 'Working...') : inactive ? 'Inactive' : 'Ready'
              const labelColor = working() ? '#f5a742' : inactive ? '#666' : '#555'
              return <>
                <span style={{ width: '6px', height: '6px', 'border-radius': '50%', background: dotColor, transition: 'background 0.3s', 'flex-shrink': '0', cursor: working() ? 'pointer' : 'default' }} onClick={() => { if (working() && currentId()) handleInterruptConfirm(currentId()!) }} />
                <span onClick={() => { if (working() && currentId()) handleInterruptConfirm(currentId()!) }} style={{ 'font-size': '10px', color: labelColor, 'font-weight': '500', cursor: working() ? 'pointer' : 'default', '-webkit-tap-highlight-color': 'transparent', 'white-space': 'nowrap', overflow: 'hidden', 'text-overflow': 'ellipsis', 'max-width': '300px' }}>{label}</span>
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
                  const r = await fetch(appUrl('/api/update'), { method: 'POST' })
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
        <Show when={currentId() && tab() === 'chat'}>
          <input ref={fileInputRef} type="file" multiple hidden title="Maximum file size: 50 MB" onChange={(e) => { if (e.target.files?.length) { addFiles(e.target.files); e.target.value = '' } }} />
          <Show when={mediaNotice()}>
            <div role="status" style={{ padding: '7px 12px', 'border-top': '1px solid #332b18', background: '#17140b', color: '#d8bd66', 'font-size': '12px', display: 'flex', 'justify-content': 'space-between', gap: '8px' }}>
              <span>{mediaNotice()}</span><button onClick={dismissMediaNotice} style={{ background: 'none', border: 'none', color: '#d8bd66', cursor: 'pointer' }}>&times;</button>
            </div>
          </Show>
          {/* File previews */}
          <Show when={files().length > 0}>
            <div style={{ padding: '6px 12px 0', 'border-top': '1px solid #1e1e1e', background: '#0a0e14', display: 'flex', gap: '8px', 'flex-wrap': 'wrap' }}>
              <For each={files()}>{(f, i) => (
                <div style={{ position: 'relative', background: '#1a1a2e', 'border-radius': '8px', padding: '4px', border: '1px solid #333' }}>
                  {f.isImage
                    ? <img src={f.dataUrl} style={{ height: '56px', 'max-width': '100px', 'border-radius': '6px', 'object-fit': 'cover', display: 'block' }} />
                    : <div style={{ padding: '4px 8px', 'font-size': '11px', color: '#999', 'max-width': '100px', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{f.name}</div>
                  }
                  <Show when={f.status !== 'draft'}>
                    <div style={{ 'font-size': '10px', color: f.status === 'failed' ? '#ff7b72' : '#8b949e', 'max-width': '120px', padding: '3px 4px' }}>
                      {fileStatusLabel(f)}
                    </div>
                  </Show>
                  <Show when={f.status === 'failed'}>
                    <div style={{ display: 'flex', gap: '4px', padding: '2px' }}>
                      <button onClick={() => uploadPendingFile(f).catch(() => {})} disabled={uploading()} style={{ 'font-size': '10px' }}>Retry</button>
                      <button onClick={() => downloadBlob(f.blob, f.name)} style={{ 'font-size': '10px' }}>Download</button>
                    </div>
                  </Show>
                  <button onClick={() => removeFile(i())} disabled={uploading()} aria-label={`Remove ${f.name}`} style={{ position: 'absolute', top: '-6px', right: '-6px', width: '22px', height: '22px', 'border-radius': '50%', background: '#d45555', color: '#fff', border: 'none', 'font-size': '12px', cursor: uploading() ? 'wait' : 'pointer', display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'line-height': '1' }}>&times;</button>
                </div>
              )}</For>
            </div>
          </Show>
          <Show when={voiceMemos().length > 0}>
            <div style={{ padding: '6px 12px', 'border-top': '1px solid #1e1e1e', background: '#0a0e14', display: 'flex', gap: '8px', 'flex-wrap': 'wrap' }}>
              <For each={voiceMemos()}>{memo => (
                <div style={{ background: '#1a1a2e', border: `1px solid ${memo.status === 'failed' ? '#6e3636' : '#333'}`, 'border-radius': '8px', padding: '7px 9px', 'font-size': '11px', color: '#bbb', 'max-width': '280px' }}>
                  <div>🎤 {voiceStatusLabel(memo)}</div>
                  <Show when={memo.status === 'failed'}>
                    <div style={{ display: 'flex', gap: '5px', 'margin-top': '5px' }}>
                      <Show when={isRetryableVoiceMemo(memo)}><button onClick={() => processVoiceMemo(memo)} disabled={transcribing()} style={{ 'font-size': '10px' }}>Retry</button></Show>
                      <button onClick={() => downloadBlob(memo.blob, memo.name)} style={{ 'font-size': '10px' }}>Download</button>
                      <button onClick={() => removeVoiceMemo(memo.id)} style={{ 'font-size': '10px' }}>Remove</button>
                    </div>
                  </Show>
                </div>
              )}</For>
            </div>
          </Show>
          <div style={{ padding: '8px 12px', 'padding-bottom': 'max(8px, env(safe-area-inset-bottom))', 'border-top': files().length ? 'none' : '1px solid #1e1e1e', background: '#0a0e14', display: 'flex', gap: '6px', 'align-items': 'flex-end', 'flex-shrink': '0', position: 'relative' }}>
            {/* Toolbar icons left of textarea */}
            <div style={{ display: 'flex', 'align-items': 'center', gap: '2px', 'flex-shrink': '0', height: '42px' }}>
              <button onClick={() => { if (composerReady()) fileInputRef?.click() }} disabled={!composerReady()} style={{ background: 'none', border: 'none', color: composerReady() ? '#666' : '#333', cursor: composerReady() ? 'pointer' : 'wait', padding: '6px', '-webkit-tap-highlight-color': 'transparent', display: 'flex', 'align-items': 'center', 'justify-content': 'center', width: '32px', height: '32px' }} title={composerReady() ? 'Attach file' : 'Loading chat…'}>
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="10" y1="4" x2="10" y2="16" /><line x1="4" y1="10" x2="16" y2="10" /></svg>
              </button>
              <Show when={currentId() && (starred()[currentId()!]?.length || 0) > 0}>
                <button onClick={jumpToNextStar} style={{ background: 'none', border: 'none', color: '#c4993a', cursor: 'pointer', padding: '6px', '-webkit-tap-highlight-color': 'transparent', display: 'flex', 'align-items': 'center', 'justify-content': 'center', gap: '2px', height: '32px' }} title="Jump to starred">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="#c4993a"><path d="M8 1l2.2 4.5 5 .7-3.6 3.5.9 5L8 12.4 3.5 14.7l.9-5L.8 6.2l5-.7z" /></svg>
                  <span style={{ 'font-size': '11px', 'font-weight': '600', color: '#c4993a' }}>{starred()[currentId()!]?.length}</span>
                </button>
              </Show>
              <button onClick={toggleVoice} disabled={transcribing() || !composerReady()} style={{ background: listening() ? 'rgba(212,85,85,0.15)' : 'none', border: 'none', 'border-radius': '8px', cursor: transcribing() || !composerReady() ? 'wait' : 'pointer', padding: '6px', '-webkit-tap-highlight-color': 'transparent', display: 'flex', 'align-items': 'center', 'justify-content': 'center', width: '32px', height: '32px', transition: 'color 0.15s' }} title={!composerReady() ? 'Loading chat…' : transcribing() ? 'Transcribing...' : listening() ? 'Stop & transcribe' : 'Record voice memo (max 25 MB)'} aria-label={!composerReady() ? 'Loading chat' : transcribing() ? 'Transcribing...' : listening() ? 'Stop & transcribe' : 'Record voice memo (max 25 MB)'}>
                <svg width="14" height="18" viewBox="0 0 14 18" fill="none" stroke={listening() ? '#d45555' : '#666'} stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="1" width="6" height="9" rx="3" fill={listening() ? 'rgba(212,85,85,0.2)' : 'none'} /><path d="M1 7.5a6 6 0 0 0 12 0" /><line x1="7" y1="13.5" x2="7" y2="16" /><line x1="4.5" y1="16" x2="9.5" y2="16" /></svg>
              </button>
            </div>
            {/* Textarea */}
            <div style={{ flex: '1', position: 'relative', 'min-width': '0', display: 'flex', 'flex-direction': 'column', 'justify-content': 'flex-end' }}>
              <textarea ref={textareaRef} value={text()}
                disabled={!composerReady()}
                onInput={(e) => { const value = e.target.value; setText(value); if (currentId()) saveDraft(currentId()!, value); e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px' }}
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
                placeholder={composerReady() ? 'Send a message...' : chatLoadError() ? 'Chat unavailable' : 'Loading chat…'} rows={1}
                style={{ width: '100%', background: '#1a1a2e', border: '1px solid #333', 'border-radius': '12px', padding: '10px 14px', color: '#e5e5e5', opacity: composerReady() ? '1' : '0.65', 'font-size': '16px', 'font-family': 'inherit', resize: 'none', outline: 'none', 'line-height': '1.4', 'max-height': '120px', '-webkit-appearance': 'none', 'box-sizing': 'border-box', overflow: 'auto', 'scrollbar-width': 'none' }} />
              <Show when={text().length > 0}>
                <div style={{ position: 'absolute', right: '8px', bottom: '2px', 'font-size': '10px', color: text().length >= 500 ? '#fab283' : '#555', 'line-height': '1', 'pointer-events': 'none' }}>
                  {text().length >= 1000 ? (text().length / 1000).toFixed(1) + 'k' : text().length}
                </div>
              </Show>
            </div>
            {/* Send button (hidden on mobile, keyboard has its own) */}
            <Show when={!isMobile}>
              <div style={{ 'flex-shrink': '0', height: '42px', display: 'flex', 'align-items': 'center' }}>
                <button onClick={handleSend} disabled={uploading() || transcribing() || !composerReady()} title={!composerReady() ? 'Loading chat…' : listening() ? 'Stop, transcribe & send' : 'Send'} style={{ background: composerReady() && (text().trim() || files().length || listening()) ? '#4aba6a' : '#333', color: composerReady() && (text().trim() || files().length || listening()) ? '#000' : '#666', border: 'none', 'border-radius': '50%', padding: '0', width: '36px', height: '36px', cursor: composerReady() && (text().trim() || files().length || listening()) ? 'pointer' : composerReady() ? 'default' : 'wait', '-webkit-tap-highlight-color': 'transparent', display: 'flex', 'align-items': 'center', 'justify-content': 'center' }}>{uploading() || transcribing() ? '...' : <svg width="14" height="16" viewBox="0 0 14 16" fill="currentColor"><polygon points="0,0 14,8 0,16" /></svg>}</button>
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
