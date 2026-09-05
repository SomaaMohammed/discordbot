import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "../src/storage/database.js";
import { recordSqliteOperationalEvent } from "../src/storage/telemetry.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("bounded SQLite operational telemetry", () => {
  it("records transaction mode and outcome without SQL parameters", () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line) => {
      lines.push(String(line));
    });
    const database = new Database();
    database.exec("CREATE TABLE records (value TEXT NOT NULL PRIMARY KEY)");
    const secret = "discord-token-shaped-private-value";
    database
      .transaction(() => {
        database.prepare("INSERT INTO records (value) VALUES (?)").run(secret);
      })
      .immediate();
    expect(() =>
      database
        .transaction(() => {
          database.prepare("DELETE FROM records").run();
          throw new Error("rollback requested");
        })
        .exclusive(),
    ).toThrow(/rollback requested/u);
    database.close();

    const telemetry = lines.filter((line) => line.includes("sqlite-telemetry"));
    expect(telemetry.some((line) => line.includes('mode="immediate"'))).toBe(
      true,
    );
    expect(telemetry.some((line) => line.includes('outcome="committed"'))).toBe(
      true,
    );
    expect(telemetry.some((line) => line.includes('mode="exclusive"'))).toBe(
      true,
    );
    expect(
      telemetry.some((line) => line.includes('outcome="rolled-back"')),
    ).toBe(true);
    expect(telemetry.join("\n")).not.toContain(secret);
    expect(telemetry.join("\n")).not.toContain("INSERT INTO");
  });

  it("observes real SQLITE_BUSY contention with a fixed operation label", () => {
    const root = makeRoot();
    const databaseFile = path.join(root, "contention.db");
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((line) => {
      warnings.push(String(line));
    });
    const first = new Database(databaseFile, { timeout: 0 });
    const second = new Database(databaseFile, {
      fileMustExist: true,
      timeout: 0,
    });
    try {
      first.exec("CREATE TABLE records (id INTEGER NOT NULL PRIMARY KEY)");
      first.exec("BEGIN IMMEDIATE");
      expect(() =>
        second.prepare("INSERT INTO records (id) VALUES (1)").run(),
      ).toThrow();
      first.exec("ROLLBACK");
    } finally {
      if (first.inTransaction) first.exec("ROLLBACK");
      first.close();
      second.close();
    }
    expect(
      warnings.some(
        (line) =>
          line.includes('event="sqlite-contention"') &&
          line.includes('operation="statement-run"') &&
          line.includes('code="SQLITE_BUSY"'),
      ),
    ).toBe(true);
  });

  it("does not let a failing telemetry sink alter a committed transaction", () => {
    vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("telemetry sink unavailable");
    });
    const database = new Database();
    database.exec("CREATE TABLE records (id INTEGER NOT NULL PRIMARY KEY)");
    expect(() =>
      database
        .transaction(() => {
          database.prepare("INSERT INTO records (id) VALUES (1)").run();
        })
        .immediate(),
    ).not.toThrow();
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM records").get(),
    ).toEqual({ count: 1 });
    database.close();
  });

  it("drops arbitrary fields and bounds numeric telemetry values", () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line) => {
      lines.push(String(line));
    });
    recordSqliteOperationalEvent({
      event: "backup",
      outcome: "published",
      snapshotDurationMs: Number.POSITIVE_INFINITY,
      totalDurationMs: -1,
      concurrentWritesObserved: true,
      backupBytes: Number.MAX_VALUE,
      walBytes: 12,
      arbitraryPath: "C:\\private\\tenant\\database.db",
    } as never);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("snapshotDurationMs=0");
    expect(lines[0]).toContain("totalDurationMs=0");
    expect(lines[0]).not.toContain("arbitraryPath");
    expect(lines[0]).not.toContain("private");
  });
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "superior-telemetry-"));
  roots.push(root);
  return root;
}
