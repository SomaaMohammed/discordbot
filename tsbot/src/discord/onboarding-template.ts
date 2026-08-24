import { escapeMarkdown } from "discord.js";

export const ONBOARDING_TEMPLATE_LIMITS = Object.freeze({
  title: 256,
  body: 4_096,
});

export const ONBOARDING_TEMPLATE_PLACEHOLDERS = Object.freeze([
  "user",
  "server",
  "member_count",
  "account_created",
  "joined_at",
  "rules",
] as const);

export type OnboardingTemplatePlaceholder =
  (typeof ONBOARDING_TEMPLATE_PLACEHOLDERS)[number];

export interface OnboardingTemplatePair {
  readonly title: string;
  readonly body: string;
}

export interface OnboardingTemplateContext {
  readonly userDisplay: string;
  readonly serverName: string;
  readonly memberCount: number;
  readonly accountCreatedAt: Date | null;
  readonly joinedAt: Date | null;
  readonly rulesChannelId: string | null;
}

const PLACEHOLDER_PATTERN = /\{([a-z_]+)\}/gu;
const UNSAFE_TEMPLATE_SYNTAX = /\$\{|\{\{|\}\}|<%|%>/u;
const DISCORD_MENTION_PATTERN = /<@!?\d{17,20}>|<@&\d{17,20}>/u;
const MASS_MENTION_PATTERN = /@(?:everyone|here)\b/iu;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

const MAXIMUM_EXPANSION_LENGTH: Readonly<
  Record<OnboardingTemplatePlaceholder, number>
> = Object.freeze({
  user: 200,
  server: 200,
  member_count: 20,
  account_created: 32,
  joined_at: 32,
  rules: 32,
});

export const DEFAULT_WELCOME_TEMPLATE: OnboardingTemplatePair = Object.freeze({
  title: "Welcome to {server}",
  body: "{user} joined the server. Please review {rules}.",
});

export const DEFAULT_FAREWELL_TEMPLATE: OnboardingTemplatePair = Object.freeze({
  title: "Member left {server}",
  body: "{user} has left the server.",
});

export function normalizeOnboardingTemplatePair(
  title: unknown,
  body: unknown,
): OnboardingTemplatePair {
  return {
    title: normalizeOnboardingTemplate(
      title,
      "Template title",
      ONBOARDING_TEMPLATE_LIMITS.title,
      true,
    ),
    body: normalizeOnboardingTemplate(
      body,
      "Template body",
      ONBOARDING_TEMPLATE_LIMITS.body,
      false,
    ),
  };
}

export function normalizeOnboardingTemplate(
  value: unknown,
  label: string,
  maximum: number,
  singleLine: boolean,
): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be text.`);
  }
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
  if (UNSAFE_TEMPLATE_SYNTAX.test(normalized)) {
    throw new TypeError(
      `${label} contains unsupported nested template syntax.`,
    );
  }
  if (
    DISCORD_MENTION_PATTERN.test(normalized) ||
    MASS_MENTION_PATTERN.test(normalized)
  ) {
    throw new TypeError(`${label} cannot contain Discord mentions.`);
  }

  const placeholders = [...normalized.matchAll(PLACEHOLDER_PATTERN)].map(
    (match) => match[1] ?? "",
  );
  for (const placeholder of placeholders) {
    if (
      !(ONBOARDING_TEMPLATE_PLACEHOLDERS as readonly string[]).includes(
        placeholder,
      )
    ) {
      throw new TypeError(`Unknown onboarding placeholder {${placeholder}}.`);
    }
  }
  const withoutPlaceholders = normalized.replace(PLACEHOLDER_PATTERN, "");
  if (/[{}]/u.test(withoutPlaceholders)) {
    throw new TypeError(`${label} contains unsupported placeholder syntax.`);
  }
  if (maximumExpandedLength(normalized) > maximum) {
    throw new RangeError(
      `${label} can exceed Discord's ${maximum}-character limit after placeholders are expanded.`,
    );
  }
  return normalized;
}

export function renderOnboardingTemplatePair(
  template: OnboardingTemplatePair,
  context: OnboardingTemplateContext,
): OnboardingTemplatePair {
  const normalized = normalizeOnboardingTemplatePair(
    template.title,
    template.body,
  );
  return {
    title: renderOnboardingTemplate(
      normalized.title,
      context,
      ONBOARDING_TEMPLATE_LIMITS.title,
    ),
    body: renderOnboardingTemplate(
      normalized.body,
      context,
      ONBOARDING_TEMPLATE_LIMITS.body,
    ),
  };
}

export function renderOnboardingTemplate(
  template: string,
  context: OnboardingTemplateContext,
  maximum: number,
): string {
  const replacements: Readonly<Record<OnboardingTemplatePlaceholder, string>> =
    {
      user: safeDisplay(context.userDisplay, "Member"),
      server: safeDisplay(context.serverName, "Server"),
      member_count: String(
        Number.isSafeInteger(context.memberCount) && context.memberCount >= 0
          ? context.memberCount
          : 0,
      ),
      account_created: renderTimestamp(context.accountCreatedAt),
      joined_at: renderTimestamp(context.joinedAt),
      rules: context.rulesChannelId
        ? `<#${assertSnowflake(context.rulesChannelId)}>`
        : "the server rules",
    };
  const rendered = escapeLiteralSegments(template, replacements);
  if (rendered.length > maximum) {
    throw new RangeError(
      `Rendered onboarding template exceeds Discord's ${maximum}-character limit.`,
    );
  }
  return rendered;
}

function escapeLiteralSegments(
  template: string,
  replacements: Readonly<Record<OnboardingTemplatePlaceholder, string>>,
): string {
  let result = "";
  let offset = 0;
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    const index = match.index;
    const placeholder = match[1] as OnboardingTemplatePlaceholder;
    result += escapeMarkdown(template.slice(offset, index));
    result += replacements[placeholder];
    offset = index + match[0].length;
  }
  result += escapeMarkdown(template.slice(offset));
  return result;
}

function maximumExpandedLength(template: string): number {
  let total = 0;
  let offset = 0;
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    total += escapeMarkdown(template.slice(offset, match.index)).length;
    const placeholder = match[1] as OnboardingTemplatePlaceholder;
    total += MAXIMUM_EXPANSION_LENGTH[placeholder] ?? 0;
    offset = match.index + match[0].length;
  }
  return total + escapeMarkdown(template.slice(offset)).length;
}

function safeDisplay(value: string, fallback: string): string {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 100);
  return escapeMarkdown(normalized || fallback).replace(/@/gu, "@\u200b");
}

function renderTimestamp(value: Date | null): string {
  if (!value || !Number.isFinite(value.getTime())) return "Unavailable";
  return `<t:${Math.max(0, Math.floor(value.getTime() / 1_000))}:F>`;
}

function assertSnowflake(value: string): string {
  if (!/^\d{17,20}$/u.test(value)) {
    throw new TypeError("Rules channel ID is invalid.");
  }
  return value;
}
