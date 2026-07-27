import { z } from "zod";
import type { GuildSettings } from "./types.js";

export const GUILD_SETTINGS_VERSION = 1 as const;
export const DISCORD_SNOWFLAKE_PATTERN = /^\d{17,20}$/;

const snowflake = z
  .string()
  .trim()
  .regex(DISCORD_SNOWFLAKE_PATTERN, "must be a Discord snowflake");
const optionalSnowflake = snowflake.nullable();
const snowflakeList = z
  .array(snowflake)
  .max(100)
  .transform((items) => [...new Set(items)]);
const boundedInteger = (minimum: number, maximum: number) =>
  z.number().int().min(minimum).max(maximum);

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

const greetingSchema = z
  .object({
    name: z.string().trim().min(1).max(50),
    userId: optionalSnowflake,
    message: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const GuildSettingsSchema: z.ZodType<GuildSettings> = z
  .object({
    version: z.literal(GUILD_SETTINGS_VERSION),
    enabled: z.boolean(),
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine(isValidTimezone, "must be a valid IANA timezone"),
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
        court: optionalSnowflake,
        log: optionalSnowflake,
        weeklyDigest: optionalSnowflake,
        royalAlert: optionalSnowflake,
      })
      .strict(),
    roles: z
      .object({
        staff: snowflakeList,
        privilegedChat: snowflakeList,
        emperor: optionalSnowflake,
        empress: optionalSnowflake,
        silenceTargets: snowflakeList,
        silenceExcludes: snowflakeList,
        anonymousRequired: optionalSnowflake,
      })
      .strict(),
    labels: z
      .object({
        emperor: z.string().trim().min(1).max(80),
        empress: z.string().trim().min(1).max(80),
      })
      .strict(),
    invocation: z
      .object({
        keyword: z
          .string()
          .trim()
          .toLowerCase()
          .min(1)
          .max(64)
          .regex(
            /^[^\u0000-\u001f\u007f]+$/,
            "must not contain control characters",
          )
          .refine(
            (value) => /[a-z0-9]/i.test(value),
            "must contain a letter or number",
          ),
        aliases: z
          .array(
            z
              .string()
              .trim()
              .toLowerCase()
              .min(1)
              .max(64)
              .regex(
                /^[^\u0000-\u001f\u007f]+$/,
                "must not contain control characters",
              )
              .refine(
                (value) => /[a-z0-9]/i.test(value),
                "must contain a letter or number",
              ),
          )
          .max(20)
          .transform((items) => [...new Set(items)]),
      })
      .strict(),
    courtSchedule: z
      .object({
        mode: z.enum(["off", "manual", "auto"]),
        hour: boundedInteger(0, 23),
        minute: boundedInteger(0, 59),
        dryRun: z.boolean(),
      })
      .strict(),
    weeklyDigestSchedule: z
      .object({
        weekday: boundedInteger(0, 6),
        hour: boundedInteger(0, 23),
      })
      .strict(),
    limits: z
      .object({
        anonMinAccountAgeMinutes: boundedInteger(0, 10_000_000),
        anonMinMemberAgeMinutes: boundedInteger(0, 10_000_000),
        anonCooldownSeconds: boundedInteger(0, 31_536_000),
        anonAllowLinks: z.boolean(),
        muteallTargetCap: boundedInteger(0, 10_000),
        answerRetentionDays: boundedInteger(1, 36_500),
      })
      .strict(),
    championUserId: optionalSnowflake,
    greetings: z.array(greetingSchema).max(100),
  })
  .strict()
  .superRefine((settings, context) => {
    const profileNames = new Set<string>();
    for (const [index, profile] of settings.greetings.entries()) {
      const normalized = profile.name.toLowerCase();
      if (profileNames.has(normalized)) {
        context.addIssue({
          code: "custom",
          message: "greeting profile names must be unique",
          path: ["greetings", index, "name"],
        });
      }
      profileNames.add(normalized);
    }

    if (settings.invocation.aliases.includes(settings.invocation.keyword)) {
      context.addIssue({
        code: "custom",
        message: "aliases must not repeat the invocation keyword",
        path: ["invocation", "aliases"],
      });
    }
  });

export function createDefaultGuildSettings(): GuildSettings {
  return {
    version: GUILD_SETTINGS_VERSION,
    enabled: false,
    timezone: "UTC",
    features: {
      court: false,
      invictusChat: false,
      anonymousAnswers: false,
      replyModeration: false,
      silenceLock: false,
      royalAfk: false,
      royalPresence: false,
      weeklyDigest: false,
      greetings: false,
    },
    channels: {
      court: null,
      log: null,
      weeklyDigest: null,
      royalAlert: null,
    },
    roles: {
      staff: [],
      privilegedChat: [],
      emperor: null,
      empress: null,
      silenceTargets: [],
      silenceExcludes: [],
      anonymousRequired: null,
    },
    labels: {
      emperor: "Emperor",
      empress: "Empress",
    },
    invocation: {
      keyword: "superior",
      aliases: [],
    },
    courtSchedule: {
      mode: "off",
      hour: 20,
      minute: 0,
      dryRun: false,
    },
    weeklyDigestSchedule: {
      weekday: 0,
      hour: 19,
    },
    limits: {
      anonMinAccountAgeMinutes: 0,
      anonMinMemberAgeMinutes: 0,
      anonCooldownSeconds: 0,
      anonAllowLinks: false,
      muteallTargetCap: 0,
      answerRetentionDays: 90,
    },
    championUserId: null,
    greetings: [],
  };
}

export function sanitizeGuildSettings(input: unknown): GuildSettings {
  return GuildSettingsSchema.parse(input);
}

export function parseGuildSettingsJson(raw: string): GuildSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new TypeError("Guild settings contain invalid JSON", {
      cause: error,
    });
  }
  return sanitizeGuildSettings(parsed);
}

export function serializeGuildSettings(settings: GuildSettings): string {
  return JSON.stringify(sanitizeGuildSettings(settings));
}

export function isDiscordSnowflake(value: string): boolean {
  return DISCORD_SNOWFLAKE_PATTERN.test(value.trim());
}

export function assertDiscordSnowflake(
  value: string,
  label = "guild ID",
): string {
  const normalized = String(value).trim();
  if (!isDiscordSnowflake(normalized)) {
    throw new TypeError(`${label} must be a Discord snowflake`);
  }
  return normalized;
}
