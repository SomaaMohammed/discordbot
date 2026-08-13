import { Collection, MessageFlags, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { GuildRuntime } from "../src/runtime.js";
import {
  clearBackfillStatus,
  handleActivityCommand,
  handleFunCommand,
} from "../src/discord/activity.js";

const GUILD_ID = "623456789012345678";
const USER_A = "723456789012345678";
const USER_B = "823456789012345678";

describe("activity backfill", () => {
  it("replaces one guild's user metrics only after a complete bounded scan", async () => {
    const reactionUsers = new Collection([
      [USER_A, { id: USER_A, bot: false }],
      [USER_B, { id: USER_B, bot: false }],
    ]);
    const messages = new Collection([
      [
        "1",
        {
          id: "1",
          createdTimestamp: Date.now(),
          author: { id: USER_A, bot: false },
          reactions: {
            cache: new Collection([
              ["r1", { users: { fetch: vi.fn(async () => reactionUsers) } }],
            ]),
          },
        },
      ],
      [
        "2",
        {
          id: "2",
          createdTimestamp: Date.now(),
          author: { id: USER_B, bot: false },
          reactions: { cache: new Collection() },
        },
      ],
    ]);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(messages)
      .mockResolvedValueOnce(new Collection());
    const channel = {
      id: "923456789012345678",
      guild: { id: GUILD_ID },
      isDMBased: vi.fn(() => false),
      isTextBased: vi.fn(() => true),
      permissionsFor: vi.fn(() => ({
        has: (permission: bigint) =>
          [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.ReadMessageHistory,
          ].includes(permission),
      })),
      messages: { fetch },
    };
    const replaceUserActivityMetrics = vi.fn();
    const recordCommandMetric = vi.fn();
    const editReply = vi.fn(async () => undefined);
    const interaction = {
      guild: {
        id: GUILD_ID,
        members: { me: { id: "bot" } },
        channels: { cache: new Collection([[channel.id, channel]]) },
      },
      options: {
        getSubcommand: vi.fn(() => "backfillstats"),
        getInteger: vi.fn(() => 30),
      },
      deferReply: vi.fn(async () => undefined),
      editReply,
    };
    const runtime = {
      guildId: GUILD_ID,
      storage: { replaceUserActivityMetrics, recordCommandMetric },
      isCurrent: vi.fn(() => true),
    } as unknown as GuildRuntime;

    await handleActivityCommand(interaction as never, runtime);

    expect(fetch).toHaveBeenCalled();
    expect(replaceUserActivityMetrics).toHaveBeenCalledTimes(1);
    expect(replaceUserActivityMetrics).toHaveBeenCalledWith(
      expect.arrayContaining([
        {
          userId: USER_A,
          metrics: expect.objectContaining({
            messages_sent: 1,
            reactions_sent: 1,
            reactions_received: 2,
          }),
        },
        {
          userId: USER_B,
          metrics: expect.objectContaining({
            messages_sent: 1,
            reactions_sent: 1,
          }),
        },
      ]),
    );
    expect(editReply).toHaveBeenCalledWith(
      expect.stringContaining("Users updated: **2**"),
    );
    expect(recordCommandMetric).toHaveBeenCalledWith("superior.backfillstats");
  });

  it("does not write partial metrics when a channel fetch fails", async () => {
    const channel = {
      id: "933456789012345678",
      guild: { id: GUILD_ID },
      isDMBased: vi.fn(() => false),
      isTextBased: vi.fn(() => true),
      permissionsFor: vi.fn(() => ({ has: vi.fn(() => true) })),
      messages: {
        fetch: vi.fn(async () => {
          throw new Error("synthetic history failure");
        }),
      },
    };
    const replaceUserActivityMetrics = vi.fn();
    const interaction = {
      guild: {
        id: GUILD_ID,
        members: { me: { id: "bot" } },
        channels: { cache: new Collection([[channel.id, channel]]) },
      },
      options: {
        getSubcommand: vi.fn(() => "backfillstats"),
        getInteger: vi.fn(() => 30),
      },
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
    };
    const runtime = {
      guildId: GUILD_ID,
      storage: { replaceUserActivityMetrics, recordCommandMetric: vi.fn() },
      isCurrent: vi.fn(() => true),
    } as unknown as GuildRuntime;

    await handleActivityCommand(interaction as never, runtime);

    expect(replaceUserActivityMetrics).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining("No partial replacement was written"),
    );
  });

  it("stops fetching reaction users immediately after runtime invalidation", async () => {
    let current = true;
    const firstReactionFetch = vi.fn(async () => {
      current = false;
      return new Collection([[USER_A, { id: USER_A, bot: false }]]);
    });
    const secondReactionFetch = vi.fn(
      async () => new Collection([[USER_B, { id: USER_B, bot: false }]]),
    );
    const message = {
      id: "103456789012345678",
      createdTimestamp: Date.now(),
      author: { id: USER_A, bot: false },
      reactions: {
        cache: new Collection([
          ["first", { users: { fetch: firstReactionFetch } }],
          ["second", { users: { fetch: secondReactionFetch } }],
        ]),
      },
    };
    const channel = {
      id: "203456789012345678",
      guild: { id: GUILD_ID },
      isDMBased: vi.fn(() => false),
      isTextBased: vi.fn(() => true),
      permissionsFor: vi.fn(() => ({ has: vi.fn(() => true) })),
      messages: {
        fetch: vi.fn(async () => new Collection([[message.id, message]])),
      },
    };
    const replaceUserActivityMetrics = vi.fn();
    const editReply = vi.fn(async () => undefined);
    const interaction = {
      guild: {
        id: GUILD_ID,
        members: { me: { id: "bot" } },
        channels: { cache: new Collection([[channel.id, channel]]) },
      },
      options: {
        getSubcommand: vi.fn(() => "backfillstats"),
        getInteger: vi.fn(() => 30),
      },
      deferred: false,
      replied: false,
      deferReply: vi.fn(async () => undefined),
      editReply,
    };
    const runtime = {
      guildId: GUILD_ID,
      storage: { replaceUserActivityMetrics, recordCommandMetric: vi.fn() },
      isCurrent: vi.fn(() => current),
    } as unknown as GuildRuntime;

    await handleActivityCommand(interaction as never, runtime);

    expect(firstReactionFetch).toHaveBeenCalledTimes(1);
    expect(secondReactionFetch).not.toHaveBeenCalled();
    expect(replaceUserActivityMetrics).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith(
      expect.stringContaining("Backfill cancelled"),
    );
  });

  it("does not claim replacement rollback when only the success reply fails", async () => {
    const replaceUserActivityMetrics = vi.fn();
    const editReply = vi.fn(async () => {
      throw new Error("synthetic acknowledgement failure");
    });
    const interaction = {
      guild: {
        id: GUILD_ID,
        members: { me: { id: "bot" } },
        channels: { cache: new Collection() },
      },
      options: {
        getSubcommand: vi.fn(() => "backfillstats"),
        getInteger: vi.fn(() => 30),
      },
      deferred: false,
      replied: false,
      deferReply: vi.fn(async () => undefined),
      editReply,
    };
    const runtime = {
      guildId: GUILD_ID,
      storage: { replaceUserActivityMetrics, recordCommandMetric: vi.fn() },
      isCurrent: vi.fn(() => true),
    } as unknown as GuildRuntime;

    await expect(
      handleActivityCommand(interaction as never, runtime),
    ).rejects.toThrow("synthetic acknowledgement failure");

    expect(replaceUserActivityMetrics).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalledTimes(1);
  });

  it("forgets process-local status when a guild is purged or leaves", async () => {
    clearBackfillStatus(GUILD_ID);
    const reply = vi.fn(async () => undefined);
    const interaction = {
      options: { getSubcommand: vi.fn(() => "backfillstatus") },
      deferred: false,
      replied: false,
      reply,
    };
    const runtime = {
      guildId: GUILD_ID,
      storage: { recordCommandMetric: vi.fn() },
    } as unknown as GuildRuntime;

    await handleActivityCommand(interaction as never, runtime);

    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("No activity backfill"),
      }),
    );
  });
});

describe("fun secure defaults", () => {
  it("exposes stored statistics immediately", async () => {
    const reply = vi.fn(async () => undefined);
    const getUserMetrics = vi.fn(() => ({
      messages_sent: 1,
      reactions_sent: 2,
      reactions_received: 3,
      battles_played: 4,
      battles_won: 5,
    }));
    const interaction = {
      options: {
        getSubcommand: vi.fn(() => "stats"),
        getUser: vi.fn(() => null),
      },
      user: { id: USER_A, username: "Member", globalName: null },
      deferred: false,
      replied: false,
      reply,
    };
    const runtime = {
      storage: { getUserMetrics, recordCommandMetric: vi.fn() },
    } as unknown as GuildRuntime;

    await handleFunCommand(interaction as never, runtime);

    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Stats for"),
        flags: MessageFlags.Ephemeral,
      }),
    );
    expect(getUserMetrics).toHaveBeenCalledWith(USER_A);
  });

  it("edits the receipt-time deferral for a leaderboard", async () => {
    const editReply = vi.fn(async () => undefined);
    const reply = vi.fn(async () => undefined);
    const recordCommandMetric = vi.fn();
    const interaction = {
      options: {
        getSubcommand: vi.fn(() => "leaderboard"),
        getString: vi.fn(() => "messages_sent"),
        getInteger: vi.fn(() => 10),
      },
      deferred: true,
      replied: false,
      editReply,
      followUp: vi.fn(async () => undefined),
      reply,
    };
    const runtime = {
      storage: {
        getUserLeaderboard: vi.fn(() => [{ userId: USER_A, value: 7 }]),
        recordCommandMetric,
      },
    } as unknown as GuildRuntime;

    await handleFunCommand(interaction as never, runtime);

    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("**7**") }),
    );
    expect(reply).not.toHaveBeenCalled();
    expect(recordCommandMetric).toHaveBeenCalledWith("fun.leaderboard");
  });
});
