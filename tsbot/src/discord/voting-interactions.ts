import { randomUUID } from "node:crypto";
import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  escapeMarkdown,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
  type MessageCreateOptions,
  type MessageEditOptions,
} from "discord.js";
import { SUPERIOR_PANEL_COLOR } from "./panel-theme.js";
import { observeLatency } from "../latency.js";
import type { GuildRuntime } from "../runtime.js";
import type {
  VotingPanel,
  VotingPanelInput,
  VotingPanelSelectionResult,
  VotingPanelTransitionResult,
  VotingPanelVoter,
} from "../types.js";
import { fetchVerifiedGuildMember } from "./authorization.js";
import { fetchCurrentBotMember } from "./fetch-coalescing.js";
import {
  VOTING_PANEL_LIMITS,
  buildVotingPanelPayload,
  buildVotingPanelOptionsPayload,
  normalizeVotingDescription,
  normalizeVotingPollType,
  normalizeVotingQuestion,
  normalizeVotingTitle,
  parseVotingPanelComponentId,
  parseVotingPanelOptions,
  type VotingPanelView,
} from "./voting-panel.js";

/**
 * Narrow persistence seam. It intentionally mirrors only the voting methods
 * needed by interaction delivery, leaving schema and scheduling ownership to
 * the storage/runtime layer.
 */
export interface VotingPanelStorage {
  countActiveVotingPanels(channelId: string): number;
  createVotingPanel(input: VotingPanelInput): VotingPanel;
  getVotingPanel(voteId: string): VotingPanel | null;
  selectVotingPanelOption(
    voteId: string,
    voterId: string,
    optionId: string,
  ): VotingPanelSelectionResult;
  toggleVotingPanelOption(
    voteId: string,
    voterId: string,
    optionId: string,
  ): VotingPanelSelectionResult;
  getVotingPanelSelection(voteId: string, voterId: string): string[];
  listVotingPanelVoters(voteId: string): VotingPanelVoter[];
  transitionVotingPanel(
    voteId: string,
    status: "completed" | "cancelled",
    actorId: string,
    timestamp: string,
  ): VotingPanelTransitionResult;
}

type EditableVotingMessage = Pick<Message, "edit">;

const SAFE_ALLOWED_MENTIONS = { parse: [] as never[] } as const;

/**
 * Handles `/panel vote` after the command router has selected this subcommand.
 * It posts the panel directly in the current channel; no target-channel option
 * or modal is involved.
 */
export async function handleVotingPanelCommand(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  _actor?: GuildMember,
): Promise<void> {
  const storage: VotingPanelStorage = runtime.storage;
  const guild = interaction.guild;
  const channel = getCurrentVotingChannel(interaction, runtime);
  if (
    !guild ||
    guild.id !== runtime.guildId ||
    interaction.guildId !== runtime.guildId ||
    !channel ||
    !runtime.isCurrent()
  ) {
    await replyPrivate(
      interaction,
      "Voting panels can only be created in this server's current text channel.",
    );
    return;
  }

  const administrator = await fetchVotingAdministrator(
    guild,
    interaction.user.id,
  );
  if (!administrator) {
    await replyPrivate(
      interaction,
      "You need Discord's Administrator permission to create a voting panel.",
    );
    return;
  }

  let request: ParsedVotingCreateRequest;
  try {
    request = readVotingCreateRequest(interaction);
  } catch (error) {
    await replyPrivate(interaction, errorMessage(error));
    return;
  }

  const botMember = await getCurrentBotMember(guild);
  const missingPermissions = getMissingVotingPermissions(channel, botMember);
  if (missingPermissions.length > 0) {
    await replyPrivate(
      interaction,
      `Superior needs ${missingPermissions.join(", ")} in this channel before it can post a voting panel.`,
    );
    return;
  }
  if (storage.countActiveVotingPanels(channel.id) >= 5) {
    await replyPrivate(
      interaction,
      "This channel already has five active voting panels. Close or cancel one before creating another.",
    );
    return;
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server changed while the voting panel was being prepared. Please try again.",
    );
    return;
  }

  await deferPublic(interaction);
  const voteId = createVotingPanelId();
  const now = new Date();
  const deadlineAt = request.durationMinutes
    ? new Date(now.getTime() + request.durationMinutes * 60_000).toISOString()
    : null;
  const draft = createVotingPanelView({
    voteId,
    guildId: runtime.guildId,
    channelId: channel.id,
    creatorId: administrator.id,
    question: request.question,
    title: request.title,
    description: request.description,
    pollType: request.pollType,
    multiSelect: request.multiSelect,
    options: request.options,
    deadlineAt,
    mentionEveryoneOnCreation: request.mentionEveryoneOnCreation,
    mentionEveryoneOnCompletion: request.mentionEveryoneOnCompletion,
    createdAt: now.toISOString(),
  });
  const canMentionEveryone = Boolean(
    request.mentionEveryoneOnCreation &&
    botMember &&
    channel.permissionsFor(botMember)?.has(PermissionFlagsBits.MentionEveryone),
  );

  let message: Message;
  try {
    message = await observeLatency(
      "discord.send",
      "voting-panel",
      () =>
        channel.send(
          buildVotingPanelPayload(draft, {
            phase: "creation",
            allowEveryoneMention: canMentionEveryone,
          }),
        ),
      { guildId: runtime.guildId },
      "info",
    );
  } catch {
    await replyPublic(
      interaction,
      "Superior could not post the voting panel in this channel.",
    );
    return;
  }

  let saved: VotingPanel;
  try {
    saved = storage.createVotingPanel({
      voteId,
      channelId: channel.id,
      messageId: message.id,
      creatorId: administrator.id,
      question: request.question,
      ...(request.title === null ? {} : { title: request.title }),
      ...(request.description === null
        ? {}
        : { description: request.description }),
      pollType: request.pollType,
      multiSelect: request.multiSelect,
      options: request.options,
      ...(deadlineAt === null ? {} : { deadlineAt }),
      mentionEveryoneOnCreation: request.mentionEveryoneOnCreation,
      mentionEveryoneOnCompletion: request.mentionEveryoneOnCompletion,
    });
  } catch {
    await message.delete().catch(() => undefined);
    await replyPublic(
      interaction,
      "Superior could not save the voting panel, so the posted panel was removed.",
    );
    return;
  }

  recordVotingMetric(runtime, "panel.vote.create");
  await replyPublic(
    interaction,
    `Voting panel created in <#${channel.id}>.${
      request.mentionEveryoneOnCreation && !canMentionEveryone
        ? " @everyone was not mentioned because Superior lacks that permission."
        : ""
    }`,
  );
}

/** Routes every persistent voting-panel button; returns false for other UI. */
export async function handleVotingPanelButton(
  interaction: ButtonInteraction,
  runtime: GuildRuntime,
): Promise<boolean> {
  const parsed = parseVotingPanelComponentId(interaction.customId);
  if (!parsed) return false;
  const storage: VotingPanelStorage = runtime.storage;
  if (parsed.kind === "option") {
    await handleOptionButton(
      interaction,
      runtime,
      storage,
      parsed.voteId,
      parsed.optionId,
    );
    return true;
  }
  if (parsed.kind === "view-voters") {
    await handleViewVotersButton(interaction, runtime, storage, parsed.voteId);
    return true;
  }
  if (parsed.kind === "panel-options") {
    await handlePanelOptionsButton(
      interaction,
      runtime,
      storage,
      parsed.voteId,
    );
    return true;
  }
  await handleManagementButton(interaction, runtime, storage, parsed);
  return true;
}

/** Updates a stored panel's original Discord message without sending a reply. */
export async function refreshVotingPanelMessage(
  message: EditableVotingMessage,
  panel: VotingPanelView,
): Promise<void> {
  await observeLatency(
    "discord.edit",
    "voting-panel",
    () => message.edit(buildVotingPanelPayload(panel)),
    { guildId: panel.guildId },
    "info",
  );
}

/**
 * Updates an original message after a persisted completion. The caller must
 * pass `allowEveryoneMention` only after checking the bot's channel permission.
 */
export async function deliverVotingPanelCompletion(
  message: EditableVotingMessage,
  panel: VotingPanelView,
  options: { readonly allowEveryoneMention: boolean },
): Promise<void> {
  const payload = buildVotingPanelPayload(panel, {
    phase: "completion",
    allowEveryoneMention: options.allowEveryoneMention,
  });
  await observeLatency(
    "discord.edit",
    "voting-panel-completion",
    () => message.edit({ ...payload, content: payload.content ?? null }),
    { guildId: panel.guildId },
    "info",
  );
}

interface ParsedVotingCreateRequest {
  readonly question: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly pollType: "yes-no" | "custom";
  readonly options: ReturnType<typeof parseVotingPanelOptions>;
  readonly multiSelect: boolean;
  readonly durationMinutes: number;
  readonly mentionEveryoneOnCreation: boolean;
  readonly mentionEveryoneOnCompletion: boolean;
}

function readVotingCreateRequest(
  interaction: ChatInputCommandInteraction,
): ParsedVotingCreateRequest {
  const pollType = normalizeVotingPollType(
    interaction.options.getString("poll_type", true),
  );
  const durationMinutes =
    interaction.options.getInteger("duration_minutes", false) ?? 0;
  if (
    !Number.isInteger(durationMinutes) ||
    durationMinutes < 0 ||
    durationMinutes > VOTING_PANEL_LIMITS.maxDurationMinutes
  ) {
    throw new RangeError(
      `Duration must be between 0 and ${VOTING_PANEL_LIMITS.maxDurationMinutes} minutes.`,
    );
  }
  return {
    question: normalizeVotingQuestion(
      interaction.options.getString("question", true),
    ),
    title: normalizeVotingTitle(interaction.options.getString("title", false)),
    description: normalizeVotingDescription(
      interaction.options.getString("description", false),
    ),
    pollType,
    options: parseVotingPanelOptions(
      pollType,
      interaction.options.getString("options", false),
    ),
    multiSelect: interaction.options.getBoolean("multi_select", false) ?? false,
    durationMinutes,
    mentionEveryoneOnCreation:
      interaction.options.getBoolean("mention_everyone_on_creation", false) ??
      false,
    mentionEveryoneOnCompletion:
      interaction.options.getBoolean("mention_everyone_on_completion", false) ??
      false,
  };
}

function createVotingPanelView(input: {
  voteId: string;
  guildId: string;
  channelId: string;
  creatorId: string;
  question: string;
  title: string | null;
  description: string | null;
  pollType: "yes-no" | "custom";
  multiSelect: boolean;
  options: ReturnType<typeof parseVotingPanelOptions>;
  deadlineAt: string | null;
  mentionEveryoneOnCreation: boolean;
  mentionEveryoneOnCompletion: boolean;
  createdAt: string;
}): VotingPanelView {
  return {
    voteId: input.voteId,
    guildId: input.guildId,
    channelId: input.channelId,
    messageId: null,
    creatorId: input.creatorId,
    question: input.question,
    title: input.title,
    description: input.description,
    pollType: input.pollType,
    options: input.options.map((option) => ({ ...option, voteCount: 0 })),
    multiSelect: input.multiSelect,
    mentionEveryoneOnCreation: input.mentionEveryoneOnCreation,
    mentionEveryoneOnCompletion: input.mentionEveryoneOnCompletion,
    status: "active",
    createdAt: input.createdAt,
    deadlineAt: input.deadlineAt,
    completedAt: null,
    completedBy: null,
    cancelledAt: null,
    cancelledBy: null,
    totalVoters: 0,
  };
}

async function handleOptionButton(
  interaction: ButtonInteraction,
  runtime: GuildRuntime,
  storage: VotingPanelStorage,
  voteId: string,
  optionId: string,
): Promise<void> {
  await deferPrivate(interaction);
  const panel = getBoundActivePanel(interaction, runtime, storage, voteId);
  if (!panel) {
    await replyPrivate(
      interaction,
      "This voting control is stale, closed, or does not belong to this panel.",
    );
    return;
  }
  if (!panel.options.some((option) => option.optionId === optionId)) {
    await replyPrivate(
      interaction,
      "This voting option is no longer available.",
    );
    return;
  }
  const member = await fetchEligibleVotingMember(interaction, runtime);
  if (!member) {
    await replyPrivate(
      interaction,
      "Could not verify your current server membership and channel access.",
    );
    return;
  }
  const current = storage.getVotingPanel(voteId);
  if (
    !current ||
    !samePanelBinding(panel, current) ||
    current.status !== "active"
  ) {
    await replyPrivate(
      interaction,
      "This voting panel changed while your membership was being verified. Refresh and try again.",
    );
    return;
  }
  const result = current.multiSelect
    ? storage.toggleVotingPanelOption(voteId, member.id, optionId)
    : storage.selectVotingPanelOption(voteId, member.id, optionId);
  if (!isSuccessfulSelection(result)) {
    await replyPrivate(interaction, selectionFailureMessage(result.status));
    return;
  }
  const selection = result.optionIds;
  await replyPrivate(
    interaction,
    current.multiSelect
      ? `Your selections: ${formatSelectedOptions(result.panel, selection)}.`
      : `Your vote: ${formatSelectedOptions(result.panel, selection)}.`,
  );
  scheduleVotingBackground(runtime, async () => {
    await refreshVotingPanelMessage(interaction.message, result.panel).catch(
      () => undefined,
    );
  });
  recordVotingMetric(runtime, "panel.vote.select");
}

async function handleViewVotersButton(
  interaction: ButtonInteraction,
  runtime: GuildRuntime,
  storage: VotingPanelStorage,
  voteId: string,
): Promise<void> {
  await deferPrivate(interaction);
  const panel = getBoundViewablePanel(interaction, runtime, storage, voteId);
  if (!panel) {
    await replyPrivate(
      interaction,
      "This voting control is stale, closed, or does not belong to this panel.",
    );
    return;
  }
  if (!(await fetchEligibleVotingMember(interaction, runtime))) {
    await replyPrivate(
      interaction,
      "Could not verify your current server membership and channel access.",
    );
    return;
  }
  const voters = storage.listVotingPanelVoters(voteId);
  await replyPrivateEmbed(interaction, buildVoterListEmbed(panel, voters));
}

async function handlePanelOptionsButton(
  interaction: ButtonInteraction,
  runtime: GuildRuntime,
  storage: VotingPanelStorage,
  voteId: string,
): Promise<void> {
  await deferPrivate(interaction);
  const panel = getBoundActivePanel(interaction, runtime, storage, voteId);
  if (!panel) {
    await replyPrivate(
      interaction,
      "This voting panel is stale, closed, or does not belong to this panel.",
    );
    return;
  }
  if (!interaction.guild) {
    await replyPrivate(
      interaction,
      "This voting panel is no longer available.",
    );
    return;
  }
  if (
    !(await fetchVotingAdministrator(interaction.guild, interaction.user.id))
  ) {
    await replyPrivate(
      interaction,
      "You need Discord's Administrator permission to open panel options.",
    );
    return;
  }
  await replyPrivatePayload(interaction, buildVotingPanelOptionsPayload(panel));
}

async function handleManagementButton(
  interaction: ButtonInteraction,
  runtime: GuildRuntime,
  storage: VotingPanelStorage,
  parsed:
    | {
        readonly kind: "close";
        readonly voteId: string;
        readonly panelMessageId?: string;
      }
    | {
        readonly kind: "cancel";
        readonly voteId: string;
        readonly panelMessageId?: string;
      },
): Promise<void> {
  const guild = interaction.guild;
  if (!guild || guild.id !== runtime.guildId || !runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This voting panel is no longer available.",
    );
    return;
  }
  const administrator = await fetchVotingAdministrator(
    guild,
    interaction.user.id,
  );
  if (!administrator) {
    await replyPrivate(
      interaction,
      "You need Discord's Administrator permission to close or cancel this vote.",
    );
    return;
  }
  const sourceMessage = await resolveVotingManagementMessage(
    interaction,
    parsed.panelMessageId,
  );
  const fromPanelOptions = Boolean(parsed.panelMessageId);
  if (!sourceMessage) {
    await replyPrivate(
      interaction,
      "This voting panel is stale, closed, or does not belong to this panel.",
    );
    return;
  }
  if (fromPanelOptions) await deferPrivate(interaction);
  else await deferPublic(interaction);
  const panel = getBoundActivePanel(
    interaction,
    runtime,
    storage,
    parsed.voteId,
    sourceMessage,
  );
  if (!panel) {
    const message =
      "This voting panel is stale, closed, or does not belong to this message.";
    if (fromPanelOptions) await replyPrivate(interaction, message);
    else await replyPublic(interaction, message);
    return;
  }
  const transition = storage.transitionVotingPanel(
    parsed.voteId,
    parsed.kind === "close" ? "completed" : "cancelled",
    administrator.id,
    new Date().toISOString(),
  );
  if (transition.status === "not-found" || !transition.panel) {
    if (fromPanelOptions) {
      await replyPrivate(
        interaction,
        "This voting panel is no longer available.",
      );
    } else {
      await replyPublic(
        interaction,
        "This voting panel is no longer available.",
      );
    }
    return;
  }

  const channel = getInteractionVotingChannel(interaction);
  const transitionedPanel = transition.panel;
  if (!transitionedPanel) return;
  const action =
    transitionedPanel.status === "completed" ? "completed" : "cancelled";
  if (transition.status === "transitioned") {
    recordVotingMetric(
      runtime,
      action === "completed" ? "panel.vote.close" : "panel.vote.cancel",
    );
  }
  const response =
    transition.status === "transitioned"
      ? `Vote ${action}.`
      : `This vote was already ${action}.`;
  if (fromPanelOptions) await replyPrivate(interaction, response);
  else await replyPublic(interaction, response);
  scheduleVotingBackground(runtime, async () => {
    const botMember = await getCurrentBotMember(guild);
    const allowCompletionMention = Boolean(
      parsed.kind === "close" &&
      transitionedPanel.status === "completed" &&
      transitionedPanel.mentionEveryoneOnCompletion &&
      botMember &&
      channel
        ?.permissionsFor(botMember)
        ?.has(PermissionFlagsBits.MentionEveryone),
    );
    await deliverVotingPanelCompletion(sourceMessage, transitionedPanel, {
      allowEveryoneMention: allowCompletionMention,
    }).catch(() => undefined);
  });
}

async function resolveVotingManagementMessage(
  interaction: ButtonInteraction,
  panelMessageId: string | undefined,
): Promise<Message | null> {
  if (!panelMessageId || panelMessageId === interaction.message.id) {
    return interaction.message;
  }
  const channel = getInteractionVotingChannel(interaction);
  if (!channel) return null;
  try {
    return await channel.messages.fetch(panelMessageId);
  } catch {
    return null;
  }
}

function getBoundActivePanel(
  interaction: ButtonInteraction,
  runtime: GuildRuntime,
  storage: VotingPanelStorage,
  voteId: string,
  sourceMessage: Message = interaction.message,
): VotingPanel | null {
  const panel = getBoundVotingPanel(
    interaction,
    runtime,
    storage,
    voteId,
    sourceMessage,
  );
  if (!panel || panel.status !== "active") {
    return null;
  }
  return panel;
}

function getBoundViewablePanel(
  interaction: ButtonInteraction,
  runtime: GuildRuntime,
  storage: VotingPanelStorage,
  voteId: string,
): VotingPanel | null {
  const panel = getBoundVotingPanel(interaction, runtime, storage, voteId);
  return panel?.status === "cancelled" ? null : panel;
}

function getBoundVotingPanel(
  interaction: ButtonInteraction,
  runtime: GuildRuntime,
  storage: VotingPanelStorage,
  voteId: string,
  sourceMessage: Message = interaction.message,
): VotingPanel | null {
  const panel = storage.getVotingPanel(voteId);
  if (
    !panel ||
    !runtime.isCurrent() ||
    panel.guildId !== runtime.guildId ||
    interaction.guild?.id !== runtime.guildId ||
    interaction.guildId !== runtime.guildId ||
    panel.channelId !== interaction.channelId ||
    panel.messageId !== sourceMessage.id ||
    sourceMessage.author?.id !== interaction.client.user?.id
  ) {
    return null;
  }
  return panel;
}

function samePanelBinding(left: VotingPanel, right: VotingPanel): boolean {
  return (
    left.guildId === right.guildId &&
    left.voteId === right.voteId &&
    left.channelId === right.channelId &&
    left.messageId === right.messageId &&
    left.updatedAt === right.updatedAt
  );
}

async function fetchEligibleVotingMember(
  interaction: ButtonInteraction,
  runtime: GuildRuntime,
): Promise<GuildMember | null> {
  const guild = interaction.guild;
  if (!guild || guild.id !== runtime.guildId) return null;
  const verified = await fetchVerifiedGuildMember(guild, interaction.user.id);
  if (!verified.valid || verified.member.user.bot) return null;
  const channel = getInteractionVotingChannel(interaction);
  if (
    !channel
      ?.permissionsFor(verified.member)
      ?.has(PermissionFlagsBits.ViewChannel)
  ) {
    return null;
  }
  return verified.member;
}

async function fetchVotingAdministrator(
  guild: Guild,
  userId: string,
): Promise<GuildMember | null> {
  const verified = await fetchVerifiedGuildMember(guild, userId);
  if (
    !verified.valid ||
    verified.member.user.bot ||
    !verified.member.permissions.has(PermissionFlagsBits.Administrator)
  ) {
    return null;
  }
  return verified.member;
}

function getCurrentVotingChannel(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): GuildTextBasedChannel | null {
  const candidate = interaction.channel as GuildTextBasedChannel | null;
  if (
    !candidate ||
    candidate.isDMBased() ||
    !candidate.isTextBased() ||
    candidate.guild.id !== runtime.guildId ||
    !("send" in candidate)
  ) {
    return null;
  }
  return candidate;
}

function getInteractionVotingChannel(
  interaction: ButtonInteraction,
): GuildTextBasedChannel | null {
  const candidate = interaction.channel as GuildTextBasedChannel | null;
  if (!candidate || candidate.isDMBased() || !candidate.isTextBased()) {
    return null;
  }
  return candidate;
}

async function getCurrentBotMember(guild: Guild): Promise<GuildMember | null> {
  return guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
}

function getMissingVotingPermissions(
  channel: GuildTextBasedChannel,
  botMember: GuildMember | null,
): string[] {
  const permissions = botMember ? channel.permissionsFor(botMember) : null;
  const sendPermission = channel.isThread()
    ? PermissionFlagsBits.SendMessagesInThreads
    : PermissionFlagsBits.SendMessages;
  const expected: Array<[bigint, string]> = [
    [PermissionFlagsBits.ViewChannel, "View Channel"],
    [
      sendPermission,
      channel.isThread() ? "Send Messages in Threads" : "Send Messages",
    ],
    [PermissionFlagsBits.ReadMessageHistory, "Read Message History"],
    [PermissionFlagsBits.EmbedLinks, "Embed Links"],
  ];
  return expected
    .filter(([permission]) => !permissions?.has(permission))
    .map(([, label]) => label);
}

function isSuccessfulSelection(
  result: VotingPanelSelectionResult,
): result is Extract<
  VotingPanelSelectionResult,
  { status: "changed" | "unchanged" }
> {
  return result.status === "changed" || result.status === "unchanged";
}

function selectionFailureMessage(
  status: Exclude<
    VotingPanelSelectionResult["status"],
    "changed" | "unchanged"
  >,
): string {
  switch (status) {
    case "not-found":
      return "This voting panel no longer exists.";
    case "not-active":
      return "Voting is no longer active for this panel.";
    case "mode-mismatch":
      return "This panel's selection mode changed. Refresh the message and try again.";
  }
}

function formatSelectedOptions(
  panel: VotingPanel,
  optionIds: readonly string[],
): string {
  const byId = new Map(
    panel.options.map((option) => [option.optionId, option]),
  );
  const labels = optionIds
    .map((id) => byId.get(id)?.label)
    .filter((label): label is string => Boolean(label))
    .map((label) => `**${escapeMarkdown(label).replace(/@/gu, "@\u200b")}**`);
  return labels.length > 0 ? labels.join(", ") : "none";
}

function buildVoterListEmbed(
  panel: VotingPanel,
  voters: readonly VotingPanelVoter[],
): EmbedBuilder {
  const grouped = new Map<string, string[]>();
  for (const option of panel.options) grouped.set(option.optionId, []);
  for (const voter of voters) {
    for (const optionId of voter.optionIds) {
      grouped.get(optionId)?.push(voter.voterId);
    }
  }
  const embed = new EmbedBuilder()
    .setColor(SUPERIOR_PANEL_COLOR)
    .setTitle("Voting panel voters")
    .setDescription(
      `Current selections for **${escapeMarkdown(panel.title ?? panel.question)
        .replace(/@/gu, "@\u200b")
        .slice(0, 200)}**`,
    )
    .setFooter({
      text: "How to use: these voter lists are visible only to you.",
    });
  for (const option of panel.options) {
    const voterIds = grouped.get(option.optionId) ?? [];
    const mentions = voterIds.map((voterId) => `<@${voterId}>`);
    const rendered = truncateVoterList(mentions);
    embed.addFields({
      name: `${escapeMarkdown(option.label).replace(/@/gu, "@\u200b").slice(0, 200)} (${option.voteCount})`,
      value: rendered || "No voters",
      inline: false,
    });
  }
  return embed;
}

function truncateVoterList(mentions: readonly string[]): string {
  const output: string[] = [];
  let length = 0;
  for (const mention of mentions) {
    const separator = output.length === 0 ? "" : ", ";
    if (length + separator.length + mention.length > 900) break;
    output.push(mention);
    length += separator.length + mention.length;
  }
  if (output.length === mentions.length) return output.join(", ");
  const remaining = mentions.length - output.length;
  return `${output.join(", ")}\n…and ${remaining} more.`.slice(0, 1_024);
}

async function deferPrivate(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await observeLatency(
      "discord.deferReply",
      "deferReply",
      () => interaction.deferReply({ flags: MessageFlags.Ephemeral }),
      { guildId: interaction.guildId ?? "dm" },
      "info",
    );
  }
}

async function deferPublic(
  interaction: ButtonInteraction | ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.deferred && !interaction.replied)
    await observeLatency(
      "discord.deferReply",
      "deferReply",
      () => interaction.deferReply(),
      { guildId: interaction.guildId ?? "dm" },
      "info",
    );
}

async function replyPrivate(
  interaction: ButtonInteraction | ChatInputCommandInteraction,
  content: string,
): Promise<void> {
  if (interaction.deferred && !interaction.replied) {
    await observeLatency(
      "discord.editReply",
      "editReply",
      () =>
        interaction.editReply({
          content,
          allowedMentions: SAFE_ALLOWED_MENTIONS,
        }),
      { guildId: interaction.guildId ?? "dm" },
      "info",
    );
    return;
  }
  if (interaction.replied) {
    await observeLatency(
      "discord.followUp",
      "followUp",
      () =>
        interaction.followUp({
          content,
          flags: MessageFlags.Ephemeral,
          allowedMentions: SAFE_ALLOWED_MENTIONS,
        }),
      { guildId: interaction.guildId ?? "dm" },
      "info",
    );
    return;
  }
  await observeLatency(
    "discord.reply",
    "reply",
    () =>
      interaction.reply({
        content,
        flags: MessageFlags.Ephemeral,
        allowedMentions: SAFE_ALLOWED_MENTIONS,
      }),
    { guildId: interaction.guildId ?? "dm" },
    "info",
  );
}

async function replyPrivateEmbed(
  interaction: ButtonInteraction,
  embed: EmbedBuilder,
): Promise<void> {
  await replyPrivatePayload(interaction, {
    embeds: [embed],
    allowedMentions: SAFE_ALLOWED_MENTIONS,
  });
}

async function replyPrivatePayload(
  interaction: ButtonInteraction,
  payload: MessageEditOptions & MessageCreateOptions,
): Promise<void> {
  if (interaction.deferred && !interaction.replied) {
    await observeLatency(
      "discord.editReply",
      "editReply",
      () => interaction.editReply(payload),
      { guildId: interaction.guildId ?? "dm" },
      "info",
    );
    return;
  }
  await observeLatency(
    "discord.reply",
    "reply",
    () => interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }),
    { guildId: interaction.guildId ?? "dm" },
    "info",
  );
}

async function replyPublic(
  interaction: ButtonInteraction | ChatInputCommandInteraction,
  content: string,
): Promise<void> {
  if (interaction.deferred && !interaction.replied) {
    await observeLatency(
      "discord.editReply",
      "editReply",
      () =>
        interaction.editReply({
          content,
          allowedMentions: SAFE_ALLOWED_MENTIONS,
        }),
      { guildId: interaction.guildId ?? "dm" },
      "info",
    );
    return;
  }
  if (interaction.replied) {
    await observeLatency(
      "discord.followUp",
      "followUp",
      () =>
        interaction.followUp({
          content,
          allowedMentions: SAFE_ALLOWED_MENTIONS,
        }),
      { guildId: interaction.guildId ?? "dm" },
      "info",
    );
    return;
  }
  await observeLatency(
    "discord.reply",
    "reply",
    () =>
      interaction.reply({ content, allowedMentions: SAFE_ALLOWED_MENTIONS }),
    { guildId: interaction.guildId ?? "dm" },
    "info",
  );
}

function createVotingPanelId(): string {
  return `vote_${randomUUID().replaceAll("-", "").slice(0, 19)}`;
}

function recordVotingMetric(runtime: GuildRuntime, key: string): void {
  const metrics = runtime.storage as unknown as {
    recordCommandMetric?: (metric: string) => void;
  };
  metrics.recordCommandMetric?.(key);
}

function scheduleVotingBackground(
  runtime: GuildRuntime,
  task: () => Promise<void>,
): void {
  if (runtime.runInBackground) {
    runtime.runInBackground(task);
    return;
  }
  void Promise.resolve()
    .then(task)
    .catch(() => undefined);
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Voting panel validation failed.";
}
