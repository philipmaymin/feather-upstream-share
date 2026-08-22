// @ts-check
import { test, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'

const HOME = process.env.HOME || '/home/user'
const projects = path.join(HOME, '.claude/projects')
const sessionId = `e2e-markdown-table-${Date.now()}`
let sessionPath

test.beforeAll(() => {
  const projectDir = fs.readdirSync(projects)
    .map((name) => path.join(projects, name))
    .find((candidate) => fs.statSync(candidate).isDirectory())
  if (!projectDir) throw new Error('No Claude project directory found')
  sessionPath = path.join(projectDir, `${sessionId}.jsonl`)
  const table = [
    '| Date | Status | What happened | Next step |',
    '|---|---|---|---|',
    '| 2026-08-22 | Done | A deliberately long narrative cell that should wrap naturally without crushing the short date and status columns into unreadable slivers. | Verify the expanded table on a phone-sized viewport. |',
    '| 2026-08-23 | Waiting | Another sentence with enough detail to deserve a readable column width. | Ship it. |',
  ].join('\n')
  const lines = [
    { type: 'user', uuid: 'table-user', timestamp: '2026-08-22T12:00:00Z', isSidechain: false, isMeta: false, message: { role: 'user', content: 'show table' } },
    { type: 'assistant', uuid: 'table-answer', timestamp: '2026-08-22T12:00:01Z', isSidechain: false, isMeta: false, message: { role: 'assistant', content: [{ type: 'text', text: table }] } },
  ]
  fs.writeFileSync(sessionPath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
})

test.afterAll(() => { try { fs.unlinkSync(sessionPath) } catch {} })

test('wide Markdown tables scroll and expand instead of squashing columns', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/#${sessionId}`, { waitUntil: 'domcontentloaded' })
  const frame = page.locator('.md-table-frame')
  await expect(frame).toBeVisible()
  await expect(page.locator('.md-col-compact').first()).toHaveCSS('white-space', 'nowrap')
  expect(await frame.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)

  await page.getByRole('button', { name: 'Expand table' }).click()
  const dialog = page.getByRole('dialog', { name: 'Expanded table' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('table')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Close expanded table' })).toBeFocused()
  await page.screenshot({ path: 'test-results/markdown-table-mobile.png', fullPage: true })
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Expand table' })).toBeFocused()
})
