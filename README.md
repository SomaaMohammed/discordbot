# Superior

Superior 5.5.0 is a neutral, multi-server Discord utility and moderation bot. One process can serve many guilds while keeping settings, delegated access, lifecycle state, and operational records isolated by guild ID.

## Windows quick start

The repository-root `SuperiorBot.exe` is a self-extracting Windows x64 build. It includes its own Node.js runtime and native SQLite dependency, so no ZIP extraction or separate Node installation is needed.

1. Copy `.env.example` to `.env` beside `SuperiorBot.exe`, then add the Discord token.
2. Run `SuperiorBot.exe --check`. This validates configuration and native SQLite without logging in to Discord or creating a database.
3. Double-click `SuperiorBot.exe` to start.

The first launch places the immutable bundled runtime in the current Windows user's local application-data cache. Configuration and the default `superior.db` remain beside the visible executable. The versioned portable ZIP is still produced for advanced maintenance that needs the bundled database tools. See the [Windows guide](docs/windows.md) for Discord setup, upgrades, backups, and troubleshooting.

## Active capabilities

- `/setup` configures each guild, including feature flags, a log channel, timezone, invocation terms, moderation limits, reusable greetings, export/import, and owner-confirmed purge.
- `/access` lets the guild owner or a freshly verified Administrator grant one of seven narrow management capabilities to a safe guild role.
- `/panel` posts and tracks fixed Superior `help`, `server-info`, `resources`, `tickets`, `suggestions`, and `applications` panels.
- `/ticket` manages up to 10 routed departments, each with its own category, closure log, support role, and 1–5-field intake form. It also posts launchers and reconciles interrupted tickets.
- `/suggestion` provides persisted submissions, voting, optional discussion threads, bounded cooldowns, staff review, withdrawals, and missing-message recovery.
- `/application` provides private configurable application forms, private review delivery, claiming, decisions, applicant status/withdrawal, and recovery.
- `/restrictedping` lets the guild owner or an Administrator map safe, normally non-mentionable roles to approved channels, while `/pingrole` lets a current role member request the bot-owned mention only in that authorized context.
- `/superior` provides announcements and panels, message cleanup, channel controls, member timeouts, bounded bulk moderation, activity backfill, and command help.
- `/utility`, `/fun`, `/greetings`, and deliberately addressed natural chat retain their existing member-facing behavior.

## Safety model

- New and rejoined guilds stay disabled until an owner or Administrator validates and enables them with `/setup`.
- Disabled, inactive, unconfigured, cross-guild, and DM contexts do not run guild behavior.
- The owner and Administrators retain ultimate authority. Delegated roles receive only the exact capability granted: `panels.manage`, `tickets.configure`, `tickets.manage`, `suggestions.configure`, `suggestions.review`, `applications.configure`, or `applications.review`.
- `/access` itself is never delegated. Privileged actions re-fetch the actor and relevant role or Discord resource; command visibility is not treated as authorization.
- Ticket configuration does not grant access to ticket contents. Suggestion/application configuration does not grant review access, and a configure-only delegate cannot assign a new workflow content role that they hold. Department support roles and reviewer roles remain workflow-specific content authorities.
- New and recovered ticket channels include up to 25 verified `tickets.manage` roles. Existing ticket channels require `/ticket recover` after a management grant or revoke. Application-review grants and form enablement require the delegated role to have current access to every affected private review channel; Superior never rewrites those operator-managed application-channel permissions.
- Ticket launchers route to one of at most 10 enabled departments. A member may have one active ticket per department and no more than three active tickets across the guild.
- Suggestion authors are public, self-voting is off by default, and the default persistent rate limit is three submissions per ten minutes. Vote changes are transactional and public totals do not expose voter identities.
- Application answers are sent only to the configured private review channel. Applicant-controlled text suppresses mentions, and only the applicant can view their status or withdraw a pending application.
- Restricted role pings require a live same-guild mapping, exact channel or explicitly enabled parent-thread match, current role membership, current user and bot channel permissions, and both per-user and per-role cooldowns. The bot never makes a role mentionable, and the outgoing message permits only the one authorized role mention.
- Schema v7 uses normalized, guild-scoped tables and transactional state changes. Startup creates v7 only for a missing or empty database and refuses v1–v6, partial, malformed, and unknown layouts.
- Schema v6, v5, v4, v3, and the exact supported v2 layout require an explicit validated backup and stopped-process migration to v7. The historical v4-to-v5 stage preserves ticket data, v5-to-v6 adds empty restricted-ping state, and v6-to-v7 adds empty bounded internal delivery-deduplication state.
- Guild export format 5 includes restricted-ping configuration and audit history. Format 5 replaces the complete portable tenant product model transactionally while preserving internal delivery deduplication; legacy format 4 and format 3 retain their documented compatibility behavior, while legacy format 2 replaces settings and metrics without deleting current operational rows. Every imported authority or Discord-resource binding is left inactive and unverified for review.
- Global guild re-enablement does not activate imported ticket-department, suggestion, or application bindings; each service or form must pass its own current Discord-resource verification and be explicitly enabled.

Superior remains a single-process SQLite deployment. Database constraints and short transactions protect concurrent interactions inside that process, but a shared SQLite file must not be written by multiple bot processes.

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

- [Configuration, commands, and Discord permissions](docs/configuration.md)
- [Windows portable guide](docs/windows.md)
- [Development architecture and schema v7](docs/development.md)
- [Operations, migration, backup, recovery, and rollback](docs/operations.md)
- [Member and delegated capabilities](docs/reference/member-capabilities.md)
- [Natural-chat trigger reference](docs/reference/trigger-patterns.md)
- [Privacy policy draft](docs/privacy-policy.md)
- [Terms of service draft](docs/terms-of-service.md)

The policy documents are publication drafts. Replace their operator and contact placeholders, verify hosting and retention facts, and obtain appropriate review before linking them from a public Discord application.

Local `.env` files, SQLite databases and sidecars, backups, dependencies, intermediate build output, versioned portable ZIPs, logs, and editor state are ignored and must not be committed. The repository-root `SuperiorBot.exe` is the deliberate tracked release artifact.
