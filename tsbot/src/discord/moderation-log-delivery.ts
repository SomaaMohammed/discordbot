import {
  ChannelType,
  escapeMarkdown,
  type Guild,
  type Message,
  type MessageCreateOptions,
  type MessageEditOptions,
  type TextChannel,
} from "discord.js";
import type { GuildRuntime } from "../runtime.js";
import type {
  DeliveryClaimResult,
  DeliveryAttempt,
  DeliveryAttemptTransitionResult,
  ModerationCase,
  ModerationLogDelivery,
} from "../types.js";
import { safeDisplayText } from "./forms.js";
import { findBotMessageByAttempt } from "./delivery-nonce.js";
import {
  SAFE_PANEL_ALLOWED_MENTIONS,
  createSuperiorEmbed,
} from "./panel-theme.js";
import { inspectModerationLogChannel } from "./safety-permissions.js";
import { fetchGuildMemberCoalescedOrThrow } from "./fetch-coalescing.js";

interface ModerationLogStorage {
  getModerationConfiguration(): {
    guildId: string;
    moderationLogChannelId: string | null;
    moderationLogVerifiedAt: string | null;
  } | null;
  getModerationLogDelivery(caseId: string): ModerationLogDelivery | null;
  getModerationLogDeliveryAttempt(caseId: string): DeliveryAttempt | null;
  beginModerationLogDeliveryAttempt(
    caseId: string,
    input: {
      channelId: string;
      claimId: string;
      expectedUpdatedAt: string;
      previousAttemptId?: string;
    },
  ): DeliveryAttemptTransitionResult<ModerationLogDelivery>;
  claimModerationLogDelivery(
    caseId: string,
    input?: { expectedUpdatedAt?: string },
  ): DeliveryClaimResult<ModerationLogDelivery>;
  completeModerationLogDelivery(
    caseId: string,
    input: {
      channelId: string;
      messageId: string;
      claimId: string;
      expectedUpdatedAt?: string;
    },
  ): ModerationLogDelivery | null;
  failModerationLogDelivery(
    caseId: string,
    input: {
      failureCode: string;
      claimId?: string;
      expectedUpdatedAt?: string;
    },
  ): ModerationLogDelivery | null;
  checkpointModerationLogDeliveryOrphan(
    caseId: string,
    input: {
      channelId: string;
      messageId: string;
      claimId: string;
      failureCode: string;
      expectedUpdatedAt: string;
    },
  ):
    | {
        status: "changed" | "unchanged" | "conflict" | "unavailable";
        delivery: ModerationLogDelivery;
      }
    | { status: "not-found"; delivery: null };
  markModerationLogDeliveryMissing(
    caseId: string,
    input: { expectedUpdatedAt?: string },
  ): ModerationLogDelivery | null;
}

export type ModerationCaseLogDeliveryResult =
  "delivered" | "updated" | "disabled" | "unavailable" | "failed";

/**
 * Delivers or refreshes a moderation case log through the persistent delivery
 * checkpoint. It never trusts cached channel state and never posts a duplicate
 * while the tracked bot-authored message still exists.
 */
export async function deliverModerationCaseLog(
  guild: Guild,
  runtime: GuildRuntime,
  moderationCase: ModerationCase,
): Promise<ModerationCaseLogDeliveryResult> {
  if (
    guild.id !== runtime.guildId ||
    moderationCase.guildId !== runtime.guildId ||
    !runtime.isCurrent()
  ) {
    return "unavailable";
  }
  const storage: ModerationLogStorage = runtime.storage;
  const configuration = storage.getModerationConfiguration();
  if (
    !configuration ||
    configuration.guildId !== guild.id ||
    !configuration.moderationLogChannelId ||
    !configuration.moderationLogVerifiedAt
  ) {
    return "disabled";
  }
  let checkpoint = storage.getModerationLogDelivery(moderationCase.caseId);
  const resources = await inspectModerationLogChannel(
    guild,
    configuration.moderationLogChannelId,
  );
  if (
    !resources.channel ||
    resources.issues.length > 0 ||
    !runtime.isCurrent()
  ) {
    if (checkpoint?.state !== "delivered") {
      safeMarkFailed(storage, moderationCase.caseId, "log-binding-unavailable");
    }
    return "unavailable";
  }
  const displays = await resolveCaseDisplays(guild, moderationCase);
  if (!runtime.isCurrent()) return "unavailable";
  const payload = buildModerationCaseLogPayload(moderationCase, displays);
  if (
    checkpoint?.state === "delivered" &&
    checkpoint.channelId &&
    checkpoint.messageId &&
    checkpoint.channelId !== resources.channel.id
  ) {
    const retired = await retireTrackedMessage(
      guild,
      checkpoint.channelId,
      checkpoint.messageId,
      guild.client.user?.id ?? null,
    );
    if (!retired || !runtime.isCurrent()) return "unavailable";
    checkpoint = safeMarkMissing(storage, moderationCase.caseId);
    if (!checkpoint || checkpoint.state !== "missing") return "failed";
  }
  if (
    checkpoint?.state === "delivered" &&
    checkpoint.channelId === resources.channel.id &&
    checkpoint.messageId
  ) {
    const lookup = await fetchTrackedMessage(
      resources.channel,
      checkpoint.messageId,
      guild.client.user?.id ?? null,
    );
    if (lookup.status === "unavailable") return "unavailable";
    if (lookup.status === "found") {
      if (!runtime.isCurrent()) return "unavailable";
      try {
        await lookup.message.edit(payload);
        return runtime.isCurrent() ? "updated" : "unavailable";
      } catch (error) {
        if (!isUnknownDiscordResource(error, 10_008)) return "unavailable";
      }
    }
    checkpoint = safeMarkMissing(storage, moderationCase.caseId);
    if (!checkpoint || checkpoint.state !== "missing") return "failed";
  }

  let message: Message | null = null;
  let boundDelivery: ModerationLogDelivery | null = null;
  let deliveryRecord: ModerationLogDelivery;
  let durableAttemptActive = false;
  let knownUnboundMessage: { channelId: string; messageId: string } | null =
    null;
  const claim = storage.claimModerationLogDelivery(
    moderationCase.caseId,
    checkpoint ? { expectedUpdatedAt: checkpoint.updatedAt } : {},
  );
  if (claim.status !== "claimed") return "unavailable";
  deliveryRecord = claim.record;
  try {
    if (!runtime.isCurrent()) {
      safeMarkFailed(
        storage,
        moderationCase.caseId,
        "runtime-changed",
        claim.claimId,
      );
      return "unavailable";
    }
    if (
      claim.record.state === "missing" &&
      claim.record.channelId &&
      claim.record.messageId
    ) {
      knownUnboundMessage = {
        channelId: claim.record.channelId,
        messageId: claim.record.messageId,
      };
      if (claim.record.channelId !== resources.channel.id) {
        if (
          !(await retireTrackedMessage(
            guild,
            claim.record.channelId,
            claim.record.messageId,
            guild.client.user?.id ?? null,
          ))
        ) {
          throw new Error(
            "The prior moderation log message could not be unambiguously retired.",
          );
        }
        knownUnboundMessage = null;
      } else {
        const tracked = await fetchTrackedMessage(
          resources.channel,
          claim.record.messageId,
          guild.client.user?.id ?? null,
        );
        if (tracked.status === "unavailable") {
          throw new Error(
            "The prior moderation log message could not be unambiguously verified.",
          );
        }
        if (tracked.status === "found") {
          message = tracked.message;
        } else {
          knownUnboundMessage = null;
        }
      }
    }
    const priorAttempt = storage.getModerationLogDeliveryAttempt(
      moderationCase.caseId,
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
        if (priorAttempt.channelId === resources.channel.id) {
          message = recovered.message;
          knownUnboundMessage = {
            channelId: resources.channel.id,
            messageId: recovered.message.id,
          };
        } else if (!(await retireMessage(recovered.message))) {
          throw new Error(
            "The prior moderation log attempt could not be unambiguously retired.",
          );
        }
      } else if (recovered.status !== "missing") {
        throw new Error(
          "Moderation log recovery could not prove a unique prior Discord delivery.",
        );
      }
      if (!message && priorAttempt.channelId !== resources.channel.id) {
        previousAttemptId = priorAttempt.attemptId;
      }
    }
    if (!message) {
      const begun = storage.beginModerationLogDeliveryAttempt(
        moderationCase.caseId,
        {
          channelId: resources.channel.id,
          claimId: claim.claimId,
          expectedUpdatedAt: deliveryRecord.updatedAt,
          ...(previousAttemptId ? { previousAttemptId } : {}),
        },
      );
      if (
        (begun.status !== "changed" && begun.status !== "unchanged") ||
        !begun.record ||
        !begun.attempt ||
        begun.attempt.channelId !== resources.channel.id
      ) {
        throw new Error(
          "Moderation log delivery could not persist its pre-send attempt.",
        );
      }
      deliveryRecord = begun.record;
      durableAttemptActive = true;
      message = await resources.channel.send({
        ...payload,
        nonce: begun.attempt.attemptId,
        enforceNonce: true,
      });
      knownUnboundMessage = {
        channelId: resources.channel.id,
        messageId: message.id,
      };
    }
    const saved = storage.completeModerationLogDelivery(moderationCase.caseId, {
      channelId: resources.channel.id,
      messageId: message.id,
      claimId: claim.claimId,
      expectedUpdatedAt: deliveryRecord.updatedAt,
    });
    if (
      !saved ||
      saved.state !== "delivered" ||
      saved.messageId !== message.id
    ) {
      throw new Error("Moderation log delivery checkpoint conflicted.");
    }
    boundDelivery = saved;
    knownUnboundMessage = null;
    if (message.id === claim.record.messageId) await message.edit(payload);
    if (!runtime.isCurrent()) {
      throw new Error(
        "Moderation log delivery was cancelled after its checkpoint was saved.",
      );
    }
    return "delivered";
  } catch {
    if (boundDelivery) {
      const retired = message ? await retireMessage(message) : true;
      if (retired) safeMarkMissing(storage, moderationCase.caseId);
    } else if (knownUnboundMessage) {
      const retired = message ? await retireMessage(message) : false;
      if (retired) {
        safeFailClaim(
          storage,
          moderationCase.caseId,
          claim,
          runtime.isCurrent() ? "discord-delivery-failed" : "runtime-changed",
          deliveryRecord.updatedAt,
        );
      } else {
        checkpointOrphan(
          storage,
          moderationCase.caseId,
          knownUnboundMessage,
          claim.claimId,
          deliveryRecord.updatedAt,
          runtime.isCurrent()
            ? "orphan-delete-ambiguous"
            : "runtime-changed-orphan-delete-ambiguous",
        );
      }
    } else if (!durableAttemptActive) {
      safeFailClaim(
        storage,
        moderationCase.caseId,
        claim,
        runtime.isCurrent() ? "discord-delivery-failed" : "runtime-changed",
      );
    }
    return runtime.isCurrent() ? "failed" : "unavailable";
  }
}

export function buildModerationCaseLogPayload(
  moderationCase: ModerationCase,
  displays: { target: string | null; actor: string | null } = {
    target: null,
    actor: null,
  },
): MessageCreateOptions & MessageEditOptions {
  const embed = createSuperiorEmbed()
    .setTitle(`Moderation Case #${moderationCase.caseNumber}`)
    .setDescription(
      escapeMarkdown(safeDisplayText(moderationCase.publicReason, 2_000)),
    )
    .addFields(
      {
        name: "Target",
        value: `${safeCaseDisplay(displays.target)}\n\`${moderationCase.targetUserId}\``,
        inline: true,
      },
      {
        name: "Actor",
        value: `${safeCaseDisplay(displays.actor)}\n\`${moderationCase.actorId}\``,
        inline: true,
      },
      {
        name: "Action",
        value: safeDisplayText(moderationCase.actionType, 100),
        inline: true,
      },
      {
        name: "Status",
        value: safeDisplayText(moderationCase.status, 100),
        inline: true,
      },
      {
        name: "Source",
        value: safeDisplayText(moderationCase.source, 100),
        inline: true,
      },
      {
        name: "Created",
        value: `<t:${toUnixSeconds(moderationCase.createdAt)}:F>`,
        inline: true,
      },
    );
  if (moderationCase.relatedCaseId) {
    embed.addFields({
      name: "Related case ID",
      value: `\`${moderationCase.relatedCaseId}\``,
    });
  }
  return { embeds: [embed], allowedMentions: SAFE_PANEL_ALLOWED_MENTIONS };
}

async function resolveCaseDisplays(
  guild: Guild,
  moderationCase: ModerationCase,
): Promise<{ target: string | null; actor: string | null }> {
  const resolve = async (userId: string): Promise<string | null> => {
    let member = null;
    try {
      member = await fetchGuildMemberCoalescedOrThrow(guild, userId, {
        cache: true,
        force: true,
      });
    } catch {
      // Fall through to the current user profile when the member is absent.
    }
    if (member?.guild.id === guild.id) return member.displayName;
    let user = null;
    try {
      user = await guild.client.users.fetch(userId);
    } catch {
      // Deleted/unavailable users keep their stable IDs in the public log.
    }
    return user ? (user.globalName ?? user.username) : null;
  };
  const [target, actor] = await Promise.all([
    resolve(moderationCase.targetUserId),
    resolve(moderationCase.actorId),
  ]);
  return { target, actor };
}

function safeCaseDisplay(value: string | null): string {
  return value
    ? escapeMarkdown(safeDisplayText(value, 100))
    : "*Display unavailable*";
}

async function fetchTrackedMessage(
  channel: TextChannel,
  messageId: string,
  botUserId: string | null,
): Promise<
  { status: "found"; message: Message } | { status: "missing" | "unavailable" }
> {
  if (channel.type !== ChannelType.GuildText || !botUserId) {
    return { status: "unavailable" };
  }
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

async function retireTrackedMessage(
  guild: Guild,
  channelId: string,
  messageId: string,
  botUserId: string | null,
): Promise<boolean> {
  if (!botUserId) return false;
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
  if (message.author.id !== botUserId) return true;
  try {
    await message.delete();
    return true;
  } catch (error) {
    return isUnknownDiscordResource(error, 10_008);
  }
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

function safeMarkFailed(
  storage: ModerationLogStorage,
  caseId: string,
  failureCode: string,
  claimId?: string,
): void {
  try {
    const checkpoint = storage.getModerationLogDelivery(caseId);
    storage.failModerationLogDelivery(caseId, {
      failureCode,
      ...(claimId ? { claimId } : {}),
      ...(checkpoint ? { expectedUpdatedAt: checkpoint.updatedAt } : {}),
    });
  } catch {
    // The original checkpoint remains recoverable.
  }
}

function safeFailClaim(
  storage: ModerationLogStorage,
  caseId: string,
  claim: Extract<
    DeliveryClaimResult<ModerationLogDelivery>,
    { status: "claimed" }
  >,
  failureCode: string,
  expectedUpdatedAt = claim.record.updatedAt,
): void {
  try {
    storage.failModerationLogDelivery(caseId, {
      failureCode,
      claimId: claim.claimId,
      expectedUpdatedAt,
    });
  } catch {
    // The persistent claim remains available for bounded recovery.
  }
}

function checkpointOrphan(
  storage: ModerationLogStorage,
  caseId: string,
  known: { channelId: string; messageId: string },
  claimId: string,
  initialUpdatedAt: string,
  failureCode: string,
): boolean {
  let expectedUpdatedAt = initialUpdatedAt;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = storage.checkpointModerationLogDeliveryOrphan(caseId, {
        channelId: known.channelId,
        messageId: known.messageId,
        claimId,
        failureCode,
        expectedUpdatedAt,
      });
      if (result.status === "changed" || result.status === "unchanged") {
        return true;
      }
      const latest = storage.getModerationLogDelivery(caseId);
      if (
        latest?.channelId === known.channelId &&
        latest.messageId === known.messageId &&
        (latest.state === "missing" || latest.state === "delivered")
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

function safeMarkMissing(
  storage: ModerationLogStorage,
  caseId: string,
): ModerationLogDelivery | null {
  try {
    const checkpoint = storage.getModerationLogDelivery(caseId);
    return storage.markModerationLogDeliveryMissing(caseId, {
      ...(checkpoint ? { expectedUpdatedAt: checkpoint.updatedAt } : {}),
    });
  } catch {
    // Recovery will retry the tracked delivery.
    return null;
  }
}

function toUnixSeconds(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : 0;
}
