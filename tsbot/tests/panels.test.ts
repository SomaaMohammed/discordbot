import { PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { GuildRuntime } from "../src/runtime.js";
import {
  canSendPanelToChannel,
  getRolePanelSafetyError,
  handlePanelButton,
  handlePanelCommand,
  handlePanelModal,
} from "../src/discord/panels.js";

const GUILD_ID = "123456789012345678";

function createRoleHarness(
  options: {
    roleId?: string;
    managed?: boolean;
    rolePosition?: number;
    actorPosition?: number;
    botPosition?: number;
    rolePermissions?: bigint[];
    channelAllowPermissions?: bigint[];
    botCanManage?: boolean;
  } = {},
) {
  const rolePosition = options.rolePosition ?? 2;
  const roleId = options.roleId ?? "333333333333333333";
  const rolePermissions = options.rolePermissions ?? [];
  const channelAllowPermissions = options.channelAllowPermissions ?? [];
  const role = {
    id: roleId,
    guild: {
      id: GUILD_ID,
      ownerId: "999999999999999999",
      channels: {
        cache: new Map(
          channelAllowPermissions.length === 0
            ? []
            : [
                [
                  "433333333333333333",
                  {
                    permissionOverwrites: {
                      cache: new Map([
                        [
                          roleId,
                          {
                            allow: {
                              bitfield: channelAllowPermissions.reduce(
                                (mask, permission) => mask | permission,
                                0n,
                              ),
                              has: (permission: bigint) =>
                                channelAllowPermissions.includes(permission),
                            },
                          },
                        ],
                      ]),
                    },
                  },
                ],
              ],
        ),
      },
    },
    managed: options.managed ?? false,
    permissions: {
      bitfield: rolePermissions.reduce(
        (mask, permission) => mask | permission,
        0n,
      ),
      has: (permission: bigint) => rolePermissions.includes(permission),
    },
  };
  const actor = {
    id: "223456789012345678",
    roles: {
      highest: {
        comparePositionTo: vi.fn(
          () => (options.actorPosition ?? 5) - rolePosition,
        ),
      },
    },
  };
  const bot = {
    permissions: {
      has: vi.fn(() => options.botCanManage ?? true),
    },
    roles: {
      highest: {
        comparePositionTo: vi.fn(
          () => (options.botPosition ?? 6) - rolePosition,
        ),
      },
    },
  };
  return { role, actor, bot };
}

describe("role-panel safety", () => {
  it.each([
    PermissionFlagsBits.Administrator,
    PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.ModerateMembers,
    PermissionFlagsBits.MentionEveryone,
    PermissionFlagsBits.CreateEvents,
    PermissionFlagsBits.ViewCreatorMonetizationAnalytics,
  ])("rejects self-assignment of dangerous permission %s", (permission) => {
    const { role, actor, bot } = createRoleHarness({
      rolePermissions: [permission],
    });
    expect(
      getRolePanelSafetyError(
        role as never,
        actor as never,
        bot as never,
        GUILD_ID,
      ),
    ).toContain("safe self-service");
  });

  it("rejects roles with sensitive channel-specific access", () => {
    const { role, actor, bot } = createRoleHarness({
      channelAllowPermissions: [PermissionFlagsBits.ManageMessages],
    });
    expect(
      getRolePanelSafetyError(
        role as never,
        actor as never,
        bot as never,
        GUILD_ID,
      ),
    ).toContain("channel permission overrides");
  });

  it("fails closed on permission bits newer than the allowlist", () => {
    const { role, actor, bot } = createRoleHarness({
      rolePermissions: [1n << 60n],
    });
    expect(
      getRolePanelSafetyError(
        role as never,
        actor as never,
        bot as never,
        GUILD_ID,
      ),
    ).toContain("safe self-service");
  });

  it("rejects roles above either the administrator or the bot", () => {
    const actorLow = createRoleHarness({ actorPosition: 1 });
    expect(
      getRolePanelSafetyError(
        actorLow.role as never,
        actorLow.actor as never,
        actorLow.bot as never,
        GUILD_ID,
      ),
    ).toContain("Your highest role");

    const botLow = createRoleHarness({ botPosition: 1 });
    expect(
      getRolePanelSafetyError(
        botLow.role as never,
        botLow.actor as never,
        botLow.bot as never,
        GUILD_ID,
      ),
    ).toContain("Superior's highest role");
  });

  it("accepts an ordinary unmanaged role below both hierarchies", () => {
    const { role, actor, bot } = createRoleHarness();
    expect(
      getRolePanelSafetyError(
        role as never,
        actor as never,
        bot as never,
        GUILD_ID,
      ),
    ).toBeNull();
  });
});

describe("panel delivery safety", () => {
  it("uses Send Messages in Threads for /say thread targets", async () => {
    const has = vi.fn(
      (permission: bigint) =>
        permission === PermissionFlagsBits.ViewChannel ||
        permission === PermissionFlagsBits.SendMessagesInThreads,
    );
    const send = vi.fn(async () => undefined);
    const guild: Record<string, unknown> = { id: GUILD_ID };
    const channel = {
      id: "323456789012345678",
      guild,
      isDMBased: vi.fn(() => false),
      isTextBased: vi.fn(() => true),
      isThread: vi.fn(() => true),
      permissionsFor: vi.fn(() => ({ has })),
      send,
    };
    const botMember = { id: "bot", guild };
    guild.members = { me: botMember };
    const interaction: Record<string, unknown> = {
      guild,
      channel,
      options: {
        getSubcommand: vi.fn(() => "say"),
        getChannel: vi.fn(() => channel),
        getString: vi.fn((name: string) =>
          name === "message" ? "Thread announcement" : null,
        ),
        getBoolean: vi.fn(() => false),
      },
      deferred: false,
      replied: false,
      editReply: vi.fn(async () => undefined),
      reply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
    };
    interaction.deferReply = vi.fn(async () => {
      interaction.deferred = true;
    });
    const runtime = {
      guildId: GUILD_ID,
      isCurrent: vi.fn(() => true),
      storage: { recordCommandMetric: vi.fn() },
    } as unknown as GuildRuntime;

    await handlePanelCommand(interaction as never, runtime, { guild } as never);

    expect(send).toHaveBeenCalledTimes(1);
    expect(has).toHaveBeenCalledWith(PermissionFlagsBits.SendMessagesInThreads);
    expect(has).not.toHaveBeenCalledWith(PermissionFlagsBits.SendMessages);
  });

  it("uses Send Messages in Threads for thread targets", () => {
    const has = vi.fn(
      (permission: bigint) =>
        permission === PermissionFlagsBits.ViewChannel ||
        permission === PermissionFlagsBits.SendMessagesInThreads ||
        permission === PermissionFlagsBits.EmbedLinks,
    );
    const channel = {
      isThread: vi.fn(() => true),
      permissionsFor: vi.fn(() => ({ has })),
    };

    expect(canSendPanelToChannel(channel as never, {} as never)).toBe(true);
    expect(has).toHaveBeenCalledWith(PermissionFlagsBits.SendMessagesInThreads);
    expect(has).not.toHaveBeenCalledWith(PermissionFlagsBits.SendMessages);
  });

  it("revalidates the DM recipient as a current guild member before delivery", async () => {
    const senderId = "523456789012345678";
    const targetId = "623456789012345678";
    const panelId = "723456789012345678";
    const fetch = vi.fn(async (id: string) =>
      id === senderId ? { id, guild: { id: GUILD_ID } } : null,
    );
    const interaction = {
      customId: `superior:dm-modal:${targetId}:${panelId}`,
      guild: { id: GUILD_ID, name: "Test Guild", members: { fetch } },
      user: { id: senderId, tag: "sender" },
      fields: { getTextInputValue: vi.fn(() => "Hello") },
      deferred: false,
      replied: false,
      deferReply: vi.fn(async function (this: { deferred: boolean }) {
        interaction.deferred = true;
      }),
      editReply: vi.fn(async () => undefined),
      reply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
    };
    const runtime = {
      guildId: GUILD_ID,
      isCurrent: vi.fn(() => true),
      storage: { recordCommandMetric: vi.fn() },
    } as unknown as GuildRuntime;

    await handlePanelModal(interaction as never, runtime);

    expect(interaction.deferReply).toHaveBeenCalledBefore(fetch);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("has left or was deleted"),
      }),
    );
  });

  it("reports a deleted role precisely without disrupting another panel router", async () => {
    const userId = "523456789012345678";
    const roleId = "623456789012345678";
    const targetId = "723456789012345678";
    const botId = "823456789012345678";
    const messageId = "923456789012345678";
    const guild: Record<string, any> = { id: GUILD_ID };
    const member = {
      id: userId,
      guild,
      roles: {
        cache: new Map(),
        add: vi.fn(),
        remove: vi.fn(),
      },
    };
    const botMember = { id: botId, guild };
    guild.members = {
      me: botMember,
      fetch: vi.fn(async () => member),
      fetchMe: vi.fn(async () => botMember),
    };
    guild.roles = { fetch: vi.fn(async () => null) };
    const runtime = {
      guildId: GUILD_ID,
      isCurrent: vi.fn(() => true),
      storage: { recordCommandMetric: vi.fn() },
    } as unknown as GuildRuntime;
    const deletedRole = {
      customId: `superior:role:${roleId}`,
      guild,
      user: { id: userId },
      client: { user: { id: botId } },
      message: { id: messageId, author: { id: botId } },
      deferred: false,
      replied: false,
      deferReply: vi.fn(async () => {
        deletedRole.deferred = true;
      }),
      editReply: vi.fn(async () => undefined),
      reply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
    };

    expect(await handlePanelButton(deletedRole as never, runtime)).toBe(true);
    expect(deletedRole.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining(
          "role configured on this panel was deleted",
        ),
      }),
    );
    expect(member.roles.add).not.toHaveBeenCalled();
    expect(member.roles.remove).not.toHaveBeenCalled();

    const privateMessage = {
      customId: `superior:dm:${targetId}`,
      guild,
      user: { id: userId },
      client: { user: { id: botId } },
      message: { id: messageId, author: { id: botId } },
      showModal: vi.fn(async () => undefined),
    };
    expect(await handlePanelButton(privateMessage as never, runtime)).toBe(
      true,
    );
    expect(privateMessage.showModal).toHaveBeenCalledTimes(1);
  });

  it("recovers precisely from Discord 50013 without disrupting the DM router", async () => {
    const userId = "523456789012345678";
    const roleId = "623456789012345678";
    const targetId = "723456789012345678";
    const botId = "823456789012345678";
    const messageId = "923456789012345678";
    const guild: Record<string, any> = {
      id: GUILD_ID,
      ownerId: "133456789012345678",
      channels: { cache: new Map() },
    };
    const role = {
      id: roleId,
      name: "Member",
      guild,
      managed: false,
      permissions: { bitfield: 0n },
    };
    const permissionError = Object.assign(new Error("Missing Permissions"), {
      code: 50_013,
    });
    const member = {
      id: userId,
      guild,
      roles: {
        cache: new Map(),
        add: vi.fn(async () => Promise.reject(permissionError)),
        remove: vi.fn(async () => undefined),
      },
    };
    const botMember = {
      id: botId,
      guild,
      permissions: { has: vi.fn(() => true) },
      roles: { highest: { comparePositionTo: vi.fn(() => 1) } },
    };
    guild.members = {
      me: botMember,
      fetch: vi.fn(async () => member),
      fetchMe: vi.fn(async () => botMember),
    };
    guild.roles = { fetch: vi.fn(async () => role) };
    const runtime = {
      guildId: GUILD_ID,
      isCurrent: vi.fn(() => true),
      storage: { recordCommandMetric: vi.fn() },
    } as unknown as GuildRuntime;
    const roleInteraction = {
      customId: `superior:role:${roleId}`,
      guild,
      user: { id: userId },
      client: { user: { id: botId } },
      message: { id: messageId, author: { id: botId } },
      deferred: false,
      replied: false,
      deferReply: vi.fn(async () => {
        roleInteraction.deferred = true;
      }),
      editReply: vi.fn(async () => undefined),
      reply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
    };

    expect(await handlePanelButton(roleInteraction as never, runtime)).toBe(
      true,
    );
    expect(member.roles.add).toHaveBeenCalledWith(
      role,
      "Self-service role panel",
    );
    expect(roleInteraction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringMatching(/Manage Roles.*highest role/iu),
      }),
    );

    const privateMessage = {
      customId: `superior:dm:${targetId}`,
      guild,
      user: { id: userId },
      client: { user: { id: botId } },
      message: { id: messageId, author: { id: botId } },
      showModal: vi.fn(async () => undefined),
    };
    expect(await handlePanelButton(privateMessage as never, runtime)).toBe(
      true,
    );
    expect(privateMessage.showModal).toHaveBeenCalledTimes(1);
  });

  it("rate-limits repeated private messages per guild, panel, and sender", async () => {
    const senderId = "823456789012345678";
    const targetId = "923456789012345678";
    const panelId = "133456789012345678";
    const send = vi.fn(async () => undefined);
    const guild = { id: GUILD_ID, name: "Test Guild" };
    const sender = { id: senderId, guild };
    const target = { id: targetId, guild, user: { bot: false }, send };
    const fetch = vi.fn(async (id: string) =>
      id === senderId ? sender : target,
    );
    const runtime = {
      guildId: GUILD_ID,
      isCurrent: vi.fn(() => true),
      storage: { recordCommandMetric: vi.fn() },
    } as unknown as GuildRuntime;
    const makeInteraction = () => {
      const interaction = {
        customId: `superior:dm-modal:${targetId}:${panelId}`,
        guild: { ...guild, members: { fetch } },
        user: { id: senderId, tag: "sender" },
        fields: { getTextInputValue: vi.fn(() => "Hello") },
        deferred: false,
        replied: false,
        deferReply: vi.fn(async () => {
          interaction.deferred = true;
        }),
        editReply: vi.fn(async () => undefined),
        reply: vi.fn(async () => undefined),
        followUp: vi.fn(async () => undefined),
      };
      return interaction;
    };

    const first = makeInteraction();
    const second = makeInteraction();
    await handlePanelModal(first as never, runtime);
    await handlePanelModal(second as never, runtime);

    expect(send).toHaveBeenCalledTimes(1);
    expect(second.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Please wait"),
      }),
    );
  });
});
