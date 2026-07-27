# Configuration and Guild Setup

Version 2 separates process configuration from per-guild configuration. The process knows how to connect to Discord, where the shared database is, and where commands are registered. Channels, roles, schedules, limits, greetings, labels, and feature choices are stored in SQLite for one guild and are changed through `/setup`.

## Discord Application Installation

Create or select one Discord application in the Discord Developer Portal, enable Guild Install for it, and install its bot in each guild that should use it. Keep user-install-only contexts disabled unless a separately designed feature needs them; this runtime expects guild context.

Use these OAuth2 scopes:

- `bot`
- `applications.commands`

Enable these privileged gateway intents:

- Message Content Intent, required by conversational Invictus triggers, reply moderation, silence phrases, royal AFK mentions, and message backfill.
- Server Members Intent, called Guild Members Intent in some Discord interfaces, required by role checks, member-age limits, moderation, greetings, and member resolution.

The runtime subscribes to Guilds, Guild Members, Guild Messages, Guild Message Reactions, and Message Content gateway events. If the application becomes public or reaches Discord's verification thresholds, account for Discord's current approval requirements for privileged intents in the Developer Portal before broad deployment.

Grant only the permissions needed by the features a guild enables. Common requirements are:

- View Channels, Send Messages, Embed Links, Read Message History, Create Public Threads, and Send Messages in Threads for court posts and replies.
- Manage Threads for automatic thread closure.
- Read Message History for reaction metrics and message backfill. The bot reads existing reactions; it does not need Add Reactions for those features.
- Manage Messages for message purge operations.
- Moderate Members for reply-moderation and explicit timeout features.
- Manage Roles for role panels, configured role actions, and temporary role permission overwrites used by channel locks.
- Manage Channels for slowmode changes and other channel-management operations.

Discord role hierarchy still applies. Place the bot's highest role above every role it must assign, remove, or moderate. `/setup validate` reports missing required channel permissions, inaccessible channels, missing configured roles, and silence-target hierarchy problems before enablement. Role-panel and moderation actions enforce their additional managed-role and hierarchy constraints when used.

## Process Configuration

Copy the sanitized example and keep the real file local:

```bash
cp .env.example .env
```

Supported process keys are:

| Key | Purpose |
| --- | --- |
| `DISCORD_TOKEN` | Required Discord bot token. Never print or commit it. |
| `DB_FILE` | Shared SQLite file. A relative path resolves from the repository root; default is `court.db`. |
| `BOT_VERSION` | Optional process-wide displayed version override. The package version is used when empty. |
| `COMMAND_REGISTRATION_MODE` | `global` for production or `guild` for development. Defaults to `global`. |
| `DEV_GUILD_IDS` | Comma-separated development guild snowflakes. Required only in `guild` registration mode. |
| `BOT_OPERATOR_USER_IDS` | Reserved process metadata. It currently grants no runtime command or setup authority. |
| `SCHEDULER_CONCURRENCY` | Positive process-wide bound for concurrent per-guild background work. |
| `LEGACY_GUILD_ID` | One-time tenant ID used while migrating a legacy v1 database. Remove after migration. |

Every configured snowflake is validated. In production, leave registration mode as `global` and leave `DEV_GUILD_IDS` empty. Runtime authorization comes from the current guild's ownership, Discord Administrator permission, and configured guild roles—not from `BOT_OPERATOR_USER_IDS`.

The runtime normally reads `<repository>/.env`. Set `ENV_FILE` in the launching shell or systemd service to select another file; relative values resolve from the repository root. `ENV_FILE` is a bootstrap setting and cannot select itself from inside an otherwise unknown file. The operations wrapper and runtime honor the same selection.

Version 1 guild-specific keys are not normal version 2 process configuration. The isolated migration path may read `TIMEZONE`, `COURT_CHANNEL_ID`, `LOG_CHANNEL_ID`, `WEEKLY_DIGEST_CHANNEL_ID`, `ROYAL_ALERT_CHANNEL_ID`, `STAFF_ROLE_IDS`, `EMPEROR_ROLE_ID`, `EMPRESS_ROLE_ID`, `SILENT_LOCK_EXCLUDE_ROLES`, `ANON_REQUIRED_ROLE_ID`, `WEEKLY_DIGEST_WEEKDAY`, `WEEKLY_DIGEST_HOUR`, `ANON_MIN_ACCOUNT_AGE_MINUTES`, `ANON_MIN_MEMBER_AGE_MINUTES`, `ANON_COOLDOWN_SECONDS`, `ANON_ALLOW_LINKS`, `MUTEALL_TARGET_CAP`, `ANSWER_RETENTION_DAYS`, and `UNDEFEATED_USER_ID` once to seed the legacy guild. Preserve Discord IDs as exact strings during migration. `TEST_GUILD_ID` is accepted only as a deprecated fallback for `LEGACY_GUILD_ID` during that first migration; it does not select the runtime guild or command-registration target.

After a successful migration and configuration review, remove deprecated guild-specific keys from the service environment. Persisted guild settings are authoritative for normal version 2 behavior.

## Disabled-First Lifecycle

When the bot joins a guild, it creates or reactivates non-sensitive guild metadata but leaves the guild disabled. It does not automatically post, moderate, respond to message triggers, record metrics, or run jobs.

Only the guild owner or a member with Discord Administrator permission can use setup mutations. Until the guild is enabled, setup commands remain available and other command families return an actionable setup-required response.

The recommended first-run sequence is:

1. Run `/setup status` to see the enabled state and a compact schedule, feature, channel, and staff summary.
2. Bind channels with `/setup channel`.
3. Bind roles with `/setup role`.
4. Enable only the desired capabilities with `/setup feature`.
5. Configure timezone, posting and digest schedules with `/setup schedule`.
6. Review anonymous-answer, moderation, and retention values with `/setup limits`.
7. Customize the Invictus keyword and aliases with `/setup trigger` if desired.
8. Add greeting profiles with `/setup greeting` if greetings are enabled.
9. Run `/setup export` and privately review the complete persisted configuration; the export can contain guild data and should not be posted publicly.
10. Run `/setup validate` and resolve every error.
11. Run `/setup enable`. Enablement is refused while validation has blocking errors.

Use `/setup disable` before maintenance or whenever automated behavior should stop. Disabling preserves all settings and guild data.

## Channels and Roles

Channel bindings are guild-local:

```text
/setup channel
  purpose:<court|log|weekly-digest|royal-alert>
  action:<set|clear>
  channel:<required for set>
```

- `court` receives scheduled and manual court posts.
- `log` receives operational or moderation logs when configured.
- `weekly-digest` receives weekly analytics summaries.
- `royal-alert` hosts royal AFK and presence behavior.

The selected binding must be a Guild Text or Guild Announcement channel in the current guild; thread channels are not accepted as setup bindings. The bot can still create and use court reply threads beneath a valid bound channel. Stored channel and message IDs are rechecked against the current guild when resolved; a cross-guild object is rejected.

Role bindings are also guild-local:

```text
/setup role
  purpose:<staff|privileged-chat|emperor|empress|silence-target|silence-exclude|anonymous-required>
  action:<set|add|remove|clear>
  role:<required when applicable>
```

List-valued purposes support `add` and `remove`; single-valued purposes support `set` and `clear`. New guild defaults contain no role IDs. Permission checks never rely on a role being globally unique and never weaken Discord's Administrator, ownership, or role-hierarchy rules.

Existing `/court channel`, `/court logchannel`, `/court mode`, and `/court schedule` commands remain guild-scoped compatibility aliases where supported. `/setup` is the canonical administration interface.

## Features

Feature flags are independent per guild:

```text
/setup feature
  name:<court|invictus-chat|anonymous-answers|reply-moderation|silence-lock|royal-afk|royal-presence|weekly-digest|greetings>
  enabled:<true|false>
```

Available capabilities include court posting, Invictus chat, anonymous answers, reply moderation, silence lock, royal AFK, royal presence, weekly digest, and greetings. Disabled features perform no event or scheduled side effects.

Some features require other settings:

- Court posting requires a court channel and a non-`off` posting mode.
- Weekly digest requires its feature, a digest channel, and a valid schedule.
- Royal AFK and presence require the appropriate royal roles and royal-alert channel.
- Silence lock requires at least one target role; exclusion roles and bot hierarchy are validated.
- Anonymous answers require the court feature and any configured required role, age, cooldown, and link policy to be valid.
- Reply and bulk moderation require the relevant bot permissions and a valid target hierarchy.
- Greetings require at least one valid greeting profile before they can be used.

## Timezone, Schedules, and Limits

Each guild has its own IANA timezone and schedules. The safe default is UTC with court posting off. Court schedules support `off`, `manual`, and `auto` modes with an hour and minute. Weekly digest schedules use a weekday and hour.

```text
/setup schedule
  target:<court|weekly-digest>
  timezone:<optional IANA timezone>
  mode:<off|manual|auto when target is court>
  weekday:<optional 0-6>
  hour:<optional 0-23>
  minute:<optional 0-59>
  dry_run:<optional boolean>
```

Jobs calculate dates and week keys in the owning guild's timezone. One guild's timezone, post date, digest week, retention value, or job failure cannot affect another guild.

`/setup limits` accepts optional `account_age_minutes`, `member_age_minutes`, `cooldown_seconds`, `allow_links`, `mute_target_cap`, and `retention_days` values. It changes only the supplied values, and validation constrains every value to its supported range.

## Invocation Labels and Greetings

The default conversational invocation keyword is `invictus`; aliases are optional and validated per guild:

```text
/setup trigger keyword:<text> aliases:<optional comma-separated text>
```

Emperor and Empress display labels can be customized without changing the underlying permission bindings:

```text
/setup labels emperor:<optional text> empress:<optional text>
```

The optional per-guild champion replaces the old built-in undefeated user:

```text
/setup champion user:<optional user> clear:<optional true>
```

Greetings use named profiles rather than built-in people or user IDs:

```text
/setup greeting action:<add|update|remove|list>
  name:<profile>
  user:<optional user>
  message:<optional text>

/greetings send profile:<name>
```

Profile lookup is validated within the current guild. A legacy migration may create profiles that preserve the old guild's behavior, but they are never defaults for a new guild.

## Validation, Export, and Purge

`/setup validate` checks the current guild only, including:

- required channels, channel types, channel accessibility, and bot permissions;
- configured role existence and silence-target bot hierarchy;
- timezone and schedule ranges;
- feature dependencies;
- anonymous-answer and moderation dependencies.

`/setup export` exports only the current guild's settings and data. Imports must identify the owning guild and reject a mismatched guild ID; moving data between guilds requires a separately designed owner-authorized migration operation.

`/setup purge` is destructive and is restricted to the server owner, not merely an administrator. Begin with a non-confirming placeholder to receive the current removal scope and exact expected text, then invoke it again with `PURGE <guildId>` exactly. It deletes rows for the current guild and cannot affect another guild, the shared schema, the live database file, or operator backups.

## Leave and Rejoin Behavior

When the bot leaves or is removed from a guild, the guild is marked inactive and `left_at` is recorded. Stored settings and tenant data are retained. Scheduled work stops because inactive and disabled guilds are not selected.

If the bot rejoins, the existing record and data are retained, `left_at` is cleared, and the guild remains disabled. An administrator must review `/setup status`, run `/setup validate`, and explicitly enable the guild again.

## Command Registration

Production registration uses application-global commands:

```dotenv
COMMAND_REGISTRATION_MODE=global
DEV_GUILD_IDS=
```

Discord can take time to propagate global command changes. Global mode first clears every stale cached guild scope while leaving the last-known global set active, then replaces the global definitions only after all guild clears succeed. If a guild clear fails, registration aborts without deleting the existing global commands, so operators retain a working command set without creating mixed duplicate scopes. Do not add guild command copies as a workaround.

For fast development iteration, use guild mode with synthetic or development-only IDs:

```dotenv
COMMAND_REGISTRATION_MODE=guild
DEV_GUILD_IDS=111111111111111111,222222222222222222
```

Guild mode clears the global set and stale non-target guild sets, then synchronizes each configured development guild independently. Logs include the guild context and command count, and one target failure does not stop the others. Never use a production guild ID as a source-code default.
