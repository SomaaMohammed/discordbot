import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  escapeMarkdown,
  type MessageMentionOptions,
} from "discord.js";
import {
  DISCORD_CUSTOM_ID_LIMIT,
  SAFE_PANEL_ALLOWED_MENTIONS,
  createSuperiorEmbed,
  setPanelInstructionFooter,
} from "./panel-theme.js";
import { ONBOARDING_RULES_BODY_MAXIMUM } from "../types.js";

export { ONBOARDING_RULES_BODY_MAXIMUM } from "../types.js";

export const VERIFICATION_ACCEPT_PREFIX = "superior:verify:";
export const VERIFICATION_PANEL_ID_MINIMUM = 8;
export const VERIFICATION_PANEL_ID_MAXIMUM = 24;
export const MAX_RETAINED_RULE_VERSIONS = 25;

const CURRENT_RULES_ACKNOWLEDGEMENT =
  "Use the button below to acknowledge the current server rules. This acknowledgement is not a legal agreement.";
const CHANGED_RULES_ACKNOWLEDGEMENT =
  "The rules have changed. Use the button below to acknowledge the current version. This acknowledgement is not a legal agreement.";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{8,24}$/u;
const MENTION_PATTERN = /@(?:everyone|here)\b|<@(?:!|&)?\d{17,20}>/iu;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export interface ParsedVerificationAcceptId {
  readonly panelId: string;
  readonly rulesVersion: number;
}

export interface VerificationPanelRequest {
  readonly panelId: string;
  readonly rulesVersion: number;
  readonly rulesTitle: string;
  readonly rulesBody: string;
  readonly reacceptanceRequested: boolean;
}

export interface VerificationPanelPayload {
  readonly embeds: readonly [ReturnType<typeof createSuperiorEmbed>];
  readonly components: readonly ActionRowBuilder<ButtonBuilder>[];
  readonly allowedMentions: Readonly<MessageMentionOptions>;
}

export function createVerificationAcceptCustomId(
  panelId: string,
  rulesVersion: number,
): string {
  const normalizedPanelId = normalizePanelId(panelId);
  const normalizedVersion = normalizeRulesVersion(rulesVersion);
  const customId = `${VERIFICATION_ACCEPT_PREFIX}${normalizedPanelId}:${normalizedVersion}`;
  if (customId.length > DISCORD_CUSTOM_ID_LIMIT) {
    throw new RangeError("Verification custom ID exceeds Discord's limit.");
  }
  return customId;
}

export function parseVerificationAcceptCustomId(
  customId: string,
): ParsedVerificationAcceptId | null {
  if (!customId.startsWith(VERIFICATION_ACCEPT_PREFIX)) return null;
  const value = customId.slice(VERIFICATION_ACCEPT_PREFIX.length);
  const match = /^([A-Za-z0-9_-]{8,24}):([1-9]\d{0,8})$/u.exec(value);
  if (!match) return null;
  const rulesVersion = Number(match[2]);
  return Number.isSafeInteger(rulesVersion) && rulesVersion > 0
    ? { panelId: match[1]!, rulesVersion }
    : null;
}

export function buildVerificationPanelPayload(
  request: VerificationPanelRequest,
): VerificationPanelPayload {
  const customId = createVerificationAcceptCustomId(
    request.panelId,
    request.rulesVersion,
  );
  const title = normalizeRulesTitle(request.rulesTitle);
  const body = normalizeRulesBody(request.rulesBody);
  const acknowledgement = request.reacceptanceRequested
    ? CHANGED_RULES_ACKNOWLEDGEMENT
    : CURRENT_RULES_ACKNOWLEDGEMENT;
  const embed = createSuperiorEmbed("Verification")
    .setTitle(escapeMarkdown(title))
    .setDescription(`${escapeMarkdown(body)}\n\n${acknowledgement}`)
    .addFields({
      name: "Rules version",
      value: `\`${request.rulesVersion}\``,
      inline: true,
    });
  setPanelInstructionFooter(
    embed,
    "Read the rules, then click Accept Rules to acknowledge them.",
  );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(customId)
      .setLabel("Accept Rules")
      .setStyle(ButtonStyle.Primary),
  );
  return {
    embeds: [embed],
    components: [row],
    allowedMentions: SAFE_PANEL_ALLOWED_MENTIONS,
  };
}

export function normalizeRulesTitle(value: unknown): string {
  return normalizeRulesText(value, "Rules title", 256, true);
}

export function normalizeRulesBody(value: unknown): string {
  return normalizeRulesText(
    value,
    "Rules body",
    ONBOARDING_RULES_BODY_MAXIMUM,
    false,
  );
}

function normalizeRulesText(
  value: unknown,
  label: string,
  maximum: number,
  singleLine: boolean,
): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be text.`);
  let normalized = value.normalize("NFKC").replace(/\r\n?/gu, "\n");
  normalized = singleLine
    ? normalized.replace(/\s+/gu, " ").trim()
    : normalized
        .split("\n")
        .map((line) => line.replace(/[ \t]+$/gu, ""))
        .join("\n")
        .replace(/\n{3,}/gu, "\n\n")
        .trim();
  if (!normalized) throw new TypeError(`${label} cannot be empty.`);
  if (CONTROL_PATTERN.test(normalized)) {
    throw new TypeError(`${label} cannot contain control characters.`);
  }
  if (MENTION_PATTERN.test(normalized)) {
    throw new TypeError(`${label} cannot contain Discord mentions.`);
  }
  if (normalized.length > maximum) {
    throw new RangeError(`${label} is limited to ${maximum} characters.`);
  }
  if (escapeMarkdown(normalized).length > maximum) {
    throw new RangeError(
      `${label} exceeds Discord's ${maximum}-character limit after safe Markdown escaping.`,
    );
  }
  return normalized;
}

function normalizePanelId(value: string): string {
  if (!OPAQUE_ID_PATTERN.test(value)) {
    throw new TypeError("Verification panel ID is invalid.");
  }
  return value;
}

function normalizeRulesVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 999_999_999) {
    throw new RangeError("Rules version is invalid.");
  }
  return value;
}
