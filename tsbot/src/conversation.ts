const DEFAULT_INVOCATION_TERMS = ["superior"] as const;

export const CONVERSATION_MAX_DICE = 20;
export const CONVERSATION_MAX_DIE_SIDES = 1_000;
export const CONVERSATION_MAX_CHOICES = 20;
export const CONVERSATION_MAX_CHOICE_LENGTH = 100;
export const REPLY_MODERATION_MAX_REASON_LENGTH = 400;

export type SimpleConversationIntentType =
  | "greeting"
  | "wellbeing"
  | "activity"
  | "help"
  | "thanks"
  | "farewell"
  | "ping"
  | "uptime"
  | "about"
  | "time";

export type ConversationValidationError =
  | "dice_format"
  | "dice_count"
  | "dice_sides"
  | "choice_count"
  | "choice_length";

export type ConversationIntent =
  | { type: SimpleConversationIntentType }
  | { type: "coinflip" }
  | { type: "dice"; count: number; sides: number }
  | { type: "choice"; options: string[] }
  | {
      type: "invalid";
      utility: "dice" | "choice";
      error: ConversationValidationError;
    };

export type ReplyModerationRequest =
  | { type: "timeout"; reason: string }
  | {
      type: "invalid";
      error: "reason_length";
      maximumLength: number;
    };

export interface ConversationAddressOptions {
  invocationTerms?: readonly string[];
  botUserId?: string | null;
  /** Set only after the caller verifies that the referenced message is the bot's. */
  replyToBot?: boolean;
}

interface AddressedRequest {
  raw: string;
  normalized: string;
}

const SIMPLE_ALIASES = {
  greeting: new Set([
    "hi",
    "hey",
    "hello",
    "yo",
    "sup",
    "gm",
    "good morning",
    "good afternoon",
    "good evening",
  ]),
  wellbeing: new Set([
    "wsp",
    "wsg",
    "wassup",
    "whats up",
    "how are you",
    "how r u",
    "how are u",
    "hru",
    "how you doing",
    "how u doing",
    "hows it going",
  ]),
  activity: new Set(["what are you doing", "what r u doing", "wyd"]),
  help: new Set([
    "help",
    "command",
    "commands",
    "cmds",
    "command list",
    "what can you do",
    "what can u do",
    "how do i use you",
    "how do i use this",
  ]),
  thanks: new Set([
    "thanks",
    "thank you",
    "thx",
    "ty",
    "tysm",
    "appreciate it",
  ]),
  farewell: new Set([
    "bye",
    "goodbye",
    "cya",
    "see ya",
    "see you",
    "later",
    "gtg",
    "goodnight",
    "good night",
    "gn",
  ]),
  ping: new Set([
    "ping",
    "pong",
    "latency",
    "are you online",
    "r u online",
    "are you alive",
    "you there",
  ]),
  uptime: new Set([
    "uptime",
    "how long have you been up",
    "how long u been up",
    "how long have you been running",
    "how long have you been online",
  ]),
  about: new Set([
    "who are you",
    "who r u",
    "what are you",
    "version",
    "ver",
    "about",
    "about you",
    "bot info",
  ]),
  time: new Set([
    "what time is it",
    "whats the time",
    "what time rn",
    "time now",
    "current time",
    "tell me the time",
  ]),
} as const satisfies Record<SimpleConversationIntentType, ReadonlySet<string>>;

const POLITE_PREFIXES = [
  "please ",
  "can you ",
  "can u ",
  "could you ",
  "could u ",
  "would you ",
  "would u ",
  "will you ",
  "will u ",
] as const;

const MODERATION_ACTION_PATTERN =
  /^(?:mute|silence|timeout|time out|quiet|hush)(?:\s+(?:them|him|her|this user|this member))?\b(?:[\s,:;\-]*(.*))?$/i;
const MODERATION_IMPLICIT_PATTERN =
  /^(?:you know what to do|u know what to do|do your thing|handle this)\b(?:[\s,:;\-]*(.*))?$/i;

/**
 * Produce a deterministic comparison form without fuzzy matching.
 * NFKC folds full-width forms; apostrophes inside words are removed so
 * straight and curly contractions share one canonical spelling.
 */
export function normalizeConversationText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\u2018\u2019\u201A\u201B\u2032\uFF07]/g, "'")
    .replace(/(?<=\p{L})'(?=\p{L})/gu, "")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Explicit precedence: moderation, dice, choice, then exact simple aliases. */
export function parseConversationIntent(
  content: string,
  options: ConversationAddressOptions = {},
): ConversationIntent | null {
  if (parseReplyModerationRequest(content, options) !== null) {
    return null;
  }

  const request = extractAddressedRequest(content, options);
  if (!request) {
    return null;
  }

  const normalized = stripPolitePrefix(request.normalized);
  if (!normalized) {
    return { type: "greeting" };
  }

  const dice = parseDiceIntent(normalized);
  if (dice) {
    return dice;
  }

  const choice = parseChoiceIntent(request.raw, normalized);
  if (choice) {
    return choice;
  }

  if (COINFLIP_ALIASES.has(normalized)) {
    return { type: "coinflip" };
  }

  // Order is intentional where natural phrases could otherwise overlap.
  const precedence: readonly SimpleConversationIntentType[] = [
    "activity",
    "wellbeing",
    "uptime",
    "ping",
    "about",
    "time",
    "help",
    "thanks",
    "farewell",
    "greeting",
  ];
  for (const type of precedence) {
    if (SIMPLE_ALIASES[type].has(normalized)) {
      return { type };
    }
  }

  return null;
}

export function parseReplyModerationRequest(
  content: string,
  options: ConversationAddressOptions = {},
): ReplyModerationRequest | null {
  const request = extractAddressedRequest(content, options);
  if (!request) {
    return null;
  }

  const raw = stripRawPolitePrefix(request.raw).trim();
  const match =
    MODERATION_ACTION_PATTERN.exec(raw) ??
    MODERATION_IMPLICIT_PATTERN.exec(raw);
  if (!match) {
    return null;
  }

  const reason = (match[1] ?? "")
    .trim()
    .replace(/^[,;:\-\s]+/, "")
    .trim();
  if (Array.from(reason).length > REPLY_MODERATION_MAX_REASON_LENGTH) {
    return {
      type: "invalid",
      error: "reason_length",
      maximumLength: REPLY_MODERATION_MAX_REASON_LENGTH,
    };
  }

  return { type: "timeout", reason };
}

function extractAddressedRequest(
  content: string,
  options: ConversationAddressOptions,
): AddressedRequest | null {
  const canonical = normalizeAddressInput(content);
  if (!canonical) {
    return null;
  }

  const addressPattern = buildAddressPattern(options);
  if (addressPattern) {
    const delimiter = String.raw`(?:\s|[,!?:;\-]|\p{Extended_Pictographic}|\uFE0F)+`;
    const edgeEmoji = String.raw`(?:\s|\p{Extended_Pictographic}|\p{Emoji_Modifier}|\uFE0F)*`;
    const salutation = String.raw`(?:hi|hello|hey|yo|ok|okay)`;

    const invocationOnly = new RegExp(
      String.raw`^${edgeEmoji}(?:(${salutation})${delimiter})?(?:${addressPattern})[.!?\s\p{Extended_Pictographic}\uFE0F]*$`,
      "iu",
    ).exec(canonical);
    if (invocationOnly) {
      const raw = invocationOnly[1] ?? "";
      return { raw, normalized: normalizeConversationText(raw) };
    }

    const prefixed = new RegExp(
      String.raw`^${edgeEmoji}(?:(?:${salutation})${delimiter})?(?:${addressPattern})${delimiter}([\s\S]*?)${edgeEmoji}$`,
      "iu",
    ).exec(canonical);
    if (prefixed) {
      const raw = trimRequestDecorations(prefixed[1] ?? "");
      return { raw, normalized: normalizeConversationText(raw) };
    }

    const suffixed = new RegExp(
      String.raw`^${edgeEmoji}([\s\S]*?)${delimiter}(?:${addressPattern})[.!?\s\p{Extended_Pictographic}\uFE0F]*$`,
      "iu",
    ).exec(canonical);
    if (suffixed) {
      const raw = trimRequestDecorations(suffixed[1] ?? "");
      return { raw, normalized: normalizeConversationText(raw) };
    }
  }

  if (!options.replyToBot) {
    return null;
  }

  const raw = trimRequestDecorations(canonical);
  return { raw, normalized: normalizeConversationText(raw) };
}

function buildAddressPattern(options: ConversationAddressOptions): string {
  const invocationTerms = options.invocationTerms ?? DEFAULT_INVOCATION_TERMS;
  const patterns: string[] = [];
  const seen = new Set<string>();

  for (const rawTerm of invocationTerms.slice(0, 21)) {
    const term = normalizeAddressInput(rawTerm).trim().replace(/\s+/g, " ");
    const searchable = normalizeConversationText(term);
    const comparison = term.toLocaleLowerCase("en-US");
    if (!term || !searchable || seen.has(comparison)) {
      continue;
    }
    seen.add(comparison);
    patterns.push(
      term
        .split(/\s+/)
        .map((part) => escapeRegExp(part))
        .join(String.raw`\s+`),
    );
  }

  const botUserId = options.botUserId?.trim() ?? "";
  if (/^\d{17,20}$/.test(botUserId)) {
    patterns.push(String.raw`<@!?${escapeRegExp(botUserId)}>`);
  }

  patterns.sort((left, right) => right.length - left.length);
  return patterns.length === 0 ? "" : `(?:${patterns.join("|")})`;
}

function normalizeAddressInput(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B\u2032\uFF07]/g, "'")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, " ")
    .trim();
}

function trimRequestDecorations(value: string): string {
  return value
    .replace(
      /^(?:\s|[,!?:;\-]|\p{Extended_Pictographic}|\p{Emoji_Modifier}|\uFE0F)+/gu,
      "",
    )
    .replace(
      /(?:\s|[.!?:;\-]|\p{Extended_Pictographic}|\p{Emoji_Modifier}|\uFE0F)+$/gu,
      "",
    )
    .trim();
}

function stripPolitePrefix(normalized: string): string {
  for (const prefix of POLITE_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      return normalized.slice(prefix.length);
    }
  }
  return normalized;
}

function stripRawPolitePrefix(raw: string): string {
  return raw.replace(
    /^\s*(?:please|can\s+(?:you|u)|could\s+(?:you|u)|would\s+(?:you|u)|will\s+(?:you|u))\s+/i,
    "",
  );
}

const COINFLIP_ALIASES = new Set([
  "flip a coin",
  "flip the coin",
  "flip coin",
  "toss a coin",
  "toss the coin",
  "toss coin",
  "coin flip",
  "coin toss",
  "heads or tails",
]);

function parseDiceIntent(normalized: string): ConversationIntent | null {
  const notation =
    /^(?:(?:roll|throw)\s+)?(?:a\s+)?(?:(\d+)\s*)?d\s*(\d+)$/.exec(normalized);
  if (notation) {
    return validateDice(
      Number.parseInt(notation[1] ?? "1", 10),
      Number.parseInt(notation[2] ?? "0", 10),
    );
  }

  const words =
    /^(?:roll|throw)(?:\s+(\d+))?\s+(?:a\s+)?(?:die|dice)(?:\s+(?:with\s+)?(\d+)\s+sides?)?$/.exec(
      normalized,
    );
  if (words) {
    return validateDice(
      Number.parseInt(words[1] ?? "1", 10),
      Number.parseInt(words[2] ?? "6", 10),
    );
  }

  if (/^(?:roll|throw|dice)(?:\s|$)/.test(normalized)) {
    return { type: "invalid", utility: "dice", error: "dice_format" };
  }
  return null;
}

function validateDice(count: number, sides: number): ConversationIntent {
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > CONVERSATION_MAX_DICE
  ) {
    return { type: "invalid", utility: "dice", error: "dice_count" };
  }
  if (
    !Number.isSafeInteger(sides) ||
    sides < 2 ||
    sides > CONVERSATION_MAX_DIE_SIDES
  ) {
    return { type: "invalid", utility: "dice", error: "dice_sides" };
  }
  return { type: "dice", count, sides };
}

function parseChoiceIntent(
  rawRequest: string,
  normalized: string,
): ConversationIntent | null {
  if (
    !/^(?:choose|pick|decide|select|should i choose|which should i (?:choose|pick))(?:\s|$)/.test(
      normalized,
    )
  ) {
    return null;
  }

  const withoutPolitePrefix = stripRawPolitePrefix(rawRequest);
  const optionText = withoutPolitePrefix.replace(
    /^\s*(?:(?:choose|pick|decide|select)(?:\s+for\s+me)?(?:\s+(?:between|from))?|should\s+i\s+choose|which\s+should\s+i\s+(?:choose|pick))\s+/i,
    "",
  );
  const options = optionText
    .split(/\s+or\s+|\s*[|,]\s*/i)
    .map((option) =>
      option
        .trim()
        .replace(/^or\s+/i, "")
        .trim(),
    )
    .filter(Boolean);
  const unique = new Map<string, string>();
  for (const option of options) {
    const comparison = normalizeConversationText(option);
    if (comparison && !unique.has(comparison)) {
      unique.set(comparison, option);
    }
  }
  const uniqueOptions = [...unique.values()];

  if (
    uniqueOptions.length < 2 ||
    uniqueOptions.length > CONVERSATION_MAX_CHOICES
  ) {
    return { type: "invalid", utility: "choice", error: "choice_count" };
  }
  if (
    uniqueOptions.some(
      (option) => Array.from(option).length > CONVERSATION_MAX_CHOICE_LENGTH,
    )
  ) {
    return { type: "invalid", utility: "choice", error: "choice_length" };
  }

  return { type: "choice", options: uniqueOptions };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
