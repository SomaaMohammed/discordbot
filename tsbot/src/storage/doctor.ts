import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadEnvironmentFile,
  resolveBackupDirectory,
  resolveDatabaseFile,
  resolveEnvironmentFile,
} from "../config.js";
import { PACKAGE_VERSION } from "../constants.js";
import { redactLogValue } from "../logging.js";
import Database from "./database.js";
import {
  assertPathConfinedToDirectory,
  inspectRegularFile,
  inspectTrustedDirectory,
  isSecureEnvironmentFileMode,
  sameIdentity,
  samePath,
  unlinkVerifiedFile,
  type FileIdentity,
  type TrustedDirectory,
} from "./filesystem-safety.js";
import {
  databaseForeignKeyViolationCount,
  databaseIntegrityCheck,
  detectDatabaseSchema,
} from "./schema.js";
import {
  decodePragmaInteger,
  decodePragmaString,
  decodeRow,
  sqliteVersionRowSchema,
} from "./row-decoder.js";

export const DOCTOR_REPORT_VERSION = 1 as const;
export const SUPPORTED_BUN_MINIMUM = "1.4.0";

export type DoctorCheckStatus = "pass" | "fail" | "warn" | "skipped";

export interface DoctorCheck {
  readonly id: string;
  readonly status: DoctorCheckStatus;
  readonly summary: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface DoctorReport {
  readonly reportVersion: typeof DOCTOR_REPORT_VERSION;
  readonly command: "doctor";
  readonly status: "healthy" | "degraded" | "failed";
  readonly packageVersion: string;
  readonly runtimeVersion: string;
  readonly sqliteBackend: "bun:sqlite";
  readonly manifest: DoctorManifest;
  readonly checks: readonly DoctorCheck[];
}

export interface DoctorManifest {
  readonly formatVersion: 1;
  readonly applicationVersion: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly kernelRelease: string;
  readonly libc: string | null;
  readonly bunVersion: string;
  readonly bunRevision: string;
  readonly sqliteBackend: "bun:sqlite";
  readonly sqliteVersion: string | null;
  readonly databasePath: string;
  readonly backupPath: string;
  readonly databaseSchema: number | null;
  readonly releaseIdentity: string | null;
  readonly releaseIdentityAlgorithm: "sha256";
  readonly requiredEnvironmentVariables: readonly ["DISCORD_TOKEN"];
  readonly machineSpecificValuesIncluded: false;
}

export interface DoctorOptions {
  readonly applicationRoot: string;
  readonly dbFile?: string;
  readonly backupDirectory?: string;
  readonly writeProbes?: boolean;
}

export function runDoctor(options: DoctorOptions): DoctorReport {
  const checks: DoctorCheck[] = [];
  const applicationRoot = path.resolve(options.applicationRoot);
  loadEnvironmentFile(applicationRoot);
  const configFile = path.resolve(resolveEnvironmentFile(applicationRoot));
  const databaseFile = path.resolve(
    options.dbFile ?? resolveDatabaseFile(applicationRoot),
  );
  const backupDirectory = path.resolve(
    options.backupDirectory ?? resolveBackupDirectory(applicationRoot),
  );
  const payloadRoot = path.resolve(
    String(process.env.SUPERIOR_PAYLOAD_ROOT ?? applicationRoot),
  );
  const launcherPath = path.resolve(
    String(process.env.SUPERIOR_EXECUTABLE_PATH ?? process.execPath),
  );
  const runtimePath = path.resolve(process.execPath);

  checks.push(checkRuntime());
  const sqliteCheck = checkSqliteRuntime();
  checks.push(sqliteCheck);
  checks.push(
    checkCanonicalPaths({
      applicationRoot,
      payloadRoot,
      launcherPath,
      runtimePath,
      configFile,
      databaseFile,
      backupDirectory,
    }),
  );
  checks.push(checkEnvironmentFile(configFile));
  const databaseChecks = checkDatabase(
    databaseFile,
    options.writeProbes === true,
  );
  checks.push(...databaseChecks);
  checks.push(
    ...checkBackupDirectory({
      backupDirectory,
      databaseFile,
      writeProbes: options.writeProbes === true,
    }),
  );
  checks.push(
    checkReleaseLayout({
      payloadRoot,
      launcherPath,
      runtimePath,
    }),
  );

  const status = checks.some((check) => check.status === "fail")
    ? "failed"
    : checks.some(
          (check) => check.status === "warn" || check.status === "skipped",
        )
      ? "degraded"
      : "healthy";
  return {
    reportVersion: DOCTOR_REPORT_VERSION,
    command: "doctor",
    status,
    packageVersion: PACKAGE_VERSION,
    runtimeVersion: Bun.version,
    sqliteBackend: "bun:sqlite",
    manifest: buildManifest({
      applicationRoot,
      databaseFile,
      backupDirectory,
      sqliteCheck,
      databaseChecks,
    }),
    checks,
  };
}

function buildManifest(input: {
  applicationRoot: string;
  databaseFile: string;
  backupDirectory: string;
  sqliteCheck: DoctorCheck;
  databaseChecks: readonly DoctorCheck[];
}): DoctorManifest {
  const sqliteVersion =
    typeof input.sqliteCheck.details?.sqliteVersion === "string"
      ? input.sqliteCheck.details.sqliteVersion
      : null;
  const databaseHealth = input.databaseChecks.find(
    (check) => check.id === "database-health",
  );
  const schemaValue = databaseHealth?.details?.schema;
  const databaseSchema =
    typeof schemaValue === "string"
      ? /^current-v(\d+)$/u.exec(schemaValue)?.[1]
      : undefined;
  return {
    formatVersion: 1,
    applicationVersion: PACKAGE_VERSION,
    platform: process.platform,
    architecture: process.arch,
    kernelRelease: os.release(),
    libc: detectLibc(),
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    sqliteBackend: "bun:sqlite",
    sqliteVersion,
    databasePath: path.resolve(input.databaseFile),
    backupPath: path.resolve(input.backupDirectory),
    databaseSchema:
      databaseSchema === undefined ? null : Number(databaseSchema),
    releaseIdentity: computeReleaseIdentity(),
    releaseIdentityAlgorithm: "sha256",
    requiredEnvironmentVariables: ["DISCORD_TOKEN"],
    machineSpecificValuesIncluded: false,
  };
}

function detectLibc(): string | null {
  try {
    const report = (
      process as unknown as {
        report?: {
          getReport?: () => {
            header?: { glibcVersionRuntime?: unknown };
          };
        };
      }
    ).report;
    const value = report?.getReport?.().header?.glibcVersionRuntime;
    return typeof value === "string" && value.length > 0
      ? `glibc-${value}`
      : null;
  } catch {
    return null;
  }
}

function computeReleaseIdentity(): string | null {
  const releaseRoot = path.resolve(
    String(process.env.SUPERIOR_RELEASE_ROOT ?? inferPackageRoot()),
  );
  const files = [
    path.join(releaseRoot, "package.json"),
    path.join(releaseRoot, "bun.lock"),
    path.join(releaseRoot, "dist", "src", "index.js"),
  ];
  if (files.some((fileName) => !isDirectRegularFile(fileName))) return null;
  const hash = createHash("sha256");
  for (const fileName of files) {
    hash.update(path.relative(releaseRoot, fileName));
    hash.update("\\0");
    hash.update(fs.readFileSync(fileName));
    hash.update("\\0");
  }
  return Buffer.from(hash.digest()).toString("hex");
}

function inferPackageRoot(): string {
  const moduleRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );
  return path.basename(moduleRoot) === "dist"
    ? path.resolve(moduleRoot, "..")
    : moduleRoot;
}

function isDirectRegularFile(fileName: string): boolean {
  try {
    const metadata = fs.lstatSync(fileName);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

export function doctorExitCode(report: DoctorReport): number {
  return report.status === "failed" ? 1 : 0;
}

function checkRuntime(): DoctorCheck {
  const actual = Bun.version;
  const supported = compareVersions(actual, SUPPORTED_BUN_MINIMUM) >= 0;
  const payloadVersion = String(process.env.SUPERIOR_PAYLOAD_VERSION ?? "");
  const executableVersion = String(
    process.env.SUPERIOR_EXECUTABLE_VERSION ?? "",
  );
  const releaseVersionsMatch = [payloadVersion, executableVersion]
    .filter(Boolean)
    .every((version) => version === PACKAGE_VERSION);
  return {
    id: "runtime",
    status: supported && releaseVersionsMatch ? "pass" : "fail",
    summary:
      supported && releaseVersionsMatch
        ? "Package and Bun runtime versions are supported"
        : "Package or Bun runtime version is unsupported or inconsistent",
    details: {
      packageVersion: PACKAGE_VERSION,
      bunVersion: actual,
      minimumBunVersion: SUPPORTED_BUN_MINIMUM,
      releaseIdentity: releaseVersionsMatch ? "matching" : "mismatch",
    },
  };
}

function checkSqliteRuntime(): DoctorCheck {
  try {
    const database = new Database();
    try {
      const version = decodeRow(
        sqliteVersionRowSchema,
        database.prepare("SELECT sqlite_version() AS version").get(),
        "doctor sqlite version",
      ).version;
      return {
        id: "sqlite-runtime",
        status: "pass",
        summary: "The production SQLite backend is available",
        details: { backend: "bun:sqlite", sqliteVersion: version },
      };
    } finally {
      database.close();
    }
  } catch (error) {
    return failed(
      "sqlite-runtime",
      "The bun:sqlite backend is unavailable",
      error,
    );
  }
}

function checkCanonicalPaths(input: {
  applicationRoot: string;
  payloadRoot: string;
  launcherPath: string;
  runtimePath: string;
  configFile: string;
  databaseFile: string;
  backupDirectory: string;
}): DoctorCheck {
  const details: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const [name, value] of Object.entries(input)) {
    try {
      const parent =
        fs.existsSync(value) && fs.statSync(value).isDirectory()
          ? value
          : path.dirname(value);
      inspectTrustedDirectory(parent, `${name} parent`);
      details[name] = fs.existsSync(value)
        ? fs.realpathSync.native(value)
        : path.resolve(value);
    } catch (error) {
      details[name] = path.resolve(value);
      errors.push(`${name}: ${safeError(error)}`);
    }
  }
  return {
    id: "canonical-paths",
    status: errors.length === 0 ? "pass" : "fail",
    summary:
      errors.length === 0
        ? "Executable, payload, application, config, database, and backup paths are canonical"
        : "One or more operational paths traverse an unsafe or unavailable directory",
    details: {
      ...details,
      ...(errors.length === 0 ? {} : { errors }),
    },
  };
}

function checkEnvironmentFile(configFile: string): DoctorCheck {
  if (!fs.existsSync(configFile)) {
    return {
      id: "environment-file",
      status: "fail",
      summary: "The adjacent environment file is missing",
      details: { path: configFile, secretsDisplayed: false },
    };
  }
  try {
    inspectRegularFile(configFile, "Environment file");
    const mode = fs.statSync(configFile).mode & 0o7777;
    if (!isSecureEnvironmentFileMode(mode)) {
      throw new Error(
        "Environment file permissions are too broad; use mode 0600 or 0640 (observed " +
          mode.toString(8) +
          ")",
      );
    }
    return {
      id: "environment-file",
      status: "pass",
      summary:
        "The adjacent environment file was discovered without reading secrets into output",
      details: {
        path: fs.realpathSync.native(configFile),
        mode: mode.toString(8),
        secretsDisplayed: false,
      },
    };
  } catch (error) {
    return failed(
      "environment-file",
      "The adjacent environment file is missing, unsafe, or too permissive",
      error,
      { path: configFile, secretsDisplayed: false },
    );
  }
}

function checkDatabase(
  databaseFile: string,
  writeProbes: boolean,
): DoctorCheck[] {
  if (!fs.existsSync(databaseFile)) {
    return [
      {
        id: "database-file",
        status: "fail",
        summary: "The configured database does not exist",
        details: { path: databaseFile },
      },
      skipped(
        "database-health",
        "Database health checks require an existing file",
      ),
      skipped(
        "database-lock",
        "Database lock probing requires an existing file",
      ),
    ];
  }

  const checks: DoctorCheck[] = [];
  try {
    inspectRegularFile(databaseFile, "Database file");
    fs.accessSync(databaseFile, fs.constants.R_OK | fs.constants.W_OK);
    checks.push({
      id: "database-file",
      status: "pass",
      summary: "The database is a readable and writable direct regular file",
      details: {
        path: fs.realpathSync.native(databaseFile),
        bytes: fs.statSync(databaseFile).size,
      },
    });
  } catch (error) {
    checks.push(
      failed(
        "database-file",
        "The database file or its permissions are unsafe",
        error,
        { path: databaseFile },
      ),
    );
  }

  try {
    const database = new Database(databaseFile, {
      readonly: true,
      fileMustExist: true,
      timeout: 5_000,
    });
    try {
      database.pragma("foreign_keys = ON");
      const journalMode = decodePragmaString(
        database.pragma("journal_mode")[0],
        "journal_mode",
        "doctor PRAGMA journal_mode",
      ).toLowerCase();
      const foreignKeys = decodePragmaInteger(
        database.pragma("foreign_keys")[0],
        "foreign_keys",
        "doctor PRAGMA foreign_keys",
      );
      const busyTimeout = decodePragmaInteger(
        database.pragma("busy_timeout")[0],
        "timeout",
        "doctor PRAGMA busy_timeout",
      );
      const schema = detectDatabaseSchema(database);
      const integrity = databaseIntegrityCheck(database);
      const foreignKeyViolations = databaseForeignKeyViolationCount(database);
      const healthy =
        schema === "current-v11" &&
        integrity === "ok" &&
        foreignKeyViolations === 0 &&
        journalMode === "wal" &&
        foreignKeys === 1 &&
        busyTimeout === 5_000;
      checks.push({
        id: "database-health",
        status: healthy ? "pass" : "fail",
        summary: healthy
          ? "Schema, integrity, foreign keys, WAL, timeout, and readonly opening are healthy"
          : "One or more database health invariants failed",
        details: {
          schema,
          integrity,
          foreignKeyViolations,
          journalMode,
          foreignKeys,
          busyTimeout,
          readonlyOpen: true,
        },
      });
    } finally {
      database.close();
    }
  } catch (error) {
    checks.push(
      failed(
        "database-health",
        "The database could not be opened readonly and validated",
        error,
      ),
    );
  }

  const launcherLockHeld = process.env.SUPERIOR_DATABASE_LOCK_HELD === "1";
  if (launcherLockHeld) {
    checks.push({
      id: "database-lock",
      status: "pass",
      summary: "The Windows launcher reports that the database lock is held",
      details: { source: "launcher" },
    });
  } else if (!writeProbes) {
    checks.push(
      skipped(
        "database-lock",
        "Use --write-probes to verify immediate database-lock availability outside the launcher",
      ),
    );
  } else {
    try {
      const database = new Database(databaseFile, {
        fileMustExist: true,
        timeout: 250,
      });
      try {
        database.transaction(() => undefined).immediate();
      } finally {
        database.close();
      }
      checks.push({
        id: "database-lock",
        status: "pass",
        summary: "An immediate transaction lock was acquired and released",
        details: { source: "explicit-write-probe" },
      });
    } catch (error) {
      checks.push(
        failed(
          "database-lock",
          "The database lock is held by another process or unavailable",
          error,
        ),
      );
    }
  }
  return checks;
}

function checkBackupDirectory(input: {
  backupDirectory: string;
  databaseFile: string;
  writeProbes: boolean;
}): DoctorCheck[] {
  let trusted: TrustedDirectory;
  try {
    trusted = inspectTrustedDirectory(
      input.backupDirectory,
      "Backup directory",
    );
  } catch (error) {
    return [
      failed(
        "backup-directory",
        "The configured backup directory is missing or unsafe",
        error,
        { path: input.backupDirectory },
      ),
      skipped(
        "backup-hard-link",
        "Hard-link probing requires a safe backup directory",
      ),
      skipped(
        "backup-space",
        "Free-space checking requires a safe backup directory",
      ),
    ];
  }

  const checks: DoctorCheck[] = [
    {
      id: "backup-directory",
      status: "pass",
      summary: "The configured backup directory is canonical and non-reparse",
      details: { path: trusted.canonicalPath },
    },
  ];
  if (input.writeProbes) {
    try {
      runHardLinkProbe(trusted);
      checks.push({
        id: "backup-hard-link",
        status: "pass",
        summary:
          "Atomic hard-link publication is supported in the backup directory",
        details: { probe: "explicit-and-cleaned" },
      });
    } catch (error) {
      checks.push(
        failed(
          "backup-hard-link",
          "The backup filesystem cannot perform safe hard-link publication",
          error,
        ),
      );
    }
  } else {
    checks.push(
      skipped(
        "backup-hard-link",
        "Use --write-probes to test hard-link publication with cleaned temporary files",
      ),
    );
  }

  try {
    const databaseBytes = regularFileSize(input.databaseFile);
    const walBytes = regularFileSize(`${input.databaseFile}-wal`);
    const requiredBytes = Math.max(
      64 * 1024 * 1024,
      (databaseBytes + walBytes) * 3 + 16 * 1024 * 1024,
    );
    const fileSystem = fs.statfsSync(trusted.resolvedPath);
    const availableBytes = Number(fileSystem.bavail) * Number(fileSystem.bsize);
    const sufficient =
      Number.isFinite(availableBytes) && availableBytes >= requiredBytes;
    checks.push({
      id: "backup-space",
      status: sufficient ? "pass" : "fail",
      summary: sufficient
        ? "The backup directory has conservative snapshot and restore capacity"
        : "The backup directory has insufficient conservative free space",
      details: { availableBytes, requiredBytes, databaseBytes, walBytes },
    });
  } catch (error) {
    checks.push(
      failed(
        "backup-space",
        "Backup free space could not be determined",
        error,
      ),
    );
  }
  return checks;
}

function checkReleaseLayout(input: {
  payloadRoot: string;
  launcherPath: string;
  runtimePath: string;
}): DoctorCheck {
  const compiled =
    Boolean(process.env.SUPERIOR_PAYLOAD_ROOT) ||
    path.basename(input.runtimePath).toLowerCase() ===
      "superiorbot.runtime.exe";
  if (!compiled) {
    return skipped(
      "release-layout",
      "Source execution has no packaged updater or manifest layout",
    );
  }
  try {
    const payload = inspectTrustedDirectory(input.payloadRoot, "Payload root");
    const versionFile = path.join(payload.resolvedPath, "VERSION");
    const buildInfoFile = path.join(payload.resolvedPath, "BUILD-INFO.txt");
    const manifestFile = path.join(payload.resolvedPath, "MANIFEST.sha256");
    const updaterFile = path.join(payload.resolvedPath, "Update.exe");
    const expectedRuntime = path.join(
      payload.resolvedPath,
      "app",
      "SuperiorBot.Runtime.exe",
    );
    for (const [fileName, label] of [
      [versionFile, "VERSION"],
      [buildInfoFile, "BUILD-INFO.txt"],
      [manifestFile, "MANIFEST.sha256"],
      [updaterFile, "Update.exe"],
      [expectedRuntime, "SuperiorBot.Runtime.exe"],
      [input.launcherPath, "SuperiorBot.exe"],
    ] as const) {
      inspectRegularFile(fileName, label);
    }
    const version = readBoundedText(versionFile, 80).trim();
    const buildInfo = parseBuildInfo(readBoundedText(buildInfoFile, 64 * 1024));
    const signingMode = buildInfo.SIGNING_MODE;
    const signingMetadataValid =
      (signingMode === "production-signed" &&
        buildInfo.SIGNATURE_STATUS === "valid" &&
        buildInfo.TIMESTAMP_STATUS === "present-and-valid" &&
        Boolean(buildInfo.SIGNING_SUBJECT) &&
        /^[A-F0-9]{40}$/u.test(buildInfo.SIGNING_THUMBPRINT ?? "")) ||
      (signingMode === "development-unsigned" &&
        buildInfo.SIGNATURE_STATUS === "unsigned" &&
        buildInfo.TIMESTAMP_STATUS === "not-applicable");
    if (
      version !== PACKAGE_VERSION ||
      buildInfo.PACKAGE_VERSION !== PACKAGE_VERSION ||
      !signingMetadataValid ||
      !samePath(fs.realpathSync.native(expectedRuntime), input.runtimePath)
    ) {
      throw new Error("Packaged release identity is inconsistent");
    }
    return {
      id: "release-layout",
      status: "pass",
      summary:
        "Updater, manifest, payload, and release identities are consistent",
      details: {
        version,
        sourceIdentityPresent: Boolean(buildInfo.SOURCE_SHA256),
        manifestPresent: true,
        updaterPresent: true,
        signingMode,
        signatureStatus: buildInfo.SIGNATURE_STATUS,
        timestampStatus: buildInfo.TIMESTAMP_STATUS,
      },
    };
  } catch (error) {
    return failed(
      "release-layout",
      "The packaged updater, manifest, or release identity is invalid",
      error,
    );
  }
}

function runHardLinkProbe(trusted: TrustedDirectory): void {
  const nonce = randomUUID();
  const source = assertPathConfinedToDirectory(
    trusted,
    path.join(trusted.resolvedPath, `.superior-doctor-${nonce}.probe`),
    "Doctor probe source",
  );
  const linked = assertPathConfinedToDirectory(
    trusted,
    path.join(trusted.resolvedPath, `.superior-doctor-${nonce}.link`),
    "Doctor probe link",
  );
  let sourceIdentity: FileIdentity | null = null;
  let linkedIdentity: FileIdentity | null = null;
  let operationError: unknown;
  try {
    const descriptor = fs.openSync(source, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, "superior-doctor-hard-link-probe", "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    sourceIdentity = inspectRegularFile(source, "Doctor probe source");
    fs.linkSync(source, linked);
    linkedIdentity = sourceIdentity;
    const observedLinkedIdentity = inspectRegularFile(
      linked,
      "Doctor probe link",
    );
    if (!sameIdentity(sourceIdentity, observedLinkedIdentity)) {
      throw new Error("Hard-link probe files do not share an identity");
    }
  } catch (error) {
    operationError = error;
  }
  const cleanupErrors: Error[] = [];
  for (const [fileName, identity] of [
    [linked, linkedIdentity],
    [source, sourceIdentity],
  ] as const) {
    if (!identity) continue;
    try {
      unlinkVerifiedFile(fileName, identity);
    } catch (error) {
      cleanupErrors.push(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      operationError === undefined
        ? cleanupErrors
        : [operationError, ...cleanupErrors],
      "Doctor hard-link probe cleanup failed",
    );
  }
  if (operationError !== undefined) throw operationError;
}

function parseBuildInfo(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of value.split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const entry = line.slice(separator + 1).trim();
    if (/^[A-Z0-9_]{1,80}$/u.test(key) && entry.length <= 4_096) {
      result[key] = entry;
    }
  }
  return result;
}

function readBoundedText(fileName: string, maximumBytes: number): string {
  const metadata = fs.statSync(fileName);
  if (metadata.size > maximumBytes) {
    throw new Error(`Release identity file exceeds ${maximumBytes} bytes`);
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

function skipped(id: string, summary: string): DoctorCheck {
  return { id, status: "skipped", summary };
}

function failed(
  id: string,
  summary: string,
  error: unknown,
  details: Record<string, unknown> = {},
): DoctorCheck {
  return {
    id,
    status: "fail",
    summary,
    details: { ...details, error: safeError(error) },
  };
}

function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return String(redactLogValue(value)).slice(0, 500);
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] =>
    value
      .split(/[.+-]/u)
      .slice(0, 3)
      .map((part) => (/^\d+$/u.test(part) ? Number(part) : 0));
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
