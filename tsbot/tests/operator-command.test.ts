import { PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { handleOperatorCommand } from "../src/discord/operator-command.js";
import type { BotRuntime, GuildRuntime } from "../src/runtime.js";
import type { GuildSettings } from "../src/types.js";

const GUILD_ID = "123456789012345678";
const USER_ID = "223456789012345678";

function makeInteraction(options: {
  subcommand: string;
  state?: "enabled" | "disabled";
  confirmation?: string;
  member: unknown;
}): any {
  const guild = {
    id: GUILD_ID,
    ownerId: "999999999999999999",
    members: { fetch: vi.fn(async () => options.member) },
  };
  return {
    guild,
    guildId: GUILD_ID,
    user: { id: USER_ID },
    options: {
      getSubcommand: vi.fn(() => options.subcommand),
      getString: vi.fn((name: string) =>
        name === "state" ? options.state : options.confirmation,
      ),
    },
    deferred: true,
    replied: false,
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  };
}

function makeRuntime(enabled: boolean): {
  runtime: BotRuntime;
  guildRuntime: GuildRuntime;
  setEnabled: ReturnType<typeof vi.fn>;
} {
  const settings = { enabled } as GuildSettings;
  const setEnabled = vi.fn(async (nextEnabled: boolean) => {
    settings.enabled = nextEnabled;
    return settings;
  });
  const guildRuntime = {
    guildId: GUILD_ID,
    settings,
    setEnabled,
    storage: { recordCommandMetric: vi.fn() },
  } as unknown as GuildRuntime;
  const runtime = {
    processConfig: { operatorIds: [USER_ID] },
    storage: { ensureGuild: vi.fn() },
    forGuild: vi.fn(async () => guildRuntime),
  } as unknown as BotRuntime;
  return { runtime, guildRuntime, setEnabled };
}

describe("deployment operator recovery", () => {
  it("requires the configured identity and exact guild confirmation", async () => {
    const member = {
      id: USER_ID,
      guild: { id: GUILD_ID, ownerId: "999999999999999999" },
      permissions: { has: vi.fn(() => false) },
      roles: { cache: new Map() },
    };
    const interaction = makeInteraction({
      subcommand: "state",
      state: "disabled",
      confirmation: `SUSPEND ${GUILD_ID}`,
      member,
    });
    const { runtime, setEnabled } = makeRuntime(true);

    await handleOperatorCommand(interaction, runtime, null);

    expect(setEnabled).toHaveBeenCalledWith(false);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("suspended"),
      }),
    );
  });

  it("does not grant access to an unconfigured member", async () => {
    const interaction = makeInteraction({
      subcommand: "status",
      member: null,
    });
    const { runtime, guildRuntime } = makeRuntime(true);
    runtime.processConfig.operatorIds = [];

    await handleOperatorCommand(interaction, runtime, guildRuntime);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("not configured"),
      }),
    );
    expect(guildRuntime.storage.recordCommandMetric).not.toHaveBeenCalled();
  });
});
