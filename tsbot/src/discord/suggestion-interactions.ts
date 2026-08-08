import {
  ChannelType,
  type ButtonInteraction,
  type GuildMember,
  type ModalSubmitInteraction,
} from "discord.js";
import type { GuildRuntime } from "../runtime.js";
import type {
  SuggestionConfiguration,
  SuggestionRecord,
  SuggestionVoteResult,
  SuggestionVoteValue,
} from "../types.js";
import { authorizeConfiguredRoleOrCapability } from "./authorization.js";
import {
  SUGGESTION_DETAILS_FIELD_ID,
  SUGGESTION_INPUT_LIMITS,
  SUGGESTION_REASON_FIELD_ID,
  SUGGESTION_TITLE_FIELD_ID,
  createSuggestionReviewModal,
  createSuggestionSubmitModal,
  parseSuggestionComponentId,
} from "./suggestion-components.js";
import {
  notifySuggestionAuthor,
  postSuggestionReviewEntry,
  publishReservedSuggestion,
  refreshSuggestionPublicMessage,
} from "./suggestion-delivery.js";
import type { SuggestionStorage } from "./suggestion-commands-handler.js";
import { normalizeMultilineText } from "./forms.js";
import { parseSuggestionOpenCustomId } from "./panel-theme.js";
import { inspectSuggestionResources } from "./phase2-permissions.js";

const NAMESPACE = "superior:suggestion:";

type SuggestionInteraction = ButtonInteraction | ModalSubmitInteraction;

export async function handleSuggestionButton(
  interaction: ButtonInteraction,
  runtime: GuildRuntime,
): Promise<boolean> {
  if (!interaction.customId.startsWith(NAMESPACE)) return false;
  const storage = runtime.storage as unknown as SuggestionStorage;
  const panelId = parseSuggestionOpenCustomId(interaction.customId);
  if (panelId) {
    await openSuggestionPanelModal(interaction, runtime, storage, panelId);
    return true;
  }
  const parsed = parseSuggestionComponentId(interaction.customId);
  if (
    !parsed ||
    parsed.kind === "submit-modal" ||
    parsed.kind === "review-modal"
  ) {
    await replyPrivate(
      interaction,
      "This suggestion control is outdated or invalid. Ask an administrator to refresh it.",
    );
    return true;
  }
  if (parsed.kind === "review") {
    const reviewer = await authorizeReviewer(interaction, runtime, storage);
    if (!reviewer) return true;
    const suggestion = storage.getSuggestionById(parsed.suggestionId);
    if (
      !runtime.isCurrent() ||
      !suggestion ||
      suggestion.guildId !== runtime.guildId ||
      interaction.guild?.id !== runtime.guildId ||
      interaction.message.author.id !== interaction.client.user?.id
    ) {
      await replyPrivate(
        interaction,
        "That suggestion is no longer available.",
      );
      return true;
    }
    await interaction.showModal(
      createSuggestionReviewModal(suggestion.suggestionId, parsed.state),
    );
    return true;
  }

  const configuration = storage.getSuggestionConfiguration();
  if (!isActiveSuggestionConfiguration(configuration)) {
    await replyPrivate(
      interaction,
      "Suggestions are currently disabled or awaiting binding verification.",
    );
    return true;
  }
  await deferPrivate(interaction);
  const suggestion = storage.getSuggestionById(parsed.suggestionId);
  if (
    !suggestion ||
    suggestion.guildId !== runtime.guildId ||
    suggestion.channelId !== interaction.channelId ||
    suggestion.messageId !== interaction.message.id ||
    interaction.message.author.id !== interaction.client.user?.id
  ) {
    await replyPrivate(
      interaction,
      "This vote control is stale or does not belong to this suggestion.",
    );
    return true;
  }
  const member = await fetchMember(interaction, runtime);
  if (!member || member.user.bot) {
    await replyPrivate(
      interaction,
      "Could not verify your current server membership.",
    );
    return true;
  }
  const verifiedSuggestion = storage.getSuggestionById(suggestion.suggestionId);
  if (
    !runtime.isCurrent() ||
    !verifiedSuggestion ||
    !sameSuggestionSnapshot(suggestion, verifiedSuggestion) ||
    verifiedSuggestion.channelId !== interaction.channelId ||
    verifiedSuggestion.messageId !== interaction.message.id
  ) {
    await replyPrivate(
      interaction,
      "This suggestion changed while your membership was being verified. Refresh the message and try again.",
    );
    return true;
  }
  const result = storage.toggleSuggestionVote(
    verifiedSuggestion.suggestionId,
    member.id,
    parsed.direction === "up" ? 1 : -1,
  );
  await respondToVote(interaction, result);
  if (result.suggestion) {
    await refreshSuggestionPublicMessage(
      interaction.guild!,
      result.suggestion,
      storage,
      member.id,
      configuration,
      () => runtime.isCurrent(),
    ).catch(() => "unavailable" as const);
  }
  runtime.storage.recordCommandMetric("suggestion.vote");
  return true;
}

export async function handleSuggestionModal(
  interaction: ModalSubmitInteraction,
  runtime: GuildRuntime,
): Promise<boolean> {
  if (!interaction.customId.startsWith(NAMESPACE)) return false;
  const parsed = parseSuggestionComponentId(interaction.customId);
  if (
    !parsed ||
    (parsed.kind !== "submit-modal" && parsed.kind !== "review-modal")
  ) {
    await replyPrivate(
      interaction,
      "This suggestion form is outdated or invalid. Open a fresh form.",
    );
    return true;
  }
  const storage = runtime.storage as unknown as SuggestionStorage;
  if (parsed.kind === "submit-modal") {
    await submitSuggestion(interaction, runtime, storage, parsed.source);
  } else {
    await submitSuggestionReview(
      interaction,
      runtime,
      storage,
      parsed.suggestionId,
      parsed.state,
    );
  }
  return true;
}

async function openSuggestionPanelModal(
  interaction: ButtonInteraction,
  runtime: GuildRuntime,
  storage: SuggestionStorage,
  panelId: string,
): Promise<void> {
  const panel = runtime.storage.findPostedPanelByToken(panelId);
  const configuration = storage.getSuggestionConfiguration();
  if (
    !panel ||
    panel.preset !== "suggestions" ||
    panel.channelId !== interaction.channelId ||
    panel.messageId !== interaction.message.id ||
    interaction.message.author.id !== interaction.client.user?.id ||
    !isActiveSuggestionConfiguration(configuration) ||
    interaction.guild?.id !== runtime.guildId ||
    !runtime.isCurrent()
  ) {
    await replyPrivate(
      interaction,
      "This suggestion panel is outdated or unavailable. Ask an administrator to refresh it.",
    );
    return;
  }
  await interaction.showModal(createSuggestionSubmitModal(panel.panelId));
  runtime.storage.recordCommandMetric("panel.suggestions.use");
}

async function submitSuggestion(
  interaction: ModalSubmitInteraction,
  runtime: GuildRuntime,
  storage: SuggestionStorage,
  source: string | null,
): Promise<void> {
  let title: string;
  let details: string;
  try {
    title = normalizeMultilineText(
      interaction.fields.getTextInputValue(SUGGESTION_TITLE_FIELD_ID),
      "Suggestion title",
      3,
      SUGGESTION_INPUT_LIMITS.title,
    ).replace(/\s+/gu, " ");
    details = normalizeMultilineText(
      interaction.fields.getTextInputValue(SUGGESTION_DETAILS_FIELD_ID),
      "Suggestion proposal",
      10,
      SUGGESTION_INPUT_LIMITS.details,
    );
  } catch (error) {
    await replyPrivate(interaction, errorMessage(error));
    return;
  }
  await deferPrivate(interaction);
  const guild = interaction.guild;
  if (!guild || guild.id !== runtime.guildId) {
    await replyPrivate(
      interaction,
      "Suggestion submission must run in this server.",
    );
    return;
  }
  if (source && source !== "command") {
    const panel = runtime.storage.findPostedPanelByToken(source);
    if (
      !panel ||
      panel.preset !== "suggestions" ||
      panel.channelId !== interaction.channelId
    ) {
      await replyPrivate(
        interaction,
        "This suggestion launcher is outdated. Open a fresh form.",
      );
      return;
    }
    const launcherChannel = await guild.channels
      .fetch(panel.channelId)
      .catch(() => null);
    const launcherMessage =
      launcherChannel &&
      (launcherChannel.type === ChannelType.GuildText ||
        launcherChannel.type === ChannelType.GuildAnnouncement)
        ? await launcherChannel.messages
            .fetch(panel.messageId)
            .catch(() => null)
        : null;
    if (launcherMessage?.author.id !== interaction.client.user?.id) {
      await replyPrivate(
        interaction,
        "This suggestion launcher is missing. Ask an administrator to refresh it.",
      );
      return;
    }
  }
  const configuration = storage.getSuggestionConfiguration();
  if (!isActiveSuggestionConfiguration(configuration)) {
    await replyPrivate(interaction, "Suggestions are currently disabled.");
    return;
  }
  const resources = await inspectSuggestionResources(guild, configuration);
  if (!resources.channel || resources.issues.length > 0) {
    await replyPrivate(
      interaction,
      `Suggestions need administrator attention: ${resources.issues.join(" ")}`,
    );
    return;
  }
  const member = await fetchMember(interaction, runtime);
  if (!member || member.user.bot) {
    await replyPrivate(
      interaction,
      "Could not verify your current server membership.",
    );
    return;
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(interaction, "This server changed. Please try again.");
    return;
  }
  const currentConfiguration = storage.getSuggestionConfiguration();
  if (
    !isActiveSuggestionConfiguration(currentConfiguration) ||
    !sameSuggestionConfiguration(configuration, currentConfiguration)
  ) {
    await replyPrivate(
      interaction,
      "Suggestion settings changed while the form was open. Submit a fresh form.",
    );
    return;
  }
  const reservation = storage.reserveSuggestion({
    authorId: member.id,
    title,
    details,
  });
  if (reservation.status === "cooldown") {
    await replyPrivate(
      interaction,
      `You reached the suggestion limit. Try again <t:${Math.floor(Date.parse(reservation.retryAt) / 1_000)}:R>.`,
    );
    return;
  }
  if (reservation.status === "disabled") {
    await replyPrivate(
      interaction,
      "Suggestions were disabled before submission.",
    );
    return;
  }
  const deliveryConfiguration = storage.getSuggestionConfiguration();
  if (
    !runtime.isCurrent() ||
    !isActiveSuggestionConfiguration(deliveryConfiguration) ||
    !sameSuggestionConfiguration(currentConfiguration, deliveryConfiguration)
  ) {
    storage.failSuggestionDelivery(
      reservation.suggestion.suggestionId,
      "Suggestion configuration changed during submission",
    );
    await replyPrivate(
      interaction,
      "Suggestion settings changed during submission. The reserved suggestion was not posted and is available for staff recovery.",
    );
    runtime.storage.recordCommandMetric("suggestion.submit", false);
    return;
  }
  try {
    const published = await publishReservedSuggestion(
      guild,
      resources.channel,
      deliveryConfiguration,
      reservation.suggestion,
      storage,
      () => runtime.isCurrent(),
    );
    await postSuggestionReviewEntry(
      resources.reviewChannel,
      published.suggestion,
      storage.getSuggestionVoteCounts(published.suggestion.suggestionId),
      deliveryConfiguration,
      storage,
      () => runtime.isCurrent(),
    );
    await replyPrivate(
      interaction,
      `Suggestion #${published.suggestion.suggestionNumber} was posted in <#${published.message.channelId}>.`,
    );
    runtime.storage.recordCommandMetric("suggestion.submit");
  } catch {
    await replyPrivate(
      interaction,
      "Superior could not post the suggestion safely. The failed reservation was recorded; try again later.",
    );
    runtime.storage.recordCommandMetric("suggestion.submit", false);
  }
}

async function submitSuggestionReview(
  interaction: ModalSubmitInteraction,
  runtime: GuildRuntime,
  storage: SuggestionStorage,
  suggestionId: string,
  state: "under-review" | "accepted" | "declined" | "implemented",
): Promise<void> {
  let reason: string;
  try {
    reason = normalizeMultilineText(
      interaction.fields.getTextInputValue(SUGGESTION_REASON_FIELD_ID),
      "Review reason",
      1,
      SUGGESTION_INPUT_LIMITS.reason,
    );
  } catch (error) {
    await replyPrivate(interaction, errorMessage(error));
    return;
  }
  await deferPrivate(interaction);
  const reviewer = await authorizeReviewer(interaction, runtime, storage);
  if (!reviewer) return;
  const suggestion = storage.getSuggestionById(suggestionId);
  if (
    !runtime.isCurrent() ||
    !suggestion ||
    suggestion.guildId !== runtime.guildId
  ) {
    await replyPrivate(interaction, "That suggestion is no longer available.");
    return;
  }
  const result = storage.reviewSuggestion(suggestionId, {
    state,
    reviewerId: reviewer.id,
    reason,
  });
  if (result.status === "not-found" || result.status === "unavailable") {
    await replyPrivate(interaction, "That suggestion cannot be reviewed now.");
    return;
  }
  await Promise.all([
    refreshSuggestionPublicMessage(
      interaction.guild!,
      result.suggestion,
      storage,
      reviewer.id,
      storage.getSuggestionConfiguration(),
      () => runtime.isCurrent(),
    ).catch(() => "unavailable" as const),
    ...(result.status === "changed"
      ? [notifySuggestionAuthor(interaction.guild!, result.suggestion)]
      : []),
  ]);
  await replyPrivate(
    interaction,
    result.status === "unchanged"
      ? `Suggestion #${result.suggestion.suggestionNumber} already has that review.`
      : `Suggestion #${result.suggestion.suggestionNumber} is now **${state}**.`,
  );
  runtime.storage.recordCommandMetric("suggestion.review");
}

async function authorizeReviewer(
  interaction: SuggestionInteraction,
  runtime: GuildRuntime,
  storage: SuggestionStorage,
): Promise<GuildMember | null> {
  const guild = interaction.guild;
  const configuration = storage.getSuggestionConfiguration();
  if (
    !guild ||
    guild.id !== runtime.guildId ||
    !hasVerifiedSuggestionBindings(configuration) ||
    configuration.reviewChannelId !== interaction.channelId
  ) {
    await replyPrivate(
      interaction,
      "This suggestion review control is outdated or unavailable.",
    );
    return null;
  }
  const decision = await authorizeConfiguredRoleOrCapability({
    guild,
    userId: interaction.user.id,
    capability: "suggestions.review",
    configuredRoleId: configuration.reviewerRoleId,
    grants: runtime.storage,
  });
  if (!decision.allowed) {
    await replyPrivate(
      interaction,
      "Only authorized suggestion reviewers can use that control.",
    );
    return null;
  }
  const current = storage.getSuggestionConfiguration();
  if (
    !runtime.isCurrent() ||
    !hasVerifiedSuggestionBindings(current) ||
    !sameSuggestionConfiguration(configuration, current)
  ) {
    await replyPrivate(
      interaction,
      "Suggestion review settings changed while access was being verified. Try again.",
    );
    return null;
  }
  return decision.member;
}

async function fetchMember(
  interaction: SuggestionInteraction,
  runtime: GuildRuntime,
): Promise<GuildMember | null> {
  const member = await interaction.guild?.members
    .fetch({ user: interaction.user.id, cache: true, force: true })
    .catch(() => null);
  return member?.guild.id === runtime.guildId ? member : null;
}

async function respondToVote(
  interaction: ButtonInteraction,
  result: SuggestionVoteResult,
): Promise<void> {
  switch (result.status) {
    case "added":
      await replyPrivate(interaction, "Your vote was recorded.");
      return;
    case "switched":
      await replyPrivate(interaction, "Your vote was switched.");
      return;
    case "removed":
      await replyPrivate(interaction, "Your vote was removed.");
      return;
    case "self-vote":
      await replyPrivate(
        interaction,
        "Authors cannot vote on their own suggestions.",
      );
      return;
    case "not-found":
    case "unavailable":
      await replyPrivate(
        interaction,
        "Voting is no longer available for that suggestion.",
      );
      return;
    case "unchanged":
      await replyPrivate(interaction, "Your vote is unchanged.");
  }
}

async function deferPrivate(interaction: SuggestionInteraction): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true });
  }
}

async function replyPrivate(
  interaction: SuggestionInteraction,
  content: string,
): Promise<void> {
  if (interaction.deferred && !interaction.replied) {
    await interaction.editReply({ content, allowedMentions: { parse: [] } });
    return;
  }
  if (interaction.replied) {
    await interaction.followUp({
      content,
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }
  await interaction.reply({
    content,
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Suggestion validation failed.";
}

function sameSuggestionSnapshot(
  expected: SuggestionRecord,
  current: SuggestionRecord,
): boolean {
  return (
    expected.updatedAt === current.updatedAt &&
    expected.state === current.state &&
    expected.deliveryState === current.deliveryState &&
    expected.channelId === current.channelId &&
    expected.messageId === current.messageId
  );
}

function sameSuggestionConfiguration(
  expected: SuggestionConfiguration,
  current: SuggestionConfiguration,
): boolean {
  return (
    expected.updatedAt === current.updatedAt &&
    expected.enabled === current.enabled &&
    expected.suggestionChannelId === current.suggestionChannelId &&
    expected.reviewChannelId === current.reviewChannelId &&
    expected.reviewerRoleId === current.reviewerRoleId &&
    expected.createThreads === current.createThreads &&
    expected.bindingsVerifiedAt === current.bindingsVerifiedAt
  );
}

function isActiveSuggestionConfiguration(
  configuration: SuggestionConfiguration | null,
): configuration is SuggestionConfiguration {
  return (
    configuration?.enabled === true &&
    hasVerifiedSuggestionBindings(configuration)
  );
}

function hasVerifiedSuggestionBindings(
  configuration: SuggestionConfiguration | null,
): configuration is SuggestionConfiguration {
  return configuration !== null && configuration.bindingsVerifiedAt !== null;
}
