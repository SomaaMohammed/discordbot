import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProcessConfig } from "./config.js";

function main(): void {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  loadProcessConfig(repoRoot);
  console.log("[config:check] process configuration is valid; values were not printed.");
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown failure";
  console.error(`[config:check][error] ${message}`);
  process.exitCode = 1;
}
