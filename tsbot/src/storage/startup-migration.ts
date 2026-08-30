import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { backupDatabase } from "./backup.js";
import { migrateDatabase, validateDatabaseFile } from "./migration.js";
import {
  databaseIntegrityCheck,
  detectDatabaseSchema,
  type DatabaseSchemaKind,
} from "./schema.js";

type LegacySchema =
  | "legacy-v2"
  | "legacy-v3"
  | "legacy-v4"
  | "legacy-v5"
  | "legacy-v6"
  | "legacy-v7"
  | "legacy-v8"
  | "legacy-v9"
  | "legacy-v10";

const LEGACY_SCHEMA_VERSIONS: Record<
  LegacySchema,
  2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10
> = {
  "legacy-v2": 2,
  "legacy-v3": 3,
  "legacy-v4": 4,
  "legacy-v5": 5,
  "legacy-v6": 6,
  "legacy-v7": 7,
  "legacy-v8": 8,
  "legacy-v9": 9,
  "legacy-v10": 10,
};

export interface StartupMigrationOptions {
  dbFile: string;
  backupDirectory?: string;
  now?: () => Date;
}

export interface StartupMigrationResult {
  status: "skipped" | "already-current" | "migrated";
  schema: DatabaseSchemaKind;
  backupFile: string | null;
  fromSchema: LegacySchema | "current-v11" | "empty" | null;
}

/**
 * Prepares a packaged Windows database before the Discord runtime opens it.
 * Legacy databases are never changed until a validated SQLite-aware backup and
 * a complete dry-run have succeeded. The regular BotStorage startup path stays
 * strict; this helper is invoked only by the self-contained Windows launcher.
 */
export async function ensureDatabaseCurrent(
  options: StartupMigrationOptions,
): Promise<StartupMigrationResult> {
  if (options.dbFile === ":memory:" || !fs.existsSync(options.dbFile)) {
    return {
      status: "skipped",
      schema: "empty",
      backupFile: null,
      fromSchema: null,
    };
  }

  const schema = inspectExistingDatabase(options.dbFile);
  if (schema === "empty") {
    return {
      status: "skipped",
      schema,
      backupFile: null,
      fromSchema: "empty",
    };
  }
  if (schema === "current-v11") {
    return {
      status: "already-current",
      schema,
      backupFile: null,
      fromSchema: "current-v11",
    };
  }
  if (schema === "legacy-v1") {
    throw new Error(
      "Database schema v1 cannot be upgraded by this executable. Upgrade it to schema v2 with the final 4.x release first.",
    );
  }
  if (!isLegacySchema(schema)) {
    throw new Error(
      "Database schema is unknown or incomplete; automatic startup migration refused without modifying it.",
    );
  }

  const sourceVersion = LEGACY_SCHEMA_VERSIONS[schema];
  const backupFile = chooseBackupFile(
    options.dbFile,
    options.backupDirectory,
    sourceVersion,
    options.now ?? (() => new Date()),
  );

  await backupDatabase({
    dbFile: options.dbFile,
    outputFile: backupFile,
    expect: sourceVersion,
  });

  const migrationNow = (options.now ?? (() => new Date()))().toISOString();
  migrateDatabase({
    dbFile: options.dbFile,
    dryRun: true,
    now: () => migrationNow,
  });
  const migration = migrateDatabase({
    dbFile: options.dbFile,
    now: () => migrationNow,
  });
  validateDatabaseFile(options.dbFile, { expect: 11 });

  return {
    status: migration.status === "migrated" ? "migrated" : "already-current",
    schema: "current-v11",
    backupFile,
    fromSchema: schema,
  };
}

function inspectExistingDatabase(dbFile: string): DatabaseSchemaKind {
  const db = new Database(dbFile, {
    readonly: true,
    fileMustExist: true,
    timeout: 5_000,
  });
  db.pragma("foreign_keys = ON");
  try {
    const integrity = databaseIntegrityCheck(db);
    if (integrity.toLowerCase() !== "ok") {
      throw new Error(`Database integrity check failed: ${integrity}`);
    }
    const foreignKeyViolations = (db.pragma("foreign_key_check") as unknown[])
      .length;
    if (foreignKeyViolations > 0) {
      throw new Error(
        `Database foreign-key check reported ${foreignKeyViolations} violation(s)`,
      );
    }
    return detectDatabaseSchema(db);
  } finally {
    db.close();
  }
}

function isLegacySchema(schema: DatabaseSchemaKind): schema is LegacySchema {
  return schema in LEGACY_SCHEMA_VERSIONS;
}

function chooseBackupFile(
  dbFile: string,
  configuredDirectory: string | undefined,
  sourceVersion: number,
  now: () => Date,
): string {
  const source = path.resolve(dbFile);
  const directory = path.resolve(
    configuredDirectory ?? path.join(path.dirname(source), "backups"),
  );
  fs.mkdirSync(directory, { recursive: true });

  const timestamp = now()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const baseName = path.basename(source, path.extname(source));
  const stem = `${baseName}-pre-schema11-schema${sourceVersion}-${timestamp}`;
  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const candidate = path.join(
      directory,
      `${stem}${suffix === 0 ? "" : `-${suffix}`}.db`,
    );
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Unable to choose a new backup filename in ${directory}`);
}
