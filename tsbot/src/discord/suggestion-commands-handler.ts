import {
  ChannelType,
  MessageFlags,
  escapeMarkdown,
  type ChatInputCommandInteraction,
  type GuildMember,
  type GuildTextBasedChannel,
} from "discord.js";
import type { GuildRuntime } from "../runtime.js";
import type {
  SuggestionConfiguration,
  SuggestionConfigurationInput,
  SuggestionDeliveryInput,
  SuggestionDeliveryResult,
  SuggestionRecord,
  SuggestionReservationInput,
  SuggestionReservationResult,
  SuggestionReviewInput,
  SuggestionState,
  SuggestionTransitionResult,
  SuggestionVoteResult,
  SuggestionVoteValue,
  SuggestionVoteCounts,
} from "../types.js";
import {
  authorizeCapability,
  authorizeConfiguredRoleOrCapability,
  fetchAndValidateRole,
} from "./authorization.js";
import { fetchGuildMemberCoalesced } from "./fetch-coalescing.js";
import {
  createSuggestionSubmitModal,
  suggestionStatusMessage,
} from "./suggestion-components.js";
import {
  notifySuggestionAuthor,
  postSuggestionReviewEntry,
  publishReservedSuggestion,
  refreshSuggestionPublicMessage,
  type SuggestionDeliveryStorage,
} from "./suggestion-delivery.js";
import { inspectSuggestionResources } from "./phase2-permissions.js";
import { postFeatureLauncher } from "./preset-panels.js";
import { logDomainOutcome } from "./domain-outcomes.js";

const PAGE_SIZE = 10;

export interface SuggestionStorage extends SuggestionDeliveryStorage {
  getSuggestionConfiguration(): SuggestionConfiguration | null;
  upsertSuggestionConfiguration(
    input: SuggestionConfigurationInput,
  ): SuggestionConfiguration;
  disableSuggestionConfiguration(): SuggestionConfiguration | null;
  reserveSuggestion(
    input: SuggestionReservationInput,
  ): SuggestionReservationResult;
  toggleSuggestionVote(
    suggestionId: string,
    voterId: string,
    vote: SuggestionVoteValue,
  ): SuggestionVoteResult;
  reviewSuggestion(
    suggestionId: string,
    input: SuggestionReviewInput,
  ): SuggestionTransitionResult;
  withdrawSuggestion(
    suggestionId: string,
    authorId: string,
  ): SuggestionTransitionResult;
  getSuggestionById(suggestionId: string): SuggestionRecord | null;
  getSuggestionByNumber(suggestionNumber: number): SuggestionRecord | null;
  listSuggestions(options?: {
    state?: SuggestionState;
    authorId?: string;
    limit?: number;
    offset?: number;
  }): SuggestionRecord[];
}

export async function handleSuggestionCommand(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const storage = runtime.storage as unknown as SuggestionStorage;
  if (
    !interaction.guild ||
    interaction.guild.id !== runtime.guildId ||
    interaction.guildId !== runtime.guildId ||
    !runtime.isCurrent()
  ) {
    await replyPrivate(
      interaction,
      "This suggestion command is unavailable outside its current server.",
    );
    return;
  }
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "submit") {
    const configuration = storage.getSuggestionConfiguration();
    if (!isActiveSuggestionConfiguration(configuration)) {
      await replyPrivate(
        interaction,
        "Suggestions are not currently available in this server.",
      );
      return;
    }
    await interaction.showModal(createSuggestionSubmitModal("command"));
    return;
  }

  if (subcommand === "panel") {
    if (
      !(await requireCapability(interaction, runtime, "suggestions.configure"))
    ) {
      return;
    }
    await interaction.deferReply();
    await postSuggestionPanel(interaction, runtime, storage);
    return;
  }

  await deferPrivate(interaction);
  switch (subcommand) {
    case "status":
      await showSuggestionStatus(interaction, runtime, storage);
      return;
    case "withdraw":
      await withdrawSuggestion(interaction, runtime, storage);
      return;
    case "configure":
      if (
        !(await requireCapability(
          interaction,
          runtime,
          "suggestions.configure",
        ))
      )
        return;
      await configureSuggestions(interaction, runtime, storage);
      return;
    case "list":
      if (!(await requireReviewer(interaction, runtime, storage))) return;
      await listSuggestions(interaction, runtime, storage);
      return;
    case "review":
      await reviewSuggestion(interaction, runtime, storage);
      return;
    case "disable":
      if (
        !(await requireCapability(
          interaction,
          runtime,
          "suggestions.configure",
        ))
      )
        return;
      if (!runtime.isCurrent()) {
        await replyPrivate(
          interaction,
          "This server changed after access was verified. Suggestions were not disabled.",
        );
        return;
      }
      storage.disableSuggestionConfiguration();
      runtime.invalidate();
      await replyPrivate(
        interaction,
        "Suggestions are disabled. Stored suggestions and votes were retained.",
      );
      runtime.storage.recordCommandMetric("suggestion.disable");
      logDomainOutcome("suggestion", "disable", runtime.guildId, "completed");
      return;
    case "recover":
      if (
        !(await requireCapability(
          interaction,
          runtime,
          "suggestions.configure",
        ))
      )
        return;
      await recoverSuggestion(interaction, runtime, storage);
      return;
    default:
      await replyPrivate(
        interaction,
        "Choose a supported suggestion operation.",
      );
  }
}

async function configureSuggestions(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: SuggestionStorage,
): Promise<void> {
  const guild = interaction.guild!;
  const selectedChannel = interaction.options.getChannel("channel", true);
  const selectedReviewChannel = interaction.options.getChannel(
    "review_channel",
    false,
  );
  const selectedRole = interaction.options.getRole("reviewer_role", true);
  if (
    !("guild" in selectedChannel) ||
    selectedChannel.guild.id !== runtime.guildId ||
    (selectedReviewChannel &&
      (!("guild" in selectedReviewChannel) ||
        selectedReviewChannel.guild.id !== runtime.guildId)) ||
    !("guild" in selectedRole) ||
    selectedRole.guild.id !== runtime.guildId
  ) {
    await replyPrivate(
      interaction,
      "Suggestion resources must belong to this server.",
    );
    return;
  }
  const role = await fetchAndValidateRole(guild, selectedRole.id);
  if (!role.valid) {
    await replyPrivate(
      interaction,
      "Choose a current, assignable server role that is not @everyone or integration-managed.",
    );
    return;
  }
  const now = new Date().toISOString();
  const candidate: SuggestionConfiguration = {
    guildId: runtime.guildId,
    enabled: true,
    suggestionChannelId: selectedChannel.id,
    reviewChannelId: selectedReviewChannel?.id ?? null,
    reviewerRoleId: role.role.id,
    createThreads:
      interaction.options.getBoolean("create_threads", false) ?? false,
    cooldownLimit: interaction.options.getInteger("cooldown_limit", false) ?? 3,
    cooldownWindowSeconds:
      interaction.options.getInteger("cooldown_seconds", false) ?? 600,
    allowSelfVotes:
      interaction.options.getBoolean("allow_self_votes", false) ?? false,
    bindingsVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const resources = await inspectSuggestionResources(guild, candidate);
  if (resources.issues.length > 0) {
    await replyPrivate(
      interaction,
      `Suggestion configuration needs attention: ${resources.issues.join(" ")}`,
    );
    return;
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(interaction, "This server changed. Please try again.");
    return;
  }
  if (
    !(await allowSuggestionReviewerRoleAssignment(
      interaction,
      runtime,
      storage,
      candidate.reviewerRoleId,
    ))
  ) {
    return;
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server changed after suggestion configuration was verified. No configuration was saved.",
    );
    return;
  }
  const saved = storage.upsertSuggestionConfiguration(candidate);
  runtime.invalidate();
  await replyPrivate(
    interaction,
    `Suggestions are enabled in <#${saved.suggestionChannelId}> with reviewer role <@&${saved.reviewerRoleId}>.`,
  );
  runtime.storage.recordCommandMetric("suggestion.configure");
  logDomainOutcome("suggestion", "configure", runtime.guildId, "completed", {
    channelId: saved.suggestionChannelId,
    state: saved.enabled ? "enabled" : "disabled",
  });
}

async function postSuggestionPanel(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: SuggestionStorage,
): Promise<void> {
  const configuration = storage.getSuggestionConfiguration();
  if (!isActiveSuggestionConfiguration(configuration) || !interaction.guild) {
    await replyPrivate(interaction, "Configure and enable suggestions first.");
    return;
  }
  const resources = await inspectSuggestionResources(
    interaction.guild,
    configuration,
  );
  if (resources.issues.length > 0) {
    await replyPrivate(
      interaction,
      `Suggestion configuration needs attention: ${resources.issues.join(" ")}`,
    );
    return;
  }
  const actor = await fetchActor(interaction, runtime);
  if (!actor) return;
  await postFeatureLauncher(interaction, runtime, actor, "suggestions");
}

async function showSuggestionStatus(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: SuggestionStorage,
): Promise<void> {
  const number = interaction.options.getInteger("number", false);
  if (number !== null) {
    const suggestion = storage.getSuggestionByNumber(number);
    if (!suggestion) {
      await replyPrivate(interaction, `Suggestion #${number} was not found.`);
      return;
    }
    await replyPrivate(
      interaction,
      suggestionStatusMessage(
        suggestion,
        storage.getSuggestionVoteCounts(suggestion.suggestionId),
      ),
    );
    return;
  }
  const recent = storage.listSuggestions({
    authorId: interaction.user.id,
    limit: PAGE_SIZE,
  });
  if (recent.length === 0) {
    await replyPrivate(interaction, "You have not submitted any suggestions.");
    return;
  }
  await replyPrivate(
    interaction,
    [
      "**Your recent suggestions**",
      ...recent.map(
        (suggestion) =>
          `- #${suggestion.suggestionNumber} · **${escapeMarkdown(suggestion.title)}** · ${suggestion.state}`,
      ),
    ].join("\n"),
  );
  runtime.storage.recordCommandMetric("suggestion.status");
}

async function withdrawSuggestion(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: SuggestionStorage,
): Promise<void> {
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server changed before the withdrawal could start. No suggestion was withdrawn. Try again.",
    );
    return;
  }
  const number = interaction.options.getInteger("number", true);
  const suggestion = storage.getSuggestionByNumber(number);
  if (!suggestion || suggestion.authorId !== interaction.user.id) {
    await replyPrivate(
      interaction,
      "That pending suggestion was not found among your submissions.",
    );
    return;
  }
  const result = storage.withdrawSuggestion(
    suggestion.suggestionId,
    interaction.user.id,
  );
  if (result.status === "unavailable" || result.status === "not-found") {
    await replyPrivate(
      interaction,
      "That suggestion can no longer be withdrawn.",
    );
    return;
  }
  const configuration = storage.getSuggestionConfiguration();
  if (hasVerifiedSuggestionBindings(configuration)) {
    await refreshSuggestionPublicMessage(
      interaction.guild!,
      result.suggestion,
      storage,
      interaction.user.id,
      configuration,
      () => runtime.isCurrent(),
    ).catch(() => undefined);
  }
  await replyPrivate(
    interaction,
    result.status === "unchanged"
      ? `Suggestion #${number} is already withdrawn.`
      : `Suggestion #${number} was withdrawn.`,
  );
  runtime.storage.recordCommandMetric("suggestion.withdraw");
  logDomainOutcome("suggestion", "withdraw", runtime.guildId, result.status, {
    recordId: result.suggestion.suggestionId,
    recordNumber: result.suggestion.suggestionNumber,
    state: result.suggestion.state,
  });
}

async function listSuggestions(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: SuggestionStorage,
): Promise<void> {
  const page = interaction.options.getInteger("page", false) ?? 1;
  const state = interaction.options.getString(
    "state",
    false,
  ) as SuggestionState | null;
  const suggestions = storage.listSuggestions({
    ...(state ? { state } : {}),
    limit: PAGE_SIZE + 1,
    offset: (page - 1) * PAGE_SIZE,
  });
  const visible = suggestions.slice(0, PAGE_SIZE);
  await replyPrivate(
    interaction,
    visible.length === 0
      ? `No suggestions were found on page ${page}.`
      : [
          `**Suggestions · page ${page}**`,
          ...visible.map(
            (suggestion) =>
              `- #${suggestion.suggestionNumber} · ${suggestion.state} · **${escapeMarkdown(suggestion.title)}** · author \`${suggestion.authorId}\``,
          ),
          ...(suggestions.length > PAGE_SIZE
            ? [`More results are available on page ${page + 1}.`]
            : []),
        ].join("\n"),
  );
  runtime.storage.recordCommandMetric("suggestion.list");
}

async function reviewSuggestion(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: SuggestionStorage,
): Promise<void> {
  const number = interaction.options.getInteger("number", true);
  const state = interaction.options.getString("state", true) as Exclude<
    SuggestionState,
    "open" | "withdrawn"
  >;
  const reason = interaction.options.getString("reason", true);
  const configuration = storage.getSuggestionConfiguration();
  const suggestion = storage.getSuggestionByNumber(number);
  if (!(await requireReviewer(interaction, runtime, storage, configuration)))
    return;
  if (!suggestion) {
    await replyPrivate(interaction, `Suggestion #${number} was not found.`);
    return;
  }
  const currentConfiguration = storage.getSuggestionConfiguration();
  const currentSuggestion = storage.getSuggestionById(suggestion.suggestionId);
  if (
    !runtime.isCurrent() ||
    !hasVerifiedSuggestionBindings(configuration) ||
    !hasVerifiedSuggestionBindings(currentConfiguration) ||
    !sameSuggestionConfiguration(configuration, currentConfiguration) ||
    !currentSuggestion ||
    currentSuggestion.guildId !== runtime.guildId ||
    !sameSuggestionSnapshot(suggestion, currentSuggestion)
  ) {
    await replyPrivate(
      interaction,
      `Suggestion #${number} changed while reviewer access was being verified. Refresh its status and try again.`,
    );
    return;
  }
  const result = storage.reviewSuggestion(currentSuggestion.suggestionId, {
    state,
    reviewerId: interaction.user.id,
    reason,
  });
  if (result.status === "not-found" || result.status === "unavailable") {
    await replyPrivate(
      interaction,
      "That suggestion cannot move to the requested state.",
    );
    return;
  }
  await Promise.all([
    refreshSuggestionPublicMessage(
      interaction.guild!,
      result.suggestion,
      storage,
      interaction.user.id,
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
      ? `Suggestion #${number} already has that review state and reason.`
      : `Suggestion #${number} is now **${state}**.`,
  );
  runtime.storage.recordCommandMetric("suggestion.review");
  logDomainOutcome("suggestion", "review", runtime.guildId, result.status, {
    recordId: result.suggestion.suggestionId,
    recordNumber: result.suggestion.suggestionNumber,
    state: result.suggestion.state,
  });
}

async function recoverSuggestion(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: SuggestionStorage,
): Promise<void> {
  const number = interaction.options.getInteger("number", true);
  let suggestion = storage.getSuggestionByNumber(number);
  const configuration = storage.getSuggestionConfiguration();
  if (
    !suggestion ||
    !hasVerifiedSuggestionBindings(configuration) ||
    !interaction.guild
  ) {
    await replyPrivate(
      interaction,
      "That suggestion or its active configuration is unavailable.",
    );
    return;
  }
  const refreshed = await refreshSuggestionPublicMessage(
    interaction.guild,
    suggestion,
    storage,
    interaction.user.id,
    configuration,
    () => runtime.isCurrent(),
  ).catch(() => "unavailable" as const);
  if (refreshed === "updated") {
    await replyPrivate(
      interaction,
      `Suggestion #${number} is healthy and refreshed.`,
    );
    return;
  }
  suggestion = storage.getSuggestionById(suggestion.suggestionId) ?? suggestion;
  if (!["missing", "failed", "reserved"].includes(suggestion.deliveryState)) {
    await replyPrivate(
      interaction,
      "That suggestion is not available for message recovery.",
    );
    return;
  }
  const resources = await inspectSuggestionResources(
    interaction.guild,
    configuration,
  );
  if (!resources.channel || resources.issues.length > 0) {
    await replyPrivate(
      interaction,
      `Suggestion recovery needs attention: ${resources.issues.join(" ")}`,
    );
    return;
  }
  const currentConfiguration = storage.getSuggestionConfiguration();
  if (
    !runtime.isCurrent() ||
    !hasVerifiedSuggestionBindings(currentConfiguration) ||
    !sameSuggestionConfiguration(configuration, currentConfiguration)
  ) {
    await replyPrivate(
      interaction,
      "Suggestion settings changed during recovery. Verify the configuration and try again.",
    );
    return;
  }
  try {
    const published = await publishReservedSuggestion(
      interaction.guild,
      resources.channel,
      currentConfiguration,
      suggestion,
      storage,
      () => runtime.isCurrent(),
    );
    await postSuggestionReviewEntry(
      resources.reviewChannel,
      published.suggestion,
      storage.getSuggestionVoteCounts(published.suggestion.suggestionId),
      currentConfiguration,
      storage,
      () => runtime.isCurrent(),
    );
    await replyPrivate(
      interaction,
      `Suggestion #${number} was reposted in <#${published.message.channelId}>.`,
    );
    runtime.storage.recordCommandMetric("suggestion.recover");
    logDomainOutcome("suggestion", "recover", runtime.guildId, "delivered", {
      recordId: published.suggestion.suggestionId,
      recordNumber: published.suggestion.suggestionNumber,
      channelId: published.message.channelId,
      state: published.suggestion.state,
    });
  } catch (error) {
    await replyPrivate(
      interaction,
      `Suggestion recovery failed safely: ${errorMessage(error)}`,
    );
    runtime.storage.recordCommandMetric("suggestion.recover", false);
    logDomainOutcome(
      "suggestion",
      "recover",
      runtime.guildId,
      "failed-delivery",
      {
        recordId: suggestion.suggestionId,
        recordNumber: suggestion.suggestionNumber,
        state: suggestion.deliveryState,
      },
    );
  }
}

async function requireCapability(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  capability: "suggestions.configure" | "suggestions.review",
): Promise<boolean> {
  const guild = interaction.guild;
  if (!guild || guild.id !== runtime.guildId) return false;
  const decision = await authorizeCapability({
    guild,
    userId: interaction.user.id,
    capability,
    grants: runtime.storage,
  });
  if (!decision.allowed) {
    await replyPrivate(
      interaction,
      `You need the \`${capability}\` capability to use that operation.`,
    );
    return false;
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server changed while access was being verified. Try again.",
    );
    return false;
  }
  return true;
}

async function requireReviewer(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: SuggestionStorage,
  configuration = storage.getSuggestionConfiguration(),
): Promise<boolean> {
  const guild = interaction.guild;
  if (
    !guild ||
    guild.id !== runtime.guildId ||
    !hasVerifiedSuggestionBindings(configuration)
  ) {
    await replyPrivate(
      interaction,
      "Suggestion review configuration is unavailable.",
    );
    return false;
  }
  const decision = await authorizeConfiguredRoleOrCapability({
    guild,
    userId: interaction.user.id,
    capability: "suggestions.review",
    configuredRoleId: configuration.reviewerRoleId,
    configuredRoleReason: "reviewer-role",
    grants: runtime.storage,
  });
  if (!decision.allowed) {
    await replyPrivate(
      interaction,
      "Only authorized suggestion reviewers can use that operation.",
    );
    return false;
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
    return false;
  }
  return true;
}

async function allowSuggestionReviewerRoleAssignment(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: SuggestionStorage,
  reviewerRoleId: string,
): Promise<boolean> {
  const guild = interaction.guild;
  if (!guild || guild.id !== runtime.guildId) return false;
  const decision = await authorizeCapability({
    guild,
    userId: interaction.user.id,
    capability: "suggestions.configure",
    grants: runtime.storage,
  });
  if (!decision.allowed) {
    await replyPrivate(
      interaction,
      "Your suggestion configuration access changed. Try again.",
    );
    return false;
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server changed while access was being verified. Try again.",
    );
    return false;
  }
  const current = storage.getSuggestionConfiguration();
  if (
    decision.reason === "delegated" &&
    (!current ||
      current.bindingsVerifiedAt === null ||
      current.reviewerRoleId !== reviewerRoleId) &&
    decision.member.roles.cache.has(reviewerRoleId)
  ) {
    await replyPrivate(
      interaction,
      "Delegated configurators cannot assign a suggestion reviewer role they currently hold. Ask the server owner or an Administrator to make that change.",
    );
    return false;
  }
  return true;
}

async function fetchActor(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<GuildMember | null> {
  const actor = await fetchGuildMemberCoalesced(
    interaction.guild!,
    interaction.user.id,
    { cache: true, force: true },
  );
  if (!actor || actor.guild.id !== runtime.guildId) {
    await replyPrivate(
      interaction,
      "Could not verify your current server membership.",
    );
    return null;
  }
  return actor;
}

function sameSuggestionSnapshot(
  expected: SuggestionRecord,
  current: SuggestionRecord,
): boolean {
  return (
    expected.guildId === current.guildId &&
    expected.suggestionId === current.suggestionId &&
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
    return;
  }
  if (interaction.replied) {
    await interaction.followUp({
      content,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }
  await interaction.reply({
    content,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Suggestion recovery failed.";
}
