#!/usr/bin/env bash
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'jobs -pr | xargs -r kill 2>/dev/null || true; chmod -R u+w "$TMP" 2>/dev/null || true; rm -rf "$TMP"' EXIT

origin="$TMP/origin.git"
source_repo="$TMP/source"
releases="$TMP/releases"
journal="$TMP/journal"
lock="$TMP/refeather.lock"
current="$TMP/current"
service_log="$TMP/supervisor.log"

git init --bare -q "$origin"
git init -q "$source_repo"
git -C "$source_repo" config user.email test@example.com
git -C "$source_repo" config user.name Test
mkdir -p "$source_repo/skills" "$source_repo/bin"
for skill in feather sidecar looper; do
  mkdir -p "$source_repo/skills/$skill"
  printf -- '---\nname: %s\n---\n' "$skill" >"$source_repo/skills/$skill/SKILL.md"
done
for cli in room sidecar; do printf '#!/bin/sh\n' >"$source_repo/bin/$cli"; chmod +x "$source_repo/bin/$cli"; done
cat >"$source_repo/build-test.sh" <<'SH'
#!/usr/bin/env bash
set -e
printf '{"version":"candidate-v1"}\n' >version.json
printf 'built\n' >build.marker
SH
chmod +x "$source_repo/build-test.sh"
printf 'tracked\n' >"$source_repo/tracked.txt"
git -C "$source_repo" add .
git -C "$source_repo" commit -qm initial
git -C "$source_repo" branch -M main
git -C "$source_repo" remote add origin "$origin"
git -C "$source_repo" push -qu origin main

stage=("$ROOT/bin/refeather" stage --source "$source_repo" --releases-dir "$releases" --build-command ./build-test.sh)
release="$(REFEATHER_DISK_HEADROOM_KB=0 "${stage[@]}")"
[ -f "$release/build.marker" ]
[ ! -e "$current" ]
[ ! -e "$service_log" ] # staging never guesses or restarts a service
[ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sourceCommit"])' "$release/.refeather-release.json")" = "$(git -C "$source_repo" rev-parse HEAD)" ]

make_receipt() {
  local commit="$1" dir="$2"
  mkdir -p "$dir"
  for artifact in refs binaryDiff untracked mutableState; do printf '%s archive\n' "$artifact" >"$dir/$artifact.bin"; done
  python3 - "$commit" "$dir" <<'PY'
import hashlib, json, os, sys
commit, directory = sys.argv[1:]
artifacts = {}
for name in ("refs", "binaryDiff", "untracked", "mutableState"):
    filename = f"{name}.bin"
    with open(os.path.join(directory, filename), "rb") as handle: digest = hashlib.sha256(handle.read()).hexdigest()
    artifacts[name] = {"path": filename, "sha256": digest}
with open(os.path.join(directory, "receipt.json"), "w", encoding="utf-8") as handle:
    json.dump({"schema": 1, "sourceCommit": commit, "artifacts": artifacts}, handle)
PY
}

printf 'dirty\n' >>"$source_repo/tracked.txt"
printf 'untracked\n' >"$source_repo/untracked.txt"
if REFEATHER_DISK_HEADROOM_KB=0 "${stage[@]}" 2>"$TMP/dirty.err"; then echo "dirty source unexpectedly staged" >&2; exit 1; fi
grep -q 'supply a complete --archive-receipt' "$TMP/dirty.err"
make_receipt "$(git -C "$source_repo" rev-parse HEAD)" "$TMP/dirty-receipt"
[ "$(REFEATHER_DISK_HEADROOM_KB=0 "${stage[@]}" --archive-receipt "$TMP/dirty-receipt/receipt.json")" = "$release" ]
git -C "$source_repo" restore tracked.txt
rm "$source_repo/untracked.txt"

printf 'unpushed\n' >>"$source_repo/tracked.txt"
git -C "$source_repo" add tracked.txt
git -C "$source_repo" commit -qm unpushed
if REFEATHER_DISK_HEADROOM_KB=0 "${stage[@]}" 2>"$TMP/unpushed.err"; then echo "unpushed source unexpectedly staged" >&2; exit 1; fi
grep -q 'unpushed commit' "$TMP/unpushed.err"
make_receipt "$(git -C "$source_repo" rev-parse HEAD)" "$TMP/unpushed-receipt"
release="$(REFEATHER_DISK_HEADROOM_KB=0 "${stage[@]}" --archive-receipt "$TMP/unpushed-receipt/receipt.json")"

if REFEATHER_REQUIRED_COMMANDS='git command-that-does-not-exist' "${stage[@]}" --archive-receipt "$TMP/unpushed-receipt/receipt.json" 2>"$TMP/dependency.err"; then
  echo "missing dependency unexpectedly passed" >&2; exit 1
fi
grep -q 'missing required command' "$TMP/dependency.err"
if REFEATHER_REQUIRED_FREE_KB=999999999999 "${stage[@]}" --archive-receipt "$TMP/unpushed-receipt/receipt.json" 2>"$TMP/disk.err"; then
  echo "low disk preflight unexpectedly passed" >&2; exit 1
fi
grep -q 'insufficient disk' "$TMP/disk.err"

# A canary bind check must fail before staging when another process owns the port.
port_file="$TMP/canary-port"
python3 - "$port_file" <<'PY' &
import socket, sys, time
sock = socket.socket()
sock.bind(("127.0.0.1", 0))
sock.listen()
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    handle.write(str(sock.getsockname()[1]))
    handle.flush()
time.sleep(30)
PY
port_pid=$!
for _ in $(seq 1 100); do [ -s "$port_file" ] && break; sleep 0.01; done
[ -s "$port_file" ] || { echo "canary listener did not start" >&2; exit 1; }
if REFEATHER_DISK_HEADROOM_KB=0 "${stage[@]}" --archive-receipt "$TMP/unpushed-receipt/receipt.json" \
    --check-port "$(cat "$port_file")" 2>"$TMP/port.err"; then
  echo "occupied canary port unexpectedly passed" >&2; exit 1
fi
grep -q 'requested canary port is already in use' "$TMP/port.err"
kill "$port_pid"; wait "$port_pid" 2>/dev/null || true

# A genuine conflicted index is never overridable by an archive receipt.
git -C "$source_repo" checkout -qb conflict-side
printf 'side\n' >"$source_repo/tracked.txt"; git -C "$source_repo" commit -qam side
git -C "$source_repo" checkout -q main
printf 'main\n' >"$source_repo/tracked.txt"; git -C "$source_repo" commit -qam main
git -C "$source_repo" merge conflict-side >/dev/null 2>&1 || true
if "${stage[@]}" --archive-receipt "$TMP/unpushed-receipt/receipt.json" 2>"$TMP/conflict.err"; then
  echo "conflicted source unexpectedly staged" >&2; exit 1
fi
grep -q 'unresolved merge conflicts' "$TMP/conflict.err"
git -C "$source_repo" merge --abort

old="$TMP/releases/old-release"
mkdir -p "$old"
printf '{"schema":1,"sourceCommit":"old","version":"old-v1","source":"fixture"}\n' >"$old/.refeather-release.json"
ln -s "$old" "$current"

fake_supervisor="$TMP/fake-supervisorctl"
cat >"$fake_supervisor" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
action="$3"; program="$4"
printf '%s %s %s\n' "$action" "$program" "$REFEATHER_TEST_CURRENT" >>"$REFEATHER_TEST_SERVICE_LOG"
if [ "$action" = start ] && [ -n "${REFEATHER_TEST_FAIL_START_VERSION:-}" ]; then
  version=$(python3 -c 'import json,os; print(json.load(open(os.path.join(os.environ["REFEATHER_TEST_CURRENT"], ".refeather-release.json")))["version"])')
  [ "$version" != "$REFEATHER_TEST_FAIL_START_VERSION" ] || exit 7
fi
SH
chmod +x "$fake_supervisor"

fake_curl="$TMP/fake-curl"
cat >"$fake_curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
version=$(python3 -c 'import json,os; print(json.load(open(os.path.join(os.environ["REFEATHER_TEST_CURRENT"], ".refeather-release.json")))["version"])')
if [ "${REFEATHER_TEST_WAIT_HEALTH_VERSION:-}" = "$version" ]; then
  : >"$REFEATHER_TEST_WAIT_FILE"
  sleep 30
fi
printf '{"status":"ok","version":"%s","capabilities":{}}\n' "$version"
SH
chmod +x "$fake_curl"

switch_env=(env REFEATHER_SUPERVISORCTL="$fake_supervisor" REFEATHER_CURL="$fake_curl"
  REFEATHER_TEST_CURRENT="$current" REFEATHER_TEST_SERVICE_LOG="$service_log"
  REFEATHER_JOURNAL_DIR="$journal" REFEATHER_LOCK_FILE="$lock" REFEATHER_HEALTH_ATTEMPTS=2 REFEATHER_HEALTH_DELAY=0.01)
switch_args=(--current-link "$current" --program feather-zak --supervisor-socket unix:///tmp/zak-supervisor.sock
  --health-url http://127.0.0.1:8123/feather2/api/health --skip-capability-install)

"${switch_env[@]}" "$ROOT/bin/refeather" promote --release "$release" "${switch_args[@]}"
[ "$(readlink -f "$current")" = "$release" ]
grep -q '^stop feather-zak ' "$service_log"
grep -q '^start feather-zak ' "$service_log"
[ ! -e "$journal/active.json" ]

"${switch_env[@]}" "$ROOT/bin/refeather" rollback --release "$old" "${switch_args[@]}"
[ "$(readlink -f "$current")" = "$old" ]

if "${switch_env[@]}" REFEATHER_PRE_PROMOTE_CHECK=false "$ROOT/bin/refeather" promote --release "$release" "${switch_args[@]}" 2>"$TMP/precheck.err"; then
  echo "failed pre-promotion check unexpectedly promoted" >&2; exit 1
fi
[ "$(readlink -f "$current")" = "$old" ]

if "${switch_env[@]}" REFEATHER_TEST_FAIL_START_VERSION=candidate-v1 "$ROOT/bin/refeather" promote --release "$release" "${switch_args[@]}" 2>"$TMP/failure.err"; then
  echo "failed service start unexpectedly promoted" >&2; exit 1
fi
[ "$(readlink -f "$current")" = "$old" ]
grep -q 'prior release restored' "$TMP/failure.err"

( flock -x 8; sleep 2 ) 8>"$lock" & lock_pid=$!
sleep 0.1
if "${switch_env[@]}" "$ROOT/bin/refeather" promote --release "$release" "${switch_args[@]}" 2>"$TMP/lock.err"; then
  echo "concurrent promotion unexpectedly acquired lock" >&2; exit 1
fi
grep -q 'another promotion or rollback owns lock' "$TMP/lock.err"
wait "$lock_pid"

# Kill after pointer replacement while health is blocked, then recover from the
# durable active phase. Recovery must restore the known prior release.
wait_file="$TMP/health-blocked"
setsid "${switch_env[@]}" REFEATHER_TEST_WAIT_HEALTH_VERSION=candidate-v1 REFEATHER_TEST_WAIT_FILE="$wait_file" \
  "$ROOT/bin/refeather" promote --release "$release" "${switch_args[@]}" >"$TMP/interrupted.out" 2>"$TMP/interrupted.err" & interrupted_pid=$!
for _ in $(seq 1 100); do [ -e "$wait_file" ] && break; sleep 0.02; done
[ -e "$wait_file" ] || { echo "promotion never reached blocked health check" >&2; exit 1; }
kill -KILL -- "-$interrupted_pid" 2>/dev/null || true
wait "$interrupted_pid" 2>/dev/null || true
[ -f "$journal/active.json" ]
[ "$(readlink -f "$current")" = "$release" ]
"${switch_env[@]}" "$ROOT/bin/refeather" recover
[ "$(readlink -f "$current")" = "$old" ]
[ ! -e "$journal/active.json" ]

echo "refeather-e2e: PASS"
