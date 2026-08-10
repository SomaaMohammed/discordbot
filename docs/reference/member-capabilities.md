# Member capabilities

All authority is guild-scoped. Superior ignores DMs and refuses work when the guild is disabled, inactive, unconfigured, purged, cross-guild, or invalidated during asynchronous work. Privileged interactions re-fetch the current member and relevant role/resource; slash-command visibility alone grants nothing.

## Guild members

All members of an enabled guild may:

- deliberately address the bot through the configured invocation, a bot mention, or a reply for natural chat, status, bounded dice, and bounded choices;
- use `/utility ping`, `avatar`, `userinfo`, `serverinfo`, `roleinfo`, `channelinfo`, `snowflake`, and `timestamp`;
- use `/fun battle`, `/fun stats`, and `/fun leaderboard` when activity metrics are enabled;
- use `/greetings send` with a configured profile;
- interact with a current role panel when the target role remains safe and manageable;
- open a ticket in an enabled department, subject to one active ticket per department and three across the guild, and inspect the state of their own ticket;
- submit, view, withdraw, and vote on suggestions while the service/state/cooldown permits;
- submit an enabled staff-application form, privately view their own status, and withdraw their own still-pending application; and
- use `/pingrole` for a configured, enabled role they currently hold in its exact allowed channel or explicitly enabled child thread/post, subject to current permissions and both persisted cooldowns.

Utilities disclose only information available from the current guild or supplied public Discord ID. Requested members, roles, and channels must belong to the current guild. Inputs are bounded and validated before a response or metric write.

Ticket and application form answers are normalized and stored. Ticket answers appear only in the resulting private ticket and its closure outputs. Application answers appear only in the configured private staff review channel and authorized same-applicant status flow. Suggestion authors/title/details are public in the configured suggestion channel; vote totals are public but voter identities are not. Applicant/member-controlled text cannot create mentions.

## Workflow roles

Configured workflow roles provide content authority only for the workflow that names them:

- A department support role may inspect, claim, release, close, and otherwise manage tickets belonging to that department.
- The suggestion reviewer role may list and transition suggestions with a reason.
- An application form's reviewer role may inspect private answers, claim the application, accept/reject with a reason, and recover its private review delivery.

Membership and the configured role are fetched again before a control is accepted. `@everyone`, managed roles, missing roles, and roles belonging to another guild are invalid. A workflow role does not configure the service, grant delegated access, or authorize a different department/form.

## Restricted-ping role members

A restricted-ping role grants only the ability to request that same role's notification through `/pingrole`. Membership alone does not authorize another role, another channel, another guild, or an unrelated thread. Channel presence alone does not replace current role membership. The member must also retain View Channel, Use Application Commands, and the applicable direct-channel or thread send permission.

Superior sends the notification rather than making the role mentionable or giving the member Mention Everyone. The outgoing payload allows exactly the one authorized role mention and contains no member-controlled text. Per-user/per-role and guild-wide/per-role cooldowns begin only after successful Discord delivery; no owner, Administrator, or role member bypasses them. Missing/deleted resources, bots/webhooks, stale mappings, disabled roles, permission loss, and Discord failures fail privately without claiming success.

## Delegated managers

The owner or an Administrator may grant one narrow capability to a safe guild role through `/access grant`. Grants are independent; holding one never implies another.

| Capability               | Delegated operations                                                              | Explicit separation                                                          |
| ------------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `panels.manage`          | List/post/replace/status for fixed Superior panels                                | Does not configure the underlying ticket, suggestion, or application service |
| `tickets.configure`      | Configure departments/forms/routing, enable/disable, health, and launcher posting | Does not grant access to private ticket channels or controls                 |
| `tickets.manage`         | Manage ticket controls and run ticket recovery                                    | Does not edit departments or grants                                          |
| `suggestions.configure`  | Setup/disable service, post launcher, recover public delivery                     | Does not review or decide proposals                                          |
| `suggestions.review`     | List/review suggestions and use review controls                                   | Does not change channel/rate settings                                        |
| `applications.configure` | Create/edit/enable/disable forms/questions and post launcher                      | Does not reveal submitted answers or allow decisions                         |
| `applications.review`    | Inspect/claim/decide/recover private applications                                 | Does not edit forms or grants                                                |

Discord cannot dynamically hide command subcommands for a guild's grants, so a delegate may see operations they cannot use. Runtime authorization returns a private denial. Deleting, managing, or moving a delegated role out of the guild makes its grant unusable after fresh verification.

Delegates cannot grant, revoke, list, or inspect `/access` merely because they hold another capability. They also do not inherit `/setup` or `/superior` administrative moderation authority.

Configuration and content authority cannot be combined by self-assignment: a configure-only delegate cannot select a new ticket support or suggestion/application reviewer role that they currently hold. An unchanged workflow role is allowed for unrelated edits; the owner or a current Administrator can intentionally make a new overlapping assignment.

`tickets.manage` channel visibility is materialized on new/recovered channels for at most 25 verified roles. Recover every active ticket after a grant or revoke; revocation denies controls immediately, while recovery updates the existing Discord overwrite. `applications.review` remains operator-managed at the Discord ACL layer: grant and form-enable preflights require the role's access, and revocation requires separate removal of channel visibility when appropriate.

## Owners and Administrators

The guild owner and freshly verified members with Administrator permission retain ultimate authority for every delegated capability and every workflow-specific support/reviewer action. They can also:

- configure and validate the guild with `/setup`, feature flags, limits, triggers, and greeting profiles;
- grant/revoke/list/status delegated role capabilities with `/access`;
- use `/superior` announcements, panels, message/channel/member moderation, bounded bulk actions, activity backfill, and help;
- configure all six fixed panel presets and all ticket/suggestion/application workflows;
- add, remove, inspect, enable, disable, and tune restricted-ping role/channel mappings; and
- export current same-guild data.

Only the guild owner can replace live data with `/setup import` or permanently purge the guild's live database rows; both require exact confirmation. Owner/Administrator evaluation happens before delegated storage, so broken delegation cannot lock out recovery.

Format-5, legacy format-4, and legacy format-3 imports replace portable operational data for their supported era while internal delivery deduplication is preserved; legacy format 2 replaces settings/metrics and preserves current operational rows. Every import disables the guild and makes imported authority/resource bindings, including restricted-ping mappings, dormant until current Discord resources are reviewed. See [Configuration](../configuration.md#export-import-purge-and-recovery-review).

Administrator status does not bypass Discord's permissions for the bot itself. Cleanup, channel changes, roles, timeouts, ticket categories/logs, suggestion threads, and private application channels all require the bot's current effective permissions and safe hierarchy.

## Ticket staff details

The department support role, owner, Administrators, and `tickets.manage` delegates are ticket staff. They can inspect, claim, release, and close a ticket. New/recovered channels contain bot-managed overwrites for up to 25 active manager roles. The opener may inspect only their own ticket; a `tickets.configure` delegate receives no private-content access from that capability.

Closing requires a reason. Superior gathers a chronological plain-text transcript of at most 1,000 recent messages and 7.5 MiB in memory, including the department, stored form answers, and bounded attachment URLs. The department log must receive the closure embed/transcript before the record closes; Superior also attempts to DM the opener. It persists the delivery checkpoint and closed state before trying to delete the channel. Failures preserve a safe retry/recovery path.

## Suggestion reviewers

The configured reviewer role, owner, Administrators, and `suggestions.review` delegates can move proposals to `under-review`, `accepted`, `declined`, or `implemented` with a bounded reason. Changes update the public embed, stop voting where appropriate, store actor/timestamps/audit events, and attempt an author DM. Repeated state interactions are conditional and idempotent. Review authority does not reveal a hidden voter list publicly or grant service configuration.

## Application reviewers

The form reviewer role, owner, Administrators, and `applications.review` delegates with effective private-channel access can see answers in that form's review destination, use **Info** for a private attachment containing every complete stored answer, claim pending work, accept/reject with a reason, and recover a missing review message. Grant and form enablement refuse an active delegate that lacks View Channel, Send Messages, or Read Message History. Conditional transitions prevent concurrent claims or decisions from silently overwriting one another. Reviewers must not repost private answers publicly. Configuration-only delegates cannot inspect submissions.

## Operator

The process operator controls credentials, registration mode, database path, releases, backups, migration, host access, logging, retention, and availability. Host access does not replace in-guild authorization or make private workflow data appropriate for routine inspection.

Operators must follow the [operations runbook](../operations.md), run one writer per SQLite database, protect backups/exports as sensitive, and complete the policy publication prerequisites before public operation.
