import {
  ChannelType,
  Collection,
  type Guild,
  type Message,
  type TextChannel,
} from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { GuildRuntime } from "../src/runtime.js";
import type {
  CaseAppeal,
  MemberReport,
  ModerationCase,
  ModerationConfiguration,
} from "../src/types.js";
import { appealVersionToken } from "../src/discord/appeal-components.js";
import { handleAppealCommand } from "../src/discord/appeal-commands-handler.js";
import {
  publishReservedAppeal,
  refreshAppealReviewMessage,
} from "../src/discord/appeal-delivery.js";
import { reportVersionToken } from "../src/discord/report-components.js";
import { handleReportCommand } from "../src/discord/report-commands-handler.js";
import {
  publishReservedReport,
  refreshReportReviewMessage,
} from "../src/discord/report-delivery.js";

type Workflow = "report" | "appeal";
type RecoveryMode = "deleted" | "rebind" | "unverified";

const GUILD_ID = "123456789012345678";
const REVIEWER_ID = "223456789012345678";
const TARGET_ID = "323456789012345678";
const BOT_ID = "423456789012345678";
const ROLE_ID = "523456789012345678";
const CURRENT_CHANNEL_ID = "623456789012345678";
const OLD_CHANNEL_ID = "723456789012345678";
const OLD_MESSAGE_ID = "823456789012345678";
const NEW_MESSAGE_ID = "923456789012345678";
const T0 = "2026-08-13T00:00:00.000Z";
const T1 = "2026-08-13T00:01:00.000Z";
const T2 = "2026-08-13T00:02:00.000Z";
const T3 = "2026-08-13T00:03:00.000Z";
const T4 = "2026-08-13T00:04:00.000Z";
const ATTEMPT_ID = "delivery_attempt_token";

describe("Phase 3 delivery leases", () => {
  it.each(["report", "appeal"] as const)(
    "acquires the %s lease before sending and never sends while it is busy",
    async (workflow) => {
      const harness = createDeliveryHarness(workflow, "busy");

      await expect(publish(harness)).rejects.toThrow(/already in progress/u);

      expect(harness.claim).toHaveBeenCalledWith(recordId(harness.record), {
        expectedUpdatedAt: T0,
      });
      expect(harness.environment.currentChannel.send).not.toHaveBeenCalled();
      expect(harness.bind).not.toHaveBeenCalled();
    },
  );

  it.each(["report", "appeal"] as const)(
    "retains the durable %s attempt when Discord send is ambiguous",
    async (workflow) => {
      const harness = createDeliveryHarness(workflow, "claimed");
      harness.environment.currentChannel.send.mockRejectedValueOnce(
        Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
      );

      await expect(publish(harness)).rejects.toThrow(/socket reset/u);

      expect(harness.begin).toHaveBeenCalledOnce();
      expect(harness.fail).not.toHaveBeenCalled();
      expect(harness.bind).not.toHaveBeenCalled();
    },
  );

  it.each(["report", "appeal"] as const)(
    "clears a proven-deleted %s send with the post-begin version",
    async (workflow) => {
      const harness = createDeliveryHarness(workflow, "claimed");
      harness.bind.mockImplementationOnce(
        () =>
          (workflow === "report"
            ? { status: "conflict" as const, report: harness.attemptRecord }
            : {
                status: "conflict" as const,
                appeal: harness.attemptRecord,
              }) as never,
      );

      await expect(publish(harness)).rejects.toThrow(/checkpoint changed/u);

      expect(harness.environment.newMessage.delete).toHaveBeenCalledOnce();
      expect(harness.fail).toHaveBeenCalledWith(recordId(harness.record), {
        failureCode: "discord-delivery-failed",
        claimId: "delivery_claim_token",
        expectedUpdatedAt: T2,
      });
    },
  );

  it.each(["report", "appeal"] as const)(
    "adopts one nonce-matched %s attempt without resending",
    async (workflow) => {
      const harness = createDeliveryHarness(workflow, "claimed");
      const recovered = Object.assign(harness.environment.oldMessage, {
        nonce: ATTEMPT_ID,
        createdTimestamp: Date.parse(T1),
      });
      harness.getAttempt.mockReturnValue({
        attemptId: ATTEMPT_ID,
        channelId: CURRENT_CHANNEL_ID,
        startedAt: T0,
      });
      harness.environment.currentChannel.messages.fetch.mockResolvedValueOnce(
        new Collection([[recovered.id, recovered]]),
      );
      harness.bind.mockImplementationOnce(() => {
        const adopted = {
          ...harness.boundRecord,
          reviewMessageId: OLD_MESSAGE_ID,
        };
        return workflow === "report"
          ? { status: "changed" as const, report: adopted }
          : { status: "changed" as const, appeal: adopted };
      });

      await expect(publish(harness)).resolves.toEqual(
        expect.objectContaining({ message: recovered }),
      );

      expect(harness.begin).not.toHaveBeenCalled();
      expect(harness.environment.currentChannel.send).not.toHaveBeenCalled();
      expect(harness.bind).toHaveBeenCalledWith(
        recordId(harness.record),
        expect.objectContaining({ reviewMessageId: OLD_MESSAGE_ID }),
      );
    },
  );

  it.each(["report", "appeal"] as const)(
    "fails closed when a %s attempt nonce is ambiguous",
    async (workflow) => {
      const harness = createDeliveryHarness(workflow, "claimed");
      const first = {
        ...harness.environment.oldMessage,
        nonce: ATTEMPT_ID,
        createdTimestamp: Date.parse(T1),
      };
      const second = {
        ...harness.environment.oldMessage,
        id: "833456789012345678",
        nonce: ATTEMPT_ID,
        createdTimestamp: Date.parse(T1),
      };
      harness.getAttempt.mockReturnValue({
        attemptId: ATTEMPT_ID,
        channelId: CURRENT_CHANNEL_ID,
        startedAt: T0,
      });
      harness.environment.currentChannel.messages.fetch.mockResolvedValueOnce(
        new Collection([
          [first.id, first],
          [second.id, second],
        ]),
      );

      await expect(publish(harness)).rejects.toThrow(/unique prior/u);

      expect(harness.begin).not.toHaveBeenCalled();
      expect(harness.environment.currentChannel.send).not.toHaveBeenCalled();
      expect(harness.fail).not.toHaveBeenCalled();
    },
  );

  it.each(["report", "appeal"] as const)(
    "refreshes the posted %s controls with the bound record version",
    async (workflow) => {
      const harness = createDeliveryHarness(workflow, "claimed");

      await expect(publish(harness)).resolves.toEqual(
        expect.objectContaining({ message: harness.environment.newMessage }),
      );

      expect(harness.environment.currentChannel.send).toHaveBeenCalledOnce();
      expect(harness.begin).toHaveBeenCalledWith(recordId(harness.record), {
        channelId: CURRENT_CHANNEL_ID,
        claimId: "delivery_claim_token",
        expectedUpdatedAt: T1,
      });
      expect(harness.environment.currentChannel.send).toHaveBeenCalledWith(
        expect.objectContaining({
          nonce: ATTEMPT_ID,
          enforceNonce: true,
        }),
      );
      expect(harness.bind).toHaveBeenCalledWith(recordId(harness.record), {
        reviewChannelId: CURRENT_CHANNEL_ID,
        reviewMessageId: NEW_MESSAGE_ID,
        claimId: "delivery_claim_token",
        expectedUpdatedAt: T2,
      });
      expect(harness.environment.newMessage.edit).toHaveBeenCalledOnce();
      expect(harness.claim.mock.invocationCallOrder[0]).toBeLessThan(
        harness.begin.mock.invocationCallOrder[0]!,
      );
      expect(harness.begin.mock.invocationCallOrder[0]).toBeLessThan(
        harness.environment.currentChannel.send.mock.invocationCallOrder[0]!,
      );
      const edited = JSON.stringify(
        harness.environment.newMessage.edit.mock.calls[0]![0],
      );
      const boundVersion =
        workflow === "report" ? reportVersionToken(T3) : appealVersionToken(T3);
      const claimedVersion =
        workflow === "report" ? reportVersionToken(T1) : appealVersionToken(T1);
      expect(edited).toContain(boundVersion);
      expect(boundVersion).not.toBe(claimedVersion);
    },
  );

  it.each(["report", "appeal"] as const)(
    "does not mark or repost a %s after an ambiguous tracked-message fetch",
    async (workflow) => {
      const harness = createDeliveryHarness(workflow, "ambiguous");

      await expect(refresh(harness)).resolves.toBe("unavailable");

      expect(harness.markMissing).not.toHaveBeenCalled();
      expect(harness.environment.currentChannel.send).not.toHaveBeenCalled();
    },
  );

  it.each(["report", "appeal"] as const)(
    "checkpoints then retires a just-posted %s when runtime state changes during send",
    async (workflow) => {
      const harness = createDeliveryHarness(workflow, "claimed");
      let current = true;
      harness.environment.currentChannel.send.mockImplementationOnce(
        async () => {
          current = false;
          return harness.environment.newMessage;
        },
      );

      await expect(publish(harness, () => current)).rejects.toThrow(
        /checkpoint was saved/u,
      );

      expect(harness.environment.newMessage.delete).toHaveBeenCalledOnce();
      expect(harness.bind).toHaveBeenCalledOnce();
      expect(harness.markMissing).toHaveBeenCalledWith(
        recordId(harness.record),
        { expectedUpdatedAt: T3 },
      );
      expect(harness.fail).not.toHaveBeenCalled();
    },
  );

  it.each(["report", "appeal"] as const)(
    "keeps a just-posted %s durably bound when runtime changes and deletion is ambiguous",
    async (workflow) => {
      const harness = createDeliveryHarness(workflow, "claimed");
      let current = true;
      harness.environment.currentChannel.send.mockImplementationOnce(
        async () => {
          current = false;
          return harness.environment.newMessage;
        },
      );
      harness.environment.newMessage.delete.mockRejectedValueOnce(
        Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
      );

      await expect(publish(harness, () => current)).rejects.toThrow(
        /checkpoint was saved/u,
      );

      expect(harness.bind).toHaveBeenCalledOnce();
      expect(harness.markMissing).not.toHaveBeenCalled();
      expect(harness.fail).not.toHaveBeenCalled();
    },
  );

  it.each(["report", "appeal"] as const)(
    "marks a bound %s missing when its current-version control edit fails",
    async (workflow) => {
      const harness = createDeliveryHarness(workflow, "claimed");
      harness.environment.newMessage.edit.mockRejectedValueOnce(
        Object.assign(new Error("Unknown Message"), { code: 10_008 }),
      );

      await expect(publish(harness)).rejects.toThrow(/Unknown Message/u);

      expect(harness.environment.newMessage.delete).toHaveBeenCalledOnce();
      expect(harness.markMissing).toHaveBeenCalledWith(
        recordId(harness.record),
        { expectedUpdatedAt: T3 },
      );
      expect(harness.fail).not.toHaveBeenCalled();
    },
  );

  it.each(["report", "appeal"] as const)(
    "does not send a %s when the verified configuration changes after claiming",
    async (workflow) => {
      const harness = createDeliveryHarness(workflow, "claimed");
      harness.storage.getModerationConfiguration
        .mockReturnValueOnce(harness.configuration)
        .mockReturnValueOnce({
          ...harness.configuration,
          updatedAt: T1,
        });

      await expect(publish(harness)).rejects.toThrow(/no longer verified/u);

      expect(harness.environment.currentChannel.send).not.toHaveBeenCalled();
      expect(harness.bind).not.toHaveBeenCalled();
      expect(harness.fail).toHaveBeenCalledWith(recordId(harness.record), {
        failureCode: "discord-delivery-failed",
        claimId: "delivery_claim_token",
        expectedUpdatedAt: T1,
      });
    },
  );
});

describe("Phase 3 delivery recovery", () => {
  it.each(["report", "appeal"] as const)(
    "recovers a verified preexisting %s reservation while new submissions are disabled",
    async (workflow) => {
      const harness = createRecoveryHarness(workflow, "deleted");
      if (workflow === "report") harness.configuration.reportsEnabled = false;
      else harness.configuration.appealsEnabled = false;

      await runRecovery(harness);

      expect(harness.environment.currentChannel.send).toHaveBeenCalledOnce();
      expect(harness.bind).toHaveBeenCalledOnce();
    },
  );
  it.each(["report", "appeal"] as const)(
    "rereads a confirmed-missing %s checkpoint before posting one replacement",
    async (workflow) => {
      const harness = createRecoveryHarness(workflow, "deleted");

      await runRecovery(harness);

      expect(harness.markMissing).toHaveBeenCalledWith(
        recordId(harness.initialRecord),
        { expectedUpdatedAt: T0 },
      );
      expect(harness.claim).toHaveBeenCalledWith(
        recordId(harness.initialRecord),
        { expectedUpdatedAt: T1 },
      );
      expect(harness.getById.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(harness.environment.currentChannel.send).toHaveBeenCalledOnce();
      expect(harness.environment.newMessage.edit).toHaveBeenCalledOnce();
      expect(harness.environment.oldMessage.delete).not.toHaveBeenCalled();
    },
  );

  it.each(["report", "appeal"] as const)(
    "retires the old bot-owned %s message and posts once in the configured channel",
    async (workflow) => {
      const harness = createRecoveryHarness(workflow, "rebind");

      await runRecovery(harness);

      expect(harness.environment.oldMessage.delete).toHaveBeenCalledOnce();
      expect(harness.markMissing).toHaveBeenCalledWith(
        recordId(harness.initialRecord),
        { expectedUpdatedAt: T0 },
      );
      expect(harness.claim).toHaveBeenCalledWith(
        recordId(harness.initialRecord),
        { expectedUpdatedAt: T1 },
      );
      expect(harness.environment.currentChannel.send).toHaveBeenCalledOnce();
      expect(harness.environment.oldChannel.send).not.toHaveBeenCalled();
    },
  );

  it.each(["report", "appeal"] as const)(
    "does not rebind a %s when retiring the old private message is ambiguous",
    async (workflow) => {
      const harness = createRecoveryHarness(workflow, "rebind");
      harness.environment.oldMessage.delete.mockRejectedValueOnce(
        Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
      );

      await runRecovery(harness);

      expect(harness.environment.oldMessage.delete).toHaveBeenCalledOnce();
      expect(harness.markMissing).not.toHaveBeenCalled();
      expect(harness.claim).not.toHaveBeenCalled();
      expect(harness.environment.currentChannel.send).not.toHaveBeenCalled();
    },
  );

  it.each(["report", "appeal"] as const)(
    "keeps %s recovery inert while imported bindings are unverified",
    async (workflow) => {
      const harness = createRecoveryHarness(workflow, "unverified");

      await runRecovery(harness);

      expect(harness.getByNumber).not.toHaveBeenCalled();
      expect(harness.environment.guild.members.fetch).not.toHaveBeenCalled();
      expect(harness.markMissing).not.toHaveBeenCalled();
      expect(harness.claim).not.toHaveBeenCalled();
      expect(harness.environment.currentChannel.send).not.toHaveBeenCalled();
      expect(harness.interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("verified"),
        }),
      );
    },
  );
});

function createDeliveryHarness(
  workflow: Workflow,
  mode: "busy" | "claimed" | "ambiguous",
) {
  const environment = createDiscordEnvironment(
    mode === "ambiguous" ? "ambiguous" : "available",
  );
  const configuration = moderationConfiguration(workflow, true);
  const record =
    workflow === "report"
      ? reportRecord({
          deliveryState: mode === "ambiguous" ? "posted" : "reserved",
          reviewChannelId: mode === "ambiguous" ? CURRENT_CHANNEL_ID : null,
          reviewMessageId: mode === "ambiguous" ? OLD_MESSAGE_ID : null,
        })
      : appealRecord({
          deliveryState: mode === "ambiguous" ? "posted" : "reserved",
          reviewChannelId: mode === "ambiguous" ? CURRENT_CHANNEL_ID : null,
          reviewMessageId: mode === "ambiguous" ? OLD_MESSAGE_ID : null,
        });
  const claimedRecord = { ...record, updatedAt: T1 };
  const attemptRecord = { ...claimedRecord, updatedAt: T2 };
  const boundRecord = {
    ...attemptRecord,
    deliveryState: "posted" as const,
    reviewChannelId: CURRENT_CHANNEL_ID,
    reviewMessageId: NEW_MESSAGE_ID,
    updatedAt: T3,
  };
  const claim = vi.fn(() =>
    mode === "busy"
      ? {
          status: "busy" as const,
          claimId: null,
          retryAt: T3,
          record,
        }
      : {
          status: "claimed" as const,
          claimId: "delivery_claim_token",
          retryAt: T3,
          record: claimedRecord,
        },
  );
  const bind = vi.fn(() =>
    workflow === "report"
      ? { status: "changed" as const, report: boundRecord }
      : { status: "changed" as const, appeal: boundRecord },
  );
  const markMissing = vi.fn(() =>
    workflow === "report"
      ? { status: "changed" as const, report: record }
      : { status: "changed" as const, appeal: record },
  );
  const fail = vi.fn();
  const getAttempt = vi.fn(
    (): { attemptId: string; channelId: string; startedAt: string } | null =>
      null,
  );
  const begin = vi.fn(() => ({
    status: "changed" as const,
    record: attemptRecord,
    attempt: {
      attemptId: ATTEMPT_ID,
      channelId: CURRENT_CHANNEL_ID,
      startedAt: T1,
    },
  }));
  const storage = {
    getModerationConfiguration: vi.fn(() => configuration),
    listCapabilityGrantsForCapability: vi.fn(() => []),
    claimMemberReportDelivery: claim,
    claimCaseAppealDelivery: claim,
    getMemberReportDeliveryAttempt: getAttempt,
    getCaseAppealDeliveryAttempt: getAttempt,
    beginMemberReportDeliveryAttempt: begin,
    beginCaseAppealDeliveryAttempt: begin,
    bindMemberReportDelivery: bind,
    bindCaseAppealDelivery: bind,
    failMemberReportDelivery: fail,
    failCaseAppealDelivery: fail,
    checkpointMemberReportDeliveryOrphan: vi.fn(),
    checkpointCaseAppealDeliveryOrphan: vi.fn(),
    markMemberReportDeliveryMissing: markMissing,
    markCaseAppealDeliveryMissing: markMissing,
    getMemberReportById: vi.fn(() => boundRecord),
    getCaseAppealById: vi.fn(() => boundRecord),
    getModerationCaseById: vi.fn(() => MODERATION_CASE),
  };
  return {
    workflow,
    environment,
    configuration,
    record,
    claimedRecord,
    attemptRecord,
    boundRecord,
    claim,
    bind,
    markMissing,
    fail,
    begin,
    getAttempt,
    storage,
  };
}

async function publish(
  harness: ReturnType<typeof createDeliveryHarness>,
  isCurrent: () => boolean = () => true,
): Promise<unknown> {
  if (harness.workflow === "report") {
    return publishReservedReport(
      harness.environment.guild as unknown as Guild,
      harness.environment.currentChannel as unknown as TextChannel,
      harness.record as MemberReport,
      harness.storage as never,
      isCurrent,
    );
  }
  return publishReservedAppeal(
    harness.environment.guild as unknown as Guild,
    harness.environment.currentChannel as unknown as TextChannel,
    harness.record as CaseAppeal,
    MODERATION_CASE,
    harness.storage as never,
    isCurrent,
  );
}

async function refresh(
  harness: ReturnType<typeof createDeliveryHarness>,
): Promise<unknown> {
  if (harness.workflow === "report") {
    return refreshReportReviewMessage(
      harness.environment.guild as unknown as Guild,
      harness.record as MemberReport,
      harness.storage as never,
    );
  }
  return refreshAppealReviewMessage(
    harness.environment.guild as unknown as Guild,
    harness.record as CaseAppeal,
    MODERATION_CASE,
    harness.storage as never,
  );
}

function createRecoveryHarness(workflow: Workflow, mode: RecoveryMode) {
  const environment = createDiscordEnvironment(
    mode === "deleted" ? "missing" : "available",
  );
  const configuration = moderationConfiguration(
    workflow,
    mode !== "unverified",
  );
  const initialRecord =
    workflow === "report"
      ? reportRecord({
          reviewChannelId:
            mode === "rebind" ? OLD_CHANNEL_ID : CURRENT_CHANNEL_ID,
          reviewMessageId: OLD_MESSAGE_ID,
          deliveryState: "posted",
        })
      : appealRecord({
          reviewChannelId:
            mode === "rebind" ? OLD_CHANNEL_ID : CURRENT_CHANNEL_ID,
          reviewMessageId: OLD_MESSAGE_ID,
          deliveryState: "posted",
        });
  let currentRecord: MemberReport | CaseAppeal = initialRecord;

  const markMissing = vi.fn(() => {
    currentRecord = {
      ...currentRecord,
      deliveryState: "missing",
      updatedAt: T1,
    };
    return workflow === "report"
      ? { status: "changed" as const, report: currentRecord }
      : { status: "changed" as const, appeal: currentRecord };
  });
  const claim = vi.fn(() => {
    currentRecord = { ...currentRecord, updatedAt: T2 };
    return {
      status: "claimed" as const,
      claimId: "recovery_claim_token",
      retryAt: T3,
      record: currentRecord,
    };
  });
  const getAttempt = vi.fn(
    (): { attemptId: string; channelId: string; startedAt: string } | null =>
      null,
  );
  const begin = vi.fn(() => {
    currentRecord = { ...currentRecord, updatedAt: T3 };
    return {
      status: "changed" as const,
      record: currentRecord,
      attempt: {
        attemptId: ATTEMPT_ID,
        channelId: CURRENT_CHANNEL_ID,
        startedAt: T2,
      },
    };
  });
  const bind = vi.fn(() => {
    currentRecord = {
      ...currentRecord,
      deliveryState: "posted",
      reviewChannelId: CURRENT_CHANNEL_ID,
      reviewMessageId: NEW_MESSAGE_ID,
      updatedAt: T4,
    };
    return workflow === "report"
      ? { status: "changed" as const, report: currentRecord }
      : { status: "changed" as const, appeal: currentRecord };
  });
  const getById = vi.fn(() => currentRecord);
  const getByNumber = vi.fn(() => initialRecord);
  const storage = {
    getModerationConfiguration: vi.fn(() => configuration),
    listCapabilityGrantsForCapability: vi.fn(() => []),
    listCapabilitiesForRoles: vi.fn(() => []),
    recordCommandMetric: vi.fn(),
    getMemberReportByNumber: getByNumber,
    getMemberReportById: getById,
    markMemberReportDeliveryMissing: markMissing,
    claimMemberReportDelivery: claim,
    getMemberReportDeliveryAttempt: getAttempt,
    beginMemberReportDeliveryAttempt: begin,
    bindMemberReportDelivery: bind,
    failMemberReportDelivery: vi.fn(),
    checkpointMemberReportDeliveryOrphan: vi.fn(),
    getCaseAppealByNumber: getByNumber,
    getCaseAppealById: getById,
    markCaseAppealDeliveryMissing: markMissing,
    claimCaseAppealDelivery: claim,
    getCaseAppealDeliveryAttempt: getAttempt,
    beginCaseAppealDeliveryAttempt: begin,
    bindCaseAppealDelivery: bind,
    failCaseAppealDelivery: vi.fn(),
    checkpointCaseAppealDeliveryOrphan: vi.fn(),
    getModerationCaseById: vi.fn(() => MODERATION_CASE),
  };
  const interaction = commandInteraction(environment.guild, workflow);
  const runtime = {
    guildId: GUILD_ID,
    storage,
    isCurrent: vi.fn(() => true),
  } as unknown as GuildRuntime;

  return {
    workflow,
    mode,
    environment,
    configuration,
    initialRecord,
    storage,
    interaction,
    runtime,
    markMissing,
    claim,
    bind,
    begin,
    getAttempt,
    getById,
    getByNumber,
  };
}

async function runRecovery(
  harness: ReturnType<typeof createRecoveryHarness>,
): Promise<void> {
  if (harness.workflow === "report") {
    await handleReportCommand(harness.interaction as never, harness.runtime);
  } else {
    await handleAppealCommand(harness.interaction as never, harness.runtime);
  }
}

function createDiscordEnvironment(
  fetchMode: "available" | "missing" | "ambiguous",
) {
  let oldMessageDeleted = false;
  const oldMessage = {
    id: OLD_MESSAGE_ID,
    author: { id: BOT_ID },
    edit: vi.fn(async (_payload: unknown) => undefined),
    delete: vi.fn(async () => {
      oldMessageDeleted = true;
    }),
  };
  const newMessage = {
    id: NEW_MESSAGE_ID,
    author: { id: BOT_ID },
    edit: vi.fn(async (_payload: unknown) => undefined),
    delete: vi.fn(async () => undefined),
  };
  const currentFetch = vi.fn(async () => {
    if (fetchMode === "missing") {
      throw Object.assign(new Error("Unknown Message"), { code: 10_008 });
    }
    if (fetchMode === "ambiguous") {
      throw Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
    }
    return oldMessage;
  });
  const currentChannel = reviewChannel(
    CURRENT_CHANNEL_ID,
    currentFetch,
    newMessage,
  );
  const oldChannel = reviewChannel(
    OLD_CHANNEL_ID,
    vi.fn(async () => {
      if (oldMessageDeleted) {
        throw Object.assign(new Error("Unknown Message"), { code: 10_008 });
      }
      return oldMessage;
    }),
    newMessage,
  );
  const reviewerRole = {
    id: ROLE_ID,
    managed: false,
    guild: null as unknown,
  };
  const reviewer = {
    id: REVIEWER_ID,
    guild: null as unknown,
    permissions: { has: vi.fn(() => false) },
    roles: { cache: new Collection() },
  };
  const botMember = {
    id: BOT_ID,
    guild: null as unknown,
    roles: { cache: new Collection() },
  };
  const everyoneRole = { id: GUILD_ID, guild: null as unknown };
  const guild = {
    id: GUILD_ID,
    ownerId: REVIEWER_ID,
    client: { user: { id: BOT_ID } },
    channels: {
      fetch: vi.fn(async (channelId: string) =>
        channelId === CURRENT_CHANNEL_ID
          ? currentChannel
          : channelId === OLD_CHANNEL_ID
            ? oldChannel
            : null,
      ),
    },
    members: {
      fetch: vi.fn(async () => reviewer),
      fetchMe: vi.fn(async () => botMember),
    },
    roles: {
      everyone: everyoneRole,
      fetch: vi.fn(async (roleId: string) =>
        roleId === ROLE_ID ? reviewerRole : null,
      ),
    },
  };
  currentChannel.guild = guild;
  oldChannel.guild = guild;
  reviewerRole.guild = guild;
  reviewer.guild = guild;
  botMember.guild = guild;
  everyoneRole.guild = guild;
  return {
    guild,
    currentChannel,
    oldChannel,
    oldMessage,
    newMessage,
  };
}

function reviewChannel(
  id: string,
  fetch: ReturnType<typeof vi.fn>,
  sentMessage: Record<string, unknown>,
) {
  return {
    id,
    type: ChannelType.GuildText,
    guild: null as unknown,
    permissionOverwrites: { cache: new Collection() },
    permissionsFor: vi.fn((subject: { id?: string }) => ({
      has: vi.fn(() => subject.id !== GUILD_ID),
    })),
    messages: { fetch },
    send: vi.fn(async () => sentMessage),
  };
}

function commandInteraction(
  guild: ReturnType<typeof createDiscordEnvironment>["guild"],
  workflow: Workflow,
) {
  const interaction = {
    guild,
    user: { id: REVIEWER_ID },
    deferred: false,
    replied: false,
    options: {
      getSubcommand: vi.fn(() => "recover"),
      getInteger: vi.fn(() => (workflow === "report" ? 7 : 9)),
    },
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
  };
  return interaction;
}

function moderationConfiguration(
  workflow: Workflow,
  verified: boolean,
): ModerationConfiguration {
  return {
    guildId: GUILD_ID,
    casesEnabled: true,
    moderationLogChannelId: null,
    moderationLogVerifiedAt: null,
    reportsEnabled: workflow === "report",
    reportReviewChannelId: workflow === "report" ? CURRENT_CHANNEL_ID : null,
    reportReviewerRoleId: workflow === "report" ? ROLE_ID : null,
    reportBindingsVerifiedAt: workflow === "report" && verified ? T0 : null,
    appealsEnabled: workflow === "appeal",
    appealReviewChannelId: workflow === "appeal" ? CURRENT_CHANNEL_ID : null,
    appealReviewerRoleId: workflow === "appeal" ? ROLE_ID : null,
    appealBindingsVerifiedAt: workflow === "appeal" && verified ? T0 : null,
    antiSpamEnabled: false,
    reportCooldownLimit: 3,
    reportCooldownWindowSeconds: 1_800,
    createdBy: REVIEWER_ID,
    updatedBy: REVIEWER_ID,
    createdAt: T0,
    updatedAt: T0,
  };
}

function reportRecord(overrides: Partial<MemberReport> = {}): MemberReport {
  return {
    guildId: GUILD_ID,
    reportId: "report_token_123",
    reportNumber: 7,
    reporterId: REVIEWER_ID,
    targetUserId: TARGET_ID,
    category: "safety",
    explanation: "A private report explanation.",
    evidenceGuildId: null,
    evidenceChannelId: null,
    evidenceMessageId: null,
    state: "submitted",
    deliveryState: "reserved",
    reviewChannelId: null,
    reviewMessageId: null,
    claimedBy: null,
    claimedAt: null,
    decisionBy: null,
    decisionReason: null,
    decidedAt: null,
    linkedCaseId: null,
    withdrawnAt: null,
    failureCode: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function appealRecord(overrides: Partial<CaseAppeal> = {}): CaseAppeal {
  return {
    guildId: GUILD_ID,
    appealId: "appeal_token_123",
    appealNumber: 9,
    caseId: MODERATION_CASE.caseId,
    appellantId: TARGET_ID,
    explanation: "A private appeal explanation.",
    state: "submitted",
    deliveryState: "reserved",
    reviewChannelId: null,
    reviewMessageId: null,
    claimedBy: null,
    claimedAt: null,
    decisionBy: null,
    decisionReason: null,
    decidedAt: null,
    reversalCaseId: null,
    withdrawnAt: null,
    failureCode: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function recordId(record: MemberReport | CaseAppeal): string {
  return "reportId" in record ? record.reportId : record.appealId;
}

const MODERATION_CASE: ModerationCase = {
  guildId: GUILD_ID,
  caseId: "case_token_123",
  caseNumber: 42,
  targetUserId: TARGET_ID,
  actorId: REVIEWER_ID,
  actionType: "warning",
  source: "moderation-command",
  publicReason: "A public moderation reason.",
  privateNote: null,
  discordActionMetadata: {},
  status: "active",
  relatedCaseId: null,
  voidedBy: null,
  voidedAt: null,
  voidReason: null,
  overturnedBy: null,
  overturnedAt: null,
  overturnReason: null,
  createdAt: T0,
  updatedAt: T0,
};
