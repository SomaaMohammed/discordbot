#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Superior operator helper. This script never logs environment values, tokens,
# database contents, or backup contents. Source it to test individual guards.

OPS_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
APP_DIR="${APP_DIR:-$OPS_ROOT}"
TSBOT_DIR="${TSBOT_DIR:-tsbot}"
ENV_FILE="${ENV_FILE:-.env}"
BACKUP_DIR="${BACKUP_DIR:-backups}"
SERVICE_NAME="${SERVICE_NAME:-superior-bot}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
DIRTY_POLICY="${DIRTY_POLICY:-refuse}"
LOCK_FILE="${LOCK_FILE:-.superior-ops.lock}"
DB_FILE_EXPLICIT=0
[[ -n "${DB_FILE+x}" ]] && DB_FILE_EXPLICIT=1

die() {
  printf 'error: %s\n' "$*" >&2
  return 1
}

note() {
  printf '%s\n' "$*"
}

trim_selector() {
  local value="${1//$'\u00a0'/ }"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

absolute_from() {
  local base="$1"
  local selected="$2"
  if [[ "$selected" = /* ]] || [[ "$selected" =~ ^[A-Za-z]:[/\\] ]]; then
    printf '%s' "$selected"
  else
    printf '%s/%s' "$base" "$selected"
  fi
}

prepare_operation_paths() {
  APP_DIR="$(cd -- "$APP_DIR" && pwd -P)"
  TSBOT_DIR="$(absolute_from "$APP_DIR" "$(trim_selector "$TSBOT_DIR")")"
  ENV_FILE="$(trim_selector "$ENV_FILE")"
  [[ -n "$ENV_FILE" ]] || ENV_FILE=.env
  ENV_FILE="$(absolute_from "$APP_DIR" "$ENV_FILE")"
  BACKUP_DIR="$(trim_selector "$BACKUP_DIR")"
  [[ -n "$BACKUP_DIR" ]] || BACKUP_DIR=backups
  BACKUP_DIR="$(absolute_from "$APP_DIR" "$BACKUP_DIR")"
  LOCK_FILE="$(trim_selector "$LOCK_FILE")"
  [[ -n "$LOCK_FILE" ]] || LOCK_FILE=.superior-ops.lock
  LOCK_FILE="$(absolute_from "$APP_DIR" "$LOCK_FILE")"
  [[ -d "$TSBOT_DIR" ]] || die "TypeScript application directory does not exist: $TSBOT_DIR"
}

read_db_selector_from_env() {
  local selected
  selected="$(
    awk '
      /^[[:space:]]*#/ { next }
      /^[[:space:]]*DB_FILE[[:space:]]*=/ {
        sub(/^[[:space:]]*DB_FILE[[:space:]]*=[[:space:]]*/, "")
        print
        exit
      }
    ' "$ENV_FILE"
  )"
  selected="$(trim_selector "$selected")"
  if [[ "$selected" =~ ^\".*\"$ ]] || [[ "$selected" =~ ^\'.*\'$ ]]; then
    selected="${selected:1:${#selected}-2}"
  fi
  printf '%s' "$selected"
}

refuse_stranded_legacy_database() {
  # The former default filename is referenced only as an upgrade safeguard.
  # It is never opened, renamed, or altered here.
  local old_default="$APP_DIR/court.db"
  if [[ -e "$old_default" ]]; then
    die "Refusing an implicit superior.db while a legacy-named database exists. Set DB_FILE explicitly, back it up, and run the documented upgrade to schema v5."
  fi
}

resolve_runtime_db_file() {
  local selected=""
  if (( DB_FILE_EXPLICIT == 1 )); then
    selected="$(trim_selector "${DB_FILE:-}")"
  else
    [[ -f "$ENV_FILE" ]] || die "Cannot resolve DB_FILE because the selected environment file does not exist: $ENV_FILE"
    selected="$(read_db_selector_from_env)"
  fi

  if [[ -z "$selected" ]]; then
    refuse_stranded_legacy_database
    selected=superior.db
  fi
  DB_FILE="$(absolute_from "$APP_DIR" "$selected")"
  export DB_FILE
}

require_supported_node() {
  local version
  version="$(node -p 'process.versions.node')"
  local major minor
  IFS=. read -r major minor _ <<<"$version"
  if (( major < 22 || (major == 22 && minor < 12) )); then
    die "Node.js 22.12.0 or newer is required; found $version"
  fi
}

restrict_live_database_permissions() {
  local database="$1"
  local candidate
  for candidate in "$database" "$database-wal" "$database-shm" "$database-journal"; do
    [[ -e "$candidate" ]] && chmod 600 -- "$candidate"
  done
}

acquire_operation_lock() {
  mkdir -p -- "$(dirname -- "$LOCK_FILE")"
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$LOCK_FILE"
    flock -n 9 || die "Another Superior operation is already running"
  else
    local lock_dir="${LOCK_FILE}.d"
    mkdir -- "$lock_dir" 2>/dev/null || die "Another Superior operation is already running"
    trap 'rmdir -- "${LOCK_FILE}.d" 2>/dev/null || true' EXIT
  fi
}

ensure_clean_or_handle_changes() {
  local policy="${1:-$DIRTY_POLICY}"
  git diff --quiet && git diff --cached --quiet && return 0
  case "$policy" in
    stash)
      git stash push -m "deploy-autostash-$(date -u +%Y%m%dT%H%M%SZ)"
      ;;
    refuse)
      die "Tracked source changes are present; commit them or rerun with DIRTY_POLICY=stash"
      ;;
    *)
      die "DIRTY_POLICY must be refuse or stash"
      ;;
  esac
}

fast_forward_fetched_branch() {
  local collisions
  collisions="$(
    git diff --name-only HEAD FETCH_HEAD -- 2>/dev/null |
      while IFS= read -r tracked_path; do
        [[ -n "$tracked_path" && -e "$tracked_path" ]] || continue
        git check-ignore -q -- "$tracked_path" && printf '%s\n' "$tracked_path"
      done
  )"
  [[ -z "$collisions" ]] || die "Fast-forward refused because fetched files would overwrite ignored operator data"
  git merge --ff-only --no-overwrite-ignore FETCH_HEAD
}

service_is_active() {
  command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$SERVICE_NAME"
}

stop_service() {
  command -v systemctl >/dev/null 2>&1 || die "systemctl is required for service operations"
  systemctl stop "$SERVICE_NAME"
}

start_service() {
  command -v systemctl >/dev/null 2>&1 || die "systemctl is required for service operations"
  systemctl start "$SERVICE_NAME"
}

restart_service() {
  command -v systemctl >/dev/null 2>&1 || die "systemctl is required for service operations"
  systemctl restart "$SERVICE_NAME"
}

ensure_production_build() {
  [[ -f "$TSBOT_DIR/dist/src/index.js" ]] || die "Production build is missing; run npm run build"
}

validate_database() {
  local database="$1"
  local expected="${2:-5}"
  node "$TSBOT_DIR/dist/src/storage/check-cli.js" --db "$database" --expect "$expected"
}

create_database_backup() {
  local expected="${1:-5}"
  [[ -f "$DB_FILE" ]] || die "Database does not exist: $DB_FILE"
  mkdir -p -- "$BACKUP_DIR"
  local destination
  destination="$BACKUP_DIR/superior-schema${expected}-$(date -u +%Y%m%dT%H%M%SZ).db"
  node "$TSBOT_DIR/dist/src/storage/backup-cli.js" \
    --db "$DB_FILE" --out "$destination" --expect "$expected"
  chmod 600 -- "$destination"
  validate_database "$destination" "$expected"
  note "Validated backup created: $destination"
}

migrate_database_to_v5() {
  local source_schema="${1:-4}"
  prepare_operation_paths
  resolve_runtime_db_file
  require_supported_node
  acquire_operation_lock
  ensure_production_build
  validate_database "$DB_FILE" "$source_schema"
  local was_active=0
  service_is_active && was_active=1
  (( was_active == 0 )) || stop_service
  restrict_live_database_permissions "$DB_FILE"
  create_database_backup "$source_schema"
  if ! node "$TSBOT_DIR/dist/src/storage/migrate-cli.js" --db "$DB_FILE"; then
    die "Migration failed and rolled back; the validated schema-v${source_schema} backup was retained and the service remains stopped"
    return 1
  fi
  validate_database "$DB_FILE" 5
  restrict_live_database_permissions "$DB_FILE"
  (( was_active == 0 )) || start_service
  note "Database migration completed and validated at schema 5"
}

restore_database() {
  local source="${1:-}"
  [[ -n "$source" ]] || {
    die "Usage: ops.sh restore <validated-schema5-backup>"
    return 1
  }
  prepare_operation_paths
  resolve_runtime_db_file
  require_supported_node
  acquire_operation_lock
  ensure_production_build
  source="$(absolute_from "$APP_DIR" "$source")"
  [[ -f "$source" ]] || {
    die "Restore source does not exist: $source"
    return 1
  }

  local db_dir candidate rollback_dir rejected_candidate was_active=0 had_live_main=0
  db_dir="$(dirname -- "$DB_FILE")"
  mkdir -p -- "$db_dir" "$BACKUP_DIR"
  candidate="$db_dir/.superior-restore.$$.partial"
  rollback_dir="$db_dir/.superior-rollback.$$.d"
  rejected_candidate="$rollback_dir/rejected-candidate.db"
  if [[ -e "$DB_FILE" && "$source" -ef "$DB_FILE" ]]; then
    die "Restore source must not be the live database; create and select a validated backup"
    return 1
  fi
  if [[ -e "$candidate" || -e "$rollback_dir" ]]; then
    die "Restore workspace already exists"
    return 1
  fi
  node "$TSBOT_DIR/dist/src/storage/backup-cli.js" \
    --db "$source" --out "$candidate" --expect 5
  chmod 600 -- "$candidate"
  validate_database "$candidate" 5 || {
    rm -f -- "$candidate"
    die "Restore source copy failed schema-v5 validation"
    return 1
  }

  service_is_active && was_active=1
  (( was_active == 0 )) || stop_service
  mkdir -- "$rollback_dir"
  [[ -e "$DB_FILE" ]] && had_live_main=1
  local install_failed=0 candidate_installed=0 index
  local -a live_parts=(
    "$DB_FILE"
    "$DB_FILE-wal"
    "$DB_FILE-shm"
    "$DB_FILE-journal"
  )
  local -a rollback_parts=(
    "$rollback_dir/original.db"
    "$rollback_dir/original.db-wal"
    "$rollback_dir/original.db-shm"
    "$rollback_dir/original.db-journal"
  )
  for index in "${!live_parts[@]}"; do
    if [[ -e "${live_parts[$index]}" ]] &&
      ! mv -- "${live_parts[$index]}" "${rollback_parts[$index]}"; then
      install_failed=1
      break
    fi
  done
  if (( install_failed == 0 )); then
    if mv -- "$candidate" "$DB_FILE"; then
      candidate_installed=1
    else
      install_failed=1
    fi
  fi
  if (( install_failed == 0 )) && ! validate_database "$DB_FILE" 5; then
    install_failed=1
  fi
  if (( install_failed == 1 )); then
    if (( candidate_installed == 1 )) && [[ -e "$DB_FILE" ]]; then
      mv -- "$DB_FILE" "$rejected_candidate" || true
    fi
    [[ ! -e "$candidate" ]] || rm -f -- "$candidate"
    local recovery_failed=0
    for index in "${!rollback_parts[@]}"; do
      [[ -e "${rollback_parts[$index]}" ]] || continue
      if ! mv -- "${rollback_parts[$index]}" "${live_parts[$index]}"; then
        recovery_failed=1
      fi
    done
    if (( had_live_main == 1 )) && ! validate_database "$DB_FILE" 5; then
      recovery_failed=1
    fi
    if (( recovery_failed == 1 )); then
      die "Restore failed and automatic recovery was incomplete; the service remains stopped and recovery files are in $rollback_dir"
      return 1
    fi
    (( was_active == 0 )) || start_service
    die "Restore failed; the previous database was restored"
    return 1
  fi
  restrict_live_database_permissions "$DB_FILE"
  (( was_active == 0 )) || start_service
  note "Database restored atomically; previous files remain recoverable in $rollback_dir"
}

rollout() {
  prepare_operation_paths
  resolve_runtime_db_file
  require_supported_node
  acquire_operation_lock
  cd -- "$APP_DIR"
  ensure_clean_or_handle_changes "$DIRTY_POLICY"
  git fetch --no-tags origin "refs/heads/$DEPLOY_BRANCH"
  fast_forward_fetched_branch
  cd -- "$TSBOT_DIR"
  npm ci
  npm run format:check
  npm run typecheck
  npm test
  npm run build
  cd -- "$APP_DIR"
  if [[ -f "$DB_FILE" ]]; then
    validate_database "$DB_FILE" 5 || die "Rollout refuses non-v5 data; use the explicit migration workflow first"
    restrict_live_database_permissions "$DB_FILE"
    create_database_backup 5
  fi
  restart_service
  note "Rollout completed"
}

show_status() {
  prepare_operation_paths
  resolve_runtime_db_file
  command -v systemctl >/dev/null 2>&1 && systemctl --no-pager status "$SERVICE_NAME" || true
  if [[ -f "$DB_FILE" && -f "$TSBOT_DIR/dist/src/storage/check-cli.js" ]]; then
    validate_database "$DB_FILE" 5
  else
    note "No schema-v5 database is currently available to validate."
  fi
}

show_logs() {
  command -v journalctl >/dev/null 2>&1 || die "journalctl is unavailable"
  journalctl -u "$SERVICE_NAME" -n "${LOG_LINES:-200}" --no-pager
}

usage() {
  cat <<'USAGE'
Usage: ./ops.sh <command>

  status                 Show service status and validate schema 5
  start|stop|restart     Control the configured systemd service
  logs                   Show recent service logs
  backup                 Create and validate a private schema-v5 backup
  restore <file>         Atomically restore a validated schema-v5 backup
  migrate-v5             Back up and transactionally migrate schema v4 to v5
  migrate-v3             Back up and transactionally migrate schema v3 to v5
  migrate-v2             Back up and transactionally migrate schema v2 to v5
  rollout                Fast-forward, validate, build, back up, and restart

Environment selectors: APP_DIR, TSBOT_DIR, ENV_FILE, DB_FILE, BACKUP_DIR,
SERVICE_NAME, DEPLOY_BRANCH, DIRTY_POLICY. Values and secrets are never logged.
USAGE
}

main() {
  local command="${1:-}"
  case "$command" in
    status) show_status ;;
    start) prepare_operation_paths; acquire_operation_lock; start_service ;;
    stop) prepare_operation_paths; acquire_operation_lock; stop_service ;;
    restart) prepare_operation_paths; acquire_operation_lock; restart_service ;;
    logs) show_logs ;;
    backup)
      prepare_operation_paths
      resolve_runtime_db_file
      require_supported_node
      acquire_operation_lock
      ensure_production_build
      create_database_backup 5
      ;;
    restore) shift; restore_database "${1:-}" ;;
    migrate-v5) migrate_database_to_v5 4 ;;
    migrate-v3) migrate_database_to_v5 3 ;;
    migrate-v2) migrate_database_to_v5 2 ;;
    rollout) rollout ;;
    help|-h|--help|"") usage ;;
    *) usage >&2; die "Unknown operation: $command" ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
