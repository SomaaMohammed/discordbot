# Member capabilities

All authority is guild-scoped. Superior ignores unsupported DMs and refuses work when the guild is explicitly disabled, inactive, purged, cross-guild, or invalidated during asynchronous work. A missing external binding blocks only its resource-bound workflow. Privileged interactions re-fetch the current member and relevant role/resource; slash-command visibility alone grants nothing.

## Guild members

All members of an active guild may:

- deliberately address the bot through the configured invocation, a bot mention, or a reply for natural chat, status, bounded dice, and bounded choices;
- use `/utility ping`, `avatar`, `userinfo`, `serverinfo`, `roleinfo`, `channelinfo`, `snowflake`, and `timestamp`;
- use `/fun battle`, `/fun stats`, and `/fun leaderboard`;
- use `/greetings send` with a configured profile;
- interact with a current role panel when the target role remains safe and manageable;
- acknowledge the current server-rules version through a verified panel after native Membership Screening completes, and privately inspect the resulting concise status;
- use a current persistent role menu when any prerequisite, selection bounds, role safety, bot hierarchy, and exact panel binding still pass;
- open a ticket in an enabled department, subject to one active ticket per department and three across the guild, and inspect the state of their own ticket;
- submit, view, withdraw, and vote on suggestions while the service/state/cooldown permits;
- submit an enabled staff-application form, privately view their own status, and withdraw their own still-pending application; and
- submit a confidential member report, privately view/withdraw their own eligible reports, and appeal one eligible case that targets them while they can still access the guild; and
- use `/pingrole` for a configured, enabled role they currently hold in its exact allowed channel or explicitly enabled child thread/post, subject to current permissions and both persisted cooldowns.

Utilities disclose only information available from the current guild or supplied public Discord ID. Requested members, roles, and channels must belong to the current guild. Inputs are bounded and validated before a response or metric write.

Ticket and application form answers are normalized and stored. Ticket answers appear only in the resulting private ticket and its closure outputs. Application answers appear only in the configured private staff review channel and authorized same-applicant status flow. Suggestion authors/title/details are public in the configured suggestion channel; vote totals are public but voter identities are not. Report identities/content and appeal explanations remain inside their separate authorized private review boundaries. Applicant/member-controlled text cannot create mentions.

Rules acknowledgement records the member, immutable rules version, and timestamp. It is not legal consent or external identity verification. Superior does not expose one member's onboarding history to other members. Welcome/farewell output contains only bounded lifecycle information, and an account-age alert is private, informational, and never an automatic punishment.

## Workflow roles

Configured workflow roles provide content authority only for the workflow that names them:

- A department support role may inspect, claim, release, close, and otherwise manage tickets belonging to that department.
- The suggestion reviewer role may list and transition suggestions with a reason.
- An application form's reviewer role may inspect private answers, claim the application, accept/reject with a reason, and recover its private review delivery.
- The report reviewer role may inspect reporter identity/content, claim or release, resolve/dismiss with a reason, and recover that report's private delivery.
- The appeal reviewer role may inspect the eligible appeal, claim or release, uphold/overturn with a reason, and recover that appeal's private delivery.

Membership and the configured role are fetched again before a control is accepted. `@everyone`, managed roles, missing roles, and roles belonging to another guild are invalid. A workflow role does not configure the service, grant delegated access, or authorize a different department/form.

## Restricted-ping role members

A restricted-ping role grants only the ability to request that same role's notification through `/pingrole`. Membership alone does not authorize another role, another channel, another guild, or an unrelated thread. Channel presence alone does not replace current role membership. The member must also retain View Channel, Use Application Commands, and the applicable direct-channel or thread send permission.

Superior sends the notification rather than making the role mentionable or giving the member Mention Everyone. The outgoing payload allows exactly the one authorized role mention and contains no member-controlled text. Per-user/per-role and guild-wide/per-role cooldowns begin only after successful Discord delivery; no owner, Administrator, or role member bypasses them. Missing/deleted resources, bots/webhooks, stale mappings, disabled roles, permission loss, and Discord failures fail privately without claiming success.

## Verification and role-menu members

A human member may acknowledge only the current same-guild rules version on their own behalf. While Discord marks the member pending under native Membership Screening, Superior defers human automatic roles and its verified role. After screening clears, verified-role addition must succeed before an optional unverified role is removed. Repeated or concurrent acknowledgement is idempotent; bots, obsolete panels, copied custom IDs, and cross-guild messages fail privately.

A role-menu member may change only roles represented by that exact menu. `toggle`, `exclusive`, and `limited` modes enforce their stored minimum/maximum selection policy, and a configured prerequisite must be held at the time of use. Superior never removes an unrelated role. A failed addition preserves prior menu roles; a partial removal is reported accurately and retained for recovery. Menu use grants no authority to edit the menu, manage onboarding, or manage another member.

## Delegated managers

The owner or an Administrator may grant one narrow capability to a safe guild role through `/access grant`. Grants are independent; holding one never implies another.

| Capability               | Delegated operations                                                                     | Explicit separation                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `panels.manage`          | List/post/replace/status for fixed Superior panels                                       | Does not configure the underlying ticket, suggestion, or application service |
| `tickets.configure`      | Configure departments/forms/routing, enable/disable, health, and launcher posting        | Does not grant access to private ticket channels or controls                 |
| `tickets.manage`         | Manage ticket controls and run ticket recovery                                           | Does not edit departments or grants                                          |
| `suggestions.configure`  | Setup/disable service, post launcher, recover public delivery                            | Does not review or decide proposals                                          |
| `suggestions.review`     | List/review suggestions and use review controls                                          | Does not change channel/rate settings                                        |
| `applications.configure` | Create/edit/enable/disable forms/questions and post launcher                             | Does not reveal submitted answers or allow decisions                         |
| `applications.review`    | Inspect/claim/decide/recover private applications                                        | Does not edit forms or grants                                                |
| `moderation.configure`   | Configure moderation/report/appeal routing, anti-spam, exemptions, and safety panel      | Does not manage sanctions or reveal private reports/appeals                  |
| `moderation.manage`      | Warn/note/sanction, inspect/amend/void cases, and recover moderation logs                | Does not change routing, review private submissions, or edit grants          |
| `reports.review`         | Inspect/claim/release/resolve/dismiss/recover confidential reports                       | Does not configure the service, review appeals, or imply punishment          |
| `appeals.review`         | Inspect/claim/release/uphold/overturn/recover confidential appeals                       | Does not configure the service, review reports, or bypass reversal checks    |
| `onboarding.configure`   | Configure lifecycle delivery, rules, verification, automatic roles, panels, and recovery | Does not configure role menus or grant moderation/private-content access     |
| `roles.configure`        | Create/edit/publish/enable/disable/archive/recover persistent self-service role menus    | Does not configure onboarding, moderate members, or manage grants            |

Discord cannot dynamically hide command subcommands for a guild's grants, so a delegate may see operations they cannot use. Runtime authorization returns a private denial. Deleting, managing, or moving a delegated role out of the guild makes its grant unusable after fresh verification.

Delegates cannot grant, revoke, list, or inspect `/access` merely because they hold another capability. They also do not inherit `/config`, `/data`, or legacy `/superior` administrative authority. `moderation.manage` is the only delegated case/sanction authority; review capabilities do not imply it.

`onboarding.configure` and `roles.configure` do not imply one another. Every use re-fetches the actor and exact granted role. For a non-owner role-menu configurator, the actor's current highest role must remain above each selected self-service role; a stale, deleted, managed, `@everyone`, duplicate, or cross-guild grant role provides no authority.

Configuration and content authority cannot be combined by self-assignment: a configure-only delegate cannot select a new ticket support, suggestion/application reviewer, report reviewer, or appeal reviewer role that they currently hold unless they already have the matching content authority. An unchanged workflow role is allowed for unrelated edits; the owner or a current Administrator can intentionally make a new overlapping assignment.

`tickets.manage` channel visibility is materialized on new/recovered channels for at most 25 verified roles. Recover every active ticket after a grant or revoke; revocation denies controls immediately, while recovery updates the existing Discord overwrite. `applications.review` remains operator-managed at the Discord ACL layer: grant and form-enable preflights require the role's access, and revocation requires separate removal of channel visibility when appropriate.

## Owners and Administrators

The guild owner and freshly verified members with Administrator permission retain ultimate authority for every delegated capability and every workflow-specific support/reviewer action. They can also:

- inspect or change optional guild settings with `/config`, including the explicit bot-state switch, limits, triggers, and greeting profiles;
- grant/revoke/list/status delegated role capabilities with `/access`;
- use `/superior` announcements, panels, message/channel/member moderation, bounded bulk actions, activity backfill, and help;
- configure/manage persistent cases, confidential reports/appeals, anti-spam rules/exemptions, and safety-panel health;
- configure all nine fixed panel presets and all ticket/suggestion/application/moderation safety workflows;
- configure welcome/farewell delivery, the private lifecycle log, versioned rules acknowledgement, automatic roles, verification panels, and bounded member recovery;
- create, publish, disable, archive, inspect, and recover persistent role menus;
- add, remove, inspect, enable, disable, and tune restricted-ping role/channel mappings; and
- export current same-guild data.

Only the guild owner can replace live data with `/data import` or permanently purge the guild's live database rows; both require exact confirmation. Owner/Administrator evaluation happens before delegated storage, so broken delegation cannot lock out recovery.

Format-8 and supported legacy formats 2–7 replace portable data for their supported era while non-portable internal delivery deduplication is preserved. Every import leaves core behavior active and makes authority and external-resource bindings dormant until current Discord resources are reviewed; anti-spam, automatic roles, verification, and role menus remain disabled, acceptance history never triggers assignment, and sanctions are never replayed. See [Configuration](../configuration.md#export-import-purge-and-recovery-review).

Administrator status does not bypass Discord's permissions for the bot itself. Cleanup, channel changes, onboarding delivery, verification/automatic/menu roles, timeouts, kicks, bans, message deletion, ticket categories/logs, suggestion threads, moderation logs, and private workflow channels all require the bot's current effective permissions and safe hierarchy.

## Ticket staff details

The department support role, owner, Administrators, and `tickets.manage` delegates are ticket staff. They can inspect, claim, release, and close a ticket. New/recovered channels contain bot-managed overwrites for up to 25 active manager roles. The opener may inspect only their own ticket; a `tickets.configure` delegate receives no private-content access from that capability.

Closing requires a reason. Superior gathers a chronological plain-text transcript of at most 1,000 recent messages and 7.5 MiB in memory, including the department, stored form answers, and bounded attachment URLs. The department log must receive the closure embed/transcript before the record closes; Superior also attempts to DM the opener. It persists the delivery checkpoint and closed state before trying to delete the channel. Failures preserve a safe retry/recovery path.

## Suggestion reviewers

The configured reviewer role, owner, Administrators, and `suggestions.review` delegates can move proposals to `under-review`, `accepted`, `declined`, or `implemented` with a bounded reason. Changes update the public embed, stop voting where appropriate, store actor/timestamps/audit events, and attempt an author DM. Repeated state interactions are conditional and idempotent. Review authority does not reveal a hidden voter list publicly or grant service configuration.

## Application reviewers

The form reviewer role, owner, Administrators, and `applications.review` delegates with effective private-channel access can see answers in that form's review destination, use **Info** for a private attachment containing every complete stored answer, claim pending work, accept/reject with a reason, and recover a missing review message. Grant and form enablement refuse an active delegate that lacks View Channel, Send Messages, or Read Message History. Conditional transitions prevent concurrent claims or decisions from silently overwriting one another. Reviewers must not repost private answers publicly. Configuration-only delegates cannot inspect submissions.

## Moderation managers

The owner, Administrators, and `moderation.manage` delegates may warn, note, timeout/untimeout, kick, ban/unban, inspect cases, amend a record with preserved audit history, void a record, and recover a missing moderation log. Every operation re-fetches the actor's relevant authority; target, guild, bot-member, role, channel, and permission resources are re-fetched wherever that operation depends on them. Self, owner, bot, cross-guild, missing-member, and unsafe-hierarchy targets are rejected where applicable.

A case is created as successful only after Discord confirms an external sanction. Voiding never reverses Discord state, and Superior refuses to void an active timeout, anti-spam timeout, or ban until a separately authorized removal completes; timeout removal and unban are explicit actions with related cases. Private notes stay within authorized case inspection and never appear in a member response, direct message, moderation log, report, or appeal. History is paginated, mention-safe, and tenant-scoped.

## Report reviewers

The configured report reviewer role, owner, Administrators, and `reports.review` delegates may see reporter identity and report content in the verified private report destination. They may claim, release, resolve, dismiss, inspect, and recover reports, with conditional/idempotent transitions and a bounded staff reason. Only the current authorized claimant may release or decide a report; another reviewer can take over only after Superior proves the prior claimant is absent or no longer authorized. They must not disclose the reporter or report outside that boundary, and resolution does not claim punishment unless a real linked moderation case exists. The reported member is never notified automatically.

The default cooldown allows three submissions per rolling 30 minutes; administrators may configure 1–10 reports and a 60–86,400-second window. A report uses category `harassment`, `spam`, `scam`, `safety`, or `other`, a 10-2,000-character explanation, and an optional validated same-guild Discord message link. Superior stores only its guild/channel/message identifiers, not the raw link, referenced message, or evidence attachments.

## Appeal reviewers

The configured appeal reviewer role, owner, Administrators, and `appeals.review` delegates may inspect, claim, release, uphold, overturn, and recover eligible appeals in the verified private appeal destination. Eligibility is limited to manual warning, kick, or ban cases and an active manual timeout whose exact expiry still matches Discord; notes, removal/unban records, anti-spam cases, failed/voided/overturned cases, and completed timeouts are excluded. Only the current authorized claimant may release or decide an appeal; another reviewer can take over only after Superior proves the prior claimant is absent or no longer authorized. One appeal is allowed per same-guild case and the appellant must be the target. Review output excludes private moderator notes.

Overturning a warning changes its case state. An active timeout is removed only after fresh authority/hierarchy checks and creates a timeout-removed case. A kick has no state to reverse. A ban becomes overturned only after an authorized unban succeeds or is verified to have already occurred. Banned members cannot invoke guild slash commands, so the Phase 3 flow is not a universal ban-appeal system and has no DM or external-form route.

## Anti-spam administration

The owner, Administrators, and `moderation.configure` delegates may configure default-disabled burst, duplicate, and mention rules, manage bounded role/channel exemptions, run the non-mutating test command, and inspect safe status. This authority does not reveal reports/appeals or authorize sanctions outside verified anti-spam enforcement.

At runtime the owner, Administrators, bots, webhooks, and freshly verified exemptions are ignored. Successful deletion precedes warnings/timeouts; ambiguous deletion or hierarchy failures do not create a sanction case. Detection windows and duplicate SHA-256 fingerprints exist only in bounded memory, while cooldowns and idempotency reservations persist. Raw message content is not stored and message edits are not enforced in Phase 3.

## Operator

The process operator controls credentials, registration mode, database path, releases, backups, migration, host access, logging, retention, and availability. Host access does not replace in-guild authorization or make private workflow data appropriate for routine inspection.

Operators must follow the [operations runbook](../operations.md), run one writer per SQLite database, protect backups/exports as sensitive, and complete the policy publication prerequisites before public operation.
