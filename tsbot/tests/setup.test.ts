import {
  ChannelType,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Guild,
} from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { createDefaultGuildSettings } from "../src/guild-settings.js";
import {
  handleSetupCommand,
  validateGuildSetup,
} from "../src/discord/setup.js";
import type { BotRuntime, GuildRuntime } from "../src/runtime.js";
import { GuildSettingsConflictError } from "../src/storage/db.js";

const GUILD_ID = "111111111111111111";
const USER_ID = "222222222222222222";

function buildInteraction(
  subcommand: string,
  options: {
    admin?: boolean;
    owner?: boolean;
    confirmation?: string;
  } = {},
): {
  interaction: ChatInputCommandInteraction;
  reply: ReturnType<typeof vi.fn>;
  editReply: ReturnType<typeof vi.fn>;
} {
  const admin = options.admin ?? true;
  const ownerId = options.owner ? USER_ID : "333333333333333333";
  const actor = {
    id: USER_ID,
    permissions: { has: vi.fn(() => admin) },
  };
  const botMember = {
    permissions: { has: vi.fn(() => true) },
    roles: { highest: { comparePositionTo: vi.fn(() => 1) } },
  };
  const guild = {
    id: GUILD_ID,
    name: "Setup Test",
    ownerId,
    members: {
      fetch: vi.fn(async (id: string) => (id === USER_ID ? actor : null)),
      me: botMember,
      fetchMe: vi.fn(async () => botMember),
    },
    channels: { fetch: vi.fn(async () => null) },
    roles: { cache: new Map(), fetch: vi.fn(async () => null) },
  };
  const reply = vi.fn(async () => undefined);
  const editReply = vi.fn(async () => undefined);
  return {
    interaction: {
      guild,
      guildId: GUILD_ID,
      user: { id: USER_ID },
      options: {
        getSubcommand: vi.fn(() => subcommand),
        getString: vi.fn((name: string) =>
          name === "confirmation" ? options.confirmation ?? null : null,
        ),
      },
      reply,
      editReply,
    } as unknown as ChatInputCommandInteraction,
    reply,
    editReply,
  };
}

function buildGuildRuntime(): GuildRuntime {
  const settings = createDefaultGuildSettings();
  return {
    guildId: GUILD_ID,
    settings,
    storage: { initializeCourtQuestions: vi.fn(() => true) },
    refreshSettings: vi.fn(async () => settings),
    setEnabled: vi.fn(async (enabled: boolean) => {
      settings.enabled = enabled;
      return settings;
    }),
  } as unknown as GuildRuntime;
}

describe("setup administration", () => {
  it("rejects a non-admin who is not the guild owner", async () => {
    const { interaction, reply } = buildInteraction("status", {
      admin: false,
      owner: false,
    });
    const guildRuntime = buildGuildRuntime();

    await handleSetupCommand(
      interaction,
      {} as BotRuntime,
      guildRuntime,
    );

    expect(reply).toHaveBeenCalledWith({
      content:
        "Only the server owner or a member with Administrator permission can use setup.",
      ephemeral: true,
    });
    expect(guildRuntime.setEnabled).not.toHaveBeenCalled();
  });

  it("refuses to enable an incomplete guild", async () => {
    const { interaction, reply } = buildInteraction("enable");
    const guildRuntime = buildGuildRuntime();

    await handleSetupCommand(
      interaction,
      {} as BotRuntime,
      guildRuntime,
    );

    expect(guildRuntime.setEnabled).not.toHaveBeenCalled();
    const payload = reply.mock.calls[0]?.[0] as { content: string };
    expect(payload.content).toContain("Setup is incomplete");
    expect(payload.content).toContain("Enable at least one feature");
  });

  it("validates the latest persisted snapshot before enabling", async () => {
    const { interaction, reply } = buildInteraction("enable");
    const guildRuntime = buildGuildRuntime();
    guildRuntime.settings.features.court = true;
    guildRuntime.settings.courtSchedule.mode = "manual";
    guildRuntime.settings.channels.court = "444444444444444444";
    const latest = createDefaultGuildSettings();
    vi.mocked(guildRuntime.refreshSettings).mockResolvedValue(latest);

    await handleSetupCommand(interaction, {} as BotRuntime, guildRuntime);

    expect(guildRuntime.refreshSettings).toHaveBeenCalledTimes(1);
    expect(guildRuntime.setEnabled).not.toHaveBeenCalled();
    const payload = reply.mock.calls[0]?.[0] as { content: string };
    expect(payload.content).toContain("Setup is incomplete");
    expect(payload.content).toContain("Enable at least one feature");
  });

  it("initializes an enabled court guild's independent question pool", async () => {
    const { interaction } = buildInteraction("enable");
    const guildRuntime = buildGuildRuntime();
    guildRuntime.settings.features.court = true;
    guildRuntime.settings.courtSchedule.mode = "manual";
    guildRuntime.settings.channels.court = "444444444444444444";
    const channel = {
      id: "444444444444444444",
      guildId: GUILD_ID,
      type: ChannelType.GuildText,
      isThread: vi.fn(() => false),
      isTextBased: vi.fn(() => true),
      send: vi.fn(),
      permissionsFor: vi.fn(() => ({ has: vi.fn(() => true) })),
    };
    (
      interaction.guild as unknown as {
        channels: { fetch: ReturnType<typeof vi.fn> };
      }
    ).channels.fetch.mockResolvedValue(channel);

    await handleSetupCommand(
      interaction,
      {} as BotRuntime,
      guildRuntime,
    );

    expect(guildRuntime.storage.initializeCourtQuestions).toHaveBeenCalledTimes(
      1,
    );
    expect(guildRuntime.setEnabled).toHaveBeenCalledWith(true);
  });

  it("fails closed when settings change during validation", async () => {
    const { interaction, reply } = buildInteraction("enable");
    const guildRuntime = buildGuildRuntime();
    guildRuntime.settings.features.court = true;
    guildRuntime.settings.courtSchedule.mode = "manual";
    guildRuntime.settings.channels.court = "444444444444444444";
    const channel = {
      id: "444444444444444444",
      guildId: GUILD_ID,
      type: ChannelType.GuildText,
      isThread: vi.fn(() => false),
      isTextBased: vi.fn(() => true),
      send: vi.fn(),
      permissionsFor: vi.fn(() => ({ has: vi.fn(() => true) })),
    };
    (
      interaction.guild as unknown as {
        channels: { fetch: ReturnType<typeof vi.fn> };
      }
    ).channels.fetch.mockResolvedValue(channel);
    vi.mocked(guildRuntime.setEnabled).mockRejectedValue(
      new GuildSettingsConflictError(GUILD_ID),
    );

    await handleSetupCommand(interaction, {} as BotRuntime, guildRuntime);

    expect(guildRuntime.setEnabled).toHaveBeenCalledWith(true);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({
      content:
        "This server's configuration changed during setup. Review the latest settings and try again.",
      ephemeral: true,
    });
  });

  it("allows only the owner to reach purge confirmation", async () => {
    const { interaction, reply, editReply } = buildInteraction("purge", {
      admin: true,
      owner: false,
      confirmation: `PURGE ${GUILD_ID}`,
    });
    const guildRuntime = buildGuildRuntime();
    const previewGuildPurge = vi.fn();
    const purgeGuild = vi.fn();
    const runtime = {
      storage: { previewGuildPurge, purgeGuild },
      invalidateGuild: vi.fn(),
    } as unknown as BotRuntime;

    await handleSetupCommand(interaction, runtime, guildRuntime);

    expect(reply).toHaveBeenCalledWith({
      content: "Only the server owner can purge retained guild data.",
      ephemeral: true,
    });
    expect(previewGuildPurge).not.toHaveBeenCalled();
    expect(purgeGuild).not.toHaveBeenCalled();
    expect(editReply).not.toHaveBeenCalled();
  });

  it("shows the guild-only purge preview and requires byte-for-byte confirmation", async () => {
    const { interaction, reply, editReply } = buildInteraction("purge", {
      owner: true,
      confirmation: `PURGE ${GUILD_ID} `,
    });
    const guildRuntime = buildGuildRuntime();
    const preview = {
      guildId: GUILD_ID,
      guilds: 1,
      settings: 1,
      kv: 2,
      posts: 3,
      answers: 4,
      metrics: 5,
      cooldowns: 6,
    };
    const previewGuildPurge = vi.fn(() => preview);
    const setGuildEnabled = vi.fn();
    const purgeGuild = vi.fn();
    const runtime = {
      storage: { previewGuildPurge, setGuildEnabled, purgeGuild },
      invalidateGuild: vi.fn(),
    } as unknown as BotRuntime;

    await handleSetupCommand(interaction, runtime, guildRuntime);

    expect(previewGuildPurge).toHaveBeenCalledWith(GUILD_ID);
    const payload = reply.mock.calls[0]?.[0] as { content: string };
    expect(payload.content).toContain(
      "guild=1, settings=1, state/questions=2, posts=3, answers=4, cooldowns=6, metrics=5",
    );
    expect(payload.content).toContain(`Type \`PURGE ${GUILD_ID}\` exactly`);
    expect(setGuildEnabled).not.toHaveBeenCalled();
    expect(purgeGuild).not.toHaveBeenCalled();
    expect(editReply).not.toHaveBeenCalled();
  });

  it("purges only after the owner supplies the exact confirmation", async () => {
    const { interaction, reply, editReply } = buildInteraction("purge", {
      owner: true,
      confirmation: `PURGE ${GUILD_ID}`,
    });
    const guildRuntime = buildGuildRuntime();
    const summary = {
      guildId: GUILD_ID,
      guilds: 1,
      settings: 1,
      kv: 2,
      posts: 3,
      answers: 4,
      metrics: 5,
      cooldowns: 6,
    };
    const previewGuildPurge = vi.fn(() => summary);
    const setGuildEnabled = vi.fn();
    const purgeGuild = vi.fn(() => summary);
    const invalidateGuild = vi.fn();
    const runtime = {
      storage: { previewGuildPurge, setGuildEnabled, purgeGuild },
      invalidateGuild,
    } as unknown as BotRuntime;

    await handleSetupCommand(interaction, runtime, guildRuntime);

    expect(setGuildEnabled).toHaveBeenCalledWith(GUILD_ID, false);
    expect(invalidateGuild).toHaveBeenCalledWith(GUILD_ID, {
      forgetBackfillStatus: true,
    });
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Exact owner confirmation accepted"),
        ephemeral: true,
      }),
    );
    expect(purgeGuild).toHaveBeenCalledWith(GUILD_ID);
    expect(editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("Removal summary"),
    });
  });
});

describe("setup validation", () => {
  it("detects a configured channel that is outside or missing from the guild", async () => {
    const settings = createDefaultGuildSettings();
    settings.features.court = true;
    settings.courtSchedule.mode = "auto";
    settings.channels.court = "444444444444444444";
    const { interaction } = buildInteraction("validate");

    const result = await validateGuildSetup(
      interaction.guild as Guild,
      settings,
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "court channel no longer exists in this server.",
    );
  });

  it("detects moderation permissions and silence-target hierarchy", async () => {
    const settings = createDefaultGuildSettings();
    const targetRoleId = "555555555555555555";
    settings.features.silenceLock = true;
    settings.features.replyModeration = true;
    settings.roles.silenceTargets = [targetRoleId];
    const targetRole = {
      id: targetRoleId,
      guild: { id: GUILD_ID },
      toString: () => `<@&${targetRoleId}>`,
    };
    const botMember = {
      permissions: {
        has: vi.fn(
          (permission: bigint) =>
            permission !== PermissionFlagsBits.ManageRoles &&
            permission !== PermissionFlagsBits.ModerateMembers,
        ),
      },
      roles: { highest: { comparePositionTo: vi.fn(() => 0) } },
    };
    const guild = {
      id: GUILD_ID,
      members: {
        me: botMember,
        fetchMe: vi.fn(async () => botMember),
        fetch: vi.fn(async () => null),
      },
      channels: { fetch: vi.fn(async () => null) },
      roles: {
        cache: new Map([[targetRoleId, targetRole]]),
        fetch: vi.fn(async () => targetRole),
      },
    } as unknown as Guild;

    const result = await validateGuildSetup(guild, settings);

    expect(result.errors).toContain(
      "Silence lock requires the bot Manage Roles permission.",
    );
    expect(result.errors).toContain(
      `Bot role must be above silence-target role <@&${targetRoleId}>.`,
    );
    expect(result.errors).toContain(
      "Reply moderation requires the bot Moderate Members permission.",
    );
  });

  it("reports cross-feature dependencies before enablement", async () => {
    const settings = createDefaultGuildSettings();
    settings.features.anonymousAnswers = true;
    settings.features.royalAfk = true;
    settings.features.silenceLock = true;
    settings.features.greetings = true;
    const { interaction } = buildInteraction("validate");

    const result = await validateGuildSetup(
      interaction.guild as Guild,
      settings,
    );

    expect(result.errors).toEqual(
      expect.arrayContaining([
        "Anonymous answers require the court feature.",
        "Royal AFK/presence requires a royal-alert channel.",
        "Royal AFK/presence requires an Emperor or Empress role.",
        "Silence lock requires at least one silence-target role.",
        "Silence lock requires an Emperor role binding.",
        "Greetings feature requires at least one greeting profile.",
      ]),
    );
  });

  it("checks anonymous-thread permissions and configured role existence", async () => {
    const settings = createDefaultGuildSettings();
    const courtChannelId = "444444444444444444";
    const missingRoleId = "555555555555555555";
    settings.features.court = true;
    settings.features.anonymousAnswers = true;
    settings.courtSchedule.mode = "manual";
    settings.channels.court = courtChannelId;
    settings.roles.staff = [missingRoleId];
    const { interaction } = buildInteraction("validate");
    const channel = {
      id: courtChannelId,
      guildId: GUILD_ID,
      type: ChannelType.GuildText,
      isThread: vi.fn(() => false),
      send: vi.fn(),
      permissionsFor: vi.fn(() => ({
        has: vi.fn(
          (permission: bigint) =>
            permission !== PermissionFlagsBits.ReadMessageHistory &&
            permission !== PermissionFlagsBits.ManageThreads,
        ),
      })),
    };
    (
      interaction.guild as unknown as {
        channels: { fetch: ReturnType<typeof vi.fn> };
      }
    ).channels.fetch.mockResolvedValue(channel);

    const result = await validateGuildSetup(
      interaction.guild as Guild,
      settings,
    );

    expect(result.errors).toContain(
      "court channel is missing 2 required bot permission(s).",
    );
    expect(result.errors).toContain(
      `Configured role \`${missingRoleId}\` no longer exists in this server.`,
    );
  });

  it("rejects a persisted thread as a setup channel binding", async () => {
    const settings = createDefaultGuildSettings();
    const courtChannelId = "444444444444444444";
    settings.features.court = true;
    settings.courtSchedule.mode = "manual";
    settings.channels.court = courtChannelId;
    const { interaction } = buildInteraction("validate");
    const thread = {
      id: courtChannelId,
      guildId: GUILD_ID,
      type: ChannelType.PublicThread,
      isThread: vi.fn(() => true),
      send: vi.fn(),
      permissionsFor: vi.fn(() => ({ has: vi.fn(() => true) })),
    };
    (
      interaction.guild as unknown as {
        channels: { fetch: ReturnType<typeof vi.fn> };
      }
    ).channels.fetch.mockResolvedValue(thread);

    const result = await validateGuildSetup(
      interaction.guild as Guild,
      settings,
    );

    expect(result.errors).toContain(
      "court channel cannot receive bot messages.",
    );
  });
});
