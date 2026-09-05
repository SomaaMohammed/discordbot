import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { PACKAGE_VERSION } from "../constants.js";
import { backupDatabase, type BackupResult } from "./backup.js";
import Database from "./database.js";
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
  type TrustedDirectory,
} from "./filesystem-safety.js";
import { validateDatabaseFile } from "./migration.js";
import { countRowSchema, decodeRow } from "./row-decoder.js";

const BACKUP_METADATA_FORMAT = 1 as const;
const BACKUP_NAME_PATTERN =
  /^superior-backup-v11-(\d{8}T\d{9}Z)-([a-f0-9]{32})\.sqlite3$/u;
const MAX_RETENTION = 1_000;
const MAX_METADATA_BYTES = 16 * 1024;

const backupMetadataSchema = z
  .object({
    formatVersion: z.literal(BACKUP_METADATA_FORMAT),
    kind: z.literal("superior-sqlite-backup"),
    fileName: z.string().regex(BACKUP_NAME_PATTERN),
    backupId: z.string().regex(/^[a-f0-9]{32}$/u),
    createdAt: z.string().datetime({ offset: true }),
    schemaVersion: z.literal(11),
    packageVersion: z.string().min(1).max(40),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export type BackupMetadata = z.infer<typeof backupMetadataSchema>;

interface BackupRecord {
  readonly backupFile: string;
  readonly metadataFile: string;
  readonly metadata: BackupMetadata;
  readonly backupIdentity: FileIdentity;
  readonly metadataIdentity: FileIdentity;
}

export interface BackupRotationOptions {
  readonly dbFile: string;
  readonly backupDirectory: string;
  readonly retention: number;
  readonly dryRun?: boolean;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export interface BackupRotationResult {
  readonly command: "backup-rotate";
  readonly status: "completed" | "dry-run";
  readonly currentBackupName: string;
  readonly currentBackupBytes: number;
  readonly restoredGuildRows: number;
  readonly retainedBackupNames: readonly string[];
  readonly deletedBackupNames: readonly string[];
  readonly wouldDeleteBackupNames: readonly string[];
  readonly retention: number;
  readonly snapshotDurationMs: number;
  readonly totalDurationMs: number;
  readonly concurrentWritesObserved: boolean;
  readonly walBytes: number;
}

export async function rotateBackups(
  options: BackupRotationOptions,
): Promise<BackupRotationResult> {
  const retention = normalizeRetention(options.retention);
  const source = path.resolve(options.dbFile);
  const sourceIdentity = inspectSourceDatabase(source);
  const trusted = inspectTrustedDirectory(
    options.backupDirectory,
    "Configured backup directory",
  );
  const createdAt = (options.now ?? (() => new Date()))();
  if (!Number.isFinite(createdAt.getTime())) {
    throw new TypeError("Backup creation time is invalid");
  }
  validateDatabaseFile(source, { expect: 11 });
  assertSourceDatabaseIdentity(source, sourceIdentity);
  const backupId = normalizeBackupId(
    (options.idFactory ?? (() => randomUUID().replaceAll("-", "")))(),
  );
  const backupName = buildBackupName(createdAt, backupId);
  const backupFile = assertPathConfinedToDirectory(
    trusted,
    path.join(trusted.resolvedPath, backupName),
    "Current backup",
  );
  const metadataFile = `${backupFile}.backup.json`;
  assertPathConfinedToDirectory(
    trusted,
    metadataFile,
    "Current backup metadata",
  );
  assertPathsVacant(
    [
      backupFile,
      metadataFile,
      `${backupFile}-wal`,
      `${backupFile}-shm`,
      `${backupFile}-journal`,
    ],
    "Current backup artifact",
  );

  const existing = readBackupRecords(trusted, source, sourceIdentity);
  if (options.dryRun === true) {
    const virtualMetadata: BackupMetadata = {
      formatVersion: BACKUP_METADATA_FORMAT,
      kind: "superior-sqlite-backup",
      fileName: backupName,
      backupId,
      createdAt: createdAt.toISOString(),
      schemaVersion: 11,
      packageVersion: PACKAGE_VERSION,
      bytes: Math.max(1, regularFileSize(source)),
      sha256: "0".repeat(64),
    };
    const plan = planRetention(existing, virtualMetadata, retention);
    return {
      command: "backup-rotate",
      status: "dry-run",
      currentBackupName: backupName,
      currentBackupBytes: 0,
      restoredGuildRows: 0,
      retainedBackupNames: plan.retained,
      deletedBackupNames: [],
      wouldDeleteBackupNames: plan.deleted,
      retention,
      snapshotDurationMs: 0,
      totalDurationMs: 0,
      concurrentWritesObserved: false,
      walBytes: regularFileSize(`${source}-wal`),
    };
  }

  let backupIdentity: FileIdentity | null = null;
  let metadataIdentity: FileIdentity | null = null;
  let metadataPublished = false;
  let backup: BackupResult | null = null;
  try {
    recheckTrustedDirectory(trusted, "Configured backup directory");
    backup = await backupDatabase({
      dbFile: source,
      outputFile: backupFile,
      expect: 11,
    });
    assertSourceDatabaseIdentity(source, sourceIdentity);
    backupIdentity = inspectRegularFile(backupFile, "Current backup");
    const restoredGuildRows = restoreAndVerifyBackup(trusted, backupFile);
    const metadata: BackupMetadata = {
      formatVersion: BACKUP_METADATA_FORMAT,
      kind: "superior-sqlite-backup",
      fileName: backupName,
      backupId,
      createdAt: createdAt.toISOString(),
      schemaVersion: 11,
      packageVersion: PACKAGE_VERSION,
      bytes: backup.bytes,
      sha256: await hashFile(backupFile),
    };
    metadataIdentity = publishMetadata(trusted, metadataFile, metadata);
    metadataPublished = true;

    const current: BackupRecord = {
      backupFile,
      metadataFile,
      metadata,
      backupIdentity,
      metadataIdentity,
    };
    const records = [...existing, current];
    const plan = planRetention(records, metadata, retention);
    const deleted: string[] = [];
    for (const name of plan.deleted) {
      const record = records.find(
        (candidate) => candidate.metadata.fileName === name,
      );
      if (!record || record.metadata.backupId === backupId) {
        throw new Error("Retention attempted to select the current backup");
      }
      await verifyDeletionCandidate(trusted, record, source, sourceIdentity);
      deleteBackupRecord(record);
      deleted.push(name);
    }
    return {
      command: "backup-rotate",
      status: "completed",
      currentBackupName: backupName,
      currentBackupBytes: backup.bytes,
      restoredGuildRows,
      retainedBackupNames: plan.retained,
      deletedBackupNames: deleted,
      wouldDeleteBackupNames: [],
      retention,
      snapshotDurationMs: backup.snapshotDurationMs,
      totalDurationMs: backup.totalDurationMs,
      concurrentWritesObserved: backup.concurrentWritesObserved,
      walBytes: backup.walBytes,
    };
  } catch (error) {
    if (!metadataPublished) {
      const cleanupErrors: Error[] = [];
      for (const [fileName, identity] of [
        [metadataFile, metadataIdentity],
        [backupFile, backupIdentity],
      ] as const) {
        if (!identity) continue;
        try {
          unlinkVerifiedFile(fileName, identity);
        } catch (cleanupError) {
          cleanupErrors.push(
            cleanupError instanceof Error
              ? cleanupError
              : new Error(String(cleanupError)),
          );
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Backup rotation failed and cleanup was incomplete",
        );
      }
    }
    throw error;
  }
}

function readBackupRecords(
  trusted: TrustedDirectory,
  source: string,
  sourceIdentity: FileIdentity,
): BackupRecord[] {
  recheckTrustedDirectory(trusted, "Configured backup directory");
  const entries = fs.readdirSync(trusted.resolvedPath, { withFileTypes: true });
  const names = new Set(entries.map((entry) => entry.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink() || entry.isDirectory()) {
      throw new Error(
        `Backup directory contains an unexpected reparse point or directory: ${entry.name}`,
      );
    }
    if (
      entry.name.startsWith("superior-backup-") &&
      entry.name.endsWith(".sqlite3")
    ) {
      if (!BACKUP_NAME_PATTERN.test(entry.name)) {
        throw new Error(
          `Backup directory contains an unexpected backup path: ${entry.name}`,
        );
      }
      if (!names.has(`${entry.name}.backup.json`)) {
        throw new Error(
          `Managed-looking backup has no validated metadata: ${entry.name}`,
        );
      }
    }
    if (
      entry.name.startsWith("superior-backup-") &&
      entry.name.endsWith(".backup.json")
    ) {
      const backupName = entry.name.slice(0, -".backup.json".length);
      if (!names.has(backupName)) {
        throw new Error(`Backup metadata is orphaned: ${entry.name}`);
      }
    }
  }

  const records: BackupRecord[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".backup.json")) continue;
    const metadataFile = assertPathConfinedToDirectory(
      trusted,
      path.join(trusted.resolvedPath, entry.name),
      "Backup metadata",
    );
    const metadataIdentity = inspectRegularFile(
      metadataFile,
      "Backup metadata",
    );
    const metadata = decodeRow(
      backupMetadataSchema,
      JSON.parse(readBoundedText(metadataFile, MAX_METADATA_BYTES)) as unknown,
      "backup rotation metadata",
    );
    if (`${metadata.fileName}.backup.json` !== entry.name) {
      throw new Error("Backup metadata filename does not match its record");
    }
    const match = BACKUP_NAME_PATTERN.exec(metadata.fileName);
    if (!match || match[2] !== metadata.backupId) {
      throw new Error("Backup metadata identity does not match its filename");
    }
    const backupFile = assertPathConfinedToDirectory(
      trusted,
      path.join(trusted.resolvedPath, metadata.fileName),
      "Managed backup",
    );
    if (samePath(backupFile, source)) {
      throw new Error(
        "The source database must never be a retention candidate",
      );
    }
    const backupIdentity = inspectRegularFile(backupFile, "Managed backup");
    if (sameIdentity(backupIdentity, sourceIdentity)) {
      throw new Error(
        "The source database must never be a retention candidate",
      );
    }
    records.push({
      backupFile,
      metadataFile,
      metadata,
      backupIdentity,
      metadataIdentity,
    });
  }
  return records;
}

function planRetention(
  records: readonly BackupRecord[],
  current: BackupMetadata,
  retention: number,
): { retained: string[]; deleted: string[] };
function planRetention(
  records: readonly BackupRecord[],
  current: BackupMetadata,
  retention: number,
): { retained: string[]; deleted: string[] } {
  const metadata = [
    ...records.map((record) => record.metadata),
    ...(records.some((record) => record.metadata.backupId === current.backupId)
      ? []
      : [current]),
  ];
  const currentRecord = metadata.find(
    (candidate) => candidate.backupId === current.backupId,
  );
  if (!currentRecord) throw new Error("Current backup metadata is missing");
  const others = metadata
    .filter((candidate) => candidate.backupId !== current.backupId)
    .sort(compareBackupMetadata);
  const retained = [currentRecord, ...others.slice(0, retention - 1)]
    .map((candidate) => candidate.fileName)
    .sort();
  const retainedSet = new Set(retained);
  const deleted = metadata
    .filter((candidate) => !retainedSet.has(candidate.fileName))
    .map((candidate) => candidate.fileName)
    .sort();
  return { retained, deleted };
}

function normalizeBackupId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{32}$/u.test(value.toLowerCase())
  ) {
    throw new TypeError("Backup identity must be 32 hexadecimal characters");
  }
  return value.toLowerCase();
}

function compareBackupMetadata(
  left: BackupMetadata,
  right: BackupMetadata,
): number {
  const timeDifference =
    Date.parse(right.createdAt) - Date.parse(left.createdAt);
  if (timeDifference !== 0) return timeDifference;
  return right.backupId.localeCompare(left.backupId);
}

async function verifyDeletionCandidate(
  trusted: TrustedDirectory,
  record: BackupRecord,
  source: string,
  sourceIdentity: FileIdentity,
): Promise<void> {
  recheckTrustedDirectory(trusted, "Configured backup directory");
  assertSourceDatabaseIdentity(source, sourceIdentity);
  if (
    samePath(record.backupFile, source) ||
    sameIdentity(record.backupIdentity, sourceIdentity)
  ) {
    throw new Error("Retention must never delete the source database");
  }
  assertSameRegularFile(
    record.backupFile,
    record.backupIdentity,
    "Retention backup candidate",
  );
  assertSameRegularFile(
    record.metadataFile,
    record.metadataIdentity,
    "Retention metadata candidate",
  );
  const size = fs.statSync(record.backupFile).size;
  const sha256 = await hashFile(record.backupFile);
  if (size !== record.metadata.bytes || sha256 !== record.metadata.sha256) {
    throw new Error(
      "Retention candidate no longer matches its explicit metadata",
    );
  }
  validateDatabaseFile(record.backupFile, { expect: 11 });
}

function deleteBackupRecord(record: BackupRecord): void {
  unlinkVerifiedFile(record.metadataFile, record.metadataIdentity);
  try {
    unlinkVerifiedFile(record.backupFile, record.backupIdentity);
  } catch (error) {
    throw new Error(
      "Retention removed metadata but preserved a backup whose identity changed or could not be deleted",
      { cause: error },
    );
  }
}

function restoreAndVerifyBackup(
  trusted: TrustedDirectory,
  backupFile: string,
): number {
  const restoreFile = assertPathConfinedToDirectory(
    trusted,
    path.join(
      trusted.resolvedPath,
      `.superior-restore-${randomUUID().replaceAll("-", "")}.sqlite3.partial`,
    ),
    "Temporary restore",
  );
  let identity: FileIdentity | null = null;
  let operationError: unknown;
  let guildRows = 0;
  try {
    fs.copyFileSync(backupFile, restoreFile, fs.constants.COPYFILE_EXCL);
    identity = inspectRegularFile(restoreFile, "Temporary restore");
    flushFile(restoreFile);
    validateDatabaseFile(restoreFile, { expect: 11 });
    const database = new Database(restoreFile, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      guildRows = decodeRow(
        countRowSchema,
        database.prepare("SELECT COUNT(*) AS count FROM guilds").get(),
        "restore drill representative guild read",
      ).count;
    } finally {
      database.close();
    }
  } catch (error) {
    operationError = error;
  }
  let cleanupError: unknown;
  if (identity) {
    try {
      unlinkVerifiedFile(restoreFile, identity);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (cleanupError !== undefined) {
    throw new AggregateError(
      operationError === undefined
        ? [cleanupError]
        : [operationError, cleanupError],
      "Restore drill cleanup failed",
    );
  }
  if (operationError !== undefined) throw operationError;
  return guildRows;
}

function publishMetadata(
  trusted: TrustedDirectory,
  metadataFile: string,
  metadata: BackupMetadata,
): FileIdentity {
  const temporary = assertPathConfinedToDirectory(
    trusted,
    path.join(
      trusted.resolvedPath,
      `.${path.basename(metadataFile)}.${randomUUID()}.partial`,
    ),
    "Temporary backup metadata",
  );
  let temporaryIdentity: FileIdentity | null = null;
  let publishedIdentity: FileIdentity | null = null;
  let operationError: unknown;
  try {
    const serialized = `${JSON.stringify(metadata)}\n`;
    fs.writeFileSync(temporary, serialized, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    temporaryIdentity = inspectRegularFile(
      temporary,
      "Temporary backup metadata",
    );
    flushFile(temporary);
    recheckTrustedDirectory(trusted, "Configured backup directory");
    assertPathsVacant([metadataFile], "Backup metadata");
    assertSameRegularFile(
      temporary,
      temporaryIdentity,
      "Temporary backup metadata",
    );
    fs.linkSync(temporary, metadataFile);
    publishedIdentity = temporaryIdentity;
    const observedPublishedIdentity = inspectRegularFile(
      metadataFile,
      "Published backup metadata",
    );
    if (!sameIdentity(temporaryIdentity, observedPublishedIdentity)) {
      throw new Error("Published backup metadata has an unexpected identity");
    }
  } catch (error) {
    operationError = error;
  }
  const cleanupErrors: Error[] = [];
  if (temporaryIdentity) {
    try {
      unlinkVerifiedFile(temporary, temporaryIdentity);
    } catch (error) {
      cleanupErrors.push(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }
  if (operationError !== undefined) {
    if (publishedIdentity) {
      try {
        unlinkVerifiedFile(metadataFile, publishedIdentity);
      } catch (error) {
        cleanupErrors.push(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [operationError, ...cleanupErrors],
        "Backup metadata publication failed and cleanup was incomplete",
      );
    }
    throw operationError;
  }
  if (cleanupErrors.length > 0 || !publishedIdentity) {
    throw new AggregateError(
      cleanupErrors,
      "Backup metadata publication cleanup failed",
    );
  }
  return publishedIdentity;
}

async function hashFile(fileName: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(fileName)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function buildBackupName(createdAt: Date, backupId: string): string {
  const stamp = createdAt
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(".", "");
  return `superior-backup-v11-${stamp}-${backupId}.sqlite3`;
}

function normalizeRetention(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_RETENTION) {
    throw new RangeError(
      `Backup retention must be from 1 through ${MAX_RETENTION}`,
    );
  }
  return value;
}

function readBoundedText(fileName: string, maximumBytes: number): string {
  if (fs.statSync(fileName).size > maximumBytes) {
    throw new Error("Backup metadata exceeds the bounded size limit");
  }
  return fs.readFileSync(fileName, "utf8");
}

function regularFileSize(fileName: string): number {
  try {
    const metadata = fs.lstatSync(fileName);
    return metadata.isFile() && !metadata.isSymbolicLink() ? metadata.size : 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

function inspectSourceDatabase(fileName: string): FileIdentity {
  const metadata = fs.statSync(fileName, { bigint: true });
  if (!metadata.isFile()) {
    throw new Error("Source database must resolve to a regular file");
  }
  if (metadata.ino <= 0n) {
    throw new Error(
      "The source filesystem does not expose a stable file identity",
    );
  }
  return {
    device: metadata.dev,
    inode: metadata.ino,
  };
}

function assertSourceDatabaseIdentity(
  fileName: string,
  expected: FileIdentity,
): void {
  const current = inspectSourceDatabase(fileName);
  if (!sameIdentity(current, expected)) {
    throw new Error("Source database changed during backup rotation");
  }
}

function flushFile(fileName: string): void {
  const descriptor = fs.openSync(fileName, "r+");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
