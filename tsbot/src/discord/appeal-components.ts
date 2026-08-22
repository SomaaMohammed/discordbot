import {
  escapeMarkdown,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type MessageCreateOptions,
  type MessageEditOptions,
} from "discord.js";
import type { CaseAppeal, ModerationCase } from "../types.js";
import { createConfiguredModal, safeDisplayText } from "./forms.js";
import {
  SAFE_PANEL_ALLOWED_MENTIONS,
  createSuperiorEmbed,
} from "./panel-theme.js";

export const APPEAL_COMPONENT_PREFIX = "superior:appeal:";
export const APPEAL_CASE_FIELD_ID = "case_number";
export const APPEAL_EXPLANATION_FIELD_ID = "explanation";
export const APPEAL_DECISION_REASON_FIELD_ID = "decision_reason";
export type AppealDecision = "uphold" | "overturn";

export type ParsedAppealComponent =
  | {
      kind: "submit-modal";
      panelId: string;
      caseNumber: number | null;
      sourceMessageToken: string;
    }
  | {
      kind: "control";
      action: "claim" | "release" | "uphold" | "overturn" | "info";
      appealId: string;
      versionToken: string;
    }
  | {
      kind: "decision-modal";
      decision: AppealDecision;
      appealId: string;
      provenanceToken: string;
    };

export function createAppealSubmitModal(
  panelId: string,
  caseNumber: number | null,
  sourceMessageId: string | null = null,
) {
  assertPanelSource(panelId);
  if (caseNumber !== null) assertCaseNumber(caseNumber);
  const sourceMessageToken = launcherSourceToken(panelId, sourceMessageId);
  return createConfiguredModal({
    customId: checkedId(
      `${APPEAL_COMPONENT_PREFIX}submit-modal:${panelId}:${caseNumber ?? "panel"}:${sourceMessageToken}`,
    ),
    title: "Appeal a moderation case",
    fields: [
      ...(caseNumber === null
        ? [
            {
              fieldId: APPEAL_CASE_FIELD_ID,
              key: "case",
              label: "Case number",
              placeholder: "123",
              type: "short" as const,
              required: true,
              minLength: 1,
              maxLength: 10,
              sortOrder: 0,
            },
          ]
        : []),
      {
        fieldId: APPEAL_EXPLANATION_FIELD_ID,
        key: "explanation",
        label: "Why should this case be reviewed?",
        placeholder: "Explain what staff should reconsider",
        type: "paragraph" as const,
        required: true,
        minLength: 10,
        maxLength: 2_000,
        sortOrder: 1,
      },
    ],
  });
}

export function createAppealDecisionModal(
  appealId: string,
  decision: AppealDecision,
  versionToken: string,
  sourceMessageId: string,
) {
  assertOpaqueId(appealId);
  assertVersionToken(versionToken);
  assertSnowflake(sourceMessageId);
  return createConfiguredModal({
    customId: checkedId(
      `${APPEAL_COMPONENT_PREFIX}decision-modal:${decision}:${appealId}:${decisionProvenanceToken(versionToken, sourceMessageId)}`,
    ),
    title: decision === "uphold" ? "Uphold case" : "Overturn case",
    fields: [
      {
        fieldId: APPEAL_DECISION_REASON_FIELD_ID,
        key: "reason",
        label: "Private review reason",
        placeholder: "Explain the appeal decision",
        type: "paragraph",
        required: true,
        minLength: 1,
        maxLength: 500,
        sortOrder: 0,
      },
    ],
  });
}

export function buildAppealReviewPayload(
  appeal: CaseAppeal,
  moderationCase: ModerationCase,
): MessageCreateOptions & MessageEditOptions {
  const embed = createSuperiorEmbed()
    .setTitle(`Case Appeal #${appeal.appealNumber}`)
    .setDescription(escapeMarkdown(safeDisplayText(appeal.explanation, 2_000)))
    .addFields(
      {
        name: "Appellant ID",
        value: `\`${appeal.appellantId}\``,
        inline: true,
      },
      {
        name: "Case",
        value: `#${moderationCase.caseNumber} · ${safeDisplayText(moderationCase.actionType, 50)}`,
        inline: true,
      },
      {
        name: "State",
        value: `**${formatState(appeal.state)}**`,
        inline: true,
      },
      {
        name: "Original reason",
        value: escapeMarkdown(
          safeDisplayText(moderationCase.publicReason, 1_024),
        ),
      },
      {
        name: "Submitted",
        value: `<t:${toUnixSeconds(appeal.createdAt)}:F>`,
        inline: true,
      },
    );
  if (appeal.claimedBy)
    embed.addFields({
      name: "Claimed by",
      value: `\`${appeal.claimedBy}\``,
      inline: true,
    });
  if (appeal.decisionReason)
    embed.addFields({
      name: "Decision",
      value: escapeMarkdown(safeDisplayText(appeal.decisionReason, 1_024)),
    });
  const pending =
    appeal.state === "submitted" || appeal.state === "under-review";
  return {
    embeds: [embed],
    components: [
      buildAppealControlRow(
        appeal.appealId,
        appealVersionToken(appeal.updatedAt),
        !pending,
      ),
    ],
    allowedMentions: SAFE_PANEL_ALLOWED_MENTIONS,
  };
}

export function buildAppealControlRow(
  appealId: string,
  versionToken: string,
  disabled = false,
) {
  assertOpaqueId(appealId);
  assertVersionToken(versionToken);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    control(
      appealId,
      versionToken,
      "claim",
      "Claim",
      ButtonStyle.Secondary,
      disabled,
    ),
    control(
      appealId,
      versionToken,
      "release",
      "Release",
      ButtonStyle.Secondary,
      disabled,
    ),
    control(
      appealId,
      versionToken,
      "uphold",
      "Uphold",
      ButtonStyle.Success,
      disabled,
    ),
    control(
      appealId,
      versionToken,
      "overturn",
      "Overturn",
      ButtonStyle.Danger,
      disabled,
    ),
    control(appealId, versionToken, "info", "Info", ButtonStyle.Primary, false),
  );
}

export function parseAppealComponentId(
  customId: string,
): ParsedAppealComponent | null {
  const parts = customId.split(":");
  if (parts[0] !== "superior" || parts[1] !== "appeal") return null;
  if (
    parts.length === 6 &&
    parts[2] === "submit-modal" &&
    isPanelSource(parts[3]) &&
    isLauncherSourceToken(parts[3]!, parts[5])
  ) {
    const caseNumber = parts[4] === "panel" ? null : parseCaseNumber(parts[4]);
    if (parts[4] === "panel" || caseNumber !== null) {
      return {
        kind: "submit-modal",
        panelId: parts[3]!,
        caseNumber,
        sourceMessageToken: parts[5]!,
      };
    }
  }
  if (
    parts.length === 5 &&
    ["claim", "release", "uphold", "overturn", "info"].includes(
      parts[2] ?? "",
    ) &&
    isOpaqueId(parts[3]) &&
    isVersionToken(parts[4])
  ) {
    return {
      kind: "control",
      action: parts[2] as "claim" | "release" | "uphold" | "overturn" | "info",
      appealId: parts[3]!,
      versionToken: parts[4]!,
    };
  }
  if (
    parts.length === 6 &&
    parts[2] === "decision-modal" &&
    (parts[3] === "uphold" || parts[3] === "overturn") &&
    isOpaqueId(parts[4]) &&
    isProvenanceToken(parts[5])
  ) {
    return {
      kind: "decision-modal",
      decision: parts[3],
      appealId: parts[4]!,
      provenanceToken: parts[5]!,
    };
  }
  return null;
}

function control(
  appealId: string,
  versionToken: string,
  action: "claim" | "release" | "uphold" | "overturn" | "info",
  label: string,
  style: ButtonStyle,
  disabled: boolean,
) {
  return new ButtonBuilder()
    .setCustomId(
      checkedId(
        `${APPEAL_COMPONENT_PREFIX}${action}:${appealId}:${versionToken}`,
      ),
    )
    .setLabel(label)
    .setStyle(style)
    .setDisabled(disabled);
}

function checkedId(value: string): string {
  if (value.length > 100)
    throw new RangeError("Appeal control exceeds Discord's custom ID limit.");
  return value;
}
function formatState(value: string): string {
  return value
    .split("-")
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}
function toUnixSeconds(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : 0;
}
function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,48}$/u.test(value);
}
export function appealVersionToken(updatedAt: string): string {
  const parsed = Date.parse(updatedAt);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new TypeError("Appeal update timestamp is invalid.");
  }
  return Math.floor(parsed).toString(36);
}
export function appealDecisionProvenanceToken(
  updatedAt: string,
  sourceMessageId: string,
): string {
  return decisionProvenanceToken(
    appealVersionToken(updatedAt),
    sourceMessageId,
  );
}
export function appealLauncherMessageToken(messageId: string): string {
  assertSnowflake(messageId);
  return BigInt(messageId).toString(36);
}
function isVersionToken(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-z]{1,16}$/u.test(value);
}
function assertVersionToken(value: unknown): asserts value is string {
  if (!isVersionToken(value))
    throw new TypeError("Appeal version token is invalid.");
}
function decisionProvenanceToken(
  versionToken: string,
  sourceMessageId: string,
): string {
  let hash = 0xcbf29ce484222325n;
  for (const character of `${versionToken}:${sourceMessageId}`) {
    hash ^= BigInt(character.codePointAt(0)!);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `p${hash.toString(36)}`;
}
function isProvenanceToken(value: unknown): value is string {
  return typeof value === "string" && /^p[0-9a-z]{1,16}$/u.test(value);
}
function assertOpaqueId(value: unknown): asserts value is string {
  if (!isOpaqueId(value))
    throw new TypeError("Appeal ID must be an opaque token.");
}
function assertSnowflake(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^\d{17,20}$/u.test(value)) {
    throw new TypeError("Source message ID is invalid.");
  }
}
function parseCaseNumber(value: string | undefined): number | null {
  if (!value || !/^\d{1,10}$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 2_147_483_647
    ? parsed
    : null;
}
function assertCaseNumber(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
    throw new RangeError("Case number is invalid.");
}
function isPanelSource(value: unknown): value is string {
  return value === "command" || isOpaqueId(value);
}
function assertPanelSource(value: unknown): asserts value is string {
  if (!isPanelSource(value))
    throw new TypeError("Appeal launcher source is invalid.");
}
function launcherSourceToken(
  panelId: string,
  sourceMessageId: string | null,
): string {
  if (panelId === "command") {
    if (sourceMessageId !== null)
      throw new TypeError("Command launchers cannot bind a panel message.");
    return "command";
  }
  if (sourceMessageId === null)
    throw new TypeError("Panel launchers must bind their source message.");
  return appealLauncherMessageToken(sourceMessageId);
}
function isLauncherSourceToken(
  panelId: string,
  token: unknown,
): token is string {
  return panelId === "command"
    ? token === "command"
    : typeof token === "string" && /^[0-9a-z]{8,16}$/u.test(token);
}
