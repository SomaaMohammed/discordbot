#!/usr/bin/env bash
set -Eeuo pipefail

# Unified operations entrypoint for Imperial Court Bot.
#
# Usage:
#   bash ./ops.sh deploy [branch]
#   bash ./ops.sh rollout
#   bash ./ops.sh backup
#   bash ./ops.sh restore /path/to/backup.db

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
TSBOT_DIR="${TSBOT_DIR:-$APP_DIR/tsbot}"
SERVICE_NAME="${SERVICE_NAME:-imperial-court-bot}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
REQUIRED_TABLES=(kv posts answers metrics anon_cooldowns)
SCOPE="ops"

usage() {
  cat <<'EOF'
Imperial Court Bot operations

Usage:
  bash ./ops.sh deploy [branch]       Pull branch and run rollout.
  bash ./ops.sh rollout               Install, build, validate, and restart service.
  bash ./ops.sh backup                Create a validated SQLite backup.
  bash ./ops.sh restore <backup.db>   Restore a validated SQLite backup.

Compatibility aliases:
  deploy-server, deploy-vm, post-pull, backup-db, restore-db

Common env options:
  APP_DIR=~/imperial-court-bot
  TSBOT_DIR=~/imperial-court-bot/tsbot
  SERVICE_NAME=imperial-court-bot
  RUN_TESTS=1
  RUN_TYPECHECK=1
  SKIP_PULL=1
  SKIP_SERVICE_RESTART=1

Backup/restore env options:
  DB_FILE=/path/to/court.db
  BACKUP_DIR=/path/to/backups
  KEEP_DAYS=14
  GCS_BUCKET=my-bucket
  BACKUP_BEFORE_RESTORE=1
  DRY_RUN=1
EOF
}

log() {
  echo "[$SCOPE] $*"
}

fail() {
  echo "[$SCOPE][error] $*" >&2
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

resolve_runtime_db_file() {
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

check_required_tables() {
  local sqlite_file="$1"
  local missing=()

  for table in "${REQUIRED_TABLES[@]}"; do
    local exists
    exists="$(sqlite3 "$sqlite_file" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='${table}';" 2>/dev/null || true)"
    if [[ "$exists" != "1" ]]; then
      missing+=("$table")
    fi
  done

  if (( ${#missing[@]} > 0 )); then
    fail "Validation failed; missing required tables: ${missing[*]}"
  fi
}

validate_sqlite_file() {
  local sqlite_file="$1"
  local quick_check
  quick_check="$(sqlite3 "$sqlite_file" "PRAGMA quick_check;" 2>/dev/null | tr -d '\r' || true)"

  if [[ "$quick_check" != "ok" ]]; then
    fail "SQLite quick_check failed for $sqlite_file (result: ${quick_check:-<empty>})"
  fi

  check_required_tables "$sqlite_file"
}

install_node_dependencies() {
  if [[ -f "$TSBOT_DIR/package-lock.json" ]]; then
    log "Installing dependencies with npm ci"
    npm ci
    return
  fi

  log "package-lock.json not found; using npm install"
  npm install
}

verify_tables_with_node() {
  if [[ ! -f "$DB_FILE" ]]; then
    log "No DB file found yet; skipping SQLite table check."
    return
  fi

  local tables
  if ! tables="$(
    cd "$TSBOT_DIR"
    DB_FILE="$DB_FILE" node <<'NODE'
const Database = require("better-sqlite3");

const dbFile = process.env.DB_FILE;
if (!dbFile) {
  process.exit(2);
}

const db = new Database(dbFile, { readonly: true });
const rows = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all();

process.stdout.write(rows.map((row) => row.name).join(" "));
NODE
  )"; then
    fail "Failed to read SQLite tables from $DB_FILE"
  fi

  log "SQLite tables in $DB_FILE: $tables"

  for table in "${REQUIRED_TABLES[@]}"; do
    if ! grep -Eq "(^|[[:space:]])${table}($|[[:space:]])" <<<"$tables"; then
      fail "Expected SQLite table not found after migration: $table"
    fi
  done

  log "SQLite table check passed (${REQUIRED_TABLES[*]})."
}

ensure_clean_or_handle_changes() {
  local local_changes_policy="$1"
  local dirty
  dirty="$(git status --porcelain)"
  if [[ -z "$dirty" ]]; then
    return
  fi

  log "Local git changes detected:"
  echo "$dirty"

  case "$local_changes_policy" in
    abort)
      fail "Working tree is not clean. Use LOCAL_CHANGES_POLICY=stash or discard to continue."
      ;;
    stash)
      local stash_name
      stash_name="deploy-autostash-$(date +%Y%m%d-%H%M%S)"
      git stash push --include-untracked -m "$stash_name" >/dev/null
      log "Stashed local changes as: $stash_name"
      ;;
    discard)
      log "Discarding local changes (destructive)"
      git reset --hard HEAD
      git clean -fd
      ;;
    *)
      fail "Invalid LOCAL_CHANGES_POLICY='$local_changes_policy' (expected: abort|stash|discard)"
      ;;
  esac
}

command_deploy() {
  SCOPE="deploy"

  local branch="${1:-${BRANCH:-main}}"
  local local_changes_policy="${LOCAL_CHANGES_POLICY:-abort}"
  local run_tests="${RUN_TESTS:-0}"
  local run_typecheck="${RUN_TYPECHECK:-${RUN_LINT:-0}}"
  local skip_pull="${SKIP_PULL:-0}"
  local skip_service_restart="${SKIP_SERVICE_RESTART:-0}"

  require_cmd git
  require_cmd bash
  require_file "$TSBOT_DIR/package.json"

  cd "$APP_DIR"

  log "App dir: $APP_DIR"
  log "TSBot dir: $TSBOT_DIR"
  log "Branch: $branch"
  log "Service: $SERVICE_NAME"
  log "Local changes policy: $local_changes_policy"

  if [[ "$skip_pull" != "1" ]]; then
    log "Validating git worktree"
    ensure_clean_or_handle_changes "$local_changes_policy"

    log "Fetching branch: $branch"
    git fetch origin "$branch"

    log "Pulling latest commit"
    git pull --ff-only origin "$branch"
  else
    log "SKIP_PULL=1 set, skipping git fetch/pull"
  fi

  log "Running rollout"
  RUN_TESTS="$run_tests" \
  RUN_TYPECHECK="$run_typecheck" \
  SKIP_SERVICE_RESTART="$skip_service_restart" \
  command_rollout

  SCOPE="deploy"
  log "Deployment finished successfully"
}

command_rollout() {
  SCOPE="rollout"

  local run_tests="${RUN_TESTS:-0}"
  local run_typecheck="${RUN_TYPECHECK:-${RUN_LINT:-0}}"
  local skip_service_restart="${SKIP_SERVICE_RESTART:-0}"

  if [[ "$skip_service_restart" != "1" ]]; then
    require_cmd sudo
  fi
  require_cmd node
  require_cmd npm
  require_cmd grep
  require_dir "$TSBOT_DIR"
  require_file "$TSBOT_DIR/package.json"
  require_file "$ENV_FILE"

  log "App dir: $APP_DIR"
  log "TSBot dir: $TSBOT_DIR"
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

  resolve_runtime_db_file
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

  (
    cd "$TSBOT_DIR"

    install_node_dependencies

    log "Building TypeScript bot"
    npm run build

    if [[ "$run_typecheck" == "1" ]]; then
      log "Running typecheck (RUN_TYPECHECK=1)"
      npm run typecheck
    fi

    if [[ "$run_tests" == "1" ]]; then
      log "Running tests (RUN_TESTS=1)"
      npm test
    fi
  )

  if [[ "$skip_service_restart" == "1" ]]; then
    log "SKIP_SERVICE_RESTART=1 set; skipping systemd restart/status checks"
    verify_tables_with_node
    log "Done. Build/validation completed without service restart."
    return
  fi

  log "Reloading systemd units"
  sudo systemctl daemon-reload

  log "Restarting service"
  sudo systemctl restart "$SERVICE_NAME"

  if ! sudo systemctl is-active --quiet "$SERVICE_NAME"; then
    sudo journalctl -u "$SERVICE_NAME" -n 120 --no-pager || true
    fail "Service failed to become active: $SERVICE_NAME"
  fi

  verify_tables_with_node

  log "Service status"
  sudo systemctl status "$SERVICE_NAME" --no-pager --full

  log "Recent logs"
  sudo journalctl -u "$SERVICE_NAME" -n 80 --no-pager

  log "Done. If needed, follow logs live: sudo journalctl -u $SERVICE_NAME -f"
}

command_backup() {
  SCOPE="backup"

  local db_file="${DB_FILE:-$APP_DIR/court.db}"
  local backup_dir="${BACKUP_DIR:-$APP_DIR/backups}"
  local keep_days="${KEEP_DAYS:-14}"
  local gcs_bucket="${GCS_BUCKET:-}"

  require_cmd sqlite3

  if [[ ! -f "$db_file" ]]; then
    fail "Database file not found: $db_file"
  fi

  mkdir -p "$backup_dir"
  chmod 700 "$backup_dir"

  local stamp
  local out_file
  stamp="$(date -u +%Y%m%d-%H%M%S)"
  out_file="$backup_dir/court-$stamp.db"

  sqlite3 "$db_file" ".timeout 5000" ".backup '$out_file'"
  validate_sqlite_file "$out_file"

  find "$backup_dir" -type f -name "court-*.db" -mtime "+$keep_days" -delete

  if [[ -n "$gcs_bucket" ]]; then
    if command -v gsutil >/dev/null 2>&1; then
      gsutil cp "$out_file" "gs://$gcs_bucket/"
    else
      log "gsutil is not installed; skipping upload to gs://$gcs_bucket"
    fi
  fi

  log "Backup created and validated: $out_file"
}

command_restore() {
  SCOPE="restore"

  local db_file="${DB_FILE:-$APP_DIR/court.db}"
  local backup_dir="${BACKUP_DIR:-$APP_DIR/backups}"
  local backup_before_restore="${BACKUP_BEFORE_RESTORE:-1}"
  local dry_run="${DRY_RUN:-0}"
  local source_backup="${1:-}"

  require_cmd sqlite3

  if [[ -z "$source_backup" ]]; then
    fail "Missing backup file path. Usage: bash ./ops.sh restore /path/to/backup.db"
  fi

  if [[ ! -f "$source_backup" ]]; then
    fail "Backup file does not exist: $source_backup"
  fi

  validate_sqlite_file "$source_backup"

  if [[ "$dry_run" == "1" ]]; then
    log "Validation successful. DRY_RUN=1, no restore was performed."
    return
  fi

  mkdir -p "$backup_dir"
  chmod 700 "$backup_dir"

  if [[ -f "$db_file" && "$backup_before_restore" == "1" ]]; then
    local stamp
    local pre_restore_backup
    stamp="$(date -u +%Y%m%d-%H%M%S)"
    pre_restore_backup="$backup_dir/court-prerestore-$stamp.db"
    cp "$db_file" "$pre_restore_backup"
    log "Pre-restore backup created: $pre_restore_backup"
  fi

  cp "$source_backup" "$db_file"
  validate_sqlite_file "$db_file"

  log "Restore complete and validated: $db_file"
}

main() {
  local command_name="${1:-help}"
  if [[ "$#" -gt 0 ]]; then
    shift
  fi

  case "$command_name" in
    help|-h|--help)
      usage
      ;;
    deploy|deploy-server|deploy-vm)
      command_deploy "$@"
      ;;
    rollout|post-pull|post-pull-server)
      command_rollout "$@"
      ;;
    backup|backup-db)
      command_backup "$@"
      ;;
    restore|restore-db)
      command_restore "$@"
      ;;
    *)
      usage >&2
      fail "Unknown command: $command_name"
      ;;
  esac
}

main "$@"
