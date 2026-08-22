import {
  MessageFlags,
  escapeMarkdown,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
} from "discord.js";
import type { GuildRuntime } from "../runtime.js";
import type {
  MemberReport,
  MemberReportDecisionInput,
  MemberReportReservationInput,
  MemberReportReservationResult,
  MemberReportState,
  MemberReportTransitionResult,
  ModerationCase,
  ModerationConfiguration,
} from "../types.js";
import { authorizeConfiguredRoleOrCapability } from "./authorization.js";
import { createReportSubmitModal } from "./report-components.js";
import {
  publishReservedReport,
  refreshReportReviewMessage,
  type ReportDeliveryStorage,
} from "./report-delivery.js";
import { inspectSafetyWorkflowResources } from "./safety-permissions.js";

export interface ReportStorage extends ReportDeliveryStorage {
  getModerationConfiguration(): ModerationConfiguration | null;
  reserveMemberReport(
    input: MemberReportReservationInput,
  ): MemberReportReservationResult;
  getMemberReportByNumber(reportNumber: number): MemberReport | null;
  listMemberReports(filter?: {
    reporterId?: string;
    targetUserId?: string;
    states?: readonly MemberReportState[];
    limit?: number;
    offset?: number;
  }): MemberReport[];
  claimMemberReport(
    reportId: string,
    input: { reviewerId: string; expectedUpdatedAt?: string },
  ): MemberReportTransitionResult;
  takeOverMemberReportClaim(
    reportId: string,
    input: {
      reviewerId: string;
      previousReviewerId: string;
      reason: string;
      expectedUpdatedAt: string;
    },
  ): MemberReportTransitionResult;
  releaseMemberReportClaim(
    reportId: string,
    input: {
      actorId: string;
      previousReviewerId: string;
      reason: string;
      expectedUpdatedAt: string;
    },
  ): MemberReportTransitionResult;
  decideMemberReport(
    reportId: string,
    input: MemberReportDecisionInput,
  ): MemberReportTransitionResult;
  withdrawMemberReport(
    reportId: string,
    input: { reporterId: string; expectedUpdatedAt?: string },
  ): MemberReportTransitionResult;
  getModerationCaseByNumber(caseNumber: number): ModerationCase | null;
}

export async function handleReportCommand(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const storage: ReportStorage = runtime.storage;
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "submit") {
    if (!interaction.deferred && !interaction.replied) {
      const member = interaction.options.getUser("member", true);
      await interaction.showModal(
        createReportSubmitModal("command", member.id),
      );
    }
    return;
  }
  await deferPrivate(interaction);
  if (subcommand === "status") {
    await showStatus(interaction, runtime, storage);
  } else if (subcommand === "withdraw") {
    await withdrawReport(interaction, runtime, storage);
  } else if (subcommand === "recover") {
    await recoverReport(interaction, runtime, storage);
  } else {
    await replyPrivate(interaction, "Choose a supported report action.");
  }
}

export async function authorizeReportReviewer(
  interaction: {
    guild: ChatInputCommandInteraction["guild"];
    user: { id: string };
  },
  runtime: GuildRuntime,
  configuration: ModerationConfiguration,
): Promise<GuildMember | null> {
  const guild = interaction.guild;
  if (!guild || guild.id !== runtime.guildId) return null;
  const decision = await authorizeConfiguredRoleOrCapability({
    guild,
    userId: interaction.user.id,
    capability: "reports.review",
    configuredRoleId: configuration.reportReviewerRoleId,
    configuredRoleReason: "reviewer-role",
    grants: runtime.storage,
  });
  return decision.allowed ? decision.member : null;
}

async function showStatus(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: ReportStorage,
): Promise<void> {
  const reportNumber = interaction.options.getInteger("report_number", false);
  const reports = reportNumber
    ? [storage.getMemberReportByNumber(reportNumber)].filter(
        (report): report is MemberReport => Boolean(report),
      )
    : storage.listMemberReports({ reporterId: interaction.user.id, limit: 10 });
  const owned = reports.filter(
    (report) =>
      report.guildId === runtime.guildId &&
      report.reporterId === interaction.user.id,
  );
  if (owned.length === 0) {
    await replyPrivate(
      interaction,
      "No matching reports were found for your account.",
    );
    return;
  }
  await replyPrivate(
    interaction,
    [
      "**Your private reports**",
      ...owned.map(
        (report) =>
          `#${report.reportNumber} · ${escapeMarkdown(report.category)} · **${escapeMarkdown(report.state)}** · <t:${unix(report.createdAt)}:R>`,
      ),
    ]
      .join("\n")
      .slice(0, 2_000),
  );
  runtime.storage.recordCommandMetric("report.status");
}

async function withdrawReport(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: ReportStorage,
): Promise<void> {
  const report = storage.getMemberReportByNumber(
    interaction.options.getInteger("report_number", true),
  );
  if (
    !report ||
    report.guildId !== runtime.guildId ||
    report.reporterId !== interaction.user.id
  ) {
    await replyPrivate(
      interaction,
      "That report was not found for your account.",
    );
    return;
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server changed before the report could be withdrawn. Try again.",
    );
    return;
  }
  const result = storage.withdrawMemberReport(report.reportId, {
    reporterId: interaction.user.id,
    expectedUpdatedAt: report.updatedAt,
  });
  if (result.status !== "changed" && result.status !== "unchanged") {
    await replyPrivate(
      interaction,
      "Only a pending report can be withdrawn. Refresh its status and try again.",
    );
    return;
  }
  await replyPrivate(
    interaction,
    `Report #${report.reportNumber} is now **${result.report.state}**.`,
  );
  if (interaction.guild) {
    await refreshReportReviewMessage(
      interaction.guild,
      result.report,
      storage,
      runtime.isCurrent,
    );
  }
  runtime.storage.recordCommandMetric("report.withdraw");
}

async function recoverReport(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: ReportStorage,
): Promise<void> {
  const guild = interaction.guild;
  const configuration = storage.getModerationConfiguration();
  if (!guild || !configuration || configuration.guildId !== runtime.guildId) {
    await replyPrivate(interaction, "Private reports are not configured.");
    return;
  }
  if (
    !configuration.reportBindingsVerifiedAt ||
    !configuration.reportReviewChannelId
  ) {
    await replyPrivate(
      interaction,
      "Private report recovery requires a currently verified review binding.",
    );
    return;
  }
  const reviewer = await authorizeReportReviewer(
    interaction,
    runtime,
    configuration,
  );
  if (!reviewer) {
    await replyPrivate(
      interaction,
      "You are not authorized to recover private reports.",
    );
    return;
  }
  const report = storage.getMemberReportByNumber(
    interaction.options.getInteger("report_number", true),
  );
  if (!report || report.guildId !== runtime.guildId) {
    await replyPrivate(
      interaction,
      "That report does not exist in this server.",
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
      `Report recovery needs administrator attention: ${resources.issues.join(" ")}`,
    );
    return;
  }
  if (resources.reviewChannel.id !== configuration.reportReviewChannelId) {
    await replyPrivate(
      interaction,
      "The verified report channel no longer matches the configured binding.",
    );
    return;
  }
  let recoverable = report;
  if (report.reviewMessageId && report.deliveryState === "posted") {
    const refreshed =
      report.reviewChannelId === resources.reviewChannel.id
        ? await refreshReportReviewMessage(
            guild,
            report,
            storage,
            runtime.isCurrent,
          )
        : await retireStaleReportMessage(
            guild,
            report,
            storage,
            runtime.isCurrent,
          );
    if (refreshed === "updated") {
      await replyPrivate(
        interaction,
        "That report already has a valid tracked review message, which was refreshed.",
      );
      return;
    }
    if (refreshed === "unavailable") {
      await replyPrivate(
        interaction,
        "Superior could not safely verify the existing review message. Try again when Discord is available.",
      );
      return;
    }
    const reconciled = storage.getMemberReportById(report.reportId);
    if (
      refreshed !== "missing" ||
      !reconciled ||
      reconciled.deliveryState !== "missing" ||
      reconciled.reviewChannelId !== report.reviewChannelId ||
      reconciled.reviewMessageId !== report.reviewMessageId
    ) {
      await replyPrivate(
        interaction,
        "The missing-message recovery checkpoint could not be verified; no replacement was posted.",
      );
      return;
    }
    recoverable = reconciled;
  }
  const inspectedConfiguration = storage.getModerationConfiguration();
  const currentResources = inspectedConfiguration
    ? await inspectSafetyWorkflowResources(
        guild,
        inspectedConfiguration,
        "reports",
        runtime.storage,
      )
    : null;
  const currentConfiguration = storage.getModerationConfiguration();
  const currentReport = storage.getMemberReportById(report.reportId);
  const currentReviewer = currentConfiguration
    ? await authorizeReportReviewer(interaction, runtime, currentConfiguration)
    : null;
  if (
    !currentConfiguration ||
    currentConfiguration.updatedAt !== inspectedConfiguration?.updatedAt ||
    currentConfiguration.updatedAt !== configuration.updatedAt ||
    !currentConfiguration.reportBindingsVerifiedAt ||
    !currentReviewer ||
    currentReviewer.id !== reviewer.id ||
    !currentReport ||
    currentReport.updatedAt !== recoverable.updatedAt ||
    !["reserved", "failed", "missing"].includes(currentReport.deliveryState) ||
    !currentResources?.reviewChannel ||
    currentResources.issues.length > 0 ||
    currentResources.reviewChannel.id !==
      currentConfiguration.reportReviewChannelId ||
    !runtime.isCurrent()
  ) {
    await replyPrivate(
      interaction,
      "The report, reviewer authority, or private destination changed before recovery could post.",
    );
    return;
  }
  try {
    await publishReservedReport(
      guild,
      currentResources.reviewChannel,
      currentReport,
      storage,
      runtime.isCurrent,
      true,
    );
    await replyPrivate(
      interaction,
      `Recovered private report #${report.reportNumber}.`,
    );
    runtime.storage.recordCommandMetric("report.recover");
  } catch {
    await replyPrivate(
      interaction,
      "The report remains safely reserved, but Discord delivery failed. Try recovery again later.",
    );
  }
}

async function retireStaleReportMessage(
  guild: Guild,
  report: MemberReport,
  storage: ReportStorage,
  isCurrent: () => boolean,
): Promise<"missing" | "unavailable"> {
  if (!report.reviewChannelId || !report.reviewMessageId || !isCurrent()) {
    return "unavailable";
  }
  let channel;
  try {
    channel = await guild.channels.fetch(report.reviewChannelId, {
      cache: true,
      force: true,
    });
  } catch (error) {
    if (!isUnknownResource(error, 10_003)) return "unavailable";
    return markReportMissing(storage, report, isCurrent);
  }
  if (!channel || channel.guild.id !== guild.id || !("messages" in channel)) {
    return "unavailable";
  }
  let message;
  try {
    message = await channel.messages.fetch(report.reviewMessageId);
  } catch (error) {
    if (!isUnknownResource(error, 10_008)) return "unavailable";
    return markReportMissing(storage, report, isCurrent);
  }
  if (message.author.id === guild.client.user?.id) {
    try {
      await message.delete();
    } catch {
      return "unavailable";
    }
  }
  return markReportMissing(storage, report, isCurrent);
}

function markReportMissing(
  storage: ReportStorage,
  report: MemberReport,
  isCurrent: () => boolean,
): "missing" | "unavailable" {
  if (!isCurrent()) return "unavailable";
  const result = storage.markMemberReportDeliveryMissing(report.reportId, {
    expectedUpdatedAt: report.updatedAt,
  });
  return result.status === "changed" || result.status === "unchanged"
    ? "missing"
    : "unavailable";
}

function isUnknownResource(error: unknown, code: number): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    Number((error as { code?: unknown }).code) === code,
  );
}

async function deferPrivate(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
}

async function replyPrivate(
  interaction: ChatInputCommandInteraction,
  content: string,
): Promise<void> {
  if (interaction.deferred && !interaction.replied) {
    await interaction.editReply({ content, allowedMentions: { parse: [] } });
  } else if (interaction.replied) {
    await interaction.followUp({
      content,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  } else {
    await interaction.reply({
      content,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }
}

function unix(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : 0;
}
