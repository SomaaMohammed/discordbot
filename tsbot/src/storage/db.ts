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
  GuildDataExport,
  GuildMetricExport,
  GuildPurgeResult,
  GuildRecord,
  GuildSettings,
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
  initializeV4Schema,
  validateV4Schema,
} from "./schema.js";
import { GuildOperationalRepository } from "./operational-repository.js";
import {
  GUILD_DATA_COLLECTION_LIMITS,
  insertImportedOperationalData,
  parseGuildDataExport,
} from "./guild-data.js";
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
      const memory = new Database(":memory:");
      try {
        memory.pragma("foreign_keys = ON");
        initializeV4Schema(memory, utcNow());
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
        "Database schema v1 is not supported by v5 startup. Upgrade through the final v4 release to schema v2, create an offline backup, then run the v5 migration command.",
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
    if (schema === "unknown") {
      throw new Error(
        "Database schema is unknown or incomplete; startup refused without modifying it",
      );
    }

    const writable = new Database(dbFile);
    try {
      writable.pragma("foreign_keys = ON");
      if (schema === "empty") {
        initializeV4Schema(writable, utcNow());
      } else {
        const issues = validateV4Schema(writable);
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
         ) VALUES (?, 0, ?, ?, NULL, ?, ?)
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
         ) VALUES (?, 0, ?, ?, NULL, ?, ?)
         ON CONFLICT(guild_id) DO UPDATE SET
           enabled = 0,
           name = COALESCE(excluded.name, guilds.name),
           joined_at = excluded.joined_at,
           left_at = NULL,
           updated_at = excluded.updated_at`,
      ).run(normalized, guildName, joinedAt, now, now);
      const settings = priorSettings ?? createDefaultGuildSettings();
      settings.enabled = false;
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
      // Every configuration edit is fail-closed. The administrator-only,
      // compare-and-swap enable path is the sole operation that can clear the
      // review gate and make the edited configuration live.
      next.enabled = false;
      next.reviewRequired = true;
      const validated = sanitizeGuildSettings(next);
      db.prepare(
        "UPDATE guilds SET enabled = 0, updated_at = ? WHERE guild_id = ?",
      ).run(now, normalized);
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
      current.reviewRequired = !enabled;
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
          "posted panels",
          counts.postedPanels,
          GUILD_DATA_COLLECTION_LIMITS.postedPanels,
        ],
        ["tickets", counts.tickets, GUILD_DATA_COLLECTION_LIMITS.tickets],
        [
          "ticket events",
          counts.ticketEvents,
          GUILD_DATA_COLLECTION_LIMITS.ticketEvents,
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
      const guildStorage = this.forGuild(normalized);
      const tickets = guildStorage.listTickets().reverse();
      return {
        formatVersion: 3,
        guildId: normalized,
        exportedAt: utcNow(),
        metadata,
        settings,
        metrics: rows.map((row): GuildMetricExport => ({
          key: row.metric_key,
          value: row.metric_value,
          updatedAt: row.updated_at,
        })),
        ticketConfiguration: guildStorage.getTicketConfiguration(),
        postedPanels: guildStorage.listPostedPanels(),
        tickets,
        ticketEvents: guildStorage.listAllTicketEvents(),
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
      settings.enabled = false;
      settings.reviewRequired = true;
      const reviewed = sanitizeGuildSettings(settings);

      db.prepare(
        "UPDATE guilds SET enabled = 0, updated_at = ? WHERE guild_id = ?",
      ).run(now, normalized);
      this.upsertSettings(normalized, reviewed, now);
      db.prepare("DELETE FROM metrics WHERE guild_id = ?").run(normalized);
      if (imported.sourceFormatVersion === 3) {
        db.prepare("DELETE FROM ticket_events WHERE guild_id = ?").run(
          normalized,
        );
        db.prepare("DELETE FROM tickets WHERE guild_id = ?").run(normalized);
        db.prepare("DELETE FROM posted_panels WHERE guild_id = ?").run(
          normalized,
        );
        db.prepare("DELETE FROM ticket_configurations WHERE guild_id = ?").run(
          normalized,
        );
      }
      const insert = db.prepare(
        `INSERT INTO metrics (
           guild_id, metric_key, metric_value, updated_at
         ) VALUES (?, ?, ?, ?)`,
      );
      for (const metric of imported.metrics) {
        insert.run(normalized, metric.key, metric.value, metric.updatedAt);
      }
      if (imported.sourceFormatVersion === 3) {
        insertImportedOperationalData(db, normalized, {
          ...imported,
          ticketConfiguration: imported.ticketConfiguration
            ? { ...imported.ticketConfiguration, enabled: false }
            : null,
        });
      }
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
        "ticket_configurations",
        "posted_panels",
        "tickets",
        "ticket_events",
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
      ticketConfigurations: this.countGuildRows(
        "ticket_configurations",
        guildId,
      ),
      postedPanels: this.countGuildRows("posted_panels", guildId),
      tickets: this.countGuildRows("tickets", guildId),
      ticketEvents: this.countGuildRows("ticket_events", guildId),
    };
  }

  private estimateGuildExportBytes(guildId: string): number {
    const row = this.requireDatabase()
      .prepare(
        `SELECT
           4096
           + COALESCE((
               SELECT length(CAST(COALESCE(name, '') AS BLOB))
                    + length(CAST(COALESCE(joined_at, '') AS BLOB))
                    + length(CAST(COALESCE(left_at, '') AS BLOB)) + 512
               FROM guilds WHERE guild_id = @guildId
             ), 0)
           + COALESCE((
               SELECT length(CAST(settings_json AS BLOB)) + 512
               FROM guild_settings WHERE guild_id = @guildId
             ), 0)
           + COALESCE((
               SELECT SUM(
                 length(CAST(metric_key AS BLOB))
                 + length(CAST(metric_value AS TEXT))
                 + length(CAST(updated_at AS BLOB)) + 128
               ) FROM metrics WHERE guild_id = @guildId
             ), 0)
           + COALESCE((
               SELECT length(CAST(category_id AS BLOB))
                    + length(CAST(log_channel_id AS BLOB))
                    + length(CAST(support_role_id AS BLOB))
                    + length(CAST(created_at AS BLOB))
                    + length(CAST(updated_at AS BLOB)) + 256
               FROM ticket_configurations WHERE guild_id = @guildId
             ), 0)
           + COALESCE((
               SELECT SUM(
                 length(CAST(panel_id AS BLOB))
                 + length(CAST(preset AS BLOB))
                 + length(CAST(channel_id AS BLOB))
                 + length(CAST(message_id AS BLOB))
                 + length(CAST(configuration_json AS BLOB))
                 + length(CAST(created_at AS BLOB))
                 + length(CAST(updated_at AS BLOB)) + 256
               ) FROM posted_panels WHERE guild_id = @guildId
             ), 0)
           + COALESCE((
               SELECT SUM(
                 length(CAST(ticket_id AS BLOB))
                 + length(CAST(opener_id AS BLOB))
                 + length(CAST(COALESCE(channel_id, '') AS BLOB))
                 + length(CAST(COALESCE(control_message_id, '') AS BLOB))
                 + length(CAST(subject AS BLOB))
                 + length(CAST(description AS BLOB))
                 + length(CAST(COALESCE(close_reason, '') AS BLOB))
                 + length(CAST(COALESCE(failure_reason, '') AS BLOB)) + 1024
               ) FROM tickets WHERE guild_id = @guildId
             ), 0)
           + COALESCE((
               SELECT SUM(
                 length(CAST(ticket_id AS BLOB))
                 + length(CAST(event_id AS BLOB))
                 + length(CAST(event_type AS BLOB))
                 + length(CAST(COALESCE(actor_id, '') AS BLOB))
                 + length(CAST(details_json AS BLOB))
                 + length(CAST(created_at AS BLOB)) + 256
               ) FROM ticket_events WHERE guild_id = @guildId
             ), 0) AS estimated_bytes`,
      )
      .get({ guildId }) as { estimated_bytes: number };
    return Number(row.estimated_bytes);
  }

  private countGuildRows(
    table:
      | "guilds"
      | "guild_settings"
      | "metrics"
      | "ticket_configurations"
      | "posted_panels"
      | "tickets"
      | "ticket_events",
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

  public constructor(
    private readonly db: Database.Database,
    private readonly root: BotStorage,
    public readonly guildId: string,
  ) {
    this.operational = new GuildOperationalRepository(db, guildId);
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

  public listPostedPanels(preset?: PanelPreset): PostedPanel[] {
    return this.operational.listPostedPanels(preset);
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

  public listTickets(states?: readonly TicketState[]): TicketRecord[] {
    return this.operational.listTickets(states);
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

  public listTicketEvents(ticketId: string): TicketEvent[] {
    return this.operational.listTicketEvents(ticketId);
  }

  public listAllTicketEvents(): TicketEvent[] {
    return this.operational.listAllTicketEvents();
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
