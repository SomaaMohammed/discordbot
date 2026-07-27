import { loadEnvironmentFile, resolveDatabaseFile } from "../config.js";
import {
  assertDiscordSnowflake,
  createDefaultGuildSettings,
  isDiscordSnowflake,
  sanitizeGuildSettings,
} from "../guild-settings.js";
import { coerceInt } from "../parity.js";
import type { GuildSettings } from "../types.js";

/*
 * These production-specific defaults are intentionally quarantined here. They
 * are used only by the explicit one-time v1 migration and must never seed a
 * newly joined guild or participate in normal v2 runtime behavior.
 */
const LEGACY_DEFAULTS = {
  staffRoles: [
    "1461376227095875707",
    "1461386876475932806",
    "1461485629178122465",
    "1461513633367330982",
    "1461513909130498230",
  ],
  emperorRole: "1461376227095875707",
  empressRole: "1461485629178122465",
  silenceTargetRole: "1461386876475932806",
  silenceExcludeRoles: [
    "1462082750101328029",
    "1461500213746204921",
    "1461382351874424842",
  ],
  royalAlertChannel: "1461374216795328515",
  championUser: "934478657114742874",
  greetings: [
    {
      name: "rio",
      userId: "1206572825100685365",
      message: "Hello {user}. The court sends respect.",
    },
    {
      name: "taylor",
      userId: "661069422869610537",
      message: "Hello {user}. The court sends respect.",
    },
  ],
} as const;

export interface LegacyMigrationConfig {
  dbFile: string;
  legacyGuildId: string | null;
  legacyGuildIdSource: "LEGACY_GUILD_ID" | "TEST_GUILD_ID" | null;
  environment: NodeJS.ProcessEnv;
}

export function loadLegacyMigrationConfig(
  repoRoot: string,
): LegacyMigrationConfig {
  loadEnvironmentFile(repoRoot);

  const explicit = String(process.env.LEGACY_GUILD_ID ?? "").trim();
  const fallback = String(process.env.TEST_GUILD_ID ?? "").trim();
  const rawGuildId = explicit || fallback;
  const source = explicit
    ? "LEGACY_GUILD_ID"
    : fallback
      ? "TEST_GUILD_ID"
      : null;

  return {
    dbFile: resolveDatabaseFile(repoRoot),
    legacyGuildId: rawGuildId
      ? assertDiscordSnowflake(rawGuildId, source ?? "legacy guild ID")
      : null,
    legacyGuildIdSource: source,
    environment: { ...process.env },
  };
}

export function buildLegacyGuildSettings(
  environment: NodeJS.ProcessEnv,
  legacyState: Record<string, unknown>,
): GuildSettings {
  const settings = createDefaultGuildSettings();
  settings.enabled = true;
  for (const feature of Object.keys(settings.features) as Array<
    keyof GuildSettings["features"]
  >) {
    settings.features[feature] = true;
  }

  settings.timezone = validTimezone(environment.TIMEZONE) ?? defaultTimezone();
  settings.channels.court =
    envSnowflake(environment, "COURT_CHANNEL_ID") ??
    stateSnowflake(legacyState.channel_id, "COURT_CHANNEL_ID");
  settings.channels.log =
    envSnowflake(environment, "LOG_CHANNEL_ID") ??
    stateSnowflake(legacyState.log_channel_id, "LOG_CHANNEL_ID");
  settings.channels.weeklyDigest = envSnowflake(
    environment,
    "WEEKLY_DIGEST_CHANNEL_ID",
  );
  settings.channels.royalAlert = envSnowflake(
    environment,
    "ROYAL_ALERT_CHANNEL_ID",
    LEGACY_DEFAULTS.royalAlertChannel,
  );

  settings.roles.staff = envSnowflakeList(environment, "STAFF_ROLE_IDS", [
    ...LEGACY_DEFAULTS.staffRoles,
  ]);
  settings.roles.privilegedChat = [...settings.roles.staff];
  settings.roles.emperor = envSnowflake(
    environment,
    "EMPEROR_ROLE_ID",
    LEGACY_DEFAULTS.emperorRole,
  );
  settings.roles.empress = envSnowflake(
    environment,
    "EMPRESS_ROLE_ID",
    LEGACY_DEFAULTS.empressRole,
  );
  settings.roles.silenceTargets = [LEGACY_DEFAULTS.silenceTargetRole];
  settings.roles.silenceExcludes = envSnowflakeList(
    environment,
    "SILENT_LOCK_EXCLUDE_ROLES",
    [...LEGACY_DEFAULTS.silenceExcludeRoles],
  );
  settings.roles.anonymousRequired = envSnowflake(
    environment,
    "ANON_REQUIRED_ROLE_ID",
  );

  const legacyMode = String(legacyState.mode ?? "")
    .trim()
    .toLowerCase();
  settings.courtSchedule.mode = ["off", "manual", "auto"].includes(legacyMode)
    ? (legacyMode as GuildSettings["courtSchedule"]["mode"])
    : "manual";
  settings.courtSchedule.hour = coerceInt(legacyState.hour, 20, 0, 23);
  settings.courtSchedule.minute = coerceInt(legacyState.minute, 0, 0, 59);
  settings.courtSchedule.dryRun = Boolean(
    legacyState.dry_run_auto_post ?? false,
  );
  settings.weeklyDigestSchedule.weekday = envInteger(
    environment,
    "WEEKLY_DIGEST_WEEKDAY",
    0,
    0,
    6,
  );
  settings.weeklyDigestSchedule.hour = envInteger(
    environment,
    "WEEKLY_DIGEST_HOUR",
    19,
    0,
    23,
  );
  settings.limits.anonMinAccountAgeMinutes = envInteger(
    environment,
    "ANON_MIN_ACCOUNT_AGE_MINUTES",
    0,
    0,
    10_000_000,
  );
  settings.limits.anonMinMemberAgeMinutes = envInteger(
    environment,
    "ANON_MIN_MEMBER_AGE_MINUTES",
    0,
    0,
    10_000_000,
  );
  settings.limits.anonCooldownSeconds = envInteger(
    environment,
    "ANON_COOLDOWN_SECONDS",
    0,
    0,
    31_536_000,
  );
  settings.limits.anonAllowLinks = envBoolean(
    environment,
    "ANON_ALLOW_LINKS",
    false,
  );
  settings.limits.muteallTargetCap = envInteger(
    environment,
    "MUTEALL_TARGET_CAP",
    0,
    0,
    10_000,
  );
  settings.limits.answerRetentionDays = envInteger(
    environment,
    "ANSWER_RETENTION_DAYS",
    90,
    1,
    36_500,
  );
  settings.championUserId = envSnowflake(
    environment,
    "UNDEFEATED_USER_ID",
    LEGACY_DEFAULTS.championUser,
  );
  settings.greetings = LEGACY_DEFAULTS.greetings.map((profile) => ({
    ...profile,
  }));

  return sanitizeGuildSettings(settings);
}

export function parseLegacyStateJson(
  raw: string | null,
): Record<string, unknown> {
  if (raw === null) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new TypeError("legacy kv.state must contain a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (
      error instanceof TypeError &&
      error.message.startsWith("legacy kv.state")
    ) {
      throw error;
    }
    throw new TypeError("legacy kv.state contains invalid JSON", {
      cause: error,
    });
  }
}

export function buildMigratedStatePayload(
  legacyState: Record<string, unknown>,
): Record<string, unknown> {
  const migrated = { ...legacyState };
  for (const extractedOrDerivedKey of [
    "mode",
    "hour",
    "minute",
    "channel_id",
    "log_channel_id",
    "dry_run_auto_post",
    "posts",
    "metrics",
  ]) {
    delete migrated[extractedOrDerivedKey];
  }

  return {
    ...migrated,
    last_posted_date: optionalString(legacyState.last_posted_date),
    last_dry_run_date: optionalString(legacyState.last_dry_run_date),
    last_weekly_digest_week: optionalString(
      legacyState.last_weekly_digest_week,
    ),
    // Preserve the legacy payload exactly during the one-time migration. The
    // normal runtime may apply its configured history window on a later state
    // update, but migration itself must not discard operator data.
    history: stringArray(legacyState.history),
    used_questions: stringArray(legacyState.used_questions),
    royal_presence: legacyState.royal_presence ?? {},
    royal_afk: legacyState.royal_afk ?? {},
  };
}

function envSnowflake(
  environment: NodeJS.ProcessEnv,
  name: string,
  defaultValue: string | null = null,
): string | null {
  const value = String(environment[name] ?? "").trim();
  if (!value) {
    return defaultValue;
  }
  if (value === "0") {
    return null;
  }
  if (!isDiscordSnowflake(value)) {
    throw new TypeError(`${name} must be a Discord snowflake for migration`);
  }
  return value;
}

function envSnowflakeList(
  environment: NodeJS.ProcessEnv,
  name: string,
  defaultValue: string[],
): string[] {
  const raw = String(environment[name] ?? "").trim();
  if (!raw) {
    return defaultValue;
  }
  const result: string[] = [];
  for (const token of raw.split(",")) {
    const value = token.trim();
    if (!value) {
      continue;
    }
    if (!isDiscordSnowflake(value)) {
      throw new TypeError(
        `${name} must be a comma-separated list of Discord snowflakes for migration`,
      );
    }
    result.push(value);
  }
  return [...new Set(result)];
}

function envInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const raw = String(environment[name] ?? "").trim();
  if (!raw) {
    return defaultValue;
  }
  if (!/^-?\d+$/.test(raw)) {
    throw new TypeError(`${name} must be an integer for migration`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(
      `${name} must be between ${minimum} and ${maximum} for migration`,
    );
  }
  return parsed;
}

function envBoolean(
  environment: NodeJS.ProcessEnv,
  name: string,
  defaultValue: boolean,
): boolean {
  const raw = String(environment[name] ?? "")
    .trim()
    .toLowerCase();
  if (!raw) {
    return defaultValue;
  }
  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }
  throw new TypeError(`${name} must be boolean-like for migration`);
}

function stateSnowflake(
  value: unknown,
  environmentName: string,
): string | null {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    value === "0" ||
    value === 0
  ) {
    return null;
  }
  if (typeof value === "string") {
    if (!isDiscordSnowflake(value)) {
      throw new TypeError(
        `Legacy state contains an invalid Discord ID; set ${environmentName} to the exact value before migration`,
      );
    }
    return value.trim();
  }
  if (typeof value === "number") {
    throw new TypeError(
      `Legacy state stores ${environmentName} as an imprecise JSON number; set ${environmentName} to the exact Discord snowflake before migration`,
    );
  }
  throw new TypeError(
    `Legacy state contains an invalid ${environmentName}; set it to the exact Discord snowflake before migration`,
  );
}

function validTimezone(value: string | undefined): string | null {
  const timezone = String(value ?? "").trim();
  if (!timezone) {
    return null;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return timezone;
  } catch {
    throw new TypeError("TIMEZONE must be a valid IANA timezone for migration");
  }
}

function defaultTimezone(): string {
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return detected && validTimezone(detected) ? detected : "UTC";
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
