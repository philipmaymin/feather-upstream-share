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

export function ompNeedsDeviceAuth(model) {
  return /^openai-codex(?:\/|$)/.test(model)
}

// Feather normally runs OMP on a remote host while the browser is on a phone.
// OpenAI's ordinary Codex OAuth flow redirects to localhost:1455, which points
// at the phone and also permits only one pending login on the server. OMP's
// device provider is designed for this topology and stores the resulting
// credential under the same shared openai-codex provider id.
export function ompLaunchCommand(ompArgs, model, thinking, { interactive = true } = {}) {
  const agentCommand = `omp ${ompModelFlags(model, thinking)}${ompArgs} --allow-home`
  if (!interactive || !ompNeedsDeviceAuth(model)) return agentCommand
  return `if ! omp token openai-codex --list >/dev/null 2>&1; then omp auth-broker login openai-codex-device || { printf "\\nOMP phone sign-in did not finish. Resume this chat to try again.\\n"; exec bash; }; fi; exec ${agentCommand}`
}

export function ompTmuxArgs(name, dir, command) {
  const quotedCommand = `'${String(command).replaceAll("'", "'\\''")}'`
  return [
    'new-session', '-d', '-s', name, '-c', dir,
    `bash --rcfile ~/.bashrc -ic ${quotedCommand}`,
    ';', 'set-option', '-t', name, 'prefix', 'M-a',
  ]
}
