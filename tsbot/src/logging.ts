type LogLevel = "INFO" | "WARN" | "ERROR";

type LogMetadata = Record<string, unknown>;

function normalizeLogValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  return value;
}

function stringifyMetadata(metadata: LogMetadata | undefined): string {
  if (!metadata || Object.keys(metadata).length === 0) {
    return "";
  }

  try {
    return ` ${JSON.stringify(metadata, (_key, value) => normalizeLogValue(value))}`;
  } catch {
    return ' {"metadata":"[unserializable]"}';
  }
}

function emitLog(
  level: LogLevel,
  scope: string,
  message: string,
  metadata?: LogMetadata,
): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level}] [${scope}] ${message}${stringifyMetadata(metadata)}`;

  if (level === "ERROR") {
    console.error(line);
    return;
  }

  if (level === "WARN") {
    console.warn(line);
    return;
  }

  console.log(line);
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
