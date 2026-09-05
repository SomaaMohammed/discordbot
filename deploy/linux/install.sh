#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Host bootstrap only. It creates missing directories and files, but never
# overwrites an environment file, release, current symlink, or service unit
# unless the corresponding explicit flag is supplied.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
INSTALL_ROOT="/opt/superior"
DATA_ROOT="/var/lib/superior"
BACKUP_ROOT="/var/backups/superior"
ENV_FILE="/etc/superior/superior.env"
SERVICE_USER="superior"
SERVICE_GROUP="superior"
SERVICE_NAME="superior.service"
INSTALL_PACKAGES=0
INSTALL_BUN=0
ENABLE_SERVICE=0
REPLACE_SERVICE=0

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: install.sh [options]

Creates the Linux host layout and installs the systemd unit. It does not copy
application code, create a database, populate secrets, or start the service.

Options:
  --install-packages       Install the documented Debian/Ubuntu packages.
  --install-bun            Download and install exactly Bun 1.4.0.
  --enable                 Enable the service after installing the unit.
  --replace-service        Replace an existing unit after an explicit review.
  --install-root PATH      Default: /opt/superior
  --data-root PATH         Default: /var/lib/superior
  --backup-root PATH       Default: /var/backups/superior
  --env-file PATH          Default: /etc/superior/superior.env
  --service-user NAME      Default: superior
  --service-group NAME     Default: superior
  --service-name NAME      Default: superior.service
USAGE
}

take_value() {
  [[ "$#" -ge 2 && -n "$2" ]] || die "Missing value for $1"
  printf '%s' "$2"
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --install-packages) INSTALL_PACKAGES=1 ;;
    --install-bun) INSTALL_BUN=1 ;;
    --enable) ENABLE_SERVICE=1 ;;
    --replace-service) REPLACE_SERVICE=1 ;;
    --install-root) INSTALL_ROOT="$(take_value "$@")"; shift ;;
    --data-root) DATA_ROOT="$(take_value "$@")"; shift ;;
    --backup-root) BACKUP_ROOT="$(take_value "$@")"; shift ;;
    --env-file) ENV_FILE="$(take_value "$@")"; shift ;;
    --service-user) SERVICE_USER="$(take_value "$@")"; shift ;;
    --service-group) SERVICE_GROUP="$(take_value "$@")"; shift ;;
    --service-name) SERVICE_NAME="$(take_value "$@")"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

[[ "$(uname -s)" == "Linux" ]] || die "This bootstrap script only supports Linux"
[[ "$(id -u)" -eq 0 ]] || die "Run as root, for example: sudo bash deploy/linux/install.sh"
case "$(uname -m)" in
  x86_64|aarch64|arm64) ;;
  *) die "Unsupported Linux architecture; use x86_64 or arm64" ;;
esac
libc_banner="$(ldd --version 2>&1 || true)"
[[ "$libc_banner" =~ [Gg][Ll][Ii][Bb][Cc] ]] ||
  die "A glibc-based Linux host is required; refusing an unverified libc"
[[ -n "$(uname -r)" ]] || die "The Linux kernel release could not be determined"

for value in "$INSTALL_ROOT" "$DATA_ROOT" "$BACKUP_ROOT" "$ENV_FILE"; do
  [[ "$value" =~ ^/[A-Za-z0-9._/@+-]+$ ]] ||
    die "Paths must be absolute and contain only safe Linux path characters"
done
[[ "$SERVICE_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "Invalid service user"
[[ "$SERVICE_GROUP" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "Invalid service group"
[[ "$SERVICE_NAME" =~ ^[A-Za-z0-9_.@-]+\.service$ ]] || die "Invalid service name"

if (( INSTALL_PACKAGES == 1 )); then
  command -v apt-get >/dev/null 2>&1 || die "--install-packages currently requires apt-get"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install --yes --no-install-recommends \
    bash ca-certificates curl git rsync sqlite3 systemd unzip util-linux
fi

required_commands=(
  getent groupadd install id ldd mkdir mktemp mv readlink rsync systemctl useradd
)
for command_name in "${required_commands[@]}"; do
  command -v "$command_name" >/dev/null 2>&1 ||
    die "Missing required command: $command_name (install documented packages or use --install-packages)"
done
if (( INSTALL_BUN == 1 )); then
  for command_name in curl unzip; do
    command -v "$command_name" >/dev/null 2>&1 ||
      die "Missing required command: $command_name (install documented packages or use --install-packages)"
  done
fi

for directory in "$INSTALL_ROOT" "$DATA_ROOT" "$BACKUP_ROOT" "$(dirname -- "$ENV_FILE")"; do
  [[ ! -L "$directory" ]] || die "Refusing to traverse a symlinked directory: $directory"
done

if ! getent group "$SERVICE_GROUP" >/dev/null; then
  groupadd --system "$SERVICE_GROUP"
fi
if ! getent passwd "$SERVICE_USER" >/dev/null; then
  useradd --system --home-dir "$INSTALL_ROOT" --no-create-home \
    --shell /usr/sbin/nologin --gid "$SERVICE_GROUP" "$SERVICE_USER"
fi
service_uid="$(id -u "$SERVICE_USER")"
[[ "$service_uid" != "0" ]] || die "The service user must not be root"
id -gn "$SERVICE_USER" >/dev/null 2>&1 || die "The service user has no usable primary group"

install -d -o root -g "$SERVICE_GROUP" -m 0750 "$INSTALL_ROOT"
install -d -o root -g "$SERVICE_GROUP" -m 0750 "$INSTALL_ROOT/releases"
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$INSTALL_ROOT/.bun"
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$DATA_ROOT"
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$BACKUP_ROOT"
install -d -o root -g "$SERVICE_GROUP" -m 0750 "$(dirname -- "$ENV_FILE")"

if [[ -e "$ENV_FILE" || -L "$ENV_FILE" ]]; then
  [[ ! -L "$ENV_FILE" ]] || die "Environment file must not be a symlink: $ENV_FILE"
  [[ -f "$ENV_FILE" ]] || die "Environment path is not a regular file: $ENV_FILE"
  chmod 0640 -- "$ENV_FILE"
  chown root:"$SERVICE_GROUP" -- "$ENV_FILE"
else
  install -o root -g "$SERVICE_GROUP" -m 0640 /dev/null "$ENV_FILE"
fi

BUN_PATH="$INSTALL_ROOT/.bun/bin/bun"
if (( INSTALL_BUN == 1 )); then
  [[ ! -e "$BUN_PATH" ]] || die "Bun already exists; verify it or remove it explicitly before reinstalling"
  bun_tmp="$(mktemp -d /tmp/superior-bun-install.XXXXXX)"
  bun_installer="$bun_tmp/install.sh"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --output "$bun_installer" https://bun.com/install
  BUN_INSTALL="$INSTALL_ROOT/.bun" bash "$bun_installer" bun-v1.4.0
  rm -f -- "$bun_installer"
  rmdir -- "$bun_tmp"
fi

[[ -x "$BUN_PATH" ]] || die "Bun 1.4.0 is not installed at $BUN_PATH; rerun with --install-bun"
[[ "$("$BUN_PATH" --version)" == "1.4.0" ]] ||
  die "Expected Bun 1.4.0 at $BUN_PATH"
chown -R "$SERVICE_USER":"$SERVICE_GROUP" -- "$INSTALL_ROOT/.bun"
chmod 0750 -- "$INSTALL_ROOT/.bun" "$INSTALL_ROOT/.bun/bin"

unit_path="/etc/systemd/system/$SERVICE_NAME"
[[ ! -e "$unit_path" && ! -L "$unit_path" ]] || (( REPLACE_SERVICE == 1 )) ||
  die "Service unit already exists; rerun with --replace-service after reviewing it"
unit_tmp="$(mktemp /etc/systemd/system/.superior-service.XXXXXX)"
sed \
  -e "s|@INSTALL_ROOT@|$INSTALL_ROOT|g" \
  -e "s|@DATA_ROOT@|$DATA_ROOT|g" \
  -e "s|@BACKUP_ROOT@|$BACKUP_ROOT|g" \
  -e "s|@ENV_FILE@|$ENV_FILE|g" \
  -e "s|@SERVICE_USER@|$SERVICE_USER|g" \
  -e "s|@SERVICE_GROUP@|$SERVICE_GROUP|g" \
  -e "s|@BUN_PATH@|$BUN_PATH|g" \
  "$SCRIPT_DIR/superior.service" > "$unit_tmp"
install -o root -g root -m 0644 "$unit_tmp" "$unit_path"
rm -f -- "$unit_tmp"
systemctl daemon-reload
if (( ENABLE_SERVICE == 1 )); then
  systemctl enable "$SERVICE_NAME"
fi

printf 'Linux layout prepared. Configure %s, deploy a release to %s/current, then validate before starting %s.\n' \
  "$ENV_FILE" "$INSTALL_ROOT" "$SERVICE_NAME"
