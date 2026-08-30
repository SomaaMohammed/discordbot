import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadProcessConfig,
  resolveApplicationRoot,
  resolveDatabaseFile,
  resolveEnvironmentFile,
} from "../src/config.js";
import { PACKAGE_VERSION } from "../src/constants.js";

const ENV_KEYS = [
  "BOT_VERSION",
  "BOT_OPERATOR_IDS",
  "COMMAND_REGISTRATION_MODE",
  "DB_FILE",
  "DEV_GUILD_IDS",
  "DISCORD_TOKEN",
  "ENV_FILE",
  "SUPERIOR_APPLICATION_ROOT",
  "npm_package_version",
] as const;

let environmentSnapshot: Record<string, string | undefined>;
const temporaryRoots: string[] = [];

beforeEach(() => {
  environmentSnapshot = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = environmentSnapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("configuration", () => {
  it("uses an explicit application root for a self-extracting launcher", () => {
    const defaultRoot = makeRoot();
    const standaloneRoot = path.join(defaultRoot, "standalone-data");
    process.env.SUPERIOR_APPLICATION_ROOT = standaloneRoot;

    expect(resolveApplicationRoot(defaultRoot)).toBe(standaloneRoot);
  });

  it("defaults fresh installs to superior.db", () => {
    const root = makeRoot();
    expect(resolveDatabaseFile(root)).toBe(path.join(root, "superior.db"));
  });

  it("fails closed when an implicit new default could strand a v4 database", () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, "court.db"), "synthetic sentinel");
    expect(() => resolveDatabaseFile(root)).toThrow(/DB_FILE must be set/);

    process.env.DB_FILE = "explicit.db";
    expect(resolveDatabaseFile(root)).toBe(path.join(root, "explicit.db"));
  });

  it("resolves explicit database and environment paths", () => {
    const root = makeRoot();
    process.env.DB_FILE = path.join(root, "data", "bot.db");
    process.env.ENV_FILE = "config/operator.env";
    expect(resolveDatabaseFile(root)).toBe(path.join(root, "data", "bot.db"));
    expect(resolveEnvironmentFile(root)).toBe(
      path.join(root, "config", "operator.env"),
    );
  });

  it("loads only active process configuration", () => {
    const root = makeRoot();
    fs.writeFileSync(
      path.join(root, ".env"),
      [
        "DISCORD_TOKEN=synthetic-token",
        "COMMAND_REGISTRATION_MODE=guild",
        "DEV_GUILD_IDS=111111111111111111,222222222222222222",
        "BOT_OPERATOR_IDS=333333333333333333,333333333333333333",
        "DB_FILE=synthetic.db",
      ].join("\n"),
    );
    const config = loadProcessConfig(root);
    expect(config).toMatchObject({
      discordToken: "synthetic-token",
      commandRegistrationMode: "guild",
      devGuildIds: ["111111111111111111", "222222222222222222"],
      operatorIds: ["333333333333333333"],
      dbFile: path.join(root, "synthetic.db"),
    });
    expect(config).not.toHaveProperty("schedulerConcurrency");
    expect(config).not.toHaveProperty("botOperatorUserIds");
  });

  it("does not allow environment variables to falsify build identity", () => {
    const root = makeRoot();
    fs.writeFileSync(
      path.join(root, ".env"),
      "DISCORD_TOKEN=synthetic-token\nBOT_VERSION=99.0.0\n",
    );
    process.env.npm_package_version = "98.0.0";

    const config = loadProcessConfig(root);
    expect(config.botVersion).toBe(PACKAGE_VERSION);
  });
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "superior-config-"));
  temporaryRoots.push(root);
  return root;
}
