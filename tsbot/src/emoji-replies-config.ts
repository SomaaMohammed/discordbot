import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DISCORD_SNOWFLAKE_PATTERN } from "./guild-settings.js";
import { normalizeUnicodeEmoji } from "./unicode-emoji.js";

export const EMOJI_REPLIES_FILENAME = "emoji-replies.json";
export const MAX_EMOJI_REPLIES_CONFIG_BYTES = 64 * 1_024;
export const MAX_EMOJI_REPLIES_SERVERS = 100;
export const MAX_EMOJI_REPLIES_MEMBERS_PER_SERVER = 100;
export const MAX_EMOJI_REPLIES_PER_MEMBER = 25;

const unicodeEmoji = z.string().superRefine((value, context) => {
  try {
    normalizeUnicodeEmoji(value, "Emoji");
  } catch {
    context.addIssue({
      code: "custom",
      message: "must be one standard Unicode emoji",
    });
  }
});

const rawEmojiRepliesSchema = z
  .object({
    reactionsEnabled: z.boolean(),
    repliesEnabled: z.boolean(),
    servers: z.record(
      z.string(),
      z
        .object({
          members: z.record(
            z.string(),
            z
              .object({
                emojis: z
                  .array(unicodeEmoji)
                  .min(1, "must contain at least one emoji")
                  .max(MAX_EMOJI_REPLIES_PER_MEMBER),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((configuration, context) => {
    const serverEntries = Object.entries(configuration.servers);
    if (serverEntries.length > MAX_EMOJI_REPLIES_SERVERS) {
      context.addIssue({
        code: "custom",
        message: `cannot contain more than ${MAX_EMOJI_REPLIES_SERVERS} servers`,
        path: ["servers"],
      });
    }
    for (const [serverId, server] of serverEntries) {
      if (!DISCORD_SNOWFLAKE_PATTERN.test(serverId)) {
        context.addIssue({
          code: "custom",
          message: "must be a Discord snowflake",
          path: ["servers", serverId],
        });
      }
      if (
        Object.keys(server.members).length >
        MAX_EMOJI_REPLIES_MEMBERS_PER_SERVER
      ) {
        context.addIssue({
          code: "custom",
          message: `cannot contain more than ${MAX_EMOJI_REPLIES_MEMBERS_PER_SERVER} members`,
          path: ["servers", serverId, "members"],
        });
      }
      for (const memberId of Object.keys(server.members)) {
        if (!DISCORD_SNOWFLAKE_PATTERN.test(memberId)) {
          context.addIssue({
            code: "custom",
            message: "must be a Discord snowflake",
            path: ["servers", serverId, "members", memberId],
          });
        }
      }
    }
  });

export interface EmojiRepliesMemberConfig {
  readonly emojis: readonly string[];
}

export interface EmojiRepliesServerConfig {
  readonly members: Readonly<Record<string, EmojiRepliesMemberConfig>>;
}

export interface EmojiRepliesConfig {
  readonly reactionsEnabled: boolean;
  readonly repliesEnabled: boolean;
  readonly servers: Readonly<Record<string, EmojiRepliesServerConfig>>;
}

export type EmojiRepliesConfigLoadResult =
  | {
      readonly status: "loaded";
      readonly filePath: string;
      readonly config: EmojiRepliesConfig;
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

export function resolveEmojiRepliesConfigPath(applicationRoot: string): string {
  return path.resolve(applicationRoot, EMOJI_REPLIES_FILENAME);
}

export function parseEmojiRepliesConfig(input: unknown): EmojiRepliesConfig {
  const parsed = rawEmojiRepliesSchema.parse(input);
  const servers: Record<string, EmojiRepliesServerConfig> = {};
  for (const [serverId, server] of Object.entries(parsed.servers)) {
    const members: Record<string, EmojiRepliesMemberConfig> = {};
    for (const [memberId, member] of Object.entries(server.members)) {
      members[memberId] = {
        emojis: member.emojis.map((emoji) => normalizeUnicodeEmoji(emoji)),
      };
    }
    servers[serverId] = { members };
  }
  return {
    reactionsEnabled: parsed.reactionsEnabled,
    repliesEnabled: parsed.repliesEnabled,
    servers,
  };
}

export function loadEmojiRepliesConfig(
  applicationRoot: string,
): EmojiRepliesConfigLoadResult {
  const filePath = resolveEmojiRepliesConfigPath(applicationRoot);
  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch (error) {
    if (isMissingFileError(error)) {
      return { status: "missing", filePath, config: null };
    }
    return unreadableConfiguration(filePath);
  }
  if (size > MAX_EMOJI_REPLIES_CONFIG_BYTES) {
    return {
      status: "invalid",
      filePath,
      config: null,
      issues: [
        `configuration exceeds the ${MAX_EMOJI_REPLIES_CONFIG_BYTES}-byte limit`,
      ],
    };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return unreadableConfiguration(filePath);
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_EMOJI_REPLIES_CONFIG_BYTES) {
    return {
      status: "invalid",
      filePath,
      config: null,
      issues: [
        `configuration exceeds the ${MAX_EMOJI_REPLIES_CONFIG_BYTES}-byte limit`,
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

  const parsed = rawEmojiRepliesSchema.safeParse(input);
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
    config: parseEmojiRepliesConfig(parsed.data),
  };
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
): EmojiRepliesConfigLoadResult {
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
