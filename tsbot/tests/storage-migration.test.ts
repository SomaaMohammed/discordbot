import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDefaultGuildSettings,
  serializeGuildSettings,
} from "../src/guild-settings.js";
import { BotStorage } from "../src/storage/db.js";
import {
  migrateDatabase,
  type MigrationFailurePoint,
  validateDatabaseFile,
} from "../src/storage/migration.js";
import {
  detectDatabaseSchema,
  initializeV3Schema,
  V4_EXPLICIT_INDEX_NAMES,
  V4_TABLE_NAMES,
} from "../src/storage/schema.js";
import {
  createV2FixtureDatabase,
  createV2Settings,
  insertV2Guild,
} from "./helpers/v2-fixture.js";

const GUILD_A = "111111111111111111";
const GUILD_B = "222222222222222222";
const USER_A = "444444444444444444";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("explicit schema migration to v4", () => {
  it("preserves active tenant data and discards retired state", () => {
    const dbFile = fixturePath("active.db");
    const db = createV2FixtureDatabase(dbFile);
    const historicalNamespace = ["in", "victus"].join("");
    const settings = createV2Settings();
    (settings.invocation as { keyword: string; aliases: string[] }) = {
      keyword: historicalNamespace,
      aliases: [historicalNamespace, "helper bot"],
    };
    (settings.greetings as unknown[]) = [
      {
        name: "hello",
        userId: USER_A,
        message: `Welcome <@${USER_A}>!`,
      },
      {
        name: "royal welcome",
        userId: USER_A,
        message: "Welcome to the throne",
      },
    ];
    insertV2Guild(db, {
      guildId: GUILD_A,
      name: "Preserved A",
      settings,
    });
    insertV2Guild(db, { guildId: GUILD_B, name: "Preserved B" });
    db.prepare(
      "UPDATE guild_settings SET settings_json = ? WHERE guild_id = ?",
    ).run("{malformed", GUILD_B);

    const insertMetric = db.prepare(
      "INSERT INTO metrics (guild_id, metric_key, metric_value, updated_at) VALUES (?, ?, ?, ?)",
    );
    insertMetric.run(
      GUILD_A,
      `command_usage.${historicalNamespace}.purge`,
      "2",
      "2026-01-03T00:00:00.000Z",
    );
    insertMetric.run(
      GUILD_A,
      "command_usage.utility.ping",
      "3",
      "2026-01-03T00:00:00.000Z",
    );
    insertMetric.run(
      GUILD_A,
      `user_stats.${USER_A}.messages_sent`,
      "4",
      "2026-01-03T00:00:00.000Z",
    );
    insertMetric.run(GUILD_A, "posts_total", "99", "2026-01-03T00:00:00.000Z");
    insertMetric.run(
      GUILD_A,
      "command_usage.utility.avatar",
      "5",
      "not-a-timestamp",
    );
    insertMetric.run(
      GUILD_A,
      "runtime.silence_leases.v1",
      JSON.stringify({ version: 1, leases: [] }),
      "2026-01-03T00:00:00.000Z",
    );
    db.prepare(
      "INSERT INTO kv (guild_id, key, value, updated_at) VALUES (?, 'state', '{}', ?)",
    ).run(GUILD_A, "2026-01-03T00:00:00.000Z");
    db.close();

    const result = migrateDatabase({
      dbFile,
      now: () => "2026-02-01T00:00:00.000Z",
    });
    expect(result).toMatchObject({
      status: "migrated",
      fromSchema: "legacy-v2",
      toSchema: "current-v4",
      guilds: 2,
      settingsRequiringReview: 1,
      metricsPreserved: 3,
      metricsDropped: 3,
    });
    expect(validateDatabaseFile(dbFile, { expect: 4 })).toMatchObject({
      schema: "current-v4",
      schemaVersion: 4,
      integrity: "ok",
      foreignKeyViolations: 0,
    });

    const migrated = new Database(dbFile, { readonly: true });
    try {
      expect(schemaObjects(migrated, "table")).toEqual(
        [...V4_TABLE_NAMES].sort(),
      );
      expect(schemaObjects(migrated, "index")).toEqual(
        [...V4_EXPLICIT_INDEX_NAMES].sort(),
      );
      expect(
        migrated
          .prepare("SELECT name FROM guilds WHERE guild_id = ?")
          .get(GUILD_A),
      ).toEqual({ name: "Preserved A" });

      const active = readSettings(migrated, GUILD_A);
      expect(active).toMatchObject({
        version: 2,
        enabled: true,
        reviewRequired: false,
        timezone: "Asia/Amman",
        features: {
          chat: true,
          replyModeration: true,
          greetings: true,
          activityMetrics: true,
        },
        channels: { log: "333333333333333333" },
        invocation: { keyword: "superior", aliases: ["helper bot"] },
        limits: { bulkModerationTargetCap: 50 },
        greetings: [{ name: "hello", message: "Welcome {user}!" }],
      });
      expect(JSON.stringify(active)).not.toContain("userId");

      expect(readSettings(migrated, GUILD_B)).toMatchObject({
        enabled: false,
        reviewRequired: true,
        timezone: "UTC",
      });
      expect(
        migrated
          .prepare("SELECT enabled FROM guilds WHERE guild_id = ?")
          .get(GUILD_B),
      ).toEqual({ enabled: 0 });
      expect(
        migrated
          .prepare(
            "SELECT metric_key, metric_value FROM metrics ORDER BY metric_key",
          )
          .all(),
      ).toEqual([
        { metric_key: "command_usage.superior.purge", metric_value: 2 },
        { metric_key: "command_usage.utility.ping", metric_value: 3 },
        {
          metric_key: `user_stats.${USER_A}.messages_sent`,
          metric_value: 4,
        },
      ]);
    } finally {
      migrated.close();
    }
  });

  it("forces review when a former unlimited moderation cap is encountered", () => {
    const dbFile = fixturePath("cap.db");
    const db = createV2FixtureDatabase(dbFile);
    const settings = createV2Settings();
    (
      settings.limits as {
        muteallTargetCap: number;
      }
    ).muteallTargetCap = 0;
    insertV2Guild(db, { guildId: GUILD_A, settings });
    db.close();

    migrateDatabase({ dbFile });
    const migrated = new Database(dbFile, { readonly: true });
    try {
      expect(readSettings(migrated, GUILD_A)).toMatchObject({
        enabled: false,
        reviewRequired: true,
        limits: { bulkModerationTargetCap: 100 },
      });
    } finally {
      migrated.close();
    }
  });

  it.each([
    ["malformed", "{not-json"],
    [
      "unresolved",
      JSON.stringify({
        version: 1,
        leases: [
          {
            channelId: "555555555555555555",
            roleId: "666666666666666666",
            originalSendMessages: null,
            expiresAt: 1,
          },
        ],
      }),
    ],
  ])(
    "refuses %s permission-recovery metadata without changes",
    (_name, value) => {
      const dbFile = fixturePath("leases.db");
      const db = createV2FixtureDatabase(dbFile);
      insertV2Guild(db, { guildId: GUILD_A });
      db.prepare(
        "INSERT INTO metrics (guild_id, metric_key, metric_value, updated_at) VALUES (?, ?, ?, ?)",
      ).run(
        GUILD_A,
        "runtime.silence_leases.v1",
        value,
        "2026-01-03T00:00:00.000Z",
      );
      db.close();
      const before = fs.readFileSync(dbFile);

      expect(() => migrateDatabase({ dbFile })).toThrow(/Migration blocked/);
      expect(fs.readFileSync(dbFile)).toEqual(before);
      expect(validateDatabaseFile(dbFile, { expect: 2 }).schema).toBe(
        "legacy-v2",
      );
    },
  );

  it("acquires BEGIN IMMEDIATE before classification and source reads", () => {
    const dbFile = fixturePath("lock.db");
    const fixture = createV2FixtureDatabase(dbFile);
    insertV2Guild(fixture, { guildId: GUILD_A });
    fixture.close();
    const competingWriter = new Database(dbFile);
    competingWriter.pragma("busy_timeout = 0");
    let blocked = false;
    try {
      migrateDatabase({
        dbFile,
        onLockAcquired: () => {
          try {
            competingWriter
              .prepare("UPDATE guilds SET name = 'raced' WHERE guild_id = ?")
              .run(GUILD_A);
          } catch (error) {
            blocked = (error as { code?: string }).code === "SQLITE_BUSY";
          }
        },
      });
    } finally {
      competingWriter.close();
    }
    expect(blocked).toBe(true);
    const verify = new Database(dbFile, { readonly: true });
    try {
      expect(
        verify
          .prepare("SELECT name FROM guilds WHERE guild_id = ?")
          .get(GUILD_A),
      ).toEqual({ name: "Synthetic Guild" });
    } finally {
      verify.close();
    }
  });

  it.each<MigrationFailurePoint>([
    "after-source-read",
    "after-rename",
    "after-create",
    "after-copy",
    "after-verify",
    "after-drop",
    "after-version",
    "before-commit",
  ])("rolls back completely after an injected %s failure", (failurePoint) => {
    const dbFile = fixturePath(`${failurePoint}.db`);
    const db = createV2FixtureDatabase(dbFile);
    insertV2Guild(db, { guildId: GUILD_A });
    db.close();
    const before = fs.readFileSync(dbFile);

    expect(() => migrateDatabase({ dbFile, failurePoint })).toThrow(
      `Injected migration failure at ${failurePoint}`,
    );
    expect(fs.readFileSync(dbFile)).toEqual(before);
    expect(validateDatabaseFile(dbFile, { expect: 2 }).schema).toBe(
      "legacy-v2",
    );
  });

  it("performs a complete dry run and rolls it back", () => {
    const dbFile = fixturePath("dry-run.db");
    const db = createV2FixtureDatabase(dbFile);
    insertV2Guild(db, { guildId: GUILD_A });
    db.close();
    const before = fs.readFileSync(dbFile);

    expect(migrateDatabase({ dbFile, dryRun: true }).status).toBe("dry-run");
    expect(fs.readFileSync(dbFile)).toEqual(before);
    expect(validateDatabaseFile(dbFile, { expect: 2 }).schema).toBe(
      "legacy-v2",
    );
  });

  it("transactionally upgrades current v3 while preserving every active row", () => {
    const dbFile = fixturePath("v3.db");
    createV3Fixture(dbFile);

    expect(
      migrateDatabase({
        dbFile,
        now: () => "2026-02-01T00:00:00.000Z",
      }),
    ).toMatchObject({
      status: "migrated",
      fromSchema: "legacy-v3",
      toSchema: "current-v4",
      guilds: 1,
      metricsPreserved: 1,
      metricsDropped: 0,
    });
    expect(validateDatabaseFile(dbFile, { expect: 4 })).toMatchObject({
      schema: "current-v4",
      schemaVersion: 4,
    });

    const db = new Database(dbFile, { readonly: true });
    try {
      expect(db.prepare("SELECT * FROM guilds").all()).toEqual([
        {
          guild_id: GUILD_A,
          enabled: 0,
          name: "Preserved v3",
          joined_at: "2026-01-01T00:00:00.000Z",
          left_at: null,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ]);
      expect(
        db
          .prepare("SELECT metric_key, metric_value, updated_at FROM metrics")
          .all(),
      ).toEqual([
        {
          metric_key: "command_usage.utility.ping",
          metric_value: 7,
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ]);
      expect(
        db
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all(),
      ).toEqual([{ version: 3 }, { version: 4 }]);
      for (const table of [
        "ticket_configurations",
        "posted_panels",
        "tickets",
        "ticket_events",
      ]) {
        expect(
          db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
        ).toEqual({ count: 0 });
      }
    } finally {
      db.close();
    }
  });

  it.each<MigrationFailurePoint>([
    "after-source-read",
    "after-rename",
    "after-create",
    "after-copy",
    "after-verify",
    "after-drop",
    "after-version",
    "before-commit",
  ])(
    "rolls v3 back completely after an injected %s failure",
    (failurePoint) => {
      const dbFile = fixturePath(`v3-${failurePoint}.db`);
      createV3Fixture(dbFile);
      const before = fs.readFileSync(dbFile);

      expect(() => migrateDatabase({ dbFile, failurePoint })).toThrow(
        `Injected migration failure at ${failurePoint}`,
      );
      expect(fs.readFileSync(dbFile)).toEqual(before);
      expect(validateDatabaseFile(dbFile, { expect: 3 }).schema).toBe(
        "legacy-v3",
      );
    },
  );

  it("is idempotent for an already-current database", () => {
    const dbFile = fixturePath("current.db");
    const storage = new BotStorage({ dbFile });
    storage.initStorage();
    storage.ensureGuild(GUILD_A);
    storage.close();
    expect(migrateDatabase({ dbFile })).toMatchObject({
      status: "already-current",
      fromSchema: "current-v4",
      toSchema: "current-v4",
      guilds: 1,
    });
    expect(validateDatabaseFile(dbFile, { expect: 4 }).schema).toBe(
      "current-v4",
    );
  });

  it("refuses v1 with the documented two-hop boundary", () => {
    const dbFile = fixturePath("v1.db");
    createV1Fixture(dbFile);
    expect(() => migrateDatabase({ dbFile })).toThrow(/final v4 release/);
    const db = new Database(dbFile, { readonly: true });
    try {
      expect(detectDatabaseSchema(db)).toBe("legacy-v1");
    } finally {
      db.close();
    }
  });

  it("refuses partial or unknown layouts", () => {
    const dbFile = fixturePath("partial.db");
    const db = new Database(dbFile);
    db.exec("CREATE TABLE guilds (guild_id TEXT PRIMARY KEY)");
    db.close();
    expect(() => migrateDatabase({ dbFile })).toThrow(/Refusing to migrate/);
    const verify = new Database(dbFile, { readonly: true });
    try {
      expect(detectDatabaseSchema(verify)).toBe("unknown");
    } finally {
      verify.close();
    }
  });
});

function readSettings(
  db: Database.Database,
  guildId: string,
): Record<string, unknown> {
  const row = db
    .prepare("SELECT settings_json FROM guild_settings WHERE guild_id = ?")
    .get(guildId) as { settings_json: string };
  return JSON.parse(row.settings_json) as Record<string, unknown>;
}

function schemaObjects(
  db: Database.Database,
  type: "table" | "index",
): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all(type) as Array<{ name: string }>
  ).map((row) => row.name);
}

function createV1Fixture(dbFile: string): void {
  const db = new Database(dbFile);
  db.exec(`
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE posts (
      message_id TEXT PRIMARY KEY, thread_id TEXT, channel_id TEXT NOT NULL,
      category TEXT NOT NULL, question TEXT NOT NULL, posted_at TEXT NOT NULL,
      close_after_hours INTEGER NOT NULL DEFAULT 24,
      closed INTEGER NOT NULL DEFAULT 0, closed_at TEXT, close_reason TEXT
    );
    CREATE TABLE answers (
      question_message_id TEXT NOT NULL, user_id TEXT NOT NULL,
      answer_message_id TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (question_message_id, user_id)
    );
    CREATE TABLE metrics (
      metric_key TEXT PRIMARY KEY, metric_value TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE anon_cooldowns (
      user_id TEXT PRIMARY KEY, last_answer_at TEXT NOT NULL
    );
    CREATE INDEX idx_posts_closed_posted_at ON posts (closed, posted_at);
    CREATE INDEX idx_answers_question_created
      ON answers (question_message_id, created_at);
    CREATE INDEX idx_answers_message_id ON answers (answer_message_id);
  `);
  db.close();
}

function createV3Fixture(dbFile: string): void {
  const db = new Database(dbFile);
  db.pragma("foreign_keys = ON");
  initializeV3Schema(db, "2026-01-01T00:00:00.000Z");
  const settings = createDefaultGuildSettings();
  db.prepare(
    `INSERT INTO guilds (
       guild_id, enabled, name, joined_at, left_at, created_at, updated_at
     ) VALUES (?, 0, ?, ?, NULL, ?, ?)`,
  ).run(
    GUILD_A,
    "Preserved v3",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
  );
  db.prepare(
    `INSERT INTO guild_settings (
       guild_id, settings_version, settings_json, updated_at
     ) VALUES (?, 2, ?, ?)`,
  ).run(GUILD_A, serializeGuildSettings(settings), "2026-01-01T00:00:00.000Z");
  db.prepare(
    `INSERT INTO metrics (
       guild_id, metric_key, metric_value, updated_at
     ) VALUES (?, ?, ?, ?)`,
  ).run(GUILD_A, "command_usage.utility.ping", 7, "2026-01-01T00:00:00.000Z");
  db.close();
}

function fixturePath(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "superior-migration-"));
  roots.push(root);
  return path.join(root, name);
}
