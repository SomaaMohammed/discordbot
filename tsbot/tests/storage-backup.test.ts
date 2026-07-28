import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { backupDatabase } from "../src/storage/backup.js";
import { BotStorage } from "../src/storage/db.js";
import { validateDatabaseFile } from "../src/storage/migration.js";
import {
  createV2FixtureDatabase,
  insertV2Guild,
} from "./helpers/v2-fixture.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("validated SQLite backup", () => {
  it("copies and validates schema v3 without changing the source", async () => {
    const root = makeRoot();
    const source = path.join(root, "source.db");
    const output = path.join(root, "backup.db");
    const storage = new BotStorage({ dbFile: source });
    storage.initStorage();
    storage.ensureGuild("111111111111111111");
    storage.forGuild("111111111111111111").recordCommandMetric("utility.ping");
    storage.close();

    const result = await backupDatabase({
      dbFile: source,
      outputFile: output,
      expect: 3,
    });
    expect(result).toMatchObject({
      schema: "current-v3",
      schemaVersion: 3,
      integrity: "ok",
      foreignKeyViolations: 0,
    });
    expect(result.bytes).toBeGreaterThan(0);
    expect(validateDatabaseFile(source, { expect: 3 }).schema).toBe(
      "current-v3",
    );
    expect(validateDatabaseFile(output, { expect: 3 }).schema).toBe(
      "current-v3",
    );

    const copied = new Database(output, { readonly: true });
    try {
      expect(
        copied.prepare("SELECT COUNT(*) AS count FROM guilds").get(),
      ).toEqual({ count: 1 });
      expect(
        copied.prepare("SELECT COUNT(*) AS count FROM metrics").get(),
      ).toEqual({ count: 1 });
    } finally {
      copied.close();
    }
  });

  it("supports exact v2 pre-migration backups", async () => {
    const root = makeRoot();
    const source = path.join(root, "source-v2.db");
    const output = path.join(root, "backup-v2.db");
    const db = createV2FixtureDatabase(source);
    insertV2Guild(db, { guildId: "111111111111111111" });
    db.close();

    await expect(
      backupDatabase({ dbFile: source, outputFile: output, expect: 2 }),
    ).resolves.toMatchObject({ schema: "legacy-v2", schemaVersion: 2 });
    expect(validateDatabaseFile(output, { expect: 2 }).schema).toBe(
      "legacy-v2",
    );
  });

  it("refuses existing destinations and schema mismatches", async () => {
    const root = makeRoot();
    const source = path.join(root, "source.db");
    const output = path.join(root, "existing.db");
    const storage = new BotStorage({ dbFile: source });
    storage.initStorage();
    storage.close();
    fs.writeFileSync(output, "operator-owned");

    await expect(
      backupDatabase({ dbFile: source, outputFile: output, expect: 3 }),
    ).rejects.toThrow(/already exists/);
    expect(fs.readFileSync(output, "utf8")).toBe("operator-owned");

    const mismatch = path.join(root, "mismatch.db");
    await expect(
      backupDatabase({ dbFile: source, outputFile: mismatch, expect: 2 }),
    ).rejects.toThrow(/expected exact schema v2/);
    expect(fs.existsSync(mismatch)).toBe(false);
  });
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "superior-backup-"));
  roots.push(root);
  return root;
}
