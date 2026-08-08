import { ApplicationCommandOptionType, PermissionFlagsBits } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultGuildSettings } from "../src/guild-settings.js";
import type { BotRuntime, GuildRuntime } from "../src/runtime.js";
import type { GuildSettings } from "../src/types.js";
import {
  buildSetupCommandDefinition,
  handleSetupCommand,
  requireSetupAdmin,
  validateGuildSetup,
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
  const json = buildSetupCommandDefinition().toJSON();
  return (json.options as JsonOption[] | undefined)?.find(
    (option) => option.name === name,
  );
}

describe("setup command definition", () => {
  it("registers only the active setup surface including safe import", () => {
    const json = buildSetupCommandDefinition().toJSON();
    expect(json.dm_permission).toBe(false);
    expect(json.options?.map(({ name }) => name)).toEqual([
      "status",
      "enable",
      "enable-all",
      "disable",
      "channel",
      "feature",
      "timezone",
      "limits",
      "trigger",
      "greeting",
      "validate",
      "export",
      "import",
      "purge",
    ]);
    expect(findSubcommand("import")).toMatchObject({
      description: expect.stringContaining("Owner-only replacement"),
    });
    expect(findSubcommand("import")?.description).toContain("v4");
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

describe("setup authorization", () => {
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

    await expect(requireSetupAdmin(interaction)).resolves.toBeNull();
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
        allowedMentions: { parse: [] },
      }),
    );
  });
});

describe("active-only setup behavior", () => {
  it("adds a default greeting and enables every feature and the server", async () => {
    const settings = createDefaultGuildSettings();
    let persisted = structuredClone(settings);
    const saveSettings = vi.fn(async (next: GuildSettings) => {
      persisted = structuredClone(next);
      return persisted;
    });
    const setEnabled = vi.fn(async (enabled: boolean) => {
      persisted.enabled = enabled;
      persisted.reviewRequired = !enabled;
      return structuredClone(persisted);
    });
    const editReply = vi.fn(async (_payload: unknown) => undefined);
    const guildRuntime = {
      guildId: GUILD_ID,
      settings,
      saveSettings,
      setEnabled,
    } as unknown as GuildRuntime;
    const interaction = {
      guild: { id: GUILD_ID },
      guildId: GUILD_ID,
      options: { getSubcommand: vi.fn(() => "enable-all") },
      deferred: true,
      replied: false,
      editReply,
    } as never;

    await handleSetupCommand(interaction, {} as BotRuntime, guildRuntime, {
      id: USER_ID,
      guild: { id: GUILD_ID },
    } as never);

    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        greetings: [{ name: "Welcome", message: "Welcome, {user}!" }],
        features: {
          chat: true,
          replyModeration: true,
          greetings: true,
          activityMetrics: true,
        },
      }),
    );
    expect(setEnabled).toHaveBeenCalledWith(true);
    expect(saveSettings.mock.invocationCallOrder[0]).toBeLessThan(
      setEnabled.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(persisted).toMatchObject({
      enabled: true,
      reviewRequired: false,
      greetings: [{ name: "Welcome", message: "Welcome, {user}!" }],
      features: {
        chat: true,
        replyModeration: true,
        greetings: true,
        activityMetrics: true,
      },
    });
    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("default **Welcome**"),
      }),
    );
  });

  it("preserves existing greetings without adding a default", async () => {
    const settings = createDefaultGuildSettings();
    const existingGreetings = [
      { name: "Custom", message: "Hello there, {user}." },
      { name: "Brief", message: "Welcome aboard." },
    ];
    settings.greetings = structuredClone(existingGreetings);
    let saved: GuildSettings | null = null;
    const saveSettings = vi.fn(async (next: GuildSettings) => {
      saved = structuredClone(next);
      return next;
    });
    const setEnabled = vi.fn(async () => settings);
    const guildRuntime = {
      guildId: GUILD_ID,
      settings,
      saveSettings,
      setEnabled,
    } as unknown as GuildRuntime;
    const interaction = {
      guild: { id: GUILD_ID },
      guildId: GUILD_ID,
      options: { getSubcommand: vi.fn(() => "enable-all") },
      deferred: true,
      replied: false,
      editReply: vi.fn(async () => undefined),
    } as never;

    await handleSetupCommand(interaction, {} as BotRuntime, guildRuntime, {
      id: USER_ID,
      guild: { id: GUILD_ID },
    } as never);

    expect(saved).not.toBeNull();
    expect(saved!.greetings).toEqual(existingGreetings);
    expect(saved!.greetings).toHaveLength(existingGreetings.length);
    expect(setEnabled).toHaveBeenCalledWith(true);
  });

  it("leaves settings unchanged when enable-all preflight validation fails", async () => {
    const settings = createDefaultGuildSettings();
    settings.timezone = "Mars/Olympus_Mons";
    settings.limits.bulkModerationTargetCap = 0;
    settings.channels.log = "323456789012345678";
    const original = structuredClone(settings);
    const saveSettings = vi.fn();
    const setEnabled = vi.fn();
    const editReply = vi.fn(async (_payload: unknown) => undefined);
    const guildRuntime = {
      guildId: GUILD_ID,
      settings,
      saveSettings,
      setEnabled,
    } as unknown as GuildRuntime;
    const interaction = {
      guild: {
        id: GUILD_ID,
        channels: { fetch: vi.fn(async () => null) },
      },
      guildId: GUILD_ID,
      options: { getSubcommand: vi.fn(() => "enable-all") },
      deferred: true,
      replied: false,
      editReply,
    } as never;

    await handleSetupCommand(interaction, {} as BotRuntime, guildRuntime, {
      id: USER_ID,
      guild: { id: GUILD_ID },
    } as never);

    expect(saveSettings).not.toHaveBeenCalled();
    expect(setEnabled).not.toHaveBeenCalled();
    expect(settings).toEqual(original);
    const failure = editReply.mock.calls[0]?.[0] as { content: string };
    expect(failure.content).toContain("Timezone is invalid.");
    expect(failure.content).toContain(
      "Bulk moderation target cap must be between 1 and 1000.",
    );
    expect(failure.content).toContain(
      "The configured log channel is unavailable.",
    );
    expect(failure.content).toContain("Nothing changed");
  });

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
          if (name === "action") return "add";
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

    const runSetup = async (subcommand: "status" | "greeting") => {
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

    const status = await runSetup("status");
    const list = await runSetup("greeting");
    expect(status.length).toBeLessThanOrEqual(2_000);
    expect(status).toContain("(+95 more)");
    expect(list.length).toBeLessThanOrEqual(2_000);
    expect(list).toContain("94** more omitted");
    expect(list).toContain("/setup export");
  });

  it("requires greeting profiles only when the feature is enabled", async () => {
    const settings = createDefaultGuildSettings();
    settings.features.greetings = true;
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

    const missing = await validateGuildSetup(interaction, settings);
    expect(missing.valid).toBe(false);
    expect(missing.errors).toContain(
      "Greetings are enabled but no greeting profile exists.",
    );

    settings.greetings.push({ name: "Welcome", message: "Hello {user}!" });
    const valid = await validateGuildSetup(interaction, settings);
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
      formatVersion: 4,
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

  it("describes every Phase 2 collection in a successful export", async () => {
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
          formatVersion: 4,
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
      content: expect.stringContaining("Format-4"),
      files: [expect.anything()],
      allowedMentions: { parse: [] },
    });
    for (const collection of [
      "delegated grants",
      "ticket departments/fields/tickets/responses/events",
      "suggestion configuration/suggestions/votes/events",
      "application forms/fields/applications/responses/events",
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
