import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import Database from "better-sqlite3";
import { DateTime } from "luxon";
import { z } from "zod";
import {
  HISTORY_LIMIT,
  POST_RECORD_LIMIT,
  QUESTIONS_FILE,
  SILENCE_LEASES_METRIC_KEY,
  THREAD_CLOSE_HOURS,
  USER_METRIC_PREFIX,
} from "../constants.js";
import {
  assertDiscordSnowflake,
  createDefaultGuildSettings,
  DISCORD_SNOWFLAKE_PATTERN,
  GuildSettingsSchema,
  parseGuildSettingsJson,
  sanitizeGuildSettings,
  serializeGuildSettings,
} from "../guild-settings.js";
import {
  coerceInt,
  ensureMetricsShape,
  ensureRoyalAfkShape,
  ensureRoyalPresenceShape,
  flattenMetricsForStorage,
} from "../parity.js";
import { isoNow } from "../time.js";
import type {
  CourtState,
  GuildAnswerExport,
  GuildCooldownExport,
  GuildDataExport,
  GuildKvExport,
  GuildMetricExport,
  GuildPurgeResult,
  GuildRecord,
  GuildSettings,
  MetricsShape,
  PostRecord,
  ProcessConfig,
} from "../types.js";
import {
  detectDatabaseSchema,
  initializeV2Schema,
  validateV2Schema,
} from "./schema.js";

interface CountRow {
  count: number;
}

interface JsonRow {
  value: string;
}

interface MetricRow {
  metric_key: string;
  metric_value: string;
  updated_at: string;
}

interface PostRow {
  message_id: string;
  thread_id: string | null;
  channel_id: string;
  category: string;
  question: string;
  posted_at: string;
  close_after_hours: number;
  closed: number;
  closed_at: string | null;
  close_reason: string | null;
}

interface AnswerRecordRow {
  question_message_id: string;
  user_id: string;
}

interface AnswerRow extends AnswerRecordRow {
  answer_message_id: string;
  created_at: string;
}

interface CooldownRow {
  user_id: string;
  last_answer_at: string;
}

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

export class GuildSettingsConflictError extends Error {
  public constructor(guildId: string) {
    super(
      `Guild ${guildId} settings changed while the operation was in progress`,
    );
    this.name = "GuildSettingsConflictError";
  }
}

export interface GuildEnableExpectation {
  settings: GuildSettings;
  lifecycleJoinedAt: string | null;
}

const TENANT_TABLES = [
  "guild_settings",
  "kv",
  "posts",
  "answers",
  "metrics",
  "anon_cooldowns",
] as const;

const OBSOLETE_OR_DERIVED_STATE_KEYS = [
  "mode",
  "hour",
  "minute",
  "channel_id",
  "log_channel_id",
  "dry_run_auto_post",
  "posts",
  "metrics",
] as const;

const IMPORT_SNOWFLAKE_SCHEMA = z.string().regex(DISCORD_SNOWFLAKE_PATTERN);
const IMPORT_ISO_TIMESTAMP_SCHEMA = z
  .string()
  .refine(
    (value) => DateTime.fromISO(value, { setZone: true }).isValid,
    "must be a valid ISO timestamp",
  );
const IMPORT_OPTIONAL_STRING_SCHEMA = z.string().nullable();
const IMPORT_NONNEGATIVE_INTEGER_SCHEMA = z.number().int().nonnegative();

const IMPORT_POST_SCHEMA = z
  .object({
    message_id: IMPORT_SNOWFLAKE_SCHEMA,
    thread_id: IMPORT_SNOWFLAKE_SCHEMA.nullable(),
    channel_id: IMPORT_SNOWFLAKE_SCHEMA,
    category: z.string().refine((value) => value.trim().length > 0),
    question: z.string().refine((value) => value.trim().length > 0),
    posted_at: IMPORT_ISO_TIMESTAMP_SCHEMA,
    close_after_hours: z.number().int().min(1),
    closed: z.boolean(),
    closed_at: IMPORT_ISO_TIMESTAMP_SCHEMA.nullable(),
    close_reason: IMPORT_OPTIONAL_STRING_SCHEMA,
  })
  .strict();

const IMPORT_NUMBER_RECORD_SCHEMA = z.record(
  z.string(),
  IMPORT_NONNEGATIVE_INTEGER_SCHEMA,
);

const IMPORT_METRICS_SHAPE_SCHEMA = z
  .object({
    command_usage: IMPORT_NUMBER_RECORD_SCHEMA,
    command_failures: IMPORT_NUMBER_RECORD_SCHEMA,
    posts_by_category: IMPORT_NUMBER_RECORD_SCHEMA,
    posts_total: IMPORT_NONNEGATIVE_INTEGER_SCHEMA,
    posts_auto: IMPORT_NONNEGATIVE_INTEGER_SCHEMA,
    posts_manual: IMPORT_NONNEGATIVE_INTEGER_SCHEMA,
    custom_posts: IMPORT_NONNEGATIVE_INTEGER_SCHEMA,
    answers_total: IMPORT_NONNEGATIVE_INTEGER_SCHEMA,
    last_successful_auto_post: IMPORT_ISO_TIMESTAMP_SCHEMA.nullable(),
  })
  .strict();

const IMPORT_ROYAL_PRESENCE_SCHEMA = z
  .object({
    last_message_at_by_title: z
      .object({
        Emperor: IMPORT_OPTIONAL_STRING_SCHEMA,
        Empress: IMPORT_OPTIONAL_STRING_SCHEMA,
      })
      .strict(),
    last_message_at: IMPORT_OPTIONAL_STRING_SCHEMA,
    last_speaker: z.enum(["Emperor", "Empress"]).nullable(),
  })
  .strict();

const IMPORT_ROYAL_AFK_ENTRY_SCHEMA = z
  .object({
    active: z.boolean(),
    reason: z.string(),
    set_at: IMPORT_OPTIONAL_STRING_SCHEMA,
    set_by_user_id: IMPORT_OPTIONAL_STRING_SCHEMA,
  })
  .strict();

const IMPORT_ROYAL_AFK_SCHEMA = z
  .object({
    by_title: z
      .object({
        Emperor: IMPORT_ROYAL_AFK_ENTRY_SCHEMA,
        Empress: IMPORT_ROYAL_AFK_ENTRY_SCHEMA,
      })
      .strict(),
  })
  .strict();

const IMPORT_STATE_SCHEMA = z
  .object({
    last_posted_date: IMPORT_OPTIONAL_STRING_SCHEMA,
    last_dry_run_date: IMPORT_OPTIONAL_STRING_SCHEMA,
    last_weekly_digest_week: IMPORT_OPTIONAL_STRING_SCHEMA,
    history: z.array(z.string()),
    used_questions: z.array(z.string()),
    royal_presence: IMPORT_ROYAL_PRESENCE_SCHEMA,
    royal_afk: IMPORT_ROYAL_AFK_SCHEMA,
    posts: z.array(IMPORT_POST_SCHEMA),
    metrics: IMPORT_METRICS_SHAPE_SCHEMA,
  })
  .strict();

const IMPORT_QUESTIONS_SCHEMA = z.record(z.string(), z.array(z.string()));

const IMPORT_GUILD_RECORD_SCHEMA = z
  .object({
    guildId: IMPORT_SNOWFLAKE_SCHEMA,
    enabled: z.boolean(),
    name: z.string().nullable(),
    joinedAt: IMPORT_ISO_TIMESTAMP_SCHEMA.nullable(),
    leftAt: IMPORT_ISO_TIMESTAMP_SCHEMA.nullable(),
    createdAt: IMPORT_ISO_TIMESTAMP_SCHEMA,
    updatedAt: IMPORT_ISO_TIMESTAMP_SCHEMA,
  })
  .strict();

const IMPORT_KV_SCHEMA = z
  .object({
    key: z.string().refine((value) => value.length > 0),
    value: z.string(),
    updatedAt: IMPORT_ISO_TIMESTAMP_SCHEMA,
  })
  .strict();

const IMPORT_ANSWER_SCHEMA = z
  .object({
    questionMessageId: IMPORT_SNOWFLAKE_SCHEMA,
    userId: IMPORT_SNOWFLAKE_SCHEMA,
    answerMessageId: IMPORT_SNOWFLAKE_SCHEMA,
    createdAt: IMPORT_ISO_TIMESTAMP_SCHEMA,
  })
  .strict();

const IMPORT_METRIC_SCHEMA = z
  .object({
    key: z.string().refine((value) => value.trim().length > 0),
    value: z.string(),
    updatedAt: IMPORT_ISO_TIMESTAMP_SCHEMA,
  })
  .strict();

const IMPORT_COOLDOWN_SCHEMA = z
  .object({
    userId: IMPORT_SNOWFLAKE_SCHEMA,
    lastAnswerAt: IMPORT_ISO_TIMESTAMP_SCHEMA,
  })
  .strict();

const GUILD_DATA_IMPORT_SCHEMA = z
  .object({
    formatVersion: z.literal(1),
    guildId: IMPORT_SNOWFLAKE_SCHEMA,
    exportedAt: IMPORT_ISO_TIMESTAMP_SCHEMA,
    metadata: IMPORT_GUILD_RECORD_SCHEMA,
    settings: GuildSettingsSchema,
    state: IMPORT_STATE_SCHEMA,
    questions: IMPORT_QUESTIONS_SCHEMA,
    kv: z.array(IMPORT_KV_SCHEMA),
    posts: z.array(IMPORT_POST_SCHEMA),
    answers: z.array(IMPORT_ANSWER_SCHEMA),
    metrics: z.array(IMPORT_METRIC_SCHEMA),
    cooldowns: z.array(IMPORT_COOLDOWN_SCHEMA),
  })
  .strict();

export class CourtStorage {
  private readonly db: Database.Database;
  private initialized = false;

  public constructor(
    config: Pick<ProcessConfig, "dbFile">,
    private readonly repoRoot: string,
  ) {
    // Deliberately do not set WAL or any other mutating pragma until the
    // existing schema has been classified. A legacy startup must stay read-only.
    this.db = new Database(config.dbFile);
  }

  public initStorage(): void {
    const schema = detectDatabaseSchema(this.db);
    if (schema === "legacy-v1") {
      throw new Error(
        "Database uses the legacy v1 schema. Create a validated backup, set LEGACY_GUILD_ID, and run `cd tsbot && npm run migrate` before starting v2.",
      );
    }
    if (schema === "unknown") {
      throw new Error(
        "Database schema is unknown or incomplete; startup refused without making schema changes.",
      );
    }

    this.db.pragma("foreign_keys = ON");
    if (schema === "empty") {
      initializeV2Schema(this.db, utcNow());
    } else {
      const issues = validateV2Schema(this.db);
      if (issues.length > 0) {
        throw new Error(
          `Database schema validation failed: ${issues.join("; ")}`,
        );
      }
    }

    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.initialized = true;
  }

  public close(): void {
    if (this.db.open) {
      this.db.close();
    }
    this.initialized = false;
  }

  public forGuild(guildId: string): GuildStorage {
    this.assertInitialized();
    const normalized = assertDiscordSnowflake(guildId);
    if (!this.getGuild(normalized)) {
      throw new Error(`Guild ${normalized} is not configured`);
    }
    return new GuildStorage(this.db, this, this.repoRoot, normalized);
  }

  public ensureGuild(
    guildId: string,
    name: string | null = null,
    observedJoinedAt: string | null = null,
  ): GuildRecord {
    this.assertInitialized();
    const normalized = assertDiscordSnowflake(guildId);
    const now = utcNow();
    const normalizedName = normalizeGuildName(name);
    const joinedAt = normalizeObservedTimestamp(observedJoinedAt) ?? now;

    const ensure = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO guilds (
             guild_id, enabled, name, joined_at, left_at, created_at, updated_at
           ) VALUES (?, 0, ?, ?, NULL, ?, ?)
           ON CONFLICT(guild_id) DO UPDATE SET
             name = CASE
               WHEN excluded.name IS NULL THEN guilds.name
               ELSE excluded.name
             END,
             joined_at = CASE
               WHEN guilds.joined_at IS NULL THEN excluded.joined_at
               ELSE guilds.joined_at
             END,
             updated_at = excluded.updated_at`,
        )
        .run(normalized, normalizedName, joinedAt, now, now);

      const existingSettings = this.getGuildSettings(normalized);
      if (!existingSettings) {
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
    this.assertInitialized();
    const normalized = assertDiscordSnowflake(guildId);
    const now = utcNow();
    const normalizedName = normalizeGuildName(name);
    const observedJoin = normalizeObservedTimestamp(observedJoinedAt);

    const reactivate = this.db.transaction(() => {
      const existingGuild = this.getGuild(normalized);
      const joinedAt = nextReactivationJoinedAt(
        existingGuild?.joinedAt ?? null,
        observedJoin,
        now,
      );
      const priorSettings = this.getGuildSettings(normalized);
      this.db
        .prepare(
          `INSERT INTO guilds (
             guild_id, enabled, name, joined_at, left_at, created_at, updated_at
           ) VALUES (?, 0, ?, ?, NULL, ?, ?)
           ON CONFLICT(guild_id) DO UPDATE SET
             enabled = 0,
             name = CASE
               WHEN excluded.name IS NULL THEN guilds.name
               ELSE excluded.name
             END,
             joined_at = excluded.joined_at,
             left_at = NULL,
             updated_at = excluded.updated_at`,
        )
        .run(normalized, normalizedName, joinedAt, now, now);

      const settings = priorSettings ?? createDefaultGuildSettings();
      settings.enabled = false;
      this.upsertSettings(normalized, settings, now);
    });
    reactivate.immediate();
    return this.requireGuild(normalized);
  }

  public markGuildLeft(guildId: string): GuildRecord | null {
    this.assertInitialized();
    const normalized = assertDiscordSnowflake(guildId);
    if (!this.getGuild(normalized)) {
      return null;
    }
    const priorSettings = this.getGuildSettings(normalized);
    const now = utcNow();
    const leave = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE guilds
           SET enabled = 0,
               left_at = ?,
               updated_at = ?
           WHERE guild_id = ?`,
        )
        .run(now, now, normalized);
      const settings = priorSettings;
      if (settings) {
        settings.enabled = false;
        this.upsertSettings(normalized, settings, now);
      }
    });
    leave.immediate();
    return this.requireGuild(normalized);
  }

  public getGuild(guildId: string): GuildRecord | null {
    this.assertInitialized();
    const normalized = assertDiscordSnowflake(guildId);
    const row = this.db
      .prepare("SELECT * FROM guilds WHERE guild_id = ?")
      .get(normalized) as GuildRow | undefined;
    return row ? parseGuildRow(row) : null;
  }

  public listEnabledGuilds(): GuildRecord[] {
    this.assertInitialized();
    const rows = this.db
      .prepare(
        `SELECT * FROM guilds
         WHERE enabled = 1 AND left_at IS NULL
         ORDER BY guild_id`,
      )
      .all() as GuildRow[];
    return rows.map(parseGuildRow);
  }

  public listActiveGuilds(): GuildRecord[] {
    this.assertInitialized();
    const rows = this.db
      .prepare(
        `SELECT * FROM guilds
         WHERE left_at IS NULL
         ORDER BY guild_id`,
      )
      .all() as GuildRow[];
    return rows.map(parseGuildRow);
  }

  public getGuildSettings(guildId: string): GuildSettings | null {
    this.assertInitialized();
    const normalized = assertDiscordSnowflake(guildId);
    const row = this.db
      .prepare(
        `SELECT settings_version, settings_json
         FROM guild_settings WHERE guild_id = ?`,
      )
      .get(normalized) as GuildSettingsRow | undefined;
    if (!row) {
      return null;
    }
    const settings = parseGuildSettingsJson(row.settings_json);
    if (row.settings_version !== settings.version) {
      throw new Error(`Guild ${normalized} settings version is inconsistent`);
    }
    const guild = this.db
      .prepare("SELECT enabled FROM guilds WHERE guild_id = ?")
      .get(normalized) as { enabled: number } | undefined;
    if (!guild || Boolean(guild.enabled) !== settings.enabled) {
      throw new Error(`Guild ${normalized} enabled state is inconsistent`);
    }
    return settings;
  }

  public getGuildEnableExpectation(
    guildId: string,
  ): GuildEnableExpectation | null {
    this.assertInitialized();
    const normalized = assertDiscordSnowflake(guildId);
    const read = this.db.transaction(() => {
      const settings = this.getGuildSettings(normalized);
      const guild = this.getGuild(normalized);
      if (!settings || !guild) {
        return null;
      }
      return {
        settings,
        lifecycleJoinedAt: guild.joinedAt,
      };
    });
    return read();
  }

  public saveGuildSettings(
    guildId: string,
    input: GuildSettings,
    expectedSettings?: GuildSettings,
  ): GuildSettings {
    this.assertInitialized();
    const normalized = assertDiscordSnowflake(guildId);
    const now = utcNow();
    let saved: GuildSettings | null = null;
    const save = this.db.transaction(() => {
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

      const settings = sanitizeGuildSettings(input);
      // Enabling and disabling are separate operations. A configuration write
      // must never resurrect a guild from a stale snapshot or disable a guild
      // merely because its caller started before another enable operation.
      settings.enabled = current.enabled;
      this.db
        .prepare("UPDATE guilds SET updated_at = ? WHERE guild_id = ?")
        .run(now, normalized);
      this.upsertSettings(normalized, settings, now);
      saved = settings;
    });
    save.immediate();
    return sanitizeGuildSettings(saved);
  }

  public setGuildEnabled(
    guildId: string,
    enabled: boolean,
    expectation?: GuildEnableExpectation,
  ): GuildSettings {
    this.assertInitialized();
    const normalized = assertDiscordSnowflake(guildId);
    const now = utcNow();
    let saved: GuildSettings | null = null;
    const update = this.db.transaction(() => {
      const current = this.getGuildSettings(normalized);
      const guild = this.getGuild(normalized);
      if (!current || !guild) {
        throw new Error(`Guild ${normalized} is not configured`);
      }
      if (enabled) {
        if (!expectation) {
          throw new TypeError(
            "Enabling a guild requires a reviewed settings and lifecycle snapshot",
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
      this.db
        .prepare(
          "UPDATE guilds SET enabled = ?, updated_at = ? WHERE guild_id = ?",
        )
        .run(current.enabled ? 1 : 0, now, normalized);
      this.upsertSettings(normalized, current, now);
      saved = current;
    });
    update.immediate();
    return sanitizeGuildSettings(saved);
  }

  public purgeGuild(guildId: string): GuildPurgeResult {
    this.assertInitialized();
    const normalized = assertDiscordSnowflake(guildId);
    const result = this.previewGuildPurge(normalized);

    const purge = this.db.transaction(() => {
      this.db.prepare("DELETE FROM guilds WHERE guild_id = ?").run(normalized);
      for (const table of TENANT_TABLES) {
        if (this.countForGuild(table, normalized) !== 0) {
          throw new Error(`Guild purge left rows in ${table}`);
        }
      }
    });
    purge.immediate();
    return result;
  }

  public previewGuildPurge(guildId: string): GuildPurgeResult {
    this.assertInitialized();
    const normalized = assertDiscordSnowflake(guildId);
    return {
      guildId: normalized,
      guilds: this.countForGuild("guilds", normalized),
      settings: this.countForGuild("guild_settings", normalized),
      kv: this.countForGuild("kv", normalized),
      posts: this.countForGuild("posts", normalized),
      answers: this.countForGuild("answers", normalized),
      metrics: this.countForGuild("metrics", normalized),
      cooldowns: this.countForGuild("anon_cooldowns", normalized),
    };
  }

  public exportGuild(guildId: string): GuildDataExport {
    return this.forGuild(guildId).exportData();
  }

  public importGuild(guildId: string, payload: unknown): void {
    this.forGuild(guildId).importData(payload);
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error("CourtStorage.initStorage() must be called first");
    }
  }

  private requireGuild(guildId: string): GuildRecord {
    const guild = this.getGuild(guildId);
    if (!guild) {
      throw new Error(`Guild ${guildId} is not configured`);
    }
    return guild;
  }

  private insertSettings(
    guildId: string,
    settings: GuildSettings,
    updatedAt: string,
  ): void {
    const validated = sanitizeGuildSettings(settings);
    this.db
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
    this.db
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

  private countForGuild(table: string, guildId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)} WHERE guild_id = ?`,
      )
      .get(guildId) as CountRow;
    return Number(row.count);
  }
}

export class GuildStorage {
  public constructor(
    private readonly db: Database.Database,
    private readonly root: CourtStorage,
    private readonly repoRoot: string,
    public readonly guildId: string,
  ) {}

  public getSettings(): GuildSettings {
    const settings = this.root.getGuildSettings(this.guildId);
    if (!settings) {
      throw new Error(`Guild ${this.guildId} has no settings`);
    }
    return settings;
  }

  public saveSettings(settings: GuildSettings): GuildSettings {
    return this.root.saveGuildSettings(this.guildId, settings);
  }

  public initializeCourtQuestions(): boolean {
    if (this.dbHasKey("questions")) {
      return false;
    }
    const filePath = path.join(this.repoRoot, QUESTIONS_FILE);
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new TypeError("The bootstrap question template must be an object");
    }
    this.setQuestions(parsed as Record<string, string[]>);
    return true;
  }

  public getState(): CourtState {
    const defaults = this.defaultStatePayload();
    const rawState = this.dbGetJson("state", defaults);
    if (
      typeof rawState !== "object" ||
      rawState === null ||
      Array.isArray(rawState)
    ) {
      throw new TypeError(`Guild ${this.guildId} state must be a JSON object`);
    }
    const state = rawState as Partial<CourtState>;
    const merged: CourtState = {
      last_posted_date: optionalString(state.last_posted_date),
      last_dry_run_date: optionalString(state.last_dry_run_date),
      last_weekly_digest_week: optionalString(state.last_weekly_digest_week),
      history: stringArray(state.history).slice(-HISTORY_LIMIT),
      used_questions: dedupeStrings(stringArray(state.used_questions)),
      royal_presence: ensureRoyalPresenceShape(state.royal_presence),
      royal_afk: ensureRoyalAfkShape(state.royal_afk),
      posts: this.listPostRecords(true, POST_RECORD_LIMIT),
      metrics: this.metricsSnapshot(),
    };
    return merged;
  }

  public saveState(
    state: CourtState,
    options: { persistMetrics?: boolean } = {},
  ): void {
    const rawState = this.dbGetJson("state", {});
    if (
      typeof rawState !== "object" ||
      rawState === null ||
      Array.isArray(rawState)
    ) {
      throw new TypeError(`Guild ${this.guildId} state must be a JSON object`);
    }
    const preservedState = {
      ...(rawState as Record<string, unknown>),
    };
    for (const key of OBSOLETE_OR_DERIVED_STATE_KEYS) {
      delete preservedState[key];
    }

    const persistMetrics = options.persistMetrics ?? true;
    const next: CourtState = {
      last_posted_date: optionalString(state.last_posted_date),
      last_dry_run_date: optionalString(state.last_dry_run_date),
      last_weekly_digest_week: optionalString(state.last_weekly_digest_week),
      history: stringArray(state.history).slice(-HISTORY_LIMIT),
      used_questions: dedupeStrings(stringArray(state.used_questions)),
      royal_presence: ensureRoyalPresenceShape(state.royal_presence),
      royal_afk: ensureRoyalAfkShape(state.royal_afk),
      posts: Array.isArray(state.posts)
        ? state.posts.slice(-POST_RECORD_LIMIT)
        : [],
      metrics: ensureMetricsShape(state.metrics),
    };

    for (const post of next.posts) {
      this.upsertPostRow(post);
    }
    if (persistMetrics) {
      for (const [key, value] of Object.entries(
        flattenMetricsForStorage(next.metrics),
      )) {
        this.metricsSet(key, value);
      }
    }

    this.dbSetJson("state", {
      ...preservedState,
      last_posted_date: next.last_posted_date,
      last_dry_run_date: next.last_dry_run_date,
      last_weekly_digest_week: next.last_weekly_digest_week,
      history: next.history,
      used_questions: next.used_questions,
      royal_presence: next.royal_presence,
      royal_afk: next.royal_afk,
    });
  }

  public updateStateAtomic(mutator: (state: CourtState) => void): CourtState {
    const update = this.db.transaction(() => {
      const state = this.getState();
      mutator(state);
      this.saveState(state);
      return this.getState();
    });
    return update.immediate();
  }

  public getQuestions(): Record<string, string[]> {
    const fallback = defaultQuestions();
    // Reading an uninitialized guild must not consume its one-time template
    // initialization. The court feature copies the tracked pool explicitly.
    if (!this.dbHasKey("questions")) {
      return fallback;
    }
    const data = this.dbGetJson("questions", fallback);
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new TypeError(
        `Guild ${this.guildId} questions must be a JSON object`,
      );
    }
    const parsed: Record<string, string[]> = {};
    for (const [category, items] of Object.entries(data)) {
      if (
        !Array.isArray(items) ||
        items.some((item) => typeof item !== "string")
      ) {
        throw new TypeError(
          `Guild ${this.guildId} question category ${category} must be an array of strings`,
        );
      }
      parsed[category] = [...items];
    }
    return { ...fallback, ...parsed };
  }

  public setQuestions(questions: Record<string, string[]>): void {
    const sanitized: Record<string, string[]> = {};
    for (const [categoryRaw, items] of Object.entries(questions)) {
      const category = categoryRaw.trim();
      if (!category || !Array.isArray(items)) {
        continue;
      }
      sanitized[category] = dedupeStrings(
        items
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean),
      );
    }
    this.dbSetJson("questions", sanitized);
  }

  public metricsSnapshot(): MetricsShape {
    return ensureMetricsShape({
      command_usage: this.metricsGetPrefixed("command_usage."),
      command_failures: this.metricsGetPrefixed("command_failures."),
      posts_by_category: this.metricsGetPrefixed("posts_by_category."),
      posts_total: this.metricsGet("posts_total", "0"),
      posts_auto: this.metricsGet("posts_auto", "0"),
      posts_manual: this.metricsGet("posts_manual", "0"),
      custom_posts: this.metricsGet("custom_posts", "0"),
      answers_total: this.metricsGet("answers_total", "0"),
      last_successful_auto_post:
        this.metricsGet("last_successful_auto_post", "") || null,
    });
  }

  public metricsSet(key: string, value: string | number): void {
    const metricKey = key.trim();
    if (!metricKey) {
      throw new TypeError("Metric key must not be empty");
    }
    this.db
      .prepare(
        `INSERT INTO metrics (
           guild_id, metric_key, metric_value, updated_at
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT(guild_id, metric_key) DO UPDATE SET
           metric_value = excluded.metric_value,
           updated_at = excluded.updated_at`,
      )
      .run(this.guildId, metricKey, String(value), this.nowIso());
  }

  public metricsGet(key: string, defaultValue: string): string {
    const exactValue = this.getStoredMetricValue(key);
    if (exactValue !== undefined) {
      return exactValue;
    }
    const legacyKey = legacyRoundedUserMetricKey(key);
    return legacyKey === null
      ? defaultValue
      : (this.getStoredMetricValue(legacyKey) ?? defaultValue);
  }

  public metricsIncrement(key: string, amount = 1): number {
    const update = this.db.transaction(() => {
      this.seedExactUserMetricFromLegacy(key);
      const current = coerceInt(this.metricsGet(key, "0"), 0) + amount;
      this.metricsSet(key, current);
      return current;
    });
    return update.immediate();
  }

  public buildUserMetricKey(
    userId: number | string,
    metricName: string,
  ): string {
    const normalizedUser = String(userId).trim();
    const normalizedMetric = metricName.trim();
    if (!isPositiveNumericId(normalizedUser) || !normalizedMetric) {
      throw new TypeError(
        "User metric requires a positive numeric user ID and metric name",
      );
    }
    return `${USER_METRIC_PREFIX}${normalizedUser}.${normalizedMetric}`;
  }

  public getUserFunMetrics(userId: number | string): Record<string, number> {
    const keys = [
      "messages_sent",
      "reactions_sent",
      "reactions_received",
      "anonymous_answers_sent",
      "battles_played",
      "battles_won",
    ];
    const result: Record<string, number> = {};
    for (const key of keys) {
      result[key] = coerceInt(
        this.metricsGet(this.buildUserMetricKey(userId, key), "0"),
        0,
      );
    }
    return result;
  }

  public listTopUsersForMetric(
    metricName: string,
    limit = 5,
  ): Array<[string, number]> {
    const suffix = metricName.trim();
    if (!suffix) {
      return [];
    }
    const safeLimit = coerceInt(limit, 5, 1, 25);
    const rows = this.db
      .prepare(
        `SELECT metric_key, metric_value, updated_at FROM metrics
         WHERE guild_id = ? AND metric_key LIKE ?`,
      )
      .all(this.guildId, `${USER_METRIC_PREFIX}%.${suffix}`) as MetricRow[];
    const pattern = new RegExp(
      String.raw`^${escapeRegex(USER_METRIC_PREFIX)}(\d+)\.${escapeRegex(suffix)}$`,
    );
    const parsed: Array<[string, number]> = [];
    const userIds = new Set<string>();
    for (const row of rows) {
      const match = pattern.exec(row.metric_key);
      const value = coerceInt(row.metric_value, 0, 0);
      if (match?.[1]) {
        userIds.add(match[1]);
      }
      if (match?.[1] && value > 0) {
        parsed.push([match[1], value]);
      }
    }
    const shadowedLegacyIds = new Set<string>();
    for (const userId of userIds) {
      const legacyUserId = legacyRoundedUserId(userId);
      if (legacyUserId !== null && userIds.has(legacyUserId)) {
        shadowedLegacyIds.add(legacyUserId);
      }
    }
    parsed.sort((left, right) =>
      right[1] !== left[1]
        ? right[1] - left[1]
        : left[0].localeCompare(right[0]),
    );
    return parsed
      .filter(([userId]) => !shadowedLegacyIds.has(userId))
      .slice(0, safeLimit);
  }

  public mergeUserMetricBackfill(
    scannedCounts: Record<string, number>,
    metricName: string,
  ): [number, number] {
    let usersSeen = 0;
    let updated = 0;
    for (const [userId, scannedRaw] of Object.entries(scannedCounts)) {
      const scanned = coerceInt(scannedRaw, 0);
      if (!isPositiveNumericId(userId) || scanned <= 0) {
        continue;
      }
      usersSeen += 1;
      const key = this.buildUserMetricKey(userId, metricName);
      this.seedExactUserMetricFromLegacy(key);
      const existing = coerceInt(this.metricsGet(key, "0"), 0);
      if (scanned > existing) {
        this.metricsSet(key, scanned);
        updated += 1;
      }
    }
    return [usersSeen, updated];
  }

  public listPostRecords(
    includeClosed = true,
    limit: number | null = null,
  ): PostRecord[] {
    let sql = "SELECT * FROM posts WHERE guild_id = ?";
    const params: unknown[] = [this.guildId];
    if (!includeClosed) {
      sql += " AND closed = 0";
    }
    let reverse = false;
    if (limit === null) {
      sql += " ORDER BY julianday(posted_at) ASC, message_id ASC";
    } else {
      sql += " ORDER BY julianday(posted_at) DESC, message_id DESC LIMIT ?";
      params.push(coerceInt(limit, POST_RECORD_LIMIT, 1));
      reverse = true;
    }
    const result = (this.db.prepare(sql).all(...params) as PostRow[]).map(
      parsePostRow,
    );
    return reverse ? result.reverse() : result;
  }

  public getPostRecord(messageId: number | string): PostRecord | null {
    const row = this.db
      .prepare("SELECT * FROM posts WHERE guild_id = ? AND message_id = ?")
      .get(this.guildId, String(messageId)) as PostRow | undefined;
    return row ? parsePostRow(row) : null;
  }

  public getLatestOpenPost(): PostRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM posts
         WHERE guild_id = ? AND closed = 0
         ORDER BY julianday(posted_at) DESC, message_id DESC LIMIT 1`,
      )
      .get(this.guildId) as PostRow | undefined;
    return row ? parsePostRow(row) : null;
  }

  public updatePostThreadId(
    messageId: number | string,
    threadId: number | string,
  ): void {
    const record = this.getPostRecord(messageId);
    if (record) {
      record.thread_id = String(threadId);
      this.upsertPostRow(record);
    }
  }

  public markPostClosed(messageId: number | string, reason: string): void {
    const record = this.getPostRecord(messageId);
    if (record) {
      record.closed = true;
      record.closed_at = this.nowIso();
      record.close_reason = reason;
      this.upsertPostRow(record);
    }
  }

  public markPostOpen(
    messageId: number | string,
    closeAfterHours: number | null = null,
  ): PostRecord | null {
    const record = this.getPostRecord(messageId);
    if (!record) {
      return null;
    }
    record.closed = false;
    record.closed_at = null;
    record.close_reason = null;
    if (closeAfterHours !== null) {
      record.close_after_hours = coerceInt(
        closeAfterHours,
        THREAD_CLOSE_HOURS,
        1,
      );
    }
    this.upsertPostRow(record);
    return record;
  }

  public setPostCloseAfterHours(
    messageId: number | string,
    closeAfterHours: number,
  ): PostRecord | null {
    const record = this.getPostRecord(messageId);
    if (!record) {
      return null;
    }
    record.close_after_hours = coerceInt(
      closeAfterHours,
      THREAD_CLOSE_HOURS,
      1,
    );
    this.upsertPostRow(record);
    return record;
  }

  public countAnswersForQuestion(questionMessageId: number | string): number {
    return this.readCount(
      "SELECT COUNT(*) AS count FROM answers WHERE guild_id = ? AND question_message_id = ?",
      this.guildId,
      String(questionMessageId),
    );
  }

  public countAllAnswerRecords(): number {
    return this.readCount(
      "SELECT COUNT(*) AS count FROM answers WHERE guild_id = ?",
      this.guildId,
    );
  }

  public hasUserAnswered(
    questionMessageId: number | string,
    userId: number | string,
  ): boolean {
    return (
      this.readCount(
        `SELECT COUNT(*) AS count FROM answers
         WHERE guild_id = ? AND question_message_id = ? AND user_id = ?`,
        this.guildId,
        String(questionMessageId),
        String(userId),
      ) > 0
    );
  }

  public nextAnswerNumber(questionMessageId: number | string): number {
    return this.countAnswersForQuestion(questionMessageId) + 1;
  }

  public markUserAnswered(
    questionMessageId: number | string,
    userId: number | string,
    answerMessageId: number | string,
  ): void {
    const now = this.nowIso();
    const mark = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO answers (
             guild_id, question_message_id, user_id, answer_message_id, created_at
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(guild_id, question_message_id, user_id) DO UPDATE SET
             answer_message_id = excluded.answer_message_id,
             created_at = excluded.created_at`,
        )
        .run(
          this.guildId,
          String(questionMessageId),
          String(userId),
          String(answerMessageId),
          now,
        );
      this.db
        .prepare(
          `INSERT INTO anon_cooldowns (guild_id, user_id, last_answer_at)
           VALUES (?, ?, ?)
           ON CONFLICT(guild_id, user_id) DO UPDATE SET
             last_answer_at = excluded.last_answer_at`,
        )
        .run(this.guildId, String(userId), now);
      this.metricsIncrement(
        this.buildUserMetricKey(userId, "anonymous_answers_sent"),
      );
      // The answer row, cooldown, per-user metric, and aggregate metric are
      // one logical write. Keeping them in this transaction prevents a sent
      // answer from being only partially represented after a storage error.
      this.metricsIncrement("answers_total");
    });
    mark.immediate();
  }

  public getLastAnswerTimeForUser(userId: number | string): string | null {
    const row = this.db
      .prepare(
        `SELECT user_id, last_answer_at FROM anon_cooldowns
         WHERE guild_id = ? AND user_id = ?`,
      )
      .get(this.guildId, String(userId)) as CooldownRow | undefined;
    return row ? String(row.last_answer_at) : null;
  }

  public purgeExpiredAnswers(retentionDays: number): number {
    const days = Math.max(1, coerceInt(retentionDays, 90, 1));
    const cutoff = DateTime.fromISO(this.nowIso()).minus({ days }).toISO();
    if (!cutoff) {
      return 0;
    }
    const result = this.db
      .prepare(
        `DELETE FROM answers
         WHERE guild_id = ?
           AND julianday(created_at) < julianday(?)`,
      )
      .run(this.guildId, cutoff);
    return Number(result.changes);
  }

  public findAnswerRecord(answerMessageId: string): AnswerRecordRow | null {
    const row = this.db
      .prepare(
        `SELECT question_message_id, user_id FROM answers
         WHERE guild_id = ? AND answer_message_id = ?`,
      )
      .get(this.guildId, String(answerMessageId)) as
      AnswerRecordRow | undefined;
    return row
      ? {
          question_message_id: String(row.question_message_id),
          user_id: String(row.user_id),
        }
      : null;
  }

  public removeAnswerRecord(answerMessageId: string): AnswerRecordRow | null {
    const match = this.findAnswerRecord(answerMessageId);
    if (!match) {
      return null;
    }
    this.db
      .prepare(
        "DELETE FROM answers WHERE guild_id = ? AND answer_message_id = ?",
      )
      .run(this.guildId, String(answerMessageId));
    return match;
  }

  public recordCommandMetric(commandName: string, success = true): void {
    this.metricsIncrement(`command_usage.${commandName}`);
    if (!success) {
      this.metricsIncrement(`command_failures.${commandName}`);
    }
  }

  public recordPostMetric(
    category: string,
    source: "auto" | "manual" | "custom",
  ): void {
    this.metricsIncrement(`posts_by_category.${category}`);
    this.metricsIncrement("posts_total");
    if (source === "auto") {
      this.metricsIncrement("posts_auto");
      this.metricsSet("last_successful_auto_post", this.nowIso());
    } else if (source === "manual") {
      this.metricsIncrement("posts_manual");
    } else {
      this.metricsIncrement("custom_posts");
    }
  }

  public registerUsedQuestion(question: string): void {
    this.updateStateAtomic((state) => {
      state.history.push(question);
      if (!state.used_questions.includes(question)) {
        state.used_questions.push(question);
      }
    });
  }

  public pickQuestion(
    category: string | null,
    randomize: boolean,
    randomInt: (maxExclusive: number) => number,
  ): [string, string] {
    const questions = this.getQuestions();
    const state = this.getState();
    const recent = new Set(state.history.slice(-HISTORY_LIMIT));
    const used = new Set(state.used_questions);
    const pool: Array<[string, string]> = [];
    if (category) {
      for (const question of questions[category] ?? []) {
        pool.push([category, question]);
      }
    } else {
      for (const [categoryName, items] of Object.entries(questions)) {
        for (const question of items) {
          pool.push([categoryName, question]);
        }
      }
    }
    if (pool.length === 0) {
      throw new Error("No questions are configured for this guild");
    }
    let unused = pool.filter((entry) => !used.has(entry[1]));
    if (unused.length === 0) {
      state.used_questions = [];
      this.saveState(state);
      unused = [...pool];
    }
    const withoutRecent = unused.filter((entry) => !recent.has(entry[1]));
    const finalPool = withoutRecent.length > 0 ? withoutRecent : unused;
    const selectedIndex = randomize ? randomInt(finalPool.length) : 0;
    const selected = finalPool[selectedIndex] ?? finalPool[0];
    if (!selected) {
      throw new Error("No questions are configured for this guild");
    }
    return selected;
  }

  public upsertPostRow(record: Partial<PostRecord>): void {
    const messageId = numericId(record.message_id);
    const channelId = numericId(record.channel_id);
    if (!messageId || !channelId) {
      return;
    }
    const threadId = numericId(record.thread_id);
    const values = {
      guild_id: this.guildId,
      message_id: messageId,
      thread_id: threadId,
      channel_id: channelId,
      category: String(record.category ?? "unknown").trim() || "unknown",
      question:
        String(record.question ?? "Unknown question").trim() ||
        "Unknown question",
      posted_at:
        String(record.posted_at ?? this.nowIso()).trim() || this.nowIso(),
      close_after_hours: coerceInt(
        record.close_after_hours,
        THREAD_CLOSE_HOURS,
        1,
      ),
      closed: record.closed ? 1 : 0,
      closed_at: optionalString(record.closed_at),
      close_reason: optionalString(record.close_reason),
    };
    this.db
      .prepare(
        `INSERT INTO posts (
           guild_id, message_id, thread_id, channel_id, category, question,
           posted_at, close_after_hours, closed, closed_at, close_reason
         ) VALUES (
           @guild_id, @message_id, @thread_id, @channel_id, @category, @question,
           @posted_at, @close_after_hours, @closed, @closed_at, @close_reason
         )
         ON CONFLICT(guild_id, message_id) DO UPDATE SET
           thread_id = excluded.thread_id,
           channel_id = excluded.channel_id,
           category = excluded.category,
           question = excluded.question,
           posted_at = excluded.posted_at,
           close_after_hours = excluded.close_after_hours,
           closed = excluded.closed,
           closed_at = excluded.closed_at,
           close_reason = excluded.close_reason`,
      )
      .run(values);
  }

  public exportData(): GuildDataExport {
    const metadata = this.root.getGuild(this.guildId);
    if (!metadata) {
      throw new Error(`Guild ${this.guildId} is not configured`);
    }
    const state = this.getState();
    const questions = this.getQuestions();
    const kv = this.db
      .prepare(
        `SELECT key, value, updated_at FROM kv
         WHERE guild_id = ? ORDER BY key`,
      )
      .all(this.guildId) as Array<{
      key: string;
      value: string;
      updated_at: string;
    }>;
    const answers = this.db
      .prepare(
        `SELECT question_message_id, user_id, answer_message_id, created_at
         FROM answers WHERE guild_id = ?
         ORDER BY question_message_id, user_id`,
      )
      .all(this.guildId) as AnswerRow[];
    const metrics = this.db
      .prepare(
        `SELECT metric_key, metric_value, updated_at FROM metrics
         WHERE guild_id = ? AND metric_key <> ? ORDER BY metric_key`,
      )
      .all(this.guildId, SILENCE_LEASES_METRIC_KEY) as MetricRow[];
    const cooldowns = this.db
      .prepare(
        `SELECT user_id, last_answer_at FROM anon_cooldowns
         WHERE guild_id = ? ORDER BY user_id`,
      )
      .all(this.guildId) as CooldownRow[];
    return {
      formatVersion: 1,
      guildId: this.guildId,
      exportedAt: utcNow(),
      metadata,
      settings: this.getSettings(),
      state,
      questions,
      kv: kv.map((row): GuildKvExport => ({
        key: String(row.key),
        value: String(row.value),
        updatedAt: String(row.updated_at),
      })),
      posts: this.listPostRecords(),
      answers: answers.map((row): GuildAnswerExport => ({
        questionMessageId: String(row.question_message_id),
        userId: String(row.user_id),
        answerMessageId: String(row.answer_message_id),
        createdAt: String(row.created_at),
      })),
      metrics: metrics.map((row): GuildMetricExport => ({
        key: String(row.metric_key),
        value: String(row.metric_value),
        updatedAt: String(row.updated_at),
      })),
      cooldowns: cooldowns.map((row): GuildCooldownExport => ({
        userId: String(row.user_id),
        lastAnswerAt: String(row.last_answer_at),
      })),
    };
  }

  public importData(payload: unknown): void {
    if (
      typeof payload !== "object" ||
      payload === null ||
      (payload as Partial<GuildDataExport>).formatVersion !== 1 ||
      (payload as Partial<GuildDataExport>).guildId !== this.guildId
    ) {
      throw new Error("Guild import payload does not belong to this guild");
    }
    const rawCandidate = payload as Partial<GuildDataExport>;
    if (
      !rawCandidate.settings ||
      !rawCandidate.state ||
      !rawCandidate.questions ||
      !rawCandidate.metadata ||
      !Array.isArray(rawCandidate.kv) ||
      !Array.isArray(rawCandidate.posts) ||
      !Array.isArray(rawCandidate.answers) ||
      !Array.isArray(rawCandidate.metrics) ||
      !Array.isArray(rawCandidate.cooldowns)
    ) {
      throw new TypeError("Guild import payload is incomplete");
    }

    // Check untrusted identifier values before parsing the rest of the payload
    // so a JSON number can never be coerced into a rounded snowflake string.
    for (const post of rawCandidate.posts) {
      if (!post || typeof post !== "object") {
        throw new TypeError("Imported post must be an object");
      }
      assertNumericRowId(post.message_id, "post message ID");
      assertNumericRowId(post.channel_id, "post channel ID");
      if (post.thread_id !== null) {
        assertNumericRowId(post.thread_id, "post thread ID");
      }
    }
    for (const answer of rawCandidate.answers) {
      if (!answer || typeof answer !== "object") {
        throw new TypeError("Imported answer must be an object");
      }
      assertNumericRowId(answer.questionMessageId, "question message ID");
      assertNumericRowId(answer.userId, "answer user ID");
      assertNumericRowId(answer.answerMessageId, "answer message ID");
    }
    for (const cooldown of rawCandidate.cooldowns) {
      if (!cooldown || typeof cooldown !== "object") {
        throw new TypeError("Imported cooldown must be an object");
      }
      assertNumericRowId(cooldown.userId, "cooldown user ID");
    }
    for (const metric of rawCandidate.metrics) {
      if (
        metric &&
        typeof metric === "object" &&
        metric.key === SILENCE_LEASES_METRIC_KEY
      ) {
        throw new TypeError(
          "Imported metrics must not contain reserved silence-lock runtime metadata",
        );
      }
    }

    const candidate = GUILD_DATA_IMPORT_SCHEMA.parse(payload);
    if (!isDeepStrictEqual(candidate.settings, rawCandidate.settings)) {
      throw new TypeError(
        "Guild import settings must already be normalized without coercion",
      );
    }
    if (candidate.metadata.guildId !== this.guildId) {
      throw new Error("Guild import metadata does not belong to this guild");
    }
    if (candidate.metadata.enabled !== candidate.settings.enabled) {
      throw new TypeError("Guild import enabled metadata is inconsistent");
    }
    validateUniqueImportRows(candidate);
    validateSpecialKvSnapshots(candidate);

    const settings = candidate.settings;
    // An export can contain bindings which have since been deleted or moved.
    // Keep restores inert until an administrator validates the imported
    // configuration against the current Discord guild and enables it again.
    settings.enabled = false;

    const applyImport = this.db.transaction(() => {
      const liveSilenceLeaseMetric = this.db
        .prepare(
          `SELECT metric_key, metric_value, updated_at FROM metrics
           WHERE guild_id = ? AND metric_key = ?`,
        )
        .get(this.guildId, SILENCE_LEASES_METRIC_KEY) as MetricRow | undefined;
      // Disable inside the same transaction before replacing configuration.
      // Ordinary configuration writes intentionally preserve the current
      // enabled state, while imports must always restore into an inert guild.
      this.root.setGuildEnabled(this.guildId, false);
      for (const table of [
        "kv",
        "posts",
        "answers",
        "metrics",
        "anon_cooldowns",
      ]) {
        this.db
          .prepare(`DELETE FROM ${quoteIdentifier(table)} WHERE guild_id = ?`)
          .run(this.guildId);
      }
      this.root.saveGuildSettings(this.guildId, settings);
      const insertKv = this.db.prepare(
        `INSERT INTO kv (guild_id, key, value, updated_at)
         VALUES (?, ?, ?, ?)`,
      );
      for (const row of candidate.kv) {
        insertKv.run(this.guildId, row.key, row.value, row.updatedAt);
      }

      // kv.state and kv.questions are restored byte-for-byte above. The
      // top-level state/questions fields are validated semantic snapshots,
      // while kv remains authoritative for persistence and initialization.
      const insertPost = this.db.prepare(
        `INSERT INTO posts (
           guild_id, message_id, thread_id, channel_id, category, question,
           posted_at, close_after_hours, closed, closed_at, close_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const post of candidate.posts) {
        insertPost.run(
          this.guildId,
          post.message_id,
          post.thread_id,
          post.channel_id,
          post.category,
          post.question,
          post.posted_at,
          post.close_after_hours,
          post.closed ? 1 : 0,
          post.closed_at,
          post.close_reason,
        );
      }
      const insertAnswer = this.db.prepare(
        `INSERT INTO answers (
           guild_id, question_message_id, user_id, answer_message_id, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const answer of candidate.answers) {
        insertAnswer.run(
          this.guildId,
          answer.questionMessageId,
          answer.userId,
          answer.answerMessageId,
          answer.createdAt,
        );
      }
      const insertMetric = this.db.prepare(
        `INSERT INTO metrics (
           guild_id, metric_key, metric_value, updated_at
         ) VALUES (?, ?, ?, ?)`,
      );
      for (const metric of candidate.metrics) {
        insertMetric.run(
          this.guildId,
          metric.key,
          metric.value,
          metric.updatedAt,
        );
      }
      if (liveSilenceLeaseMetric) {
        insertMetric.run(
          this.guildId,
          liveSilenceLeaseMetric.metric_key,
          liveSilenceLeaseMetric.metric_value,
          liveSilenceLeaseMetric.updated_at,
        );
      }
      const insertCooldown = this.db.prepare(
        `INSERT INTO anon_cooldowns (guild_id, user_id, last_answer_at)
         VALUES (?, ?, ?)`,
      );
      for (const cooldown of candidate.cooldowns) {
        insertCooldown.run(
          this.guildId,
          cooldown.userId,
          cooldown.lastAnswerAt,
        );
      }
    });
    applyImport.immediate();
  }

  private metricsGetPrefixed(prefix: string): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT metric_key, metric_value, updated_at FROM metrics
         WHERE guild_id = ? AND substr(metric_key, 1, ?) = ?`,
      )
      .all(this.guildId, prefix.length, prefix) as MetricRow[];
    const result: Record<string, number> = {};
    for (const row of rows) {
      const suffix = row.metric_key.slice(prefix.length);
      if (suffix) {
        result[suffix] = coerceInt(row.metric_value, 0, 0);
      }
    }
    return result;
  }

  private getStoredMetricValue(key: string): string | undefined {
    const row = this.db
      .prepare(
        "SELECT metric_value FROM metrics WHERE guild_id = ? AND metric_key = ?",
      )
      .get(this.guildId, key) as { metric_value: string } | undefined;
    return row ? String(row.metric_value) : undefined;
  }

  private seedExactUserMetricFromLegacy(key: string): void {
    const legacyKey = legacyRoundedUserMetricKey(key);
    if (legacyKey === null) {
      return;
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO metrics (
           guild_id, metric_key, metric_value, updated_at
         )
         SELECT guild_id, ?, metric_value, updated_at
         FROM metrics
         WHERE guild_id = ? AND metric_key = ?`,
      )
      .run(key, this.guildId, legacyKey);
  }

  private dbHasKey(key: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS found FROM kv WHERE guild_id = ? AND key = ?")
      .get(this.guildId, key) as { found: number } | undefined;
    return Boolean(row);
  }

  private dbGetJson(key: string, defaultValue: unknown): unknown {
    const row = this.db
      .prepare("SELECT value FROM kv WHERE guild_id = ? AND key = ?")
      .get(this.guildId, key) as JsonRow | undefined;
    if (!row) {
      return defaultValue;
    }
    try {
      return JSON.parse(row.value);
    } catch (error) {
      throw new TypeError(
        `Guild ${this.guildId} ${key} contains invalid JSON`,
        { cause: error },
      );
    }
  }

  private dbSetJson(key: string, data: unknown): void {
    this.db
      .prepare(
        `INSERT INTO kv (guild_id, key, value, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(guild_id, key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run(this.guildId, key, JSON.stringify(data), this.nowIso());
  }

  private readCount(sql: string, ...params: unknown[]): number {
    const row = this.db.prepare(sql).get(...params) as CountRow;
    return Number(row.count);
  }

  private defaultStatePayload(): CourtState {
    return {
      last_posted_date: null,
      last_dry_run_date: null,
      last_weekly_digest_week: null,
      history: [],
      used_questions: [],
      royal_presence: ensureRoyalPresenceShape({}),
      royal_afk: ensureRoyalAfkShape({}),
      posts: [],
      metrics: ensureMetricsShape({}),
    };
  }

  private nowIso(): string {
    return isoNow(this.getSettings().timezone);
  }
}

function parseGuildRow(row: GuildRow): GuildRecord {
  return {
    guildId: String(row.guild_id),
    enabled: Boolean(row.enabled),
    name: row.name === null ? null : String(row.name),
    joinedAt: row.joined_at === null ? null : String(row.joined_at),
    leftAt: row.left_at === null ? null : String(row.left_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function parsePostRow(row: PostRow): PostRecord {
  return {
    message_id: String(row.message_id),
    thread_id: row.thread_id === null ? null : String(row.thread_id),
    channel_id: String(row.channel_id),
    category: String(row.category),
    question: String(row.question),
    posted_at: String(row.posted_at),
    close_after_hours: coerceInt(row.close_after_hours, THREAD_CLOSE_HOURS, 1),
    closed: Boolean(row.closed),
    closed_at: row.closed_at === null ? null : String(row.closed_at),
    close_reason: row.close_reason === null ? null : String(row.close_reason),
  };
}

function defaultQuestions(): Record<string, string[]> {
  return {
    general: [],
    gaming: [],
    music: [],
    "hot-take": [],
    chaos: [],
  };
}

function normalizeGuildName(name: string | null): string | null {
  if (name === null) {
    return null;
  }
  const normalized = String(name).trim();
  return normalized ? normalized.slice(0, 100) : null;
}

function normalizeObservedTimestamp(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const normalized = String(value).trim();
  const timestamp = Date.parse(normalized);
  if (!normalized || !Number.isFinite(timestamp)) {
    throw new TypeError("Observed guild join time must be a valid timestamp");
  }
  return new Date(timestamp).toISOString();
}

function nextReactivationJoinedAt(
  storedJoinedAt: string | null,
  observedJoinedAt: string | null,
  now: string,
): string {
  const storedTimestamp =
    storedJoinedAt === null ? NaN : Date.parse(storedJoinedAt);
  const observedTimestamp =
    observedJoinedAt === null ? NaN : Date.parse(observedJoinedAt);
  const nowTimestamp = Date.parse(now);
  const nextTimestamp = Math.max(
    nowTimestamp,
    Number.isFinite(observedTimestamp)
      ? observedTimestamp
      : Number.NEGATIVE_INFINITY,
    Number.isFinite(storedTimestamp)
      ? storedTimestamp + 1
      : Number.NEGATIVE_INFINITY,
  );
  return new Date(nextTimestamp).toISOString();
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function numericId(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return /^\d+$/.test(normalized) ? normalized : null;
}

function isPositiveNumericId(value: string): boolean {
  return /^\d+$/.test(value) && !/^0+$/.test(value);
}

function legacyRoundedUserId(userId: string): string | null {
  if (!DISCORD_SNOWFLAKE_PATTERN.test(userId)) {
    return null;
  }
  const parsed = Number.parseInt(userId, 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  const rounded = String(parsed);
  return rounded === userId ? null : rounded;
}

function legacyRoundedUserMetricKey(key: string): string | null {
  const pattern = new RegExp(
    String.raw`^${escapeRegex(USER_METRIC_PREFIX)}(\d+)\.(.+)$`,
  );
  const match = pattern.exec(key);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  const legacyUserId = legacyRoundedUserId(match[1]);
  return legacyUserId === null
    ? null
    : `${USER_METRIC_PREFIX}${legacyUserId}.${match[2]}`;
}

function assertNumericRowId(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !DISCORD_SNOWFLAKE_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a Discord snowflake string`);
  }
}

function validateUniqueImportRows(candidate: GuildDataExport): void {
  assertUniqueImportKeys(
    candidate.kv.map((row) => row.key),
    "kv key",
  );
  assertUniqueImportKeys(
    candidate.posts.map((post) => post.message_id),
    "post message ID",
  );
  assertUniqueImportKeys(
    candidate.answers.map((answer) =>
      JSON.stringify([answer.questionMessageId, answer.userId]),
    ),
    "answer question/user key",
  );
  assertUniqueImportKeys(
    candidate.answers.map((answer) => answer.answerMessageId),
    "answer message ID",
  );
  assertUniqueImportKeys(
    candidate.metrics.map((metric) => metric.key),
    "metric key",
  );
  assertUniqueImportKeys(
    candidate.cooldowns.map((cooldown) => cooldown.userId),
    "cooldown user ID",
  );
}

function assertUniqueImportKeys(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new TypeError(`Imported ${label} must be unique`);
    }
    seen.add(value);
  }
}

function validateSpecialKvSnapshots(candidate: GuildDataExport): void {
  const stateRow = candidate.kv.find((row) => row.key === "state");
  const rawState = stateRow
    ? parseImportJsonObject(stateRow.value, "kv.state")
    : {};
  const expectedMutableState = {
    last_posted_date: optionalString(rawState.last_posted_date),
    last_dry_run_date: optionalString(rawState.last_dry_run_date),
    last_weekly_digest_week: optionalString(rawState.last_weekly_digest_week),
    history: stringArray(rawState.history).slice(-HISTORY_LIMIT),
    used_questions: dedupeStrings(stringArray(rawState.used_questions)),
    royal_presence: ensureRoyalPresenceShape(rawState.royal_presence),
    royal_afk: ensureRoyalAfkShape(rawState.royal_afk),
  };
  const importedMutableState = {
    last_posted_date: candidate.state.last_posted_date,
    last_dry_run_date: candidate.state.last_dry_run_date,
    last_weekly_digest_week: candidate.state.last_weekly_digest_week,
    history: candidate.state.history,
    used_questions: candidate.state.used_questions,
    royal_presence: candidate.state.royal_presence,
    royal_afk: candidate.state.royal_afk,
  };
  if (!isDeepStrictEqual(importedMutableState, expectedMutableState)) {
    throw new TypeError("Guild import state snapshot does not match kv.state");
  }

  const questionsRow = candidate.kv.find((row) => row.key === "questions");
  const expectedQuestions = defaultQuestions();
  if (questionsRow) {
    const rawQuestions = parseImportJsonObject(
      questionsRow.value,
      "kv.questions",
    );
    for (const [category, items] of Object.entries(rawQuestions)) {
      if (
        !Array.isArray(items) ||
        items.some((item) => typeof item !== "string")
      ) {
        throw new TypeError(
          `Guild import kv.questions category ${category} must be an array of strings`,
        );
      }
      expectedQuestions[category] = [...items];
    }
  }
  if (!isDeepStrictEqual(candidate.questions, expectedQuestions)) {
    throw new TypeError(
      "Guild import questions snapshot does not match kv.questions",
    );
  }

  const expectedPosts = candidate.posts.slice(-POST_RECORD_LIMIT);
  if (!isDeepStrictEqual(candidate.state.posts, expectedPosts)) {
    throw new TypeError(
      "Guild import state posts snapshot does not match posts",
    );
  }

  const expectedMetrics = metricsSnapshotFromImportRows(candidate.metrics);
  if (!isDeepStrictEqual(candidate.state.metrics, expectedMetrics)) {
    throw new TypeError(
      "Guild import state metrics snapshot does not match metrics",
    );
  }
}

function metricsSnapshotFromImportRows(
  rows: GuildMetricExport[],
): MetricsShape {
  const values = new Map(rows.map((row) => [row.key, row.value]));
  const prefixed = (prefix: string): Record<string, number> => {
    const result: Record<string, number> = {};
    for (const row of rows) {
      if (!row.key.startsWith(prefix)) {
        continue;
      }
      const suffix = row.key.slice(prefix.length);
      if (suffix) {
        result[suffix] = coerceInt(row.value, 0, 0);
      }
    }
    return result;
  };
  return ensureMetricsShape({
    command_usage: prefixed("command_usage."),
    command_failures: prefixed("command_failures."),
    posts_by_category: prefixed("posts_by_category."),
    posts_total: values.get("posts_total") ?? "0",
    posts_auto: values.get("posts_auto") ?? "0",
    posts_manual: values.get("posts_manual") ?? "0",
    custom_posts: values.get("custom_posts") ?? "0",
    answers_total: values.get("answers_total") ?? "0",
    last_successful_auto_post: values.get("last_successful_auto_post") || null,
  });
}

function parseImportJsonObject(
  raw: string,
  label: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new TypeError(`Guild import ${label} contains invalid JSON`, {
      cause: error,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`Guild import ${label} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function escapeRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function utcNow(): string {
  return new Date().toISOString();
}
