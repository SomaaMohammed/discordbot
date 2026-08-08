# Development

The maintained application is a strict TypeScript project in `tsbot/`. Superior 5.3.0 requires Node.js 22.12.0 or newer.

## Architecture

- `src/index.ts` loads process configuration and owns startup/shutdown.
- `src/runtime.ts` owns guild runtimes, lifecycle generations, bounded work, and tenant invalidation.
- `src/conversation.ts`, `src/reply-catalog.ts`, and `src/message-runtime.ts` implement deterministic direct-address chat after lifecycle and moderation precedence checks.
- `src/discord/commands.ts` and `src/discord/bot.ts` register and route slash commands, autocomplete, buttons, modals, and string select menus. Unknown or obsolete components fail safely.
- Focused modules under `src/discord/` own delegated authorization, reusable modal forms, panels, ticket departments/workflow, suggestions, applications, moderation, utilities, and Discord boundary checks.
- Focused repositories under `src/storage/` own delegated grants, ticket departments, operational ticket lifecycle, suggestions, applications, schema classification, import/export parsing, and backup/check/migration CLIs.

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

The schema records a principal type so future versions can add individual-user grants, but 5.3.0 creates role grants only. `/access` mutations remain owner-or-Administrator-only and reject `@everyone`, managed, missing, duplicate, and cross-guild roles. Workflow-specific support/reviewer roles and delegated capabilities share the same fresh-verification boundary without merging configuration and private-content authority.

## Reusable forms and workflow boundaries

Ticket department fields and application questions use the typed form-definition layer for field type, ordering, Discord modal limits, normalization, length validation, rendering, and response validation. A definition has 1–5 short/paragraph inputs; labels, optional guidance/placeholders, min/max length, required state, stable field ID, and order are stored explicitly.

The abstraction stops at form handling. Ticket reservation/channel lifecycle, suggestion cooldown/voting/review, and private application review remain separate repositories and interaction modules. Suggestions use their own fixed title/details modal rather than pretending to be a configurable form.

Correctness-sensitive transitions are database-backed:

- one active ticket per opener/department plus a transactional three-ticket guild cap;
- conditional ticket activation, claim/release, close, log checkpoint, and recovery;
- persisted suggestion cooldown timestamps, one vote per user/suggestion, atomic vote switching/removal, and conditional state changes;
- one active application per applicant/form plus conditional delivery, claim, withdrawal, decision, and recovery; and
- stable guild/channel/message/component identities for repeated or restarted deliveries.

Discord API calls are performed outside long SQLite transactions. A failed external call leaves a bounded failure/recovery state instead of holding a write lock or inventing success.

## Schema v5

Schema v5 has exactly 20 application tables and no application views or triggers:

| Area               | Tables                                                                                                                 | Purpose                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Core               | `schema_migrations`, `guilds`, `guild_settings`, `metrics`                                                             | Schema history, tenant lifecycle, validated settings, and bounded guild/member metrics                            |
| Delegation         | `delegated_capability_grants`                                                                                          | Guild-scoped role authority with capability, active state, grantor, and timestamps                                |
| Tickets and panels | `ticket_departments`, `ticket_department_fields`, `posted_panels`, `tickets`, `ticket_form_responses`, `ticket_events` | Department routing/forms, tracked preset messages, ticket lifecycle, immutable intake answers, and audit events   |
| Suggestions        | `suggestion_configurations`, `suggestions`, `suggestion_votes`, `suggestion_events`                                    | Routing/rate settings, proposal/delivery/review state, per-member votes, and audit events                         |
| Applications       | `application_forms`, `application_form_fields`, `applications`, `application_responses`, `application_events`          | Private workflow definitions, questions, application/delivery/decision state, immutable answers, and audit events |

Every tenant-owned row has `guild_id` directly or through a guild-scoped composite reference. Foreign keys cascade from `guilds`; child rows use composite guild/object references to prevent cross-tenant attachment. Checks bound opaque IDs, Discord snowflakes, enum states, form positions, text sizes, timestamps, JSON audit details, cooldown values, and enabled-resource invariants.

Important indexes cover active capability lookup; enabled departments/forms and field order; active ticket uniqueness and guild/opener/department/state queries; suggestion state/author/message/vote/event queries; and application active uniqueness, state/form/applicant/review-message/event queries. Partial unique indexes enforce one active ticket per opener/department and one active application per applicant/form. Other unique constraints cover slugs, server-local numbers, live Discord message bindings, and one vote per member/suggestion. The three-active-ticket guild cap is enforced inside the reservation transaction because it spans departments.

All interaction and administrative queries have explicit bounds, count/exists variants, or pagination. Ticket, suggestion, and application audit logs retain the latest 100 events per parent; appending a new event trims the oldest in the same transaction instead of blocking a lifecycle action. Format-4 imports additionally cap grants at 1,000, departments at 10, department fields at 50, panels at 5,000, tickets and suggestions/applications at 10,000 each, suggestion votes at 250,000, form definitions at 25/125, responses at 50,000 per workflow collection, events at 100,000 per workflow collection and 100 per parent, and metrics at 50,000. These are import safety ceilings, not promises that a deployment should routinely approach them.

## Initialization and migration

A missing or empty database is initialized transactionally at v5. Startup accepts exact v5 only and refuses v1, v2, v3, v4, malformed, partial, and unknown layouts. Schema upgrades are explicit offline operator actions.

The v4-to-v5 migration snapshots and verifies every Phase 1 operational row inside one immediate transaction. For each guild with a ticket configuration or ticket history it creates a `General Support` department with Subject and Details fields, associates every existing ticket with it, and derives matching stored responses from the legacy subject/description. A migrated Phase 1 configuration carries its existing update timestamp as the department binding-verification marker so active controls remain compatible; every privileged action still freshly fetches current Discord resources. It preserves guilds, settings, metrics, posted panels, ticket numbers, channel/control identities, claims, close-log checkpoints, failures, timestamps, and ticket events. New suggestion, application, and delegation tables start empty. A failure at any stage rolls back the complete transaction.

Exact v3 and supported v2 sources migrate to the established v4 shape and then v5 within the same outer transaction. V3 preserves guild/settings/metrics and begins with no Phase 1 operational rows; v2 keeps safely convertible active data under its existing compatibility rules and refuses unresolved moderation-recovery metadata. V1 must first be upgraded to the supported v2 layout with the final 4.0.0 release. See [Operations](operations.md) for commands and rollback.

## Guild export and import

Guild export format 4 includes the entire active schema-v5 tenant model, subject to collection bounds. Parsing validates guild ownership, limits, unique identities, enum/text constraints, and cross-record references before mutation.

- Format 4 is a complete transactional replacement of settings, metrics, and all Phase 2 operational collections.
- Legacy format 3 is a complete operational replacement for its era. Its ticket configuration/history becomes one `General Support` department plus Subject/Details responses; collections absent from format 3 are empty after replacement.
- Legacy format 2 remains a partial compatibility import: it replaces settings and metrics and deliberately preserves all current operational rows.

Every import disables the guild. Inserted grants are inactive; departments/forms and suggestion configuration are disabled; stored Discord bindings have no verification timestamp. Historical workflow records and delivery IDs remain for integrity/recovery, but imports never activate external roles or channels automatically.

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
npm run db:check -- --db /path/to/database.db --expect 5
npm run db:backup -- --db /path/to/database.db --out /new/path/backup.db --expect 5
npm run migrate -- --db /path/to/database.db --dry-run
```

Use `--expect 5` for an active database and `--expect 4`, `3`, or `2` only to validate the corresponding migration source. The backup destination must not already exist. Omit `--dry-run` only during a stopped, validated, backed-up maintenance window.

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

Superior 5.3.0 supports one bot process with a local SQLite database. SQLite WAL/transactions, unique constraints, and conditional updates make concurrent work within that process safe; they do not provide leader election, distributed locks, or safe horizontal writes by several bot processes. Do not place a shared live database on a network filesystem or advertise multi-process support.

Future scale work may keep the focused repository interfaces while replacing storage/coordination, adding workers, or introducing stronger pagination/archival policy. It requires an explicit design and migration. Phase 2 intentionally has no web dashboard, external service dependency, anonymous suggestions, anonymous applications, application attachments, forms longer than five questions, or arbitrary panel themes.
