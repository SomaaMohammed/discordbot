import os
import asyncio
from datetime import timedelta
from unittest.mock import AsyncMock

# Configure minimal runtime env before importing bot module.
os.environ.setdefault("DISCORD_TOKEN", "test-token")
os.environ.setdefault("TEST_GUILD_ID", "1")
os.environ.setdefault("COURT_CHANNEL_ID", "1")

import bot


def test_normalize_question_text_collapses_whitespace() -> None:
    assert bot.normalize_question_text("  hello   world  ") == "hello world"


def test_format_duration_hours_minutes() -> None:
    assert bot.format_duration(timedelta(hours=2, minutes=5, seconds=30)) == "2h 5m"


def test_count_open_and_overdue_posts() -> None:
    now = bot.get_now()
    posts = [
        {"closed": False, "posted_at": (now - timedelta(hours=25)).isoformat()},
        {"closed": False, "posted_at": (now - timedelta(hours=1)).isoformat()},
        {"closed": True, "posted_at": (now - timedelta(hours=26)).isoformat()},
    ]
    open_count, overdue_count = bot.count_open_and_overdue_posts(posts, now)
    assert open_count == 2
    assert overdue_count == 1


def test_merge_imported_state_only_applies_allowed_keys() -> None:
    merged = bot.merge_imported_state(
        {
            "mode": "auto",
            "hour": 9,
            "minute": 30,
            "unknown_key": "nope",
        }
    )
    assert merged["mode"] == "auto"
    assert merged["hour"] == 9
    assert merged["minute"] == 30
    assert "unknown_key" not in merged


def test_emperor_lock_trigger_exact_phrase_matches() -> None:
    assert bot.is_emperor_lock_trigger("The Emperor is here")
    assert bot.is_emperor_lock_trigger("the emperor is here.")


def test_emperor_mention_still_matches_general_mentions() -> None:
    assert bot.has_emperor_mention("where is sammy")
    assert bot.has_emperor_mention("long live the emperor")


def test_reply_mute_parser_extracts_optional_reason() -> None:
    assert bot.parse_reply_mute_message("invictus mute") == ""
    assert bot.parse_reply_mute_message("hey invictus timeout too loud") == "too loud"


def test_on_message_prioritizes_exact_emperor_lock_trigger(monkeypatch) -> None:
    class DummyMember:
        def __init__(self) -> None:
            self.bot = False

    class DummyTextChannel:
        def __init__(self) -> None:
            self.send = AsyncMock()

    class DummyGuild:
        pass

    class DummyMessage:
        def __init__(self) -> None:
            self.author = DummyMember()
            self.guild = DummyGuild()
            self.channel = DummyTextChannel()
            self.content = "The Emperor is here"

    lock_mock = AsyncMock()
    monkeypatch.setattr(bot.discord, "Member", DummyMember)
    monkeypatch.setattr(bot.discord, "TextChannel", DummyTextChannel)
    monkeypatch.setattr(bot, "is_staff", lambda _: True)
    monkeypatch.setattr(bot, "lock_channel_silently", lock_mock)
    monkeypatch.setattr(bot, "handle_royal_presence_announcement", AsyncMock())

    message = DummyMessage()
    asyncio.run(bot.on_message(message))

    lock_mock.assert_awaited_once_with(message.channel, message.author, bot.SILENT_LOCK_SECONDS)
    message.channel.send.assert_not_called()


def test_on_message_emperor_mention_without_lock_phrase_sends_response(monkeypatch) -> None:
    class DummyRole:
        def __init__(self, role_id: int) -> None:
            self.id = role_id

    class DummyMember:
        def __init__(self) -> None:
            self.bot = False
            self.roles = [DummyRole(bot.EMPEROR_ROLE_ID)]

    class DummyTextChannel:
        def __init__(self) -> None:
            self.send = AsyncMock()

    class DummyGuild:
        pass

    class DummyMessage:
        def __init__(self) -> None:
            self.author = DummyMember()
            self.guild = DummyGuild()
            self.channel = DummyTextChannel()
            self.content = "sammy is online"

    lock_mock = AsyncMock()
    monkeypatch.setattr(bot.discord, "Member", DummyMember)
    monkeypatch.setattr(bot.discord, "TextChannel", DummyTextChannel)
    monkeypatch.setattr(bot, "is_staff", lambda _: True)
    monkeypatch.setattr(bot, "lock_channel_silently", lock_mock)
    monkeypatch.setattr(bot, "handle_royal_presence_announcement", AsyncMock())

    message = DummyMessage()
    asyncio.run(bot.on_message(message))

    lock_mock.assert_not_called()
    message.channel.send.assert_awaited_once()
    send_args = message.channel.send.await_args
    assert send_args.args == (bot.EMPEROR_MENTION_RESPONSE,)
    assert "allowed_mentions" in send_args.kwargs
    assert send_args.kwargs["allowed_mentions"].everyone is False
    assert send_args.kwargs["allowed_mentions"].users is False
    assert send_args.kwargs["allowed_mentions"].roles is False


def test_should_announce_royal_presence_is_based_on_message_gap() -> None:
    current = bot.get_now()
    assert bot.should_announce_royal_presence(None, current)
    assert not bot.should_announce_royal_presence(current - timedelta(hours=2, minutes=59), current)
    assert bot.should_announce_royal_presence(current - timedelta(hours=3), current)


def test_handle_royal_presence_announcement_uses_last_message_interval(monkeypatch) -> None:
    class DummyRole:
        def __init__(self, role_id: int) -> None:
            self.id = role_id

    class DummyMember:
        def __init__(self, role_id: int) -> None:
            self.bot = False
            self.roles = [DummyRole(role_id)]

    class DummyChannel:
        def __init__(self) -> None:
            self.send = AsyncMock()

    class DummyMessage:
        def __init__(self, role_id: int) -> None:
            now = bot.get_now()
            self.author = DummyMember(role_id)
            self.channel = DummyChannel()
            self.created_at = now

    state = {
        "mode": "manual",
        "hour": 20,
        "minute": 0,
        "channel_id": 1,
        "log_channel_id": 0,
        "last_posted_date": None,
        "dry_run_auto_post": False,
        "last_dry_run_date": None,
        "history": [],
        "used_questions": [],
        "posts": [],
        "metrics": {},
        "royal_presence": {"last_message_at": None, "last_speaker": None},
    }

    monkeypatch.setattr(bot, "get_state", lambda: state)
    monkeypatch.setattr(bot, "save_state", lambda _: None)

    first = DummyMessage(bot.EMPEROR_ROLE_ID)
    asyncio.run(bot.handle_royal_presence_announcement(first))
    first.channel.send.assert_awaited_once()
    first_send_args = first.channel.send.await_args
    assert first_send_args.args == ("# Emperor has spoken",)
    assert "allowed_mentions" in first_send_args.kwargs
    assert first_send_args.kwargs["allowed_mentions"].everyone is False
    assert first_send_args.kwargs["allowed_mentions"].users is False
    assert first_send_args.kwargs["allowed_mentions"].roles is False

    saved_first = state["royal_presence"]["last_message_at"]
    second = DummyMessage(bot.EMPRESS_ROLE_ID)
    second.created_at = bot.parse_iso(saved_first) + timedelta(hours=2, minutes=30)
    asyncio.run(bot.handle_royal_presence_announcement(second))
    second.channel.send.assert_not_called()

    third = DummyMessage(bot.EMPRESS_ROLE_ID)
    third.created_at = bot.parse_iso(state["royal_presence"]["last_message_at"]) + timedelta(hours=3, minutes=1)
    asyncio.run(bot.handle_royal_presence_announcement(third))
    third.channel.send.assert_awaited_once()
    third_send_args = third.channel.send.await_args
    assert third_send_args.args == ("# Empress has spoken",)
    assert "allowed_mentions" in third_send_args.kwargs
    assert third_send_args.kwargs["allowed_mentions"].everyone is False
    assert third_send_args.kwargs["allowed_mentions"].users is False
    assert third_send_args.kwargs["allowed_mentions"].roles is False
