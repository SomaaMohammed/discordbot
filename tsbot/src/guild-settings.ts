import { z } from "zod";
import { isGreetingTemplateWithinDiscordLimit } from "./greeting-message.js";
import type { GuildSettings } from "./types.js";

export const GUILD_SETTINGS_VERSION = 3 as const;
export const DISCORD_SNOWFLAKE_PATTERN = /^\d{17,20}$/;
export const DEFAULT_BULK_MODERATION_TARGET_CAP = 100;
export const MAX_BULK_MODERATION_TARGET_CAP = 1_000;

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

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function isSafeGreetingMessage(value: string): boolean {
  return (
    !/@(?:everyone|here)\b/i.test(value) && !/<@(?:!|&)?\d{17,20}>/.test(value)
  );
}

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
            isSafeGreetingMessage,
            "must use {user} instead of Discord or broadcast mentions",
          )
          .refine(
            isGreetingTemplateWithinDiscordLimit,
            "must render to at most 2000 Discord characters after Markdown escaping and {user} expansion",
          ),
      ),
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
    channels: z
      .object({
        log: snowflake.nullable(),
      })
      .strict(),
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

export function createDefaultGuildSettings(): GuildSettings {
  return {
    version: GUILD_SETTINGS_VERSION,
    enabled: true,
    timezone: "UTC",
    channels: {
      log: null,
    },
    invocation: {
      keyword: "superior",
      aliases: [],
    },
    limits: {
      bulkModerationTargetCap: DEFAULT_BULK_MODERATION_TARGET_CAP,
    },
    greetings: [{ name: "Welcome", message: "Welcome, {user}!" }],
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
