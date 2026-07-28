# Configuration

Superior uses one Discord application, one process configuration, and one shared SQLite database. Guild configuration is stored separately for each guild and starts disabled.

## Discord application

In the Discord Developer Portal:

1. Create or select the application and bot user.
2. Reset and securely store the bot token. Put it only in `.env`; never commit or paste it into logs.
3. Enable the privileged **Server Members Intent** and **Message Content Intent**. The runtime also uses Guilds, Guild Messages, and Guild Message Reactions.
4. Install the application with the `bot` and `applications.commands` scopes.
5. Grant only the permissions required for enabled features. Typical capabilities need View Channels, Send Messages, Embed Links, Read Message History, and Attach Files. Message cleanup needs Manage Messages; channel locking and slow mode need Manage Channels; timeouts need Moderate Members; role panels need Manage Roles. Mention Everyone is needed only when an administrator explicitly chooses that panel option.

Keep the bot's highest role above roles it must manage or members it must moderate. Superior checks its effective channel permissions and role hierarchy before acting.

## Process environment

Copy `.env.example` to `.env` in the application root. For a Windows portable build, that is the folder containing `SuperiorBot.exe`.

| Variable                    | Required      | Meaning                                                                                     |
| --------------------------- | ------------- | ------------------------------------------------------------------------------------------- |
| `DISCORD_TOKEN`             | Yes           | Bot token from the Developer Portal.                                                        |
| `DB_FILE`                   | No            | SQLite path. A relative value resolves from the application root; default is `superior.db`. |
| `BOT_VERSION`               | No            | Display override; normally leave blank to use package version 5.0.1.                        |
| `COMMAND_REGISTRATION_MODE` | No            | `global` for production or `guild` for development. Defaults to `global`.                   |
| `DEV_GUILD_IDS`             | In guild mode | Comma-separated development guild IDs.                                                      |

`SuperiorBot.exe --check` validates portable configuration and native SQLite without Discord login. Source check commands are documented in [Development](development.md).

## Command registration

Use global registration for production. Discord can take time to propagate global command changes. Use guild registration only for controlled development because updates appear faster.

Never put a production guild ID into source code. Development IDs belong in the local environment file.

## Guild onboarding

After the bot joins a guild, an owner or member with Administrator permission should run:

1. `/setup status`
2. `/setup channel` if audit output should go to a dedicated channel
3. `/setup timezone`
4. `/setup trigger` to set a primary invocation and optional aliases
5. `/setup feature` for `chat`, `reply-moderation`, `greetings`, and `activity-metrics`
6. `/setup limits` to set the finite bulk-moderation cap
7. `/setup greeting` to add neutral reusable profiles if greetings are enabled
8. `/setup validate`
9. `/setup enable`

`/setup disable` stops guild behavior without deleting data. Leaving a guild marks it inactive. `/setup purge` permanently removes only that guild's active rows after an exact owner confirmation; it does not delete Discord-hosted messages, logs, exports, or backups.

### Greeting profiles

A profile contains only a name and message. It is never tied to a stored member ID. In profile text, `{user}` becomes the safe display mention of whoever runs `/greetings send`. Every member in an enabled guild can choose a configured profile, and a greeting never expands to a mass mention.

## Active commands

- `/setup`: status, enable, disable, channel, feature, timezone, limits, trigger, greeting, validate, export, import, and guild-data purge.
- `/superior`: `say`, `dmpanel`, `rolepanel`, `rolepanelmulti`, `purge`, `purgeuser`, `lock`, `unlock`, `slowmode`, `timeout`, `untimeout`, `mutemany`, `unmutemany`, `muteall`, `unmuteall`, `backfillstats`, `backfillstatus`, and `help`.
- `/utility`: `ping`, `avatar`, `userinfo`, `serverinfo`, `roleinfo`, `channelinfo`, `snowflake`, and `timestamp`.
- `/fun`: `battle`, `stats`, and `leaderboard` while the activity-metrics feature is enabled.
- `/greetings send`: send one configured profile as the current member.

The `roleinfo`, `channelinfo`, `snowflake`, and `timestamp` utilities validate bounded input, remain guild-scoped where relevant, and reply privately. See [Member capabilities](reference/member-capabilities.md) for access details.

## Lifecycle and isolation

Events and interactions are rejected when the guild is missing, disabled, inactive, removed, purged, or has changed configuration during asynchronous work. Guild resources are revalidated against the interaction guild. Successful metrics are written only after the corresponding reply succeeds.
