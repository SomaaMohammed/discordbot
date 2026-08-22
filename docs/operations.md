# Operations

This runbook covers source deployments on Linux and the schema-v9 data lifecycle. Windows portable operation is covered in the [Windows guide](windows.md).

## Invariants

- Never print or commit `.env`, tokens, SQLite files/sidecars, exports, or backups.
- Run only one Superior writer process for a database. Shared-file multi-process SQLite operation is unsupported.
- Stop every writer before migration or release-level rollback.
- Back up and validate before changing a database.
- Normal startup never upgrades an existing schema.
- Never point development, tests, or ad hoc SQLite tools at the live database.
- Keep database, sidecars, backups, environment files, operation locks, application answers, suggestion text, ticket transcripts, case reasons/private notes, reports, appeals, and review records private to appropriately authorized people.

`ops.sh` uses `umask 077`, a single-operation lock, exact schema validation, tracked-change guards, fast-forward-only rollout, and restrictive database permissions. Defaults are `superior.db`, `backups/`, and systemd service `superior-bot`; override selectors through the environment when a host uses different paths.

## Terminal logging and interaction expiry

The terminal attached to the source process or `SuperiorBot.exe` is the primary operational log. Each bounded single-line entry begins with an ISO timestamp, `DEBUG`, `INFO`, `WARN`, or `ERROR`, and a scope, followed by readable text and `key=value` fields. Normal output records launcher/build identity, safe configuration and database classification, Discord login/ready/gateway state, command synchronization, guild lifecycle, interaction receipt/outcome, workflow delivery, cleanup, and graceful shutdown. Set `SUPERIOR_LOG_LEVEL=DEBUG` only during bounded diagnosis; routine ignored-message/parser detail stays out of the default stream.

Interaction entries include a correlation ID, sanitized command/component route, safe guild ID, age at receipt, acknowledgement type/latency, outcome, and total duration. They never include message text, ticket/application answers, suggestion bodies, case reasons/private notes, report or appeal bodies, reviewer reasons, attachments, exports, tokens, or private operator-configuration values. Metadata is recursively redacted by sensitive key and token pattern; values, collections, cause chains, and stacks are bounded. Safe moderation metadata may include a case/report/appeal number, action type, state transition, Discord error class, and recovery recommendation.

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

`rollout` refuses a non-v9 database. It fast-forwards the selected branch, installs dependencies, runs formatting, typecheck, tests, and a clean build, validates and backs up an existing v9 database, then restarts the service. The default dirty-tree policy refuses tracked changes; `DIRTY_POLICY=stash` stashes tracked changes only and does not move ignored operator data.

An external checkout-directory or service rename is not performed by this repository. Update `APP_DIR`, `SERVICE_NAME`, the systemd unit, working directory, and environment paths together during a separately planned maintenance window.

## Fresh database

With no file at `DB_FILE`, startup creates schema v9 transactionally. An empty existing file is also eligible. If another database exists under an earlier default name while `DB_FILE` is unset, startup and operations refuse to create a second database; select the intended file explicitly and follow the upgrade workflow.

After first startup, run:

```bash
./ops.sh status
```

Joined guilds work immediately with safe core defaults. Configure only external-resource workflows whose Discord channels, roles, and permissions must be verified.

## Required offline migration from schema v8

Schema v8 is the normal source for a 6.0.0 deployment. Build 6.1.0 first, but do not start it against v8. Confirm that all processes and maintenance sessions that can write the selected file will be stopped. A dry run performs exact schema classification and the complete conversion in a transaction that is deliberately rolled back:

```bash
cd tsbot
npm ci
npm run build
node dist/src/storage/check-cli.js --db /absolute/path/to/superior.db --expect 8
node dist/src/storage/migrate-cli.js --db /absolute/path/to/superior.db --dry-run
cd ..
```

Run the guarded workflow from the repository root:

```bash
DB_FILE=/absolute/path/to/superior.db ./ops.sh migrate-v9
```

The workflow validates exact v8, stops the service if active, creates and validates a private schema-v8 backup, runs one immediate transaction, validates exact v9 plus integrity and foreign keys, restricts file permissions, and restarts only if the service was previously active. A migration error rolls back the transaction, retains the validated v8 backup, and leaves the service stopped.

The v8-to-v9 step preserves every existing table row, setting, grant, panel, workflow, delivery checkpoint, and external Discord identifier. It extends the delegated-capability constraint without losing grants and adds empty/default-disabled moderation, report, appeal, and anti-spam storage. It does not invent historical cases, enable new submissions, activate anti-spam, or act on prior sanctions. After migration, start only a schema-v9-capable 6.1.x build and inspect startup/database-check logs. Never run 6.0.0 or another pre-v9 executable against the migrated database.

## Supported legacy v7, v6, v5, v4, v3, and v2 paths

The v9 migration CLI also accepts exact schema v7, schema v6, schema v5, schema v4, schema v3, and the exact supported schema-v2 layout. These paths run the applicable frozen historical conversions and the final v8-to-v9 step inside one outer transaction.

For v7, validate with `--expect 7`, retain a schema-v7 backup, and run `DB_FILE=/absolute/path/to/superior.db ./ops.sh migrate-v8`. For v6, validate with `--expect 6`, retain a schema-v6 backup, and run `DB_FILE=/absolute/path/to/superior.db ./ops.sh migrate-v7`. For v5, use `migrate-v6`. Every compatibility command reaches current v9 in one transaction.

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

The v2 path preserves active guild metadata, safely convertible settings, greeting text without fixed member IDs, and supported metrics. Data with no active consumer is removed. Unsafe or malformed values are replaced with bounded neutral settings; invocation branding is reset or sanitized; unresolved moderation-recovery metadata blocks migration. A failed migration from any supported source generation leaves that source unchanged and keeps its validated backup.

Schema v1 is not accepted. Before any migration to v9, convert a separate stopped copy with the final 4.0.0 source release until it validates as schema v2, stop that process, retain its backup, and then follow the v2-to-v9 procedure. Renaming a database file never upgrades its contents. Once the working database reaches v9, never open it with a pre-v9 executable.

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
7. Confirm `/moderation status` and `/automod status` show Phase 3 services/rules disabled and no invented historical cases.
8. Configure private moderation/report/appeal bindings from current Discord resources, then test confidential report and eligible appeal review in disposable records before posting a safety panel.
9. Configure one conservative anti-spam rule in a disposable channel, run `/automod test`, then verify deletion, exemption, cooldown, and case/log behavior before wider enablement.
10. In a disposable test workflow, verify ticket closure/transcript delivery, suggestion submit/vote/review, private application submit/claim/decision, and a reversible moderation case.

Do not interpret Discord message IDs alone as healthy bindings. The runtime re-fetches current channels, roles, messages, members, and bot permissions.

## Backup and restore

Create a current backup with:

```bash
./ops.sh backup
```

The backup CLI uses SQLite's online backup API, refuses an existing destination, validates exact schema v9, integrity, and foreign keys, and writes a private timestamped file. It is safe for a running single process; do not copy a live `.db` plus sidecars with ordinary filesystem tools.

Restore a v9 backup into a 6.1.x deployment with:

```bash
./ops.sh restore backups/superior-schema9-YYYYMMDDTHHMMSSZ.db
```

Restore refuses the live database as its source. It makes a consistent private candidate through SQLite's backup API and validates it before stopping the service. It keeps the rollback directory on the database filesystem, moves the current database and sidecars there, installs the candidate atomically, validates again, restores the prior files on installation failure, and restarts only when appropriate. Keep the rollback directory until the application and guild checks pass.

Backups are not expired automatically. Define and test retention, encryption, off-host storage, access control, restore drills, and verified deletion appropriate to the deployment. A schema-v9 backup can contain delegated actor/role IDs, persistent panel bindings/content, ticket questions/answers/transcript metadata, suggestion and application content, restricted-ping use, case reasons/private notes, reporter/appellant identities and explanations, staff decisions, message-link identifiers, anti-spam enforcement metadata, bounded delivery identifiers, and audit events. Treat every private workflow and moderation field as potentially sensitive.

## Guild export, import, and purge

The guild owner and Administrators can create a bounded same-guild JSON export with `/data export`. Only the owner can run exact-confirmation `/data import` and `/data purge`. Treat import as destructive live-data replacement and keep a protected pre-import export or SQLite-aware backup when rollback may be required.

- Format 7 replaces the complete portable tenant model, including moderation configuration/cases/events/checkpoints, reports/events, appeals/events, anti-spam rules/exemptions, and safe enforcement metadata.
- Legacy format 6 replaces its complete schema-v8-era model and leaves Phase 3 collections empty/default-disabled.
- Legacy format 5 replaces its schema-v7 portable model, converts its frozen settings to settings v3, and leaves Phase 3 empty/default-disabled.
- Legacy format 4 replaces its complete schema-v5 model and leaves restricted-ping and Phase 3 collections empty/default-disabled.
- Legacy format 3 replaces settings, metrics, panels, and the Phase 1 ticket model. It converts that ticket data to `General Support`, clears Phase 2 collections the old format cannot contain, and leaves Phase 3 empty/default-disabled.
- Legacy format 2 replaces settings and metrics only, preserving every current operational row.

Parsing validates collection limits, audit-history caps, tenant identity, uniqueness, and cross-record references before replacement. Every successful import leaves the core guild bot active. Inserted grants are inactive; external service/form/department/restricted-ping/moderation/report/appeal/resource bindings are disabled or unverified until administrators inspect current Discord resources and explicitly reconfigure or enable them. Anti-spam rules remain disabled, imported sanctions are never replayed, and imported history remains readable only to its authorized audience.

Guild purge deletes the `guilds` row and schema-v9 tenant data through foreign-key cascades, including all Phase 3 rows. A Discord `guildDelete` departure instead marks the tenant inactive and retains its rows, panel bindings, and workflow history for a possible rejoin; rejoin restores immediate core availability. Import and purge affect only the live database. They do not remove downloaded exports, backups, SQLite free pages, Discord panels, suggestion/application/report/appeal messages, moderation logs, ticket channels/transcripts/logs, prior sanctions or restricted-role notifications, direct messages, host logs, or vendor copies. Apply separate retention and verified-deletion procedures to each copy.

## Workflow recovery

- Tickets: `/ticket recover` reconciles interrupted creation/closure, missing channel/control delivery, a lingering channel for a closed record, and Superior-managed support/delegate ACLs. After granting or revoking `tickets.manage`, run recovery separately for every active ticket; revocation blocks controls immediately, but the old role can retain Discord read access until that channel is recovered. Recovery preserves unrelated manual overwrites.
- Suggestions: `/suggestion recover` re-checks stored public delivery, recreates or rebinds a missing suggestion message as supported, and records recovery. Review channel/thread permissions before retrying.
- Applications: `/application recover` is content-review authority and reconciles a missing private review message for a locally binding-verified form—even after submissions are disabled—after revalidating its private channel and reviewer role. Imported unverified forms remain dormant until explicit revalidation. Superior does not edit application review-channel ACLs; grant/form-enable preflights require active `applications.review` roles to have access, and operators remove that Discord access separately after revocation.
- Restricted pings: `/restrictedping list` and `/restrictedping info` expose missing role/channel bindings. Discord role/channel deletion events clean known mappings, while `/pingrole` always performs live validation so downtime cannot turn a missed deletion event into authorization. Use `/restrictedping cleanup-role role_id:<id>` or `/restrictedping cleanup-channel channel_id:<id>` for a stale entry whose deletion event was missed, then re-add only a current safe role/channel pair; do not repair IDs directly in SQLite.
- Moderation cases: `/moderation recover case_number:<number> mode:log` revalidates the log channel and retries its checkpoint without duplicating a successful log. `mode:confirm` applies only to a failed reserved Discord-action attempt and requires current, action-specific proof: a correlated live timeout, an unambiguous active ban, an unambiguous completed unban, an exactly related timeout removal, or an explicit operator assertion for a kick, which has no durable state to query. Appeal timeout removals are reconciled atomically by retrying the current appeal decision instead. `mode:fail` records a bounded explicit failure code on a failed reservation. A Discord punishment remains successful even when downstream logging failed; log recovery must not repeat it. Active timeout, anti-spam-timeout, and ban cases cannot be voided until a separately authorized removal completes.
- Reports and appeals: `/report recover report_number:<number>` and `/appeal recover appeal_number:<number>` require current review authority and revalidate the private destination, reviewer role, tracked record, and case where applicable. They refresh a valid tracked review message, or retire/mark a provably missing or stale tracked message before conditionally posting a replacement; ambiguous Discord lookup or deletion fails closed. Deleted channels/roles disable or invalidate the binding until explicit configuration succeeds; never recover into a public channel. Reviewers can release their own claims. Another reviewer can take over only when Superior proves the prior claimant is absent or has lost current authority; an unavailable member lookup never authorizes takeover.
- Anti-spam: recovery expires or reconciles interrupted enforcement reservations by guild/rule/message/member without inventing success or repeating a case. A restart resets only in-memory detection windows, not persisted cooldowns or duplicate-action protection.
- Panels: use the corresponding `panel` command or `/panel post ... replace_existing:true` after resource health is restored.

Recovery actions are designed to be repeatable, but Discord deletion, delivery, thread creation, and DMs remain external best-effort effects. Read the private response and audit state before retrying. Never repair a row by copying an ID from another guild.

## Release rollback

Application and schema generations must match:

- To recover a 6.1.x deployment while retaining schema v9, deploy only a known-good schema-v9-capable 6.1.x build and restore a validated v9 backup if data restoration is necessary.
- After any database has migrated to v9, do not start, deploy, or recommend 6.0.0 or another pre-v9 executable for that installation. Keep pre-migration backups only as protected recovery evidence; use current-version restore tooling, a known-good current build, or a forward fix.
- If a current release regression prevents safe startup, keep the bot stopped, preserve the v9 database, and repair or replace the current build. Do not convert the incident into an application/schema downgrade.

The 6.1.x `restore` command intentionally accepts only v9. `./ops.sh restore` cannot downgrade a schema or authorize an older executable. Never run a pre-v9 executable after the database has migrated to v9.

## Verification checklist

- The service account owns `.env`, database, sidecars, backup directory, and lock with restrictive permissions.
- Exactly one bot process is configured to write the database; it is on a local reliable filesystem.
- `./ops.sh status` reports schema 9 and integrity `ok`; foreign-key check is empty.
- The 38 expected tables exist and no unexpected application views/triggers exist. See [Development](development.md#schema-v9).
- Every expected joined guild appears active; intentionally disabled or departed guilds remain inactive.
- `/config status`, `/access list`, `/panel status`, `/restrictedping list`, ticket department health, a private utility, and deliberate addressed chat work in a test guild.
- Existing role, ticket, suggestion, application, resource, help, private-message, and safety panel controls route without exposing a private record.
- Enabled ticket, suggestion, application, restricted-ping, moderation, report, appeal, and anti-spam services pass current channel/role/member/bot permission checks and a disposable end-to-end workflow.
- Private notes never reach member/log output; reports and appeals stay in their separate private destinations; public suggestion output contains no voter identity; user text creates no mentions.
- Anti-spam remains default-disabled until deliberately enabled, stores no raw message content, respects verified exemptions, and does not enforce edits.
- Legacy `/superior` member timeout, untimeout, and bounded bulk-timeout actions fail closed until Phase 3 moderation cases are enabled; purge, channel lock/unlock, and slowmode remain independent.
- `/pingrole` produces exactly one approved role notification, rejects the wrong role/channel/thread, and enforces the 60-second user plus 30-second role defaults without an Administrator bypass.
- Global command synchronization has registered `/pingrole`, `/restrictedping`, `/moderation`, `/report`, `/appeal`, and `/automod`, and propagation has finished before stale definitions are treated as an incident.
- Logs contain no token, environment value, raw message content, private note, report/appeal body, reviewer reason, application answer, suggestion detail, transcript content, export, or database content.
