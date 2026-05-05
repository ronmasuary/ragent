#!/bin/sh
# Cloud VM deployment: pull latest code and restart Docker container.
# For local dev, use start.sh / stop.sh instead.
set -e
cd "$(dirname "$0")"
git pull
docker compose up -d --build
echo "[ragent] Deployed."
