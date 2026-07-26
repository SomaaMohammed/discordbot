# Imperial Court Bot Development

The active production implementation is the TypeScript runtime under `tsbot/`.

## Runtime Responsibilities

- Implements the `court`, `questions`, `invictus`, `fun`, and `greetings` slash-command families.
- Handles anonymous-answer modals, role-panel buttons, and Invictus message-chat replies.
- Runs the `auto_poster`, `thread_closer`, `weekly_digest`, and `retention_cleaner` background loops.
- Stores state, posts, answers, metrics, and cooldowns in the root `court.db` SQLite database.
- Seeds missing `kv` keys for a fresh database from `data/bootstrap/` without overwriting keys already present in an existing database.

The complete conversational phrase list and its access rules are maintained in the [trigger-pattern reference](reference/trigger-patterns.md).

## Invictus Chat

- Normal server messages containing `invictus` can trigger greeting, help, coin-flip, time, thanks, and farewell replies for any member.
- Status-report, counsel, and title-bestowal intents are restricted to the configured royal roles.
- `/invictus say` accepts normal-length text through a modal or a plain-text `message_file` attachment for longer announcements; long text is split across multiple embed messages.

## Local Commands

Node.js 22 or newer is recommended.

```bash
cd tsbot
npm ci
npm run check
npm run typecheck
npm test
npm run build
npm run dev
```

`npm run check` runs typecheck, tests, and build together. The individual commands remain useful while iterating.

## Production Command

```bash
cd tsbot
npm run build
npm run start
```

The compiled entrypoint is `tsbot/dist/src/index.js`. Production deployment and service management are documented in the [operations runbook](operations.md).

## Design Constraints

- Keep compatibility with the existing `court.db` schema, default root database path, and `kv` key usage.
- Keep environment-key compatibility with the repository-root `.env` file.
- Keep JSON-to-SQLite bootstrap compatibility with `data/bootstrap/` for fresh databases.
- Make behavior changes incrementally and cover them with tests.
- Do not use a live Discord login as a development smoke test.

## Test Guidance

- Add focused unit or regression coverage beside the existing tests in `tsbot/tests/`.
- Use temporary directories or in-memory databases for storage tests; never point tests at the root `court.db`.
- Cover permission and channel-failure paths when changing Discord interactions.
- Before committing runtime changes, run `npm run typecheck`, `npm test`, and `npm run build` from `tsbot/`.

## Testing Backlog

The remaining useful follow-ups from the completed runtime migration are:

1. Expand integration-style command tests for role-panel posting and bulk-moderation edge cases.
2. Add focused tests for modal-submit flows (`anonymous answer` and `invictus say`) with permission and channel-failure paths.
