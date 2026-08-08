# Operations

This runbook covers source deployments on Linux and the schema-v5 data lifecycle. Windows portable operation is covered in the [Windows guide](windows.md).

## Invariants

- Never print or commit `.env`, tokens, SQLite files/sidecars, exports, or backups.
- Run only one Superior writer process for a database. Shared-file multi-process SQLite operation is unsupported.
- Stop every writer before migration or release-level rollback.
- Back up and validate before changing a database.
- Normal startup never upgrades an existing schema.
- Never point development, tests, or ad hoc SQLite tools at the live database.
- Keep database, sidecars, backups, environment files, operation locks, application answers, suggestion text, and ticket transcripts private to appropriately authorized people.

`ops.sh` uses `umask 077`, a single-operation lock, exact schema validation, tracked-change guards, fast-forward-only rollout, and restrictive database permissions. Defaults are `superior.db`, `backups/`, and systemd service `superior-bot`; override selectors through the environment when a host uses different paths.

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

`rollout` refuses a non-v5 database. It fast-forwards the selected branch, installs dependencies, runs formatting, typecheck, tests, and a clean build, validates and backs up an existing v5 database, then restarts the service. The default dirty-tree policy refuses tracked changes; `DIRTY_POLICY=stash` stashes tracked changes only and does not move ignored operator data.

An external checkout-directory or service rename is not performed by this repository. Update `APP_DIR`, `SERVICE_NAME`, the systemd unit, working directory, and environment paths together during a separately planned maintenance window.

## Fresh database

With no file at `DB_FILE`, startup creates schema v5 transactionally. An empty existing file is also eligible. If another database exists under an earlier default name while `DB_FILE` is unset, startup and operations refuse to create a second database; select the intended file explicitly and follow the upgrade workflow.

After first startup, run:

```bash
./ops.sh status
```

Then configure and enable each guild with `/setup`. Operational services remain unavailable until their Discord bindings are configured and verified.

## Required offline migration from schema v4

Schema v4 is the normal source for a 5.2.0/5.2.1 deployment. Build 5.3.0 first, but do not start it against v4. Confirm that all processes and maintenance sessions that can write the selected file will be stopped. A dry run performs exact schema classification and the complete conversion in a transaction that is deliberately rolled back:

```bash
cd tsbot
npm ci
npm run build
node dist/src/storage/check-cli.js --db /absolute/path/to/superior.db --expect 4
node dist/src/storage/migrate-cli.js --db /absolute/path/to/superior.db --dry-run
cd ..
```

Run the guarded workflow from the repository root:

```bash
DB_FILE=/absolute/path/to/superior.db ./ops.sh migrate-v5
```

The workflow validates exact v4, stops the service if active, creates and validates a private schema-v4 backup, runs one immediate transaction, validates exact v5 plus integrity and foreign keys, restricts file permissions, and restarts only if the service was previously active. A migration error rolls back the transaction, retains the validated v4 backup, and leaves the service stopped.

For each guild with Phase 1 ticket configuration or history, conversion creates a `General Support` department and default Subject/Details fields. Existing tickets receive that department and corresponding stored responses. Guild/settings/metrics rows, posted panels, ticket IDs/numbers, channel/control identities, claims, closure/log checkpoints, failure state, timestamps, and ticket events are verified unchanged. Delegated grants, suggestions, and applications start empty. When a Phase 1 configuration exists, its update timestamp becomes the department binding-verification marker so its active tickets and controls remain compatible; runtime actions still freshly fetch the current category, role, channels, member, and permissions. A history-only department with no prior routing remains unverified. Review `/ticket status` or `/ticket department health` and refresh launchers before accepting new work.

## Supported legacy v3 and v2 paths

The v5 migration CLI accepts exact schema v3 and the exact supported schema-v2 layout. Both paths run the established conversion to v4 and the v4-to-v5 conversion inside one outer transaction.

For v3:

```bash
node tsbot/dist/src/storage/check-cli.js --db /absolute/path/to/superior.db --expect 3
node tsbot/dist/src/storage/migrate-cli.js --db /absolute/path/to/superior.db --dry-run
DB_FILE=/absolute/path/to/superior.db ./ops.sh migrate-v3
```

The v3 path preserves guilds, validated settings, and metrics, then adds empty Phase 1/Phase 2 operational tables.

For supported v2:

```bash
node tsbot/dist/src/storage/check-cli.js --db /absolute/path/to/superior.db --expect 2
node tsbot/dist/src/storage/migrate-cli.js --db /absolute/path/to/superior.db --dry-run
DB_FILE=/absolute/path/to/superior.db ./ops.sh migrate-v2
```

The v2 path preserves active guild metadata, safely convertible settings, greeting text without fixed member IDs, and supported metrics. Data with no active consumer is removed. Unsafe or malformed settings become disabled and require review; invocation branding is reset or sanitized; unresolved moderation-recovery metadata blocks migration. A failed v3 or v2 transaction leaves the source generation unchanged and keeps its validated backup.

Schema v1 is not accepted. Upgrade it with the final 4.0.0 source release until it validates as schema v2, stop that process, retain its backup, and then follow the v2-to-v5 procedure. Renaming a database file never upgrades its contents.

## Post-migration review

After any successful migration:

```bash
./ops.sh status
./ops.sh logs
```

Review every guild before enabling new work:

1. Confirm `/setup status`, then validate/enable the guild if required.
2. Run `/access list` and verify that only intentional delegated grants exist. A v4/v3/v2 migration creates none.
3. Inspect `/panel status` and refresh any missing tracked launcher.
4. Inspect ticket department health and recover a representative active migrated ticket before accepting new tickets.
5. Setup suggestions and application forms from current Discord resources; migrations do not invent or enable them.
6. In a disposable test workflow, verify ticket closure/transcript delivery, suggestion submit/vote/review, and private application submit/claim/decision.

Do not interpret Discord message IDs alone as healthy bindings. The runtime re-fetches current channels, roles, messages, members, and bot permissions.

## Backup and restore

Create a current backup with:

```bash
./ops.sh backup
```

The backup CLI uses SQLite's online backup API, refuses an existing destination, validates exact schema v5, integrity, and foreign keys, and writes a private timestamped file. It is safe for a running single process; do not copy a live `.db` plus sidecars with ordinary filesystem tools.

Restore a v5 backup into a 5.3.0 deployment with:

```bash
./ops.sh restore backups/superior-schema5-YYYYMMDDTHHMMSSZ.db
```

Restore refuses the live database as its source. It makes a consistent private candidate through SQLite's backup API and validates it before stopping the service. It keeps the rollback directory on the database filesystem, moves the current database and sidecars there, installs the candidate atomically, validates again, restores the prior files on installation failure, and restarts only when appropriate. Keep the rollback directory until the application and guild checks pass.

Backups are not expired automatically. Define and test retention, encryption, off-host storage, access control, restore drills, and verified deletion appropriate to the deployment. A schema-v5 backup can contain delegated actor/role IDs, ticket questions/answers/transcripts metadata, suggestion authors/title/details/votes/review reasons, application applicants/private answers/decision reasons, panel content, delivery identifiers, and audit events. Treat application and ticket text as potentially sensitive even though users are warned not to submit sensitive data.

## Guild export, import, and purge

The guild owner and Administrators can create a bounded same-guild JSON export with `/setup export`. Only the owner can run exact-confirmation `/setup import` and `/setup purge`. Treat import as destructive live-data replacement and keep a protected pre-import export or SQLite-aware backup when rollback may be required.

- Format 4 replaces settings, metrics, delegated grants, ticket departments/forms/responses/events, panels, suggestions/votes/events, and application forms/responses/events.
- Legacy format 3 replaces settings, metrics, panels, and the Phase 1 ticket model. It converts that ticket data to `General Support` and clears Phase 2 collections the old format cannot contain.
- Legacy format 2 replaces settings and metrics only, preserving every current operational row.

Parsing validates collection limits, the 100-event per-workflow-record history cap, tenant identity, uniqueness, and cross-record references before replacement. Every successful import disables the guild. Inserted grants are inactive, service/form/department configurations are disabled, and external role/channel bindings are unverified until administrators inspect current Discord resources and explicitly reconfigure or enable them.

Guild purge deletes the `guilds` row and schema-v5 tenant data through foreign-key cascades. A confirmed Discord `guildDelete` removal invokes the same live-database purge and clears guild-scoped process state. Startup reconciliation remains deliberately conservative: a guild missing or temporarily unavailable while the process starts is marked inactive so a Discord outage cannot be mistaken for confirmed removal. Import and purge affect only the live database. They do not remove downloaded exports, backups, SQLite free pages, Discord panels, suggestion messages/threads, application review messages, ticket channels/transcripts/logs, direct messages, host logs, or vendor copies. Apply separate retention and verified-deletion procedures to each copy.

## Workflow recovery

- Tickets: `/ticket recover` reconciles interrupted creation/closure, missing channel/control delivery, a lingering channel for a closed record, and Superior-managed support/delegate ACLs. After granting or revoking `tickets.manage`, run recovery separately for every active ticket; revocation blocks controls immediately, but the old role can retain Discord read access until that channel is recovered. Recovery preserves unrelated manual overwrites.
- Suggestions: `/suggestion recover` re-checks stored public delivery, recreates or rebinds a missing suggestion message as supported, and records recovery. Review channel/thread permissions before retrying.
- Applications: `/application recover` is content-review authority and reconciles a missing private review message for a locally binding-verified form—even after submissions are disabled—after revalidating its private channel and reviewer role. Imported unverified forms remain dormant until explicit revalidation. Superior does not edit application review-channel ACLs; grant/form-enable preflights require active `applications.review` roles to have access, and operators remove that Discord access separately after revocation.
- Panels: use the corresponding `panel` command or `/panel post ... replace_existing:true` after resource health is restored.

Recovery actions are designed to be repeatable, but Discord deletion, delivery, thread creation, and DMs remain external best-effort effects. Read the private response and audit state before retrying. Never repair a row by copying an ID from another guild.

## Release rollback

Application and schema generations must match:

- To recover a 5.3.0 deployment while retaining schema v5, deploy a known-good 5.3.0 build and restore a validated v5 backup if data restoration is necessary.
- To return to 5.2.1 after a v4-to-v5 migration, stop all writers, preserve the current v5 database separately, validate the pre-migration v4 backup, restore it through a controlled atomic file replacement, deploy the exact known-good v4-compatible build/configuration, then start and verify it.
- To return to 5.1.0 after a v3-to-v5 migration, use the original validated v3 backup and exact compatible application generation.
- To return to a schema-v2 application after a v2-to-v5 migration, use the original validated v2 backup and exact compatible generation.

The 5.3.0 `restore` command intentionally accepts only v5. Release-level rollback to v4/v3/v2 therefore requires the stopped-process procedure, not `./ops.sh restore`. Never start 5.3.0 against v4/v3/v2 or an older application against v5.

## Verification checklist

- The service account owns `.env`, database, sidecars, backup directory, and lock with restrictive permissions.
- Exactly one bot process is configured to write the database; it is on a local reliable filesystem.
- `./ops.sh status` reports schema 5 and integrity `ok`; foreign-key check is empty.
- The 20 expected tables exist and no unexpected application views/triggers exist. See [Development](development.md#schema-v5).
- Every expected guild appears; inactive guilds remain disabled.
- `/setup status`, `/access list`, `/panel status`, ticket department health, a private utility, and deliberate addressed chat work in a test guild.
- Enabled ticket, suggestion, and application services pass current channel/role/bot permission checks and a disposable end-to-end workflow.
- Application answers appear only in the configured private review destination; public suggestion output contains no voter identity; user text creates no mentions.
- Global command changes have finished propagating before stale definitions are treated as an incident.
- Logs contain no token, environment value, message content, application answers, suggestion details, transcript content, or database content.
