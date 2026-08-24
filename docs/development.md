# Development

The maintained application is a strict TypeScript project in `tsbot/`. Superior requires Node.js 22.12.0 or newer.

## Architecture

- `src/index.ts` loads process configuration and owns startup/shutdown.
- `src/runtime.ts` owns guild runtimes, lifecycle generations, bounded work, and tenant invalidation.
- `src/conversation.ts`, `src/reply-catalog.ts`, and `src/message-runtime.ts` implement deterministic direct-address chat after lifecycle, anti-spam, and moderation precedence checks.
- `src/discord/commands.ts` and `src/discord/bot.ts` register and route slash commands, autocomplete, buttons, modals, string select menus, and shutdown-tracked member lifecycle events. The interaction lifecycle acknowledges private work before database/network latency, preserves immediate modal responses, and attaches safe correlation/timing fields to failures. Unknown or obsolete components fail safely.
- Focused modules under `src/discord/` own delegated authorization, onboarding commands/permissions/recovery, lifecycle template validation/rendering, rules acceptance, member lifecycle delivery, role safety, persistent role-menu commands/components, panels, ticket departments/workflow, suggestions, applications, restricted role pings, moderation cases, reports, appeals, anti-spam, utilities, and Discord boundary checks.
- Focused repositories under `src/storage/` own delegated grants, onboarding/rules/member/role-delivery state, role menus/options/posts/member operations, ticket departments, operational ticket lifecycle, suggestions, applications, restricted-ping configuration/cooldowns/audit, moderation cases/delivery, reports, appeals, anti-spam rules/enforcement, schema classification, import/export parsing, and backup/check/migration CLIs.

Do not add a second conversational parser, storage path, authorization model, or purge command. Keep member-controlled text normalized and escaped before display, set `allowedMentions: { parse: [] }` on operational payloads, and verify every persisted Discord identity against the current guild.

## Authorization model

The centralized authorization path re-fetches the acting guild member and any configured or delegated role. Guild owner and Administrator checks happen before delegated storage is read, preserving recovery authority if a grant is missing or malformed. Active delegated role grants provide only one of:

- `panels.manage`
- `tickets.configure`
- `tickets.manage`
- `suggestions.configure`
- `suggestions.review`
- `applications.configure`
- `applications.review`
- `moderation.configure`
- `moderation.manage`
- `reports.review`
- `appeals.review`
- `onboarding.configure`
- `roles.configure`

The schema records a principal type so future versions can add individual-user grants, but schema v10 creates role grants only. `/access` mutations remain owner-or-Administrator-only and reject `@everyone`, managed, missing, duplicate, stale, and cross-guild roles. `onboarding.configure` and `roles.configure` are independent and imply no review, ticket, or moderation authority. Workflow-specific support/reviewer roles and delegated capabilities share the same fresh-verification boundary without merging configuration, member-role mutation, moderation management, and private-content authority.

`/restrictedping` is separately owner-or-Administrator-only and is not delegated through `/access`. `/pingrole` is a member action whose authority comes from live membership in the exact configured role plus the exact channel/thread mapping, never from configuration authority. The role must remain non-mentionable and pass a fail-closed dangerous-permission/managed-role screen. Every execution freshly verifies the member, role, channel or exact parent, and effective user/bot permissions before attempting Discord delivery.

## Reusable forms and workflow boundaries

Ticket department fields and application questions use the typed form-definition layer for field type, ordering, Discord modal limits, normalization, length validation, rendering, and response validation. A definition has 1–5 short/paragraph inputs; labels, optional guidance/placeholders, min/max length, required state, stable field ID, and order are stored explicitly.

The abstraction stops at form handling. Ticket reservation/channel lifecycle, suggestion cooldown/voting/review, and private application review remain separate repositories and interaction modules. Suggestions use their own fixed title/details modal rather than pretending to be a configurable form.

Correctness-sensitive transitions are database-backed:

- one active ticket per opener/department plus a transactional three-ticket guild cap;
- conditional ticket activation, claim/release, close, log checkpoint, and recovery;
- persisted suggestion cooldown timestamps, one vote per user/suggestion, atomic vote switching/removal, and conditional state changes;
- one active application per applicant/form plus conditional delivery, claim, withdrawal, decision, and recovery; and
- persisted per-user/per-role and guild-wide/per-role restricted-ping cooldowns, with one bounded durable delivery reservation per role;
- guild-local case numbering, bounded case audit, and checkpointed moderation-log delivery;
- report cooldown/reservation, conditional claim/decision/withdrawal, and private-delivery recovery;
- one appeal per case, conditional claim/decision/withdrawal, and verified Discord reversal before an overturn is recorded;
- anti-spam enforcement reservations keyed by guild/rule/message/member plus persisted cooldown/idempotency state; and
- immutable rules versions, one idempotent member/version acceptance, deferred native-screening work, and bounded per-role onboarding delivery outcomes;
- role-menu definition versions/posts plus serialized member/menu operation plans that preserve exact partial Discord outcomes; and
- stable guild/channel/message/component identities for repeated or restarted deliveries.

Discord API calls are performed outside long SQLite transactions. A failed external call leaves a bounded failure/recovery state instead of holding a write lock or inventing success.

Restricted-ping execution uses a short immediate transaction to validate cooldown timestamps and atomically claim a role-scoped reservation containing the requesting user, channel, source, and expiry. Discord receives only the canonical role token with an explicit one-role allowed-mentions allowlist. A second request cannot pass while the reservation is live. Successful delivery is finalized in another immediate transaction that updates role/user success timestamps and counters and appends the audit event; a Discord failure releases the reservation without advancing either successful cooldown. An expired reservation can be reclaimed after a process interruption. There is no cooldown bypass, and no Discord API call occurs inside the transaction.

## Schema v10

Schema v10 retains every schema-v9 table and adds normalized Phase 4 storage without application views or triggers:

| Area       | Normalized records                                                                                                  | Purpose                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Onboarding | One configuration, automatic-role rows, member state, delivery/recovery rows, and bounded lifecycle audit per guild | Verified channel/role bindings, pending-screening work, exact partial delivery outcomes, and bounded retention |
| Rules      | Immutable guild-local rule versions and member/version acceptances                                                  | Current-versus-older acknowledgement, idempotency, preserved history, and safe re-acknowledgement              |
| Role menus | Menus, ordered options, published message bindings, and bounded member operation/audit rows                         | Stable slugs/opaque IDs, definition versions, selection limits, exact Discord outcomes, health, and recovery   |

Every tenant-owned row has `guild_id` directly or through a guild-scoped composite reference. Foreign keys cascade from `guilds`; child rows use composite guild/object references to prevent cross-tenant attachment. Checks bound opaque IDs, Discord snowflakes, slugs, templates/rules text, enum states, menu modes and selection limits, timestamps, delivery details, and enabled-resource invariants. Unique constraints protect guild-local rules versions/menu slugs, member/version acceptance, menu option-role identity, menu channel/message bindings, and idempotent member operations.

Indexes cover existing operational lookups plus guild/member onboarding state and recovery, rules/member acceptance, chronological lifecycle audit, menu slug/state/version, option order/role, published message, and member/menu operation state. Discord API work remains outside SQLite transactions. State changes use short conditional/immediate transactions, and a stale snapshot cannot overwrite a newer configuration, panel binding, rules version, or menu definition.

All interaction and administrative queries have explicit bounds, count/exists variants, or pagination. Rules retain at most 25 immutable versions per guild; automatic roles are capped at 10 human and 10 bot roles; menus/options are capped at 25 per guild/menu. Onboarding and role-operation audit/delivery collections use explicit per-guild row ceilings enforced by repository cleanup and import validation. Existing parent audits retain their documented latest-100-event bound. Format-8 parsing caps every portable collection. These are import and recovery safety ceilings, not promises that an operator should retain every eligible row for the maximum duration.

Onboarding persists Discord IDs, configuration/templates/rules, acceptance timestamps, safe lifecycle metadata, delivery identifiers, and exact role outcomes. It never stores member message content, DM contents, full member profiles, IP/email/phone data, invite history, or raw gateway payloads. Anti-spam and private-workflow data retain the existing schema-v9 minimization boundaries. User-controlled rules/templates/private text are excluded from terminal logs.

## Initialization and migration

A missing or empty database is initialized transactionally at v10. Startup accepts exact v10 only and refuses v1 through v9, malformed, partial, and unknown layouts. Schema upgrades are explicit offline operator actions.

The v9-to-v10 migration validates the exact source and completes in one immediate outer transaction. It preserves every v9 row, setting, metric, grant, panel, ticket, suggestion, application, restricted-ping, moderation, report, appeal, anti-spam, delivery, audit, and external Discord identifier. It rebuilds only the delegated-capability and panel-preset constraints needed for `onboarding.configure`, `roles.configure`, `verification`, and `roles`, preserving existing grants/panels exactly, and adds empty/default-disabled Phase 4 tables. It never invents a join, acceptance, rules version, menu, or role outcome and performs no Discord delivery or mutation. Dry-run executes this complete transaction and deliberately rolls it back; any failure leaves the source exact v9.

The v8-to-v9, v7-to-v8, v6-to-v7, v5-to-v6, v4-to-v5, v3, and supported-v2 conversions remain frozen compatibility stages. Exact v2-v8 sources run their applicable stages and then v9-to-v10 within the same outer transaction. Every supported legacy path reaches v10 with empty/default-disabled Phase 4 data. V1 must first be upgraded to the supported v2 layout with the final 4.0.0 release. See [Operations](operations.md) for commands and rollback.

## Guild export and import

Guild export format 8 includes the complete portable tenant product model, subject to collection bounds. In addition to format 7, it carries onboarding configuration, immutable rules versions, member acceptance/state, automatic-role configuration, bounded lifecycle/audit data, role menus/options/posts, and portable recovery/delivery metadata. Parsing validates guild ownership, collection limits, unique identities, enum/text constraints, and cross-record references before mutation.

- Format 8 is a complete transactional replacement of settings, metrics, and all portable current operational collections.
- Legacy format 7 remains a complete replacement for its schema-v9 era and leaves Phase 4 collections empty/default-disabled.
- Legacy format 6 remains a complete replacement for its schema-v8 era and leaves Phase 3 collections empty/default-disabled.
- Legacy format 5 replaces its schema-v7 model, converts frozen settings v2 into the current settings v3 defaults, and leaves Phase 3 empty/default-disabled.
- Legacy format 4 remains a complete replacement for its schema-v5 era and leaves restricted-ping and Phase 3 collections empty/default-disabled.
- Legacy format 3 is a complete operational replacement for its era. Its ticket configuration/history becomes one `General Support` department plus Subject/Details responses; collections absent from format 3, including Phase 3, are empty/default-disabled after replacement.
- Legacy format 2 remains a partial compatibility import: it replaces settings and metrics and deliberately preserves current operational rows.

Every import leaves the core guild bot active. Inserted grants are inactive; external departments/forms, suggestion/restricted-ping/moderation/report/appeal/onboarding/menu configuration and Discord bindings remain disabled or unverified until current resource/permission checks succeed. Imported anti-spam rules and automatic roles remain disabled; verification and role menus require explicit enablement after revalidation; imported acceptance history never triggers role assignment; historical sanctions are never replayed; and authorized staff may still read imported history. Non-portable internal delivery deduplication is preserved across imports.

## Local workflow

```bash
cd tsbot
npm ci
npm run format
npm run format:check
npm run typecheck
npm test
npm run build
node --check dist/src/index.js
```

`npm run build` removes `dist/` first and compiles only `src/**/*.ts` through `tsconfig.build.json`. Tests are never copied into production output.

The database CLIs require explicit paths and schema expectations:

```bash
npm run db:check -- --db /path/to/database.db --expect 10
npm run db:backup -- --db /path/to/database.db --out /new/path/backup.db --expect 10
npm run migrate -- --db /path/to/database.db --dry-run
```

Use `--expect 10` for an active database and `--expect 9`, `8`, `7`, `6`, `5`, `4`, `3`, or `2` only to validate the corresponding migration source. The backup destination must not already exist. Omit `--dry-run` only during a stopped, validated, backed-up maintenance window.

Run `npm run security:check`, `bash -n ../ops.sh`, ShellCheck when available, and `git diff --check` before release. The security command enforces the high-severity production-audit threshold, validates the complete dependency tree, scans tracked text for high-confidence credentials and production snowflakes, checks private/runtime ignore boundaries, rejects deprecated private interaction responses, and rejects runtime version overrides. Do not use `npm run dev` or `npm start` merely to validate a change; those commands can log in and touch the selected database. Tests must use synthetic temporary databases and never an operator `.env`, token, live database, or backup.

## Windows packaging

From a Windows x64 checkout with Node.js available for development:

```powershell
cd tsbot
npm ci
npm run package:win:verify
cd ..
$archive = Get-ChildItem .\release\SuperiorBot-*-win-x64.zip
.\windows\test-portable.ps1 -Artifact $archive.FullName
.\windows\test-standalone.ps1 -Executable .\SuperiorBot.exe
```

The builder verifies SHA-256-pinned tool/runtime inputs, normalizes launcher source, produces deterministic ZIP metadata, and embeds the ZIP into the repository-root self-extracting `SuperiorBot.exe`. `package:win:verify` performs two clean-staging builds and requires byte-for-byte identical ZIP and executable output. Use `package:win` for one local iteration. Cache, staging, and release output are ignored; the requested standalone executable is tracked.

## Version and release workflow

`tsbot/package.json` is the only hand-edited semantic version. The lockfile, generated runtime constant, portable `VERSION`, payload build identity, launcher assembly metadata, and artifact filename are derived from it. `BOT_VERSION` and npm lifecycle variables cannot alter the reported version.

From `tsbot/`, the easiest complete releases are:

```powershell
npm run release:patch # compatible fix; increments patch once
npm run release:minor # backward-compatible feature; increments minor once
npm run release:major # breaking behavior; increments major once
```

Each command bumps exactly once, generates/verifies the lockfile/runtime/documentation version markers, and then runs local-link and PowerShell checks, formatting verification, typecheck, all tests, the security gate, a clean production build, every compiled-JavaScript syntax check, two-build Windows reproducibility, portable and standalone smoke tests, `--version`, `--check`, safe diagnostics, PE metadata checks, payload/source identity checks, and final SHA-256 reporting. If any validation fails after the bump, fix it and run `npm run release:build`; do not run the patch/minor/major wrapper again. `release:build` is idempotent and never increments the version.

For a controlled manual bump, use `npm run version:bump -- patch`, `minor`, or `major`, then `npm run version:verify` and `npm run release:build`. If `scripts/version.mjs` is unavailable or fails integrity review, stop: restore that exact tracked file from the trusted release source before changing a version, then run the normal non-bumping workflow. The generator is the authority for the lockfile and `src/generated-version.ts`; there is no safe scriptless release path. Never hand-edit the portable `VERSION`, C# metadata, or executable.

CI runs the non-mutating version/security checks, verifies the committed executable's embedded source identity before rebuilding, rebuilds it twice, and fails if `git diff -- SuperiorBot.exe` is nonempty. A source or version change therefore cannot silently retain an old tracked executable.

For this backward-compatible Phase 4 feature release, run `npm run release:minor` once from `tsbot/`. The complete pre-commit gate also includes `bash -n ops.sh`, ShellCheck when available, and repository-root `git diff --check`; these checks are outside the Windows release wrapper. Confirm `npm run artifact:verify` after the reproducible build, stage only Phase 4 plus generated release files, and inspect `git diff --staged` before committing.

The individual non-bumping checks, useful when diagnosing a failed release build, are:

```text
npm run version:verify
npm run docs:links
npm run powershell:check
npm run format:check
npm run typecheck
npm test
npm run security:check
npm run build
node --check dist/src/index.js        # repeat for every dist/src/**/*.js
npm run package:win:verify
../windows/test-portable.ps1 -Artifact ../release/SuperiorBot-<version>-win-x64.zip
../windows/test-standalone.ps1 -Executable ../SuperiorBot.exe
npm run artifact:verify
```

## Change rules

- Change only the package version through the version workflow; generated runtime and artifact metadata must pass `version:verify` and release verification.
- Add regression tests for parsing boundaries, fresh permission/resource verification, private-content exposure, concurrency, idempotency, partial Discord failures, tenant isolation, migration rollback, import compatibility, and any material review finding.
- Keep migration-only compatibility literals isolated from active runtime definitions.
- Review command definitions, autocomplete, dispatch, component routing, help text, docs, and registration together when changing a command.
- Do not use global caches for operational guild state or put Discord calls inside storage transactions.

## Deployment and future boundaries

Superior supports one bot process with a local SQLite database. SQLite WAL/transactions, unique constraints, conditional updates, and bounded delivery reservations make concurrent work within that process safe; they do not provide leader election, distributed locks, or safe horizontal writes by several bot processes. Do not place a shared live database on a network filesystem or advertise multi-process support.

Later phases may add polls, giveaways, starboard/highlights, reminders, scheduled announcements, community events, bounded dry-run member backfill, in-Discord server analytics/retention views, and stronger archival/retention tools. An optional external dashboard remains deferred unless the owner deliberately chooses it. Captchas, external OAuth verification, phone/email collection, invite tracking, AI account-risk scoring, automatic age-based punishment, arbitrary scripts/template code, and public member history are outside Phase 4.

Future scale work may keep the focused repository interfaces while replacing storage/coordination, adding workers, or introducing stronger pagination/archival policy. Distributed storage or multi-process coordination requires a separate architectural redesign and migration; it is not a configuration mode of the single-process SQLite release.
