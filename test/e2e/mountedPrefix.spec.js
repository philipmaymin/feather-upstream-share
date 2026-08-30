// @ts-check
import { test, expect } from '@playwright/test'
import { spawn } from 'child_process'
import fs from 'fs'
import http from 'http'
import net from 'net'
import os from 'os'
import path from 'path'

const repo = path.resolve(import.meta.dirname, '../..')
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-prefix-e2e-'))
const home = path.join(fixtureRoot, 'home')
const stateNormal = path.join(fixtureRoot, 'state-normal')
const stateCanary = path.join(fixtureRoot, 'state-canary')
const projectDir = path.join(home, '.claude/projects/-tmp-prefix-e2e')
const sessionId = 'mounted-prefix-session'
const previewPath = path.join(fixtureRoot, 'preview.svg')
const sessionPath = path.join(projectDir, `${sessionId}.jsonl`)

/** @type {import('child_process').ChildProcess[]} */
const children = []
/** @type {http.Server | null} */
let proxy = null
let origin = ''
const proxyState = {
  versionOverride: null,
  /** @type {{ path: string, status: number }[]} */
  upgrades: [],
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function waitForHealth(port) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (response.ok) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Feather did not start on ${port}`)
}

async function startFeather(port, stateDir, readOnly) {
  const child = spawn(process.execPath, ['server-single.js'], {
    cwd: repo,
    env: {
      ...process.env,
      HOME: home,
      FEATHER_STATE_DIR: stateDir,
      FEATHER_READ_ONLY: readOnly ? '1' : '0',
      STATIC_OVERRIDE: 'static-test',
      PORT: String(port),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  children.push(child)
  try { await waitForHealth(port) }
  catch (error) { throw new Error(`${error.message}\n${stderr}`) }
}

function proxyTarget(rawUrl, routes) {
  const pathname = new URL(rawUrl || '/', 'http://proxy').pathname
  for (const [prefix, port] of routes) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return { prefix, port, path: (rawUrl || '/').slice(prefix.length) || '/' }
    }
  }
  return null
}

async function startProxy(routes) {
  const server = http.createServer((req, res) => {
    const target = proxyTarget(req.url, routes)
    if (!target) { res.writeHead(404).end('outside mounted app'); return }
    if (req.url === target.prefix) {
      res.writeHead(308, { Location: `${target.prefix}/` }).end()
      return
    }
    const upstream = http.request({
      hostname: '127.0.0.1', port: target.port, method: req.method,
      path: target.path, headers: { ...req.headers, host: `127.0.0.1:${target.port}` },
    }, upstreamResponse => {
      if (proxyState.versionOverride && new URL(target.path, 'http://upstream').pathname === '/api/health') {
        const chunks = []
        upstreamResponse.on('data', chunk => chunks.push(chunk))
        upstreamResponse.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          body.version = proxyState.versionOverride
          const encoded = Buffer.from(JSON.stringify(body))
          const headers = { ...upstreamResponse.headers }
          delete headers['transfer-encoding']
          delete headers['content-length']
          res.writeHead(upstreamResponse.statusCode || 200, {
            ...headers,
            'content-type': 'application/json', 'content-length': encoded.length,
          })
          res.end(encoded)
        })
        return
      }
      res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers)
      upstreamResponse.pipe(res)
    })
    upstream.on('error', error => { if (!res.headersSent) res.writeHead(502); res.end(error.message) })
    req.pipe(upstream)
  })

  server.on('upgrade', (req, socket, head) => {
    const target = proxyTarget(req.url, routes)
    if (!target) { socket.destroy(); return }
    const upstream = http.request({
      hostname: '127.0.0.1', port: target.port, method: req.method,
      path: target.path, headers: { ...req.headers, host: `127.0.0.1:${target.port}` },
    })
    upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
      proxyState.upgrades.push({ path: req.url || '', status: response.statusCode || 101 })
      socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`)
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        socket.write(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`)
      }
      socket.write('\r\n')
      if (head.length) upstreamSocket.write(head)
      if (upstreamHead.length) socket.write(upstreamHead)
      upstreamSocket.pipe(socket).pipe(upstreamSocket)
    })
    upstream.on('response', response => {
      proxyState.upgrades.push({ path: req.url || '', status: response.statusCode || 500 })
      socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`)
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        socket.write(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`)
      }
      socket.write('\r\n')
      response.pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
    upstream.end()
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  fs.mkdirSync(projectDir, { recursive: true })
  fs.mkdirSync(path.join(home, '.feather'), { recursive: true })
  fs.writeFileSync(previewPath, '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="green"/></svg>')
  fs.writeFileSync(sessionPath, [
    {
      type: 'user', uuid: 'prefix-user', cwd: fixtureRoot, timestamp: '2026-08-22T12:00:00Z',
      isMeta: false, isSidechain: false, message: { role: 'user', content: 'Mounted prefix fixture' },
    },
    {
      type: 'assistant', uuid: 'prefix-assistant', cwd: fixtureRoot, timestamp: '2026-08-22T12:00:01Z',
      isMeta: false, isSidechain: false,
      message: { role: 'assistant', content: [
        { type: 'text', text: `![Mounted preview](${previewPath})\n\n[Attached image: ${previewPath}]` },
        { type: 'tool_use', id: 'prefix-tool', name: 'view_image', input: { path: previewPath } },
      ] },
    },
  ].map(line => JSON.stringify(line)).join('\n') + '\n')

  const normalPort = await freePort()
  const canaryPort = await freePort()
  await startFeather(normalPort, stateNormal, false)
  await startFeather(canaryPort, stateCanary, true)
  proxy = await startProxy([['/feather2', normalPort], ['/canary-zak', canaryPort]])
  const address = proxy.address()
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

test.afterAll(async () => {
  await new Promise(resolve => proxy?.close(resolve))
  for (const child of children) child.kill('SIGTERM')
  await Promise.all(children.map(child => child.exitCode === null
    ? new Promise(resolve => child.once('exit', resolve))
    : Promise.resolve()))
  fs.rmSync(fixtureRoot, { recursive: true, force: true })
})

test('production prefix carries SPA assets, REST, SSE, media, files, export, WS, and reload', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
    })
    class FakeRecorder {
      static isTypeSupported() { return true }
      constructor(stream, options) { this.mimeType = options?.mimeType || 'audio/webm'; this.state = 'inactive' }
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
  await page.clock.install()
  const mountedPaths = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin === origin) mountedPaths.push(url.pathname)
  })

  await page.goto(`${origin}/feather2/#${sessionId}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Mounted prefix fixture', { exact: true }).first()).toBeVisible()
  await expect.poll(() => mountedPaths.some(value => value === `/feather2/api/sessions/${sessionId}/stream`)).toBe(true)
  expect(mountedPaths.some(value => value.startsWith('/feather2/assets/'))).toBe(true)

  const markdownImage = page.locator('img[alt="Mounted preview"]')
  await expect(markdownImage).toBeVisible()
  await expect(markdownImage).toHaveAttribute('src', /^\/feather2\/api\/files\/raw\?path=/)
  await expect.poll(() => markdownImage.evaluate(image => image.naturalWidth)).toBeGreaterThan(0)

  await page.getByTestId('work-log-summary').click()
  const tool = page.locator('summary').filter({ hasText: 'View Image' })
  await tool.click()
  await expect(tool.locator('xpath=..').locator('img')).toHaveAttribute('src', /^\/feather2\/api\/files\/raw\?path=/)

  await page.locator('button', { hasText: '⋮' }).click()
  await expect(page.getByRole('link', { name: 'Export MD' })).toHaveAttribute('href', `/feather2/api/sessions/${sessionId}/export`)
  await page.mouse.click(5, 100)

  const uploadRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/feather2/api/upload')
  await page.locator('input[type="file"]').setInputFiles({ name: 'prefix.txt', mimeType: 'text/plain', buffer: Buffer.from('prefix upload') })
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await uploadRequest

  const voiceRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/feather2/api/transcribe')
  await page.getByRole('button', { name: 'Record voice memo' }).click()
  await page.getByRole('button', { name: /Stop & transcribe/ }).click()
  await voiceRequest

  const terminalSocket = page.waitForEvent('websocket', socket => new URL(socket.url()).pathname === `/feather2/api/terminal`)
  await page.getByRole('button', { name: 'Terminal', exact: true }).click()
  await terminalSocket

  const shellNonce = `feather-mounted-shell-${process.pid}-${Date.now()}`
  const shellOutput = await page.evaluate(nonce => new Promise((resolve, reject) => {
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/feather2/api/shell`)
    let output = ''
    socket.addEventListener('open', () => socket.send(`printf '${nonce}\\n'\n`))
    socket.addEventListener('message', event => {
      output += String(event.data)
      if (!output.includes(nonce)) return
      socket.close()
      resolve(output)
    })
    socket.addEventListener('close', () => {
      if (!output.includes(nonce)) reject(new Error('mounted shell closed before nonce output'))
    })
    socket.addEventListener('error', () => reject(new Error('mounted shell WebSocket failed')))
  }), shellNonce)
  expect(shellOutput).toContain(shellNonce)
  await expect.poll(() => proxyState.upgrades.some(entry => entry.path === '/feather2/api/shell' && entry.status === 101)).toBe(true)

  const beforeReloadAssets = mountedPaths.filter(value => value.startsWith('/feather2/assets/')).length
  await page.reload({ waitUntil: 'domcontentloaded' })
  expect(page.url()).toContain('/feather2/#')
  await expect.poll(() => mountedPaths.filter(value => value.startsWith('/feather2/assets/')).length).toBeGreaterThan(beforeReloadAssets)

  const escaped = mountedPaths.filter(value => /^\/(?:api|assets|uploads)(?:\/|$)/.test(value))
  expect(escaped).toEqual([])
})

test('mobile read-only canary rejects terminal and shell through its mounted WS routes', async ({ page }) => {
  proxyState.versionOverride = null
  await page.setViewportSize({ width: 375, height: 812 })
  const paths = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin === origin) paths.push(url.pathname)
  })
  await page.goto(`${origin}/canary-zak/#${sessionId}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Mounted prefix fixture', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Terminal', exact: true }).click()
  await page.evaluate(() => Promise.all(['/api/terminal?session=mounted-prefix-session', '/api/shell'].map(route => new Promise(resolve => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${location.host}/canary-zak${route}`)
    socket.addEventListener('close', resolve)
    socket.addEventListener('error', resolve)
  }))))

  await expect.poll(() => proxyState.upgrades.filter(entry => entry.path.startsWith('/canary-zak/api/')).length).toBeGreaterThanOrEqual(2)
  expect(proxyState.upgrades.filter(entry => entry.path.startsWith('/canary-zak/api/')).every(entry => entry.status === 403)).toBe(true)
  expect(paths.some(value => value.startsWith('/canary-zak/assets/'))).toBe(true)
  expect(paths.some(value => value === `/canary-zak/api/sessions/${sessionId}/stream`)).toBe(true)
  expect(paths.filter(value => /^\/(?:api|assets|uploads)(?:\/|$)/.test(value))).toEqual([])
})
