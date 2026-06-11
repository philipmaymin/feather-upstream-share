// @ts-check
import { test, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'

const BASE = process.env.FEATHER_URL || 'http://localhost:4870'
const HOME = process.env.HOME || '/home/user'
const CLAUDE_PROJECTS = path.join(HOME, '.claude/projects')

// Fixtures live under HOME because the file browser UI can only reach the
// HOME subtree (api/files/list 403s outside ALLOWED_ROOTS, and / is not allowed).
const FIXTURE_DIR = path.join(HOME, 'feather-e2e-files-tmp')
const PDF_PATH = path.join(FIXTURE_DIR, 'fixture.pdf')
const TXT_PATH = path.join(FIXTURE_DIR, 'fixture.txt')
const TXT_CONTENT = 'hello from files-tab e2e'

const MINIMAL_PDF = `%PDF-1.1
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj
xref
0 4
0000000000 65535 f
trailer<</Size 4/Root 1 0 R>>
startxref
0
%%EOF`

const TEST_SESSION_ID = `e2e-files-${Date.now()}`
let testSessionPath

test.beforeAll(() => {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true })
  fs.writeFileSync(PDF_PATH, MINIMAL_PDF)
  fs.writeFileSync(TXT_PATH, TXT_CONTENT)

  const dirs = fs.readdirSync(CLAUDE_PROJECTS).filter(d =>
    fs.statSync(path.join(CLAUDE_PROJECTS, d)).isDirectory()
  )
  if (dirs.length === 0) throw new Error('No project dirs in ~/.claude/projects/')
  testSessionPath = path.join(CLAUDE_PROJECTS, dirs[0], `${TEST_SESSION_ID}.jsonl`)
  fs.appendFileSync(testSessionPath, JSON.stringify({
    type: 'user', uuid: 'e2e-files-001', timestamp: '2025-06-15T14:00:00Z',
    isSidechain: false, isMeta: false,
    message: { role: 'user', content: 'files tab e2e session' },
  }) + '\n')
})

test.afterAll(() => {
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true })
  if (testSessionPath) fs.rmSync(testSessionPath, { force: true })
})

// ── API behavior ────────────────────────────────────────────────────────────

test.describe('files/raw API', () => {
  test('pdf serves inline as application/pdf (preview)', async ({ request }) => {
    const r = await request.get(`${BASE}/api/files/raw?path=${encodeURIComponent(PDF_PATH)}`)
    expect(r.status()).toBe(200)
    expect(r.headers()['content-type']).toContain('application/pdf')
    expect(r.headers()['content-disposition'] || '').not.toContain('attachment')
  })

  test('pdf with download=1 forces attachment', async ({ request }) => {
    const r = await request.get(`${BASE}/api/files/raw?path=${encodeURIComponent(PDF_PATH)}&download=1`)
    expect(r.status()).toBe(200)
    expect(r.headers()['content-disposition']).toContain('attachment')
    expect(r.headers()['content-disposition']).toContain('fixture.pdf')
  })

  test('text still serves inline as text/plain', async ({ request }) => {
    const r = await request.get(`${BASE}/api/files/raw?path=${encodeURIComponent(TXT_PATH)}`)
    expect(r.status()).toBe(200)
    expect(r.headers()['content-type']).toContain('text/plain')
    expect(await r.text()).toBe(TXT_CONTENT)
  })

  test('text with download=1 forces attachment', async ({ request }) => {
    const r = await request.get(`${BASE}/api/files/raw?path=${encodeURIComponent(TXT_PATH)}&download=1`)
    expect(r.status()).toBe(200)
    expect(r.headers()['content-disposition']).toContain('attachment')
  })
})

// ── Files tab UI ────────────────────────────────────────────────────────────

async function openSidebar(page) {
  await page.locator('button:has-text("☰")').click()
  await page.waitForTimeout(300)
}

async function openFixtureDirInBrowser(page) {
  await page.goto(BASE)
  await page.waitForLoadState('networkidle')
  await openSidebar(page)
  const sessionItem = page.locator('text=files tab e2e session').first()
  await expect(sessionItem).toBeVisible({ timeout: 5000 })
  await sessionItem.click()
  await page.waitForTimeout(500)
  await page.locator('button:has-text("Files")').click()
  await page.waitForTimeout(500)
  // Browse mode is the default; home listing shows our fixture dir
  const dirButton = page.locator('button', { hasText: 'feather-e2e-files-tmp/' }).first()
  await expect(dirButton).toBeVisible({ timeout: 5000 })
  await dirButton.click()
  await page.waitForTimeout(500)
}

test.describe('Files tab UI', () => {
  test('each file row has a download button linking to download=1', async ({ page }) => {
    await openFixtureDirInBrowser(page)
    const dl = page.locator('a[title="Download fixture.pdf"]')
    await expect(dl).toBeVisible()
    const href = await dl.getAttribute('href')
    expect(href).toContain('download=1')
    expect(href).toContain(encodeURIComponent(PDF_PATH))
    expect(await dl.getAttribute('download')).toBe('fixture.pdf')
    await expect(page.locator('a[title="Download fixture.txt"]')).toBeVisible()
  })

  test('clicking a pdf name opens viewer with inline PDF iframe and Download', async ({ page }) => {
    await openFixtureDirInBrowser(page)
    await page.locator('button:has-text("fixture.pdf")').first().click()
    // Kind pill + blob iframe = the type-aware viewer, not a garbled text dump
    await expect(page.locator('span:text-is("PDF")')).toBeVisible({ timeout: 5000 })
    const iframe = page.locator('iframe[title="fixture.pdf"]')
    await expect(iframe).toBeVisible({ timeout: 5000 })
    expect(await iframe.getAttribute('src')).toMatch(/^blob:/)
    await expect(page.locator('a:has-text("Download")').first()).toBeVisible()
    // No raw %PDF bytes dumped as text anywhere
    await expect(page.locator('pre:has-text("%PDF")')).toHaveCount(0)
  })

  test('clicking a text name still shows text content', async ({ page }) => {
    await openFixtureDirInBrowser(page)
    await page.locator('button:has-text("fixture.txt")').first().click()
    await expect(page.locator(`pre:has-text("${TXT_CONTENT}")`)).toBeVisible({ timeout: 5000 })
  })
})
