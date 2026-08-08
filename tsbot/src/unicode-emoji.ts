const MAX_UNICODE_EMOJI_LENGTH = 16;

/** Normalize and require exactly one Unicode emoji grapheme. */
export function normalizeUnicodeEmoji(value: unknown, label = "Emoji"): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be one Unicode emoji.`);
  }
  const normalized = value.normalize("NFC").trim();
  const segments = [
    ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
      normalized,
    ),
  ];
  if (
    normalized.length > MAX_UNICODE_EMOJI_LENGTH ||
    segments.length !== 1 ||
    !(
      /\p{Extended_Pictographic}/u.test(normalized) ||
      /[\u{1F1E6}-\u{1F1FF}]/u.test(normalized) ||
      /[0-9#*]\uFE0F?\u20E3/u.test(normalized)
    )
  ) {
    throw new TypeError(`${label} must be one Unicode emoji.`);
  }
  return normalized;
}

export function normalizeOptionalUnicodeEmoji(
  value: unknown,
  label = "Emoji",
): string | null {
  return value === undefined || value === null
    ? null
    : normalizeUnicodeEmoji(value, label);
}

/** Best-effort validation for render paths that may encounter legacy rows. */
export function safeUnicodeEmoji(value: unknown): string | null {
  try {
    return normalizeOptionalUnicodeEmoji(value);
  } catch {
    return null;
  }
}
