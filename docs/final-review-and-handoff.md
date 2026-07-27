# Imperial Court Bot 2.0.1: Final Review and Handoff

Date: July 27, 2026

This document records the completed multi-server redesign, the subsequent full-codebase review and hardening pass, the release validation, and the operational boundaries observed while doing the work.

## Outcome

Imperial Court Bot is now a multi-tenant Discord application designed to run as one Discord application, one Node.js process, and one SQLite database while serving independently configured guilds. Configuration, mutable state, schedules, command behavior, metrics, cooldowns, posts, questions, answers, and background work are scoped to a guild.

The work spans two commits:

1. `28dc0a44b60e1baec55f247a442273c2438c590b` — `feat(multitenancy): support independent guild configuration`
2. The commit containing this report — `fix(multitenancy): harden final release`

The release version moved from 1.0.1 to 2.0.0 for the architectural redesign, then to 2.0.1 for the review-discovered fixes and operator-visible hardening.

## Multi-Server Redesign

### Process configuration and command registration

- Split process-wide configuration from guild-owned settings.
- Reduced process configuration to values such as the Discord token, database path, command-registration mode, development guild IDs, operator metadata, and scheduler concurrency.
- Made production command registration global by default.
- Added development registration for every validated `DEV_GUILD_IDS` entry.
- Retained `TEST_GUILD_ID` only as a deprecated legacy-migration fallback; it no longer selects the runtime guild.
- Added registration planning and synchronization tests, including stale global/guild command cleanup and partial-failure behavior.
- Added a sanitized `.env.example` without live IDs or secrets.

### Per-guild settings

- Added a centrally validated, versioned `GuildSettings` model.
- Made feature flags, channels, roles, display labels, Invictus triggers, schedules, limits, retention, champion binding, greeting profiles, and timezone configurable per guild.
- Added neutral defaults: disabled guild, UTC, no Discord IDs, no enabled features, empty role lists, null channel/user bindings, court scheduling off, Imperial labels, and the `invictus` keyword.
- Removed active-runtime dependence on server-specific hard-coded role, channel, and user IDs.
- Kept compatibility-only legacy defaults isolated to the v1 migration module.

### Runtime and tenant isolation

- Added explicit guild-scoped runtime and storage contexts.
- Required event handlers, commands, interactions, scheduled jobs, and storage operations to derive a guild context.
- Rejected unsupported DM use.
- Prevented unconfigured, disabled, inactive, or left guilds from producing message-trigger, moderation, metric, posting, or background-job side effects.
- Made backfill status, timezone helpers, feature checks, and permission policy guild-local.
- Added cross-guild channel/message checks so stored Discord objects cannot be resolved through another tenant.

### SQLite schema and storage

- Added schema migration tracking, guild metadata, and persisted guild settings.
- Added `guild_id` to all tenant-owned tables.
- Implemented guild-scoped logical keys for `kv`, `posts`, `answers`, `metrics`, and `anon_cooldowns`.
- Added guild-scoped indexes for open posts, dated answers, answer-message lookup, and enabled-guild enumeration.
- Enabled foreign-key validation and exact current-schema validation.
- Scoped state, question pools, posts, answers, metrics, cooldowns, schedules, royal state, retention, imports, exports, and purge operations.
- Preserved compatibility for rounded version 1 per-user metric keys while using exact Discord ID strings for version 2 writes.

### Legacy v1 migration

- Added an explicit `npm run migrate` command; normal startup refuses an outdated or unknown database instead of migrating implicitly.
- Added read-only database classification and validation through `npm run db:check`.
- Implemented an idempotent, transactional v1-to-v2 migration.
- Required `LEGACY_GUILD_ID` when legacy rows exist, with `TEST_GUILD_ID` accepted only as the deprecated fallback.
- Preserved legacy state, questions, posts, answers, metrics, cooldowns, schedules, channels, royal state, history, and used-question data under the legacy guild.
- Seeded legacy guild settings from the effective v1 environment/database state without exposing those defaults to new guilds.
- Verified source/copy row counts, keys, indexes, foreign keys, schema version, and integrity before commit.
- Added synthetic temporary-database migration fixtures and rollback/idempotency coverage. The live database was never used as a test fixture.

### Guild lifecycle and setup

- Added `guildCreate` and `guildDelete` lifecycle handling.
- New and rejoined guilds remain disabled until setup is reviewed and explicitly enabled.
- Leaving a guild records inactivity and stops work without deleting its data.
- Added owner/administrator-authorized `/setup` commands for status, enable, disable, channels, roles, features, schedules, limits, triggers, greetings, validation, export, and purge.
- Added dependency, channel, permission, role hierarchy, schedule, timezone, moderation, and anonymous-answer validation.
- Restricted purge to the guild owner with exact confirmation, and scoped it to that guild only.
- Preserved compatible `/court` configuration aliases as guild-scoped operations.

### Existing Discord features

- Made court status/health, question management, manual/automatic posts, thread closure, anonymous answers, role panels, moderation, Invictus chat, reply moderation, silence lock, royal AFK/presence, greetings, weekly digest, retention, analytics, metrics, backfill, and state import/export guild-aware.
- Added configurable greeting profiles in place of fixed user presentations.
- Made Invictus invocation keywords and royal display labels configurable.
- Verified component interactions from the actual message guild rather than trusting custom IDs alone.
- Prevented fallback logging and stored Discord-object lookup from crossing guild boundaries.

### Background jobs

- Reworked background loops to enumerate enabled guilds with bounded concurrency.
- Applied each guild's timezone, configuration, local dates, schedules, and retention.
- Isolated one guild's job failure from all other guilds.
- Included guild IDs in structured operational logs.
- Added idempotency, local-date, timezone, cross-guild rejection, and failure-isolation coverage.

### Bootstrap data

- Replaced tracked state with a neutral guild-state template.
- Kept reusable questions as a per-guild seed source.
- Ensured each guild receives independent question/state copies.
- Kept tracked answer bootstrap data empty.
- Removed live channel IDs, dates, post history, and server-specific mutable state from templates.

### Documentation and operations

- Rewrote the root README and configuration, development, operations, capability, and trigger references for version 2.
- Documented setup, installation, command registration, schema, migration, backup, restore, rollback, validation, and post-migration checks.
- Rebuilt `ops.sh` around read-only preflight, SQLite-consistent backups, explicit migration, post-migration verification, validation, build, service restart, and recovery.
- Ensured operator backups are uniquely named, validated, retained, and never automatically deleted.
- Prevented validation commands from performing a live Discord login.

## Full-Codebase Review and Hardening

The final review covered storage and migration atomicity, schema compatibility, tenant isolation, Discord concurrency, lifecycle state transitions, setup rollback, moderation safety, background cancellation, shutdown ordering, deployment scripting, dependencies, formatting, documentation, and ignored live artifacts.

| Area                   | Review finding                                                                           | Resolution                                                                                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Migration              | Schema classification and source reads could race another database writer.               | Acquire `BEGIN IMMEDIATE` before classification and retain the lock through source reads, transformation, verification, and commit. Added a two-connection `SQLITE_BUSY` regression. |
| Schema validation      | Column-name/key checks alone could accept weakened v2 table definitions.                 | Validate normalized table SQL, including required defaults and `CHECK` constraints.                                                                                                  |
| Migration integrity    | Duplicate imported `answer_message_id` values could create ambiguous lookups.            | Reject duplicates atomically and leave the legacy database unchanged.                                                                                                                |
| Legacy settings        | The string value `"0"` could be confused with an absent optional Discord ID.             | Treat `"0"` as explicit null and reserve fallback behavior for absent/empty input.                                                                                                   |
| Guild lifecycle        | Leave/rejoin/enable operations had an ABA window.                                        | Added a monotonic `joined_at` generation token and compare-and-swap enable checks without changing the published v2 schema.                                                          |
| Guild lifecycle        | Internal reactivation tokens could look like a new Discord rejoin on every restart.      | Only treat a strictly newer observed Discord join as an offline rejoin; added stable-startup and repeated-rejoin coverage.                                                           |
| Guild lifecycle        | A startup-unavailable Discord guild could miss reconciliation permanently.               | Defer it without marking it left, then reconcile through a tracked `guildAvailable` handler when Discord restores availability.                                                      |
| Reactivation           | A stale in-memory settings snapshot could overwrite newer persisted settings.            | Read and update current settings inside one immediate transaction.                                                                                                                   |
| Setup                  | Question seeding occurred before configuration enablement was durably accepted.          | Seed only after successful settings CAS, and restore the exact prior enable/settings state if seeding fails.                                                                         |
| Setup                  | Silence validation used raw targets even when runtime exclusions removed every target.   | Share one de-duplicated effective-target calculation, reject zero non-excluded targets, and skip excluded roles during hierarchy checks.                                             |
| Metrics                | Anonymous answer, cooldown, user metric, and aggregate metric updates were separate.     | Make all answer admission writes one transaction; failure injection proves complete rollback.                                                                                        |
| Anonymous answers      | Queued submissions could miss acknowledgement or race cooldowns across questions.        | Defer ephemerally before network/queue work, serialize by guild/user and guild/question, and repeat all admission checks inside the queues.                                          |
| Anonymous answers      | A sent Discord answer could remain untracked after invalidation or persistence failure.  | Delete the sent message when final validation or database persistence fails, and log cleanup failures.                                                                               |
| Runtime work           | Event, background, or detached backfill promises could outlive storage shutdown.         | Track ready, lifecycle, interaction, message, reaction, background, and awaited backfill work; cancel between discovery calls and perform a bounded drain.                           |
| Shutdown               | Repeated signals could overlap, and destroying Discord before draining broke REST work.  | Use one promise-idempotent coordinator: stop/invalidate, drain while Discord remains usable, then destroy the client and close storage.                                              |
| Silence lock           | Restart/crash paths could lose the original channel permission overwrite.                | Persist an exact per-guild lease containing the original `SendMessages` tri-state before applying denial.                                                                            |
| Silence lock           | Overlapping locks and restoration could race.                                            | Serialize lease work per guild, reuse the original baseline, and extend to the maximum active deadline.                                                                              |
| Silence lock           | Expired locks needed recovery after restart.                                             | Reconcile leases at startup and on a five-second background interval, including disabled but active guilds.                                                                          |
| Silence lock           | A definitively deleted lease target could block owner purge forever.                     | Distinguish null/Discord 404/unknown targets from transient failures, discard only definitive deletions, and retain unresolved transient leases.                                     |
| Silence lock           | Invalid lease metadata could be silently discarded or exported across guilds.            | Fail closed on malformed/duplicate metadata, exclude the reserved lease metric from portable exports, reject it on import, and preserve the exact current row during imports.        |
| Purge safety           | Purge could delete the only metadata needed to restore channel permissions.              | Disable and invalidate first, restore every lease, and refuse/preserve data if metadata is corrupt or any target remains unresolved.                                                 |
| Command sync           | A stale-scope clear or one development-guild failure could hide other failures.          | Attempt every required scope and reject with an `AggregateError` retaining all original causes.                                                                                      |
| Health checks          | Court health did not fully match setup validation.                                       | Check message history and conditional thread permissions, missing bot membership, and anonymous thread validity.                                                                     |
| Backfill               | Work could detach after acknowledgement, miss thread history, or ignore invalidation.    | Await the worker inside tracked interaction work and scan announcement plus accessible active/archived threads with cancellation checks between Discord calls.                       |
| Moderation             | Server-wide mute operations could act on an incomplete member cache.                     | Abort when the complete member fetch fails and operate on the returned collection only.                                                                                              |
| Moderation             | Timeout paths did not consistently verify bot permission and hierarchy.                  | Require `ModerateMembers` and target `moderatable` for preview and execution, including reply moderation.                                                                            |
| Permission diagnostics | Lock/unlock errors named the wrong permission.                                           | Report the required Discord `Manage Roles` permission consistently.                                                                                                                  |
| Deployment             | Environment/database path normalization could differ from Node's runtime behavior.       | Normalize with JavaScript `String.trim()` semantics and cover whitespace-only/NBSP values.                                                                                           |
| Deployment             | Pull/stash behavior could move or overwrite untracked/ignored operator files.            | Stash tracked changes only and use a single fetched commit with `git merge --ff-only --no-overwrite-ignore FETCH_HEAD`.                                                              |
| Deployment             | Runtime data permissions and Node compatibility were underspecified.                     | Apply a private `0077` umask, enforce safe database file types/modes, require Node 22.12.0+, and document matching service ownership/`UMask`.                                        |
| Release validation     | The Node floor regression checked `package.json` but not lockfile drift or the boundary. | Assert the lockfile engine and execute the operations preflight against rejected 22.11.9 and accepted 22.12.0/23.0.0 versions.                                                       |
| Dependencies           | The starting dependency graph reported seven audit findings.                             | Updated compatible dependencies/tooling and regenerated the lockfile; the final audit reports zero vulnerabilities.                                                                  |
| Formatting             | The repository lacked one enforced format policy.                                        | Added Prettier configuration, safe exclusions, npm format/check scripts, LF normalization, and a CI formatting gate.                                                                 |

## Test and Validation Coverage

The original baseline had 39 tests across 7 files. The architectural redesign raised this to 137 tests across 16 files. The final hardening pass finishes with 206 passing tests across 25 files.

The suite now covers, among other behavior:

- two-guild isolation for settings, state, questions, posts, answers, cooldowns, metrics, schedules, royal state, import/export, backfill, and purge;
- exact schema recognition, synthetic v1 migration, idempotency, rollback, locking, row preservation, duplicate detection, and unknown/partial-schema refusal;
- neutral defaults and independent bootstrap copies;
- disabled, inactive, left, rejoined, and re-enabled guild lifecycle behavior;
- setup authorization, validation, compare-and-swap enablement, seeding rollback, export, and purge;
- global/development registration planning, stale-scope cleanup, and aggregated failures;
- anonymous-answer serialization, cleanup, cooldowns, and transaction rollback;
- silence-lease overlap, persistence, restart reconciliation, corruption handling, import/export, and purge refusal;
- background-loop lifetime, bounded concurrency, per-guild failure isolation, and graceful shutdown;
- backfill coverage, moderation permissions/hierarchy, cross-guild Discord object rejection, and command parity;
- deployment-script environment normalization, ignored-file collision safety, and tracked-only autostash behavior.

Final release commands and checks:

- `npm ci` from the committed lockfile;
- `npm audit` with zero reported vulnerabilities;
- `npm ls --all` with a valid dependency tree;
- `npm run format:check`;
- `npm run typecheck`;
- `npm test` — 25 files and 206 tests passed;
- `npm run build`;
- `node --check dist/src/index.js`;
- TypeScript unused-local/unused-parameter audit;
- parse every tracked bootstrap JSON file;
- `bash -n ops.sh` and ShellCheck;
- `git diff --check` and full staged-diff review;
- static scans for obsolete production IDs, singleton guild behavior, and unscoped tenant SQL.

No live Discord login was used for validation.

## Protected Live Data

The ignored root database, SQLite sidecars, environment file, backups, dependencies, build output, prompts, and editor state were not staged.

The live-data baseline recorded before review was:

| Artifact                                     |         Size | SHA-256                                                            |
| -------------------------------------------- | -----------: | ------------------------------------------------------------------ |
| `court.db`                                   | 69,632 bytes | `E768AFF3822261EBB9DB745CEBFAC8EB27B2293C3CEA4A8C1120A516B90BF1B9` |
| `court.db-shm`                               | 32,768 bytes | `FD4C9FDA9CD3F9AE7C962B0DDF37232294D55580E1AA165AA06129B8549389EB` |
| `court.db-wal`                               |      0 bytes | SHA-256 of an empty file                                           |
| `backups/court-predeploy-20260419-231141.db` | 69,632 bytes | `E768AFF3822261EBB9DB745CEBFAC8EB27B2293C3CEA4A8C1120A516B90BF1B9` |

The matching backup sidecars and the earlier `court-predeploy-20260419-231106` sidecars were preserved. The hashes are rechecked before commit and after push. No migration, restore, service restart, live database write, or live Discord connection was performed during development or validation.

## Deployment Handoff

For the existing production guild, follow `docs/operations.md` exactly:

1. Verify the selected environment and `LEGACY_GUILD_ID` without printing secrets.
2. Stop version 1 before migration.
3. Validate the exact source database read-only.
4. Create and validate a SQLite-consistent pre-migration backup.
5. Run the explicit v2 migration while the database is offline.
6. Validate integrity, foreign keys, schema, keys, indexes, and required row counts.
7. Install, typecheck, test, build, and syntax-check the locked release.
8. Start version 2 and verify `/setup status`, `/setup export`, and `/setup validate` before enabling behavior.

Rollback to version 1 requires keeping the service stopped, restoring the exact validated pre-migration v1 backup first, reinstalling/building the prior release from its lockfile, and only then starting the old application. Never run a v1 binary against a v2 database.

## Intentional Boundaries and External Checks

The repository is complete for the requested code change, but deployment still requires verification of external state:

- Discord global commands propagate asynchronously after registration.
- Developer Portal intents, installation scopes, guild permissions, bot role hierarchy, accessible archived/private threads, and configured channel/role existence must be checked in Discord.
- The external systemd unit, user/group, working directory, environment path, `UMask=0077`, sandboxing, restart policy, disk space, and off-host backup retention are outside this repository.
- The runtime and lease coordination are intentionally designed for one Node.js process. Running multiple writers would require a distributed coordination design.
- A malformed silence-lease row or a transiently inaccessible lease target blocks purge conservatively until an operator repairs or resolves it. A definitive null/404/unknown channel or role is discarded because no permission overwrite can remain on a deleted target.
- No live migration or Discord login was attempted. The first real migration must use the guarded offline runbook and the preserved backups.

Discord permission and thread behavior were checked against the official [Discord channel resource documentation](https://docs.discord.com/developers/resources/channel), [Discord threads documentation](https://docs.discord.com/developers/topics/threads), and [discord.js `GuildMember` documentation](https://discord.js.org/docs/packages/discord.js/14.19.2/GuildMember%3AClass).

## Changed Areas

The combined release changes include:

- root configuration and safety files: `.env.example`, `.gitattributes`, `.gitignore`, `.prettierignore`, `.prettierrc.json`, CI, README, and `ops.sh`;
- neutral bootstrap state under `data/bootstrap/`;
- configuration, development, operations, capability, trigger, and final-handoff documentation;
- process configuration, guild settings, runtime, parity, constants, and startup/shutdown code;
- Discord lifecycle, command registration, setup, command dispatch, runtime jobs, work tracking, keyed serialization, and persistent silence leases;
- storage schema, database access, schema classification, migration CLI, migration compatibility, and database validation CLI;
- package metadata, engine requirement, dependency lockfile, Prettier, TypeScript, and Vitest tooling;
- 25 test files covering storage, migration, tenant isolation, lifecycle, setup, registration, commands, background work, shutdown, deployment, moderation, anonymous answers, and silence leases.

This report is the final in-repository handoff for the multi-server redesign and codebase review.
