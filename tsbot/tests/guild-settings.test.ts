import { describe, expect, it } from "vitest";
import {
  createDefaultGuildSettings,
  sanitizeGuildSettings,
} from "../src/guild-settings.js";

describe("guild settings", () => {
  it("uses disabled, neutral defaults with no Discord IDs", () => {
    const settings = createDefaultGuildSettings();
    expect(settings.enabled).toBe(false);
    expect(settings.timezone).toBe("UTC");
    expect(settings.courtSchedule.mode).toBe("off");
    expect(settings.invocation.keyword).toBe("superior");
    expect(Object.values(settings.features).every((value) => !value)).toBe(
      true,
    );
    expect(JSON.stringify(settings)).not.toMatch(/\d{17,20}/);
  });

  it("normalizes safe multiword invocations and de-duplicates IDs", () => {
    const settings = createDefaultGuildSettings();
    settings.invocation.keyword = "  Imperial Court  ";
    settings.invocation.aliases = [" Your Majesty ", "your majesty"];
    settings.roles.staff = ["111111111111111111", "111111111111111111"];
    const parsed = sanitizeGuildSettings(settings);
    expect(parsed.invocation).toEqual({
      keyword: "imperial court",
      aliases: ["your majesty"],
    });
    expect(parsed.roles.staff).toEqual(["111111111111111111"]);
  });

  it("rejects invalid timezone, IDs, control characters, and unknown keys", () => {
    const settings = createDefaultGuildSettings();
    settings.timezone = "Not/A-Timezone";
    expect(() => sanitizeGuildSettings(settings)).toThrow();

    const invalidId = createDefaultGuildSettings();
    invalidId.channels.court = "123";
    expect(() => sanitizeGuildSettings(invalidId)).toThrow();

    const invalidTrigger = createDefaultGuildSettings();
    invalidTrigger.invocation.keyword = "bad\ntrigger";
    expect(() => sanitizeGuildSettings(invalidTrigger)).toThrow();

    expect(() =>
      sanitizeGuildSettings({
        ...createDefaultGuildSettings(),
        unexpected: true,
      }),
    ).toThrow();
  });
});
