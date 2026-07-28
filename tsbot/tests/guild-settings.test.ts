import { describe, expect, it } from "vitest";
import {
  createDefaultGuildSettings,
  DEFAULT_BULK_MODERATION_TARGET_CAP,
  GUILD_SETTINGS_VERSION,
  sanitizeGuildSettings,
} from "../src/guild-settings.js";

describe("guild settings v2", () => {
  it("uses active-only, disabled defaults with a finite moderation cap", () => {
    expect(createDefaultGuildSettings()).toEqual({
      version: GUILD_SETTINGS_VERSION,
      enabled: false,
      reviewRequired: true,
      timezone: "UTC",
      features: {
        chat: false,
        replyModeration: false,
        greetings: false,
        activityMetrics: false,
      },
      channels: { log: null },
      invocation: { keyword: "superior", aliases: [] },
      limits: {
        bulkModerationTargetCap: DEFAULT_BULK_MODERATION_TARGET_CAP,
      },
      greetings: [],
    });
    expect(DEFAULT_BULK_MODERATION_TARGET_CAP).toBeGreaterThan(0);
  });

  it("normalizes invocation names and universal greeting metadata", () => {
    const settings = createDefaultGuildSettings();
    settings.invocation = {
      keyword: "  SUPERIOR  ",
      aliases: [" Helper   Bot ", "helper bot"],
    };
    settings.greetings = [
      { name: "  Friendly  ", message: "  Hello {user}!  " },
    ];
    expect(sanitizeGuildSettings(settings)).toMatchObject({
      invocation: { keyword: "superior", aliases: ["helper bot"] },
      greetings: [{ name: "Friendly", message: "Hello {user}!" }],
    });
  });

  it("rejects fixed targets, mass mentions, and direct Discord mentions", () => {
    const settings = createDefaultGuildSettings();
    expect(() =>
      sanitizeGuildSettings({
        ...settings,
        greetings: [
          {
            name: "hello",
            message: "Hello {user}",
            userId: "111111111111111111",
          },
        ],
      }),
    ).toThrow();

    for (const message of [
      "Hello @everyone",
      "Hello @here",
      "Hello <@111111111111111111>",
      "Hello <@&111111111111111111>",
    ]) {
      expect(() =>
        sanitizeGuildSettings({
          ...settings,
          greetings: [{ name: "hello", message }],
        }),
      ).toThrow(/\{user\}/);
    }
  });

  it("rejects greetings whose worst-case rendered content exceeds Discord's limit", () => {
    const settings = createDefaultGuildSettings();
    settings.greetings = [{ name: "full", message: "a".repeat(2_000) }];
    expect(sanitizeGuildSettings(settings).greetings[0]?.message).toHaveLength(
      2_000,
    );

    for (const message of ["{user}".repeat(87), "~".repeat(1_001)]) {
      expect(() =>
        sanitizeGuildSettings({
          ...settings,
          greetings: [{ name: "too-long", message }],
        }),
      ).toThrow(/render to at most 2000 Discord characters/);
    }
  });

  it("rejects unsafe enabled/review combinations and unbounded caps", () => {
    const settings = createDefaultGuildSettings();
    expect(() =>
      sanitizeGuildSettings({
        ...settings,
        enabled: true,
        reviewRequired: true,
      }),
    ).toThrow(/requiring review/);
    expect(() =>
      sanitizeGuildSettings({
        ...settings,
        limits: { bulkModerationTargetCap: 0 },
      }),
    ).toThrow();
  });

  it("requires valid tenant IDs, timezones, and unique profile names", () => {
    const settings = createDefaultGuildSettings();
    expect(() =>
      sanitizeGuildSettings({
        ...settings,
        channels: { log: "not-an-id" },
      }),
    ).toThrow();
    expect(() =>
      sanitizeGuildSettings({ ...settings, timezone: "Moon/Base" }),
    ).toThrow();
    expect(() =>
      sanitizeGuildSettings({
        ...settings,
        greetings: [
          { name: "Hello", message: "One" },
          { name: "hello", message: "Two" },
        ],
      }),
    ).toThrow(/unique/);
  });
});
