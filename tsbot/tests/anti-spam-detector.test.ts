import { describe, expect, it } from "vitest";
import {
  AntiSpamDetector,
  MAX_ANTI_SPAM_GUILDS,
  evaluateSyntheticAntiSpam,
  type AntiSpamDetectorRule,
} from "../src/discord/anti-spam-detector.js";

const GUILD_ID = "12345678901234567";
const MEMBER_ID = "22345678901234567";

function sample(
  content: string,
  createdTimestamp: number,
  mentions: { users?: number; roles?: number } = {},
) {
  return {
    guildId: GUILD_ID,
    memberId: MEMBER_ID,
    content,
    userMentionCount: mentions.users ?? 0,
    roleMentionCount: mentions.roles ?? 0,
    createdTimestamp,
  };
}

function rule(
  ruleType: AntiSpamDetectorRule["ruleType"],
  threshold: number,
  windowSeconds: number | null,
): AntiSpamDetectorRule {
  return { ruleType, enabled: true, threshold, windowSeconds };
}

describe("AntiSpamDetector", () => {
  it("detects a burst exactly at its rolling threshold", () => {
    const detector = new AntiSpamDetector();
    const configured = [rule("burst", 3, 5)];

    expect(detector.evaluate(sample("one", 1_000), configured)).toBeNull();
    expect(detector.evaluate(sample("two", 2_000), configured)).toBeNull();
    expect(detector.evaluate(sample("three", 3_000), configured)).toEqual({
      ruleType: "burst",
      observedCount: 3,
      threshold: 3,
      windowSeconds: 5,
    });
  });

  it("drops expired burst samples from the rolling window", () => {
    const detector = new AntiSpamDetector();
    const configured = [rule("burst", 3, 2)];

    detector.evaluate(sample("one", 1_000), configured);
    detector.evaluate(sample("two", 2_000), configured);
    expect(detector.evaluate(sample("three", 4_001), configured)).toBeNull();
  });

  it("detects normalized duplicates without retaining original text", () => {
    const detector = new AntiSpamDetector();
    const configured = [rule("duplicate", 3, 10)];

    expect(
      detector.evaluate(sample("  Repeated   TEXT ", 1_000), configured),
    ).toBeNull();
    expect(
      detector.evaluate(sample("repeated text", 2_000), configured),
    ).toBeNull();
    expect(
      detector.evaluate(sample("REPEATED TEXT", 3_000), configured),
    ).toMatchObject({ ruleType: "duplicate", observedCount: 3 });
  });

  it("counts combined user and role mentions", () => {
    const detector = new AntiSpamDetector();
    const result = detector.evaluate(
      sample("mentions", 1_000, { users: 2, roles: 2 }),
      [rule("mention", 4, null)],
    );

    expect(result).toEqual({
      ruleType: "mention",
      observedCount: 4,
      threshold: 4,
      windowSeconds: null,
    });
  });

  it("updates every rolling window when a higher-priority rule matches", () => {
    const detector = new AntiSpamDetector();
    const configured = [
      rule("mention", 2, null),
      rule("duplicate", 2, 10),
      rule("burst", 2, 10),
    ];

    expect(
      detector.evaluate(sample("same text", 1_000, { users: 2 }), configured),
    ).toMatchObject({ ruleType: "mention" });
    expect(
      detector.evaluate(sample("same text", 2_000), configured),
    ).toMatchObject({ ruleType: "duplicate", observedCount: 2 });
  });

  it("cleans guild state when disabled or explicitly cleared", () => {
    const detector = new AntiSpamDetector();
    detector.evaluate(sample("one", 1_000), [rule("burst", 3, 5)]);
    expect(detector.memberCount(GUILD_ID)).toBe(1);

    detector.evaluate(sample("two", 2_000), []);
    expect(detector.memberCount(GUILD_ID)).toBe(0);

    detector.evaluate(sample("one", 3_000), [rule("burst", 3, 5)]);
    detector.clearGuild(GUILD_ID);
    expect(detector.guildCount()).toBe(0);
  });

  it("bounds process-local guild windows with LRU eviction", () => {
    const detector = new AntiSpamDetector();
    for (let index = 0; index <= MAX_ANTI_SPAM_GUILDS; index += 1) {
      detector.evaluate(
        { ...sample("one", index), guildId: `guild-${index}` },
        [rule("burst", 3, 5)],
      );
    }
    expect(detector.guildCount()).toBe(MAX_ANTI_SPAM_GUILDS);
    expect(detector.memberCount("guild-0")).toBe(0);
  });

  it("evaluates synthetic tests without mutating detector state", () => {
    expect(
      evaluateSyntheticAntiSpam({
        rule: rule("mention", 5, null),
        userMentionCount: 3,
        roleMentionCount: 2,
      }),
    ).toMatchObject({ ruleType: "mention", observedCount: 5 });
    expect(
      evaluateSyntheticAntiSpam({
        rule: rule("duplicate", 4, 15),
        repetitionCount: 3,
      }),
    ).toBeNull();
    expect(
      evaluateSyntheticAntiSpam({
        rule: rule("duplicate", 4, 15),
        repetitionCount: 4,
        content: "  RePeAt   me  ",
      }),
    ).toMatchObject({ ruleType: "duplicate", observedCount: 4 });
    expect(
      evaluateSyntheticAntiSpam({
        rule: rule("duplicate", 4, 15),
        repetitionCount: 4,
        content: " \n\t ",
      }),
    ).toBeNull();
  });
});
