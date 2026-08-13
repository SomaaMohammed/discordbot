import { afterEach, describe, expect, it, vi } from "vitest";
import { logDomainOutcome } from "../src/discord/domain-outcomes.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("safe domain outcome logging", () => {
  it.each([
    ["ticket", "create", "completed", "log", "INFO"],
    ["application", "submit", "failed-delivery", "warn", "WARN"],
    ["moderation", "purge", "partial-api-failures", "warn", "WARN"],
  ] as const)(
    "routes %s/%s/%s to terminal %s",
    (scope, operation, outcome, consoleMethod, level) => {
      const output = vi
        .spyOn(console, consoleMethod)
        .mockImplementation(() => undefined);

      logDomainOutcome(scope, operation, "123456789012345678", outcome, {
        recordId: "record_01",
        recordNumber: 7,
        channelId: "223456789012345678",
        state: "open",
        attemptedCount: 3,
        succeededCount: 2,
        failedCount: 1,
      });

      const line = String(output.mock.calls[0]?.[0]);
      expect(line).toContain(`[${level}] [${scope}-outcome]`);
      expect(line).toContain(`operation="${operation}"`);
      expect(line).toContain(`outcome="${outcome}"`);
      expect(line).toContain('guildId="123456789012345678"');
      expect(line).toContain('recordId="record_01"');
      expect(line).toContain("attemptedCount=3");
    },
  );

  it("drops undeclared, malformed, and private metadata fields", () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const forgedDetails = {
      recordId: "unsafe record text",
      state: "unsafe state text",
      attemptedCount: -1,
      content: "private message body",
      recipientUserId: "323456789012345678",
      applicationAnswers: ["private answer"],
    } as never;

    logDomainOutcome(
      "panel",
      "private-message-delivery",
      "123456789012345678",
      "delivered",
      forgedDetails,
    );

    const line = String(output.mock.calls[0]?.[0]);
    expect(line).toContain('outcome="delivered"');
    expect(line).not.toContain("unsafe record text");
    expect(line).not.toContain("unsafe state text");
    expect(line).not.toContain("private message body");
    expect(line).not.toContain("323456789012345678");
    expect(line).not.toContain("private answer");
    expect(line).not.toContain("attemptedCount");
  });
});
