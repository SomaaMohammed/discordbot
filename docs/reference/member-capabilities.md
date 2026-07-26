# Invictus Member Capabilities

This reference lists what members can do with the current Invictus runtime, grouped by access level.

## 1. Any Member (No Admin Required)

### Invictus Chat Phrases in Normal Server Messages

- Messages must be sent in a server, not a DM, and include the word `invictus`.
- Public intents available to everyone:
  - Greeting: hi, hello, hey, yo, sup, good morning, good afternoon, good evening
  - Help: help, commands, options, what can you do
  - Coin flip: flip a coin, flip coin, coin flip, heads or tails
  - Time: what time is it, time now, current time
  - Thanks: thanks, thank you, ty
  - Farewell: goodnight, good night, sleep well

### Role Panel Button Usage

- Members can click buttons created by Invictus role-panel commands.
- A click self-assigns or removes the configured role.
- The bot must have Manage Roles, and its role must be above the target role.
- Managed roles and `@everyone` cannot be self-assigned from a panel.

### Invictus DM Panel Button Usage

- Members can click an Invictus DM-panel button to open a message modal.
- The bot forwards that message as a DM to the panel's configured recipient.
- If the recipient's DMs are closed, forwarding fails with an error message.

### Royal AFK Mention Trigger

- In the configured royal-alert channel, members can trigger AFK responses by mentioning Emperor or Empress aliases while that royal title is AFK.

## 2. Royal Members Only (Emperor/Empress Role)

### `/invictus afk`

- `/invictus afk reason:<text>` sets AFK for the caller's royal title or titles.
- `/invictus afk` with no reason clears AFK for the caller's royal title or titles.

### Emperor Text-Triggered Temporary Silence Lock

- An Emperor-role member can post specific lock phrases in a text channel.
- The result is a channel send-permission lock for two minutes on the configured target roles.

## 3. Privileged Invictus Chat Intents

Restricted conversational intents are not public:

- `invictus status report`
- `invictus what should i do`
- `invictus title me`

Access requires the Empress role or the server-configured privileged Invictus account.

## 4. Admin Members Only

The following `/invictus` subcommands require Administrator permission or server ownership:

- `/invictus say`
- `/invictus dmpanel`
- `/invictus rolepanel`
- `/invictus rolepanelmulti`
- `/invictus purge`
- `/invictus purgeuser`
- `/invictus lock`
- `/invictus unlock`
- `/invictus slowmode`
- `/invictus timeout`
- `/invictus untimeout`
- `/invictus mutemany`
- `/invictus unmutemany`
- `/invictus muteall`
- `/invictus unmuteall`
- `/invictus resetroyaltimer`
- `/invictus afkstatus`
- `/invictus backfillstats`
- `/invictus backfillstatus`
- `/invictus help`

Admin text-triggered reply mute, silence, and timeout intents work only for an administrator or server owner, in a server channel, when sent as a reply.

## Notes

- `/invictus afk` is not admin-only, but it is royal-role-only.
- Invictus chat triggers are case-insensitive.
- This reference reflects current TypeScript runtime behavior.
