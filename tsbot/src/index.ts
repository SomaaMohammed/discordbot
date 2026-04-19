import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuntimeConfig } from "./config.js";
import { createDiscordClient } from "./discord/bot.js";
import { createRuntime } from "./runtime.js";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const tsbotRoot = path.resolve(currentDir, "..");
const repoRoot = path.resolve(tsbotRoot, "..");

async function main(): Promise<void> {
  const config = loadRuntimeConfig(repoRoot);
  const runtime = createRuntime(config, repoRoot);
  const client = createDiscordClient(runtime);

  await client.login(config.discordToken);
}

try {
  await main();
} catch (error) {
  console.error("Failed to start TypeScript bot", error);
  process.exitCode = 1;
}
