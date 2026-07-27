# Superior Privacy Policy

**Effective date:** July 27, 2026<br>
**Last updated:** July 28, 2026

> **Unpublished draft — do not use this URL in the Discord Developer Portal.**
> The current implementation and this draft are not suitable for public
> deployment or publication until every prerequisite below is implemented,
> verified in production, and reflected accurately in the final policy.

Before publication, the Operator must:

- replace `OPERATOR LEGAL NAME` and `PRIVACY/SUPPORT EMAIL` with a real
  controller identity and monitored private contact address;
- identify the actual hosting, storage, backup, and monitoring providers,
  processing locations, and written service-provider restrictions;
- encrypt Discord API data at rest, including credentials, the live database,
  SQLite sidecars, host logs, and backups, using a verified production control;
- adopt and enforce concrete host-log and backup retention, restoration, and
  erasure periods;
- adopt justified automatic expiration for retained legacy answer mappings, cooldowns, and
  per-user metrics, with cleanup that does not stop merely because a feature is
  disabled;
- implement and test prompt guild-removal, service-termination, and verified
  individual-deletion workflows, including prevention of unwanted
  re-collection;
- resolve the Discord-policy risks created by passive per-user activity
  tracking, public user leaderboards, and history backfills that scan messages,
  reactions, and archived threads; and
- restrict or redact administrator exports and other disclosures so Discord API
  data is shared only with a contracted service provider, as legally required,
  or when the applicable user expressly directs the disclosure.

## 1. Who This Policy Covers

This Privacy Policy explains how **OPERATOR LEGAL NAME** (the "Operator," "we,"
"us," or "our") processes information through the official hosted deployment
of Superior (the "Bot"). You can contact the Operator at
**PRIVACY/SUPPORT EMAIL**.

The Bot is an independently operated Discord application. Discord is a
separate service with its own [Privacy Policy](https://discord.com/privacy) and
[Terms of Service](https://discord.com/terms).

If a person or organization lawfully operates an independent deployment of the
source code, that operator controls its deployment and must provide its own
accurate privacy notice, contact method, retention schedule, and legally
required disclosures. This policy does not automatically cover an independent
deployment or grant rights to use the source code.

## 2. Summary

- The Bot processes Discord events, messages, members, roles, interactions, and
  reactions needed for enabled features.
- The Bot stores guild configuration, Discord identifiers, greeting profiles,
  and usage metrics in a guild-scoped SQLite database. It processes moderation
  and panel inputs to carry out requested Discord actions and, when configured,
  sends relevant content to a guild log channel. Migrated or previously created
  court, question, answer, cooldown, schedule, and royal records may also remain
  in SQLite for compatibility and rollback.
- The retired "anonymous answer" feature was pseudonymous, not untraceable.
  Retained mappings can associate an author's Discord user ID with an answer
  message ID and can appear in an administrator export until deleted under the
  applicable retention, verified-request, or guild-purge process.
- The Bot does not sell API data, use it for advertising or data brokering, or
  use message content to train artificial-intelligence models.
- Removing the Bot from a server does not automatically delete retained data.
  The server owner can purge current live guild data with `/setup purge`, and
  individuals can submit a privacy request to the Operator.

## 3. Information We Process

The exact data depends on which features a server administrator enables and
which commands members use.

| Category                              | Examples                                                                                                                                                                           | Why it is processed                                                                                                                                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Guild and installation data           | Guild ID and name; enabled state; Bot join, leave, and record timestamps                                                                                                           | Route data to the correct guild, isolate tenants, manage setup, and restore a rejoined guild safely                                                                           |
| Discord identifiers and configuration | User, guild, channel, role, message, and thread IDs; timezone; supported and legacy feature flags; invocation keyword and aliases; greeting profiles                               | Deliver configured features, enforce permissions, target Discord resources, keep tenants isolated, and preserve compatible guild settings                                     |
| Member and account context            | User ID; role membership; permissions and role hierarchy; Discord account and server-join timestamps when returned by Discord                                                      | Authorize commands, resolve utilities, apply moderation, attribute activity metrics, and enforce Discord hierarchy                                                            |
| Content and command input             | Greeting text, announcements, panel text, DM-panel submissions, moderation reasons, utility targets, and choice input                                                              | Perform the action requested by a member or administrator and maintain the resulting supported state                                                                          |
| Message and reaction activity         | Message content, authors, replies, mentions, timestamps, reactions, reactor IDs, and accessible message/thread history                                                             | Run neutral conversational triggers, reply moderation, activity metrics, and administrator-requested backfills                                                                |
| Retained legacy feature data          | Court questions and posts; answer-to-user/message mappings; cooldowns; schedules; royal/AFK state; old labels, channels, roles, and metrics                                        | Preserve migrated or previously created data for compatibility, rollback, private export, retention cleanup, and owner-authorized purge; these are not active public features |
| Usage and operational data            | Per-user message, reaction, and game counts; command counts; backfill initiator/status; legacy anonymous-answer/post metrics; silence-lease recovery state; error and service logs | Provide statistics and leaderboards, recover prior permission changes, troubleshoot, secure, and improve reliability                                                          |
| Exports, migrations, and backups      | Portable guild exports, internal legacy-migration data, SQLite database copies, and operational backups                                                                            | Let authorized administrators inspect guild data and support compatibility migration, rollback, and disaster recovery                                                         |

The Bot receives this information from Discord's API, from members and server
administrators, and from actions the Bot performs. It does not use cookies or
independent web tracking. The application code does not intentionally collect
IP addresses, email addresses, phone numbers, payment details, or precise
physical location.

The Bot is not designed or authorized to process protected health information,
financial or payment-account information, government identifiers,
authentication credentials, or other sensitive information regulated by law.
Do not submit such information. If the Operator receives unauthorized Discord
API data in error, the Operator must notify Discord and delete the data as
required by Discord's Developer Terms.

### Transient API data and caches

Discord API payloads and Discord.js objects—including members, messages,
reactions, channels, and roles—may be held temporarily in process memory until
eviction or restart. These transient caches are not the SQLite database.
Ordinary message bodies are not intentionally persisted to SQLite solely
because the Bot observed them, although limited identifiers and error details
may enter operational logs.

### Message access and history scans

In an enabled guild, the Bot counts messages from non-bot members and may inspect
message content for enabled neutral triggers and reply-moderation phrases.
Reaction events are used to update
per-user reaction counts. Ordinary message bodies are not saved to the local
SQLite database merely because the Bot observes them, but content deliberately
submitted to a supported stored feature—such as a greeting, announcement,
panel, DM forwarding, or moderation reason—can be retained or copied to a
configured guild log as described below.

An administrator can start an activity backfill. A backfill may fetch accessible
text and announcement channels and active or archived threads, including
private threads the Bot is permitted to access. It can scan all available
history if the administrator does not set a lookback limit. The Bot retains
per-user counts and scan status, not a separate local copy of every scanned
message body.

### Retained legacy answers are pseudonymous, not untraceable

Superior no longer offers new anonymous court-answer submissions. A migrated or
previously created record can still map a member's user ID to a question message,
answer message, and submission time. The local database did not store the
answer body, but the mapping was never anonymous to the Bot, its Operator, or a
guild owner or Administrator who can use `/setup export`. A separate cooldown
timestamp or per-user legacy anonymous-answer count may also remain. Discord
controls retention of the already-posted message independently. Public-feature
retirement did not delete or anonymize these retained records.

### Guild logs and administrator exports

When a guild configures a log channel, people who can view that channel may see
actor and target identities, IDs, moderation reasons, announcement text,
DM-panel content, panel changes, and operational details. Older logs or backups
may also contain events produced by retired features.
A DM-panel submission is sent to the named recipient and its sender identity,
source channel, and complete message are also copied to the configured log
channel, when one is available.

Guild owners and authorized administrators can request an ephemeral, portable
export containing that guild's current settings and activity data plus retained
legacy state, questions, posts, answer mappings, metrics, and cooldowns. The
export deliberately excludes the Bot's
internal live silence-lease recovery record. Anyone who downloads an export is
responsible for protecting and deleting their copy.

## 4. How We Use Information

We process information to:

- provide, configure, and route Bot commands and automated features;
- provide utilities, greetings, neutral conversational replies, announcements,
  panels, activity statistics, and leaderboards;
- enforce permissions, moderation, and anti-abuse controls;
- provide member statistics, leaderboards, and administrator analytics;
- keep each guild's data isolated and recover temporary channel-permission
  changes;
- respond to support, privacy, safety, and security requests;
- diagnose failures, preserve service integrity, and maintain backups; and
- comply with Discord's requirements and applicable law.

Where applicable law requires a legal basis, the basis will depend on the
processing and jurisdiction. It may include providing functionality requested
by users or server administrators, the Operator's legitimate interests in
running and securing the Bot, consent where required, and compliance with legal
obligations. You may contact the Operator for details about a particular use.

The Bot's rule-based eligibility and moderation features can automatically
allow, reject, time out, or otherwise act on Discord interactions according to
server configuration. They are not intended to make legal or similarly
significant decisions. Server administrators control the applicable settings
and can review or disable the features.

## 5. When Information Is Disclosed

Information may be disclosed to:

- **Discord:** All Bot events, interactions, messages, embeds, DMs,
  attachments, and moderation or role actions pass through Discord.
- **People selected by the user or guild:** Under the current implementation,
  content and statistics are visible according to target channel, thread, DM,
  and role permissions, and configured log-channel viewers can see the audit
  information described above. Public deployment is blocked until every such
  API-data disclosure has a valid basis under Discord's Developer Terms.
- **The Operator and authorized administrators:** People with a legitimate need
  may access the live database, service logs, backups, or guild exports to run,
  secure, support, or administer the Bot.
- **Infrastructure providers:** Hosting, storage, backup, monitoring, or similar
  providers may process information only after the Operator identifies them and
  binds them in writing to act at the Operator's direction, comply with
  Discord's terms, protect API data, and delete it when required.
- **Authorities, Discord, or affected users:** API data may be disclosed when
  required by applicable law or Discord's terms. Incident information may be
  provided to Discord and affected users as required by Discord's Developer
  Terms or law.

Before public deployment, Discord API data must be disclosed only to a
contracted service provider acting at the Operator's direction, as required by
law or Discord's terms, or when the applicable user expressly directs the
disclosure.

We do not sell, license, or otherwise commercialize Discord API data, disclose
it to advertisers or data brokers, or use it to build advertising profiles. We
do not use message content to train machine-learning or artificial-intelligence
models.

Discord and infrastructure providers may process information in countries
other than the user's country. Any required transfer safeguards depend on the
Operator's location, providers, and applicable law. Contact the Operator for
deployment-specific details.

## 6. Retention and Deletion

| Data                                                                          | Normal retention                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legacy answer user/message mapping                                            | Existing records retain their stored guild retention setting (90 days by default, historically configurable from 1 to 36,500 days). Cleanup can be delayed while the Bot is offline. Public retirement does not itself erase them. |
| Legacy answer text on Discord                                                 | Controlled separately by Discord and server moderation. Local metadata cleanup does not delete the Discord message.                                                                                                                |
| Legacy cooldowns and per-user or aggregate metrics                            | Retained until guild purge or an applicable verified deletion request; answer-link cleanup does not erase these records. The implementation must adopt justified automatic expiration before public deployment.                    |
| Guild settings, legacy questions/state/post records, and Discord resource IDs | Retained while needed for supported operation or compatibility and otherwise until the server owner purges the guild or the Operator deletes them. No general automatic expiration currently applies.                              |
| Transient API payloads and library caches                                     | Held in process memory until eviction or restart; they are not intentionally persisted as complete payload archives.                                                                                                               |
| Backfill initiator and status                                                 | Held only in process memory until replaced by later status, explicitly forgotten during lifecycle handling, or the Bot process restarts.                                                                                           |
| Data after the Bot leaves a guild                                             | The current implementation marks the guild inactive and retains its data for a possible rejoin. This behavior must be replaced with a prompt, verified deletion process before public deployment.                                  |
| Host logs                                                                     | The application writes structured logs to the host but does not enforce log rotation itself. **Operator: replace this sentence with the production log-retention period before publication.**                                      |
| Backups                                                                       | The software can create restricted backup files but does not automatically expire them. **Operator: add and enforce a production backup-retention and erasure schedule before publication.**                                       |
| Downloaded exports                                                            | Retained by the administrator or Discord client that receives them; the Operator cannot automatically delete independently downloaded copies.                                                                                      |

The server-owner-only `/setup purge` flow removes that guild's records from the
active SQLite database for metadata, settings, state, questions, posts, answer
mappings, metrics, and cooldowns. It does **not** securely erase SQLite free
pages or delete Discord messages, DMs, Discord audit history, host logs,
previously downloaded exports, or historical backups. The Operator must
separately address those copies when required by a verified request, Discord's
instructions, or applicable law.

Before public deployment, the Operator must promptly delete API data when the
applicable user requests deletion, Discord requests it, the data is no longer
needed for approved functionality, or the official hosted Bot stops operating,
unless applicable law requires retention. The current implementation has no
tested end-to-end individual-erasure or re-collection opt-out workflow and must
not be represented as having one.

## 7. Your Choices and Rights

- A server administrator can disable individual features or the entire guild.
- A server owner or Administrator can export current guild data. Only the server
  owner can use `/setup purge`, with the exact confirmation required by the Bot.
- A member can ask guild staff to remove a specific Discord message or anonymous
  answer where appropriate.
- Any person can request access, correction, deletion, or a copy of personal
  data by emailing **PRIVACY/SUPPORT EMAIL**. Include the relevant Discord user
  ID and guild ID, but never send a bot token, password, or other credential.

We may need to verify that the requester controls the relevant Discord account
and may ask for additional context. Subject to applicable law, rights may also
include restriction, objection, portability, withdrawal of consent, and a
complaint to a data-protection authority. Discord API data must be deleted
promptly on the applicable user's request unless applicable law requires
retention. Other privacy rights may be limited only where applicable law
permits. The Operator must respond without undue delay and explain any lawful
limitation.

Deleting data from the Bot does not automatically delete the same content from
Discord. Use Discord's controls or contact the relevant server's administrators
for Discord-hosted messages and account data.

## 8. Security and Incidents

The codebase provides safeguards designed to reduce risk, including guild-scoped
data isolation, role and permission checks, guarded legacy migration, and operational
guidance for restrictive database and backup file permissions. Operational
secrets should be kept outside source control. The repository does not itself
demonstrate encryption at rest or deployment-specific access restrictions;
those controls must be implemented and verified before public deployment. No
storage or transmission method is completely secure, and this policy does not
promise absolute security or uninterrupted recovery.

Report a suspected security or privacy incident to **PRIVACY/SUPPORT EMAIL**.
For a potential unauthorized access to Discord API data, the Operator must
immediately begin remediation, promptly notify Discord and affected users as
required by Discord's Developer Terms or law, and provide Discord with requested
incident information.

## 9. Children

The Bot is not directed to children below the minimum age required to use
Discord in their country. Do not use the Bot if you are not old enough to use
Discord. A parent, guardian, or other person who believes a child provided data
contrary to these requirements should contact the Operator. If the report is
verified, the Operator must stop the processing and promptly delete the data as
required.

## 10. Changes to This Policy

We may update this policy when the Bot, its data practices, Discord's rules, or
applicable law changes. We will post the updated policy at the same public URL,
change the "Last updated" date, and provide any additional notice required by
law. Material changes apply prospectively unless a different treatment is
legally permitted and clearly stated.

## 11. Contact

**Operator:** OPERATOR LEGAL NAME<br>
**Privacy, deletion, security, and support email:** PRIVACY/SUPPORT EMAIL

Do not publish Discord IDs, private messages, or other personal information in
a public issue tracker.
