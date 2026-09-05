#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Import a standalone, already-transferred SQLite backup into a clean data
# directory. It never overwrites a database, sidecar, environment file, or
# release, and it never starts the bot.

INSTALL_ROOT="/opt/superior"
DATA_ROOT="/var/lib/superior"
SERVICE_NAME="superior.service"
SERVICE_USER="superior"
SERVICE_GROUP="superior"
BUN_PATH=""
INPUT_FILE=""
TARGET_FILE=""
EXPECTED_SCHEMA="11"

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
Usage: import.sh --in FILE [options]

Validates a standalone schema-11 backup and installs it into the configured
data directory. The service must already be stopped; this command never starts
it and never reads or prints database contents.

Options:
  --in FILE              Absolute input backup path.
  --target FILE          Absolute target database path; default: DATA_ROOT/superior.db.
  --expect 11            Exact schema; default: 11.
  --install-root PATH    Default: /opt/superior.
  --data-root PATH       Default: /var/lib/superior.
  --service-name NAME    Default: superior.service.
  --service-user NAME    Default: superior.
  --service-group NAME   Default: superior.
  --bun PATH             Default: INSTALL_ROOT/.bun/bin/bun.
USAGE
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --in) INPUT_FILE="$(take_value "$@")"; shift ;;
    --target) TARGET_FILE="$(take_value "$@")"; shift ;;
    --expect) EXPECTED_SCHEMA="$(take_value "$@")"; shift ;;
    --install-root) INSTALL_ROOT="$(take_value "$@")"; shift ;;
    --data-root) DATA_ROOT="$(take_value "$@")"; shift ;;
    --service-name) SERVICE_NAME="$(take_value "$@")"; shift ;;
    --service-user) SERVICE_USER="$(take_value "$@")"; shift ;;
    --service-group) SERVICE_GROUP="$(take_value "$@")"; shift ;;
    --bun) BUN_PATH="$(take_value "$@")"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

[[ "$(uname -s)" == "Linux" ]] || die "This import script only supports Linux"
[[ "$(id -u)" -eq 0 ]] || die "Run as root"
[[ -n "$INPUT_FILE" ]] || die "--in is required"
[[ "$EXPECTED_SCHEMA" == "11" ]] || die "Only schema 11 imports are accepted"
[[ "$SERVICE_NAME" =~ ^[A-Za-z0-9_.@-]+\.service$ ]] || die "Invalid service name"
[[ "$SERVICE_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "Invalid service user"
[[ "$SERVICE_GROUP" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "Invalid service group"
for value in "$INSTALL_ROOT" "$DATA_ROOT" "$INPUT_FILE"; do
  [[ "$value" =~ ^/[A-Za-z0-9._/@+-]+$ ]] ||
    die "Paths must be absolute and contain only safe Linux path characters"
done

for command_name in chmod chown dirname getent id ln readlink systemctl; do
  command -v "$command_name" >/dev/null 2>&1 || die "Missing required command: $command_name"
done
[[ -n "$BUN_PATH" ]] || BUN_PATH="$INSTALL_ROOT/.bun/bin/bun"
[[ -x "$BUN_PATH" ]] || die "Bun executable is missing: $BUN_PATH"
[[ "$($BUN_PATH --version)" == "1.4.0" ]] || die "Expected Bun 1.4.0"
getent passwd "$SERVICE_USER" >/dev/null || die "Service user is missing: $SERVICE_USER"
getent group "$SERVICE_GROUP" >/dev/null || die "Service group is missing: $SERVICE_GROUP"

[[ -d "$INSTALL_ROOT" && ! -L "$INSTALL_ROOT" ]] || die "Install root is missing or unsafe"
[[ -d "$DATA_ROOT" && ! -L "$DATA_ROOT" ]] || die "Data root is missing or unsafe"
[[ -f "$INPUT_FILE" && ! -L "$INPUT_FILE" ]] || die "Input is not a direct regular file"
[[ ! -e "$INPUT_FILE-wal" && ! -e "$INPUT_FILE-shm" && ! -e "$INPUT_FILE-journal" ]] ||
  die "Input has SQLite sidecars; export a stopped database with export.sh"
if systemctl is-active --quiet "$SERVICE_NAME"; then
  die "Service is active; stop it before importing data"
fi

if [[ -z "$TARGET_FILE" ]]; then TARGET_FILE="$DATA_ROOT/superior.db"; fi
for value in "$TARGET_FILE"; do
  [[ "$value" =~ ^/[A-Za-z0-9._/@+-]+$ ]] ||
    die "Target path must be absolute and contain only safe Linux path characters"
done
TARGET_DIR="$(dirname -- "$TARGET_FILE")"
[[ -d "$TARGET_DIR" && ! -L "$TARGET_DIR" ]] || die "Target directory is missing or unsafe"
[[ ! -e "$TARGET_FILE" && ! -L "$TARGET_FILE" ]] || die "Refusing to overwrite target database"
for sidecar in "$TARGET_FILE-wal" "$TARGET_FILE-shm" "$TARGET_FILE-journal"; do
  [[ ! -e "$sidecar" && ! -L "$sidecar" ]] || die "Refusing to overwrite target sidecar: $sidecar"
done

CURRENT_ROOT="$(readlink -f -- "$INSTALL_ROOT/current")"
[[ -d "$CURRENT_ROOT" && "$CURRENT_ROOT" == "$INSTALL_ROOT/releases/"* ]] ||
  die "Current release points outside the trusted release directory"
CHECK_CLI="$CURRENT_ROOT/tsbot/dist/src/storage/check-cli.js"
BACKUP_CLI="$CURRENT_ROOT/tsbot/dist/src/storage/backup-cli.js"
[[ -f "$CHECK_CLI" && ! -L "$CHECK_CLI" ]] || die "Database check CLI is missing"
[[ -f "$BACKUP_CLI" && ! -L "$BACKUP_CLI" ]] || die "Database backup CLI is missing"

"$BUN_PATH" --no-env-file "$CHECK_CLI" --db "$INPUT_FILE" --expect 11
candidate="$TARGET_DIR/.superior-import.$$.sqlite3.partial"
[[ ! -e "$candidate" && ! -L "$candidate" ]] || die "Import temporary path already exists"
cleanup() {
  local status="$?"
  if [[ -e "$candidate" || -L "$candidate" ]]; then rm -f -- "$candidate"; fi
  exit "$status"
}
trap cleanup EXIT

"$BUN_PATH" --no-env-file "$BACKUP_CLI" \
  --db "$INPUT_FILE" --out "$candidate" --expect 11
chmod 0600 -- "$candidate"
chown "$SERVICE_USER":"$SERVICE_GROUP" -- "$candidate"
"$BUN_PATH" --no-env-file "$CHECK_CLI" --db "$candidate" --expect 11
[[ ! -e "$TARGET_FILE" && ! -L "$TARGET_FILE" ]] || die "Target database appeared during import; refusing to overwrite it"
ln -- "$candidate" "$TARGET_FILE"
rm -f -- "$candidate"
trap - EXIT
chmod 0600 -- "$TARGET_FILE"
chown "$SERVICE_USER":"$SERVICE_GROUP" -- "$TARGET_FILE"
"$BUN_PATH" --no-env-file "$CHECK_CLI" --db "$TARGET_FILE" --expect 11
printf 'Portable import verified: %s\nThe service remains stopped; validate before starting it.\n' "$TARGET_FILE"
