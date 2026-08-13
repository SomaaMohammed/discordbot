/**
 * One-time schema-v2 conversion policy.
 *
 * Historical product identifiers are deliberately isolated in this module so
 * the active runtime never imports or advertises them.
 */
import { z } from "zod";
import {
  DEFAULT_BULK_MODERATION_TARGET_CAP,
  DISCORD_SNOWFLAKE_PATTERN,
} from "../guild-settings.js";
import { USER_ACTIVITY_METRICS, type UserActivityMetric } from "../types.js";
import {
  createDefaultLegacyGuildSettingsV2,
  sanitizeLegacyGuildSettingsV2,
  type LegacyGuildSettingsV2,
} from "./guild-settings-v2.js";

export const LEGACY_SILENCE_RECOVERY_METRIC_KEY = "runtime.silence_leases.v1";

const snowflake = z.string().regex(DISCORD_SNOWFLAKE_PATTERN);
const nullableSnowflake = snowflake.nullable();
const snowflakeList = z.array(snowflake).max(100);
const integer = (minimum: number, maximum: number) =>
  z.number().int().min(minimum).max(maximum);

const LegacySettingsSchema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    timezone: z.string().min(1).max(100),
    features: z
      .object({
        court: z.boolean(),
        invictusChat: z.boolean(),
        anonymousAnswers: z.boolean(),
        replyModeration: z.boolean(),
        silenceLock: z.boolean(),
        royalAfk: z.boolean(),
        royalPresence: z.boolean(),
        weeklyDigest: z.boolean(),
        greetings: z.boolean(),
      })
      .strict(),
    channels: z
      .object({
        court: nullableSnowflake,
        log: nullableSnowflake,
        weeklyDigest: nullableSnowflake,
        royalAlert: nullableSnowflake,
      })
      .strict(),
    roles: z
      .object({
        staff: snowflakeList,
        privilegedChat: snowflakeList,
        emperor: nullableSnowflake,
        empress: nullableSnowflake,
        silenceTargets: snowflakeList,
        silenceExcludes: snowflakeList,
        anonymousRequired: nullableSnowflake,
      })
      .strict(),
    labels: z
      .object({
        emperor: z.string().max(80),
        empress: z.string().max(80),
      })
      .strict(),
    invocation: z
      .object({
        keyword: z.string().min(1).max(64),
        aliases: z.array(z.string().min(1).max(64)).max(20),
      })
      .strict(),
    courtSchedule: z
      .object({
        mode: z.enum(["off", "manual", "auto"]),
        hour: integer(0, 23),
        minute: integer(0, 59),
        dryRun: z.boolean(),
      })
      .strict(),
    weeklyDigestSchedule: z
      .object({
        weekday: integer(0, 6),
        hour: integer(0, 23),
      })
      .strict(),
    limits: z
      .object({
        anonMinAccountAgeMinutes: integer(0, 10_000_000),
        anonMinMemberAgeMinutes: integer(0, 10_000_000),
        anonCooldownSeconds: integer(0, 31_536_000),
        anonAllowLinks: z.boolean(),
        muteallTargetCap: integer(0, 10_000),
        answerRetentionDays: integer(1, 36_500),
      })
      .strict(),
    championUserId: nullableSnowflake,
    greetings: z
      .array(
        z
          .object({
            name: z.string().min(1).max(50),
            userId: nullableSnowflake,
            message: z.string().min(1).max(2_000),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

type LegacySettings = z.infer<typeof LegacySettingsSchema>;

export interface ConvertedSettings {
  settings: LegacyGuildSettingsV2;
  safelyTranslated: boolean;
  warnings: string[];
}

const HISTORICAL_TERMS = new RegExp(
  String.raw`\b(?:invictus|imperial|empire|court|royal|emperor|empress|throne|decree|majesty|sovereign|rio|taylor)\b`,
  "iu",
);

const ACTIVE_LEGACY_COMMAND_MAP = new Map<string, string>([
  ["say", "say"],
  ["dmpanel", "dmpanel"],
  ["dmpanel.forward", "dmpanel.message"],
  ["purge", "purge"],
  ["purgeuser", "purgeuser"],
  ["lock", "lock"],
  ["unlock", "unlock"],
  ["slowmode", "slowmode"],
  ["timeout", "timeout"],
  ["untimeout", "untimeout"],
  ["mutemany", "mutemany"],
  ["unmutemany", "unmutemany"],
  ["muteall", "muteall"],
  ["unmuteall", "unmuteall"],
  ["rolepanel", "rolepanel"],
  ["rolepanelmulti", "rolepanelmulti"],
  ["backfillstats", "backfillstats"],
  ["backfillstatus", "backfillstatus"],
]);

const ACTIVE_COMMAND_NAMESPACE =
  /^(?:setup|superior|utility|fun|greetings)\.[a-z0-9][a-z0-9._-]*$/;
const USER_METRIC_SET = new Set<string>(USER_ACTIVITY_METRICS);

export function convertLegacyV2Settings(
  input: unknown,
  lifecycle: { guildEnabled: boolean; guildActive: boolean },
): ConvertedSettings {
  const parsed = LegacySettingsSchema.safeParse(input);
  if (!parsed.success) {
    return settingsRequiringReview("settings JSON is malformed or incomplete");
  }

  const legacy = parsed.data;
  if (!isValidTimezone(legacy.timezone)) {
    return settingsRequiringReview("timezone is invalid");
  }

  const warnings: string[] = [];
  const invocation = convertInvocation(legacy, warnings);
  const greetings = convertGreetings(legacy, warnings);
  const reviewRequired = legacy.limits.muteallTargetCap <= 0;
  if (reviewRequired) {
    warnings.push(
      "unbounded bulk moderation was replaced with a finite cap and requires review",
    );
  }

  const enabled =
    legacy.enabled &&
    lifecycle.guildEnabled &&
    lifecycle.guildActive &&
    !reviewRequired;
  const settings: LegacyGuildSettingsV2 = {
    version: 2,
    enabled,
    reviewRequired,
    timezone: legacy.timezone,
    features: {
      chat: legacy.features.invictusChat,
      replyModeration: legacy.features.replyModeration,
      greetings: legacy.features.greetings && greetings.length > 0,
      activityMetrics: legacy.features.invictusChat,
    },
    channels: {
      log: legacy.channels.log,
    },
    invocation,
    limits: {
      bulkModerationTargetCap:
        legacy.limits.muteallTargetCap > 0
          ? Math.min(legacy.limits.muteallTargetCap, 1_000)
          : DEFAULT_BULK_MODERATION_TARGET_CAP,
    },
    greetings,
  };

  try {
    return {
      settings: sanitizeLegacyGuildSettingsV2(settings),
      safelyTranslated: !reviewRequired,
      warnings,
    };
  } catch {
    return settingsRequiringReview(
      "active settings could not be represented safely",
    );
  }
}

export function convertLegacyMetric(
  key: string,
  rawValue: string,
): { key: string; value: number } | null {
  const value = parseMetricValue(rawValue);
  if (value === null) {
    return null;
  }

  const userMatch = /^user_stats\.(\d{17,20})\.([a-z_]+)$/.exec(key);
  if (
    userMatch?.[1] &&
    userMatch[2] &&
    DISCORD_SNOWFLAKE_PATTERN.test(userMatch[1]) &&
    USER_METRIC_SET.has(userMatch[2])
  ) {
    return { key, value };
  }

  const commandMatch = /^(command_usage|command_failures)\.(.+)$/.exec(key);
  if (!commandMatch?.[1] || !commandMatch[2]) {
    return null;
  }
  let command = commandMatch[2];
  if (ACTIVE_COMMAND_NAMESPACE.test(command)) {
    return { key: `${commandMatch[1]}.${command}`, value };
  }

  const historicalMatch = /^invictus\.(.+)$/.exec(command);
  if (!historicalMatch?.[1]) {
    return null;
  }
  const activeCommand = ACTIVE_LEGACY_COMMAND_MAP.get(historicalMatch[1]);
  if (!activeCommand) {
    return null;
  }
  command = `superior.${activeCommand}`;
  return { key: `${commandMatch[1]}.${command}`, value };
}

export function isUserActivityMetric(
  value: string,
): value is UserActivityMetric {
  return USER_METRIC_SET.has(value);
}

function settingsRequiringReview(reason: string): ConvertedSettings {
  const settings = createDefaultLegacyGuildSettingsV2();
  settings.reviewRequired = true;
  return {
    settings,
    safelyTranslated: false,
    warnings: [reason],
  };
}

function convertInvocation(
  legacy: LegacySettings,
  warnings: string[],
): LegacyGuildSettingsV2["invocation"] {
  let keyword = normalizeInvocation(legacy.invocation.keyword);
  if (!keyword || HISTORICAL_TERMS.test(keyword)) {
    keyword = "superior";
    warnings.push("historical invocation keyword was replaced");
  }

  const aliases: string[] = [];
  for (const raw of legacy.invocation.aliases) {
    const alias = normalizeInvocation(raw);
    if (
      !alias ||
      alias === keyword ||
      HISTORICAL_TERMS.test(alias) ||
      aliases.includes(alias)
    ) {
      continue;
    }
    aliases.push(alias);
  }
  return { keyword, aliases };
}

function convertGreetings(
  legacy: LegacySettings,
  warnings: string[],
): LegacyGuildSettingsV2["greetings"] {
  const converted: LegacyGuildSettingsV2["greetings"] = [];
  const names = new Set<string>();
  for (const profile of legacy.greetings) {
    const name = profile.name.normalize("NFKC").trim();
    let message = profile.message.normalize("NFKC").trim();
    message = message.replace(/<@!?\d{17,20}>/g, "{user}");
    const normalizedName = name.toLocaleLowerCase("en-US");
    if (
      !name ||
      !message ||
      names.has(normalizedName) ||
      HISTORICAL_TERMS.test(name) ||
      HISTORICAL_TERMS.test(message) ||
      /@(?:everyone|here)\b/i.test(message) ||
      /<@(?:&)?\d{17,20}>/.test(message)
    ) {
      warnings.push(`greeting profile ${profile.name} was discarded`);
      continue;
    }
    names.add(normalizedName);
    converted.push({ name, message });
  }

  if (legacy.features.greetings && converted.length === 0) {
    converted.push({
      name: "welcome",
      message: "Hey {user}, glad you're here!",
    });
    warnings.push("a neutral greeting profile was created");
  }
  return converted;
}

function normalizeInvocation(value: string): string | null {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (
    normalized.length < 1 ||
    normalized.length > 64 ||
    /[\u0000-\u001f\u007f]/.test(normalized) ||
    !/[\p{L}\p{N}]/u.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function parseMetricValue(value: string): number | null {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
