import { config as loadDotEnv } from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { PACKAGE_VERSION } from "./constants.js";
import { assertDiscordSnowflake } from "./guild-settings.js";
import type { CommandRegistrationMode, ProcessConfig } from "./types.js";

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

export function resolveApplicationRoot(defaultRoot: string): string {
  const configured = String(process.env.SUPERIOR_APPLICATION_ROOT ?? "").trim();
  if (!configured) {
    return defaultRoot;
  }
  return path.isAbsolute(configured)
    ? path.normalize(configured)
    : path.resolve(defaultRoot, configured);
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
  const configured = String(process.env.DB_FILE ?? "").trim();
  if (configured) {
    return path.isAbsolute(configured)
      ? configured
      : path.resolve(repoRoot, configured);
  }

  // This legacy filename is intentionally retained only as an upgrade-safety
  // sentinel. Never silently create a fresh database beside an installation
  // that may still depend on the v4 default.
  const legacyDatabase = path.resolve(repoRoot, "court.db");
  if (fs.existsSync(legacyDatabase)) {
    throw new Error(
      `DB_FILE must be set explicitly because a legacy database exists at ${legacyDatabase}. ` +
        "Do not rename it in place; follow the documented v4-to-v5 migration workflow.",
    );
  }

  return path.resolve(repoRoot, "superior.db");
}

function assertLauncherDatabaseLock(dbFile: string, required: boolean): void {
  const held = process.env.SUPERIOR_DATABASE_LOCK_HELD;
  const lockedPath = process.env.SUPERIOR_DATABASE_LOCK_PATH;
  const heldPresent = held !== undefined && held.trim() !== "";
  const lockedPathPresent =
    lockedPath !== undefined && lockedPath.trim() !== "";
  if (!heldPresent && !lockedPathPresent) {
    if (required) {
      throw new Error(
        "The packaged Bun runtime requires Windows launcher database-lock attestation; refusing to open SQLite.",
      );
    }
    return;
  }
  if (held !== "1" || !lockedPath?.trim()) {
    throw new Error(
      "The launcher database-lock attestation is incomplete; refusing to open SQLite.",
    );
  }
  const resolvedDatabase = path.resolve(dbFile);
  const resolvedLock = path.resolve(lockedPath);
  const matches =
    process.platform === "win32"
      ? resolvedDatabase.toLowerCase() === resolvedLock.toLowerCase()
      : resolvedDatabase === resolvedLock;
  if (!matches) {
    throw new Error(
      "The launcher database lock does not match the configured database; refusing to open SQLite.",
    );
  }
}

export function resolveBackupDirectory(repoRoot: string): string {
  const configured = String(process.env.SUPERIOR_BACKUP_DIR ?? "").trim();
  if (!configured) {
    return path.resolve(repoRoot, "backups");
  }
  return path.isAbsolute(configured)
    ? path.normalize(configured)
    : path.resolve(repoRoot, configured);
}

export function loadDatabaseConfig(
  repoRoot: string,
  options: { requireLauncherLock?: boolean } = {},
): Pick<ProcessConfig, "dbFile"> {
  loadEnvironmentFile(repoRoot);
  const dbFile = resolveDatabaseFile(repoRoot);
  assertLauncherDatabaseLock(dbFile, options.requireLauncherLock === true);
  return { dbFile };
}

export function loadProcessConfig(
  repoRoot: string,
  options: { requireLauncherLock?: boolean } = {},
): ProcessConfig {
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
  const operatorIds = envSnowflakeList("BOT_OPERATOR_IDS");
  if (commandRegistrationMode === "guild" && devGuildIds.length === 0) {
    throw new Error(
      "DEV_GUILD_IDS must contain at least one Discord snowflake when COMMAND_REGISTRATION_MODE=guild",
    );
  }

  const dbFile = resolveDatabaseFile(repoRoot);
  assertLauncherDatabaseLock(dbFile, options.requireLauncherLock === true);

  return {
    discordToken,
    botVersion: PACKAGE_VERSION,
    dbFile,
    commandRegistrationMode,
    devGuildIds,
    operatorIds,
  };
}
