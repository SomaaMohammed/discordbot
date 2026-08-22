import { type Guild, type Message, type TextChannel } from "discord.js";
import type {
  ModerationConfiguration,
  MemberReport,
  MemberReportTransitionResult,
  DeliveryClaimResult,
  DeliveryAttempt,
  DeliveryAttemptTransitionResult,
} from "../types.js";
import { buildReportReviewPayload } from "./report-components.js";
import { findBotMessageByAttempt } from "./delivery-nonce.js";
import {
  inspectSafetyWorkflowResources,
  type SafetyCapabilityGrantReader,
} from "./safety-permissions.js";

export interface ReportDeliveryStorage extends SafetyCapabilityGrantReader {
  getModerationConfiguration(): ModerationConfiguration | null;
  claimMemberReportDelivery(
    reportId: string,
    input?: { expectedUpdatedAt?: string },
  ): DeliveryClaimResult<MemberReport>;
  getMemberReportDeliveryAttempt(reportId: string): DeliveryAttempt | null;
  beginMemberReportDeliveryAttempt(
    reportId: string,
    input: {
      channelId: string;
      claimId: string;
      expectedUpdatedAt: string;
      previousAttemptId?: string;
    },
  ): DeliveryAttemptTransitionResult<MemberReport>;
  bindMemberReportDelivery(
    reportId: string,
    input: {
      reviewChannelId: string;
      reviewMessageId: string;
      expectedUpdatedAt?: string;
      claimId: string;
    },
  ): MemberReportTransitionResult;
  failMemberReportDelivery(
    reportId: string,
    input: {
      failureCode: string;
      claimId?: string;
      expectedUpdatedAt?: string;
    },
  ): MemberReportTransitionResult;
  checkpointMemberReportDeliveryOrphan(
    reportId: string,
    input: {
      reviewChannelId: string;
      reviewMessageId: string;
      claimId: string;
      failureCode: string;
      expectedUpdatedAt: string;
    },
  ): MemberReportTransitionResult;
  markMemberReportDeliveryMissing(
    reportId: string,
    input: { expectedUpdatedAt?: string },
  ): MemberReportTransitionResult;
  getMemberReportById(reportId: string): MemberReport | null;
}

export async function publishReservedReport(
  guild: Guild,
  channel: TextChannel,
  report: MemberReport,
  storage: ReportDeliveryStorage,
  isCurrent: () => boolean = () => true,
  allowDisabledRecovery = false,
): Promise<{ report: MemberReport; message: Message }> {
  if (
    guild.id !== report.guildId ||
    channel.guild.id !== guild.id ||
    !isCurrent()
  ) {
    throw new Error("Report delivery resources are stale or cross-server.");
  }
  let message: Message | null = null;
  let boundReport: MemberReport | null = null;
  let deliveryRecord: MemberReport;
  let durableAttemptActive = false;
  let knownUnboundMessage: { channelId: string; messageId: string } | null =
    report.deliveryState === "missing" &&
    report.reviewChannelId &&
    report.reviewMessageId
      ? {
          channelId: report.reviewChannelId,
          messageId: report.reviewMessageId,
        }
      : null;
  const claim = storage.claimMemberReportDelivery(report.reportId, {
    expectedUpdatedAt: report.updatedAt,
  });
  if (claim.status !== "claimed") {
    throw new Error(
      claim.status === "busy"
        ? "Another report delivery operation is already in progress."
        : "Report delivery could not acquire a current persistent claim.",
    );
  }
  deliveryRecord = claim.record;
  try {
    const destination = await currentReportDestination(
      guild,
      storage,
      isCurrent,
      !allowDisabledRecovery,
    );
    if (!destination || destination.id !== channel.id) {
      throw new Error(
        "The configured private report destination is no longer verified.",
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
            "The prior report message could not be unambiguously retired.",
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
            "The prior report message could not be unambiguously verified.",
          );
        }
        if (tracked.status === "found") {
          message = tracked.message;
        } else {
          knownUnboundMessage = null;
        }
      }
    }
    const priorAttempt = storage.getMemberReportDeliveryAttempt(
      report.reportId,
    );
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
            "The prior report attempt could not be unambiguously retired.",
          );
        }
      } else if (recovered.status !== "missing") {
        throw new Error(
          "Report recovery could not prove a unique prior Discord delivery.",
        );
      }
      if (!message && priorAttempt.channelId !== destination.id) {
        previousAttemptId = priorAttempt.attemptId;
      }
    }
    if (!message) {
      const begun = storage.beginMemberReportDeliveryAttempt(report.reportId, {
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
          "Report delivery could not persist its pre-send attempt.",
        );
      }
      deliveryRecord = begun.record;
      durableAttemptActive = true;
      message = await destination.send({
        ...buildReportReviewPayload(deliveryRecord),
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
    const bound = storage.bindMemberReportDelivery(report.reportId, {
      reviewChannelId: destination.id,
      reviewMessageId: message.id,
      claimId: claim.claimId,
      expectedUpdatedAt: deliveryRecord.updatedAt,
    });
    if (bound.status !== "changed" && bound.status !== "unchanged") {
      throw new Error(
        "Report delivery checkpoint changed before it could be saved.",
      );
    }
    if (bound.report.reviewMessageId !== message.id) {
      throw new Error("Another operation already delivered this report.");
    }
    boundReport = bound.report;
    knownUnboundMessage = null;
    await message.edit(buildReportReviewPayload(bound.report));
    if (!isCurrent()) {
      throw new Error(
        "Report delivery was cancelled after its checkpoint was saved.",
      );
    }
    return { report: bound.report, message };
  } catch (error) {
    if (boundReport) {
      const retired = message ? await retireMessage(message) : true;
      if (retired) await markMissing(storage, boundReport, () => true);
    } else if (knownUnboundMessage) {
      const retired = message ? await retireMessage(message) : false;
      if (retired) {
        safeFailDelivery(
          storage,
          report.reportId,
          claim,
          isCurrent,
          deliveryRecord.updatedAt,
        );
      } else {
        checkpointOrphan(
          storage,
          report.reportId,
          knownUnboundMessage,
          claim.claimId,
          deliveryRecord.updatedAt,
          isCurrent()
            ? "orphan-delete-ambiguous"
            : "runtime-changed-orphan-delete-ambiguous",
        );
      }
    } else if (!durableAttemptActive) {
      safeFailDelivery(storage, report.reportId, claim, isCurrent);
    }
    throw error;
  }
}

export async function refreshReportReviewMessage(
  guild: Guild,
  report: MemberReport,
  storage: ReportDeliveryStorage,
  isCurrent: () => boolean = () => true,
): Promise<"updated" | "missing" | "unavailable"> {
  if (
    report.guildId !== guild.id ||
    !report.reviewChannelId ||
    !report.reviewMessageId
  )
    return "unavailable";
  if (!isCurrent()) return "unavailable";
  const destination = await currentReportDestination(
    guild,
    storage,
    isCurrent,
    false,
  );
  if (!destination) return "unavailable";
  if (report.reviewChannelId !== destination.id) {
    const retired = await retireTrackedMessage(
      guild,
      report.reviewChannelId,
      report.reviewMessageId,
    );
    return retired ? markMissing(storage, report, isCurrent) : "unavailable";
  }
  let message: Message;
  try {
    message = await destination.messages.fetch(report.reviewMessageId);
  } catch (error) {
    return isUnknownDiscordResource(error, 10_008)
      ? markMissing(storage, report, isCurrent)
      : "unavailable";
  }
  if (!message || message.author.id !== guild.client.user?.id) {
    return markMissing(storage, report, isCurrent);
  }
  const latest = storage.getMemberReportById(report.reportId);
  if (!latest || latest.guildId !== guild.id || !isCurrent())
    return "unavailable";
  try {
    await message.edit(buildReportReviewPayload(latest));
  } catch (error) {
    return isUnknownDiscordResource(error, 10_008)
      ? markMissing(storage, latest, isCurrent)
      : "unavailable";
  }
  return isCurrent() ? "updated" : "unavailable";
}

async function currentReportDestination(
  guild: Guild,
  storage: ReportDeliveryStorage,
  isCurrent: () => boolean,
  requireEnabled: boolean,
): Promise<TextChannel | null> {
  const configuration = storage.getModerationConfiguration();
  if (
    !configuration ||
    configuration.guildId !== guild.id ||
    !configuration.reportBindingsVerifiedAt ||
    !configuration.reportReviewChannelId ||
    (requireEnabled && !configuration.reportsEnabled) ||
    !isCurrent()
  ) {
    return null;
  }
  const resources = await inspectSafetyWorkflowResources(
    guild,
    configuration,
    "reports",
    storage,
  );
  if (
    !resources.reviewChannel ||
    resources.reviewChannel.id !== configuration.reportReviewChannelId ||
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
  storage: ReportDeliveryStorage,
  reportId: string,
  claim: Extract<DeliveryClaimResult<MemberReport>, { status: "claimed" }>,
  isCurrent: () => boolean,
  expectedUpdatedAt = claim.record.updatedAt,
): void {
  try {
    storage.failMemberReportDelivery(reportId, {
      failureCode: isCurrent() ? "discord-delivery-failed" : "runtime-changed",
      claimId: claim.claimId,
      expectedUpdatedAt,
    });
  } catch {
    // Preserve the delivery error; recovery can inspect the reservation.
  }
}

function checkpointOrphan(
  storage: ReportDeliveryStorage,
  reportId: string,
  known: { channelId: string; messageId: string },
  claimId: string,
  initialUpdatedAt: string,
  failureCode: string,
): boolean {
  let expectedUpdatedAt = initialUpdatedAt;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = storage.checkpointMemberReportDeliveryOrphan(reportId, {
        reviewChannelId: known.channelId,
        reviewMessageId: known.messageId,
        claimId,
        failureCode,
        expectedUpdatedAt,
      });
      if (result.status === "changed" || result.status === "unchanged") {
        return true;
      }
      const latest = storage.getMemberReportById(reportId);
      if (
        latest?.reviewChannelId === known.channelId &&
        latest.reviewMessageId === known.messageId &&
        (latest.deliveryState === "missing" ||
          latest.deliveryState === "posted")
      ) {
        return true;
      }
      if (!latest || latest.guildId !== result.report?.guildId) return false;
      expectedUpdatedAt = latest.updatedAt;
    } catch {
      return false;
    }
  }
  // Never release or overwrite a claim after an ambiguous retirement.
  return false;
}

async function markMissing(
  storage: ReportDeliveryStorage,
  report: MemberReport,
  isCurrent: () => boolean,
): Promise<"missing" | "unavailable"> {
  if (!isCurrent()) return "unavailable";
  const result = storage.markMemberReportDeliveryMissing(report.reportId, {
    expectedUpdatedAt: report.updatedAt,
  });
  return result.status === "changed" || result.status === "unchanged"
    ? "missing"
    : "unavailable";
}
