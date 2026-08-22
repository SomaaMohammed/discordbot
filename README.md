# Superior

Superior 6.1.0 is a neutral, multi-server Discord utility and moderation bot. One process can serve many guilds while keeping settings, delegated access, lifecycle state, and operational records isolated by guild ID.

## Windows quick start

The repository-root `SuperiorBot.exe` is a self-extracting Windows x64 build. It includes its own Node.js runtime and native SQLite dependency, so no ZIP extraction or separate Node installation is needed.

1. Copy `.env.example` to `.env` beside `SuperiorBot.exe`, then add the Discord token.
2. Run `SuperiorBot.exe --check`. This validates configuration and native SQLite without logging in to Discord or creating a database.
3. Double-click `SuperiorBot.exe` to start.

The first launch places the immutable bundled runtime in the current Windows user's local application-data cache. Configuration and the default `superior.db` remain beside the visible executable. The versioned portable ZIP is still produced for advanced maintenance that needs the bundled database tools. See the [Windows guide](docs/windows.md) for Discord setup, upgrades, backups, and troubleshooting.

## Active capabilities

- `/config` reports or changes the explicit bot-state switch, log channel, timezone, invocation terms, moderation limits, and reusable greetings. `/data` provides export, owner-only import, and owner-confirmed purge.
- `/access` lets the guild owner or a freshly verified Administrator grant one of eleven narrow management capabilities to a safe guild role.
- `/panel` posts and tracks fixed Superior `help`, `server-info`, `resources`, `tickets`, `suggestions`, `applications`, and `safety` panels.
- `/ticket` manages up to 10 routed departments, each with its own category, closure log, support role, and 1–5-field intake form. It also posts launchers and reconciles interrupted tickets.
- `/suggestion` provides persisted submissions, voting, optional discussion threads, bounded cooldowns, staff review, withdrawals, and missing-message recovery.
- `/application` provides private configurable application forms, private review delivery, claiming, decisions, applicant status/withdrawal, and recovery.
- `/restrictedping` lets the guild owner or an Administrator map safe, normally non-mentionable roles to approved channels, while `/pingrole` lets a current role member request the bot-owned mention only in that authorized context.
- `/moderation` provides persistent warning, note, timeout, kick, ban, unban, case-history, amendment, voiding, configuration, and recovery workflows. Legacy `/superior` timeout, untimeout, and bounded bulk-timeout operations enter the same case history and fail closed until moderation cases are enabled, while purge, lock, unlock, and slowmode remain independent.
- `/report` provides confidential member reports with private staff review, and `/appeal` provides one in-guild appeal for an eligible case while the sanctioned member can still access the guild.
- `/automod` configures a deliberately narrow, default-disabled burst, duplicate, and mention anti-spam system with role/channel exemptions, dry-run testing, durable cooldowns, and auditable enforcement.
- `/superior` continues to provide announcements and panels, message cleanup, channel controls, bounded member timeouts, activity backfill, and command help.
- `/utility`, `/fun`, `/greetings`, and deliberately addressed natural chat retain their existing member-facing behavior.

## Safety model

- New and rejoined guilds are immediately usable with safe defaults: every core command family, greeting, conversational reply, activity metric, and persistent interaction route is active without onboarding.
- The explicit `/config bot-state` switch is the emergency global disable. Disabled, departed, cross-guild, and unsupported DM contexts do not run guild behavior.
- The owner and Administrators retain ultimate authority. Delegated roles receive only the exact capability granted, including the separated `moderation.configure`, `moderation.manage`, `reports.review`, and `appeals.review` boundaries.
- `/access` itself is never delegated. Privileged actions re-fetch the actor and relevant role or Discord resource; command visibility is not treated as authorization.
- Ticket configuration does not grant access to ticket contents. Suggestion/application/moderation configuration does not grant review access, and a configure-only delegate cannot assign a new workflow content role that they hold without the matching content authority. Department support roles and reviewer roles remain workflow-specific content authorities.
- New and recovered ticket channels include up to 25 verified `tickets.manage` roles. Existing ticket channels require `/ticket recover` after a management grant or revoke. Application-review grants and form enablement require the delegated role to have current access to every affected private review channel; Superior never rewrites those operator-managed application-channel permissions.
- Ticket launchers route to one of at most 10 enabled departments. A member may have one active ticket per department and no more than three active tickets across the guild.
- Suggestion authors are public, self-voting is off by default, and the default persistent rate limit is three submissions per ten minutes. Vote changes are transactional and public totals do not expose voter identities.
- Application answers are sent only to the configured private review channel. Applicant-controlled text suppresses mentions, and only the applicant can view their status or withdraw a pending application.
- Moderation cases distinguish successful sanctions, completed records, failures, voided records, and overturned outcomes. Private moderator notes never appear in member-facing replies, direct messages, moderation-log delivery, reports, or appeals.
- Reports preserve the reporter's identity and explanation only inside the authorized private review boundary and never notify the reported member automatically. Appeals expose only eligible member-facing case information; banned users cannot use the in-guild slash-command flow.
- Anti-spam rules remain disabled after migration and import. The detector ignores bots, webhooks, the owner, Administrators, and configured live exemptions; it never persists raw message content, and Phase 3 does not enforce message edits.
- Restricted role pings require a live same-guild mapping, exact channel or explicitly enabled parent-thread match, current role membership, current user and bot channel permissions, and both per-user and per-role cooldowns. The bot never makes a role mentionable, and the outgoing message permits only the one authorized role mention.
- Schema v9 adds normalized, guild-scoped moderation, report, appeal, anti-spam, audit, and delivery records. The supported v8-to-v9 migration preserves every existing row and external Discord identifier, adds no invented historical cases, and leaves new services and anti-spam rules disabled.
- Startup creates v9 only for a missing or empty database and refuses unmigrated, partial, malformed, and unknown layouts. Back up and stop the process before migration, and never run a pre-v9 executable after a database has migrated.
- Guild export format 7 contains the complete portable tenant product model. Imports preserve readable history but leave imported authority, external Discord-resource bindings, and anti-spam enforcement dormant until their explicit current-resource verification paths succeed.

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
- [Development architecture and schema v9](docs/development.md)
- [Operations, migration, backup, recovery, and rollback](docs/operations.md)
- [Member and delegated capabilities](docs/reference/member-capabilities.md)
- [Natural-chat trigger reference](docs/reference/trigger-patterns.md)
- [Privacy policy draft](docs/privacy-policy.md)
- [Terms of service draft](docs/terms-of-service.md)

The policy documents are publication drafts. Replace their operator and contact placeholders, verify hosting and retention facts, and obtain appropriate review before linking them from a public Discord application.

Local `.env` files, SQLite databases and sidecars, backups, dependencies, intermediate build output, versioned portable ZIPs, logs, and editor state are ignored and must not be committed. The repository-root `SuperiorBot.exe` is the deliberate tracked release artifact.
