#!/bin/sh
cd "$(dirname "$0")"

kill_tree() {
  local pid=$1
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_tree "$child"
  done
  kill "$pid" 2>/dev/null
}

if [ -f ragent.pid ]; then
  PID=$(cat ragent.pid)
  # Kill the whole process tree rooted at PID
  pkill -P "$PID" 2>/dev/null
  kill "$PID" 2>/dev/null && echo "[ragent] Stopped (PID: $PID)"
  rm -f ragent.pid
  echo "[ragent] Stopped (PID: $PID)"
else
  echo "[ragent] Not running"
fi
# Kill any stragglers from the ragent directory
pkill -f "ragent/node_modules/.bin/tsx\|ragent/node_modules/tsx" 2>/dev/null || true
