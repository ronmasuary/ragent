#!/bin/sh
cd "$(dirname "$0")"
LOG_FILE="ragent.log"
npx tsx src/index.ts "$@" >> "$LOG_FILE" 2>&1 &
echo $! > ragent.pid
echo "[ragent] Started (PID: $!) — logs: $LOG_FILE"
