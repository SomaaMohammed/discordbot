#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_NAME="${SERVICE_NAME:-imperial-court-bot}"
BRANCH="${1:-main}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="${VENV_DIR:-$APP_DIR/.venv}"
LOCAL_CHANGES_POLICY="${LOCAL_CHANGES_POLICY:-abort}"

# LOCAL_CHANGES_POLICY controls how local git changes are handled before pull:
#   abort   -> stop deployment and print instructions (default, safest)
#   stash   -> stash tracked + untracked changes automatically
#   discard -> hard reset + clean untracked files (destructive)

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

ensure_clean_or_handle_changes() {
  local dirty
  dirty="$(git status --porcelain)"
  if [[ -z "$dirty" ]]; then
    return
  fi

  echo "==> Local git changes detected:"
  echo "$dirty"

  case "$LOCAL_CHANGES_POLICY" in
    abort)
      echo "Error: working tree is not clean; refusing to pull with LOCAL_CHANGES_POLICY=abort." >&2
      echo "Use one of:" >&2
      echo "  git stash push -u -m 'pre-deploy stash'" >&2
      echo "  LOCAL_CHANGES_POLICY=stash ./deploy_vm.sh $BRANCH" >&2
      echo "  LOCAL_CHANGES_POLICY=discard ./deploy_vm.sh $BRANCH   # destructive" >&2
      exit 1
      ;;
    stash)
      local stash_name
      stash_name="deploy-vm-autostash-$(date +%Y%m%d-%H%M%S)"
      git stash push --include-untracked -m "$stash_name" >/dev/null
      echo "==> Stashed local changes as: $stash_name"
      ;;
    discard)
      echo "==> Discarding local changes (LOCAL_CHANGES_POLICY=discard)"
      git reset --hard HEAD
      git clean -fd
      ;;
    *)
      echo "Error: invalid LOCAL_CHANGES_POLICY='$LOCAL_CHANGES_POLICY' (expected: abort|stash|discard)." >&2
      exit 1
      ;;
  esac
}

echo "==> Deploying from branch: $BRANCH"
echo "==> App directory: $APP_DIR"
echo "==> Service: $SERVICE_NAME"
echo "==> Local changes policy: $LOCAL_CHANGES_POLICY"

echo "==> Validate git worktree state"
ensure_clean_or_handle_changes

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
