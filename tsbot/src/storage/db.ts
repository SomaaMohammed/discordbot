import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import Database from "better-sqlite3";
import {
  assertDiscordSnowflake,
  createDefaultGuildSettings,
  parseGuildSettingsJson,
  sanitizeGuildSettings,
  serializeGuildSettings,
} from "../guild-settings.js";
import { observeLatencySync } from "../latency.js";
import type {
  CapabilityGrantResult,
  CapabilityRevokeResult,
  GuildCapability,
  GuildDataExport,
  GuildMetricExport,
  GuildPurgeResult,
  GuildRecord,
  GuildSettings,
  ActiveModerationCaseLookupResult,
  DeliveryAttempt,
  DeliveryAttemptInput,
  DeliveryAttemptTransitionResult,
  DeliveryClaimResult,
  ModerationCase,
  ModerationCaseActionType,
  ModerationCaseSource,
  ModerationCaseAmendInput,
  ModerationCaseAttemptInput,
  ModerationCaseEvent,
  ModerationCaseEventInput,
  ModerationCaseInput,
  ModerationCaseListFilter,
  ModerationCaseTransitionResult,
  ExpiredTimeoutCaseCompletionInput,
  ModerationTimeoutRemovalFinalizeResult,
  ModerationConfiguration,
  ModerationConfigurationInput,
  ModerationLogDelivery,
  ModerationLogDeliveryTransitionResult,
  MemberReport,
  MemberReportDecisionInput,
  MemberReportEvent,
  MemberReportReservationInput,
  MemberReportReservationResult,
  MemberReportTransitionResult,
  CaseAppeal,
  CaseAppealDecisionInput,
  CaseAppealEvent,
  CaseAppealReservationInput,
  CaseAppealReservationResult,
  CaseAppealTransitionResult,
  CaseAppealOverturnFinalizeResult,
  TimeoutAppealRemovalCheckpointInput,
  TimeoutAppealRemovalCheckpointResult,
  AntiSpamRule,
  AntiSpamRuleInput,
  AntiSpamRuleType,
  AntiSpamExemption,
  AntiSpamEnforcement,
  AntiSpamEnforcementCompletionInput,
  AntiSpamEnforcementReservationInput,
  AntiSpamEnforcementReservationResult,
  AntiSpamEvent,
  RoleCapabilityGrant,
  PanelPreset,
  PostedPanel,
  PostedPanelInput,
  ProcessConfig,
  TicketActivationInput,
  TicketActivationResult,
  TicketClaimResult,
  TicketCloseFinishResult,
  TicketCloseLogResult,
  TicketCloseRollbackResult,
  TicketCloseStartResult,
  TicketConfiguration,
  TicketConfigurationInput,
  TicketCreationFailureResult,
  TicketCreationInput,
  TicketEvent,
  TicketEventInput,
  TicketRebindInput,
  TicketRebindResult,
  TicketRecord,
  TicketReleaseResult,
  TicketReservationResult,
  TicketState,
  UserActivityMetric,
  UserLeaderboardEntry,
  UserMetrics,
  VotingPanel,
  VotingPanelInput,
  VotingPanelSelectionResult,
  VotingPanelTransitionResult,
  VotingPanelVoter,
} from "../types.js";
import { USER_ACTIVITY_METRICS } from "../types.js";
import {
  assertActiveMetricKey,
  assertUserActivityMetric,
  buildUserMetricKey,
  commandMetricKey,
} from "./metric-keys.js";
import {
  detectDatabaseSchema,
  initializeV11Schema,
  validateV11Schema,
} from "./schema.js";
import { GuildOperationalRepository } from "./operational-repository.js";
import { GuildAccessRepository } from "./access-repository.js";
import { TicketDepartmentRepository } from "./ticket-department-repository.js";
import { SuggestionRepository } from "./suggestion-repository.js";
import { RestrictedPingRepository } from "./restricted-ping-repository.js";
import { ModerationCaseRepository } from "./moderation-case-repository.js";
import { AntiSpamRepository } from "./anti-spam-repository.js";
import { GuildVotingRepository } from "./voting-repository.js";
import {
  CaseAppealRepository,
  MemberReportRepository,
  type CaseAppealListFilter,
  type CaseAppealActorInput,
  type CaseAppealWithdrawInput,
  type DeliveryBindingInput,
  type DeliveryFailureInput,
  type DeliveryMissingInput,
  type DeliveryOrphanCheckpointInput,
  type MemberReportActorInput,
  type MemberReportListFilter,
  type MemberReportWithdrawInput,
  type ReviewClaimReleaseInput,
  type ReviewClaimTakeoverInput,
} from "./report-appeal-repository.js";
import {
  MudaeWatchDeliveryRepository,
  pruneAllMudaeWatchDeliveries,
  type MudaeWatchDeliveryOutcome,
  type MudaeWatchDeliveryRecord,
  type MudaeWatchDeliveryReservationResult,
} from "./mudae-watch-delivery-repository.js";
import {
  ApplicationRepository,
  type ApplicationListFilter,
} from "./application-repository.js";
import type {
  ApplicationDecisionInput,
  ApplicationDeliveryInput,
  ApplicationDeliveryResult,
  ApplicationEvent,
  ApplicationEventInput,
  ApplicationForm,
  ApplicationFormDeleteResult,
  ApplicationFormField,
  ApplicationFormFieldInput,
  ApplicationFormInput,
  ApplicationFormUpdate,
  ApplicationRecord,
  ApplicationReservationInput,
  ApplicationReservationResult,
  ApplicationResponse,
  ApplicationTransitionResult,
  SuggestionConfiguration,
  SuggestionConfigurationInput,
  SuggestionDeliveryInput,
  SuggestionDeliveryResult,
  SuggestionEvent,
  SuggestionEventInput,
  SuggestionRecord,
  SuggestionReservationInput,
  SuggestionReservationResult,
  SuggestionReviewInput,
  SuggestionState,
  SuggestionTransitionResult,
  SuggestionVote,
  SuggestionVoteCounts,
  SuggestionVoteResult,
  SuggestionVoteValue,
  RestrictedPingAddMappingInput,
  RestrictedPingAddMappingResult,
  RestrictedPingCleanupResult,
  RestrictedPingCompletionResult,
  RestrictedPingConfigureInput,
  RestrictedPingEvent,
  RestrictedPingMapping,
  RestrictedPingRemoveMappingResult,
  RestrictedPingReservationInput,
  RestrictedPingReservationResult,
  RestrictedPingRoleConfiguration,
  TicketDepartment,
  TicketDepartmentDeleteResult,
  TicketDepartmentField,
  TicketDepartmentFieldInput,
  TicketDepartmentInput,
  TicketDepartmentUpdate,
  TicketFormResponse,
} from "../types.js";
import {
  GUILD_DATA_COLLECTION_LIMITS,
  insertImportedOperationalData,
  insertPhase3GuildData,
  parseGuildDataExport,
} from "./guild-data.js";
import {
  deactivatePhase2OperationalBindings,
  PHASE2_GUILD_TABLES,
  readPhase2OperationalData,
} from "./guild-data-v4.js";
import {
  deactivateRestrictedPingBindings,
  readRestrictedPingGuildData,
  RESTRICTED_PING_GUILD_TABLES,
} from "./guild-data-v5.js";
import {
  deactivatePhase3Bindings,
  PHASE3_GUILD_TABLES,
  readPhase3GuildData,
} from "./guild-data-v7.js";
import {
  deactivatePhase4Bindings,
  insertPhase4GuildData,
  PHASE4_GUILD_TABLES,
  readPhase4GuildData,
} from "./guild-data-v8.js";
import type { OnboardingLifecycleDefinitionSnapshot } from "../discord/onboarding-repository.js";
import { OnboardingStorageRepository } from "./onboarding-repository.js";
import {
  RoleMenuRepository,
  type RoleMenuListOptions,
  type RoleMenuOperationListOptions,
  type RoleMenuPostListOptions,
} from "./role-menu-repository.js";
import type {
  MemberOnboardingState,
  MemberOnboardingStateInput,
  MemberRuleAcceptance,
  MemberRuleAcceptanceInput,
  MemberRuleAcceptanceResult,
  OnboardingAuditEvent,
  OnboardingAuditEventInput,
  OnboardingAutorole,
  OnboardingAutoroleAudience,
  OnboardingAutoroleInput,
  OnboardingConfiguration,
  OnboardingConfigurationInput,
  OnboardingDeliveryCompletionInput,
  OnboardingDeliveryRecord,
  OnboardingDeliveryReservationInput,
  OnboardingDeliveryReservationResult,
  OnboardingRoleOperation,
  OnboardingRoleOperationCompletionInput,
  OnboardingRoleOperationReservationInput,
  OnboardingRoleOperationReservationResult,
  OnboardingRulesActivationInput,
  OnboardingRulesActivationResult,
  OnboardingRulesVersion,
  OnboardingRulesVersionInput,
  RoleMenu,
  RoleMenuInput,
  RoleMenuOperation,
  RoleMenuOperationCompletionInput,
  RoleMenuOperationReservationInput,
  RoleMenuOperationReservationResult,
  RoleMenuOption,
  RoleMenuOptionInput,
  RoleMenuOptionUpdateInput,
  RoleMenuPost,
  RoleMenuPostInput,
  RoleMenuPostState,
  RoleMenuState,
  RoleMenuUpdateInput,
} from "../types.js";
export { createOpaqueStorageId } from "./operational-repository.js";

interface GuildRow {
  guild_id: string;
  enabled: number;
  name: string | null;
  joined_at: string | null;
  left_at: string | null;
  created_at: string;
  updated_at: string;
}

interface GuildSettingsRow {
  settings_version: number;
  settings_json: string;
}

interface MetricRow {
  metric_key: string;
  metric_value: number;
  updated_at: string;
}

const HISTORY_ACTIVITY_METRICS = [
  "messages_sent",
  "reactions_sent",
  "reactions_received",
] as const satisfies readonly UserActivityMetric[];

export class GuildSettingsConflictError extends Error {
  public constructor(guildId: string) {
    super(`Guild ${guildId} settings changed while the operation was running`);
    this.name = "GuildSettingsConflictError";
  }
}

export interface GuildEnableExpectation {
  settings: GuildSettings;
  lifecycleJoinedAt: string | null;
}

export interface UserMetricReplacement {
  userId: string;
  metrics: UserMetrics;
}

export class BotStorage {
  private db: Database.Database | null = null;
  private nonessentialScheduler:
    ((task: () => void | Promise<void>) => void) | null = null;

  public constructor(private readonly config: Pick<ProcessConfig, "dbFile">) {}

  /**
   * Opens writable storage only after a separate read-only connection has
   * classified every existing on-disk database.
   */
  public initStorage(): void {
    if (this.db?.open) {
      return;
    }
    const dbFile = this.config.dbFile;
    if (dbFile === ":memory:") {
      const memory = new Database(":memory:", { timeout: 5_000 });
      try {
        memory.pragma("foreign_keys = ON");
        initializeV11Schema(memory, utcNow());
        this.db = memory;
      } catch (error) {
        memory.close();
        throw error;
      }
      return;
    }

    let schema: ReturnType<typeof detectDatabaseSchema> = "empty";
    if (fs.existsSync(dbFile)) {
      const readonly = new Database(dbFile, {
        readonly: true,
        fileMustExist: true,
        timeout: 5_000,
      });
      try {
        readonly.pragma("foreign_keys = ON");
        schema = detectDatabaseSchema(readonly);
      } finally {
        readonly.close();
      }
    }

    if (schema === "legacy-v1") {
      throw new Error(
        "Database schema v1 is not supported by v11 startup. Upgrade through the final v4 release to schema v2, create an offline backup, stop every older executable, then run the current migration command.",
      );
    }
    if (schema === "legacy-v2") {
      throw new Error(
        `Database schema v2 requires an explicit migration. Stop the bot, create an offline backup, then run npm run migrate -- --db ${dbFile}`,
      );
    }
    if (schema === "legacy-v3") {
      throw new Error(
        `Database schema v3 requires an explicit migration. Stop the bot, create an offline backup, then run npm run migrate -- --db ${dbFile}`,
      );
    }
    if (schema === "legacy-v4") {
      throw new Error(
        `Database schema v4 requires an explicit migration. Stop the bot, create an offline backup, then run npm run migrate -- --db ${dbFile}`,
      );
    }
    if (schema === "legacy-v5") {
      throw new Error(
        `Database schema v5 requires an explicit migration. Stop the bot, create an offline backup, then run npm run migrate -- --db ${dbFile}`,
      );
    }
    if (schema === "legacy-v6") {
      throw new Error(
        `Database schema v6 requires an explicit migration. Stop the bot, create an offline backup, then run npm run migrate -- --db ${dbFile}`,
      );
    }
    if (schema === "legacy-v7") {
      throw new Error(
        `Database schema v7 requires an explicit migration to v11. Stop every older Superior executable, create an offline backup, then run npm run migrate -- --db ${dbFile}.`,
      );
    }
    if (schema === "legacy-v8") {
      throw new Error(
        `Database schema v8 requires an explicit migration to v11. Stop every older Superior executable, create an offline backup, then run npm run migrate -- --db ${dbFile}.`,
      );
    }
    if (schema === "legacy-v9") {
      throw new Error(
        `Database schema v9 requires an explicit migration to v11. Stop every older Superior executable, create an offline backup, then run npm run migrate -- --db ${dbFile}.`,
      );
    }
    if (schema === "legacy-v10") {
      throw new Error(
        `Database schema v10 requires an explicit migration to v11. Stop every older Superior executable, create an offline backup, then run npm run migrate -- --db ${dbFile}.`,
      );
    }
    if (schema === "unknown") {
      throw new Error(
        "Database schema is unknown or incomplete; startup refused without modifying it",
      );
    }

    const writable = new Database(dbFile, { timeout: 5_000 });
    try {
      writable.pragma("foreign_keys = ON");
      if (schema === "empty") {
        initializeV11Schema(writable, utcNow());
      } else {
        const issues = validateV11Schema(writable);
        if (issues.length > 0) {
          throw new Error(
            `Database changed after read-only classification: ${issues.join("; ")}`,
          );
        }
      }
      writable.pragma("journal_mode = WAL");
      writable.pragma("synchronous = NORMAL");
      this.db = writable;
    } catch (error) {
      writable.close();
      throw error;
    }
  }

  public close(): void {
    if (this.db?.open) {
      this.db.close();
    }
    this.db = null;
  }

  /**
   * Hooks nonessential writes into the Discord event work lifecycle. Tests and
   * offline CLIs intentionally run them inline when no scheduler is attached.
   */
  public setNonessentialScheduler(
    scheduler: ((task: () => void | Promise<void>) => void) | null,
  ): void {
    this.nonessentialScheduler = scheduler;
  }

  public scheduleNonessential(task: () => void | Promise<void>): void {
    if (this.nonessentialScheduler) {
      this.nonessentialScheduler(task);
      return;
    }
    task();
  }

  public pruneMudaeWatchDeliveries(): number {
    return pruneAllMudaeWatchDeliveries(this.requireDatabase());
  }

  public forGuild(guildId: string): GuildStorage {
    const normalized = assertDiscordSnowflake(guildId);
    if (!this.getGuild(normalized)) {
      throw new Error(`Guild ${normalized} is not configured`);
    }
    return instrumentGuildStorage(
      new GuildStorage(this.requireDatabase(), this, normalized),
    );
  }

  public ensureGuild(
    guildId: string,
    name: string | null = null,
    observedJoinedAt: string | null = null,
  ): GuildRecord {
    const db = this.requireDatabase();
    const normalized = assertDiscordSnowflake(guildId);
    const now = utcNow();
    const joinedAt = normalizeObservedTimestamp(observedJoinedAt) ?? now;
    const guildName = normalizeGuildName(name);
    const ensure = db.transaction(() => {
      db.prepare(
        `INSERT INTO guilds (
           guild_id, enabled, name, joined_at, left_at, created_at, updated_at
         ) VALUES (?, 1, ?, ?, NULL, ?, ?)
         ON CONFLICT(guild_id) DO UPDATE SET
           name = COALESCE(excluded.name, guilds.name),
           joined_at = COALESCE(guilds.joined_at, excluded.joined_at),
           updated_at = excluded.updated_at`,
      ).run(normalized, guildName, joinedAt, now, now);
      if (!this.getGuildSettings(normalized)) {
        this.insertSettings(normalized, createDefaultGuildSettings(), now);
      }
    });
    ensure.immediate();
    return this.requireGuild(normalized);
  }

  public reactivateGuild(
    guildId: string,
    name: string | null = null,
    observedJoinedAt: string | null = null,
  ): GuildRecord {
    const db = this.requireDatabase();
    const normalized = assertDiscordSnowflake(guildId);
    const now = utcNow();
    const guildName = normalizeGuildName(name);
    const existing = this.getGuild(normalized);
    const joinedAt =
      normalizeObservedTimestamp(observedJoinedAt) ??
      (existing?.leftAt === null ? existing.joinedAt : null) ??
      now;
    const reactivate = db.transaction(() => {
      const priorSettings = this.getGuildSettings(normalized);
      db.prepare(
        `INSERT INTO guilds (
           guild_id, enabled, name, joined_at, left_at, created_at, updated_at
         ) VALUES (?, 1, ?, ?, NULL, ?, ?)
         ON CONFLICT(guild_id) DO UPDATE SET
           enabled = 1,
           name = COALESCE(excluded.name, guilds.name),
           joined_at = excluded.joined_at,
           left_at = NULL,
           updated_at = excluded.updated_at`,
      ).run(normalized, guildName, joinedAt, now, now);
      const settings = priorSettings ?? createDefaultGuildSettings();
      settings.enabled = true;
      this.upsertSettings(normalized, settings, now);
    });
    reactivate.immediate();
    return this.requireGuild(normalized);
  }

  public markGuildLeft(guildId: string): GuildRecord | null {
    const db = this.requireDatabase();
    const normalized = assertDiscordSnowflake(guildId);
    if (!this.getGuild(normalized)) {
      return null;
    }
    const now = utcNow();
    const leave = db.transaction(() => {
      const settings = this.getGuildSettings(normalized);
      db.prepare(
        `UPDATE guilds
         SET enabled = 0, left_at = ?, updated_at = ?
         WHERE guild_id = ?`,
      ).run(now, now, normalized);
      if (settings) {
        settings.enabled = false;
        this.upsertSettings(normalized, settings, now);
      }
    });
    leave.immediate();
    return this.requireGuild(normalized);
  }

  public getGuild(guildId: string): GuildRecord | null {
    const db = this.requireDatabase();
    const normalized = assertDiscordSnowflake(guildId);
    const row = db
      .prepare("SELECT * FROM guilds WHERE guild_id = ?")
      .get(normalized) as GuildRow | undefined;
    return row ? parseGuildRow(row) : null;
  }

  public listEnabledGuilds(): GuildRecord[] {
    return this.listGuilds(
      "WHERE enabled = 1 AND left_at IS NULL ORDER BY guild_id",
    );
  }

  public listActiveGuilds(): GuildRecord[] {
    return this.listGuilds("WHERE left_at IS NULL ORDER BY guild_id");
  }

  public getGuildSettings(guildId: string): GuildSettings | null {
    const db = this.requireDatabase();
    const normalized = assertDiscordSnowflake(guildId);
    const row = db
      .prepare(
        "SELECT settings_version, settings_json FROM guild_settings WHERE guild_id = ?",
      )
      .get(normalized) as GuildSettingsRow | undefined;
    if (!row) {
      return null;
    }
    const settings = parseGuildSettingsJson(row.settings_json);
    if (row.settings_version !== settings.version) {
      throw new Error(`Guild ${normalized} settings version is inconsistent`);
    }
    const guild = db
      .prepare("SELECT enabled FROM guilds WHERE guild_id = ?")
      .get(normalized) as { enabled: number } | undefined;
    if (!guild || settings.enabled !== Boolean(guild.enabled)) {
      throw new Error(`Guild ${normalized} enabled state is inconsistent`);
    }
    return settings;
  }

  public getGuildEnableExpectation(
    guildId: string,
  ): GuildEnableExpectation | null {
    const db = this.requireDatabase();
    const normalized = assertDiscordSnowflake(guildId);
    const row = db
      .prepare(
        `SELECT guilds.enabled, guilds.joined_at,
                guild_settings.settings_version, guild_settings.settings_json
         FROM guilds
         JOIN guild_settings ON guild_settings.guild_id = guilds.guild_id
         WHERE guilds.guild_id = ?`,
      )
      .get(normalized) as
      | {
          enabled: number;
          joined_at: string | null;
          settings_version: number;
          settings_json: string;
        }
      | undefined;
    if (!row) return null;
    const settings = parseGuildSettingsJson(row.settings_json);
    if (
      row.settings_version !== settings.version ||
      settings.enabled !== Boolean(row.enabled)
    ) {
      throw new Error(`Guild ${normalized} enabled state is inconsistent`);
    }
    return { settings, lifecycleJoinedAt: row.joined_at };
  }

  public isGuildCurrent(guildId: string): boolean {
    const db = this.requireDatabase();
    const normalized = assertDiscordSnowflake(guildId);
    const row = db
      .prepare(
        `SELECT guilds.enabled, guilds.left_at,
                guild_settings.settings_version, guild_settings.settings_json
         FROM guilds
         JOIN guild_settings ON guild_settings.guild_id = guilds.guild_id
         WHERE guilds.guild_id = ?`,
      )
      .get(normalized) as
      | {
          enabled: number;
          left_at: string | null;
          settings_version: number;
          settings_json: string;
        }
      | undefined;
    if (!row) return false;
    const settings = parseGuildSettingsJson(row.settings_json);
    if (row.settings_version !== settings.version) {
      throw new Error(`Guild ${normalized} settings version is inconsistent`);
    }
    return Boolean(row.enabled && row.left_at === null && settings.enabled);
  }

  public saveGuildSettings(
    guildId: string,
    input: GuildSettings,
    expectedSettings?: GuildSettings,
  ): GuildSettings {
    const db = this.requireDatabase();
    const normalized = assertDiscordSnowflake(guildId);
    const now = utcNow();
    let saved: GuildSettings | null = null;
    const save = db.transaction(() => {
      const current = this.getGuildSettings(normalized);
      if (!current) {
        throw new Error(`Guild ${normalized} is not configured`);
      }
      if (
        expectedSettings !== undefined &&
        !isDeepStrictEqual(current, sanitizeGuildSettings(expectedSettings))
      ) {
        throw new GuildSettingsConflictError(normalized);
      }
      const next = sanitizeGuildSettings(input);
      // Configuration writes are atomic and may not implicitly change the
      // explicit emergency bot-state switch.
      next.enabled = current.enabled;
      const validated = sanitizeGuildSettings(next);
      db.prepare(
        "UPDATE guilds SET enabled = ?, updated_at = ? WHERE guild_id = ?",
      ).run(validated.enabled ? 1 : 0, now, normalized);
      this.upsertSettings(normalized, validated, now);
      saved = validated;
    });
    save.immediate();
    if (!saved) {
      throw new Error("Settings write completed without a result");
    }
    return sanitizeGuildSettings(saved);
  }

  public setGuildEnabled(
    guildId: string,
    enabled: boolean,
    expectation?: GuildEnableExpectation,
  ): GuildSettings {
    const db = this.requireDatabase();
    const normalized = assertDiscordSnowflake(guildId);
    const now = utcNow();
    let saved: GuildSettings | null = null;
    const update = db.transaction(() => {
      const current = this.getGuildSettings(normalized);
      const guild = this.getGuild(normalized);
      if (!current || !guild) {
        throw new Error(`Guild ${normalized} is not configured`);
      }
      if (enabled) {
        if (!expectation) {
          throw new TypeError(
            "Enabling requires the reviewed settings and lifecycle snapshot",
          );
        }
        if (
          !isDeepStrictEqual(
            current,
            sanitizeGuildSettings(expectation.settings),
          ) ||
          guild.joinedAt !== expectation.lifecycleJoinedAt
        ) {
          throw new GuildSettingsConflictError(normalized);
        }
        if (guild.leftAt !== null) {
          throw new Error(
            "An inactive guild must rejoin before it can be enabled",
          );
        }
      }
      current.enabled = Boolean(enabled);
      const validated = sanitizeGuildSettings(current);
      db.prepare(
        "UPDATE guilds SET enabled = ?, updated_at = ? WHERE guild_id = ?",
      ).run(validated.enabled ? 1 : 0, now, normalized);
      this.upsertSettings(normalized, validated, now);
      saved = validated;
    });
    update.immediate();
    if (!saved) {
      throw new Error("Enable write completed without a result");
    }
    return sanitizeGuildSettings(saved);
  }

  public exportGuildData(
    guildId: string,
    /** Test/diagnostic hook after the read snapshot has been established. */
    onSnapshotAcquired?: () => void,
    maximumMaterializedBytes?: number,
  ): GuildDataExport {
    const db = this.requireDatabase();
    const normalized = assertDiscordSnowflake(guildId);
    const exportSnapshot = db.transaction((): GuildDataExport => {
      const metadata = this.requireGuild(normalized);
      onSnapshotAcquired?.();
      const counts = this.guildPurgeCounts(normalized);
      const boundedCollections = [
        ["metrics", counts.metrics, GUILD_DATA_COLLECTION_LIMITS.metrics],
        [
          "delegated capability grants",
          counts.delegatedCapabilityGrants,
          GUILD_DATA_COLLECTION_LIMITS.delegatedCapabilityGrants,
        ],
        [
          "ticket departments",
          counts.ticketDepartments,
          GUILD_DATA_COLLECTION_LIMITS.ticketDepartments,
        ],
        [
          "ticket department fields",
          counts.ticketDepartmentFields,
          GUILD_DATA_COLLECTION_LIMITS.ticketDepartmentFields,
        ],
        [
          "posted panels",
          counts.postedPanels,
          GUILD_DATA_COLLECTION_LIMITS.postedPanels,
        ],
        ["tickets", counts.tickets, GUILD_DATA_COLLECTION_LIMITS.tickets],
        [
          "ticket form responses",
          counts.ticketFormResponses,
          GUILD_DATA_COLLECTION_LIMITS.ticketFormResponses,
        ],
        [
          "ticket events",
          counts.ticketEvents,
          GUILD_DATA_COLLECTION_LIMITS.ticketEvents,
        ],
        [
          "suggestions",
          counts.suggestions,
          GUILD_DATA_COLLECTION_LIMITS.suggestions,
        ],
        [
          "suggestion votes",
          counts.suggestionVotes,
          GUILD_DATA_COLLECTION_LIMITS.suggestionVotes,
        ],
        [
          "suggestion events",
          counts.suggestionEvents,
          GUILD_DATA_COLLECTION_LIMITS.suggestionEvents,
        ],
        [
          "application forms",
          counts.applicationForms,
          GUILD_DATA_COLLECTION_LIMITS.applicationForms,
        ],
        [
          "application form fields",
          counts.applicationFormFields,
          GUILD_DATA_COLLECTION_LIMITS.applicationFormFields,
        ],
        [
          "applications",
          counts.applications,
          GUILD_DATA_COLLECTION_LIMITS.applications,
        ],
        [
          "application responses",
          counts.applicationResponses,
          GUILD_DATA_COLLECTION_LIMITS.applicationResponses,
        ],
        [
          "application events",
          counts.applicationEvents,
          GUILD_DATA_COLLECTION_LIMITS.applicationEvents,
        ],
        [
          "restricted ping roles",
          counts.restrictedPingRoles,
          GUILD_DATA_COLLECTION_LIMITS.restrictedPingRoles,
        ],
        [
          "restricted ping mappings",
          counts.restrictedPingMappings,
          GUILD_DATA_COLLECTION_LIMITS.restrictedPingMappings,
        ],
        [
          "restricted ping user cooldowns",
          counts.restrictedPingUserCooldowns,
          GUILD_DATA_COLLECTION_LIMITS.restrictedPingUserCooldowns,
        ],
        [
          "restricted ping events",
          counts.restrictedPingEvents,
          GUILD_DATA_COLLECTION_LIMITS.restrictedPingEvents,
        ],
        [
          "moderation cases",
          counts.moderationCases,
          GUILD_DATA_COLLECTION_LIMITS.moderationCases,
        ],
        [
          "moderation case events",
          counts.moderationCaseEvents,
          GUILD_DATA_COLLECTION_LIMITS.moderationCaseEvents,
        ],
        [
          "moderation log deliveries",
          counts.moderationLogDeliveries,
          GUILD_DATA_COLLECTION_LIMITS.moderationLogDeliveries,
        ],
        [
          "member reports",
          counts.memberReports,
          GUILD_DATA_COLLECTION_LIMITS.memberReports,
        ],
        [
          "member report events",
          counts.memberReportEvents,
          GUILD_DATA_COLLECTION_LIMITS.memberReportEvents,
        ],
        [
          "case appeals",
          counts.caseAppeals,
          GUILD_DATA_COLLECTION_LIMITS.caseAppeals,
        ],
        [
          "case appeal events",
          counts.caseAppealEvents,
          GUILD_DATA_COLLECTION_LIMITS.caseAppealEvents,
        ],
        [
          "anti-spam rules",
          counts.antiSpamRules,
          GUILD_DATA_COLLECTION_LIMITS.antiSpamRules,
        ],
        [
          "anti-spam exempt roles",
          counts.antiSpamExemptRoles,
          GUILD_DATA_COLLECTION_LIMITS.antiSpamExemptRoles,
        ],
        [
          "anti-spam exempt channels",
          counts.antiSpamExemptChannels,
          GUILD_DATA_COLLECTION_LIMITS.antiSpamExemptChannels,
        ],
        [
          "anti-spam enforcements",
          counts.antiSpamEnforcements,
          GUILD_DATA_COLLECTION_LIMITS.antiSpamEnforcements,
        ],
        [
          "anti-spam events",
          counts.antiSpamEvents,
          GUILD_DATA_COLLECTION_LIMITS.antiSpamEvents,
        ],
        [
          "onboarding rules versions",
          counts.onboardingRulesVersions,
          GUILD_DATA_COLLECTION_LIMITS.onboardingRulesVersions,
        ],
        [
          "onboarding autoroles",
          counts.onboardingAutoroles,
          GUILD_DATA_COLLECTION_LIMITS.onboardingAutoroles,
        ],
        [
          "member onboarding states",
          counts.memberOnboardingStates,
          GUILD_DATA_COLLECTION_LIMITS.memberOnboardingStates,
        ],
        [
          "member rules acceptances",
          counts.memberRuleAcceptances,
          GUILD_DATA_COLLECTION_LIMITS.memberRuleAcceptances,
        ],
        [
          "onboarding delivery records",
          counts.onboardingDeliveryRecords,
          GUILD_DATA_COLLECTION_LIMITS.onboardingDeliveryRecords,
        ],
        [
          "onboarding role operations",
          counts.onboardingRoleOperations,
          GUILD_DATA_COLLECTION_LIMITS.onboardingRoleOperations,
        ],
        [
          "onboarding audit events",
          counts.onboardingAuditEvents,
          GUILD_DATA_COLLECTION_LIMITS.onboardingAuditEvents,
        ],
        [
          "role menus",
          counts.roleMenus,
          GUILD_DATA_COLLECTION_LIMITS.roleMenus,
        ],
        [
          "role menu options",
          counts.roleMenuOptions,
          GUILD_DATA_COLLECTION_LIMITS.roleMenuOptions,
        ],
        [
          "role menu posts",
          counts.roleMenuPosts,
          GUILD_DATA_COLLECTION_LIMITS.roleMenuPosts,
        ],
        [
          "role menu operations",
          counts.roleMenuOperations,
          GUILD_DATA_COLLECTION_LIMITS.roleMenuOperations,
        ],
      ] as const;
      for (const [label, count, maximum] of boundedCollections) {
        if (count > maximum) {
          throw new RangeError(
            `Guild export ${label} exceeds the ${maximum}-record safety limit`,
          );
        }
      }
      if (
        maximumMaterializedBytes !== undefined &&
        this.estimateGuildExportBytes(normalized) > maximumMaterializedBytes
      ) {
        throw new RangeError(
          `Guild export exceeds the ${maximumMaterializedBytes}-byte materialization safety limit`,
        );
      }
      const settings = this.getGuildSettings(normalized);
      if (!settings) {
        throw new Error(`Guild ${normalized} has no settings`);
      }
      const rows = db
        .prepare(
          `SELECT metric_key, metric_value, updated_at
           FROM metrics WHERE guild_id = ? ORDER BY metric_key`,
        )
        .all(normalized) as MetricRow[];
      return {
        formatVersion: 8,
        guildId: normalized,
        exportedAt: utcNow(),
        metadata,
        settings,
        metrics: rows.map((row): GuildMetricExport => ({
          key: row.metric_key,
          value: row.metric_value,
          updatedAt: row.updated_at,
        })),
        ...readPhase2OperationalData(db, normalized),
        ...readRestrictedPingGuildData(db, normalized),
        ...readPhase3GuildData(db, normalized),
        ...readPhase4GuildData(db, normalized),
      };
    });
    return exportSnapshot.deferred();
  }

  public importGuildData(
    guildId: string,
    payload: unknown,
    expectedSettings: GuildSettings,
  ): GuildSettings {
    const db = this.requireDatabase();
    const normalized = assertDiscordSnowflake(guildId);
    const imported = parseGuildDataExport(payload, normalized);
    const expected = sanitizeGuildSettings(expectedSettings);
    const now = utcNow();
    let saved: GuildSettings | null = null;
    const apply = db.transaction(() => {
      const current = this.getGuildSettings(normalized);
      if (!current || !isDeepStrictEqual(current, expected)) {
        throw new GuildSettingsConflictError(normalized);
      }
      const settings = sanitizeGuildSettings(imported.settings);
      // Imports cannot globally disable otherwise safe core behavior. External
      // authority and Discord bindings are deactivated independently below.
      settings.enabled = true;
      const reviewed = sanitizeGuildSettings(settings);

      db.prepare(
        "UPDATE guilds SET enabled = 1, updated_at = ? WHERE guild_id = ?",
      ).run(now, normalized);
      this.upsertSettings(normalized, reviewed, now);
      db.prepare("DELETE FROM metrics WHERE guild_id = ?").run(normalized);
      if (imported.sourceFormatVersion >= 3) {
        for (const table of [
          ...PHASE2_GUILD_TABLES,
          ...RESTRICTED_PING_GUILD_TABLES,
        ].reverse()) {
          db.prepare(`DELETE FROM ${table} WHERE guild_id = ?`).run(normalized);
        }
      }
      // Formats 3+ have always represented a complete portable tenant model
      // for their schema generation. Collections introduced after the source
      // format therefore become empty on import instead of silently retaining
      // newer live records. Format 2 intentionally keeps all operational rows
      // for its documented settings-and-metrics-only compatibility behavior.
      if (imported.sourceFormatVersion >= 3) {
        for (const table of [...PHASE3_GUILD_TABLES].reverse()) {
          db.prepare(`DELETE FROM ${table} WHERE guild_id = ?`).run(normalized);
        }
        for (const table of [...PHASE4_GUILD_TABLES].reverse()) {
          db.prepare(`DELETE FROM ${table} WHERE guild_id = ?`).run(normalized);
        }
      }
      const insert = db.prepare(
        `INSERT INTO metrics (
           guild_id, metric_key, metric_value, updated_at
         ) VALUES (?, ?, ?, ?)`,
      );
      for (const metric of imported.metrics) {
        insert.run(normalized, metric.key, metric.value, metric.updatedAt);
      }
      if (imported.sourceFormatVersion >= 3) {
        insertImportedOperationalData(db, normalized, imported);
      }
      if (imported.sourceFormatVersion >= 7) {
        insertPhase3GuildData(db, normalized, imported);
      }
      if (imported.sourceFormatVersion === 8) {
        insertPhase4GuildData(db, normalized, imported);
      }
      deactivatePhase2OperationalBindings(db, normalized);
      deactivateRestrictedPingBindings(db, normalized);
      deactivatePhase3Bindings(db, normalized);
      deactivatePhase4Bindings(db, normalized);
      saved = reviewed;
    });
    apply.immediate();
    if (!saved) {
      throw new Error("Guild import completed without a result");
    }
    return sanitizeGuildSettings(saved);
  }

  public previewGuildPurge(guildId: string): GuildPurgeResult {
    const normalized = assertDiscordSnowflake(guildId);
    return this.guildPurgeCounts(normalized);
  }

  public purgeGuildData(guildId: string): GuildPurgeResult {
    const db = this.requireDatabase();
    const normalized = assertDiscordSnowflake(guildId);
    let result: GuildPurgeResult | null = null;
    const purge = db.transaction(() => {
      result = this.guildPurgeCounts(normalized);
      db.prepare("DELETE FROM guilds WHERE guild_id = ?").run(normalized);
      for (const table of [
        "guilds",
        "guild_settings",
        "metrics",
        ...PHASE2_GUILD_TABLES,
        ...RESTRICTED_PING_GUILD_TABLES,
        ...PHASE3_GUILD_TABLES,
        ...PHASE4_GUILD_TABLES,
        "mudae_watch_deliveries",
      ] as const) {
        if (this.countGuildRows(table, normalized) !== 0) {
          throw new Error(`Guild purge left rows in ${table}`);
        }
      }
    });
    purge.immediate();
    if (!result) {
      throw new Error("Guild purge completed without a result");
    }
    return result;
  }

  private listGuilds(suffix: string): GuildRecord[] {
    const rows = this.requireDatabase()
      .prepare(`SELECT * FROM guilds ${suffix}`)
      .all() as GuildRow[];
    return rows.map(parseGuildRow);
  }

  private requireGuild(guildId: string): GuildRecord {
    const guild = this.getGuild(guildId);
    if (!guild) {
      throw new Error(`Guild ${guildId} is not configured`);
    }
    return guild;
  }

  private requireDatabase(): Database.Database {
    if (!this.db?.open) {
      throw new Error("BotStorage.initStorage() must be called first");
    }
    return this.db;
  }

  private insertSettings(
    guildId: string,
    settings: GuildSettings,
    updatedAt: string,
  ): void {
    const validated = sanitizeGuildSettings(settings);
    this.requireDatabase()
      .prepare(
        `INSERT INTO guild_settings (
           guild_id, settings_version, settings_json, updated_at
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(
        guildId,
        validated.version,
        serializeGuildSettings(validated),
        updatedAt,
      );
  }

  private upsertSettings(
    guildId: string,
    settings: GuildSettings,
    updatedAt: string,
  ): void {
    const validated = sanitizeGuildSettings(settings);
    this.requireDatabase()
      .prepare(
        `INSERT INTO guild_settings (
           guild_id, settings_version, settings_json, updated_at
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT(guild_id) DO UPDATE SET
           settings_version = excluded.settings_version,
           settings_json = excluded.settings_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        guildId,
        validated.version,
        serializeGuildSettings(validated),
        updatedAt,
      );
  }

  private guildPurgeCounts(guildId: string): GuildPurgeResult {
    return {
      guildId,
      guilds: this.countGuildRows("guilds", guildId),
      settings: this.countGuildRows("guild_settings", guildId),
      metrics: this.countGuildRows("metrics", guildId),
      delegatedCapabilityGrants: this.countGuildRows(
        "delegated_capability_grants",
        guildId,
      ),
      ticketDepartments: this.countGuildRows("ticket_departments", guildId),
      ticketDepartmentFields: this.countGuildRows(
        "ticket_department_fields",
        guildId,
      ),
      postedPanels: this.countGuildRows("posted_panels", guildId),
      tickets: this.countGuildRows("tickets", guildId),
      ticketFormResponses: this.countGuildRows(
        "ticket_form_responses",
        guildId,
      ),
      ticketEvents: this.countGuildRows("ticket_events", guildId),
      suggestionConfigurations: this.countGuildRows(
        "suggestion_configurations",
        guildId,
      ),
      suggestions: this.countGuildRows("suggestions", guildId),
      suggestionVotes: this.countGuildRows("suggestion_votes", guildId),
      suggestionEvents: this.countGuildRows("suggestion_events", guildId),
      applicationForms: this.countGuildRows("application_forms", guildId),
      applicationFormFields: this.countGuildRows(
        "application_form_fields",
        guildId,
      ),
      applications: this.countGuildRows("applications", guildId),
      applicationResponses: this.countGuildRows(
        "application_responses",
        guildId,
      ),
      applicationEvents: this.countGuildRows("application_events", guildId),
      restrictedPingRoles: this.countGuildRows(
        "restricted_ping_roles",
        guildId,
      ),
      restrictedPingMappings: this.countGuildRows(
        "restricted_ping_channels",
        guildId,
      ),
      restrictedPingUserCooldowns: this.countGuildRows(
        "restricted_ping_user_cooldowns",
        guildId,
      ),
      restrictedPingEvents: this.countGuildRows(
        "restricted_ping_events",
        guildId,
      ),
      mudaeWatchDeliveries: this.countGuildRows(
        "mudae_watch_deliveries",
        guildId,
      ),
      moderationConfigurations: this.countGuildRows(
        "moderation_configurations",
        guildId,
      ),
      moderationCases: this.countGuildRows("moderation_cases", guildId),
      moderationCaseEvents: this.countGuildRows(
        "moderation_case_events",
        guildId,
      ),
      moderationLogDeliveries: this.countGuildRows(
        "moderation_log_deliveries",
        guildId,
      ),
      memberReports: this.countGuildRows("member_reports", guildId),
      memberReportEvents: this.countGuildRows("member_report_events", guildId),
      caseAppeals: this.countGuildRows("case_appeals", guildId),
      caseAppealEvents: this.countGuildRows("case_appeal_events", guildId),
      antiSpamRules: this.countGuildRows("anti_spam_rules", guildId),
      antiSpamExemptRoles: this.countGuildRows(
        "anti_spam_exempt_roles",
        guildId,
      ),
      antiSpamExemptChannels: this.countGuildRows(
        "anti_spam_exempt_channels",
        guildId,
      ),
      antiSpamEnforcements: this.countGuildRows(
        "anti_spam_enforcements",
        guildId,
      ),
      antiSpamEvents: this.countGuildRows("anti_spam_events", guildId),
      onboardingConfigurations: this.countGuildRows(
        "onboarding_configurations",
        guildId,
      ),
      onboardingRulesVersions: this.countGuildRows(
        "onboarding_rules_versions",
        guildId,
      ),
      onboardingAutoroles: this.countGuildRows("onboarding_autoroles", guildId),
      memberOnboardingStates: this.countGuildRows(
        "member_onboarding_states",
        guildId,
      ),
      memberRuleAcceptances: this.countGuildRows(
        "member_rule_acceptances",
        guildId,
      ),
      onboardingDeliveryRecords: this.countGuildRows(
        "onboarding_delivery_records",
        guildId,
      ),
      onboardingRoleOperations: this.countGuildRows(
        "onboarding_role_operations",
        guildId,
      ),
      onboardingAuditEvents: this.countGuildRows(
        "onboarding_audit_events",
        guildId,
      ),
      roleMenus: this.countGuildRows("role_menus", guildId),
      roleMenuOptions: this.countGuildRows("role_menu_options", guildId),
      roleMenuPosts: this.countGuildRows("role_menu_posts", guildId),
      roleMenuOperations: this.countGuildRows("role_menu_operations", guildId),
      roleMenuOperationItems: this.countGuildRows(
        "role_menu_operation_items",
        guildId,
      ),
    };
  }

  private estimateGuildExportBytes(guildId: string): number {
    const tables = [
      "guilds",
      "guild_settings",
      "metrics",
      ...PHASE2_GUILD_TABLES,
      ...RESTRICTED_PING_GUILD_TABLES,
      ...PHASE3_GUILD_TABLES,
      ...PHASE4_GUILD_TABLES,
    ] as const;
    return tables.reduce(
      (total, table) => total + this.estimateGuildTableBytes(table, guildId),
      4_096,
    );
  }

  private estimateGuildTableBytes(
    table:
      | "guilds"
      | "guild_settings"
      | "metrics"
      | (typeof PHASE2_GUILD_TABLES)[number]
      | (typeof RESTRICTED_PING_GUILD_TABLES)[number]
      | (typeof PHASE3_GUILD_TABLES)[number]
      | (typeof PHASE4_GUILD_TABLES)[number],
    guildId: string,
  ): number {
    const db = this.requireDatabase();
    const columns = db.pragma(`table_info(${table})`) as Array<{
      name: string;
    }>;
    const expression = columns
      .map(
        ({ name }) =>
          `length(CAST(COALESCE("${name.replaceAll('"', '""')}", '') AS BLOB))`,
      )
      .join(" + ");
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(${expression} + ${columns.length * 64}), 0) AS bytes
         FROM ${table} WHERE guild_id = ?`,
      )
      .get(guildId) as { bytes: number };
    return Number(row.bytes);
  }

  private countGuildRows(
    table:
      | "guilds"
      | "guild_settings"
      | "metrics"
      | (typeof PHASE2_GUILD_TABLES)[number]
      | (typeof RESTRICTED_PING_GUILD_TABLES)[number]
      | (typeof PHASE3_GUILD_TABLES)[number]
      | (typeof PHASE4_GUILD_TABLES)[number]
      | "mudae_watch_deliveries",
    guildId: string,
  ): number {
    const row = this.requireDatabase()
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE guild_id = ?`)
      .get(guildId) as { count: number };
    return Number(row.count);
  }
}

export class GuildStorage {
  private readonly operational: GuildOperationalRepository;
  private readonly access: GuildAccessRepository;
  private readonly departments: TicketDepartmentRepository;
  private readonly suggestions: SuggestionRepository;
  private readonly applications: ApplicationRepository;
  private readonly restrictedPings: RestrictedPingRepository;
  private readonly mudaeWatchDeliveries: MudaeWatchDeliveryRepository;
  private readonly moderationCases: ModerationCaseRepository;
  private readonly memberReports: MemberReportRepository;
  private readonly caseAppeals: CaseAppealRepository;
  private readonly antiSpam: AntiSpamRepository;
  private readonly voting: GuildVotingRepository;
  private readonly onboarding: OnboardingStorageRepository;
  private readonly roleMenus: RoleMenuRepository;

  public constructor(
    private readonly db: Database.Database,
    private readonly root: BotStorage,
    public readonly guildId: string,
  ) {
    this.operational = new GuildOperationalRepository(db, guildId);
    this.access = new GuildAccessRepository(db, guildId);
    this.departments = new TicketDepartmentRepository(db, guildId);
    this.suggestions = new SuggestionRepository(db, guildId);
    this.applications = new ApplicationRepository(db, guildId);
    this.restrictedPings = new RestrictedPingRepository(db, guildId);
    this.mudaeWatchDeliveries = new MudaeWatchDeliveryRepository(db, guildId);
    this.moderationCases = new ModerationCaseRepository(db, guildId);
    this.memberReports = new MemberReportRepository(db, guildId);
    this.caseAppeals = new CaseAppealRepository(db, guildId);
    this.antiSpam = new AntiSpamRepository(db, guildId);
    this.voting = new GuildVotingRepository(db, guildId);
    this.onboarding = new OnboardingStorageRepository(db, guildId);
    this.roleMenus = new RoleMenuRepository(db, guildId);
  }

  public getOnboardingConfiguration(): OnboardingConfiguration | null {
    return this.onboarding.getOnboardingConfiguration();
  }

  public isOnboardingLifecycleDefinitionCurrent(
    snapshot: OnboardingLifecycleDefinitionSnapshot,
  ): boolean {
    return this.onboarding.isOnboardingLifecycleDefinitionCurrent(snapshot);
  }

  public upsertOnboardingConfiguration(
    input: OnboardingConfigurationInput,
  ): OnboardingConfiguration {
    return this.onboarding.upsertOnboardingConfiguration(input);
  }

  public disableOnboardingConfiguration(
    actorId: string,
  ): OnboardingConfiguration | null {
    return this.onboarding.disableOnboardingConfiguration(actorId);
  }

  public createOnboardingRulesVersion(
    input: OnboardingRulesVersionInput,
  ): OnboardingRulesVersion {
    return this.onboarding.createOnboardingRulesVersion(input);
  }

  public createAndActivateOnboardingRulesVersion(
    input: OnboardingRulesActivationInput,
  ): OnboardingRulesActivationResult {
    return this.onboarding.createAndActivateOnboardingRulesVersion(input);
  }

  public getOnboardingRulesVersion(
    rulesVersion: number,
  ): OnboardingRulesVersion | null {
    return this.onboarding.getOnboardingRulesVersion(rulesVersion);
  }

  public getCurrentOnboardingRulesVersion(): OnboardingRulesVersion | null {
    return this.onboarding.getCurrentOnboardingRulesVersion();
  }

  public listOnboardingRulesVersions(
    limit?: number,
    offset?: number,
  ): OnboardingRulesVersion[] {
    return this.onboarding.listOnboardingRulesVersions(limit, offset);
  }

  public countOnboardingRulesVersions(): number {
    return this.onboarding.countOnboardingRulesVersions();
  }

  public replaceOnboardingAutoroles(
    audience: OnboardingAutoroleAudience,
    roles: readonly OnboardingAutoroleInput[],
    actorId: string,
  ): OnboardingAutorole[] {
    return this.onboarding.replaceOnboardingAutoroles(audience, roles, actorId);
  }

  public listOnboardingAutoroles(
    audience?: OnboardingAutoroleAudience,
    limit?: number,
    offset?: number,
  ): OnboardingAutorole[] {
    return this.onboarding.listOnboardingAutoroles(audience, limit, offset);
  }

  public getMemberOnboardingState(
    memberId: string,
  ): MemberOnboardingState | null {
    return this.onboarding.getMemberOnboardingState(memberId);
  }

  public upsertMemberOnboardingState(
    input: MemberOnboardingStateInput,
  ): MemberOnboardingState {
    return this.onboarding.upsertMemberOnboardingState(input);
  }

  public getMemberRuleAcceptance(
    memberId: string,
    rulesVersion: number,
  ): MemberRuleAcceptance | null {
    return this.onboarding.getMemberRuleAcceptance(memberId, rulesVersion);
  }

  public listMemberRuleAcceptances(
    memberId: string,
    limit?: number,
    offset?: number,
  ): MemberRuleAcceptance[] {
    return this.onboarding.listMemberRuleAcceptances(memberId, limit, offset);
  }

  public recordMemberRuleAcceptance(
    input: MemberRuleAcceptanceInput,
  ): MemberRuleAcceptanceResult {
    return this.onboarding.recordMemberRuleAcceptance(input);
  }

  public getOnboardingDelivery(
    deliveryId: string,
  ): OnboardingDeliveryRecord | null {
    return this.onboarding.getOnboardingDelivery(deliveryId);
  }

  public reserveOnboardingDelivery(
    input: OnboardingDeliveryReservationInput,
  ): OnboardingDeliveryReservationResult {
    return this.onboarding.reserveOnboardingDelivery(input);
  }

  public completeOnboardingDelivery(
    deliveryId: string,
    input: OnboardingDeliveryCompletionInput,
  ): OnboardingDeliveryRecord {
    return this.onboarding.completeOnboardingDelivery(deliveryId, input);
  }

  public listOnboardingDeliveries(options?: {
    memberId?: string;
    states?: readonly string[];
    kinds?: readonly string[];
    limit?: number;
    offset?: number;
  }): OnboardingDeliveryRecord[] {
    return this.onboarding.listOnboardingDeliveries(options);
  }

  public getOnboardingRoleOperation(
    operationId: string,
  ): OnboardingRoleOperation | null {
    return this.onboarding.getOnboardingRoleOperation(operationId);
  }

  public reserveOnboardingRoleOperation(
    input: OnboardingRoleOperationReservationInput,
  ): OnboardingRoleOperationReservationResult {
    return this.onboarding.reserveOnboardingRoleOperation(input);
  }

  public completeOnboardingRoleOperation(
    operationId: string,
    input: OnboardingRoleOperationCompletionInput,
  ): OnboardingRoleOperation {
    return this.onboarding.completeOnboardingRoleOperation(operationId, input);
  }

  public resolveOnboardingRoleOperations(
    resolvedByOperationId: string,
  ): OnboardingRoleOperation[] {
    return this.onboarding.resolveOnboardingRoleOperations(
      resolvedByOperationId,
    );
  }

  public listOnboardingRoleOperations(options?: {
    memberId?: string;
    states?: readonly string[];
    unresolvedOnly?: boolean;
    limit?: number;
    offset?: number;
  }): OnboardingRoleOperation[] {
    return this.onboarding.listOnboardingRoleOperations(options);
  }

  public appendOnboardingAudit(
    input: OnboardingAuditEventInput,
  ): OnboardingAuditEvent {
    return this.onboarding.appendOnboardingAudit(input);
  }

  public listOnboardingAuditEvents(options?: {
    memberId?: string;
    limit?: number;
    offset?: number;
  }): OnboardingAuditEvent[] {
    return this.onboarding.listOnboardingAuditEvents(options);
  }

  public invalidateOnboardingRole(roleId: string): {
    configurationChanged: number;
    autorolesChanged: number;
  } {
    return this.onboarding.invalidateOnboardingRole(roleId);
  }

  public invalidateOnboardingChannel(channelId: string): {
    configurationChanged: number;
  } {
    return this.onboarding.invalidateOnboardingChannel(channelId);
  }

  public createRoleMenu(input: RoleMenuInput): RoleMenu {
    return this.roleMenus.createRoleMenu(input);
  }

  public updateRoleMenu(
    menuId: string,
    input: RoleMenuUpdateInput,
  ): RoleMenu | null {
    return this.roleMenus.updateRoleMenu(menuId, input);
  }

  public setRoleMenuState(
    menuId: string,
    state: RoleMenuState,
    actorId: string,
    bindingsVerifiedAt: string | null = null,
  ): RoleMenu | null {
    return this.roleMenus.setRoleMenuState(
      menuId,
      state,
      actorId,
      bindingsVerifiedAt,
    );
  }

  public getRoleMenuById(menuId: string): RoleMenu | null {
    return this.roleMenus.getRoleMenuById(menuId);
  }

  public getRoleMenuBySlug(slug: string): RoleMenu | null {
    return this.roleMenus.getRoleMenuBySlug(slug);
  }

  public listRoleMenus(options: RoleMenuListOptions = {}): RoleMenu[] {
    return this.roleMenus.listRoleMenus(options);
  }

  public countRoleMenus(): number {
    return this.roleMenus.countRoleMenus();
  }

  public createRoleMenuOption(
    menuId: string,
    input: RoleMenuOptionInput,
  ): RoleMenuOption {
    return this.roleMenus.createRoleMenuOption(menuId, input);
  }

  public updateRoleMenuOption(
    menuId: string,
    optionId: string,
    input: RoleMenuOptionUpdateInput,
  ): RoleMenuOption | null {
    return this.roleMenus.updateRoleMenuOption(menuId, optionId, input);
  }

  public moveRoleMenuOption(
    menuId: string,
    optionId: string,
    sortOrder: number,
    actorId: string,
  ): RoleMenuOption | null {
    return this.roleMenus.moveRoleMenuOption(
      menuId,
      optionId,
      sortOrder,
      actorId,
    );
  }

  public reorderRoleMenuOptions(
    menuId: string,
    optionIds: readonly string[],
    actorId: string,
  ): RoleMenuOption[] {
    return this.roleMenus.reorderRoleMenuOptions(menuId, optionIds, actorId);
  }

  public removeRoleMenuOption(
    menuId: string,
    optionId: string,
    actorId: string,
  ): boolean {
    return this.roleMenus.removeRoleMenuOption(menuId, optionId, actorId);
  }

  public getRoleMenuOption(
    menuId: string,
    optionId: string,
  ): RoleMenuOption | null {
    return this.roleMenus.getRoleMenuOption(menuId, optionId);
  }

  public listRoleMenuOptions(menuId: string): RoleMenuOption[] {
    return this.roleMenus.listRoleMenuOptions(menuId);
  }

  public countRoleMenuOptions(menuId: string): number {
    return this.roleMenus.countRoleMenuOptions(menuId);
  }

  public createRoleMenuPost(input: RoleMenuPostInput): RoleMenuPost {
    return this.roleMenus.createRoleMenuPost(input);
  }

  public upsertRoleMenuPost(input: RoleMenuPostInput): RoleMenuPost {
    return this.roleMenus.upsertRoleMenuPost(input);
  }

  public setRoleMenuPostState(
    postId: string,
    state: RoleMenuPostState,
    bindingsVerifiedAt: string | null = null,
  ): RoleMenuPost | null {
    return this.roleMenus.setRoleMenuPostState(
      postId,
      state,
      bindingsVerifiedAt,
    );
  }

  public getRoleMenuPostById(postId: string): RoleMenuPost | null {
    return this.roleMenus.getRoleMenuPostById(postId);
  }

  public findRoleMenuPostByMessage(
    channelId: string,
    messageId: string,
  ): RoleMenuPost | null {
    return this.roleMenus.findRoleMenuPostByMessage(channelId, messageId);
  }

  public listRoleMenuPosts(
    options: RoleMenuPostListOptions = {},
  ): RoleMenuPost[] {
    return this.roleMenus.listRoleMenuPosts(options);
  }

  public countRoleMenuPosts(menuId?: string): number {
    return this.roleMenus.countRoleMenuPosts(menuId);
  }

  public getRoleMenuOperationById(
    operationId: string,
  ): RoleMenuOperation | null {
    return this.roleMenus.getRoleMenuOperationById(operationId);
  }

  public getRoleMenuOperation(operationId: string): RoleMenuOperation | null {
    return this.roleMenus.getRoleMenuOperation(operationId);
  }

  public getRoleMenuOperationByInteraction(
    interactionId: string,
  ): RoleMenuOperation | null {
    return this.roleMenus.getRoleMenuOperationByInteraction(interactionId);
  }

  public reserveRoleMenuOperation(
    input: RoleMenuOperationReservationInput,
  ): RoleMenuOperationReservationResult {
    return this.roleMenus.reserveRoleMenuOperation(input);
  }

  public completeRoleMenuOperation(
    operationId: string,
    input: RoleMenuOperationCompletionInput,
  ): RoleMenuOperation {
    return this.roleMenus.completeRoleMenuOperation(operationId, input);
  }

  public listRoleMenuOperations(
    options: RoleMenuOperationListOptions = {},
  ): RoleMenuOperation[] {
    return this.roleMenus.listRoleMenuOperations(options);
  }

  public invalidateRoleMenuRole(roleId: string): {
    menusChanged: number;
    postsChanged: number;
  } {
    return this.roleMenus.invalidateRoleMenuRole(roleId);
  }

  public markRoleMenuChannelMissing(channelId: string): number {
    return this.roleMenus.markRoleMenuChannelMissing(channelId);
  }

  public markRoleMenuMessageMissing(
    channelId: string,
    messageId: string,
  ): number {
    return this.roleMenus.markRoleMenuMessageMissing(channelId, messageId);
  }

  public createVotingPanel(input: VotingPanelInput): VotingPanel {
    return this.voting.createVotingPanel(input);
  }

  public getVotingPanel(voteId: string): VotingPanel | null {
    return this.voting.getVotingPanel(voteId);
  }

  public getVotingPanelByMessage(
    channelId: string,
    messageId: string,
  ): VotingPanel | null {
    return this.voting.getVotingPanelByMessage(channelId, messageId);
  }

  public listActiveVotingPanels(): VotingPanel[] {
    return this.voting.listActiveVotingPanels();
  }

  public listDueVotingPanels(now: string): VotingPanel[] {
    return this.voting.listDueVotingPanels(now);
  }

  public countActiveVotingPanels(channelId?: string): number {
    return this.voting.countActiveVotingPanels(channelId);
  }

  public getVotingPanelSelection(voteId: string, voterId: string): string[] {
    return this.voting.getVotingPanelSelection(voteId, voterId);
  }

  public replaceVotingSelection(
    voteId: string,
    voterId: string,
    optionIds: readonly string[],
  ): VotingPanelSelectionResult {
    return this.voting.replaceVotingSelection(voteId, voterId, optionIds);
  }

  public selectVotingPanelOption(
    voteId: string,
    voterId: string,
    optionId: string,
  ): VotingPanelSelectionResult {
    return this.voting.selectVotingPanelOption(voteId, voterId, optionId);
  }

  public toggleVotingPanelOption(
    voteId: string,
    voterId: string,
    optionId: string,
  ): VotingPanelSelectionResult {
    return this.voting.toggleVotingPanelOption(voteId, voterId, optionId);
  }

  public listVotingPanelVoters(voteId: string): VotingPanelVoter[] {
    return this.voting.listVotingPanelVoters(voteId);
  }

  public transitionVotingPanel(
    voteId: string,
    status: "completed" | "cancelled",
    actorId: string,
    timestamp: string,
  ): VotingPanelTransitionResult {
    return this.voting.transitionVotingPanel(
      voteId,
      status,
      actorId,
      timestamp,
    );
  }

  public getModerationConfiguration(): ModerationConfiguration | null {
    return this.moderationCases.getConfiguration();
  }

  public upsertModerationConfiguration(
    input: ModerationConfigurationInput,
  ): ModerationConfiguration {
    return this.moderationCases.upsertConfiguration(input);
  }

  public disableModerationConfiguration(
    actorId: string,
  ): ModerationConfiguration | null {
    return this.moderationCases.disableConfiguration(actorId);
  }

  public createModerationCase(input: ModerationCaseInput): ModerationCase {
    return this.moderationCases.createCase(input);
  }

  public reserveModerationCaseAttempt(
    input: ModerationCaseAttemptInput,
  ): ModerationCase {
    return this.moderationCases.reserveCaseAttempt(input);
  }

  public confirmModerationCase(
    caseId: string,
    input: {
      actorId: string;
      status: "active" | "completed";
      discordActionMetadata?: unknown;
      expectedUpdatedAt?: string;
    },
  ): ModerationCaseTransitionResult {
    return this.moderationCases.confirmCaseAttempt(caseId, input);
  }

  public failModerationCaseAttempt(
    caseId: string,
    input: { actorId: string; failureCode: string; expectedUpdatedAt?: string },
  ): ModerationCaseTransitionResult {
    return this.moderationCases.failCaseAttempt(caseId, input);
  }

  public finalizeTimeoutRemovalCase(
    removalCaseId: string,
    input: {
      actorId: string;
      originalCaseId: string;
      discordActionMetadata?: unknown;
      originalOutcome?: "completed" | "overturned";
      originalReason?: string;
      removalExpectedUpdatedAt?: string;
      originalExpectedUpdatedAt?: string;
    },
  ): ModerationTimeoutRemovalFinalizeResult {
    return this.moderationCases.finalizeTimeoutRemoval(removalCaseId, input);
  }

  public finalizeBanRemovalCase(
    removalCaseId: string,
    input: {
      actorId: string;
      originalCaseId: string;
      discordActionMetadata?: unknown;
      removalExpectedUpdatedAt?: string;
      originalExpectedUpdatedAt?: string;
    },
  ): ModerationTimeoutRemovalFinalizeResult {
    return this.moderationCases.finalizeBanRemoval(removalCaseId, input);
  }

  public finalizeTimeoutRemovalAppealCases(
    removalCaseId: string,
    input: {
      actorId: string;
      originalCaseId: string;
      reason: string;
      discordActionMetadata?: unknown;
      removalExpectedUpdatedAt?: string;
      originalExpectedUpdatedAt?: string;
    },
  ): ModerationTimeoutRemovalFinalizeResult {
    return this.moderationCases.finalizeTimeoutAppealOverturn(
      removalCaseId,
      input,
    );
  }

  public getModerationCaseById(caseId: string): ModerationCase | null {
    return this.moderationCases.getCaseById(caseId);
  }

  public getModerationCaseByNumber(caseNumber: number): ModerationCase | null {
    return this.moderationCases.getCaseByNumber(caseNumber);
  }

  public listModerationCases(
    filter: ModerationCaseListFilter = {},
  ): ModerationCase[] {
    return this.moderationCases.listCases(filter);
  }

  public findUniqueActiveModerationCase(
    targetUserId: string,
    actionTypes: readonly ModerationCaseActionType[],
  ): ActiveModerationCaseLookupResult {
    return this.moderationCases.findUniqueActiveCase(targetUserId, actionTypes);
  }

  public findUniqueFailedModerationCase(
    targetUserId: string,
    actionTypes: readonly ModerationCaseActionType[],
    filter: {
      relatedCaseId?: string;
      sources?: readonly ModerationCaseSource[];
    } = {},
  ): ActiveModerationCaseLookupResult {
    return this.moderationCases.findUniqueFailedCase(
      targetUserId,
      actionTypes,
      filter,
    );
  }

  public amendModerationCase(
    caseId: string,
    input: ModerationCaseAmendInput,
  ): ModerationCaseTransitionResult {
    return this.moderationCases.amendCase(caseId, input);
  }

  public voidModerationCase(
    caseId: string,
    input: { actorId: string; reason: string; expectedUpdatedAt?: string },
  ): ModerationCaseTransitionResult {
    return this.moderationCases.voidCase(caseId, input);
  }

  public completeModerationCase(
    caseId: string,
    input: {
      actorId: string;
      reason?: string;
      relatedCaseId?: string | null;
      expectedUpdatedAt?: string;
    },
  ): ModerationCaseTransitionResult {
    return this.moderationCases.completeCase(caseId, input);
  }

  public completeExpiredTimeoutCase(
    caseId: string,
    input: ExpiredTimeoutCaseCompletionInput,
  ): ModerationCaseTransitionResult {
    return this.moderationCases.completeExpiredTimeoutCase(caseId, input);
  }

  public overturnModerationCase(
    caseId: string,
    input: { actorId: string; reason: string; expectedUpdatedAt?: string },
  ): ModerationCaseTransitionResult {
    return this.moderationCases.overturnCase(caseId, input);
  }

  public appendModerationCaseEvent(
    caseId: string,
    input: ModerationCaseEventInput,
  ): ModerationCaseEvent | null {
    return this.moderationCases.appendEvent(caseId, input);
  }

  public listModerationCaseEvents(
    caseId: string,
    limit?: number,
    offset?: number,
  ): ModerationCaseEvent[] {
    return this.moderationCases.listEvents(caseId, limit, offset);
  }

  public getModerationLogDelivery(
    caseId: string,
  ): ModerationLogDelivery | null {
    return this.moderationCases.getLogDelivery(caseId);
  }

  public getModerationLogDeliveryAttempt(
    caseId: string,
  ): DeliveryAttempt | null {
    return this.moderationCases.getLogDeliveryAttempt(caseId);
  }

  public beginModerationLogDeliveryAttempt(
    caseId: string,
    input: DeliveryAttemptInput,
  ): DeliveryAttemptTransitionResult<ModerationLogDelivery> {
    return this.moderationCases.beginLogDeliveryAttempt(caseId, input);
  }

  public completeModerationLogDelivery(
    caseId: string,
    input: {
      channelId: string;
      messageId: string;
      claimId: string;
      expectedUpdatedAt?: string;
    },
  ): ModerationLogDelivery | null {
    return this.moderationCases.completeLogDelivery(
      caseId,
      input.channelId,
      input.messageId,
      input.claimId,
      input.expectedUpdatedAt,
    );
  }

  public failModerationLogDelivery(
    caseId: string,
    input: {
      failureCode: string;
      claimId?: string;
      expectedUpdatedAt?: string;
    },
  ): ModerationLogDelivery | null {
    return this.moderationCases.failLogDelivery(
      caseId,
      input.failureCode,
      input.claimId,
      input.expectedUpdatedAt,
    );
  }

  public markModerationLogDeliveryMissing(
    caseId: string,
    input: { expectedUpdatedAt?: string },
  ): ModerationLogDelivery | null {
    return this.moderationCases.markLogDeliveryMissing(
      caseId,
      "message-missing",
      input.expectedUpdatedAt,
    );
  }

  public checkpointModerationLogDeliveryOrphan(
    caseId: string,
    input: {
      channelId: string;
      messageId: string;
      claimId: string;
      failureCode: string;
      expectedUpdatedAt: string;
    },
  ): ModerationLogDeliveryTransitionResult {
    return this.moderationCases.checkpointLogDeliveryOrphan(caseId, input);
  }

  public listRecoverableModerationLogDeliveries(
    limit?: number,
  ): ModerationLogDelivery[] {
    return this.moderationCases.listRecoverableLogDeliveries(limit);
  }

  public claimModerationLogDelivery(
    caseId: string,
    input: { expectedUpdatedAt?: string } = {},
  ): DeliveryClaimResult<ModerationLogDelivery> {
    return this.moderationCases.claimLogDelivery(
      caseId,
      input.expectedUpdatedAt,
    );
  }

  public reserveMemberReport(
    input: MemberReportReservationInput,
  ): MemberReportReservationResult {
    return this.memberReports.reserveReport(input);
  }

  public bindMemberReportDelivery(
    reportId: string,
    input: DeliveryBindingInput,
  ): MemberReportTransitionResult {
    return this.memberReports.bindDelivery(reportId, input);
  }

  public claimMemberReportDelivery(
    reportId: string,
    input: DeliveryMissingInput = {},
  ): DeliveryClaimResult<MemberReport> {
    return this.memberReports.claimDelivery(reportId, input);
  }

  public getMemberReportDeliveryAttempt(
    reportId: string,
  ): DeliveryAttempt | null {
    return this.memberReports.getDeliveryAttempt(reportId);
  }

  public beginMemberReportDeliveryAttempt(
    reportId: string,
    input: DeliveryAttemptInput,
  ): DeliveryAttemptTransitionResult<MemberReport> {
    return this.memberReports.beginDeliveryAttempt(reportId, input);
  }

  public failMemberReportDelivery(
    reportId: string,
    input: DeliveryFailureInput,
  ): MemberReportTransitionResult {
    return this.memberReports.failDelivery(reportId, input);
  }

  public markMemberReportDeliveryMissing(
    reportId: string,
    input: DeliveryMissingInput,
  ): MemberReportTransitionResult {
    return this.memberReports.markDeliveryMissing(reportId, input);
  }

  public checkpointMemberReportDeliveryOrphan(
    reportId: string,
    input: DeliveryOrphanCheckpointInput,
  ): MemberReportTransitionResult {
    return this.memberReports.checkpointOrphanDelivery(reportId, input);
  }

  public claimMemberReport(
    reportId: string,
    input: MemberReportActorInput,
  ): MemberReportTransitionResult {
    return this.memberReports.claimReport(reportId, input);
  }

  public takeOverMemberReportClaim(
    reportId: string,
    input: ReviewClaimTakeoverInput,
  ): MemberReportTransitionResult {
    return this.memberReports.takeOverClaim(reportId, input);
  }

  public releaseMemberReportClaim(
    reportId: string,
    input: ReviewClaimReleaseInput,
  ): MemberReportTransitionResult {
    return this.memberReports.releaseClaim(reportId, input);
  }

  public decideMemberReport(
    reportId: string,
    input: MemberReportDecisionInput,
  ): MemberReportTransitionResult {
    return this.memberReports.decideReport(reportId, input);
  }

  public withdrawMemberReport(
    reportId: string,
    input: MemberReportWithdrawInput,
  ): MemberReportTransitionResult {
    return this.memberReports.withdrawReport(reportId, input);
  }

  public getMemberReportById(reportId: string): MemberReport | null {
    return this.memberReports.getReportById(reportId);
  }

  public getMemberReportByNumber(reportNumber: number): MemberReport | null {
    return this.memberReports.getReportByNumber(reportNumber);
  }

  public listMemberReports(
    filter: MemberReportListFilter = {},
  ): MemberReport[] {
    return this.memberReports.listReports(filter);
  }

  public listMemberReportEvents(
    reportId: string,
    limit?: number,
    offset?: number,
  ): MemberReportEvent[] {
    return this.memberReports.listEvents(reportId, limit, offset);
  }

  public listRecoverableMemberReports(limit?: number): MemberReport[] {
    return this.memberReports.listRecoverable(limit);
  }

  public reserveCaseAppeal(
    input: CaseAppealReservationInput,
  ): CaseAppealReservationResult {
    return this.caseAppeals.reserveAppeal(input);
  }

  public bindCaseAppealDelivery(
    appealId: string,
    input: DeliveryBindingInput,
  ): CaseAppealTransitionResult {
    return this.caseAppeals.bindDelivery(appealId, input);
  }

  public claimCaseAppealDelivery(
    appealId: string,
    input: DeliveryMissingInput = {},
  ): DeliveryClaimResult<CaseAppeal> {
    return this.caseAppeals.claimDelivery(appealId, input);
  }

  public getCaseAppealDeliveryAttempt(
    appealId: string,
  ): DeliveryAttempt | null {
    return this.caseAppeals.getDeliveryAttempt(appealId);
  }

  public beginCaseAppealDeliveryAttempt(
    appealId: string,
    input: DeliveryAttemptInput,
  ): DeliveryAttemptTransitionResult<CaseAppeal> {
    return this.caseAppeals.beginDeliveryAttempt(appealId, input);
  }

  public failCaseAppealDelivery(
    appealId: string,
    input: DeliveryFailureInput,
  ): CaseAppealTransitionResult {
    return this.caseAppeals.failDelivery(appealId, input);
  }

  public markCaseAppealDeliveryMissing(
    appealId: string,
    input: DeliveryMissingInput,
  ): CaseAppealTransitionResult {
    return this.caseAppeals.markDeliveryMissing(appealId, input);
  }

  public checkpointCaseAppealDeliveryOrphan(
    appealId: string,
    input: DeliveryOrphanCheckpointInput,
  ): CaseAppealTransitionResult {
    return this.caseAppeals.checkpointOrphanDelivery(appealId, input);
  }

  public claimCaseAppeal(
    appealId: string,
    input: CaseAppealActorInput,
  ): CaseAppealTransitionResult {
    return this.caseAppeals.claimAppeal(appealId, input);
  }

  public takeOverCaseAppealClaim(
    appealId: string,
    input: ReviewClaimTakeoverInput,
  ): CaseAppealTransitionResult {
    return this.caseAppeals.takeOverClaim(appealId, input);
  }

  public releaseCaseAppealClaim(
    appealId: string,
    input: ReviewClaimReleaseInput,
  ): CaseAppealTransitionResult {
    return this.caseAppeals.releaseClaim(appealId, input);
  }

  public decideCaseAppeal(
    appealId: string,
    input: CaseAppealDecisionInput,
  ): CaseAppealTransitionResult {
    return this.caseAppeals.decideAppeal(appealId, input);
  }

  public finalizeCaseAppealOverturn(
    appealId: string,
    input: {
      reviewerId: string;
      decisionReason: string;
      caseReason: string;
      reversalCaseId?: string | null;
      appealExpectedUpdatedAt?: string;
      originalExpectedUpdatedAt?: string;
    },
  ): CaseAppealOverturnFinalizeResult {
    return this.caseAppeals.finalizeCaseOverturn(appealId, input);
  }

  public checkpointTimeoutAppealRemoval(
    appealId: string,
    removalCaseId: string,
    input: TimeoutAppealRemovalCheckpointInput,
  ): TimeoutAppealRemovalCheckpointResult {
    return this.caseAppeals.checkpointTimeoutAppealRemoval(
      appealId,
      removalCaseId,
      input,
    );
  }

  public finalizeTimeoutAppealOverturn(
    appealId: string,
    removalCaseId: string,
    input: {
      reviewerId: string;
      decisionReason: string;
      caseReason: string;
      discordActionMetadata?: unknown;
      appealExpectedUpdatedAt?: string;
      removalExpectedUpdatedAt?: string;
      originalExpectedUpdatedAt?: string;
    },
  ): CaseAppealOverturnFinalizeResult {
    return this.caseAppeals.finalizeTimeoutAppealOverturn(
      appealId,
      removalCaseId,
      input,
    );
  }

  public withdrawCaseAppeal(
    appealId: string,
    input: CaseAppealWithdrawInput,
  ): CaseAppealTransitionResult {
    return this.caseAppeals.withdrawAppeal(appealId, input);
  }

  public getCaseAppealById(appealId: string): CaseAppeal | null {
    return this.caseAppeals.getAppealById(appealId);
  }

  public getCaseAppealByNumber(appealNumber: number): CaseAppeal | null {
    return this.caseAppeals.getAppealByNumber(appealNumber);
  }

  public listCaseAppeals(filter: CaseAppealListFilter = {}): CaseAppeal[] {
    return this.caseAppeals.listAppeals(filter);
  }

  public listCaseAppealEvents(
    appealId: string,
    limit?: number,
    offset?: number,
  ): CaseAppealEvent[] {
    return this.caseAppeals.listEvents(appealId, limit, offset);
  }

  public listRecoverableCaseAppeals(limit?: number): CaseAppeal[] {
    return this.caseAppeals.listRecoverable(limit);
  }

  public getAntiSpamRule(ruleType: AntiSpamRuleType): AntiSpamRule | null {
    return this.antiSpam.getRule(ruleType);
  }

  public listAntiSpamRules(): AntiSpamRule[] {
    return this.antiSpam.listRules();
  }

  public upsertAntiSpamRule(input: AntiSpamRuleInput): AntiSpamRule {
    return this.antiSpam.upsertRule(input);
  }

  public setAntiSpamRuleEnabled(
    ruleType: AntiSpamRuleType,
    enabled: boolean,
    actorId: string,
  ): AntiSpamRule | null {
    return this.antiSpam.setRuleEnabled(ruleType, enabled, actorId);
  }

  public listAntiSpamExemptRoleIds(): string[] {
    return this.antiSpam.listExemptRoleIds();
  }

  public listAntiSpamExemptChannelIds(): string[] {
    return this.antiSpam.listExemptChannelIds();
  }

  public listAntiSpamExemptRoles(): string[] {
    return this.listAntiSpamExemptRoleIds();
  }

  public listAntiSpamExemptChannels(): string[] {
    return this.listAntiSpamExemptChannelIds();
  }

  public addAntiSpamExemptRole(roleId: string, actorId: string): boolean {
    this.antiSpam.addExemptRole(roleId, actorId);
    return true;
  }

  public removeAntiSpamExemptRole(roleId: string, _actorId?: string): boolean {
    return this.antiSpam.removeExemptRole(roleId);
  }

  public addAntiSpamExemptChannel(channelId: string, actorId: string): boolean {
    this.antiSpam.addExemptChannel(channelId, actorId);
    return true;
  }

  public removeAntiSpamExemptChannel(
    channelId: string,
    _actorId?: string,
  ): boolean {
    return this.antiSpam.removeExemptChannel(channelId);
  }

  public reserveAntiSpamEnforcement(
    input: AntiSpamEnforcementReservationInput,
  ): AntiSpamEnforcementReservationResult {
    return this.antiSpam.reserveEnforcement(input);
  }

  public completeAntiSpamEnforcement(
    reservationId: string,
    input: AntiSpamEnforcementCompletionInput,
  ): AntiSpamEnforcement | null {
    return this.antiSpam.completeEnforcement(reservationId, input);
  }

  public getAntiSpamEnforcement(
    enforcementId: string,
  ): AntiSpamEnforcement | null {
    return this.antiSpam.getEnforcement(enforcementId);
  }

  public listAntiSpamEnforcements(
    limit?: number,
    offset?: number,
  ): AntiSpamEnforcement[] {
    return this.antiSpam.listEnforcements(limit, offset);
  }

  public listAntiSpamEvents(limit?: number, offset?: number): AntiSpamEvent[] {
    return this.antiSpam.listEvents(limit, offset);
  }

  public recoverExpiredAntiSpamEnforcements(limit?: number): number {
    return this.antiSpam.recoverExpiredEnforcements(limit);
  }

  public getMudaeWatchDelivery(
    messageId: string,
  ): MudaeWatchDeliveryRecord | null {
    return this.mudaeWatchDeliveries.getDelivery(messageId);
  }

  public countMudaeWatchDeliveries(): number {
    return this.mudaeWatchDeliveries.countDeliveries();
  }

  public reserveMudaeWatchDelivery(
    messageId: string,
  ): MudaeWatchDeliveryReservationResult {
    return this.mudaeWatchDeliveries.reserveDelivery(messageId);
  }

  public completeMudaeWatchDelivery(
    reservationId: string,
    outcome: MudaeWatchDeliveryOutcome,
  ): MudaeWatchDeliveryRecord | null {
    return this.mudaeWatchDeliveries.completeDelivery(reservationId, outcome);
  }

  public releaseMudaeWatchDelivery(reservationId: string): boolean {
    return this.mudaeWatchDeliveries.releaseDelivery(reservationId);
  }

  public pruneMudaeWatchDeliveries(): number {
    return this.mudaeWatchDeliveries.pruneDeliveries();
  }

  public grantRoleCapability(
    roleId: string,
    capability: GuildCapability,
    grantedBy: string,
  ): CapabilityGrantResult {
    return this.access.grantRoleCapability(roleId, capability, grantedBy);
  }

  public revokeRoleCapability(
    roleId: string,
    capability: GuildCapability,
  ): CapabilityRevokeResult {
    return this.access.revokeRoleCapability(roleId, capability);
  }

  public listCapabilityGrants(
    limit?: number,
    offset?: number,
  ): RoleCapabilityGrant[] {
    return this.access.listCapabilityGrants(limit, offset);
  }

  public listCapabilityGrantsForCapability(
    capability: GuildCapability,
    limit?: number,
    offset?: number,
  ): RoleCapabilityGrant[] {
    return this.access.listCapabilityGrantsForCapability(
      capability,
      limit,
      offset,
    );
  }

  public listCapabilitiesForRoles(
    roleIds: readonly string[],
  ): RoleCapabilityGrant[] {
    return this.access.listCapabilitiesForRoles(roleIds);
  }

  public getRestrictedPingRole(
    roleId: string,
  ): RestrictedPingRoleConfiguration | null {
    return this.restrictedPings.getRole(roleId);
  }

  public listRestrictedPingRoles(
    limit?: number,
    offset?: number,
  ): RestrictedPingRoleConfiguration[] {
    return this.restrictedPings.listRoles(limit, offset);
  }

  public countRestrictedPingRoles(): number {
    return this.restrictedPings.countRoles();
  }

  public listRestrictedPingMappings(
    roleId: string,
    limit?: number,
    offset?: number,
  ): RestrictedPingMapping[] {
    return this.restrictedPings.listMappings(roleId, limit, offset);
  }

  public addRestrictedPingMapping(
    input: RestrictedPingAddMappingInput,
  ): RestrictedPingAddMappingResult {
    return this.restrictedPings.addMapping(input);
  }

  public removeRestrictedPingMapping(
    roleId: string,
    channelId: string,
    removedBy: string,
  ): RestrictedPingRemoveMappingResult {
    return this.restrictedPings.removeMapping(roleId, channelId, removedBy);
  }

  public configureRestrictedPingRole(
    roleId: string,
    update: RestrictedPingConfigureInput,
  ): RestrictedPingRoleConfiguration | null {
    return this.restrictedPings.configureRole(roleId, update);
  }

  public setRestrictedPingRoleEnabled(
    roleId: string,
    enabled: boolean,
    updatedBy: string,
    bindingsVerifiedAt?: string | null,
  ): RestrictedPingRoleConfiguration | null {
    return this.restrictedPings.setRoleEnabled(
      roleId,
      enabled,
      updatedBy,
      bindingsVerifiedAt,
    );
  }

  public reserveRestrictedPing(
    input: RestrictedPingReservationInput,
  ): RestrictedPingReservationResult {
    return this.restrictedPings.reservePing(input);
  }

  public completeRestrictedPing(
    reservationId: string,
    messageId?: string | null,
  ): RestrictedPingCompletionResult {
    return this.restrictedPings.completePing(reservationId, messageId);
  }

  public releaseRestrictedPing(
    reservationId: string,
    reason?: string,
  ): boolean {
    return this.restrictedPings.releasePing(reservationId, reason);
  }

  public cleanupRestrictedPingRole(
    roleId: string,
    actorId?: string,
  ): RestrictedPingCleanupResult {
    return this.restrictedPings.cleanupDeletedRole(roleId, actorId);
  }

  public cleanupRestrictedPingChannel(
    channelId: string,
    actorId?: string,
  ): RestrictedPingCleanupResult {
    return this.restrictedPings.cleanupDeletedChannel(channelId, actorId);
  }

  public listRestrictedPingEvents(
    limit?: number,
    offset?: number,
  ): RestrictedPingEvent[] {
    return this.restrictedPings.listEvents(limit, offset);
  }

  public createTicketDepartment(
    input: TicketDepartmentInput,
  ): TicketDepartment {
    return this.departments.createDepartment(input);
  }

  public updateTicketDepartment(
    departmentId: string,
    input: TicketDepartmentUpdate,
  ): TicketDepartment | null {
    return this.departments.updateDepartment(departmentId, input);
  }

  public setTicketDepartmentEnabled(
    departmentId: string,
    enabled: boolean,
  ): TicketDepartment | null {
    return this.departments.setDepartmentEnabled(departmentId, enabled);
  }

  public disableAllTicketDepartments(): number {
    return this.departments.disableAllDepartments();
  }

  public deleteTicketDepartment(
    departmentId: string,
  ): TicketDepartmentDeleteResult {
    return this.departments.deleteDepartment(departmentId);
  }

  public getTicketDepartment(departmentId: string): TicketDepartment | null {
    return this.departments.getDepartment(departmentId);
  }

  public getTicketDepartmentBySlug(slug: string): TicketDepartment | null {
    return this.departments.getDepartmentBySlug(slug);
  }

  public listTicketDepartments(
    options: {
      enabled?: boolean;
      limit?: number;
      offset?: number;
    } = {},
  ): TicketDepartment[] {
    return this.departments.listDepartments(options);
  }

  public countTicketDepartments(): number {
    return this.departments.countDepartments();
  }

  public upsertTicketDepartmentField(
    departmentId: string,
    input: TicketDepartmentFieldInput,
  ): TicketDepartmentField {
    return this.departments.upsertDepartmentField(departmentId, input);
  }

  public removeTicketDepartmentField(
    departmentId: string,
    fieldId: string,
  ): boolean {
    return this.departments.removeDepartmentField(departmentId, fieldId);
  }

  public reorderTicketDepartmentFields(
    departmentId: string,
    fieldIds: readonly string[],
  ): TicketDepartmentField[] {
    return this.departments.reorderDepartmentFields(departmentId, fieldIds);
  }

  public getTicketDepartmentField(
    departmentId: string,
    fieldId: string,
  ): TicketDepartmentField | null {
    return this.departments.getDepartmentField(departmentId, fieldId);
  }

  public listTicketDepartmentFields(
    departmentId: string,
  ): TicketDepartmentField[] {
    return this.departments.listDepartmentFields(departmentId);
  }

  public getSuggestionConfiguration(): SuggestionConfiguration | null {
    return this.suggestions.getConfiguration();
  }

  public upsertSuggestionConfiguration(
    input: SuggestionConfigurationInput,
  ): SuggestionConfiguration {
    return this.suggestions.upsertConfiguration(input);
  }

  public disableSuggestionConfiguration(): SuggestionConfiguration | null {
    return this.suggestions.disableConfiguration();
  }

  public reserveSuggestion(
    input: SuggestionReservationInput,
  ): SuggestionReservationResult {
    return this.suggestions.reserveSuggestion(input);
  }

  public bindSuggestionDelivery(
    suggestionId: string,
    input: SuggestionDeliveryInput,
  ): SuggestionDeliveryResult {
    return this.suggestions.bindSuggestionDelivery(suggestionId, input);
  }

  public failSuggestionDelivery(
    suggestionId: string,
    reason: string,
  ): SuggestionDeliveryResult {
    return this.suggestions.failSuggestionDelivery(suggestionId, reason);
  }

  public markSuggestionDeliveryMissing(
    suggestionId: string,
    actorId?: string | null,
  ): SuggestionDeliveryResult {
    return this.suggestions.markSuggestionDeliveryMissing(
      suggestionId,
      actorId,
    );
  }

  public toggleSuggestionVote(
    suggestionId: string,
    voterId: string,
    vote: SuggestionVoteValue,
  ): SuggestionVoteResult {
    return this.suggestions.toggleVote(suggestionId, voterId, vote);
  }

  public reviewSuggestion(
    suggestionId: string,
    input: SuggestionReviewInput,
  ): SuggestionTransitionResult {
    return this.suggestions.reviewSuggestion(suggestionId, input);
  }

  public withdrawSuggestion(
    suggestionId: string,
    authorId: string,
  ): SuggestionTransitionResult {
    return this.suggestions.withdrawSuggestion(suggestionId, authorId);
  }

  public getSuggestionById(suggestionId: string): SuggestionRecord | null {
    return this.suggestions.getSuggestionById(suggestionId);
  }

  public getSuggestionByNumber(
    suggestionNumber: number,
  ): SuggestionRecord | null {
    return this.suggestions.getSuggestionByNumber(suggestionNumber);
  }

  public getSuggestionByMessage(
    channelId: string,
    messageId: string,
  ): SuggestionRecord | null {
    return this.suggestions.getSuggestionByMessage(channelId, messageId);
  }

  public listSuggestions(
    options: {
      state?: SuggestionState;
      authorId?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): SuggestionRecord[] {
    return this.suggestions.listSuggestions(options);
  }

  public getSuggestionVote(
    suggestionId: string,
    voterId: string,
  ): SuggestionVote | null {
    return this.suggestions.getVote(suggestionId, voterId);
  }

  public getSuggestionVoteCounts(suggestionId: string): SuggestionVoteCounts {
    return this.suggestions.getVoteCounts(suggestionId);
  }

  public appendSuggestionEvent(
    suggestionId: string,
    input: SuggestionEventInput,
  ): SuggestionEvent | null {
    return this.suggestions.appendEvent(suggestionId, input);
  }

  public listSuggestionEvents(
    suggestionId: string,
    limit?: number,
    offset?: number,
  ): SuggestionEvent[] {
    return this.suggestions.listEvents(suggestionId, limit, offset);
  }

  public createApplicationForm(input: ApplicationFormInput): ApplicationForm {
    return this.applications.createForm(input);
  }

  public updateApplicationForm(
    formId: string,
    input: ApplicationFormUpdate,
  ): ApplicationForm | null {
    return this.applications.updateForm(formId, input);
  }

  public setApplicationFormEnabled(
    formId: string,
    enabled: boolean,
  ): ApplicationForm | null {
    return this.applications.setFormEnabled(formId, enabled);
  }

  public deleteApplicationForm(formId: string): ApplicationFormDeleteResult {
    return this.applications.deleteForm(formId);
  }

  public getApplicationForm(formId: string): ApplicationForm | null {
    return this.applications.getForm(formId);
  }

  public getApplicationFormBySlug(slug: string): ApplicationForm | null {
    return this.applications.getFormBySlug(slug);
  }

  public listApplicationForms(
    options: { enabledOnly?: boolean; limit?: number; offset?: number } = {},
  ): ApplicationForm[] {
    return this.applications.listForms(options);
  }

  public upsertApplicationFormField(
    formId: string,
    input: ApplicationFormFieldInput,
  ): ApplicationFormField {
    return this.applications.upsertFormField(formId, input);
  }

  public removeApplicationFormField(formId: string, fieldId: string): boolean {
    return this.applications.removeFormField(formId, fieldId);
  }

  public reorderApplicationFormFields(
    formId: string,
    fieldIds: readonly string[],
  ): ApplicationFormField[] {
    return this.applications.reorderFormFields(formId, fieldIds);
  }

  public getApplicationFormField(
    formId: string,
    fieldId: string,
  ): ApplicationFormField | null {
    return this.applications.getFormField(formId, fieldId);
  }

  public listApplicationFormFields(formId: string): ApplicationFormField[] {
    return this.applications.listFormFields(formId);
  }

  public reserveApplication(
    input: ApplicationReservationInput,
  ): ApplicationReservationResult {
    return this.applications.reserveApplication(input);
  }

  public bindApplicationDelivery(
    applicationId: string,
    input: ApplicationDeliveryInput,
  ): ApplicationDeliveryResult {
    return this.applications.bindDelivery(applicationId, input);
  }

  public failApplicationDelivery(
    applicationId: string,
    reason: string,
  ): ApplicationDeliveryResult {
    return this.applications.failDelivery(applicationId, reason);
  }

  public markApplicationDeliveryMissing(
    applicationId: string,
    expectedUpdatedAt?: string,
  ): ApplicationDeliveryResult {
    return this.applications.markDeliveryMissing(
      applicationId,
      expectedUpdatedAt,
    );
  }

  public claimApplication(
    applicationId: string,
    reviewerId: string,
    expectedUpdatedAt?: string,
  ): ApplicationTransitionResult {
    return this.applications.claimApplication(
      applicationId,
      reviewerId,
      expectedUpdatedAt,
    );
  }

  public decideApplication(
    applicationId: string,
    input: ApplicationDecisionInput,
  ): ApplicationTransitionResult {
    return this.applications.decideApplication(applicationId, input);
  }

  public withdrawApplication(
    applicationId: string,
    applicantId: string,
    expectedUpdatedAt?: string,
  ): ApplicationTransitionResult {
    return this.applications.withdrawApplication(
      applicationId,
      applicantId,
      expectedUpdatedAt,
    );
  }

  public getApplicationById(applicationId: string): ApplicationRecord | null {
    return this.applications.getApplicationById(applicationId);
  }

  public hasApplicationsForForm(formId: string): boolean {
    return this.applications.hasApplicationsForForm(formId);
  }

  public getApplicationByNumber(
    applicationNumber: number,
  ): ApplicationRecord | null {
    return this.applications.getApplicationByNumber(applicationNumber);
  }

  public getApplicationByReviewMessage(
    reviewChannelId: string,
    reviewMessageId: string,
  ): ApplicationRecord | null {
    return this.applications.getApplicationByReviewMessage(
      reviewChannelId,
      reviewMessageId,
    );
  }

  public listApplications(
    filter: ApplicationListFilter = {},
    limit?: number,
    offset?: number,
  ): ApplicationRecord[] {
    return this.applications.listApplications(filter, limit, offset);
  }

  public listApplicationResponses(
    applicationId: string,
  ): ApplicationResponse[] {
    return this.applications.listResponses(applicationId);
  }

  public appendApplicationEvent(
    applicationId: string,
    input: ApplicationEventInput,
  ): ApplicationEvent | null {
    return this.applications.appendEvent(applicationId, input);
  }

  public listApplicationEvents(
    applicationId: string,
    limit?: number,
    offset?: number,
  ): ApplicationEvent[] {
    return this.applications.listEvents(applicationId, limit, offset);
  }

  public listAllApplicationEvents(
    limit?: number,
    offset?: number,
  ): ApplicationEvent[] {
    return this.applications.listAllEvents(limit, offset);
  }

  public getSettings(): GuildSettings {
    const settings = this.root.getGuildSettings(this.guildId);
    if (!settings) {
      throw new Error(`Guild ${this.guildId} has no settings`);
    }
    return settings;
  }

  public getTicketConfiguration(): TicketConfiguration | null {
    return this.operational.getTicketConfiguration();
  }

  public upsertTicketConfiguration(
    input: TicketConfigurationInput,
  ): TicketConfiguration {
    return this.operational.upsertTicketConfiguration(input);
  }

  public disableTicketConfiguration(): TicketConfiguration | null {
    return this.operational.disableTicketConfiguration();
  }

  public createPostedPanel(input: PostedPanelInput): PostedPanel {
    return this.operational.createPostedPanel(input);
  }

  public upsertPostedPanel(input: PostedPanelInput): PostedPanel {
    return this.operational.upsertPostedPanel(input);
  }

  public listPostedPanels(
    preset?: PanelPreset,
    limit?: number,
    offset?: number,
  ): PostedPanel[] {
    return this.operational.listPostedPanels(preset, limit, offset);
  }

  public countPostedPanels(preset?: PanelPreset): number {
    return this.operational.countPostedPanels(preset);
  }

  public findPostedPanelByToken(panelId: string): PostedPanel | null {
    return this.operational.findPostedPanelByToken(panelId);
  }

  public findPostedPanelByPresetAndChannel(
    preset: PanelPreset,
    channelId: string,
  ): PostedPanel | null {
    return this.operational.findPostedPanelByPresetAndChannel(
      preset,
      channelId,
    );
  }

  public deletePostedPanel(panelId: string): boolean {
    return this.operational.deletePostedPanel(panelId);
  }

  public reserveTicketCreation(
    input: TicketCreationInput,
  ): TicketReservationResult {
    return this.operational.reserveTicketCreation(input);
  }

  public activateTicketCreation(
    ticketId: string,
    input: TicketActivationInput,
  ): TicketActivationResult {
    return this.operational.activateTicketCreation(ticketId, input);
  }

  public failTicketCreation(
    ticketId: string,
    reason: string,
  ): TicketCreationFailureResult {
    return this.operational.failTicketCreation(ticketId, reason);
  }

  public getTicketById(ticketId: string): TicketRecord | null {
    return this.operational.getTicketById(ticketId);
  }

  public getTicketByNumber(ticketNumber: number): TicketRecord | null {
    return this.operational.getTicketByNumber(ticketNumber);
  }

  public getTicketByChannel(channelId: string): TicketRecord | null {
    return this.operational.getTicketByChannel(channelId);
  }

  public getTicketByOpener(openerId: string): TicketRecord | null {
    return this.operational.getTicketByOpener(openerId);
  }

  public getActiveTicketByOpener(openerId: string): TicketRecord | null {
    return this.getTicketByOpener(openerId);
  }

  public getTicketByOpenerAndDepartment(
    openerId: string,
    departmentId: string,
  ): TicketRecord | null {
    return this.operational.getTicketByOpenerAndDepartment(
      openerId,
      departmentId,
    );
  }

  public listTicketResponses(ticketId: string): TicketFormResponse[] {
    return this.operational.listTicketResponses(ticketId);
  }

  public hasActiveTicketsForDepartment(departmentId: string): boolean {
    return this.operational.hasActiveTicketsForDepartment(departmentId);
  }

  public countTickets(states?: readonly TicketState[]): number {
    return this.operational.countTickets(states);
  }

  public listTickets(
    states?: readonly TicketState[],
    limit?: number,
    offset?: number,
  ): TicketRecord[] {
    return this.operational.listTickets(states, limit, offset);
  }

  public claimTicket(ticketId: string, staffUserId: string): TicketClaimResult {
    return this.operational.claimTicket(ticketId, staffUserId);
  }

  public releaseTicket(
    ticketId: string,
    staffUserId: string,
  ): TicketReleaseResult {
    return this.operational.releaseTicket(ticketId, staffUserId);
  }

  public beginTicketClose(
    ticketId: string,
    staffUserId: string,
    reason: string,
  ): TicketCloseStartResult {
    return this.operational.beginTicketClose(ticketId, staffUserId, reason);
  }

  public reopenAfterCloseFailure(
    ticketId: string,
    failureReason: string,
  ): TicketCloseRollbackResult {
    return this.operational.reopenAfterCloseFailure(ticketId, failureReason);
  }

  public finishTicketClose(ticketId: string): TicketCloseFinishResult {
    return this.operational.finishTicketClose(ticketId);
  }

  public markTicketLogDelivered(
    ticketId: string,
    logMessageId: string,
    expectedUpdatedAt?: string,
  ): TicketCloseLogResult {
    return this.operational.markTicketLogDelivered(
      ticketId,
      logMessageId,
      expectedUpdatedAt,
    );
  }

  public rebindTicket(
    ticketId: string,
    input: TicketRebindInput,
    actorId?: string | null,
  ): TicketRebindResult {
    return this.operational.rebindTicket(ticketId, input, actorId);
  }

  public appendTicketEvent(
    ticketId: string,
    input: TicketEventInput,
  ): TicketEvent | null {
    return this.operational.appendTicketEvent(ticketId, input);
  }

  public listTicketEvents(
    ticketId: string,
    limit?: number,
    offset?: number,
  ): TicketEvent[] {
    return this.operational.listTicketEvents(ticketId, limit, offset);
  }

  public listAllTicketEvents(limit?: number, offset?: number): TicketEvent[] {
    return this.operational.listAllTicketEvents(limit, offset);
  }

  public recordCommandMetric(commandName: string, success = true): void {
    // Keep input validation synchronous even when the write is deferred.
    commandMetricKey(commandName);
    if (!success) commandMetricKey(commandName, true);
    this.root.scheduleNonessential(() =>
      observeLatencySync(
        "sqlite.operation",
        "recordCommandMetric",
        () => this.recordCommandMetricNow(commandName, success),
        { guildId: this.guildId },
      ),
    );
  }

  private recordCommandMetricNow(commandName: string, success: boolean): void {
    const usageKey = commandMetricKey(commandName);
    const failureKey = success ? null : commandMetricKey(commandName, true);
    const record = this.db.transaction(() => {
      const guildExists = this.db
        .prepare("SELECT 1 FROM guilds WHERE guild_id = ?")
        .get(this.guildId);
      if (!guildExists) return;
      this.metricsIncrement(usageKey);
      if (failureKey) {
        this.metricsIncrement(failureKey);
      }
    });
    record.immediate();
  }

  public incrementUserMetric(
    userId: string,
    metric: UserActivityMetric,
    amount = 1,
  ): number {
    const metricKey = buildUserMetricKey(userId, metric);
    const normalizedAmount = normalizeMetricValue(amount);
    let result = 0;
    this.root.scheduleNonessential(() => {
      result = observeLatencySync(
        "sqlite.operation",
        "incrementUserMetric",
        () => this.metricsIncrement(metricKey, normalizedAmount),
        { guildId: this.guildId },
      );
    });
    return result;
  }

  public setUserMetric(
    userId: string,
    metric: UserActivityMetric,
    value: number,
  ): void {
    this.metricsSet(buildUserMetricKey(userId, metric), value);
  }

  public getUserMetrics(userId: string): UserMetrics {
    const normalized = assertDiscordSnowflake(userId, "user ID");
    return Object.fromEntries(
      USER_ACTIVITY_METRICS.map((metric) => [
        metric,
        Number(this.metricsGet(buildUserMetricKey(normalized, metric), "0")),
      ]),
    ) as UserMetrics;
  }

  public getUserLeaderboard(
    metric: UserActivityMetric,
    limit = 10,
  ): UserLeaderboardEntry[] {
    const validatedMetric = assertUserActivityMetric(metric);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("Leaderboard limit must be between 1 and 100");
    }
    const suffix = `.${validatedMetric}`;
    const rows = this.db
      .prepare(
        `SELECT metric_key, metric_value
         FROM metrics
         WHERE guild_id = ? AND metric_key GLOB 'user_stats.*'
         ORDER BY metric_value DESC, metric_key ASC`,
      )
      .all(this.guildId) as Array<{
      metric_key: string;
      metric_value: number;
    }>;
    const result: UserLeaderboardEntry[] = [];
    for (const row of rows) {
      if (!row.metric_key.endsWith(suffix)) {
        continue;
      }
      const userId = row.metric_key.slice("user_stats.".length, -suffix.length);
      if (/^\d{17,20}$/.test(userId)) {
        result.push({ userId, value: row.metric_value });
      }
      if (result.length === limit) {
        break;
      }
    }
    return result;
  }

  public replaceUserActivityMetrics(rows: UserMetricReplacement[]): void {
    const normalizedRows = validateMetricReplacements(rows);
    const replace = this.db.transaction(() => {
      this.db
        .prepare(
          `DELETE FROM metrics
           WHERE guild_id = ? AND (
             metric_key GLOB 'user_stats.*.messages_sent'
             OR metric_key GLOB 'user_stats.*.reactions_sent'
             OR metric_key GLOB 'user_stats.*.reactions_received'
           )`,
        )
        .run(this.guildId);
      const insert = this.db.prepare(
        `INSERT INTO metrics (
           guild_id, metric_key, metric_value, updated_at
         ) VALUES (?, ?, ?, ?)`,
      );
      const now = utcNow();
      for (const row of normalizedRows) {
        for (const metric of HISTORY_ACTIVITY_METRICS) {
          const value = row.metrics[metric];
          if (value > 0) {
            insert.run(
              this.guildId,
              buildUserMetricKey(row.userId, metric),
              value,
              now,
            );
          }
        }
      }
    });
    replace.immediate();
  }

  public metricsGet(key: string, defaultValue: string): string {
    const metricKey = assertActiveMetricKey(key);
    const row = this.db
      .prepare(
        "SELECT metric_value FROM metrics WHERE guild_id = ? AND metric_key = ?",
      )
      .get(this.guildId, metricKey) as { metric_value: number } | undefined;
    return row ? String(row.metric_value) : defaultValue;
  }

  public metricsSet(key: string, value: string | number): void {
    const metricKey = assertActiveMetricKey(key);
    const metricValue = normalizeMetricValue(value);
    this.db
      .prepare(
        `INSERT INTO metrics (
           guild_id, metric_key, metric_value, updated_at
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT(guild_id, metric_key) DO UPDATE SET
           metric_value = excluded.metric_value,
           updated_at = excluded.updated_at`,
      )
      .run(this.guildId, metricKey, metricValue, utcNow());
  }

  public metricsIncrement(key: string, amount = 1): number {
    const metricKey = assertActiveMetricKey(key);
    const increment = normalizeMetricValue(amount);
    let value = 0;
    const update = this.db.transaction(() => {
      const current = Number(this.metricsGet(metricKey, "0"));
      value = current + increment;
      if (!Number.isSafeInteger(value)) {
        throw new RangeError("Metric value exceeds the safe-integer range");
      }
      this.metricsSet(metricKey, value);
    });
    update.immediate();
    return value;
  }
}

/** Adds timing to root SQLite operations without exposing arguments or SQL. */
export function instrumentBotStorage(storage: BotStorage): BotStorage {
  const wrappedMethods = new Map<PropertyKey, (...args: never[]) => unknown>();
  return new Proxy(storage, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (
        typeof value !== "function" ||
        property === "constructor" ||
        ROOT_STORAGE_EXCLUDED_METHODS.has(property)
      ) {
        return value;
      }
      const existing = wrappedMethods.get(property);
      if (existing) return existing;
      const wrapped = (...args: never[]): unknown =>
        observeLatencySync(
          "sqlite.operation",
          typeof property === "string" ? property : "method",
          () => value.apply(target, args),
        );
      wrappedMethods.set(property, wrapped);
      return wrapped;
    },
  });
}

const ROOT_STORAGE_EXCLUDED_METHODS = new Set<PropertyKey>([
  "forGuild",
  "getGuildEnableExpectation",
  "isGuildCurrent",
  "saveGuildSettings",
  "setGuildEnabled",
  "setNonessentialScheduler",
  "scheduleNonessential",
]);

/** Adds per-operation SQLite timing without exposing SQL, keys, or payloads. */
function instrumentGuildStorage(storage: GuildStorage): GuildStorage {
  const wrappedMethods = new Map<PropertyKey, (...args: never[]) => unknown>();
  return new Proxy(storage, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || property === "constructor") {
        return value;
      }
      const existing = wrappedMethods.get(property);
      if (existing) return existing;
      const wrapped = (...args: never[]): unknown =>
        observeLatencySync(
          "sqlite.operation",
          typeof property === "string" ? property : "method",
          () => value.apply(target, args),
          { guildId: target.guildId },
        );
      wrappedMethods.set(property, wrapped);
      return wrapped;
    },
  });
}

function parseGuildRow(row: GuildRow): GuildRecord {
  return {
    guildId: row.guild_id,
    enabled: Boolean(row.enabled),
    name: row.name,
    joinedAt: row.joined_at,
    leftAt: row.left_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateMetricReplacements(
  rows: UserMetricReplacement[],
): UserMetricReplacement[] {
  if (!Array.isArray(rows)) {
    throw new TypeError("Metric replacement rows must be an array");
  }
  const users = new Set<string>();
  return rows.map((row) => {
    const userId = assertDiscordSnowflake(row.userId, "user ID");
    if (users.has(userId)) {
      throw new TypeError(`Duplicate metric replacement user ${userId}`);
    }
    users.add(userId);
    const keys = Object.keys(row.metrics).sort();
    if (!isDeepStrictEqual(keys, [...USER_ACTIVITY_METRICS].sort())) {
      throw new TypeError("Each replacement must contain every user metric");
    }
    const metrics = Object.fromEntries(
      USER_ACTIVITY_METRICS.map((metric) => [
        metric,
        normalizeMetricValue(row.metrics[metric]),
      ]),
    ) as UserMetrics;
    return { userId, metrics };
  });
}

function normalizeMetricValue(value: string | number): number {
  const normalized = typeof value === "string" ? value.trim() : value;
  if (
    (typeof normalized === "string" && !/^(?:0|[1-9]\d*)$/.test(normalized)) ||
    (typeof normalized !== "string" && typeof normalized !== "number")
  ) {
    throw new TypeError("Metric value must be a non-negative integer");
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError("Metric value must be a non-negative safe integer");
  }
  return parsed;
}

function normalizeGuildName(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const normalized = String(value).normalize("NFKC").trim();
  return normalized ? normalized.slice(0, 100) : null;
}

function normalizeObservedTimestamp(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeImportedTimestamp(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Imported timestamp must be an ISO timestamp");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError("Imported timestamp must be an ISO timestamp");
  }
  return new Date(timestamp).toISOString();
}

function utcNow(): string {
  return new Date().toISOString();
}
