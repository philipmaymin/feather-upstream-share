import { onMount, onCleanup, createEffect, createSignal, Show, For } from 'solid-js'
import { init, Terminal as GhosttyTerm, FitAddon, OSC8LinkProvider } from 'ghostty-web'
import type { ILink, ILinkProvider } from 'ghostty-web'
import { sendSessionKeys } from '../api'
import { appWebSocketUrl } from '../lib/appPath.js'
import { completeTerminalUrl, extractDeviceCodes, extractHttpUrls, extractOsc8HttpUrls, findTerminalLineUrls, stripTerminalControlSequences } from '../lib/terminalLinks.js'

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
  let reconnectTimer: number | undefined
  let pendingTerminalInput: string[] = []
  let rawOutput = ''
  let removeMobileInputFallback: (() => void) | null = null
  let keyboardEnterPending = false
  let keyboardEnterTimer: number | undefined
  let keyNoticeTimer: number | undefined
  let lastTouchKeyAt = 0
  let connectionGeneration = 0
  const [copied, setCopied] = createSignal(false)
  const [hasSelection, setHasSelection] = createSignal(false)
  const [terminalLinks, setTerminalLinks] = createSignal<string[]>([])
  const [terminalCodes, setTerminalCodes] = createSignal<string[]>([])
  const [explicitLinkTargets, setExplicitLinkTargets] = createSignal<string[]>([])
  const [showLinks, setShowLinks] = createSignal(false)
  const [copiedLink, setCopiedLink] = createSignal('')
  const [copiedCode, setCopiedCode] = createSignal('')
  const [keyNotice, setKeyNotice] = createSignal('')

  function sendTerminalData(data: string) {
    try {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(data)
        return
      }
    } catch {}
    pendingTerminalInput = [...pendingTerminalInput, data].slice(-100)
  }

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
      const complete = ordered.filter(link => (
        !explicitLinkTargets().some(target => (
          target !== link && target.length > link.length + 8 && target.startsWith(link)
        ))
        && !ordered.some(other => (
          other !== link && link.includes('?') && other.length > link.length + 8 && other.startsWith(link)
        ))
      ))
      return complete.reverse().slice(0, 20)
    })
  }

  function rememberExplicitTargets(values: string[]) {
    const targets = values.map(safeHttpUrl).filter((value): value is string => Boolean(value))
    if (!targets.length) return
    setExplicitLinkTargets(previous => {
      const next = [...previous]
      for (const target of targets) {
        const existing = next.indexOf(target)
        if (existing >= 0) next.splice(existing, 1)
        next.unshift(target)
      }
      return next.slice(0, 20)
    })
    // A tmux redraw can expose a valid-looking prefix before the preserved OSC
    // 8 target reaches us. Drop that dead endpoint once its full target arrives.
    setTerminalLinks(previous => previous.filter(link => !targets.some(target => (
      target !== link && target.length > link.length + 8 && target.startsWith(link)
    ))))
    rememberLinks(targets)
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
    const explicitTargets = extractOsc8HttpUrls(rawOutput)
    rememberExplicitTargets(explicitTargets)
    const printable = stripTerminalControlSequences(rawOutput)
    rememberLinks([
      ...extractHttpUrls(printable),
    ])
    const codes = extractDeviceCodes(printable)
    if (codes.length) {
      if (terminalCodes().length === 0) {
        setShowLinks(true)
        queueMicrotask(() => { try { fitAddon?.fit() } catch {} })
      }
      setTerminalCodes(codes.slice(-5).reverse())
    }
  }

  async function connect(sessionId: string) {
    disconnect()
    const generation = connectionGeneration
    setTerminalLinks([])
    setTerminalCodes([])
    setExplicitLinkTargets([])
    setShowLinks(false)
    setCopiedLink('')
    setCopiedCode('')
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
          provideLinks: (row, callback) => callback(term ? wrappedUrlLinks(term, row).map(link => {
            const target = completeTerminalUrl(link.text, explicitLinkTargets())
            return { ...link, text: target, activate: () => openTerminalUrl(target) }
          }) : undefined),
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
        sendTerminalData('\r')
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

    let connectedOnce = false
    const openSocket = () => {
      if (generation !== connectionGeneration || term !== activeTerm) return
      const socket = new WebSocket(`${BASE_WS}?session=${sessionId}`)
      let socketOpened = false
      ws = socket
      socket.onmessage = (e) => {
        if (generation !== connectionGeneration || term !== activeTerm || ws !== socket) return
        if (typeof e.data === 'string' && e.data.startsWith('{')) {
          try {
            const control = JSON.parse(e.data)
            if (control?.type === 'terminal-links' && Array.isArray(control.links)) {
              rememberExplicitTargets(control.links)
              return
            }
          } catch {}
        }
        scanRawOutput(e.data)
        activeTerm.write(e.data, scanTerminalLinks)
      }
      socket.onclose = (event) => {
        if (generation !== connectionGeneration || term !== activeTerm || ws !== socket) return
        ws = null
        if (socketOpened) activeTerm.write('\r\n\x1b[90m[disconnected — reconnecting…]\x1b[0m\r\n')
        if (event.code === 1000 && event.reason === 'Session not active') return
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = undefined
          openSocket()
        }, 750)
      }
      socket.onopen = () => {
        if (generation !== connectionGeneration || fitAddon === null || ws !== socket) return
        socketOpened = true
        if (connectedOnce) activeTerm.write('\r\n\x1b[90m[reconnected]\x1b[0m\r\n')
        connectedOnce = true
        const dims = fitAddon.proposeDimensions()
        if (dims) socket.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }))
        const queued = pendingTerminalInput
        pendingTerminalInput = []
        for (const data of queued) socket.send(data)
      }
    }
    openSocket()

    activeTerm.onData((data) => {
      if (data === '\r') {
        keyboardEnterPending = true
        if (keyboardEnterTimer !== undefined) window.clearTimeout(keyboardEnterTimer)
        keyboardEnterTimer = window.setTimeout(() => {
          keyboardEnterPending = false
          keyboardEnterTimer = undefined
        }, 0)
      }
      if (generation === connectionGeneration) sendTerminalData(data)
    })
    activeTerm.onResize(({ cols, rows }) => {
      try { if (generation === connectionGeneration && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows })) } catch {}
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
    if (keyNoticeTimer !== undefined) window.clearTimeout(keyNoticeTimer)
    keyNoticeTimer = undefined
    setKeyNotice('')
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
    reconnectTimer = undefined
    pendingTerminalInput = []
    lastTouchKeyAt = 0
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

  async function copyCode(code: string) {
    if (!await writeClipboard(code)) return
    setCopiedCode(code)
    setTimeout(() => setCopiedCode(current => current === code ? '' : current), 1500)
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

  // Toolbar keys use the server's tmux endpoint instead of depending on the
  // terminal canvas WebSocket. That path remains usable while Ghostty is
  // reconnecting and gives a phone user visible success/failure feedback.
  async function sendToolbarKey(key: string) {
    const sessionId = props.sessionId
    if (!sessionId) return
    setKeyNotice(`Sending ${key}…`)
    try { (term as any)?.focus?.() } catch {}
    try {
      await sendSessionKeys(sessionId, [key])
      if (props.sessionId === sessionId) setKeyNotice(`Sent ${key}`)
    } catch {
      if (props.sessionId === sessionId) setKeyNotice(`${key} failed — tap again`)
    }
    if (keyNoticeTimer !== undefined) window.clearTimeout(keyNoticeTimer)
    keyNoticeTimer = window.setTimeout(() => {
      setKeyNotice('')
      keyNoticeTimer = undefined
    }, 1800)
  }

  function sendKeyFromPointer(event: PointerEvent, key: string) {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return
    event.preventDefault()
    lastTouchKeyAt = performance.now()
    void sendToolbarKey(key)
  }

  function sendKeyFromClick(_event: MouseEvent, key: string) {
    // iOS may suppress its synthetic click after terminal focus changes. Send
    // on the native touch pointer path, and ignore the compatibility click if
    // the browser still emits one. Mouse and keyboard clicks continue here.
    if (performance.now() - lastTouchKeyAt < 750) return
    void sendToolbarKey(key)
  }

  const KEYS: [string, string, string][] = [
    ['Escape', 'ESC', 'Escape'],
    ['Left', '←', 'Left arrow'],
    ['Down', '↓', 'Down arrow'],
    ['Up', '↑', 'Up arrow'],
    ['Right', '→', 'Right arrow'],
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
    'touch-action': 'manipulation',
  }

  return (
    <div style={{ height: '100%', width: '100%', display: 'flex', 'flex-direction': 'column', background: '#0a0e14' }}>
      {/* Terminal toolbar */}
      <div style={{ display: 'flex', gap: '6px', padding: '6px 8px', 'border-bottom': '1px solid #1e1e1e', 'flex-shrink': '0', 'overflow-x': 'auto' }}>
        <button
          onMouseDown={(e) => e.preventDefault()}
          onPointerUp={(e) => sendKeyFromPointer(e, 'Enter')}
          onClick={(e) => sendKeyFromClick(e, 'Enter')}
          aria-label="Enter"
          title="Enter"
          style={{ ...keyStyle, 'font-size': '12px', 'min-width': '66px' }}
        >Enter ↵</button>
        <button onClick={toggleLinks} aria-controls="terminal-links" aria-expanded={showLinks()} style={{ ...btnStyle, color: showLinks() ? '#4aba6a' : '#73b8ff' }}>
          {terminalCodes().length > 0 ? 'Login' : terminalLinks().length > 0 ? `Links (${terminalLinks().length})` : 'Links'}
        </button>
        <button onClick={handleSelectAll} style={btnStyle}>Select All</button>
        <button onClick={handleCopy} style={{ ...btnStyle, color: copied() ? '#4aba6a' : '#aaa' }}>
          {copied() ? 'Copied!' : hasSelection() ? 'Copy Selection' : 'Copy All'}
        </button>
        <button onClick={handlePaste} style={btnStyle}>Paste</button>
        {KEYS.map(([key, label, aria]) => (
          <button
            onMouseDown={(e) => e.preventDefault()}
            onPointerUp={(e) => sendKeyFromPointer(e, key)}
            onClick={(e) => sendKeyFromClick(e, key)}
            aria-label={aria}
            title={aria}
            style={keyStyle}
          >{label}</button>
        ))}
        <Show when={keyNotice()}>
          <span role="status" style={{ color: keyNotice().includes('failed') ? '#e06c75' : '#4aba6a', 'font-size': '11px', 'white-space': 'nowrap', 'align-self': 'center', 'flex-shrink': '0' }}>{keyNotice()}</span>
        </Show>
      </div>
      <Show when={showLinks()}>
        <div id="terminal-links" data-testid="terminal-links" aria-live="polite" style={{ padding: '8px', background: '#0d1117', 'border-bottom': '1px solid #1e1e1e', display: 'flex', 'flex-direction': 'column', gap: '6px', 'max-height': '35%', overflow: 'auto', 'flex-shrink': '0' }}>
          <Show when={terminalLinks().length > 0 || terminalCodes().length > 0} fallback={(
            <div style={{ color: '#888', 'font-size': '12px', padding: '3px 2px' }}>No complete links found yet. Keep this open and new terminal links will appear here.</div>
          )}>
            <For each={terminalCodes()}>{code => (
              <div style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'min-width': '0' }}>
                <span style={{ color: '#aaa', 'font-size': '12px' }}>Login code</span>
                <code style={{ color: '#e5e5e5', 'font-size': '15px', 'font-weight': '700', 'letter-spacing': '0.08em' }}>{code}</code>
                <button aria-label={`Copy login code ${code}`} onClick={() => copyCode(code)} style={{ ...btnStyle, padding: '4px 9px', color: copiedCode() === code ? '#4aba6a' : '#aaa', 'flex-shrink': '0' }}>{copiedCode() === code ? 'Copied!' : 'Copy code'}</button>
              </div>
            )}</For>
            <For each={terminalLinks()}>{link => (
              <div style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'min-width': '0' }}>
                <a href={link} target="_blank" rel="noopener noreferrer" title={link} style={{ flex: '1', 'min-width': '0', color: '#73b8ff', 'font-size': '12px', 'font-family': "'SF Mono', Menlo, monospace", overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{link === 'https://auth.openai.com/codex/device' ? 'Open ChatGPT device login' : link}</a>
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
