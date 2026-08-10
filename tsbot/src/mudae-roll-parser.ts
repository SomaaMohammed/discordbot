import type { Message } from "discord.js";
import {
  normalizeMudaeSeriesDisplay,
  normalizeMudaeSeriesKey,
} from "./mudae-watch-normalization.js";

const MAX_CHARACTER_NAME_LENGTH = 256;
const INFORMATION_COMMANDS = new Set([
  "im",
  "ima",
  "imak",
  "infomarry",
  "infomarrya",
  "infomarryak",
]);
const INFORMATION_TITLE =
  /^(?:\$im\b|mudae help\b|search results?\b|wish(?:ed)?\s*list\b|wishlist\b|series list\b|characters? from\b)/iu;
const INFORMATION_FOOTER =
  /(?:\b(?:image|character|page)\s+\d+\s*\/\s*\d+\b|\$im\b|infomarry)/iu;
const NON_SERIES_LINE =
  /^(?:claims?|likes?|keys?|kakera|belongs to|react with|image\s+\d+|page\s+\d+)\s*[:#]/iu;
const UNSAFE_CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export interface ParsedMudaeRoll {
  readonly characterName: string;
  readonly seriesName: string;
  readonly normalizedSeries: string;
  readonly imageUrl: string;
  readonly sourceEmbedIndex: number;
}

export type MudaeRollMessage = Pick<
  Message,
  "components" | "content" | "embeds" | "interaction"
>;

/**
 * Extracts only character-card-shaped Mudae output. Identity and location are
 * deliberately enforced by the watcher, not by this content parser.
 */
export function parseMudaeRoll(
  message: MudaeRollMessage,
): ParsedMudaeRoll | null {
  if (
    looksLikeInformationCommand(message) ||
    message.embeds.length !== 1 ||
    !hasEnabledCustomIdButton(message.components)
  ) {
    return null;
  }

  for (const [sourceEmbedIndex, embed] of message.embeds.entries()) {
    const imageUrl = normalizeEmbedAssetUrl(embed.image?.url);
    if (!imageUrl || normalizeEmbedAssetUrl(embed.thumbnail?.url)) {
      continue;
    }

    const characterName = normalizeCharacterName(
      embed.title ?? embed.author?.name,
    );
    if (!characterName || INFORMATION_TITLE.test(characterName)) {
      continue;
    }
    const footer = normalizeLooseText(embed.footer?.text);
    if (footer && INFORMATION_FOOTER.test(footer)) {
      continue;
    }

    const seriesName = firstMeaningfulDescriptionLine(embed.description);
    if (!seriesName || NON_SERIES_LINE.test(seriesName)) {
      continue;
    }

    return {
      characterName,
      seriesName,
      normalizedSeries: normalizeMudaeSeriesKey(seriesName),
      imageUrl,
      sourceEmbedIndex,
    };
  }
  return null;
}

function hasEnabledCustomIdButton(components: readonly unknown[]): boolean {
  const pending = [...components];
  let inspected = 0;
  while (pending.length > 0 && inspected < 50) {
    inspected += 1;
    const component = pending.shift() as
      | {
          readonly type?: unknown;
          readonly customId?: unknown;
          readonly custom_id?: unknown;
          readonly disabled?: unknown;
          readonly components?: readonly unknown[];
          readonly children?: readonly unknown[];
        }
      | undefined;
    if (!component || typeof component !== "object") {
      continue;
    }
    const customId = component.customId ?? component.custom_id;
    if (
      (component.type === 2 || component.type === "Button") &&
      component.disabled !== true &&
      typeof customId === "string" &&
      customId.length >= 1 &&
      customId.length <= 100
    ) {
      return true;
    }
    if (Array.isArray(component.components)) {
      pending.push(...component.components);
    }
    if (Array.isArray(component.children)) {
      pending.push(...component.children);
    }
  }
  return false;
}

function looksLikeInformationCommand(message: MudaeRollMessage): boolean {
  const commandName = message.interaction?.commandName
    ?.normalize("NFKC")
    .trim()
    .toLowerCase();
  if (commandName && INFORMATION_COMMANDS.has(commandName)) {
    return true;
  }
  return /^\s*\$(?:im|ima|imak|infomarry|infomarrya|infomarryak)(?:\s|$)/iu.test(
    message.content ?? "",
  );
}

function firstMeaningfulDescriptionLine(
  description: string | null,
): string | null {
  if (!description || UNSAFE_CONTROL_CHARACTERS.test(description)) {
    return null;
  }
  for (const rawLine of description.split(/\r?\n/u)) {
    const line = normalizeMarkdownLine(rawLine);
    if (!line || /^[\p{P}\p{S}\s]+$/u.test(line)) {
      continue;
    }
    try {
      return normalizeMudaeSeriesDisplay(line);
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeCharacterName(
  value: string | null | undefined,
): string | null {
  const normalized = normalizeMarkdownLine(value ?? "");
  if (
    !normalized ||
    normalized.length > MAX_CHARACTER_NAME_LENGTH ||
    UNSAFE_CONTROL_CHARACTERS.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function normalizeMarkdownLine(value: string): string {
  let normalized = value
    .normalize("NFKC")
    .replace(/[\u200b-\u200d\ufeff]/gu, "")
    .trim()
    .replace(/^(?:>|#{1,6}|[-+])\s+/u, "")
    .trim();

  const markdownLink = /^\[([^\]]+)\]\((?:https?:\/\/)[^)]+\)$/iu.exec(
    normalized,
  );
  if (markdownLink?.[1]) {
    normalized = markdownLink[1];
  }

  const wrappers = ["**", "__", "~~", "`", "*", "_"] as const;
  let changed = true;
  while (changed) {
    changed = false;
    for (const wrapper of wrappers) {
      if (
        normalized.length > wrapper.length * 2 &&
        normalized.startsWith(wrapper) &&
        normalized.endsWith(wrapper)
      ) {
        normalized = normalized.slice(wrapper.length, -wrapper.length).trim();
        changed = true;
      }
    }
  }

  return normalized
    .replace(/\\([\\`*_{}\[\]()#+.!|>~-])/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeLooseText(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return normalized || null;
}

function normalizeEmbedAssetUrl(
  value: string | null | undefined,
): string | null {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 && normalized.length <= 2_048
    ? normalized
    : null;
}
