import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const LOOP = path.join(ROOT, 'bin/feather-ux-loop')
const CRITIQUE = path.join(ROOT, 'automation/feather-ux/critique.py')

function gate(status, ageHours) {
  return JSON.parse(execFileSync('python3', [LOOP, 'gate', '--status', status, '--age-hours', String(ageHours)], {
    cwd: ROOT,
    encoding: 'utf8',
  }))
}

test('UX loop never supersedes a pending fleet rollout', () => {
  assert.deepEqual(gate('pending', 48), {
    allowed: false,
    reason: 'prior fleet schedule is pending, not settled',
  })
})

test('UX loop requires both a settled fleet and a 24-hour Philip canary', () => {
  assert.equal(gate('succeeded', 23.99).allowed, false)
  assert.equal(gate('succeeded', 24).allowed, true)
  assert.equal(gate('failed', 30).allowed, true)
})

test('candidate publication tracks the branch it pushes before release staging', () => {
  const command = `
import json
import runpy
from pathlib import Path

module = runpy.run_path(${JSON.stringify(LOOP)})
calls = []
module["publish_candidate"].__globals__["run"] = lambda args, **kwargs: calls.append(args)
module["publish_candidate"](Path("/tmp/feather-ux-run"))
print(json.dumps(calls))
`
  const calls = JSON.parse(execFileSync('python3', ['-c', command], { cwd: ROOT, encoding: 'utf8' }))
  assert.deepEqual(calls, [['git', 'push', '-u', 'fork', 'auto/feather-ux']])
})

test('Gemini critic rejects recordings that are not explicitly synthetic', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-ux-privacy-'))
  try {
    fs.writeFileSync(path.join(directory, 'recording.json'), JSON.stringify({ synthetic: false, focus: 'outcome-inbox' }))
    fs.writeFileSync(path.join(directory, 'journey.webm'), 'not-a-video')
    const result = spawnSync('python3', [CRITIQUE, directory], { cwd: ROOT, encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /refusing to upload a recording not marked synthetic/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
