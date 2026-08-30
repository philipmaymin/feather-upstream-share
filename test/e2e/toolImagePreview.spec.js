// @ts-check
import { test, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const HOME = process.env.HOME || '/home/user'
const CLAUDE_PROJECTS = path.join(HOME, '.claude/projects')
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const previewPath = path.resolve(__dirname, '../fixtures/tool-preview.svg')
const sessionId = `e2e-tool-image-${Date.now()}`
let sessionPath

test.beforeAll(() => {
  const projectDir = fs.readdirSync(CLAUDE_PROJECTS)
    .map(name => path.join(CLAUDE_PROJECTS, name))
    .find(candidate => fs.statSync(candidate).isDirectory())
  if (!projectDir) throw new Error('No Claude project directory found')

  sessionPath = path.join(projectDir, `${sessionId}.jsonl`)
  const lines = [
    {
      type: 'user', uuid: 'tool-image-user', timestamp: '2026-07-26T12:00:00Z',
      isSidechain: false, isMeta: false,
      message: { role: 'user', content: 'Show me the image tool output' },
    },
    {
      type: 'assistant', uuid: 'tool-image-call', timestamp: '2026-07-26T12:00:01Z',
      isSidechain: false, isMeta: false,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'view-image-call', name: 'view_image', input: { path: previewPath, detail: 'original' } }],
      },
    },
  ]
  fs.writeFileSync(sessionPath, lines.map(line => JSON.stringify(line)).join('\n') + '\n')
})

test.afterAll(() => {
  try { fs.unlinkSync(sessionPath) } catch {}
})

test('view_image expands to a tappable preview and full-screen lightbox', async ({ page }) => {
  await page.goto(`/#${sessionId}`, { waitUntil: 'domcontentloaded' })
  await page.getByTestId('work-log-summary').click()

  const summary = page.locator('summary').filter({ hasText: 'View Image' })
  await expect(summary).toContainText('tool-preview.svg')
  await summary.click()

  const preview = page.getByRole('button', { name: 'Open tool-preview.svg full screen' })
  await expect(preview.locator('img')).toBeVisible()
  await preview.click()

  const lightbox = page.locator('div[style*="position: fixed"]').filter({
    has: page.locator('img[src*="tool-preview.svg"]'),
  })
  await expect(lightbox).toBeVisible()
  await expect(lightbox.locator('img')).toHaveAttribute('src', /tool-preview\.svg/)
})
