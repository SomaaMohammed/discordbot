import {
  ApplicationCommandOptionType,
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type GuildMember,
} from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultGuildSettings } from "../src/guild-settings.js";
import { handleChatInputCommand } from "../src/discord/commands.js";
import type { BotRuntime, GuildRuntime } from "../src/runtime.js";
import type { GuildSettings } from "../src/types.js";
import {
  buildConfigCommandDefinition,
  buildDataCommandDefinition,
  handleConfigCommand,
  handleDataCommand,
  requireConfigurationAdmin,
  validateGuildConfiguration,
} from "../src/discord/setup.js";

const GUILD_ID = "123456789012345678";
const USER_ID = "223456789012345678";

afterEach(() => {
  vi.unstubAllGlobals();
});

interface JsonOption {
  name: string;
  description?: string;
  type?: number;
  options?: JsonOption[];
  min_value?: number;
  max_value?: number;
  required?: boolean;
}

function findSubcommand(name: string): JsonOption | undefined {
  const json = buildConfigCommandDefinition().toJSON();
  return (json.options as JsonOption[] | undefined)?.find(
    (option) => option.name === name,
  );
}

async function handleManagementCommand(
  interaction: ChatInputCommandInteraction,
  runtime: BotRuntime,
  guildRuntime: GuildRuntime,
  actor: GuildMember,
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  if (["export", "import", "purge"].includes(subcommand)) {
    await handleDataCommand(interaction, runtime, guildRuntime, actor);
    return;
  }
  await handleConfigCommand(interaction, runtime, guildRuntime, actor);
}

const handleSetupCommand = handleManagementCommand;

describe("configuration and data command definitions", () => {
  it("registers optional configuration without onboarding gates", () => {
    const json = buildConfigCommandDefinition().toJSON();
    expect(json.dm_permission).toBe(false);
    expect(json.options?.map(({ name }) => name)).toEqual([
      "status",
      "bot-state",
      "log",
      "timezone",
      "limits",
      "trigger",
      "greeting",
    ]);
    expect(JSON.stringify(json)).not.toMatch(/setup|validate|enable-all/);
  });

  it("registers owner data management separately", () => {
    const json = buildDataCommandDefinition().toJSON();
    expect(json.options?.map(({ name }) => name)).toEqual([
      "export",
      "import",
      "purge",
    ]);
    const imported = (json.options as JsonOption[] | undefined)?.find(
      ({ name }) => name === "import",
    );
    expect(imported).toMatchObject({
      description: expect.stringContaining("Owner-only replacement"),
    });
  });

  it("makes greetings universal by exposing no target-user option", () => {
    const greeting = findSubcommand("greeting");
    expect(greeting?.options?.map(({ name }) => name)).toEqual([
      "action",
      "name",
      "message",
    ]);
    expect(greeting?.options).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: ApplicationCommandOptionType.User }),
      ]),
    );
    expect(greeting?.options?.find(({ name }) => name === "message")).toEqual(
      expect.objectContaining({ max_length: 2_000 }),
    );
  });

  it("enforces a finite nonzero bulk target cap in registration", () => {
    const limits = findSubcommand("limits");
    expect(limits?.options).toEqual([
      expect.objectContaining({
        name: "bulk_target_cap",
        min_value: 1,
        max_value: 1_000,
        required: true,
      }),
    ]);
  });
});

describe("configuration authorization", () => {
  it("routes an Administrator command on a fresh active guild without a setup gate", async () => {
    const settings = createDefaultGuildSettings();
    const actor = {
      id: USER_ID,
      guild: null as unknown,
      permissions: {
        has: vi.fn(
          (permission: bigint) =>
            permission === PermissionFlagsBits.Administrator,
        ),
      },
      roles: { cache: new Map() },
    };
    const guild = {
      id: GUILD_ID,
      name: "Fresh active guild",
      ownerId: "999999999999999999",
      members: { fetch: vi.fn(async () => actor) },
    };
    actor.guild = guild;
    const guildRuntime = {
      guildId: GUILD_ID,
      settings,
      isCurrent: vi.fn(() => true),
    } as unknown as GuildRuntime;
    const runtime = {
      forGuild: vi.fn(async () => guildRuntime),
      storage: { ensureGuild: vi.fn() },
    } as unknown as BotRuntime;
    const interaction: Record<string, any> = {
      commandName: "config",
      guild,
      guildId: GUILD_ID,
      user: { id: USER_ID },
      options: { getSubcommand: vi.fn(() => "status") },
      deferred: false,
      replied: false,
      deferReply: vi.fn(async () => {
        interaction.deferred = true;
      }),
      editReply: vi.fn(async () => undefined),
      reply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
    };

    await handleChatInputCommand(interaction as never, runtime);

    expect(runtime.forGuild).toHaveBeenCalledWith(GUILD_ID);
    expect(runtime.storage.ensureGuild).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Enabled: **yes**"),
      }),
    );
  });

  it("rejects a non-administrator without exposing configuration", async () => {
    const reply = vi.fn(async () => undefined);
    const member = {
      id: USER_ID,
      guild: { id: GUILD_ID, ownerId: "999999999999999999" },
      permissions: { has: vi.fn(() => false) },
      roles: { cache: new Map() },
    };
    const guild = {
      id: GUILD_ID,
      ownerId: "999999999999999999",
      members: { fetch: vi.fn(async () => member) },
    };
    const interaction = {
      guild,
      guildId: GUILD_ID,
      user: { id: USER_ID },
      reply,
    } as never;

    await expect(requireConfigurationAdmin(interaction)).resolves.toBeNull();
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      }),
    );
  });
});

describe("immediate configuration behavior", () => {
  it("stores greeting profiles without a fixed user and explains dynamic {user}", async () => {
    const settings = createDefaultGuildSettings();
    const reply = vi.fn(async () => undefined);
    let saved: GuildSettings | null = null;
    const guildRuntime = {
      guildId: GUILD_ID,
      settings,
      saveSettings: vi.fn(async (next: GuildSettings) => {
        saved = structuredClone(next);
        return next;
      }),
    } as unknown as GuildRuntime;
    const actor = { id: USER_ID, guild: { id: GUILD_ID } } as never;
    const interaction = {
      guild: { id: GUILD_ID },
      guildId: GUILD_ID,
      options: {
        getSubcommand: vi.fn(() => "greeting"),
        getString: vi.fn((name: string) => {
          if (name === "action") return "update";
          if (name === "name") return "Welcome";
          if (name === "message") return "Hello {user}!";
          return null;
        }),
      },
      reply,
    } as never;

    await handleSetupCommand(
      interaction,
      {} as BotRuntime,
      guildRuntime,
      actor,
    );

    expect(saved).not.toBeNull();
    expect(saved!.greetings).toEqual([
      { name: "Welcome", message: "Hello {user}!" },
    ]);
    expect(JSON.stringify(saved)).not.toContain("userId");
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("Welcome") }),
    );
  });

  it("rejects a greeting whose fully rendered worst case exceeds 2000 characters", async () => {
    const settings = createDefaultGuildSettings();
    const reply = vi.fn(async () => undefined);
    const saveSettings = vi.fn();
    const guildRuntime = {
      guildId: GUILD_ID,
      settings,
      saveSettings,
    } as unknown as GuildRuntime;
    const interaction = {
      guild: { id: GUILD_ID },
      guildId: GUILD_ID,
      options: {
        getSubcommand: vi.fn(() => "greeting"),
        getString: vi.fn((name: string) => {
          if (name === "action") return "add";
          if (name === "name") return "Too long";
          if (name === "message") return "{user}".repeat(87);
          return null;
        }),
      },
      reply,
    } as never;

    await handleSetupCommand(interaction, {} as BotRuntime, guildRuntime, {
      id: USER_ID,
      guild: { id: GUILD_ID },
    } as never);

    expect(saveSettings).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("after Markdown escaping"),
      }),
    );
  });

  it("bounds setup status and greeting-list summaries for maximum valid settings", async () => {
    const settings = createDefaultGuildSettings();
    settings.invocation.aliases = Array.from(
      { length: 20 },
      (_, index) => `alias-${index}-${"a".repeat(45)}`,
    );
    settings.greetings = Array.from({ length: 100 }, (_, index) => ({
      name: `Profile ${index} ${"n".repeat(35)}`,
      message: `Greeting ${index} ${"m".repeat(500)}`,
    }));
    const guildRuntime = {
      guildId: GUILD_ID,
      settings,
    } as GuildRuntime;
    const actor = { id: USER_ID, guild: { id: GUILD_ID } } as never;

    const runConfiguration = async (subcommand: "status" | "greeting") => {
      const reply = vi.fn<(payload: unknown) => Promise<void>>(
        async () => undefined,
      );
      const interaction = {
        guild: { id: GUILD_ID },
        guildId: GUILD_ID,
        options: {
          getSubcommand: vi.fn(() => subcommand),
          getString: vi.fn((name: string) =>
            name === "action" ? "list" : null,
          ),
        },
        reply,
      } as never;
      await handleSetupCommand(
        interaction,
        {} as BotRuntime,
        guildRuntime,
        actor,
      );
      return (reply.mock.calls[0]?.[0] as { content: string }).content;
    };

    const status = await runConfiguration("status");
    const list = await runConfiguration("greeting");
    expect(status.length).toBeLessThanOrEqual(2_000);
    expect(status).toContain("(+95 more)");
    expect(list.length).toBeLessThanOrEqual(2_000);
    expect(list).toContain("94** more omitted");
    expect(list).toContain("/data export");
  });

  it("requires a neutral greeting profile", async () => {
    const settings = createDefaultGuildSettings();
    settings.greetings = [];
    const permissions = {
      has: vi.fn((permission: bigint) =>
        [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
        ].includes(permission),
      ),
    };
    const interaction = {
      guildId: GUILD_ID,
      guild: {
        id: GUILD_ID,
        channels: { fetch: vi.fn(async () => null) },
        members: { me: { id: "bot" }, fetchMe: vi.fn() },
      },
    } as never;
    void permissions;

    const missing = await validateGuildConfiguration(interaction, settings);
    expect(missing.valid).toBe(false);
    expect(missing.errors).toContain(
      "At least one greeting profile is required.",
    );

    settings.greetings.push({ name: "Welcome", message: "Hello {user}!" });
    const valid = await validateGuildConfiguration(interaction, settings);
    expect(valid).toEqual({ valid: true, errors: [] });
  });

  it("acknowledges an import before downloading or mutating", async () => {
    const settings = createDefaultGuildSettings();
    const importGuildData = vi.fn();
    const invalidateGuild = vi.fn();
    const ownerFetch = vi.fn(async () => ({
      id: GUILD_ID,
      ownerId: USER_ID,
    }));
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ formatVersion: 2, guildId: GUILD_ID })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const interaction: Record<string, unknown> = {
      guild: { id: GUILD_ID, ownerId: USER_ID },
      guildId: GUILD_ID,
      client: { guilds: { fetch: ownerFetch } },
      options: {
        getSubcommand: vi.fn(() => "import"),
        getString: vi.fn((name: string) =>
          name === "confirmation" ? `IMPORT ${GUILD_ID}` : null,
        ),
        getAttachment: vi.fn(() => ({
          size: 100,
          url: "https://example.test/synthetic-export.json",
        })),
      },
      deferred: false,
      replied: false,
      editReply: vi.fn(async () => undefined),
      reply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
    };
    const deferReply = vi.fn(async () => {
      interaction.deferred = true;
    });
    interaction.deferReply = deferReply;
    const runtime = {
      storage: { importGuildData },
      invalidateGuild,
    } as unknown as BotRuntime;
    const guildRuntime = {
      guildId: GUILD_ID,
      settings,
    } as GuildRuntime;
    const actor = { id: USER_ID, guild: { id: GUILD_ID } } as never;

    await handleSetupCommand(
      interaction as never,
      runtime,
      guildRuntime,
      actor,
    );

    expect(deferReply.mock.invocationCallOrder[0]).toBeLessThan(
      fetchMock.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(importGuildData).toHaveBeenCalledTimes(1);
    expect(invalidateGuild).toHaveBeenCalledWith(GUILD_ID);
    expect(invalidateGuild.mock.invocationCallOrder[0]).toBeLessThan(
      importGuildData.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(ownerFetch).toHaveBeenCalledWith({
      guild: GUILD_ID,
      cache: false,
      force: true,
    });
    expect(fetchMock.mock.invocationCallOrder[0]).toBeLessThan(
      ownerFetch.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("refuses an import if ownership changes during the download", async () => {
    const settings = createDefaultGuildSettings();
    const importGuildData = vi.fn();
    const invalidateGuild = vi.fn();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ formatVersion: 2, guildId: GUILD_ID })),
    );
    const ownerFetch = vi.fn(async () => ({
      id: GUILD_ID,
      ownerId: "999999999999999999",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const interaction: Record<string, any> = {
      guild: { id: GUILD_ID, ownerId: USER_ID },
      guildId: GUILD_ID,
      client: { guilds: { fetch: ownerFetch } },
      options: {
        getSubcommand: vi.fn(() => "import"),
        getString: vi.fn((name: string) =>
          name === "confirmation" ? `IMPORT ${GUILD_ID}` : null,
        ),
        getAttachment: vi.fn(() => ({
          size: 100,
          url: "https://example.test/synthetic-export.json",
        })),
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
      storage: { importGuildData },
      invalidateGuild,
    } as unknown as BotRuntime;
    const guildRuntime = {
      guildId: GUILD_ID,
      settings,
    } as GuildRuntime;

    await handleSetupCommand(interaction as never, runtime, guildRuntime, {
      id: USER_ID,
      guild: { id: GUILD_ID },
    } as never);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ownerFetch).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.invocationCallOrder[0]).toBeLessThan(
      ownerFetch.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(invalidateGuild).not.toHaveBeenCalled();
    expect(importGuildData).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("owner") }),
    );
  });

  it("bounds the downloaded import body even when attachment metadata is false", async () => {
    const settings = createDefaultGuildSettings();
    const importGuildData = vi.fn();
    const invalidateGuild = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1))),
    );
    const interaction: Record<string, any> = {
      guild: { id: GUILD_ID, ownerId: USER_ID },
      guildId: GUILD_ID,
      options: {
        getSubcommand: vi.fn(() => "import"),
        getString: vi.fn((name: string) =>
          name === "confirmation" ? `IMPORT ${GUILD_ID}` : null,
        ),
        getAttachment: vi.fn(() => ({
          size: 100,
          url: "https://example.test/oversized-export.json",
        })),
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
      storage: { importGuildData },
      invalidateGuild,
    } as unknown as BotRuntime;
    const guildRuntime = {
      guildId: GUILD_ID,
      settings,
    } as GuildRuntime;

    await handleSetupCommand(interaction as never, runtime, guildRuntime, {
      id: USER_ID,
      guild: { id: GUILD_ID },
    } as never);

    expect(importGuildData).not.toHaveBeenCalled();
    expect(invalidateGuild).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("2 MiB") }),
    );
  });

  it("refuses a non-owner import before downloading or mutating", async () => {
    const settings = createDefaultGuildSettings();
    const importGuildData = vi.fn();
    const invalidateGuild = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const interaction: Record<string, any> = {
      guild: { id: GUILD_ID, ownerId: "999999999999999999" },
      guildId: GUILD_ID,
      options: {
        getSubcommand: vi.fn(() => "import"),
        getString: vi.fn(() => `IMPORT ${GUILD_ID}`),
        getAttachment: vi.fn(() => ({
          size: 100,
          url: "https://example.test/export.json",
        })),
      },
      deferred: false,
      replied: false,
      reply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
    };
    const runtime = {
      storage: { importGuildData },
      invalidateGuild,
    } as unknown as BotRuntime;
    const guildRuntime = {
      guildId: GUILD_ID,
      settings,
    } as GuildRuntime;

    await handleSetupCommand(interaction as never, runtime, guildRuntime, {
      id: USER_ID,
      guild: { id: GUILD_ID },
    } as never);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(importGuildData).not.toHaveBeenCalled();
    expect(invalidateGuild).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("owner") }),
    );
  });

  it("refuses a non-owner purge before invalidating or deleting", async () => {
    const settings = createDefaultGuildSettings();
    const purgeGuildData = vi.fn();
    const invalidateGuild = vi.fn();
    const interaction: Record<string, any> = {
      guild: { id: GUILD_ID, ownerId: "999999999999999999" },
      guildId: GUILD_ID,
      options: {
        getSubcommand: vi.fn(() => "purge"),
        getString: vi.fn(() => `PURGE ${GUILD_ID}`),
      },
      deferred: false,
      replied: false,
      reply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
    };
    const runtime = {
      storage: { purgeGuildData },
      invalidateGuild,
    } as unknown as BotRuntime;
    const guildRuntime = {
      guildId: GUILD_ID,
      settings,
    } as GuildRuntime;

    await handleSetupCommand(interaction as never, runtime, guildRuntime, {
      id: USER_ID,
      guild: { id: GUILD_ID },
    } as never);

    expect(purgeGuildData).not.toHaveBeenCalled();
    expect(invalidateGuild).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("owner") }),
    );
  });

  it("allows the owner to purge after exact confirmation", async () => {
    const settings = createDefaultGuildSettings();
    const purgeGuildData = vi.fn(async () => ({ guildId: GUILD_ID }));
    const invalidateGuild = vi.fn();
    const ownerFetch = vi.fn(async () => ({
      id: GUILD_ID,
      ownerId: USER_ID,
    }));
    const interaction: Record<string, any> = {
      guild: { id: GUILD_ID, ownerId: USER_ID },
      guildId: GUILD_ID,
      client: { guilds: { fetch: ownerFetch } },
      options: {
        getSubcommand: vi.fn(() => "purge"),
        getString: vi.fn(() => `PURGE ${GUILD_ID}`),
      },
      deferred: false,
      replied: false,
      reply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
    };
    interaction.deferReply = vi.fn(async () => {
      interaction.deferred = true;
    });
    const runtime = {
      storage: { purgeGuildData },
      invalidateGuild,
    } as unknown as BotRuntime;
    const guildRuntime = {
      guildId: GUILD_ID,
      settings,
    } as GuildRuntime;

    await handleSetupCommand(interaction as never, runtime, guildRuntime, {
      id: USER_ID,
      guild: { id: GUILD_ID },
    } as never);

    expect(invalidateGuild).toHaveBeenCalledWith(GUILD_ID);
    expect(purgeGuildData).toHaveBeenCalledWith(GUILD_ID);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("purged") }),
    );
    expect(ownerFetch).toHaveBeenCalledTimes(1);
    expect(interaction.deferReply.mock.invocationCallOrder[0]).toBeLessThan(
      ownerFetch.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("refuses a purge if ownership changes after deferral", async () => {
    const settings = createDefaultGuildSettings();
    const purgeGuildData = vi.fn(async () => ({ guildId: GUILD_ID }));
    const invalidateGuild = vi.fn();
    const ownerFetch = vi.fn(async () => ({
      id: GUILD_ID,
      ownerId: "999999999999999999",
    }));
    const interaction: Record<string, any> = {
      guild: { id: GUILD_ID, ownerId: USER_ID },
      guildId: GUILD_ID,
      client: { guilds: { fetch: ownerFetch } },
      options: {
        getSubcommand: vi.fn(() => "purge"),
        getString: vi.fn(() => `PURGE ${GUILD_ID}`),
      },
      deferred: false,
      replied: false,
      reply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
    };
    interaction.deferReply = vi.fn(async () => {
      interaction.deferred = true;
    });
    const runtime = {
      storage: { purgeGuildData },
      invalidateGuild,
    } as unknown as BotRuntime;
    const guildRuntime = {
      guildId: GUILD_ID,
      settings,
    } as GuildRuntime;

    await handleSetupCommand(interaction as never, runtime, guildRuntime, {
      id: USER_ID,
      guild: { id: GUILD_ID },
    } as never);

    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(ownerFetch).toHaveBeenCalledTimes(1);
    expect(interaction.deferReply.mock.invocationCallOrder[0]).toBeLessThan(
      ownerFetch.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(invalidateGuild).not.toHaveBeenCalled();
    expect(purgeGuildData).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("owner") }),
    );
  });

  it("refuses an oversized complete export instead of sending partial data", async () => {
    const settings = createDefaultGuildSettings();
    const exportGuildData = vi.fn(() => ({
      formatVersion: 6,
      guildId: GUILD_ID,
      oversized: "x".repeat(2 * 1024 * 1024),
    }));
    const interaction: Record<string, any> = {
      guild: { id: GUILD_ID },
      guildId: GUILD_ID,
      options: { getSubcommand: vi.fn(() => "export") },
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
      storage: { exportGuildData },
    } as unknown as BotRuntime;
    const guildRuntime = {
      guildId: GUILD_ID,
      settings,
    } as GuildRuntime;

    await handleSetupCommand(interaction as never, runtime, guildRuntime, {
      id: USER_ID,
      guild: { id: GUILD_ID },
    } as never);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("No partial export"),
      }),
    );
    expect(interaction.editReply.mock.calls[0]?.[0]).not.toHaveProperty(
      "files",
    );
  });

  it("describes every current collection in a successful export", async () => {
    const settings = createDefaultGuildSettings();
    const interaction: Record<string, any> = {
      guild: { id: GUILD_ID },
      guildId: GUILD_ID,
      options: { getSubcommand: vi.fn(() => "export") },
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
      storage: {
        exportGuildData: vi.fn(() => ({
          formatVersion: 6,
          guildId: GUILD_ID,
        })),
      },
    } as unknown as BotRuntime;
    const guildRuntime = {
      guildId: GUILD_ID,
      settings,
    } as GuildRuntime;

    await handleSetupCommand(interaction as never, runtime, guildRuntime, {
      id: USER_ID,
      guild: { id: GUILD_ID },
    } as never);

    const response = interaction.editReply.mock.calls[0]?.[0];
    expect(response).toMatchObject({
      content: expect.stringContaining("Format-6"),
      files: [expect.anything()],
      allowedMentions: { parse: [] },
    });
    for (const collection of [
      "delegated grants",
      "ticket departments/fields/tickets/responses/events",
      "suggestion configuration/suggestions/votes/events",
      "application forms/fields/applications/responses/events",
      "restricted-ping roles/mappings/user cooldowns/events",
      "delivery identifiers",
    ]) {
      expect(response.content).toContain(collection);
    }
  });

  it("responds privately when export preflight refuses materialization", async () => {
    const settings = createDefaultGuildSettings();
    const interaction: Record<string, any> = {
      guild: { id: GUILD_ID },
      guildId: GUILD_ID,
      options: { getSubcommand: vi.fn(() => "export") },
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
      storage: {
        exportGuildData: vi.fn(() => {
          throw new RangeError("synthetic materialization limit");
        }),
      },
    } as unknown as BotRuntime;
    const guildRuntime = {
      guildId: GUILD_ID,
      settings,
    } as GuildRuntime;

    await handleSetupCommand(interaction as never, runtime, guildRuntime, {
      id: USER_ID,
      guild: { id: GUILD_ID },
    } as never);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("refused safely"),
      }),
    );
  });
});
