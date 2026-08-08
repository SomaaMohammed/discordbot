import { ChannelType, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { GuildRuntime } from "../src/runtime.js";
import type {
  ApplicationForm,
  ApplicationFormField,
  ApplicationRecord,
  ApplicationResponse,
} from "../src/types.js";
import { handleApplicationCommand } from "../src/discord/application-commands-handler.js";
import {
  buildApplicationReviewPayload,
  type ApplicationDisplayRecord,
} from "../src/discord/application-components.js";
import {
  publishReservedApplication,
  refreshApplicationReviewMessage,
} from "../src/discord/application-delivery.js";
import {
  handleApplicationButton,
  handleApplicationModal,
} from "../src/discord/application-interactions.js";

const GUILD_ID = "111111111111111111";
const BOT_ID = "222222222222222222";
const REVIEWER_ID = "333333333333333333";
const APPLICANT_ID = "444444444444444444";
const REVIEWER_ROLE_ID = "555555555555555555";
const CONFIGURE_ROLE_ID = "565656565656565656";
const ALTERNATE_REVIEWER_ROLE_ID = "575757575757575757";
const CHANNEL_ID = "666666666666666666";
const MESSAGE_ID = "777777777777777777";
const APPLICATION_ID = "application1";
const FORM_ID = "form0001";

function form(overrides: Partial<ApplicationForm> = {}): ApplicationForm {
  return {
    guildId: GUILD_ID,
    formId: FORM_ID,
    slug: "moderator",
    displayName: "Moderator",
    description: "Private moderator application",
    reviewerRoleId: REVIEWER_ROLE_ID,
    reviewChannelId: CHANNEL_ID,
    enabled: true,
    sortOrder: 0,
    definitionVersion: 2,
    bindingsVerifiedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

function application(
  overrides: Partial<ApplicationRecord> = {},
): ApplicationRecord {
  return {
    guildId: GUILD_ID,
    applicationId: APPLICATION_ID,
    applicationNumber: 7,
    formId: FORM_ID,
    applicantId: APPLICANT_ID,
    state: "submitted",
    deliveryState: "posted",
    reviewChannelId: CHANNEL_ID,
    reviewMessageId: MESSAGE_ID,
    claimedBy: null,
    claimedAt: null,
    decisionBy: null,
    decisionReason: null,
    decidedAt: null,
    withdrawnAt: null,
    failureReason: null,
    createdAt: "2026-01-01T00:00:02.000Z",
    updatedAt: "2026-01-01T00:00:03.000Z",
    ...overrides,
  };
}

function response(index = 0, value = "Private answer"): ApplicationResponse {
  return {
    guildId: GUILD_ID,
    applicationId: APPLICATION_ID,
    responseId: `response${index}`,
    fieldId: `field000${index}`,
    fieldLabel: `Question ${index + 1}`,
    fieldType: "paragraph",
    responseText: value,
    sortOrder: index,
    createdAt: "2026-01-01T00:00:02.000Z",
  };
}

function applicationField(
  fieldId: string,
  sortOrder: number,
): ApplicationFormField {
  return {
    guildId: GUILD_ID,
    formId: FORM_ID,
    fieldId,
    label: `Question ${sortOrder + 1}`,
    description: null,
    placeholder: null,
    fieldType: "short",
    required: true,
    minLength: 1,
    maxLength: 100,
    sortOrder,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function guildHarness(options: { owner?: boolean } = {}) {
  const guild: Record<string, any> = {
    id: GUILD_ID,
    ownerId: options.owner ? REVIEWER_ID : "888888888888888888",
  };
  const reviewerRole = {
    id: REVIEWER_ROLE_ID,
    name: "Application Reviewers",
    guild,
    managed: false,
  };
  const configureRole = {
    id: CONFIGURE_ROLE_ID,
    name: "Application Configurators",
    guild,
    managed: false,
  };
  const alternateReviewerRole = {
    id: ALTERNATE_REVIEWER_ROLE_ID,
    name: "Alternate Reviewers",
    guild,
    managed: false,
  };
  const everyoneRole = {
    id: GUILD_ID,
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
        [ALTERNATE_REVIEWER_ROLE_ID, alternateReviewerRole],
      ]),
    },
  };
  const botMember = {
    id: BOT_ID,
    guild,
    user: { id: BOT_ID, bot: true },
  };
  const reviewMessage = {
    id: MESSAGE_ID,
    author: { id: BOT_ID },
    edit: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
  const reviewChannel = {
    id: CHANNEL_ID,
    guild,
    type: ChannelType.GuildText,
    messages: {
      fetch: vi.fn(async (id: string) =>
        id === MESSAGE_ID ? reviewMessage : null,
      ),
    },
    send: vi.fn(async () => reviewMessage),
    permissionsFor: vi.fn((subject: unknown) => ({
      has: vi.fn((permission: bigint) =>
        subject === everyoneRole
          ? permission !== PermissionFlagsBits.ViewChannel && false
          : true,
      ),
    })),
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
    everyone: everyoneRole,
    fetch: vi.fn(async (id?: string) => {
      if (!id) {
        return new Map([
          [REVIEWER_ROLE_ID, reviewerRole],
          [CONFIGURE_ROLE_ID, configureRole],
          [ALTERNATE_REVIEWER_ROLE_ID, alternateReviewerRole],
        ]);
      }
      if (id === REVIEWER_ROLE_ID) return reviewerRole;
      if (id === CONFIGURE_ROLE_ID) return configureRole;
      if (id === ALTERNATE_REVIEWER_ROLE_ID) return alternateReviewerRole;
      return null;
    }),
  };
  guild.channels = {
    fetch: vi.fn(async (id: string) =>
      id === CHANNEL_ID ? reviewChannel : null,
    ),
  };
  return {
    guild,
    member,
    reviewerRole,
    configureRole,
    alternateReviewerRole,
    reviewChannel,
    reviewMessage,
  };
}

function runtime(storage: Record<string, any>, guild: Record<string, any>) {
  return {
    guildId: GUILD_ID,
    storage,
    guild,
    isCurrent: vi.fn(() => true),
    invalidate: vi.fn(),
  } as unknown as GuildRuntime;
}

function buttonInteraction(guild: Record<string, any>) {
  const interaction: Record<string, any> = {
    customId: `superior:application:claim:${APPLICATION_ID}`,
    guild,
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    user: { id: REVIEWER_ID },
    client: guild.client,
    message: { id: MESSAGE_ID, author: { id: BOT_ID } },
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

function modalInteraction(
  guild: Record<string, any>,
  customId: string,
  userId = REVIEWER_ID,
) {
  const interaction: Record<string, any> = {
    customId,
    guild,
    guildId: guild.id,
    channelId: CHANNEL_ID,
    user: { id: userId },
    client: guild.client,
    fields: { getTextInputValue: vi.fn(() => "A clear decision reason") },
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

describe("application delivery", () => {
  it("posts answers only to the configured review channel and binds with CAS", async () => {
    const harness = guildHarness();
    const reserved = application({
      deliveryState: "reserved",
      reviewChannelId: null,
      reviewMessageId: null,
    });
    const posted = application();
    const storage = {
      listApplicationResponses: vi.fn(() => [response()]),
      bindApplicationDelivery: vi.fn(() => ({
        status: "posted",
        application: posted,
      })),
      failApplicationDelivery: vi.fn(),
      markApplicationDeliveryMissing: vi.fn(),
    };

    const result = await publishReservedApplication(
      harness.guild as never,
      harness.reviewChannel as never,
      form(),
      reserved,
      storage as never,
    );

    expect(result.application).toEqual(posted);
    expect(harness.reviewChannel.send).toHaveBeenCalledTimes(1);
    expect(storage.bindApplicationDelivery).toHaveBeenCalledWith(
      APPLICATION_ID,
      {
        reviewChannelId: CHANNEL_ID,
        reviewMessageId: MESSAGE_ID,
        expectedUpdatedAt: reserved.updatedAt,
      },
    );
    expect(storage.failApplicationDelivery).not.toHaveBeenCalled();
  });

  it("records a bounded failure and preserves the original delivery error", async () => {
    const harness = guildHarness();
    const failure = new Error("");
    harness.reviewChannel.send.mockRejectedValueOnce(failure);
    const storage = {
      listApplicationResponses: vi.fn(() => [response()]),
      bindApplicationDelivery: vi.fn(),
      failApplicationDelivery: vi.fn(() => {
        throw new Error("secondary persistence failure");
      }),
      markApplicationDeliveryMissing: vi.fn(),
    };

    await expect(
      publishReservedApplication(
        harness.guild as never,
        harness.reviewChannel as never,
        form(),
        application({
          deliveryState: "reserved",
          reviewChannelId: null,
          reviewMessageId: null,
        }),
        storage,
      ),
    ).rejects.toBe(failure);
    expect(storage.failApplicationDelivery).toHaveBeenCalledWith(
      APPLICATION_ID,
      "Application delivery failed.",
    );
  });

  it("deletes a sent review message and performs no stale storage write after runtime invalidation", async () => {
    const harness = guildHarness();
    let current = true;
    harness.reviewChannel.send.mockImplementationOnce(async () => {
      current = false;
      return harness.reviewMessage;
    });
    const storage = {
      listApplicationResponses: vi.fn(() => [response()]),
      bindApplicationDelivery: vi.fn(),
      failApplicationDelivery: vi.fn(),
      markApplicationDeliveryMissing: vi.fn(),
    };

    await expect(
      publishReservedApplication(
        harness.guild as never,
        harness.reviewChannel as never,
        form(),
        application({
          deliveryState: "reserved",
          reviewChannelId: null,
          reviewMessageId: null,
        }),
        storage,
        () => current,
      ),
    ).rejects.toThrow(/server changed/i);
    expect(harness.reviewMessage.delete).toHaveBeenCalledTimes(1);
    expect(storage.bindApplicationDelivery).not.toHaveBeenCalled();
    expect(storage.failApplicationDelivery).not.toHaveBeenCalled();
  });

  it("does not mark transient lookups missing, but persists an unknown message", async () => {
    const transient = guildHarness();
    transient.guild.channels.fetch.mockRejectedValueOnce(
      new Error("temporary Discord outage"),
    );
    const transientStorage = {
      listApplicationResponses: vi.fn(() => []),
      bindApplicationDelivery: vi.fn(),
      failApplicationDelivery: vi.fn(),
      markApplicationDeliveryMissing: vi.fn(),
    };
    await expect(
      refreshApplicationReviewMessage(
        transient.guild as never,
        form(),
        application(),
        transientStorage,
      ),
    ).resolves.toBe("unavailable");
    expect(
      transientStorage.markApplicationDeliveryMissing,
    ).not.toHaveBeenCalled();

    const missing = guildHarness();
    missing.reviewChannel.messages.fetch.mockRejectedValueOnce(
      Object.assign(new Error("Unknown Message"), { code: 10_008 }),
    );
    const missingStorage = {
      ...transientStorage,
      markApplicationDeliveryMissing: vi.fn(() => ({
        status: "missing",
        application: application({ deliveryState: "missing" }),
      })),
    };
    await expect(
      refreshApplicationReviewMessage(
        missing.guild as never,
        form(),
        application(),
        missingStorage as never,
      ),
    ).resolves.toBe("missing");
    expect(missingStorage.markApplicationDeliveryMissing).toHaveBeenCalledWith(
      APPLICATION_ID,
      application().updatedAt,
    );
  });

  it("does not mark delivery missing after refresh runtime invalidation", async () => {
    const harness = guildHarness();
    let current = true;
    harness.guild.channels.fetch.mockImplementationOnce(async () => {
      current = false;
      return null;
    });
    const storage = {
      getApplicationById: vi.fn(() => application()),
      listApplicationResponses: vi.fn(() => []),
      bindApplicationDelivery: vi.fn(),
      failApplicationDelivery: vi.fn(),
      markApplicationDeliveryMissing: vi.fn(),
    };

    await expect(
      refreshApplicationReviewMessage(
        harness.guild as never,
        form(),
        application(),
        storage,
        () => current,
      ),
    ).resolves.toBe("unavailable");
    expect(storage.markApplicationDeliveryMissing).not.toHaveBeenCalled();
  });

  it("keeps the worst-case review embed below Discord's total size", () => {
    const record: ApplicationDisplayRecord = {
      applicationId: APPLICATION_ID,
      applicationNumber: 7,
      applicantId: APPLICANT_ID,
      state: "accepted",
      claimedBy: REVIEWER_ID,
      decisionBy: REVIEWER_ID,
      decisionReason: "D".repeat(1_000),
      createdAt: "2026-01-01T00:00:02.000Z",
    };
    const payload = buildApplicationReviewPayload(
      record,
      { displayName: "F".repeat(100), description: "X".repeat(1_000) },
      Array.from({ length: 5 }, (_, index) => ({
        fieldId: `field000${index}`,
        key: `field-${index + 1}`,
        label: `Question ${index + 1}`,
        value: "A".repeat(4_000),
        sortOrder: index,
      })),
    );
    const embed = payload.embeds?.[0];
    const json =
      embed && "toJSON" in embed && typeof embed.toJSON === "function"
        ? embed.toJSON()
        : embed;
    const embedCharacters = JSON.stringify(json).length;
    expect(embedCharacters).toBeLessThan(6_000);
  });

  it("reconciles an out-of-order review edit to the latest final state", async () => {
    const harness = guildHarness();
    const reviewing = application({
      state: "under-review",
      claimedBy: REVIEWER_ID,
    });
    const accepted = application({
      state: "accepted",
      claimedBy: REVIEWER_ID,
      decisionBy: REVIEWER_ID,
      decisionReason: "Approved",
      updatedAt: "2026-01-01T00:00:05.000Z",
    });
    let current = reviewing;
    let releaseFirstEdit!: () => void;
    harness.reviewMessage.edit
      .mockImplementationOnce(
        () =>
          new Promise<undefined>((resolve) => {
            releaseFirstEdit = () => resolve(undefined);
          }),
      )
      .mockResolvedValue(undefined);
    const storage = {
      getApplicationById: vi.fn(() => current),
      listApplicationResponses: vi.fn(() => [response()]),
      bindApplicationDelivery: vi.fn(),
      failApplicationDelivery: vi.fn(),
      markApplicationDeliveryMissing: vi.fn(),
    };

    const earlier = refreshApplicationReviewMessage(
      harness.guild as never,
      form(),
      reviewing,
      storage,
    );
    await vi.waitFor(() =>
      expect(harness.reviewMessage.edit).toHaveBeenCalledTimes(1),
    );
    current = accepted;
    await refreshApplicationReviewMessage(
      harness.guild as never,
      form(),
      accepted,
      storage,
    );
    releaseFirstEdit();
    await earlier;

    const finalPayload = (harness.reviewMessage.edit as any).mock.calls.at(
      -1,
    )?.[0] as {
      embeds?: Array<{
        toJSON(): { fields?: Array<{ name: string; value: string }> };
      }>;
      components?: Array<{
        toJSON(): { components?: Array<{ disabled?: boolean }> };
      }>;
    };
    const status = finalPayload.embeds?.[0]
      ?.toJSON()
      .fields?.find(({ name }) => name === "Status");
    expect(status?.value).toContain("Accepted");
    expect(
      finalPayload.components?.[0]
        ?.toJSON()
        .components?.slice(0, 3)
        .every(({ disabled }) => disabled),
    ).toBe(true);
  });
});

describe("application interactions", () => {
  it("submits a current form privately and persists its review delivery", async () => {
    const harness = guildHarness();
    const reserved = application({
      applicantId: REVIEWER_ID,
      deliveryState: "reserved",
      reviewChannelId: null,
      reviewMessageId: null,
    });
    const posted = application({ applicantId: REVIEWER_ID });
    const storage = {
      getApplicationForm: vi.fn(() => form()),
      listApplicationFormFields: vi.fn(() => [
        applicationField("field0000", 0),
      ]),
      reserveApplication: vi.fn(() => ({
        status: "created",
        application: reserved,
      })),
      listApplicationResponses: vi.fn(() => [response()]),
      bindApplicationDelivery: vi.fn(() => ({
        status: "posted",
        application: posted,
      })),
      failApplicationDelivery: vi.fn(),
      markApplicationDeliveryMissing: vi.fn(),
      listCapabilitiesForRoles: vi.fn(() => []),
      recordCommandMetric: vi.fn(),
    };
    const interaction = modalInteraction(
      harness.guild,
      `superior:application:submit-modal:command:${FORM_ID}:2`,
    );
    interaction.fields.getTextInputValue.mockReturnValue(
      "A complete private response",
    );

    await handleApplicationModal(
      interaction as never,
      runtime(storage, harness.guild),
    );

    expect(storage.reserveApplication).toHaveBeenCalledWith(
      expect.objectContaining({
        formId: FORM_ID,
        applicantId: REVIEWER_ID,
        responses: [
          expect.objectContaining({
            fieldId: "field0000",
            responseText: "A complete private response",
          }),
        ],
      }),
    );
    expect(harness.reviewChannel.send).toHaveBeenCalledTimes(1);
    expect(storage.bindApplicationDelivery).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("submitted privately"),
      }),
    );
  });

  it("rejects a control changed during reviewer authorization", async () => {
    const harness = guildHarness({ owner: true });
    const before = application();
    const after = application({
      state: "under-review",
      claimedBy: REVIEWER_ID,
      claimedAt: "2026-01-01T00:00:04.000Z",
      updatedAt: "2026-01-01T00:00:04.000Z",
    });
    const storage = {
      getApplicationById: vi
        .fn()
        .mockReturnValueOnce(before)
        .mockReturnValueOnce(after),
      getApplicationForm: vi.fn(() => form()),
      claimApplication: vi.fn(),
      listApplicationResponses: vi.fn(() => []),
      listCapabilitiesForRoles: vi.fn(() => []),
      recordCommandMetric: vi.fn(),
    };
    const interaction = buttonInteraction(harness.guild);

    await handleApplicationButton(
      interaction as never,
      runtime(storage, harness.guild),
    );

    expect(storage.claimApplication).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("changed") }),
    );
  });

  it("does not disclose private answers when the reviewer role is removed during defer", async () => {
    const harness = guildHarness();
    const storage = {
      getApplicationById: vi.fn(() => application()),
      getApplicationForm: vi.fn(() => form()),
      claimApplication: vi.fn(),
      listApplicationResponses: vi.fn(() => [response()]),
      listCapabilitiesForRoles: vi.fn(() => []),
      recordCommandMetric: vi.fn(),
    };
    const interaction = buttonInteraction(harness.guild);
    interaction.customId = `superior:application:info:${APPLICATION_ID}`;
    interaction.deferReply.mockImplementationOnce(async () => {
      interaction.deferred = true;
      harness.guild.members.fetch.mockResolvedValue({
        ...harness.member,
        roles: { cache: new Map() },
      });
    });

    await handleApplicationButton(
      interaction as never,
      runtime(storage, harness.guild),
    );

    expect(storage.listApplicationResponses).not.toHaveBeenCalled();
    expect(storage.claimApplication).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Only authorized"),
      }),
    );
  });

  it("does not claim when the runtime generation changes during defer", async () => {
    const harness = guildHarness();
    const storage = {
      getApplicationById: vi.fn(() => application()),
      getApplicationForm: vi.fn(() => form()),
      claimApplication: vi.fn(),
      listApplicationResponses: vi.fn(() => [response()]),
      listCapabilitiesForRoles: vi.fn(() => []),
      recordCommandMetric: vi.fn(),
    };
    const interaction = buttonInteraction(harness.guild);
    let generationCurrent = true;
    const guildRuntime = runtime(storage, harness.guild);
    vi.mocked(guildRuntime.isCurrent).mockImplementation(
      () => generationCurrent,
    );
    interaction.deferReply.mockImplementationOnce(async () => {
      interaction.deferred = true;
      generationCurrent = false;
    });

    await handleApplicationButton(interaction as never, guildRuntime);

    expect(storage.claimApplication).not.toHaveBeenCalled();
    expect(storage.listApplicationResponses).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("changed") }),
    );
  });

  it("does not disclose private answers when review configuration changes during defer", async () => {
    const harness = guildHarness();
    let currentForm = form();
    const storage = {
      getApplicationById: vi.fn(() => application()),
      getApplicationForm: vi.fn(() => currentForm),
      claimApplication: vi.fn(),
      listApplicationResponses: vi.fn(() => [response()]),
      listCapabilitiesForRoles: vi.fn(() => []),
      recordCommandMetric: vi.fn(),
    };
    const interaction = buttonInteraction(harness.guild);
    interaction.customId = `superior:application:info:${APPLICATION_ID}`;
    interaction.deferReply.mockImplementationOnce(async () => {
      interaction.deferred = true;
      currentForm = form({
        reviewerRoleId: ALTERNATE_REVIEWER_ROLE_ID,
        updatedAt: "2026-01-01T00:00:04.000Z",
      });
    });

    await handleApplicationButton(
      interaction as never,
      runtime(storage, harness.guild),
    );

    expect(storage.listApplicationResponses).not.toHaveBeenCalled();
    expect(storage.claimApplication).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("changed") }),
    );
  });

  it("does not claim when the application snapshot changes during defer", async () => {
    const harness = guildHarness();
    let currentApplication = application();
    const storage = {
      getApplicationById: vi.fn(() => currentApplication),
      getApplicationForm: vi.fn(() => form()),
      claimApplication: vi.fn(),
      listApplicationResponses: vi.fn(() => [response()]),
      listCapabilitiesForRoles: vi.fn(() => []),
      recordCommandMetric: vi.fn(),
    };
    const interaction = buttonInteraction(harness.guild);
    interaction.deferReply.mockImplementationOnce(async () => {
      interaction.deferred = true;
      currentApplication = application({
        state: "under-review",
        claimedBy: "343434343434343434",
        claimedAt: "2026-01-01T00:00:04.000Z",
        updatedAt: "2026-01-01T00:00:04.000Z",
      });
    });

    await handleApplicationButton(
      interaction as never,
      runtime(storage, harness.guild),
    );

    expect(storage.claimApplication).not.toHaveBeenCalled();
    expect(storage.listApplicationResponses).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("changed") }),
    );
  });

  it("claims a verified disabled form, refreshes review, and DMs once", async () => {
    const harness = guildHarness({ owner: true });
    const send = vi.fn(async () => undefined);
    harness.guild.client.users.fetch.mockResolvedValue({ bot: false, send });
    const before = application();
    const claimed = application({
      state: "under-review",
      claimedBy: REVIEWER_ID,
      claimedAt: "2026-01-01T00:00:04.000Z",
      updatedAt: "2026-01-01T00:00:04.000Z",
    });
    const storage = {
      getApplicationById: vi.fn(() => before),
      getApplicationForm: vi.fn(() => form({ enabled: false })),
      claimApplication: vi.fn(() => ({
        status: "changed",
        application: claimed,
      })),
      listApplicationResponses: vi.fn(() => [response()]),
      markApplicationDeliveryMissing: vi.fn(),
      listCapabilitiesForRoles: vi.fn(() => []),
      recordCommandMetric: vi.fn(),
    };
    const interaction = buttonInteraction(harness.guild);

    await handleApplicationButton(
      interaction as never,
      runtime(storage, harness.guild),
    );

    expect(storage.claimApplication).toHaveBeenCalledWith(
      APPLICATION_ID,
      REVIEWER_ID,
      before.updatedAt,
    );
    expect(harness.reviewMessage.edit).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("under-review"),
      }),
    );
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("claimed") }),
    );
  });

  it("does not DM again when the same reviewer repeats an idempotent claim", async () => {
    const harness = guildHarness({ owner: true });
    const send = vi.fn(async () => undefined);
    harness.guild.client.users.fetch.mockResolvedValue({ bot: false, send });
    const claimed = application({
      state: "under-review",
      claimedBy: REVIEWER_ID,
      claimedAt: "2026-01-01T00:00:04.000Z",
      updatedAt: "2026-01-01T00:00:04.000Z",
    });
    const storage = {
      getApplicationById: vi.fn(() => claimed),
      getApplicationForm: vi.fn(() => form({ enabled: false })),
      claimApplication: vi.fn(() => ({
        status: "unchanged",
        application: claimed,
      })),
      listApplicationResponses: vi.fn(() => [response()]),
      markApplicationDeliveryMissing: vi.fn(),
      listCapabilitiesForRoles: vi.fn(() => []),
      recordCommandMetric: vi.fn(),
    };
    const interaction = buttonInteraction(harness.guild);

    await handleApplicationButton(
      interaction as never,
      runtime(storage, harness.guild),
    );

    expect(storage.claimApplication).toHaveBeenCalledTimes(1);
    expect(harness.reviewMessage.edit).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("already") }),
    );
  });

  it("keeps dormant imported forms out of private review controls", async () => {
    const harness = guildHarness({ owner: true });
    const storage = {
      getApplicationById: vi.fn(() => application()),
      getApplicationForm: vi.fn(() => form({ bindingsVerifiedAt: null })),
      claimApplication: vi.fn(),
      listCapabilitiesForRoles: vi.fn(() => []),
      recordCommandMetric: vi.fn(),
    };
    const interaction = buttonInteraction(harness.guild);

    await handleApplicationButton(
      interaction as never,
      runtime(storage, harness.guild),
    );

    expect(storage.claimApplication).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("stale") }),
    );
  });

  it("rejects cross-server application controls before claiming", async () => {
    const harness = guildHarness({ owner: true });
    const storage = {
      getApplicationById: vi.fn(() => application()),
      getApplicationForm: vi.fn(() => form()),
      claimApplication: vi.fn(),
      listCapabilitiesForRoles: vi.fn(() => []),
      recordCommandMetric: vi.fn(),
    };
    const interaction = buttonInteraction(harness.guild);
    interaction.guild = { ...harness.guild, id: "999999999999999999" };
    interaction.guildId = interaction.guild.id;

    await handleApplicationButton(
      interaction as never,
      runtime(storage, harness.guild),
    );

    expect(storage.claimApplication).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("unavailable"),
      }),
    );
  });

  it("rejects a submit modal opened under an older form definition", async () => {
    const harness = guildHarness();
    const storage = {
      getApplicationForm: vi.fn(() => form({ definitionVersion: 3 })),
      reserveApplication: vi.fn(),
      listCapabilitiesForRoles: vi.fn(() => []),
      recordCommandMetric: vi.fn(),
    };
    const interaction = modalInteraction(
      harness.guild,
      `superior:application:submit-modal:command:${FORM_ID}:2`,
      APPLICANT_ID,
    );

    await handleApplicationModal(
      interaction as never,
      runtime(storage, harness.guild),
    );

    expect(interaction.fields.getTextInputValue).not.toHaveBeenCalled();
    expect(storage.reserveApplication).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("changed") }),
    );
  });

  it("provides all five maximum-length private answers in the Info attachment", async () => {
    const harness = guildHarness({ owner: true });
    const answers = Array.from({ length: 5 }, (_, index) =>
      response(index, `${String(index).repeat(3_980)}TAIL-${index}-@everyone`),
    );
    const storage = {
      getApplicationById: vi.fn(() => application()),
      getApplicationForm: vi.fn(() => form()),
      listApplicationResponses: vi.fn(() => answers),
      listCapabilitiesForRoles: vi.fn(() => []),
      recordCommandMetric: vi.fn(),
    };
    const interaction = buttonInteraction(harness.guild);
    interaction.customId = `superior:application:info:${APPLICATION_ID}`;

    await handleApplicationButton(
      interaction as never,
      runtime(storage, harness.guild),
    );

    const payload = interaction.editReply.mock.calls[0]?.[0] as {
      files?: Array<{ attachment?: unknown }>;
      allowedMentions?: unknown;
    };
    const attachment = payload.files?.[0]?.attachment;
    expect(Buffer.isBuffer(attachment)).toBe(true);
    const text = (attachment as Buffer).toString("utf8");
    for (let index = 0; index < 5; index += 1) {
      expect(text).toContain(`TAIL-${index}-@\u200beveryone`);
    }
    expect(payload.allowedMentions).toEqual({ parse: [] });
  });

  it("allows only one claimant under competing deliveries", async () => {
    const harness = guildHarness();
    const secondReviewerId = "343434343434343434";
    const secondMember = {
      ...harness.member,
      id: secondReviewerId,
      user: { id: secondReviewerId, bot: false },
    };
    harness.guild.members.fetch.mockImplementation(
      async (input: string | { user: string }) => {
        const id = typeof input === "string" ? input : input.user;
        return id === secondReviewerId ? secondMember : harness.member;
      },
    );
    const dm = vi.fn(async () => undefined);
    harness.guild.client.users.fetch.mockResolvedValue({
      bot: false,
      send: dm,
    });
    let current = application();
    const storage = {
      getApplicationById: vi.fn(() => current),
      getApplicationForm: vi.fn(() => form()),
      claimApplication: vi.fn(
        (_: string, reviewerId: string, expected: string) => {
          if (current.state !== "submitted" || current.updatedAt !== expected) {
            return { status: "conflict", application: current };
          }
          current = application({
            state: "under-review",
            claimedBy: reviewerId,
            claimedAt: "2026-01-01T00:00:04.000Z",
            updatedAt: "2026-01-01T00:00:04.000Z",
          });
          return { status: "changed", application: current };
        },
      ),
      listApplicationResponses: vi.fn(() => [response()]),
      markApplicationDeliveryMissing: vi.fn(),
      listCapabilitiesForRoles: vi.fn(() => []),
      recordCommandMetric: vi.fn(),
    };
    const first = buttonInteraction(harness.guild);
    const second = buttonInteraction(harness.guild);
    second.user = { id: secondReviewerId };

    await Promise.all([
      handleApplicationButton(first as never, runtime(storage, harness.guild)),
      handleApplicationButton(second as never, runtime(storage, harness.guild)),
    ]);

    expect(storage.claimApplication.mock.calls.length).toBeGreaterThanOrEqual(
      1,
    );
    expect(storage.claimApplication.mock.calls.length).toBeLessThanOrEqual(2);
    const claimStatuses = storage.claimApplication.mock.results.map(
      ({ value }) => (value as { status: string }).status,
    );
    expect(claimStatuses.filter((status) => status === "changed")).toHaveLength(
      1,
    );
    expect(claimStatuses.filter((status) => status === "conflict").length).toBe(
      claimStatuses.length - 1,
    );
    expect([REVIEWER_ID, secondReviewerId]).toContain(current.claimedBy);
    expect(dm).toHaveBeenCalledTimes(1);
  });

  it.each(["accept", "reject"] as const)(
    "keeps repeated %s decisions idempotent and sends one DM",
    async (decision) => {
      const harness = guildHarness();
      const dm = vi.fn(async () => undefined);
      harness.guild.client.users.fetch.mockResolvedValue({
        bot: false,
        send: dm,
      });
      let current = application({
        state: "under-review",
        claimedBy: REVIEWER_ID,
        claimedAt: "2026-01-01T00:00:04.000Z",
        updatedAt: "2026-01-01T00:00:04.000Z",
      });
      const finalState = decision === "accept" ? "accepted" : "rejected";
      const storage = {
        getApplicationById: vi.fn(() => current),
        getApplicationForm: vi.fn(() => form()),
        decideApplication: vi.fn(() => {
          if (current.state === finalState) {
            return { status: "unchanged", application: current };
          }
          current = application({
            state: finalState,
            claimedBy: REVIEWER_ID,
            claimedAt: "2026-01-01T00:00:04.000Z",
            decisionBy: REVIEWER_ID,
            decisionReason: "A clear decision reason",
            decidedAt: "2026-01-01T00:00:05.000Z",
            updatedAt: "2026-01-01T00:00:05.000Z",
          });
          return { status: "changed", application: current };
        }),
        listApplicationResponses: vi.fn(() => [response()]),
        markApplicationDeliveryMissing: vi.fn(),
        listCapabilitiesForRoles: vi.fn(() => []),
        recordCommandMetric: vi.fn(),
      };
      const customId = `superior:application:decision-modal:${decision}:${APPLICATION_ID}`;

      await handleApplicationModal(
        modalInteraction(harness.guild, customId) as never,
        runtime(storage, harness.guild),
      );
      await handleApplicationModal(
        modalInteraction(harness.guild, customId) as never,
        runtime(storage, harness.guild),
      );

      expect(current.state).toBe(finalState);
      expect(storage.decideApplication).toHaveBeenCalledTimes(2);
      expect(dm).toHaveBeenCalledTimes(1);
    },
  );

  it("lets the configured reviewer recover a verified form after disable", async () => {
    const harness = guildHarness();
    const storedApplication = application();
    const storage = {
      getApplicationByNumber: vi.fn(() => storedApplication),
      getApplicationById: vi.fn(() => storedApplication),
      getApplicationForm: vi.fn(() => form({ enabled: false })),
      listApplicationResponses: vi.fn(() => []),
      listCapabilitiesForRoles: vi.fn(() => []),
      markApplicationDeliveryMissing: vi.fn(),
      recordCommandMetric: vi.fn(),
    };
    const interaction: Record<string, any> = {
      guild: harness.guild,
      guildId: GUILD_ID,
      user: { id: REVIEWER_ID },
      options: {
        getSubcommandGroup: vi.fn(() => null),
        getSubcommand: vi.fn(() => "recover"),
        getInteger: vi.fn(() => 7),
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

    await handleApplicationCommand(
      interaction as never,
      runtime(storage, harness.guild),
    );

    expect(harness.reviewMessage.edit).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("healthy") }),
    );
  });
});

describe("application member withdrawal generation", () => {
  it("does not read or mutate a withdrawal after invalidation during defer", async () => {
    const harness = guildHarness();
    const storage = {
      getApplicationByNumber: vi.fn(),
      withdrawApplication: vi.fn(),
      recordCommandMetric: vi.fn(),
    };
    let current = true;
    const guildRuntime = runtime(storage, harness.guild);
    guildRuntime.isCurrent = vi.fn(() => current);
    const interaction: Record<string, any> = {
      guild: harness.guild,
      guildId: GUILD_ID,
      user: { id: APPLICANT_ID },
      options: {
        getSubcommandGroup: vi.fn(() => null),
        getSubcommand: vi.fn(() => "withdraw"),
        getInteger: vi.fn(() => 7),
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

    await handleApplicationCommand(interaction as never, guildRuntime);

    expect(interaction.options.getInteger).not.toHaveBeenCalled();
    expect(storage.getApplicationByNumber).not.toHaveBeenCalled();
    expect(storage.withdrawApplication).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("No application was withdrawn"),
      }),
    );
  });
});

describe("application configuration authority boundaries", () => {
  function configureGrant() {
    return {
      guildId: GUILD_ID,
      principalType: "role",
      principalId: CONFIGURE_ROLE_ID,
      roleId: CONFIGURE_ROLE_ID,
      capability: "applications.configure",
      active: true,
      grantedBy: "888888888888888888",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as const;
  }

  function formCommandInteraction(
    harness: ReturnType<typeof guildHarness>,
    subcommand: "create" | "edit" | "enable" | "disable",
    role = harness.reviewerRole,
  ) {
    const interaction: Record<string, any> = {
      guild: harness.guild,
      guildId: GUILD_ID,
      user: { id: REVIEWER_ID },
      options: {
        getSubcommandGroup: vi.fn(() => "form"),
        getSubcommand: vi.fn(() => subcommand),
        getString: vi.fn((name: string, required: boolean) => {
          if (name === "form") return "moderator";
          if (name === "name")
            return subcommand === "create" || required
              ? "Moderator"
              : "Updated moderator";
          if (name === "description") {
            return subcommand === "create" || required
              ? "Private moderator application"
              : null;
          }
          return null;
        }),
        getRole: vi.fn(() => (subcommand === "enable" ? null : role)),
        getChannel: vi.fn((name: string, required: boolean) =>
          name === "review_channel" && (subcommand === "create" || required)
            ? harness.reviewChannel
            : null,
        ),
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

  it("prevents a delegated configurator from creating a reviewer role they hold", async () => {
    const harness = guildHarness();
    const storage = {
      createApplicationForm: vi.fn(),
      listCapabilitiesForRoles: vi.fn(() => [configureGrant()]),
      recordCommandMetric: vi.fn(),
    };
    const interaction = formCommandInteraction(harness, "create");

    await handleApplicationCommand(
      interaction as never,
      runtime(storage, harness.guild),
    );

    expect(storage.createApplicationForm).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("cannot assign"),
      }),
    );
  });

  it("prevents a configure-only delegate from routing private answers to a channel they can read", async () => {
    const harness = guildHarness();
    harness.member.roles.cache.delete(REVIEWER_ROLE_ID);
    harness.member.roles.cache.delete(ALTERNATE_REVIEWER_ROLE_ID);
    const storage = {
      createApplicationForm: vi.fn(),
      listCapabilitiesForRoles: vi.fn(() => [configureGrant()]),
      recordCommandMetric: vi.fn(),
    };
    const interaction = formCommandInteraction(harness, "create");

    await handleApplicationCommand(
      interaction as never,
      runtime(storage, harness.guild),
    );

    expect(storage.createApplicationForm).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringMatching(
          /configuration-only.*private application answers/i,
        ),
      }),
    );
  });

  it("prevents a delegated configurator from changing to another role they hold", async () => {
    const harness = guildHarness();
    const current = form();
    const storage = {
      getApplicationFormBySlug: vi.fn(() => current),
      getApplicationForm: vi.fn(() => current),
      updateApplicationForm: vi.fn(),
      listCapabilitiesForRoles: vi.fn(() => [configureGrant()]),
      recordCommandMetric: vi.fn(),
    };
    const interaction = formCommandInteraction(
      harness,
      "edit",
      harness.alternateReviewerRole,
    );

    await handleApplicationCommand(
      interaction as never,
      runtime(storage, harness.guild),
    );

    expect(storage.updateApplicationForm).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("cannot assign"),
      }),
    );
  });

  it("allows an unchanged reviewer role while editing unrelated metadata", async () => {
    const harness = guildHarness();
    const current = form();
    const updated = form({
      displayName: "Updated moderator",
      enabled: false,
      updatedAt: "2026-01-01T00:00:04.000Z",
    });
    const storage = {
      getApplicationFormBySlug: vi.fn(() => current),
      getApplicationForm: vi.fn(() => current),
      updateApplicationForm: vi.fn(() => updated),
      listCapabilitiesForRoles: vi.fn(() => [configureGrant()]),
      recordCommandMetric: vi.fn(),
    };
    const interaction = formCommandInteraction(harness, "edit");
    const guildRuntime = runtime(storage, harness.guild);

    await handleApplicationCommand(interaction as never, guildRuntime);

    expect(storage.updateApplicationForm).toHaveBeenCalledTimes(1);
    expect(guildRuntime.invalidate).toHaveBeenCalledTimes(1);
  });

  it("refuses a configuration mutation after its runtime generation changes", async () => {
    const harness = guildHarness();
    const current = form({ enabled: true });
    const storage = {
      getApplicationFormBySlug: vi.fn(() => current),
      setApplicationFormEnabled: vi.fn(),
      listCapabilitiesForRoles: vi.fn(() => [configureGrant()]),
      recordCommandMetric: vi.fn(),
    };
    const interaction = formCommandInteraction(harness, "disable");
    const guildRuntime = runtime(storage, harness.guild);
    vi.mocked(guildRuntime.isCurrent)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);

    await handleApplicationCommand(interaction as never, guildRuntime);

    expect(storage.setApplicationFormEnabled).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("server changed"),
      }),
    );
  });

  it("does not let a configure-only reviewer reactivate an imported dormant form", async () => {
    const harness = guildHarness();
    const current = form({ enabled: false, bindingsVerifiedAt: null });
    const storage = {
      getApplicationFormBySlug: vi.fn(() => current),
      getApplicationForm: vi.fn(() => current),
      updateApplicationForm: vi.fn(),
      listApplicationFormFields: vi.fn(() => [
        applicationField("field0000", 0),
      ]),
      listCapabilityGrantsForCapability: vi.fn(() => []),
      listCapabilitiesForRoles: vi.fn(() => [configureGrant()]),
      recordCommandMetric: vi.fn(),
    };
    const interaction = formCommandInteraction(harness, "enable");

    await handleApplicationCommand(
      interaction as never,
      runtime(storage, harness.guild),
    );

    expect(storage.updateApplicationForm).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("cannot assign"),
      }),
    );
  });

  it("refuses to rotate private review routing after application history exists", async () => {
    const harness = guildHarness({ owner: true });
    const current = form();
    const storage = {
      getApplicationFormBySlug: vi.fn(() => current),
      getApplicationForm: vi.fn(() => current),
      updateApplicationForm: vi.fn(),
      hasApplicationsForForm: vi.fn(() => true),
      listCapabilitiesForRoles: vi.fn(() => []),
      recordCommandMetric: vi.fn(),
    };
    const interaction = formCommandInteraction(
      harness,
      "edit",
      harness.alternateReviewerRole,
    );

    await handleApplicationCommand(
      interaction as never,
      runtime(storage, harness.guild),
    );

    expect(storage.updateApplicationForm).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("application history"),
      }),
    );
  });

  it("refuses to enable a form when an active delegated reviewer lacks channel access", async () => {
    const harness = guildHarness();
    const current = form({ enabled: false });
    harness.reviewChannel.permissionsFor.mockImplementation(
      (subject: unknown) => ({
        has: vi.fn(
          () =>
            (subject as { id?: string } | null)?.id !== GUILD_ID &&
            subject !== harness.alternateReviewerRole,
        ),
      }),
    );
    const storage = {
      getApplicationFormBySlug: vi.fn(() => current),
      getApplicationForm: vi.fn(() => current),
      updateApplicationForm: vi.fn(),
      listApplicationFormFields: vi.fn(() => [
        {
          guildId: GUILD_ID,
          formId: FORM_ID,
          fieldId: "field0001",
          label: "Why do you want to join?",
          description: null,
          placeholder: null,
          fieldType: "paragraph",
          required: true,
          minLength: 1,
          maxLength: 500,
          sortOrder: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
      listCapabilityGrantsForCapability: vi.fn(() => [
        {
          guildId: GUILD_ID,
          principalType: "role",
          principalId: ALTERNATE_REVIEWER_ROLE_ID,
          roleId: ALTERNATE_REVIEWER_ROLE_ID,
          capability: "applications.review",
          active: true,
          grantedBy: "888888888888888888",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
      listCapabilitiesForRoles: vi.fn(() => [configureGrant()]),
      recordCommandMetric: vi.fn(),
    };
    const interaction = formCommandInteraction(harness, "enable");

    await handleApplicationCommand(
      interaction as never,
      runtime(storage, harness.guild),
    );

    expect(storage.updateApplicationForm).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("lacks private review-channel access"),
      }),
    );
  });

  it("enables a form after active delegated reviewer access is verified", async () => {
    const harness = guildHarness();
    const current = form({ enabled: false });
    const storage = {
      getApplicationFormBySlug: vi.fn(() => current),
      getApplicationForm: vi.fn(() => current),
      updateApplicationForm: vi.fn(() => form()),
      listApplicationFormFields: vi.fn(() => [
        {
          guildId: GUILD_ID,
          formId: FORM_ID,
          fieldId: "field0001",
          label: "Why do you want to join?",
          description: null,
          placeholder: null,
          fieldType: "paragraph",
          required: true,
          minLength: 1,
          maxLength: 500,
          sortOrder: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
      listCapabilityGrantsForCapability: vi.fn(() => [
        {
          guildId: GUILD_ID,
          principalType: "role",
          principalId: ALTERNATE_REVIEWER_ROLE_ID,
          roleId: ALTERNATE_REVIEWER_ROLE_ID,
          capability: "applications.review",
          active: true,
          grantedBy: "888888888888888888",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
      listCapabilitiesForRoles: vi.fn(() => [configureGrant()]),
      recordCommandMetric: vi.fn(),
    };
    const interaction = formCommandInteraction(harness, "enable");

    await handleApplicationCommand(
      interaction as never,
      runtime(storage, harness.guild),
    );

    expect(storage.updateApplicationForm).toHaveBeenCalledWith(
      FORM_ID,
      expect.objectContaining({ enabled: true }),
    );
  });

  it("adds an application question at an occupied position through a free slot then reorders", async () => {
    const harness = guildHarness();
    const fields = [
      applicationField("question01", 0),
      applicationField("question02", 1),
    ];
    const created = applicationField("new-question", 2);
    const storage = {
      getApplicationFormBySlug: vi.fn(() => form({ enabled: false })),
      getApplicationFormField: vi.fn(() => null),
      listApplicationFormFields: vi.fn(() => fields),
      setApplicationFormEnabled: vi.fn(),
      upsertApplicationFormField: vi.fn(() => created),
      reorderApplicationFormFields: vi.fn(() => [created, ...fields]),
      removeApplicationFormField: vi.fn(),
      listCapabilitiesForRoles: vi.fn(() => [configureGrant()]),
      recordCommandMetric: vi.fn(),
    };
    const interaction: Record<string, any> = {
      guild: harness.guild,
      guildId: GUILD_ID,
      user: { id: REVIEWER_ID },
      options: {
        getSubcommandGroup: vi.fn(() => "field"),
        getSubcommand: vi.fn(() => "add"),
        getString: vi.fn((name: string) => {
          if (name === "form") return "moderator";
          if (name === "field") return "new-question";
          if (name === "label") return "New question";
          if (name === "type") return "short";
          return null;
        }),
        getBoolean: vi.fn((name: string) =>
          name === "required" ? true : null,
        ),
        getInteger: vi.fn((name: string) => {
          if (name === "position") return 0;
          if (name === "min_length") return 1;
          if (name === "max_length") return 100;
          return null;
        }),
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

    await handleApplicationCommand(
      interaction as never,
      runtime(storage, harness.guild),
    );

    expect(storage.upsertApplicationFormField).toHaveBeenCalledWith(
      FORM_ID,
      expect.objectContaining({ fieldId: "new-question", sortOrder: 2 }),
    );
    expect(storage.reorderApplicationFormFields).toHaveBeenCalledWith(FORM_ID, [
      "new-question",
      "question01",
      "question02",
    ]);
  });

  it("refuses recovery until an imported form is explicitly revalidated", async () => {
    const harness = guildHarness({ owner: true });
    const storage = {
      getApplicationByNumber: vi.fn(() => application()),
      getApplicationForm: vi.fn(() => form({ bindingsVerifiedAt: null })),
      listCapabilitiesForRoles: vi.fn(() => []),
      recordCommandMetric: vi.fn(),
    };
    const interaction: Record<string, any> = {
      guild: harness.guild,
      guildId: GUILD_ID,
      user: { id: REVIEWER_ID },
      options: {
        getSubcommandGroup: vi.fn(() => null),
        getSubcommand: vi.fn(() => "recover"),
        getInteger: vi.fn(() => 7),
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

    await handleApplicationCommand(
      interaction as never,
      runtime(storage, harness.guild),
    );

    expect(harness.reviewMessage.edit).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("not found or you are not authorized"),
      }),
    );
  });
});
