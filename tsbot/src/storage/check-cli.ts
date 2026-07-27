import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDatabaseConfig } from "../config.js";
import { validateDatabaseFile } from "./migration.js";

function main(): void {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  const config = loadDatabaseConfig(repoRoot);
  const allowedArgs = new Set(["--require-current"]);
  const unknownArgs = process.argv
    .slice(2)
    .filter((arg) => !allowedArgs.has(arg));
  if (unknownArgs.length > 0) {
    throw new Error(`Unknown db:check option: ${unknownArgs[0]}`);
  }
  const result = validateDatabaseFile(config.dbFile, {
    requireCurrent: process.argv.includes("--require-current"),
  });
  console.log(
    `[db:check] integrity=${result.integrity}; schema=${result.schema}; version=${result.schemaVersion}`,
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown failure";
  console.error(`[db:check][error] ${message}`);
  process.exitCode = 1;
}
