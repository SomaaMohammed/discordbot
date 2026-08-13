import { z } from "zod";
import { isGreetingTemplateWithinDiscordLimit } from "../greeting-message.js";

/**
 * Frozen schema-v3-through-v7 settings contract.  Keep this independent from
 * the active GuildSettings type so an upgrade cannot make old databases
 * unclassifiable before the explicit offline migration runs.
 */
export const LEGACY_GUILD_SETTINGS_VERSION = 2 as const;

const DISCORD_SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const DEFAULT_BULK_MODERATION_TARGET_CAP = 100;
const MAX_BULK_MODERATION_TARGET_CAP = 1_000;

const snowflake = z
  .string()
  .trim()
  .regex(DISCORD_SNOWFLAKE_PATTERN, "must be a Discord snowflake");

const invocationName = z
  .string()
  .transform((value) =>
    value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " "),
  )
  .pipe(
    z
      .string()
      .min(1)
      .max(64)
      .regex(/^[^\u0000-\u001f\u007f]+$/, "must not contain control characters")
      .refine(
        (value) => /[\p{L}\p{N}]/u.test(value),
        "must contain a letter or number",
      ),
  );

const greetingSchema = z
  .object({
    name: z
      .string()
      .transform((value) => value.normalize("NFKC").trim())
      .pipe(z.string().min(1).max(50)),
    message: z
      .string()
      .transform((value) => value.normalize("NFKC").trim())
      .pipe(
        z
          .string()
          .min(1)
          .max(2_000)
          .refine(
            (value) =>
              !/@(?:everyone|here)\b/i.test(value) &&
              !/<@(?:!|&)?\d{17,20}>/.test(value),
            "must use {user} instead of Discord or broadcast mentions",
          )
          .refine(
            isGreetingTemplateWithinDiscordLimit,
            "must render within Discord's message limit",
          ),
      ),
  })
  .strict();

const LegacyGuildSettingsV2Schema = z
  .object({
    version: z.literal(LEGACY_GUILD_SETTINGS_VERSION),
    enabled: z.boolean(),
    reviewRequired: z.boolean(),
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine(isValidTimezone, "must be a valid IANA timezone"),
    features: z
      .object({
        chat: z.boolean(),
        replyModeration: z.boolean(),
        greetings: z.boolean(),
        activityMetrics: z.boolean(),
      })
      .strict(),
    channels: z.object({ log: snowflake.nullable() }).strict(),
    invocation: z
      .object({
        keyword: invocationName,
        aliases: z
          .array(invocationName)
          .max(20)
          .transform((items) => [...new Set(items)]),
      })
      .strict(),
    limits: z
      .object({
        bulkModerationTargetCap: z
          .number()
          .int()
          .min(1)
          .max(MAX_BULK_MODERATION_TARGET_CAP),
      })
      .strict(),
    greetings: z.array(greetingSchema).max(100),
  })
  .strict()
  .superRefine((settings, context) => {
    if (settings.enabled && settings.reviewRequired) {
      context.addIssue({
        code: "custom",
        message: "a guild requiring review cannot be enabled",
        path: ["enabled"],
      });
    }
    const names = new Set<string>();
    for (const [index, profile] of settings.greetings.entries()) {
      const name = profile.name.normalize("NFKC").toLocaleLowerCase("en-US");
      if (names.has(name)) {
        context.addIssue({
          code: "custom",
          message: "greeting profile names must be unique",
          path: ["greetings", index, "name"],
        });
      }
      names.add(name);
    }
    if (settings.invocation.aliases.includes(settings.invocation.keyword)) {
      context.addIssue({
        code: "custom",
        message: "aliases must not repeat the invocation keyword",
        path: ["invocation", "aliases"],
      });
    }
  });

export type LegacyGuildSettingsV2 = z.infer<typeof LegacyGuildSettingsV2Schema>;

export function createDefaultLegacyGuildSettingsV2(): LegacyGuildSettingsV2 {
  return {
    version: LEGACY_GUILD_SETTINGS_VERSION,
    enabled: false,
    reviewRequired: true,
    timezone: "UTC",
    features: {
      chat: false,
      replyModeration: false,
      greetings: false,
      activityMetrics: false,
    },
    channels: { log: null },
    invocation: { keyword: "superior", aliases: [] },
    limits: {
      bulkModerationTargetCap: DEFAULT_BULK_MODERATION_TARGET_CAP,
    },
    greetings: [],
  };
}

export function sanitizeLegacyGuildSettingsV2(
  input: unknown,
): LegacyGuildSettingsV2 {
  return LegacyGuildSettingsV2Schema.parse(input);
}

export function parseLegacyGuildSettingsV2Json(
  raw: string,
): LegacyGuildSettingsV2 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new TypeError("Legacy guild settings contain invalid JSON", {
      cause: error,
    });
  }
  return sanitizeLegacyGuildSettingsV2(parsed);
}

export function serializeLegacyGuildSettingsV2(
  settings: LegacyGuildSettingsV2,
): string {
  return JSON.stringify(sanitizeLegacyGuildSettingsV2(settings));
}

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
