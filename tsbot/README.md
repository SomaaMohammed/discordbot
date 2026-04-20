# Imperial Court Bot (TypeScript Runtime)

This directory contains the active production/runtime implementation of Imperial Court Bot.

## Status

- Slash command families are implemented and runnable:
  - `court`
  - `questions`
  - `invictus`
  - `fun`
  - `greetings`
- Runtime parity includes:
  - anonymous answer modal flow
  - role panel button interactions
  - privileged message-chat replies for Invictus trigger phrases
  - background loops (`auto_poster`, `thread_closer`, `weekly_digest`, `retention_cleaner`)
  - SQLite-backed state, posts, answers, metrics, and cooldown storage

## Privileged Invictus Chat

- Triggered by normal messages that include `invictus` plus known conversational phrases.
- Access is restricted to:
  - members with the Empress role
  - the configured `UNDEFEATED_USER_ID`
- Supported intents include greeting, status report, counsel, help, title bestowal, coin flip, time, thanks, and farewell.
- Full phrase reference is maintained in `../invictus_trigger_patterns.txt`.

## Local Commands

```bash
cd tsbot
npm ci
npm run typecheck
npm test
npm run build
npm run dev
```

## Production Command

```bash
cd tsbot
npm run build
npm run start
```

## Design Constraints

- Keep DB compatibility with existing `court.db` schema and key usage.
- Keep env key compatibility from repo-root `.env`.
- Keep behavior changes incremental and covered by tests.
