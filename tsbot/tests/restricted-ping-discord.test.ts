import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type Role,
} from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildPingRoleCommandDefinition,
  buildRestrictedPingCommandDefinition,
} from "../src/discord/restricted-ping-command.js";
import {
  executeRestrictedPing,
  inspectRestrictedPingRole,
  type RestrictedPingExecutionResult,
  type RestrictedPingRepository,
} from "../src/discord/restricted-ping-service.js";
import { BotStorage } from "../src/storage/db.js";
import type { RestrictedPingRoleConfiguration } from "../src/types.js";

const GUILD_ID = "111111111111111111";
const ROLE_ID = "222222222222222222";
const SECOND_ROLE_ID = "232323232323232323";
const USER_ID = "333333333333333333";
const BOT_ID = "444444444444444444";
const CHANNEL_ID = "555555555555555555";
const PARENT_ID = "666666666666666666";
const MESSAGE_ID = "777777777777777777";
const RESERVATION_ID = "restricted-ping-reservation-1";

describe("restricted-ping command definitions", () => {
  it("registers the canonical direct role command", () => {
    const command = buildPingRoleCommandDefinition().toJSON();

    expect(command).toMatchObject({
      name: "pingrole",
      dm_permission: false,
      options: [
        expect.objectContaining({ name: "role", type: 8, required: true }),
      ],
    });
  });

  it("registers administrator configuration with bounded options", () => {
    const command =
      buildRestrictedPingCommandDefinition().toJSON() as unknown as {
        dm_permission?: boolean;
        default_member_permissions?: string;
        options?: Array<{
          name: string;
          options?: Array<{
            name: string;
            channel_types?: number[];
            min_value?: number;
            max_value?: number;
            min_length?: number;
            max_length?: number;
          }>;
        }>;
      };
    expect(command.dm_permission).toBe(false);
    expect(command.default_member_permissions).toBe(
      PermissionFlagsBits.Administrator.toString(),
    );
    expect(command.options?.map(({ name }) => name)).toEqual([
      "add",
      "remove",
      "cleanup-role",
      "cleanup-channel",
      "list",
      "info",
      "enable",
      "disable",
      "configure",
    ]);

    const add = command.options?.find(({ name }) => name === "add");
    const channel = add?.options?.find(({ name }) => name === "channel");
    expect(channel?.channel_types).toEqual([
      ChannelType.GuildText,
      ChannelType.GuildAnnouncement,
      ChannelType.GuildForum,
      ChannelType.GuildMedia,
    ]);
    const cleanupRole = command.options?.find(
      ({ name }) => name === "cleanup-role",
    );
    expect(cleanupRole?.options?.[0]).toMatchObject({
      name: "role_id",
      min_length: 17,
      max_length: 20,
    });
    const cleanupChannel = command.options?.find(
      ({ name }) => name === "cleanup-channel",
    );
    expect(cleanupChannel?.options?.[0]).toMatchObject({
      name: "channel_id",
      min_length: 17,
      max_length: 20,
    });
    const configure = command.options?.find(({ name }) => name === "configure");
    expect(
      configure?.options?.find(({ name }) => name === "user_cooldown_seconds"),
    ).toMatchObject({ min_value: 1, max_value: 86_400 });
    expect(
      configure?.options?.find(({ name }) => name === "role_cooldown_seconds"),
    ).toMatchObject({ min_value: 0, max_value: 86_400 });
  });
});

describe("restricted role ping execution", () => {
  it("sends and verifies only the authorized role mention", async () => {
    const harness = createHarness();

    const result = await executeRestrictedPing(harness.options);

    expect(result).toMatchObject({
      status: "sent",
      channelId: CHANNEL_ID,
      messageId: MESSAGE_ID,
    });
    expect(harness.send).toHaveBeenCalledWith({
      content: `<@&${ROLE_ID}>`,
      allowedMentions: {
        roles: [ROLE_ID],
        users: [],
        repliedUser: false,
      },
    });
    const payload = harness.send.mock.calls[0]?.[0] as {
      allowedMentions: Record<string, unknown>;
    };
    expect(payload.allowedMentions).not.toHaveProperty("parse");
    expect(payload.allowedMentions).not.toHaveProperty("everyone");
    expect(
      (harness.send.mock.calls[0]?.[0] as { content: string }).content,
    ).not.toContain("@everyone");
    expect(
      (harness.send.mock.calls[0]?.[0] as { content: string }).content,
    ).not.toContain("@here");
    expect(harness.reserve).toHaveBeenCalledWith({
      roleId: ROLE_ID,
      userId: USER_ID,
      channelId: CHANNEL_ID,
      mappingChannelId: CHANNEL_ID,
      source: "command",
    });
    expect(harness.complete).toHaveBeenCalledWith(RESERVATION_ID, MESSAGE_ID);
    expect(harness.release).not.toHaveBeenCalled();
  });

  it("denies a member who no longer has the selected role", async () => {
    const harness = createHarness({ memberHasRole: false });

    await expect(executeRestrictedPing(harness.options)).resolves.toMatchObject(
      { status: "member-missing-role" },
    );
    expect(harness.reserve).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it("denies a role that is not configured", async () => {
    const harness = createHarness({ configurationState: "missing" });

    await expect(executeRestrictedPing(harness.options)).resolves.toEqual({
      status: "not-configured",
      role: null,
    });
    expect(harness.reserve).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it("denies a disabled configuration before authorization", async () => {
    const harness = createHarness({ configurationState: "disabled" });

    await expect(executeRestrictedPing(harness.options)).resolves.toEqual({
      status: "disabled",
      role: null,
    });
    expect(harness.reserve).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it("rejects a configuration belonging to a different guild", async () => {
    const harness = createHarness({ configurationState: "foreign-guild" });

    await expect(executeRestrictedPing(harness.options)).resolves.toEqual({
      status: "not-configured",
      role: null,
    });
    expect(harness.reserve).not.toHaveBeenCalled();
  });

  it("uses the atomic reservation mapping result for a wrong direct channel", async () => {
    const harness = createHarness({ reservationState: "channel-not-allowed" });

    await expect(executeRestrictedPing(harness.options)).resolves.toMatchObject(
      { status: "channel-not-allowed" },
    );
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.release).not.toHaveBeenCalled();
  });

  it("handles a deleted role without sending or reserving", async () => {
    const harness = createHarness({ roleDeleted: true });

    await expect(executeRestrictedPing(harness.options)).resolves.toEqual({
      status: "role-invalid",
      role: null,
      issue: "role-unavailable",
    });
    expect(harness.reserve).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it("handles a deleted channel without sending or reserving", async () => {
    const harness = createHarness({ channelDeleted: true });

    await expect(executeRestrictedPing(harness.options)).resolves.toMatchObject(
      { status: "channel-unavailable" },
    );
    expect(harness.reserve).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it("rejects current role and channel resources from another guild", async () => {
    const foreignRole = createHarness({ roleGuildMismatch: true });
    await expect(
      executeRestrictedPing(foreignRole.options),
    ).resolves.toMatchObject({
      status: "role-invalid",
      issue: "role-mismatch",
    });
    expect(foreignRole.reserve).not.toHaveBeenCalled();

    const foreignChannel = createHarness({ channelGuildMismatch: true });
    await expect(
      executeRestrictedPing(foreignChannel.options),
    ).resolves.toMatchObject({ status: "channel-unavailable" });
    expect(foreignChannel.reserve).not.toHaveBeenCalled();
  });

  it("rejects bot invokers", async () => {
    const harness = createHarness({ botInvoker: true });

    await expect(executeRestrictedPing(harness.options)).resolves.toEqual({
      status: "bot-invoker",
      role: null,
    });
    expect(harness.reserve).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it("rejects a freshly fetched member with an active communication timeout", async () => {
    const harness = createHarness({ timedOut: true });

    await expect(executeRestrictedPing(harness.options)).resolves.toEqual({
      status: "member-permissions",
      role: null,
    });
    expect(harness.reserve).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it("surfaces persisted cooldown scope and retry time", async () => {
    const harness = createHarness({ reservationState: "user-cooldown" });

    await expect(executeRestrictedPing(harness.options)).resolves.toMatchObject(
      {
        status: "cooldown",
        scope: "user",
        retryAt: "2026-08-10T00:01:00.000Z",
      },
    );
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.release).not.toHaveBeenCalled();
  });

  it("allows only one delivery across two simultaneous executions", async () => {
    const storage = new BotStorage({ dbFile: ":memory:" });
    storage.initStorage();
    storage.ensureGuild(GUILD_ID);
    const guildStorage = storage.forGuild(GUILD_ID);
    guildStorage.addRestrictedPingMapping({
      roleId: ROLE_ID,
      channelId: CHANNEL_ID,
      createdBy: USER_ID,
    });
    const harness = createHarness();
    harness.options.repository = guildStorage;
    let releaseDelivery!: (message: typeof harness.message) => void;
    const heldDelivery = new Promise<typeof harness.message>((resolve) => {
      releaseDelivery = resolve;
    });
    harness.send.mockImplementation(() => heldDelivery);

    try {
      const earlyResults: RestrictedPingExecutionResult[] = [];
      const executions = [
        executeRestrictedPing(harness.options).then((result) => {
          earlyResults.push(result);
          return result;
        }),
        executeRestrictedPing(harness.options).then((result) => {
          earlyResults.push(result);
          return result;
        }),
      ];
      await vi.waitFor(() => {
        expect(harness.send).toHaveBeenCalledTimes(1);
        expect(earlyResults).toHaveLength(1);
      });
      expect(earlyResults[0]).toMatchObject({
        status: "cooldown",
        scope: "active",
      });
      releaseDelivery(harness.message);
      const results = await Promise.all(executions);

      expect(results.map(({ status }) => status).sort()).toEqual([
        "cooldown",
        "sent",
      ]);
      expect(harness.send).toHaveBeenCalledTimes(1);
      expect(guildStorage.getRestrictedPingRole(ROLE_ID)?.successCount).toBe(1);
    } finally {
      storage.close();
    }
  });

  it("uses stable role IDs after renames and evaluates each held role independently", async () => {
    const renamed = createHarness({ roleName: "Renamed Notifications" });
    await expect(executeRestrictedPing(renamed.options)).resolves.toMatchObject(
      { status: "sent" },
    );
    expect(renamed.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: `<@&${ROLE_ID}>` }),
    );

    const secondRole = createHarness({
      roleId: SECOND_ROLE_ID,
      roleName: "Second Notifications",
      memberRoleIds: [ROLE_ID, SECOND_ROLE_ID],
    });
    await expect(
      executeRestrictedPing(secondRole.options),
    ).resolves.toMatchObject({ status: "sent" });
    expect(secondRole.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        roleId: SECOND_ROLE_ID,
        userId: USER_ID,
      }),
    );
    expect(secondRole.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: `<@&${SECOND_ROLE_ID}>` }),
    );
  });

  it("releases a reservation when runtime validity changes before send", async () => {
    const harness = createHarness({ cancelAfterReserve: true });

    await expect(executeRestrictedPing(harness.options)).resolves.toMatchObject(
      { status: "cancelled" },
    );
    expect(harness.release).toHaveBeenCalledWith(
      RESERVATION_ID,
      "Server configuration changed before delivery",
    );
    expect(harness.send).not.toHaveBeenCalled();
  });

  it("uses the exact configured parent for an enabled forum post", async () => {
    const harness = createHarness({ thread: true, allowThreads: true });

    await expect(executeRestrictedPing(harness.options)).resolves.toMatchObject(
      { status: "sent", channelId: CHANNEL_ID },
    );
    expect(harness.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: CHANNEL_ID,
        mappingChannelId: PARENT_ID,
      }),
    );
  });

  it("denies threads conservatively before reserving", async () => {
    const harness = createHarness({ thread: true, allowThreads: false });

    await expect(executeRestrictedPing(harness.options)).resolves.toMatchObject(
      { status: "thread-not-allowed" },
    );
    expect(harness.reserve).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it("releases a reservation when Discord delivery fails", async () => {
    const harness = createHarness({ sendFailure: true });

    await expect(executeRestrictedPing(harness.options)).resolves.toMatchObject(
      { status: "delivery-failed" },
    );
    expect(harness.release).toHaveBeenCalledWith(
      RESERVATION_ID,
      "Discord delivery failed",
    );
    expect(harness.complete).not.toHaveBeenCalled();
  });

  it("deletes an unverified message while retaining its safety reservation", async () => {
    const harness = createHarness({ mentionVerified: false });

    await expect(executeRestrictedPing(harness.options)).resolves.toMatchObject(
      { status: "delivery-unverified" },
    );
    expect(harness.deleteMessage).toHaveBeenCalledOnce();
    expect(harness.release).not.toHaveBeenCalled();
    expect(harness.complete).not.toHaveBeenCalled();
  });

  it("rejects mentionable and privileged roles", async () => {
    const mentionable = createHarness({ roleMentionable: true });
    await expect(
      inspectRestrictedPingRole(mentionable.guild, ROLE_ID),
    ).resolves.toEqual({ valid: false, issue: "role-mentionable" });

    const privileged = createHarness({
      rolePermissions: PermissionFlagsBits.ManageMessages,
    });
    await expect(
      inspectRestrictedPingRole(privileged.guild, ROLE_ID),
    ).resolves.toEqual({ valid: false, issue: "role-dangerous" });

    const everyone = createHarness({ roleEveryone: true });
    await expect(
      inspectRestrictedPingRole(everyone.guild, GUILD_ID),
    ).resolves.toEqual({ valid: false, issue: "role-everyone" });
  });
});

function configuration(
  allowThreads: boolean,
  roleId = ROLE_ID,
): RestrictedPingRoleConfiguration {
  return {
    guildId: GUILD_ID,
    roleId,
    enabled: true,
    userCooldownSeconds: 60,
    roleCooldownSeconds: 30,
    allowThreads,
    bindingsVerifiedAt: "2026-08-10T00:00:00.000Z",
    lastRoleSuccessAt: null,
    successCount: 0,
    createdBy: USER_ID,
    updatedBy: USER_ID,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
  };
}

function createHarness(
  options: {
    memberHasRole?: boolean;
    thread?: boolean;
    allowThreads?: boolean;
    sendFailure?: boolean;
    mentionVerified?: boolean;
    roleMentionable?: boolean;
    rolePermissions?: bigint;
    configurationState?: "active" | "missing" | "disabled" | "foreign-guild";
    reservationState?: "reserved" | "channel-not-allowed" | "user-cooldown";
    roleDeleted?: boolean;
    channelDeleted?: boolean;
    roleGuildMismatch?: boolean;
    channelGuildMismatch?: boolean;
    botInvoker?: boolean;
    timedOut?: boolean;
    roleEveryone?: boolean;
    cancelAfterReserve?: boolean;
    roleId?: string;
    roleName?: string;
    memberRoleIds?: string[];
  } = {},
) {
  const requestedRoleId = options.roleId ?? ROLE_ID;
  const guild = {
    id: GUILD_ID,
    ownerId: "888888888888888888",
  } as unknown as Guild;
  const actor = {
    id: USER_ID,
    guild,
    user: { id: USER_ID, bot: options.botInvoker ?? false },
    isCommunicationDisabled: () => options.timedOut ?? false,
    roles: {
      cache: new Map(
        options.memberHasRole === false
          ? []
          : (options.memberRoleIds ?? [requestedRoleId]).map((roleId) => [
              roleId,
              { id: roleId },
            ]),
      ),
    },
  } as unknown as GuildMember;
  const bot = {
    id: BOT_ID,
    guild,
    user: { id: BOT_ID, bot: true },
  } as unknown as GuildMember;
  const role = {
    id: options.roleEveryone ? GUILD_ID : requestedRoleId,
    guild: options.roleGuildMismatch
      ? { id: "999999999999999999", ownerId: guild.ownerId }
      : guild,
    managed: false,
    mentionable: options.roleMentionable ?? false,
    permissions: { bitfield: options.rolePermissions ?? 0n },
    name: options.roleName ?? "Food",
  } as unknown as Role;
  const actorPermissions = permissions([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.UseApplicationCommands,
    options.thread
      ? PermissionFlagsBits.SendMessagesInThreads
      : PermissionFlagsBits.SendMessages,
  ]);
  const botPermissions = permissions([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.MentionEveryone,
    options.thread
      ? PermissionFlagsBits.SendMessagesInThreads
      : PermissionFlagsBits.SendMessages,
  ]);
  const deleteMessage = vi.fn(async () => undefined);
  const message = {
    id: MESSAGE_ID,
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    mentions: {
      roles: { has: vi.fn(() => options.mentionVerified ?? true) },
    },
    delete: deleteMessage,
  };
  const send = options.sendFailure
    ? vi.fn(async (_payload: unknown) => {
        throw new Error("synthetic Discord failure");
      })
    : vi.fn(async (_payload: unknown) => message);
  const channel = {
    id: CHANNEL_ID,
    guild: options.channelGuildMismatch ? { id: "999999999999999999" } : guild,
    type: options.thread ? ChannelType.PublicThread : ChannelType.GuildText,
    parentId: options.thread ? PARENT_ID : null,
    sendable: true,
    isTextBased: () => true,
    isSendable: () => true,
    isThread: () => options.thread ?? false,
    permissionsFor: (subject: GuildMember) =>
      subject.id === BOT_ID ? botPermissions : actorPermissions,
    send,
  };
  const parent = {
    id: PARENT_ID,
    guild,
    type: ChannelType.GuildForum,
  };
  Object.assign(guild, {
    members: {
      fetch: vi.fn(async () => actor),
      fetchMe: vi.fn(async () => bot),
    },
    roles: { fetch: vi.fn(async () => role) },
    channels: {
      fetch: vi.fn(async (id: string) =>
        id === CHANNEL_ID
          ? options.channelDeleted
            ? null
            : channel
          : id === PARENT_ID
            ? parent
            : null,
      ),
    },
  });
  if (options.roleDeleted) {
    (guild.roles.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  }
  const config = configuration(options.allowThreads ?? false, requestedRoleId);
  if (options.configurationState === "disabled") config.enabled = false;
  if (options.configurationState === "foreign-guild") {
    config.guildId = "999999999999999999";
  }
  const reserve = vi.fn(() =>
    options.reservationState === "channel-not-allowed"
      ? {
          status: "channel-not-allowed" as const,
          configuration: config,
        }
      : options.reservationState === "user-cooldown"
        ? {
            status: "user-cooldown" as const,
            retryAt: "2026-08-10T00:01:00.000Z",
            configuration: config,
          }
        : {
            status: "reserved" as const,
            reservationId: RESERVATION_ID,
            expiresAt: "2026-08-10T00:01:00.000Z",
            configuration: config,
          },
  );
  const complete = vi.fn(() => ({
    status: "completed" as const,
    configuration: config,
    event: {},
  }));
  const release = vi.fn(() => true);
  const repository = {
    getRestrictedPingRole: vi.fn(() =>
      options.configurationState === "missing" ? null : config,
    ),
    reserveRestrictedPing: reserve,
    completeRestrictedPing: complete,
    releaseRestrictedPing: release,
  } as unknown as RestrictedPingRepository;

  const isCurrent = options.cancelAfterReserve
    ? vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false)
    : vi.fn(() => true);
  return {
    guild,
    send,
    reserve,
    complete,
    release,
    deleteMessage,
    message,
    options: {
      guild,
      userId: USER_ID,
      roleId: requestedRoleId,
      channelId: CHANNEL_ID,
      repository,
      isCurrent,
    },
  };
}

function permissions(values: readonly bigint[]) {
  const allowed = new Set(values);
  return { has: (permission: bigint) => allowed.has(permission) };
}
