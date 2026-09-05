import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import Database from "../src/storage/database.js";
import { BotStorage } from "../src/storage/db.js";

const roots: string[] = [];
const tsbotRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("source operator commands", () => {
  it("emits stable doctor JSON and human output without a Discord login", () => {
    const fixture = makeFixture();
    const arguments_ = [
      "--root",
      fixture.root,
      "--db",
      fixture.dbFile,
      "--backup-dir",
      fixture.backupDirectory,
    ];
    const json = run("src/storage/doctor-cli.ts", [...arguments_, "--json"]);
    expect(json.status, json.stderr).toBe(0);
    expect(lastJson(json.stdout)).toMatchObject({
      reportVersion: 1,
      command: "doctor",
      status: "degraded",
      sqliteBackend: "bun:sqlite",
    });
    expect(json.stdout).toContain(
      '"requiredEnvironmentVariables":["DISCORD_TOKEN"]',
    );
    expect(json.stdout).not.toContain("offline-test-token");

    const human = run("src/storage/doctor-cli.ts", arguments_);
    expect(human.status, human.stderr).toBe(0);
    expect(human.stdout).toContain("Superior doctor: degraded");
    expect(human.stdout).toContain("[PASS] database-health");
  });

  it("runs explicit checkpoint and backup-rotation commands", () => {
    const fixture = makeFixture();
    const checkpoint = run("src/storage/checkpoint-cli.ts", [
      "--db",
      fixture.dbFile,
      "--mode",
      "truncate",
      "--json",
    ]);
    expect(checkpoint.status, checkpoint.stderr).toBe(0);
    expect(lastJson(checkpoint.stdout)).toMatchObject({
      command: "db:checkpoint",
      status: "completed",
      mode: "truncate",
      busyFrames: 0,
    });

    const rotation = run("src/storage/backup-rotation-cli.ts", [
      "--db",
      fixture.dbFile,
      "--backup-dir",
      fixture.backupDirectory,
      "--retention",
      "2",
      "--json",
    ]);
    expect(rotation.status, rotation.stderr).toBe(0);
    const result = lastJson(rotation.stdout) as {
      command: string;
      status: string;
      restoredGuildRows: number;
    };
    expect(result).toMatchObject({
      command: "backup-rotate",
      status: "completed",
      restoredGuildRows: 1,
    });
  });

  it("returns nonzero with structured output for invalid rotation policy", () => {
    const fixture = makeFixture();
    const result = run("src/storage/backup-rotation-cli.ts", [
      "--db",
      fixture.dbFile,
      "--backup-dir",
      fixture.backupDirectory,
      "--retention",
      "0",
      "--json",
    ]);
    expect(result.status).toBe(1);
    expect(lastJson(result.stderr)).toMatchObject({
      command: "backup-rotate",
      status: "failed",
    });
  });

  it("returns exit 2 when a passive checkpoint leaves pinned WAL frames", () => {
    const fixture = makeFixture();
    const writer = new Database(fixture.dbFile, { fileMustExist: true });
    const reader = new Database(fixture.dbFile, {
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
      reader
        .prepare("SELECT name FROM guilds WHERE guild_id = ?")
        .get("111111111111111111");
      writer
        .prepare(
          "UPDATE guilds SET name = ?, updated_at = ? WHERE guild_id = ?",
        )
        .run(
          "after pinned read",
          "2026-09-01T00:00:01.000Z",
          "111111111111111111",
        );

      const result = run("src/storage/checkpoint-cli.ts", [
        "--db",
        fixture.dbFile,
        "--mode",
        "passive",
        "--json",
      ]);

      expect(result.status, result.stderr).toBe(2);
      const output = lastJson(result.stdout) as {
        status: string;
        logFrames: number;
        checkpointedFrames: number;
      };
      expect(output.status).toBe("busy");
      expect(output.logFrames).toBeGreaterThan(output.checkpointedFrames);
    } finally {
      reader.exec("ROLLBACK");
      reader.close();
      writer.close();
    }
  });
});

function makeFixture(): {
  root: string;
  dbFile: string;
  backupDirectory: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "superior-operator-cli-"));
  roots.push(root);
  const dbFile = path.join(root, "superior.db");
  const backupDirectory = path.join(root, "backups");
  fs.mkdirSync(backupDirectory);
  fs.writeFileSync(path.join(root, ".env"), "# offline operator fixture\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  const storage = new BotStorage({ dbFile });
  storage.initStorage();
  storage.ensureGuild("111111111111111111");
  storage.close();
  return { root, dbFile, backupDirectory };
}

function run(
  relativeScript: string,
  arguments_: string[],
): { status: number | null; stdout: string; stderr: string } {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        ![
          "DB_FILE",
          "ENV_FILE",
          "SUPERIOR_APPLICATION_ROOT",
          "SUPERIOR_BACKUP_DIR",
          "SUPERIOR_PAYLOAD_ROOT",
        ].includes(key),
    ),
  );
  const result = spawnSync(
    process.execPath,
    ["--no-env-file", path.join(tsbotRoot, relativeScript), ...arguments_],
    {
      cwd: tsbotRoot,
      encoding: "utf8",
      env: environment,
      timeout: 30_000,
    },
  );
  return {
    status: result.status,
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
}

function lastJson(output: string): unknown {
  const line = output
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) throw new Error("Operator command produced no JSON output");
  return JSON.parse(line) as unknown;
}
