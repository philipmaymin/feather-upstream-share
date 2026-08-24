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
import { toolImagePath, toolInputText, toolPresentation } from '../lib/toolPresentation.js'
import { localFilePath } from '../lib/localMedia.js'
import { appUrl } from '../lib/appPath.js'
import { extractImages } from '../lib/attachments.js'

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

function filesystemPathFromHref(a: HTMLAnchorElement): string | null {
  const candidate = localFilePath(a.getAttribute('href'))
  return candidate?.replace(/:\d+(?::\d+)?$/, '') || null
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

function resolveLocalPath(filePath: string): string {
  const username = document.querySelector<HTMLElement>('[data-username]')?.dataset.username || 'user'
  return filePath.replace(/^~/, `/home/${username}`)
}

function localFileHref(filePath: string): string {
  const resolvedPath = resolveLocalPath(filePath)
  const ext = resolvedPath.substring(resolvedPath.lastIndexOf('.')).toLowerCase()
  const route = ext === '.html' || ext === '.htm' ? 'html' : 'raw'
  return appUrl(`/api/files/${route}?path=${encodeURIComponent(resolvedPath)}`)
}

function localImageHref(src: string): string {
  const filePath = localFilePath(src)
  return filePath ? localFileHref(filePath) : src
}

function fixLinks(el: HTMLElement, onImageClick?: (src: string) => void) {
  for (const a of el.querySelectorAll('a')) {
    // Markdown already turns [label](/absolute/path) into an anchor, so the
    // text-node pass below never sees its path. Route those anchors through
    // the same authenticated preview endpoint as the Files tab.
    const localPath = filesystemPathFromHref(a)
    if (localPath) {
      a.href = localFileHref(localPath)
      a.classList.add('feather-path')
      a.dataset.path = localPath
      a.title = /\.html?$/i.test(localPath) ? 'Open HTML preview' : 'Open local file'
    }
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
      const fileHref = localFileHref(path)
      if (IMAGE_EXTS.has(ext)) {
        const imgSrc = fileHref
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
        a.href = fileHref
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

// Markdown image syntax preserves an absolute filesystem path in <img src>.
// Route it through the same authenticated preview as the Files tab, wire it
// into the lightbox, and turn failures into a useful clickable path.
function replaceImageWithPathLink(img: HTMLImageElement, targetPath: string) {
  const a = document.createElement('a')
  a.textContent = targetPath
  a.href = localFileHref(targetPath)
  a.target = '_blank'
  a.rel = 'noopener'
  a.title = 'Open local file'
  a.className = 'feather-path'
  a.dataset.path = targetPath
  img.replaceWith(a)
}

function fixImages(el: HTMLElement, onImageClick?: (src: string) => void) {
  for (const img of el.querySelectorAll('img')) {
    const targetPath = localFilePath(img.getAttribute('src'))
    if (!targetPath) continue
    const url = localFileHref(targetPath)
    img.loading = 'lazy'
    img.classList.add('md-local-img')
    if (!img.alt) img.alt = targetPath.split('/').pop() || 'image'
    if (!img.closest('a')) {
      img.style.cursor = 'zoom-in'
      img.addEventListener('click', () => onImageClick?.(url))
    }
    img.addEventListener('error', () => replaceImageWithPathLink(img, targetPath), { once: true })
    img.src = url
  }
}

function enhanceTables(el: HTMLElement, onExpandTable?: (html: string) => void) {
  for (const table of el.querySelectorAll<HTMLTableElement>('table:not([data-feather-table])')) {
    table.dataset.featherTable = 'true'
    const rows = Array.from(table.rows)
    const columnCount = Math.max(0, ...rows.map((row) => row.cells.length))
    for (let column = 0; column < columnCount; column++) {
      const cells = rows.map((row) => row.cells[column]).filter(Boolean)
      const values = cells.map((cell) => (cell.textContent || '').trim()).filter(Boolean)
      const compact = values.every((value) => value.length <= 18 && !/\s{2,}|\n/.test(value))
      cells.forEach((cell) => cell.classList.add(compact ? 'md-col-compact' : 'md-col-wide'))
    }

    const existingFrame = table.closest<HTMLElement>('.table-wrap')
    const frame = existingFrame || document.createElement('div')
    frame.className = 'md-table-frame'
    if (!existingFrame) {
      table.parentNode?.insertBefore(frame, table)
      frame.appendChild(table)
    }

    const expand = document.createElement('button')
    expand.type = 'button'
    expand.className = 'md-table-expand'
    expand.setAttribute('aria-label', 'Expand table')
    expand.title = 'Expand table'
    expand.textContent = '↗'
    expand.addEventListener('click', (event) => {
      event.stopPropagation()
      onExpandTable?.(DOMPurify.sanitize(table.outerHTML))
    })
    frame.appendChild(expand)
  }
}

function enhanceMarkdown(el: HTMLElement, onImageClick?: (src: string) => void, onExpandTable?: (html: string) => void) {
  fixLinks(el, onImageClick)
  fixImages(el, onImageClick)
  collapseCodeBlocks(el)
  enhanceTables(el, onExpandTable)
}

// ── Utilities ───────────────────────────────────────────────────────────────

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
}

// ── Tool rendering ──────────────────────────────────────────────────────────

const TOOL_ICONS: Record<string, string> = {
  Read: '📄', Write: '✏️', Edit: '✂️', Bash: '⚡', Grep: '🔍', Glob: '🗂️',
  WebFetch: '🌐', WebSearch: '🔎', Web: '🌐', Agent: '🤖', Skill: '⚡',
}

const TOOL_COLORS: Record<string, string> = {
  Bash: '#e5946b', Read: '#73b8ff', Write: '#4aba6a', Edit: '#c4993a',
  Grep: '#b48ead', Glob: '#88c0d0', WebFetch: '#88c0d0', WebSearch: '#b48ead',
  Web: '#88c0d0', Agent: '#73b8ff', Skill: '#b48ead',
  Patch: '#c4993a', Input: '#73b8ff',
}

const SPECIAL_TOOL_DETAILS = new Set(['Edit', 'Bash', 'Patch', 'Input', 'Write', 'Agent', 'Grep', 'Read'])

// Codex emits tool_use blocks with names like 'shell', 'exec', or 'exec_command'
// (the latter may arrive truncated as 'exec_comman'). Map them onto our
// canonical names so the summary/color lookups work uniformly.
const TOOL_ALIASES: Record<string, string> = {
  shell: 'Bash', exec: 'Bash', exec_command: 'Bash', exec_comman: 'Bash',
  local_shell_call: 'Bash',
  apply_patch: 'Patch', write_stdin: 'Input',
  bash: 'Bash', read: 'Read', write: 'Write', edit: 'Edit',
  grep: 'Grep', glob: 'Glob', find: 'Glob',
  task: 'Agent', agent: 'Agent',
  webfetch: 'WebFetch', fetch: 'WebFetch',
  websearch: 'WebSearch', web_search: 'WebSearch',
}

function canonicalName(raw: string): string {
  if (!raw) return 'tool'
  const stripped = raw.replace(/^mcp__.+?__/, '').split('.').pop() || raw
  return TOOL_ALIASES[stripped.toLowerCase()] || stripped.charAt(0).toUpperCase() + stripped.slice(1)
}

// Codex shell inputs use `command` (array or string), `cmd`, or already-joined
// strings — normalize them.
function commandText(input: any): string {
  const v = input?.command ?? input?.cmd
  if (Array.isArray(v)) return v.join(' ').trim()
  return ((v as string) || '').trim()
}

// Codex apply_patch / write_stdin tool helpers.
function patchText(input: any): string {
  return ((input?.raw || input?.input || input?.patch) as string || '').trim()
}

function stdinText(input: any): string {
  return ((input?.chars || input?.input) as string || '')
}

function patchSummary(input: any): string {
  const text = patchText(input)
  if (!text) return ''
  const firstFile = text.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/m)?.[1]
  const changeCount = (text.match(/^\*\*\* (?:Update|Add|Delete) File: /gm) || []).length
  if (firstFile) {
    const short = firstFile.split('/').slice(-2).join('/')
    return changeCount > 1 ? `${short} +${changeCount - 1}` : short
  }
  const firstLine = text.split('\n').find(Boolean) || ''
  return firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine
}

function stdinSummary(input: any): string {
  const chars = stdinText(input)
  if (!chars) return input?.session_id != null ? `session ${input.session_id}` : ''
  const visible = chars.replace(/\u0003/g, '^C').replace(/\r/g, '\\r').replace(/\n/g, '\\n')
  const prefix = input?.session_id != null ? `session ${input.session_id}: ` : ''
  return prefix + (visible.length > 60 ? visible.slice(0, 60) + '…' : visible)
}

function toolSummary(name: string, input: any): string {
  if (!input) return ''
  const fp = input.file_path as string || ''
  const short = fp.split('/').slice(-2).join('/')
  switch (name) {
    case 'Read': return short + (input.offset ? ` L${input.offset}` : '')
    case 'Write': return short
    case 'Edit': return short + (input.replace_all ? ' ×all' : '')
    case 'Bash': { const c = commandText(input).split('\n')[0]; return c.length > 80 ? c.slice(0, 80) + '…' : c }
    case 'Patch': return patchSummary(input)
    case 'Input': return stdinSummary(input)
    case 'Grep': return `${input.pattern || ''}${input.path ? ' in ' + input.path : ''}`
    case 'Glob': return input.pattern || ''
    case 'Agent': return input.description || ''
    default: return ''
  }
}

// ── Block renderers ─────────────────────────────────────────────────────────

// Linkify file paths inside tool input pres and tool result output. Deferred to
// the next microtask so text children are mounted before fixLinks walks them.
const linkifyRef = (el: HTMLElement) => queueMicrotask(() => fixLinks(el))

function renderBlock(block: ContentBlock, onImageClick?: (src: string) => void, onExpandTable?: (html: string) => void, getResult?: (toolUseId: string) => ContentBlock | undefined) {
  if (block.type === 'text' && block.text) {
    return <div class="markdown" innerHTML={renderMarkdown(block.text)} ref={(el) => queueMicrotask(() => enhanceMarkdown(el, onImageClick, onExpandTable))} />
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
    const inp = block.input || {}
    const presented = toolPresentation(block.name || 'tool', inp)
    const name = presented.name
    const color = TOOL_COLORS[name] || '#999'
    const summary = presented.summary
    const genericInput = SPECIAL_TOOL_DETAILS.has(name) ? '' : toolInputText(inp)
    const pre = 'white-space:pre-wrap;font-size:10px;font-family:SF Mono,Menlo,monospace;padding:3px 0;max-height:160px;overflow:auto;margin:0;word-break:break-all;'
    const isImageFile = (name === 'Read' || name === 'Write') && inp.file_path && IMAGE_EXTS.has(((inp.file_path as string).substring((inp.file_path as string).lastIndexOf('.')).toLowerCase()))
    const imagePath = toolImagePath(block.name || '', inp) || (isImageFile ? inp.file_path as string : '')
    const hasDetail = SPECIAL_TOOL_DETAILS.has(name) || !!genericInput || !!imagePath
    const result = block.id ? getResult?.(block.id) : undefined
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
        {name === 'Bash' && commandText(inp) && <pre style={`${pre}color:#e5a070`} ref={linkifyRef}>{commandText(inp)}</pre>}
        {name === 'Patch' && patchText(inp) && <pre style={`${pre}color:#c4993a`} ref={linkifyRef}>{patchText(inp).slice(0, 2000)}{patchText(inp).length > 2000 ? '\n…' : ''}</pre>}
        {name === 'Input' && <pre style={`${pre}color:#73b8ff`} ref={linkifyRef}>{stdinText(inp).replace(/\u0003/g, '^C') || '(empty stdin)'}{inp.session_id != null ? `\n\nsession: ${inp.session_id}` : ''}</pre>}
        {name === 'Write' && inp.content && <pre style={`${pre}color:#5cc878`} ref={linkifyRef}>{(inp.content as string).slice(0, 500)}{(inp.content as string).length > 500 ? '...' : ''}</pre>}
        {name === 'Agent' && <>
          {inp.subagent_type && <div style={{ padding: '2px 0', 'font-size': '10px', color: '#888' }}>Type: <span style={{ color: '#c4993a' }}>{inp.subagent_type}</span></div>}
          {inp.prompt && <pre style={`${pre}color:#88c4ff`} ref={linkifyRef}>{(inp.prompt as string).slice(0, 800)}{(inp.prompt as string).length > 800 ? '...' : ''}</pre>}
        </>}
        {name === 'Grep' && inp.pattern && <pre style={`${pre}color:#c4a0c0`}>/{inp.pattern}/{inp.path ? ` in ${inp.path}` : ''}</pre>}
        {name === 'Read' && inp.file_path && <pre style={`${pre}color:#88c4ff`} ref={linkifyRef}>{inp.file_path}{inp.offset ? ` (L${inp.offset})` : ''}</pre>}
        {genericInput && <pre style={`${pre}color:#aaa`} ref={linkifyRef}>{genericInput}</pre>}
      </details>
      {imagePath && (() => {
        const resolvedPath = imagePath.replace(/^~/, '/home/' + (typeof document !== 'undefined' ? document.querySelector<HTMLElement>('[data-username]')?.dataset.username || 'user' : 'user'))
        const imgSrc = appUrl(`/api/files/raw?path=${encodeURIComponent(resolvedPath)}`)
        return <img src={imgSrc} onClick={() => onImageClick?.(imgSrc)} style={{ 'max-width': '100%', 'max-height': '300px', 'border-radius': '8px', 'margin-top': '6px', display: 'block', cursor: 'zoom-in' }} />
      })()}
      {result && renderBlock(result, onImageClick, onExpandTable)}
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
        {raw && <div style={{ padding: '2px 0', 'font-size': '10px', 'font-family': "'SF Mono', Menlo, monospace", color: isErr ? '#e07070' : '#999', 'white-space': 'pre-wrap', 'max-height': '200px', overflow: 'auto', 'word-break': 'break-all' }} ref={linkifyRef}>{raw.length > 3000 ? raw.slice(0, 3000) + '\n... (truncated)' : raw}</div>}
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

function isQuestionBlock(block: ContentBlock): boolean {
  if (block.type !== 'tool_use') return false
  return block.name === 'AskUserQuestion' || block.name?.toLowerCase() === 'ask'
}

// Consecutive reasoning/tool messages belong to one assistant turn. Keep that
// execution trace available behind one quiet disclosure and attach it to the
// final answer when one follows.
function isTraceAssistantMsg(m: Message): boolean {
  if (m.role !== 'assistant' || !m.content || m.content.length === 0) return false
  if (m.content.some(isQuestionBlock)) return false
  const hasTool = m.content.some(block => block.type === 'tool_use' || block.type === 'tool_result')
  const hasThinking = m.content.some(block => block.type === 'thinking')
  const hasText = m.content.some(block => block.type === 'text' && block.text?.trim())
  return hasTool || (hasThinking && !hasText)
}

function canAttachTraceToMessage(m: Message): boolean {
  if (m.role !== 'assistant' || !m.content?.some(block => block.type === 'text' && block.text?.trim())) return false
  return !m.content.some(isQuestionBlock)
}

type RenderItem =
  | { kind: 'msg'; msg: Message }
  | { kind: 'chain'; messages: Message[] }
  | { kind: 'turn'; msg: Message; trace: Message[] }

function buildRenderItems(messages: Message[], isPureToolResult: (m: Message) => boolean): RenderItem[] {
  const out: RenderItem[] = []
  let i = 0
  while (i < messages.length) {
    const m = messages[i]
    if (isPureToolResult(m)) { i++; continue }
    if (isTraceAssistantMsg(m)) {
      const chain: Message[] = [m]
      let j = i + 1
      while (j < messages.length) {
        const next = messages[j]
        if (isPureToolResult(next)) { j++; continue }
        if (!isTraceAssistantMsg(next)) break
        chain.push(next)
        j++
      }
      const next = messages[j]
      if (next && canAttachTraceToMessage(next) && !isTraceAssistantMsg(next)) {
        out.push({ kind: 'turn', msg: next, trace: chain })
        i = j + 1
      } else {
        out.push({ kind: 'chain', messages: chain })
        i = j
      }
    } else {
      out.push({ kind: 'msg', msg: m })
      i++
    }
  }
  return out
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
.markdown .md-table-frame { position: relative; max-width: 100%; margin: 8px 0; overflow-x: auto; border: 1px solid #333; border-radius: 7px; -webkit-overflow-scrolling: touch; }
.markdown table { border-collapse: collapse; width: max-content; min-width: 100%; max-width: none; margin: 0; font-size: 0.9em; table-layout: auto; }
.markdown th, .markdown td { border: 1px solid #333; padding: 5px 10px; text-align: left; vertical-align: top; }
.markdown .md-col-compact { white-space: nowrap; width: 1%; }
.markdown .md-col-wide { min-width: 14rem; max-width: 34rem; white-space: normal; overflow-wrap: break-word; }
.markdown th { background: rgba(255,255,255,0.05); font-weight: 600; }
.markdown .md-table-expand { position: sticky; left: calc(100% - 32px); bottom: 6px; width: 26px; height: 26px; margin: 0 6px 6px 0; border: 1px solid #333; border-radius: 6px; background: rgba(20,24,30,0.94); color: #999; cursor: zoom-in; font-size: 15px; line-height: 1; }
.markdown .md-table-expand:hover { color: #e5e5e5; background: #1a1a2e; }
.md-table-modal { position: fixed; inset: 0; z-index: 220; display: flex; flex-direction: column; background: rgba(5,7,10,0.96); }
.md-table-modal-bar { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid #333; color: #999; font-size: 12px; }
.md-table-modal-body { flex: 1; overflow: auto; padding: 16px; -webkit-overflow-scrolling: touch; }
.md-table-modal-body table { border-collapse: collapse; width: max-content; min-width: 100%; font-size: 14px; }
.md-table-modal-body th, .md-table-modal-body td { border: 1px solid #333; padding: 8px 12px; text-align: left; vertical-align: top; }
.md-table-modal-body th { background: #1a1a2e; position: sticky; top: 0; }
.md-table-modal-body .md-col-compact { white-space: nowrap; width: 1%; }
.md-table-modal-body .md-col-wide { min-width: 18rem; max-width: 42rem; white-space: normal; overflow-wrap: break-word; }
.markdown a { color: #73b8ff; text-decoration: none; }
.markdown a:hover { text-decoration: underline; }
.markdown img { max-width: 100%; border-radius: 6px; }
.markdown img.md-local-img { display: block; max-height: 400px; margin: 8px 0; object-fit: contain; }
.markdown hr { border: none; border-top: 1px solid #333; margin: 12px 0; }
.markdown strong { font-weight: 600; }

/* Execution details: quiet at rest, full fidelity on demand */
.work-log { width: 100%; margin-top: 3px; }
.work-log > summary::-webkit-details-marker { display: none; }
.work-log-summary { display: flex; align-items: center; gap: 5px; width: max-content; min-height: 28px; padding: 0 2px; border: none; background: transparent; color: #666; font-size: 11px; cursor: pointer; list-style: none; user-select: none; transition: color 120ms ease; }
.work-log-summary:hover { color: #999; }
.work-log-summary:focus-visible { outline: 2px solid #4aba6a; outline-offset: 2px; border-radius: 4px; }
.work-log-chevron { display: inline-block; transition: transform 120ms ease; }
.work-log[open] .work-log-chevron { transform: rotate(90deg); }
.work-log-issue { display: inline-flex; align-items: center; gap: 4px; color: #c4993a; }
.work-log-issue-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.work-log-detail { margin-top: 6px; padding: 10px 12px; border: 1px solid #2a2a3a; border-radius: 9px; background: #0d1117; font-size: 13px; line-height: 1.5; }
.work-log-meta { margin-bottom: 8px; color: #555; font-size: 10px; }
.work-log-reasoning { margin: 2px 0 4px; padding-left: 8px; border-left: 1px solid rgba(192,132,252,0.3); color: #999; font-size: 12px; line-height: 1.4; }
.work-log-reasoning p { margin: 0 0 4px; }
.work-log-reasoning p:last-child { margin-bottom: 0; }
.work-log-reasoning ul, .work-log-reasoning ol { margin: 2px 0 4px; }

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

// ── Component ───────────────────────────────────────────────────────────────

type MessageViewTodo = {
  phases: Array<{ name: string; tasks: Array<{ content: string; status: string }> }>
  completed: number
  total: number
  active: string | null
}

type MessageViewSubagent = {
  id: string
  agent: string
  status: string
  description?: string
  intent?: string
  resolvedModel?: string
  toolCount?: number
  requests?: number
  tokens?: number
  durationMs?: number
}

type MessageViewJob = { id: string; type: string; status: string; label?: string }

type MessageViewRuntime = {
  modelProvider?: string
  modelId?: string
  modelApi?: string
  thinkingLevel?: string
  serviceTiers?: Record<string, string | null>
  contextTokens?: number
  contextWindow?: number
  contextPercent?: number
}

type MessageViewProps = {
  messages: Message[]
  loading: boolean
  hasMore?: boolean
  loadingMore?: boolean
  onLoadEarlier?: () => void
  onAnswer?: (text: string) => void
  onKeys?: (keys: string[]) => void
  starred?: Set<string>
  onToggleStar?: (uuid: string) => void
  working?: boolean
  statusText?: string | null
  intentHistory?: string[]
  assistantStream?: { text: string; ended: boolean } | null
  todo?: MessageViewTodo | null
  notice?: { kind: string; text: string } | null
  approval?: { toolName: string; approvalMode: string; reason?: string } | null
  subagents?: MessageViewSubagent[]
  jobs?: MessageViewJob[]
  runtime?: MessageViewRuntime | null
  scrollRefCb?: (el: HTMLDivElement) => void
  sessionId?: string | null
}

export function MessageView(props: MessageViewProps) {
  const [lightbox, setLightbox] = createSignal<string | null>(null)
  const [pdfViewer, setPdfViewer] = createSignal<string | null>(null)
  const [expandedTable, setExpandedTable] = createSignal<string | null>(null)
  let tableReturnFocus: HTMLElement | null = null
  let tableModal: HTMLDivElement | undefined

  function openExpandedTable(html: string) {
    tableReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setExpandedTable(html)
  }

  function closeExpandedTable() {
    setExpandedTable(null)
    queueMicrotask(() => tableReturnFocus?.focus())
  }

  function handleTableModalKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); closeExpandedTable(); return }
    if (event.key !== 'Tab' || !tableModal) return
    const focusable = Array.from(tableModal.querySelectorAll<HTMLElement>('button, a[href], [tabindex]:not([tabindex="-1"])'))
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }

  let scrollRef: HTMLDivElement | undefined
  const [pinned, setPinned] = createSignal(true)
  const [newMsgCount, setNewMsgCount] = createSignal(0)
  const [actionMenu, setActionMenu] = createSignal<string | null>(null)
  const [actionFeedback, setActionFeedback] = createSignal<string | null>(null)
  let prevMsgLen = props.messages.length
  let prevStreamText = props.assistantStream?.text || ''

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
  createEffect(() => {
    const len = props.messages.length
    const streamText = props.assistantStream?.text || ''
    const delta = len - prevMsgLen
    const streamChanged = streamText !== prevStreamText
    prevMsgLen = len
    prevStreamText = streamText
    if (!untrack(pinned) && delta > 0) {
      setNewMsgCount(c => c + delta)
    }
    if (untrack(pinned) && streamChanged) requestAnimationFrame(pinSync)
  })

  // Reset delta counter on session switch so a new session's load doesn't
  // get interpreted as a huge burst of "new messages since last time".
  createEffect(on(() => props.sessionId, () => {
    prevMsgLen = props.messages.length
    prevStreamText = props.assistantStream?.text || ''
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

  const toolResultsById = createMemo(() => {
    const results = new Map<string, ContentBlock>()
    for (const message of props.messages) {
      for (const block of message.content || []) {
        if (block.type === 'tool_result' && block.tool_use_id) results.set(block.tool_use_id, block)
      }
    }
    return results
  })
  const getResult = (id: string) => toolResultsById().get(id)
  const toolUseIds = createMemo(() => {
    const ids = new Set<string>()
    for (const message of props.messages) {
      for (const block of message.content || []) {
        if (block.type === 'tool_use' && block.id) ids.add(block.id)
      }
    }
    return ids
  })

  function isPureToolResultMsg(message: Message): boolean {
    if (!message.content?.length) return false
    return message.content.every(block => block.type === 'tool_result' || (block.type === 'text' && !block.text?.trim()))
      && message.content.some(block => block.type === 'tool_result')
      && message.content.filter(block => block.type === 'tool_result').every(block => !!block.tool_use_id && toolUseIds().has(block.tool_use_id))
  }

  function renderWorkLog(messages: Message[]) {
    const blocks = messages.flatMap(message => message.content || [])
    const traceBlocks = blocks.filter(block => block.type === 'thinking' || block.type === 'tool_use' || block.type === 'tool_result')
    const renderedToolUseIds = new Set(traceBlocks.filter(block => block.type === 'tool_use' && block.id).map(block => block.id!))
    const errorCount = traceBlocks.filter(block =>
      block.type === 'tool_result' ? !!block.is_error && (!block.tool_use_id || !renderedToolUseIds.has(block.tool_use_id)) :
      block.type === 'tool_use' && block.id ? !!getResult(block.id)?.is_error : false
    ).length
    const last = messages[messages.length - 1]
    return <details class="work-log">
      <summary class="work-log-summary" data-testid="work-log-summary">
        <span class="work-log-chevron">›</span>
        <span style={{ 'font-weight': '600' }}>Details</span>
        <Show when={errorCount > 0}>
          <span class="work-log-issue"><span class="work-log-issue-dot" />{errorCount} issue{errorCount === 1 ? '' : 's'}</span>
        </Show>
      </summary>
      <div class="work-log-detail" data-testid="work-log-detail">
        <div class="work-log-meta">{traceBlocks.length} execution step{traceBlocks.length === 1 ? '' : 's'} · {formatTime(last?.timestamp || '')}</div>
        <For each={messages}>{(message) => <For each={message.content}>{(block) => {
          if (block.type === 'tool_result' && block.tool_use_id && renderedToolUseIds.has(block.tool_use_id)) return null
          if (block.type === 'thinking' && block.thinking) {
            return <div class="markdown work-log-reasoning" innerHTML={renderMarkdown(block.thinking)} ref={(element) => queueMicrotask(() => enhanceMarkdown(element, (src) => setLightbox(src), openExpandedTable))} />
          }
          return renderBlock(block, (src) => setLightbox(src), openExpandedTable, getResult)
        }}</For>}</For>
      </div>
    </details>
  }

  const renderMsg = (msg: Message, trace: Message[] = []) => {
    const textBlock = msg.content?.find(b => b.type === 'text' && b.text)
    const { cleanText, images, files } = textBlock?.text ? extractImages(textBlock.text) : { cleanText: textBlock?.text || '', images: [], files: [] }
    const hasImages = images.length > 0
    const hasFiles = files.length > 0
    const hasAttachments = hasImages || hasFiles
    const inlineTraceBlocks = msg.role === 'assistant' ? (msg.content || []).filter(block =>
      block.type === 'thinking' || block.type === 'tool_result' ||
      (block.type === 'tool_use' && !isQuestionBlock(block))
    ) : []
    const workLogMessages = inlineTraceBlocks.length > 0 ? [...trace, { ...msg, content: inlineTraceBlocks }] : trace

    return <div style={{ display: 'flex', 'flex-direction': 'column', 'align-items': msg.role === 'user' ? 'flex-end' : 'flex-start', 'margin-bottom': '10px' }}>
      <div data-uuid={msg.uuid} data-role={msg.role} style={{
        'max-width': '85%', padding: hasAttachments ? '6px' : '10px 14px',
        'border-radius': msg.role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
        background: msg.role === 'user' ? 'rgba(74,186,106,0.15)' : '#1a1a2e',
        color: '#e5e5e5', overflow: 'hidden',
        'font-size': '14px', 'line-height': '1.5', 'word-break': 'break-word',
      }}>
        <For each={images}>{(src) => (
          <img src={localImageHref(src)} onClick={() => setLightbox(localImageHref(src))} onError={(event) => replaceImageWithPathLink(event.currentTarget, src)} style={{ 'max-width': '100%', 'max-height': '300px', 'border-radius': hasAttachments ? '12px' : '6px', 'margin-bottom': '4px', cursor: 'zoom-in', display: 'block' }} />
        )}</For>
        <For each={files}>{(f) => (
          <a href={localFileHref(f.path)} target="_blank" rel="noopener" onClick={(e) => { if (f.name.toLowerCase().endsWith('.pdf')) { e.preventDefault(); setPdfViewer(localFileHref(f.path)) } }} style={{ display: 'flex', 'align-items': 'center', gap: '6px', padding: '6px 10px', margin: '2px 0', background: 'rgba(255,255,255,0.05)', 'border-radius': '8px', 'text-decoration': 'none', color: '#73b8ff', 'font-size': '12px' }}>
            <span style={{ 'font-size': '16px' }}>{f.name.endsWith('.pdf') ? '\uD83D\uDCC4' : '\uD83D\uDCCE'}</span>
            <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{f.name}</span>
          </a>
        )}</For>
        <div style={hasAttachments ? { padding: '4px 8px 4px' } : {}}>
          <For each={msg.content}>{(block) => {
            if (msg.role === 'assistant' && (block.type === 'thinking' || block.type === 'tool_result' || (block.type === 'tool_use' && !isQuestionBlock(block)))) return null
            if (block.type === 'text' && block.text) {
              const display = hasAttachments ? cleanText : block.text
              return display ? <div class="markdown" innerHTML={renderMarkdown(display)} ref={(el) => queueMicrotask(() => enhanceMarkdown(el, (src) => setLightbox(src), openExpandedTable))} /> : null
            }
            if (isQuestionBlock(block)) {
              const rawQuestions = Array.isArray(block.input?.questions)
                ? block.input.questions
                : [{ id: 'question', question: block.input?.question || 'The assistant needs your input.', options: [{ label: 'Yes' }, { label: 'No' }, { label: 'Continue' }] }]
              return <For each={rawQuestions}>{(question, questionIndex) => {
                const options = Array.isArray(question.options) ? question.options : []
                const answered = block.id ? !!getResult(block.id) : false
                return <div style={{ margin: '6px 0', background: 'rgba(168,85,247,.06)', border: '1px solid rgba(168,85,247,.25)', 'border-left': '2px solid #a855f7', 'border-radius': '10px', padding: '12px' }}>
                  <div style={{ color: '#a855f7', 'font-size': '10px', 'font-weight': '700', 'text-transform': 'uppercase', 'letter-spacing': '.08em', 'margin-bottom': '6px' }}>{answered ? 'Answered' : question.header || 'Question'}</div>
                  <div style={{ color: '#e5e5e5', 'font-size': '14px', 'margin-bottom': '10px' }}>{question.question}</div>
                  <div style={{ display: 'flex', gap: '6px', 'flex-wrap': 'wrap' }}>
                    <For each={options}>{(option, optionIndex) => <button
                      disabled={answered}
                      title={option.description || undefined}
                      onClick={() => {
                        if (answered) return
                        if (!props.onKeys) {
                          props.onAnswer?.(rawQuestions.length > 1 ? `${question.id}: ${option.label}` : option.label)
                          return
                        }
                        props.onKeys(['Home', ...Array(optionIndex()).fill('Down'), question.multi ? 'Space' : 'Enter'])
                      }}
                      style={{ background: '#252536', border: '1px solid #555', color: '#e5e5e5', padding: '5px 12px', 'border-radius': '6px', 'font-size': '12px', cursor: answered ? 'default' : 'pointer', 'text-align': 'left', opacity: answered ? '.55' : '1' }}>
                      <span>{option.label}</span>
                      <Show when={option.description}><span style={{ display: 'block', color: '#888', 'font-size': '10px', 'margin-top': '2px' }}>{option.description}</span></Show>
                    </button>}</For>
                    <Show when={question.multi}><button disabled={answered} onClick={() => props.onKeys?.(['End', 'Enter'])} style={{ background: '#4aba6a', border: 'none', color: '#061109', padding: '5px 12px', 'border-radius': '6px', 'font-size': '12px', cursor: 'pointer' }}>Done</button></Show>
                  </div>
                  <Show when={question.multi}><div style={{ color: '#888', 'font-size': '10px', 'margin-top': '7px' }}>Multiple selections allowed</div></Show>
                  <Show when={questionIndex() < rawQuestions.length - 1}><div style={{ height: '6px' }} /></Show>
                </div>
              }}</For>
            }
            return renderBlock(block, (src) => setLightbox(src), openExpandedTable)
          }}</For>
          <Show when={msg.role === 'assistant' && workLogMessages.length > 0}>{renderWorkLog(workLogMessages)}</Show>
        </div>
      </div>
      <div style={{ display: 'flex', 'align-items': 'center', gap: '4px', 'margin-top': '4px', padding: '0 4px', 'justify-content': msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
        <span onClick={(e) => { const el = e.currentTarget; el.textContent = el.textContent === formatTime(msg.timestamp) ? formatFullDate(msg.timestamp) : formatTime(msg.timestamp) }}
          style={{ 'font-size': '10px', color: '#444', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>{formatTime(msg.timestamp)}</span>
        {msg.role === 'user' && msg.delivery && (
          <span title={msg.delivery === 'queued' ? 'Queued safely on this device' : msg.delivery === 'delivered' ? 'Delivered to the chat transcript' : 'Accepted by Feather'}
            style={{ 'font-size': msg.delivery === 'queued' ? '10px' : '11px', color: msg.delivery === 'delivered' ? '#4aba6a' : msg.delivery === 'queued' ? '#d8bd66' : '#777' }}>
            {msg.delivery === 'queued' ? 'queued' : msg.delivery === 'delivered' ? '\u2713\u2713' : '\u2713'}
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
      <Show when={expandedTable()}>
        <div ref={tableModal} class="md-table-modal" role="dialog" aria-modal="true" aria-label="Expanded table" onKeyDown={handleTableModalKeydown}>
          <div class="md-table-modal-bar">
            <span>Table</span>
            <button ref={(element) => queueMicrotask(() => element.focus())} aria-label="Close expanded table" onClick={closeExpandedTable} style={{ background: 'none', border: 'none', color: '#e5e5e5', 'font-size': '24px', cursor: 'pointer', padding: '2px 8px' }}>&times;</button>
          </div>
          <div class="md-table-modal-body" innerHTML={expandedTable()!} ref={(element) => queueMicrotask(() => { fixLinks(element, (src) => setLightbox(src)); fixImages(element, (src) => setLightbox(src)) })} />
        </div>
      </Show>
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
      {/* PDF viewer */}
      <Show when={pdfViewer()}>
        <div style={{ position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.92)', 'z-index': '200', display: 'flex', 'flex-direction': 'column' }}>
          <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', padding: '8px 12px', background: '#111' }}>
            <span style={{ color: '#999', 'font-size': '13px', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', flex: '1' }}>{pdfViewer()!.split('/').pop()}</span>
            <button onClick={() => setPdfViewer(null)} style={{ background: 'none', border: 'none', color: '#e5e5e5', 'font-size': '24px', cursor: 'pointer', padding: '4px 8px', 'line-height': '1' }}>&times;</button>
          </div>
          <iframe src={pdfViewer()!} style={{ flex: '1', border: 'none', width: '100%', background: '#fff' }} />
        </div>
      </Show>
      {/* Action menu backdrop */}
      <Show when={actionMenu()}>
        <div onClick={() => setActionMenu(null)} style={{ position: 'fixed', inset: '0', 'z-index': '90' }} />
      </Show>

      <For each={buildRenderItems(props.messages, isPureToolResultMsg)}>{(item) => {
        if (item.kind === 'msg') return renderMsg(item.msg)
        if (item.kind === 'turn') return renderMsg(item.msg, item.trace)
        // Keep an unfinished or failed trace reachable even before a final
        // answer arrives; it stays collapsed so it does not dominate chat.
        return <div style={{ margin: '4px 0 10px', 'max-width': '85%' }}>{renderWorkLog(item.messages)}</div>
      }}</For>

      <Show when={props.approval}>
        <div data-testid="omp-approval" role="alert" style={{ margin: '0 0 10px', padding: '11px 12px', 'border-radius': '10px', border: '1px solid #d8a13b', background: 'rgba(216,161,59,.08)' }}>
          <div style={{ color: '#d8a13b', 'font-size': '10px', 'font-weight': '700', 'text-transform': 'uppercase', 'letter-spacing': '.08em' }}>Approval required</div>
          <div style={{ color: '#e5e5e5', 'font-size': '13px', 'margin-top': '4px' }}>{props.approval!.toolName}</div>
          <Show when={props.approval!.reason}><div style={{ color: '#999', 'font-size': '11px', 'margin-top': '3px', 'white-space': 'pre-wrap' }}>{props.approval!.reason}</div></Show>
          <div style={{ display: 'flex', gap: '7px', 'margin-top': '9px' }}>
            <button onClick={() => props.onKeys?.(['Enter'])} style={{ background: '#4aba6a', color: '#07140b', border: 'none', padding: '5px 13px', 'border-radius': '6px', 'font-size': '12px', 'font-weight': '600', cursor: 'pointer' }}>Approve</button>
            <button onClick={() => props.onKeys?.(['Escape'])} style={{ background: 'transparent', color: '#ccc', border: '1px solid #444', padding: '5px 13px', 'border-radius': '6px', 'font-size': '12px', cursor: 'pointer' }}>Reject</button>
          </div>
        </div>
      </Show>

      <Show when={props.runtime}>
        <details data-testid="omp-runtime" style={{ margin: '0 0 10px', padding: '0 11px', 'border-radius': '10px', border: '1px solid #292936', background: '#11151c' }}>
          <summary style={{ padding: '7px 0', cursor: 'pointer', color: '#888', 'font-size': '11px' }}>
            {[props.runtime!.modelProvider, props.runtime!.modelId].filter(Boolean).join('/') || 'OMP session'}
            <Show when={props.runtime!.thinkingLevel}><span> · {props.runtime!.thinkingLevel}</span></Show>
            <Show when={props.runtime!.contextPercent !== undefined}><span> · {Math.round(props.runtime!.contextPercent!)}% context</span></Show>
          </summary>
          <div style={{ padding: '0 0 8px', color: '#777', 'font-size': '10px', 'line-height': '1.55' }}>
            <Show when={props.runtime!.modelApi}><div>API · {props.runtime!.modelApi}</div></Show>
            <Show when={props.runtime!.contextTokens !== undefined && props.runtime!.contextWindow !== undefined}><div>Context · {props.runtime!.contextTokens!.toLocaleString()} / {props.runtime!.contextWindow!.toLocaleString()} tokens</div></Show>
            <Show when={Object.keys(props.runtime!.serviceTiers || {}).length}><div>Service · {Object.entries(props.runtime!.serviceTiers || {}).map(([family, tier]) => `${family}: ${tier || 'default'}`).join(' · ')}</div></Show>
          </div>
        </details>
      </Show>

      <Show when={(props.subagents?.length || 0) > 0}>
        <details data-testid="omp-subagents" open={(props.subagents || []).some(agent => agent.status === 'running' || agent.status === 'started')} style={{ margin: '0 0 10px', padding: '0 11px', 'border-radius': '10px', border: '1px solid #333', background: '#11151c' }}>
          <summary style={{ padding: '8px 0', cursor: 'pointer', color: '#bbb', 'font-size': '12px', 'font-weight': '600' }}>Agents · {(props.subagents || []).filter(agent => agent.status === 'running' || agent.status === 'started').length} running</summary>
          <div style={{ padding: '0 0 8px' }}><For each={props.subagents || []}>{(agent) => <div style={{ padding: '5px 0', 'border-top': '1px solid #222', 'font-size': '11px' }}>
            <div style={{ display: 'flex', 'justify-content': 'space-between', gap: '8px' }}><span style={{ color: '#e5e5e5', 'font-weight': '600' }}>{agent.agent}</span><span style={{ color: agent.status === 'failed' ? '#e07070' : '#d8a13b' }}>{agent.status}</span></div>
            <Show when={agent.description}><div style={{ color: '#aaa', 'margin-top': '2px' }}>{agent.description}</div></Show>
            <Show when={agent.intent}><div style={{ color: '#777', 'margin-top': '2px' }}>{agent.intent}</div></Show>
            <div style={{ color: '#555', 'font-size': '10px', 'margin-top': '2px' }}>{[agent.resolvedModel, agent.toolCount !== undefined ? `${agent.toolCount} steps` : '', agent.tokens !== undefined ? `${agent.tokens.toLocaleString()} tokens` : ''].filter(Boolean).join(' · ')}</div>
          </div>}</For></div>
        </details>
      </Show>

      <Show when={(props.jobs?.length || 0) > 0}>
        <details data-testid="omp-jobs" style={{ margin: '0 0 10px', padding: '0 11px', 'border-radius': '10px', border: '1px solid #292936', background: '#11151c' }}>
          <summary style={{ padding: '7px 0', cursor: 'pointer', color: '#888', 'font-size': '11px' }}>Background jobs · {(props.jobs || []).filter(job => job.status === 'running').length} running</summary>
          <div style={{ padding: '0 0 7px' }}><For each={props.jobs || []}>{(job) => <div style={{ display: 'flex', 'justify-content': 'space-between', gap: '8px', padding: '3px 0', color: '#777', 'font-size': '10px' }}><span>{job.label || job.type}</span><span>{job.status}</span></div>}</For></div>
        </details>
      </Show>

      <Show when={props.notice}><div role="status" style={{ margin: '0 0 10px', padding: '8px 11px', 'border-radius': '9px', border: '1px solid #d8a13b', background: 'rgba(216,161,59,.08)', color: '#d8a13b', 'font-size': '12px' }}>{props.notice!.text}</div></Show>

      <Show when={props.todo}>
        <details open={props.working} style={{ margin: '0 0 10px', padding: '0 11px', 'border-radius': '10px', border: '1px solid #333', background: '#11151c' }}>
          <summary style={{ padding: '8px 0', cursor: 'pointer', color: '#bbb', 'font-size': '12px', 'font-weight': '600' }}>Todo · {props.todo!.completed}/{props.todo!.total}<Show when={props.todo!.active}><span style={{ color: '#777', 'font-weight': '400' }}> · {props.todo!.active}</span></Show></summary>
          <div style={{ padding: '0 0 9px' }}><For each={props.todo!.phases}>{(phase) => <div style={{ 'margin-top': '7px' }}>
            <div style={{ color: '#777', 'font-size': '10px', 'font-weight': '700', 'text-transform': 'uppercase', 'letter-spacing': '.06em', 'margin-bottom': '3px' }}>{phase.name}</div>
            <For each={phase.tasks}>{(task) => <div style={{ display: 'flex', gap: '7px', padding: '2px 0', color: task.status === 'completed' ? '#666' : task.status === 'in_progress' ? '#e5e5e5' : '#aaa', 'font-size': '11px', 'text-decoration': task.status === 'abandoned' ? 'line-through' : 'none' }}><span style={{ color: task.status === 'completed' ? '#4aba6a' : task.status === 'in_progress' ? '#d8a13b' : task.status === 'blocked' ? '#d8a13b' : '#555', width: '12px', 'flex-shrink': '0' }}>{task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '●' : task.status === 'blocked' ? '!' : task.status === 'abandoned' ? '×' : '○'}</span><span>{task.content}</span></div>}</For>
          </div>}</For></div>
        </details>
      </Show>

      <Show when={props.assistantStream?.text}>
        <div data-testid="assistant-stream" aria-live="polite" style={{ display: 'flex', 'justify-content': 'flex-start', 'margin-bottom': '10px' }}><div style={{ 'max-width': '100%', padding: '10px 14px', 'border-radius': '12px', background: '#1a1a2e', border: '1px solid rgba(255,255,255,.06)', color: '#e5e5e5', 'font-size': '14px', 'line-height': '1.55', 'white-space': 'pre-wrap', 'word-break': 'break-word' }}>{props.assistantStream!.text}<span aria-hidden="true" style={{ display: 'inline-block', width: '1px', height: '1em', background: '#aaa', 'margin-left': '2px', 'vertical-align': 'text-bottom', opacity: props.assistantStream!.ended ? '.35' : '.9' }} /></div></div>
      </Show>

      {/* Typing indicator — always mounted, opacity-toggled so mount/unmount
          doesn't shift layout and trigger a pin-scroll every time working flips. */}
      <div style={{ display: 'flex', 'align-items': 'flex-start', 'margin-bottom': '10px', opacity: props.working ? '1' : '0', transition: 'opacity 0.12s', 'pointer-events': props.working ? 'auto' : 'none' }}>
        <div role={props.statusText ? 'status' : undefined} aria-live={props.statusText ? 'polite' : undefined} aria-hidden={!props.working ? 'true' : undefined} style={{ padding: '10px 16px', 'border-radius': '16px 16px 16px 4px', background: '#1a1a2e', display: 'flex', gap: '4px', 'align-items': 'center', 'max-width': '92%' }}>
          <span class="typing-dot" style={{ width: '6px', height: '6px', 'border-radius': '50%', background: '#888', 'animation': 'typing-bounce 1.2s ease-in-out infinite' }} />
          <span class="typing-dot" style={{ width: '6px', height: '6px', 'border-radius': '50%', background: '#888', 'animation': 'typing-bounce 1.2s ease-in-out 0.2s infinite' }} />
          <span class="typing-dot" style={{ width: '6px', height: '6px', 'border-radius': '50%', background: '#888', 'animation': 'typing-bounce 1.2s ease-in-out 0.4s infinite' }} />
          <Show when={props.statusText}>
            <Show when={(props.intentHistory?.length || 0) > 1} fallback={<span style={{ 'margin-left': '6px', 'font-size': '12px', color: '#999', 'line-height': '1.35', 'word-break': 'break-word' }}>{props.statusText}</span>}>
              <details style={{ 'margin-left': '6px' }}><summary style={{ cursor: 'pointer', 'font-size': '12px', color: '#999', 'line-height': '1.35', 'word-break': 'break-word' }}>{props.statusText}</summary><div style={{ 'margin-top': '6px', padding: '6px 8px', 'border-left': '1px solid #444', color: '#777', 'font-size': '10px', 'line-height': '1.45' }}><For each={(props.intentHistory || []).slice(0, -1)}>{(intent) => <div>{intent}</div>}</For></div></details>
            </Show>
          </Show>
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
