import type Database from "better-sqlite3";
import {
  GUILD_SETTINGS_VERSION,
  isDiscordSnowflake,
  parseGuildSettingsJson,
} from "../guild-settings.js";
import { isActiveMetricKey } from "./metric-keys.js";

export const CURRENT_SCHEMA_VERSION = 3 as const;
export const LEGACY_V2_SCHEMA_VERSION = 2 as const;

export type DatabaseSchemaKind =
  "empty" | "legacy-v1" | "legacy-v2" | "current-v3" | "unknown";

export const SCHEMA_MIGRATIONS_TABLE_SQL = `
CREATE TABLE schema_migrations (
  version INTEGER NOT NULL PRIMARY KEY CHECK (version > 0),
  applied_at TEXT NOT NULL
)
`;

export const GUILDS_TABLE_SQL = `
CREATE TABLE guilds (
  guild_id TEXT NOT NULL PRIMARY KEY
    CHECK (
      length(guild_id) BETWEEN 17 AND 20
      AND guild_id NOT GLOB '*[^0-9]*'
    ),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  name TEXT,
  joined_at TEXT,
  left_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
`;

export const GUILD_SETTINGS_TABLE_SQL = `
CREATE TABLE guild_settings (
  guild_id TEXT NOT NULL PRIMARY KEY,
  settings_version INTEGER NOT NULL CHECK (settings_version = 2),
  settings_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
)
`;

export const METRICS_TABLE_SQL = `
CREATE TABLE metrics (
  guild_id TEXT NOT NULL,
  metric_key TEXT NOT NULL CHECK (length(metric_key) BETWEEN 1 AND 200),
  metric_value INTEGER NOT NULL
    CHECK (metric_value BETWEEN 0 AND 9007199254740991),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, metric_key),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
)
`;

export const GUILDS_ENABLED_LEFT_AT_INDEX_SQL = `
CREATE INDEX idx_guilds_enabled_left_at
ON guilds (enabled, left_at)
`;

export const V3_TABLE_NAMES = [
  "schema_migrations",
  "guilds",
  "guild_settings",
  "metrics",
] as const;

export const V3_EXPLICIT_INDEX_NAMES = ["idx_guilds_enabled_left_at"] as const;

const V3_TABLE_SQL: Record<(typeof V3_TABLE_NAMES)[number], string> = {
  schema_migrations: SCHEMA_MIGRATIONS_TABLE_SQL,
  guilds: GUILDS_TABLE_SQL,
  guild_settings: GUILD_SETTINGS_TABLE_SQL,
  metrics: METRICS_TABLE_SQL,
};

const V3_INDEX_SQL: Record<(typeof V3_EXPLICIT_INDEX_NAMES)[number], string> = {
  idx_guilds_enabled_left_at: GUILDS_ENABLED_LEFT_AT_INDEX_SQL,
};

export const V1_TABLE_NAMES = [
  "kv",
  "posts",
  "answers",
  "metrics",
  "anon_cooldowns",
] as const;

export const V2_TABLE_NAMES = [
  "schema_migrations",
  "guilds",
  "guild_settings",
  "kv",
  "posts",
  "answers",
  "metrics",
  "anon_cooldowns",
] as const;

const V2_EXPLICIT_INDEX_NAMES = [
  "idx_posts_guild_closed_posted_at",
  "idx_posts_guild_posted_at",
  "idx_answers_guild_question_created",
  "idx_answers_guild_message_id",
  "idx_answers_guild_created_at",
  "idx_guilds_enabled_left_at",
] as const;

const V1_EXPLICIT_INDEX_NAMES = [
  "idx_posts_closed_posted_at",
  "idx_answers_question_created",
  "idx_answers_message_id",
] as const;

// Frozen v2 definitions are used only to identify the supported migration
// source. They intentionally match the final v4 schema byte-for-byte after
// SQL normalization.
const V2_TABLE_SQL: Record<(typeof V2_TABLE_NAMES)[number], string> = {
  schema_migrations: `CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`,
  guilds: `CREATE TABLE guilds (
    guild_id TEXT NOT NULL PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    name TEXT,
    joined_at TEXT,
    left_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  guild_settings: `CREATE TABLE guild_settings (
    guild_id TEXT NOT NULL PRIMARY KEY,
    settings_version INTEGER NOT NULL,
    settings_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
  )`,
  kv: `CREATE TABLE kv (
    guild_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (guild_id, key),
    FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
  )`,
  posts: `CREATE TABLE posts (
    guild_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    thread_id TEXT,
    channel_id TEXT NOT NULL,
    category TEXT NOT NULL,
    question TEXT NOT NULL,
    posted_at TEXT NOT NULL,
    close_after_hours INTEGER NOT NULL DEFAULT 24,
    closed INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0, 1)),
    closed_at TEXT,
    close_reason TEXT,
    PRIMARY KEY (guild_id, message_id),
    FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
  )`,
  answers: `CREATE TABLE answers (
    guild_id TEXT NOT NULL,
    question_message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    answer_message_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (guild_id, question_message_id, user_id),
    FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
  )`,
  metrics: `CREATE TABLE metrics (
    guild_id TEXT NOT NULL,
    metric_key TEXT NOT NULL,
    metric_value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (guild_id, metric_key),
    FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
  )`,
  anon_cooldowns: `CREATE TABLE anon_cooldowns (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    last_answer_at TEXT NOT NULL,
    PRIMARY KEY (guild_id, user_id),
    FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
  )`,
};

const V2_INDEX_SQL: Record<(typeof V2_EXPLICIT_INDEX_NAMES)[number], string> = {
  idx_posts_guild_closed_posted_at:
    "CREATE INDEX idx_posts_guild_closed_posted_at ON posts (guild_id, closed, julianday(posted_at))",
  idx_posts_guild_posted_at:
    "CREATE INDEX idx_posts_guild_posted_at ON posts (guild_id, julianday(posted_at))",
  idx_answers_guild_question_created:
    "CREATE INDEX idx_answers_guild_question_created ON answers (guild_id, question_message_id, created_at)",
  idx_answers_guild_message_id:
    "CREATE INDEX idx_answers_guild_message_id ON answers (guild_id, answer_message_id)",
  idx_answers_guild_created_at:
    "CREATE INDEX idx_answers_guild_created_at ON answers (guild_id, julianday(created_at))",
  idx_guilds_enabled_left_at:
    "CREATE INDEX idx_guilds_enabled_left_at ON guilds (enabled, left_at)",
};

interface SchemaObjectRow {
  type: "table" | "index" | "view" | "trigger";
  name: string;
  tbl_name: string;
  sql: string | null;
}

interface TableInfoRow {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

interface ForeignKeyRow {
  table: string;
  from: string;
  to: string;
  on_delete: string;
}

interface GuildDataRow {
  guild_id: string;
  enabled: number;
  joined_at: string | null;
  left_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SettingsDataRow {
  guild_id: string;
  settings_version: number;
  settings_json: string;
  updated_at: string;
}

interface MetricDataRow {
  guild_id: string;
  metric_key: string;
  metric_value: number;
  updated_at: string;
}

export function createV3Objects(db: Database.Database): void {
  for (const table of V3_TABLE_NAMES) {
    db.exec(V3_TABLE_SQL[table]);
  }
  for (const index of V3_EXPLICIT_INDEX_NAMES) {
    db.exec(V3_INDEX_SQL[index]);
  }
}

export function recordCurrentSchemaVersion(
  db: Database.Database,
  appliedAt: string,
): void {
  db.prepare(
    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
  ).run(CURRENT_SCHEMA_VERSION, appliedAt);
}

export function initializeV3Schema(
  db: Database.Database,
  appliedAt: string,
): void {
  const initialize = db.transaction(() => {
    createV3Objects(db);
    recordCurrentSchemaVersion(db, appliedAt);
    const issues = validateV3Schema(db);
    if (issues.length > 0) {
      throw new Error(`Failed to initialize schema: ${issues.join("; ")}`);
    }
  });
  initialize.immediate();
}

export function getUserTableNames(db: Database.Database): string[] {
  return getSchemaObjects(db)
    .filter((row) => row.type === "table")
    .map((row) => row.name)
    .sort();
}

export function detectDatabaseSchema(
  db: Database.Database,
): DatabaseSchemaKind {
  const objects = getSchemaObjects(db);
  if (objects.length === 0) {
    return "empty";
  }

  const tables = objects
    .filter((row) => row.type === "table")
    .map((row) => row.name)
    .sort();

  if (sameStrings(tables, [...V3_TABLE_NAMES].sort())) {
    return validateV3Schema(db).length === 0 ? "current-v3" : "unknown";
  }
  if (sameStrings(tables, [...V2_TABLE_NAMES].sort())) {
    return validateV2Schema(db).length === 0 ? "legacy-v2" : "unknown";
  }
  if (sameStrings(tables, [...V1_TABLE_NAMES].sort())) {
    return validateV1Schema(db).length === 0 ? "legacy-v1" : "unknown";
  }
  return "unknown";
}

export function validateV3Schema(db: Database.Database): string[] {
  const issues = validateExactObjects(
    db,
    [...V3_TABLE_NAMES],
    [...V3_EXPLICIT_INDEX_NAMES],
  );
  if (issues.length > 0) {
    return issues;
  }

  validateSqlDefinitions(db, V3_TABLE_SQL, "table", issues);
  validateSqlDefinitions(db, V3_INDEX_SQL, "index", issues);
  validateColumnsAndKeys(
    db,
    {
      schema_migrations: ["version", "applied_at"],
      guilds: [
        "guild_id",
        "enabled",
        "name",
        "joined_at",
        "left_at",
        "created_at",
        "updated_at",
      ],
      guild_settings: [
        "guild_id",
        "settings_version",
        "settings_json",
        "updated_at",
      ],
      metrics: ["guild_id", "metric_key", "metric_value", "updated_at"],
    },
    {
      schema_migrations: ["version"],
      guilds: ["guild_id"],
      guild_settings: ["guild_id"],
      metrics: ["guild_id", "metric_key"],
    },
    issues,
  );
  validateGuildForeignKey(db, "guild_settings", issues);
  validateGuildForeignKey(db, "metrics", issues);

  const versions = db
    .prepare(
      "SELECT version, applied_at FROM schema_migrations ORDER BY version",
    )
    .all() as Array<{ version: number; applied_at: string }>;
  if (
    versions.length !== 1 ||
    versions[0]?.version !== CURRENT_SCHEMA_VERSION ||
    !isValidTimestamp(versions[0]?.applied_at)
  ) {
    issues.push(
      `schema_migrations must contain exactly version ${CURRENT_SCHEMA_VERSION}`,
    );
  }

  validateV3Data(db, issues);
  validateDatabaseHealth(db, issues);
  return issues;
}

export function validateV2Schema(db: Database.Database): string[] {
  const issues = validateExactObjects(
    db,
    [...V2_TABLE_NAMES],
    [...V2_EXPLICIT_INDEX_NAMES],
  );
  if (issues.length > 0) {
    return issues;
  }

  validateSqlDefinitions(db, V2_TABLE_SQL, "table", issues);
  validateSqlDefinitions(db, V2_INDEX_SQL, "index", issues);
  for (const table of [
    "guild_settings",
    "kv",
    "posts",
    "answers",
    "metrics",
    "anon_cooldowns",
  ]) {
    validateGuildForeignKey(db, table, issues);
  }

  const versions = db
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all() as Array<{ version: number }>;
  if (
    versions.length === 0 ||
    versions.at(-1)?.version !== LEGACY_V2_SCHEMA_VERSION ||
    versions.some(
      (row) =>
        !Number.isInteger(row.version) ||
        row.version < 1 ||
        row.version > LEGACY_V2_SCHEMA_VERSION,
    )
  ) {
    issues.push("schema_migrations must end at version 2");
  }
  validateDatabaseHealth(db, issues);
  return issues;
}

export function databaseIntegrityCheck(db: Database.Database): string {
  const rows = db.pragma("integrity_check") as Array<{
    integrity_check: string;
  }>;
  return rows.map((row) => String(row.integrity_check)).join("; ");
}

function validateV1Schema(db: Database.Database): string[] {
  const issues = validateExactObjects(
    db,
    [...V1_TABLE_NAMES],
    [...V1_EXPLICIT_INDEX_NAMES],
  );
  if (issues.length > 0) {
    return issues;
  }
  const expectedColumns: Record<string, string[]> = {
    kv: ["key", "value", "updated_at"],
    posts: [
      "message_id",
      "thread_id",
      "channel_id",
      "category",
      "question",
      "posted_at",
      "close_after_hours",
      "closed",
      "closed_at",
      "close_reason",
    ],
    answers: [
      "question_message_id",
      "user_id",
      "answer_message_id",
      "created_at",
    ],
    metrics: ["metric_key", "metric_value", "updated_at"],
    anon_cooldowns: ["user_id", "last_answer_at"],
  };
  for (const [table, columns] of Object.entries(expectedColumns)) {
    const actual = tableInfo(db, table).map((row) => row.name);
    if (!sameStrings(actual, columns)) {
      issues.push(`${table} does not match the final v4 v1 layout`);
    }
  }
  return issues;
}

function validateV3Data(db: Database.Database, issues: string[]): void {
  const guilds = db
    .prepare(
      "SELECT guild_id, enabled, joined_at, left_at, created_at, updated_at FROM guilds ORDER BY guild_id",
    )
    .all() as GuildDataRow[];
  const settingsRows = db
    .prepare(
      "SELECT guild_id, settings_version, settings_json, updated_at FROM guild_settings ORDER BY guild_id",
    )
    .all() as SettingsDataRow[];

  if (settingsRows.length !== guilds.length) {
    issues.push("every guild must have exactly one settings row");
  }
  const guildById = new Map(guilds.map((row) => [row.guild_id, row]));
  for (const guild of guilds) {
    if (!isDiscordSnowflake(guild.guild_id)) {
      issues.push(`guilds contains invalid guild ID ${guild.guild_id}`);
    }
    if (guild.enabled !== 0 && guild.enabled !== 1) {
      issues.push(`guild ${guild.guild_id} has invalid enabled state`);
    }
    if (guild.enabled === 1 && guild.left_at !== null) {
      issues.push(`guild ${guild.guild_id} is enabled after leaving`);
    }
    if (
      !isValidTimestamp(guild.created_at) ||
      !isValidTimestamp(guild.updated_at) ||
      (guild.joined_at !== null && !isValidTimestamp(guild.joined_at)) ||
      (guild.left_at !== null && !isValidTimestamp(guild.left_at))
    ) {
      issues.push(`guild ${guild.guild_id} has invalid timestamps`);
    }
  }

  for (const row of settingsRows) {
    const guild = guildById.get(row.guild_id);
    if (!guild) {
      issues.push(`settings row ${row.guild_id} has no guild`);
      continue;
    }
    if (row.settings_version !== GUILD_SETTINGS_VERSION) {
      issues.push(`guild ${row.guild_id} settings version is not 2`);
      continue;
    }
    try {
      const settings = parseGuildSettingsJson(row.settings_json);
      if (settings.enabled !== Boolean(guild.enabled)) {
        issues.push(`guild ${row.guild_id} enabled state is inconsistent`);
      }
    } catch (error) {
      issues.push(
        `guild ${row.guild_id} settings are invalid: ${errorMessage(error)}`,
      );
    }
    if (!isValidTimestamp(row.updated_at)) {
      issues.push(`guild ${row.guild_id} settings timestamp is invalid`);
    }
  }

  const metrics = db
    .prepare(
      "SELECT guild_id, metric_key, metric_value, updated_at FROM metrics ORDER BY guild_id, metric_key",
    )
    .all() as MetricDataRow[];
  for (const metric of metrics) {
    if (!guildById.has(metric.guild_id)) {
      issues.push(`metric ${metric.metric_key} has no guild`);
    }
    if (
      !isActiveMetricKey(metric.metric_key) ||
      !Number.isSafeInteger(metric.metric_value) ||
      metric.metric_value < 0
    ) {
      issues.push(
        `guild ${metric.guild_id} has invalid metric ${metric.metric_key}`,
      );
    }
    if (!isValidTimestamp(metric.updated_at)) {
      issues.push(`metric ${metric.metric_key} timestamp is invalid`);
    }
  }
}

function validateExactObjects(
  db: Database.Database,
  expectedTables: string[],
  expectedIndexes: string[],
): string[] {
  const objects = getSchemaObjects(db);
  const actualTables = objects
    .filter((row) => row.type === "table")
    .map((row) => row.name)
    .sort();
  const actualIndexes = objects
    .filter((row) => row.type === "index")
    .map((row) => row.name)
    .sort();
  const views = objects.filter((row) => row.type === "view");
  const triggers = objects.filter((row) => row.type === "trigger");

  const issues: string[] = [];
  if (!sameStrings(actualTables, [...expectedTables].sort())) {
    issues.push(
      `tables are (${actualTables.join(",")}), expected (${[...expectedTables].sort().join(",")})`,
    );
  }
  if (!sameStrings(actualIndexes, [...expectedIndexes].sort())) {
    issues.push(
      `explicit indexes are (${actualIndexes.join(",")}), expected (${[...expectedIndexes].sort().join(",")})`,
    );
  }
  if (views.length > 0) {
    issues.push(`unexpected views: ${views.map((row) => row.name).join(",")}`);
  }
  if (triggers.length > 0) {
    issues.push(
      `unexpected triggers: ${triggers.map((row) => row.name).join(",")}`,
    );
  }
  return issues;
}

function validateSqlDefinitions(
  db: Database.Database,
  expected: Record<string, string>,
  type: "table" | "index",
  issues: string[],
): void {
  for (const [name, sql] of Object.entries(expected)) {
    const row = db
      .prepare(
        "SELECT tbl_name, sql FROM sqlite_master WHERE type = ? AND name = ?",
      )
      .get(type, name) as { tbl_name: string; sql: string | null } | undefined;
    if (!row || normalizeSql(row.sql ?? "") !== normalizeSql(sql)) {
      issues.push(`${name} SQL does not match the required definition`);
    }
  }
}

function validateColumnsAndKeys(
  db: Database.Database,
  expectedColumns: Record<string, string[]>,
  expectedKeys: Record<string, string[]>,
  issues: string[],
): void {
  for (const [table, columns] of Object.entries(expectedColumns)) {
    const info = tableInfo(db, table);
    if (
      !sameStrings(
        info.map((row) => row.name),
        columns,
      )
    ) {
      issues.push(`${table} columns do not match the required order`);
    }
    const keys = info
      .filter((row) => row.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((row) => row.name);
    if (!sameStrings(keys, expectedKeys[table] ?? [])) {
      issues.push(`${table} primary key does not match the required key`);
    }
  }
}

function validateGuildForeignKey(
  db: Database.Database,
  table: string,
  issues: string[],
): void {
  const rows = db
    .prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`)
    .all() as ForeignKeyRow[];
  if (
    rows.length !== 1 ||
    rows[0]?.table !== "guilds" ||
    rows[0]?.from !== "guild_id" ||
    rows[0]?.to !== "guild_id" ||
    rows[0]?.on_delete.toUpperCase() !== "CASCADE"
  ) {
    issues.push(`${table} must cascade from guilds(guild_id)`);
  }
}

function validateDatabaseHealth(db: Database.Database, issues: string[]): void {
  const integrity = databaseIntegrityCheck(db);
  if (integrity.toLowerCase() !== "ok") {
    issues.push(`integrity_check failed: ${integrity}`);
  }
  const foreignKeyViolations = db.pragma("foreign_key_check") as unknown[];
  if (foreignKeyViolations.length > 0) {
    issues.push("foreign_key_check reported violations");
  }
}

function getSchemaObjects(db: Database.Database): SchemaObjectRow[] {
  return db
    .prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
         AND type IN ('table', 'index', 'view', 'trigger')
       ORDER BY type, name`,
    )
    .all() as SchemaObjectRow[];
}

function tableInfo(db: Database.Database, table: string): TableInfoRow[] {
  return db
    .prepare(`PRAGMA table_xinfo(${quoteIdentifier(table)})`)
    .all() as TableInfoRow[];
}

function normalizeSql(value: string): string {
  return value
    .replaceAll(/["'`\[\]]/g, "")
    .replaceAll(/\s+/g, " ")
    .replaceAll(/\s*([(),])\s*/g, "$1")
    .replace(/;$/, "")
    .trim()
    .toLowerCase();
}

function sameStrings(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
