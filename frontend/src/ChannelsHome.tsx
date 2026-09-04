import { For, Index, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import {
  addChannelMember,
  cancelChannelExecution,
  createChannel,
  createChannelDm,
  fetchChannelActivity,
  fetchChannelExecutionPeek,
  fetchChannelMessages,
  fetchChannelPrincipals,
  fetchChannelThread,
  fetchChannels,
  postChannelMessage,
  restartChannelExecution,
  subscribeChannels,
  updateChannelAttention,
  updateChannelThread,
  uploadChannelImage,
  type ChannelActivityItem,
  type ChannelDelivery,
  type ChannelExecution,
  type ChannelExecutionPeek,
  type ChannelInfo,
  type ChannelMessage,
  type ChannelPrincipal,
  type ChannelThread,
} from './api'
import { RichMarkdown } from './components/MessageView'
import { appUrl } from './lib/appPath.js'
import './channels.css'

type ChannelSection = 'activity' | 'channels' | 'threads' | 'dms'
type DialogKind = 'channel' | 'dm' | 'members' | null
type PendingChannelImage = { id: string; file: File; previewUrl: string }
const CHANNEL_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_CHANNEL_IMAGE_BYTES = 15 * 1024 * 1024
const MAX_CHANNEL_IMAGES = 6


function channelDraftKey(channelId: string) {
  return `feather:channel-draft:${channelId}`
}

function loadChannelDraft(channelId: string | null) {
  if (!channelId) return ''
  try { return localStorage.getItem(channelDraftKey(channelId)) || '' }
  catch { return '' }
}
type ChannelsSnapshot = {
  channels: ChannelInfo[]
  dms: ChannelInfo[]
  principal: ChannelPrincipal | null
}

export interface ChannelsHomeProps {
  onFeed: () => void
  onRooms: () => void
  onMenu: () => void
  onCloseMenu: () => void
  onNewChat: () => void
  showPersonal: boolean
}

const emptySnapshot: ChannelsSnapshot = { channels: [], dms: [], principal: null }

function channelSection(params: URLSearchParams): ChannelSection {
  const view = params.get('view')
  return view === 'activity' || view === 'threads' || view === 'dms' ? view : 'channels'
}

function relativeTime(iso: string) {
  const elapsed = Math.max(0, Date.now() - Date.parse(iso))
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return days < 7 ? `${days}d` : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(iso))
}

function activeSnooze(until: string | null) {
  return !!until && Date.parse(until) > Date.now()
}

async function boundedBrowserWait<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: number | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => { timer = window.setTimeout(() => reject(new Error(message)), 5_000) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function initials(principal: Pick<ChannelPrincipal, 'displayName'>) {
  return principal.displayName.split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase()
}

function dmName(channel: ChannelInfo, selfId?: string | null) {
  const others = channel.members.filter(member => member.id !== selfId)
  return others.map(member => member.displayName).join(', ') || 'Direct message'
}

function pushKey(value: string): ArrayBuffer {
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const binary = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'))
  const buffer = new ArrayBuffer(binary.length)
  const bytes = new Uint8Array(buffer)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return buffer
}

function PersonMark(props: { person: Pick<ChannelPrincipal, 'kind' | 'displayName' | 'username'>; small?: boolean }) {
  return (
    <span
      class="channel-avatar"
      classList={{ 'channel-avatar-agent': props.person.kind === 'agent', 'channel-avatar-small': !!props.small }}
      title={`${props.person.displayName} · ${props.person.kind}`}
      aria-hidden="true"
    >
      {props.person.kind === 'agent' ? <span class="channel-agent-glyph" /> : initials(props.person as ChannelPrincipal)}
    </span>
  )
}

function Identity(props: { person: ChannelPrincipal; compact?: boolean }) {
  return (
    <span class="channel-identity">
      <b>{props.person.displayName}</b>
      <Show when={props.person.kind === 'agent'}><span class="channel-agent-label">Agent</span></Show>
      <Show when={!props.compact}><span class="channel-handle">@{props.person.username}</span></Show>
    </span>
  )
}

export default function ChannelsHome(props: ChannelsHomeProps) {
  const query = new URLSearchParams(location.search)
  const [section, setSection] = createSignal<ChannelSection>(channelSection(query))
  const [snapshot, setSnapshot] = createSignal<ChannelsSnapshot>(emptySnapshot)
  const [selectedChannelId, setSelectedChannelId] = createSignal(query.get('channel'))
  const [roots, setRoots] = createSignal<ChannelMessage[]>([])
  const [thread, setThread] = createSignal<ChannelThread | null>(null)
  const [activity, setActivity] = createSignal<{ items: ChannelActivityItem[]; unread: number; needsYou: number }>({ items: [], unread: 0, needsYou: 0 })
  const [principals, setPrincipals] = createSignal<ChannelPrincipal[]>([])
  const [loading, setLoading] = createSignal(true)
  const [refreshing, setRefreshing] = createSignal(false)
  const [error, setError] = createSignal('')
  const [rootDraft, setRootDraft] = createSignal(loadChannelDraft(query.get('channel')))
  const [replyDraft, setReplyDraft] = createSignal('')
  const [rootImages, setRootImages] = createSignal<PendingChannelImage[]>([])
  const [replyImages, setReplyImages] = createSignal<PendingChannelImage[]>([])
  const [expandedMessageIds, setExpandedMessageIds] = createSignal<Set<string>>(new Set())
  const [sending, setSending] = createSignal(false)
  const [expandedThreadIds, setExpandedThreadIds] = createSignal<Set<string>>(new Set())
  const [inlineThreads, setInlineThreads] = createSignal<Record<string, ChannelThread>>({})
  const [inlineDrafts, setInlineDrafts] = createSignal<Record<string, string>>({})
  const [inlineSendingRootId, setInlineSendingRootId] = createSignal<string | null>(null)
  const [rosterOpen, setRosterOpen] = createSignal(false)
  const [channelDirectoryOpen, setChannelDirectoryOpen] = createSignal(false)
  const [channelDirectoryMode, setChannelDirectoryMode] = createSignal<'channels' | 'dms'>('channels')
  const [peekExecutionId, setPeekExecutionId] = createSignal<string | null>(null)
  const [executionPeek, setExecutionPeek] = createSignal<ChannelExecutionPeek | null>(null)
  const [peekLoading, setPeekLoading] = createSignal(false)
  const [peekError, setPeekError] = createSignal('')
  const [restartingExecutionId, setRestartingExecutionId] = createSignal<string | null>(null)
  const [attentionAction, setAttentionAction] = createSignal<'follow' | 'done' | 'snooze' | null>(null)
  const [dialog, setDialog] = createSignal<DialogKind>(null)
  const [dialogValue, setDialogValue] = createSignal('')
  const [dialogTitle, setDialogTitle] = createSignal('')
  const [dialogError, setDialogError] = createSignal('')
  const [dialogBusy, setDialogBusy] = createSignal(false)
  const [editingTitle, setEditingTitle] = createSignal(false)
  const [titleDraft, setTitleDraft] = createSignal('')
  const [activityNeedsOnly, setActivityNeedsOnly] = createSignal(false)
  const [pushState, setPushState] = createSignal<'idle' | 'enabling' | 'enabled' | 'denied' | 'error' | 'unavailable'>('idle')
  const [announcement, setAnnouncement] = createSignal('')
  const [restartNotice, setRestartNotice] = createSignal('')
  let refreshTimer: number | undefined
  let restartNoticeTimer: number | undefined
  let peekTimer: number | undefined
  let threadScroller: HTMLElement | undefined
  let rootComposer: HTMLTextAreaElement | undefined
  let replyComposer: HTMLTextAreaElement | undefined
  const inlineComposers = new Map<string, HTMLTextAreaElement>()
  let cancellingTitleEdit = false

  function updateRootDraft(value: string) {
    setRootDraft(value)
    const channelId = selectedChannelId()
    if (!channelId) return
    try {
      if (value) localStorage.setItem(channelDraftKey(channelId), value)
      else localStorage.removeItem(channelDraftKey(channelId))
    } catch {}
  }
  let loadGeneration = 0
  let threadLoadRequest = 0
  const readMessageByThread = new Map<string, string>()

  const allChannels = createMemo(() => [...snapshot().channels, ...snapshot().dms])
  const selectedChannel = createMemo(() => allChannels().find(channel => channel.id === selectedChannelId()) || null)
  const agents = createMemo(() => selectedChannel()?.members.filter(member => member.kind === 'agent') || [])
  const visibleActivity = createMemo(() => activityNeedsOnly()
    ? activity().items.filter(item => item.kind === 'needs_you' || item.kind === 'failure' || item.kind === 'mention')
    : activity().items)
  const currentHumanIsOwner = createMemo(() => selectedChannel()?.members.some(member => member.id === snapshot().principal?.id && member.role === 'owner'))
  const notificationDisabled = createMemo(() => ['enabling', 'enabled', 'denied', 'unavailable'].includes(pushState()))
  const notificationLabel = createMemo(() => {
    if (pushState() === 'enabled') return 'Notifications on'
    if (pushState() === 'enabling') return 'Enabling notifications…'
    if (pushState() === 'denied') return 'Notifications blocked'
    if (pushState() === 'unavailable') return 'Notifications unavailable'
    if (pushState() === 'error') return 'Try notifications again'
    return 'Turn on notifications'
  })
  const notificationHint = createMemo(() => pushState() === 'denied'
    ? 'Allow notifications in browser settings'
    : notificationLabel())

  function updateLocation(nextSection = section(), channelId = selectedChannelId(), rootId = thread()?.id || null, mode: 'replace' | 'push' = 'replace') {
    const url = new URL(location.href)
    url.searchParams.set('surface', 'channels')
    url.searchParams.set('view', nextSection)
    if (channelId) url.searchParams.set('channel', channelId)
    else url.searchParams.delete('channel')
    if (rootId) url.searchParams.set('thread', rootId)
    else url.searchParams.delete('thread')
    const state = { channels: true, view: nextSection, channelId, channelThread: rootId, channelThreadPushed: mode === 'push' }
    if (mode === 'push') history.pushState(state, '', `${url.pathname}${url.search}`)
    else history.replaceState(state, '', `${url.pathname}${url.search}`)
  }

  async function loadRoots(channelId: string, generation = loadGeneration) {
    const messages = await fetchChannelMessages(channelId)
    if (generation !== loadGeneration || selectedChannelId() !== channelId) return
    setRoots(messages)
  }

  async function loadInlineThread(channelId: string, rootId: string, generation = loadGeneration) {
    const next = await fetchChannelThread(channelId, rootId)
    if (generation !== loadGeneration || selectedChannelId() !== channelId || !expandedThreadIds().has(rootId)) return
    setInlineThreads(current => ({ ...current, [rootId]: next }))
  }

  function inlineRepliesFor(message: ChannelMessage) {
    return inlineThreads()[message.threadRootId]?.messages.slice(1) || message.replies || []
  }

  async function loadThread(channelId: string, rootId: string, generation = loadGeneration, request = threadLoadRequest) {
    const next = await fetchChannelThread(channelId, rootId)
    if (generation !== loadGeneration || request !== threadLoadRequest || selectedChannelId() !== channelId) return
    const openingThread = thread()?.id !== rootId
    const pinnedToLatest = !threadScroller
      || threadScroller.scrollHeight - threadScroller.scrollTop - threadScroller.clientHeight < 96
    setThread(next)
    setTitleDraft(next.title)
    if (openingThread || pinnedToLatest) {
      queueMicrotask(() => requestAnimationFrame(() => {
        if (thread()?.id !== rootId || !threadScroller) return
        const messages = threadScroller.querySelectorAll<HTMLElement>(':scope > .channel-message')
        const latest = messages.item(messages.length - 1)
        if (latest && latest.offsetHeight > threadScroller.clientHeight - 24) {
          latest.scrollIntoView({ block: 'start' })
        } else {
          threadScroller.scrollTop = threadScroller.scrollHeight
        }
      }))
    }
    const lastMessageId = next.messages.at(-1)?.id
    if (lastMessageId && readMessageByThread.get(rootId) !== lastMessageId) {
      readMessageByThread.set(rootId, lastMessageId)
      await updateChannelAttention(channelId, rootId, 'read').catch(() => {
        if (readMessageByThread.get(rootId) === lastMessageId) readMessageByThread.delete(rootId)
      })
    }
  }

  async function refresh(options: { initial?: boolean } = {}) {
    const generation = ++loadGeneration
    options.initial ? setLoading(true) : setRefreshing(true)
    setError('')
    try {
      const [nextSnapshot, nextActivity, nextPrincipals] = await Promise.all([
        fetchChannels(),
        fetchChannelActivity(),
        fetchChannelPrincipals(),
      ])
      if (generation !== loadGeneration) return
      setSnapshot(nextSnapshot)
      setActivity(nextActivity)
      setPrincipals(nextPrincipals)
      const requested = selectedChannelId()
      const fallback = section() === 'dms'
        ? nextSnapshot.dms[0]?.id || null
        : nextSnapshot.channels[0]?.id || nextSnapshot.dms[0]?.id || null
      const channelId = [...nextSnapshot.channels, ...nextSnapshot.dms].some(item => item.id === requested) ? requested : fallback
      const rootId = channelId ? thread()?.id || new URLSearchParams(location.search).get('thread') : null
      setSelectedChannelId(channelId)
      if (channelId !== requested) setRootDraft(loadChannelDraft(channelId))
      if (channelId) {
        await loadRoots(channelId, generation)
        await Promise.all([...expandedThreadIds()].map(expandedId =>
          loadInlineThread(channelId, expandedId, generation).catch(() => {})))
        if (rootId) await loadThread(channelId, rootId, generation).catch(() => setThread(null))
      } else {
        setRoots([])
        setThread(null)
      }
      if (options.initial) updateLocation(section(), channelId, rootId, 'replace')
      const badge = nextActivity.unread
      const appNavigator = navigator as Navigator & { setAppBadge?: (count?: number) => Promise<void>; clearAppBadge?: () => Promise<void> }
      if (badge > 0) appNavigator.setAppBadge?.(badge).catch(() => {})
      else appNavigator.clearAppBadge?.().catch(() => {})
      document.title = badge ? `(${badge}) Fledge` : 'Fledge'
    } catch (reason) {
      if (generation === loadGeneration) setError(reason instanceof Error ? reason.message : 'Channels could not be loaded')
    } finally {
      if (generation === loadGeneration) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }

  function queueRefresh() {
    clearTimeout(refreshTimer)
    refreshTimer = window.setTimeout(() => void refresh(), 140)
  }

  function openChannelDirectory(mode: 'channels' | 'dms' = 'channels') {
    setRosterOpen(false)
    setChannelDirectoryMode(mode)
    setChannelDirectoryOpen(true)
  }

  async function chooseChannel(channel: ChannelInfo, nextSection: ChannelSection = channel.type === 'dm' ? 'dms' : 'channels') {
    setRootDraft(loadChannelDraft(channel.id))
    ++loadGeneration
    ++threadLoadRequest
    setSelectedChannelId(channel.id)
    setSection(nextSection)
    setThread(null)
    setExpandedThreadIds(new Set())
    setExpandedMessageIds(new Set())
    setInlineThreads({})
    setRosterOpen(false)
    setChannelDirectoryOpen(false)
    setRoots([])
    setLoading(true)
    updateLocation(nextSection, channel.id, null, 'push')
    try {
      await loadRoots(channel.id)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Conversation could not be loaded')
    } finally {
      setLoading(false)
    }
  }

  async function openThread(rootId: string, channelId = selectedChannelId()) {
    if (!channelId) return
    const request = ++threadLoadRequest
    setError('')
    try {
      await loadThread(channelId, rootId, loadGeneration, request)
      if (request === threadLoadRequest && selectedChannelId() === channelId && thread()?.id === rootId) {
        updateLocation(section(), channelId, rootId, 'push')
      }
    } catch (reason) {
      if (request === threadLoadRequest) setError(reason instanceof Error ? reason.message : 'Thread could not be loaded')
    }
  }

  function closeThread() {
    ++threadLoadRequest
    const rootId = thread()?.id
    setThread(null)
    setEditingTitle(false)
    if (rootId && history.state?.channelThread === rootId && history.state?.channelThreadPushed && history.length > 1) history.back()
    else updateLocation(section(), selectedChannelId(), null, 'replace')
  }
  function addImages(inReply: boolean, images: File[]) {
    const current = inReply ? replyImages() : rootImages()
    const supported = images.filter(file => CHANNEL_IMAGE_TYPES.has(file.type) && file.size <= MAX_CHANNEL_IMAGE_BYTES)
    if (supported.length !== images.length) {
      setError('Attach PNG, JPEG, GIF, or WebP images up to 15 MB each.')
    }
    const additions = supported.slice(0, Math.max(0, MAX_CHANNEL_IMAGES - current.length))
      .map(file => ({ id: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file) }))
    if (!additions.length) return
    const setter = inReply ? setReplyImages : setRootImages
    setter(existing => [...existing, ...additions])
    setAnnouncement(`${additions.length} image${additions.length === 1 ? '' : 's'} attached.`)
  }

  function removeImage(inReply: boolean, id: string) {
    const images = inReply ? replyImages : rootImages
    const setter = inReply ? setReplyImages : setRootImages
    const removed = images().find(image => image.id === id)
    if (removed) URL.revokeObjectURL(removed.previewUrl)
    setter(current => current.filter(image => image.id !== id))
  }

  function clearImages(inReply: boolean) {
    const images = inReply ? replyImages : rootImages
    const setter = inReply ? setReplyImages : setRootImages
    for (const image of images()) URL.revokeObjectURL(image.previewUrl)
    setter([])
  }

  function pasteImages(event: ClipboardEvent & { currentTarget: HTMLTextAreaElement }, inReply: boolean) {
    const clipboard = event.clipboardData
    if (!clipboard) return
    const itemImages = [...clipboard.items]
      .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
      .map(item => item.getAsFile())
      .filter((file): file is File => !!file)
    const images = itemImages.length
      ? itemImages
      : [...clipboard.files].filter(file => file.type.startsWith('image/'))
    if (!images.length) return

    event.preventDefault()
    const pastedText = clipboard.getData('text/plain')
    if (pastedText) {
      const value = inReply ? replyDraft() : rootDraft()
      const setter = inReply ? setReplyDraft : updateRootDraft
      const start = event.currentTarget.selectionStart ?? value.length
      const end = event.currentTarget.selectionEnd ?? start
      setter(`${value.slice(0, start)}${pastedText}${value.slice(end)}`)
      queueMicrotask(() => event.currentTarget.setSelectionRange(start + pastedText.length, start + pastedText.length))
    }
    addImages(inReply, images)
  }

  async function contentWithImages(channelId: string, content: string, images: PendingChannelImage[]) {
    const parts = content ? [content] : []
    const attachments = await Promise.all(images.map(image =>
      uploadChannelImage(channelId, image.file, image.id)))
    for (const attachment of attachments) {
      const alt = (attachment.filename || 'pasted image').replace(/[[\]\\]/g, '_')
      parts.push(`![${alt}](<${attachment.url.replace(/>/g, '%3E')}>)`)
    }
    return parts.join('\n\n')
  }

  async function sendRoot() {
    const channelId = selectedChannelId()
    const draft = rootDraft().trim()
    const images = rootImages()
    if (!channelId || (!draft && !images.length) || sending()) return
    setSending(true)
    setError('')
    try {
      const content = await contentWithImages(channelId, draft, images)
      const message = await postChannelMessage(channelId, content)
      updateRootDraft('')
      clearImages(false)
      await loadRoots(channelId)
      setExpandedThreadIds(current => new Set(current).add(message.threadRootId))
      setAnnouncement('Message delivered. Reply inline or open Focus for the full thread.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Message was not sent. Your draft is unchanged.')
    } finally {
      setSending(false)
    }
  }

  async function sendReply() {
    const current = thread()
    const draft = replyDraft().trim()
    const images = replyImages()
    if (!current || (!draft && !images.length) || sending()) return
    setSending(true)
    setError('')
    try {
      const content = await contentWithImages(current.channelId, draft, images)
      await postChannelMessage(current.channelId, content, current.id, current.messages.at(-1)?.id)
      setReplyDraft('')
      clearImages(true)
      await Promise.all([loadThread(current.channelId, current.id), loadRoots(current.channelId)])
      setAnnouncement('Reply delivered.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Reply was not sent. Your draft is unchanged.')
    } finally {
      setSending(false)
    }
  }

  function toggleInlineThread(message: ChannelMessage) {
    const opening = !expandedThreadIds().has(message.threadRootId)
    setExpandedThreadIds(current => {
      const next = new Set(current)
      if (opening) next.add(message.threadRootId)
      else next.delete(message.threadRootId)
      return next
    })
    if (!opening) {
      inlineComposers.delete(message.threadRootId)
      return
    }
    void loadInlineThread(message.channelId, message.threadRootId).catch(() => {})
    const lastMessageId = message.replies?.at(-1)?.id
    if (lastMessageId && readMessageByThread.get(message.threadRootId) !== lastMessageId) {
      readMessageByThread.set(message.threadRootId, lastMessageId)
      void updateChannelAttention(message.channelId, message.threadRootId, 'read').catch(() => {
        if (readMessageByThread.get(message.threadRootId) === lastMessageId) readMessageByThread.delete(message.threadRootId)
      })
    }
  }

  async function sendInlineReply(message: ChannelMessage) {
    const rootId = message.threadRootId
    const draft = (inlineDrafts()[rootId] || '').trim()
    if (!draft || inlineSendingRootId()) return
    setInlineSendingRootId(rootId)
    setError('')
    try {
      await postChannelMessage(message.channelId, draft, rootId, inlineRepliesFor(message).at(-1)?.id || message.id)
      setInlineDrafts(current => ({ ...current, [rootId]: '' }))
      await Promise.all([loadRoots(message.channelId), loadInlineThread(message.channelId, rootId)])
      if (thread()?.id === rootId) await loadThread(message.channelId, rootId)
      setAnnouncement('Reply delivered.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Reply was not sent. Your draft is unchanged.')
    } finally {
      setInlineSendingRootId(null)
    }
  }

  function mentionInline(agent: ChannelPrincipal, rootId: string) {
    const current = inlineDrafts()[rootId] || ''
    setInlineDrafts(drafts => ({
      ...drafts,
      [rootId]: `${current}${current && !/\s$/.test(current) ? ' ' : ''}@${agent.username} `,
    }))
    queueMicrotask(() => inlineComposers.get(rootId)?.focus())
  }

  function mention(agent: ChannelPrincipal, inReply: boolean) {
    const setter = inReply ? setReplyDraft : updateRootDraft
    const current = inReply ? replyDraft() : rootDraft()
    setter(`${current}${current && !/\s$/.test(current) ? ' ' : ''}@${agent.username} `)
    queueMicrotask(() => (inReply ? replyComposer : rootComposer)?.focus())
  }

  async function loadExecutionPeek(executionId: string) {
    try {
      const next = await fetchChannelExecutionPeek(executionId)
      if (peekExecutionId() !== executionId) return
      setExecutionPeek(next)
      setPeekError('')
      if (next.execution.state !== 'running') clearInterval(peekTimer)
    } catch (reason) {
      if (peekExecutionId() === executionId) {
        setPeekError(reason instanceof Error ? reason.message : 'Live agent activity is unavailable')
      }
    } finally {
      if (peekExecutionId() === executionId) setPeekLoading(false)
    }
  }

  function openExecutionPeek(execution: ChannelExecution) {
    clearInterval(peekTimer)
    setPeekExecutionId(execution.id)
    setExecutionPeek(null)
    setPeekError('')
    setPeekLoading(true)
    void loadExecutionPeek(execution.id)
    peekTimer = window.setInterval(() => void loadExecutionPeek(execution.id), 1_500)
  }

  function closeExecutionPeek() {
    clearInterval(peekTimer)
    setPeekExecutionId(null)
    setExecutionPeek(null)
    setPeekError('')
    setPeekLoading(false)
  }

  async function restartExecution(executionId: string) {
    if (restartingExecutionId()) return
    const agent = roots().map(root => root.thread?.recovery).find(recovery => recovery?.id === executionId)?.agent
      || thread()?.executions.find(execution => execution.id === executionId)?.agent
    const showQueued = () => {
      if (!agent) return
      const queued = { queuedAgents: [agent], activeAgents: [], queuedCount: 1, activeCount: 0 }
      setRoots(current => current.map(root => root.thread?.recovery?.id === executionId
        ? { ...root, thread: { ...root.thread, state: 'working', recovery: null, delivery: queued } }
        : root))
      setThread(current => {
        const stale = current?.executions.find(execution => execution.id === executionId && execution.canRestart)
        return current && stale
          ? { ...current, state: 'working', delivery: queued, executions: current.executions.map(execution => execution.id === executionId ? { ...execution, canRestart: false } : execution) }
          : current
      })
    }
    setRestartingExecutionId(executionId)
    try {
      await restartChannelExecution(executionId)
      closeExecutionPeek()
      showQueued()
      await refresh()
      showQueued()
      props.onCloseMenu()
      clearTimeout(restartNoticeTimer)
      setRestartNotice(`Restart queued for ${agent?.displayName || 'agent'}.`)
      restartNoticeTimer = window.setTimeout(() => setRestartNotice(''), 6_000)
      setAnnouncement('Agent turn restarted. A new Working now attempt will appear.')
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Agent turn could not be restarted'
      if (peekExecutionId() === executionId) setPeekError(message)
      else setError(message)
    } finally {
      setRestartingExecutionId(null)
    }
  }

  function startThreadTitleEdit() {
    const current = thread()
    if (!current) return
    cancellingTitleEdit = false
    setTitleDraft(current.title)
    setEditingTitle(true)
  }

  function cancelThreadTitleEdit() {
    cancellingTitleEdit = true
    setTitleDraft(thread()?.title || '')
    setEditingTitle(false)
    queueMicrotask(() => { cancellingTitleEdit = false })
  }

  async function saveThreadTitle() {
    if (cancellingTitleEdit) return
    const current = thread()
    const title = titleDraft().trim()
    if (!current || !title || title === current.title) {
      setEditingTitle(false)
      return
    }
    try {
      const updated = await updateChannelThread(current.channelId, current.id, { title })
      setThread(updated)
      setEditingTitle(false)
      await loadRoots(current.channelId)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Thread title was not saved')
    }
  }

  async function setAttention(action: 'follow' | 'done' | 'snooze', value = true) {
    const current = thread()
    if (!current || attentionAction()) return
    const until = action === 'snooze' && value ? new Date(Date.now() + 60 * 60 * 1000).toISOString() : null
    const optimistic = {
      ...current,
      ...(action === 'follow' ? { following: value } : {}),
      ...(action === 'done' ? { doneAt: value ? new Date().toISOString() : null } : {}),
      ...(action === 'snooze' ? { snoozedUntil: until } : {}),
    }
    setAttentionAction(action)
    setThread(optimistic)
    try {
      setThread(await updateChannelAttention(current.channelId, current.id, action, value, until))
      queueRefresh()
    } catch (reason) {
      if (thread()?.id === current.id) setThread(current)
      setError(reason instanceof Error ? reason.message : 'Thread state could not be changed')
    } finally {
      setAttentionAction(null)
    }
  }

  async function finishActivity(item: ChannelActivityItem, snooze = false) {
    if (!item.thread) return
    try {
      await updateChannelAttention(item.channel.id, item.thread.id, snooze ? 'snooze' : 'done', true,
        snooze ? new Date(Date.now() + 60 * 60 * 1000).toISOString() : null)
      setActivity(current => {
        const items = current.items.filter(candidate => candidate.thread?.id !== item.thread?.id)
        return { ...current, items, unread: items.filter(candidate => !candidate.readAt).length }
      })
      queueRefresh()
      setAnnouncement(snooze ? 'Thread snoozed for one hour.' : 'Thread marked done.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Activity state could not be changed')
    }
  }

  async function openActivity(item: ChannelActivityItem) {
    const channel = allChannels().find(candidate => candidate.id === item.channel.id)
    if (!channel || !item.thread) return
    await chooseChannel(channel, channel.type === 'dm' ? 'dms' : 'channels')
    await openThread(item.thread.id, channel.id)
  }

  function openDialog(kind: Exclude<DialogKind, null>) {
    setDialog(kind)
    queueMicrotask(() => document.querySelector<HTMLElement>('.channel-dialog input, .channel-dialog button')?.focus())
    setDialogValue('')
    setDialogTitle('')
    setDialogError('')
  }

  async function submitDialog() {
    const kind = dialog()
    const value = dialogValue().trim()
    if (!kind || !value || dialogBusy()) return
    setDialogBusy(true)
    setDialogError('')
    try {
      if (kind === 'channel') {
        const slug = value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
        const result = await createChannel({ slug, title: dialogTitle().trim() || value })
        await refresh()
        await chooseChannel(result.channel)
        if (result.staffing.status === 'failed') {
          setError(`Channel created, but its agents could not start: ${result.staffing.error || 'unknown error'}`)
        }
      } else if (kind === 'members') {
        const channel = selectedChannel()
        if (!channel) return
        await addChannelMember(channel.id, value.toLowerCase())
        await refresh()
      }
      setDialog(null)
    } catch (reason) {
      setDialogError(reason instanceof Error ? reason.message : 'Could not complete that action')
    } finally {
      setDialogBusy(false)
    }
  }

  async function startDm(principal: ChannelPrincipal) {
    if (dialogBusy()) return
    setDialogBusy(true)
    setDialogError('')
    try {
      const channel = await createChannelDm(principal.id)
      setDialog(null)
      await refresh()
      await chooseChannel(channel, 'dms')
    } catch (reason) {
      setDialogError(reason instanceof Error ? reason.message : 'Direct message could not be opened')
    } finally {
      setDialogBusy(false)
    }
  }


  async function enableNotifications() {
    if (pushState() !== 'idle' && pushState() !== 'error') return
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      setPushState('unavailable')
      setAnnouncement('This browser does not support push notifications.')
      return
    }
    if (Notification.permission === 'denied') {
      setPushState('denied')
      setAnnouncement('Notifications are blocked. Allow them in browser settings.')
      return
    }
    setPushState('enabling')
    try {
      const permission = await boundedBrowserWait(Notification.requestPermission(), 'Notification permission timed out')
      if (permission !== 'granted') {
        setAnnouncement('Notifications are blocked. Allow them in browser settings.')
        setPushState('denied')
        return
      }
      const registration = await boundedBrowserWait(navigator.serviceWorker.ready, 'Notification service did not become ready')
      const response = await fetch(appUrl('/api/push/key'))
      const body = await response.json()
      if (!response.ok || typeof body.key !== 'string') throw new Error(body.error || 'Push key unavailable')
      const subscription = await registration.pushManager.getSubscription() || await boundedBrowserWait(
        registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: pushKey(body.key),
        }),
        'Notification subscription timed out',
      )
      const saved = await fetch(appUrl('/api/push/subscribe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription.toJSON()),
      })
      if (!saved.ok) throw new Error('Subscription could not be saved')
      setPushState('enabled')
      setAnnouncement('Notifications are on for mentions, direct messages, failures, and agent replies you asked for.')
    } catch {
      setPushState('error')
      setAnnouncement('Notifications could not be enabled. Try again.')
    }
  }

  async function restoreLocation() {
    const params = new URLSearchParams(location.search)
    const nextSection = channelSection(params)
    const listed = allChannels()
    const requestedChannel = params.get('channel')
    const fallback = nextSection === 'dms'
      ? snapshot().dms[0]?.id || null
      : snapshot().channels[0]?.id || snapshot().dms[0]?.id || null
    const channelId = listed.some(channel => channel.id === requestedChannel) ? requestedChannel : fallback
    const rootId = params.get('thread')
    const changedChannel = channelId !== selectedChannelId()
    const generation = ++loadGeneration
    const request = ++threadLoadRequest
    setSection(nextSection)
    setSelectedChannelId(channelId)
    if (changedChannel) {
      setExpandedThreadIds(new Set())
      setExpandedMessageIds(new Set())
      setInlineThreads({})
      setRosterOpen(false)
    }
    setThread(null)
    if (!channelId) {
      setRoots([])
      return
    }
    try {
      if (changedChannel) {
        setLoading(true)
        setRoots([])
        await loadRoots(channelId, generation)
      }
      if (rootId) await loadThread(channelId, rootId, generation, request)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Navigation could not be restored')
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    void refresh({ initial: true })
    const onPopState = () => { void restoreLocation() }
    const onVisibilityChange = () => { if (!document.hidden) queueRefresh() }
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (peekExecutionId()) {
        event.preventDefault()
        closeExecutionPeek()
      } else if (dialog()) {
        event.preventDefault()
        setDialog(null)
      } else if (channelDirectoryOpen()) {
        event.preventDefault()
        setChannelDirectoryOpen(false)
      } else if (rosterOpen()) {
        event.preventDefault()
        setRosterOpen(false)
      } else if (thread()) {
        event.preventDefault()
        closeThread()
      }
    }
    window.addEventListener('popstate', onPopState)
    window.addEventListener('keydown', onEscape)
    document.addEventListener('visibilitychange', onVisibilityChange)
    const unsubscribe = subscribeChannels(queueRefresh)
    if ('Notification' in window && Notification.permission === 'granted' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.ready
        .then(registration => registration.pushManager.getSubscription())
        .then(subscription => { if (subscription) setPushState('enabled') })
        .catch(() => {})
    }
    onCleanup(() => {
      unsubscribe()
      clearTimeout(refreshTimer)
      clearTimeout(restartNoticeTimer)
      clearInterval(peekTimer)
      window.removeEventListener('popstate', onPopState)
      window.removeEventListener('keydown', onEscape)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      for (const image of [...rootImages(), ...replyImages()]) URL.revokeObjectURL(image.previewUrl)
    })
  })

  const navigate = (next: ChannelSection) => {
    const expectedType = next === 'channels' ? 'channel' : next === 'dms' ? 'dm' : null
    if (expectedType && selectedChannel()?.type !== expectedType) {
      const target = expectedType === 'channel' ? snapshot().channels[0] : snapshot().dms[0]
      if (target) {
        void chooseChannel(target, next)
        return
      }
      ++loadGeneration
      setSelectedChannelId(null)
      setRoots([])
    }
    setSection(next)
    setThread(null)
    updateLocation(next, selectedChannelId(), null, 'push')
  }

  const renderComposer = (inReply = false) => {
    const value = inReply ? replyDraft : rootDraft
    const setter = inReply ? setReplyDraft : updateRootDraft
    const images = inReply ? replyImages : rootImages
    let imageInput: HTMLInputElement | undefined
    return (
      <div class="channel-compose-wrap">
        <Show when={agents().length > 0}>
          <div class="channel-mention-row" aria-label="Mention an agent">
            <span>Bring in</span>
            <For each={agents()}>{agent => (
              <button type="button" onClick={() => mention(agent, inReply)}>@{agent.username}</button>
            )}</For>
          </div>
        </Show>
        <Show when={images().length > 0}>
          <div class="channel-image-previews" aria-label="Attached images">
            <For each={images()}>{image => (
              <div class="channel-image-preview">
                <img src={image.previewUrl} alt={image.file.name || 'Pasted image'} />
                <button type="button" onClick={() => removeImage(inReply, image.id)} aria-label={`Remove ${image.file.name || 'pasted image'}`}>&times;</button>
              </div>
            )}</For>
          </div>
        </Show>
        <div class="channel-composer" classList={{ 'channel-composer-thread': inReply }}>
          <input
            ref={imageInput}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={event => {
              if (event.currentTarget.files?.length) addImages(inReply, [...event.currentTarget.files])
              event.currentTarget.value = ''
            }}
          />
          <button type="button" class="channel-attach" onClick={() => imageInput?.click()} aria-label="Attach images">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 12.5 14 7a3 3 0 1 1 4.2 4.2l-7.1 7.1a5 5 0 0 1-7.1-7.1l7.4-7.4" /></svg>
          </button>
          <textarea
            ref={element => { if (inReply) replyComposer = element; else rootComposer = element }}
            value={value()}
            onInput={event => setter(event.currentTarget.value)}
            onPaste={event => pasteImages(event, inReply)}
            onKeyDown={event => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault()
                void (inReply ? sendReply() : sendRoot())
              }
            }}
            rows={inReply ? 2 : 3}
            placeholder={inReply ? 'Reply in this thread' : selectedChannel()?.type === 'dm' ? `Message ${dmName(selectedChannel()!, snapshot().principal?.id)}` : `Message #${selectedChannel()?.slug || ''}`}
            aria-label={inReply ? 'Thread reply' : 'New channel message'}
          />
          <button
            type="button"
            class="channel-send"
            onClick={() => void (inReply ? sendReply() : sendRoot())}
            disabled={sending() || (!value().trim() && !images().length)}
            aria-label={sending() ? 'Sending' : 'Send message'}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 4 17 8-17 8 3-8-3-8Zm3 8h14" /></svg>
          </button>
        </div>
        <span class="channel-compose-hint">Ctrl/⌘ + Enter to send</span>
      </div>
    )
  }

  const renderDelivery = (delivery?: ChannelDelivery) => {
    if (!delivery || (!delivery.activeCount && !delivery.queuedCount)) return null
    const activeNames = delivery.activeAgents.map(agent => agent.displayName).join(' + ')
    const queuedNames = delivery.queuedAgents.map(agent => agent.displayName).join(' + ')
    return (
      <div class="channel-delivery-status" aria-label="Agent delivery status">
        <Show when={delivery.activeCount > 0}>
          <span class="channel-delivery-active">👀 {activeNames || 'Agent'} {delivery.activeCount === 1 ? 'is' : 'are'} working</span>
        </Show>
        <Show when={delivery.queuedCount > 0}>
          <span>{delivery.activeCount ? `${delivery.queuedCount} ${delivery.queuedCount === 1 ? 'reply' : 'replies'} queued for ${queuedNames || 'agent'}` : `Queued for ${queuedNames || 'agent'}`}</span>
        </Show>
      </div>
    )
  }

  const renderExecution = (execution: ChannelExecution) => (
    <div class="channel-execution">
      <PersonMark person={{ ...execution.agent, kind: 'agent' }} small />
      <div>
        <b>@{execution.agent.username}</b>
        <span>{execution.state === 'running' ? 'Working now' : execution.state === 'done' ? 'Completed' : execution.state === 'error' && execution.error === 'Server restarted during execution' ? 'Interrupted by update · retried automatically' : execution.state === 'error' ? 'Failed' : 'Stopped'}</span>
        <Show when={execution.error && execution.error !== 'Server restarted during execution'}><p>{execution.error}</p></Show>
      </div>
      <Show when={execution.state === 'running'}>
        <div class="channel-execution-actions">
          <button type="button" class="channel-peek-action" onClick={() => openExecutionPeek(execution)}>Peek</button>
          <Show when={execution.canRestart}>
            <button type="button" class="channel-restart-action" disabled={restartingExecutionId() === execution.id} onClick={() => void restartExecution(execution.id)}>
              {restartingExecutionId() === execution.id ? 'Restarting…' : 'Restart turn'}
            </button>
          </Show>
          <button type="button" onClick={async () => { await cancelChannelExecution(execution.id); queueRefresh() }}>Stop</button>
        </div>
      </Show>
    </div>
  )

  const renderMessage = (message: ChannelMessage, inThread = false) => (
    <article class="channel-message" classList={{ 'channel-message-agent': message.author.kind === 'agent', 'channel-message-system': message.messageType === 'system' }}>
      <PersonMark person={message.author} />
      <div class="channel-message-content">
        <header>
          <Identity person={message.author} />
          <time dateTime={message.createdAt}>{relativeTime(message.createdAt)}</time>
        </header>
        <div class="channel-message-body" classList={{ 'channel-message-body-collapsed': !inThread && message.content.length > 520 && !expandedMessageIds().has(message.id) }}><RichMarkdown text={message.content} /></div>
        <Show when={!inThread && message.content.length > 520}>
          <button type="button" class="channel-message-expand" aria-expanded={expandedMessageIds().has(message.id)} onClick={() => setExpandedMessageIds(current => {
            const next = new Set(current)
            if (next.has(message.id)) next.delete(message.id)
            else next.add(message.id)
            return next
          })}>{expandedMessageIds().has(message.id) ? 'Show less' : 'Show full message'}</button>
        </Show>
        <Show when={!inThread && message.thread}>
          <div class="channel-root-footer">
            <div class="channel-participants" aria-label="Thread participants">
              <For each={[...new Map((message.replies || []).map(reply => [reply.author.id, reply.author])).values()].slice(0, 4)}>{person => <PersonMark person={person} small />}</For>
            </div>
            <button type="button" aria-expanded={expandedThreadIds().has(message.threadRootId)} onClick={() => toggleInlineThread(message)}>
              {expandedThreadIds().has(message.threadRootId)
                ? 'Hide replies'
                : message.thread!.replyCount
                  ? `${message.thread!.replyCount} ${message.thread!.replyCount === 1 ? 'reply' : 'replies'}`
                  : 'Reply'}
              <span aria-hidden="true">{expandedThreadIds().has(message.threadRootId) ? '↑' : '↓'}</span>
            </button>
            <button type="button" class="channel-focus-thread" onClick={() => void openThread(message.threadRootId)} aria-label={`Focus thread: ${message.thread!.title}`}>
              Focus <span aria-hidden="true">↗</span>
            </button>
            <Show when={message.thread!.state !== 'open'}>
              <span class={`channel-state channel-state-${message.thread!.state}`}>{message.thread!.state.replace('_', ' ')}</span>
            </Show>
            <Show when={message.thread!.unread}><span class="channel-unread-dot" title="Unread replies" /></Show>
          </div>
          {renderDelivery(message.thread!.delivery)}
          <Show when={message.thread!.recovery}>{failed => (
            <section class="channel-turn-recovery channel-root-recovery" role="alert">
              <div><b>{failed().agent.displayName} stopped.</b><span>{failed().error || 'The turn did not complete.'}</span></div>
              <button type="button" disabled={restartingExecutionId() === failed().id} onClick={event => { event.stopPropagation(); void restartExecution(failed().id) }}>
                {restartingExecutionId() === failed().id ? 'Restarting…' : 'Restart turn'}
              </button>
            </section>
          )}</Show>
          <Show when={!expandedThreadIds().has(message.threadRootId) && (message.replies || []).length > 0}>
            <button class="channel-reply-preview" type="button" onClick={() => toggleInlineThread(message)}>
              <PersonMark person={message.replies!.at(-1)!.author} small />
              <span><b>{message.replies!.at(-1)!.author.displayName}</b> {message.replies!.at(-1)!.content.replace(/[#*_`]/g, '').slice(0, 150)}</span>
            </button>
          </Show>
          <Show when={expandedThreadIds().has(message.threadRootId)}>
            <section class="channel-inline-thread" aria-label={`Expanded thread: ${message.thread!.title}`}>
              <Show when={inlineRepliesFor(message).length > 0} fallback={<p class="channel-inline-empty">No replies yet. Continue the thread here.</p>}>
                <Index each={inlineRepliesFor(message)}>{reply => renderMessage(reply(), true)}</Index>
              </Show>
              <Show when={agents().length > 0}>
                <div class="channel-inline-mentions">
                  <span>Bring in</span>
                  <For each={agents()}>{agent => (
                    <button type="button" onClick={() => mentionInline(agent, message.threadRootId)}>@{agent.username}</button>
                  )}</For>
                </div>
              </Show>
              <form class="channel-inline-reply" onSubmit={event => { event.preventDefault(); void sendInlineReply(message) }}>
                <textarea
                  ref={element => { inlineComposers.set(message.threadRootId, element) }}
                  value={inlineDrafts()[message.threadRootId] || ''}
                  onInput={event => setInlineDrafts(current => ({ ...current, [message.threadRootId]: event.currentTarget.value }))}
                  onKeyDown={event => {
                    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                      event.preventDefault()
                      void sendInlineReply(message)
                    }
                  }}
                  rows={2}
                  placeholder="Reply in this thread"
                  aria-label={`Reply to thread: ${message.thread!.title}`}
                />
                <button type="submit" disabled={inlineSendingRootId() === message.threadRootId || !(inlineDrafts()[message.threadRootId] || '').trim()}>
                  {inlineSendingRootId() === message.threadRootId ? 'Sending…' : 'Reply'}
                </button>
              </form>
            </section>
          </Show>
        </Show>
      </div>
    </article>
  )

  return (
    <div class="channels-root" classList={{ 'channels-root-personal': props.showPersonal, 'channel-thread-open': !!thread() }} data-testid="channels-home">
      <p class="channel-sr-only" aria-live="polite">{announcement()}</p>

      <aside class="channels-rail" aria-label="Channels navigation">
        <div class="channels-brand">
          <button type="button" class="channels-menu" onClick={props.onMenu} aria-label="Open Feather menu"><span /><span /><span /></button>
          <div class="channels-brand-mark" aria-hidden="true"><span /><span /><span /></div>
          <div><small>Shared studio</small><strong>Fledge</strong></div>
        </div>

        <nav class="channels-primary-nav">
          <button type="button" classList={{ active: section() === 'activity' }} onClick={() => navigate('activity')}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14v14H5zM8 9h8M8 13h6M8 17h4" /></svg>
            <span>Activity</span>
            <Show when={activity().unread > 0}><b>{activity().unread}</b></Show>
          </button>
          <button type="button" classList={{ active: section() === 'threads' }} onClick={() => navigate('threads')}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4V5Zm4 4h8M8 12h5" /></svg>
            <span>Threads</span>
          </button>
        </nav>

        <div class="channels-nav-group">
          <div class="channels-nav-heading"><span>Channels</span><button type="button" onClick={() => openDialog('channel')} aria-label="Create channel">+</button></div>
          <For each={snapshot().channels}>{channel => (
            <button
              type="button"
              class="channels-channel-link"
              classList={{ active: selectedChannelId() === channel.id && section() === 'channels' }}
              onClick={() => void chooseChannel(channel)}
            >
              <span class="channels-hash">#</span><span>{channel.slug}</span>
              <Show when={channel.unread > 0}><b>{channel.unread}</b></Show>
            </button>
          )}</For>
        </div>

        <div class="channels-nav-group channels-dm-group">
          <div class="channels-nav-heading"><span>Direct messages</span><button type="button" onClick={() => openDialog('dm')} aria-label="Start direct message">+</button></div>
          <For each={snapshot().dms}>{channel => {
            const other = channel.members.find(member => member.id !== snapshot().principal?.id)
            return (
              <button
                type="button"
                class="channels-channel-link"
                classList={{ active: selectedChannelId() === channel.id && section() === 'dms' }}
                onClick={() => void chooseChannel(channel, 'dms')}
              >
                <Show when={other} fallback={<span class="channel-avatar channel-avatar-small">DM</span>}>{person => <PersonMark person={person()} small />}</Show>
                <span>{dmName(channel, snapshot().principal?.id)}</span>
                <Show when={channel.unread > 0}><b>{channel.unread}</b></Show>
              </button>
            )
          }}</For>
        </div>

        <div class="channels-rail-footer">
          <button type="button" class="channels-notify" classList={{ active: pushState() === 'enabled' }} onClick={() => void enableNotifications()} disabled={notificationDisabled()} title={notificationHint()} aria-label={notificationHint()}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 9a5 5 0 0 1 10 0c0 5 2 6 2 6H5s2-1 2-6Zm3 9h4" /></svg>
            <span>{notificationLabel()}</span>
          </button>
          <Show when={props.showPersonal}>
            <button type="button" onClick={props.onRooms}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h6l2 2h8v10H4V6Z" /></svg><span>Rooms</span>
            </button>
            <button type="button" onClick={props.onFeed}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14M5 12h10M5 19h7" /></svg><span>Run feed</span>
            </button>
          </Show>
        </div>
      </aside>

      <main class="channels-main">
        <Show when={error()}><div class="channel-error" role="alert"><span>{error()}</span><button type="button" onClick={() => setError('')}>Dismiss</button></div></Show>
        <Show when={restartNotice()}><div class="channel-restart-notice" role="status">{restartNotice()}</div></Show>

        <Show when={section() === 'activity'}>
          <header class="channel-view-header channel-activity-header">
            <div><small>Your inbox</small><h1>Activity</h1><p>Read is not done. Clear work when it no longer needs your attention.</p></div>
            <div class="channel-header-actions">
              <button type="button" classList={{ active: activityNeedsOnly() }} aria-pressed={activityNeedsOnly()} onClick={() => setActivityNeedsOnly(!activityNeedsOnly())}>Needs you <b>{activity().needsYou}</b></button>
              <button type="button" classList={{ active: pushState() === 'enabled' }} onClick={() => void enableNotifications()} disabled={notificationDisabled()} title={notificationHint()}>
                {pushState() === 'enabled' ? 'Alerts on' : pushState() === 'denied' ? 'Alerts blocked' : pushState() === 'unavailable' ? 'Alerts unavailable' : pushState() === 'error' ? 'Retry alerts' : pushState() === 'enabling' ? 'Enabling…' : 'Alerts'}
              </button>
              <button type="button" onClick={() => void refresh()} disabled={refreshing()}>{refreshing() ? 'Checking…' : 'Refresh'}</button>
            </div>
          </header>
          <section class="channel-activity-list" aria-label="Notification inbox">
            <Show when={!loading() && visibleActivity().length === 0}>
              <div class="channel-empty"><span class="channel-empty-rule" /><small>Inbox zero</small><h2>Nothing is waiting on you</h2><p>Mentions, direct messages, agent completions, and failures arrive here with the reason they need your attention.</p></div>
            </Show>
            <For each={visibleActivity()}>{item => (
              <article class="channel-activity-item" classList={{ unread: !item.readAt, urgent: item.kind === 'needs_you' || item.kind === 'failure' }}>
                <button type="button" class="channel-activity-open" onClick={() => void openActivity(item)}>
                  <Show when={item.actor}><PersonMark person={item.actor!} /></Show>
                  <div>
                    <div class="channel-activity-meta">
                      <span>{item.actor?.kind === 'agent' ? 'Agent' : 'Human'} · {item.channel.slug ? `#${item.channel.slug}` : 'Direct message'}{(item.updates || 0) > 1 ? ` · ${item.updates} updates` : ''}</span>
                      <time>{relativeTime(item.createdAt)}</time>
                    </div>
                    <h2>{item.thread?.title || item.channel.title}</h2>
                    <p class="channel-activity-reason">{item.reason}</p>
                    <p class="channel-activity-preview">{item.preview}</p>
                  </div>
                </button>
                <div class="channel-activity-actions">
                  <button type="button" onClick={() => void finishActivity(item, true)}>Snooze 1h</button>
                  <button type="button" class="primary" onClick={() => void finishActivity(item)}>Done</button>
                </div>
              </article>
            )}</For>
          </section>
        </Show>

        <Show when={section() === 'threads'}>
          <header class="channel-view-header">
            <div><small>{selectedChannel()?.slug ? `#${selectedChannel()!.slug}` : 'Current conversation'}</small><h1>Threads</h1><p>Every thread in this channel, ordered by its latest update.</p></div>
          </header>
          <section class="channel-thread-index">
            <For each={[...roots()].sort((a, b) => Date.parse(b.thread?.updatedAt || b.createdAt) - Date.parse(a.thread?.updatedAt || a.createdAt))}>{root => (
              <button type="button" class="channel-thread-index-row" onClick={() => void openThread(root.id)}>
                <span class={`channel-state channel-state-${root.thread?.state || 'open'}`}>{root.thread?.state?.replace('_', ' ') || 'open'}</span>
                <div><h2>{root.thread?.title}</h2><p>{root.content}</p></div>
                <span>{root.thread?.replyCount || 0} replies</span>
              </button>
            )}</For>
          </section>
        </Show>

        <Show when={section() === 'channels' || section() === 'dms'}>
          <Show when={selectedChannel()} fallback={
            <Show when={!loading()} fallback={
              <div class="channel-initial-loading" role="status" aria-label="Opening channels">
                <span /><span /><span />
              </div>
            }>
              <div class="channel-empty channel-empty-full">
                <span class="channel-empty-rule" /><small>Fresh workspace</small>
                <h1>{section() === 'dms' ? 'No direct messages yet' : 'Create your first channel'}</h1>
                <p>{section() === 'dms' ? 'Start a private line with any human or agent who shares a channel with you.' : 'Channels keep human and agent work together in one shared timeline.'}</p>
                <Show when={section() === 'dms'}><button type="button" onClick={() => openDialog('dm')}>Start a direct message</button></Show>
                <Show when={section() !== 'dms'}><button type="button" onClick={() => openDialog('channel')}>New channel</button></Show>
              </div>
            </Show>
          }>{channel => (
            <>
              <header class="channel-view-header channel-conversation-header">
                <div>
                  <small>{channel().type === 'dm' ? 'Direct message' : 'Channel'}</small>
                  <div class="channel-title-row">
                    <h1>{channel().type === 'dm' ? dmName(channel(), snapshot().principal?.id) : `#${channel().slug}`}</h1>
                    <Show when={channel().type === 'channel'}>
                      <button type="button" class="channel-directory-button" onClick={() => openChannelDirectory('channels')}>All channels</button>
                      <button type="button" class="channel-new-button" onClick={() => openDialog('channel')}>New channel</button>
                    </Show>
                  </div>
                  <p>{channel().description || (channel().type === 'dm' ? 'A private conversation between members.' : '')}</p>
                </div>
                <div class="channel-member-cluster">
                  <button
                    type="button"
                    class="channel-roster-toggle"
                    aria-label={`${channel().members.length} members`}
                    aria-expanded={rosterOpen()}
                    onClick={() => setRosterOpen(!rosterOpen())}
                  >
                    <For each={channel().members.slice(0, 5)}>{member => <PersonMark person={member} />}</For>
                    <span>{channel().members.length}</span>
                  </button>
                  <Show when={currentHumanIsOwner()}><button type="button" onClick={() => openDialog('members')}>Invite</button></Show>
                  <Show when={rosterOpen()}>
                    <section class="channel-roster-popover" aria-label="Channel members">
                      <header><b>Who’s here</b><span>Coordinator owns substantial work. Btw answers overflow while Coordinator is busy.</span></header>
                      <For each={channel().members}>{member => (
                        <Show when={member.kind === 'agent'} fallback={
                          <div class="channel-roster-member"><PersonMark person={member} /><Identity person={member} compact /></div>
                        }>
                          <button type="button" class="channel-roster-member" onClick={() => { mention(member, false); setRosterOpen(false) }}>
                            <PersonMark person={member} />
                            <Identity person={member} compact />
                            <small>{member.displayName.toLowerCase() === 'btw' ? 'Helps while Coordinator is busy' : channel().defaultAgentId === member.id ? 'Main agent' : 'Mention to involve'}</small>
                          </button>
                        </Show>
                      )}</For>
                    </section>
                  </Show>
                </div>
              </header>
              <section class="channel-timeline" aria-label={`${channel().title} messages`} aria-busy={loading()}>
                <Show when={loading()}><div class="channel-loading"><span /><span /><span /></div></Show>
                <Show when={!loading() && roots().length === 0}>
                  <div class="channel-empty"><small>The first note</small><h2>Set the work in motion</h2><p>Coordinator answers directly when free. While Coordinator is busy, Btw handles quick questions or queues substantial work behind it.</p></div>
                </Show>
                <Index each={roots()}>{message => renderMessage(message())}</Index>
              </section>
              {renderComposer(false)}
            </>
          )}</Show>
        </Show>
      </main>

      <Show when={thread()}>{current => (
        <aside class="channel-thread-pane open" aria-label="Focused thread">
            <header class="channel-thread-header">
              <button type="button" class="channel-thread-back" onClick={closeThread} aria-label="Close focused thread">←</button>
              <div>
                <small>Focused thread · {current().messages.length - 1} replies</small>
                <Show when={editingTitle()} fallback={<button type="button" class="channel-thread-title" onClick={startThreadTitleEdit} title="Edit thread title">{current().title}</button>}>
                  <input
                    value={titleDraft()}
                    onInput={event => setTitleDraft(event.currentTarget.value)}
                    onBlur={() => void saveThreadTitle()}
                    onKeyDown={event => {
                      if (event.key === 'Enter') void saveThreadTitle()
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        event.stopPropagation()
                        cancelThreadTitleEdit()
                      }
                    }}
                    aria-label="Thread title"
                    autofocus
                  />
                </Show>
              </div>
              <span class={`channel-state channel-state-${current().state}`}>{current().state.replace('_', ' ')}</span>
            </header>

            <div class="channel-thread-actions">
              <button type="button" disabled={!!attentionAction()} classList={{ active: current().following }} aria-pressed={current().following} onClick={() => void setAttention('follow', !current().following)}>{current().following ? 'Following' : 'Follow'}</button>
              <button type="button" disabled={!!attentionAction()} classList={{ active: activeSnooze(current().snoozedUntil) }} aria-pressed={activeSnooze(current().snoozedUntil)} onClick={() => void setAttention('snooze', !activeSnooze(current().snoozedUntil))}>{activeSnooze(current().snoozedUntil) ? 'Snoozed 1h' : 'Snooze'}</button>
              <button type="button" disabled={!!attentionAction()} class="channel-done" classList={{ active: !!current().doneAt }} aria-pressed={!!current().doneAt} onClick={() => void setAttention('done', !current().doneAt)}>{current().doneAt ? 'Reopen' : 'Done'}</button>
            </div>
            {renderDelivery(current().delivery)}

            <section class="channel-thread-messages" ref={threadScroller}>
              <Index each={current().messages}>{message => renderMessage(message(), true)}</Index>
              <Show when={current().executions.some(execution => execution.state === 'running')}>
                <section class="channel-active-work" aria-label="Agents working now">
                  <header><span class="channel-worklog-pulse running" />Working now</header>
                  <For each={current().executions.filter(execution => execution.state === 'running')}>{renderExecution}</For>
                </section>
              </Show>
              <Show when={(() => {
                const latest = current().executions.at(-1)
                return latest?.canRestart && (latest.state === 'error' || latest.state === 'killed') ? latest : null
              })()}>{failed => (
                <section class="channel-turn-recovery" role="alert">
                  <div><b>This agent turn stopped.</b><span>{failed().error || 'It did not complete.'}</span></div>
                  <button type="button" disabled={restartingExecutionId() === failed().id} onClick={event => { event.stopPropagation(); void restartExecution(failed().id) }}>
                    {restartingExecutionId() === failed().id ? 'Restarting…' : 'Restart turn'}
                  </button>
                </section>
              )}</Show>
              <Show when={current().executions.some(execution => execution.state !== 'running')}>
                <details class="channel-worklog">
                  <summary>Past agent activity · {current().executions.filter(execution => execution.state !== 'running').length}</summary>
                  <For each={current().executions.filter(execution => execution.state !== 'running')}>{renderExecution}</For>
                </details>
              </Show>
            </section>
            {renderComposer(true)}
        </aside>
      )}</Show>

      <Show when={peekExecutionId()}>
        <aside class="channel-agent-peek" aria-label="Live agent peek">
          <header>
            <div><small>Read-only live view</small><h2>{executionPeek()?.execution.agent.displayName || 'Agent work'}</h2></div>
            <button type="button" onClick={closeExecutionPeek} aria-label="Close live agent peek">×</button>
          </header>
          <Show when={peekLoading() && !executionPeek()}><div class="channel-peek-loading">Opening live activity…</div></Show>
          <Show when={peekError()}><div class="channel-peek-error">{peekError()}</div></Show>
          <Show when={executionPeek()}>{peek => (
            <div class="channel-peek-body">
              <div class="channel-peek-current" classList={{ stalled: peek().stalled }}>
                <span class="channel-worklog-pulse" classList={{ running: peek().execution.state === 'running' && peek().processActive }} />
                <div><small>{peek().stalled ? 'Attention needed' : peek().execution.state === 'running' ? 'Working now' : 'Finished'}</small><p>{peek().activity}</p></div>
              </div>
              <Show when={peek().stalledReason && peek().steps.length > 0}><p class="channel-peek-stalled">{peek().stalledReason}</p></Show>
              <Show when={peek().steps.length > 0} fallback={<p class="channel-peek-empty">{peek().stalledReason || 'No tool activity has been reported yet.'}</p>}>
                <ol class="channel-peek-steps">
                  <For each={peek().steps}>{step => (
                    <li classList={{ working: step.status === 'working', failed: step.status === 'failed' }}>
                      <span>{step.status === 'working' ? 'Now' : step.status === 'failed' ? 'Failed' : 'Done'}</span>
                      <div><b>{step.tool}</b><Show when={step.intent}><p>{step.intent}</p></Show></div>
                    </li>
                  )}</For>
                </ol>
              </Show>
              <Show when={peek().canRestart}>
                <div class="channel-peek-recovery">
                  <button type="button" disabled={restartingExecutionId() === peek().execution.id} onClick={() => void restartExecution(peek().execution.id)}>
                    {restartingExecutionId() === peek().execution.id ? 'Restarting turn…' : 'Restart turn'}
                  </button>
                  <span>Replays the latest request in this thread.</span>
                </div>
              </Show>
              <footer>{peek().updatedAt ? `Progress updated ${relativeTime(peek().updatedAt!)}` : `Started ${relativeTime(peek().execution.startedAt)} · no live progress heartbeat yet`}</footer>
            </div>
          )}</Show>
        </aside>
      </Show>

      <Show when={channelDirectoryOpen()}>
        <div class="channel-directory-scrim" onClick={event => { if (event.target === event.currentTarget) setChannelDirectoryOpen(false) }}>
          <section class="channel-directory" role="dialog" aria-modal="true" aria-labelledby="channel-directory-title">
            <header>
              <div><small>Fledge</small><h2 id="channel-directory-title">{channelDirectoryMode() === 'channels' ? 'All channels' : 'Direct messages'}</h2></div>
              <button type="button" onClick={() => setChannelDirectoryOpen(false)} aria-label={`Close ${channelDirectoryMode() === 'channels' ? 'all channels' : 'direct messages'}`}>×</button>
            </header>
            <div class="channel-directory-list">
              <Show when={channelDirectoryMode() === 'channels'} fallback={
                <For each={snapshot().dms}>{channel => {
                  const other = channel.members.find(member => member.id !== snapshot().principal?.id)
                  return (
                    <button
                      type="button"
                      classList={{ active: selectedChannelId() === channel.id && section() === 'dms' }}
                      aria-current={selectedChannelId() === channel.id && section() === 'dms' ? 'page' : undefined}
                      onClick={() => void chooseChannel(channel, 'dms')}
                    >
                      <Show when={other} fallback={<span class="channel-directory-hash">DM</span>}>{person => <PersonMark person={person()} small />}</Show>
                      <span><b>{dmName(channel, snapshot().principal?.id)}</b><small>{channel.description || 'Private conversation'}</small></span>
                      <Show when={channel.unread > 0}><strong>{channel.unread}</strong></Show>
                      <span aria-hidden="true">→</span>
                    </button>
                  )
                }}</For>
              }>
                <For each={snapshot().channels}>{channel => (
                  <button
                    type="button"
                    classList={{ active: selectedChannelId() === channel.id && section() === 'channels' }}
                    aria-current={selectedChannelId() === channel.id && section() === 'channels' ? 'page' : undefined}
                    onClick={() => void chooseChannel(channel)}
                  >
                    <span class="channel-directory-hash">#</span>
                    <span><b>{channel.slug}</b><small>{channel.description || `${channel.members.length} members`}</small></span>
                    <Show when={channel.unread > 0}><strong>{channel.unread}</strong></Show>
                    <span aria-hidden="true">→</span>
                  </button>
                )}</For>
              </Show>
            </div>
            <footer>
              <button type="button" onClick={() => { setChannelDirectoryOpen(false); openDialog(channelDirectoryMode() === 'channels' ? 'channel' : 'dm') }}>
                {channelDirectoryMode() === 'channels' ? 'New channel' : 'New direct message'}
              </button>
            </footer>
          </section>
        </div>
      </Show>

      <nav class="channels-mobile-nav" classList={{ personal: props.showPersonal }} aria-label="Channel workspace navigation">
        <button type="button" classList={{ active: section() === 'activity' }} onClick={() => navigate('activity')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14v14H5zM8 9h8M8 13h6" /></svg><span>Activity</span><Show when={activity().unread}><b>{activity().unread}</b></Show></button>
        <button type="button" classList={{ active: section() === 'channels' }} onClick={() => openChannelDirectory('channels')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 4-2 16m10-16-2 16M4 9h16M3 15h16" /></svg><span>Channels</span></button>
        <button type="button" classList={{ active: section() === 'threads' }} onClick={() => navigate('threads')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4V5Z" /></svg><span>Threads</span></button>
        <button type="button" classList={{ active: section() === 'dms' }} onClick={() => openChannelDirectory('dms')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4zM7 9h10M7 13h7" /></svg><span>DMs</span></button>
        <Show when={props.showPersonal}><button type="button" onClick={props.onRooms}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h6l2 2h8v10H4V6Z" /></svg><span>Rooms</span></button></Show>
        <Show when={props.showPersonal}><button type="button" onClick={props.onFeed}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14M5 12h10M5 19h7" /></svg><span>Runs</span></button></Show>
      </nav>

      <Show when={dialog()}>
        <div class="channel-dialog-scrim" onClick={event => { if (event.target === event.currentTarget) setDialog(null) }} onKeyDown={event => { if (event.key === 'Escape') setDialog(null) }}>
          <section class="channel-dialog" role="dialog" aria-modal="true" aria-labelledby="channel-dialog-title">
            <header><small>{dialog() === 'dm' ? 'Private line' : 'Shared studio'}</small><h2 id="channel-dialog-title">{dialog() === 'channel' ? 'Create a channel' : dialog() === 'members' ? 'Invite a human' : 'Start a direct message'}</h2><button type="button" onClick={() => setDialog(null)} aria-label="Close">×</button></header>
            <Show when={dialog() === 'dm'} fallback={
              <form onSubmit={event => { event.preventDefault(); void submitDialog() }}>
                <label>{dialog() === 'channel' ? 'Channel name' : 'Username'}<input value={dialogValue()} onInput={event => setDialogValue(event.currentTarget.value)} placeholder={dialog() === 'channel' ? 'Film launch' : 'maya'} autofocus /></label>
                <Show when={dialog() === 'channel'}><label>Display title <input value={dialogTitle()} onInput={event => setDialogTitle(event.currentTarget.value)} placeholder="Film Launch" /></label></Show>
                <Show when={dialogError()}><p class="channel-dialog-error">{dialogError()}</p></Show>
                <button type="submit" class="channel-dialog-submit" disabled={!dialogValue().trim() || dialogBusy()}>{dialogBusy() ? dialog() === 'channel' ? 'Adding agents…' : 'Inviting…' : dialog() === 'channel' ? 'Create channel' : 'Send invite'}</button>
              </form>
            }>
              <div class="channel-person-list">
                <For each={principals().filter(principal => principal.id !== snapshot().principal?.id)}>{principal => (
                  <button type="button" onClick={() => void startDm(principal)} disabled={dialogBusy()}>
                    <PersonMark person={principal} /><span><b>{principal.displayName}</b><small>{principal.kind === 'agent' ? `Agent · @${principal.username}` : `Human · @${principal.username}`}</small></span><span aria-hidden="true">→</span>
                  </button>
                )}</For>
              </div>
            </Show>
          </section>
        </div>
      </Show>
    </div>
  )
}
