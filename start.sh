#!/bin/sh
# Local dev only. For cloud/production use deploy.sh (Docker).
cd "$(dirname "$0")"
LOG_FILE="ragent.log"
# Start in a new process group so stop.sh can kill npx + all child node processes
./stop.sh
npx tsx src/index.ts "$@" >> "$LOG_FILE" 2>&1 &
echo $! > ragent.pid
echo "[ragent] Started (PID: $!) — logs: $LOG_FILE"
