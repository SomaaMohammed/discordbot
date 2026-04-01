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


def test_extract_role_panel_role_id_reads_footer_marker() -> None:
    embed = bot.discord.Embed(title="Role Panel")
    embed.set_footer(text=f"{bot.ROLE_PANEL_FOOTER_PREFIX}123456789")

    class DummyMessage:
        def __init__(self) -> None:
            self.embeds = [embed]

    assert bot.extract_role_panel_role_id(DummyMessage()) == 123456789


def test_extract_role_panel_role_id_returns_none_without_marker() -> None:
    embed = bot.discord.Embed(title="Role Panel")
    embed.set_footer(text="NoRoleHere")

    class DummyMessage:
        def __init__(self) -> None:
            self.embeds = [embed]

    assert bot.extract_role_panel_role_id(DummyMessage()) is None


def test_extract_role_panel_role_id_for_slot_reads_multi_footer() -> None:
    embed = bot.discord.Embed(title="Role Panel")
    embed.set_footer(text=f"{bot.ROLE_PANEL_TARGETS_FOOTER_PREFIX}1=111,2=222,3=333")

    class DummyMessage:
        def __init__(self) -> None:
            self.embeds = [embed]

    message = DummyMessage()
    assert bot.extract_role_panel_role_id_for_slot(message, 1) == 111
    assert bot.extract_role_panel_role_id_for_slot(message, 2) == 222
    assert bot.extract_role_panel_role_id_for_slot(message, 3) == 333
    assert bot.extract_role_panel_role_id_for_slot(message, 4) is None


def test_extract_role_panel_button_slot_parses_expected_custom_ids() -> None:
    assert bot.extract_role_panel_button_slot(bot.ROLE_PANEL_BUTTON_CUSTOM_ID) == 1
    assert bot.extract_role_panel_button_slot(f"{bot.ROLE_PANEL_BUTTON_CUSTOM_ID}:2") == 2
    assert bot.extract_role_panel_button_slot(f"{bot.ROLE_PANEL_BUTTON_CUSTOM_ID}:5") == 5
    assert bot.extract_role_panel_button_slot(f"{bot.ROLE_PANEL_BUTTON_CUSTOM_ID}:6") is None
    assert bot.extract_role_panel_button_slot("court:other") is None


def test_toggle_role_for_member_adds_role_when_missing() -> None:
    class DummyRole:
        def __init__(self) -> None:
            self.id = 123
            self.mention = "@Role"

    class DummyMember:
        def __init__(self) -> None:
            self.add_roles = AsyncMock()
            self.remove_roles = AsyncMock()

        def get_role(self, role_id: int) -> None:
            return None

    member = DummyMember()
    role = DummyRole()

    success, error = asyncio.run(bot.toggle_role_for_member(member, role, 999))

    assert error is None
    assert success == "You now have @Role."
    member.add_roles.assert_awaited_once()
    member.remove_roles.assert_not_awaited()


def test_toggle_role_for_member_removes_role_when_present() -> None:
    class DummyRole:
        def __init__(self) -> None:
            self.id = 456
            self.mention = "@Role2"

    class DummyMember:
        def __init__(self) -> None:
            self.add_roles = AsyncMock()
            self.remove_roles = AsyncMock()

        def get_role(self, role_id: int) -> object:
            return object()

    member = DummyMember()
    role = DummyRole()

    success, error = asyncio.run(bot.toggle_role_for_member(member, role, 1001))

    assert error is None
    assert success == "Removed @Role2."
    member.remove_roles.assert_awaited_once()
    member.add_roles.assert_not_awaited()


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


def test_emperor_lock_trigger_accepts_additional_phrases() -> None:
    assert bot.is_emperor_lock_trigger("Emperor has arrived!")
    assert bot.is_emperor_lock_trigger("Make way for the emperor.")


def test_emperor_mention_still_matches_general_mentions() -> None:
    assert bot.has_emperor_mention("where is sammy")
    assert bot.has_emperor_mention("long live the emperor")


def test_emperor_mention_accepts_majesty_titles() -> None:
    assert bot.has_emperor_mention("Your Majesty, we await your command")


def test_empress_mention_matches_majesty_titles() -> None:
    assert bot.has_empress_mention("Her Majesty will arrive shortly")
    assert bot.has_empress_mention("Long live the Empress")
    assert bot.has_empress_mention("tay needs to see this")
    assert bot.has_empress_mention("taytay is online")
    assert bot.has_empress_mention("taylor has spoken")
    assert bot.has_empress_mention("tayla gave the order")


def test_parse_royal_mentions_detects_both_titles() -> None:
    mentions = bot.parse_royal_mentions("The Emperor and Empress have entered")
    assert mentions == ["Emperor", "Empress"]


def test_parse_royal_member_mentions_detects_titles_from_explicit_mentions() -> None:
    class DummyRole:
        def __init__(self, role_id: int) -> None:
            self.id = role_id

    class DummyMember:
        def __init__(self, roles: list[DummyRole]) -> None:
            self.roles = roles

    emperor = DummyMember([DummyRole(bot.EMPEROR_ROLE_ID)])
    empress = DummyMember([DummyRole(bot.EMPRESS_ROLE_ID)])

    titles = bot.parse_royal_member_mentions([emperor, empress])
    assert titles == ["Emperor", "Empress"]


def test_get_royal_afk_response_returns_active_status() -> None:
    now = bot.get_now()
    state = {
        "royal_afk": {
            "by_title": {
                "Emperor": {
                    "active": True,
                    "reason": "At war council",
                    "set_at": (now - timedelta(minutes=90)).isoformat(),
                    "set_by_user_id": "123",
                },
                "Empress": {
                    "active": False,
                    "reason": "",
                    "set_at": None,
                    "set_by_user_id": None,
                },
            }
        }
    }

    response = bot.get_royal_afk_response("Where is the emperor?", state=state, now=now)
    assert response is not None
    assert "The Emperor is currently AFK" in response
    assert "At war council" in response


def test_get_royal_afk_response_handles_explicit_member_mentions_without_keywords() -> None:
    class DummyRole:
        def __init__(self, role_id: int) -> None:
            self.id = role_id

    class DummyMember:
        def __init__(self, roles: list[DummyRole]) -> None:
            self.roles = roles

    now = bot.get_now()
    state = {
        "royal_afk": {
            "by_title": {
                "Emperor": {
                    "active": False,
                    "reason": "",
                    "set_at": None,
                    "set_by_user_id": None,
                },
                "Empress": {
                    "active": True,
                    "reason": "Reviewing decrees",
                    "set_at": (now - timedelta(minutes=15)).isoformat(),
                    "set_by_user_id": "2",
                },
            }
        }
    }

    empress_member = DummyMember([DummyRole(bot.EMPRESS_ROLE_ID)])
    response = bot.get_royal_afk_response(
        "hello there",
        mentioned_members=[empress_member],
        state=state,
        now=now,
    )

    assert response is not None
    assert "The Empress is currently AFK" in response
    assert "Reviewing decrees" in response


def test_build_royal_afk_status_report_shows_afk_and_non_afk() -> None:
    now = bot.get_now()
    state = {
        "royal_afk": {
            "by_title": {
                "Emperor": {
                    "active": True,
                    "reason": "In war council",
                    "set_at": (now - timedelta(minutes=45)).isoformat(),
                    "set_by_user_id": "1",
                },
                "Empress": {
                    "active": False,
                    "reason": "",
                    "set_at": None,
                    "set_by_user_id": None,
                },
            }
        }
    }

    report = bot.build_royal_afk_status_report(state=state, now=now)
    assert "**Emperor:** AFK for" in report
    assert "In war council" in report
    assert "**Empress:** Not AFK" in report


def test_build_royal_afk_status_report_defaults_when_missing_timestamp() -> None:
    state = {
        "royal_afk": {
            "by_title": {
                "Emperor": {
                    "active": True,
                    "reason": "Reviewing scrolls",
                    "set_at": None,
                    "set_by_user_id": "1",
                },
                "Empress": {
                    "active": False,
                    "reason": "",
                    "set_at": None,
                    "set_by_user_id": None,
                },
            }
        }
    }

    report = bot.build_royal_afk_status_report(state=state)
    assert "**Emperor:** AFK - Reviewing scrolls" in report


def test_clear_member_royal_afk_resets_active_entries(monkeypatch) -> None:
    class DummyRole:
        def __init__(self, role_id: int) -> None:
            self.id = role_id

    class DummyMember:
        def __init__(self) -> None:
            self.roles = [DummyRole(bot.EMPEROR_ROLE_ID)]

    state = {
        "royal_afk": {
            "by_title": {
                "Emperor": {
                    "active": True,
                    "reason": "Meeting",
                    "set_at": bot.iso_now(),
                    "set_by_user_id": "1",
                },
                "Empress": {
                    "active": False,
                    "reason": "",
                    "set_at": None,
                    "set_by_user_id": None,
                },
            }
        }
    }

    monkeypatch.setattr(bot, "get_state", lambda: state)
    monkeypatch.setattr(bot, "save_state", lambda _: None)

    cleared = bot.clear_member_royal_afk(DummyMember())

    assert cleared == ["Emperor"]
    emperor_state = state["royal_afk"]["by_title"]["Emperor"]
    assert emperor_state["active"] is False
    assert emperor_state["reason"] == ""
    assert emperor_state["set_at"] is None
    assert emperor_state["set_by_user_id"] is None


def test_reply_mute_parser_extracts_optional_reason() -> None:
    assert bot.parse_reply_mute_message("invictus mute") == ""
    assert bot.parse_reply_mute_message("hey invictus timeout too loud") == "too loud"


def test_reply_mute_parser_accepts_more_aliases_and_prefixes() -> None:
    assert bot.parse_reply_mute_message("hey, invictus: hush stop spamming") == "stop spamming"
    assert bot.parse_reply_mute_message("yo invictus quiet too loud") == "too loud"


def test_reply_mute_parser_accepts_you_know_what_to_do_family() -> None:
    assert bot.parse_reply_mute_message("invictus you know what to do") == ""
    assert bot.parse_reply_mute_message("invictus, you know what to do stop now") == "stop now"
    assert bot.parse_reply_mute_message("hey invictus do your thing being toxic") == "being toxic"
    assert bot.parse_reply_mute_message("invictus handle this") == ""


def test_silence_lock_trigger_accepts_additional_phrases() -> None:
    assert bot.is_silence_lock_trigger("silence now")
    assert bot.is_silence_lock_trigger("Order in the court!")


def test_build_announcement_mentions_defaults_to_no_everyone() -> None:
    content, allowed_mentions = bot.build_announcement_mentions(False)
    assert content is None
    assert allowed_mentions.everyone is False
    assert allowed_mentions.users is False
    assert allowed_mentions.roles is False


def test_build_announcement_mentions_allows_everyone_when_enabled() -> None:
    content, allowed_mentions = bot.build_announcement_mentions(True)
    assert content == bot.MSG_EVERYONE_MENTION
    assert allowed_mentions.everyone is True


def test_fetch_channel_by_id_returns_none_for_invalid_input() -> None:
    assert asyncio.run(bot.fetch_channel_by_id("invalid")) is None


def test_on_message_prioritizes_exact_emperor_lock_trigger(monkeypatch) -> None:
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
            self.id = bot.ROYAL_ALERT_CHANNEL_ID

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


def test_on_message_lock_trigger_ignores_non_emperor_even_if_staff(monkeypatch) -> None:
    class DummyRole:
        def __init__(self, role_id: int) -> None:
            self.id = role_id

    class DummyMember:
        def __init__(self) -> None:
            self.bot = False
            self.roles = [DummyRole(999)]

    class DummyTextChannel:
        def __init__(self) -> None:
            self.send = AsyncMock()
            self.id = bot.ROYAL_ALERT_CHANNEL_ID

    class DummyGuild:
        pass

    class DummyMessage:
        def __init__(self) -> None:
            self.author = DummyMember()
            self.guild = DummyGuild()
            self.channel = DummyTextChannel()
            self.content = "silence now"

    lock_mock = AsyncMock()
    royal_mock = AsyncMock()
    monkeypatch.setattr(bot.discord, "Member", DummyMember)
    monkeypatch.setattr(bot.discord, "TextChannel", DummyTextChannel)
    monkeypatch.setattr(bot, "is_staff", lambda _: True)
    monkeypatch.setattr(bot, "lock_channel_silently", lock_mock)
    monkeypatch.setattr(bot, "handle_royal_presence_announcement", royal_mock)

    message = DummyMessage()
    asyncio.run(bot.on_message(message))

    lock_mock.assert_not_called()


def test_on_message_emperor_mention_without_lock_phrase_does_not_send_when_not_afk(monkeypatch) -> None:
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
            self.id = bot.ROYAL_ALERT_CHANNEL_ID

    class DummyGuild:
        pass

    class DummyMessage:
        def __init__(self) -> None:
            self.author = DummyMember()
            self.guild = DummyGuild()
            self.channel = DummyTextChannel()
            self.content = "sammy is online"

    lock_mock = AsyncMock()
    royal_mock = AsyncMock()
    monkeypatch.setattr(bot.discord, "Member", DummyMember)
    monkeypatch.setattr(bot.discord, "TextChannel", DummyTextChannel)
    monkeypatch.setattr(bot, "is_staff", lambda _: True)
    monkeypatch.setattr(bot, "lock_channel_silently", lock_mock)
    monkeypatch.setattr(bot, "handle_royal_presence_announcement", royal_mock)

    message = DummyMessage()
    asyncio.run(bot.on_message(message))

    lock_mock.assert_not_called()
    message.channel.send.assert_not_called()
    royal_mock.assert_awaited_once_with(message)


def test_on_message_emperor_afk_response_overrides_default_mention(monkeypatch) -> None:
    class DummyMember:
        def __init__(self) -> None:
            self.bot = False
            self.roles = []

    class DummyTextChannel:
        def __init__(self) -> None:
            self.send = AsyncMock()
            self.id = bot.ROYAL_ALERT_CHANNEL_ID

    class DummyGuild:
        pass

    class DummyMessage:
        def __init__(self) -> None:
            self.author = DummyMember()
            self.guild = DummyGuild()
            self.channel = DummyTextChannel()
            self.content = "sammy where are you"

    monkeypatch.setattr(bot.discord, "Member", DummyMember)
    monkeypatch.setattr(bot.discord, "TextChannel", DummyTextChannel)
    monkeypatch.setattr(bot, "handle_royal_presence_announcement", AsyncMock())
    monkeypatch.setattr(
        bot,
        "get_royal_afk_response",
        lambda *_args, **_kwargs: "The Emperor is currently AFK: At war council",
    )

    message = DummyMessage()
    asyncio.run(bot.on_message(message))

    message.channel.send.assert_awaited_once()
    send_args = message.channel.send.await_args
    assert send_args.args == ("The Emperor is currently AFK: At war council",)
    assert send_args.kwargs["allowed_mentions"].everyone is False
    assert send_args.kwargs["allowed_mentions"].users is False
    assert send_args.kwargs["allowed_mentions"].roles is False


def test_on_message_does_not_send_royal_or_mention_messages_outside_target_channel(monkeypatch) -> None:
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
            self.id = 999

    class DummyGuild:
        pass

    class DummyMessage:
        def __init__(self) -> None:
            self.author = DummyMember()
            self.guild = DummyGuild()
            self.channel = DummyTextChannel()
            self.content = "sammy is online"

    lock_mock = AsyncMock()
    royal_mock = AsyncMock()
    monkeypatch.setattr(bot.discord, "Member", DummyMember)
    monkeypatch.setattr(bot.discord, "TextChannel", DummyTextChannel)
    monkeypatch.setattr(bot, "is_staff", lambda _: True)
    monkeypatch.setattr(bot, "lock_channel_silently", lock_mock)
    monkeypatch.setattr(bot, "handle_royal_presence_announcement", royal_mock)

    message = DummyMessage()
    asyncio.run(bot.on_message(message))

    lock_mock.assert_not_called()
    royal_mock.assert_not_called()
    message.channel.send.assert_not_called()


def test_should_announce_royal_presence_is_based_on_message_gap() -> None:
    current = bot.get_now()
    assert bot.should_announce_royal_presence(None, current)
    assert not bot.should_announce_royal_presence(current - timedelta(hours=2, minutes=59), current)
    assert bot.should_announce_royal_presence(current - timedelta(hours=3), current)


def test_reset_royal_presence_timer_clears_last_message_and_speaker(monkeypatch) -> None:
    state = {
        "royal_presence": {
            "last_message_at": bot.get_now().isoformat(),
            "last_speaker": "Emperor",
            "last_message_at_by_title": {
                "Emperor": bot.get_now().isoformat(),
                "Empress": bot.get_now().isoformat(),
            },
        }
    }

    monkeypatch.setattr(bot, "get_state", lambda: state)
    monkeypatch.setattr(bot, "save_state", lambda _: None)

    bot.reset_royal_presence_timer()

    assert state["royal_presence"]["last_message_at"] is None
    assert state["royal_presence"]["last_speaker"] is None
    assert state["royal_presence"]["last_message_at_by_title"]["Emperor"] is None
    assert state["royal_presence"]["last_message_at_by_title"]["Empress"] is None


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
        "royal_presence": {
            "last_message_at": None,
            "last_speaker": None,
            "last_message_at_by_title": {
                "Emperor": None,
                "Empress": None,
            },
        },
    }

    monkeypatch.setattr(bot, "get_state", lambda: state)
    monkeypatch.setattr(bot, "save_state", lambda _: None)

    first = DummyMessage(bot.EMPEROR_ROLE_ID)
    asyncio.run(bot.handle_royal_presence_announcement(first))
    first.channel.send.assert_awaited_once()
    first_send_args = first.channel.send.await_args
    assert first_send_args.args == ("# The Emperor has spoken",)
    assert "allowed_mentions" in first_send_args.kwargs
    assert first_send_args.kwargs["allowed_mentions"].everyone is False
    assert first_send_args.kwargs["allowed_mentions"].users is False
    assert first_send_args.kwargs["allowed_mentions"].roles is False

    saved_first = state["royal_presence"]["last_message_at_by_title"]["Emperor"]
    second = DummyMessage(bot.EMPRESS_ROLE_ID)
    second.created_at = bot.parse_iso(saved_first) + timedelta(hours=2, minutes=30)
    asyncio.run(bot.handle_royal_presence_announcement(second))
    second.channel.send.assert_awaited_once()

    third = DummyMessage(bot.EMPRESS_ROLE_ID)
    third.created_at = bot.parse_iso(state["royal_presence"]["last_message_at_by_title"]["Empress"]) + timedelta(hours=3, minutes=1)
    asyncio.run(bot.handle_royal_presence_announcement(third))
    third.channel.send.assert_awaited_once()
    third_send_args = third.channel.send.await_args
    assert third_send_args.args == ("# The Empress has spoken",)
    assert "allowed_mentions" in third_send_args.kwargs
    assert third_send_args.kwargs["allowed_mentions"].everyone is False
    assert third_send_args.kwargs["allowed_mentions"].users is False
    assert third_send_args.kwargs["allowed_mentions"].roles is False


def test_validate_anonymous_answer_submission_blocks_links_by_default() -> None:
    class DummyMember:
        def __init__(self) -> None:
            now = bot.get_now()
            self.id = 1
            self.roles = []
            self.created_at = now - timedelta(days=30)
            self.joined_at = now - timedelta(days=30)

    message = bot.validate_anonymous_answer_submission(DummyMember(), "check this out https://example.com")
    assert message == "Links are currently disabled for anonymous answers."


def test_remaining_anonymous_cooldown_seconds_uses_last_answer_time(monkeypatch) -> None:
    monkeypatch.setattr(bot, "ANON_COOLDOWN_SECONDS", 60)
    monkeypatch.setattr(
        bot,
        "get_last_answer_time_for_user",
        lambda _user_id: bot.datetime.now(bot.timezone.utc) - timedelta(seconds=25),
    )

    remaining = bot.remaining_anonymous_cooldown_seconds(123)
    assert 30 <= remaining <= 35


def test_get_post_close_deadline_uses_record_specific_hours() -> None:
    now = bot.get_now()
    record = {
        "posted_at": now.isoformat(),
        "close_after_hours": 48,
    }
    deadline = bot.get_post_close_deadline(record)
    assert deadline is not None
    assert int((deadline - now).total_seconds()) == 48 * 3600


def test_get_week_key_is_stable_for_iso_week() -> None:
    sample = bot.datetime(2026, 1, 5, 12, 0, 0)
    assert bot.get_week_key(sample) == "2026-W02"
