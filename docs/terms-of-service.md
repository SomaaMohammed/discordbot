# Superior Terms of Service

**Effective date:** July 27, 2026<br>
**Last updated:** July 28, 2026

> **Unpublished draft — do not use this URL in the Discord Developer Portal.**
> The current implementation and these Terms are not suitable for public
> deployment or publication until every prerequisite below is implemented,
> verified in production, and reflected accurately in the final documents.

Before publication, the Operator must:

- replace `OPERATOR LEGAL NAME` and `PRIVACY/SUPPORT EMAIL` with a real legal
  identity and monitored private contact address;
- complete every deployment, encryption, provider, retention, deletion,
  disclosure, and Discord-policy prerequisite listed in the unpublished
  [Privacy Policy](privacy-policy.md);
- resolve the Discord-policy risks created by passive per-user activity
  tracking, user leaderboards, history backfills, and administrator exports of
  other users' API data;
- ensure sensitive data is prohibited, DM-panel disclosures are clear at the
  point of collection, and retained pseudonymous-answer data is described
  accurately; and
- have qualified counsel select jurisdiction-specific terms and review the
  complete agreement for the Operator's location and users.

## 1. Agreement and Operator

These Terms of Service (the "Terms") are an agreement between
**OPERATOR LEGAL NAME** (the "Operator," "we," "us," or "our") and each person
who installs or intentionally uses or interacts with the official hosted
deployment of Superior (the "Bot"). Contact the Operator at
**PRIVACY/SUPPORT EMAIL**.

By adding the Bot to a Discord server or intentionally using a Bot command,
button, modal, panel, or other feature, you agree to these Terms. If you do not
agree, do not install or intentionally use the Bot. A server administrator who
adds the Bot confirms that they have authority to do so and to configure its
permissions for that server.

If a person or organization lawfully operates an independent deployment of the
source code, it operates a separate service and must provide terms and policies
appropriate for that deployment. These Terms do not automatically govern an
independent deployment or grant rights to use the source code.

## 2. Eligibility

You must meet Discord's minimum age requirement for your country and be legally
able to agree to these Terms. If you use the Bot for an organization or manage
it for a Discord server, you confirm that you have authority to act in that
role. The Bot is not directed to anyone who is not permitted to use Discord.

## 3. What the Bot Does

Superior provides configurable Discord utilities, neutral conversational
responses, greetings, announcements, DM and role panels, activity statistics,
leaderboards, message cleanup, channel controls, and moderation or
administration tools. A server's owner and administrators decide which
supported features to enable, how to configure them, and who can view the
resulting channels and logs.

The Bot no longer offers its former court, question, anonymous-answer, royal,
scheduled-post, or digest features. Legacy records from those features may
remain in schema-v2 storage, exports, logs, or backups for compatibility,
rollback, retention, and deletion workflows. Retirement does not mean those
records were erased.

Features, commands, limits, and availability may change. The Bot is a community
and administration tool, not an emergency service, professional adviser, or
substitute for human moderation judgment.

## 4. Discord Is a Separate Service

The Bot operates through Discord and depends on Discord's APIs and
infrastructure. Your use of Discord remains subject to Discord's
[Terms of Service](https://discord.com/terms),
[Community Guidelines](https://discord.com/guidelines), and
[Privacy Policy](https://discord.com/privacy). You must not use the Bot in a way
that causes the Operator to violate Discord's rules.

Discord is not a party to these Terms, is not responsible for the Bot, and does
not sponsor or endorse it. Discord may change or withdraw API functionality,
permissions, intents, accounts, or access at any time.

## 5. Server Owner and Administrator Responsibilities

If you install or administer the Bot, you are responsible for:

- having authority to add the Bot and grant only the permissions needed for the
  features you enable;
- configuring the log channel, role hierarchy, timezone,
  moderation limits, supported features, and log visibility appropriately;
- telling members how the Bot processes information and making the current
  Privacy Policy and Terms reasonably available;
- ensuring your configuration and use comply with law, Discord's rules, and
  your server's own policies;
- supervising moderation, bulk actions, role panels, announcements, exports,
  and activity backfills;
- protecting downloaded exports and limiting access to channels that may
  contain private, moderation, or audit content; and
- reviewing Bot output and correcting or reversing actions when human judgment
  is needed.

The Bot's permission checks supplement rather than replace responsible server
administration. The Operator is not responsible for permissions, content, or
actions selected by an independent server owner or administrator. These
administrator responsibilities do not transfer or reduce the Operator's own
obligations under Discord's terms or applicable law.

## 6. User Conduct

You may use the Bot only for lawful, authorized purposes. You must not:

- violate law, Discord's rules, another person's rights, or a server's rules;
- harass, threaten, exploit, discriminate against, impersonate, or dox anyone;
- submit illegal content, malware, credentials, authentication tokens,
  protected health information, financial or payment-account information,
  government identifiers, or other sensitive information regulated by law;
- use DM panels, announcements, utilities, role panels, or moderation tools to
  evade accountability, spam, deceive, surveil, retaliate, or cause harm;
- bypass permissions, eligibility checks, cooldowns, rate limits, safety
  controls, or access restrictions;
- probe, disrupt, overload, reverse engineer for abuse, or gain unauthorized
  access to the Bot, its data, its host, or another guild's data;
- scrape, sell, broker, advertise against, or create unauthorized profiles from
  Discord or Bot data;
- infringe copyright, trademark, privacy, publicity, or other rights; or
- assist another person in doing any of the above.

Do not report a security issue by publicly posting exploit details or private
data. Send it to **PRIVACY/SUPPORT EMAIL**.

## 7. Your Content

You retain the rights you have in content you submit. You give the Operator a
limited, non-exclusive, worldwide, royalty-free license to receive, process,
store, reproduce, format, transmit, and display that content only as reasonably
needed to provide, secure, support, and maintain the Bot; comply with your
instructions; enforce these Terms; and meet legal or Discord obligations. This
license ends when the content is deleted from systems under the Operator's
control, except for copies temporarily retained in backups or retained when
lawfully required.

You confirm that you have the rights and permissions needed to submit content
and choose its destination. Depending on Discord channel permissions, content
may be public to a server, visible to administrators or log-channel viewers, or
delivered in a DM. The Operator does not claim ownership of user content.

A DM-panel submission is delivered to the recipient identified on the panel.
When a guild log channel is configured and available, the Bot also copies the
complete message, sender identity, recipient identity, and source-channel
context to that log channel. Do not submit a DM-panel message unless you accept
both disclosures.

### Retained legacy answers

The Bot no longer accepts new anonymous court answers. For a migrated or
previously used guild, the database may still contain a submitter's Discord user
ID with a question/answer-message record and timestamp. The Operator and a guild
owner or Administrator permitted to use `/setup export` can correlate that
mapping with the Discord message. A separate cooldown timestamp or per-user
legacy answer count can also remain. These records were pseudonymous, not
untraceable, and public-feature retirement did not delete them.

## 8. Privacy

The [Superior Privacy Policy](privacy-policy.md) explains what data the
Bot processes, why it is used, who can receive it, how long it is retained, and
how to request access, correction, or deletion. It is incorporated into these
Terms by reference.

Removing the Bot from a server marks the guild inactive but does not
automatically delete retained Bot data. A server owner can use `/setup purge` to
delete current live guild rows. That purge does not delete Discord-hosted
messages, host logs, historical backups, or copies previously exported by an
administrator. Privacy requests must be sent to **PRIVACY/SUPPORT EMAIL**.

That leave-retention behavior is a description of the current unpublished
implementation, not an acceptable public-deployment commitment. Before public
deployment, the Operator must implement prompt deletion after confirmed guild
removal, verified individual deletion and re-collection controls, fixed log and
backup erasure periods, and deletion of API data if the hosted Bot stops
operating, except where applicable law requires retention.

## 9. Intellectual Property

The Bot software, branding, documentation, and other materials are owned by the
Operator or their respective contributors and licensors, subject to any
third-party or open-source licenses that accompany particular components. These
Terms govern use of the hosted Bot service; they do not grant permission to use
the Operator's names, logos, or branding or imply endorsement.

Feedback may be used to improve the Bot without an obligation to compensate the
person who submits it, but this does not transfer ownership of the submitter's
pre-existing intellectual property.

## 10. Suspension and Termination

You may stop using the Bot at any time. A server owner may disable features,
disable the guild, remove the Bot, or use the confirmed guild-purge flow.

The Operator may restrict, suspend, or terminate access to protect users or the
service; investigate abuse or security issues; enforce these Terms; comply with
law, Discord's rules, or Discord's requests; or discontinue the Bot. Where
reasonable, the Operator may provide notice, but urgent safety, legal, platform,
or technical action may occur without advance notice.

If the Operator permanently discontinues the hosted Bot, it must stop accessing
Discord's APIs and promptly delete stored Discord API data unless applicable law
requires retention.

Sections that by their nature should survive termination—including content
responsibility, intellectual-property, disclaimer, liability, and dispute
terms—remain effective. Data after termination is handled under the Privacy
Policy and applicable law.

## 11. Availability and Changes

The Bot may be changed, interrupted, degraded, or discontinued. Maintenance,
bugs, Discord outages or API changes, hosting failures, configuration errors,
and events outside the Operator's control can affect service. The Operator does
not promise that every feature or historical record will remain available or
that deleted content can be recovered.

We may update these Terms when the Bot, Discord's requirements, or applicable
law changes. The updated Terms will be posted at the same public URL with a new
"Last updated" date. If a change materially affects users, the Operator will
provide any additional notice required by law. Continuing to intentionally use
the Bot after updated Terms take effect constitutes acceptance to the extent
permitted by law.

## 12. Disclaimers

To the maximum extent permitted by applicable law, the Bot is provided "as is"
and "as available." The Operator and contributors disclaim implied warranties,
including merchantability, fitness for a particular purpose, non-infringement,
and uninterrupted, secure, or error-free operation. Bot output may be
incomplete, delayed, inaccurate, or inappropriate for a particular situation;
users and administrators must review it.

Nothing in these Terms excludes a warranty, remedy, or consumer right that
cannot lawfully be excluded.

## 13. Limitation of Liability

To the maximum extent permitted by applicable law, the Operator and contributors
will not be liable for indirect, incidental, special, consequential, exemplary,
or punitive damages, or for lost data, profits, goodwill, opportunities, or
service access arising from or related to the Bot. This limitation does not
apply where liability cannot lawfully be limited, including any liability that
applicable law makes non-excludable.

Server owners and administrators remain responsible for their configurations,
permissions, moderation decisions, exports, and use of Bot output.

## 14. Disputes and General Terms

Before starting a formal dispute, contact **PRIVACY/SUPPORT EMAIL** and provide a
reasonable opportunity to resolve the issue informally. Applicable law governs
these Terms without depriving a consumer of mandatory protections available in
their place of residence. The Operator should add a jurisdiction-specific
governing-law and forum provision only after qualified legal review.

If a provision is unenforceable, it will be limited or removed only to the
minimum extent necessary, and the remaining provisions will continue. A delay
in enforcing a provision is not a waiver. You may not transfer your rights or
obligations under these Terms without the Operator's consent; the Operator may
transfer these Terms as part of a lawful reorganization or transfer of the Bot,
subject to applicable notice requirements.

These Terms, together with the Privacy Policy and any additional terms
presented for a specific feature, are the entire agreement about the hosted Bot
service. Additional terms cannot make Discord responsible for the Bot or
override Discord's terms.

## 15. Contact and Reports

**Operator:** OPERATOR LEGAL NAME<br>
**Privacy, deletion, security, abuse reports, and support email:**
PRIVACY/SUPPORT EMAIL

The Operator must review reports concerning the Bot, its use, or violations of
Discord's rules and take appropriate action. This reporting channel must be
monitored before public deployment.

When reporting a problem, include enough non-sensitive context to identify the
relevant guild and event. Never send a Discord token, password, or another
person's private information unless the Operator specifically and lawfully
requests it through a secure channel.
