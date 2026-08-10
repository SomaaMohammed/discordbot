import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PRIVATE_MUDAE_WATCH_FILENAME,
  findPrivateMudaeWatchSeries,
  isPrivateMudaeWatchLocation,
  loadPrivateMudaeWatchConfig,
  parsePrivateMudaeWatchConfig,
} from "../src/mudae-watch-config.js";
import {
  MAX_PRIVATE_MUDAE_SERIES,
  MAX_PRIVATE_MUDAE_SERIES_LENGTH,
  normalizeMudaeSeriesDisplay,
  normalizeMudaeSeriesKey,
} from "../src/mudae-watch-normalization.js";

const RECIPIENT_ID = "111111111111111111";
const MUDAE_ID = "222222222222222222";
const GUILD_ID = "333333333333333333";
const OTHER_GUILD_ID = "444444444444444444";
const CHANNEL_ID = "555555555555555555";
const OTHER_CHANNEL_ID = "666666666666666666";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "superior-mudae-config-"));
  roots.push(root);
  return root;
}

function validInput(): Record<string, unknown> {
  return {
    enabled: true,
    recipientUserId: RECIPIENT_ID,
    mudaeBotUserId: MUDAE_ID,
    locations: [
      { guildId: GUILD_ID, channelIds: [CHANNEL_ID, CHANNEL_ID] },
      { guildId: GUILD_ID, channelIds: [OTHER_CHANNEL_ID] },
    ],
    series: [
      "  Kage   no Jitsuryokusha ni Naritakute!  ",
      "kage no jitsuryokusha ni naritakute!",
      "Another Series",
    ],
  };
}

function writeConfig(root: string, input: unknown): void {
  fs.writeFileSync(
    path.join(root, PRIVATE_MUDAE_WATCH_FILENAME),
    JSON.stringify(input),
    "utf8",
  );
}

describe("private Mudae watch configuration", () => {
  it("loads, normalizes, and safely deduplicates a valid private file", () => {
    const root = temporaryRoot();
    writeConfig(root, validInput());

    const result = loadPrivateMudaeWatchConfig(root);

    expect(result.status).toBe("loaded");
    if (result.status !== "loaded") throw new Error("expected loaded config");
    expect(result.config.locations).toEqual([
      { guildId: GUILD_ID, channelIds: [CHANNEL_ID, OTHER_CHANNEL_ID] },
    ]);
    expect(result.config.series).toEqual([
      {
        display: "Kage no Jitsuryokusha ni Naritakute!",
        key: "kage no jitsuryokusha ni naritakute!",
      },
      { display: "Another Series", key: "another series" },
    ]);
    expect(
      isPrivateMudaeWatchLocation(result.config, GUILD_ID, CHANNEL_ID),
    ).toBe(true);
    expect(
      isPrivateMudaeWatchLocation(result.config, OTHER_GUILD_ID, CHANNEL_ID),
    ).toBe(false);
    expect(
      findPrivateMudaeWatchSeries(
        result.config,
        " KAGE NO JITSURYOKUSHA NI NARITAKUTE! ",
      )?.display,
    ).toBe("Kage no Jitsuryokusha ni Naritakute!");
  });

  it("quietly reports a missing file as disabled input", () => {
    const root = temporaryRoot();

    expect(loadPrivateMudaeWatchConfig(root)).toMatchObject({
      status: "missing",
      config: null,
      filePath: path.join(root, PRIVATE_MUDAE_WATCH_FILENAME),
    });
  });

  it("reports malformed JSON and schema problems without echoing values", () => {
    const root = temporaryRoot();
    const filePath = path.join(root, PRIVATE_MUDAE_WATCH_FILENAME);
    fs.writeFileSync(
      filePath,
      `{ "recipientUserId": "${RECIPIENT_ID}"`,
      "utf8",
    );
    const malformed = loadPrivateMudaeWatchConfig(root);
    expect(malformed).toMatchObject({
      status: "invalid",
      issues: ["configuration is not valid JSON"],
    });
    expect(JSON.stringify(malformed)).not.toContain(RECIPIENT_ID);

    writeConfig(root, { ...validInput(), recipientUserId: "secret-value" });
    const invalid = loadPrivateMudaeWatchConfig(root);
    expect(invalid.status).toBe("invalid");
    if (invalid.status !== "invalid")
      throw new Error("expected invalid config");
    expect(invalid.issues.join(" ")).toContain("recipientUserId");
    expect(invalid.issues.join(" ")).not.toContain("secret-value");
  });

  it("allows an explicitly disabled empty watch set", () => {
    expect(
      parsePrivateMudaeWatchConfig({
        enabled: false,
        recipientUserId: RECIPIENT_ID,
        mudaeBotUserId: MUDAE_ID,
        locations: [],
        series: [],
      }),
    ).toMatchObject({ enabled: false, locations: [], series: [] });
  });

  it("requires an actual channel and series whenever enabled", () => {
    expect(() =>
      parsePrivateMudaeWatchConfig({
        ...validInput(),
        locations: [{ guildId: GUILD_ID, channelIds: [] }],
      }),
    ).toThrow(/monitored channel/iu);
    expect(() =>
      parsePrivateMudaeWatchConfig({ ...validInput(), series: [] }),
    ).toThrow(/watched series/iu);
  });

  it("rejects cross-guild channel reuse and recipient/bot identity overlap", () => {
    expect(() =>
      parsePrivateMudaeWatchConfig({
        ...validInput(),
        locations: [
          { guildId: GUILD_ID, channelIds: [CHANNEL_ID] },
          { guildId: OTHER_GUILD_ID, channelIds: [CHANNEL_ID] },
        ],
      }),
    ).toThrow(/more than one guild/iu);
    expect(() =>
      parsePrivateMudaeWatchConfig({
        ...validInput(),
        recipientUserId: MUDAE_ID,
      }),
    ).toThrow(/must be different/iu);
  });

  it("enforces unique-series count and normalized length limits", () => {
    const tooMany = Array.from(
      { length: MAX_PRIVATE_MUDAE_SERIES + 1 },
      (_, index) => `Series ${index}`,
    );
    expect(() =>
      parsePrivateMudaeWatchConfig({ ...validInput(), series: tooMany }),
    ).toThrow(/unique series/iu);
    expect(() =>
      parsePrivateMudaeWatchConfig({
        ...validInput(),
        series: ["x".repeat(MAX_PRIVATE_MUDAE_SERIES_LENGTH + 1)],
      }),
    ).toThrow(/1-200 characters/iu);
  });
});

describe("Mudae series normalization", () => {
  it("normalizes compatibility characters and harmless whitespace only", () => {
    expect(normalizeMudaeSeriesDisplay("  Ａnother\t\n Series  ")).toBe(
      "Another Series",
    );
    expect(normalizeMudaeSeriesKey(" KAGE   NO JITSURYOKUSHA ")).toBe(
      "kage no jitsuryokusha",
    );
    expect(normalizeMudaeSeriesKey("Series!")).not.toBe(
      normalizeMudaeSeriesKey("Series"),
    );
  });

  it("rejects empty, oversized, and unsafe control-character input", () => {
    expect(() => normalizeMudaeSeriesDisplay(" \n\t ")).toThrow(/empty/iu);
    expect(() =>
      normalizeMudaeSeriesDisplay(
        "x".repeat(MAX_PRIVATE_MUDAE_SERIES_LENGTH + 1),
      ),
    ).toThrow(/exceed/iu);
    expect(() => normalizeMudaeSeriesDisplay("Series\u0000Name")).toThrow(
      /control/iu,
    );
  });
});
