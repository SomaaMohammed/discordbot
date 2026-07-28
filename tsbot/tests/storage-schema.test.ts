import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { BotStorage } from "../src/storage/db.js";
import { validateDatabaseFile } from "../src/storage/migration.js";
import {
  detectDatabaseSchema,
  validateV3Schema,
  V3_EXPLICIT_INDEX_NAMES,
  V3_TABLE_NAMES,
} from "../src/storage/schema.js";
import { createV2FixtureDatabase } from "./helpers/v2-fixture.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("schema v3", () => {
  it("creates only the exact active tables and required index", () => {
    const dbFile = freshDatabase();
    const validation = validateDatabaseFile(dbFile, { expect: 3 });
    expect(validation).toEqual({
      schema: "current-v3",
      schemaVersion: 3,
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
      ).toEqual([...V3_TABLE_NAMES].sort());
      expect(
        objects.filter((row) => row.type === "index").map(rowName),
      ).toEqual([...V3_EXPLICIT_INDEX_NAMES].sort());
      expect(objects.some((row) => row.type === "view")).toBe(false);
      expect(objects.some((row) => row.type === "trigger")).toBe(false);
      expect(validateV3Schema(db)).toEqual([]);
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
      expect(validateV3Schema(db).join(" ")).toMatch(/settings are invalid/);
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
