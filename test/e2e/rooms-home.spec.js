// @ts-check
import { test, expect } from '@playwright/test'

const BASE = process.env.FEATHER_URL || 'http://localhost:4870'

const ROOM_FIXTURE = {
  rooms: [{
    name: 'instant-room',
    cwd: '/home/user/rooms/instant-room',
    sessions: [],
    active: false,
    latest: null,
    updatedAt: null,
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

test('makes OMP the primary new-room chat and keeps room harness controls one level down', async ({ page }) => {
  let createdAgent
  await page.route('**/api/rooms', route => route.fulfill({ json: ROOM_FIXTURE }))
  await page.route('**/api/sessions', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    createdAgent = JSON.parse(route.request().postData() || '{}').agent
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'unused', status: 'starting' }) })
  })
  await page.route('**/api/rooms/*/assign', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, assignments: {} }) }))

  await page.goto(BASE)
  await page.getByText('#instant-room', { exact: true }).click()
  await expect(page.getByRole('button', { name: '+ New OMP chat' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Claude Code' })).not.toBeVisible()
  await page.getByText('Room options', { exact: true }).click()
  await expect(page.getByRole('button', { name: 'Claude Code' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Codex' })).toBeVisible()
  const harness = page.getByLabel('Default harness for #instant-room')
  await expect(harness).toHaveValue('omp')
  await harness.selectOption('codex')
  await expect(page.getByRole('button', { name: '+ New Codex chat' })).toBeVisible()
  await harness.selectOption('omp')

  await page.getByRole('button', { name: '+ New OMP chat' }).click()
  await expect.poll(() => createdAgent).toBe('omp')
})
