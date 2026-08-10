import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BotStorage } from "../src/storage/db.js";
import { MAX_RESTRICTED_PING_SUCCESS_EVENTS_PER_GUILD } from "../src/storage/restricted-ping-repository.js";

const GUILD_A = "111111111111111111";
const GUILD_B = "222222222222222222";
const ROLE_A = "333333333333333333";
const ROLE_B = "444444444444444444";
const CHANNEL_A = "555555555555555555";
const CHANNEL_B = "666666666666666666";
const THREAD_A = "777777777777777777";
const ACTOR = "888888888888888888";
const USER_A = "999999999999999999";
const USER_B = "101010101010101010";
const MESSAGE = "121212121212121212";

const storages: BotStorage[] = [];
const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const storage of storages.splice(0)) storage.close();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("restricted ping persistence", () => {
  it("stores paged mappings with defaults and preserves removal audit events", () => {
    const storage = makeMemoryStorage();
    const guildA = storage.forGuild(GUILD_A);
    const guildB = storage.forGuild(GUILD_B);

    const created = guildA.addRestrictedPingMapping({
      roleId: ROLE_A,
      channelId: CHANNEL_A,
      createdBy: ACTOR,
    });
    expect(created).toMatchObject({
      status: "created",
      configuration: {
        guildId: GUILD_A,
        roleId: ROLE_A,
        enabled: true,
        userCooldownSeconds: 60,
        roleCooldownSeconds: 30,
        allowThreads: false,
      },
    });
    expect(
      guildA.addRestrictedPingMapping({
        roleId: ROLE_A,
        channelId: CHANNEL_A,
        createdBy: ACTOR,
      }),
    ).toMatchObject({ status: "duplicate" });
    guildA.addRestrictedPingMapping({
      roleId: ROLE_A,
      channelId: CHANNEL_B,
      createdBy: ACTOR,
    });

    expect(guildA.countRestrictedPingRoles()).toBe(1);
    expect(guildA.listRestrictedPingMappings(ROLE_A, 1, 0)).toEqual([
      expect.objectContaining({ channelId: CHANNEL_A }),
    ]);
    expect(guildA.listRestrictedPingMappings(ROLE_A, 1, 1)).toEqual([
      expect.objectContaining({ channelId: CHANNEL_B }),
    ]);
    expect(guildB.getRestrictedPingRole(ROLE_A)).toBeNull();
    expect(guildB.listRestrictedPingMappings(ROLE_A)).toEqual([]);
    expect(guildA.metricsIncrement("command_usage.pingrole.send")).toBe(1);
    expect(guildA.metricsIncrement("command_usage.restrictedping.add")).toBe(1);

    expect(
      guildA.removeRestrictedPingMapping(ROLE_A, CHANNEL_A, ACTOR),
    ).toMatchObject({ status: "removed", configurationDeleted: false });
    expect(
      guildA.removeRestrictedPingMapping(ROLE_A, CHANNEL_B, ACTOR),
    ).toMatchObject({ status: "removed", configurationDeleted: true });
    expect(guildA.getRestrictedPingRole(ROLE_A)).toBeNull();
    expect(
      guildA.listRestrictedPingEvents(10).map((event) => event.type),
    ).toEqual([
      "mapping_removed",
      "mapping_removed",
      "mapping_added",
      "mapping_added",
    ]);
  });

  it("reserves atomically, enforces mapped-thread policy, and starts cooldowns only on completion", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const storage = makeMemoryStorage();
    const guild = storage.forGuild(GUILD_A);
    guild.addRestrictedPingMapping({
      roleId: ROLE_A,
      channelId: CHANNEL_A,
      createdBy: ACTOR,
    });

    expect(
      guild.reserveRestrictedPing({
        roleId: ROLE_A,
        userId: USER_A,
        channelId: THREAD_A,
        mappingChannelId: CHANNEL_A,
        source: "pingrole.send",
      }),
    ).toMatchObject({ status: "channel-not-allowed" });
    guild.configureRestrictedPingRole(ROLE_A, {
      updatedBy: ACTOR,
      allowThreads: true,
    });

    const first = guild.reserveRestrictedPing({
      roleId: ROLE_A,
      userId: USER_A,
      channelId: THREAD_A,
      mappingChannelId: CHANNEL_A,
      source: "pingrole.send",
    });
    expect(first.status).toBe("reserved");
    if (first.status !== "reserved") throw new Error("Expected reservation");
    expect(Date.parse(first.expiresAt) - Date.now()).toBe(120_000);
    expect(
      guild.reserveRestrictedPing({
        roleId: ROLE_A,
        userId: USER_B,
        channelId: CHANNEL_A,
        mappingChannelId: CHANNEL_A,
        source: "pingrole.send",
      }),
    ).toMatchObject({ status: "active-reservation" });
    expect(
      guild.releaseRestrictedPing(first.reservationId, "send failed"),
    ).toBe(true);

    const retry = guild.reserveRestrictedPing({
      roleId: ROLE_A,
      userId: USER_A,
      channelId: THREAD_A,
      mappingChannelId: CHANNEL_A,
      source: "pingrole.send",
    });
    if (retry.status !== "reserved") throw new Error("Expected reservation");
    expect(
      guild.completeRestrictedPing(retry.reservationId, MESSAGE),
    ).toMatchObject({
      status: "completed",
      configuration: { successCount: 1 },
      event: {
        type: "ping_succeeded",
        channelId: THREAD_A,
        roleId: ROLE_A,
        userId: USER_A,
        details: { messageId: MESSAGE },
      },
    });
    expect(
      guild.reserveRestrictedPing({
        roleId: ROLE_A,
        userId: USER_A,
        channelId: CHANNEL_A,
        mappingChannelId: CHANNEL_A,
        source: "pingrole.send",
      }),
    ).toMatchObject({ status: "user-cooldown" });
    expect(
      guild.reserveRestrictedPing({
        roleId: ROLE_A,
        userId: USER_B,
        channelId: CHANNEL_A,
        mappingChannelId: CHANNEL_A,
        source: "pingrole.send",
      }),
    ).toMatchObject({ status: "role-cooldown" });

    vi.advanceTimersByTime(31_000);
    expect(
      guild.reserveRestrictedPing({
        roleId: ROLE_A,
        userId: USER_B,
        channelId: CHANNEL_A,
        mappingChannelId: CHANNEL_A,
        source: "pingrole.send",
      }),
    ).toMatchObject({ status: "reserved" });
  });

  it("clears expired reservations and leases for at least the configured cooldown", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const storage = makeMemoryStorage();
    const guild = storage.forGuild(GUILD_A);
    guild.addRestrictedPingMapping({
      roleId: ROLE_A,
      channelId: CHANNEL_A,
      createdBy: ACTOR,
      userCooldownSeconds: 300,
      roleCooldownSeconds: 0,
    });
    const first = guild.reserveRestrictedPing({
      roleId: ROLE_A,
      userId: USER_A,
      channelId: CHANNEL_A,
      mappingChannelId: CHANNEL_A,
      source: "pingrole.send",
    });
    if (first.status !== "reserved") throw new Error("Expected reservation");
    expect(Date.parse(first.expiresAt) - Date.now()).toBe(300_000);

    vi.advanceTimersByTime(301_000);
    expect(
      guild.reserveRestrictedPing({
        roleId: ROLE_A,
        userId: USER_B,
        channelId: CHANNEL_A,
        mappingChannelId: CHANNEL_A,
        source: "pingrole.send",
      }),
    ).toMatchObject({ status: "reserved" });
  });

  it("removes orphaned configurations on channel cleanup while retaining audit", () => {
    const storage = makeMemoryStorage();
    const guild = storage.forGuild(GUILD_A);
    for (const [roleId, channelId] of [
      [ROLE_A, CHANNEL_A],
      [ROLE_A, CHANNEL_B],
      [ROLE_B, CHANNEL_A],
    ] as const) {
      guild.addRestrictedPingMapping({ roleId, channelId, createdBy: ACTOR });
    }

    expect(guild.cleanupRestrictedPingChannel(CHANNEL_A, ACTOR)).toEqual({
      rolesDeleted: 1,
      mappingsDeleted: 2,
      userCooldownsDeleted: 0,
      roleIds: [ROLE_A, ROLE_B],
    });
    expect(guild.getRestrictedPingRole(ROLE_A)).not.toBeNull();
    expect(guild.getRestrictedPingRole(ROLE_B)).toBeNull();
    const channelEvents = guild
      .listRestrictedPingEvents(10)
      .filter((event) => event.type === "channel_deleted");
    expect(channelEvents).toHaveLength(2);
    expect(channelEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorId: ACTOR,
          source: "restrictedping.cleanup-channel",
        }),
      ]),
    );
    expect(guild.cleanupRestrictedPingRole(ROLE_A, ACTOR)).toMatchObject({
      rolesDeleted: 1,
      mappingsDeleted: 1,
      roleIds: [ROLE_A],
    });
    expect(guild.listRestrictedPingEvents(10)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "role_deleted",
          actorId: ACTOR,
          source: "restrictedping.cleanup-role",
        }),
      ]),
    );
  });

  it("retains only the newest 10,000 success events without pruning admin audit", () => {
    const { storage, dbFile } = makeFileStorage();
    const guild = storage.forGuild(GUILD_A);
    guild.addRestrictedPingMapping({
      roleId: ROLE_A,
      channelId: CHANNEL_A,
      createdBy: ACTOR,
      roleCooldownSeconds: 0,
      userCooldownSeconds: 1,
    });
    const reservation = guild.reserveRestrictedPing({
      roleId: ROLE_A,
      userId: USER_A,
      channelId: CHANNEL_A,
      mappingChannelId: CHANNEL_A,
      source: "pingrole.send",
    });
    if (reservation.status !== "reserved") {
      throw new Error("Expected reservation");
    }
    storage.close();

    const raw = new Database(dbFile);
    try {
      const insert = raw.prepare(
        `INSERT INTO restricted_ping_events (
           guild_id, event_id, event_number, event_type, actor_id, role_id,
           channel_id, user_id, source, details_json, created_at
         ) VALUES (?, ?, ?, 'ping_succeeded', ?, ?, ?, ?, 'seed', '{}', ?)`,
      );
      const seed = raw.transaction(() => {
        for (
          let index = 0;
          index < MAX_RESTRICTED_PING_SUCCESS_EVENTS_PER_GUILD;
          index += 1
        ) {
          insert.run(
            GUILD_A,
            `event${String(index).padStart(7, "0")}`,
            index + 2,
            USER_B,
            ROLE_A,
            CHANNEL_A,
            USER_B,
            "2026-01-01T00:00:00.000Z",
          );
        }
      });
      seed.immediate();
    } finally {
      raw.close();
    }

    const reopened = new BotStorage({ dbFile });
    reopened.initStorage();
    storages.push(reopened);
    expect(
      reopened
        .forGuild(GUILD_A)
        .completeRestrictedPing(reservation.reservationId, MESSAGE),
    ).toMatchObject({ status: "completed" });

    const verify = new Database(dbFile, { readonly: true });
    try {
      expect(
        verify
          .prepare(
            `SELECT COUNT(*) AS count FROM restricted_ping_events
             WHERE guild_id = ? AND event_type = 'ping_succeeded'`,
          )
          .get(GUILD_A),
      ).toEqual({ count: MAX_RESTRICTED_PING_SUCCESS_EVENTS_PER_GUILD });
      expect(
        verify
          .prepare(
            `SELECT COUNT(*) AS count FROM restricted_ping_events
             WHERE guild_id = ? AND event_type = 'mapping_added'`,
          )
          .get(GUILD_A),
      ).toEqual({ count: 1 });
      expect(
        verify
          .prepare(
            "SELECT 1 FROM restricted_ping_events WHERE guild_id = ? AND event_number = 2",
          )
          .get(GUILD_A),
      ).toBeUndefined();
    } finally {
      verify.close();
    }
  });

  it("rejects configuring the guild default role at the database boundary", () => {
    const storage = makeMemoryStorage();
    expect(() =>
      storage.forGuild(GUILD_A).addRestrictedPingMapping({
        roleId: GUILD_A,
        channelId: CHANNEL_A,
        createdBy: ACTOR,
      }),
    ).toThrow(/CHECK constraint failed/);
  });
});

function makeMemoryStorage(): BotStorage {
  const storage = new BotStorage({ dbFile: ":memory:" });
  storage.initStorage();
  storage.ensureGuild(GUILD_A);
  storage.ensureGuild(GUILD_B);
  storages.push(storage);
  return storage;
}

function makeFileStorage(): { storage: BotStorage; dbFile: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "restricted-ping-"));
  roots.push(root);
  const dbFile = path.join(root, "storage.db");
  const storage = new BotStorage({ dbFile });
  storage.initStorage();
  storage.ensureGuild(GUILD_A);
  storages.push(storage);
  return { storage, dbFile };
}
