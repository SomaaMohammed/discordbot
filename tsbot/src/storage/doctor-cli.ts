import path from "node:path";
import { fileURLToPath } from "node:url";
import { doctorExitCode, runDoctor, type DoctorReport } from "./doctor.js";

interface DoctorArguments {
  readonly applicationRoot: string;
  readonly dbFile?: string;
  readonly backupDirectory?: string;
  readonly json: boolean;
  readonly writeProbes: boolean;
}

function parseArguments(argv: string[]): DoctorArguments {
  const sourceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
  );
  let applicationRoot = sourceRoot;
  let dbFile: string | undefined;
  let backupDirectory: string | undefined;
  let json = false;
  let writeProbes = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--root" && value) {
      applicationRoot = path.resolve(value);
      index += 1;
      continue;
    }
    if (argument === "--db" && value) {
      dbFile = path.resolve(value);
      index += 1;
      continue;
    }
    if (argument === "--backup-dir" && value) {
      backupDirectory = path.resolve(value);
      index += 1;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--write-probes") {
      writeProbes = true;
      continue;
    }
    throw new Error(`Unknown or incomplete doctor option: ${argument}`);
  }
  return {
    applicationRoot,
    ...(dbFile === undefined ? {} : { dbFile }),
    ...(backupDirectory === undefined ? {} : { backupDirectory }),
    json,
    writeProbes,
  };
}

function printHuman(report: DoctorReport): void {
  console.log(
    `Superior doctor: ${report.status}; package=${report.packageVersion}; bun=${report.runtimeVersion}; sqlite=${report.sqliteBackend}`,
  );
  for (const check of report.checks) {
    console.log(
      `[${check.status.toUpperCase()}] ${check.id}: ${check.summary}`,
    );
    if (check.details) console.log(`  ${JSON.stringify(check.details)}`);
  }
}

try {
  const options = parseArguments(process.argv.slice(2));
  const report = runDoctor(options);
  if (options.json) console.log(JSON.stringify(report));
  else printHuman(report);
  process.exitCode = doctorExitCode(report);
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown failure";
  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify({
        reportVersion: 1,
        command: "doctor",
        status: "failed",
        packageVersion: "unknown",
        runtimeVersion: Bun.version,
        sqliteBackend: "bun:sqlite",
        manifest: {
          formatVersion: 1,
          applicationVersion: "unknown",
          platform: process.platform,
          architecture: process.arch,
          kernelRelease: "unknown",
          libc: null,
          bunVersion: Bun.version,
          bunRevision: Bun.revision,
          sqliteBackend: "bun:sqlite",
          sqliteVersion: null,
          databasePath: null,
          backupPath: null,
          databaseSchema: null,
          releaseIdentity: null,
          releaseIdentityAlgorithm: "sha256",
          requiredEnvironmentVariables: ["DISCORD_TOKEN"],
          machineSpecificValuesIncluded: false,
        },
        checks: [
          {
            id: "doctor-command",
            status: "fail",
            summary: message,
          },
        ],
      }),
    );
  } else {
    console.error(`[doctor][error] ${message}`);
  }
  process.exitCode = 2;
}
