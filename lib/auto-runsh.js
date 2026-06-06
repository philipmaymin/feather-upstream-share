// Generate an auto-instance run.sh from a pipeline JSON definition.
//
// A pipeline file (templates/auto/<name>.json) defines:
//   - timeout, sleepBetween, sleepOnCrash (seconds)
//   - phases: [{ phase: "claude-design"|"codex-impl"|..., role: "You are ..." }]
//   - metaPhase (optional): { probability: 0.1, phase, role } — fires randomly
//     each iteration in place of the normal cycle.
//
// Engine is derived from the phase name prefix: "claude-*" → claude CLI,
// "codex-*" → codex CLI. A bare "claude" / "codex" works too.
//
// Role strings can use the placeholders {DIR} (instance directory) and {NAME}
// (instance name); both are substituted at generation time.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dirname, '..', 'templates', 'auto');

function listPipelines() {
  try {
    return fs.readdirSync(TEMPLATES_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace(/\.json$/, ''))
      .sort();
  } catch { return []; }
}

function loadPipeline(name) {
  const p = path.join(TEMPLATES_DIR, `${name}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// Single-quote a string for safe bash interpolation. Escapes embedded ' as '\''.
const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

function generateRunSh({ pipelineName, instanceName, instanceDir, repo }) {
  const pipeline = loadPipeline(pipelineName);
  if (!pipeline) throw new Error(`unknown pipeline: ${pipelineName}`);
  if (!Array.isArray(pipeline.phases) || pipeline.phases.length === 0) {
    throw new Error(`pipeline ${pipelineName} has no phases`);
  }

  const timeout = pipeline.timeout ?? 1200;
  const sleepBetween = pipeline.sleepBetween ?? 30;
  const sleepOnCrash = pipeline.sleepOnCrash ?? 300;
  const timeoutMin = Math.max(1, Math.round(timeout / 60));

  const subst = (s) => String(s)
    .replace(/\{DIR\}/g, instanceDir)
    .replace(/\{NAME\}/g, instanceName);

  const engineOf = (phaseName) => phaseName.split('-')[0];

  const phasesList = pipeline.phases.map(p => sq(p.phase)).join(' ');
  const rolesList = pipeline.phases
    .map(p => '    ' + sq(subst(p.role)))
    .join('\n');

  const codexC = repo ? `-C ${repo}` : '';

  let phasePickBlock;
  if (pipeline.metaPhase) {
    const m = pipeline.metaPhase;
    const denom = Math.max(2, Math.round(1 / m.probability));
    phasePickBlock = `    if [ $((RANDOM % ${denom})) -eq 0 ]; then
        PHASE=${sq(m.phase)}
        ENGINE=${sq(engineOf(m.phase))}
        ROLE=${sq(subst(m.role))}
    else
        PHASE_IDX=$(( (ITERATION - 1) % ${pipeline.phases.length} ))
        PHASE="\${PHASES[$PHASE_IDX]}"
        ROLE="\${ROLES[$PHASE_IDX]}"
        ENGINE="\${PHASE%%-*}"
    fi`;
  } else {
    phasePickBlock = `    PHASE_IDX=$(( (ITERATION - 1) % ${pipeline.phases.length} ))
    PHASE="\${PHASES[$PHASE_IDX]}"
    ROLE="\${ROLES[$PHASE_IDX]}"
    ENGINE="\${PHASE%%-*}"`;
  }

  return `#!/bin/bash
# auto-${instanceName} — generated from pipeline "${pipelineName}".
# Regenerate via /api/auto/instances or templates/auto/${pipelineName}.json.

DIR="$(cd "$(dirname "$0")" && pwd)"
PROGRAM="$DIR/program.md"
RESULTS="$DIR/results.tsv"
LOGDIR="$DIR/logs"
TIMEOUT=${timeout}
SLEEP_ON_CRASH=${sleepOnCrash}
SLEEP_BETWEEN=${sleepBetween}

export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

[ -f /home/user/.env ] && . /home/user/.env
[ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && unset ANTHROPIC_API_KEY

mkdir -p "$LOGDIR"
[ ! -f "$RESULTS" ] && printf "timestamp\\tstatus\\tdescription\\n" > "$RESULTS"

ITER_FILE="$DIR/iteration_count"
[ -f "$ITER_FILE" ] && ITERATION=$(cat "$ITER_FILE") || ITERATION=0

PHASES=(${phasesList})
ROLES=(
${rolesList}
)

echo "[auto-${instanceName}] Starting (pipeline: ${pipelineName})"

while true; do
    ITERATION=$((ITERATION+1))
    echo "$ITERATION" > "$ITER_FILE"
    TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

${phasePickBlock}

    LOGFILE="$LOGDIR/iteration-$(printf '%04d' $ITERATION)-\${PHASE}-$(date +%s).log"
    KEEPS=$(tail -n +2 "$RESULTS" 2>/dev/null | grep -c "keep" || true)
    REVERTS=$(tail -n +2 "$RESULTS" 2>/dev/null | grep -c "revert" || true)

    DEADLINE=$(($(date +%s) + TIMEOUT))
    echo "$DEADLINE" > "$DIR/deadline"
    LINES_BEFORE=$(wc -l < "$RESULTS")

    echo "[auto-${instanceName}] === Iteration $ITERATION ($PHASE) — keeps=$KEEPS reverts=$REVERTS ==="
    echo "$PHASE #$ITERATION at $(date -u +'%H:%M UTC') — keeps=$KEEPS reverts=$REVERTS" > "$DIR/current.txt"

    PREV_LOG=$(ls -t "$LOGDIR"/iteration-*.log 2>/dev/null | head -1)
    PREV_LOG_LINE=""
    [ -f "$PREV_LOG" ] && PREV_LOG_LINE="Previous iteration log (tail it if you want context): $PREV_LOG"

    PROMPT_FILE=$(mktemp)
    cat > "$PROMPT_FILE" <<PROMPTEOF
AUTO_WORKER=TRUE — auto-${instanceName} \$PHASE iteration \$ITERATION.
You have a hard ${timeoutMin}-minute timeout. Check: echo \\$((\\$(cat $DIR/deadline) - \\$(date +%s)))s left

\$ROLE

Instructions: cat $PROGRAM
Progress so far: cat $RESULTS
\$PREV_LOG_LINE

Log results to $RESULTS:
  keep:   printf '%s\\tkeep\\tDESCRIPTION\\n' "\\$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> $RESULTS
  revert: printf '%s\\trevert\\tDESCRIPTION\\n' "\\$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> $RESULTS
PROMPTEOF

    if [ "$ENGINE" = "claude" ]; then
        timeout "$TIMEOUT" claude --print --dangerously-skip-permissions \\
            -p "$(cat "$PROMPT_FILE")" < /dev/null > "$LOGFILE" 2>&1
    else
        timeout "$TIMEOUT" codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check \\
            ${codexC} \\
            --add-dir "$DIR" \\
            < "$PROMPT_FILE" > "$LOGFILE" 2>&1
    fi
    rm -f "$PROMPT_FILE"

    EXIT_CODE=$?
    LINES_AFTER=$(wc -l < "$RESULTS")

    if [ $EXIT_CODE -eq 124 ]; then
        printf "%s\\tcrash\\t%s timed out after ${timeoutMin} minutes\\n" "$TIMESTAMP" "$PHASE" >> "$RESULTS"
        sleep "$SLEEP_ON_CRASH"
    elif [ $EXIT_CODE -ne 0 ]; then
        printf "%s\\tcrash\\t%s exited with code %d\\n" "$TIMESTAMP" "$PHASE" "$EXIT_CODE" >> "$RESULTS"
        sleep "$SLEEP_ON_CRASH"
    else
        if [ "$LINES_AFTER" -le "$LINES_BEFORE" ]; then
            REASON=$(tail -3 "$LOGFILE" | tr '\\n' ' ' | cut -c1-120)
            printf "%s\\tskip\\t%s: %s\\n" "$TIMESTAMP" "$PHASE" "\${REASON:-No output}" >> "$RESULTS"
        fi
    fi

    sleep "$SLEEP_BETWEEN"
done
`;
}

export { generateRunSh, listPipelines, loadPipeline };
