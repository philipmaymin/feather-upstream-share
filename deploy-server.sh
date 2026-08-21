#!/bin/bash
# Safe server deploy: syntax check, backup, restart, health check, rollback on failure
set -e

FEATHER_DIR="$1"
PORT="$2"

if [ -z "$FEATHER_DIR" ] || [ -z "$PORT" ]; then
  echo "Usage: deploy-server.sh <feather-dir> <port>"
  echo "Example: deploy-server.sh /home/user/feather-next 4870"
  exit 1
fi

SERVER="$FEATHER_DIR/server-single.js"
BACKUP="$FEATHER_DIR/server-single.js.bak"

# Step 1: Syntax check
echo "Checking syntax..."
if ! node --check "$SERVER" 2>&1; then
  echo "BLOCKED: Syntax error in server-single.js. Not deploying."
  exit 1
fi

# Step 2: Find only the process listening on this port. Plain `lsof -ti`
# also returns connected clients; quoting that multi-line result makes `kill`
# reject the whole value and can leave the old server running unnoticed.
mapfile -t OLD_PIDS < <(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
if [ "${#OLD_PIDS[@]}" -eq 0 ]; then
  echo "No server found on port $PORT, starting fresh."
fi

# Step 3: Backup current running version (if different from new)
if [ "${#OLD_PIDS[@]}" -gt 0 ] && [ -f "$SERVER" ]; then
  cp "$SERVER" "$BACKUP"
  echo "Backed up to $BACKUP"
fi

# Step 4: Kill old server and start new one
if [ "${#OLD_PIDS[@]}" -gt 0 ]; then
  kill "${OLD_PIDS[@]}" 2>/dev/null || true
  sleep 1
fi

OWNER=$(stat -c '%U' "$FEATHER_DIR")
start_server() {
  if [ "$OWNER" != "$(whoami)" ]; then
    sudo -u "$OWNER" env PORT="$PORT" bash -c 'cd "$1" && exec node server-single.js' bash "$FEATHER_DIR" </dev/null >> "/tmp/feather-${OWNER}-${PORT}.log" 2>&1 &
  else
    (cd "$FEATHER_DIR" && exec env PORT="$PORT" node server-single.js) </dev/null >> "/tmp/feather-${PORT}.log" 2>&1 &
  fi
  START_PID=$!
}

start_server
echo "Started server on port $PORT"

# Step 5: Health check (try for 5 seconds)
echo "Health check..."
HEALTHY=false
for i in 1 2 3 4 5; do
  sleep 1
  if kill -0 "$START_PID" 2>/dev/null && curl -sf "http://localhost:${PORT}/api/version" > /dev/null 2>&1; then
    HEALTHY=true
    break
  fi
done

if [ "$HEALTHY" = true ]; then
  echo "OK: Server healthy on port $PORT"
  # Clean up backup on success
  rm -f "$BACKUP"
  exit 0
else
  echo "FAILED: Server not responding on port $PORT. Rolling back..."

  # Kill the broken server
  mapfile -t NEW_PIDS < <(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
  if [ "${#NEW_PIDS[@]}" -gt 0 ]; then
    kill "${NEW_PIDS[@]}" 2>/dev/null || true
    sleep 1
  fi

  # Restore backup
  if [ -f "$BACKUP" ]; then
    cp "$BACKUP" "$SERVER"
    start_server
    echo "Rolled back to previous version and restarted."
  else
    echo "No backup found. Server is DOWN."
  fi
  exit 1
fi
