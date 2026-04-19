export type BotMode = "off" | "manual" | "auto";
export type RoyalTitle = "Emperor" | "Empress";

export interface RuntimeConfig {
  discordToken: string;
  botVersion: string;
  testGuildId: number;
  testGuildIdText: string;
  courtChannelId: number;
  courtChannelIdText: string;
  logChannelId: number;
  logChannelIdText: string;
  timezoneName: string;
  staffRoleIds: Set<string>;
  staffRoleIdsText: Set<string>;
  emperorRoleId: number;
  emperorRoleIdText: string;
  empressRoleId: number;
  empressRoleIdText: string;
  silentLockExcludeRoles: Set<string>;
  royalAlertChannelId: number;
  royalAlertChannelIdText: string;
  undefeatedUserId: number;
  undefeatedUserIdText: string;
  anonMinAccountAgeMinutes: number;
  anonMinMemberAgeMinutes: number;
  anonRequiredRoleId: number;
  anonRequiredRoleIdText: string;
  anonCooldownSeconds: number;
  anonAllowLinks: boolean;
  muteallTargetCap: number;
  weeklyDigestChannelId: number;
  weeklyDigestChannelIdText: string;
  weeklyDigestWeekday: number;
  weeklyDigestHour: number;
  answerRetentionDays: number;
  dbFile: string;
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

export interface CourtState {
  mode: BotMode;
  hour: number;
  minute: number;
  channel_id: number;
  log_channel_id: number;
  last_posted_date: string | null;
  dry_run_auto_post: boolean;
  last_dry_run_date: string | null;
  last_weekly_digest_week: string | null;
  history: string[];
  used_questions: string[];
  royal_presence: RoyalPresenceShape;
  royal_afk: RoyalAfkShape;
  posts: PostRecord[];
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
