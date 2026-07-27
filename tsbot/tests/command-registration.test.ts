import { describe, expect, it, vi } from "vitest";
import type {
  Client,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import {
  buildCommandRegistrationPlan,
  synchronizeCommands,
} from "../src/discord/registration.js";

describe("command registration", () => {
  it("selects global registration for production", () => {
    expect(
      buildCommandRegistrationPlan("global", ["111111111111111111"]),
    ).toEqual({
      mode: "global",
      registerGlobal: true,
      developmentGuildIds: [],
    });
  });

  it("selects unique configured guilds for development registration", () => {
    expect(
      buildCommandRegistrationPlan("guild", [
        "111111111111111111",
        " 222222222222222222 ",
        "111111111111111111",
        "invalid",
      ]),
    ).toEqual({
      mode: "guild",
      registerGlobal: false,
      developmentGuildIds: [
        "111111111111111111",
        "222222222222222222",
      ],
    });
  });

  it("isolates a failed development-guild sync", async () => {
    const globalSet = vi.fn(async () => new Map());
    const guildBSet = vi.fn(async () => new Map([["command", {}]]));
    const fetch = vi.fn(async (guildId: string) => {
      if (guildId === "111111111111111111") {
        throw new Error("synthetic Discord failure");
      }
      return { commands: { set: guildBSet } };
    });
    const client = {
      application: { commands: { set: globalSet } },
      guilds: {
        cache: new Map(),
        fetch,
      },
    } as unknown as Client;

    await synchronizeCommands(
      client,
      {
        commandRegistrationMode: "guild",
        devGuildIds: [
          "111111111111111111",
          "222222222222222222",
        ],
      },
      [],
    );

    expect(globalSet).toHaveBeenCalledWith([]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(guildBSet).toHaveBeenCalledWith([]);
  });

  it("clears stale guild-scoped command sets when switching to global mode", async () => {
    const definitions: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
      { name: "court", description: "Court", type: 1 },
    ];
    const globalSet = vi.fn(async () => new Map([["court", {}]]));
    const guildASet = vi.fn(async () => new Map());
    const guildBSet = vi.fn(async () => new Map());
    const client = {
      application: { commands: { set: globalSet } },
      guilds: {
        cache: new Map([
          [
            "111111111111111111",
            { id: "111111111111111111", commands: { set: guildASet } },
          ],
          [
            "222222222222222222",
            { id: "222222222222222222", commands: { set: guildBSet } },
          ],
        ]),
      },
    } as unknown as Client;

    await synchronizeCommands(
      client,
      { commandRegistrationMode: "global", devGuildIds: [] },
      definitions,
    );

    expect(globalSet).toHaveBeenCalledTimes(1);
    expect(globalSet).toHaveBeenCalledWith(definitions);
    expect(guildASet).toHaveBeenCalledWith([]);
    expect(guildBSet).toHaveBeenCalledWith([]);
    expect(
      Math.max(
        guildASet.mock.invocationCallOrder[0] ?? 0,
        guildBSet.mock.invocationCallOrder[0] ?? 0,
      ),
    ).toBeLessThan(
      globalSet.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("preserves global definitions when a stale guild scope cannot be cleared", async () => {
    const definitions: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
      { name: "court", description: "Court", type: 1 },
    ];
    const globalSet = vi.fn(async () => new Map());
    const guildSet = vi.fn(async () => {
      throw new Error("synthetic clear failure");
    });
    const client = {
      application: { commands: { set: globalSet } },
      guilds: {
        cache: new Map([
          [
            "111111111111111111",
            { id: "111111111111111111", commands: { set: guildSet } },
          ],
        ]),
      },
    } as unknown as Client;

    await expect(
      synchronizeCommands(
        client,
        { commandRegistrationMode: "global", devGuildIds: [] },
        definitions,
      ),
    ).rejects.toThrow("guild command scope");

    expect(globalSet).not.toHaveBeenCalled();
  });

  it("clears global and non-target guild scopes in development mode", async () => {
    const targetGuildId = "111111111111111111";
    const staleGuildId = "222222222222222222";
    const definitions: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
      { name: "court", description: "Court", type: 1 },
    ];
    const globalSet = vi.fn(async () => new Map());
    const targetSet = vi.fn(async () => new Map([["court", {}]]));
    const staleSet = vi.fn(async () => new Map());
    const targetGuild = { id: targetGuildId, commands: { set: targetSet } };
    const staleGuild = { id: staleGuildId, commands: { set: staleSet } };
    const client = {
      application: { commands: { set: globalSet } },
      guilds: {
        cache: new Map([
          [targetGuildId, targetGuild],
          [staleGuildId, staleGuild],
        ]),
        fetch: vi.fn(async () => targetGuild),
      },
    } as unknown as Client;

    await synchronizeCommands(
      client,
      { commandRegistrationMode: "guild", devGuildIds: [targetGuildId] },
      definitions,
    );

    expect(globalSet).toHaveBeenCalledWith([]);
    expect(staleSet).toHaveBeenCalledWith([]);
    expect(targetSet).not.toHaveBeenCalledWith([]);
    expect(targetSet).toHaveBeenCalledWith(definitions);
  });
});
