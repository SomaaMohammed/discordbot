#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
DB_FILE="${DB_FILE:-$APP_DIR/court.db}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
GCS_BUCKET="${GCS_BUCKET:-}"

mkdir -p "$BACKUP_DIR"

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 is required but not installed."
  exit 1
fi

STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_FILE="$BACKUP_DIR/court-$STAMP.db"

sqlite3 "$DB_FILE" ".timeout 5000" ".backup '$OUT_FILE'"

find "$BACKUP_DIR" -type f -name "court-*.db" -mtime "+$KEEP_DAYS" -delete

if [[ -n "$GCS_BUCKET" ]]; then
  if command -v gsutil >/dev/null 2>&1; then
    gsutil cp "$OUT_FILE" "gs://$GCS_BUCKET/"
  else
    echo "gsutil is not installed; skipping upload to gs://$GCS_BUCKET"
  fi
fi

echo "Backup created: $OUT_FILE"
