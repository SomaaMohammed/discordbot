import { afterEach, describe, expect, it, vi } from "vitest";
import { observeLatency, observeLatencySync } from "../src/latency.js";
import {
  fetchCurrentBotMember,
  fetchGuildMemberCoalesced,
  fetchGuildMemberCoalescedOrThrow,
  fetchGuildRoleCoalesced,
} from "../src/discord/fetch-coalescing.js";
import { instrumentDiscordRestLatency } from "../src/discord/bot.js";

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

  it("does not let a fresh bot-member read share a weaker request", async () => {
    const fetchMe = vi.fn(() => Promise.resolve(null));
    const guild = {
      id: "123456789012345678",
      members: { me: null, fetchMe },
    } as never;

    await Promise.all([
      fetchCurrentBotMember(guild),
      fetchCurrentBotMember(guild, { force: true }),
    ]);

    expect(fetchMe).toHaveBeenCalledTimes(2);
    expect(fetchMe.mock.calls).toEqual([[], [{ cache: true, force: true }]]);
  });

  it("coalesces overlapping member and role reads without weakening fresh reads", async () => {
    let releaseMember: ((value: unknown) => void) | undefined;
    let releaseRole: ((value: unknown) => void) | undefined;
    const member = { id: "223456789012345678" };
    const role = { id: "323456789012345678" };
    const fetchMember = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          releaseMember = resolve;
        }),
    );
    const fetchRole = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          releaseRole = resolve;
        }),
    );
    const guild = {
      id: "123456789012345678",
      members: { fetch: fetchMember },
      roles: { fetch: fetchRole },
    } as never;

    const memberReads = Promise.all([
      fetchGuildMemberCoalesced(guild, member.id),
      fetchGuildMemberCoalesced(guild, member.id),
    ]);
    const roleReads = Promise.all([
      fetchGuildRoleCoalesced(guild, role.id),
      fetchGuildRoleCoalesced(guild, role.id),
    ]);
    expect(fetchMember).toHaveBeenCalledOnce();
    expect(fetchRole).toHaveBeenCalledOnce();
    releaseMember?.(member);
    releaseRole?.(role);
    await expect(memberReads).resolves.toEqual([member, member]);
    await expect(roleReads).resolves.toEqual([role, role]);

    fetchMember.mockResolvedValue(member);
    fetchRole.mockResolvedValue(role);
    await Promise.all([
      fetchGuildMemberCoalesced(guild, member.id, {
        cache: true,
        force: false,
      }),
      fetchGuildMemberCoalesced(guild, member.id, { cache: true, force: true }),
      fetchGuildRoleCoalesced(guild, role.id, {
        cache: true,
        force: false,
      }),
      fetchGuildRoleCoalesced(guild, role.id, { cache: true, force: true }),
    ]);
    expect(fetchMember).toHaveBeenCalledTimes(3);
    expect(fetchRole).toHaveBeenCalledTimes(3);
  });

  it("preserves strict member-fetch errors while recording safe latency metadata", async () => {
    vi.stubEnv("SUPERIOR_LOG_LEVEL", "DEBUG");
    const output = vi
      .spyOn(console, "debug")
      .mockImplementation(() => undefined);
    const secret = "private-member-fetch-error";
    const guild = {
      id: "123456789012345678",
      members: {
        fetch: vi.fn(() =>
          Promise.reject(Object.assign(new Error(secret), { code: 10_007 })),
        ),
      },
    } as never;

    await expect(
      fetchGuildMemberCoalescedOrThrow(guild, "223456789012345678"),
    ).rejects.toMatchObject({ code: 10_007 });

    const line = String(output.mock.calls.at(-1)?.[0]);
    expect(line).toContain('stage="authorization.member.fetch"');
    expect(line).toContain('outcome="failed"');
    expect(line).not.toContain(secret);
  });

  it("instruments Discord REST edits without logging routes or bodies", async () => {
    vi.stubEnv("SUPERIOR_LOG_LEVEL", "DEBUG");
    const output = vi
      .spyOn(console, "debug")
      .mockImplementation(() => undefined);
    const secret = "interaction-token-or-user-content";
    const request = vi.fn(() => Promise.resolve({ ok: true }));
    const client = { rest: { request } } as unknown as {
      rest: { request: (input: unknown) => Promise<unknown> };
    };

    instrumentDiscordRestLatency(client as never);
    await client.rest.request({
      fullRoute: `/webhooks/${secret}/messages/@original`,
      method: "PATCH",
      body: { content: secret },
    });

    const line = String(output.mock.calls.at(-1)?.[0]);
    expect(line).toContain('stage="discord.rest"');
    expect(line).toContain('operation="edit"');
    expect(line).not.toContain(secret);
  });
});
