// @ts-check
import { test, expect } from '@playwright/test'
import { createHash, randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'

const BASE = process.env.FEATHER_URL || 'http://localhost:4870'
const HOME = process.env.HOME || '/home/user'
const SESSION_ID = `e2e-council-${Date.now()}`
const OWNER_ID = '40000000-0000-4000-8000-000000000001'
const BRIDGE_TOKEN = 'e2e-council-token'
let sessionPath
let tokenPath
let protocolPath
let serial = 1

test.use({ viewport: { width: 390, height: 844 } })

function writeLine(entry) {
  fs.appendFileSync(sessionPath, `${JSON.stringify(entry)}\n`)
}

async function postJson(url, body, token = false) {
  return fetch(`${BASE}${url}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Feather-Bridge-Token': BRIDGE_TOKEN } : {}),
    },
    body: JSON.stringify(body),
  })
}

function eventId() {
  return `50000000-0000-4000-8000-${String(serial++).padStart(12, '0')}`
}

async function appendEvent(runId, type, fields = {}, payload = {}) {
  const response = await postJson(`/api/internal/sessions/${SESSION_ID}/protocol-runs/${runId}/events`, {
    ownerExecutionId: OWNER_ID,
    event: { schemaVersion: 1, eventId: eventId(), runId, type, ...fields, payload },
  }, true)
  expect(response.status).toBe(200)
  return (await response.json()).run
}

async function postOmpEvents(events) {
  const response = await postJson(`/api/internal/sessions/${SESSION_ID}/events`, { version: 4, events }, true)
  expect(response.status).toBe(204)
}

test.beforeAll(() => {
  const projectsRoot = path.join(HOME, '.claude', 'projects')
  const project = fs.readdirSync(projectsRoot).find(name => fs.statSync(path.join(projectsRoot, name)).isDirectory())
  if (!project) throw new Error('No Claude project directory available')
  sessionPath = path.join(projectsRoot, project, `${SESSION_ID}.jsonl`)
  writeLine({
    type: 'user', uuid: OWNER_ID, timestamp: '2026-08-24T20:00:00Z', isSidechain: false, isMeta: false,
    message: { role: 'user', content: 'Should Feather make OMP the default harness?' },
  })
  const tokenDir = path.join(HOME, '.feather', 'omp-sessions', '.feather-bridge-tokens')
  fs.mkdirSync(tokenDir, { recursive: true })
  tokenPath = path.join(tokenDir, createHash('sha256').update(SESSION_ID).digest('hex'))
  fs.writeFileSync(tokenPath, BRIDGE_TOKEN, { mode: 0o600 })
  protocolPath = path.join(HOME, '.feather', 'protocol-runs', SESSION_ID)
})
test.afterAll(async () => {
  try { await fetch(`${BASE}/api/sessions/${SESSION_ID}`, { method: 'DELETE' }) } catch {}
  try { fs.unlinkSync(sessionPath) } catch {}
  try { fs.unlinkSync(tokenPath) } catch {}
  try { fs.rmSync(protocolPath, { recursive: true, force: true }) } catch {}
})

test('runs Advisory inline through candidates, Judge, verdict, and replay', async ({ page }) => {
  await page.goto(`${BASE}/#${SESSION_ID}`)
  await expect(page.locator('.markdown').getByText('Should Feather make OMP the default harness?', { exact: true }).first()).toBeVisible()

  await expect(page.getByRole('button', { name: 'Council', exact: true })).toHaveCount(0)

  const claimResponse = await postJson(`/api/internal/sessions/${SESSION_ID}/protocol-runs/claim`, {
    ownerExecutionId: OWNER_ID,
    invocationMessageId: OWNER_ID,
    mode: 'create',
    input: {
      question: 'Should Feather make OMP the default harness?',
      candidateCount: 2,
      roleMode: 'diverse',
      timeoutMs: 600000,
    },
  }, true)
  expect(claimResponse.status).toBe(200)
  const envelope = (await claimResponse.json()).envelope
  const runId = envelope.runId
  const roles = envelope.input.roles

  await appendEvent(runId, 'run_started', {}, {
    protocol: 'advisory', invocationMessageId: OWNER_ID, actionId: envelope.actionId,
    question: envelope.input.question, candidateCount: 2, roles, roleMode: 'diverse', timeoutMs: 600000,
  })
  await appendEvent(runId, 'stage_started', { stageId: 'candidates', attempt: 1 }, {})
  await postOmpEvents([
    { type: 'subagent_lifecycle', id: 'council-child-1', agent: 'task', status: 'started', index: 0, assignment: 'Advocate candidate' },
    { type: 'subagent_lifecycle', id: 'council-child-2', agent: 'task', status: 'started', index: 1, assignment: 'Skeptic candidate' },
  ])

  for (const [index, childId, answer] of [
    [1, 'council-child-1', 'Make OMP the default because Feather now mirrors its full execution model.'],
    [2, 'council-child-2', 'Keep an escape hatch until native protocol runs prove reliable.'],
  ]) {
    const seatId = `candidate-${index}`
    const role = roles[index - 1].role
    await appendEvent(runId, 'seat_started', { stageId: 'candidates', seatId, attempt: 1 }, { role, ompChildId: childId })
    await appendEvent(runId, 'evidence_added', { stageId: 'candidates', seatId, attempt: 1 }, { evidenceId: `evidence-${seatId}`, kind: 'candidate_answer', content: answer })
    await appendEvent(runId, 'seat_terminal', { stageId: 'candidates', seatId, attempt: 1 }, { status: 'succeeded' })
  }
  await appendEvent(runId, 'stage_terminal', { stageId: 'candidates', attempt: 1 }, { status: 'succeeded' })
  await appendEvent(runId, 'stage_started', { stageId: 'judge', attempt: 1 }, {})
  await postOmpEvents([{ type: 'subagent_lifecycle', id: 'council-judge', agent: 'task', status: 'started', index: 2, assignment: 'Fresh Advisory judge' }])
  await appendEvent(runId, 'seat_started', { stageId: 'judge', seatId: 'judge-1', attempt: 1 }, { role: 'Judge', ompChildId: 'council-judge' })

  const inlineCard = page.getByTestId(`chat-protocol-run-${runId}`)
  await expect(inlineCard).toContainText('Judge synthesizing')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(await page.evaluate((runId) => {
    const invocation = [...document.querySelectorAll('.msg-row')].find(row => row.textContent?.includes('Should Feather make OMP the default harness?'))
    const card = document.querySelector(`[data-testid="chat-protocol-run-${runId}"]`)
    return !!invocation && !!card && !!(invocation.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING)
  }, runId)).toBe(true)

  const verdict = {
    ranking: [
      { seatId: 'candidate-1', rationale: 'Strongest product and execution argument.' },
      { seatId: 'candidate-2', rationale: 'Correctly preserves a fallback risk.' },
    ],
    recommendation: 'Make OMP the default harness while preserving Terminal and alternative-session escape hatches.',
    disagreements: [{ summary: 'How long the fallback should remain.', evidenceIds: ['evidence-candidate-2'] }],
    confidence: 'high',
    citedEvidenceIds: ['evidence-candidate-1', 'evidence-candidate-2'],
  }
  await appendEvent(runId, 'evidence_added', { stageId: 'judge', seatId: 'judge-1', attempt: 1 }, { evidenceId: 'evidence-judge-1', kind: 'judge_verdict', content: verdict })
  await appendEvent(runId, 'seat_terminal', { stageId: 'judge', seatId: 'judge-1', attempt: 1 }, { status: 'succeeded' })
  await appendEvent(runId, 'stage_terminal', { stageId: 'judge', attempt: 1 }, { status: 'succeeded' })
  await appendEvent(runId, 'verdict_recorded', {}, { evidenceId: 'evidence-judge-1' })
  await appendEvent(runId, 'run_terminal', {}, { status: 'succeeded' })

  await expect(inlineCard).toContainText('Complete')
  await expect(inlineCard).toContainText('Make OMP the default harness')

  await page.getByRole('button', { name: /Agents 3/ }).click()
  await page.getByTestId('omp-subagent-council-child-1').click()
  await expect(page.getByTestId('omp-subagent-inspector')).toContainText('Advocate candidate')

  await page.reload()
  await expect(page.getByRole('button', { name: 'Council', exact: true })).toHaveCount(0)
  const replayedCard = page.getByTestId(`chat-protocol-run-${runId}`)
  await expect(replayedCard).toContainText('Complete')
  await expect(replayedCard).toContainText('Make OMP the default harness')
  await page.screenshot({ path: '/tmp/feather-council-inline-mobile.png', fullPage: false })
})
