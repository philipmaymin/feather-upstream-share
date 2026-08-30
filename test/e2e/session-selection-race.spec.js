// @ts-check
import { test, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'

const BASE = process.env.FEATHER_URL || 'http://localhost:4870'
const HOME = process.env.HOME || '/home/user'
const CLAUDE_PROJECTS = path.join(HOME, '.claude/projects')
const RUN_ID = Date.now()
const FILM_ID = `e2e-selection-film-${RUN_ID}`
const TARGET_ID = `e2e-selection-target-${RUN_ID}`
const FILM_TITLE = `Film selection race ${RUN_ID}`
const TARGET_TITLE = `Compelle selection target ${RUN_ID}`
const FILM_MESSAGE = `FILM_CONTEXT_MUST_NOT_LEAK_${RUN_ID}`
const TARGET_MESSAGE = `COMPELLE_CONTEXT_MUST_STAY_${RUN_ID}`
/** @type {string[]} */
let fixturePaths = []

function writeSession(file, title, assistantMessage) {
  const lines = [
    {
      type: 'user', uuid: `${path.basename(file)}-user`, timestamp: '2026-08-23T13:24:40Z',
      isSidechain: false, isMeta: false,
      message: { role: 'user', content: title },
    },
    {
      type: 'assistant', uuid: `${path.basename(file)}-assistant`, timestamp: '2026-08-23T13:24:49Z',
      isSidechain: false, isMeta: false,
      message: { role: 'assistant', content: [{ type: 'text', text: assistantMessage }] },
    },
  ]
  fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n')
}

test.beforeAll(() => {
  const projectDir = fs.readdirSync(CLAUDE_PROJECTS)
    .map(name => path.join(CLAUDE_PROJECTS, name))
    .find(candidate => fs.statSync(candidate).isDirectory())
  if (!projectDir) throw new Error('No project dirs in ~/.claude/projects/')
  fixturePaths = [path.join(projectDir, `${FILM_ID}.jsonl`), path.join(projectDir, `${TARGET_ID}.jsonl`)]
  writeSession(fixturePaths[0], FILM_TITLE, FILM_MESSAGE)
  writeSession(fixturePaths[1], TARGET_TITLE, TARGET_MESSAGE)
})

test.afterAll(() => {
  for (const file of fixturePaths) {
    try { fs.unlinkSync(file) } catch {}
  }
})

test('late transcript responses cannot cross chat identity or receive a send', async ({ page }) => {
  /** @type {() => void} */
  let releaseFilm
  /** @type {() => void} */
  let releaseTarget
  const filmGate = new Promise(resolve => { releaseFilm = resolve })
  const targetGate = new Promise(resolve => { releaseTarget = resolve })
  const sentTo = []

  await page.route(`**/api/sessions/${FILM_ID}/messages*`, async route => {
    await filmGate
    await route.continue().catch(() => {})
  })
  await page.route(`**/api/sessions/${TARGET_ID}/messages*`, async route => {
    await targetGate
    await route.continue().catch(() => {})
  })
  await page.route(`**/api/sessions/${FILM_ID}/send`, async route => {
    sentTo.push(FILM_ID)
    await route.fulfill({ json: { ok: true, sentAt: new Date().toISOString() } })
  })
  await page.route(`**/api/sessions/${TARGET_ID}/send`, async route => {
    sentTo.push(TARGET_ID)
    await route.fulfill({ json: { ok: true, sentAt: new Date().toISOString() } })
  })
  await page.route(`**/api/sessions/${TARGET_ID}/resume`, route => route.fulfill({ json: { ok: true } }))

  await page.goto(BASE)
  await expect(page.getByText('Feather', { exact: true }).last()).toBeVisible({ timeout: 10000 })

  await page.locator('button:has-text("☰")').click()
  await page.getByText(FILM_TITLE, { exact: true }).click()
  const composer = page.locator('textarea')
  await expect(composer).toBeDisabled()
  await expect(composer).toHaveAttribute('placeholder', 'Loading chat…')

  await page.locator('button:has-text("☰")').click()
  await page.getByText(TARGET_TITLE, { exact: true }).click()
  await expect(page.locator('span').filter({ hasText: TARGET_TITLE }).last()).toBeVisible()
  await expect(composer).toBeDisabled()
  await expect(page.locator('button:has(svg polygon)')).toBeDisabled()
  expect(sentTo).toEqual([])

  releaseTarget()
  await expect(page.getByText(TARGET_MESSAGE, { exact: true })).toBeVisible()
  await expect(composer).toBeEnabled()
  await expect(composer).toHaveAttribute('placeholder', 'Send a message...')

  releaseFilm()
  await page.waitForTimeout(400)
  await expect(page.getByText(FILM_MESSAGE, { exact: true })).toHaveCount(0)
  await expect(page.getByText(TARGET_MESSAGE, { exact: true })).toBeVisible()
  await expect(page.locator('span').filter({ hasText: TARGET_TITLE }).last()).toBeVisible()

  await composer.fill('send only to the transcript I can see')
  await page.locator('button:has(svg polygon)').click()
  await expect.poll(() => sentTo).toEqual([TARGET_ID])
})

test('resume reports progress and stays active across a stale sessions refresh', async ({ page }) => {
  let resumePosts = 0
  await page.route('**/api/sessions**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname !== '/api/sessions') return route.continue()
    const response = await route.fetch()
    const body = await response.json()
    body.sessions = body.sessions.map(session => session.id === TARGET_ID ? { ...session, isActive: false } : session)
    await route.fulfill({ response, json: body })
  })
  await page.route(`**/api/sessions/${TARGET_ID}/resume`, async route => {
    resumePosts++
    await new Promise(resolve => setTimeout(resolve, 500))
    await route.fulfill({ json: { ok: true } })
  })

  await page.goto(`${BASE}/#${TARGET_ID}`)
  await expect(page.getByText(TARGET_MESSAGE, { exact: true })).toBeVisible()
  const menu = page.locator('button').filter({ hasText: '⋮' })
  await menu.click()
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Resuming chat…')
  await expect(page.getByRole('status')).toContainText('Chat resumed.')
  expect(resumePosts).toBe(1)

  await menu.click()
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0)
})

test('send-triggered resume preserves the acknowledgement across a stale session list', async ({ page }) => {
  let resumePosts = 0
  const sentTo = []
  await page.route('**/api/sessions**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname !== '/api/sessions' || route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    const body = await response.json()
    body.sessions = body.sessions.map(session => session.id === TARGET_ID ? { ...session, isActive: false } : session)
    await route.fulfill({ response, json: body })
  })
  await page.route(`**/api/sessions/${TARGET_ID}/resume`, async route => {
    resumePosts++
    await route.fulfill({ json: { ok: true } })
  })
  await page.route(`**/api/sessions/${TARGET_ID}/send`, async route => {
    sentTo.push(TARGET_ID)
    await route.fulfill({ json: { ok: true, sentAt: new Date().toISOString() } })
  })

  await page.goto(`${BASE}/#${TARGET_ID}`)
  await expect(page.getByText(TARGET_MESSAGE, { exact: true })).toBeVisible()
  const composer = page.locator('textarea')
  await composer.fill('resume and send only to this inactive chat')
  await page.locator('button:has(svg polygon)').click()

  await expect.poll(() => resumePosts).toBe(1)
  await expect.poll(() => sentTo).toEqual([TARGET_ID])
  await expect(page.getByText('Inactive', { exact: true })).toHaveCount(0)
  const menu = page.locator('button').filter({ hasText: '⋮' })
  await menu.click()
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0)
})
