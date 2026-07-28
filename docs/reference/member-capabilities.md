# Member capabilities

All features are guild-scoped. Superior ignores DMs and refuses work when the guild is disabled, inactive, unconfigured, purged, or invalidated during an asynchronous operation.

## Guild members

- Deliberately address the bot through the configured invocation, a bot mention, or a reply to the bot for natural chat, factual status replies, coin flips, bounded dice, and bounded choices.
- Use `/utility ping`, `avatar`, `userinfo`, `serverinfo`, `roleinfo`, `channelinfo`, `snowflake`, and `timestamp`. Responses are private where the information is primarily for the caller.
- Use `/fun battle`, `/fun stats`, and `/fun leaderboard` when the relevant feature is enabled.
- Use `/greetings send` with any configured profile. `{user}` resolves to the member sending the greeting and does not mass-mention the guild.
- Interact with administrator-posted role panels when the role remains safe and manageable.

Utilities disclose only information available from the current guild or the supplied public Discord ID. A requested member, role, or channel must belong to the current guild. Inputs are bounded and validated before a response or metric write.

## Administrators

Guild owners and members with Administrator permission can configure the guild with `/setup`, validate before enabling, manage feature flags and greeting profiles, and export/import active guild data. Only the guild owner can permanently purge the guild's active database rows through the exact confirmation flow.

Authorized administrators can use `/superior` to:

- send an announcement or create DM and role panels;
- clean recent messages with `/superior purge` or filter cleanup by member with `/superior purgeuser`;
- lock a channel, unlock only a matching lock tracked by the running process, or set slow mode;
- apply/remove timeouts and perform bounded multi-member moderation;
- backfill or inspect enabled activity statistics; and
- view built-in command help.

Cleanup preflights View Channel, Read Message History, and Manage Messages. It respects Discord's 100-message bulk limit and the age restriction for bulk deletion, then reports requested, scanned, deleted, and skipped counts instead of claiming filtered messages were removed. Other moderation actions validate bot permissions, actor authority, role hierarchy, the current guild, configured caps, and cancellation state.

## Operator

The process operator controls credentials, registration mode, database path, releases, backups, migration, host access, logging, and service availability.

Host access does not replace in-guild authorization. Operators must follow the [operations runbook](../operations.md), protect credentials and backups, and complete the policy publication prerequisites before public operation.
