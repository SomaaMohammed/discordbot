import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyError } from "../src/errors.js";
import Database from "../src/storage/database.js";
import { BotStorage } from "../src/storage/db.js";
import { SqliteRowDecodeError } from "../src/storage/row-decoder.js";

const roots: string[] = [];
const GUILD_ID = "111111111111111111";
const NOW = "2026-01-01T00:00:00.000Z";

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("classified malformed SQLite rows", () => {
  it("rejects malformed guild settings without exposing the stored value", () => {
    const fixture = makeFixture();
    const database = new Database(fixture.dbFile, { fileMustExist: true });
    try {
      database
        .prepare(
          "UPDATE guild_settings SET settings_json = x'7b7d' WHERE guild_id = ?",
        )
        .run(GUILD_ID);
      const failure = capture(() => fixture.storage.getGuildSettings(GUILD_ID));
      expect(failure).toBeInstanceOf(SqliteRowDecodeError);
      expect(classifyError(failure).category).toBe("sqlite-schema");
      expect((failure as Error).message).toContain("guild_settings");
      expect((failure as Error).message).not.toContain("7b7d");
    } finally {
      database.close();
      fixture.storage.close();
    }
  });

  it("rejects malformed authorization rows at the repository boundary", () => {
    const fixture = makeFixture();
    const database = new Database(fixture.dbFile, { fileMustExist: true });
    try {
      database.pragma("ignore_check_constraints = ON");
      database
        .prepare(
          `INSERT INTO delegated_capability_grants (
             guild_id, principal_type, principal_id, capability, active,
             granted_by, created_at, updated_at
           ) VALUES (?, 'role', x'0102', 'panels.manage', 1, ?, ?, ?)`,
        )
        .run(GUILD_ID, "222222222222222222", NOW, NOW);
      const failure = capture(() =>
        fixture.storage.forGuild(GUILD_ID).listCapabilityGrants(),
      );
      expect(failure).toBeInstanceOf(SqliteRowDecodeError);
      expect(classifyError(failure).category).toBe("sqlite-schema");
      expect((failure as Error).message).toContain("delegated capability");
      expect((failure as Error).message).not.toContain("0102");
    } finally {
      database.close();
      fixture.storage.close();
    }
  });

  it("rejects malformed persistent-panel rows before JSON parsing", () => {
    const fixture = makeFixture();
    const database = new Database(fixture.dbFile, { fileMustExist: true });
    try {
      database
        .prepare(
          `INSERT INTO posted_panels (
             guild_id, panel_id, preset, channel_id, message_id,
             configuration_json, created_at, updated_at
           ) VALUES (?, ?, 'help', ?, ?, x'7b7d', ?, ?)`,
        )
        .run(
          GUILD_ID,
          "aaaaaaaaaaaaaaaaaaaaaaaa",
          "333333333333333333",
          "444444444444444444",
          NOW,
          NOW,
        );
      const failure = capture(() =>
        fixture.storage.forGuild(GUILD_ID).listPostedPanels(),
      );
      expect(failure).toBeInstanceOf(SqliteRowDecodeError);
      expect(classifyError(failure).category).toBe("sqlite-schema");
      expect((failure as Error).message).toContain("posted panels");
      expect((failure as Error).message).not.toContain("7b7d");
    } finally {
      database.close();
      fixture.storage.close();
    }
  });
});

function makeFixture(): { dbFile: string; storage: BotStorage } {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "superior-malformed-row-"),
  );
  roots.push(root);
  const dbFile = path.join(root, "superior.db");
  const storage = new BotStorage({ dbFile });
  storage.initStorage();
  storage.ensureGuild(GUILD_ID);
  return { dbFile, storage };
}

function capture(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the malformed row to fail decoding");
}
