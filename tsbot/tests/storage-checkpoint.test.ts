import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "../src/storage/database.js";
import {
  checkpointDatabase,
  normalizeCheckpointMode,
} from "../src/storage/checkpoint.js";
import { BotStorage } from "../src/storage/db.js";
import { validateDatabaseFile } from "../src/storage/migration.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("explicit WAL checkpointing", () => {
  it("checkpoints a validated v11 database without changing its schema", () => {
    const root = makeRoot();
    const dbFile = path.join(root, "superior.db");
    const storage = new BotStorage({ dbFile });
    storage.initStorage();
    storage.ensureGuild("111111111111111111");
    storage.close();

    const result = checkpointDatabase({ dbFile, mode: "truncate" });

    expect(result).toMatchObject({
      mode: "truncate",
      outcome: "completed",
      busyFrames: 0,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(() => validateDatabaseFile(dbFile, { expect: 11 })).not.toThrow();
  });

  it("rejects unsupported modes before issuing a pragma", () => {
    expect(normalizeCheckpointMode("FULL")).toBe("full");
    expect(() => normalizeCheckpointMode("delete")).toThrow(
      /Checkpoint mode must be one of/u,
    );
  });

  it("reports an incomplete passive checkpoint while a reader pins WAL frames", () => {
    const root = makeRoot();
    const dbFile = path.join(root, "superior.db");
    const storage = new BotStorage({ dbFile });
    storage.initStorage();
    storage.ensureGuild("111111111111111111");
    storage.close();

    const writer = new Database(dbFile, { fileMustExist: true });
    const reader = new Database(dbFile, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      writer
        .prepare(
          "UPDATE guilds SET name = ?, updated_at = ? WHERE guild_id = ?",
        )
        .run(
          "before pinned read",
          "2026-09-01T00:00:00.000Z",
          "111111111111111111",
        );
      reader.exec("BEGIN");
      expect(
        reader
          .prepare("SELECT name FROM guilds WHERE guild_id = ?")
          .get("111111111111111111"),
      ).toEqual({ name: "before pinned read" });
      writer
        .prepare(
          "UPDATE guilds SET name = ?, updated_at = ? WHERE guild_id = ?",
        )
        .run(
          "after pinned read",
          "2026-09-01T00:00:01.000Z",
          "111111111111111111",
        );

      const result = checkpointDatabase({ dbFile, mode: "passive" });

      expect(result.outcome).toBe("busy");
      expect(result.logFrames).toBeGreaterThan(result.checkpointedFrames);
    } finally {
      reader.exec("ROLLBACK");
      reader.close();
      writer.close();
    }
  });
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "superior-checkpoint-"));
  roots.push(root);
  return root;
}
