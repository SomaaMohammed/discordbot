#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Export a SQLite-aware, standalone migration artifact. The service is stopped
# first and remains stopped so this command never causes an implicit Discord
# login. It never copies a live database or its WAL sidecars.

INSTALL_ROOT="/opt/superior"
DATA_ROOT="/var/lib/superior"
SERVICE_NAME="superior.service"
BUN_PATH=""
OUTPUT_FILE=""
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
Usage: export.sh --out FILE [options]

Stops the service, truncates the SQLite WAL, creates a validated standalone
backup, and writes a sanitized manifest beside it. The service stays stopped;
start it only after the artifact has been transferred and verified.

Options:
  --out FILE             Absolute destination for the standalone backup.
  --expect 2..11         Exact source schema; default: 11.
  --install-root PATH    Default: /opt/superior.
  --data-root PATH       Default: /var/lib/superior.
  --service-name NAME    Default: superior.service.
  --bun PATH             Default: INSTALL_ROOT/.bun/bin/bun.
USAGE
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --out) OUTPUT_FILE="$(take_value "$@")"; shift ;;
    --expect) EXPECTED_SCHEMA="$(take_value "$@")"; shift ;;
    --install-root) INSTALL_ROOT="$(take_value "$@")"; shift ;;
    --data-root) DATA_ROOT="$(take_value "$@")"; shift ;;
    --service-name) SERVICE_NAME="$(take_value "$@")"; shift ;;
    --bun) BUN_PATH="$(take_value "$@")"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

[[ "$(uname -s)" == "Linux" ]] || die "This export script only supports Linux"
[[ "$(id -u)" -eq 0 ]] || die "Run as root"
[[ -n "$OUTPUT_FILE" ]] || die "--out is required"
[[ "$SERVICE_NAME" =~ ^[A-Za-z0-9_.@-]+\.service$ ]] || die "Invalid service name"
[[ "$EXPECTED_SCHEMA" =~ ^(2|3|4|5|6|7|8|9|10|11)$ ]] ||
  die "Expected schema must be an integer from 2 through 11"
for value in "$INSTALL_ROOT" "$DATA_ROOT" "$OUTPUT_FILE"; do
  [[ "$value" =~ ^/[A-Za-z0-9._/@+-]+$ ]] ||
    die "Paths must be absolute and contain only safe Linux path characters"
done

for command_name in awk chmod dirname id ln readlink sha256sum systemctl; do
  command -v "$command_name" >/dev/null 2>&1 || die "Missing required command: $command_name"
done
[[ -n "$BUN_PATH" ]] || BUN_PATH="$INSTALL_ROOT/.bun/bin/bun"
[[ -x "$BUN_PATH" ]] || die "Bun executable is missing: $BUN_PATH"
[[ "$($BUN_PATH --version)" == "1.4.0" ]] || die "Expected Bun 1.4.0"

[[ -d "$INSTALL_ROOT" && ! -L "$INSTALL_ROOT" ]] || die "Install root is missing or unsafe"
[[ -d "$DATA_ROOT" && ! -L "$DATA_ROOT" ]] || die "Data root is missing or unsafe"
[[ -L "$INSTALL_ROOT/current" ]] || die "Current release is not a symlink"
CURRENT_ROOT="$(readlink -f -- "$INSTALL_ROOT/current")"
[[ -d "$CURRENT_ROOT" && "$CURRENT_ROOT" == "$INSTALL_ROOT/releases/"* ]] ||
  die "Current release points outside the trusted release directory"
DB_FILE="$DATA_ROOT/superior.db"
CHECK_CLI="$CURRENT_ROOT/tsbot/dist/src/storage/check-cli.js"
CHECKPOINT_CLI="$CURRENT_ROOT/tsbot/dist/src/storage/checkpoint-cli.js"
BACKUP_CLI="$CURRENT_ROOT/tsbot/dist/src/storage/backup-cli.js"
for file_name in "$CHECK_CLI" "$CHECKPOINT_CLI" "$BACKUP_CLI"; do
  [[ -f "$file_name" && ! -L "$file_name" ]] || die "Required offline CLI is missing: $file_name"
done
[[ -f "$DB_FILE" && ! -L "$DB_FILE" ]] || die "Database is missing or unsafe: $DB_FILE"
OUTPUT_DIR="$(dirname -- "$OUTPUT_FILE")"
[[ -d "$OUTPUT_DIR" && ! -L "$OUTPUT_DIR" ]] || die "Output directory is missing or unsafe"
[[ ! -e "$OUTPUT_FILE" && ! -L "$OUTPUT_FILE" ]] || die "Refusing to overwrite export: $OUTPUT_FILE"
[[ ! -e "$OUTPUT_FILE-wal" && ! -e "$OUTPUT_FILE-shm" && ! -e "$OUTPUT_FILE-journal" ]] ||
  die "Refusing to overwrite export sidecar"

# The source schema is checked before stopping so a bad selector cannot cause
# an unnecessary outage. A second check follows the checkpoint.
"$BUN_PATH" --no-env-file "$CHECK_CLI" --db "$DB_FILE" --expect "$EXPECTED_SCHEMA"
if systemctl is-active --quiet "$SERVICE_NAME"; then
  systemctl stop "$SERVICE_NAME"
fi

"$BUN_PATH" --no-env-file "$CHECKPOINT_CLI" \
  --db "$DB_FILE" --mode truncate --json
"$BUN_PATH" --no-env-file "$CHECK_CLI" --db "$DB_FILE" --expect "$EXPECTED_SCHEMA"
"$BUN_PATH" --no-env-file "$BACKUP_CLI" \
  --db "$DB_FILE" --out "$OUTPUT_FILE" --expect "$EXPECTED_SCHEMA"
[[ -f "$OUTPUT_FILE" && ! -L "$OUTPUT_FILE" ]] || die "Backup was not published"
[[ ! -e "$OUTPUT_FILE-wal" && ! -e "$OUTPUT_FILE-shm" && ! -e "$OUTPUT_FILE-journal" ]] ||
  die "Backup unexpectedly has SQLite sidecars"
chmod 0600 -- "$OUTPUT_FILE"

release_root="$CURRENT_ROOT/tsbot"
[[ -f "$release_root/package.json" && -f "$release_root/bun.lock" ]] ||
  die "Current release metadata is incomplete"
release_identity="$(
  cd -- "$release_root"
  sha256sum package.json bun.lock dist/src/index.js | sha256sum | awk '{print $1}'
)"
application_version="$(cd -- "$release_root" && "$BUN_PATH" --no-env-file -e 'const p = JSON.parse(await Bun.file("package.json").text()); console.log(String(p.version));')"
bun_revision="$($BUN_PATH --no-env-file -e 'console.log(Bun.revision)')"
sqlite_version="$($BUN_PATH --no-env-file -e 'const { Database } = await import("bun:sqlite"); const d = new Database(":memory:"); console.log(d.query("SELECT sqlite_version() AS version").get().version); d.close();')"
manifest_file="${OUTPUT_FILE}.manifest"
manifest_tmp="${manifest_file}.partial.$$"
[[ ! -e "$manifest_file" && ! -L "$manifest_file" ]] || die "Refusing to overwrite export manifest: $manifest_file"
[[ ! -e "$manifest_tmp" && ! -L "$manifest_tmp" ]] || die "Manifest temporary path already exists"
cleanup() {
  local status="$?"
  if [[ -n "${manifest_tmp:-}" && ( -e "$manifest_tmp" || -L "$manifest_tmp" ) ]]; then
    rm -f -- "$manifest_tmp"
  fi
  exit "$status"
}
trap cleanup EXIT
{
  printf 'format_version=1\n'
  printf 'application_version=%s\n' "$application_version"
  printf 'bun_version=1.4.0\n'
  printf 'bun_revision=%s\n' "$bun_revision"
  printf 'sqlite_backend=bun:sqlite\n'
  printf 'sqlite_version=%s\n' "$sqlite_version"
  printf 'database_schema=%s\n' "$EXPECTED_SCHEMA"
  printf 'database_path=%s\n' "$DB_FILE"
  printf 'backup_path=%s\n' "$OUTPUT_FILE"
  printf 'release_identity_sha256=%s\n' "$release_identity"
  printf 'required_environment_variables=DISCORD_TOKEN\n'
  printf 'filesystem_requirement=local-ext4-or-xfs\n'
  printf 'service_name=%s\n' "$SERVICE_NAME"
  printf 'discord_login_attempted=false\n'
  printf 'secrets_included=false\n'
} > "$manifest_tmp"
chmod 0600 -- "$manifest_tmp"
ln -- "$manifest_tmp" "$manifest_file"
rm -f -- "$manifest_tmp"
trap - EXIT

printf 'Portable export verified: %s\nManifest: %s\nThe service remains stopped.\n' \
  "$OUTPUT_FILE" "$manifest_file"
