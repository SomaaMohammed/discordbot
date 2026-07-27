import { config as loadDotEnv } from "dotenv";
import path from "node:path";
import { PACKAGE_VERSION } from "./constants.js";
import { assertDiscordSnowflake } from "./guild-settings.js";
import type { CommandRegistrationMode, ProcessConfig } from "./types.js";

function envInt(
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return defaultValue;
  }
  if (!/^-?\d+$/.test(raw.trim())) {
    throw new TypeError(`${name} must be an integer in .env`);
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(
      `${name} must be between ${minimum} and ${maximum} in .env`,
    );
  }
  return parsed;
}

function envSnowflakeList(name: string): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return [];
  }

  const values: string[] = [];
  for (const token of raw.split(",")) {
    const normalized = token.trim();
    if (!normalized) {
      continue;
    }
    values.push(assertDiscordSnowflake(normalized, name));
  }
  return [...new Set(values)];
}

export function loadEnvironmentFile(repoRoot: string): void {
  const bootstrapEnvironmentFile = process.env.ENV_FILE;
  loadDotEnv({ path: resolveEnvironmentFile(repoRoot), quiet: true });
  // ENV_FILE selects the file from the launching environment. Do not allow an
  // entry inside one dotenv file to redirect a later load in the same process.
  if (bootstrapEnvironmentFile === undefined) {
    delete process.env.ENV_FILE;
  } else {
    process.env.ENV_FILE = bootstrapEnvironmentFile;
  }
}

export function resolveEnvironmentFile(repoRoot: string): string {
  const configured = String(process.env.ENV_FILE ?? "").trim();
  if (!configured) {
    return path.join(repoRoot, ".env");
  }
  return path.isAbsolute(configured)
    ? configured
    : path.resolve(repoRoot, configured);
}

export function resolveDatabaseFile(repoRoot: string): string {
  const configured = String(process.env.DB_FILE ?? "court.db").trim();
  const dbFile = configured || "court.db";
  return path.isAbsolute(dbFile) ? dbFile : path.join(repoRoot, dbFile);
}

export function loadDatabaseConfig(
  repoRoot: string,
): Pick<ProcessConfig, "dbFile"> {
  loadEnvironmentFile(repoRoot);
  return { dbFile: resolveDatabaseFile(repoRoot) };
}

export function loadProcessConfig(repoRoot: string): ProcessConfig {
  loadEnvironmentFile(repoRoot);

  const discordToken = String(process.env.DISCORD_TOKEN ?? "").trim();
  if (!discordToken) {
    throw new Error("DISCORD_TOKEN is missing in .env");
  }

  const registrationRaw = String(
    process.env.COMMAND_REGISTRATION_MODE ?? "global",
  )
    .trim()
    .toLowerCase();
  if (registrationRaw !== "global" && registrationRaw !== "guild") {
    throw new Error(
      "COMMAND_REGISTRATION_MODE must be global or guild in .env",
    );
  }
  const commandRegistrationMode: CommandRegistrationMode = registrationRaw;
  const devGuildIds = envSnowflakeList("DEV_GUILD_IDS");
  if (commandRegistrationMode === "guild" && devGuildIds.length === 0) {
    throw new Error(
      "DEV_GUILD_IDS must contain at least one Discord snowflake when COMMAND_REGISTRATION_MODE=guild",
    );
  }

  const packageVersion = String(
    process.env.npm_package_version ?? PACKAGE_VERSION,
  );
  const botVersion =
    String(process.env.BOT_VERSION ?? packageVersion).trim() || packageVersion;

  return {
    discordToken,
    botVersion,
    dbFile: resolveDatabaseFile(repoRoot),
    commandRegistrationMode,
    devGuildIds,
    botOperatorUserIds: envSnowflakeList("BOT_OPERATOR_USER_IDS"),
    schedulerConcurrency: envInt("SCHEDULER_CONCURRENCY", 4, 1, 32),
  };
}
