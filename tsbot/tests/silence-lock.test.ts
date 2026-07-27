import { PermissionFlagsBits } from "discord.js";
import type { GuildMember, Role, TextChannel } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lockChannelSilently } from "../src/discord/runtime-parity.js";
import { readSilenceLeases } from "../src/discord/silence-leases.js";
import type { GuildRuntime } from "../src/runtime.js";

const GUILD_ID = "123456789012345678";
const CHANNEL_ID = "234567890123456789";
const ROLE_ID = "345678901234567890";

function createFixture(options: { editFails?: boolean } = {}): {
  actor: GuildMember;
  channel: TextChannel;
  runtime: GuildRuntime;
  role: Role;
  edit: ReturnType<typeof vi.fn>;
} {
  let stored = "";
  let sendMessages: boolean | null = null;
  const role = { id: ROLE_ID, managed: true } as Role;
  const edit = vi.fn(
    async (_role: Role, permissions: { SendMessages: boolean | null }) => {
      if (options.editFails) {
        throw new Error("missing permission");
      }
      sendMessages = permissions.SendMessages;
    },
  );
  const channel = {
    id: CHANNEL_ID,
    permissionOverwrites: {
      cache: {
        get: vi.fn(() => ({
          allow: {
            has: (permission: bigint) =>
              permission === PermissionFlagsBits.SendMessages &&
              sendMessages === true,
          },
          deny: {
            has: (permission: bigint) =>
              permission === PermissionFlagsBits.SendMessages &&
              sendMessages === false,
          },
        })),
      },
      edit,
    },
  } as unknown as TextChannel;
  const actor = {
    user: { tag: "Emperor#0001" },
    guild: {
      roles: { cache: { get: vi.fn(() => role) } },
    },
  } as unknown as GuildMember;
  const storage = {
    metricsGet: vi.fn(
      (_key: string, defaultValue: string) => stored || defaultValue,
    ),
    metricsSet: vi.fn((_key: string, value: string | number) => {
      stored = String(value);
    }),
  };
  const runtime = {
    guildId: GUILD_ID,
    settings: {
      roles: {
        silenceTargets: [ROLE_ID],
        silenceExcludes: [],
      },
    },
    storage,
    isCurrent: () => true,
  } as unknown as GuildRuntime;
  return { actor, channel, runtime, role, edit };
}

describe("runtime silence lock", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("applies a silence overwrite to a configured managed role", async () => {
    const fixture = createFixture();

    await lockChannelSilently(
      fixture.channel,
      fixture.actor,
      fixture.runtime,
      120,
    );

    expect(fixture.edit).toHaveBeenCalledWith(
      fixture.role,
      { SendMessages: false },
      { reason: "Silence by Emperor#0001" },
    );
    expect(readSilenceLeases(fixture.runtime.storage)).toHaveLength(1);
  });

  it("reports Manage Roles when a silence overwrite cannot be applied", async () => {
    const fixture = createFixture({ editFails: true });
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await lockChannelSilently(
      fixture.channel,
      fixture.actor,
      fixture.runtime,
      120,
    );

    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining(
        "check Manage Roles permission and role hierarchy",
      ),
    );
    expect(readSilenceLeases(fixture.runtime.storage)).toEqual([]);
  });
});
