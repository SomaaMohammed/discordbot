# Superior Configuration and Guild Setup

Superior separates process configuration from per-guild configuration while retaining database schema version 2. The process knows how to connect to Discord, where the shared database is, and where commands are registered. Each guild independently controls its enabled state, log channel, invocation terms, timezone, greeting profiles, moderation limit, and supported feature flags through `/setup`.

Legacy court, question, answer, royal, schedule, channel, role, label, and limit fields can remain in persisted guild settings and exports. They are retained for migration compatibility and rollback, but they are not active setup choices and startup does not rewrite them.

## Discord Application Installation

Create or select one Discord application in the Discord Developer Portal, enable Guild Install, and install its bot in each guild that should use it. Keep user-install-only contexts disabled; this runtime expects a guild context.

Use these OAuth2 scopes:

- `bot`
- `applications.commands`

Enable these privileged gateway intents:

- Message Content Intent, required by conversational Superior triggers, reply moderation, message activity metrics, and administrator-requested history backfill.
- Server Members Intent, called Guild Members Intent in some Discord interfaces, required by role checks, moderation, greetings, utilities that resolve members, and backfill attribution.

The runtime subscribes to Guilds, Guild Members, Guild Messages, Guild Message Reactions, and Message Content gateway events. If the application becomes public or reaches Discord's verification thresholds, account for Discord's current approval requirements for privileged intents before broad deployment.

Before publishing the application, replace every publication blocker in the [Privacy Policy](privacy-policy.md) and [Terms of Service](terms-of-service.md) with real operator and production facts. After the reviewed files are committed and pushed to the public `main` branch, the intended stable URLs are:

- Privacy Policy: `https://github.com/SomaaMohammed/discordbot/blob/main/docs/privacy-policy.md`
- Terms of Service: `https://github.com/SomaaMohammed/discordbot/blob/main/docs/terms-of-service.md`

These files remain drafts until their placeholders and listed blockers are resolved. Do not use draft URLs in a public listing. Configure a private, monitored support contact and the required support server before applying for App Directory discovery. Update any remaining old application name, bot username, description, or installation-page text to Superior in the Developer Portal; repository code cannot rename the Discord application itself.

Grant only the permissions required by the commands a guild will use:

- View Channels, Send Messages, Embed Links, and Read Message History for replies, greetings, panels, announcements, activity statistics, and backfill.
- Manage Messages for purge commands.
- Moderate Members for timeout, untimeout, and bulk moderation.
- Manage Roles for role panels and channel permission-overwrite controls.
- Manage Channels for slowmode and related channel controls.

Discord role hierarchy still applies. Place the bot's highest role above every role or member it must assign, remove, or moderate. `/setup validate` reports missing configured resources and required permissions; individual moderation and role-panel actions also enforce Discord's ownership, managed-role, and hierarchy constraints when used.

## Process Configuration

Copy the sanitized example and keep the real file local:

```bash
cp .env.example .env
```

Supported process keys are:

| Key                         | Purpose                                                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| `DISCORD_TOKEN`             | Required Discord bot token. Never print or commit it.                                         |
| `DB_FILE`                   | Shared SQLite file. A relative path resolves from the repository root; default is `court.db`. |
| `BOT_VERSION`               | Optional process-wide displayed version override. The package version is used when empty.     |
| `COMMAND_REGISTRATION_MODE` | `global` for production or `guild` for development. Defaults to `global`.                     |
| `DEV_GUILD_IDS`             | Comma-separated development guild snowflakes. Required only in `guild` registration mode.     |
| `BOT_OPERATOR_USER_IDS`     | Reserved process metadata. It currently grants no runtime command or setup authority.         |
| `SCHEDULER_CONCURRENCY`     | Positive process-wide bound for concurrent per-guild background work.                         |
| `LEGACY_GUILD_ID`           | One-time tenant ID used while migrating a legacy v1 database. Remove after migration.         |

Every configured snowflake is validated. In production, leave registration mode as `global` and `DEV_GUILD_IDS` empty. Runtime authorization comes from the current guild's owner, Discord Administrator permission, and configured guild roles—not from `BOT_OPERATOR_USER_IDS`.

The runtime normally reads `<repository>/.env`. Set `ENV_FILE` in the launching shell or systemd service to select another file; relative values resolve from the repository root. `ENV_FILE` is a bootstrap setting and cannot select itself from inside an otherwise unknown file. The operations wrapper and runtime honor the same selection.

Version 1 guild-specific keys are not normal current process configuration. The isolated migration path may still read `TIMEZONE`, `COURT_CHANNEL_ID`, `LOG_CHANNEL_ID`, `WEEKLY_DIGEST_CHANNEL_ID`, `ROYAL_ALERT_CHANNEL_ID`, `STAFF_ROLE_IDS`, `EMPEROR_ROLE_ID`, `EMPRESS_ROLE_ID`, `SILENT_LOCK_EXCLUDE_ROLES`, `ANON_REQUIRED_ROLE_ID`, `WEEKLY_DIGEST_WEEKDAY`, `WEEKLY_DIGEST_HOUR`, `ANON_MIN_ACCOUNT_AGE_MINUTES`, `ANON_MIN_MEMBER_AGE_MINUTES`, `ANON_COOLDOWN_SECONDS`, `ANON_ALLOW_LINKS`, `MUTEALL_TARGET_CAP`, `ANSWER_RETENTION_DAYS`, and `UNDEFEATED_USER_ID` once to preserve the legacy guild. Keep Discord IDs as exact strings during migration. `TEST_GUILD_ID` is accepted only as a deprecated `LEGACY_GUILD_ID` fallback for that first migration.

After successful migration and a private `/setup export` review, remove deprecated guild-specific keys from the service environment. Persisted guild settings are authoritative. Retaining a legacy field in SQLite does not reactivate its retired feature.

## Disabled-First Lifecycle

When Superior joins a guild, it creates or reactivates non-sensitive guild metadata but leaves the guild disabled. It does not automatically respond, moderate, record activity metrics, or run guild work.

Only the guild owner or a member with Discord Administrator permission can use setup mutations. Until the guild is enabled, setup remains available and other command families return an actionable setup-required response.

Recommended first-run sequence:

1. Run `/setup status`.
2. Optionally bind a private moderation log channel with `/setup channel`.
3. Enable the desired supported features with `/setup feature`.
4. Set the guild timezone with `/setup timezone`.
5. Set the Superior invocation and aliases with `/setup trigger` if desired.
6. Add a greeting profile with `/setup greeting` before enabling greetings.
7. Set `mute_target_cap` with `/setup limits` if bulk moderation needs a cap.
8. Run `/setup export` and privately review the persisted configuration and retained data.
9. Run `/setup validate`, resolve every error, then run `/setup enable`.

Use `/setup disable` before maintenance or whenever guild behavior should stop. Disabling preserves settings and retained guild data.

## Active Setup Surface

The published `/setup` subcommands are:

- `status`, `enable`, and `disable`;
- `channel`, `feature`, `limits`, `timezone`, `trigger`, and `greeting`;
- `validate`, `export`, and owner-only `purge`.

### Log channel

```text
/setup channel
  purpose:log
  action:<set|clear>
  channel:<required for set>
```

The channel must be a text or announcement channel in the current guild. It can receive moderation, announcement, panel, DM-forwarding, and operational audit entries. Stored channel IDs are rechecked against the current guild when resolved.

### Legacy role bindings

`/setup role` is retired and is not published. All supported conversational intents are public to guild members when `superior-chat` is enabled, while reply moderation requires the guild owner or Discord Administrator permission. Persisted privileged-chat, staff, royal, anonymous-answer, and silence-target role bindings may remain for compatibility and rollback, but they have no active runtime consumer and are not public setup choices.

### Feature flags

```text
/setup feature
  name:<superior-chat|reply-moderation|greetings>
  enabled:<true|false>
```

- `superior-chat` enables the neutral message intents documented in [Trigger Patterns](reference/trigger-patterns.md).
- `reply-moderation` lets a guild owner or Administrator issue a one-minute reply timeout through a recognized Superior phrase, subject to Discord permissions and hierarchy.
- `greetings` enables `/greetings send` after at least one profile is configured.

Legacy feature flags—including court, anonymous answers, royal AFK/presence, silence lock, and weekly digest—may remain stored but no longer expose active behavior.

### Limits and timezone

```text
/setup limits mute_target_cap:<0-10000>
/setup timezone timezone:<IANA timezone>
```

`mute_target_cap` limits server-wide bulk moderation targets; `0` disables that configured cap. The timezone controls guild-local output such as the conversational time response. Use an IANA value such as `UTC` or `Asia/Amman`.

### Invocation and greetings

The default invocation for a new guild is `superior`:

```text
/setup trigger keyword:<text> aliases:<optional comma-separated text>
```

Existing guilds keep their persisted keyword and aliases. To adopt the Superior name, run `/setup trigger keyword:superior aliases:<every alias to retain>`. The command replaces the complete alias list; do not edit settings JSON directly.

Greetings use named profiles:

```text
/setup greeting action:<add|update|remove|list>
  name:<profile>
  user:<optional user>
  message:<optional text using {user}>

/greetings send profile:<name>
```

Profile lookup is validated within the current guild. A migrated profile can preserve old text until an administrator edits or removes it; migration does not make that text a new-guild default.

## Active Commands

The `/superior` family retains these administration and moderation commands:

- `say`, `dmpanel`, `rolepanel`, and `rolepanelmulti`;
- `purge`, `purgeuser`, `lock`, `unlock`, and `slowmode`;
- `timeout`, `untimeout`, `mutemany`, `unmutemany`, `muteall`, and `unmuteall`;
- `backfillstats`, `backfillstatus`, and `help`.

The general member commands are:

- `/utility ping`, `/utility avatar`, `/utility userinfo`, `/utility serverinfo`;
- `/fun battle`, `/fun stats`, `/fun leaderboard`;
- `/greetings send profile:<name>`.

`/court`, `/questions`, `/fun verdict`, `/fun title`, `/fun fate`, and the royal `/superior` subcommands are retired and are not published. `/invictus` also remains retired. Discord can briefly retain stale global definitions while command synchronization propagates; stale retired interactions do not reactivate legacy behavior.

Previously posted role and DM panels remain compatible through stable internal component IDs. Administrators must repost a panel if they want its visible old text changed. Internal names such as `invictusChat` and `invictus.*` metric keys are compatibility details, not public branding.

## Validation, Export, and Purge

`/setup validate` checks the current guild's supported feature dependencies, configured log channel, timezone, bot permissions, and moderation requirements. Legacy retained settings, including role bindings, are not treated as active dependencies.

`/setup export` exports only the current guild's configuration and data. Its payload can include legacy court, question, answer, schedule, royal, cooldown, and metric records retained for compatibility. Protect the file and never post it publicly. Cross-guild import is rejected.

`/setup purge` is destructive and restricted to the server owner. Begin with a non-confirming value to receive the exact scope and expected `PURGE <guildId>` confirmation. A successful purge removes the current guild's rows from the active shared database; it cannot affect another guild, change the schema, delete `court.db`, or touch operator backups. Run it before removing the bot, or re-invite the bot/contact the operator if it has already been removed.

## Leave and Rejoin Behavior

When the bot leaves, the guild is marked inactive and its stored configuration and tenant data are retained. If it rejoins, the record is reactivated but remains disabled until an administrator reviews, validates, and enables it again.

## Command Registration

Production uses application-global commands:

```dotenv
COMMAND_REGISTRATION_MODE=global
DEV_GUILD_IDS=
```

Discord can take time to propagate global changes. Global mode clears stale guild scopes before replacing global definitions. Do not create duplicate guild command copies as a workaround.

For development-only iteration:

```dotenv
COMMAND_REGISTRATION_MODE=guild
DEV_GUILD_IDS=111111111111111111,222222222222222222
```

Guild mode clears global and stale non-target guild definitions, then synchronizes each configured development guild. Never use a production guild ID as a source-code default.
