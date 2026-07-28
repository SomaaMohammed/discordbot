import { beforeEach, describe, expect, it } from "vitest";
import type {
  ConversationIntent,
  SimpleConversationIntentType,
} from "../src/conversation.js";
import {
  SIMPLE_REPLY_CATALOG,
  buildConversationReply,
  clearReplySelectionHistory,
  escapeUserText,
  type ConversationReplyContext,
} from "../src/reply-catalog.js";

function context(
  overrides: Partial<ConversationReplyContext> = {},
): ConversationReplyContext {
  return {
    guildId: "123456789012345678",
    invocation: "superior",
    botVersion: "5.0.0-test",
    timezone: "Asia/Amman",
    currentTime: "2026-07-28 14:30 +03",
    gatewayPingMs: 42.4,
    uptimeMs: 90_061_000,
    randomInt: () => 0,
    ...overrides,
  };
}

beforeEach(() => {
  clearReplySelectionHistory();
});

describe("typed reply catalog", () => {
  it("provides eight neutral variants for every simple intent", () => {
    const keys = Object.keys(SIMPLE_REPLY_CATALOG).sort();
    expect(keys).toEqual(
      [
        "about",
        "activity",
        "farewell",
        "greeting",
        "help",
        "ping",
        "thanks",
        "time",
        "uptime",
        "wellbeing",
      ].sort(),
    );

    for (const [type, pool] of Object.entries(SIMPLE_REPLY_CATALOG)) {
      expect(pool, type).toHaveLength(8);
      for (const factory of pool) {
        const reply = factory(context({ guildId: `guild-${type}` }));
        expect(reply.length, `${type}: ${reply}`).toBeGreaterThan(3);
        expect(reply.length, `${type}: ${reply}`).toBeLessThanOrEqual(2_000);
      }
    }
  });

  it("prevents an immediate repeat per guild and intent", () => {
    const intent = { type: "greeting" } as const;
    const first = buildConversationReply(intent, context());
    const second = buildConversationReply(intent, context());
    const otherGuild = buildConversationReply(
      intent,
      context({ guildId: "987654321098765432" }),
    );

    expect(second).not.toBe(first);
    expect(otherGuild).toBe(first);
  });

  it.each<readonly [SimpleConversationIntentType, readonly string[]]>([
    ["help", ["superior", "roll 2d6"]],
    ["ping", ["42 ms"]],
    ["uptime", ["1d 1h 1m 1s"]],
    ["about", ["v5.0.0-test", "Discord"]],
    ["time", ["2026-07-28 14:30 +03", "Asia/Amman"]],
  ])("keeps %s replies tied to injected facts", (type, facts) => {
    const reply = buildConversationReply({ type }, context());
    for (const fact of facts) {
      expect(reply).toContain(fact);
    }
  });

  it("reports unavailable dynamic status values factually", () => {
    expect(
      buildConversationReply(
        { type: "ping" },
        context({ gatewayPingMs: null }),
      ),
    ).toContain("not available");
    expect(
      buildConversationReply({ type: "uptime" }, context({ uptimeMs: null })),
    ).toBe("Uptime is not available yet.");
  });
});

describe("deterministic utility replies", () => {
  it("uses injected randomness for coins and bounded dice", () => {
    expect(buildConversationReply({ type: "coinflip" }, context())).toContain(
      "heads",
    );
    expect(
      buildConversationReply(
        { type: "coinflip" },
        context({ randomInt: () => 1 }),
      ),
    ).toContain("tails");
    expect(
      buildConversationReply(
        { type: "dice", count: 2, sides: 6 },
        context({ randomInt: () => 0 }),
      ),
    ).toBe("Rolled **2d6**: 1 + 1 = **2**.");
  });

  it("escapes Markdown and mention syntax in preserved choices", () => {
    const intent: ConversationIntent = {
      type: "choice",
      options: ["**@everyone <@123456789012345678> [admin]**", "normal"],
    };
    const reply = buildConversationReply(intent, context());

    expect(reply).toContain("\\*\\*");
    expect(reply).toContain("@\u200Beveryone");
    expect(reply).toContain("<@\u200B123456789012345678\\>");
    expect(reply).toContain("\\[admin\\]");
    expect(reply).not.toContain("<@123456789012345678>");
  });

  it("escapes standalone member-controlled text", () => {
    expect(escapeUserText("`x` | @here <@&123>")).toBe(
      "\\`x\\` \\| @\u200Bhere <@\u200B&123\\>",
    );
  });

  it.each([
    [{ type: "invalid", utility: "dice", error: "dice_format" }, "roll 2d6"],
    [
      { type: "invalid", utility: "dice", error: "dice_count" },
      "between 1 and 20",
    ],
    [
      { type: "invalid", utility: "dice", error: "dice_sides" },
      "between 2 and 1,000",
    ],
    [
      { type: "invalid", utility: "choice", error: "choice_count" },
      "between 2 and 20",
    ],
    [
      { type: "invalid", utility: "choice", error: "choice_length" },
      "100 characters",
    ],
  ] as const)("explains invalid input %#", (intent, expected) => {
    expect(
      buildConversationReply(intent as ConversationIntent, context()),
    ).toContain(expected);
  });
});
