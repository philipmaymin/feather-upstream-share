import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { fetchFeed, postFeedComment, setFeedReaction, type FeedComment, type FeedMode, type FeedPost, type FeedReaction, type FeedResponse } from './api'
import { RichMarkdown } from './components/MessageView'
import { appUrl } from './lib/appPath.js'
import './fledge.css'

export interface FeedHomeProps {
  onOpen: (sessionId: string) => void
  onChannels: () => void
  onMenu: () => void
  onNewChat: () => void
  onOpenFile: (path: string) => void
}

type FeedSource = 'network' | 'cache' | null

type FeedState = {
  response: FeedResponse | null
  firstPageIds: string[]
  savedAt: number | null
  source: FeedSource
  stale: boolean
  error: string | null
  loading: boolean
  refreshing: boolean
  pending: FeedResponse | null
  pendingCount: number
}

type CachedFeed = {
  savedAt: number
  firstPageIds: string[]
  response: FeedResponse
}

type AffinityEntry = { score: number; updatedAt: number }
type AffinityStore = { version: 1; items: Record<string, AffinityEntry> }
type ExternalEmbed = { key: string; platform: 'X' | 'TikTok'; src: string }
type PushState = 'idle' | 'enabling' | 'enabled' | 'denied' | 'dismissed' | 'unavailable' | 'error'
type InteractionState = {
  replyOpen: boolean
  draft: string
  sending: boolean
  reacting: boolean
  pendingCommentId: string | null
  error: string | null
  notice: string | null
}

const PRIORITY_BY_STATUS: Record<FeedPost['status'], number> = {
  waiting: 0,
  errored: 1,
  working: 2,
  finished: 3,
}

const FEED_MODES: Array<{ id: FeedMode; label: string; note: string }> = [
  { id: 'for-you', label: 'For You', note: 'Important only' },
  { id: 'latest', label: 'Latest', note: 'Everything' },
  { id: 'needs-me', label: 'Needs Me', note: 'Decisions waiting' },
]
const CACHE_PREFIX = 'fledge-last-good-v1:'
const SCROLL_PREFIX = 'fledge-scroll-v1:'
const POLL_INTERVAL_MS = 30_000
const PAGE_SIZE = 24
const FOR_YOU_COMPLETION_MS = 3 * 24 * 60 * 60 * 1000
const AFFINITY_KEY = 'fledge-affinity-v1'
const MAX_AFFINITIES = 24
const MAX_AFFINITY_SCORE = 12
const feedRequests = new Map<string, Promise<FeedResponse>>()

function emptyState(): FeedState {
  return {
    response: null,
    firstPageIds: [],
    savedAt: null,
    source: null,
    stale: false,
    error: null,
    loading: true,
    refreshing: false,
    pending: null,
    pendingCount: 0,
  }
}

function validResponse(value: unknown): value is FeedResponse {
  if (!value || typeof value !== 'object') return false
  const response = value as FeedResponse
  return typeof response.generatedAt === 'string'
    && Array.isArray(response.posts)
    && !!response.counts
    && typeof response.counts.waiting === 'number'
}

function readCached(mode: FeedMode): FeedState {
  if (typeof localStorage === 'undefined') return emptyState()
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_PREFIX + mode) || 'null') as CachedFeed | null
    if (!cached || !Number.isFinite(cached.savedAt) || !validResponse(cached.response)) return emptyState()
    return {
      response: cached.response,
      firstPageIds: Array.isArray(cached.firstPageIds) ? cached.firstPageIds : cached.response.posts.map(post => post.id),
      savedAt: cached.savedAt,
      source: 'cache',
      stale: true,
      error: null,
      loading: false,
      refreshing: false,
      pending: null,
      pendingCount: 0,
    }
  } catch {
    return emptyState()
  }
}

function requestFeed(mode: FeedMode, before?: string): Promise<FeedResponse> {
  const key = `${mode}:${before || 'first'}`
  const active = feedRequests.get(key)
  if (active) return active
  const request = fetchFeed(mode, PAGE_SIZE, before)
  feedRequests.set(key, request)
  request.finally(() => {
    if (feedRequests.get(key) === request) feedRequests.delete(key)
  }).catch(() => {})
  return request
}

function samePost(left: FeedPost, right: FeedPost): boolean {
  const leftComments = left.comments || []
  const rightComments = right.comments || []
  const commentsMatch = leftComments.length === rightComments.length && leftComments.every((comment, index) => {
    const other = rightComments[index]
    return !!other
      && comment.id === other.id
      && comment.text === other.text
      && comment.delivery === other.delivery
      && comment.reply?.text === other.reply?.text
      && comment.reply?.timestamp === other.reply?.timestamp
  })
  return left.id === right.id
    && left.timestamp === right.timestamp
    && left.status === right.status
    && left.title === right.title
    && left.question === right.question
    && left.activity === right.activity
    && left.updateText === right.updateText
    && left.importance === right.importance
    && left.media?.kind === right.media?.kind
    && left.media?.path === right.media?.path
    && left.media?.name === right.media?.name
    && left.why === right.why
    && left.score === right.score
    && left.sessionId === right.sessionId
    && left.reaction === right.reaction
    && left.reactionDelivery === right.reactionDelivery
    && commentsMatch
    && left.message?.uuid === right.message?.uuid
    && left.message?.timestamp === right.message?.timestamp
}

function reuseStablePosts(previous: FeedPost[], next: FeedPost[]): FeedPost[] {
  const previousById = new Map(previous.map(post => [post.id, post]))
  return next.map(post => {
    const old = previousById.get(post.id)
    return old && samePost(old, post) ? old : post
  })
}

function dedupePosts(posts: FeedPost[]): FeedPost[] {
  const seen = new Set<string>()
  return posts.filter(post => {
    if (seen.has(post.id)) return false
    seen.add(post.id)
    return true
  })
}

function messageText(post: FeedPost): string {
  if (post.updateText?.trim()) return post.updateText.trim()
  if (!post.message) return ''
  return post.message.content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text!.trim())
    .filter(Boolean)
    .join('\n\n')
}

function affinityKey(post: FeedPost): string | null {
  if (post.room) return `room:${post.room}`
  if (post.projectId) return `project:${post.projectId}`
  if (post.projectLabel) return `project-label:${post.projectLabel}`
  return null
}

function readAffinity(): Record<string, AffinityEntry> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const stored = JSON.parse(localStorage.getItem(AFFINITY_KEY) || 'null') as AffinityStore | null
    return stored?.version === 1 && stored.items && typeof stored.items === 'object' ? stored.items : {}
  } catch {
    return {}
  }
}

function externalEmbeds(text: string): ExternalEmbed[] {
  const embeds: ExternalEmbed[] = []
  const seen = new Set<string>()
  const xPattern = /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^/\s]+\/status\/(\d+)/gi
  const tiktokPattern = /https?:\/\/(?:www\.)?tiktok\.com\/@[^/\s]+\/video\/(\d+)/gi
  for (const match of text.matchAll(xPattern)) {
    const id = match[1]
    if (!id || seen.has(`x:${id}`)) continue
    seen.add(`x:${id}`)
    embeds.push({ key: `x:${id}`, platform: 'X', src: `https://platform.twitter.com/embed/Tweet.html?id=${id}&dnt=true` })
  }
  for (const match of text.matchAll(tiktokPattern)) {
    const id = match[1]
    if (!id || seen.has(`tiktok:${id}`)) continue
    seen.add(`tiktok:${id}`)
    embeds.push({ key: `tiktok:${id}`, platform: 'TikTok', src: `https://www.tiktok.com/player/v1/${id}` })
  }
  return embeds
}


function vapidApplicationKey(key: string): Uint8Array {
  const padding = '='.repeat((4 - key.length % 4) % 4)
  const binary = atob((key + padding).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}
function postImportance(post: FeedPost, text = messageText(post)): 'feature' | 'standard' | 'note' {
  if (post.importance) return post.importance
  if (post.status === 'waiting' || post.status === 'errored') return 'feature'
  if (post.status === 'working') return 'standard'
  if (post.media || externalEmbeds(text).length > 0) return 'feature'
  if (post.kind === 'room-update' || text.length < 180) return 'note'
  return 'standard'
}

function statusLabel(post: FeedPost): string {
  if (post.status === 'waiting') return 'Your move'
  if (post.status === 'working') return 'In motion'
  if (post.status === 'errored') return 'Needs review'
  if (postImportance(post) === 'feature') return 'Highlight'
  if (postImportance(post) === 'note') return 'Note'
  return 'Update'
}

function contentLabel(post: FeedPost): string {
  if (post.status === 'waiting') return 'Decision context'
  if (post.status === 'working') return 'Live dispatch'
  if (post.status === 'errored') return 'Field report'
  if (postImportance(post) === 'note') return 'Note'
  return post.kind === 'room-update' ? 'Room dispatch' : 'Result'
}


function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return 'Time unavailable'
  const now = new Date()
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const prefix = day === today
    ? 'Today'
    : day === today - 86_400_000
      ? 'Yesterday'
      : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date)
  return `${prefix} · ${time}`
}

function ageLabel(savedAt: number | null): string {
  if (!savedAt) return 'saved copy'
  const minutes = Math.max(0, Math.floor((Date.now() - savedAt) / 60_000))
  if (minutes < 1) return 'saved just now'
  if (minutes === 1) return 'saved 1 minute ago'
  if (minutes < 60) return `saved ${minutes} minutes ago`
  const hours = Math.floor(minutes / 60)
  return `saved ${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
}

function isNestedControl(target: EventTarget | null, card: HTMLElement): boolean {
  if (!(target instanceof Element)) return false
  const control = target.closest('a, button, input, select, textarea, summary, [role="button"], [role="link"]')
  return !!control && control !== card
}


function isExpandableDispatch(post: FeedPost, text: string): boolean {
  return post.status === 'finished'
    && postImportance(post, text) !== 'note'
    && (text.length > 360 || text.split('\n').length > 7)
}

export default function FeedHome(props: FeedHomeProps) {
  const [mode, setMode] = createSignal<FeedMode>('for-you')
  const [feeds, setFeeds] = createSignal<Record<FeedMode, FeedState>>({
    'for-you': readCached('for-you'),
    latest: readCached('latest'),
    'needs-me': readCached('needs-me'),
  })
  const [online, setOnline] = createSignal(typeof navigator === 'undefined' ? true : navigator.onLine)
  const [announcement, setAnnouncement] = createSignal('Feed ready')
  const [affinities, setAffinities] = createSignal<Record<string, AffinityEntry>>(readAffinity())
  const [pushState, setPushState] = createSignal<PushState>(
    typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)
      ? 'unavailable'
      : Notification.permission === 'denied' ? 'denied' : 'idle',
  )
  const [interactions, setInteractions] = createSignal<Record<string, InteractionState>>({})
  const [expandedPosts, setExpandedPosts] = createSignal<Set<string>>(new Set())
  const current = createMemo(() => feeds()[mode()])
  const personalized = createMemo(() => {
    const all = current().response?.posts || []
    if (mode() !== 'for-you') return { posts: all, reasons: {} as Record<string, string> }
    const completionCutoff = Date.now() - FOR_YOU_COMPLETION_MS
    const seenSources = new Set<string>()
    const raw = all.filter(post => {
      if (post.status !== 'finished') return true
      if (postImportance(post) !== 'feature' || (post.reaction !== 'like' && Date.parse(post.timestamp) < completionCutoff)) return false
      const sourceKey = post.room ? `room:${post.room}`
        : post.projectId ? `project:${post.projectId}`
          : post.projectLabel ? `project-label:${post.projectLabel}`
            : post.sessionId ? `session:${post.sessionId}`
              : `post:${post.id}`
      if (seenSources.has(sourceKey)) return false
      seenSources.add(sourceKey)
      return true
    })
    const buckets: FeedPost[][] = [[], [], [], []]
    raw.forEach(post => buckets[PRIORITY_BY_STATUS[post.status]].push(post))
    const reasons: Record<string, string> = {}
    const ordered = buckets.flatMap(bucket => {
      const originalPosition = new Map(bucket.map((post, index) => [post.id, index]))
      const sorted = [...bucket].sort((left, right) => {
        const leftKey = affinityKey(left)
        const rightKey = affinityKey(right)
        const scoreDifference = (rightKey ? affinities()[rightKey]?.score || 0 : 0) - (leftKey ? affinities()[leftKey]?.score || 0 : 0)
        return scoreDifference || (originalPosition.get(left.id)! - originalPosition.get(right.id)!)
      })
      sorted.forEach((post, index) => {
        if (originalPosition.get(post.id) === index) return
        const key = affinityKey(post)
        const score = key ? affinities()[key]?.score || 0 : 0
        if (score > 0) reasons[post.id] = 'Often opened'
        else if (score < 0) reasons[post.id] = 'You asked for less'
      })
      return sorted
    })
    return { posts: ordered, reasons }
  })
  const posts = createMemo(() => personalized().posts)
  let feedScroller: HTMLDivElement | undefined
  let scrollSaveFrame = 0

  const updateFeed = (target: FeedMode, update: (state: FeedState) => FeedState) => {
    setFeeds(all => ({ ...all, [target]: update(all[target]) }))
  }

  const saveCache = (target: FeedMode, state: FeedState) => {
    if (!state.response || !state.savedAt || typeof localStorage === 'undefined') return
    try {
      const cached: CachedFeed = {
        savedAt: state.savedAt,
        firstPageIds: state.firstPageIds,
        response: state.response,
      }
      localStorage.setItem(CACHE_PREFIX + target, JSON.stringify(cached))
    } catch {}
  }

  const patchInteraction = (postId: string, patch: Partial<InteractionState>) => {
    setInteractions(all => ({
      ...all,
      [postId]: {
        replyOpen: false,
        draft: '',
        sending: false,
        reacting: false,
        pendingCommentId: null,
        error: null,
        notice: null,
        ...all[postId],
        ...patch,
      },
    }))
  }

  const togglePostExpansion = (postId: string) => {
    setExpandedPosts(current => {
      const next = new Set(current)
      if (next.has(postId)) next.delete(postId)
      else next.add(postId)
      return next
    })
  }

  const updatePost = (postId: string, update: (post: FeedPost) => FeedPost) => {
    setFeeds(all => {
      const next = { ...all }
      FEED_MODES.forEach(({ id }) => {
        const state = next[id]
        const updateResponse = (response: FeedResponse | null) => response
          ? { ...response, posts: response.posts.map(post => post.id === postId ? update(post) : post) }
          : null
        next[id] = {
          ...state,
          response: updateResponse(state.response),
          pending: updateResponse(state.pending),
        }
      })
      return next
    })
  }

  const adjustAffinity = (post: FeedPost, delta: number) => {
    const key = affinityKey(post)
    if (!key) return
    const next = {
      ...affinities(),
      [key]: {
        score: Math.max(-MAX_AFFINITY_SCORE, Math.min(MAX_AFFINITY_SCORE, (affinities()[key]?.score || 0) + delta)),
        updatedAt: Date.now(),
      },
    }
    const bounded = Object.fromEntries(
      Object.entries(next)
        .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
        .slice(0, MAX_AFFINITIES),
    )
    setAffinities(bounded)
    try {
      const stored: AffinityStore = { version: 1, items: bounded }
      localStorage.setItem(AFFINITY_KEY, JSON.stringify(stored))
    } catch {}
  }

  const saveScroll = (target = mode()) => {
    if (!feedScroller || typeof sessionStorage === 'undefined') return
    try { sessionStorage.setItem(SCROLL_PREFIX + target, String(feedScroller.scrollTop)) } catch {}
  }

  const restoreScroll = (target: FeedMode) => {
    if (!feedScroller || typeof sessionStorage === 'undefined') return
    let top = 0
    try { top = Number(sessionStorage.getItem(SCROLL_PREFIX + target) || 0) || 0 } catch {}
    requestAnimationFrame(() => feedScroller?.scrollTo({ top, behavior: 'auto' }))
  }

  const queueScrollSave = () => {
    if (scrollSaveFrame) return
    scrollSaveFrame = requestAnimationFrame(() => {
      scrollSaveFrame = 0
      saveScroll()
    })
  }

  const captureAnchor = () => {
    if (!feedScroller) return null
    const scrollerTop = feedScroller.getBoundingClientRect().top
    const slides = Array.from(feedScroller.querySelectorAll<HTMLElement>('[data-feed-post-id]'))
    const anchor = slides.find(slide => slide.getBoundingClientRect().bottom > scrollerTop + 8)
    return anchor ? { id: anchor.dataset.feedPostId || '', offset: anchor.getBoundingClientRect().top - scrollerTop } : null
  }

  const restoreAnchor = (anchor: { id: string; offset: number } | null) => {
    if (!feedScroller || !anchor?.id) return
    requestAnimationFrame(() => {
      if (!feedScroller) return
      const next = Array.from(feedScroller.querySelectorAll<HTMLElement>('[data-feed-post-id]'))
        .find(slide => slide.dataset.feedPostId === anchor.id)
      if (!next) return
      const delta = next.getBoundingClientRect().top - feedScroller.getBoundingClientRect().top - anchor.offset
      if (delta) feedScroller.scrollTop += delta
    })
  }

  const applyResponse = (target: FeedMode, response: FeedResponse, append: boolean) => {
    const anchor = target === mode() ? captureAnchor() : null
    const savedAt = Date.now()
    let stored: FeedState | null = null
    updateFeed(target, state => {
      const oldPosts = state.response?.posts || []
      let merged: FeedPost[]
      let firstPageIds = state.firstPageIds
      let nextBefore = response.nextBefore

      if (append) {
        merged = dedupePosts([...oldPosts, ...response.posts])
      } else {
        const previousFirst = new Set(state.firstPageIds)
        const retainedTail = target === 'needs-me'
          ? []
          : oldPosts.filter(post => !previousFirst.has(post.id))
        merged = dedupePosts([...response.posts, ...retainedTail])
        firstPageIds = response.posts.map(post => post.id)
        if (retainedTail.length && state.response) nextBefore = state.response.nextBefore
      }

      const nextResponse: FeedResponse = {
        ...response,
        nextBefore,
        posts: reuseStablePosts(oldPosts, merged),
      }
      stored = {
        response: nextResponse,
        firstPageIds,
        savedAt,
        source: 'network',
        stale: false,
        error: null,
        loading: false,
        refreshing: false,
        pending: null,
        pendingCount: 0,
      }
      return stored
    })
    if (stored) saveCache(target, stored)
    restoreAnchor(anchor)
    setAnnouncement(`${append ? 'Older dispatches loaded' : 'Feed updated'}. ${response.posts.length} ${response.posts.length === 1 ? 'entry' : 'entries'}.`)
  }

  const shouldBuffer = (target: FeedMode, response: FeedResponse): number => {
    if (target !== mode() || !feedScroller || feedScroller.scrollTop < 96) return 0
    const visibleIds = new Set(feeds()[target].firstPageIds)
    return response.posts.reduce((count, post) => count + (visibleIds.has(post.id) ? 0 : 1), 0)
  }

  const load = async (target: FeedMode, reason: 'initial' | 'switch' | 'poll' | 'manual' | 'visible' | 'online' | 'older') => {
    if (feeds()[target].refreshing) return
    const before = reason === 'older' ? feeds()[target].response?.nextBefore || undefined : undefined
    if (reason === 'older' && !before) return
    if (!online()) {
      updateFeed(target, state => ({
        ...state,
        loading: false,
        refreshing: false,
        stale: !!state.response,
        error: state.response ? null : 'You are offline and no saved feed is available yet.',
      }))
      setAnnouncement('Offline. Showing the last saved feed when available.')
      return
    }

    updateFeed(target, state => ({ ...state, loading: !state.response, refreshing: true, error: null }))
    try {
      const response = await requestFeed(target, before)
      if (reason !== 'older') {
        const pendingCount = shouldBuffer(target, response)
        if (pendingCount > 0) {
          updateFeed(target, state => ({
            ...state,
            loading: false,
            refreshing: false,
            error: null,
            pending: response,
            pendingCount,
          }))
          setAnnouncement(`${pendingCount} new ${pendingCount === 1 ? 'dispatch' : 'dispatches'} ready.`)
          return
        }
      }
      applyResponse(target, response, reason === 'older')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The feed could not be refreshed.'
      updateFeed(target, state => ({
        ...state,
        loading: false,
        refreshing: false,
        stale: !!state.response,
        error: state.response ? message : `The dispatch line is unavailable: ${message}`,
      }))
      setAnnouncement(feeds()[target].response ? 'Refresh failed. The saved feed is still visible.' : 'Feed unavailable.')
    }
  }

  const revealPending = () => {
    const pending = current().pending
    if (!pending) return
    applyResponse(mode(), pending, false)
    requestAnimationFrame(() => {
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      feedScroller?.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' })
    })
  }

  const switchMode = (next: FeedMode) => {
    if (next === mode()) return
    saveScroll(mode())
    setMode(next)
    setAnnouncement(`${FEED_MODES.find(item => item.id === next)?.label} feed selected.`)
    restoreScroll(next)
    void load(next, 'switch')
  }

  const openPost = (post: FeedPost) => {
    saveScroll()
    adjustAffinity(post, 1)
    if (post.sessionId) props.onOpen(post.sessionId)
    else props.onChannels()
  }

  const reactToPost = async (post: FeedPost, selected: FeedReaction) => {
    const state = interactions()[post.id]
    if (state?.reacting) return
    const previous = post.reaction || null
    const previousDelivery = post.reactionDelivery || null
    const next = previous === selected ? null : selected
    const weight: Record<FeedReaction, number> = { like: 2, less: -2 }
    const delta = (next ? weight[next] : 0) - (previous ? weight[previous] : 0)
    const anchor = captureAnchor()
    patchInteraction(post.id, { reacting: true, error: null, notice: null })
    updatePost(post.id, item => ({ ...item, reaction: next, reactionDelivery: null }))
    adjustAffinity(post, delta)
    restoreAnchor(anchor)
    try {
      const saved = await setFeedReaction(post.id, next)
      updatePost(post.id, item => ({ ...item, reaction: saved.reaction, reactionDelivery: saved.reactionDelivery }))
      if (saved.reactionDelivery === 'failed') {
        patchInteraction(post.id, { reacting: false, error: 'Feedback delivery failed.', notice: null })
        setAnnouncement('Preference saved, but feedback delivery failed.')
      } else {
        patchInteraction(post.id, { reacting: false, error: null, notice: saved.reactionDelivery === 'queued' ? 'Feedback queued' : null })
        setAnnouncement(saved.reactionDelivery === 'queued' ? 'Preference saved. Feedback queued.' : 'Feed preference saved.')
      }
    } catch {
      updatePost(post.id, item => ({ ...item, reaction: previous, reactionDelivery: previousDelivery }))
      adjustAffinity(post, -delta)
      patchInteraction(post.id, { reacting: false, error: 'Could not save. Your preference was restored.', notice: null })
      restoreAnchor(anchor)
    }
  }

  const retryReactionFeedback = async (post: FeedPost) => {
    if (!post.reaction || interactions()[post.id]?.reacting) return
    patchInteraction(post.id, { reacting: true, error: null, notice: 'Retrying feedback…' })
    try {
      const saved = await setFeedReaction(post.id, post.reaction)
      updatePost(post.id, item => ({ ...item, reaction: saved.reaction, reactionDelivery: saved.reactionDelivery }))
      if (saved.reactionDelivery === 'failed') {
        patchInteraction(post.id, { reacting: false, error: 'Feedback delivery failed.', notice: null })
        setAnnouncement('Feedback delivery failed again.')
      } else {
        patchInteraction(post.id, { reacting: false, error: null, notice: saved.reactionDelivery === 'queued' ? 'Feedback queued' : null })
        setAnnouncement(saved.reactionDelivery === 'queued' ? 'Feedback queued.' : 'Feedback delivered.')
      }
    } catch {
      patchInteraction(post.id, { reacting: false, error: 'Feedback retry failed.', notice: null })
      setAnnouncement('Feedback retry failed.')
    }
  }

  const sendComment = async (post: FeedPost) => {
    const state = interactions()[post.id]
    const text = state?.draft.trim() || ''
    if (!post.sessionId || !text || state?.sending) return
    const commentId = state?.pendingCommentId || crypto.randomUUID()
    patchInteraction(post.id, { sending: true, pendingCommentId: commentId, error: null, notice: null })
    try {
      const result = await postFeedComment(post.id, commentId, text)
      updatePost(post.id, item => {
        const comments = item.comments || []
        const existingIndex = comments.findIndex(comment => comment.id === result.comment.id)
        const nextComments = existingIndex >= 0
          ? comments.map((comment, index) => index === existingIndex ? result.comment : comment)
          : [...comments, result.comment]
        return { ...item, comments: nextComments }
      })
      if (result.comment.delivery === 'failed') {
        patchInteraction(post.id, { sending: false, pendingCommentId: commentId, draft: text, error: 'Delivery failed. Your draft is still here.', notice: null })
        setAnnouncement('Reply delivery failed. The draft was preserved.')
      } else {
        patchInteraction(post.id, { sending: false, pendingCommentId: null, draft: '', notice: result.comment.delivery === 'delivered' ? 'Reply delivered' : 'Reply queued' })
        setAnnouncement('Reply added to this dispatch.')
      }
    } catch {
      patchInteraction(post.id, { sending: false, pendingCommentId: commentId, error: 'Reply failed. Your draft is still here.', notice: null })
      setAnnouncement('Reply could not be sent. The draft was preserved.')
    }
  }

  function toggleReply(postId: string) {
    const opening = !interactions()[postId]?.replyOpen
    patchInteraction(postId, { replyOpen: opening, error: null, notice: null })
    if (!opening) return
    queueMicrotask(() => document.getElementById(`fledge-reply-${postId}`)?.focus())
  }

  const handleScroll = () => {
    queueScrollSave()
    if (!feedScroller || current().refreshing || !current().response?.nextBefore || !online()) return
    const remaining = feedScroller.scrollHeight - feedScroller.scrollTop - feedScroller.clientHeight
    if (remaining < feedScroller.clientHeight * 1.5) void load(mode(), 'older')
  }

  const pushLabel = createMemo(() => {
    if (pushState() === 'enabling') return 'Enabling alerts'
    if (pushState() === 'enabled') return 'Alerts on'
    if (pushState() === 'denied') return 'Alerts denied'
    if (pushState() === 'dismissed') return 'Alerts not enabled'
    if (pushState() === 'unavailable') return 'Alerts unavailable'
    if (pushState() === 'error') return 'Alert setup failed'
    return 'Alerts'
  })

  const enablePush = async () => {
    if (pushState() !== 'idle') return
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      setPushState('unavailable')
      return
    }
    setPushState('enabling')
    try {
      const permission = await Notification.requestPermission()
      if (permission === 'denied') {
        setPushState('denied')
        setAnnouncement('Alerts were denied. You can change this in browser settings.')
        return
      }
      if (permission !== 'granted') {
        setPushState('dismissed')
        setAnnouncement('Alerts were not enabled.')
        return
      }
      const registration = await navigator.serviceWorker.ready
      const keyResponse = await fetch(appUrl('/api/push/key'))
      const keyData = await keyResponse.json().catch(() => ({})) as { key?: string; error?: string }
      if (!keyResponse.ok || typeof keyData.key !== 'string') throw new Error(keyData.error || 'Push key unavailable')
      const existing = await registration.pushManager.getSubscription()
      const subscription = existing || await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidApplicationKey(keyData.key),
      })
      const saveResponse = await fetch(appUrl('/api/push/subscribe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription.toJSON()),
      })
      if (!saveResponse.ok) {
        const failure = await saveResponse.json().catch(() => ({})) as { error?: string }
        throw new Error(failure.error || 'Subscription could not be saved')
      }
      setPushState('enabled')
      setAnnouncement('Alerts enabled for dispatches that need you.')
    } catch {
      setPushState('error')
      setAnnouncement('Alert setup failed. No notification subscription was saved.')
    }
  }

  const connectionLabel = createMemo(() => {
    const state = current()
    if (!online()) return `Offline · ${ageLabel(state.savedAt)}`
    if (state.refreshing) return 'Checking dispatches'
    if (state.stale || state.source === 'cache') return `Stale copy · ${ageLabel(state.savedAt)}`
    if (state.error && state.response) return `Stale copy · ${ageLabel(state.savedAt)}`
    return state.source === 'network' ? 'Live' : 'Connecting'
  })

  onMount(() => {
    if (pushState() === 'idle' && Notification.permission === 'granted') {
      navigator.serviceWorker.ready
        .then(registration => registration.pushManager.getSubscription())
        .then(subscription => {
          if (subscription) setPushState('enabled')
        })
        .catch(() => setPushState('error'))
    }
    restoreScroll(mode())
    void load(mode(), 'initial')

    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(mode(), 'poll')
    }, POLL_INTERVAL_MS)
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return
      const savedAt = feeds()[mode()].savedAt || 0
      if (Date.now() - savedAt > POLL_INTERVAL_MS / 2) void load(mode(), 'visible')
    }
    const onOnline = () => {
      setOnline(true)
      setAnnouncement('Back online. Checking for dispatches.')
      void load(mode(), 'online')
    }
    const onOffline = () => {
      setOnline(false)
      updateFeed(mode(), state => ({ ...state, stale: !!state.response }))
      setAnnouncement('Offline. The feed is now a saved copy.')
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    onCleanup(() => {
      saveScroll()
      window.clearInterval(poll)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      if (scrollSaveFrame) cancelAnimationFrame(scrollSaveFrame)
    })
  })

  return (
    <div class="fledge-root" data-testid="fledge-home">
      <p class="fledge-sr-only" aria-live="polite" aria-atomic="true">{announcement()}</p>

      <header class="fledge-header">
        <div class="fledge-brand" aria-label="Fledge dispatch feed">
          <svg class="fledge-mark" viewBox="0 0 36 44" aria-hidden="true">
            <path d="M29.5 2.5C17 5.8 8.5 15.2 7.1 29.6c-.4 4.1-2.2 7.6-5.1 10.6 6.2-1.5 10.8-4.6 13.9-9.2 5.2-7.6 8.6-17.1 13.6-28.5Z" />
            <path d="M8.6 33.2 24.8 8.8M11.8 27.8l-3.5-6.2M16 21.4l-3.1-5.5M13.9 25.4l7.1-.8M18.4 18.4l6-.7" />
          </svg>
          <div>
            <span class="fledge-kicker">Field dispatch</span>
            <span class="fledge-wordmark">Fledge</span>
          </div>
        </div>
        <div class="fledge-header-actions">
          <button
            type="button"
            class="fledge-live"
            classList={{ 'fledge-live-refreshing': current().refreshing, 'fledge-live-stale': current().stale || !online() }}
            onClick={() => void load(mode(), 'manual')}
            disabled={current().refreshing || !online()}
            aria-label={`${connectionLabel()}. Refresh feed`}
          >
            <span class="fledge-live-beacon" aria-hidden="true" />
            <span>{connectionLabel()}</span>
          </button>
          <button
            type="button"
            class="fledge-alerts"
            classList={{ 'fledge-alerts-enabled': pushState() === 'enabled', 'fledge-alerts-error': pushState() === 'denied' || pushState() === 'error' }}
            onClick={() => void enablePush()}
            disabled={pushState() !== 'idle'}
            aria-label={pushLabel()}
            title={pushLabel()}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 9.5a5.5 5.5 0 0 1 11 0c0 6 2.5 6.5 2.5 6.5H4s2.5-.5 2.5-6.5ZM9.5 19h5" /></svg>
            <span>{pushState() === 'enabled' ? 'On' : 'Alerts'}</span>
          </button>
          <button type="button" class="fledge-menu" onClick={props.onMenu} aria-label="Open menu">
            <span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" />
          </button>
        </div>
      </header>

      <nav class="fledge-modes" aria-label="Feed order">
        <For each={FEED_MODES}>{item => (
          <button
            type="button"
            class="fledge-mode"
            classList={{ 'fledge-mode-active': mode() === item.id }}
            aria-pressed={mode() === item.id}
            onClick={() => switchMode(item.id)}
          >
            <span>{item.label}</span>
            <small>{item.note}</small>
          </button>
        )}</For>
      </nav>

      <Show when={current().response}>
        {response => (
          <aside class="fledge-pulse" aria-label="Live feed pulse">
            <span class="fledge-pulse-title">{mode() === 'for-you' ? 'Signal' : 'Live pulse'}</span>
            <span class="fledge-pulse-item fledge-pulse-waiting" data-testid="fledge-needs-count"><b>{response().counts.waiting}</b> waiting</span>
            <Show when={response().counts.working > 0}>
              <span class="fledge-pulse-item"><b>{response().counts.working}</b> working</span>
            </Show>
            <Show when={response().counts.errored > 0}>
              <span class="fledge-pulse-item"><b>{response().counts.errored}</b> flagged</span>
            </Show>
            <span class="fledge-pulse-item"><b>{mode() === 'for-you' ? response().counts.important ?? posts().length : response().counts.finished}</b> {mode() === 'for-you' ? 'done' : 'filed'}</span>
            <Show when={mode() === 'for-you' && (response().counts.notes || 0) > 0}>
              <span class="fledge-pulse-item fledge-pulse-quiet"><b>{response().counts.notes}</b> more in Latest</span>
            </Show>
          </aside>
        )}
      </Show>

      <div class="fledge-feed-frame">
        <Show when={current().pendingCount > 0}>
          <button type="button" class="fledge-new-dispatches" data-testid="fledge-new-dispatches" onClick={revealPending}>
            <span class="fledge-new-mark" aria-hidden="true" />
            {current().pendingCount} new {current().pendingCount === 1 ? 'dispatch' : 'dispatches'}
            <span class="fledge-new-action">Review from top</span>
          </button>
        </Show>

        <section
          ref={feedScroller}
          class="fledge-feed"
          data-testid="fledge-feed"
          aria-label={`${FEED_MODES.find(item => item.id === mode())?.label} dispatches`}
          aria-busy={current().loading || current().refreshing}
          onScroll={handleScroll}
        >
          <Show when={current().loading && !current().response}>
            <div class="fledge-state fledge-loading" role="status">
              <span class="fledge-loader-rule" aria-hidden="true" />
              <span class="fledge-state-index">Receiving field notes</span>
              <h1>Opening the dispatch line</h1>
              <p>Recent decisions, active work, and finished results will appear here.</p>
            </div>
          </Show>

          <Show when={!current().loading && current().error && !current().response}>
            <div class="fledge-state fledge-error" role="alert">
              <span class="fledge-state-index">Dispatch interrupted</span>
              <h1>The field line is quiet</h1>
              <p>{current().error}</p>
              <button type="button" class="fledge-state-action" onClick={() => void load(mode(), 'manual')} disabled={!online()}>
                Try the line again
              </button>
            </div>
          </Show>

          <Show when={!current().loading && current().response && posts().length === 0}>
            <div class="fledge-state fledge-empty">
              <span class="fledge-state-index">Nothing queued</span>
              <h1>{mode() === 'needs-me' ? 'No decisions are waiting on you' : 'The journal is caught up'}</h1>
              <p>{mode() === 'needs-me' ? 'Active agents can keep moving. Check the wider feed for results and work in progress.' : 'Start a conversation or open Channels to put shared work in motion.'}</p>
              <div class="fledge-state-actions">
                <button type="button" class="fledge-state-action" onClick={props.onNewChat}>Start a conversation</button>
                <button type="button" class="fledge-state-action fledge-state-action-secondary" onClick={props.onChannels}>Open Channels</button>
              </div>
            </div>
          </Show>

          <For each={posts()}>{post => {
            const text = messageText(post)
            const expandable = isExpandableDispatch(post, text)
            const expanded = () => expandedPosts().has(post.id)
            const importance = postImportance(post, text)
            const mediaSource = post.media ? appUrl(`/api/files/media?path=${encodeURIComponent(post.media.path)}`) : ''
            const source = post.room || post.projectLabel || post.agent || 'F'
            const monogram = source.replace(/^#/, '').trim().charAt(0).toUpperCase() || 'F'
            return (
              <div class="fledge-slide" data-feed-post-id={post.id} data-post-id={post.id} data-importance={importance} data-testid="fledge-post">
                <article
                  class="fledge-card"
                  data-importance={importance}
                  classList={{
                    'fledge-card-feature': importance === 'feature',
                    'fledge-card-standard': importance === 'standard',
                    'fledge-card-note': importance === 'note',
                    'fledge-card-waiting': post.status === 'waiting',
                    'fledge-card-working': post.status === 'working',
                    'fledge-card-errored': post.status === 'errored',
                  }}
                  onClick={event => {
                    if (!isNestedControl(event.target, event.currentTarget)) openPost(post)
                  }}
                >

                  <div class="fledge-card-main">
                    <div class="fledge-card-avatar" aria-hidden="true">{monogram}</div>
                    <div class="fledge-card-content">
                    <div class="fledge-card-topline">
                      <span class="fledge-status" classList={{ 'fledge-status-waiting': post.status === 'waiting' }}>
                        <span class="fledge-status-dot" aria-hidden="true" />
                        {statusLabel(post)}
                      </span>
                      <span class="fledge-card-place">{post.room || post.projectLabel || 'Unfiled'}</span>
                      <Show when={post.agent}><span class="fledge-card-agent">{post.agent}</span></Show>
                      <time dateTime={post.timestamp}>{formatTimestamp(post.timestamp)}</time>
                    </div>

                    <Show when={post.status === 'waiting'}>
                      <section class="fledge-your-move" aria-label="Your move">
                        <span class="fledge-your-move-label">Your move</span>
                        <p>{post.question?.trim() || 'This conversation is waiting for your decision.'}</p>
                      </section>
                    </Show>

                    <div class="fledge-card-heading">
                      <h2 title={post.title}>{post.title}</h2>
                    </div>

                    <Show when={post.activity?.trim()}>
                      <div class="fledge-phase">
                        <span>Current phase</span>
                        <p>{post.activity}</p>
                      </div>
                    </Show>

                    <Show when={text}>
                      <section class="fledge-dispatch-body" aria-label={contentLabel(post)}>
                        <div class="fledge-section-label">{contentLabel(post)}</div>
                        <div class="fledge-markdown" classList={{ 'fledge-dispatch-collapsed': expandable && !expanded() }}>
                          <RichMarkdown text={text} onOpenFile={props.onOpenFile} allowRemoteImages={false} />
                        </div>
                        <Show when={expandable}>
                          <button
                            type="button"
                            class="fledge-more"
                            aria-expanded={expanded()}
                            onClick={event => { event.stopPropagation(); togglePostExpansion(post.id) }}
                          >
                            {expanded() ? 'Show less' : 'More'}
                          </button>
                        </Show>
                          <For each={externalEmbeds(text)}>{embed => (
                            <figure class="fledge-external-embed" data-platform={embed.platform.toLowerCase()}>
                              <figcaption>{embed.platform} dispatch</figcaption>
                              <iframe
                                src={embed.src}
                                title={`${embed.platform} post embedded in ${post.title}`}
                                loading="lazy"
                                sandbox="allow-scripts"
                                referrerpolicy="no-referrer"
                                allow="fullscreen; encrypted-media; picture-in-picture"
                              />
                            </figure>
                          )}</For>
                      </section>
                    </Show>
                    <Show when={importance === 'feature' ? post.media : undefined}>
                      {media => (
                        <figure class="fledge-primary-media">
                          <Show when={media().kind === 'image'} fallback={
                            <video src={mediaSource} controls playsinline preload="metadata" aria-label={`Play ${media().name}`} />
                          }>
                            <img src={mediaSource} alt={media().name} loading="lazy" />
                          </Show>
                          <figcaption>{media().name}</figcaption>
                        </figure>
                      )}
                    </Show>

                    <aside class="fledge-why">
                      <span>Why</span>
                      <p>{post.why}{personalized().reasons[post.id] ? ` · ${personalized().reasons[post.id]}` : ''}</p>
                    </aside>

                    <section class="fledge-interactions" aria-label={`Ask about ${post.title}`} onClick={event => event.stopPropagation()}>
                      <div class="fledge-reaction-row">
                        <button
                          type="button"
                          class="fledge-reaction"
                          classList={{ 'fledge-reaction-active': post.reaction === 'like' }}
                          aria-pressed={post.reaction === 'like'}
                          aria-label="Show me more like this"
                          title="Show me more like this"
                          disabled={interactions()[post.id]?.reacting}
                          onClick={() => void reactToPost(post, 'like')}
                        >
                          <span class="fledge-reaction-emoji" aria-hidden="true">👍</span>
                        </button>
                        <button
                          type="button"
                          class="fledge-reaction"
                          classList={{ 'fledge-reaction-less': post.reaction === 'less' }}
                          aria-pressed={post.reaction === 'less'}
                          aria-label="Show me less like this"
                          title="Show me less like this"
                          disabled={interactions()[post.id]?.reacting}
                          onClick={() => void reactToPost(post, 'less')}
                        >
                          <span class="fledge-reaction-emoji" aria-hidden="true">👎</span>
                        </button>
                        <Show when={post.sessionId} fallback={
                          <button
                            type="button"
                            class="fledge-reaction"
                            disabled
                            aria-label="Open Room to reply"
                            title="Open Room to reply"
                          >
                            <span class="fledge-reaction-emoji" aria-hidden="true">💬</span>
                            Open Room to reply
                          </button>
                        }>
                          <button
                            type="button"
                            class="fledge-reaction"
                            aria-expanded={!!interactions()[post.id]?.replyOpen}
                            aria-label="Ask a follow-up"
                            title="Ask a follow-up"
                            onClick={() => toggleReply(post.id)}
                          >
                            <span class="fledge-reaction-emoji" aria-hidden="true">💬</span>
                            Ask
                          </button>
                        </Show>
                        <Show when={post.reaction && post.reactionDelivery === 'failed'}>
                          <button
                            type="button"
                            class="fledge-feedback-retry"
                            disabled={interactions()[post.id]?.reacting}
                            onClick={() => void retryReactionFeedback(post)}
                          >
                            Retry feedback
                          </button>
                        </Show>
                        <span class="fledge-interaction-note" aria-live="polite">
                          {interactions()[post.id]?.error || interactions()[post.id]?.notice || ''}
                        </span>
                        <button
                          type="button"
                          class="fledge-conversation-arrow"
                          aria-label={post.sessionId ? 'Open conversation' : 'Open Room'}
                          title={post.sessionId ? 'Open conversation' : 'Open Room'}
                          onClick={() => openPost(post)}
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M14 7l5 5-5 5" /></svg>
                        </button>
                      </div>

                      <Show when={interactions()[post.id]?.replyOpen}>
                        <form class="fledge-reply-form" onSubmit={event => { event.preventDefault(); void sendComment(post) }}>
                          <label for={`fledge-reply-${post.id}`}>Ask about this result</label>
                          <textarea
                            id={`fledge-reply-${post.id}`}
                            value={interactions()[post.id]?.draft || ''}
                            maxLength={2000}
                            rows={3}
                            placeholder="Ask a question or give direction…"
                            disabled={interactions()[post.id]?.sending}
                            onInput={event => patchInteraction(post.id, { draft: event.currentTarget.value, pendingCommentId: null, error: null })}
                          />
                          <div class="fledge-reply-actions">
                            <span>{(interactions()[post.id]?.draft || '').length}/2000</span>
                            <button type="submit" disabled={interactions()[post.id]?.sending || !(interactions()[post.id]?.draft || '').trim()}>
                              {interactions()[post.id]?.sending ? 'Sending…' : 'Ask'}
                            </button>
                          </div>
                        </form>
                      </Show>

                      <Show when={(post.comments?.length || 0) > 0}>
                        <div class="fledge-comment-thread" aria-label="Replies on this dispatch">
                          <For each={post.comments}>{(comment: FeedComment) => (
                            <article class="fledge-comment">
                              <div class="fledge-comment-meta">
                                <span>You</span>
                                <time dateTime={comment.createdAt}>{formatTimestamp(comment.createdAt)}</time>
                                <span classList={{ 'fledge-comment-failed': comment.delivery === 'failed' }}>{comment.delivery}</span>
                              </div>
                              <p>{comment.text}</p>
                              <Show when={comment.reply}>
                                {reply => (
                                  <div class="fledge-agent-reply">
                                    <span>Feather reply</span>
                                    <RichMarkdown text={reply().text} onOpenFile={props.onOpenFile} allowRemoteImages={false} />
                                  </div>
                                )}
                              </Show>
                            </article>
                          )}</For>
                        </div>
                      </Show>
                    </section>
                    </div>
                  </div>
                </article>
              </div>
            )
          }}</For>

          <Show when={current().response?.nextBefore && posts().length > 0}>
            <div class="fledge-feed-tail">
              <span>Earlier in the journal</span>
              <button type="button" onClick={() => void load(mode(), 'older')} disabled={current().refreshing}>
                {current().refreshing ? 'Receiving…' : 'Load older dispatches'}
              </button>
            </div>
          </Show>
        </section>
      </div>

      <nav class="fledge-bottom-nav" aria-label="Primary navigation">
        <button type="button" class="fledge-bottom-item fledge-bottom-item-active" aria-current="page" onClick={() => feedScroller?.scrollTo({ top: 0, behavior: 'smooth' })}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14M5 12h10M5 19h7" /></svg>
          <span>Feed</span>
        </button>
        <button type="button" class="fledge-bottom-item" onClick={props.onChannels}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 4-2 16m10-16-2 16M4 9h16M3 15h16" /></svg>
          <span>Channels</span>
        </button>
        <button type="button" class="fledge-bottom-item fledge-bottom-new" onClick={props.onNewChat}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          <span>New</span>
        </button>
      </nav>
    </div>
  )
}
