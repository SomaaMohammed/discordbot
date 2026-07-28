import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProcessConfig, resolveApplicationRoot } from "./config.js";
import { createDiscordClient } from "./discord/bot.js";
import { logError, logInfo } from "./logging.js";
import { createRuntime } from "./runtime.js";
import {
  createShutdownCoordinator,
  installShutdownSignalHandlers,
  loginWithShutdown,
} from "./shutdown.js";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);

// In dev, entrypoint lives at tsbot/src/index.ts; in prod it lives at tsbot/dist/src/index.js.
let tsbotRoot = path.resolve(currentDir, "..");
if (path.basename(tsbotRoot) === "dist") {
  tsbotRoot = path.resolve(tsbotRoot, "..");
}

const repoRoot = resolveApplicationRoot(path.resolve(tsbotRoot, ".."));

async function main(): Promise<void> {
  const config = loadProcessConfig(repoRoot);
  const runtime = createRuntime(config, repoRoot);
  const client = createDiscordClient(runtime);
  const shutdownCoordinator = createShutdownCoordinator(client, runtime);
  const removeShutdownSignalHandlers =
    installShutdownSignalHandlers(shutdownCoordinator);

  logInfo("bootstrap", "Starting TypeScript bot runtime", {
    version: runtime.processConfig.botVersion,
    commandRegistrationMode: runtime.processConfig.commandRegistrationMode,
  });

  await loginWithShutdown(
    client,
    config.discordToken,
    shutdownCoordinator,
    removeShutdownSignalHandlers,
  );
}

try {
  await main();
} catch (error) {
  logError("bootstrap", "Failed to start TypeScript bot", { error });
  process.exitCode = 1;
}
