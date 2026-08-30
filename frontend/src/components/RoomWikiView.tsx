import { createEffect, createSignal, For, Show } from 'solid-js'
import { fetchRoomWiki, fetchRoomWikiPage } from '../api'
import type { RoomWikiPageMeta } from '../api'
import { renderWikiMarkdown } from './MessageView'

export function RoomWikiView(props: { room?: string }) {
  const [pages, setPages] = createSignal<RoomWikiPageMeta[]>([])
  const [selected, setSelected] = createSignal<string | null>(null)
  const [content, setContent] = createSignal('')
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  let generation = 0
  let pageGeneration = 0

  async function selectPage(name: string, room = props.room) {
    if (!room) return
    const ownRoomGeneration = generation
    const ownPageGeneration = ++pageGeneration
    setSelected(name)
    setLoading(true)
    setError(null)
    try {
      const page = await fetchRoomWikiPage(room, name)
      if (ownRoomGeneration === generation && ownPageGeneration === pageGeneration) setContent(page.content)
    } catch (cause) {
      if (ownRoomGeneration === generation && ownPageGeneration === pageGeneration) {
        setContent('')
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (ownRoomGeneration === generation && ownPageGeneration === pageGeneration) setLoading(false)
    }
  }

  createEffect(() => {
    const room = props.room
    const ownGeneration = ++generation
    ++pageGeneration
    setPages([])
    setSelected(null)
    setContent('')
    setError(null)
    if (!room) return
    setLoading(true)
    fetchRoomWiki(room).then(async (next) => {
      if (ownGeneration !== generation) return
      setPages(next)
      const first = next.find((page) => page.name === 'Home') || next[0]
      if (first) await selectPage(first.name, room)
      else setLoading(false)
    }).catch((cause) => {
      if (ownGeneration !== generation) return
      setError(cause instanceof Error ? cause.message : String(cause))
      setLoading(false)
    })
  })

  function followLink(event: MouseEvent) {
    const anchor = (event.target as HTMLElement).closest('a')
    if (!anchor) return
    const href = anchor.getAttribute('href') || ''
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) {
      anchor.setAttribute('target', '_blank')
      anchor.setAttribute('rel', 'noopener noreferrer')
      return
    }
    if (href.startsWith('#')) return
    event.preventDefault()
    const raw = decodeURIComponent(href.replace(/[#?].*$/, '').replace(/\.md$/i, ''))
    const parts = raw.startsWith('/') ? [] : (selected() || '').split('/').slice(0, -1)
    for (const segment of raw.split('/')) {
      if (!segment || segment === '.') continue
      if (segment === '..') {
        if (parts.length === 0) return
        parts.pop()
      } else {
        parts.push(segment)
      }
    }
    const target = parts.join('/')
    if (target) selectPage(target)
  }

  return (
    <section data-testid={props.room ? `wiki-view-${props.room}` : 'wiki-view-none'} style={{ height: '100%', display: 'flex', 'flex-direction': 'column', 'min-height': '0' }}>
      <Show when={props.room} fallback={
        <div style={{ color: '#666', 'font-size': '13px', padding: '24px 16px' }}>This chat is not in a Room, so it has no Wiki.</div>
      }>
        <div style={{ display: 'flex', 'flex-wrap': 'wrap', gap: '6px', padding: '9px 12px', 'border-bottom': '1px solid #1e1e1e', 'flex-shrink': '0' }}>
          <For each={pages()}>{(page) => (
            <button data-testid={`wiki-page-${props.room}-${page.name}`} onClick={() => selectPage(page.name)}
              style={{ background: selected() === page.name ? '#1a1f2e' : 'transparent', border: '1px solid #2a3346', color: selected() === page.name ? '#d6dce7' : '#8a94a4', 'font-size': '11px', 'font-weight': '600', padding: '4px 10px', 'border-radius': '999px', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>
              {page.name}
            </button>
          )}</For>
          <span style={{ 'margin-left': 'auto', color: '#4f5866', 'font-size': '10px', 'align-self': 'center' }}>#{props.room}</span>
        </div>
        <Show when={error()}>
          <div style={{ color: '#d45555', 'font-size': '12px', padding: '12px 16px' }}>{error()}</div>
        </Show>
        <Show when={loading()}>
          <div style={{ color: '#666', 'font-size': '12px', padding: '12px 16px' }}>Loading Wiki…</div>
        </Show>
        <Show when={!loading() && !error() && pages().length === 0}>
          <div style={{ color: '#666', 'font-size': '13px', padding: '24px 16px', 'line-height': '1.5' }}>No curated knowledge yet. The Room caretaker creates pages as evidence stabilizes.</div>
        </Show>
        <Show when={!loading() && !error() && selected()}>
          <article data-testid={`wiki-content-${props.room}`} class="markdown wiki-markdown" onClick={followLink}
            style={{ flex: '1', 'min-height': '0', 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch', padding: '14px 16px 32px', 'font-size': '14px', color: '#d0d4da', 'line-height': '1.6', 'word-break': 'break-word' }}
            innerHTML={renderWikiMarkdown(content())} />
        </Show>
      </Show>
    </section>
  )
}
