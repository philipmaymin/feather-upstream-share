// @ts-check
import { test, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'

const BASE = process.env.FEATHER_URL || 'http://localhost:4870'
const HOME = process.env.HOME || '/home/user'
const CLAUDE_PROJECTS = path.join(HOME, '.claude/projects')
const SESSION_ID = `e2e-terminal-link-${Date.now()}`
const TITLE = `Terminal login link ${Date.now()}`
const LOGIN_URL = `https://auth.example.test/claude/login?client_id=feather&state=${'long-state-'.repeat(24)}done&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Fcallback`
let sessionPath = ''

test.use({ hasTouch: true, viewport: { width: 390, height: 844 } })

test.beforeAll(() => {
  const projectDir = fs.readdirSync(CLAUDE_PROJECTS)
    .map(name => path.join(CLAUDE_PROJECTS, name))
    .find(candidate => fs.statSync(candidate).isDirectory())
  if (!projectDir) throw new Error('No project dirs in ~/.claude/projects/')
  sessionPath = path.join(projectDir, `${SESSION_ID}.jsonl`)
  fs.writeFileSync(sessionPath, JSON.stringify({
    type: 'user', uuid: `${SESSION_ID}-user`, timestamp: new Date().toISOString(),
    isSidechain: false, isMeta: false,
    message: { role: 'user', content: TITLE },
  }) + '\n')
})

test.afterAll(() => {
  try { fs.unlinkSync(sessionPath) } catch {}
})

test('long wrapped login URLs can be tapped, opened, and copied on mobile', async ({ page }) => {
  let terminalSocket
  let terminalCols = 0
  let terminalRows = 0
  await page.addInitScript(() => {
    // @ts-ignore test observation hooks
    window.__terminalOpened = []
    // @ts-ignore test observation hooks
    window.open = url => { window.__terminalOpened.push(String(url)); return null }
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        // @ts-ignore test observation hooks
        writeText: async text => { window.__terminalCopied = text },
        readText: async () => '',
      },
    })
  })
  await page.routeWebSocket(/\/api\/terminal\?session=/, socket => {
    terminalSocket = socket
    socket.onMessage(message => {
      try {
        const parsed = JSON.parse(String(message))
        if (parsed.type === 'resize') {
          terminalCols = parsed.cols
          terminalRows = parsed.rows
        }
      } catch {}
    })
  })

  await page.goto(`${BASE}/#${SESSION_ID}`)
  await expect(page.getByText(TITLE, { exact: true }).first()).toBeVisible({ timeout: 10000 })
  await page.getByRole('button', { name: 'Terminal', exact: true }).click()

  const emptyLinksButton = page.locator('button[aria-controls="terminal-links"]')
  await expect(emptyLinksButton).toBeVisible({ timeout: 10000 })
  const linksButtonBox = await emptyLinksButton.boundingBox()
  expect(linksButtonBox).not.toBeNull()
  expect(linksButtonBox.x).toBeGreaterThanOrEqual(0)
  expect(linksButtonBox.x + linksButtonBox.width).toBeLessThanOrEqual(390)
  await emptyLinksButton.click()
  await expect(page.getByText('No complete links found yet.')).toBeVisible()

  await expect.poll(() => Boolean(terminalSocket) && terminalCols > 20 && terminalRows > 2).toBe(true)
  const indent = '    '
  const width = terminalCols - indent.length
  // Match OMP's live login screen: tmux first redraws a valid-looking prefix,
  // then Feather recovers the complete preserved OSC 8 target from the pane.
  const visibleUrl = LOGIN_URL.slice(0, width)
  const rows = []
  for (let offset = 0; offset < visibleUrl.length; offset += width) {
    rows.push((indent + visibleUrl.slice(offset, offset + width)).padEnd(terminalCols))
  }
  terminalSocket.send(rows.join('\r\n'))
  await expect(emptyLinksButton).toHaveText('Links (1)', { timeout: 10000 })
  terminalSocket.send(JSON.stringify({ type: 'terminal-links', links: [LOGIN_URL] }))
  await expect(page.getByRole('link', { name: LOGIN_URL })).toHaveAttribute('href', LOGIN_URL)
  await expect(emptyLinksButton).toHaveText('Links (1)')

  const canvas = page.locator('canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('terminal canvas is not visible')
  const rowHeight = box.height / terminalRows
  await page.touchscreen.tap(box.x + 35, box.y + rowHeight * 0.5)
  await expect.poll(() => page.evaluate(() => {
    // @ts-ignore test observation hooks
    return window.__terminalOpened
  })).toEqual([LOGIN_URL])

  const link = page.getByRole('link', { name: LOGIN_URL })
  await expect(link).toHaveAttribute('href', LOGIN_URL)
  await expect(link).toHaveAttribute('target', '_blank')

  await page.getByRole('button', { name: 'Copy', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Copied!', exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    // @ts-ignore test observation hooks
    return window.__terminalCopied
  })).toBe(LOGIN_URL)
})

test('mobile Return input and the visible Enter control both reach the terminal', async ({ page }) => {
  const terminalInput = []
  let terminalSocket
  await page.routeWebSocket(/\/api\/terminal\?session=/, socket => {
    terminalSocket = socket
    socket.onMessage(message => {
      const value = String(message)
      try {
        if (JSON.parse(value).type === 'resize') return
      } catch {}
      terminalInput.push(value)
    })
  })

  await page.goto(`${BASE}/#${SESSION_ID}`)
  await expect(page.getByText(TITLE, { exact: true }).first()).toBeVisible({ timeout: 10000 })
  await page.getByRole('button', { name: 'Terminal', exact: true }).click()
  await expect.poll(() => Boolean(terminalSocket)).toBe(true)

  const hiddenInput = page.locator('textarea[aria-label="Terminal input"]')
  await expect(hiddenInput).toBeAttached()
  await hiddenInput.evaluate(element => element.dispatchEvent(new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertLineBreak',
  })))
  await expect.poll(() => terminalInput.filter(value => value === '\r').length).toBe(1)

  // Keyboards that emit both events must still produce exactly one Return.
  await hiddenInput.evaluate(element => {
    element.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
      code: 'Enter',
    }))
    element.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertParagraph',
    }))
  })
  await expect.poll(() => terminalInput.filter(value => value === '\r').length).toBe(2)

  const enterButton = page.getByRole('button', { name: 'Enter', exact: true })
  await expect(enterButton).toBeVisible()
  const box = await enterButton.boundingBox()
  expect(box).not.toBeNull()
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  await enterButton.click()
  await expect.poll(() => terminalInput.filter(value => value === '\r').length).toBe(3)
})

test('a silent zombie event stream reconnects from its last event id', async ({ page }) => {
  await page.addInitScript(() => {
    // Keep the production timeout meaningful while making this regression fast.
    const nativeSetTimeout = window.setTimeout.bind(window)
    // @ts-ignore preserve the native call shape for the app
    window.setTimeout = (handler, delay, ...args) => nativeSetTimeout(handler, delay === 40_000 ? 2000 : delay, ...args)
    class FakeEventSource extends EventTarget {
      url
      closed = false
      onerror = null
      constructor(url) {
        super()
        this.url = String(url)
        // @ts-ignore test observation hook
        ;(window.__fakeEventSources ||= []).push(this)
        queueMicrotask(() => this.dispatchEvent(new Event('connected')))
      }
      close() { this.closed = true }
    }
    // @ts-ignore deliberately replacing the browser transport
    window.EventSource = FakeEventSource
  })

  await page.goto(`${BASE}/#${SESSION_ID}`)
  await expect.poll(() => page.evaluate(() => {
    // @ts-ignore test observation hook
    return window.__fakeEventSources?.length || 0
  })).toBe(1)
  await page.evaluate(() => {
    // @ts-ignore test observation hook
    const source = window.__fakeEventSources[0]
    source.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ uuid: 'zombie-offset', role: 'assistant', timestamp: new Date().toISOString(), content: [{ type: 'text', text: 'offset marker' }] }),
      lastEventId: '123',
    }))
  })

  await expect.poll(() => page.evaluate(() => {
    // @ts-ignore test observation hook
    return window.__fakeEventSources?.length || 0
  })).toBeGreaterThanOrEqual(2)
  const state = await page.evaluate(() => {
    // @ts-ignore test observation hook
    return { firstClosed: window.__fakeEventSources[0].closed, secondUrl: window.__fakeEventSources[1].url }
  })
  expect(state.firstClosed).toBe(true)
  expect(state.secondUrl).toContain('lastEventId=123')
})
