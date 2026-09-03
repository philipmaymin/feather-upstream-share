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
    thread: { title: 'Continuity bridge', state: 'open', replyCount: 0, updatedAt: NOW, unread: false, following: true, doneAt: null, snoozedUntil: null, delivery: { queuedAgents: [], activeAgents: [], queuedCount: 0, activeCount: 0 } },
    replies: [],
  }
  const root = {
    ...message('root-1', philip, 'What dramatic question should the opening make impossible to ignore?'),
    thread: { title: 'The dramatic question in the opening', state: 'working', replyCount: 2, updatedAt: NOW, unread: true, following: true, doneAt: null, snoozedUntil: null, delivery: { queuedAgents: [btw], activeAgents: [coordinator], queuedCount: 1, activeCount: 1 } },
    replies: [
      message('reply-1', coordinator, 'The opening should ask whether she will trade the truth for belonging.', 'root-1'),
      message('reply-2', caretaker, 'Continuity holds if the unopened letter remains visible in both shots.', 'root-1'),
    ],
  }
  const threads = new Map([
    ['bridge', { id: 'bridge', channelId: channel.id, title: 'Continuity bridge', state: 'open', following: true, doneAt: null, snoozedUntil: null, messages: [bridge], executions: [] }],
    ['root-1', {
      id: 'root-1', channelId: channel.id, title: 'The dramatic question in the opening', state: 'working', following: true, doneAt: null, snoozedUntil: null,
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
      return route.fulfill({ json: { channels: state.channels || [channel], dms: [], principal: state.principal || philip } })
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
    if (pathname === '/api/channels/executions/execution-1/peek' && request.method() === 'GET') {
      return route.fulfill({ json: state.peek })
    }
    if (pathname === '/api/channels/executions/execution-1/restart' && request.method() === 'POST') {
      const execution = state.threads.get('root-1').executions.find(candidate => candidate.id === 'execution-1')
      execution.state = 'error'
      execution.completedAt = NOW
      execution.error = 'Restarted by a channel member'
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
    await page.goto(`${BASE}/?app=fledge&surface=channels`)

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

  test('mobile exposes channel creation and primary workspace destinations', async ({ page }) => {
    const state = fixtureState()
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

    await page.getByRole('button', { name: 'New channel', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Create a channel' })).toBeVisible()
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByLabel('New channel message').fill('Draft survives workspace navigation')
    await expect(page.locator('.channels-mobile-nav').getByRole('button', { name: 'Rooms', exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Open Fledge navigation' }).click()
    const destinations = page.getByRole('navigation', { name: 'Fledge destinations' })
    await expect(destinations.getByRole('button', { name: 'Channels', exact: true })).toHaveAttribute('aria-current', 'page')
    await expect(page.getByText('Visible user chat', { exact: true })).toBeVisible()
    await expect(page.getByText(/channel-turn execution/)).toHaveCount(0)
    await expect(destinations.getByRole('button', { name: 'Rooms', exact: true })).toBeVisible()
    await expect(destinations.getByRole('button', { name: 'Runs', exact: true })).toBeVisible()
    await destinations.getByRole('button', { name: 'Rooms', exact: true }).click()
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
