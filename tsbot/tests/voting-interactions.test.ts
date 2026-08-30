import { MessageFlags, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
  handleVotingPanelButton,
  handleVotingPanelCommand,
} from "../src/discord/voting-interactions.js";
import {
  createVotingCloseCustomId,
  createVotingOptionCustomId,
  createVotingViewVotersCustomId,
} from "../src/discord/voting-panel.js";
import type { GuildRuntime } from "../src/runtime.js";
import type {
  VotingPanel,
  VotingPanelInput,
  VotingPanelVoter,
} from "../src/types.js";

const GUILD_ID = "111111111111111111";
const CHANNEL_ID = "222222222222222222";
const MESSAGE_ID = "333333333333333333";
const ADMIN_ID = "444444444444444444";
const VOTER_ID = "555555555555555555";
const BOT_ID = "666666666666666666";
const NOW = "2026-08-27T12:00:00.000Z";

describe("voting-panel Discord interactions", () => {
  it("requires Discord Administrator even when the creator is the guild owner", async () => {
    const harness = createCommandHarness({
      administrator: false,
      ownerId: ADMIN_ID,
    });

    await handleVotingPanelCommand(
      harness.interaction as never,
      harness.runtime,
    );

    expect(harness.channel.send).not.toHaveBeenCalled();
    expect(harness.storage.countActiveVotingPanels).not.toHaveBeenCalled();
    expect(harness.interaction.deferReply).not.toHaveBeenCalled();
    expect(harness.interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringMatching(/Administrator/i),
        flags: MessageFlags.Ephemeral,
      }),
    );
  });

  it("posts a complete panel in the invoking channel with a public result", async () => {
    const harness = createCommandHarness({
      mentionEveryoneOnCreation: true,
      allowEveryoneMention: true,
    });

    await handleVotingPanelCommand(
      harness.interaction as never,
      harness.runtime,
    );

    expect(harness.channel.send).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "@everyone",
        allowedMentions: { parse: ["everyone"] },
      }),
    );
    expect(harness.storage.createVotingPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: CHANNEL_ID,
        messageId: MESSAGE_ID,
        creatorId: ADMIN_ID,
        pollType: "yes-no",
        options: [
          { optionId: "option-1", label: "Yes" },
          { optionId: "option-2", label: "No" },
        ],
      }),
    );
    expect(harness.interaction.deferReply).toHaveBeenCalledWith();
    expect(harness.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Voting panel created"),
      }),
    );
    expect(harness.message.edit).not.toHaveBeenCalled();
  });

  it("keeps vote confirmations and voter lists ephemeral", async () => {
    const harness = createButtonHarness();
    harness.storage.listVotingPanelVoters.mockReturnValue([
      {
        guildId: GUILD_ID,
        voteId: harness.panel.voteId,
        voterId: VOTER_ID,
        optionIds: ["option-1"],
        updatedAt: NOW,
      },
    ]);

    expect(
      await handleVotingPanelButton(
        harness.optionInteraction as never,
        harness.runtime,
      ),
    ).toBe(true);
    expect(harness.optionInteraction.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });
    expect(harness.optionInteraction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringMatching(/Your vote/i),
        allowedMentions: { parse: [] },
      }),
    );
    expect(harness.message.edit).toHaveBeenCalled();

    expect(
      await handleVotingPanelButton(
        harness.viewInteraction as never,
        harness.runtime,
      ),
    ).toBe(true);
    expect(harness.viewInteraction.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });
    expect(harness.viewInteraction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: [expect.anything()],
        allowedMentions: { parse: [] },
      }),
    );
  });

  it("rolls back the posted message when persistence fails", async () => {
    const harness = createCommandHarness();
    harness.storage.createVotingPanel.mockImplementation(() => {
      throw new Error("synthetic persistence failure");
    });

    await handleVotingPanelCommand(
      harness.interaction as never,
      harness.runtime,
    );

    expect(harness.message.delete).toHaveBeenCalledOnce();
    expect(harness.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("posted panel was removed"),
      }),
    );
  });

  it("reports a posting failure without creating or deleting stored state", async () => {
    const harness = createCommandHarness();
    harness.channel.send.mockRejectedValueOnce(
      new Error("synthetic send failure"),
    );

    await handleVotingPanelCommand(
      harness.interaction as never,
      harness.runtime,
    );

    expect(harness.storage.createVotingPanel).not.toHaveBeenCalled();
    expect(harness.message.delete).not.toHaveBeenCalled();
    expect(harness.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("could not post"),
      }),
    );
  });

  it("returns unauthorized Close vote feedback privately without a transition", async () => {
    const harness = createButtonHarness({ administrator: false });

    expect(
      await handleVotingPanelButton(
        harness.closeInteraction as never,
        harness.runtime,
      ),
    ).toBe(true);

    expect(harness.storage.transitionVotingPanel).not.toHaveBeenCalled();
    expect(harness.closeInteraction.deferReply).not.toHaveBeenCalled();
    expect(harness.closeInteraction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringMatching(/Administrator/i),
        flags: MessageFlags.Ephemeral,
      }),
    );
  });

  it("reports the persisted terminal state when closing races with cancellation", async () => {
    const harness = createButtonHarness({ administrator: true });
    const cancelled = {
      ...harness.panel,
      status: "cancelled" as const,
      cancelledAt: NOW,
      cancelledBy: ADMIN_ID,
      updatedAt: "2026-08-27T12:01:00.000Z",
    };
    harness.storage.transitionVotingPanel.mockReturnValue({
      status: "conflict",
      panel: cancelled,
    });

    await expect(
      handleVotingPanelButton(
        harness.closeInteraction as never,
        harness.runtime,
      ),
    ).resolves.toBe(true);

    expect(harness.closeInteraction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "This vote was already cancelled.",
        allowedMentions: { parse: [] },
      }),
    );
    expect(harness.storage.recordCommandMetric).not.toHaveBeenCalledWith(
      "panel.vote.close",
    );
  });
});

function createCommandHarness(
  options: {
    administrator?: boolean;
    ownerId?: string;
    mentionEveryoneOnCreation?: boolean;
    allowEveryoneMention?: boolean;
  } = {},
) {
  const administrator = options.administrator ?? true;
  const guild: Record<string, any> = {
    id: GUILD_ID,
    ownerId: options.ownerId ?? "777777777777777777",
  };
  const actor = createMember(ADMIN_ID, guild, administrator);
  const botMember = createMember(BOT_ID, guild, true, true);
  guild.members = {
    me: botMember,
    fetch: vi.fn(async () => actor),
    fetchMe: vi.fn(async () => botMember),
  };
  const message = {
    id: MESSAGE_ID,
    author: { id: BOT_ID, bot: true },
    edit: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
  const channel = createChannel(
    guild,
    message,
    options.allowEveryoneMention ?? false,
  );
  const storage = {
    countActiveVotingPanels: vi.fn(() => 0),
    createVotingPanel: vi.fn((input: VotingPanelInput) =>
      panelFromInput(input),
    ),
    recordCommandMetric: vi.fn(),
  };
  const runtime = {
    guildId: GUILD_ID,
    isCurrent: vi.fn(() => true),
    storage,
  } as unknown as GuildRuntime;
  const interaction: Record<string, any> = {
    guild,
    guildId: GUILD_ID,
    channel,
    channelId: CHANNEL_ID,
    user: { id: ADMIN_ID },
    deferred: false,
    replied: false,
    options: {
      getString: vi.fn(
        (name: string) =>
          ({
            question: "Should the council approve this?",
            title: "Council vote",
            description: "Choose the answer you support.",
            poll_type: "yes-no",
            options: null,
          })[name] ?? null,
      ),
      getInteger: vi.fn(() => 0),
      getBoolean: vi.fn((name: string) =>
        name === "mention_everyone_on_creation"
          ? (options.mentionEveryoneOnCreation ?? false)
          : false,
      ),
    },
    reply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  };
  interaction.deferReply = vi.fn(async () => {
    interaction.deferred = true;
  });
  return {
    guild,
    actor,
    botMember,
    channel,
    message,
    storage,
    runtime,
    interaction,
  };
}

function createButtonHarness(options: { administrator?: boolean } = {}) {
  const guild: Record<string, any> = {
    id: GUILD_ID,
    ownerId: "777777777777777777",
  };
  const voter = createMember(VOTER_ID, guild, options.administrator ?? false);
  const botMember = createMember(BOT_ID, guild, true, true);
  guild.members = {
    me: botMember,
    fetch: vi.fn(async () => voter),
    fetchMe: vi.fn(async () => botMember),
  };
  const message = {
    id: MESSAGE_ID,
    author: { id: BOT_ID, bot: true },
    edit: vi.fn(async () => undefined),
  };
  const channel = createChannel(guild, message, false);
  const panel = panelFromInput({
    voteId: "vote_panel",
    channelId: CHANNEL_ID,
    messageId: MESSAGE_ID,
    creatorId: ADMIN_ID,
    question: "Should the council approve this?",
    pollType: "yes-no",
    multiSelect: false,
    options: [
      { optionId: "option-1", label: "Yes" },
      { optionId: "option-2", label: "No" },
    ],
  });
  const selected = {
    ...panel,
    options: panel.options.map((option) =>
      option.optionId === "option-1" ? { ...option, voteCount: 1 } : option,
    ),
    totalVoters: 1,
    updatedAt: "2026-08-27T12:01:00.000Z",
  };
  const storage = {
    getVotingPanel: vi.fn(() => panel),
    selectVotingPanelOption: vi.fn(() => ({
      status: "changed" as const,
      panel: selected,
      optionIds: ["option-1"],
    })),
    toggleVotingPanelOption: vi.fn(),
    getVotingPanelSelection: vi.fn(() => ["option-1"]),
    listVotingPanelVoters: vi.fn(() => [] as VotingPanelVoter[]),
    transitionVotingPanel: vi.fn(),
    recordCommandMetric: vi.fn(),
  };
  const runtime = {
    guildId: GUILD_ID,
    isCurrent: vi.fn(() => true),
    storage,
  } as unknown as GuildRuntime;
  return {
    panel,
    storage,
    runtime,
    message,
    optionInteraction: createButtonInteraction(
      guild,
      channel,
      message,
      createVotingOptionCustomId(panel.voteId, "option-1"),
    ),
    viewInteraction: createButtonInteraction(
      guild,
      channel,
      message,
      createVotingViewVotersCustomId(panel.voteId),
    ),
    closeInteraction: createButtonInteraction(
      guild,
      channel,
      message,
      createVotingCloseCustomId(panel.voteId),
    ),
  };
}

function createMember(
  id: string,
  guild: Record<string, any>,
  administrator: boolean,
  bot = false,
) {
  return {
    id,
    guild,
    user: { id, bot },
    permissions: {
      has: vi.fn(
        (permission: bigint) =>
          administrator && permission === PermissionFlagsBits.Administrator,
      ),
    },
  };
}

function createChannel(
  guild: Record<string, any>,
  message: Record<string, any>,
  allowEveryoneMention: boolean,
) {
  const permissions = new Set<bigint>([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.EmbedLinks,
    ...(allowEveryoneMention ? [PermissionFlagsBits.MentionEveryone] : []),
  ]);
  return {
    id: CHANNEL_ID,
    guild,
    isDMBased: vi.fn(() => false),
    isTextBased: vi.fn(() => true),
    isThread: vi.fn(() => false),
    permissionsFor: vi.fn(() => ({
      has: (permission: bigint) => permissions.has(permission),
    })),
    send: vi.fn(async () => message),
  };
}

function createButtonInteraction(
  guild: Record<string, any>,
  channel: Record<string, any>,
  message: Record<string, any>,
  customId: string,
) {
  const interaction: Record<string, any> = {
    customId,
    guild,
    guildId: GUILD_ID,
    channel,
    channelId: CHANNEL_ID,
    message,
    client: { user: { id: BOT_ID } },
    user: { id: VOTER_ID },
    deferred: false,
    replied: false,
    reply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  };
  interaction.deferReply = vi.fn(async () => {
    interaction.deferred = true;
  });
  return interaction;
}

function panelFromInput(input: VotingPanelInput): VotingPanel {
  const voteId = input.voteId ?? "vote_panel";
  return {
    guildId: GUILD_ID,
    voteId,
    channelId: input.channelId,
    messageId: input.messageId,
    creatorId: input.creatorId,
    question: input.question,
    title: input.title ?? null,
    description: input.description ?? null,
    pollType: input.pollType,
    multiSelect: input.multiSelect,
    deadlineAt: input.deadlineAt ?? null,
    mentionEveryoneOnCreation: input.mentionEveryoneOnCreation ?? false,
    mentionEveryoneOnCompletion: input.mentionEveryoneOnCompletion ?? false,
    status: "active",
    completedBy: null,
    completedAt: null,
    cancelledBy: null,
    cancelledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    options: input.options.map((option, sortOrder) => ({
      guildId: GUILD_ID,
      voteId,
      optionId: option.optionId,
      label: option.label,
      sortOrder,
      voteCount: 0,
    })),
    totalVoters: 0,
  };
}
