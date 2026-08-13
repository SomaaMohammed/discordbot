import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyError } from "../src/errors.js";
import {
  logClassifiedError,
  logError,
  redactLogValue,
} from "../src/logging.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readable bounded logging", () => {
  it("recursively redacts tokens, private fields, URLs, and log injection", () => {
    const discordToken = `${"A".repeat(24)}.${"B".repeat(6)}.${"C".repeat(30)}`;
    const value = redactLogValue({
      guildId: "123456789012345678",
      discordToken,
      nested: {
        authorization: `Bot ${discordToken}`,
        recipientUserId: "223456789012345678",
        link: `https://example.invalid/?token=${discordToken}`,
        harmless: "first\n[ERROR] injected",
      },
    });
    const rendered = JSON.stringify(value);

    expect(rendered).toContain("123456789012345678");
    expect(rendered).not.toContain(discordToken);
    expect(rendered).not.toContain("223456789012345678");
    expect(rendered).not.toContain("\n[ERROR] injected");
    expect(rendered).toContain("[REDACTED]");
  });

  it("prints a plain-language 10062 error with code and recovery action", () => {
    const error = Object.assign(new Error("Unknown interaction"), {
      name: "DiscordAPIError[10062]",
      code: 10062,
    });
    const output = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const classified = logClassifiedError("interaction", error, {
      correlationId: "abc123",
      command: "superior/backfillstats",
      ageMs: 3_100,
    });

    expect(classified.category).toBe("interaction-expired");
    const line = String(output.mock.calls[0]?.[0]);
    expect(line).toContain(
      "Discord interaction expired before Superior could acknowledge it.",
    );
    expect(line).toContain("code=10062");
    expect(line).toContain('correlationId="abc123"');
    expect(line).toContain("Check event-loop-delay warnings");
  });

  it("bounds stacks and metadata while retaining safe diagnosis fields", () => {
    const output = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const error = new Error(`failure ${"x".repeat(20_000)}`);
    error.stack = `Error: failure\n${"frame\n".repeat(2_000)}`;
    logError("test", "bounded failure", {
      guildId: "123456789012345678",
      error,
    });
    const line = String(output.mock.calls[0]?.[0]);
    expect(line).toContain("123456789012345678");
    expect(line).toContain("truncated");
    expect(line.length).toBeLessThan(8_000);
  });
});

describe("central error classifier", () => {
  it.each([
    [50001, "discord-access"],
    [50013, "discord-access"],
    [10003, "discord-resource"],
    [10008, "discord-resource"],
    [429, "rate-limit"],
    ["SQLITE_BUSY", "sqlite-busy"],
    ["SQLITE_CONSTRAINT_FOREIGNKEY", "sqlite-integrity"],
    ["EACCES", "filesystem"],
    ["ECONNRESET", "network"],
  ])("classifies code %s as %s", (code, category) => {
    expect(
      classifyError(Object.assign(new Error("synthetic"), { code })),
    ).toMatchObject({ category, code });
  });

  it.each([
    [
      "Database schema v7 requires an explicit migration to v8. After migration, do not run a pre-6.0.0 executable against this database.",
      "sqlite-schema",
    ],
    [
      "Database schema is unknown or incomplete; startup refused without modifying it",
      "sqlite-schema",
    ],
  ])(
    "classifies startup refusal %s as schema guidance",
    (message, category) => {
      expect(classifyError(new Error(message))).toMatchObject({
        category,
        recoveryAction: expect.stringContaining(
          "Do not run an older executable",
        ),
      });
    },
  );

  it("classifies generic SQLite transaction failures separately", () => {
    expect(
      classifyError(
        Object.assign(new Error("cannot commit - no transaction is active"), {
          code: "SQLITE_ERROR",
        }),
      ),
    ).toMatchObject({
      category: "sqlite-transaction",
      code: "SQLITE_ERROR",
    });
  });

  it.each(["MODULE_NOT_FOUND", "ERR_DLOPEN_FAILED"])(
    "classifies native runtime load failure %s",
    (code) => {
      expect(
        classifyError(
          Object.assign(new Error("native module failed"), { code }),
        ),
      ).toMatchObject({ category: "native-runtime", code });
    },
  );
});
