import { onMount, onCleanup, createEffect, createSignal, Show, For } from 'solid-js'
import { init, Terminal as GhosttyTerm, FitAddon, OSC8LinkProvider } from 'ghostty-web'
import type { ILink, ILinkProvider } from 'ghostty-web'
import { appWebSocketUrl } from '../lib/appPath.js'
import { extractHttpUrls, findTerminalLineUrls, stripTerminalControlSequences } from '../lib/terminalLinks.js'

const BASE_WS = appWebSocketUrl('/api/terminal')

let wasmReady: Promise<void> | null = null
function ensureInit() {
  if (!wasmReady) wasmReady = init()
  return wasmReady
}

function safeHttpUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch { return null }
}

function openTerminalUrl(value: string) {
  const url = safeHttpUrl(value)
  if (url) window.open(url, '_blank', 'noopener,noreferrer')
}

function lineText(line: any) {
  let result = ''
  for (let column = 0; column < line.length; column++) {
    result += line.getCell(column)?.getChars?.() || ' '
  }
  return result
}

// ghostty-web's built-in URL provider only scans one physical row, so long
// OAuth URLs stop working as soon as the terminal wraps them. Reconstruct the
// logical wrapped line and return one link whose range spans every screen row.
export function wrappedUrlLinks(term: GhosttyTerm, row: number, activate = openTerminalUrl): ILink[] {
  const buffer = term.buffer.active
  if (row < 0 || row >= buffer.length || !buffer.getLine(row)) return []
  const firstRow = Math.max(0, row - 64)
  const lastRow = Math.min(buffer.length - 1, row + 64)
  const lines: string[] = []
  for (let current = firstRow; current <= lastRow; current++) {
    const line = buffer.getLine(current)
    lines.push(line ? lineText(line) : '')
  }

  return findTerminalLineUrls(lines, firstRow)
    .filter(link => row >= link.start.y && row <= link.end.y)
    .map(link => ({
      text: link.url,
      range: { start: link.start, end: link.end },
      activate: () => activate(link.url),
    }))
}

function pointInLink(link: ILink, column: number, row: number) {
  const { start, end } = link.range
  if (row < start.y || row > end.y) return false
  if (start.y === end.y) return column >= start.x && column <= end.x
  if (row === start.y) return column >= start.x
  if (row === end.y) return column <= end.x
  return true
}

function tapProvider(base: ILinkProvider, remember: (links: string[]) => void): ILinkProvider {
  return {
    provideLinks(row, callback) {
      base.provideLinks(row, links => {
        if (links?.length) remember(links.map(link => link.text))
        callback(links?.map(link => ({ ...link, activate: () => openTerminalUrl(link.text) })))
      })
    },
    dispose() { base.dispose?.() },
  }
}

async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const input = document.createElement('textarea')
    input.value = text
    input.style.position = 'fixed'
    input.style.opacity = '0'
    document.body.appendChild(input)
    try {
      input.focus()
      input.select()
      return typeof document.execCommand === 'function' && document.execCommand('copy')
    } catch { return false }
    finally { input.remove() }
  }
}

export function Terminal(props: { sessionId: string | null }) {
  let containerRef: HTMLDivElement | undefined
  let term: GhosttyTerm | null = null
  let fitAddon: FitAddon | null = null
  let ws: WebSocket | null = null
  let rawOutput = ''
  let removeMobileInputFallback: (() => void) | null = null
  let keyboardEnterPending = false
  let keyboardEnterTimer: number | undefined
  let connectionGeneration = 0
  const [copied, setCopied] = createSignal(false)
  const [hasSelection, setHasSelection] = createSignal(false)
  const [terminalLinks, setTerminalLinks] = createSignal<string[]>([])
  const [showLinks, setShowLinks] = createSignal(false)
  const [copiedLink, setCopiedLink] = createSignal('')

  function rememberLinks(values: string[]) {
    const links = values.map(safeHttpUrl).filter((value): value is string => Boolean(value))
    if (!links.length) return
    setTerminalLinks(previous => {
      const ordered = [...previous].reverse()
      for (const link of links) {
        const existing = ordered.indexOf(link)
        if (existing >= 0) ordered.splice(existing, 1)
        ordered.push(link)
      }
      // A hard-wrapped OAuth URL can briefly look like a valid shorter URL
      // before the following rows arrive. Prefer its later, complete form.
      const complete = ordered.filter(link => !ordered.some(other => (
        other !== link && link.includes('?') && other.length > link.length + 8 && other.startsWith(link)
      )))
      return complete.reverse().slice(0, 20)
    })
  }

  function scanTerminalLinks() {
    if (!term) return
    const seen = new Set<string>()
    const found: string[] = []
    const buffer = term.buffer.active
    const firstRow = Math.max(0, buffer.length - 500)
    const lines: string[] = []
    for (let row = firstRow; row < buffer.length; row++) {
      const line = buffer.getLine(row)
      lines.push(line ? lineText(line) : '')
    }
    for (const link of findTerminalLineUrls(lines, firstRow)) {
      const key = `${link.start.y}:${link.start.x}:${link.url}`
      if (seen.has(key)) continue
      seen.add(key)
      found.push(link.url)
    }
    rememberLinks(found)
  }

  function scanRawOutput(data: unknown) {
    if (typeof data !== 'string') return
    rawOutput = (rawOutput + data).slice(-65536)
    rememberLinks(extractHttpUrls(stripTerminalControlSequences(rawOutput)))
  }

  async function connect(sessionId: string) {
    disconnect()
    const generation = connectionGeneration
    setTerminalLinks([])
    setShowLinks(false)
    setCopiedLink('')
    rawOutput = ''
    await ensureInit()
    if (generation !== connectionGeneration) return

    const activeTerm = new GhosttyTerm({
      theme: { background: '#0a0e14', foreground: '#e5e5e5', cursor: '#4aba6a' },
      fontSize: 13,
      fontFamily: "'SF Mono', Menlo, 'Courier New', monospace",
      cursorBlink: true,
      scrollback: 5000,
    })
    term = activeTerm
    fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    if (containerRef) {
      term.open(containerRef)
      fitAddon.fit()

      // Register providers whose activation is a normal tap/click. The
      // library defaults require Ctrl/Cmd, which phones cannot produce.
      const providers: ILinkProvider[] = []
      try {
        const wrappedProvider = tapProvider({
          provideLinks: (row, callback) => callback(term ? wrappedUrlLinks(term, row) : undefined),
        }, rememberLinks)
        const osc8Provider = tapProvider(new OSC8LinkProvider(term as any), rememberLinks)
        providers.push(osc8Provider, wrappedProvider)
        term.registerLinkProvider(wrappedProvider)
        term.registerLinkProvider(osc8Provider)
      } catch {}

      // ghostty-web suppresses the synthetic click after touchend so it can
      // focus its hidden textarea. Resolve a stationary touch to a buffer cell
      // ourselves and activate the same registered link.
      const canvas = containerRef.querySelector('canvas')
      if (canvas) {
        let touchStart: { x: number; y: number } | null = null
        canvas.addEventListener('touchstart', event => {
          const touch = event.touches[0]
          touchStart = touch ? { x: touch.clientX, y: touch.clientY } : null
        }, { passive: true })
        canvas.addEventListener('touchend', async event => {
          const touch = event.changedTouches[0]
          if (!term || !touch || !touchStart || Math.hypot(touch.clientX - touchStart.x, touch.clientY - touchStart.y) > 10) return
          touchStart = null
          const rect = canvas.getBoundingClientRect()
          const column = Math.floor((touch.clientX - rect.left) / (rect.width / term.cols))
          const visibleRow = Math.floor((touch.clientY - rect.top) / (rect.height / term.rows))
          const buffer = term.buffer.active
          const scrollback = Math.max(0, buffer.length - term.rows)
          const absoluteRow = scrollback - Math.floor(term.getViewportY()) + visibleRow
          for (const provider of providers) {
            const links = await new Promise<ILink[] | undefined>(resolve => provider.provideLinks(absoluteRow, resolve))
            const link = links?.find(candidate => pointInLink(candidate, column, absoluteRow))
            if (!link) continue
            link.activate(event as unknown as MouseEvent)
            event.preventDefault()
            event.stopPropagation()
            break
          }
        })
      }

      // iOS may expose the software keyboard's Return only as beforeinput,
      // without the keydown Ghostty expects. Ghostty prevents beforeinput by
      // default, so translate the two Return forms before they disappear.
      const handleMobileBeforeInput = (event: InputEvent) => {
        const isReturn = event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph'
          || (event.inputType === 'insertText' && (event.data === '\n' || event.data === '\r'))
        if (!isReturn) return
        event.preventDefault()
        if (keyboardEnterPending) {
          keyboardEnterPending = false
          if (keyboardEnterTimer !== undefined) window.clearTimeout(keyboardEnterTimer)
          keyboardEnterTimer = undefined
          return
        }
        try { ws?.send('\r') } catch {}
      }
      containerRef.addEventListener('beforeinput', handleMobileBeforeInput as EventListener, true)
      removeMobileInputFallback = () => containerRef?.removeEventListener('beforeinput', handleMobileBeforeInput as EventListener, true)
    }

    // Track selection changes
    if (term.onSelectionChange) {
      term.onSelectionChange(() => {
        setHasSelection(term?.hasSelection() || false)
      })
    }

    const socket = new WebSocket(`${BASE_WS}?session=${sessionId}`)
    ws = socket
    socket.onmessage = (e) => {
      if (generation !== connectionGeneration || term !== activeTerm) return
      scanRawOutput(e.data)
      activeTerm.write(e.data, scanTerminalLinks)
    }
    socket.onclose = () => {
      if (generation === connectionGeneration && term === activeTerm) activeTerm.write('\r\n\x1b[90m[disconnected]\x1b[0m\r\n')
    }

    socket.onopen = () => {
      if (generation === connectionGeneration && fitAddon && ws === socket) {
        const dims = fitAddon.proposeDimensions()
        if (dims) socket.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }))
      }
    }

    activeTerm.onData((data) => {
      if (data === '\r') {
        keyboardEnterPending = true
        if (keyboardEnterTimer !== undefined) window.clearTimeout(keyboardEnterTimer)
        keyboardEnterTimer = window.setTimeout(() => {
          keyboardEnterPending = false
          keyboardEnterTimer = undefined
        }, 0)
      }
      try { if (generation === connectionGeneration) socket.send(data) } catch {}
    })
    activeTerm.onResize(({ cols, rows }) => {
      try { if (generation === connectionGeneration) socket.send(JSON.stringify({ type: 'resize', cols, rows })) } catch {}
      queueMicrotask(scanTerminalLinks)
    })
  }

  function disconnect() {
    connectionGeneration++
    removeMobileInputFallback?.()
    removeMobileInputFallback = null
    keyboardEnterPending = false
    if (keyboardEnterTimer !== undefined) window.clearTimeout(keyboardEnterTimer)
    keyboardEnterTimer = undefined
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
        if (await writeClipboard(text)) {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }
      } catch {}
    }
  }

  async function copyLink(link: string) {
    if (!await writeClipboard(link)) return
    setCopiedLink(link)
    setTimeout(() => setCopiedLink(current => current === link ? '' : current), 1500)
  }

  function toggleLinks() {
    setShowLinks(value => !value)
    queueMicrotask(() => { try { fitAddon?.fit() } catch {} })
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
    'flex-shrink': '0',
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
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => sendKey('\r')}
          aria-label="Enter"
          title="Enter"
          style={{ ...keyStyle, 'font-size': '12px', 'min-width': '66px' }}
        >Enter ↵</button>
        <button onClick={toggleLinks} aria-controls="terminal-links" aria-expanded={showLinks()} style={{ ...btnStyle, color: showLinks() ? '#4aba6a' : '#73b8ff' }}>
          {terminalLinks().length > 0 ? `Links (${terminalLinks().length})` : 'Links'}
        </button>
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
      <Show when={showLinks()}>
        <div id="terminal-links" data-testid="terminal-links" aria-live="polite" style={{ padding: '8px', background: '#0d1117', 'border-bottom': '1px solid #1e1e1e', display: 'flex', 'flex-direction': 'column', gap: '6px', 'max-height': '35%', overflow: 'auto', 'flex-shrink': '0' }}>
          <Show when={terminalLinks().length > 0} fallback={(
            <div style={{ color: '#888', 'font-size': '12px', padding: '3px 2px' }}>No complete links found yet. Keep this open and new terminal links will appear here.</div>
          )}>
            <For each={terminalLinks()}>{link => (
              <div style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'min-width': '0' }}>
                <a href={link} target="_blank" rel="noopener noreferrer" title={link} style={{ flex: '1', 'min-width': '0', color: '#73b8ff', 'font-size': '12px', 'font-family': "'SF Mono', Menlo, monospace", overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{link}</a>
                <button onClick={() => copyLink(link)} style={{ ...btnStyle, padding: '4px 9px', color: copiedLink() === link ? '#4aba6a' : '#aaa', 'flex-shrink': '0' }}>{copiedLink() === link ? 'Copied!' : 'Copy'}</button>
              </div>
            )}</For>
          </Show>
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
