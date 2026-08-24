import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { toolImagePath, toolPresentation } from '../../frontend/src/lib/toolPresentation.js'

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

  it('exposes local view_image inputs for Feather previews', () => {
    assert.equal(
      toolImagePath('view_image', { path: '/home/user/feather/uploads/example.png', detail: 'original' }),
      '/home/user/feather/uploads/example.png',
    )
    assert.equal(toolImagePath('read', { path: '/tmp/example.png' }), '')
  })

  it('is total over bounded but malformed bridge arguments', () => {
    assert.doesNotThrow(() => toolPresentation('read', { path: {} }))
    assert.deepEqual(toolPresentation('read', { path: {} }), { name: 'Read', summary: '' })
    assert.deepEqual(toolPresentation('__proto__', {}), { name: 'Proto', summary: '' })
    assert.deepEqual(toolPresentation('exec_command', { cmd: {} }), { name: 'Bash', summary: '' })
  })
})
