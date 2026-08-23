// OMP (oh-my-pi) launch configuration — pure helpers, imported by the server.
// Empty FEATHER_OMP_MODEL opts out and lets OMP choose its own model.

const OMP_THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'])
const DEFAULT_OMP_MODEL = 'openai-codex/gpt-5.6-sol'
const DEFAULT_OMP_THINKING = 'xhigh'

export function resolveOmpModel(env = {}) {
  const raw = (env.FEATHER_OMP_MODEL ?? DEFAULT_OMP_MODEL).trim()
  if (raw === '') return ''
  return /^[a-zA-Z0-9._/:-]+$/.test(raw) ? raw : DEFAULT_OMP_MODEL
}

export function resolveOmpThinking(env = {}) {
  const raw = (env.FEATHER_OMP_THINKING ?? DEFAULT_OMP_THINKING).trim()
  return OMP_THINKING_LEVELS.has(raw) ? raw : DEFAULT_OMP_THINKING
}

export function ompModelFlags(model, thinking) {
  return `${model ? `--model ${model} ` : ''}${thinking ? `--thinking ${thinking} ` : ''}`
}
