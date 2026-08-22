import { appBasePath } from './lib/appPath.js'

const BASE = appBasePath()

async function responseJson<T = any>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status })
  return data as T
}

export interface SessionMeta {
  id: string
  title: string
  updatedAt: string
  isActive: boolean
  projectId?: string | null
  projectLabel?: string | null
  cwd?: string | null
  agent?: 'claude' | 'codex' | 'omp'
  outcome?: 'finished' | 'errored' | null
  summary?: string | null
  roomAssigned?: boolean
}

export interface AgentInfo {
  id: 'claude' | 'codex' | 'omp'
  label: string
  available: boolean
}

export const fetchAgents = (): Promise<{ agents: AgentInfo[] }> =>
  fetch(`${BASE}/api/agents`).then(r => r.json())

export interface Project {
  id: string
  label: string
  cwd?: string | null
}

export interface RoomInfo {
  name: string
  cwd: string
  sessions: SessionMeta[]
  active: boolean
  latest: { role: string; text: string } | null
  updatedAt: string | null
}

const ROOMS_SNAPSHOT_KEY = 'feather-rooms-snapshot-v1'
let roomsSnapshot: RoomInfo[] | null = null
let roomsRequest: Promise<RoomInfo[]> | null = null
let roomsFetchedAt = 0

export function cachedRoomsSnapshot(): RoomInfo[] | null {
  if (roomsSnapshot) return roomsSnapshot
  if (typeof sessionStorage === 'undefined') return null
  try {
    const stored = JSON.parse(sessionStorage.getItem(ROOMS_SNAPSHOT_KEY) || 'null')
    if (Array.isArray(stored)) roomsSnapshot = stored
  } catch {}
  return roomsSnapshot
}

export async function fetchRooms(maxAgeMs = 0): Promise<RoomInfo[]> {
  // The app shell and RoomsHome both warm this endpoint during startup. Share
  // that request so the home view does not add a second network round trip.
  if (roomsSnapshot && Date.now() - roomsFetchedAt < maxAgeMs) return roomsSnapshot
  if (roomsRequest) return roomsRequest
  roomsRequest = (async () => {
    const response = await fetch(`${BASE}/api/rooms`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const rooms = (await response.json()).rooms as RoomInfo[]
    roomsSnapshot = rooms
    roomsFetchedAt = Date.now()
    try { sessionStorage.setItem(ROOMS_SNAPSHOT_KEY, JSON.stringify(rooms)) } catch {}
    return rooms
  })()
  try { return await roomsRequest }
  finally { roomsRequest = null }
}

export async function createRoom(name: string): Promise<{ name: string; cwd: string }> {
  const response = await fetch(`${BASE}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  return responseJson(response)
}

export const assignSessionToRoom = async (room: string, sessionId: string, remove = false) => {
  const response = await fetch(`${BASE}/api/rooms/${encodeURIComponent(room)}/assign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, remove }),
  })
  return responseJson<{ ok: true, assignments: Record<string, string> }>(response)
}

export interface ContentBlock {
  type: string
  text?: string
  thinking?: string
  name?: string
  id?: string
  tool_use_id?: string
  input?: any
  content?: any
  is_error?: boolean
}

export interface Message {
  uuid: string
  role: 'user' | 'assistant'
  timestamp: string
  content: ContentBlock[]
  delivery?: 'sent' | 'delivered'
  stopReason?: string
  cwd?: string
  model?: string
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
  version?: string
  gitBranch?: string
  internal?: boolean
}

export async function fetchSessions(project?: string | null, query?: string, limit?: number): Promise<SessionMeta[]> {
  const params = new URLSearchParams()
  if (project) params.set('project', project)
  if (query) params.set('q', query)
  if (limit) params.set('limit', String(limit))
  const qs = params.toString()
  const r = await fetch(`${BASE}/api/sessions${qs ? '?' + qs : ''}`)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return (await r.json()).sessions
}

export async function fetchProjects(): Promise<Project[]> {
  const r = await fetch(`${BASE}/api/projects`)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return (await r.json()).projects
}

export async function deletePath(path: string): Promise<void> {
  const r = await fetch(`${BASE}/api/files/delete?path=${encodeURIComponent(path)}`, { method: 'DELETE' })
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`)
}

export async function fetchMessages(id: string, before = 0): Promise<{ messages: Message[], hasMore: boolean }> {
  const url = before > 0
    ? `${BASE}/api/sessions/${id}/messages?before=${before}`
    : `${BASE}/api/sessions/${id}/messages`
  const r = await fetch(url)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return await r.json()
}

export async function sendInput(id: string, text: string, messageId?: string): Promise<{ ok: boolean, sentAt: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (messageId) headers['X-Feather-Message-ID'] = messageId
  const r = await fetch(`${BASE}/api/sessions/${id}/send`, { method: 'POST', headers, body: JSON.stringify({ text }) })
  const data = await responseJson<{ ok?: boolean, sentAt: string, error?: string }>(r)
  if (data.ok !== true) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { status: r.status })
  return data
}

export async function createSession(cwd?: string, agent?: 'claude' | 'codex' | 'omp'): Promise<string> {
  const id = crypto.randomUUID()
  const response = await fetch(`${BASE}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, cwd, agent }) })
  await responseJson(response)
  return id
}

export const resumeSession = (id: string, cwd?: string) =>
  fetch(`${BASE}/api/sessions/${id}/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd }) })

export const interruptSession = (id: string) =>
  fetch(`${BASE}/api/sessions/${id}/interrupt`, { method: 'POST' })

export async function uploadFileWithId(blob: Blob, name: string, uploadId: string, signal?: AbortSignal): Promise<string> {
  const r = await fetch(`${BASE}/api/upload`, {
    method: 'POST', signal,
    headers: {
      'Content-Type': blob.type || 'application/octet-stream',
      'X-Filename': encodeURIComponent(name),
      'X-Upload-ID': uploadId,
    },
    body: blob,
  })
  const data = await responseJson<{ path?: string }>(r)
  if (typeof data.path !== 'string' || !data.path.startsWith('/')) throw new Error('Upload response did not include a valid path')
  return data.path
}

export async function transcribeAudio(blob: Blob, signal?: AbortSignal): Promise<string> {
  const r = await fetch(`${BASE}/api/transcribe`, {
    method: 'POST', signal,
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
  })
  const data = await responseJson<{ transcript?: string }>(r)
  if (typeof data.transcript !== 'string') throw new Error('Transcription response did not include text')
  if (!data.transcript.trim()) throw new Error('No speech was detected')
  return data.transcript.trim()
}

export const deleteSession = (id: string) =>
  fetch(`${BASE}/api/sessions/${id}/delete`, { method: 'POST' }).then(r => r.json())

export const renameSession = (id: string, title: string) =>
  fetch(`${BASE}/api/sessions/${id}/rename`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) }).then(r => r.json())

export const forkSession = (id: string, cwd?: string) =>
  fetch(`${BASE}/api/sessions/${id}/fork`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd }) }).then(r => r.json())

export const fetchStarred = (): Promise<Record<string, string[]>> =>
  fetch(`${BASE}/api/starred`).then(r => r.json())

export const saveStarred = (data: Record<string, string[]>) =>
  fetch(`${BASE}/api/starred`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(r => r.json())

export const exportUrl = (id: string) => `${BASE}/api/sessions/${id}/export`

export interface SearchResult {
  id: string
  title: string
  snippet: string
  matchCount: number
  updatedAt: string
  isActive: boolean
  projectId?: string
  projectLabel?: string | null
  cwd?: string | null
}

export async function searchSessions(query: string, project?: string | null): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query })
  if (project) params.set('project', project)
  const r = await fetch(`${BASE}/api/search?${params}`)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return (await r.json()).results
}

export async function checkAuth(): Promise<{ username: string; admin: boolean } | null> {
  try {
    const r = await fetch(`${BASE}/api/me`)
    if (!r.ok) return null
    return await r.json()
  } catch { return null }
}

export async function login(username: string, password: string): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  return await r.json()
}

export async function logout(): Promise<void> {
  await fetch(`${BASE}/api/logout`, { method: 'POST' })
}

export interface QuestionData {
  type: 'selector' | 'yesno' | 'numbered' | 'text'
  question: string
  options?: string[]
  selectedIndex?: number
}

export const answerQuestion = (id: string, body: { type: string; index?: number; text?: string }) =>
  fetch(`${BASE}/api/sessions/${id}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json())

// ── Rooms (upstream Sidecar) ───────────────────────────────────────

export interface SidecarMessage {
  ts: number
  seq: number
  from: string
  to: string
  text: string
}

export interface SidecarMember {
  sessionId: string
  role: string
  spawned?: boolean
}

export interface SidecarGroup {
  id: string
  members: SidecarMember[]
  agent: string
  task: string
  status: 'active' | 'done'
  createdAt: number
}

async function sidecarJson<T>(request: Promise<Response>): Promise<T> {
  const response = await request
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
  return body as T
}

export const fetchSidecars = (): Promise<{ groups: SidecarGroup[] }> =>
  sidecarJson(fetch(`${BASE}/api/sidecar`))

export const fetchSidecar = (id: string): Promise<{ group: SidecarGroup; thread: SidecarMessage[] }> =>
  sidecarJson(fetch(`${BASE}/api/sidecar/${id}`))

export const createSidecar = (
  driverSessionId: string,
  opts: { agent?: string; task?: string; cwd?: string; driverRole?: string; peerRole?: string } = {},
): Promise<{ group: SidecarGroup; peerSessionId: string; peers: Array<{ role: string; sessionId: string }> }> =>
  sidecarJson(fetch(`${BASE}/api/sidecar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ driverSessionId, ...opts }),
  }))

export const postSidecar = (id: string, to: string, text: string, from = 'driver') =>
  sidecarJson<{ ok: boolean; group: string; seq: number }>(fetch(`${BASE}/api/sidecar/${id}/post`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, text }),
  }))

export const deleteSidecar = (id: string) =>
  sidecarJson<{ ok: boolean }>(fetch(`${BASE}/api/sidecar/${id}/delete`, { method: 'POST' }))

export const addSidecarPeer = (id: string, role: string, opts: { agent?: string; task?: string } = {}) =>
  sidecarJson<{ ok: boolean; role: string; sessionId: string }>(fetch(`${BASE}/api/sidecar/${id}/peers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, ...opts }),
  }))

export const removeSidecarPeer = (id: string, role: string) =>
  sidecarJson<{ ok: boolean }>(fetch(`${BASE}/api/sidecar/${id}/peers/${encodeURIComponent(role)}/delete`, { method: 'POST' }))

export function subscribeSidecar(id: string, onMessage: (message: SidecarMessage) => void): () => void {
  let source: EventSource | null = new EventSource(`${BASE}/api/sidecar/${id}/stream`)
  source.addEventListener('message', (event) => {
    try { onMessage(JSON.parse(event.data)) } catch {}
  })
  return () => { source?.close(); source = null }
}

export function subscribeMessages(
  id: string,
  onMessage: (msg: Message) => void,
  onStatus?: (status: 'connected' | 'reconnecting') => void,
  onActivity?: (activity: string | null) => void,
  onQuestion?: (question: QuestionData | null) => void,
): () => void {
  let es: EventSource | null = null
  let closed = false
  let retries = 0
  let lastEventId = ''

  function connect() {
    if (closed) return
    const url = lastEventId
      ? `${BASE}/api/sessions/${id}/stream?lastEventId=${lastEventId}`
      : `${BASE}/api/sessions/${id}/stream`
    es = new EventSource(url)

    es.addEventListener('connected', () => {
      retries = 0
      onStatus?.('connected')
      // On reconnect, check if last message has stopReason (Claude finished while disconnected)
      if (lastEventId) {
        fetch(`${BASE}/api/sessions/${id}/messages`)
          .then(r => r.ok ? r.json() : null)
          .then(data => {
            if (!data?.messages?.length) return
            const last = data.messages[data.messages.length - 1]
            if (last.stopReason) onMessage(last) // Re-emit so working state clears
          })
          .catch(() => {})
      }
    })
    es.addEventListener('message', (e) => {
      if (e.lastEventId) lastEventId = e.lastEventId
      try { onMessage(JSON.parse(e.data)) } catch {}
    })
    es.addEventListener('activity', (e) => {
      try { onActivity?.(JSON.parse(e.data).activity) } catch {}
    })
    es.addEventListener('question', (e) => {
      try { onQuestion?.(JSON.parse(e.data).question) } catch {}
    })
    es.onerror = () => {
      es?.close(); es = null
      if (closed) return
      retries++
      onStatus?.('reconnecting')
      setTimeout(connect, Math.min(1000 * 2 ** Math.min(retries - 1, 5), 30000))
    }
  }

  connect()
  return () => { closed = true; es?.close(); es = null }
}
