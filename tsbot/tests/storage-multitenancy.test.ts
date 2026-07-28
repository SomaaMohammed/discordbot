import { afterEach, describe, expect, it } from "vitest";
import { BotStorage, GuildSettingsConflictError } from "../src/storage/db.js";
import type { UserMetrics } from "../src/types.js";

const GUILD_A = "111111111111111111";
const GUILD_B = "222222222222222222";
const USER_A = "333333333333333333";
const USER_B = "444444444444444444";
const storages: BotStorage[] = [];

afterEach(() => {
  for (const storage of storages.splice(0)) {
    storage.close();
  }
});

describe("active guild storage", () => {
  it("isolates lifecycle and settings by exact guild ID", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD_A, "A");
    storage.ensureGuild(GUILD_B, "B");

    const a = storage.getGuildSettings(GUILD_A)!;
    a.features.chat = true;
    a.invocation.aliases = ["helper bot"];
    storage.saveGuildSettings(GUILD_A, a);

    expect(storage.getGuildSettings(GUILD_A)?.features.chat).toBe(true);
    expect(storage.getGuildSettings(GUILD_B)?.features.chat).toBe(false);
    expect(storage.getGuildSettings(GUILD_B)?.invocation.aliases).toEqual([]);

    const expectation = storage.getGuildEnableExpectation(GUILD_A)!;
    expect(storage.setGuildEnabled(GUILD_A, true, expectation).enabled).toBe(
      true,
    );
    expect(storage.listEnabledGuilds().map((row) => row.guildId)).toEqual([
      GUILD_A,
    ]);

    storage.markGuildLeft(GUILD_A);
    expect(storage.getGuild(GUILD_A)).toMatchObject({
      enabled: false,
    });
    expect(storage.getGuild(GUILD_A)?.leftAt).not.toBeNull();
    const rejoined = storage.reactivateGuild(GUILD_A, "A again");
    expect(rejoined).toMatchObject({ enabled: false, leftAt: null });
    expect(storage.getGuildSettings(GUILD_A)?.features.chat).toBe(true);
  });

  it("uses compare-and-swap settings writes and clears review only on enable", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD_A);
    const original = storage.getGuildSettings(GUILD_A)!;
    const changed = structuredClone(original);
    changed.timezone = "Asia/Amman";
    storage.saveGuildSettings(GUILD_A, changed, original);

    expect(() =>
      storage.saveGuildSettings(GUILD_A, original, original),
    ).toThrow(GuildSettingsConflictError);

    const exported = storage.exportGuildData(GUILD_A);
    const imported = storage.importGuildData(
      GUILD_A,
      exported,
      storage.getGuildSettings(GUILD_A)!,
    );
    expect(imported).toMatchObject({ enabled: false, reviewRequired: true });

    const reviewExpectation = storage.getGuildEnableExpectation(GUILD_A)!;
    const enabled = storage.setGuildEnabled(GUILD_A, true, reviewExpectation);
    expect(enabled).toMatchObject({ enabled: true, reviewRequired: false });

    const edited = structuredClone(enabled);
    edited.features.greetings = true;
    expect(storage.saveGuildSettings(GUILD_A, edited, enabled)).toMatchObject({
      enabled: false,
      reviewRequired: true,
    });
    expect(storage.getGuild(GUILD_A)?.enabled).toBe(false);
  });

  it("stores command and user metrics per tenant", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD_A);
    storage.ensureGuild(GUILD_B);
    const a = storage.forGuild(GUILD_A);
    const b = storage.forGuild(GUILD_B);

    a.recordCommandMetric("superior.purge", false);
    a.incrementUserMetric(USER_A, "messages_sent", 4);
    a.incrementUserMetric(USER_B, "messages_sent", 2);
    b.incrementUserMetric(USER_A, "messages_sent", 9);

    expect(a.getUserMetrics(USER_A).messages_sent).toBe(4);
    expect(b.getUserMetrics(USER_A).messages_sent).toBe(9);
    expect(a.getUserLeaderboard("messages_sent", 10)).toEqual([
      { userId: USER_A, value: 4 },
      { userId: USER_B, value: 2 },
    ]);
    expect(a.metricsGet("command_usage.superior.purge", "0")).toBe("1");
    expect(a.metricsGet("command_failures.superior.purge", "0")).toBe("1");
    expect(b.metricsGet("command_usage.superior.purge", "0")).toBe("0");
  });

  it("transactionally replaces activity metrics without duplicating backfills", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD_A);
    const guild = storage.forGuild(GUILD_A);
    guild.recordCommandMetric("utility.ping");
    guild.setUserMetric(USER_A, "battles_won", 99);

    const replacements = [
      { userId: USER_A, metrics: userMetrics({ messages_sent: 7 }) },
      { userId: USER_B, metrics: userMetrics({ reactions_sent: 3 }) },
    ];
    guild.replaceUserActivityMetrics(replacements);
    guild.replaceUserActivityMetrics(replacements);

    expect(guild.getUserMetrics(USER_A)).toEqual(
      userMetrics({ messages_sent: 7, battles_won: 99 }),
    );
    expect(guild.getUserMetrics(USER_B)).toEqual(
      userMetrics({ reactions_sent: 3 }),
    );
    expect(guild.metricsGet("command_usage.utility.ping", "0")).toBe("1");
  });

  it("exports/imports only active same-guild data and purges atomically", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD_A);
    storage.ensureGuild(GUILD_B);
    storage
      .forGuild(GUILD_A)
      .incrementUserMetric(USER_A, "reactions_received", 5);
    const payload = storage.exportGuildData(GUILD_A);

    expect(payload).toMatchObject({
      formatVersion: 2,
      guildId: GUILD_A,
      metrics: [
        {
          key: `user_stats.${USER_A}.reactions_received`,
          value: 5,
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain('userId":null');
    const invalidGreetingPayload = structuredClone(payload);
    invalidGreetingPayload.settings.greetings = [
      { name: "Too long", message: "{user}".repeat(87) },
    ];
    const settingsBeforeInvalidImport = storage.getGuildSettings(GUILD_A)!;
    expect(() =>
      storage.importGuildData(
        GUILD_A,
        invalidGreetingPayload,
        settingsBeforeInvalidImport,
      ),
    ).toThrow(/render to at most 2000 Discord characters/);
    expect(storage.getGuildSettings(GUILD_A)).toEqual(
      settingsBeforeInvalidImport,
    );
    expect(() =>
      storage.importGuildData(
        GUILD_B,
        payload,
        storage.getGuildSettings(GUILD_B)!,
      ),
    ).toThrow(/current guild/);

    expect(storage.previewGuildPurge(GUILD_A)).toEqual({
      guildId: GUILD_A,
      guilds: 1,
      settings: 1,
      metrics: 1,
    });
    expect(storage.purgeGuildData(GUILD_A)).toEqual({
      guildId: GUILD_A,
      guilds: 1,
      settings: 1,
      metrics: 1,
    });
    expect(storage.getGuild(GUILD_A)).toBeNull();
    expect(storage.getGuild(GUILD_B)).not.toBeNull();
  });
});

function makeStorage(): BotStorage {
  const storage = new BotStorage({ dbFile: ":memory:" });
  storage.initStorage();
  storages.push(storage);
  return storage;
}

function userMetrics(overrides: Partial<UserMetrics> = {}): UserMetrics {
  return {
    messages_sent: 0,
    reactions_sent: 0,
    reactions_received: 0,
    battles_played: 0,
    battles_won: 0,
    ...overrides,
  };
}
