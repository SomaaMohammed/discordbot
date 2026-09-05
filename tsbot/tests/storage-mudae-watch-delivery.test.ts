import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "../src/storage/database.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BotStorage } from "../src/storage/db.js";
import { MUDAE_WATCH_DELIVERY_RETENTION_DAYS } from "../src/storage/mudae-watch-delivery-repository.js";
import { MAX_MUDAE_WATCH_DELIVERIES_PER_GUILD } from "../src/storage/schema.js";

const GUILD_A = "111111111111111111";
const GUILD_B = "222222222222222222";
const MESSAGE_A = "333333333333333333";
const storages: BotStorage[] = [];
const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const storage of storages.splice(0)) {
    storage.close();
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("private delivery deduplication storage", () => {
  it("reserves once and keeps active reservations as duplicates", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD_A);
    const guild = storage.forGuild(GUILD_A);

    const first = guild.reserveMudaeWatchDelivery(MESSAGE_A);
    expect(first).toMatchObject({
      status: "reserved",
      delivery: {
        guildId: GUILD_A,
        messageId: MESSAGE_A,
        state: "reserved",
        completedAt: null,
      },
    });
    if (first.status !== "reserved") throw new Error("Expected reservation");
    expect(first.delivery.reservationId).toBe(first.reservationId);

    expect(guild.reserveMudaeWatchDelivery(MESSAGE_A)).toMatchObject({
      status: "duplicate",
      delivery: {
        messageId: MESSAGE_A,
        state: "reserved",
        reservationId: first.reservationId,
      },
    });
    expect(guild.countMudaeWatchDeliveries()).toBe(1);
  });

  it("completes by opaque token and terminal outcomes remain duplicates", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD_A);
    const guild = storage.forGuild(GUILD_A);
    const reserved = guild.reserveMudaeWatchDelivery(MESSAGE_A);
    if (reserved.status !== "reserved") throw new Error("Expected reservation");

    expect(
      guild.completeMudaeWatchDelivery("wrongtoken", "delivered"),
    ).toBeNull();
    expect(
      guild.completeMudaeWatchDelivery(reserved.reservationId, "delivered"),
    ).toMatchObject({
      messageId: MESSAGE_A,
      state: "delivered",
      reservationId: null,
      completedAt: expect.stringMatching(/Z$/),
    });
    expect(
      guild.completeMudaeWatchDelivery(reserved.reservationId, "failed"),
    ).toBeNull();
    expect(guild.reserveMudaeWatchDelivery(MESSAGE_A)).toMatchObject({
      status: "duplicate",
      delivery: { state: "delivered" },
    });

    const failed = guild.reserveMudaeWatchDelivery("444444444444444444");
    if (failed.status !== "reserved") throw new Error("Expected reservation");
    expect(
      guild.completeMudaeWatchDelivery(failed.reservationId, "failed"),
    ).toMatchObject({ state: "failed" });
  });

  it("releases only an active token before external delivery begins", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD_A);
    const guild = storage.forGuild(GUILD_A);
    const reserved = guild.reserveMudaeWatchDelivery(MESSAGE_A);
    if (reserved.status !== "reserved") throw new Error("Expected reservation");

    expect(guild.releaseMudaeWatchDelivery("wrongtoken")).toBe(false);
    expect(guild.releaseMudaeWatchDelivery(reserved.reservationId)).toBe(true);
    expect(guild.releaseMudaeWatchDelivery(reserved.reservationId)).toBe(false);
    expect(guild.getMudaeWatchDelivery(MESSAGE_A)).toBeNull();
    expect(guild.reserveMudaeWatchDelivery(MESSAGE_A).status).toBe("reserved");
  });

  it("isolates identical message IDs between guilds", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD_A);
    storage.ensureGuild(GUILD_B);

    expect(
      storage.forGuild(GUILD_A).reserveMudaeWatchDelivery(MESSAGE_A).status,
    ).toBe("reserved");
    expect(
      storage.forGuild(GUILD_B).reserveMudaeWatchDelivery(MESSAGE_A).status,
    ).toBe("reserved");
    expect(storage.forGuild(GUILD_A).countMudaeWatchDeliveries()).toBe(1);
    expect(storage.forGuild(GUILD_B).countMudaeWatchDeliveries()).toBe(1);
  });

  it("persists reservations and terminal results across restarts", () => {
    const root = makeRoot();
    const dbFile = path.join(root, "restart.db");
    const firstStorage = new BotStorage({ dbFile });
    firstStorage.initStorage();
    firstStorage.ensureGuild(GUILD_A);
    const first = firstStorage
      .forGuild(GUILD_A)
      .reserveMudaeWatchDelivery(MESSAGE_A);
    expect(first.status).toBe("reserved");
    firstStorage.close();

    const secondStorage = new BotStorage({ dbFile });
    storages.push(secondStorage);
    secondStorage.initStorage();
    const guild = secondStorage.forGuild(GUILD_A);
    expect(guild.reserveMudaeWatchDelivery(MESSAGE_A)).toMatchObject({
      status: "duplicate",
      delivery: { state: "reserved" },
    });
    if (first.status !== "reserved") throw new Error("Expected reservation");
    guild.completeMudaeWatchDelivery(first.reservationId, "delivered");
    expect(guild.reserveMudaeWatchDelivery(MESSAGE_A)).toMatchObject({
      status: "duplicate",
      delivery: { state: "delivered" },
    });
  });

  it("prunes every state after 30 days even without a new guild event", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const storage = makeStorage();
    storage.ensureGuild(GUILD_A);
    storage.ensureGuild(GUILD_B);
    const a = storage.forGuild(GUILD_A);
    const b = storage.forGuild(GUILD_B);
    const delivered = a.reserveMudaeWatchDelivery(MESSAGE_A);
    const reserved = b.reserveMudaeWatchDelivery("444444444444444444");
    if (delivered.status !== "reserved" || reserved.status !== "reserved") {
      throw new Error("Expected reservations");
    }
    a.completeMudaeWatchDelivery(delivered.reservationId, "delivered");

    vi.setSystemTime(
      new Date(
        Date.UTC(2026, 0, 1) +
          (MUDAE_WATCH_DELIVERY_RETENTION_DAYS + 1) * 86_400_000,
      ),
    );
    expect(storage.pruneMudaeWatchDeliveries()).toBe(2);
    expect(a.countMudaeWatchDeliveries()).toBe(0);
    expect(b.countMudaeWatchDeliveries()).toBe(0);
  });

  it("keeps at most the latest 10,000 rows per guild", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const root = makeRoot();
    const dbFile = path.join(root, "bounded.db");
    const initial = new BotStorage({ dbFile });
    initial.initStorage();
    initial.ensureGuild(GUILD_A);
    initial.close();

    const db = new Database(dbFile);
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare(
        `WITH RECURSIVE sequence(value) AS (
           SELECT 1
           UNION ALL
           SELECT value + 1 FROM sequence WHERE value < ?
         )
         INSERT INTO mudae_watch_deliveries (
           guild_id, message_id, delivery_state, reservation_id,
           completed_at, created_at, updated_at
         )
         SELECT ?, printf('%018d', 100000000000000000 + value),
                'delivered', NULL, ?, ?, ?
         FROM sequence`,
      ).run(
        MAX_MUDAE_WATCH_DELIVERIES_PER_GUILD,
        GUILD_A,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
      db.exec("COMMIT");
    } finally {
      db.close();
    }

    const storage = new BotStorage({ dbFile });
    storages.push(storage);
    storage.initStorage();
    const guild = storage.forGuild(GUILD_A);
    expect(guild.countMudaeWatchDeliveries()).toBe(
      MAX_MUDAE_WATCH_DELIVERIES_PER_GUILD,
    );
    expect(guild.reserveMudaeWatchDelivery("999999999999999999").status).toBe(
      "reserved",
    );
    expect(guild.countMudaeWatchDeliveries()).toBe(
      MAX_MUDAE_WATCH_DELIVERIES_PER_GUILD,
    );
    expect(guild.getMudaeWatchDelivery("999999999999999999")).toMatchObject({
      state: "reserved",
    });
  });

  it("excludes private delivery state from export/import and purges by guild", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD_A);
    storage.ensureGuild(GUILD_B);
    storage.forGuild(GUILD_A).reserveMudaeWatchDelivery(MESSAGE_A);
    storage.forGuild(GUILD_B).reserveMudaeWatchDelivery("444444444444444444");

    const exported = storage.exportGuildData(GUILD_A);
    expect(exported).not.toHaveProperty("mudaeWatchDeliveries");
    storage.importGuildData(
      GUILD_A,
      exported,
      storage.getGuildSettings(GUILD_A)!,
    );
    expect(storage.forGuild(GUILD_A).countMudaeWatchDeliveries()).toBe(1);

    expect(storage.previewGuildPurge(GUILD_A)).toMatchObject({
      guildId: GUILD_A,
      mudaeWatchDeliveries: 1,
    });
    expect(storage.purgeGuildData(GUILD_A)).toMatchObject({
      mudaeWatchDeliveries: 1,
    });
    expect(storage.getGuild(GUILD_A)).toBeNull();
    expect(storage.forGuild(GUILD_B).countMudaeWatchDeliveries()).toBe(1);
  });
});

function makeStorage(): BotStorage {
  const storage = new BotStorage({ dbFile: ":memory:" });
  storages.push(storage);
  storage.initStorage();
  return storage;
}

function makeRoot(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "superior-mudae-storage-"),
  );
  roots.push(root);
  return root;
}
