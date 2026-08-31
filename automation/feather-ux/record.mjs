#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const playwrightRoot = path.resolve(process.env.FEATHER_UX_PLAYWRIGHT_ROOT || sourceRoot)
const require = createRequire(path.join(playwrightRoot, 'package.json'))
const { chromium } = require('playwright')
const BASE_URL = process.env.FEATHER_URL || 'http://127.0.0.1:4871'
const OUTPUT_DIR = path.resolve(process.argv[2] || '')
const FOCUS = process.argv[3] || 'outcome-inbox'
const VIEWPORT = { width: 390, height: 844 }
const PAUSE_MS = Number(process.env.FEATHER_UX_PAUSE_MS || 1600)

if (!process.argv[2]) throw new Error('usage: record.mjs OUTPUT_DIR [FOCUS]')

const now = Date.now()
const timestamp = minutesAgo => new Date(now - minutesAgo * 60_000).toISOString()
const leaderMessages = [
  { uuid: 'synthetic-user-1', role: 'user', timestamp: timestamp(19), content: [{ type: 'text', text: 'Is the release ready, and what still needs my decision?' }] },
  { uuid: 'synthetic-assistant-1', role: 'assistant', timestamp: timestamp(18), content: [{ type: 'text', text: 'The candidate passed every automated gate. The only remaining decision is whether to use the cautious or immediate channel.' }] },
]

const waitingPost = {
  id: 'synthetic-waiting', kind: 'session', timestamp: timestamp(1), sessionId: 'leader-alpha', room: 'launch',
  projectId: 'launch', projectLabel: 'Launch', title: 'Choose the release channel', agent: 'omp', status: 'waiting',
  question: 'Cautious rollout tomorrow, or immediate rollout now?', message: leaderMessages[1], score: 1000,
  why: 'Waiting for your decision', importance: 'feature', comments: [],
}
const resultPost = {
  id: 'synthetic-result', kind: 'session', timestamp: timestamp(7), sessionId: 'research-result', room: 'research',
  projectId: 'research', projectLabel: 'Research', title: 'Mobile release audit completed', agent: 'omp', status: 'finished',
  message: {
    uuid: 'synthetic-result-message', role: 'assistant', timestamp: timestamp(7), content: [{ type: 'text', text: '## Release result\n\nThe complete mobile journey passed. Waiting decisions remain first, Room questions open the Leader directly, and the exact immutable asset matches both production listeners.\n\n- 98 browser checks passed\n- no cross-chat routing errors\n- rollback receipt verified\n\nThe next useful action is to review the one remaining visual hierarchy concern shown in the attached release map.' }],
  },
  score: 900, why: 'Important verified result', importance: 'feature',
  media: { kind: 'image', path: '/synthetic/release-map.svg', name: 'release-map.svg' }, comments: [],
}
const longPost = {
  id: 'synthetic-long-result', kind: 'session', timestamp: timestamp(12), sessionId: 'analysis-result', room: 'analysis',
  projectId: 'analysis', projectLabel: 'Analysis', title: 'Evidence review narrowed to one change', agent: 'codex', status: 'finished',
  message: {
    uuid: 'synthetic-long-message', role: 'assistant', timestamp: timestamp(12), content: [{ type: 'text', text: 'The review compared the complete phone journey at each step rather than scoring isolated screenshots. The first explanation fit the evidence, but the counterexample showed that density alone was not the cause. The actual problem was two equally strong actions competing in the same decision row. The proposed repair keeps one primary action, moves history into secondary disclosure, preserves keyboard access, and changes no data contract. A second pass reproduced the issue at 390 pixels, while the wide layout remained clear. This paragraph is intentionally long enough to exercise collapsed-result behavior without exposing any real transcript or artifact.' }],
  },
  score: 800, why: 'Important verified result', importance: 'feature', comments: [],
}
const quietPost = {
  id: 'synthetic-note', kind: 'room-update', timestamp: timestamp(14), sessionId: 'leader-alpha', room: 'launch',
  projectId: 'launch', projectLabel: 'Launch', title: 'Receipt filenames normalized', agent: null, status: 'finished',
  updateText: 'Internal receipt filenames were normalized for the next audit.', score: 100,
  why: 'Quiet note', importance: 'note', comments: [],
}

const sessions = [
  { id: 'leader-alpha', title: '#launch Leader', updatedAt: timestamp(1), isActive: true, agent: 'omp', projectId: 'launch', projectLabel: 'Launch', roomAssigned: true },
  { id: 'caretaker-alpha', title: '#launch Caretaker', updatedAt: timestamp(8), isActive: true, agent: 'omp', projectId: 'launch', projectLabel: 'Launch', roomAssigned: true },
  { id: 'history-alpha', title: 'Earlier launch discussion', updatedAt: timestamp(120), isActive: false, agent: 'claude', projectId: 'launch', projectLabel: 'Launch', roomAssigned: true },
  { id: 'research-result', title: 'Mobile release audit completed', updatedAt: timestamp(7), isActive: false, agent: 'omp', projectId: 'research', projectLabel: 'Research' },
  { id: 'analysis-result', title: 'Evidence review narrowed to one change', updatedAt: timestamp(12), isActive: false, agent: 'codex', projectId: 'analysis', projectLabel: 'Analysis' },
]

const room = {
  name: 'launch', cwd: '/synthetic/rooms/launch', sessions: sessions.slice(0, 3), leaderSessionId: 'leader-alpha', active: true,
  latest: { role: 'assistant', text: 'The candidate passed every automated gate. One release-channel decision remains.' },
  updatedAt: timestamp(1), updates: { count: 1, latestAt: timestamp(14), latest: 'One synthetic update' },
  friction: { count: 0, latestAt: null, latest: null },
  residents: [
    { role: 'leader', sessionId: 'leader-alpha', title: '#launch Leader', agent: 'omp', status: 'active' },
    { role: 'caretaker', sessionId: 'caretaker-alpha', title: '#launch Caretaker', agent: 'omp', status: 'active' },
  ],
  pulse: { enabled: false, status: 'paused', lastRunAt: null, nextRunAt: null, sessionId: null },
}

function feedResponse(mode) {
  const posts = mode === 'needs-me'
    ? [waitingPost]
    : mode === 'latest'
      ? [waitingPost, resultPost, longPost, quietPost]
      : [waitingPost, resultPost, longPost]
  return {
    generatedAt: new Date(now).toISOString(), nextBefore: null,
    counts: { waiting: 1, working: 0, errored: 0, finished: 3, important: 4, notes: 1 }, posts,
  }
}

async function installSyntheticRoutes(page) {
  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const apiPath = url.pathname
    if (apiPath === '/api/feed') return route.fulfill({ json: feedResponse(url.searchParams.get('mode') || 'for-you') })
    if (apiPath === '/api/me') return route.fulfill({ json: { username: 'demo', admin: false } })
    if (apiPath === '/api/agents') return route.fulfill({ json: { agents: [{ id: 'omp', label: 'oh-my-pi', available: true, default: true }, { id: 'claude', label: 'Claude Code', available: true }, { id: 'codex', label: 'Codex', available: true }] } })
    if (apiPath === '/api/rooms') return route.fulfill({ json: { rooms: [room] } })
    if (apiPath === '/api/sessions' && request.method() === 'GET') return route.fulfill({ json: { sessions } })
    if (apiPath === '/api/sessions/leader-alpha/messages') return route.fulfill({ json: { messages: leaderMessages, hasMore: false } })
    if (apiPath === '/api/sessions/history-alpha/messages') return route.fulfill({ json: { messages: leaderMessages, hasMore: false } })
    if (/^\/api\/sessions\/[^/]+\/messages$/.test(apiPath)) return route.fulfill({ json: { messages: [resultPost.message], hasMore: false } })
    if (/^\/api\/sessions\/[^/]+\/protocol-runs$/.test(apiPath)) return route.fulfill({ json: { runs: [] } })
    if (/^\/api\/sessions\/[^/]+\/room$/.test(apiPath)) return route.fulfill({ json: { room: 'launch' } })
    if (/^\/api\/sessions\/[^/]+\/stream$/.test(apiPath)) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': synthetic\n\n' })
    if (apiPath === '/api/starred') return route.fulfill({ json: {} })
    if (apiPath === '/api/sidecar') return route.fulfill({ json: { groups: [] } })
    if (apiPath === '/api/quick-links') return route.fulfill({ json: [] })
    if (apiPath === '/api/version') return route.fulfill({ json: { version: 'synthetic-review' } })
    if (apiPath === '/api/files/media') return route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="#10181d"/><path d="M90 350h190l80-150 130 210 110-250 110 190h160" fill="none" stroke="#b8ff5a" stroke-width="18"/><text x="90" y="105" fill="#eef2f4" font-family="sans-serif" font-size="44">Synthetic release map</text></svg>',
    })
    if (/^\/api\/feed\/[^/]+\/(reaction|comments)$/.test(apiPath)) return route.fulfill({ status: 403, json: { error: 'synthetic review is read-only' } })
    return route.fulfill({ status: 404, json: { error: `synthetic fixture has no ${apiPath}` } })
  })
}

async function pause(page, label, screenshots) {
  await page.waitForTimeout(PAUSE_MS)
  const file = path.join(OUTPUT_DIR, `${String(screenshots.length + 1).padStart(2, '0')}-${label}.png`)
  await page.screenshot({ path: file, fullPage: false })
  screenshots.push(path.basename(file))
}

async function privacyCheck(page) {
  const visible = await page.locator('body').innerText()
  const forbidden = [/\/home\//i, /feather-uploads/i, /telegram/i, /@maymin/i, /philip/i, /device code/i, /oauth/i]
  const match = forbidden.find(pattern => pattern.test(visible))
  if (match) throw new Error(`privacy guard rejected visible content matching ${match}`)
}

async function runOutcomeInbox(page, screenshots) {
  await pause(page, 'for-you', screenshots)
  await page.getByRole('button', { name: 'Latest', exact: true }).click()
  await page.getByText('Receipt filenames normalized', { exact: true }).scrollIntoViewIfNeeded()
  await pause(page, 'latest-notes', screenshots)
  await page.getByRole('button', { name: 'Needs Me', exact: true }).click()
  await pause(page, 'needs-me', screenshots)
  await page.getByRole('button', { name: 'For You', exact: true }).click()
  await page.getByRole('button', { name: 'Ask a follow-up' }).first().click()
  const reply = page.getByLabel('Ask about this result')
  await reply.fill('What would make the cautious channel safer?')
  await pause(page, 'focused-question', screenshots)
  await reply.fill('')
}

async function runRoomQuestion(page, screenshots) {
  await page.locator('.fledge-bottom-nav').getByRole('button', { name: 'Rooms' }).click()
  await pause(page, 'rooms', screenshots)
  await page.getByTestId('history-launch').click()
  await pause(page, 'room-history', screenshots)
  await page.getByTestId('open-room-launch').click()
  await page.waitForSelector('textarea[placeholder="Send a message..."]')
  const composer = page.locator('textarea[placeholder="Send a message..."]')
  await composer.fill('What needs my decision?')
  await pause(page, 'leader-question', screenshots)
  await composer.fill('')
}

async function runConversationReturn(page, screenshots) {
  const scroller = page.getByTestId('fledge-feed')
  await scroller.evaluate(element => { element.scrollTop = 260 })
  const before = await scroller.evaluate(element => element.scrollTop)
  await pause(page, 'feed-position', screenshots)
  await page.getByRole('heading', { name: 'Mobile release audit completed' }).click()
  await page.waitForSelector('[data-testid="chat-panel"]')
  await pause(page, 'conversation', screenshots)
  await page.goBack()
  await page.waitForSelector('[data-testid="fledge-home"]')
  const after = await scroller.evaluate(element => element.scrollTop)
  if (Math.abs(after - before) > 4) throw new Error(`feed position changed from ${before} to ${after}`)
  await pause(page, 'returned-feed-position', screenshots)
}

async function runRichResults(page, screenshots) {
  const card = page.getByTestId('fledge-post').filter({ hasText: 'Mobile release audit completed' })
  await card.scrollIntoViewIfNeeded()
  await pause(page, 'rich-result', screenshots)
  const more = card.locator('.fledge-more')
  if (await more.count()) await more.click()
  await pause(page, 'expanded-result', screenshots)
  await card.getByRole('button', { name: 'Ask a follow-up' }).click()
  await pause(page, 'rich-result-question', screenshots)
}

const JOURNEYS = {
  'outcome-inbox': runOutcomeInbox,
  'room-question': runRoomQuestion,
  'conversation-return': runConversationReturn,
  'rich-results': runRichResults,
}

if (!JOURNEYS[FOCUS]) throw new Error(`unknown focus ${FOCUS}; expected ${Object.keys(JOURNEYS).join(', ')}`)

await fs.mkdir(OUTPUT_DIR, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport: VIEWPORT,
  deviceScaleFactor: 1,
  hasTouch: true,
  isMobile: true,
  serviceWorkers: 'block',
  recordVideo: { dir: OUTPUT_DIR, size: VIEWPORT },
})
const page = await context.newPage()
const screenshots = []
try {
  await installSyntheticRoutes(page)
  await page.goto(`${BASE_URL}/?app=fledge&synthetic-review=${encodeURIComponent(FOCUS)}`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="fledge-home"]')
  await privacyCheck(page)
  await JOURNEYS[FOCUS](page, screenshots)
  await privacyCheck(page)
  const metrics = await page.evaluate(() => ({
    title: document.title,
    viewport: { width: innerWidth, height: innerHeight },
    visibleTextCharacters: document.body.innerText.length,
    feedPosts: document.querySelectorAll('[data-testid="fledge-post"]').length,
    roomCards: document.querySelectorAll('[data-testid^="room-card-"]').length,
    activeElement: document.activeElement?.getAttribute('aria-label') || document.activeElement?.getAttribute('placeholder') || document.activeElement?.tagName || null,
  }))
  await fs.writeFile(path.join(OUTPUT_DIR, 'recording.json'), JSON.stringify({
    schema: 1,
    synthetic: true,
    focus: FOCUS,
    baseUrl: new URL(BASE_URL).origin,
    viewport: VIEWPORT,
    recordedAt: new Date().toISOString(),
    screenshots,
    metrics,
  }, null, 2) + '\n')
} finally {
  await page.close()
  await context.close()
  await browser.close()
}

const files = await fs.readdir(OUTPUT_DIR)
const video = files.find(file => file.endsWith('.webm'))
if (!video) throw new Error('Playwright did not produce a recording')
await fs.rename(path.join(OUTPUT_DIR, video), path.join(OUTPUT_DIR, 'journey.webm'))
console.log(JSON.stringify({ focus: FOCUS, outputDir: OUTPUT_DIR, video: 'journey.webm', screenshots }))
