import type {
  ModerationCaseActionType,
  ModerationCaseSource,
} from "../types.js";

const ANTI_SPAM_KEYS = new Set([
  "ruleType",
  "messageId",
  "channelId",
  "observedCount",
  "timeoutSeconds",
  "expiresAt",
]);

/**
 * Enforces the Phase 3 privacy boundary for anti-spam case metadata.
 * Anti-spam cases retain only identifiers, counters, rule selection, and the
 * timeout expiry needed for later lifecycle reconciliation.
 */
export function validateModerationCaseMetadata(
  value: unknown,
  source: ModerationCaseSource,
  actionType: ModerationCaseActionType,
): unknown {
  if (source !== "anti-spam") return value;
  if (actionType !== "automod-warning" && actionType !== "automod-timeout") {
    throw new TypeError("Anti-spam cases require an automated action type");
  }
  if (!isRecord(value)) {
    throw new TypeError("Anti-spam case metadata must be a plain object");
  }
  const keys = Object.keys(value);
  if (keys.length > ANTI_SPAM_KEYS.size) {
    throw new RangeError("Anti-spam case metadata contains too many fields");
  }
  for (const key of keys) {
    if (!ANTI_SPAM_KEYS.has(key)) {
      throw new TypeError(`Unsafe anti-spam case metadata field: ${key}`);
    }
  }
  if (
    value.ruleType !== undefined &&
    (typeof value.ruleType !== "string" ||
      !["burst", "duplicate", "mention"].includes(value.ruleType))
  ) {
    throw new TypeError("Invalid anti-spam rule metadata");
  }
  for (const [key, label] of [
    ["messageId", "message ID"],
    ["channelId", "channel ID"],
  ] as const) {
    const candidate = value[key];
    if (candidate !== undefined && !isSnowflake(candidate)) {
      throw new TypeError(`Invalid anti-spam ${label} metadata`);
    }
  }
  if (
    value.observedCount !== undefined &&
    !isIntegerBetween(value.observedCount, 1, 1_000_000)
  ) {
    throw new RangeError("Invalid anti-spam observed count metadata");
  }
  if (
    value.timeoutSeconds !== undefined &&
    (actionType !== "automod-timeout" ||
      !isIntegerBetween(value.timeoutSeconds, 60, 2_419_200))
  ) {
    throw new RangeError("Invalid anti-spam timeout metadata");
  }
  if (value.expiresAt !== undefined && value.expiresAt !== null) {
    const expiresTime =
      typeof value.expiresAt === "string"
        ? Date.parse(value.expiresAt)
        : Number.NaN;
    if (
      actionType !== "automod-timeout" ||
      typeof value.expiresAt !== "string" ||
      !Number.isFinite(expiresTime) ||
      new Date(expiresTime).toISOString() !== value.expiresAt
    ) {
      throw new TypeError("Invalid anti-spam timeout expiry metadata");
    }
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isSnowflake(value: unknown): boolean {
  return typeof value === "string" && /^\d{17,20}$/.test(value);
}

function isIntegerBetween(value: unknown, min: number, max: number): boolean {
  return (
    Number.isInteger(value) && Number(value) >= min && Number(value) <= max
  );
}
