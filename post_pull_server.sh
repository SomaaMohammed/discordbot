#!/usr/bin/env bash
set -Eeuo pipefail

# Post-pull rollout helper for Imperial Court Bot.
# Usage:
#   chmod +x post_pull_server.sh
#   ./post_pull_server.sh
#
# Optional env overrides:
#   SERVICE_NAME=imperial-court-bot
#   APP_DIR=~/imperial-court-bot
#   VENV_DIR=~/imperial-court-bot/.venv
#   RUN_TESTS=0
#   RUN_LINT=0

SERVICE_NAME="${SERVICE_NAME:-imperial-court-bot}"
APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
VENV_DIR="${VENV_DIR:-$APP_DIR/.venv}"
PYTHON_BIN="$VENV_DIR/bin/python"
ENV_FILE="$APP_DIR/.env"
DB_FILE=""
BACKUP_DIR="$APP_DIR/backups"
RUN_TESTS="${RUN_TESTS:-0}"
RUN_LINT="${RUN_LINT:-0}"

log() {
  echo "[post-pull] $*"
}

fail() {
  echo "[post-pull][error] $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

require_file() {
  [[ -f "$1" ]] || fail "Missing required file: $1"
}

require_dir() {
  [[ -d "$1" ]] || fail "Missing required directory: $1"
}

has_env_key() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] && grep -Eq "^[[:space:]]*${key}=" "$ENV_FILE"
}

require_env_key() {
  local key="$1"
  has_env_key "$key" || fail "Missing required env key in .env: $key"
}

ensure_env_default() {
  local key="$1"
  local default_value="$2"
  if ! has_env_key "$key"; then
    echo "${key}=${default_value}" >> "$ENV_FILE"
    log "Added missing .env key: ${key}=${default_value}"
  fi
}

read_env_value() {
  local key="$1"
  local value
  value="$(grep -E "^[[:space:]]*${key}=" "$ENV_FILE" | tail -n1 | cut -d'=' -f2- || true)"
  echo "$value"
}

resolve_db_file() {
  local db_from_env
  db_from_env="$(read_env_value "DB_FILE")"

  if [[ -n "$db_from_env" ]]; then
    if [[ "$db_from_env" = /* ]]; then
      DB_FILE="$db_from_env"
    else
      DB_FILE="$APP_DIR/$db_from_env"
    fi
  else
    DB_FILE="$APP_DIR/court.db"
  fi
}

run_migration_warmup() {
  log "Running storage warm-up import"
  (
    cd "$APP_DIR"
    "$PYTHON_BIN" - <<'PY'
import bot
print(f"[post-pull] bot DB_FILE resolved to: {bot.DB_FILE}")
PY
  )
}

verify_tables() {
  local tables
  tables="$(sqlite3 "$DB_FILE" ".tables" || true)"
  log "SQLite tables in $DB_FILE: $tables"

  for table in kv posts answers metrics anon_cooldowns; do
    if ! grep -Eq "(^|[[:space:]])${table}($|[[:space:]])" <<<"$tables"; then
      fail "Expected SQLite table not found after migration: $table"
    fi
  done

  log "SQLite table check passed (kv, posts, answers, metrics, anon_cooldowns)."
}

main() {
  require_cmd sudo
  require_cmd sqlite3
  require_cmd grep
  require_file "$APP_DIR/requirements.txt"
  require_file "$APP_DIR/bot.py"
  require_dir "$VENV_DIR"
  require_file "$PYTHON_BIN"
  require_file "$ENV_FILE"

  log "App dir: $APP_DIR"
  log "Service: $SERVICE_NAME"

  require_env_key "DISCORD_TOKEN"
  require_env_key "TEST_GUILD_ID"
  require_env_key "COURT_CHANNEL_ID"

  ensure_env_default "LOG_CHANNEL_ID" "0"
  ensure_env_default "TIMEZONE" "Asia/Qatar"

  ensure_env_default "STAFF_ROLE_IDS" "1461376227095875707,1461386876475932806,1461485629178122465,1461513633367330982,1461513909130498230"
  ensure_env_default "EMPEROR_ROLE_ID" "1461376227095875707"
  ensure_env_default "EMPRESS_ROLE_ID" "1461485629178122465"
  ensure_env_default "SILENT_LOCK_EXCLUDE_ROLES" "1462082750101328029,1461500213746204921,1461382351874424842"
  ensure_env_default "ROYAL_ALERT_CHANNEL_ID" "1461374216795328515"
  ensure_env_default "UNDEFEATED_USER_ID" "934478657114742874"

  ensure_env_default "ANON_MIN_ACCOUNT_AGE_MINUTES" "0"
  ensure_env_default "ANON_MIN_MEMBER_AGE_MINUTES" "0"
  ensure_env_default "ANON_REQUIRED_ROLE_ID" "0"
  ensure_env_default "ANON_COOLDOWN_SECONDS" "0"
  ensure_env_default "ANON_ALLOW_LINKS" "false"

  ensure_env_default "MUTEALL_TARGET_CAP" "0"
  ensure_env_default "WEEKLY_DIGEST_CHANNEL_ID" "0"
  ensure_env_default "WEEKLY_DIGEST_WEEKDAY" "0"
  ensure_env_default "WEEKLY_DIGEST_HOUR" "19"
  ensure_env_default "ANSWER_RETENTION_DAYS" "90"

  resolve_db_file
  log "Using DB file: $DB_FILE"

  mkdir -p "$BACKUP_DIR"
  if [[ -f "$DB_FILE" ]]; then
    local backup_file
    backup_file="$BACKUP_DIR/court-predeploy-$(date +%Y%m%d-%H%M%S).db"
    cp "$DB_FILE" "$backup_file"
    log "DB backup created: $backup_file"
  else
    log "No existing DB found; skipping backup copy."
  fi

  log "Installing/updating dependencies"
  "$PYTHON_BIN" -m pip install --upgrade pip
  "$PYTHON_BIN" -m pip install -r "$APP_DIR/requirements.txt"

  log "Compile check"
  "$PYTHON_BIN" -m py_compile "$APP_DIR/bot.py"

  run_migration_warmup

  if [[ "$RUN_LINT" == "1" ]]; then
    log "Running lint/type checks (RUN_LINT=1)"
    "$PYTHON_BIN" -m ruff check "$APP_DIR"
    "$PYTHON_BIN" -m mypy "$APP_DIR/bot.py" "$APP_DIR/courtbot"
  fi

  if [[ "$RUN_TESTS" == "1" ]]; then
    log "Running tests (RUN_TESTS=1)"
    "$PYTHON_BIN" -m pytest -q "$APP_DIR/tests"
  fi

  log "Reloading systemd units"
  sudo systemctl daemon-reload

  log "Restarting service"
  sudo systemctl restart "$SERVICE_NAME"

  if ! sudo systemctl is-active --quiet "$SERVICE_NAME"; then
    sudo journalctl -u "$SERVICE_NAME" -n 120 --no-pager || true
    fail "Service failed to become active: $SERVICE_NAME"
  fi

  verify_tables

  log "Service status"
  sudo systemctl status "$SERVICE_NAME" --no-pager --full

  log "Recent logs"
  sudo journalctl -u "$SERVICE_NAME" -n 80 --no-pager

  log "Done. If needed, follow logs live: sudo journalctl -u $SERVICE_NAME -f"
}

main "$@"
