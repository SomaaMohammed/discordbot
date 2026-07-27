import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client, Guild } from "discord.js";
import { DateTime } from "luxon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultGuildSettings } from "../src/guild-settings.js";
import {
  runAcrossEnabledGuilds,
  runThreadCloser,
  runWeeklyDigest,
  wireRuntimeParity,
} from "../src/discord/runtime-parity.js";
import { createRuntime, type BotRuntime, type GuildRuntime } from "../src/runtime.js";
import { GuildSettingsConflictError } from "../src/storage/db.js";

const GUILD_A = "111111111111111111";
const GUILD_B = "222222222222222222";
const roots: string[] = [];
const realRuntimes: BotRuntime[] = [];

afterEach(() => {
  for (const runtime of realRuntimes.splice(0)) {
    runtime.storage.close();
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function enabledGuildRuntime(guildId: string): GuildRuntime {
  const settings = createDefaultGuildSettings();
  settings.enabled = true;
  return {
    guildId,
    botVersion: "test",
    settings,
    generation: 0,
    isCurrent: () => true,
    invalidate: vi.fn(),
  } as unknown as GuildRuntime;
}

function schedulerRuntime(
  guildIds: string[],
  guildRuntimes: Map<string, GuildRuntime>,
  concurrency = 2,
): BotRuntime {
  return {
    processConfig: { schedulerConcurrency: concurrency },
    storage: {
      listEnabledGuilds: vi.fn(() =>
        guildIds.map((guildId) => ({ guildId })),
      ),
    },
    forGuild: vi.fn(async (guildId: string) =>
      guildRuntimes.get(guildId) ?? null,
    ),
  } as unknown as BotRuntime;
}

function schedulerClient(): Client {
  return {
    guilds: {
      fetch: vi.fn(async (guildId: string) => ({ id: guildId })),
    },
  } as unknown as Client;
}

function createRealRuntimeForTest(prefix: string): BotRuntime {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  fs.mkdirSync(path.join(root, "data", "bootstrap"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "data", "bootstrap", "questions.json"),
    JSON.stringify({ general: ["Seed?"] }),
  );
  const runtime = createRuntime(
    {
      discordToken: "synthetic-token",
      botVersion: "2.0.0-test",
      dbFile: path.join(root, "runtime.db"),
      commandRegistrationMode: "global",
      devGuildIds: [],
      botOperatorUserIds: [],
      schedulerConcurrency: 2,
    },
    root,
  );
  realRuntimes.push(runtime);
  return runtime;
}

describe("runtime tenant isolation", () => {
  it("does not record message metrics for a disabled guild", async () => {
    const callbacks = new Map<string, (...args: unknown[]) => unknown>();
    const client = {
      on: vi.fn((event: string, callback: (...args: unknown[]) => unknown) => {
        callbacks.set(event, callback);
      }),
      once: vi.fn((event: string, callback: (...args: unknown[]) => unknown) => {
        callbacks.set(event, callback);
      }),
    } as unknown as Client;
    const settings = createDefaultGuildSettings();
    const metricsIncrement = vi.fn();
    const guildRuntime = {
      guildId: GUILD_A,
      settings,
      storage: { metricsIncrement },
    } as unknown as GuildRuntime;
    const runtime = {
      forGuild: vi.fn(async () => guildRuntime),
    } as unknown as BotRuntime;
    wireRuntimeParity(client, runtime);

    await callbacks.get("messageCreate")?.({
      guildId: GUILD_A,
      guild: { id: GUILD_A },
      author: { bot: false },
    });

    expect(runtime.forGuild).toHaveBeenCalledWith(GUILD_A);
    expect(metricsIncrement).not.toHaveBeenCalled();
  });

  it("does not record event metrics for an unconfigured guild", async () => {
    const callbacks = new Map<string, (...args: unknown[]) => unknown>();
    const client = {
      on: vi.fn((event: string, callback: (...args: unknown[]) => unknown) => {
        callbacks.set(event, callback);
      }),
    } as unknown as Client;
    const runtime = {
      forGuild: vi.fn(async () => null),
    } as unknown as BotRuntime;
    wireRuntimeParity(client, runtime);

    await callbacks.get("messageCreate")?.({
      guildId: GUILD_A,
      guild: { id: GUILD_A },
      author: { bot: false },
    });
    await callbacks.get("messageReactionAdd")?.(
      {
        message: {
          partial: false,
          guildId: GUILD_A,
          guild: { id: GUILD_A },
        },
      },
      { bot: false },
    );

    expect(runtime.forGuild).toHaveBeenCalledTimes(2);
  });

  it("does not record reaction metrics through a stale guild runtime", async () => {
    const callbacks = new Map<string, (...args: unknown[]) => unknown>();
    const client = {
      on: vi.fn((event: string, callback: (...args: unknown[]) => unknown) => {
        callbacks.set(event, callback);
      }),
    } as unknown as Client;
    const settings = createDefaultGuildSettings();
    settings.enabled = true;
    const metricsIncrement = vi.fn();
    const isCurrent = vi.fn(() => false);
    const guildRuntime = {
      guildId: GUILD_A,
      settings,
      isCurrent,
      storage: {
        metricsIncrement,
        buildUserMetricKey: vi.fn(),
      },
    } as unknown as GuildRuntime;
    const runtime = {
      forGuild: vi.fn(async () => guildRuntime),
    } as unknown as BotRuntime;
    wireRuntimeParity(client, runtime);

    await callbacks.get("messageReactionAdd")?.(
      {
        message: {
          partial: false,
          guildId: GUILD_A,
          guild: { id: GUILD_A },
          author: { id: "333333333333333333", bot: false },
        },
      },
      { id: "444444444444444444", bot: false },
    );

    expect(isCurrent).toHaveBeenCalledTimes(1);
    expect(metricsIncrement).not.toHaveBeenCalled();
  });

  it("isolates a scheduled-task failure to its guild", async () => {
    const runtimes = new Map([
      [GUILD_A, enabledGuildRuntime(GUILD_A)],
      [GUILD_B, enabledGuildRuntime(GUILD_B)],
    ]);
    const runtime = schedulerRuntime([GUILD_A, GUILD_B], runtimes);
    const visited: string[] = [];

    await runAcrossEnabledGuilds(
      schedulerClient(),
      runtime,
      "isolation_test",
      async (guild) => {
        visited.push(guild.id);
        if (guild.id === GUILD_A) {
          throw new Error("synthetic guild failure");
        }
      },
    );

    expect(visited).toEqual(expect.arrayContaining([GUILD_A, GUILD_B]));
  });

  it("does not overlap the same task for the same guild", async () => {
    const runtime = schedulerRuntime(
      [GUILD_A],
      new Map([[GUILD_A, enabledGuildRuntime(GUILD_A)]]),
      1,
    );
    let releaseTask: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      releaseTask = resolve;
    });
    const task = vi.fn(async (_guild: Guild) => {
      markStarted?.();
      await hold;
    });

    const firstTick = runAcrossEnabledGuilds(
      schedulerClient(),
      runtime,
      "overlap_test",
      task,
    );
    await started;
    await runAcrossEnabledGuilds(
      schedulerClient(),
      runtime,
      "overlap_test",
      task,
    );

    expect(task).toHaveBeenCalledTimes(1);
    releaseTask?.();
    await firstTick;
  });

  it("keeps backfill status isolated and stable for each real guild runtime", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "court-runtime-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "data", "bootstrap"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "data", "bootstrap", "questions.json"),
      JSON.stringify({ general: ["Seed?"] }),
    );
    const runtime = createRuntime(
      {
        discordToken: "synthetic-token",
        botVersion: "2.0.0-test",
        dbFile: path.join(root, "runtime.db"),
        commandRegistrationMode: "global",
        devGuildIds: [],
        botOperatorUserIds: [],
        schedulerConcurrency: 2,
      },
      root,
    );
    realRuntimes.push(runtime);
    runtime.storage.ensureGuild(GUILD_A);
    runtime.storage.ensureGuild(GUILD_B);
    runtime.storage.setGuildEnabled(GUILD_A, true);
    runtime.storage.setGuildEnabled(GUILD_B, true);

    const a = await runtime.forGuild(GUILD_A);
    const aAgain = await runtime.forGuild(GUILD_A);
    const b = await runtime.forGuild(GUILD_B);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a?.backfillStatus).toBe(aAgain?.backfillStatus);
    expect(a?.backfillStatus).not.toBe(b?.backfillStatus);

    a!.backfillStatus.running = true;
    a!.backfillStatus.last_status = "running";
    expect(aAgain?.backfillStatus.running).toBe(true);
    expect(b?.backfillStatus.running).toBe(false);

    runtime.invalidateGuild(GUILD_A);
    expect(a?.isCurrent()).toBe(false);
    expect(b?.isCurrent()).toBe(true);
    const refreshedA = await runtime.forGuild(GUILD_A);
    expect(refreshedA?.backfillStatus).toBe(a?.backfillStatus);

    runtime.storage.markGuildLeft(GUILD_A);
    runtime.invalidateGuild(GUILD_A);
    runtime.storage.reactivateGuild(GUILD_A, "Guild A rejoined");
    runtime.invalidateGuild(GUILD_A);
    runtime.storage.setGuildEnabled(GUILD_A, true);
    const rejoinedA = await runtime.forGuild(GUILD_A);
    expect(rejoinedA?.backfillStatus).toBe(a?.backfillStatus);
    expect(rejoinedA?.backfillStatus.running).toBe(true);

    runtime.storage.setGuildEnabled(GUILD_A, false);
    runtime.invalidateGuild(GUILD_A, { forgetBackfillStatus: true });
    runtime.storage.purgeGuild(GUILD_A);
    runtime.storage.ensureGuild(GUILD_A, "Guild A recreated");
    runtime.storage.setGuildEnabled(GUILD_A, true);
    const recreatedA = await runtime.forGuild(GUILD_A);
    expect(recreatedA?.backfillStatus).not.toBe(a?.backfillStatus);
    expect(recreatedA?.backfillStatus).toMatchObject({
      running: false,
      last_status: "never",
      last_summary: null,
      last_error: null,
    });
  });

  it("keeps the settings mutator current while invalidating sibling guild contexts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "court-runtime-generation-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "data", "bootstrap"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "data", "bootstrap", "questions.json"),
      JSON.stringify({ general: ["Seed?"] }),
    );
    const runtime = createRuntime(
      {
        discordToken: "synthetic-token",
        botVersion: "2.0.0-test",
        dbFile: path.join(root, "runtime.db"),
        commandRegistrationMode: "global",
        devGuildIds: [],
        botOperatorUserIds: [],
        schedulerConcurrency: 2,
      },
      root,
    );
    realRuntimes.push(runtime);
    runtime.storage.ensureGuild(GUILD_A);
    runtime.storage.setGuildEnabled(GUILD_A, true);

    const mutator = await runtime.forGuild(GUILD_A);
    const sibling = await runtime.forGuild(GUILD_A);
    expect(mutator).not.toBeNull();
    expect(sibling).not.toBeNull();
    const originalGeneration = mutator!.generation;
    const nextSettings = structuredClone(mutator!.settings);
    nextSettings.timezone = "Asia/Amman";

    await mutator!.saveSettings(nextSettings);

    expect(mutator!.generation).toBeGreaterThan(originalGeneration);
    expect(mutator!.settings.timezone).toBe("Asia/Amman");
    expect(mutator!.isCurrent()).toBe(true);
    expect(sibling!.isCurrent()).toBe(false);
    const refreshed = await runtime.forGuild(GUILD_A);
    expect(refreshed?.isCurrent()).toBe(true);
    expect(refreshed?.settings.timezone).toBe("Asia/Amman");
  });

  it("rejects stale runtime saves instead of clobbering concurrent settings or re-enabling", async () => {
    const runtime = createRealRuntimeForTest("court-runtime-settings-race-");
    runtime.storage.ensureGuild(GUILD_A);
    runtime.storage.setGuildEnabled(GUILD_A, true);

    const stale = (await runtime.forGuild(GUILD_A))!;
    const writer = (await runtime.forGuild(GUILD_A))!;
    const writerSettings = structuredClone(writer.settings);
    writerSettings.timezone = "Asia/Amman";
    await writer.saveSettings(writerSettings);

    const staleSettings = structuredClone(stale.settings);
    staleSettings.labels.emperor = "Concurrent overwrite";
    await expect(stale.saveSettings(staleSettings)).rejects.toBeInstanceOf(
      GuildSettingsConflictError,
    );
    expect(runtime.storage.getGuildSettings(GUILD_A)).toMatchObject({
      enabled: true,
      timezone: "Asia/Amman",
      labels: { emperor: "Emperor" },
    });

    const staleBeforeDisable = (await runtime.forGuild(GUILD_A))!;
    const disabler = (await runtime.forGuild(GUILD_A))!;
    await disabler.setEnabled(false);
    const staleEnabledSettings = structuredClone(staleBeforeDisable.settings);
    staleEnabledSettings.labels.empress = "Stale re-enable";
    await expect(
      staleBeforeDisable.saveSettings(staleEnabledSettings),
    ).rejects.toBeInstanceOf(GuildSettingsConflictError);
    expect(runtime.storage.getGuildSettings(GUILD_A)).toMatchObject({
      enabled: false,
      labels: { empress: "Empress" },
    });
  });

  it("preserves enablement on ordinary writes and conditionally enables only an unchanged snapshot", () => {
    const runtime = createRealRuntimeForTest("court-runtime-enable-race-");
    runtime.storage.ensureGuild(GUILD_A);
    const reviewed = runtime.storage.getGuildSettings(GUILD_A)!;

    const concurrentlyEdited = structuredClone(reviewed);
    concurrentlyEdited.timezone = "Asia/Amman";
    concurrentlyEdited.enabled = true;
    const saved = runtime.storage.saveGuildSettings(
      GUILD_A,
      concurrentlyEdited,
    );
    expect(saved.enabled).toBe(false);
    expect(runtime.storage.getGuild(GUILD_A)?.enabled).toBe(false);

    expect(() =>
      runtime.storage.setGuildEnabled(GUILD_A, true, reviewed),
    ).toThrow(GuildSettingsConflictError);
    expect(runtime.storage.getGuildSettings(GUILD_A)).toMatchObject({
      enabled: false,
      timezone: "Asia/Amman",
    });
  });

  it("maps Sunday schedules correctly and records the guild-local week once", async () => {
    const channelId = "333333333333333333";
    const send = vi.fn(async () => undefined);
    const channel = {
      id: channelId,
      guildId: GUILD_A,
      send,
      isThread: vi.fn(() => true),
    };
    const guild = {
      id: GUILD_A,
      channels: {
        cache: new Map([[channelId, channel]]),
        fetch: vi.fn(async () => channel),
      },
    } as unknown as Guild;
    const settings = createDefaultGuildSettings();
    settings.enabled = true;
    settings.features.weeklyDigest = true;
    settings.channels.weeklyDigest = channelId;
    settings.weeklyDigestSchedule = { weekday: 0, hour: 19 };
    const state = {
      last_weekly_digest_week: null as string | null,
    };
    const runtime = {
      guildId: GUILD_A,
      botVersion: "test",
      settings,
      generation: 0,
      isCurrent: () => true,
      now: () => DateTime.fromISO("2026-07-26T19:00:00Z", { setZone: true }),
      storage: {
        getState: vi.fn(() => state),
        updateStateAtomic: vi.fn((mutator: (value: typeof state) => void) => {
          mutator(state);
          return state;
        }),
        metricsSnapshot: vi.fn(() => ({
          command_usage: {},
          command_failures: {},
          posts_by_category: {},
        })),
        listPostRecords: vi.fn(() => []),
        countAllAnswerRecords: vi.fn(() => 0),
      },
    } as unknown as GuildRuntime;

    await runWeeklyDigest(guild, runtime);
    await runWeeklyDigest(guild, runtime);

    expect(send).toHaveBeenCalledTimes(1);
    expect(state.last_weekly_digest_week).not.toBeNull();
  });

  it("does not close a stored post resolved to another guild", async () => {
    const markPostClosed = vi.fn();
    const settings = createDefaultGuildSettings();
    settings.enabled = true;
    settings.features.court = true;
    const runtime = {
      guildId: GUILD_A,
      botVersion: "test",
      settings,
      generation: 0,
      isCurrent: () => true,
      now: () => DateTime.fromISO("2026-07-26T19:00:00Z", { setZone: true }),
      storage: {
        listPostRecords: vi.fn(() => [
          {
            message_id: "444444444444444444",
            thread_id: null,
            channel_id: "333333333333333333",
            category: "general",
            question: "Stored?",
            posted_at: "2026-07-24T00:00:00Z",
            close_after_hours: 24,
            closed: false,
            closed_at: null,
            close_reason: null,
          },
        ]),
        markPostClosed,
      },
    } as unknown as GuildRuntime;
    const foreignChannel = {
      guildId: GUILD_B,
      isThread: () => false,
      isTextBased: () => true,
    };
    const guild = {
      id: GUILD_A,
      channels: {
        cache: new Map(),
        fetch: vi.fn(async () => foreignChannel),
      },
    } as unknown as Guild;

    await runThreadCloser(guild, runtime);

    expect(markPostClosed).not.toHaveBeenCalled();
  });
});
