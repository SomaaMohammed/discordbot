import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "../src/storage/database.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDefaultGuildSettings,
  serializeGuildSettings,
} from "../src/guild-settings.js";
import {
  createDefaultLegacyGuildSettingsV2,
  serializeLegacyGuildSettingsV2,
} from "../src/storage/guild-settings-v2.js";
import { BotStorage } from "../src/storage/db.js";
import {
  migrateDatabase,
  type MigrationFailurePoint,
  validateDatabaseFile,
} from "../src/storage/migration.js";
import {
  detectDatabaseSchema,
  initializeV3Schema,
  initializeV4Schema,
  initializeV5Schema,
  initializeV6Schema,
  initializeV7Schema,
  initializeV8Schema,
  initializeV9Schema,
  initializeV10Schema,
  V8_TABLE_NAMES,
  V9_TABLE_NAMES,
  V11_EXPLICIT_INDEX_NAMES,
  V11_TABLE_NAMES,
} from "../src/storage/schema.js";
import {
  createV2FixtureDatabase,
  createV2Settings,
  insertV2Guild,
} from "./helpers/v2-fixture.js";

const GUILD_A = "111111111111111111";
const GUILD_B = "222222222222222222";
const USER_A = "444444444444444444";
const NOW = "2026-01-01T00:00:00.000Z";
const PHASE4_TABLES = [
  "onboarding_rules_versions",
  "onboarding_configurations",
  "onboarding_message_templates",
  "onboarding_autoroles",
  "member_onboarding_states",
  "member_rule_acceptances",
  "onboarding_delivery_records",
  "onboarding_role_operations",
  "onboarding_audit_events",
  "role_menus",
  "role_menu_options",
  "role_menu_posts",
  "role_menu_operations",
  "role_menu_operation_items",
] as const;
const MIGRATION_FAILURE_TIMEOUT_MS =
  process.platform === "linux" ? 60_000 : 15_000;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("explicit schema migration to v11", () => {
  it("transactionally migrates exact v8 rows and enables only new constraints", () => {
    const dbFile = fixturePath("v8.db");
    createV8Fixture(dbFile);
    const source = new Database(dbFile, { readonly: true });
    const snapshot = new Map(
      V8_TABLE_NAMES.filter((table) => table !== "schema_migrations").map(
        (table) => [
          table,
          source.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        ],
      ),
    );
    source.close();

    expect(
      migrateDatabase({
        dbFile,
        now: () => "2026-02-01T00:00:00.000Z",
      }),
    ).toMatchObject({
      status: "migrated",
      fromSchema: "legacy-v8",
      toSchema: "current-v11",
      guilds: 1,
    });
    expect(validateDatabaseFile(dbFile, { expect: 11 })).toMatchObject({
      schema: "current-v11",
      schemaVersion: 11,
      foreignKeyViolations: 0,
    });

    const migrated = new Database(dbFile);
    migrated.pragma("foreign_keys = ON");
    try {
      for (const [table, rows] of snapshot) {
        expect(
          migrated.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        ).toEqual(rows);
      }
      expect(
        migrated
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all(),
      ).toEqual([
        { version: 8 },
        { version: 9 },
        { version: 10 },
        { version: 11 },
      ]);
      for (const table of [
        "moderation_configurations",
        "moderation_cases",
        "member_reports",
        "case_appeals",
        "anti_spam_rules",
        "anti_spam_enforcements",
        ...PHASE4_TABLES,
      ]) {
        expect(
          migrated.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
        ).toEqual({
          count: 0,
        });
      }
      expect(() =>
        migrated
          .prepare(
            `INSERT INTO delegated_capability_grants (
               guild_id, principal_type, principal_id, capability, active,
               granted_by, created_at, updated_at
             ) VALUES (?, 'role', ?, 'moderation.manage', 1, ?, ?, ?)`,
          )
          .run(GUILD_A, "900000000000000001", USER_A, NOW, NOW),
      ).not.toThrow();
      expect(() =>
        migrated
          .prepare(
            `INSERT INTO posted_panels (
               guild_id, panel_id, preset, channel_id, message_id,
               configuration_json, created_at, updated_at
             ) VALUES (?, 'safetypanel', 'safety', ?, ?, '{}', ?, ?)`,
          )
          .run(GUILD_A, "900000000000000002", "900000000000000003", NOW, NOW),
      ).not.toThrow();
    } finally {
      migrated.close();
    }
  });

  it("copies every exact v9 row before adding dormant Phase 4 storage", () => {
    const dbFile = fixturePath("v9.db");
    createV9Fixture(dbFile);
    const source = new Database(dbFile, { readonly: true });
    const snapshot = new Map(
      V9_TABLE_NAMES.filter((table) => table !== "schema_migrations").map(
        (table) => [
          table,
          source.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        ],
      ),
    );
    source.close();

    expect(
      migrateDatabase({
        dbFile,
        now: () => "2026-02-01T00:00:00.000Z",
      }),
    ).toMatchObject({
      status: "migrated",
      fromSchema: "legacy-v9",
      toSchema: "current-v11",
      guilds: 1,
      metricsPreserved: 1,
      metricsDropped: 0,
    });
    expect(validateDatabaseFile(dbFile, { expect: 11 })).toMatchObject({
      schema: "current-v11",
      schemaVersion: 11,
      foreignKeyViolations: 0,
    });

    const migrated = new Database(dbFile);
    migrated.pragma("foreign_keys = ON");
    try {
      for (const [table, rows] of snapshot) {
        expect(
          migrated.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
          `${table} exact v9 rows`,
        ).toEqual(rows);
      }
      for (const table of PHASE4_TABLES) {
        expect(
          migrated.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
          `${table} starts empty`,
        ).toEqual({ count: 0 });
      }
      expect(
        migrated
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all(),
      ).toEqual([{ version: 9 }, { version: 10 }, { version: 11 }]);

      const insertGrant = migrated.prepare(
        `INSERT INTO delegated_capability_grants (
           guild_id, principal_type, principal_id, capability, active,
           granted_by, created_at, updated_at
         ) VALUES (?, 'role', ?, ?, 1, ?, ?, ?)`,
      );
      expect(() =>
        insertGrant.run(
          GUILD_A,
          "900000000000000011",
          "onboarding.configure",
          USER_A,
          NOW,
          NOW,
        ),
      ).not.toThrow();
      expect(() =>
        insertGrant.run(
          GUILD_A,
          "900000000000000012",
          "roles.configure",
          USER_A,
          NOW,
          NOW,
        ),
      ).not.toThrow();

      const insertPanel = migrated.prepare(
        `INSERT INTO posted_panels (
           guild_id, panel_id, preset, channel_id, message_id,
           configuration_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, '{}', ?, ?)`,
      );
      expect(() =>
        insertPanel.run(
          GUILD_A,
          "verify_p1",
          "verification",
          "900000000000000013",
          "900000000000000014",
          NOW,
          NOW,
        ),
      ).not.toThrow();
      expect(() =>
        insertPanel.run(
          GUILD_A,
          "roles_p01",
          "roles",
          "900000000000000015",
          "900000000000000016",
          NOW,
          NOW,
        ),
      ).not.toThrow();
    } finally {
      migrated.close();
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
    "rolls exact v9 back after an injected %s failure",
    (failurePoint) => {
      const dbFile = fixturePath(`v9-${failurePoint}.db`);
      createV9Fixture(dbFile);
      const before = fs.readFileSync(dbFile);

      expect(() => migrateDatabase({ dbFile, failurePoint })).toThrow(
        `Injected migration failure at ${failurePoint}`,
      );
      expect(fs.readFileSync(dbFile)).toEqual(before);
      expect(validateDatabaseFile(dbFile, { expect: 9 })).toMatchObject({
        schema: "legacy-v9",
        schemaVersion: 9,
        foreignKeyViolations: 0,
      });
    },
    MIGRATION_FAILURE_TIMEOUT_MS,
  );

  it("dry-runs the complete exact v9-to-v11 transaction", () => {
    const dbFile = fixturePath("v9-dry-run.db");
    createV9Fixture(dbFile);
    const before = fs.readFileSync(dbFile);

    expect(migrateDatabase({ dbFile, dryRun: true })).toMatchObject({
      status: "dry-run",
      fromSchema: "legacy-v9",
      toSchema: "current-v11",
    });
    expect(fs.readFileSync(dbFile)).toEqual(before);
    expect(validateDatabaseFile(dbFile, { expect: 9 }).schema).toBe(
      "legacy-v9",
    );
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
    "rolls exact v8 back after an injected %s failure",
    (failurePoint) => {
      const dbFile = fixturePath(`v8-${failurePoint}.db`);
      createV8Fixture(dbFile);
      const before = fs.readFileSync(dbFile);
      expect(() => migrateDatabase({ dbFile, failurePoint })).toThrow(
        `Injected migration failure at ${failurePoint}`,
      );
      expect(fs.readFileSync(dbFile)).toEqual(before);
      expect(validateDatabaseFile(dbFile, { expect: 8 }).schema).toBe(
        "legacy-v8",
      );
    },
    MIGRATION_FAILURE_TIMEOUT_MS,
  );

  it("dry-runs exact v8 through the full v11 transaction", () => {
    const dbFile = fixturePath("v8-dry-run.db");
    createV8Fixture(dbFile);
    const before = fs.readFileSync(dbFile);
    expect(migrateDatabase({ dbFile, dryRun: true })).toMatchObject({
      status: "dry-run",
      fromSchema: "legacy-v8",
      toSchema: "current-v11",
    });
    expect(fs.readFileSync(dbFile)).toEqual(before);
    expect(validateDatabaseFile(dbFile, { expect: 8 }).schema).toBe(
      "legacy-v8",
    );
  });

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
      toSchema: "current-v11",
      guilds: 2,
      settingsRequiringReview: 0,
      metricsPreserved: 3,
      metricsDropped: 3,
    });
    expect(validateDatabaseFile(dbFile, { expect: 11 })).toMatchObject({
      schema: "current-v11",
      schemaVersion: 11,
      integrity: "ok",
      foreignKeyViolations: 0,
    });

    const migrated = new Database(dbFile, { readonly: true });
    try {
      expect(schemaObjects(migrated, "table")).toEqual(
        [...V11_TABLE_NAMES].sort(),
      );
      expect(schemaObjects(migrated, "index")).toEqual(
        [...V11_EXPLICIT_INDEX_NAMES].sort(),
      );
      expect(
        migrated
          .prepare("SELECT name FROM guilds WHERE guild_id = ?")
          .get(GUILD_A),
      ).toEqual({ name: "Preserved A" });

      const active = readSettings(migrated, GUILD_A);
      expect(active).toMatchObject({
        version: 3,
        enabled: true,
        timezone: "Asia/Amman",
        channels: { log: "333333333333333333" },
        invocation: { keyword: "superior", aliases: ["helper bot"] },
        limits: { bulkModerationTargetCap: 50 },
        greetings: [{ name: "hello", message: "Welcome {user}!" }],
      });
      expect(JSON.stringify(active)).not.toContain("userId");

      expect(readSettings(migrated, GUILD_B)).toMatchObject({
        enabled: true,
        timezone: "UTC",
        greetings: [{ name: "Welcome", message: "Welcome, {user}!" }],
      });
      expect(
        migrated
          .prepare("SELECT enabled FROM guilds WHERE guild_id = ?")
          .get(GUILD_B),
      ).toEqual({ enabled: 1 });
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

  it("replaces an unsafe former unlimited moderation cap without a global gate", () => {
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
        enabled: true,
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
      toSchema: "current-v11",
      guilds: 1,
      metricsPreserved: 1,
      metricsDropped: 0,
    });
    expect(validateDatabaseFile(dbFile, { expect: 11 })).toMatchObject({
      schema: "current-v11",
      schemaVersion: 11,
    });

    const db = new Database(dbFile, { readonly: true });
    try {
      expect(db.prepare("SELECT * FROM guilds").all()).toEqual([
        {
          guild_id: GUILD_A,
          enabled: 1,
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
      ).toEqual([
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 },
        { version: 7 },
        { version: 8 },
        { version: 9 },
        { version: 10 },
        { version: 11 },
      ]);
      for (const table of [
        "ticket_departments",
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

  it("migrates schema v4 ticket lifecycle rows exactly into General Support", () => {
    const dbFile = fixturePath("v4-tickets.db");
    const ticketId = createV4TicketFixture(dbFile);
    const source = new Database(dbFile, { readonly: true });
    const preservedTickets = readPreservedV4Tickets(source);
    source.close();
    expect(preservedTickets).toHaveLength(3);
    expect(
      preservedTickets.find((ticket) => ticket.ticket_id === "ticket_v4"),
    ).toMatchObject({
      state: "open",
      channel_id: "900000000000000001",
      control_message_id: "900000000000000002",
      claimed_by: "900000000000000003",
      claimed_at: "2026-01-01T00:01:00.000Z",
    });
    expect(
      preservedTickets.find(
        (ticket) => ticket.ticket_id === "ticket_closing_v4",
      ),
    ).toMatchObject({
      state: "closing",
      closing_at: "2026-01-01T00:04:00.000Z",
      close_log_message_id: "900000000000000015",
      close_logged_at: "2026-01-01T00:05:00.000Z",
      closed_at: null,
    });
    expect(
      preservedTickets.find(
        (ticket) => ticket.ticket_id === "ticket_closed_v4",
      ),
    ).toMatchObject({
      state: "closed",
      closing_at: "2026-01-01T00:08:00.000Z",
      close_log_message_id: "900000000000000026",
      close_logged_at: "2026-01-01T00:09:00.000Z",
      closed_at: "2026-01-01T00:10:00.000Z",
    });

    expect(
      migrateDatabase({
        dbFile,
        now: () => "2026-02-01T00:00:00.000Z",
      }),
    ).toMatchObject({
      status: "migrated",
      fromSchema: "legacy-v4",
      toSchema: "current-v11",
      guilds: 1,
    });
    expect(validateDatabaseFile(dbFile, { expect: 11 }).schema).toBe(
      "current-v11",
    );

    const db = new Database(dbFile);
    try {
      const department = db
        .prepare("SELECT * FROM ticket_departments WHERE guild_id = ?")
        .get(GUILD_A) as Record<string, unknown>;
      expect(department).toMatchObject({
        slug: "general-support",
        display_name: "General Support",
        enabled: 1,
        category_id: "333333333333333333",
        log_channel_id: "555555555555555555",
        support_role_id: "666666666666666666",
        bindings_verified_at: "2026-01-01T00:00:00.000Z",
      });
      expect(
        db
          .prepare(
            `SELECT label, field_type, max_length, sort_order
             FROM ticket_department_fields
             WHERE guild_id = ? ORDER BY sort_order`,
          )
          .all(GUILD_A),
      ).toEqual([
        {
          label: "Subject",
          field_type: "short",
          max_length: 100,
          sort_order: 0,
        },
        {
          label: "Details",
          field_type: "paragraph",
          max_length: 2_000,
          sort_order: 1,
        },
      ]);
      expect(
        db
          .prepare(
            "SELECT department_id, subject, description FROM tickets WHERE ticket_id = ?",
          )
          .get(ticketId),
      ).toEqual({
        department_id: department.department_id,
        subject: "Migration subject",
        description: "Migration details",
      });
      expect(
        db
          .prepare(
            `SELECT field_label, field_type, response_text, sort_order
             FROM ticket_form_responses WHERE ticket_id = ? ORDER BY sort_order`,
          )
          .all(ticketId),
      ).toEqual([
        {
          field_label: "Subject",
          field_type: "short",
          response_text: "Migration subject",
          sort_order: 0,
        },
        {
          field_label: "Details",
          field_type: "paragraph",
          response_text: "Migration details",
          sort_order: 1,
        },
      ]);
      expect(db.prepare("SELECT event_type FROM ticket_events").all()).toEqual([
        { event_type: "creation_reserved" },
      ]);
      expect(readPreservedV4Tickets(db)).toEqual(preservedTickets);
      expect(
        db
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all(),
      ).toEqual([
        { version: 4 },
        { version: 5 },
        { version: 6 },
        { version: 7 },
        { version: 8 },
        { version: 9 },
        { version: 10 },
        { version: 11 },
      ]);
      expect(() =>
        db
          .prepare(
            `INSERT INTO delegated_capability_grants (
               guild_id, principal_type, principal_id, capability, active,
               granted_by, created_at, updated_at
             ) VALUES (?, 'user', ?, 'panels.manage', 1, ?, ?, ?)`,
          )
          .run(
            GUILD_A,
            GUILD_B,
            USER_A,
            "2026-02-01T00:00:00.000Z",
            "2026-02-01T00:00:00.000Z",
          ),
      ).toThrow(/CHECK constraint failed/);
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
    "rolls v4 back completely after an injected %s failure",
    (failurePoint) => {
      const dbFile = fixturePath(`v4-${failurePoint}.db`);
      createV4TicketFixture(dbFile);
      const before = fs.readFileSync(dbFile);

      expect(() => migrateDatabase({ dbFile, failurePoint })).toThrow(
        `Injected migration failure at ${failurePoint}`,
      );
      expect(fs.readFileSync(dbFile)).toEqual(before);
      expect(validateDatabaseFile(dbFile, { expect: 4 }).schema).toBe(
        "legacy-v4",
      );
    },
  );

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

  it("additively migrates an exact schema-v6 database to v11", () => {
    const dbFile = fixturePath("v6.db");
    const db = new Database(dbFile);
    db.pragma("foreign_keys = ON");
    initializeV6Schema(db, "2026-01-01T00:00:00.000Z");
    db.prepare(
      `INSERT INTO guilds (
         guild_id, enabled, name, joined_at, left_at, created_at, updated_at
       ) VALUES (?, 0, 'Preserved v6', ?, NULL, ?, ?)`,
    ).run(
      GUILD_A,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO guild_settings (
         guild_id, settings_version, settings_json, updated_at
       ) VALUES (?, 2, ?, ?)`,
    ).run(
      GUILD_A,
      serializeLegacyGuildSettingsV2(createDefaultLegacyGuildSettingsV2()),
      "2026-01-01T00:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO metrics (guild_id, metric_key, metric_value, updated_at)
       VALUES (?, 'command_usage.utility.ping', 3, ?)`,
    ).run(GUILD_A, "2026-01-01T00:00:00.000Z");
    db.close();

    expect(
      migrateDatabase({
        dbFile,
        now: () => "2026-02-01T00:00:00.000Z",
      }),
    ).toMatchObject({
      status: "migrated",
      fromSchema: "legacy-v6",
      toSchema: "current-v11",
      guilds: 1,
      metricsPreserved: 1,
    });
    expect(validateDatabaseFile(dbFile, { expect: 11 })).toMatchObject({
      schema: "current-v11",
      schemaVersion: 11,
    });

    const migrated = new Database(dbFile, { readonly: true });
    try {
      expect(
        migrated
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all(),
      ).toEqual([
        { version: 6 },
        { version: 7 },
        { version: 8 },
        { version: 9 },
        { version: 10 },
        { version: 11 },
      ]);
      expect(
        migrated
          .prepare("SELECT name FROM guilds WHERE guild_id = ?")
          .get(GUILD_A),
      ).toEqual({ name: "Preserved v6" });
      expect(
        migrated
          .prepare("SELECT COUNT(*) AS count FROM mudae_watch_deliveries")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      migrated.close();
    }
  });

  it("migrates and dry-run rolls back an exact schema-v7 database", () => {
    const dbFile = fixturePath("v7.db");
    const db = new Database(dbFile);
    db.pragma("foreign_keys = ON");
    initializeV7Schema(db, NOW);
    db.close();
    const before = fs.readFileSync(dbFile);

    expect(migrateDatabase({ dbFile, dryRun: true })).toMatchObject({
      status: "dry-run",
      fromSchema: "legacy-v7",
      toSchema: "current-v11",
    });
    expect(fs.readFileSync(dbFile)).toEqual(before);
    expect(validateDatabaseFile(dbFile, { expect: 7 }).schema).toBe(
      "legacy-v7",
    );

    expect(migrateDatabase({ dbFile })).toMatchObject({
      status: "migrated",
      fromSchema: "legacy-v7",
      toSchema: "current-v11",
    });
    expect(validateDatabaseFile(dbFile, { expect: 11 }).schema).toBe(
      "current-v11",
    );
    const migrated = new Database(dbFile, { readonly: true });
    try {
      expect(
        migrated
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all(),
      ).toEqual([
        { version: 7 },
        { version: 8 },
        { version: 9 },
        { version: 10 },
        { version: 11 },
      ]);
    } finally {
      migrated.close();
    }
  });

  it.each<MigrationFailurePoint>([
    "after-create",
    "after-version",
    "before-commit",
  ])("rolls an interrupted v6-to-v7 %s back byte-for-byte", (failurePoint) => {
    const dbFile = fixturePath(`v6-${failurePoint}.db`);
    const db = new Database(dbFile);
    db.pragma("foreign_keys = ON");
    initializeV6Schema(db, "2026-01-01T00:00:00.000Z");
    db.close();
    const before = fs.readFileSync(dbFile);

    expect(() => migrateDatabase({ dbFile, failurePoint })).toThrow(
      `Injected migration failure at ${failurePoint}`,
    );
    expect(fs.readFileSync(dbFile)).toEqual(before);
    expect(validateDatabaseFile(dbFile, { expect: 6 }).schema).toBe(
      "legacy-v6",
    );
  });

  it("dry-runs schema v6 to v11 without modifying the source", () => {
    const dbFile = fixturePath("v6-dry-run.db");
    const db = new Database(dbFile);
    db.pragma("foreign_keys = ON");
    initializeV6Schema(db, "2026-01-01T00:00:00.000Z");
    db.close();
    const before = fs.readFileSync(dbFile);

    expect(migrateDatabase({ dbFile, dryRun: true })).toMatchObject({
      status: "dry-run",
      fromSchema: "legacy-v6",
      toSchema: "current-v11",
    });
    expect(fs.readFileSync(dbFile)).toEqual(before);
    expect(validateDatabaseFile(dbFile, { expect: 6 }).schema).toBe(
      "legacy-v6",
    );
  });

  it("additively migrates an exact schema-v5 database to v11", () => {
    const dbFile = fixturePath("v5.db");
    const db = new Database(dbFile);
    db.pragma("foreign_keys = ON");
    initializeV5Schema(db, "2026-01-01T00:00:00.000Z");
    db.close();

    expect(
      migrateDatabase({
        dbFile,
        now: () => "2026-02-01T00:00:00.000Z",
      }),
    ).toMatchObject({
      status: "migrated",
      fromSchema: "legacy-v5",
      toSchema: "current-v11",
      guilds: 0,
    });
    expect(validateDatabaseFile(dbFile, { expect: 11 })).toMatchObject({
      schema: "current-v11",
      schemaVersion: 11,
    });
    const migrated = new Database(dbFile, { readonly: true });
    try {
      expect(
        migrated
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all(),
      ).toEqual([
        { version: 5 },
        { version: 6 },
        { version: 7 },
        { version: 8 },
        { version: 9 },
        { version: 10 },
        { version: 11 },
      ]);
      expect(schemaObjects(migrated, "table")).toEqual(
        [...V11_TABLE_NAMES].sort(),
      );
    } finally {
      migrated.close();
    }
  });

  it("rolls an interrupted v5-to-v7 migration back byte-for-byte", () => {
    const dbFile = fixturePath("v5-rollback.db");
    const db = new Database(dbFile);
    db.pragma("foreign_keys = ON");
    initializeV5Schema(db, "2026-01-01T00:00:00.000Z");
    db.close();
    const before = fs.readFileSync(dbFile);

    expect(() =>
      migrateDatabase({ dbFile, failurePoint: "after-create" }),
    ).toThrow("Injected migration failure at after-create");
    expect(fs.readFileSync(dbFile)).toEqual(before);
    expect(validateDatabaseFile(dbFile, { expect: 5 }).schema).toBe(
      "legacy-v5",
    );
  });

  it("is idempotent for an already-current database", () => {
    const dbFile = fixturePath("current.db");
    const storage = new BotStorage({ dbFile });
    storage.initStorage();
    storage.ensureGuild(GUILD_A);
    storage.close();
    expect(migrateDatabase({ dbFile })).toMatchObject({
      status: "already-current",
      fromSchema: "current-v11",
      toSchema: "current-v11",
      guilds: 1,
    });
    expect(validateDatabaseFile(dbFile, { expect: 11 }).schema).toBe(
      "current-v11",
    );
  });

  it("additively upgrades a frozen v10 database to v11", () => {
    const dbFile = fixturePath("v10.db");
    const db = new Database(dbFile);
    db.pragma("foreign_keys = ON");
    initializeV10Schema(db, NOW);
    db.close();

    expect(
      migrateDatabase({
        dbFile,
        now: () => "2026-02-01T00:00:00.000Z",
      }),
    ).toMatchObject({
      status: "migrated",
      fromSchema: "legacy-v10",
      toSchema: "current-v11",
      guilds: 0,
    });
    expect(validateDatabaseFile(dbFile, { expect: 11 })).toMatchObject({
      schema: "current-v11",
      schemaVersion: 11,
    });
    const migrated = new Database(dbFile, { readonly: true });
    try {
      expect(
        migrated
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all(),
      ).toEqual([{ version: 10 }, { version: 11 }]);
      expect(schemaObjects(migrated, "table")).toEqual(
        [...V11_TABLE_NAMES].sort(),
      );
    } finally {
      migrated.close();
    }
  });

  it("rolls a v10-to-v11 migration back byte-for-byte on failure", () => {
    const dbFile = fixturePath("v10-rollback.db");
    const db = new Database(dbFile);
    db.pragma("foreign_keys = ON");
    initializeV10Schema(db, NOW);
    db.close();
    const before = fs.readFileSync(dbFile);

    expect(() =>
      migrateDatabase({ dbFile, failurePoint: "after-create" }),
    ).toThrow("Injected migration failure at after-create");
    expect(fs.readFileSync(dbFile)).toEqual(before);
    expect(validateDatabaseFile(dbFile, { expect: 10 }).schema).toBe(
      "legacy-v10",
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

const PRESERVED_V4_TICKET_COLUMNS = `
  guild_id, ticket_id, ticket_number, opener_id, channel_id,
  control_message_id, subject, description, state, claimed_by, claimed_at,
  closed_by, close_reason, close_log_message_id, close_logged_at,
  failure_reason, created_at, updated_at, closing_at, closed_at
`;

function readPreservedV4Tickets(db: Database): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT ${PRESERVED_V4_TICKET_COLUMNS}
       FROM tickets ORDER BY guild_id, ticket_number`,
    )
    .all() as Array<Record<string, unknown>>;
}

function readSettings(db: Database, guildId: string): Record<string, unknown> {
  const row = db
    .prepare("SELECT settings_json FROM guild_settings WHERE guild_id = ?")
    .get(guildId) as { settings_json: string };
  return JSON.parse(row.settings_json) as Record<string, unknown>;
}

function schemaObjects(db: Database, type: "table" | "index"): string[] {
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

function createV9Fixture(dbFile: string): void {
  const db = new Database(dbFile);
  db.pragma("foreign_keys = ON");
  initializeV9Schema(db, NOW);
  db.prepare(
    `INSERT INTO guilds (
       guild_id, enabled, name, joined_at, left_at, created_at, updated_at
     ) VALUES (?, 1, 'Preserved v9', ?, NULL, ?, ?)`,
  ).run(GUILD_A, NOW, NOW, NOW);
  db.prepare(
    `INSERT INTO guild_settings (
       guild_id, settings_version, settings_json, updated_at
     ) VALUES (?, 3, ?, ?)`,
  ).run(GUILD_A, serializeGuildSettings(createDefaultGuildSettings()), NOW);
  db.prepare(
    `INSERT INTO metrics (guild_id, metric_key, metric_value, updated_at)
     VALUES (?, 'command_usage.utility.ping', 7, ?)`,
  ).run(GUILD_A, NOW);
  db.prepare(
    `INSERT INTO delegated_capability_grants (
       guild_id, principal_type, principal_id, capability, active,
       granted_by, created_at, updated_at
     ) VALUES (?, 'role', ?, 'moderation.manage', 1, ?, ?, ?)`,
  ).run(GUILD_A, "900000000000000001", USER_A, NOW, NOW);
  db.prepare(
    `INSERT INTO posted_panels (
       guild_id, panel_id, preset, channel_id, message_id,
       configuration_json, created_at, updated_at
     ) VALUES (?, 'safetypanel', 'safety', ?, ?, '{"source":"v9"}', ?, ?)`,
  ).run(GUILD_A, "900000000000000002", "900000000000000003", NOW, NOW);
  db.close();
}

function createV8Fixture(dbFile: string): void {
  const db = new Database(dbFile);
  db.pragma("foreign_keys = ON");
  initializeV8Schema(db, NOW);
  db.prepare(
    `INSERT INTO guilds (
       guild_id, enabled, name, joined_at, left_at, created_at, updated_at
     ) VALUES (?, 1, 'Preserved v8', ?, NULL, ?, ?)`,
  ).run(GUILD_A, NOW, NOW, NOW);
  db.prepare(
    `INSERT INTO guild_settings (
       guild_id, settings_version, settings_json, updated_at
     ) VALUES (?, 3, ?, ?)`,
  ).run(GUILD_A, serializeGuildSettings(createDefaultGuildSettings()), NOW);
  db.prepare(
    `INSERT INTO delegated_capability_grants (
       guild_id, principal_type, principal_id, capability, active,
       granted_by, created_at, updated_at
     ) VALUES (?, 'role', ?, 'panels.manage', 1, ?, ?, ?)`,
  ).run(GUILD_A, "900000000000000010", USER_A, NOW, NOW);
  db.prepare(
    `INSERT INTO posted_panels (
       guild_id, panel_id, preset, channel_id, message_id,
       configuration_json, created_at, updated_at
     ) VALUES (?, 'panel_v8', 'resources', ?, ?, ?, ?, ?)`,
  ).run(
    GUILD_A,
    "900000000000000011",
    "900000000000000012",
    JSON.stringify({ title: "Preserved panel" }),
    NOW,
    NOW,
  );
  db.close();
}

function createV3Fixture(dbFile: string): void {
  const db = new Database(dbFile);
  db.pragma("foreign_keys = ON");
  initializeV3Schema(db, "2026-01-01T00:00:00.000Z");
  const settings = createDefaultLegacyGuildSettingsV2();
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
  ).run(
    GUILD_A,
    serializeLegacyGuildSettingsV2(settings),
    "2026-01-01T00:00:00.000Z",
  );
  db.prepare(
    `INSERT INTO metrics (
       guild_id, metric_key, metric_value, updated_at
     ) VALUES (?, ?, ?, ?)`,
  ).run(GUILD_A, "command_usage.utility.ping", 7, "2026-01-01T00:00:00.000Z");
  db.close();
}

function createV4TicketFixture(dbFile: string): string {
  const db = new Database(dbFile);
  db.pragma("foreign_keys = ON");
  const now = "2026-01-01T00:00:00.000Z";
  initializeV4Schema(db, now);
  const settings = createDefaultLegacyGuildSettingsV2();
  db.prepare(
    `INSERT INTO guilds (
       guild_id, enabled, name, joined_at, left_at, created_at, updated_at
     ) VALUES (?, 0, 'Preserved v4', ?, NULL, ?, ?)`,
  ).run(GUILD_A, now, now, now);
  db.prepare(
    `INSERT INTO guild_settings (
       guild_id, settings_version, settings_json, updated_at
     ) VALUES (?, 2, ?, ?)`,
  ).run(GUILD_A, serializeLegacyGuildSettingsV2(settings), now);
  db.prepare(
    `INSERT INTO ticket_configurations (
       guild_id, enabled, category_id, log_channel_id, support_role_id,
       created_at, updated_at
     ) VALUES (?, 1, ?, ?, ?, ?, ?)`,
  ).run(
    GUILD_A,
    "333333333333333333",
    "555555555555555555",
    "666666666666666666",
    now,
    now,
  );
  db.prepare(
    `INSERT INTO posted_panels (
       guild_id, panel_id, preset, channel_id, message_id, configuration_json,
       created_at, updated_at
     ) VALUES (?, 'panel_v4', 'tickets', ?, ?, '{}', ?, ?)`,
  ).run(GUILD_A, "777777777777777777", "888888888888888888", now, now);
  const ticketId = "ticket_v4";
  const insertTicket = db.prepare(
    `INSERT INTO tickets (
       guild_id, ticket_id, ticket_number, opener_id, channel_id,
       control_message_id, subject, description, state, claimed_by, claimed_at,
       closed_by, close_reason, close_log_message_id, close_logged_at,
       failure_reason, created_at, updated_at, closing_at, closed_at
     ) VALUES (
       @guildId, @ticketId, @ticketNumber, @openerId, @channelId,
       @controlMessageId, @subject, @description, @state, @claimedBy, @claimedAt,
       @closedBy, @closeReason, @closeLogMessageId, @closeLoggedAt,
       @failureReason, @createdAt, @updatedAt, @closingAt, @closedAt
     )`,
  );
  insertTicket.run({
    guildId: GUILD_A,
    ticketId,
    ticketNumber: 1,
    openerId: USER_A,
    channelId: "900000000000000001",
    controlMessageId: "900000000000000002",
    subject: "Migration subject",
    description: "Migration details",
    state: "open",
    claimedBy: "900000000000000003",
    claimedAt: "2026-01-01T00:01:00.000Z",
    closedBy: null,
    closeReason: null,
    closeLogMessageId: null,
    closeLoggedAt: null,
    failureReason: null,
    createdAt: now,
    updatedAt: "2026-01-01T00:02:00.000Z",
    closingAt: null,
    closedAt: null,
  });
  insertTicket.run({
    guildId: GUILD_A,
    ticketId: "ticket_closing_v4",
    ticketNumber: 2,
    openerId: "900000000000000011",
    channelId: "900000000000000012",
    controlMessageId: "900000000000000013",
    subject: "Closing migration",
    description: "Preserve the closing and log-delivery checkpoints.",
    state: "closing",
    claimedBy: null,
    claimedAt: null,
    closedBy: "900000000000000014",
    closeReason: "The request is complete.",
    closeLogMessageId: "900000000000000015",
    closeLoggedAt: "2026-01-01T00:05:00.000Z",
    failureReason: null,
    createdAt: "2026-01-01T00:03:00.000Z",
    updatedAt: "2026-01-01T00:06:00.000Z",
    closingAt: "2026-01-01T00:04:00.000Z",
    closedAt: null,
  });
  insertTicket.run({
    guildId: GUILD_A,
    ticketId: "ticket_closed_v4",
    ticketNumber: 3,
    openerId: "900000000000000021",
    channelId: "900000000000000022",
    controlMessageId: "900000000000000023",
    subject: "Closed migration",
    description: "Preserve the completed closure lifecycle exactly.",
    state: "closed",
    claimedBy: "900000000000000024",
    claimedAt: "2026-01-01T00:07:00.000Z",
    closedBy: "900000000000000025",
    closeReason: "The request was resolved.",
    closeLogMessageId: "900000000000000026",
    closeLoggedAt: "2026-01-01T00:09:00.000Z",
    failureReason: null,
    createdAt: "2026-01-01T00:06:00.000Z",
    updatedAt: "2026-01-01T00:10:00.000Z",
    closingAt: "2026-01-01T00:08:00.000Z",
    closedAt: "2026-01-01T00:10:00.000Z",
  });
  db.prepare(
    `INSERT INTO ticket_events (
       guild_id, ticket_id, event_id, event_number, event_type, actor_id,
       details_json, created_at
     ) VALUES (?, ?, 'event_v4', 1, 'creation_reserved', ?, '{}', ?)`,
  ).run(GUILD_A, ticketId, USER_A, now);
  db.close();
  return ticketId;
}

function fixturePath(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "superior-migration-"));
  roots.push(root);
  return path.join(root, name);
}
