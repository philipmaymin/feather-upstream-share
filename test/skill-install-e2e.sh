#!/usr/bin/env bash
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

release="$TMP/releases/release-one"
current="$TMP/current"
claude="$TMP/home/.claude/skills"
codex="$TMP/home/.codex/skills"
omp_skills="$TMP/home/.omp/agent/skills"
omp_extensions="$TMP/home/.omp/agent/extensions"
bindir="$TMP/home/.local/bin"
backup="$TMP/conflict-backup"
mkdir -p "$release/skills" "$release/omp-tools" "$release/bin"
for skill in feather sidecar council; do
  mkdir -p "$release/skills/$skill"
  printf -- '---\nname: %s\n---\n' "$skill" >"$release/skills/$skill/SKILL.md"
done
printf 'export default function () {}\n' >"$release/omp-tools/feather-protocol-tools.js"
for cli in room sidecar refeather refeather-fleet; do printf '#!/bin/sh\n' >"$release/bin/$cli"; chmod +x "$release/bin/$cli"; done
ln -s "$release" "$current"
mkdir -p "$claude" "$codex"
ln -s "$current/skills/looper" "$claude/looper"
ln -s "$current/skills/looper" "$codex/looper"

install=("$ROOT/bin/refeather" install-capabilities --release "$release" --target-root "$current"
  --claude-skills-dir "$claude" --codex-skills-dir "$codex"
  --omp-skills-dir "$omp_skills" --omp-extensions-dir "$omp_extensions"
  --bin-dir "$bindir" --backup-dir "$backup")
"${install[@]}"
rm "$omp_extensions/feather-protocol-tools.js"
ln -s "$release/omp-tools/feather-protocol-tools.js" "$omp_extensions/feather-protocol-tools.js"
"${install[@]}" # idempotent and normalizes an older immutable managed target

for harness in "$claude" "$codex"; do
  for skill in feather sidecar; do
    [ "$(readlink "$harness/$skill")" = "$current/skills/$skill" ]
  done
done
[ ! -e "$claude/looper" ] && [ ! -L "$claude/looper" ]
[ ! -e "$codex/looper" ] && [ ! -L "$codex/looper" ]
[ "$(readlink "$omp_skills/council")" = "$current/skills/council" ]
[ "$(readlink "$omp_extensions/feather-protocol-tools.js")" = "$current/omp-tools/feather-protocol-tools.js" ]
for cli in room sidecar refeather refeather-fleet; do [ "$(readlink "$bindir/$cli")" = "$current/bin/$cli" ]; done

rm "$claude/feather"
printf 'user-owned skill\n' >"$claude/feather"
if "${install[@]}" 2>"$TMP/conflict.err"; then
  echo "expected a conflicting skill to abort installation" >&2
  exit 1
fi
grep -q 'capability destination conflicts' "$TMP/conflict.err"
[ "$(cat "$claude/feather")" = 'user-owned skill' ]
grep -q "$claude/feather" "$backup/manifest.tsv"

rm "$claude/feather"
ln -s "$current/skills/feather" "$claude/feather"
rm "$omp_extensions/feather-protocol-tools.js"
printf 'user-owned OMP extension\n' >"$omp_extensions/feather-protocol-tools.js"
if "${install[@]}" --backup-dir "$TMP/tool-conflict-backup" 2>"$TMP/tool-conflict.err"; then
  echo "expected a conflicting OMP extension to abort installation" >&2
  exit 1
fi
grep -q 'capability destination conflicts' "$TMP/tool-conflict.err"
[ "$(cat "$omp_extensions/feather-protocol-tools.js")" = 'user-owned OMP extension' ]
grep -q "$omp_extensions/feather-protocol-tools.js" "$TMP/tool-conflict-backup/manifest.tsv"

fake_curl="$TMP/fake-curl"
cat >"$fake_curl" <<'SH'
#!/usr/bin/env bash
url="${!#}"
port="${url#http://127.0.0.1:}"; port="${port%%/*}"
case ",${FEATHER_FAKE_PORTS:-}," in
  *",$port,"*) printf '{"status":"ok","version":"test","capabilities":{}}\n'; exit 0 ;;
  *) exit 22 ;;
esac
SH
chmod +x "$fake_curl"
unset PI_SESSION_FILE FEATHER_SESSION_ID

session_dir="$TMP/omp-sessions/owner-id"
mkdir -p "$session_dir"
printf '%s\n' '{"url":"http://127.0.0.1:4871/api/internal/sessions/owner-id/events","token":"test","sessionId":"owner-id"}' >"$session_dir/.feather-bridge.json"
touch "$session_dir/rollout.jsonl"
[ "$(PI_SESSION_FILE="$session_dir/rollout.jsonl" FEATHER_CURL="$fake_curl" FEATHER_FAKE_PORTS=4871 "$ROOT/bin/feather-instance")" = 'http://127.0.0.1:4871' ]
[ "$(PI_SESSION_FILE="$session_dir/rollout.jsonl" FEATHER_CURL="$fake_curl" FEATHER_FAKE_PORTS=4870 "$ROOT/bin/feather-instance")" = 'http://127.0.0.1:4870' ]

[ "$(FEATHER_URL='https://zak.example/feather2/' FEATHER_CURL=/missing "$ROOT/bin/feather-instance")" = 'https://zak.example/feather2' ]
[ "$(FEATHER_CURL="$fake_curl" FEATHER_FAKE_PORTS=4870 "$ROOT/bin/feather-instance")" = 'http://127.0.0.1:4870' ]
[ "$(FEATHER_CURL="$fake_curl" FEATHER_FAKE_PORTS=3300 FEATHER_PORT=3300 "$ROOT/bin/sidecar" url)" = 'http://127.0.0.1:3300' ]
[ "$(FEATHER_CURL="$fake_curl" FEATHER_FAKE_PORTS=3300 PORT=3300 "$ROOT/bin/feather-instance")" = 'http://127.0.0.1:3300' ]
[ "$(FEATHER_CURL="$fake_curl" FEATHER_FAKE_PORTS=3300 FEATHER_PORT=3300 PORT=not-a-port "$ROOT/bin/feather-instance")" = 'http://127.0.0.1:3300' ]
if FEATHER_CURL="$fake_curl" FEATHER_FAKE_PORTS=3300,4870 "$ROOT/bin/feather-instance" 2>"$TMP/ambiguous.err"; then
  echo "expected ambiguous discovery to fail" >&2
  exit 1
fi
grep -q 'multiple Feather instances' "$TMP/ambiguous.err"

echo "skill-install-e2e: PASS"
