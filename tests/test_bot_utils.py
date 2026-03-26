import os
from datetime import timedelta

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
