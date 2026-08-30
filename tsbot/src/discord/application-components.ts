import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type MessageCreateOptions,
  type MessageEditOptions,
} from "discord.js";
import {
  createConfiguredModal,
  renderFormResponses,
  safeDisplayText,
  type FormFieldInput,
  type FormResponse,
} from "./forms.js";
import {
  SAFE_PANEL_ALLOWED_MENTIONS,
  createSuperiorEmbed,
} from "./panel-theme.js";

export const APPLICATION_COMPONENT_PREFIX = "superior:application:";
export const APPLICATION_DECISION_REASON_FIELD_ID = "decision_reason";

export type ApplicationDecision = "accept" | "reject";

export type ParsedApplicationComponent =
  | { kind: "select"; panelId: string }
  | {
      kind: "submit-modal";
      panelId: string;
      formId: string;
      definitionVersion: number;
    }
  | {
      kind: "control";
      action: "claim" | "accept" | "reject" | "info";
      applicationId: string;
    }
  | {
      kind: "decision-modal";
      decision: ApplicationDecision;
      applicationId: string;
    };

export interface ApplicationFormDisplay {
  formId: string;
  definitionVersion: number;
  slug: string;
  displayName: string;
  description: string;
  emoji?: string | null;
  fields: readonly FormFieldInput[];
}

export interface ApplicationDisplayRecord {
  applicationId: string;
  applicationNumber: number;
  applicantId: string;
  state: string;
  claimedBy: string | null;
  decisionBy: string | null;
  decisionReason: string | null;
  createdAt: string;
}

export function buildApplicationFormSelect(
  panelId: string,
  forms: readonly ApplicationFormDisplay[],
): ActionRowBuilder<StringSelectMenuBuilder> {
  assertOpaqueId(panelId, "Panel ID");
  if (forms.length < 1 || forms.length > 25) {
    throw new RangeError("Application launchers require 1-25 enabled forms.");
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId(checkedId(`${APPLICATION_COMPONENT_PREFIX}select:${panelId}`))
    .setPlaceholder("Choose an application")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      forms.map((form) => {
        assertOpaqueId(form.formId, "Application form ID");
        const option = new StringSelectMenuOptionBuilder()
          .setValue(form.formId)
          .setLabel(safeDisplayText(form.displayName, 100))
          .setDescription(safeDisplayText(form.description, 100));
        if (form.emoji) option.setEmoji(form.emoji);
        return option;
      }),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export function createApplicationSubmitModal(
  panelId: string,
  form: ApplicationFormDisplay,
) {
  if (panelId !== "command") assertOpaqueId(panelId, "Panel ID");
  assertOpaqueId(form.formId, "Application form ID");
  assertDefinitionVersion(form.definitionVersion);
  return createConfiguredModal({
    customId: checkedId(
      `${APPLICATION_COMPONENT_PREFIX}submit-modal:${panelId}:${form.formId}:${form.definitionVersion}`,
    ),
    title: safeDisplayText(form.displayName, 45),
    fields: form.fields,
  });
}

export function createApplicationDecisionModal(
  applicationId: string,
  decision: ApplicationDecision,
) {
  assertOpaqueId(applicationId, "Application ID");
  return createConfiguredModal({
    customId: checkedId(
      `${APPLICATION_COMPONENT_PREFIX}decision-modal:${decision}:${applicationId}`,
    ),
    title: decision === "accept" ? "Accept application" : "Reject application",
    fields: [
      {
        fieldId: APPLICATION_DECISION_REASON_FIELD_ID,
        key: "reason",
        label: "Decision reason",
        placeholder: "Give a short, helpful explanation",
        type: "paragraph",
        required: true,
        minLength: 1,
        maxLength: 500,
        sortOrder: 0,
      },
    ],
  });
}

export function buildApplicationReviewPayload(
  application: ApplicationDisplayRecord,
  form: Pick<ApplicationFormDisplay, "displayName" | "description">,
  responses: readonly FormResponse[],
): MessageCreateOptions & MessageEditOptions {
  const embed = createSuperiorEmbed("Application")
    .setTitle(
      `${safeDisplayText(form.displayName, 160)} · Application #${application.applicationNumber}`,
    )
    .setDescription(safeDisplayText(form.description, 1_000))
    .addFields(
      {
        name: "Applicant ID",
        value: `\`${application.applicantId}\``,
        inline: true,
      },
      {
        name: "Status",
        value: `**${formatApplicationState(application.state)}**`,
        inline: true,
      },
      {
        name: "Submitted",
        value: `<t:${toUnixSeconds(application.createdAt)}:F>`,
        inline: true,
      },
      ...renderFormResponses(
        responses.map((response) => ({
          ...response,
          label: safeDisplayText(response.label, 45),
          value: safeDisplayText(response.value, 600),
        })),
      ),
    );
  if (application.claimedBy) {
    embed.addFields({
      name: "Claimed by",
      value: `\`${application.claimedBy}\``,
      inline: true,
    });
  }
  if (application.decisionReason) {
    embed.addFields({
      name: "Decision",
      value: safeDisplayText(application.decisionReason, 1_024),
    });
  }
  const pending =
    application.state === "submitted" || application.state === "under-review";
  return {
    embeds: [embed],
    components: [
      buildApplicationControlRow(application.applicationId, !pending),
    ],
    allowedMentions: SAFE_PANEL_ALLOWED_MENTIONS,
  };
}

export function buildApplicationControlRow(
  applicationId: string,
  disabled = false,
): ActionRowBuilder<ButtonBuilder> {
  assertOpaqueId(applicationId, "Application ID");
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    controlButton(
      applicationId,
      "claim",
      "Claim",
      ButtonStyle.Secondary,
      disabled,
    ),
    controlButton(
      applicationId,
      "accept",
      "Accept",
      ButtonStyle.Success,
      disabled,
    ),
    controlButton(
      applicationId,
      "reject",
      "Reject",
      ButtonStyle.Danger,
      disabled,
    ),
    controlButton(applicationId, "info", "Info", ButtonStyle.Primary, false),
  );
}

export function parseApplicationComponentId(
  customId: string,
): ParsedApplicationComponent | null {
  const parts = customId.split(":");
  if (parts[0] !== "superior" || parts[1] !== "application") return null;
  if (parts.length === 4 && parts[2] === "select" && isOpaqueId(parts[3])) {
    return { kind: "select", panelId: parts[3]! };
  }
  if (
    parts.length === 6 &&
    parts[2] === "submit-modal" &&
    (parts[3] === "command" || isOpaqueId(parts[3])) &&
    isOpaqueId(parts[4]) &&
    parseDefinitionVersion(parts[5]) !== null
  ) {
    return {
      kind: "submit-modal",
      panelId: parts[3]!,
      formId: parts[4]!,
      definitionVersion: parseDefinitionVersion(parts[5])!,
    };
  }
  if (
    parts.length === 4 &&
    ["claim", "accept", "reject", "info"].includes(parts[2] ?? "") &&
    isOpaqueId(parts[3])
  ) {
    return {
      kind: "control",
      action: parts[2] as "claim" | "accept" | "reject" | "info",
      applicationId: parts[3]!,
    };
  }
  if (
    parts.length === 5 &&
    parts[2] === "decision-modal" &&
    (parts[3] === "accept" || parts[3] === "reject") &&
    isOpaqueId(parts[4])
  ) {
    return {
      kind: "decision-modal",
      decision: parts[3],
      applicationId: parts[4]!,
    };
  }
  return null;
}

export function applicationStatusMessage(
  application: ApplicationDisplayRecord,
  formName: string,
): string {
  return [
    `**${safeDisplayText(formName, 120)} · Application #${application.applicationNumber}**`,
    `Status: **${formatApplicationState(application.state)}**`,
    application.decisionReason
      ? `Decision: ${safeDisplayText(application.decisionReason, 800)}`
      : "Decision: pending",
  ].join("\n");
}

function controlButton(
  applicationId: string,
  action: "claim" | "accept" | "reject" | "info",
  label: string,
  style: ButtonStyle,
  disabled: boolean,
): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(
      checkedId(`${APPLICATION_COMPONENT_PREFIX}${action}:${applicationId}`),
    )
    .setLabel(label)
    .setStyle(style)
    .setDisabled(disabled);
}

function formatApplicationState(state: string): string {
  return state
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function toUnixSeconds(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : 0;
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,24}$/.test(value);
}

function assertOpaqueId(
  value: unknown,
  label: string,
): asserts value is string {
  if (!isOpaqueId(value)) {
    throw new TypeError(`${label} must be an opaque storage token.`);
  }
}

function assertDefinitionVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new RangeError("Application form version is invalid.");
  }
}

function parseDefinitionVersion(value: string | undefined): number | null {
  if (!value || !/^\d{1,10}$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 2_147_483_647
    ? parsed
    : null;
}

function checkedId(value: string): string {
  if (value.length > 100)
    throw new RangeError("Application custom ID is too long.");
  return value;
}
