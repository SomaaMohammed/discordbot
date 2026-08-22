import {
  MessageFlags,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
} from "discord.js";
import type { GuildRuntime } from "../runtime.js";
import type {
  CaseAppeal,
  CaseAppealDecisionInput,
  CaseAppealOverturnFinalizeResult,
  CaseAppealReservationInput,
  CaseAppealReservationResult,
  CaseAppealState,
  CaseAppealTransitionResult,
  ModerationCase,
  ModerationCaseActionType,
  ActiveModerationCaseLookupResult,
  ModerationCaseListFilter,
  ModerationCaseAttemptInput,
  ModerationCaseTransitionResult,
  ModerationConfiguration,
  TimeoutAppealRemovalCheckpointInput,
  TimeoutAppealRemovalCheckpointResult,
} from "../types.js";
import { authorizeConfiguredRoleOrCapability } from "./authorization.js";
import { createAppealSubmitModal } from "./appeal-components.js";
import {
  publishReservedAppeal,
  refreshAppealReviewMessage,
  type AppealDeliveryStorage,
} from "./appeal-delivery.js";
import { inspectSafetyWorkflowResources } from "./safety-permissions.js";

export interface AppealStorage extends AppealDeliveryStorage {
  getModerationConfiguration(): ModerationConfiguration | null;
  reserveCaseAppeal(
    input: CaseAppealReservationInput,
  ): CaseAppealReservationResult;
  getCaseAppealByNumber(appealNumber: number): CaseAppeal | null;
  listCaseAppeals(filter?: {
    appellantId?: string;
    caseId?: string;
    states?: readonly CaseAppealState[];
    limit?: number;
    offset?: number;
  }): CaseAppeal[];
  claimCaseAppeal(
    appealId: string,
    input: { reviewerId: string; expectedUpdatedAt?: string },
  ): CaseAppealTransitionResult;
  takeOverCaseAppealClaim(
    appealId: string,
    input: {
      reviewerId: string;
      previousReviewerId: string;
      reason: string;
      expectedUpdatedAt: string;
    },
  ): CaseAppealTransitionResult;
  releaseCaseAppealClaim(
    appealId: string,
    input: {
      actorId: string;
      previousReviewerId: string;
      reason: string;
      expectedUpdatedAt: string;
    },
  ): CaseAppealTransitionResult;
  decideCaseAppeal(
    appealId: string,
    input: CaseAppealDecisionInput,
  ): CaseAppealTransitionResult;
  withdrawCaseAppeal(
    appealId: string,
    input: { appellantId: string; expectedUpdatedAt?: string },
  ): CaseAppealTransitionResult;
  getModerationCaseByNumber(caseNumber: number): ModerationCase | null;
  listModerationCases(filter?: ModerationCaseListFilter): ModerationCase[];
  findUniqueActiveModerationCase(
    targetUserId: string,
    actionTypes: readonly ModerationCaseActionType[],
  ): ActiveModerationCaseLookupResult;
  findUniqueFailedModerationCase(
    targetUserId: string,
    actionTypes: readonly ModerationCaseActionType[],
    options?: {
      relatedCaseId?: string;
      sources?: readonly ModerationCase["source"][];
    },
  ): ActiveModerationCaseLookupResult;
  finalizeCaseAppealOverturn(
    appealId: string,
    input: {
      reviewerId: string;
      decisionReason: string;
      caseReason: string;
      reversalCaseId?: string | null;
      appealExpectedUpdatedAt?: string;
      originalExpectedUpdatedAt?: string;
    },
  ): CaseAppealOverturnFinalizeResult;
  reserveModerationCaseAttempt(
    input: ModerationCaseAttemptInput,
  ): ModerationCase;
  finalizeTimeoutAppealOverturn(
    appealId: string,
    removalCaseId: string,
    input: {
      reviewerId: string;
      decisionReason: string;
      caseReason: string;
      discordActionMetadata?: unknown;
      appealExpectedUpdatedAt?: string;
      removalExpectedUpdatedAt?: string;
      originalExpectedUpdatedAt?: string;
    },
  ): CaseAppealOverturnFinalizeResult;
  failModerationCaseAttempt(
    caseId: string,
    input: { actorId: string; failureCode: string; expectedUpdatedAt?: string },
  ): ModerationCaseTransitionResult;
  checkpointTimeoutAppealRemoval(
    appealId: string,
    removalCaseId: string,
    input: TimeoutAppealRemovalCheckpointInput,
  ): TimeoutAppealRemovalCheckpointResult;
  completeExpiredTimeoutCase(
    caseId: string,
    input: {
      actorId: string;
      observedAt: string;
      expectedUpdatedAt: string;
    },
  ): ModerationCaseTransitionResult;
}

export async function handleAppealCommand(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const storage: AppealStorage = runtime.storage;
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "submit") {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.showModal(
        createAppealSubmitModal(
          "command",
          interaction.options.getInteger("case_number", true),
        ),
      );
    }
    return;
  }
  await deferPrivate(interaction);
  if (subcommand === "status") {
    await showStatus(interaction, runtime, storage);
  } else if (subcommand === "withdraw") {
    await withdrawAppeal(interaction, runtime, storage);
  } else if (subcommand === "recover") {
    await recoverAppeal(interaction, runtime, storage);
  } else {
    await replyPrivate(interaction, "Choose a supported appeal action.");
  }
}

export async function authorizeAppealReviewer(
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
    capability: "appeals.review",
    configuredRoleId: configuration.appealReviewerRoleId,
    configuredRoleReason: "reviewer-role",
    grants: runtime.storage,
  });
  return decision.allowed ? decision.member : null;
}

async function showStatus(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: AppealStorage,
): Promise<void> {
  const number = interaction.options.getInteger("appeal_number", false);
  const appeals = number
    ? [storage.getCaseAppealByNumber(number)].filter(
        (appeal): appeal is CaseAppeal => Boolean(appeal),
      )
    : storage.listCaseAppeals({ appellantId: interaction.user.id, limit: 10 });
  const owned = appeals.filter(
    (appeal) =>
      appeal.guildId === runtime.guildId &&
      appeal.appellantId === interaction.user.id,
  );
  if (owned.length === 0) {
    await replyPrivate(
      interaction,
      "No matching appeals were found for your account.",
    );
    return;
  }
  await replyPrivate(
    interaction,
    [
      "**Your case appeals**",
      ...owned.map((appeal) => {
        const moderationCase = storage.getModerationCaseById(appeal.caseId);
        return `Appeal #${appeal.appealNumber} · case #${moderationCase?.caseNumber ?? "unknown"} · **${appeal.state}** · <t:${unix(appeal.createdAt)}:R>`;
      }),
    ]
      .join("\n")
      .slice(0, 2_000),
  );
  runtime.storage.recordCommandMetric("appeal.status");
}

async function withdrawAppeal(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: AppealStorage,
): Promise<void> {
  const appeal = storage.getCaseAppealByNumber(
    interaction.options.getInteger("appeal_number", true),
  );
  if (
    !appeal ||
    appeal.guildId !== runtime.guildId ||
    appeal.appellantId !== interaction.user.id
  ) {
    await replyPrivate(
      interaction,
      "That appeal was not found for your account.",
    );
    return;
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server changed before the appeal could be withdrawn. Try again.",
    );
    return;
  }
  const result = storage.withdrawCaseAppeal(appeal.appealId, {
    appellantId: interaction.user.id,
    expectedUpdatedAt: appeal.updatedAt,
  });
  if (result.status !== "changed" && result.status !== "unchanged") {
    await replyPrivate(interaction, "Only a pending appeal can be withdrawn.");
    return;
  }
  await replyPrivate(
    interaction,
    `Appeal #${appeal.appealNumber} is now **${result.appeal.state}**.`,
  );
  const moderationCase = storage.getModerationCaseById(result.appeal.caseId);
  if (interaction.guild && moderationCase) {
    await refreshAppealReviewMessage(
      interaction.guild,
      result.appeal,
      moderationCase,
      storage,
      runtime.isCurrent,
    );
  }
  runtime.storage.recordCommandMetric("appeal.withdraw");
}

async function recoverAppeal(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: AppealStorage,
): Promise<void> {
  const guild = interaction.guild;
  const configuration = storage.getModerationConfiguration();
  if (!guild || !configuration) {
    await replyPrivate(interaction, "Case appeals are not configured.");
    return;
  }
  if (
    configuration.guildId !== runtime.guildId ||
    !configuration.appealBindingsVerifiedAt ||
    !configuration.appealReviewChannelId
  ) {
    await replyPrivate(
      interaction,
      "Appeal recovery requires a currently verified private review binding.",
    );
    return;
  }
  const reviewer = await authorizeAppealReviewer(
    interaction,
    runtime,
    configuration,
  );
  if (!reviewer) {
    await replyPrivate(
      interaction,
      "You are not authorized to recover appeals.",
    );
    return;
  }
  const appeal = storage.getCaseAppealByNumber(
    interaction.options.getInteger("appeal_number", true),
  );
  const moderationCase = appeal
    ? storage.getModerationCaseById(appeal.caseId)
    : null;
  if (!appeal || !moderationCase || appeal.guildId !== runtime.guildId) {
    await replyPrivate(
      interaction,
      "That appeal does not exist in this server.",
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
      `Appeal recovery needs administrator attention: ${resources.issues.join(" ")}`,
    );
    return;
  }
  if (resources.reviewChannel.id !== configuration.appealReviewChannelId) {
    await replyPrivate(
      interaction,
      "The verified appeal channel no longer matches the configured binding.",
    );
    return;
  }
  let recoverable = appeal;
  if (appeal.reviewMessageId && appeal.deliveryState === "posted") {
    const refreshed =
      appeal.reviewChannelId === resources.reviewChannel.id
        ? await refreshAppealReviewMessage(
            guild,
            appeal,
            moderationCase,
            storage,
            runtime.isCurrent,
          )
        : await retireStaleAppealMessage(
            guild,
            appeal,
            storage,
            runtime.isCurrent,
          );
    if (refreshed === "updated") {
      await replyPrivate(
        interaction,
        "That appeal already has a valid tracked review message, which was refreshed.",
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
    const reconciled = storage.getCaseAppealById(appeal.appealId);
    if (
      refreshed !== "missing" ||
      !reconciled ||
      reconciled.deliveryState !== "missing" ||
      reconciled.reviewChannelId !== appeal.reviewChannelId ||
      reconciled.reviewMessageId !== appeal.reviewMessageId
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
        "appeals",
        runtime.storage,
      )
    : null;
  const currentConfiguration = storage.getModerationConfiguration();
  const currentAppeal = storage.getCaseAppealById(appeal.appealId);
  const currentCase = currentAppeal
    ? storage.getModerationCaseById(currentAppeal.caseId)
    : null;
  const currentReviewer = currentConfiguration
    ? await authorizeAppealReviewer(interaction, runtime, currentConfiguration)
    : null;
  if (
    !currentConfiguration ||
    currentConfiguration.updatedAt !== inspectedConfiguration?.updatedAt ||
    currentConfiguration.updatedAt !== configuration.updatedAt ||
    !currentConfiguration.appealBindingsVerifiedAt ||
    !currentReviewer ||
    currentReviewer.id !== reviewer.id ||
    !currentAppeal ||
    currentAppeal.updatedAt !== recoverable.updatedAt ||
    !["reserved", "failed", "missing"].includes(currentAppeal.deliveryState) ||
    !currentCase ||
    currentCase.caseId !== moderationCase.caseId ||
    !currentResources?.reviewChannel ||
    currentResources.issues.length > 0 ||
    currentResources.reviewChannel.id !==
      currentConfiguration.appealReviewChannelId ||
    !runtime.isCurrent()
  ) {
    await replyPrivate(
      interaction,
      "The appeal, reviewer authority, case, or private destination changed before recovery could post.",
    );
    return;
  }
  try {
    await publishReservedAppeal(
      guild,
      currentResources.reviewChannel,
      currentAppeal,
      currentCase,
      storage,
      runtime.isCurrent,
      true,
    );
    await replyPrivate(
      interaction,
      `Recovered case appeal #${appeal.appealNumber}.`,
    );
    runtime.storage.recordCommandMetric("appeal.recover");
  } catch {
    await replyPrivate(
      interaction,
      "The appeal remains safely reserved, but Discord delivery failed. Try again later.",
    );
  }
}

async function retireStaleAppealMessage(
  guild: Guild,
  appeal: CaseAppeal,
  storage: AppealStorage,
  isCurrent: () => boolean,
): Promise<"missing" | "unavailable"> {
  if (!appeal.reviewChannelId || !appeal.reviewMessageId || !isCurrent()) {
    return "unavailable";
  }
  let channel;
  try {
    channel = await guild.channels.fetch(appeal.reviewChannelId, {
      cache: true,
      force: true,
    });
  } catch (error) {
    if (!isUnknownResource(error, 10_003)) return "unavailable";
    return markAppealMissing(storage, appeal, isCurrent);
  }
  if (!channel || channel.guild.id !== guild.id || !("messages" in channel)) {
    return "unavailable";
  }
  let message;
  try {
    message = await channel.messages.fetch(appeal.reviewMessageId);
  } catch (error) {
    if (!isUnknownResource(error, 10_008)) return "unavailable";
    return markAppealMissing(storage, appeal, isCurrent);
  }
  if (message.author.id === guild.client.user?.id) {
    try {
      await message.delete();
    } catch {
      return "unavailable";
    }
  }
  return markAppealMissing(storage, appeal, isCurrent);
}

function markAppealMissing(
  storage: AppealStorage,
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
  if (!interaction.deferred && !interaction.replied)
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
}
async function replyPrivate(
  interaction: ChatInputCommandInteraction,
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
function unix(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : 0;
}
