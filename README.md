# Imperial Court Bot

Imperial Court Bot is a Discord bot for running structured, anonymous community prompts with moderation controls, operational reporting, and server automation.

It is designed for a "court" style workflow:

1. Post a prompt as an Imperial Court inquiry.
2. Open or reuse a dedicated thread for responses.
3. Collect anonymous answers through a modal.
4. Track participation, moderation actions, and usage metrics.
5. Automatically close stale threads and publish digest/reporting data.

## What This Bot Does

- Posts rotating prompts from categorized question banks.
- Supports posting modes: `off`, `manual`, and `auto`.
- Creates one thread per inquiry for focused discussion.
- Provides anonymous answer collection with anti-abuse controls.
- Stores records in SQLite for durability and server restarts.
- Exposes staff/admin moderation and diagnostics commands.
- Runs background tasks for auto-posting, auto-closing, weekly digest, and data retention.
- Includes public "fun" commands and user activity metrics.

## Feature Breakdown

### Prompt and Thread System

- Categorized questions from `questions.json`.
- Rotation avoids immediate repeats using recent history + used pool tracking.
- Manual post and custom post options.
- Auto-generated embed with persistent answer button.
- One inquiry thread per post with close/reopen/extend controls.

### Anonymous Answers

- Modal-based submission through "Answer Anonymously".
- One answer per user per inquiry.
- Optional eligibility checks:
  - minimum account age
  - minimum server member age
  - required role
  - submission cooldown
  - optional link blocking
- Answer records stored in SQLite (`answers`, `anon_cooldowns`).

### Moderation and Administration

- Bulk timeout and untimeout tools with optional dry-run.
- Channel lock/unlock and slowmode controls.
- Purge and targeted purge tools.
- Announcement commands.
- Role panel tools for self-assign role messages.

### Health, Analytics, and Operations

- `/court status`, `/court health`, `/court analytics` for diagnostics.
- Weekly digest summary task.
- Retention cleaner task for old answer data.
- Structured metrics storage in SQLite (`metrics`).

### Fun and Community Layer

- Battle command plus imperial-themed fun commands.
- Public user metrics (`messages_sent`, reactions, battles, answers) exposed through `/fun stats` and `/fun leaderboard`.

## Tech Stack

- Python 3.11+
- discord.py
- SQLite
- python-dotenv
- Optional tzdata for timezone support

## Repository Layout

```text
.
├── bot.py
├── courtbot/
│   ├── config.py
│   └── storage_sql.py
├── tests/
│   └── test_bot_utils.py
├── questions.json
├── answers.json
├── state.json
├── requirements.txt
├── requirements-dev.txt
├── pyproject.toml
├── post_pull_server.sh
├── deploy_vm.sh
└── backup_db.sh
```

## Prerequisites

- Python 3.11 or newer
- A Discord application and bot token
- Bot installed in your server with proper intents/permissions
- For server rollout script: Linux host with `bash`, `sudo`, `systemd`, and `sqlite3`

## Install and Run Locally

### Linux/macOS

```bash
git clone https://github.com/SomaaMohammed/discordbot.git
cd discordbot
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python bot.py
```

### Windows (PowerShell)

```powershell
git clone https://github.com/SomaaMohammed/discordbot.git
cd discordbot
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python bot.py
```

## Dependency Files

- `requirements.txt`: runtime dependencies used in production.
- `requirements-dev.txt`: local/CI tooling (`pytest`, `ruff`, `mypy`) plus runtime deps.

## Environment Configuration

Create `.env` in the project root.

### Required Keys

| Key                | Purpose                                  |
| ------------------ | ---------------------------------------- |
| `DISCORD_TOKEN`    | Bot token from Discord Developer Portal  |
| `TEST_GUILD_ID`    | Guild ID for command sync and task scope |
| `COURT_CHANNEL_ID` | Default inquiry post channel             |

### Optional Core Keys

| Key              |      Default | Purpose                                |
| ---------------- | -----------: | -------------------------------------- |
| `LOG_CHANNEL_ID` |          `0` | Staff log channel (`0` disables)       |
| `TIMEZONE`       | `Asia/Qatar` | Timezone used for scheduling/reporting |
| `DB_FILE`        |   `court.db` | SQLite database path                   |
| `BOT_VERSION`    | package ver. | Optional release/build identifier      |

### Role and Royal Keys

| Key                         | Default | Purpose                                                |
| --------------------------- | ------: | ------------------------------------------------------ |
| `STAFF_ROLE_IDS`            |   empty | Comma-separated role IDs allowed for `/court` commands |
| `EMPEROR_ROLE_ID`           |     `0` | Emperor role ID                                        |
| `EMPRESS_ROLE_ID`           |     `0` | Empress role ID                                        |
| `SILENT_LOCK_EXCLUDE_ROLES` |   empty | Roles excluded from silent lock behavior               |
| `ROYAL_ALERT_CHANNEL_ID`    |     `0` | Channel that triggers royal response behavior          |
| `UNDEFEATED_USER_ID`        |     `0` | User ID that always wins `/fun battle`                 |

### Anonymous Answer Guardrails

| Key                            | Default | Purpose                                        |
| ------------------------------ | ------: | ---------------------------------------------- |
| `ANON_MIN_ACCOUNT_AGE_MINUTES` |     `0` | Minimum account age to submit anonymous answer |
| `ANON_MIN_MEMBER_AGE_MINUTES`  |     `0` | Minimum guild membership age                   |
| `ANON_REQUIRED_ROLE_ID`        |     `0` | Required role for anonymous answer eligibility |
| `ANON_COOLDOWN_SECONDS`        |     `0` | Minimum time between anonymous submissions     |
| `ANON_ALLOW_LINKS`             | `false` | Whether links are allowed in anonymous answers |

### Operations and Retention

| Key                        | Default | Purpose                                                 |
| -------------------------- | ------: | ------------------------------------------------------- |
| `MUTEALL_TARGET_CAP`       |     `0` | Safety cap for mass timeout commands (`0` = unlimited)  |
| `WEEKLY_DIGEST_CHANNEL_ID` |     `0` | Override digest channel (`0` falls back to log channel) |
| `WEEKLY_DIGEST_WEEKDAY`    |     `0` | Digest weekday (`0` = Monday in Python weekday scale)   |
| `WEEKLY_DIGEST_HOUR`       |    `19` | Digest posting hour                                     |
| `ANSWER_RETENTION_DAYS`    |    `90` | Days before old answer records are purged               |

## Access and Permission Model

- `/court` and `/questions`: staff (staff role IDs) or admins.
- `/invictus` moderation/admin commands: Discord administrators only.
- `/invictus afk`: Emperor/Empress roles only.
- `/fun` and `/greetings`: public commands.

## Command Reference

### `/court`

Scheduling, posting, state management, and diagnostics.

- `status`
- `health`
- `analytics`
- `dryrun`
- `exportstate`
- `importstate`
- `mode`
- `channel`
- `logchannel`
- `schedule`
- `listcategories`
- `addquestion`
- `deletequestion`
- `editquestion`
- `resethistory`
- `post`
- `custom`
- `close`
- `listopen`
- `extend`
- `reopen`
- `removeanswer`

### `/questions`

Question bank utilities.

- `count`
- `unused`
- `audit`

### `/invictus`

Admin moderation and utility controls.

- `say`
- `rolepanel`
- `rolepanelmulti`
- `purge`
- `purgeuser`
- `lock`
- `unlock`
- `slowmode`
- `timeout`
- `untimeout`
- `mutemany`
- `unmutemany`
- `muteall`
- `unmuteall`
- `backfillstats`
- `backfillstatus`
- `afk`
- `afkstatus`
- `resetroyaltimer`
- `help`

### `/fun`

Public social commands.

- `battle`
- `stats`
- `leaderboard`
- `verdict`
- `title`
- `fate`

Note: `messages_sent`, `reactions_sent`, and `reactions_received` can be backfilled from historical channel history with `/invictus backfillstats`. Check run progress and last result with `/invictus backfillstatus`.

Backfill observability:

- Backfill emits `Started`, `Complete`, `Failed`, and `Interrupted` log entries.
- If `LOG_CHANNEL_ID` is not configured or unavailable, backfill logs fall back to the channel where `/invictus backfillstats` was triggered.

### `/greetings`

- `rio`
- `taylor`

## Data and Storage

### SQLite Tables

| Table            | Purpose                                       |
| ---------------- | --------------------------------------------- |
| `kv`             | JSON blobs and core state persistence         |
| `posts`          | Inquiry post records and lifecycle fields     |
| `answers`        | Anonymous answer records                      |
| `metrics`        | Command usage and activity counters           |
| `anon_cooldowns` | Per-user anonymous answer cooldown timestamps |

### SQL Indexes

The storage module defines indexes used to speed up high-frequency queries:

- `idx_posts_closed_posted_at`
- `idx_answers_question_created`
- `idx_answers_message_id`

### JSON Files

- `questions.json`: question source bank.
- `answers.json`: legacy data compatibility pathway.
- `state.json`: scheduler/history flags (with structured data synthesized from SQLite).

## Scheduled Background Tasks

- `auto_poster` (every minute): posts automatically when mode/schedule conditions match.
- `thread_closer` (every 10 minutes): closes expired open inquiry threads.
- `weekly_digest` (every 30 minutes): sends weekly summary once per configured week.
- `retention_cleaner` (every 24 hours): purges answers older than retention threshold.

## Required Discord Permissions

At minimum, ensure the bot can:

- View Channels
- Send Messages
- Read Message History
- Embed Links
- Create Public Threads
- Send Messages in Threads
- Manage Threads
- Manage Messages
- Moderate Members
- Manage Roles (for role panel features)

Also ensure the invite includes the `applications.commands` scope so slash commands register.

## Development Workflow

Install dev tooling and run checks:

```bash
pip install -r requirements-dev.txt
ruff check .
mypy bot.py courtbot
pytest -q
```

Optional quick compile smoke test:

```bash
python -m py_compile bot.py
```

## Deployment

This repository includes deployment helpers:

- `deploy_server.sh` (recommended all-in-one server deploy)
- `deploy_vm.sh`
- `post_pull_server.sh`
- `backup_db.sh`

### One Command Server Deploy (`deploy_server.sh`) - Recommended

```bash
cd /path/to/imperial-court-bot
chmod +x deploy_server.sh
RUN_TESTS=1 RUN_LINT=1 ./deploy_server.sh main
```

What this script does:

- Handles local git changes using `LOCAL_CHANGES_POLICY` (`abort`, `stash`, `discard`).
- Pulls latest code from the selected branch.
- Runs `post_pull_server.sh` for dependency install, compile checks, optional lint/tests, DB checks, and service restart.

Useful options:

- `LOCAL_CHANGES_POLICY=stash` to auto-stash local edits before pull.
- `SKIP_PULL=1` to run rollout checks/restart only on current checkout.

### Recommended Server Rollout (`post_pull_server.sh`)

```bash
cd /path/to/imperial-court-bot
git pull --ff-only
chmod +x post_pull_server.sh
RUN_TESTS=1 RUN_LINT=1 ./post_pull_server.sh
```

What the script does:

- Validates required commands and files.
- Ensures required `.env` keys exist.
- Applies default values for optional env keys.
- Backs up the existing SQLite DB (if present).
- Installs runtime dependencies.
- Installs dev dependencies when lint/tests are enabled.
- Runs compile check and storage warm-up.
- Optionally runs lint/type/test checks.
- Restarts the systemd service and validates active status.
- Verifies expected SQLite tables exist after rollout.
- Prints service status and recent logs.

### `deploy_vm.sh` and Local Change Policy

`deploy_vm.sh` now checks for local git changes before pulling updates.

Supported behavior is controlled by `LOCAL_CHANGES_POLICY`:

- `abort` (default): stop and print recovery options.
- `stash`: auto-stash local changes, then continue deployment.
- `discard`: hard reset and clean untracked files, then continue (destructive).

Examples:

```bash
./deploy_vm.sh
LOCAL_CHANGES_POLICY=stash ./deploy_vm.sh
LOCAL_CHANGES_POLICY=discard ./deploy_vm.sh   # destructive
```

If deployment fails with "local changes would be overwritten by merge", run:

```bash
git status --short
git stash push -u -m "pre-deploy stash"
./deploy_vm.sh
```

## Observability and Safety Notes

- Anonymous answers are anonymous to regular users in-thread, but operators with DB/log access can still correlate metadata.
- Moderation commands are intentionally guarded by role/admin checks in code.
- Metrics include both operational command counters and user-facing fun activity counters.
- Runtime version tracking is available via `BOT_VERSION` (optional). If unset, the package version is used.
- `/court status` and startup logs include the effective bot version for deployment traceability.

## Troubleshooting

### Slash commands do not appear

- Verify bot invite scopes include `applications.commands`.
- Confirm `TEST_GUILD_ID` is correct.
- Confirm bot started and synced commands successfully.

### Bot starts but does not post

- Verify `DISCORD_TOKEN`, guild/channel IDs, and channel permissions.
- Check `/court mode` and `/court schedule`.
- Run `/court health` to inspect task and permission state.

### Anonymous answers fail

- Check account/member age requirements.
- Check required role and cooldown settings.
- Check whether links are blocked by config.

### Auto-close does not trigger

- Ensure the thread closer loop is running (`/court health`).
- Confirm post records exist and are marked open.

### Deployment script fails

- Read `journalctl -u <service> -n 120 --no-pager` output.
- Confirm service name and app paths in env overrides.
- Confirm server has `sudo`, `systemd`, and `sqlite3`.

## License

No license file is currently included in this repository.
