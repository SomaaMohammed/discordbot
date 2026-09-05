import { z } from "zod";

const MAX_CONTEXT_LENGTH = 160;

export class SqliteRowDecodeError extends Error {
  public readonly code = "SQLITE_ROW_DECODE";
  public readonly context: string;

  public constructor(context: string, cause?: unknown) {
    const safeContext = normalizeContext(context);
    super(`Malformed SQLite row returned for ${safeContext}`, {
      ...(cause === undefined ? {} : { cause }),
    });
    this.name = "SqliteRowDecodeError";
    this.context = safeContext;
  }
}

export const countRowSchema = z
  .object({ count: z.number().int().nonnegative() })
  .strict();

export const sqliteVersionRowSchema = z
  .object({ version: z.string().min(1).max(80) })
  .strict();

export const integrityCheckRowSchema = z
  .object({ integrity_check: z.string().min(1).max(4_096) })
  .strict();

export const schemaVersionRowSchema = z
  .object({ version: z.number().int().positive().nullable() })
  .strict();

export const tableInfoRowSchema = z
  .object({
    cid: z.number().int().nonnegative(),
    name: z.string().min(1).max(255),
    type: z.string().max(255),
    notnull: z.number().int().min(0).max(1),
    dflt_value: z.unknown().nullable(),
    pk: z.number().int().nonnegative(),
  })
  .passthrough();

export type CountRow = z.infer<typeof countRowSchema>;
export type TableInfoRow = z.infer<typeof tableInfoRowSchema>;

export function decodeRow<T>(
  schema: z.ZodType<T>,
  value: unknown,
  context: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new SqliteRowDecodeError(context, result.error);
  }
  return result.data;
}

export function decodeOptionalRow<T>(
  schema: z.ZodType<T>,
  value: unknown | undefined,
  context: string,
): T | undefined {
  return value === undefined ? undefined : decodeRow(schema, value, context);
}

export function decodeRows<T>(
  schema: z.ZodType<T>,
  values: readonly unknown[],
  context: string,
): T[] {
  return values.map((value) => decodeRow(schema, value, context));
}

export function decodePragmaInteger(
  value: unknown,
  column: string,
  context: string,
): number {
  const record = decodeRecord(value, context);
  const field = record[column];
  if (!Number.isInteger(field)) {
    throw new SqliteRowDecodeError(context);
  }
  return field as number;
}

export function decodePragmaString(
  value: unknown,
  column: string,
  context: string,
): string {
  const record = decodeRecord(value, context);
  const field = record[column];
  if (typeof field !== "string" || field.length === 0 || field.length > 4_096) {
    throw new SqliteRowDecodeError(context);
  }
  return field;
}

function decodeRecord(
  value: unknown,
  context: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SqliteRowDecodeError(context);
  }
  return value as Record<string, unknown>;
}

function normalizeContext(value: string): string {
  const normalized = value
    .replace(/[^A-Za-z0-9_.: -]/gu, "_")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_CONTEXT_LENGTH);
  return normalized || "unknown query";
}
