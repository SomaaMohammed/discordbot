# Linux deployment guide

This is the production path for the Bun/`bun:sqlite` runtime. Windows portable packaging, `SuperiorBot.exe`, `Update.exe`, and Authenticode procedures remain documented in [Windows](windows.md) and are not used by this guide.

## Support boundary and architecture

Use a systemd-based Debian 12 or Ubuntu 24.04 x86_64 or arm64 host, a local ext4 or XFS filesystem, and one process per SQLite database. Do not put the database, WAL sidecars, or backup directory on NFS, SMB, a shared volume, or an eventually consistent filesystem.

Install the documented host packages:

```bash
sudo apt-get update
sudo apt-get install --yes bash ca-certificates curl git rsync sqlite3 systemd unzip util-linux
```

The deployment layout is intentionally split:

```text
/opt/superior/                         immutable installation root
/opt/superior/current -> releases/...  active release symlink
/opt/superior/releases/<version>/      retained release directories
/opt/superior/.bun/bin/bun             service-owned Bun 1.4.0 runtime
/var/lib/superior/superior.db         live SQLite database and sidecars
/var/backups/superior/                 validated SQLite backups
/etc/superior/superior.env             root-owned secret environment file
```

The `superior` service user owns mutable state. Releases are root-owned and readable by the service group. SQLite writes are single-process only; systemd restart/recovery and the deployment lock are the process-management boundary.

For a separate local ext4 or XFS filesystem, mount it before creating the
service layout and pass its state directories to the bootstrap and deployment
scripts. The generated unit includes `RequiresMountsFor` so systemd waits for
the filesystem before starting the bot:

```bash
sudo bash deploy/linux/install.sh \
  --data-root /srv/superior-storage/data \
  --backup-root /srv/superior-storage/backups
sudo bash deploy/linux/update.sh \
  --source /path/to/imperial-court-bot \
  --data-root /srv/superior-storage/data \
  --backup-root /srv/superior-storage/backups \
  --activate
sudo bash deploy/linux/validate-service.sh \
  --data-root /srv/superior-storage/data \
  --backup-root /srv/superior-storage/backups
```

## Bootstrap and Bun verification

From a Linux checkout of this repository, run the bootstrap as root. The flags that install packages and download Bun are explicit; without them the script only verifies prerequisites and refuses to guess.

```bash
sudo bash deploy/linux/install.sh --install-packages --install-bun --enable
sudo -u superior /opt/superior/.bun/bin/bun --version
```

The expected output is exactly `1.4.0`. The installer creates an empty environment file but never fills it and never starts the bot. Review the downloaded Bun installer and verify the final version before continuing. The project dependency lock must be installed with:

```bash
cd /path/to/imperial-court-bot/tsbot
/opt/superior/.bun/bin/bun install --frozen-lockfile
```

Do not copy Windows `node_modules`, `dist`, `.exe`, or `.db` files into a Linux release. Build and test on Linux, or transfer source and repeat the build there:

```bash
/opt/superior/.bun/bin/bun run format:check
/opt/superior/.bun/bin/bun run typecheck
/opt/superior/.bun/bin/bun run test
/opt/superior/.bun/bin/bun run build
```

## Secrets and configuration

Copy the example, then edit it without placing the token in shell history:

```bash
sudo install -o root -g superior -m 0640 deploy/linux/superior.env.example /etc/superior/superior.env.example
if ! sudo test -f /etc/superior/superior.env; then
  sudo install -o root -g superior -m 0640 /dev/null /etc/superior/superior.env
fi
sudoedit /etc/superior/superior.env
sudo chmod 0640 /etc/superior/superior.env
sudo chown root:superior /etc/superior/superior.env
```

Required secret:

- `DISCORD_TOKEN`: the bot token. Use a real value only in the protected file on the server; never commit it or print it.

Non-secret settings are `COMMAND_REGISTRATION_MODE=global` for production, optional `BOT_OPERATOR_IDS`, and `DEV_GUILD_IDS` only when using `guild` registration in development. The service unit pins `ENV_FILE`, `SUPERIOR_APPLICATION_ROOT`, `DB_FILE`, `SUPERIOR_BACKUP_DIR`, and `SUPERIOR_AUTO_MIGRATE=0` to absolute production paths. Do not override those paths in the environment file.

## Release, migration, and start

After the Linux build passes, stage a production-only release. Staging does not switch the active symlink or start the bot:

```bash
sudo bash deploy/linux/update.sh --source /path/to/imperial-court-bot
```

For a new installation, start only after the database and config checks pass. The bot creates a fresh current schema database on first start; for an existing v2–v10 database, use the explicit offline migration below before starting.

Offline migration is run while the service is stopped and never logs in to Discord:

```bash
sudo systemctl stop superior.service
sudo -u superior env ENV_FILE=/etc/superior/superior.env \
  /opt/superior/.bun/bin/bun --no-env-file \
  /opt/superior/current/tsbot/dist/src/storage/check-cli.js \
  --db /var/lib/superior/superior.db --expect 2
sudo -u superior /opt/superior/.bun/bin/bun --no-env-file \
  /opt/superior/current/tsbot/dist/src/storage/backup-cli.js \
  --db /var/lib/superior/superior.db \
  --out /var/backups/superior/pre-migration-$(date -u +%Y%m%dT%H%M%SZ).sqlite3 \
  --expect 2
sudo -u superior /opt/superior/.bun/bin/bun --no-env-file \
  /opt/superior/current/tsbot/dist/src/storage/migrate-cli.js \
  --db /var/lib/superior/superior.db
sudo -u superior /opt/superior/.bun/bin/bun --no-env-file \
  /opt/superior/current/tsbot/dist/src/storage/check-cli.js \
  --db /var/lib/superior/superior.db --expect 11
```

Replace `--expect 2` with the validated source schema (2 through 10). A failed migration leaves the source database unchanged and retains its backup. Do not enable `SUPERIOR_AUTO_MIGRATE` for production systemd.

Activate and start the release only after offline checks pass:

```bash
sudo bash deploy/linux/update.sh --source /path/to/imperial-court-bot --activate
sudo systemctl enable --now superior.service
sudo bash deploy/linux/validate-service.sh
```

`validate-service.sh` calls only `config-check`, `db:check`, and `doctor`; it never calls the Discord entrypoint. It is suitable for readiness probes and post-restart checks.

## Operations commands

All commands below use absolute paths and the unprivileged service account. They do not log in to Discord.

Doctor and health:

```bash
sudo bash deploy/linux/validate-service.sh --health-only
sudo -u superior /opt/superior/.bun/bin/bun --no-env-file \
  /opt/superior/current/tsbot/dist/src/storage/doctor-cli.js \
  --root /var/lib/superior --db /var/lib/superior/superior.db \
  --backup-dir /var/backups/superior --json
```

Backup, verification, checkpoint, and rotation:

```bash
backup=/var/backups/superior/manual-$(date -u +%Y%m%dT%H%M%SZ).sqlite3
sudo -u superior /opt/superior/.bun/bin/bun --no-env-file \
  /opt/superior/current/tsbot/dist/src/storage/backup-cli.js \
  --db /var/lib/superior/superior.db --out "$backup" --expect 11
sudo bash deploy/linux/verify-backup.sh --backup "$backup" --live-db /var/lib/superior/superior.db
sudo -u superior /opt/superior/.bun/bin/bun --no-env-file \
  /opt/superior/current/tsbot/dist/src/storage/checkpoint-cli.js \
  --db /var/lib/superior/superior.db --mode passive --json
sudo -u superior /opt/superior/.bun/bin/bun --no-env-file \
  /opt/superior/current/tsbot/dist/src/storage/backup-rotation-cli.js \
  --db /var/lib/superior/superior.db --backup-dir /var/backups/superior \
  --retention 7 --json
```

Exit status 2 from a passive checkpoint means readers pinned WAL frames; investigate active readers and retry a maintenance checkpoint. Never delete `.db-wal` or `.db-shm` manually while the bot is running.

Restore is explicit and stops the service. Prefer the guarded existing helper, which keeps a rollback directory and validates before/after installation:

```bash
sudo SERVICE_NAME=superior.service \
  APP_DIR=/opt/superior/current TSBOT_DIR=/opt/superior/current/tsbot \
  ENV_FILE=/etc/superior/superior.env DB_FILE=/var/lib/superior/superior.db \
  BACKUP_DIR=/var/backups/superior \
  bash ./ops.sh restore /var/backups/superior/<validated-schema11-backup>.sqlite3
sudo bash deploy/linux/validate-service.sh
```

The restore source must not be the live database and must validate as schema 11. Keep the generated rollback directory until the application and guild checks pass.

## Upgrade and rollback

An upgrade is: build/test on Linux, run `update.sh` without activation, review the staged release, activate, then validate.

```bash
sudo bash deploy/linux/update.sh --source /path/to/imperial-court-bot
sudo bash deploy/linux/update.sh --source /path/to/imperial-court-bot --activate
sudo journalctl -u superior.service -n 200 --no-pager
sudo bash deploy/linux/validate-service.sh
```

If the new release is unhealthy, the update script restores the previous active link when possible. A manual explicit rollback is:

```bash
sudo bash deploy/linux/update.sh rollback
sudo bash deploy/linux/rollback.sh
sudo bash deploy/linux/validate-service.sh
```

Rollback is application-only and must remain schema-compatible: after migration to schema 11, use another schema-11-capable release. Never start a pre-v11 executable against the live database.

## New-server migration

The portable unit of migration is a validated SQLite backup plus its sanitized
manifest. Do not copy a live `superior.db` while the service is running. WAL,
SHM, and journal files are SQLite coordination state, not independent backup
files. If they are present on the source, stop the service and let
`export.sh` checkpoint them before making the standalone backup.

On the old server, stage the destination directory on a local filesystem and
run the export as root. It validates the exact source schema, stops the
service, performs a truncate checkpoint, writes a no-clobber backup, and leaves
the service stopped:

```bash
sudo bash /path/to/repository/deploy/linux/export.sh \
  --out /var/backups/superior/migration-20260905.sqlite3 --expect 11
sudo bash /path/to/repository/deploy/linux/verify-backup.sh \
  --backup /var/backups/superior/migration-20260905.sqlite3
sha256sum /var/backups/superior/migration-20260905.sqlite3 \
  /var/backups/superior/migration-20260905.sqlite3.manifest
```

Transfer only the backup and manifest over an authenticated channel, then
verify the transferred hashes on the new server. Do not transfer `.env`,
`node_modules`, Windows artifacts, temporary files, or live SQLite sidecars.
The manifest contains versions, paths, schema, release identity, and required
environment variable names only; it contains no token, database rows,
hostname, IP address, username, or mount-specific identity.

Prepare the new host with the prerequisites and layout above, create a fresh
root-owned environment file, and install a Linux-built release. Before any
service start, verify the backup and import it into the empty data directory:

```bash
sudo bash deploy/linux/install.sh --install-packages --install-bun --enable
sudo install -o root -g superior -m 0640 deploy/linux/superior.env.example \
  /etc/superior/superior.env.example
sudo install -o root -g superior -m 0640 /dev/null /etc/superior/superior.env
sudoedit /etc/superior/superior.env
sudo bash deploy/linux/update.sh --source /path/to/linux-built/repository --activate --no-start
sudo bash deploy/linux/verify-backup.sh \
  --backup /transfer/migration-20260905.sqlite3
sudo bash deploy/linux/import.sh \
  --in /transfer/migration-20260905.sqlite3 \
  --target /var/lib/superior/superior.db
sudo bash deploy/linux/validate-service.sh --health-only
sudo systemctl enable --now superior.service
sudo bash deploy/linux/validate-service.sh
```

The import refuses an existing target or sidecar and never starts the service.
If a clean server has no release yet and you want a review pause, run
`update.sh` once without activation, review the staged directory, then rerun
with `--activate --no-start` before importing. Recreate the environment file
from names and policy; never copy production secrets in a repository archive.
Discord login is not needed for export, verification,
import, doctor, checkpoint, backup, restore, or service health validation.

## In-place OS/distribution upgrade

Before changing the OS, record the output of `doctor --json`,
`systemd-analyze verify`, `systemctl cat superior.service`, and
`validate-service.sh`. Create and verify an off-host schema-11 backup. Confirm
that `/opt/superior`, `/var/lib/superior`, `/var/backups/superior`, and
`/etc/superior/superior.env` are on filesystems that will survive the upgrade,
or copy them using the same stopped-service export/import procedure.

```bash
sudo bash deploy/linux/validate-service.sh
sudo bash deploy/linux/export.sh \
  --out /var/backups/superior/pre-os-upgrade-20260905.sqlite3
sudo bash deploy/linux/verify-backup.sh \
  --backup /var/backups/superior/pre-os-upgrade-20260905.sqlite3
sudo systemctl disable superior.service
```

Apply the distribution upgrade according to the OS provider's procedure. Do
not replace the service user, database directory, environment file, or active
release symlink merely because the hostname, IP, username, or mount layout
changed. After reboot, verify Bun's exact version and architecture, directory
ownership/modes, the unit, local filesystem type, free space, and database
integrity. Re-enable the unit only after offline checks pass:

```bash
sudo /opt/superior/.bun/bin/bun --version
sudo systemd-analyze verify /etc/systemd/system/superior.service
sudo bash deploy/linux/validate-service.sh --health-only
sudo systemctl enable --now superior.service
sudo bash deploy/linux/validate-service.sh
```

If the distribution upgrade changes libc, architecture, kernel, or filesystem
behavior in a way that fails the checks, keep the service stopped and migrate
the validated backup to a clean supported host. Never force-start a release
against an unvalidated database.

## Backup, restore, retention, and decommissioning

Run a validated backup at the desired schedule, keep at least seven local
generations unless policy requires more, and maintain encrypted off-host
copies with keys stored separately from the server. Test restore drills on a
disposable host at least quarterly and after schema changes. Rotation deletes
only managed, metadata-matching backups after a valid restore drill; it never
deletes the live database or unknown files.

```bash
sudo -u superior /opt/superior/.bun/bin/bun --no-env-file \
  /opt/superior/current/tsbot/dist/src/storage/backup-rotation-cli.js \
  --db /var/lib/superior/superior.db --backup-dir /var/backups/superior \
  --retention 7 --json
sudo bash deploy/linux/verify-backup.sh \
  --backup /var/backups/superior/<validated-schema11-backup>.sqlite3
sudo bash ops.sh restore /var/backups/superior/<validated-schema11-backup>.sqlite3
sudo bash deploy/linux/validate-service.sh
```

Keep the old server powered off but recoverable until the new service has
passed health, application, and guild-level checks and the first new-server
backup has been copied off-host. Revoke old host credentials, remove the
Discord token from the old environment file through secure deletion policy,
revoke unused firewall/DNS access, destroy encrypted disks or securely erase
data-bearing media, and retain only the approved encrypted backup and audit
record. Do not upload databases, `.env` files, or journal logs to a public
artifact store.

## Portability boundary

Portable: the validated standalone SQLite backup, its manifest, the
schema-compatible release source/lockfile, documented directory layout, and
configuration variable names. Server-specific: the real environment secret,
service account UID/GID, absolute installation/data/backup paths, systemd
unit instance, filesystem mounts, firewall/DNS records, host architecture,
kernel/libc, and current release symlink. The hostname, IP address, username,
mount points, and Discord login session are not part of application state.

## systemd, logs, limits, and permissions

The unit restarts on failure with a bounded burst, forwards SIGTERM for graceful shutdown, sets `TimeoutStopSec=30s`, and limits file descriptors, tasks, memory, and CPU. Bun's runtime needs executable memory in some builds, so `MemoryDenyWriteExecute` is intentionally not enabled; review the host's systemd hardening policy before adding it.

Useful checks:

```bash
sudo systemctl cat superior.service
sudo systemd-analyze verify /etc/systemd/system/superior.service
sudo systemd-analyze security superior.service
sudo systemctl status superior.service --no-pager
sudo journalctl -u superior.service -f
sudo namei -l /opt/superior/current/tsbot/dist/src/index.js
sudo stat -c '%A %U:%G %n' /etc/superior/superior.env /var/lib/superior /var/backups/superior
```

The environment file should be `root:superior` mode `0640` (or stricter), the database and sidecars should be service-owned mode `0600`, and backups should not be world-readable. A local filesystem with sufficient free space is required for `VACUUM INTO` and atomic publication. Monitor journal rate, restart loops, free space, backup verification, and the age of the last successful backup.

## Development, staging, production

- Development: use a separate checkout and database, `COMMAND_REGISTRATION_MODE=guild`, a test guild, and `bun run dev` only when an intentional Discord login is acceptable. Use the offline CLIs for SQLite work.
- Staging: use a separate service user, environment file, data root, backup root, and Discord application/guild. Run the full Linux install/build/test/upgrade/restore drill before production; do not share production SQLite or secrets.
- Production: use `superior.service`, global command registration, root-owned secrets, one process, immutable retained releases, validated off-host backups, and explicit offline migration. Do not run tests, development entrypoints, or old schema executables against production data.
