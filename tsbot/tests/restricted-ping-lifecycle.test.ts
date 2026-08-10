import type { EventEmitter } from "node:events";
import type { Role, TextChannel } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDiscordClient,
  getDiscordClientWorkLifecycle,
} from "../src/discord/bot.js";
import type { BotRuntime } from "../src/runtime.js";

const GUILD_ID = "111111111111111111";
const ROLE_ID = "222222222222222222";
const CHANNEL_ID = "333333333333333333";

describe("restricted-ping lifecycle cleanup", () => {
  const clients: ReturnType<typeof createDiscordClient>[] = [];

  afterEach(() => {
    for (const client of clients) client.destroy();
    clients.length = 0;
  });

  it("tracks role and channel deletion cleanup through shutdown drain", async () => {
    const cleanupRestrictedPingRole = vi.fn(() => ({
      rolesDeleted: 1,
      mappingsDeleted: 2,
      userCooldownsDeleted: 3,
      roleIds: [ROLE_ID],
    }));
    const cleanupRestrictedPingChannel = vi.fn(() => ({
      rolesDeleted: 0,
      mappingsDeleted: 1,
      userCooldownsDeleted: 0,
      roleIds: [ROLE_ID],
    }));
    const guildStorage = {
      cleanupRestrictedPingRole,
      cleanupRestrictedPingChannel,
    };
    const runtime = {
      storage: {
        getGuild: vi.fn(() => ({ guildId: GUILD_ID })),
        forGuild: vi.fn(() => guildStorage),
      },
      invalidateGuild: vi.fn(),
    } as unknown as BotRuntime;
    const client = createDiscordClient(runtime);
    clients.push(client);
    const emitter = client as unknown as EventEmitter;

    emitter.emit("roleDelete", {
      id: ROLE_ID,
      guild: { id: GUILD_ID },
    } as Role);
    emitter.emit("channelDelete", {
      id: CHANNEL_ID,
      guild: { id: GUILD_ID },
      isDMBased: () => false,
    } as TextChannel);

    const lifecycle = getDiscordClientWorkLifecycle(client);
    await expect(lifecycle?.drain(1_000)).resolves.toBe(true);
    expect(cleanupRestrictedPingRole).toHaveBeenCalledWith(ROLE_ID);
    expect(cleanupRestrictedPingChannel).toHaveBeenCalledWith(CHANNEL_ID);
    expect(runtime.invalidateGuild).toHaveBeenCalledTimes(2);
    expect(runtime.invalidateGuild).toHaveBeenNthCalledWith(1, GUILD_ID);
    expect(runtime.invalidateGuild).toHaveBeenNthCalledWith(2, GUILD_ID);
  });

  it("does not touch storage for DM channel deletion", async () => {
    const runtime = {
      storage: {
        getGuild: vi.fn(),
        forGuild: vi.fn(),
      },
      invalidateGuild: vi.fn(),
    } as unknown as BotRuntime;
    const client = createDiscordClient(runtime);
    clients.push(client);

    (client as unknown as EventEmitter).emit("channelDelete", {
      id: CHANNEL_ID,
      isDMBased: () => true,
    });
    await expect(
      getDiscordClientWorkLifecycle(client)?.drain(1_000),
    ).resolves.toBe(true);
    expect(runtime.storage.getGuild).not.toHaveBeenCalled();
  });
});
