import type { EventEmitter } from "node:events";
import { DateTime } from "luxon";
import {
  ChannelType,
  type GuildMember,
  type ChatInputCommandInteraction,
  type MessageReaction,
  type Message,
  type User,
} from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDiscordClient,
  getDiscordClientWorkLifecycle,
} from "../src/discord/bot.js";
import { createDefaultGuildSettings } from "../src/guild-settings.js";
import { DEFAULT_BACKFILL_STATUS } from "../src/parity.js";
import type { BotRuntime, GuildRuntime } from "../src/runtime.js";

const GUILD_ID = "123456789012345678";

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

describe("Discord work tracking", () => {
  const clients: ReturnType<typeof createDiscordClient>[] = [];

  afterEach(() => {
    for (const client of clients) {
      client.destroy();
    }
    clients.length = 0;
  });

  it("drains interaction and message handlers through the same lifecycle", async () => {
    const firstRuntime = deferred<GuildRuntime | null>();
    const secondRuntime = deferred<GuildRuntime | null>();
    const thirdRuntime = deferred<GuildRuntime | null>();
    const forGuild = vi
      .fn<BotRuntime["forGuild"]>()
      .mockImplementationOnce(() => firstRuntime.promise)
      .mockImplementationOnce(() => secondRuntime.promise)
      .mockImplementationOnce(() => thirdRuntime.promise);
    const runtime = {
      forGuild,
    } as unknown as BotRuntime;
    const client = createDiscordClient(runtime);
    clients.push(client);
    const emitter = client as unknown as EventEmitter;
    const reply = vi.fn(async () => undefined);
    const interaction = {
      guildId: GUILD_ID,
      guild: { id: GUILD_ID, name: "Tracking Test Guild" },
      commandName: "court",
      options: { getSubcommand: vi.fn(() => "status") },
      reply,
      isAutocomplete: () => false,
      isChatInputCommand: () => true,
      isButton: () => false,
      isModalSubmit: () => false,
    } as unknown as ChatInputCommandInteraction;
    const message = {
      guildId: GUILD_ID,
      guild: { id: GUILD_ID },
      author: { bot: false },
    } as unknown as Message;
    const reaction = {
      message: {
        partial: false,
        guildId: GUILD_ID,
        guild: { id: GUILD_ID },
      },
    } as unknown as MessageReaction;
    const reactionUser = {
      id: "234567890123456789",
      bot: false,
    } as User;

    emitter.emit("interactionCreate", interaction);
    emitter.emit("messageCreate", message);
    emitter.emit("messageReactionAdd", reaction, reactionUser);
    await vi.waitFor(() => {
      expect(forGuild).toHaveBeenCalledTimes(3);
    });

    const workLifecycle = getDiscordClientWorkLifecycle(client);
    expect(workLifecycle).not.toBeNull();
    workLifecycle?.stop();
    let drainCompleted = false;
    const drain = workLifecycle?.drain(1_000).then((result) => {
      drainCompleted = true;
      return result;
    });

    firstRuntime.resolve(null);
    await vi.waitFor(() => {
      expect(reply).toHaveBeenCalledTimes(1);
    });
    expect(drainCompleted).toBe(false);

    secondRuntime.resolve(null);
    await Promise.resolve();
    expect(drainCompleted).toBe(false);

    thirdRuntime.resolve(null);
    await expect(drain).resolves.toBe(true);
    expect(drainCompleted).toBe(true);
  });

  it("keeps archived-thread backfill discovery in the interaction drain", async () => {
    const archivedDiscovery = deferred<{ threads: Map<string, never> }>();
    const fetchArchived = vi.fn(
      async (options: { type: "public" | "private" }) =>
        options.type === "public"
          ? archivedDiscovery.promise
          : { threads: new Map<string, never>() },
    );
    const historyChannel = {
      id: "234567890123456789",
      type: ChannelType.GuildText,
      threads: { fetchArchived },
      messages: {
        fetch: vi.fn(async () => ({
          size: 0,
          values: () => new Map().values(),
          last: () => undefined,
        })),
      },
    };
    const actor = {
      id: "345678901234567890",
      permissions: { has: vi.fn(() => true) },
    } as unknown as GuildMember;
    const guild = {
      id: GUILD_ID,
      name: "Backfill Tracking Guild",
      ownerId: actor.id,
      members: { fetch: vi.fn(async () => actor) },
      channels: {
        cache: new Map([[historyChannel.id, historyChannel]]),
        fetchActiveThreads: vi.fn(async () => ({
          threads: new Map<string, never>(),
        })),
      },
    };
    const settings = createDefaultGuildSettings();
    settings.enabled = true;
    const mergeUserMetricBackfill = vi.fn(() => [0, 0] as [number, number]);
    const guildRuntime = {
      guildId: GUILD_ID,
      botVersion: "2.0.1-test",
      settings,
      storage: {
        recordCommandMetric: vi.fn(),
        mergeUserMetricBackfill,
      },
      backfillStatus: structuredClone(DEFAULT_BACKFILL_STATUS),
      generation: 0,
      now: () => DateTime.utc(),
      randomInt: () => 0,
      isCurrent: () => true,
    } as unknown as GuildRuntime;
    const runtime = {
      forGuild: vi.fn(async () => guildRuntime),
    } as unknown as BotRuntime;
    const client = createDiscordClient(runtime);
    clients.push(client);
    const emitter = client as unknown as EventEmitter;
    const reply = vi.fn(async () => undefined);
    const interaction = {
      guildId: GUILD_ID,
      guild,
      commandName: "invictus",
      options: {
        getSubcommand: vi.fn(() => "backfillstats"),
        getInteger: vi.fn(() => 0),
      },
      user: {
        id: actor.id,
        toString: () => `<@${actor.id}>`,
      },
      reply,
      editReply: vi.fn(async () => undefined),
      isAutocomplete: () => false,
      isChatInputCommand: () => true,
      isButton: () => false,
      isModalSubmit: () => false,
    } as unknown as ChatInputCommandInteraction;

    emitter.emit("interactionCreate", interaction);
    await vi.waitFor(() => {
      expect(fetchArchived).toHaveBeenCalledWith({
        type: "public",
        fetchAll: true,
      });
    });

    const workLifecycle = getDiscordClientWorkLifecycle(client);
    expect(workLifecycle).not.toBeNull();
    workLifecycle?.stop();
    let drainCompleted = false;
    const drain = workLifecycle?.drain(1_000).then((result) => {
      drainCompleted = true;
      return result;
    });
    await Promise.resolve();
    expect(drainCompleted).toBe(false);

    archivedDiscovery.resolve({ threads: new Map<string, never>() });
    await expect(drain).resolves.toBe(true);
    expect(drainCompleted).toBe(true);
    expect(mergeUserMetricBackfill).toHaveBeenCalledTimes(3);
  });
});
