import type { Client } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startRuntimeBackgroundLoops } from "../src/discord/runtime-parity.js";
import { AsyncWorkTracker } from "../src/discord/work-tracker.js";
import type { BotRuntime } from "../src/runtime.js";

describe("runtime background lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retains and clears every scheduler interval idempotently", async () => {
    vi.useFakeTimers();
    const listEnabledGuilds = vi.fn(() => []);
    const listActiveGuilds = vi.fn(() => []);
    const runtime = {
      processConfig: { schedulerConcurrency: 2 },
      storage: { listEnabledGuilds, listActiveGuilds },
    } as unknown as BotRuntime;
    const client = {} as Client;
    const tracker = new AsyncWorkTracker();

    const controller = startRuntimeBackgroundLoops(client, runtime, tracker);
    await expect(controller.drain(1_000)).resolves.toBe(true);
    expect(listEnabledGuilds).toHaveBeenCalledTimes(4);
    expect(listActiveGuilds).toHaveBeenCalledTimes(1);

    controller.stop();
    controller.stop();
    expect(controller.stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(listEnabledGuilds).toHaveBeenCalledTimes(4);
    expect(listActiveGuilds).toHaveBeenCalledTimes(1);
  });
});
