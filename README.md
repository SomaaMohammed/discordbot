# Imperial Court Bot

Imperial Court Bot is a multi-server Discord bot. One Discord application and one Node.js process can serve any number of guilds from one SQLite database while keeping each guild's configuration, state, schedules, and data isolated.

The active runtime is TypeScript under `tsbot/`. The Imperial Court and Invictus identity is the default theme, but every guild configures its own channels, roles, labels, invocation trigger, limits, greetings, schedules, and enabled features through Discord slash commands.

## Safety Model

- Every tenant-owned SQLite row is keyed by `guild_id`.
- New and rejoined guilds remain disabled until an administrator validates and explicitly enables them.
- Disabled guilds do not trigger chat, moderation, metrics, posting, or background jobs.
- Leaving a guild marks it inactive; it does not delete its configuration or data.
- Guild data is deleted only through the server-owner-only `/setup purge` confirmation flow.
- An existing v1 database is upgraded only by the explicit, guarded migration command. Normal startup does not migrate an outdated database.

## Documentation

- [Configuration and Discord installation](docs/configuration.md)
- [Development guide](docs/development.md)
- [Operations, migration, backup, and rollback](docs/operations.md)
- [Final review and handoff](docs/final-review-and-handoff.md)
- [Member capabilities](docs/reference/member-capabilities.md)
- [Trigger patterns](docs/reference/trigger-patterns.md)
- [Invictus Empire lore](lore/README.md)

## Repository Layout

```text
.
|-- .env.example              # sanitized process-only configuration
|-- data/bootstrap/           # neutral templates copied per guild
|-- docs/                     # configuration, development, and operations
|-- lore/                     # setting and continuity references
|-- tsbot/
|   |-- src/                  # active runtime and migration CLI
|   |-- tests/                # unit, isolation, and migration tests
|   |-- package.json
|   `-- package-lock.json
|-- AGENTS.md
|-- README.md
`-- ops.sh
```

Local environment files, common SQLite database/sidecar names, `backups/`, dependencies, build output, logs, and editor state are ignored and must never be committed. Deployment autostash handles tracked source changes only and never moves untracked or ignored operator data.

## Local Validation

Node.js 22.12.0 or newer is required.

```bash
cp .env.example .env
cd tsbot
npm ci
npm run format:check
npm run typecheck
npm test
npm run build
node --check dist/src/index.js
```

Set a real token only when intentionally connecting to Discord. Do not use `npm run dev` or `npm run start` as a validation smoke test: both can log in and access the configured database.

For a fresh installation, configure the process from `.env.example`, invite the bot with the required intents and permissions, start it, and complete `/setup` in each guild. For an existing v1 deployment, follow the backup and migration procedure in the [operations runbook](docs/operations.md) before starting version 2.
