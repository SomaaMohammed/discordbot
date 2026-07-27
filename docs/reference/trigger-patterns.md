# Superior Trigger Patterns

Message triggers run only in an enabled guild with the relevant feature flag. They never run in DMs, disabled guilds, or another guild's context. Matching is case-insensitive and normalizes ordinary punctuation.

`superior` is the default conversational invocation for new guilds. Each guild can replace it and configure aliases with `/setup trigger`; existing guilds retain their persisted terms until an administrator changes them. The examples below use `<keyword>` for the current guild's keyword or any configured alias.

## Public Superior Chat

Superior chat requires the `superior-chat` feature. Address Superior directly by placing `<keyword>` at the beginning or end of the message, or by mentioning the bot in the same position. Common punctuation and polite prefixes such as `please`, `can you`, and `could you` are accepted. Incidental use of the word in the middle of unrelated text does not trigger a response.

Supported public intents are:

- greeting: `hi`, `hello`, `hey`, `yo`, `sup`, `howdy`, `greetings`, time-of-day greetings, `what's up`, or `how are you`;
- help: `help`, `command(s)`, `command list`, `options`, `features`, `capabilities`, or common “how do I use you?” wording;
- coin: flip/toss a coin, coin flip/toss, or heads or tails;
- time: `what time is it`, `time now`, `current time`, or `tell me the time`;
- thanks: `thanks`, `thank you`, `thx`, `ty`, `tysm`, `cheers`, or appreciation wording;
- farewell: `goodnight`, `sleep well`, `bye`, `goodbye`, `cya`, `see you`, or `later`;
- ping: `ping`, `pong`, `latency`, `response time`, or common online/alive wording;
- uptime: `uptime`, how long the bot has been up/running/online, or when it started;
- about: `about`, `who are you`, `what are you`, bot information, or version;
- dice: `roll d20`, `roll 2d6`, `throw dice`, and equivalent notation/wording;
- choice: `choose`, `pick`, `decide`, or `select` between options separated by `or`, commas, or `|`.

Examples:

```text
hi <keyword>
<keyword> help
<keyword>, flip a coin
<keyword> what time is it
thanks <keyword>
good night <keyword>
<keyword> ping
<keyword> uptime
<keyword> about
<keyword> roll dice
<keyword> choose pizza or burgers
```

Dice requests allow 1–20 dice with 2–1,000 sides. Choice requests require 2–20 unique options of at most 100 characters each. Invalid requests receive bounded usage guidance instead of being executed as arbitrary text.

The time response uses the IANA timezone configured with `/setup timezone`. Replies use safe allowed-mention settings and do not grant authority or execute arbitrary text.

## Reply Moderation

Reply moderation runs only when all of these conditions are true:

- the guild and `reply-moderation` feature are enabled;
- the author is the guild owner or has Discord Administrator permission;
- the message replies to another member in the same guild;
- the bot can moderate the target under Discord's ownership, permission, and role-hierarchy rules.

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

Extra text becomes the moderation reason. This trigger applies the runtime's fixed short timeout and is distinct from the explicit `/superior timeout` and bulk-moderation commands.

## Retired Triggers

Court-silence phrases, Emperor-arrival phrases, royal AFK mentions, royal presence announcements, imperial title/counsel responses, and court status responses are retired. Persisted royal labels, roles, channels, feature flags, or old invocation aliases do not reactivate them.
