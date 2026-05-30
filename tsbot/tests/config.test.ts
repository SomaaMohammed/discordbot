import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../src/config.js";

const CONFIG_ENV_KEYS = [
  "ANON_ALLOW_LINKS",
  "ANON_COOLDOWN_SECONDS",
  "ANON_MIN_ACCOUNT_AGE_MINUTES",
  "ANON_MIN_MEMBER_AGE_MINUTES",
  "ANON_REQUIRED_ROLE_ID",
  "BOT_VERSION",
  "COURT_CHANNEL_ID",
  "DB_FILE",
  "DISCORD_TOKEN",
  "EMPEROR_ROLE_ID",
  "EMPRESS_ROLE_ID",
  "LOG_CHANNEL_ID",
  "MUTEALL_TARGET_CAP",
  "ROYAL_ALERT_CHANNEL_ID",
  "SILENT_LOCK_EXCLUDE_ROLES",
  "STAFF_ROLE_IDS",
  "TEST_GUILD_ID",
  "TIMEZONE",
  "UNDEFEATED_USER_ID",
  "WEEKLY_DIGEST_CHANNEL_ID",
  "WEEKLY_DIGEST_HOUR",
  "WEEKLY_DIGEST_WEEKDAY",
] as const;

const originalEnv = { ...process.env };
const tempRepoRoots: string[] = [];

function resetConfigEnv(): void {
  for (const key of CONFIG_ENV_KEYS) {
    delete process.env[key];
  }
  delete process.env.npm_package_version;
}

function writeEnvFile(repoRoot: string, lines: string[]): void {
  fs.writeFileSync(path.join(repoRoot, ".env"), `${lines.join("\n")}\n`);
}

function makeRepoRoot(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "imperial-config-"));
  tempRepoRoots.push(repoRoot);
  return repoRoot;
}

beforeEach(() => {
  resetConfigEnv();
});

afterEach(() => {
  process.env = { ...originalEnv };
  for (const repoRoot of tempRepoRoots.splice(0)) {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

describe("runtime config", () => {
  it("loads required env and resolves relative database paths", () => {
    const repoRoot = makeRepoRoot();
    writeEnvFile(repoRoot, [
      "DISCORD_TOKEN=test-token",
      "TEST_GUILD_ID=123456789012345678",
      "COURT_CHANNEL_ID=234567890123456789",
      "DB_FILE=data/court.db",
      "STAFF_ROLE_IDS=111, 222",
      "ANON_ALLOW_LINKS=yes",
    ]);

    const config = loadRuntimeConfig(repoRoot);

    expect(config.discordToken).toBe("test-token");
    expect(config.testGuildIdText).toBe("123456789012345678");
    expect(config.courtChannelIdText).toBe("234567890123456789");
    expect(config.dbFile).toBe(path.join(repoRoot, "data/court.db"));
    expect([...config.staffRoleIdsText]).toEqual(["111", "222"]);
    expect(config.anonAllowLinks).toBe(true);
  });

  it("rejects malformed integer values instead of partially parsing them", () => {
    const repoRoot = makeRepoRoot();
    writeEnvFile(repoRoot, [
      "DISCORD_TOKEN=test-token",
      "TEST_GUILD_ID=123456789012345678",
      "COURT_CHANNEL_ID=234567890123456789",
      "ANON_COOLDOWN_SECONDS=12seconds",
    ]);

    expect(() => loadRuntimeConfig(repoRoot)).toThrow(
      "ANON_COOLDOWN_SECONDS must be an integer in .env",
    );
  });
});
