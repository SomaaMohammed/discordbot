# Operations

This runbook covers source deployments on Linux and the schema-v10 data lifecycle. Windows portable operation is covered in the [Windows guide](windows.md).

## Invariants

- Never print or commit `.env`, tokens, SQLite files/sidecars, exports, or backups.
- Run only one Superior writer process for a database. Shared-file multi-process SQLite operation is unsupported.
- Stop every writer before migration or release-level rollback.
- Back up and validate before changing a database.
- Normal startup never upgrades an existing schema.
- Never point development, tests, or ad hoc SQLite tools at the live database.
- Keep database, sidecars, backups, environment files, operation locks, application answers, suggestion text, ticket transcripts, case reasons/private notes, reports, appeals, rules text, welcome/farewell templates, onboarding history, member-role outcomes, and review records private to appropriately authorized people.

`ops.sh` uses `umask 077`, a single-operation lock, exact schema validation, tracked-change guards, fast-forward-only rollout, and restrictive database permissions. Defaults are `superior.db`, `backups/`, and systemd service `superior-bot`; override selectors through the environment when a host uses different paths.

## Terminal logging and interaction expiry

The terminal attached to the source process or `SuperiorBot.exe` is the primary operational log. Each bounded single-line entry begins with an ISO timestamp, `DEBUG`, `INFO`, `WARN`, or `ERROR`, and a scope, followed by readable text and `key=value` fields. Normal output records launcher/build identity, safe configuration and database classification, Discord login/ready/gateway state, command synchronization, guild lifecycle, interaction receipt/outcome, workflow delivery, cleanup, and graceful shutdown. Set `SUPERIOR_LOG_LEVEL=DEBUG` only during bounded diagnosis; routine ignored-message/parser detail stays out of the default stream.

Interaction entries include a correlation ID, sanitized command/component route, safe guild ID, age at receipt, acknowledgement type/latency, outcome, and total duration. They never include message text, ticket/application answers, suggestion bodies, case reasons/private notes, report or appeal bodies, reviewer reasons, rules text, welcome/farewell templates, direct-message contents, member-submitted content, attachments, exports, tokens, environment values, or database contents. Metadata is recursively redacted by sensitive key and token pattern; values, collections, cause chains, and stacks are bounded. Safe metadata may include a case/report/appeal number, member ID, menu ID, rules version, delivery type, role-operation counts, state transition, classified Discord failure, and recovery recommendation.

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

`rollout` refuses a non-v10 database. It fast-forwards the selected branch, installs dependencies, runs formatting, typecheck, tests, and a clean build, validates and backs up an existing v10 database, then restarts the service. The default dirty-tree policy refuses tracked changes; `DIRTY_POLICY=stash` stashes tracked changes only and does not move ignored operator data.

An external checkout-directory or service rename is not performed by this repository. Update `APP_DIR`, `SERVICE_NAME`, the systemd unit, working directory, and environment paths together during a separately planned maintenance window.

## Fresh database

With no file at `DB_FILE`, startup creates schema v10 transactionally. An empty existing file is also eligible. If another database exists under an earlier default name while `DB_FILE` is unset, startup and operations refuse to create a second database; select the intended file explicitly and follow the upgrade workflow.

After first startup, run:

```bash
./ops.sh status
```

Joined guilds work immediately with safe core defaults. Phase 4 onboarding, verification, automatic roles, and role menus start disabled. Configure only external-resource workflows whose current Discord channels, roles, messages, hierarchy, and permissions have been verified.

## Required offline migration from schema v9

Schema v9 is the normal source for a 6.1.0 deployment. Build the current schema-v10 release first, but do not start it against v9. Confirm that all processes and maintenance sessions that can write the selected file will be stopped. A dry run performs exact schema classification and the complete conversion in a transaction that is deliberately rolled back:

```bash
cd tsbot
npm ci
npm run build
node dist/src/storage/check-cli.js --db /absolute/path/to/superior.db --expect 9
node dist/src/storage/migrate-cli.js --db /absolute/path/to/superior.db --dry-run
cd ..
```

Run the guarded workflow from the repository root:

```bash
DB_FILE=/absolute/path/to/superior.db ./ops.sh migrate-v9
```

The workflow validates exact v9, stops the service if active, creates and validates a private schema-v9 backup, runs one immediate transaction, validates exact v10 plus integrity and foreign keys, restricts file permissions, and restarts only if the service was previously active. A migration error rolls back the transaction, retains the validated v9 backup, and leaves the service stopped.

The v9-to-v10 step preserves every existing table row, setting, metric, grant, panel, workflow, delivery checkpoint, audit record, and external Discord identifier. It extends the delegated-capability constraint for `onboarding.configure` and `roles.configure` and the panel-preset constraint for `verification` and `roles` without losing existing grants or panels. It adds empty/default-disabled Phase 4 storage and does not invent joins, rules versions, acceptance history, menus, deliveries, or role outcomes. Migration sends no welcome message and performs no Discord role mutation. After migration, start only a schema-v10-capable build and inspect startup/database-check logs. Never run a pre-v10 executable against the migrated database.

## Supported legacy v8, v7, v6, v5, v4, v3, and v2 paths

The v10 migration CLI also accepts exact schema v8, schema v7, schema v6, schema v5, schema v4, schema v3, and the exact supported schema-v2 layout. These paths run the applicable frozen historical conversions followed by v9-to-v10 inside one outer transaction. Dry-run executes and rolls back the whole chain; any failure leaves the source generation unchanged.

For v8, validate with `--expect 8`, retain a schema-v8 backup, and run `DB_FILE=/absolute/path/to/superior.db ./ops.sh migrate-v8`. For v7, use `migrate-v7`; for v6, use `migrate-v6`; and for v5, use `migrate-v5`. Every compatibility command names its source generation and reaches current v10 in one transaction.

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

Schema v1 is not accepted. Before any migration to v10, convert a separate stopped copy with the final 4.0.0 source release until it validates as schema v2, stop that process, retain its backup, and then follow the v2-to-v10 procedure. Renaming a database file never upgrades its contents. Once the working database reaches v10, never open it with a pre-v10 executable.

## Post-migration review

After any successful migration:

```bash
./ops.sh status
./ops.sh logs
```

Review migrated external bindings and persistent routes:

1. Confirm `/config status`; joined guilds should already be active unless an administrator intentionally used the emergency switch.
2. Run `/access list` and verify that only intentional delegated grants exist. A v4/v3/v2 migration creates none.
3. Inspect `/panel status` and exercise existing legacy role, ticket, suggestion, application, resource, help, private-message, and safety controls. Restart and migration do not require reposting. New `verification` and `roles` panels must remain absent or unhealthy until configured from current resources.
4. Inspect ticket department health and recover a representative active migrated ticket before accepting new tickets.
5. Configure suggestions and application forms from current Discord resources when the legacy source did not contain them; migrations do not invent external bindings.
6. Run `/restrictedping list`, verify every retained mapping, then test one disposable `/pingrole` delivery and both cooldowns.
7. Confirm `/moderation status` and `/automod status` show Phase 3 services/rules disabled and no invented historical cases.
8. Configure private moderation/report/appeal bindings from current Discord resources, then test confidential report and eligible appeal review in disposable records before posting a safety panel.
9. Configure one conservative anti-spam rule in a disposable channel, run `/automod test`, then verify deletion, exemption, cooldown, and case/log behavior before wider enablement.
10. Confirm `/onboarding status` shows Phase 4 delivery, verification, and human/bot automatic roles disabled with no invented member history. Verify the private lifecycle-log channel separately from public welcome/farewell destinations.
11. Configure current rules and safe verified/unverified roles, then post a disposable verification panel. Confirm a pending native Membership Screening member receives no human/verification role until screening completes, and confirm verified-role addition precedes optional unverified-role removal.
12. Create one disabled disposable role menu, add only current safe roles, verify its selection limits and prerequisite, enable and post it, exercise every selected mode used by the guild, then inspect `/rolemenu status`. Existing `/superior rolepanel` components must still retain their legacy behavior.
13. In a disposable test workflow, verify ticket closure/transcript delivery, suggestion submit/vote/review, private application submit/claim/decision, and a reversible moderation case.

Do not interpret Discord message IDs alone as healthy bindings. The runtime re-fetches current channels, roles, messages, members, and bot permissions.

## Backup and restore

Create a current backup with:

```bash
./ops.sh backup
```

The backup CLI uses SQLite's online backup API, refuses an existing destination, validates exact schema v10, integrity, and foreign keys, and writes a private timestamped file. It is safe for a running single process; do not copy a live `.db` plus sidecars with ordinary filesystem tools.

Restore a v10 backup into a schema-v10-capable deployment with:

```bash
./ops.sh restore backups/superior-schema10-YYYYMMDDTHHMMSSZ.db
```

Restore refuses the live database as its source. It makes a consistent private candidate through SQLite's backup API and validates it before stopping the service. It keeps the rollback directory on the database filesystem, moves the current database and sidecars there, installs the candidate atomically, validates again, restores the prior files on installation failure, and restarts only when appropriate. Keep the rollback directory until the application and guild checks pass.

Backups are not expired automatically. Define and test retention, encryption, off-host storage, access control, restore drills, and verified deletion appropriate to the deployment. A schema-v10 backup can contain delegated actor/role IDs, persistent panel bindings/content, ticket questions/answers/transcript metadata, suggestion and application content, restricted-ping use, case reasons/private notes, reporter/appellant identities and explanations, staff decisions, message-link identifiers, anti-spam enforcement metadata, administrator-authored rules/templates, member acceptance and lifecycle timestamps, account-age metadata, automatic/menu-role outcomes, and bounded delivery/audit identifiers. Treat every private workflow, onboarding, and moderation field as potentially sensitive.

## Guild export, import, and purge

The guild owner and Administrators can create a bounded same-guild JSON export with `/data export`. Only the owner can run exact-confirmation `/data import` and `/data purge`. Treat import as destructive live-data replacement and keep a protected pre-import export or SQLite-aware backup when rollback may be required.

- Format 8 replaces the complete portable tenant model, including Phase 3 plus onboarding configuration/templates, immutable rule versions, member acceptance/state, automatic-role configuration, bounded lifecycle/audit records, role menus/options/posts, and portable recovery/delivery metadata.
- Legacy format 7 replaces its complete schema-v9-era model and leaves every Phase 4 collection empty/default-disabled.
- Legacy format 6 replaces its complete schema-v8-era model and leaves Phase 3 collections empty/default-disabled.
- Legacy format 5 replaces its schema-v7 portable model, converts its frozen settings to settings v3, and leaves Phase 3 empty/default-disabled.
- Legacy format 4 replaces its complete schema-v5 model and leaves restricted-ping and Phase 3 collections empty/default-disabled.
- Legacy format 3 replaces settings, metrics, panels, and the Phase 1 ticket model. It converts that ticket data to `General Support`, clears Phase 2 collections the old format cannot contain, and leaves Phase 3 empty/default-disabled.
- Legacy format 2 replaces settings and metrics only, preserving every current operational row.

Parsing validates every collection limit, audit-history cap, tenant identity, unique identity, selection bound, and cross-record reference before replacement. Format 8 replacement is one transaction. Every successful import leaves the core guild bot active. Inserted grants are inactive; external service/form/department/restricted-ping/moderation/report/appeal/resource/onboarding/panel/menu bindings are disabled or unverified until administrators inspect current Discord resources and explicitly reconfigure or enable them. Anti-spam and automatic roles remain disabled; verification and role menus require explicit enablement after current-resource validation. Imported acceptance history remains readable to authorized staff but never triggers a role assignment. Imported sanctions are never replayed, and import performs no Discord role mutation.

Guild purge deletes the `guilds` row and schema-v10 tenant data through foreign-key cascades, including all Phase 3 and Phase 4 rows. A Discord `guildDelete` departure instead marks the tenant inactive and retains its rows, panel bindings, and workflow history for a possible rejoin; rejoin restores immediate core availability. Import and purge affect only the live database. They do not remove downloaded exports, backups, SQLite free pages, Discord verification/role-menu panels, suggestion/application/report/appeal messages, moderation or lifecycle logs, ticket channels/transcripts/logs, prior sanctions or role assignments/notifications, direct messages, host logs, or vendor copies. Apply separate retention and verified-deletion procedures to each copy.

## Workflow recovery

- Tickets: `/ticket recover` reconciles interrupted creation/closure, missing channel/control delivery, a lingering channel for a closed record, and Superior-managed support/delegate ACLs. After granting or revoking `tickets.manage`, run recovery separately for every active ticket; revocation blocks controls immediately, but the old role can retain Discord read access until that channel is recovered. Recovery preserves unrelated manual overwrites.
- Suggestions: `/suggestion recover` re-checks stored public delivery, recreates or rebinds a missing suggestion message as supported, and records recovery. Review channel/thread permissions before retrying.
- Applications: `/application recover` is content-review authority and reconciles a missing private review message for a locally binding-verified form—even after submissions are disabled—after revalidating its private channel and reviewer role. Imported unverified forms remain dormant until explicit revalidation. Superior does not edit application review-channel ACLs; grant/form-enable preflights require active `applications.review` roles to have access, and operators remove that Discord access separately after revocation.
- Restricted pings: `/restrictedping list` and `/restrictedping info` expose missing role/channel bindings. Discord role/channel deletion events clean known mappings, while `/pingrole` always performs live validation so downtime cannot turn a missed deletion event into authorization. Use `/restrictedping cleanup-role role_id:<id>` or `/restrictedping cleanup-channel channel_id:<id>` for a stale entry whose deletion event was missed, then re-add only a current safe role/channel pair; do not repair IDs directly in SQLite.
- Moderation cases: `/moderation recover case_number:<number> mode:log` revalidates the log channel and retries its checkpoint without duplicating a successful log. `mode:confirm` applies only to a failed reserved Discord-action attempt and requires current, action-specific proof: a correlated live timeout, an unambiguous active ban, an unambiguous completed unban, an exactly related timeout removal, or an explicit operator assertion for a kick, which has no durable state to query. Appeal timeout removals are reconciled atomically by retrying the current appeal decision instead. `mode:fail` records a bounded explicit failure code on a failed reservation. A Discord punishment remains successful even when downstream logging failed; log recovery must not repeat it. Active timeout, anti-spam-timeout, and ban cases cannot be voided until a separately authorized removal completes.
- Reports and appeals: `/report recover report_number:<number>` and `/appeal recover appeal_number:<number>` require current review authority and revalidate the private destination, reviewer role, tracked record, and case where applicable. They refresh a valid tracked review message, or retire/mark a provably missing or stale tracked message before conditionally posting a replacement; ambiguous Discord lookup or deletion fails closed. Deleted channels/roles disable or invalidate the binding until explicit configuration succeeds; never recover into a public channel. Reviewers can release their own claims. Another reviewer can take over only when Superior proves the prior claimant is absent or has lost current authority; an unavailable member lookup never authorizes takeover.
- Anti-spam: recovery expires or reconciles interrupted enforcement reservations by guild/rule/message/member without inventing success or repeating a case. A restart resets only in-memory detection windows, not persisted cooldowns or duplicate-action protection.
- Onboarding: `/onboarding recover member:<user>` re-fetches the current member, bot membership, screening state, channels, roles, hierarchy, permissions, and runtime generation. It can finish a verified-role/unverified-role partial, incomplete human/bot automatic-role work, interrupted post-screening work, and a welcome or lifecycle-log checkpoint only where retry is safe. A failed send without a Discord receipt may be retried; an ambiguous reserved delivery is not automatically reclaimed, and an ambiguous reservation imported from another database becomes skipped. Recovery must not repeat a delivered public message or DM, overwrite newer configuration, remove an unrelated role, or describe a partial result as complete. Reconfigure deleted welcome/farewell/rules/lifecycle-log channels or verified/unverified/automatic roles before retrying. Account-age warnings remain informational and private.
- Role menus: `/rolemenu status` identifies missing/deleted roles, prerequisites, messages, imported unverified bindings, stale definition versions, and archived/disabled state. `/rolemenu recover slug:<slug> member:<user>` revalidates and retries only that member's newest unresolved plan for the current definition; without `member:`, recovery verifies or reposts bounded message bindings. It preserves the original partial history, adds before removing, preserves unrelated roles, never scans every guild member to reconstruct use, and reports confirmed additions/removals separately when Discord only partially completes a mutation.
- Panels: use the corresponding panel command or `/panel post ... replace_existing:true` after resource health is restored. A verification panel must bind the current enabled rules version; a roles panel must bind an enabled stored role menu. Imported panels remain dormant until current validation.

Recovery actions are designed to be repeatable, but Discord deletion, delivery, thread creation, and DMs remain external best-effort effects. Read the private response and audit state before retrying. Never repair a row by copying an ID from another guild.

## Release rollback

Application and schema generations must match:

- To recover a current deployment while retaining schema v10, deploy only a known-good schema-v10-capable build and restore a validated v10 backup if data restoration is necessary.
- After any database has migrated to v10, do not start, deploy, test, or recommend 6.1.0 or another pre-v10 executable for that installation. Keep pre-migration backups only as protected recovery evidence; use current-version restore tooling, a known-good current build, or a forward fix.
- If a current release regression prevents safe startup, keep the bot stopped, preserve the v10 database, and repair or replace the current build. Do not convert the incident into an application/schema downgrade.

The current `restore` command intentionally accepts only v10. `./ops.sh restore` cannot downgrade a schema or authorize an older executable. A schema-v9 pre-migration backup is evidence and a source for a separately planned forward migration, not a candidate for installation under the active v10 service.

## Verification checklist

- The service account owns `.env`, database, sidecars, backup directory, and lock with restrictive permissions.
- Exactly one bot process is configured to write the database; it is on a local reliable filesystem.
- `./ops.sh status` reports schema 10 and integrity `ok`; foreign-key check is empty.
- The exact schema-v10 tables/indexes exist and no unexpected application views/triggers exist. See [Development](development.md#schema-v10).
- Every expected joined guild appears active; intentionally disabled or departed guilds remain inactive.
- `/config status`, `/access list`, `/panel status`, `/restrictedping list`, ticket department health, a private utility, and deliberate addressed chat work in a test guild.
- Existing legacy role, ticket, suggestion, application, resource, help, private-message, and safety panel controls route without exposing a private record; current verification and role-menu controls reject copied, cross-guild, imported-unverified, or stale bindings.
- Enabled ticket, suggestion, application, restricted-ping, moderation, report, appeal, and anti-spam services pass current channel/role/member/bot permission checks and a disposable end-to-end workflow.
- Private notes never reach member/log output; reports and appeals stay in their separate private destinations; public suggestion output contains no voter identity; user text creates no mentions.
- Anti-spam remains default-disabled until deliberately enabled, stores no raw message content, respects verified exemptions, and does not enforce edits.
- Onboarding remains disabled until configured. Welcome/farewell/templates suppress mentions; DM failure is best effort; only the private lifecycle log receives account-age alerts; the Guild Members intent is enabled; and pending native Membership Screening members receive no human/verification role.
- Rules acknowledgement records one immutable current-version acceptance for the member, is never described as legal consent, adds the verified role before removing the optional unverified role, and exposes any partial outcome to bounded recovery.
- Human and bot automatic-role lists are independently enabled, contain at most 10 safe roles each, and reject dangerous, managed, cross-guild, or unmanageable roles. No configuration change initiates an unbounded member scan.
- Each enabled role menu contains at most 25 options and uses `toggle`, `exclusive`, or `limited` bounds. It changes only its own safe roles, preserves prior access on failed addition, and accurately records a partial removal for recovery.
- Legacy `/superior` member timeout, untimeout, and bounded bulk-timeout actions fail closed until Phase 3 moderation cases are enabled; purge, channel lock/unlock, and slowmode remain independent.
- `/pingrole` produces exactly one approved role notification, rejects the wrong role/channel/thread, and enforces the 60-second user plus 30-second role defaults without an Administrator bypass.
- Global command synchronization has registered `/pingrole`, `/restrictedping`, `/moderation`, `/report`, `/appeal`, `/automod`, `/onboarding`, and `/rolemenu`, and propagation has finished before stale definitions are treated as an incident.
- Logs contain no token, environment value, raw message content, private note, report/appeal body, reviewer reason, application answer, suggestion detail, transcript content, rules text, welcome/farewell template, direct-message content, export, or database content.
