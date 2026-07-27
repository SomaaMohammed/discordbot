import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLegacyMigrationConfig } from "./legacy-v1-settings.js";
import { migrateDatabase } from "./migration.js";

function main(): void {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  const config = loadLegacyMigrationConfig(repoRoot);
  if (config.legacyGuildIdSource === "TEST_GUILD_ID") {
    console.warn(
      "[migration] TEST_GUILD_ID is deprecated; use LEGACY_GUILD_ID for future migration attempts.",
    );
  }

  const result = migrateDatabase({
    dbFile: config.dbFile,
    legacyGuildId: config.legacyGuildId,
    environment: config.environment,
  });
  const copied = Object.entries(result.copiedRows)
    .map(([table, count]) => `${table}=${count}`)
    .join(", ");
  console.log(
    `[migration] ${result.status}; schema v${result.schemaVersion}${copied ? `; copied ${copied}` : ""}`,
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown failure";
  console.error(`[migration][error] ${message}`);
  process.exitCode = 1;
}
