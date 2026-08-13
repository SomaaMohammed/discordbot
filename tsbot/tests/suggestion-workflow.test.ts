import { ChannelType, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { GuildRuntime } from "../src/runtime.js";
import type {
  SuggestionConfiguration,
  SuggestionRecord,
} from "../src/types.js";
import { handleSuggestionCommand } from "../src/discord/suggestion-commands-handler.js";
import {
  postSuggestionReviewEntry,
  publishReservedSuggestion,
  refreshSuggestionPublicMessage,
} from "../src/discord/suggestion-delivery.js";
import {
  SUGGESTION_DETAILS_FIELD_ID,
  SUGGESTION_TITLE_FIELD_ID,
} from "../src/discord/suggestion-components.js";
import {
  handleSuggestionButton,
  handleSuggestionModal,
} from "../src/discord/suggestion-interactions.js";

const GUILD_ID = "111111111111111111";
const OTHER_GUILD_ID = "121212121212121212";
const BOT_ID = "222222222222222222";
const REVIEWER_ID = "333333333333333333";
const AUTHOR_ID = "444444444444444444";
const REVIEWER_ROLE_ID = "555555555555555555";
const CONFIGURE_ROLE_ID = "565656565656565656";
const CHANNEL_ID = "666666666666666666";
const REVIEW_CHANNEL_ID = "676767676767676767";
const MESSAGE_ID = "777777777777777777";
const OLD_THREAD_ID = "888888888888888888";
const NEW_THREAD_ID = "999999999999999999";
const SUGGESTION_ID = "suggestion1";

function configuration(
  overrides: Partial<SuggestionConfiguration> = {},
): SuggestionConfiguration {
  return {
    guildId: GUILD_ID,
    enabled: true,
    suggestionChannelId: CHANNEL_ID,
    reviewChannelId: null,
    reviewerRoleId: REVIEWER_ROLE_ID,
    createThreads: true,
    cooldownLimit: 3,
    cooldownWindowSeconds: 600,
    allowSelfVotes: false,
    bindingsVerifiedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

function suggestion(
  overrides: Partial<SuggestionRecord> = {},
): SuggestionRecord {
  return {
    guildId: GUILD_ID,
    suggestionId: SUGGESTION_ID,
    suggestionNumber: 4,
    authorId: AUTHOR_ID,
    title: "Create a handbook",
    details: "Publish a concise handbook for new community members.",
    state: "open",
    deliveryState: "posted",
    channelId: CHANNEL_ID,
    messageId: MESSAGE_ID,
    threadId: OLD_THREAD_ID,
    reviewerId: null,
    reviewReason: null,
    reviewedAt: null,
    withdrawnAt: null,
    failureReason: null,
    createdAt: "2026-01-01T00:00:02.000Z",
    updatedAt: "2026-01-01T00:00:03.000Z",
    ...overrides,
  };
}

function guildHarness(options: { owner?: boolean } = {}) {
  const guild: Record<string, any> = {
    id: GUILD_ID,
    ownerId: options.owner ? REVIEWER_ID : "101010101010101010",
  };
  const reviewerRole = {
    id: REVIEWER_ROLE_ID,
    guild,
    managed: false,
  };
  const configureRole = {
    id: CONFIGURE_ROLE_ID,
    guild,
    managed: false,
  };
  const member = {
    id: REVIEWER_ID,
    guild,
    user: { id: REVIEWER_ID, bot: false },
    permissions: {
      has: vi.fn(
        (permission: bigint) =>
          permission === PermissionFlagsBits.Administrator && false,
      ),
    },
    roles: {
      cache: new Map([
        [REVIEWER_ROLE_ID, reviewerRole],
        [CONFIGURE_ROLE_ID, configureRole],
      ]),
    },
  };
  const botMember = {
    id: BOT_ID,
    guild,
    user: { id: BOT_ID, bot: true },
  };
  const recoveredThread = {
    id: NEW_THREAD_ID,
    guild,
    archived: false,
    isThread: vi.fn(() => true),
    setArchived: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
  const publicMessage: Record<string, any> = {
    id: MESSAGE_ID,
    channelId: CHANNEL_ID,
    author: { id: BOT_ID },
    thread: null,
    edit: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    startThread: vi.fn(async () => recoveredThread),
  };
  const publicChannel = {
    id: CHANNEL_ID,
    guild,
    type: ChannelType.GuildText,
    isDMBased: vi.fn(() => false),
    messages: {
      fetch: vi.fn(async (id: string) =>
        id === MESSAGE_ID ? publicMessage : null,
      ),
    },
    send: vi.fn(async () => publicMessage),
    permissionsFor: vi.fn(() => ({ has: vi.fn(() => true) })),
  };
  guild.client = {
    user: { id: BOT_ID },
    users: { fetch: vi.fn(async () => null) },
  };
  guild.members = {
    me: botMember,
    fetch: vi.fn(async () => member),
    fetchMe: vi.fn(async () => botMember),
  };
  guild.roles = {
    fetch: vi.fn(async (id: string) => {
      if (id === REVIEWER_ROLE_ID) return reviewerRole;
      if (id === CONFIGURE_ROLE_ID) return configureRole;
      return null;
    }),
  };
  guild.channels = {
    fetch: vi.fn(async (id: string) => {
      if (id === CHANNEL_ID) return publicChannel;
      if (id === OLD_THREAD_ID) {
        throw Object.assign(new Error("Unknown Channel"), { code: 10_003 });
      }
      if (id === NEW_THREAD_ID) return recoveredThread;
      return null;
    }),
  };
  return {
    guild,
    member,
    reviewerRole,
    configureRole,
    publicChannel,
    publicMessage,
    recoveredThread,
  };
}

function runtime(storage: Record<string, any>, guild: Record<string, any>) {
  return {
    guildId: GUILD_ID,
    guild,
    storage,
    isCurrent: vi.fn(() => true),
    invalidate: vi.fn(),
  } as unknown as GuildRuntime;
}

function buttonInteraction(
  guild: Record<string, any>,
  customId: string,
  overrides: { guildId?: string; channelId?: string } = {},
) {
  const interaction: Record<string, any> = {
    customId,
    guild,
    guildId: overrides.guildId ?? guild.id,
    channelId: overrides.channelId ?? CHANNEL_ID,
    user: { id: REVIEWER_ID },
    client: guild.client,
    message: { id: MESSAGE_ID, author: { id: BOT_ID }, edit: vi.fn() },
    deferred: false,
    replied: false,
    reply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    showModal: vi.fn(async () => undefined),
  };
  interaction.deferReply = vi.fn(async () => {
    interaction.deferred = true;
  });
  return interaction;
}

function modalInteraction(guild: Record<string, any>) {
  const values: Record<string, string> = {
    [SUGGESTION_TITLE_FIELD_ID]: "Create a handbook",
    [SUGGESTION_DETAILS_FIELD_ID]:
      "Publish a concise handbook for new community members.",
  };
  const interaction: Record<string, any> = {
    customId: "superior:suggestion:submit-modal:command",
    guild,
    guildId: guild.id,
    channelId: CHANNEL_ID,
    user: { id: REVIEWER_ID },
    client: guild.client,
    fields: {
      getTextInputValue: vi.fn((fieldId: string) => values[fieldId] ?? ""),
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
  return interaction;
}

describe("suggestion delivery and recovery", () => {
  it("repairs a missing discussion thread without reposting a healthy message", async () => {
    const harness = guildHarness();
    const before = suggestion();
    const rebound = suggestion({ threadId: NEW_THREAD_ID });
    const storage = {
      getSuggestionById: vi.fn(() => before),
      getSuggestionVoteCounts: vi.fn(() => ({
        upvotes: 2,
        downvotes: 1,
        score: 1,
      })),
      bindSuggestionDelivery: vi.fn(() => ({
        status: "posted",
        suggestion: rebound,
      })),
      failSuggestionDelivery: vi.fn(),
      markSuggestionDeliveryMissing: vi.fn(),
    };

    await expect(
      refreshSuggestionPublicMessage(
        harness.guild as never,
        before,
        storage as never,
        REVIEWER_ID,
        configuration(),
      ),
    ).resolves.toBe("updated");
    expect(harness.publicMessage.edit).toHaveBeenCalledTimes(1);
    expect(harness.publicMessage.startThread).toHaveBeenCalledTimes(1);
    expect(storage.bindSuggestionDelivery).toHaveBeenCalledWith(SUGGESTION_ID, {
      channelId: CHANNEL_ID,
      messageId: MESSAGE_ID,
      threadId: NEW_THREAD_ID,
      expectedUpdatedAt: before.updatedAt,
    });
    expect(harness.publicChannel.send).not.toHaveBeenCalled();
  });

  it("does not convert a transient lookup outage into a missing binding", async () => {
    const harness = guildHarness();
    harness.guild.channels.fetch.mockRejectedValueOnce(
      new Error("temporary Discord outage"),
    );
    const storage = {
      getSuggestionById: vi.fn(() => suggestion()),
      getSuggestionVoteCounts: vi.fn(() => ({
        upvotes: 0,
        downvotes: 0,
        score: 0,
      })),
      bindSuggestionDelivery: vi.fn(),
      failSuggestionDelivery: vi.fn(),
      markSuggestionDeliveryMissing: vi.fn(),
    };

    await expect(
      refreshSuggestionPublicMessage(
        harness.guild as never,
        suggestion(),
        storage as never,
        REVIEWER_ID,
        configuration(),
      ),
    ).resolves.toBe("unavailable");
    expect(storage.markSuggestionDeliveryMissing).not.toHaveBeenCalled();
  });

  it("does not mark a suggestion missing after refresh runtime invalidation", async () => {
    const harness = guildHarness();
    let current = true;
    harness.guild.channels.fetch.mockImplementationOnce(async () => {
      current = false;
      return null;
    });
    const storage = {
      getSuggestionById: vi.fn(() => suggestion()),
      getSuggestionVoteCounts: vi.fn(() => ({
        upvotes: 0,
        downvotes: 0,
        score: 0,
      })),
      bindSuggestionDelivery: vi.fn(),
      failSuggestionDelivery: vi.fn(),
      markSuggestionDeliveryMissing: vi.fn(),
    };

    await expect(
      refreshSuggestionPublicMessage(
        harness.guild as never,
        suggestion(),
        storage as never,
        REVIEWER_ID,
        configuration(),
        () => current,
      ),
    ).resolves.toBe("unavailable");
    expect(storage.markSuggestionDeliveryMissing).not.toHaveBeenCalled();
  });

  it("marks an unknown tracked message missing without treating a stale snapshot as current", async () => {
    const harness = guildHarness();
    harness.publicChannel.messages.fetch.mockRejectedValue(
      Object.assign(new Error("Unknown Message"), { code: 10_008 }),
    );
    const before = suggestion();
    const missing = suggestion({
      deliveryState: "missing",
      updatedAt: "2026-01-01T00:00:04.000Z",
    });
    const storage = {
      getSuggestionById: vi.fn(() => before),
      getSuggestionVoteCounts: vi.fn(() => ({
        upvotes: 0,
        downvotes: 0,
        score: 0,
      })),
      bindSuggestionDelivery: vi.fn(),
      failSuggestionDelivery: vi.fn(),
      markSuggestionDeliveryMissing: vi.fn(() => ({
        status: "missing",
        suggestion: missing,
      })),
    };

    await expect(
      refreshSuggestionPublicMessage(
        harness.guild as never,
        before,
        storage as never,
        REVIEWER_ID,
      ),
    ).resolves.toBe("missing");
    expect(storage.markSuggestionDeliveryMissing).toHaveBeenCalledWith(
      SUGGESTION_ID,
      REVIEWER_ID,
    );

    storage.getSuggestionById.mockReturnValueOnce(
      suggestion({ updatedAt: "2026-01-01T00:00:05.000Z" }),
    );
    await expect(
      refreshSuggestionPublicMessage(
        harness.guild as never,
        before,
        storage as never,
        REVIEWER_ID,
      ),
    ).resolves.toBe("unavailable");
    expect(storage.markSuggestionDeliveryMissing).toHaveBeenCalledTimes(1);
  });

  it("records a bounded send failure without masking the Discord error", async () => {
    const harness = guildHarness();
    const failure = new Error("");
    harness.publicChannel.send.mockRejectedValueOnce(failure);
    const storage = {
      getSuggestionVoteCounts: vi.fn(() => ({
        upvotes: 0,
        downvotes: 0,
        score: 0,
      })),
      bindSuggestionDelivery: vi.fn(),
      failSuggestionDelivery: vi.fn(() => {
        throw new Error("secondary storage failure");
      }),
      markSuggestionDeliveryMissing: vi.fn(),
    };

    await expect(
      publishReservedSuggestion(
        harness.guild as never,
        harness.publicChannel as never,
        configuration(),
        suggestion({
          deliveryState: "reserved",
          channelId: null,
          messageId: null,
          threadId: null,
        }),
        storage as never,
      ),
    ).rejects.toBe(failure);
    expect(storage.failSuggestionDelivery).toHaveBeenCalledWith(
      SUGGESTION_ID,
      "Suggestion delivery failed.",
    );
  });

  it("rolls back Discord resources when configuration changes during delivery", async () => {
    const harness = guildHarness();
    const initial = configuration();
    const storage = {
      getSuggestionConfiguration: vi.fn(() =>
        configuration({ updatedAt: "2026-01-01T00:00:09.000Z" }),
      ),
      getSuggestionVoteCounts: vi.fn(() => ({
        upvotes: 0,
        downvotes: 0,
        score: 0,
      })),
      bindSuggestionDelivery: vi.fn(),
      failSuggestionDelivery: vi.fn(() => ({
        status: "failed",
        suggestion: suggestion({ deliveryState: "failed" }),
      })),
      markSuggestionDeliveryMissing: vi.fn(),
    };

    await expect(
      publishReservedSuggestion(
        harness.guild as never,
        harness.publicChannel as never,
        initial,
        suggestion({
          deliveryState: "reserved",
          channelId: null,
          messageId: null,
          threadId: null,
        }),
        storage as never,
      ),
    ).rejects.toThrow("configuration changed");
    expect(storage.bindSuggestionDelivery).not.toHaveBeenCalled();
    expect(harness.recoveredThread.delete).toHaveBeenCalledTimes(1);
    expect(harness.publicMessage.delete).toHaveBeenCalledTimes(1);
  });

  it("rolls back a sent message without stale storage writes when the runtime changes", async () => {
    const harness = guildHarness();
    let current = true;
    harness.publicChannel.send.mockImplementationOnce(async () => {
      current = false;
      return harness.publicMessage;
    });
    const storage = {
      getSuggestionConfiguration: vi.fn(() => configuration()),
      getSuggestionVoteCounts: vi.fn(() => ({
        upvotes: 0,
        downvotes: 0,
        score: 0,
      })),
      bindSuggestionDelivery: vi.fn(),
      failSuggestionDelivery: vi.fn(),
      markSuggestionDeliveryMissing: vi.fn(),
    };

    await expect(
      publishReservedSuggestion(
        harness.guild as never,
        harness.publicChannel as never,
        configuration(),
        suggestion({
          deliveryState: "reserved",
          channelId: null,
          messageId: null,
          threadId: null,
        }),
        storage as never,
        () => current,
      ),
    ).rejects.toThrow(/server changed/i);
    expect(harness.publicMessage.delete).toHaveBeenCalledTimes(1);
    expect(storage.bindSuggestionDelivery).not.toHaveBeenCalled();
    expect(storage.failSuggestionDelivery).not.toHaveBeenCalled();
  });

  it("does not send a review entry for a reconfigured workflow", async () => {
    const harness = guildHarness();
    const expected = configuration({ reviewChannelId: REVIEW_CHANNEL_ID });
    const reviewChannel = {
      id: REVIEW_CHANNEL_ID,
      guild: harness.guild,
      send: vi.fn(),
    };
    const storage = {
      getSuggestionConfiguration: vi.fn(() =>
        configuration({
          reviewChannelId: REVIEW_CHANNEL_ID,
          updatedAt: "2026-01-01T00:00:09.000Z",
        }),
      ),
    };

    await postSuggestionReviewEntry(
      reviewChannel as never,
      suggestion(),
      { upvotes: 0, downvotes: 0, score: 0 },
      expected,
      storage as never,
    );

    expect(reviewChannel.send).not.toHaveBeenCalled();
  });

  it("deletes a review entry when the runtime changes during its send", async () => {
    const harness = guildHarness();
    const expected = configuration({ reviewChannelId: REVIEW_CHANNEL_ID });
    const reviewMessage = { delete: vi.fn(async () => undefined) };
    let current = true;
    const reviewChannel = {
      id: REVIEW_CHANNEL_ID,
      guild: harness.guild,
      send: vi.fn(async () => {
        current = false;
        return reviewMessage;
      }),
    };
    const storage = {
      getSuggestionConfiguration: vi.fn(() => expected),
    };

    await postSuggestionReviewEntry(
      reviewChannel as never,
      suggestion(),
      { upvotes: 0, downvotes: 0, score: 0 },
      expected,
      storage as never,
      () => current,
    );

    expect(reviewChannel.send).toHaveBeenCalledTimes(1);
    expect(reviewMessage.delete).toHaveBeenCalledTimes(1);
  });

  it("deletes a review entry when configuration changes during its send", async () => {
    const harness = guildHarness();
    const expected = configuration({ reviewChannelId: REVIEW_CHANNEL_ID });
    const changed = configuration({
      reviewChannelId: REVIEW_CHANNEL_ID,
      updatedAt: "2026-01-01T00:00:09.000Z",
    });
    const reviewMessage = { delete: vi.fn(async () => undefined) };
    const storage = {
      getSuggestionConfiguration: vi
        .fn()
        .mockReturnValueOnce(expected)
        .mockReturnValue(changed),
    };
    const reviewChannel = {
      id: REVIEW_CHANNEL_ID,
      guild: harness.guild,
      send: vi.fn(async () => reviewMessage),
    };

    await postSuggestionReviewEntry(
      reviewChannel as never,
      suggestion(),
      { upvotes: 0, downvotes: 0, score: 0 },
      expected,
      storage as never,
    );

    expect(reviewChannel.send).toHaveBeenCalledTimes(1);
    expect(reviewMessage.delete).toHaveBeenCalledTimes(1);
  });

  it("recovers a verified workflow after local submission is disabled", async () => {
    const harness = guildHarness({ owner: true });
    const before = suggestion();
    const rebound = suggestion({ threadId: NEW_THREAD_ID });
    const storage = {
      getSuggestionConfiguration: vi.fn(() =>
        configuration({ enabled: false }),
      ),
      getSuggestionByNumber: vi.fn(() => before),
      getSuggestionById: vi.fn(() => before),
      getSuggestionVoteCounts: vi.fn(() => ({
        upvotes: 0,
        downvotes: 0,
        score: 0,
      })),
      bindSuggestionDelivery: vi.fn(() => ({
        status: "posted",
        suggestion: rebound,
      })),
      markSuggestionDeliveryMissing: vi.fn(),
      listCapabilitiesForRoles: vi.fn(() => []),
      recordCommandMetric: vi.fn(),
    };
    const interaction: Record<string, any> = {
      guild: harness.guild,
      guildId: GUILD_ID,
      user: { id: REVIEWER_ID },
      options: {
        getSubcommand: vi.fn(() => "recover"),
        getInteger: vi.fn(() => 4),
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

    await handleSuggestionCommand(
      interaction as never,
      runtime(storage, harness.guild),
    );

    expect(harness.publicMessage.startThread).toHaveBeenCalledTimes(1);
    expect(harness.publicChannel.send).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("healthy") }),
    );
  });

  it("refuses recovery while imported suggestion bindings are unverified", async () => {
    const harness = guildHarness({ owner: true });
    const storage = {
      getSuggestionConfiguration: vi.fn(() =>
        configuration({ enabled: false, bindingsVerifiedAt: null }),
      ),
      getSuggestionByNumber: vi.fn(() => suggestion()),
      listCapabilitiesForRoles: vi.fn(() => []),
      recordCommandMetric: vi.fn(),
    };
    const interaction: Record<string, any> = {
      guild: harness.guild,
      guildId: GUILD_ID,
      user: { id: REVIEWER_ID },
      options: {
        getSubcommand: vi.fn(() => "recover"),
        getInteger: vi.fn(() => 4),
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

    await handleSuggestionCommand(
      interaction as never,
      runtime(storage, harness.guild),
    );

    expect(harness.publicMessage.edit).not.toHaveBeenCalled();
    expect(harness.publicMessage.startThread).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("unavailable"),
      }),
    );
  });
});

describe("suggestion interactions", () => {
  it("submits a modal privately and persists its Discord delivery", async () => {
    const harness = guildHarness();
    const reserved = suggestion({
      deliveryState: "reserved",
      channelId: null,
      messageId: null,
      threadId: null,
    });
    const posted = suggestion({ threadId: NEW_THREAD_ID });
    const storage = {
      getSuggestionConfiguration: vi.fn(() => configuration()),
      reserveSuggestion: vi.fn(() => ({
        status: "created",
        suggestion: reserved,
      })),
      getSuggestionVoteCounts: vi.fn(() => ({
        upvotes: 0,
        downvotes: 0,
        score: 0,
      })),
      bindSuggestionDelivery: vi.fn(() => ({
        status: "posted",
        suggestion: posted,
      })),
      failSuggestionDelivery: vi.fn(),
      markSuggestionDeliveryMissing: vi.fn(),
      listCapabilitiesForRoles: vi.fn(() => []),
      recordCommandMetric: vi.fn(),
    };
    const interaction = modalInteraction(harness.guild);

    await handleSuggestionModal(
      interaction as never,
      runtime(storage, harness.guild),
    );

    expect(storage.reserveSuggestion).toHaveBeenCalledWith({
      authorId: REVIEWER_ID,
      title: "Create a handbook",
      details: "Publish a concise handbook for new community members.",
    });
    expect(storage.bindSuggestionDelivery).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("posted") }),
    );
  });

  it("enforces a persisted cooldown before Discord delivery", async () => {
    const harness = guildHarness();
    const storage = {
      getSuggestionConfiguration: vi.fn(() => configuration()),
      reserveSuggestion: vi.fn(() => ({
        status: "cooldown",
        suggestion: null,
        recentCount: 3,
        retryAt: "2026-01-01T00:10:00.000Z",
      })),
      listCapabilitiesForRoles: vi.fn(() => []),
      recordCommandMetric: vi.fn(),
    };
    const interaction = modalInteraction(harness.guild);

    await handleSuggestionModal(
      interaction as never,
      runtime(storage, harness.guild),
    );

    expect(harness.publicChannel.send).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("suggestion limit"),
      }),
    );
  });

  it("keeps one vote row and renders final totals after concurrent vote switches", async () => {
    const harness = guildHarness();
    let vote: -1 | 0 | 1 = 0;
    let releaseFirstEdit!: () => void;
    harness.publicMessage.edit
      .mockImplementationOnce(
        () =>
          new Promise<undefined>((resolve) => {
            releaseFirstEdit = () => resolve(undefined);
          }),
      )
      .mockResolvedValue(undefined);
    const storage = {
      getSuggestionConfiguration: vi.fn(() =>
        configuration({ createThreads: false }),
      ),
      getSuggestionById: vi.fn(() => suggestion({ threadId: null })),
      toggleSuggestionVote: vi.fn(
        (_suggestionId: string, _voterId: string, direction: -1 | 1) => {
          const previous = vote;
          vote = vote === direction ? 0 : direction;
          return {
            status:
              vote === 0 ? "removed" : previous === 0 ? "added" : "switched",
            suggestion: suggestion({ threadId: null }),
            counts: {
              upvotes: vote === 1 ? 1 : 0,
              downvotes: vote === -1 ? 1 : 0,
              score: vote,
            },
          };
        },
      ),
      getSuggestionVoteCounts: vi.fn(() => ({
        upvotes: vote === 1 ? 1 : 0,
        downvotes: vote === -1 ? 1 : 0,
        score: vote,
      })),
      bindSuggestionDelivery: vi.fn(),
      failSuggestionDelivery: vi.fn(),
      markSuggestionDeliveryMissing: vi.fn(),
      listCapabilitiesForRoles: vi.fn(() => []),
      recordCommandMetric: vi.fn(),
    };
    const up = buttonInteraction(
      harness.guild,
      `superior:suggestion:vote:up:${SUGGESTION_ID}`,
    );
    const down = buttonInteraction(
      harness.guild,
      `superior:suggestion:vote:down:${SUGGESTION_ID}`,
    );

    const deliveries = Promise.all([
      handleSuggestionButton(up as never, runtime(storage, harness.guild)),
      handleSuggestionButton(down as never, runtime(storage, harness.guild)),
    ]);
    await vi.waitFor(() =>
      expect(
        harness.publicMessage.edit.mock.calls.length,
      ).toBeGreaterThanOrEqual(2),
    );
    releaseFirstEdit();
    await deliveries;

    expect(storage.toggleSuggestionVote).toHaveBeenCalledTimes(2);
    expect(Math.abs(vote)).toBe(1);
    const finalPayload = (harness.publicMessage.edit as any).mock.calls.at(
      -1,
    )?.[0] as {
      embeds?: Array<{
        toJSON(): { fields?: Array<{ name: string; value: string }> };
      }>;
    };
    const voteField = finalPayload.embeds?.[0]
      ?.toJSON()
      .fields?.find(({ name }) => name === "Votes");
    expect(voteField?.value).toContain(
      Number(vote) === 1 ? "Up **1**" : "Down **1**",
    );
  });

  it("rejects a vote when the binding changes during forced member verification", async () => {
    const harness = guildHarness();
    const before = suggestion();
    const after = suggestion({
      messageId: "131313131313131313",
      updatedAt: "2026-01-01T00:00:04.000Z",
    });
    const storage = {
      getSuggestionConfiguration: vi.fn(() => configuration()),
      getSuggestionById: vi
        .fn()
        .mockReturnValueOnce(before)
        .mockReturnValueOnce(after),
      toggleSuggestionVote: vi.fn(),
      getSuggestionVoteCounts: vi.fn(),
      listCapabilitiesForRoles: vi.fn(() => []),
      recordCommandMetric: vi.fn(),
    };
    const interaction = buttonInteraction(
      harness.guild,
      `superior:suggestion:vote:up:${SUGGESTION_ID}`,
    );

    await handleSuggestionButton(
      interaction as never,
      runtime(storage, harness.guild),
    );

    expect(harness.guild.members.fetch).toHaveBeenCalledWith({
      user: REVIEWER_ID,
      cache: true,
      force: true,
    });
    expect(storage.toggleSuggestionVote).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("changed") }),
    );
  });

  it("keeps dormant imported bindings out of review controls", async () => {
    const harness = guildHarness({ owner: true });
    const storage = {
      getSuggestionConfiguration: vi.fn(() =>
        configuration({ bindingsVerifiedAt: null }),
      ),
      getSuggestionById: vi.fn(() => suggestion()),
      listCapabilitiesForRoles: vi.fn(() => []),
      recordCommandMetric: vi.fn(),
    };
    const interaction = buttonInteraction(
      harness.guild,
      `superior:suggestion:review:accepted:${SUGGESTION_ID}`,
      { channelId: REVIEW_CHANNEL_ID },
    );

    await handleSuggestionButton(
      interaction as never,
      runtime(storage, harness.guild),
    );

    expect(interaction.showModal).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("outdated") }),
    );
  });

  it("allows verified review controls while disabled but rejects cross-guild controls", async () => {
    const harness = guildHarness();
    const storage = {
      getSuggestionConfiguration: vi.fn(() =>
        configuration({ enabled: false, reviewChannelId: REVIEW_CHANNEL_ID }),
      ),
      getSuggestionById: vi.fn(() => suggestion()),
      listCapabilitiesForRoles: vi.fn(() => []),
      recordCommandMetric: vi.fn(),
    };
    const authorized = buttonInteraction(
      harness.guild,
      `superior:suggestion:review:accepted:${SUGGESTION_ID}`,
      { channelId: REVIEW_CHANNEL_ID },
    );
    await handleSuggestionButton(
      authorized as never,
      runtime(storage, harness.guild),
    );
    expect(authorized.showModal).toHaveBeenCalledTimes(1);

    const otherGuild = { ...harness.guild, id: OTHER_GUILD_ID };
    const crossGuild = buttonInteraction(
      otherGuild,
      `superior:suggestion:review:accepted:${SUGGESTION_ID}`,
      { guildId: OTHER_GUILD_ID },
    );
    await handleSuggestionButton(
      crossGuild as never,
      runtime(storage, harness.guild),
    );
    expect(crossGuild.showModal).not.toHaveBeenCalled();
    expect(crossGuild.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("outdated"),
      }),
    );
  });

  it("rejects review controls when configuration changes during authorization", async () => {
    const harness = guildHarness();
    const initial = configuration({ reviewChannelId: REVIEW_CHANNEL_ID });
    const changed = configuration({
      reviewChannelId: REVIEW_CHANNEL_ID,
      updatedAt: "2026-01-01T00:00:09.000Z",
    });
    const storage = {
      getSuggestionConfiguration: vi
        .fn()
        .mockReturnValueOnce(initial)
        .mockReturnValueOnce(changed),
      getSuggestionById: vi.fn(() => suggestion()),
      listCapabilitiesForRoles: vi.fn(() => []),
      recordCommandMetric: vi.fn(),
    };
    const interaction = buttonInteraction(
      harness.guild,
      `superior:suggestion:review:accepted:${SUGGESTION_ID}`,
      { channelId: REVIEW_CHANNEL_ID },
    );

    await handleSuggestionButton(
      interaction as never,
      runtime(storage, harness.guild),
    );

    expect(interaction.showModal).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("changed") }),
    );
  });
});

describe("suggestion member withdrawal generation", () => {
  it("does not read or mutate a withdrawal after invalidation during defer", async () => {
    const harness = guildHarness();
    const storage = {
      getSuggestionByNumber: vi.fn(),
      withdrawSuggestion: vi.fn(),
      recordCommandMetric: vi.fn(),
    };
    let current = true;
    const guildRuntime = runtime(storage, harness.guild);
    guildRuntime.isCurrent = vi.fn(() => current);
    const interaction: Record<string, any> = {
      guild: harness.guild,
      guildId: GUILD_ID,
      user: { id: AUTHOR_ID },
      options: {
        getSubcommand: vi.fn(() => "withdraw"),
        getInteger: vi.fn(() => 4),
      },
      deferred: false,
      replied: false,
      reply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
    };
    interaction.deferReply = vi.fn(async () => {
      interaction.deferred = true;
      current = false;
    });

    await handleSuggestionCommand(interaction as never, guildRuntime);

    expect(interaction.options.getInteger).not.toHaveBeenCalled();
    expect(storage.getSuggestionByNumber).not.toHaveBeenCalled();
    expect(storage.withdrawSuggestion).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("No suggestion was withdrawn"),
      }),
    );
  });
});

describe("suggestion configuration authority boundaries", () => {
  function configureInteraction(harness: ReturnType<typeof guildHarness>) {
    const interaction: Record<string, any> = {
      guild: harness.guild,
      guildId: GUILD_ID,
      user: { id: REVIEWER_ID },
      options: {
        getSubcommand: vi.fn(() => "configure"),
        getChannel: vi.fn((name: string) =>
          name === "channel" ? harness.publicChannel : null,
        ),
        getRole: vi.fn(() => harness.reviewerRole),
        getBoolean: vi.fn(() => null),
        getInteger: vi.fn(() => null),
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
    return interaction;
  }

  function configureGrant() {
    return {
      guildId: GUILD_ID,
      principalType: "role",
      principalId: CONFIGURE_ROLE_ID,
      roleId: CONFIGURE_ROLE_ID,
      capability: "suggestions.configure",
      active: true,
      grantedBy: "101010101010101010",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as const;
  }

  it("denies configuration without suggestion configuration authority", async () => {
    const harness = guildHarness();
    harness.member.roles.cache.delete(CONFIGURE_ROLE_ID);
    const storage = {
      getSuggestionConfiguration: vi.fn(() => null),
      upsertSuggestionConfiguration: vi.fn(),
      listCapabilitiesForRoles: vi.fn(() => []),
      recordCommandMetric: vi.fn(),
    };
    const interaction = configureInteraction(harness);

    await handleSuggestionCommand(
      interaction as never,
      runtime(storage, harness.guild),
    );

    expect(storage.upsertSuggestionConfiguration).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("suggestions.configure"),
      }),
    );
  });

  it("prevents a delegated configurator from assigning a reviewer role they hold", async () => {
    const harness = guildHarness();
    const storage = {
      getSuggestionConfiguration: vi.fn(() => null),
      upsertSuggestionConfiguration: vi.fn(),
      listCapabilitiesForRoles: vi.fn(() => [configureGrant()]),
      recordCommandMetric: vi.fn(),
    };
    const interaction = configureInteraction(harness);

    await handleSuggestionCommand(
      interaction as never,
      runtime(storage, harness.guild),
    );

    expect(storage.upsertSuggestionConfiguration).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("cannot assign"),
      }),
    );
  });

  it("allows the unchanged reviewer role while editing other settings", async () => {
    const harness = guildHarness();
    const current = configuration();
    const storage = {
      getSuggestionConfiguration: vi.fn(() => current),
      upsertSuggestionConfiguration: vi.fn((input) => input),
      listCapabilitiesForRoles: vi.fn(() => [configureGrant()]),
      recordCommandMetric: vi.fn(),
    };
    const interaction = configureInteraction(harness);
    const guildRuntime = runtime(storage, harness.guild);

    await handleSuggestionCommand(interaction as never, guildRuntime);

    expect(storage.upsertSuggestionConfiguration).toHaveBeenCalledTimes(1);
    expect(guildRuntime.invalidate).toHaveBeenCalledTimes(1);
  });

  it("does not let a configure-only reviewer reactivate imported dormant bindings", async () => {
    const harness = guildHarness();
    const current = configuration({
      enabled: false,
      bindingsVerifiedAt: null,
    });
    const storage = {
      getSuggestionConfiguration: vi.fn(() => current),
      upsertSuggestionConfiguration: vi.fn(),
      listCapabilitiesForRoles: vi.fn(() => [configureGrant()]),
      recordCommandMetric: vi.fn(),
    };
    const interaction = configureInteraction(harness);

    await handleSuggestionCommand(
      interaction as never,
      runtime(storage, harness.guild),
    );

    expect(storage.upsertSuggestionConfiguration).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("cannot assign"),
      }),
    );
  });

  it("keeps the server owner exempt from delegated role-assignment limits", async () => {
    const harness = guildHarness({ owner: true });
    const storage = {
      getSuggestionConfiguration: vi.fn(() => null),
      upsertSuggestionConfiguration: vi.fn((input) => input),
      listCapabilitiesForRoles: vi.fn(() => []),
      recordCommandMetric: vi.fn(),
    };
    const interaction = configureInteraction(harness);

    await handleSuggestionCommand(
      interaction as never,
      runtime(storage, harness.guild),
    );

    expect(storage.upsertSuggestionConfiguration).toHaveBeenCalledTimes(1);
  });

  it("does not save configuration when the runtime changes after awaited verification", async () => {
    const harness = guildHarness({ owner: true });
    const storage = {
      getSuggestionConfiguration: vi.fn(() => null),
      upsertSuggestionConfiguration: vi.fn((input) => input),
      listCapabilitiesForRoles: vi.fn(() => []),
      recordCommandMetric: vi.fn(),
    };
    const interaction = configureInteraction(harness);
    const guildRuntime = runtime(storage, harness.guild);
    vi.mocked(guildRuntime.isCurrent)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);

    await handleSuggestionCommand(interaction as never, guildRuntime);

    expect(storage.upsertSuggestionConfiguration).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining(
          "after suggestion configuration was verified",
        ),
      }),
    );
  });

  it("blocks reviewer listing while bindings await explicit revalidation", async () => {
    const harness = guildHarness({ owner: true });
    const storage = {
      getSuggestionConfiguration: vi.fn(() =>
        configuration({ bindingsVerifiedAt: null }),
      ),
      listSuggestions: vi.fn(() => []),
      listCapabilitiesForRoles: vi.fn(() => []),
      recordCommandMetric: vi.fn(),
    };
    const interaction: Record<string, any> = {
      ...configureInteraction(harness),
      options: {
        getSubcommand: vi.fn(() => "list"),
        getInteger: vi.fn(() => 1),
        getString: vi.fn(() => null),
      },
    };

    await handleSuggestionCommand(
      interaction as never,
      runtime(storage, harness.guild),
    );

    expect(storage.listSuggestions).not.toHaveBeenCalled();
  });

  it("does not review a suggestion changed during reviewer authorization", async () => {
    const harness = guildHarness();
    const initialConfiguration = configuration();
    const initialSuggestion = suggestion();
    let currentSuggestion = initialSuggestion;
    let releaseAuthorization!: () => void;
    let authorizationStarted!: () => void;
    const authorizationGate = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    const authorizationStart = new Promise<void>((resolve) => {
      authorizationStarted = resolve;
    });
    harness.guild.members.fetch.mockImplementationOnce(async () => {
      authorizationStarted();
      await authorizationGate;
      return harness.member;
    });
    const storage = {
      getSuggestionConfiguration: vi.fn(() => initialConfiguration),
      getSuggestionByNumber: vi.fn(() => initialSuggestion),
      getSuggestionById: vi.fn(() => currentSuggestion),
      reviewSuggestion: vi.fn(),
      listCapabilitiesForRoles: vi.fn(() => []),
      recordCommandMetric: vi.fn(),
    };
    const interaction = configureInteraction(harness);
    interaction.options = {
      getSubcommand: vi.fn(() => "review"),
      getInteger: vi.fn(() => 4),
      getString: vi.fn((name: string) =>
        name === "state" ? "accepted" : "A clear review reason.",
      ),
    };
    const command = handleSuggestionCommand(
      interaction as never,
      runtime(storage, harness.guild),
    );
    await authorizationStart;
    currentSuggestion = suggestion({
      state: "under-review",
      reviewerId: REVIEWER_ID,
      reviewReason: "Another reviewer acted first.",
      reviewedAt: "2026-01-01T00:00:04.000Z",
      updatedAt: "2026-01-01T00:00:04.000Z",
    });
    releaseAuthorization();
    await command;

    expect(storage.reviewSuggestion).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("changed while reviewer access"),
      }),
    );
  });
});
