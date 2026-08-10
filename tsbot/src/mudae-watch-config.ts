import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DISCORD_SNOWFLAKE_PATTERN } from "./guild-settings.js";
import {
  MAX_PRIVATE_MUDAE_SERIES,
  MAX_PRIVATE_MUDAE_SERIES_LENGTH,
  normalizeMudaeSeriesDisplay,
  normalizeMudaeSeriesList,
  normalizeMudaeSeriesKey,
  type NormalizedMudaeSeries,
} from "./mudae-watch-normalization.js";

export const PRIVATE_MUDAE_WATCH_FILENAME = "mudae-watch.private.json";
export const MAX_PRIVATE_MUDAE_CONFIG_BYTES = 64 * 1_024;
export const MAX_PRIVATE_MUDAE_LOCATIONS = 25;
export const MAX_PRIVATE_MUDAE_CHANNELS_PER_GUILD = 100;
export const MAX_PRIVATE_MUDAE_CHANNELS = 250;

const MAX_RAW_PRIVATE_MUDAE_SERIES = MAX_PRIVATE_MUDAE_SERIES * 2;

const snowflake = z
  .string()
  .trim()
  .regex(DISCORD_SNOWFLAKE_PATTERN, "must be a Discord snowflake");

const seriesName = z
  .string()
  .max(MAX_PRIVATE_MUDAE_SERIES_LENGTH * 2)
  .superRefine((value, context) => {
    try {
      normalizeMudaeSeriesDisplay(value);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message:
          error instanceof RangeError
            ? "must contain 1-200 characters after whitespace normalization"
            : "contains unsupported control characters",
      });
    }
  });

const rawPrivateMudaeWatchSchema = z
  .object({
    enabled: z.boolean(),
    recipientUserId: snowflake,
    mudaeBotUserId: snowflake,
    locations: z
      .array(
        z
          .object({
            guildId: snowflake,
            channelIds: z
              .array(snowflake)
              .max(MAX_PRIVATE_MUDAE_CHANNELS_PER_GUILD),
          })
          .strict(),
      )
      .max(MAX_PRIVATE_MUDAE_LOCATIONS),
    series: z.array(seriesName).max(MAX_RAW_PRIVATE_MUDAE_SERIES),
  })
  .strict()
  .superRefine((configuration, context) => {
    if (configuration.recipientUserId === configuration.mudaeBotUserId) {
      context.addIssue({
        code: "custom",
        message: "recipient and trusted bot IDs must be different",
        path: ["recipientUserId"],
      });
    }
    if (configuration.enabled && configuration.locations.length === 0) {
      context.addIssue({
        code: "custom",
        message: "at least one monitored location is required when enabled",
        path: ["locations"],
      });
    }
    if (
      configuration.enabled &&
      !configuration.locations.some(
        (location) => location.channelIds.length > 0,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "at least one monitored channel is required when enabled",
        path: ["locations"],
      });
    }
    if (configuration.enabled && configuration.series.length === 0) {
      context.addIssue({
        code: "custom",
        message: "at least one watched series is required when enabled",
        path: ["series"],
      });
    }

    const channelGuilds = new Map<string, string>();
    const uniqueChannels = new Set<string>();
    for (const [locationIndex, location] of configuration.locations.entries()) {
      for (const [channelIndex, channelId] of location.channelIds.entries()) {
        uniqueChannels.add(channelId);
        const existingGuild = channelGuilds.get(channelId);
        if (existingGuild && existingGuild !== location.guildId) {
          context.addIssue({
            code: "custom",
            message: "a channel cannot be assigned to more than one guild",
            path: ["locations", locationIndex, "channelIds", channelIndex],
          });
        } else {
          channelGuilds.set(channelId, location.guildId);
        }
      }
    }
    if (uniqueChannels.size > MAX_PRIVATE_MUDAE_CHANNELS) {
      context.addIssue({
        code: "custom",
        message: `cannot contain more than ${MAX_PRIVATE_MUDAE_CHANNELS} unique channels`,
        path: ["locations"],
      });
    }

    const uniqueSeries = new Set<string>();
    for (const value of configuration.series) {
      try {
        uniqueSeries.add(normalizeMudaeSeriesKey(value));
      } catch {
        // The field-level issue already describes invalid series text.
      }
    }
    if (uniqueSeries.size > MAX_PRIVATE_MUDAE_SERIES) {
      context.addIssue({
        code: "custom",
        message: `cannot contain more than ${MAX_PRIVATE_MUDAE_SERIES} unique series`,
        path: ["series"],
      });
    }
  });

export interface PrivateMudaeWatchLocation {
  readonly guildId: string;
  readonly channelIds: readonly string[];
}

export interface PrivateMudaeWatchConfig {
  readonly enabled: boolean;
  readonly recipientUserId: string;
  readonly mudaeBotUserId: string;
  readonly locations: readonly PrivateMudaeWatchLocation[];
  readonly series: readonly NormalizedMudaeSeries[];
}

export type PrivateMudaeWatchConfigLoadResult =
  | {
      readonly status: "loaded";
      readonly filePath: string;
      readonly config: PrivateMudaeWatchConfig;
    }
  | {
      readonly status: "missing";
      readonly filePath: string;
      readonly config: null;
    }
  | {
      readonly status: "invalid";
      readonly filePath: string;
      readonly config: null;
      readonly issues: readonly string[];
    };

export function resolvePrivateMudaeWatchConfigPath(
  applicationRoot: string,
): string {
  return path.resolve(applicationRoot, PRIVATE_MUDAE_WATCH_FILENAME);
}

export function parsePrivateMudaeWatchConfig(
  input: unknown,
): PrivateMudaeWatchConfig {
  const parsed = rawPrivateMudaeWatchSchema.parse(input);
  const channelIdsByGuild = new Map<string, Set<string>>();
  for (const location of parsed.locations) {
    let channelIds = channelIdsByGuild.get(location.guildId);
    if (!channelIds) {
      channelIds = new Set<string>();
      channelIdsByGuild.set(location.guildId, channelIds);
    }
    for (const channelId of location.channelIds) {
      channelIds.add(channelId);
    }
  }

  return {
    enabled: parsed.enabled,
    recipientUserId: parsed.recipientUserId,
    mudaeBotUserId: parsed.mudaeBotUserId,
    locations: [...channelIdsByGuild.entries()].map(
      ([guildId, channelIds]) => ({
        guildId,
        channelIds: [...channelIds],
      }),
    ),
    series: normalizeMudaeSeriesList(parsed.series),
  };
}

export function loadPrivateMudaeWatchConfig(
  applicationRoot: string,
): PrivateMudaeWatchConfigLoadResult {
  const filePath = resolvePrivateMudaeWatchConfigPath(applicationRoot);
  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch (error) {
    if (isMissingFileError(error)) {
      return { status: "missing", filePath, config: null };
    }
    return unreadableConfiguration(filePath);
  }
  if (size > MAX_PRIVATE_MUDAE_CONFIG_BYTES) {
    return {
      status: "invalid",
      filePath,
      config: null,
      issues: [
        `configuration exceeds the ${MAX_PRIVATE_MUDAE_CONFIG_BYTES}-byte limit`,
      ],
    };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return unreadableConfiguration(filePath);
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_PRIVATE_MUDAE_CONFIG_BYTES) {
    return {
      status: "invalid",
      filePath,
      config: null,
      issues: [
        `configuration exceeds the ${MAX_PRIVATE_MUDAE_CONFIG_BYTES}-byte limit`,
      ],
    };
  }

  let input: unknown;
  try {
    input = JSON.parse(raw) as unknown;
  } catch {
    return {
      status: "invalid",
      filePath,
      config: null,
      issues: ["configuration is not valid JSON"],
    };
  }

  const parsed = rawPrivateMudaeWatchSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: "invalid",
      filePath,
      config: null,
      issues: formatConfigurationIssues(parsed.error.issues),
    };
  }
  return {
    status: "loaded",
    filePath,
    config: parsePrivateMudaeWatchConfig(parsed.data),
  };
}

export function isPrivateMudaeWatchLocation(
  configuration: PrivateMudaeWatchConfig,
  guildId: string,
  channelId: string,
): boolean {
  return configuration.locations.some(
    (location) =>
      location.guildId === guildId && location.channelIds.includes(channelId),
  );
}

export function findPrivateMudaeWatchSeries(
  configuration: PrivateMudaeWatchConfig,
  seriesName: string,
): NormalizedMudaeSeries | null {
  let key: string;
  try {
    key = normalizeMudaeSeriesKey(seriesName);
  } catch {
    return null;
  }
  return configuration.series.find((series) => series.key === key) ?? null;
}

function formatConfigurationIssues(
  issues: readonly z.core.$ZodIssue[],
): string[] {
  return issues.slice(0, 20).map((issue) => {
    const location = issue.path.length > 0 ? issue.path.join(".") : "root";
    return `${location}: ${issue.message}`;
  });
}

function unreadableConfiguration(
  filePath: string,
): PrivateMudaeWatchConfigLoadResult {
  return {
    status: "invalid",
    filePath,
    config: null,
    issues: ["configuration file could not be read"],
  };
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
