import type { Client } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { DiscordClientWorkLifecycle } from "../src/discord/bot.js";
import { AsyncWorkTracker } from "../src/discord/work-tracker.js";
import type { BotRuntime } from "../src/runtime.js";
import {
  createShutdownCoordinator,
  installProcessFailureHandlers,
  installShutdownSignalHandlers,
  loginWithShutdown,
  type ShutdownCoordinator,
  type ProcessFailureSource,
  type ShutdownSignal,
  type ShutdownSignalSource,
} from "../src/shutdown.js";

const GUILD_ONE = "123456789012345678";
const GUILD_TWO = "234567890123456789";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("graceful shutdown", () => {
  it("is idempotent and keeps storage open until Discord work drains", async () => {
    const calls: string[] = [];
    const drainGate = deferred<void>();
    let storageClosed = false;
    const workLifecycle: DiscordClientWorkLifecycle = {
      stop: vi.fn(() => calls.push("stop")),
      drain: vi.fn(async () => {
        calls.push(`drain:${storageClosed}`);
        await drainGate.promise;
        calls.push(`drained:${storageClosed}`);
        return true;
      }),
    };
    const client = {
      destroy: vi.fn(() => calls.push("destroy")),
    } as unknown as Client;
    const runtime = {
      storage: {
        listActiveGuilds: vi.fn(() => {
          calls.push("list");
          return [{ guildId: GUILD_ONE }, { guildId: GUILD_TWO }];
        }),
        close: vi.fn(() => {
          calls.push("close");
          storageClosed = true;
        }),
      },
      invalidateGuild: vi.fn((guildId: string) =>
        calls.push(`invalidate:${guildId}`),
      ),
    } as unknown as BotRuntime;
    const coordinator = createShutdownCoordinator(client, runtime, {
      timeoutMs: 1_000,
      workLifecycle,
    });

    const first = coordinator.shutdown("first");
    const second = coordinator.shutdown("second");
    expect(second).toBe(first);
    await vi.waitFor(() => {
      expect(workLifecycle.drain).toHaveBeenCalledTimes(1);
    });
    expect(storageClosed).toBe(false);

    drainGate.resolve();
    await expect(first).resolves.toEqual({ drained: true });
    expect(calls).toEqual([
      "stop",
      "list",
      `invalidate:${GUILD_ONE}`,
      `invalidate:${GUILD_TWO}`,
      "drain:false",
      "drained:false",
      "destroy",
      "close",
    ]);
    expect(workLifecycle.stop).toHaveBeenCalledTimes(1);
    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(runtime.storage.close).toHaveBeenCalledTimes(1);
  });

  it("closes storage after a bounded drain timeout", async () => {
    const tracker = new AsyncWorkTracker();
    const never = new Promise<void>(() => undefined);
    void tracker.run(() => never);
    const workLifecycle: DiscordClientWorkLifecycle = {
      stop: () => tracker.stopAccepting(),
      drain: (timeoutMs) => tracker.drain(timeoutMs),
    };
    const close = vi.fn();
    const runtime = {
      storage: {
        listActiveGuilds: vi.fn(() => []),
        close,
      },
      invalidateGuild: vi.fn(),
    } as unknown as BotRuntime;
    const client = { destroy: vi.fn() } as unknown as Client;
    const coordinator = createShutdownCoordinator(client, runtime, {
      timeoutMs: 10,
      workLifecycle,
    });

    await expect(coordinator.shutdown("timeout-test")).resolves.toEqual({
      drained: false,
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("awaits signal-triggered cleanup without forcing process exit", async () => {
    const shutdownGate = deferred<{ drained: boolean }>();
    const shutdown = vi.fn(() => shutdownGate.promise);
    const coordinator = { shutdown } as ShutdownCoordinator;
    const listeners = new Map<ShutdownSignal, () => void | Promise<void>>();
    const source: ShutdownSignalSource = {
      once: vi.fn((signal, listener) => {
        listeners.set(signal, listener);
      }),
      off: vi.fn((signal, listener) => {
        if (listeners.get(signal) === listener) {
          listeners.delete(signal);
        }
      }),
    };
    const uninstall = installShutdownSignalHandlers(coordinator, source);

    const signalRun = Promise.resolve(listeners.get("SIGTERM")?.());
    await vi.waitFor(() => {
      expect(shutdown).toHaveBeenCalledWith("SIGTERM");
    });
    let completed = false;
    void signalRun.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    shutdownGate.resolve({ drained: true });
    await signalRun;
    expect(completed).toBe(true);

    uninstall();
    expect(source.off).toHaveBeenCalledTimes(2);
    expect(listeners).toHaveLength(0);
  });

  it("uses the same shutdown coordinator after a startup login failure", async () => {
    const loginError = new Error("injected login failure");
    const client = {
      login: vi.fn(async () => {
        throw loginError;
      }),
    };
    const shutdown = vi.fn(async () => ({ drained: true }));
    const coordinator = { shutdown } as ShutdownCoordinator;
    const removeSignalHandlers = vi.fn();

    await expect(
      loginWithShutdown(
        client,
        "test-token",
        coordinator,
        removeSignalHandlers,
      ),
    ).rejects.toBe(loginError);
    expect(client.login).toHaveBeenCalledWith("test-token");
    expect(removeSignalHandlers).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledWith("startup-login-failure");
  });

  it("routes process-level fatal errors through one controlled shutdown", async () => {
    const shutdown = vi.fn(async () => ({ drained: true }));
    const coordinator = { shutdown } as ShutdownCoordinator;
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const source: ProcessFailureSource = {
      exitCode: null,
      on: vi.fn((event, listener) => {
        listeners.set(event, listener);
      }),
      off: vi.fn((event, listener) => {
        if (listeners.get(event) === listener) listeners.delete(event);
      }),
    };
    const uninstall = installProcessFailureHandlers(coordinator, source);

    listeners.get("unhandledRejection")?.(
      Object.assign(new Error("synthetic rejection"), {
        code: "SQLITE_BUSY",
      }),
    );
    listeners.get("uncaughtException")?.(
      new Error("secondary fatal error"),
      "uncaughtException",
    );
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledTimes(1));

    expect(shutdown).toHaveBeenCalledWith("fatal-unhandled-rejection");
    expect(source.exitCode).toBe(1);
    uninstall();
    expect(source.off).toHaveBeenCalledTimes(3);
    expect(listeners.size).toBe(0);
  });
});
