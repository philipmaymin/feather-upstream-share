import test from 'node:test'
import assert from 'node:assert/strict'
import {
  inferLegacyTmuxOwner, legacyTmuxSessionName, tmuxKeyMatchesSession, tmuxSessionName,
} from '../../lib/tmux-session.js'

test('tmux names retain the complete chat id', () => {
  const first = '01a02fc0-de56-7193-b787-34d7f3a89066'
  const sibling = '01a02fc0-bf3c-7d11-b76c-fcd7ffe6e358'
  assert.notEqual(tmuxSessionName(first), tmuxSessionName(sibling))
  assert.equal(tmuxSessionName(first), `f-${first}`)
  assert.equal(legacyTmuxSessionName(first), 'f-01a02fc0')
})

test('legacy migration uses the exact id embedded in a resume command', () => {
  const first = '01a02fc0-de56-7193-b787-34d7f3a89066'
  const sibling = '01a02fc0-bf3c-7d11-b76c-fcd7ffe6e358'
  const command = `codex resume ${sibling} --cd /home/user/rooms/films`
  assert.equal(inferLegacyTmuxOwner('f-01a02fc0', command, [first, sibling]), sibling)
})

test('legacy migration fails closed when a shared prefix has no owner evidence', () => {
  const ids = ['01a02fc0-de56-7193-b787-34d7f3a89066', '01a02fc0-bf3c-7d11-b76c-fcd7ffe6e358']
  assert.equal(inferLegacyTmuxOwner('f-01a02fc0', 'codex', ids), null)
  assert.equal(tmuxKeyMatchesSession(ids[0], ids[0]), true)
  assert.equal(tmuxKeyMatchesSession('01a02fc0', ids[0]), true)
  assert.equal(tmuxKeyMatchesSession(ids[1], ids[0]), false)
})
