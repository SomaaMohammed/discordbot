# Imperial Court Bot

Imperial Court Bot now runs on the TypeScript runtime in `tsbot/`.

The legacy Python runtime has been retired from this repository.

## Runtime

- Runtime language: TypeScript (Node 22+ recommended)
- Bot entrypoint: `tsbot/src/index.ts`
- Production start command: `npm run start` from `tsbot`
- Build output: `tsbot/dist/`
- Persistent data: `court.db` (SQLite)

## Repository Layout

```text
.
├── tsbot/
│   ├── src/
│   ├── tests/
│   ├── package.json
│   └── tsconfig.json
├── questions.json
├── answers.json
├── state.json
├── court.db
├── deploy_server.sh
├── post_pull_server.sh
├── backup_db.sh
└── restore_db.sh
```

## Local Development

```bash
cd tsbot
npm ci
npm run typecheck
npm test
npm run build
npm run dev
```

## Deployment

Preferred server deployment command:

```bash
cd ~/imperial-court-bot
RUN_TESTS=1 RUN_TYPECHECK=1 ./deploy_server.sh main
```

Useful options:

- `LOCAL_CHANGES_POLICY=stash` auto-stashes local changes before pull.
- `SKIP_PULL=1` runs rollout on current checkout without fetching.
- `SKIP_SERVICE_RESTART=1` runs build/tests only (no `systemctl` restart).

`deploy_vm.sh` is retained as a compatibility wrapper and forwards to `deploy_server.sh`.

## Environment

Required keys in `.env`:

- `DISCORD_TOKEN`
- `TEST_GUILD_ID`
- `COURT_CHANNEL_ID`

Optional operational keys (defaults are applied by `post_pull_server.sh` when absent):

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

- Create validated backup: `./backup_db.sh`
- Restore validated backup: `./restore_db.sh /path/to/backup.db`

Both scripts validate SQLite integrity and required tables before completing.
