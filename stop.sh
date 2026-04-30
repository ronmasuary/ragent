#!/bin/sh
cd "$(dirname "$0")"
if [ -f ragent.pid ]; then
  PID=$(cat ragent.pid)
  kill "$PID" 2>/dev/null && echo "[ragent] Stopped (PID: $PID)"
  rm -f ragent.pid
else
  echo "[ragent] Not running"
fi
