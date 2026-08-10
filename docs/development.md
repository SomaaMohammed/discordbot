# Development

The maintained application is a strict TypeScript project in `tsbot/`. Superior 5.4.0 requires Node.js 22.12.0 or newer.

## Architecture

- `src/index.ts` loads process configuration and owns startup/shutdown.
- `src/runtime.ts` owns guild runtimes, lifecycle generations, bounded work, and tenant invalidation.
- `src/conversation.ts`, `src/reply-catalog.ts`, and `src/message-runtime.ts` implement deterministic direct-address chat after lifecycle and moderation precedence checks.
- `src/discord/commands.ts` and `src/discord/bot.ts` register and route slash commands, autocomplete, buttons, modals, and string select menus. Unknown or obsolete components fail safely.
- Focused modules under `src/discord/` own delegated authorization, reusable modal forms, panels, ticket departments/workflow, suggestions, applications, restricted role pings, moderation, utilities, and Discord boundary checks.
- Focused repositories under `src/storage/` own delegated grants, ticket departments, operational ticket lifecycle, suggestions, applications, restricted-ping configuration/cooldowns/audit, schema classification, import/export parsing, and backup/check/migration CLIs.

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

The schema records a principal type so future versions can add individual-user grants, but 5.4.0 creates role grants only. `/access` mutations remain owner-or-Administrator-only and reject `@everyone`, managed, missing, duplicate, and cross-guild roles. Workflow-specific support/reviewer roles and delegated capabilities share the same fresh-verification boundary without merging configuration and private-content authority.

`/restrictedping` is separately owner-or-Administrator-only and is not delegated through `/access`. `/pingrole` is a member action whose authority comes from live membership in the exact configured role plus the exact channel/thread mapping, never from configuration authority. The role must remain non-mentionable and pass a fail-closed dangerous-permission/managed-role screen. Every execution freshly verifies the member, role, channel or exact parent, and effective user/bot permissions before attempting Discord delivery.

## Reusable forms and workflow boundaries

Ticket department fields and application questions use the typed form-definition layer for field type, ordering, Discord modal limits, normalization, length validation, rendering, and response validation. A definition has 1–5 short/paragraph inputs; labels, optional guidance/placeholders, min/max length, required state, stable field ID, and order are stored explicitly.

The abstraction stops at form handling. Ticket reservation/channel lifecycle, suggestion cooldown/voting/review, and private application review remain separate repositories and interaction modules. Suggestions use their own fixed title/details modal rather than pretending to be a configurable form.

Correctness-sensitive transitions are database-backed:

- one active ticket per opener/department plus a transactional three-ticket guild cap;
- conditional ticket activation, claim/release, close, log checkpoint, and recovery;
- persisted suggestion cooldown timestamps, one vote per user/suggestion, atomic vote switching/removal, and conditional state changes;
- one active application per applicant/form plus conditional delivery, claim, withdrawal, decision, and recovery; and
- persisted per-user/per-role and guild-wide/per-role restricted-ping cooldowns, with one bounded durable delivery reservation per role; and
- stable guild/channel/message/component identities for repeated or restarted deliveries.

Discord API calls are performed outside long SQLite transactions. A failed external call leaves a bounded failure/recovery state instead of holding a write lock or inventing success.

Restricted-ping execution uses a short immediate transaction to validate cooldown timestamps and atomically claim a role-scoped reservation containing the requesting user, channel, source, and expiry. Discord receives only the canonical role token with an explicit one-role allowed-mentions allowlist. A second request cannot pass while the reservation is live. Successful delivery is finalized in another immediate transaction that updates role/user success timestamps and counters and appends the audit event; a Discord failure releases the reservation without advancing either successful cooldown. An expired reservation can be reclaimed after a process interruption. There is no cooldown bypass, and no Discord API call occurs inside the transaction.

## Schema v6

Schema v6 has exactly 24 application tables and no application views or triggers:

| Area               | Tables                                                                                                                 | Purpose                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Core               | `schema_migrations`, `guilds`, `guild_settings`, `metrics`                                                             | Schema history, tenant lifecycle, validated settings, and bounded guild/member metrics                            |
| Delegation         | `delegated_capability_grants`                                                                                          | Guild-scoped role authority with capability, active state, grantor, and timestamps                                |
| Tickets and panels | `ticket_departments`, `ticket_department_fields`, `posted_panels`, `tickets`, `ticket_form_responses`, `ticket_events` | Department routing/forms, tracked preset messages, ticket lifecycle, immutable intake answers, and audit events   |
| Suggestions        | `suggestion_configurations`, `suggestions`, `suggestion_votes`, `suggestion_events`                                    | Routing/rate settings, proposal/delivery/review state, per-member votes, and audit events                         |
| Applications       | `application_forms`, `application_form_fields`, `applications`, `application_responses`, `application_events`          | Private workflow definitions, questions, application/delivery/decision state, immutable answers, and audit events |
| Restricted pings   | `restricted_ping_roles`, `restricted_ping_channels`, `restricted_ping_user_cooldowns`, `restricted_ping_events`        | Safe role policy, allowed destinations, durable cooldown/reservation state, counters, and configuration/use audit |

Every tenant-owned row has `guild_id` directly or through a guild-scoped composite reference. Foreign keys cascade from `guilds`; child rows use composite guild/object references to prevent cross-tenant attachment. Checks bound opaque IDs, Discord snowflakes, enum states, form positions, text sizes, timestamps, JSON audit details, cooldown values, and enabled-resource invariants.

Important indexes cover active capability lookup; enabled departments/forms and field order; active ticket uniqueness and guild/opener/department/state queries; suggestion state/author/message/vote/event queries; application active uniqueness, state/form/applicant/review-message/event queries; and restricted-ping role/channel, user cooldown, and chronological audit queries. Partial unique indexes enforce one active ticket per opener/department and one active application per applicant/form. Other unique constraints cover slugs, server-local numbers, live Discord message bindings, one vote per member/suggestion, one restricted role/channel mapping, and one user-cooldown row per guild/role/member. The three-active-ticket guild cap and restricted-ping reservation claim are enforced inside immediate transactions because they span multiple rows or checks.

All interaction and administrative queries have explicit bounds, count/exists variants, or pagination. Ticket, suggestion, and application audit logs retain the latest 100 events per parent; appending a new event trims the oldest in the same transaction instead of blocking a lifecycle action. Restricted-ping administrative audit survives role/mapping deletion, while successful-ping events retain the latest 10,000 entries per guild and remain paginated. Format-5 imports additionally cap every collection, including restricted roles, mappings, cooldowns, and events; the established limits for grants, departments/fields, panels, tickets, suggestions/votes, applications/forms/responses/events, and metrics remain enforced. These are import safety ceilings, not promises that a deployment should routinely approach them.

## Initialization and migration

A missing or empty database is initialized transactionally at v6. Startup accepts exact v6 only and refuses v1, v2, v3, v4, v5, malformed, partial, and unknown layouts. Schema upgrades are explicit offline operator actions.

The v5-to-v6 migration is additive. In one immediate transaction it validates the complete v5 source, creates the four empty restricted-ping tables and their indexes, records schema version 6, and validates the resulting v6 layout. It preserves every v5 row and never invents a role/channel mapping. A failure rolls back the complete transaction and leaves the source at v5.

The v4-to-v5 migration snapshots and verifies every Phase 1 operational row inside one immediate transaction. For each guild with a ticket configuration or ticket history it creates a `General Support` department with Subject and Details fields, associates every existing ticket with it, and derives matching stored responses from the legacy subject/description. A migrated Phase 1 configuration carries its existing update timestamp as the department binding-verification marker so active controls remain compatible; every privileged action still freshly fetches current Discord resources. It preserves guilds, settings, metrics, posted panels, ticket numbers, channel/control identities, claims, close-log checkpoints, failures, timestamps, and ticket events. New suggestion, application, and delegation tables start empty. A failure at any stage rolls back the complete transaction.

Exact v4, v3, and supported v2 sources migrate through the frozen v4-to-v5 conversion and then the additive v5-to-v6 step within the same outer transaction. V3 preserves guild/settings/metrics and begins with no Phase 1 operational rows; v2 keeps safely convertible active data under its existing compatibility rules and refuses unresolved moderation-recovery metadata. Every legacy path reaches v6 with empty restricted-ping tables. V1 must first be upgraded to the supported v2 layout with the final 4.0.0 release. See [Operations](operations.md) for commands and rollback.

## Guild export and import

Guild export format 5 includes the entire active schema-v6 tenant model, subject to collection bounds. Parsing validates guild ownership, limits, unique identities, enum/text constraints, and cross-record references before mutation.

- Format 5 is a complete transactional replacement of settings, metrics, and all current operational collections, including restricted-ping configuration, mappings, cooldowns, and audit history.
- Legacy format 4 remains a complete replacement for its schema-v5 era and leaves the newer restricted-ping collections empty.
- Legacy format 3 is a complete operational replacement for its era. Its ticket configuration/history becomes one `General Support` department plus Subject/Details responses; collections absent from format 3 are empty after replacement.
- Legacy format 2 remains a partial compatibility import: it replaces settings and metrics and deliberately preserves all current operational rows.

Every import disables the guild. Inserted grants are inactive; departments/forms, suggestion configuration, and restricted-ping roles are disabled; stored Discord bindings have no verification timestamp. Historical workflow and restricted-ping audit records remain for integrity/recovery, but imports never activate external roles or channels automatically.

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
npm run db:check -- --db /path/to/database.db --expect 6
npm run db:backup -- --db /path/to/database.db --out /new/path/backup.db --expect 6
npm run migrate -- --db /path/to/database.db --dry-run
```

Use `--expect 6` for an active database and `--expect 5`, `4`, `3`, or `2` only to validate the corresponding migration source. The backup destination must not already exist. Omit `--dry-run` only during a stopped, validated, backed-up maintenance window.

Run `npm audit --omit=dev`, `npm ls --all`, `bash -n ../ops.sh`, ShellCheck when available, and `git diff --check` before release. Do not use `npm run dev` or `npm start` merely to validate a change; those commands can log in and touch the selected database. Tests must use synthetic temporary databases and never an operator `.env`, token, live database, or backup.

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

## Change rules

- Keep package version, lockfile version, `PACKAGE_VERSION`, packaging assertions, and versioned documentation synchronized.
- Add regression tests for parsing boundaries, fresh permission/resource verification, private-content exposure, concurrency, idempotency, partial Discord failures, tenant isolation, migration rollback, import compatibility, and any material review finding.
- Keep migration-only compatibility literals isolated from active runtime definitions.
- Review command definitions, autocomplete, dispatch, component routing, help text, docs, and registration together when changing a command.
- Do not use global caches for operational guild state or put Discord calls inside storage transactions.

## Deployment and future boundaries

Superior 5.4.0 supports one bot process with a local SQLite database. SQLite WAL/transactions, unique constraints, conditional updates, and bounded delivery reservations make concurrent work within that process safe; they do not provide leader election, distributed locks, or safe horizontal writes by several bot processes. Do not place a shared live database on a network filesystem or advertise multi-process support.

Future scale work may keep the focused repository interfaces while replacing storage/coordination, adding workers, or introducing stronger pagination/archival policy. It requires an explicit design and migration. Phase 2 intentionally has no web dashboard, external service dependency, anonymous suggestions, anonymous applications, application attachments, forms longer than five questions, or arbitrary panel themes.
