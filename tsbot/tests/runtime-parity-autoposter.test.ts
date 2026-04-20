import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { shouldRunAutoPosterNow } from "../src/discord/runtime-parity.js";
import type { CourtState } from "../src/types.js";

type AutoPosterState = Pick<
  CourtState,
  "mode" | "hour" | "minute" | "dry_run_auto_post" | "last_dry_run_date"
>;

function buildState(overrides: Partial<AutoPosterState> = {}): AutoPosterState {
  return {
    mode: "auto",
    hour: 20,
    minute: 0,
    dry_run_auto_post: false,
    last_dry_run_date: null,
    ...overrides,
  };
}

describe("auto-poster schedule gate", () => {
  it("does not run before the configured time", () => {
    const now = DateTime.fromISO("2026-04-20T19:59:00+00:00", {
      setZone: true,
    });
    const shouldRun = shouldRunAutoPosterNow(buildState(), now, null);
    expect(shouldRun).toBe(false);
  });

  it("runs when current time is after the configured minute", () => {
    const now = DateTime.fromISO("2026-04-20T20:07:00+00:00", {
      setZone: true,
    });
    const shouldRun = shouldRunAutoPosterNow(buildState(), now, null);
    expect(shouldRun).toBe(true);
  });

  it("does not run when dry-run already executed today", () => {
    const now = DateTime.fromISO("2026-04-20T20:10:00+00:00", {
      setZone: true,
    });
    const shouldRun = shouldRunAutoPosterNow(
      buildState({ dry_run_auto_post: true, last_dry_run_date: "2026-04-20" }),
      now,
      null,
    );
    expect(shouldRun).toBe(false);
  });

  it("does not run when auto-post already succeeded today", () => {
    const now = DateTime.fromISO("2026-04-20T20:10:00+00:00", {
      setZone: true,
    });
    const shouldRun = shouldRunAutoPosterNow(
      buildState(),
      now,
      "2026-04-20T09:30:00.000Z",
    );
    expect(shouldRun).toBe(false);
  });

  it("compares last auto-post date in runtime timezone", () => {
    const now = DateTime.fromISO("2026-04-20T08:00:00+03:00", {
      setZone: true,
    });
    const shouldRun = shouldRunAutoPosterNow(
      buildState({ hour: 7, minute: 0 }),
      now,
      "2026-04-19T22:30:00.000Z",
    );
    expect(shouldRun).toBe(false);
  });
});
