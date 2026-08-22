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
  version: 3;
  enabled: boolean;
  timezone: string;
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
  "suggestions",
  "applications",
  "safety",
] as const;

export type PanelPreset = (typeof PANEL_PRESETS)[number];

export const GUILD_CAPABILITIES = [
  "panels.manage",
  "tickets.configure",
  "tickets.manage",
  "suggestions.configure",
  "suggestions.review",
  "applications.configure",
  "applications.review",
  "moderation.configure",
  "moderation.manage",
  "reports.review",
  "appeals.review",
] as const;

export const DELEGATED_CAPABILITIES = GUILD_CAPABILITIES;

export type GuildCapability = (typeof GUILD_CAPABILITIES)[number];
export type DelegatedCapability = GuildCapability;
export type Capability = GuildCapability;

/** Storage supports future user principals, but Phase 3 only grants roles. */
export type CapabilityPrincipalType = "role" | "user";

export interface DelegatedCapabilityGrant {
  guildId: string;
  principalType: CapabilityPrincipalType;
  principalId: string;
  capability: GuildCapability;
  active: boolean;
  grantedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface RoleCapabilityGrant extends DelegatedCapabilityGrant {
  principalType: "role";
  roleId: string;
}

export type CapabilityGrantResult = {
  status: "granted" | "duplicate";
  grant: RoleCapabilityGrant;
};

export type CapabilityRevokeResult =
  | { status: "revoked"; grant: RoleCapabilityGrant }
  | { status: "not-found"; grant: null };

export const RESTRICTED_PING_EVENT_TYPES = [
  "mapping_added",
  "mapping_removed",
  "configuration_updated",
  "enabled",
  "disabled",
  "role_deleted",
  "channel_deleted",
  "ping_succeeded",
] as const;

export type RestrictedPingEventType =
  (typeof RESTRICTED_PING_EVENT_TYPES)[number];

export interface RestrictedPingRoleConfiguration {
  guildId: string;
  roleId: string;
  enabled: boolean;
  userCooldownSeconds: number;
  roleCooldownSeconds: number;
  allowThreads: boolean;
  bindingsVerifiedAt: string | null;
  lastRoleSuccessAt: string | null;
  successCount: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface RestrictedPingMapping {
  guildId: string;
  roleId: string;
  channelId: string;
  createdBy: string;
  createdAt: string;
}

export interface RestrictedPingUserCooldown {
  guildId: string;
  roleId: string;
  userId: string;
  lastSuccessAt: string;
  successCount: number;
  updatedAt: string;
}

export interface RestrictedPingEvent {
  guildId: string;
  eventId: string;
  eventNumber: number;
  type: RestrictedPingEventType;
  actorId: string | null;
  roleId: string;
  channelId: string | null;
  userId: string | null;
  source: string;
  details: unknown;
  createdAt: string;
}

export interface RestrictedPingAddMappingInput {
  roleId: string;
  channelId: string;
  createdBy: string;
  enabled?: boolean;
  userCooldownSeconds?: number;
  roleCooldownSeconds?: number;
  allowThreads?: boolean;
  bindingsVerifiedAt?: string | null;
}

export type RestrictedPingAddMappingResult = {
  status: "created" | "duplicate";
  configuration: RestrictedPingRoleConfiguration;
  mapping: RestrictedPingMapping;
};

export type RestrictedPingRemoveMappingResult =
  | {
      status: "removed";
      mapping: RestrictedPingMapping;
      configurationDeleted: boolean;
    }
  | {
      status: "not-found";
      mapping: null;
      configurationDeleted: false;
    };

export interface RestrictedPingConfigureInput {
  updatedBy: string;
  userCooldownSeconds?: number;
  roleCooldownSeconds?: number;
  allowThreads?: boolean;
  bindingsVerifiedAt?: string | null;
}

export interface RestrictedPingReservationInput {
  roleId: string;
  userId: string;
  /** Actual command/send channel, including a thread or forum post ID. */
  channelId: string;
  /** Configured channel ID; differs from channelId only for an allowed child thread. */
  mappingChannelId: string;
  source: string;
}

export type RestrictedPingReservationResult =
  | {
      status: "reserved";
      reservationId: string;
      expiresAt: string;
      configuration: RestrictedPingRoleConfiguration;
    }
  | {
      status: "not-configured" | "disabled" | "channel-not-allowed";
      configuration: RestrictedPingRoleConfiguration | null;
    }
  | {
      status: "active-reservation" | "user-cooldown" | "role-cooldown";
      retryAt: string;
      configuration: RestrictedPingRoleConfiguration;
    };

export type RestrictedPingCompletionResult =
  | {
      status: "completed";
      configuration: RestrictedPingRoleConfiguration;
      event: RestrictedPingEvent;
    }
  | { status: "not-found"; configuration: null; event: null };

export interface RestrictedPingCleanupResult {
  rolesDeleted: number;
  mappingsDeleted: number;
  userCooldownsDeleted: number;
  roleIds: string[];
}

export const FORM_FIELD_TYPES = ["short", "paragraph"] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

export interface TicketConfigurationInput {
  categoryId: string;
  logChannelId: string;
  supportRoleId: string;
  enabled?: boolean;
}

export interface TicketConfiguration {
  guildId: string;
  /** The General Support department backing the Phase 1 compatibility API. */
  departmentId?: string;
  enabled: boolean;
  categoryId: string;
  logChannelId: string;
  supportRoleId: string;
  createdAt: string;
  updatedAt: string;
}

export interface TicketDepartmentInput {
  departmentId?: string;
  slug: string;
  displayName: string;
  description: string;
  emoji?: string | null;
  categoryId?: string | null;
  logChannelId?: string | null;
  supportRoleId?: string | null;
  enabled?: boolean;
  sortOrder?: number;
  bindingsVerifiedAt?: string | null;
}

export interface TicketDepartment {
  guildId: string;
  departmentId: string;
  slug: string;
  displayName: string;
  description: string;
  emoji: string | null;
  categoryId: string | null;
  logChannelId: string | null;
  supportRoleId: string | null;
  enabled: boolean;
  sortOrder: number;
  definitionVersion: number;
  bindingsVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TicketDepartmentUpdate {
  slug?: string;
  displayName?: string;
  description?: string;
  emoji?: string | null;
  categoryId?: string | null;
  logChannelId?: string | null;
  supportRoleId?: string | null;
  enabled?: boolean;
  sortOrder?: number;
  bindingsVerifiedAt?: string | null;
}

export interface TicketDepartmentFieldInput {
  fieldId?: string;
  label: string;
  description?: string | null;
  placeholder?: string | null;
  fieldType: FormFieldType;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  sortOrder?: number;
}

export interface TicketDepartmentField {
  guildId: string;
  departmentId: string;
  fieldId: string;
  label: string;
  description: string | null;
  placeholder: string | null;
  fieldType: FormFieldType;
  required: boolean;
  minLength: number;
  maxLength: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export type TicketDepartmentDeleteResult =
  | { status: "deleted"; department: TicketDepartment }
  | { status: "in-use" | "not-found"; department: TicketDepartment | null };

export interface TicketFormResponseInput {
  fieldId: string;
  fieldLabel: string;
  fieldType: FormFieldType;
  responseText: string;
  sortOrder: number;
}

export interface TicketFormResponse extends TicketFormResponseInput {
  guildId: string;
  ticketId: string;
  responseId: string;
  createdAt: string;
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
  /** Omitted by Phase 1 callers and resolved to General Support. */
  departmentId?: string;
  responses?: readonly TicketFormResponseInput[];
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
  departmentId: string;
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

export const MAX_TICKET_EVENTS_PER_TICKET = 100;

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
  | { status: "existing"; ticket: TicketRecord }
  | { status: "limit"; ticket: TicketRecord; activeCount: number };

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

export interface SuggestionConfigurationInput {
  suggestionChannelId: string;
  reviewChannelId?: string | null;
  reviewerRoleId: string;
  enabled?: boolean;
  createThreads?: boolean;
  cooldownLimit?: number;
  cooldownWindowSeconds?: number;
  allowSelfVotes?: boolean;
  bindingsVerifiedAt?: string | null;
}

export interface SuggestionConfiguration {
  guildId: string;
  enabled: boolean;
  suggestionChannelId: string;
  reviewChannelId: string | null;
  reviewerRoleId: string;
  createThreads: boolean;
  cooldownLimit: number;
  cooldownWindowSeconds: number;
  allowSelfVotes: boolean;
  bindingsVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const SUGGESTION_STATES = [
  "open",
  "under-review",
  "accepted",
  "declined",
  "implemented",
  "withdrawn",
] as const;
export type SuggestionState = (typeof SUGGESTION_STATES)[number];

export const DELIVERY_STATES = [
  "reserved",
  "posted",
  "failed",
  "missing",
] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

export type DeliveryClaimResult<T> =
  | { status: "claimed"; claimId: string; retryAt: string; record: T }
  | { status: "busy"; claimId: null; retryAt: string; record: T }
  | {
      status: "conflict" | "unavailable";
      claimId: null;
      retryAt: null;
      record: T;
    }
  | { status: "not-found"; claimId: null; retryAt: null; record: null };

export interface DeliveryAttempt {
  attemptId: string;
  channelId: string;
  startedAt: string;
}

export interface DeliveryAttemptInput {
  channelId: string;
  claimId: string;
  expectedUpdatedAt: string;
  /** Required when rotating an unresolved attempt to another channel. */
  previousAttemptId?: string;
}

export type DeliveryAttemptTransitionResult<T> =
  | {
      status: "changed" | "unchanged" | "conflict" | "unavailable";
      record: T;
      attempt: DeliveryAttempt | null;
    }
  | { status: "not-found"; record: null; attempt: null };

export interface SuggestionRecord {
  guildId: string;
  suggestionId: string;
  suggestionNumber: number;
  authorId: string;
  title: string;
  details: string;
  state: SuggestionState;
  deliveryState: DeliveryState;
  channelId: string | null;
  messageId: string | null;
  threadId: string | null;
  reviewerId: string | null;
  reviewReason: string | null;
  reviewedAt: string | null;
  withdrawnAt: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SuggestionReservationInput {
  authorId: string;
  title: string;
  details: string;
}

export type SuggestionReservationResult =
  | { status: "created"; suggestion: SuggestionRecord }
  | {
      status: "cooldown";
      suggestion: null;
      recentCount: number;
      retryAt: string;
    }
  | { status: "disabled"; suggestion: null };

export interface SuggestionDeliveryInput {
  channelId: string;
  messageId: string;
  threadId?: string | null;
  expectedUpdatedAt?: string;
}

export type SuggestionDeliveryResult =
  | {
      status:
        | "posted"
        | "already-posted"
        | "failed"
        | "already-failed"
        | "missing"
        | "already-missing"
        | "conflict"
        | "unavailable";
      suggestion: SuggestionRecord;
    }
  | { status: "not-found"; suggestion: null };

export type SuggestionVoteValue = -1 | 1;

export interface SuggestionVote {
  guildId: string;
  suggestionId: string;
  voterId: string;
  vote: SuggestionVoteValue;
  createdAt: string;
  updatedAt: string;
}

export interface SuggestionVoteCounts {
  upvotes: number;
  downvotes: number;
  score: number;
}

export type SuggestionVoteResult =
  | {
      status: "added" | "switched" | "removed" | "unchanged";
      suggestion: SuggestionRecord;
      vote: SuggestionVote | null;
      counts: SuggestionVoteCounts;
    }
  | {
      status: "not-found" | "unavailable" | "self-vote";
      suggestion: SuggestionRecord | null;
      vote: null;
      counts: SuggestionVoteCounts;
    };

export interface SuggestionReviewInput {
  state: Exclude<SuggestionState, "open" | "withdrawn">;
  reviewerId: string;
  reason: string;
}

export type SuggestionTransitionResult =
  | {
      status: "changed" | "unchanged" | "unavailable";
      suggestion: SuggestionRecord;
    }
  | { status: "not-found"; suggestion: null };

export const SUGGESTION_EVENT_TYPES = [
  "submission_reserved",
  "submission_posted",
  "submission_failed",
  "vote_changed",
  "state_changed",
  "withdrawn",
  "rebound",
  "recovery_noted",
] as const;
export type SuggestionEventType = (typeof SUGGESTION_EVENT_TYPES)[number];

export interface SuggestionEventInput {
  type: SuggestionEventType;
  actorId?: string | null;
  details?: unknown;
}

export interface SuggestionEvent {
  guildId: string;
  suggestionId: string;
  eventId: string;
  eventNumber: number;
  type: SuggestionEventType;
  actorId: string | null;
  details: unknown;
  createdAt: string;
}

export interface ApplicationFormInput {
  formId?: string;
  slug: string;
  displayName: string;
  description: string;
  reviewerRoleId: string;
  reviewChannelId: string;
  enabled?: boolean;
  sortOrder?: number;
  bindingsVerifiedAt?: string | null;
}

export interface ApplicationForm {
  guildId: string;
  formId: string;
  slug: string;
  displayName: string;
  description: string;
  reviewerRoleId: string;
  reviewChannelId: string;
  enabled: boolean;
  sortOrder: number;
  definitionVersion: number;
  bindingsVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ApplicationFormUpdate = Partial<
  Omit<ApplicationFormInput, "formId">
>;

export interface ApplicationFormFieldInput {
  fieldId?: string;
  label: string;
  description?: string | null;
  placeholder?: string | null;
  fieldType: FormFieldType;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  sortOrder?: number;
}

export interface ApplicationFormField {
  guildId: string;
  formId: string;
  fieldId: string;
  label: string;
  description: string | null;
  placeholder: string | null;
  fieldType: FormFieldType;
  required: boolean;
  minLength: number;
  maxLength: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export type ApplicationFormDeleteResult =
  | { status: "deleted"; form: ApplicationForm }
  | { status: "in-use" | "not-found"; form: ApplicationForm | null };

export const APPLICATION_STATES = [
  "submitted",
  "under-review",
  "accepted",
  "rejected",
  "withdrawn",
] as const;
export type ApplicationState = (typeof APPLICATION_STATES)[number];

export interface ApplicationResponseInput {
  fieldId: string;
  fieldLabel: string;
  fieldType: FormFieldType;
  responseText: string;
  sortOrder: number;
}

export interface ApplicationResponse extends ApplicationResponseInput {
  guildId: string;
  applicationId: string;
  responseId: string;
  createdAt: string;
}

export interface ApplicationRecord {
  guildId: string;
  applicationId: string;
  applicationNumber: number;
  formId: string;
  applicantId: string;
  state: ApplicationState;
  deliveryState: DeliveryState;
  reviewChannelId: string | null;
  reviewMessageId: string | null;
  claimedBy: string | null;
  claimedAt: string | null;
  decisionBy: string | null;
  decisionReason: string | null;
  decidedAt: string | null;
  withdrawnAt: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationReservationInput {
  formId: string;
  applicantId: string;
  responses: readonly ApplicationResponseInput[];
}

export type ApplicationReservationResult =
  | { status: "created"; application: ApplicationRecord }
  | { status: "existing"; application: ApplicationRecord }
  | { status: "disabled"; application: null };

export interface ApplicationDeliveryInput {
  reviewChannelId: string;
  reviewMessageId: string;
  expectedUpdatedAt?: string;
}

export type ApplicationDeliveryResult =
  | {
      status:
        | "posted"
        | "already-posted"
        | "failed"
        | "already-failed"
        | "missing"
        | "already-missing"
        | "conflict"
        | "unavailable";
      application: ApplicationRecord;
    }
  | { status: "not-found"; application: null };

export interface ApplicationDecisionInput {
  state: Extract<ApplicationState, "accepted" | "rejected">;
  reviewerId: string;
  reason: string;
  expectedUpdatedAt?: string;
}

export type ApplicationTransitionResult =
  | {
      status: "changed" | "unchanged" | "conflict" | "unavailable";
      application: ApplicationRecord;
    }
  | { status: "not-found"; application: null };

export const APPLICATION_EVENT_TYPES = [
  "submission_reserved",
  "submission_posted",
  "submission_failed",
  "claimed",
  "decision_recorded",
  "withdrawn",
  "rebound",
  "recovery_noted",
] as const;
export type ApplicationEventType = (typeof APPLICATION_EVENT_TYPES)[number];

export interface ApplicationEventInput {
  type: ApplicationEventType;
  actorId?: string | null;
  details?: unknown;
}

export interface ApplicationEvent {
  guildId: string;
  applicationId: string;
  eventId: string;
  eventNumber: number;
  type: ApplicationEventType;
  actorId: string | null;
  details: unknown;
  createdAt: string;
}

export interface ModerationConfigurationInput {
  casesEnabled?: boolean;
  moderationLogChannelId?: string | null;
  moderationLogVerifiedAt?: string | null;
  reportsEnabled?: boolean;
  reportReviewChannelId?: string | null;
  reportReviewerRoleId?: string | null;
  reportBindingsVerifiedAt?: string | null;
  appealsEnabled?: boolean;
  appealReviewChannelId?: string | null;
  appealReviewerRoleId?: string | null;
  appealBindingsVerifiedAt?: string | null;
  antiSpamEnabled?: boolean;
  reportCooldownLimit?: number;
  reportCooldownWindowSeconds?: number;
  actorId: string;
}

export interface ModerationConfiguration {
  guildId: string;
  casesEnabled: boolean;
  moderationLogChannelId: string | null;
  moderationLogVerifiedAt: string | null;
  reportsEnabled: boolean;
  reportReviewChannelId: string | null;
  reportReviewerRoleId: string | null;
  reportBindingsVerifiedAt: string | null;
  appealsEnabled: boolean;
  appealReviewChannelId: string | null;
  appealReviewerRoleId: string | null;
  appealBindingsVerifiedAt: string | null;
  antiSpamEnabled: boolean;
  reportCooldownLimit: number;
  reportCooldownWindowSeconds: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export const MODERATION_CASE_ACTION_TYPES = [
  "warning",
  "note",
  "timeout",
  "timeout-removed",
  "kick",
  "ban",
  "unban",
  "automod-warning",
  "automod-timeout",
] as const;
export type ModerationCaseActionType =
  (typeof MODERATION_CASE_ACTION_TYPES)[number];

export const MODERATION_CASE_SOURCES = [
  "moderation-command",
  "superior-command",
  "anti-spam",
  "appeal-review",
  "import",
] as const;
export type ModerationCaseSource = (typeof MODERATION_CASE_SOURCES)[number];

export const MODERATION_CASE_STATUSES = [
  "active",
  "completed",
  "voided",
  "overturned",
  "failed",
] as const;
export type ModerationCaseStatus = (typeof MODERATION_CASE_STATUSES)[number];

export interface ModerationCaseInput {
  targetUserId: string;
  actorId: string;
  actionType: ModerationCaseActionType;
  source: ModerationCaseSource;
  publicReason: string;
  privateNote?: string | null;
  discordActionMetadata?: unknown;
  status: ModerationCaseStatus;
  relatedCaseId?: string | null;
}

export type ModerationCaseAttemptInput = Omit<ModerationCaseInput, "status">;

export interface ModerationCase {
  guildId: string;
  caseId: string;
  caseNumber: number;
  targetUserId: string;
  actorId: string;
  actionType: ModerationCaseActionType;
  source: ModerationCaseSource;
  publicReason: string;
  privateNote: string | null;
  discordActionMetadata: unknown;
  status: ModerationCaseStatus;
  relatedCaseId: string | null;
  voidedBy: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  overturnedBy: string | null;
  overturnedAt: string | null;
  overturnReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModerationCaseListFilter {
  targetUserId?: string;
  statuses?: readonly ModerationCaseStatus[];
  actionTypes?: readonly ModerationCaseActionType[];
  limit?: number;
  offset?: number;
}

export type ActiveModerationCaseLookupResult =
  | { status: "found"; case: ModerationCase }
  | { status: "none" | "ambiguous"; case: null };

export interface ExpiredTimeoutCaseCompletionInput {
  actorId: string;
  observedAt: string;
  expectedUpdatedAt: string;
}

export interface ModerationCaseAmendInput {
  actorId: string;
  publicReason?: string;
  privateNote?: string | null;
  expectedUpdatedAt?: string;
}

export type ModerationCaseTransitionResult =
  | {
      status: "changed" | "unchanged" | "conflict" | "unavailable";
      case: ModerationCase;
    }
  | { status: "not-found"; case: null };

export type ModerationTimeoutRemovalFinalizeResult =
  | {
      status: "changed" | "unchanged" | "conflict" | "unavailable";
      removalCase: ModerationCase;
      originalCase: ModerationCase;
    }
  | {
      status: "not-found";
      removalCase: ModerationCase | null;
      originalCase: ModerationCase | null;
    };

export type TimeoutAppealRemovalCheckpointResult =
  | {
      status: "changed" | "unchanged" | "conflict" | "unavailable";
      appeal: CaseAppeal;
      originalCase: ModerationCase;
      removalCase: ModerationCase;
    }
  | {
      status: "not-found";
      appeal: CaseAppeal | null;
      originalCase: ModerationCase | null;
      removalCase: ModerationCase | null;
    };

export interface TimeoutAppealRemovalCheckpointInput {
  reviewerId: string;
  originalExpiresAt: string;
  discordActionMetadata?: unknown;
  appealExpectedUpdatedAt: string;
  removalExpectedUpdatedAt: string;
  originalExpectedUpdatedAt: string;
}

export interface TimeoutAppealRemovalCheckpointProof {
  kind: "timeout-appeal-removal-confirmed";
  appealId: string;
  originalCaseId: string;
  originalExpiresAt: string;
  reviewerId: string;
}

export const MODERATION_CASE_EVENT_TYPES = [
  "created",
  "action-reserved",
  "action-confirmed-pending",
  "action-confirmed",
  "action-failed",
  "amended",
  "completed",
  "voided",
  "overturned",
  "log-delivered",
  "log-failed",
  "timeout-expired",
  "recovery-noted",
] as const;
export type ModerationCaseEventType =
  (typeof MODERATION_CASE_EVENT_TYPES)[number];

export interface ModerationCaseEventInput {
  type: ModerationCaseEventType;
  actorId?: string | null;
  details?: unknown;
}

export interface ModerationCaseEvent {
  guildId: string;
  caseId: string;
  eventId: string;
  eventNumber: number;
  type: ModerationCaseEventType;
  actorId: string | null;
  details: unknown;
  createdAt: string;
}

export type ModerationLogDeliveryState =
  "pending" | "delivered" | "failed" | "missing";

export interface ModerationLogDelivery {
  guildId: string;
  caseId: string;
  state: ModerationLogDeliveryState;
  channelId: string | null;
  messageId: string | null;
  attemptCount: number;
  lastFailureCode: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ModerationLogDeliveryTransitionResult =
  | {
      status: "changed" | "unchanged" | "conflict" | "unavailable";
      delivery: ModerationLogDelivery;
    }
  | { status: "not-found"; delivery: null };

export const MEMBER_REPORT_CATEGORIES = [
  "harassment",
  "spam",
  "scam",
  "safety",
  "other",
] as const;
export type MemberReportCategory = (typeof MEMBER_REPORT_CATEGORIES)[number];
export const MEMBER_REPORT_STATES = [
  "submitted",
  "under-review",
  "resolved",
  "dismissed",
  "withdrawn",
] as const;
export type MemberReportState = (typeof MEMBER_REPORT_STATES)[number];

export interface MemberReportReservationInput {
  reporterId: string;
  targetUserId: string;
  category: MemberReportCategory;
  explanation: string;
  evidenceGuildId?: string | null;
  evidenceChannelId?: string | null;
  evidenceMessageId?: string | null;
}

export interface MemberReport {
  guildId: string;
  reportId: string;
  reportNumber: number;
  reporterId: string;
  targetUserId: string;
  category: MemberReportCategory;
  explanation: string;
  evidenceGuildId: string | null;
  evidenceChannelId: string | null;
  evidenceMessageId: string | null;
  state: MemberReportState;
  deliveryState: DeliveryState;
  reviewChannelId: string | null;
  reviewMessageId: string | null;
  claimedBy: string | null;
  claimedAt: string | null;
  decisionBy: string | null;
  decisionReason: string | null;
  decidedAt: string | null;
  linkedCaseId: string | null;
  withdrawnAt: string | null;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export type MemberReportReservationResult =
  | { status: "created"; report: MemberReport }
  | { status: "cooldown"; report: null; recentCount: number; retryAt: string }
  | { status: "disabled"; report: null };

export type MemberReportTransitionResult =
  | {
      status: "changed" | "unchanged" | "conflict" | "unavailable";
      report: MemberReport;
    }
  | { status: "not-found"; report: null };

export interface MemberReportDecisionInput {
  state: "resolved" | "dismissed";
  reviewerId: string;
  reason: string;
  linkedCaseId?: string | null;
  expectedUpdatedAt?: string;
}

export interface MemberReportEvent {
  guildId: string;
  reportId: string;
  eventId: string;
  eventNumber: number;
  type: string;
  actorId: string | null;
  details: unknown;
  createdAt: string;
}

export const CASE_APPEAL_STATES = [
  "submitted",
  "under-review",
  "upheld",
  "overturned",
  "withdrawn",
] as const;
export type CaseAppealState = (typeof CASE_APPEAL_STATES)[number];

export interface CaseAppealReservationInput {
  caseId: string;
  appellantId: string;
  explanation: string;
}

export interface CaseAppeal {
  guildId: string;
  appealId: string;
  appealNumber: number;
  caseId: string;
  appellantId: string;
  explanation: string;
  state: CaseAppealState;
  deliveryState: DeliveryState;
  reviewChannelId: string | null;
  reviewMessageId: string | null;
  claimedBy: string | null;
  claimedAt: string | null;
  decisionBy: string | null;
  decisionReason: string | null;
  decidedAt: string | null;
  reversalCaseId: string | null;
  withdrawnAt: string | null;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export type CaseAppealReservationResult =
  | { status: "created"; appeal: CaseAppeal }
  | {
      status: "existing" | "disabled" | "ineligible";
      appeal: CaseAppeal | null;
    };

export type CaseAppealTransitionResult =
  | {
      status: "changed" | "unchanged" | "conflict" | "unavailable";
      appeal: CaseAppeal;
    }
  | { status: "not-found"; appeal: null };

export type CaseAppealOverturnFinalizeResult =
  | {
      status: "changed" | "unchanged" | "conflict" | "unavailable";
      appeal: CaseAppeal;
      originalCase: ModerationCase;
      reversalCase: ModerationCase | null;
    }
  | {
      status: "not-found";
      appeal: CaseAppeal | null;
      originalCase: ModerationCase | null;
      reversalCase: ModerationCase | null;
    };

export interface CaseAppealDecisionInput {
  state: "upheld" | "overturned";
  reviewerId: string;
  reason: string;
  reversalCaseId?: string | null;
  expectedUpdatedAt?: string;
}

export interface CaseAppealEvent {
  guildId: string;
  appealId: string;
  eventId: string;
  eventNumber: number;
  type: string;
  actorId: string | null;
  details: unknown;
  createdAt: string;
}

export const ANTI_SPAM_RULE_TYPES = ["burst", "duplicate", "mention"] as const;
export type AntiSpamRuleType = (typeof ANTI_SPAM_RULE_TYPES)[number];
export const ANTI_SPAM_ACTIONS = [
  "delete",
  "delete-and-warn",
  "delete-and-timeout",
] as const;
export type AntiSpamAction = (typeof ANTI_SPAM_ACTIONS)[number];

export interface AntiSpamRuleInput {
  ruleType: AntiSpamRuleType;
  enabled?: boolean;
  threshold: number;
  windowSeconds?: number | null;
  action: AntiSpamAction;
  timeoutSeconds?: number | null;
  cooldownSeconds: number;
  actorId: string;
}

export interface AntiSpamRule {
  guildId: string;
  ruleType: AntiSpamRuleType;
  enabled: boolean;
  threshold: number;
  windowSeconds: number | null;
  action: AntiSpamAction;
  timeoutSeconds: number | null;
  cooldownSeconds: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AntiSpamExemption {
  guildId: string;
  subjectId: string;
  createdBy: string;
  createdAt: string;
}

export interface AntiSpamEnforcementReservationInput {
  ruleType: AntiSpamRuleType;
  messageId: string;
  memberId: string;
  channelId: string;
  observedCount: number;
}

export type AntiSpamEnforcementOutcome =
  "deleted" | "warned" | "timed-out" | "failed" | "skipped";

export interface AntiSpamEnforcement {
  guildId: string;
  enforcementId: string;
  ruleType: AntiSpamRuleType;
  messageId: string;
  memberId: string;
  channelId: string;
  observedCount: number;
  state: "reserved" | AntiSpamEnforcementOutcome;
  reservationId: string | null;
  caseId: string | null;
  failureCode: string | null;
  reservationExpiresAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AntiSpamEnforcementReservationResult =
  | {
      status: "reserved";
      reservationId: string;
      retryAt: null;
      enforcement: AntiSpamEnforcement;
    }
  | {
      status: "duplicate";
      reservationId: null;
      retryAt: string | null;
      enforcement: AntiSpamEnforcement;
    }
  | {
      status: "cooldown";
      reservationId: null;
      retryAt: string;
      enforcement: AntiSpamEnforcement | null;
    };

export interface AntiSpamEnforcementCompletionInput {
  outcome: AntiSpamEnforcementOutcome;
  caseId?: string | null;
  failureCode?: string | null;
}

export interface AntiSpamEvent {
  guildId: string;
  eventId: string;
  eventNumber: number;
  ruleType: AntiSpamRuleType;
  messageId: string;
  memberId: string;
  channelId: string;
  observedCount: number;
  outcome: AntiSpamEnforcementOutcome;
  caseId: string | null;
  failureCode: string | null;
  createdAt: string;
}

/** Portable, tenant-scoped export of the active product data model. */
export interface GuildDataExport {
  formatVersion: 7;
  guildId: string;
  exportedAt: string;
  metadata: GuildRecord;
  settings: GuildSettings;
  metrics: GuildMetricExport[];
  delegatedCapabilityGrants: DelegatedCapabilityGrant[];
  ticketDepartments: TicketDepartment[];
  ticketDepartmentFields: TicketDepartmentField[];
  postedPanels: PostedPanel[];
  tickets: TicketRecord[];
  ticketFormResponses: TicketFormResponse[];
  ticketEvents: TicketEvent[];
  suggestionConfiguration: SuggestionConfiguration | null;
  suggestions: SuggestionRecord[];
  suggestionVotes: SuggestionVote[];
  suggestionEvents: SuggestionEvent[];
  applicationForms: ApplicationForm[];
  applicationFormFields: ApplicationFormField[];
  applications: ApplicationRecord[];
  applicationResponses: ApplicationResponse[];
  applicationEvents: ApplicationEvent[];
  restrictedPingRoles: RestrictedPingRoleConfiguration[];
  restrictedPingMappings: RestrictedPingMapping[];
  restrictedPingUserCooldowns: RestrictedPingUserCooldown[];
  restrictedPingEvents: RestrictedPingEvent[];
  moderationConfiguration: ModerationConfiguration | null;
  moderationCases: ModerationCase[];
  moderationCaseEvents: ModerationCaseEvent[];
  moderationLogDeliveries: ModerationLogDelivery[];
  memberReports: MemberReport[];
  memberReportEvents: MemberReportEvent[];
  caseAppeals: CaseAppeal[];
  caseAppealEvents: CaseAppealEvent[];
  antiSpamRules: AntiSpamRule[];
  antiSpamExemptRoles: AntiSpamExemption[];
  antiSpamExemptChannels: AntiSpamExemption[];
  antiSpamEnforcements: AntiSpamEnforcement[];
  antiSpamEvents: AntiSpamEvent[];
}

export interface GuildPurgeResult {
  guildId: string;
  guilds: number;
  settings: number;
  metrics: number;
  delegatedCapabilityGrants: number;
  ticketDepartments: number;
  ticketDepartmentFields: number;
  postedPanels: number;
  tickets: number;
  ticketFormResponses: number;
  ticketEvents: number;
  suggestionConfigurations: number;
  suggestions: number;
  suggestionVotes: number;
  suggestionEvents: number;
  applicationForms: number;
  applicationFormFields: number;
  applications: number;
  applicationResponses: number;
  applicationEvents: number;
  restrictedPingRoles: number;
  restrictedPingMappings: number;
  restrictedPingUserCooldowns: number;
  restrictedPingEvents: number;
  mudaeWatchDeliveries: number;
  moderationConfigurations: number;
  moderationCases: number;
  moderationCaseEvents: number;
  moderationLogDeliveries: number;
  memberReports: number;
  memberReportEvents: number;
  caseAppeals: number;
  caseAppealEvents: number;
  antiSpamRules: number;
  antiSpamExemptRoles: number;
  antiSpamExemptChannels: number;
  antiSpamEnforcements: number;
  antiSpamEvents: number;
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
