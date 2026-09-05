import { rotateBackups, type BackupRotationResult } from "./backup-rotation.js";

interface RotationArguments {
  readonly dbFile: string;
  readonly backupDirectory: string;
  readonly retention: number;
  readonly dryRun: boolean;
  readonly json: boolean;
}

function parseArguments(argv: string[]): RotationArguments {
  let dbFile: string | null = null;
  let backupDirectory: string | null = null;
  let retention = 7;
  let dryRun = false;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--db" && value) {
      dbFile = value;
      index += 1;
      continue;
    }
    if (argument === "--backup-dir" && value) {
      backupDirectory = value;
      index += 1;
      continue;
    }
    if (argument === "--retention" && value) {
      retention = Number(value);
      index += 1;
      continue;
    }
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    throw new Error(
      `Unknown or incomplete backup-rotation option: ${argument}`,
    );
  }
  if (!dbFile || !backupDirectory) {
    throw new Error(
      "Usage: db:rotate --db <source> --backup-dir <directory> [--retention <count>] [--dry-run] [--json]",
    );
  }
  return { dbFile, backupDirectory, retention, dryRun, json };
}

function printHuman(result: BackupRotationResult): void {
  console.log(
    `[db:rotate] status=${result.status}; backup=${result.currentBackupName}; bytes=${result.currentBackupBytes}; restored_guild_rows=${result.restoredGuildRows}; retention=${result.retention}; deleted=${result.deletedBackupNames.length}; would_delete=${result.wouldDeleteBackupNames.length}`,
  );
}

void (async () => {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = await rotateBackups(options);
    if (options.json) console.log(JSON.stringify(result));
    else printHuman(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown failure";
    if (process.argv.includes("--json")) {
      console.error(
        JSON.stringify({
          command: "backup-rotate",
          status: "failed",
          error: message,
        }),
      );
    } else {
      console.error(`[db:rotate][error] ${message}`);
    }
    process.exitCode = 1;
  }
})();
