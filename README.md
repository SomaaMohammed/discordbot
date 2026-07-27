# Superior

Superior is a multi-server Discord utility and moderation bot. One Discord application and one Node.js process can serve multiple guilds from one shared SQLite database while keeping every guild's configuration, activity metrics, and retained data isolated by guild ID.

The active TypeScript runtime is under `tsbot/`. Each guild starts disabled and is configured independently through `/setup`. The public product surface focuses on moderation, announcements and panels, server/member utilities, configurable greetings, lightweight community statistics, and neutral conversational triggers.

## Active Features

- `/superior` provides announcements, DM and role panels, message cleanup, channel controls, timeouts, bulk moderation, activity backfill, and help.
- `/utility` provides `ping`, `avatar`, `userinfo`, and `serverinfo`.
- `/fun` provides `battle`, `stats`, and `leaderboard`.
- `/greetings send` sends a configured per-guild greeting profile.
- Messages containing the guild's configured invocation keyword can request greetings, help, a coin flip, the local time, thanks/farewell replies, ping, uptime, bot information, dice rolls, and choices.

Legacy court, question, anonymous-answer, royal, schedule, and related configuration data may remain in schema-v2 storage for migration compatibility, rollback, export, and owner-authorized purge. Those retained records are not active public features and are not automatically rewritten or deleted by this redesign.

## Safety Model

- Every tenant-owned SQLite row is keyed by `guild_id`.
- New and rejoined guilds remain disabled until an administrator validates and explicitly enables them.
- Disabled guilds do not trigger chat, moderation, metrics, or background work.
- Leaving a guild marks it inactive; it does not automatically delete retained data.
- Guild data is deleted from the active database only through the server-owner-only `/setup purge` confirmation flow.
- An existing v1 database is upgraded only by the explicit guarded migration command. Normal startup does not migrate an outdated database.
- Internal compatibility names—including `court.db`, backup prefixes, the `imperial-court-bot` service/path, legacy settings fields, metric keys, and component IDs—remain stable to protect live deployments and already-posted Discord components.

## Documentation

- [Configuration and Discord installation](docs/configuration.md)
- [Development guide](docs/development.md)
- [Operations, migration, backup, and rollback](docs/operations.md)
- [Privacy policy](docs/privacy-policy.md)
- [Terms of service](docs/terms-of-service.md)
- [Final review and handoff](docs/final-review-and-handoff.md)
- [Member capabilities](docs/reference/member-capabilities.md)
- [Trigger patterns](docs/reference/trigger-patterns.md)
- [Invictus Empire lore](lore/README.md)

## Repository Layout

```text
.
|-- .env.example              # sanitized process-only configuration
|-- data/bootstrap/           # retained compatibility templates
|-- docs/                     # configuration, development, and operations
|-- lore/                     # separate fiction and continuity references
|-- tsbot/
|   |-- src/                  # active runtime and migration CLI
|   |-- tests/                # unit, isolation, and migration tests
|   |-- package.json
|   `-- package-lock.json
|-- AGENTS.md
|-- README.md
`-- ops.sh
```

Local environment files, SQLite databases and sidecars, `backups/`, dependencies, build output, logs, and editor state are ignored and must never be committed. Deployment autostash handles tracked source changes only and never moves untracked or ignored operator data.

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

For a fresh installation, configure the process from `.env.example`, invite the bot with the required intents and permissions, start it, and complete `/setup` in each guild. For an existing v1 deployment, follow the backup and migration procedure in the [operations runbook](docs/operations.md); the database schema remains version 2.
