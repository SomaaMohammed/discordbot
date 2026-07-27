import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CourtStorage } from "../src/storage/db.js";
import { validateDatabaseFile } from "../src/storage/migration.js";
import {
  detectDatabaseSchema,
  validateV2Schema,
} from "../src/storage/schema.js";

const roots: string[] = [];

function makePaths(): { root: string; dbFile: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "court-schema-"));
  roots.push(root);
  return { root, dbFile: path.join(root, "synthetic.db") };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("v2 schema", () => {
  it("initializes a fresh database with all current constraints", () => {
    const { root, dbFile } = makePaths();
    const storage = new CourtStorage({ dbFile }, root);
    storage.initStorage();
    storage.close();

    expect(validateDatabaseFile(dbFile, { requireCurrent: true })).toEqual({
      schema: "current-v2",
      integrity: "ok",
      schemaVersion: 2,
    });
    const db = new Database(dbFile, { readonly: true });
    try {
      expect(validateV2Schema(db)).toEqual([]);
      const answerPk = (
        db.pragma("table_info(answers)") as Array<{
          name: string;
          pk: number;
        }>
      )
        .filter((column) => column.pk > 0)
        .sort((left, right) => left.pk - right.pk)
        .map((column) => column.name);
      expect(answerPk).toEqual([
        "guild_id",
        "question_message_id",
        "user_id",
      ]);
      for (const table of ["guilds", "guild_settings"]) {
        const guildIdColumn = (
          db.pragma(`table_info(${table})`) as Array<{
            name: string;
            type: string;
            notnull: number;
            pk: number;
          }>
        ).find((column) => column.name === "guild_id");
        expect(guildIdColumn).toMatchObject({
          type: "TEXT",
          notnull: 1,
          pk: 1,
        });
      }
      const retentionIndex = db
        .pragma("index_info(idx_answers_guild_created_at)") as Array<{
        name: string | null;
        seqno: number;
      }>;
      expect(
        retentionIndex
          .sort((left, right) => left.seqno - right.seqno)
          .map((column) => column.name),
      ).toEqual(["guild_id", null]);
      const postDateIndex = db.pragma(
        "index_info(idx_posts_guild_posted_at)",
      ) as Array<{ name: string | null; seqno: number }>;
      expect(
        postDateIndex
          .sort((left, right) => left.seqno - right.seqno)
          .map((column) => column.name),
      ).toEqual(["guild_id", null]);
    } finally {
      db.close();
    }
  });

  it("classifies a damaged v2 schema as unknown", () => {
    const { root, dbFile } = makePaths();
    const storage = new CourtStorage({ dbFile }, root);
    storage.initStorage();
    storage.close();
    const db = new Database(dbFile);
    db.exec("DROP INDEX idx_answers_guild_message_id");
    expect(detectDatabaseSchema(db)).toBe("unknown");
    expect(validateV2Schema(db)).toContain(
      "missing index idx_answers_guild_message_id",
    );
    db.close();
    expect(() => validateDatabaseFile(dbFile)).toThrow("unknown");
  });

  it("rejects unsafe tenant column declarations and spoofed date indexes", () => {
    const { root, dbFile } = makePaths();
    const storage = new CourtStorage({ dbFile }, root);
    storage.initStorage();
    storage.close();

    const db = new Database(dbFile);
    try {
      db.exec(`
        DROP TABLE guild_settings;
        CREATE TABLE guild_settings (
          guild_id INTEGER PRIMARY KEY,
          settings_version INTEGER NOT NULL,
          settings_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
        );
        DROP INDEX idx_answers_guild_created_at;
        CREATE INDEX idx_answers_guild_created_at
          ON answers (guild_id, length(created_at));
      `);

      const issues = validateV2Schema(db);
      expect(issues).toContain(
        "guild_settings.guild_id type is INTEGER, expected TEXT",
      );
      expect(issues).toContain(
        "guild_settings.guild_id NOT NULL is false, expected true",
      );
      expect(issues).toContain(
        "idx_answers_guild_created_at SQL does not match the required definition",
      );
      expect(detectDatabaseSchema(db)).toBe("unknown");
    } finally {
      db.close();
    }
  });
});
