import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rotateBackups } from "../src/storage/backup-rotation.js";
import { BotStorage } from "../src/storage/db.js";
import { validateDatabaseFile } from "../src/storage/migration.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("validated backup rotation", () => {
  it("restores every backup and retains the newest explicit records", async () => {
    const fixture = makeFixture();
    const unknownFile = path.join(
      fixture.backupDirectory,
      "operator-notes.txt",
    );
    fs.writeFileSync(unknownFile, "preserve me", "utf8");
    const first = await rotate(fixture, 1, "1");
    const second = await rotate(fixture, 2, "2");
    const third = await rotate(fixture, 3, "3");

    expect(first.restoredGuildRows).toBe(1);
    expect(second.restoredGuildRows).toBe(1);
    expect(third.restoredGuildRows).toBe(1);
    expect(third.retainedBackupNames).toHaveLength(2);
    expect(third.deletedBackupNames).toEqual([first.currentBackupName]);
    expect(fs.existsSync(unknownFile)).toBe(true);
    expect(
      fs.existsSync(
        path.join(fixture.backupDirectory, first.currentBackupName),
      ),
    ).toBe(false);
    for (const name of third.retainedBackupNames) {
      expect(() =>
        validateDatabaseFile(path.join(fixture.backupDirectory, name), {
          expect: 11,
        }),
      ).not.toThrow();
      expect(
        fs.existsSync(
          path.join(fixture.backupDirectory, `${name}.backup.json`),
        ),
      ).toBe(true);
    }
    expect(
      fs
        .readdirSync(fixture.backupDirectory)
        .some((name) => name.includes(".partial")),
    ).toBe(false);
  });

  it("plans retention without writing and never overwrites an existing backup", async () => {
    const fixture = makeFixture();
    const created = await rotate(fixture, 1, "a");
    const before = fs.readdirSync(fixture.backupDirectory).sort();

    const dryRun = await rotateBackups({
      ...fixture,
      retention: 1,
      dryRun: true,
      now: () => new Date("2026-01-02T00:00:00.000Z"),
      idFactory: () => "b".repeat(32),
    });
    expect(dryRun.status).toBe("dry-run");
    expect(dryRun.wouldDeleteBackupNames).toEqual([created.currentBackupName]);
    expect(fs.readdirSync(fixture.backupDirectory).sort()).toEqual(before);

    await expect(
      rotateBackups({
        ...fixture,
        retention: 1,
        now: () => new Date("2026-01-01T00:00:01.000Z"),
        idFactory: () => "a".repeat(32),
      }),
    ).rejects.toThrow(/already exists/u);
    expect(fs.readdirSync(fixture.backupDirectory).sort()).toEqual(before);
  });

  it("fails closed on managed-looking artifacts without validated metadata", async () => {
    const fixture = makeFixture();
    const malformed = path.join(
      fixture.backupDirectory,
      `superior-backup-v11-20260101T000000000Z-${"c".repeat(32)}.sqlite3`,
    );
    fs.writeFileSync(malformed, "not a managed database", "utf8");

    await expect(rotate(fixture, 1, "d")).rejects.toThrow(
      /no validated metadata/u,
    );
    expect(fs.readFileSync(malformed, "utf8")).toBe("not a managed database");
  });

  it("rejects a configured backup directory that is a reparse point", async () => {
    const fixture = makeFixture();
    const realDirectory = path.join(fixture.root, "real rotation directory");
    const redirected = path.join(fixture.root, "redirected rotation directory");
    fs.mkdirSync(realDirectory);
    fs.symlinkSync(
      realDirectory,
      redirected,
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      rotateBackups({
        dbFile: fixture.dbFile,
        backupDirectory: redirected,
        retention: 2,
      }),
    ).rejects.toThrow(/reparse point/u);
    expect(fs.readdirSync(realDirectory)).toEqual([]);
  });

  it("never treats an aliased source database as a retention candidate", async () => {
    const fixture = makeFixture();
    const first = await rotate(fixture, 1, "e");
    const alias = path.join(fixture.root, "backup directory alias");
    fs.symlinkSync(
      fixture.backupDirectory,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const aliasedSource = path.join(alias, first.currentBackupName);
    const before = fs.readdirSync(fixture.backupDirectory).sort();

    await expect(
      rotateBackups({
        dbFile: aliasedSource,
        backupDirectory: fixture.backupDirectory,
        retention: 1,
        now: () => new Date("2026-01-01T00:00:02.000Z"),
        idFactory: () => "f".repeat(32),
      }),
    ).rejects.toThrow(/source database must never be a retention candidate/iu);

    expect(fs.existsSync(aliasedSource)).toBe(true);
    expect(fs.readdirSync(fixture.backupDirectory).sort()).toEqual(before);
    expect(() =>
      validateDatabaseFile(aliasedSource, { expect: 11 }),
    ).not.toThrow();
  });
});

function makeFixture(): {
  root: string;
  dbFile: string;
  backupDirectory: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "superior-rotation-"));
  roots.push(root);
  const dbFile = path.join(root, "superior.db");
  const backupDirectory = path.join(root, "backups");
  fs.mkdirSync(backupDirectory);
  const storage = new BotStorage({ dbFile });
  storage.initStorage();
  storage.ensureGuild("111111111111111111");
  storage.close();
  return { root, dbFile, backupDirectory };
}

function rotate(
  fixture: ReturnType<typeof makeFixture>,
  second: number,
  idCharacter: string,
) {
  return rotateBackups({
    ...fixture,
    retention: 2,
    now: () => new Date(`2026-01-01T00:00:0${second}.000Z`),
    idFactory: () => idCharacter.repeat(32),
  });
}
