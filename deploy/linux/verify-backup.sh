#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Offline backup verification. This invokes only the database check CLI and
# never starts the bot or attempts a Discord login.

INSTALL_ROOT="/opt/superior"
BUN_PATH=""
BACKUP_FILE=""
EXPECTED_SCHEMA=11
LIVE_DATABASE=""

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

take_value() {
  [[ "$#" -ge 2 && -n "$2" ]] || die "Missing value for $1"
  printf '%s' "$2"
}

usage() {
  cat <<'USAGE'
Usage: verify-backup.sh --backup FILE [--live-db FILE] [--expect 11]

The backup must be a direct regular file. Verification checks the expected
schema, SQLite integrity, foreign keys, and WAL configuration through the
compiled offline check CLI.
USAGE
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --backup) BACKUP_FILE="$(take_value "$@")"; shift ;;
    --live-db) LIVE_DATABASE="$(take_value "$@")"; shift ;;
    --expect) EXPECTED_SCHEMA="$(take_value "$@")"; shift ;;
    --install-root) INSTALL_ROOT="$(take_value "$@")"; shift ;;
    --bun) BUN_PATH="$(take_value "$@")"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

[[ -n "$BACKUP_FILE" ]] || die "--backup is required"
[[ "$EXPECTED_SCHEMA" == "11" ]] || die "Only schema 11 backups are accepted by this verifier"
[[ "$(uname -s)" == "Linux" ]] || die "This verifier only supports Linux"
[[ "$INSTALL_ROOT" =~ ^/[A-Za-z0-9._/@+-]+$ ]] || die "Invalid install root"
[[ "$BACKUP_FILE" =~ ^/[A-Za-z0-9._/@+-]+$ ]] ||
  die "Backup path must be absolute and contain only safe Linux path characters"
if [[ -n "$LIVE_DATABASE" ]]; then
  [[ "$LIVE_DATABASE" =~ ^/[A-Za-z0-9._/@+-]+$ ]] ||
    die "Live database path must be absolute and contain only safe Linux path characters"
fi
[[ -n "$BUN_PATH" ]] || BUN_PATH="$INSTALL_ROOT/.bun/bin/bun"
[[ -x "$BUN_PATH" ]] || die "Bun executable is missing: $BUN_PATH"
[[ "$("$BUN_PATH" --version)" == "1.4.0" ]] || die "Expected Bun 1.4.0"
[[ -f "$BACKUP_FILE" && ! -L "$BACKUP_FILE" ]] || die "Backup is not a direct regular file: $BACKUP_FILE"
if [[ -n "$LIVE_DATABASE" && -e "$LIVE_DATABASE" && "$BACKUP_FILE" -ef "$LIVE_DATABASE" ]]; then
  die "Refusing to verify the live database as a backup"
fi
[[ ! -e "$BACKUP_FILE-wal" && ! -e "$BACKUP_FILE-shm" && ! -e "$BACKUP_FILE-journal" ]] ||
  die "Backup sidecars are present; verify the published backup instead"

check_cli="$INSTALL_ROOT/current/tsbot/dist/src/storage/check-cli.js"
[[ -f "$check_cli" ]] || die "Compiled database check CLI is missing: $check_cli"
"$BUN_PATH" --no-env-file "$check_cli" --db "$BACKUP_FILE" --expect "$EXPECTED_SCHEMA"
printf 'Backup verified offline: %s\n' "$BACKUP_FILE"
