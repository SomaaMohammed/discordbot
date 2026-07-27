import {
  ChannelType,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Guild,
} from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { createDefaultGuildSettings } from "../src/guild-settings.js";
import {
  buildSetupCommandDefinition,
  getFeatureDisplayName,
  handleSetupCommand,
  validateGuildSetup,
} from "../src/discord/setup.js";
import type { BotRuntime, GuildRuntime } from "../src/runtime.js";
import { GuildSettingsConflictError } from "../src/storage/db.js";

const GUILD_ID = "111111111111111111";
const USER_ID = "222222222222222222";
const RETIRED_SETUP_MESSAGE =
  "That Imperial/Court setup option has been retired. Its stored legacy data was not changed.";

interface InteractionOptions {
  admin?: boolean;
  owner?: boolean;
  confirmation?: string;
  strings?: Record<string, string>;
  booleans?: Record<string, boolean>;
  integers?: Record<string, number>;
}

function buildInteraction(
  subcommand: string,
  options: InteractionOptions = {},
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
    channels: { cache: new Map(), fetch: vi.fn(async () => null) },
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
          name === "confirmation"
            ? (options.confirmation ?? null)
            : (options.strings?.[name] ?? null),
        ),
        getBoolean: vi.fn((name: string) => options.booleans?.[name] ?? null),
        getInteger: vi.fn((name: string) => options.integers?.[name] ?? null),
        getChannel: vi.fn(() => null),
        getRole: vi.fn(() => null),
        getUser: vi.fn(() => null),
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
  const guildRuntime = {
    guildId: GUILD_ID,
    settings,
    storage: {
      initializeCourtQuestions: vi.fn(() => true),
      metricsGet: vi.fn((_key: string, defaultValue: string) => defaultValue),
      metricsSet: vi.fn(),
    },
    refreshSettings: vi.fn(async () => settings),
    setEnabled: vi.fn(async (enabled: boolean) => {
      settings.enabled = enabled;
      return settings;
    }),
  } as unknown as GuildRuntime;
  guildRuntime.saveSettings = vi.fn(async (nextSettings) => {
    guildRuntime.settings = structuredClone(nextSettings);
    return guildRuntime.settings;
  });
  return guildRuntime;
}

describe("setup command definition", () => {
  it("registers only the active setup operations and choices", () => {
    const definition = buildSetupCommandDefinition().toJSON();
    const subcommands = (definition.options ?? []) as Array<{
      name: string;
      options?: Array<{
        name: string;
        min_value?: number;
        max_value?: number;
        choices?: Array<{ name: string; value: string }>;
      }>;
    }>;
    const byName = new Map(
      subcommands.map((subcommand) => [subcommand.name, subcommand]),
    );
    const choices = (subcommand: string, option: string) =>
      byName
        .get(subcommand)
        ?.options?.find((candidate) => candidate.name === option)?.choices;

    expect(subcommands.map(({ name }) => name)).toEqual([
      "status",
      "enable",
      "disable",
      "channel",
      "feature",
      "timezone",
      "limits",
      "trigger",
      "greeting",
      "validate",
      "export",
      "purge",
    ]);
    expect(choices("channel", "purpose")).toEqual([
      { name: "log", value: "log" },
    ]);
    expect(byName.has("role")).toBe(false);
    expect(choices("feature", "name")).toEqual([
      { name: "superior-chat", value: "invictusChat" },
      { name: "reply-moderation", value: "replyModeration" },
      { name: "greetings", value: "greetings" },
    ]);
    expect(byName.get("timezone")?.options?.map(({ name }) => name)).toEqual([
      "timezone",
    ]);
    expect(byName.get("limits")?.options).toEqual([
      expect.objectContaining({
        name: "mute_target_cap",
        min_value: 0,
        max_value: 10_000,
      }),
    ]);

    expect(subcommands.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(["schedule", "labels", "champion"]),
    );
    const registeredChoiceValues = subcommands.flatMap((subcommand) =>
      (subcommand.options ?? []).flatMap((option) =>
        (option.choices ?? []).map((choice) => choice.value),
      ),
    );
    expect(registeredChoiceValues).not.toEqual(
      expect.arrayContaining([
        "court",
        "weeklyDigest",
        "royalAlert",
        "staff",
        "privilegedChat",
        "emperor",
        "empress",
        "silenceTargets",
        "silenceExcludes",
        "anonymousRequired",
        "anonymousAnswers",
        "silenceLock",
        "royalAfk",
        "royalPresence",
      ]),
    );
  });
});

describe("setup administration", () => {
  it("presents active feature keys with Superior branding", () => {
    expect(getFeatureDisplayName("invictusChat")).toBe("superior-chat");
    expect(getFeatureDisplayName("replyModeration")).toBe("reply-moderation");
    expect(getFeatureDisplayName("greetings")).toBe("greetings");
  });

  it("rejects a non-admin who is not the guild owner", async () => {
    const { interaction, reply } = buildInteraction("status", {
      admin: false,
      owner: false,
    });
    const guildRuntime = buildGuildRuntime();

    await handleSetupCommand(interaction, {} as BotRuntime, guildRuntime);

    expect(reply).toHaveBeenCalledWith({
      content:
        "Only the server owner or a member with Administrator permission can use setup.",
      ephemeral: true,
    });
    expect(guildRuntime.setEnabled).not.toHaveBeenCalled();
  });

  it("enables zero optional features and ignores legacy stored values", async () => {
    const { interaction, reply } = buildInteraction("enable");
    const guildRuntime = buildGuildRuntime();
    guildRuntime.settings.features.court = true;
    guildRuntime.settings.features.anonymousAnswers = true;
    guildRuntime.settings.features.silenceLock = true;
    guildRuntime.settings.features.royalAfk = true;
    guildRuntime.settings.features.royalPresence = true;
    guildRuntime.settings.features.weeklyDigest = true;
    guildRuntime.settings.channels.court = "444444444444444444";
    guildRuntime.settings.channels.weeklyDigest = "455555555555555555";
    guildRuntime.settings.channels.royalAlert = "466666666666666666";
    guildRuntime.settings.roles.staff = ["555555555555555555"];
    guildRuntime.settings.roles.silenceTargets = ["566666666666666666"];
    guildRuntime.settings.roles.emperor = "577777777777777777";
    guildRuntime.settings.championUserId = "588888888888888888";

    await handleSetupCommand(interaction, {} as BotRuntime, guildRuntime);

    expect(guildRuntime.refreshSettings).toHaveBeenCalledTimes(1);
    expect(guildRuntime.setEnabled).toHaveBeenCalledWith(true);
    expect(
      guildRuntime.storage.initializeCourtQuestions,
    ).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      content: "Setup is valid. Superior is now enabled for this server.",
      ephemeral: true,
    });
  });

  it("validates the latest persisted snapshot before enabling", async () => {
    const { interaction, reply } = buildInteraction("enable");
    const guildRuntime = buildGuildRuntime();
    const latest = createDefaultGuildSettings();
    latest.timezone = "Not/A-Timezone";
    vi.mocked(guildRuntime.refreshSettings).mockResolvedValue(latest);

    await handleSetupCommand(interaction, {} as BotRuntime, guildRuntime);

    expect(guildRuntime.refreshSettings).toHaveBeenCalledTimes(1);
    expect(guildRuntime.setEnabled).not.toHaveBeenCalled();
    const payload = reply.mock.calls[0]?.[0] as { content: string };
    expect(payload.content).toContain("Setup is incomplete");
    expect(payload.content).toContain("Timezone `Not/A-Timezone` is invalid.");
  });

  it("fails closed when settings change during enablement", async () => {
    const { interaction, reply } = buildInteraction("enable");
    const guildRuntime = buildGuildRuntime();
    vi.mocked(guildRuntime.setEnabled).mockRejectedValue(
      new GuildSettingsConflictError(GUILD_ID),
    );

    await handleSetupCommand(interaction, {} as BotRuntime, guildRuntime);

    expect(guildRuntime.setEnabled).toHaveBeenCalledWith(true);
    expect(
      guildRuntime.storage.initializeCourtQuestions,
    ).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      content:
        "This server's configuration changed during setup. Review the latest settings and try again.",
      ephemeral: true,
    });
  });

  it("shows only active settings while acknowledging retained legacy data", async () => {
    const { interaction, reply } = buildInteraction("status");
    const guildRuntime = buildGuildRuntime();
    guildRuntime.settings.features.invictusChat = true;
    guildRuntime.settings.features.replyModeration = true;
    guildRuntime.settings.features.greetings = true;
    guildRuntime.settings.features.court = true;
    guildRuntime.settings.features.royalPresence = true;
    guildRuntime.settings.channels.log = "444444444444444444";
    guildRuntime.settings.channels.court = "455555555555555555";
    guildRuntime.settings.channels.royalAlert = "466666666666666666";
    guildRuntime.settings.roles.privilegedChat = [
      "555555555555555555",
      "566666666666666666",
    ];
    guildRuntime.settings.roles.emperor = "577777777777777777";
    guildRuntime.settings.championUserId = "588888888888888888";
    guildRuntime.settings.greetings = [
      { name: "welcome", userId: null, message: "Hello" },
    ];

    await handleSetupCommand(interaction, {} as BotRuntime, guildRuntime);

    const content = (reply.mock.calls[0]?.[0] as { content: string }).content;
    const featureLine = content
      .split("\n")
      .find((line) => line.startsWith("Features:"));
    expect(featureLine).toBe(
      "Features: `superior-chat`, `reply-moderation`, `greetings`",
    );
    expect(content).toContain("Log channel: <#444444444444444444>");
    expect(content).not.toContain("Privileged-chat roles:");
    expect(content).toContain("Greeting profiles: `1`");
    expect(content).toContain(
      "Legacy court settings and data are retained but inactive.",
    );
    expect(content).not.toContain("455555555555555555");
    expect(content).not.toContain("466666666666666666");
    expect(content).not.toContain("577777777777777777");
    expect(content).not.toContain("588888888888888888");
  });

  it.each([
    ["channel", { strings: { purpose: "court", action: "set" } }],
    ["role", { strings: { purpose: "privilegedChat", action: "add" } }],
    ["feature", { strings: { name: "court" }, booleans: { enabled: true } }],
    ["limits", {}],
    ["schedule", {}],
    ["labels", {}],
    ["champion", {}],
  ] as Array<[string, InteractionOptions]>)(
    "rejects stale retired setup values for /setup %s",
    async (subcommand, options) => {
      const { interaction, reply } = buildInteraction(subcommand, options);
      const guildRuntime = buildGuildRuntime();

      await handleSetupCommand(interaction, {} as BotRuntime, guildRuntime);

      expect(reply).toHaveBeenCalledWith({
        content: RETIRED_SETUP_MESSAGE,
        ephemeral: true,
      });
      expect(guildRuntime.saveSettings).not.toHaveBeenCalled();
      expect(guildRuntime.setEnabled).not.toHaveBeenCalled();
      expect(
        guildRuntime.storage.initializeCourtQuestions,
      ).not.toHaveBeenCalled();
    },
  );

  it("updates only the active moderation limit", async () => {
    const { interaction, reply } = buildInteraction("limits", {
      integers: { mute_target_cap: 25 },
    });
    const guildRuntime = buildGuildRuntime();

    await handleSetupCommand(interaction, {} as BotRuntime, guildRuntime);

    expect(guildRuntime.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        limits: expect.objectContaining({ muteallTargetCap: 25 }),
      }),
    );
    expect(reply).toHaveBeenCalledWith({
      content: "Guild limits updated.",
      ephemeral: true,
    });
  });

  it("allows only the owner to reach purge confirmation", async () => {
    const { interaction, reply, editReply } = buildInteraction("purge", {
      admin: true,
      owner: false,
      confirmation: "PURGE " + GUILD_ID,
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

  it("shows the guild-only purge preview and requires exact confirmation", async () => {
    const { interaction, reply, editReply } = buildInteraction("purge", {
      owner: true,
      confirmation: "PURGE " + GUILD_ID + " ",
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
    expect(payload.content).toContain("Type `PURGE " + GUILD_ID + "` exactly");
    expect(setGuildEnabled).not.toHaveBeenCalled();
    expect(purgeGuild).not.toHaveBeenCalled();
    expect(editReply).not.toHaveBeenCalled();
  });

  it("purges only after the owner supplies the exact confirmation", async () => {
    const { interaction, reply, editReply } = buildInteraction("purge", {
      owner: true,
      confirmation: "PURGE " + GUILD_ID,
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

  it("preserves guild data when an active silence overwrite cannot be restored", async () => {
    const { interaction, editReply } = buildInteraction("purge", {
      owner: true,
      confirmation: "PURGE " + GUILD_ID,
    });
    const guildRuntime = buildGuildRuntime();
    (
      interaction.guild as unknown as {
        channels: { fetch: ReturnType<typeof vi.fn> };
      }
    ).channels.fetch.mockRejectedValue({ status: 403 });
    vi.mocked(guildRuntime.storage.metricsGet).mockReturnValue(
      JSON.stringify({
        version: 1,
        leases: [
          {
            channelId: "444444444444444444",
            roleId: "555555555555555555",
            originalSendMessages: null,
            expiresAt: Date.now() + 60_000,
          },
        ],
      }),
    );
    const summary = {
      guildId: GUILD_ID,
      guilds: 1,
      settings: 1,
      kv: 1,
      posts: 0,
      answers: 0,
      metrics: 1,
      cooldowns: 0,
    };
    const setGuildEnabled = vi.fn();
    const invalidateGuild = vi.fn();
    const purgeGuild = vi.fn();
    const runtime = {
      storage: {
        previewGuildPurge: vi.fn(() => summary),
        setGuildEnabled,
        purgeGuild,
      },
      invalidateGuild,
    } as unknown as BotRuntime;

    await handleSetupCommand(interaction, runtime, guildRuntime);

    expect(setGuildEnabled).toHaveBeenCalledWith(GUILD_ID, false);
    expect(invalidateGuild).toHaveBeenCalled();
    expect(setGuildEnabled.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(guildRuntime.storage.metricsGet).mock.invocationCallOrder[0]!,
    );
    expect(invalidateGuild.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(guildRuntime.storage.metricsGet).mock.invocationCallOrder[0]!,
    );
    expect(purgeGuild).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith({
      content: expect.stringContaining(
        "1 active silence overwrite(s) could not be restored",
      ),
    });
  });

  it.each(["null", "404"] as const)(
    "does not block purge when a silence target is definitively deleted (%s)",
    async (missingResult) => {
      const { interaction, editReply } = buildInteraction("purge", {
        owner: true,
        confirmation: "PURGE " + GUILD_ID,
      });
      if (missingResult === "404") {
        (
          interaction.guild as unknown as {
            channels: { fetch: ReturnType<typeof vi.fn> };
          }
        ).channels.fetch.mockRejectedValue({ status: 404 });
      }
      const guildRuntime = buildGuildRuntime();
      vi.mocked(guildRuntime.storage.metricsGet).mockReturnValue(
        JSON.stringify({
          version: 1,
          leases: [
            {
              channelId: "444444444444444444",
              roleId: "555555555555555555",
              originalSendMessages: null,
              expiresAt: Date.now() + 60_000,
            },
          ],
        }),
      );
      const summary = {
        guildId: GUILD_ID,
        guilds: 1,
        settings: 1,
        kv: 1,
        posts: 0,
        answers: 0,
        metrics: 1,
        cooldowns: 0,
      };
      const purgeGuild = vi.fn(() => summary);
      const runtime = {
        storage: {
          previewGuildPurge: vi.fn(() => summary),
          setGuildEnabled: vi.fn(),
          purgeGuild,
        },
        invalidateGuild: vi.fn(),
      } as unknown as BotRuntime;

      await handleSetupCommand(interaction, runtime, guildRuntime);

      expect(guildRuntime.storage.metricsSet).toHaveBeenCalledWith(
        expect.any(String),
        JSON.stringify({ version: 1, leases: [] }),
      );
      expect(purgeGuild).toHaveBeenCalledWith(GUILD_ID);
      expect(editReply).toHaveBeenCalledWith({
        content: expect.stringContaining("Removal summary"),
      });
    },
  );

  it("preserves guild data when silence lease metadata is malformed", async () => {
    const { interaction, editReply } = buildInteraction("purge", {
      owner: true,
      confirmation: "PURGE " + GUILD_ID,
    });
    const guildRuntime = buildGuildRuntime();
    vi.mocked(guildRuntime.storage.metricsGet).mockReturnValue("{not-json");
    const summary = {
      guildId: GUILD_ID,
      guilds: 1,
      settings: 1,
      kv: 1,
      posts: 0,
      answers: 0,
      metrics: 1,
      cooldowns: 0,
    };
    const purgeGuild = vi.fn();
    const runtime = {
      storage: {
        previewGuildPurge: vi.fn(() => summary),
        setGuildEnabled: vi.fn(),
        purgeGuild,
      },
      invalidateGuild: vi.fn(),
    } as unknown as BotRuntime;

    await handleSetupCommand(interaction, runtime, guildRuntime);

    expect(purgeGuild).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith({
      content: expect.stringContaining(
        "silence-lock metadata could not be read safely",
      ),
    });
  });
});

describe("setup validation", () => {
  it("accepts zero active optional features", async () => {
    const settings = createDefaultGuildSettings();
    const { interaction } = buildInteraction("validate");

    const result = await validateGuildSetup(
      interaction.guild as Guild,
      settings,
    );

    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("ignores every retired feature, channel, role, schedule, and binding", async () => {
    const settings = createDefaultGuildSettings();
    settings.features.court = true;
    settings.features.anonymousAnswers = true;
    settings.features.silenceLock = true;
    settings.features.royalAfk = true;
    settings.features.royalPresence = true;
    settings.features.weeklyDigest = true;
    settings.channels.court = "444444444444444444";
    settings.channels.weeklyDigest = "455555555555555555";
    settings.channels.royalAlert = "466666666666666666";
    settings.roles.staff = ["555555555555555555"];
    settings.roles.privilegedChat = ["511111111111111111"];
    settings.roles.emperor = "566666666666666666";
    settings.roles.empress = "577777777777777777";
    settings.roles.silenceTargets = ["588888888888888888"];
    settings.roles.silenceExcludes = ["599999999999999999"];
    settings.roles.anonymousRequired = "600000000000000000";
    settings.championUserId = "611111111111111111";
    settings.courtSchedule = {
      mode: "auto",
      hour: 99,
      minute: 99,
      dryRun: true,
    };
    settings.weeklyDigestSchedule = { weekday: 99, hour: 99 };
    const { interaction } = buildInteraction("validate");
    const guild = interaction.guild as Guild;

    const result = await validateGuildSetup(guild, settings);

    expect(result).toEqual({ valid: true, errors: [] });
    expect(guild.channels.fetch).not.toHaveBeenCalled();
    expect(guild.roles.fetch).not.toHaveBeenCalled();
    expect(guild.members.fetch).not.toHaveBeenCalled();
  });

  it("validates only active configuration dependencies and permissions", async () => {
    const settings = createDefaultGuildSettings();
    const logChannelId = "444444444444444444";
    settings.timezone = "Not/A-Timezone";
    settings.features.invictusChat = true;
    settings.invocation.keyword = " ";
    settings.features.greetings = true;
    settings.features.replyModeration = true;
    settings.channels.log = logChannelId;
    const botMember = {
      permissions: {
        has: vi.fn(
          (permission: bigint) =>
            permission !== PermissionFlagsBits.ModerateMembers,
        ),
      },
    };
    const guild = {
      id: GUILD_ID,
      members: {
        me: botMember,
        fetchMe: vi.fn(async () => botMember),
        fetch: vi.fn(async () => null),
      },
      channels: { fetch: vi.fn(async () => null) },
      roles: { cache: new Map(), fetch: vi.fn(async () => null) },
    } as unknown as Guild;

    const result = await validateGuildSetup(guild, settings);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        "Timezone `Not/A-Timezone` is invalid.",
        "Superior chat requires an invocation keyword.",
        "Greetings requires at least one greeting profile.",
        "The log channel no longer exists in this server.",
        "Reply moderation requires the bot Moderate Members permission.",
      ]),
    );
  });

  it("accepts valid active log, role, greeting, and moderation settings", async () => {
    const settings = createDefaultGuildSettings();
    const logChannelId = "444444444444444444";
    const greetingUserId = "666666666666666666";
    settings.features.invictusChat = true;
    settings.features.replyModeration = true;
    settings.features.greetings = true;
    settings.channels.log = logChannelId;
    settings.greetings = [
      {
        name: "welcome",
        userId: greetingUserId,
        message: "Welcome {user}",
      },
    ];
    const botMember = {
      permissions: { has: vi.fn(() => true) },
    };
    const channel = {
      id: logChannelId,
      guildId: GUILD_ID,
      type: ChannelType.GuildText,
      send: vi.fn(),
      permissionsFor: vi.fn(() => ({ has: vi.fn(() => true) })),
    };
    const greetingMember = { id: greetingUserId };
    const guild = {
      id: GUILD_ID,
      members: {
        me: botMember,
        fetchMe: vi.fn(async () => botMember),
        fetch: vi.fn(async (id: string) =>
          id === greetingUserId ? greetingMember : null,
        ),
      },
      channels: {
        fetch: vi.fn(async (id: string) =>
          id === logChannelId ? channel : null,
        ),
      },
      roles: {
        cache: new Map(),
        fetch: vi.fn(async () => null),
      },
    } as unknown as Guild;

    const result = await validateGuildSetup(guild, settings);

    expect(result).toEqual({ valid: true, errors: [] });
  });
});
