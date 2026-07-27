import type { Client } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runRetentionCleaner,
  startRuntimeBackgroundLoops,
} from "../src/discord/runtime-parity.js";
import { AsyncWorkTracker } from "../src/discord/work-tracker.js";
import type { BotRuntime, GuildRuntime } from "../src/runtime.js";
import type { Guild } from "discord.js";

describe("runtime background lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules only legacy cleanup and clears every interval idempotently", async () => {
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
    // Thread closure and answer-retention cleanup remain active. The retired
    // court auto-poster and weekly digest are never scheduled.
    expect(listEnabledGuilds).toHaveBeenCalledTimes(2);
    expect(listActiveGuilds).toHaveBeenCalledTimes(1);

    controller.stop();
    controller.stop();
    expect(controller.stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(listEnabledGuilds).toHaveBeenCalledTimes(2);
    expect(listActiveGuilds).toHaveBeenCalledTimes(1);
  });

  it("cleans retained answers even when the retired feature flag is off", async () => {
    const purgeExpiredAnswers = vi.fn(() => 0);
    const runtime = {
      settings: {
        features: { anonymousAnswers: false },
        limits: { answerRetentionDays: 30 },
      },
      storage: { purgeExpiredAnswers },
      isCurrent: () => true,
    } as unknown as GuildRuntime;

    await runRetentionCleaner({} as Guild, runtime);

    expect(purgeExpiredAnswers).toHaveBeenCalledWith(30);
  });
});
