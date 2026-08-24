// @ts-check
import { test, expect } from '@playwright/test'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const BASE = process.env.FEATHER_URL || 'http://localhost:4870'
const HOME = process.env.HOME || '/home/user'
const CLAUDE_PROJECTS = path.join(HOME, '.claude/projects')
const SESSION_ID = `e2e-terminal-reflow-${Date.now()}`
const TMUX_NAME = `f-${SESSION_ID}`
const TITLE = `Terminal reflow ${Date.now()}`
const FIXTURE = fileURLToPath(new URL('../fixtures/terminal-reflow.js', import.meta.url))
let sessionPath = ''

test.use({ hasTouch: true, viewport: { width: 390, height: 844 } })

test.beforeAll(async () => {
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
  try { execFileSync('tmux', ['kill-session', '-t', `=${TMUX_NAME}`], { stdio: 'ignore' }) } catch {}
  execFileSync('tmux', [
    'new-session', '-d', '-s', TMUX_NAME, '-x', '80', '-y', '24',
    `node ${FIXTURE}`,
  ])
  await new Promise(resolve => setTimeout(resolve, 150))
})

test.afterAll(() => {
  try { execFileSync('tmux', ['kill-session', '-t', `=${TMUX_NAME}`], { stdio: 'ignore' }) } catch {}
  try { fs.unlinkSync(sessionPath) } catch {}
})

test('a first open at a different viewport reveals only the settled current screen', async ({ page }) => {
  await page.goto(`${BASE}/#${SESSION_ID}`)
  await expect(page.getByText(TITLE, { exact: true }).first()).toBeVisible({ timeout: 10_000 })

  const socketPromise = page.waitForEvent('websocket', socket => new URL(socket.url()).pathname.endsWith('/api/terminal'))
  const clickedAt = Date.now()
  await page.getByRole('button', { name: 'Terminal', exact: true }).click()
  const socket = await socketPromise
  const terminalUrl = new URL(socket.url())
  expect(Number(terminalUrl.searchParams.get('cols'))).toBeGreaterThan(20)
  expect(Number(terminalUrl.searchParams.get('rows'))).toBeGreaterThan(5)

  let firstFrameMs = null
  let receivedBytes = 0
  let received = ''
  socket.on('framereceived', event => {
    if (firstFrameMs === null) firstFrameMs = Date.now() - clickedAt
    const value = Buffer.isBuffer(event.payload) ? event.payload : Buffer.from(String(event.payload))
    receivedBytes += value.length
    received += value.toString()
  })

  await expect.poll(() => received.includes('FINAL'), { timeout: 3_000 }).toBe(true)
  await page.waitForTimeout(750)
  expect(firstFrameMs).not.toBeNull()
  expect(firstFrameMs).toBeLessThan(1_200)
  expect(receivedBytes).toBeLessThan(50_000)
  expect(received).not.toContain('reflow-05000')
  expect(received).toContain('winch=1')

  const geometry = execFileSync('tmux', [
    'display-message', '-p', '-t', TMUX_NAME, '#{pane_width}|#{pane_height}|#{history_size}',
  ], { encoding: 'utf8' }).trim().split('|').map(Number)
  expect(geometry[0]).toBe(Number(terminalUrl.searchParams.get('cols')))
  expect(geometry[1]).toBe(Number(terminalUrl.searchParams.get('rows')) - 1)
  expect(geometry[2]).toBeGreaterThan(1_000)
})
