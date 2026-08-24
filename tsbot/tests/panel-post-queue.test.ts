import { describe, expect, it } from "vitest";
import { runPanelPostSerial } from "../src/discord/panel-post-queue.js";

describe("shared panel post queue", () => {
  it("serializes every command surface for the same preset and channel", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstStart = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });

    const first = runPanelPostSerial(
      "100000000000000001",
      "verification",
      "200000000000000001",
      async () => {
        events.push("onboarding-start");
        firstStarted();
        await firstGate;
        events.push("onboarding-end");
      },
    );
    await firstStart;
    const second = runPanelPostSerial(
      "100000000000000001",
      "verification",
      "200000000000000001",
      async () => {
        events.push("panel-start");
        events.push("panel-end");
      },
    );

    await Promise.resolve();
    expect(events).toEqual(["onboarding-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual([
      "onboarding-start",
      "onboarding-end",
      "panel-start",
      "panel-end",
    ]);
  });
});
