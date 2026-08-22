// @ts-check
import { test, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'

const HOME = process.env.HOME || '/home/user'
const CLAUDE_PROJECTS = path.join(HOME, '.claude/projects')
const sessionId = `e2e-media-recovery-${Date.now()}`
let sessionPath

test.beforeAll(() => {
  const projectDir = fs.readdirSync(CLAUDE_PROJECTS)
    .map(name => path.join(CLAUDE_PROJECTS, name))
    .find(candidate => fs.statSync(candidate).isDirectory())
  if (!projectDir) throw new Error('No Claude project directory found')
  sessionPath = path.join(projectDir, `${sessionId}.jsonl`)
  fs.writeFileSync(sessionPath, JSON.stringify({
    type: 'user', uuid: 'media-seed', timestamp: new Date().toISOString(), isSidechain: false, isMeta: false,
    message: { role: 'user', content: 'media recovery test' },
  }) + '\n')
})

test.afterAll(() => { try { fs.unlinkSync(sessionPath) } catch {} })

test('failed attachment survives reload, retries, and sends without a failure marker', async ({ page }) => {
  let allowUpload = false
  let uploadAttempts = 0
  let sentText = ''
  await page.route('**/api/upload', async route => {
    uploadAttempts++
    if (!allowUpload) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary outage' }) })
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ path: '/tmp/recovered-photo.png' }) })
  })
  await page.route(`**/api/sessions/${sessionId}/send`, async route => {
    sentText = JSON.parse(route.request().postData() || '{}').text || ''
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, sentAt: new Date().toISOString() }) })
  })

  await page.goto(`/#${sessionId}`, { waitUntil: 'domcontentloaded' })
  await page.locator('textarea').fill('keep this caption')
  await page.locator('input[type=file]').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('not-a-real-png-but-a-durable-blob') })
  await expect(page.locator('img[src^="blob:"]')).toBeVisible()

  await page.locator('button[title="Send"]').last().click()
  await expect(page.getByRole('button', { name: 'Retry' }).first()).toBeVisible()
  expect(uploadAttempts).toBe(3)
  await expect(page.locator('textarea')).toHaveValue('keep this caption')

  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Recovered 1 unsent media item.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retry' }).first()).toBeVisible()
  expect(uploadAttempts).toBe(6)
  allowUpload = true
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(page.getByText('Uploaded', { exact: true })).toBeVisible()
  await expect(page.locator('textarea')).toHaveValue('keep this caption')

  await page.locator('button[title="Send"]').last().click()
  await expect.poll(() => sentText).toContain('[Attached image: /tmp/recovered-photo.png]')
  expect(sentText).not.toContain('[Upload failed:')
  await expect(page.locator('img[src^="blob:"]')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('feather-media-outbox')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const tx = request.result.transaction('items', 'readonly')
      const count = tx.objectStore('items').count()
      count.onerror = () => reject(count.error)
      count.onsuccess = () => resolve(count.result)
    }
  }))).toBe(0)
})

test('voice transcription uses the mounted prefix and inserts recovered text', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
    } })
    class FakeRecorder {
      static isTypeSupported() { return true }
      constructor(_stream, options) { this.mimeType = options?.mimeType || 'audio/webm'; this.state = 'inactive' }
      start() { this.state = 'recording' }
      stop() {
        this.state = 'inactive'
        this.ondataavailable?.({ data: new Blob([new Uint8Array(2048)], { type: this.mimeType }) })
        this.onstop?.()
      }
    }
    window.MediaRecorder = FakeRecorder
    window.AudioContext = class {
      createMediaStreamSource() { return { connect() {} } }
      createAnalyser() { return { fftSize: 0, frequencyBinCount: 1, getByteFrequencyData() {} } }
      close() {}
    }
  })

  let transcriptPath = ''
  await page.route('**/feather2/assets/**', route => {
    const url = route.request().url().replace('/feather2/assets/', '/assets/')
    return route.continue({ url })
  })
  await page.route('**/feather2/api/**', async route => {
    const url = new URL(route.request().url())
    const p = url.pathname
    const json = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    if (p.endsWith('/api/transcribe')) { transcriptPath = p; return json({ transcript: 'prefix voice works' }) }
    if (p.endsWith('/stream')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' })
    if (p.endsWith('/messages')) return json({ messages: [], hasMore: false })
    if (p.endsWith('/api/sessions')) return json({ sessions: [{ id: sessionId, title: 'Media test', updatedAt: new Date().toISOString(), isActive: true }] })
    if (p.endsWith('/api/health')) return json({ status: 'ok', version: 'test' })
    if (p.endsWith('/api/boxes')) return json({ boxes: [{ id: 'local', label: 'Local', available: true }] })
    if (p.endsWith('/api/agents')) return json({ agents: [] })
    if (p.endsWith('/api/sharing/peers')) return json({ owner: null, peers: [] })
    if (p.endsWith('/api/starred')) return json({})
    if (p.endsWith('/api/quick-links')) return json([])
    if (p.endsWith('/api/sidecar')) return json({ groups: [] })
    return json({})
  })

  await page.goto(`/feather2/#${sessionId}`, { waitUntil: 'domcontentloaded' })
  const mic = page.getByRole('button', { name: 'Record voice memo' }).first()
  await mic.click()
  await page.getByRole('button', { name: /Stop & transcribe/ }).first().click()
  await expect(page.locator('textarea')).toHaveValue('prefix voice works')
  expect(transcriptPath).toBe('/feather2/api/transcribe')
})
