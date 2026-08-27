import { PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { createVotingPanelScheduler } from "../src/discord/voting-scheduler.js";
import type { BotRuntime, GuildRuntime } from "../src/runtime.js";
import type { VotingPanel } from "../src/types.js";

const GUILD_ID = "111111111111111111";
const CHANNEL_ID = "222222222222222222";
const MESSAGE_ID = "333333333333333333";
const ADMIN_ID = "444444444444444444";
const BOT_ID = "555555555555555555";
const NOW = "2026-08-27T12:00:00.000Z";

describe("voting-panel scheduler", () => {
  it("completes due durable panels once and updates the original message", async () => {
    const due = panel({ deadlineAt: "2026-08-27T11:59:00.000Z" });
    const completed = panel({
      status: "completed",
      deadlineAt: due.deadlineAt,
      completedAt: NOW,
      completedBy: BOT_ID,
      mentionEveryoneOnCompletion: true,
      options: [
        { ...due.options[0]!, voteCount: 3 },
        { ...due.options[1]!, voteCount: 1 },
      ],
      totalVoters: 4,
    });
    const message = {
      id: MESSAGE_ID,
      author: { id: BOT_ID, bot: true },
      edit: vi.fn(async () => undefined),
    };
    const channel = {
      id: CHANNEL_ID,
      isDMBased: vi.fn(() => false),
      isTextBased: vi.fn(() => true),
      messages: { fetch: vi.fn(async () => message) },
      permissionsFor: vi.fn(() => ({
        has: (permission: bigint) =>
          permission === PermissionFlagsBits.MentionEveryone,
      })),
    };
    const botMember = { id: BOT_ID, user: { id: BOT_ID, bot: true } };
    const guild = {
      id: GUILD_ID,
      available: true,
      channels: { fetch: vi.fn(async () => channel) },
      members: { me: botMember, fetchMe: vi.fn(async () => botMember) },
    };
    const guildStorage = {
      listDueVotingPanels: vi
        .fn()
        .mockReturnValueOnce([due])
        .mockReturnValueOnce([]),
      transitionVotingPanel: vi.fn(() => ({
        status: "transitioned" as const,
        panel: completed,
      })),
      recordCommandMetric: vi.fn(),
    };
    const guildRuntime = {
      guildId: GUILD_ID,
      isCurrent: vi.fn(() => true),
      storage: guildStorage,
    } as unknown as GuildRuntime;
    const runtime = {
      storage: { listEnabledGuilds: vi.fn(() => [{ guildId: GUILD_ID }]) },
      forGuild: vi.fn(async () => guildRuntime),
    } as unknown as BotRuntime;
    const client = {
      user: { id: BOT_ID },
      guilds: { cache: new Map([[GUILD_ID, guild]]) },
    };
    const scheduler = createVotingPanelScheduler(client as never, runtime, {
      now: () => new Date(NOW),
    });

    await scheduler.runDue();
    await scheduler.runDue();

    expect(guildStorage.listDueVotingPanels).toHaveBeenCalledWith(NOW);
    expect(guildStorage.transitionVotingPanel).toHaveBeenCalledTimes(1);
    expect(guildStorage.transitionVotingPanel).toHaveBeenNthCalledWith(
      1,
      due.voteId,
      "completed",
      BOT_ID,
      NOW,
    );
    expect(message.edit).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "@everyone",
        allowedMentions: { parse: ["everyone"] },
      }),
    );
    expect(guildStorage.recordCommandMetric).toHaveBeenCalledWith(
      "panel.vote.auto-complete",
    );
  });

  it("handles a deleted voting message without failing reconciliation", async () => {
    const due = panel({ deadlineAt: "2026-08-27T11:59:00.000Z" });
    const channel = {
      id: CHANNEL_ID,
      isDMBased: vi.fn(() => false),
      isTextBased: vi.fn(() => true),
      messages: { fetch: vi.fn(async () => null) },
    };
    const guild = {
      id: GUILD_ID,
      available: true,
      channels: { fetch: vi.fn(async () => channel) },
      members: { me: null, fetchMe: vi.fn(async () => null) },
    };
    const guildStorage = {
      listDueVotingPanels: vi.fn(() => [due]),
      transitionVotingPanel: vi.fn(() => ({
        status: "transitioned" as const,
        panel: panel({
          status: "completed",
          deadlineAt: due.deadlineAt,
          completedAt: NOW,
          completedBy: BOT_ID,
        }),
      })),
      recordCommandMetric: vi.fn(),
    };
    const guildRuntime = {
      guildId: GUILD_ID,
      isCurrent: vi.fn(() => true),
      storage: guildStorage,
    } as unknown as GuildRuntime;
    const runtime = {
      storage: { listEnabledGuilds: vi.fn(() => [{ guildId: GUILD_ID }]) },
      forGuild: vi.fn(async () => guildRuntime),
    } as unknown as BotRuntime;
    const client = {
      user: { id: BOT_ID },
      guilds: { cache: new Map([[GUILD_ID, guild]]) },
    };
    const scheduler = createVotingPanelScheduler(client as never, runtime, {
      now: () => new Date(NOW),
    });

    await expect(scheduler.runDue()).resolves.toBeUndefined();
    expect(guildStorage.transitionVotingPanel).toHaveBeenCalledTimes(1);
    expect(guildStorage.recordCommandMetric).not.toHaveBeenCalled();
  });
});

function panel(overrides: Partial<VotingPanel> = {}): VotingPanel {
  return {
    guildId: GUILD_ID,
    voteId: "vote_panel",
    channelId: CHANNEL_ID,
    messageId: MESSAGE_ID,
    creatorId: ADMIN_ID,
    question: "Should the council approve this?",
    title: "Council vote",
    description: null,
    pollType: "yes-no",
    multiSelect: false,
    deadlineAt: null,
    mentionEveryoneOnCreation: false,
    mentionEveryoneOnCompletion: false,
    status: "active",
    completedBy: null,
    completedAt: null,
    cancelledBy: null,
    cancelledAt: null,
    createdAt: "2026-08-27T11:00:00.000Z",
    updatedAt: "2026-08-27T11:00:00.000Z",
    options: [
      {
        guildId: GUILD_ID,
        voteId: "vote_panel",
        optionId: "option-1",
        label: "Yes",
        sortOrder: 0,
        voteCount: 0,
      },
      {
        guildId: GUILD_ID,
        voteId: "vote_panel",
        optionId: "option-2",
        label: "No",
        sortOrder: 1,
        voteCount: 0,
      },
    ],
    totalVoters: 0,
    ...overrides,
  };
}
