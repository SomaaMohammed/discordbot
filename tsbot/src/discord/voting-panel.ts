import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  escapeMarkdown,
  type MessageMentionOptions,
} from "discord.js";

/** Prefix shared by every persistent voting-panel component. */
export const VOTING_PANEL_COMPONENT_PREFIX = "superior:vote:";

export const VOTING_PANEL_LIMITS = Object.freeze({
  question: 256,
  title: 256,
  description: 4_096,
  optionLabel: 80,
  minOptions: 2,
  maxOptions: 10,
  maxDurationMinutes: 20_160,
  maxCustomIdLength: 100,
});

export type VotingPollType = "yes-no" | "custom";
export type VotingPanelStatus = "active" | "completed" | "cancelled";

export interface VotingOptionInput {
  readonly optionId: string;
  readonly label: string;
}

export interface VotingOptionView extends VotingOptionInput {
  readonly voteCount: number;
}

/**
 * The persisted subset needed to render the public message. The storage layer
 * deliberately owns identity allocation and all state transitions.
 */
export interface VotingPanelView {
  readonly voteId: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly messageId: string | null;
  readonly creatorId: string;
  readonly question: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly pollType: VotingPollType;
  readonly options: readonly VotingOptionView[];
  readonly multiSelect: boolean;
  readonly mentionEveryoneOnCreation: boolean;
  readonly mentionEveryoneOnCompletion: boolean;
  readonly status: VotingPanelStatus;
  readonly createdAt: string;
  readonly deadlineAt: string | null;
  readonly completedAt: string | null;
  readonly completedBy: string | null;
  readonly cancelledAt: string | null;
  readonly cancelledBy: string | null;
  readonly totalVoters: number;
}

export interface VotingPanelPayload {
  readonly content?: string;
  readonly embeds: readonly [EmbedBuilder];
  readonly components: readonly ActionRowBuilder<ButtonBuilder>[];
  readonly allowedMentions: Readonly<MessageMentionOptions>;
}

export interface VotingPanelPayloadOptions {
  /** Enables the one explicitly requested @everyone notification. */
  readonly allowEveryoneMention?: boolean;
  /** Uses the creation mention preference rather than completion preference. */
  readonly phase?: "creation" | "completion" | "normal";
}

export type ParsedVotingPanelComponent =
  | {
      readonly kind: "option";
      readonly voteId: string;
      readonly optionId: string;
    }
  | { readonly kind: "view-voters"; readonly voteId: string }
  | { readonly kind: "close"; readonly voteId: string }
  | { readonly kind: "cancel"; readonly voteId: string };

const SAFE_ALLOWED_MENTIONS: Readonly<MessageMentionOptions> = Object.freeze({
  parse: Object.freeze([]),
});

const EVERYONE_ALLOWED_MENTIONS: Readonly<MessageMentionOptions> =
  Object.freeze({
    parse: Object.freeze(["everyone" as const]),
  });

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

/**
 * Normalizes the command's poll-type choice while accepting the compact forms
 * used by Discord choice values in older registrations.
 */
export function normalizeVotingPollType(value: string): VotingPollType {
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  if (
    normalized === "yes-no" ||
    normalized === "yes_no" ||
    normalized === "yes/no" ||
    normalized === "yesno"
  ) {
    return "yes-no";
  }
  if (normalized === "custom") return "custom";
  throw new TypeError("Poll type must be yes/no or custom.");
}

export function normalizeVotingQuestion(value: string): string {
  return normalizeSingleLine(
    value,
    "Voting question",
    VOTING_PANEL_LIMITS.question,
  );
}

export function normalizeVotingTitle(value: string | null): string | null {
  if (value === null) return null;
  return normalizeSingleLine(value, "Voting title", VOTING_PANEL_LIMITS.title);
}

export function normalizeVotingDescription(
  value: string | null,
): string | null {
  if (value === null) return null;
  const normalized = value.normalize("NFKC").trim();
  if (!normalized) throw new TypeError("Voting description cannot be empty.");
  if (normalized.length > VOTING_PANEL_LIMITS.description) {
    throw new RangeError(
      `Voting description must be at most ${VOTING_PANEL_LIMITS.description} characters.`,
    );
  }
  return normalized;
}

/**
 * Parses custom options from one option per line. An explicit option ID is
 * deterministic for the new record; storage may retain these values verbatim.
 */
export function parseVotingPanelOptions(
  pollType: string,
  customOptions: string | null,
): VotingOptionInput[] {
  const type = normalizeVotingPollType(pollType);
  const supplied = customOptions?.normalize("NFKC") ?? "";
  if (type === "yes-no") {
    if (supplied.trim()) {
      throw new TypeError("Yes/no polls cannot include custom options.");
    }
    return [
      { optionId: "option-1", label: "Yes" },
      { optionId: "option-2", label: "No" },
    ];
  }

  const trimmed = supplied.trim();
  if (!trimmed) {
    throw new TypeError("Custom polls require one option on each line.");
  }
  const labels = trimmed.split(/\r?\n/u).map((line, index) => {
    const label = line.replace(/\s+/gu, " ").trim();
    if (!label) {
      throw new TypeError(`Custom option ${index + 1} cannot be empty.`);
    }
    if (label.length > VOTING_PANEL_LIMITS.optionLabel) {
      throw new RangeError(
        `Custom option ${index + 1} must be at most ${VOTING_PANEL_LIMITS.optionLabel} characters.`,
      );
    }
    return label;
  });
  if (
    labels.length < VOTING_PANEL_LIMITS.minOptions ||
    labels.length > VOTING_PANEL_LIMITS.maxOptions
  ) {
    throw new RangeError(
      `Custom polls require ${VOTING_PANEL_LIMITS.minOptions}-${VOTING_PANEL_LIMITS.maxOptions} options.`,
    );
  }
  const unique = new Set(
    labels.map((label) => label.toLocaleLowerCase("en-US")),
  );
  if (unique.size !== labels.length) {
    throw new TypeError("Custom poll options must be unique.");
  }
  return labels.map((label, index) => ({
    optionId: `option-${index + 1}`,
    label,
  }));
}

export function createVotingOptionCustomId(
  voteId: string,
  optionId: string,
): string {
  return checkedCustomId(
    `${VOTING_PANEL_COMPONENT_PREFIX}${checkedOpaqueId(voteId, "vote")}:option:${checkedOpaqueId(optionId, "option")}`,
  );
}

export function createVotingViewVotersCustomId(voteId: string): string {
  return checkedCustomId(
    `${VOTING_PANEL_COMPONENT_PREFIX}${checkedOpaqueId(voteId, "vote")}:view`,
  );
}

export function createVotingCloseCustomId(voteId: string): string {
  return checkedCustomId(
    `${VOTING_PANEL_COMPONENT_PREFIX}${checkedOpaqueId(voteId, "vote")}:close`,
  );
}

export function createVotingCancelCustomId(voteId: string): string {
  return checkedCustomId(
    `${VOTING_PANEL_COMPONENT_PREFIX}${checkedOpaqueId(voteId, "vote")}:cancel`,
  );
}

export function parseVotingPanelComponentId(
  customId: string,
): ParsedVotingPanelComponent | null {
  if (!customId.startsWith(VOTING_PANEL_COMPONENT_PREFIX)) return null;
  const parts = customId.slice(VOTING_PANEL_COMPONENT_PREFIX.length).split(":");
  const [voteId, action, optionId] = parts;
  if (!voteId || !OPAQUE_ID_PATTERN.test(voteId)) return null;
  if (
    action === "option" &&
    parts.length === 3 &&
    optionId &&
    OPAQUE_ID_PATTERN.test(optionId)
  ) {
    return { kind: "option", voteId, optionId };
  }
  if (parts.length !== 2) return null;
  if (action === "view") return { kind: "view-voters", voteId };
  if (action === "close") return { kind: "close", voteId };
  if (action === "cancel") return { kind: "cancel", voteId };
  return null;
}

/** Builds a public payload for creation, refresh, completion, or cancellation. */
export function buildVotingPanelPayload(
  panel: VotingPanelView,
  options: VotingPanelPayloadOptions = {},
): VotingPanelPayload {
  validateVotingPanelView(panel);
  const completionMention =
    options.phase === "completion" &&
    panel.status === "completed" &&
    panel.mentionEveryoneOnCompletion;
  const creationMention =
    options.phase === "creation" &&
    panel.status === "active" &&
    panel.mentionEveryoneOnCreation;
  const includeEveryone =
    options.allowEveryoneMention === true &&
    (completionMention || creationMention);
  return {
    ...(includeEveryone ? { content: "@everyone" } : {}),
    embeds: [buildVotingPanelEmbed(panel)],
    components: buildVotingPanelComponents(panel),
    allowedMentions: includeEveryone
      ? EVERYONE_ALLOWED_MENTIONS
      : SAFE_ALLOWED_MENTIONS,
  };
}

export function buildVotingPanelEmbed(panel: VotingPanelView): EmbedBuilder {
  validateVotingPanelView(panel);
  const displayTitle = panel.title ?? panel.question;
  const description = [
    panel.title
      ? `**Question:** ${safeEmbedText(panel.question, 1_000)}`
      : null,
    panel.description ? safeEmbedText(panel.description, 3_000) : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
  const embed = new EmbedBuilder()
    .setColor(0xd4af37)
    .setTitle(safeEmbedText(displayTitle, 256))
    .setDescription(description || null)
    .addFields(
      {
        name: "Status",
        value: `**${formatStatus(panel.status)}**`,
        inline: true,
      },
      {
        name: "Poll type",
        value: panel.pollType === "yes-no" ? "Yes / No" : "Custom",
        inline: true,
      },
      {
        name: "Selection",
        value: panel.multiSelect ? "Multiple options" : "One option",
        inline: true,
      },
      {
        name: "Votes",
        value: optionVoteLines(panel.options),
      },
      {
        name: "Total voters",
        value: `**${safeCount(panel.totalVoters)}**`,
        inline: true,
      },
      {
        name: "Deadline",
        value: panel.deadlineAt
          ? `<t:${toUnixSeconds(panel.deadlineAt)}:F> (<t:${toUnixSeconds(panel.deadlineAt)}:R>)`
          : "Manual close",
        inline: true,
      },
      {
        name: "Creator",
        value: `\`${safeCodeText(panel.creatorId)}\``,
        inline: true,
      },
      {
        name: "Created",
        value: `<t:${toUnixSeconds(panel.createdAt)}:F>`,
        inline: true,
      },
    )
    .setFooter({ text: votingFooter(panel) });
  const outcome = completionOutcome(panel);
  if (outcome) embed.addFields({ name: "Result", value: outcome });
  if (panel.status === "completed" && panel.completedAt) {
    embed.addFields({
      name: "Completed",
      value: completionMetadata(panel.completedAt, panel.completedBy),
      inline: true,
    });
  }
  if (panel.status === "cancelled" && panel.cancelledAt) {
    embed.addFields({
      name: "Cancelled",
      value: completionMetadata(panel.cancelledAt, panel.cancelledBy),
      inline: true,
    });
  }
  return embed;
}

/**
 * Ten option buttons occupy at most two rows, with the three management
 * controls in the final row. This stays below Discord's five-row maximum.
 */
export function buildVotingPanelComponents(
  panel: VotingPanelView,
): ActionRowBuilder<ButtonBuilder>[] {
  validateVotingPanelView(panel);
  const votingDisabled = panel.status !== "active";
  const viewVotersDisabled = panel.status === "cancelled";
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let start = 0; start < panel.options.length; start += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    const optionSlice = panel.options.slice(start, start + 5);
    row.addComponents(
      optionSlice.map((option) =>
        new ButtonBuilder()
          .setCustomId(
            createVotingOptionCustomId(panel.voteId, option.optionId),
          )
          .setLabel(optionButtonLabel(option))
          .setStyle(ButtonStyle.Primary)
          .setDisabled(votingDisabled),
      ),
    );
    rows.push(row);
  }
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(createVotingViewVotersCustomId(panel.voteId))
        .setLabel("View voters")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(viewVotersDisabled),
      new ButtonBuilder()
        .setCustomId(createVotingCloseCustomId(panel.voteId))
        .setLabel("Close vote")
        .setStyle(ButtonStyle.Success)
        .setDisabled(votingDisabled),
      new ButtonBuilder()
        .setCustomId(createVotingCancelCustomId(panel.voteId))
        .setLabel("Cancel vote")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(votingDisabled),
    ),
  );
  return rows;
}

function validateVotingPanelView(panel: VotingPanelView): void {
  checkedOpaqueId(panel.voteId, "vote");
  if (!panel.guildId || !panel.channelId || !panel.creatorId) {
    throw new TypeError("Voting panel identity is incomplete.");
  }
  normalizeVotingQuestion(panel.question);
  if (panel.title !== null) normalizeVotingTitle(panel.title);
  if (panel.description !== null) normalizeVotingDescription(panel.description);
  if (panel.pollType !== "yes-no" && panel.pollType !== "custom") {
    throw new TypeError("Voting panel poll type is invalid.");
  }
  if (
    panel.status !== "active" &&
    panel.status !== "completed" &&
    panel.status !== "cancelled"
  ) {
    throw new TypeError("Voting panel status is invalid.");
  }
  if (!Number.isInteger(panel.totalVoters) || panel.totalVoters < 0) {
    throw new RangeError("Voting panel voter count is invalid.");
  }
  if (
    panel.options.length < VOTING_PANEL_LIMITS.minOptions ||
    panel.options.length > VOTING_PANEL_LIMITS.maxOptions
  ) {
    throw new RangeError("Voting panel must contain 2-10 options.");
  }
  const optionIds = new Set<string>();
  const labels = new Set<string>();
  for (const option of panel.options) {
    checkedOpaqueId(option.optionId, "option");
    const label = normalizeSingleLine(
      option.label,
      "Voting option",
      VOTING_PANEL_LIMITS.optionLabel,
    );
    if (!Number.isInteger(option.voteCount) || option.voteCount < 0) {
      throw new RangeError("Voting option count is invalid.");
    }
    if (optionIds.has(option.optionId)) {
      throw new TypeError("Voting panel option IDs must be unique.");
    }
    const labelKey = label.toLocaleLowerCase("en-US");
    if (labels.has(labelKey)) {
      throw new TypeError("Voting panel option labels must be unique.");
    }
    optionIds.add(option.optionId);
    labels.add(labelKey);
  }
}

function normalizeSingleLine(
  value: string,
  label: string,
  maximum: number,
): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be text.`);
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized) throw new TypeError(`${label} cannot be empty.`);
  if (normalized.length > maximum) {
    throw new RangeError(`${label} must be at most ${maximum} characters.`);
  }
  return normalized;
}

function checkedOpaqueId(value: string, label: string): string {
  if (!OPAQUE_ID_PATTERN.test(value)) {
    throw new TypeError(`${label} ID must be an opaque URL-safe identifier.`);
  }
  return value;
}

function checkedCustomId(value: string): string {
  if (value.length > VOTING_PANEL_LIMITS.maxCustomIdLength) {
    throw new RangeError("Voting control exceeds Discord's custom ID limit.");
  }
  return value;
}

function safeEmbedText(value: string, maximum: number): string {
  return escapeMarkdown(
    value.normalize("NFKC").replace(/@/gu, "@\u200b"),
  ).slice(0, maximum);
}

function safeCodeText(value: string): string {
  return value.replace(/[`\\]/gu, "\\$&").slice(0, 100);
}

function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function optionButtonLabel(option: VotingOptionView): string {
  const suffix = ` · ${safeCount(option.voteCount)}`;
  const available = Math.max(
    1,
    VOTING_PANEL_LIMITS.optionLabel - suffix.length,
  );
  return `${safeEmbedText(option.label, available)}${suffix}`;
}

function optionVoteLines(options: readonly VotingOptionView[]): string {
  const lines = options.map(
    (option, index) =>
      `${index + 1}. ${safeEmbedText(option.label, 900)} — **${safeCount(option.voteCount)}**`,
  );
  return lines.join("\n").slice(0, 1_024) || "No options available.";
}

function formatStatus(status: VotingPanelStatus): string {
  switch (status) {
    case "active":
      return "Active";
    case "completed":
      return "Completed";
    case "cancelled":
      return "Cancelled";
  }
}

function votingFooter(panel: VotingPanelView): string {
  if (panel.status !== "active") {
    return "How to use: this vote is closed; review the final results above.";
  }
  return panel.multiSelect
    ? "How to use: click an option to toggle it, then use View voters to inspect selections."
    : "How to use: click an option to cast or change your vote, then use View voters to inspect selections.";
}

function completionOutcome(panel: VotingPanelView): string | null {
  if (panel.status !== "completed") return null;
  const highest = Math.max(
    ...panel.options.map((option) => safeCount(option.voteCount)),
  );
  if (highest === 0) return "No votes were cast.";
  const winners = panel.options.filter(
    (option) => safeCount(option.voteCount) === highest,
  );
  if (winners.length === 1) {
    return `Winner: **${safeEmbedText(winners[0]!.label, 900)}** with **${highest}** vote${highest === 1 ? "" : "s"}.`;
  }
  return `Tie: ${winners
    .map((option) => `**${safeEmbedText(option.label, 180)}**`)
    .join(", ")} with **${highest}** votes each.`;
}

function completionMetadata(timestamp: string, actorId: string | null): string {
  const actor = actorId ? ` by \`${safeCodeText(actorId)}\`` : "";
  return `<t:${toUnixSeconds(timestamp)}:F>${actor}`;
}

function toUnixSeconds(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed)
    ? Math.floor(parsed / 1_000)
    : Math.floor(Date.now() / 1_000);
}
