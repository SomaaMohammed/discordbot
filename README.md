# Imperial Court Bot

A Discord bot for running structured anonymous discussion prompts inside a server.

It posts rotating court inquiry questions, creates a thread for discussion, collects anonymous responses through a modal, and gives staff tools for scheduling, moderation, analytics, and thread lifecycle management.

## Features

- Posts rotating question prompts from JSON question banks
- Supports **manual**, **auto**, and **off** posting modes
- Creates a thread for each court inquiry
- Lets users answer through an **Answer Anonymously** button
- Tracks one anonymous answer per user per inquiry
- Can enforce anonymous-answer eligibility rules such as:
  - minimum account age
  - minimum server membership age
  - required role
  - cooldowns
  - optional link blocking
- Auto-closes expired inquiry threads
- Generates staff-facing status, health, analytics, and weekly digest views
- Includes moderation and admin slash commands
- Stores bot state and activity in SQLite
- Includes CI, backup, and VM deployment scripts

## How It Works

1. The bot posts a court inquiry prompt in the configured channel.
2. It creates a thread for discussion.
3. Members click **Answer Anonymously** and submit a response through a modal.
4. The bot posts the response anonymously in the thread.
5. Responses are stored for analytics, cooldowns, and retention handling.
6. The inquiry thread is automatically closed after the configured time window.

## Requirements

- Python 3.11+
- A Discord bot token
- A Discord server where the bot has the required permissions
- Required gateway intents enabled in the Discord Developer Portal if your setup depends on them

## Quick Start

```bash
git clone https://github.com/SomaaMohammed/discordbot.git
cd discordbot
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python bot.py
````

## Configuration

Create a `.env` file in the project root and set at least:

```env
DISCORD_TOKEN=your_bot_token
TEST_GUILD_ID=your_guild_id
COURT_CHANNEL_ID=your_channel_id
```

Common optional settings may include:

```env
LOG_CHANNEL_ID=0
TIMEZONE=Asia/Qatar
DB_FILE=court.db

STAFF_ROLE_IDS=
EMPEROR_ROLE_ID=0
EMPRESS_ROLE_ID=0
SILENT_LOCK_EXCLUDE_ROLES=
ROYAL_ALERT_CHANNEL_ID=0
UNDEFEATED_USER_ID=0

ANON_MIN_ACCOUNT_AGE_MINUTES=0
ANON_MIN_MEMBER_AGE_MINUTES=0
ANON_REQUIRED_ROLE_ID=0
ANON_COOLDOWN_SECONDS=0
ANON_ALLOW_LINKS=false

MUTEALL_TARGET_CAP=0
WEEKLY_DIGEST_CHANNEL_ID=0
WEEKLY_DIGEST_WEEKDAY=0
WEEKLY_DIGEST_HOUR=19
ANSWER_RETENTION_DAYS=90
```

Adjust values based on your server setup.

## Command Groups

### `/court`

Staff controls for scheduling, posting, lifecycle management, and reporting.

Examples:

* `/court status`
* `/court health`
* `/court analytics`
* `/court mode`
* `/court channel`
* `/court logchannel`
* `/court schedule`
* `/court post`
* `/court custom`
* `/court close`
* `/court reopen`
* `/court extend`
* `/court listopen`
* `/court exportstate`
* `/court importstate`
* `/court dryrun`
* `/court listcategories`
* `/court addquestion`
* `/court editquestion`
* `/court deletequestion`
* `/court resethistory`
* `/court removeanswer`

### `/questions`

Question-bank utilities.

* `/questions count`
* `/questions unused`
* `/questions audit`

### `/invictus`

Admin and moderation tools.

* `/invictus say`
* `/invictus purge`
* `/invictus purgeuser`
* `/invictus lock`
* `/invictus unlock`
* `/invictus slowmode`
* `/invictus timeout`
* `/invictus untimeout`
* `/invictus mutemany`
* `/invictus unmutemany`
* `/invictus muteall`
* `/invictus unmuteall`
* `/invictus afk`
* `/invictus afkstatus`
* `/invictus resetroyaltimer`
* `/invictus help`

### `/fun`

Public fun commands.

* `/fun battle`

## Question System

Questions live in `questions.json` and are grouped into categories such as:

* `general`
* `gaming`
* `music`
* `hot-take`
* `chaos`

The bot avoids repeating recent questions and keeps track of used prompts. When the pool is exhausted, it resets the used-question list and starts cycling again.

## Anonymous Answers

Each court post includes a persistent **Answer Anonymously** button.

When a member submits an answer, the bot:

* opens or reuses the inquiry thread
* posts the answer as an embed inside the thread
* marks it anonymous
* prevents duplicate submissions for the same inquiry
* records the answer in SQLite for analytics and retention handling

Anonymous answer rules are configurable through environment variables.

## Privacy Note

Anonymous answers are anonymous to regular server members in the inquiry thread.

Depending on your logging, database access, and admin tooling, server staff or bot operators may still be able to trace submissions at the storage level. Do not describe the system as fully untraceable unless that is actually true in your deployment.

## Scheduling and Automation

Background tasks handle recurring work:

* **Auto poster** checks on a schedule and posts the next inquiry when the bot is in `auto` mode
* **Thread closer** checks open inquiries and locks or archives them after the configured window
* **Weekly digest** posts a summary on the configured weekday and hour
* **Retention cleaner** removes old answer records based on the configured retention period

## Storage

The bot uses **SQLite** for persistence.

Tables include:

* `kv` — JSON-backed state blobs and miscellaneous storage
* `posts` — inquiry post records
* `answers` — anonymous answer records
* `metrics` — command and activity metrics
* `anon_cooldowns` — cooldown tracking for anonymous answers

The repo also uses JSON files for content and state snapshots:

* `questions.json`
* `answers.json`
* `state.json`

## Required Bot Permissions

Make sure the bot has the permissions it needs in your server, such as:

* View Channels
* Send Messages
* Read Message History
* Create Public Threads
* Send Messages in Threads
* Manage Threads
* Manage Messages
* Moderate Members

You may also need the appropriate application command scope when inviting the bot so slash commands register correctly.

## Project Structure

```text
.
├── .github/workflows/ci.yml
├── courtbot/
│   ├── config.py
│   └── storage_sql.py
├── tests/
│   └── test_bot_utils.py
├── answers.json
├── backup_db.sh
├── bot.py
├── deploy_vm.sh
├── post_pull_server.sh
├── pyproject.toml
├── pytest.ini
├── questions.json
├── requirements.txt
└── state.json
```

## Running the Bot

```bash
python bot.py
```

## Development

Run checks locally with:

```bash
ruff check .
mypy bot.py courtbot
pytest -q
```

CI is set up to run validation and quality checks automatically.

## Deployment

This repo includes helper scripts for server workflows:

* `deploy_vm.sh` — deploy updates to a VM and restart the bot service
* `post_pull_server.sh` — run post-pull checks and rollout steps
* `backup_db.sh` — create timestamped SQLite backups

Review these scripts before using them in production so they match your environment.

## Troubleshooting

### Slash commands are not showing up

Check the bot invite scopes, confirm the guild ID is correct, and make sure command sync is happening in the expected server.

### Bot starts but does nothing

Verify `DISCORD_TOKEN`, channel IDs, role IDs, and required permissions.

### Anonymous answers are not working

Check cooldown settings, required role settings, account age restrictions, member age restrictions, and whether links are allowed.

### Threads are not closing automatically

Check that background tasks are running and that the configured schedule or expiry window is valid.

### The bot cannot post in the target channel

Make sure the bot can view the channel, send messages, read history, and create threads.

## License

No license file is currently included in the repository.
