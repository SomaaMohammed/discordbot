import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  escapeMarkdown,
  type ButtonInteraction,
  type GuildMember,
  type ModalSubmitInteraction,
} from "discord.js";
import type { GuildRuntime } from "../runtime.js";
import type { CaseAppeal, ModerationCase } from "../types.js";
import {
  APPEAL_CASE_FIELD_ID,
  APPEAL_COMPONENT_PREFIX,
  APPEAL_DECISION_REASON_FIELD_ID,
  APPEAL_EXPLANATION_FIELD_ID,
  createAppealDecisionModal,
  createAppealSubmitModal,
  parseAppealComponentId,
  appealDecisionProvenanceToken,
  appealLauncherMessageToken,
  appealVersionToken,
} from "./appeal-components.js";
import {
  authorizeAppealReviewer,
  type AppealStorage,
} from "./appeal-commands-handler.js";
import {
  publishReservedAppeal,
  refreshAppealReviewMessage,
} from "./appeal-delivery.js";
import { deliverModerationCaseLog } from "./moderation-log-delivery.js";
import { parseAppealOpenCustomId } from "./panel-theme.js";
import { inspectSafetyWorkflowResources } from "./safety-permissions.js";
import { KeyedSerialQueue } from "./keyed-serial-queue.js";
import { runModerationTargetAction } from "./moderation-action-queue.js";
import {
  fetchCurrentBotMember,
  fetchGuildMemberCoalesced,
  fetchGuildMemberCoalescedOrThrow,
} from "./fetch-coalescing.js";

const ELIGIBLE_ACTIONS = new Set(["warning", "timeout", "kick", "ban"]);
const SAFE_OVERTURN_PUBLIC_REASON =
  "Case overturned after authorized appeal review.";
const appealDecisionQueue = new KeyedSerialQueue();

export async function handleAppealButton(
  interaction: ButtonInteraction,
  runtime: GuildRuntime,
): Promise<boolean> {
  if (!interaction.customId.startsWith(APPEAL_COMPONENT_PREFIX)) return false;
  const panelId = parseAppealOpenCustomId(interaction.customId);
  if (panelId) {
    if (!verifySafetyPanel(interaction, runtime, panelId)) {
      await replyPrivate(
        interaction,
        "This safety panel is outdated or unavailable.",
      );
      return true;
    }
    await interaction.showModal(
      createAppealSubmitModal(panelId, null, interaction.message.id),
    );
    return true;
  }
  const parsed = parseAppealComponentId(interaction.customId);
  if (!parsed || parsed.kind !== "control") {
    await replyPrivate(
      interaction,
      "This appeal control is invalid or outdated.",
    );
    return true;
  }
  const storage: AppealStorage = runtime.storage;
  const appeal = storage.getCaseAppealById(parsed.appealId);
  const moderationCase = appeal
    ? storage.getModerationCaseById(appeal.caseId)
    : null;
  const configuration = storage.getModerationConfiguration();
  if (
    !appeal ||
    !moderationCase ||
    !configuration?.appealBindingsVerifiedAt ||
    !validControl(interaction, runtime, appeal)
  ) {
    await replyPrivate(
      interaction,
      "This review control is stale or does not belong to that appeal.",
    );
    return true;
  }
  const target = await fetchAppealReviewTarget(
    interaction.guild!,
    moderationCase.targetUserId,
  );
  const currentConfiguration = storage.getModerationConfiguration();
  const currentReviewer = currentConfiguration
    ? await authorizeAppealReviewer(interaction, runtime, currentConfiguration)
    : null;
  if (
    !isSafeAppealReviewTarget(target) ||
    !currentReviewer ||
    currentConfiguration?.updatedAt !== configuration.updatedAt ||
    !runtime.isCurrent()
  ) {
    await replyPrivate(
      interaction,
      "The target, reviewer authority, or private appeal binding changed during verification.",
    );
    return true;
  }
  if (parsed.versionToken !== appealVersionToken(appeal.updatedAt)) {
    await replyPrivate(
      interaction,
      "This appeal control is stale. Refresh the tracked review message.",
    );
    return true;
  }
  const reviewer = await authorizeAppealReviewer(
    interaction,
    runtime,
    configuration,
  );
  if (!reviewer) {
    await replyPrivate(
      interaction,
      "You are not authorized to review case appeals.",
    );
    return true;
  }
  const resources = await inspectSafetyWorkflowResources(
    interaction.guild!,
    configuration,
    "appeals",
    runtime.storage,
  );
  if (
    !resources.reviewChannel ||
    resources.issues.length > 0 ||
    resources.reviewChannel.id !== interaction.channelId ||
    configuration.appealReviewChannelId !== interaction.channelId
  ) {
    await replyPrivate(
      interaction,
      "The private appeal review boundary changed or is no longer safe.",
    );
    return true;
  }
  if (parsed.action === "uphold" || parsed.action === "overturn") {
    if (
      appeal.state !== "under-review" ||
      appeal.claimedBy !== currentReviewer.id
    ) {
      await replyPrivate(
        interaction,
        "Claim this pending appeal before recording its decision.",
      );
      return true;
    }
    await interaction.showModal(
      createAppealDecisionModal(
        appeal.appealId,
        parsed.action,
        parsed.versionToken,
        interaction.message.id,
      ),
    );
    return true;
  }
  await deferPrivate(interaction);
  const current = storage.getCaseAppealById(appeal.appealId);
  const finalConfiguration = storage.getModerationConfiguration();
  const [finalResources, finalTarget] = finalConfiguration
    ? await Promise.all([
        inspectSafetyWorkflowResources(
          interaction.guild!,
          finalConfiguration,
          "appeals",
          runtime.storage,
        ),
        fetchAppealReviewTarget(
          interaction.guild!,
          moderationCase.targetUserId,
        ),
      ])
    : [null, null];
  const finalReviewer = finalConfiguration
    ? await authorizeAppealReviewer(interaction, runtime, finalConfiguration)
    : null;
  if (
    !current ||
    !sameSnapshot(appeal, current) ||
    !finalConfiguration ||
    finalConfiguration.updatedAt !== configuration.updatedAt ||
    !finalReviewer ||
    finalReviewer.id !== currentReviewer.id ||
    !isSafeAppealReviewTarget(finalTarget) ||
    !finalResources?.reviewChannel ||
    finalResources.reviewChannel.id !== interaction.channelId ||
    finalResources.issues.length > 0 ||
    !runtime.isCurrent()
  ) {
    await replyPrivate(
      interaction,
      "This appeal changed while access was being verified. Try again.",
    );
    return true;
  }
  if (parsed.action === "info") {
    await replyPrivate(interaction, reviewerInfo(current, moderationCase));
    runtime.storage.recordCommandMetric("appeal.review.info");
    return true;
  }
  if (parsed.action === "release") {
    if (
      current.state !== "under-review" ||
      current.claimedBy !== finalReviewer.id
    ) {
      await replyPrivate(
        interaction,
        "Only the current authorized claimant can release this appeal.",
      );
      return true;
    }
    const released = storage.releaseCaseAppealClaim(current.appealId, {
      actorId: finalReviewer.id,
      previousReviewerId: finalReviewer.id,
      reason: "Current claimant released the appeal for reassignment.",
      expectedUpdatedAt: current.updatedAt,
    });
    if (released.status !== "changed" && released.status !== "unchanged") {
      await replyPrivate(
        interaction,
        "The appeal changed before its claim could be released.",
      );
      return true;
    }
    await refreshAppealReviewMessage(
      interaction.guild!,
      released.appeal,
      moderationCase,
      storage,
      runtime.isCurrent,
    );
    await replyPrivate(
      interaction,
      `Released your claim on appeal #${released.appeal.appealNumber}.`,
    );
    runtime.storage.recordCommandMetric("appeal.review.release");
    return true;
  }
  let result;
  if (
    current.state === "under-review" &&
    current.claimedBy &&
    current.claimedBy !== finalReviewer.id
  ) {
    const prior = await fetchMemberForClaimRecovery(
      interaction.guild!,
      current.claimedBy,
    );
    if (prior.status === "unavailable") {
      await replyPrivate(
        interaction,
        "Superior could not prove whether the current claimant still has access, so the claim was not reassigned.",
      );
      return true;
    }
    if (
      prior.status === "member" &&
      hasCurrentAppealReviewAuthority(prior.member, finalConfiguration, runtime)
    ) {
      await replyPrivate(
        interaction,
        "This appeal is still assigned to an authorized current reviewer.",
      );
      return true;
    }
    const takeoverConfiguration = storage.getModerationConfiguration();
    const takeoverAppeal = storage.getCaseAppealById(current.appealId);
    const takeoverResources = takeoverConfiguration
      ? await inspectSafetyWorkflowResources(
          interaction.guild!,
          takeoverConfiguration,
          "appeals",
          runtime.storage,
        )
      : null;
    const takeoverReviewer = takeoverConfiguration
      ? await authorizeAppealReviewer(
          interaction,
          runtime,
          takeoverConfiguration,
        )
      : null;
    if (
      !takeoverConfiguration ||
      takeoverConfiguration.updatedAt !== finalConfiguration.updatedAt ||
      !takeoverAppeal ||
      !sameSnapshot(current, takeoverAppeal) ||
      takeoverAppeal.claimedBy !== current.claimedBy ||
      !takeoverReviewer ||
      takeoverReviewer.id !== finalReviewer.id ||
      !takeoverResources?.reviewChannel ||
      takeoverResources.reviewChannel.id !== interaction.channelId ||
      takeoverResources.issues.length > 0 ||
      !runtime.isCurrent()
    ) {
      await replyPrivate(
        interaction,
        "The appeal, reviewer authority, or private boundary changed before claim reassignment.",
      );
      return true;
    }
    result = storage.takeOverCaseAppealClaim(current.appealId, {
      reviewerId: takeoverReviewer.id,
      previousReviewerId: current.claimedBy,
      reason:
        "Prior claimant is absent or no longer authorized to review appeals.",
      expectedUpdatedAt: takeoverAppeal.updatedAt,
    });
  } else {
    result = storage.claimCaseAppeal(current.appealId, {
      reviewerId: finalReviewer.id,
      expectedUpdatedAt: current.updatedAt,
    });
  }
  if (result.status !== "changed" && result.status !== "unchanged") {
    await replyPrivate(
      interaction,
      "Another reviewer changed this appeal. Refresh and try again.",
    );
    return true;
  }
  await refreshAppealReviewMessage(
    interaction.guild!,
    result.appeal,
    moderationCase,
    storage,
    runtime.isCurrent,
  );
  await replyPrivate(
    interaction,
    `Appeal #${result.appeal.appealNumber} is now claimed by you.`,
  );
  runtime.storage.recordCommandMetric("appeal.review.claim");
  return true;
}

export async function handleAppealModal(
  interaction: ModalSubmitInteraction,
  runtime: GuildRuntime,
): Promise<boolean> {
  if (!interaction.customId.startsWith(APPEAL_COMPONENT_PREFIX)) return false;
  const parsed = parseAppealComponentId(interaction.customId);
  if (
    !parsed ||
    (parsed.kind !== "submit-modal" && parsed.kind !== "decision-modal")
  ) {
    await replyPrivate(interaction, "This appeal form is invalid or outdated.");
    return true;
  }
  const storage: AppealStorage = runtime.storage;
  await deferPrivate(interaction);
  if (parsed.kind === "submit-modal") {
    await submitAppeal(
      interaction,
      runtime,
      storage,
      parsed.panelId,
      parsed.caseNumber,
      parsed.sourceMessageToken,
    );
  } else {
    await appealDecisionQueue.run(`${runtime.guildId}:${parsed.appealId}`, () =>
      decideAppeal(
        interaction,
        runtime,
        storage,
        parsed.appealId,
        parsed.decision,
        parsed.provenanceToken,
      ),
    );
  }
  return true;
}

async function submitAppeal(
  interaction: ModalSubmitInteraction,
  runtime: GuildRuntime,
  storage: AppealStorage,
  panelId: string,
  encodedCaseNumber: number | null,
  sourceMessageToken: string,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild || guild.id !== runtime.guildId) {
    await replyPrivate(
      interaction,
      "Appeals must be submitted inside their server.",
    );
    return;
  }
  if (
    panelId === "command"
      ? sourceMessageToken !== "command"
      : !(await verifySafetyPanelSubmission(
          interaction,
          runtime,
          panelId,
          sourceMessageToken,
        ))
  ) {
    await replyPrivate(
      interaction,
      "This safety panel is outdated. Open a fresh form.",
    );
    return;
  }
  const configuration = storage.getModerationConfiguration();
  if (
    !configuration?.appealsEnabled ||
    !configuration.appealBindingsVerifiedAt
  ) {
    await replyPrivate(
      interaction,
      "Case appeals are not currently available.",
    );
    return;
  }
  const resources = await inspectSafetyWorkflowResources(
    guild,
    configuration,
    "appeals",
    runtime.storage,
  );
  if (!resources.reviewChannel || resources.issues.length > 0) {
    await replyPrivate(
      interaction,
      "Case appeals need administrator attention before they can be submitted.",
    );
    return;
  }
  const member = await fetchMember(guild, interaction.user.id);
  const caseNumber =
    encodedCaseNumber ??
    parseCaseNumber(interaction.fields.getTextInputValue(APPEAL_CASE_FIELD_ID));
  let moderationCase = caseNumber
    ? storage.getModerationCaseByNumber(caseNumber)
    : null;
  if (
    !member ||
    member.user.bot ||
    !moderationCase ||
    moderationCase.guildId !== runtime.guildId ||
    moderationCase.targetUserId !== member.id
  ) {
    await replyPrivate(
      interaction,
      "That case is not eligible for an appeal by your account.",
    );
    return;
  }
  if (
    moderationCase.actionType === "timeout" &&
    moderationCase.status === "active"
  ) {
    const storedExpiry = timeoutExpiry(moderationCase);
    const liveExpiry = member.isCommunicationDisabled()
      ? (member.communicationDisabledUntil?.getTime() ?? null)
      : null;
    const observedAt = new Date().toISOString();
    const botUserId = guild.client.user?.id ?? null;
    if (
      botUserId &&
      storedExpiry !== null &&
      storedExpiry <= Date.parse(observedAt) &&
      (liveExpiry === null || Math.abs(liveExpiry - storedExpiry) > 2_000)
    ) {
      const completed = storage.completeExpiredTimeoutCase(
        moderationCase.caseId,
        {
          actorId: botUserId,
          observedAt,
          expectedUpdatedAt: moderationCase.updatedAt,
        },
      );
      if (
        (completed.status === "changed" || completed.status === "unchanged") &&
        completed.case
      ) {
        moderationCase = completed.case;
      }
    }
  }
  if (
    !ELIGIBLE_ACTIONS.has(moderationCase.actionType) ||
    (moderationCase.actionType === "timeout" &&
      moderationCase.status !== "active") ||
    moderationCase.status === "voided" ||
    moderationCase.status === "overturned" ||
    moderationCase.status === "failed"
  ) {
    await replyPrivate(
      interaction,
      "That case type or state is not eligible for an appeal.",
    );
    return;
  }
  if (moderationCase.actionType === "timeout") {
    const storedExpiry = timeoutExpiry(moderationCase);
    const liveExpiry = member.communicationDisabledUntil?.getTime() ?? null;
    if (
      !member.isCommunicationDisabled() ||
      storedExpiry === null ||
      liveExpiry === null ||
      liveExpiry !== storedExpiry
    ) {
      await replyPrivate(
        interaction,
        "That timeout is no longer actively confirmed with the exact stored expiry, so it cannot enter an unrecoverable appeal state.",
      );
      return;
    }
  }
  const explanation = normalizeText(
    interaction.fields.getTextInputValue(APPEAL_EXPLANATION_FIELD_ID),
    10,
    2_000,
  );
  if (!explanation) {
    await replyPrivate(
      interaction,
      "Give a 10-2000 character appeal explanation.",
    );
    return;
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server changed while the appeal was being verified. Try again.",
    );
    return;
  }
  const reservation = storage.reserveCaseAppeal({
    caseId: moderationCase.caseId,
    appellantId: member.id,
    explanation,
  });
  if (reservation.status === "existing") {
    await replyPrivate(
      interaction,
      "Only one appeal may be submitted for each moderation case.",
    );
    return;
  }
  if (reservation.status !== "created") {
    await replyPrivate(
      interaction,
      "That case is no longer eligible or appeals were disabled.",
    );
    return;
  }
  try {
    await publishReservedAppeal(
      guild,
      resources.reviewChannel,
      reservation.appeal,
      moderationCase,
      storage,
      runtime.isCurrent,
    );
    await replyPrivate(
      interaction,
      `Appeal #${reservation.appeal.appealNumber} was submitted privately. Use \`/appeal status\` to track it.`,
    );
    runtime.storage.recordCommandMetric("appeal.submit");
  } catch {
    await replyPrivate(
      interaction,
      `Appeal #${reservation.appeal.appealNumber} was reserved safely, but staff delivery failed. An authorized reviewer can recover it.`,
    );
  }
}

async function decideAppeal(
  interaction: ModalSubmitInteraction,
  runtime: GuildRuntime,
  storage: AppealStorage,
  appealId: string,
  decision: "uphold" | "overturn",
  provenanceToken: string,
): Promise<void> {
  const guild = interaction.guild;
  const configuration = storage.getModerationConfiguration();
  const appeal = storage.getCaseAppealById(appealId);
  const moderationCase = appeal
    ? storage.getModerationCaseById(appeal.caseId)
    : null;
  if (
    !guild ||
    !configuration?.appealBindingsVerifiedAt ||
    !appeal ||
    !moderationCase
  ) {
    await replyPrivate(interaction, "That appeal is no longer available.");
    return;
  }
  if (
    !appeal.reviewMessageId ||
    provenanceToken !==
      appealDecisionProvenanceToken(appeal.updatedAt, appeal.reviewMessageId) ||
    appeal.reviewChannelId !== interaction.channelId ||
    appeal.deliveryState !== "posted"
  ) {
    await replyPrivate(
      interaction,
      "This appeal decision form is stale or was not opened from the current tracked review message.",
    );
    return;
  }
  const resources = await inspectSafetyWorkflowResources(
    guild,
    configuration,
    "appeals",
    runtime.storage,
  );
  if (
    !resources.reviewChannel ||
    resources.issues.length > 0 ||
    resources.reviewChannel.id !== interaction.channelId ||
    configuration.appealReviewChannelId !== interaction.channelId
  ) {
    await replyPrivate(
      interaction,
      "The private appeal review boundary changed or is no longer safe.",
    );
    return;
  }
  const verifiedReviewChannelId = resources.reviewChannel.id;
  const reviewer = await authorizeAppealReviewer(
    interaction,
    runtime,
    configuration,
  );
  if (
    !reviewer ||
    appeal.state !== "under-review" ||
    appeal.claimedBy !== reviewer.id
  ) {
    await replyPrivate(
      interaction,
      "You must remain the authorized claimant to decide this appeal.",
    );
    return;
  }
  const target = await fetchAppealReviewTarget(
    guild,
    moderationCase.targetUserId,
  );
  const currentConfiguration = storage.getModerationConfiguration();
  const currentReviewer = currentConfiguration
    ? await authorizeAppealReviewer(interaction, runtime, currentConfiguration)
    : null;
  if (
    !isSafeAppealReviewTarget(target) ||
    !currentReviewer ||
    currentReviewer.id !== reviewer.id ||
    currentConfiguration?.updatedAt !== configuration.updatedAt ||
    !runtime.isCurrent()
  ) {
    await replyPrivate(
      interaction,
      "The target, reviewer authority, or private appeal binding changed during verification.",
    );
    return;
  }
  const reason = normalizeText(
    interaction.fields.getTextInputValue(APPEAL_DECISION_REASON_FIELD_ID),
    1,
    500,
  );
  if (!reason) {
    await replyPrivate(interaction, "Give a short appeal decision reason.");
    return;
  }
  const finalReviewer = await freshAppealMutationBoundary(
    guild,
    runtime,
    storage,
    reviewer.id,
    configuration.updatedAt,
    interaction.channelId,
  );
  const finalAppeal = storage.getCaseAppealById(appeal.appealId);
  const finalCase = storage.getModerationCaseById(moderationCase.caseId);
  if (
    !finalReviewer ||
    !finalAppeal ||
    !sameSnapshot(appeal, finalAppeal) ||
    finalAppeal.state !== "under-review" ||
    finalAppeal.claimedBy !== finalReviewer.id ||
    !finalCase ||
    finalCase.updatedAt !== moderationCase.updatedAt
  ) {
    await replyPrivate(
      interaction,
      "The appeal, case, reviewer authority, or private boundary changed at the final decision boundary.",
    );
    return;
  }
  let decidedAppeal: CaseAppeal;
  let decidedCase = finalCase;
  if (decision === "overturn") {
    const reversal = await runModerationTargetAction(
      runtime.guildId,
      finalCase.targetUserId,
      () =>
        applyOverturn(
          guild,
          runtime,
          storage,
          finalReviewer,
          finalAppeal,
          finalCase,
          configuration.updatedAt,
          verifiedReviewChannelId,
          reason,
        ),
    );
    if (!reversal.ok) {
      await replyPrivate(interaction, reversal.message);
      return;
    }
    decidedAppeal = reversal.appeal;
    decidedCase = reversal.originalCase;
  } else {
    const result = storage.decideCaseAppeal(finalAppeal.appealId, {
      state: "upheld",
      reviewerId: finalReviewer.id,
      reason,
      reversalCaseId: null,
      expectedUpdatedAt: finalAppeal.updatedAt,
    });
    if (result.status !== "changed" && result.status !== "unchanged") {
      await replyPrivate(
        interaction,
        "This appeal changed before the decision was saved. Recovery is required before retrying.",
      );
      return;
    }
    decidedAppeal = result.appeal;
  }
  await refreshAppealReviewMessage(
    guild,
    decidedAppeal,
    decidedCase,
    storage,
    runtime.isCurrent,
  );
  await notifyAppellant(guild, decidedAppeal);
  await replyPrivate(
    interaction,
    `Appeal #${decidedAppeal.appealNumber} is now **${decidedAppeal.state}**.`,
  );
  runtime.storage.recordCommandMetric(`appeal.review.${decision}`);
}

async function applyOverturn(
  guild: NonNullable<ModalSubmitInteraction["guild"]>,
  runtime: GuildRuntime,
  storage: AppealStorage,
  reviewer: GuildMember,
  appeal: CaseAppeal,
  moderationCase: ModerationCase,
  expectedConfigurationUpdatedAt: string,
  expectedReviewChannelId: string,
  reason: string,
): Promise<
  | {
      ok: true;
      appeal: CaseAppeal;
      originalCase: ModerationCase;
      reversalCase: ModerationCase | null;
    }
  | { ok: false; message: string }
> {
  if (moderationCase.actionType === "timeout") {
    if (moderationCase.status !== "active") {
      return {
        ok: false,
        message:
          "Only the currently active timeout case can be reversed by an appeal.",
      };
    }
    const activeTimeout = storage.findUniqueActiveModerationCase(
      moderationCase.targetUserId,
      ["timeout", "automod-timeout"],
    );
    if (
      activeTimeout.status !== "found" ||
      activeTimeout.case.caseId !== moderationCase.caseId
    ) {
      return {
        ok: false,
        message:
          "A newer active timeout case exists for this member, so this appeal cannot safely clear the current timeout.",
      };
    }
    const [target, botMember] = await Promise.all([
      fetchMember(guild, moderationCase.targetUserId),
      fetchCurrentBotMember(guild, { force: true }),
    ]);
    if (
      !target ||
      !botMember ||
      target.id === guild.ownerId ||
      !target.moderatable
    ) {
      return {
        ok: false,
        message:
          "Superior cannot safely remove this timeout with current membership or hierarchy.",
      };
    }
    if (
      reviewer.id !== guild.ownerId &&
      !reviewer.permissions.has(PermissionFlagsBits.Administrator) &&
      reviewer.roles.highest.comparePositionTo(target.roles.highest) <= 0
    ) {
      return {
        ok: false,
        message:
          "Your current role hierarchy is not high enough to reverse this timeout.",
      };
    }
    if (!botMember.permissions.has(PermissionFlagsBits.ModerateMembers)) {
      return {
        ok: false,
        message: "Superior currently lacks Moderate Members.",
      };
    }
    if (!target.isCommunicationDisabled()) {
      const failedLookup = storage.findUniqueFailedModerationCase(
        moderationCase.targetUserId,
        ["timeout-removed"],
        {
          relatedCaseId: moderationCase.caseId,
          sources: ["appeal-review"],
        },
      );
      const recoverable =
        failedLookup.status === "found"
          ? findRecoverableTimeoutRemoval(
              [failedLookup.case],
              moderationCase,
              appeal,
            )
          : {
              status:
                failedLookup.status === "ambiguous"
                  ? ("ambiguous" as const)
                  : ("none" as const),
            };
      if (recoverable.status !== "unique") {
        return {
          ok: false,
          message:
            recoverable.status === "none"
              ? "This timeout is already absent, but no unique reserved appeal-removal attempt proves which authorized action removed it. Recover or record that action first."
              : "This timeout is already absent and multiple reserved removal attempts exist. Resolve the ambiguous attempts before deciding the appeal.",
        };
      }
      const boundaryReviewer = await freshAppealMutationBoundary(
        guild,
        runtime,
        storage,
        reviewer.id,
        expectedConfigurationUpdatedAt,
        expectedReviewChannelId,
      );
      if (!boundaryReviewer) {
        return {
          ok: false,
          message:
            "Reviewer authority or the private appeal boundary changed before the reserved removal could be reconciled.",
        };
      }
      const attempt = recoverable.attempt;
      const finalized = storage.finalizeTimeoutAppealOverturn(
        appeal.appealId,
        attempt.caseId,
        {
          reviewerId: boundaryReviewer.id,
          decisionReason: reason,
          caseReason: SAFE_OVERTURN_PUBLIC_REASON,
          discordActionMetadata: { originalCaseId: moderationCase.caseId },
          appealExpectedUpdatedAt: appeal.updatedAt,
          removalExpectedUpdatedAt: attempt.updatedAt,
          originalExpectedUpdatedAt: moderationCase.updatedAt,
        },
      );
      if (finalized.status !== "changed" && finalized.status !== "unchanged") {
        return {
          ok: false,
          message:
            "The reserved timeout-removal attempt could not be atomically reconciled with the appeal and original case.",
        };
      }
      if (!finalized.reversalCase) {
        return {
          ok: false,
          message:
            "The atomic appeal checkpoint is missing its timeout-removal case.",
        };
      }
      await deliverModerationCaseLog(guild, runtime, finalized.reversalCase);
      await deliverModerationCaseLog(guild, runtime, finalized.originalCase);
      return {
        ok: true,
        appeal: finalized.appeal,
        originalCase: finalized.originalCase,
        reversalCase: finalized.reversalCase,
      };
    }
    const expectedExpiry = timeoutExpiry(moderationCase);
    const currentExpiry = target.communicationDisabledUntil?.getTime() ?? null;
    if (
      expectedExpiry === null ||
      currentExpiry === null ||
      Math.abs(expectedExpiry - currentExpiry) > 2_000
    ) {
      return {
        ok: false,
        message:
          "The current Discord timeout does not match this case's confirmed expiry metadata, so Superior will not clear it ambiguously.",
      };
    }
    const boundaryReviewer = await freshAppealMutationBoundary(
      guild,
      runtime,
      storage,
      reviewer.id,
      expectedConfigurationUpdatedAt,
      expectedReviewChannelId,
    );
    if (!boundaryReviewer) {
      return {
        ok: false,
        message:
          "Reviewer authority or the private appeal boundary changed before timeout removal.",
      };
    }
    const terminalConfiguration = storage.getModerationConfiguration();
    const terminalReviewer = terminalConfiguration
      ? await authorizeAppealReviewer(
          { guild, user: { id: boundaryReviewer.id } },
          runtime,
          terminalConfiguration,
        )
      : null;
    const [actionTarget, actionBot] = await Promise.all([
      fetchMember(guild, target.id),
      fetchCurrentBotMember(guild, { force: true }),
    ]);
    if (
      !actionTarget ||
      !actionBot ||
      !terminalReviewer ||
      terminalReviewer.id !== boundaryReviewer.id ||
      terminalConfiguration?.updatedAt !== expectedConfigurationUpdatedAt ||
      !actionTarget.isCommunicationDisabled() ||
      actionTarget.communicationDisabledUntil?.getTime() !== expectedExpiry ||
      actionTarget.id === guild.ownerId ||
      !actionTarget.moderatable ||
      !actionBot.permissions.has(PermissionFlagsBits.ModerateMembers) ||
      actionBot.roles.highest.comparePositionTo(actionTarget.roles.highest) <=
        0 ||
      (terminalReviewer.id !== guild.ownerId &&
        !terminalReviewer.permissions.has(PermissionFlagsBits.Administrator) &&
        terminalReviewer.roles.highest.comparePositionTo(
          actionTarget.roles.highest,
        ) <= 0) ||
      !runtime.isCurrent()
    ) {
      return {
        ok: false,
        message:
          "Target, bot, reviewer authority, or timeout state changed at the final reversal boundary.",
      };
    }
    const attempt = storage.reserveModerationCaseAttempt({
      targetUserId: actionTarget.id,
      actorId: terminalReviewer.id,
      actionType: "timeout-removed",
      source: "appeal-review",
      publicReason: SAFE_OVERTURN_PUBLIC_REASON,
      privateNote: null,
      discordActionMetadata: {
        appealId: appeal.appealId,
        originalCaseId: moderationCase.caseId,
        originalExpiresAt: new Date(expectedExpiry).toISOString(),
      },
      relatedCaseId: moderationCase.caseId,
    });
    try {
      await actionTarget.timeout(
        null,
        `Authorized appeal overturn by ${terminalReviewer.id}`,
      );
    } catch {
      storage.failModerationCaseAttempt(attempt.caseId, {
        actorId: terminalReviewer.id,
        failureCode: "discord-timeout-removal-failed",
        expectedUpdatedAt: attempt.updatedAt,
      });
      return {
        ok: false,
        message:
          "Discord rejected timeout removal; the appeal was not overturned and the failed attempt was retained explicitly.",
      };
    }
    const refreshed = await fetchMember(guild, target.id);
    if (!refreshed || refreshed.isCommunicationDisabled()) {
      storage.failModerationCaseAttempt(attempt.caseId, {
        actorId: terminalReviewer.id,
        failureCode: "timeout-removal-not-confirmed",
        expectedUpdatedAt: attempt.updatedAt,
      });
      return {
        ok: false,
        message:
          "Discord did not confirm that the timeout was removed; the appeal was not overturned.",
      };
    }
    const checkpoint = storage.checkpointTimeoutAppealRemoval(
      appeal.appealId,
      attempt.caseId,
      {
        reviewerId: terminalReviewer.id,
        originalExpiresAt: new Date(expectedExpiry).toISOString(),
        discordActionMetadata: {
          originalCaseId: moderationCase.caseId,
          targetUserId: moderationCase.targetUserId,
        },
        appealExpectedUpdatedAt: appeal.updatedAt,
        removalExpectedUpdatedAt: attempt.updatedAt,
        originalExpectedUpdatedAt: moderationCase.updatedAt,
      },
    );
    if (checkpoint.status !== "changed" && checkpoint.status !== "unchanged") {
      return {
        ok: false,
        message:
          "Discord confirmed timeout removal, but Superior could not persist its correlated recovery checkpoint. Do not retry the Discord action; inspect the failed case attempt.",
      };
    }
    const finalBoundaryReviewer = await freshAppealMutationBoundary(
      guild,
      runtime,
      storage,
      boundaryReviewer.id,
      expectedConfigurationUpdatedAt,
      expectedReviewChannelId,
    );
    const checkpointedAppeal = storage.getCaseAppealById(appeal.appealId);
    const checkpointedOriginal = storage.getModerationCaseById(
      moderationCase.caseId,
    );
    const checkpointedRemoval = storage.getModerationCaseById(attempt.caseId);
    if (
      !finalBoundaryReviewer ||
      !checkpointedAppeal ||
      checkpointedAppeal.updatedAt !== checkpoint.appeal.updatedAt ||
      !checkpointedOriginal ||
      checkpointedOriginal.updatedAt !== checkpoint.originalCase.updatedAt ||
      !checkpointedRemoval ||
      checkpointedRemoval.updatedAt !== checkpoint.removalCase.updatedAt
    ) {
      return {
        ok: false,
        message:
          "The timeout removal is durably checkpointed, but reviewer authority or linked records changed before atomic appeal finalization. Retry the appeal decision to recover it.",
      };
    }
    const finalized = storage.finalizeTimeoutAppealOverturn(
      checkpointedAppeal.appealId,
      checkpointedRemoval.caseId,
      {
        reviewerId: finalBoundaryReviewer.id,
        decisionReason: reason,
        caseReason: SAFE_OVERTURN_PUBLIC_REASON,
        discordActionMetadata: {
          appealId: checkpointedAppeal.appealId,
          originalCaseId: checkpointedOriginal.caseId,
          originalExpiresAt: new Date(expectedExpiry).toISOString(),
        },
        appealExpectedUpdatedAt: checkpointedAppeal.updatedAt,
        removalExpectedUpdatedAt: checkpointedRemoval.updatedAt,
        originalExpectedUpdatedAt: checkpointedOriginal.updatedAt,
      },
    );
    if (finalized.status !== "changed" && finalized.status !== "unchanged") {
      return {
        ok: false,
        message:
          "Discord confirmed timeout removal, but the atomic case reversal needs persistence recovery before deciding the appeal.",
      };
    }
    const reversalCase = finalized.reversalCase;
    if (!reversalCase) {
      return {
        ok: false,
        message:
          "Discord confirmed timeout removal, but the reversal case checkpoint is unavailable for recovery.",
      };
    }
    if (!runtime.isCurrent())
      return {
        ok: false,
        message:
          "Server configuration changed after the timeout was removed. The atomic reversal was retained for recovery.",
      };
    await deliverModerationCaseLog(guild, runtime, reversalCase);
    await deliverModerationCaseLog(guild, runtime, finalized.originalCase);
    return {
      ok: true,
      appeal: finalized.appeal,
      originalCase: finalized.originalCase,
      reversalCase,
    };
  }
  if (moderationCase.actionType === "ban") {
    let currentBan;
    try {
      currentBan = await guild.bans.fetch(moderationCase.targetUserId);
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (code !== 10_026) {
        return {
          ok: false,
          message:
            "Superior could not verify the current ban state, so the appeal was not overturned.",
        };
      }
      currentBan = null;
    }
    if (currentBan) {
      return {
        ok: false,
        message:
          "The user is still banned. Use an authorized unban action first; this appeal cannot claim a reversal.",
      };
    }
    const linkedUnbanCandidate = moderationCase.relatedCaseId
      ? storage.getModerationCaseById(moderationCase.relatedCaseId)
      : null;
    const linkedUnban = findLinkedConfirmedUnban(
      linkedUnbanCandidate ? [linkedUnbanCandidate] : [],
      moderationCase,
    );
    if (!linkedUnban) {
      return {
        ok: false,
        message:
          "Discord shows no active ban, but no confirmed authorized unban case is linked to this ban. Record or recover that unban before overturning the appeal.",
      };
    }
    if (
      !(await freshAppealMutationBoundary(
        guild,
        runtime,
        storage,
        reviewer.id,
        expectedConfigurationUpdatedAt,
        expectedReviewChannelId,
      ))
    ) {
      return {
        ok: false,
        message:
          "Reviewer authority or the private appeal boundary changed before the ban case could be overturned.",
      };
    }
    const finalized = storage.finalizeCaseAppealOverturn(appeal.appealId, {
      reviewerId: reviewer.id,
      decisionReason: reason,
      caseReason: SAFE_OVERTURN_PUBLIC_REASON,
      reversalCaseId: linkedUnban.caseId,
      appealExpectedUpdatedAt: appeal.updatedAt,
      originalExpectedUpdatedAt: moderationCase.updatedAt,
    });
    if (finalized.status !== "changed" && finalized.status !== "unchanged") {
      return {
        ok: false,
        message:
          "The ban case or appeal changed before the authorized unban could be linked atomically.",
      };
    }
    await deliverModerationCaseLog(guild, runtime, finalized.originalCase);
    return {
      ok: true,
      appeal: finalized.appeal,
      originalCase: finalized.originalCase,
      reversalCase: finalized.reversalCase,
    };
  }
  if (
    !(await freshAppealMutationBoundary(
      guild,
      runtime,
      storage,
      reviewer.id,
      expectedConfigurationUpdatedAt,
      expectedReviewChannelId,
    ))
  ) {
    return {
      ok: false,
      message:
        "Reviewer authority or the private appeal boundary changed before the case could be overturned.",
    };
  }
  const finalized = storage.finalizeCaseAppealOverturn(appeal.appealId, {
    reviewerId: reviewer.id,
    decisionReason: reason,
    caseReason: SAFE_OVERTURN_PUBLIC_REASON,
    appealExpectedUpdatedAt: appeal.updatedAt,
    originalExpectedUpdatedAt: moderationCase.updatedAt,
  });
  if (finalized.status !== "changed" && finalized.status !== "unchanged") {
    return {
      ok: false,
      message:
        "The moderation case changed before it could be marked overturned.",
    };
  }
  await deliverModerationCaseLog(guild, runtime, finalized.originalCase);
  return {
    ok: true,
    appeal: finalized.appeal,
    originalCase: finalized.originalCase,
    reversalCase: finalized.reversalCase,
  };
}

async function freshAppealMutationBoundary(
  guild: NonNullable<ModalSubmitInteraction["guild"]>,
  runtime: GuildRuntime,
  storage: AppealStorage,
  reviewerId: string,
  expectedConfigurationUpdatedAt: string,
  expectedReviewChannelId: string,
): Promise<GuildMember | null> {
  const configuration = storage.getModerationConfiguration();
  if (
    !configuration?.appealBindingsVerifiedAt ||
    configuration.updatedAt !== expectedConfigurationUpdatedAt ||
    configuration.appealReviewChannelId !== expectedReviewChannelId ||
    !runtime.isCurrent()
  ) {
    return null;
  }
  const resources = await inspectSafetyWorkflowResources(
    guild,
    configuration,
    "appeals",
    runtime.storage,
  );
  const authorized = await authorizeAppealReviewer(
    { guild, user: { id: reviewerId } },
    runtime,
    configuration,
  );
  return authorized &&
    authorized.id === reviewerId &&
    resources.reviewChannel?.id === expectedReviewChannelId &&
    resources.issues.length === 0 &&
    runtime.isCurrent()
    ? authorized
    : null;
}

export function findRecoverableTimeoutRemoval(
  candidates: readonly ModerationCase[],
  originalCase: ModerationCase,
  appeal: CaseAppeal,
):
  | { status: "none" | "ambiguous"; attempt: null }
  | { status: "unique"; attempt: ModerationCase } {
  const originalExpiresAt = timeoutExpiry(originalCase);
  const matching = candidates.filter((candidate) => {
    const proof = timeoutAppealRecoveryProof(candidate);
    return (
      originalExpiresAt !== null &&
      candidate.guildId === originalCase.guildId &&
      candidate.targetUserId === originalCase.targetUserId &&
      candidate.status === "failed" &&
      candidate.actionType === "timeout-removed" &&
      candidate.source === "appeal-review" &&
      candidate.relatedCaseId === originalCase.caseId &&
      proof?.appealId === appeal.appealId &&
      proof.originalCaseId === originalCase.caseId &&
      proof.reviewerId === candidate.actorId &&
      Date.parse(proof.originalExpiresAt) === originalExpiresAt &&
      Date.parse(candidate.createdAt) >= Date.parse(appeal.createdAt)
    );
  });
  return matching.length === 1
    ? { status: "unique", attempt: matching[0]! }
    : { status: matching.length === 0 ? "none" : "ambiguous", attempt: null };
}

function timeoutAppealRecoveryProof(moderationCase: ModerationCase): {
  appealId: string;
  originalCaseId: string;
  originalExpiresAt: string;
  reviewerId: string;
} | null {
  const metadata = moderationCase.discordActionMetadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const proof = (metadata as { recoveryCheckpoint?: unknown })
    .recoveryCheckpoint;
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return null;
  const value = proof as Record<string, unknown>;
  return value.kind === "timeout-appeal-removal-confirmed" &&
    typeof value.appealId === "string" &&
    typeof value.originalCaseId === "string" &&
    typeof value.originalExpiresAt === "string" &&
    Number.isFinite(Date.parse(value.originalExpiresAt)) &&
    typeof value.reviewerId === "string"
    ? {
        appealId: value.appealId,
        originalCaseId: value.originalCaseId,
        originalExpiresAt: value.originalExpiresAt,
        reviewerId: value.reviewerId,
      }
    : null;
}

export function findLinkedConfirmedUnban(
  candidates: readonly ModerationCase[],
  originalBan: ModerationCase,
): ModerationCase | null {
  return (
    candidates.find(
      (candidate) =>
        candidate.guildId === originalBan.guildId &&
        candidate.targetUserId === originalBan.targetUserId &&
        candidate.status === "completed" &&
        candidate.actionType === "unban" &&
        candidate.relatedCaseId === originalBan.caseId &&
        Date.parse(candidate.createdAt) >= Date.parse(originalBan.createdAt),
    ) ?? null
  );
}

function verifySafetyPanel(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  runtime: GuildRuntime,
  panelId: string,
  sourceMessageToken?: string,
): boolean {
  const panel = runtime.storage.findPostedPanelByToken(panelId);
  if (
    !panel ||
    panel.preset !== "safety" ||
    panel.channelId !== interaction.channelId ||
    !runtime.isCurrent()
  )
    return false;
  return interaction.isModalSubmit()
    ? sourceMessageToken === appealLauncherMessageToken(panel.messageId)
    : panel.messageId === interaction.message.id &&
        interaction.message.author.id === interaction.client.user?.id;
}
async function verifySafetyPanelSubmission(
  interaction: ModalSubmitInteraction,
  runtime: GuildRuntime,
  panelId: string,
  sourceMessageToken: string,
): Promise<boolean> {
  const panel = runtime.storage.findPostedPanelByToken(panelId);
  if (
    !panel ||
    panel.preset !== "safety" ||
    panel.channelId !== interaction.channelId ||
    sourceMessageToken !== appealLauncherMessageToken(panel.messageId) ||
    !runtime.isCurrent()
  ) {
    return false;
  }
  const channel = await interaction
    .guild!.channels.fetch(panel.channelId, { cache: true, force: true })
    .catch(() => null);
  if (
    !channel ||
    (channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement) ||
    channel.guild.id !== runtime.guildId
  ) {
    return false;
  }
  const message = await channel.messages
    .fetch(panel.messageId)
    .catch(() => null);
  return Boolean(
    message &&
    message.author.id === interaction.client.user?.id &&
    runtime.isCurrent(),
  );
}
function validControl(
  interaction: ButtonInteraction,
  runtime: GuildRuntime,
  appeal: CaseAppeal,
): boolean {
  return (
    appeal.guildId === runtime.guildId &&
    appeal.reviewChannelId === interaction.channelId &&
    appeal.reviewMessageId === interaction.message.id &&
    interaction.message.author.id === interaction.client.user?.id &&
    runtime.isCurrent()
  );
}
function sameSnapshot(left: CaseAppeal, right: CaseAppeal): boolean {
  return (
    left.guildId === right.guildId &&
    left.appealId === right.appealId &&
    left.updatedAt === right.updatedAt &&
    left.reviewChannelId === right.reviewChannelId &&
    left.reviewMessageId === right.reviewMessageId
  );
}
function reviewerInfo(
  appeal: CaseAppeal,
  moderationCase: ModerationCase,
): string {
  return [
    `**Case appeal #${appeal.appealNumber}**`,
    `Appellant: \`${appeal.appellantId}\``,
    `Case: #${moderationCase.caseNumber} (${moderationCase.actionType})`,
    `State: **${appeal.state}**`,
    `Original public reason: ${safePrivateDisplay(moderationCase.publicReason)}`,
    `Appeal: ${safePrivateDisplay(appeal.explanation)}`,
  ]
    .join("\n")
    .slice(0, 2_000);
}
function safePrivateDisplay(value: string): string {
  return escapeMarkdown(value)
    .replace(/@(everyone|here)/giu, "@\u200b$1")
    .replace(/<(@[!&]?|#)(\d{17,20})>/gu, "<$1\u200b$2>");
}
async function notifyAppellant(
  guild: NonNullable<ModalSubmitInteraction["guild"]>,
  appeal: CaseAppeal,
): Promise<void> {
  const user = await guild.client.users
    .fetch(appeal.appellantId)
    .catch(() => null);
  if (!user || user.bot) return;
  await user
    .send({
      content: `Your case appeal #${appeal.appealNumber} is now **${appeal.state}**.`,
      allowedMentions: { parse: [] },
    })
    .catch(() => undefined);
}
function parseCaseNumber(value: string): number | null {
  const normalized = value.trim();
  if (!/^\d{1,10}$/u.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 2_147_483_647
    ? parsed
    : null;
}
function timeoutExpiry(moderationCase: ModerationCase): number | null {
  if (
    !moderationCase.discordActionMetadata ||
    typeof moderationCase.discordActionMetadata !== "object"
  )
    return null;
  const value = (
    moderationCase.discordActionMetadata as { expiresAt?: unknown }
  ).expiresAt;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function normalizeText(value: string, min: number, max: number): string | null {
  const normalized = value.normalize("NFKC").replace(/\r\n?/gu, "\n").trim();
  return normalized.length >= min &&
    normalized.length <= max &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)
    ? normalized
    : null;
}
async function fetchMember(
  guild: NonNullable<ModalSubmitInteraction["guild"]>,
  id: string,
): Promise<GuildMember | null> {
  return fetchGuildMemberCoalesced(guild, id, {
    cache: true,
    force: true,
  });
}
type AppealReviewTarget =
  | { status: "member"; member: GuildMember }
  | { status: "departed" | "unavailable" };
async function fetchAppealReviewTarget(
  guild: NonNullable<ModalSubmitInteraction["guild"]>,
  id: string,
): Promise<AppealReviewTarget> {
  try {
    const member = await fetchGuildMemberCoalescedOrThrow(guild, id, {
      cache: true,
      force: true,
    });
    return member.guild.id === guild.id
      ? { status: "member", member }
      : { status: "unavailable" };
  } catch (error) {
    return Number((error as { code?: unknown })?.code) === 10_007
      ? { status: "departed" }
      : { status: "unavailable" };
  }
}
function isSafeAppealReviewTarget(target: AppealReviewTarget | null): boolean {
  return Boolean(
    target &&
    (target.status === "departed" ||
      (target.status === "member" && !target.member.user.bot)),
  );
}
async function fetchMemberForClaimRecovery(
  guild: NonNullable<ModalSubmitInteraction["guild"]>,
  id: string,
): Promise<
  | { status: "member"; member: GuildMember }
  | { status: "absent" | "unavailable"; member: null }
> {
  try {
    const member = await fetchGuildMemberCoalescedOrThrow(guild, id, {
      cache: true,
      force: true,
    });
    return member.guild.id === guild.id
      ? { status: "member", member }
      : { status: "unavailable", member: null };
  } catch (error) {
    return (error as { code?: unknown })?.code === 10_007
      ? { status: "absent", member: null }
      : { status: "unavailable", member: null };
  }
}
function hasCurrentAppealReviewAuthority(
  member: GuildMember,
  configuration: NonNullable<
    ReturnType<AppealStorage["getModerationConfiguration"]>
  >,
  runtime: GuildRuntime,
): boolean {
  if (
    member.id === member.guild.ownerId ||
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    (configuration.appealReviewerRoleId &&
      member.roles.cache.has(configuration.appealReviewerRoleId))
  ) {
    return true;
  }
  const grants = runtime.storage.listCapabilitiesForRoles([
    ...member.roles.cache.keys(),
  ]);
  return grants.some(
    (grant) =>
      grant.active &&
      grant.guildId === runtime.guildId &&
      grant.capability === "appeals.review" &&
      member.roles.cache.has(grant.roleId),
  );
}
async function deferPrivate(
  interaction: ButtonInteraction | ModalSubmitInteraction,
): Promise<void> {
  if (!interaction.deferred && !interaction.replied)
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
}
async function replyPrivate(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  content: string,
): Promise<void> {
  if (interaction.deferred && !interaction.replied)
    await interaction.editReply({ content, allowedMentions: { parse: [] } });
  else if (interaction.replied)
    await interaction.followUp({
      content,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  else
    await interaction.reply({
      content,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
}
