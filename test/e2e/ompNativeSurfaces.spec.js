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

async function postEvents(events) {
  return fetch(`${BASE}/api/internal/sessions/${SESSION_ID}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Feather-Bridge-Token': 'e2e-native-token' },
    body: JSON.stringify({ version: 4, events }),
  })
}

test.beforeAll(() => {
  const projectsRoot = path.join(HOME, '.claude', 'projects')
  const project = fs.readdirSync(projectsRoot).find(name => fs.statSync(path.join(projectsRoot, name)).isDirectory())
  if (!project) throw new Error('No Claude project directory available')
  sessionPath = path.join(projectsRoot, project, `${SESSION_ID}.jsonl`)
  writeLine({
    type: 'user', uuid: 'native-user-1', timestamp: '2026-08-24T00:00:00Z', isSidechain: false, isMeta: false,
    message: { role: 'user', content: 'Mirror the parent and child OMP work.' },
  })
  writeLine({
    type: 'assistant', uuid: 'native-final-1', timestamp: '2026-08-24T00:00:01Z', isSidechain: false, isMeta: false,
    message: { role: 'assistant', content: [{ type: 'text', text: 'Ready for deterministic bridge events.' }] },
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

test('mirrors parent and child execution across completion, replay, and responsive layouts', async ({ page }) => {
  await page.goto(`${BASE}/#${SESSION_ID}`)
  await expect(page.getByText('Ready for deterministic bridge events.')).toBeVisible()
  const health = await (await fetch(`${BASE}/api/health`)).json()
  await expect(page.locator('html')).toHaveAttribute('data-build-version', health.version)
  await expect(page.getByTestId('build-version')).toBeVisible()
  await expect(page.getByTestId('build-version')).toHaveAttribute('title', `Build ${health.version}`)

  const started = await postEvents([
    { type: 'agent_start' },
    { type: 'assistant_snapshot', messageId: 'answer-1', text: 'The parent is inspecting the bridge.' },
    { type: 'todo', phases: [{ name: 'Mirror', tasks: [{ content: 'Normalize parent tools', status: 'completed' }, { content: 'Verify child inspector', status: 'in_progress' }] }] },
    { type: 'session_state', modelProvider: 'openai', modelId: 'gpt-5.6', modelApi: 'responses', thinkingLevel: 'high', contextTokens: 42000, contextWindow: 200000, contextPercent: 21 },
    { type: 'work_snapshot', messageId: 'answer-1', blocks: [{ type: 'thinking', thinking: 'Planning the parent execution sequence.' }] },
    { type: 'tool_execution_start', toolCallId: 'parent-read', toolName: 'read', args: { path: '/tmp/parent-state' }, intent: 'Reading parent bridge state' },
    { type: 'tool_execution_update', toolCallId: 'parent-read', toolName: 'read', partialResult: 'Parent state is arriving.' },
    { type: 'assistant_cancel', messageId: 'answer-1', willContinue: true },
    { type: 'tool_execution_start', toolCallId: 'current-check', toolName: 'bash', args: { command: 'printf current' }, intent: 'Testing current execution segment' },
    { type: 'tool_execution_update', toolCallId: 'current-check', toolName: 'bash', partialResult: 'Current segment is running.' },
    { type: 'tool_execution_start', toolCallId: 'spawn-child', toolName: 'task', args: { tasks: [{ agent: 'scout', task: 'Inspect nested bridge events' }] }, intent: 'Delegating bridge inspection' },
    { type: 'tool_execution_end', toolCallId: 'spawn-child', toolName: 'task', result: 'Started scout.', isError: false },
    { type: 'tool_execution_start', toolCallId: 'wait-child', toolName: 'hub', args: { op: 'wait' }, intent: 'Waiting for scout' },
    { type: 'tool_execution_end', toolCallId: 'wait-child', toolName: 'hub', result: 'Scout completed.', isError: false },
    { type: 'subagent_lifecycle', id: 'child-1', agent: 'scout', agentSource: 'task', status: 'started', index: 0, assignment: 'Inspect nested bridge events', task: 'Map child events', resolvedModel: 'gpt-5.6-mini', parentToolCallId: 'spawn-child' },
    { type: 'todo', subagentId: 'child-1', phases: [{ name: 'Child', tasks: [{ content: 'Trace nested tool', status: 'in_progress' }] }] },
    { type: 'work_snapshot', subagentId: 'child-1', messageId: 'child-answer-1', blocks: [{ type: 'thinking', thinking: 'Child-only reasoning stays in the inspector.' }] },
    { type: 'tool_execution_start', subagentId: 'child-1', toolCallId: 'child-grep', toolName: 'grep', args: { pattern: 'subagentId' }, intent: 'Tracing nested event routing' },
    { type: 'assistant_snapshot', subagentId: 'child-1', messageId: 'child-answer-1', text: 'Child answer is arriving.' },
    { type: 'tool_execution_update', subagentId: 'child-1', toolCallId: 'child-grep', toolName: 'grep', partialResult: 'Nested match found.' },
    { type: 'work_snapshot', subagentId: 'child-1', messageId: 'child-answer-2', blocks: [{ type: 'thinking', thinking: 'Reviewing child output.' }] },
    { type: 'assistant_snapshot', subagentId: 'child-1', messageId: 'child-answer-2', text: 'Child answer is arriving.' },
  ])

  writeLine({
    type: 'assistant', uuid: `native-live-trace-${Date.now()}`, timestamp: new Date().toISOString(), isSidechain: false, isMeta: false,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'durable-parent-read', name: 'Read', input: { path: '/tmp/durable-parent' } }] },
  })
  expect(started.status).toBe(204)
  await expect(page.getByTestId('omp-parent-execution')).toBeVisible({ timeout: 10000 })
  await expect(page.getByTestId('live-work-turn')).toHaveCount(0)

  const promptsTab = page.getByRole('button', { name: 'Prompts', exact: true })
  await expect(promptsTab).toBeVisible()
  await expect(page.getByRole('button', { name: /Todos/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Agents/ })).toHaveCount(0)

  const chatPanel = page.getByTestId('chat-panel')
  const parentExecution = chatPanel.getByTestId('omp-parent-execution')
  const detailsSummary = chatPanel.getByTestId('omp-parent-execution-summary')
  await expect(parentExecution).toBeVisible()
  await expect(parentExecution).toHaveJSProperty('open', false)
  await expect(detailsSummary).toContainText('Testing current execution segment')
  await expect(detailsSummary).toContainText('Activity')
  await expect(detailsSummary).not.toContainText('Working')
  await expect(detailsSummary).not.toContainText('0 steps')
  await expect(parentExecution.getByTestId('omp-todo')).toBeHidden()
  await expect(parentExecution.getByTestId('omp-parent-execution-timeline').getByTestId('omp-tool-card')).toHaveCount(2)
  await expect(chatPanel.getByTestId('thinking-indicator')).toHaveCount(0)
  await page.screenshot({ path: '/tmp/feather-work-details-closed-mobile.png', fullPage: false })

  await detailsSummary.click()
  await expect(parentExecution).toHaveJSProperty('open', true)
  await expect(parentExecution.getByTestId('omp-todo')).toContainText('Verify child inspector')
  await expect(parentExecution.getByTestId('omp-todo')).toContainText('1/2')
  const detailedParentExecution = parentExecution.getByTestId('omp-parent-execution-timeline')
  await expect(detailedParentExecution.getByTestId('omp-tool-card')).toHaveCount(2)
  expect(await detailedParentExecution.getByTestId('omp-tool-card').evaluateAll(cards =>
    cards.map(card => card.getAttribute('data-tool-call-id')))).toEqual(['parent-read', 'current-check'])
  const currentTool = detailedParentExecution.locator('[data-tool-call-id="current-check"]')
  await expect(currentTool.locator('.execution-tool-intent')).toContainText('Testing current execution segment')
  await expect(currentTool.locator('.execution-tool-name')).toBeHidden()
  await currentTool.click()
  await expect(detailedParentExecution).toContainText('Current segment is running.')
  const childCard = parentExecution.getByTestId('omp-subagent-child-1')
  await expect(childCard).toContainText('scout')
  await childCard.click()
  const inspector = parentExecution.getByTestId('omp-subagent-inspector')
  await expect(inspector).toContainText('gpt-5.6-mini')
  await expect(inspector).toContainText('Inspect nested bridge events')
  await expect(inspector.getByTestId('omp-subagent-todo')).toContainText('Trace nested tool')
  await expect(inspector.getByTestId('omp-subagent-execution')).toContainText('Child-only reasoning stays in the inspector.')
  await expect(inspector.getByTestId('omp-subagent-execution')).toContainText('Tracing nested event routing')
  await expect(inspector.getByTestId('omp-subagent-execution').locator('.execution-active')).toHaveText('Reasoning')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await expect(inspector.getByTestId('omp-subagent-answer')).toContainText('Child answer is arriving.')
  await page.screenshot({ path: '/tmp/feather-work-details-open-mobile.png', fullPage: false })
  await detailsSummary.click()
  await expect(parentExecution).toHaveJSProperty('open', false)

  const completed = await postEvents([
    { type: 'tool_execution_end', toolCallId: 'current-check', toolName: 'bash', result: 'Current segment complete.', isError: false },
    { type: 'tool_execution_end', subagentId: 'child-1', toolCallId: 'child-grep', toolName: 'grep', result: 'Nested route verified.', isError: false },
    { type: 'assistant_snapshot', subagentId: 'child-1', messageId: 'child-answer-2', text: 'Child answer is complete.' },
    { type: 'assistant_end', subagentId: 'child-1', messageId: 'child-answer-2' },
    { type: 'subagent_progress', id: 'child-1', agent: 'scout', status: 'completed', index: 0, resolvedModel: 'gpt-5.6-mini', toolCount: 1, requests: 2, tokens: 840, durationMs: 12400 },
    { type: 'assistant_end', messageId: 'answer-1' },
  ])
  expect(completed.status).toBe(204)
  await expect(chatPanel.getByTestId('thinking-indicator')).toHaveCount(0)
  await expect(parentExecution).toHaveJSProperty('open', false)
  await expect(detailsSummary).toContainText('Activity')
  await detailsSummary.click()
  await expect(parentExecution).toHaveJSProperty('open', true)
  await expect(detailedParentExecution.getByTestId('omp-tool-card')).toHaveCount(2)
  await expect(currentTool).toHaveAttribute('data-status', 'success')
  await expect(detailedParentExecution).toContainText('Success')
  await expect(childCard).toContainText('Success')
  await expect(inspector).toContainText('12s')
  await expect(inspector).toContainText('840 tokens')
  await expect(inspector.getByTestId('omp-subagent-answer')).toContainText('Child answer is complete.')
  const replayed = await postEvents([
    { type: 'tool_execution_start', toolCallId: 'parent-read', toolName: 'read', intent: 'Reading parent bridge state' },
    { type: 'tool_execution_update', toolCallId: 'parent-read', toolName: 'read', partialResult: 'Replay must not regress completion.' },
    { type: 'tool_execution_end', toolCallId: 'parent-read', toolName: 'read', result: 'Replay segment complete.', isError: false },
  ])
  expect(replayed.status).toBe(204)
  await expect(parentExecution).toHaveJSProperty('open', true)
  await expect(detailsSummary).toContainText('Testing current execution segment')
  await expect(detailedParentExecution.getByTestId('omp-tool-card')).toHaveCount(2)

  writeLine({
    type: 'assistant', uuid: `native-stream-final-${Date.now()}`, timestamp: new Date().toISOString(), isSidechain: false, isMeta: false,
    message: { role: 'assistant', content: [{ type: 'text', text: 'The mirrored run is complete.' }] },
  })
  await expect(page.getByText('The mirrored run is complete.')).toBeVisible()
  await expect(page.getByTestId('assistant-stream')).toHaveCount(0)
  expect(await page.evaluate(() => {
    const execution = document.querySelector('[data-testid="omp-parent-execution"]')
    const answer = [...document.querySelectorAll('.asst-bubble')].find(element => element.textContent?.includes('The mirrored run is complete.'))
    return !!execution && !!answer && !!(execution.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING)
  })).toBe(true)

  await page.reload()
  const reloadedDetails = page.getByTestId('chat-panel').getByTestId('omp-parent-execution')
  await expect(reloadedDetails).toHaveJSProperty('open', false)
  await expect(reloadedDetails).toContainText('Reading parent bridge state')
  await reloadedDetails.getByTestId('omp-parent-execution-summary').click()
  await expect(reloadedDetails.getByTestId('omp-todo')).toContainText('Verify child inspector')
  await reloadedDetails.getByTestId('omp-subagent-child-1').click()
  await expect(reloadedDetails.getByTestId('omp-subagent-inspector')).toContainText('Inspect nested bridge events')
  await reloadedDetails.getByTestId('omp-subagent-inspector').getByTestId('omp-tool-card').click()
  await expect(reloadedDetails.getByTestId('omp-subagent-inspector')).toContainText('Nested route verified.')
  await expect(reloadedDetails.getByTestId('omp-subagent-answer')).toContainText('Child answer is complete.')
  await page.setViewportSize({ width: 1280, height: 800 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: '/tmp/feather-work-details-desktop.png', fullPage: false })
  const directStarted = await postEvents([{ type: 'agent_start' }])
  expect(directStarted.status).toBe(204)
  const thinkingIndicator = chatPanel.getByTestId('thinking-indicator')
  await expect(thinkingIndicator).toContainText('Thinking…')
  await expect(chatPanel.getByTestId('omp-parent-execution')).toHaveCount(0)
  await page.screenshot({ path: '/tmp/feather-thinking-direct.png', fullPage: false })

  const reasoningOnly = await postEvents([
    { type: 'work_snapshot', messageId: 'markdown-stream', blocks: [{ type: 'thinking', thinking: 'Planning the direct answer.' }] },
  ])
  expect(reasoningOnly.status).toBe(204)
  await expect(thinkingIndicator).toContainText('Thinking…')
  await expect(chatPanel.getByTestId('omp-parent-execution')).toHaveCount(0)

  const markdownStarted = await postEvents([
    { type: 'assistant_snapshot', messageId: 'markdown-stream', text: '# Live answer\n\nThe **Markdown** is arriving.' },
  ])
  expect(markdownStarted.status).toBe(204)
  const markdownStream = page.getByTestId('assistant-stream')
  await expect(markdownStream.getByRole('heading', { name: 'Live answer' })).toBeVisible()
  await expect(markdownStream.locator('strong')).toHaveText('Markdown')
  await expect(markdownStream).not.toContainText('**Markdown**')

  const markdownUpdated = await postEvents([
    { type: 'assistant_snapshot', messageId: 'markdown-stream', text: '# Live answer\n\nThe **Markdown** is arriving.\n\n- First item\n- Second item\n\n`inline code`' },
  ])
  expect(markdownUpdated.status).toBe(204)
  await expect(markdownStream.locator('li')).toHaveCount(2)
  await expect(markdownStream.locator('code')).toHaveText('inline code')
  await page.screenshot({ path: '/tmp/feather-streaming-markdown.png', fullPage: false })

  writeLine({
    type: 'assistant', uuid: `native-direct-final-${Date.now()}`, timestamp: new Date().toISOString(), isSidechain: false, isMeta: false,
    message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'Planning the direct answer.' },
      { type: 'text', text: '# Live answer\n\nThe **Markdown** arrived.\n\n- First item\n- Second item\n\n`inline code`' },
    ] },
  })
  const directCompleted = await postEvents([{ type: 'assistant_end', messageId: 'markdown-stream' }])
  expect(directCompleted.status).toBe(204)
  await expect(page.getByText('The Markdown arrived.')).toBeVisible()
  await expect(thinkingIndicator).toHaveCount(0)
  await expect(chatPanel.getByTestId('omp-parent-execution')).toHaveCount(0)
  const directBubble = page.locator('.asst-bubble').filter({ hasText: 'The Markdown arrived.' })
  await expect(directBubble.getByTestId('work-log-summary')).toHaveCount(0)

  const jobsStarted = await postEvents([{
    type: 'async_jobs',
    running: [
      { id: 'job-1', type: 'task', label: 'First background check', status: 'running', startTime: Date.now() },
      { id: 'job-2', type: 'task', label: 'Second background check', status: 'running', startTime: Date.now() },
    ],
    recent: [],
  }])
  expect(jobsStarted.status).toBe(204)
  const backgroundActivity = chatPanel.getByTestId('omp-parent-execution')
  await expect(backgroundActivity.getByTestId('omp-parent-execution-summary')).toContainText('First background check')
  await expect(backgroundActivity.locator('.execution-status')).toHaveAttribute('aria-label', 'Running')
  await backgroundActivity.getByTestId('omp-parent-execution-summary').click()
  await expect(backgroundActivity.getByTestId('omp-jobs')).toContainText('2 running')

  const jobsCompleted = await postEvents([{ type: 'async_jobs', running: [], recent: [] }])
  expect(jobsCompleted.status).toBe(204)
  await expect(backgroundActivity).toHaveCount(0)
})
