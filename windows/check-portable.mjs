import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const toolsDirectory = path.dirname(fileURLToPath(import.meta.url));
const portableRoot = path.resolve(toolsDirectory, "..");

async function main() {
  const configModuleUrl = pathToFileURL(
    path.join(portableRoot, "app", "dist", "src", "config.js"),
  ).href;
  const sqliteModuleUrl = pathToFileURL(
    path.join(
      portableRoot,
      "app",
      "node_modules",
      "better-sqlite3",
      "lib",
      "index.js",
    ),
  ).href;

  const { loadProcessConfig, resolveApplicationRoot, resolveEnvironmentFile } =
    await import(configModuleUrl);
  const applicationRoot = resolveApplicationRoot(portableRoot);
  const config = loadProcessConfig(applicationRoot);

  const expectedRoot = process.env.SUPERIOR_PORTABLE_EXPECT_ROOT;
  if (expectedRoot && path.resolve(expectedRoot) !== applicationRoot) {
    throw new Error(
      "Portable configuration was not resolved from the launcher directory.",
    );
  }
  const expectedDatabase = process.env.SUPERIOR_PORTABLE_EXPECT_DB;
  if (expectedDatabase && path.resolve(expectedDatabase) !== config.dbFile) {
    throw new Error(
      "The configured database path did not resolve beside the launcher.",
    );
  }
  if (
    expectedRoot &&
    resolveEnvironmentFile(applicationRoot) !==
      path.join(applicationRoot, ".env")
  ) {
    throw new Error(
      "The environment file did not resolve beside the launcher.",
    );
  }

  const sqliteModule = await import(sqliteModuleUrl);
  const Database = sqliteModule.default;
  const database = new Database(":memory:");
  try {
    database.prepare("SELECT 1 AS ready").get();
  } finally {
    database.close();
  }

  console.log(
    "[portable:check] configuration and native SQLite are ready; no Discord login was attempted.",
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown failure";
  console.error(`[portable:check][error] ${message}`);
  process.exitCode = 1;
});
