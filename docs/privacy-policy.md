# Superior privacy policy

**Effective date:** NOT YET EFFECTIVE<br>
**Last updated:** July 28, 2026

> **Unpublished draft. Do not link this document from the Discord Developer Portal or represent it as an effective policy.** Replace every placeholder, verify the actual hosted deployment, complete the safeguards listed below, and obtain appropriate legal and Discord-policy review first.

Before publication, the operator must document and verify:

- `OPERATOR LEGAL NAME`, a monitored `PRIVACY/SUPPORT EMAIL`, and the countries in which the service is offered;
- hosting provider, processing locations, vendors, access controls, encryption, incident response, and international-transfer arrangements;
- fixed retention and deletion periods for application logs, inactive guild data, backups, and incident records;
- prompt deletion after confirmed guild removal, individual access/deletion handling, and any required opt-out or re-collection controls;
- whether optional per-member activity metrics, history backfill, leaderboards, guild exports, and DM-panel delivery comply with Discord's current developer requirements and applicable law; and
- clear in-product disclosures for features that send content to another member or an administrator-visible log channel.

## 1. Operator and scope

Superior (the “Bot”) is operated by **OPERATOR LEGAL NAME** (“we,” “us,” or “our”). Contact **PRIVACY/SUPPORT EMAIL** for privacy, deletion, security, or support requests.

This draft describes the official hosted Bot. An independent operator of the source code controls a separate deployment and must publish an accurate policy for that deployment.

Discord separately processes account, server, message, and interaction data under [Discord's Privacy Policy](https://discord.com/privacy). This policy covers only processing controlled by the Bot operator.

## 2. Data the Bot processes

Depending on enabled features, the Bot processes:

- **Guild metadata:** guild ID, guild name, enabled state, and join/leave timestamps.
- **Guild settings:** feature flags, log-channel ID, IANA timezone, invocation keyword and aliases, finite moderation limit, and greeting profile names/messages.
- **Command and interaction data:** guild, channel, user, member, role, message, and interaction identifiers and the options needed to validate and complete a request.
- **Message and reaction events:** content and metadata needed in memory to recognize a deliberately addressed request, perform authorized moderation or cleanup, send a panel submission, or update enabled activity metrics.
- **Metrics:** guild-scoped command counters and, when activity metrics are enabled, member-ID-scoped counts for messages, reactions, and game results. Activity backfill reads eligible Discord history to reconstruct selected counts.
- **Operational records:** startup, shutdown, command failure, migration, security, and diagnostic information written by the host. Exact log fields and retention must be verified before publication.

The active schema contains only `schema_migrations`, `guilds`, `guild_settings`, and `metrics`. It does not persist ordinary message content. A DM panel delivers submitted content through Discord only to the selected recipient; it does not copy the content, sender, or recipient to the configured guild log channel. A successful delivery increments a guild-scoped aggregate command counter that contains none of those details. The Discord-hosted direct message is governed by the visibility and retention of that destination.

Do not submit passwords, tokens, payment data, government identifiers, health information, or other sensitive information to the Bot.

## 3. Why data is used

Data is used to:

- provide requested commands, conversational replies, greetings, utilities, panels, and moderation actions;
- enforce guild configuration, permissions, role hierarchy, input limits, cooldowns, and tenant isolation;
- maintain optional activity statistics and leaderboards selected by guild administrators;
- diagnose failures, prevent abuse, secure the service, and meet legal or Discord obligations; and
- respond to support, privacy, and security requests.

The operator must identify and document the lawful basis for each processing purpose in every applicable jurisdiction before publication. The Bot must not be used for advertising profiles, sale of personal data, or automated decisions with legal or similarly significant effects.

## 4. Who receives data

Data may be received by:

- Discord, as the platform carrying commands, messages, interactions, and responses;
- `HOSTING PROVIDER` and verified infrastructure vendors needed to operate and secure the Bot;
- guild members or administrators who can see the relevant Discord channel, response, panel destination, leaderboard, log channel, or authorized guild export;
- personnel authorized by the operator under least-privilege access controls; and
- authorities or other parties when disclosure is lawfully required, necessary to protect rights and safety, or part of a properly disclosed business transfer.

The operator does not sell personal data. Vendor identities, processing locations, contracts, and transfer safeguards remain publication blockers until completed.

## 5. Retention

Current application behavior is not yet a public retention commitment:

- Active schema rows remain until an authorized guild-owner purge or operator deletion. Removing the Bot marks a guild inactive but does not currently delete its rows automatically.
- A guild-owner purge removes that guild's active metadata, settings, and metrics from the live database. It does not securely erase SQLite free pages or delete Discord messages, host logs, downloaded exports, or backups.
- Host logs and backups do not have an enforced repository-level expiry. The operator must set, document, test, and monitor fixed schedules before publication.
- A migration backup can contain information that is no longer present in the active schema and must receive the same or stronger access, retention, and deletion controls.
- Downloaded exports are controlled by the administrator or Discord client that receives them.

When required by Discord or law, API data must be deleted promptly after an applicable user request, when no longer needed, or when the hosted Bot stops operating, unless retention is legally required. The operator must implement verified deletion across live data, logs, backups, and vendors before publication.

## 6. Choices and requests

Guild administrators can disable individual features or the guild. The guild owner can use the exact-confirmation `/setup purge` flow. Members can ask guild staff to address Discord-hosted content and can contact **PRIVACY/SUPPORT EMAIL** to request access, correction, deletion, restriction, objection, portability, or other rights available under applicable law.

Include the relevant Discord user ID and guild ID, but never send a password or bot token. We may verify control of the account and request only the context necessary to locate data. Deleting Bot data does not delete a copy hosted by Discord; use Discord controls or contact the relevant guild administrators for that copy.

The current implementation does not yet provide a tested end-to-end individual export, deletion, and re-collection opt-out workflow. It must not be described as doing so.

## 7. Security and incidents

The code provides guild scoping, lifecycle invalidation, permission checks, bounded inputs, explicit database migration, integrity checks, private backup guidance, and secret exclusions. The deployment must separately verify encryption, host hardening, patching, credential rotation, least-privilege access, monitoring, recovery, and vendor controls. No system is guaranteed completely secure.

Report a suspected incident privately to **PRIVACY/SUPPORT EMAIL**. The operator must begin containment and investigation promptly and notify Discord, affected people, regulators, or others when required.

## 8. Children

The Bot is not directed to anyone below the minimum age to use Discord in their country. If a parent or guardian believes prohibited child data was processed, contact **PRIVACY/SUPPORT EMAIL** so the operator can verify and respond as required.

## 9. Changes

An effective policy must be hosted at a stable public URL. Material changes require an updated date and any notice or consent required by law. This draft has no effect until the publication prerequisites are completed and an effective date is added.

## 10. Contact

**Operator:** OPERATOR LEGAL NAME<br>
**Privacy, deletion, security, and support:** PRIVACY/SUPPORT EMAIL

Do not place private Discord data or vulnerability details in a public issue.
