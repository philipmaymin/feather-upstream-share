import { createSignal, onMount, onCleanup, Show, For } from 'solid-js'
import { fetchRooms, cachedRoomsSnapshot, fetchSessions, searchSessions, createRoom, createSession, assignSessionToRoom, setRoomPulse, fetchRoomUpdates } from './api'
import type { RoomInfo, SessionMeta, RoomUpdate } from './api'

// Full-screen rooms home (iMessage model, phone-first): one row per room
// folder under ~/rooms/, latest message snippet, status dot. Tap a session
// to open it in the normal session view. This is the default view when no
// session is open; the sidebar stays untouched.

function timeAgo(iso: string | null) {
  if (!iso) return ''
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

function timeUntil(iso: string | null) {
  if (!iso) return 'later'
  const m = Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 60000))
  if (m < 1) return 'now'
  if (m < 60) return `in ${m}m`
  return `in ${Math.ceil(m / 60)}h`
}

function snippetLabel(latest: { role: string, text: string } | null) {
  if (!latest) return 'No messages yet'
  const prefix = latest.role === 'user' ? 'you: ' : latest.role === 'notes' ? 'notes: ' : ''
  return prefix + latest.text
}

function pulseLabel(room: RoomInfo) {
  if (!room.pulse.enabled) return 'Paused'
  const age = timeAgo(room.pulse.lastRunAt)
  let worked = ''
  if (age === 'now') worked = 'Worked now'
  else if (age) worked = `Worked ${age} ago`
  if (room.pulse.status === 'working') return `${worked || 'Started'} · working now`
  if (room.pulse.status === 'error') return `Last check failed · tries again ${timeUntil(room.pulse.nextRunAt)}`
  return `${worked ? `${worked} · ` : ''}checks again ${timeUntil(room.pulse.nextRunAt)}`
}

const SEEN_KEY = 'feather:roomUpdatesSeen'
function loadSeen(): Record<string, number> {
  try {
    const value = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}')
    return value && typeof value === 'object' ? value : {}
  } catch { return {} }
}
function saveSeen(map: Record<string, number>) {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(map)) } catch {}
}
function updateTimeLabel(iso: string | null) {
  if (!iso) return ''
  const date = new Date(iso)
  if (isNaN(date.getTime())) return ''
  const when = date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  const ago = timeAgo(iso)
  return ago && ago !== 'now' ? `${when} · ${ago} ago` : `${when} · just now`
}

export default function RoomsHome(props: { onOpen: (id: string) => void, onSessionsChanged?: () => void }) {
  // Keep the last successful snapshot visible while a fresh one loads. This
  // makes returning home immediate instead of flashing an empty loading view.
  const [rooms, setRooms] = createSignal<RoomInfo[] | null>(cachedRoomsSnapshot())
  const [error, setError] = createSignal<string | null>(null)
  const [expanded, setExpanded] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [attachLoading, setAttachLoading] = createSignal(false)
  const [attachingRoom, setAttachingRoom] = createSignal<string | null>(null)
  const [attachCandidates, setAttachCandidates] = createSignal<SessionMeta[]>([])
  const [attachError, setAttachError] = createSignal<string | null>(null)
  const [attachQuery, setAttachQuery] = createSignal('')
  const [seen, setSeen] = createSignal<Record<string, number>>(loadSeen())
  const [updatesRoom, setUpdatesRoom] = createSignal<string | null>(null)
  const [updatesList, setUpdatesList] = createSignal<RoomUpdate[]>([])
  const [updatesLoading, setUpdatesLoading] = createSignal(false)
  const [updatesError, setUpdatesError] = createSignal<string | null>(null)
  let updatesRequest = 0

  async function refresh(useWarmSnapshot = false) {
    try { setRooms(await fetchRooms(useWarmSnapshot ? 1000 : 0)); setError(null) }
    catch (e: any) { setError(e.message) }
  }

  let timer: ReturnType<typeof setInterval>
  onMount(() => { refresh(true); timer = setInterval(refresh, 10000) })
  onCleanup(() => clearInterval(timer))

  async function newRoom() {
    const name = prompt('Room name (lowercase, digits, dashes):')?.trim()
    if (!name) return
    setBusy(true)
    try { await createRoom(name); await refresh(); setExpanded(name) }
    catch (e: any) { alert(e.message) }
    finally { setBusy(false) }
  }

  async function newChat(room: RoomInfo, agent?: 'claude' | 'codex' | 'omp') {
    setBusy(true)
    try {
      const id = await createSession(room.cwd, agent)
      // Belt and braces: cwd-derived grouping covers claude immediately, but
      // codex/omp transcripts appear later — pin the membership explicitly.
      await assignSessionToRoom(room.name, id).catch(() => {})
      props.onSessionsChanged?.()
      props.onOpen(id)
    } catch (e: any) { alert(e.message) }
    finally { setBusy(false) }
  }

  async function loadAttachCandidates(query = '') {
    setAttachError(null)
    try {
      setAttachLoading(true)
      const sessions = query ? await searchSessions(query) : await fetchSessions(null, undefined, 300)
      const groupedIds = new Set((rooms() || []).flatMap(current => current.sessions.map(session => session.id)))
      setAttachCandidates(sessions.filter(session => !groupedIds.has(session.id)))
    } catch (e: any) { setAttachError(e.message) }
    finally { setAttachLoading(false) }
  }

  async function showAttach(room: RoomInfo) {
    if (attachingRoom() === room.name) { setAttachingRoom(null); setAttachError(null); return }
    setAttachingRoom(room.name)
    setAttachQuery('')
    setAttachCandidates([])
    await loadAttachCandidates()
  }

  async function attachSession(room: RoomInfo, session: SessionMeta) {
    setBusy(true)
    try {
      await assignSessionToRoom(room.name, session.id)
      setAttachCandidates(sessions => sessions.filter(candidate => candidate.id !== session.id))
      await refresh()
      props.onSessionsChanged?.()
    } catch (e: any) { setAttachError(e.message) }
    finally { setBusy(false) }
  }

  async function detachSession(room: RoomInfo, session: SessionMeta, event: MouseEvent) {
    event.stopPropagation()
    setBusy(true)
    try {
      await assignSessionToRoom(room.name, session.id, true)
      await refresh()
      props.onSessionsChanged?.()
    } catch (e: any) { alert(e.message) }
    finally { setBusy(false) }
  }

  async function togglePulse(room: RoomInfo, event: MouseEvent) {
    event.stopPropagation()
    setBusy(true)
    try {
      const pulse = await setRoomPulse(room.name, !room.pulse.enabled)
      setRooms((current) => current?.map((item) => item.name === room.name ? { ...item, pulse } : item) || null)
    } catch (e: any) { alert(e.message) }
    finally { setBusy(false) }
  }

  const unreadCount = (room: RoomInfo) => Math.max(0, room.updates.count - (seen()[room.name] || 0))

  function markSeen(room: RoomInfo) {
    const next = { ...seen(), [room.name]: room.updates.count }
    setSeen(next)
    saveSeen(next)
  }

  async function openUpdates(room: RoomInfo, event: MouseEvent) {
    event.stopPropagation()
    if (updatesRoom() === room.name) {
      updatesRequest++
      setUpdatesRoom(null)
      return
    }
    const request = ++updatesRequest
    setUpdatesRoom(room.name)
    setUpdatesList([])
    setUpdatesError(null)
    setUpdatesLoading(true)
    try {
      const updates = await fetchRoomUpdates(room.name)
      if (request !== updatesRequest) return
      setUpdatesList(updates)
      markSeen(room)
    } catch (error: any) {
      if (request !== updatesRequest) return
      setUpdatesError(error.message)
    } finally {
      if (request === updatesRequest) setUpdatesLoading(false)
    }
  }

  // Tap the card → open the newest chat (iMessage model). The chevron (or a
  // room with no chats) expands the card to show all chats + new-chat buttons.
  function openRoom(room: RoomInfo) {
    if (room.sessions.length === 0) { setExpanded(expanded() === room.name ? null : room.name); return }
    props.onOpen(room.sessions[0].id)
  }
  const toggleExpand = (name: string) => setExpanded(expanded() === name ? null : name)

  const agentColor = (a?: string) => a === 'codex' ? '#c084fc' : a === 'omp' ? '#e0a050' : '#73b8ff'
  const agentBg = (a?: string) => a === 'codex' ? '#2a1e3a' : a === 'omp' ? '#3a2a1e' : '#1e2a3a'

  const sessionRow = (room: RoomInfo, s: SessionMeta) => (
    <div onClick={(e) => { e.stopPropagation(); props.onOpen(s.id) }}
      style={{ display: 'flex', 'align-items': 'center', gap: '8px', padding: '9px 16px 9px 28px', 'border-top': '1px solid #16161f', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>
      <span style={{ width: '7px', height: '7px', 'border-radius': '50%', background: s.isActive ? '#4aba6a' : '#333', 'flex-shrink': '0' }} />
      <span style={{ 'font-size': '9px', padding: '1px 5px', 'border-radius': '3px', background: agentBg(s.agent), color: agentColor(s.agent), 'flex-shrink': '0', 'font-weight': '600' }}>{s.agent || 'claude'}</span>
      <span style={{ flex: '1', 'font-size': '13px', color: '#ccc', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{s.title}</span>
      <Show when={s.roomAssigned}>
        <button data-testid={`detach-${s.id}`} aria-label={`Detach ${s.title} from #${room.name}`} disabled={busy()}
          onClick={(event) => detachSession(room, s, event)}
          style={{ background: 'none', border: 'none', color: '#777', 'font-size': '11px', padding: '3px 5px', cursor: 'pointer', 'flex-shrink': '0' }}>Detach</button>
      </Show>
      <span style={{ 'font-size': '11px', color: '#555', 'font-family': 'monospace', 'flex-shrink': '0' }}>{timeAgo(s.updatedAt)}</span>
    </div>
  )

  return (
    <div style={{ height: '100%', 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch' }}>
      <div style={{ 'max-width': '640px', margin: '0 auto', padding: '12px 12px 40px' }}>
        <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', padding: '10px 4px 14px 44px' }}>
          <span style={{ 'font-size': '20px', 'font-weight': '700' }}>Rooms</span>
          <button onClick={newRoom} disabled={busy()}
            style={{ background: '#1a1a2e', border: '1px solid #333', color: '#e5e5e5', 'font-size': '13px', 'font-weight': '600', padding: '6px 12px', 'border-radius': '8px', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>+ New room</button>
        </div>

        <Show when={error()}>
          <div style={{ color: '#d45555', 'font-size': '13px', padding: '8px 4px' }}>{error()}</div>
        </Show>

        <Show when={rooms()} fallback={<div style={{ color: '#555', 'text-align': 'center', padding: '40px', 'font-size': '13px' }}>Loading rooms…</div>}>
          <Show when={rooms()!.length > 0} fallback={
            <div style={{ color: '#555', 'text-align': 'center', padding: '40px', 'font-size': '13px' }}>
              No rooms yet. A room is a folder under ~/rooms/ — create one to start.
            </div>
          }>
            <For each={rooms()!}>{(room) => (
              <div style={{ background: '#0d1117', border: '1px solid #1e1e1e', 'border-radius': '12px', 'margin-bottom': '10px', overflow: 'hidden' }}>
                <div onClick={() => openRoom(room)} style={{ padding: '12px 16px', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>
                  <div style={{ display: 'flex', 'align-items': 'center', gap: '10px' }}>
                    <span style={{ width: '10px', height: '10px', 'border-radius': '50%', background: room.active ? '#4aba6a' : '#333', 'flex-shrink': '0' }} />
                    <span style={{ 'font-size': '16px', 'font-weight': '700', color: '#e5e5e5' }}>#{room.name}</span>
                    <Show when={room.sessions.length > 1}>
                      <span style={{ 'font-size': '11px', color: '#666' }}>{room.sessions.length} chats</span>
                    </Show>
                    <span style={{ 'margin-left': 'auto', 'font-size': '11px', color: '#555', 'font-family': 'monospace' }}>{timeAgo(room.updatedAt)}</span>
                    <button onClick={(e) => { e.stopPropagation(); toggleExpand(room.name) }}
                      style={{ background: 'none', border: 'none', color: '#666', 'font-size': '14px', cursor: 'pointer', padding: '2px 6px', transform: expanded() === room.name ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', '-webkit-tap-highlight-color': 'transparent' }}>›</button>
                  </div>
                  <div style={{ 'margin-top': '6px', 'padding-left': '20px', 'font-size': '13px', color: room.latest ? '#999' : '#555', overflow: 'hidden', display: '-webkit-box', '-webkit-line-clamp': '2', '-webkit-box-orient': 'vertical', 'line-height': '1.4' }}>
                    {snippetLabel(room.latest)}
                  </div>
                  <div style={{ 'margin-top': '9px', 'padding-left': '20px', display: 'flex', 'align-items': 'center', gap: '8px' }}>
                    <button data-testid={`pulse-${room.name}`} onClick={(event) => togglePulse(room, event)} disabled={busy()}
                      aria-pressed={room.pulse.enabled}
                      style={{ background: room.pulse.enabled ? '#152a1c' : 'transparent', border: `1px solid ${room.pulse.enabled ? '#2a4a34' : '#333'}`, color: room.pulse.enabled ? '#69c77f' : '#777', 'font-size': '11px', 'font-weight': '600', padding: '3px 8px', 'border-radius': '999px', cursor: 'pointer' }}>
                      {room.pulse.enabled ? 'Keep working' : 'Paused'}
                    </button>
                    <span style={{ color: room.pulse.status === 'error' ? '#d48166' : '#666', 'font-size': '11px' }}>{pulseLabel(room)}</span>
                    <button data-testid={`updates-${room.name}`} onClick={(event) => openUpdates(room, event)}
                      aria-label={`Updates for #${room.name}`}
                      style={{ 'margin-left': 'auto', display: 'flex', 'align-items': 'center', gap: '6px', background: updatesRoom() === room.name ? '#1a1f2e' : 'transparent', border: '1px solid #2a3346', color: '#9aa4b2', 'font-size': '11px', 'font-weight': '600', padding: '3px 9px', 'border-radius': '999px', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>
                      Updates
                      <Show when={unreadCount(room) > 0} fallback={<span style={{ color: '#555', 'font-weight': '500' }}>{room.updates.count}</span>}>
                        <span style={{ background: '#c0392b', color: '#fff', 'border-radius': '999px', padding: '0 6px', 'font-size': '10px', 'line-height': '16px' }}>{unreadCount(room)} new</span>
                      </Show>
                    </button>
                  </div>
                </div>
                <Show when={updatesRoom() === room.name}>
                  <div data-testid={`updates-panel-${room.name}`} style={{ 'border-top': '1px solid #16161f', padding: '8px 16px 12px', background: '#0a0d13' }}>
                    <Show when={updatesError()}>
                      <div style={{ color: '#d45555', 'font-size': '12px', padding: '4px 0' }}>{updatesError()}</div>
                    </Show>
                    <Show when={updatesLoading()}>
                      <div style={{ color: '#666', 'font-size': '12px', padding: '4px 0' }}>Loading updates…</div>
                    </Show>
                    <Show when={!updatesLoading() && !updatesError() && updatesList().length === 0}>
                      <div style={{ color: '#666', 'font-size': '12px', padding: '4px 0' }}>No updates yet. Agents post here with <code style={{ color: '#e0a050' }}>room update</code> when something worth knowing happens.</div>
                    </Show>
                    <For each={[...updatesList()].reverse()}>{(update) => (
                      <div style={{ padding: '9px 0', 'border-bottom': '1px solid #14141c' }}>
                        <div style={{ 'font-size': '10px', color: '#5a6472', 'font-family': 'monospace', 'margin-bottom': '3px' }}>{updateTimeLabel(update.ts)}</div>
                        <div style={{ 'font-size': '13px', color: '#d0d4da', 'line-height': '1.5', 'white-space': 'pre-wrap', 'word-break': 'break-word' }}>{update.text}</div>
                      </div>
                    )}</For>
                  </div>
                </Show>
                <Show when={expanded() === room.name}>
                  <For each={room.sessions}>{(s) => sessionRow(room, s)}</For>
                  <div style={{ display: 'flex', 'flex-wrap': 'wrap', gap: '8px', padding: '10px 16px 12px 28px', 'border-top': '1px solid #16161f' }}>
                    <button onClick={() => newChat(room)} disabled={busy()}
                      style={{ background: '#152a1c', border: '1px solid #2a4a34', color: '#4aba6a', 'font-size': '12px', 'font-weight': '600', padding: '5px 12px', 'border-radius': '8px', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>+ New chat here</button>
                    <button onClick={() => newChat(room, 'codex')} disabled={busy()}
                      style={{ background: 'none', border: '1px solid #333', color: '#c084fc', 'font-size': '12px', padding: '5px 12px', 'border-radius': '8px', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>codex</button>
                    <button data-testid={`attach-existing-${room.name}`} onClick={() => showAttach(room)} disabled={busy()}
                      style={{ 'margin-left': 'auto', background: 'none', border: '1px solid #333', color: '#9aa4b2', 'font-size': '12px', padding: '5px 10px', 'border-radius': '8px', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>
                      {attachingRoom() === room.name ? 'Close' : 'Attach existing'}
                    </button>
                  </div>
                  <Show when={attachingRoom() === room.name}>
                    <div data-testid={`attach-picker-${room.name}`} style={{ 'border-top': '1px solid #16161f', padding: '6px 16px 10px 28px' }}>
                      <form onSubmit={(event) => { event.preventDefault(); loadAttachCandidates(attachQuery().trim()) }}
                        style={{ display: 'flex', gap: '6px', padding: '5px 0 3px' }}>
                        <input data-testid={`attach-search-${room.name}`} value={attachQuery()} onInput={(event) => setAttachQuery(event.currentTarget.value)}
                          aria-label={`Search chats to attach to #${room.name}`} placeholder="Search all chats"
                          style={{ flex: '1', 'min-width': '0', background: '#090d12', border: '1px solid #292f38', color: '#ddd', 'font-size': '12px', padding: '6px 8px', 'border-radius': '7px', outline: 'none' }} />
                        <button type="submit" disabled={attachLoading()}
                          style={{ background: 'none', border: '1px solid #333', color: '#9aa4b2', 'font-size': '11px', padding: '5px 9px', 'border-radius': '7px', cursor: 'pointer' }}>Search</button>
                      </form>
                      <Show when={attachError()}>
                        <div style={{ color: '#d45555', 'font-size': '12px', padding: '6px 0' }}>{attachError()}</div>
                      </Show>
                      <Show when={attachCandidates().length > 0} fallback={
                        <div style={{ color: '#666', 'font-size': '12px', padding: '7px 0' }}>{attachLoading() ? 'Loading chats…' : attachQuery().trim() ? 'No matching ungrouped chats.' : 'No ungrouped recent chats.'}</div>
                      }>
                        <For each={attachCandidates()}>{(session) => (
                          <button data-testid={`attach-${session.id}`} disabled={busy()} onClick={() => attachSession(room, session)}
                            style={{ display: 'flex', width: '100%', 'align-items': 'center', gap: '8px', background: 'none', border: 'none', color: '#bbb', padding: '7px 0', cursor: 'pointer', 'text-align': 'left' }}>
                            <span style={{ 'font-size': '9px', padding: '1px 5px', 'border-radius': '3px', background: agentBg(session.agent), color: agentColor(session.agent), 'font-weight': '600' }}>{session.agent || 'claude'}</span>
                            <span style={{ flex: '1', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', 'font-size': '12px' }}>{session.title}</span>
                            <span style={{ color: '#4aba6a', 'font-size': '11px' }}>Attach</span>
                          </button>
                        )}</For>
                      </Show>
                    </div>
                  </Show>
                </Show>
              </div>
            )}</For>
          </Show>
        </Show>
      </div>
    </div>
  )
}
