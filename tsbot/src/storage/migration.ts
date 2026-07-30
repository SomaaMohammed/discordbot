import { isDeepStrictEqual } from "node:util";
import Database from "better-sqlite3";
import {
  DISCORD_SNOWFLAKE_PATTERN,
  serializeGuildSettings,
} from "../guild-settings.js";
import type { GuildSettings } from "../types.js";
import {
  convertLegacyMetric,
  convertLegacyV2Settings,
  LEGACY_SILENCE_RECOVERY_METRIC_KEY,
} from "./legacy-v2-converter.js";
import {
  createV4Objects,
  createV4OperationalObjects,
  CURRENT_SCHEMA_VERSION,
  databaseIntegrityCheck,
  detectDatabaseSchema,
  type DatabaseSchemaKind,
  recordCurrentSchemaVersion,
  V2_TABLE_NAMES,
  validateV2Schema,
  validateV3Schema,
  validateV4Schema,
} from "./schema.js";

export type MigrationFailurePoint =
  | "after-source-read"
  | "after-rename"
  | "after-create"
  | "after-copy"
  | "after-verify"
  | "after-drop"
  | "after-version"
  | "before-commit";

export interface MigrationOptions {
  dbFile: string;
  dryRun?: boolean;
  failurePoint?: MigrationFailurePoint;
  now?: () => string;
  /** Test/diagnostic hook invoked after BEGIN IMMEDIATE and before reads. */
  onLockAcquired?: () => void;
}

export interface MigrationResult {
  status: "migrated" | "dry-run" | "already-current";
  fromSchema: "legacy-v2" | "legacy-v3" | "current-v4";
  toSchema: "current-v4";
  guilds: number;
  settingsRequiringReview: number;
  metricsPreserved: number;
  metricsDropped: number;
  warnings: number;
}

export interface DatabaseValidationResult {
  schema: DatabaseSchemaKind;
  schemaVersion: number | null;
  integrity: string;
  foreignKeyViolations: number;
}

interface V3Snapshot {
  guilds: unknown[];
  settings: unknown[];
  metrics: unknown[];
}

interface LegacyGuildRow {
  guild_id: string;
  enabled: number;
  name: string | null;
  joined_at: string | null;
  left_at: string | null;
  created_at: string;
  updated_at: string;
}

interface LegacySettingsRow {
  guild_id: string;
  settings_version: number;
  settings_json: string;
  updated_at: string;
}

interface LegacyMetricRow {
  guild_id: string;
  metric_key: string;
  metric_value: string;
  updated_at: string;
}

interface PreparedSettingsRow {
  guildId: string;
  settings: GuildSettings;
  json: string;
  updatedAt: string;
}

interface PreparedMetricRow {
  guildId: string;
  key: string;
  value: number;
  updatedAt: string;
}

interface PreparedMigration {
  guilds: LegacyGuildRow[];
  settings: PreparedSettingsRow[];
  metrics: PreparedMetricRow[];
  result: Omit<MigrationResult, "status">;
}

const V2_EXPLICIT_INDEXES = [
  "idx_posts_guild_closed_posted_at",
  "idx_posts_guild_posted_at",
  "idx_answers_guild_question_created",
  "idx_answers_guild_message_id",
  "idx_answers_guild_created_at",
  "idx_guilds_enabled_left_at",
] as const;

class DryRunRollback extends Error {}

export function migrateDatabase(options: MigrationOptions): MigrationResult {
  const db = new Database(options.dbFile, {
    fileMustExist: true,
    timeout: 5_000,
  });
  db.pragma("foreign_keys = ON");

  let dryRunResult: MigrationResult | null = null;
  try {
    const migrate = db.transaction((): MigrationResult => {
      options.onLockAcquired?.();
      assertIntegrity(db);
      const schema = detectDatabaseSchema(db);
      if (schema === "current-v4") {
        const issues = validateV4Schema(db);
        if (issues.length > 0) {
          throw new Error(`Schema v4 validation failed: ${issues.join("; ")}`);
        }
        return {
          status: "already-current",
          fromSchema: "current-v4",
          toSchema: "current-v4",
          guilds: countRows(db, "guilds"),
          settingsRequiringReview: countReviewRequiredSettings(db),
          metricsPreserved: countRows(db, "metrics"),
          metricsDropped: 0,
          warnings: 0,
        };
      }
      if (schema === "legacy-v3") {
        const v3Issues = validateV3Schema(db);
        if (v3Issues.length > 0) {
          throw new Error(
            `Schema v3 validation failed: ${v3Issues.join("; ")}`,
          );
        }
        const now = (options.now ?? utcNow)();
        const snapshot = readV3Snapshot(db);
        const result: MigrationResult = {
          status: options.dryRun ? "dry-run" : "migrated",
          fromSchema: "legacy-v3",
          toSchema: "current-v4",
          guilds: snapshot.guilds.length,
          settingsRequiringReview: countReviewRequiredSettings(db),
          metricsPreserved: snapshot.metrics.length,
          metricsDropped: 0,
          warnings: 0,
        };
        injectFailure(options, "after-source-read");
        injectFailure(options, "after-rename");
        createV4OperationalObjects(db);
        injectFailure(options, "after-create");
        injectFailure(options, "after-copy");
        verifyV3Snapshot(db, snapshot);
        injectFailure(options, "after-verify");
        injectFailure(options, "after-drop");
        recordCurrentSchemaVersion(db, now);
        injectFailure(options, "after-version");
        const finalIssues = validateV4Schema(db);
        if (finalIssues.length > 0) {
          throw new Error(
            `Migrated schema validation failed: ${finalIssues.join("; ")}`,
          );
        }
        injectFailure(options, "before-commit");
        if (options.dryRun) {
          dryRunResult = result;
          throw new DryRunRollback("validated dry run");
        }
        return result;
      }
      if (schema === "legacy-v1") {
        throw new Error(
          "Schema v1 cannot be migrated by v5. Upgrade with the final v4 release to schema v2, stop the bot, create an offline backup, then run the v5 migration.",
        );
      }
      if (schema !== "legacy-v2") {
        throw new Error(
          `Refusing to migrate ${schema}: expected the exact final-v4 schema v2 layout`,
        );
      }

      const v2Issues = validateV2Schema(db);
      if (v2Issues.length > 0) {
        throw new Error(`Schema v2 validation failed: ${v2Issues.join("; ")}`);
      }

      const now = (options.now ?? utcNow)();
      const prepared = prepareMigration(db, now);
      injectFailure(options, "after-source-read");

      for (const index of V2_EXPLICIT_INDEXES) {
        db.exec(`DROP INDEX ${quoteIdentifier(index)}`);
      }
      for (const table of V2_TABLE_NAMES) {
        db.exec(
          `ALTER TABLE ${quoteIdentifier(table)} RENAME TO ${quoteIdentifier(legacyTableName(table))}`,
        );
      }
      injectFailure(options, "after-rename");

      createV4Objects(db);
      injectFailure(options, "after-create");

      copyPreparedRows(db, prepared);
      injectFailure(options, "after-copy");
      verifyPreparedRows(db, prepared);
      injectFailure(options, "after-verify");

      for (const table of [...V2_TABLE_NAMES].reverse()) {
        db.exec(`DROP TABLE ${quoteIdentifier(legacyTableName(table))}`);
      }
      injectFailure(options, "after-drop");

      // The marker is deliberately the last data write. A database claiming
      // version 4 has already passed source and copy verification.
      recordCurrentSchemaVersion(db, now);
      injectFailure(options, "after-version");

      const finalIssues = validateV4Schema(db);
      if (finalIssues.length > 0) {
        throw new Error(
          `Migrated schema validation failed: ${finalIssues.join("; ")}`,
        );
      }

      const result: MigrationResult = {
        status: options.dryRun ? "dry-run" : "migrated",
        ...prepared.result,
      };
      injectFailure(options, "before-commit");
      if (options.dryRun) {
        dryRunResult = result;
        throw new DryRunRollback("validated dry run");
      }
      return result;
    });

    try {
      return migrate.immediate();
    } catch (error) {
      if (error instanceof DryRunRollback && dryRunResult) {
        return dryRunResult;
      }
      throw error;
    }
  } finally {
    db.close();
  }
}

export function validateDatabaseFile(
  dbFile: string,
  options: { expect: 2 | 3 | 4 },
): DatabaseValidationResult {
  const db = new Database(dbFile, {
    readonly: true,
    fileMustExist: true,
  });
  db.pragma("foreign_keys = ON");
  try {
    const integrity = databaseIntegrityCheck(db);
    const schema = detectDatabaseSchema(db);
    const foreignKeyViolations = (db.pragma("foreign_key_check") as unknown[])
      .length;
    const schemaVersion = readSchemaVersion(db, schema);
    const expected = options.expect;
    if (integrity.toLowerCase() !== "ok") {
      throw new Error(`Database integrity check failed: ${integrity}`);
    }
    if (foreignKeyViolations > 0) {
      throw new Error(
        `Database foreign-key check reported ${foreignKeyViolations} violation(s)`,
      );
    }
    if (
      (expected === 2 && schema !== "legacy-v2") ||
      (expected === 3 && schema !== "legacy-v3") ||
      (expected === 4 && schema !== "current-v4")
    ) {
      throw new Error(
        `Database schema is ${schema}; expected exact schema v${expected}`,
      );
    }
    return { schema, schemaVersion, integrity, foreignKeyViolations };
  } finally {
    db.close();
  }
}

function prepareMigration(
  db: Database.Database,
  now: string,
): PreparedMigration {
  const guilds = db
    .prepare("SELECT * FROM guilds ORDER BY guild_id")
    .all() as LegacyGuildRow[];
  const settingsRows = db
    .prepare("SELECT * FROM guild_settings ORDER BY guild_id")
    .all() as LegacySettingsRow[];
  const metricRows = db
    .prepare("SELECT * FROM metrics ORDER BY guild_id, metric_key")
    .all() as LegacyMetricRow[];

  assertLegacyGuildRows(guilds);
  assertNoUnresolvedRecoveryMetadata(metricRows);

  const sourceSettings = new Map(
    settingsRows.map((row) => [row.guild_id, row]),
  );
  const settings: PreparedSettingsRow[] = [];
  let settingsRequiringReview = 0;
  let warnings = 0;

  for (const guild of guilds) {
    const source = sourceSettings.get(guild.guild_id);
    let input: unknown = {};
    let sourceEnabled: boolean | null = null;
    if (source?.settings_version === 1) {
      try {
        input = JSON.parse(source.settings_json) as unknown;
        if (
          input &&
          typeof input === "object" &&
          !Array.isArray(input) &&
          typeof (input as { enabled?: unknown }).enabled === "boolean"
        ) {
          sourceEnabled = (input as { enabled: boolean }).enabled;
        }
      } catch {
        input = {};
      }
    }

    const enabledConsistent =
      sourceEnabled !== null && sourceEnabled === Boolean(guild.enabled);
    const converted = convertLegacyV2Settings(enabledConsistent ? input : {}, {
      guildEnabled: Boolean(guild.enabled),
      guildActive: guild.left_at === null,
    });
    if (converted.settings.reviewRequired) {
      settingsRequiringReview += 1;
    }
    warnings += converted.warnings.length;
    guild.enabled = converted.settings.enabled ? 1 : 0;
    settings.push({
      guildId: guild.guild_id,
      settings: converted.settings,
      json: serializeGuildSettings(converted.settings),
      updatedAt: now,
    });
  }

  const preparedMetrics = new Map<string, PreparedMetricRow>();
  let dropped = 0;
  for (const row of metricRows) {
    if (row.metric_key === LEGACY_SILENCE_RECOVERY_METRIC_KEY) {
      dropped += 1;
      continue;
    }
    const converted = convertLegacyMetric(row.metric_key, row.metric_value);
    if (!converted) {
      dropped += 1;
      continue;
    }
    if (!isValidTimestamp(row.updated_at)) {
      dropped += 1;
      continue;
    }
    const mapKey = `${row.guild_id}\u0000${converted.key}`;
    const existing = preparedMetrics.get(mapKey);
    if (!existing) {
      preparedMetrics.set(mapKey, {
        guildId: row.guild_id,
        key: converted.key,
        value: converted.value,
        updatedAt: row.updated_at,
      });
      continue;
    }
    const total = existing.value + converted.value;
    if (!Number.isSafeInteger(total)) {
      throw new Error(
        "Active metric collision exceeds the supported safe-integer range",
      );
    }
    existing.value = total;
    if (Date.parse(row.updated_at) > Date.parse(existing.updatedAt)) {
      existing.updatedAt = row.updated_at;
    }
  }

  return {
    guilds,
    settings,
    metrics: [...preparedMetrics.values()].sort((left, right) =>
      `${left.guildId}\u0000${left.key}`.localeCompare(
        `${right.guildId}\u0000${right.key}`,
      ),
    ),
    result: {
      fromSchema: "legacy-v2",
      toSchema: "current-v4",
      guilds: guilds.length,
      settingsRequiringReview,
      metricsPreserved: preparedMetrics.size,
      metricsDropped: dropped,
      warnings,
    },
  };
}

function copyPreparedRows(
  db: Database.Database,
  prepared: PreparedMigration,
): void {
  const insertGuild = db.prepare(
    `INSERT INTO guilds (
       guild_id, enabled, name, joined_at, left_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const guild of prepared.guilds) {
    insertGuild.run(
      guild.guild_id,
      guild.enabled,
      guild.name,
      guild.joined_at,
      guild.left_at,
      guild.created_at,
      guild.updated_at,
    );
  }

  const insertSettings = db.prepare(
    `INSERT INTO guild_settings (
       guild_id, settings_version, settings_json, updated_at
     ) VALUES (?, 2, ?, ?)`,
  );
  for (const row of prepared.settings) {
    insertSettings.run(row.guildId, row.json, row.updatedAt);
  }

  const insertMetric = db.prepare(
    `INSERT INTO metrics (
       guild_id, metric_key, metric_value, updated_at
     ) VALUES (?, ?, ?, ?)`,
  );
  for (const row of prepared.metrics) {
    insertMetric.run(row.guildId, row.key, row.value, row.updatedAt);
  }
}

function verifyPreparedRows(
  db: Database.Database,
  prepared: PreparedMigration,
): void {
  const guilds = db
    .prepare("SELECT * FROM guilds ORDER BY guild_id")
    .all() as LegacyGuildRow[];
  if (!isDeepStrictEqual(guilds, prepared.guilds)) {
    throw new Error("Migrated guild metadata does not match the prepared copy");
  }

  const settings = db
    .prepare(
      "SELECT guild_id, settings_version, settings_json, updated_at FROM guild_settings ORDER BY guild_id",
    )
    .all() as LegacySettingsRow[];
  const expectedSettings = prepared.settings.map((row) => ({
    guild_id: row.guildId,
    settings_version: 2,
    settings_json: row.json,
    updated_at: row.updatedAt,
  }));
  if (!isDeepStrictEqual(settings, expectedSettings)) {
    throw new Error("Migrated guild settings do not match the prepared copy");
  }

  const metrics = db
    .prepare(
      "SELECT guild_id, metric_key, metric_value, updated_at FROM metrics ORDER BY guild_id, metric_key",
    )
    .all() as Array<{
    guild_id: string;
    metric_key: string;
    metric_value: number;
    updated_at: string;
  }>;
  const expectedMetrics = prepared.metrics.map((row) => ({
    guild_id: row.guildId,
    metric_key: row.key,
    metric_value: row.value,
    updated_at: row.updatedAt,
  }));
  if (!isDeepStrictEqual(metrics, expectedMetrics)) {
    throw new Error("Migrated metrics do not match the prepared copy");
  }

  const foreignKeyViolations = db.pragma("foreign_key_check") as unknown[];
  if (foreignKeyViolations.length > 0) {
    throw new Error("Migrated candidate has foreign-key violations");
  }
}

function readV3Snapshot(db: Database.Database): V3Snapshot {
  return {
    guilds: db.prepare("SELECT * FROM guilds ORDER BY guild_id").all(),
    settings: db
      .prepare("SELECT * FROM guild_settings ORDER BY guild_id")
      .all(),
    metrics: db
      .prepare("SELECT * FROM metrics ORDER BY guild_id, metric_key")
      .all(),
  };
}

function verifyV3Snapshot(db: Database.Database, expected: V3Snapshot): void {
  const actual = readV3Snapshot(db);
  if (!isDeepStrictEqual(actual.guilds, expected.guilds)) {
    throw new Error("Schema v3 guild metadata changed during migration");
  }
  if (!isDeepStrictEqual(actual.settings, expected.settings)) {
    throw new Error("Schema v3 guild settings changed during migration");
  }
  if (!isDeepStrictEqual(actual.metrics, expected.metrics)) {
    throw new Error("Schema v3 metrics changed during migration");
  }
}

function assertLegacyGuildRows(rows: LegacyGuildRow[]): void {
  for (const row of rows) {
    if (!DISCORD_SNOWFLAKE_PATTERN.test(row.guild_id)) {
      throw new Error("Schema v2 contains an invalid guild ID");
    }
    if (row.enabled !== 0 && row.enabled !== 1) {
      throw new Error("Schema v2 contains an invalid enabled value");
    }
    for (const timestamp of [
      row.joined_at,
      row.left_at,
      row.created_at,
      row.updated_at,
    ]) {
      if (timestamp !== null && !isValidTimestamp(timestamp)) {
        throw new Error("Schema v2 contains invalid guild timestamps");
      }
    }
  }
}

function assertNoUnresolvedRecoveryMetadata(rows: LegacyMetricRow[]): void {
  for (const row of rows) {
    if (row.metric_key !== LEGACY_SILENCE_RECOVERY_METRIC_KEY) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.metric_value);
    } catch {
      throw new Error(
        "Migration blocked: permission-recovery metadata is malformed. Run the final v4 bot, repair or restore all silence leases, verify the lease list is empty, stop the service, and retry.",
      );
    }
    if (!isValidEmptyRecoveryPayload(parsed)) {
      throw new Error(
        "Migration blocked: unresolved or malformed permission-recovery metadata exists. Run the final v4 bot, restore/cancel every silence lease, verify the lease list is empty, stop the service, and retry.",
      );
    }
  }
}

function isValidEmptyRecoveryPayload(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    record.version === 1 &&
    Array.isArray(record.leases) &&
    record.leases.length === 0
  );
}

function assertIntegrity(db: Database.Database): void {
  const integrity = databaseIntegrityCheck(db);
  if (integrity.toLowerCase() !== "ok") {
    throw new Error(`Database integrity check failed: ${integrity}`);
  }
}

function injectFailure(
  options: MigrationOptions,
  point: MigrationFailurePoint,
): void {
  if (options.failurePoint === point) {
    throw new Error(`Injected migration failure at ${point}`);
  }
}

function countRows(db: Database.Database, table: string): number {
  return Number(
    (
      db
        .prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`)
        .get() as { count: number }
    ).count,
  );
}

function countReviewRequiredSettings(db: Database.Database): number {
  const rows = db
    .prepare("SELECT settings_json FROM guild_settings")
    .all() as Array<{ settings_json: string }>;
  return rows.reduce((count, row) => {
    try {
      const parsed = JSON.parse(row.settings_json) as {
        reviewRequired?: unknown;
      };
      return count + (parsed.reviewRequired === true ? 1 : 0);
    } catch {
      return count;
    }
  }, 0);
}

function readSchemaVersion(
  db: Database.Database,
  schema: DatabaseSchemaKind,
): number | null {
  if (
    schema !== "legacy-v2" &&
    schema !== "legacy-v3" &&
    schema !== "current-v4"
  ) {
    return null;
  }
  const row = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as { version: number | null };
  return row.version === null ? null : Number(row.version);
}

function legacyTableName(table: string): string {
  return `${table}_v2_legacy`;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function utcNow(): string {
  return new Date().toISOString();
}

function isValidTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Number.isFinite(Date.parse(value))
  );
}
