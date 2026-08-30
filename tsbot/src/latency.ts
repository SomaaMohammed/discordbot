import { performance } from "node:perf_hooks";
import { logDebug, logInfo } from "./logging.js";

export interface LatencyContext {
  readonly guildId?: string;
  readonly correlationId?: string;
  readonly cache?: "hit" | "miss" | "coalesced";
}

/**
 * Records bounded, metadata-only timing events. Callers provide identifiers,
 * never request or response payloads, so latency diagnostics cannot become a
 * second content or credential logging channel.
 */
export async function observeLatency<T>(
  stage: string,
  operation: string,
  task: () => Promise<T>,
  context: LatencyContext = {},
  level: "debug" | "info" = "debug",
): Promise<T> {
  const startedAt = performance.now();
  try {
    const result = await task();
    emitLatency(level, stage, operation, startedAt, "success", context);
    return result;
  } catch (error) {
    emitLatency(level, stage, operation, startedAt, "failed", context);
    throw error;
  }
}

export function observeLatencySync<T>(
  stage: string,
  operation: string,
  task: () => T,
  context: LatencyContext = {},
  level: "debug" | "info" = "debug",
): T {
  const startedAt = performance.now();
  try {
    const result = task();
    emitLatency(level, stage, operation, startedAt, "success", context);
    return result;
  } catch (error) {
    emitLatency(level, stage, operation, startedAt, "failed", context);
    throw error;
  }
}

function emitLatency(
  level: "debug" | "info",
  stage: string,
  operation: string,
  startedAt: number,
  outcome: "success" | "failed",
  context: LatencyContext,
): void {
  const durationMs = Math.max(
    0,
    Math.round((performance.now() - startedAt) * 10) / 10,
  );
  const metadata = {
    stage,
    operation,
    durationMs,
    outcome,
    ...(context.guildId === undefined ? {} : { guildId: context.guildId }),
    ...(context.correlationId === undefined
      ? {}
      : { correlationId: context.correlationId }),
    ...(context.cache === undefined ? {} : { cache: context.cache }),
  };
  if (level === "info") {
    logInfo("latency", "Stage completed", metadata);
  } else {
    logDebug("latency", "Stage completed", metadata);
  }
}
