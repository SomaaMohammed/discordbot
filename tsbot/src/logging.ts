import {
  boundedCauseChain,
  classifyError,
  type ClassifiedError,
} from "./errors.js";

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export type LogMetadata = Record<string, unknown>;

const MAX_STRING_LENGTH = 800;
const MAX_STACK_LENGTH = 3_000;
const MAX_COLLECTION_ITEMS = 24;
const MAX_OBJECT_KEYS = 40;
const MAX_DEPTH = 6;
const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";

const SENSITIVE_KEY_PATTERN =
  /(?:answer|attachment|authorization|body|content|cookie|credential|discordtoken|env|messagecontent|password|privateconfig|recipient|secret|series(?!count)|session|token(?!count))/iu;
const USER_CONTROLLED_KEY_PATTERN =
  /^(?:applicationAnswers?|customId|guildName|message|reasonText|suggestionBody|ticketAnswers?|userTag)$/iu;
const DISCORD_TOKEN_PATTERN =
  /(?:Bot\s+)?(?:mfa\.[\w-]{20,}|[A-Za-z\d_-]{20,}\.[A-Za-z\d_-]{6,}\.[A-Za-z\d_-]{20,})/gu;
const CREDENTIAL_URL_PATTERN =
  /([?&](?:access_token|api_key|key|password|secret|signature|token)=)[^&\s]+/giu;
const AUTHORIZATION_PATTERN =
  /\b(?:authorization|bearer)\s*[:= ]\s*[^\s,;]+/giu;

interface NormalizeState {
  readonly seen: WeakSet<object>;
  readonly depth: number;
  readonly key?: string;
}

export function redactLogValue(value: unknown, key?: string): unknown {
  return normalizeLogValue(value, {
    seen: new WeakSet<object>(),
    depth: 0,
    ...(key === undefined ? {} : { key }),
  });
}

export function logDebug(
  scope: string,
  message: string,
  metadata?: LogMetadata,
): void {
  if (process.env.SUPERIOR_LOG_LEVEL?.toUpperCase() !== "DEBUG") return;
  emitLog("DEBUG", scope, message, metadata);
}

export function logInfo(
  scope: string,
  message: string,
  metadata?: LogMetadata,
): void {
  emitLog("INFO", scope, message, metadata);
}

export function logWarn(
  scope: string,
  message: string,
  metadata?: LogMetadata,
): void {
  emitLog("WARN", scope, message, metadata);
}

export function logError(
  scope: string,
  message: string,
  metadata?: LogMetadata,
): void {
  emitLog("ERROR", scope, message, metadata);
}

export function logClassifiedError(
  scope: string,
  error: unknown,
  metadata: LogMetadata = {},
): ClassifiedError {
  const classified = classifyError(error);
  const technical = technicalErrorMetadata(error, classified);
  emitLog("ERROR", scope, classified.message, {
    ...metadata,
    ...technical,
  });
  return classified;
}

function emitLog(
  level: LogLevel,
  scope: string,
  message: string,
  metadata?: LogMetadata,
): void {
  const timestamp = new Date().toISOString();
  const safeScope = sanitizeSingleLine(scope, 80);
  const safeMessage = redactString(message, MAX_STRING_LENGTH);
  const line = `[${timestamp}] [${level}] [${safeScope}] ${safeMessage}${formatMetadata(metadata)}`;

  if (level === "ERROR") {
    console.error(line);
    return;
  }
  if (level === "WARN") {
    console.warn(line);
    return;
  }
  if (level === "DEBUG") {
    console.debug(line);
    return;
  }
  console.log(line);
}

function formatMetadata(metadata: LogMetadata | undefined): string {
  if (!metadata || Object.keys(metadata).length === 0) return "";
  const entries = Object.entries(metadata).slice(0, MAX_OBJECT_KEYS);
  const formatted = entries.map(([key, value]) => {
    const safeKey = sanitizeMetadataKey(key);
    const normalized = redactLogValue(value, key);
    return `${safeKey}=${formatMetadataValue(normalized)}`;
  });
  if (Object.keys(metadata).length > entries.length) {
    formatted.push(`metadata=${JSON.stringify(TRUNCATED)}`);
  }
  return formatted.length === 0 ? "" : ` ${formatted.join(" ")}`;
}

function formatMetadataValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify("[UNSERIALIZABLE]");
  }
}

function normalizeLogValue(value: unknown, state: NormalizeState): unknown {
  if (
    state.key &&
    (SENSITIVE_KEY_PATTERN.test(state.key) ||
      USER_CONTROLLED_KEY_PATTERN.test(state.key))
  ) {
    return REDACTED;
  }
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") return redactString(value, MAX_STRING_LENGTH);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol" || typeof value === "function") {
    return `[${typeof value}]`;
  }
  if (state.depth >= MAX_DEPTH) return TRUNCATED;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime())
      ? value.toISOString()
      : "Invalid Date";
  }
  if (value instanceof Error) {
    const classified = classifyError(value);
    return technicalErrorMetadata(value, classified);
  }
  if (typeof value !== "object")
    return redactString(String(value), MAX_STRING_LENGTH);
  if (state.seen.has(value)) return "[CIRCULAR]";
  state.seen.add(value);

  if (Array.isArray(value)) {
    const normalized = value.slice(0, MAX_COLLECTION_ITEMS).map((item) =>
      normalizeLogValue(item, {
        seen: state.seen,
        depth: state.depth + 1,
      }),
    );
    if (value.length > normalized.length) normalized.push(TRUNCATED);
    return normalized;
  }
  if (value instanceof Set) {
    return normalizeLogValue([...value], {
      seen: state.seen,
      depth: state.depth + 1,
    });
  }
  if (value instanceof Map) {
    return normalizeLogValue(Object.fromEntries([...value]), {
      seen: state.seen,
      depth: state.depth + 1,
    });
  }

  const record: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>).slice(
    0,
    MAX_OBJECT_KEYS,
  );
  for (const [key, child] of entries) {
    record[sanitizeMetadataKey(key)] = normalizeLogValue(child, {
      seen: state.seen,
      depth: state.depth + 1,
      key,
    });
  }
  if (Object.keys(value as object).length > entries.length) {
    record.metadata = TRUNCATED;
  }
  return record;
}

function technicalErrorMetadata(
  error: unknown,
  classified: ClassifiedError,
): LogMetadata {
  const stack =
    error instanceof Error && typeof error.stack === "string"
      ? redactString(error.stack, MAX_STACK_LENGTH)
      : null;
  return {
    errorName: classified.name,
    ...(classified.code === null ? {} : { code: classified.code }),
    category: classified.category,
    retryable: classified.retryable,
    action: classified.recoveryAction,
    causeChain: boundedCauseChain(error).map((cause) =>
      redactString(cause, MAX_STRING_LENGTH),
    ),
    ...(stack ? { stack } : {}),
  };
}

function sanitizeMetadataKey(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 80);
  return safe || "metadata";
}

function sanitizeSingleLine(value: string, maximum: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximum);
}

function redactString(value: string, maximum: number): string {
  const sanitized = value
    .replace(DISCORD_TOKEN_PATTERN, REDACTED)
    .replace(CREDENTIAL_URL_PATTERN, `$1${REDACTED}`)
    .replace(AUTHORIZATION_PATTERN, REDACTED)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "�")
    .replace(/\r?\n/gu, "\\n");
  if (sanitized.length <= maximum) return sanitized;
  return `${sanitized.slice(0, Math.max(0, maximum - 14))}…[truncated]`;
}
