import { describe, expect, it } from "vitest";
import { classifyError } from "../src/errors.js";
import {
  countRowSchema,
  decodeOptionalRow,
  decodeRow,
  decodeRows,
  SqliteRowDecodeError,
} from "../src/storage/row-decoder.js";

describe("SQLite row decoders", () => {
  it("decodes required, optional, and repeated rows", () => {
    expect(decodeRow(countRowSchema, { count: 2 }, "count query")).toEqual({
      count: 2,
    });
    expect(
      decodeOptionalRow(countRowSchema, undefined, "optional count"),
    ).toBeUndefined();
    expect(
      decodeRows(countRowSchema, [{ count: 1 }, { count: 2 }], "count list"),
    ).toEqual([{ count: 1 }, { count: 2 }]);
  });

  it("classifies malformed rows without leaking their values", () => {
    const privateValue = "private-row-value-that-must-not-be-logged";
    let failure: unknown;
    try {
      decodeRow(
        countRowSchema,
        { count: privateValue },
        "authorization lookup: delegated grants",
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SqliteRowDecodeError);
    expect((failure as SqliteRowDecodeError).code).toBe("SQLITE_ROW_DECODE");
    expect((failure as Error).message).toContain("authorization lookup");
    expect((failure as Error).message).not.toContain(privateValue);
    expect(classifyError(failure).category).toBe("sqlite-schema");
  });

  it("bounds and sanitizes query context", () => {
    expect(() =>
      decodeRow(
        countRowSchema,
        { count: -1 },
        `table\nsecret=${"x".repeat(400)}`,
      ),
    ).toThrow(/^Malformed SQLite row returned for table_secret_/u);
  });
});
