# Operations

This runbook covers source deployments on Linux and the schema-v4 data lifecycle. Windows portable operation is covered separately in the [Windows guide](windows.md).

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

`rollout` refuses a non-v4 database. It fast-forwards the selected branch, installs dependencies, runs formatting, typecheck, tests, and a clean build, validates and backs up an existing v4 database, then restarts the service. The default dirty-tree policy refuses tracked changes; `DIRTY_POLICY=stash` stashes tracked changes only and does not move ignored operator data.

An external checkout-directory or service rename is optional and is not performed by this repository. Update `APP_DIR`, `SERVICE_NAME`, the systemd unit, working directory, and environment paths together during a separately planned maintenance window.

## Fresh database

With no file at `DB_FILE`, startup creates schema v4 transactionally. An empty existing file is also eligible. If another database exists under an earlier default name while `DB_FILE` is unset, startup and operations refuse to create a second database; select the intended file explicitly and follow the upgrade workflow.

After first startup, run:

```bash
./ops.sh status
```

Then configure and enable each guild with `/setup`.

## Upgrade from schema v3

Schema v3 is the normal source for a 5.1.0 deployment. Build version 5.2.0 first, but do not start it against v3. A dry run performs exact classification and conversion checks without committing:

```bash
cd tsbot
npm ci
npm run build
node dist/src/storage/migrate-cli.js --db /absolute/path/to/superior.db --dry-run
cd ..
```

Run the guarded offline workflow from the repository root:

```bash
DB_FILE=/absolute/path/to/superior.db ./ops.sh migrate-v4
```

The workflow validates exact schema v3, stops the service if active, creates and validates a private schema-v3 backup, runs one immediate transaction, validates exact schema v4 plus integrity and foreign keys, restricts file permissions, and restarts only if the service was previously active. Existing guilds, settings, and metrics are preserved; the new ticket-configuration, posted-panel, ticket, and ticket-event tables start empty. A migration error rolls back the transaction, retains the validated backup, and leaves the service stopped.

## Upgrade from legacy schema v2

Version 5.2.0 can also convert the exact supported schema-v2 layout directly to v4. Build without starting the application, run the same migration CLI dry run shown above, then use:

```bash
DB_FILE=/absolute/path/to/superior.db ./ops.sh migrate-v2
```

This path validates and backs up exact v2 before the transactional conversion and validates exact v4 afterward. It preserves active guild metadata, safely convertible settings, greeting text without fixed member IDs, and supported metrics. It removes legacy data that has no active 5.2.0 consumer. Unsafe or malformed settings become disabled and require review; invocation branding is reset or sanitized; unresolved moderation-recovery metadata is refused.

After either migration:

```bash
./ops.sh status
./ops.sh logs
```

The migration command already restarts a service that was active before maintenance. Use `./ops.sh start` only if the service was intentionally stopped and should now run. Review `/setup status`, `/panel status`, and `/ticket status` for every guild before enabling or posting new workflows.

### Schema v1 boundary

Version 5.2.0 does not migrate schema v1. Upgrade that database with the final 4.0.0 release until it validates as schema v2, stop the old process, retain its validated backup, and then follow the legacy v2-to-v4 procedure above. Never rename an old database and assume that changes its schema.

## Backup and restore

Create a current backup with:

```bash
./ops.sh backup
```

The backup CLI uses SQLite's online backup API, refuses an existing destination, validates the expected schema, integrity, and foreign keys, and writes a private timestamped file.

Restore a v4 backup into a 5.2.0 deployment with:

```bash
./ops.sh restore backups/superior-schema4-YYYYMMDDTHHMMSSZ.db
```

Restore refuses the live database itself as a source, creates a consistent private candidate through SQLite's backup API, and validates it before stopping the service. It keeps the rollback directory on the database filesystem, moves the current database and sidecars there, installs the candidate atomically, validates again, restores the prior files on any installation failure, and restarts only when appropriate. Keep the rollback directory until application and guild checks pass.

Backups are not expired automatically. Define retention, encryption, off-host storage, access control, and verified deletion appropriate to the deployment. Schema-v4 backups can contain ticket subjects, descriptions, closure reasons, staff/user IDs, panel content, and lifecycle events. A pre-migration backup may contain other data that is deliberately absent from schema v4; protect and expire every generation accordingly.

## Guild export, import, and purge

The guild owner and Administrators can create a same-guild JSON export with `/setup export`. Only the guild owner can run the exact-confirmation `/setup import` and `/setup purge` workflows. Treat an import as a destructive live-data operation and retain a protected pre-import export or SQLite-aware operator backup when rollback may be required.

A validated format-3 import runs in one database transaction and replaces the guild's current settings, metrics, posted-panel records, ticket configuration, tickets, and ticket events. A legacy format-2 import replaces settings and metrics but deliberately preserves current panel and ticket operational rows. Either format leaves the guild disabled with configuration review required; imported ticket configuration is always disabled until the owner or an Administrator reviews current Discord resources and explicitly runs `/ticket setup`.

Import and purge affect only rows in the live database. They do not delete downloaded exports, operator backups, SQLite free pages, Discord-hosted panels or ticket channels, closure logs, direct messages, or other external copies. Apply separate retention and verified-deletion procedures to every such copy.

## Release rollback

Code and schema must remain compatible:

- To recover 5.2.0 while retaining schema v4, deploy a known-good 5.2.0 build and use `./ops.sh restore` with a validated v4 backup if data restoration is necessary.
- To return to 5.1.0 after a v3-to-v4 migration, stop all writers, preserve the current v4 database separately, validate the pre-migration v3 backup, restore that backup with a controlled atomic file replacement, deploy the exact known-good 5.1.0 build and configuration, then start and verify it.
- To return to a schema-v2 application after a direct v2-to-v4 migration, use the same release-level process with the original validated v2 backup and the exact compatible application generation.

The 5.2.0 `restore` command intentionally accepts only v4, so a release-level rollback to v3 or v2 cannot use it. Never start 5.2.0 against v3/v2 or an older build against v4.

## Verification checklist

- Service account owns `.env`, database, sidecars, backup directory, and lock.
- `./ops.sh status` reports schema 4 and integrity `ok`.
- `PRAGMA foreign_key_check` is empty through the checker.
- Exactly `schema_migrations`, `guilds`, `guild_settings`, `metrics`, `ticket_configurations`, `posted_panels`, `tickets`, and `ticket_events` exist.
- The explicit indexes are `idx_guilds_enabled_left_at`, `idx_posted_panels_guild_preset`, `idx_tickets_guild_opener_active`, `idx_tickets_guild_channel`, `idx_tickets_guild_state`, `idx_tickets_guild_close_log_message`, and `idx_ticket_events_ticket`; there are no application views or triggers.
- Every expected guild appears; inactive guilds remain disabled.
- `/setup status`, `/panel status`, `/ticket status`, one private utility, and a deliberate addressed-chat request work in a test guild. If tickets are enabled, test creation and closure in a disposable channel and confirm both the log attachment and channel cleanup.
- Global command changes have finished propagating before stale definitions are treated as an incident.
- Logs contain no token, environment value, message content, or database content.
