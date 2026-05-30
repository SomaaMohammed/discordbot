# Imperial Court Bot

Imperial Court Bot now runs on the TypeScript runtime in `tsbot/`.

The legacy Python runtime has been retired from this repository.

## Runtime

- Runtime language: TypeScript (Node 22+ recommended)
- Bot entrypoint: `tsbot/src/index.ts`
- Production start command: `npm run start` from `tsbot`
- Build output: `tsbot/dist/`
- Persistent data: `court.db` (SQLite)

Trigger phrase reference:

- `invictus_trigger_patterns.txt`

## Invictus Announcements

- Use `/invictus say` for admin announcements.
- For short messages, use the modal input directly.
- For longer announcements, attach a plain text file with the optional `message_file` option.
- Long announcement files are split into multiple embed parts automatically (up to 32,000 total characters).

## Repository Layout

```text
.
|-- tsbot/
|   |-- src/
|   |-- tests/
|   |-- package.json
|   `-- tsconfig.json
|-- questions.json
|-- answers.json
|-- state.json
|-- court.db
`-- ops.sh
```

## Local Development

```bash
cd tsbot
npm ci
npm run check
npm run typecheck
npm test
npm run build
npm run dev
```

## Deployment

Preferred server deployment command:

```bash
cd ~/imperial-court-bot
RUN_TESTS=1 RUN_TYPECHECK=1 bash ./ops.sh deploy main
```

Useful options:

- `LOCAL_CHANGES_POLICY=stash` auto-stashes local changes before pull.
- `SKIP_PULL=1` runs rollout on current checkout without fetching.
- `SKIP_SERVICE_RESTART=1` runs build/tests only (no `systemctl` restart).

`ops.sh` also supports `rollout`, `backup`, and `restore` subcommands.

## Environment

Required keys in `.env`:

- `DISCORD_TOKEN`
- `TEST_GUILD_ID`
- `COURT_CHANNEL_ID`

Optional operational keys (defaults are applied by `bash ./ops.sh rollout` when absent):

- `LOG_CHANNEL_ID`
- `TIMEZONE`
- `DB_FILE`
- `BOT_VERSION`
- `STAFF_ROLE_IDS`
- `EMPEROR_ROLE_ID`
- `EMPRESS_ROLE_ID`
- `SILENT_LOCK_EXCLUDE_ROLES`
- `ROYAL_ALERT_CHANNEL_ID`
- `UNDEFEATED_USER_ID`
- `ANON_MIN_ACCOUNT_AGE_MINUTES`
- `ANON_MIN_MEMBER_AGE_MINUTES`
- `ANON_REQUIRED_ROLE_ID`
- `ANON_COOLDOWN_SECONDS`
- `ANON_ALLOW_LINKS`
- `MUTEALL_TARGET_CAP`
- `WEEKLY_DIGEST_CHANNEL_ID`
- `WEEKLY_DIGEST_WEEKDAY`
- `WEEKLY_DIGEST_HOUR`
- `ANSWER_RETENTION_DAYS`

## Database Operations

- Create validated backup: `bash ./ops.sh backup`
- Restore validated backup: `bash ./ops.sh restore /path/to/backup.db`

Both database commands validate SQLite integrity and required tables before completing.
