import { validateDatabaseFile } from "./migration.js";

interface CheckArguments {
  dbFile: string;
  expect?: 2 | 3;
}

function parseArguments(argv: string[]): CheckArguments {
  let dbFile: string | null = null;
  let expect: 2 | 3 | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--db" && value) {
      dbFile = value;
      index += 1;
      continue;
    }
    if (argument === "--expect" && (value === "2" || value === "3")) {
      expect = Number(value) as 2 | 3;
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete db:check option: ${argument}`);
  }
  if (!dbFile) {
    throw new Error("Usage: db:check --db <path> [--expect 2|3]");
  }
  return expect === undefined ? { dbFile } : { dbFile, expect };
}

function main(): void {
  const options = parseArguments(process.argv.slice(2));
  const result = validateDatabaseFile(
    options.dbFile,
    options.expect === undefined ? {} : { expect: options.expect },
  );
  console.log(
    `[db:check] integrity=${result.integrity}; foreign_keys=${result.foreignKeyViolations}; schema=${result.schema}; version=${result.schemaVersion ?? "none"}`,
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown failure";
  console.error(`[db:check][error] ${message}`);
  process.exitCode = 1;
}
