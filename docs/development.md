# Imperial Court Bot Development

The active production implementation is the TypeScript runtime under `tsbot/`. Version 2 is a multi-tenant application: one Discord client and one SQLite connection serve multiple guilds, but every guild-owned read, write, event, command, and scheduled operation must carry an explicit guild scope.

## Architecture

The runtime separates three kinds of data:

- Process configuration contains the Discord token, database path, displayed bot version, command-registration mode, development guild IDs, reserved operator metadata that currently grants no authority, and operational concurrency limits.
- `GuildSettings` contains validated, versioned configuration for one guild: enabled state, timezone, features, channels, roles, labels, trigger aliases, schedules, limits, champion, and greetings.
- Guild runtime state contains mutable values such as last-post and digest dates, question history, used questions, royal AFK/presence state, and backfill status.

Guild settings are persisted in `guild_settings`; mutable state and feature data are stored in tenant-keyed tables. Configuration values do not belong in `CourtState` and guild values do not belong in `.env` after legacy migration.

Code handling an interaction or event must derive the guild ID, reject unsupported DMs, load a validated guild context, and then use that context's scoped storage and permission policy. Disabled or unconfigured guilds are side-effect free except for setup and lifecycle metadata. Stored channels and messages must be checked against the expected guild after Discord resolves them.

## SQLite Schema

Schema version 2 uses one shared database with these core tables:

- `schema_migrations`
- `guilds`
- `guild_settings`
- `kv`
- `posts`
- `answers`
- `metrics`
- `anon_cooldowns`

Every tenant-owned logical key starts with `guild_id`. Use the guild-scoped storage/context API rather than accepting an optional guild parameter or issuing ad hoc SQL. User IDs, message IDs, and channel IDs being globally unique does not make their data global.

Fresh empty databases may be initialized directly at the current schema. An existing outdated database must not be upgraded during normal application startup. Use the explicit migration command:

```bash
cd tsbot
npm run db:check
npm run migrate
npm run db:check -- --require-current
```

The v1-to-v2 migration is transactional and idempotent. It requires `LEGACY_GUILD_ID` when legacy rows exist, with `TEST_GUILD_ID` accepted only as a deprecated first-migration fallback. Migration compatibility values and old production defaults must remain isolated from normal settings defaults and active handlers.

Never develop or test a migration against the root `court.db`. Build an exact synthetic v1 fixture in a temporary directory, close it, migrate a temporary copy, and verify every table, row count, key, foreign key, index, and integrity result. Failure-path tests must prove the original v1 schema and rows remain intact.

## Bootstrap Templates

Tracked files in `data/bootstrap/` are reusable templates, not production state:

- `questions.json` is copied independently when a guild initializes the court feature.
- `state.json` contains only neutral mutable-state defaults with no configuration, IDs, dates, posts, or history.
- `answers.json` remains empty for compatibility; answers are stored in the tenant-keyed SQLite table.

Do not add a guild, channel, role, message, or user snowflake to a template. Changing one guild's question pool must never mutate another guild's copy or the tracked template.

## Discord Commands and Events

Production command registration is global. Development registration targets every validated `DEV_GUILD_IDS` value, isolates failures per target, and must not leave both global and development copies active. Keep target selection in testable planning logic; validation must not perform a Discord login.

Every command, component, modal, autocomplete request, message event, reaction event, lifecycle event, and background job must derive and validate its guild context. A component custom ID is not proof of tenancy. Mutating configuration, question, import/reset, and moderation paths require explicit permission review. Purge is server-owner-only and requires exact confirmation.

Background loops enumerate enabled, active guilds with bounded concurrency. Use the guild's timezone and state, make each tick idempotent, and catch failures at the guild boundary so one tenant cannot stop another. Backfill status is keyed per guild.

## Local Commands

Node.js 22 or newer is recommended.

```bash
cd tsbot
npm ci
npm run typecheck
npm test
npm run build
node --check dist/src/index.js
```

`npm run check` runs typecheck, tests, and build together. `npm run db:check` is a read-only database preflight. `npm run migrate` changes the selected database and therefore belongs only in a deliberate migration workflow with a validated backup.

`npm run dev` and `npm run start` can connect to Discord and access the configured database. Do not use either as a smoke test. Never point `DB_FILE` at the root live database while running tests or experiments.

## Test Guidance

- Use temporary SQLite files or `:memory:` where migration behavior is not under test.
- Use synthetic 17-20 digit snowflakes; never copy live server data into fixtures.
- Prove isolation with at least two guilds for state, questions, posts, answers, cooldowns, metrics, schedules, royal state, backfill, export/import, and purge.
- Cover disabled-guild and cross-guild channel/message rejection paths.
- Cover setup authorization, validation dependencies, enablement refusal, lifecycle retention, registration planning, independent timezones, and per-guild job failure isolation.
- Parse all tracked bootstrap JSON and scan active defaults/templates for production snowflakes.
- Do not weaken permission or role-hierarchy checks to make mocks easier.

Before committing, run all validation required by `AGENTS.md`, parse bootstrap JSON, run migration and schema tests, check the built entrypoint, run `git diff --check`, and inspect the complete staged diff. Never stage `.env`, databases, sidecars, backups, dependencies, build output, prompts, editor state, or unrelated work.
