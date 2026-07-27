import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDatabaseConfig, loadProcessConfig } from "../src/config.js";
import { loadLegacyMigrationConfig } from "../src/storage/legacy-v1-settings.js";

const CONFIG_ENV_KEYS = [
  "BOT_OPERATOR_USER_IDS",
  "BOT_VERSION",
  "COMMAND_REGISTRATION_MODE",
  "COURT_CHANNEL_ID",
  "DB_FILE",
  "DEV_GUILD_IDS",
  "DISCORD_TOKEN",
  "ENV_FILE",
  "LEGACY_GUILD_ID",
  "SCHEDULER_CONCURRENCY",
  "TEST_GUILD_ID",
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

beforeEach(resetConfigEnv);

afterEach(() => {
  process.env = { ...originalEnv };
  for (const repoRoot of tempRepoRoots.splice(0)) {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

describe("process config", () => {
  it("requires only the token and defaults command registration to global", () => {
    const repoRoot = makeRepoRoot();
    writeEnvFile(repoRoot, [
      "DISCORD_TOKEN=test-token",
      "DB_FILE=data/court.db",
    ]);

    const config = loadProcessConfig(repoRoot);

    expect(config.discordToken).toBe("test-token");
    expect(config.commandRegistrationMode).toBe("global");
    expect(config.devGuildIds).toEqual([]);
    expect(config.dbFile).toBe(path.join(repoRoot, "data/court.db"));
    expect(config.schedulerConcurrency).toBe(4);
    expect("testGuildId" in config).toBe(false);
    expect("courtChannelId" in config).toBe(false);
  });

  it("validates every development guild and operator snowflake", () => {
    const repoRoot = makeRepoRoot();
    writeEnvFile(repoRoot, [
      "DISCORD_TOKEN=test-token",
      "COMMAND_REGISTRATION_MODE=guild",
      "DEV_GUILD_IDS=111111111111111111,222222222222222222,111111111111111111",
      "BOT_OPERATOR_USER_IDS=333333333333333333",
      "SCHEDULER_CONCURRENCY=8",
    ]);

    const config = loadProcessConfig(repoRoot);

    expect(config.devGuildIds).toEqual([
      "111111111111111111",
      "222222222222222222",
    ]);
    expect(config.botOperatorUserIds).toEqual(["333333333333333333"]);
    expect(config.schedulerConcurrency).toBe(8);
  });

  it("rejects guild registration without development guilds", () => {
    const repoRoot = makeRepoRoot();
    writeEnvFile(repoRoot, [
      "DISCORD_TOKEN=test-token",
      "COMMAND_REGISTRATION_MODE=guild",
    ]);
    expect(() => loadProcessConfig(repoRoot)).toThrow("DEV_GUILD_IDS");
  });

  it("rejects malformed snowflakes and integer values", () => {
    const repoRoot = makeRepoRoot();
    writeEnvFile(repoRoot, [
      "DISCORD_TOKEN=test-token",
      "DEV_GUILD_IDS=not-a-snowflake",
    ]);
    expect(() => loadProcessConfig(repoRoot)).toThrow("DEV_GUILD_IDS");

    delete process.env.DEV_GUILD_IDS;
    writeEnvFile(repoRoot, [
      "DISCORD_TOKEN=test-token",
      "SCHEDULER_CONCURRENCY=4workers",
    ]);
    expect(() => loadProcessConfig(repoRoot)).toThrow(
      "SCHEDULER_CONCURRENCY must be an integer",
    );
  });

  it("loads database-only configuration without a Discord token", () => {
    const repoRoot = makeRepoRoot();
    writeEnvFile(repoRoot, ["DB_FILE=temporary.sqlite"]);
    expect(loadDatabaseConfig(repoRoot).dbFile).toBe(
      path.join(repoRoot, "temporary.sqlite"),
    );
  });

  it("loads a custom ENV_FILE relative to the repository root", () => {
    const repoRoot = makeRepoRoot();
    const configDirectory = path.join(repoRoot, "config");
    fs.mkdirSync(configDirectory);
    fs.writeFileSync(
      path.join(configDirectory, "production.env"),
      [
        "DISCORD_TOKEN=custom-file-token",
        "DB_FILE=data/custom.sqlite",
        "LEGACY_GUILD_ID=222222222222222222",
        "COURT_CHANNEL_ID=333333333333333333",
      ].join("\n"),
    );
    process.env.ENV_FILE = "config/production.env";

    expect(loadProcessConfig(repoRoot)).toMatchObject({
      discordToken: "custom-file-token",
      dbFile: path.join(repoRoot, "data/custom.sqlite"),
    });
    expect(loadLegacyMigrationConfig(repoRoot)).toMatchObject({
      legacyGuildId: "222222222222222222",
      environment: expect.objectContaining({
        COURT_CHANNEL_ID: "333333333333333333",
      }),
    });
  });

  it("does not allow ENV_FILE inside dotenv to redirect later loads", () => {
    const repoRoot = makeRepoRoot();
    writeEnvFile(repoRoot, [
      "DISCORD_TOKEN=selected-token",
      "ENV_FILE=redirected.env",
    ]);
    fs.writeFileSync(
      path.join(repoRoot, "redirected.env"),
      "DISCORD_TOKEN=redirected-token\n",
    );

    expect(loadProcessConfig(repoRoot).discordToken).toBe("selected-token");
    expect(process.env.ENV_FILE).toBeUndefined();
    expect(loadProcessConfig(repoRoot).discordToken).toBe("selected-token");
  });

  it("uses TEST_GUILD_ID only as a deprecated migration fallback", () => {
    const fallbackRoot = makeRepoRoot();
    writeEnvFile(fallbackRoot, ["TEST_GUILD_ID=111111111111111111"]);
    expect(loadLegacyMigrationConfig(fallbackRoot)).toMatchObject({
      legacyGuildId: "111111111111111111",
      legacyGuildIdSource: "TEST_GUILD_ID",
    });

    delete process.env.TEST_GUILD_ID;
    const explicitRoot = makeRepoRoot();
    writeEnvFile(explicitRoot, [
      "TEST_GUILD_ID=111111111111111111",
      "LEGACY_GUILD_ID=222222222222222222",
    ]);
    expect(loadLegacyMigrationConfig(explicitRoot)).toMatchObject({
      legacyGuildId: "222222222222222222",
      legacyGuildIdSource: "LEGACY_GUILD_ID",
    });
  });
});
