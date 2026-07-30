# Development

The maintained application is a strict TypeScript project in `tsbot/`. Node.js 22.12.0 or newer is required.

## Architecture

- `src/index.ts` loads process configuration and owns startup/shutdown.
- `src/runtime.ts` owns guild runtimes, lifecycle generations, bounded work, and tenant invalidation.
- `src/conversation.ts` performs deterministic direct-address recognition and bounded dice/choice parsing.
- `src/reply-catalog.ts` contains typed, varied response pools.
- `src/message-runtime.ts` dispatches guild messages after lifecycle and moderation precedence checks.
- `src/discord/` contains command registration, setup, moderation, fixed panel rendering, persistent ticket workflows, utilities, and Discord boundary checks.
- `src/storage/` contains schema classification, tenant-scoped repositories, backup/check CLIs, and the explicit v3-to-v4 and v2-to-v4 converters.

Do not add a second conversational parser, storage path, or purge command. Keep member-controlled text escaped before Markdown output, allowed mentions narrow, and Discord resources validated against the current guild.

## Persistent model

Schema v4 has exactly eight application tables:

| Table                   | Purpose                                                                     |
| ----------------------- | --------------------------------------------------------------------------- |
| `schema_migrations`     | The current version record, with retained v3 history after a v3 migration.  |
| `guilds`                | Guild identity, enabled state, and join/leave lifecycle metadata.           |
| `guild_settings`        | One validated settings-version-2 JSON document per guild.                   |
| `metrics`               | Guild-scoped command and optional member-activity counters.                 |
| `ticket_configurations` | Category, closure-log channel, support role, and enable state for tickets.  |
| `posted_panels`         | Tracked fixed-panel messages and bounded preset configuration.              |
| `tickets`               | Server-local number, opener, subject/details, lifecycle, claims, and close. |
| `ticket_events`         | Ordered, bounded lifecycle audit events for each ticket.                    |

All tenant-owned tables key or reference rows by `guild_id` and cascade from `guilds`. Ticket uniqueness indexes enforce one active ticket per opener and one record per live channel. Other indexes support preset, state, closure-log checkpoint, and ordered-event lookups. There are no application views or triggers.

The ticket repository uses conditional transactions for reservation, activation, claim/release, closure, log checkpointing, and recovery so concurrent interactions cannot silently overwrite lifecycle state. Posted panel records identify the exact guild/channel/message/token. Guild export format 3 includes ticket configuration, posted panels, tickets, and ticket events in addition to metadata, settings, and metrics. Owner-authorized format-3 import transactionally replaces settings, metrics, and those operational collections; legacy format-2 import replaces settings and metrics while preserving current operational rows. Every import disables the guild and imported ticket configuration for review.

A missing or empty database is initialized transactionally at v4. Startup refuses v1, v2, v3, malformed, partial, or unknown layouts. Migration is a separate offline operator action: exact v3 converts to v4 without inventing ticket data, while the supported legacy v2 layout converts directly to v4 through the existing compatibility converter. Tests must use synthetic databases in temporary directories.

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

`npm run build` removes `dist/` first and compiles only `src/**/*.ts` through `tsconfig.build.json`. Tests are never copied into the production output.

The database CLIs require explicit paths and schema expectations:

```bash
npm run db:check -- --db /path/to/database.db --expect 4
npm run db:backup -- --db /path/to/database.db --out /new/path/backup.db --expect 4
npm run migrate -- --db /path/to/database.db --dry-run
```

Use `--expect 4` with the checker for an active database; use `--expect 3` or `--expect 2` only to validate the corresponding migration source. The backup destination must not already exist. Omit `--dry-run` only during a stopped, validated, backed-up v3-to-v4 or v2-to-v4 maintenance window.

Run `npm audit --omit=dev`, `npm ls --all`, `bash -n ../ops.sh`, ShellCheck when available, and `git diff --check` before release. Do not run `npm run dev` or `npm start` merely to validate a change; those commands can log in and touch the selected database.

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

The builder verifies SHA-256-pinned copies of the official Windows Node runtime, Microsoft C# compiler toolset, .NET Framework reference assemblies, and native SQLite binary. It normalizes the launcher source, compiles against only the pinned references with deterministic path mapping, creates an ordinal per-file manifest, and uses the pinned Node runtime to emit the versioned ZIP with fixed entry metadata. It also embeds that ZIP into the repository-root self-extracting `SuperiorBot.exe`. `package:win:verify` performs two clean-staging builds and fails unless both the ZIP and standalone executable are byte-for-byte reproducible. Use `package:win` when one build is sufficient during local iteration. Cache, staging, and release output are ignored; the requested standalone executable is tracked.

## Change rules

- Keep package version and `PACKAGE_VERSION` synchronized.
- Add regression tests for parsing boundaries, permissions, partial Discord results, tenant isolation, migration rollback, and any material review finding.
- Never use an ignored operator database, `.env`, backup, or Discord token as a fixture.
- Keep migration-only compatibility literals isolated from the active runtime.
- Review command definitions, dispatch, help text, docs, and registration together when changing a command.

## Phase boundaries

Version 5.2.0 delivers the fixed panel framework and the first persistent support-ticket workflow. Suggestions, staff applications, delegated panel/ticket managers, richer ticket categories/forms/routing, and horizontal or multi-process scaling are future phases. The authorization module exposes narrow extension seams, but no delegated-manager configuration is active. Do not document those future systems as available or overload the current ticket tables and component protocol without a deliberate schema and compatibility design.
