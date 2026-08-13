# Operations

This runbook covers source deployments on Linux and the schema-v8 data lifecycle. Windows portable operation is covered in the [Windows guide](windows.md).

## Invariants

- Never print or commit `.env`, tokens, SQLite files/sidecars, exports, or backups.
- Run only one Superior writer process for a database. Shared-file multi-process SQLite operation is unsupported.
- Stop every writer before migration or release-level rollback.
- Back up and validate before changing a database.
- Normal startup never upgrades an existing schema.
- Never point development, tests, or ad hoc SQLite tools at the live database.
- Keep database, sidecars, backups, environment files, operation locks, application answers, suggestion text, and ticket transcripts private to appropriately authorized people.

`ops.sh` uses `umask 077`, a single-operation lock, exact schema validation, tracked-change guards, fast-forward-only rollout, and restrictive database permissions. Defaults are `superior.db`, `backups/`, and systemd service `superior-bot`; override selectors through the environment when a host uses different paths.

## Terminal logging and interaction expiry

The terminal attached to the source process or `SuperiorBot.exe` is the primary operational log. Each bounded single-line entry begins with an ISO timestamp, `DEBUG`, `INFO`, `WARN`, or `ERROR`, and a scope, followed by readable text and `key=value` fields. Normal output records launcher/build identity, safe configuration and database classification, Discord login/ready/gateway state, command synchronization, guild lifecycle, interaction receipt/outcome, workflow delivery, cleanup, and graceful shutdown. Set `SUPERIOR_LOG_LEVEL=DEBUG` only during bounded diagnosis; routine ignored-message/parser detail stays out of the default stream.

Interaction entries include a correlation ID, sanitized command/component route, safe guild ID, age at receipt, acknowledgement type/latency, outcome, and total duration. They never include message text, ticket/application answers, suggestion bodies, attachments, exports, tokens, or private operator-configuration values. Metadata is recursively redacted by sensitive key and token pattern; values, collections, cause chains, and stacks are bounded.

Representative output has this shape:

```text
[2026-08-11T10:00:00.000Z] [INFO] [interaction] Command interaction received correlationId="a1b2c3d4e5f6" operation="superior/backfillstats" guildId="123..." ageAtReceiptMs=42
[2026-08-11T10:00:00.120Z] [INFO] [interaction] Command interaction completed correlationId="a1b2c3d4e5f6" outcome="succeeded" acknowledgement="defer-reply" acknowledgementLatencyMs=18 totalDurationMs=120
```

Superior classifies Discord 10062 as an interaction that was already expired/unknown when acknowledgement began. The operation is not executed, and no doomed user reply is attempted. Code 40060 means a competing path already acknowledged the interaction, so Superior avoids a second reply. Codes 50001/50013 identify missing access/permissions; missing-channel/message/role codes name a stale external resource; rate-limit, network, SQLite busy/integrity/schema, configuration, filesystem, child-process, and shutdown-timeout failures each include a concise recovery action. Unknown failures retain a correlation ID, bounded cause chain, and redacted stack.

If 10062 appears, correlate `ageAtReceiptMs`, `eventLoopMaxDelayMs`, gateway disconnect/resume lines, and the same correlation ID. An interaction arriving near 3 seconds is warned and rejected before business work; event-loop delay above the diagnostic threshold produces a separate warning. Check host CPU pressure, synchronous maintenance/backfill work, Discord gateway health, and duplicate processes. Do not retry by adding another reply path. Unhandled rejections, uncaught exceptions, and fatal gateway invalidation are reported once and enter the controlled drain/shutdown path rather than continuing in an unknown state.

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

`rollout` refuses a non-v8 database. It fast-forwards the selected branch, installs dependencies, runs formatting, typecheck, tests, and a clean build, validates and backs up an existing v8 database, then restarts the service. The default dirty-tree policy refuses tracked changes; `DIRTY_POLICY=stash` stashes tracked changes only and does not move ignored operator data.

An external checkout-directory or service rename is not performed by this repository. Update `APP_DIR`, `SERVICE_NAME`, the systemd unit, working directory, and environment paths together during a separately planned maintenance window.

## Fresh database

With no file at `DB_FILE`, startup creates schema v8 transactionally. An empty existing file is also eligible. If another database exists under an earlier default name while `DB_FILE` is unset, startup and operations refuse to create a second database; select the intended file explicitly and follow the upgrade workflow.

After first startup, run:

```bash
./ops.sh status
```

Joined guilds work immediately with safe core defaults. Configure only external-resource workflows whose Discord channels, roles, and permissions must be verified.

## Required offline migration from schema v7

Schema v7 is the normal source for a 5.5.0 deployment. Build 6.0.0 first, but do not start it against v7. Confirm that all processes and maintenance sessions that can write the selected file will be stopped. A dry run performs exact schema classification and the complete conversion in a transaction that is deliberately rolled back:

```bash
cd tsbot
npm ci
npm run build
node dist/src/storage/check-cli.js --db /absolute/path/to/superior.db --expect 7
node dist/src/storage/migrate-cli.js --db /absolute/path/to/superior.db --dry-run
cd ..
```

Run the guarded workflow from the repository root:

```bash
DB_FILE=/absolute/path/to/superior.db ./ops.sh migrate-v8
```

The workflow validates exact v7, stops the service if active, creates and validates a private schema-v7 backup, runs one immediate transaction, validates exact v8 plus integrity and foreign keys, restricts file permissions, and restarts only if the service was previously active. A migration error rolls back the transaction, retains the validated v7 backup, and leaves the service stopped.

The v7-to-v8 step preserves every operational row and stored panel/message/channel/workflow/component identifier. It replaces only settings v2 with settings v3: joined guilds become active, departed guilds remain inactive, timezone/log/invocation/limits/greetings are retained, and a neutral `Welcome` greeting is added only when the old list is empty. After migration, start only 6.0.0 and inspect startup/database-check logs. Never run a 5.5.0 or older executable against the migrated v8 database.

## Supported legacy v6, v5, v4, v3, and v2 paths

The v8 migration CLI also accepts exact schema v6, schema v5, schema v4, schema v3, and the exact supported schema-v2 layout. These paths run the applicable frozen historical conversions and the final v7-to-v8 step inside one outer transaction.

For v6, validate with `--expect 6`, retain a schema-v6 backup, and run `DB_FILE=/absolute/path/to/superior.db ./ops.sh migrate-v7`. For v5, validate with `--expect 5`, retain a schema-v5 backup, and run `DB_FILE=/absolute/path/to/superior.db ./ops.sh migrate-v6`. Both compatibility commands reach current v8 in one transaction.

For v4:

```bash
node tsbot/dist/src/storage/check-cli.js --db /absolute/path/to/superior.db --expect 4
node tsbot/dist/src/storage/migrate-cli.js --db /absolute/path/to/superior.db --dry-run
DB_FILE=/absolute/path/to/superior.db ./ops.sh migrate-v4
```

For each guild with Phase 1 ticket configuration or history, the historical v4-to-v5 conversion creates a `General Support` department and default Subject/Details fields. Existing tickets receive that department and corresponding stored responses. Guild/settings/metrics rows, posted panels, ticket identities, claims, closure/log checkpoints, failure state, timestamps, and ticket events are preserved. Delegated grants, suggestions, applications, and restricted pings start empty. Runtime actions still freshly fetch current resources and permissions.

For v3:

```bash
node tsbot/dist/src/storage/check-cli.js --db /absolute/path/to/superior.db --expect 3
node tsbot/dist/src/storage/migrate-cli.js --db /absolute/path/to/superior.db --dry-run
DB_FILE=/absolute/path/to/superior.db ./ops.sh migrate-v3
```

The v3 path preserves guilds, validated settings, and metrics, then adds empty later-generation operational tables.

For supported v2:

```bash
node tsbot/dist/src/storage/check-cli.js --db /absolute/path/to/superior.db --expect 2
node tsbot/dist/src/storage/migrate-cli.js --db /absolute/path/to/superior.db --dry-run
DB_FILE=/absolute/path/to/superior.db ./ops.sh migrate-v2
```

The v2 path preserves active guild metadata, safely convertible settings, greeting text without fixed member IDs, and supported metrics. Data with no active consumer is removed. Unsafe or malformed values are replaced with bounded neutral settings; invocation branding is reset or sanitized; unresolved moderation-recovery metadata blocks migration. A failed v6, v5, v4, v3, or v2 transaction leaves the source generation unchanged and keeps its validated backup.

Schema v1 is not accepted. Before any migration to v8, convert a separate stopped copy with the final 4.0.0 source release until it validates as schema v2, stop that process, retain its backup, and then follow the v2-to-v8 procedure. Renaming a database file never upgrades its contents. Once the working database reaches v8, never open it with that or any other older executable.

## Post-migration review

After any successful migration:

```bash
./ops.sh status
./ops.sh logs
```

Review migrated external bindings and persistent routes:

1. Confirm `/config status`; joined guilds should already be active unless an administrator intentionally used the emergency switch.
2. Run `/access list` and verify that only intentional delegated grants exist. A v4/v3/v2 migration creates none.
3. Inspect `/panel status` and exercise existing role, ticket, suggestion, application, resource, help, and private-message controls. Restart and migration do not require reposting.
4. Inspect ticket department health and recover a representative active migrated ticket before accepting new tickets.
5. Configure suggestions and application forms from current Discord resources when the legacy source did not contain them; migrations do not invent external bindings.
6. Run `/restrictedping list`, verify every retained mapping, then test one disposable `/pingrole` delivery and both cooldowns.
7. In a disposable test workflow, verify ticket closure/transcript delivery, suggestion submit/vote/review, and private application submit/claim/decision.

Do not interpret Discord message IDs alone as healthy bindings. The runtime re-fetches current channels, roles, messages, members, and bot permissions.

## Backup and restore

Create a current backup with:

```bash
./ops.sh backup
```

The backup CLI uses SQLite's online backup API, refuses an existing destination, validates exact schema v8, integrity, and foreign keys, and writes a private timestamped file. It is safe for a running single process; do not copy a live `.db` plus sidecars with ordinary filesystem tools.

Restore a v8 backup into a 6.0.0 deployment with:

```bash
./ops.sh restore backups/superior-schema8-YYYYMMDDTHHMMSSZ.db
```

Restore refuses the live database as its source. It makes a consistent private candidate through SQLite's backup API and validates it before stopping the service. It keeps the rollback directory on the database filesystem, moves the current database and sidecars there, installs the candidate atomically, validates again, restores the prior files on installation failure, and restarts only when appropriate. Keep the rollback directory until the application and guild checks pass.

Backups are not expired automatically. Define and test retention, encryption, off-host storage, access control, restore drills, and verified deletion appropriate to the deployment. A schema-v8 backup can contain delegated actor/role IDs, persistent panel bindings/content, ticket questions/answers/transcripts metadata, suggestion authors/title/details/votes/review reasons, application applicants/private answers/decision reasons, restricted-ping mappings/member cooldowns/audit actors, bounded internal delivery identifiers, and audit events. Treat application and ticket text as potentially sensitive even though users are warned not to submit sensitive data.

## Guild export, import, and purge

The guild owner and Administrators can create a bounded same-guild JSON export with `/data export`. Only the owner can run exact-confirmation `/data import` and `/data purge`. Treat import as destructive live-data replacement and keep a protected pre-import export or SQLite-aware backup when rollback may be required.

- Format 6 replaces settings, metrics, delegated grants, ticket departments/forms/responses/events, persistent panels, suggestions/votes/events, application forms/responses/events, and restricted-ping configuration/mappings/cooldowns/events.
- Legacy format 5 replaces its schema-v7 portable model and converts its frozen settings to settings v3.
- Legacy format 4 replaces its complete schema-v5 model and leaves restricted-ping collections empty.
- Legacy format 3 replaces settings, metrics, panels, and the Phase 1 ticket model. It converts that ticket data to `General Support` and clears Phase 2 collections the old format cannot contain.
- Legacy format 2 replaces settings and metrics only, preserving every current operational row.

Parsing validates collection limits, audit-history caps, tenant identity, uniqueness, and cross-record references before replacement. Every successful import leaves the core guild bot active. Inserted grants are inactive; external service/form/department/restricted-ping/resource bindings are disabled or unverified until administrators inspect current Discord resources and explicitly reconfigure or enable them.

Guild purge deletes the `guilds` row and schema-v8 tenant data through foreign-key cascades. A Discord `guildDelete` departure instead marks the tenant inactive and retains its rows, panel bindings, and workflow history for a possible rejoin; rejoin restores immediate core availability. Import and purge affect only the live database. They do not remove downloaded exports, backups, SQLite free pages, Discord panels, suggestion messages/threads, application review messages, ticket channels/transcripts/logs, prior restricted-role notifications, direct messages, host logs, or vendor copies. Apply separate retention and verified-deletion procedures to each copy.

## Workflow recovery

- Tickets: `/ticket recover` reconciles interrupted creation/closure, missing channel/control delivery, a lingering channel for a closed record, and Superior-managed support/delegate ACLs. After granting or revoking `tickets.manage`, run recovery separately for every active ticket; revocation blocks controls immediately, but the old role can retain Discord read access until that channel is recovered. Recovery preserves unrelated manual overwrites.
- Suggestions: `/suggestion recover` re-checks stored public delivery, recreates or rebinds a missing suggestion message as supported, and records recovery. Review channel/thread permissions before retrying.
- Applications: `/application recover` is content-review authority and reconciles a missing private review message for a locally binding-verified form—even after submissions are disabled—after revalidating its private channel and reviewer role. Imported unverified forms remain dormant until explicit revalidation. Superior does not edit application review-channel ACLs; grant/form-enable preflights require active `applications.review` roles to have access, and operators remove that Discord access separately after revocation.
- Restricted pings: `/restrictedping list` and `/restrictedping info` expose missing role/channel bindings. Discord role/channel deletion events clean known mappings, while `/pingrole` always performs live validation so downtime cannot turn a missed deletion event into authorization. Use `/restrictedping cleanup-role role_id:<id>` or `/restrictedping cleanup-channel channel_id:<id>` for a stale entry whose deletion event was missed, then re-add only a current safe role/channel pair; do not repair IDs directly in SQLite.
- Panels: use the corresponding `panel` command or `/panel post ... replace_existing:true` after resource health is restored.

Recovery actions are designed to be repeatable, but Discord deletion, delivery, thread creation, and DMs remain external best-effort effects. Read the private response and audit state before retrying. Never repair a row by copying an ID from another guild.

## Release rollback

Application and schema generations must match:

- To recover a 6.0.0 deployment while retaining schema v8, deploy only a known-good 6.0.0 build and restore a validated v8 backup if data restoration is necessary.
- After any database has migrated to v8, do not start, deploy, or recommend a pre-6.0.0 executable for that installation. Keep pre-migration backups only as protected recovery evidence; use current-version restore tooling, a known-good current build, or a forward fix.
- If a current release regression prevents safe startup, keep the bot stopped, preserve the v8 database, and repair or replace the 6.x build. Do not convert the incident into an application/schema downgrade.

The 6.0.0 `restore` command intentionally accepts only v8. `./ops.sh restore` cannot downgrade a schema or authorize an older executable. Never run an older executable after the database has migrated to v8.

## Verification checklist

- The service account owns `.env`, database, sidecars, backup directory, and lock with restrictive permissions.
- Exactly one bot process is configured to write the database; it is on a local reliable filesystem.
- `./ops.sh status` reports schema 8 and integrity `ok`; foreign-key check is empty.
- The 25 expected tables exist and no unexpected application views/triggers exist. See [Development](development.md#schema-v8).
- Every expected joined guild appears active; intentionally disabled or departed guilds remain inactive.
- `/config status`, `/access list`, `/panel status`, `/restrictedping list`, ticket department health, a private utility, and deliberate addressed chat work in a test guild.
- Existing role, ticket, suggestion, application, resource, help, and private-message panel controls route without reposting.
- Enabled ticket, suggestion, application, and restricted-ping services pass current channel/role/member/bot permission checks and a disposable end-to-end workflow.
- Application answers appear only in the configured private review destination; public suggestion output contains no voter identity; user text creates no mentions.
- `/pingrole` produces exactly one approved role notification, rejects the wrong role/channel/thread, and enforces the 60-second user plus 30-second role defaults without an Administrator bypass.
- Global command synchronization has registered `/pingrole` and `/restrictedping`, and propagation has finished before stale definitions are treated as an incident.
- Logs contain no token, environment value, message content, application answers, suggestion details, transcript content, or database content.
