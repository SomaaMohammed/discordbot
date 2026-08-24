import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { validateDatabaseFile } from "./migration.js";
import type { DatabaseSchemaKind } from "./schema.js";

export interface BackupOptions {
  dbFile: string;
  outputFile: string;
  expect: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
}

export interface BackupResult {
  schema: DatabaseSchemaKind;
  schemaVersion: number;
  integrity: string;
  foreignKeyViolations: number;
  bytes: number;
}

/** Creates a new SQLite-aware backup and validates the copied database. */
export async function backupDatabase(
  options: BackupOptions,
): Promise<BackupResult> {
  const source = path.resolve(options.dbFile);
  const destination = path.resolve(options.outputFile);
  if (
    source.toLocaleLowerCase("en-US") === destination.toLocaleLowerCase("en-US")
  ) {
    throw new Error("Backup destination must differ from the source database");
  }
  if (fs.existsSync(destination)) {
    throw new Error("Backup destination already exists");
  }

  validateDatabaseFile(source, { expect: options.expect });
  const reservation = fs.openSync(destination, "wx", 0o600);
  fs.closeSync(reservation);
  let completed = false;
  try {
    const db = new Database(source, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      await db.backup(destination);
    } finally {
      db.close();
    }
    const validation = validateDatabaseFile(destination, {
      expect: options.expect,
    });
    if (validation.schemaVersion === null) {
      throw new Error("Backup validation did not return a schema version");
    }
    const result: BackupResult = {
      schema: validation.schema,
      schemaVersion: validation.schemaVersion,
      integrity: validation.integrity,
      foreignKeyViolations: validation.foreignKeyViolations,
      bytes: fs.statSync(destination).size,
    };
    completed = true;
    return result;
  } finally {
    if (!completed && fs.existsSync(destination)) {
      fs.unlinkSync(destination);
    }
  }
}
