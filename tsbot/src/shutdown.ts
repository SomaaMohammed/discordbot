import type { Client } from "discord.js";
import {
  getDiscordClientWorkLifecycle,
  type DiscordClientWorkLifecycle,
} from "./discord/bot.js";
import { logClassifiedError, logError, logInfo, logWarn } from "./logging.js";
import type { BotRuntime } from "./runtime.js";
import { clearAntiSpamProcessState } from "./discord/anti-spam-enforcement.js";

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000;

export interface ShutdownResult {
  drained: boolean;
}

export interface ShutdownCoordinator {
  shutdown: (reason: string) => Promise<ShutdownResult>;
}

export interface ShutdownCoordinatorOptions {
  timeoutMs?: number;
  workLifecycle?: DiscordClientWorkLifecycle | null;
}

export type ShutdownSignal = "SIGINT" | "SIGTERM";

export interface ShutdownSignalSource {
  once: (
    event: ShutdownSignal,
    listener: () => void | Promise<void>,
  ) => unknown;
  off: (event: ShutdownSignal, listener: () => void | Promise<void>) => unknown;
}

export interface DiscordLoginClient {
  login: (token: string) => Promise<string>;
}

export interface ProcessFailureSource {
  exitCode?: string | number | null;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  off: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

const noWorkLifecycle: DiscordClientWorkLifecycle = {
  stop: () => undefined,
  drain: async () => true,
};

export function createShutdownCoordinator(
  client: Client,
  runtime: BotRuntime,
  options: ShutdownCoordinatorOptions = {},
): ShutdownCoordinator {
  const workLifecycle =
    options.workLifecycle ??
    getDiscordClientWorkLifecycle(client) ??
    noWorkLifecycle;
  const timeoutMs = Math.max(
    0,
    Math.floor(options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS),
  );
  let shutdownPromise: Promise<ShutdownResult> | null = null;

  const performShutdown = async (reason: string): Promise<ShutdownResult> => {
    logInfo("shutdown", "Graceful shutdown started", { reason, timeoutMs });
    let drained = false;

    try {
      try {
        workLifecycle.stop();
      } catch (error) {
        logError("shutdown", "Failed to stop Discord work scheduling", {
          reason,
          error,
        });
      }

      try {
        const activeGuilds = runtime.storage.listActiveGuilds();
        for (const record of activeGuilds) {
          try {
            runtime.invalidateGuild(record.guildId);
          } catch (error) {
            logError("shutdown", "Failed to invalidate guild work", {
              reason,
              guildId: record.guildId,
              error,
            });
          } finally {
            clearAntiSpamProcessState(record.guildId);
          }
        }
      } catch (error) {
        logError("shutdown", "Failed to enumerate active guilds", {
          reason,
          error,
        });
      }

      try {
        drained = await workLifecycle.drain(timeoutMs);
      } catch (error) {
        logError("shutdown", "Failed while draining Discord work", {
          reason,
          error,
        });
      }

      if (!drained) {
        logWarn("shutdown", "Discord work drain timed out", {
          reason,
          timeoutMs,
        });
      }

      try {
        await client.destroy();
      } catch (error) {
        logError("shutdown", "Failed to destroy Discord client", {
          reason,
          error,
        });
      }
      try {
        runtime.emojiReplies?.close();
      } catch (error) {
        logError("shutdown", "Failed to close emoji reply configuration", {
          reason,
          error,
        });
      }
    } finally {
      try {
        runtime.storage.close();
      } catch (error) {
        logError("shutdown", "Failed to close bot storage", {
          reason,
          error,
        });
      }
    }

    logInfo("shutdown", "Graceful shutdown finished", { reason, drained });
    return { drained };
  };

  return {
    shutdown(reason: string): Promise<ShutdownResult> {
      shutdownPromise ??= performShutdown(reason);
      return shutdownPromise;
    },
  };
}

export function installShutdownSignalHandlers(
  coordinator: ShutdownCoordinator,
  signalSource: ShutdownSignalSource = process as unknown as ShutdownSignalSource,
): () => void {
  const listeners = new Map<ShutdownSignal, () => Promise<void>>();

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const listener = async (): Promise<void> => {
      try {
        await coordinator.shutdown(signal);
      } catch (error) {
        logError("shutdown", "Signal-triggered shutdown failed", {
          signal,
          error,
        });
      }
    };
    listeners.set(signal, listener);
    signalSource.once(signal, listener);
  }

  return (): void => {
    for (const [signal, listener] of listeners) {
      signalSource.off(signal, listener);
    }
  };
}

export function installProcessFailureHandlers(
  coordinator: ShutdownCoordinator,
  source: ProcessFailureSource = process as unknown as ProcessFailureSource,
): () => void {
  let fatalShutdown: Promise<ShutdownResult> | null = null;

  const requestFatalShutdown = (kind: string, error: unknown): void => {
    logClassifiedError("process", error, {
      fatal: true,
      event: kind,
      outcome: "controlled-shutdown-requested",
    });
    source.exitCode = 1;
    fatalShutdown ??= coordinator.shutdown(`fatal-${kind}`);
    void fatalShutdown.catch((shutdownError: unknown) => {
      logClassifiedError("shutdown", shutdownError, {
        fatal: true,
        event: kind,
        stage: "fatal-shutdown",
      });
      source.exitCode = 1;
    });
  };

  const unhandledRejection = (reason: unknown): void => {
    requestFatalShutdown("unhandled-rejection", reason);
  };
  const uncaughtException = (error: unknown, origin: unknown): void => {
    requestFatalShutdown(
      typeof origin === "string"
        ? `uncaught-exception-${origin}`
        : "uncaught-exception",
      error,
    );
  };
  const warning = (value: unknown): void => {
    const nodeWarning =
      value instanceof Error ? value : new Error(String(value));
    logWarn("process", "Node.js emitted a runtime warning", {
      warningName: nodeWarning.name,
      warningCode:
        "code" in nodeWarning
          ? String(
              (nodeWarning as Error & { code?: unknown }).code ?? "unknown",
            )
          : "unknown",
      stack: nodeWarning.stack,
      action:
        "Remove deprecated calls or inspect adjacent runtime diagnostics; warnings do not expose configuration values.",
    });
  };

  source.on("unhandledRejection", unhandledRejection);
  source.on("uncaughtException", uncaughtException);
  source.on("warning", warning);

  return (): void => {
    source.off("unhandledRejection", unhandledRejection);
    source.off("uncaughtException", uncaughtException);
    source.off("warning", warning);
  };
}

export async function loginWithShutdown(
  client: DiscordLoginClient,
  token: string,
  coordinator: ShutdownCoordinator,
  removeSignalHandlers: () => void,
): Promise<void> {
  try {
    await client.login(token);
  } catch (error) {
    removeSignalHandlers();
    await coordinator.shutdown("startup-login-failure");
    throw error;
  }
}
