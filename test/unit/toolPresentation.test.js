import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { activityDescription, toolImagePath, toolPresentation } from '../../frontend/src/lib/toolPresentation.js'

describe('Codex tool presentation', () => {
  it('identifies web weather calls even when Codex stores the tool as run', () => {
    assert.deepEqual(
      toolPresentation('run', {
        weather: [{ location: '32250' }],
        response_length: 'short',
      }),
      { name: 'Web', summary: 'Weather · 32250' },
    )
  })

  it('shows useful arguments for unfamiliar tools', () => {
    assert.deepEqual(
      toolPresentation('mystery_tool', { resource_id: 'abc-123' }),
      { name: 'Mystery Tool', summary: 'Resource id · abc-123' },
    )
  })

  it('keeps existing shell command labels and summaries', () => {
    assert.deepEqual(
      toolPresentation('exec_command', { cmd: 'npm test' }),
      { name: 'Bash', summary: 'npm test' },
    )
  })

  it('unwraps Codex exec orchestration to show the nested command', () => {
    assert.deepEqual(
      toolPresentation('exec', {
        raw: 'const r = await tools.exec_command({"cmd":"git status --short","workdir":"/home/user/feather"});\ntext(r.output);',
      }),
      { name: 'Bash', summary: 'git status --short' },
    )
  })

  it('keeps local image basenames visible while preserving the preview path', () => {
    const imagePath = '/home/user/feather/a-deliberately-long/path/that/exceeds/the/generic/summary/limit/by/a/wide/margin/tool-preview.svg'

    assert.deepEqual(
      toolPresentation('view_image', { path: imagePath, detail: 'original' }),
      { name: 'View Image', summary: 'tool-preview.svg' },
    )
    assert.deepEqual(
      toolPresentation('viewImage', { path: String.raw`C:\Users\feather\deeply\nested\tool-preview.svg` }),
      { name: 'View Image', summary: 'tool-preview.svg' },
    )
    assert.equal(toolImagePath('view_image', { path: imagePath, detail: 'original' }), imagePath)
    assert.equal(toolImagePath('read', { path: '/tmp/example.png' }), '')
  })

  it('is total over bounded but malformed bridge arguments', () => {
    assert.doesNotThrow(() => toolPresentation('read', { path: {} }))
    assert.deepEqual(toolPresentation('read', { path: {} }), { name: 'Read', summary: '' })
    assert.deepEqual(toolPresentation('__proto__', {}), { name: 'Proto', summary: '' })
    assert.deepEqual(toolPresentation('exec_command', { cmd: {} }), { name: 'Bash', summary: '' })
  })

  it('turns plumbing tools into intent-first Activity descriptions', () => {
    assert.equal(activityDescription('eval', { title: 'Evaluating Activity state' }), 'Evaluating Activity state')
    assert.equal(activityDescription('bash', { command: 'npm test' }), 'Running npm test')
    assert.equal(activityDescription('grep', { pattern: 'TODO', path: 'src' }), 'Searching TODO in src')
    assert.equal(activityDescription('write', { path: 'src/state.js' }), 'Writing src/state.js')
  })

  it('prefers the declared intent over every tool-derived fallback', () => {
    assert.equal(
      activityDescription('bash', { command: 'git status' }, 'Checking repository state'),
      'Checking repository state',
    )
  })
})
