# Imperial Court Bot

Imperial Court Bot is a Discord bot powered by the active TypeScript runtime in `tsbot/`. It stores live state in the ignored root `court.db` SQLite database and can seed a fresh database from source-controlled JSON in `data/bootstrap/`.

## Project Areas

- [Documentation index](docs/README.md)
- [Development guide](docs/development.md)
- [Operations runbook](docs/operations.md)
- [Member capabilities](docs/reference/member-capabilities.md)
- [Trigger patterns](docs/reference/trigger-patterns.md)
- [Invictus Empire lore](lore/README.md)

## Repository Layout

```text
.
|-- .github/
|   `-- workflows/
|-- data/
|   `-- bootstrap/
|       |-- answers.json
|       |-- questions.json
|       `-- state.json
|-- docs/
|   |-- README.md
|   |-- development.md
|   |-- operations.md
|   `-- reference/
|       |-- member-capabilities.md
|       `-- trigger-patterns.md
|-- lore/
|   |-- README.md
|   |-- continuity-ledger.md
|   `-- snippets.md
|-- tsbot/
|   |-- src/
|   |-- tests/
|   |-- package.json
|   |-- package-lock.json
|   |-- tsconfig.json
|   `-- vitest.config.ts
|-- AGENTS.md
|-- README.md
`-- ops.sh
```

Ignored local state such as `.env`, `court.db*`, `backups/`, editor settings, dependencies, and build output is intentionally absent from the tracked layout.

## Quick Start

```bash
cd tsbot
npm ci
npm run typecheck
npm test
npm run build
npm run dev
```

For production deployment and database maintenance, follow the [operations runbook](docs/operations.md).
