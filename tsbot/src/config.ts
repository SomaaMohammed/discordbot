import { config as loadDotEnv } from "dotenv";
import path from "node:path";
import {
  DEFAULT_SILENT_LOCK_EXCLUDE_ROLES,
  DEFAULT_STAFF_ROLE_IDS,
  PACKAGE_VERSION,
} from "./constants.js";
import type { RuntimeConfig } from "./types.js";

function envInt(name: string, defaultValue = 0): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return defaultValue;
  }

  const normalized = raw.trim();
  if (!normalized) {
    return defaultValue;
  }

  const parsed = Number.parseInt(normalized, 10);
  if (Number.isNaN(parsed)) {
    throw new TypeError(`${name} must be an integer in .env`);
  }
  return parsed;
}

function envSnowflake(name: string, defaultValue = ""): string {
  const raw = process.env[name];
  if (raw === undefined) {
    return defaultValue;
  }

  const normalized = raw.trim();
  if (!normalized) {
    return defaultValue;
  }

  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${name} must be a Discord snowflake in .env`);
  }

  return normalized;
}

function envBool(name: string, defaultValue = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) {
    return defaultValue;
  }

  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`${name} must be a boolean-like value in .env`);
}

function envSnowflakeSet(name: string, defaultValue: Set<string>): Set<string> {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return new Set<string>(defaultValue);
  }

  const values = new Set<string>();
  for (const token of raw.split(",")) {
    const stripped = token.trim();
    if (!stripped) {
      continue;
    }

    if (!/^\d+$/.test(stripped)) {
      throw new Error(
        `${name} must be a comma-separated list of Discord snowflakes`,
      );
    }

    values.add(stripped);
  }

  return values;
}

export function loadRuntimeConfig(repoRoot: string): RuntimeConfig {
  loadDotEnv({ path: path.join(repoRoot, ".env") });

  const discordToken = String(process.env.DISCORD_TOKEN ?? "").trim();
  const testGuildIdText = envSnowflake("TEST_GUILD_ID");
  const courtChannelIdText = envSnowflake("COURT_CHANNEL_ID");
  const logChannelIdText = envSnowflake("LOG_CHANNEL_ID", "");
  const emperorRoleIdText = envSnowflake(
    "EMPEROR_ROLE_ID",
    "1461376227095875707",
  );
  const empressRoleIdText = envSnowflake(
    "EMPRESS_ROLE_ID",
    "1461485629178122465",
  );
  const royalAlertChannelIdText = envSnowflake(
    "ROYAL_ALERT_CHANNEL_ID",
    "1461374216795328515",
  );
  const undefeatedUserIdText = envSnowflake(
    "UNDEFEATED_USER_ID",
    "934478657114742874",
  );
  const anonRequiredRoleIdText = envSnowflake("ANON_REQUIRED_ROLE_ID", "");
  const weeklyDigestChannelIdText = envSnowflake(
    "WEEKLY_DIGEST_CHANNEL_ID",
    "",
  );
  const defaultStaffRoleIdsText = new Set<string>(DEFAULT_STAFF_ROLE_IDS);
  const staffRoleIdsText = envSnowflakeSet(
    "STAFF_ROLE_IDS",
    defaultStaffRoleIdsText,
  );

  const testGuildId = envInt("TEST_GUILD_ID", 0);
  const courtChannelId = envInt("COURT_CHANNEL_ID", 0);

  if (!discordToken) {
    throw new Error("DISCORD_TOKEN is missing in .env");
  }
  if (!testGuildId || !testGuildIdText) {
    throw new Error("TEST_GUILD_ID is missing in .env");
  }
  if (!courtChannelId || !courtChannelIdText) {
    throw new Error("COURT_CHANNEL_ID is missing in .env");
  }

  const packageVersion = String(
    process.env.npm_package_version ?? PACKAGE_VERSION,
  );
  const botVersion =
    String(process.env.BOT_VERSION ?? packageVersion).trim() || packageVersion;

  const dbFileEnv =
    String(process.env.DB_FILE ?? "court.db").trim() || "court.db";
  const dbFile = path.isAbsolute(dbFileEnv)
    ? dbFileEnv
    : path.join(repoRoot, dbFileEnv);

  return {
    discordToken,
    botVersion,
    testGuildId,
    testGuildIdText,
    courtChannelId,
    courtChannelIdText,
    logChannelId: envInt("LOG_CHANNEL_ID", 0),
    logChannelIdText,
    timezoneName: String(process.env.TIMEZONE ?? "Asia/Qatar"),
    staffRoleIds: new Set<string>(staffRoleIdsText),
    staffRoleIdsText,
    emperorRoleId: Number.parseInt(emperorRoleIdText, 10),
    emperorRoleIdText,
    empressRoleId: Number.parseInt(empressRoleIdText, 10),
    empressRoleIdText,
    silentLockExcludeRoles: envSnowflakeSet(
      "SILENT_LOCK_EXCLUDE_ROLES",
      DEFAULT_SILENT_LOCK_EXCLUDE_ROLES,
    ),
    royalAlertChannelId: Number.parseInt(royalAlertChannelIdText, 10),
    royalAlertChannelIdText,
    undefeatedUserId: Number.parseInt(undefeatedUserIdText, 10),
    undefeatedUserIdText,
    anonMinAccountAgeMinutes: Math.max(
      0,
      envInt("ANON_MIN_ACCOUNT_AGE_MINUTES", 0),
    ),
    anonMinMemberAgeMinutes: Math.max(
      0,
      envInt("ANON_MIN_MEMBER_AGE_MINUTES", 0),
    ),
    anonRequiredRoleId: Math.max(0, envInt("ANON_REQUIRED_ROLE_ID", 0)),
    anonRequiredRoleIdText,
    anonCooldownSeconds: Math.max(0, envInt("ANON_COOLDOWN_SECONDS", 0)),
    anonAllowLinks: envBool("ANON_ALLOW_LINKS", false),
    muteallTargetCap: Math.max(0, envInt("MUTEALL_TARGET_CAP", 0)),
    weeklyDigestChannelId: Math.max(0, envInt("WEEKLY_DIGEST_CHANNEL_ID", 0)),
    weeklyDigestChannelIdText,
    weeklyDigestWeekday: Math.min(
      6,
      Math.max(0, envInt("WEEKLY_DIGEST_WEEKDAY", 0)),
    ),
    weeklyDigestHour: Math.min(
      23,
      Math.max(0, envInt("WEEKLY_DIGEST_HOUR", 19)),
    ),
    answerRetentionDays: Math.max(1, envInt("ANSWER_RETENTION_DAYS", 90)),
    dbFile,
  };
}
