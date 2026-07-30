# Member capabilities

All features are guild-scoped. Superior ignores DMs and refuses work when the guild is disabled, inactive, unconfigured, purged, or invalidated during an asynchronous operation.

## Guild members

- Deliberately address the bot through the configured invocation, a bot mention, or a reply to the bot for natural chat, factual status replies, coin flips, bounded dice, and bounded choices.
- Use `/utility ping`, `avatar`, `userinfo`, `serverinfo`, `roleinfo`, `channelinfo`, `snowflake`, and `timestamp`. Responses are private where the information is primarily for the caller.
- Use `/fun battle`, `/fun stats`, and `/fun leaderboard` when the relevant feature is enabled.
- Use `/greetings send` with any configured profile. `{user}` resolves to the member sending the greeting and does not mass-mention the guild.
- Interact with administrator-posted role panels when the role remains safe and manageable.
- Use a current administrator-posted ticket launcher to submit a bounded subject and description. One active ticket is allowed per member; the resulting channel is visible to the opener, configured support role, and bot under Discord's effective permissions.
- Use Info inside their own ticket to inspect its current state, claim, opener, and subject.

Utilities disclose only information available from the current guild or the supplied public Discord ID. A requested member, role, or channel must belong to the current guild. Inputs are bounded and validated before a response or metric write.

## Administrators

Guild owners and members with Administrator permission can configure the guild with `/setup`, validate before enabling, manage feature flags and greeting profiles, and export active guild data. Only the guild owner can replace same-guild live data with `/setup import` or permanently purge the guild's active database rows; both destructive workflows require exact confirmation. A format-3 import transaction replaces settings, metrics, panel records, ticket configuration, tickets, and ticket events, while a legacy format-2 import replaces settings and metrics and preserves current panel and ticket operational rows. All imports leave the guild and imported ticket configuration disabled for review.

Authorized administrators can use `/superior` to:

- send an announcement or create DM and role panels;
- clean recent messages with `/superior purge` or filter cleanup by member with `/superior purgeuser`;
- lock a channel, unlock only a matching lock tracked by the running process, or set slow mode;
- apply/remove timeouts and perform bounded multi-member moderation;
- backfill or inspect enabled activity statistics; and
- view built-in command help.

Owners and Administrators can also use `/panel list`, `/panel post`, and `/panel status` for Superior's fixed `help`, `server-info`, `resources`, and `tickets` presets. Resource panels accept bounded administrator text and up to five unique HTTPS links. They can use `/ticket setup`, `/ticket status`, `/ticket panel`, `/ticket disable`, and `/ticket recover` to configure and reconcile the support workflow. Ticket setup, panel posting, and recovery revalidate current guild resources, bot permissions, and role hierarchy.

Cleanup preflights View Channel, Read Message History, and Manage Messages. It respects Discord's 100-message bulk limit and the age restriction for bulk deletion, then reports requested, scanned, deleted, and skipped counts instead of claiming filtered messages were removed. Other moderation actions validate bot permissions, actor authority, role hierarchy, the current guild, configured caps, and cancellation state.

## Ticket staff

The configured support role, guild owner, and Administrators are ticket staff. Current membership and role state are fetched again before a staff control is accepted. Ticket staff can inspect, claim, release, and close an open ticket; other members cannot use those management controls. The opener may inspect only their own ticket.

Closing requires a reason. Superior gathers a chronological plain-text transcript of at most 1,000 recent messages and at most 7.5 MiB in memory, including attachment URLs, and marks any truncation. The configured log channel must receive the closure embed and transcript before the record can close; Superior also attempts to DM the same files to the opener. It persists a delivery checkpoint and the closed state before trying to delete the private channel. Delivery or persistence failures preserve the channel for a safe retry or administrator recovery.

## Operator

The process operator controls credentials, registration mode, database path, releases, backups, migration, host access, logging, and service availability.

Host access does not replace in-guild authorization. Operators must follow the [operations runbook](../operations.md), protect credentials and backups, and complete the policy publication prerequisites before public operation.
