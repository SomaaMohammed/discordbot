import {
  escapeMarkdown,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type MessageCreateOptions,
  type MessageEditOptions,
} from "discord.js";
import type { MemberReport } from "../types.js";
import { createConfiguredModal, safeDisplayText } from "./forms.js";
import {
  SAFE_PANEL_ALLOWED_MENTIONS,
  createSuperiorEmbed,
} from "./panel-theme.js";

export const REPORT_COMPONENT_PREFIX = "superior:report:";
export const REPORT_TARGET_FIELD_ID = "target_id";
export const REPORT_CATEGORY_FIELD_ID = "category";
export const REPORT_EXPLANATION_FIELD_ID = "explanation";
export const REPORT_EVIDENCE_FIELD_ID = "evidence_link";
export const REPORT_DECISION_REASON_FIELD_ID = "decision_reason";
export const REPORT_LINKED_CASE_FIELD_ID = "linked_case";

export type ReportDecision = "resolve" | "dismiss";

export type ParsedReportComponent =
  | {
      kind: "submit-modal";
      panelId: string;
      targetUserId: string | null;
      sourceMessageToken: string;
    }
  | {
      kind: "control";
      action: "claim" | "release" | "resolve" | "dismiss" | "info";
      reportId: string;
      versionToken: string;
    }
  | {
      kind: "decision-modal";
      decision: ReportDecision;
      reportId: string;
      provenanceToken: string;
    };

export function createReportSubmitModal(
  panelId: string,
  targetUserId: string | null,
  sourceMessageId: string | null = null,
) {
  assertPanelSource(panelId);
  if (targetUserId !== null) assertSnowflake(targetUserId, "Target user ID");
  const sourceMessageToken = launcherSourceToken(panelId, sourceMessageId);
  const fields = [
    ...(targetUserId
      ? []
      : [
          {
            fieldId: REPORT_TARGET_FIELD_ID,
            key: "target",
            label: "Member user ID",
            placeholder: "Enter the 17-20 digit member ID",
            type: "short" as const,
            required: true,
            minLength: 17,
            maxLength: 20,
            sortOrder: 0,
          },
        ]),
    {
      fieldId: REPORT_CATEGORY_FIELD_ID,
      key: "category",
      label: "Category",
      placeholder: "harassment, spam, scam, safety, or other",
      type: "short" as const,
      required: true,
      minLength: 3,
      maxLength: 20,
      sortOrder: 1,
    },
    {
      fieldId: REPORT_EXPLANATION_FIELD_ID,
      key: "explanation",
      label: "What happened?",
      placeholder: "Give staff enough context to review safely",
      type: "paragraph" as const,
      required: true,
      minLength: 10,
      maxLength: 2_000,
      sortOrder: 2,
    },
    {
      fieldId: REPORT_EVIDENCE_FIELD_ID,
      key: "evidence",
      label: "Discord message link (optional)",
      placeholder: "https://discord.com/channels/server/channel/message",
      type: "short" as const,
      required: false,
      minLength: 0,
      maxLength: 200,
      sortOrder: 3,
    },
  ];
  const targetToken = targetUserId ?? "panel";
  return createConfiguredModal({
    customId: checkedId(
      `${REPORT_COMPONENT_PREFIX}submit-modal:${panelId}:${targetToken}:${sourceMessageToken}`,
    ),
    title: "Private member report",
    fields,
  });
}

export function createReportDecisionModal(
  reportId: string,
  decision: ReportDecision,
  versionToken: string,
  sourceMessageId: string,
) {
  assertOpaqueId(reportId, "Report ID");
  assertVersionToken(versionToken);
  assertSnowflake(sourceMessageId, "Source message ID");
  return createConfiguredModal({
    customId: checkedId(
      `${REPORT_COMPONENT_PREFIX}decision-modal:${decision}:${reportId}:${decisionProvenanceToken(versionToken, sourceMessageId)}`,
    ),
    title: decision === "resolve" ? "Resolve report" : "Dismiss report",
    fields: [
      {
        fieldId: REPORT_DECISION_REASON_FIELD_ID,
        key: "reason",
        label: "Private review reason",
        placeholder: "Explain the decision for the audit record",
        type: "paragraph",
        required: true,
        minLength: 1,
        maxLength: 500,
        sortOrder: 0,
      },
      {
        fieldId: REPORT_LINKED_CASE_FIELD_ID,
        key: "case",
        label: "Linked case number (optional)",
        placeholder: "123",
        type: "short",
        required: false,
        minLength: 0,
        maxLength: 10,
        sortOrder: 1,
      },
    ],
  });
}

export function buildReportReviewPayload(
  report: MemberReport,
): MessageCreateOptions & MessageEditOptions {
  const embed = createSuperiorEmbed()
    .setTitle(`Private Report #${report.reportNumber}`)
    .setDescription(escapeMarkdown(safeDisplayText(report.explanation, 2_000)))
    .addFields(
      { name: "Reporter ID", value: `\`${report.reporterId}\``, inline: true },
      { name: "Target ID", value: `\`${report.targetUserId}\``, inline: true },
      {
        name: "Category",
        value: safeDisplayText(report.category, 100),
        inline: true,
      },
      {
        name: "State",
        value: `**${formatState(report.state)}**`,
        inline: true,
      },
      {
        name: "Submitted",
        value: `<t:${toUnixSeconds(report.createdAt)}:F>`,
        inline: true,
      },
    );
  if (report.evidenceMessageId && report.evidenceChannelId) {
    embed.addFields({
      name: "Evidence",
      value: `[Open message](https://discord.com/channels/${report.guildId}/${report.evidenceChannelId}/${report.evidenceMessageId})`,
    });
  }
  if (report.claimedBy) {
    embed.addFields({
      name: "Claimed by",
      value: `\`${report.claimedBy}\``,
      inline: true,
    });
  }
  if (report.decisionReason) {
    embed.addFields({
      name: "Decision",
      value: escapeMarkdown(safeDisplayText(report.decisionReason, 1_024)),
    });
  }
  if (report.linkedCaseId) {
    embed.addFields({
      name: "Linked case ID",
      value: `\`${report.linkedCaseId}\``,
    });
  }
  const pending =
    report.state === "submitted" || report.state === "under-review";
  return {
    embeds: [embed],
    components: [
      buildReportControlRow(
        report.reportId,
        reportVersionToken(report.updatedAt),
        !pending,
      ),
    ],
    allowedMentions: SAFE_PANEL_ALLOWED_MENTIONS,
  };
}

export function buildReportControlRow(
  reportId: string,
  versionToken: string,
  disabled = false,
) {
  assertOpaqueId(reportId, "Report ID");
  assertVersionToken(versionToken);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    control(
      reportId,
      versionToken,
      "claim",
      "Claim",
      ButtonStyle.Secondary,
      disabled,
    ),
    control(
      reportId,
      versionToken,
      "release",
      "Release",
      ButtonStyle.Secondary,
      disabled,
    ),
    control(
      reportId,
      versionToken,
      "resolve",
      "Resolve",
      ButtonStyle.Success,
      disabled,
    ),
    control(
      reportId,
      versionToken,
      "dismiss",
      "Dismiss",
      ButtonStyle.Danger,
      disabled,
    ),
    control(reportId, versionToken, "info", "Info", ButtonStyle.Primary, false),
  );
}

export function parseReportComponentId(
  customId: string,
): ParsedReportComponent | null {
  const parts = customId.split(":");
  if (parts[0] !== "superior" || parts[1] !== "report") return null;
  if (
    parts.length === 6 &&
    parts[2] === "submit-modal" &&
    isPanelSource(parts[3]) &&
    (parts[4] === "panel" || isSnowflake(parts[4])) &&
    isLauncherSourceToken(parts[3]!, parts[5])
  ) {
    return {
      kind: "submit-modal",
      panelId: parts[3]!,
      targetUserId: parts[4] === "panel" ? null : parts[4]!,
      sourceMessageToken: parts[5]!,
    };
  }
  if (
    parts.length === 5 &&
    ["claim", "release", "resolve", "dismiss", "info"].includes(
      parts[2] ?? "",
    ) &&
    isOpaqueId(parts[3]) &&
    isVersionToken(parts[4])
  ) {
    return {
      kind: "control",
      action: parts[2] as "claim" | "release" | "resolve" | "dismiss" | "info",
      reportId: parts[3]!,
      versionToken: parts[4]!,
    };
  }
  if (
    parts.length === 6 &&
    parts[2] === "decision-modal" &&
    (parts[3] === "resolve" || parts[3] === "dismiss") &&
    isOpaqueId(parts[4]) &&
    isProvenanceToken(parts[5])
  ) {
    return {
      kind: "decision-modal",
      decision: parts[3],
      reportId: parts[4]!,
      provenanceToken: parts[5]!,
    };
  }
  return null;
}

function control(
  reportId: string,
  versionToken: string,
  action: "claim" | "release" | "resolve" | "dismiss" | "info",
  label: string,
  style: ButtonStyle,
  disabled: boolean,
) {
  return new ButtonBuilder()
    .setCustomId(
      checkedId(
        `${REPORT_COMPONENT_PREFIX}${action}:${reportId}:${versionToken}`,
      ),
    )
    .setLabel(label)
    .setStyle(style)
    .setDisabled(disabled);
}

function checkedId(value: string): string {
  if (value.length > 100)
    throw new RangeError("Report control exceeds Discord's custom ID limit.");
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

export function reportVersionToken(updatedAt: string): string {
  const parsed = Date.parse(updatedAt);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new TypeError("Report update timestamp is invalid.");
  }
  return Math.floor(parsed).toString(36);
}

export function reportDecisionProvenanceToken(
  updatedAt: string,
  sourceMessageId: string,
): string {
  return decisionProvenanceToken(
    reportVersionToken(updatedAt),
    sourceMessageId,
  );
}

export function reportLauncherMessageToken(messageId: string): string {
  assertSnowflake(messageId, "Source message ID");
  return BigInt(messageId).toString(36);
}

function isVersionToken(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-z]{1,16}$/u.test(value);
}

function assertVersionToken(value: unknown): asserts value is string {
  if (!isVersionToken(value))
    throw new TypeError("Report version token is invalid.");
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

function assertOpaqueId(
  value: unknown,
  label: string,
): asserts value is string {
  if (!isOpaqueId(value))
    throw new TypeError(`${label} must be an opaque token.`);
}

function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && /^\d{17,20}$/u.test(value);
}

function assertSnowflake(
  value: unknown,
  label: string,
): asserts value is string {
  if (!isSnowflake(value)) throw new TypeError(`${label} is invalid.`);
}

function isPanelSource(value: unknown): value is string {
  return value === "command" || isOpaqueId(value);
}

function assertPanelSource(value: unknown): asserts value is string {
  if (!isPanelSource(value))
    throw new TypeError("Report launcher source is invalid.");
}

function launcherSourceToken(
  panelId: string,
  sourceMessageId: string | null,
): string {
  if (panelId === "command") {
    if (sourceMessageId !== null) {
      throw new TypeError("Command launchers cannot bind a panel message.");
    }
    return "command";
  }
  if (sourceMessageId === null) {
    throw new TypeError("Panel launchers must bind their source message.");
  }
  return reportLauncherMessageToken(sourceMessageId);
}

function isLauncherSourceToken(
  panelId: string,
  token: unknown,
): token is string {
  return panelId === "command"
    ? token === "command"
    : typeof token === "string" && /^[0-9a-z]{8,16}$/u.test(token);
}
