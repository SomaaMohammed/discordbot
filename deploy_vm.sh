#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_NAME="${SERVICE_NAME:-imperial-court-bot}"
BRANCH="${1:-main}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="${VENV_DIR:-$APP_DIR/.venv}"

if ! command -v git >/dev/null 2>&1; then
  echo "Error: git is not installed." >&2
  exit 1
fi

if ! command -v sudo >/dev/null 2>&1; then
  echo "Error: sudo is required to restart and check systemd service." >&2
  exit 1
fi

if [[ ! -d "$VENV_DIR" ]]; then
  echo "Error: virtual environment not found at $VENV_DIR" >&2
  echo "Create it first: python3 -m venv .venv" >&2
  exit 1
fi

if [[ ! -f "$APP_DIR/requirements.txt" ]]; then
  echo "Error: requirements.txt not found in $APP_DIR" >&2
  exit 1
fi

cd "$APP_DIR"

echo "==> Deploying from branch: $BRANCH"
echo "==> App directory: $APP_DIR"
echo "==> Service: $SERVICE_NAME"

echo "==> Fetch latest changes"
git fetch origin "$BRANCH"

echo "==> Pull latest commit"
git pull --ff-only origin "$BRANCH"

# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

echo "==> Install/update Python dependencies"
python -m pip install -r requirements.txt

echo "==> Restart service"
sudo systemctl restart "$SERVICE_NAME"

if ! sudo systemctl is-active --quiet "$SERVICE_NAME"; then
  echo "Error: service '$SERVICE_NAME' is not active after restart." >&2
  sudo journalctl -u "$SERVICE_NAME" -n 100 --no-pager || true
  exit 1
fi

echo "==> Service status"
sudo systemctl --no-pager --full status "$SERVICE_NAME"

echo "==> Recent logs"
sudo journalctl -u "$SERVICE_NAME" -n 60 --no-pager

echo "==> Deployment completed successfully"
echo "If needed, live logs: sudo journalctl -u $SERVICE_NAME -f"
