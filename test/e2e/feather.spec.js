// @ts-check
import { test, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'

const BASE = process.env.FEATHER_URL || 'http://localhost:4870'
const HOME = process.env.HOME || '/home/user'
const CLAUDE_PROJECTS = path.join(HOME, '.claude/projects')

// ── Synthetic session setup ─────────────────────────────────────────────────

const TEST_SESSION_ID = `e2e-feather-${Date.now()}`
const HTML_ARTIFACT_PATH = path.join('/tmp', `${TEST_SESSION_ID}-artifact.html`)
let testSessionPath

function writeLine(obj) {
  fs.appendFileSync(testSessionPath, JSON.stringify(obj) + '\n')
}

test.beforeAll(() => {
  const dirs = fs.readdirSync(CLAUDE_PROJECTS).filter(d =>
    fs.statSync(path.join(CLAUDE_PROJECTS, d)).isDirectory()
  )
  if (dirs.length === 0) throw new Error('No project dirs in ~/.claude/projects/')

  testSessionPath = path.join(CLAUDE_PROJECTS, dirs[0], `${TEST_SESSION_ID}.jsonl`)
  fs.writeFileSync(HTML_ARTIFACT_PATH, '<!doctype html><html><head><title>Feather artifact</title></head><body><h1>Rendered HTML artifact</h1><p>This is rendered markup, not source text.</p></body></html>')

  writeLine({
    type: 'user', uuid: 'e2e-msg-001', timestamp: '2025-06-15T14:00:00Z',
    isSidechain: false, isMeta: false,
    message: { role: 'user', content: 'Explain how **markdown** rendering works in `Feather`' },
  })
  writeLine({
    type: 'assistant', uuid: 'e2e-msg-002', timestamp: '2025-06-15T14:00:05Z',
    isSidechain: false, isMeta: false,
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Let me explain the markdown pipeline step by step.' },
        { type: 'text', text: `Feather uses **marked** with GFM support.\n\n## How it works\n\n1. Raw text goes through \`marked.parse()\`\n2. Output is sanitized with \`DOMPurify\`\n3. Result is cached in an LRU map\n\n\`\`\`js\nconst html = marked.parse(text)\nconst safe = DOMPurify.sanitize(html)\n\`\`\`\n\nThis keeps things **fast** and **secure**.\n\nLocal artifact: [Feather fixture](${path.join(HOME, 'feather-next/test/e2e/feather.spec.js')}:12)\n\nHTML artifact: [Rendered artifact](${HTML_ARTIFACT_PATH})` },
      ],
    },
  })
  writeLine({
    type: 'assistant', uuid: 'e2e-msg-003', timestamp: '2025-06-15T14:00:10Z',
    isSidechain: false, isMeta: false,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tool_e2e', name: 'Read', input: { file_path: '/src/MessageView.tsx' } }],
    },
  })
  writeLine({
    type: 'assistant', uuid: 'e2e-msg-004', timestamp: '2025-06-15T14:00:12Z',
    isSidechain: false, isMeta: false,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_result', tool_use_id: 'tool_e2e', content: 'export function MessageView() { ... }', is_error: false }],
    },
  })
  writeLine({
    type: 'assistant', uuid: 'e2e-msg-005', timestamp: '2025-06-15T14:00:15Z',
    isSidechain: false, isMeta: false,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_result', tool_use_id: 'tool_err', content: 'ENOENT: no such file', is_error: true }],
    },
  })
  writeLine({
    type: 'user', uuid: 'e2e-msg-006', timestamp: '2025-06-15T14:01:00Z',
    isSidechain: false, isMeta: false,
    message: { role: 'user', content: 'Thanks, that makes sense!' },
  })
})

test.afterAll(() => {
  try { fs.unlinkSync(testSessionPath) } catch {}
  try { fs.unlinkSync(HTML_ARTIFACT_PATH) } catch {}
})

// ── Helpers ─────────────────────────────────────────────────────────────────

async function openSidebar(page) {
  await page.locator('button:has-text("☰")').click()
  await page.waitForTimeout(300)
}

async function selectTestSession(page) {
  await openSidebar(page)
  // Find and click our test session by title text
  const sessionItem = page.locator(`text=Explain how`).first()
  await expect(sessionItem).toBeVisible({ timeout: 5000 })
  await sessionItem.click()
  await page.waitForTimeout(500)
}

// Send button uses an SVG polygon, no text. Find it by the polygon shape.
function sendButton(page) {
  return page.locator('button:has(svg polygon)')
}

// ── App shell ───────────────────────────────────────────────────────────────

test.describe('App shell', () => {
  test('shows empty state when no session selected', async ({ page }) => {
    await page.goto(BASE)
    await expect(page.getByText('Feather', { exact: true }).last()).toBeVisible({ timeout: 10000 })
    // No tabs should be visible
    await expect(page.locator('button:has-text("Chat")')).not.toBeVisible()
    await expect(page.locator('button:has-text("Terminal")')).not.toBeVisible()
  })

  test('hamburger exposes every chat harness without a nested menu', async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')
    await openSidebar(page)
    await expect(page.getByText('Feather', { exact: true }).first()).toBeVisible()
    await expect(page.locator('button:has-text("+ New OMP")')).toBeVisible()
    await expect(page.getByRole('button', { name: '+ Claude Code' }).last()).toBeVisible()
    await expect(page.getByRole('button', { name: '+ Codex' }).last()).toBeVisible()
    await expect(page.getByText('Other', { exact: true })).not.toBeVisible()
    await expect(page.getByText(/^Keep working: #/)).toHaveCount(0)
  })

  test('sidebar closes with Escape key', async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')
    // Hamburger should be visible initially
    await expect(page.locator('button:has-text("☰")')).toBeVisible()
    await openSidebar(page)
    // Hamburger hides when sidebar is open
    await expect(page.locator('button:has-text("☰")')).not.toBeVisible()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    // Hamburger should re-appear after sidebar closes
    await expect(page.locator('button:has-text("☰")')).toBeVisible()
  })

  test('sidebar shows our test session', async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')
    await openSidebar(page)
    await expect(page.locator(`text=Explain how`).first()).toBeVisible({ timeout: 5000 })
  })
})

// ── Session selection ───────────────────────────────────────────────────────

test.describe('Session selection', () => {
  test('selecting a session shows chat and terminal tabs', async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')
    await selectTestSession(page)
    await expect(page.locator('button:has-text("Chat")')).toBeVisible()
    await expect(page.locator('button:has-text("Terminal")')).toBeVisible()
  })

  test('selecting a session hides the empty state', async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')
    await selectTestSession(page)
    // Chat/Terminal tabs should now be visible (empty state is gone)
    await expect(page.locator('button:has-text("Chat")')).toBeVisible()
  })

  test('header shows session title after selection', async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')
    await selectTestSession(page)
    // The header should no longer show the placeholder
    await expect(page.getByText('Select a session', { exact: true })).not.toBeVisible()
  })

  test('SSE stream is established when session is selected', async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')

    const ssePromise = page.waitForRequest(req =>
      req.url().includes('/api/sessions/') && req.url().includes('/stream')
    )
    await selectTestSession(page)
    const sseReq = await ssePromise
    expect(sseReq.url()).toContain('/stream')
  })
})

// ── Message rendering ───────────────────────────────────────────────────────

test.describe('Message rendering', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')
    await selectTestSession(page)
    // Wait for messages to load
    await expect(page.locator('.markdown').first()).toBeVisible({ timeout: 5000 })
  })

  test('user message renders as right-aligned bubble', async ({ page }) => {
    // User messages should have flex-end alignment
    const userBubbles = page.locator('div[style*="flex-end"]')
    await expect(userBubbles.first()).toBeVisible()
  })

  test('assistant message renders as left-aligned bubble', async ({ page }) => {
    const assistantBubbles = page.locator('div[style*="flex-start"]')
    await expect(assistantBubbles.first()).toBeVisible()
  })

  test('markdown bold renders as <strong>', async ({ page }) => {
    // The assistant message contains **marked** and **fast** and **secure**
    const strongElements = page.locator('.markdown strong')
    const count = await strongElements.count()
    expect(count).toBeGreaterThanOrEqual(1)
    // Check specific text
    const allText = await page.locator('.markdown').allInnerTexts()
    const combined = allText.join(' ')
    expect(combined).toContain('marked')
    expect(combined).toContain('fast')
    expect(combined).toContain('secure')
  })

  test('markdown inline code renders as <code>', async ({ page }) => {
    const codeElements = page.locator('.markdown code')
    const count = await codeElements.count()
    expect(count).toBeGreaterThanOrEqual(1)
  })

  test('markdown heading renders as <h2>', async ({ page }) => {
    const h2 = page.locator('.markdown h2')
    await expect(h2.first()).toBeVisible()
    const text = await h2.first().innerText()
    expect(text).toContain('How it works')
  })

  test('markdown ordered list renders as <ol>', async ({ page }) => {
    const ol = page.locator('.markdown ol')
    await expect(ol.first()).toBeVisible()
    const items = page.locator('.markdown ol li')
    const count = await items.count()
    expect(count).toBe(3)
  })

  test('markdown code block renders as <pre><code>', async ({ page }) => {
    const pre = page.locator('.markdown pre')
    await expect(pre.first()).toBeVisible()
    const code = await pre.first().innerText()
    expect(code).toContain('marked.parse')
    expect(code).toContain('DOMPurify.sanitize')
  })

  test('markdown links to local artifacts use the Files preview endpoint', async ({ page }) => {
    const link = page.getByRole('link', { name: 'Feather fixture' })
    const expectedPath = path.join(HOME, 'feather-next/test/e2e/feather.spec.js')
    const expectedHref = `/api/files/raw?path=${encodeURIComponent(expectedPath)}`
    await expect(link).toHaveAttribute('href', expectedHref)

    const [preview] = await Promise.all([
      page.waitForEvent('popup'),
      link.click(),
    ])
    await preview.waitForLoadState()
    expect(preview.url()).toBe(new URL(expectedHref, BASE).href)
    await expect(preview.locator('body')).toContainText('Synthetic session setup')
  })

  test('markdown links to HTML artifacts open as rendered sandboxed pages', async ({ page }) => {
    const link = page.getByRole('link', { name: 'Rendered artifact' })
    const expectedHref = `/api/files/html?path=${encodeURIComponent(HTML_ARTIFACT_PATH)}`
    await expect(link).toHaveAttribute('href', expectedHref)

    const [preview] = await Promise.all([
      page.waitForEvent('popup'),
      link.click(),
    ])
    await preview.waitForLoadState()
    expect(preview.url()).toBe(new URL(expectedHref, BASE).href)
    await expect(preview.getByRole('heading', { name: 'Rendered HTML artifact' })).toBeVisible()
    await expect(preview.locator('body')).not.toContainText('<h1>')
  })

  test('thinking block renders as collapsible details', async ({ page }) => {
    const details = page.locator('details').filter({ has: page.locator('summary', { hasText: 'Thinking...' }) }).first()
    await expect(details).toBeVisible()
    const summary = details.locator('summary')
    await expect(summary).toHaveText('Thinking...')

    // Click to expand
    await summary.click()
    await page.waitForTimeout(200)
    const text = await details.locator('div').innerText()
    expect(text).toContain('markdown pipeline')
  })

  test('tool_use block shows tool name', async ({ page }) => {
    await page.getByText('3 tool steps', { exact: false }).click()
    // Should see "Read" in monospace
    const toolUse = page.locator('text=Read').first()
    await expect(toolUse).toBeVisible()
  })

  test('tool_result shows output label', async ({ page }) => {
    await page.getByText('3 tool steps', { exact: false }).click()
    // Tool results render with lowercase "output" label
    const result = page.locator('summary:has-text("output")')
    await expect(result.first()).toBeVisible()
  })

  test('error tool_result shows error label', async ({ page }) => {
    await page.getByText('3 tool steps', { exact: false }).click()
    // Error tool results render with lowercase "error" label
    const error = page.locator('summary:has-text("error")')
    await expect(error.first()).toBeVisible()
  })

  test('timestamps are displayed on messages', async ({ page }) => {
    // Timestamps are small text under each bubble
    const allText = await page.locator('span').allInnerTexts()
    const timePattern = /\d{1,2}:\d{2}/
    const timestamps = allText.filter(t => timePattern.test(t))
    expect(timestamps.length).toBeGreaterThanOrEqual(4)
  })
})

// ── Chat input ──────────────────────────────────────────────────────────────

test.describe('Chat input', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')
    await selectTestSession(page)
  })

  test('chat input is visible on chat tab', async ({ page }) => {
    const textarea = page.locator('textarea[placeholder="Send a message..."]')
    await expect(textarea).toBeVisible()
  })

  test('chat input is hidden on terminal tab', async ({ page }) => {
    await page.locator('button:has-text("Terminal")').click()
    await page.waitForTimeout(300)
    const textarea = page.locator('textarea[placeholder="Send a message..."]')
    await expect(textarea).not.toBeVisible()
  })

  test('send button is dim when input is empty', async ({ page }) => {
    const btn = sendButton(page)
    const bg = await btn.evaluate(el => getComputedStyle(el).backgroundColor)
    // Should be gray-ish (not green)
    expect(bg).not.toContain('74, 186, 106')
  })

  test('send button changes style when text is entered', async ({ page }) => {
    const textarea = page.locator('textarea[placeholder="Send a message..."]')
    const btn = sendButton(page)

    const bgEmpty = await btn.evaluate(el => getComputedStyle(el).backgroundColor)

    await textarea.fill('test')
    await page.waitForTimeout(100)

    const bgFilled = await btn.evaluate(el => getComputedStyle(el).backgroundColor)
    expect(bgFilled).not.toEqual(bgEmpty)
  })

  test('textarea auto-grows with multi-line input', async ({ page }) => {
    const textarea = page.locator('textarea[placeholder="Send a message..."]')
    const initialHeight = await textarea.evaluate(el => el.offsetHeight)

    await textarea.fill('Line 1\nLine 2\nLine 3\nLine 4\nLine 5')
    await textarea.dispatchEvent('input')
    await page.waitForTimeout(200)

    const newHeight = await textarea.evaluate(el => el.offsetHeight)
    expect(newHeight).toBeGreaterThan(initialHeight)
  })

  test('input clears after sending', async ({ page }) => {
    const textarea = page.locator('textarea[placeholder="Send a message..."]')
    await textarea.fill('test message to clear')
    await page.waitForTimeout(100)

    await sendButton(page).click()
    await page.waitForTimeout(300)

    const value = await textarea.inputValue()
    expect(value).toBe('')
  })

  test('Enter key sends, Shift+Enter adds newline', async ({ page }) => {
    const textarea = page.locator('textarea[placeholder="Send a message..."]')

    // Shift+Enter should not send
    await textarea.fill('line 1')
    await textarea.press('Shift+Enter')
    await page.waitForTimeout(100)
    const val = await textarea.inputValue()
    expect(val.length).toBeGreaterThan(0)

    // Enter should send and clear
    await textarea.fill('will be sent')
    await textarea.press('Enter')
    await page.waitForTimeout(300)
    const afterSend = await textarea.inputValue()
    expect(afterSend).toBe('')
  })
})

// ── Tab switching ───────────────────────────────────────────────────────────

test.describe('Tab switching', () => {
  test.beforeEach(async ({ page }) => {
    // Open by hash so these tab regressions also cover resuming a direct link
    // and do not depend on the server's intentionally stale session-list cache.
    await page.goto(`${BASE}/#${TEST_SESSION_ID}`)
    await expect(page.locator('p').filter({ hasText: 'Thanks, that makes sense!' }).first()).toBeVisible({ timeout: 10000 })
  })

  test('chat tab is active by default', async ({ page }) => {
    const chatTab = page.locator('button:has-text("Chat")')
    const borderBottom = await chatTab.evaluate(el => {
      const cs = getComputedStyle(el)
      return cs.borderBottomColor
    })
    expect(borderBottom).not.toBe('rgba(0, 0, 0, 0)')
    expect(borderBottom).not.toBe('transparent')
  })

  test('clicking terminal tab hides chat content', async ({ page }) => {
    await page.locator('button:has-text("Terminal")').click()
    await page.waitForTimeout(500)

    const textarea = page.locator('textarea[placeholder="Send a message..."]')
    await expect(textarea).not.toBeVisible()
  })

  test('switching back to chat shows messages again', async ({ page }) => {
    await page.locator('button:has-text("Terminal")').click()
    await page.waitForTimeout(300)

    await page.locator('button:has-text("Chat")').click()
    await page.waitForTimeout(300)

    await expect(page.locator('.markdown').first()).toBeVisible()
  })

  test('prompts tab shows only user asks and hides the composer', async ({ page }) => {
    await page.getByRole('button', { name: 'Prompts', exact: true }).click()
    const panel = page.getByTestId('prompts-panel')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('Explain how **markdown** rendering works in `Feather`')
    await expect(panel).toContainText('Thanks, that makes sense!')
    await expect(panel).not.toContainText('Feather uses marked')
    await expect(page.locator('textarea[placeholder="Send a message..."]')).not.toBeVisible()
  })

  test('updates tab explains chats that are not assigned to a Room', async ({ page }) => {
    await page.getByRole('button', { name: 'Updates', exact: true }).click()
    const panel = page.getByTestId('updates-panel')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText("This chat isn't in a Room")
    await expect(page.locator('textarea[placeholder="Send a message..."]')).not.toBeVisible()
  })
})

test('updates tab loads the selected chat Room feed newest first', async ({ page }) => {
  const room = {
    name: 'e2e-room', cwd: '/tmp/e2e-room', active: false, latest: null, updatedAt: null,
    sessions: [{ id: TEST_SESSION_ID, title: 'Explain how markdown rendering works', updatedAt: '2025-06-15T14:01:00Z', isActive: false }],
    updates: { count: 2, latestAt: '2025-06-15T14:03:00Z', latest: 'newest room update' },
    pulse: { enabled: false, status: 'paused', lastRunAt: null, nextRunAt: null, sessionId: null },
  }
  await page.route('**/api/rooms', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rooms: [room] }) }))
  await page.route('**/api/rooms/e2e-room/updates', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ updates: [
      { id: 'one', ts: '2025-06-15T14:02:00Z', text: 'older room update' },
      { id: 'two', ts: '2025-06-15T14:03:00Z', text: 'newest room update' },
    ] }),
  }))
  await page.goto(`${BASE}/#${TEST_SESSION_ID}`)
  await expect(page.locator('p').filter({ hasText: 'Thanks, that makes sense!' }).first()).toBeVisible({ timeout: 10000 })
  await page.getByRole('button', { name: 'Updates', exact: true }).click()

  const panel = page.getByTestId('updates-panel')
  await expect(panel).toContainText('Updates for #e2e-room')
  await expect(panel).toContainText('newest room update')
  const feedText = await panel.innerText()
  expect(feedText.indexOf('newest room update')).toBeLessThan(feedText.indexOf('older room update'))
})

// ── Live SSE updates in the browser ─────────────────────────────────────────

test.describe('Live updates', () => {
  test('new message appears in real-time via SSE', async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')
    await selectTestSession(page)
    await expect(page.locator('.markdown').first()).toBeVisible({ timeout: 5000 })

    const liveUuid = `e2e-live-${Date.now()}`
    writeLine({
      type: 'user', uuid: liveUuid, timestamp: '2025-06-15T14:05:00Z',
      isSidechain: false, isMeta: false,
      message: { role: 'user', content: 'This message arrived via SSE live update!' },
    })

    // The new message should appear without page reload
    await expect(page.locator('text=This message arrived via SSE live update!')).toBeVisible({ timeout: 10000 })
  })
})

// ── Mobile viewport ─────────────────────────────────────────────────────────

test.describe('Mobile viewport', () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test('hamburger is visible on mobile', async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('button:has-text("☰")')).toBeVisible()
  })

  test('sidebar opens and fills screen on mobile', async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')
    await openSidebar(page)
    await expect(page.locator('button:has-text("+ New OMP")')).toBeVisible()
  })

  test('messages are readable on mobile', async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')
    await selectTestSession(page)
    await expect(page.locator('.markdown').first()).toBeVisible({ timeout: 5000 })

    const firstMd = page.locator('.markdown').first()
    const color = await firstMd.evaluate(el => getComputedStyle(el).color)
    expect(color).not.toBe('rgba(0, 0, 0, 0)')
  })

  test('chat input works on mobile', async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')
    await selectTestSession(page)

    const textarea = page.locator('textarea[placeholder="Send a message..."]')
    await expect(textarea).toBeVisible()
    await textarea.fill('mobile test')
    // On mobile (Playwright uses Chromium UA, not iPhone), send button should still be visible
    await expect(sendButton(page)).toBeVisible()
  })
})
