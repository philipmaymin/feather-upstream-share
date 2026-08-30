// @ts-check
import { test, expect } from '@playwright/test'

const BASE = process.env.FEATHER_URL || 'http://localhost:4870'
const GENERATED_AT = '2026-08-30T16:00:00.000Z'

const waitingPost = {
  id: 'session:waiting:answer', kind: 'session', timestamp: '2026-08-30T15:59:00.000Z',
  sessionId: 'waiting', room: 'launch', projectId: 'launch', projectLabel: 'Launch',
  title: 'Deployment decision', agent: 'omp', status: 'waiting',
  question: 'Choose the release channel before deployment can continue.',
  message: { uuid: 'answer', role: 'assistant', timestamp: '2026-08-30T15:59:00.000Z', content: [{ type: 'text', text: 'The release is ready once you choose the channel.' }] },
  score: 400, why: 'Waiting for your decision',
}

const richPost = {
  id: 'session:rich:result', kind: 'session', timestamp: '2026-08-30T15:40:00.000Z',
  sessionId: 'rich', room: 'research', projectId: 'research', projectLabel: 'Research',
  title: 'Field research packet', agent: 'omp', status: 'finished',
  message: {
    uuid: 'result', role: 'assistant', timestamp: '2026-08-30T15:40:00.000Z',
    content: [{ type: 'text', text: '## Research packet\n\nThe useful files are [report](/tmp/fledge-report.pdf), [interactive](/tmp/fledge-demo.html), and [clip](/tmp/fledge-clip.mp4).\n\n![tracking pixel](https://tracker.example/pixel.png)\n\nhttps://x.com/example/status/1234567890123456789' }],
  },
  score: 100, why: 'Completed recently', reaction: null,
  comments: [{ id: 'existing-comment', text: 'Can you narrow this to the strongest example?', createdAt: '2026-08-30T15:45:00.000Z', delivery: 'delivered', reply: { text: 'Yes. The report is the strongest example because it contains the complete evidence chain.', timestamp: '2026-08-30T15:46:00.000Z' } }],
}

const updatePost = {
  id: 'room-update:films:curated', kind: 'room-update', timestamp: '2026-08-30T15:20:00.000Z',
  sessionId: 'films', room: 'films', projectId: 'films', projectLabel: 'Films',
  title: '#films update', agent: null, status: 'finished',
  updateText: '### Worth watching\n\nA Feather curated this for the stream: https://www.tiktok.com/@example/video/7412345678901234567',
  score: 90, why: 'New Room update',
}

const olderPost = {
  id: 'session:older:result', kind: 'session', timestamp: '2026-08-28T10:00:00.000Z',
  sessionId: 'older', room: 'archive', projectId: 'archive', projectLabel: 'Archive',
  title: 'Earlier dispatch', agent: 'claude', status: 'finished',
  message: { uuid: 'older-result', role: 'assistant', timestamp: '2026-08-28T10:00:00.000Z', content: [{ type: 'text', text: 'An older result remains reachable.' }] },
  score: 40, why: 'Filed earlier',
}

function feedResponse(mode, before) {
  if (before) return {
    generatedAt: GENERATED_AT,
    nextBefore: null,
    counts: { waiting: 1, working: 0, errored: 0, finished: 3 },
    posts: [olderPost],
  }
  const all = mode === 'needs-me' ? [waitingPost] : mode === 'latest' ? [waitingPost, richPost, updatePost] : [waitingPost, richPost, updatePost]
  return {
    generatedAt: GENERATED_AT,
    nextBefore: mode === 'needs-me' ? null : '2026-08-29T00:00:00.000Z',
    counts: { waiting: 1, working: 0, errored: 0, finished: 3 },
    posts: all,
  }
}

async function installFixtureRoutes(page, state = { failFeed: false }) {
  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (path === '/api/feed') {
      if (state.failFeed) return route.abort('failed')
      return route.fulfill({ json: feedResponse(url.searchParams.get('mode') || 'for-you', url.searchParams.get('before')) })
    }
    if (/^\/api\/feed\/.+\/reaction$/.test(path) && request.method() === 'PUT') {
      const reaction = JSON.parse(request.postData() || '{}').reaction ?? null
      state.lastReaction = reaction
      state.reactionAttempts = [...(state.reactionAttempts || []), reaction]
      const delivery = reaction && state.failFirstReaction ? 'failed' : reaction ? 'delivered' : 'not-needed'
      state.failFirstReaction = false
      return route.fulfill({ json: { reaction, reactionDelivery: reaction ? delivery : null, changed: true, delivery } })
    }
    if (/^\/api\/feed\/.+\/comments$/.test(path) && request.method() === 'POST') {
      const body = JSON.parse(request.postData() || '{}')
      state.lastComment = body.text
      state.commentIds = [...(state.commentIds || []), body.id]
      const delivery = state.commentFailuresRemaining > 0 ? 'failed' : 'delivered'
      state.commentFailuresRemaining = Math.max(0, (state.commentFailuresRemaining || 0) - 1)
      return route.fulfill({ json: { comment: { id: body.id, text: body.text, createdAt: GENERATED_AT, delivery } } })
    }
    if (path === '/api/me') return route.fulfill({ json: { username: 'philip', admin: true } })
    if (path === '/api/agents') return route.fulfill({ json: { agents: [{ id: 'omp', label: 'oh-my-pi', available: true, default: true }, { id: 'claude', label: 'Claude Code', available: true }, { id: 'codex', label: 'Codex', available: true }] } })
    if (path === '/api/rooms') return route.fulfill({ json: { rooms: [{ name: 'launch', cwd: '/home/user/rooms/launch', sessions: [{ id: 'waiting', title: 'Deployment decision', updatedAt: waitingPost.timestamp, isActive: true, agent: 'omp' }], active: true, latest: { role: 'assistant', text: 'Release ready' }, updatedAt: waitingPost.timestamp, updates: { count: 0, latestAt: null, latest: null }, friction: { count: 0, latestAt: null, latest: null }, pulse: { enabled: false, status: 'paused', lastRunAt: null, nextRunAt: null, sessionId: null } }] } })
    if (path === '/api/sessions' && request.method() === 'GET') return route.fulfill({ json: { sessions: [{ id: 'waiting', title: 'Deployment decision', updatedAt: waitingPost.timestamp, isActive: true, agent: 'omp', projectId: 'launch', projectLabel: 'Launch' }] } })
    if (path === '/api/sessions/waiting/messages') return route.fulfill({ json: { messages: [waitingPost.message], hasMore: false } })
    if (path === '/api/sessions/waiting/protocol-runs') return route.fulfill({ json: { runs: [] } })
    if (path === '/api/starred') return route.fulfill({ json: {} })
    if (path === '/api/sidecar') return route.fulfill({ json: { groups: [] } })
    if (path === '/api/quick-links') return route.fulfill({ json: [] })
    if (path === '/api/version') return route.fulfill({ json: {} })
    if (path === '/api/files/raw') {
      const file = url.searchParams.get('path') || ''
      const contentType = file.endsWith('.pdf') ? 'application/pdf' : file.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream'
      return route.fulfill({ status: 200, contentType, body: file.endsWith('.pdf') ? '%PDF-1.4\n%%EOF' : 'media' })
    }
    if (path === '/api/files/html') return route.fulfill({
      status: 200,
      contentType: 'text/html',
      headers: { 'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'" },
      body: '<!doctype html><p id="result">loading</p><script>document.getElementById("result").textContent="interactive-ok"</script>',
    })
    return route.continue()
  })
}

test('Fledge is a feed-first complete interface with internal chat navigation', async ({ page }) => {
  await installFixtureRoutes(page)
  await page.goto(`${BASE}/?app=fledge`)

  await expect(page.getByTestId('fledge-home')).toBeVisible()
  await expect(page.getByTestId('fledge-needs-count')).toContainText('1 waiting')
  const posts = page.getByTestId('fledge-post')
  await expect(posts).toHaveCount(3)
  await expect(posts.first()).toContainText('Your move')
  await expect(posts.first()).toContainText('Choose the release channel')
  await expect(posts.first()).toContainText('Deployment decision')
  await expect(page.locator('a[href*="philip.feather.plus"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sessions' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Open menu' }).click()
  await expect(page.getByRole('button', { name: 'Sessions' })).toBeVisible()
  await page.getByRole('button', { name: '×' }).click()

  await posts.first().getByRole('heading', { name: 'Deployment decision', exact: true }).click()
  await expect(page.getByTestId('chat-panel')).toBeVisible()
  await expect(page).toHaveURL(/#waiting$/)
  await expect(page.getByText('The release is ready once you choose the channel.')).toBeVisible()

  await page.goBack()
  await expect(page.getByTestId('fledge-home')).toBeVisible()
  await expect(page).not.toHaveURL(/#waiting$/)
  await page.goForward()
  await expect(page.getByTestId('chat-panel')).toBeVisible()
  await expect(page).toHaveURL(/#waiting$/)

  await page.getByTitle('Fledge home').click()
  await expect(page.getByTestId('fledge-home')).toBeVisible()
  await page.locator('.fledge-bottom-nav').getByRole('button', { name: 'Rooms' }).click()
  await expect(page.getByText('#launch', { exact: true })).toBeVisible()
  await page.getByTestId('fledge-feed-return').click()
  await expect(page.getByTestId('fledge-home')).toBeVisible()

  await page.getByText('Needs Me', { exact: true }).click()
  await expect(page.getByTestId('fledge-post')).toHaveCount(1)
  await expect(page.getByTestId('fledge-post').first().getByRole('heading', { name: 'Deployment decision', exact: true })).toBeVisible()
})

test('Fledge renders rich and curated media in-app and paginates without a context switch', async ({ page }) => {
  let remoteImageRequests = 0
  page.on('request', request => { if (new URL(request.url()).hostname === 'tracker.example') remoteImageRequests++ })
  const state = { failFeed: false, failFirstReaction: true, reactionAttempts: [], commentFailuresRemaining: 2, commentIds: [] }
  await installFixtureRoutes(page, state)
  await page.goto(`${BASE}/?app=fledge`)

  await expect(page.getByRole('heading', { name: 'Research packet', exact: true })).toBeVisible()
  await expect(page.locator('iframe[src*="platform.twitter.com/embed/Tweet.html"]')).toHaveCount(1)
  await expect(page.locator('iframe[src*="www.tiktok.com/player/v1/"]')).toHaveCount(1)
  await expect(page.getByRole('link', { name: 'Load remote image: tracking pixel' })).toBeVisible()
  expect(remoteImageRequests).toBe(0)

  const richCard = page.locator('[data-post-id="session:rich:result"]')
  await expect(richCard.getByText('The report is the strongest example because it contains the complete evidence chain.')).toBeVisible()
  await richCard.getByRole('button', { name: 'Show me more like this' }).click()
  await expect(richCard.getByRole('button', { name: 'Show me more like this' })).toHaveAttribute('aria-pressed', 'true')
  await expect(richCard.getByRole('button', { name: 'Retry feedback' })).toBeVisible()
  await richCard.getByRole('button', { name: 'Retry feedback' }).click()
  await expect(richCard.getByRole('button', { name: 'Retry feedback' })).toHaveCount(0)
  expect(state.reactionAttempts).toEqual(['like', 'like'])
  await richCard.getByRole('button', { name: 'Show me less like this' }).click()
  await expect(richCard.getByRole('button', { name: 'Show me more like this' })).toHaveAttribute('aria-pressed', 'false')
  await expect(richCard.getByRole('button', { name: 'Show me less like this' })).toHaveAttribute('aria-pressed', 'true')
  await richCard.getByRole('button', { name: 'Reply: respond inline to this dispatch' }).click()
  await richCard.getByLabel('Reply inside this dispatch').fill('Please turn that into a one-page brief.')
  await richCard.getByRole('button', { name: 'Send reply' }).click()
  await expect(richCard.getByText('Delivery failed. Your draft is still here.')).toBeVisible()
  await richCard.getByLabel('Reply inside this dispatch').fill('Please turn that into a concise one-page brief.')
  await richCard.getByRole('button', { name: 'Send reply' }).click()
  await expect(richCard.getByText('Delivery failed. Your draft is still here.')).toBeVisible()
  await richCard.getByRole('button', { name: 'Send reply' }).click()
  await expect(richCard.getByText('Please turn that into a concise one-page brief.')).toHaveCount(1)
  expect(state.commentIds).toHaveLength(3)
  expect(state.commentIds[0]).not.toBe(state.commentIds[1])
  expect(state.commentIds[1]).toBe(state.commentIds[2])

  await page.getByRole('link', { name: 'report' }).click()
  await expect(page.getByText('PDF', { exact: true })).toBeVisible()
  await page.getByTitle('Close').click()

  await page.getByRole('link', { name: 'interactive' }).click()
  const interactive = page.locator('iframe[title="fledge-demo.html"]')
  await expect(interactive).toHaveAttribute('sandbox', /allow-scripts/)
  await expect(interactive).not.toHaveAttribute('sandbox', /allow-same-origin/)
  await expect(interactive.contentFrame().locator('#result')).toHaveText('interactive-ok')
  await page.getByTitle('Close').click()

  await page.getByRole('link', { name: 'clip' }).click()
  await expect(page.locator('video[playsinline]')).toBeVisible()
  await page.getByTitle('Close').click()

  const olderHeading = page.getByRole('heading', { name: 'Earlier dispatch', exact: true })
  if (await olderHeading.count() === 0) await page.getByRole('button', { name: 'Load older dispatches' }).click()
  await expect(olderHeading).toBeVisible()
})

test('Fledge labels a saved feed as stale when refresh fails', async ({ page }) => {
  const state = { failFeed: false }
  await installFixtureRoutes(page, state)
  await page.goto(`${BASE}/?app=fledge`)
  await expect(page.getByRole('heading', { name: 'Deployment decision' })).toBeVisible()

  state.failFeed = true
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Deployment decision' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Stale copy.*Refresh feed/ })).toBeVisible()
})
