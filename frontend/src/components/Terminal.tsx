import { onMount, onCleanup, createEffect, createSignal, Show } from 'solid-js'
import { init, Terminal as GhosttyTerm, FitAddon } from 'ghostty-web'

const basePath = location.pathname.replace(/\/+$/, '')
const BASE_WS = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${basePath}/api/terminal`

const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)

let wasmReady: Promise<void> | null = null
function ensureInit() {
  if (!wasmReady) wasmReady = init()
  return wasmReady
}

export function Terminal(props: { sessionId: string | null }) {
  let containerRef: HTMLDivElement | undefined
  let term: GhosttyTerm | null = null
  let fitAddon: FitAddon | null = null
  let ws: WebSocket | null = null
  const [copied, setCopied] = createSignal(false)
  const [hasSelection, setHasSelection] = createSignal(false)

  async function connect(sessionId: string) {
    disconnect()
    await ensureInit()

    term = new GhosttyTerm({
      theme: { background: '#0a0e14', foreground: '#e5e5e5', cursor: '#4aba6a' },
      fontSize: 13,
      fontFamily: "'SF Mono', Menlo, 'Courier New', monospace",
      cursorBlink: true,
      scrollback: 5000,
    })
    fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    if (containerRef) {
      term.open(containerRef)
      fitAddon.fit()
    }

    // Track selection changes
    if (term.onSelectionChange) {
      term.onSelectionChange(() => {
        setHasSelection(term?.hasSelection() || false)
      })
    }

    ws = new WebSocket(`${BASE_WS}?session=${sessionId}`)
    ws.onmessage = (e) => term?.write(e.data)
    ws.onclose = () => term?.write('\r\n\x1b[90m[disconnected]\x1b[0m\r\n')

    ws.onopen = () => {
      if (fitAddon && ws) {
        const dims = fitAddon.proposeDimensions()
        if (dims) ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }))
      }
    }

    term.onData((data) => { try { ws?.send(data) } catch {} })
    term.onResize(({ cols, rows }) => {
      try { ws?.send(JSON.stringify({ type: 'resize', cols, rows })) } catch {}
    })
  }

  function disconnect() {
    ws?.close()
    ws = null
    term?.dispose()
    term = null
    fitAddon = null
  }

  async function handleCopy() {
    if (!term) return
    let text = ''
    if (term.hasSelection()) {
      text = term.getSelection()
    } else {
      // Select all and copy
      term.selectAll()
      text = term.getSelection()
      term.deselect()
    }
    if (text) {
      try {
        await navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      } catch {}
    }
  }

  async function handlePaste() {
    if (!term) return
    try {
      const text = await navigator.clipboard.readText()
      if (text) term.paste(text)
    } catch {}
  }

  function handleSelectAll() {
    if (!term) return
    term.selectAll()
    setHasSelection(true)
  }

  createEffect(() => {
    const sid = props.sessionId
    if (sid) connect(sid)
    else disconnect()
  })

  onMount(() => {
    const onResize = () => { try { fitAddon?.fit() } catch {} }
    window.addEventListener('resize', onResize)
    onCleanup(() => { window.removeEventListener('resize', onResize); disconnect() })
  })

  const btnStyle = {
    background: '#1a1a2e',
    border: '1px solid #333',
    color: '#aaa',
    'font-size': '12px',
    'font-weight': '500',
    padding: '6px 12px',
    'border-radius': '6px',
    cursor: 'pointer',
    '-webkit-tap-highlight-color': 'transparent',
    display: 'flex',
    'align-items': 'center',
    gap: '4px',
  }

  return (
    <div style={{ height: '100%', width: '100%', display: 'flex', 'flex-direction': 'column', background: '#0a0e14' }}>
      {/* Mobile toolbar */}
      <Show when={isMobile}>
        <div style={{ display: 'flex', gap: '6px', padding: '6px 8px', 'border-bottom': '1px solid #1e1e1e', 'flex-shrink': '0', 'overflow-x': 'auto' }}>
          <button onClick={handleSelectAll} style={btnStyle}>Select All</button>
          <button onClick={handleCopy} style={{ ...btnStyle, color: copied() ? '#4aba6a' : '#aaa' }}>
            {copied() ? 'Copied!' : hasSelection() ? 'Copy Selection' : 'Copy All'}
          </button>
          <button onClick={handlePaste} style={btnStyle}>Paste</button>
        </div>
      </Show>
      <div ref={containerRef}
        onKeyDown={(e) => e.stopPropagation()}
        onKeyPress={(e) => e.stopPropagation()}
        onKeyUp={(e) => e.stopPropagation()}
        style={{
          flex: '1', width: '100%', background: '#0a0e14',
          padding: '4px', 'min-height': '0',
      }} />
    </div>
  )
}
