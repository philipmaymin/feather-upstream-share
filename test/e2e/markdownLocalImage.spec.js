// @ts-check
// Regression: local filesystem paths embedded as Markdown or attached images
// must render through Feather's Files preview instead of as broken site URLs.
import { test, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const HOME = process.env.HOME || '/home/user'
const CLAUDE_PROJECTS = path.join(HOME, '.claude/projects')
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sessionId = `e2e-md-local-image-${Date.now()}`
const fixturePath = path.resolve(__dirname, '../fixtures/tool-preview.svg')
const imagePath = path.join('/tmp', `${sessionId}-tool-preview.svg`)
let sessionPath

test.beforeAll(() => {
  const projectDir = fs.readdirSync(CLAUDE_PROJECTS)
    .map(name => path.join(CLAUDE_PROJECTS, name))
    .find(candidate => fs.statSync(candidate).isDirectory())
  if (!projectDir) throw new Error('No Claude project directory found')

  sessionPath = path.join(projectDir, `${sessionId}.jsonl`)
  fs.copyFileSync(fixturePath, imagePath)
  const text = [
    `![Feather preview](${imagePath})`,
    '',
    'The local image should render above this sentence.',
    '',
    `Missing one: ![gone](/no/such/dir/missing-image.png)`,
    '',
    `Full image: [open the SVG](${imagePath})`,
    '',
    `[Attached image: ${imagePath}]`,
    '',
    'Quoted marker, not an attachment: `[Attached image: /abs/path]` stays inline code.',
  ].join('\n')
  const lines = [
    {
      type: 'user', uuid: 'md-img-user', timestamp: '2026-08-22T12:00:00Z',
      isSidechain: false, isMeta: false,
      message: { role: 'user', content: 'show the image' },
    },
    {
      type: 'assistant', uuid: 'md-img-answer', timestamp: '2026-08-22T12:00:01Z',
      isSidechain: false, isMeta: false,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    },
  ]
  fs.writeFileSync(sessionPath, lines.map(line => JSON.stringify(line)).join('\n') + '\n')
})

test.afterAll(() => {
  try { fs.unlinkSync(sessionPath) } catch {}
  try { fs.unlinkSync(imagePath) } catch {}
})

async function openTestSession(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const session = page.getByText('show the image', { exact: true }).first()
  if (!await session.isVisible()) await page.locator('button:has-text("☰")').click()
  await expect(session).toBeVisible({ timeout: 10_000 })
  await session.click()
  await expect(page.locator('[data-uuid="md-img-answer"]')).toBeVisible({ timeout: 10_000 })
}

test('local Markdown image renders through the Files route and opens the lightbox', async ({ page }) => {
  await openTestSession(page)

  const img = page.locator('.markdown img.md-local-img[alt="Feather preview"]')
  await expect(img).toBeVisible()
  await expect(img).toHaveAttribute('src', /^\/api\/files\/raw\?path=/)
  await expect.poll(() => img.evaluate(el => /** @type {HTMLImageElement} */ (el).naturalWidth)).toBeGreaterThan(0)

  await img.click()
  const lightboxImage = page.locator('img[style*="95vw"]')
  await expect(lightboxImage).toBeVisible()
  await expect(lightboxImage).toHaveAttribute('src', /^\/api\/files\/raw\?path=/)
})

test('missing local image degrades to a clickable file path', async ({ page }) => {
  await openTestSession(page)

  const fallback = page.locator('.markdown a.feather-path', { hasText: '/no/such/dir/missing-image.png' })
  await expect(fallback).toBeVisible()
  await expect(fallback).toHaveAttribute('href', /^\/api\/files\/raw\?path=/)
})

test('attachment markers quoted in code spans do not become previews', async ({ page }) => {
  await openTestSession(page)

  const code = page.locator('.markdown code', { hasText: '[Attached image: /abs/path]' })
  await expect(code).toBeVisible()
  await expect(page.locator('img[src*="%2Fabs%2Fpath"]')).toHaveCount(0)
})

test('local Markdown link still uses the Files preview', async ({ page }) => {
  await openTestSession(page)

  const link = page.locator('.markdown a.feather-path', { hasText: 'open the SVG' })
  await expect(link).toBeVisible()
  await expect(link).toHaveAttribute('href', `/api/files/raw?path=${encodeURIComponent(imagePath)}`)
  await expect(link).toHaveAttribute('data-path', imagePath)
})

test('attached local image also renders through the Files preview', async ({ page }) => {
  await openTestSession(page)

  const attached = page.locator('[data-uuid="md-img-answer"] > img').first()
  await expect(attached).toBeVisible()
  await expect(attached).toHaveAttribute('src', `/api/files/raw?path=${encodeURIComponent(imagePath)}`)
  await expect.poll(() => attached.evaluate(el => /** @type {HTMLImageElement} */ (el).naturalWidth)).toBeGreaterThan(0)
})
