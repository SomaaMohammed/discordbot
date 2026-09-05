import fs from "node:fs";
import path from "node:path";
import {
  loadDatabaseConfig,
  loadProcessConfig,
  resolveBackupDirectory,
  resolveApplicationRoot,
  resolveEnvironmentFile,
} from "./config.js";
import { runBot } from "./index.js";
import { rotateBackups } from "./storage/backup-rotation.js";
import {
  checkpointDatabase,
  normalizeCheckpointMode,
  type CheckpointMode,
} from "./storage/checkpoint.js";
import { BotStorage } from "./storage/db.js";
import Database from "./storage/database.js";
import {
  doctorExitCode,
  runDoctor,
  type DoctorReport,
} from "./storage/doctor.js";
import { decodeRow, sqliteVersionRowSchema } from "./storage/row-decoder.js";
import { detectDatabaseSchema } from "./storage/schema.js";
import { ensureDatabaseCurrent } from "./storage/startup-migration.js";

const applicationRoot = resolveApplicationRoot(path.dirname(process.execPath));

async function main(): Promise<void> {
  const [option, ...arguments_] = process.argv.slice(2);
  switch (option) {
    case undefined:
      await runBot({ requireLauncherLock: true });
      return;
    case "--check":
      runCheck();
      return;
    case "--diagnostics":
      runDiagnostics();
      return;
    case "--offline-smoke":
      await runOfflineSmoke();
      return;
    case "--doctor":
      runCompiledDoctor(arguments_);
      return;
    case "--checkpoint":
      runCompiledCheckpoint(arguments_);
      return;
    case "--backup-rotate":
      await runCompiledBackupRotation(arguments_);
      return;
    default:
      throw new Error("Unsupported compiled-runtime option");
  }
}

function runCheck(): void {
  const config = loadProcessConfig(applicationRoot);
  assertLauncherPaths(config.dbFile);
  const database = new Database();
  try {
    const row = decodeRow(
      sqliteVersionRowSchema,
      database.prepare("SELECT sqlite_version() AS version").get(),
      "compiled runtime readiness",
    );
    if (!row.version) {
      throw new Error("bun:sqlite did not return the expected readiness row");
    }
  } finally {
    database.close();
  }
  console.log(
    "[portable:check] configuration and bun:sqlite are ready; no Discord login was attempted.",
  );
}

function runDiagnostics(): void {
  const environmentFile = resolveEnvironmentFile(applicationRoot);
  const config = loadDatabaseConfig(applicationRoot);
  const registrationMode = String(
    process.env.COMMAND_REGISTRATION_MODE ?? "global",
  )
    .trim()
    .toLowerCase();
  const devGuildCount = String(process.env.DEV_GUILD_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean).length;

  emit("executableVersion", process.env.SUPERIOR_EXECUTABLE_VERSION);
  emit("executablePath", process.env.SUPERIOR_EXECUTABLE_PATH);
  emit("payloadVersion", process.env.SUPERIOR_PAYLOAD_VERSION);
  emit("payloadSha256", process.env.SUPERIOR_PAYLOAD_SHA256);
  emit("payloadRoot", process.env.SUPERIOR_PAYLOAD_ROOT);
  emit("sourceSha256", process.env.SUPERIOR_SOURCE_SHA256);
  emit("payloadCache", process.env.SUPERIOR_PAYLOAD_CACHE);
  emit("bunVersion", Bun.version);
  emit("sqliteBackend", "bun:sqlite");
  emit("sqliteVersion", sqliteVersion());
  emit("applicationRoot", applicationRoot);
  emit("configFile", environmentFile);
  emit("configPresent", fs.existsSync(environmentFile));
  emit("databasePath", config.dbFile);
  emit("databaseSchema", classifyDatabase(config.dbFile));
  emit(
    "commandRegistrationMode",
    registrationMode === "global" || registrationMode === "guild"
      ? registrationMode
      : "invalid",
  );
  emit("developmentGuildCount", devGuildCount);
  const doctor = runDoctor({
    applicationRoot,
    dbFile: config.dbFile,
    backupDirectory: resolveBackupDirectory(applicationRoot),
  });
  emit("doctorStatus", doctor.status);
  emit(
    "doctorFailedChecks",
    doctor.checks.filter((check) => check.status === "fail").length,
  );
  console.log(
    "[diagnostics] completed without Discord login; token and private watcher values were not displayed",
  );
}

function runCompiledDoctor(argv: string[]): void {
  const parsed = parseFixedFlags(argv, ["--json", "--write-probes"]);
  const config = loadDatabaseConfig(applicationRoot, {
    requireLauncherLock: true,
  });
  const report = runDoctor({
    applicationRoot,
    dbFile: config.dbFile,
    backupDirectory: resolveBackupDirectory(applicationRoot),
    writeProbes: parsed.has("--write-probes"),
  });
  if (parsed.has("--json")) console.log(JSON.stringify(report));
  else printDoctor(report);
  process.exitCode = doctorExitCode(report);
}

function runCompiledCheckpoint(argv: string[]): void {
  let mode: CheckpointMode = "passive";
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--mode" && argv[index + 1]) {
      mode = normalizeCheckpointMode(argv[index + 1]);
      index += 1;
      continue;
    }
    throw new Error("Unsupported compiled checkpoint option");
  }
  const config = loadDatabaseConfig(applicationRoot, {
    requireLauncherLock: true,
  });
  assertLauncherPaths(config.dbFile);
  const result = checkpointDatabase({ dbFile: config.dbFile, mode });
  const output = { command: "checkpoint", ...result };
  if (json) console.log(JSON.stringify(output));
  else {
    console.log(
      `[checkpoint] status=${result.outcome}; mode=${result.mode}; busy=${result.busyFrames}; log=${result.logFrames}; checkpointed=${result.checkpointedFrames}; duration_ms=${result.durationMs.toFixed(3)}`,
    );
  }
  if (result.outcome === "busy") process.exitCode = 2;
}

async function runCompiledBackupRotation(argv: string[]): Promise<void> {
  let retention = 7;
  let dryRun = false;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--retention" && argv[index + 1]) {
      retention = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    throw new Error("Unsupported compiled backup-rotation option");
  }
  const config = loadDatabaseConfig(applicationRoot, {
    requireLauncherLock: true,
  });
  assertLauncherPaths(config.dbFile);
  const result = await rotateBackups({
    dbFile: config.dbFile,
    backupDirectory: resolveBackupDirectory(applicationRoot),
    retention,
    dryRun,
  });
  if (json) console.log(JSON.stringify(result));
  else {
    console.log(
      `[backup-rotate] status=${result.status}; backup=${result.currentBackupName}; bytes=${result.currentBackupBytes}; restored_guild_rows=${result.restoredGuildRows}; retained=${result.retainedBackupNames.length}; deleted=${result.deletedBackupNames.length}; would_delete=${result.wouldDeleteBackupNames.length}`,
    );
  }
}

function parseFixedFlags(
  argv: string[],
  allowed: readonly string[],
): Set<string> {
  const result = new Set<string>();
  for (const argument of argv) {
    if (!allowed.includes(argument) || result.has(argument)) {
      throw new Error("Unsupported or repeated compiled-runtime option");
    }
    result.add(argument);
  }
  return result;
}

function printDoctor(report: DoctorReport): void {
  console.log(
    `Superior doctor: ${report.status}; package=${report.packageVersion}; bun=${report.runtimeVersion}; sqlite=${report.sqliteBackend}`,
  );
  for (const check of report.checks) {
    console.log(
      `[${check.status.toUpperCase()}] ${check.id}: ${check.summary}`,
    );
  }
}

async function runOfflineSmoke(): Promise<void> {
  if (process.env.SUPERIOR_TEST_MODE !== "1") {
    throw new Error("The offline smoke mode is restricted to packaging tests");
  }
  const config = loadDatabaseConfig(applicationRoot, {
    requireLauncherLock: true,
  });
  assertLauncherPaths(config.dbFile);
  const databaseExisted = fs.existsSync(config.dbFile);
  if (process.env.SUPERIOR_AUTO_MIGRATE === "1") {
    await ensureDatabaseCurrent({ dbFile: config.dbFile });
  }
  const storage = new BotStorage(config);
  storage.initStorage();
  const smokeDatabase = new Database(config.dbFile, {
    readonly: true,
    fileMustExist: true,
  });
  let schema: string;
  try {
    schema = detectDatabaseSchema(smokeDatabase);
  } finally {
    smokeDatabase.close();
  }
  console.log(
    `[offline-smoke] ready database=${safe(config.dbFile)} databaseState=${databaseExisted ? "existing" : "created"} schema=${schema}`,
  );

  await new Promise<void>((resolve) => {
    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      storage.close();
      console.log("[offline-smoke] graceful shutdown complete");
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGBREAK", stop);
    process.once("SIGTERM", stop);
  });
}

function assertLauncherPaths(databaseFile: string): void {
  const expectedRoot = process.env.SUPERIOR_PORTABLE_EXPECT_ROOT;
  if (expectedRoot && path.resolve(expectedRoot) !== applicationRoot) {
    throw new Error(
      "Portable configuration was not resolved from the launcher directory.",
    );
  }
  const expectedDatabase = process.env.SUPERIOR_PORTABLE_EXPECT_DB;
  if (expectedDatabase && path.resolve(expectedDatabase) !== databaseFile) {
    throw new Error(
      "The configured database path did not resolve beside the launcher.",
    );
  }
  const expectedEnvironment = process.env.SUPERIOR_PORTABLE_EXPECT_ENV;
  if (
    expectedEnvironment &&
    path.resolve(expectedEnvironment) !==
      path.resolve(resolveEnvironmentFile(applicationRoot))
  ) {
    throw new Error(
      "The selected environment file did not reach the packaged configuration loader.",
    );
  }
}

function classifyDatabase(databaseFile: string): string {
  if (process.env.SUPERIOR_DIAGNOSTICS_SKIP_DATABASE === "1") return "skipped";
  if (!fs.existsSync(databaseFile)) return "missing (not opened)";
  const database = new Database(databaseFile, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return detectDatabaseSchema(database);
  } catch (error) {
    return `unreadable (${error instanceof Error ? error.message : String(error)})`;
  } finally {
    database.close();
  }
}

function sqliteVersion(): string {
  const database = new Database();
  try {
    return decodeRow(
      sqliteVersionRowSchema,
      database.prepare("SELECT sqlite_version() AS version").get(),
      "compiled diagnostics sqlite version",
    ).version;
  } finally {
    database.close();
  }
}

function emit(name: string, value: unknown): void {
  console.log(`[diagnostics] ${name}=${safe(value)}`);
}

function safe(value: unknown, maximumLength = 2_048): string {
  const normalized = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .slice(0, maximumLength);
  return normalized || "(none)";
}

try {
  await main();
} catch (error) {
  console.error(
    `[compiled-runtime:error] ${safe(error instanceof Error ? error.message : error)}`,
  );
  process.exitCode = 1;
}
