export type CommandRegistrationMode = "global" | "guild";

export interface ProcessConfig {
  discordToken: string;
  botVersion: string;
  dbFile: string;
  commandRegistrationMode: CommandRegistrationMode;
  devGuildIds: string[];
}

export interface GuildGreetingProfile {
  name: string;
  message: string;
}

export interface GuildSettings {
  version: 2;
  enabled: boolean;
  reviewRequired: boolean;
  timezone: string;
  features: {
    chat: boolean;
    replyModeration: boolean;
    greetings: boolean;
    activityMetrics: boolean;
  };
  channels: {
    log: string | null;
  };
  invocation: {
    keyword: string;
    aliases: string[];
  };
  limits: {
    bulkModerationTargetCap: number;
  };
  greetings: GuildGreetingProfile[];
}

export interface GuildRecord {
  guildId: string;
  enabled: boolean;
  name: string | null;
  joinedAt: string | null;
  leftAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GuildMetricExport {
  key: string;
  value: number;
  updatedAt: string;
}

/** Portable, tenant-scoped export of the active product data model. */
export interface GuildDataExport {
  formatVersion: 2;
  guildId: string;
  exportedAt: string;
  metadata: GuildRecord;
  settings: GuildSettings;
  metrics: GuildMetricExport[];
}

export interface GuildPurgeResult {
  guildId: string;
  guilds: number;
  settings: number;
  metrics: number;
}

export const USER_ACTIVITY_METRICS = [
  "messages_sent",
  "reactions_sent",
  "reactions_received",
  "battles_played",
  "battles_won",
] as const;

export type UserActivityMetric = (typeof USER_ACTIVITY_METRICS)[number];

export type UserMetrics = Record<UserActivityMetric, number>;

export interface UserLeaderboardEntry {
  userId: string;
  value: number;
}
