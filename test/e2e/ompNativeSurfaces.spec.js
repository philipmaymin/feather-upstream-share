// @ts-check
import { test, expect } from '@playwright/test'
import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'

const BASE = process.env.FEATHER_URL || 'http://localhost:4870'
const HOME = process.env.HOME || '/home/user'
const SESSION_ID = `e2e-omp-native-${Date.now()}`
let sessionPath
let tokenPath
test.use({ viewport: { width: 390, height: 844 } })


function writeLine(entry) {
  fs.appendFileSync(sessionPath, `${JSON.stringify(entry)}\n`)
}

test.beforeAll(() => {
  const projectsRoot = path.join(HOME, '.claude', 'projects')
  const project = fs.readdirSync(projectsRoot).find(name => fs.statSync(path.join(projectsRoot, name)).isDirectory())
  if (!project) throw new Error('No Claude project directory available')
  sessionPath = path.join(projectsRoot, project, `${SESSION_ID}.jsonl`)

  writeLine({
    type: 'user', uuid: 'native-user-1', timestamp: '2026-08-24T00:00:00Z', isSidechain: false, isMeta: false,
    message: { role: 'user', content: 'Inspect the native OMP surfaces.' },
  })
  writeLine({
    type: 'assistant', uuid: 'native-trace-1', timestamp: '2026-08-24T00:00:01Z', isSidechain: false, isMeta: false,
    message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'Private reasoning stays folded.' },
      { type: 'tool_use', id: 'read-1', name: 'Read', intent: 'Reading native surface state', input: { path: '/tmp/private-native-state' } },
    ] },
  })
  writeLine({
    type: 'assistant', uuid: 'native-result-1', timestamp: '2026-08-24T00:00:02Z', isSidechain: false, isMeta: false,
    message: { role: 'assistant', content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'private result', is_error: false }] },
  })
  writeLine({
    type: 'assistant', uuid: 'native-final-1', timestamp: '2026-08-24T00:00:03Z', isSidechain: false, isMeta: false,
    message: { role: 'assistant', content: [{ type: 'text', text: 'Initial inspection complete.' }] },
  })
  writeLine({
    type: 'assistant', uuid: 'native-question-1', timestamp: '2026-08-24T00:00:04Z', isSidechain: false, isMeta: false,
    message: { role: 'assistant', content: [{
      type: 'tool_use', id: 'ask-1', name: 'ask', input: { questions: [{ id: 'scope', header: 'Scope', question: 'Which surface should ship?', options: [{ label: 'All native surfaces', description: 'Streaming, Todo, jobs, and metadata.' }, { label: 'Streaming only' }], recommended: 0 }] },
    }] },
  })

  const tokenDir = path.join(HOME, '.feather', 'omp-sessions', '.feather-bridge-tokens')
  fs.mkdirSync(tokenDir, { recursive: true })
  tokenPath = path.join(tokenDir, createHash('sha256').update(SESSION_ID).digest('hex'))
  fs.writeFileSync(tokenPath, 'e2e-native-token', { mode: 0o600 })
})

test.afterAll(() => {
  try { fs.unlinkSync(sessionPath) } catch {}
  try { fs.unlinkSync(tokenPath) } catch {}
})

test('renders and reconciles OMP-native live surfaces', async ({ page }) => {
  await page.goto(`${BASE}/#${SESSION_ID}`)
  await expect(page.getByText('Initial inspection complete.')).toBeVisible()
  await expect(page.getByText('/tmp/private-native-state')).not.toBeVisible()
  await page.getByTestId('work-log-summary').click()
  await page.getByText('tmp/private-native-state', { exact: true }).click()
  await expect(page.getByText('/tmp/private-native-state')).toBeVisible()
  await expect(page.getByText('Which surface should ship?')).toBeVisible()
  await expect(page.getByRole('button', { name: /All native surfaces/ })).toBeVisible()

  const response = await fetch(`${BASE}/api/internal/sessions/${SESSION_ID}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Feather-Bridge-Token': 'e2e-native-token' },
    body: JSON.stringify({ events: [
      { type: 'assistant_snapshot', messageId: 'stream-1', text: 'This answer is arriving token by token.' },
      { type: 'todo', phases: [{ name: 'Build', tasks: [{ content: 'Wire bridge', status: 'completed' }, { content: 'Verify native UI', status: 'in_progress' }] }], op: 'start', isError: false },
      { type: 'session_state', modelProvider: 'openai', modelId: 'gpt-5.6', modelApi: 'responses', thinkingLevel: 'high', serviceTiers: { openai: 'priority' }, contextTokens: 42000, contextWindow: 200000, contextPercent: 21 },
      { type: 'subagent_lifecycle', id: 'agent-1', agent: 'scout', status: 'started', index: 0, detached: true, description: 'Map OMP events' },
      { type: 'async_jobs', running: [{ id: 'job-1', type: 'task', status: 'running', startTime: 100, label: 'Bridge extension' }], recent: [], delivery: { queued: 0, delivering: 0 } },
      { type: 'tool_approval_requested', toolCallId: 'approval-1', toolName: 'write', approvalMode: 'write', reason: 'Mutates a file' },
    ] }),
  })
  expect(response.status).toBe(204)

  await expect(page.getByTestId('assistant-stream')).toContainText('arriving token by token')
  await expect(page.getByText(/Todo · 1\/2/)).toBeVisible()
  await expect(page.getByText('Verify native UI', { exact: true })).toBeVisible()
  await expect(page.getByTestId('omp-runtime')).toContainText('openai/gpt-5.6')
  await expect(page.getByTestId('omp-subagents')).toContainText('scout')
  await expect(page.getByTestId('omp-jobs')).toContainText('Background jobs · 1 running')
  await expect(page.getByTestId('omp-approval')).toContainText('Mutates a file')
  await expect(page.getByRole('button', { name: 'Approve' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Reject' })).toBeEnabled()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: '/tmp/feather-omp-native-mobile.png', fullPage: false })


  writeLine({
    type: 'assistant', uuid: `native-stream-final-${Date.now()}`, timestamp: new Date().toISOString(), isSidechain: false, isMeta: false,
    message: { role: 'assistant', content: [{ type: 'text', text: 'This answer is now durable.' }] },
  })
  await expect(page.getByText('This answer is now durable.')).toBeVisible()
  await expect(page.getByTestId('assistant-stream')).toHaveCount(0)
})
