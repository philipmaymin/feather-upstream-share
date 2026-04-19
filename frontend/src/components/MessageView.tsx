import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from 'solid-js'
import type { Message, ContentBlock } from '../api'
import { toBlob } from 'html-to-image'
import { Marked } from 'marked'
import { markedHighlight } from 'marked-highlight'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import css from 'highlight.js/lib/languages/css'
import xml from 'highlight.js/lib/languages/xml'
import rust from 'highlight.js/lib/languages/rust'
import go from 'highlight.js/lib/languages/go'
import diff from 'highlight.js/lib/languages/diff'
import sql from 'highlight.js/lib/languages/sql'
import yaml from 'highlight.js/lib/languages/yaml'
import markdown from 'highlight.js/lib/languages/markdown'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sh', bash)
hljs.registerLanguage('shell', bash)
hljs.registerLanguage('json', json)
hljs.registerLanguage('css', css)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('go', go)
hljs.registerLanguage('diff', diff)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('yml', yaml)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('md', markdown)

// ── Markdown renderer with LRU cache ────────────────────────────────────────

const marked = new Marked(
  { gfm: true, breaks: true },
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value
      return code
    },
  }),
)
const mdCache = new Map<string, string>()
const MD_CACHE_MAX = 2000

function renderMarkdown(text: string): string {
  const cached = mdCache.get(text)
  if (cached !== undefined) return cached
  const html = marked.parse(text.trimEnd()) as string
  const safe = DOMPurify.sanitize(html, { ADD_ATTR: ['class', 'target', 'rel'] })
    .replace(/<table>/g, '<div class="table-wrap"><table>')
    .replace(/<\/table>/g, '</table></div>')
  if (mdCache.size >= MD_CACHE_MAX) {
    const first = mdCache.keys().next().value!
    mdCache.delete(first)
  }
  mdCache.set(text, safe)
  return safe
}

// ── Message export helpers ──────────────────────────────────────────────

function getMsgEl(uuid: string, container: HTMLElement): HTMLElement | null {
  return container.querySelector(`[data-uuid="${uuid}"]`)
}

async function copyText(uuid: string, container: HTMLElement): Promise<boolean> {
  const el = getMsgEl(uuid, container)
  if (!el) return false
  await navigator.clipboard.writeText(el.textContent || '')
  return true
}

async function copyHtml(uuid: string, container: HTMLElement): Promise<boolean> {
  const el = getMsgEl(uuid, container)
  if (!el) return false
  const html = `<div style="background:#1a1a2e;color:#e5e5e5;font-family:-apple-system,system-ui,sans-serif;padding:12px;border-radius:8px">${el.innerHTML}</div>`
  const htmlBlob = new Blob([html], { type: 'text/html' })
  const textBlob = new Blob([el.textContent || ''], { type: 'text/plain' })
  await navigator.clipboard.write([new ClipboardItem({ 'text/html': htmlBlob, 'text/plain': textBlob })])
  return true
}

async function copyPng(uuid: string, container: HTMLElement): Promise<boolean> {
  const el = getMsgEl(uuid, container)
  if (!el) return false
  const blob = await toBlob(el, { backgroundColor: '#0a0e14', pixelRatio: 2 })
  if (!blob) return false
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
  return true
}

async function shareMsg(uuid: string, container: HTMLElement): Promise<boolean> {
  const el = getMsgEl(uuid, container)
  if (!el) return false
  const blob = await toBlob(el, { backgroundColor: '#0a0e14', pixelRatio: 2 })
  if (!blob) return false
  const file = new File([blob], 'message.png', { type: 'image/png' })
  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file] })
    return true
  }
  return false
}

function printMsg(uuid: string, container: HTMLElement, css: string) {
  const el = getMsgEl(uuid, container)
  if (!el) return
  const w = window.open('', '_blank')
  if (!w) return
  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>body{background:#0a0e14;color:#e5e5e5;font-family:-apple-system,system-ui,sans-serif;padding:20px;margin:0;font-size:14px;line-height:1.5;}${css}</style></head><body>${el.innerHTML}</body></html>`)
  w.document.close()
  setTimeout(() => w.print(), 300)
}

// Auto-collapse long code blocks (>25 lines)
function collapseCodeBlocks(el: HTMLElement) {
  for (const pre of el.querySelectorAll('pre')) {
    if (pre.querySelector('.code-expand-btn') || pre.closest('.code-collapse-wrapper')) continue
    const code = pre.querySelector('code')
    if (!code) continue
    const lineCount = (code.textContent || '').split('\n').length
    if (lineCount < 25) continue
    const hiddenLines = lineCount - 15
    pre.classList.add('code-collapsed')
    const wrapper = document.createElement('div')
    wrapper.className = 'code-collapse-wrapper'
    pre.parentNode!.insertBefore(wrapper, pre)
    wrapper.appendChild(pre)
    const btn = document.createElement('button')
    btn.className = 'code-expand-btn'
    btn.textContent = `Show ${hiddenLines} more lines`
    btn.onclick = (e) => {
      e.stopPropagation()
      const collapsed = pre.classList.toggle('code-collapsed')
      btn.textContent = collapsed ? `Show ${hiddenLines} more lines` : 'Collapse'
    }
    wrapper.appendChild(btn)
  }
}

// Make all links open in new tab + linkify file paths
const FILE_PATH_RE = /((?:\/(?:home|opt|tmp|var|etc|usr)\/[^\s,;:)"'`\]>]+)|(?:~\/[^\s,;:)"'`\]>]+))/g
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'])

function fixLinks(el: HTMLElement, onImageClick?: (src: string) => void) {
  for (const a of el.querySelectorAll('a')) {
    a.setAttribute('target', '_blank')
    a.setAttribute('rel', 'noopener')
  }
  // Linkify file paths in text nodes
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  for (const node of nodes) {
    if (node.parentElement?.tagName === 'A') continue
    // Skip code blocks (<pre><code>) but allow inline <code> to be linkified
    if (node.parentElement?.tagName === 'CODE' && node.parentElement?.parentElement?.tagName === 'PRE') continue
    const text = node.textContent || ''
    if (!text.match(FILE_PATH_RE)) continue
    const frag = document.createDocumentFragment()
    let last = 0
    for (const match of text.matchAll(FILE_PATH_RE)) {
      const idx = match.index!
      if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)))
      const path = match[0]
      const a = document.createElement('a')
      a.textContent = path
      a.style.color = '#73b8ff'
      a.style.textDecoration = 'none'
      a.style.cursor = 'pointer'
      const ext = path.substring(path.lastIndexOf('.')).toLowerCase()
      const base = location.pathname.replace(/\/+$/, '')
      const resolvedPath = path.replace(/^~/, '/home/' + (document.querySelector<HTMLElement>('[data-username]')?.dataset.username || 'user'))
      if (IMAGE_EXTS.has(ext)) {
        const imgSrc = `${base}/api/files/raw?path=${encodeURIComponent(resolvedPath)}`
        a.href = imgSrc
        a.onclick = (e) => { e.preventDefault(); onImageClick?.(imgSrc) }
        frag.appendChild(a)
        // Auto-preview: insert inline image below the link
        const img = document.createElement('img')
        img.src = imgSrc
        img.style.maxWidth = '100%'
        img.style.maxHeight = '300px'
        img.style.borderRadius = '8px'
        img.style.marginTop = '4px'
        img.style.display = 'block'
        img.style.cursor = 'zoom-in'
        img.onclick = () => onImageClick?.(imgSrc)
        frag.appendChild(img)
      } else {
        a.href = `${base}/api/files/raw?path=${encodeURIComponent(resolvedPath)}`
        a.target = '_blank'
        a.rel = 'noopener'
        frag.appendChild(a)
      }
      last = idx + path.length
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)))
    node.parentNode?.replaceChild(frag, node)
  }
}

// ── Utilities ───────────────────────────────────────────────────────────────

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
}

// ── Tool rendering ──────────────────────────────────────────────────────────

const TOOL_ICONS: Record<string, string> = {
  Read: '📄', Write: '✏️', Edit: '✂️', Bash: '⚡', Grep: '🔍', Glob: '🗂️',
  WebFetch: '🌐', WebSearch: '🔎', Agent: '🤖', Skill: '⚡',
}

const TOOL_COLORS: Record<string, string> = {
  Bash: '#e5946b', Read: '#73b8ff', Write: '#4aba6a', Edit: '#c4993a',
  Grep: '#b48ead', Glob: '#88c0d0', WebFetch: '#88c0d0', WebSearch: '#b48ead',
  Agent: '#73b8ff', Skill: '#b48ead',
}

function toolSummary(name: string, input: any): string {
  if (!input) return ''
  const fp = input.file_path as string || ''
  const short = fp.split('/').slice(-2).join('/')
  switch (name) {
    case 'Read': return short + (input.offset ? ` L${input.offset}` : '')
    case 'Write': return short
    case 'Edit': return short + (input.replace_all ? ' ×all' : '')
    case 'Bash': { const c = (input.command || '').split('\n')[0].trim(); return c.length > 80 ? c.slice(0, 80) + '…' : c }
    case 'Grep': return `${input.pattern || ''}${input.path ? ' in ' + input.path : ''}`
    case 'Glob': return input.pattern || ''
    case 'Agent': return input.description || ''
    default: return ''
  }
}

// ── Block renderers ─────────────────────────────────────────────────────────

function renderBlock(block: ContentBlock, onImageClick?: (src: string) => void) {
  if (block.type === 'text' && block.text) {
    return <div class="markdown" innerHTML={renderMarkdown(block.text)} ref={(el) => queueMicrotask(() => { fixLinks(el, onImageClick); collapseCodeBlocks(el) })} />
  }
  if (block.type === 'thinking' && block.thinking) {
    return (
      <details style={{ margin: '4px 0' }}>
        <summary style={{ color: '#c4993a', 'font-size': '12px', cursor: 'pointer' }}>Thinking...</summary>
        <div style={{ color: '#999', 'font-size': '12px', 'white-space': 'pre-wrap', 'max-height': '200px', overflow: 'auto', padding: '8px', background: '#0d1117', 'border-radius': '4px', 'margin-top': '4px' }}>
          {block.thinking}
        </div>
      </details>
    )
  }
  if (block.type === 'tool_use') {
    const name = block.name || 'tool'
    const color = TOOL_COLORS[name] || '#999'
    const summary = toolSummary(name, block.input)
    const inp = block.input || {}
    const hasDetail = name === 'Edit' || name === 'Bash' || name === 'Write' || name === 'Agent' || name === 'Grep' || name === 'Read'
    const pre = 'white-space:pre-wrap;font-size:10px;font-family:SF Mono,Menlo,monospace;padding:3px 0;max-height:160px;overflow:auto;margin:0;word-break:break-all;'
    const isImageFile = (name === 'Read' || name === 'Write') && inp.file_path && IMAGE_EXTS.has(((inp.file_path as string).substring((inp.file_path as string).lastIndexOf('.')).toLowerCase()))
    return <>
      <details style={{ margin: '3px 0', 'font-size': '11px', 'font-family': "'SF Mono', Menlo, monospace", 'border-top': '1px solid #ffffff0a' }}>
        <summary style={{ padding: '2px 0', cursor: hasDetail ? 'pointer' : 'default', 'list-style': hasDetail ? undefined : 'none', color: '#999' }}>
          <span style={{ color }}>{name}</span>
          {summary && <span style={{ color: '#888', 'margin-left': '6px' }}>{summary}</span>}
        </summary>
        {name === 'Edit' && <>
          {inp.old_string && <pre style={`${pre}color:#e07070`}>{inp.old_string}</pre>}
          {inp.new_string && <pre style={`${pre}color:#5cc878`}>{inp.new_string}</pre>}
        </>}
        {name === 'Bash' && inp.command && <pre style={`${pre}color:#e5a070`}>{inp.command}</pre>}
        {name === 'Write' && inp.content && <pre style={`${pre}color:#5cc878`}>{(inp.content as string).slice(0, 500)}{(inp.content as string).length > 500 ? '...' : ''}</pre>}
        {name === 'Agent' && <>
          {inp.subagent_type && <div style={{ padding: '2px 0', 'font-size': '10px', color: '#888' }}>Type: <span style={{ color: '#c4993a' }}>{inp.subagent_type}</span></div>}
          {inp.prompt && <pre style={`${pre}color:#88c4ff`}>{(inp.prompt as string).slice(0, 800)}{(inp.prompt as string).length > 800 ? '...' : ''}</pre>}
        </>}
        {name === 'Grep' && inp.pattern && <pre style={`${pre}color:#c4a0c0`}>/{inp.pattern}/{inp.path ? ` in ${inp.path}` : ''}</pre>}
        {name === 'Read' && inp.file_path && <pre style={`${pre}color:#88c4ff`}>{inp.file_path}{inp.offset ? ` (L${inp.offset})` : ''}</pre>}
      </details>
      {isImageFile && (() => {
        const base = typeof location !== 'undefined' ? location.pathname.replace(/\/+$/, '') : ''
        const resolvedPath = (inp.file_path as string).replace(/^~/, '/home/' + (typeof document !== 'undefined' ? document.querySelector<HTMLElement>('[data-username]')?.dataset.username || 'user' : 'user'))
        const imgSrc = `${base}/api/files/raw?path=${encodeURIComponent(resolvedPath)}`
        return <img src={imgSrc} onClick={() => onImageClick?.(imgSrc)} style={{ 'max-width': '100%', 'max-height': '300px', 'border-radius': '8px', 'margin-top': '6px', display: 'block', cursor: 'zoom-in' }} />
      })()}
    </>
  }
  if (block.type === 'tool_result') {
    const rawContent = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.map((c: any) => c.text || '').join('') : ''
    const raw = stripAnsi(rawContent)
    const isErr = block.is_error
    const isLong = raw.length > 200
    const preview = raw.slice(0, 200)
    const lineCount = raw.split('\n').length
    const label = isErr ? 'error' : `output${isLong ? ` (${lineCount} lines)` : ''}`
    return (
      <details style={{ margin: '2px 0', overflow: 'hidden' }} open={isErr || !isLong}>
        <summary style={{ padding: '1px 0', 'font-size': '9px', 'font-weight': '500', 'text-transform': 'uppercase', 'letter-spacing': '0.05em', color: isErr ? '#e07070' : '#777', cursor: isLong ? 'pointer' : 'default', 'list-style': isLong ? undefined : 'none' }}>
          {label}
          {isLong && !isErr && <span style={{ 'font-weight': '400', 'text-transform': 'none', 'margin-left': '6px', color: '#666' }}>{preview.split('\n')[0].slice(0, 60)}</span>}
        </summary>
        {raw && <div style={{ padding: '2px 0', 'font-size': '10px', 'font-family': "'SF Mono', Menlo, monospace", color: isErr ? '#e07070' : '#999', 'white-space': 'pre-wrap', 'max-height': '200px', overflow: 'auto', 'word-break': 'break-all' }}>{raw.length > 3000 ? raw.slice(0, 3000) + '\n... (truncated)' : raw}</div>}
      </details>
    )
  }
  return null
}

function formatTime(iso: string) {
  try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
  catch { return '' }
}

function formatFullDate(iso: string) {
  try {
    const d = new Date(iso)
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch { return '' }
}


// ── Markdown styles ─────────────────────────────────────────────────────────

const markdownCSS = `
.markdown { line-height: 1.55; word-break: break-word; }
.markdown p { margin: 0 0 8px 0; }
.markdown p:last-child { margin-bottom: 0; }
.markdown h1, .markdown h2, .markdown h3, .markdown h4 { margin: 12px 0 6px 0; font-weight: 600; }
.markdown h1 { font-size: 1.3em; }
.markdown h2 { font-size: 1.15em; }
.markdown h3 { font-size: 1.05em; }
.markdown ul, .markdown ol { margin: 4px 0; padding-left: 20px; }
.markdown li { margin: 2px 0; }
.markdown code {
  background: rgba(255,255,255,0.08); padding: 1px 5px; border-radius: 3px;
  font-family: 'SF Mono', Menlo, 'Courier New', monospace; font-size: 0.88em;
}
.markdown pre { margin: 8px 0; border-radius: 6px; overflow-x: auto; background: #0d1117; padding: 10px 12px; position: relative; }
.markdown pre code { background: none; padding: 0; font-size: 0.85em; color: #c9d1d9; }
.markdown pre.code-collapsed { max-height: 360px; overflow: hidden; }
.markdown pre.code-collapsed::after { content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 60px; background: linear-gradient(transparent, #0d1117); pointer-events: none; border-radius: 0 0 6px 6px; }
.code-expand-btn { display: block; width: 100%; padding: 4px 0; margin-top: -1px; background: #0d1117; border: 1px solid #333; border-top: none; border-radius: 0 0 6px 6px; color: #fab283; font-size: 0.75em; font-family: -apple-system, system-ui, sans-serif; cursor: pointer; text-align: center; transition: background-color 0.2s, color 0.2s; }
.code-expand-btn:hover { background: #161b22; color: #fcd9b8; }
.markdown blockquote {
  margin: 6px 0; padding: 4px 12px; border-left: 3px solid #444; color: #999;
}
.markdown .table-wrap { overflow-x: auto; margin: 8px 0; -webkit-overflow-scrolling: touch; }
.markdown table { border-collapse: collapse; font-size: 0.9em; white-space: nowrap; }
.markdown th, .markdown td { border: 1px solid #333; padding: 5px 10px; text-align: left; }
.markdown th { background: rgba(255,255,255,0.05); font-weight: 600; }
.markdown a { color: #73b8ff; text-decoration: none; }
.markdown a:hover { text-decoration: underline; }
.markdown img { max-width: 100%; border-radius: 6px; }
.markdown hr { border: none; border-top: 1px solid #333; margin: 12px 0; }
.markdown strong { font-weight: 600; }

/* Message action buttons - show on hover */
.star-btn, .action-menu-btn { -webkit-tap-highlight-color: transparent; }
div:hover > div > .star-btn, div:hover > div > .action-menu-btn { opacity: 0.6 !important; }
.star-btn:hover, .action-menu-btn:hover { opacity: 1 !important; }

/* Typing indicator bounce */
@keyframes typing-bounce {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
  30% { transform: translateY(-4px); opacity: 1; }
}

/* highlight.js dark theme */
.hljs { color: #c9d1d9; }
.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-section, .hljs-link { color: #ff7b72; }
.hljs-function .hljs-keyword { color: #ff7b72; }
.hljs-string, .hljs-attr { color: #a5d6ff; }
.hljs-number, .hljs-meta { color: #79c0ff; }
.hljs-comment, .hljs-quote { color: #8b949e; font-style: italic; }
.hljs-title, .hljs-title.function_ { color: #d2a8ff; }
.hljs-built_in { color: #ffa657; }
.hljs-type, .hljs-class .hljs-title { color: #ffa657; }
.hljs-variable, .hljs-template-variable { color: #ffa657; }
.hljs-name { color: #7ee787; }
.hljs-selector-class { color: #7ee787; }
.hljs-addition { color: #aff5b4; background: rgba(46,160,67,0.15); }
.hljs-deletion { color: #ffdcd7; background: rgba(248,81,73,0.15); }
.hljs-regexp, .hljs-symbol { color: #f0883e; }
.hljs-params { color: #c9d1d9; }
.hljs-property { color: #79c0ff; }
`

// ── Image extraction ─────────────────────────────────────────────────────────

const imgPattern = /\[Attached image: (\/[^\]]+)\]/g

const filePattern = /\[Attached file: (\/[^\]]+)\]\s*\(([^)]+)\)/g

function extractImages(text: string): { cleanText: string; images: string[]; files: { path: string; name: string }[] } {
  const images: string[] = []
  const files: { path: string; name: string }[] = []
  let cleaned = text.replace(imgPattern, (_, p) => { images.push(p); return '' })
  cleaned = cleaned.replace(filePattern, (_, p, name) => { files.push({ path: p, name }); return '' }).trim()
  return { cleanText: cleaned, images, files }
}

// ── Component ───────────────────────────────────────────────────────────────

export function MessageView(props: { messages: Message[], loading: boolean, hasMore?: boolean, loadingMore?: boolean, onLoadEarlier?: () => void, onAnswer?: (text: string) => void, starred?: Set<string>, onToggleStar?: (uuid: string) => void, working?: boolean, scrollRefCb?: (el: HTMLDivElement) => void, sessionId?: string | null }) {
  const [lightbox, setLightbox] = createSignal<string | null>(null)
  let scrollRef: HTMLDivElement | undefined
  const [pinned, setPinned] = createSignal(true)
  const [newMsgCount, setNewMsgCount] = createSignal(0)
  const [actionMenu, setActionMenu] = createSignal<string | null>(null)
  const [actionFeedback, setActionFeedback] = createSignal<string | null>(null)
  const [expandedRuns, setExpandedRuns] = createSignal<Set<string>>(new Set())
  let prevMsgLen = props.messages.length

  // ResizeObserver fires after layout and before paint, so we can set
  // scrollTop synchronously inside it — the adjusted position lands in the
  // same frame as the size change, eliminating the one-frame flicker where
  // new content paints at the old scroll position first.
  let selfScrollUntil = 0
  let smoothScrollUntil = 0
  function pinSync() {
    if (!scrollRef) return
    if (performance.now() < smoothScrollUntil) return
    const target = scrollRef.scrollHeight - scrollRef.clientHeight
    if (Math.abs(scrollRef.scrollTop - target) < 2) return
    selfScrollUntil = performance.now() + 120
    scrollRef.scrollTop = target
  }

  function onScroll() {
    if (!scrollRef) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef
    const near = scrollHeight - scrollTop - clientHeight < 80
    // Ignore scroll events caused by our own pin writes — they don't mean
    // the user took over the viewport.
    if (performance.now() < selfScrollUntil) {
      if (near) setNewMsgCount(0)
      return
    }
    setPinned(near)
    if (near) setNewMsgCount(0)
  }

  function scrollToBottom() {
    if (!scrollRef) return
    const target = scrollRef.scrollHeight - scrollRef.clientHeight
    smoothScrollUntil = performance.now() + 600
    scrollRef.scrollTo({ top: target, behavior: 'smooth' })
    setNewMsgCount(0)
  }

  async function doAction(action: string, uuid: string) {
    if (!scrollRef) return
    setActionMenu(null)
    try {
      let ok = false
      if (action === 'text') ok = await copyText(uuid, scrollRef)
      else if (action === 'html') ok = await copyHtml(uuid, scrollRef)
      else if (action === 'png') ok = await copyPng(uuid, scrollRef)
      else if (action === 'share') ok = await shareMsg(uuid, scrollRef)
      else if (action === 'pdf') { printMsg(uuid, scrollRef, markdownCSS); return }
      if (ok) {
        setActionFeedback(uuid)
        setTimeout(() => setActionFeedback(null), 1200)
      }
    } catch {}
  }

  // Length effect only updates the new-msg badge when unpinned. Pin writes
  // happen through ResizeObserver (pinSync) so they stay in the same frame
  // as the layout change — no flicker.
  createEffect(on(() => props.messages.length, (len) => {
    const delta = len - prevMsgLen
    prevMsgLen = len
    if (!untrack(pinned) && delta > 0) {
      setNewMsgCount(c => c + delta)
    }
  }))

  // Reset delta counter on session switch so a new session's load doesn't
  // get interpreted as a huge burst of "new messages since last time".
  createEffect(on(() => props.sessionId, () => {
    prevMsgLen = props.messages.length
    setNewMsgCount(0)
    setPinned(true)
  }, { defer: true }))

  // ResizeObserver is the single pin writer — it catches every size change
  // (collapse/expand, image load, typing indicator growth, new message) and
  // runs after layout, before paint, in the same frame as the size change.
  // Setting scrollTop directly here lands before the next paint.
  let contentRef: HTMLDivElement | undefined
  onMount(() => {
    if (!contentRef) return
    const ro = new ResizeObserver(() => {
      if (untrack(pinned) && scrollRef) pinSync()
    })
    ro.observe(contentRef)
    onCleanup(() => ro.disconnect())
  })

  const canShare = typeof navigator !== 'undefined' && !!navigator.share

  const menuBtnStyle = { display: 'block', width: '100%', padding: '8px 14px', background: 'none', border: 'none', 'border-bottom': '1px solid #222', color: '#e5e5e5', 'font-size': '12px', 'text-align': 'left' as const, cursor: 'pointer', 'white-space': 'nowrap' as const }

  // Auto-collapse consecutive internal-only messages (tool_use / tool_result /
  // thinking with no visible text) into a single expandable group so that a
  // long agent run doesn't drown out the user/assistant signal.
  const RUN_COLLAPSE_THRESHOLD = 3
  const hasVisibleText = (msg: Message) =>
    !msg.internal &&
    (msg.content || []).some(b => b.type === 'text' && (b.text || '').trim().length > 0)

  type GroupedItem = { kind: 'msg'; msg: Message } | { kind: 'run'; msgs: Message[] }
  const groupedItems = createMemo<GroupedItem[]>(() => {
    const result: GroupedItem[] = []
    let run: Message[] = []
    const flush = () => { if (run.length) { result.push({ kind: 'run', msgs: run }); run = [] } }
    for (const msg of props.messages) {
      if (hasVisibleText(msg)) { flush(); result.push({ kind: 'msg', msg }) }
      else run.push(msg)
    }
    flush()
    return result
  })

  const renderMsg = (msg: Message) => {
    const textBlock = msg.content?.find(b => b.type === 'text' && b.text)
    const { cleanText, images, files } = textBlock?.text ? extractImages(textBlock.text) : { cleanText: textBlock?.text || '', images: [], files: [] }
    const hasImages = images.length > 0
    const hasFiles = files.length > 0
    const hasAttachments = hasImages || hasFiles

    return <div style={{ display: 'flex', 'flex-direction': 'column', 'align-items': msg.role === 'user' ? 'flex-end' : 'flex-start', 'margin-bottom': '10px' }}>
      <div data-uuid={msg.uuid} data-role={msg.role} style={{
        'max-width': '85%', padding: hasAttachments ? '6px' : '10px 14px',
        'border-radius': msg.role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
        background: msg.role === 'user' ? 'rgba(74,186,106,0.15)' : '#1a1a2e',
        color: '#e5e5e5', overflow: 'hidden',
        'font-size': '14px', 'line-height': '1.5', 'word-break': 'break-word',
      }}>
        <For each={images}>{(src) => (
          <img src={src} onClick={() => setLightbox(src)} style={{ 'max-width': '100%', 'max-height': '300px', 'border-radius': hasAttachments ? '12px' : '6px', 'margin-bottom': '4px', cursor: 'zoom-in', display: 'block' }} />
        )}</For>
        <For each={files}>{(f) => (
          <a href={f.path} target="_blank" rel="noopener" style={{ display: 'flex', 'align-items': 'center', gap: '6px', padding: '6px 10px', margin: '2px 0', background: 'rgba(255,255,255,0.05)', 'border-radius': '8px', 'text-decoration': 'none', color: '#73b8ff', 'font-size': '12px' }}>
            <span style={{ 'font-size': '16px' }}>{f.name.endsWith('.pdf') ? '\uD83D\uDCC4' : '\uD83D\uDCCE'}</span>
            <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{f.name}</span>
          </a>
        )}</For>
        <div style={hasAttachments ? { padding: '4px 8px 4px' } : {}}>
          <For each={msg.content}>{(block) => {
            if (block.type === 'text' && block.text) {
              const display = hasAttachments ? cleanText : block.text
              return display ? <div class="markdown" innerHTML={renderMarkdown(display)} ref={(el) => queueMicrotask(() => { fixLinks(el, (src) => setLightbox(src)); collapseCodeBlocks(el) })} /> : null
            }
            return renderBlock(block, (src) => setLightbox(src))
          }}</For>
        </div>
      </div>
      <div style={{ display: 'flex', 'align-items': 'center', gap: '4px', 'margin-top': '4px', padding: '0 4px', 'justify-content': msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
        <span onClick={(e) => { const el = e.currentTarget; el.textContent = el.textContent === formatTime(msg.timestamp) ? formatFullDate(msg.timestamp) : formatTime(msg.timestamp) }}
          style={{ 'font-size': '10px', color: '#444', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>{formatTime(msg.timestamp)}</span>
        {msg.role === 'user' && msg.delivery && (
          <span style={{ 'font-size': '11px', color: msg.delivery === 'delivered' ? '#4aba6a' : '#555' }}>
            {msg.delivery === 'delivered' ? '\u2713\u2713' : '\u2713'}
          </span>
        )}
        {!msg.uuid.startsWith('optimistic-') && (
          <button onClick={() => props.onToggleStar?.(msg.uuid)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', 'font-size': '12px', padding: '0 2px', color: props.starred?.has(msg.uuid) ? '#c4993a' : '#333', opacity: props.starred?.has(msg.uuid) ? '1' : '0', transition: 'opacity 0.15s' }}
            class="star-btn">{props.starred?.has(msg.uuid) ? '\u2605' : '\u2606'}</button>
        )}
        {!msg.uuid.startsWith('optimistic-') && (
          <div style={{ position: 'relative', display: 'flex', 'align-items': 'center' }}>
            <button onClick={() => setActionMenu(actionMenu() === msg.uuid ? null : msg.uuid)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', 'font-size': '10px', padding: '0 3px', color: actionFeedback() === msg.uuid ? '#4aba6a' : '#444', opacity: actionMenu() === msg.uuid ? '1' : undefined, transition: 'color 0.2s' }}
              class="action-menu-btn">{actionFeedback() === msg.uuid ? '\u2713' : 'Copy'}</button>
            <Show when={actionMenu() === msg.uuid}>
              <div style={{ position: 'absolute', bottom: '100%', [msg.role === 'user' ? 'right' : 'left']: '0', 'margin-bottom': '4px', background: '#1a1a2e', border: '1px solid #333', 'border-radius': '8px', 'box-shadow': '0 4px 12px rgba(0,0,0,0.5)', 'z-index': '100', overflow: 'hidden', 'min-width': '120px' }}>
                <button onClick={() => doAction('text', msg.uuid)} style={menuBtnStyle}>Copy text</button>
                <button onClick={() => doAction('html', msg.uuid)} style={menuBtnStyle}>Copy HTML</button>
                <button onClick={() => doAction('png', msg.uuid)} style={menuBtnStyle}>Copy image</button>
                <button onClick={() => doAction('pdf', msg.uuid)} style={{ ...menuBtnStyle, 'border-bottom': canShare ? '1px solid #222' : 'none' }}>Save PDF</button>
                <Show when={canShare}>
                  <button onClick={() => doAction('share', msg.uuid)} style={{ ...menuBtnStyle, 'border-bottom': 'none' }}>Share...</button>
                </Show>
              </div>
            </Show>
          </div>
        )}
      </div>
    </div>
  }

  return (
    <div style={{ position: 'relative', height: '100%' }}>
    <div ref={(el) => { scrollRef = el; props.scrollRefCb?.(el) }} onScroll={onScroll} style={{ height: '100%', 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch', 'overscroll-behavior': 'contain', padding: '16px', 'padding-bottom': '80px' }}>
      <style>{markdownCSS}</style>
      <div ref={contentRef}>
      <Show when={props.loading}>
        <div style={{ color: '#555', 'text-align': 'center', padding: '40px' }}>Loading...</div>
      </Show>
      <Show when={props.hasMore && !props.loading}>
        <div style={{ 'text-align': 'center', padding: '12px' }}>
          <button onClick={() => props.onLoadEarlier?.()} disabled={props.loadingMore}
            style={{ background: '#1a1a2e', border: '1px solid #333', color: '#73b8ff', padding: '6px 16px', 'border-radius': '6px', 'font-size': '12px', cursor: props.loadingMore ? 'wait' : 'pointer' }}>
            {props.loadingMore ? 'Loading...' : 'Load earlier messages'}
          </button>
        </div>
      </Show>
      {/* Lightbox */}
      <Show when={lightbox()}>
        <div onClick={() => setLightbox(null)} style={{ position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.85)', 'z-index': '200', display: 'flex', 'align-items': 'center', 'justify-content': 'center', cursor: 'zoom-out' }}>
          <img src={lightbox()!} style={{ 'max-width': '95vw', 'max-height': '95vh', 'object-fit': 'contain', 'border-radius': '8px' }} />
        </div>
      </Show>
      {/* Action menu backdrop */}
      <Show when={actionMenu()}>
        <div onClick={() => setActionMenu(null)} style={{ position: 'fixed', inset: '0', 'z-index': '90' }} />
      </Show>

      <For each={groupedItems()}>{(item) => {
        if (item.kind === 'msg') return renderMsg(item.msg)
        if (item.msgs.length < RUN_COLLAPSE_THRESHOLD) {
          return <For each={item.msgs}>{(msg) => renderMsg(msg)}</For>
        }
        const key = item.msgs[0].uuid
        const expanded = () => expandedRuns().has(key)
        const toggle = () => setExpandedRuns(prev => {
          const next = new Set(prev)
          if (next.has(key)) next.delete(key); else next.add(key)
          return next
        })
        return (
          <div style={{ margin: '6px 0' }}>
            <div onClick={toggle} style={{ 'text-align': 'center', cursor: 'pointer', padding: '4px 0', '-webkit-tap-highlight-color': 'transparent' }}>
              <span style={{ display: 'inline-block', padding: '3px 10px', background: '#14141c', border: '1px solid #2a2a3a', color: '#888', 'font-size': '11px', 'border-radius': '12px' }}>
                {expanded() ? '\u25BE' : '\u25B8'} {item.msgs.length} tool steps
              </span>
            </div>
            <Show when={expanded()}>
              <div style={{ 'border-left': '2px solid #2a2a3a', 'margin-left': '12px', 'padding-left': '10px', 'margin-top': '4px' }}>
                <For each={item.msgs}>{(msg) => renderMsg(msg)}</For>
              </div>
            </Show>
          </div>
        )
      }}</For>

      {/* Typing indicator — always mounted, opacity-toggled so mount/unmount
          doesn't shift layout and trigger a pin-scroll every time working flips. */}
      <div style={{ display: 'flex', 'align-items': 'flex-start', 'margin-bottom': '10px', opacity: props.working ? '1' : '0', transition: 'opacity 0.12s', 'pointer-events': props.working ? 'auto' : 'none' }}>
        <div style={{ padding: '10px 16px', 'border-radius': '16px 16px 16px 4px', background: '#1a1a2e', display: 'flex', gap: '4px', 'align-items': 'center' }}>
          <span class="typing-dot" style={{ width: '6px', height: '6px', 'border-radius': '50%', background: '#888', 'animation': 'typing-bounce 1.2s ease-in-out infinite' }} />
          <span class="typing-dot" style={{ width: '6px', height: '6px', 'border-radius': '50%', background: '#888', 'animation': 'typing-bounce 1.2s ease-in-out 0.2s infinite' }} />
          <span class="typing-dot" style={{ width: '6px', height: '6px', 'border-radius': '50%', background: '#888', 'animation': 'typing-bounce 1.2s ease-in-out 0.4s infinite' }} />
        </div>
      </div>
      </div>
    </div>
    {/* Scroll to bottom button */}
    <Show when={!pinned()}>
      <button
        onClick={scrollToBottom}
        title="Scroll to bottom"
        style={{
          position: 'absolute', bottom: '12px', right: '16px', 'z-index': '10',
          width: '32px', height: '32px', 'border-radius': '50%',
          background: '#1a1a2e', color: '#e5e5e5',
          border: '1px solid #333', cursor: 'pointer',
          'font-size': '16px', display: 'flex', 'align-items': 'center', 'justify-content': 'center',
          'box-shadow': '0 2px 8px rgba(0,0,0,0.35)', opacity: '0.9',
          '-webkit-tap-highlight-color': 'transparent',
        }}
      >
        <Show when={newMsgCount() > 0}>
          <span style={{
            position: 'absolute', top: '-8px', right: '-8px',
            'min-width': '20px', height: '20px', padding: '0 5px',
            background: '#4aba6a', color: '#000',
            'font-size': '11px', 'font-weight': '600', 'border-radius': '10px',
            display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'line-height': '1',
          }}>{newMsgCount() > 99 ? '99+' : newMsgCount()}</span>
        </Show>
        {'\u2193'}
      </button>
    </Show>
    </div>
  )
}
