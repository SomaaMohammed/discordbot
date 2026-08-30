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
import {
  MEMBER_REPORT_CATEGORIES,
  type MemberReport,
  type ModerationCase,
} from "../types.js";
import {
  REPORT_CATEGORY_FIELD_ID,
  REPORT_COMPONENT_PREFIX,
  REPORT_DECISION_REASON_FIELD_ID,
  REPORT_EVIDENCE_FIELD_ID,
  REPORT_EXPLANATION_FIELD_ID,
  REPORT_LINKED_CASE_FIELD_ID,
  REPORT_TARGET_FIELD_ID,
  createReportDecisionModal,
  createReportSubmitModal,
  parseReportComponentId,
  reportDecisionProvenanceToken,
  reportLauncherMessageToken,
  reportVersionToken,
} from "./report-components.js";
import {
  authorizeReportReviewer,
  type ReportStorage,
} from "./report-commands-handler.js";
import {
  publishReservedReport,
  refreshReportReviewMessage,
} from "./report-delivery.js";
import { parseReportOpenCustomId } from "./panel-theme.js";
import { inspectSafetyWorkflowResources } from "./safety-permissions.js";
import { fetchGuildMemberCoalesced } from "./fetch-coalescing.js";

const SNOWFLAKE = /^\d{17,20}$/u;
const LINKABLE_REPORT_CASE_ACTIONS = new Set([
  "warning",
  "timeout",
  "kick",
  "ban",
  "automod-warning",
  "automod-timeout",
]);

export async function handleReportButton(
  interaction: ButtonInteraction,
  runtime: GuildRuntime,
): Promise<boolean> {
  if (!interaction.customId.startsWith(REPORT_COMPONENT_PREFIX)) return false;
  const panelId = parseReportOpenCustomId(interaction.customId);
  if (panelId) {
    if (!verifySafetyPanel(interaction, runtime, panelId)) {
      await replyPrivate(
        interaction,
        "This safety panel is outdated or unavailable.",
      );
      return true;
    }
    await interaction.showModal(
      createReportSubmitModal(panelId, null, interaction.message.id),
    );
    return true;
  }
  const parsed = parseReportComponentId(interaction.customId);
  if (!parsed || parsed.kind !== "control") {
    await replyPrivate(
      interaction,
      "This report control is invalid or outdated.",
    );
    return true;
  }
  const storage: ReportStorage = runtime.storage;
  const report = storage.getMemberReportById(parsed.reportId);
  const configuration = storage.getModerationConfiguration();
  if (
    !report ||
    !configuration?.reportBindingsVerifiedAt ||
    !validControl(interaction, runtime, report)
  ) {
    await replyPrivate(
      interaction,
      "This review control is stale or does not belong to that report.",
    );
    return true;
  }
  if (parsed.versionToken !== reportVersionToken(report.updatedAt)) {
    await replyPrivate(
      interaction,
      "This report control is stale. Refresh the tracked review message.",
    );
    return true;
  }
  const reviewer = await authorizeReportReviewer(
    interaction,
    runtime,
    configuration,
  );
  if (!reviewer) {
    await replyPrivate(
      interaction,
      "You are not authorized to review private reports.",
    );
    return true;
  }
  const resources = await inspectSafetyWorkflowResources(
    interaction.guild!,
    configuration,
    "reports",
    runtime.storage,
  );
  if (
    !resources.reviewChannel ||
    resources.issues.length > 0 ||
    resources.reviewChannel.id !== interaction.channelId ||
    configuration.reportReviewChannelId !== interaction.channelId
  ) {
    await replyPrivate(
      interaction,
      "The private report review boundary changed or is no longer safe.",
    );
    return true;
  }
  const target = await fetchReportDecisionTarget(
    interaction.guild!,
    report.targetUserId,
  );
  const currentConfiguration = storage.getModerationConfiguration();
  const currentReviewer = currentConfiguration
    ? await authorizeReportReviewer(interaction, runtime, currentConfiguration)
    : null;
  if (
    !isSafeDecisionTarget(target) ||
    !currentReviewer ||
    currentConfiguration?.updatedAt !== configuration.updatedAt ||
    !runtime.isCurrent()
  ) {
    await replyPrivate(
      interaction,
      "The target, reviewer authority, or private report binding changed during verification.",
    );
    return true;
  }
  if (parsed.action === "resolve" || parsed.action === "dismiss") {
    if (
      report.state !== "under-review" ||
      report.claimedBy !== currentReviewer.id
    ) {
      await replyPrivate(
        interaction,
        "Claim this pending report before recording its decision.",
      );
      return true;
    }
    await interaction.showModal(
      createReportDecisionModal(
        report.reportId,
        parsed.action,
        parsed.versionToken,
        interaction.message.id,
      ),
    );
    return true;
  }
  await deferPrivate(interaction);
  const current = storage.getMemberReportById(report.reportId);
  const finalConfiguration = storage.getModerationConfiguration();
  const [finalResources, finalTarget] = finalConfiguration
    ? await Promise.all([
        inspectSafetyWorkflowResources(
          interaction.guild!,
          finalConfiguration,
          "reports",
          runtime.storage,
        ),
        fetchReportDecisionTarget(interaction.guild!, report.targetUserId),
      ])
    : [null, null];
  const finalReviewer = finalConfiguration
    ? await authorizeReportReviewer(interaction, runtime, finalConfiguration)
    : null;
  if (
    !current ||
    !sameReportSnapshot(report, current) ||
    !finalConfiguration ||
    finalConfiguration.updatedAt !== configuration.updatedAt ||
    !finalReviewer ||
    finalReviewer.id !== currentReviewer.id ||
    !isSafeDecisionTarget(finalTarget) ||
    !finalResources?.reviewChannel ||
    finalResources.issues.length > 0 ||
    finalResources.reviewChannel.id !== interaction.channelId ||
    !runtime.isCurrent()
  ) {
    await replyPrivate(
      interaction,
      "This report changed while access was being verified. Try again.",
    );
    return true;
  }
  if (parsed.action === "info") {
    await replyPrivate(interaction, reviewerInfo(current));
    runtime.storage.recordCommandMetric("report.review.info");
    return true;
  }
  if (parsed.action === "release") {
    if (
      current.state !== "under-review" ||
      current.claimedBy !== finalReviewer.id
    ) {
      await replyPrivate(
        interaction,
        "Only the current authorized claimant can release this report.",
      );
      return true;
    }
    const released = storage.releaseMemberReportClaim(current.reportId, {
      actorId: finalReviewer.id,
      previousReviewerId: finalReviewer.id,
      reason: "Current claimant released the report for reassignment.",
      expectedUpdatedAt: current.updatedAt,
    });
    if (released.status !== "changed" && released.status !== "unchanged") {
      await replyPrivate(
        interaction,
        "The report changed before its claim could be released.",
      );
      return true;
    }
    await refreshReportReviewMessage(
      interaction.guild!,
      released.report,
      storage,
      runtime.isCurrent,
    );
    await replyPrivate(
      interaction,
      `Released your claim on report #${released.report.reportNumber}.`,
    );
    runtime.storage.recordCommandMetric("report.review.release");
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
      hasCurrentReviewAuthority(
        prior.member,
        finalConfiguration,
        "reports.review",
        runtime,
      )
    ) {
      await replyPrivate(
        interaction,
        "This report is still assigned to an authorized current reviewer.",
      );
      return true;
    }
    const takeoverConfiguration = storage.getModerationConfiguration();
    const takeoverReport = storage.getMemberReportById(current.reportId);
    const takeoverResources = takeoverConfiguration
      ? await inspectSafetyWorkflowResources(
          interaction.guild!,
          takeoverConfiguration,
          "reports",
          runtime.storage,
        )
      : null;
    const takeoverReviewer = takeoverConfiguration
      ? await authorizeReportReviewer(
          interaction,
          runtime,
          takeoverConfiguration,
        )
      : null;
    if (
      !takeoverConfiguration ||
      takeoverConfiguration.updatedAt !== finalConfiguration.updatedAt ||
      !takeoverReport ||
      !sameReportSnapshot(current, takeoverReport) ||
      takeoverReport.claimedBy !== current.claimedBy ||
      !takeoverReviewer ||
      takeoverReviewer.id !== finalReviewer.id ||
      !takeoverResources?.reviewChannel ||
      takeoverResources.reviewChannel.id !== interaction.channelId ||
      takeoverResources.issues.length > 0 ||
      !runtime.isCurrent()
    ) {
      await replyPrivate(
        interaction,
        "The report, reviewer authority, or private boundary changed before claim reassignment.",
      );
      return true;
    }
    result = storage.takeOverMemberReportClaim(current.reportId, {
      reviewerId: takeoverReviewer.id,
      previousReviewerId: current.claimedBy,
      reason:
        "Prior claimant is absent or no longer authorized to review reports.",
      expectedUpdatedAt: takeoverReport.updatedAt,
    });
  } else {
    result = storage.claimMemberReport(current.reportId, {
      reviewerId: finalReviewer.id,
      expectedUpdatedAt: current.updatedAt,
    });
  }
  if (result.status !== "changed" && result.status !== "unchanged") {
    await replyPrivate(
      interaction,
      "Another reviewer changed this report. Refresh and try again.",
    );
    return true;
  }
  await refreshReportReviewMessage(
    interaction.guild!,
    result.report,
    storage,
    runtime.isCurrent,
  );
  await replyPrivate(
    interaction,
    `Report #${result.report.reportNumber} is now claimed by you.`,
  );
  runtime.storage.recordCommandMetric("report.review.claim");
  return true;
}

export async function handleReportModal(
  interaction: ModalSubmitInteraction,
  runtime: GuildRuntime,
): Promise<boolean> {
  if (!interaction.customId.startsWith(REPORT_COMPONENT_PREFIX)) return false;
  const parsed = parseReportComponentId(interaction.customId);
  if (
    !parsed ||
    (parsed.kind !== "submit-modal" && parsed.kind !== "decision-modal")
  ) {
    await replyPrivate(interaction, "This report form is invalid or outdated.");
    return true;
  }
  const storage: ReportStorage = runtime.storage;
  await deferPrivate(interaction);
  if (parsed.kind === "submit-modal") {
    await submitReport(
      interaction,
      runtime,
      storage,
      parsed.panelId,
      parsed.targetUserId,
      parsed.sourceMessageToken,
    );
  } else {
    await decideReport(
      interaction,
      runtime,
      storage,
      parsed.reportId,
      parsed.decision,
      parsed.provenanceToken,
    );
  }
  return true;
}

async function submitReport(
  interaction: ModalSubmitInteraction,
  runtime: GuildRuntime,
  storage: ReportStorage,
  panelId: string,
  encodedTargetId: string | null,
  sourceMessageToken: string,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild || guild.id !== runtime.guildId) {
    await replyPrivate(
      interaction,
      "Reports must be submitted inside their server.",
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
    !configuration?.reportsEnabled ||
    !configuration.reportBindingsVerifiedAt ||
    configuration.guildId !== runtime.guildId
  ) {
    await replyPrivate(
      interaction,
      "Private reports are not currently available.",
    );
    return;
  }
  const resources = await inspectSafetyWorkflowResources(
    guild,
    configuration,
    "reports",
    runtime.storage,
  );
  if (!resources.reviewChannel || resources.issues.length > 0) {
    await replyPrivate(
      interaction,
      "Private reports need administrator attention before they can be submitted.",
    );
    return;
  }
  const reporter = await fetchMember(guild, interaction.user.id);
  const targetId =
    encodedTargetId ??
    normalizeId(interaction.fields.getTextInputValue(REPORT_TARGET_FIELD_ID));
  const target = targetId ? await fetchMember(guild, targetId) : null;
  if (
    !reporter ||
    reporter.user.bot ||
    !target ||
    target.user.bot ||
    target.id === reporter.id
  ) {
    await replyPrivate(
      interaction,
      "Choose another current, non-bot member in this server.",
    );
    return;
  }
  const category = interaction.fields
    .getTextInputValue(REPORT_CATEGORY_FIELD_ID)
    .normalize("NFKC")
    .trim()
    .toLowerCase();
  if (!(MEMBER_REPORT_CATEGORIES as readonly string[]).includes(category)) {
    await replyPrivate(
      interaction,
      "Category must be harassment, spam, scam, safety, or other.",
    );
    return;
  }
  const explanation = normalizeText(
    interaction.fields.getTextInputValue(REPORT_EXPLANATION_FIELD_ID),
    10,
    2_000,
  );
  if (!explanation) {
    await replyPrivate(interaction, "Give a 10-2000 character explanation.");
    return;
  }
  const evidenceRaw = interaction.fields
    .getTextInputValue(REPORT_EVIDENCE_FIELD_ID)
    .trim();
  const evidence = evidenceRaw
    ? parseEvidenceLink(evidenceRaw, guild.id)
    : null;
  if (evidenceRaw && !evidence) {
    await replyPrivate(
      interaction,
      "Evidence must be a Discord message link from this server.",
    );
    return;
  }
  if (evidence) {
    const evidenceChannel = await guild.channels
      .fetch(evidence.channelId, { cache: true, force: true })
      .catch(() => null);
    if (
      !evidenceChannel ||
      evidenceChannel.guild.id !== guild.id ||
      ![
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread,
      ].includes(evidenceChannel.type) ||
      !("messages" in evidenceChannel)
    ) {
      await replyPrivate(
        interaction,
        "That evidence message channel is unavailable.",
      );
      return;
    }
    const message = await evidenceChannel.messages
      .fetch(evidence.messageId)
      .catch(() => null);
    if (!message) {
      await replyPrivate(
        interaction,
        "That evidence message could not be verified.",
      );
      return;
    }
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server changed while the report was being verified. Try again.",
    );
    return;
  }
  const reservation = storage.reserveMemberReport({
    reporterId: reporter.id,
    targetUserId: target.id,
    category: category as (typeof MEMBER_REPORT_CATEGORIES)[number],
    explanation,
    evidenceGuildId: evidence ? guild.id : null,
    evidenceChannelId: evidence?.channelId ?? null,
    evidenceMessageId: evidence?.messageId ?? null,
  });
  if (reservation.status === "cooldown") {
    await replyPrivate(
      interaction,
      `You have reached the private-report cooldown. Try again <t:${Math.floor(Date.parse(reservation.retryAt) / 1_000)}:R>.`,
    );
    return;
  }
  if (reservation.status !== "created") {
    await replyPrivate(
      interaction,
      "Private reports were disabled before this submission was saved.",
    );
    return;
  }
  try {
    await publishReservedReport(
      guild,
      resources.reviewChannel,
      reservation.report,
      storage,
      runtime.isCurrent,
    );
    await replyPrivate(
      interaction,
      `Private report #${reservation.report.reportNumber} was submitted. Use \`/report status\` to track it.`,
    );
    runtime.storage.recordCommandMetric("report.submit");
  } catch {
    await replyPrivate(
      interaction,
      `Report #${reservation.report.reportNumber} was reserved safely, but staff delivery failed. An authorized reviewer can use \`/report recover\`.`,
    );
  }
}

async function decideReport(
  interaction: ModalSubmitInteraction,
  runtime: GuildRuntime,
  storage: ReportStorage,
  reportId: string,
  decision: "resolve" | "dismiss",
  provenanceToken: string,
): Promise<void> {
  const configuration = storage.getModerationConfiguration();
  const report = storage.getMemberReportById(reportId);
  if (
    !configuration?.reportBindingsVerifiedAt ||
    !report ||
    report.guildId !== runtime.guildId
  ) {
    await replyPrivate(interaction, "That report is no longer available.");
    return;
  }
  if (
    !report.reviewMessageId ||
    provenanceToken !==
      reportDecisionProvenanceToken(report.updatedAt, report.reviewMessageId) ||
    report.reviewChannelId !== interaction.channelId ||
    report.deliveryState !== "posted"
  ) {
    await replyPrivate(
      interaction,
      "This report decision form is stale or was not opened from the current tracked review message.",
    );
    return;
  }
  const reviewer = await authorizeReportReviewer(
    interaction,
    runtime,
    configuration,
  );
  if (
    !reviewer ||
    report.state !== "under-review" ||
    report.claimedBy !== reviewer.id
  ) {
    await replyPrivate(
      interaction,
      "You must remain the authorized claimant to decide this report.",
    );
    return;
  }
  const resources = await inspectSafetyWorkflowResources(
    interaction.guild!,
    configuration,
    "reports",
    runtime.storage,
  );
  if (
    !resources.reviewChannel ||
    resources.issues.length > 0 ||
    resources.reviewChannel.id !== interaction.channelId ||
    configuration.reportReviewChannelId !== interaction.channelId
  ) {
    await replyPrivate(
      interaction,
      "The private report review boundary changed or is no longer safe.",
    );
    return;
  }
  const target = await fetchReportDecisionTarget(
    interaction.guild!,
    report.targetUserId,
  );
  const currentConfiguration = storage.getModerationConfiguration();
  const currentReviewer = currentConfiguration
    ? await authorizeReportReviewer(interaction, runtime, currentConfiguration)
    : null;
  if (
    !isSafeDecisionTarget(target) ||
    !currentReviewer ||
    currentReviewer.id !== reviewer.id ||
    currentConfiguration?.updatedAt !== configuration.updatedAt ||
    !runtime.isCurrent()
  ) {
    await replyPrivate(
      interaction,
      "The target, reviewer authority, or private report binding changed during verification.",
    );
    return;
  }
  const reason = normalizeText(
    interaction.fields.getTextInputValue(REPORT_DECISION_REASON_FIELD_ID),
    1,
    500,
  );
  if (!reason) {
    await replyPrivate(interaction, "Give a short decision reason.");
    return;
  }
  const linkedRaw = interaction.fields
    .getTextInputValue(REPORT_LINKED_CASE_FIELD_ID)
    .trim();
  const linkedCase = /^\d{1,10}$/u.test(linkedRaw)
    ? storage.getModerationCaseByNumber(Number(linkedRaw))
    : null;
  if (linkedRaw && (!linkedCase || linkedCase.guildId !== runtime.guildId)) {
    await replyPrivate(
      interaction,
      "The linked moderation case number is invalid.",
    );
    return;
  }
  const linkIssue = linkedCase
    ? reportCaseLinkIssue(report, decision, linkedCase)
    : null;
  if (linkIssue) {
    await replyPrivate(interaction, linkIssue);
    return;
  }
  const finalConfiguration = storage.getModerationConfiguration();
  const finalReport = storage.getMemberReportById(report.reportId);
  const finalLinkedCase = linkedCase
    ? storage.getModerationCaseByNumber(linkedCase.caseNumber)
    : null;
  const [finalResources, finalTarget] = finalConfiguration
    ? await Promise.all([
        inspectSafetyWorkflowResources(
          interaction.guild!,
          finalConfiguration,
          "reports",
          runtime.storage,
        ),
        fetchReportDecisionTarget(interaction.guild!, report.targetUserId),
      ])
    : [null, null];
  const finalReviewer = finalConfiguration
    ? await authorizeReportReviewer(interaction, runtime, finalConfiguration)
    : null;
  if (
    !finalConfiguration ||
    finalConfiguration.updatedAt !== configuration.updatedAt ||
    !finalReport ||
    !sameReportSnapshot(report, finalReport) ||
    finalReport.state !== "under-review" ||
    !finalReviewer ||
    finalReviewer.id !== reviewer.id ||
    finalReport.claimedBy !== finalReviewer.id ||
    !isSafeDecisionTarget(finalTarget) ||
    !finalResources?.reviewChannel ||
    finalResources.issues.length > 0 ||
    finalResources.reviewChannel.id !== interaction.channelId ||
    (linkedCase !== null &&
      (!finalLinkedCase ||
        finalLinkedCase.updatedAt !== linkedCase.updatedAt ||
        reportCaseLinkIssue(finalReport, decision, finalLinkedCase) !==
          null)) ||
    !runtime.isCurrent()
  ) {
    await replyPrivate(
      interaction,
      "The report, linked case, reviewer authority, or private boundary changed during final verification.",
    );
    return;
  }
  const result = storage.decideMemberReport(report.reportId, {
    state: decision === "resolve" ? "resolved" : "dismissed",
    reviewerId: finalReviewer.id,
    reason,
    linkedCaseId: finalLinkedCase?.caseId ?? null,
    expectedUpdatedAt: finalReport.updatedAt,
  });
  if (result.status !== "changed" && result.status !== "unchanged") {
    await replyPrivate(
      interaction,
      "This report changed before the decision was saved. Refresh and try again.",
    );
    return;
  }
  await refreshReportReviewMessage(
    interaction.guild!,
    result.report,
    storage,
    runtime.isCurrent,
  );
  await replyPrivate(
    interaction,
    `Report #${result.report.reportNumber} is now **${result.report.state}**.`,
  );
  runtime.storage.recordCommandMetric(`report.review.${decision}`);
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
    ? sourceMessageToken === reportLauncherMessageToken(panel.messageId)
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
    sourceMessageToken !== reportLauncherMessageToken(panel.messageId) ||
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
  report: MemberReport,
): boolean {
  return (
    report.guildId === runtime.guildId &&
    report.reviewChannelId === interaction.channelId &&
    report.reviewMessageId === interaction.message.id &&
    interaction.message.author.id === interaction.client.user?.id &&
    runtime.isCurrent()
  );
}

function sameReportSnapshot(left: MemberReport, right: MemberReport): boolean {
  return (
    left.guildId === right.guildId &&
    left.reportId === right.reportId &&
    left.updatedAt === right.updatedAt &&
    left.reviewChannelId === right.reviewChannelId &&
    left.reviewMessageId === right.reviewMessageId
  );
}

function reviewerInfo(report: MemberReport): string {
  return [
    `**Private report #${report.reportNumber}**`,
    `Reporter: \`${report.reporterId}\``,
    `Target: \`${report.targetUserId}\``,
    `Category: **${report.category}**`,
    `State: **${report.state}**`,
    `Explanation: ${safePrivateDisplay(report.explanation)}`,
  ]
    .join("\n")
    .slice(0, 2_000);
}

function safePrivateDisplay(value: string): string {
  return escapeMarkdown(value)
    .replace(/@(everyone|here)/giu, "@\u200b$1")
    .replace(/<(@[!&]?|#)(\d{17,20})>/gu, "<$1\u200b$2>");
}

export function reportCaseLinkIssue(
  report: MemberReport,
  decision: "resolve" | "dismiss",
  linkedCase: ModerationCase,
): string | null {
  if (decision !== "resolve") {
    return "Dismissed reports cannot link a moderation case.";
  }
  if (linkedCase.targetUserId !== report.targetUserId) {
    return "The linked moderation case targets a different member.";
  }
  if (linkedCase.status !== "active" && linkedCase.status !== "completed") {
    return "Only a confirmed active or completed moderation case can resolve this report.";
  }
  if (!LINKABLE_REPORT_CASE_ACTIONS.has(linkedCase.actionType)) {
    return "The linked record is not a resulting warning or enforcement action.";
  }
  if (Date.parse(linkedCase.createdAt) < Date.parse(report.createdAt)) {
    return "The linked moderation case predates this report and cannot be its resulting action.";
  }
  return null;
}

function parseEvidenceLink(
  value: string,
  guildId: string,
): { channelId: string; messageId: string } | null {
  const match =
    /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})\/?$/u.exec(
      value,
    );
  return match?.[1] === guildId
    ? { channelId: match[2]!, messageId: match[3]! }
    : null;
}
function normalizeId(value: string): string | null {
  const normalized = value.trim();
  return SNOWFLAKE.test(normalized) ? normalized : null;
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
type ReportDecisionTarget =
  | { status: "member"; member: GuildMember }
  | { status: "departed" | "unavailable" };
async function fetchReportDecisionTarget(
  guild: NonNullable<ModalSubmitInteraction["guild"]>,
  id: string,
): Promise<ReportDecisionTarget> {
  try {
    const member = await guild.members.fetch({
      user: id,
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
function isSafeDecisionTarget(target: ReportDecisionTarget | null): boolean {
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
    const member = await guild.members.fetch({
      user: id,
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
function hasCurrentReviewAuthority(
  member: GuildMember,
  configuration: NonNullable<
    ReturnType<ReportStorage["getModerationConfiguration"]>
  >,
  capability: "reports.review",
  runtime: GuildRuntime,
): boolean {
  if (
    member.id === member.guild.ownerId ||
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    (configuration.reportReviewerRoleId &&
      member.roles.cache.has(configuration.reportReviewerRoleId))
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
      grant.capability === capability &&
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
