// @ts-check
import { test, expect } from '@playwright/test'

const BASE = process.env.FEATHER_URL || 'http://localhost:4870'
const NOW = new Date().toISOString()

const philip = { id: 'human:philip', kind: 'human', username: 'philip', displayName: 'Philip', avatarSeed: 'philip', createdAt: NOW, role: 'owner', notificationLevel: 'all' }
const coordinator = { id: 'agent:films7:coordinator', kind: 'agent', username: 'coordinator', displayName: 'Coordinator', avatarSeed: 'coordinator', agentBackend: 'omp', createdAt: NOW, role: 'agent', notificationLevel: 'mentions' }
const caretaker = { id: 'agent:films7:caretaker', kind: 'agent', username: 'caretaker', displayName: 'Caretaker', avatarSeed: 'caretaker', agentBackend: 'omp', createdAt: NOW, role: 'agent', notificationLevel: 'mentions' }
const btw = { id: 'agent:films7:btw', kind: 'agent', username: 'films7-btw', displayName: 'Btw', avatarSeed: 'films7-btw', agentBackend: 'omp', createdAt: NOW, role: 'agent', notificationLevel: 'mentions' }
const channel = {
  id: 'channel-films7', slug: 'films7', title: 'Films 7',
  description: 'A human-and-agent studio for making the next film together.',
  type: 'channel', defaultAgentId: coordinator.id, createdAt: NOW, archivedAt: null,
  unread: 1, members: [philip, coordinator, caretaker, btw],
}

function message(id, author, content, rootId = id, type = author.kind === 'agent' ? 'agent' : 'human') {
  return { id, channelId: channel.id, seq: 1, threadRootId: rootId, replyToId: rootId === id ? null : rootId, messageType: type, content, createdAt: NOW, editedAt: null, author, metadata: {} }
}

function fixtureState() {
  const bridge = {
    ...message('bridge', philip, 'Continuity bridge: the #films6 Wiki remains read-only historical context.', 'bridge', 'system'),
    thread: { title: 'Continuity bridge', state: 'open', replyCount: 0, updatedAt: NOW, unread: false, mentioned: false, following: true, doneAt: null, snoozedUntil: null, delivery: { queuedAgents: [], activeAgents: [], queuedCount: 0, activeCount: 0 }, recovery: null },
    replies: [],
  }
  const root = {
    ...message('root-1', philip, 'What dramatic question should the opening make impossible to ignore?'),
    thread: { title: 'The dramatic question in the opening', state: 'working', replyCount: 2, updatedAt: NOW, unread: true, mentioned: false, following: true, doneAt: null, snoozedUntil: null, delivery: { queuedAgents: [btw], activeAgents: [coordinator], queuedCount: 1, activeCount: 1 }, recovery: null },
    replies: [
      message('reply-1', coordinator, 'The opening should ask whether she will trade the truth for belonging.', 'root-1'),
      message('reply-2', caretaker, 'Continuity holds if the unopened letter remains visible in both shots.', 'root-1'),
    ],
  }
  const threads = new Map([
    ['bridge', { id: 'bridge', channelId: channel.id, title: 'Continuity bridge', state: 'open', lastReadSeq: 1, following: true, doneAt: null, snoozedUntil: null, messages: [bridge], executions: [] }],
    ['root-1', {
      id: 'root-1', channelId: channel.id, title: 'The dramatic question in the opening', state: 'working', lastReadSeq: 1, following: true, doneAt: null, snoozedUntil: null,
      delivery: { queuedAgents: [btw], activeAgents: [coordinator], queuedCount: 1, activeCount: 1 },
      messages: [root, ...root.replies],
      executions: [{ id: 'execution-1', state: 'running', agent: coordinator, triggerMessageId: 'root-1', finalMessageId: null, depth: 0, startedAt: NOW, completedAt: null, error: null, canRestart: true }],
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
    peek: {
      execution: { id: 'execution-1', state: 'running', agent: coordinator, startedAt: NOW, completedAt: null },
      activity: 'Opening the Blackboard gradebook…',
      steps: [{ id: 'tool-browser', tool: 'browser', intent: 'Open Homework 1 submissions', status: 'working' }],
      updatedAt: NOW,
      processActive: true,
      stalled: false,
      stalledReason: null,
      canRestart: true,
    },
    posts: [],
    attachments: [],
  }
}

async function installChannels(page, state) {
  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const pathname = url.pathname
    if (pathname === '/api/me') {
      if (state.authDelay) await new Promise(resolve => setTimeout(resolve, state.authDelay))
      return route.fulfill({ json: state.user || { username: 'philip', admin: true } })
    }
    if (pathname === `/api/channels/${channel.id}/attachments` && request.method() === 'POST') {
      const id = request.headers()['x-upload-id']
      const filename = decodeURIComponent(request.headers()['x-filename'] || 'pasted-image.png')
      const attachment = {
        id,
        filename,
        contentType: request.headers()['content-type'],
        byteSize: request.postDataBuffer()?.length || 0,
        url: `/api/channels/${channel.id}/attachments/${id}`,
      }
      state.attachments.push(attachment)
      return route.fulfill({ status: 201, json: { attachment } })
    }
    if (pathname.startsWith(`/api/channels/${channel.id}/attachments/`) && request.method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZP0kAAAAASUVORK5CYII=', 'base64'),
      })
    }
    if (pathname === '/api/channels' && request.method() === 'GET') {
      state.channelGets = (state.channelGets || 0) + 1
      const gate = state.channelGetGates?.[state.channelGets]
      if (gate) await gate
      return route.fulfill({ json: { channels: state.channels || [channel], dms: state.dms || [], principal: state.principal || philip } })
    }
    if (pathname === '/api/channels' && request.method() === 'POST' && state.createdChannel) {
      if (state.channelCreateGate) await state.channelCreateGate
      state.channels = [channel, state.createdChannel]
      return route.fulfill({ status: 201, json: { channel: state.createdChannel, staffing: state.staffing || { status: 'ready', agents: state.createdChannel.members.filter(member => member.kind === 'agent') } } })
    }
    if (pathname === '/api/channels/activity') return route.fulfill({ json: { items: state.activity, unread: state.activity.filter(item => !item.readAt && !item.doneAt).length, needsYou: 0 } })
    if (pathname === '/api/channels/principals') return route.fulfill({ json: { principals: state.createdChannel ? [...state.createdChannel.members, coordinator, caretaker, btw] : [philip, coordinator, caretaker, btw] } })
    if (pathname === '/api/channels/stream') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: connected\ndata: {}\n\n' })
    if (pathname === `/api/channels/${channel.id}/messages` && request.method() === 'GET') return route.fulfill({ json: { messages: state.roots } })
    if (state.createdChannel && pathname === `/api/channels/${state.createdChannel.id}/messages` && request.method() === 'GET') return route.fulfill({ json: { messages: [] } })
    if (state.dm && pathname === `/api/channels/${state.dm.id}/messages` && request.method() === 'GET') {
      return route.fulfill({ json: { messages: state.dmRoots } })
    }
    if (pathname === `/api/channels/${channel.id}/messages` && request.method() === 'POST') {
      const body = JSON.parse(request.postData() || '{}')
      const id = `posted-${state.posts.length + 1}`
      const posted = message(id, philip, body.content, body.threadRootId || id)
      state.posts.push(posted)
      if (body.threadRootId) {
        const existing = state.threads.get(body.threadRootId)
        existing.messages.push(posted)
        const root = state.roots.find(candidate => candidate.id === body.threadRootId)
        if (root) {
          root.replies.push(posted)
          root.thread.replyCount = root.replies.length
          root.thread.updatedAt = NOW
        }
      } else {
        const root = { ...posted, thread: { title: body.content, state: 'working', replyCount: 0, updatedAt: NOW, unread: false, following: true, doneAt: null, snoozedUntil: null }, replies: [] }
        state.roots.push(root)
        state.threads.set(id, { id, channelId: channel.id, title: body.content, state: 'working', following: true, doneAt: null, snoozedUntil: null, messages: [root], executions: [] })
      }
      return route.fulfill({ status: 201, json: { message: posted } })
    }
    const threadMatch = pathname.match(/^\/api\/channels\/channel-films7\/threads\/([^/]+)$/)
    if (threadMatch && request.method() === 'GET') {
      if (state.threadDelays?.[threadMatch[1]]) await new Promise(resolve => setTimeout(resolve, state.threadDelays[threadMatch[1]]))
      return route.fulfill({ json: { thread: state.threads.get(threadMatch[1]) } })
    }
    if (threadMatch && request.method() === 'PATCH') {
      state.threadPatches = (state.threadPatches || 0) + 1
      const current = state.threads.get(threadMatch[1])
      Object.assign(current, JSON.parse(request.postData() || '{}'))
      return route.fulfill({ json: { thread: current } })
    }
    if (state.dm && pathname === `/api/channels/${state.dm.id}/threads/${state.dmRoot.id}/attention`) {
      const body = JSON.parse(request.postData() || '{}')
      if (body.action === 'read') {
        state.dmReadRequests = (state.dmReadRequests || 0) + 1
        state.dm.unread = 0
        state.dmRoot.thread.unread = false
        state.activity = state.activity.map(item => item.thread?.id === state.dmRoot.id ? { ...item, readAt: NOW } : item)
      }
      return route.fulfill({ json: { thread: state.dmThread } })
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
      if (body.action === 'read') {
        current.lastReadSeq = Math.max(0, ...current.messages.map(message => message.seq))
        const root = state.roots.find(candidate => candidate.id === current.id)
        if (root?.thread) root.thread.unread = false
        state.activity = state.activity.map(item => item.thread?.id === current.id ? { ...item, readAt: NOW } : item)
      }
      return route.fulfill({ json: { thread: current } })
    }
    if (pathname === '/api/channels/executions/execution-1/peek' && request.method() === 'GET') {
      return route.fulfill({ json: state.peek })
    }
    if (pathname === '/api/channels/executions/execution-1/restart' && request.method() === 'POST') {
      const execution = state.threads.get('root-1').executions.find(candidate => candidate.id === 'execution-1')
      execution.state = 'error'
      execution.completedAt = NOW
      execution.error = 'Restarted by a channel member'
      execution.canRestart = false
      const queued = { queuedAgents: [coordinator], activeAgents: [], queuedCount: 1, activeCount: 0 }
      state.roots = state.roots.map(root => root.id === 'root-1'
        ? { ...root, thread: { ...root.thread, recovery: null, delivery: queued } }
        : root)
      state.threads.get('root-1').delivery = queued
      state.restarted = (state.restarted || 0) + 1
      return route.fulfill({ status: 202, json: { ok: true, state: 'queued' } })
    }
    if (pathname === '/api/channels/executions/execution-1/cancel' && request.method() === 'POST') {
      const execution = state.threads.get('root-1').executions.find(candidate => candidate.id === 'execution-1')
      execution.state = 'killed'
      execution.completedAt = NOW
      execution.error = 'Stopped by a channel member'
      state.cancelled = (state.cancelled || 0) + 1
      return route.fulfill({ json: { ok: true, state: 'killed' } })
    }
    if (pathname === '/api/rooms' && request.method() === 'GET') return route.fulfill({ json: state.roomSnapshot || { rooms: [] } })
    if (pathname === '/api/sessions' && request.method() === 'GET') return route.fulfill({ json: { sessions: state.sessions || [] } })
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
    state.threads.get('root-1').executions.unshift({
      id: 'execution-past',
      state: 'done',
      agent: caretaker,
      triggerMessageId: 'root-1',
      finalMessageId: 'reply-2',
      depth: 0,
      startedAt: NOW,
      completedAt: NOW,
      error: null,
    })
    await installChannels(page, state)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${BASE}/?app=fledge&surface=channels`)

    await expect(page.getByTestId('channels-home')).toBeVisible()
    await expect(page.getByRole('heading', { name: '#films7' })).toBeVisible()
    await expect(page.getByText('What dramatic question should the opening make impossible to ignore?')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Rooms', exact: true })).toBeVisible()
    await expect(page.getByText('👀 Coordinator is working', { exact: true })).toBeVisible()
    await expect(page.getByText('1 reply queued for Btw', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '4 members' }).click()
    await expect(page.getByText('Coordinator owns substantial work. Btw answers overflow while Coordinator is busy.')).toBeVisible()
    await expect(page.getByRole('button', { name: /Btw.*Helps while Coordinator is busy/ })).toBeVisible()
    await page.getByRole('button', { name: /Coordinator.*Main agent/ }).click()
    await expect(page.getByLabel('New channel message')).toBeFocused()
    await expect(page.getByLabel('New channel message')).toHaveValue('@coordinator ')
    await page.getByLabel('New channel message').fill('')
    const mainWidthBefore = await page.locator('.channels-main').evaluate(element => element.getBoundingClientRect().width)

    await page.getByRole('button', { name: /2 replies/ }).click()
    const inlineThread = page.getByRole('region', { name: /Expanded thread:/ })
    await expect(inlineThread).toBeVisible()
    await expect(page.locator('.channels-root')).not.toHaveClass(/channel-thread-open/)
    const mainWidthAfter = await page.locator('.channels-main').evaluate(element => element.getBoundingClientRect().width)
    expect(mainWidthAfter).toBe(mainWidthBefore)
    await expect(inlineThread.locator('.channel-message')).toHaveCount(2)
    const inlineReply = inlineThread.getByRole('textbox', { name: /Reply to thread:/ })
    await inlineReply.fill('Inline reply without leaving the timeline.')
    await inlineReply.press('Control+Enter')
    await expect(inlineThread.locator('.channel-message')).toHaveCount(3)

    await page.getByRole('button', { name: /Focus thread: The dramatic/ }).click()
    await expect(page.locator('.channels-root')).toHaveClass(/channel-thread-open/)
    await expect(page.getByRole('complementary', { name: 'Focused thread' })).toBeVisible()
    await expect(page.locator('.channel-thread-messages .channel-message')).toHaveCount(4)
    expect(await page.locator('.channel-thread-messages .channel-message').evaluateAll(elements =>
      elements.every(element => getComputedStyle(element).opacity === '1'))).toBe(true)
    await expect(page.locator('.channel-thread-pane').getByText('Agent', { exact: true }).first()).toBeVisible()
    await expect(page.getByRole('region', { name: 'Agents working now' })).toBeVisible()
    await expect(page.locator('.channel-active-work .channel-execution')).toContainText('@coordinator')
    await expect(page.locator('.channel-worklog')).not.toHaveAttribute('open', '')
    await expect(page.locator('.channel-worklog summary')).toContainText('Past agent activity · 1')
    await page.getByRole('button', { name: 'Peek', exact: true }).click()
    const livePeek = page.getByRole('complementary', { name: 'Live agent peek' })
    await expect(livePeek).toContainText('Opening the Blackboard gradebook…')
    await expect(livePeek).toContainText('Open Homework 1 submissions')
    await livePeek.getByRole('button', { name: 'Close live agent peek' }).click()
    await expect(livePeek).toHaveCount(0)

    const threadPane = page.locator('.channel-thread-pane')
    await threadPane.getByRole('button', { name: 'Stop', exact: true }).click()
    await threadPane.locator('.channel-worklog summary').click()
    await expect(threadPane.getByText('Stopped', { exact: true })).toBeVisible()
    await expect(threadPane.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
    expect(state.cancelled).toBe(1)
    await threadPane.locator('.channel-mention-row').getByRole('button', { name: '@caretaker' }).click()
    await expect(page.getByLabel('Thread reply')).toBeFocused()
    await expect(page.getByLabel('Thread reply')).toHaveValue('@caretaker ')
    await page.getByLabel('Thread reply').fill('')

    await threadPane.getByTitle('Edit thread title').click()
    await page.getByLabel('Thread title').fill('This title must not persist')
    await page.getByLabel('Thread title').press('Escape')
    await expect(threadPane.getByTitle('Edit thread title')).toContainText('The dramatic question in the opening')
    expect(state.threadPatches || 0).toBe(0)
    await threadPane.getByTitle('Edit thread title').click()
    await page.getByLabel('Thread title').fill('A sharper dramatic question')
    await page.getByLabel('Thread title').press('Enter')
    await expect(threadPane.getByTitle('Edit thread title')).toContainText('A sharper dramatic question')
    expect(state.threadPatches).toBe(1)

    await threadPane.getByRole('button', { name: 'Snooze', exact: true }).click()
    await expect(threadPane.getByRole('button', { name: 'Snoozed 1h', exact: true })).toBeVisible()
    await threadPane.getByRole('button', { name: 'Snoozed 1h', exact: true }).click()
    await expect(threadPane.getByRole('button', { name: 'Snooze', exact: true })).toBeVisible()


    await page.getByRole('button', { name: 'Close focused thread' }).click()
    const composer = page.getByLabel('New channel message')
    await composer.fill('Build a silent ending that earns the final held look.')
    await composer.press('Control+Enter')
    await expect(page.getByLabel('Reply to thread: Build a silent ending that earns the final held look.')).toBeVisible()
    expect(state.posts).toHaveLength(2)
  })

  test('the last thread click wins when earlier thread data arrives late', async ({ page }) => {
    const state = fixtureState()
    state.threadDelays = { 'root-1': 300, bridge: 10 }
    await installChannels(page, state)
    await page.goto(`${BASE}/?app=fledge&surface=channels&threadFilter=all`)

    await page.getByRole('button', { name: /Focus thread: The dramatic/ }).click()
    await page.getByRole('button', { name: 'Focus thread: Continuity bridge' }).click()
    const focused = page.getByRole('complementary', { name: 'Focused thread' })
    await expect(focused.getByTitle('Edit thread title')).toHaveText('Continuity bridge')
    await page.waitForTimeout(400)
    await expect(focused.getByTitle('Edit thread title')).toHaveText('Continuity bridge')
    await expect(page).toHaveURL(/thread=bridge/)
    const beforeVisibilityRefresh = state.channelGets
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))

    await expect.poll(() => state.channelGets).toBeGreaterThan(beforeVisibilityRefresh)
  })

  test('a closed deep-linked thread stays closed after live refreshes', async ({ page }) => {
    const state = fixtureState()
    await installChannels(page, state)
    await page.goto(`${BASE}/?app=fledge&surface=channels&channel=${channel.id}&thread=root-1`)
    await expect(page.getByRole('complementary', { name: 'Focused thread' })).toBeVisible()

    await page.getByRole('button', { name: 'Close focused thread' }).click()
    await expect(page).not.toHaveURL(/thread=/)
    const beforeVisibilityRefresh = state.channelGets
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await expect.poll(() => state.channelGets).toBeGreaterThan(beforeVisibilityRefresh)
    await expect(page.getByRole('complementary', { name: 'Focused thread' })).toHaveCount(0)
  })

  test('Activity behaves as a triage inbox rather than another feed', async ({ page }) => {
    const state = fixtureState()
    await installChannels(page, state)
    await page.setViewportSize({ width: 1180, height: 820 })
    await page.goto(`${BASE}/?app=fledge&surface=channels&view=activity`)

    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible()
    await expect(page.getByText('Coordinator replied as an agent')).toBeVisible()
    await expect(page.getByText('Agent · #films7')).toBeVisible()
    await page.locator('.channel-activity-open').click()
    await expect(page.getByRole('complementary', { name: 'Focused thread' })).toBeVisible()
    await expect(page).toHaveURL(/channel=channel-films7.*thread=root-1/)
    await page.getByRole('button', { name: 'Close focused thread' }).click()
    await page.locator('.channels-primary-nav button').first().click()
    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible()
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Nothing is waiting on you' })).toBeVisible()
  })

  test('opening a direct message clears its unread notification', async ({ page }) => {
    const state = fixtureState()
    const dm = {
      id: 'dm-caretaker', slug: null, title: 'Philip and Caretaker', description: '',
      type: 'dm', defaultAgentId: caretaker.id, createdAt: NOW, archivedAt: null,
      unread: 1, members: [philip, caretaker],
    }
    const dmRoot = {
      id: 'dm-root', channelId: dm.id, seq: 1, threadRootId: 'dm-root', replyToId: null,
      messageType: 'agent', content: 'I checked the work and left you one private note.',
      createdAt: NOW, editedAt: null, author: caretaker, metadata: {},
      thread: {
        title: 'Private note', state: 'open', replyCount: 0, updatedAt: NOW, unread: true,
        following: true, doneAt: null, snoozedUntil: null,
        delivery: { queuedAgents: [], activeAgents: [], queuedCount: 0, activeCount: 0 },
        recovery: null,
      },
      replies: [],
    }
    state.dm = dm
    state.dms = [dm]
    state.dmRoot = dmRoot
    state.dmRoots = [dmRoot]
    state.dmThread = {
      id: dmRoot.id, channelId: dm.id, title: dmRoot.thread.title, state: 'open',
      following: true, doneAt: null, snoozedUntil: null, messages: [dmRoot], executions: [],
    }
    state.activity = [{
      id: 'dm-notice', kind: 'direct_message', reason: 'Caretaker sent you a direct message',
      createdAt: NOW, readAt: null, doneAt: null,
      channel: { id: dm.id, slug: dm.slug, title: dm.title },
      thread: { id: dmRoot.id, title: dmRoot.thread.title, state: dmRoot.thread.state },
      messageId: dmRoot.id, preview: dmRoot.content, actor: caretaker,
    }]
    await installChannels(page, state)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${BASE}/?app=fledge&surface=channels&view=channels`)

    await expect(page).toHaveTitle('(1) Fledge')
    await page.locator('.channels-mobile-nav').getByRole('button', { name: 'DMs' }).click()
    let dmRow = page.getByRole('dialog', { name: 'Direct messages' }).getByRole('button', { name: /Caretaker/ })
    await expect(dmRow.locator('strong')).toHaveText('1')
    await dmRow.click()

    await expect(page.getByRole('heading', { name: 'Caretaker' })).toBeVisible()
    await expect.poll(() => state.dmReadRequests || 0).toBe(1)
    await expect(page).toHaveTitle('Fledge')
    await page.locator('.channels-mobile-nav').getByRole('button', { name: 'DMs' }).click()
    dmRow = page.getByRole('dialog', { name: 'Direct messages' }).getByRole('button', { name: /Caretaker/ })
    await expect(dmRow.locator('strong')).toHaveCount(0)
  })

  test('blank Peek identifies a stopped process and restarts the same turn', async ({ page }) => {
    const state = fixtureState()
    state.peek = {
      ...state.peek,
      activity: 'Agent process stopped.',
      steps: [],
      updatedAt: null,
      processActive: false,
      stalled: true,
      stalledReason: 'The agent process stopped before completing this turn.',
      canRestart: true,
    }
    await installChannels(page, state)
    await page.goto(`${BASE}/?app=fledge&surface=channels`)

    await page.getByRole('button', { name: /Focus thread: The dramatic/ }).click()
    await page.getByRole('button', { name: 'Peek', exact: true }).click()
    const livePeek = page.getByRole('complementary', { name: 'Live agent peek' })
    await expect(livePeek).toContainText('Attention needed')
    await expect(livePeek).toContainText('The agent process stopped before completing this turn.')
    await livePeek.getByRole('button', { name: 'Restart turn', exact: true }).click()

    await expect.poll(() => state.restarted).toBe(1)
    await expect(livePeek).toHaveCount(0)
    await expect(page.locator('.channel-sr-only')).toContainText('Agent turn restarted')
  })

  test('mobile exposes a failed root turn and collapses long messages without hiding recovery', async ({ page }) => {
    const state = fixtureState()
    const root = state.roots.find(candidate => candidate.id === 'root-1')
    root.content = `Long channel request. ${'Important context remains available. '.repeat(40)}`
    root.thread.state = 'needs_you'
    root.thread.delivery = { queuedAgents: [], activeAgents: [], queuedCount: 0, activeCount: 0 }
    root.thread.recovery = {
      id: 'execution-1',
      state: 'error',
      error: 'Agent exceeded the channel turn limit',
      agent: coordinator,
      canRestart: true,
    }
    const execution = state.threads.get('root-1').executions[0]
    execution.state = 'error'
    execution.error = root.thread.recovery.error
    execution.canRestart = true
    state.threads.get('root-1').delivery = root.thread.delivery
    await installChannels(page, state)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${BASE}/?app=fledge&surface=channels`)

    const messageBody = page.locator('.channel-message-body').filter({ hasText: 'Long channel request.' })
    await expect(page.getByRole('button', { name: 'Show full message' })).toBeVisible()
    expect(await messageBody.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    const recovery = page.locator('.channel-root-recovery')
    await expect(recovery).toContainText('Coordinator stopped.')
    await expect(recovery).toContainText('Agent exceeded the channel turn limit')

    await page.getByRole('button', { name: 'Show full message' }).click()
    await expect(page.getByRole('button', { name: 'Show less' })).toBeVisible()
    await recovery.getByRole('button', { name: 'Restart turn' }).click()
    await expect.poll(() => state.restarted).toBe(1)
    await expect(page.getByRole('status')).toHaveText('Restart queued for Coordinator.')
    expect(state.roots.find(candidate => candidate.id === 'root-1').thread.delivery.queuedCount).toBe(1)
  })

  test('collapsed roots replace image previews with a compact attachment summary', async ({ page }) => {
    const state = fixtureState()
    const root = state.roots.find(candidate => candidate.id === 'root-1')
    root.content = `Compare these screenshots.

![First screenshot](</api/channels/${channel.id}/attachments/first-shot>)

![Second screenshot](</api/channels/${channel.id}/attachments/second-shot>)`
    await installChannels(page, state)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${BASE}/?app=fledge&surface=channels`)

    const card = page.locator('.channel-message').filter({ hasText: 'Compare these screenshots.' })
    const summary = card.getByRole('button', { name: 'Show 2 images' })
    await expect(summary).toBeVisible()
    await expect(card.locator('.channel-message-body img')).toHaveCount(0)

    await summary.click()
    await expect(card.locator('.channel-message-body img')).toHaveCount(2)
    await expect(card.getByRole('button', { name: 'Hide replies' })).toBeVisible()
    await card.getByRole('button', { name: 'Hide replies' }).click()
    await expect(card.locator('.channel-message-body img')).toHaveCount(0)
    await expect(summary).toBeVisible()
  })

  test('keeps the foreground app icon badge synchronized with unread threads', async ({ page }) => {
    const state = fixtureState()
    const focused = state.threads.get('root-1')
    focused.messages = focused.messages.map((item, index) => ({ ...item, seq: index + 1 }))
    focused.lastReadSeq = 1
    await page.addInitScript(() => {
      window.__fledgeBadgeCalls = []
      Object.defineProperty(navigator, 'setAppBadge', {
        configurable: true,
        value: async count => { window.__fledgeBadgeCalls.push(['set', count]) },
      })
      Object.defineProperty(navigator, 'clearAppBadge', {
        configurable: true,
        value: async () => { window.__fledgeBadgeCalls.push(['clear']) },
      })
    })
    await installChannels(page, state)
    await page.goto(`${BASE}/?app=fledge&surface=channels`)

    await expect.poll(() => page.evaluate(() => window.__fledgeBadgeCalls)).toContainEqual(['set', 1])
    await page.getByRole('button', { name: /Focus thread: The dramatic/ }).click()
    await expect.poll(() => page.evaluate(() => window.__fledgeBadgeCalls)).toContainEqual(['clear'])
  })

  test('desktop dims settled read threads until they are expanded', async ({ page }) => {

    const state = fixtureState()
    const settled = state.roots.find(candidate => candidate.id === 'bridge')
    settled.messageType = 'human'
    settled.content = 'Settled reference thread'
    settled.thread.state = 'resolved'
    settled.thread.doneAt = NOW
    const urgent = state.roots.find(candidate => candidate.id === 'root-1')
    urgent.content = 'Unread decision thread'
    urgent.thread.state = 'needs_you'
    urgent.thread.mentioned = true
    urgent.thread.unread = true
    await installChannels(page, state)
    await page.goto(`${BASE}/?app=fledge&surface=channels&threadFilter=all`)

    const filters = page.getByRole('group', { name: 'Thread filters' })
    await expect(filters.getByRole('button', { name: /Needs attention/ })).toContainText('1')
    await expect(filters.getByRole('button', { name: /Mentions/ })).toContainText('1')
    await expect(filters.getByRole('button', { name: /Unread/ })).toContainText('1')
    await expect(filters.getByRole('button', { name: /Done/ })).toContainText('1')
    await expect(filters.getByRole('button', { name: /All/ })).toContainText('2')
    const settledCard = page.locator('.channel-message').filter({ hasText: 'Settled reference thread' })
    const urgentCard = page.locator('.channel-message').filter({ hasText: 'Unread decision thread' })
    await expect(settledCard).toHaveClass(/channel-message-settled/)
    await expect(settledCard).toHaveClass(/channel-message-read/)
    await expect(urgentCard).toHaveClass(/channel-message-needs-attention/)
    await expect(page.locator('.channel-timeline > .channel-message').first()).toContainText('Unread decision thread')
    expect(await settledCard.locator('.channel-message-content').evaluate(element => Number(getComputedStyle(element).opacity))).toBeLessThan(0.7)
    await settledCard.getByRole('button', { name: 'Reply', exact: true }).click()
    await expect(settledCard).toHaveClass(/channel-message-expanded/)
    await expect(settledCard.locator('.channel-message-content')).toHaveCSS('opacity', '1')
    await settledCard.getByRole('button', { name: 'Hide replies', exact: true }).click()
    expect(await settledCard.locator('.channel-message-content').evaluate(element => Number(getComputedStyle(element).opacity))).toBeLessThan(0.7)


    await filters.getByRole('button', { name: /Mentions/ }).click()
    await expect(page).toHaveURL(/threadFilter=mentions/)
    await expect(urgentCard).toBeVisible()
    await expect(settledCard).toHaveCount(0)
    await filters.getByRole('button', { name: /Done/ }).click()
    await expect(settledCard).toBeVisible()
    await expect(urgentCard).toHaveCount(0)
    await filters.getByRole('button', { name: /Needs attention/ }).click()
    await expect(page).toHaveURL(/threadFilter=needs/)
    await page.getByRole('button', { name: 'Threads', exact: true }).click()
    await expect(page.getByRole('group', { name: 'Thread filters' }).getByRole('button', { name: /Needs attention/ })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.channel-thread-index-row')).toHaveCount(1)
    await page.reload()
    await expect(page.getByRole('group', { name: 'Thread filters' }).getByRole('button', { name: /Needs attention/ })).toHaveAttribute('aria-pressed', 'true')
  })
  test('focused unread threads resume at new work with bounded context', async ({ page }) => {
    const state = fixtureState()
    const root = state.roots.find(candidate => candidate.id === 'root-1')
    root.thread.replyCount = 12
    root.thread.unread = true
    const replies = Array.from({ length: 12 }, (_, index) => ({
      ...message(`history-${index + 1}`, index % 2 ? caretaker : coordinator,
        `${index < 7 ? 'Historical' : 'Unread'} reply ${index + 1}`, root.id),
      seq: index + 2,
    }))
    root.replies = replies.slice(-3)
    const focused = state.threads.get(root.id)
    focused.lastReadSeq = 8
    focused.messages = [{ ...root, seq: 1 }, ...replies]
    focused.executions = []
    const bridge = state.roots.find(candidate => candidate.id === 'bridge')
    bridge.messageType = 'human'
    bridge.thread.unread = true
    state.threads.get('bridge').lastReadSeq = 0
    await installChannels(page, state)
    await page.setViewportSize({ width: 1180, height: 820 })
    await page.goto(`${BASE}/?app=fledge&surface=channels`)

    await page.getByRole('button', { name: /Focus thread: The dramatic/ }).click()
    const pane = page.getByRole('complementary', { name: 'Focused thread' })
    await expect(pane).toContainText('5 new')
    await expect(pane.getByText('Historical reply 1', { exact: true })).toHaveCount(0)
    await expect(pane.getByText('Historical reply 6', { exact: true })).toBeVisible()
    await expect(pane.locator('.channel-unread-divider')).toHaveText('New since your last visit')
    await expect(pane.locator('.channel-unread-divider + .channel-message')).toContainText('Unread reply 8')
    await expect(pane.getByRole('button', { name: 'Show 6 earlier messages' })).toBeVisible()

    await pane.getByRole('button', { name: 'Show 6 earlier messages' }).click()
    await expect(pane.getByText('Historical reply 1', { exact: true })).toBeVisible()
    await pane.getByRole('button', { name: '← Previous unread' }).click()
    await expect(pane.getByTitle('Edit thread title')).toContainText('Continuity bridge')
    await pane.getByRole('button', { name: 'Next unread →' }).click()
    await expect(pane.getByTitle('Edit thread title')).toContainText('The dramatic question')
  })

  test('mobile attention filter has a useful caught-up state', async ({ page }) => {
    const state = fixtureState()
    for (const root of state.roots) {
      root.thread.unread = false
      root.thread.state = 'resolved'
      root.thread.doneAt = NOW
      root.thread.recovery = null
      root.thread.delivery = { queuedAgents: [], activeAgents: [], queuedCount: 0, activeCount: 0 }
    }
    await installChannels(page, state)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${BASE}/?app=fledge&surface=channels&threadFilter=needs`)

    await expect(page.getByRole('status')).toContainText('Nothing needs you')
    await expect(page.getByRole('status')).toContainText('Unread replies, decisions, and failures will appear here.')
    await page.getByRole('button', { name: 'Show all threads' }).click()
    await expect(page).not.toHaveURL(/threadFilter=/)
    await expect(page.locator('.channel-message')).toHaveCount(2)
  })

  test('shows channel agent staffing while creation is pending and opens the staffed channel', async ({ page }) => {
    const state = fixtureState()
    const fairfieldCoordinator = { ...coordinator, id: 'agent:fairfield:coordinator', username: 'fairfield-coordinator' }
    const fairfieldBtw = { ...btw, id: 'agent:fairfield:btw', username: 'fairfield-btw' }
    const fairfieldCaretaker = { ...caretaker, id: 'agent:fairfield:caretaker', username: 'fairfield-caretaker' }
    state.createdChannel = {
      ...channel,
      id: 'channel-fairfield',
      slug: 'fairfield',
      title: 'Fairfield',
      defaultAgentId: fairfieldCoordinator.id,
      members: [philip, fairfieldCoordinator, fairfieldCaretaker, fairfieldBtw],
    }
    let releaseStaffing = () => {}
    state.channelCreateGate = new Promise(resolve => { releaseStaffing = resolve })
    await installChannels(page, state)
    await page.goto(`${BASE}/?app=fledge&surface=channels`)

    await page.getByRole('button', { name: 'Create channel', exact: true }).click()
    await page.getByRole('textbox', { name: 'Channel name' }).fill('Fairfield')
    await page.locator('.channel-dialog-submit').click()
    await expect(page.getByRole('button', { name: 'Adding agents…' })).toBeVisible()
    releaseStaffing()

    const memberCluster = page.getByLabel('4 members')
    await expect(memberCluster).toBeVisible()
    await expect(memberCluster.locator('[title="Coordinator · agent"]')).toBeVisible()
    await expect(memberCluster.locator('[title="Btw · agent"]')).toBeVisible()
    await expect(memberCluster.locator('[title="Caretaker · agent"]')).toBeVisible()
  })

  test('a created channel survives overlapping live refreshes', async ({ page }) => {
    const state = fixtureState()
    state.createdChannel = {
      ...channel,
      id: 'channel-overlap',
      slug: 'overlap',
      title: 'Overlap',
      unread: 0,
    }
    let releaseFirstRefresh = () => {}
    let releaseSecondRefresh = () => {}
    state.channelGetGates = {
      2: new Promise(resolve => { releaseFirstRefresh = resolve }),
      3: new Promise(resolve => { releaseSecondRefresh = resolve }),
    }
    await installChannels(page, state)
    await page.goto(`${BASE}/?app=fledge&surface=channels`)

    await page.getByRole('button', { name: 'Create channel', exact: true }).click()
    await page.getByRole('textbox', { name: 'Channel name' }).fill('Overlap')
    await page.locator('.channel-dialog-submit').click()
    await expect.poll(() => state.channelGets).toBe(2)
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await expect.poll(() => state.channelGets).toBe(3)
    releaseFirstRefresh()
    await expect.poll(() => new URL(page.url()).searchParams.get('channel')).toBe(state.createdChannel.id)
    releaseSecondRefresh()

    await expect(page.getByRole('heading', { name: '#overlap' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Create your first channel' })).toHaveCount(0)
  })

  test('keeps a created channel visible when agent staffing fails', async ({ page }) => {
    const state = fixtureState()
    state.createdChannel = {
      ...channel,
      id: 'channel-partial',
      slug: 'partial',
      title: 'Partial',
      defaultAgentId: null,
      unread: 0,
      members: [philip],
    }
    state.staffing = { status: 'failed', agents: [], error: 'OMP unavailable' }
    await installChannels(page, state)
    await page.goto(`${BASE}/?app=fledge&surface=channels`)

    await page.getByRole('button', { name: 'Create channel', exact: true }).click()
    await page.getByRole('textbox', { name: 'Channel name' }).fill('Partial')
    await page.locator('.channel-dialog-submit').click()

    await expect(page.getByRole('heading', { name: '#partial' })).toBeVisible()
    await expect(page.getByText('Channel created, but its agents could not start: OMP unavailable')).toBeVisible()
  })

  test('dialogs, empty DMs, and Escape behavior match their labels', async ({ page }) => {
    const state = fixtureState()
    await installChannels(page, state)
    await page.setViewportSize({ width: 1180, height: 820 })
    await page.goto(`${BASE}/?app=fledge&surface=channels`)

    await page.getByRole('button', { name: 'Create channel', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Create a channel' })).toBeVisible()
    await page.getByRole('textbox', { name: 'Channel name' }).press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    await page.getByRole('button', { name: 'Invite', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Invite a human' })).toBeVisible()
    await page.getByRole('textbox', { name: 'Username' }).press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    await page.getByRole('button', { name: 'Start direct message', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Start a direct message' })).toBeVisible()
    await expect(page.getByRole('button', { name: /Caretaker Agent/ })).toBeVisible()
    await page.getByRole('button', { name: 'Close', exact: true }).click()

    await page.goto(`${BASE}/?app=fledge&surface=channels&view=dms`)
    await expect(page.getByRole('heading', { name: 'No direct messages yet' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '#films7' })).toHaveCount(0)
  })

  test('waits for shared identity before mounting role-specific navigation', async ({ page }) => {
    const state = fixtureState()
    state.authDelay = 400
    state.user = { username: 'maya', admin: false }
    state.principal = { ...philip, id: 'human:maya', username: 'maya', displayName: 'Maya', role: 'member' }
    await installChannels(page, state)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${BASE}/?app=fledge&surface=channels`)

    await expect(page.locator('.channels-boot')).toBeVisible()
    await expect(page.getByTestId('channels-home')).toBeVisible()
    await expect(page.locator('.channels-root')).not.toHaveClass(/channels-root-personal/)
    await expect(page.locator('.channels-mobile-nav').getByRole('button', { name: 'Runs' })).toHaveCount(0)
  })

  test('mobile makes every channel directly discoverable without a global hamburger', async ({ page }) => {
    const state = fixtureState()
    state.channels = [
      channel,
      {
        ...channel,
        id: 'channel-operations',
        slug: 'operations',
        title: 'Operations',
        description: 'Shipping, incidents, and fleet work.',
        unread: 3,
      },
    ]
    state.roomSnapshot = {
      rooms: [{
        name: 'navigation-room',
        cwd: '/home/user/rooms/navigation-room',
        sessions: [{ id: 'leader-navigation', title: '#navigation-room Leader', updatedAt: NOW, isActive: true, agent: 'omp' }],
        leaderSessionId: 'leader-navigation',
        residents: [
          { role: 'leader', sessionId: 'leader-navigation', agent: 'omp', title: '#navigation-room Leader', status: 'working' },
          { role: 'caretaker', sessionId: 'caretaker-navigation', agent: 'omp', title: '#navigation-room Caretaker', status: 'waiting' },
        ],
        sidecarGroupId: 'room-navigation-room',
        active: true,
        latest: null,
        updatedAt: NOW,
        updates: { count: 0, latestAt: null, latest: null },
        friction: { count: 0, latestAt: null, latest: null },
        pulse: { enabled: false, status: 'paused', lastRunAt: null, nextRunAt: null, sessionId: null },
      }],
    }
    state.sessions = [
      { id: 'user-chat', title: 'Visible user chat', updatedAt: NOW, isActive: false, agent: 'omp', cwd: '/home/user/rooms/navigation-room' },
      { id: 'channel-agent-chat', title: '<channel-turn execution=\"internal\">', updatedAt: NOW, isActive: true, agent: 'omp', cwd: '/home/user/.feather/channel-workspaces/films7-coordinator' },
    ]
    await installChannels(page, state)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${BASE}/?app=fledge&surface=channels`)

    await expect(page.getByRole('button', { name: 'Open Fledge navigation' })).toHaveCount(0)
    await page.getByRole('button', { name: 'All channels', exact: true }).click()
    const directory = page.getByRole('dialog', { name: 'All channels' })
    await expect(directory).toBeVisible()
    await expect(directory.getByText('films7', { exact: true })).toBeVisible()
    await expect(directory.getByText('operations', { exact: true })).toBeVisible()
    await expect(directory.getByText('3', { exact: true })).toBeVisible()
    await directory.getByRole('button', { name: 'New channel', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Create a channel' })).toBeVisible()
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByLabel('New channel message').fill('Draft survives workspace navigation')
    const mobileNav = page.locator('.channels-mobile-nav')
    const activityButton = mobileNav.getByRole('button', { name: 'Activity 1', exact: true })
    const [activityBox, badgeBox] = await Promise.all([activityButton.boundingBox(), activityButton.locator('b').boundingBox()])
    expect(activityBox).not.toBeNull()
    expect(badgeBox).not.toBeNull()
    expect(badgeBox.x).toBeGreaterThanOrEqual(activityBox.x)
    expect(badgeBox.x + badgeBox.width).toBeLessThanOrEqual(activityBox.x + activityBox.width)
    await mobileNav.getByRole('button', { name: 'Channels', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'All channels' })).toBeVisible()
    await page.getByRole('button', { name: 'Close all channels' }).click()
    await expect(mobileNav.getByRole('button', { name: 'Rooms', exact: true })).toBeVisible()
    await mobileNav.getByRole('button', { name: 'Rooms', exact: true }).click()
    await expect(page).toHaveURL(/surface=rooms/)
    await expect(page.getByText('#navigation-room', { exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Open Fledge navigation' }).click()
    await page.getByRole('navigation', { name: 'Fledge destinations' }).getByRole('button', { name: 'Channels', exact: true }).click()
    await expect(page).toHaveURL(/surface=channels/)
    await expect(page.getByRole('heading', { name: '#films7' })).toBeVisible()
    await expect(page.getByLabel('New channel message')).toHaveValue('Draft survives workspace navigation')
  })

  test('notification denial becomes an honest disabled state', async ({ page }) => {
    const state = fixtureState()
    await page.addInitScript(() => {
      Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'denied' })
    })
    await installChannels(page, state)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${BASE}/?app=fledge&surface=channels&view=activity`)

    const alerts = page.getByRole('button', { name: 'Alerts', exact: true })
    await alerts.click()
    const blocked = page.getByRole('button', { name: 'Alerts blocked', exact: true })
    await expect(blocked).toBeDisabled()
    await expect(blocked).toHaveAttribute('title', 'Allow notifications in browser settings')
  })

  test('mobile supports inline replies and a full-screen focused thread', async ({ page }) => {
    const state = fixtureState()
    const longResult = `Continuity audit begins here. ${'A verified detail follows. '.repeat(120)}`
    state.threads.get('root-1').messages.at(-1).content = longResult
    state.roots[1].replies.at(-1).content = longResult
    await installChannels(page, state)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${BASE}/?app=fledge&surface=channels`)

    const mobileNav = page.locator('.channels-mobile-nav')
    await expect(mobileNav.getByRole('button', { name: 'Activity' })).toBeVisible()
    await expect(mobileNav.getByRole('button', { name: 'Channels' })).toBeVisible()
    await expect(mobileNav.getByRole('button', { name: 'Threads' })).toBeVisible()
    await expect(mobileNav.getByRole('button', { name: 'DMs' })).toBeVisible()

    await page.getByRole('button', { name: /2 replies/ }).click()
    await expect(page.getByRole('region', { name: /Expanded thread:/ })).toBeVisible()
    await page.getByRole('button', { name: /Focus thread: The dramatic/ }).click()
    const pane = page.locator('.channel-thread-pane')
    await expect(pane).toBeVisible()
    await expect(pane).toHaveCSS('position', 'absolute')
    await expect(pane.getByText('Continuity audit begins here.', { exact: false })).toBeVisible()
    const scrollerBox = await pane.locator('.channel-thread-messages').boundingBox()
    const latestBox = await pane.locator('.channel-thread-messages .channel-message').last().boundingBox()
    expect(latestBox.y).toBeGreaterThanOrEqual(scrollerBox.y - 1)
    expect(latestBox.y).toBeLessThan(scrollerBox.y + scrollerBox.height)
    await pane.getByRole('button', { name: 'Close focused thread' }).click()
    await expect(pane).toHaveCount(0)
  })

  test('mobile composer shows typed text and sends pasted images', async ({ page }) => {
    const state = fixtureState()
    await installChannels(page, state)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${BASE}/?app=fledge&surface=channels`)

    const composer = page.getByLabel('New channel message')
    await composer.fill('Visible on iPhone')
    await expect(composer).toHaveValue('Visible on iPhone')
    await expect(composer).toHaveCSS('font-size', '16px')
    expect(await composer.evaluate(element => getComputedStyle(element).webkitTextFillColor)).toBe('rgb(24, 33, 30)')
    await page.evaluate(() => document.documentElement.style.setProperty('--vh', '4px'))
    const compactComposer = await page.locator('.channel-compose-wrap').first().boundingBox()
    const compactNav = await page.locator('.channels-mobile-nav').boundingBox()
    expect(compactComposer.y + compactComposer.height).toBeLessThanOrEqual(compactNav.y + 1)
    await expect(composer).toBeVisible()
    await page.evaluate(() => document.documentElement.style.setProperty('--vh', '8.44px'))
    await expect(page.getByRole('button', { name: 'Attach images' })).toBeVisible()
    const fileChooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Attach images' }).click()
    await (await fileChooser).setFiles({
      name: 'selected.png',
      mimeType: 'image/png',
      buffer: Buffer.from('selected-image'),
    })
    await expect(page.locator('.channel-image-preview')).toHaveCount(1)
    await page.getByRole('button', { name: 'Remove selected.png' }).click()
    await expect(page.locator('.channel-image-preview')).toHaveCount(0)

    await composer.fill('')
    await composer.evaluate(element => {
      const clipboard = new DataTransfer()
      clipboard.setData('text/plain', 'See the keyboard screenshot.')
      clipboard.items.add(new File(['image-bytes'], 'mobile-screenshot.png', { type: 'image/png' }))
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }))
    })

    await expect(composer).toHaveValue('See the keyboard screenshot.')
    await expect(page.locator('.channel-image-preview')).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled()
    await page.getByRole('button', { name: 'Send message' }).click()

    await expect.poll(() => state.attachments.length).toBe(1)
    await expect.poll(() => state.posts.length).toBe(1)
    expect(state.attachments[0].filename).toBe('mobile-screenshot.png')
    expect(state.attachments[0].byteSize).toBe(11)
    expect(state.posts[0].content).toContain('See the keyboard screenshot.')
    expect(state.posts[0].content).toContain(`/api/channels/${channel.id}/attachments/${state.attachments[0].id}`)
    await expect(page.locator('.channel-image-preview')).toHaveCount(0)
    await expect(page.locator('.channel-timeline .markdown img[alt="mobile-screenshot.png"]')).toBeVisible()
  })
})
