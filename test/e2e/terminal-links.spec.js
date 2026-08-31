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

  await emptyLinksButton.click()
  await expect(page.locator('#terminal-links')).toBeHidden()
  const deviceUrl = 'https://auth.openai.com/codex/device'
  const deviceCode = '8TIP-RI00E'
  terminalSocket.send(`\r\nOpen this URL in your browser:\r\n${deviceUrl}\r\nEnter code: ${deviceCode}\r\n`)
  await expect(emptyLinksButton).toHaveText('Login')
  await expect(page.locator('#terminal-links')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Open ChatGPT device login' })).toHaveAttribute('href', deviceUrl)
  await expect(page.getByText(deviceCode, { exact: true })).toBeVisible()
  await page.getByRole('button', { name: `Copy login code ${deviceCode}` }).click()
  await expect.poll(() => page.evaluate(() => {
    // @ts-ignore test observation hooks
    return window.__terminalCopied
  })).toBe(deviceCode)
})

test('mobile Return input and visible toolbar controls both reach the terminal', async ({ page }) => {
  const terminalInput = []
  const terminalKeys = []
  let terminalSocket
  let terminalUrl = ''
  let terminalConnections = 0
  await page.route(/\/api\/sessions\/[^/]+\/keys$/, async route => {
    const body = route.request().postDataJSON()
    terminalKeys.push(...body.keys)
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
  })
  await page.routeWebSocket(url => {
    if (!url.pathname.endsWith('/api/terminal')) return false
    terminalUrl = url.href
    return true
  }, socket => {
    terminalSocket = socket
    terminalConnections++
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
  await expect.poll(() => terminalUrl).not.toBe('')
  const initialSize = new URL(terminalUrl)
  expect(Number(initialSize.searchParams.get('cols'))).toBeGreaterThan(20)
  expect(Number(initialSize.searchParams.get('rows'))).toBeGreaterThan(2)

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
  const tapButton = async (name) => {
    const button = page.getByRole('button', { name, exact: true })
    await button.evaluate(element => element.scrollIntoView({ block: 'nearest', inline: 'center' }))
    await expect(button, `${name} toolbar key should be visible after scrolling`).toBeVisible()
    await button.click({ trial: true })
    const box = await button.boundingBox()
    if (!box) throw new Error(`${name} toolbar key has no bounding box`)
    const viewport = page.viewportSize()
    if (!viewport) throw new Error(`${name} toolbar key test has no viewport`)
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    expect(center.x, `${name} toolbar key center x should be inside the viewport`).toBeGreaterThanOrEqual(0)
    expect(center.x, `${name} toolbar key center x should be inside the viewport`).toBeLessThan(viewport.width)
    expect(center.y, `${name} toolbar key center y should be inside the viewport`).toBeGreaterThanOrEqual(0)
    expect(center.y, `${name} toolbar key center y should be inside the viewport`).toBeLessThan(viewport.height)
    const hitTargetIsButton = await button.evaluate((element, point) => {
      const hit = document.elementFromPoint(point.x, point.y)
      return !!hit && (hit === element || element.contains(hit))
    }, center)
    expect(hitTargetIsButton, `${name} toolbar key should receive a touch at its center`).toBe(true)
    await page.touchscreen.tap(center.x, center.y)
  }

  await tapButton('Enter')
  await expect.poll(() => terminalKeys, { message: 'Enter touch key should be delivered exactly once' }).toEqual(['Enter'])
  await expect(page.getByRole('status')).toHaveText('Sent Enter')

  for (const [name, key] of [
    ['Escape', 'Escape'], ['Left arrow', 'Left'], ['Down arrow', 'Down'],
    ['Up arrow', 'Up'], ['Right arrow', 'Right'],
  ]) {
    await tapButton(name)
    await expect.poll(() => terminalKeys.filter(value => value === key).length, {
      message: `${key} touch key should be delivered exactly once`,
    }).toBe(1)
  }

  // iOS can suppress the compatibility click after terminal focus changes.
  // The touch pointer path must send by itself and suppress a later click so
  // one physical tap never becomes two terminal keys.
  const escapeButton = page.getByRole('button', { name: 'Escape', exact: true })
  await escapeButton.evaluate(element => {
    element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'touch' }))
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
  })
  await expect.poll(() => terminalKeys.filter(value => value === 'Escape').length, {
    message: 'Escape pointerup plus compatibility click should deliver exactly one additional key',
  }).toBe(2)

  // If the next tap loses pointerup but still emits click, a recent touch on a
  // different key must not suppress that click.
  await page.evaluate(() => {
    const prior = document.querySelector('button[aria-label="Down arrow"]')
    const next = document.querySelector('button[aria-label="Up arrow"]')
    prior?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'touch' }))
    next?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
  })
  await expect.poll(() => terminalKeys.filter(value => value === 'Down').length, {
    message: 'Down touch pointerup should remain the primary delivery',
  }).toBe(2)
  await expect.poll(() => terminalKeys.filter(value => value === 'Up').length, {
    message: 'Up click-only fallback should survive a recent touch on a different key',
  }).toBe(2)

  // Canvas keyboard input still queues while the terminal WebSocket reconnects.
  // Toolbar controls use the independent HTTP path tested above.
  await terminalSocket.close()
  await hiddenInput.evaluate(element => element.dispatchEvent(new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertLineBreak',
  })))
  await expect.poll(() => terminalConnections).toBe(2)
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
