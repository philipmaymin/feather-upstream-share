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
  await expect(page.getByTestId('pulse-marriage')).toHaveText('Keep working')
  await page.getByTestId('pulse-marriage').click()
  await expect(page.getByTestId('pulse-marriage')).toHaveText('Paused')
  await page.locator('button:has-text("›")').click()
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

test('shows room updates newest-first and remembers that they were read', async ({ page }) => {
  const room = {
    name: 'briefings', cwd: '/srv/zak/home/rooms/briefings', active: false,
    latest: null, updatedAt: '2026-08-22T12:00:00Z', sessions: [],
    pulse: { enabled: false, status: 'paused', lastRunAt: null, nextRunAt: null, sessionId: null },
    updates: { count: 2, latestAt: '2026-08-22T12:00:00Z', latest: 'Second outcome.' },
  }
  await page.route('**/api/rooms', route => route.fulfill({ json: { rooms: [room] } }))
  await page.route('**/api/rooms/briefings/updates', route => route.fulfill({ json: { updates: [
    { id: 'first', ts: '2026-08-22T11:00:00Z', text: 'First outcome.' },
    { id: 'second', ts: '2026-08-22T12:00:00Z', text: 'Second outcome.' },
  ] } }))

  await page.goto(BASE)
  const button = page.getByTestId('updates-briefings')
  await expect(button).toContainText('2 new')
  await button.click()
  const panel = page.getByTestId('updates-panel-briefings')
  await expect(panel).toBeVisible()
  await expect(panel.locator('div').filter({ hasText: 'Second outcome.' }).last()).toBeVisible()
  const entries = panel.getByTestId('room-update')
  await expect(entries.first()).toContainText('Second outcome.')
  await expect(button).not.toContainText('new')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('feather:roomUpdatesSeen') || '{}').briefings)).toBe(2)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('updates-briefings')).not.toContainText('new')
})
