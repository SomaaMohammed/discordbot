# Invictus Trigger Patterns

Message triggers run only in an enabled guild with the relevant feature flag. They never run in DMs, disabled guilds, or an unrelated guild. Matching is case-insensitive.

`invictus` is the default conversational invocation keyword. Each guild can replace it and configure aliases with `/setup trigger`; examples below use `<keyword>` to mean the guild's keyword or one of its aliases.

## Reply Moderation Triggers

Reply moderation runs only when all of these conditions are true:

- the guild and reply-moderation feature are enabled;
- the message author is the guild owner or has Administrator permission;
- the message replies to another member in the same guild and channel;
- the bot can moderate the target under Discord's ownership and role-hierarchy rules.

Recognized forms include:

```text
hey <keyword> mute [reason]
yo <keyword> silence [reason]
oi <keyword> timeout [reason]
<keyword>: quiet [reason]
<keyword> hush [reason]
<keyword> you know what to do [reason]
<keyword> u know what to do [reason]
<keyword> do your thing [reason]
<keyword> handle this [reason]
```

Punctuation around the invocation is optional. Extra text becomes the moderation reason; the bot uses a neutral default when it is absent.

## Temporary Silence Lock Triggers

Silence-lock phrases run only when the silence-lock feature is enabled and the author has the current guild's configured Emperor binding. Recognized phrases are:

- `silence`
- `silence now`
- `silence the court`
- `court silence`
- `order in the court`
- `the emperor is here`
- `emperor is here`
- `the emperor has arrived`
- `emperor has arrived`
- `make way for the emperor`
- `all rise for the emperor`

The temporary lock applies `SendMessages: false` only to roles in the guild's `silenceTargets` setting, minus roles in `silenceExcludes`. The bot records and restores each affected overwrite value. No citizen role, exclusion role, or other production snowflake is built into the active runtime. Manage Roles and role/channel access are required because Discord treats permission-overwrite edits as role management.

## Royal AFK Mentions

Royal AFK mention responses run only when royal AFK is enabled and the message is in the current guild's configured royal-alert channel. The bot resolves configured Emperor/Empress role mentions and title labels in that guild. It replies only when the referenced title is currently AFK and uses safe allowed-mention settings.

## Invictus Chat

Invictus chat requires the `invictusChat` feature and the configured invocation keyword or alias.

Public intent phrases include:

- greeting: hi, hello, hey, yo, sup, good morning, good afternoon, good evening;
- help: help, commands, options, what can you do;
- coin flip: flip a coin, flip coin, coin flip, heads or tails;
- time: what time is it, time now, current time;
- thanks: thanks, thank you, ty;
- farewell: goodnight, good night, sleep well.

A configured privileged-chat role or the configured champion user is required for:

- status: status, status report;
- counsel: advice, omen, prophecy, what should I do, what do you think;
- title: title me, give me a title, grant me a title, bestow a title.

Emperor and Empress role bindings remain separate from privileged chat; bind the same role under `privileged-chat` as well if that guild wants royal-role members to receive these intents.

Responses use the current guild's labels and timezone and do not allow everyone, user, or role pings unless a specific feature explicitly requires a controlled mention.

## Royal Presence Announcements

Royal presence is not a keyword trigger. When enabled, a message in the configured royal-alert channel from a member with the configured Emperor or Empress role can produce the corresponding title announcement.

Presence timers are stored independently per title and per guild. The resolved channel and member roles must belong to the expected guild. A message in one guild cannot advance another guild's timer or select its fallback channel.
