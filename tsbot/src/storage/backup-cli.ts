import { backupDatabase } from "./backup.js";

interface BackupArguments {
  dbFile: string;
  outputFile: string;
  expect: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}

function parseArguments(argv: string[]): BackupArguments {
  let dbFile: string | null = null;
  let outputFile: string | null = null;
  let expect: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--db" && value) {
      dbFile = value;
      index += 1;
      continue;
    }
    if (argument === "--out" && value) {
      outputFile = value;
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
        value === "9")
    ) {
      expect = Number(value) as 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete backup option: ${argument}`);
  }
  if (!dbFile || !outputFile || expect === null) {
    throw new Error(
      "Usage: backup --db <source> --out <new-file> --expect 2|3|4|5|6|7|8|9",
    );
  }
  return { dbFile, outputFile, expect };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const result = await backupDatabase({
    dbFile: options.dbFile,
    outputFile: options.outputFile,
    expect: options.expect,
  });
  console.log(
    `[db:backup] schema=${result.schema}; version=${result.schemaVersion}; integrity=${result.integrity}; foreign_keys=${result.foreignKeyViolations}; bytes=${result.bytes}`,
  );
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown failure";
  console.error(`[db:backup][error] ${message}`);
  process.exitCode = 1;
});
