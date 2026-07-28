import { migrateDatabase, type MigrationFailurePoint } from "./migration.js";

const FAILURE_POINTS = new Set<MigrationFailurePoint>([
  "after-source-read",
  "after-rename",
  "after-create",
  "after-copy",
  "after-verify",
  "after-drop",
  "after-version",
  "before-commit",
]);

interface MigrateArguments {
  dbFile: string;
  dryRun: boolean;
  failurePoint?: MigrationFailurePoint;
}

function parseArguments(argv: string[]): MigrateArguments {
  let dbFile: string | null = null;
  let dryRun = false;
  let failurePoint: MigrationFailurePoint | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--db" && value) {
      dbFile = value;
      index += 1;
      continue;
    }
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (
      argument === "--inject-failure" &&
      value &&
      FAILURE_POINTS.has(value as MigrationFailurePoint)
    ) {
      failurePoint = value as MigrationFailurePoint;
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete migration option: ${argument}`);
  }
  if (!dbFile) {
    throw new Error(
      "Usage: migrate --db <path> [--dry-run] [--inject-failure <stage>]",
    );
  }
  return failurePoint === undefined
    ? { dbFile, dryRun }
    : { dbFile, dryRun, failurePoint };
}

function main(): void {
  const options = parseArguments(process.argv.slice(2));
  const migrationOptions = {
    dbFile: options.dbFile,
    dryRun: options.dryRun,
    ...(options.failurePoint === undefined
      ? {}
      : { failurePoint: options.failurePoint }),
  };
  const result = migrateDatabase(migrationOptions);
  console.log(
    `[migration] status=${result.status}; from=${result.fromSchema}; to=${result.toSchema}; guilds=${result.guilds}; review_required=${result.settingsRequiringReview}; metrics_preserved=${result.metricsPreserved}; metrics_dropped=${result.metricsDropped}; warnings=${result.warnings}`,
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown failure";
  console.error(`[migration][error] ${message}`);
  process.exitCode = 1;
}
