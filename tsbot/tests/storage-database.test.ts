import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "../src/storage/database.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("bun:sqlite database contract", () => {
  it("normalizes missing rows and preserves run-result metadata", () => {
    const db = new Database();
    try {
      db.exec(
        "CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
      );
      const insert = db.prepare("INSERT INTO items (value) VALUES (?)");
      const inserted = insert.run("first");
      expect(inserted).toMatchObject({ changes: 1, lastInsertRowid: 1 });
      expect(
        db.prepare("SELECT id, value FROM items WHERE id = ?").get(1),
      ).toEqual({ id: 1, value: "first" });
      expect(
        db.prepare("SELECT id FROM items WHERE id = ?").get(999),
      ).toBeUndefined();
      expect(
        db.prepare("UPDATE items SET value = ? WHERE id = ?").run("second", 1),
      ).toMatchObject({ changes: 1 });
    } finally {
      db.close();
    }
  });

  it("finalizes cached prepared statements when the connection closes", () => {
    const root = makeRoot();
    const databaseFile = path.join(root, "prepared-cleanup.db");
    const db = new Database(databaseFile);
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY)");
    const statements = Array.from({ length: 40 }, (_, index) =>
      db.prepare(`SELECT ${index} AS value`),
    );
    expect(statements[0]!.get()).toEqual({ value: 0 });
    expect(statements[39]!.get()).toEqual({ value: 39 });
    expect(statements[0]!.get()).toEqual({ value: 0 });
    expect(db.open).toBe(true);
    db.close();
    expect(db.open).toBe(false);
    for (const statement of statements) {
      expect(() => statement.all()).toThrow(/closed|finalized/iu);
    }
    expect(() => db.prepare("SELECT 1")).toThrow(/not open/iu);
    expect(() => db.close()).not.toThrow();

    const moved = path.join(root, "prepared-cleanup-moved.db");
    fs.renameSync(databaseFile, moved);
    expect(fs.existsSync(moved)).toBe(true);
  });

  it("applies deferred, immediate, and exclusive locking semantics", () => {
    const root = makeRoot();
    const databaseFile = path.join(root, "transaction modes.db");
    const first = new Database(databaseFile, { timeout: 100 });
    first.pragma("journal_mode = WAL");
    first.exec("CREATE TABLE items (id INTEGER PRIMARY KEY)");
    const second = new Database(databaseFile, {
      fileMustExist: true,
      timeout: 50,
    });
    try {
      const deferred = first.transaction(() => {
        expect(first.inTransaction).toBe(true);
        expect(
          second.prepare("INSERT INTO items DEFAULT VALUES").run(),
        ).toMatchObject({
          changes: 1,
        });
      });
      deferred.deferred();
      expect(first.inTransaction).toBe(false);

      for (const mode of ["immediate", "exclusive"] as const) {
        const locked = first.transaction(() => {
          expect(first.inTransaction).toBe(true);
          expect(() =>
            second.prepare("INSERT INTO items DEFAULT VALUES").run(),
          ).toThrow(/busy|locked/iu);
          expect(
            second.prepare("SELECT COUNT(*) AS count FROM items").get(),
          ).toEqual({
            count: 1,
          });
        });
        locked[mode]();
        expect(first.inTransaction).toBe(false);
      }
    } finally {
      second.close();
      first.close();
    }
  });

  it("supports transaction modes, nested savepoints, and rollback", () => {
    const db = new Database();
    try {
      db.exec("CREATE TABLE events (value TEXT NOT NULL)");
      const insert = db.prepare("INSERT INTO events (value) VALUES (?)");
      const modeTransaction = db.transaction((value: string) =>
        insert.run(value),
      );
      modeTransaction.default("default");
      modeTransaction.deferred("deferred");
      modeTransaction.immediate("immediate");
      modeTransaction.exclusive("exclusive");

      const inner = db.transaction(() => {
        expect(db.inTransaction).toBe(true);
        insert.run("inner-rolled-back");
        throw new Error("rollback savepoint");
      });
      const outer = db.transaction(() => {
        insert.run("outer-before");
        expect(() => inner.immediate()).toThrow("rollback savepoint");
        insert.run("outer-after");
      });
      outer.immediate();

      const uncaught = db.transaction(() => {
        insert.run("outer-rolled-back");
        inner.deferred();
      });
      expect(() => uncaught.exclusive()).toThrow("rollback savepoint");

      expect(
        db.prepare("SELECT value FROM events ORDER BY rowid").all(),
      ).toEqual([
        { value: "default" },
        { value: "deferred" },
        { value: "immediate" },
        { value: "exclusive" },
        { value: "outer-before" },
        { value: "outer-after" },
      ]);
      expect(db.inTransaction).toBe(false);
    } finally {
      db.close();
    }
  });

  it("rejects async transaction callbacks before they escape the boundary", () => {
    const db = new Database();
    try {
      db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY)");
      const transaction = db.transaction(() => {
        db.prepare("INSERT INTO items DEFAULT VALUES").run();
        return Promise.resolve("too late");
      });
      expect(() => transaction.immediate()).toThrow(/must be synchronous/iu);
      expect(db.prepare("SELECT COUNT(*) AS count FROM items").get()).toEqual({
        count: 0,
      });
      expect(() =>
        db.transaction(async () => {
          await Promise.resolve();
        }),
      ).toThrow(/async functions are not supported/iu);
    } finally {
      db.close();
    }
  });

  it("preserves WAL visibility, foreign keys, readonly mode, and missing-file errors", () => {
    const root = makeRoot();
    const databaseFile = path.join(root, "wal and readonly.db");
    const writer = new Database(databaseFile);
    writer.pragma("journal_mode = WAL");
    writer.pragma("foreign_keys = ON");
    writer.exec(
      "CREATE TABLE parents (id INTEGER PRIMARY KEY);" +
        "CREATE TABLE children (parent_id INTEGER NOT NULL REFERENCES parents(id));",
    );
    writer.prepare("INSERT INTO parents (id) VALUES (?)").run(1);

    const reader = new Database(databaseFile, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(writer.pragma("journal_mode")).toEqual([{ journal_mode: "wal" }]);
      expect(writer.pragma("foreign_keys")).toEqual([{ foreign_keys: 1 }]);
      expect(() =>
        writer.prepare("INSERT INTO children (parent_id) VALUES (?)").run(2),
      ).toThrow(/foreign key/iu);
      expect(reader.readonly).toBe(true);
      expect(reader.name).toBe(databaseFile);
      expect(reader.memory).toBe(false);
      expect(
        reader.prepare("SELECT id FROM parents ORDER BY id").all(),
      ).toEqual([{ id: 1 }]);

      writer.prepare("INSERT INTO parents (id) VALUES (?)").run(2);
      expect(
        reader.prepare("SELECT id FROM parents ORDER BY id").all(),
      ).toEqual([{ id: 1 }, { id: 2 }]);
      expect(() =>
        reader.prepare("INSERT INTO parents (id) VALUES (3)").run(),
      ).toThrow(/readonly|read-only/iu);
    } finally {
      reader.close();
      writer.close();
    }

    const missing = path.join(root, "missing.db");
    expect(
      () =>
        new Database(missing, {
          readonly: true,
          fileMustExist: true,
        }),
    ).toThrow(/open|exist/iu);
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("honors busy timeouts and releases locks after rollback", () => {
    const root = makeRoot();
    const databaseFile = path.join(root, "locking.db");
    const holder = new Database(databaseFile);
    holder.exec("CREATE TABLE items (id INTEGER PRIMARY KEY)");
    const contender = new Database(databaseFile, {
      fileMustExist: true,
      timeout: 75,
    });
    try {
      expect(contender.pragma("busy_timeout")).toEqual([{ timeout: 75 }]);
      holder.exec("BEGIN IMMEDIATE");
      holder.prepare("INSERT INTO items DEFAULT VALUES").run();

      const startedAt = performance.now();
      expect(() =>
        contender.prepare("INSERT INTO items DEFAULT VALUES").run(),
      ).toThrow(/busy|locked/iu);
      const elapsed = performance.now() - startedAt;
      expect(elapsed).toBeGreaterThanOrEqual(50);
      expect(elapsed).toBeLessThan(500);

      holder.exec("ROLLBACK");
      expect(
        contender.prepare("INSERT INTO items DEFAULT VALUES").run(),
      ).toMatchObject({ changes: 1 });
    } finally {
      if (holder.inTransaction) holder.exec("ROLLBACK");
      contender.close();
      holder.close();
    }
  });
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "superior-database-"));
  roots.push(root);
  return root;
}
