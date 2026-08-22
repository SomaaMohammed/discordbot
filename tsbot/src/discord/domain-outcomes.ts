import { logInfo, logWarn } from "../logging.js";

export type DomainOutcomeScope =
  | "activity"
  | "anti-spam"
  | "appeal"
  | "application"
  | "moderation"
  | "panel"
  | "report"
  | "suggestion"
  | "ticket";

export interface SafeDomainOutcomeDetails {
  readonly recordId?: string;
  readonly recordNumber?: number;
  readonly channelId?: string;
  readonly state?: string;
  readonly attemptedCount?: number;
  readonly succeededCount?: number;
  readonly failedCount?: number;
  readonly processedCount?: number;
  readonly totalCount?: number;
}

const WARNING_OUTCOME_PATTERN =
  /(?:blocked|cancelled|denied|failed|missing|partial|rejected|unavailable)/iu;

/**
 * Emits a deliberately narrow terminal outcome record. Callers may supply only
 * operational identifiers, enum-like states, and counts; user-authored content,
 * answers, recipients, reasons, attachments, and private configuration have no
 * representation in this API.
 */
export function logDomainOutcome(
  scope: DomainOutcomeScope,
  operation: string,
  guildId: string,
  outcome: string,
  details: SafeDomainOutcomeDetails = {},
): void {
  const safeOperation = enumToken(operation);
  const safeOutcome = enumToken(outcome);
  const metadata = {
    guildId: /^\d{17,20}$/u.test(guildId) ? guildId : "unknown",
    operation: safeOperation,
    outcome: safeOutcome,
    ...(safeIdentifier(details.recordId) === undefined
      ? {}
      : { recordId: safeIdentifier(details.recordId) }),
    ...(safeCount(details.recordNumber) === undefined
      ? {}
      : { recordNumber: safeCount(details.recordNumber) }),
    ...(/^\d{17,20}$/u.test(details.channelId ?? "")
      ? { channelId: details.channelId }
      : {}),
    ...(details.state === undefined ? {} : { state: enumToken(details.state) }),
    ...countMetadata(details),
  };
  const message = `${scope[0]!.toUpperCase()}${scope.slice(1)} operation outcome`;
  if (WARNING_OUTCOME_PATTERN.test(safeOutcome)) {
    logWarn(`${scope}-outcome`, message, metadata);
    return;
  }
  logInfo(`${scope}-outcome`, message, metadata);
}

function enumToken(value: string): string {
  return /^[a-z][a-z0-9-]{0,79}$/u.test(value) ? value : "invalid";
}

function safeIdentifier(value: string | undefined): string | undefined {
  return value && /^[A-Za-z0-9_-]{1,100}$/u.test(value) ? value : undefined;
}

function safeCount(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function countMetadata(details: SafeDomainOutcomeDetails) {
  const metadata: Record<string, number> = {};
  for (const [key, value] of [
    ["attemptedCount", details.attemptedCount],
    ["succeededCount", details.succeededCount],
    ["failedCount", details.failedCount],
    ["processedCount", details.processedCount],
    ["totalCount", details.totalCount],
  ] as const) {
    const safeValue = safeCount(value);
    if (safeValue !== undefined) metadata[key] = safeValue;
  }
  return metadata;
}
