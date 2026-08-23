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
        if (parsed.type === 'resize') terminalCols = parsed.cols
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

  await expect.poll(() => Boolean(terminalSocket) && terminalCols > 20).toBe(true)
  const indent = '    '
  const width = terminalCols - indent.length
  const rows = []
  for (let offset = 0; offset < LOGIN_URL.length; offset += width) {
    rows.push((indent + LOGIN_URL.slice(offset, offset + width)).padEnd(terminalCols))
  }
  terminalSocket.send(rows.join('\r\n'))
  await expect(emptyLinksButton).toHaveText('Links (1)', { timeout: 10000 })

  const canvas = page.locator('canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('terminal canvas is not visible')
  await page.touchscreen.tap(box.x + 35, box.y + 8)
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
