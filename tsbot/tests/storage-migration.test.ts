import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { parseGuildSettingsJson } from "../src/guild-settings.js";
import { CourtStorage } from "../src/storage/db.js";
import {
  migrateDatabase,
  validateDatabaseFile,
  type MigrationFailurePoint,
} from "../src/storage/migration.js";
import {
  detectDatabaseSchema,
  validateV2Schema,
} from "../src/storage/schema.js";

const LEGACY_GUILD = "111111111111111111";
const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "court-migration-"));
  roots.push(root);
  return root;
}

function createLegacyDatabase(dbFile: string, withRows = true): void {
  const db = new Database(dbFile);
  try {
    db.exec(`
      CREATE TABLE kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE posts (
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
      );
      CREATE TABLE answers (
        question_message_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        answer_message_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (question_message_id, user_id)
      );
      CREATE TABLE metrics (
        metric_key TEXT PRIMARY KEY,
        metric_value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE anon_cooldowns (
        user_id TEXT PRIMARY KEY,
        last_answer_at TEXT NOT NULL
      );
      CREATE INDEX idx_posts_closed_posted_at
        ON posts (closed, posted_at);
      CREATE INDEX idx_answers_question_created
        ON answers (question_message_id, created_at);
      CREATE INDEX idx_answers_message_id
        ON answers (answer_message_id);
    `);
    if (!withRows) {
      return;
    }

    const state = {
      mode: "auto",
      hour: 7,
      minute: 15,
      channel_id: "444444444444444444",
      log_channel_id: "444444444444444445",
      dry_run_auto_post: true,
      last_posted_date: "2026-01-03",
      last_dry_run_date: "2026-01-02",
      last_weekly_digest_week: "2026-W01",
      history: Array.from({ length: 60 }, (_, index) => `History ${index}?`),
      used_questions: ["Used?", "Used again?", "Used?"],
      royal_presence: {
        last_message_at_by_title: {
          Emperor: "2026-01-01T00:00:00.000Z",
          Empress: null,
        },
        last_message_at: "2026-01-01T00:00:00.000Z",
        last_speaker: "Emperor",
      },
      royal_afk: {
        by_title: {
          Emperor: {
            active: true,
            reason: "Away",
            set_at: "2026-01-01T00:00:00.000Z",
            set_by_user_id: "777777777777777777",
          },
          Empress: {
            active: false,
            reason: "",
            set_at: null,
            set_by_user_id: null,
          },
        },
      },
      custom_operator_state: {
        note: "preserve this unknown state",
        flags: ["alpha", "beta"],
      },
    };
    const insertKv = db.prepare(
      "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)",
    );
    insertKv.run("state", JSON.stringify(state), "2026-01-03T00:00:00.000Z");
    insertKv.run(
      "questions",
      JSON.stringify({ general: ["Migrated?"] }),
      "2026-01-03T00:00:00.000Z",
    );
    insertKv.run(
      "answers",
      JSON.stringify({ legacy: true }),
      "2026-01-03T00:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO posts (
         message_id, thread_id, channel_id, category, question, posted_at,
         close_after_hours, closed, closed_at, close_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "900000000000000001",
      "900000000000000002",
      "333333333333333333",
      "general",
      "Migrated?",
      "2026-01-01T00:00:00.000Z",
      24,
      0,
      null,
      null,
    );
    db.prepare(
      `INSERT INTO answers (
         question_message_id, user_id, answer_message_id, created_at
       ) VALUES (?, ?, ?, ?)`,
    ).run(
      "900000000000000001",
      "700000000000000001",
      "600000000000000001",
      "2026-01-01T01:00:00.000Z",
    );
    db.prepare(
      "INSERT INTO metrics (metric_key, metric_value, updated_at) VALUES (?, ?, ?)",
    ).run("posts_total", "1", "2026-01-01T00:00:00.000Z");
    db.prepare(
      "INSERT INTO metrics (metric_key, metric_value, updated_at) VALUES (?, ?, ?)",
    ).run(
      "user_stats.700000000000000001.messages_sent",
      "4",
      "2026-01-01T00:00:00.000Z",
    );
    db.prepare(
      "INSERT INTO anon_cooldowns (user_id, last_answer_at) VALUES (?, ?)",
    ).run("700000000000000001", "2026-01-01T01:00:00.000Z");
  } finally {
    db.close();
  }
}

function migrationEnvironment(): NodeJS.ProcessEnv {
  return {
    COURT_CHANNEL_ID: "333333333333333333",
    LOG_CHANNEL_ID: "555555555555555555",
    TIMEZONE: "Asia/Amman",
    STAFF_ROLE_IDS: "666666666666666666",
    WEEKLY_DIGEST_WEEKDAY: "2",
    WEEKLY_DIGEST_HOUR: "18",
    ANSWER_RETENTION_DAYS: "45",
  };
}

function updateLegacyState(
  dbFile: string,
  mutate: (state: Record<string, unknown>) => void,
): string {
  const db = new Database(dbFile);
  try {
    const row = db.prepare("SELECT value FROM kv WHERE key = 'state'").get() as {
      value: string;
    };
    const state = JSON.parse(row.value) as Record<string, unknown>;
    mutate(state);
    const raw = JSON.stringify(state);
    db.prepare("UPDATE kv SET value = ? WHERE key = 'state'").run(raw);
    return raw;
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("v1 to v2 migration", () => {
  it("copies every legacy table, separates settings from state, and validates schema", () => {
    const root = makeRoot();
    const dbFile = path.join(root, "legacy.db");
    createLegacyDatabase(dbFile);

    const result = migrateDatabase({
      dbFile,
      legacyGuildId: LEGACY_GUILD,
      environment: migrationEnvironment(),
      now: () => "2026-02-01T00:00:00.000Z",
    });

    expect(result.status).toBe("migrated");
    expect(result.copiedRows).toEqual({
      kv: 3,
      posts: 1,
      answers: 1,
      metrics: 2,
      anon_cooldowns: 1,
    });

    const db = new Database(dbFile, { readonly: true, fileMustExist: true });
    try {
      expect(detectDatabaseSchema(db)).toBe("current-v2");
      expect(validateV2Schema(db)).toEqual([]);
      expect(db.pragma("quick_check", { simple: true })).toBe("ok");

      for (const [table, count] of Object.entries(result.copiedRows)) {
        const row = db
          .prepare(
            `SELECT COUNT(*) AS count FROM "${table}" WHERE guild_id = ?`,
          )
          .get(LEGACY_GUILD) as { count: number };
        expect(row.count).toBe(count);
      }

      expect(
        db
          .prepare(
            `SELECT message_id, thread_id, channel_id
             FROM posts WHERE guild_id = ?`,
          )
          .get(LEGACY_GUILD),
      ).toEqual({
        message_id: "900000000000000001",
        thread_id: "900000000000000002",
        channel_id: "333333333333333333",
      });
      expect(
        db
          .prepare(
            `SELECT question_message_id, user_id, answer_message_id
             FROM answers WHERE guild_id = ?`,
          )
          .get(LEGACY_GUILD),
      ).toEqual({
        question_message_id: "900000000000000001",
        user_id: "700000000000000001",
        answer_message_id: "600000000000000001",
      });
      expect(
        db
          .prepare(
            `SELECT user_id FROM anon_cooldowns WHERE guild_id = ?`,
          )
          .get(LEGACY_GUILD),
      ).toEqual({ user_id: "700000000000000001" });
      expect(
        db
          .prepare(
            `SELECT metric_key FROM metrics
             WHERE guild_id = ? AND metric_key LIKE 'user_stats.%'`,
          )
          .get(LEGACY_GUILD),
      ).toEqual({
        metric_key: "user_stats.700000000000000001.messages_sent",
      });

      const settingsRow = db
        .prepare(
          "SELECT settings_json FROM guild_settings WHERE guild_id = ?",
        )
        .get(LEGACY_GUILD) as { settings_json: string };
      const settings = parseGuildSettingsJson(settingsRow.settings_json);
      expect(settings).toMatchObject({
        enabled: true,
        timezone: "Asia/Amman",
        channels: {
          court: "333333333333333333",
          log: "555555555555555555",
        },
        courtSchedule: {
          mode: "auto",
          hour: 7,
          minute: 15,
          dryRun: true,
        },
        weeklyDigestSchedule: { weekday: 2, hour: 18 },
        limits: { answerRetentionDays: 45 },
      });

      const stateRow = db
        .prepare("SELECT value FROM kv WHERE guild_id = ? AND key = 'state'")
        .get(LEGACY_GUILD) as { value: string };
      const state = JSON.parse(stateRow.value) as Record<string, unknown>;
      expect(state).toMatchObject({
        last_posted_date: "2026-01-03",
        last_dry_run_date: "2026-01-02",
        last_weekly_digest_week: "2026-W01",
        history: Array.from({ length: 60 }, (_, index) => `History ${index}?`),
        used_questions: ["Used?", "Used again?", "Used?"],
        royal_presence: {
          last_message_at: "2026-01-01T00:00:00.000Z",
          last_speaker: "Emperor",
        },
        royal_afk: {
          by_title: {
            Emperor: {
              active: true,
              reason: "Away",
              set_by_user_id: "777777777777777777",
            },
          },
        },
        custom_operator_state: {
          note: "preserve this unknown state",
          flags: ["alpha", "beta"],
        },
      });
      expect(state).not.toHaveProperty("mode");
      expect(state).not.toHaveProperty("channel_id");
      expect(state).not.toHaveProperty("dry_run_auto_post");
      expect(
        db.pragma("foreign_key_list(posts)") as Array<Record<string, unknown>>,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            table: "guilds",
            from: "guild_id",
            to: "guild_id",
            on_delete: "CASCADE",
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it("preserves migrated unknown state fields through later runtime updates", () => {
    const root = makeRoot();
    const dbFile = path.join(root, "preserved-state.db");
    createLegacyDatabase(dbFile);
    migrateDatabase({
      dbFile,
      legacyGuildId: LEGACY_GUILD,
      environment: migrationEnvironment(),
    });

    const storage = new CourtStorage({ dbFile }, root);
    storage.initStorage();
    try {
      storage.forGuild(LEGACY_GUILD).updateStateAtomic((state) => {
        state.last_posted_date = "2026-02-02";
      });
    } finally {
      storage.close();
    }

    const verify = new Database(dbFile, { readonly: true });
    try {
      const row = verify
        .prepare("SELECT value FROM kv WHERE guild_id = ? AND key = 'state'")
        .get(LEGACY_GUILD) as { value: string };
      const state = JSON.parse(row.value) as Record<string, unknown>;
      expect(state.custom_operator_state).toEqual({
        note: "preserve this unknown state",
        flags: ["alpha", "beta"],
      });
      expect(state.last_posted_date).toBe("2026-02-02");
      expect(state).not.toHaveProperty("mode");
      expect(state).not.toHaveProperty("channel_id");
      expect(state).not.toHaveProperty("posts");
      expect(state).not.toHaveProperty("metrics");
    } finally {
      verify.close();
    }
  });

  it("adopts rounded legacy user metrics lazily without deleting collisions", () => {
    const root = makeRoot();
    const dbFile = path.join(root, "rounded-user-metrics.db");
    const exactUserA = "700000000000000001";
    const exactUserB = "700000000000000002";
    const roundedUser = String(Number.parseInt(exactUserA, 10));
    expect(String(Number.parseInt(exactUserB, 10))).toBe(roundedUser);
    expect(roundedUser).not.toBe(exactUserA);

    createLegacyDatabase(dbFile);
    const legacy = new Database(dbFile);
    try {
      legacy
        .prepare(
          `UPDATE metrics SET metric_key = ?
           WHERE metric_key = 'user_stats.700000000000000001.messages_sent'`,
        )
        .run(`user_stats.${roundedUser}.messages_sent`);
    } finally {
      legacy.close();
    }
    migrateDatabase({
      dbFile,
      legacyGuildId: LEGACY_GUILD,
      environment: migrationEnvironment(),
    });

    const storage = new CourtStorage({ dbFile }, root);
    storage.initStorage();
    try {
      const guild = storage.forGuild(LEGACY_GUILD);
      const exactKeyA = guild.buildUserMetricKey(exactUserA, "messages_sent");
      const exactKeyB = guild.buildUserMetricKey(exactUserB, "messages_sent");
      const legacyKey = `user_stats.${roundedUser}.messages_sent`;

      expect(guild.getUserFunMetrics(exactUserA).messages_sent).toBe(4);
      expect(guild.exportData().metrics.map((row) => row.key)).not.toContain(
        exactKeyA,
      );

      expect(guild.metricsIncrement(exactKeyA)).toBe(5);
      expect(
        guild.mergeUserMetricBackfill(
          { [exactUserB]: 6 },
          "messages_sent",
        ),
      ).toEqual([1, 1]);

      expect(guild.metricsGet(legacyKey, "0")).toBe("4");
      expect(guild.metricsGet(exactKeyA, "0")).toBe("5");
      expect(guild.metricsGet(exactKeyB, "0")).toBe("6");
      expect(guild.exportData().metrics.map((row) => row.key)).toEqual(
        expect.arrayContaining([legacyKey, exactKeyA, exactKeyB]),
      );
      expect(guild.listTopUsersForMetric("messages_sent", 5)).toEqual([
        [exactUserB, 6],
        [exactUserA, 5],
      ]);
    } finally {
      storage.close();
    }
  });

  it.each([
    ["channel_id", "COURT_CHANNEL_ID", "333333333333333333"],
    ["log_channel_id", "LOG_CHANNEL_ID", "444444444444444444"],
  ] as const)(
    "refuses numeric legacy %s without an exact %s override and leaves v1 intact",
    (stateKey, environmentKey, numericSource) => {
      const root = makeRoot();
      const dbFile = path.join(root, "numeric-state-id.db");
      createLegacyDatabase(dbFile);
      const originalState = updateLegacyState(dbFile, (state) => {
        state[stateKey] = Number(numericSource);
      });
      const environment = migrationEnvironment();
      delete environment[environmentKey];

      expect(() =>
        migrateDatabase({
          dbFile,
          legacyGuildId: LEGACY_GUILD,
          environment,
        }),
      ).toThrow(environmentKey);

      const verify = new Database(dbFile, { readonly: true });
      try {
        expect(detectDatabaseSchema(verify)).toBe("legacy-v1");
        expect(
          (
            verify.prepare("SELECT value FROM kv WHERE key = 'state'").get() as {
              value: string;
            }
          ).value,
        ).toBe(originalState);
      } finally {
        verify.close();
      }
    },
  );

  it("uses exact environment overrides when legacy state channel IDs are numeric", () => {
    const root = makeRoot();
    const dbFile = path.join(root, "numeric-state-overridden.db");
    createLegacyDatabase(dbFile);
    updateLegacyState(dbFile, (state) => {
      state.channel_id = Number("333333333333333333");
      state.log_channel_id = Number("444444444444444444");
    });

    expect(
      migrateDatabase({
        dbFile,
        legacyGuildId: LEGACY_GUILD,
        environment: migrationEnvironment(),
      }).status,
    ).toBe("migrated");

    const storage = new CourtStorage({ dbFile }, root);
    storage.initStorage();
    try {
      expect(storage.getGuildSettings(LEGACY_GUILD)?.channels).toMatchObject({
        court: "333333333333333333",
        log: "555555555555555555",
      });
    } finally {
      storage.close();
    }
  });

  it("is idempotent and never overwrites migrated settings", () => {
    const root = makeRoot();
    const dbFile = path.join(root, "legacy.db");
    createLegacyDatabase(dbFile);
    migrateDatabase({
      dbFile,
      legacyGuildId: LEGACY_GUILD,
      environment: migrationEnvironment(),
      now: () => "2026-02-01T00:00:00.000Z",
    });
    const before = fs.statSync(dbFile).size;

    const second = migrateDatabase({
      dbFile,
      legacyGuildId: "222222222222222222",
      environment: { COURT_CHANNEL_ID: "999999999999999999" },
      now: () => "2030-01-01T00:00:00.000Z",
    });

    expect(second.status).toBe("already-current");
    expect(fs.statSync(dbFile).size).toBe(before);
    const db = new Database(dbFile, { readonly: true });
    try {
      const rows = db
        .prepare("SELECT guild_id, updated_at FROM guild_settings")
        .all() as Array<{ guild_id: string; updated_at: string }>;
      expect(rows).toEqual([
        {
          guild_id: LEGACY_GUILD,
          updated_at: "2026-02-01T00:00:00.000Z",
        },
      ]);
    } finally {
      db.close();
    }
  });

  it.each<MigrationFailurePoint>([
    "after-rename",
    "after-create",
    "after-copy",
    "after-verify",
  ])(
    "rolls back all DDL and row copies after an injected %s failure",
    (failurePoint) => {
      const root = makeRoot();
      const dbFile = path.join(root, `rollback-${failurePoint}.db`);
      createLegacyDatabase(dbFile);

      expect(() =>
        migrateDatabase({
          dbFile,
          legacyGuildId: LEGACY_GUILD,
          environment: migrationEnvironment(),
          failurePoint,
        }),
      ).toThrow("Injected migration failure");

      const db = new Database(dbFile, { readonly: true });
      try {
        expect(detectDatabaseSchema(db)).toBe("legacy-v1");
        for (const [table, count] of Object.entries({
          kv: 3,
          posts: 1,
          answers: 1,
          metrics: 2,
          anon_cooldowns: 1,
        })) {
          expect(
            db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get(),
          ).toEqual({ count });
        }
        expect(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE '%_v1_legacy'",
            )
            .get(),
        ).toEqual({ count: 0 });
        expect(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM sqlite_master WHERE name IN ('guilds', 'guild_settings', 'schema_migrations')",
            )
            .get(),
        ).toEqual({ count: 0 });
      } finally {
        db.close();
      }
    },
  );

  it("requires a legacy guild ID for rows and leaves v1 untouched", () => {
    const root = makeRoot();
    const dbFile = path.join(root, "missing-id.db");
    createLegacyDatabase(dbFile);
    expect(() =>
      migrateDatabase({ dbFile, legacyGuildId: null, environment: {} }),
    ).toThrow("LEGACY_GUILD_ID is required");
    expect(validateDatabaseFile(dbFile).schema).toBe("legacy-v1");
    const db = new Database(dbFile, { readonly: true });
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM kv").get()).toEqual({
        count: 3,
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM posts").get()).toEqual({
        count: 1,
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM answers").get()).toEqual({
        count: 1,
      });
    } finally {
      db.close();
    }
  });

  it.each(["{broken", ""])(
    "refuses malformed legacy state %j without changing the original row",
    (invalidState) => {
      const root = makeRoot();
      const dbFile = path.join(root, "malformed-state.db");
      createLegacyDatabase(dbFile);
      const db = new Database(dbFile);
      try {
        db.prepare("UPDATE kv SET value = ? WHERE key = 'state'").run(
          invalidState,
        );
      } finally {
        db.close();
      }

      expect(() =>
        migrateDatabase({
          dbFile,
          legacyGuildId: LEGACY_GUILD,
          environment: migrationEnvironment(),
        }),
      ).toThrow("legacy kv.state contains invalid JSON");

      const verify = new Database(dbFile, { readonly: true });
      try {
        expect(detectDatabaseSchema(verify)).toBe("legacy-v1");
        const row = verify
          .prepare("SELECT value FROM kv WHERE key = 'state'")
          .get() as { value: string };
        expect(row.value).toBe(invalidState);
      } finally {
        verify.close();
      }
    },
  );

  it("promotes an empty legacy schema without requiring a guild ID", () => {
    const root = makeRoot();
    const dbFile = path.join(root, "empty-v1.db");
    createLegacyDatabase(dbFile, false);
    const result = migrateDatabase({
      dbFile,
      legacyGuildId: null,
      environment: {},
    });
    expect(result.status).toBe("migrated");
    expect(validateDatabaseFile(dbFile, { requireCurrent: true }).schema).toBe(
      "current-v2",
    );
  });

  it("normal startup refuses a legacy database without migrating it", () => {
    const root = makeRoot();
    const dbFile = path.join(root, "startup-refusal.db");
    createLegacyDatabase(dbFile);
    const before = fs.readFileSync(dbFile);
    const storage = new CourtStorage({ dbFile }, root);
    expect(() => storage.initStorage()).toThrow("npm run migrate");
    storage.close();
    expect(fs.readFileSync(dbFile)).toEqual(before);
    expect(validateDatabaseFile(dbFile).schema).toBe("legacy-v1");
  });

  it("refuses a legacy lookalike with incompatible column metadata without changing it", () => {
    const root = makeRoot();
    const dbFile = path.join(root, "legacy-wrong-columns.db");
    createLegacyDatabase(dbFile);
    const damage = new Database(dbFile);
    let expectedRows: unknown[];
    try {
      expectedRows = damage
        .prepare(
          "SELECT metric_key, metric_value, updated_at FROM metrics ORDER BY metric_key",
        )
        .all();
      damage.exec(`
        ALTER TABLE metrics RENAME TO metrics_original;
        CREATE TABLE metrics (
          metric_key BLOB PRIMARY KEY,
          metric_value TEXT,
          updated_at TEXT NOT NULL DEFAULT 'unexpected'
        );
        INSERT INTO metrics (metric_key, metric_value, updated_at)
          SELECT metric_key, metric_value, updated_at FROM metrics_original;
        DROP TABLE metrics_original;
      `);
    } finally {
      damage.close();
    }
    const before = fs.readFileSync(dbFile);

    expect(() =>
      migrateDatabase({
        dbFile,
        legacyGuildId: LEGACY_GUILD,
        environment: migrationEnvironment(),
      }),
    ).toThrow("unknown or incomplete");
    expect(fs.readFileSync(dbFile)).toEqual(before);

    const verify = new Database(dbFile, { readonly: true });
    try {
      expect(detectDatabaseSchema(verify)).toBe("unknown");
      expect(
        verify
          .prepare(
            "SELECT metric_key, metric_value, updated_at FROM metrics ORDER BY metric_key",
          )
          .all(),
      ).toEqual(expectedRows);
      const columns = verify.pragma("table_xinfo(metrics)") as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }>;
      expect(columns.find((column) => column.name === "metric_key")?.type).toBe(
        "BLOB",
      );
      expect(
        columns.find((column) => column.name === "metric_value")?.notnull,
      ).toBe(0);
      expect(
        columns.find((column) => column.name === "updated_at")?.dflt_value,
      ).toBe("'unexpected'");
    } finally {
      verify.close();
    }
  });

  it("refuses a legacy lookalike with a partial baseline index without changing it", () => {
    const root = makeRoot();
    const dbFile = path.join(root, "legacy-wrong-index.db");
    createLegacyDatabase(dbFile);
    const damage = new Database(dbFile);
    try {
      damage.exec(`
        DROP INDEX idx_answers_message_id;
        CREATE INDEX idx_answers_message_id
          ON answers (answer_message_id)
          WHERE user_id <> '';
      `);
    } finally {
      damage.close();
    }
    const before = fs.readFileSync(dbFile);

    expect(() =>
      migrateDatabase({
        dbFile,
        legacyGuildId: LEGACY_GUILD,
        environment: migrationEnvironment(),
      }),
    ).toThrow("unknown or incomplete");
    expect(fs.readFileSync(dbFile)).toEqual(before);

    const verify = new Database(dbFile, { readonly: true });
    try {
      expect(detectDatabaseSchema(verify)).toBe("unknown");
      expect(
        verify
          .prepare(
            `SELECT question_message_id, user_id, answer_message_id, created_at
             FROM answers`,
          )
          .all(),
      ).toEqual([
        {
          question_message_id: "900000000000000001",
          user_id: "700000000000000001",
          answer_message_id: "600000000000000001",
          created_at: "2026-01-01T01:00:00.000Z",
        },
      ]);
      const index = verify
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
        )
        .get("idx_answers_message_id") as { sql: string };
      expect(index.sql).toContain("WHERE user_id <> ''");
    } finally {
      verify.close();
    }
  });

  it("refuses an unknown partial schema without changing it", () => {
    const root = makeRoot();
    const dbFile = path.join(root, "partial.db");
    const db = new Database(dbFile);
    db.exec("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO kv (key, value) VALUES ('state', '{}')").run();
    db.close();

    expect(() =>
      migrateDatabase({
        dbFile,
        legacyGuildId: LEGACY_GUILD,
        environment: migrationEnvironment(),
      }),
    ).toThrow("unknown or incomplete");

    const verify = new Database(dbFile, { readonly: true });
    try {
      expect(detectDatabaseSchema(verify)).toBe("unknown");
      expect(verify.prepare("SELECT key, value FROM kv").all()).toEqual([
        { key: "state", value: "{}" },
      ]);
    } finally {
      verify.close();
    }
  });
});
