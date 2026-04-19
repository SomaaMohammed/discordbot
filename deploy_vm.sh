#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRANCH="${1:-${BRANCH:-main}}"

if [[ ! -x "$APP_DIR/deploy_server.sh" ]]; then
  chmod +x "$APP_DIR/deploy_server.sh"
fi

echo "[deploy-vm] Forwarding to deploy_server.sh (TypeScript rollout path)"
exec "$APP_DIR/deploy_server.sh" "$BRANCH"
