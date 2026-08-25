import { Show, createMemo } from 'solid-js'
import type { ProtocolRunSnapshot } from '../api'
import { protocolRunView } from '../lib/protocolRuns.js'

function stateColor(state: ProtocolRunSnapshot['status']) {
  if (state === 'succeeded') return 'var(--success)'
  if (state === 'failed' || state === 'start_failed') return 'var(--error)'
  if (state === 'cancelled' || state === 'interrupted') return 'var(--warning)'
  return 'var(--info)'
}

export function ProtocolRunCard(props: { run: ProtocolRunSnapshot }) {
  const view = createMemo(() => protocolRunView(props.run))
  return (
    <aside
      data-testid={`chat-protocol-run-${props.run.runId}`}
      data-invocation-message-id={props.run.invocationMessageId}
      aria-live={view().isTerminal ? 'off' : 'polite'}
      style={{
        width: 'min(100%, 680px)', margin: '0 0 12px', padding: '10px 12px',
        background: 'var(--bg-secondary)', border: '1px solid var(--border-medium)',
        'border-left': `3px solid ${stateColor(props.run.status)}`, 'border-radius': '8px',
        display: 'flex', 'align-items': 'center', gap: '12px', 'box-sizing': 'border-box',
      }}
    >
      <div style={{ 'min-width': '0', flex: '1' }}>
        <div style={{ display: 'flex', 'align-items': 'baseline', gap: '8px', 'min-width': '0' }}>
          <strong style={{ color: 'var(--text-primary)', 'font-size': '12px' }}>Advisory</strong>
          <span style={{ color: stateColor(props.run.status), 'font-size': '9px', 'font-weight': '800', 'text-transform': 'uppercase', 'letter-spacing': '0.08em' }}>{view().statusLabel}</span>
        </div>
        <div style={{ color: 'var(--text-secondary)', 'font-size': '11px', 'line-height': '1.4', 'margin-top': '3px', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{view().summary}</div>
        <Show when={view().verdict?.recommendation}>
          <div style={{ color: 'var(--text-primary)', 'font-size': '11px', 'line-height': '1.4', 'margin-top': '5px', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{view().verdict!.recommendation}</div>
        </Show>
      </div>
    </aside>
  )
}
