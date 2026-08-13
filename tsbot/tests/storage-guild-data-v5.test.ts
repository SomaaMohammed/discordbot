import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BotStorage } from "../src/storage/db.js";
import { createDefaultLegacyGuildSettingsV2 } from "../src/storage/guild-settings-v2.js";
import { MAX_RESTRICTED_PING_SUCCESS_EVENTS_PER_GUILD } from "../src/storage/restricted-ping-repository.js";
import type { GuildDataExport } from "../src/types.js";

const GUILD = "111111111111111111";
const ADMIN = "222222222222222222";
const ROLE = "333333333333333333";
const OTHER_ROLE = "444444444444444444";
const CHANNEL = "555555555555555555";
const USER = "666666666666666666";
const SECOND_USER = "777777777777777777";
const MESSAGE = "888888888888888888";
const TIMESTAMP = "2026-01-01T00:00:00.000Z";
const storages: BotStorage[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const storage of storages.splice(0)) storage.close();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("restricted ping guild data format 6", () => {
  it("round-trips history fail-closed without exporting a live reservation", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD);
    const guild = storage.forGuild(GUILD);
    seedMapping(guild);

    const first = guild.reserveRestrictedPing({
      roleId: ROLE,
      userId: USER,
      channelId: CHANNEL,
      mappingChannelId: CHANNEL,
      source: "pingrole",
    });
    if (first.status !== "reserved") throw new Error("Expected reservation");
    expect(
      guild.completeRestrictedPing(first.reservationId, MESSAGE).status,
    ).toBe("completed");
    const live = guild.reserveRestrictedPing({
      roleId: ROLE,
      userId: SECOND_USER,
      channelId: CHANNEL,
      mappingChannelId: CHANNEL,
      source: "pingrole",
    });
    if (live.status !== "reserved")
      throw new Error("Expected live reservation");

    const payload = storage.exportGuildData(GUILD);
    expect(payload).toMatchObject({
      formatVersion: 6,
      restrictedPingRoles: [
        {
          guildId: GUILD,
          roleId: ROLE,
          enabled: true,
          userCooldownSeconds: 60,
          roleCooldownSeconds: 0,
          allowThreads: true,
          successCount: 1,
        },
      ],
      restrictedPingMappings: [
        { guildId: GUILD, roleId: ROLE, channelId: CHANNEL },
      ],
      restrictedPingUserCooldowns: [
        {
          guildId: GUILD,
          roleId: ROLE,
          userId: USER,
          successCount: 1,
        },
      ],
    });
    expect(payload.restrictedPingEvents.map(({ type }) => type)).toEqual([
      "mapping_added",
      "ping_succeeded",
    ]);
    expect(payload.restrictedPingUserCooldowns[0]?.updatedAt).toMatch(/Z$/);
    expect(JSON.stringify(payload)).not.toMatch(
      /reservation(Id|UserId|ChannelId|Source|ExpiresAt)/,
    );

    storage.importGuildData(GUILD, payload, storage.getGuildSettings(GUILD)!);
    const restored = storage.exportGuildData(GUILD);
    expect(restored.restrictedPingRoles).toEqual([
      expect.objectContaining({
        roleId: ROLE,
        enabled: false,
        bindingsVerifiedAt: null,
        lastRoleSuccessAt: payload.restrictedPingRoles[0]!.lastRoleSuccessAt,
        successCount: 1,
      }),
    ]);
    expect(restored.restrictedPingMappings).toEqual(
      payload.restrictedPingMappings,
    );
    expect(restored.restrictedPingUserCooldowns).toEqual(
      payload.restrictedPingUserCooldowns,
    );
    expect(restored.restrictedPingEvents).toEqual(payload.restrictedPingEvents);

    guild.setRestrictedPingRoleEnabled(ROLE, true, ADMIN, TIMESTAMP);
    expect(guild.getRestrictedPingRole(ROLE)?.bindingsVerifiedAt).toBe(
      TIMESTAMP,
    );
    expect(
      guild.reserveRestrictedPing({
        roleId: ROLE,
        userId: SECOND_USER,
        channelId: CHANNEL,
        mappingChannelId: CHANNEL,
        source: "pingrole",
      }).status,
    ).toBe("reserved");

    const counts = storage.previewGuildPurge(GUILD);
    expect(counts).toMatchObject({
      restrictedPingRoles: 1,
      restrictedPingMappings: 1,
      restrictedPingUserCooldowns: 1,
      restrictedPingEvents: 3,
    });
    expect(storage.purgeGuildData(GUILD)).toEqual(counts);
    expect(storage.getGuild(GUILD)).toBeNull();
  });

  it("imports the frozen format-5 generation with bindings dormant", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD);
    seedMapping(storage.forGuild(GUILD));
    const current = storage.exportGuildData(GUILD);
    const legacyV5 = {
      ...current,
      formatVersion: 5,
      settings: createDefaultLegacyGuildSettingsV2(),
    };

    storage.importGuildData(GUILD, legacyV5, storage.getGuildSettings(GUILD)!);

    expect(storage.getGuildSettings(GUILD)).toMatchObject({
      version: 3,
      enabled: true,
    });
    expect(storage.forGuild(GUILD).getRestrictedPingRole(ROLE)).toMatchObject({
      enabled: false,
      bindingsVerifiedAt: null,
    });
  });

  it.each([3, 4] as const)(
    "clears restricted ping data when importing legacy format %s",
    (formatVersion) => {
      const storage = makeStorage();
      storage.ensureGuild(GUILD);
      seedMapping(storage.forGuild(GUILD));
      const current = storage.exportGuildData(GUILD);
      const legacy =
        formatVersion === 4
          ? toLegacyV4(current)
          : {
              formatVersion: 3,
              guildId: current.guildId,
              exportedAt: current.exportedAt,
              metadata: current.metadata,
              settings: createDefaultLegacyGuildSettingsV2(),
              metrics: current.metrics,
              ticketConfiguration: null,
              postedPanels: [],
              tickets: [],
              ticketEvents: [],
            };

      storage.importGuildData(GUILD, legacy, storage.getGuildSettings(GUILD)!);
      const restored = storage.exportGuildData(GUILD);
      expect(restored.restrictedPingRoles).toEqual([]);
      expect(restored.restrictedPingMappings).toEqual([]);
      expect(restored.restrictedPingUserCooldowns).toEqual([]);
      expect(restored.restrictedPingEvents).toEqual([]);
    },
  );

  it("preserves format-2 restricted rows while disabling and clearing leases", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD);
    const guild = storage.forGuild(GUILD);
    seedMapping(guild);
    const live = guild.reserveRestrictedPing({
      roleId: ROLE,
      userId: USER,
      channelId: CHANNEL,
      mappingChannelId: CHANNEL,
      source: "pingrole",
    });
    if (live.status !== "reserved") throw new Error("Expected reservation");
    const current = storage.exportGuildData(GUILD);

    storage.importGuildData(
      GUILD,
      {
        formatVersion: 2,
        guildId: current.guildId,
        exportedAt: current.exportedAt,
        metadata: current.metadata,
        settings: createDefaultLegacyGuildSettingsV2(),
        metrics: current.metrics,
      },
      storage.getGuildSettings(GUILD)!,
    );

    expect(guild.getRestrictedPingRole(ROLE)).toMatchObject({
      enabled: false,
      bindingsVerifiedAt: null,
    });
    expect(guild.listRestrictedPingMappings(ROLE)).toHaveLength(1);
    expect(guild.listRestrictedPingEvents()).toHaveLength(1);
    guild.setRestrictedPingRoleEnabled(ROLE, true, ADMIN, TIMESTAMP);
    expect(guild.getRestrictedPingRole(ROLE)?.bindingsVerifiedAt).toBe(
      TIMESTAMP,
    );
    expect(
      guild.reserveRestrictedPing({
        roleId: ROLE,
        userId: USER,
        channelId: CHANNEL,
        mappingChannelId: CHANNEL,
        source: "pingrole",
      }).status,
    ).toBe("reserved");
  });

  it("rejects cross-guild, duplicate, orphaned, invalid, and oversized rows", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD);
    seedMapping(storage.forGuild(GUILD));
    const payload = storage.exportGuildData(GUILD);

    expectInvalid(storage, payload, /current guild/, (candidate) => {
      candidate.restrictedPingMappings[0]!.guildId = OTHER_ROLE;
    });
    expectInvalid(
      storage,
      payload,
      /duplicate restricted ping mapping/,
      (candidate) => {
        candidate.restrictedPingMappings.push(
          structuredClone(candidate.restrictedPingMappings[0]!),
        );
      },
    );
    expectInvalid(storage, payload, /references unknown role/, (candidate) => {
      candidate.restrictedPingMappings[0]!.roleId = OTHER_ROLE;
    });
    expectInvalid(storage, payload, /cannot be @everyone/, (candidate) => {
      candidate.restrictedPingRoles[0]!.roleId = GUILD;
    });
    expectInvalid(
      storage,
      payload,
      /integer between 1 and 86400/,
      (candidate) => {
        candidate.restrictedPingRoles[0]!.userCooldownSeconds = 0;
      },
    );
    expectInvalid(
      storage,
      payload,
      /null exactly when.*count is zero/,
      (candidate) => {
        candidate.restrictedPingRoles[0]!.successCount = 1;
      },
    );
    expectInvalid(
      storage,
      payload,
      /null exactly when.*count is zero/,
      (candidate) => {
        candidate.restrictedPingRoles[0]!.lastRoleSuccessAt = TIMESTAMP;
      },
    );
    expectInvalid(storage, payload, /ISO timestamp/, (candidate) => {
      candidate.restrictedPingEvents[0]!.createdAt = "not-a-date";
    });
    expectInvalid(
      storage,
      payload,
      /event type is unsupported/,
      (candidate) => {
        (candidate.restrictedPingEvents[0] as { type: string }).type = "unsafe";
      },
    );
    expectInvalid(
      storage,
      payload,
      /mapping_added.*actor and channel/,
      (candidate) => {
        candidate.restrictedPingEvents[0]!.actorId = null;
      },
    );
    expectInvalid(
      storage,
      payload,
      /configuration_updated.*actor/,
      (candidate) => {
        candidate.restrictedPingEvents[0]!.type = "configuration_updated";
        candidate.restrictedPingEvents[0]!.actorId = null;
      },
    );
    expectInvalid(storage, payload, /channel_deleted.*channel/, (candidate) => {
      candidate.restrictedPingEvents[0]!.type = "channel_deleted";
      candidate.restrictedPingEvents[0]!.channelId = null;
    });
    expectInvalid(storage, payload, /matching actor\/user IDs/, (candidate) => {
      candidate.restrictedPingEvents[0]!.type = "ping_succeeded";
      candidate.restrictedPingEvents[0]!.userId = USER;
    });
    expectInvalid(storage, payload, /4000-byte limit/, (candidate) => {
      candidate.restrictedPingEvents[0]!.details = "x".repeat(4_001);
    });
    expectInvalid(
      storage,
      payload,
      /duplicate restricted ping event number/,
      (candidate) => {
        candidate.restrictedPingEvents.push({
          ...structuredClone(candidate.restrictedPingEvents[0]!),
          eventId: "event_dup",
        });
      },
    );
    expectInvalid(storage, payload, /references unknown role/, (candidate) => {
      candidate.restrictedPingUserCooldowns = [
        {
          guildId: GUILD,
          roleId: OTHER_ROLE,
          userId: USER,
          lastSuccessAt: TIMESTAMP,
          successCount: 1,
          updatedAt: TIMESTAMP,
        },
      ];
    });
    expect(storage.forGuild(GUILD).countRestrictedPingRoles()).toBe(1);
  });

  it("rejects excess success history without invalidating the shared database", () => {
    const { storage, dbFile } = makeFileStorage();
    storage.ensureGuild(GUILD);
    seedMapping(storage.forGuild(GUILD));
    const payload = storage.exportGuildData(GUILD);
    payload.restrictedPingEvents = Array.from(
      { length: MAX_RESTRICTED_PING_SUCCESS_EVENTS_PER_GUILD + 1 },
      (_, index) => ({
        guildId: GUILD,
        eventId: `success${String(index).padStart(8, "0")}`,
        eventNumber: index + 1,
        type: "ping_succeeded" as const,
        actorId: USER,
        roleId: ROLE,
        channelId: CHANNEL,
        userId: USER,
        source: "import-regression",
        details: { messageId: MESSAGE },
        createdAt: TIMESTAMP,
      }),
    );

    expect(() =>
      storage.importGuildData(GUILD, payload, storage.getGuildSettings(GUILD)!),
    ).toThrow(/at most 10000 successful pings/i);
    expect(storage.forGuild(GUILD).countRestrictedPingRoles()).toBe(1);

    storage.close();
    const reopened = new BotStorage({ dbFile });
    reopened.initStorage();
    storages.push(reopened);
    expect(reopened.forGuild(GUILD).countRestrictedPingRoles()).toBe(1);
  });
});

function seedMapping(guild: ReturnType<BotStorage["forGuild"]>): void {
  const result = guild.addRestrictedPingMapping({
    roleId: ROLE,
    channelId: CHANNEL,
    createdBy: ADMIN,
    enabled: true,
    userCooldownSeconds: 60,
    roleCooldownSeconds: 0,
    allowThreads: true,
    bindingsVerifiedAt: TIMESTAMP,
  });
  if (result.status !== "created") throw new Error("Expected mapping");
}

function toLegacyV4(payload: GuildDataExport): Record<string, unknown> {
  const {
    restrictedPingRoles: _roles,
    restrictedPingMappings: _mappings,
    restrictedPingUserCooldowns: _cooldowns,
    restrictedPingEvents: _events,
    formatVersion: _formatVersion,
    ...legacy
  } = payload;
  return {
    ...legacy,
    formatVersion: 4,
    settings: createDefaultLegacyGuildSettingsV2(),
  };
}

function expectInvalid(
  storage: BotStorage,
  payload: GuildDataExport,
  message: RegExp,
  mutate: (candidate: GuildDataExport) => void,
): void {
  const candidate = structuredClone(payload);
  mutate(candidate);
  expect(() =>
    storage.importGuildData(GUILD, candidate, storage.getGuildSettings(GUILD)!),
  ).toThrow(message);
}

function makeStorage(): BotStorage {
  const storage = new BotStorage({ dbFile: ":memory:" });
  storage.initStorage();
  storages.push(storage);
  return storage;
}

function makeFileStorage(): { storage: BotStorage; dbFile: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guild-data-v5-"));
  roots.push(root);
  const dbFile = path.join(root, "storage.db");
  const storage = new BotStorage({ dbFile });
  storage.initStorage();
  storages.push(storage);
  return { storage, dbFile };
}
