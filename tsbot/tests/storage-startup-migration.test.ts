import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDatabaseCurrent } from "../src/storage/startup-migration.js";
import { validateDatabaseFile } from "../src/storage/migration.js";
import {
  initializeV10Schema,
  initializeV11Schema,
  initializeV9Schema,
} from "../src/storage/schema.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("packaged startup database migration", () => {
  it("backs up and upgrades an exact schema-v9 database", async () => {
    const root = makeRoot();
    const dbFile = path.join(root, "superior.db");
    const db = new Database(dbFile);
    initializeV9Schema(db, "2026-01-01T00:00:00.000Z");
    db.close();

    const result = await ensureDatabaseCurrent({
      dbFile,
      now: () => new Date("2026-08-24T20:00:00.000Z"),
    });

    expect(result).toMatchObject({
      status: "migrated",
      schema: "current-v11",
      fromSchema: "legacy-v9",
    });
    expect(result.backupFile).toBe(
      path.join(
        root,
        "backups",
        "superior-pre-schema11-schema9-20260824T200000Z.db",
      ),
    );
    expect(validateDatabaseFile(dbFile, { expect: 11 })).toMatchObject({
      schema: "current-v11",
      schemaVersion: 11,
    });
    expect(
      validateDatabaseFile(result.backupFile as string, { expect: 9 }),
    ).toMatchObject({
      schema: "legacy-v9",
      schemaVersion: 9,
    });
  });

  it("does not create a backup for a missing or current database", async () => {
    const root = makeRoot();
    const missing = path.join(root, "missing.db");
    await expect(
      ensureDatabaseCurrent({ dbFile: missing }),
    ).resolves.toMatchObject({ status: "skipped", schema: "empty" });

    const current = path.join(root, "current.db");
    const db = new Database(current);
    db.pragma("foreign_keys = ON");
    initializeV11Schema(db, "2026-01-01T00:00:00.000Z");
    db.close();
    await expect(
      ensureDatabaseCurrent({ dbFile: current }),
    ).resolves.toMatchObject({
      status: "already-current",
      schema: "current-v11",
    });

    expect(fs.existsSync(path.join(root, "backups"))).toBe(false);
  });

  it("backs up and upgrades an exact schema-v10 database", async () => {
    const root = makeRoot();
    const dbFile = path.join(root, "superior-v10.db");
    const db = new Database(dbFile);
    initializeV10Schema(db, "2026-01-01T00:00:00.000Z");
    db.close();

    await expect(
      ensureDatabaseCurrent({
        dbFile,
        now: () => new Date("2026-08-24T20:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      status: "migrated",
      schema: "current-v11",
      fromSchema: "legacy-v10",
    });
    expect(validateDatabaseFile(dbFile, { expect: 11 }).schema).toBe(
      "current-v11",
    );
  });
});

function makeRoot(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "superior-startup-migration-"),
  );
  roots.push(root);
  return root;
}
