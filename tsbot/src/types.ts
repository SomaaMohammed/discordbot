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

export const PANEL_PRESETS = [
  "help",
  "server-info",
  "resources",
  "tickets",
] as const;

export type PanelPreset = (typeof PANEL_PRESETS)[number];

export interface TicketConfigurationInput {
  categoryId: string;
  logChannelId: string;
  supportRoleId: string;
  enabled?: boolean;
}

export interface TicketConfiguration {
  guildId: string;
  enabled: boolean;
  categoryId: string;
  logChannelId: string;
  supportRoleId: string;
  createdAt: string;
  updatedAt: string;
}

export interface PostedPanelInput {
  panelId?: string;
  preset: PanelPreset;
  channelId: string;
  messageId: string;
  configuration?: unknown;
}

export interface PostedPanel {
  guildId: string;
  panelId: string;
  preset: PanelPreset;
  channelId: string;
  messageId: string;
  configuration: unknown;
  createdAt: string;
  updatedAt: string;
}

export const TICKET_STATES = [
  "creating",
  "open",
  "closing",
  "closed",
  "failed",
] as const;

export type TicketState = (typeof TICKET_STATES)[number];

export interface TicketCreationInput {
  openerId: string;
  subject: string;
  description: string;
}

export interface TicketActivationInput {
  channelId: string;
  controlMessageId?: string | null;
}

export interface TicketRebindInput {
  channelId?: string;
  controlMessageId?: string | null;
  expectedChannelId?: string | null;
  expectedControlMessageId?: string | null;
  expectedState?: TicketState;
  expectedUpdatedAt?: string;
}

export interface TicketRecord {
  guildId: string;
  ticketId: string;
  ticketNumber: number;
  openerId: string;
  channelId: string | null;
  controlMessageId: string | null;
  subject: string;
  description: string;
  state: TicketState;
  claimedBy: string | null;
  claimedAt: string | null;
  closedBy: string | null;
  closeReason: string | null;
  closeLogMessageId: string | null;
  closeLoggedAt: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
  closingAt: string | null;
  closedAt: string | null;
}

export const TICKET_EVENT_TYPES = [
  "creation_reserved",
  "creation_activated",
  "creation_failed",
  "claimed",
  "released",
  "close_started",
  "close_logged",
  "close_failed",
  "closed",
  "rebound",
  "recovery_noted",
] as const;

export type TicketEventType = (typeof TICKET_EVENT_TYPES)[number];

export interface TicketEventInput {
  type: TicketEventType;
  actorId?: string | null;
  details?: unknown;
}

export interface TicketEvent {
  guildId: string;
  ticketId: string;
  eventId: string;
  eventNumber: number;
  type: TicketEventType;
  actorId: string | null;
  details: unknown;
  createdAt: string;
}

export type TicketReservationResult =
  | { status: "created"; ticket: TicketRecord }
  | { status: "existing"; ticket: TicketRecord };

export type TicketActivationResult =
  | {
      status: "activated" | "already-active" | "unavailable";
      ticket: TicketRecord;
    }
  | { status: "not-found"; ticket: null };

export type TicketCreationFailureResult =
  | {
      status: "failed" | "already-failed" | "unavailable";
      ticket: TicketRecord;
    }
  | { status: "not-found"; ticket: null };

export type TicketClaimResult =
  | {
      status: "claimed" | "already-claimed" | "conflict" | "unavailable";
      ticket: TicketRecord;
    }
  | { status: "not-found"; ticket: null };

export type TicketReleaseResult =
  | {
      status: "released" | "already-released" | "unavailable";
      ticket: TicketRecord;
    }
  | { status: "not-found"; ticket: null };

export type TicketCloseStartResult =
  | {
      status: "started" | "already-closing" | "already-closed" | "unavailable";
      ticket: TicketRecord;
    }
  | { status: "not-found"; ticket: null };

export type TicketCloseRollbackResult =
  | {
      status: "reopened" | "already-open" | "unavailable";
      ticket: TicketRecord;
    }
  | { status: "not-found"; ticket: null };

export type TicketCloseLogResult =
  | {
      status: "logged" | "already-logged" | "conflict" | "unavailable";
      ticket: TicketRecord;
    }
  | { status: "not-found"; ticket: null };

export type TicketCloseFinishResult =
  | {
      status: "closed" | "already-closed" | "unavailable";
      ticket: TicketRecord;
    }
  | { status: "not-found"; ticket: null };

export type TicketRebindResult =
  | {
      status: "rebound" | "conflict" | "unavailable";
      ticket: TicketRecord;
    }
  | { status: "not-found"; ticket: null };

/** Portable, tenant-scoped export of the active product data model. */
export interface GuildDataExport {
  formatVersion: 3;
  guildId: string;
  exportedAt: string;
  metadata: GuildRecord;
  settings: GuildSettings;
  metrics: GuildMetricExport[];
  ticketConfiguration: TicketConfiguration | null;
  postedPanels: PostedPanel[];
  tickets: TicketRecord[];
  ticketEvents: TicketEvent[];
}

export interface GuildPurgeResult {
  guildId: string;
  guilds: number;
  settings: number;
  metrics: number;
  ticketConfigurations: number;
  postedPanels: number;
  tickets: number;
  ticketEvents: number;
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
