import { onMount, onCleanup, createEffect, createSignal } from 'solid-js'
import { init, Terminal as GhosttyTerm, FitAddon, UrlRegexProvider, OSC8LinkProvider } from 'ghostty-web'

const basePath = location.pathname.replace(/\/+$/, '')
const BASE_WS = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${basePath}/api/terminal`

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

      // Register link providers so URLs are clickable (Ctrl/Cmd+click opens them)
      try {
        // URL regex provider detects http/https links
        const urlProvider = new UrlRegexProvider(term as any)
        term.registerLinkProvider(urlProvider)
        // OSC 8 hyperlinks (explicit terminal hyperlinks)
        const osc8Provider = new OSC8LinkProvider(term as any)
        term.registerLinkProvider(osc8Provider)
      } catch {}

      // Also allow plain click on links (no modifier) for mobile/convenience
      const canvas = containerRef.querySelector('canvas')
      if (canvas) {
        canvas.addEventListener('click', async (e) => {
          if (e.ctrlKey || e.metaKey) return // already handled by ghostty
          if (!term) return
          const rect = canvas.getBoundingClientRect()
          const renderer = (term as any).renderer
          if (!renderer || !renderer.charWidth || !renderer.charHeight) return
          const col = Math.floor((e.clientX - rect.left) / renderer.charWidth)
          const row = Math.floor((e.clientY - rect.top) / renderer.charHeight)
          const detector = (term as any).linkDetector
          if (!detector) return
          const scrollback = (term as any).wasmTerm?.getScrollbackLength?.() || 0
          const absRow = scrollback + row
          const link = await detector.getLinkAt(col, absRow)
          if (link) {
            window.open(link.text, '_blank', 'noopener,noreferrer')
            e.preventDefault()
            e.stopPropagation()
          }
        })
      }
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
      ;(term as any).deselect()
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

  // A phone keyboard has no arrow or escape keys. Send the same bytes a
  // physical key would write, then return focus to the terminal.
  function sendKey(seq: string) {
    try { ws?.send(seq) } catch {}
    try { (term as any)?.focus?.() } catch {}
  }

  const KEYS: [string, string, string][] = [
    ['\x1b', 'ESC', 'Escape'],
    ['\x1b[D', '←', 'Left arrow'],
    ['\x1b[B', '↓', 'Down arrow'],
    ['\x1b[A', '↑', 'Up arrow'],
    ['\x1b[C', '→', 'Right arrow'],
  ]

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

  const keyStyle = {
    ...btnStyle,
    'font-size': '15px',
    padding: '8px 0',
    'min-width': '44px',
    'min-height': '40px',
    'justify-content': 'center',
    'flex-shrink': '0',
  }

  return (
    <div style={{ height: '100%', width: '100%', display: 'flex', 'flex-direction': 'column', background: '#0a0e14' }}>
      {/* Terminal toolbar */}
      <div style={{ display: 'flex', gap: '6px', padding: '6px 8px', 'border-bottom': '1px solid #1e1e1e', 'flex-shrink': '0', 'overflow-x': 'auto' }}>
        <button onClick={handleSelectAll} style={btnStyle}>Select All</button>
        <button onClick={handleCopy} style={{ ...btnStyle, color: copied() ? '#4aba6a' : '#aaa' }}>
          {copied() ? 'Copied!' : hasSelection() ? 'Copy Selection' : 'Copy All'}
        </button>
        <button onClick={handlePaste} style={btnStyle}>Paste</button>
        {KEYS.map(([seq, label, aria]) => (
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => sendKey(seq)}
            aria-label={aria}
            title={aria}
            style={keyStyle}
          >{label}</button>
        ))}
      </div>
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
