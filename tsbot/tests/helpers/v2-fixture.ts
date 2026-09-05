import Database from "../../src/storage/database.js";

export function createV2FixtureDatabase(dbFile: string): Database {
  const db = new Database(dbFile);
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE guilds (
      guild_id TEXT NOT NULL PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      name TEXT,
      joined_at TEXT,
      left_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE guild_settings (
      guild_id TEXT NOT NULL PRIMARY KEY,
      settings_version INTEGER NOT NULL,
      settings_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
    );
    CREATE TABLE kv (
      guild_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, key),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
    );
    CREATE TABLE posts (
      guild_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      thread_id TEXT,
      channel_id TEXT NOT NULL,
      category TEXT NOT NULL,
      question TEXT NOT NULL,
      posted_at TEXT NOT NULL,
      close_after_hours INTEGER NOT NULL DEFAULT 24,
      closed INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0, 1)),
      closed_at TEXT,
      close_reason TEXT,
      PRIMARY KEY (guild_id, message_id),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
    );
    CREATE TABLE answers (
      guild_id TEXT NOT NULL,
      question_message_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      answer_message_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, question_message_id, user_id),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
    );
    CREATE TABLE metrics (
      guild_id TEXT NOT NULL,
      metric_key TEXT NOT NULL,
      metric_value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, metric_key),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
    );
    CREATE TABLE anon_cooldowns (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      last_answer_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, user_id),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
    );
    CREATE INDEX idx_posts_guild_closed_posted_at
      ON posts (guild_id, closed, julianday(posted_at));
    CREATE INDEX idx_posts_guild_posted_at
      ON posts (guild_id, julianday(posted_at));
    CREATE INDEX idx_answers_guild_question_created
      ON answers (guild_id, question_message_id, created_at);
    CREATE INDEX idx_answers_guild_message_id
      ON answers (guild_id, answer_message_id);
    CREATE INDEX idx_answers_guild_created_at
      ON answers (guild_id, julianday(created_at));
    CREATE INDEX idx_guilds_enabled_left_at
      ON guilds (enabled, left_at);
    INSERT INTO schema_migrations (version, applied_at)
      VALUES (2, '2026-01-01T00:00:00.000Z');
  `);
  return db;
}

export function createV2Settings(): Record<string, unknown> {
  return {
    version: 1,
    enabled: true,
    timezone: "Asia/Amman",
    features: {
      court: false,
      invictusChat: true,
      anonymousAnswers: false,
      replyModeration: true,
      silenceLock: false,
      royalAfk: false,
      royalPresence: false,
      weeklyDigest: false,
      greetings: true,
    },
    channels: {
      court: null,
      log: "333333333333333333",
      weeklyDigest: null,
      royalAlert: null,
    },
    roles: {
      staff: [],
      privilegedChat: [],
      emperor: null,
      empress: null,
      silenceTargets: [],
      silenceExcludes: [],
      anonymousRequired: null,
    },
    labels: {
      emperor: "Former A",
      empress: "Former B",
    },
    invocation: {
      keyword: "superior",
      aliases: ["helper bot"],
    },
    courtSchedule: {
      mode: "off",
      hour: 20,
      minute: 0,
      dryRun: false,
    },
    weeklyDigestSchedule: {
      weekday: 0,
      hour: 19,
    },
    limits: {
      anonMinAccountAgeMinutes: 0,
      anonMinMemberAgeMinutes: 0,
      anonCooldownSeconds: 0,
      anonAllowLinks: false,
      muteallTargetCap: 50,
      answerRetentionDays: 90,
    },
    championUserId: null,
    greetings: [
      {
        name: "hello",
        userId: "444444444444444444",
        message: "Welcome <@444444444444444444>!",
      },
    ],
  };
}

export function insertV2Guild(
  db: Database,
  options: {
    guildId: string;
    enabled?: boolean;
    name?: string;
    leftAt?: string | null;
    settings?: unknown;
    settingsVersion?: number;
  },
): void {
  const enabled = options.enabled ?? true;
  const timestamp = "2026-01-02T00:00:00.000Z";
  db.prepare(
    `INSERT INTO guilds (
       guild_id, enabled, name, joined_at, left_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    options.guildId,
    enabled ? 1 : 0,
    options.name ?? "Synthetic Guild",
    "2026-01-01T00:00:00.000Z",
    options.leftAt ?? null,
    timestamp,
    timestamp,
  );
  const settings = options.settings ?? createV2Settings();
  db.prepare(
    `INSERT INTO guild_settings (
       guild_id, settings_version, settings_json, updated_at
     ) VALUES (?, ?, ?, ?)`,
  ).run(
    options.guildId,
    options.settingsVersion ?? 1,
    JSON.stringify(settings),
    timestamp,
  );
}
