import type Database from "better-sqlite3";

export const CURRENT_SCHEMA_VERSION = 2;

export type DatabaseSchemaKind =
  "empty" | "legacy-v1" | "current-v2" | "unknown";

export const SCHEMA_MIGRATIONS_TABLE_SQL = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
)
`;

export const GUILDS_TABLE_SQL = `
CREATE TABLE guilds (
  guild_id TEXT NOT NULL PRIMARY KEY,
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
  settings_version INTEGER NOT NULL,
  settings_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
)
`;

export const KV_TABLE_SQL = `
CREATE TABLE kv (
  guild_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, key),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
)
`;

export const POSTS_TABLE_SQL = `
CREATE TABLE posts (
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
)
`;

export const ANSWERS_TABLE_SQL = `
CREATE TABLE answers (
  guild_id TEXT NOT NULL,
  question_message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  answer_message_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, question_message_id, user_id),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
)
`;

export const METRICS_TABLE_SQL = `
CREATE TABLE metrics (
  guild_id TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  metric_value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, metric_key),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
)
`;

export const ANON_COOLDOWNS_TABLE_SQL = `
CREATE TABLE anon_cooldowns (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  last_answer_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, user_id),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
)
`;

export const POSTS_GUILD_CLOSED_POSTED_AT_INDEX_SQL = `
CREATE INDEX idx_posts_guild_closed_posted_at
ON posts (guild_id, closed, julianday(posted_at))
`;

export const POSTS_GUILD_POSTED_AT_INDEX_SQL = `
CREATE INDEX idx_posts_guild_posted_at
ON posts (guild_id, julianday(posted_at))
`;

export const ANSWERS_GUILD_QUESTION_CREATED_INDEX_SQL = `
CREATE INDEX idx_answers_guild_question_created
ON answers (guild_id, question_message_id, created_at)
`;

export const ANSWERS_GUILD_MESSAGE_ID_INDEX_SQL = `
CREATE INDEX idx_answers_guild_message_id
ON answers (guild_id, answer_message_id)
`;

export const ANSWERS_GUILD_CREATED_AT_INDEX_SQL = `
CREATE INDEX idx_answers_guild_created_at
ON answers (guild_id, julianday(created_at))
`;

export const GUILDS_ENABLED_LEFT_AT_INDEX_SQL = `
CREATE INDEX idx_guilds_enabled_left_at
ON guilds (enabled, left_at)
`;

const EXPECTED_V2_TABLE_SQL = {
  schema_migrations: SCHEMA_MIGRATIONS_TABLE_SQL,
  guilds: GUILDS_TABLE_SQL,
  guild_settings: GUILD_SETTINGS_TABLE_SQL,
  kv: KV_TABLE_SQL,
  posts: POSTS_TABLE_SQL,
  answers: ANSWERS_TABLE_SQL,
  metrics: METRICS_TABLE_SQL,
  anon_cooldowns: ANON_COOLDOWNS_TABLE_SQL,
} as const;

const V2_TABLE_SQL = Object.values(EXPECTED_V2_TABLE_SQL);

const V2_INDEX_SQL = [
  POSTS_GUILD_CLOSED_POSTED_AT_INDEX_SQL,
  POSTS_GUILD_POSTED_AT_INDEX_SQL,
  ANSWERS_GUILD_QUESTION_CREATED_INDEX_SQL,
  ANSWERS_GUILD_MESSAGE_ID_INDEX_SQL,
  ANSWERS_GUILD_CREATED_AT_INDEX_SQL,
  GUILDS_ENABLED_LEFT_AT_INDEX_SQL,
] as const;

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
  ...V1_TABLE_NAMES,
] as const;

const EXPECTED_PRIMARY_KEYS: Record<string, string[]> = {
  schema_migrations: ["version"],
  guilds: ["guild_id"],
  guild_settings: ["guild_id"],
  kv: ["guild_id", "key"],
  posts: ["guild_id", "message_id"],
  answers: ["guild_id", "question_message_id", "user_id"],
  metrics: ["guild_id", "metric_key"],
  anon_cooldowns: ["guild_id", "user_id"],
};

interface ExpectedColumn {
  name: string;
  type: "INTEGER" | "TEXT";
  notNull: boolean;
}

const integerColumn = (name: string, notNull = true): ExpectedColumn => ({
  name,
  type: "INTEGER",
  notNull,
});

const textColumn = (name: string, notNull = true): ExpectedColumn => ({
  name,
  type: "TEXT",
  notNull,
});

const EXPECTED_V2_COLUMNS: Record<string, ExpectedColumn[]> = {
  schema_migrations: [
    // INTEGER PRIMARY KEY is intrinsically non-null even though table_info
    // reports notnull=0 unless NOT NULL is written explicitly.
    integerColumn("version", false),
    textColumn("applied_at"),
  ],
  guilds: [
    textColumn("guild_id"),
    integerColumn("enabled"),
    textColumn("name", false),
    textColumn("joined_at", false),
    textColumn("left_at", false),
    textColumn("created_at"),
    textColumn("updated_at"),
  ],
  guild_settings: [
    textColumn("guild_id"),
    integerColumn("settings_version"),
    textColumn("settings_json"),
    textColumn("updated_at"),
  ],
  kv: [
    textColumn("guild_id"),
    textColumn("key"),
    textColumn("value"),
    textColumn("updated_at"),
  ],
  posts: [
    textColumn("guild_id"),
    textColumn("message_id"),
    textColumn("thread_id", false),
    textColumn("channel_id"),
    textColumn("category"),
    textColumn("question"),
    textColumn("posted_at"),
    integerColumn("close_after_hours"),
    integerColumn("closed"),
    textColumn("closed_at", false),
    textColumn("close_reason", false),
  ],
  answers: [
    textColumn("guild_id"),
    textColumn("question_message_id"),
    textColumn("user_id"),
    textColumn("answer_message_id"),
    textColumn("created_at"),
  ],
  metrics: [
    textColumn("guild_id"),
    textColumn("metric_key"),
    textColumn("metric_value"),
    textColumn("updated_at"),
  ],
  anon_cooldowns: [
    textColumn("guild_id"),
    textColumn("user_id"),
    textColumn("last_answer_at"),
  ],
};

const EXPECTED_INDEXES: Record<
  string,
  { table: string; columns: Array<string | null>; sql: string }
> = {
  idx_posts_guild_closed_posted_at: {
    table: "posts",
    columns: ["guild_id", "closed", null],
    sql: POSTS_GUILD_CLOSED_POSTED_AT_INDEX_SQL,
  },
  idx_posts_guild_posted_at: {
    table: "posts",
    columns: ["guild_id", null],
    sql: POSTS_GUILD_POSTED_AT_INDEX_SQL,
  },
  idx_answers_guild_question_created: {
    table: "answers",
    columns: ["guild_id", "question_message_id", "created_at"],
    sql: ANSWERS_GUILD_QUESTION_CREATED_INDEX_SQL,
  },
  idx_answers_guild_message_id: {
    table: "answers",
    columns: ["guild_id", "answer_message_id"],
    sql: ANSWERS_GUILD_MESSAGE_ID_INDEX_SQL,
  },
  idx_answers_guild_created_at: {
    table: "answers",
    columns: ["guild_id", null],
    sql: ANSWERS_GUILD_CREATED_AT_INDEX_SQL,
  },
  idx_guilds_enabled_left_at: {
    table: "guilds",
    columns: ["enabled", "left_at"],
    sql: GUILDS_ENABLED_LEFT_AT_INDEX_SQL,
  },
};

interface ExpectedLegacyColumn extends ExpectedColumn {
  primaryKeyPosition: number;
  defaultValue: string | null;
}

const legacyColumn = (
  name: string,
  type: ExpectedColumn["type"],
  options: {
    notNull?: boolean;
    primaryKeyPosition?: number;
    defaultValue?: string | null;
  } = {},
): ExpectedLegacyColumn => ({
  name,
  type,
  notNull: options.notNull ?? false,
  primaryKeyPosition: options.primaryKeyPosition ?? 0,
  defaultValue: options.defaultValue ?? null,
});

const LEGACY_COLUMNS: Record<string, ExpectedLegacyColumn[]> = {
  kv: [
    legacyColumn("key", "TEXT", { primaryKeyPosition: 1 }),
    legacyColumn("value", "TEXT", { notNull: true }),
    legacyColumn("updated_at", "TEXT", { notNull: true }),
  ],
  posts: [
    legacyColumn("message_id", "TEXT", { primaryKeyPosition: 1 }),
    legacyColumn("thread_id", "TEXT"),
    legacyColumn("channel_id", "TEXT", { notNull: true }),
    legacyColumn("category", "TEXT", { notNull: true }),
    legacyColumn("question", "TEXT", { notNull: true }),
    legacyColumn("posted_at", "TEXT", { notNull: true }),
    legacyColumn("close_after_hours", "INTEGER", {
      notNull: true,
      defaultValue: "24",
    }),
    legacyColumn("closed", "INTEGER", {
      notNull: true,
      defaultValue: "0",
    }),
    legacyColumn("closed_at", "TEXT"),
    legacyColumn("close_reason", "TEXT"),
  ],
  answers: [
    legacyColumn("question_message_id", "TEXT", {
      notNull: true,
      primaryKeyPosition: 1,
    }),
    legacyColumn("user_id", "TEXT", {
      notNull: true,
      primaryKeyPosition: 2,
    }),
    legacyColumn("answer_message_id", "TEXT", { notNull: true }),
    legacyColumn("created_at", "TEXT", { notNull: true }),
  ],
  metrics: [
    legacyColumn("metric_key", "TEXT", { primaryKeyPosition: 1 }),
    legacyColumn("metric_value", "TEXT", { notNull: true }),
    legacyColumn("updated_at", "TEXT", { notNull: true }),
  ],
  anon_cooldowns: [
    legacyColumn("user_id", "TEXT", { primaryKeyPosition: 1 }),
    legacyColumn("last_answer_at", "TEXT", { notNull: true }),
  ],
};

const LEGACY_INDEXES: Record<
  string,
  { table: string; columns: string[]; sql: string }
> = {
  idx_posts_closed_posted_at: {
    table: "posts",
    columns: ["closed", "posted_at"],
    sql: `CREATE INDEX idx_posts_closed_posted_at
          ON posts (closed, posted_at)`,
  },
  idx_answers_question_created: {
    table: "answers",
    columns: ["question_message_id", "created_at"],
    sql: `CREATE INDEX idx_answers_question_created
          ON answers (question_message_id, created_at)`,
  },
  idx_answers_message_id: {
    table: "answers",
    columns: ["answer_message_id"],
    sql: `CREATE INDEX idx_answers_message_id
          ON answers (answer_message_id)`,
  },
};

interface TableInfoRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
  hidden: number;
}

interface ForeignKeyRow {
  table: string;
  from: string;
  to: string;
  on_delete: string;
}

interface IndexInfoRow {
  name: string | null;
  seqno: number;
}

interface IndexListRow {
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

interface IndexDefinitionRow {
  tbl_name: string;
  sql: string | null;
}

export function createV2Objects(db: Database.Database): void {
  for (const sql of V2_TABLE_SQL) {
    db.exec(sql);
  }
  for (const sql of V2_INDEX_SQL) {
    db.exec(sql);
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

export function initializeV2Schema(
  db: Database.Database,
  appliedAt: string,
): void {
  const initialize = db.transaction(() => {
    createV2Objects(db);
    recordCurrentSchemaVersion(db, appliedAt);
    const issues = validateV2Schema(db);
    if (issues.length > 0) {
      throw new Error(`Failed to initialize schema: ${issues.join("; ")}`);
    }
  });
  initialize.immediate();
}

export function getUserTableNames(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  return rows.map((row) => String(row.name));
}

export function detectDatabaseSchema(
  db: Database.Database,
): DatabaseSchemaKind {
  const tables = getUserTableNames(db);
  if (tables.length === 0) {
    return "empty";
  }

  if (tables.includes("schema_migrations")) {
    return validateV2Schema(db).length === 0 ? "current-v2" : "unknown";
  }

  const expected = [...V1_TABLE_NAMES].sort();
  if (
    tables.length !== expected.length ||
    tables.some((name, index) => name !== expected[index])
  ) {
    return "unknown";
  }

  for (const table of V1_TABLE_NAMES) {
    const info = getTableInfo(db, table);
    if (!sameLegacyColumns(info, LEGACY_COLUMNS[table] ?? [])) {
      return "unknown";
    }
  }

  for (const [indexName, expected] of Object.entries(LEGACY_INDEXES)) {
    const indexRows = db
      .prepare(`PRAGMA index_list(${quoteIdentifier(expected.table)})`)
      .all() as IndexListRow[];
    const index = indexRows.find((row) => row.name === indexName);
    if (
      !index ||
      Boolean(index.unique) ||
      index.origin !== "c" ||
      Boolean(index.partial)
    ) {
      return "unknown";
    }
    const definition = db
      .prepare(
        `SELECT tbl_name, sql FROM sqlite_master
         WHERE type = 'index' AND name = ?`,
      )
      .get(indexName) as IndexDefinitionRow | undefined;
    if (
      !definition ||
      definition.tbl_name !== expected.table ||
      normalizeLegacyIndexSql(definition.sql ?? "") !==
        normalizeLegacyIndexSql(expected.sql)
    ) {
      return "unknown";
    }
    const columns = (
      db
        .prepare(`PRAGMA index_info(${quoteIdentifier(indexName)})`)
        .all() as IndexInfoRow[]
    )
      .sort((left, right) => left.seqno - right.seqno)
      .map((row) => row.name);
    if (!sameNullableStrings(columns, expected.columns)) {
      return "unknown";
    }
  }
  return "legacy-v1";
}

export function validateV2Schema(db: Database.Database): string[] {
  const issues: string[] = [];
  const tables = new Set(getUserTableNames(db));

  for (const table of V2_TABLE_NAMES) {
    if (!tables.has(table)) {
      issues.push(`missing table ${table}`);
    }
  }
  if (issues.length > 0) {
    return issues;
  }

  for (const [table, expectedSql] of Object.entries(EXPECTED_V2_TABLE_SQL)) {
    const definition = db
      .prepare(
        `SELECT tbl_name, sql FROM sqlite_master
         WHERE type = 'table' AND name = ?`,
      )
      .get(table) as IndexDefinitionRow | undefined;
    if (
      !definition ||
      definition.tbl_name !== table ||
      normalizeSql(definition.sql ?? "") !== normalizeSql(expectedSql)
    ) {
      issues.push(`${table} SQL does not match the required definition`);
    }
  }

  for (const [table, expectedKey] of Object.entries(EXPECTED_PRIMARY_KEYS)) {
    const tableInfo = getTableInfo(db, table);
    const actualColumns = tableInfo.map((column) => column.name);
    const expectedColumns = EXPECTED_V2_COLUMNS[table] ?? [];
    const expectedColumnNames = expectedColumns.map((column) => column.name);
    if (!sameStrings(actualColumns, expectedColumnNames)) {
      issues.push(
        `${table} columns are (${actualColumns.join(",")}), expected (${expectedColumnNames.join(",")})`,
      );
    }
    for (const expectedColumn of expectedColumns) {
      const actualColumn = tableInfo.find(
        (column) => column.name === expectedColumn.name,
      );
      if (!actualColumn) {
        continue;
      }
      const actualType = String(actualColumn.type).trim().toUpperCase();
      if (actualType !== expectedColumn.type) {
        issues.push(
          `${table}.${expectedColumn.name} type is ${actualType || "untyped"}, expected ${expectedColumn.type}`,
        );
      }
      if (Boolean(actualColumn.notnull) !== expectedColumn.notNull) {
        issues.push(
          `${table}.${expectedColumn.name} NOT NULL is ${Boolean(actualColumn.notnull)}, expected ${expectedColumn.notNull}`,
        );
      }
    }
    const actualKey = primaryKeyColumns(tableInfo);
    if (!sameStrings(actualKey, expectedKey)) {
      issues.push(
        `${table} primary key is (${actualKey.join(",")}), expected (${expectedKey.join(",")})`,
      );
    }
  }

  for (const table of ["guild_settings", ...V1_TABLE_NAMES]) {
    const foreignKeys = db
      .prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`)
      .all() as ForeignKeyRow[];
    const guildForeignKey = foreignKeys.find(
      (row) =>
        row.table === "guilds" &&
        row.from === "guild_id" &&
        row.to === "guild_id" &&
        row.on_delete.toUpperCase() === "CASCADE",
    );
    if (!guildForeignKey) {
      issues.push(
        `${table} is missing its guilds(guild_id) cascade foreign key`,
      );
    }
  }

  for (const [indexName, expected] of Object.entries(EXPECTED_INDEXES)) {
    const indexRows = db
      .prepare(`PRAGMA index_list(${quoteIdentifier(expected.table)})`)
      .all() as IndexListRow[];
    if (!indexRows.some((row) => row.name === indexName)) {
      issues.push(`missing index ${indexName}`);
      continue;
    }
    const definition = db
      .prepare(
        `SELECT tbl_name, sql FROM sqlite_master
         WHERE type = 'index' AND name = ?`,
      )
      .get(indexName) as IndexDefinitionRow | undefined;
    if (
      !definition ||
      definition.tbl_name !== expected.table ||
      normalizeSql(definition.sql ?? "") !== normalizeSql(expected.sql)
    ) {
      issues.push(`${indexName} SQL does not match the required definition`);
    }
    const columns = (
      db
        .prepare(`PRAGMA index_info(${quoteIdentifier(indexName)})`)
        .all() as IndexInfoRow[]
    )
      .sort((left, right) => left.seqno - right.seqno)
      .map((row) => row.name);
    if (!sameNullableStrings(columns, expected.columns)) {
      issues.push(
        `${indexName} columns are (${columns.join(",")}), expected (${expected.columns.join(",")})`,
      );
    }
  }

  const versions = db
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all() as Array<{ version: number }>;
  if (
    versions.length === 0 ||
    Number(versions.at(-1)?.version) !== CURRENT_SCHEMA_VERSION ||
    versions.some(
      (row) =>
        !Number.isInteger(row.version) ||
        row.version < 1 ||
        row.version > CURRENT_SCHEMA_VERSION,
    )
  ) {
    issues.push(
      `schema_migrations must end at version ${CURRENT_SCHEMA_VERSION}`,
    );
  }

  const foreignKeyViolations = db.pragma("foreign_key_check") as unknown[];
  if (foreignKeyViolations.length > 0) {
    issues.push("foreign_key_check reported violations");
  }

  return issues;
}

export function countLegacyRows(db: Database.Database): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of V1_TABLE_NAMES) {
    const row = db
      .prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`)
      .get() as { count: number };
    counts[table] = Number(row.count);
  }
  return counts;
}

export function databaseIntegrityCheck(db: Database.Database): string {
  const rows = db.pragma("integrity_check") as Array<{
    integrity_check: string;
  }>;
  return rows.map((row) => String(row.integrity_check)).join("; ");
}

function getTableInfo(db: Database.Database, table: string): TableInfoRow[] {
  return db
    .prepare(`PRAGMA table_xinfo(${quoteIdentifier(table)})`)
    .all() as TableInfoRow[];
}

function primaryKeyColumns(rows: TableInfoRow[]): string[] {
  return rows
    .filter((row) => row.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((row) => row.name);
}

function sameStrings(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameLegacyColumns(
  actual: TableInfoRow[],
  expected: ExpectedLegacyColumn[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((column, index) => {
      const wanted = expected[index];
      return Boolean(
        wanted &&
        column.name === wanted.name &&
        String(column.type).trim().toUpperCase() === wanted.type &&
        Boolean(column.notnull) === wanted.notNull &&
        Number(column.pk) === wanted.primaryKeyPosition &&
        normalizeDefaultValue(column.dflt_value) === wanted.defaultValue &&
        Number(column.hidden) === 0,
      );
    })
  );
}

function normalizeDefaultValue(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value).trim();
}

function sameNullableStrings(
  left: Array<string | null>,
  right: Array<string | null>,
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function normalizeSql(sql: string): string {
  return sql.trim().replace(/;$/, "").replaceAll(/\s+/g, " ").toLowerCase();
}

function normalizeLegacyIndexSql(sql: string): string {
  return normalizeSql(sql).replace(
    /^create index if not exists /,
    "create index ",
  );
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
