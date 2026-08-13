export type ErrorCategory =
  | "interaction-expired"
  | "interaction-acknowledged"
  | "discord-access"
  | "discord-resource"
  | "rate-limit"
  | "network"
  | "sqlite-busy"
  | "sqlite-integrity"
  | "sqlite-schema"
  | "sqlite-transaction"
  | "configuration"
  | "filesystem"
  | "native-runtime"
  | "shutdown-timeout"
  | "child-process"
  | "unknown";

export interface ClassifiedError {
  readonly category: ErrorCategory;
  readonly name: string;
  readonly code: string | number | null;
  readonly message: string;
  readonly retryable: boolean;
  readonly interactionTokenValid: boolean;
  readonly recoveryAction: string;
}

interface ErrorShape {
  readonly name?: unknown;
  readonly message?: unknown;
  readonly code?: unknown;
  readonly status?: unknown;
  readonly cause?: unknown;
}

const DISCORD_RESOURCE_CODES = new Set([10003, 10008, 10011]);
const NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const FILESYSTEM_CODES = new Set([
  "EACCES",
  "EBUSY",
  "EISDIR",
  "EMFILE",
  "ENFILE",
  "ENOENT",
  "ENOSPC",
  "ENOTDIR",
  "EPERM",
  "EROFS",
]);
const NATIVE_RUNTIME_CODES = new Set([
  "ERR_DLOPEN_FAILED",
  "ERR_MODULE_NOT_FOUND",
  "ERR_PACKAGE_PATH_NOT_EXPORTED",
  "MODULE_NOT_FOUND",
]);

export function errorCode(error: unknown): string | number | null {
  const visited = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (visited.has(current)) break;
    visited.add(current);
    if (typeof current !== "object" && typeof current !== "function") break;
    const shape = current as ErrorShape;
    const code = normalizeCode(shape.code);
    if (code !== null) return code;
    const status = normalizeCode(shape.status);
    if (status !== null) return status;
    current = shape.cause;
  }
  return codeFromText(errorName(error)) ?? codeFromText(errorMessage(error));
}

export function isDiscordInteractionExpired(error: unknown): boolean {
  return errorCode(error) === 10062;
}

export function isDiscordInteractionAcknowledged(error: unknown): boolean {
  return errorCode(error) === 40060;
}

export function classifyError(error: unknown): ClassifiedError {
  const code = errorCode(error);
  const name = errorName(error);
  const message = errorMessage(error);

  if (code === 10062) {
    return classified(
      "interaction-expired",
      name,
      code,
      "Discord interaction expired before Superior could acknowledge it. The operation was not executed.",
      false,
      false,
      "Check event-loop-delay warnings and gateway health.",
    );
  }
  if (code === 40060) {
    return classified(
      "interaction-acknowledged",
      name,
      code,
      "Discord reports that this interaction was already acknowledged.",
      false,
      true,
      "Check the interaction acknowledgement guard for a competing response path.",
    );
  }
  if (code === 50001 || code === 50013) {
    return classified(
      "discord-access",
      name,
      code,
      code === 50013
        ? "Discord refused the operation because Superior lacks a required permission."
        : "Discord refused the operation because Superior cannot access the resource.",
      false,
      true,
      "Restore the named channel or role permission, then retry the operation.",
    );
  }
  if (typeof code === "number" && DISCORD_RESOURCE_CODES.has(code)) {
    return classified(
      "discord-resource",
      name,
      code,
      "A Discord channel, message, or role referenced by this operation no longer exists.",
      false,
      true,
      "Reconfigure only the missing resource; unrelated workflows remain available.",
    );
  }
  if (code === 429) {
    return classified(
      "rate-limit",
      name,
      code,
      "Discord temporarily rate-limited the operation.",
      true,
      true,
      "Wait for Discord's retry window; Superior will accept later operations normally.",
    );
  }
  if (typeof code === "string" && NETWORK_CODES.has(code.toUpperCase())) {
    return classified(
      "network",
      name,
      code,
      "A network or Discord gateway connection failed.",
      true,
      true,
      "Check connectivity and gateway reconnect messages, then retry.",
    );
  }
  if (
    typeof code === "string" &&
    (code.toUpperCase() === "SQLITE_BUSY" ||
      code.toUpperCase() === "SQLITE_LOCKED")
  ) {
    return classified(
      "sqlite-busy",
      name,
      code,
      "Superior's database is busy or locked by another operation or process.",
      true,
      true,
      "Confirm only one Superior instance uses this database, then retry.",
    );
  }
  if (
    typeof code === "string" &&
    (code.toUpperCase().startsWith("SQLITE_CONSTRAINT") ||
      code.toUpperCase() === "SQLITE_CORRUPT" ||
      code.toUpperCase() === "SQLITE_NOTADB")
  ) {
    return classified(
      "sqlite-integrity",
      name,
      code,
      "Superior rejected a database write or detected an integrity problem.",
      false,
      true,
      "Run the offline database check and restore a verified backup if integrity fails.",
    );
  }
  if (
    (typeof code === "string" &&
      (code.toUpperCase().includes("SCHEMA") ||
        code.toUpperCase().includes("MIGRATION"))) ||
    looksLikeSchemaOrMigrationError(message)
  ) {
    return classified(
      "sqlite-schema",
      name,
      code,
      "The database schema is unsupported, incomplete, or failed migration validation.",
      false,
      true,
      "Do not run an older executable; use the matching current release and an offline verified backup.",
    );
  }
  if (
    typeof code === "string" &&
    code.toUpperCase() === "SQLITE_ERROR" &&
    looksLikeTransactionError(message)
  ) {
    return classified(
      "sqlite-transaction",
      name,
      code,
      "Superior could not complete a database transaction safely.",
      false,
      true,
      "Stop concurrent database users, run the offline database check, and retry only with the current executable.",
    );
  }
  if (
    typeof code === "string" &&
    NATIVE_RUNTIME_CODES.has(code.toUpperCase())
  ) {
    return classified(
      "native-runtime",
      name,
      code,
      "Superior could not load a required Node.js or native runtime module.",
      false,
      true,
      "Use the complete matching release payload; do not mix runtime or native module files between releases.",
    );
  }
  if (name === "SyntaxError" || looksLikeConfigurationError(message)) {
    return classified(
      "configuration",
      name,
      code,
      "Superior could not parse or validate a configuration file.",
      false,
      true,
      "Correct the named configuration file without exposing its contents, then restart.",
    );
  }
  if (typeof code === "string" && FILESYSTEM_CODES.has(code.toUpperCase())) {
    return classified(
      "filesystem",
      name,
      code,
      "Superior could not access a required file or directory.",
      code.toUpperCase() === "EBUSY",
      true,
      "Check the application-root path, disk space, and service-account permissions.",
    );
  }
  if (code === "SHUTDOWN_TIMEOUT") {
    return classified(
      "shutdown-timeout",
      name,
      code,
      "Superior timed out while draining active work during shutdown.",
      false,
      true,
      "Review the last correlation IDs and stop the old process before replacing the executable.",
    );
  }
  if (code === "CHILD_PROCESS_EXIT") {
    return classified(
      "child-process",
      name,
      code,
      "A required child process exited unsuccessfully.",
      false,
      true,
      "Review the child exit code and payload/runtime diagnostics before restarting.",
    );
  }

  return classified(
    "unknown",
    name,
    code,
    "Superior encountered an unexpected error.",
    false,
    true,
    "Use the correlation ID and bounded stack to diagnose the failure before retrying.",
  );
}

export function boundedCauseChain(error: unknown, maximumDepth = 4): string[] {
  const chain: string[] = [];
  const visited = new Set<unknown>();
  let current: unknown = error;
  while (current && chain.length < maximumDepth && !visited.has(current)) {
    visited.add(current);
    const code = errorCodeAtCurrentLevel(current);
    chain.push(
      `${errorName(current)}${code === null ? "" : ` code=${String(code)}`}: ${errorMessage(current)}`,
    );
    if (typeof current !== "object" && typeof current !== "function") break;
    current = (current as ErrorShape).cause;
  }
  return chain;
}

function classified(
  category: ErrorCategory,
  name: string,
  code: string | number | null,
  message: string,
  retryable: boolean,
  interactionTokenValid: boolean,
  recoveryAction: string,
): ClassifiedError {
  return {
    category,
    name,
    code,
    message,
    retryable,
    interactionTokenValid,
    recoveryAction,
  };
}

function normalizeCode(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (/^\d{3,6}$/u.test(normalized)) return Number(normalized);
  return normalized.slice(0, 80);
}

function codeFromText(value: string): number | null {
  const match = /(?:DiscordAPIError\[|\bcode[=: ]+)(\d{3,6})/iu.exec(value);
  return match?.[1] ? Number(match[1]) : null;
}

function errorCodeAtCurrentLevel(error: unknown): string | number | null {
  if (!error || (typeof error !== "object" && typeof error !== "function")) {
    return null;
  }
  const shape = error as ErrorShape;
  return normalizeCode(shape.code) ?? normalizeCode(shape.status);
}

function errorName(error: unknown): string {
  if (
    error &&
    (typeof error === "object" || typeof error === "function") &&
    typeof (error as ErrorShape).name === "string"
  ) {
    return ((error as ErrorShape).name as string).slice(0, 120);
  }
  return typeof error === "string" ? "Error" : "UnknownError";
}

function errorMessage(error: unknown): string {
  if (
    error &&
    (typeof error === "object" || typeof error === "function") &&
    typeof (error as ErrorShape).message === "string"
  ) {
    return ((error as ErrorShape).message as string).slice(0, 500);
  }
  if (typeof error === "string") return error.slice(0, 500);
  return "No safe error message was provided.";
}

function looksLikeConfigurationError(message: string): boolean {
  return /(?:config(?:uration)?|\.env|json|token).*(?:invalid|missing|parse|required)|(?:invalid|missing|parse|required).*(?:config(?:uration)?|\.env|json|token)/iu.test(
    message,
  );
}

function looksLikeSchemaOrMigrationError(message: string): boolean {
  return /(?:database\s+schema|schema\s+v\d+|schema\s+(?:is\s+)?(?:unknown|incomplete|unsupported)|requires?\s+an?\s+explicit\s+migration|migration\s+(?:failed|required)|changed\s+after\s+read-only\s+classification|no\s+such\s+(?:table|column))/iu.test(
    message,
  );
}

function looksLikeTransactionError(message: string): boolean {
  return /(?:transaction|commit|rollback|savepoint)/iu.test(message);
}
