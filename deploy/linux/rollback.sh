#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Keep rollback as a separately discoverable operator command while retaining
# one implementation of the release-link and health-validation transaction.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec bash "$SCRIPT_DIR/update.sh" rollback "$@"
