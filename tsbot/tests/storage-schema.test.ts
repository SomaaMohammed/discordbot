import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { BotStorage } from "../src/storage/db.js";
import { validateDatabaseFile } from "../src/storage/migration.js";
import {
  detectDatabaseSchema,
  initializeV3Schema,
  initializeV4Schema,
  validateV2Schema,
  validateV5Schema,
  V5_EXPLICIT_INDEX_NAMES,
  V5_TABLE_NAMES,
} from "../src/storage/schema.js";
import { createV2FixtureDatabase } from "./helpers/v2-fixture.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("schema v5", () => {
  it("creates only the exact active tables and required index", () => {
    const dbFile = freshDatabase();
    const validation = validateDatabaseFile(dbFile, { expect: 5 });
    expect(validation).toEqual({
      schema: "current-v5",
      schemaVersion: 5,
      integrity: "ok",
      foreignKeyViolations: 0,
    });

    const db = new Database(dbFile, { readonly: true });
    try {
      const objects = db
        .prepare(
          `SELECT type, name FROM sqlite_master
           WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
        )
        .all() as Array<{ type: string; name: string }>;
      expect(
        objects.filter((row) => row.type === "table").map(rowName),
      ).toEqual([...V5_TABLE_NAMES].sort());
      expect(
        objects.filter((row) => row.type === "index").map(rowName),
      ).toEqual([...V5_EXPLICIT_INDEX_NAMES].sort());
      expect(objects.some((row) => row.type === "view")).toBe(false);
      expect(objects.some((row) => row.type === "trigger")).toBe(false);
      expect(validateV5Schema(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("rejects user-principal capability grants in a fresh v5 schema", () => {
    const dbFile = freshDatabase();
    const storage = new BotStorage({ dbFile });
    storage.initStorage();
    storage.ensureGuild("111111111111111111");
    storage.close();

    const db = new Database(dbFile);
    db.pragma("foreign_keys = ON");
    try {
      expect(() =>
        db
          .prepare(
            `INSERT INTO delegated_capability_grants (
               guild_id, principal_type, principal_id, capability, active,
               granted_by, created_at, updated_at
             ) VALUES (?, 'user', ?, 'panels.manage', 1, ?, ?, ?)`,
          )
          .run(
            "111111111111111111",
            "222222222222222222",
            "333333333333333333",
            "2026-01-01T00:00:00.000Z",
            "2026-01-01T00:00:00.000Z",
          ),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it.each([
    ["table", "CREATE TABLE unexpected_table (value TEXT)"],
    ["view", "CREATE VIEW unexpected_view AS SELECT guild_id FROM guilds"],
    [
      "trigger",
      "CREATE TRIGGER unexpected_trigger AFTER INSERT ON guilds BEGIN SELECT 1; END",
    ],
    ["index", "CREATE INDEX unexpected_index ON metrics (updated_at)"],
  ])("rejects every extra explicit %s", (_kind, sql) => {
    const dbFile = freshDatabase();
    const db = new Database(dbFile);
    try {
      db.exec(sql);
      expect(detectDatabaseSchema(db)).toBe("unknown");
    } finally {
      db.close();
    }
  });

  it("rejects data-level settings inconsistencies", () => {
    const dbFile = freshDatabase();
    const storage = new BotStorage({ dbFile });
    storage.initStorage();
    storage.ensureGuild("111111111111111111");
    storage.close();

    const db = new Database(dbFile);
    try {
      db.prepare(
        "UPDATE guild_settings SET settings_json = '{malformed' WHERE guild_id = ?",
      ).run("111111111111111111");
      expect(detectDatabaseSchema(db)).toBe("unknown");
      expect(validateV5Schema(db).join(" ")).toMatch(/settings are invalid/);
    } finally {
      db.close();
    }
  });

  it("preserves CHECK literal case while comparing exact table SQL", () => {
    const dbFile = freshDatabase();
    const db = new Database(dbFile);
    try {
      const table = db
        .prepare(
          `SELECT sql FROM sqlite_master
           WHERE type = 'table' AND name = 'ticket_events'`,
        )
        .get() as { sql: string };
      const index = db
        .prepare(
          `SELECT sql FROM sqlite_master
           WHERE type = 'index' AND name = 'idx_ticket_events_ticket'`,
        )
        .get() as { sql: string };
      db.exec("DROP TABLE ticket_events");
      db.exec(table.sql.replace("'creation_reserved'", "'CREATION_RESERVED'"));
      db.exec(index.sql);
      expect(validateV5Schema(db).join(" ")).toMatch(
        /ticket_events SQL does not match/,
      );
      expect(detectDatabaseSchema(db)).toBe("unknown");
    } finally {
      db.close();
    }
  });

  it("rejects operational JSON that exceeds repository UTF-8 byte limits", () => {
    const dbFile = freshDatabase();
    const storage = new BotStorage({ dbFile });
    storage.initStorage();
    storage.ensureGuild("111111111111111111");
    storage.close();
    const db = new Database(dbFile);
    try {
      db.pragma("ignore_check_constraints = ON");
      db.prepare(
        `INSERT INTO posted_panels (
           guild_id, panel_id, preset, channel_id, message_id,
           configuration_json, created_at, updated_at
         ) VALUES (?, ?, 'resources', ?, ?, ?, ?, ?)`,
      ).run(
        "111111111111111111",
        "bytepanel1",
        "222222222222222222",
        "333333333333333333",
        JSON.stringify({ body: "😀".repeat(5_000) }),
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
      db.pragma("ignore_check_constraints = OFF");
      expect(validateV5Schema(db).join(" ")).toMatch(
        /invalid or oversized JSON/,
      );
      expect(detectDatabaseSchema(db)).toBe("unknown");
    } finally {
      db.close();
    }
  });

  it.each(["subject", "description", "close_reason", "failure_reason"])(
    "rejects a SQLite BLOB in the ticket %s column",
    (column) => {
      const dbFile = freshDatabase();
      const storage = new BotStorage({ dbFile });
      storage.initStorage();
      storage.ensureGuild("111111111111111111");
      const guild = storage.forGuild("111111111111111111");
      guild.upsertTicketConfiguration({
        categoryId: "222222222222222222",
        logChannelId: "333333333333333333",
        supportRoleId: "444444444444444444",
      });
      const reserved = guild.reserveTicketCreation({
        openerId: "555555555555555555",
        subject: "BLOB validation",
        description: "The schema checker must reject binary ticket text.",
      });
      storage.close();

      const db = new Database(dbFile);
      try {
        db.pragma("ignore_check_constraints = ON");
        db.prepare(
          `UPDATE tickets SET ${column} = ? WHERE guild_id = ? AND ticket_id = ?`,
        ).run(
          Buffer.from("binary ticket text"),
          "111111111111111111",
          reserved.ticket.ticketId,
        );
        db.pragma("ignore_check_constraints = OFF");

        expect(validateV5Schema(db).join(" ")).toMatch(/non-text data/);
        expect(detectDatabaseSchema(db)).toBe("unknown");
      } finally {
        db.close();
      }
    },
  );

  it("rejects an enabled application form without a configured field", () => {
    const dbFile = freshDatabase();
    const storage = new BotStorage({ dbFile });
    storage.initStorage();
    storage.ensureGuild("111111111111111111");
    storage.close();

    const db = new Database(dbFile);
    try {
      db.prepare(
        `INSERT INTO application_forms (
           guild_id, form_id, slug, display_name, description,
           reviewer_role_id, review_channel_id, enabled, sort_order,
           definition_version, bindings_verified_at, created_at, updated_at
         ) VALUES (?, 'staffform', 'staff', 'Staff', 'Apply for staff.',
           ?, ?, 1, 0, 1, NULL, ?, ?)`,
      ).run(
        "111111111111111111",
        "222222222222222222",
        "333333333333333333",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );

      expect(validateV5Schema(db).join(" ")).toMatch(
        /enabled application form does not have 1-5 fields/,
      );
      expect(detectDatabaseSchema(db)).toBe("unknown");
    } finally {
      db.close();
    }
  });

  it("enforces active-opener, channel, lifecycle, and composite tenant constraints", () => {
    const dbFile = freshDatabase();
    const storage = new BotStorage({ dbFile });
    storage.initStorage();
    storage.ensureGuild("111111111111111111");
    storage.ensureGuild("222222222222222222");
    const guild = storage.forGuild("111111111111111111");
    const reserved = guild.reserveTicketCreation({
      openerId: "333333333333333333",
      subject: "Constraint proof",
      description: "Exercise raw SQLite invariants.",
    });
    guild.activateTicketCreation(reserved.ticket.ticketId, {
      channelId: "444444444444444444",
    });
    storage.close();

    const db = new Database(dbFile);
    db.pragma("foreign_keys = ON");
    try {
      const activeIndex = db
        .prepare(
          `SELECT sql FROM sqlite_master
           WHERE type = 'index' AND name = 'idx_tickets_guild_opener_department_active'`,
        )
        .get() as { sql: string };
      expect(activeIndex.sql).toMatch(
        /UNIQUE INDEX[\s\S]*guild_id, department_id, opener_id[\s\S]*WHERE state IN \('creating', 'open', 'closing'\)/i,
      );
      const eventForeignKeys = db
        .prepare("PRAGMA foreign_key_list(ticket_events)")
        .all() as Array<{ table: string; from: string; to: string }>;
      expect(
        eventForeignKeys
          .filter((row) => row.table === "tickets")
          .map((row) => `${row.from}:${row.to}`)
          .sort(),
      ).toEqual(["guild_id:guild_id", "ticket_id:ticket_id"]);

      expect(() =>
        db
          .prepare(
            `INSERT INTO tickets (
               guild_id, ticket_id, ticket_number, department_id, opener_id,
               subject, description, state, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?)`,
          )
          .run(
            "111111111111111111",
            "duplicate1",
            2,
            reserved.ticket.departmentId,
            "333333333333333333",
            "Duplicate",
            "Must fail",
            "2026-01-01T00:00:00.000Z",
            "2026-01-01T00:00:00.000Z",
          ),
      ).toThrow(/UNIQUE constraint failed/);
      expect(() =>
        db
          .prepare(
            `INSERT INTO tickets (
               guild_id, ticket_id, ticket_number, department_id, opener_id,
               channel_id, subject, description, state, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
          )
          .run(
            "111111111111111111",
            "duplicate2",
            2,
            reserved.ticket.departmentId,
            "555555555555555555",
            "444444444444444444",
            "Duplicate channel",
            "Must fail",
            "2026-01-01T00:00:00.000Z",
            "2026-01-01T00:00:00.000Z",
          ),
      ).toThrow(/UNIQUE constraint failed/);
      expect(() =>
        db
          .prepare(
            "UPDATE tickets SET state = 'closed' WHERE guild_id = ? AND ticket_id = ?",
          )
          .run("111111111111111111", reserved.ticket.ticketId),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        db
          .prepare(
            `INSERT INTO ticket_events (
               guild_id, ticket_id, event_id, event_number, event_type,
               details_json, created_at
             ) VALUES (?, ?, ?, 2, 'recovery_noted', '{}', ?)`,
          )
          .run(
            "222222222222222222",
            reserved.ticket.ticketId,
            "crossevent",
            "2026-01-01T00:00:00.000Z",
          ),
      ).toThrow(/FOREIGN KEY constraint failed/);
    } finally {
      db.close();
    }
  });

  it("normal startup read-only classifies and refuses schema v2 unchanged", () => {
    const root = makeRoot();
    const dbFile = path.join(root, "v2.db");
    createV2FixtureDatabase(dbFile).close();
    const before = fs.readFileSync(dbFile);

    const storage = new BotStorage({ dbFile });
    expect(() => storage.initStorage()).toThrow(/explicit migration/);
    storage.close();
    expect(fs.readFileSync(dbFile)).toEqual(before);
    expect(validateDatabaseFile(dbFile, { expect: 2 }).schema).toBe(
      "legacy-v2",
    );
  });

  it("rejects a schema-v2 migration marker with an invalid timestamp", () => {
    const root = makeRoot();
    const dbFile = path.join(root, "invalid-v2-marker.db");
    const db = createV2FixtureDatabase(dbFile);
    try {
      db.prepare(
        "UPDATE schema_migrations SET applied_at = 'not-a-timestamp' WHERE version = 2",
      ).run();
      expect(validateV2Schema(db).join(" ")).toMatch(
        /schema_migrations must end at version 2/,
      );
      expect(detectDatabaseSchema(db)).toBe("unknown");
    } finally {
      db.close();
    }
    expect(() => validateDatabaseFile(dbFile, { expect: 2 })).toThrow(
      /expected exact schema v2/,
    );
  });

  it("normal startup read-only classifies and refuses schema v3 unchanged", () => {
    const root = makeRoot();
    const dbFile = path.join(root, "v3.db");
    const db = new Database(dbFile);
    db.pragma("foreign_keys = ON");
    initializeV3Schema(db, "2026-01-01T00:00:00.000Z");
    db.close();
    const before = fs.readFileSync(dbFile);

    const storage = new BotStorage({ dbFile });
    expect(() => storage.initStorage()).toThrow(
      /schema v3 requires an explicit migration/i,
    );
    storage.close();
    expect(fs.readFileSync(dbFile)).toEqual(before);
    expect(validateDatabaseFile(dbFile, { expect: 3 }).schema).toBe(
      "legacy-v3",
    );
  });

  it("normal startup read-only classifies and refuses schema v4 unchanged", () => {
    const root = makeRoot();
    const dbFile = path.join(root, "v4.db");
    const db = new Database(dbFile);
    db.pragma("foreign_keys = ON");
    initializeV4Schema(db, "2026-01-01T00:00:00.000Z");
    db.close();
    const before = fs.readFileSync(dbFile);

    const storage = new BotStorage({ dbFile });
    expect(() => storage.initStorage()).toThrow(
      /schema v4 requires an explicit migration/i,
    );
    storage.close();
    expect(fs.readFileSync(dbFile)).toEqual(before);
    expect(validateDatabaseFile(dbFile, { expect: 4 }).schema).toBe(
      "legacy-v4",
    );
  });

  it("normal startup refuses an unknown database unchanged", () => {
    const root = makeRoot();
    const dbFile = path.join(root, "unknown.db");
    const db = new Database(dbFile);
    db.exec("CREATE TABLE partial (value TEXT)");
    db.close();
    const before = fs.readFileSync(dbFile);

    const storage = new BotStorage({ dbFile });
    expect(() => storage.initStorage()).toThrow(/unknown or incomplete/);
    storage.close();
    expect(fs.readFileSync(dbFile)).toEqual(before);
  });
});

function rowName(row: { name: string }): string {
  return row.name;
}

function freshDatabase(): string {
  const root = makeRoot();
  const dbFile = path.join(root, "fresh.db");
  const storage = new BotStorage({ dbFile });
  storage.initStorage();
  storage.close();
  return dbFile;
}

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "superior-schema-"));
  roots.push(root);
  return root;
}
