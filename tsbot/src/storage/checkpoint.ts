import { z } from "zod";
import Database from "./database.js";
import { validateDatabaseFile } from "./migration.js";
import { decodePragmaString, decodeRow } from "./row-decoder.js";
import { recordSqliteOperationalEvent } from "./telemetry.js";

export const CHECKPOINT_MODES = [
  "passive",
  "full",
  "restart",
  "truncate",
] as const;

export type CheckpointMode = (typeof CHECKPOINT_MODES)[number];

export interface CheckpointResult {
  readonly mode: CheckpointMode;
  readonly outcome: "completed" | "busy";
  readonly busyFrames: number;
  readonly logFrames: number;
  readonly checkpointedFrames: number;
  readonly durationMs: number;
}

const checkpointRowSchema = z
  .object({
    busy: z.number().int().nonnegative(),
    log: z.number().int(),
    checkpointed: z.number().int(),
  })
  .strict();

export function checkpointDatabase(options: {
  dbFile: string;
  mode?: CheckpointMode;
}): CheckpointResult {
  const mode = normalizeCheckpointMode(options.mode ?? "passive");
  validateDatabaseFile(options.dbFile, { expect: 11 });
  const database = new Database(options.dbFile, {
    fileMustExist: true,
    timeout: 30_000,
  });
  const startedAt = performance.now();
  let result: CheckpointResult | null = null;
  let operationError: unknown;
  try {
    const journalMode = decodePragmaString(
      database.pragma("journal_mode")[0],
      "journal_mode",
      "PRAGMA journal_mode before checkpoint",
    );
    if (journalMode.toLowerCase() !== "wal") {
      throw new Error("WAL checkpoint requires the database to use WAL mode");
    }
    const row = decodeRow(
      checkpointRowSchema,
      database.pragma(`wal_checkpoint(${mode.toUpperCase()})`)[0],
      `PRAGMA wal_checkpoint ${mode}`,
    );
    const durationMs = performance.now() - startedAt;
    const checkpointIncomplete =
      row.log >= 0 && row.checkpointed >= 0 && row.checkpointed < row.log;
    const outcome = row.busy > 0 || checkpointIncomplete ? "busy" : "completed";
    result = {
      mode,
      outcome,
      busyFrames: row.busy,
      logFrames: Math.max(0, row.log),
      checkpointedFrames: Math.max(0, row.checkpointed),
      durationMs,
    };
    recordSqliteOperationalEvent({
      event: "checkpoint",
      ...result,
    });
  } catch (error) {
    recordSqliteOperationalEvent({
      event: "checkpoint",
      mode,
      outcome: "failed",
      durationMs: performance.now() - startedAt,
      busyFrames: 0,
      logFrames: 0,
      checkpointedFrames: 0,
    });
    operationError = error;
  }
  const finalizationErrors: Error[] = [];
  try {
    database.close();
  } catch (error) {
    finalizationErrors.push(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
  try {
    validateDatabaseFile(options.dbFile, { expect: 11 });
  } catch (error) {
    finalizationErrors.push(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
  if (operationError !== undefined) {
    if (finalizationErrors.length > 0) {
      throw new AggregateError(
        [operationError, ...finalizationErrors],
        "WAL checkpoint failed and final validation was incomplete",
      );
    }
    throw operationError;
  }
  if (finalizationErrors.length > 0) {
    throw new AggregateError(
      finalizationErrors,
      "WAL checkpoint completed but final validation failed",
    );
  }
  if (!result) throw new Error("WAL checkpoint completed without a result");
  return result;
}

export function normalizeCheckpointMode(value: unknown): CheckpointMode {
  if (
    typeof value !== "string" ||
    !(CHECKPOINT_MODES as readonly string[]).includes(value.toLowerCase())
  ) {
    throw new TypeError(
      `Checkpoint mode must be one of: ${CHECKPOINT_MODES.join(", ")}`,
    );
  }
  return value.toLowerCase() as CheckpointMode;
}
