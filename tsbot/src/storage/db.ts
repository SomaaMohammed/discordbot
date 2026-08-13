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
import type {
  CapabilityGrantResult,
  CapabilityRevokeResult,
  GuildCapability,
  GuildDataExport,
  GuildMetricExport,
  GuildPurgeResult,
  GuildRecord,
  GuildSettings,
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
  initializeV8Schema,
  validateV8Schema,
} from "./schema.js";
import { GuildOperationalRepository } from "./operational-repository.js";
import { GuildAccessRepository } from "./access-repository.js";
import { TicketDepartmentRepository } from "./ticket-department-repository.js";
import { SuggestionRepository } from "./suggestion-repository.js";
import { RestrictedPingRepository } from "./restricted-ping-repository.js";
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
        initializeV8Schema(memory, utcNow());
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
        "Database schema v1 is not supported by v8 startup. Upgrade through the final v4 release to schema v2, create an offline backup, stop every older executable, then run the current migration command.",
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
        `Database schema v7 requires an explicit migration to v8. Stop every older Superior executable, create an offline backup, then run npm run migrate -- --db ${dbFile}. After migration, do not run a pre-6.0.0 executable against this database.`,
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
        initializeV8Schema(writable, utcNow());
      } else {
        const issues = validateV8Schema(writable);
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

  public pruneMudaeWatchDeliveries(): number {
    return pruneAllMudaeWatchDeliveries(this.requireDatabase());
  }

  public forGuild(guildId: string): GuildStorage {
    const normalized = assertDiscordSnowflake(guildId);
    if (!this.getGuild(normalized)) {
      throw new Error(`Guild ${normalized} is not configured`);
    }
    return new GuildStorage(this.requireDatabase(), this, normalized);
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
    const normalized = assertDiscordSnowflake(guildId);
    const settings = this.getGuildSettings(normalized);
    const guild = this.getGuild(normalized);
    return settings && guild
      ? { settings, lifecycleJoinedAt: guild.joinedAt }
      : null;
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
        formatVersion: 6,
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
      deactivatePhase2OperationalBindings(db, normalized);
      deactivateRestrictedPingBindings(db, normalized);
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
    };
  }

  private estimateGuildExportBytes(guildId: string): number {
    const tables = [
      "guilds",
      "guild_settings",
      "metrics",
      ...PHASE2_GUILD_TABLES,
      ...RESTRICTED_PING_GUILD_TABLES,
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
      | (typeof RESTRICTED_PING_GUILD_TABLES)[number],
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
    return this.metricsIncrement(buildUserMetricKey(userId, metric), amount);
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
