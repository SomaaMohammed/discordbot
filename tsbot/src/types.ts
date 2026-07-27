export type BotMode = "off" | "manual" | "auto";
export type CommandRegistrationMode = "global" | "guild";
export type RoyalTitle = "Emperor" | "Empress";

export interface ProcessConfig {
  discordToken: string;
  botVersion: string;
  dbFile: string;
  commandRegistrationMode: CommandRegistrationMode;
  devGuildIds: string[];
  botOperatorUserIds: string[];
  schedulerConcurrency: number;
}

export interface GuildGreetingProfile {
  name: string;
  userId: string | null;
  message: string;
}

export interface GuildSettings {
  version: number;
  enabled: boolean;
  timezone: string;
  features: {
    court: boolean;
    invictusChat: boolean;
    anonymousAnswers: boolean;
    replyModeration: boolean;
    silenceLock: boolean;
    royalAfk: boolean;
    royalPresence: boolean;
    weeklyDigest: boolean;
    greetings: boolean;
  };
  channels: {
    court: string | null;
    log: string | null;
    weeklyDigest: string | null;
    royalAlert: string | null;
  };
  roles: {
    staff: string[];
    privilegedChat: string[];
    emperor: string | null;
    empress: string | null;
    silenceTargets: string[];
    silenceExcludes: string[];
    anonymousRequired: string | null;
  };
  labels: {
    emperor: string;
    empress: string;
  };
  invocation: {
    keyword: string;
    aliases: string[];
  };
  courtSchedule: {
    mode: BotMode;
    hour: number;
    minute: number;
    dryRun: boolean;
  };
  weeklyDigestSchedule: {
    weekday: number;
    hour: number;
  };
  limits: {
    anonMinAccountAgeMinutes: number;
    anonMinMemberAgeMinutes: number;
    anonCooldownSeconds: number;
    anonAllowLinks: boolean;
    muteallTargetCap: number;
    answerRetentionDays: number;
  };
  championUserId: string | null;
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

export interface PostRecord {
  message_id: string;
  thread_id: string | null;
  channel_id: string;
  category: string;
  question: string;
  posted_at: string;
  close_after_hours: number;
  closed: boolean;
  closed_at: string | null;
  close_reason: string | null;
}

export interface MetricsShape {
  command_usage: Record<string, number>;
  command_failures: Record<string, number>;
  posts_by_category: Record<string, number>;
  posts_total: number;
  posts_auto: number;
  posts_manual: number;
  custom_posts: number;
  answers_total: number;
  last_successful_auto_post: string | null;
}

export interface RoyalPresenceShape {
  last_message_at_by_title: Record<RoyalTitle, string | null>;
  last_message_at: string | null;
  last_speaker: RoyalTitle | null;
}

export interface RoyalAfkEntry {
  active: boolean;
  reason: string;
  set_at: string | null;
  set_by_user_id: string | null;
}

export interface RoyalAfkShape {
  by_title: Record<RoyalTitle, RoyalAfkEntry>;
}

/** Mutable per-guild state. Configuration belongs in GuildSettings. */
export interface CourtState {
  last_posted_date: string | null;
  last_dry_run_date: string | null;
  last_weekly_digest_week: string | null;
  history: string[];
  used_questions: string[];
  royal_presence: RoyalPresenceShape;
  royal_afk: RoyalAfkShape;
  /** Derived from the guild-scoped posts table; not persisted in kv.state. */
  posts: PostRecord[];
  /** Derived from the guild-scoped metrics table; not persisted in kv.state. */
  metrics: MetricsShape;
}

export interface BackfillStatusSnapshot {
  running: boolean;
  started_at: string | null;
  lookback_days: number | null;
  initiated_by_user_id: string | null;
  last_started_at: string | null;
  last_completed_at: string | null;
  last_status: string;
  last_summary: string | null;
  last_error: string | null;
}

export interface GuildAnswerExport {
  questionMessageId: string;
  userId: string;
  answerMessageId: string;
  createdAt: string;
}

export interface GuildMetricExport {
  key: string;
  value: string;
  updatedAt: string;
}

export interface GuildCooldownExport {
  userId: string;
  lastAnswerAt: string;
}

export interface GuildKvExport {
  key: string;
  value: string;
  updatedAt: string;
}

export interface GuildDataExport {
  formatVersion: 1;
  guildId: string;
  exportedAt: string;
  metadata: GuildRecord;
  settings: GuildSettings;
  state: CourtState;
  questions: Record<string, string[]>;
  kv: GuildKvExport[];
  posts: PostRecord[];
  answers: GuildAnswerExport[];
  metrics: GuildMetricExport[];
  cooldowns: GuildCooldownExport[];
}

export interface GuildPurgeResult {
  guildId: string;
  guilds: number;
  settings: number;
  kv: number;
  posts: number;
  answers: number;
  metrics: number;
  cooldowns: number;
}
