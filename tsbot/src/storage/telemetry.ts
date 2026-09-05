import { errorCode } from "../errors.js";
import { logInfo, logWarn } from "../logging.js";

export type SqliteOperation =
  | "prepare"
  | "statement-run"
  | "statement-get"
  | "statement-all"
  | "transaction"
  | "exec"
  | "pragma"
  | "vacuum-into"
  | "checkpoint"
  | "close";

export type TransactionMode =
  "default" | "deferred" | "immediate" | "exclusive";

export type SqliteOperationalEvent =
  | {
      event: "sqlite-contention";
      code: "SQLITE_BUSY" | "SQLITE_LOCKED";
      operation: SqliteOperation;
    }
  | {
      event: "transaction";
      mode: TransactionMode;
      outcome: "committed" | "rolled-back";
      durationMs: number;
    }
  | {
      event: "migration";
      outcome: "migrated" | "dry-run" | "already-current" | "failed";
      fromSchema: string;
      durationMs: number;
    }
  | {
      event: "backup";
      outcome: "published" | "failed";
      snapshotDurationMs: number;
      totalDurationMs: number;
      concurrentWritesObserved: boolean;
      backupBytes: number;
      walBytes: number;
    }
  | {
      event: "checkpoint";
      mode: "passive" | "full" | "restart" | "truncate";
      outcome: "completed" | "busy" | "failed";
      durationMs: number;
      busyFrames: number;
      logFrames: number;
      checkpointedFrames: number;
    }
  | {
      event: "shutdown-drain";
      outcome: "drained" | "timed-out" | "failed";
      durationMs: number;
    }
  | {
      event: "database-close";
      outcome: "failed";
    };

/**
 * Emits only fixed, bounded, low-cardinality SQLite operational fields.
 * Logging is observability-only: logger failures must never alter database work.
 */
export function recordSqliteOperationalEvent(
  value: SqliteOperationalEvent,
): void {
  try {
    switch (value.event) {
      case "sqlite-contention":
        logWarn("sqlite-telemetry", "SQLite contention observed", {
          event: value.event,
          code: value.code,
          operation: value.operation,
        });
        return;
      case "transaction":
        logInfo("sqlite-telemetry", "SQLite transaction completed", {
          event: value.event,
          mode: value.mode,
          outcome: value.outcome,
          durationMs: boundedNumber(value.durationMs),
        });
        return;
      case "migration":
        logInfo("sqlite-telemetry", "SQLite migration completed", {
          event: value.event,
          outcome: value.outcome,
          fromSchema: boundedSchema(value.fromSchema),
          durationMs: boundedNumber(value.durationMs),
        });
        return;
      case "backup":
        logInfo("sqlite-telemetry", "SQLite backup completed", {
          event: value.event,
          outcome: value.outcome,
          snapshotDurationMs: boundedNumber(value.snapshotDurationMs),
          totalDurationMs: boundedNumber(value.totalDurationMs),
          concurrentWritesObserved: value.concurrentWritesObserved,
          backupBytes: boundedInteger(value.backupBytes),
          walBytes: boundedInteger(value.walBytes),
        });
        return;
      case "checkpoint":
        logInfo("sqlite-telemetry", "SQLite checkpoint completed", {
          event: value.event,
          mode: value.mode,
          outcome: value.outcome,
          durationMs: boundedNumber(value.durationMs),
          busyFrames: boundedInteger(value.busyFrames),
          logFrames: boundedInteger(value.logFrames),
          checkpointedFrames: boundedInteger(value.checkpointedFrames),
        });
        return;
      case "shutdown-drain":
        logInfo("sqlite-telemetry", "Graceful shutdown drain completed", {
          event: value.event,
          outcome: value.outcome,
          durationMs: boundedNumber(value.durationMs),
        });
        return;
      case "database-close":
        logWarn("sqlite-telemetry", "SQLite close failed", {
          event: value.event,
          outcome: value.outcome,
        });
    }
  } catch {
    // Telemetry is deliberately best-effort and must never affect SQLite state.
  }
}

export function recordSqliteContention(
  error: unknown,
  operation: SqliteOperation,
): void {
  const code = errorCode(error);
  if (typeof code !== "string") return;
  const normalized = code.toUpperCase();
  if (normalized !== "SQLITE_BUSY" && normalized !== "SQLITE_LOCKED") return;
  recordSqliteOperationalEvent({
    event: "sqlite-contention",
    code: normalized,
    operation,
  });
}

function boundedNumber(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(86_400_000, Math.round(value * 1_000) / 1_000);
}

function boundedInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, value);
}

function boundedSchema(value: string): string {
  const normalized = value.replace(/[^a-z0-9-]/giu, "_").slice(0, 40);
  return normalized || "unknown";
}
