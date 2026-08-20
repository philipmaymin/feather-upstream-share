#!/usr/bin/env bash
# Route-level e2e for multi-peer sidecars. Spins an isolated server (temp HOME,
# spare port), seeds a group via the lib (no real agents — uses `cat` tmux
# stand-ins), and exercises the broker routes end to end.
#
#   bash test/sidecar-multipeer-e2e.sh
#
# Covers: broadcast injects every recipient (and excludes the sender),
# missing-role -> 400, remove-driver guard -> 400, driver-gone GC -> 410 + peers
# killed. No real `claude`/`codex` is spawned.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT=4899
HOME_DIR=$(mktemp -d)
BASE="http://127.0.0.1:$PORT"
GEN=gen00001; P1=peer0001; P2=peer0002          # 8-char ids -> feather-<id> tmux names
SRV_PID=""
fails=0

cleanup() {
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null
  for s in "$GEN" "$P1" "$P2"; do tmux kill-session -t "feather-$s" 2>/dev/null; done
  rm -rf "$HOME_DIR"
}
trap cleanup EXIT

pass() { echo "  ok  - $1"; }
fail() { echo "  NOT OK - $1"; fails=$((fails+1)); }
check() { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (want $2, got $1)"; fi; }

echo "# starting isolated server on :$PORT (HOME=$HOME_DIR)"
HOME="$HOME_DIR" PORT="$PORT" node server.js >"$HOME_DIR/server.log" 2>&1 &
SRV_PID=$!
for i in $(seq 1 20); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/health" 2>/dev/null)" = "200" ] && break
  sleep 0.5
done
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/health")" = "200" ] || { echo "server never came up"; cat "$HOME_DIR/server.log"; exit 1; }

# stand-in sessions (cat echoes injected text to its pane)
for s in "$GEN" "$P1" "$P2"; do tmux new-session -d -s "feather-$s" 'cat'; done

# seed a 3-member group directly (no agent spawn)
GID=$(HOME="$HOME_DIR" node --input-type=module -e "
import * as s from './lib/sidecar.js';
const g = s.createGroup({ id:'e2e-grp', members:[
  {sessionId:'$GEN',role:'generator',spawned:false},
  {sessionId:'$P1',role:'critic-a',spawned:true},
  {sessionId:'$P2',role:'critic-b',spawned:true},
]});
console.log(g.id);
")
check "$GID" "e2e-grp" "seed group"

echo "# broadcast: generator --to all"
code=$(curl -s -o "$HOME_DIR/r.json" -w '%{http_code}' -X POST "$BASE/api/sidecar/$GID/post" \
  -H 'Content-Type: application/json' -d '{"from":"generator","to":"all","text":"BCAST_XYZ"}')
check "$code" "200" "broadcast accepted"
sleep 1.2
echo "$(tmux capture-pane -p -t feather-$P1)" | grep -q BCAST_XYZ && pass "critic-a received broadcast" || fail "critic-a missing broadcast"
echo "$(tmux capture-pane -p -t feather-$P2)" | grep -q BCAST_XYZ && pass "critic-b received broadcast" || fail "critic-b missing broadcast"
echo "$(tmux capture-pane -p -t feather-$GEN)" | grep -q BCAST_XYZ && fail "sender wrongly received its own broadcast" || pass "sender excluded from broadcast"

echo "# missing role -> 400"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/sidecar/$GID/post" \
  -H 'Content-Type: application/json' -d '{"from":"generator","to":"ghost","text":"x"}')
check "$code" "400" "missing-role rejected"

echo "# remove-driver guard -> 400"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/sidecar/$GID/peers/generator/delete")
check "$code" "400" "cannot remove the driver"

echo "# driver-gone GC -> 410 + peers killed"
tmux kill-session -t "feather-$GEN"     # driver dies
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/sidecar/$GID/post" \
  -H 'Content-Type: application/json' -d '{"from":"critic-a","to":"generator","text":"anyone?"}')
check "$code" "410" "post after driver death is GC'd (410)"
sleep 0.5
tmux has-session -t "feather-$P1" 2>/dev/null && fail "critic-a not killed by GC" || pass "GC killed critic-a"
tmux has-session -t "feather-$P2" 2>/dev/null && fail "critic-b not killed by GC" || pass "GC killed critic-b"
status=$(curl -s "$BASE/api/sidecar/$GID" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).group.status))")
check "$status" "done" "group marked done after GC"

echo
if [ "$fails" -eq 0 ]; then echo "ALL E2E CHECKS PASSED"; else echo "$fails E2E CHECK(S) FAILED"; fi
exit "$fails"
