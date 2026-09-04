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
  default?: boolean
}

export const fetchAgents = (): Promise<{ agents: AgentInfo[] }> =>
  fetch(`${BASE}/api/agents`).then(r => r.json())

export interface Project {
  id: string
  label: string
  cwd?: string | null
}

export interface RoomResident {
  role: string
  sessionId: string
  agent: string
  title: string
  status: 'working' | 'waiting' | 'offline'
}

export interface RoomInfo {
  name: string
  cwd: string
  sessions: SessionMeta[]
  leaderSessionId: string | null
  residents: RoomResident[]
  sidecarGroupId: string | null
  active: boolean
  latest: { role: string; text: string } | null
  updatedAt: string | null
  updates: { count: number; latestAt: string | null; latest: string | null }
  friction: { count: number; latestAt: string | null; latest: string | null }
  pulse: {
    enabled: boolean
    status: 'waiting' | 'working' | 'paused' | 'error'
    lastRunAt: string | null
    nextRunAt: string | null
    sessionId: string | null
    error?: string | null
  }
}

const ROOMS_SNAPSHOT_KEY = 'feather-rooms-snapshot-v1'
let roomsSnapshot: RoomInfo[] | null = null
let roomsRequest: Promise<RoomInfo[]> | null = null
let roomsFetchedAt = 0

function normalizeRoom(room: RoomInfo): RoomInfo {
  const pulse = room.pulse || {
    enabled: true, status: 'waiting' as const, lastRunAt: null,
    nextRunAt: null, sessionId: null, error: null,
  }
  const sessions = Array.isArray(room.sessions) ? room.sessions : []
  const pulseWasNewest = sessions[0]
    && (sessions[0].id === pulse.sessionId || /^(Keep working|Status): #/.test(sessions[0].title || ''))
  const userSessions = sessions.filter(session =>
    session.id !== pulse.sessionId && !/^(Keep working|Status): #/.test(session.title || ''))
  return {
    ...room,
    leaderSessionId: room.leaderSessionId || null,
    residents: Array.isArray(room.residents) ? room.residents : [],
    sidecarGroupId: room.sidecarGroupId || null,
    sessions,
    active: userSessions.some(session => session.isActive),
    latest: pulseWasNewest ? null : room.latest,
    updatedAt: pulseWasNewest ? (userSessions[0]?.updatedAt || room.updates?.latestAt || null) : room.updatedAt,
    updates: room.updates || { count: 0, latestAt: null, latest: null },
    friction: room.friction || { count: 0, latestAt: null, latest: null },
    pulse,
  }
}

export function cachedRoomsSnapshot(): RoomInfo[] | null {
  if (roomsSnapshot) return roomsSnapshot
  if (typeof sessionStorage === 'undefined') return null
  try {
    const stored = JSON.parse(sessionStorage.getItem(ROOMS_SNAPSHOT_KEY) || 'null')
    if (Array.isArray(stored)) roomsSnapshot = stored.map(normalizeRoom)
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
    const rooms = ((await response.json()).rooms as RoomInfo[]).map(normalizeRoom)
    roomsSnapshot = rooms
    roomsFetchedAt = Date.now()
    try { sessionStorage.setItem(ROOMS_SNAPSHOT_KEY, JSON.stringify(rooms)) } catch {}
    return rooms
  })()
  try { return await roomsRequest }
  finally { roomsRequest = null }
}
export interface RoomSessionContext {
  room: string | null
  kind: 'main' | 'resident' | 'status' | 'chat' | null
  role: string | null
  label: string | null
  forkOf: string | null
  forkSourceTitle: string | null
  workspaceMode: 'isolated' | 'shared' | null
  forkBranch: string | null
}

export async function fetchSessionRoomContext(sessionId: string): Promise<RoomSessionContext> {
  const response = await fetch(`${BASE}/api/sessions/${encodeURIComponent(sessionId)}/room`)
  return responseJson<RoomSessionContext>(response)
}

export async function fetchSessionRoom(sessionId: string): Promise<string | null> {
  return (await fetchSessionRoomContext(sessionId)).room
}


export interface RoomWikiPageMeta {
  name: string
  size: number
  updatedAt: string
}

export interface RoomWikiPage {
  name: string
  content: string
  updatedAt: string
}

export async function fetchRoomWiki(room: string): Promise<RoomWikiPageMeta[]> {
  const response = await fetch(`${BASE}/api/rooms/${encodeURIComponent(room)}/wiki`)
  return (await responseJson<{ pages: RoomWikiPageMeta[] }>(response)).pages
}

export async function fetchRoomWikiPage(room: string, page: string): Promise<RoomWikiPage> {
  const response = await fetch(`${BASE}/api/rooms/${encodeURIComponent(room)}/wiki/page?name=${encodeURIComponent(page)}`)
  return responseJson<RoomWikiPage>(response)
}

export interface ChannelPrincipal {
  id: string
  kind: 'human' | 'agent' | 'service'
  username: string
  displayName: string
  avatarSeed: string
  agentBackend?: string | null
  createdAt: string
  role?: 'owner' | 'member' | 'agent'
  notificationLevel?: 'all' | 'mentions' | 'mute'
}

export interface WorkspaceStaffing {
  status: 'ready' | 'failed'
  agents: Array<{ id?: string; sessionId?: string; username?: string; displayName?: string; role?: string; agent?: string }>
  error?: string
  dispatched?: boolean
}

export interface ChannelInfo {
  id: string
  slug: string | null
  title: string
  description: string
  type: 'channel' | 'dm'
  defaultAgentId: string | null
  createdAt: string
  archivedAt: string | null
  unread: number
  members: ChannelPrincipal[]
}

export interface ChannelDelivery {
  queuedAgents: Array<Pick<ChannelPrincipal, 'id' | 'username' | 'displayName'>>
  activeAgents: Array<Pick<ChannelPrincipal, 'id' | 'username' | 'displayName'>>
  queuedCount: number
  activeCount: number
}

export interface ChannelMessage {
  id: string
  channelId: string
  seq: number
  threadRootId: string
  replyToId: string | null
  messageType: 'human' | 'agent' | 'system' | 'progress'
  content: string
  createdAt: string
  editedAt: string | null
  author: ChannelPrincipal
  metadata: Record<string, unknown>
  thread?: {
    title: string
    state: 'open' | 'working' | 'needs_you' | 'resolved'
    replyCount: number
    updatedAt: string
    unread: boolean
    following: boolean
    doneAt: string | null
    snoozedUntil: string | null
    delivery: ChannelDelivery
    recovery: Pick<ChannelExecution, 'id' | 'state' | 'error' | 'agent' | 'canRestart'> | null
  }
  replies?: ChannelMessage[]
}

export interface ChannelExecution {
  id: string
  state: 'queued' | 'running' | 'done' | 'error' | 'killed'
  agent: Pick<ChannelPrincipal, 'id' | 'username' | 'displayName'>
  triggerMessageId: string
  finalMessageId: string | null
  depth: number
  startedAt: string
  completedAt: string | null
  error: string | null
  canRestart: boolean
}

export interface ChannelExecutionPeek {
  execution: Pick<ChannelExecution, 'id' | 'state' | 'agent' | 'startedAt' | 'completedAt'>
  activity: string
  steps: Array<{ id: string; tool: string; intent: string | null; status: 'working' | 'completed' | 'failed' }>
  updatedAt: string | null
  processActive: boolean
  stalled: boolean
  stalledReason: string | null
  canRestart: boolean
}

export interface ChannelThread {
  id: string
  channelId: string
  title: string
  state: 'open' | 'working' | 'needs_you' | 'resolved'
  lastReadSeq: number
  following: boolean
  doneAt: string | null
  snoozedUntil: string | null
  delivery: ChannelDelivery
  messages: ChannelMessage[]
  executions: ChannelExecution[]
}

export interface ChannelActivityItem {
  id: string
  kind: string
  reason: string
  createdAt: string
  readAt: string | null
  doneAt: string | null
  channel: Pick<ChannelInfo, 'id' | 'slug' | 'title'>
  thread: Pick<ChannelThread, 'id' | 'title' | 'state'> | null
  messageId: string | null
  preview: string
  actor: Pick<ChannelPrincipal, 'id' | 'kind' | 'username' | 'displayName'> | null
  updates?: number
}

export async function fetchChannels(): Promise<{ channels: ChannelInfo[]; dms: ChannelInfo[]; principal: ChannelPrincipal }> {
  return responseJson(await fetch(`${BASE}/api/channels`))
}

export async function fetchChannelMessages(channelId: string): Promise<ChannelMessage[]> {
  const data = await responseJson<{ messages: ChannelMessage[] }>(await fetch(`${BASE}/api/channels/${encodeURIComponent(channelId)}/messages`))
  return data.messages
}

export async function fetchChannelThread(channelId: string, rootId: string): Promise<ChannelThread> {
  const data = await responseJson<{ thread: ChannelThread }>(await fetch(`${BASE}/api/channels/${encodeURIComponent(channelId)}/threads/${encodeURIComponent(rootId)}`))
  return data.thread
}

export async function fetchChannelActivity(): Promise<{ items: ChannelActivityItem[]; unread: number; needsYou: number }> {
  return responseJson(await fetch(`${BASE}/api/channels/activity`))
}

export async function fetchChannelPrincipals(): Promise<ChannelPrincipal[]> {
  const data = await responseJson<{ principals: ChannelPrincipal[] }>(await fetch(`${BASE}/api/channels/principals`))
  return data.principals
}

export interface ChannelAttachment {
  id: string
  filename: string
  contentType: string
  byteSize: number
  url: string
}

export async function uploadChannelImage(channelId: string, file: File, uploadId: string): Promise<ChannelAttachment> {
  const response = await fetch(`${BASE}/api/channels/${encodeURIComponent(channelId)}/attachments`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type,
      'X-Filename': encodeURIComponent(file.name || 'pasted-image'),
      'X-Upload-ID': uploadId,
    },
    body: file,
  })
  const data = await responseJson<{ attachment: ChannelAttachment }>(response)
  return {
    ...data.attachment,
    url: `${BASE}/api/channels/${encodeURIComponent(channelId)}/attachments/${encodeURIComponent(data.attachment.id)}`,
  }
}

export async function createChannel(input: { slug: string; title: string; description?: string }): Promise<{ channel: ChannelInfo; staffing: WorkspaceStaffing }> {
  return responseJson<{ channel: ChannelInfo; staffing: WorkspaceStaffing }>(await fetch(`${BASE}/api/channels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify(input),
  }))
}

export async function bootstrapFilms7(): Promise<ChannelInfo> {
  const data = await responseJson<{ channel: ChannelInfo }>(await fetch(`${BASE}/api/channels/bootstrap-films7`, { method: 'POST' }))
  return data.channel
}

export async function addChannelMember(channelId: string, username: string): Promise<ChannelPrincipal> {
  const data = await responseJson<{ member: { principal: ChannelPrincipal } }>(await fetch(`${BASE}/api/channels/${encodeURIComponent(channelId)}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  }))
  return data.member.principal
}

export async function postChannelMessage(channelId: string, content: string, threadRootId?: string, replyToId?: string): Promise<ChannelMessage> {
  const data = await responseJson<{ message: ChannelMessage }>(await fetch(`${BASE}/api/channels/${encodeURIComponent(channelId)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ content, threadRootId, replyToId }),
  }))
  return data.message
}

export async function updateChannelThread(channelId: string, rootId: string, patch: { title?: string; state?: ChannelThread['state'] }): Promise<ChannelThread> {
  const data = await responseJson<{ thread: ChannelThread }>(await fetch(`${BASE}/api/channels/${encodeURIComponent(channelId)}/threads/${encodeURIComponent(rootId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }))
  return data.thread
}

export async function updateChannelAttention(channelId: string, rootId: string, action: 'read' | 'follow' | 'done' | 'snooze', value = true, until?: string | null): Promise<ChannelThread> {
  const data = await responseJson<{ thread: ChannelThread }>(await fetch(`${BASE}/api/channels/${encodeURIComponent(channelId)}/threads/${encodeURIComponent(rootId)}/attention`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, value, until }),
  }))
  return data.thread
}

export async function createChannelDm(principalId: string): Promise<ChannelInfo> {
  const data = await responseJson<{ channel: ChannelInfo }>(await fetch(`${BASE}/api/channels/dms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ principalId }),
  }))
  return data.channel
}

export async function fetchChannelExecutionPeek(executionId: string): Promise<ChannelExecutionPeek> {
  return responseJson(await fetch(`${BASE}/api/channels/executions/${encodeURIComponent(executionId)}/peek`))
}

export async function restartChannelExecution(executionId: string): Promise<void> {
  await responseJson(await fetch(`${BASE}/api/channels/executions/${encodeURIComponent(executionId)}/restart`, { method: 'POST' }))
}

export async function cancelChannelExecution(executionId: string): Promise<void> {
  await responseJson(await fetch(`${BASE}/api/channels/executions/${encodeURIComponent(executionId)}/cancel`, { method: 'POST' }))
}

export function subscribeChannels(onChange: (event: { channelId: string | null; type: string }) => void): () => void {
  const source = new EventSource(`${BASE}/api/channels/stream`)
  for (const type of ['message', 'thread', 'attention', 'channel', 'execution']) {
    source.addEventListener(type, event => {
      try {
        const data = JSON.parse((event as MessageEvent).data)
        onChange({ channelId: data.channelId || null, type })
      } catch {}
    })
  }
  return () => source.close()
}


export interface RoomUpdate { id: string | null; ts: string | null; title?: string; text: string }

export interface FrictionComplaint {
  id: string
  timestamp: string
  source: string
  summary: string
  evidence: string | null
}

export async function fetchRoomUpdates(room: string): Promise<RoomUpdate[]> {
  const response = await fetch(`${BASE}/api/rooms/${encodeURIComponent(room)}/updates`)
  return (await responseJson<{ updates: RoomUpdate[] }>(response)).updates
}

export async function fetchRoomFriction(room: string): Promise<FrictionComplaint[]> {
  const response = await fetch(`${BASE}/api/rooms/${encodeURIComponent(room)}/friction`)
  return (await responseJson<{ complaints: FrictionComplaint[] }>(response)).complaints
}

export async function createRoom(name: string): Promise<{ name: string; cwd: string; staffing: WorkspaceStaffing }> {
  const response = await fetch(`${BASE}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  return responseJson(response)
}

export async function renameRoom(room: string, name: string): Promise<{ ok: true; name: string; cwd: string }> {
  const response = await fetch(`${BASE}/api/rooms/${encodeURIComponent(room)}/rename`, {
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

export async function setRoomPulse(room: string, enabled: boolean): Promise<RoomInfo['pulse']> {
  const response = await fetch(`${BASE}/api/rooms/${encodeURIComponent(room)}/pulse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  return (await responseJson<{ ok: true, pulse: RoomInfo['pulse'] }>(response)).pulse
}

export interface ContentBlock {
  type: string
  text?: string
  thinking?: string
  name?: string
  intent?: string
  id?: string
  tool_use_id?: string
  input?: any
  content?: any
  details?: unknown
  is_error?: boolean
  toolCallId?: string
  toolName?: string
  args?: unknown
  partialResult?: unknown
  result?: unknown
  isError?: boolean
  subagentId?: string
}

export interface Message {
  uuid: string
  role: 'user' | 'assistant'
  timestamp: string
  content: ContentBlock[]
  delivery?: 'queued' | 'sent' | 'delivered'
  passive?: boolean
  stopReason?: string
  cwd?: string
  model?: string
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
  version?: string
  gitBranch?: string
  internal?: boolean
}

export type ProtocolRunStatus =
  | 'starting'
  | 'start_failed'
  | 'pending'
  | 'running'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export type ProtocolSeatStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled'
export type ProtocolStageStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'

export interface ProtocolRanking {
  seatId: string
  rationale: string
}

export interface ProtocolDisagreement {
  summary: string
  evidenceIds: string[]
}

export interface ProtocolVerdict {
  ranking: ProtocolRanking[]
  recommendation: string
  disagreements: ProtocolDisagreement[]
  confidence: 'low' | 'medium' | 'high'
  citedEvidenceIds: string[]
}

export interface ProtocolSeatSnapshot {
  seatId: string
  stageId: 'candidates' | 'judge'
  attempt: number
  role: string
  status: ProtocolSeatStatus
  evidenceIds?: string[]
  ompChildId?: string
  reason?: string
  startedAt?: string
  finishedAt?: string
}

export interface ProtocolAttemptSnapshot {
  attempt: number
  status: ProtocolStageStatus
  seats: ProtocolSeatSnapshot[]
  reason?: string
}

export interface ProtocolStageSnapshot {
  stageId: 'candidates' | 'judge'
  status: ProtocolStageStatus
  attempts: ProtocolAttemptSnapshot[]
  reason?: string
}

export interface ProtocolEvidenceSnapshot {
  evidenceId: string
  kind: 'candidate_answer' | 'judge_verdict'
  stageId: 'candidates' | 'judge'
  seatId: string
  attempt: number
  content: string | ProtocolVerdict
  artifactReferences?: string[]
}

export interface ProtocolRunSnapshot {
  schemaVersion: 1
  sessionId: string
  runId: string
  protocol: 'advisory'
  status: ProtocolRunStatus
  lastSeq: number
  invocationMessageId: string
  actionId: string
  question: string
  candidateCount: number
  roles: Array<{ seatId: string; role: string }>
  roleMode: 'diverse' | 'neutral'
  timeoutMs: number
  rubric?: string
  sourceRunId?: string
  ownerExecutionId?: string
  createdAt: string
  updatedAt?: string
  startedAt?: string
  finishedAt?: string
  stages: ProtocolStageSnapshot[]
  seats: ProtocolSeatSnapshot[]
  evidence: ProtocolEvidenceSnapshot[]
  verdict: ProtocolVerdict | null
  verdictEvidenceId?: string | null
  verdictRecordedAt?: string
  cancelActionId?: string
  reason?: string
  error?: string
}

export type FeedMode = 'for-you' | 'latest' | 'needs-me'

export type FeedReaction = 'like' | 'less'
export type FeedDelivery = 'queued' | 'delivered' | 'failed'

export interface FeedCommentReply {
  text: string
  timestamp: string
}

export interface FeedComment {
  id: string
  text: string
  createdAt: string
  delivery: 'queued' | 'delivered' | 'failed'
  reply?: FeedCommentReply
}

export interface FeedPost {
  id: string
  kind: 'session' | 'room-update'
  timestamp: string
  sessionId: string | null
  room: string | null
  projectId: string | null
  projectLabel: string | null
  title: string
  agent: 'claude' | 'codex' | 'omp' | null
  status: 'waiting' | 'working' | 'errored' | 'finished'
  importance?: 'feature' | 'standard' | 'note'
  media?: { kind: 'image' | 'video'; path: string; name: string }
  question?: string
  activity?: string
  message?: Message
  updateText?: string
  score: number
  why: string
  reaction?: FeedReaction | null
  reactionDelivery?: FeedDelivery | null
  comments?: FeedComment[]
}

export interface FeedResponse {
  generatedAt: string
  nextBefore: string | null
  counts: { waiting: number; working: number; errored: number; finished: number; important?: number; notes?: number }
  posts: FeedPost[]
}

export async function fetchFeed(mode: FeedMode, limit = 20, before?: string, signal?: AbortSignal): Promise<FeedResponse> {
  const params = new URLSearchParams({ mode, limit: String(limit) })
  if (before) params.set('before', before)
  const response = await fetch(`${BASE}/api/feed?${params}`, { signal })
  return responseJson<FeedResponse>(response)
}

export async function setFeedReaction(postId: string, reaction: FeedReaction | null): Promise<{ reaction: FeedReaction | null; reactionDelivery: FeedDelivery | null; changed: boolean; delivery: 'delivered' | 'failed' | 'not-needed' }> {
  const response = await fetch(`${BASE}/api/feed/${encodeURIComponent(postId)}/reaction`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reaction }),
  })
  return responseJson(response)
}

export async function postFeedComment(postId: string, id: string, text: string): Promise<{ comment: FeedComment }> {
  const response = await fetch(`${BASE}/api/feed/${encodeURIComponent(postId)}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, text }),
  })
  return responseJson(response)
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

const MESSAGE_PAGE_SIZE = 100
const INITIAL_MESSAGE_LIMIT = 80

export interface MessagePage {
  messages: Message[]
  hasMore: boolean
  cursor: number
  nextBefore: number
}

async function fetchMessagePage(id: string, before: number, signal?: AbortSignal, limit = MESSAGE_PAGE_SIZE): Promise<MessagePage> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (before > 0) params.set('before', String(before))
  const response = await fetch(`${BASE}/api/sessions/${id}/messages?${params}`, { signal })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const page = await response.json()
  return {
    messages: Array.isArray(page.messages) ? page.messages : [],
    hasMore: !!page.hasMore,
    cursor: Number.isSafeInteger(page.cursor) && page.cursor >= 0 ? page.cursor : 0,
    nextBefore: Number.isSafeInteger(page.nextBefore) && page.nextBefore >= 0
      ? page.nextBefore
      : before + (Array.isArray(page.messages) ? page.messages.length : 0),
  }
}

export async function fetchMessages(id: string, before = 0, signal?: AbortSignal): Promise<MessagePage> {
  return fetchMessagePage(id, before, signal, before > 0 ? MESSAGE_PAGE_SIZE : INITIAL_MESSAGE_LIMIT)
}

export async function fetchProtocolRuns(id: string): Promise<{ runs: ProtocolRunSnapshot[] }> {
  const response = await fetch(`${BASE}/api/sessions/${id}/protocol-runs`)
  return responseJson<{ runs: ProtocolRunSnapshot[] }>(response)
}

export async function sendInput(id: string, text: string, messageId?: string): Promise<{ ok: boolean, sentAt: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (messageId) headers['X-Feather-Message-ID'] = messageId
  const r = await fetch(`${BASE}/api/sessions/${id}/send`, { method: 'POST', headers, body: JSON.stringify({ text }) })
  const data = await responseJson<{ ok?: boolean, sentAt: string, error?: string }>(r)
  if (data.ok !== true) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { status: r.status })
  return data
}
export async function sendSessionKeys(id: string, keys: string[]): Promise<void> {
  const r = await fetch(`${BASE}/api/sessions/${id}/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys }),
  })
  const data = await responseJson<{ ok?: boolean; error?: string }>(r)
  if (data.ok !== true) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { status: r.status })
}


export interface CreateSessionOptions {
  model?: string
  roomName?: string
  roomRole?: 'leader'
}

export async function createSession(cwd?: string, agent?: 'claude' | 'codex' | 'omp', options: CreateSessionOptions = {}): Promise<string> {
  const id = crypto.randomUUID()
  const response = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, cwd, agent, ...options }),
  })
  const created = await responseJson<{ id?: string }>(response)
  return created.id || id
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

export async function renameSession(id: string, title: string): Promise<void> {
  const response = await fetch(`${BASE}/api/sessions/${id}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  await responseJson(response)
}

export async function forkSession(id: string, options: { title: string, workspaceMode: 'isolated' | 'shared' }): Promise<{
  id: string
  status: 'starting'
  room: string | null
  workspaceMode: 'isolated' | 'shared'
  workspacePath: string | null
  notice: string | null
}> {
  const response = await fetch(`${BASE}/api/sessions/${id}/fork`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  })
  return responseJson(response)
}

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
    const r = await fetch(`${BASE}/api/me`, { cache: 'no-store' })
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
  kind?: 'sidecar' | 'room'
  roomName?: string
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

export interface OmpTodoPhase {
  name: string
  tasks: Array<{ content: string; status: string; blocker?: string }>
}

export interface OmpAsyncJob {
  id: string
  type: string
  status: string
  startTime: number
  label?: string
}
export interface OmpTodoSnapshot {
  phases: OmpTodoPhase[]
  completed: number
  total: number
  active: string | null
}

export type OmpExecutionStatus = 'running' | 'success' | 'error' | 'cancelled'

export type OmpTimelineItem =
  | { key: string; kind: 'thinking'; text: string; status: OmpExecutionStatus }
  | {
      key: string
      kind: 'tool'
      toolCallId: string
      toolName: string
      status: OmpExecutionStatus
      args?: unknown
      intent?: string
      partialResult?: unknown
      result?: unknown
      isError?: boolean
    }

export interface OmpWorkScope {
  timeline: OmpTimelineItem[]
  todo: OmpTodoSnapshot | null
  activeMessageId: string | null
  runStatus: 'idle' | OmpExecutionStatus
  assistantText: string
  assistantEnded: boolean
  continuationPending: boolean
  segment: number
  invocationId: string
}

export interface OmpSubagentState extends OmpWorkScope {
  id: string
  agent: string
  status: string
  index: number
  detached: boolean
  description?: string
  intent?: string
  resolvedModel?: string
  agentSource?: string
  task?: string
  assignment?: string
  sessionFile?: string
  parentToolCallId?: string
  toolCount?: number
  requests?: number
  tokens?: number
  durationMs?: number
}

export interface OmpMirrorState {
  parent: OmpWorkScope
  children: Record<string, OmpSubagentState>
  childOrder: string[]
}


export interface OmpBridgeEvent {
  invocationId?: string
  type: string
  messageId?: string
  text?: string
  reason?: string

  attempt?: number
  provider?: string
  maxAttempts?: number
  delayMs?: number
  success?: boolean
  finalError?: string
  aborted?: boolean
  errorMessage?: string
  willContinue?: boolean
  toolCallId?: string
  toolName?: string
  approvalMode?: string
  approved?: boolean
  phases?: OmpTodoPhase[]
  isError?: boolean
  args?: unknown
  partialResult?: unknown
  result?: unknown
  subagentId?: string
  id?: string
  agent?: string
  status?: string
  index?: number
  detached?: boolean
  description?: string
  intent?: string
  resolvedModel?: string
  toolCount?: number
  requests?: number
  tokens?: number
  durationMs?: number
  agentSource?: string
  task?: string
  assignment?: string
  sessionFile?: string
  parentToolCallId?: string
  running?: OmpAsyncJob[]
  recent?: OmpAsyncJob[]
  delivery?: { queued: number; delivering: boolean }
  modelProvider?: string
  modelId?: string
  modelApi?: string
  thinkingLevel?: string
  serviceTiers?: Record<string, string | null>
  contextTokens?: number
  contextWindow?: number
  contextPercent?: number
}

export interface SubscribeMessagesOptions {
  onMessage: (message: Message, offset: number) => void
  onStatus?: (status: 'connected' | 'reconnecting') => void
  onActivity?: (activity: string | null) => void
  onQuestion?: (question: QuestionData | null) => void
  onOmpEvent?: (event: OmpBridgeEvent) => void
  onProtocolRun?: (run: ProtocolRunSnapshot) => void
}

export interface MessageSubscription {
  connected: Promise<void>
  close: () => void
  setCursor: (cursor: number) => void
}

export function subscribeMessages(id: string, options: SubscribeMessagesOptions): MessageSubscription {
  const { onMessage, onStatus, onActivity, onQuestion, onOmpEvent, onProtocolRun } = options
  let es: EventSource | null = null
  let closed = false
  let hasConnected = false
  let retries = 0
  let lastEventId = ''
  let generation = 0
  let watchdog: ReturnType<typeof setTimeout> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let resolveConnected = () => {}
  const connected = new Promise<void>(resolve => { resolveConnected = resolve })
  const IDLE_TIMEOUT = 40_000

  function clearWatchdog() {
    clearTimeout(watchdog)
    watchdog = null
  }

  function reconnect(source: EventSource, sourceGeneration: number, delay = 0) {
    if (closed || sourceGeneration !== generation || source !== es) return
    generation++
    clearWatchdog()
    try { source.close() } catch {}
    es = null
    onStatus?.('reconnecting')
    clearTimeout(retryTimer)
    retryTimer = setTimeout(() => {
      retryTimer = null
      connect()
    }, delay)
  }

  function armWatchdog(source: EventSource, sourceGeneration: number) {
    clearWatchdog()
    watchdog = setTimeout(() => reconnect(source, sourceGeneration), IDLE_TIMEOUT)
  }

  function connect() {
    if (closed) return
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    try { es?.close() } catch {}
    const sourceGeneration = ++generation
    const url = lastEventId
      ? `${BASE}/api/sessions/${id}/stream?lastEventId=${lastEventId}`
      : `${BASE}/api/sessions/${id}/stream`
    const source = new EventSource(url)
    es = source
    armWatchdog(source, sourceGeneration)

    const alive = () => {
      if (closed || sourceGeneration !== generation || source !== es) return false
      armWatchdog(source, sourceGeneration)
      return true
    }

    source.addEventListener('connected', () => {
      if (!alive()) return
      retries = 0
      hasConnected = true
      resolveConnected()
      onStatus?.('connected')
    })
    source.addEventListener('heartbeat', () => { alive() })
    source.addEventListener('message', (event) => {
      if (!alive()) return
      const offset = Number.parseInt(event.lastEventId || '0', 10) || 0
      if (offset > (Number.parseInt(lastEventId || '0', 10) || 0)) lastEventId = String(offset)
      try { onMessage(JSON.parse(event.data), offset) } catch {}
    })
    source.addEventListener('activity', (event) => {
      if (!alive()) return
      try { onActivity?.(JSON.parse(event.data).activity) } catch {}
    })
    source.addEventListener('question', (event) => {
      if (!alive()) return
      try { onQuestion?.(JSON.parse(event.data).question) } catch {}
    })
    source.addEventListener('omp_event', (event) => {
      if (!alive()) return
      try { onOmpEvent?.(JSON.parse(event.data)) } catch {}
    })
    source.addEventListener('protocol_run', (event) => {
      if (!alive()) return
      try { onProtocolRun?.(JSON.parse(event.data)) } catch {}
    })
    source.onerror = () => {
      if (closed || sourceGeneration !== generation || source !== es) return
      retries++
      reconnect(source, sourceGeneration, Math.min(1000 * 2 ** Math.min(retries - 1, 5), 30_000))
    }
  }

  connect()
  return {
    connected,
    close: () => {
      closed = true
      resolveConnected()
      generation++
      clearWatchdog()
      clearTimeout(retryTimer)
      retryTimer = null
      es?.close()
      es = null
    },
    setCursor: (cursor: number) => {
      if (!Number.isSafeInteger(cursor) || cursor < 0) return
      lastEventId = String(Math.max(Number.parseInt(lastEventId || '0', 10) || 0, cursor))
      if (!hasConnected && !closed) {
        try { es?.close() } catch {}
        connect()
      }
    },
  }
}
