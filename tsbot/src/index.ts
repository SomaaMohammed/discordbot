import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProcessConfig, resolveApplicationRoot } from "./config.js";
import { createDiscordClient } from "./discord/bot.js";
import { logClassifiedError, logInfo } from "./logging.js";
import { createRuntime } from "./runtime.js";
import {
  createShutdownCoordinator,
  installProcessFailureHandlers,
  installShutdownSignalHandlers,
  loginWithShutdown,
  type ShutdownCoordinator,
} from "./shutdown.js";
import { ensureDatabaseCurrent } from "./storage/startup-migration.js";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);

// In dev, entrypoint lives at tsbot/src/index.ts; in prod it lives at tsbot/dist/src/index.js.
let tsbotRoot = path.resolve(currentDir, "..");
if (path.basename(tsbotRoot) === "dist") {
  tsbotRoot = path.resolve(tsbotRoot, "..");
}

const repoRoot = resolveApplicationRoot(path.resolve(tsbotRoot, ".."));

export async function runBot(
  options: { requireLauncherLock?: boolean } = {},
): Promise<void> {
  logInfo("bootstrap", "Selected Superior application root", {
    applicationRoot: repoRoot,
  });
  const config = loadProcessConfig(repoRoot, options);
  if (process.env.SUPERIOR_AUTO_MIGRATE === "1") {
    const migration = await ensureDatabaseCurrent({ dbFile: config.dbFile });
    if (migration.status === "migrated") {
      logInfo("storage-upgrade", "Database upgraded automatically", {
        fromSchema: migration.fromSchema,
        toSchema: migration.schema,
        backupFile: migration.backupFile,
      });
    }
  }
  logInfo("bootstrap", "Process configuration validated", {
    tokenConfigured: Boolean(config.discordToken),
    databaseMode: config.dbFile === ":memory:" ? "memory" : "file",
    commandRegistrationMode: config.commandRegistrationMode,
    developmentGuildCount: config.devGuildIds.length,
  });
  const runtime = createRuntime(config, repoRoot);
  let shutdownCoordinator: ShutdownCoordinator | null = null;
  const client = createDiscordClient(runtime, {
    onFatalGatewayInvalidation: async () => {
      process.exitCode = 1;
      if (!shutdownCoordinator) {
        throw new Error(
          "Discord invalidated the gateway before shutdown coordination was ready",
        );
      }
      await shutdownCoordinator.shutdown("fatal-discord-session-invalidated");
    },
  });
  shutdownCoordinator = createShutdownCoordinator(client, runtime);
  const removeShutdownSignalHandlers =
    installShutdownSignalHandlers(shutdownCoordinator);
  installProcessFailureHandlers(shutdownCoordinator);

  logInfo("bootstrap", "Starting TypeScript bot runtime", {
    version: runtime.processConfig.botVersion,
    commandRegistrationMode: runtime.processConfig.commandRegistrationMode,
  });

  logInfo("discord", "Starting Discord login", {
    commandRegistrationMode: runtime.processConfig.commandRegistrationMode,
  });

  await loginWithShutdown(
    client,
    config.discordToken,
    shutdownCoordinator,
    removeShutdownSignalHandlers,
  );
}

if (import.meta.main) {
  try {
    await runBot();
  } catch (error) {
    logClassifiedError("bootstrap", error, {
      stage: "startup",
      outcome: "startup-failed",
    });
    process.exitCode = 1;
  }
}
