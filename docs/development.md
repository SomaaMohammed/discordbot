# Superior Development

The active production implementation is the TypeScript runtime under `tsbot/`. It is a multi-tenant application on database schema version 2: one Discord client and one SQLite connection serve multiple guilds, but every guild-owned read, write, event, command, and background operation carries an explicit guild scope.

## Architecture

The runtime separates three kinds of data:

- Process configuration contains the Discord token, database path, displayed version, command-registration mode, development guild IDs, reserved operator metadata, and concurrency limits.
- `GuildSettings` contains validated configuration for one guild. Its persisted schema still includes retired court/royal fields so existing rows remain readable and exportable; only the choices documented in [Configuration](configuration.md) are active publicly.
- Guild runtime state contains activity/backfill state plus legacy mutable court, question, answer, schedule, and royal state retained for compatibility.

Guild settings are persisted in `guild_settings`; mutable state and feature data are stored in tenant-keyed tables. Code handling an interaction or event must derive the guild ID, reject unsupported DMs, load a validated current guild context, and use only that context's scoped storage and permission policy. Disabled or unconfigured guilds are side-effect free except for setup and lifecycle metadata. Discord-resolved channels, roles, members, messages, and components must be checked against the expected guild.

The active public command surface is intentionally narrower than the storage model:

- `/superior`: announcements, panels, cleanup, channel controls, timeouts, bulk moderation, backfill, and help;
- `/utility`: ping, avatar, user information, and server information;
- `/fun`: battle, statistics, and leaderboards;
- `/greetings send`;
- neutral Superior conversational intents and administrator-only reply moderation.

Do not infer active product behavior merely because a legacy type, field, table, metric key, handler compatibility ID, or bootstrap file still exists.

## SQLite Schema and Compatibility

Schema version 2 uses one shared database with these core tables:

- `schema_migrations`
- `guilds`
- `guild_settings`
- `kv`
- `posts`
- `answers`
- `metrics`
- `anon_cooldowns`

Every tenant-owned logical key begins with `guild_id`. Use the guild-scoped storage/context API rather than accepting an optional guild parameter or issuing ad hoc SQL. Globally unique Discord IDs do not make their stored data process-global.

The `posts`, `answers`, and `anon_cooldowns` tables and legacy state/settings fields remain required schema-v2 compatibility data even though the public court/question/answer flows are retired. They support exact migration, export, owner purge, rollback analysis, and preservation of live records. Removing or renaming them is a separate data-migration project and must not be bundled into a public-surface cleanup.

Fresh empty databases may be initialized directly at schema v2. Existing outdated databases must not be upgraded during ordinary startup. Use the explicit guarded workflow:

```bash
cd tsbot
npm run db:check
npm run migrate
npm run db:check -- --require-current
```

The v1-to-v2 migration is transactional and idempotent. It requires `LEGACY_GUILD_ID` when legacy rows exist, with `TEST_GUILD_ID` accepted only as a deprecated first-migration fallback. Legacy defaults and environment inputs remain quarantined in migration code and must not seed active new-guild behavior.

Never develop or test migration code against the root `court.db`. Build an exact synthetic v1 fixture in a temporary directory, close it, migrate a temporary copy, and verify every table, row count, key, foreign key, index, and integrity result. Failure-path tests must prove the original v1 database remains unchanged.

## Bootstrap Templates

Tracked files under `data/bootstrap/` are retained compatibility templates, not production state:

- `questions.json` preserves the historical seed pool for migration/storage compatibility; active setup no longer initializes it.
- `state.json` preserves the schema-v2 legacy state shape without production IDs or live history.
- `answers.json` remains empty; retained answer mappings live in the tenant-keyed SQLite table.

Do not delete or repurpose these files merely because their public feature was retired. Do not add guild, channel, role, message, or user snowflakes to any tracked template.

## Discord Commands and Events

Production registration is global. Development registration targets every validated `DEV_GUILD_IDS` value, isolates failures per target, and must not leave both global and development command copies active. Keep registration planning testable without a Discord login.

Every command, component, modal, autocomplete request, message event, reaction event, lifecycle event, and background job must validate guild context. A component custom ID is not proof of tenancy. Keep stable role-panel and DM-panel IDs compatible with already-posted messages even when their internal prefixes use legacy names. Stale retired commands/components must fail closed without mutating legacy data.

Message processing currently supports neutral Superior intents, reply moderation, and guild-scoped activity metrics. Activity backfill is administrator initiated, tracked per guild, and must honor invalidation between Discord fetches. Temporary silence-lease reconciliation remains an internal recovery safeguard for permission overwrites created by older behavior; do not remove it until every persisted lease can be proven restored or safely resolved.

## Local Commands

Node.js 22.12.0 or newer is required.

```bash
cd tsbot
npm ci
npm run format:check
npm run typecheck
npm test
npm run build
node --check dist/src/index.js
```

`npm run format` applies the repository's Prettier policy to maintained files. `npm run check` runs formatting, typecheck, tests, and build together. `npm run db:check` is read-only. `npm run migrate` writes to the selected database and belongs only in a deliberate migration workflow with a validated backup.

`npm run dev` and `npm run start` can connect to Discord and access the configured database. Never use either as a validation smoke test or point tests/experiments at the root live database.

## Test Guidance

- Use temporary SQLite files or `:memory:` except for explicit read-only operator checks.
- Use synthetic 17–20 digit snowflakes; never copy live server data into fixtures.
- Prove two-guild isolation for active commands, setup, triggers, metrics, backfill, lifecycle, export, and purge.
- Prove `/court`, `/questions`, retired fun/royal commands, and stale anonymous-answer components cannot execute.
- Prove active setup definitions expose only the log channel, supported features, `mute_target_cap`, timezone, trigger, greeting, validation, export, and purge choices; legacy role bindings must not be published or consumed.
- Keep migration, schema, storage, export/import, and purge tests for legacy court/question/answer/royal data. Public retirement must not weaken preservation coverage.
- Cover disabled-guild behavior, cross-guild object rejection, authorization, moderation hierarchy, command synchronization, and tracked graceful shutdown.
- Parse all tracked bootstrap JSON and scan active defaults/templates for production snowflakes.
- Do not weaken permission or role-hierarchy checks to simplify mocks.

Before committing, run every validation required by `AGENTS.md`, parse bootstrap JSON, run migration and schema tests, check the built entrypoint, run `bash -n ops.sh` and ShellCheck when operations code changes, run `git diff --check`, and inspect the complete staged diff. Never stage environment files, databases, sidecars, backups, dependencies, build output, prompts, editor state, or unrelated work.
