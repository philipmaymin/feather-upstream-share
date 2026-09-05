import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveOmpModel, resolveOmpThinking, ompLaunchCommand, ompModelFlags, ompNeedsDeviceAuth, ompTmuxArgs, sanitizeOmpModel } from '../../lib/omp.js'

describe('omp launch config', () => {
  it('defaults the model to gpt-6-astra and honors a valid override', () => {
    assert.equal(resolveOmpModel({}), 'openai-codex/gpt-6-astra')
    assert.equal(resolveOmpModel({ FEATHER_OMP_MODEL: 'anthropic/claude-opus-4-8' }), 'anthropic/claude-opus-4-8')
    assert.equal(resolveOmpModel({ FEATHER_OMP_MODEL: 'gpt-5.6-sol' }), 'gpt-5.6-sol')
  })

  it('treats empty model as opt-out and rejects shell-unsafe values', () => {
    assert.equal(resolveOmpModel({ FEATHER_OMP_MODEL: '' }), '')
    assert.equal(resolveOmpModel({ FEATHER_OMP_MODEL: '   ' }), '')
    // Anything with quotes/spaces/semicolons can't be a model id → fall back.
    assert.equal(resolveOmpModel({ FEATHER_OMP_MODEL: "sol'; rm -rf /" }), 'openai-codex/gpt-6-astra')
    assert.equal(resolveOmpModel({ FEATHER_OMP_MODEL: 'has space' }), 'openai-codex/gpt-6-astra')
  })

  it('defaults thinking to high and accepts only known levels', () => {
    assert.equal(resolveOmpThinking({}), 'high')
    assert.equal(resolveOmpThinking({ FEATHER_OMP_THINKING: 'medium' }), 'medium')
    assert.equal(resolveOmpThinking({ FEATHER_OMP_THINKING: 'bogus' }), 'high')
    assert.equal(resolveOmpThinking({ FEATHER_OMP_THINKING: '' }), 'high')
  })

  it('sanitizes per-session model overrides: valid id or empty, never a fallback', () => {
    assert.equal(sanitizeOmpModel('anthropic/claude-opus-5'), 'anthropic/claude-opus-5')
    assert.equal(sanitizeOmpModel(' opus '), 'opus')
    assert.equal(sanitizeOmpModel(''), '')
    assert.equal(sanitizeOmpModel(undefined), '')
    assert.equal(sanitizeOmpModel("sol'; rm -rf /"), '')
    assert.equal(sanitizeOmpModel('has space'), '')
  })

  it('builds the flag prefix, omitting empty parts', () => {
    assert.equal(ompModelFlags('openai-codex/gpt-5.6-sol', 'xhigh'), '--model openai-codex/gpt-5.6-sol --thinking xhigh ')
    assert.equal(ompModelFlags('', 'high'), '--thinking high ')
    assert.equal(ompModelFlags('gpt-5.6-sol', ''), '--model gpt-5.6-sol ')
    assert.equal(ompModelFlags('', ''), '')
  })

  it('uses headless device auth before an interactive remote Codex session', () => {
    assert.equal(ompNeedsDeviceAuth('openai-codex/gpt-5.6-sol'), true)
    assert.equal(ompNeedsDeviceAuth('anthropic/claude-opus-4-8'), false)
    const command = ompLaunchCommand('--session-dir /tmp/omp-session', 'openai-codex/gpt-5.6-sol', 'xhigh')
    assert.match(command, /omp token openai-codex --list/)
    assert.match(command, /omp auth-broker login openai-codex-device/)
    assert.match(command, /omp config set startup\.setupWizard false/)
    assert.match(command, /exec omp --model openai-codex\/gpt-5\.6-sol --thinking xhigh --session-dir/)
  })

  it('does not block noninteractive pulses or non-Codex providers on login', () => {
    const pulse = ompLaunchCommand('-p @pulse.md', 'openai-codex/gpt-5.6-sol', 'xhigh', { interactive: false })
    assert.equal(pulse, 'omp --model openai-codex/gpt-5.6-sol --thinking xhigh -p @pulse.md --allow-home')
    const claude = ompLaunchCommand('--session-dir /tmp/omp-session', 'anthropic/claude-opus-4-8', 'high')
    assert.equal(claude, 'omp --model anthropic/claude-opus-4-8 --thinking high --session-dir /tmp/omp-session --allow-home')
  })

  it('keeps quoted device-auth output inside one direct tmux command argument', () => {
    const command = ompLaunchCommand('--session-dir /tmp/omp-session', 'openai-codex/gpt-5.6-sol', 'xhigh')
    const args = ompTmuxArgs('f-test-session', '/home/user', command)
    assert.equal(args[0], 'new-session')
    assert.equal(args[5], '/home/user')
    assert.match(args[6], /printf "\\nOMP phone sign-in/)
    assert.deepEqual(args.slice(7), [';', 'set-option', '-t', 'f-test-session', 'prefix', 'M-a'])
  })
})
