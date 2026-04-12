#!/usr/bin/env bash
set -Eeuo pipefail

# General server deployment entrypoint.
# Pulls latest code safely, then runs the full post-pull rollout checks.
#
# Usage:
#   chmod +x deploy_server.sh
#   ./deploy_server.sh
#   ./deploy_server.sh main
#
# Optional env overrides:
#   SERVICE_NAME=imperial-court-bot
#   APP_DIR=~/imperial-court-bot
#   VENV_DIR=~/imperial-court-bot/.venv
#   LOCAL_CHANGES_POLICY=abort|stash|discard
#   RUN_TESTS=1
#   RUN_LINT=1
#   SKIP_PULL=1

SERVICE_NAME="${SERVICE_NAME:-imperial-court-bot}"
APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
VENV_DIR="${VENV_DIR:-$APP_DIR/.venv}"
BRANCH="${1:-${BRANCH:-main}}"
LOCAL_CHANGES_POLICY="${LOCAL_CHANGES_POLICY:-abort}"
RUN_TESTS="${RUN_TESTS:-0}"
RUN_LINT="${RUN_LINT:-0}"
SKIP_PULL="${SKIP_PULL:-0}"

log() {
  echo "[deploy-server] $*"
}

fail() {
  echo "[deploy-server][error] $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

require_file() {
  [[ -f "$1" ]] || fail "Missing required file: $1"
}

ensure_clean_or_handle_changes() {
  local dirty
  dirty="$(git status --porcelain)"
  if [[ -z "$dirty" ]]; then
    return
  fi

  log "Local git changes detected:"
  echo "$dirty"

  case "$LOCAL_CHANGES_POLICY" in
    abort)
      fail "Working tree is not clean. Use LOCAL_CHANGES_POLICY=stash or discard to continue."
      ;;
    stash)
      local stash_name
      stash_name="deploy-server-autostash-$(date +%Y%m%d-%H%M%S)"
      git stash push --include-untracked -m "$stash_name" >/dev/null
      log "Stashed local changes as: $stash_name"
      ;;
    discard)
      log "Discarding local changes (destructive)"
      git reset --hard HEAD
      git clean -fd
      ;;
    *)
      fail "Invalid LOCAL_CHANGES_POLICY='$LOCAL_CHANGES_POLICY' (expected: abort|stash|discard)"
      ;;
  esac
}

main() {
  require_cmd git
  require_cmd sudo
  require_cmd bash

  require_file "$APP_DIR/post_pull_server.sh"

  cd "$APP_DIR"

  log "App dir: $APP_DIR"
  log "Branch: $BRANCH"
  log "Service: $SERVICE_NAME"
  log "Local changes policy: $LOCAL_CHANGES_POLICY"

  if [[ "$SKIP_PULL" != "1" ]]; then
    log "Validating git worktree"
    ensure_clean_or_handle_changes

    log "Fetching branch: $BRANCH"
    git fetch origin "$BRANCH"

    log "Pulling latest commit"
    git pull --ff-only origin "$BRANCH"
  else
    log "SKIP_PULL=1 set, skipping git fetch/pull"
  fi

  chmod +x "$APP_DIR/post_pull_server.sh"

  log "Running post-pull rollout"
  SERVICE_NAME="$SERVICE_NAME" \
  APP_DIR="$APP_DIR" \
  VENV_DIR="$VENV_DIR" \
  RUN_TESTS="$RUN_TESTS" \
  RUN_LINT="$RUN_LINT" \
  "$APP_DIR/post_pull_server.sh"

  log "Deployment finished successfully"
}

main "$@"