import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveOmpModel, resolveOmpThinking, ompModelFlags } from '../../lib/omp.js'

describe('omp launch config', () => {
  it('defaults the model to gpt-5.6-sol and honors a valid override', () => {
    assert.equal(resolveOmpModel({}), 'openai-codex/gpt-5.6-sol')
    assert.equal(resolveOmpModel({ FEATHER_OMP_MODEL: 'anthropic/claude-opus-4-8' }), 'anthropic/claude-opus-4-8')
    assert.equal(resolveOmpModel({ FEATHER_OMP_MODEL: 'gpt-5.6-sol' }), 'gpt-5.6-sol')
  })

  it('treats empty model as opt-out and rejects shell-unsafe values', () => {
    assert.equal(resolveOmpModel({ FEATHER_OMP_MODEL: '' }), '')
    assert.equal(resolveOmpModel({ FEATHER_OMP_MODEL: '   ' }), '')
    assert.equal(resolveOmpModel({ FEATHER_OMP_MODEL: "sol'; rm -rf /" }), 'openai-codex/gpt-5.6-sol')
    assert.equal(resolveOmpModel({ FEATHER_OMP_MODEL: 'has space' }), 'openai-codex/gpt-5.6-sol')
  })

  it('defaults thinking to xhigh and accepts only known levels', () => {
    assert.equal(resolveOmpThinking({}), 'xhigh')
    assert.equal(resolveOmpThinking({ FEATHER_OMP_THINKING: 'medium' }), 'medium')
    assert.equal(resolveOmpThinking({ FEATHER_OMP_THINKING: 'bogus' }), 'xhigh')
    assert.equal(resolveOmpThinking({ FEATHER_OMP_THINKING: '' }), 'xhigh')
  })

  it('builds the flag prefix, omitting empty parts', () => {
    assert.equal(ompModelFlags('openai-codex/gpt-5.6-sol', 'xhigh'), '--model openai-codex/gpt-5.6-sol --thinking xhigh ')
    assert.equal(ompModelFlags('', 'high'), '--thinking high ')
    assert.equal(ompModelFlags('gpt-5.6-sol', ''), '--model gpt-5.6-sol ')
    assert.equal(ompModelFlags('', ''), '')
  })
})
