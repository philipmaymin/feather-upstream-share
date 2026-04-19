const BASE = location.pathname.replace(/\/+$/, '')

export interface SessionMeta {
  id: string
  title: string
  updatedAt: string
  isActive: boolean
  projectId?: string
  projectLabel?: string | null
  cwd?: string | null
}

export interface Project {
  id: string
  label: string
  cwd?: string | null
}

export interface ContentBlock {
  type: string
  text?: string
  thinking?: string
  name?: string
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

export async function fetchSessions(project?: string | null): Promise<SessionMeta[]> {
  const params = new URLSearchParams()
  if (project) params.set('project', project)
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

export async function fetchMessages(id: string, before = 0): Promise<{ messages: Message[], hasMore: boolean }> {
  const url = before > 0
    ? `${BASE}/api/sessions/${id}/messages?before=${before}`
    : `${BASE}/api/sessions/${id}/messages`
  const r = await fetch(url)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return await r.json()
}

export const sendInput = (id: string, text: string): Promise<{ ok: boolean, sentAt: string }> =>
  fetch(`${BASE}/api/sessions/${id}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
    .then(r => r.json())

export async function createSession(cwd?: string): Promise<string> {
  const id = crypto.randomUUID()
  await fetch(`${BASE}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, cwd }) })
  return id
}

export const resumeSession = (id: string, cwd?: string) =>
  fetch(`${BASE}/api/sessions/${id}/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd }) })

export const interruptSession = (id: string) =>
  fetch(`${BASE}/api/sessions/${id}/interrupt`, { method: 'POST' })

export async function uploadFile(blob: Blob, name: string): Promise<string> {
  const r = await fetch(`${BASE}/api/upload`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(name) },
    body: blob,
  })
  const { path } = await r.json()
  return path
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
