import json
import os
import random
import re
import sqlite3
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import discord
from discord import app_commands
from discord.ext import commands, tasks
from dotenv import load_dotenv

load_dotenv()

def env_int(name: str, default: int = 0) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default

    raw = raw.strip()
    if raw == "":
        return default

    try:
        return int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer in .env") from exc


TOKEN = os.getenv("DISCORD_TOKEN")
TEST_GUILD_ID = env_int("TEST_GUILD_ID", 0)
COURT_CHANNEL_ID = env_int("COURT_CHANNEL_ID", 0)
LOG_CHANNEL_ID_ENV = env_int("LOG_CHANNEL_ID", 0)
TIMEZONE_NAME = os.getenv("TIMEZONE", "Asia/Qatar")

# Roles allowed to control the bot
STAFF_ROLE_IDS = {
    1461376227095875707,  # Emperor
    1461485629178122465,  # Empress
    1461513633367330982,  # Grand Marshal
    1461513909130498230,  # Imperial Guard
}

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

MSG_USE_IN_SERVER = "Use this inside the server."
MSG_USE_TEXT_CHANNEL = "Use this command inside a text channel."
MSG_BOT_CONTEXT_ERROR = "Could not verify bot permissions in this server."
MSG_CONFIRM_REQUIRED = "Confirmation failed. Type `CONFIRM` exactly."
MSG_VERIFY_ROLES = "Could not verify your roles."
MSG_EVERYONE_MENTION = "@everyone"
MSG_INQUIRY_CLOSED = "This court inquiry is already closed."
MSG_QUESTION_EMPTY = "Question cannot be empty."

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
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS kv (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )


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
            "history": [],
            "used_questions": [],
            "posts": [],
        },
    )

    state.setdefault("mode", "manual")
    state.setdefault("hour", 20)
    state.setdefault("minute", 0)
    state.setdefault("channel_id", COURT_CHANNEL_ID)
    state.setdefault("log_channel_id", LOG_CHANNEL_ID_ENV)
    state.setdefault("last_posted_date", None)
    state.setdefault("history", [])
    state.setdefault("used_questions", [])
    state.setdefault("posts", [])

    if state.get("channel_id", 0) == 0:
        state["channel_id"] = COURT_CHANNEL_ID

    save_state(state)
    return state


def save_state(state: dict) -> None:
    state["history"] = state.get("history", [])[-HISTORY_LIMIT:]

    used = []
    seen = set()
    for question in state.get("used_questions", []):
        if question not in seen:
            used.append(question)
            seen.add(question)
    state["used_questions"] = used

    state["posts"] = state.get("posts", [])[-POST_RECORD_LIMIT:]
    save_json(STATE_FILE, state)


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
    return load_json(ANSWERS_FILE, {})


def save_answers(data: dict) -> None:
    save_json(ANSWERS_FILE, data)


def normalize_question_text(value: str) -> str:
    return " ".join(value.split()).strip()


def get_answer_bucket(question_message_id: int | str) -> dict:
    answers = get_answers()
    bucket = answers.setdefault(str(question_message_id), {"count": 0, "users": {}})
    bucket.setdefault("count", 0)
    bucket.setdefault("users", {})
    save_answers(answers)
    return bucket


def has_user_answered(question_message_id: int, user_id: int) -> bool:
    answers = get_answers()
    bucket = answers.get(str(question_message_id), {"users": {}})
    return str(user_id) in bucket.get("users", {})


def next_answer_number(question_message_id: int) -> int:
    answers = get_answers()
    bucket = answers.get(str(question_message_id), {"count": 0})
    return int(bucket.get("count", 0)) + 1


def mark_user_answered(question_message_id: int, user_id: int, answer_message_id: int) -> None:
    answers = get_answers()
    key = str(question_message_id)

    if key not in answers:
        answers[key] = {"count": 0, "users": {}}

    answers[key].setdefault("count", 0)
    answers[key].setdefault("users", {})

    answers[key]["count"] += 1
    answers[key]["users"][str(user_id)] = {
        "answer_message_id": str(answer_message_id),
        "created_at": iso_now(),
    }

    save_answers(answers)


def find_answer_record(answer_message_id: str) -> tuple[str, str] | None:
    answers = get_answers()

    for question_message_id, bucket in answers.items():
        for user_id, data in bucket.get("users", {}).items():
            if str(data.get("answer_message_id")) == str(answer_message_id):
                return question_message_id, user_id

    return None


def remove_answer_record(answer_message_id: str) -> tuple[str, str] | None:
    answers = get_answers()

    for question_message_id, bucket in answers.items():
        users = bucket.get("users", {})
        target_user_id = None
        for user_id, data in users.items():
            if str(data.get("answer_message_id")) == str(answer_message_id):
                target_user_id = user_id
                break

        if target_user_id is not None:
            del users[target_user_id]
            save_answers(answers)
            return question_message_id, target_user_id

    return None


def is_staff(member: discord.Member) -> bool:
    if member.guild_permissions.administrator:
        return True
    return any(role.id in STAFF_ROLE_IDS for role in member.roles)


def remove_question_from_state(question: str) -> None:
    state = get_state()
    state["history"] = [q for q in state.get("history", []) if q != question]
    state["used_questions"] = [q for q in state.get("used_questions", []) if q != question]
    save_state(state)


def replace_question_in_state(old_question: str, new_question: str) -> None:
    state = get_state()
    state["history"] = [new_question if q == old_question else q for q in state.get("history", [])]
    state["used_questions"] = [new_question if q == old_question else q for q in state.get("used_questions", [])]
    save_state(state)


def register_used_question(question: str) -> None:
    state = get_state()
    state["history"].append(question)
    if question not in state["used_questions"]:
        state["used_questions"].append(question)
    save_state(state)


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
    state = get_state()

    for post in reversed(state.get("posts", [])):
        if str(post.get("message_id")) == str(message_id):
            return post

    return None


def get_latest_open_post() -> dict | None:
    state = get_state()

    for post in reversed(state.get("posts", [])):
        if not post.get("closed", False):
            return post

    return None


def upsert_post_record(record: dict) -> None:
    state = get_state()
    posts = state.get("posts", [])

    for index, existing in enumerate(posts):
        if str(existing.get("message_id")) == str(record.get("message_id")):
            posts[index] = record
            state["posts"] = posts
            save_state(state)
            return

    posts.append(record)
    state["posts"] = posts
    save_state(state)


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


def extract_question_from_message(message: discord.Message | None) -> str:
    if not message or not message.embeds:
        return "Unknown question"

    embed = message.embeds[0]
    description = embed.description or ""
    marker = "**Question:**"

    if marker in description:
        return description.split(marker, 1)[1].strip()

    return "Unknown question"


def make_thread_name(question: str) -> str:
    cleaned = "".join(ch for ch in question if ch.isalnum() or ch in " -_").strip()
    cleaned = "-".join(cleaned.split())
    name = f"court-{cleaned}" if cleaned else "court-replies"
    return name[:100]


def build_embed(category: str, question: str) -> discord.Embed:
    embed = discord.Embed(
        title="📜 Imperial Court Inquiry",
        description=f"*The throne demands an answer.*\n\n**Question:** {question}",
        color=ROLE_COLOR,
        timestamp=get_now(),
    )
    embed.set_footer(text=f"Category: {category}")
    return embed


async def fetch_channel_by_id(channel_id: int | str) -> discord.abc.GuildChannel | discord.Thread | None:
    channel_id_int = int(channel_id)
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


class ClosedAnswerView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)
        button = discord.ui.Button(
            label="Court Inquiry Closed",
            style=discord.ButtonStyle.secondary,
            emoji="🔒",
            disabled=True,
        )
        self.add_item(button)


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


def status_text() -> str:
    state = get_state()
    channel_id = state["channel_id"]
    log_channel_id = state.get("log_channel_id", 0)
    channel_mention = f"<#{channel_id}>" if channel_id else "Not set"
    log_channel_mention = f"<#{log_channel_id}>" if log_channel_id else "Disabled"
    open_posts = sum(1 for post in state.get("posts", []) if not post.get("closed", False))

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

        post_record = get_post_record(interaction.message.id)
        if post_record and post_record.get("closed", False):
            await interaction.response.send_message(
                MSG_INQUIRY_CLOSED,
                ephemeral=True,
            )
            return

        question_message_id = interaction.message.id
        user_id = interaction.user.id

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
            title=f"🕯️ Anonymous Answer #{answer_number}",
            description=self.answer.value,
            color=ROLE_COLOR,
            timestamp=get_now(),
        )
        embed.set_footer(text="Submitted anonymously")

        sent = await thread.send(embed=embed)
        mark_user_answered(question_message_id, user_id, sent.id)

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
        emoji="🕯️",
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
) -> tuple[str, str]:
    chosen_category, question = pick_question(category, randomize)
    embed = build_embed(chosen_category, question)

    sent = await channel.send(
        content=MSG_EVERYONE_MENTION,
        embed=embed,
        view=AnonymousAnswerView(),
        allowed_mentions=discord.AllowedMentions(everyone=True),
    )
    thread = await get_or_create_answer_thread(sent)

    if thread is not None:
        await thread.send(
            "🕯️ **Anonymous Court Replies**\n"
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
        "closed": False,
        "closed_at": None,
        "close_reason": None,
    }
    upsert_post_record(record)

    register_used_question(question)

    state = get_state()
    state["last_posted_date"] = get_now().strftime("%Y-%m-%d")
    save_state(state)

    return chosen_category, question


class ImperialCourtBot(commands.Bot):
    async def setup_hook(self) -> None:
        guild = discord.Object(id=TEST_GUILD_ID)
        self.tree.add_command(court_group, guild=guild)
        self.tree.add_command(admin_group, guild=guild)
        self.add_view(AnonymousAnswerView())
        synced = await self.tree.sync(guild=guild)
        print(f"Synced {len(synced)} command(s) to guild {TEST_GUILD_ID}")
        auto_poster.start()
        thread_closer.start()


intents = discord.Intents.default()
intents.members = True
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


court_group = app_commands.Group(name="court", description="Imperial Court controls")
questions_group = app_commands.Group(name="questions", description="Question utilities")
court_group.add_command(questions_group)
admin_group = app_commands.Group(name="admin", description="Server admin and moderation tools")


def get_manage_target_channel(interaction: discord.Interaction) -> discord.TextChannel | None:
    if interaction.channel is None:
        return None
    if isinstance(interaction.channel, discord.TextChannel):
        return interaction.channel
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


class AdminSayModal(discord.ui.Modal, title="Send Announcement"):
    message_content = discord.ui.TextInput(
        label="Message",
        style=discord.TextStyle.paragraph,
        placeholder="Paste your announcement here...",
        required=True,
        max_length=2000,
    )

    def __init__(self, channel: discord.TextChannel):
        super().__init__(timeout=None)
        self.channel = channel

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
            await self.channel.send(
                content=MSG_EVERYONE_MENTION,
                embed=embed,
                allowed_mentions=discord.AllowedMentions(everyone=True),
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
@app_commands.describe(channel="Target channel")
async def admin_say(
    interaction: discord.Interaction,
    channel: discord.TextChannel,
) -> None:
    if not await require_staff(interaction):
        return

    await interaction.response.send_modal(AdminSayModal(channel))


@admin_group.command(name="purge", description="Delete recent messages in this channel")
@app_commands.describe(amount="How many recent messages to delete (1-100)")
async def admin_purge(
    interaction: discord.Interaction,
    amount: app_commands.Range[int, 1, 100],
) -> None:
    if not await require_staff(interaction):
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
    if not await require_staff(interaction):
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
    if not await require_staff(interaction):
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
    if not await require_staff(interaction):
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
    if not await require_staff(interaction):
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
    if not await require_staff(interaction):
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
    if not await require_staff(interaction):
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
    reason="Optional reason",
)
async def admin_mutemany(
    interaction: discord.Interaction,
    members: str,
    minutes: app_commands.Range[int, 1, MAX_TIMEOUT_MINUTES],
    reason: str | None = None,
) -> None:
    if not await require_staff(interaction):
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
    reason="Optional reason",
)
async def admin_unmutemany(
    interaction: discord.Interaction,
    members: str,
    reason: str | None = None,
) -> None:
    if not await require_staff(interaction):
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
    reason="Optional reason",
)
async def admin_muteall(
    interaction: discord.Interaction,
    minutes: app_commands.Range[int, 1, MAX_TIMEOUT_MINUTES],
    confirm: str,
    reason: str | None = None,
) -> None:
    if not await require_staff(interaction):
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
@app_commands.describe(confirm="Type CONFIRM to run", reason="Optional reason")
async def admin_unmuteall(
    interaction: discord.Interaction,
    confirm: str,
    reason: str | None = None,
) -> None:
    if not await require_staff(interaction):
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
    await interaction.response.send_message(status_text(), ephemeral=True)


@court_group.command(name="help", description="Show all available commands")
async def court_help(interaction: discord.Interaction) -> None:
    if not await require_staff(interaction):
        return

    help_text = """
**📜 Imperial Court Bot Commands**

**Court Control Commands**
`/court status` — Show current bot status
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
`/court resethistory` — Clear history and used question pool

**Court Posts**
`/court post [category] [randomize]` — Post a question now (opt: pick category/order)
`/court custom <question>` — Post a custom question immediately
`/court close [message_id]` — Close latest inquiry (or specific by ID)
`/court removeanswer <message_id>` — Remove anonymous answer by message ID

**Admin Commands**
`/admin say <channel>` — Send announcement in channel
`/admin purge <amount>` — Delete 1-100 recent messages
`/admin purgeuser <member> [amount]` — Delete member's messages (scan 1-200)
`/admin lock [reason]` — Lock channel for @everyone
`/admin unlock [reason]` — Unlock channel for @everyone
`/admin slowmode <seconds>` — Set slowmode (0-21600)
`/admin timeout <member> <minutes> [reason]` — Timeout member (1-40320 min)
`/admin untimeout <member> [reason]` — Remove timeout from member
`/admin mutemany <members> <minutes> [reason]` — Timeout multiple (space-separated IDs/mentions)
`/admin unmutemany <members> [reason]` — Remove timeout from multiple
`/admin muteall <minutes> <confirm> [reason]` — Timeout all (type CONFIRM)
`/admin unmuteall <confirm> [reason]` — Remove timeout from all (type CONFIRM)

**Categories**
`general` — Broad prompts for everyday discussion
`gaming` — Games, consoles, mechanics, franchises, hot takes
`music` — Songs, artists, albums, genres, music takes
`hot-take` — Controversial opinions and spicy takes
`chaos` — Funny, dumb, cursed, unhinged prompts

**Notes**
• Staff role required for all commands
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
        chosen_category, question = await post_question(channel, category.value if category else None, randomize)
    except ValueError as e:
        await interaction.followup.send(str(e), ephemeral=True)
        return

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
    sent = await channel.send(
        content=MSG_EVERYONE_MENTION,
        embed=embed,
        view=AnonymousAnswerView(),
        allowed_mentions=discord.AllowedMentions(everyone=True),
    )
    thread = await get_or_create_answer_thread(sent)

    if thread is not None:
        await thread.send(
            "🕯️ **Anonymous Court Replies**\n"
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
        "closed": False,
        "closed_at": None,
        "close_reason": None,
    }
    upsert_post_record(record)

    state = get_state()
    state["last_posted_date"] = get_now().strftime("%Y-%m-%d")
    save_state(state)

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

    await interaction.response.send_message(message, ephemeral=True)

    if ok:
        await send_log(
            interaction.guild,
            "Court Inquiry Closed",
            f"**By:** {interaction.user.mention}\n**Message ID:** `{record['message_id']}`\n**Question:** {record['question']}",
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


@tasks.loop(minutes=1)
async def auto_poster() -> None:
    state = get_state()

    if state["mode"] != "auto":
        return

    now = get_now()
    today = now.strftime("%Y-%m-%d")

    if state["last_posted_date"] == today:
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
        chosen_category, question = await post_question(channel)
        await send_log(
            guild,
            "Court Question Auto-Posted",
            f"**Channel:** {channel.mention}\n**Category:** `{chosen_category}`\n**Question:** {question}",
        )
    except Exception as e:
        print(f"Auto-post failed: {e}")


@auto_poster.before_loop
async def before_auto_poster() -> None:
    await bot.wait_until_ready()


@tasks.loop(minutes=10)
async def thread_closer() -> None:
    guild = bot.get_guild(TEST_GUILD_ID)
    if guild is None:
        return

    now = get_now()
    state = get_state()

    for record in state.get("posts", []):
        if record.get("closed", False):
            continue

        posted_at = parse_iso(record.get("posted_at"))
        if posted_at is None:
            continue

        if now - posted_at >= timedelta(hours=THREAD_CLOSE_HOURS):
            ok, _ = await close_court_post(record, "expired")
            if ok:
                await send_log(
                    guild,
                    "Court Inquiry Auto-Closed",
                    f"**Message ID:** `{record['message_id']}`\n**Question:** {record['question']}",
                )


@thread_closer.before_loop
async def before_thread_closer() -> None:
    await bot.wait_until_ready()


@bot.event
async def on_ready() -> None:
    print(f"Logged in as {bot.user} (ID: {bot.user.id})")


bot.run(TOKEN)