#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Unified operations entrypoint for Imperial Court Bot v2.
#
# A rollout keeps the service offline while the shared database is backed up and
# migrated. It restarts the service only after database checks, typecheck, tests,
# build, and the compiled-entrypoint syntax check all succeed.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$SCRIPT_DIR}"
TSBOT_DIR="${TSBOT_DIR:-tsbot}"
SERVICE_NAME="${SERVICE_NAME:-imperial-court-bot}"
ENV_FILE="${ENV_FILE:-.env}"
BACKUP_DIR="${BACKUP_DIR:-backups}"
SCHEMA_VERSION=2
LEGACY_TABLES=(kv posts answers metrics anon_cooldowns)
CURRENT_TABLES=(schema_migrations guilds guild_settings kv posts answers metrics anon_cooldowns)
SCOPE="ops"

usage() {
  cat <<'EOF'
Imperial Court Bot operations

Usage:
  bash ./ops.sh deploy [branch]       Pull a branch and run the safe rollout.
  bash ./ops.sh rollout               Back up, migrate, validate, build, and restart.
  bash ./ops.sh validate [database]   Read-only database integrity/schema check.
  bash ./ops.sh backup                Create a SQLite-consistent validated backup.
  bash ./ops.sh restore <backup.db>   Restore a validated backup while offline.

Compatibility aliases:
  deploy-server, deploy-vm, post-pull, backup-db, restore-db

Common environment options:
  APP_DIR=/srv/imperial-court-bot
  TSBOT_DIR=/srv/imperial-court-bot/tsbot
  SERVICE_NAME=imperial-court-bot
  ENV_FILE=/srv/imperial-court-bot/.env
  BACKUP_DIR=/srv/imperial-court-bot/backups
  SKIP_PULL=1
  LOCAL_CHANGES_POLICY=abort|stash

Offline/local rollout options:
  SKIP_SERVICE_RESTART=1 OFFLINE_MIGRATION_CONFIRMED=1

Restore options:
  BACKUP_BEFORE_RESTORE=1
  SKIP_SERVICE_CHECK=1 OFFLINE_MIGRATION_CONFIRMED=1
  DRY_RUN=1

`SKIP_SERVICE_RESTART` and `SKIP_SERVICE_CHECK` are for an already-offline
database only. They never make an active-database migration safe.

`LOCAL_CHANGES_POLICY=stash` stashes tracked source changes only. The fetched
branch is merged with Git's ignored-file overwrite protection enabled, so
untracked and ignored operator files abort a conflicting deployment.
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

require_binary_flag() {
  local name="$1"
  local value="$2"
  [[ "$value" == "0" || "$value" == "1" ]] || fail "$name must be exactly 0 or 1"
}

require_supported_node() {
  local version
  local major
  local minor
  local patch
  version="$(node --eval 'process.stdout.write(process.versions.node)')" || fail "Unable to determine the Node.js version"
  IFS=. read -r major minor patch <<<"$version"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ && "$patch" =~ ^[0-9]+$ ]] || fail "Unable to determine the Node.js version"
  (( major > 22 || (major == 22 && minor >= 12) )) || fail "Node.js 22.12.0 or newer is required; found $version"
}

trim_boundary_whitespace() {
  TRIM_VALUE="$1" node --eval 'process.stdout.write(process.env.TRIM_VALUE.trim())'
}

restrict_live_database_permissions() {
  local database_file="$1"
  local sqlite_file

  for sqlite_file in \
    "$database_file" \
    "$database_file-wal" \
    "$database_file-shm" \
    "$database_file-journal"; do
    [[ ! -L "$sqlite_file" ]] || fail "Refusing to change permissions through a SQLite symbolic link"
    [[ -e "$sqlite_file" ]] || continue
    [[ -f "$sqlite_file" ]] || fail "SQLite live path is not a regular file"
    chmod 600 -- "$sqlite_file"
  done
}

prepare_operation_paths() {
  require_cmd realpath
  require_cmd node

  if [[ "$APP_DIR" != /* ]]; then
    APP_DIR="$(pwd)/$APP_DIR"
  fi
  APP_DIR="$(realpath -e -- "$APP_DIR")" || fail "APP_DIR must be an existing directory"

  if [[ "$TSBOT_DIR" != /* ]]; then
    TSBOT_DIR="$APP_DIR/$TSBOT_DIR"
  fi
  TSBOT_DIR="$(realpath -m -- "$TSBOT_DIR")"

  ENV_FILE="$(trim_boundary_whitespace "$ENV_FILE")"
  ENV_FILE="${ENV_FILE:-.env}"
  if [[ "$ENV_FILE" != /* ]]; then
    ENV_FILE="$APP_DIR/$ENV_FILE"
  fi
  ENV_FILE="$(realpath -m -- "$ENV_FILE")"

  if [[ "$BACKUP_DIR" != /* ]]; then
    BACKUP_DIR="$APP_DIR/$BACKUP_DIR"
  fi
  BACKUP_DIR="$(realpath -m -- "$BACKUP_DIR")"
}

read_config_value() {
  local key="$1"
  local value=""

  if [[ -v "$key" ]]; then
    printf '%s' "${!key}"
    return
  fi

  if [[ -f "$ENV_FILE" ]]; then
    value="$({
      cd "$TSBOT_DIR"
      CONFIG_KEY="$key" CONFIG_ENV_FILE="$ENV_FILE" node --eval '
        const fs = require("node:fs");
        const { parse } = require("dotenv");
        const parsed = parse(fs.readFileSync(process.env.CONFIG_ENV_FILE, "utf8"));
        process.stdout.write(parsed[process.env.CONFIG_KEY] ?? "");
      '
    })"
  fi

  printf '%s' "$value"
}

has_config_value() {
  local key="$1"
  [[ -n "$(read_config_value "$key")" ]]
}

validate_process_config() {
  (
    cd "$TSBOT_DIR"
    ENV_FILE="$ENV_FILE" npm run config:check
  )
}

resolve_runtime_db_file() {
  local configured_db

  if [[ ! -f "$ENV_FILE" && -z "${DB_FILE:-}" ]]; then
    fail "Cannot resolve DB_FILE because the selected environment file does not exist: $ENV_FILE"
  fi

  configured_db="$(trim_boundary_whitespace "$(read_config_value "DB_FILE")")"
  configured_db="${configured_db:-court.db}"

  if [[ "$configured_db" = /* ]]; then
    DB_FILE="$configured_db"
  else
    DB_FILE="$APP_DIR/$configured_db"
  fi

  validate_sqlite_cli_path "$DB_FILE"
  if [[ -e "$DB_FILE" ]]; then
    DB_FILE="$(realpath -e -- "$DB_FILE")"
  elif [[ -L "$DB_FILE" ]]; then
    fail "Configured database path is a broken symbolic link"
  else
    DB_FILE="$(realpath -m -- "$DB_FILE")"
  fi
}

validate_sqlite_cli_path() {
  local sqlite_path="$1"
  [[ "$sqlite_path" != *"'"* ]] || fail "SQLite paths containing a single quote are not supported by ops.sh"
  [[ "$sqlite_path" != *$'\n'* ]] || fail "SQLite paths containing a newline are not supported by ops.sh"
  [[ "$sqlite_path" != *$'\r'* ]] || fail "SQLite paths containing a carriage return are not supported by ops.sh"
}

canonical_existing_path() {
  local requested_path="$1"
  realpath -e -- "$requested_path" || fail "Path does not resolve to an existing file"
}

sqlite_scalar() {
  local sqlite_file="$1"
  local sql="$2"
  sqlite3 -readonly "$sqlite_file" "$sql" 2>/dev/null | tr -d '\r'
}

table_exists() {
  local sqlite_file="$1"
  local table="$2"
  [[ "$(sqlite_scalar "$sqlite_file" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='${table}';")" == "1" ]]
}

validate_integrity() {
  local sqlite_file="$1"
  local integrity_check
  integrity_check="$(sqlite_scalar "$sqlite_file" "PRAGMA integrity_check;")"
  [[ "$integrity_check" == "ok" ]] || fail "SQLite integrity_check failed for the selected database"
}

classify_schema() {
  local sqlite_file="$1"
  local table_count
  local table

  table_count="$(sqlite_scalar "$sqlite_file" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';")"
  if [[ "$table_count" == "0" ]]; then
    printf '%s' "empty"
    return
  fi

  if table_exists "$sqlite_file" "schema_migrations" || table_exists "$sqlite_file" "guilds" || table_exists "$sqlite_file" "guild_settings"; then
    printf '%s' "current-v2"
    return
  fi

  for table in "${LEGACY_TABLES[@]}"; do
    if ! table_exists "$sqlite_file" "$table"; then
      printf '%s' "unknown"
      return
    fi
  done

  printf '%s' "legacy-v1"
}

validate_primary_key() {
  local sqlite_file="$1"
  local table="$2"
  local expected="$3"
  local actual
  actual="$(sqlite_scalar "$sqlite_file" "SELECT group_concat(name, ',') FROM (SELECT name FROM pragma_table_info('${table}') WHERE pk > 0 ORDER BY pk);")"
  [[ "$actual" == "$expected" ]] || fail "Unexpected primary key for required v2 table: $table"
}

validate_guild_foreign_key() {
  local sqlite_file="$1"
  local table="$2"
  local count
  count="$(sqlite_scalar "$sqlite_file" "SELECT COUNT(*) FROM pragma_foreign_key_list('${table}') WHERE \"table\"='guilds' AND \"from\"='guild_id';")"
  [[ "$count" -ge 1 ]] || fail "Missing guild foreign key on required v2 table: $table"
}

validate_current_schema() {
  local sqlite_file="$1"
  local table
  local applied_version
  local foreign_key_errors

  for table in "${CURRENT_TABLES[@]}"; do
    table_exists "$sqlite_file" "$table" || fail "Missing required v2 table: $table"
  done

  applied_version="$(sqlite_scalar "$sqlite_file" "SELECT COALESCE(MAX(version), 0) FROM schema_migrations;")"
  [[ "$applied_version" == "$SCHEMA_VERSION" ]] || fail "Database is not at required schema version $SCHEMA_VERSION"

  validate_primary_key "$sqlite_file" "schema_migrations" "version"
  validate_primary_key "$sqlite_file" "guilds" "guild_id"
  validate_primary_key "$sqlite_file" "guild_settings" "guild_id"
  validate_primary_key "$sqlite_file" "kv" "guild_id,key"
  validate_primary_key "$sqlite_file" "posts" "guild_id,message_id"
  validate_primary_key "$sqlite_file" "answers" "guild_id,question_message_id,user_id"
  validate_primary_key "$sqlite_file" "metrics" "guild_id,metric_key"
  validate_primary_key "$sqlite_file" "anon_cooldowns" "guild_id,user_id"

  for table in guild_settings kv posts answers metrics anon_cooldowns; do
    validate_guild_foreign_key "$sqlite_file" "$table"
  done

  foreign_key_errors="$(sqlite3 -readonly "$sqlite_file" "PRAGMA foreign_keys=ON; PRAGMA foreign_key_check;" 2>/dev/null | tr -d '\r')"
  [[ -z "$foreign_key_errors" ]] || fail "SQLite foreign_key_check failed for the selected database"
}

validate_sqlite_database() {
  local sqlite_file="$1"
  local expected_kind="${2:-any}"
  local actual_kind
  local table

  require_file "$sqlite_file"
  validate_integrity "$sqlite_file"
  actual_kind="$(classify_schema "$sqlite_file")"

  if [[ "$expected_kind" != "any" && "$actual_kind" != "$expected_kind" ]]; then
    fail "Database schema classification changed unexpectedly"
  fi

  case "$actual_kind" in
    empty)
      ;;
    legacy-v1)
      for table in "${LEGACY_TABLES[@]}"; do
        table_exists "$sqlite_file" "$table" || fail "Missing required legacy table: $table"
      done
      ;;
    current-v2)
      validate_current_schema "$sqlite_file"
      ;;
    *)
      fail "Database schema is partial or unknown; refusing to continue"
      ;;
  esac

  printf '%s' "$actual_kind"
}

run_db_check() {
  local sqlite_file="$1"
  local require_current="${2:-0}"

  if [[ "$require_current" == "1" ]]; then
    (
      cd "$TSBOT_DIR"
      ENV_FILE="$ENV_FILE" DB_FILE="$sqlite_file" npm run db:check -- --require-current
    )
    return
  fi

  (
    cd "$TSBOT_DIR"
    ENV_FILE="$ENV_FILE" DB_FILE="$sqlite_file" npm run db:check
  )
}

compare_table_counts() {
  local source_file="$1"
  local backup_file="$2"
  local schema_kind="$3"
  local source_count
  local backup_count
  local table
  local tables=()

  case "$schema_kind" in
    legacy-v1)
      tables=("${LEGACY_TABLES[@]}")
      ;;
    current-v2)
      tables=("${CURRENT_TABLES[@]}")
      ;;
    empty)
      return
      ;;
    *)
      fail "Cannot compare row counts for an unknown schema"
      ;;
  esac

  for table in "${tables[@]}"; do
    source_count="$(sqlite_scalar "$source_file" "SELECT COUNT(*) FROM ${table};")"
    backup_count="$(sqlite_scalar "$backup_file" "SELECT COUNT(*) FROM ${table};")"
    [[ "$source_count" == "$backup_count" ]] || fail "Backup row-count verification failed for table: $table"
  done
}

create_validated_backup() {
  local source_file="$1"
  local filename_prefix="$2"
  local schema_kind="$3"
  local compare_counts="${4:-1}"
  local stamp
  local partial_file
  local final_file

  validate_sqlite_cli_path "$source_file"
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"

  stamp="$(date -u +%Y%m%d-%H%M%S)-$$"
  final_file="$BACKUP_DIR/${filename_prefix}-${stamp}.db"
  partial_file="${final_file}.partial"
  validate_sqlite_cli_path "$partial_file"
  [[ ! -e "$partial_file" && ! -e "$final_file" ]] || fail "Refusing to overwrite an existing backup path"

  sqlite3 -readonly "$source_file" ".timeout 5000" ".backup '$partial_file'"
  chmod 600 "$partial_file"
  validate_sqlite_database "$partial_file" "$schema_kind" >/dev/null
  if [[ "$schema_kind" != "empty" ]]; then
    run_db_check "$partial_file" "$([[ "$schema_kind" == "current-v2" ]] && echo 1 || echo 0)"
  fi
  if [[ "$compare_counts" == "1" ]]; then
    compare_table_counts "$source_file" "$partial_file" "$schema_kind"
  fi

  mv -n -- "$partial_file" "$final_file"
  [[ ! -e "$partial_file" && -f "$final_file" ]] || fail "Refusing to overwrite an existing backup path"
  log "SQLite-consistent backup created and validated: $final_file"
}

install_node_dependencies() {
  if [[ -f "$TSBOT_DIR/package-lock.json" ]]; then
    log "Installing locked dependencies with npm ci"
    (cd "$TSBOT_DIR" && npm ci)
    return
  fi

  log "package-lock.json not found; installing dependencies with npm install"
  (cd "$TSBOT_DIR" && npm install)
}

run_required_validation_suite() {
  (
    cd "$TSBOT_DIR"
    log "Running TypeScript typecheck"
    npm run typecheck

    log "Running full test suite with an isolated database and environment"
    local validation_directory
    local validation_environment
    validation_directory="$(mktemp -d "${TMPDIR:-/tmp}/imperial-court-validation.XXXXXX")"
    validation_environment="$validation_directory/validation.env"
    trap 'rm -rf -- "$validation_directory"' EXIT
    : >"$validation_environment"
    chmod 600 "$validation_environment"
    ENV_FILE="$validation_environment" \
      DISCORD_TOKEN="" \
      DB_FILE="$validation_directory/test.db" \
      npm test

    log "Building TypeScript runtime"
    npm run build

    require_file "$TSBOT_DIR/dist/src/index.js"
    log "Checking compiled entrypoint syntax"
    node --check "$TSBOT_DIR/dist/src/index.js"
  )
}

legacy_row_count() {
  local sqlite_file="$1"
  sqlite_scalar "$sqlite_file" "SELECT (SELECT COUNT(*) FROM kv) + (SELECT COUNT(*) FROM posts) + (SELECT COUNT(*) FROM answers) + (SELECT COUNT(*) FROM metrics) + (SELECT COUNT(*) FROM anon_cooldowns);"
}

require_legacy_migration_identity() {
  local sqlite_file="$1"
  local identity=""
  local identity_source=""
  local rows
  rows="$(legacy_row_count "$sqlite_file")"
  if [[ "$rows" -eq 0 ]]; then
    return
  fi

  if has_config_value "LEGACY_GUILD_ID"; then
    identity="$(read_config_value "LEGACY_GUILD_ID")"
    identity_source="LEGACY_GUILD_ID"
  elif has_config_value "TEST_GUILD_ID"; then
    identity="$(read_config_value "TEST_GUILD_ID")"
    identity_source="TEST_GUILD_ID"
  else
    fail "LEGACY_GUILD_ID is required because the legacy database contains rows"
  fi

  [[ "$identity" =~ ^[0-9]{17,20}$ ]] || fail "$identity_source must be one Discord snowflake"
  if [[ "$identity_source" == "TEST_GUILD_ID" ]]; then
    log "Using deprecated TEST_GUILD_ID migration fallback; replace it with LEGACY_GUILD_ID."
  else
    log "Legacy migration identity is configured; its value was not printed."
  fi
}

ensure_clean_or_handle_changes() {
  local local_changes_policy="$1"
  local dirty
  local tracked_dirty
  dirty="$(git status --porcelain)"
  if [[ -z "$dirty" ]]; then
    return
  fi

  log "Local git changes detected; values and ignored files are not displayed."
  case "$local_changes_policy" in
    abort)
      fail "Working tree is not clean. Commit changes or use LOCAL_CHANGES_POLICY=stash."
      ;;
    stash)
      local stash_name
      tracked_dirty="$(git status --porcelain --untracked-files=no)"
      if [[ -n "$tracked_dirty" ]]; then
        stash_name="deploy-autostash-$(date -u +%Y%m%d-%H%M%S)"
        git stash push -m "$stash_name" >/dev/null
        [[ -z "$(git status --porcelain --untracked-files=no)" ]] || fail "Tracked changes remain after the deployment stash"
        log "Tracked changes were stashed as $stash_name."
      else
        log "No tracked changes required stashing."
      fi
      if [[ -n "$(git status --porcelain)" ]]; then
        log "Untracked operator files were left untouched; the protected merge will abort if they conflict."
      fi
      ;;
    *)
      fail "LOCAL_CHANGES_POLICY must be abort or stash"
      ;;
  esac
}

fast_forward_fetched_branch() {
  git merge --ff-only --no-overwrite-ignore FETCH_HEAD ||
    fail "Fast-forward refused; resolve the branch state or move conflicting untracked/ignored files without deleting operator data"
}

stop_service_for_rollout() {
  local skip_service_restart="$1"

  if [[ "$skip_service_restart" == "1" ]]; then
    [[ "${OFFLINE_MIGRATION_CONFIRMED:-0}" == "1" ]] || fail "Set OFFLINE_MIGRATION_CONFIRMED=1 only after confirming the selected database is offline"
    log "Offline migration was explicitly confirmed; skipping systemd stop/restart."
    return
  fi

  require_cmd sudo
  require_loaded_service
  log "Stopping service before database backup and migration"
  sudo systemctl stop "$SERVICE_NAME"
  require_service_stopped
}

require_loaded_service() {
  local load_state
  [[ "$SERVICE_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9_.@:-]*$ ]] || fail "SERVICE_NAME contains unsupported characters"
  load_state="$(sudo systemctl show "$SERVICE_NAME" --property=LoadState --value)" || fail "Unable to inspect the configured systemd service"
  [[ "$load_state" == "loaded" ]] || fail "The configured systemd service is not loaded; verify SERVICE_NAME"
}

require_service_stopped() {
  local active_state
  require_cmd sudo
  require_loaded_service
  active_state="$(sudo systemctl show "$SERVICE_NAME" --property=ActiveState --value)" || fail "Unable to inspect the configured systemd service"
  case "$active_state" in
    inactive|failed)
      ;;
    *)
      fail "The configured systemd service is not fully stopped"
      ;;
  esac
}

command_deploy() {
  SCOPE="deploy"

  local branch="${1:-${BRANCH:-main}}"
  local local_changes_policy="${LOCAL_CHANGES_POLICY:-abort}"
  local skip_pull="${SKIP_PULL:-0}"

  require_binary_flag "SKIP_PULL" "$skip_pull"
  case "$local_changes_policy" in
    abort|stash)
      ;;
    *)
      fail "LOCAL_CHANGES_POLICY must be abort or stash"
      ;;
  esac
  require_cmd git
  require_cmd bash
  require_file "$TSBOT_DIR/package.json"

  cd "$APP_DIR"

  if [[ "$skip_pull" != "1" ]]; then
    log "Validating git worktree"
    ensure_clean_or_handle_changes "$local_changes_policy"

    git check-ref-format "refs/heads/$branch" >/dev/null || fail "Requested branch name is invalid"

    log "Fetching requested branch"
    git fetch --no-tags origin "refs/heads/$branch"

    log "Fast-forwarding the fetched branch with operator-file protection"
    fast_forward_fetched_branch
  else
    log "SKIP_PULL=1 set; using the current checkout"
  fi

  if [[ "$skip_pull" == "1" ]]; then
    log "Running safe rollout from the current checkout"
    command_rollout
  else
    log "Re-executing the newly checked-out operations script for safe rollout"
    export APP_DIR TSBOT_DIR ENV_FILE BACKUP_DIR SERVICE_NAME
    exec bash "$APP_DIR/ops.sh" rollout
  fi

  SCOPE="deploy"
  log "Deployment finished successfully"
}

command_rollout() {
  SCOPE="rollout"

  local skip_service_restart="${SKIP_SERVICE_RESTART:-0}"
  local pre_schema_kind="missing"
  local post_schema_kind

  require_binary_flag "SKIP_SERVICE_RESTART" "$skip_service_restart"
  require_binary_flag "OFFLINE_MIGRATION_CONFIRMED" "${OFFLINE_MIGRATION_CONFIRMED:-0}"
  require_cmd node
  require_supported_node
  require_cmd npm
  require_cmd sqlite3
  require_cmd mktemp
  require_dir "$TSBOT_DIR"
  require_file "$TSBOT_DIR/package.json"
  require_file "$ENV_FILE"

  # Install before downtime so config validation, the read-only checker, and
  # the migration CLI use the exact checked-in dependency set.
  install_node_dependencies
  validate_process_config
  resolve_runtime_db_file
  validate_sqlite_cli_path "$DB_FILE"
  require_dir "$(dirname "$DB_FILE")"

  stop_service_for_rollout "$skip_service_restart"

  if [[ -f "$DB_FILE" ]]; then
    restrict_live_database_permissions "$DB_FILE"
    log "Running read-only pre-migration database checks"
    pre_schema_kind="$(validate_sqlite_database "$DB_FILE")"
    if [[ "$pre_schema_kind" != "empty" ]]; then
      run_db_check "$DB_FILE" "$([[ "$pre_schema_kind" == "current-v2" ]] && echo 1 || echo 0)"
    fi
    if [[ "$pre_schema_kind" == "legacy-v1" ]]; then
      require_legacy_migration_identity "$DB_FILE"
    fi

    create_validated_backup "$DB_FILE" "court-pre-migration" "$pre_schema_kind"
  else
    log "No database exists at the configured path; migration will initialize schema v2."
  fi

  log "Running explicit transactional schema migration"
  (
    cd "$TSBOT_DIR"
    ENV_FILE="$ENV_FILE" DB_FILE="$DB_FILE" npm run migrate
  )
  restrict_live_database_permissions "$DB_FILE"

  log "Running read-only post-migration integrity and schema checks"
  post_schema_kind="$(validate_sqlite_database "$DB_FILE" "current-v2")"
  [[ "$post_schema_kind" == "current-v2" ]] || fail "Migration did not produce schema v2"
  run_db_check "$DB_FILE" 1

  run_required_validation_suite

  if [[ "$skip_service_restart" == "1" ]]; then
    log "Validation completed successfully; service restart was explicitly skipped."
    return
  fi

  log "Reloading systemd units"
  sudo systemctl daemon-reload

  log "Starting migrated release"
  sudo systemctl restart "$SERVICE_NAME"

  if ! sudo systemctl is-active --quiet "$SERVICE_NAME"; then
    sudo journalctl -u "$SERVICE_NAME" -n 120 --no-pager || true
    fail "Service failed to become active; keep the validated pre-migration backup for rollback"
  fi

  log "Service is active after successful migration and validation."
  sudo systemctl status "$SERVICE_NAME" --no-pager --full
  sudo journalctl -u "$SERVICE_NAME" -n 80 --no-pager
}

command_validate() {
  SCOPE="validate"

  local requested_file="${1:-}"
  local schema_kind

  require_cmd sqlite3
  require_cmd node
  require_supported_node
  require_cmd npm
  require_dir "$TSBOT_DIR"

  if [[ -n "$requested_file" ]]; then
    validate_sqlite_cli_path "$requested_file"
    DB_FILE="$(canonical_existing_path "$requested_file")"
  else
    resolve_runtime_db_file
  fi

  validate_sqlite_cli_path "$DB_FILE"
  schema_kind="$(validate_sqlite_database "$DB_FILE")"
  if [[ "$schema_kind" != "empty" ]]; then
    run_db_check "$DB_FILE" "$([[ "$schema_kind" == "current-v2" ]] && echo 1 || echo 0)"
  fi
  log "Read-only database validation passed for schema classification: $schema_kind"
}

command_backup() {
  SCOPE="backup"

  local schema_kind

  require_cmd sqlite3
  require_cmd node
  require_supported_node
  require_cmd npm
  require_dir "$TSBOT_DIR"
  resolve_runtime_db_file
  validate_sqlite_cli_path "$DB_FILE"
  require_file "$DB_FILE"

  schema_kind="$(validate_sqlite_database "$DB_FILE")"
  if [[ "$schema_kind" != "empty" ]]; then
    run_db_check "$DB_FILE" "$([[ "$schema_kind" == "current-v2" ]] && echo 1 || echo 0)"
  fi
  # SQLite's online backup API provides a transactionally consistent snapshot.
  # The live source may receive a write after that snapshot, so comparing it to
  # post-snapshot live counts would incorrectly reject a valid online backup.
  create_validated_backup "$DB_FILE" "court" "$schema_kind" 0
}

command_restore() {
  SCOPE="restore"

  local source_backup="${1:-}"
  local source_kind
  local restored_kind
  local backup_before_restore="${BACKUP_BEFORE_RESTORE:-1}"
  local skip_service_check="${SKIP_SERVICE_CHECK:-0}"
  local dry_run="${DRY_RUN:-0}"

  require_binary_flag "BACKUP_BEFORE_RESTORE" "$backup_before_restore"
  require_binary_flag "SKIP_SERVICE_CHECK" "$skip_service_check"
  require_binary_flag "DRY_RUN" "$dry_run"
  require_binary_flag "OFFLINE_MIGRATION_CONFIRMED" "${OFFLINE_MIGRATION_CONFIRMED:-0}"
  require_cmd sqlite3
  require_cmd node
  require_supported_node
  require_cmd npm
  require_dir "$TSBOT_DIR"

  [[ -n "$source_backup" ]] || fail "Missing backup path. Usage: bash ./ops.sh restore /path/to/backup.db"
  validate_sqlite_cli_path "$source_backup"
  source_backup="$(canonical_existing_path "$source_backup")"
  require_file "$source_backup"

  source_kind="$(validate_sqlite_database "$source_backup")"
  if [[ "$source_kind" != "empty" ]]; then
    run_db_check "$source_backup" "$([[ "$source_kind" == "current-v2" ]] && echo 1 || echo 0)"
  fi

  if [[ "$dry_run" == "1" ]]; then
    log "Source backup validation passed. DRY_RUN=1; no restore was performed."
    return
  fi

  if [[ "$skip_service_check" == "1" ]]; then
    [[ "${OFFLINE_MIGRATION_CONFIRMED:-0}" == "1" ]] || fail "Set OFFLINE_MIGRATION_CONFIRMED=1 only after confirming the selected database is offline"
  else
    require_service_stopped
  fi

  resolve_runtime_db_file
  validate_sqlite_cli_path "$DB_FILE"
  require_dir "$(dirname "$DB_FILE")"
  if [[ "$source_backup" == "$DB_FILE" ]]; then
    fail "The restore source and destination must be different files"
  fi

  if [[ -e "$DB_FILE" ]]; then
    restrict_live_database_permissions "$DB_FILE"
  fi

  if [[ -f "$DB_FILE" && "$backup_before_restore" == "1" ]]; then
    local existing_kind
    existing_kind="$(validate_sqlite_database "$DB_FILE")"
    create_validated_backup "$DB_FILE" "court-pre-restore" "$existing_kind"
  fi

  sqlite3 "$DB_FILE" ".timeout 5000" ".restore '$source_backup'"
  restrict_live_database_permissions "$DB_FILE"
  restored_kind="$(validate_sqlite_database "$DB_FILE" "$source_kind")"
  [[ "$restored_kind" == "$source_kind" ]] || fail "Restored schema does not match the source backup"
  compare_table_counts "$source_backup" "$DB_FILE" "$source_kind"
  if [[ "$restored_kind" != "empty" ]]; then
    run_db_check "$DB_FILE" "$([[ "$restored_kind" == "current-v2" ]] && echo 1 || echo 0)"
  fi

  log "Restore completed and passed integrity, schema, and row-count validation."
}

main() {
  local command_name="${1:-help}"
  if [[ "$#" -gt 0 ]]; then
    shift
  fi

  case "$command_name" in
    help|-h|--help)
      usage
      return
      ;;
    deploy|deploy-server|deploy-vm|rollout|post-pull|post-pull-server|validate|check-db|backup|backup-db|restore|restore-db)
      ;;
    *)
      usage >&2
      fail "Unknown command: $command_name"
      ;;
  esac

  prepare_operation_paths

  case "$command_name" in
    deploy|deploy-server|deploy-vm)
      command_deploy "$@"
      ;;
    rollout|post-pull|post-pull-server)
      command_rollout "$@"
      ;;
    validate|check-db)
      command_validate "$@"
      ;;
    backup|backup-db)
      command_backup "$@"
      ;;
    restore|restore-db)
      command_restore "$@"
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
