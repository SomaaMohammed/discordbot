# Configuration

Superior uses one Discord application, one bot process, and one shared SQLite database. Guild configuration is isolated by guild ID and starts immediately usable with safe defaults.

## Discord application

In the Discord Developer Portal:

1. Create or select the application and bot user.
2. Reset and securely store the bot token. Put it only in `.env`; never commit or paste it into logs.
3. Enable the privileged **Server Members Intent** and **Message Content Intent**. The runtime also uses Guilds, Guild Messages, and Guild Message Reactions.
4. Install the application with the `bot` and `applications.commands` scopes.
5. Grant only the permissions required by the features the guild enables.

Core replies and panels normally need View Channels, Send Messages, Embed Links, and Read Message History. Features add these requirements:

| Feature                     | Additional bot permissions and channel requirements                                                                                                                                                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Message cleanup             | Manage Messages in the target channel                                                                                                                                                                                                                                               |
| Channel locks and slow mode | Manage Channels                                                                                                                                                                                                                                                                     |
| Member sanctions            | Moderate Members for timeouts, Kick Members for kicks, Ban Members for bans/unbans, and a safe role hierarchy                                                                                                                                                                       |
| Moderation records          | The log channel needs View Channel, Send Messages, Embed Links, Attach Files, and Read Message History                                                                                                                                                                              |
| Reports and appeals         | Each review destination must be a standard private text channel where `@everyone` cannot View Channel; Superior and the corresponding reviewer role need View Channel, Send Messages, and Read Message History, and Superior also needs Embed Links and Attach Files                |
| Anti-spam                   | Manage Messages in every enforced channel; delete-and-timeout additionally needs Moderate Members and a safe role hierarchy                                                                                                                                                         |
| Role panels                 | Manage Roles and a bot role above every managed role                                                                                                                                                                                                                                |
| Restricted role pings       | View Channel and Mention Everyone in every configured destination, plus Send Messages for a direct channel or Send Messages in Threads for an authorized thread/post                                                                                                                |
| Ticket departments          | Manage Channels and Manage Roles; each category must allow View Channel, Send Messages, Read Message History, Embed Links, Attach Files, Manage Channels, and Manage Roles; each closure-log channel also needs Attach Files                                                        |
| Suggestions                 | The public channel needs View Channel, Send Messages, Read Message History, and Embed Links; discussion mode additionally needs Create Public Threads and Send Messages in Threads in a standard text channel; an optional review channel needs the core message permissions        |
| Staff applications          | The private review channel must be a standard text channel where `@everyone` cannot View Channel; Superior needs View Channel, Send Messages, Read Message History, and Embed Links, while the configured reviewer role needs View Channel, Send Messages, and Read Message History |

`Mention Everyone` is needed when an administrator explicitly chooses that announcement option or when Superior sends an approved mention of a normally non-mentionable restricted-ping role. Ordinary members do not need Mention Everyone. Keep Superior's highest role above roles it must manage or members it must moderate; restricted pings do not manage roles and therefore do not require a hierarchy relationship. A reviewer role must have effective access to its own private report or appeal destination. Superior verifies effective channel permissions, current resources, and role hierarchy whenever the operation needs it.

## Process environment

Copy `.env.example` to `.env` in the application root. For a Windows portable build, that is the folder containing `SuperiorBot.exe`.

| Variable                    | Required      | Meaning                                                                                     |
| --------------------------- | ------------- | ------------------------------------------------------------------------------------------- |
| `DISCORD_TOKEN`             | Yes           | Bot token from the Developer Portal.                                                        |
| `DB_FILE`                   | No            | SQLite path. A relative value resolves from the application root; default is `superior.db`. |
| `COMMAND_REGISTRATION_MODE` | No            | `global` for production or `guild` for development. Defaults to `global`.                   |
| `DEV_GUILD_IDS`             | In guild mode | Comma-separated development guild IDs.                                                      |

`SuperiorBot.exe --check` validates portable configuration and native SQLite without Discord login. Source check commands are documented in [Development](development.md).

## Command registration and runtime authorization

Use global registration for production. Discord can take time to propagate global command changes. Use guild registration only for controlled development because updates appear faster. Never put a production guild ID into source code.

Discord cannot vary slash-command visibility by a guild's delegated grants. `/panel`, `/ticket`, `/suggestion`, `/application`, `/moderation`, and `/automod` therefore expose relevant command choices and enforce the exact permission at runtime. A visible command is not evidence that the member may use it. `/access` and `/restrictedping` are Administrator-restricted in Discord and also perform a fresh owner-or-Administrator check at runtime. Report and appeal review controls repeat authorization at use time even when a member can see the private channel.

## Immediate defaults and optional configuration

After Superior joins or rejoins a guild, all core command families, greetings, deliberately addressed chat, reply moderation, activity metrics, and existing persistent interaction routes work immediately. No setup, validation, or enable sequence is required. The initial settings use UTC, a finite moderation limit, neutral invocation terms, and a neutral `Welcome` greeting profile.

Owners and Administrators can inspect or tune those defaults when needed:

- `/config status` reports the current effective settings.
- `/config bot-state enabled:<true|false>` is the explicit emergency switch for the whole guild.
- `/config log set|clear`, `/config timezone`, `/config limits`, `/config trigger`, and `/config greeting` change their respective settings without disabling unrelated behavior.
- `/data export`, owner-only `/data import`, and owner-confirmed `/data purge` manage tenant data.

Configure only the external-resource workflows the guild needs:

- Create ticket departments with `/ticket department create`, add up to five fields with `/ticket field add`, enable each healthy department, and post `/ticket panel`.
- Configure suggestions with `/suggestion configure`, then post `/suggestion panel`.
- Create application forms with `/application form create`, add 1–5 questions with `/application field add`, enable each healthy form, then post `/application panel`.
- Register each restricted role and destination with `/restrictedping add`, review it with `/restrictedping info`, and leave the Discord role's **Allow anyone to @mention this role** setting off.
- Configure moderation logging and the private report/appeal destinations with `/moderation configure`, verify `/moderation status`, then post the `safety` panel if wanted.
- Configure individual `/automod rule` entries and exemptions, inspect them with `/automod status`, and enable a rule only after `/automod test` and a permission review.
- If routine management should be delegated, use `/access grant` only after the relevant roles exist and have been reviewed.

`/config bot-state enabled:false` stops guild behavior without deleting data. Removing Superior from a guild marks that tenant inactive and retains its rows and persistent-panel bindings so a later rejoin works without reposting. `/data purge` is owner-only and permanently removes only that guild's live rows after exact confirmation; neither departure nor purge deletes Discord-hosted messages, logs, exports, or backups.

## Delegated access

Only the guild owner or a freshly re-fetched member with Administrator permission can run `/access grant`, `/access revoke`, `/access list`, or `/access status`. Grants target roles. Superior rejects `@everyone`, managed/integration roles, deleted roles, roles from another guild, and duplicate active grants. Delegates cannot use `/access`.

The eleven capabilities are intentionally separate:

| Capability               | Allows                                                                                         | Does not imply                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `panels.manage`          | List, post, refresh, and inspect fixed panels                                                  | Ticket, suggestion, or application configuration      |
| `tickets.configure`      | Configure departments and fields, enable/disable them, post launchers, and inspect health      | Reading or managing private ticket contents           |
| `tickets.manage`         | Recover tickets and manage private ticket controls                                             | Editing departments or delegated access               |
| `suggestions.configure`  | Configure/disable suggestions, post launchers, and recover public delivery                     | Reviewing suggestion content                          |
| `suggestions.review`     | List and transition suggestions                                                                | Changing service configuration                        |
| `applications.configure` | Configure forms/questions and post launchers                                                   | Reading or deciding private applications              |
| `applications.review`    | Review, claim, decide, and recover applications                                                | Changing form configuration                           |
| `moderation.configure`   | Configure moderation logging, report/appeal bindings, anti-spam, exemptions, and safety panels | Managing sanctions or reading private reports/appeals |
| `moderation.manage`      | Warn, note, timeout/untimeout, kick, ban/unban, inspect, amend, void, and recover cases        | Changing configuration or delegated access            |
| `reports.review`         | Inspect, claim/release, resolve, dismiss, and recover confidential reports                     | Configuring destinations or reviewing appeals         |
| `appeals.review`         | Inspect, claim/release, uphold, overturn, and recover confidential appeals                     | Configuring destinations or reviewing reports         |

Owner and Administrator access is evaluated before delegated storage, so they retain recovery authority even if a grant or delegated role is stale. Every delegated action re-fetches the member and matching role. Removing or managing a granted role makes its authorization unusable. Revoke grants before deleting their roles when practical; `/access list` identifies a role that has already disappeared.

A configure-only delegate cannot create or change a ticket support role, suggestion reviewer role, application reviewer role, report reviewer role, or appeal reviewer role to a role they currently hold unless they also have the matching content-review authority. An unchanged existing workflow role does not prevent unrelated metadata edits. The guild owner and a freshly verified Administrator remain the authorities for intentional overlap.

Discord channel visibility is a separate boundary from Superior's action authorization:

- At most 25 active `tickets.manage` roles can be represented in a private ticket channel. New and recovered tickets receive freshly verified manager-role overwrites. After a grant, recover each existing active ticket that the role should access. A revoke blocks controls immediately, then each active ticket must be recovered to remove the prior bot-managed role overwrite. Recovery reads Superior's ACL marker, removes stale bot-managed support/manager overwrites, and preserves unrelated manual overwrites.
- Before `applications.review` is granted, the target role must already have View Channel, Send Messages, and Read Message History in every locally binding-verified form destination, including disabled forms whose history and recovery controls remain available. Enabling a form repeats that check for every active review delegate. Superior does not edit application review-channel ACLs. After revocation, remove the role's Discord channel access separately when it is no longer appropriate.

## Restricted role pings

Restricted Role Pings let a member ask Superior to mention one role they currently hold, but only in channels that the guild owner or an Administrator explicitly mapped for that role. The role stays non-mentionable in Discord, and members are not granted Mention Everyone or permission to mention unrelated roles.

Only the guild owner or a freshly verified Administrator can configure the feature:

- `/restrictedping add role:<role> channel:<channel>` adds one unique role/channel mapping and starts a new role with safe defaults.
- `/restrictedping remove role:<role> channel:<channel>` removes that mapping. Removing the last channel removes the role configuration.
- `/restrictedping cleanup-role role_id:<id>` removes configuration left behind when a role was deleted while Superior was offline.
- `/restrictedping cleanup-channel channel_id:<id>` removes every stale mapping for a channel ID and any role configuration left with no channels. Copy IDs only from the stale entries shown by `list`; these are audited destructive cleanup operations.
- `/restrictedping list page:<number>` shows a bounded page of configured roles and destinations.
- `/restrictedping info role:<role>` shows status, allowed channels, both cooldowns, and thread behavior.
- `/restrictedping enable role:<role>` and `/restrictedping disable role:<role>` control execution without changing the mappings.
- `/restrictedping configure role:<role> user_cooldown_seconds:<1-86400> role_cooldown_seconds:<0-86400> allow_threads:<true|false>` changes anti-spam and thread policy. A role cooldown of `0` disables only the role-wide cooldown.

The defaults are one successful ping every 60 seconds per member and role, and one successful ping every 30 seconds for the role across the guild. There is no owner or Administrator cooldown bypass. A denial or Discord delivery failure before message creation does not consume a successful-ping cooldown. If Discord creates the message but its returned mention metadata cannot be verified, Superior deletes it where possible and retains a durable safety lease because an already-issued notification cannot be retracted. Successful timestamps and audit events are persisted, so a restart does not reset the anti-spam boundary.

At configuration time, Superior rejects `@everyone`, every managed role (including bot, integration, and booster roles), an already mentionable role, and roles carrying Administrator, Manage Server, Manage Roles, Manage Channels, Kick Members, Ban Members, Moderate Members, Manage Messages, Mention Everyone, or Manage Webhooks. Role hierarchy is not a mention requirement and is not used as a configuration gate because Superior never assigns, edits, reorders, or temporarily makes the role mentionable.

Mappings may target standard text channels, announcement channels, forum channels, or media channels. Threads are off by default. When `allow_threads` is enabled, a command in a thread or forum/media post is authorized only when that thread's exact parent channel is mapped for the selected role. A mapped forum or media parent is therefore usable only from one of its child posts with thread support enabled. An unrelated thread, a post under another parent, or a direct child-channel ID that was never mapped does not inherit access.

Members invoke `/pingrole role:<role>`. Before sending, Superior freshly verifies all of the following:

- the interaction is from a human member in the same active guild;
- the selected role and effective channel are still configured and enabled;
- the role, channel, and optional thread parent still exist in that guild;
- the member still has the role and can View Channel, Use Application Commands, and send in the current direct channel or thread;
- Superior can View Channel, use the matching Send Messages permission, and use Mention Everyone there; and
- neither persisted cooldown is active.

On success, Superior sends only the canonical Discord role token and uses an explicit allowed-mentions role allowlist containing exactly the authorized role ID, with automatic parsing otherwise disabled. There is no member-supplied message text, so `@everyone`, `@here`, user mentions, and additional roles cannot be injected. Configuration changes and successful pings are auditable with guild, channel, role, actor, source, result, and timestamp data. Deleted roles/channels are cleaned when Discord events are observed and are still treated as stale at execution time if an event was missed while Superior was offline. Use the ID-based cleanup commands for stale entries shown by `/restrictedping list` that could not receive a deletion event.

For example, these names are illustrative configuration rather than hard-coded behavior:

```text
/restrictedping add role:@Food channel:#food
/restrictedping add role:@Pics channel:#pics
/restrictedping add role:@Media channel:#media
```

A member who currently has `@Food` can run `/pingrole role:@Food` in `#food`; Superior sends the real `@Food` notification. The same implementation handles `@Pics`, `@Media`, multiple allowed channels for one role, and future roles without new code.

## Moderation cases and private safety workflows

`/moderation configure` stores the moderation-log channel, private report and appeal destinations, reviewer roles, service state, binding-verification times, and update actors. `/moderation status` reports bounded health without exposing private content. `/moderation disable` stops new actions without erasing history. Changing a destination or reviewer role invalidates that binding until current guild ownership, private-channel visibility, reviewer access, and Superior's permissions are verified again.

`/moderation warn`, `note`, `timeout`, `untimeout`, `kick`, `ban`, and `unban` create normalized guild-local case history. Destructive member actions require a 1-500-character public reason; a private moderator note is limited to 1,000 characters. History and case views return at most 10 rows per page, suppress mentions, and keep private notes inside authorized staff output. Legacy `/superior timeout`, `/superior untimeout`, and bounded multi-member timeout operations now fail closed while Phase 3 moderation cases are disabled, ensuring every successful legacy sanction can be recorded durably. When cases are enabled, successful targets create the same per-target cases; failed or skipped targets never receive successful cases. Legacy purge, channel lock/unlock, and slowmode actions remain available independently because they do not create member cases.

Cases record a stable opaque ID, guild-local number, target, actor, action, source, public reason, optional private note, relevant Discord outcome metadata, status, related case, timestamps, and up to 100 audit events. States distinguish `active`, `completed`, `voided`, `overturned`, and `failed`; supported actions include `warning`, `note`, `timeout`, `timeout-removed`, `kick`, `ban`, `unban`, `automod-warning`, and `automod-timeout`. `/moderation amend` appends the previous value to audit history. `/moderation void` changes the record only; it never silently reverses Discord state, and Superior refuses to void an active timeout, anti-spam timeout, or ban until the sanction is removed through a separately authorized action. Removing a timeout or ban creates its corresponding case and completes the original record before that original can be voided.

Moderation-log embeds contain only the case number, action, safe target/actor display and IDs, public reason, timestamp, and outcome. They never contain private notes, report or appeal content, raw messages, or stack traces. A log-delivery failure after Discord confirms a sanction leaves the successful case intact and a durable checkpoint for bounded, idempotent recovery.

Members use `/report submit member:<user>` and a private modal with category `harassment`, `spam`, `scam`, `safety`, or `other`, a 10-2,000-character explanation, and an optional same-guild Discord message link of at most 200 characters. Superior rejects self-reports, malformed or cross-guild evidence links, inappropriate bot targets, and submissions beyond the configured persistent cooldown. The default is three reports in a rolling 30-minute window; configuration accepts 1–10 reports and a 60–86,400-second window. Superior stores only the validated guild/channel/message IDs, never the raw link, referenced message content, or an attachment. `/report status` and `/report withdraw` reveal only the reporter's own eligible records.

Reports move through `submitted`, `under-review`, `resolved`, `dismissed`, and `withdrawn`. The reporter's identity and report body are visible only to the configured reviewer role, owner, Administrators, and `reports.review` delegates inside the private destination. Superior never notifies the reported member automatically. Claim, Release, Resolve, Dismiss, and Info controls are conditional and idempotent; only the current authorized claimant can release or decide a record. A different reviewer may take over only after Superior proves the prior claimant is absent or no longer authorized; an unavailable member lookup fails closed. A decision requires a bounded staff reason and does not imply punishment unless it links to a real moderation case. `/report recover` may refresh or recreate a missing private review record only after revalidating the content boundary.

Members use `/appeal submit case_number:<number>` with a 10-2,000-character explanation, then `/appeal status` or `/appeal withdraw` for their own records. Eligible records are manual warning, kick, or ban cases, plus an active manual timeout whose live Discord expiry still exactly matches the case; notes, removal/unban records, anti-spam cases, failed/voided/overturned cases, and completed timeouts are ineligible. The appellant must be the target of the same-guild case, and only one appeal is accepted per case. Private moderator notes are never shown. Appeals move through `submitted`, `under-review`, `upheld`, `overturned`, and `withdrawn`; authorized review uses conditional Claim, Release, Uphold, Overturn, and Info controls with a 1-500-character decision reason. Only the current authorized claimant can release or decide an appeal, and takeover uses the same proof-of-absence-or-lost-authority rule as reports. `/appeal recover` revalidates the case and private boundary before it refreshes or recreates a review record.

An upheld appeal preserves the case. An overturned warning marks that case overturned. An active timeout is removed only after fresh permission and hierarchy verification, then receives a `timeout-removed` case. A kick has no continuing Discord state to reverse. A ban is marked overturned only after a separately authorized unban succeeds or is verified to have already occurred. Discord rejection is never represented as reversal. Because banned members cannot invoke guild slash commands, Phase 3's appeal flow is available only while the member can still access the guild; there is no DM command or external-form fallback.

## Configurable anti-spam

Anti-spam is narrow, opt-in, and disabled by default after fresh initialization, migration, and import. `/automod rule configure|enable|disable` manages these rule types:

- **Burst:** 2-100 messages in a configurable 1-300-second rolling window.
- **Duplicate:** 2-100 repetitions in a configurable 1-300-second rolling window. Only an in-memory normalized SHA-256 fingerprint is compared; neither the text nor fingerprint is persisted.
- **Mention:** a 2-100 combined user/role mention threshold on one message.

Each rule stores its enabled state, threshold, applicable window, action, optional timeout duration up to Discord's 28-day maximum, 1-86,400-second enforcement cooldown, and creation/update actors and timestamps. Actions are delete, delete-and-warn, or delete-and-timeout. `/automod exempt-role add|remove` and `/automod exempt-channel add|remove` maintain up to 250 same-guild entries of each kind; stale, managed, `@everyone`, and cross-guild roles are rejected. `/automod test` evaluates optional synthetic text up to 1,000 characters and message, repetition, and mention counts from 0–1,000 without deleting a message, reserving an enforcement, or moderating a member.

Runtime enforcement ignores bots, webhooks, the owner, and Administrators and freshly checks every role/channel exemption. It verifies deletion permission before deleting, re-fetches the target and bot member before a timeout, and respects current hierarchy and moderatability. A failed or ambiguous deletion never becomes a warning or timeout. Durable guild/rule/message/member reservations and persisted cooldowns prevent duplicate gateway delivery from producing duplicate actions; interrupted reservations are recovered in a bounded way. Successful warnings and confirmed timeouts create real cases.

Detection windows are bounded in memory and cleared on guild disable, purge/removal, and shutdown. A restart may reset those windows but does not reset persisted enforcement cooldowns or idempotency records. Raw message content is never persisted for anti-spam, successful deletion prevents ordinary chat/activity processing for that message, and Phase 3 does not enforce message edits. Anti-spam does not implement word lists, AI classification, sentiment, link reputation, attachment scanning, scam judgments, shadow actions, or cross-server reputation.

## Fixed panels

Superior has seven fixed gold presets:

- `help`: active member services and management command families;
- `server-info`: a bounded guild snapshot;
- `resources`: administrator-supplied title/body plus up to five unique HTTPS links;
- `tickets`: the current department launcher;
- `suggestions`: the suggestion submission launcher; and
- `applications`: the private staff-application launcher; and
- `safety`: private report and eligible in-guild appeal launchers with a concise privacy explanation.

`/panel post` targets a text or announcement channel and records the exact bot-authored message so `replace_existing` can refresh it safely. `/panel status` privately lists a bounded set of tracked panels and current feature health. Operational presets are refused when their stored configuration is disabled, missing, belongs to another guild, or fails current resource/permission checks. The safety panel enables only controls whose report/appeal service is currently verified and never displays a case or private record publicly. Member-controlled text cannot select arbitrary styling and all payloads suppress automatic mentions.

## Ticket departments and forms

Each department has a stable internal ID, unique lowercase slug, display name, description, optional Unicode emoji, ticket category, closure-log channel, support role, enabled state, sort order, timestamps, and a versioned field definition. At most 10 departments may exist, matching the bounded launcher design.

Use `/ticket department list|create|edit|enable|disable|delete|health` for department lifecycle and routing. Creation starts disabled. A department's category, log channel, or support role cannot change while it has an active ticket; after active work is closed, changing routing disables the department for review. Metadata-only edits retain its state. Enable only after Superior verifies the current category, log channel, support role, permissions, guild ownership, and role hierarchy. Deletion is refused once a department has ticket history; disable it instead. The compatibility `/ticket disable` command disables every enabled department in the guild, while preserving verified routing for staff handling of existing tickets.

Use `/ticket field add|edit|remove|move` to maintain 1–5 ordered fields. A field is short text or paragraph and stores a 45-character label, optional 100-character guidance/placeholder, required flag, and bounded minimum/maximum response lengths. Superior validates the definition when it is stored and again before rendering the Discord modal. A department with no custom definition uses the safe Subject/Details form.

Launcher behavior is deterministic:

- One enabled department uses a direct **Open Ticket** button.
- Two or more enabled departments use a select menu ordered by department configuration.
- A selection is checked against the persisted department and current guild. Deleted, disabled, malformed, cross-guild, or obsolete selections fail privately with refresh/recovery guidance.

Submitted answers are normalized and stored with the ticket. The private introduction and ephemeral **Info** workflow render mention-safe previews that are fairly truncated when necessary to stay within Discord's aggregate embed limit, and each includes one bounded UTF-8 text attachment with every complete stored answer. Both message payloads suppress mention parsing. The complete bounded answers also remain in SQLite and the closure transcript. Superior transactionally enforces one `creating`, `open`, or `closing` ticket per member per department and at most three active tickets per member across the guild.

The ticket channel is private to the opener, that department's support role, up to 25 freshly verified active `tickets.manage` roles, and the bot under Discord's effective permissions. The support role, owner, Administrator, and those delegates may inspect, claim, release, and close it. A `tickets.configure` delegate cannot access the contents merely because of that grant.

Closing requires a bounded reason. Superior assembles a chronological plain-text transcript in memory, including the department and intake answers, then sends the closure record and attachment to that department's log channel and attempts the same delivery to the opener by DM. The transcript is capped at 1,000 messages and 7.5 MiB of UTF-8 data. A logging, persistence, or Discord failure preserves a recoverable state rather than claiming completion.

`/ticket recover ticket_number:<number>` reconciles interrupted creation/closure, missing controls, a lingering channel for a closed ticket, and current support/manager ACLs. Run it once for every active ticket after granting or revoking `tickets.manage`; action authorization changes immediately, while existing Discord visibility changes on recovery. A channel-less creation or unlogged closing state must remain unchanged for five minutes before recovery treats it as interrupted. Existing schema-v4 controls and launcher records remain associated with the migrated `General Support` department; refresh a stale launcher when Discord no longer has its tracked message.

## Suggestions

`/suggestion configure` selects a public suggestion channel, reviewer role, optional staff review channel, optional public discussion threads, a persisted cooldown, and whether authors may self-vote. The default is three submissions per 600 seconds; configuration accepts 1–10 submissions and a 60–3,600-second window. Self-voting is disabled by default.

Members use `/suggestion submit` or the `suggestions` panel, complete a private modal, and receive a server-local number. Superior reserves the record before posting its public themed embed. Upvote/downvote buttons store one vote per member; clicking the same vote removes it and clicking the opposite vote switches it transactionally. Totals are public, voter identities are not, and voting is refused for ineligible state, stale/cross-guild controls, or a self-vote when disabled.

Authors use `/suggestion status` for one or a bounded recent list and `/suggestion withdraw` while the proposal is `open` or `under-review`. Reviewers use `/suggestion list` and `/suggestion review`, or the review controls, with a bounded reason: `open` may become `under-review`, `accepted`, or `declined`; `under-review` may become `accepted` or `declined`; and `accepted` may become `implemented`. `withdrawn` is author-driven. Closed-state voting is disabled, the public embed is refreshed, an audit event is stored, and Superior attempts to DM the author.

`/suggestion disable` stops new submissions without deleting records or votes. Previously verified bindings remain available for review and recovery of existing suggestions; an imported configuration with no verification marker remains dormant until explicit configuration. `/suggestion recover` reconciles a missing public message and optional thread. Repeated delivery/state actions are backed by persisted identity and conditional transitions rather than an in-memory correctness assumption.

## Private staff applications

An application form has a stable internal ID, unique lowercase slug, display name, description, reviewer role, private standard-text review channel, enabled state, sort order, timestamps, and 1–5 configurable questions. Up to 25 forms are stored per guild. Use `/application form list|create|edit|enable|disable|delete` and `/application field add|edit|remove|move`; creation starts disabled, and changing the reviewer role or review channel disables a form until current resource health is verified. Once a form has application history, that private routing is immutable: archive or disable it and create a replacement form instead. Deletion is refused if applications reference the form.

Members use `/application submit form:<slug>` or the `applications` panel. Superior validates and normalizes all answers, reserves a private record, enforces one `submitted` or `under-review` application per member per form, and posts the answers only to that form's private review channel. The review embed uses bounded previews; authorized reviewers can use **Info** for a private UTF-8 attachment containing every complete stored answer. Applicant-controlled content suppresses mentions and is never placed in the public launcher or a public response.

Only the applicant can use `/application status` for their records or `/application withdraw` while a decision is pending. The configured reviewer role, owner, Administrator, and `applications.review` delegates with effective access to the private destination may claim, accept, reject, inspect, and recover the private review record. Grant and form-enable preflights enforce View Channel, Send Messages, and Read Message History without changing the channel's ACL. Accept/reject requires a bounded reason and is concurrency-safe and idempotent. States are `submitted`, `under-review`, `accepted`, `rejected`, and `withdrawn`; Superior attempts to DM status changes to the applicant.

`/application recover` reconciles a missing private review message after freshly verifying the reviewer and private destination. Disabling a locally verified form stops new applications but preserves its history, review controls, and recovery path; an imported form remains dormant until its bindings are explicitly revalidated. Phase 2 does not support anonymous applicants, attachments, more than five questions, or public application answers.

## Export, import, purge, and recovery review

`/data export` lets the owner or an Administrator download a bounded same-guild format-7 snapshot. It contains the existing portable model plus moderation configuration/cases/events, reports/events, appeals/events, anti-spam rules/exemptions/safe enforcement metadata, and legitimately portable delivery checkpoints.

`/data import` is owner-only, requires exact same-guild confirmation, validates collection limits and references, and runs in one transaction:

- Format 7 replaces settings, metrics, and the complete portable operational model while preserving non-portable internal delivery deduplication.
- Legacy format 6 replaces its complete schema-v8-era model and leaves Phase 3 configuration and records empty/default-disabled.
- Legacy format 5 replaces its schema-v7 portable model, converts settings to the current safe defaults, preserves the operational collections represented by that format, and leaves Phase 3 empty/default-disabled.
- Legacy format 4 replaces its complete schema-v5 model and leaves restricted-ping and Phase 3 collections empty/default-disabled.
- Legacy format 3 replaces settings, metrics, panels, and the Phase 1 ticket model, converting it to a `General Support` department with Subject/Details responses. Phase 2 collections absent from the file are cleared, and Phase 3 is empty/default-disabled.
- Legacy format 2 replaces settings and metrics while preserving all current operational rows.

Every import leaves the core guild bot active. Imported delegated grants are inactive; external ticket, application, suggestion, restricted-ping, moderation-log, report, appeal, and resource bindings remain dormant or unverified until the corresponding configuration or recovery path checks current Discord resources and permissions. Imported anti-spam rules remain disabled and imported sanctions are never replayed. Imported historical records remain readable to authorized staff. Keep a protected pre-import export or operator backup when rollback may be necessary.

Import and purge affect only the live SQLite database. They do not delete downloaded exports, backups, SQLite free pages, Discord panels, ticket/application/suggestion/report/appeal messages, ticket channels, moderation logs, transcripts, review logs, discussion threads, prior sanctions, or direct messages.

## Command reference

- `/config`: status, explicit bot-state switch, log-channel set/clear, timezone, limits, trigger, and greeting management.
- `/data`: export, owner-only import, and owner-confirmed guild-data purge.
- `/access`: grant, revoke, list, and status for delegated role capabilities.
- `/pingrole role:<role>`: request one authorized restricted role ping in the current channel or allowed child thread/post.
- `/restrictedping`: add/remove/list/info/enable/disable restricted role mappings, clean stale role/channel IDs, and configure cooldown/thread policy; owner-or-Administrator only.
- `/panel`: list, post, and status for all seven fixed presets.
- `/ticket`: status, panel, disable, recover; department list/create/edit/enable/disable/delete/health; field add/edit/remove/move.
- `/suggestion`: submit, status, withdraw, configure, panel, list, review, disable, and recover.
- `/application`: submit, status, withdraw, panel, recover; form list/create/edit/enable/disable/delete; field add/edit/remove/move.
- `/moderation`: configure/status/disable/recover; warn, note, timeout, untimeout, kick, ban, unban, history, case, amend, and void.
- `/report`: submit, status, withdraw, and reviewer-authorized recover; review decisions use the private record controls.
- `/appeal`: submit, status, withdraw, and reviewer-authorized recover; review decisions use the private record controls.
- `/automod`: status, rule configure/enable/disable, exempt-role add/remove, exempt-channel add/remove, and non-mutating test.
- `/superior`: `say`, `dmpanel`, `rolepanel`, `rolepanelmulti`, `purge`, `purgeuser`, `lock`, `unlock`, `slowmode`, `timeout`, `untimeout`, `mutemany`, `unmutemany`, `muteall`, `unmuteall`, `backfillstats`, `backfillstatus`, and `help`.
- `/utility`: `ping`, `avatar`, `userinfo`, `serverinfo`, `roleinfo`, `channelinfo`, `snowflake`, and `timestamp`.
- `/fun`: `battle`, `stats`, and `leaderboard`.
- `/greetings send`: send one configured profile as the current member.

The `roleinfo`, `channelinfo`, `snowflake`, and `timestamp` utilities validate bounded input, remain guild-scoped where relevant, and reply privately. See [Member capabilities](reference/member-capabilities.md) for the authorization matrix.

## Lifecycle and isolation

Events and interactions are rejected when the guild is missing, disabled, inactive, removed, purged, or has changed generation during asynchronous work. Guild resources are revalidated against the interaction guild. Discord API work stays outside long SQLite transactions, list operations are bounded or paginated, and successful metrics are written only after the corresponding reply succeeds.

Only one Superior process may write a database. Running several processes against a shared SQLite file is unsupported even on a network filesystem. Future multi-process deployment requires a different coordination/storage design; no configuration flag enables it in this release.
