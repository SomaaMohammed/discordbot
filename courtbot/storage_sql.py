KV_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
"""

POSTS_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS posts (
    message_id TEXT PRIMARY KEY,
    thread_id TEXT,
    channel_id TEXT NOT NULL,
    category TEXT NOT NULL,
    question TEXT NOT NULL,
    posted_at TEXT NOT NULL,
    close_after_hours INTEGER NOT NULL DEFAULT 24,
    closed INTEGER NOT NULL DEFAULT 0,
    closed_at TEXT,
    close_reason TEXT
)
"""

ANSWERS_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS answers (
    question_message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    answer_message_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (question_message_id, user_id)
)
"""

METRICS_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS metrics (
    metric_key TEXT PRIMARY KEY,
    metric_value TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
"""

ANON_COOLDOWNS_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS anon_cooldowns (
    user_id TEXT PRIMARY KEY,
    last_answer_at TEXT NOT NULL
)
"""
