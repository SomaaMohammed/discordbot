import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "./database.js";
import { validateDatabaseFile } from "./migration.js";
import type { DatabaseSchemaKind } from "./schema.js";
import {
  assertPathConfinedToDirectory,
  assertPathsVacant,
  assertSameRegularFile,
  inspectRegularFile,
  inspectTrustedDirectory,
  recheckTrustedDirectory,
  sameIdentity,
  samePath,
  unlinkVerifiedFile,
  type FileIdentity,
} from "./filesystem-safety.js";
import { decodePragmaInteger } from "./row-decoder.js";
import { recordSqliteOperationalEvent } from "./telemetry.js";

export interface BackupOptions {
  dbFile: string;
  outputFile: string;
  expect: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
}

export interface BackupResult {
  schema: DatabaseSchemaKind;
  schemaVersion: number;
  integrity: string;
  foreignKeyViolations: number;
  bytes: number;
  snapshotDurationMs: number;
  totalDurationMs: number;
  concurrentWritesObserved: boolean;
  walBytes: number;
}

/**
 * Creates a transactionally consistent SQLite backup, validates it, and only
 * then publishes it atomically at the requested destination.
 */
export async function backupDatabase(
  options: BackupOptions,
): Promise<BackupResult> {
  const startedAt = performance.now();
  let detailedTelemetry = false;
  try {
    return await performBackupDatabase(options, () => {
      detailedTelemetry = true;
    });
  } catch (error) {
    if (!detailedTelemetry) {
      recordSqliteOperationalEvent({
        event: "backup",
        outcome: "failed",
        snapshotDurationMs: 0,
        totalDurationMs: performance.now() - startedAt,
        concurrentWritesObserved: false,
        backupBytes: 0,
        walBytes: 0,
      });
    }
    throw error;
  }
}

async function performBackupDatabase(
  options: BackupOptions,
  onDetailedTelemetry: () => void,
): Promise<BackupResult> {
  const totalStartedAt = performance.now();
  const source = path.resolve(options.dbFile);
  const destination = path.resolve(options.outputFile);
  if (samePath(source, destination)) {
    throw new Error("Backup destination must differ from the source database");
  }
  const reservedDestinationPaths = [
    destination,
    `${destination}-wal`,
    `${destination}-shm`,
    `${destination}-journal`,
  ];
  const destinationDirectory = path.dirname(destination);
  const trustedDirectory = inspectTrustedDirectory(
    destinationDirectory,
    "Backup destination directory",
  );
  assertPathConfinedToDirectory(
    trustedDirectory,
    destination,
    "Backup destination",
  );
  assertPathsVacant(
    reservedDestinationPaths,
    "Backup destination or SQLite sidecar",
  );
  validateDatabaseFile(source, { expect: options.expect });

  const temporary = path.join(
    destinationDirectory,
    `.${path.basename(destination)}.${process.pid}.${randomUUID()}.partial`,
  );
  assertPathsVacant(
    [temporary, `${temporary}-wal`, `${temporary}-shm`, `${temporary}-journal`],
    "Temporary backup path or SQLite sidecar",
  );
  let published = false;
  let finalValidated = false;
  let snapshotDurationMs = 0;
  let concurrentWritesObserved = false;
  let backupBytes = 0;
  let walBytes = safeRegularFileSize(`${source}-wal`);
  const ownedArtifacts = new Map<string, FileIdentity>();
  const temporaryArtifacts = [
    temporary,
    `${temporary}-wal`,
    `${temporary}-shm`,
    `${temporary}-journal`,
  ];
  onDetailedTelemetry();
  try {
    const db = new Database(source, {
      readonly: true,
      fileMustExist: true,
      timeout: 30_000,
    });
    try {
      // SQLite's VACUUM INTO takes a consistent snapshot even in WAL mode and
      // binds the destination instead of interpolating a filesystem path.
      const dataVersionBefore = readDataVersion(db);
      const startedAt = performance.now();
      db.vacuumInto(temporary);
      // Record the output identity immediately after SQLite returns ownership.
      // Never infer ownership later in a catch block: another local process may
      // have created or replaced a path after the failing operation.
      ownedArtifacts.set(
        temporary,
        inspectRegularFile(temporary, "SQLite backup output"),
      );
      snapshotDurationMs = performance.now() - startedAt;
      concurrentWritesObserved = readDataVersion(db) !== dataVersionBefore;
    } finally {
      db.close();
    }

    fs.chmodSync(temporary, 0o600);
    const temporaryIdentity = inspectRegularFile(
      temporary,
      "SQLite backup output",
    );
    assertSameRegularFile(
      temporary,
      ownedArtifacts.get(temporary)!,
      "SQLite backup output",
    );
    flushFile(temporary);
    const temporaryValidation = validateDatabaseFile(temporary, {
      expect: options.expect,
    });
    if (temporaryValidation.schemaVersion === null) {
      throw new Error("Backup validation did not return a schema version");
    }

    // The temporary file is adjacent to the destination. Creating a hard link
    // is an atomic, no-clobber publication on supported production filesystems.
    // It prevents a concurrent destination creator from being overwritten.
    recheckTrustedDirectory(trustedDirectory, "Backup destination directory");
    assertPathsVacant(
      reservedDestinationPaths,
      "Backup destination or SQLite sidecar",
    );
    assertSameRegularFile(
      temporary,
      temporaryIdentity,
      "Validated temporary backup",
    );
    try {
      fs.linkSync(temporary, destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EXDEV" || code === "ENOTSUP") {
        throw new Error(
          "Atomic backup publication requires hard-link support in a trusted local destination directory",
          { cause: error },
        );
      }
      throw error;
    }
    published = true;
    ownedArtifacts.set(destination, temporaryIdentity);
    const destinationIdentity = inspectRegularFile(
      destination,
      "Published backup",
    );
    if (!sameIdentity(destinationIdentity, temporaryIdentity)) {
      throw new Error("Published backup does not identify the validated file");
    }
    ownedArtifacts.set(destination, destinationIdentity);
    flushDirectory(destinationDirectory);

    const validation = validateDatabaseFile(destination, {
      expect: options.expect,
    });
    if (validation.schemaVersion === null) {
      throw new Error(
        "Published backup validation did not return a schema version",
      );
    }
    finalValidated = true;

    backupBytes = fs.statSync(destination).size;
    walBytes = Math.max(walBytes, safeRegularFileSize(`${source}-wal`));
    const totalDurationMs = performance.now() - totalStartedAt;
    const result = {
      schema: validation.schema,
      schemaVersion: validation.schemaVersion,
      integrity: validation.integrity,
      foreignKeyViolations: validation.foreignKeyViolations,
      bytes: backupBytes,
      snapshotDurationMs,
      totalDurationMs,
      concurrentWritesObserved,
      walBytes,
    };
    const cleanupErrors = cleanupOwnedArtifacts(
      ownedArtifacts,
      new Set([destination]),
    );
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        `Backup was published and validated, but temporary-file cleanup was incomplete: ${temporary}`,
      );
    }
    flushDirectory(destinationDirectory);
    recordSqliteOperationalEvent({
      event: "backup",
      outcome: "published",
      snapshotDurationMs,
      totalDurationMs,
      concurrentWritesObserved,
      backupBytes,
      walBytes,
    });
    return result;
  } catch (error) {
    const keep =
      published && finalValidated ? new Set([destination]) : new Set<string>();
    const cleanupErrors = cleanupOwnedArtifacts(ownedArtifacts, keep);
    const survivingPaths = [
      ...new Set([
        ...ownedArtifacts.keys(),
        ...temporaryArtifacts.filter(
          (candidate) => !ownedArtifacts.has(candidate),
        ),
      ]),
    ].filter((candidate) => !keep.has(candidate) && fs.existsSync(candidate));
    recordSqliteOperationalEvent({
      event: "backup",
      outcome: "failed",
      snapshotDurationMs,
      totalDurationMs: performance.now() - totalStartedAt,
      concurrentWritesObserved,
      backupBytes,
      walBytes,
    });
    if (cleanupErrors.length > 0 || survivingPaths.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        `Backup failed and cleanup was incomplete; inspect: ${survivingPaths.join(", ") || "unknown path"}`,
      );
    }
    throw error;
  }
}

function readDataVersion(db: Database): number {
  return decodePragmaInteger(
    db.pragma("data_version")[0],
    "data_version",
    "PRAGMA data_version",
  );
}

function flushFile(fileName: string): void {
  // Windows requires a writable handle for FlushFileBuffers (fsync).
  const descriptor = fs.openSync(fileName, "r+");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function flushDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function cleanupOwnedArtifacts(
  ownedArtifacts: ReadonlyMap<string, FileIdentity>,
  keep: ReadonlySet<string>,
): Error[] {
  const errors: Error[] = [];
  for (const [fileName, identity] of ownedArtifacts) {
    if (keep.has(fileName)) continue;
    try {
      unlinkVerifiedFile(fileName, identity);
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  return errors;
}

function safeRegularFileSize(fileName: string): number {
  try {
    const metadata = fs.lstatSync(fileName);
    return metadata.isFile() && !metadata.isSymbolicLink() ? metadata.size : 0;
  } catch {
    return 0;
  }
}
