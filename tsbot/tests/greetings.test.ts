import { describe, expect, it, vi } from "vitest";
import type { GuildRuntime } from "../src/runtime.js";
import { handleGreetingCommand } from "../src/discord/greetings.js";

const GUILD_ID = "123456789012345678";
const INVOKER_ID = "223456789012345678";

function createHarness() {
  const reply = vi.fn<(payload: unknown) => Promise<void>>(
    async () => undefined,
  );
  const recordCommandMetric = vi.fn();
  const interaction = {
    user: { id: INVOKER_ID },
    options: { getString: vi.fn(() => "Welcome") },
    reply,
  };
  const runtime = {
    guildId: GUILD_ID,
    settings: {
      greetings: [
        { name: "Welcome", message: "Hello {user}! Please ignore @everyone." },
      ],
    },
    storage: { recordCommandMetric },
    isCurrent: vi.fn(() => true),
  } as unknown as GuildRuntime;
  return { interaction, runtime, reply, recordCommandMetric };
}

describe("dynamic greetings", () => {
  it("substitutes the current invoker and allows only that one mention", async () => {
    const harness = createHarness();

    await handleGreetingCommand(harness.interaction as never, harness.runtime);

    expect(harness.reply).toHaveBeenCalledWith({
      content: `Hello <@${INVOKER_ID}>! Please ignore @everyone.`,
      allowedMentions: { parse: [], users: [INVOKER_ID] },
    });
    expect(harness.recordCommandMetric).toHaveBeenCalledWith("greetings.send");
  });

  it("does not record a metric when Discord rejects the primary reply", async () => {
    const harness = createHarness();
    harness.reply.mockRejectedValueOnce(new Error("synthetic reply failure"));

    await expect(
      handleGreetingCommand(harness.interaction as never, harness.runtime),
    ).rejects.toThrow("synthetic reply failure");

    expect(harness.recordCommandMetric).not.toHaveBeenCalled();
  });

  it("bounds repeated dynamic substitutions to Discord's message limit", async () => {
    const harness = createHarness();
    harness.runtime.settings.greetings[0]!.message = "{user}".repeat(400);

    await handleGreetingCommand(harness.interaction as never, harness.runtime);

    const payload = harness.reply.mock.calls[0]?.[0] as {
      content: string;
      allowedMentions: { parse: string[]; users: string[] };
    };
    expect(payload.content.length).toBeLessThanOrEqual(2_000);
    expect(payload.content).toContain(`<@${INVOKER_ID}>`);
    expect(payload.allowedMentions).toEqual({ parse: [], users: [INVOKER_ID] });
  });
});
