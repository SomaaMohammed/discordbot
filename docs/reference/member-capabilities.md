# Superior Member Capabilities

Capabilities are scoped to the current guild. The guild must be active, configured, and enabled, and any relevant feature flag must be on. A channel or role configured in one guild never grants access or receives output in another.

## Before Guild Enablement

New and rejoined guilds are disabled. They do not receive message-trigger replies, moderation actions, activity metrics, or backfill work.

The guild owner and members with Discord Administrator permission can use `/setup` to inspect and configure the guild. Other command families return a setup-required response until setup validates and an administrator enables the guild.

## Any Member

When the relevant feature is enabled, ordinary members can use:

- Public Superior message intents for greetings, help, coin flips, local time, thanks, farewell, ping, uptime, bot information, dice, and choices.
- `/utility ping`, `/utility avatar`, `/utility userinfo`, and `/utility serverinfo`.
- `/fun battle`, `/fun stats`, and `/fun leaderboard`.
- `/superior help` for the current command and feature summary.
- `/greetings send profile:<name>` for a profile configured in that guild.
- Role-panel buttons for configured self-assignable roles. Discord managed roles and `@everyone` cannot be self-assigned, and the bot still needs Manage Roles and sufficient hierarchy.
- DM-panel buttons created by an administrator. Forwarding can fail when the recipient blocks DMs; when a log channel is configured, the submission and sender identity are copied there as disclosed by the panel.

Component interactions validate the message guild as well as their stable custom ID. User-install and unsupported DM command contexts are rejected.

## Legacy Role Bindings

`/setup role` is retired and is not published. All supported conversational intents are public to guild members when `superior-chat` is enabled. Reply moderation requires the guild owner or Discord Administrator permission. Persisted privileged-chat and other legacy role bindings can remain in storage and exports for compatibility and rollback, but they have no active runtime consumer.

## Administrators and Guild Owner

The following operations require the guild owner or Discord Administrator permission and remain subject to the bot's Discord permissions and role hierarchy:

- `/setup` mutations, validation, enablement, disablement, and export;
- `/superior say`, `dmpanel`, `rolepanel`, and `rolepanelmulti`;
- `/superior purge`, `purgeuser`, `lock`, `unlock`, and `slowmode`;
- `/superior timeout`, `untimeout`, `mutemany`, `unmutemany`, `muteall`, and `unmuteall`;
- `/superior backfillstats` and `backfillstatus`;
- text-triggered reply moderation when enabled.

Announcements, panels, moderation targets, channel objects, and role objects are re-resolved in the current guild. Timeout and role actions enforce Discord ownership, permission, managed-role, and hierarchy rules at execution time. Bulk actions honor the configured `mute_target_cap` and their confirmation/dry-run controls.

`/setup validate` checks the log channel, supported feature dependencies, timezone, moderation permission, and configuration shape. It does not reactivate or require old role, court, question, answer, royal, schedule, or staff settings retained in legacy data.

## Guild Owner Only

`/setup purge` is restricted to the server owner. It previews the current guild's removal scope and requires exact `PURGE <guildId>` confirmation. A successful purge deletes only that guild's active-database rows; it does not delete the shared database file, another guild's rows, previously downloaded exports, Discord content, host logs, or operator backups.

## Retired Surfaces and Retained Data

`/court`, `/questions`, anonymous court-answer components, royal AFK/presence commands and triggers, `/fun verdict`, `/fun title`, and `/fun fate` are retired. A stale Discord command or component does not restore them.

Schema-v2 storage and private exports can still contain legacy questions, posts, answer mappings, cooldowns, schedules, royal state, and metrics for compatibility, rollback, retention, and owner-authorized purge. Their presence in storage does not make them active member capabilities.

## Guild Lifecycle

`/setup disable` stops guild behavior without deleting data. If the bot leaves, the guild is marked inactive and retained. Rejoining restores the record but does not auto-enable it; an administrator must review, validate, and enable it again.
