import asyncio
import io
import json
import logging
import os
import random
import re
import sqlite3
from collections import defaultdict
from threading import RLock
from difflib import SequenceMatcher
from datetime import datetime, timedelta, timezone
from typing import Callable, Coroutine
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import discord
from discord import app_commands
from discord.ext import commands, tasks
from dotenv import load_dotenv

from courtbot.config import load_runtime_config
from courtbot.storage_sql import (
    ANON_COOLDOWNS_TABLE_SQL,
    ANSWERS_TABLE_SQL,
    ANSWERS_MESSAGE_ID_INDEX_SQL,
    ANSWERS_QUESTION_CREATED_INDEX_SQL,
    KV_TABLE_SQL,
    METRICS_TABLE_SQL,
    POSTS_TABLE_SQL,
    POSTS_CLOSED_POSTED_AT_INDEX_SQL,
)

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)
TOKEN = os.getenv("DISCORD_TOKEN")
RUNTIME_CONFIG = load_runtime_config()
TEST_GUILD_ID = RUNTIME_CONFIG.test_guild_id
COURT_CHANNEL_ID = RUNTIME_CONFIG.court_channel_id
LOG_CHANNEL_ID_ENV = RUNTIME_CONFIG.log_channel_id
TIMEZONE_NAME = RUNTIME_CONFIG.timezone_name

# Roles allowed to control the bot
STAFF_ROLE_IDS = RUNTIME_CONFIG.staff_role_ids
EMPEROR_ROLE_ID = RUNTIME_CONFIG.emperor_role_id
EMPRESS_ROLE_ID = RUNTIME_CONFIG.empress_role_id

STATE_FILE = "state.json"
QUESTIONS_FILE = "questions.json"
ANSWERS_FILE = "answers.json"
DB_FILE = os.getenv("DB_FILE", "court.db")

STORAGE_JSON_KEYS = {
    STATE_FILE: "state",
    QUESTIONS_FILE: "questions",
    ANSWERS_FILE: "answers",
}

ROLE_COLOR = 0x000000  # black
HISTORY_LIMIT = 50
POST_RECORD_LIMIT = 100
THREAD_CLOSE_HOURS = 24
THREAD_AUTO_ARCHIVE_MINUTES = 1440
MAX_TIMEOUT_MINUTES = 40320
REPLY_MUTE_MINUTES = 1
SILENT_LOCK_SECONDS = 10
SILENT_LOCK_EXCLUDE_ROLES = RUNTIME_CONFIG.silent_lock_exclude_roles
EMPEROR_MENTION_RESPONSE = "He's always watching."
ROYAL_PRESENCE_INTERVAL_HOURS = 3
ROYAL_ALERT_CHANNEL_ID = RUNTIME_CONFIG.royal_alert_channel_id
ROYAL_TITLES = ("Emperor", "Empress")
ANON_MIN_ACCOUNT_AGE_MINUTES = RUNTIME_CONFIG.anon_min_account_age_minutes
ANON_MIN_MEMBER_AGE_MINUTES = RUNTIME_CONFIG.anon_min_member_age_minutes
ANON_REQUIRED_ROLE_ID = RUNTIME_CONFIG.anon_required_role_id
ANON_COOLDOWN_SECONDS = RUNTIME_CONFIG.anon_cooldown_seconds
ANON_ALLOW_LINKS = RUNTIME_CONFIG.anon_allow_links
MUTEALL_TARGET_CAP = RUNTIME_CONFIG.muteall_target_cap
WEEKLY_DIGEST_CHANNEL_ID = RUNTIME_CONFIG.weekly_digest_channel_id
WEEKLY_DIGEST_WEEKDAY = RUNTIME_CONFIG.weekly_digest_weekday
WEEKLY_DIGEST_HOUR = RUNTIME_CONFIG.weekly_digest_hour
ANSWER_RETENTION_DAYS = RUNTIME_CONFIG.answer_retention_days
REPLY_MUTE_ACTION_PATTERN = r"(?:mute|silence|timeout|quiet|hush)"
REPLY_MUTE_INTENT_PATTERN = r"(?:you\s+know\s+what\s+to\s+do|u\s+know\s+what\s+to\s+do|do\s+your\s+thing|handle\s+this)"
REPLY_MUTE_PATTERNS = (
    re.compile(rf"^\s*(?:hey|yo|oi)[\s,]+invictus[\s,:-]+{REPLY_MUTE_ACTION_PATTERN}\b(.*)$", re.IGNORECASE),
    re.compile(rf"^\s*invictus[\s,:-]+{REPLY_MUTE_ACTION_PATTERN}\b(.*)$", re.IGNORECASE),
    re.compile(rf"^\s*(?:hey|yo|oi)[\s,]+invictus[\s,:-]+{REPLY_MUTE_INTENT_PATTERN}\b(?:[\s,:-]*(.*))$", re.IGNORECASE),
    re.compile(rf"^\s*invictus[\s,:-]+{REPLY_MUTE_INTENT_PATTERN}\b(?:[\s,:-]*(.*))$", re.IGNORECASE),
)
SILENCE_LOCK_PHRASES = {
    "silence",
    "silence now",
    "silence the court",
    "court silence",
    "order in the court",
}
EMPEROR_LOCK_PHRASES = {
    "the emperor is here",
    "emperor is here",
    "the emperor has arrived",
    "emperor has arrived",
    "make way for the emperor",
    "all rise for the emperor",
}
EMPEROR_MENTION_PATTERN = re.compile(r"\b(sammy|emperor|his majesty|your majesty)\b", re.IGNORECASE)
EMPRESS_MENTION_PATTERN = re.compile(r"\b(empress|her majesty|tay|taytay|taylor|tayla)\b", re.IGNORECASE)
URL_PATTERN = re.compile(r"https?://|discord\.gg/", re.IGNORECASE)
ROLE_PANEL_BUTTON_CUSTOM_ID = "court:role_panel_claim"
ROLE_PANEL_FOOTER_PREFIX = "RolePanelTarget:"
ROLE_PANEL_TARGETS_FOOTER_PREFIX = "RolePanelTargets:"
ROLE_PANEL_ROLE_ID_PATTERN = re.compile(r"^RolePanelTarget:(\d+)$")
ROLE_PANEL_DEFAULT_BUTTON_LABEL = "Claim Role"
ROLE_PANEL_BUTTON_LABEL_MAX_LENGTH = 80
ROLE_PANEL_MAX_BUTTONS = 5

USER_METRIC_PREFIX = "user_stats."
USER_FUN_METRIC_FIELDS: tuple[tuple[str, str], ...] = (
    ("messages_sent", "Messages Sent"),
    ("reactions_sent", "Reactions Sent"),
    ("reactions_received", "Reactions Received"),
    ("anonymous_answers_sent", "Anonymous Answers"),
    ("battles_played", "Battles Played"),
    ("battles_won", "Battles Won"),
)
USER_FUN_METRIC_LABELS = dict(USER_FUN_METRIC_FIELDS)
USER_FUN_LEADERBOARD_CHOICES = [
    app_commands.Choice(name="Messages Sent", value="messages_sent"),
    app_commands.Choice(name="Reactions Sent", value="reactions_sent"),
    app_commands.Choice(name="Reactions Received", value="reactions_received"),
    app_commands.Choice(name="Anonymous Answers", value="anonymous_answers_sent"),
    app_commands.Choice(name="Battles Played", value="battles_played"),
    app_commands.Choice(name="Battles Won", value="battles_won"),
]

MSG_USE_IN_SERVER = "Use this inside the server."
MSG_USE_TEXT_CHANNEL = "Use this command inside a text channel."
MSG_BOT_CONTEXT_ERROR = "Could not verify bot permissions in this server."
MSG_CONFIRM_REQUIRED = "Confirmation failed. Type `CONFIRM` exactly."
MSG_VERIFY_ROLES = "Could not verify your roles."
MSG_ADMIN_ONLY = "Only server administrators can use this command."
MSG_ROYAL_ONLY = "Only the Emperor or Empress can use this command."
MSG_EVERYONE_MENTION = "@everyone"
MSG_INQUIRY_CLOSED = "This court inquiry is already closed."
MSG_QUESTION_EMPTY = "Question cannot be empty."
MSG_UNKNOWN_QUESTION = "Unknown question"
PREVIEW_ISSUES_PREFIX = "\n\nPreview issues:\n"

CATEGORY_DESCRIPTIONS = {
    "general": "Broad prompts for everyday discussion.",
    "gaming": "Games, consoles, mechanics, franchises, and hot gaming opinions.",
    "music": "Songs, artists, albums, genres, and music takes.",
    "hot-take": "Controversial opinions and spicy takes.",
    "chaos": "Funny, dumb, cursed, and unhinged prompts.",
}

CATEGORY_CHOICES = [
    app_commands.Choice(name="general", value="general"),
    app_commands.Choice(name="gaming", value="gaming"),
    app_commands.Choice(name="music", value="music"),
    app_commands.Choice(name="hot-take", value="hot-take"),
    app_commands.Choice(name="chaos", value="chaos"),
]

# Special user ID that always wins boss battles
UNDEFEATED_USER_ID = RUNTIME_CONFIG.undefeated_user_id
RIO_USER_ID = 1206572825100685365
TAYLOR_USER_ID = 661069422869610537

STATE_WRITE_LOCK = RLock()
USER_METRICS_BACKFILL_LOCK = asyncio.Lock()
BACKGROUND_TASKS: set[asyncio.Task[None]] = set()
USER_METRICS_BACKFILL_STATE: dict[str, object | None] = {
    "running": False,
    "started_at": None,
    "lookback_days": None,
    "initiated_by_user_id": None,
    "last_started_at": None,
    "last_completed_at": None,
    "last_status": "never",
    "last_summary": None,
    "last_error": None,
}

BOSS_STATS = [
    "Strength",
    "Speed",
    "Wisdom",
    "Charisma",
    "Luck",
    "Endurance",
]
IMPERIAL_VERDICTS = (
    "Approved. The throne nods in your favor.",
    "Denied. The court demands stronger resolve.",
    "Delayed. Return once your allies are prepared.",
    "Conditionally approved. Pay your debts before dawn.",
    "Accepted. Proceed, but carry steel and patience.",
    "Rejected. Fate advises a different road.",
)
IMPERIAL_TITLES = (
    "Warden of the Iron Gate",
    "Keeper of Midnight Oaths",
    "High Marshal of Courtly Chaos",
    "Bearer of the Black Standard",
    "Chancellor of Loud Opinions",
    "Sovereign of Unhinged Takes",
    "Archivist of Forbidden Memes",
    "Champion of the Inner Court",
)
IMPERIAL_OMENS = (
    "A quiet hallway means someone already heard your plan.",
    "Steel sings only for those who laugh first.",
    "When candles bend, old rivals wake.",
    "The loudest boast usually hides the weakest shield.",
    "Tonight favors bold words and careful exits.",
    "A sealed letter is worth more than ten promises.",
)

def validate_runtime_config() -> None:
    if not TOKEN:
        raise RuntimeError("DISCORD_TOKEN is missing in .env")
    if not TEST_GUILD_ID:
        raise RuntimeError("TEST_GUILD_ID is missing in .env")
    if not COURT_CHANNEL_ID:
        raise RuntimeError("COURT_CHANNEL_ID is missing in .env")


def get_db_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with get_db_connection() as conn:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.execute(KV_TABLE_SQL)
        conn.execute(POSTS_TABLE_SQL)
        conn.execute(ANSWERS_TABLE_SQL)
        conn.execute(METRICS_TABLE_SQL)
        conn.execute(ANON_COOLDOWNS_TABLE_SQL)
        conn.execute(POSTS_CLOSED_POSTED_AT_INDEX_SQL)
        conn.execute(ANSWERS_QUESTION_CREATED_INDEX_SQL)
        conn.execute(ANSWERS_MESSAGE_ID_INDEX_SQL)


def db_has_key(key: str) -> bool:
    with get_db_connection() as conn:
        row = conn.execute("SELECT 1 FROM kv WHERE key = ?", (key,)).fetchone()
    return row is not None


def db_get_json(key: str, default: dict) -> dict:
    with get_db_connection() as conn:
        row = conn.execute("SELECT value FROM kv WHERE key = ?", (key,)).fetchone()

    if row is None:
        db_set_json(key, default)
        return default

    try:
        return json.loads(row["value"])
    except (json.JSONDecodeError, TypeError):
        db_set_json(key, default)
        return default


def db_set_json(key: str, data: dict) -> None:
    payload = json.dumps(data, ensure_ascii=False, indent=2)
    now = iso_now()
    with get_db_connection() as conn:
        conn.execute(
            """
            INSERT INTO kv (key, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at
            """,
            (key, payload, now),
        )


def metrics_set(key: str, value: str | int) -> None:
    with get_db_connection() as conn:
        conn.execute(
            """
            INSERT INTO metrics (metric_key, metric_value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(metric_key) DO UPDATE SET
                metric_value = excluded.metric_value,
                updated_at = excluded.updated_at
            """,
            (key, str(value), iso_now()),
        )


def metrics_get(key: str, default: str | int = "0") -> str:
    with get_db_connection() as conn:
        row = conn.execute("SELECT metric_value FROM metrics WHERE metric_key = ?", (key,)).fetchone()
    if row is None:
        return str(default)
    return str(row["metric_value"])


def metrics_increment(key: str, amount: int = 1) -> int:
    current_value = int(metrics_get(key, 0)) + amount
    metrics_set(key, current_value)
    return current_value


def metrics_get_prefixed(prefix: str) -> dict[str, int]:
    with get_db_connection() as conn:
        rows = conn.execute(
            "SELECT metric_key, metric_value FROM metrics WHERE metric_key LIKE ?",
            (f"{prefix}%",),
        ).fetchall()

    result: dict[str, int] = {}
    for row in rows:
        key = str(row["metric_key"])
        suffix = key.removeprefix(prefix)
        if suffix:
            result[suffix] = int(row["metric_value"])
    return result


def build_user_metric_key(user_id: int | str, metric_name: str) -> str:
    return f"{USER_METRIC_PREFIX}{int(user_id)}.{metric_name}"


def parse_user_id_from_metric_key(metric_key: str, metric_name: str) -> int | None:
    prefix = USER_METRIC_PREFIX
    suffix = f".{metric_name}"

    if not metric_key.startswith(prefix) or not metric_key.endswith(suffix):
        return None

    user_id_raw = metric_key[len(prefix) : -len(suffix)]
    if not user_id_raw.isdigit():
        return None

    return int(user_id_raw)


def increment_user_metric(user_id: int | str, metric_name: str, amount: int = 1) -> int:
    return metrics_increment(build_user_metric_key(user_id, metric_name), amount=amount)


def get_user_fun_metrics(user_id: int | str) -> dict[str, int]:
    return {
        metric_name: int(metrics_get(build_user_metric_key(user_id, metric_name), 0))
        for metric_name, _label in USER_FUN_METRIC_FIELDS
    }


def list_top_users_for_metric(metric_name: str, limit: int = 5) -> list[tuple[int, int]]:
    with get_db_connection() as conn:
        rows = conn.execute(
            "SELECT metric_key, metric_value FROM metrics WHERE metric_key LIKE ?",
            (f"{USER_METRIC_PREFIX}%.{metric_name}",),
        ).fetchall()

    ranked: list[tuple[int, int]] = []
    for row in rows:
        metric_key = str(row["metric_key"])
        user_id = parse_user_id_from_metric_key(metric_key, metric_name)
        if user_id is None:
            continue

        try:
            metric_value = int(row["metric_value"])
        except (TypeError, ValueError):
            continue

        if metric_value > 0:
            ranked.append((user_id, metric_value))

    ranked.sort(key=lambda item: item[1], reverse=True)
    return ranked[: max(1, int(limit))]


def merge_user_metric_backfill(scanned_counts: dict[int, int], metric_name: str) -> tuple[int, int]:
    users_seen = 0
    updated = 0

    for user_id, scanned_value in scanned_counts.items():
        value = int(scanned_value)
        if value <= 0:
            continue

        users_seen += 1
        metric_key = build_user_metric_key(user_id, metric_name)
        existing_value = int(metrics_get(metric_key, 0))
        merged_value = max(existing_value, value)
        if merged_value > existing_value:
            metrics_set(metric_key, merged_value)
            updated += 1

    return users_seen, updated


def backfill_lookback_text(lookback_days: int | None) -> str:
    if lookback_days is None or int(lookback_days) <= 0:
        return "all available history"
    return f"last {int(lookback_days)} day(s)"


def get_backfill_status_snapshot() -> dict[str, object | None]:
    return dict(USER_METRICS_BACKFILL_STATE)


def mark_backfill_started(initiated_by_user_id: int | str, lookback_days: int) -> None:
    started_at = iso_now()
    USER_METRICS_BACKFILL_STATE["running"] = True
    USER_METRICS_BACKFILL_STATE["started_at"] = started_at
    USER_METRICS_BACKFILL_STATE["lookback_days"] = int(lookback_days)
    USER_METRICS_BACKFILL_STATE["initiated_by_user_id"] = str(initiated_by_user_id)
    USER_METRICS_BACKFILL_STATE["last_started_at"] = started_at
    USER_METRICS_BACKFILL_STATE["last_status"] = "running"
    USER_METRICS_BACKFILL_STATE["last_summary"] = None
    USER_METRICS_BACKFILL_STATE["last_error"] = None


def mark_backfill_finished(status: str, summary: str | None = None, error: str | None = None) -> None:
    USER_METRICS_BACKFILL_STATE["running"] = False
    USER_METRICS_BACKFILL_STATE["started_at"] = None
    USER_METRICS_BACKFILL_STATE["last_completed_at"] = iso_now()
    USER_METRICS_BACKFILL_STATE["last_status"] = status
    USER_METRICS_BACKFILL_STATE["last_summary"] = summary
    USER_METRICS_BACKFILL_STATE["last_error"] = error


def format_iso_as_discord_time(value: str | None) -> str:
    parsed = parse_iso(value)
    if parsed is None:
        return "Not available"

    timestamp = int(parsed.timestamp())
    return f"<t:{timestamp}:F> (<t:{timestamp}:R>)"


def build_backfill_status_embed(snapshot: dict[str, object | None]) -> discord.Embed:
    running = bool(snapshot.get("running", False))
    lookback_days = snapshot.get("lookback_days")
    initiated_by_user_id = str(snapshot.get("initiated_by_user_id") or "")
    initiated_by_text = f"<@{initiated_by_user_id}>" if initiated_by_user_id else "Unknown"

    state_text = "running" if running else str(snapshot.get("last_status") or "idle")

    embed = discord.Embed(
        title="User Stats Backfill Status",
        description=f"**State:** `{state_text}`",
        color=ROLE_COLOR,
        timestamp=get_now(),
    )

    embed.add_field(
        name="Lookback",
        value=backfill_lookback_text(lookback_days if isinstance(lookback_days, int) else None),
        inline=True,
    )
    embed.add_field(name="Initiated By", value=initiated_by_text, inline=True)

    started_at_text = format_iso_as_discord_time(str(snapshot.get("started_at") or ""))
    last_started_text = format_iso_as_discord_time(str(snapshot.get("last_started_at") or ""))
    last_completed_text = format_iso_as_discord_time(str(snapshot.get("last_completed_at") or ""))

    if running:
        embed.add_field(name="Started", value=started_at_text, inline=False)
    else:
        embed.add_field(name="Last Started", value=last_started_text, inline=False)
        embed.add_field(name="Last Completed", value=last_completed_text, inline=False)

    last_summary = str(snapshot.get("last_summary") or "")
    if last_summary:
        embed.add_field(name="Last Summary", value=last_summary[:1000], inline=False)

    last_error = str(snapshot.get("last_error") or "")
    if last_error:
        embed.add_field(name="Last Error", value=last_error[:1000], inline=False)

    return embed


def start_background_task(coro: Coroutine[object, object, None]) -> None:
    task = asyncio.create_task(coro)
    BACKGROUND_TASKS.add(task)
    task.add_done_callback(BACKGROUND_TASKS.discard)


def get_backfill_after_datetime(lookback_days: int) -> datetime | None:
    if lookback_days <= 0:
        return None
    return datetime.now(timezone.utc) - timedelta(days=lookback_days)


def get_history_kwargs(after_dt: datetime | None) -> dict[str, object]:
    kwargs: dict[str, object] = {"limit": None}
    if after_dt is not None:
        kwargs["after"] = after_dt
    return kwargs


def get_non_bot_user_id(user: object | None) -> int | None:
    if user is None or getattr(user, "bot", False):
        return None

    user_id = int(getattr(user, "id", 0) or 0)
    if user_id <= 0:
        return None
    return user_id


def get_backfill_history_targets(guild: discord.Guild) -> list[discord.TextChannel | discord.Thread]:
    targets: list[discord.TextChannel | discord.Thread] = []
    seen_ids: set[int] = set()

    for channel in guild.text_channels:
        if channel.id not in seen_ids:
            targets.append(channel)
            seen_ids.add(channel.id)

    for thread in guild.threads:
        if thread.id not in seen_ids:
            targets.append(thread)
            seen_ids.add(thread.id)

    return targets


async def tally_reaction_counts_for_message(
    message: discord.Message,
    reactions_sent_counts: dict[int, int],
    reactions_received_counts: dict[int, int],
) -> int:
    async def count_reactors_for_reaction(reaction: discord.Reaction) -> int:
        non_bot_reactors_local = 0
        async for reactor in reaction.users(limit=None):
            reactor_id = get_non_bot_user_id(reactor)
            if reactor_id is None:
                continue

            reactions_sent_counts[reactor_id] += 1
            non_bot_reactors_local += 1
        return non_bot_reactors_local

    scanned_reactions = 0
    recipient_id = get_non_bot_user_id(message.author)

    for reaction in message.reactions:
        try:
            non_bot_reactors = await count_reactors_for_reaction(reaction)
        except (discord.Forbidden, discord.HTTPException):
            continue

        scanned_reactions += non_bot_reactors
        if recipient_id is not None and non_bot_reactors > 0:
            reactions_received_counts[recipient_id] += non_bot_reactors

    return scanned_reactions


async def scan_backfill_history_target(
    target: discord.TextChannel | discord.Thread,
    after_dt: datetime | None,
    message_counts: dict[int, int],
    reactions_sent_counts: dict[int, int],
    reactions_received_counts: dict[int, int],
) -> tuple[int, int]:
    scanned_messages = 0
    scanned_reactions = 0

    async for message in target.history(**get_history_kwargs(after_dt)):
        scanned_messages += 1
        message_author_id = get_non_bot_user_id(message.author)
        if message_author_id is not None:
            message_counts[message_author_id] += 1

        scanned_reactions += await tally_reaction_counts_for_message(
            message,
            reactions_sent_counts,
            reactions_received_counts,
        )

    return scanned_messages, scanned_reactions


async def backfill_user_activity_metrics(guild: discord.Guild, lookback_days: int = 0) -> dict[str, int]:
    after_dt = get_backfill_after_datetime(lookback_days)

    message_counts: dict[int, int] = defaultdict(int)
    reactions_sent_counts: dict[int, int] = defaultdict(int)
    reactions_received_counts: dict[int, int] = defaultdict(int)

    scanned_channels = 0
    skipped_channels = 0
    scanned_messages = 0
    scanned_reactions = 0

    for target in get_backfill_history_targets(guild):
        scanned_channels += 1
        try:
            channel_messages, channel_reactions = await scan_backfill_history_target(
                target,
                after_dt,
                message_counts,
                reactions_sent_counts,
                reactions_received_counts,
            )
            scanned_messages += channel_messages
            scanned_reactions += channel_reactions
        except (discord.Forbidden, discord.HTTPException):
            skipped_channels += 1
            continue

    message_users_seen, message_updates = merge_user_metric_backfill(dict(message_counts), "messages_sent")
    reaction_sent_users_seen, reaction_sent_updates = merge_user_metric_backfill(
        dict(reactions_sent_counts),
        "reactions_sent",
    )
    reaction_received_users_seen, reaction_received_updates = merge_user_metric_backfill(
        dict(reactions_received_counts),
        "reactions_received",
    )

    return {
        "scanned_channels": scanned_channels,
        "skipped_channels": skipped_channels,
        "scanned_messages": scanned_messages,
        "scanned_reactions": scanned_reactions,
        "message_users_seen": message_users_seen,
        "reaction_sent_users_seen": reaction_sent_users_seen,
        "reaction_received_users_seen": reaction_received_users_seen,
        "message_updates": message_updates,
        "reaction_sent_updates": reaction_sent_updates,
        "reaction_received_updates": reaction_received_updates,
    }


async def run_user_activity_backfill(
    guild: discord.Guild,
    initiated_by: discord.Member | discord.User,
    lookback_days: int,
) -> None:
    async with USER_METRICS_BACKFILL_LOCK:
        initiator_id = int(getattr(initiated_by, "id", 0) or 0)
        mark_backfill_started(initiator_id, lookback_days)

        started_at = get_now()
        lookback_text = backfill_lookback_text(lookback_days)

        try:
            result = await backfill_user_activity_metrics(guild, lookback_days=lookback_days)
        except Exception as error:
            mark_backfill_finished(
                "failed",
                error=f"{type(error).__name__}: {str(error)[:400]}",
            )
            await send_failure_alert(
                guild,
                "User Stats Backfill Failed",
                error,
                f"invictus.backfillstats by {initiated_by}",
            )
            return

        elapsed = format_duration(get_now() - started_at)
        description = (
            f"**By:** {getattr(initiated_by, 'mention', str(initiated_by))}\n"
            f"**Lookback:** {lookback_text}\n"
            f"**Elapsed:** `{elapsed}`\n"
            f"**Scanned Channels:** `{result['scanned_channels']}`\n"
            f"**Skipped Channels:** `{result['skipped_channels']}`\n"
            f"**Scanned Messages:** `{result['scanned_messages']}`\n"
            f"**Scanned Reactions:** `{result['scanned_reactions']}`\n"
            f"**Messages Users Seen:** `{result['message_users_seen']}` (updated `{result['message_updates']}`)\n"
            f"**Reactions Sent Users Seen:** `{result['reaction_sent_users_seen']}` (updated `{result['reaction_sent_updates']}`)\n"
            f"**Reactions Received Users Seen:** `{result['reaction_received_users_seen']}` (updated `{result['reaction_received_updates']}`)"
        )

        summary = (
            f"channels={result['scanned_channels']}, messages={result['scanned_messages']}, "
            f"reactions={result['scanned_reactions']}, updates={result['message_updates'] + result['reaction_sent_updates'] + result['reaction_received_updates']}"
        )
        mark_backfill_finished("completed", summary=summary)

        logger.info("User stats backfill completed | %s", description.replace("\n", " | "))
        await send_log(guild, "User Stats Backfill Complete", description)


def metrics_snapshot() -> dict:
    snapshot = {
        "command_usage": metrics_get_prefixed("command_usage."),
        "command_failures": metrics_get_prefixed("command_failures."),
        "posts_by_category": metrics_get_prefixed("posts_by_category."),
        "posts_total": int(metrics_get("posts_total", 0)),
        "posts_auto": int(metrics_get("posts_auto", 0)),
        "posts_manual": int(metrics_get("posts_manual", 0)),
        "custom_posts": int(metrics_get("custom_posts", 0)),
        "answers_total": int(metrics_get("answers_total", 0)),
        "last_successful_auto_post": metrics_get("last_successful_auto_post", "") or None,
    }
    return ensure_metrics_shape(snapshot)


def flatten_metrics_for_storage(metrics: dict) -> dict[str, str]:
    shaped = metrics if isinstance(metrics, dict) else {}
    shaped.setdefault("command_usage", {})
    shaped.setdefault("command_failures", {})
    shaped.setdefault("posts_by_category", {})
    shaped.setdefault("posts_total", 0)
    shaped.setdefault("posts_auto", 0)
    shaped.setdefault("posts_manual", 0)
    shaped.setdefault("custom_posts", 0)
    shaped.setdefault("answers_total", 0)
    shaped.setdefault("last_successful_auto_post", None)
    flattened: dict[str, str] = {
        "posts_total": str(int(shaped.get("posts_total", 0))),
        "posts_auto": str(int(shaped.get("posts_auto", 0))),
        "posts_manual": str(int(shaped.get("posts_manual", 0))),
        "custom_posts": str(int(shaped.get("custom_posts", 0))),
        "answers_total": str(int(shaped.get("answers_total", 0))),
        "last_successful_auto_post": str(shaped.get("last_successful_auto_post") or ""),
    }

    for command_name, count in shaped.get("command_usage", {}).items():
        flattened[f"command_usage.{command_name}"] = str(int(count))
    for command_name, count in shaped.get("command_failures", {}).items():
        flattened[f"command_failures.{command_name}"] = str(int(count))
    for category, count in shaped.get("posts_by_category", {}).items():
        flattened[f"posts_by_category.{category}"] = str(int(count))

    return flattened


def parse_post_row(row: sqlite3.Row) -> dict:
    return {
        "message_id": str(row["message_id"]),
        "thread_id": str(row["thread_id"]) if row["thread_id"] is not None else None,
        "channel_id": str(row["channel_id"]),
        "category": str(row["category"]),
        "question": str(row["question"]),
        "posted_at": str(row["posted_at"]),
        "close_after_hours": int(row["close_after_hours"]),
        "closed": bool(row["closed"]),
        "closed_at": str(row["closed_at"]) if row["closed_at"] is not None else None,
        "close_reason": str(row["close_reason"]) if row["close_reason"] is not None else None,
    }


def upsert_post_row(record: dict) -> None:
    close_after_hours = int(record.get("close_after_hours", THREAD_CLOSE_HOURS))
    with get_db_connection() as conn:
        conn.execute(
            """
            INSERT INTO posts (
                message_id, thread_id, channel_id, category, question, posted_at,
                close_after_hours, closed, closed_at, close_reason
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(message_id) DO UPDATE SET
                thread_id = excluded.thread_id,
                channel_id = excluded.channel_id,
                category = excluded.category,
                question = excluded.question,
                posted_at = excluded.posted_at,
                close_after_hours = excluded.close_after_hours,
                closed = excluded.closed,
                closed_at = excluded.closed_at,
                close_reason = excluded.close_reason
            """,
            (
                str(record.get("message_id")),
                str(record.get("thread_id")) if record.get("thread_id") else None,
                str(record.get("channel_id")),
                str(record.get("category") or "unknown"),
                str(record.get("question") or MSG_UNKNOWN_QUESTION),
                str(record.get("posted_at") or iso_now()),
                close_after_hours,
                1 if bool(record.get("closed", False)) else 0,
                str(record.get("closed_at")) if record.get("closed_at") else None,
                str(record.get("close_reason")) if record.get("close_reason") else None,
            ),
        )


def get_structured_table_counts() -> tuple[int, int, int]:
    with get_db_connection() as conn:
        posts_count = int(conn.execute("SELECT COUNT(*) AS c FROM posts").fetchone()["c"])
        answers_count = int(conn.execute("SELECT COUNT(*) AS c FROM answers").fetchone()["c"])
        metrics_count = int(conn.execute("SELECT COUNT(*) AS c FROM metrics").fetchone()["c"])
    return posts_count, answers_count, metrics_count


def migrate_posts_from_state(state: dict) -> None:
    for post in state.get("posts", []):
        if isinstance(post, dict):
            upsert_post_row(post)


def migrate_answers_from_legacy_blob(legacy_answers: dict) -> None:
    with get_db_connection() as conn:
        for question_message_id, bucket in legacy_answers.items():
            users = bucket.get("users", {}) if isinstance(bucket, dict) else {}
            for user_id, data in users.items():
                conn.execute(
                    """
                    INSERT INTO answers (question_message_id, user_id, answer_message_id, created_at)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(question_message_id, user_id) DO UPDATE SET
                        answer_message_id = excluded.answer_message_id,
                        created_at = excluded.created_at
                    """,
                    (
                        str(question_message_id),
                        str(user_id),
                        str(data.get("answer_message_id") or ""),
                        str(data.get("created_at") or iso_now()),
                    ),
                )


def migrate_metrics_from_state(state: dict) -> None:
    for metric_key, metric_value in flatten_metrics_for_storage(state.get("metrics", {})).items():
        metrics_set(metric_key, metric_value)


def migrate_structured_tables() -> None:
    posts_count, answers_count, metrics_count = get_structured_table_counts()
    state = db_get_json("state", {})

    if posts_count == 0:
        migrate_posts_from_state(state)

    legacy_answers = db_get_json("answers", {})
    if answers_count == 0 and isinstance(legacy_answers, dict):
        migrate_answers_from_legacy_blob(legacy_answers)

    if metrics_count == 0:
        migrate_metrics_from_state(state)


def maybe_migrate_json_files() -> None:
    for path, key in STORAGE_JSON_KEYS.items():
        if db_has_key(key) or not os.path.exists(path):
            continue

        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError):
            continue

        if isinstance(data, dict):
            db_set_json(key, data)


def init_storage() -> None:
    init_db()
    maybe_migrate_json_files()
    migrate_structured_tables()


def save_json(path: str, data: dict) -> None:
    storage_key = STORAGE_JSON_KEYS.get(path)
    if storage_key is not None:
        db_set_json(storage_key, data)
        return

    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def load_json(path: str, default: dict) -> dict:
    storage_key = STORAGE_JSON_KEYS.get(path)
    if storage_key is not None:
        return db_get_json(storage_key, default)

    if not os.path.exists(path):
        save_json(path, default)
        return default
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def get_now() -> datetime:
    try:
        return datetime.now(ZoneInfo(TIMEZONE_NAME))
    except ZoneInfoNotFoundError:
        return datetime.now()


def iso_now() -> str:
    return get_now().isoformat()


init_storage()


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def get_state() -> dict:
    state = load_json(
        STATE_FILE,
        {
            "mode": "manual",
            "hour": 20,
            "minute": 0,
            "channel_id": COURT_CHANNEL_ID,
            "log_channel_id": LOG_CHANNEL_ID_ENV,
            "last_posted_date": None,
            "dry_run_auto_post": False,
            "last_dry_run_date": None,
            "last_weekly_digest_week": None,
            "history": [],
            "used_questions": [],
            "royal_presence": {},
            "royal_afk": {},
        },
    )

    state.setdefault("mode", "manual")
    state.setdefault("hour", 20)
    state.setdefault("minute", 0)
    state.setdefault("channel_id", COURT_CHANNEL_ID)
    state.setdefault("log_channel_id", LOG_CHANNEL_ID_ENV)
    state.setdefault("last_posted_date", None)
    state.setdefault("dry_run_auto_post", False)
    state.setdefault("last_dry_run_date", None)
    state.setdefault("last_weekly_digest_week", None)
    state.setdefault("history", [])
    state.setdefault("used_questions", [])
    state.setdefault("royal_presence", {})
    state.setdefault("royal_afk", {})
    state["posts"] = list_post_records(limit=POST_RECORD_LIMIT)
    state["metrics"] = metrics_snapshot()
    state["royal_presence"] = ensure_royal_presence_shape(state.get("royal_presence", {}))
    state["royal_afk"] = ensure_royal_afk_shape(state.get("royal_afk", {}))

    if state.get("channel_id", 0) == 0:
        state["channel_id"] = COURT_CHANNEL_ID

    state_to_persist = dict(state)
    state_to_persist["posts"] = []
    state_to_persist["metrics"] = {}
    save_state(state_to_persist)
    return state


def save_state(state: dict) -> None:
    with STATE_WRITE_LOCK:
        _save_state_unlocked(state)


def _save_state_unlocked(state: dict) -> None:
    state["history"] = state.get("history", [])[-HISTORY_LIMIT:]

    used = []
    seen = set()
    for question in state.get("used_questions", []):
        if question not in seen:
            used.append(question)
            seen.add(question)
    state["used_questions"] = used

    for post in state.get("posts", [])[-POST_RECORD_LIMIT:]:
        if isinstance(post, dict):
            upsert_post_row(post)

    for metric_key, metric_value in flatten_metrics_for_storage(state.get("metrics", {})).items():
        metrics_set(metric_key, metric_value)

    state["posts"] = []
    state["metrics"] = {}
    state["royal_presence"] = ensure_royal_presence_shape(state.get("royal_presence", {}))
    state["royal_afk"] = ensure_royal_afk_shape(state.get("royal_afk", {}))
    save_json(STATE_FILE, state)


def update_state_atomic(mutator: Callable[[dict], None]) -> dict:
    with STATE_WRITE_LOCK:
        state = load_json(
            STATE_FILE,
            {
                "mode": "manual",
                "hour": 20,
                "minute": 0,
                "channel_id": COURT_CHANNEL_ID,
                "log_channel_id": LOG_CHANNEL_ID_ENV,
                "last_posted_date": None,
                "dry_run_auto_post": False,
                "last_dry_run_date": None,
                "last_weekly_digest_week": None,
                "history": [],
                "used_questions": [],
                "royal_presence": {},
                "royal_afk": {},
            },
        )
        mutator(state)
        _save_state_unlocked(state)
        state["posts"] = list_post_records(limit=POST_RECORD_LIMIT)
        state["metrics"] = metrics_snapshot()
        return state


def ensure_metrics_shape(metrics: dict) -> dict:
    metrics = metrics if isinstance(metrics, dict) else {}
    metrics.setdefault("command_usage", {})
    metrics.setdefault("command_failures", {})
    metrics.setdefault("posts_by_category", {})
    metrics.setdefault("posts_total", 0)
    metrics.setdefault("posts_auto", 0)
    metrics.setdefault("posts_manual", 0)
    metrics.setdefault("custom_posts", 0)
    metrics.setdefault("answers_total", 0)
    metrics.setdefault("last_successful_auto_post", None)
    return metrics


def ensure_royal_presence_shape(royal_presence: dict) -> dict:
    royal_presence = royal_presence if isinstance(royal_presence, dict) else {}

    by_title = royal_presence.get("last_message_at_by_title")
    if not isinstance(by_title, dict):
        by_title = {}
    for title in ROYAL_TITLES:
        by_title.setdefault(title, None)

    # Migrate legacy single-timer state into the role-specific timer bucket.
    legacy_last_message_at = royal_presence.get("last_message_at")
    legacy_last_speaker = royal_presence.get("last_speaker")
    if legacy_last_speaker in by_title and by_title.get(legacy_last_speaker) is None:
        by_title[legacy_last_speaker] = legacy_last_message_at

    royal_presence["last_message_at_by_title"] = by_title
    royal_presence.setdefault("last_message_at", None)
    royal_presence.setdefault("last_speaker", None)
    return royal_presence


def ensure_royal_afk_shape(royal_afk: dict) -> dict:
    royal_afk = royal_afk if isinstance(royal_afk, dict) else {}

    by_title = royal_afk.get("by_title")
    if not isinstance(by_title, dict):
        by_title = {}

    for title in ROYAL_TITLES:
        entry = by_title.get(title)
        if not isinstance(entry, dict):
            entry = {}

        by_title[title] = {
            "active": bool(entry.get("active", False)),
            "reason": str(entry.get("reason") or ""),
            "set_at": entry.get("set_at"),
            "set_by_user_id": str(entry.get("set_by_user_id")) if entry.get("set_by_user_id") is not None else None,
        }

    royal_afk["by_title"] = by_title
    return royal_afk


def reset_royal_presence_timer() -> None:
    state = get_state()
    royal_presence = ensure_royal_presence_shape(state.get("royal_presence", {}))
    for title in ROYAL_TITLES:
        royal_presence["last_message_at_by_title"][title] = None
    royal_presence["last_message_at"] = None
    royal_presence["last_speaker"] = None
    state["royal_presence"] = royal_presence
    save_state(state)


def increment_counter(counter_map: dict, key: str) -> None:
    counter_map[key] = int(counter_map.get(key, 0)) + 1


def record_command_metric(command_name: str, success: bool = True) -> None:
    metrics_increment(f"command_usage.{command_name}")
    if not success:
        metrics_increment(f"command_failures.{command_name}")


def record_post_metric(category: str, source: str) -> None:
    metrics_increment(f"posts_by_category.{category}")
    metrics_increment("posts_total")

    if source == "auto":
        metrics_increment("posts_auto")
        metrics_set("last_successful_auto_post", iso_now())
    elif source == "manual":
        metrics_increment("posts_manual")
    elif source == "custom":
        metrics_increment("custom_posts")


def record_answer_metric() -> None:
    metrics_increment("answers_total")


def record_user_message_metric(user: discord.Member | object) -> None:
    user_id = getattr(user, "id", None)
    if user_id is None:
        return

    try:
        increment_user_metric(int(user_id), "messages_sent")
    except (TypeError, ValueError):
        return


def record_user_reaction_sent_metric(user_id: int) -> None:
    increment_user_metric(user_id, "reactions_sent")


def record_user_reaction_received_metric(user_id: int) -> None:
    increment_user_metric(user_id, "reactions_received")


def record_user_anonymous_answer_metric(user_id: int) -> None:
    increment_user_metric(user_id, "anonymous_answers_sent")


def record_user_battle_metrics(player1_id: int, player2_id: int, winner_id: int) -> None:
    increment_user_metric(player1_id, "battles_played")
    increment_user_metric(player2_id, "battles_played")
    increment_user_metric(winner_id, "battles_won")


def get_questions() -> dict:
    questions = load_json(
        QUESTIONS_FILE,
        {
            "general": [],
            "gaming": [],
            "music": [],
            "hot-take": [],
            "chaos": [],
        },
    )

    for category in CATEGORY_DESCRIPTIONS:
        questions.setdefault(category, [])

    return questions


def get_answers() -> dict:
    answers: dict[str, dict] = {}
    with get_db_connection() as conn:
        rows = conn.execute(
            """
            SELECT question_message_id, user_id, answer_message_id, created_at
            FROM answers
            ORDER BY created_at ASC
            """
        ).fetchall()

    for row in rows:
        question_message_id = str(row["question_message_id"])
        bucket = answers.setdefault(question_message_id, {"count": 0, "users": {}})
        bucket["count"] += 1
        bucket["users"][str(row["user_id"])] = {
            "answer_message_id": str(row["answer_message_id"]),
            "created_at": str(row["created_at"]),
        }

    return answers


def save_answers(data: dict) -> None:
    with get_db_connection() as conn:
        conn.execute("DELETE FROM answers")
        for question_message_id, bucket in data.items():
            users = bucket.get("users", {}) if isinstance(bucket, dict) else {}
            for user_id, answer_data in users.items():
                conn.execute(
                    """
                    INSERT INTO answers (question_message_id, user_id, answer_message_id, created_at)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(question_message_id, user_id) DO UPDATE SET
                        answer_message_id = excluded.answer_message_id,
                        created_at = excluded.created_at
                    """,
                    (
                        str(question_message_id),
                        str(user_id),
                        str(answer_data.get("answer_message_id") or ""),
                        str(answer_data.get("created_at") or iso_now()),
                    ),
                )


def normalize_question_text(value: str) -> str:
    return " ".join(value.split()).strip()


def get_answer_bucket(question_message_id: int | str) -> dict:
    key = str(question_message_id)
    with get_db_connection() as conn:
        rows = conn.execute(
            "SELECT user_id, answer_message_id, created_at FROM answers WHERE question_message_id = ?",
            (key,),
        ).fetchall()

    users = {
        str(row["user_id"]): {
            "answer_message_id": str(row["answer_message_id"]),
            "created_at": str(row["created_at"]),
        }
        for row in rows
    }
    return {"count": len(rows), "users": users}


def has_user_answered(question_message_id: int, user_id: int) -> bool:
    with get_db_connection() as conn:
        row = conn.execute(
            "SELECT 1 FROM answers WHERE question_message_id = ? AND user_id = ?",
            (str(question_message_id), str(user_id)),
        ).fetchone()
    return row is not None


def next_answer_number(question_message_id: int) -> int:
    with get_db_connection() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS c FROM answers WHERE question_message_id = ?",
            (str(question_message_id),),
        ).fetchone()
    return int(row["c"]) + 1


def mark_user_answered(question_message_id: int, user_id: int, answer_message_id: int) -> None:
    now_iso = iso_now()
    with get_db_connection() as conn:
        conn.execute(
            """
            INSERT INTO answers (question_message_id, user_id, answer_message_id, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(question_message_id, user_id) DO UPDATE SET
                answer_message_id = excluded.answer_message_id,
                created_at = excluded.created_at
            """,
            (str(question_message_id), str(user_id), str(answer_message_id), now_iso),
        )
        conn.execute(
            """
            INSERT INTO anon_cooldowns (user_id, last_answer_at)
            VALUES (?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                last_answer_at = excluded.last_answer_at
            """,
            (str(user_id), now_iso),
        )
    record_user_anonymous_answer_metric(user_id)


def find_answer_record(answer_message_id: str) -> tuple[str, str] | None:
    with get_db_connection() as conn:
        row = conn.execute(
            "SELECT question_message_id, user_id FROM answers WHERE answer_message_id = ?",
            (str(answer_message_id),),
        ).fetchone()
    if row is None:
        return None
    return str(row["question_message_id"]), str(row["user_id"])


def remove_answer_record(answer_message_id: str) -> tuple[str, str] | None:
    with get_db_connection() as conn:
        row = conn.execute(
            "SELECT question_message_id, user_id FROM answers WHERE answer_message_id = ?",
            (str(answer_message_id),),
        ).fetchone()
        if row is None:
            return None

        conn.execute("DELETE FROM answers WHERE answer_message_id = ?", (str(answer_message_id),))
    return str(row["question_message_id"]), str(row["user_id"])


def count_answers_for_question(question_message_id: int | str) -> int:
    with get_db_connection() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS c FROM answers WHERE question_message_id = ?",
            (str(question_message_id),),
        ).fetchone()
    return int(row["c"])


def count_all_answer_records() -> int:
    with get_db_connection() as conn:
        row = conn.execute("SELECT COUNT(*) AS c FROM answers").fetchone()
    return int(row["c"])


def get_last_answer_time_for_user(user_id: int) -> datetime | None:
    with get_db_connection() as conn:
        row = conn.execute(
            "SELECT last_answer_at FROM anon_cooldowns WHERE user_id = ?",
            (str(user_id),),
        ).fetchone()
    if row is None:
        return None
    return parse_iso(str(row["last_answer_at"]))


def is_admin(member: discord.Member) -> bool:
    if getattr(getattr(member, "guild_permissions", None), "administrator", False):
        return True

    guild = getattr(member, "guild", None)
    owner_id = getattr(guild, "owner_id", None)
    return owner_id is not None and getattr(member, "id", None) == owner_id


def is_staff(member: discord.Member) -> bool:
    if is_admin(member):
        return True
    return any(role.id in STAFF_ROLE_IDS for role in member.roles)


def remove_question_from_state(question: str) -> None:
    def mutator(state: dict) -> None:
        state["history"] = [q for q in state.get("history", []) if q != question]
        state["used_questions"] = [q for q in state.get("used_questions", []) if q != question]

    update_state_atomic(mutator)


def replace_question_in_state(old_question: str, new_question: str) -> None:
    def mutator(state: dict) -> None:
        state["history"] = [new_question if q == old_question else q for q in state.get("history", [])]
        state["used_questions"] = [new_question if q == old_question else q for q in state.get("used_questions", [])]

    update_state_atomic(mutator)


def register_used_question(question: str) -> None:
    def mutator(state: dict) -> None:
        state["history"].append(question)
        if question not in state["used_questions"]:
            state["used_questions"].append(question)

    update_state_atomic(mutator)


def pick_question(category: str | None = None, randomize: bool = True) -> tuple[str, str]:
    questions = get_questions()
    state = get_state()

    recent = set(state.get("history", [])[-HISTORY_LIMIT:])
    used = set(state.get("used_questions", []))

    pool: list[tuple[str, str]] = []

    if category:
        for q in questions.get(category, []):
            pool.append((category, q))
    else:
        for cat, items in questions.items():
            for q in items:
                pool.append((cat, q))

    if not pool:
        raise ValueError("No questions found in questions.json")

    unused = [item for item in pool if item[1] not in used]

    if not unused:
        state["used_questions"] = []
        save_state(state)
        unused = pool[:]

    filtered = [item for item in unused if item[1] not in recent]
    final_pool = filtered if filtered else unused

    if randomize:
        return random.choice(final_pool)

    return final_pool[0]


def get_post_record(message_id: int | str) -> dict | None:
    with get_db_connection() as conn:
        row = conn.execute(
            "SELECT * FROM posts WHERE message_id = ?",
            (str(message_id),),
        ).fetchone()
    if row is None:
        return None
    return parse_post_row(row)


def list_post_records(include_closed: bool = True, limit: int | None = None) -> list[dict]:
    if limit is None:
        query = "SELECT * FROM posts"
        params: list[object] = []
        if not include_closed:
            query += " WHERE closed = 0"
        query += " ORDER BY posted_at ASC"
    else:
        query = "SELECT * FROM posts"
        params = []
        if not include_closed:
            query += " WHERE closed = 0"
        query += " ORDER BY posted_at DESC LIMIT ?"
        params.append(limit)

    with get_db_connection() as conn:
        rows = conn.execute(query, tuple(params)).fetchall()

    parsed = [parse_post_row(row) for row in rows]
    if limit is not None:
        parsed.reverse()
    return parsed


def get_latest_open_post() -> dict | None:
    with get_db_connection() as conn:
        row = conn.execute(
            "SELECT * FROM posts WHERE closed = 0 ORDER BY posted_at DESC LIMIT 1"
        ).fetchone()
    if row is None:
        return None
    return parse_post_row(row)


def upsert_post_record(record: dict) -> None:
    upsert_post_row(record)


def update_post_thread_id(message_id: int | str, thread_id: int | str) -> None:
    record = get_post_record(message_id)
    if record is None:
        return
    record["thread_id"] = str(thread_id)
    upsert_post_record(record)


def mark_post_closed(message_id: int | str, reason: str) -> None:
    record = get_post_record(message_id)
    if record is None:
        return

    record["closed"] = True
    record["closed_at"] = iso_now()
    record["close_reason"] = reason
    upsert_post_record(record)


def mark_post_open(message_id: int | str, close_after_hours: int | None = None) -> dict | None:
    record = get_post_record(message_id)
    if record is None:
        return None

    record["closed"] = False
    record["closed_at"] = None
    record["close_reason"] = None
    if close_after_hours is not None:
        record["close_after_hours"] = int(close_after_hours)
    upsert_post_record(record)
    return record


def set_post_close_after_hours(message_id: int | str, close_after_hours: int) -> dict | None:
    record = get_post_record(message_id)
    if record is None:
        return None
    record["close_after_hours"] = int(close_after_hours)
    upsert_post_record(record)
    return record


def extract_question_from_message(message: discord.Message | None) -> str:
    if not message or not message.embeds:
        return MSG_UNKNOWN_QUESTION

    embed = message.embeds[0]
    description = embed.description or ""
    marker = "**Question:**"

    if marker in description:
        return description.split(marker, 1)[1].strip()

    return MSG_UNKNOWN_QUESTION


def make_thread_name(question: str) -> str:
    cleaned = "".join(ch for ch in question if ch.isalnum() or ch in " -_").strip()
    cleaned = "-".join(cleaned.split())
    name = f"court-{cleaned}" if cleaned else "court-replies"
    return name[:100]


def build_embed(category: str, question: str) -> discord.Embed:
    embed = discord.Embed(
        title="Imperial Court Inquiry",
        description=f"*The throne demands an answer.*\n\n**Question:** {question}",
        color=ROLE_COLOR,
        timestamp=get_now(),
    )
    embed.set_footer(text=f"Category: {category}")
    return embed


def build_announcement_mentions(mention_everyone: bool) -> tuple[str | None, discord.AllowedMentions]:
    if mention_everyone:
        return MSG_EVERYONE_MENTION, discord.AllowedMentions(everyone=True)

    return None, discord.AllowedMentions(everyone=False, users=False, roles=False)


async def fetch_channel_by_id(channel_id: int | str) -> discord.abc.GuildChannel | discord.Thread | None:
    try:
        channel_id_int = int(channel_id)
    except (TypeError, ValueError):
        return None

    channel = bot.get_channel(channel_id_int)
    if channel is not None:
        return channel

    try:
        return await bot.fetch_channel(channel_id_int)
    except Exception:
        return None


async def get_target_channel(guild: discord.Guild) -> discord.TextChannel | None:
    state = get_state()
    channel = guild.get_channel(state["channel_id"])

    if isinstance(channel, discord.TextChannel):
        return channel

    try:
        fetched = await bot.fetch_channel(state["channel_id"])
        if isinstance(fetched, discord.TextChannel):
            return fetched
    except Exception:
        return None

    return None


async def get_log_channel(guild: discord.Guild) -> discord.TextChannel | None:
    state = get_state()
    channel_id = state.get("log_channel_id", 0)

    if not channel_id:
        return None

    channel = guild.get_channel(int(channel_id))
    if isinstance(channel, discord.TextChannel):
        return channel

    try:
        fetched = await bot.fetch_channel(int(channel_id))
        if isinstance(fetched, discord.TextChannel):
            return fetched
    except Exception:
        return None

    return None


async def send_log(guild: discord.Guild, title: str, description: str) -> None:
    channel = await get_log_channel(guild)
    if channel is None:
        return

    embed = discord.Embed(
        title=title,
        description=description,
        color=ROLE_COLOR,
        timestamp=get_now(),
    )
    await channel.send(embed=embed)


async def send_failure_alert(
    guild: discord.Guild | None,
    title: str,
    error: Exception,
    context: str,
) -> None:
    logger.exception("%s | %s", title, context)
    if guild is None:
        return

    description = (
        f"**Context:** {context}\n"
        f"**Error Type:** `{type(error).__name__}`\n"
        f"**Error:** `{str(error)[:1000]}`"
    )
    await send_log(guild, title, description)


class ClosedAnswerView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)
        button = discord.ui.Button(
            label="Court Inquiry Closed",
            style=discord.ButtonStyle.secondary,
            disabled=True,
        )
        self.add_item(button)


def build_role_panel_embed(
    roles: list[discord.Role],
    title: str | None = None,
    description: str | None = None,
) -> discord.Embed:
    panel_roles = roles[:ROLE_PANEL_MAX_BUTTONS]
    panel_title = (title or "").strip() or "Imperial Role Panel"

    if len(panel_roles) == 1:
        default_description = f"Click the button below to add or remove the **{panel_roles[0].name}** role."
    else:
        default_description = "Click one of the buttons below to toggle the matching role."
    panel_description = (description or "").strip() or default_description

    embed = discord.Embed(
        title=panel_title,
        description=panel_description,
        color=ROLE_COLOR,
        timestamp=get_now(),
    )

    if len(panel_roles) == 1:
        role = panel_roles[0]
        embed.add_field(name="Role", value=f"{role.mention} (`{role.id}`)", inline=False)
        embed.set_footer(text=f"{ROLE_PANEL_FOOTER_PREFIX}{role.id}")
        return embed

    role_lines = [f"{index}. {role.mention} (`{role.id}`)" for index, role in enumerate(panel_roles, start=1)]
    footer_targets = [f"{index}={role.id}" for index, role in enumerate(panel_roles, start=1)]
    embed.add_field(name="Roles", value="\n".join(role_lines), inline=False)
    embed.set_footer(text=f"{ROLE_PANEL_TARGETS_FOOTER_PREFIX}{','.join(footer_targets)}")
    return embed


def parse_role_panel_targets_from_footer(footer_text: str) -> dict[int, int]:
    cleaned = footer_text.strip()
    single_match = ROLE_PANEL_ROLE_ID_PATTERN.match(cleaned)
    if single_match is not None:
        try:
            return {1: int(single_match.group(1))}
        except ValueError:
            return {}

    if not cleaned.startswith(ROLE_PANEL_TARGETS_FOOTER_PREFIX):
        return {}

    payload = cleaned.removeprefix(ROLE_PANEL_TARGETS_FOOTER_PREFIX).strip()
    if not payload:
        return {}

    targets: dict[int, int] = {}
    for entry in payload.split(","):
        segment = entry.strip()
        if not segment or "=" not in segment:
            continue
        slot_raw, role_id_raw = (item.strip() for item in segment.split("=", 1))
        if not slot_raw.isdigit() or not role_id_raw.isdigit():
            continue

        slot = int(slot_raw)
        role_id = int(role_id_raw)
        if 1 <= slot <= ROLE_PANEL_MAX_BUTTONS and slot not in targets:
            targets[slot] = role_id

    return targets


def extract_role_panel_role_id_for_slot(message: discord.Message | None, slot: int) -> int | None:
    if message is None or slot < 1 or slot > ROLE_PANEL_MAX_BUTTONS:
        return None

    for embed in message.embeds:
        footer_text = str(embed.footer.text or "")
        targets = parse_role_panel_targets_from_footer(footer_text)
        if slot in targets:
            return targets[slot]

    return None


def extract_role_panel_role_id(message: discord.Message | None) -> int | None:
    return extract_role_panel_role_id_for_slot(message, 1)


def extract_role_panel_button_slot(custom_id: str | None) -> int | None:
    if custom_id is None:
        return None

    if custom_id == ROLE_PANEL_BUTTON_CUSTOM_ID:
        return 1

    expected_prefix = f"{ROLE_PANEL_BUTTON_CUSTOM_ID}:"
    if not custom_id.startswith(expected_prefix):
        return None

    slot_value = custom_id.removeprefix(expected_prefix)
    if not slot_value.isdigit():
        return None

    slot = int(slot_value)
    if 1 <= slot <= ROLE_PANEL_MAX_BUTTONS:
        return slot

    return None


def get_role_panel_claim_role(interaction: discord.Interaction) -> tuple[discord.Role | None, str | None]:
    guild = interaction.guild
    message = interaction.message
    if guild is None or message is None:
        return None, MSG_USE_IN_SERVER

    interaction_data = interaction.data if isinstance(interaction.data, dict) else {}
    button_slot = extract_role_panel_button_slot(str(interaction_data.get("custom_id") or ""))
    if button_slot is None:
        return None, "Could not determine which role button was clicked."

    role_id = extract_role_panel_role_id_for_slot(message, button_slot)
    if role_id is None:
        return None, "This role panel is missing role metadata."

    role = guild.get_role(role_id)
    if role is None:
        return None, "The configured role no longer exists."

    return role, None


def get_role_panel_claim_permission_error(role: discord.Role, me: discord.Member | None) -> str | None:
    if role.is_default() or role.managed:
        return "This role cannot be self-assigned from this panel."

    if me is None or not me.guild_permissions.manage_roles:
        return "I need Manage Roles permission to manage this role."

    if me.top_role <= role:
        return "I cannot manage this role because it is above or equal to my top role."

    return None


async def toggle_role_for_member(
    member: discord.Member,
    role: discord.Role,
    message_id: int,
) -> tuple[str | None, str | None]:
    has_role = member.get_role(role.id) is not None

    if has_role:
        try:
            await member.remove_roles(
                role,
                reason=f"Self-removed via role panel ({message_id})",
            )
        except discord.Forbidden:
            return None, "I do not have permission to remove this role."
        except discord.HTTPException:
            return None, "Failed to remove role due to a Discord API error."

        return f"Removed {role.mention}.", None

    try:
        await member.add_roles(
            role,
            reason=f"Self-assigned via role panel ({message_id})",
        )
    except discord.Forbidden:
        return None, "I do not have permission to grant this role."
    except discord.HTTPException:
        return None, "Failed to grant role due to a Discord API error."

    return f"You now have {role.mention}.", None


class RolePanelView(discord.ui.View):
    def __init__(self, button_labels: list[str] | None = None):
        super().__init__(timeout=None)
        labels = button_labels or [ROLE_PANEL_DEFAULT_BUTTON_LABEL]
        trimmed_labels = labels[:ROLE_PANEL_MAX_BUTTONS]

        for index, raw_label in enumerate(trimmed_labels, start=1):
            fallback = ROLE_PANEL_DEFAULT_BUTTON_LABEL if index == 1 else f"Claim Role {index}"
            label = (raw_label or "").strip() or fallback
            custom_id = ROLE_PANEL_BUTTON_CUSTOM_ID if index == 1 else f"{ROLE_PANEL_BUTTON_CUSTOM_ID}:{index}"
            button = discord.ui.Button(
                label=label[:ROLE_PANEL_BUTTON_LABEL_MAX_LENGTH],
                style=discord.ButtonStyle.secondary,
                custom_id=custom_id,
            )
            button.callback = self.claim_role_button
            self.add_item(button)

    async def claim_role_button(self, interaction: discord.Interaction) -> None:
        if interaction.guild is None or interaction.message is None:
            await interaction.response.send_message(MSG_USE_IN_SERVER, ephemeral=True)
            return

        if not isinstance(interaction.user, discord.Member):
            await interaction.response.send_message(MSG_VERIFY_ROLES, ephemeral=True)
            return

        role, role_error = get_role_panel_claim_role(interaction)
        if role_error is not None:
            await interaction.response.send_message(role_error, ephemeral=True)
            return

        me = interaction.guild.me
        permission_error = get_role_panel_claim_permission_error(role, me)
        if permission_error is not None:
            await interaction.response.send_message(permission_error, ephemeral=True)
            return

        success_message, error_message = await toggle_role_for_member(interaction.user, role, interaction.message.id)
        if error_message is not None:
            await interaction.response.send_message(error_message, ephemeral=True)
            return

        await interaction.response.send_message(success_message or "Role updated.", ephemeral=True)


async def create_answer_thread(message: discord.Message) -> discord.Thread | None:
    question = extract_question_from_message(message)

    try:
        thread = await message.create_thread(
            name=make_thread_name(question),
            auto_archive_duration=THREAD_AUTO_ARCHIVE_MINUTES,
        )
        update_post_thread_id(message.id, thread.id)
        return thread
    except discord.HTTPException:
        try:
            thread = await message.create_thread(name=make_thread_name(question))
            update_post_thread_id(message.id, thread.id)
            return thread
        except Exception:
            return None
    except Exception:
        return None


async def get_or_create_answer_thread(message: discord.Message) -> discord.Thread | None:
    if message.guild is None:
        return None

    thread = message.guild.get_thread(message.id)
    if isinstance(thread, discord.Thread):
        update_post_thread_id(message.id, thread.id)
        return thread

    record = get_post_record(message.id)
    if record and record.get("thread_id"):
        fetched = await fetch_channel_by_id(record["thread_id"])
        if isinstance(fetched, discord.Thread):
            update_post_thread_id(message.id, fetched.id)
            return fetched

    try:
        fetched = await bot.fetch_channel(message.id)
        if isinstance(fetched, discord.Thread):
            update_post_thread_id(message.id, fetched.id)
            return fetched
    except discord.NotFound:
        pass
    except discord.HTTPException:
        return None

    return await create_answer_thread(message)


async def get_post_message(record: dict) -> discord.Message | None:
    channel = await fetch_channel_by_id(record["channel_id"])
    if not isinstance(channel, discord.TextChannel):
        return None

    try:
        return await channel.fetch_message(int(record["message_id"]))
    except Exception:
        return None


async def close_court_post(
    record: dict,
    reason: str,
) -> tuple[bool, str]:
    if record.get("closed", False):
        return False, MSG_INQUIRY_CLOSED

    thread = None
    if record.get("thread_id"):
        fetched = await fetch_channel_by_id(record["thread_id"])
        if isinstance(fetched, discord.Thread):
            thread = fetched

    if thread is not None:
        try:
            await thread.edit(archived=True, locked=True)
        except Exception:
            pass

    message = await get_post_message(record)
    if message is not None:
        try:
            await message.edit(view=ClosedAnswerView())
        except Exception:
            pass

    mark_post_closed(record["message_id"], reason)
    return True, "Court inquiry closed."


def get_post_close_after_hours(record: dict) -> int:
    return int(record.get("close_after_hours", THREAD_CLOSE_HOURS))


def get_post_close_deadline(record: dict) -> datetime | None:
    posted_at = parse_iso(record.get("posted_at"))
    if posted_at is None:
        return None
    return posted_at + timedelta(hours=get_post_close_after_hours(record))


def get_post_remaining_time(record: dict, now: datetime) -> timedelta | None:
    deadline = get_post_close_deadline(record)
    if deadline is None:
        return None
    return deadline - now


async def reopen_court_post(record: dict, close_after_hours: int | None = None) -> tuple[bool, str]:
    if not record.get("closed", False):
        return False, "This court inquiry is already open."

    thread = None
    if record.get("thread_id"):
        fetched = await fetch_channel_by_id(record["thread_id"])
        if isinstance(fetched, discord.Thread):
            thread = fetched

    if thread is not None:
        try:
            await thread.edit(archived=False, locked=False, auto_archive_duration=THREAD_AUTO_ARCHIVE_MINUTES)
        except Exception:
            pass

    message = await get_post_message(record)
    if message is not None:
        try:
            await message.edit(view=AnonymousAnswerView())
        except Exception:
            pass

    reopened = mark_post_open(record["message_id"], close_after_hours=close_after_hours)
    if reopened is None:
        return False, "Could not reopen this inquiry record."

    return True, "Court inquiry reopened."


def status_text() -> str:
    state = get_state()
    channel_id = state["channel_id"]
    log_channel_id = state.get("log_channel_id", 0)
    channel_mention = f"<#{channel_id}>" if channel_id else "Not set"
    log_channel_mention = f"<#{log_channel_id}>" if log_channel_id else "Disabled"
    open_posts = len(list_post_records(include_closed=False))

    return (
        f"**Mode:** `{state['mode']}`\n"
        f"**Channel:** {channel_mention}\n"
        f"**Log Channel:** {log_channel_mention}\n"
        f"**Auto Time:** `{state['hour']:02d}:{state['minute']:02d}` ({TIMEZONE_NAME})\n"
        f"**Last Posted:** `{state['last_posted_date'] or 'Never'}`\n"
        f"**Recent Memory Size:** `{len(state.get('history', []))}`\n"
        f"**Used Pool Size:** `{len(state.get('used_questions', []))}`\n"
        f"**Open Court Threads:** `{open_posts}`"
    )


def next_auto_post_time(state: dict, now: datetime) -> datetime:
    next_run = now.replace(
        hour=state.get("hour", 20),
        minute=state.get("minute", 0),
        second=0,
        microsecond=0,
    )
    if next_run <= now:
        next_run += timedelta(days=1)
    return next_run


def format_duration(delta: timedelta) -> str:
    total_seconds = max(int(delta.total_seconds()), 0)
    hours, remainder = divmod(total_seconds, 3600)
    minutes, _ = divmod(remainder, 60)
    return f"{hours}h {minutes}m"


def count_open_and_overdue_posts(posts: list[dict], now: datetime) -> tuple[int, int]:
    open_posts = [post for post in posts if not post.get("closed", False)]
    overdue_posts = 0
    for post in open_posts:
        posted_at = parse_iso(post.get("posted_at"))
        close_after_hours = int(post.get("close_after_hours", THREAD_CLOSE_HOURS))
        if posted_at and now - posted_at >= timedelta(hours=close_after_hours):
            overdue_posts += 1
    return len(open_posts), overdue_posts


def find_missing_permissions(
    channel: discord.TextChannel | None,
    member: discord.Member | None,
) -> list[str]:
    if channel is None or member is None:
        return []

    required_permissions = [
        ("view_channel", "View Channel"),
        ("send_messages", "Send Messages"),
        ("embed_links", "Embed Links"),
        ("create_public_threads", "Create Public Threads"),
        ("send_messages_in_threads", "Send Messages In Threads"),
    ]
    permissions = channel.permissions_for(member)

    return [label for attr, label in required_permissions if not getattr(permissions, attr, False)]


def build_next_run_text(state: dict, now: datetime) -> tuple[str, str]:
    mode = state.get("mode", "manual")
    if mode != "auto":
        return mode, f"Not scheduled while mode is `{mode}`"

    next_run = next_auto_post_time(state, now)
    next_run_unix = int(next_run.timestamp())
    next_run_text = (
        f"<t:{next_run_unix}:F> (<t:{next_run_unix}:R>)"
        f" - in `{format_duration(next_run - now)}`"
    )
    return mode, next_run_text


def build_health_warnings(
    state: dict,
    target_channel: discord.TextChannel | None,
    log_channel: discord.TextChannel | None,
    missing_permissions: list[str],
    overdue_open_posts: int,
) -> list[str]:
    warnings = []
    if target_channel is None:
        warnings.append("Court channel is not reachable")
    if state.get("log_channel_id", 0) and log_channel is None:
        warnings.append("Log channel is configured but not reachable")
    if missing_permissions:
        warnings.append("Bot is missing permissions in court channel")
    if overdue_open_posts > 0:
        warnings.append(f"{overdue_open_posts} open thread(s) appear overdue for auto-close")
    return warnings


def resolve_bot_member(guild: discord.Guild) -> discord.Member | None:
    me = guild.me
    if me is None and bot.user is not None:
        return guild.get_member(bot.user.id)
    return me


def format_channel_health_texts(
    state: dict,
    target_channel: discord.TextChannel | None,
    log_channel: discord.TextChannel | None,
) -> tuple[str, str]:
    channel_text = target_channel.mention if target_channel else "Not found"
    if not state.get("log_channel_id", 0):
        return channel_text, "Disabled"
    return channel_text, log_channel.mention if log_channel else "Configured but not found"


def add_warnings_field(embed: discord.Embed, warnings: list[str]) -> None:
    if warnings:
        embed.add_field(name="Warnings", value="\n".join(f"- {item}" for item in warnings), inline=False)
        return
    embed.add_field(name="Warnings", value="None.", inline=False)


async def build_health_embed(guild: discord.Guild) -> discord.Embed:
    state = get_state()
    questions = get_questions()
    metrics = metrics_snapshot()
    posts = list_post_records(limit=POST_RECORD_LIMIT)
    now = get_now()

    open_posts_count, overdue_open_posts = count_open_and_overdue_posts(posts, now)

    target_channel = await get_target_channel(guild)
    log_channel = await get_log_channel(guild)

    missing_permissions = find_missing_permissions(target_channel, resolve_bot_member(guild))

    mode, next_run_text = build_next_run_text(state, now)

    db_exists = os.path.exists(DB_FILE)
    db_size_bytes = os.path.getsize(DB_FILE) if db_exists else 0
    db_size_kb = db_size_bytes / 1024
    total_questions = sum(len(items) for items in questions.values())

    warnings = build_health_warnings(
        state,
        target_channel,
        log_channel,
        missing_permissions,
        overdue_open_posts,
    )

    overall = "Healthy" if not warnings else "Attention Needed"

    embed = discord.Embed(
        title="Court Health Check",
        description=f"**Overall:** `{overall}`\n**Timezone:** `{TIMEZONE_NAME}`\n**Now:** `{now.strftime('%Y-%m-%d %H:%M:%S')}`",
        color=ROLE_COLOR,
        timestamp=now,
    )

    channel_text, log_channel_text = format_channel_health_texts(state, target_channel, log_channel)

    embed.add_field(
        name="Scheduling",
        value=(
            f"**Mode:** `{mode}`\n"
            f"**Dry Run:** `{'enabled' if state.get('dry_run_auto_post', False) else 'disabled'}`\n"
            f"**Auto Time:** `{state.get('hour', 20):02d}:{state.get('minute', 0):02d}`\n"
            f"**Next Auto-Post:** {next_run_text}\n"
            f"**Last Posted Date:** `{state.get('last_posted_date') or 'Never'}`\n"
            f"**Last Successful Auto-Post:** `{metrics.get('last_successful_auto_post') or 'Never'}`"
        ),
        inline=False,
    )
    embed.add_field(
        name="Channels",
        value=(
            f"**Court Channel:** {channel_text}\n"
            f"**Log Channel:** {log_channel_text}"
        ),
        inline=False,
    )
    embed.add_field(
        name="Tasks",
        value=(
            f"**Auto Poster Loop:** `{'running' if auto_poster.is_running() else 'stopped'}`\n"
            f"**Thread Closer Loop:** `{'running' if thread_closer.is_running() else 'stopped'}`\n"
            f"**Weekly Digest Loop:** `{'running' if weekly_digest.is_running() else 'stopped'}`\n"
            f"**Retention Loop:** `{'running' if retention_cleaner.is_running() else 'stopped'}`"
        ),
        inline=True,
    )
    embed.add_field(
        name="Data",
        value=(
            f"**Questions:** `{total_questions}`\n"
            f"**Used Pool:** `{len(state.get('used_questions', []))}`\n"
            f"**Open Posts:** `{open_posts_count}`\n"
            f"**DB:** `{'present' if db_exists else 'missing'}` ({db_size_kb:.1f} KB)"
        ),
        inline=True,
    )

    if missing_permissions:
        embed.add_field(
            name="Missing Permissions",
            value="\n".join(f"- {item}" for item in missing_permissions),
            inline=False,
        )

    add_warnings_field(embed, warnings)

    return embed


def build_analytics_embed() -> discord.Embed:
    metrics = metrics_snapshot()
    posts = list_post_records(limit=POST_RECORD_LIMIT)
    today = get_now().strftime("%Y-%m-%d")

    posts_today = sum(1 for post in posts if str(post.get("posted_at", "")).startswith(today))
    open_posts = sum(1 for post in posts if not post.get("closed", False))
    total_answers = count_all_answer_records()
    post_count = max(len(posts), 1)
    average_answers = total_answers / post_count

    by_category = metrics.get("posts_by_category", {})
    top_categories = sorted(by_category.items(), key=lambda item: int(item[1]), reverse=True)[:5]
    category_lines = "\n".join(f"- `{cat}`: `{count}`" for cat, count in top_categories) or "No data yet."

    usage = metrics.get("command_usage", {})
    top_commands = sorted(usage.items(), key=lambda item: int(item[1]), reverse=True)[:8]
    command_lines = "\n".join(f"- `{name}`: `{count}`" for name, count in top_commands) or "No command usage yet."

    embed = discord.Embed(
        title="Court Analytics",
        description="Usage and engagement snapshot.",
        color=ROLE_COLOR,
        timestamp=get_now(),
    )
    embed.add_field(
        name="Posts",
        value=(
            f"**Lifetime Total:** `{metrics.get('posts_total', 0)}`\n"
            f"**Auto Posts:** `{metrics.get('posts_auto', 0)}`\n"
            f"**Manual Posts:** `{metrics.get('posts_manual', 0)}`\n"
            f"**Custom Posts:** `{metrics.get('custom_posts', 0)}`\n"
            f"**Posts Today (recent window):** `{posts_today}`\n"
            f"**Open Posts:** `{open_posts}`"
        ),
        inline=False,
    )
    embed.add_field(
        name="Engagement",
        value=(
            f"**Tracked Answers:** `{metrics.get('answers_total', 0)}`\n"
            f"**Current Answer Records:** `{total_answers}`\n"
            f"**Avg Answers per Post (recent window):** `{average_answers:.2f}`"
        ),
        inline=False,
    )
    embed.add_field(name="Top Categories", value=category_lines, inline=True)
    embed.add_field(name="Top Commands", value=command_lines, inline=True)
    return embed


def build_user_fun_metrics_embed(member: discord.Member, stats: dict[str, int]) -> discord.Embed:
    embed = discord.Embed(
        title=f"{member.display_name}'s Court Activity",
        description="Just-for-fun community activity tracking.",
        color=ROLE_COLOR,
        timestamp=get_now(),
    )

    for metric_name, label in USER_FUN_METRIC_FIELDS:
        embed.add_field(name=label, value=f"`{int(stats.get(metric_name, 0))}`", inline=True)

    embed.set_footer(text="Stats are tracked from this bot runtime onward.")
    return embed


def get_fate_reading(roll: int) -> tuple[str, str]:
    normalized_roll = max(1, min(100, int(roll)))

    if normalized_roll <= 10:
        return "Dire Omen", "Storm clouds gather. Move carefully and trust fewer people."
    if normalized_roll <= 30:
        return "Trial Ahead", "A test is coming. Discipline beats luck today."
    if normalized_roll <= 70:
        return "Balanced Winds", "No doom, no blessing. Your choices decide the outcome."
    if normalized_roll <= 90:
        return "Favorable Tide", "Momentum is with you. Strike while your name carries weight."

    return "Imperial Blessing", "The throne smiles. Ask for more than you think you deserve."


def get_member_display_name(member: object) -> str:
    display_name = getattr(member, "display_name", None)
    if isinstance(display_name, str) and display_name:
        return display_name

    name = getattr(member, "name", None)
    if isinstance(name, str) and name:
        return name

    return "Courtier"


def get_member_mention(member: object) -> str:
    mention = getattr(member, "mention", None)
    if isinstance(mention, str) and mention:
        return mention
    return get_member_display_name(member)


def question_fingerprint(question: str) -> str:
    lowered = question.casefold()
    return " ".join(re.findall(r"[a-z0-9']+", lowered))


def collect_question_duplicates(questions: dict) -> tuple[list[tuple[str, str]], list[str]]:
    seen: dict[str, tuple[str, str]] = {}
    duplicates: list[str] = []
    all_items: list[tuple[str, str]] = []

    for category, items in questions.items():
        for question in items:
            fp = question_fingerprint(question)
            all_items.append((category, question))
            if fp in seen:
                previous_category, previous_question = seen[fp]
                duplicates.append(
                    f"- `{category}` duplicates `{previous_category}`: {question}"
                    if question != previous_question
                    else f"- `{category}` duplicate: {question}"
                )
            else:
                seen[fp] = (category, question)

    return all_items, duplicates


def find_near_duplicates(all_items: list[tuple[str, str]]) -> list[str]:
    near_duplicates: list[str] = []
    limit = min(len(all_items), 80)
    for i in range(limit):
        cat_a, q_a = all_items[i]
        fp_a = question_fingerprint(q_a)
        for j in range(i + 1, limit):
            cat_b, q_b = all_items[j]
            fp_b = question_fingerprint(q_b)
            if fp_a == fp_b:
                continue
            score = SequenceMatcher(None, fp_a, fp_b).ratio()
            if score >= 0.92:
                near_duplicates.append(f"- `{cat_a}` vs `{cat_b}` ({score:.2f}): {q_a}")
            if len(near_duplicates) >= 10:
                return near_duplicates
    return near_duplicates


def find_question_length_outliers(all_items: list[tuple[str, str]]) -> tuple[list[str], list[str]]:
    short_questions = [f"- `{cat}`: {q}" for cat, q in all_items if len(q) < 20][:10]
    long_questions = [f"- `{cat}`: {q}" for cat, q in all_items if len(q) > 160][:10]
    return short_questions, long_questions


def build_question_audit_report() -> str:
    questions = get_questions()
    all_items, duplicates = collect_question_duplicates(questions)
    near_duplicates = find_near_duplicates(all_items)
    short_questions, long_questions = find_question_length_outliers(all_items)

    lines = ["**Question Audit Report**"]
    lines.append(f"**Total Questions:** `{len(all_items)}`")
    lines.append(f"**Exact Duplicates:** `{len(duplicates)}`")
    if duplicates:
        lines.append("\n".join(duplicates[:10]))
    lines.append(f"**Near Duplicates:** `{len(near_duplicates)}`")
    if near_duplicates:
        lines.append("\n".join(near_duplicates))
    lines.append(f"**Very Short (<20 chars):** `{len(short_questions)}`")
    if short_questions:
        lines.append("\n".join(short_questions))
    lines.append(f"**Very Long (>160 chars):** `{len(long_questions)}`")
    if long_questions:
        lines.append("\n".join(long_questions))

    return "\n".join(lines)


def merge_imported_state(imported: dict) -> dict:
    base = get_state()
    allowed_keys = {
        "mode",
        "hour",
        "minute",
        "channel_id",
        "log_channel_id",
        "last_posted_date",
        "dry_run_auto_post",
        "last_dry_run_date",
        "last_weekly_digest_week",
        "history",
        "used_questions",
        "posts",
        "metrics",
        "royal_presence",
        "royal_afk",
    }
    for key in allowed_keys:
        if key in imported:
            base[key] = imported[key]
    return base


def as_utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def remaining_anonymous_cooldown_seconds(user_id: int) -> int:
    if ANON_COOLDOWN_SECONDS <= 0:
        return 0

    last_answer_at = as_utc(get_last_answer_time_for_user(user_id))
    if last_answer_at is None:
        return 0

    now_utc = datetime.now(timezone.utc)
    elapsed = int((now_utc - last_answer_at).total_seconds())
    return max(ANON_COOLDOWN_SECONDS - elapsed, 0)


def validate_anonymous_answer_submission(member: discord.Member, answer_text: str) -> str | None:
    now_utc = datetime.now(timezone.utc)

    if ANON_REQUIRED_ROLE_ID and not any(role.id == ANON_REQUIRED_ROLE_ID for role in member.roles):
        return "You are not eligible to submit anonymous court answers yet."

    account_created = as_utc(getattr(member, "created_at", None))
    if ANON_MIN_ACCOUNT_AGE_MINUTES > 0 and account_created is not None:
        account_age = now_utc - account_created
        required = timedelta(minutes=ANON_MIN_ACCOUNT_AGE_MINUTES)
        if account_age < required:
            remaining = required - account_age
            return (
                "Your account is too new to use anonymous answers. "
                f"Try again in `{format_duration(remaining)}`."
            )

    joined_at = as_utc(getattr(member, "joined_at", None))
    if ANON_MIN_MEMBER_AGE_MINUTES > 0 and joined_at is not None:
        member_age = now_utc - joined_at
        required = timedelta(minutes=ANON_MIN_MEMBER_AGE_MINUTES)
        if member_age < required:
            remaining = required - member_age
            return (
                "You need more time in this server before using anonymous answers. "
                f"Try again in `{format_duration(remaining)}`."
            )

    cooldown_left = remaining_anonymous_cooldown_seconds(member.id)
    if cooldown_left > 0:
        return (
            "You are on cooldown for anonymous answers. "
            f"Try again in `{format_duration(timedelta(seconds=cooldown_left))}`."
        )

    if not ANON_ALLOW_LINKS and URL_PATTERN.search(answer_text):
        return "Links are currently disabled for anonymous answers."

    return None


class AnonymousAnswerModal(discord.ui.Modal, title="Anonymous Court Answer"):
    answer = discord.ui.TextInput(
        label="Your answer",
        style=discord.TextStyle.paragraph,
        placeholder="Write your answer here...",
        required=True,
        max_length=1000,
    )

    def __init__(self, question: str):
        super().__init__(timeout=None)
        self.question = question

    async def on_submit(self, interaction: discord.Interaction) -> None:
        if interaction.message is None:
            await interaction.response.send_message(
                "Could not find the original court post.",
                ephemeral=True,
            )
            return

        if interaction.user is None:
            await interaction.response.send_message(
                "Could not verify your account.",
                ephemeral=True,
            )
            return

        if not isinstance(interaction.user, discord.Member):
            await interaction.response.send_message(
                MSG_USE_IN_SERVER,
                ephemeral=True,
            )
            return

        post_record = get_post_record(interaction.message.id)
        if post_record and post_record.get("closed", False):
            await interaction.response.send_message(
                MSG_INQUIRY_CLOSED,
                ephemeral=True,
            )
            return

        question_message_id = interaction.message.id
        user_id = interaction.user.id

        validation_error = validate_anonymous_answer_submission(interaction.user, self.answer.value)
        if validation_error is not None:
            await interaction.response.send_message(validation_error, ephemeral=True)
            return

        if has_user_answered(question_message_id, user_id):
            await interaction.response.send_message(
                "You already answered this court inquiry.",
                ephemeral=True,
            )
            return

        thread = await get_or_create_answer_thread(interaction.message)
        if thread is None:
            await interaction.response.send_message(
                "Could not create or find the reply thread. Check the bot's thread permissions.",
                ephemeral=True,
            )
            return

        if thread.locked:
            await interaction.response.send_message(
                MSG_INQUIRY_CLOSED,
                ephemeral=True,
            )
            return

        answer_number = next_answer_number(question_message_id)

        embed = discord.Embed(
            title=f"Anonymous Answer #{answer_number}",
            description=self.answer.value,
            color=ROLE_COLOR,
            timestamp=get_now(),
        )
        embed.set_footer(text="Submitted anonymously")

        sent = await thread.send(embed=embed)
        mark_user_answered(question_message_id, user_id, sent.id)
        record_answer_metric()

        await interaction.response.send_message(
            f"Your anonymous answer has been posted in {thread.mention}.",
            ephemeral=True,
        )


class AnonymousAnswerView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(
        label="Answer Anonymously",
        style=discord.ButtonStyle.secondary,
        custom_id="court:anonymous_answer",
    )
    async def anonymous_answer_button(
        self,
        interaction: discord.Interaction,
        button: discord.ui.Button,
    ) -> None:
        if interaction.message is None:
            await interaction.response.send_message(
                "Could not find the court inquiry.",
                ephemeral=True,
            )
            return

        post_record = get_post_record(interaction.message.id)
        if post_record and post_record.get("closed", False):
            await interaction.response.send_message(
                MSG_INQUIRY_CLOSED,
                ephemeral=True,
            )
            return

        question = extract_question_from_message(interaction.message)
        await interaction.response.send_modal(AnonymousAnswerModal(question))


async def post_question(
    channel: discord.TextChannel,
    category: str | None = None,
    randomize: bool = True,
    source: str = "manual",
    mention_everyone: bool = False,
) -> tuple[str, str]:
    chosen_category, question = pick_question(category, randomize)
    embed = build_embed(chosen_category, question)
    content, allowed_mentions = build_announcement_mentions(mention_everyone)

    sent = await channel.send(
        content=content,
        embed=embed,
        view=AnonymousAnswerView(),
        allowed_mentions=allowed_mentions,
    )
    thread = await get_or_create_answer_thread(sent)

    if thread is not None:
        await thread.send(
            "**Anonymous Court Replies**\n"
            "- One anonymous answer per person\n"
            "- Stay on topic\n"
            "- Anonymous does not mean consequence-free\n"
            f"- This thread will close automatically after {THREAD_CLOSE_HOURS} hours"
        )

    record = {
        "message_id": str(sent.id),
        "thread_id": str(thread.id) if thread else None,
        "channel_id": str(channel.id),
        "category": chosen_category,
        "question": question,
        "posted_at": iso_now(),
        "close_after_hours": THREAD_CLOSE_HOURS,
        "closed": False,
        "closed_at": None,
        "close_reason": None,
    }
    upsert_post_record(record)

    register_used_question(question)
    record_post_metric(chosen_category, source)

    state = get_state()
    state["last_posted_date"] = get_now().strftime("%Y-%m-%d")
    save_state(state)

    return chosen_category, question


class ImperialCourtBot(commands.Bot):
    async def setup_hook(self) -> None:
        guild = discord.Object(id=TEST_GUILD_ID)
        self.tree.add_command(court_group, guild=guild)
        self.tree.add_command(admin_group, guild=guild)
        self.tree.add_command(fun_group, guild=guild)
        self.tree.add_command(greetings_group, guild=guild)
        self.add_view(AnonymousAnswerView())
        self.add_view(RolePanelView(button_labels=[f"Role {i}" for i in range(1, ROLE_PANEL_MAX_BUTTONS + 1)]))
        synced = await self.tree.sync(guild=guild)
        logger.info("Synced %s command(s) to guild %s", len(synced), TEST_GUILD_ID)
        auto_poster.start()
        thread_closer.start()
        weekly_digest.start()
        retention_cleaner.start()


intents = discord.Intents.default()
intents.members = True
intents.message_content = True
bot = ImperialCourtBot(command_prefix=commands.when_mentioned, intents=intents)


async def require_staff(interaction: discord.Interaction) -> bool:
    if interaction.guild is None:
        await interaction.response.send_message(MSG_USE_IN_SERVER, ephemeral=True)
        return False

    if not isinstance(interaction.user, discord.Member):
        await interaction.response.send_message(MSG_VERIFY_ROLES, ephemeral=True)
        return False

    if not is_staff(interaction.user):
        await interaction.response.send_message("You do not have permission to use this command.", ephemeral=True)
        return False

    return True


async def require_admin(interaction: discord.Interaction) -> bool:
    if interaction.guild is None:
        await interaction.response.send_message(MSG_USE_IN_SERVER, ephemeral=True)
        return False

    if not isinstance(interaction.user, discord.Member):
        await interaction.response.send_message(MSG_VERIFY_ROLES, ephemeral=True)
        return False

    if not is_admin(interaction.user):
        await interaction.response.send_message(MSG_ADMIN_ONLY, ephemeral=True)
        return False

    return True


async def require_royal(interaction: discord.Interaction) -> tuple[discord.Guild, discord.Member, list[str]] | None:
    if interaction.guild is None:
        await interaction.response.send_message(MSG_USE_IN_SERVER, ephemeral=True)
        return None

    if not isinstance(interaction.user, discord.Member):
        await interaction.response.send_message(MSG_VERIFY_ROLES, ephemeral=True)
        return None

    titles = get_member_royal_titles(interaction.user)
    if not titles:
        await interaction.response.send_message(MSG_ROYAL_ONLY, ephemeral=True)
        return None

    return interaction.guild, interaction.user, titles


court_group = app_commands.Group(name="court", description="Imperial Court controls")
questions_group = app_commands.Group(name="questions", description="Question utilities")
court_group.add_command(questions_group)
admin_group = app_commands.Group(name="invictus", description="Server admin and moderation tools")
fun_group = app_commands.Group(name="fun", description="Fun commands for everyone")
greetings_group = app_commands.Group(name="greetings", description="Friendly greeting commands")


def get_manage_target_channel(interaction: discord.Interaction) -> discord.TextChannel | None:
    if interaction.channel is None:
        return None
    if isinstance(interaction.channel, discord.TextChannel):
        return interaction.channel
    return None


def can_member_manage_role(member: discord.Member, role: discord.Role) -> bool:
    if member.id == member.guild.owner_id:
        return True
    return member.top_role > role


def get_role_panel_role_error(actor: discord.Member, me: discord.Member, role: discord.Role) -> str | None:
    if role.is_default():
        return "You cannot create a panel for @everyone."

    if role.managed:
        return "Managed/integration roles cannot be self-assigned."

    if not can_member_manage_role(actor, role):
        return "You can only create panels for roles lower than your highest role."

    if not me.guild_permissions.manage_roles:
        return "I need Manage Roles permission to grant roles."

    if me.top_role <= role:
        return "I cannot grant that role because it is above or equal to my top role."

    return None


def get_role_panel_channel_permission_error(channel: discord.TextChannel, me: discord.Member) -> str | None:
    channel_permissions = channel.permissions_for(me)
    missing_permissions = []
    if not channel_permissions.view_channel:
        missing_permissions.append("View Channel")
    if not channel_permissions.send_messages:
        missing_permissions.append("Send Messages")
    if not channel_permissions.embed_links:
        missing_permissions.append("Embed Links")

    if not missing_permissions:
        return None

    return "I am missing required channel permissions: " + ", ".join(missing_permissions)


def collect_role_panel_roles(
    role_1: discord.Role,
    role_2: discord.Role,
    role_3: discord.Role | None = None,
    role_4: discord.Role | None = None,
    role_5: discord.Role | None = None,
) -> tuple[list[discord.Role], str | None]:
    selected_roles = [role_1, role_2]
    for optional_role in (role_3, role_4, role_5):
        if optional_role is not None:
            selected_roles.append(optional_role)

    unique_ids: set[int] = set()
    for selected_role in selected_roles:
        if selected_role.id in unique_ids:
            return [], "Each role in a multi panel must be unique."
        unique_ids.add(selected_role.id)

    return selected_roles, None


def get_multi_role_panel_error(actor: discord.Member, me: discord.Member, roles: list[discord.Role]) -> str | None:
    for selected_role in roles:
        role_error = get_role_panel_role_error(actor, me, selected_role)
        if role_error is not None:
            return f"{selected_role.mention}: {role_error}"

    return None


def is_confirmed(value: str) -> bool:
    return value.strip().upper() == "CONFIRM"


async def get_admin_context(
    interaction: discord.Interaction,
) -> tuple[discord.Guild, discord.Member] | None:
    if interaction.guild is None:
        await interaction.response.send_message(MSG_USE_IN_SERVER, ephemeral=True)
        return None

    if not isinstance(interaction.user, discord.Member):
        await interaction.response.send_message(MSG_VERIFY_ROLES, ephemeral=True)
        return None

    return interaction.guild, interaction.user


async def send_admin_log(
    guild: discord.Guild,
    actor: discord.Member,
    title: str,
    details: list[str],
) -> None:
    description = "\n".join([f"**By:** {actor.mention}", *details])
    await send_log(guild, title, description)


def parse_member_ids(raw: str) -> list[int]:
    seen = set()
    parsed = []

    for value in re.findall(r"\d{15,20}", raw):
        member_id = int(value)
        if member_id not in seen:
            seen.add(member_id)
            parsed.append(member_id)

    return parsed


async def resolve_members(guild: discord.Guild, member_ids: list[int]) -> tuple[list[discord.Member], list[int]]:
    found: list[discord.Member] = []
    missing: list[int] = []

    for member_id in member_ids:
        member = guild.get_member(member_id)
        if member is None:
            try:
                member = await guild.fetch_member(member_id)
            except Exception:
                missing.append(member_id)
                continue

        found.append(member)

    return found, missing


def can_timeout_target(
    actor: discord.Member,
    me: discord.Member,
    target: discord.Member,
) -> tuple[bool, str]:
    if target.bot:
        return False, "target is a bot"

    if target.id == me.id:
        return False, "target is the bot"

    if target.id == actor.guild.owner_id:
        return False, "target is the server owner"

    if target.id == actor.id:
        return False, "target is yourself"

    if me.top_role <= target.top_role:
        return False, "bot role is not high enough"

    if actor.id != actor.guild.owner_id and actor.top_role <= target.top_role:
        return False, "your role is not high enough"

    return True, ""


async def set_member_timeout(
    member: discord.Member,
    until: datetime | None,
    reason: str,
) -> tuple[bool, str | None]:
    try:
        await member.timeout(until, reason=reason)
        return True, None
    except discord.Forbidden:
        return False, "missing permissions"
    except discord.HTTPException:
        return False, "discord API error"


async def get_timeout_context(
    interaction: discord.Interaction,
) -> tuple[discord.Guild, discord.Member, discord.Member] | None:
    admin_context = await get_admin_context(interaction)
    if admin_context is None:
        return None
    guild, actor = admin_context

    me = guild.me
    if me is None:
        await interaction.response.send_message(MSG_BOT_CONTEXT_ERROR, ephemeral=True)
        return None

    return guild, actor, me


def build_timeout_reason(action: str, user: discord.Member, reason: str | None) -> str:
    base = f"{action} by {user} via /admin"
    if reason:
        return f"{base} | {reason}"
    return base


def normalize_trigger_phrase(content: str) -> str:
    cleaned = re.sub(r"[^a-z0-9'\s]", " ", content.casefold())
    return " ".join(cleaned.split())


def parse_reply_mute_message(content: str) -> str | None:
    for pattern in REPLY_MUTE_PATTERNS:
        match = pattern.match(content)
        if match is not None:
            reason = match.group(1) if match.lastindex else ""
            return reason.strip()

    return None


def is_silence_lock_trigger(content: str) -> bool:
    return normalize_trigger_phrase(content) in SILENCE_LOCK_PHRASES


def is_emperor_lock_trigger(content: str) -> bool:
    return normalize_trigger_phrase(content) in EMPEROR_LOCK_PHRASES


def has_emperor_mention(content: str) -> bool:
    return EMPEROR_MENTION_PATTERN.search(content) is not None


def has_empress_mention(content: str) -> bool:
    return EMPRESS_MENTION_PATTERN.search(content) is not None


def parse_royal_mentions(content: str) -> list[str]:
    mentioned: list[str] = []
    if has_emperor_mention(content):
        mentioned.append("Emperor")
    if has_empress_mention(content):
        mentioned.append("Empress")
    return mentioned


def parse_royal_member_mentions(mentioned_members: list[object] | None) -> list[str]:
    if not mentioned_members:
        return []

    mentioned_titles: list[str] = []
    for mentioned_member in mentioned_members:
        for title in get_member_royal_titles(mentioned_member):
            if title not in mentioned_titles:
                mentioned_titles.append(title)
    return mentioned_titles


def is_royal_alert_channel(channel_id: int | None) -> bool:
    return int(channel_id or 0) == ROYAL_ALERT_CHANNEL_ID


def get_member_royal_titles(member: discord.Member | object) -> list[str]:
    titles: list[str] = []
    for role in getattr(member, "roles", []):
        role_id = getattr(role, "id", 0)
        if role_id == EMPEROR_ROLE_ID and "Emperor" not in titles:
            titles.append("Emperor")
        if role_id == EMPRESS_ROLE_ID and "Empress" not in titles:
            titles.append("Empress")
    return titles


def get_royal_title(member: discord.Member) -> str | None:
    titles = get_member_royal_titles(member)
    return titles[0] if titles else None


def build_royal_afk_status_line(title: str, afk_entry: dict, now: datetime) -> str:
    reason = str(afk_entry.get("reason") or "Away from court")
    set_at = parse_iso(afk_entry.get("set_at"))
    if set_at is None:
        return f"The {title} is currently AFK: {reason}"
    return f"The {title} is currently AFK ({format_duration(now - set_at)}): {reason}"


def get_royal_afk_response(
    content: str,
    mentioned_members: list[object] | None = None,
    state: dict | None = None,
    now: datetime | None = None,
) -> str | None:
    mentioned_titles = parse_royal_mentions(content)
    for title in parse_royal_member_mentions(mentioned_members):
        if title not in mentioned_titles:
            mentioned_titles.append(title)

    if not mentioned_titles:
        return None

    effective_state = state if state is not None else get_state()
    royal_afk = ensure_royal_afk_shape(effective_state.get("royal_afk", {}))
    by_title = royal_afk.get("by_title", {})
    current_time = now or get_now()

    lines: list[str] = []
    for title in mentioned_titles:
        entry = by_title.get(title, {})
        if bool(entry.get("active", False)):
            lines.append(build_royal_afk_status_line(title, entry, current_time))

    if not lines:
        return None

    return "\n".join(lines)


def build_royal_afk_status_report(state: dict | None = None, now: datetime | None = None) -> str:
    effective_state = state if state is not None else get_state()
    royal_afk = ensure_royal_afk_shape(effective_state.get("royal_afk", {}))
    by_title = royal_afk.get("by_title", {})
    current_time = now or get_now()

    lines: list[str] = []
    for title in ROYAL_TITLES:
        entry = by_title.get(title, {})
        if not bool(entry.get("active", False)):
            continue

        reason = str(entry.get("reason") or "Away from court")
        set_at = parse_iso(entry.get("set_at"))
        if set_at is None:
            lines.append(f"**{title}:** AFK - {reason}")
        else:
            lines.append(f"**{title}:** AFK for `{format_duration(current_time - set_at)}` - {reason}")

    if not lines:
        return "No royal AFK statuses are enabled."

    return "\n".join(lines)


def clear_member_royal_afk(member: discord.Member) -> list[str]:
    titles = get_member_royal_titles(member)
    if not titles:
        return []

    state = get_state()
    royal_afk = ensure_royal_afk_shape(state.get("royal_afk", {}))
    by_title = royal_afk.get("by_title", {})
    cleared: list[str] = []

    for title in titles:
        entry = by_title.get(title, {})
        if bool(entry.get("active", False)):
            cleared.append(title)

        by_title[title] = {
            "active": False,
            "reason": "",
            "set_at": None,
            "set_by_user_id": None,
        }

    if cleared:
        royal_afk["by_title"] = by_title
        state["royal_afk"] = royal_afk
        save_state(state)

    return cleared


def should_announce_royal_presence(previous_message_at: datetime | None, current_message_at: datetime) -> bool:
    if previous_message_at is None:
        return True
    return (current_message_at - previous_message_at) >= timedelta(hours=ROYAL_PRESENCE_INTERVAL_HOURS)


async def handle_royal_presence_announcement(message: discord.Message) -> None:
    royal_title = get_royal_title(message.author)
    if royal_title is None:
        return

    state = get_state()
    royal_presence = ensure_royal_presence_shape(state.get("royal_presence", {}))
    previous_message_at = parse_iso(royal_presence["last_message_at_by_title"].get(royal_title))

    created_at = getattr(message, "created_at", None)
    current_message_at = created_at if created_at is not None else get_now()
    should_announce = should_announce_royal_presence(previous_message_at, current_message_at)

    royal_presence["last_message_at_by_title"][royal_title] = current_message_at.isoformat()
    royal_presence["last_message_at"] = current_message_at.isoformat()
    royal_presence["last_speaker"] = royal_title
    state["royal_presence"] = royal_presence
    save_state(state)

    if should_announce:
        await message.channel.send(
            f"# The {royal_title} has spoken",
            allowed_mentions=discord.AllowedMentions.none(),
        )


async def lock_channel_silently(channel: discord.TextChannel, actor: discord.Member, seconds: int = SILENT_LOCK_SECONDS) -> None:
    targets: list[discord.Role] = [
        role for role in actor.guild.roles
        if not role.permissions.administrator and role.id not in SILENT_LOCK_EXCLUDE_ROLES and not role.is_bot_managed()
    ]

    original_send_messages: dict[int, bool | None] = {}
    applied_targets: list[discord.Role] = []

    for role in targets:
        overwrite = channel.overwrites_for(role)
        original_send_messages[role.id] = overwrite.send_messages
        overwrite.send_messages = False
        try:
            await channel.set_permissions(role, overwrite=overwrite, reason=f"Silence by {actor}")
            applied_targets.append(role)
        except (discord.Forbidden, discord.HTTPException):
            continue

    if not applied_targets:
        return

    await asyncio.sleep(max(0, seconds))

    for role in applied_targets:
        restore_overwrite = channel.overwrites_for(role)
        restore_overwrite.send_messages = original_send_messages.get(role.id)
        try:
            await channel.set_permissions(role, overwrite=restore_overwrite, reason=f"Silence expired by {actor}")
        except (discord.Forbidden, discord.HTTPException):
            continue


async def get_replied_member(message: discord.Message) -> discord.Member | None:
    if message.reference is None or message.reference.message_id is None:
        return None

    target_message = message.reference.resolved
    if not isinstance(target_message, discord.Message):
        try:
            target_message = await message.channel.fetch_message(message.reference.message_id)
        except Exception:
            return None

    if isinstance(target_message.author, discord.Member):
        return target_message.author
    return None


async def send_mute_failed_embed(message: discord.Message, target: discord.Member, reason: str) -> None:
    embed = discord.Embed(
        title="Mute Failed",
        description=f"Could not mute {target.mention}: {reason}.",
        color=ROLE_COLOR,
        timestamp=get_now(),
    )
    await message.reply(embed=embed, mention_author=False)


async def handle_reply_mute_trigger(message: discord.Message, reason_text: str) -> None:
    if not is_admin(message.author):
        return

    target = await get_replied_member(message)
    if target is None:
        return

    me = message.guild.me
    if me is None:
        return

    allowed, why_not = can_timeout_target(message.author, me, target)
    if not allowed:
        await send_mute_failed_embed(message, target, why_not)
        return

    until = get_now() + timedelta(minutes=REPLY_MUTE_MINUTES)
    mod_reason = build_timeout_reason("Muted", message.author, reason_text or "reply command")
    ok, failure = await set_member_timeout(target, until, mod_reason)
    if not ok:
        await send_mute_failed_embed(message, target, failure or "unknown error")
        return

    embed = discord.Embed(
        title="Invictus Mute",
        description=f"{target.mention} has been muted for `{REPLY_MUTE_MINUTES}` minute(s).",
        color=ROLE_COLOR,
        timestamp=get_now(),
    )
    embed.add_field(name="By", value=message.author.mention, inline=True)
    embed.add_field(name="Reason", value=reason_text or "No reason provided.", inline=True)
    await message.channel.send(embed=embed)

    await send_log(
        message.guild,
        "Reply Mute Triggered",
        f"**By:** {message.author.mention}\n"
        f"**Target:** {target.mention}\n"
        f"**Minutes:** `{REPLY_MUTE_MINUTES}`\n"
        f"**Reason:** {reason_text or 'No reason provided.'}",
    )


async def maybe_send_royal_mention_response(message: discord.Message, in_royal_alert_channel: bool) -> bool:
    if not in_royal_alert_channel:
        return False

    mentioned_members = getattr(message, "mentions", None)

    afk_response = get_royal_afk_response(message.content, mentioned_members=mentioned_members)
    if afk_response is not None:
        await message.channel.send(
            afk_response,
            allowed_mentions=discord.AllowedMentions.none(),
        )
        return True

    return False


async def apply_timeout_to_targets(
    actor: discord.Member,
    me: discord.Member,
    targets: list[discord.Member],
    until: datetime | None,
    reason: str,
    only_if_timed_out: bool = False,
) -> tuple[int, int, int, list[str]]:
    applied = 0
    skipped = 0
    failed = 0
    details: list[str] = []

    for target in targets:
        allowed, why_not = can_timeout_target(actor, me, target)
        if not allowed:
            skipped += 1
            details.append(f"{target} ({why_not})")
            continue

        if only_if_timed_out and not target.is_timed_out():
            skipped += 1
            continue

        ok, failure = await set_member_timeout(target, until, reason)
        if ok:
            applied += 1
        else:
            failed += 1
            details.append(f"{target} ({failure})")

    return applied, skipped, failed, details


def build_target_cap_message(eligible_targets: int) -> str:
    return (
        f"Safety cap blocked this action. Eligible targets: `{eligible_targets}` exceeds cap `{MUTEALL_TARGET_CAP}`. "
        "Set `MUTEALL_TARGET_CAP=0` or raise the cap in config for larger actions."
    )


def preview_timeout_targets(
    actor: discord.Member,
    me: discord.Member,
    targets: list[discord.Member],
    only_if_timed_out: bool = False,
) -> tuple[int, int, list[str]]:
    eligible = 0
    skipped = 0
    details: list[str] = []

    for target in targets:
        allowed, why_not = can_timeout_target(actor, me, target)
        if not allowed:
            skipped += 1
            details.append(f"{target} ({why_not})")
            continue

        if only_if_timed_out and not target.is_timed_out():
            skipped += 1
            continue

        eligible += 1

    return eligible, skipped, details


class AdminSayModal(discord.ui.Modal, title="Send Announcement"):
    message_content = discord.ui.TextInput(
        label="Message",
        style=discord.TextStyle.paragraph,
        placeholder="Paste your announcement here...",
        required=True,
        max_length=2000,
    )

    def __init__(self, channel: discord.TextChannel, mention_everyone: bool = False):
        super().__init__(timeout=None)
        self.channel = channel
        self.mention_everyone = mention_everyone

    async def on_submit(self, interaction: discord.Interaction) -> None:
        if not isinstance(interaction.user, discord.Member):
            await interaction.response.send_message(MSG_VERIFY_ROLES, ephemeral=True)
            return

        if interaction.guild is None:
            await interaction.response.send_message(MSG_USE_IN_SERVER, ephemeral=True)
            return

        try:
            embed = discord.Embed(
                description=self.message_content.value,
                color=ROLE_COLOR,
                timestamp=get_now(),
            )
            content, allowed_mentions = build_announcement_mentions(self.mention_everyone)
            await self.channel.send(
                content=content,
                embed=embed,
                allowed_mentions=allowed_mentions,
            )
        except discord.Forbidden:
            await interaction.response.send_message("I do not have permission to send messages there.", ephemeral=True)
            return
        except discord.HTTPException:
            await interaction.response.send_message("Failed to send the message.", ephemeral=True)
            return

        await interaction.response.send_message(f"Announcement sent to {self.channel.mention}.", ephemeral=True)

        await send_admin_log(
            interaction.guild,
            interaction.user,
            "Admin Announcement Sent",
            [f"**Channel:** {self.channel.mention}", f"**Message:** {self.message_content.value}"],
        )


@admin_group.command(name="say", description="Send an admin announcement in a channel")
@app_commands.describe(channel="Target channel", mention_everyone="Whether to ping @everyone (default: false)")
async def admin_say(
    interaction: discord.Interaction,
    channel: discord.TextChannel,
    mention_everyone: bool = False,
) -> None:
    if not await require_admin(interaction):
        return

    await interaction.response.send_modal(AdminSayModal(channel, mention_everyone=mention_everyone))


@admin_group.command(name="rolepanel", description="Post an embed panel with a button that toggles a role")
@app_commands.describe(
    role="Role to toggle when the button is clicked",
    channel="Target text channel (defaults to current channel)",
    title="Optional embed title",
    description="Optional embed description",
    button_label="Optional button label (max 80 characters)",
    mention_everyone="Whether to ping @everyone above the panel",
)
async def admin_rolepanel(
    interaction: discord.Interaction,
    role: discord.Role,
    channel: discord.TextChannel | None = None,
    title: str | None = None,
    description: str | None = None,
    button_label: str | None = None,
    mention_everyone: bool = False,
) -> None:
    if not await require_admin(interaction):
        return

    admin_context = await get_admin_context(interaction)
    if admin_context is None:
        return
    guild, actor = admin_context

    target_channel = channel or get_manage_target_channel(interaction)
    if target_channel is None:
        await interaction.response.send_message(
            "Provide a text channel, or run this command from a text channel.",
            ephemeral=True,
        )
        return

    panel_button_label = (button_label or "").strip() or ROLE_PANEL_DEFAULT_BUTTON_LABEL
    if len(panel_button_label) > ROLE_PANEL_BUTTON_LABEL_MAX_LENGTH:
        await interaction.response.send_message(
            f"Button label must be {ROLE_PANEL_BUTTON_LABEL_MAX_LENGTH} characters or fewer.",
            ephemeral=True,
        )
        return

    me = guild.me
    if me is None:
        await interaction.response.send_message(MSG_BOT_CONTEXT_ERROR, ephemeral=True)
        return

    role_error = get_role_panel_role_error(actor, me, role)
    if role_error is not None:
        await interaction.response.send_message(role_error, ephemeral=True)
        return

    channel_error = get_role_panel_channel_permission_error(target_channel, me)
    if channel_error is not None:
        await interaction.response.send_message(channel_error, ephemeral=True)
        return

    panel_embed = build_role_panel_embed([role], title=title, description=description)
    panel_view = RolePanelView(button_labels=[panel_button_label])
    content, allowed_mentions = build_announcement_mentions(mention_everyone)

    try:
        await target_channel.send(
            content=content,
            embed=panel_embed,
            view=panel_view,
            allowed_mentions=allowed_mentions,
        )
    except discord.Forbidden:
        await interaction.response.send_message("I do not have permission to post in that channel.", ephemeral=True)
        return
    except discord.HTTPException:
        await interaction.response.send_message("Failed to create the role panel.", ephemeral=True)
        return

    await interaction.response.send_message(
        f"Role panel posted in {target_channel.mention} for {role.mention}.",
        ephemeral=True,
    )

    await send_admin_log(
        guild,
        actor,
        "Role Panel Created",
        [
            f"**Channel:** {target_channel.mention}",
            f"**Role:** {role.mention} (`{role.id}`)",
            f"**Button:** {panel_button_label}",
            f"**Mention Everyone:** {'Yes' if mention_everyone else 'No'}",
        ],
    )


@admin_group.command(name="rolepanelmulti", description="Post an embed panel with multiple role toggle buttons")
@app_commands.describe(
    role_1="First role button",
    role_2="Second role button",
    role_3="Optional third role button",
    role_4="Optional fourth role button",
    role_5="Optional fifth role button",
    channel="Target text channel (defaults to current channel)",
    title="Optional embed title",
    description="Optional embed description",
    mention_everyone="Whether to ping @everyone above the panel",
)
async def admin_rolepanelmulti(
    interaction: discord.Interaction,
    role_1: discord.Role,
    role_2: discord.Role,
    role_3: discord.Role | None = None,
    role_4: discord.Role | None = None,
    role_5: discord.Role | None = None,
    channel: discord.TextChannel | None = None,
    title: str | None = None,
    description: str | None = None,
    mention_everyone: bool = False,
) -> None:
    if not await require_admin(interaction):
        return

    admin_context = await get_admin_context(interaction)
    if admin_context is None:
        return
    guild, actor = admin_context

    target_channel = channel or get_manage_target_channel(interaction)
    if target_channel is None:
        await interaction.response.send_message(
            "Provide a text channel, or run this command from a text channel.",
            ephemeral=True,
        )
        return

    selected_roles, collection_error = collect_role_panel_roles(role_1, role_2, role_3, role_4, role_5)
    if collection_error is not None:
        await interaction.response.send_message(collection_error, ephemeral=True)
        return

    me = guild.me
    if me is None:
        await interaction.response.send_message(MSG_BOT_CONTEXT_ERROR, ephemeral=True)
        return

    role_error = get_multi_role_panel_error(actor, me, selected_roles)
    if role_error is not None:
        await interaction.response.send_message(role_error, ephemeral=True)
        return

    channel_error = get_role_panel_channel_permission_error(target_channel, me)
    if channel_error is not None:
        await interaction.response.send_message(channel_error, ephemeral=True)
        return

    panel_embed = build_role_panel_embed(selected_roles, title=title, description=description)
    panel_view = RolePanelView(button_labels=[selected_role.name for selected_role in selected_roles])
    content, allowed_mentions = build_announcement_mentions(mention_everyone)

    try:
        await target_channel.send(
            content=content,
            embed=panel_embed,
            view=panel_view,
            allowed_mentions=allowed_mentions,
        )
    except discord.Forbidden:
        await interaction.response.send_message("I do not have permission to post in that channel.", ephemeral=True)
        return
    except discord.HTTPException:
        await interaction.response.send_message("Failed to create the multi-role panel.", ephemeral=True)
        return

    await interaction.response.send_message(
        f"Multi-role panel posted in {target_channel.mention} with `{len(selected_roles)}` role button(s).",
        ephemeral=True,
    )

    role_lines = [f"- {selected_role.mention} (`{selected_role.id}`)" for selected_role in selected_roles]
    await send_admin_log(
        guild,
        actor,
        "Multi Role Panel Created",
        [
            f"**Channel:** {target_channel.mention}",
            "**Roles:**\n" + "\n".join(role_lines),
            f"**Mention Everyone:** {'Yes' if mention_everyone else 'No'}",
        ],
    )


@admin_group.command(name="purge", description="Delete recent messages in this channel")
@app_commands.describe(amount="How many recent messages to delete (1-100)")
async def admin_purge(
    interaction: discord.Interaction,
    amount: app_commands.Range[int, 1, 100],
) -> None:
    if not await require_admin(interaction):
        return

    channel = get_manage_target_channel(interaction)
    if channel is None:
        await interaction.response.send_message(MSG_USE_TEXT_CHANNEL, ephemeral=True)
        return

    await interaction.response.defer(ephemeral=True)

    try:
        deleted = await channel.purge(limit=amount)
    except discord.Forbidden:
        await interaction.followup.send("I do not have permission to manage messages here.", ephemeral=True)
        return
    except discord.HTTPException:
        await interaction.followup.send("Failed to purge messages.", ephemeral=True)
        return

    await interaction.followup.send(f"Deleted `{len(deleted)}` message(s) in {channel.mention}.", ephemeral=True)

    admin_context = await get_admin_context(interaction)
    if admin_context is None:
        return
    guild, actor = admin_context

    await send_admin_log(
        guild,
        actor,
        "Admin Purge",
        [
            f"**Channel:** {channel.mention}",
            f"**Requested:** `{amount}`",
            f"**Deleted:** `{len(deleted)}`",
        ],
    )


@admin_group.command(name="purgeuser", description="Delete recent messages from one member in this channel")
@app_commands.describe(member="Member whose messages to remove", amount="How many recent messages to scan (1-200)")
async def admin_purgeuser(
    interaction: discord.Interaction,
    member: discord.Member,
    amount: app_commands.Range[int, 1, 200] = 100,
) -> None:
    if not await require_admin(interaction):
        return

    channel = get_manage_target_channel(interaction)
    if channel is None:
        await interaction.response.send_message(MSG_USE_TEXT_CHANNEL, ephemeral=True)
        return

    await interaction.response.defer(ephemeral=True)

    try:
        deleted = await channel.purge(limit=amount, check=lambda m: m.author.id == member.id)
    except discord.Forbidden:
        await interaction.followup.send("I do not have permission to manage messages here.", ephemeral=True)
        return
    except discord.HTTPException:
        await interaction.followup.send("Failed to purge that member's messages.", ephemeral=True)
        return

    await interaction.followup.send(
        f"Deleted `{len(deleted)}` message(s) from {member.mention} in {channel.mention}.",
        ephemeral=True,
    )

    admin_context = await get_admin_context(interaction)
    if admin_context is None:
        return
    guild, actor = admin_context

    await send_admin_log(
        guild,
        actor,
        "Admin Purge User",
        [
            f"**Channel:** {channel.mention}",
            f"**Target:** {member.mention}",
            f"**Scanned:** `{amount}`",
            f"**Deleted:** `{len(deleted)}`",
        ],
    )


@admin_group.command(name="lock", description="Lock this channel for @everyone")
@app_commands.describe(reason="Optional reason")
async def admin_lock(
    interaction: discord.Interaction,
    reason: str | None = None,
) -> None:
    if not await require_admin(interaction):
        return

    channel = get_manage_target_channel(interaction)
    if channel is None:
        await interaction.response.send_message(MSG_USE_TEXT_CHANNEL, ephemeral=True)
        return

    everyone = interaction.guild.default_role
    overwrite = channel.overwrites_for(everyone)
    overwrite.send_messages = False

    try:
        await channel.set_permissions(everyone, overwrite=overwrite, reason=reason or "Channel locked via /admin lock")
    except discord.Forbidden:
        await interaction.response.send_message("I do not have permission to edit channel overrides.", ephemeral=True)
        return
    except discord.HTTPException:
        await interaction.response.send_message("Failed to lock this channel.", ephemeral=True)
        return

    await interaction.response.send_message("Channel locked for @everyone.", ephemeral=True)

    await send_log(
        interaction.guild,
        "Admin Channel Locked",
        f"**By:** {interaction.user.mention}\n**Channel:** {channel.mention}\n**Reason:** {reason or 'No reason provided.'}",
    )


@admin_group.command(name="unlock", description="Unlock this channel for @everyone")
@app_commands.describe(reason="Optional reason")
async def admin_unlock(
    interaction: discord.Interaction,
    reason: str | None = None,
) -> None:
    if not await require_admin(interaction):
        return

    channel = get_manage_target_channel(interaction)
    if channel is None:
        await interaction.response.send_message(MSG_USE_TEXT_CHANNEL, ephemeral=True)
        return

    everyone = interaction.guild.default_role
    overwrite = channel.overwrites_for(everyone)
    overwrite.send_messages = True

    try:
        await channel.set_permissions(everyone, overwrite=overwrite, reason=reason or "Channel unlocked via /admin unlock")
    except discord.Forbidden:
        await interaction.response.send_message("I do not have permission to edit channel overrides.", ephemeral=True)
        return
    except discord.HTTPException:
        await interaction.response.send_message("Failed to unlock this channel.", ephemeral=True)
        return

    await interaction.response.send_message("Channel unlocked for @everyone.", ephemeral=True)

    await send_log(
        interaction.guild,
        "Admin Channel Unlocked",
        f"**By:** {interaction.user.mention}\n**Channel:** {channel.mention}\n**Reason:** {reason or 'No reason provided.'}",
    )


@admin_group.command(name="slowmode", description="Set slowmode for this channel")
@app_commands.describe(seconds="Slowmode delay in seconds (0-21600)")
async def admin_slowmode(
    interaction: discord.Interaction,
    seconds: app_commands.Range[int, 0, 21600],
) -> None:
    if not await require_admin(interaction):
        return

    channel = get_manage_target_channel(interaction)
    if channel is None:
        await interaction.response.send_message(MSG_USE_TEXT_CHANNEL, ephemeral=True)
        return

    try:
        await channel.edit(slowmode_delay=seconds, reason=f"Updated by {interaction.user}")
    except discord.Forbidden:
        await interaction.response.send_message("I do not have permission to edit this channel.", ephemeral=True)
        return
    except discord.HTTPException:
        await interaction.response.send_message("Failed to update slowmode.", ephemeral=True)
        return

    await interaction.response.send_message(
        f"Slowmode set to `{seconds}` second(s) in {channel.mention}.",
        ephemeral=True,
    )

    await send_log(
        interaction.guild,
        "Admin Slowmode Updated",
        f"**By:** {interaction.user.mention}\n**Channel:** {channel.mention}\n**Seconds:** `{seconds}`",
    )


@admin_group.command(name="timeout", description="Timeout one member")
@app_commands.describe(member="Member to timeout", minutes="Timeout duration in minutes (1-40320)", reason="Optional reason")
async def admin_timeout(
    interaction: discord.Interaction,
    member: discord.Member,
    minutes: app_commands.Range[int, 1, MAX_TIMEOUT_MINUTES],
    reason: str | None = None,
) -> None:
    if not await require_admin(interaction):
        return

    context = await get_timeout_context(interaction)
    if context is None:
        return
    guild, actor, me = context

    allowed, why_not = can_timeout_target(actor, me, member)
    if not allowed:
        await interaction.response.send_message(f"Cannot timeout {member.mention}: {why_not}.", ephemeral=True)
        return

    until = get_now() + timedelta(minutes=minutes)
    mod_reason = build_timeout_reason("Muted", actor, reason)
    ok, failure = await set_member_timeout(member, until, mod_reason)
    if not ok:
        await interaction.response.send_message(f"Failed to timeout {member.mention}: {failure}.", ephemeral=True)
        return

    await interaction.response.send_message(
        f"Timed out {member.mention} for `{minutes}` minute(s).",
        ephemeral=True,
    )

    await send_admin_log(
        guild,
        actor,
        "Admin Timeout",
        [
            f"**Target:** {member.mention}",
            f"**Minutes:** `{minutes}`",
            f"**Reason:** {reason or 'No reason provided.'}",
        ],
    )


@admin_group.command(name="untimeout", description="Remove timeout from one member")
@app_commands.describe(member="Member to untimeout", reason="Optional reason")
async def admin_untimeout(
    interaction: discord.Interaction,
    member: discord.Member,
    reason: str | None = None,
) -> None:
    if not await require_admin(interaction):
        return

    context = await get_timeout_context(interaction)
    if context is None:
        return
    guild, actor, me = context

    allowed, why_not = can_timeout_target(actor, me, member)
    if not allowed:
        await interaction.response.send_message(f"Cannot untimeout {member.mention}: {why_not}.", ephemeral=True)
        return

    if not member.is_timed_out():
        await interaction.response.send_message(f"{member.mention} is not currently timed out.", ephemeral=True)
        return

    mod_reason = build_timeout_reason("Unmuted", actor, reason)
    ok, failure = await set_member_timeout(member, None, mod_reason)
    if not ok:
        await interaction.response.send_message(f"Failed to untimeout {member.mention}: {failure}.", ephemeral=True)
        return

    await interaction.response.send_message(
        f"Removed timeout from {member.mention}.",
        ephemeral=True,
    )

    await send_admin_log(
        guild,
        actor,
        "Admin Untimeout",
        [
            f"**Target:** {member.mention}",
            f"**Reason:** {reason or 'No reason provided.'}",
        ],
    )


@admin_group.command(name="mutemany", description="Timeout multiple members at once")
@app_commands.describe(
    members="Mentions or user IDs separated by spaces",
    minutes="Timeout duration in minutes (1-40320)",
    dry_run="Preview impacts without applying timeouts",
    reason="Optional reason",
)
async def admin_mutemany(
    interaction: discord.Interaction,
    members: str,
    minutes: app_commands.Range[int, 1, MAX_TIMEOUT_MINUTES],
    dry_run: bool = False,
    reason: str | None = None,
) -> None:
    if not await require_admin(interaction):
        return

    context = await get_timeout_context(interaction)
    if context is None:
        return
    guild, actor, me = context

    member_ids = parse_member_ids(members)
    if not member_ids:
        await interaction.response.send_message("No valid member mentions or IDs were provided.", ephemeral=True)
        return

    await interaction.response.defer(ephemeral=True)

    targets, missing_ids = await resolve_members(guild, member_ids)
    eligible, preview_skipped, preview_details = preview_timeout_targets(actor, me, targets)

    if MUTEALL_TARGET_CAP > 0 and eligible > MUTEALL_TARGET_CAP:
        await interaction.followup.send(build_target_cap_message(eligible), ephemeral=True)
        return

    if dry_run:
        summary = (
            f"Dry run only: would mute `{eligible}` member(s) for `{minutes}` minute(s).\n"
            f"Skipped during preview: `{preview_skipped}` | Unknown IDs: `{len(missing_ids)}`"
        )
        if preview_details:
            summary += PREVIEW_ISSUES_PREFIX + "\n".join(f"- {line}" for line in preview_details[:10])
        await interaction.followup.send(summary, ephemeral=True)
        return

    mute_until = get_now() + timedelta(minutes=minutes)
    mod_reason = build_timeout_reason("Muted", actor, reason)
    applied, skipped, failed, skipped_details = await apply_timeout_to_targets(
        actor,
        me,
        targets,
        mute_until,
        mod_reason,
    )

    summary = (
        f"Muted `{applied}` member(s) for `{minutes}` minute(s).\n"
        f"Skipped: `{skipped}` | Failed: `{failed}` | Unknown IDs: `{len(missing_ids)}`"
    )
    if skipped_details:
        summary += "\n\nIssues:\n" + "\n".join(f"- {line}" for line in skipped_details[:10])

    await interaction.followup.send(summary, ephemeral=True)

    await send_log(
        guild,
        "Admin Mute Many",
        f"**By:** {actor.mention}\n"
        f"**Minutes:** `{minutes}`\n"
        f"**Applied:** `{applied}`\n"
        f"**Skipped:** `{skipped}`\n"
        f"**Failed:** `{failed}`\n"
        f"**Unknown IDs:** `{len(missing_ids)}`\n"
        f"**Reason:** {reason or 'No reason provided.'}",
    )


@admin_group.command(name="unmutemany", description="Remove timeout from multiple members")
@app_commands.describe(
    members="Mentions or user IDs separated by spaces",
    dry_run="Preview impacts without removing timeouts",
    reason="Optional reason",
)
async def admin_unmutemany(
    interaction: discord.Interaction,
    members: str,
    dry_run: bool = False,
    reason: str | None = None,
) -> None:
    if not await require_admin(interaction):
        return

    context = await get_timeout_context(interaction)
    if context is None:
        return
    guild, actor, me = context

    member_ids = parse_member_ids(members)
    if not member_ids:
        await interaction.response.send_message("No valid member mentions or IDs were provided.", ephemeral=True)
        return

    await interaction.response.defer(ephemeral=True)

    targets, missing_ids = await resolve_members(guild, member_ids)
    eligible, preview_skipped, preview_details = preview_timeout_targets(actor, me, targets, only_if_timed_out=True)

    if MUTEALL_TARGET_CAP > 0 and eligible > MUTEALL_TARGET_CAP:
        await interaction.followup.send(build_target_cap_message(eligible), ephemeral=True)
        return

    if dry_run:
        summary = (
            f"Dry run only: would unmute `{eligible}` member(s).\n"
            f"Skipped during preview: `{preview_skipped}` | Unknown IDs: `{len(missing_ids)}`"
        )
        if preview_details:
            summary += PREVIEW_ISSUES_PREFIX + "\n".join(f"- {line}" for line in preview_details[:10])
        await interaction.followup.send(summary, ephemeral=True)
        return

    mod_reason = build_timeout_reason("Unmuted", actor, reason)
    applied, skipped, failed, skipped_details = await apply_timeout_to_targets(
        actor,
        me,
        targets,
        None,
        mod_reason,
    )

    summary = (
        f"Unmuted `{applied}` member(s).\n"
        f"Skipped: `{skipped}` | Failed: `{failed}` | Unknown IDs: `{len(missing_ids)}`"
    )
    if skipped_details:
        summary += "\n\nIssues:\n" + "\n".join(f"- {line}" for line in skipped_details[:10])

    await interaction.followup.send(summary, ephemeral=True)

    await send_log(
        guild,
        "Admin Unmute Many",
        f"**By:** {actor.mention}\n"
        f"**Applied:** `{applied}`\n"
        f"**Skipped:** `{skipped}`\n"
        f"**Failed:** `{failed}`\n"
        f"**Unknown IDs:** `{len(missing_ids)}`\n"
        f"**Reason:** {reason or 'No reason provided.'}",
    )


@admin_group.command(name="muteall", description="Timeout all non-bot members")
@app_commands.describe(
    minutes="Timeout duration in minutes (1-40320)",
    confirm="Type CONFIRM to run",
    dry_run="Preview impacts without applying timeouts",
    reason="Optional reason",
)
async def admin_muteall(
    interaction: discord.Interaction,
    minutes: app_commands.Range[int, 1, MAX_TIMEOUT_MINUTES],
    confirm: str,
    dry_run: bool = False,
    reason: str | None = None,
) -> None:
    if not await require_admin(interaction):
        return

    if not is_confirmed(confirm):
        await interaction.response.send_message(MSG_CONFIRM_REQUIRED, ephemeral=True)
        return

    context = await get_timeout_context(interaction)
    if context is None:
        return
    guild, actor, me = context

    await interaction.response.defer(ephemeral=True)

    try:
        if not guild.chunked:
            await guild.chunk(cache=True)
    except Exception:
        pass

    eligible, preview_skipped, preview_details = preview_timeout_targets(actor, me, guild.members)
    if MUTEALL_TARGET_CAP > 0 and eligible > MUTEALL_TARGET_CAP:
        await interaction.followup.send(build_target_cap_message(eligible), ephemeral=True)
        return

    if dry_run:
        summary = (
            f"Dry run only: would mute `{eligible}` member(s) for `{minutes}` minute(s).\n"
            f"Skipped during preview: `{preview_skipped}`"
        )
        if preview_details:
            summary += PREVIEW_ISSUES_PREFIX + "\n".join(f"- {line}" for line in preview_details[:10])
        await interaction.followup.send(summary, ephemeral=True)
        return

    mute_until = get_now() + timedelta(minutes=minutes)
    mod_reason = build_timeout_reason("Muted", actor, reason)
    applied, skipped, failed, _ = await apply_timeout_to_targets(
        actor,
        me,
        guild.members,
        mute_until,
        mod_reason,
    )

    await interaction.followup.send(
        f"Mute all complete. Muted `{applied}` member(s). Skipped `{skipped}`. Failed `{failed}`.",
        ephemeral=True,
    )

    await send_log(
        guild,
        "Admin Mute All",
        f"**By:** {actor.mention}\n"
        f"**Minutes:** `{minutes}`\n"
        f"**Applied:** `{applied}`\n"
        f"**Skipped:** `{skipped}`\n"
        f"**Failed:** `{failed}`\n"
        f"**Reason:** {reason or 'No reason provided.'}",
    )


@admin_group.command(name="unmuteall", description="Remove timeout from all non-bot members")
@app_commands.describe(confirm="Type CONFIRM to run", dry_run="Preview impacts without removing timeouts", reason="Optional reason")
async def admin_unmuteall(
    interaction: discord.Interaction,
    confirm: str,
    dry_run: bool = False,
    reason: str | None = None,
) -> None:
    if not await require_admin(interaction):
        return

    if not is_confirmed(confirm):
        await interaction.response.send_message(MSG_CONFIRM_REQUIRED, ephemeral=True)
        return

    context = await get_timeout_context(interaction)
    if context is None:
        return
    guild, actor, me = context

    await interaction.response.defer(ephemeral=True)

    try:
        if not guild.chunked:
            await guild.chunk(cache=True)
    except Exception:
        pass

    eligible, preview_skipped, preview_details = preview_timeout_targets(
        actor,
        me,
        guild.members,
        only_if_timed_out=True,
    )
    if MUTEALL_TARGET_CAP > 0 and eligible > MUTEALL_TARGET_CAP:
        await interaction.followup.send(build_target_cap_message(eligible), ephemeral=True)
        return

    if dry_run:
        summary = (
            f"Dry run only: would unmute `{eligible}` member(s).\n"
            f"Skipped during preview: `{preview_skipped}`"
        )
        if preview_details:
            summary += PREVIEW_ISSUES_PREFIX + "\n".join(f"- {line}" for line in preview_details[:10])
        await interaction.followup.send(summary, ephemeral=True)
        return

    mod_reason = build_timeout_reason("Unmuted", actor, reason)
    applied, skipped, failed, _ = await apply_timeout_to_targets(
        actor,
        me,
        guild.members,
        None,
        mod_reason,
        only_if_timed_out=True,
    )

    await interaction.followup.send(
        f"Unmute all complete. Unmuted `{applied}` member(s). Skipped `{skipped}`. Failed `{failed}`.",
        ephemeral=True,
    )

    await send_log(
        guild,
        "Admin Unmute All",
        f"**By:** {actor.mention}\n"
        f"**Applied:** `{applied}`\n"
        f"**Skipped:** `{skipped}`\n"
        f"**Failed:** `{failed}`\n"
        f"**Reason:** {reason or 'No reason provided.'}",
    )


@court_group.command(name="status", description="Show current court bot status")
async def court_status(interaction: discord.Interaction) -> None:
    if not await require_staff(interaction):
        return
    record_command_metric("court.status")
    await interaction.response.send_message(status_text(), ephemeral=True)


@court_group.command(name="health", description="Show detailed bot health diagnostics")
async def court_health(interaction: discord.Interaction) -> None:
    if not await require_staff(interaction):
        return

    if interaction.guild is None:
        await interaction.response.send_message(MSG_USE_IN_SERVER, ephemeral=True)
        return

    record_command_metric("court.health")
    embed = await build_health_embed(interaction.guild)
    await interaction.response.send_message(embed=embed, ephemeral=True)


@court_group.command(name="analytics", description="Show usage and engagement analytics")
async def court_analytics(interaction: discord.Interaction) -> None:
    if not await require_staff(interaction):
        return

    record_command_metric("court.analytics")
    await interaction.response.send_message(embed=build_analytics_embed(), ephemeral=True)


@court_group.command(name="dryrun", description="Enable or disable auto-post dry run mode")
@app_commands.describe(enabled="When enabled, scheduled auto-post logs what it would post without posting")
async def court_dryrun(interaction: discord.Interaction, enabled: bool) -> None:
    if not await require_staff(interaction):
        return

    state = get_state()
    state["dry_run_auto_post"] = enabled
    if not enabled:
        state["last_dry_run_date"] = None
    save_state(state)

    record_command_metric("court.dryrun")
    await interaction.response.send_message(
        f"Auto-post dry run is now `{'enabled' if enabled else 'disabled'}`.",
        ephemeral=True,
    )


@admin_group.command(name="resetroyaltimer", description="Reset the royal announcement timer (testing)")
async def admin_resetroyaltimer(interaction: discord.Interaction) -> None:
    if not await require_admin(interaction):
        return

    reset_royal_presence_timer()
    record_command_metric("invictus.resetroyaltimer")
    await interaction.response.send_message(
        "Royal timer reset. The next message from the Emperor or the Empress can trigger the H1 announcement immediately.",
        ephemeral=True,
    )

    await send_log(
        interaction.guild,
        "Royal Timer Reset",
        f"**By:** {interaction.user.mention}",
    )


@admin_group.command(name="afk", description="Set or clear AFK status for Emperor and Empress")
@app_commands.describe(reason="Reason for being AFK. Leave empty to clear your AFK status")
async def admin_afk(
    interaction: discord.Interaction,
    reason: str | None = None,
) -> None:
    royal_context = await require_royal(interaction)
    if royal_context is None:
        return

    guild, actor, titles = royal_context
    clean_reason = normalize_question_text(reason or "")

    state = get_state()
    royal_afk = ensure_royal_afk_shape(state.get("royal_afk", {}))
    by_title = royal_afk.get("by_title", {})

    if clean_reason:
        now_iso = iso_now()
        for title in titles:
            by_title[title] = {
                "active": True,
                "reason": clean_reason,
                "set_at": now_iso,
                "set_by_user_id": str(actor.id),
            }

        royal_afk["by_title"] = by_title
        state["royal_afk"] = royal_afk
        save_state(state)

        record_command_metric("invictus.afk")
        joined_titles = ", ".join(titles)
        await interaction.response.send_message(
            f"AFK enabled for {joined_titles}.",
            ephemeral=True,
        )

        await send_log(
            guild,
            "Royal AFK Enabled",
            f"**By:** {actor.mention}\n"
            f"**Titles:** `{joined_titles}`\n"
            f"**Reason:** {clean_reason}",
        )
        return

    cleared: list[str] = []
    for title in titles:
        entry = by_title.get(title, {})
        if bool(entry.get("active", False)):
            cleared.append(title)

        by_title[title] = {
            "active": False,
            "reason": "",
            "set_at": None,
            "set_by_user_id": None,
        }

    royal_afk["by_title"] = by_title
    state["royal_afk"] = royal_afk
    save_state(state)

    record_command_metric("invictus.afk")
    if cleared:
        joined_titles = ", ".join(cleared)
        await interaction.response.send_message(
            f"AFK cleared for {joined_titles}.",
            ephemeral=True,
        )
        await send_log(
            guild,
            "Royal AFK Cleared",
            f"**By:** {actor.mention}\n"
            f"**Titles:** `{joined_titles}`",
        )
        return

    await interaction.response.send_message(
        "No AFK status was active. Provide a reason to set AFK.",
        ephemeral=True,
    )


@admin_group.command(name="afkstatus", description="Show current Emperor and Empress AFK status")
async def admin_afkstatus(interaction: discord.Interaction) -> None:
    if not await require_admin(interaction):
        return

    record_command_metric("invictus.afkstatus")
    await interaction.response.send_message(
        "**Royal AFK Status**\n" + build_royal_afk_status_report(),
        ephemeral=True,
    )


@questions_group.command(name="audit", description="Audit questions for duplicates and quality issues")
async def court_questions_audit(interaction: discord.Interaction) -> None:
    if not await require_staff(interaction):
        return

    report = build_question_audit_report()
    record_command_metric("court.questions.audit")
    await interaction.response.send_message(report[:1900], ephemeral=True)


@court_group.command(name="exportstate", description="Export current state as a JSON file")
async def court_exportstate(interaction: discord.Interaction) -> None:
    if not await require_staff(interaction):
        return

    payload = json.dumps(get_state(), ensure_ascii=False, indent=2)
    file_obj = discord.File(io.BytesIO(payload.encode("utf-8")), filename="court_state_export.json")
    record_command_metric("court.exportstate")
    await interaction.response.send_message("State export attached.", file=file_obj, ephemeral=True)


@court_group.command(name="importstate", description="Import state from a JSON attachment")
@app_commands.describe(file="JSON file previously exported by this bot", confirm="Type CONFIRM to apply")
async def court_importstate(
    interaction: discord.Interaction,
    file: discord.Attachment,
    confirm: str,
) -> None:
    if not await require_staff(interaction):
        return

    if not is_confirmed(confirm):
        await interaction.response.send_message(MSG_CONFIRM_REQUIRED, ephemeral=True)
        return

    try:
        raw = await file.read()
        imported = json.loads(raw.decode("utf-8"))
    except Exception:
        await interaction.response.send_message("Failed to parse state JSON file.", ephemeral=True)
        return

    if not isinstance(imported, dict):
        await interaction.response.send_message("Imported state must be a JSON object.", ephemeral=True)
        return

    merged = merge_imported_state(imported)
    save_state(merged)
    record_command_metric("court.importstate")
    await interaction.response.send_message("State imported successfully.", ephemeral=True)


@admin_group.command(name="backfillstats", description="Backfill message/reaction stats from historical channel history")
@app_commands.describe(days="How many days to scan (0 scans all available history)")
async def admin_backfillstats(
    interaction: discord.Interaction,
    days: app_commands.Range[int, 0, 3650] = 0,
) -> None:
    if not await require_admin(interaction):
        return

    if interaction.guild is None:
        await interaction.response.send_message(MSG_USE_IN_SERVER, ephemeral=True)
        return

    if USER_METRICS_BACKFILL_LOCK.locked():
        await interaction.response.send_message(
            "A user stats backfill is already running. Wait for it to finish before starting another.",
            ephemeral=True,
        )
        return

    lookback_text = backfill_lookback_text(int(days))
    await interaction.response.send_message(
        "Starting user stats backfill for "
        f"{lookback_text}. This can take a while and may hit API rate limits on large servers. "
        "A completion summary will be sent to the configured log channel.",
        ephemeral=True,
    )

    record_command_metric("invictus.backfillstats")
    start_background_task(run_user_activity_backfill(interaction.guild, interaction.user, int(days)))


@admin_group.command(name="backfillstatus", description="Show status of the user stats backfill")
async def admin_backfillstatus(interaction: discord.Interaction) -> None:
    if not await require_admin(interaction):
        return

    snapshot = get_backfill_status_snapshot()
    status_embed = build_backfill_status_embed(snapshot)

    record_command_metric("invictus.backfillstatus")
    await interaction.response.send_message(embed=status_embed, ephemeral=True)


@admin_group.command(name="help", description="Show all available commands")
async def admin_help(interaction: discord.Interaction) -> None:
    if not await require_admin(interaction):
        return

    help_text = """
**Imperial Court Bot Commands**

**Court Control Commands**
`/court status` — Show current bot status
`/court health` — Show detailed bot health diagnostics
`/court analytics` — Show usage and engagement analytics
`/court dryrun <enabled>` — Toggle scheduled auto-post dry run mode
`/court exportstate` — Export bot state JSON
`/court importstate <file> <confirm>` — Import bot state JSON (CONFIRM required)
`/court mode <mode>` — Set bot mode (off, manual, auto)
`/court channel <channel>` — Set court post channel
`/court logchannel [channel]` — Set staff log channel (leave empty to disable)
`/court schedule <hour> <minute>` — Set auto-post time (0-23 hour, 0-59 minute)

**Question Management**
`/court listcategories` — List all question categories and counts
`/court addquestion <category> <question>` — Add a question to a category
`/court deletequestion <category> <question>` — Delete a question from a category
`/court editquestion <category> <old> <new>` — Edit a question in a category
`/court questions count [category]` — Count questions (opt: by category)
`/court questions unused [category]` — Show unused questions (opt: by category)
`/court questions audit` — Audit duplicates and question quality issues
`/court resethistory` — Clear history and used question pool

**Court Posts**
`/court post [category] [randomize]` — Post a question now (opt: pick category/order)
`/court custom <question>` — Post a custom question immediately
`/court close [message_id]` — Close latest inquiry (or specific by ID)
`/court listopen` — Show open inquiries with age/remaining time/answer counts
`/court extend <message_id> <additional_hours>` — Extend inquiry auto-close window
`/court reopen <message_id> [close_after_hours]` — Reopen a closed inquiry
`/court removeanswer <message_id>` — Remove anonymous answer by message ID

**Invictus Commands**
`/invictus say <channel>` — Send announcement in channel
`/invictus rolepanel <role> [channel] [title] [description] [button_label] [mention_everyone]` — Post a role toggle panel
`/invictus rolepanelmulti <role_1> <role_2> [role_3] [role_4] [role_5] [channel] [title] [description] [mention_everyone]` — Post a multi-role toggle panel with multiple buttons
`/invictus purge <amount>` — Delete 1-100 recent messages
`/invictus purgeuser <member> [amount]` — Delete member's messages (scan 1-200)
`/invictus resetroyaltimer` — Reset royal announcement timer for testing
`/invictus afk [reason]` — Set AFK for Emperor/Empress (leave reason empty to clear)
`/invictus afkstatus` — Show current Emperor/Empress AFK status
`/invictus lock [reason]` — Lock channel for @everyone
`/invictus unlock [reason]` — Unlock channel for @everyone
`/invictus slowmode <seconds>` — Set slowmode (0-21600)
`/invictus timeout <member> <minutes> [reason]` — Timeout member (1-40320 min)
`/invictus untimeout <member> [reason]` — Remove timeout from member
`/invictus mutemany <members> <minutes> [dry_run] [reason]` — Timeout multiple with dry-run option
`/invictus unmutemany <members> [dry_run] [reason]` — Remove timeout from multiple with dry-run option
`/invictus muteall <minutes> <confirm> [dry_run] [reason]` — Timeout all (type CONFIRM)
`/invictus unmuteall <confirm> [dry_run] [reason]` — Remove timeout from all (type CONFIRM)
`/invictus backfillstats [days]` — Backfill historical message/reaction stats
`/invictus backfillstatus` — Show running/last status for user stats backfill

**Fun Commands**
`/fun battle <opponent>` — Battle another member (mentions both users)
`/fun stats [member]` — Show fun activity stats for yourself or a member
`/fun leaderboard <metric> [limit]` — Show top members for a fun activity metric
`/fun verdict <question>` — Ask the throne for a yes/no-style decree
`/fun title [member]` — Grant a random imperial title
`/fun fate [member]` — Roll fate and receive a court reading

**Greetings Commands**
`/greetings rio` — Send Rio-chan a friendly ping with an embed
`/greetings taylor` — Send Taylor-chan a friendly ping with an embed

**Categories**
`general` — Broad prompts for everyday discussion
`gaming` — Games, consoles, mechanics, franchises, hot takes
`music` — Songs, artists, albums, genres, music takes
`hot-take` — Controversial opinions and spicy takes
`chaos` — Funny, dumb, cursed, unhinged prompts

**Notes**
• Staff role required for `/court` commands
• Administrator permission required for `/invictus` moderation commands
• Only Emperor/Empress can run `/invictus afk`
• `/fun` commands are available to everyone
• Anonymous answers are one per person per inquiry
• Inquiries auto-close after 24 hours
• Confirm commands require exact "CONFIRM" text
"""

    embed = discord.Embed(
        title="🗺️ Command Reference",
        description=help_text,
        color=ROLE_COLOR,
        timestamp=get_now(),
    )
    await interaction.response.send_message(embed=embed, ephemeral=True)


@court_group.command(name="mode", description="Set the bot mode")
@app_commands.describe(mode="off, manual, or auto")
@app_commands.choices(
    mode=[
        app_commands.Choice(name="off", value="off"),
        app_commands.Choice(name="manual", value="manual"),
        app_commands.Choice(name="auto", value="auto"),
    ]
)
async def court_mode(interaction: discord.Interaction, mode: app_commands.Choice[str]) -> None:
    if not await require_staff(interaction):
        return

    state = get_state()
    state["mode"] = mode.value
    save_state(state)

    await interaction.response.send_message(
        f"Mode set to `{mode.value}`.\n\n{status_text()}",
        ephemeral=True,
    )

    await send_log(
        interaction.guild,
        "Court Mode Updated",
        f"**By:** {interaction.user.mention}\n**New Mode:** `{mode.value}`",
    )


@court_group.command(name="channel", description="Set the channel for court posts")
@app_commands.describe(channel="The text channel to post in")
async def court_channel(interaction: discord.Interaction, channel: discord.TextChannel) -> None:
    if not await require_staff(interaction):
        return

    state = get_state()
    state["channel_id"] = channel.id
    save_state(state)

    await interaction.response.send_message(
        f"Court channel set to {channel.mention}.",
        ephemeral=True,
    )

    await send_log(
        interaction.guild,
        "Court Channel Updated",
        f"**By:** {interaction.user.mention}\n**Channel:** {channel.mention}",
    )


@court_group.command(name="logchannel", description="Set or clear the staff log channel")
@app_commands.describe(channel="Leave empty to disable logging")
async def court_logchannel(
    interaction: discord.Interaction,
    channel: discord.TextChannel | None = None,
) -> None:
    if not await require_staff(interaction):
        return

    state = get_state()
    state["log_channel_id"] = channel.id if channel else 0
    save_state(state)

    if channel is None:
        await interaction.response.send_message("Log channel disabled.", ephemeral=True)
        return

    await interaction.response.send_message(
        f"Log channel set to {channel.mention}.",
        ephemeral=True,
    )

    await send_log(
        interaction.guild,
        "Log Channel Updated",
        f"**By:** {interaction.user.mention}\n**Log Channel:** {channel.mention}",
    )


@court_group.command(name="schedule", description="Set auto-post time")
@app_commands.describe(hour="0-23", minute="0-59")
async def court_schedule(
    interaction: discord.Interaction,
    hour: app_commands.Range[int, 0, 23],
    minute: app_commands.Range[int, 0, 59],
) -> None:
    if not await require_staff(interaction):
        return

    state = get_state()
    state["hour"] = hour
    state["minute"] = minute
    save_state(state)

    await interaction.response.send_message(
        f"Auto-post time set to `{hour:02d}:{minute:02d}` ({TIMEZONE_NAME}).",
        ephemeral=True,
    )

    await send_log(
        interaction.guild,
        "Court Schedule Updated",
        f"**By:** {interaction.user.mention}\n**Time:** `{hour:02d}:{minute:02d}` ({TIMEZONE_NAME})",
    )


@court_group.command(name="listcategories", description="List all question categories")
async def court_listcategories(interaction: discord.Interaction) -> None:
    if not await require_staff(interaction):
        return

    questions = get_questions()
    total = 0
    lines = []

    for category, description in CATEGORY_DESCRIPTIONS.items():
        count = len(questions.get(category, []))
        total += count
        lines.append(f"- `{category}`: `{count}` question(s) — {description}")

    await interaction.response.send_message(
        "**Question Categories**\n" + "\n".join(lines) + f"\n\n**Total Questions:** `{total}`",
        ephemeral=True,
    )


@court_group.command(name="addquestion", description="Add a question to a category")
@app_commands.describe(category="Question category", question="The question text")
@app_commands.choices(category=CATEGORY_CHOICES)
async def court_addquestion(
    interaction: discord.Interaction,
    category: app_commands.Choice[str],
    question: str,
) -> None:
    if not await require_staff(interaction):
        return

    clean_question = normalize_question_text(question)
    if not clean_question:
        await interaction.response.send_message(
            MSG_QUESTION_EMPTY,
            ephemeral=True,
        )
        return

    questions = get_questions()
    category_items = questions.setdefault(category.value, [])
    already_exists = any(item.strip().casefold() == clean_question.casefold() for item in category_items)

    if already_exists:
        await interaction.response.send_message(
            f"That question already exists in `{category.value}`.",
            ephemeral=True,
        )
        return

    category_items.append(clean_question)
    save_json(QUESTIONS_FILE, questions)

    await interaction.response.send_message(
        f"Added question to `{category.value}`.",
        ephemeral=True,
    )

    await send_log(
        interaction.guild,
        "Question Added",
        f"**By:** {interaction.user.mention}\n**Category:** `{category.value}`\n**Question:** {clean_question}",
    )


@court_group.command(name="deletequestion", description="Delete a question from a category")
@app_commands.describe(category="Question category", question="Paste the exact question text to remove")
@app_commands.choices(category=CATEGORY_CHOICES)
async def court_deletequestion(
    interaction: discord.Interaction,
    category: app_commands.Choice[str],
    question: str,
) -> None:
    if not await require_staff(interaction):
        return

    clean_question = normalize_question_text(question)
    if not clean_question:
        await interaction.response.send_message(
            MSG_QUESTION_EMPTY,
            ephemeral=True,
        )
        return

    questions = get_questions()
    items = questions.get(category.value, [])

    target = clean_question.casefold()
    kept = [q for q in items if q.strip().casefold() != target]

    if len(kept) == len(items):
        await interaction.response.send_message(
            "Question not found in that category.",
            ephemeral=True,
        )
        return

    questions[category.value] = kept
    save_json(QUESTIONS_FILE, questions)
    remove_question_from_state(clean_question)

    await interaction.response.send_message(
        f"Removed `{len(items) - len(kept)}` matching question(s) from `{category.value}`.",
        ephemeral=True,
    )

    await send_log(
        interaction.guild,
        "Question Deleted",
        f"**By:** {interaction.user.mention}\n**Category:** `{category.value}`\n**Question:** {clean_question}",
    )


@court_group.command(name="editquestion", description="Edit a question inside a category")
@app_commands.describe(
    category="Question category",
    old_question="Paste the exact old question",
    new_question="The new replacement question",
)
@app_commands.choices(category=CATEGORY_CHOICES)
async def court_editquestion(
    interaction: discord.Interaction,
    category: app_commands.Choice[str],
    old_question: str,
    new_question: str,
) -> None:
    if not await require_staff(interaction):
        return

    old_clean = normalize_question_text(old_question)
    new_clean = normalize_question_text(new_question)

    if not old_clean or not new_clean:
        await interaction.response.send_message(
            "Old and new question text must be non-empty.",
            ephemeral=True,
        )
        return

    questions = get_questions()
    items = questions.get(category.value, [])

    if old_clean.casefold() != new_clean.casefold() and any(
        existing.strip().casefold() == new_clean.casefold() for existing in items
    ):
        await interaction.response.send_message(
            "That replacement question already exists in this category.",
            ephemeral=True,
        )
        return

    target = old_clean.casefold()
    replaced = False

    for index, existing in enumerate(items):
        if existing.strip().casefold() == target:
            items[index] = new_clean
            replaced = True
            break

    if not replaced:
        await interaction.response.send_message(
            "Question not found in that category.",
            ephemeral=True,
        )
        return

    questions[category.value] = items
    save_json(QUESTIONS_FILE, questions)
    replace_question_in_state(old_clean, new_clean)

    await interaction.response.send_message(
        f"Updated question in `{category.value}`.",
        ephemeral=True,
    )

    await send_log(
        interaction.guild,
        "Question Edited",
        f"**By:** {interaction.user.mention}\n**Category:** `{category.value}`\n**Old:** {old_clean}\n**New:** {new_clean}",
    )


@questions_group.command(name="count", description="Count questions in one category or all categories")
@app_commands.describe(category="Optional category to count")
@app_commands.choices(category=CATEGORY_CHOICES)
async def court_questions_count(
    interaction: discord.Interaction,
    category: app_commands.Choice[str] | None = None,
) -> None:
    if not await require_staff(interaction):
        return

    questions = get_questions()

    if category:
        count = len(questions.get(category.value, []))
        await interaction.response.send_message(
            f"`{category.value}` has `{count}` question(s).",
            ephemeral=True,
        )
        return

    total = sum(len(items) for items in questions.values())
    await interaction.response.send_message(
        f"Total questions across all categories: `{total}`",
        ephemeral=True,
    )


@questions_group.command(name="unused", description="Show how many questions have not been used yet")
@app_commands.describe(category="Optional category to inspect")
@app_commands.choices(category=CATEGORY_CHOICES)
async def court_questions_unused(
    interaction: discord.Interaction,
    category: app_commands.Choice[str] | None = None,
) -> None:
    if not await require_staff(interaction):
        return

    questions = get_questions()
    used = set(get_state().get("used_questions", []))

    if category:
        items = questions.get(category.value, [])
        unused = [q for q in items if q not in used]
        preview = "\n".join(f"- {q}" for q in unused[:10]) if unused else "None."
        await interaction.response.send_message(
            f"**Unused in `{category.value}`:** `{len(unused)}`\n{preview}",
            ephemeral=True,
        )
        return

    lines = []
    total_unused = 0
    for cat, items in questions.items():
        unused_count = sum(1 for q in items if q not in used)
        total_unused += unused_count
        lines.append(f"- `{cat}`: `{unused_count}` unused")

    await interaction.response.send_message(
        "**Unused Questions**\n" + "\n".join(lines) + f"\n\n**Total Unused:** `{total_unused}`",
        ephemeral=True,
    )


@court_group.command(name="resethistory", description="Reset recent and used question history")
async def court_resethistory(interaction: discord.Interaction) -> None:
    if not await require_staff(interaction):
        return

    state = get_state()
    state["history"] = []
    state["used_questions"] = []
    save_state(state)

    await interaction.response.send_message(
        "Question history and used pool have been reset.",
        ephemeral=True,
    )

    await send_log(
        interaction.guild,
        "Question History Reset",
        f"**By:** {interaction.user.mention}",
    )


@court_group.command(name="post", description="Post a question now")
@app_commands.describe(category="Optional category", randomize="Post randomly or pick the first available question")
@app_commands.choices(category=CATEGORY_CHOICES)
@app_commands.checks.cooldown(1, 20.0)
async def court_post(
    interaction: discord.Interaction,
    category: app_commands.Choice[str] | None = None,
    randomize: bool = True,
) -> None:
    if not await require_staff(interaction):
        return

    if interaction.guild is None:
        await interaction.response.send_message(MSG_USE_IN_SERVER, ephemeral=True)
        return

    await interaction.response.defer(ephemeral=True)

    channel = await get_target_channel(interaction.guild)
    if channel is None:
        await interaction.followup.send("Configured channel not found.", ephemeral=True)
        return

    try:
        chosen_category, question = await post_question(
            channel,
            category.value if category else None,
            randomize,
            source="manual",
            mention_everyone=True,
        )
    except ValueError as e:
        await interaction.followup.send(str(e), ephemeral=True)
        return

    record_command_metric("court.post")
    await interaction.followup.send(
        f"Posted in {channel.mention}\n**Category:** `{chosen_category}`\n**Question:** {question}",
        ephemeral=True,
    )

    await send_log(
        interaction.guild,
        "Court Question Posted",
        f"**By:** {interaction.user.mention}\n**Channel:** {channel.mention}\n**Category:** `{chosen_category}`\n**Randomized:** `{randomize}`\n**Question:** {question}",
    )


@court_group.command(name="custom", description="Post a custom question right now")
@app_commands.describe(question="Your custom court question")
@app_commands.checks.cooldown(1, 20.0)
async def court_custom(interaction: discord.Interaction, question: str) -> None:
    if not await require_staff(interaction):
        return

    if interaction.guild is None:
        await interaction.response.send_message(MSG_USE_IN_SERVER, ephemeral=True)
        return

    await interaction.response.defer(ephemeral=True)

    clean_question = normalize_question_text(question)
    if not clean_question:
        await interaction.followup.send(MSG_QUESTION_EMPTY, ephemeral=True)
        return

    channel = await get_target_channel(interaction.guild)
    if channel is None:
        await interaction.followup.send("Configured channel not found.", ephemeral=True)
        return

    embed = build_embed("custom", clean_question)
    content, allowed_mentions = build_announcement_mentions(False)
    sent = await channel.send(
        content=content,
        embed=embed,
        view=AnonymousAnswerView(),
        allowed_mentions=allowed_mentions,
    )
    thread = await get_or_create_answer_thread(sent)

    if thread is not None:
        await thread.send(
            "**Anonymous Court Replies**\n"
            "- One anonymous answer per person\n"
            "- Stay on topic\n"
            "- Anonymous does not mean consequence-free\n"
            f"- This thread will close automatically after {THREAD_CLOSE_HOURS} hours"
        )

    record = {
        "message_id": str(sent.id),
        "thread_id": str(thread.id) if thread else None,
        "channel_id": str(channel.id),
        "category": "custom",
        "question": clean_question,
        "posted_at": iso_now(),
        "close_after_hours": THREAD_CLOSE_HOURS,
        "closed": False,
        "closed_at": None,
        "close_reason": None,
    }
    upsert_post_record(record)
    record_post_metric("custom", "custom")

    state = get_state()
    state["last_posted_date"] = get_now().strftime("%Y-%m-%d")
    save_state(state)

    record_command_metric("court.custom")
    await interaction.followup.send(
        f"Custom question posted in {channel.mention}.",
        ephemeral=True,
    )

    await send_log(
        interaction.guild,
        "Custom Court Question Posted",
        f"**By:** {interaction.user.mention}\n**Channel:** {channel.mention}\n**Question:** {clean_question}",
    )


@court_group.command(name="close", description="Close the latest court inquiry or a specific one by message ID")
@app_commands.describe(message_id="Optional QOTD message ID to close")
@app_commands.checks.cooldown(1, 10.0)
async def court_close(
    interaction: discord.Interaction,
    message_id: str | None = None,
) -> None:
    if not await require_staff(interaction):
        return

    if interaction.guild is None:
        await interaction.response.send_message(MSG_USE_IN_SERVER, ephemeral=True)
        return

    record = get_post_record(message_id) if message_id else get_latest_open_post()
    if record is None:
        await interaction.response.send_message(
            "No matching open court inquiry found.",
            ephemeral=True,
        )
        return

    ok, message = await close_court_post(record, "manual")
    record_command_metric("court.close")

    await interaction.response.send_message(message, ephemeral=True)

    if ok:
        await send_log(
            interaction.guild,
            "Court Inquiry Closed",
            f"**By:** {interaction.user.mention}\n**Message ID:** `{record['message_id']}`\n**Question:** {record['question']}",
        )


@court_group.command(name="listopen", description="List currently open court inquiries")
async def court_listopen(interaction: discord.Interaction) -> None:
    if not await require_staff(interaction):
        return

    open_posts = list_post_records(include_closed=False)
    if not open_posts:
        await interaction.response.send_message("No open court inquiries.", ephemeral=True)
        return

    now = get_now()
    lines: list[str] = []
    for post in open_posts[-10:]:
        posted_at = parse_iso(post.get("posted_at"))
        age_text = format_duration(now - posted_at) if posted_at else "Unknown"
        remaining = get_post_remaining_time(post, now)
        if remaining is None:
            closes_text = "Unknown"
        elif remaining.total_seconds() <= 0:
            closes_text = "Overdue"
        else:
            closes_text = format_duration(remaining)

        answer_count = count_answers_for_question(post["message_id"])
        lines.append(
            f"- `{post['message_id']}` | `{post.get('category', 'unknown')}` | "
            f"Age `{age_text}` | Closes in `{closes_text}` | Answers `{answer_count}`"
        )

    record_command_metric("court.listopen")
    await interaction.response.send_message(
        "**Open Court Inquiries (latest 10)**\n" + "\n".join(lines),
        ephemeral=True,
    )


@court_group.command(name="extend", description="Extend auto-close window for a court inquiry")
@app_commands.describe(message_id="Inquiry message ID", additional_hours="Hours to add (1-168)")
async def court_extend(
    interaction: discord.Interaction,
    message_id: str,
    additional_hours: app_commands.Range[int, 1, 168],
) -> None:
    if not await require_staff(interaction):
        return

    record = get_post_record(message_id)
    if record is None:
        await interaction.response.send_message("Court inquiry not found.", ephemeral=True)
        return

    current_window = get_post_close_after_hours(record)
    new_window = current_window + int(additional_hours)
    set_post_close_after_hours(message_id, new_window)

    record_command_metric("court.extend")
    await interaction.response.send_message(
        f"Extended inquiry `{message_id}` by `{additional_hours}` hour(s). New close window: `{new_window}` hour(s).",
        ephemeral=True,
    )

    if interaction.guild is not None:
        await send_log(
            interaction.guild,
            "Court Inquiry Extended",
            f"**By:** {interaction.user.mention}\n**Message ID:** `{message_id}`\n"
            f"**Old Window:** `{current_window}`h\n**New Window:** `{new_window}`h",
        )


@court_group.command(name="reopen", description="Reopen a closed court inquiry")
@app_commands.describe(message_id="Inquiry message ID", close_after_hours="New auto-close window in hours (1-168)")
async def court_reopen(
    interaction: discord.Interaction,
    message_id: str,
    close_after_hours: app_commands.Range[int, 1, 168] = THREAD_CLOSE_HOURS,
) -> None:
    if not await require_staff(interaction):
        return

    if interaction.guild is None:
        await interaction.response.send_message(MSG_USE_IN_SERVER, ephemeral=True)
        return

    record = get_post_record(message_id)
    if record is None:
        await interaction.response.send_message("Court inquiry not found.", ephemeral=True)
        return

    ok, message = await reopen_court_post(record, close_after_hours=int(close_after_hours))
    record_command_metric("court.reopen")
    await interaction.response.send_message(message, ephemeral=True)

    if ok:
        await send_log(
            interaction.guild,
            "Court Inquiry Reopened",
            f"**By:** {interaction.user.mention}\n**Message ID:** `{message_id}`\n"
            f"**Close Window:** `{int(close_after_hours)}`h",
        )


@court_group.command(name="removeanswer", description="Remove an anonymous answer by message ID")
@app_commands.describe(message_id="The anonymous answer message ID")
async def court_removeanswer(
    interaction: discord.Interaction,
    message_id: str,
) -> None:
    if not await require_staff(interaction):
        return

    if interaction.guild is None:
        await interaction.response.send_message(MSG_USE_IN_SERVER, ephemeral=True)
        return

    record_match = find_answer_record(message_id)
    if record_match is None:
        await interaction.response.send_message(
            "Anonymous answer record not found.",
            ephemeral=True,
        )
        return

    question_message_id, _user_id = record_match
    post_record = get_post_record(question_message_id)

    if post_record is None or not post_record.get("thread_id"):
        await interaction.response.send_message(
            "Could not find the parent court thread.",
            ephemeral=True,
        )
        return

    thread = await fetch_channel_by_id(post_record["thread_id"])
    if not isinstance(thread, discord.Thread):
        await interaction.response.send_message(
            "Could not access the parent thread.",
            ephemeral=True,
        )
        return

    try:
        answer_message = await thread.fetch_message(int(message_id))
    except Exception:
        await interaction.response.send_message(
            "Could not fetch that answer message.",
            ephemeral=True,
        )
        return

    try:
        await answer_message.delete()
    except Exception:
        await interaction.response.send_message(
            "Failed to delete that answer message.",
            ephemeral=True,
        )
        return

    remove_answer_record(message_id)

    await interaction.response.send_message(
        "Anonymous answer removed.",
        ephemeral=True,
    )

    await send_log(
        interaction.guild,
        "Anonymous Answer Removed",
        f"**By:** {interaction.user.mention}\n**Answer Message ID:** `{message_id}`\n**Parent Question ID:** `{question_message_id}`",
    )


@fun_group.command(name="battle", description="Battle someone to the death!")
@app_commands.describe(opponent="Who do you want to fight?")
async def fun_boss(interaction: discord.Interaction, opponent: discord.Member) -> None:
    if opponent.id == interaction.user.id:
        await interaction.response.send_message("You can't battle yourself, coward!", ephemeral=True)
        return

    player1 = interaction.user
    player2 = opponent

    # Check if undefeated user is involved
    if player1.id == UNDEFEATED_USER_ID:
        winner = player1
        loser = player2
    elif player2.id == UNDEFEATED_USER_ID:
        winner = player2
        loser = player1
    else:
        # Random winner if neither is the undefeated user
        winner = random.choice([player1, player2])
        loser = player2 if winner == player1 else player1

    record_user_battle_metrics(player1.id, player2.id, winner.id)

    # Generate fake stats for both players, with max stats for the undefeated user.
    p1_stats = {
        stat_name: (100 if player1.id == UNDEFEATED_USER_ID else random.randint(1, 100))
        for stat_name in BOSS_STATS
    }
    p2_stats = {
        stat_name: (100 if player2.id == UNDEFEATED_USER_ID else random.randint(1, 100))
        for stat_name in BOSS_STATS
    }

    # Battle description
    battle_text = f"""**{player1.mention} vs {player2.mention}**

**{player1.name}'s Arsenal:**
"""
    for stat_name, value in p1_stats.items():
        battle_text += f"• {stat_name}: {value}/100\n"

    battle_text += f"\n**{player2.name}'s Arsenal:**\n"
    for stat_name, value in p2_stats.items():
        battle_text += f"• {stat_name}: {value}/100\n"

    battle_text += f"\n---\n\n** CHAMPIONSHIP VICTORY: {winner.mention}!**\n"
    battle_text += f"**{loser.mention} has been defeated!**"

    embed = discord.Embed(
        title="BOSS BATTLE ARENA",
        description=battle_text,
        color=ROLE_COLOR,
        timestamp=get_now(),
    )
    embed.add_field(name="Challenger", value=f"{player1.mention}", inline=True)
    embed.add_field(name="Opponent", value=f"{player2.mention}", inline=True)
    embed.add_field(name="Champion", value=f"{winner.mention}", inline=False)
    await interaction.response.send_message(content=f"{player1.mention} {player2.mention}", embed=embed)


@fun_group.command(name="stats", description="Show fun activity stats for yourself or another member")
@app_commands.describe(member="Optional member to inspect")
async def fun_stats(interaction: discord.Interaction, member: discord.Member | None = None) -> None:
    if interaction.guild is None:
        await interaction.response.send_message(MSG_USE_IN_SERVER, ephemeral=True)
        return

    target_member = member
    if target_member is None:
        if not isinstance(interaction.user, discord.Member):
            await interaction.response.send_message(MSG_VERIFY_ROLES, ephemeral=True)
            return
        target_member = interaction.user

    stats = get_user_fun_metrics(target_member.id)
    await interaction.response.send_message(embed=build_user_fun_metrics_embed(target_member, stats))


@fun_group.command(name="leaderboard", description="Show the top members for a fun activity metric")
@app_commands.describe(metric="Metric to rank", limit="How many entries to show (1-10)")
@app_commands.choices(metric=USER_FUN_LEADERBOARD_CHOICES)
async def fun_leaderboard(
    interaction: discord.Interaction,
    metric: app_commands.Choice[str],
    limit: app_commands.Range[int, 1, 10] = 5,
) -> None:
    if interaction.guild is None:
        await interaction.response.send_message(MSG_USE_IN_SERVER, ephemeral=True)
        return

    top_rows = list_top_users_for_metric(metric.value, limit=int(limit))
    if not top_rows:
        await interaction.response.send_message("No data yet for that leaderboard. Go make some chaos first.")
        return

    lines: list[str] = []
    for rank, (user_id, value) in enumerate(top_rows, start=1):
        member = interaction.guild.get_member(user_id)
        display = member.mention if member is not None else f"<@{user_id}>"
        lines.append(f"{rank}. {display} - `{value}`")

    metric_label = USER_FUN_METRIC_LABELS.get(metric.value, metric.value.replace("_", " ").title())
    embed = discord.Embed(
        title=f"Fun Leaderboard: {metric_label}",
        description="\n".join(lines),
        color=ROLE_COLOR,
        timestamp=get_now(),
    )
    await interaction.response.send_message(embed=embed)


@fun_group.command(name="verdict", description="Ask the throne for a yes/no-style decree")
@app_commands.describe(question="Your petition to the Imperial Court")
async def fun_verdict(interaction: discord.Interaction, question: str) -> None:
    clean_question = normalize_question_text(question)
    if not clean_question:
        await interaction.response.send_message(MSG_QUESTION_EMPTY, ephemeral=True)
        return

    decree = random.choice(IMPERIAL_VERDICTS)
    embed = discord.Embed(
        title="Imperial Verdict",
        description=f"**Petition:** {clean_question}\n**Decree:** {decree}",
        color=ROLE_COLOR,
        timestamp=get_now(),
    )
    await interaction.response.send_message(embed=embed)


@fun_group.command(name="title", description="Grant a random imperial title")
@app_commands.describe(member="Optional member to honor")
async def fun_title(interaction: discord.Interaction, member: discord.Member | None = None) -> None:
    target = member or interaction.user
    title = random.choice(IMPERIAL_TITLES)
    omen = random.choice(IMPERIAL_OMENS)

    embed = discord.Embed(
        title="Imperial Appointment",
        description=(
            f"{get_member_mention(target)} has been proclaimed **{title}**.\n"
            f"May their name be carved into the court ledgers."
        ),
        color=ROLE_COLOR,
        timestamp=get_now(),
    )
    embed.add_field(name="Witnessed By", value=get_member_display_name(interaction.user), inline=True)
    embed.add_field(name="Omen", value=omen, inline=False)
    await interaction.response.send_message(embed=embed)


@fun_group.command(name="fate", description="Roll fate and receive a court reading")
@app_commands.describe(member="Optional member to read")
async def fun_fate(interaction: discord.Interaction, member: discord.Member | None = None) -> None:
    target = member or interaction.user
    roll = random.randint(1, 100)
    fate_title, fate_reading = get_fate_reading(roll)

    embed = discord.Embed(
        title="Court Fate Reading",
        description=f"{get_member_mention(target)} rolled `{roll}` on the imperial die.",
        color=ROLE_COLOR,
        timestamp=get_now(),
    )
    embed.add_field(name=fate_title, value=fate_reading, inline=False)
    await interaction.response.send_message(embed=embed)


async def send_personal_greeting(
    interaction: discord.Interaction,
    *,
    user_id: int,
    name: str,
) -> None:
    user_mention = f"<@{user_id}>"
    sammy_suffix = "From Sammy" if interaction.user.id == UNDEFEATED_USER_ID else ""
    greeting_text = f"HIIIIIIIIIIIIIIIIIIII {name}-chan {sammy_suffix}\n||{user_mention}||"

    await interaction.response.send_message(
        content=greeting_text,
        allowed_mentions=discord.AllowedMentions(everyone=False, roles=False, users=True),
    )


@greetings_group.command(name="rio", description="Send a nice hello to Rio-chan")
async def greetings_rio(interaction: discord.Interaction) -> None:
    await send_personal_greeting(
        interaction,
        user_id=RIO_USER_ID,
        name="Rio",
    )


@greetings_group.command(name="taylor", description="Send a nice hello to Taylor-chan")
async def greetings_taylor(interaction: discord.Interaction) -> None:
    await send_personal_greeting(
        interaction,
        user_id=TAYLOR_USER_ID,
        name="Taylor",
    )


def get_week_key(now: datetime) -> str:
    iso_year, iso_week, _ = now.isocalendar()
    return f"{iso_year}-W{iso_week:02d}"


async def get_weekly_digest_channel(guild: discord.Guild) -> discord.TextChannel | None:
    if WEEKLY_DIGEST_CHANNEL_ID:
        channel = guild.get_channel(int(WEEKLY_DIGEST_CHANNEL_ID))
        if isinstance(channel, discord.TextChannel):
            return channel
        fetched = await fetch_channel_by_id(WEEKLY_DIGEST_CHANNEL_ID)
        if isinstance(fetched, discord.TextChannel):
            return fetched

    return await get_log_channel(guild)


def build_weekly_digest_embed() -> discord.Embed:
    now = get_now()
    metrics = metrics_snapshot()
    posts = list_post_records(limit=POST_RECORD_LIMIT)
    answers_total = count_all_answer_records()
    open_posts = [post for post in posts if not post.get("closed", False)]
    unanswered_open = [post for post in open_posts if count_answers_for_question(post.get("message_id", "")) == 0]
    post_count = max(len(posts), 1)

    by_category = metrics.get("posts_by_category", {})
    top_categories = sorted(by_category.items(), key=lambda item: int(item[1]), reverse=True)[:3]
    top_category_text = "\n".join(f"- `{cat}`: `{count}`" for cat, count in top_categories) or "No data yet."

    usage = metrics.get("command_usage", {})
    failures = metrics.get("command_failures", {})
    usage_total = sum(int(value) for value in usage.values())
    failure_total = sum(int(value) for value in failures.values())
    failure_rate = (failure_total / usage_total * 100) if usage_total else 0.0

    embed = discord.Embed(
        title="Weekly Court Digest",
        description=f"Week `{get_week_key(now)}` performance summary.",
        color=ROLE_COLOR,
        timestamp=now,
    )
    embed.add_field(
        name="Posts & Answers",
        value=(
            f"**Posts (recent window):** `{len(posts)}`\n"
            f"**Open Inquiries:** `{len(open_posts)}`\n"
            f"**Unanswered Open:** `{len(unanswered_open)}`\n"
            f"**Answer Records:** `{answers_total}`\n"
            f"**Avg Answers/Post:** `{answers_total / post_count:.2f}`"
        ),
        inline=False,
    )
    embed.add_field(name="Top Categories", value=top_category_text, inline=False)
    embed.add_field(
        name="Command Reliability",
        value=(
            f"**Command Invocations:** `{usage_total}`\n"
            f"**Command Failures:** `{failure_total}`\n"
            f"**Failure Rate:** `{failure_rate:.2f}%`"
        ),
        inline=False,
    )
    return embed


def purge_expired_answers(retention_days: int) -> int:
    cutoff = (get_now() - timedelta(days=retention_days)).isoformat()
    with get_db_connection() as conn:
        rows = conn.execute(
            "SELECT COUNT(*) AS c FROM answers WHERE created_at < ?",
            (cutoff,),
        ).fetchone()
        removed = int(rows["c"])
        if removed:
            conn.execute("DELETE FROM answers WHERE created_at < ?", (cutoff,))
    return removed


@tasks.loop(minutes=30)
async def weekly_digest() -> None:
    guild = bot.get_guild(TEST_GUILD_ID)
    if guild is None:
        return

    now = get_now()
    if now.weekday() != WEEKLY_DIGEST_WEEKDAY or now.hour != WEEKLY_DIGEST_HOUR:
        return

    state = get_state()
    week_key = get_week_key(now)
    if state.get("last_weekly_digest_week") == week_key:
        return

    channel = await get_weekly_digest_channel(guild)
    if channel is None:
        return

    try:
        await channel.send(embed=build_weekly_digest_embed())

        def mutator(current_state: dict) -> None:
            current_state["last_weekly_digest_week"] = week_key

        update_state_atomic(mutator)
    except Exception as error:
        await send_failure_alert(guild, "Weekly Digest Failed", error, "weekly_digest loop")


@weekly_digest.before_loop
async def before_weekly_digest() -> None:
    await bot.wait_until_ready()


@tasks.loop(hours=24)
async def retention_cleaner() -> None:
    guild = bot.get_guild(TEST_GUILD_ID)
    removed = purge_expired_answers(ANSWER_RETENTION_DAYS)
    if guild is not None and removed > 0:
        await send_log(
            guild,
            "Answer Retention Cleanup",
            f"Removed `{removed}` answer record(s) older than `{ANSWER_RETENTION_DAYS}` day(s).",
        )


@retention_cleaner.before_loop
async def before_retention_cleaner() -> None:
    await bot.wait_until_ready()


@tasks.loop(minutes=1)
async def auto_poster() -> None:
    state = get_state()

    if state["mode"] != "auto":
        return

    now = get_now()
    today = now.strftime("%Y-%m-%d")

    if state["last_posted_date"] == today:
        return

    if state.get("dry_run_auto_post", False) and state.get("last_dry_run_date") == today:
        return

    if now.hour != state["hour"] or now.minute != state["minute"]:
        return

    guild = bot.get_guild(TEST_GUILD_ID)
    if guild is None:
        return

    channel = await get_target_channel(guild)
    if channel is None:
        return

    try:
        if state.get("dry_run_auto_post", False):
            chosen_category, question = pick_question(None, True)

            def mutator(current_state: dict) -> None:
                current_state["last_dry_run_date"] = today

            update_state_atomic(mutator)
            await send_log(
                guild,
                "Court Auto-Post Dry Run",
                f"**Channel:** {channel.mention}\n**Category:** `{chosen_category}`\n**Question:** {question}",
            )
            return

        chosen_category, question = await post_question(
            channel,
            source="auto",
            mention_everyone=True,
        )
        await send_log(
            guild,
            "Court Question Auto-Posted",
            f"**Channel:** {channel.mention}\n**Category:** `{chosen_category}`\n**Question:** {question}",
        )
    except Exception as error:
        await send_failure_alert(guild, "Court Auto-Post Failed", error, "auto_poster loop")


@auto_poster.before_loop
async def before_auto_poster() -> None:
    await bot.wait_until_ready()


@tasks.loop(minutes=10)
async def thread_closer() -> None:
    guild = bot.get_guild(TEST_GUILD_ID)
    if guild is None:
        return

    now = get_now()
    for record in list_post_records(include_closed=False):
        if record.get("closed", False):
            continue

        remaining = get_post_remaining_time(record, now)
        if remaining is None:
            continue

        if remaining.total_seconds() <= 0:
            try:
                ok, _ = await close_court_post(record, "expired")
                if ok:
                    await send_log(
                        guild,
                        "Court Inquiry Auto-Closed",
                        f"**Message ID:** `{record['message_id']}`\n**Question:** {record['question']}",
                    )
            except Exception as error:
                await send_failure_alert(guild, "Court Thread Auto-Close Failed", error, "thread_closer loop")


@thread_closer.before_loop
async def before_thread_closer() -> None:
    await bot.wait_until_ready()


@bot.event
async def on_ready() -> None:
    logger.info("Logged in as %s (ID: %s)", bot.user, bot.user.id if bot.user else "unknown")


@bot.tree.error
async def on_app_command_error(
    interaction: discord.Interaction,
    error: app_commands.AppCommandError,
) -> None:
    command_name = interaction.command.qualified_name if interaction.command else "unknown"
    record_command_metric(command_name, success=False)

    if isinstance(error, app_commands.CommandOnCooldown):
        retry_after = int(error.retry_after)
        message = f"This command is on cooldown. Try again in `{retry_after}` second(s)."
        if interaction.response.is_done():
            await interaction.followup.send(message, ephemeral=True)
        else:
            await interaction.response.send_message(message, ephemeral=True)
        return

    underlying = error.original if isinstance(error, app_commands.CommandInvokeError) else error

    if interaction.guild is not None and isinstance(underlying, Exception):
        await send_failure_alert(
            interaction.guild,
            "App Command Failed",
            underlying,
            f"/{command_name} by {interaction.user}",
        )

    user_message = "The command failed unexpectedly and was logged."
    if interaction.response.is_done():
        await interaction.followup.send(user_message, ephemeral=True)
    else:
        await interaction.response.send_message(user_message, ephemeral=True)


@bot.event
async def on_message(message: discord.Message) -> None:
    if message.author.bot:
        return

    if message.guild is None or not isinstance(message.author, discord.Member):
        return

    record_user_message_metric(message.author)

    cleared_titles = clear_member_royal_afk(message.author)
    if cleared_titles:
        actor_mention = getattr(message.author, "mention", str(message.author))
        channel_mention = getattr(message.channel, "mention", f"<#{getattr(message.channel, 'id', 0)}>")
        joined_titles = ", ".join(cleared_titles)
        await send_log(
            message.guild,
            "Royal AFK Auto-Cleared",
            f"**By:** {actor_mention}\n"
            f"**Titles:** `{joined_titles}`\n"
            f"**Trigger:** Message activity in {channel_mention}",
        )

    in_royal_alert_channel = is_royal_alert_channel(getattr(message.channel, "id", None))

    if in_royal_alert_channel:
        await handle_royal_presence_announcement(message)

    if is_silence_lock_trigger(message.content) or is_emperor_lock_trigger(message.content):
        if "Emperor" not in get_member_royal_titles(message.author):
            return
        if isinstance(message.channel, discord.TextChannel):
            await lock_channel_silently(message.channel, message.author, SILENT_LOCK_SECONDS)
        return

    if await maybe_send_royal_mention_response(message, in_royal_alert_channel):
        return

    reason_text = parse_reply_mute_message(message.content)
    if reason_text is None:
        return

    if not is_admin(message.author):
        return
    await handle_reply_mute_trigger(message, reason_text)


@bot.event
async def on_raw_reaction_add(payload: discord.RawReactionActionEvent) -> None:
    if payload.guild_id is None:
        return

    guild = bot.get_guild(payload.guild_id)
    if guild is None:
        return

    member = payload.member
    if member is None:
        member = guild.get_member(payload.user_id)
        if member is None:
            try:
                member = await guild.fetch_member(payload.user_id)
            except Exception:
                return

    if member.bot:
        return

    record_user_reaction_sent_metric(member.id)

    channel = await fetch_channel_by_id(payload.channel_id)
    if not isinstance(channel, (discord.TextChannel, discord.Thread)):
        return

    try:
        message = await channel.fetch_message(payload.message_id)
    except Exception:
        return

    if message.author.bot:
        return

    record_user_reaction_received_metric(message.author.id)


if __name__ == "__main__":
    validate_runtime_config()
    bot.run(TOKEN)