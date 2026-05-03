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
  kill_tree "$PID"
  rm -f ragent.pid
  echo "[ragent] Stopped (PID: $PID)"
else
  echo "[ragent] Not running"
fi
