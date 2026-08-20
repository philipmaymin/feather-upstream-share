import { createSignal, createEffect, onCleanup, For, Show } from 'solid-js'
import { fetchSidecar, postSidecar, addSidecarPeer, removeSidecarPeer, subscribeSidecar } from '../api'
import type { SidecarGroup, SidecarMessage } from '../api'

// SidecarThread: the live thread view for one sidecar group, rendered in an
// overlay opened from the session that owns it. The group list is no longer a
// standalone tab — sidecars are nested under their driver session in App.
export function SidecarThread(props: {
  id: () => string | null
  onClose: () => void
  onOpenSession: (id: string) => void
  onChange?: () => void
}) {
  const [group, setGroup] = createSignal<SidecarGroup | null>(null)
  const [thread, setThread] = createSignal<SidecarMessage[]>([])
  const [draft, setDraft] = createSignal('')
  const [recipient, setRecipient] = createSignal('')

  createEffect(() => {
    const id = props.id()
    setGroup(null); setThread([]); setRecipient('')
    if (!id) return
    fetchSidecar(id).then(r => { setGroup(r.group); setThread(r.thread || []) }).catch(() => {})
    const unsub = subscribeSidecar(id, (m) => setThread(prev => [...prev, m]))
    onCleanup(unsub)
  })

  const driverRole = () => group()?.members.find(m => !m.spawned)?.role || 'driver'
  const peerRoles = () => (group()?.members.filter(m => m.spawned) || []).map(m => m.role)
  const recipientOptions = () => { const p = peerRoles(); return p.length > 1 ? ['all', ...p] : p }
  const currentRecipient = () => recipient() || recipientOptions()[0] || 'peer'

  async function reload() {
    const id = props.id()
    if (id) { try { setGroup((await fetchSidecar(id)).group) } catch {} }
    props.onChange?.()
  }
  async function send() {
    const id = props.id(); const text = draft().trim()
    if (!id || !text) return
    setDraft('')
    try { await postSidecar(id, currentRecipient(), text, driverRole()) }
    catch (e: any) { alert('Send failed: ' + (e?.message || e)) }
  }
  async function addPeer() {
    const id = props.id(); if (!id) return
    const role = (prompt('Role for the new peer (e.g. critic-perf):') || '').trim(); if (!role) return
    const agent = (prompt('Agent (claude / codex):', 'claude') || 'claude').trim()
    const task = prompt('Task / rubric for this peer (optional):') ?? ''
    try { await addSidecarPeer(id, role, { agent, task }); await reload() }
    catch (e: any) { alert('Add peer failed: ' + (e?.message || e)) }
  }
  async function removePeer(role: string) {
    const id = props.id(); if (!id) return
    if (!confirm(`Remove peer "${role}"? (kills its session)`)) return
    try { await removeSidecarPeer(id, role); await reload() } catch {}
  }

  const btn = { padding: '4px 8px', 'font-size': '11px', border: '1px solid #333', background: '#1a1a1a', color: '#bbb', cursor: 'pointer', 'border-radius': '4px' } as const

  return (
    <Show when={group()}>
      <div style={{ display: 'flex', 'flex-direction': 'column', height: '100%', color: '#e5e5e5', 'font-size': '13px' }}>
        <div style={{ padding: '8px', 'border-bottom': '1px solid #222', display: 'flex', 'align-items': 'center', gap: '6px', 'flex-wrap': 'wrap' }}>
          <button style={btn} onClick={() => props.onClose()}>✕ close</button>
          <span style={{ flex: '1', color: '#888', 'font-size': '12px' }}>{group()!.members.map(m => m.role).join(' ↔ ')}</span>
          <For each={group()!.members}>{(m) => (
            <span style={{ display: 'inline-flex', 'align-items': 'center', gap: '2px' }}>
              <button style={btn} onClick={() => props.onOpenSession(m.sessionId)}>open {m.role}</button>
              <Show when={m.spawned}>
                <button style={{ ...btn, padding: '4px 6px' }} title={`remove ${m.role}`} onClick={() => removePeer(m.role)}>×</button>
              </Show>
            </span>
          )}</For>
          <button style={{ ...btn, color: '#6aa6e5' }} onClick={addPeer}>+ peer</button>
        </div>
        <div style={{ flex: '1', overflow: 'auto', padding: '8px', display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
          <For each={thread()}>{(m) => (
            <div style={{ 'border-left': '2px solid #333', padding: '2px 8px' }}>
              <div style={{ color: '#6aa6e5', 'font-size': '11px' }}>{m.from} → {m.to}</div>
              <div style={{ 'white-space': 'pre-wrap' }}>{m.text}</div>
            </div>
          )}</For>
        </div>
        <div style={{ padding: '8px', 'border-top': '1px solid #222', display: 'flex', gap: '6px', 'align-items': 'center' }}>
          <select value={currentRecipient()} onChange={(e) => setRecipient(e.currentTarget.value)} style={{ background: '#111', border: '1px solid #333', color: '#e5e5e5', 'border-radius': '4px', padding: '6px' }}>
            <For each={recipientOptions()}>{(r) => <option value={r}>{r}</option>}</For>
          </select>
          <input
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') send() }}
            placeholder={`message ${currentRecipient()}…`}
            style={{ flex: '1', padding: '6px', background: '#111', border: '1px solid #333', color: '#e5e5e5', 'border-radius': '4px' }}
          />
          <button style={btn} onClick={send}>Send</button>
        </div>
      </div>
    </Show>
  )
}
