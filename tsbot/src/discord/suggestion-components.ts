import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type MessageCreateOptions,
  type MessageEditOptions,
} from "discord.js";
import { createConfiguredModal, safeDisplayText } from "./forms.js";
import {
  SAFE_PANEL_ALLOWED_MENTIONS,
  createSuperiorEmbed,
} from "./panel-theme.js";

export const SUGGESTION_COMPONENT_PREFIX = "superior:suggestion:";
export const SUGGESTION_TITLE_FIELD_ID = "suggest_title";
export const SUGGESTION_DETAILS_FIELD_ID = "suggest_details";
export const SUGGESTION_REASON_FIELD_ID = "review_reason";

export const SUGGESTION_INPUT_LIMITS = Object.freeze({
  title: 100,
  details: 3_000,
  reason: 500,
});

export const SUGGESTION_REVIEW_STATES = [
  "under-review",
  "accepted",
  "declined",
  "implemented",
] as const;

export type SuggestionReviewState = (typeof SUGGESTION_REVIEW_STATES)[number];

export type ParsedSuggestionComponent =
  | { kind: "vote"; direction: "up" | "down"; suggestionId: string }
  | { kind: "review"; state: SuggestionReviewState; suggestionId: string }
  | {
      kind: "review-modal";
      state: SuggestionReviewState;
      suggestionId: string;
    }
  | { kind: "submit-modal"; source: string | null };

export interface SuggestionDisplayRecord {
  suggestionId: string;
  suggestionNumber: number;
  authorId: string;
  title: string;
  details: string;
  state: string;
  reviewerId: string | null;
  reviewReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SuggestionVoteCounts {
  upvotes: number;
  downvotes: number;
}

export function createSuggestionSubmitModal(source?: string | null) {
  if (source && source !== "command") assertSuggestionId(source);
  return createConfiguredModal({
    customId: checkedId(
      `${SUGGESTION_COMPONENT_PREFIX}submit-modal${source ? `:${source}` : ""}`,
    ),
    title: "Share a suggestion",
    fields: [
      {
        fieldId: SUGGESTION_TITLE_FIELD_ID,
        key: "title",
        label: "Title",
        type: "short",
        required: true,
        minLength: 3,
        maxLength: SUGGESTION_INPUT_LIMITS.title,
        sortOrder: 0,
      },
      {
        fieldId: SUGGESTION_DETAILS_FIELD_ID,
        key: "details",
        label: "Proposal",
        description: "Explain the change and why it would help",
        placeholder: "Describe the proposal and expected benefit",
        type: "paragraph",
        required: true,
        minLength: 10,
        maxLength: SUGGESTION_INPUT_LIMITS.details,
        sortOrder: 1,
      },
    ],
  });
}

export function createSuggestionReviewModal(
  suggestionId: string,
  state: SuggestionReviewState,
) {
  assertSuggestionId(suggestionId);
  assertSuggestionReviewState(state);
  return createConfiguredModal({
    customId: checkedId(
      `${SUGGESTION_COMPONENT_PREFIX}review-modal:${state}:${suggestionId}`,
    ),
    title: "Review suggestion",
    fields: [
      {
        fieldId: SUGGESTION_REASON_FIELD_ID,
        key: "reason",
        label: "Reason",
        placeholder: "Give a short, helpful explanation",
        type: "paragraph",
        required: true,
        minLength: 1,
        maxLength: SUGGESTION_INPUT_LIMITS.reason,
        sortOrder: 0,
      },
    ],
  });
}

export function buildSuggestionPublicPayload(
  suggestion: SuggestionDisplayRecord,
  counts: SuggestionVoteCounts,
): MessageCreateOptions & MessageEditOptions {
  const votingOpen =
    suggestion.state === "open" || suggestion.state === "under-review";
  const embed = createSuperiorEmbed("Suggestion")
    .setTitle(
      `Suggestion #${suggestion.suggestionNumber}: ${safeDisplayText(suggestion.title, 200)}`,
    )
    .setDescription(safeDisplayText(suggestion.details, 4_000))
    .addFields(
      {
        name: "Status",
        value: `**${formatSuggestionState(suggestion.state)}**`,
        inline: true,
      },
      {
        name: "Votes",
        value: `Up **${safeCount(counts.upvotes)}** · Down **${safeCount(counts.downvotes)}**`,
        inline: true,
      },
      {
        name: "Author ID",
        value: `\`${suggestion.authorId}\``,
        inline: true,
      },
      {
        name: "Submitted",
        value: `<t:${toUnixSeconds(suggestion.createdAt)}:F>`,
        inline: false,
      },
    );
  if (suggestion.reviewReason) {
    embed.addFields({
      name: "Staff update",
      value: safeDisplayText(suggestion.reviewReason, 1_024),
    });
  }
  const components = [
    buildSuggestionVoteRow(suggestion.suggestionId, counts, !votingOpen),
  ];
  return {
    embeds: [embed],
    components,
    allowedMentions: SAFE_PANEL_ALLOWED_MENTIONS,
  };
}

export function buildSuggestionVoteRow(
  suggestionId: string,
  counts: SuggestionVoteCounts,
  disabled = false,
): ActionRowBuilder<ButtonBuilder> {
  assertSuggestionId(suggestionId);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(
        checkedId(`${SUGGESTION_COMPONENT_PREFIX}vote:up:${suggestionId}`),
      )
      .setLabel(`Upvote ${safeCount(counts.upvotes)}`)
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(
        checkedId(`${SUGGESTION_COMPONENT_PREFIX}vote:down:${suggestionId}`),
      )
      .setLabel(`Downvote ${safeCount(counts.downvotes)}`)
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );
}

export function buildSuggestionReviewRow(
  suggestionId: string,
  disabled = false,
): ActionRowBuilder<ButtonBuilder> {
  assertSuggestionId(suggestionId);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    reviewButton(
      suggestionId,
      "under-review",
      "Under Review",
      ButtonStyle.Secondary,
      disabled,
    ),
    reviewButton(
      suggestionId,
      "accepted",
      "Accept",
      ButtonStyle.Success,
      disabled,
    ),
    reviewButton(
      suggestionId,
      "declined",
      "Decline",
      ButtonStyle.Danger,
      disabled,
    ),
    reviewButton(
      suggestionId,
      "implemented",
      "Implemented",
      ButtonStyle.Primary,
      disabled,
    ),
  );
}

export function parseSuggestionComponentId(
  customId: string,
): ParsedSuggestionComponent | null {
  if (customId === `${SUGGESTION_COMPONENT_PREFIX}submit-modal`) {
    return { kind: "submit-modal", source: null };
  }
  const parts = customId.split(":");
  if (parts[0] !== "superior" || parts[1] !== "suggestion") return null;
  if (
    parts.length === 4 &&
    parts[2] === "submit-modal" &&
    (parts[3] === "command" || isSuggestionId(parts[3] ?? ""))
  ) {
    return { kind: "submit-modal", source: parts[3]! };
  }
  if (
    parts.length === 5 &&
    parts[2] === "vote" &&
    (parts[3] === "up" || parts[3] === "down") &&
    isSuggestionId(parts[4] ?? "")
  ) {
    return {
      kind: "vote",
      direction: parts[3],
      suggestionId: parts[4]!,
    };
  }
  if (
    parts.length === 5 &&
    parts[2] === "review" &&
    isSuggestionReviewState(parts[3]) &&
    isSuggestionId(parts[4] ?? "")
  ) {
    return { kind: "review", state: parts[3], suggestionId: parts[4]! };
  }
  if (
    parts.length === 5 &&
    parts[2] === "review-modal" &&
    isSuggestionReviewState(parts[3]) &&
    isSuggestionId(parts[4] ?? "")
  ) {
    return {
      kind: "review-modal",
      state: parts[3],
      suggestionId: parts[4]!,
    };
  }
  return null;
}

export function suggestionStatusMessage(
  suggestion: SuggestionDisplayRecord,
  counts: SuggestionVoteCounts,
): string {
  return [
    `**Suggestion #${suggestion.suggestionNumber} · ${safeDisplayText(suggestion.title, 120)}**`,
    `Status: **${formatSuggestionState(suggestion.state)}**`,
    `Votes: **${safeCount(counts.upvotes)}** up · **${safeCount(counts.downvotes)}** down`,
    suggestion.reviewReason
      ? `Staff update: ${safeDisplayText(suggestion.reviewReason, 800)}`
      : "Staff update: none",
  ].join("\n");
}

function reviewButton(
  suggestionId: string,
  state: SuggestionReviewState,
  label: string,
  style: ButtonStyle,
  disabled: boolean,
): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(
      checkedId(
        `${SUGGESTION_COMPONENT_PREFIX}review:${state}:${suggestionId}`,
      ),
    )
    .setLabel(label)
    .setStyle(style)
    .setDisabled(disabled);
}

function formatSuggestionState(state: string): string {
  return state
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function toUnixSeconds(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : 0;
}

function isSuggestionReviewState(
  value: unknown,
): value is SuggestionReviewState {
  return (SUGGESTION_REVIEW_STATES as readonly unknown[]).includes(value);
}

function assertSuggestionReviewState(
  value: unknown,
): asserts value is SuggestionReviewState {
  if (!isSuggestionReviewState(value)) {
    throw new TypeError("Unsupported suggestion review state.");
  }
}

function isSuggestionId(value: string): boolean {
  return /^[A-Za-z0-9_-]{8,24}$/.test(value);
}

function assertSuggestionId(value: string): void {
  if (!isSuggestionId(value)) {
    throw new TypeError("Suggestion ID must be an opaque storage token.");
  }
}

function checkedId(value: string): string {
  if (value.length > 100)
    throw new RangeError("Suggestion custom ID is too long.");
  return value;
}
