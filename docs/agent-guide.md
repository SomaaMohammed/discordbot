# Superior agent guide

This is the durable technical handoff for agents working on Superior. It
describes the entire maintained product, not only the latest phase. Read it
together with the repository-root `AGENTS.md`, which remains authoritative for
commit scope, versioning, validation, and commit-message rules.

This guide is intentionally append-friendly. Future agents should update the
current-state sections when behavior changes and add a dated entry to the
handoff log at the end. Do not erase historical rationale merely because an
implementation has evolved.

## Current baseline

| Item                   | Current value                                                            |
| ---------------------- | ------------------------------------------------------------------------ |
| Product                | Superior                                                                 |
| Version                | 7.2.4                                                                    |
| Runtime                | Node.js 22.14.0 or newer, strict TypeScript, Discord.js 14               |
| Deployment             | One process and one local SQLite database                                |
| SQLite schema          | v11                                                                      |
| Guild export           | Format 8                                                                 |
| Supported imports      | Formats 2 through 8                                                      |
| Primary platform       | Discord; no required dashboard or domain                                 |
| Windows artifact       | Repository-root `SuperiorBot.exe`, Windows x64                           |
| Current feature commit | See the current `git log`; this checkout contains the 7.2.4 release work |
| Baseline date          | 2026-08-30                                                               |

Always verify these values from the current checkout before relying on them:

```powershell
git status --short
git log -5 --oneline
Get-Content tsbot/package.json
rg "CURRENT_SCHEMA_VERSION|formatVersion" tsbot/src
```

Do not assume the worktree is clean. Existing edits and untracked files belong
to the user unless the current task clearly created them.

## Product identity and boundaries

Superior is a neutral, English-only, multi-guild Discord utility and moderation
bot. It is intended mainly for communities below roughly 1,000 members. One
process can serve multiple guilds, but every tenant's settings, grants,
workflows, audit state, and external Discord bindings are isolated by guild ID.

The product should feel calm, clear, and non-theatrical. It uses a fixed
Superior black visual theme. The retired Imperial/Court public identity and lore
must not be reintroduced into the active runtime.

Core boundaries:

- Discord-only operation; there is no web dashboard, public API, or external
  OAuth flow.
- One local SQLite database and one writer process. No distributed workers,
  shared-network database, or horizontal multi-process mode.
- Secure defaults with owner and Administrator recovery authority.
- Current Discord resources and permissions are re-fetched before privileged or
  destructive work. Command visibility is never authorization.
- External Discord calls stay outside long database transactions. Partial
  external success is stored and reported honestly.
- User-controlled content is bounded, normalized, mention-suppressed, and kept
  out of terminal logs.
- Imported external bindings are dormant or unverified until explicitly checked
  against the destination guild.

## Product history

The repository began as an Imperial/Invictus single-server bot with cloud
deployment scripts, administrator announcement and moderation commands,
role-panel controls, natural triggers, activity tracking, SQLite storage, and
JSON migration. The maintained product later moved to TypeScript, removed the
legacy theme, became multi-tenant, and grew through four persistent-workflow
phases.

| Milestone                              | Release/data generation     | Commit        | Durable result                                                                                                                                                                      |
| -------------------------------------- | --------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript production cutover          | 1.x                         | `e4bc6c4`     | TypeScript became the maintained runtime and production path.                                                                                                                       |
| Multi-guild foundation                 | 2.0.0, schema v2            | `28dc0a4`     | Guild-scoped settings/storage/runtime generations, registration, migration, and operator safeguards.                                                                                |
| Multi-tenant hardening                 | 2.0.1                       | `491f8c2`     | Work tracking, graceful shutdown, concurrency fixes, migration snapshots, and deployment hardening.                                                                                 |
| Superior replaces Court surface        | 4.0.0                       | `c23c19c`     | Neutral utilities and triggers replaced the themed public runtime; policy drafts were added.                                                                                        |
| Modern neutral runtime                 | 5.0.0, schema v3            | `8008e73`     | Deterministic natural chat, utilities, greetings, moderation helpers, exact migration/backup safety, and reproducible Windows packaging.                                            |
| Standalone Windows executable          | 5.0.1                       | `27c498c`     | Added the tracked self-extracting `SuperiorBot.exe`.                                                                                                                                |
| One-step setup                         | 5.1.0                       | `dd41f15`     | Added `/setup enable-all`; this was later superseded by secure zero-onboarding defaults.                                                                                            |
| Phase 1: panels and tickets            | 5.2.0, schema v4, export 3  | `1f93e1b`     | Persistent fixed panels and restart-safe support-ticket workflows.                                                                                                                  |
| Fresh-server setup fix                 | 5.2.1                       | `281b751`     | Ensured neutral greetings existed before enabling all behavior.                                                                                                                     |
| Phase 2: delegated workflows           | 5.3.0, schema v5, export 4  | `178641a`     | Narrow role capabilities, ticket departments/forms, suggestions, and private staff applications.                                                                                    |
| Restricted role pings                  | 5.4.0, schema v6, export 5  | `675bc78`     | Safe member-owned role notifications with exact channel mappings and durable cooldowns.                                                                                             |
| Private roll watcher                   | 5.5.0, schema v7            | `1c72d2a`     | Operator-only trusted Mudae-roll notifications with bounded deduplication.                                                                                                          |
| Secure defaults and automated releases | 6.0.0, schema v8, export 6  | `cf164dc`     | Immediate safe guild defaults, config/data commands, persistent-panel compatibility, centralized interaction lifecycle, logging, security gates, and authoritative release tooling. |
| Phase 3: moderation and safety         | 6.1.0, schema v9, export 7  | `53e111e`     | Persistent moderation cases, confidential reports, appeals, anti-spam, safety panels, recovery, and separated authorities.                                                          |
| Phase 4: member lifecycle              | 6.2.0, schema v10, export 8 | `b1b9f12`     | Welcome/farewell delivery, rules verification, safe autoroles, Membership Screening support, persistent role menus, and recovery.                                                   |
| Current 7.2.4 release work             | 7.2.4, schema v11, export 8 | this checkout | Persistent voting panels, deployment-owner recovery controls, packaged v2-v10 startup migration, black panel branding, and refreshed Windows packaging/runtime inputs.              |

Use `git log --oneline --reverse` for the complete granular history. The table
captures the architectural milestones future work is expected to preserve.

## Runtime architecture

The maintained application lives in `tsbot/`:

```text
Discord event or interaction
  -> bot.ts / commands.ts / focused interaction router
  -> current guild runtime and generation check
  -> fresh authorization and Discord resource verification
  -> focused service or command handler
  -> guild-scoped repository transition
  -> external Discord effect outside the transaction
  -> exact completion, failure, or recovery state
  -> bounded private/public response with safe logging
```

Key ownership:

- `src/index.ts`: configuration load, application startup, signals, and shutdown.
- `src/storage/startup-migration.ts`: packaged-only validation, backup, dry-run,
  and automatic legacy database upgrade before Discord login.
- `src/runtime.ts`: shared database, current guild runtimes, lifecycle
  generations, invalidation, and private watcher creation.
- `src/discord/bot.ts`: Discord client intents and event wiring for commands,
  components, messages, guild changes, member lifecycle, deletions, and work
  tracking.
- `src/discord/commands.ts`: top-level slash/component dispatch and safe stale
  interaction handling. Keep it a router; add feature logic to focused modules.
- `src/discord/operator-command.ts`: deployment-owner status and explicit
  guild-scoped enable/suspend recovery controls.
- `src/discord/interaction-lifecycle.ts` and
  `immediate-interaction-response.ts`: acknowledgement, correlation, timing,
  error containment, and immediate modal behavior.
- `src/discord/work-tracker.ts` and `src/shutdown.ts`: reject new work after
  shutdown begins and drain accepted work before exit.
- `src/message-runtime.ts`, `src/conversation.ts`, and
  `src/reply-catalog.ts`: message precedence, deliberate-address natural chat,
  deterministic intent parsing, and bounded replies.
- `src/guild-settings.ts`: normalized, bounded guild settings and defaults.
- `src/storage/db.ts`: database composition and per-guild storage facade. Domain
  persistence belongs in focused repositories rather than expanding this into a
  second monolith.
- `src/storage/schema.ts`: exact schema SQL, classification, and integrity
  validation.
- `src/storage/migration.ts`: frozen historical migration stages and the one
  outer transactional upgrade path.
- `src/storage/guild-data.ts` and versioned `guild-data-v*.ts` modules: strict
  import parsing, compatibility conversion, and portable model validation.
- `src/types.ts`: shared domain and transport types. Keep runtime constants and
  frozen historical shapes separate.

Do not create a second command router, conversational parser, authorization
model, database path, data-purge path, or panel theme.

## Current command surface

The current slash-command families are:

- `/config`: status, emergency bot-state switch, log channel, timezone,
  moderation limits, invocation triggers, and greeting profiles.
- `/data`: format-8 export, owner-only import, and owner-confirmed tenant purge.
- `/access`: grant, revoke, list, and status for narrow delegated capabilities.
- `/pingrole`: member request for one approved restricted-role notification.
- `/restrictedping`: owner/Administrator mapping, health, cleanup, enable/disable,
  cooldown, and thread policy.
- `/onboarding`: status/configure, welcome, farewell, rules, verification,
  autorole, panel, member, recover, and disable.
- `/rolemenu`: list/create/edit/status/enable/disable/archive/recover/post plus
  option add/edit/remove/move.
- `/panel`: list, post, and status for fixed presets, plus private-message,
  role-button, and voting panels.
- `/ticket`: status, launcher panel, disable, recover; department
  list/create/edit/enable/disable/delete/health; field add/edit/remove/move.
- `/suggestion`: submit, status, withdraw, configure, panel, list, review,
  disable, and recover.
- `/application`: submit, status, withdraw, panel, recover; form
  list/create/edit/enable/disable/delete; field add/edit/remove/move.
- `/moderation`: configure/status/disable/recover; warn, note, timeout,
  untimeout, kick, ban, unban, history, case, amend, and void.
- `/report`: confidential submit, member status/withdrawal, and authorized
  recovery; reviewers decide through private persistent controls.
- `/appeal`: eligible case appeal, member status/withdrawal, and authorized
  recovery; reviewers decide through private persistent controls.
- `/automod`: status, rule configure/enable/disable, role/channel exemptions,
  and a non-mutating synthetic test.
- `/channel`: announce, purge/purge-member, lock/unlock, and slowmode.
- `/timeout`: single-member and bounded bulk timeout operations.
- `/activity`: totals, leaderboards, and backfill/status.
- `/help`: command overview and practical next steps.
- `/utility`: ping, avatar, user/server/role/channel information, snowflake, and
  timestamp helpers.
- `/fun`: battle.
- `/greetings send`: send a configured greeting as the current member.
- Natural chat: replies only when deliberately addressed by configured
  invocation, bot mention, or direct reply.

When changing commands, update the builder, registration, dispatch,
autocomplete, component/modal/select routing, help text, tests, and
documentation together.

## Authorization model

Guild owners and freshly verified Administrators retain recovery authority.
Role delegates receive one exact capability:

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

Rules that must remain true:

- `/access` grant/revoke is owner-or-Administrator-only and is never delegated.
- Every privileged action freshly fetches the acting member and applicable
  granted role.
- A capability grants only its named surface. Configuration authority is not
  private-content review authority or member-mutation authority.
- Missing, stale, duplicate, cross-guild, `@everyone`, and managed grant roles
  fail closed.
- Workflow support/reviewer roles are independent content authorities and must
  be verified against the exact current private destination.
- `/restrictedping` is separately owner-or-Administrator-only. `/pingrole`
  authority comes from current membership in the exact mapped role and channel,
  not from a delegated configuration capability.

Primary modules are `authorization.ts`, `capabilities.ts`,
`access-command.ts`, `access-commands-handler.ts`, `phase2-permissions.ts`,
`safety-permissions.ts`, `onboarding-permissions.ts`, and the workflow-specific
permission modules.

## Functional domains and invariants

### Guild lifecycle, configuration, chat, and utilities

- New and rejoined guilds get safe, immediately usable defaults.
- `/config bot-state` is the explicit emergency disable. Disabled, departed,
  purged, stale-generation, cross-guild, and unsupported DM work is rejected.
- `guildCreate`, `guildUpdate`, and `guildDelete` preserve tenant state correctly;
  departure marks a guild inactive, while purge removes it by cascade.
- Message precedence is lifecycle/watcher and safety enforcement before natural
  chat. Do not add a competing parser.
- Natural chat is deterministic and deliberate-address only. Trigger behavior is
  documented in `reference/trigger-patterns.md`.
- Utilities are private where appropriate and validate IDs, channels, roles,
  timestamps, and guild boundaries.

### Fixed and legacy panels

Current fixed presets are `help`, `server-info`, `resources`, `tickets`,
`suggestions`, `applications`, `safety`, `verification`, and `roles`.

- Persistent bindings include guild/channel/message/preset identity and health.
- Replacing a panel preserves rollback and delivery safety.
- `/onboarding panel`, `/rolemenu post`, and generic panel posting share the
  keyed post queue where their destinations overlap.
- `replace_existing:false` refuses a conflicting tracked binding; it must not
  orphan the old message.
- Imported panels remain dormant or unverified.
- Role-panel and DM panels posted by older releases, and their custom IDs, retain
  their existing behavior. Never reinterpret a legacy custom ID as a new
  persistent record.

Primary modules are `panel-theme.ts`, `panels.ts`, `preset-panels.ts`,
`panel-command.ts`, `panel-post-queue.ts`, and the component routers.

### Tickets

- Up to 10 ordered departments per guild; each has an optional category, log
  channel, support role, and 1–5-field typed intake form.
- One active ticket per member/department and no more than three active tickets
  for one member across a guild.
- Reservations, channel creation, control delivery, claims, closure, transcript,
  log checkpoints, and recovery are conditional and restart-safe.
- New/recovered private ticket ACLs include verified workflow staff and up to 25
  live `tickets.manage` roles while preserving unrelated manual overwrites.
- Ticket configuration never grants ticket-content access.
- Transcripts are bounded; current defaults cap 1,000 messages and roughly
  7.5 MiB of generated content.

Primary modules are `ticket-*`, `forms.ts`,
`storage/ticket-department-repository.ts`, and
`storage/operational-repository.ts`.

### Suggestions

- Suggestions persist submission, public delivery, votes, optional discussion
  thread, review state, withdrawal, and recovery.
- Authors are public; voter identities are not exposed in public totals.
- One vote per user/suggestion, with atomic switch/removal.
- Self-voting is off by default. The default durable rate limit is three
  submissions per ten minutes.
- Configuration authority and review authority are separate.

Primary modules are `suggestion-*` and
`storage/suggestion-repository.ts`.

### Applications

- Forms have 1–5 typed short/paragraph questions with stable IDs, order, limits,
  and normalized answers.
- Answers are delivered only to the configured private review destination.
- One active application per applicant/form; delivery, claiming, release,
  withdrawal, decision, and recovery use conditional transitions.
- Only the applicant may see their status or withdraw a pending application.
- Superior verifies but does not rewrite operator-managed review-channel ACLs.

Primary modules are `application-*`, `forms.ts`, and
`storage/application-repository.ts`.

### Restricted role pings

- Only safe, normally non-mentionable roles can be mapped to approved channels.
- Every request verifies the exact guild, current member, current role
  membership, exact channel or explicitly allowed child thread, and effective
  member/bot permissions.
- The bot never makes a role mentionable. The outgoing payload allows only the
  one canonical authorized role mention.
- Default cooldowns are 60 seconds per user and 30 seconds per role, with an
  atomic role-scoped delivery reservation and no Administrator bypass.
- Discord failures release the reservation and do not advance successful
  cooldown timestamps.

Primary modules are `restricted-ping-*` and
`storage/restricted-ping-repository.ts`.

### Private Mudae roll watcher

This is an operator-only subsystem with no public slash-command or public
configuration surface.

- Configuration is loaded from ignored `mudae-watch.private.json` beside the
  application root and is bounded/strictly parsed.
- Only the configured trusted bot, exact guild/channel, and exact normalized
  watched series can produce a notification.
- The current recipient is freshly verified, native Discord forwarding is
  attempted first, and a safe fallback is used when possible.
- Delivery reservations deduplicate by source message and are pruned. Content
  and the private watch configuration stay out of terminal logs and portable
  guild exports.

Primary modules are `mudae-*` and
`storage/mudae-watch-delivery-repository.ts`.

### Moderation cases

- Persistent case types cover warn, note, timeout, timeout removal, kick, and ban,
  and unban, including `/timeout` utility paths.
- Case numbering is guild-local. Reservations distinguish attempted, confirmed,
  failed, voided, overturned, and partial downstream states.
- A successful Discord sanction is not repeated because private logging failed.
- Private moderator notes never appear in member replies, DMs, moderation logs,
  reports, or appeals.
- Active timeout/ban cases cannot be voided until separately authorized reversal
  completes.
- Recovery requires current, action-specific proof; a kick has no durable
  Discord state and therefore requires explicit operator assertion.

Primary modules are `moderation*`, `moderation-action-queue.ts`,
`moderation-log-delivery.ts`, and `storage/moderation-case-*`.

### Reports and appeals

- Reports are confidential, preserve reporter identity and explanation only in
  the authorized private boundary, and never automatically notify the reported
  member.
- Appeals are tied to an eligible case, allow one appeal per case, and are an
  in-guild flow; banned users cannot use the slash command.
- Claim, release/takeover, withdrawal, decision, delivery, and recovery are
  conditional and guild-scoped.
- An appeal is recorded as overturned only after the required Discord reversal
  is verified.
- Missing or ambiguous private review delivery fails closed; never recover into
  a public destination.

Primary modules are `report-*`, `appeal-*`, and
`storage/report-appeal-repository.ts`.

### Anti-spam

- Phase 3 implements narrow burst, duplicate, and mention detectors. Rules are
  default-disabled and remain disabled after migration/import.
- Bots, webhooks, the owner, Administrators, and current configured exemptions
  are ignored.
- Raw message content is never persisted; duplicate detection uses bounded
  normalized in-memory state. Message edits are not enforced.
- Enforcement reservations are keyed by guild/rule/message/member and use
  durable cooldown/idempotency state. Restart clears only in-memory detection
  windows.
- `/automod test` is synthetic and non-mutating.

Primary modules are `anti-spam-detector.ts`, `anti-spam-enforcement.ts`,
`automod-*`, and `storage/anti-spam-repository.ts`.

### Onboarding, rules, and member lifecycle

- Welcome public delivery, best-effort DM, farewell public delivery, and a
  private lifecycle log are independently configured and failure-isolated.
- Allowed template placeholders are only `{user}`, `{server}`,
  `{member_count}`, `{account_created}`, `{joined_at}`, and `{rules}`. Unknown,
  nested, executable, unsafe mention, over-limit, and custom-theme content is
  rejected.
- Account-age warnings are private and informational only. They never trigger an
  automatic kick, ban, timeout, quarantine, or public label.
- Rules versions are immutable and capped at 25. Acceptance is an acknowledgement
  of the exact current server-rules version, not legal consent or external
  identity verification.
- Verification adds the verified role first. Only after success may it remove an
  optional unverified role. A failed removal preserves acceptance and creates
  recoverable partial work.
- Repeated/concurrent acceptance is idempotent. Old-version or copied/cross-guild
  panels fail safely.
- Discord Membership Screening is never bypassed. Humans marked `pending` receive
  no human autoroles or verification role until `guildMemberUpdate` confirms
  screening completion.
- Human and bot autoroles are separate, disabled until configured, and capped at
  10 each. Configuration never starts an unbounded guild-member scan.
- `guildMemberAdd`, `guildMemberRemove`, and screening-related
  `guildMemberUpdate` work enters the shared shutdown tracker.

Primary modules are `onboarding-*`, `verification-*`,
`member-lifecycle-*`, `role-policy.ts`,
`storage/onboarding-repository.ts`, and the Discord/storage onboarding adapter.

### Persistent self-service role menus

- At most 25 menus per guild and 25 options per menu. Slugs are guild-local;
  opaque IDs and stable option IDs are used in components.
- Modes are `toggle`, `exclusive`, and `limited`, with coherent minimum/maximum
  bounds and an optional current prerequisite role.
- Menu and option order is contiguous and deterministic. User-facing positions
  are 1-based; stored sort order is zero-based.
- A self-service role is freshly checked during configuration, posting, and use.
  Reject `@everyone`, deleted/cross-guild, managed/integration/bot/booster,
  unmanageable, or dangerous-permission roles. A non-owner configurator must
  also outrank configured roles.
- Interactions verify menu, definition version, guild, channel, message, member,
  prerequisite, bot hierarchy, and Manage Roles permission.
- Member/menu interactions are serialized. Additions happen before removals;
  failed additions preserve prior access. Only roles represented by that menu may
  be removed.
- Exact per-role outcomes are persisted. Partial removal is recoverable and is
  never described as an atomic success.
- Disable prevents changes without stripping roles. Archive preserves history
  and prevents posting/interactions. Editing makes old definition-bound posts
  stale.

Primary modules are `role-menu-*`, `role-policy.ts`,
`keyed-serial-queue.ts`, and the role-menu storage repositories.

## Shared Discord role policy

Autoroles, verification roles, menu roles, prerequisites, and delegated roles
must remain same-guild and freshly fetched. Role assignment targets reject roles
at or above Superior's highest role and roles with dangerous permissions,
including:

- Administrator
- Manage Server/Guild
- Manage Roles
- Manage Channels
- Kick Members
- Ban Members
- Moderate Members
- Manage Messages
- Manage Webhooks
- Mention Everyone

The optional unverified role is removal-only but still requires hierarchy and
resource validation. Never weaken one feature's role checks independently; use
the shared policy where the semantics match.

## Storage, migration, and guild data

### Schema rules

- Fresh missing/empty databases are created transactionally at exact schema v11.
- The strict storage layer accepts exact v11 only and refuses v1–v10, partial,
  malformed, and unknown layouts. Packaged Windows startup can validate,
  back up, dry-run, and upgrade supported v2–v10 files before Discord login.
- Every tenant row contains `guild_id` directly or belongs through a composite
  guild-scoped foreign key. Cross-tenant attachment must be structurally
  impossible.
- Guild purge deletes the `guilds` row and cascades all tenant data. Guild
  departure only marks the tenant inactive and retains history for rejoin.
- State transitions use short immediate/conditional transactions, uniqueness,
  reservations, and bounded history. Discord API calls never run inside them.
- SQLite integer validation must check SQLite storage type, not merely numeric
  coercion; fractional values in integer fields are invalid.
- Do not add application views or triggers without a specific reviewed need and
  comprehensive integrity coverage.

Schema v10 adds these Phase 4 tables to all prior tables:

- `onboarding_rules_versions`
- `onboarding_configurations`
- `onboarding_message_templates`
- `onboarding_autoroles`
- `member_onboarding_states`
- `member_rule_acceptances`
- `onboarding_delivery_records`
- `onboarding_role_operations`
- `onboarding_audit_events`
- `role_menus`
- `role_menu_options`
- `role_menu_posts`
- `role_menu_operations`
- `role_menu_operation_items`

The complete exact schema and index inventory is owned by
`src/storage/schema.ts`; do not maintain a second hand-written schema list here.

Schema v11 adds the persistent voting-panel tables and indexes without changing
the frozen schema-v10 workflow layout. Current voting panels remain guild-scoped,
bounded, and restart-safe.

### Migration rules

- Migration is an explicit offline operator action after a SQLite-aware backup.
- Supported exact v2–v9 sources run frozen historical stages through v10 and then
  the isolated v10-to-v11 voting stage inside one outer transaction. Exact v10
  sources use only the final stage. Dry-run executes the same work and rolls it
  back.
- Any failure leaves the source unchanged. Never partially advance a schema.
- V1 is unsupported by current tooling and must first be converted to v2 with the
  final 4.0.0 conversion release on a separate stopped copy.
- Migrations preserve every existing row and Discord identifier applicable to
  the source. New services start empty/default-disabled and migrations never
  invent workflow history or perform a Discord effect.
- Once a database reaches v11, never open it with a pre-v11 executable.

### Export/import rules

Format 8 is the complete bounded portable tenant model. It includes settings,
metrics, grants, panels, every persistent workflow through Phase 4, readable
history, and portable recovery checkpoints where appropriate.

- Format 8 replaces the complete portable tenant model transactionally.
- Format 7 replaces the schema-v9-era model and leaves Phase 4 empty/disabled.
- Format 6 replaces the schema-v8-era model and leaves Phase 3/4 empty/disabled.
- Format 5 replaces its schema-v7-era portable model and leaves later services
  empty/disabled.
- Format 4 replaces the schema-v5 Phase 2 model and leaves later services empty.
- Format 3 replaces its Phase 1 operational model and converts legacy ticket
  data to a `General Support` department with Subject/Details responses.
- Format 2 replaces settings and metrics only and deliberately preserves current
  operational rows.

All formats validate size, tenant identity, collection bounds, unique IDs,
enums, states, and cross-record references before mutation. Import never sends a
Discord message, replays a sanction, assigns a role, or grants live authority.
Imported grants are inactive; external bindings, verification, role menus,
automatic roles, anti-spam, and other enforcement remain disabled/unverified
until explicit current-resource validation. Imported acceptance history may be
read but must never trigger role assignment.

## Concurrency, delivery, recovery, and shutdown

Superior does not pretend Discord offers transactions. The standard pattern is:

1. Validate current runtime generation, actor, target, resource, and permission.
2. Reserve or conditionally transition a bounded local operation.
3. Commit the short SQLite transaction.
4. Perform the Discord effect.
5. Confirm each observable result in another short transition.
6. Store an exact failure/partial/ambiguous outcome for bounded recovery.

Use keyed serialization for same-resource races, such as member/menu operations,
moderation actions, onboarding configuration, and panel posts. Use uniqueness and
conditional updates for cross-call idempotency. Never rely only on an in-memory
lock for restart safety.

Every Discord event-handler promise must be contained and accepted through the
shared work tracker. Shutdown stops accepting new work, invalidates runtimes,
cleans bounded process state, and drains accepted work. Guild disable, purge,
departure, rejoin, or generation change must prevent stale asynchronous work from
committing or making a new external effect.

Recovery commands are guild-scoped, bounded, current-authorized, idempotent, and
resource-verifying. They reconcile only provably safe work and must not:

- duplicate a confirmed or ambiguous delivery;
- repeat a successful sanction;
- remove unrelated roles or channel permissions;
- overwrite newer configuration with a stale snapshot;
- recover a private workflow into a public destination; or
- scan an entire guild without a deliberately bounded dry-run design.

Detailed operator recovery procedures live in `operations.md`.

## Privacy, content, and logging boundaries

Store only what the active workflow requires: Discord IDs, bounded
configuration, rules versions, timestamps, safe delivery identifiers, precise
operation outcomes, and bounded audit metadata.

Do not store:

- member message content for moderation/anti-spam analytics;
- DM contents;
- full member profiles or raw gateway payloads;
- IP addresses, emails, phone numbers, or invite histories;
- credentials, environment values, full exports, or database dumps in logs.

Terminal logs must also exclude rules text, welcome/farewell templates,
application answers, ticket transcripts, suggestion details, private notes,
report/appeal bodies or decisions, member-submitted content, and private watcher
configuration. Safe logs may contain correlation ID, guild/member/record IDs,
enum-like states/outcomes, counts, classified Discord failures, and recovery
action names.

Operational payloads should normally use `allowedMentions: { parse: [] }`.
Where one mention is the purpose—restricted role pings—use the narrow explicit
allowlist for that exact role only. Never log user text merely to aid debugging.

The files `privacy-policy.md` and `terms-of-service.md` are unpublished drafts.
They require real operator/contact/retention facts and appropriate review before
public use.

## Testing map

Tests use Vitest under `tsbot/tests/`. They must use synthetic IDs and temporary
databases, never an operator token, `.env`, live database, backup, or Discord
login.

Important suites by concern:

- Runtime/lifecycle: `runtime-isolation`, `guild-lifecycle`, `shutdown`,
  `discord-work-tracking`, `interaction-lifecycle`, `message-runtime`.
- Authorization/privacy: `access`, `ticket-authorization`,
  `safety-permissions`, `logging-errors`, Phase 3 privacy and delivery-boundary
  suites.
- Panels/tickets: `panels`, `panel-command`, `panel-post-queue`,
  `preset-panels`, `persistent-panel-compatibility`, `tickets`, ticket
  department/transcript suites.
- Phase 2: `suggestion-workflow`, `application-workflow`, `forms`, and
  `phase2-components`.
- Restricted pings/watcher: restricted-ping lifecycle/Discord/storage and all
  `mudae-*` suites.
- Phase 3: moderation, moderation-log delivery, anti-spam, report/appeal,
  commands, components, privacy, and recovery-boundary suites.
- Phase 4: `member-lifecycle`, onboarding command/template/verification,
  role-policy, role-menu command/handler/interaction, and storage Phase 4 suites.
- Storage/data: schema, migration, backup, multitenancy, operational repositories,
  versioned guild-data imports, and format-8 tests.
- Release/operations: command registration, config, setup regression,
  operations regression, and Windows packaging.

Material changes should test success, rejection, tenant isolation, fresh
resource/permission checks, concurrency, repeated use, partial Discord failure,
recovery, restart behavior, privacy/logging, migration rollback, import
compatibility, and existing-feature regression as applicable.

## Development and validation

Use PowerShell 7 (`pwsh`) for every Windows command below. For a normal source change:

```powershell
cd tsbot
npm ci
npm run format:check
npm run typecheck
npm test
npm run build
```

The combined non-release gate is `npm run check`. Additional release checks:

```powershell
npm run version:verify
npm run docs:links
npm run powershell:check
npm run security:check
npm run package:win:verify
npm run artifact:verify
```

Also check every built `dist/src/**/*.js` with `node --check`, run portable and
standalone/native-SQLite smoke tests, run `bash -n ops.sh`, run ShellCheck when
available, and run repository-root `git diff --check`.

Do not use `npm run dev` or `npm start` as a smoke test. Both may log in to
Discord and open the configured database.

For a docs-only guide update, no version bump is normally required. Run at least
a targeted Prettier check and local documentation-link check. Follow
`AGENTS.md` if the task also requests a commit.

## Versioning, packaging, and release

`tsbot/package.json` is the only hand-edited semantic version authority.
`package-lock.json`, `src/generated-version.ts`, portable metadata, C# assembly
metadata, source identity, artifact names, and the tracked executable are
generated or verified from it. Do not hand-edit generated version or executable
metadata.

From `tsbot/`:

```powershell
npm run release:patch # compatible fix
npm run release:minor # backward-compatible feature
npm run release:major # breaking release
```

Each wrapper bumps exactly once and runs the full release build. If validation
fails after the bump, fix the issue and run `npm run release:build`; never run the
bumping wrapper a second time. CI rebuilds the Windows artifacts twice and fails
if the committed executable is stale or not reproducible.

The 6.2.0 release validation completed with:

- 76 Vitest files and 1,144 tests;
- 83 security tests and zero production audit vulnerabilities;
- version, docs, PowerShell, formatting, typecheck, production build, and 131
  compiled-JavaScript syntax checks;
- reproducible Windows packaging and portable, standalone, and native-SQLite
  smoke tests;
- source/artifact identity verification and Git Bash `bash -n ops.sh`;
- ShellCheck unavailable on the release host.

Recorded 6.2.0 artifact SHA-256 values:

- `SuperiorBot.exe`:
  `daf3b7d467225843b28ef3d4a1e3ab9819d2d3ac1334390d3f35dd3395e18d79`
- portable ZIP:
  `e4256bd9f6e8fd057ef23cb9d0d91774e84bc5f0fe73e4c5890f1da6c7dede60`

These hashes describe the 6.2.0 baseline only. Recompute and replace them for a
new release rather than treating them as permanent expectations.

## Operations

- `.env` contains only process configuration: token, database path, command
  registration mode, optional development guild IDs, and optional deployment
  operator IDs.
- `SuperiorBot.exe --check` validates configuration and native SQLite without
  logging in or creating a database. Safe diagnostics and version checks are
  part of packaging verification.
- Linux/service operations use `ops.sh`; Windows install, upgrade, migration, and
  troubleshooting use `windows.md` and the scripts in `windows/`.
- Create backups with SQLite's online backup API. Do not copy a live database and
  sidecars with ordinary filesystem tools.
- Migrate only while stopped, after exact source validation, dry-run, and backup.
- Restore validates an isolated candidate and keeps rollback files until the
  application and guild checks pass.
- Backups and exports can contain private workflow and lifecycle data. Apply
  operator-defined retention, encryption, access control, off-host storage,
  restore drills, and verified deletion.
- The repository-root executable is intentionally tracked. `.env`, databases,
  WAL/SHM sidecars, backups, logs, dependencies, staging, and release ZIP output
  are intentionally ignored.

## Safe extension checklist

Before implementing a new feature or widening an existing one:

1. Confirm product scope, actor, private-content boundary, and recovery authority.
2. Decide whether the operation needs a new narrow capability; never overload an
   unrelated capability for convenience.
3. Define explicit bounds for every input, list, history, file, scan, and retry.
4. Design guild-scoped tables/foreign keys, uniqueness, state transitions,
   idempotency, retention, and recovery before Discord effects.
5. Reuse the interaction lifecycle, work tracker, current runtime generation,
   authorization, safe role policy, panel theme, form layer, delivery outcomes,
   and keyed queues where applicable.
6. Keep command definitions, handlers, components, repositories, and import
   parsers focused; do not grow `commands.ts`, `bot.ts`, `db.ts`, or `schema.ts`
   into feature monoliths.
7. Re-fetch actors and Discord resources at use time; do not trust a cached role,
   member, channel, message, or imported binding.
8. Keep Discord calls outside transactions and persist exact partial outcomes.
9. Add storage migration, schema classification/integrity, import/export, purge,
   backup, tenant-isolation, shutdown, privacy, and regression coverage where the
   feature affects them.
10. Update README, configuration, capability, development, operations, Windows,
    policy, help, and future-boundary text as relevant.
11. Use the authoritative release workflow for behavior changes and verify the
    tracked executable matches source.
12. Review `git status --short` and stage only current-task files.

## Deferred and prohibited assumptions

The following are intentionally not implemented and must not be assumed to
exist:

- CAPTCHA, external OAuth verification, phone/email collection, invite tracking,
  AI account-risk scoring, or automatic age-based punishment;
- web dashboard or required domain;
- arbitrary scripts, executable template code, or public member history;
- unbounded member backfill or guild scans;
- multi-process SQLite, distributed locks/workers, or horizontal scaling;
- migration/import-triggered Discord messages, sanctions, or role changes.

Possible later work includes polls, giveaways, starboard/highlights, reminders,
scheduled announcements, community events, bounded dry-run member backfill,
in-Discord analytics/retention views, and stronger archival tools. An external
dashboard or distributed architecture requires an explicit product and migration
decision, not a configuration toggle.

## Canonical documentation

- `../README.md`: product overview, quick start, active capabilities, and safety
  model.
- `configuration.md`: Discord setup, current commands, permissions, limits, and
  workflow behavior.
- `development.md`: active architecture, exact schema generation, migration,
  import/export, tests, packaging, and release workflow.
- `operations.md`: service operation, migration, backup/restore, recovery, and
  rollback.
- `windows.md`: executable/portable setup, upgrades, paths, and troubleshooting.
- `reference/member-capabilities.md`: member, workflow-role, delegate,
  Administrator, owner, and operator authority.
- `reference/trigger-patterns.md`: deliberate natural-chat parsing and
  precedence.
- `privacy-policy.md` and `terms-of-service.md`: unpublished policy drafts.

When this guide and executable code disagree, verify tests and history, correct
the implementation or guide as appropriate, and record the decision below.

## Agent handoff log

Add new entries at the top of this section so the newest handoff is easiest to
find. Keep entries factual and link them to commits when available.

### Entry template

```markdown
### YYYY-MM-DD — Short change summary

- Agent/task:
- Commit: `<hash> <subject>` or `uncommitted`
- Version/schema/export: `<version> / v<schema> / format <n>`
- What changed:
- Invariants or compatibility affected:
- Validation completed:
- Known limitations or follow-up:
- Files future agents should read first:
```

### 2026-08-24 — Full repository handoff guide

- Agent/task: document the complete Superior implementation context for future
  agents, replacing the initially proposed Phase-4-only guide scope.
- Commit: uncommitted documentation after
  `b1b9f12 feat(onboarding): add member lifecycle and role menus`.
- Version/schema/export: 6.2.0 / v10 / format 8.
- What changed: created this append-friendly guide covering product history,
  every active feature family, architecture, authorization, persistence,
  migration/import behavior, recovery, privacy, testing, operations, and release
  workflow.
- Invariants or compatibility affected: none; documentation only.
- Validation completed: see the task handoff/final response for docs-only checks.
- Known limitations or follow-up: future agents must keep the current-baseline
  and handoff sections synchronized with subsequent releases.
- Files future agents should read first: root `AGENTS.md`, this guide,
  `../README.md`, `development.md`, `configuration.md`, and `operations.md`.

### 2026-08-24 — Phase 4 member lifecycle release

- Agent/task: implement complete onboarding, verification, member lifecycle,
  automatic-role, and persistent self-service role-menu workflows.
- Commit: `b1b9f12 feat(onboarding): add member lifecycle and role menus`.
- Version/schema/export: 6.2.0 / v10 / format 8.
- What changed: added `/onboarding`, `/rolemenu`, `verification`/`roles` fixed
  panels, lifecycle event wiring, immutable rules acceptance, screening-aware
  autoroles, strict shared role policy, exact partial-operation recovery,
  normalized Phase 4 storage, migration, import/export, tests, docs, and rebuilt
  Windows artifacts.
- Invariants or compatibility affected: formats 2–7 remain importable; v9–v2
  migrations remain supported; legacy role panels retain their custom-ID
  behavior; imported external bindings stay dormant; no migration/import Discord
  mutation.
- Validation completed: 76 test files/1,144 tests, 83 security tests, zero audit
  vulnerabilities, full release build, 131 JavaScript syntax checks,
  reproducible artifacts, portable/standalone/native-SQLite smokes, identity and
  Bash syntax checks; ShellCheck unavailable.
- Known limitations or follow-up: CAPTCHA, dashboard/OAuth, bulk member backfill,
  distributed workers, and automatic age-based enforcement remain deferred.
- Files future agents should read first: `src/discord/onboarding-*`,
  `member-lifecycle-*`, `verification-*`, `role-menu-*`, `role-policy.ts`,
  `panel-post-queue.ts`, Phase 4 storage repositories, `schema.ts`,
  `migration.ts`, and `guild-data-v8.ts`.
