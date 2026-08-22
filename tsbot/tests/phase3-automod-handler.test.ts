import { describe, expect, it, vi } from "vitest";
import type { ChatInputCommandInteraction } from "discord.js";
import type { GuildRuntime } from "../src/runtime.js";
import { handleAutomodCommand } from "../src/discord/automod-commands-handler.js";
import { buildAutomodCommandDefinition } from "../src/discord/automod-command.js";

const GUILD_ID = "123456789012345678";
const OWNER_ID = "223456789012345678";

function harness(options: {
  subcommand: "status" | "configure";
  existingEnabled?: boolean | null;
  enabledOption?: boolean | null;
  globalEnabled?: boolean;
}) {
  const actor = {
    id: OWNER_ID,
    guild: null as unknown,
    permissions: { has: vi.fn(() => true) },
    roles: { cache: new Map() },
  };
  const guild = {
    id: GUILD_ID,
    ownerId: OWNER_ID,
    members: { fetch: vi.fn(async () => actor) },
  };
  actor.guild = guild;
  const upsert = vi.fn((input: Record<string, unknown>) => ({
    ...input,
    guildId: GUILD_ID,
  }));
  const existing =
    options.existingEnabled === null || options.existingEnabled === undefined
      ? null
      : {
          ruleType: "burst",
          enabled: options.existingEnabled,
          threshold: 4,
          windowSeconds: 10,
          action: "delete",
          timeoutSeconds: null,
          cooldownSeconds: 30,
        };
  const storage = {
    listCapabilitiesForRoles: vi.fn(() => []),
    getModerationConfiguration: vi.fn(() => ({
      guildId: GUILD_ID,
      antiSpamEnabled: options.globalEnabled ?? false,
    })),
    getAntiSpamRule: vi.fn(() => existing),
    listAntiSpamRules: vi.fn(() => (existing ? [existing] : [])),
    upsertAntiSpamRule: upsert,
    listAntiSpamExemptRoleIds: vi.fn(() => []),
    listAntiSpamExemptChannelIds: vi.fn(() => []),
  };
  const editReply = vi.fn(async () => undefined);
  const interaction = {
    guild,
    user: { id: OWNER_ID },
    deferred: false,
    replied: false,
    deferReply: vi.fn(async function (this: { deferred: boolean }) {
      this.deferred = true;
    }),
    editReply,
    options: {
      getSubcommandGroup: vi.fn(() =>
        options.subcommand === "configure" ? "rule" : null,
      ),
      getSubcommand: vi.fn(() => options.subcommand),
      getString: vi.fn((name: string) =>
        name === "type" ? "burst" : name === "action" ? "delete" : null,
      ),
      getInteger: vi.fn((name: string) =>
        name === "threshold"
          ? 5
          : name === "window_seconds"
            ? 15
            : name === "cooldown_seconds"
              ? 45
              : null,
      ),
      getBoolean: vi.fn(() => options.enabledOption ?? null),
    },
  } as unknown as ChatInputCommandInteraction;
  const runtime = {
    guildId: GUILD_ID,
    storage,
    isCurrent: vi.fn(() => true),
    invalidate: vi.fn(),
  } as unknown as GuildRuntime;
  return { interaction, runtime, storage, upsert, editReply };
}

describe("Phase 3 automod command handler", () => {
  it("bounds optional synthetic text in the registered test command", () => {
    const definition = buildAutomodCommandDefinition().toJSON();
    const testCommand = definition.options?.find(
      (option) => option.name === "test",
    ) as
      | {
          options?: Array<{
            name: string;
            max_length?: number;
            required?: boolean;
          }>;
        }
      | undefined;
    const textOption = testCommand?.options?.find(
      (option) => option.name === "text",
    );

    expect(textOption).toMatchObject({ required: false, max_length: 1_000 });
  });

  it("shows the global anti-spam enforcement state", async () => {
    const context = harness({
      subcommand: "status",
      existingEnabled: true,
      globalEnabled: false,
    });

    await handleAutomodCommand(context.interaction, context.runtime);

    expect(context.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Global enforcement: **disabled**"),
      }),
    );
  });

  it("preserves an existing rule's enabled state when enabled is omitted", async () => {
    const context = harness({
      subcommand: "configure",
      existingEnabled: true,
      enabledOption: null,
    });

    await handleAutomodCommand(context.interaction, context.runtime);

    expect(context.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ ruleType: "burst", enabled: true }),
    );
  });

  it("keeps a newly configured rule disabled when enabled is omitted", async () => {
    const context = harness({
      subcommand: "configure",
      existingEnabled: null,
      enabledOption: null,
    });

    await handleAutomodCommand(context.interaction, context.runtime);

    expect(context.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ ruleType: "burst", enabled: false }),
    );
  });
});
