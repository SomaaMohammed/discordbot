#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Stage an immutable release, optionally activate it, and retain every older
# release. No release or database is deleted by this script.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DEFAULT_REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
INSTALL_ROOT="/opt/superior"
DATA_ROOT="/var/lib/superior"
BACKUP_ROOT="/var/backups/superior"
ENV_FILE="/etc/superior/superior.env"
SERVICE_NAME="superior.service"
SERVICE_GROUP="superior"
BUN_PATH=""
SOURCE_ROOT="$DEFAULT_REPO_ROOT"
ACTIVATE=0
START_SERVICE=1

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage:
  update.sh [--source REPOSITORY] [--activate]
  update.sh [--source REPOSITORY] --activate --no-start
  update.sh rollback

The source must already contain tsbot/dist/src/index.js, package.json, and
bun.lock. Build and test it on Linux first. Staging installs production-only
dependencies into a new release and never copies .env or Windows artifacts.
--activate atomically switches current, restarts systemd, and health-checks the
new release. --no-start switches current without starting systemd for a clean
server import. Older releases remain for rollback.
USAGE
}

take_value() {
  [[ "$#" -ge 2 && -n "$2" ]] || die "Missing value for $1"
  printf '%s' "$2"
}

MODE="deploy"
if [[ "${1:-}" == "rollback" ]]; then
  MODE="rollback"
  shift
fi
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --source) SOURCE_ROOT="$(take_value "$@")"; shift ;;
    --activate) ACTIVATE=1 ;;
    --no-start) START_SERVICE=0 ;;
    --install-root) INSTALL_ROOT="$(take_value "$@")"; shift ;;
    --data-root) DATA_ROOT="$(take_value "$@")"; shift ;;
    --backup-root) BACKUP_ROOT="$(take_value "$@")"; shift ;;
    --env-file) ENV_FILE="$(take_value "$@")"; shift ;;
    --service-name) SERVICE_NAME="$(take_value "$@")"; shift ;;
    --service-group) SERVICE_GROUP="$(take_value "$@")"; shift ;;
    --bun) BUN_PATH="$(take_value "$@")"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

(( ACTIVATE == 1 || START_SERVICE == 1 )) || die "--no-start requires --activate"

[[ "$(uname -s)" == "Linux" ]] || die "This deployment script only supports Linux"
[[ "$(id -u)" -eq 0 ]] || die "Run as root"
[[ "$SERVICE_NAME" =~ ^[A-Za-z0-9_.@-]+\.service$ ]] || die "Invalid service name"
[[ "$SERVICE_GROUP" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "Invalid service group"
for value in "$INSTALL_ROOT" "$DATA_ROOT" "$BACKUP_ROOT" "$ENV_FILE" "$SOURCE_ROOT"; do
  [[ "$value" =~ ^/[A-Za-z0-9._/@+-]+$ ]] ||
    die "Paths must be absolute and contain only safe Linux path characters"
done

for command_name in chown find install ln mv readlink rsync sed systemctl; do
  command -v "$command_name" >/dev/null 2>&1 || die "Missing required command: $command_name"
done
[[ -d "$INSTALL_ROOT/releases" && ! -L "$INSTALL_ROOT/releases" ]] ||
  die "Run install.sh first; release directory is missing or unsafe"
[[ -d "$DATA_ROOT" && ! -L "$DATA_ROOT" ]] || die "Data directory is missing or unsafe"
[[ -d "$BACKUP_ROOT" && ! -L "$BACKUP_ROOT" ]] || die "Backup directory is missing or unsafe"
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || die "Environment file is missing or unsafe"

if [[ -z "$BUN_PATH" ]]; then
  BUN_PATH="$INSTALL_ROOT/.bun/bin/bun"
fi
[[ -x "$BUN_PATH" ]] || die "Bun executable is missing: $BUN_PATH"
[[ "$("$BUN_PATH" --version)" == "1.4.0" ]] || die "Expected Bun 1.4.0"

assert_release_target() {
  local target="$1"
  [[ -d "$target" && ! -L "$target" ]] || die "Release target is not a direct directory: $target"
  case "$target" in
    "$INSTALL_ROOT/releases/"*) ;;
    *) die "Release target is outside the release directory: $target" ;;
  esac
}

atomic_link() {
  local target="$1"
  local link="$2"
  local temporary="$INSTALL_ROOT/.superior-link.$$.tmp"
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || die "Temporary link already exists: $temporary"
  ln -s -- "$target" "$temporary"
  mv -Tf -- "$temporary" "$link"
}

current_target() {
  local current="$INSTALL_ROOT/current"
  [[ -L "$current" ]] || die "Active release is not a symlink: $current"
  local target
  target="$(readlink -f -- "$current")"
  assert_release_target "$target"
  printf '%s' "$target"
}

read_version() {
  (cd -- "$SOURCE_ROOT/tsbot" && "$BUN_PATH" --no-env-file -e \
    'const p = JSON.parse(await Bun.file("package.json").text()); if (!/^\d+\.\d+\.\d+$/.test(String(p.version))) throw new Error("invalid package version"); console.log(p.version);')
}

validate_source() {
  [[ -d "$SOURCE_ROOT/tsbot" ]] || die "Source tsbot directory is missing: $SOURCE_ROOT/tsbot"
  [[ -f "$SOURCE_ROOT/tsbot/dist/src/index.js" ]] || die "Linux production build is missing; run bun run build"
  [[ -f "$SOURCE_ROOT/tsbot/package.json" ]] || die "package.json is missing"
  [[ -f "$SOURCE_ROOT/tsbot/bun.lock" ]] || die "bun.lock is missing"
  [[ ! -e "$SOURCE_ROOT/.env" ]] || printf 'warning: source contains .env; it will not be copied\n' >&2
  [[ -z "$(find "$SOURCE_ROOT/tsbot/dist" -type l -print -quit)" ]] ||
    die "The production build contains a symlink; refusing to copy it"
}

validate_database() {
  local database="$1"
  "$BUN_PATH" --no-env-file "$2/tsbot/dist/src/storage/check-cli.js" \
    --db "$database" --expect 11
}

rollback_release() {
  local current="$INSTALL_ROOT/current"
  local previous="$INSTALL_ROOT/.previous"
  local old_target next_target
  old_target="$(current_target)"
  [[ -L "$previous" ]] || die "No .previous release is available"
  next_target="$(readlink -f -- "$previous")"
  assert_release_target "$next_target"
  [[ "$next_target" != "$old_target" ]] || die "Previous release equals current release"
  systemctl stop "$SERVICE_NAME"
  atomic_link "$old_target" "$previous"
  atomic_link "$next_target" "$current"
  if ! systemctl start "$SERVICE_NAME"; then
    atomic_link "$next_target" "$previous"
    atomic_link "$old_target" "$current"
    systemctl start "$SERVICE_NAME" || true
    die "Rollback failed; the prior active link was restored"
  fi
  if ! "$SCRIPT_DIR/validate-service.sh" --health-only \
    --install-root "$INSTALL_ROOT" --data-root "$DATA_ROOT" \
    --backup-root "$BACKUP_ROOT" --env-file "$ENV_FILE" \
    --service-name "$SERVICE_NAME" --bun "$BUN_PATH"; then
    atomic_link "$next_target" "$previous"
    atomic_link "$old_target" "$current"
    systemctl restart "$SERVICE_NAME" || true
    die "Rollback health check failed; the prior active link was restored"
  fi
  printf 'Rollback completed to %s; the former release remains available at %s.\n' "$next_target" "$old_target"
}

if [[ "$MODE" == "rollback" ]]; then
  rollback_release
  exit 0
fi

validate_source
version="$(read_version)"
release_id="${version}-$(date -u +%Y%m%dT%H%M%SZ)-$$"
release_dir="$INSTALL_ROOT/releases/$release_id"
staging_dir="$INSTALL_ROOT/releases/.staging-$release_id"
[[ ! -e "$release_dir" && ! -L "$release_dir" ]] || die "Release already exists: $release_dir"
[[ ! -e "$staging_dir" && ! -L "$staging_dir" ]] || die "Staging directory already exists: $staging_dir"
mkdir -- "$staging_dir"
mkdir -- "$staging_dir/tsbot"
install -o root -g "$SERVICE_GROUP" -m 0640 "$SOURCE_ROOT/tsbot/package.json" "$staging_dir/tsbot/package.json"
install -o root -g "$SERVICE_GROUP" -m 0640 "$SOURCE_ROOT/tsbot/bun.lock" "$staging_dir/tsbot/bun.lock"
rsync -a --safe-links --delete "$SOURCE_ROOT/tsbot/dist/" "$staging_dir/tsbot/dist/"
find "$staging_dir" -type f -exec chmod 0640 -- {} +
find "$staging_dir" -type d -exec chmod 0750 -- {} +
chown -R root:"$SERVICE_GROUP" -- "$staging_dir"

(cd -- "$staging_dir/tsbot" && "$BUN_PATH" install --frozen-lockfile --production --no-progress)
[[ ! -e "$staging_dir/tsbot/node_modules/typescript" ]] ||
  die "Production install unexpectedly contains the TypeScript dev dependency"
[[ ! -e "$staging_dir/tsbot/node_modules/vitest" ]] ||
  die "Production install unexpectedly contains the Vitest dev dependency"
find "$staging_dir" -type f -exec chmod 0640 -- {} +
find "$staging_dir" -type d -exec chmod 0750 -- {} +
chown -R root:"$SERVICE_GROUP" -- "$staging_dir"
mv -- "$staging_dir" "$release_dir"
assert_release_target "$release_dir"

if [[ -f "$DATA_ROOT/superior.db" ]]; then
  validate_database "$DATA_ROOT/superior.db" "$release_dir"
  backup_name="predeploy-schema11-$(date -u +%Y%m%dT%H%M%SZ)-$$.sqlite3"
  "$BUN_PATH" --no-env-file "$release_dir/tsbot/dist/src/storage/backup-cli.js" \
    --db "$DATA_ROOT/superior.db" --out "$BACKUP_ROOT/$backup_name" --expect 11
  chmod 0640 -- "$BACKUP_ROOT/$backup_name"
fi

if (( ACTIVATE == 0 )); then
  printf 'Release staged at %s. Review it, then rerun with --activate to switch current.\n' "$release_dir"
  exit 0
fi

old_target=""
if [[ -L "$INSTALL_ROOT/current" ]]; then
  old_target="$(current_target)"
elif [[ -e "$INSTALL_ROOT/current" ]]; then
  die "Refusing to replace a non-symlink current path: $INSTALL_ROOT/current"
fi
[[ -z "$old_target" || "$old_target" != "$release_dir" ]] || die "New release is already active"
if [[ -n "$old_target" ]]; then
  atomic_link "$old_target" "$INSTALL_ROOT/.previous"
fi
atomic_link "$release_dir" "$INSTALL_ROOT/current"

if (( START_SERVICE == 0 )); then
  printf 'Release %s is active without starting %s. Import and validate data before starting the service.\n' \
    "$release_id" "$SERVICE_NAME"
  exit 0
fi

if ! systemctl restart "$SERVICE_NAME"; then
  if [[ -n "$old_target" ]]; then atomic_link "$old_target" "$INSTALL_ROOT/current"; fi
  die "Service restart failed; active link was restored when possible"
fi
if ! "$SCRIPT_DIR/validate-service.sh" --health-only \
  --install-root "$INSTALL_ROOT" --data-root "$DATA_ROOT" \
  --backup-root "$BACKUP_ROOT" --env-file "$ENV_FILE" \
  --service-name "$SERVICE_NAME" --bun "$BUN_PATH"; then
  if [[ -n "$old_target" ]]; then
    atomic_link "$old_target" "$INSTALL_ROOT/current"
    systemctl restart "$SERVICE_NAME" || true
  fi
  die "New release health check failed; active link was restored when possible"
fi
printf 'Release %s is active. Previous release remains available for rollback.\n' "$release_id"
