import { describe, expect, it } from "vitest";
import { KeyedSerialQueue } from "../src/discord/keyed-serial-queue.js";

describe("KeyedSerialQueue", () => {
  it("releases and removes a key after a failed task", async () => {
    const queue = new KeyedSerialQueue();

    await expect(
      queue.run("guild:question", async () => {
        throw new Error("injected failure");
      }),
    ).rejects.toThrow("injected failure");

    expect(queue.size).toBe(0);
    await expect(
      queue.run("guild:question", async () => "continued"),
    ).resolves.toBe("continued");
    expect(queue.size).toBe(0);
  });
});
