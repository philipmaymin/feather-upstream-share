// @ts-check
import { test, expect } from '@playwright/test'

const BASE = process.env.FEATHER_URL || 'http://localhost:4870'
const NOW = new Date().toISOString()

const philip = { id: 'human:philip', kind: 'human', username: 'philip', displayName: 'Philip', avatarSeed: 'philip', createdAt: NOW, role: 'owner', notificationLevel: 'all' }
const coordinator = { id: 'agent:films7:coordinator', kind: 'agent', username: 'coordinator', displayName: 'Coordinator', avatarSeed: 'coordinator', agentBackend: 'omp', createdAt: NOW, role: 'agent', notificationLevel: 'mentions' }
const caretaker = { id: 'agent:films7:caretaker', kind: 'agent', username: 'caretaker', displayName: 'Caretaker', avatarSeed: 'caretaker', agentBackend: 'omp', createdAt: NOW, role: 'agent', notificationLevel: 'mentions' }
const channel = {
  id: 'channel-films7', slug: 'films7', title: 'Films 7',
  description: 'A human-and-agent studio for making the next film together.',
  type: 'channel', defaultAgentId: coordinator.id, createdAt: NOW, archivedAt: null,
  unread: 1, members: [philip, coordinator, caretaker],
}

function message(id, author, content, rootId = id, type = author.kind === 'agent' ? 'agent' : 'human') {
  return { id, channelId: channel.id, seq: 1, threadRootId: rootId, replyToId: rootId === id ? null : rootId, messageType: type, content, createdAt: NOW, editedAt: null, author, metadata: {} }
}

function fixtureState() {
  const bridge = {
    ...message('bridge', philip, 'Continuity bridge: the #films6 Wiki remains read-only historical context.', 'bridge', 'system'),
    thread: { title: 'Continuity bridge', state: 'open', replyCount: 0, updatedAt: NOW, unread: false, following: true, doneAt: null, snoozedUntil: null },
    replies: [],
  }
  const root = {
    ...message('root-1', philip, 'What dramatic question should the opening make impossible to ignore?'),
    thread: { title: 'The dramatic question in the opening', state: 'working', replyCount: 2, updatedAt: NOW, unread: true, following: true, doneAt: null, snoozedUntil: null },
    replies: [
      message('reply-1', coordinator, 'The opening should ask whether she will trade the truth for belonging.', 'root-1'),
      message('reply-2', caretaker, 'Continuity holds if the unopened letter remains visible in both shots.', 'root-1'),
    ],
  }
  const threads = new Map([
    ['bridge', { id: 'bridge', channelId: channel.id, title: 'Continuity bridge', state: 'open', following: true, doneAt: null, snoozedUntil: null, messages: [bridge], executions: [] }],
    ['root-1', {
      id: 'root-1', channelId: channel.id, title: 'The dramatic question in the opening', state: 'working', following: true, doneAt: null, snoozedUntil: null,
      messages: [root, ...root.replies],
      executions: [{ id: 'execution-1', state: 'running', agent: coordinator, triggerMessageId: 'root-1', finalMessageId: null, depth: 0, startedAt: NOW, completedAt: null, error: null }],
    }],
  ])
  return {
    roots: [bridge, root],
    threads,
    activity: [{
      id: 'notice-1', kind: 'agent_reply', reason: 'Coordinator replied as an agent', createdAt: NOW, readAt: null, doneAt: null,
      channel: { id: channel.id, slug: channel.slug, title: channel.title },
      thread: { id: 'root-1', title: root.thread.title, state: root.thread.state },
      messageId: 'reply-1', preview: root.replies[0].content,
      actor: coordinator,
    }],
    posts: [],
  }
}

async function installChannels(page, state) {
  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const pathname = url.pathname
    if (pathname === '/api/me') return route.fulfill({ json: { username: 'philip', admin: true } })
    if (pathname === '/api/channels' && request.method() === 'GET') return route.fulfill({ json: { channels: [channel], dms: [], principal: philip } })
    if (pathname === '/api/channels/activity') return route.fulfill({ json: { items: state.activity, unread: state.activity.filter(item => !item.readAt && !item.doneAt).length, needsYou: 0 } })
    if (pathname === '/api/channels/principals') return route.fulfill({ json: { principals: [philip, coordinator, caretaker] } })
    if (pathname === '/api/channels/stream') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: connected\ndata: {}\n\n' })
    if (pathname === `/api/channels/${channel.id}/messages` && request.method() === 'GET') return route.fulfill({ json: { messages: state.roots } })
    if (pathname === `/api/channels/${channel.id}/messages` && request.method() === 'POST') {
      const body = JSON.parse(request.postData() || '{}')
      const id = `posted-${state.posts.length + 1}`
      const posted = message(id, philip, body.content, body.threadRootId || id)
      state.posts.push(posted)
      if (body.threadRootId) {
        const existing = state.threads.get(body.threadRootId)
        existing.messages.push(posted)
      } else {
        const root = { ...posted, thread: { title: body.content, state: 'working', replyCount: 0, updatedAt: NOW, unread: false, following: true, doneAt: null, snoozedUntil: null }, replies: [] }
        state.roots.push(root)
        state.threads.set(id, { id, channelId: channel.id, title: body.content, state: 'working', following: true, doneAt: null, snoozedUntil: null, messages: [root], executions: [] })
      }
      return route.fulfill({ status: 201, json: { message: posted } })
    }
    const threadMatch = pathname.match(/^\/api\/channels\/channel-films7\/threads\/([^/]+)$/)
    if (threadMatch && request.method() === 'GET') return route.fulfill({ json: { thread: state.threads.get(threadMatch[1]) } })
    if (threadMatch && request.method() === 'PATCH') {
      const current = state.threads.get(threadMatch[1])
      Object.assign(current, JSON.parse(request.postData() || '{}'))
      return route.fulfill({ json: { thread: current } })
    }
    const attentionMatch = pathname.match(/^\/api\/channels\/channel-films7\/threads\/([^/]+)\/attention$/)
    if (attentionMatch) {
      const body = JSON.parse(request.postData() || '{}')
      const current = state.threads.get(attentionMatch[1])
      if (body.action === 'done') {
        current.doneAt = body.value ? NOW : null
        state.activity = state.activity.map(item => item.thread?.id === current.id ? { ...item, doneAt: current.doneAt } : item).filter(item => !item.doneAt)
      }
      if (body.action === 'follow') current.following = body.value
      if (body.action === 'snooze') current.snoozedUntil = body.until
      if (body.action === 'read') state.activity = state.activity.map(item => item.thread?.id === current.id ? { ...item, readAt: NOW } : item)
      return route.fulfill({ json: { thread: current } })
    }
    if (pathname === '/api/sessions' && request.method() === 'GET') return route.fulfill({ json: { sessions: [] } })
    if (pathname === '/api/agents') return route.fulfill({ json: { agents: [{ id: 'omp', label: 'oh-my-pi', available: true, default: true }] } })
    if (pathname === '/api/starred') return route.fulfill({ json: {} })
    if (pathname === '/api/quick-links') return route.fulfill({ json: [] })
    if (pathname === '/api/version') return route.fulfill({ json: {} })
    return route.fulfill({ status: 404, json: { error: `Unhandled fixture route ${pathname}` } })
  })
}

test.describe('Channels PWA', () => {
  test('desktop keeps shared work legible from channel to execution', async ({ page }) => {
    const state = fixtureState()
    await installChannels(page, state)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${BASE}/?app=fledge&surface=channels`)

    await expect(page.getByTestId('channels-home')).toBeVisible()
    await expect(page.getByRole('heading', { name: '#films7' })).toBeVisible()
    await expect(page.getByText('What dramatic question should the opening make impossible to ignore?')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Rooms' })).toHaveCount(0)
    await expect(page.locator('.channels-root')).not.toHaveClass(/channel-thread-open/)

    await page.getByRole('button', { name: /2 replies/ }).click()
    await expect(page.locator('.channels-root')).toHaveClass(/channel-thread-open/)
    await expect(page.locator('.channel-thread-pane').getByText('Agent', { exact: true }).first()).toBeVisible()
    await expect(page.locator('.channel-thread-pane')).toContainText('Agent work · 1 turn')
    await expect(page.locator('.channel-execution')).toContainText('@coordinator')
    await expect(page.locator('.channel-execution')).toContainText('running · depth 0')

    await page.getByRole('button', { name: 'Close thread' }).click()
    const composer = page.getByLabel('New channel message')
    await composer.fill('Build a silent ending that earns the final held look.')
    await composer.press('Control+Enter')
    await expect(page.locator('.channel-thread-pane')).toContainText('Build a silent ending that earns the final held look.')
    expect(state.posts).toHaveLength(1)
  })

  test('Activity behaves as a triage inbox rather than another feed', async ({ page }) => {
    const state = fixtureState()
    await installChannels(page, state)
    await page.setViewportSize({ width: 1180, height: 820 })
    await page.goto(`${BASE}/?app=fledge&surface=channels&view=activity`)

    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible()
    await expect(page.getByText('Coordinator replied as an agent')).toBeVisible()
    await expect(page.getByText('Agent · #films7')).toBeVisible()
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Nothing is waiting on you' })).toBeVisible()
  })

  test('mobile thread is full-screen and preserves direct navigation', async ({ page }) => {
    const state = fixtureState()
    await installChannels(page, state)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${BASE}/?app=fledge&surface=channels`)

    const mobileNav = page.locator('.channels-mobile-nav')
    await expect(mobileNav.getByRole('button', { name: 'Activity' })).toBeVisible()
    await expect(mobileNav.getByRole('button', { name: 'Channels' })).toBeVisible()
    await expect(mobileNav.getByRole('button', { name: 'Threads' })).toBeVisible()
    await expect(mobileNav.getByRole('button', { name: 'DMs' })).toBeVisible()

    await page.getByRole('button', { name: /2 replies/ }).click()
    const pane = page.locator('.channel-thread-pane')
    await expect(pane).toHaveClass(/open/)
    await expect(pane).toHaveCSS('position', 'fixed')
    await expect(pane.getByText('Continuity holds if the unopened letter remains visible in both shots.')).toBeVisible()
    await pane.getByRole('button', { name: 'Close thread' }).click()
    await expect(pane).not.toHaveClass(/open/)
  })
})
