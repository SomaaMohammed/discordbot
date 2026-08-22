import { type Guild, type Message, type TextChannel } from "discord.js";
import type {
  CaseAppeal,
  CaseAppealTransitionResult,
  ModerationConfiguration,
  ModerationCase,
  DeliveryClaimResult,
  DeliveryAttempt,
  DeliveryAttemptTransitionResult,
} from "../types.js";
import { buildAppealReviewPayload } from "./appeal-components.js";
import { findBotMessageByAttempt } from "./delivery-nonce.js";
import {
  inspectSafetyWorkflowResources,
  type SafetyCapabilityGrantReader,
} from "./safety-permissions.js";

export interface AppealDeliveryStorage extends SafetyCapabilityGrantReader {
  getModerationConfiguration(): ModerationConfiguration | null;
  claimCaseAppealDelivery(
    appealId: string,
    input?: { expectedUpdatedAt?: string },
  ): DeliveryClaimResult<CaseAppeal>;
  getCaseAppealDeliveryAttempt(appealId: string): DeliveryAttempt | null;
  beginCaseAppealDeliveryAttempt(
    appealId: string,
    input: {
      channelId: string;
      claimId: string;
      expectedUpdatedAt: string;
      previousAttemptId?: string;
    },
  ): DeliveryAttemptTransitionResult<CaseAppeal>;
  bindCaseAppealDelivery(
    appealId: string,
    input: {
      reviewChannelId: string;
      reviewMessageId: string;
      expectedUpdatedAt?: string;
      claimId: string;
    },
  ): CaseAppealTransitionResult;
  failCaseAppealDelivery(
    appealId: string,
    input: {
      failureCode: string;
      claimId?: string;
      expectedUpdatedAt?: string;
    },
  ): CaseAppealTransitionResult;
  checkpointCaseAppealDeliveryOrphan(
    appealId: string,
    input: {
      reviewChannelId: string;
      reviewMessageId: string;
      claimId: string;
      failureCode: string;
      expectedUpdatedAt: string;
    },
  ): CaseAppealTransitionResult;
  markCaseAppealDeliveryMissing(
    appealId: string,
    input: { expectedUpdatedAt?: string },
  ): CaseAppealTransitionResult;
  getCaseAppealById(appealId: string): CaseAppeal | null;
  getModerationCaseById(caseId: string): ModerationCase | null;
}

export async function publishReservedAppeal(
  guild: Guild,
  channel: TextChannel,
  appeal: CaseAppeal,
  moderationCase: ModerationCase,
  storage: AppealDeliveryStorage,
  isCurrent: () => boolean = () => true,
  allowDisabledRecovery = false,
): Promise<{ appeal: CaseAppeal; message: Message }> {
  if (
    guild.id !== appeal.guildId ||
    moderationCase.guildId !== guild.id ||
    appeal.caseId !== moderationCase.caseId ||
    channel.guild.id !== guild.id ||
    !isCurrent()
  )
    throw new Error("Appeal delivery resources are stale or cross-server.");
  let message: Message | null = null;
  let boundAppeal: CaseAppeal | null = null;
  let deliveryRecord: CaseAppeal;
  let durableAttemptActive = false;
  let knownUnboundMessage: { channelId: string; messageId: string } | null =
    null;
  const claim = storage.claimCaseAppealDelivery(appeal.appealId, {
    expectedUpdatedAt: appeal.updatedAt,
  });
  if (claim.status !== "claimed") {
    throw new Error(
      claim.status === "busy"
        ? "Another appeal delivery operation is already in progress."
        : "Appeal delivery could not acquire a current persistent claim.",
    );
  }
  deliveryRecord = claim.record;
  try {
    const destination = await currentAppealDestination(
      guild,
      storage,
      isCurrent,
      !allowDisabledRecovery,
    );
    if (!destination || destination.id !== channel.id) {
      throw new Error(
        "The configured private appeal destination is no longer verified.",
      );
    }
    if (
      claim.record.deliveryState === "missing" &&
      claim.record.reviewChannelId &&
      claim.record.reviewMessageId
    ) {
      knownUnboundMessage = {
        channelId: claim.record.reviewChannelId,
        messageId: claim.record.reviewMessageId,
      };
      if (claim.record.reviewChannelId !== destination.id) {
        if (
          !(await retireTrackedMessage(
            guild,
            claim.record.reviewChannelId,
            claim.record.reviewMessageId,
          ))
        ) {
          throw new Error(
            "The prior appeal message could not be unambiguously retired.",
          );
        }
        knownUnboundMessage = null;
      } else {
        const tracked = await fetchTrackedMessage(
          destination,
          claim.record.reviewMessageId,
          guild.client.user?.id ?? null,
        );
        if (tracked.status === "unavailable") {
          throw new Error(
            "The prior appeal message could not be unambiguously verified.",
          );
        }
        if (tracked.status === "found") {
          message = tracked.message;
        } else {
          knownUnboundMessage = null;
        }
      }
    }
    const priorAttempt = storage.getCaseAppealDeliveryAttempt(appeal.appealId);
    let previousAttemptId: string | undefined;
    if (!message && !knownUnboundMessage && priorAttempt) {
      durableAttemptActive = true;
      const recovered = await findBotMessageByAttempt(
        guild,
        guild.client.user?.id ?? null,
        priorAttempt,
      );
      if (recovered.status === "found") {
        if (priorAttempt.channelId === destination.id) {
          message = recovered.message;
          knownUnboundMessage = {
            channelId: destination.id,
            messageId: recovered.message.id,
          };
        } else if (!(await retireMessage(recovered.message))) {
          throw new Error(
            "The prior appeal attempt could not be unambiguously retired.",
          );
        }
      } else if (recovered.status !== "missing") {
        throw new Error(
          "Appeal recovery could not prove a unique prior Discord delivery.",
        );
      }
      if (!message && priorAttempt.channelId !== destination.id) {
        previousAttemptId = priorAttempt.attemptId;
      }
    }
    if (!message) {
      const begun = storage.beginCaseAppealDeliveryAttempt(appeal.appealId, {
        channelId: destination.id,
        claimId: claim.claimId,
        expectedUpdatedAt: deliveryRecord.updatedAt,
        ...(previousAttemptId ? { previousAttemptId } : {}),
      });
      if (
        (begun.status !== "changed" && begun.status !== "unchanged") ||
        !begun.record ||
        !begun.attempt ||
        begun.attempt.channelId !== destination.id
      ) {
        throw new Error(
          "Appeal delivery could not persist its pre-send attempt.",
        );
      }
      deliveryRecord = begun.record;
      durableAttemptActive = true;
      message = await destination.send({
        ...buildAppealReviewPayload(deliveryRecord, moderationCase),
        nonce: begun.attempt.attemptId,
        enforceNonce: true,
      });
      knownUnboundMessage = {
        channelId: destination.id,
        messageId: message.id,
      };
    }
    // Bind the known Discord message while the persistent lease is still held,
    // even if the runtime generation changed during send. Otherwise an
    // ambiguous delete could leave sensitive content untracked and a later
    // recovery could silently post a duplicate.
    const bound = storage.bindCaseAppealDelivery(appeal.appealId, {
      reviewChannelId: destination.id,
      reviewMessageId: message.id,
      claimId: claim.claimId,
      expectedUpdatedAt: deliveryRecord.updatedAt,
    });
    if (bound.status !== "changed" && bound.status !== "unchanged") {
      throw new Error(
        "Appeal delivery checkpoint changed before it could be saved.",
      );
    }
    if (bound.appeal.reviewMessageId !== message.id) {
      throw new Error("Another operation already delivered this appeal.");
    }
    boundAppeal = bound.appeal;
    knownUnboundMessage = null;
    await message.edit(buildAppealReviewPayload(bound.appeal, moderationCase));
    if (!isCurrent()) {
      throw new Error(
        "Appeal delivery was cancelled after its checkpoint was saved.",
      );
    }
    return { appeal: bound.appeal, message };
  } catch (error) {
    if (boundAppeal) {
      const retired = message ? await retireMessage(message) : true;
      if (retired) markMissing(storage, boundAppeal, () => true);
    } else if (knownUnboundMessage) {
      const retired = message ? await retireMessage(message) : false;
      if (retired) {
        safeFailDelivery(
          storage,
          appeal.appealId,
          claim,
          isCurrent,
          deliveryRecord.updatedAt,
        );
      } else {
        checkpointOrphan(
          storage,
          appeal.appealId,
          knownUnboundMessage,
          claim.claimId,
          deliveryRecord.updatedAt,
          isCurrent()
            ? "orphan-delete-ambiguous"
            : "runtime-changed-orphan-delete-ambiguous",
        );
      }
    } else if (!durableAttemptActive) {
      safeFailDelivery(storage, appeal.appealId, claim, isCurrent);
    }
    throw error;
  }
}

export async function refreshAppealReviewMessage(
  guild: Guild,
  appeal: CaseAppeal,
  moderationCase: ModerationCase,
  storage: AppealDeliveryStorage,
  isCurrent: () => boolean = () => true,
): Promise<"updated" | "missing" | "unavailable"> {
  if (
    appeal.guildId !== guild.id ||
    moderationCase.guildId !== guild.id ||
    appeal.caseId !== moderationCase.caseId ||
    !appeal.reviewChannelId ||
    !appeal.reviewMessageId ||
    !isCurrent()
  )
    return "unavailable";
  const destination = await currentAppealDestination(
    guild,
    storage,
    isCurrent,
    false,
  );
  if (!destination) return "unavailable";
  if (appeal.reviewChannelId !== destination.id) {
    const retired = await retireTrackedMessage(
      guild,
      appeal.reviewChannelId,
      appeal.reviewMessageId,
    );
    return retired ? markMissing(storage, appeal, isCurrent) : "unavailable";
  }
  let message: Message;
  try {
    message = await destination.messages.fetch(appeal.reviewMessageId);
  } catch (error) {
    return isUnknownDiscordResource(error, 10_008)
      ? markMissing(storage, appeal, isCurrent)
      : "unavailable";
  }
  if (!message || message.author.id !== guild.client.user?.id) {
    return markMissing(storage, appeal, isCurrent);
  }
  const latest = storage.getCaseAppealById(appeal.appealId);
  const latestCase = latest
    ? storage.getModerationCaseById(latest.caseId)
    : null;
  if (!latest || !latestCase || !isCurrent()) return "unavailable";
  try {
    await message.edit(buildAppealReviewPayload(latest, latestCase));
  } catch (error) {
    return isUnknownDiscordResource(error, 10_008)
      ? markMissing(storage, latest, isCurrent)
      : "unavailable";
  }
  return isCurrent() ? "updated" : "unavailable";
}

async function currentAppealDestination(
  guild: Guild,
  storage: AppealDeliveryStorage,
  isCurrent: () => boolean,
  requireEnabled: boolean,
): Promise<TextChannel | null> {
  const configuration = storage.getModerationConfiguration();
  if (
    !configuration ||
    configuration.guildId !== guild.id ||
    !configuration.appealBindingsVerifiedAt ||
    !configuration.appealReviewChannelId ||
    (requireEnabled && !configuration.appealsEnabled) ||
    !isCurrent()
  ) {
    return null;
  }
  const resources = await inspectSafetyWorkflowResources(
    guild,
    configuration,
    "appeals",
    storage,
  );
  if (
    !resources.reviewChannel ||
    resources.reviewChannel.id !== configuration.appealReviewChannelId ||
    resources.issues.length > 0 ||
    !isCurrent()
  ) {
    return null;
  }
  const latest = storage.getModerationConfiguration();
  return latest?.updatedAt === configuration.updatedAt && isCurrent()
    ? resources.reviewChannel
    : null;
}

async function retireTrackedMessage(
  guild: Guild,
  channelId: string,
  messageId: string,
): Promise<boolean> {
  let channel;
  try {
    channel = await guild.channels.fetch(channelId, {
      cache: true,
      force: true,
    });
  } catch (error) {
    return isUnknownDiscordResource(error, 10_003);
  }
  if (!channel || channel.guild.id !== guild.id || !("messages" in channel))
    return false;
  let message: Message;
  try {
    message = await channel.messages.fetch(messageId);
  } catch (error) {
    return isUnknownDiscordResource(error, 10_008);
  }
  if (message.author.id !== guild.client.user?.id) return true;
  return retireMessage(message);
}

async function fetchTrackedMessage(
  channel: TextChannel,
  messageId: string,
  botUserId: string | null,
): Promise<
  { status: "found"; message: Message } | { status: "missing" | "unavailable" }
> {
  if (!botUserId) return { status: "unavailable" };
  let message: Message;
  try {
    message = await channel.messages.fetch(messageId);
  } catch (error) {
    return {
      status: isUnknownDiscordResource(error, 10_008)
        ? "missing"
        : "unavailable",
    };
  }
  return message.author.id === botUserId
    ? { status: "found", message }
    : { status: "missing" };
}

async function retireMessage(message: Message): Promise<boolean> {
  try {
    await message.delete();
    return true;
  } catch (error) {
    return isUnknownDiscordResource(error, 10_008);
  }
}

function isUnknownDiscordResource(
  error: unknown,
  expectedCode: number,
): boolean {
  if (!error || typeof error !== "object") return false;
  return Number((error as { code?: unknown }).code) === expectedCode;
}

function safeFailDelivery(
  storage: AppealDeliveryStorage,
  appealId: string,
  claim: Extract<DeliveryClaimResult<CaseAppeal>, { status: "claimed" }>,
  isCurrent: () => boolean,
  expectedUpdatedAt = claim.record.updatedAt,
): void {
  try {
    storage.failCaseAppealDelivery(appealId, {
      failureCode: isCurrent() ? "discord-delivery-failed" : "runtime-changed",
      claimId: claim.claimId,
      expectedUpdatedAt,
    });
  } catch {
    // Preserve the delivery error for recovery.
  }
}

function checkpointOrphan(
  storage: AppealDeliveryStorage,
  appealId: string,
  known: { channelId: string; messageId: string },
  claimId: string,
  initialUpdatedAt: string,
  failureCode: string,
): boolean {
  let expectedUpdatedAt = initialUpdatedAt;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = storage.checkpointCaseAppealDeliveryOrphan(appealId, {
        reviewChannelId: known.channelId,
        reviewMessageId: known.messageId,
        claimId,
        failureCode,
        expectedUpdatedAt,
      });
      if (result.status === "changed" || result.status === "unchanged") {
        return true;
      }
      const latest = storage.getCaseAppealById(appealId);
      if (
        latest?.reviewChannelId === known.channelId &&
        latest.reviewMessageId === known.messageId &&
        (latest.deliveryState === "missing" ||
          latest.deliveryState === "posted")
      ) {
        return true;
      }
      if (!latest) return false;
      expectedUpdatedAt = latest.updatedAt;
    } catch {
      return false;
    }
  }
  return false;
}

function markMissing(
  storage: AppealDeliveryStorage,
  appeal: CaseAppeal,
  isCurrent: () => boolean,
): "missing" | "unavailable" {
  if (!isCurrent()) return "unavailable";
  const result = storage.markCaseAppealDeliveryMissing(appeal.appealId, {
    expectedUpdatedAt: appeal.updatedAt,
  });
  return result.status === "changed" || result.status === "unchanged"
    ? "missing"
    : "unavailable";
}
