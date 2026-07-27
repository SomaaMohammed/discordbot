import Database from "better-sqlite3";
import {
  assertDiscordSnowflake,
  serializeGuildSettings,
} from "../guild-settings.js";
import {
  buildLegacyGuildSettings,
  buildMigratedStatePayload,
  parseLegacyStateJson,
} from "./legacy-v1-settings.js";
import {
  countLegacyRows,
  createV2Objects,
  databaseIntegrityCheck,
  detectDatabaseSchema,
  recordCurrentSchemaVersion,
  validateV2Schema,
  type DatabaseSchemaKind,
} from "./schema.js";

export type MigrationFailurePoint =
  "after-rename" | "after-create" | "after-copy" | "after-verify";

export interface MigrateDatabaseOptions {
  dbFile: string;
  legacyGuildId: string | null;
  environment?: NodeJS.ProcessEnv;
  now?: () => string;
  /** Test-only failure injection used to prove transactional rollback. */
  failurePoint?: MigrationFailurePoint;
}

export interface MigrationResult {
  status: "initialized" | "migrated" | "already-current";
  schemaVersion: 2;
  copiedRows: Record<string, number>;
}

export interface DatabaseValidationResult {
  schema: DatabaseSchemaKind;
  integrity: "ok";
  schemaVersion: 0 | 1 | 2;
}

const LEGACY_TABLE_MAP = {
  kv: "kv_v1_legacy",
  posts: "posts_v1_legacy",
  answers: "answers_v1_legacy",
  metrics: "metrics_v1_legacy",
  anon_cooldowns: "anon_cooldowns_v1_legacy",
} as const;

const LEGACY_INDEX_NAMES = [
  "idx_posts_closed_posted_at",
  "idx_answers_question_created",
  "idx_answers_message_id",
] as const;

export function migrateDatabase(
  options: MigrateDatabaseOptions,
): MigrationResult {
  const db = new Database(options.dbFile);
  const now = options.now ?? (() => new Date().toISOString());
  try {
    db.pragma("foreign_keys = ON");
    const migrate = db.transaction((): MigrationResult => {
      // BEGIN IMMEDIATE is acquired before schema classification or any legacy
      // source reads. A v1 writer therefore cannot commit newer rows between
      // the snapshot used for transformation and the INSERT ... SELECT copy.
      assertHealthy(db);
      const schema = detectDatabaseSchema(db);
      if (schema === "current-v2") {
        return {
          status: "already-current",
          schemaVersion: 2,
          copiedRows: {},
        };
      }
      if (schema === "unknown") {
        throw new Error(
          "Database schema is unknown or incomplete; migration refused without changes.",
        );
      }

      if (schema === "empty") {
        const appliedAt = now();
        createV2Objects(db);
        recordCurrentSchemaVersion(db, appliedAt);
        const issues = validateV2Schema(db);
        if (issues.length > 0) {
          throw new Error(`Failed to initialize schema: ${issues.join("; ")}`);
        }
        assertHealthy(db);
        return {
          status: "initialized",
          schemaVersion: 2,
          copiedRows: {},
        };
      }

      const counts = countLegacyRows(db);
      const hasRows = Object.values(counts).some((count) => count > 0);
      const guildId = options.legacyGuildId
        ? assertDiscordSnowflake(options.legacyGuildId, "LEGACY_GUILD_ID")
        : null;
      if (hasRows && !guildId) {
        throw new Error(
          "LEGACY_GUILD_ID is required because the legacy database contains rows (TEST_GUILD_ID is accepted only by the migration CLI as a deprecated fallback).",
        );
      }

      const stateRow = db
        .prepare("SELECT value FROM kv WHERE key = 'state'")
        .get() as { value: string } | undefined;
      const legacyState = parseLegacyStateJson(stateRow?.value ?? null);
      const settings = guildId
        ? buildLegacyGuildSettings(options.environment ?? {}, legacyState)
        : null;
      const appliedAt = now();

      for (const [current, legacy] of Object.entries(LEGACY_TABLE_MAP)) {
        db.exec(
          `ALTER TABLE ${quoteIdentifier(current)} RENAME TO ${quoteIdentifier(legacy)}`,
        );
      }
      for (const index of LEGACY_INDEX_NAMES) {
        db.exec(`DROP INDEX IF EXISTS ${quoteIdentifier(index)}`);
      }
      injectFailure(options, "after-rename");

      createV2Objects(db);
      injectFailure(options, "after-create");

      if (guildId && settings) {
        db.prepare(
          `INSERT INTO guilds (
             guild_id, enabled, name, joined_at, left_at, created_at, updated_at
           ) VALUES (?, 1, NULL, NULL, NULL, ?, ?)`,
        ).run(guildId, appliedAt, appliedAt);
        db.prepare(
          `INSERT INTO guild_settings (
             guild_id, settings_version, settings_json, updated_at
           ) VALUES (?, ?, ?, ?)`,
        ).run(
          guildId,
          settings.version,
          serializeGuildSettings(settings),
          appliedAt,
        );

        db.prepare(
          `INSERT INTO kv (guild_id, key, value, updated_at)
           SELECT ?, key, value, updated_at FROM kv_v1_legacy`,
        ).run(guildId);
        if (stateRow) {
          db.prepare(
            `UPDATE kv SET value = ?
             WHERE guild_id = ? AND key = 'state'`,
          ).run(
            JSON.stringify(buildMigratedStatePayload(legacyState)),
            guildId,
          );
        }
        db.prepare(
          `INSERT INTO posts (
             guild_id, message_id, thread_id, channel_id, category, question,
             posted_at, close_after_hours, closed, closed_at, close_reason
           )
           SELECT ?, message_id, thread_id, channel_id, category, question,
                  posted_at, close_after_hours, closed, closed_at, close_reason
           FROM posts_v1_legacy`,
        ).run(guildId);
        db.prepare(
          `INSERT INTO answers (
             guild_id, question_message_id, user_id, answer_message_id, created_at
           )
           SELECT ?, question_message_id, user_id, answer_message_id, created_at
           FROM answers_v1_legacy`,
        ).run(guildId);
        db.prepare(
          `INSERT INTO metrics (
             guild_id, metric_key, metric_value, updated_at
           )
           SELECT ?, metric_key, metric_value, updated_at
           FROM metrics_v1_legacy`,
        ).run(guildId);
        db.prepare(
          `INSERT INTO anon_cooldowns (guild_id, user_id, last_answer_at)
           SELECT ?, user_id, last_answer_at FROM anon_cooldowns_v1_legacy`,
        ).run(guildId);
      }
      injectFailure(options, "after-copy");

      verifyCopiedRowCounts(db, counts, guildId);
      const foreignKeyViolations = db.pragma("foreign_key_check") as unknown[];
      if (foreignKeyViolations.length > 0) {
        throw new Error("Migration produced foreign key violations");
      }
      injectFailure(options, "after-verify");

      for (const legacy of Object.values(LEGACY_TABLE_MAP)) {
        db.exec(`DROP TABLE ${quoteIdentifier(legacy)}`);
      }
      // The version marker is deliberately the final data write. A database is
      // never advertised as v2 before all copy and integrity checks succeed.
      recordCurrentSchemaVersion(db, appliedAt);

      const issues = validateV2Schema(db);
      if (issues.length > 0) {
        throw new Error(
          `Migrated schema validation failed: ${issues.join("; ")}`,
        );
      }
      assertHealthy(db);

      return {
        status: "migrated",
        schemaVersion: 2,
        copiedRows: counts,
      };
    });
    return migrate.immediate();
  } finally {
    db.close();
  }
}

export function validateDatabaseFile(
  dbFile: string,
  options: { requireCurrent?: boolean } = {},
): DatabaseValidationResult {
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    assertHealthy(db);
    const schema = detectDatabaseSchema(db);
    if (schema === "unknown" || schema === "empty") {
      throw new Error(`Database schema is ${schema}; validation failed`);
    }
    if (options.requireCurrent && schema !== "current-v2") {
      throw new Error("Database schema is not current v2");
    }
    if (schema === "current-v2") {
      const issues = validateV2Schema(db);
      if (issues.length > 0) {
        throw new Error(
          `Database schema validation failed: ${issues.join("; ")}`,
        );
      }
    }
    return {
      schema,
      integrity: "ok",
      schemaVersion: schema === "current-v2" ? 2 : 1,
    };
  } finally {
    db.close();
  }
}

function verifyCopiedRowCounts(
  db: Database.Database,
  expected: Record<string, number>,
  guildId: string | null,
): void {
  const guildCount = db
    .prepare("SELECT COUNT(*) AS count FROM guilds")
    .get() as { count: number };
  const settingsCount = db
    .prepare("SELECT COUNT(*) AS count FROM guild_settings")
    .get() as { count: number };
  const expectedMetadataRows = guildId ? 1 : 0;
  if (
    Number(guildCount.count) !== expectedMetadataRows ||
    Number(settingsCount.count) !== expectedMetadataRows
  ) {
    throw new Error("Migration guild metadata/settings row-count mismatch");
  }

  for (const table of Object.keys(LEGACY_TABLE_MAP) as Array<
    keyof typeof LEGACY_TABLE_MAP
  >) {
    const row = guildId
      ? (db
          .prepare(
            `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)} WHERE guild_id = ?`,
          )
          .get(guildId) as { count: number })
      : (db
          .prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`)
          .get() as { count: number });
    const actual = Number(row.count);
    const wanted = expected[table] ?? 0;
    if (actual !== wanted) {
      throw new Error(
        `Migration row-count mismatch for ${table}: copied ${actual}, expected ${wanted}`,
      );
    }
  }
}

function assertHealthy(db: Database.Database): void {
  const result = databaseIntegrityCheck(db);
  if (result !== "ok") {
    throw new Error(`SQLite integrity_check failed: ${result || "no result"}`);
  }
}

function injectFailure(
  options: MigrateDatabaseOptions,
  point: MigrationFailurePoint,
): void {
  if (options.failurePoint === point) {
    throw new Error(`Injected migration failure at ${point}`);
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
