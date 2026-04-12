#!/usr/bin/env bash
set -euo pipefail

# SQLite backup helper with post-backup validation.
#
# Optional env overrides:
#   DB_FILE=/path/to/court.db
#   BACKUP_DIR=/path/to/backups
#   KEEP_DAYS=14
#   GCS_BUCKET=my-bucket

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
DB_FILE="${DB_FILE:-$APP_DIR/court.db}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
GCS_BUCKET="${GCS_BUCKET:-}"
REQUIRED_TABLES=(kv posts answers metrics anon_cooldowns)

fail() {
  echo "[backup-db][error] $*" >&2
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
    fail "Backup validation failed; missing required tables: ${missing[*]}"
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

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

if ! command -v sqlite3 >/dev/null 2>&1; then
  fail "sqlite3 is required but not installed."
fi

if [[ ! -f "$DB_FILE" ]]; then
  fail "Database file not found: $DB_FILE"
fi

STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_FILE="$BACKUP_DIR/court-$STAMP.db"

sqlite3 "$DB_FILE" ".timeout 5000" ".backup '$OUT_FILE'"
validate_sqlite_file "$OUT_FILE"

find "$BACKUP_DIR" -type f -name "court-*.db" -mtime "+$KEEP_DAYS" -delete

if [[ -n "$GCS_BUCKET" ]]; then
  if command -v gsutil >/dev/null 2>&1; then
    gsutil cp "$OUT_FILE" "gs://$GCS_BUCKET/"
  else
    echo "gsutil is not installed; skipping upload to gs://$GCS_BUCKET"
  fi
fi

echo "Backup created and validated: $OUT_FILE"
