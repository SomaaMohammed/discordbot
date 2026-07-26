# Invictus Trigger Patterns

All patterns in this reference are case-insensitive.

## Reply Mute Triggers

These patterns run only when all conditions are true:

- The message is sent by an administrator or server owner.
- The message is in a server, not a DM.
- The message is sent as a reply to another member's message.

Valid trigger text:

- `hey invictus mute`
- `hey invictus mute <anything>`
- `hey, invictus mute <anything>`
- `hey, invictus: mute <anything>`
- `yo invictus mute <anything>`
- `oi invictus mute <anything>`
- `hey invictus silence`
- `hey invictus silence <anything>`
- `hey invictus timeout`
- `hey invictus timeout <anything>`
- `invictus mute`
- `invictus mute <anything>`
- `invictus silence`
- `invictus silence <anything>`
- `invictus timeout`
- `invictus timeout <anything>`
- `invictus: mute|silence|timeout <anything>`
- `invictus quiet <anything>`
- `invictus hush <anything>`
- `invictus you know what to do`
- `invictus, you know what to do <anything>`
- `invictus u know what to do <anything>`
- `hey invictus you know what to do <anything>`
- `yo invictus do your thing <anything>`
- `invictus do your thing <anything>`
- `invictus handle this <anything>`

Extra text after a reply-mute trigger is used as the mute reason. If none is provided, the bot uses a default reason.

## Silent Channel Lock Triggers

These patterns run only when the message is sent by a member with the Emperor role in a text channel.

Valid trigger text:

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

Behavior:

- Locks the current text channel for two minutes.
- Applies `SendMessages: false` only to:
  - `@everyone`
  - citizen role `1461386876475932806`
- Restores each role to its original `SendMessages` overwrite value.
- Posts no bot message for this action.

## Royal AFK Mention Trigger

This trigger runs only in the configured royal-alert channel.

Word matches anywhere in the message:

- Emperor aliases: sammy, emperor, his majesty, your majesty
- Empress aliases: empress, her majesty, tay, taytay, taylor, tayla
- Mentioning royal members by Discord mention also counts.

Behavior:

- The bot replies only when the referenced royal title is currently AFK.
- Replies use safe mentions with no everyone, user, or role pings.

## Invictus Chat Triggers (Mixed Access)

These conversational triggers run only when a message is in a server, not a DM, and contains the word `invictus`.

Available to all members:

- Greeting: hi, hello, hey, yo, sup, good morning, good afternoon, good evening
- Help: help, commands, options, what can you do
- Coin flip: flip a coin, flip coin, coin flip, heads or tails
- Time: what time is it, time now, current time
- Thanks: thanks, thank you, ty
- Farewell: goodnight, good night, sleep well

Restricted to the Empress role or Emperor role:

- Status: status, status report
- Counsel: advice, omen, prophecy, what should i do, what do you think
- Title: title me, give me a title, grant me a title, bestow a title, bestow title

The two lists above are the intent-phrase lists. The bot sends an in-channel thematic reply based on the matching intent and uses safe mentions with no everyone, user, or role pings.

## Royal Presence Announcement (Automatic)

This is not a text-keyword trigger. It runs automatically when a message in the royal-alert channel is sent by a member with either of these roles:

- Emperor role
- Empress role

Behavior:

- Posts `# The Emperor has spoken` or `# The Empress has spoken`.
- The timer is separate for each role, not shared.
- The interval is three hours per role.

## General Notes

- Any capitalization works for all text triggers.
- Extra text after a reply-mute trigger is used as the mute reason.
- If no extra text is provided, a default reason is used.
