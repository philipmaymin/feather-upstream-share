// OMP (oh-my-pi) launch configuration — pure helpers, imported by server-single.js.
// Empty FEATHER_OMP_MODEL opts out and lets OMP choose its own model.

const OMP_THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'])
const DEFAULT_OMP_MODEL = 'openai-codex/gpt-6-astra'
const DEFAULT_OMP_THINKING = 'xhigh'
export function resolveOmpModel(env = {}) {
  const raw = (env.FEATHER_OMP_MODEL ?? DEFAULT_OMP_MODEL).trim()
  if (raw === '') return ''
  return /^[a-zA-Z0-9._/:-]+$/.test(raw) ? raw : DEFAULT_OMP_MODEL
}

// Resolve the reasoning level. Must be one omp accepts; anything else (typo,
// injection attempt) falls back to the default.
export function resolveOmpThinking(env = {}) {
  const raw = (env.FEATHER_OMP_THINKING ?? DEFAULT_OMP_THINKING).trim()
  return OMP_THINKING_LEVELS.has(raw) ? raw : DEFAULT_OMP_THINKING
}

// Validate a per-session model override (request input or persisted meta).
// Returns the model id when it is shell-safe, '' otherwise (no override).
export function sanitizeOmpModel(raw) {
  if (typeof raw !== 'string') return ''
  const model = raw.trim()
  return /^[a-zA-Z0-9._/:-]+$/.test(model) ? model : ''
}

export function ompModelFlags(model, thinking) {
  return `${model ? `--model ${model} ` : ''}${thinking ? `--thinking ${thinking} ` : ''}`
}

export function ompNeedsDeviceAuth(model) {
  return /^openai-codex(?:\/|$)/.test(model)
}

// Feather normally runs OMP on a remote host while the browser is on a phone.
// OpenAI's ordinary Codex OAuth flow redirects to localhost:1455, which points
// at the phone and also permits only one pending login on the server. OMP's
// device provider is designed for this topology and stores the resulting
// credential under the same shared openai-codex provider id. Once Feather has
// authenticated and supplied the model, OMP's separate five-step setup wizard
// is redundant and strands phone users on a terminal-only provider picker.
export function ompLaunchCommand(ompArgs, model, thinking, { interactive = true } = {}) {
  const agentCommand = `omp ${ompModelFlags(model, thinking)}${ompArgs} --allow-home`
  if (!interactive || !ompNeedsDeviceAuth(model)) return agentCommand
  return `if ! omp token openai-codex --list >/dev/null 2>&1; then omp auth-broker login openai-codex-device || { printf "\\nOMP phone sign-in did not finish. Resume this chat to try again.\\n"; exec bash; }; fi; omp config set startup.setupWizard false >/dev/null 2>&1 || { printf "\\nFeather could not disable OMP's redundant setup wizard. Resume this chat to try again.\\n"; exec bash; }; exec ${agentCommand}`
}

export function ompTmuxArgs(name, dir, command) {
  const quotedCommand = `'${String(command).replaceAll("'", "'\\''")}'`
  return [
    'new-session', '-d', '-s', name, '-c', dir,
    `bash --rcfile ~/.bashrc -ic ${quotedCommand}`,
    ';', 'set-option', '-t', name, 'prefix', 'M-a',
  ]
}
