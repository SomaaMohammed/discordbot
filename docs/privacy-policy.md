# Superior privacy policy

**Effective date:** NOT YET EFFECTIVE<br>
**Last updated:** July 30, 2026

> **Unpublished draft. Do not link this document from the Discord Developer Portal or represent it as an effective policy.** Replace every placeholder, verify the actual hosted deployment, complete the safeguards listed below, and obtain appropriate legal and Discord-policy review first.

Before publication, the operator must document and verify:

- `OPERATOR LEGAL NAME`, a monitored `PRIVACY/SUPPORT EMAIL`, and the countries in which the service is offered;
- hosting provider, processing locations, vendors, access controls, encryption, incident response, and international-transfer arrangements;
- fixed retention and deletion periods for application logs, inactive guild data, backups, and incident records;
- prompt deletion after confirmed guild removal, individual access/deletion handling, and any required opt-out or re-collection controls;
- whether optional per-member activity metrics, history backfill, leaderboards, guild exports, DM-panel delivery, and support-ticket transcripts comply with Discord's current developer requirements and applicable law; and
- clear in-product disclosures for features that send content to another member, create a staff-visible private channel, or deliver content to an administrator-visible log channel.

## 1. Operator and scope

Superior (the “Bot”) is operated by **OPERATOR LEGAL NAME** (“we,” “us,” or “our”). Contact **PRIVACY/SUPPORT EMAIL** for privacy, deletion, security, or support requests.

This draft describes the official hosted Bot. An independent operator of the source code controls a separate deployment and must publish an accurate policy for that deployment.

Discord separately processes account, server, message, and interaction data under [Discord's Privacy Policy](https://discord.com/privacy). This policy covers only processing controlled by the Bot operator.

## 2. Data the Bot processes

Depending on enabled features, the Bot processes:

- **Guild metadata:** guild ID, guild name, enabled state, and join/leave timestamps.
- **Guild settings:** feature flags, log-channel ID, IANA timezone, invocation keyword and aliases, finite moderation limit, and greeting profile names/messages.
- **Command and interaction data:** guild, channel, user, member, role, message, and interaction identifiers and the options needed to validate and complete a request.
- **Panel records:** panel preset, guild/channel/message identifiers, an opaque panel identifier, timestamps, and bounded administrator-supplied resource-panel title, body, and HTTPS links when that preset is used.
- **Ticket configuration and records:** selected category, log-channel, and support-role IDs; whether new tickets are enabled; ticket number and opaque ID; opener ID; channel and control-message IDs; subject and description; lifecycle state; claimant/closer IDs; closure reason and log-message checkpoint; timestamps; bounded failure/recovery details; and ordered lifecycle events.
- **Message and reaction events:** content and metadata needed in memory to recognize a deliberately addressed request, perform authorized moderation or cleanup, send a panel submission, create or close a support ticket, or update enabled activity metrics.
- **Metrics:** guild-scoped command counters and, when activity metrics are enabled, member-ID-scoped counts for messages, reactions, and game results. Activity backfill reads eligible Discord history to reconstruct selected counts.
- **Operational records:** startup, shutdown, command failure, migration, security, and diagnostic information written by the host. Exact log fields and retention must be verified before publication.

Schema v4 contains `schema_migrations`, `guilds`, `guild_settings`, `metrics`, `ticket_configurations`, `posted_panels`, `tickets`, and `ticket_events`. Tenant-owned rows are guild-scoped and cascade when the guild record is purged. Ordinary Discord conversation and ticket-channel history are not copied into the SQLite database, but administrator-authored resource-panel content and the subject, description, closure reason, identifiers, and lifecycle metadata of a ticket are persisted.

When authorized staff close a ticket, the Bot reads up to 1,000 recent messages from that channel and builds a chronological UTF-8 plain-text transcript entirely in memory. The transcript is capped at 7.5 MiB, includes author/timestamp/message identifiers, message text, and up to ten attachment URLs per included message, and explicitly marks message-count or byte truncation. The Bot must send the closure record and transcript to the configured guild log channel before finalizing closure, then attempts to send the same material to the opener by direct message. The transcript buffer is not written to the Bot's local database or filesystem by this workflow. The resulting Discord-hosted log message and any successful direct message follow the visibility and retention of those destinations; the database retains the log-message ID and delivery time as a restart-safe checkpoint.

A DM-panel submission remains a separate feature: it is delivered through Discord only to the selected recipient and is not copied to the configured guild log channel. Its aggregate success metric contains none of the submitted content, sender, or recipient details.

Do not submit passwords, tokens, payment data, government identifiers, health information, or other sensitive information to the Bot.

## 3. Why data is used

Data is used to:

- provide requested commands, conversational replies, greetings, utilities, panels, support tickets, and moderation actions;
- enforce guild configuration, permissions, role hierarchy, input limits, cooldowns, and tenant isolation;
- maintain optional activity statistics and leaderboards selected by guild administrators;
- diagnose failures, prevent abuse, secure the service, and meet legal or Discord obligations; and
- respond to support, privacy, and security requests.

The operator must identify and document the lawful basis for each processing purpose in every applicable jurisdiction before publication. The Bot must not be used for advertising profiles, sale of personal data, or automated decisions with legal or similarly significant effects.

## 4. Who receives data

Data may be received by:

- Discord, as the platform carrying commands, messages, interactions, and responses;
- `HOSTING PROVIDER` and verified infrastructure vendors needed to operate and secure the Bot;
- guild members, configured ticket support staff, owners, or administrators who can see the relevant Discord channel, response, panel destination, ticket channel, leaderboard, log channel, or authorized guild export;
- personnel authorized by the operator under least-privilege access controls; and
- authorities or other parties when disclosure is lawfully required, necessary to protect rights and safety, or part of a properly disclosed business transfer.

The operator does not sell personal data. Vendor identities, processing locations, contracts, and transfer safeguards remain publication blockers until completed.

## 5. Retention

Current application behavior is not yet a public retention commitment:

- Active schema rows, including closed tickets and their lifecycle events, remain until an authorized guild-owner purge, replacement by an owner-authorized same-guild import, or operator deletion. Removing the Bot marks a guild inactive but does not currently delete its rows automatically. `/ticket disable` only stops new tickets and preserves ticket configuration, channels, and records.
- A guild-owner purge removes that guild's active metadata, settings, metrics, ticket configuration, posted-panel records, tickets, and ticket events from the live database. It does not securely erase SQLite free pages or delete Discord messages, panel messages, ticket channels, closure logs, direct messages, host logs, downloaded exports, or backups.
- A guild-owner format-3 import transaction replaces that guild's live settings, metrics, ticket configuration, posted-panel records, tickets, and ticket events with the validated same-guild file. A legacy format-2 import replaces settings and metrics while preserving current panel and ticket operational rows. Every import disables the guild for review, and imported ticket configuration remains disabled until explicitly reviewed and reconfigured. Import does not delete prior downloaded exports, operator backups, Discord-hosted content, or other external copies.
- Host logs and backups do not have an enforced repository-level expiry. The operator must set, document, test, and monitor fixed schedules before publication.
- A schema-v4 backup can contain panel content, ticket subjects/descriptions, closure reasons, Discord identifiers, and lifecycle events. A migration backup can contain other information no longer present in the active schema. Both require appropriate access, retention, and verified deletion controls.
- Downloaded guild exports include the active panel and ticket model and are controlled by the administrator or Discord client that receives them.

When required by Discord or law, API data must be deleted promptly after an applicable user request, when no longer needed, or when the hosted Bot stops operating, unless retention is legally required. The operator must implement verified deletion across live data, logs, backups, and vendors before publication.

## 6. Choices and requests

Guild administrators can disable individual features, stop new tickets, disable the guild, or export active guild data. Only the guild owner can use the exact-confirmation `/setup import` replacement or `/setup purge` flow. Members can ask guild staff to address Discord-hosted ticket channels, closure logs, panel messages, or direct messages and can contact **PRIVACY/SUPPORT EMAIL** to request access, correction, deletion, restriction, objection, portability, or other rights available under applicable law.

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
