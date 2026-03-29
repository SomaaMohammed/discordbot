from __future__ import annotations

import os
from dataclasses import dataclass


DEFAULT_STAFF_ROLE_IDS = {
    1461376227095875707,
    1461386876475932806,
    1461485629178122465,
    1461513633367330982,
    1461513909130498230,
}

DEFAULT_SILENT_LOCK_EXCLUDE_ROLES = {
    1462082750101328029,
    1461500213746204921,
    1461382351874424842,
}


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


def env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default

    normalized = raw.strip().casefold()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise RuntimeError(f"{name} must be a boolean-like value in .env")


def env_int_set(name: str, default: set[int]) -> set[int]:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return set(default)

    values: set[int] = set()
    for token in raw.split(","):
        stripped = token.strip()
        if not stripped:
            continue
        try:
            values.add(int(stripped))
        except ValueError as exc:
            raise RuntimeError(f"{name} must be a comma-separated list of integers") from exc

    return values


@dataclass(frozen=True)
class RuntimeConfig:
    test_guild_id: int
    court_channel_id: int
    log_channel_id: int
    timezone_name: str
    staff_role_ids: set[int]
    emperor_role_id: int
    empress_role_id: int
    silent_lock_exclude_roles: set[int]
    royal_alert_channel_id: int
    undefeated_user_id: int
    anon_min_account_age_minutes: int
    anon_min_member_age_minutes: int
    anon_required_role_id: int
    anon_cooldown_seconds: int
    anon_allow_links: bool
    muteall_target_cap: int
    weekly_digest_channel_id: int
    weekly_digest_weekday: int
    weekly_digest_hour: int
    answer_retention_days: int


def load_runtime_config() -> RuntimeConfig:
    return RuntimeConfig(
        test_guild_id=env_int("TEST_GUILD_ID", 0),
        court_channel_id=env_int("COURT_CHANNEL_ID", 0),
        log_channel_id=env_int("LOG_CHANNEL_ID", 0),
        timezone_name=os.getenv("TIMEZONE", "Asia/Qatar"),
        staff_role_ids=env_int_set("STAFF_ROLE_IDS", DEFAULT_STAFF_ROLE_IDS),
        emperor_role_id=env_int("EMPEROR_ROLE_ID", 1461376227095875707),
        empress_role_id=env_int("EMPRESS_ROLE_ID", 1461485629178122465),
        silent_lock_exclude_roles=env_int_set("SILENT_LOCK_EXCLUDE_ROLES", DEFAULT_SILENT_LOCK_EXCLUDE_ROLES),
        royal_alert_channel_id=env_int("ROYAL_ALERT_CHANNEL_ID", 1461374216795328515),
        undefeated_user_id=env_int("UNDEFEATED_USER_ID", 934478657114742874),
        anon_min_account_age_minutes=max(0, env_int("ANON_MIN_ACCOUNT_AGE_MINUTES", 0)),
        anon_min_member_age_minutes=max(0, env_int("ANON_MIN_MEMBER_AGE_MINUTES", 0)),
        anon_required_role_id=max(0, env_int("ANON_REQUIRED_ROLE_ID", 0)),
        anon_cooldown_seconds=max(0, env_int("ANON_COOLDOWN_SECONDS", 0)),
        anon_allow_links=env_bool("ANON_ALLOW_LINKS", False),
        muteall_target_cap=max(0, env_int("MUTEALL_TARGET_CAP", 0)),
        weekly_digest_channel_id=max(0, env_int("WEEKLY_DIGEST_CHANNEL_ID", 0)),
        weekly_digest_weekday=min(6, max(0, env_int("WEEKLY_DIGEST_WEEKDAY", 0))),
        weekly_digest_hour=min(23, max(0, env_int("WEEKLY_DIGEST_HOUR", 19))),
        answer_retention_days=max(1, env_int("ANSWER_RETENTION_DAYS", 90)),
    )
