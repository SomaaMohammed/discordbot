# Superior terms of service

**Effective date:** NOT YET EFFECTIVE<br>
**Last updated:** July 30, 2026

> **Unpublished draft. Do not link this document from the Discord Developer Portal or present it as binding terms.** Replace the operator/contact placeholders, complete the [Privacy Policy](privacy-policy.md) publication prerequisites, verify the hosted service, and obtain appropriate legal review for the operator's jurisdictions.

## 1. Agreement and operator

These terms are between **OPERATOR LEGAL NAME** (“Operator,” “we,” “us,” or “our”) and each person who installs or intentionally uses the official hosted Superior bot (“Bot”). Contact **PRIVACY/SUPPORT EMAIL**.

Once these terms become effective, adding the Bot or intentionally using a command, button, modal, panel, or conversational feature means agreeing to them. A guild administrator confirms authority to install and configure the Bot. If you do not agree, do not install or intentionally use it.

An independent source-code deployment is a separate service whose operator must provide its own accurate terms and privacy notice.

## 2. Eligibility

You must meet Discord's minimum age requirement in your country and be legally able to agree. If you act for an organization or administer a guild, you confirm authority to do so.

## 3. Service

Superior provides configurable conversational replies, greetings, information utilities, announcements, fixed information/resource panels, private support tickets, optional activity statistics, message cleanup, channel controls, timeouts, role panels, and other bounded moderation tools. Guild owners and administrators select supported features, permissions, destinations, support roles, and limits.

The Bot is not an emergency service, professional adviser, or substitute for human moderation judgment. Features, limits, and availability may change.

## 4. Discord

The Bot depends on Discord's APIs and infrastructure. Discord is a separate service governed by its [Terms of Service](https://discord.com/terms), [Community Guidelines](https://discord.com/guidelines), and [Privacy Policy](https://discord.com/privacy). Discord does not sponsor or endorse the Bot and may change or withdraw APIs, intents, permissions, accounts, or access.

You must not use the Bot in a way that causes the Operator to violate Discord's rules.

## 5. Administrator responsibilities

An installer or administrator is responsible for:

- granting only the permissions needed for enabled features and maintaining safe role hierarchy and channel visibility;
- configuring feature flags, logging, invocation terms, timezone, moderation limits, panels, ticket category/log/support resources, and greetings appropriately;
- telling members how the Bot is used and making the effective privacy notice and terms available;
- supervising message cleanup, bulk actions, timeouts, panels, tickets, closure transcripts, announcements, exports, activity backfill, statistics, and leaderboards;
- protecting downloaded exports and administrator-visible logs; and
- reviewing Bot output and correcting or reversing actions when human judgment is needed.

Permission checks supplement, but do not replace, responsible administration.

## 6. Acceptable use

You must not:

- violate law, Discord's rules, another person's rights, or applicable guild rules;
- harass, threaten, exploit, discriminate, impersonate, dox, spam, or deceive;
- submit malware, credentials, authentication tokens, unlawful content, or sensitive personal information;
- use panels, tickets, transcripts, exports, statistics, backfill, or moderation tools for unauthorized surveillance, retaliation, profiling, or harm;
- bypass permissions, role hierarchy, lifecycle checks, input bounds, cooldowns, or other safeguards;
- disrupt, overload, scrape, probe, or gain unauthorized access to the Bot, host, data, or another guild's data;
- sell or broker Discord or Bot data; or
- infringe intellectual-property, privacy, publicity, or other rights.

Report security issues privately to **PRIVACY/SUPPORT EMAIL** rather than publishing exploit details or private data.

## 7. Content and feature disclosures

You retain rights you already have in submitted content. You grant the Operator a limited, non-exclusive, worldwide, royalty-free license to receive, process, format, transmit, display, and temporarily store that content only as needed to provide, secure, support, and maintain the Bot, follow authorized instructions, and meet legal or Discord obligations.

You confirm that you have permission to submit the content and select its destination. Depending on the feature, content may be visible to guild members, administrators, a selected recipient, or log-channel viewers according to Discord permissions and feature configuration.

A DM-panel submission is delivered through Discord only to the selected recipient. It is not copied to the configured guild log channel, and the aggregate success metric records none of the content, sender, or recipient. Do not use the panel unless you accept delivery to the selected recipient.

A support-ticket submission persists the opener's Discord ID, subject, description, ticket/channel identifiers, lifecycle state, and later claim/closure metadata in the guild-scoped database. The resulting private channel is intended for the opener, configured support role, guild owner, Administrators, and Bot, but actual visibility follows Discord permissions and administrator configuration. Do not submit credentials or sensitive personal information.

When authorized staff close a ticket, the Bot builds a bounded plain-text transcript in memory from up to 1,000 recent channel messages and no more than 7.5 MiB of UTF-8 data. The transcript can include message text, author/timestamp/message identifiers, and attachment URLs. It is delivered with the closure reason to the configured guild log channel, and the Bot attempts the same delivery to the opener by direct message. Only after the log delivery is checkpointed and closure is persisted does the Bot attempt to delete the ticket channel. A failed log or transcript step preserves the channel for retry or recovery. Discord-hosted logs and direct messages can remain after the local ticket channel or Bot database rows are deleted.

Optional member-activity metrics and backfill can produce member-specific statistics and leaderboards from Discord events and eligible history. Administrators must enable and operate those features only with an appropriate, disclosed basis.

## 8. Privacy and deletion

The effective [Privacy Policy](privacy-policy.md) will explain processing, disclosure, retention, and requests. Removing the Bot currently marks a guild inactive but does not automatically delete active rows. Disabling tickets stops new tickets but preserves existing channels and records. Only the guild owner can use `/setup import` to replace validated same-guild live data or `/setup purge` to remove the guild's live database rows. A format-3 import replaces settings, metrics, panel records, ticket configuration, tickets, and ticket events; a legacy format-2 import replaces settings and metrics while preserving current panel and ticket operational rows. Every import leaves the guild disabled for review, and a format-3 imported ticket configuration is also disabled. Neither import nor purge deletes Discord-hosted panel messages, ticket channels, closure logs, direct messages, host logs, backups, or downloaded exports.

This behavior is a publication blocker, not a promise of indefinite retention. Before public operation, the Operator must implement and document appropriate guild-removal, individual-request, log, backup, vendor, and shutdown deletion procedures.

## 9. Intellectual property

The Bot software, name, documentation, and other materials remain owned by their respective authors and licensors, subject to applicable open-source licenses. These terms govern the hosted service and do not grant branding rights or imply endorsement. Feedback may be used to improve the Bot without transferring ownership of pre-existing work.

## 10. Suspension and termination

Users may stop interacting at any time. A guild owner may disable features, disable the guild, remove the Bot, or use the confirmed purge flow.

The Operator may restrict, suspend, or end access to protect people or the service, investigate abuse, comply with law or Discord, enforce effective terms, or discontinue the Bot. Urgent safety, legal, platform, or technical action may occur without advance notice. If the hosted Bot permanently stops, the Operator must stop API access and delete API data as required.

## 11. Availability and changes

The Bot may be changed, interrupted, degraded, or discontinued. Discord changes, maintenance, bugs, host failures, and events outside the Operator's control can affect service. No promise is made that every feature or record will always remain available.

Effective terms must be hosted at a stable URL and updated with required notice. Continuing to intentionally use the Bot after an effective update constitutes acceptance only to the extent permitted by law.

## 12. Disclaimers and liability

To the maximum extent permitted by applicable law, the Bot is provided “as is” and “as available.” The Operator and contributors disclaim implied warranties, including merchantability, fitness for a particular purpose, non-infringement, and uninterrupted, secure, or error-free operation. Bot output can be incomplete, delayed, inaccurate, or inappropriate; users and administrators must review it.

To the maximum extent permitted by law, the Operator and contributors are not liable for indirect, incidental, special, consequential, exemplary, or punitive damages, or lost data, profit, goodwill, opportunity, or service access arising from the Bot. Nothing excludes a non-waivable consumer right, remedy, warranty, or liability.

## 13. General terms

Contact **PRIVACY/SUPPORT EMAIL** before starting a formal dispute and allow a reasonable opportunity to resolve it. Qualified counsel must add an appropriate governing-law and forum clause before publication without removing mandatory protections.

If one provision is unenforceable, it is limited only as necessary and the remainder continues. Delay is not a waiver. Users may not transfer obligations without consent; the Operator may transfer the service as part of a lawful transaction with required notice. Effective terms and the effective privacy policy form the agreement for the hosted Bot and cannot make Discord responsible for it.

## 14. Contact

**Operator:** OPERATOR LEGAL NAME<br>
**Privacy, deletion, security, abuse, and support:** PRIVACY/SUPPORT EMAIL

Never send a bot token, password, or another person's private information in a support request.
