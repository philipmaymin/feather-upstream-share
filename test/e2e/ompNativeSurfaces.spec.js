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
    { type: 'subagent_lifecycle', id: 'child-1', agent: 'scout', agentSource: 'task', status: 'started', index: 0, assignment: 'Inspect nested bridge events', task: 'Map child events', resolvedModel: 'gpt-5.6-mini', parentToolCallId: 'spawn-child' },
    { type: 'todo', subagentId: 'child-1', phases: [{ name: 'Child', tasks: [{ content: 'Trace nested tool', status: 'in_progress' }] }] },
    { type: 'work_snapshot', subagentId: 'child-1', messageId: 'child-answer-1', blocks: [{ type: 'thinking', thinking: 'Child-only reasoning stays in the inspector.' }] },
    { type: 'tool_execution_start', subagentId: 'child-1', toolCallId: 'child-grep', toolName: 'grep', args: { pattern: 'subagentId' }, intent: 'Tracing nested event routing' },
    { type: 'assistant_snapshot', subagentId: 'child-1', messageId: 'child-answer-1', text: 'Child answer is arriving.' },
    { type: 'tool_execution_update', subagentId: 'child-1', toolCallId: 'child-grep', toolName: 'grep', partialResult: 'Nested match found.' },
  ])

  writeLine({
    type: 'assistant', uuid: `native-live-trace-${Date.now()}`, timestamp: new Date().toISOString(), isSidechain: false, isMeta: false,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'durable-parent-read', name: 'Read', input: { path: '/tmp/durable-parent' } }] },
  })
  await page.waitForTimeout(300)
  await expect(page.getByTestId('live-work-turn')).toHaveCount(0)
  expect(started.status).toBe(204)

  const todo = page.getByTestId('omp-todo')
  await expect(todo).toContainText('Todo · 1/2')
  await expect(todo).toContainText('Verify child inspector')
  expect(await todo.evaluate(element => getComputedStyle(element).position)).toBe('sticky')
  expect(await todo.evaluate(element => element.getBoundingClientRect().height <= window.innerHeight * 0.31)).toBe(true)

  const parentExecution = page.getByTestId('omp-parent-execution')
  await expect(parentExecution).toBeVisible()
  await expect(page.getByTestId('omp-parent-execution-summary')).toContainText('Reading parent bridge state')
  await expect(parentExecution.getByText('Child-only reasoning stays in the inspector.')).toHaveCount(0)
  await page.getByTestId('omp-parent-execution-summary').click()
  await expect(parentExecution.getByTestId('omp-tool-card')).toHaveCount(1)
  await expect(parentExecution).toContainText('Reading parent bridge state')
  await parentExecution.getByTestId('omp-tool-card').click()
  await expect(parentExecution).toContainText('Parent state is arriving.')

  const childCard = page.getByTestId('omp-subagent-child-1')
  await expect(childCard).toContainText('scout')
  await childCard.click()
  const inspector = page.getByTestId('omp-subagent-inspector')
  await expect(inspector).toContainText('gpt-5.6-mini')
  await expect(inspector).toContainText('Inspect nested bridge events')
  await expect(inspector.getByTestId('omp-subagent-todo')).toContainText('Trace nested tool')
  await expect(inspector.getByTestId('omp-subagent-execution')).toContainText('Child-only reasoning stays in the inspector.')
  await expect(inspector.getByTestId('omp-subagent-execution')).toContainText('Tracing nested event routing')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await expect(inspector.getByTestId('omp-subagent-answer')).toContainText('Child answer is arriving.')
  await page.screenshot({ path: '/tmp/feather-omp-mirror-mobile.png', fullPage: false })

  const completed = await postEvents([
    { type: 'tool_execution_end', toolCallId: 'parent-read', toolName: 'read', result: 'Parent state complete.', isError: false },
    { type: 'tool_execution_end', subagentId: 'child-1', toolCallId: 'child-grep', toolName: 'grep', result: 'Nested route verified.', isError: false },
    { type: 'assistant_snapshot', subagentId: 'child-1', messageId: 'child-answer-1', text: 'Child answer is complete.' },
    { type: 'assistant_end', subagentId: 'child-1', messageId: 'child-answer-1' },
    { type: 'subagent_progress', id: 'child-1', agent: 'scout', status: 'completed', index: 0, resolvedModel: 'gpt-5.6-mini', toolCount: 1, requests: 2, tokens: 840, durationMs: 12400 },
    { type: 'assistant_end', messageId: 'answer-1' },
    { type: 'tool_execution_start', toolCallId: 'parent-read', toolName: 'read', intent: 'Reading parent bridge state' },
    { type: 'tool_execution_update', toolCallId: 'parent-read', toolName: 'read', partialResult: 'Replay must not regress completion.' },
  ])
  expect(completed.status).toBe(204)

  await expect(parentExecution).toHaveJSProperty('open', true)
  await expect(parentExecution.getByTestId('omp-tool-card')).toHaveCount(1)
  await expect(parentExecution.getByTestId('omp-tool-card')).toHaveAttribute('data-status', 'success')
  await expect(parentExecution).toContainText('Success')
  await expect(childCard).toContainText('Success')
  await expect(inspector).toContainText('12s')
  await expect(inspector).toContainText('840 tokens')
  await expect(inspector.getByTestId('omp-subagent-answer')).toContainText('Child answer is complete.')

  writeLine({
    type: 'assistant', uuid: `native-stream-final-${Date.now()}`, timestamp: new Date().toISOString(), isSidechain: false, isMeta: false,
    message: { role: 'assistant', content: [{ type: 'text', text: 'The mirrored run is complete.' }] },
  })
  await expect(page.getByText('The mirrored run is complete.')).toBeVisible()
  await expect(page.getByTestId('assistant-stream')).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('omp-todo')).toContainText('Verify child inspector')
  await expect(page.getByTestId('omp-parent-execution')).toContainText('Reading parent bridge state')
  await page.getByTestId('omp-subagent-child-1').click()
  await expect(page.getByTestId('omp-subagent-inspector')).toContainText('Inspect nested bridge events')
  await page.getByTestId('omp-subagent-inspector').getByTestId('omp-tool-card').click()
  await expect(page.getByTestId('omp-subagent-inspector')).toContainText('Nested route verified.')

  await expect(page.getByTestId('omp-subagent-answer')).toContainText('Child answer is complete.')
  await page.setViewportSize({ width: 1280, height: 800 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: '/tmp/feather-omp-mirror-desktop.png', fullPage: false })
})
