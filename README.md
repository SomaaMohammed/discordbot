# Imperial Court Bot

A themed Discord bot for running daily or manual **court inquiries** inside a server.

It posts discussion prompts, opens a dedicated thread for replies, lets members submit **anonymous answers** through a button + modal flow, auto-closes inquiry threads after a time window, and gives staff a decent set of moderation and reporting commands.

## What it does

- Posts rotating question prompts from JSON question banks
- Supports **manual**, **auto**, and **off** posting modes
- Creates a thread for each court inquiry
- Lets users answer through an **"Answer Anonymously"** button
- Tracks one anonymous answer per user per inquiry
- Can enforce anonymous-answer eligibility rules like:
  - minimum account age
  - minimum server membership age
  - required role
  - cooldowns
  - optional link blocking
- Auto-closes expired inquiry threads
- Generates staff-facing status, health, analytics, and weekly digest views
- Includes moderation/admin slash commands for purge, lock, slowmode, timeout, mass timeout, and more
- Stores bot state and activity in SQLite
- Includes CI, backup, and VM deployment scripts

## Command groups

### `/court`
Main bot controls for staff.

Examples:

- `/court status`
- `/court health`
- `/court analytics`
- `/court mode`
- `/court channel`
- `/court logchannel`
- `/court schedule`
- `/court post`
- `/court custom`
- `/court close`
- `/court reopen`
- `/court extend`
- `/court listopen`
- `/court exportstate`
- `/court importstate`
- `/court dryrun`
- `/court listcategories`
- `/court addquestion`
- `/court editquestion`
- `/court deletequestion`
- `/court resethistory`
- `/court removeanswer`

### `/questions`
Question-bank utilities.

- `/questions count`
- `/questions unused`
- `/questions audit`

### `/invictus`
Admin and moderation tools.

- `/invictus say`
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
- `/invictus afk`
- `/invictus afkstatus`
- `/invictus resetroyaltimer`
- `/invictus help`

### `/fun`
Public fun commands.

- `/fun battle`

## Question system

Questions live in `questions.json` and are grouped into five categories:

- `general`
- `gaming`
- `music`
- `hot-take`
- `chaos`

The bot avoids repeating recent questions and keeps track of used prompts. When the pool is exhausted, it resets the used-question list and starts cycling again.

## Anonymous answers

Each court post includes a persistent **Answer Anonymously** button.

When a member submits an answer:

- the bot opens or reuses the inquiry thread
- posts the answer as an embed inside the thread
- marks it anonymous
- prevents duplicate submissions for that same question
- records the answer in SQLite for analytics and retention handling

Anonymous answer rules are configurable through environment variables.

## Scheduling and automation

Background tasks handle the recurring work:

- **Auto poster** checks every minute and posts the scheduled question when the bot is in `auto` mode
- **Thread closer** checks open inquiries and locks/archive them after the configured window
- **Weekly digest** posts a summary embed on the configured weekday/hour
- **Retention cleaner** removes old answer records based on the configured retention period

## Storage

The bot uses **SQLite** for persistence.

Tables include:

- `kv` - JSON-backed state blobs and misc storage
- `posts` - inquiry post records
- `answers` - anonymous answer records
- `metrics` - command and activity metrics
- `anon_cooldowns` - cooldown tracking for anonymous answers

The repo also keeps JSON files for base content and state snapshots:

- `questions.json`
- `answers.json`
- `state.json`

## Project structure

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
