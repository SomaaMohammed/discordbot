import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  escapeMarkdown,
  type MessageMentionOptions,
} from "discord.js";
import { SUPERIOR_PANEL_COLOR } from "./panel-theme.js";

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

const VOTING_PANEL_STATUS_COLORS = Object.freeze({
  active: SUPERIOR_PANEL_COLOR,
  completed: SUPERIOR_PANEL_COLOR,
  cancelled: SUPERIOR_PANEL_COLOR,
});
const VOTE_BAR_WIDTH = 8;
const DISCORD_USER_ID_PATTERN = /^\d{17,20}$/u;

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
  | { readonly kind: "panel-options"; readonly voteId: string }
  | {
      readonly kind: "close";
      readonly voteId: string;
      readonly panelMessageId?: string;
    }
  | {
      readonly kind: "cancel";
      readonly voteId: string;
      readonly panelMessageId?: string;
    };

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

export function createVotingPanelOptionsCustomId(voteId: string): string {
  return checkedCustomId(
    `${VOTING_PANEL_COMPONENT_PREFIX}${checkedOpaqueId(voteId, "vote")}:options`,
  );
}

export function createVotingCloseCustomId(
  voteId: string,
  panelMessageId?: string,
): string {
  return checkedCustomId(
    `${VOTING_PANEL_COMPONENT_PREFIX}${checkedOpaqueId(voteId, "vote")}:close${panelMessageId ? `:${checkedOpaqueId(panelMessageId, "panel message")}` : ""}`,
  );
}

export function createVotingCancelCustomId(
  voteId: string,
  panelMessageId?: string,
): string {
  return checkedCustomId(
    `${VOTING_PANEL_COMPONENT_PREFIX}${checkedOpaqueId(voteId, "vote")}:cancel${panelMessageId ? `:${checkedOpaqueId(panelMessageId, "panel message")}` : ""}`,
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
  if (action === "options" && parts.length === 2) {
    return { kind: "panel-options", voteId };
  }
  if (
    (action === "close" || action === "cancel") &&
    (parts.length === 2 ||
      (parts.length === 3 &&
        optionId !== undefined &&
        OPAQUE_ID_PATTERN.test(optionId)))
  ) {
    return {
      kind: action,
      voteId,
      ...(parts.length === 3 ? { panelMessageId: optionId } : {}),
    };
  }
  if (parts.length !== 2) return null;
  if (action === "view") return { kind: "view-voters", voteId };
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
  const metadata = [
    formatStatus(panel.status),
    panel.multiSelect ? "Choose multiple" : "Choose one",
    panel.status === "active"
      ? panel.deadlineAt
        ? `Ends <t:${toUnixSeconds(panel.deadlineAt)}:R>`
        : "No deadline"
      : endedMetadata(panel),
  ].join("  •  ");
  const embed = new EmbedBuilder()
    .setColor(VOTING_PANEL_STATUS_COLORS[panel.status])
    .setAuthor({ name: "Voting panel" })
    .setTitle(safeEmbedText(displayTitle, 256))
    .setDescription(
      [
        panel.title ? `> ${safeEmbedText(panel.question, 1_000)}` : null,
        metadata,
      ]
        .filter((value): value is string => Boolean(value))
        .join("\n\n"),
    )
    .addFields({
      name: `Results  •  ${safeCount(panel.totalVoters)} voter${panel.totalVoters === 1 ? "" : "s"}`,
      value: optionVoteLines(panel.options),
    })
    .setFooter({ text: votingFooter(panel) });
  const outcome = completionOutcome(panel);
  if (outcome) embed.addFields({ name: "Result", value: outcome });
  if (panel.status === "completed" && panel.completedAt) {
    embed.addFields({
      name: "Completed",
      value: completionMetadata(panel.completedAt, panel.creatorId),
      inline: true,
    });
  }
  if (panel.status === "cancelled" && panel.cancelledAt) {
    embed.addFields({
      name: "Cancelled",
      value: completionMetadata(panel.cancelledAt, panel.creatorId),
      inline: true,
    });
  }
  return embed;
}

/** Builds the private administrator menu opened by the public Panel options button. */
export function buildVotingPanelOptionsPayload(
  panel: VotingPanelView,
): VotingPanelPayload {
  validateVotingPanelView(panel);
  if (!panel.messageId) {
    throw new TypeError("Voting panel options require a posted panel message.");
  }
  const embed = new EmbedBuilder()
    .setColor(SUPERIOR_PANEL_COLOR)
    .setTitle("Panel options")
    .setDescription(
      "Administrator controls for this vote. These actions update the public panel.",
    )
    .addFields(
      {
        name: "Close vote",
        value: "End voting and publish the final result.",
        inline: true,
      },
      {
        name: "Cancel vote",
        value: "End voting without publishing a winner.",
        inline: true,
      },
    )
    .setFooter({ text: "Only server Administrators can use these controls." });
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(createVotingCloseCustomId(panel.voteId, panel.messageId))
          .setLabel("Close vote")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(
            createVotingCancelCustomId(panel.voteId, panel.messageId),
          )
          .setLabel("Cancel vote")
          .setStyle(ButtonStyle.Danger),
      ),
    ],
    allowedMentions: SAFE_ALLOWED_MENTIONS,
  };
}

/**
 * Ten option buttons occupy at most two rows, with the two panel controls in
 * the final row. This stays below Discord's five-row maximum.
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
          .setStyle(optionButtonStyle(panel, option))
          .setDisabled(votingDisabled),
      ),
    );
    rows.push(row);
  }
  const utilityButtons = [
    new ButtonBuilder()
      .setCustomId(createVotingViewVotersCustomId(panel.voteId))
      .setLabel("View voters")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(viewVotersDisabled),
    new ButtonBuilder()
      .setCustomId(createVotingPanelOptionsCustomId(panel.voteId))
      .setLabel("Panel options")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(votingDisabled),
  ];

  // Discord action rows are horizontal flex-like groups with a five-component
  // limit. Keep the common two-choice layout in one compact row and spill the
  // utility controls into their own row only when a custom vote needs it.
  const lastRow = rows.at(-1);
  if (lastRow && panel.options.length + utilityButtons.length <= 5) {
    lastRow.addComponents(utilityButtons);
  } else {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(utilityButtons),
    );
  }
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

function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function optionButtonLabel(option: VotingOptionView): string {
  return safeEmbedText(option.label, VOTING_PANEL_LIMITS.optionLabel);
}

function optionButtonStyle(
  panel: VotingPanelView,
  option: VotingOptionView,
): ButtonStyle {
  if (panel.pollType !== "yes-no") return ButtonStyle.Primary;
  const label = option.label
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US");
  if (label === "yes") return ButtonStyle.Success;
  if (label === "no") return ButtonStyle.Danger;
  return ButtonStyle.Primary;
}

function optionVoteLines(options: readonly VotingOptionView[]): string {
  const totalSelections = options.reduce(
    (total, option) => total + safeCount(option.voteCount),
    0,
  );
  const lines = options.map((option, index) => {
    const voteCount = safeCount(option.voteCount);
    const percentage =
      totalSelections === 0
        ? 0
        : Math.round((voteCount / totalSelections) * 100);
    const filled =
      voteCount === 0
        ? 0
        : Math.max(1, Math.round((percentage / 100) * VOTE_BAR_WIDTH));
    const bar = `${"▰".repeat(filled)}${"▱".repeat(VOTE_BAR_WIDTH - filled)}`;
    return `${index + 1}. **${safeEmbedText(option.label, 72)}** \`${bar} ${percentage}%\` · ${voteCount}`;
  });
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

function endedMetadata(panel: VotingPanelView): string {
  const endedAt = panel.completedAt ?? panel.cancelledAt;
  return endedAt ? `Ended <t:${toUnixSeconds(endedAt)}:R>` : "Ended";
}

function votingFooter(panel: VotingPanelView): string {
  if (panel.status !== "active") {
    return "How to use: this vote is closed; review the results above.";
  }
  return panel.multiSelect
    ? "How to use: select one or more options, then use View voters to inspect selections."
    : "How to use: select an option, then use View voters to inspect selections.";
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
    // Up to ten custom labels may tie. Keep each escaped label short enough
    // that the Result field stays within Discord's 1,024-character limit.
    .map((option) => `**${safeEmbedText(option.label, 80)}**`)
    .join(", ")} with **${highest}** votes each.`;
}

function completionMetadata(timestamp: string, actorId: string | null): string {
  const actor =
    actorId && DISCORD_USER_ID_PATTERN.test(actorId) ? ` by <@${actorId}>` : "";
  return `<t:${toUnixSeconds(timestamp)}:F>${actor}`;
}

function toUnixSeconds(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed)
    ? Math.floor(parsed / 1_000)
    : Math.floor(Date.now() / 1_000);
}
