# Imperial Court Bot Operations

This runbook covers version 2 of the TypeScript runtime and the default systemd service `imperial-court-bot`. One process serves every configured guild from one shared SQLite database. Treat that database, its sidecars, `.env`, and every backup as live operator data.

## Safety Rules

- Never test migration code against the live `court.db`.
- Never copy live guild data into test fixtures.
- Stop the running v1 service before its schema is migrated. The rollout script does this automatically.
- Create and validate a SQLite-consistent backup before migration. A filesystem copy of an active database is not sufficient.
- Never delete or overwrite an operator backup automatically. `ops.sh` creates unique backup names and has no retention deletion.
- Do not start the previous release on a v2 database. Restore its pre-migration v1 backup first.
- Do not use `npm run dev` or `npm run start` as a validation check; both can connect to Discord and access live data.
- Never print or stage environment files, the Discord token, SQLite databases or sidecars, or backups.

## Prerequisites

The host needs:

- Node.js 22.12.0 or newer and npm;
- `sqlite3` with backup and read-only CLI support;
- git, Bash, GNU `realpath`, and `mktemp`;
- systemd access through `sudo` for normal rollout and restore checks.

Run `ops.sh` as the same service account that owns the checkout and runtime data; its private `0077` umask intentionally makes newly installed dependencies and build output owner-only. The service must continue to run the compiled entrypoint `tsbot/dist/src/index.js`. Review any external systemd unit, working directory, environment-file path, file ownership, sandboxing directives, and restart policy separately; those files are not managed by this repository.

Create the process configuration from `.env.example`. For production, use global command registration:

```dotenv
DISCORD_TOKEN=<secret>
DB_FILE=court.db
COMMAND_REGISTRATION_MODE=global
DEV_GUILD_IDS=
SCHEDULER_CONCURRENCY=4
LEGACY_GUILD_ID=
```

The values above are placeholders. `BOT_OPERATOR_USER_IDS` is reserved process metadata in version 2 and currently grants no command or setup authority. Never paste a real token or guild ID into documentation, source, or shell history shared with others.

By default both the runtime and `ops.sh` load `<repository>/.env`. To select another file, export `ENV_FILE`; a relative path resolves from the repository root. Use the same `ENV_FILE` in the systemd process and every operations command so the migration and runtime cannot read different settings. Do not put `ENV_FILE` inside the file it is supposed to select. Commands that infer the database target fail closed when the selected environment file is missing unless `DB_FILE` is supplied explicitly in the shell; an explicit database argument to `ops.sh validate` remains independent of `.env`.

Restrict local configuration and live data to the service account: use mode `0600` for `.env`, the SQLite database, and any `-wal`, `-shm`, or `-journal` sidecars, and mode `0700` for backup directories. `ops.sh` uses a `0077` umask and reapplies `0600` while the database is offline or being restored. Configure the external systemd unit with `UMask=0077` so sidecars recreated later by the running service remain private. Also verify the unit's `User`, `Group`, `EnvironmentFile`, working directory, and database ownership before rollout.

## v1 Migration Preparation

Before pulling version 2:

1. Confirm the current service and database path from the host's systemd/environment configuration without printing the token.
2. Confirm the root `court.db` and newest known-good backups remain present.
3. Record the production guild snowflake as `LEGACY_GUILD_ID` in the selected local `ENV_FILE`.
4. Preserve the existing version 1 guild-specific environment keys through migration so the compatibility module can seed equivalent settings.
5. Confirm there is enough disk space for the database, a pre-migration backup, dependencies, and build output.

When legacy rows exist, `LEGACY_GUILD_ID` must be one valid Discord snowflake. `TEST_GUILD_ID` is accepted only as a deprecated fallback for the first migration. It no longer selects the runtime guild or command-registration target.

The compatibility loader may read these exact v1 environment keys once: `TIMEZONE`, `COURT_CHANNEL_ID`, `LOG_CHANNEL_ID`, `WEEKLY_DIGEST_CHANNEL_ID`, `ROYAL_ALERT_CHANNEL_ID`, `STAFF_ROLE_IDS`, `EMPEROR_ROLE_ID`, `EMPRESS_ROLE_ID`, `SILENT_LOCK_EXCLUDE_ROLES`, `ANON_REQUIRED_ROLE_ID`, `WEEKLY_DIGEST_WEEKDAY`, `WEEKLY_DIGEST_HOUR`, `ANON_MIN_ACCOUNT_AGE_MINUTES`, `ANON_MIN_MEMBER_AGE_MINUTES`, `ANON_COOLDOWN_SECONDS`, `ANON_ALLOW_LINKS`, `MUTEALL_TARGET_CAP`, `ANSWER_RETENTION_DAYS`, and `UNDEFEATED_USER_ID`. Keep the exact string form of legacy Discord IDs: converting them through JavaScript numbers can lose precision. Court mode, posting time, dry-run state, channel fallbacks, and history are also recovered from the legacy database where present.

Keep those old keys only until migration and a full `/setup export` review are complete. Version 2 runtime behavior comes from persisted `guild_settings`, not those variables. Compatibility-only defaults remain quarantined in the migration module and never seed a new guild.

Version 1 generated per-user metric keys by converting Discord snowflakes through a JavaScript number, which could round large IDs. Version 2 preserves those legacy rows, uses them as a read-only fallback, and lazily seeds an exact-string key when that user next records or backfills the same metric. A rounded legacy key is hidden from leaderboards once an exact replacement exists, but two IDs that collided in version 1 cannot be distinguished retroactively. Use the guild-scoped backfill command where message history is available and treat any remaining pre-v2 per-user attribution as approximate; aggregate metrics and all other migrated tables are unaffected.

## Read-Only Preflight

After version 2 code is checked out, install its dependency set, then classify and validate the selected database without writing it:

```bash
cd ~/imperial-court-bot/tsbot
npm ci
npm run db:check
```

`db:check` opens the configured database read-only, runs SQLite integrity checks, and accepts only an exact legacy-v1 schema or a valid current-v2 schema. It fails for a missing path, corrupt database, partial migration, or unknown schema.

The operations wrapper provides the same read-only check:

```bash
cd ~/imperial-court-bot
bash ./ops.sh validate
```

Do not run the migration until preflight succeeds and the legacy tenant ID is configured when rows exist.

## First Upgrade From Version 1

Do not run `bash ./ops.sh deploy` from the old v1 checkout. Bash has already parsed that old script before its `git pull`, so it cannot acquire the new backup and migration safeguards in the same process.

Start from a clean worktree, pull version 2 explicitly, and then launch the newly checked-out script:

```bash
cd ~/imperial-court-bot
git status --short
git fetch origin main
git merge --ff-only --no-overwrite-ignore FETCH_HEAD
bash ./ops.sh rollout
```

Stop if `git status --short` prints anything; preserve and resolve local work before pulling. Pulling source does not migrate the database. The new `rollout` command installs dependencies before downtime, then stops v1 before any backup or migration write.

## Subsequent Safe Deployments

Once the host already has the version 2 operations script, use:

```bash
cd ~/imperial-court-bot
bash ./ops.sh deploy main
```

After a successful pull, `deploy` replaces its shell process with the newly checked-out `ops.sh rollout`; it never continues rollout using a stale in-memory script. The rollout performs this sequence and stops on the first failure:

1. refuses local changes or explicitly stashes tracked source changes, then fast-forwards with Git's ignored-file overwrite protection while leaving every untracked and ignored operator file untouched;
2. re-executes the operations script from the new checkout;
3. installs locked Node dependencies and validates process configuration before downtime;
4. verifies the configured systemd unit exists, stops it, and confirms it is fully stopped;
5. validates the current database integrity and schema through read-only connections;
6. creates a SQLite `.backup` snapshot with a unique `court-pre-migration-*.db` name;
7. validates the backup's integrity/schema and compares every required table row count with the source;
8. runs `npm run migrate` explicitly with the selected `ENV_FILE` and canonical database path;
9. runs direct v2 table/key/foreign-key checks and `npm run db:check -- --require-current`;
10. runs typecheck, the full test suite with a temporary database and empty token, build, and `node --check dist/src/index.js`;
11. reloads systemd and restarts the service only after every earlier step succeeds;
12. confirms that the service is active and prints recent service logs.

Tests, typecheck, and build are mandatory in a production rollout; there are no skip flags for them. A migration or validation failure leaves the service stopped and preserves the source database transaction outcome and the pre-migration backup. Investigate before taking any further write action.

`LOCAL_CHANGES_POLICY=stash` never stashes untracked files, custom environment files, databases, sidecars, or backup directories. It prints the name of any tracked-change stash it creates so the operator can recover it deliberately after deployment. Deployment fetches once and then runs `git merge --ff-only --no-overwrite-ignore FETCH_HEAD`; an untracked or ignored path that conflicts with the fetched branch makes Git abort without moving or overwriting that path.

To roll out an already checked-out branch without pulling:

```bash
SKIP_PULL=1 bash ./ops.sh deploy
```

For an already-offline local or recovery database with no systemd interaction, both confirmations are required:

```bash
SKIP_SERVICE_RESTART=1 OFFLINE_MIGRATION_CONFIRMED=1 bash ./ops.sh rollout
```

That option is unsafe for a database still used by any process. It does not stop or restart a service.

## Manual Migration Sequence

Use the wrapper for production. When diagnosing in a controlled offline environment, the equivalent explicit sequence is:

```bash
umask 077
cd ~/imperial-court-bot
cd tsbot
npm ci
npm run config:check
cd ..
sudo systemctl stop imperial-court-bot
bash ./ops.sh validate
bash ./ops.sh backup
cd tsbot
npm run migrate
npm run db:check -- --require-current
npm run typecheck
(
  validation_dir="$(mktemp -d)"
  trap 'rm -rf -- "$validation_dir"' EXIT
  : >"$validation_dir/validation.env"
  ENV_FILE="$validation_dir/validation.env" DISCORD_TOKEN= DB_FILE="$validation_dir/test.db" npm test
)
npm run build
node --check dist/src/index.js
```

Record the exact validated `court-*.db` path printed by the manual backup command; unlike the rollout wrapper, its prefix is not `court-pre-migration`. Do not restart until every command succeeds. `npm run migrate` is transactional and idempotent: an already-current database is a verified no-op, and a failure must leave an exact v1 database intact.

## Expected v2 Database

Schema version 2 contains:

- `schema_migrations`
- `guilds`
- `guild_settings`
- `kv`
- `posts`
- `answers`
- `metrics`
- `anon_cooldowns`

Required logical primary keys are:

- `guilds(guild_id)` and `guild_settings(guild_id)`;
- `kv(guild_id, key)`;
- `posts(guild_id, message_id)`;
- `answers(guild_id, question_message_id, user_id)`;
- `metrics(guild_id, metric_key)`;
- `anon_cooldowns(guild_id, user_id)`.

Tenant tables reference `guilds(guild_id)`. Validation checks full `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, schema version 2, required keys, and guild-scoped indexes for open posts, question answers by date, answer-message lookup, and enabled guild selection.

Useful read-only checks are:

```bash
cd ~/imperial-court-bot/tsbot
npm run db:check -- --require-current

sqlite3 -readonly ../court.db "PRAGMA integrity_check;"
sqlite3 -readonly ../court.db "PRAGMA foreign_key_check;"
sqlite3 -readonly ../court.db ".tables"
```

An empty result from `foreign_key_check` is success. Do not dump `guild_settings.settings_json`, tenant rows, or `.env` into shared logs.

## Backups

Create an online SQLite-consistent backup:

```bash
cd ~/imperial-court-bot
bash ./ops.sh backup
```

The command:

- reads the configured `DB_FILE` without printing process values;
- validates the source;
- writes through SQLite's backup API to a unique partial path;
- validates the snapshot's schema and integrity;
- renames the file to its final `backups/court-*.db` name only after success.

The SQLite backup API provides a transactionally consistent online snapshot. The standalone backup command does not compare that snapshot with later live row counts because a legitimate concurrent write could make those counts differ. The offline deployment and restore safeguards do compare table counts while their source is stable.

If validation fails, the partial artifact is retained for operator inspection; it is never promoted over a valid backup. The script never expires or deletes backups. Apply any organizational retention policy separately and only after verifying which backups must remain available for rollback.

## Restore

Always validate the candidate first:

```bash
cd ~/imperial-court-bot
DRY_RUN=1 bash ./ops.sh restore ~/imperial-court-bot/backups/court-YYYYMMDD-HHMMSS.db
```

Then stop the service and restore:

```bash
sudo systemctl stop imperial-court-bot
bash ./ops.sh restore ~/imperial-court-bot/backups/court-YYYYMMDD-HHMMSS.db
```

By default, restore creates and validates a separate `court-pre-restore-*.db` backup of the current database first. It rejects an unknown or active systemd unit, uses SQLite restore, validates the restored integrity and schema, and compares required table counts with the source. It does not restart the service automatically. Safety flags accept only the literal values `0` or `1`; an invalid value aborts before any write.

After selecting the compatible application version, start and verify it:

```bash
sudo systemctl start imperial-court-bot
sudo systemctl status imperial-court-bot --no-pager
sudo journalctl -u imperial-court-bot -n 120 --no-pager
```

## Roll Back to Version 1

Never run the old binary against schema v2. To roll back:

1. Keep the service stopped and prevent any further database writes.
2. Identify the exact validated `court-pre-migration-*.db` created for the failed rollout, or the exact `court-*.db` path recorded during a manual migration; do not choose a file only because it sorts newest.
3. Run restore with `DRY_RUN=1` and confirm it is classified as a valid legacy-v1 database.
4. Restore that pre-migration backup while the service remains stopped.
5. Check out the previous known-good release, run `cd tsbot && npm ci`, rebuild with `npm run build`, and verify `node --check dist/src/index.js` so the old code uses its own locked dependency graph.
6. Restore the previous release's external systemd/environment configuration if it changed.
7. Start the previous release and verify logs and legacy behavior.

The order is essential: restore the v1 database before running the v1 application. Keep the v2 database and every backup for investigation; do not overwrite or delete them.

## Post-Migration Guild Health

After version 2 starts:

1. Confirm logs show global or development registration mode and command counts without secrets.
2. Allow time for Discord global-command propagation in production.
3. Run `/setup status` for the migrated legacy guild to review its enabled state, schedule summary, feature summary, bound channels, and configured staff count.
4. Run `/setup export` and privately inspect the complete persisted settings and guild data, including roles, limits, labels, triggers, schedules, greetings, and features. Protect the export because it contains guild data.
5. Run `/setup validate`, resolve any external Discord permission or hierarchy issue, and explicitly enable the guild if migration did not leave it enabled.
6. For at least two configured guilds, verify status, manual court behavior, independent question pools, metrics, timezone/date behavior, and log destinations.
7. Disable one test guild and confirm it has no message-trigger or background-job side effects while another enabled guild continues.
8. Review structured job errors by guild ID; a failure in one guild must not stop work for others.
9. Confirm the database remains at schema version 2 with `npm run db:check -- --require-current`.

Newly joined and rejoined guilds must remain disabled until setup is reviewed and enabled. Leaving a guild retains its data. Purge must be initiated by that guild's owner with exact confirmation.

## Command Registration and External Risks

Production uses application-global commands. Discord propagation is asynchronous and can take time; do not switch to guild registration or retain duplicate guild command sets as a quick fix. Development guild mode is only for configured `DEV_GUILD_IDS` and intentionally clears the global set.

Repository validation cannot prove external state such as:

- Discord Developer Portal intents, installation scopes, and bot permissions;
- bot role placement in each guild;
- global-command propagation time;
- systemd unit paths, environment-file permissions, user/group ownership, or host sandboxing;
- available disk space and off-host backup retention.

Treat these as deployment checks, not reasons to weaken runtime validation.

## Incident Checklist

1. Stop automated writes if database or migration safety is uncertain.
2. Inspect `systemctl status` and recent journal logs without dumping environment values.
3. Run `bash ./ops.sh validate` or `npm run db:check -- --require-current` read-only.
4. Identify affected guild IDs in structured logs and determine whether other guilds continue normally.
5. Preserve the live database, sidecars, and all backups before attempting recovery.
6. Restore only a validated, schema-compatible backup while the service is stopped.
