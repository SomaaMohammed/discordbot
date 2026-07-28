# Superior

Superior is a neutral, multi-server Discord utility and moderation bot. One process can serve many guilds while keeping settings, lifecycle state, and metrics isolated by guild ID.

## Windows quick start

The repository-root `SuperiorBot.exe` is a self-extracting Windows x64 build. It includes its own Node.js runtime and native SQLite dependency, so no ZIP extraction or separate Node installation is needed.

1. Copy `.env.example` to `.env` beside `SuperiorBot.exe`, then add the Discord token.
2. Run `SuperiorBot.exe --check`. This validates configuration and native SQLite without logging in to Discord or creating a database.
3. Double-click `SuperiorBot.exe` to start.

The first launch places the immutable bundled runtime in the current Windows user's local application-data cache. Configuration and the default `superior.db` remain beside the visible executable. The versioned portable ZIP is still produced for advanced maintenance that needs the bundled database tools. See the [Windows guide](docs/windows.md) for Discord setup, upgrades, backups, and troubleshooting.

## Active capabilities

- `/setup` configures each guild, including feature flags, a log channel, timezone, invocation terms, moderation limits, and reusable greeting profiles.
- `/superior` provides announcements and panels, message cleanup, channel controls, member timeouts, bounded bulk moderation, activity backfill, and command help.
- `/utility` provides `ping`, `avatar`, `userinfo`, `serverinfo`, `roleinfo`, `channelinfo`, `snowflake`, and `timestamp`.
- `/fun` provides `battle`, `stats`, and `leaderboard` when activity metrics are enabled for the guild.
- `/greetings send` lets any guild member send a configured greeting. `{user}` always resolves to the member invoking the command.
- Directly addressed chat supports greetings, wellbeing, activity, help, thanks, farewell, status, uptime, about/version, time, coin flips, bounded dice, and bounded choices.

Examples include `superior hru`, `hey superior, wyd?`, `superior cmds`, `<@bot> what time rn`, and replying directly to the bot with `wsp`. Ordinary conversation is ignored unless the bot is deliberately addressed through the configured invocation, a bot mention, or a reply to the bot.

## Safety model

- New and rejoined guilds stay disabled until an owner or Administrator validates and enables them with `/setup`.
- Disabled, inactive, unconfigured, cross-guild, and DM contexts do not run guild behavior.
- Administrator actions validate the current guild, actor permissions, bot permissions, role hierarchy, and runtime generation before committing results.
- The SQLite schema contains only `schema_migrations`, `guilds`, `guild_settings`, and `metrics`. Tenant-owned rows are keyed by `guild_id`.
- Normal startup creates schema v3 only for a missing or empty database. It refuses v1, v2, partial, or unknown databases and never migrates them implicitly.
- Existing v2 data requires the explicit backup-and-migrate workflow. A v1 installation must first be upgraded to v2 with the final 4.0.0 release.

## Source development

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

Do not use `npm run dev` or `npm start` as a smoke test: both can log in to Discord and open the configured database. The production build is cleaned first and contains source output under `dist/src/`, never compiled tests.

## Documentation

- [Configuration and Discord installation](docs/configuration.md)
- [Windows portable guide](docs/windows.md)
- [Development and architecture](docs/development.md)
- [Operations, migration, backup, and rollback](docs/operations.md)
- [Member capabilities](docs/reference/member-capabilities.md)
- [Natural-chat trigger reference](docs/reference/trigger-patterns.md)
- [Privacy policy draft](docs/privacy-policy.md)
- [Terms of service draft](docs/terms-of-service.md)

The policy documents are publication drafts. Replace their operator and contact placeholders, verify hosting and retention facts, and obtain appropriate review before linking them from a public Discord application.

Local `.env` files, SQLite databases and sidecars, backups, dependencies, intermediate build output, versioned portable ZIPs, logs, and editor state are ignored and must not be committed. The repository-root `SuperiorBot.exe` is the deliberate tracked release artifact.
