import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BotStorage } from "../src/storage/db.js";
import { doctorExitCode, runDoctor } from "../src/storage/doctor.js";

const roots: string[] = [];

afterEach(() => {
  delete process.env.SUPERIOR_DATABASE_LOCK_HELD;
  delete process.env.SUPERIOR_PAYLOAD_ROOT;
  delete process.env.SUPERIOR_EXECUTABLE_PATH;
  delete process.env.SUPERIOR_PAYLOAD_VERSION;
  delete process.env.SUPERIOR_EXECUTABLE_VERSION;
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("offline database doctor", () => {
  it("reports stable checks without creating probe artifacts by default", () => {
    const fixture = makeFixture();
    const before = fs.readdirSync(fixture.backupDirectory);

    const report = runDoctor({
      applicationRoot: fixture.root,
      dbFile: fixture.dbFile,
      backupDirectory: fixture.backupDirectory,
    });

    expect(report.reportVersion).toBe(1);
    expect(report.command).toBe("doctor");
    expect(report.sqliteBackend).toBe("bun:sqlite");
    expect(report.manifest.requiredEnvironmentVariables).toEqual([
      "DISCORD_TOKEN",
    ]);
    expect(report.manifest.machineSpecificValuesIncluded).toBe(false);
    expect(report.manifest.databasePath).toBe(fixture.dbFile);
    expect(report.manifest.databaseSchema).toBe(11);
    expect(report.manifest.releaseIdentity).toMatch(/^[a-f0-9]{64}$/u);
    expect(check(report, "database-health").status).toBe("pass");
    expect(check(report, "database-lock").status).toBe("skipped");
    expect(check(report, "backup-hard-link").status).toBe("skipped");
    expect(check(report, "release-layout").status).toBe("skipped");
    expect(report.status).toBe("degraded");
    expect(doctorExitCode(report)).toBe(0);
    expect(fs.readdirSync(fixture.backupDirectory)).toEqual(before);
  });

  it("performs and cleans explicitly requested lock and hard-link probes", () => {
    const fixture = makeFixture();

    const report = runDoctor({
      applicationRoot: fixture.root,
      dbFile: fixture.dbFile,
      backupDirectory: fixture.backupDirectory,
      writeProbes: true,
    });

    expect(check(report, "database-lock").status).toBe("pass");
    expect(check(report, "backup-hard-link").status).toBe("pass");
    expect(fs.readdirSync(fixture.backupDirectory)).toEqual([]);
    expect(doctorExitCode(report)).toBe(0);
  });

  it("returns a meaningful failure for a missing database", () => {
    const root = makeRoot();
    const backupDirectory = path.join(root, "backups");
    fs.mkdirSync(backupDirectory);
    fs.writeFileSync(path.join(root, ".env"), "# doctor fixture\n", {
      encoding: "utf8",
      mode: 0o600,
    });

    const report = runDoctor({
      applicationRoot: root,
      dbFile: path.join(root, "missing.db"),
      backupDirectory,
    });

    expect(check(report, "database-file").status).toBe("fail");
    expect(report.status).toBe("failed");
    expect(doctorExitCode(report)).toBe(1);
  });

  it("reports a reparse-point backup directory as unsafe", () => {
    const fixture = makeFixture();
    const realDirectory = path.join(fixture.root, "real doctor backup");
    const redirected = path.join(fixture.root, "redirected doctor backup");
    fs.mkdirSync(realDirectory);
    fs.symlinkSync(
      realDirectory,
      redirected,
      process.platform === "win32" ? "junction" : "dir",
    );

    const report = runDoctor({
      applicationRoot: fixture.root,
      dbFile: fixture.dbFile,
      backupDirectory: redirected,
    });
    expect(check(report, "backup-directory").status).toBe("fail");
    expect(report.status).toBe("failed");
  });
});

function makeFixture(): {
  root: string;
  dbFile: string;
  backupDirectory: string;
} {
  const root = makeRoot();
  const dbFile = path.join(root, "superior.db");
  const backupDirectory = path.join(root, "backups");
  fs.mkdirSync(backupDirectory);
  fs.writeFileSync(path.join(root, ".env"), "# doctor fixture\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  const storage = new BotStorage({ dbFile });
  storage.initStorage();
  storage.ensureGuild("111111111111111111");
  storage.close();
  return { root, dbFile, backupDirectory };
}

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "superior-doctor-"));
  roots.push(root);
  return root;
}

function check(
  report: ReturnType<typeof runDoctor>,
  id: string,
): ReturnType<typeof runDoctor>["checks"][number] {
  const value = report.checks.find((candidate) => candidate.id === id);
  if (!value) throw new Error(`Missing doctor check: ${id}`);
  return value;
}
