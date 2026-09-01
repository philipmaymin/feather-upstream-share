import { For, Index, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from 'solid-js'
import type { Message, ContentBlock, OmpSubagentState, OmpTodoSnapshot, OmpTimelineItem, OmpWorkScope, ProtocolRunSnapshot } from '../api'
import { toBlob } from 'html-to-image'
import { Marked } from 'marked'
import { markedHighlight } from 'marked-highlight'
import markedKatex from 'marked-katex-extension'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import DOMPurify from 'dompurify'
import Anser from 'anser'
import { createTwoFilesPatch } from 'diff'
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
import { activityDescription, toolImagePath, toolInputDisplay, toolOutputDisplay, toolPresentation } from '../lib/toolPresentation.js'
import { localFilePath } from '../lib/localMedia.js'
import { appUrl } from '../lib/appPath.js'
import { extractImages } from '../lib/attachments.js'
import { ProtocolRunCard } from './ProtocolRunCard'
import { runsForInvocation } from '../lib/protocolRuns.js'

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
type MathCode = { source: string; display: boolean }

function mathOnlyCode(text: string, displayOnly = false): MathCode | null {
  const value = text.trim()
  const display = value.match(/^\$\$\s*([\s\S]+?)\s*\$\$$/) || value.match(/^\\\[\s*([\s\S]+?)\s*\\\]$/)
  if (display?.[1]?.trim()) return { source: display[1].trim(), display: true }
  if (displayOnly) return null
  const inline = value.match(/^\$(?!\$)([\s\S]+?)\$$/) || value.match(/^\\\(([\s\S]+?)\\\)$/)
  return inline?.[1]?.trim() ? { source: inline[1].trim(), display: false } : null
}

function renderMathCode(math: MathCode): string | false {
  try {
    return katex.renderToString(math.source, { displayMode: math.display, throwOnError: false, trust: false })
  } catch {
    return false
  }
}



const marked = new Marked(
  { gfm: true, breaks: true },
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value
      return code
    },
  }),
  markedKatex({ throwOnError: false }),
  {
    renderer: {
      codespan({ text }) {
        const math = mathOnlyCode(text)
        return math ? renderMathCode(math) : false
      },
      code({ text, lang }) {
        const language = lang?.trim().toLowerCase()
        const math = ['math', 'latex', 'tex'].includes(language || '')
          ? { source: text.trim(), display: true }
          : mathOnlyCode(text, true)
        return math?.source ? renderMathCode(math) : false
      },
    },
  },
)
const mdCache = new Map<string, string>()
const MD_CACHE_MAX = 2000

export function renderMarkdown(text: string): string {
  const cached = mdCache.get(text)
  if (cached !== undefined) return cached
  const html = marked.parse(text.trimEnd()) as string
  const safe = DOMPurify.sanitize(html, { ADD_ATTR: ['class', 'target', 'rel'], FORBID_TAGS: ['style'] })
    .replace(/<table>/g, '<div class="table-wrap"><table>')
    .replace(/<\/table>/g, '</table></div>')
  if (mdCache.size >= MD_CACHE_MAX) {
    const first = mdCache.keys().next().value!
    mdCache.delete(first)
  }
  mdCache.set(text, safe)
  return safe
}
// Persistent Room knowledge and resident A2A are passive content. They may
// contain links and formatting, but must never inject controls, CSS, embedded
// browsing contexts, or resources that load from the network automatically.
export function renderWikiMarkdown(text: string): string {
  return DOMPurify.sanitize(renderMarkdown(text), {
    ADD_ATTR: ['class', 'target', 'rel'],
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'option', 'img', 'picture', 'source', 'video', 'audio', 'track', 'iframe', 'object', 'embed', 'link', 'meta'],
    FORBID_ATTR: ['style', 'action', 'formaction', 'src', 'srcset', 'background', 'autofocus'],
  })
}


function isRemoteImageReference(value: string | null): boolean {
  if (!value) return false
  const normalized = value.trim().replace(/[\u0000-\u0020]/g, '').replace(/\\/g, '/')
  return /^(?:https?:)?\/\//i.test(normalized)
}

function remoteImageSourceSetReference(value: string | null): string | null {
  return value?.match(/(?:^|,)\s*((?:https?:)?\/\/[^\s,]+)/i)?.[1] || null
}

function renderRichMarkdown(text: string, allowRemoteImages: boolean): string {
  const html = renderMarkdown(text)
  if (allowRemoteImages) return html

  const template = document.createElement('template')
  template.innerHTML = html
  for (const image of template.content.querySelectorAll('img')) {
    const source = image.getAttribute('src')
    const remoteSource = isRemoteImageReference(source)
      ? source!
      : remoteImageSourceSetReference(image.getAttribute('srcset'))
    if (!remoteSource) continue

    const link = document.createElement('a')
    link.href = remoteSource
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.title = remoteSource
    link.dataset.remoteImageSource = 'true'
    link.textContent = image.alt ? `Load remote image: ${image.alt}` : `Load remote image: ${remoteSource}`
    image.replaceWith(link)
  }
  return template.innerHTML
}

// Live snapshots are sanitized on every update and deliberately omit remote
// images. This prevents an unfinished answer from making third-party requests
// while still rendering headings, lists, links, tables, and code immediately.
function renderLiveMarkdown(text: string): string {
  const html = marked.parse(text.trimEnd()) as string
  return DOMPurify.sanitize(html, { ADD_ATTR: ['class', 'target', 'rel'], FORBID_TAGS: ['img', 'style'] })
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
  const href = a.getAttribute('href')
  if (href?.trim().startsWith('//')) return null
  const candidate = localFilePath(href)
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

const CODE_WRAP_STORAGE_KEY = 'feather-code-wrap'

function applyCodeWrap(enabled: boolean, persist = true) {
  document.documentElement.classList.toggle('code-nowrap', !enabled)
  for (const input of document.querySelectorAll<HTMLInputElement>('.code-wrap-checkbox')) {
    input.checked = enabled
  }
  if (!persist) return
  try {
    window.localStorage.setItem(CODE_WRAP_STORAGE_KEY, String(enabled))
  } catch {}
}

// Code-block copy buttons are injected after Markdown rendering and handled
// here through the scroll container so rerenders do not accumulate listeners.
function handleCopyClick(e: MouseEvent) {
  const btn = (e.target as HTMLElement).closest('.copy-btn') as HTMLElement | null
  if (!btn) return
  const code = btn.closest('.code-block-shell')?.querySelector('pre code')
  if (!code) return
  navigator.clipboard.writeText(code.textContent || '').then(() => {
    btn.textContent = 'Copied!'
    setTimeout(() => { btn.textContent = 'Copy' }, 1500)
  })
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
function injectCopyButtons(el: HTMLElement) {
  for (const pre of el.querySelectorAll('pre')) {
    if (pre.closest('.code-block-shell')) continue

    const tools = document.createElement('div')
    tools.className = 'code-tools'

    const copy = document.createElement('button')
    copy.className = 'copy-btn'
    copy.textContent = 'Copy'
    tools.appendChild(copy)

    const wrap = document.createElement('label')
    wrap.className = 'code-wrap-control'
    wrap.title = 'Wrap long code and output lines'
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.className = 'code-wrap-checkbox'
    checkbox.checked = !document.documentElement.classList.contains('code-nowrap')
    checkbox.setAttribute('aria-label', 'Wrap long code and output lines')
    checkbox.onchange = (event) => {
      event.stopPropagation()
      applyCodeWrap(checkbox.checked)
    }
    wrap.append(checkbox, document.createTextNode('Wrap'))
    tools.appendChild(wrap)

    const shell = document.createElement('div')
    shell.className = 'code-block-shell'
    pre.parentNode!.insertBefore(shell, pre)
    shell.append(tools, pre)
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

function fixLinks(el: HTMLElement, onImageClick?: (src: string) => void, onOpenFile?: (path: string) => void) {
  for (const a of el.querySelectorAll('a')) {
    if (a.dataset.remoteImageSource === 'true') {
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      continue
    }
    // Markdown already turns [label](/absolute/path) into an anchor, so the
    // text-node pass below never sees its path. Route those anchors through
    // the same authenticated preview endpoint as the Files tab.
    const localPath = filesystemPathFromHref(a)
    if (localPath) {
      a.href = localFileHref(localPath)
      a.classList.add('feather-path')
      a.dataset.path = localPath
      a.title = /\.html?$/i.test(localPath) ? 'Open HTML preview' : 'Open local file'
      const ext = localPath.substring(localPath.lastIndexOf('.')).toLowerCase()
      if (!IMAGE_EXTS.has(ext) && onOpenFile) {
        a.removeAttribute('target')
        a.removeAttribute('rel')
        a.onclick = (event) => {
          event.preventDefault()
          event.stopPropagation()
          onOpenFile(localPath)
        }
        continue
      }
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
        a.onclick = (event) => { event.preventDefault(); event.stopPropagation(); onImageClick?.(imgSrc) }
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
        img.onclick = (event) => { event.stopPropagation(); onImageClick?.(imgSrc) }
        frag.appendChild(img)
      } else {
        a.href = fileHref
        if (onOpenFile) {
          a.onclick = (event) => {
            event.preventDefault()
            event.stopPropagation()
            onOpenFile(path)
          }
        } else {
          a.target = '_blank'
          a.rel = 'noopener'
        }
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
      img.addEventListener('click', (event) => { event.stopPropagation(); onImageClick?.(url) })
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

function enhanceMarkdown(el: HTMLElement, onImageClick?: (src: string) => void, onExpandTable?: (html: string) => void, onOpenFile?: (path: string) => void) {
  injectCopyButtons(el)
  fixLinks(el, onImageClick, onOpenFile)
  fixImages(el, onImageClick)
  collapseCodeBlocks(el)
  enhanceTables(el, onExpandTable)
}

// ── Utilities ───────────────────────────────────────────────────────────────

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
}

// Render ANSI escape sequences as inline-styled HTML. Tool output is plain
// text: escape markup first (Anser does NOT escape by default), so quoted
// HTML like <style>body{display:none}</style> renders as text instead of
// becoming live DOM. DOMPurify stays as the backstop.
function ansiToSafeHtml(raw: string): string {
  const html = Anser.ansiToHtml(Anser.escapeForHtml(raw))
  return DOMPurify.sanitize(html, { ADD_ATTR: ['style'], FORBID_TAGS: ['style'] })
}

type DiffKind = 'meta' | 'hunk' | 'add' | 'del' | 'ctx'
function buildUnifiedDiff(oldText: string, newText: string, filePath: string): Array<{ line: string; kind: DiffKind }> {
  const patch = createTwoFilesPatch(filePath, filePath, oldText, newText, 'before', 'after', { context: 3 })
  const lines = patch.split('\n')
  // Skip the first 4 header lines (Index, ===, ---, +++) — too noisy inline
  return lines.slice(4).map(l => {
    if (l.startsWith('@@')) return { line: l, kind: 'hunk' as const }
    if (l.startsWith('+')) return { line: l, kind: 'add' as const }
    if (l.startsWith('-')) return { line: l, kind: 'del' as const }
    return { line: l, kind: 'ctx' as const }
  })
}

function diffLineStyle(kind: DiffKind): Record<string, string> {
  switch (kind) {
    case 'hunk': return { color: 'var(--info)', background: 'rgba(59,130,246,0.10)' }
    case 'add':  return { color: 'var(--diff-add-text)', background: 'var(--diff-add-bg)' }
    case 'del':  return { color: 'var(--diff-del-text)', background: 'var(--diff-del-bg)' }
    case 'meta': return { color: 'var(--text-dim)', 'font-weight': '600' }
    default:     return { color: 'var(--text-secondary)' }
  }
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
const linkifyRef = (el: HTMLElement, onImageClick?: (src: string) => void, onOpenFile?: (path: string) => void) => queueMicrotask(() => fixLinks(el, onImageClick, onOpenFile))

function renderBlock(block: ContentBlock, onImageClick?: (src: string) => void, onExpandTable?: (html: string) => void, getResult?: (toolUseId: string) => ContentBlock | undefined, onOpenFile?: (path: string) => void) {
  if (block.type === 'text' && block.text) {
    return <div class="markdown" innerHTML={renderMarkdown(block.text)} ref={(el) => queueMicrotask(() => enhanceMarkdown(el, onImageClick, onExpandTable, onOpenFile))} />
  }
  if (block.type === 'thinking' && block.thinking) {
    return (
      <details style={{ margin: '4px 0', 'border-left': '2px solid rgba(168,85,247,0.35)', 'padding-left': '12px' }}>
        <summary style={{ display: 'flex', 'align-items': 'center', gap: '6px', color: 'var(--text-muted)', 'font-size': '12px', cursor: 'pointer', 'list-style': 'none', 'user-select': 'none', padding: '2px 0' }}>
          <span style={{ color: '#c084fc', 'font-size': '13px', 'line-height': '1', width: '12px', display: 'inline-flex', 'align-items': 'center' }}>◉</span>
          <span style={{ color: '#c084fc' }}>Reasoning</span>
          <span style={{ 'margin-left': 'auto', color: 'var(--text-ghost)', 'font-size': '10px' }}>▸</span>
        </summary>
        <div class="markdown" style={{ 'margin-top': '6px', 'margin-left': '4px', padding: '10px 14px', background: 'rgba(168,85,247,0.04)', border: '1px solid rgba(168,85,247,0.12)', 'border-radius': '10px', color: 'var(--text-secondary)', 'font-size': '12px', 'max-height': '400px', 'overflow-y': 'auto', 'line-height': '1.55', 'box-shadow': '0 1px 3px rgba(0,0,0,0.15)' }}
          innerHTML={renderLiveMarkdown(block.thinking)}
          ref={(element) => queueMicrotask(() => enhanceMarkdown(element, onImageClick, onExpandTable, onOpenFile))} />
      </details>
    )
  }
  if (block.type === 'tool_use') {
    const inp = block.input || {}
    // OMP's native Read/Write tools use `path`; Claude uses `file_path`.
    // Normalize both so native execution details remain inspectable and their
    // local artifact paths get the same clickable Files preview treatment.
    const filePath = inp.file_path || inp.path || ''
    const presented = toolPresentation(block.name || 'tool', inp)
    const name = presented.name
    const color = TOOL_COLORS[name] || '#999'
    const summary = activityDescription(block.name || '', inp, block.intent || '')
    const readableInput = toolInputDisplay(block.name || '', inp)
    const genericInput = SPECIAL_TOOL_DETAILS.has(name) ? '' : readableInput
    const pre = 'white-space:pre-wrap;font:11px/1.55 SF Mono,Menlo,monospace;padding:8px 10px;max-height:280px;overflow:auto;margin:0;overflow-wrap:anywhere;'
    const isImageFile = (name === 'Read' || name === 'Write') && filePath && IMAGE_EXTS.has((filePath.substring(filePath.lastIndexOf('.')).toLowerCase()))
    const imagePath = toolImagePath(block.name || '', inp) || (isImageFile ? filePath : '')
    const hasDetail = SPECIAL_TOOL_DETAILS.has(name) || !!genericInput || !!imagePath
    const result = block.id ? getResult?.(block.id) : undefined
    return <>
      <details style={{ margin: '3px 0', 'font-size': '11px', 'font-family': "'SF Mono', Menlo, monospace", 'border-top': '1px solid #ffffff0a' }}>
        <summary style={{ padding: '2px 0', cursor: hasDetail ? 'pointer' : 'default', 'list-style': hasDetail ? undefined : 'none', color: '#999' }}>
          {summary && <span class="execution-tool-intent">{summary}</span>}
          <span class="execution-tool-name" style={{ color }}>{name}</span>
        </summary>
        {name === 'Edit' && <>
          {inp.old_string && <pre style={`${pre}color:#e07070`}>{inp.old_string}</pre>}
          {inp.new_string && <pre style={`${pre}color:#5cc878`}>{inp.new_string}</pre>}
        </>}
        {name === 'Bash' && readableInput && <pre style={`${pre}color:#e5a070`} ref={(el) => linkifyRef(el, onImageClick, onOpenFile)}>{readableInput}</pre>}
        {name === 'Patch' && patchText(inp) && <pre style={`${pre}color:#c4993a`} ref={(el) => linkifyRef(el, onImageClick, onOpenFile)}>{patchText(inp).slice(0, 2000)}{patchText(inp).length > 2000 ? '\n…' : ''}</pre>}
        {name === 'Input' && <pre style={`${pre}color:#73b8ff`} ref={(el) => linkifyRef(el, onImageClick, onOpenFile)}>{stdinText(inp).replace(/\u0003/g, '^C') || '(empty stdin)'}{inp.session_id != null ? `\n\nsession: ${inp.session_id}` : ''}</pre>}
        {name === 'Write' && readableInput && <pre style={`${pre}color:#5cc878`} ref={(el) => linkifyRef(el, onImageClick, onOpenFile)}>{readableInput.slice(0, 2000)}{readableInput.length > 2000 ? '…' : ''}</pre>}
        {name === 'Agent' && <>
          {inp.subagent_type && <div style={{ padding: '2px 0', 'font-size': '10px', color: '#888' }}>Type: <span style={{ color: '#c4993a' }}>{inp.subagent_type}</span></div>}
          {inp.prompt && <pre style={`${pre}color:#88c4ff`} ref={(el) => linkifyRef(el, onImageClick, onOpenFile)}>{(inp.prompt as string).slice(0, 800)}{(inp.prompt as string).length > 800 ? '...' : ''}</pre>}
        </>}
        {name === 'Grep' && readableInput && <pre style={`${pre}color:#c4a0c0`}>{readableInput}</pre>}
        {name === 'Read' && readableInput && <pre style={`${pre}color:#88c4ff`} ref={(el) => linkifyRef(el, onImageClick, onOpenFile)}>{readableInput}</pre>}
        {genericInput && <pre style={`${pre}color:#aaa`} ref={(el) => linkifyRef(el, onImageClick, onOpenFile)}>{genericInput}</pre>}
      </details>
      {imagePath && (() => {
        const resolvedPath = imagePath.replace(/^~/, '/home/' + (typeof document !== 'undefined' ? document.querySelector<HTMLElement>('[data-username]')?.dataset.username || 'user' : 'user'))
        const imgSrc = appUrl(`/api/files/raw?path=${encodeURIComponent(resolvedPath)}`)
        const imageName = imagePath.split(/[\\/]/).pop() || imagePath
        return (
          <button type="button" aria-label={`Open ${imageName} full screen`} onClick={() => onImageClick?.(imgSrc)}
            style={{ background: 'none', border: 'none', padding: '0', margin: '0', display: 'block', cursor: 'zoom-in' }}>
            <img src={imgSrc} alt={`Preview of ${imageName}`} style={{ 'max-width': '100%', 'max-height': '300px', 'border-radius': '8px', 'margin-top': '6px', display: 'block', cursor: 'zoom-in' }} />
          </button>
        )
      })()}
      {result && renderBlock(result, onImageClick, onExpandTable, undefined, onOpenFile)}
    </>
  }
  // Orphaned tool_result (no matching tool_use in loaded messages) — render standalone
  if (block.type === 'tool_result') {
    const contentArr = Array.isArray(block.content) ? block.content : typeof block.content === 'string' ? [{ type: 'text', text: block.content }] : []
    const images = contentArr.filter((c: any) => c.type === 'image' && c.source?.data)
    const rawContent = contentArr.filter((c: any) => c.type !== 'image').map((c: any) => c.text || '').join('')
    const raw = stripAnsi(rawContent)
    const isErr = block.is_error
    const hasImages = images.length > 0
    const isLong = raw.length > 200
    const preview = raw.slice(0, 200)
    const lineCount = raw.split('\n').length
    const label = isErr ? 'error' : hasImages ? `image${images.length > 1 ? 's' : ''}` : `output${isLong ? ` (${lineCount} lines)` : ''}`
    return (
      <details style={{ margin: '2px 0', overflow: 'hidden' }} open={isErr || !isLong}>
        <summary style={{ padding: '1px 0', 'font-size': '9px', 'font-weight': '500', 'text-transform': 'uppercase', 'letter-spacing': '0.05em', color: isErr ? '#e07070' : '#777', cursor: isLong ? 'pointer' : 'default', 'list-style': isLong ? undefined : 'none' }}>
          {label}
          {isLong && !isErr && <span style={{ 'font-weight': '400', 'text-transform': 'none', 'margin-left': '6px', color: '#666' }}>{preview.split('\n')[0].slice(0, 60)}</span>}
        </summary>
        {raw && <div style={{ padding: '2px 0', 'font-size': '10px', 'font-family': "'SF Mono', Menlo, monospace", color: isErr ? '#e07070' : '#999', 'white-space': 'pre-wrap', 'max-height': '200px', overflow: 'auto', 'word-break': 'break-all' }} ref={(el) => linkifyRef(el, onImageClick, onOpenFile)}>{raw.length > 3000 ? raw.slice(0, 3000) + '\n... (truncated)' : raw}</div>}
      </details>
    )
  }
  return null
}

function formatTime(iso: string) {
  try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
  catch { return '' }
}
function formatDuration(durationMs?: number) {
  if (durationMs === undefined) return ''
  const seconds = Math.max(0, Math.round(durationMs / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

function executionStatusLabel(status: string) {
  if (status === 'error' || status === 'failed') return 'Failed'
  if (status === 'cancelled' || status === 'canceled' || status === 'aborted') return 'Canceled'
  if (status === 'success' || status === 'completed' || status === 'complete' || status === 'succeeded') return 'Success'
  if (status === 'running' || status === 'started' || status === 'working') return 'Running'
  return status || 'Idle'
}

function executionStatusColor(status: string) {
  const label = executionStatusLabel(status)
  if (label === 'Failed') return 'var(--error)'
  if (label === 'Success') return 'var(--success)'
  if (label === 'Running') return 'var(--info)'
  return 'var(--text-muted)'
}

function executionStatusMark(status: string) {
  const label = executionStatusLabel(status)
  if (label === 'Success') return '✓'
  if (label === 'Failed') return '!'
  if (label === 'Canceled') return '×'
  if (label === 'Running') return '●'
  return '○'
}

function executionValue(value: unknown) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) }
  catch { return String(value) }
}

function timelineToolPresentation(item: Extract<OmpTimelineItem, { kind: 'tool' }>) {
  const args = item.args && typeof item.args === 'object' && !Array.isArray(item.args) ? item.args as Record<string, unknown> : {}
  return toolPresentation(item.toolName, args)
}

function timelineActivityDescription(item: Extract<OmpTimelineItem, { kind: 'tool' }>) {
  const args = item.args && typeof item.args === 'object' && !Array.isArray(item.args) ? item.args as Record<string, unknown> : {}
  return activityDescription(item.toolName, args, item.intent)
}

function latestActivityDescription(scope: OmpWorkScope) {
  const latest = [...scope.timeline].reverse().find(item => item.status === 'running') || scope.timeline.at(-1)
  if (!latest) return ''
  return latest.kind === 'thinking' ? 'Reasoning' : timelineActivityDescription(latest)
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
  // Text is user-facing even when the same native OMP message also launches a
  // tool. renderMsg keeps the tool blocks in Activity while leaving
  // that text exposed in the conversation.
  return !hasText && (hasTool || hasThinking)
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
:root {
  --accent: #4aba6a; --accent-subtle: rgba(74,186,106,.12);
  --bg-base: #0d1117; --bg-secondary: #0d1117; --bg-surface: #11151c;
  --border-subtle: #222; --border-medium: #333;
  --text-primary: #e5e5e5; --text-secondary: #999; --text-muted: #777;
  --text-dim: #666; --text-faint: #555; --text-ghost: #444;
  --info: #73b8ff; --success: #4aba6a; --warning: #c4993a; --error: #e07070;
  --code-text: #c9d1d9; --hljs-keyword: #ff7b72; --hljs-string: #a5d6ff;
  --hljs-number: #79c0ff; --hljs-comment: #8b949e; --hljs-function: #d2a8ff;
  --hljs-builtin: #ffa657; --hljs-name: #7ee787; --hljs-addition: #aff5b4;
  --hljs-addition-bg: rgba(46,160,67,.15); --hljs-deletion: #ffdcd7;
  --hljs-deletion-bg: rgba(248,81,73,.15); --hljs-regexp: #f0883e;
  --hljs-property: #79c0ff;
}
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
  background: var(--code-bg); padding: 1px 5px; border-radius: 3px;
  font-family: 'SF Mono', Menlo, 'Courier New', monospace; font-size: 0.88em;
}
.markdown pre { margin: 8px 0; border-radius: 6px; overflow-x: hidden; background: #0d1117; padding: 10px 12px; position: relative; }
.markdown pre code { background: none; padding: 0; font-size: 0.85em; color: #c9d1d9; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
.code-nowrap .markdown pre { overflow-x: auto; }
.code-nowrap .markdown pre code { white-space: pre; overflow-wrap: normal; word-break: normal; }
.markdown pre.code-collapsed { max-height: 360px; overflow: hidden; }
.markdown pre.code-collapsed::after { content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 60px; background: linear-gradient(transparent, #0d1117); pointer-events: none; border-radius: 0 0 6px 6px; }
.code-expand-btn { display: block; width: 100%; padding: 4px 0; margin-top: -1px; background: #0d1117; border: 1px solid #333; border-top: none; border-radius: 0 0 6px 6px; color: #fab283; font-size: 0.75em; font-family: -apple-system, system-ui, sans-serif; cursor: pointer; text-align: center; transition: background-color 0.2s, color 0.2s; }
.code-expand-btn:hover { background: #161b22; color: #fcd9b8; }
.markdown blockquote {
  margin: 6px 0; padding: 4px 12px; border-left: 3px solid var(--text-faint); color: var(--text-secondary);
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
.feather-path { color: var(--link); text-decoration: none; cursor: pointer; }
.feather-path:hover { text-decoration: underline; }
.markdown img { max-width: 100%; border-radius: 6px; }
.markdown img.md-local-img { display: block; max-height: 400px; margin: 8px 0; object-fit: contain; }
.markdown hr { border: none; border-top: 1px solid #333; margin: 12px 0; }
.markdown strong { font-weight: 600; }

/* Execution details: quiet at rest, full fidelity on demand */
.work-log { width: 100%; margin: 0 0 4px; }
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

/* Message action buttons - show on hover */
.star-btn, .action-menu-btn { -webkit-tap-highlight-color: transparent; }
div:hover > div > .star-btn, div:hover > div > .action-menu-btn { opacity: 0.6 !important; }
.star-btn:hover, .action-menu-btn:hover { opacity: 1 !important; }

/* Code-block controls: dedicated toolbar above code, never overlaid on text */
.code-block-shell {
  margin: 8px 0;
  overflow: hidden;
  border: 1px solid #2a2f38;
  border-radius: 6px;
  background: #0d1117;
}
.markdown .code-block-shell > pre,
.markdown .code-block-shell .code-collapse-wrapper > pre {
  margin: 0;
  border-radius: 0;
}
.code-tools {
  display: flex; align-items: center; justify-content: flex-end; gap: 5px;
  min-height: 30px; padding: 4px 6px;
  border-bottom: 1px solid #2a2f38;
  background: #111720;
  font-family: -apple-system, system-ui, sans-serif;
}
.copy-btn {
  background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.15);
  color: var(--text-secondary); font-size: 11px; padding: 2px 8px; border-radius: 4px;
  cursor: pointer; transition: background 0.15s;
  font-family: inherit;
}
.copy-btn:hover { background: rgba(255,255,255,0.2); color: var(--text-primary); }
.code-wrap-control {
  display: inline-flex; align-items: center; gap: 3px;
  min-height: 22px; padding: 0 6px;
  border: 1px solid rgba(255,255,255,0.15); border-radius: 4px;
  background: rgba(13,17,23,0.92); color: var(--text-secondary);
  font-size: 11px; cursor: pointer; user-select: none;
}
.code-wrap-control:hover { background: rgba(255,255,255,0.1); color: var(--text-primary); }
.code-wrap-control input { width: 11px; height: 11px; margin: 0; accent-color: #fab283; cursor: pointer; }

/* Typing indicator bounce */
@keyframes typing-bounce {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
  30% { transform: translateY(-4px); opacity: 1; }
}

/* Star button - show on hover */
.star-btn { -webkit-tap-highlight-color: transparent; }
div:hover > div > .star-btn { opacity: 0.6 !important; }
.star-btn:hover { opacity: 1 !important; }
.msg-action { min-width: 28px; min-height: 28px; align-items: center; justify-content: center; border-radius: 5px !important; color: var(--text-secondary) !important; opacity: 1 !important; }
.msg-action:hover, .msg-action:focus-visible { color: var(--text-primary) !important; background: rgba(255,255,255,0.07) !important; }

/* Execution details: quiet at rest, full fidelity on demand */
.work-log { width: 100%; margin: 0 0 4px; }
.work-log > summary::-webkit-details-marker { display: none; }
.work-log-summary {
  display: flex; align-items: center; gap: 5px; width: max-content; min-height: 28px;
  padding: 0 2px; border: none; background: transparent; color: var(--text-faint);
  font-size: 11px; cursor: pointer; list-style: none; user-select: none;
  transition: color 120ms ease;
}
.work-log-summary:hover { color: var(--text-secondary); }
.work-log-summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
.work-log-chevron { display: inline-block; transition: transform 120ms ease; }
.work-log[open] .work-log-chevron { transform: rotate(90deg); }
.live-work-disclosure { width: 100%; min-width: 0; }
.live-work-disclosure .work-log { margin: 0; }
.live-work-disclosure .work-log-summary { width: 100%; min-height: 34px; }
.work-log-active { min-width: 0; flex: 0 1 auto; max-width: 75%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-primary); font-size: 12px; }
.work-log-live-dot { width: 7px; height: 7px; flex-shrink: 0; border-radius: 50%; background: var(--info); }
.work-log-live-dot.is-complete { background: var(--success); }
.work-log-live-dot.is-error { background: var(--error); }
.live-work-disclosure .work-log-detail { max-height: min(58vh, 520px); overflow: auto; margin-top: 2px; padding: 8px 10px; border: 0; border-top: 1px solid var(--border-subtle); border-radius: 0; background: transparent; }
.work-log-detail {
  margin-top: 6px; padding: 10px 12px; border: 1px solid var(--border-subtle);
  border-radius: 9px; background: var(--bg-secondary); font-size: 13px; line-height: 1.5;
}
.work-log-meta { margin-bottom: 8px; color: var(--text-ghost); font-size: 10px; }


/* OMP mirror: one quiet disclosure, then a bounded chronological run rail */
.execution-log { width: 100%; max-width: 960px; margin: 0 auto 10px; border: 1px solid var(--border-medium); border-radius: 10px; background: var(--bg-surface); overflow: hidden; }
.execution-log > summary::-webkit-details-marker, .execution-tool > summary::-webkit-details-marker { display: none; }
.execution-summary { display: flex; align-items: center; gap: 8px; min-height: 38px; padding: 0 12px; color: var(--text-secondary); cursor: pointer; list-style: none; user-select: none; }
.execution-summary:focus-visible, .execution-tool > summary:focus-visible, .agent-card:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.execution-title { flex-shrink: 0; font-size: 12px; font-weight: 700; }
.execution-active { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); font-size: 12px; }
.execution-chevron, .execution-tool-chevron { color: var(--text-faint); transition: transform 120ms ease; }
.execution-log[open] > .execution-summary .execution-chevron, .execution-tool[open] > summary .execution-tool-chevron { transform: rotate(90deg); }
.execution-detail { padding: 4px 12px 12px; border-top: 1px solid var(--border-subtle); }
.execution-meta { padding: 6px 0 8px; color: var(--text-faint); font-size: 10px; }
.execution-timeline { list-style: none; margin: 0; padding: 0; }
.execution-item { position: relative; min-width: 0; padding: 0 0 8px 18px; }
.execution-item:not(:last-child)::before { content: ''; position: absolute; left: 4px; top: 12px; bottom: -4px; width: 1px; background: var(--border-medium); }
.execution-node { position: absolute; left: 0; top: 9px; width: 9px; height: 9px; border: 2px solid var(--bg-surface); border-radius: 50%; background: currentColor; box-sizing: border-box; }
.execution-item[data-status='running'] .execution-card { border-color: var(--info); }
.execution-card { min-width: 0; border: 1px solid var(--border-subtle); border-radius: 8px; background: var(--bg-base); overflow: hidden; }
.execution-thinking { padding: 8px 10px; color: var(--text-secondary); font-size: 11px; line-height: 1.45; }
.execution-thinking-label { margin-bottom: 4px; color: var(--text-muted); font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }
.execution-tool > summary { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 38px; padding: 0 10px; cursor: pointer; list-style: none; }
.execution-tool-name { min-width: 0; max-width: 30%; flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); font: 500 10px 'SF Mono', Menlo, monospace; }
.execution-tool-intent { min-width: 0; flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-primary); font-size: 11px; font-weight: 600; }
.execution-payload { padding: 10px 12px; border-top: 1px solid var(--border-subtle); background: rgba(255,255,255,0.018); }
.execution-payload-label { margin-bottom: 6px; color: var(--text-muted); font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; }
.execution-payload pre { max-height: 280px; overflow: auto; margin: 0; padding: 8px 10px; border-radius: 6px; background: var(--bg-secondary); color: var(--text-primary); font: 11px/1.55 'SF Mono', Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.execution-status { flex-shrink: 0; color: currentColor; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; }
.omp-todo-status { position: sticky; top: 0; z-index: 4; display: flex; align-items: center; gap: 5px; width: 100%; max-width: 960px; min-height: 36px; margin: 0 auto 4px; padding: 0 11px; border: 1px solid var(--border-medium); border-radius: 10px; background: var(--bg-surface); box-shadow: 0 6px 18px var(--bg-base); color: var(--text-secondary); cursor: pointer; font-size: 12px; font-weight: 600; text-align: left; box-sizing: border-box; }
.omp-todo-status-active { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); font-weight: 500; }
.omp-todo-surface { max-width: 960px; overflow: visible; margin: 0 auto 10px; padding: 0 11px; border: 1px solid var(--border-medium); border-radius: 10px; background: var(--bg-surface); }
.omp-todo-surface > summary { padding: 8px 0; color: var(--text-secondary); cursor: pointer; font-size: 12px; font-weight: 600; }
.agent-surface { max-width: 938px; margin: 0 auto 10px; padding: 10px; border: 1px solid var(--border-medium); border-radius: 10px; background: var(--bg-surface); }
.agent-surface-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; color: var(--text-secondary); font-size: 12px; font-weight: 700; }
.agent-layout.is-open { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 12px; }
.agent-rail { display: flex; flex-wrap: wrap; gap: 8px; margin: 0; padding: 0; list-style: none; }
.agent-rail > li { display: flex; flex: 1 1 190px; min-width: 0; max-width: 260px; }
.agent-layout.is-open .agent-rail { align-content: start; }
.agent-layout.is-open .agent-rail > li { flex: none; width: 100%; max-width: none; }
.agent-card { width: 100%; min-width: 0; padding: 8px 10px; border: 1px solid var(--border-subtle); border-left: 3px solid currentColor; border-radius: 8px; background: var(--bg-base); color: var(--text-muted); cursor: pointer; text-align: left; }
.agent-card[aria-expanded='true'] { border-color: var(--accent); background: var(--accent-subtle); }
.agent-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.agent-card-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-primary); font-size: 11px; font-weight: 700; }
.agent-inspector { max-height: min(54vh, 560px); overflow-y: auto; padding-left: 12px; border-left: 1px solid var(--border-medium); }
.agent-inspector-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.agent-inspector-title { color: var(--text-primary); font-size: 13px; font-weight: 700; }
.agent-inspector-assignment { margin-top: 4px; color: var(--text-secondary); font-size: 11px; line-height: 1.4; }
.agent-inspector-meta { margin: 8px 0; color: var(--text-muted); font-size: 10px; line-height: 1.5; overflow-wrap: anywhere; }
.agent-inspector .execution-log { margin-bottom: 0; background: var(--bg-base); }
.agent-answer { margin-top: 10px; padding: 10px 12px; border-left: 2px solid var(--info); border-radius: 0 8px 8px 0; background: var(--bg-base); color: var(--text-primary); }
.agent-answer-label { margin-bottom: 5px; color: var(--text-muted); font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }
@media (max-width: 520px) {
  .execution-tool > summary { min-height: 44px; }
  .execution-tool-name { display: none; }
  .agent-layout.is-open { display: block; }
  .agent-rail > li { flex-basis: 100%; max-width: none; }
  .agent-inspector { max-height: none; overflow: visible; margin-top: 10px; padding: 10px 0 0; border-top: 1px solid var(--border-medium); border-left: none; }
}
.work-details { width: min(100%, 78ch); margin: 0 0 8px; color: var(--text-secondary); }
.work-details > .execution-detail { max-height: min(58vh, 520px); overflow: auto; }
.work-details > summary::-webkit-details-marker { display: none; }
.work-details > .execution-summary { min-height: 40px; padding: 0 11px; border: 1px solid var(--border-subtle); border-radius: 10px; background: var(--bg-surface); }
.work-details[open] > .execution-summary { border-radius: 10px 10px 0 0; border-bottom-color: transparent; }
.work-details[open] > .execution-summary .execution-chevron { transform: rotate(90deg); }
.work-details > .execution-detail { padding: 8px 10px; border: 1px solid var(--border-subtle); border-top: 0; border-radius: 0 0 10px 10px; background: var(--bg-surface); }
.work-details .execution-item { padding: 0 0 2px 14px; }
.work-details .execution-item:not(:last-child)::before { left: 3px; top: 14px; bottom: -2px; background: var(--border-subtle); }
.work-details .execution-node { left: 0; top: 12px; width: 7px; height: 7px; border: 0; }
.work-details .execution-card { border: 0; border-radius: 6px; background: transparent; }
.work-details .execution-item[data-status='running'] .execution-card { border: 0; background: rgba(96, 165, 250, 0.05); }
.work-details .execution-tool > summary { min-height: 32px; padding: 0 6px; }
.work-details .execution-payload { margin: 0 6px 4px; border: 1px solid var(--border-subtle); border-radius: 6px; background: var(--bg-base); }
.work-details .omp-todo-surface { margin: 0 0 5px; padding: 0 6px; border: 0; border-radius: 6px; background: transparent; }
.work-details .agent-surface { margin: 5px 0; padding: 6px; border: 0; border-radius: 6px; background: transparent; }
.work-details .agent-card { padding: 6px 8px; border: 0; border-left: 2px solid currentColor; border-radius: 5px; background: transparent; }
.work-details .agent-card[aria-expanded='true'] { border-color: var(--accent); background: rgba(255,255,255,0.025); }
.work-details .execution-status { font-weight: 650; text-transform: none; letter-spacing: 0; }
.work-details .execution-title { color: var(--text-muted); font-weight: 600; }
.work-details .execution-active { flex: 0 1 auto; max-width: 75%; color: var(--text-primary); }
.work-details .execution-status { margin-left: 2px; }
.thinking-indicator { display: flex; align-items: center; gap: 8px; width: fit-content; max-width: min(100%, 78ch); min-height: 44px; margin: 0 0 10px; padding: 10px 14px; box-sizing: border-box; border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; background: #1e1e1e; color: var(--text-secondary); font-size: 13px; line-height: 1.45; }
.thinking-indicator-dot { width: 7px; height: 7px; flex-shrink: 0; border-radius: 50%; background: var(--info); animation: typing-bounce 1.2s ease-in-out infinite; }
/* highlight.js theme — uses CSS variables for theme switching */
.hljs { color: var(--code-text); }
.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-section, .hljs-link { color: var(--hljs-keyword); }
.hljs-function .hljs-keyword { color: var(--hljs-keyword); }
.hljs-string, .hljs-attr { color: var(--hljs-string); }
.hljs-number, .hljs-meta { color: var(--hljs-number); }
.hljs-comment, .hljs-quote { color: var(--hljs-comment); font-style: italic; }
.hljs-title, .hljs-title.function_ { color: var(--hljs-function); }
.hljs-built_in { color: var(--hljs-builtin); }
.hljs-type, .hljs-class .hljs-title { color: var(--hljs-builtin); }
.hljs-variable, .hljs-template-variable { color: var(--hljs-builtin); }
.hljs-name { color: var(--hljs-name); }
.hljs-selector-class { color: var(--hljs-name); }
.hljs-addition { color: var(--hljs-addition); background: var(--hljs-addition-bg); }
.hljs-deletion { color: var(--hljs-deletion); background: var(--hljs-deletion-bg); }
.hljs-regexp, .hljs-symbol { color: var(--hljs-regexp); }
.hljs-params { color: var(--code-text); }
.hljs-property { color: var(--hljs-property); }
`

const RICH_MARKDOWN_STYLE_ID = 'feather-rich-markdown-styles'

function ensureRichMarkdownStyles() {
  if (document.getElementById(RICH_MARKDOWN_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = RICH_MARKDOWN_STYLE_ID
  style.textContent = markdownCSS
  document.head.appendChild(style)
}

export function RichMarkdown(props: { text: string; onOpenFile?: (path: string) => void; allowRemoteImages?: boolean }) {
  const [lightbox, setLightbox] = createSignal<string | null>(null)
  const [expandedTable, setExpandedTable] = createSignal<string | null>(null)
  let markdownElement: HTMLDivElement | undefined

  createEffect(() => {
    const text = props.text
    const allowRemoteImages = props.allowRemoteImages !== false
    queueMicrotask(() => {
      if (!markdownElement || props.text !== text || (props.allowRemoteImages !== false) !== allowRemoteImages) return
      enhanceMarkdown(markdownElement, setLightbox, setExpandedTable, props.onOpenFile)
    })
  })

  return <>
    <div
      class="markdown"
      onClick={handleCopyClick}
      innerHTML={renderRichMarkdown(props.text, props.allowRemoteImages !== false)}
      ref={(element) => { ensureRichMarkdownStyles(); markdownElement = element }}
    />
    <Show when={expandedTable()}>
      <div class="md-table-modal" role="dialog" aria-modal="true" aria-label="Expanded table" onClick={(event) => event.stopPropagation()}>
        <div class="md-table-modal-bar">
          <span>Table</span>
          <button aria-label="Close expanded table" onClick={() => setExpandedTable(null)} style={{ background: 'none', border: 'none', color: '#e5e5e5', 'font-size': '24px', cursor: 'pointer', padding: '2px 8px' }}>&times;</button>
        </div>
        <div class="md-table-modal-body" innerHTML={expandedTable()!} ref={(element) => queueMicrotask(() => { fixLinks(element, setLightbox, props.onOpenFile); fixImages(element, setLightbox) })} />
      </div>
    </Show>
    <Show when={lightbox()}>
      <div onClick={(event) => { event.stopPropagation(); setLightbox(null) }} style={{ position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.85)', 'z-index': '200', display: 'flex', 'align-items': 'center', 'justify-content': 'center', cursor: 'zoom-out' }}>
        <img src={lightbox()!} style={{ 'max-width': '95vw', 'max-height': '95vh', 'object-fit': 'contain', 'border-radius': '8px' }} />
      </div>
    </Show>
  </>
}

// ── Component ───────────────────────────────────────────────────────────────

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
  assistantStream?: { text: string; ended: boolean } | null
  work?: OmpWorkScope | null
  todo?: OmpTodoSnapshot | null
  notice?: { kind: string; text: string } | null
  approval?: { toolName: string; approvalMode: string; reason?: string } | null
  subagents?: OmpSubagentState[]
  jobs?: MessageViewJob[]
  runtime?: MessageViewRuntime | null
  scrollRefCb?: (el: HTMLDivElement) => void
  sessionId?: string | null
  protocolRuns?: ProtocolRunSnapshot[]
  onOpenFile?: (path: string) => void
  highLevel?: boolean
  onOpenAgentHub?: () => void
}

export function MessageView(props: MessageViewProps) {
  const [lightbox, setLightbox] = createSignal<string | null>(null)
  const [pdfViewer, setPdfViewer] = createSignal<string | null>(null)
  const [expandedTable, setExpandedTable] = createSignal<string | null>(null)
  const [selectedSubagentId, setSelectedSubagentId] = createSignal<string | null>(null)
  const [parentTodoOpen, setParentTodoOpen] = createSignal(true)
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


  const selectedSubagent = createMemo(() => {
    const selectedId = selectedSubagentId()
    return selectedId ? (props.subagents || []).find(agent => agent.id === selectedId) || null : null
  })

  createEffect(() => {
    const selectedId = selectedSubagentId()
    if (selectedId && !(props.subagents || []).some(agent => agent.id === selectedId)) setSelectedSubagentId(null)
  })

  let todoWasWorking = !!props.working
  createEffect(() => {
    const working = !!props.working
    if (working && !todoWasWorking) setParentTodoOpen(true)
    todoWasWorking = working
  })

  function renderTodo(todo: () => OmpTodoSnapshot, testId: string, sticky: boolean) {
    const taskList = () => (
      <div style={{ padding: '0 0 9px' }}>
        <For each={todo().phases}>{(phase) => (
          <div style={{ 'margin-top': '7px' }}>
            <div style={{ color: 'var(--text-muted)', 'font-size': '10px', 'font-weight': '700', 'text-transform': 'uppercase', 'letter-spacing': '0.06em', 'margin-bottom': '3px' }}>{phase.name}</div>
            <For each={phase.tasks}>{(task) => (
              <div style={{ display: 'flex', gap: '7px', padding: '2px 0', color: task.status === 'completed' ? 'var(--text-dim)' : task.status === 'in_progress' ? 'var(--text-primary)' : 'var(--text-secondary)', 'font-size': '11px', 'text-decoration': task.status === 'abandoned' ? 'line-through' : 'none' }}>
                <span style={{ color: task.status === 'completed' ? 'var(--success)' : task.status === 'in_progress' ? 'var(--accent)' : task.status === 'blocked' ? 'var(--warning)' : 'var(--text-faint)', width: '12px', 'flex-shrink': '0' }}>
                  {task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '●' : task.status === 'blocked' ? '!' : task.status === 'abandoned' ? '×' : '○'}
                </span>
                <span>
                  {task.content}
                  <Show when={task.blocker}><span style={{ display: 'block', color: 'var(--warning)', 'font-size': '10px', 'margin-top': '2px' }}>{task.blocker}</span></Show>
                </span>
              </div>
            )}</For>
          </div>
        )}</For>
      </div>
    )
    if (sticky) {
      return (
        <>
          <button type="button" data-testid={testId} class="omp-todo-status" aria-expanded={parentTodoOpen()} onClick={() => setParentTodoOpen(open => !open)}>
            <span>{parentTodoOpen() ? '▾' : '›'} Todo · {todo().completed}/{todo().total}</span>
            <Show when={todo().active}><span class="omp-todo-status-active">· {todo().active}</span></Show>
          </button>
          <Show when={parentTodoOpen()}>
            <div data-testid={`${testId}-body`} class="omp-todo-surface">{taskList()}</div>
          </Show>
        </>
      )
    }
    return (
      <details data-testid={testId} open class="omp-todo-surface">
        <summary>
          Todo · {todo().completed}/{todo().total}
          <Show when={todo().active}><span style={{ color: 'var(--text-muted)', 'font-weight': '400' }}> · {todo().active}</span></Show>
        </summary>
        {taskList()}
      </details>
    )
  }

  function ExecutionEntry(entryProps: { item: OmpTimelineItem }) {
    const thinking = createMemo(() => entryProps.item.kind === 'thinking' ? entryProps.item : null)
    const tool = createMemo(() => entryProps.item.kind === 'tool' ? entryProps.item : null)
    const presentation = createMemo(() => tool() ? timelineToolPresentation(tool()!) : null)
    const description = createMemo(() => tool() ? timelineActivityDescription(tool()!) : '')
    const input = createMemo(() => tool() ? toolInputDisplay(tool()!.toolName, tool()!.args) : '')
    const output = createMemo(() => toolOutputDisplay(tool()?.result !== undefined ? tool()?.result : tool()?.partialResult))
    return (
      <li class="execution-item" style={{ color: executionStatusColor(entryProps.item.status) }} data-status={entryProps.item.status}>
        <span class="execution-node" aria-hidden="true" />
        <Show when={thinking()} fallback={
          <details class="execution-card execution-tool" open={tool()?.status === 'error'} data-testid="omp-tool-card" data-tool-call-id={tool()?.toolCallId} data-status={tool()?.status}>
            <summary>
              <span class="execution-tool-intent">{description()}</span>
              <span class="execution-tool-name">{presentation()?.name || tool()?.toolName}</span>
              <span class="execution-tool-chevron" aria-hidden="true">›</span>
              <span class="execution-status">{executionStatusMark(tool()?.status || '')} {executionStatusLabel(tool()?.status || '')}</span>
            </summary>
            <Show when={input()}>
              <div class="execution-payload">
                <div class="execution-payload-label">Input</div>
                <pre ref={(element) => linkifyRef(element, setLightbox, props.onOpenFile)}>{input().slice(0, 3000)}{input().length > 3000 ? '\n… (truncated)' : ''}</pre>
              </div>
            </Show>
            <Show when={output()}>
              <div class="execution-payload">
                <div class="execution-payload-label">{tool()?.result !== undefined ? 'Output' : 'Live output'}</div>
                <pre ref={(element) => linkifyRef(element, setLightbox, props.onOpenFile)}>{output().slice(0, 3000)}{output().length > 3000 ? '\n… (truncated)' : ''}</pre>
              </div>
            </Show>
          </details>
        }>
          <article class="execution-card execution-thinking" data-testid="omp-thinking-step">
            <div class="execution-thinking-label">Reasoning · {executionStatusMark(thinking()?.status || '')} {executionStatusLabel(thinking()?.status || '')}</div>
            <div class="markdown" innerHTML={renderLiveMarkdown(thinking()?.text || '')} ref={(element) => queueMicrotask(() => enhanceMarkdown(element, setLightbox, openExpandedTable, props.onOpenFile))} />
          </article>
        </Show>
      </li>
    )
  }

  function hideParentOrchestration(item: OmpTimelineItem) {
    if (item.kind !== 'tool') return false
    const name = item.toolName.toLowerCase()
    if (name === 'task') return true
    if (name !== 'hub' || !item.args || typeof item.args !== 'object' || Array.isArray(item.args)) return false
    const op = String((item.args as Record<string, unknown>).op || '').toLowerCase()
    return op === 'wait' || op === 'jobs' || op === 'inbox' || op === 'list'
  }

  function renderTimelineItems(timeline: () => OmpTimelineItem[]) {
    return (
      <ol class="execution-timeline">
        <Index each={timeline()}>{(item) => <ExecutionEntry item={item()} />}</Index>
      </ol>
    )
  }

  function renderExecutionTimeline(scope: () => OmpWorkScope, testId: string, inspector = false) {
    const visibleTimeline = createMemo(() => inspector ? scope().timeline : scope().timeline.filter(item => !hideParentOrchestration(item)))
    const visibleScope = () => ({ ...scope(), timeline: visibleTimeline() })
    const summary = () => latestActivityDescription(visibleScope())
    let executionDetails: HTMLDetailsElement | undefined
    let renderedSegment = scope().segment
    createEffect(() => {
      const segment = scope().segment
      if (!inspector && executionDetails && segment !== renderedSegment) executionDetails.open = false
      renderedSegment = segment
    })
    if (inspector) {
      return (
        <section class="execution-log" data-testid={testId} aria-label="Agent execution timeline">
          <div class="execution-summary">
            <span class="execution-title">Execution</span>
            <span class="execution-active">{summary() || `${visibleTimeline().length} steps`}</span>
            <span class="execution-status" style={{ color: executionStatusColor(scope().runStatus) }}>{executionStatusMark(scope().runStatus)} {executionStatusLabel(scope().runStatus)}</span>
          </div>
          <div class="execution-detail">
            <div class="execution-meta">{visibleTimeline().length} chronological step{visibleTimeline().length === 1 ? '' : 's'}</div>
            {renderTimelineItems(visibleTimeline)}
          </div>
        </section>
      )
    }
    return (
      <Show when={visibleTimeline().length > 0}>
        <details ref={executionDetails} class="execution-log" data-testid={testId} data-segment={scope().segment}>
          <summary class="execution-summary" data-testid={`${testId}-summary`}>
            <span class="execution-chevron">›</span>
            <span class="execution-title">Execution</span>
            <span class="execution-active">{summary() || `${visibleTimeline().length} steps`}</span>
            <span class="execution-status" style={{ color: executionStatusColor(scope().runStatus) }}>{executionStatusMark(scope().runStatus)} {executionStatusLabel(scope().runStatus)}</span>
          </summary>
          <div class="execution-detail">
            <div class="execution-meta">{visibleTimeline().length} chronological step{visibleTimeline().length === 1 ? '' : 's'}</div>
            {renderTimelineItems(visibleTimeline)}
          </div>
        </details>
      </Show>
    )
  }
  function renderWorkAuxiliarySurfaces() {
    return (
      <>

      <Show when={(props.subagents?.length || 0) > 0}>
        <section data-testid="omp-subagents" class="agent-surface" aria-label="Subagents">
          <div class="agent-surface-heading">
            <span>Agents</span>
            <span style={{ color: 'var(--text-muted)', 'font-size': '10px', 'font-weight': '600' }}>
              {(props.subagents || []).filter(agent => executionStatusLabel(agent.status) === 'Running').length} running
            </span>
          </div>
          <div class={`agent-layout${selectedSubagent() ? ' is-open' : ''}`}>
            <ul class="agent-rail">
              <For each={props.subagents || []}>{(agent) => (
                <li>
                  <button
                    type="button"
                    id={`omp-subagent-${agent.id}`}
                    data-testid={`omp-subagent-${agent.id}`}
                    class="agent-card"
                    style={{ color: executionStatusColor(agent.status) }}
                    aria-expanded={selectedSubagentId() === agent.id}
                    aria-controls={selectedSubagentId() === agent.id ? `omp-subagent-inspector-${agent.id}` : undefined}
                    onClick={() => setSelectedSubagentId(current => current === agent.id ? null : agent.id)}
                  >
                    <span class="agent-card-head">
                      <span class="agent-card-name">{agent.agent}</span>
                      <span class="execution-status">{executionStatusMark(agent.status)} {executionStatusLabel(agent.status)}</span>
                    </span>
                  </button>
                </li>
              )}</For>
            </ul>
            <Show when={selectedSubagent()}>
              {(agent) => (
                <section id={`omp-subagent-inspector-${agent().id}`} data-testid="omp-subagent-inspector" class="agent-inspector" aria-label={`${agent().agent} inspector`}>
                  <div class="agent-inspector-head">
                    <div style={{ 'min-width': '0' }}>
                      <div class="agent-inspector-title">
                        {agent().agent}
                        <Show when={agent().agentSource}><span style={{ color: 'var(--text-muted)', 'font-size': '10px', 'font-weight': '500' }}> · {agent().agentSource}</span></Show>
                      </div>
                      <div class="agent-inspector-assignment">{agent().assignment || agent().task || agent().description || 'Waiting for assignment'}</div>
                    </div>
                    <span class="execution-status" style={{ color: executionStatusColor(agent().status) }}>{executionStatusMark(agent().status)} {executionStatusLabel(agent().status)}</span>
                  </div>
                  <div class="agent-inspector-meta">
                    <div>Model · {agent().resolvedModel || 'Resolving'}</div>
                    <div>
                      Elapsed · {formatDuration(agent().durationMs) || '—'}
                      {' · '}Usage · {[
                        agent().requests !== undefined ? `${agent().requests} requests` : '',
                        agent().toolCount !== undefined ? `${agent().toolCount} steps` : '',
                        agent().tokens !== undefined ? `${agent().tokens!.toLocaleString()} tokens` : '',
                      ].filter(Boolean).join(' · ') || 'pending'}
                    </div>
                    <Show when={agent().sessionFile}><div>Session · {agent().sessionFile}</div></Show>
                  <Show when={props.onOpenAgentHub}>
                    <button type="button" data-testid="open-agent-hub" onClick={() => props.onOpenAgentHub?.()}
                      style={{ margin: '8px 0 2px', background: 'var(--bg-secondary)', border: '1px solid var(--border-medium)', color: 'var(--link)', padding: '6px 10px', 'border-radius': '6px', 'font-size': '11px', 'font-weight': '650', cursor: 'pointer' }}>
                      Open Agent Hub to steer
                    </button>
                  </Show>
                  </div>
                  <Show when={agent().assistantText}>
                    <section class="agent-answer" data-testid="omp-subagent-answer" aria-live={agent().assistantEnded ? 'off' : 'polite'}>
                      <div class="agent-answer-label">Answer{agent().assistantEnded ? '' : ' · streaming'}</div>
                      <div class="markdown" innerHTML={renderLiveMarkdown(agent().assistantText)} ref={(element) => queueMicrotask(() => enhanceMarkdown(element, setLightbox, openExpandedTable, props.onOpenFile))} />
                    </section>
                  </Show>
                  <Show when={agent().todo}>
                    {renderTodo(() => agent().todo!, 'omp-subagent-todo')}
                  </Show>
                  <Show when={agent().timeline.length > 0} fallback={<div style={{ padding: '10px 0', color: 'var(--text-muted)', 'font-size': '11px' }}>Waiting for the first execution step.</div>}>
                    {renderExecutionTimeline(() => agent(), 'omp-subagent-execution', true)}
                  </Show>
                </section>
              )}
            </Show>
          </div>
        </section>
      </Show>

      <Show when={(props.jobs || []).some(job => job.status === 'running')}>
        <details data-testid="omp-jobs" style={{ margin: '0 0 10px', padding: '0 11px', 'border-radius': '10px', border: '1px solid var(--border-subtle)', background: 'var(--bg-surface)' }}>
          <summary style={{ padding: '7px 0', cursor: 'pointer', color: 'var(--text-muted)', 'font-size': '11px' }}>
            Background jobs · {(props.jobs || []).filter(job => job.status === 'running').length} running
          </summary>
          <div style={{ padding: '0 0 7px' }}>
            <For each={(props.jobs || []).filter(job => job.status === 'running')}>{(job) => (
              <div style={{ display: 'flex', 'justify-content': 'space-between', gap: '8px', padding: '3px 0', color: 'var(--text-muted)', 'font-size': '10px' }}>
                <span>{job.label || job.type}</span><span>{job.status}</span>
              </div>
            )}</For>
          </div>
        </details>
      </Show>
      </>
    )
  }
  const todoNeedsAttention = () => !!props.todo
    && ((props.todo.active || '') !== '' || props.todo.completed < props.todo.total)
  function renderParentExecution(scope: () => OmpWorkScope) {
    const timeline = createMemo(() => scope().timeline.filter(isParentActivity))
    const visibleScope = () => ({ ...scope(), timeline: timeline() })
    const runningSubagent = () => (props.subagents || []).find(agent => executionStatusLabel(agent.status) === 'Running')
    const activityId = () => `${props.sessionId || 'session'}:native:${scope().invocationId}`
    const runningJobs = () => (props.jobs || []).filter(job => job.status === 'running')
    const runningJob = () => runningJobs()[0]
    const activityStatus = () => scope().runStatus === 'running' || runningSubagent() || runningJob() ? 'running' : scope().runStatus
    const actionCount = () => timeline().length + (props.subagents?.length || 0) + runningJobs().length
    const latestDescription = () => latestActivityDescription(visibleScope())
    const summary = () => {
      if (activityStatus() === 'running') {
        return latestDescription()
          || props.todo?.active
          || runningSubagent()?.assignment
          || runningSubagent()?.task
          || runningJob()?.label
          || runningJob()?.type
          || 'In progress'
      }
      if (latestDescription()) {
        return actionCount() > 1 ? `${latestDescription()} · ${actionCount()} actions` : latestDescription()
      }
      if (actionCount() > 0) return `${actionCount()} action${actionCount() === 1 ? '' : 's'}`
      if ((props.todo?.total || 0) > 0) return `${props.todo!.completed}/${props.todo!.total} planned`
      return 'Complete'
    }
    const hasWork = () => timeline().length > 0 || todoNeedsAttention() || (props.subagents?.length || 0) > 0 || (props.jobs || []).some(job => job.status === 'running')
    return (
      <Show when={hasWork()}>
        <details
          class="work-details"
          data-testid="omp-parent-execution"
          data-segment={scope().segment}
          data-activity-id={activityId()}
          open={openWorkLogs().has(activityId())}
          onToggle={(event) => rememberWorkLogOpen(activityId(), event.currentTarget.open)}
        >
          <summary class="execution-summary" data-testid="omp-parent-execution-summary">
            <span class="execution-chevron">›</span>
            <span class="execution-title">Activity</span>
            <span class="execution-active">{summary()}</span>
            <span class="execution-status" aria-label={executionStatusLabel(activityStatus())} title={executionStatusLabel(activityStatus())} style={{ color: executionStatusColor(activityStatus()) }}>{executionStatusMark(activityStatus())}</span>
          </summary>
          <div class="execution-detail">
            <Show when={todoNeedsAttention()}>{renderTodo(() => props.todo!, 'omp-todo')}</Show>
            <Show when={timeline().length > 0}>
              <div data-testid="omp-parent-execution-timeline">{renderTimelineItems(timeline)}</div>
            </Show>
            {renderWorkAuxiliarySurfaces()}
          </div>
        </details>
      </Show>
    )
  }


  let scrollRef: HTMLDivElement | undefined
  let assistantStreamMarkdownRef: HTMLDivElement | undefined
  const [pinned, setPinned] = createSignal(true)
  const [newMsgCount, setNewMsgCount] = createSignal(0)
  const [actionMenu, setActionMenu] = createSignal<string | null>(null)
  const [actionFeedback, setActionFeedback] = createSignal<string | null>(null)
  const [openWorkLogs, setOpenWorkLogs] = createSignal<Set<string>>(new Set())
  function rememberWorkLogOpen(id: string, open: boolean) {
    setOpenWorkLogs(current => {
      if (current.has(id) === open) return current
      const next = new Set(current)
      if (open) next.add(id)
      else next.delete(id)
      return next
    })
  }
  let openWorkLogScope = props.sessionId
  createEffect(() => {
    if (props.sessionId === openWorkLogScope) return
    openWorkLogScope = props.sessionId
    setOpenWorkLogs(new Set())
  })
  let prevMsgLen = props.messages.length
  let prevStreamText = props.assistantStream?.text || ''
  let prevWork = props.work
  let prevSubagents = props.subagents

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
    const work = props.work
    const subagents = props.subagents
    const delta = len - prevMsgLen
    const streamChanged = streamText !== prevStreamText
    const liveSurfaceChanged = work !== prevWork || subagents !== prevSubagents
    prevMsgLen = len
    prevStreamText = streamText
    prevWork = work
    prevSubagents = subagents
    if (!untrack(pinned) && delta > 0) {
      setNewMsgCount(c => c + delta)
    }
    if (untrack(pinned) && (streamChanged || liveSurfaceChanged)) requestAnimationFrame(pinSync)
  })

  createEffect(() => {
    const streamText = props.assistantStream?.text || ''
    if (!streamText) return
    queueMicrotask(() => {
      if (!assistantStreamMarkdownRef || props.assistantStream?.text !== streamText) return
      enhanceMarkdown(assistantStreamMarkdownRef, (src) => setLightbox(src), openExpandedTable, props.onOpenFile)
    })
  })

  // Reset delta counter on session switch so a new session's load doesn't
  // get interpreted as a huge burst of "new messages since last time".
  createEffect(on(() => props.sessionId, () => {
    prevMsgLen = props.messages.length
    prevStreamText = props.assistantStream?.text || ''
    prevWork = props.work
    prevSubagents = props.subagents
    setNewMsgCount(0)
    setPinned(true)
    setOpenWorkLogs(new Set())
    setSelectedSubagentId(null)
  }, { defer: true }))

  // ResizeObserver is the single pin writer — it catches every size change
  // (collapse/expand, image load, typing indicator growth, new message) and
  // runs after layout, before paint, in the same frame as the size change.
  // Setting scrollTop directly here lands before the next paint.
  let contentRef: HTMLDivElement | undefined
  onMount(() => {
    let enabled = true
    try {
      enabled = window.localStorage.getItem(CODE_WRAP_STORAGE_KEY) !== 'false'
    } catch {}
    applyCodeWrap(enabled, false)
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
  const mirroredThinking = createMemo(() => {
    const texts = new Set<string>()
    for (const item of props.work?.timeline || []) {
      if (item.kind === 'thinking' && item.text) texts.add(item.text)
    }
    return texts
  })
  function isActivityBlock(block: ContentBlock) {
    return (block.type === 'thinking' && !!block.thinking && !mirroredThinking().has(block.thinking))
      || block.type === 'tool_result'
      || (block.type === 'tool_use' && !isQuestionBlock(block))
  }
  function messageHasActivity(message: Message) {
    return (message.content || []).some(isActivityBlock)
  }
  function messagesHaveActivity(messages: Message[]) {
    return messages.some(messageHasActivity)
  }
  function isParentActivity(item: OmpTimelineItem) {
    return item.kind === 'tool' && !hideParentOrchestration(item)
  }
  const renderItems = createMemo(() => buildRenderItems(props.messages, isPureToolResultMsg))
  const hasCurrentWork = createMemo(() => !!props.work && (
    props.work.timeline.some(isParentActivity) ||
    todoNeedsAttention() ||
    (props.subagents?.length || 0) > 0 ||
    (props.jobs || []).some(job => job.status === 'running')
  ))
  const liveLegacyWork = createMemo(() => {
    const latest = renderItems().at(-1)
    return props.working && !hasCurrentWork() && latest?.kind === 'chain' && messagesHaveActivity(latest.messages)
  })
  const workAttachedToAnswer = createMemo(() => {
    if (!hasCurrentWork()) return false
    const latest = renderItems().at(-1)
    return !!latest && latest.kind !== 'chain' && latest.msg.role === 'assistant'
  })
  const currentProtocolOwnsWork = createMemo(() => {
    const latestUser = [...props.messages].reverse().find(message => message.role === 'user')
    return !!latestUser && runsForInvocation(props.protocolRuns || [], latestUser.uuid).length > 0
  })

  function renderWorkLog(messages: Message[], live = false) {
    // buildRenderItems returns fresh wrapper objects as a turn grows. Native
    // <details> state would therefore reset whenever a later SSE update
    // replaced the DOM node. The first trace message is stable for the life of
    // the execution chain, so keep the user's disclosure choice against it.
    const disclosureKey = `${props.sessionId || 'session'}:${messages[0]?.uuid || messages[0]?.timestamp || 'work-log'}`
    const blocks = messages.flatMap(message => message.content || [])
    const last = messages.at(-1)
    const traceBlocks = blocks.filter(isActivityBlock)
    const renderedToolUseIds = new Set(traceBlocks.filter(block => block.type === 'tool_use' && block.id).map(block => block.id!))
    const errorCount = traceBlocks.filter(block =>
      block.type === 'tool_result' ? !!block.is_error && (!block.tool_use_id || !renderedToolUseIds.has(block.tool_use_id)) :
      block.type === 'tool_use' && block.id ? !!getResult(block.id)?.is_error : false
    ).length
    const toolUses = traceBlocks.filter(block => block.type === 'tool_use')
    const reasoning = traceBlocks.filter(block => block.type === 'thinking' && block.thinking)
    const summary = live && props.statusText
      ? props.statusText
      : props.highLevel
        ? ''
        : toolUses.length > 0
          ? activityDescription(toolUses.at(-1)?.name || '', toolUses.at(-1)?.input || {}, toolUses.at(-1)?.intent || '')
          : ''
    return <details class="work-log" data-activity-id={disclosureKey} open={openWorkLogs().has(disclosureKey)} onToggle={(event) => {
      rememberWorkLogOpen(disclosureKey, event.currentTarget.open)
    }}>
      <summary class="work-log-summary" data-testid="work-log-summary">
        <span class="work-log-chevron">›</span>
        <span style={{ color: 'var(--text-muted)', 'font-weight': '600' }}>Activity</span>
        <Show when={summary}><span class="work-log-active">{summary}</span></Show>
        <Show when={errorCount > 0} fallback={
          <span
            class="work-log-live-dot"
            classList={{ 'is-complete': !live }}
            aria-label={live ? 'Running' : 'Complete'}
          />
        }>
          <span class="work-log-issue"><span class="work-log-issue-dot" />{errorCount} issue{errorCount === 1 ? '' : 's'}</span>
        </Show>
      </summary>
      <div class="work-log-detail" data-testid="work-log-detail">
        <div class="work-log-meta">
          {toolUses.length} action{toolUses.length === 1 ? '' : 's'}
          {reasoning.length > 0 ? ` · ${reasoning.length} reasoning` : ''}
          {' · '}{formatTime(last?.timestamp || '')}
        </div>
        <For each={traceBlocks}>{(block) => {
          if (block.type === 'tool_result' && block.tool_use_id && renderedToolUseIds.has(block.tool_use_id)) return null
          return renderBlock(block, (src) => setLightbox(src), openExpandedTable, getResult, props.onOpenFile)
        }}</For>
      </div>
    </details>
  }

  const renderMsg = (msg: Message, trace: Message[] = [], suppressWork = false) => {
    const textBlock = msg.content?.find(b => b.type === 'text' && b.text)
    const { cleanText, images, files } = msg.passive
      ? { cleanText: textBlock?.text || '', images: [], files: [] }
      : textBlock?.text
        ? extractImages(textBlock.text)
        : { cleanText: textBlock?.text || '', images: [], files: [] }
    const hasImages = images.length > 0
    const hasFiles = files.length > 0
    const hasAttachments = hasImages || hasFiles
    const inlineTraceBlocks = msg.role === 'assistant' && !suppressWork
      ? (msg.content || []).filter(isActivityBlock)
      : []
    const workLogMessages = inlineTraceBlocks.length > 0 ? [...trace, { ...msg, content: inlineTraceBlocks }] : trace

    return <div class="msg-row" style={{ display: 'flex', 'flex-direction': 'column', 'align-items': msg.role === 'user' ? 'flex-end' : 'flex-start', 'margin-bottom': '10px' }}>
      <div class={msg.role === 'assistant' ? 'asst-bubble' : undefined} data-uuid={msg.uuid} data-role={msg.role} style={{
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
          <a href={localFileHref(f.path)} target={props.onOpenFile ? undefined : '_blank'} rel={props.onOpenFile ? undefined : 'noopener'} onClick={(event) => { if (props.onOpenFile) { event.preventDefault(); event.stopPropagation(); props.onOpenFile(f.path); return } if (f.name.toLowerCase().endsWith('.pdf')) { event.preventDefault(); setPdfViewer(localFileHref(f.path)) } }} style={{ display: 'flex', 'align-items': 'center', gap: '6px', padding: '6px 10px', margin: '2px 0', background: 'rgba(255,255,255,0.05)', 'border-radius': '8px', 'text-decoration': 'none', color: '#73b8ff', 'font-size': '12px' }}>
            <span style={{ 'font-size': '16px' }}>{f.name.endsWith('.pdf') ? '\uD83D\uDCC4' : '\uD83D\uDCCE'}</span>
            <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{f.name}</span>
          </a>
        )}</For>
        <div style={hasAttachments ? { padding: '4px 8px 4px' } : {}}>
          <Show when={msg.role === 'assistant' && workLogMessages.length > 0}>{renderWorkLog(workLogMessages)}</Show>
          <For each={msg.content}>{(block) => {
            if (msg.role === 'assistant' && (block.type === 'thinking' || block.type === 'tool_result' || (block.type === 'tool_use' && !isQuestionBlock(block)))) return null
            if (block.type === 'text' && block.text) {
              const display = hasAttachments ? cleanText : block.text
              return display ? <div class="markdown" innerHTML={msg.passive ? renderWikiMarkdown(display) : renderMarkdown(display)} ref={(el) => queueMicrotask(() => enhanceMarkdown(el, (src) => setLightbox(src), openExpandedTable, props.onOpenFile))} /> : null
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
            return renderBlock(block, (src) => setLightbox(src), openExpandedTable, undefined, props.onOpenFile)
          }}</For>
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
    <div ref={(el) => { scrollRef = el; props.scrollRefCb?.(el) }} onScroll={onScroll} onClick={handleCopyClick} style={{ height: '100%', 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch', 'overscroll-behavior': 'contain', padding: '16px', 'padding-bottom': '80px' }}>
      <style>{markdownCSS}</style>
      <Show when={expandedTable()}>
        <div ref={tableModal} class="md-table-modal" role="dialog" aria-modal="true" aria-label="Expanded table" onKeyDown={handleTableModalKeydown}>
          <div class="md-table-modal-bar">
            <span>Table</span>
            <button ref={(element) => queueMicrotask(() => element.focus())} aria-label="Close expanded table" onClick={closeExpandedTable} style={{ background: 'none', border: 'none', color: '#e5e5e5', 'font-size': '24px', cursor: 'pointer', padding: '2px 8px' }}>&times;</button>
          </div>
          <div class="md-table-modal-body" innerHTML={expandedTable()!} ref={(element) => queueMicrotask(() => { fixLinks(element, (src) => setLightbox(src), props.onOpenFile); fixImages(element, (src) => setLightbox(src)) })} />
        </div>
      </Show>
      <div ref={contentRef}>
      <Show when={props.loading}>
        <div style={{ color: 'var(--text-dim)', 'text-align': 'center', padding: '40px' }}>Loading...</div>
      </Show>
      <Show when={props.hasMore && !props.loading}>
        <div style={{ 'text-align': 'center', padding: '12px' }}>
          <button onClick={() => props.onLoadEarlier?.()} disabled={props.loadingMore}
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-medium)', color: 'var(--link)', padding: '6px 16px', 'border-radius': '6px', 'font-size': '12px', cursor: props.loadingMore ? 'wait' : 'pointer' }}>
            {props.loadingMore ? 'Loading...' : 'Load earlier messages'}
          </button>
        </div>
      </Show>
      {/* Lightbox with pinch-to-zoom */}
      <Show when={lightbox()}>
        {(() => {
          const [scale, setScale] = createSignal(1)
          const [tx, setTx] = createSignal(0)
          const [ty, setTy] = createSignal(0)
          let startDist = 0
          let startScale = 1
          let startTx = 0
          let startTy = 0
          let startMidX = 0
          let startMidY = 0
          let lastTap = 0
          let moved = false

          function dist(t: TouchList) {
            const dx = t[1].clientX - t[0].clientX
            const dy = t[1].clientY - t[0].clientY
            return Math.sqrt(dx * dx + dy * dy)
          }

          function onTouch(e: TouchEvent) {
            if (e.type === 'touchstart') {
              moved = false
              if (e.touches.length === 2) {
                e.preventDefault()
                startDist = dist(e.touches)
                startScale = scale()
                startTx = tx()
                startTy = ty()
                startMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2
                startMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2
              } else if (e.touches.length === 1 && scale() > 1) {
                e.preventDefault()
                startTx = tx()
                startTy = ty()
                startMidX = e.touches[0].clientX
                startMidY = e.touches[0].clientY
              }
            } else if (e.type === 'touchmove') {
              if (e.touches.length === 2) {
                e.preventDefault()
                moved = true
                const newScale = Math.min(5, Math.max(1, startScale * (dist(e.touches) / startDist)))
                setScale(newScale)
                const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2
                const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2
                setTx(startTx + midX - startMidX)
                setTy(startTy + midY - startMidY)
              } else if (e.touches.length === 1 && scale() > 1) {
                e.preventDefault()
                moved = true
                setTx(startTx + e.touches[0].clientX - startMidX)
                setTy(startTy + e.touches[0].clientY - startMidY)
              }
            } else if (e.type === 'touchend') {
              // Snap back if scale went below 1
              if (scale() <= 1) { setScale(1); setTx(0); setTy(0) }
            }
          }

          function onClick(e: MouseEvent) {
            // Double-tap to zoom
            const now = Date.now()
            if (now - lastTap < 300) {
              e.stopPropagation()
              if (scale() > 1) { setScale(1); setTx(0); setTy(0) }
              else { setScale(2.5) }
              lastTap = 0
              return
            }
            lastTap = now
            // Single tap close (with delay to detect double-tap)
            if (!moved && scale() <= 1) {
              setTimeout(() => { if (Date.now() - lastTap >= 280) setLightbox(null) }, 300)
            }
          }

          return (
            <div
              onClick={onClick}
              onTouchStart={onTouch} onTouchMove={onTouch} onTouchEnd={onTouch}
              style={{ position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.85)', 'z-index': '200', display: 'flex', 'align-items': 'center', 'justify-content': 'center', cursor: scale() > 1 ? 'grab' : 'zoom-out', 'touch-action': 'none' }}
            >
              <img src={lightbox()!} style={{ 'max-width': '95vw', 'max-height': '95vh', 'object-fit': 'contain', 'border-radius': '8px', transform: `translate(${tx()}px, ${ty()}px) scale(${scale()})`, 'transform-origin': 'center center', transition: scale() === 1 ? 'transform 0.2s ease' : 'none', 'pointer-events': 'none' }} draggable={false} />
            </div>
          )
        })()}
      </Show>

      {/* PDF viewer modal */}
      <Show when={pdfViewer()}>
        <div style={{ position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.92)', 'z-index': '200', display: 'flex', 'flex-direction': 'column' }}>
          <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', padding: '8px 12px', background: 'var(--bg-secondary)' }}>
            <span style={{ color: 'var(--text-secondary)', 'font-size': '13px', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', flex: '1' }}>{pdfViewer()!.split('/').pop()}</span>
            <button onClick={() => setPdfViewer(null)} style={{ background: 'none', border: 'none', color: 'var(--text-primary)', 'font-size': '24px', cursor: 'pointer', padding: '4px 8px', 'line-height': '1' }}>&times;</button>
          </div>
          <iframe src={pdfViewer()!} style={{ flex: '1', border: 'none', width: '100%', background: '#fff' }} />
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
      <For each={renderItems()}>{(item, itemIndex) => {
        // The live OMP mirror is the authoritative view of the current turn.
        // Keep this decision reactive: transcript messages often render before
        // the replayed OMP timeline reaches the browser after a reload.
        const isLatestItem = () => itemIndex() === renderItems().length - 1
        const mirroredCurrentTurn = createMemo(() => hasCurrentWork() && isLatestItem())
        if (item.kind === 'msg') return <Show
          when={mirroredCurrentTurn() && item.msg.role === 'assistant'}
          fallback={<>{renderMsg(item.msg)}<Show when={item.msg.role === 'user'}><For each={runsForInvocation(props.protocolRuns || [], item.msg.uuid)}>{run => <ProtocolRunCard run={run} />}</For></Show></>}
        >
          <>{renderParentExecution(() => props.work!)}{renderMsg(item.msg, [], true)}</>
        </Show>
        if (item.kind === 'turn') return <Show
          when={mirroredCurrentTurn() && item.msg.role === 'assistant'}
          fallback={<>{renderMsg(item.msg, item.trace.filter(messageHasActivity))}<Show when={item.msg.role === 'user'}><For each={runsForInvocation(props.protocolRuns || [], item.msg.uuid)}>{run => <ProtocolRunCard run={run} />}</For></Show></>}
        >
          <>{renderParentExecution(() => props.work!)}{renderMsg(item.msg, [], true)}</>
        </Show>
        // Keep an unfinished or failed trace reachable even before a final
        // answer arrives; it stays collapsed so it does not dominate chat.
        return <Show when={!mirroredCurrentTurn() && !currentProtocolOwnsWork() && messagesHaveActivity(item.messages)}>
          <div class="live-work-disclosure" data-testid={props.working && isLatestItem() ? 'live-work-turn' : undefined} style={{ margin: '4px 0 10px' }}>{renderWorkLog(item.messages.filter(messageHasActivity), !!props.working && isLatestItem())}</div>
        </Show>
      }}</For>
      <Show when={hasCurrentWork() && !workAttachedToAnswer()}>
        {renderParentExecution(() => props.work!)}
      </Show>



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



      <Show when={props.notice}><div role="status" style={{ margin: '0 0 10px', padding: '8px 11px', 'border-radius': '9px', border: '1px solid #d8a13b', background: 'rgba(216,161,59,.08)', color: '#d8a13b', 'font-size': '12px' }}>{props.notice!.text}</div></Show>

      <Show when={props.assistantStream?.text}>
        <div data-testid="assistant-stream" aria-live="polite" style={{ display: 'flex', 'justify-content': 'flex-start', 'margin-bottom': '10px' }}><div class="asst-bubble" style={{ position: 'relative', width: 'fit-content', 'max-width': 'min(100%, 78ch)', 'min-height': '44px', padding: '10px 14px', 'border-radius': '12px', background: '#1a1a2e', border: '1px solid rgba(255,255,255,.06)', color: '#e5e5e5', 'font-size': '14px', 'line-height': '1.55', 'word-break': 'break-word', 'box-sizing': 'border-box' }}><div class="markdown" innerHTML={renderLiveMarkdown(props.assistantStream!.text)} ref={assistantStreamMarkdownRef} /><span aria-hidden="true" style={{ position: 'absolute', right: '7px', bottom: '7px', display: 'inline-block', width: '2px', height: '10px', background: '#aaa', opacity: props.assistantStream!.ended ? '.35' : '.9' }} /></div></div>
      </Show>



      <Show when={props.working && !currentProtocolOwnsWork() && !hasCurrentWork() && !liveLegacyWork() && !props.assistantStream?.text}>
        <div role="status" data-testid="thinking-indicator" aria-live="polite" class="thinking-indicator">
          <span class="thinking-indicator-dot" aria-hidden="true" />
          <span>{props.statusText || 'Thinking…'}</span>
        </div>
      </Show>
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
          background: 'var(--bg-surface)', color: 'var(--text-primary)',
          border: '1px solid var(--border-medium)', cursor: 'pointer',
          'font-size': '16px', display: 'flex', 'align-items': 'center', 'justify-content': 'center',
          'box-shadow': '0 2px 8px rgba(0,0,0,0.35)', opacity: '0.9',
          '-webkit-tap-highlight-color': 'transparent',
        }}
      >
        <Show when={newMsgCount() > 0}>
          <span style={{
            position: 'absolute', top: '-8px', right: '-8px',
            'min-width': '20px', height: '20px', padding: '0 5px',
            background: 'var(--accent)', color: 'var(--accent-text)',
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
