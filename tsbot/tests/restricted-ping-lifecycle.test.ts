import type { EventEmitter } from "node:events";
import type { Role, TextChannel } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDiscordClient,
  getDiscordClientWorkLifecycle,
} from "../src/discord/bot.js";
import type { BotRuntime } from "../src/runtime.js";

const logging = vi.hoisted(() => ({ logInfo: vi.fn() }));

vi.mock("../src/logging.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/logging.js")>()),
  logInfo: logging.logInfo,
}));

const GUILD_ID = "111111111111111111";
const ROLE_ID = "222222222222222222";
const CHANNEL_ID = "333333333333333333";

describe("Discord resource lifecycle cleanup", () => {
  const clients: ReturnType<typeof createDiscordClient>[] = [];

  afterEach(() => {
    for (const client of clients) client.destroy();
    clients.length = 0;
    logging.logInfo.mockReset();
  });

  it("tracks Phase 4 role and channel cleanup through shutdown drain", async () => {
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
    const invalidateOnboardingRole = vi.fn(() => ({
      configurationChanged: 1,
      autorolesChanged: 2,
    }));
    const invalidateRoleMenuRole = vi.fn(() => ({
      menusChanged: 3,
      postsChanged: 4,
    }));
    const invalidateOnboardingChannel = vi.fn(() => ({
      configurationChanged: 5,
    }));
    const markRoleMenuChannelMissing = vi.fn(() => 6);
    const guildStorage = {
      cleanupRestrictedPingRole,
      cleanupRestrictedPingChannel,
      invalidateOnboardingRole,
      invalidateRoleMenuRole,
      invalidateOnboardingChannel,
      markRoleMenuChannelMissing,
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
    expect(invalidateOnboardingRole).toHaveBeenCalledWith(ROLE_ID);
    expect(invalidateRoleMenuRole).toHaveBeenCalledWith(ROLE_ID);
    expect(invalidateOnboardingChannel).toHaveBeenCalledWith(CHANNEL_ID);
    expect(markRoleMenuChannelMissing).toHaveBeenCalledWith(CHANNEL_ID);
    expect(runtime.invalidateGuild).toHaveBeenCalledTimes(2);
    expect(runtime.invalidateGuild).toHaveBeenNthCalledWith(1, GUILD_ID);
    expect(runtime.invalidateGuild).toHaveBeenNthCalledWith(2, GUILD_ID);
    expect(logging.logInfo).toHaveBeenNthCalledWith(
      1,
      "discord-resource-lifecycle",
      "Deleted role bindings were made dormant",
      expect.objectContaining({
        guildId: GUILD_ID,
        roleId: ROLE_ID,
        onboardingConfigurationsChanged: 1,
        onboardingAutorolesChanged: 2,
        roleMenusChanged: 3,
        roleMenuPostsChanged: 4,
      }),
    );
    expect(logging.logInfo).toHaveBeenNthCalledWith(
      2,
      "discord-resource-lifecycle",
      "Deleted channel bindings were made dormant",
      expect.objectContaining({
        guildId: GUILD_ID,
        channelId: CHANNEL_ID,
        onboardingConfigurationsChanged: 5,
        roleMenuPostsChanged: 6,
      }),
    );
  });

  it("marks deleted role-menu messages missing with bounded log metadata", async () => {
    const markRoleMenuMessageMissing = vi.fn(() => 2);
    const runtime = {
      storage: {
        getGuild: vi.fn(() => ({ guildId: GUILD_ID })),
        forGuild: vi.fn(() => ({ markRoleMenuMessageMissing })),
      },
      invalidateGuild: vi.fn(),
    } as unknown as BotRuntime;
    const client = createDiscordClient(runtime);
    clients.push(client);

    (client as unknown as EventEmitter).emit("messageDelete", {
      id: "444444444444444444",
      channelId: CHANNEL_ID,
      guildId: GUILD_ID,
    });

    await expect(
      getDiscordClientWorkLifecycle(client)?.drain(1_000),
    ).resolves.toBe(true);
    expect(markRoleMenuMessageMissing).toHaveBeenCalledWith(
      CHANNEL_ID,
      "444444444444444444",
    );
    expect(logging.logInfo).toHaveBeenCalledWith(
      "discord-resource-lifecycle",
      "Deleted role-menu message marked missing",
      {
        guildId: GUILD_ID,
        channelId: CHANNEL_ID,
        messageId: "444444444444444444",
        roleMenuPostsChanged: 2,
      },
    );
    expect(runtime.invalidateGuild).not.toHaveBeenCalled();
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
