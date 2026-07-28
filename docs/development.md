# Development

The maintained application is a strict TypeScript project in `tsbot/`. Node.js 22.12.0 or newer is required.

## Architecture

- `src/index.ts` loads process configuration and owns startup/shutdown.
- `src/runtime.ts` owns guild runtimes, lifecycle generations, bounded work, and tenant invalidation.
- `src/conversation.ts` performs deterministic direct-address recognition and bounded dice/choice parsing.
- `src/reply-catalog.ts` contains typed, varied response pools.
- `src/message-runtime.ts` dispatches guild messages after lifecycle and moderation precedence checks.
- `src/discord/` contains command registration, setup, moderation, panels, utilities, and Discord boundary checks.
- `src/storage/` contains schema classification, the active store, backup/check CLIs, and the explicit v2-to-v3 converter.

Do not add a second conversational parser, storage path, or purge command. Keep member-controlled text escaped before Markdown output, allowed mentions narrow, and Discord resources validated against the current guild.

## Persistent model

Schema v3 has exactly four application tables:

| Table               | Purpose                                                           |
| ------------------- | ----------------------------------------------------------------- |
| `schema_migrations` | Exactly one current schema-version record.                        |
| `guilds`            | Guild identity, enabled state, and join/leave lifecycle metadata. |
| `guild_settings`    | One validated settings-version-2 JSON document per guild.         |
| `metrics`           | Guild-scoped command and optional member-activity counters.       |

`guild_settings` and `metrics` cascade from `guilds`. The sole explicit application index is `idx_guilds_enabled_left_at`. There are no application views or triggers.

A missing or empty database is initialized transactionally at v3. Startup refuses v1, v2, malformed, partial, or unknown layouts. Migration is a separate offline operator action; tests must use synthetic databases in temporary directories.

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
npm run db:check -- --db /path/to/database.db --expect 3
npm run db:backup -- --db /path/to/database.db --out /new/path/backup.db --expect 3
npm run migrate -- --db /path/to/database.db --dry-run
```

The backup destination must not already exist. Omit `--dry-run` only during a stopped, backed-up v2-to-v3 maintenance window.

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
