// @ts-check
import { test, expect } from '@playwright/test'

const BASE = process.env.FEATHER_URL || 'http://localhost:4870'

const ROOM_FIXTURE = {
  rooms: [{
    name: 'instant-room',
    cwd: '/home/user/rooms/instant-room',
    sessions: [{
      id: 'pulse-session', title: 'Keep working: #instant-room', updatedAt: '2026-08-22T12:00:00Z',
      isActive: true, agent: 'omp',
    }],
    active: true,
    latest: { role: 'user', text: '<file name="/tmp/pulse.md">Keep working on this room.</file>' },
    updatedAt: '2026-08-22T12:00:00Z',
    pulse: { enabled: false, status: 'paused', lastRunAt: null, nextRunAt: null, sessionId: 'pulse-session' },
  }],
}

test('renders the last Rooms snapshot while its refresh is still pending', async ({ page }) => {
  let requests = 0
  let holdRefresh = false
  let releaseRefresh = () => {}
  const refreshGate = new Promise(resolve => { releaseRefresh = resolve })

  await page.route('**/api/rooms', async route => {
    requests++
    if (holdRefresh) await refreshGate
    await route.fulfill({ json: ROOM_FIXTURE })
  })

  await page.goto(BASE)
  const card = page.getByText('#instant-room', { exact: true })
  await expect(card).toBeVisible()
  expect(requests).toBe(1) // App warm-up and RoomsHome share one request.

  holdRefresh = true
  const refreshed = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/rooms' && response.ok())
  await page.reload({ waitUntil: 'domcontentloaded' })

  // A network-only implementation would still show "Loading rooms…" here
  // until releaseRefresh runs.
  await expect(card).toBeVisible({ timeout: 500 })
  expect(requests).toBe(2)

  releaseRefresh()
  await refreshed
})

test('serves fingerprinted frontend assets as immutable', async ({ page }) => {
  await page.goto(BASE)
  const source = await page.locator('script[type="module"][src]').getAttribute('src')
  expect(source).toBeTruthy()
  const response = await page.request.get(new URL(source, page.url()).href)
  expect(response.headers()['cache-control']).toContain('max-age=31536000')
  expect(response.headers()['cache-control']).toContain('immutable')
})

test('puts OMP, Claude Code, and Codex on the Rooms home and hides pulse worker internals', async ({ page }) => {
  let createdSession
  await page.route('**/api/rooms', route => route.fulfill({ json: ROOM_FIXTURE }))
  await page.route('**/api/agents', route => route.fulfill({ json: { agents: [
    { id: 'claude', label: 'Claude Code', available: true },
    { id: 'codex', label: 'Codex', available: true },
    { id: 'omp', label: 'oh-my-pi', available: true, default: true },
  ] } }))
  await page.route('**/api/sessions', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    createdSession = JSON.parse(route.request().postData() || '{}')
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'unused', status: 'starting' }) })
  })
  await page.route('**/api/rooms/*/assign', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, assignments: {} }) }))

  await page.goto(BASE)
  await expect(page.getByTestId('new-chat-launcher')).toBeVisible()
  await page.getByText('New chat outside a Room', { exact: true }).click()
  await expect(page.getByRole('button', { name: '+ OMP' })).toBeVisible()
  await expect(page.getByRole('button', { name: '+ Claude Code' }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: '+ Codex' }).first()).toBeVisible()
  await expect(page.getByTestId('background-work-status')).toContainText('all paused')
  await expect(page.getByText('pulse.md')).toHaveCount(0)
  await expect(page.getByText('Keep working: #instant-room')).toHaveCount(0)
  await page.getByTestId('history-instant-room').click()
  await expect(page.getByRole('button', { name: '+ Start OMP Leader' })).toBeVisible()
  await page.getByText('Room options', { exact: true }).click()
  await expect(page.getByRole('button', { name: 'Claude Code', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Codex', exact: true })).toBeVisible()
  const harness = page.getByLabel('Default harness for #instant-room')
  await expect(harness).toHaveValue('omp')
  await harness.selectOption('codex')
  await expect(page.getByRole('button', { name: '+ Start OMP Leader' })).toBeVisible()
  await harness.selectOption('omp')

  await page.getByRole('button', { name: '+ Start OMP Leader' }).click()
  await expect.poll(() => createdSession).toMatchObject({
    agent: 'omp',
    roomName: 'instant-room',
    roomRole: 'leader',
  })
})

test('stops background work in every enabled room from one visible control', async ({ page }) => {
  const stopped = []
  const rooms = ['first-room', 'second-room'].map(name => ({
    name, cwd: `/home/user/rooms/${name}`, sessions: [], active: false, latest: null, updatedAt: null,
    pulse: { enabled: true, status: 'waiting', lastRunAt: null, nextRunAt: '2026-08-22T12:15:00Z', sessionId: null },
  }))
  await page.route('**/api/rooms', route => route.fulfill({ json: { rooms } }))
  await page.route('**/api/rooms/*/pulse', async route => {
    stopped.push(new URL(route.request().url()).pathname.split('/')[3])
    await route.fulfill({ json: { ok: true, pulse: { enabled: false, status: 'paused', lastRunAt: null, nextRunAt: null, sessionId: null } } })
  })

  await page.goto(BASE)
  await page.getByText('New chat outside a Room', { exact: true }).click()
  await expect(page.getByTestId('background-work-status')).toContainText('2 rooms enabled')
  await page.getByTestId('pause-all-background').click()
  await expect.poll(() => stopped.sort()).toEqual(['first-room', 'second-room'])
  await expect(page.getByTestId('background-work-status')).toContainText('all paused')
  await expect(page.getByTestId('pause-all-background')).toHaveCount(0)
})
