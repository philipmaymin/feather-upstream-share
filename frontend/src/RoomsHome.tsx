import { createSignal, onMount, onCleanup, Show, For } from 'solid-js'
import { fetchRooms, createRoom, createSession, assignSessionToRoom } from './api'
import type { RoomInfo, SessionMeta } from './api'

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

function snippetLabel(latest: { role: string, text: string } | null) {
  if (!latest) return 'No messages yet'
  const prefix = latest.role === 'user' ? 'you: ' : latest.role === 'notes' ? 'notes: ' : ''
  return prefix + latest.text
}

export default function RoomsHome(props: { onOpen: (id: string) => void, onSessionsChanged?: () => void }) {
  const [rooms, setRooms] = createSignal<RoomInfo[] | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [expanded, setExpanded] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)

  async function refresh() {
    try { setRooms(await fetchRooms()); setError(null) }
    catch (e: any) { setError(e.message) }
  }

  let timer: ReturnType<typeof setInterval>
  onMount(() => { refresh(); timer = setInterval(refresh, 10000) })
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
                </div>
                <Show when={expanded() === room.name}>
                  <For each={room.sessions}>{(s) => sessionRow(room, s)}</For>
                  <div style={{ display: 'flex', gap: '8px', padding: '10px 16px 12px 28px', 'border-top': '1px solid #16161f' }}>
                    <button onClick={() => newChat(room)} disabled={busy()}
                      style={{ background: '#152a1c', border: '1px solid #2a4a34', color: '#4aba6a', 'font-size': '12px', 'font-weight': '600', padding: '5px 12px', 'border-radius': '8px', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>+ New chat here</button>
                    <button onClick={() => newChat(room, 'codex')} disabled={busy()}
                      style={{ background: 'none', border: '1px solid #333', color: '#c084fc', 'font-size': '12px', padding: '5px 12px', 'border-radius': '8px', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>codex</button>
                  </div>
                </Show>
              </div>
            )}</For>
          </Show>
        </Show>
      </div>
    </div>
  )
}
