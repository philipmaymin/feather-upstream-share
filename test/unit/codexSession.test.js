import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { codexSessionIsWorkerFromHead } from '../../lib/codex-session.js'

const session = payload => JSON.stringify({ type: 'session_meta', payload })

describe('Codex session ownership', () => {
  it('keeps a human-owned Codex thread visible', () => {
    assert.equal(codexSessionIsWorkerFromHead(session({
      id: 'main', cwd: '/home/user/rooms/compelle-miner', source: 'cli', thread_source: 'user',
    })), false)
  })

  it('recognizes native Codex subagent rollouts', () => {
    assert.equal(codexSessionIsWorkerFromHead(session({
      id: 'worker', cwd: '/home/user/rooms/compelle-miner',
      source: { subagent: { thread_spawn: { parent_thread_id: 'main', depth: 1 } } },
      thread_source: 'subagent', parent_thread_id: 'main',
    })), true)
  })

  it('recognizes worker metadata in a truncated bounded head', () => {
    assert.equal(codexSessionIsWorkerFromHead(
      '{"type":"session_meta","payload":{"source":{"subagent":{"thread_spawn":{}}},"base_instructions":{"text":"truncated',
    ), true)
  })

  it('retains the legacy explicit worker marker', () => {
    assert.equal(codexSessionIsWorkerFromHead('AUTO_WORKER=TRUE'), true)
  })
})
