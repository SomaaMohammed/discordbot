import type { Guild } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
  createDiscordClient,
  getDiscordClientWorkLifecycle,
  recordGuildAvailable,
  recordGuildRemoved,
  recordGuildUnavailable,
} from "../src/discord/bot.js";
import type { BotRuntime } from "../src/runtime.js";
import type { GuildRecord } from "../src/types.js";

const GUILD_ID = "111111111111111111";

function record(enabled: boolean, leftAt: string | null): GuildRecord {
  return {
    guildId: GUILD_ID,
    enabled,
    name: "Guild",
    joinedAt: "2026-07-01T00:00:00.000Z",
    leftAt,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function runtimeWith(existing: GuildRecord | null): {
  runtime: BotRuntime;
  ensureGuild: ReturnType<typeof vi.fn>;
  reactivateGuild: ReturnType<typeof vi.fn>;
  invalidateGuild: ReturnType<typeof vi.fn>;
} {
  const ensureGuild = vi.fn(() => existing ?? record(true, null));
  const reactivateGuild = vi.fn(() => record(true, null));
  const invalidateGuild = vi.fn();
  return {
    runtime: {
      storage: {
        getGuild: vi.fn(() => existing),
        ensureGuild,
        reactivateGuild,
      },
      invalidateGuild,
    } as unknown as BotRuntime,
    ensureGuild,
    reactivateGuild,
    invalidateGuild,
  };
}

describe("guild lifecycle", () => {
  it("preserves an active guild during startup discovery when its join is unchanged", () => {
    const fixture = runtimeWith(record(true, null));

    const result = recordGuildAvailable(fixture.runtime, GUILD_ID, "Guild", {
      startupDiscovery: true,
      observedJoinedAt: "2026-07-01T00:00:00.000Z",
    });

    expect(result.rejoined).toBe(false);
    expect(result.record.enabled).toBe(true);
    expect(fixture.ensureGuild).toHaveBeenCalledWith(
      GUILD_ID,
      "Guild",
      "2026-07-01T00:00:00.000Z",
    );
    expect(fixture.reactivateGuild).not.toHaveBeenCalled();
    expect(fixture.invalidateGuild).toHaveBeenCalledWith(GUILD_ID);
  });

  it("preserves enablement when the stored lifecycle token is newer than Discord's stable join time", () => {
    const existing = record(true, null);
    existing.joinedAt = "2026-07-01T00:00:00.001Z";
    const fixture = runtimeWith(existing);

    const result = recordGuildAvailable(fixture.runtime, GUILD_ID, "Guild", {
      startupDiscovery: true,
      observedJoinedAt: "2026-07-01T00:00:00.000Z",
    });

    expect(result.rejoined).toBe(false);
    expect(result.record.enabled).toBe(true);
    expect(fixture.ensureGuild).toHaveBeenCalled();
    expect(fixture.reactivateGuild).not.toHaveBeenCalled();
  });

  it("treats an online guildCreate as a rejoin and restores core availability", () => {
    const fixture = runtimeWith(record(true, null));

    const result = recordGuildAvailable(fixture.runtime, GUILD_ID, "Guild", {
      observedJoinedAt: "2026-07-01T00:00:00.000Z",
    });

    expect(result.rejoined).toBe(true);
    expect(result.record.enabled).toBe(true);
    expect(fixture.reactivateGuild).toHaveBeenCalledWith(
      GUILD_ID,
      "Guild",
      "2026-07-01T00:00:00.000Z",
    );
    expect(fixture.ensureGuild).not.toHaveBeenCalled();
  });

  it("detects an offline leave/rejoin from a changed startup join timestamp", () => {
    const fixture = runtimeWith(record(true, null));

    const result = recordGuildAvailable(fixture.runtime, GUILD_ID, "Guild", {
      startupDiscovery: true,
      observedJoinedAt: "2026-07-20T00:00:00.000Z",
    });

    expect(result.rejoined).toBe(true);
    expect(result.record.enabled).toBe(true);
    expect(fixture.reactivateGuild).toHaveBeenCalledWith(
      GUILD_ID,
      "Guild",
      "2026-07-20T00:00:00.000Z",
    );
    expect(fixture.ensureGuild).not.toHaveBeenCalled();
  });

  it("reactivates a guild previously marked left during startup discovery", () => {
    const fixture = runtimeWith(record(true, "2026-07-20T00:00:00.000Z"));

    const result = recordGuildAvailable(fixture.runtime, GUILD_ID, "Guild", {
      startupDiscovery: true,
      observedJoinedAt: "2026-07-25T00:00:00.000Z",
    });

    expect(result.rejoined).toBe(true);
    expect(result.record.enabled).toBe(true);
    expect(fixture.reactivateGuild).toHaveBeenCalledWith(
      GUILD_ID,
      "Guild",
      "2026-07-25T00:00:00.000Z",
    );
    expect(fixture.ensureGuild).not.toHaveBeenCalled();
  });

  it("reconciles a startup-unavailable guild when guildAvailable fires", async () => {
    const fixture = runtimeWith(record(true, "2026-07-20T00:00:00.000Z"));
    const client = createDiscordClient(fixture.runtime);

    client.emit("guildAvailable", {
      id: GUILD_ID,
      name: "Guild",
      joinedAt: new Date("2026-07-25T00:00:00.000Z"),
    } as Guild);
    const workLifecycle = getDiscordClientWorkLifecycle(client);

    expect(workLifecycle).not.toBeNull();
    await expect(workLifecycle?.drain(1_000)).resolves.toBe(true);
    expect(fixture.reactivateGuild).toHaveBeenCalledWith(
      GUILD_ID,
      "Guild",
      "2026-07-25T00:00:00.000Z",
    );
    expect(fixture.ensureGuild).not.toHaveBeenCalled();

    workLifecycle?.stop();
    client.removeAllListeners();
  });

  it("marks an offline-unavailable guild inactive without invoking purge", () => {
    const markGuildLeft = vi.fn();
    const purgeGuildData = vi.fn();
    const invalidateGuild = vi.fn();
    const runtime = {
      storage: { markGuildLeft, purgeGuildData },
      invalidateGuild,
    } as unknown as BotRuntime;

    recordGuildUnavailable(runtime, GUILD_ID);

    expect(markGuildLeft).toHaveBeenCalledWith(GUILD_ID);
    expect(invalidateGuild).toHaveBeenCalledWith(GUILD_ID);
    expect(purgeGuildData).not.toHaveBeenCalled();
  });

  it("retains tenant data for a future rejoin after confirmed removal", () => {
    const markGuildLeft = vi.fn();
    const purgeGuildData = vi.fn(() => ({ guilds: 1 }));
    const invalidateGuild = vi.fn();
    const runtime = {
      storage: { markGuildLeft, purgeGuildData },
      invalidateGuild,
    } as unknown as BotRuntime;

    expect(recordGuildRemoved(runtime, GUILD_ID)).toBeUndefined();

    expect(invalidateGuild).toHaveBeenCalledWith(GUILD_ID);
    expect(markGuildLeft).toHaveBeenCalledWith(GUILD_ID);
    expect(purgeGuildData).not.toHaveBeenCalled();
  });

  it("routes guildDelete through inactive retention", async () => {
    const markGuildLeft = vi.fn();
    const purgeGuildData = vi.fn();
    const runtime = {
      storage: { markGuildLeft, purgeGuildData },
      invalidateGuild: vi.fn(),
    } as unknown as BotRuntime;
    const client = createDiscordClient(runtime);

    client.emit("guildDelete", {
      id: GUILD_ID,
      name: "Guild",
    } as Guild);
    const workLifecycle = getDiscordClientWorkLifecycle(client);

    await expect(workLifecycle?.drain(1_000)).resolves.toBe(true);
    expect(markGuildLeft).toHaveBeenCalledWith(GUILD_ID);
    expect(purgeGuildData).not.toHaveBeenCalled();

    workLifecycle?.stop();
    client.removeAllListeners();
  });
});
