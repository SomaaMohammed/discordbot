# Superior privacy policy

**Effective date:** NOT YET EFFECTIVE<br>
**Last updated:** August 23, 2026

> **Unpublished draft. Do not link this document from the Discord Developer Portal or represent it as an effective policy.** Replace every placeholder, verify the actual hosted deployment, complete the safeguards listed below, and obtain appropriate legal and Discord-policy review first.

Before publication, the operator must document and verify:

- `OPERATOR LEGAL NAME`, a monitored `PRIVACY/SUPPORT EMAIL`, and the countries in which the service is offered;
- hosting provider, processing locations, vendors, access controls, encryption, incident response, and international-transfer arrangements;
- fixed retention and deletion periods for application logs, inactive guild data, moderation cases/notes, reports, appeals, anti-spam enforcement records, rules/acceptances, member lifecycle/audit records, role-operation history, backups, and incident records;
- prompt deletion after confirmed guild removal, individual access/deletion handling, and any required opt-out or re-collection controls;
- whether optional per-member activity metrics, history backfill, leaderboards, guild exports, DM-panel delivery, support-ticket transcripts, public attributable suggestions/votes, private staff applications/reports/appeals, moderation case history, anti-spam enforcement, restricted role notifications, lifecycle messages/logs, rules acknowledgement, automatic roles, and self-service role menus comply with Discord's current developer requirements and applicable law; and
- clear in-product disclosures for features that send content to another member, create a staff-visible private channel, publish an attributed suggestion, collect application/report/appeal text, deliver lifecycle/account-age information to an administrator-visible channel, or record a member's acknowledgement of guild rules.

## 1. Operator and scope

Superior (the “Bot”) is operated by **OPERATOR LEGAL NAME** (“we,” “us,” or “our”). Contact **PRIVACY/SUPPORT EMAIL** for privacy, deletion, security, or support requests.

This draft describes the official hosted Bot. An independent operator of the source code controls a separate deployment and must publish an accurate policy for that deployment.

Discord separately processes account, server, message, and interaction data under [Discord's Privacy Policy](https://discord.com/privacy). This policy covers only processing controlled by the Bot operator.

## 2. Data the Bot processes

Depending on enabled features, the Bot processes:

- **Guild metadata:** guild ID, guild name, enabled state, and join/leave timestamps.
- **Guild settings:** explicit bot-state switch, log-channel ID, IANA timezone, invocation keyword and aliases, finite moderation limit, and greeting profile names/messages.
- **Command and interaction data:** guild, channel, user, member, role, message, and interaction identifiers and the options needed to validate and complete a request.
- **Delegated access records:** capability, delegated role ID, owner/Administrator grantor ID, active state, and timestamps. The active product grants roles only, although storage reserves a principal-type field for possible future user grants.
- **Panel records:** panel type or preset, guild/channel/message identifiers, stable opaque panel and component identifiers, workflow/resource bindings, timestamps, role/recipient bindings where applicable, and bounded administrator-supplied resource-panel title, body, and HTTPS links when that preset is used.
- **Ticket configuration and records:** department name/description/emoji; category, log-channel, and support-role IDs; enabled state; configurable question definitions; ticket number and opaque ID; opener/channel/control-message IDs; normalized subject, description, and other form answers; lifecycle state; claimant/closer IDs; closure reason and log-message checkpoint; timestamps; bounded failure/recovery details; and ordered lifecycle events.
- **Suggestions:** public suggestion channel, optional review-channel and thread IDs, reviewer-role ID, rate/self-vote settings, author ID, title, proposal details, state/delivery identifiers, reviewer ID and reason, timestamps, one signed vote value per voter ID, bounded recovery details, and audit events. Authors are not anonymous; public output shows the author and aggregate totals but not individual voter identities.
- **Staff applications:** form name/description, reviewer-role and private review-channel IDs, configurable question definitions, applicant ID, normalized answers, application/delivery/state identifiers, claimant/decision-maker IDs, decision reason, timestamps, bounded recovery details, and audit events. Answers are intended only for the configured private review channel and authorized applicant/reviewer flows.
- **Restricted Role Pings:** configured role and channel IDs, enabled and thread-policy state, per-member and per-role cooldown settings, configuration actor IDs, successful requesting-member/channel/role IDs, timestamps, command source/result, and bounded configuration/use audit history. The feature sends only the selected role notification and accepts no member-authored message body.
- **Moderation configuration and cases:** enabled state; verified moderation-log, private report, and private appeal channel/role bindings; configuration actors/timestamps; stable case ID and guild-local number; target and actor IDs; action, source, public reason, optional private moderator note, status, related case, Discord outcome metadata, void/overturn data, bounded delivery checkpoints, and up to 100 audit events per case.
- **Member reports:** reporter and reported-member IDs, category, 10-2,000-character explanation, optional validated same-guild message-link identifiers, guild-local number, private review-message binding, claimant/decision actor and reason, optional resulting case link, timestamps, state, cooldown evidence, recovery metadata, and up to 100 audit events. The raw evidence link and referenced message content are not stored. Reports are not anonymous to authorized reviewers, but the reported member is not automatically notified.
- **Appeals:** appellant ID, referenced case, 10-2,000-character explanation, guild-local number, private review-message binding, claimant/decision actor and reason, reversal outcome/related case, timestamps, state, recovery metadata, and up to 100 audit events. One appeal is accepted per eligible case. The in-guild flow is unavailable to a banned member who cannot invoke guild slash commands.
- **Anti-spam:** default-disabled burst, duplicate, and mention rule configuration; thresholds/windows/actions/timeout/cooldown settings; configured role/channel exemptions; configuration actors/timestamps; message/member/rule IDs; safe counts/outcomes/error classes; persistent enforcement reservations/cooldowns; and bounded events. Duplicate comparison uses a normalized SHA-256 fingerprint only in bounded process memory. Raw message text and the fingerprint are not persisted.
- **Onboarding configuration and authored text:** enabled/delivery states; welcome, farewell, rules, and private lifecycle-log channel IDs; bounded welcome/farewell titles and bodies; immutable rules title/body/version and whether re-acknowledgement was requested; verified/unverified role IDs; separate human/bot automatic-role IDs; optional account-age alert threshold; binding-verification timestamps; and configuration actor/timestamps. Templates support only the documented non-executable placeholders and are not written to terminal logs.
- **Member onboarding and rules acknowledgement:** member ID and human/bot kind; native Membership Screening state; join, account-creation, screening-completion, departure, processing, and acknowledgement timestamps; immutable accepted rules version; current configured onboarding roles held when status is requested; safe delivery/message identifiers; per-role success/failure and recovery state; and bounded lifecycle/audit metadata. The private log can disclose joins/leaves, bot status, verification/recovery, automatic-role failure, and an account younger than the configured threshold to its Discord-visible audience. Account age is informational only and is not proof of abuse.
- **Persistent role menus:** stable menu/option/post/operation IDs; guild-local slug; bounded title/description/labels; optional Unicode emoji; selection mode and minimum/maximum; required and option role IDs; enabled/archive, definition, post, binding-verification, and per-role operation states; channel/message IDs; actor/member IDs; failure class; and timestamps. A prerequisite records a role ID, not why the member has it.
- **Message, reaction, and member events:** content and metadata needed in memory to run configured anti-spam on new messages, recognize a deliberately addressed request, perform authorized moderation or cleanup, send a panel submission, create or close a support ticket, update activity metrics, or process a bounded member join/leave/screening transition. Phase 3 does not apply anti-spam to message edits. Onboarding does not retain raw gateway payloads, ordinary member messages, or direct-message contents.
- **Metrics:** guild-scoped command counters and member-ID-scoped counts for messages, reactions, and game results. Optional activity backfill reads eligible Discord history to reconstruct selected counts.
- **Operational records:** startup, shutdown, command failure, migration, security, and diagnostic information written by the host. Exact log fields and retention must be verified before publication.

Schema v10 uses normalized guild-scoped tables covering the existing product plus onboarding configuration/templates, immutable rules/acceptances, member lifecycle state, automatic roles, safe delivery/role outcomes, role menus/options/posts, and bounded audit/operation history. Tenant-owned rows cascade when the guild record is purged. Ordinary Discord conversation and ticket-channel history are not copied into SQLite. Referenced report-message content is not copied, anti-spam never persists raw message content, and report/appeal evidence attachments are not accepted. Onboarding deliberately does not store member-message or direct-message contents, full Discord member profiles, IP addresses, email addresses, phone numbers, invite history, or raw gateway payloads.

Terminal logs exclude rules text, welcome/farewell templates, direct-message contents, member-submitted content, tokens, environment values, database contents, full exports, and private workflow text. Bounded safe metadata may include a correlation ID, guild/member ID, menu or rules-version ID, delivery type, role-operation counts, state transition, classified Discord failure, and recovery action.

When authorized staff close a ticket, the Bot reads up to 1,000 recent messages from that channel and builds a chronological UTF-8 plain-text transcript entirely in memory. The transcript is capped at 7.5 MiB, includes the department and stored intake answers, author/timestamp/message identifiers, message text, and bounded attachment URLs, and explicitly marks truncation. The Bot must send the closure record and transcript to the department's configured log channel before finalizing closure, then attempts to send the same material to the opener by direct message. The transcript buffer is not written to the Bot's local database or filesystem by this workflow. Discord-hosted logs and successful DMs follow those destinations' visibility/retention; SQLite retains the log-message ID and delivery time as a restart-safe checkpoint.

A DM-panel submission remains a separate feature: it is delivered through Discord only to the selected recipient and is not copied to the configured guild log channel. Its aggregate success metric contains none of the submitted content, sender, or recipient details.

Do not submit passwords, tokens, payment data, government identifiers, health information, or other sensitive information to tickets, suggestions, application forms, reports, appeals, panels, or any Bot interaction. A private review channel reduces audience; it does not make the content appropriate for sensitive data.

## 3. Why data is used

Data is used to:

- provide requested commands, conversational replies, greetings, utilities, panels, support tickets, public suggestions/voting, private staff applications, confidential reports/appeals, persistent moderation cases, configurable anti-spam, restricted role notifications, welcome/farewell delivery, private member lifecycle logging, rules acknowledgement, safe automatic roles, self-service role menus, and moderation actions;
- enforce guild configuration, delegated/workflow permissions, private-content boundaries, native Membership Screening deferral, role membership, channel authorization, role hierarchy and dangerous-role exclusions, menu selection bounds, active-record/rate limits, input bounds, persisted cooldowns/idempotency, conditional reviews, and tenant isolation;
- maintain activity statistics and leaderboards, including optional administrator-requested history backfill;
- diagnose failures, prevent abuse, secure the service, and meet legal or Discord obligations; and
- respond to support, privacy, and security requests.

The operator must identify and document the lawful basis for each processing purpose in every applicable jurisdiction before publication. The Bot must not be used for advertising profiles, sale of personal data, or automated decisions with legal or similarly significant effects.

## 4. Who receives data

Data may be received by:

- Discord, as the platform carrying commands, messages, interactions, and responses;
- `HOSTING PROVIDER` and verified infrastructure vendors needed to operate and secure the Bot;
- guild members who can see an attributed public suggestion, panel, welcome/farewell message, moderation-log entry, or authorized restricted-role notification; configured private lifecycle-log viewers who can see bounded join/leave, verification/recovery, automatic-role-failure, and account-age-alert metadata; configured department support staff who can see a private ticket/transcript; configured application, report, or appeal reviewers who can see their separately authorized private content; owners, Administrators, or narrowly delegated staff who can see their authorized onboarding/member status, case/log/review channel, workflow content, or guild export; and applicants/authors/appellants or newly joined members receiving a best-effort status/welcome DM;
- personnel authorized by the operator under least-privilege access controls; and
- authorities or other parties when disclosure is lawfully required, necessary to protect rights and safety, or part of a properly disclosed business transfer.

The operator does not sell personal data. Vendor identities, processing locations, contracts, and transfer safeguards remain publication blockers until completed.

## 5. Retention

Current application behavior is not yet a public retention commitment:

- Active schema rows—including closed tickets, decided suggestions/applications, cases and private notes, withdrawn/decided reports and appeals, anti-spam enforcement metadata, restricted-ping audit, immutable rules/acceptances, member lifecycle state, delivery/recovery outcomes, and role-menu operations—remain until an authorized guild-owner purge, replacement under applicable import semantics, bounded repository cleanup, or operator deletion. Ticket, suggestion, application, case, report, and appeal records retain their latest 100 events per parent. Rules are limited to 25 versions per guild; automatic roles to 10 human and 10 bot roles; role menus to 25 per guild, 25 options per menu, and 100 retained posts per menu within a 500-post guild ceiling. Schema/import safety ceilings per guild are 100,000 member states, 100,000 acceptances, 100,000 onboarding deliveries, 200,000 onboarding role operations, 10,000 onboarding audit events, 100,000 menu operations, and 2,500,000 menu operation items. These are hard safety ceilings, not recommended retention periods. The operator must choose materially shorter age/row schedules appropriate to the deployment before publication.
- Discord removal marks the tenant inactive and retains rows for restart-safe compatibility and a possible rejoin. Disabling onboarding, verification, automatic roles, a role menu, moderation submissions, report/appeal services, anti-spam rules, or another workflow stops new work without erasing applicable history or removing Discord roles already assigned.
- A guild-owner purge removes that guild's live core, Phase 3, and Phase 4 rows through database cascades. It does not securely erase SQLite free pages, reverse a Discord sanction or role assignment, or delete Discord messages, verification/role-menu panels, lifecycle/moderation logs, private review messages, ticket channels/transcripts/logs, suggestion threads, prior role notifications, direct messages, host logs, downloaded exports, or backups.
- Revoking a delegated capability stops Superior from authorizing that role's actions, but Discord-hosted visibility is reconciled separately. Existing ticket channels retain a prior bot-managed `tickets.manage` overwrite until each ticket is recovered; application review-channel ACLs remain administrator-managed and must be removed separately. Discord-hosted copies remain subject to the effective channel permissions until that work is completed.
- A guild-owner format-8 import transaction replaces the complete portable tenant model while preserving non-portable internal delivery-deduplication rows. Legacy formats 2-7 retain their documented compatibility behavior. Every import leaves the core bot active while inserted grants and external bindings remain inactive or unverified. Anti-spam and automatic roles remain disabled; verification and role menus require current-resource validation and explicit enablement; imported acceptance history is readable but never assigns a role; and imported sanctions are not replayed. Import performs no Discord role mutation and does not delete prior downloaded exports, operator backups, Discord-hosted content, or other external copies.
- Host logs and backups do not have an enforced repository-level expiry. The operator must set, document, test, and monitor fixed schedules before publication.
- A schema-v10 backup can contain every existing private field plus case reasons/notes, reporter/appellant identities and explanations, decision reasons, message-link IDs, anti-spam metadata, rules/templates, acceptance and lifecycle timestamps, account-age metadata, role outcomes, bounded delivery identifiers, and audit events. Migration backups can contain older data absent from the active schema. Every generation requires appropriate access, retention, encryption, and verified deletion controls.
- Downloaded format-8 guild exports include portable configuration and operational records within collection limits, including private application/report/appeal content, case notes, voter IDs, rules/templates, member acceptance/lifecycle records, role-menu operations, and audit actors; non-portable internal delivery-deduplication rows, member/DM message contents, and raw gateway payloads are excluded. Exports are controlled by the authorized administrator or Discord client that receives them and must not be posted publicly.

When required by Discord or law, API data must be deleted promptly after an applicable user request, when no longer needed, or when the hosted Bot stops operating, unless retention is legally required. The operator must implement verified deletion across live data, logs, backups, and vendors before publication.

## 6. Choices and requests

Guild administrators can use the explicit bot-state switch, disable configured workflows, onboarding delivery/verification/automatic roles, role menus, report/appeal intake, new moderation actions, anti-spam rules, or restricted-ping roles, and export active guild data. Only the guild owner can use the exact-confirmation `/data import` replacement or `/data purge` flow. Members can receive a concise private result for their own rules acknowledgement; administrative `/onboarding member` lookup is bounded and excludes unrelated private workflows. Suggestion authors and applicants retain their existing view/withdraw choices. A reporter or appellant can privately view and withdraw their own eligible record. These state changes do not erase audit rows, remove an assigned role, reverse a sanction, or delete Discord-hosted copies.

Members can ask guild staff to address Discord-hosted ticket channels/transcripts/logs, attributed suggestions/threads, moderation or lifecycle logs, private application/report/appeal review messages, welcome/farewell messages, verification/role-menu panels, role assignments, or direct messages and can contact **PRIVACY/SUPPORT EMAIL** to request access, correction, deletion, restriction, objection, portability, or other rights available under applicable law.

Include the relevant Discord user ID and guild ID, but never send a password or bot token. We may verify control of the account and request only the context necessary to locate data. Deleting Bot data does not delete a copy hosted by Discord; use Discord controls or contact the relevant guild administrators for that copy.

The current implementation does not yet provide a tested end-to-end individual export, deletion, and re-collection opt-out workflow. It must not be described as doing so.

## 7. Security and incidents

The code provides guild scoping, separated capabilities, lifecycle/generation invalidation, fresh permission/resource checks, native-screening deferral, dangerous-role and hierarchy restrictions, mention suppression, private review/log-destination checks, bounded inputs/queries, conditional database transitions, idempotent acceptance/role/delivery reservations, explicit offline migration, integrity checks, private backup guidance, and secret exclusions. The supported deployment is one bot process per local SQLite database; sharing the live file between processes is not a security or availability boundary. Anti-spam is deliberately narrow and default-disabled; message edits are outside Phase 3 enforcement. Rules acknowledgement is not external identity verification or legal consent, and account age is not proof of abuse. The deployment must separately verify encryption, host hardening, patching, credential rotation, least-privilege access, monitoring, recovery, and vendor controls. No system is guaranteed completely secure.

Report a suspected incident privately to **PRIVACY/SUPPORT EMAIL**. The operator must begin containment and investigation promptly and notify Discord, affected people, regulators, or others when required.

## 8. Children

The Bot is not directed to anyone below the minimum age to use Discord in their country. If a parent or guardian believes prohibited child data was processed, contact **PRIVACY/SUPPORT EMAIL** so the operator can verify and respond as required.

## 9. Changes

An effective policy must be hosted at a stable public URL. Material changes require an updated date and any notice or consent required by law. This draft has no effect until the publication prerequisites are completed and an effective date is added.

## 10. Contact

**Operator:** OPERATOR LEGAL NAME<br>
**Privacy, deletion, security, and support:** PRIVACY/SUPPORT EMAIL

Do not place private Discord data or vulnerability details in a public issue.
