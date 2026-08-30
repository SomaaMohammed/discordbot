import { afterEach, describe, expect, it, vi } from "vitest";
import { observeLatency, observeLatencySync } from "../src/latency.js";
import { fetchCurrentBotMember } from "../src/discord/fetch-coalescing.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("latency instrumentation", () => {
  it("records structured stage timing without request content or credentials", async () => {
    vi.stubEnv("SUPERIOR_LOG_LEVEL", "DEBUG");
    const output = vi
      .spyOn(console, "debug")
      .mockImplementation(() => undefined);
    const secret = "Bot synthetic-token-value";

    await observeLatency(
      "authorization.member.fetch",
      "guild-member",
      async () => secret,
      { guildId: "123456789012345678", cache: "miss" },
    );
    const line = String(output.mock.calls[0]?.[0]);

    expect(line).toContain('stage="authorization.member.fetch"');
    expect(line).toContain('operation="guild-member"');
    expect(line).toContain("durationMs=");
    expect(line).toContain('outcome="success"');
    expect(line).not.toContain(secret);
  });

  it("logs failed synchronous SQLite stages without embedding thrown details", () => {
    vi.stubEnv("SUPERIOR_LOG_LEVEL", "DEBUG");
    const output = vi
      .spyOn(console, "debug")
      .mockImplementation(() => undefined);

    expect(() =>
      observeLatencySync(
        "sqlite.operation",
        "isGuildCurrent",
        () => {
          throw new Error("private database value");
        },
        { guildId: "123456789012345678" },
      ),
    ).toThrow("private database value");

    const line = String(output.mock.calls[0]?.[0]);
    expect(line).toContain('stage="sqlite.operation"');
    expect(line).toContain('outcome="failed"');
    expect(line).not.toContain("private database value");
  });

  it("coalesces overlapping bot-member fetches without caching a completed read", async () => {
    let release: ((value: null) => void) | undefined;
    const fetchMe = vi.fn(
      () =>
        new Promise<null>((resolve) => {
          release = resolve;
        }),
    );
    const guild = {
      id: "123456789012345678",
      members: { me: null, fetchMe },
    } as never;

    const first = fetchCurrentBotMember(guild);
    const second = fetchCurrentBotMember(guild);
    expect(fetchMe).toHaveBeenCalledOnce();

    release?.(null);
    await expect(Promise.all([first, second])).resolves.toEqual([null, null]);
    fetchMe.mockImplementation(() => Promise.resolve(null));
    await expect(fetchCurrentBotMember(guild)).resolves.toBeNull();
    expect(fetchMe).toHaveBeenCalledTimes(2);
  });
});
