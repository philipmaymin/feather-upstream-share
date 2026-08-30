import { createSignal, onMount, onCleanup, Show, For } from 'solid-js'
import { fetchRooms, cachedRoomsSnapshot, fetchSessions, searchSessions, createRoom, renameRoom, createSession, assignSessionToRoom, setRoomPulse, fetchRoomFriction } from './api'
import type { RoomInfo, SessionMeta, FrictionComplaint } from './api'
import { RoomWikiView } from './components/RoomWikiView'

type AgentId = 'claude' | 'codex' | 'omp'
const ROOM_HARNESSES_KEY = 'feather:roomHarnesses'

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

function loadRoomHarnesses(): Record<string, AgentId> {
  try {
    const value = JSON.parse(localStorage.getItem(ROOM_HARNESSES_KEY) || '{}')
    if (!value || typeof value !== 'object') return {}
    return Object.fromEntries(Object.entries(value).filter(([, agent]) => agent === 'omp' || agent === 'claude' || agent === 'codex')) as Record<string, AgentId>
  } catch { return {} }
}
function saveRoomHarnesses(map: Record<string, AgentId>) {
  try { localStorage.setItem(ROOM_HARNESSES_KEY, JSON.stringify(map)) } catch {}
}
const agentLabel = (agent: AgentId) => agent === 'omp' ? 'OMP' : agent === 'codex' ? 'Codex' : 'Claude Code'
function updateTimeLabel(iso: string | null) {
  if (!iso) return ''
  const date = new Date(iso)
  if (isNaN(date.getTime())) return ''
  const when = date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  const ago = timeAgo(iso)
  return ago && ago !== 'now' ? `${when} · ${ago} ago` : `${when} · just now`
}

function leaderRoomSession(room: RoomInfo) {
  return room.sessions.find(session => session.id === room.leaderSessionId) || null
}

export default function RoomsHome(props: {
  onOpen: (id: string) => void
  onNewChat: (agent: AgentId, model?: string) => void
  onSessionsChanged?: () => void
  creating?: boolean
  codexAvailable?: boolean
}) {
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
  const [unassignedChat, setUnassignedChat] = createSignal<{ id: string, room: string, detail: string } | null>(null)
  const [attachQuery, setAttachQuery] = createSignal('')
  const [roomHarnesses, setRoomHarnesses] = createSignal<Record<string, AgentId>>(loadRoomHarnesses())
  const [ompModel, setOmpModel] = createSignal(localStorage.getItem('feather:ompModelOverride') || '')
  const [wikiRoom, setWikiRoom] = createSignal<string | null>(null)
  const [frictionRoom, setFrictionRoom] = createSignal<string | null>(null)
  const [frictionList, setFrictionList] = createSignal<FrictionComplaint[]>([])
  const [frictionLoading, setFrictionLoading] = createSignal(false)
  const [frictionError, setFrictionError] = createSignal<string | null>(null)
  let frictionRequest = 0
  let roomsEpoch = 0

  async function refresh(useWarmSnapshot = false) {
    const epoch = ++roomsEpoch
    try {
      const next = await fetchRooms(useWarmSnapshot ? 1000 : 0)
      if (epoch === roomsEpoch) {
        setRooms(next)
        setError(null)
      }
    } catch (cause) {
      if (epoch === roomsEpoch) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  let timer: ReturnType<typeof setInterval>
  onMount(() => { refresh(true); timer = setInterval(() => { if (!wikiRoom()) refresh() }, 10000) })
  onCleanup(() => clearInterval(timer))

  async function newRoom() {
    const name = prompt('Room name (lowercase, digits, dashes):')?.trim()
    if (!name) return
    setBusy(true)
    try { await createRoom(name); await refresh(); setExpanded(name) }
    catch (e: any) { alert(e.message) }
    finally { setBusy(false) }
  }

  const roomHarness = (name: string): AgentId => roomHarnesses()[name] || 'omp'

  function setRoomHarness(name: string, agent: AgentId) {
    const next = { ...roomHarnesses(), [name]: agent }
    setRoomHarnesses(next)
    saveRoomHarnesses(next)
  }
  function updateOmpModel(model: string) {
    setOmpModel(model)
    if (model.trim()) localStorage.setItem('feather:ompModelOverride', model)
    else localStorage.removeItem('feather:ompModelOverride')
  }


  async function newChat(room: RoomInfo, agent?: AgentId, asLeader = false) {
    setBusy(true)
    try {
      const selectedAgent = asLeader ? 'omp' : agent || roomHarness(room.name)
      const id = await createSession(room.cwd, selectedAgent, {
        ...(selectedAgent === 'omp' && ompModel().trim() ? { model: ompModel().trim() } : {}),
        ...(asLeader ? { roomName: room.name, roomRole: 'leader' as const } : {}),
      })
      // Leader membership is assigned atomically so its first prompt carries
      // the durable role. Other harnesses are grouped after launch.
      if (!asLeader) {
        try {
          await assignSessionToRoom(room.name, id)
        } catch (cause) {
          setUnassignedChat({
            id,
            room: room.name,
            detail: cause instanceof Error ? cause.message : String(cause),
          })
          props.onSessionsChanged?.()
          return
        }
      }
      props.onSessionsChanged?.()
      props.onOpen(id)
    } catch (e: any) { alert(e.message) }
    finally { setBusy(false) }
  }

  async function doRenameRoom(room: RoomInfo) {
    const name = prompt('Rename room (lowercase, digits, dashes):', room.name)?.trim()
    if (!name || name === room.name) return
    setBusy(true)
    try {
      await renameRoom(room.name, name)
      const harnesses = { ...roomHarnesses() }
      if (harnesses[room.name]) {
        harnesses[name] = harnesses[room.name]
        delete harnesses[room.name]
        setRoomHarnesses(harnesses)
        saveRoomHarnesses(harnesses)
      }
      await refresh()
      setExpanded(name)
      props.onSessionsChanged?.()
    } catch (e: any) { alert(e.message) }
    finally { setBusy(false) }
  }

  async function moveSession(room: RoomInfo, session: SessionMeta, event: MouseEvent) {
    event.stopPropagation()
    const choices = (rooms() || []).map(candidate => candidate.name).filter(name => name !== room.name)
    if (!choices.length) { alert('Create another room first.'); return }
    const destination = prompt(`Move chat to room:\n${choices.join(', ')}`)?.trim()
    if (!destination) return
    if (!choices.includes(destination)) { alert(`No room named #${destination}`); return }
    setBusy(true)
    try {
      await assignSessionToRoom(destination, session.id)
      await refresh()
      props.onSessionsChanged?.()
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

  async function pauseAllPulses() {
    const enabledRooms = (rooms() || []).filter(room => room.pulse.enabled)
    if (!enabledRooms.length) return
    setBusy(true)
    try {
      const stopped = await Promise.all(enabledRooms.map(async room => ({
        name: room.name,
        pulse: await setRoomPulse(room.name, false),
      })))
      const byName = new Map(stopped.map(item => [item.name, item.pulse]))
      setRooms(current => current?.map(room => byName.has(room.name)
        ? { ...room, pulse: byName.get(room.name)! }
        : room) || null)
    } catch (e: any) { alert(e.message) }
    finally { setBusy(false) }
  }


  function openWiki(room: RoomInfo, event: MouseEvent) {
    event.stopPropagation()
    frictionRequest++
    setFrictionRoom(null)
    const opening = wikiRoom() !== room.name
    if (opening) roomsEpoch++ // discard an in-flight poll that would remount the reader
    setWikiRoom(opening ? room.name : null)
    if (!opening) refresh()
  }

  async function openFriction(room: RoomInfo, event: MouseEvent) {
    event.stopPropagation()
    setWikiRoom(null)
    if (frictionRoom() === room.name) {
      frictionRequest++
      setFrictionRoom(null)
      return
    }
    const request = ++frictionRequest
    setWikiRoom(null)
    setFrictionRoom(room.name)
    setFrictionError(null)
    setFrictionLoading(true)
    try {
      const complaints = await fetchRoomFriction(room.name)
      if (request !== frictionRequest) return
      setFrictionList(complaints)
    }
    catch (error) {
      if (request !== frictionRequest) return
      setFrictionError(error instanceof Error ? error.message : String(error))
      setFrictionList([])
    } finally {
      if (request === frictionRequest) setFrictionLoading(false)
    }
  }


  const toggleExpand = (name: string) => setExpanded(expanded() === name ? null : name)

  function otherRoomSessions(room: RoomInfo) {
    const residentIds = new Set((room.residents || []).map(resident => resident.sessionId))
    return room.sessions.filter(session => !residentIds.has(session.id))
  }

  const agentColor = (a?: string) => a === 'codex' ? '#c084fc' : a === 'omp' ? '#e0a050' : '#73b8ff'
  const agentBg = (a?: string) => a === 'codex' ? '#2a1e3a' : a === 'omp' ? '#3a2a1e' : '#1e2a3a'

  const sessionRow = (room: RoomInfo, s: SessionMeta) => (
    <div onClick={(e) => { e.stopPropagation(); props.onOpen(s.id) }}
      style={{ display: 'flex', 'align-items': 'center', gap: '8px', padding: '9px 16px 9px 28px', 'border-top': '1px solid #16161f', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>
      <span style={{ width: '7px', height: '7px', 'border-radius': '50%', background: s.isActive ? '#4aba6a' : '#333', 'flex-shrink': '0' }} />
      <span style={{ 'font-size': '9px', padding: '1px 5px', 'border-radius': '3px', background: agentBg(s.agent), color: agentColor(s.agent), 'flex-shrink': '0', 'font-weight': '600' }}>{s.agent || 'claude'}</span>
      <span style={{ flex: '1', 'font-size': '13px', color: '#ccc', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{s.title}</span>
      <Show when={(rooms()?.length || 0) > 1}>
        <button aria-label={`Move ${s.title} to another room`} disabled={busy()}
          onClick={(event) => moveSession(room, s, event)}
          style={{ background: 'none', border: 'none', color: '#777', 'font-size': '11px', padding: '3px 5px', cursor: 'pointer', 'flex-shrink': '0' }}>Move</button>
      </Show>
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

        <div data-testid="new-chat-launcher" style={{ background: '#0d1117', border: '1px solid #262b33', 'border-radius': '12px', padding: '12px', 'margin-bottom': '10px' }}>
          <div style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'flex-wrap': 'wrap' }}>
            <span style={{ color: '#9aa4b2', 'font-size': '12px', 'font-weight': '700', 'margin-right': '2px' }}>New chat</span>
            <button onClick={() => props.onNewChat('omp', ompModel().trim() || undefined)} disabled={busy() || props.creating}
              style={{ background: '#e0a050', border: 'none', color: '#111', 'font-size': '12px', 'font-weight': '800', padding: '7px 12px', 'border-radius': '8px', cursor: 'pointer' }}>+ OMP</button>
            <button onClick={() => props.onNewChat('claude')} disabled={busy() || props.creating}
              style={{ background: '#15202a', border: '1px solid #344657', color: '#73b8ff', 'font-size': '12px', 'font-weight': '700', padding: '6px 11px', 'border-radius': '8px', cursor: 'pointer' }}>+ Claude Code</button>
            <Show when={props.codexAvailable}>
              <button onClick={() => props.onNewChat('codex')} disabled={busy() || props.creating}
                style={{ background: '#251b31', border: '1px solid #49345e', color: '#c084fc', 'font-size': '12px', 'font-weight': '700', padding: '6px 11px', 'border-radius': '8px', cursor: 'pointer' }}>+ Codex</button>
            </Show>
          </div>
          <label style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'margin-top': '10px', color: '#78828f', 'font-size': '11px' }}>
            <span style={{ 'flex-shrink': '0' }}>OMP model</span>
            <input
              data-testid="omp-model-override"
              aria-label="OMP model override"
              value={ompModel()}
              onInput={(event) => updateOmpModel(event.currentTarget.value)}
              placeholder="Deployment default"
              spellcheck={false}
              autocapitalize="none"
              style={{ flex: '1', 'min-width': '0', background: '#090d12', border: '1px solid #292f38', color: '#c9d1db', 'font-size': '11px', 'font-family': 'monospace', padding: '6px 8px', 'border-radius': '7px', outline: 'none' }}
            />
          </label>
          <div data-testid="background-work-status" style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'margin-top': '11px', 'padding-top': '10px', 'border-top': '1px solid #1c2128', color: '#78828f', 'font-size': '11px' }}>
            <span style={{ width: '7px', height: '7px', 'border-radius': '50%', background: (rooms() || []).some(room => room.pulse.enabled) ? '#e0a050' : '#4f5965' }} />
            <span>Background work: <strong style={{ color: '#aeb6c0', 'font-weight': '600' }}>{(rooms() || []).some(room => room.pulse.enabled) ? `${(rooms() || []).filter(room => room.pulse.enabled).length} room${(rooms() || []).filter(room => room.pulse.enabled).length === 1 ? '' : 's'} enabled` : 'all paused'}</strong></span>
            <Show when={(rooms() || []).some(room => room.pulse.enabled)}>
              <button data-testid="pause-all-background" onClick={pauseAllPulses} disabled={busy()}
                style={{ 'margin-left': 'auto', background: '#24191a', border: '1px solid #5c3336', color: '#e18a8e', 'font-size': '11px', 'font-weight': '700', padding: '4px 9px', 'border-radius': '7px', cursor: 'pointer' }}>Stop all</button>
            </Show>
          </div>
        </div>
        <Show when={error()}>
          <div style={{ color: '#d45555', 'font-size': '13px', padding: '8px 4px' }}>{error()}</div>
        </Show>
        <Show when={unassignedChat()}>
          {(failed) => (
            <div role="alert" data-testid="room-assignment-recovery" style={{ color: '#ffaaa3', background: '#2a1515', border: '1px solid #61312d', 'border-radius': '9px', padding: '10px 12px', 'margin-bottom': '10px', 'font-size': '12px', 'line-height': '1.45' }}>
              <div>Chat <code>{failed().id}</code> was created, but could not be added to #{failed().room}. It remains ungrouped. {failed().detail}</div>
              <button onClick={() => { const chat = failed(); setUnassignedChat(null); props.onOpen(chat.id) }}
                style={{ 'margin-top': '8px', background: '#4a2525', border: '1px solid #7b3e3e', color: '#ffd0cc', 'border-radius': '6px', padding: '5px 9px', cursor: 'pointer', 'font-size': '11px', 'font-weight': '700' }}>
                Open ungrouped chat {failed().id}
              </button>
            </div>
          )}
        </Show>

        <Show when={rooms()} fallback={<div style={{ color: '#555', 'text-align': 'center', padding: '40px', 'font-size': '13px' }}>Loading rooms…</div>}>
          <Show when={rooms()!.length > 0} fallback={
            <div style={{ color: '#555', 'text-align': 'center', padding: '40px', 'font-size': '13px' }}>
              No rooms yet. A room is a folder under ~/rooms/ — create one to start.
            </div>
          }>
            <For each={rooms()!}>{(room) => (
              <div data-testid={`room-card-${room.name}`} style={{ background: '#0d1117', border: '1px solid #1e1e1e', 'border-radius': '12px', 'margin-bottom': '10px', overflow: 'hidden' }}>
                <div onClick={() => toggleExpand(room.name)} style={{ padding: '12px 16px', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>
                  <div style={{ display: 'flex', 'align-items': 'center', gap: '10px' }}>
                    <span style={{ width: '10px', height: '10px', 'border-radius': '50%', background: room.active ? '#4aba6a' : '#333', 'flex-shrink': '0' }} />
                    <span style={{ 'font-size': '16px', 'font-weight': '700', color: '#e5e5e5' }}>#{room.name}</span>
                    <Show when={leaderRoomSession(room)} fallback={<span style={{ 'font-size': '11px', color: '#806f55' }}>No Leader</span>}>
                      {(leader) => <span style={{ 'font-size': '11px', color: '#69c77f' }}>Leader · {leader().agent || 'omp'} · {room.residents?.length || 1} resident{(room.residents?.length || 1) === 1 ? '' : 's'}</span>}
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
                      {room.pulse.enabled ? 'Stop background' : 'Start background'}
                    </button>
                    <span style={{ color: room.pulse.status === 'error' ? '#d48166' : '#666', 'font-size': '11px' }}>{pulseLabel(room)}</span>
                    <button data-testid={`wiki-${room.name}`} onClick={(event) => openWiki(room, event)}
                      aria-label={`Wiki for #${room.name}`}
                      style={{ 'margin-left': 'auto', display: 'flex', 'align-items': 'center', gap: '6px', background: wikiRoom() === room.name ? '#1a1f2e' : 'transparent', border: '1px solid #2a3346', color: '#9aa4b2', 'font-size': '11px', 'font-weight': '600', padding: '3px 9px', 'border-radius': '999px', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>
                      Wiki
                    </button>
                    <button data-testid={`friction-${room.name}`} onClick={(event) => openFriction(room, event)}
                      aria-label={`Friction from #${room.name}`}
                      style={{ display: 'flex', 'align-items': 'center', gap: '5px', background: frictionRoom() === room.name ? '#2a2115' : 'transparent', border: '1px solid #3a3328', color: '#b7a27d', 'font-size': '11px', 'font-weight': '600', padding: '3px 8px', 'border-radius': '999px', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>
                      Friction <span style={{ color: '#6f6250', 'font-weight': '500' }}>{room.friction?.count || 0}</span>
                    </button>
                  </div>
                </div>
                <Show when={wikiRoom() === room.name}>
                  <div data-testid={`wiki-panel-${room.name}`} style={{ height: '60vh', 'border-top': '1px solid #16161f', background: '#0a0d13' }}>
                    <RoomWikiView room={room.name} />
                  </div>
                </Show>
                <Show when={frictionRoom() === room.name}>
                  <div data-testid={`friction-panel-${room.name}`} style={{ 'border-top': '1px solid #1c1a16', padding: '8px 16px 12px', background: '#0b0d10' }}>
                    <Show when={frictionError()}>
                      <div style={{ color: '#d45555', 'font-size': '12px', padding: '4px 0' }}>{frictionError()}</div>
                    </Show>
                    <Show when={frictionLoading()}>
                      <div style={{ color: '#666', 'font-size': '12px', padding: '4px 0' }}>Loading friction…</div>
                    </Show>
                    <Show when={!frictionLoading() && !frictionError() && frictionList().length === 0}>
                      <div style={{ color: '#666', 'font-size': '12px', padding: '4px 0' }}>No friction reported from #{room.name}.</div>
                    </Show>
                    <For each={frictionList()}>{(complaint) => (
                      <article style={{ padding: '9px 0', 'border-bottom': '1px solid #171713' }}>
                        <div style={{ color: '#5a6472', 'font-size': '10px', 'font-family': 'monospace', 'margin-bottom': '3px' }}>{updateTimeLabel(complaint.timestamp)}</div>
                        <div style={{ color: '#d0d4da', 'font-size': '13px', 'line-height': '1.45', 'white-space': 'pre-wrap', 'word-break': 'break-word' }}>{complaint.summary}</div>
                        <Show when={complaint.evidence}>
                          <div style={{ color: '#77818f', 'font-size': '11px', 'font-family': 'monospace', 'line-height': '1.4', 'margin-top': '5px', 'white-space': 'pre-wrap', 'word-break': 'break-word' }}>{complaint.evidence}</div>
                        </Show>
                      </article>
                    )}</For>
                  </div>
                </Show>
                <Show when={expanded() === room.name}>
                  <div data-testid={`residents-${room.name}`} style={{ 'border-top': '1px solid #16161f', padding: '7px 16px 9px 28px' }}>
                    <div style={{ color: '#596373', 'font-size': '9px', 'font-weight': '700', 'text-transform': 'uppercase', 'letter-spacing': '0.06em', 'margin-bottom': '5px' }}>Residents</div>
                    <For each={room.residents || []}>{(resident) => (
                      <div data-testid={`resident-${room.name}-${resident.role}`} onClick={() => props.onOpen(resident.sessionId)} style={{ display: 'flex', 'align-items': 'center', gap: '8px', padding: '5px 0', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>
                        <span style={{ width: '7px', height: '7px', 'border-radius': '50%', background: resident.status === 'working' ? '#4aba6a' : resident.status === 'waiting' ? '#596373' : '#5c3333', 'flex-shrink': '0' }} />
                        <span style={{ color: resident.role === 'leader' ? '#69c77f' : '#b6bfcc', 'font-size': '12px', 'font-weight': '650', 'text-transform': 'capitalize' }}>{resident.role}</span>
                        <span style={{ color: agentColor(resident.agent), 'font-size': '9px', 'font-weight': '600' }}>{resident.agent}</span>
                        <span style={{ color: '#555f6d', 'font-size': '10px', 'margin-left': 'auto' }}>{resident.status}</span>
                      </div>
                    )}</For>
                  </div>
                  <For each={otherRoomSessions(room)}>{(session) => sessionRow(room, session)}</For>
                  <div style={{ display: 'flex', 'flex-wrap': 'wrap', gap: '8px', padding: '10px 16px 12px 28px', 'border-top': '1px solid #16161f', position: 'relative' }}>
                    <button onClick={() => leaderRoomSession(room) ? newChat(room) : newChat(room, 'omp', true)} disabled={busy()}
                      style={{ background: roomHarness(room.name) === 'omp' ? '#3a2a1e' : '#15202a', border: `1px solid ${roomHarness(room.name) === 'omp' ? '#68481f' : '#344657'}`, color: roomHarness(room.name) === 'omp' ? '#e0a050' : agentColor(roomHarness(room.name)), 'font-size': '12px', 'font-weight': '700', padding: '6px 12px', 'border-radius': '8px', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>{leaderRoomSession(room) ? `+ New ${agentLabel(roomHarness(room.name))} chat` : '+ Start OMP Leader'}</button>
                    <details style={{ position: 'relative' }}>
                      <summary style={{ 'list-style': 'none', background: 'none', border: '1px solid #2b3038', color: '#777', 'font-size': '11px', padding: '6px 9px', 'border-radius': '8px', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>Room options</summary>
                      <div style={{ position: 'absolute', top: '34px', left: '0', width: '180px', padding: '8px', background: '#11151c', border: '1px solid #333', 'border-radius': '9px', 'box-shadow': '0 8px 24px rgba(0,0,0,.45)', 'z-index': '20', display: 'flex', 'flex-direction': 'column', gap: '7px' }}>
                        <label style={{ color: '#777', 'font-size': '10px', display: 'flex', 'flex-direction': 'column', gap: '4px' }}>Default harness
                          <select aria-label={`Default harness for #${room.name}`} value={roomHarness(room.name)} onChange={(event) => setRoomHarness(room.name, event.currentTarget.value as AgentId)}
                            style={{ background: '#0c1016', border: '1px solid #333', color: '#ddd', padding: '6px', 'border-radius': '6px' }}>
                            <option value="omp">OMP</option><option value="claude">Claude Code</option><option value="codex">Codex</option>
                          </select>
                        </label>
                        <div style={{ color: '#666', 'font-size': '10px' }}>Start one fallback chat</div>
                        <button onClick={() => newChat(room, 'claude')} disabled={busy()}
                          style={{ background: 'none', border: '1px solid #29313b', color: '#73b8ff', 'font-size': '11px', padding: '6px 8px', 'border-radius': '7px', cursor: 'pointer', 'text-align': 'left' }}>Claude Code</button>
                        <button onClick={() => newChat(room, 'codex')} disabled={busy()}
                          style={{ background: 'none', border: '1px solid #332a3d', color: '#c084fc', 'font-size': '11px', padding: '6px 8px', 'border-radius': '7px', cursor: 'pointer', 'text-align': 'left' }}>Codex</button>
                        <button onClick={() => doRenameRoom(room)} disabled={busy()}
                          style={{ background: 'none', border: 'none', 'border-top': '1px solid #292d34', color: '#999', 'font-size': '11px', padding: '7px 2px 2px', cursor: 'pointer', 'text-align': 'left' }}>Rename room…</button>
                      </div>
                    </details>
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
