#!/usr/bin/env bash
set -euo pipefail

AGENT_NAME="${AGENT_NAME:-wally}"
IDENTITY_DIR="./identities/${AGENT_NAME}"
KEEP_SKILLS=false

for arg in "$@"; do
  case "$arg" in
    --keep-skills) KEEP_SKILLS=true ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

echo "[reset] Stopping agent..."
./stop.sh 2>/dev/null || true

echo "[reset] Clearing history, logs, errors..."
rm -f "${IDENTITY_DIR}/history.jsonl"
rm -f "${IDENTITY_DIR}/errors.jsonl"
rm -f "${IDENTITY_DIR}/shell_audit.jsonl"
rm -f ./ragent.log

if [ "$KEEP_SKILLS" = true ]; then
  echo "[reset] Keeping skills/ (--keep-skills)"
else
  echo "[reset] Clearing skills..."
  rm -rf ./skills/*/
fi

echo "[reset] Done. Start with: ./start.sh"
