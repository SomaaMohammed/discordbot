# Operations

This runbook covers source deployments on Linux and the schema-v3 data lifecycle. Windows portable operation is covered separately in the [Windows guide](windows.md).

## Invariants

- Never print or commit `.env`, tokens, SQLite files/sidecars, or backups.
- Stop all writers before migration or release-level rollback.
- Back up and validate before changing a database.
- Normal startup never upgrades an existing schema.
- Never point development or tests at the live database.
- Keep database, sidecars, backups, environment files, and operation locks private to the service account.

`ops.sh` uses `umask 077`, a single-operation lock, exact schema validation, tracked-change guards, fast-forward-only rollout, and restrictive database permissions. Defaults are `superior.db`, `backups/`, and systemd service `superior-bot`; override selectors through the environment when an existing host uses different paths.

## Build and service commands

Run from the repository root:

```bash
./ops.sh status
./ops.sh logs
./ops.sh start
./ops.sh stop
./ops.sh restart
./ops.sh backup
./ops.sh rollout
```

`rollout` refuses a non-v3 database. It fast-forwards the selected branch, installs dependencies, runs formatting, typecheck, tests, and a clean build, validates and backs up an existing v3 database, then restarts the service. The default dirty-tree policy refuses tracked changes; `DIRTY_POLICY=stash` stashes tracked changes only and does not move ignored operator data.

An external checkout-directory or service rename is optional and is not performed by this repository. Update `APP_DIR`, `SERVICE_NAME`, the systemd unit, working directory, and environment paths together during a separately planned maintenance window.

## Fresh database

With no file at `DB_FILE`, startup creates schema v3 transactionally. An empty existing file is also eligible. If another database exists under an earlier default name while `DB_FILE` is unset, startup and operations refuse to create a second database; select the intended file explicitly and follow the upgrade workflow.

After first startup, run:

```bash
./ops.sh status
```

Then configure and enable each guild with `/setup`.

## Upgrade from schema v2

Build version 5.0.0 first, but do not start it against v2. A dry run performs classification and conversion checks without committing:

```bash
cd tsbot
npm ci
npm run build
node dist/src/storage/migrate-cli.js --db /absolute/path/to/superior.db --dry-run
cd ..
```

Run the guarded offline workflow:

```bash
DB_FILE=/absolute/path/to/superior.db ./ops.sh migrate-v2
```

The workflow validates exact schema v2, stops the service if active, creates and validates a private schema-v2 backup, runs an immediate transactional migration, validates exact schema v3 plus integrity and foreign keys, restricts file permissions, and restarts only if the service was previously active. An injected or real migration error rolls back the transaction, retains the validated backup, and leaves the service stopped because v5 cannot run against v2.

Migration preserves active guild metadata, safely convertible settings, greeting text without fixed member IDs, and supported metrics. It removes data that has no active v5 consumer. Unsafe or malformed settings become disabled and require review. Invocation branding is reset or sanitized. Migration refuses unresolved moderation-recovery metadata.

After migration:

```bash
./ops.sh status
./ops.sh start
./ops.sh logs
```

Review `/setup status` for every guild before enabling anything marked for review.

### Schema v1 boundary

Version 5.0.0 does not migrate schema v1. Upgrade that database with the final 4.0.0 release until it validates as schema v2, stop the old process, retain its validated backup, and only then follow the v2-to-v3 procedure above. Never rename an old database and assume that changes its schema.

## Backup and restore

Create a current backup with:

```bash
./ops.sh backup
```

The backup CLI uses SQLite's online backup API, refuses an existing destination, validates the expected schema, integrity, and foreign keys, and writes a private timestamped file.

Restore a v3 backup into a v5 deployment with:

```bash
./ops.sh restore backups/superior-schema3-YYYYMMDDTHHMMSSZ.db
```

Restore refuses the live database itself as a source, creates a consistent private candidate through SQLite's backup API, and validates it before stopping the service. It keeps the rollback directory on the database filesystem, moves the current database and sidecars there, installs the candidate atomically, validates again, restores the prior files on any installation failure, and restarts only when appropriate. Keep the rollback directory until application and guild checks pass.

Backups are not expired automatically. Define retention, encryption, off-host storage, access control, and verified deletion appropriate to the deployment. A pre-migration backup may contain data that is deliberately absent from schema v3; protect and expire it accordingly.

## Release rollback

Code and schema must remain compatible:

- To recover v5 while retaining schema v3, deploy a known-good v5 build and use `./ops.sh restore` with a validated v3 backup if data restoration is necessary.
- To return to a v4 build after v2-to-v3 migration, stop all writers, preserve the current v3 database separately, validate the pre-migration v2 backup, restore that backup with a controlled atomic file replacement, deploy the exact known-good v4 build and configuration, then start and verify it. The v5 `restore` command intentionally rejects v2, so this release-level rollback must use the documented host change procedure and the original validated backup.

Do not start v4 code against v3 or v5 code against v2.

## Verification checklist

- Service account owns `.env`, database, sidecars, backup directory, and lock.
- `./ops.sh status` reports schema 3 and integrity `ok`.
- `PRAGMA foreign_key_check` is empty through the checker.
- Only `schema_migrations`, `guilds`, `guild_settings`, and `metrics` exist, with `idx_guilds_enabled_left_at` as the sole explicit index.
- Every expected guild appears; inactive guilds remain disabled.
- `/setup status`, one private utility, and a deliberate addressed-chat request work in a test guild.
- Global command changes have finished propagating before stale definitions are treated as an incident.
- Logs contain no token, environment value, message content, or database content.
