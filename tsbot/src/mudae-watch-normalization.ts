export const MAX_PRIVATE_MUDAE_SERIES = 100;
export const MAX_PRIVATE_MUDAE_SERIES_LENGTH = 200;

const UNSAFE_CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

/**
 * Normalizes only presentation-neutral differences. Punctuation remains
 * significant so watch entries cannot broaden into fuzzy matches.
 */
export function normalizeMudaeSeriesDisplay(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Mudae series names must be text");
  }
  if (UNSAFE_CONTROL_CHARACTERS.test(value)) {
    throw new TypeError(
      "Mudae series names must not contain control characters",
    );
  }

  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized) {
    throw new RangeError("Mudae series names cannot be empty");
  }
  if (normalized.length > MAX_PRIVATE_MUDAE_SERIES_LENGTH) {
    throw new RangeError(
      `Mudae series names cannot exceed ${MAX_PRIVATE_MUDAE_SERIES_LENGTH} characters`,
    );
  }
  return normalized;
}

export function normalizeMudaeSeriesKey(value: unknown): string {
  return normalizeMudaeSeriesDisplay(value).toLowerCase();
}

export interface NormalizedMudaeSeries {
  readonly display: string;
  readonly key: string;
}

export function normalizeMudaeSeriesList(
  values: readonly unknown[],
): NormalizedMudaeSeries[] {
  if (!Array.isArray(values)) {
    throw new TypeError("Mudae series must be an array");
  }

  const unique = new Map<string, NormalizedMudaeSeries>();
  for (const value of values) {
    const display = normalizeMudaeSeriesDisplay(value);
    const key = display.toLowerCase();
    if (!unique.has(key)) {
      unique.set(key, { display, key });
    }
  }
  if (unique.size > MAX_PRIVATE_MUDAE_SERIES) {
    throw new RangeError(
      `Mudae watch configuration cannot contain more than ${MAX_PRIVATE_MUDAE_SERIES} unique series`,
    );
  }
  return [...unique.values()];
}
