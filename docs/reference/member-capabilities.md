# Invictus Member Capabilities

Capabilities are scoped to the current guild. The guild must be active, configured, and enabled, and the relevant feature flag must be on. A role or channel configured in one guild never grants access or receives output in another.

## Before Guild Enablement

New and rejoined guilds are disabled. They do not receive message-trigger replies, moderation actions, metrics, scheduled posts, digests, retention work, or backfills.

The guild owner and members with Administrator permission can use the `/setup` family to inspect and configure the guild. Other command families return a setup-required response until `/setup validate` succeeds and an administrator runs `/setup enable`.

## Any Member

When their feature is enabled, ordinary members can use:

- Public Invictus chat intents in normal guild messages containing the configured invocation keyword or an alias.
- Court threads and anonymous-answer flows, subject to the guild's required role, account/member age, cooldown, and link policy.
- Role-panel buttons for configured self-assignable roles. The bot still needs Manage Roles and sufficient hierarchy; managed roles and `@everyone` cannot be self-assigned.
- DM-panel buttons created by an administrator. DM forwarding can fail if the recipient blocks DMs.
- `/greetings send profile:<name>` for a greeting profile configured in the current guild.
- `/fun` verdict, title, fate, battle, stats, and leaderboard commands.
- Royal AFK mention responses in the configured royal-alert channel when the referenced title is AFK.

Component interactions validate the message guild as well as their custom ID. DMs are rejected unless the individual feature explicitly supports them.

## Configured Royal Members

Members with the guild's Emperor or Empress role can use `/invictus afk` to set or clear the AFK state for their bound title. Royal AFK and presence behavior also requires the guild's feature flag and royal-alert channel.

Temporary silence phrases are available only to the configured royal role and apply only to the guild's configured silence-target roles, excluding configured silence-exclude roles. There is no built-in citizen role or production role ID.

## Privileged Invictus Chat

Status, counsel, and title-bestowal conversational intents require one of the current guild's configured privileged-chat roles or its configured champion user. Emperor and Empress bindings are distinct and do not grant privileged chat unless the same role is also added to `privileged-chat`. The invocation keyword and display labels can differ by guild.

## Configured Staff

Members with one of the current guild's configured staff roles can use the `/questions` reports and the non-administrative `/court` operations. Those operations include status, health, analytics, category and question maintenance, manual/custom posting, closing and reopening posts, deadline extension, open-post listing, and answer removal.

Configured staff access is local to that guild. It does not grant `/setup`, process-wide authority, or the administrator-only court operations listed below. Guild owners and Discord Administrators also satisfy the staff check.

## Administrators and Guild Owner

The following operations require the guild owner or Discord Administrator permission and remain subject to Discord bot permissions and role hierarchy:

- all non-purge `/setup` mutations, validation, enablement, disablement, and export;
- court dry runs, state export/import, mode, channel, log-channel, schedule, and history-reset operations;
- Invictus announcements, DM/role panels, message purge, locks, slowmode, timeouts, and bulk moderation;
- user-stat backfill execution/status and royal-presence timer reset;
- Invictus administrative help and royal-AFK status inspection;
- text-triggered reply moderation when enabled.

`/setup validate` checks channels, required bot permissions, configured role existence, silence-target hierarchy, schedules, timezone, limits, and feature dependencies. Role-panel interactions separately reject managed roles and `@everyone` and enforce assignment hierarchy when used. `/setup enable` refuses an incomplete configuration.

## Guild Owner Only

`/setup purge` is restricted to the server owner. It displays what will be removed and requires the exact confirmation `PURGE <guildId>`. A successful purge deletes only the current guild's settings and tenant data. It never deletes the shared database file or another guild's rows.

## Guild Lifecycle

`/setup disable` stops guild behavior without deleting data. If the bot leaves, the guild is marked inactive and all tenant data is retained. Rejoining restores that retained record but does not auto-enable it; an administrator must validate and enable it again.
