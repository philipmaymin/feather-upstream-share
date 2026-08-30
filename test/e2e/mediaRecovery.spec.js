// @ts-check
import { test, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'

const HOME = process.env.HOME || '/home/user'
const CLAUDE_PROJECTS = path.join(HOME, '.claude/projects')
const sessionId = `e2e-media-recovery-${Date.now()}`
const navigationSessionId = `e2e-media-navigation-${Date.now()}`
let sessionPath, navigationSessionPath

test.beforeEach(async ({ page }) => {
  // These synthetic transcripts have no tmux process. Stub only the resume
  // handshake so the tests exercise media/send behavior rather than spawning a harness.
  await page.route('**/api/sessions/*/resume', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }),
  }))
})
test.beforeAll(() => {
  const projectDir = fs.readdirSync(CLAUDE_PROJECTS)
    .map(name => path.join(CLAUDE_PROJECTS, name))
    .find(candidate => fs.statSync(candidate).isDirectory())
  if (!projectDir) throw new Error('No Claude project directory found')
  sessionPath = path.join(projectDir, `${sessionId}.jsonl`)
  navigationSessionPath = path.join(projectDir, `${navigationSessionId}.jsonl`)
  fs.writeFileSync(sessionPath, JSON.stringify({
    type: 'user', uuid: 'media-seed', timestamp: new Date().toISOString(), isSidechain: false, isMeta: false,
    message: { role: 'user', content: 'media recovery test' },
  }) + '\n')
  fs.writeFileSync(navigationSessionPath, JSON.stringify({
    type: 'user', uuid: 'media-navigation-seed', timestamp: new Date().toISOString(), isSidechain: false, isMeta: false,
    message: { role: 'user', content: 'media navigation target' },
  }) + '\n')
})

test.afterAll(() => {
  try { fs.unlinkSync(sessionPath) } catch {}
  try { fs.unlinkSync(navigationSessionPath) } catch {}
})

test('failed attachment survives reload, retries, and sends without a failure marker', async ({ page }) => {
  let allowUpload = false
  let uploadAttempts = 0
  let sentText = ''
  let sentMessageId = ''
  await page.route('**/api/upload', async route => {
    uploadAttempts++
    if (!allowUpload) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary outage' }) })
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ path: '/tmp/recovered-photo.png' }) })
  })
  await page.route(`**/api/sessions/${sessionId}/send`, async route => {
    sentText = JSON.parse(route.request().postData() || '{}').text || ''
    sentMessageId = route.request().headers()['x-feather-message-id'] || ''
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, sentAt: new Date().toISOString() }) })
  })

  await page.goto(`/#${sessionId}`, { waitUntil: 'domcontentloaded' })
  await page.locator('textarea').fill('keep this caption')
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  await page.locator('input[type=file]').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: png })
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
  expect(sentMessageId).toMatch(/^[0-9a-f-]{20,}$/i)
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

test('an acknowledged send preserves composer edits typed while the request is in flight', async ({ page }) => {
  let releaseSend
  const sendGate = new Promise(resolve => { releaseSend = resolve })
  let received = false
  await page.route(`**/api/sessions/${sessionId}/send`, async route => {
    received = true
    await sendGate
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, sentAt: new Date().toISOString() }) })
  })

  await page.goto(`/#${sessionId}`, { waitUntil: 'domcontentloaded' })
  const composer = page.locator('textarea')
  await composer.fill('submit this draft')
  await page.locator('button[title="Send"]').last().click()
  await expect.poll(() => received).toBe(true)
  await composer.fill('newer unsent thought')
  releaseSend()
  await expect(composer).toHaveValue('newer unsent thought')
  await expect.poll(() => page.evaluate(id => localStorage.getItem(`feather-draft-${id}`), sessionId)).toBe('newer unsent thought')
})

test('a send survives leaving during delivery and retries against its original chat after reload', async ({ page }) => {
  let sendAttempts = 0
  const messageIds = []
  let sent
  await page.route(`**/api/sessions/${sessionId}/send`, async route => {
    sendAttempts++
    messageIds.push(route.request().headers()['x-feather-message-id'])
    if (sendAttempts === 1) {
      await new Promise(resolve => setTimeout(resolve, 800))
      return route.abort('failed')
    }
    sent = {
      text: JSON.parse(route.request().postData() || '{}').text,
      messageId: route.request().headers()['x-feather-message-id'],
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, sentAt: new Date().toISOString() }) })
  })

  await page.goto(`/#${sessionId}`, { waitUntil: 'domcontentloaded' })
  await page.locator('textarea').fill('install OMP and keep this request')
  await page.locator('button[title="Send"]').last().click()
  await expect(page.getByText('queued', { exact: true })).toBeVisible()
  await expect(page.locator('textarea')).toHaveValue('')
  await expect.poll(() => sendAttempts).toBe(1)
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('feather-message-outbox-v1') || '[]').length)).toBe(1)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect.poll(() => sent?.text).toBe('install OMP and keep this request')
  expect(sent.messageId).toMatch(/^[0-9a-f-]{20,}$/i)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('feather-message-outbox-v1'))).toBe(null)
  expect(sendAttempts).toBeGreaterThanOrEqual(2)
  expect(new Set(messageIds).size).toBe(1)
})
test('an in-flight attachment send does not block another room and clears the acknowledged origin draft', async ({ page }) => {
  let releaseSend
  let sendReceived = false
  let sendAcknowledged = false
  const sendGate = new Promise(resolve => { releaseSend = resolve })
  await page.route('**/api/upload', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ path: '/tmp/navigation-photo.png' }),
  }))
  await page.route(`**/api/sessions/${sessionId}/send`, async route => {
    sendReceived = true
    await sendGate
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, sentAt: new Date().toISOString() }) })
    sendAcknowledged = true
  })

  await page.goto(`/#${sessionId}`, { waitUntil: 'domcontentloaded' })
  await page.locator('textarea').fill('send from the first room')
  await page.locator('input[type=file]').setInputFiles({
    name: 'navigation.png',
    mimeType: 'image/png',
    buffer: Buffer.from('durable navigation image'),
  })
  await page.locator('button[title="Send"]').last().click()
  await expect.poll(() => sendReceived).toBe(true)

  await page.locator('button').first().click()
  await page.getByText('media navigation target', { exact: true }).click()
  const secondComposer = page.locator('textarea')
  await expect(secondComposer).toBeEditable()
  await expect(page.locator('button[title="Send"]').last()).toBeEnabled()
  await secondComposer.fill('work in the second room')

  releaseSend()
  await expect.poll(() => sendAcknowledged).toBe(true)
  await expect(page.getByTestId('working-indicator')).toHaveCount(0)
  await expect(secondComposer).toHaveValue('work in the second room')

  await page.locator('button').first().click()
  await page.getByText('media recovery test', { exact: true }).click()
  await expect(page.locator('textarea')).toHaveValue('')
  await expect(page.locator('img[src^="blob:"]')).toHaveCount(0)
})

test('oversized attachments are rejected before any upload request', async ({ page }) => {
  let uploads = 0
  const oversizedPath = path.join('/tmp', `feather-too-large-${Date.now()}.bin`)
  fs.writeFileSync(oversizedPath, '')
  fs.truncateSync(oversizedPath, 50 * 1024 * 1024 + 1)
  await page.route('**/api/upload', route => { uploads++; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ path: '/tmp/should-not-upload' }) }) })
  try {
    await page.goto(`/#${sessionId}`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('textarea')).toBeEnabled()
    await page.locator('input[type=file]').setInputFiles(oversizedPath)
    await expect(page.getByText(`${path.basename(oversizedPath)} is larger than the 50 MB upload limit.`)).toBeVisible()
    expect(uploads).toBe(0)
    await expect(page.getByText(path.basename(oversizedPath), { exact: true })).toHaveCount(0)
  } finally {
    fs.unlinkSync(oversizedPath)
  }
})

test('a terminal voice tombstone is never transcribed or delivered again', async ({ page }) => {
  let transcriptions = 0
  let sends = 0
  await page.route('**/api/transcribe', route => { transcriptions++; return route.fulfill({ status: 500, body: '{}' }) })
  await page.route(`**/api/sessions/${sessionId}/send`, route => { sends++; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, sentAt: new Date().toISOString() }) }) })

  await page.goto(`/#${sessionId}`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(({ sessionId }) => new Promise((resolve, reject) => {
    const request = indexedDB.open('feather-media-outbox', 1)
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('items', { keyPath: 'id' })
      store.createIndex('scope', ['boxId', 'sessionId'])
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const tx = request.result.transaction('items', 'readwrite')
      tx.objectStore('items').put({
        id: 'delivered-voice', boxId: 'local', sessionId, kind: 'audio', name: 'voice.webm',
        blob: new Blob([], { type: 'audio/webm' }), status: 'delivered', attempts: 1,
        intent: 'send', capturedText: 'already sent', transcript: 'already transcribed', deliveredAt: Date.now(),
      })
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    }
  }), { sessionId })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(250)
  expect(transcriptions).toBe(0)
  expect(sends).toBe(0)
  await expect(page.getByText(/Recovered .*unsent media/)).toHaveCount(0)
})

test('voice and image work stay pinned to the session where they started', async ({ page }) => {
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
  let releaseTranscription
  let transcriptionReceived = false
  const transcriptionGate = new Promise(resolve => { releaseTranscription = resolve })
  await page.route('**/api/transcribe', async route => {
    transcriptionReceived = true
    await transcriptionGate
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ transcript: 'pinned voice' }) })
  })
  let voiceSend
  await page.route(`**/api/sessions/${sessionId}/send`, async route => {
    voiceSend = {
      messageId: route.request().headers()['x-feather-message-id'],
      text: JSON.parse(route.request().postData() || '{}').text,
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, sentAt: new Date().toISOString() }) })
  })

  await page.goto(`/#${sessionId}`, { waitUntil: 'domcontentloaded' })
  await page.locator('textarea').fill('original draft')
  await page.getByRole('button', { name: /Record voice memo/ }).first().click()
  await page.locator('button').first().click()
  await page.getByText('media navigation target', { exact: true }).first().click()
  await page.locator('textarea').fill('other draft')
  await page.locator('button[title="Stop, transcribe & send"]').last().click()
  await expect.poll(() => transcriptionReceived).toBe(true)
  await expect(page.locator('textarea')).toHaveValue('other draft')
  await expect(page.locator('button[title="Send"]').last()).toBeEnabled()
  await expect.poll(() => page.evaluate(id => localStorage.getItem(`feather-draft-${id}`), sessionId)).toBe(null)
  releaseTranscription()
  await expect(page.locator('textarea')).toHaveValue('other draft')
  await expect.poll(() => voiceSend?.text).toBe('original draft pinned voice')
  expect(voiceSend.messageId).toMatch(/^[0-9a-f-]{20,}$/i)
  await expect(page.getByText('Voice memo recovered successfully.')).toHaveCount(0)
  await expect.poll(() => page.evaluate(id => localStorage.getItem(`feather-draft-${id}`), sessionId)).toBe(null)

  const oversizedSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="2000"><rect width="2000" height="2000" fill="red"/></svg>`
  await page.locator('button').first().click()
  await page.getByText('media recovery test', { exact: true }).first().click()
  await page.locator('input[type=file]').setInputFiles({ name: 'slow.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(oversizedSvg) })
  await page.locator('button').first().click()
  await page.getByText('media navigation target', { exact: true }).first().click()
  await expect(page.locator('img[src^="blob:"]')).toHaveCount(0)
})

test('voice transcription uses the mounted prefix and inserts recovered text', async ({ page }) => {
  await page.clock.install()
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
  await expect(page.getByText('Voice memo recovered successfully.')).toBeVisible()
  await page.clock.fastForward(5000)
  await expect(page.getByText('Voice memo recovered successfully.')).toHaveCount(0)
  expect(transcriptPath).toBe('/feather2/api/transcribe')
})

test('one voice Send includes the caption, transcript, and pending attachment', async ({ page }) => {
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
  await page.route('**/api/transcribe', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ transcript: 'spoken detail' }) }))
  await page.route('**/api/upload', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ path: '/tmp/voice-photo.png' }) }))
  const sends = []
  await page.route(`**/api/sessions/${sessionId}/send`, async route => {
    sends.push(JSON.parse(route.request().postData() || '{}').text || '')
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, sentAt: new Date().toISOString() }) })
  })

  await page.goto(`/#${sessionId}`, { waitUntil: 'domcontentloaded' })
  await page.locator('textarea').fill('photo context')
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  await page.locator('input[type=file]').setInputFiles({ name: 'voice-photo.png', mimeType: 'image/png', buffer: png })
  await expect(page.locator('img[src^="blob:"]')).toBeVisible()
  await page.getByRole('button', { name: /Record voice memo/ }).first().click()
  await page.locator('button[title="Stop, transcribe & send"]').last().click()

  await expect.poll(() => sends.length).toBe(1)
  expect(sends[0]).toContain('photo context spoken detail')
  expect(sends[0]).toContain('[Attached image: /tmp/voice-photo.png]')
  await expect(page.locator('img[src^="blob:"]')).toHaveCount(0)
  await expect(page.locator('textarea')).toHaveValue('')
})
