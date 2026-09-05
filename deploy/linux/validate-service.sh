#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Readiness/service validation. The only application commands invoked here are
# config-check, db:check, and doctor; the Discord entrypoint is never invoked.

INSTALL_ROOT="/opt/superior"
DATA_ROOT="/var/lib/superior"
BACKUP_ROOT="/var/backups/superior"
ENV_FILE="/etc/superior/superior.env"
SERVICE_NAME="superior.service"
BUN_PATH=""
HEALTH_ONLY=0

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
Usage: validate-service.sh [--health-only] [options]

Validates the current release, exact Bun version, environment-file presence,
configuration, schema-11 database health, and systemd state. It never logs in.
USAGE
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --health-only) HEALTH_ONLY=1 ;;
    --install-root) INSTALL_ROOT="$(take_value "$@")"; shift ;;
    --data-root) DATA_ROOT="$(take_value "$@")"; shift ;;
    --backup-root) BACKUP_ROOT="$(take_value "$@")"; shift ;;
    --env-file) ENV_FILE="$(take_value "$@")"; shift ;;
    --service-name) SERVICE_NAME="$(take_value "$@")"; shift ;;
    --bun) BUN_PATH="$(take_value "$@")"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

[[ "$(uname -s)" == "Linux" ]] || die "This validator only supports Linux"
[[ "$SERVICE_NAME" =~ ^[A-Za-z0-9_.@-]+\.service$ ]] || die "Invalid service name"
for value in "$INSTALL_ROOT" "$DATA_ROOT" "$BACKUP_ROOT" "$ENV_FILE"; do
  [[ "$value" =~ ^/[A-Za-z0-9._/@+-]+$ ]] ||
    die "Paths must be absolute and contain only safe Linux path characters"
done
for command_name in readlink systemctl; do
  command -v "$command_name" >/dev/null 2>&1 || die "Missing required command: $command_name"
done
[[ -n "$BUN_PATH" ]] || BUN_PATH="$INSTALL_ROOT/.bun/bin/bun"
[[ -x "$BUN_PATH" ]] || die "Bun executable is missing: $BUN_PATH"
[[ "$("$BUN_PATH" --version)" == "1.4.0" ]] || die "Expected Bun 1.4.0"
[[ -L "$INSTALL_ROOT/current" ]] || die "Current release is not a symlink"
current_root="$(readlink -f -- "$INSTALL_ROOT/current")"
[[ -d "$current_root" && "$current_root" == "$INSTALL_ROOT/releases/"* ]] ||
  die "Current release points outside the trusted release directory"
for cli in \
  "$current_root/tsbot/dist/src/index.js" \
  "$current_root/tsbot/dist/src/config-check-cli.js" \
  "$current_root/tsbot/dist/src/storage/check-cli.js" \
  "$current_root/tsbot/dist/src/storage/doctor-cli.js"; do
  [[ -f "$cli" ]] || die "Required compiled file is missing: $cli"
done
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || die "Environment file is missing or unsafe"
[[ -d "$DATA_ROOT" && ! -L "$DATA_ROOT" ]] || die "Data directory is missing or unsafe"
[[ -d "$BACKUP_ROOT" && ! -L "$BACKUP_ROOT" ]] || die "Backup directory is missing or unsafe"

export ENV_FILE SUPERIOR_APPLICATION_ROOT="$DATA_ROOT" SUPERIOR_RELEASE_ROOT="$INSTALL_ROOT/current" DB_FILE="$DATA_ROOT/superior.db" SUPERIOR_BACKUP_DIR="$BACKUP_ROOT"
"$BUN_PATH" --no-env-file "$current_root/tsbot/dist/src/config-check-cli.js"
[[ -f "$DB_FILE" ]] || die "Database is missing; readiness requires a migrated schema-11 database"
"$BUN_PATH" --no-env-file "$current_root/tsbot/dist/src/storage/check-cli.js" \
  --db "$DB_FILE" --expect 11
"$BUN_PATH" --no-env-file "$current_root/tsbot/dist/src/storage/doctor-cli.js" \
  --root "$DATA_ROOT" --db "$DB_FILE" --backup-dir "$BACKUP_ROOT" --json

if (( HEALTH_ONLY == 0 )); then
  systemctl is-enabled --quiet "$SERVICE_NAME" || die "Service is not enabled: $SERVICE_NAME"
  systemctl is-active --quiet "$SERVICE_NAME" || die "Service is not active: $SERVICE_NAME"
fi
printf 'Service validation succeeded; no Discord login was attempted.\n'
