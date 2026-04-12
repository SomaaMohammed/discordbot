#!/usr/bin/env bash
set -euo pipefail

# SQLite restore helper with pre-restore backup and validation.
#
# Usage:
#   chmod +x restore_db.sh
#   ./restore_db.sh /path/to/backup.db
#
# Optional env overrides:
#   DB_FILE=/path/to/court.db
#   BACKUP_DIR=/path/to/backups
#   BACKUP_BEFORE_RESTORE=1
#   DRY_RUN=0

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
DB_FILE="${DB_FILE:-$APP_DIR/court.db}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
BACKUP_BEFORE_RESTORE="${BACKUP_BEFORE_RESTORE:-1}"
DRY_RUN="${DRY_RUN:-0}"
REQUIRED_TABLES=(kv posts answers metrics anon_cooldowns)

fail() {
  echo "[restore-db][error] $*" >&2
  exit 1
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

if ! command -v sqlite3 >/dev/null 2>&1; then
  fail "sqlite3 is required but not installed"
fi

if [[ "$#" -lt 1 ]]; then
  fail "Missing backup file path. Usage: ./restore_db.sh /path/to/backup.db"
fi

SOURCE_BACKUP="$1"
if [[ ! -f "$SOURCE_BACKUP" ]]; then
  fail "Backup file does not exist: $SOURCE_BACKUP"
fi

validate_sqlite_file "$SOURCE_BACKUP"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "Validation successful. DRY_RUN=1, no restore was performed."
  exit 0
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

if [[ -f "$DB_FILE" && "$BACKUP_BEFORE_RESTORE" == "1" ]]; then
  STAMP="$(date -u +%Y%m%d-%H%M%S)"
  PRE_RESTORE_BACKUP="$BACKUP_DIR/court-prerestore-$STAMP.db"
  cp "$DB_FILE" "$PRE_RESTORE_BACKUP"
  echo "Pre-restore backup created: $PRE_RESTORE_BACKUP"
fi

cp "$SOURCE_BACKUP" "$DB_FILE"
validate_sqlite_file "$DB_FILE"

echo "Restore complete and validated: $DB_FILE"
