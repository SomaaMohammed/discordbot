import { validateDatabaseFile } from "./migration.js";

interface CheckArguments {
  dbFile: string;
  expect: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
}

function parseArguments(argv: string[]): CheckArguments {
  let dbFile: string | null = null;
  let expect: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--db" && value) {
      dbFile = value;
      index += 1;
      continue;
    }
    if (
      argument === "--expect" &&
      (value === "2" ||
        value === "3" ||
        value === "4" ||
        value === "5" ||
        value === "6" ||
        value === "7" ||
        value === "8" ||
        value === "9" ||
        value === "10" ||
        value === "11")
    ) {
      expect = Number(value) as 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete db:check option: ${argument}`);
  }
  if (!dbFile || expect === undefined) {
    throw new Error("Usage: db:check --db <path> --expect 2|3|4|5|6|7|8|9|10|11");
  }
  return { dbFile, expect };
}

function main(): void {
  const options = parseArguments(process.argv.slice(2));
  const result = validateDatabaseFile(options.dbFile, {
    expect: options.expect,
  });
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
