# Configuration

Superior uses one Discord application, one process configuration, and one shared SQLite database. Guild configuration is stored separately for each guild and starts disabled.

## Discord application

In the Discord Developer Portal:

1. Create or select the application and bot user.
2. Reset and securely store the bot token. Put it only in `.env`; never commit or paste it into logs.
3. Enable the privileged **Server Members Intent** and **Message Content Intent**. The runtime also uses Guilds, Guild Messages, and Guild Message Reactions.
4. Install the application with the `bot` and `applications.commands` scopes.
5. Grant only the permissions required for enabled features. Typical capabilities need View Channels, Send Messages, Embed Links, Read Message History, and Attach Files. Message cleanup needs Manage Messages; channel locking and slow mode need Manage Channels; timeouts need Moderate Members; role panels need Manage Roles. Tickets require global Manage Channels and Manage Roles; the ticket category must allow View Channel, Send Messages, Read Message History, Embed Links, Attach Files, Manage Channels, and Manage Roles; and the closure-log channel must allow View Channel, Send Messages, Read Message History, Embed Links, and Attach Files. Mention Everyone is needed only when an administrator explicitly chooses that panel option.

Keep the bot's highest role above roles it must manage or members it must moderate. Superior checks its effective channel permissions and role hierarchy before acting.

## Process environment

Copy `.env.example` to `.env` in the application root. For a Windows portable build, that is the folder containing `SuperiorBot.exe`.

| Variable                    | Required      | Meaning                                                                                     |
| --------------------------- | ------------- | ------------------------------------------------------------------------------------------- |
| `DISCORD_TOKEN`             | Yes           | Bot token from the Developer Portal.                                                        |
| `DB_FILE`                   | No            | SQLite path. A relative value resolves from the application root; default is `superior.db`. |
| `BOT_VERSION`               | No            | Display override; normally leave blank to use package version 5.2.0.                        |
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

If the guild will use support tickets, continue with `/ticket setup` after enabling the guild. Select a category, a text or announcement log channel, and a dedicated support role, then post the launcher with `/ticket panel` or `/panel post preset:tickets`.

`/setup disable` stops guild behavior without deleting data. Leaving a guild marks it inactive. `/setup purge` is owner-only and permanently removes only that guild's active rows after an exact confirmation; it does not delete Discord-hosted messages, logs, exports, or backups.

`/setup export` lets the guild owner or an Administrator download the current same-guild data. `/setup import` is owner-only, requires an exact same-guild confirmation, and applies a validated file in one database transaction. A format-3 import replaces the current settings, metrics, posted-panel records, ticket configuration, tickets, and ticket events. A legacy format-2 import replaces settings and metrics but preserves the current panel and ticket operational rows. Every successful import leaves the guild disabled and requiring review, and any imported ticket configuration is forced disabled. Review the file and `/setup status`, run `/setup validate` and `/setup enable`, then inspect `/panel status` and `/ticket status`; after a format-3 import, explicitly run `/ticket setup` before accepting new tickets. Keep a protected pre-import export or operator backup when rollback may be necessary. Import and purge change only the live database and do not remove previously downloaded exports, operator backups, or Discord-hosted content.

### Greeting profiles

A profile contains only a name and message. It is never tied to a stored member ID. In profile text, `{user}` becomes the safe display mention of whoever runs `/greetings send`. Every member in an enabled guild can choose a configured profile, and a greeting never expands to a mass mention.

## Active commands

- `/setup`: status, enable, disable, channel, feature, timezone, limits, trigger, greeting, validate, export, import, and guild-data purge.
- `/superior`: `say`, `dmpanel`, `rolepanel`, `rolepanelmulti`, `purge`, `purgeuser`, `lock`, `unlock`, `slowmode`, `timeout`, `untimeout`, `mutemany`, `unmutemany`, `muteall`, `unmuteall`, `backfillstats`, `backfillstatus`, and `help`.
- `/panel`: `list`, `post`, and `status` for fixed Superior panels.
- `/ticket`: `setup`, `status`, `panel`, `disable`, and `recover` for the support-ticket service.
- `/utility`: `ping`, `avatar`, `userinfo`, `serverinfo`, `roleinfo`, `channelinfo`, `snowflake`, and `timestamp`.
- `/fun`: `battle`, `stats`, and `leaderboard` while the activity-metrics feature is enabled.
- `/greetings send`: send one configured profile as the current member.

The `roleinfo`, `channelinfo`, `snowflake`, and `timestamp` utilities validate bounded input, remain guild-scoped where relevant, and reply privately. See [Member capabilities](reference/member-capabilities.md) for access details.

## Superior panels

Only the guild owner or a currently verified member with Administrator permission can use `/panel` or `/ticket` configuration commands. The current presets are:

- `help`: active member services and administrator command families;
- `server-info`: a bounded snapshot of the current guild;
- `resources`: administrator-supplied title and body plus up to five unique HTTPS links; and
- `tickets`: the button that opens the configured ticket form.

Every preset and ticket lifecycle embed uses Superior's fixed gold theme and footer. Member- or administrator-controlled text cannot select arbitrary styling, and these payloads suppress automatic mentions.

`/panel list` explains the presets. `/panel post` targets a text or announcement channel and records the bot-authored message so `replace_existing` can refresh it safely. Posting requires View Channel, Send Messages, Read Message History, and Embed Links in the destination. `/panel status` privately shows up to 20 tracked panels and the current ticket configuration. A ticket preset is refused until ticket resources are configured, enabled, present in the guild, and usable by the bot.

## Ticket configuration and workflow

`/ticket setup` validates all selected resources before enabling new tickets:

- the category and log channel must belong to the current guild;
- the support role cannot be `@everyone`, managed, or from another guild;
- unless the actor is the guild owner, the actor's highest role must be above the support role;
- the bot's highest role must be above the support role; it must have Manage Channels and Manage Roles globally; and the category must grant View Channel, Send Messages, Read Message History, Embed Links, Attach Files, Manage Channels, and Manage Roles; and
- the log channel must grant the bot View Channel, Send Messages, Read Message History, Embed Links, and Attach Files.

Members use the launcher to submit a subject of up to 100 characters and details of up to 1,000 characters. Superior permits one `creating`, `open`, or `closing` ticket per member, creates a private text channel under the configured category, and grants access to the opener, support role, and bot. The welcome message provides Claim, Release, Info, and Close controls. The opener can inspect the ticket; the configured support role, guild owner, and Administrators can manage it. There is no delegated-manager role in this phase.

Closing requires a reason of up to 400 characters. Superior assembles a bounded plain-text transcript in memory, sends the closure record and transcript to the configured log channel, attempts the same delivery to the opener by DM, persists the closure, and then deletes the ticket channel. The transcript includes at most 1,000 messages and 7.5 MiB of UTF-8 text; truncation is marked in the file. A log or transcript failure preserves the channel and leaves or returns the record to a recoverable state.

`/ticket status` rechecks resource and permission health. `/ticket disable` stops new tickets but preserves existing channels and records. While any ticket is creating, open, or closing, `/ticket setup` permits a log-channel-only update but refuses category or support-role changes so an obsolete live role cannot retain channel access; close the active tickets before rotating either live resource. If Discord definitively confirms that the previous category or support role was deleted, setup permits its replacement to avoid a recovery deadlock and instructs staff to run `/ticket recover` for every active record. A transient Discord lookup failure never authorizes that exception.

`/ticket recover ticket_number:<number>` reconciles an interrupted creation or closure, removes a lingering channel for a closed ticket, or recreates/refreshes the controls for an active ticket whose channel or control message is missing. A channel-less creation or an unlogged closing state must remain unchanged for five minutes before recovery treats it as interrupted, avoiding interference with a live interaction. Persisted ticket state and closure-log checkpoints allow restart-safe retries, but external Discord delivery and deletion are still subject to Discord availability and permissions.

## Lifecycle and isolation

Events and interactions are rejected when the guild is missing, disabled, inactive, removed, purged, or has changed configuration during asynchronous work. Guild resources are revalidated against the interaction guild. Successful metrics are written only after the corresponding reply succeeds.
