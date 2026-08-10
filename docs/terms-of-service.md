# Superior terms of service

**Effective date:** NOT YET EFFECTIVE<br>
**Last updated:** August 10, 2026

> **Unpublished draft. Do not link this document from the Discord Developer Portal or present it as binding terms.** Replace the operator/contact placeholders, complete the [Privacy Policy](privacy-policy.md) publication prerequisites, verify the hosted service, and obtain appropriate legal review for the operator's jurisdictions.

## 1. Agreement and operator

These terms are between **OPERATOR LEGAL NAME** (“Operator,” “we,” “us,” or “our”) and each person who installs or intentionally uses the official hosted Superior bot (“Bot”). Contact **PRIVACY/SUPPORT EMAIL**.

Once these terms become effective, adding the Bot or intentionally using a command, button, modal, panel, or conversational feature means agreeing to them. A guild administrator confirms authority to install and configure the Bot. If you do not agree, do not install or intentionally use it.

An independent source-code deployment is a separate service whose operator must provide its own accurate terms and privacy notice.

## 2. Eligibility

You must meet Discord's minimum age requirement in your country and be legally able to agree. If you act for an organization or administer a guild, you confirm authority to do so.

## 3. Service

Superior provides configurable conversational replies, greetings, information utilities, announcements, fixed panels, multi-department private support tickets, attributable public suggestions/voting, private configurable staff applications, restricted role notifications, delegated role-based management, optional activity statistics, message cleanup, channel controls, timeouts, role panels, and other bounded moderation tools. Guild owners and administrators select supported features, permissions, destinations, workflow roles, delegated capabilities, and limits.

The Bot is not an emergency service, professional adviser, or substitute for human moderation judgment. Features, limits, and availability may change.

## 4. Discord

The Bot depends on Discord's APIs and infrastructure. Discord is a separate service governed by its [Terms of Service](https://discord.com/terms), [Community Guidelines](https://discord.com/guidelines), and [Privacy Policy](https://discord.com/privacy). Discord does not sponsor or endorse the Bot and may change or withdraw APIs, intents, permissions, accounts, or access.

You must not use the Bot in a way that causes the Operator to violate Discord's rules.

## 5. Administrator responsibilities

An installer or administrator is responsible for:

- granting only the permissions needed for enabled features and maintaining safe role hierarchy and channel visibility;
- configuring feature flags, logging, invocation terms, timezone, moderation limits, panels, ticket departments/forms/routing, suggestion channels/rates/review roles, private application forms/review channels, restricted-ping roles/channels/cooldowns/thread policy, and greetings appropriately;
- granting each delegated role only the narrow capability needed, reviewing stale roles, and understanding that configuration authority does not automatically include private-content review authority;
- telling members how the Bot is used and making the effective privacy notice and terms available;
- supervising message cleanup, bulk actions, timeouts, panels, tickets, closure transcripts, suggestions/voting/reviews, staff applications/decisions, restricted role notifications, announcements, exports, activity backfill, statistics, and leaderboards;
- keeping application review channels private, making public suggestion attribution clear, and protecting downloaded exports, backups, ticket logs, and staff review content; and
- reviewing Bot output and correcting or reversing actions when human judgment is needed.

Permission checks supplement, but do not replace, responsible administration.

## 6. Acceptable use

You must not:

- violate law, Discord's rules, another person's rights, or applicable guild rules;
- harass, threaten, exploit, discriminate, impersonate, dox, spam, or deceive;
- submit malware, credentials, authentication tokens, unlawful content, or sensitive personal information;
- use panels, tickets, transcripts, suggestions, voter records, staff applications, private answers, exports, statistics, backfill, or moderation tools for unauthorized surveillance, retaliation, profiling, or harm;
- publish private application answers or ticket content without authorization, falsely promise anonymity for suggestions/applications, or solicit credentials or other sensitive data through a form;
- bypass delegated/workflow permissions, role hierarchy, lifecycle checks, active-record limits, input bounds, persisted cooldowns, or other safeguards;
- bypass restricted-ping role membership, channel/parent-thread mappings, dangerous-role exclusions, cooldowns, or the exact single-role mention boundary, or use the feature to spam or harass;
- disrupt, overload, scrape, probe, or gain unauthorized access to the Bot, host, data, or another guild's data;
- sell or broker Discord or Bot data; or
- infringe intellectual-property, privacy, publicity, or other rights.

Report security issues privately to **PRIVACY/SUPPORT EMAIL** rather than publishing exploit details or private data.

## 7. Content and feature disclosures

You retain rights you already have in submitted content. You grant the Operator a limited, non-exclusive, worldwide, royalty-free license to receive, process, format, transmit, display, and temporarily store that content only as needed to provide, secure, support, and maintain the Bot, follow authorized instructions, and meet legal or Discord obligations.

You confirm that you have permission to submit the content and select its destination. Depending on the feature, content may be visible to guild members, administrators, a selected recipient, or log-channel viewers according to Discord permissions and feature configuration.

A DM-panel submission is delivered through Discord only to the selected recipient. It is not copied to the configured guild log channel, and the aggregate success metric records none of the content, sender, or recipient. Do not use the panel unless you accept delivery to the selected recipient.

A support-ticket submission persists the opener's Discord ID, selected department, normalized form answers, ticket/channel identifiers, lifecycle state, and later claim/closure metadata in the guild-scoped database. The resulting private channel is intended for the opener, that department's support role, guild owner, Administrators, authorized `tickets.manage` delegates, and Bot, but actual visibility follows Discord permissions and administrator configuration. Grant/revoke changes require recovery of existing ticket channels to reconcile their bot-managed role overwrites. A `tickets.configure` grant alone does not authorize private ticket content. Do not submit credentials or sensitive personal information.

When authorized staff close a ticket, the Bot builds a bounded plain-text transcript in memory from up to 1,000 recent channel messages and no more than 7.5 MiB of UTF-8 data. The transcript can include the department/form answers, message text, author/timestamp/message identifiers, and attachment URLs. It is delivered with the closure reason to the department's configured guild log channel, and the Bot attempts the same delivery to the opener by direct message. Only after the log delivery is checkpointed and closure is persisted does the Bot attempt to delete the ticket channel. A failed log or transcript step preserves the channel for retry or recovery. Discord-hosted logs and direct messages can remain after the local ticket channel or Bot database rows are deleted.

A suggestion submission is attributable, not anonymous. It persists the author's Discord ID, title/details, state and delivery identifiers, and audit history, then publishes the author and proposal in the configured guild channel. Per-member up/down votes are stored to enforce one current vote and calculate totals; public output shows totals but not voter identities. Staff review may publish a state and reason and trigger a best-effort direct message. Optional public discussion threads follow Discord's channel visibility. Do not submit content you are not authorized to publish.

A staff-application submission persists the applicant's Discord ID and normalized answers and sends them to the form's configured private review channel. The intended audience is that form's reviewer role, owner, Administrators, authorized `applications.review` delegates, and Bot, subject to actual Discord permissions and administrator configuration. Superior validates delegated channel access when granting review authority and enabling forms but does not modify operator-managed review-channel ACLs; administrators must remove obsolete Discord visibility after revocation. A configuration-only grant does not authorize submitted answers. Claim and decision state/reasons are persisted and may be sent to the applicant by direct message. “Private” describes the configured channel, not end-to-end encryption or a guarantee against authorized staff copying the content. Do not submit credentials, government identifiers, health information, payment data, or other sensitive information.

A restricted role ping is a real Discord notification sent by the Bot for one safe, normally non-mentionable role. The requesting member must currently hold that role and use `/pingrole` in its mapped channel or an exact allowed child thread/post. The Bot never makes the role globally mentionable and does not grant the requester Mention Everyone. The payload contains no member-authored text and allows only the authorized role mention. Configuration and successful use persist actor/member, guild, role, channel, cooldown, result/source, and timestamp data for security, anti-spam, and audit purposes. The default limits are 60 seconds per member/role and 30 seconds per role guild-wide, with no administrator bypass; administrators may change the configured values within product bounds.

Optional member-activity metrics and backfill can produce member-specific statistics and leaderboards from Discord events and eligible history. Administrators must enable and operate those features only with an appropriate, disclosed basis.

## 8. Privacy and deletion

The effective [Privacy Policy](privacy-policy.md) will explain processing, disclosure, retention, and requests. A confirmed removal of the Bot from a guild purges that guild's live SQLite rows; temporary or startup unavailability only marks it inactive. Disabling a department, suggestions, an application form, or a restricted-ping role stops new work and preserves applicable existing records.

Only the guild owner can use `/setup import` to replace validated same-guild live data or `/setup purge` to remove the guild's live database rows. Format 5 replaces the complete portable tenant product model while preserving internal delivery deduplication; legacy format 4 replaces its schema-v5 model without restricted-ping collections; legacy format 3 replaces its panel/ticket-era operational model and converts tickets to `General Support`; legacy format 2 replaces settings/metrics while preserving current operational rows. Every import disables the guild, and imported delegated/resource bindings remain inactive or unverified pending review. Neither import nor purge deletes Discord-hosted panels, ticket channels/transcripts/logs, suggestion messages/threads, application review messages, prior restricted-role notifications, direct messages, host logs, backups, exports, or SQLite free pages.

This behavior is a publication blocker, not a promise of indefinite retention. Before public operation, the Operator must implement and document appropriate guild-removal, individual-request, log, backup, vendor, and shutdown deletion procedures.

## 9. Intellectual property

The Bot software, name, documentation, and other materials remain owned by their respective authors and licensors, subject to applicable open-source licenses. These terms govern the hosted service and do not grant branding rights or imply endorsement. Feedback may be used to improve the Bot without transferring ownership of pre-existing work.

## 10. Suspension and termination

Users may stop interacting at any time. A guild owner may disable features, disable the guild, remove the Bot, or use the confirmed purge flow.

The Operator may restrict, suspend, or end access to protect people or the service, investigate abuse, comply with law or Discord, enforce effective terms, or discontinue the Bot. Urgent safety, legal, platform, or technical action may occur without advance notice. If the hosted Bot permanently stops, the Operator must stop API access and delete API data as required.

## 11. Availability and changes

The Bot may be changed, interrupted, degraded, or discontinued. Discord changes, maintenance, bugs, host failures, and events outside the Operator's control can affect service. The supported software deployment is one bot process with local SQLite and does not provide horizontal multi-process availability. No promise is made that every feature or record will always remain available.

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
