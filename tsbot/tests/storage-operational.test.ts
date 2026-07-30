import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BotStorage, createOpaqueStorageId } from "../src/storage/db.js";

const GUILD_A = "111111111111111111";
const GUILD_B = "222222222222222222";
const CATEGORY = "333333333333333333";
const LOG_CHANNEL = "444444444444444444";
const SUPPORT_ROLE = "555555555555555555";
const PANEL_CHANNEL = "666666666666666666";
const PANEL_MESSAGE = "777777777777777777";
const OPENER = "888888888888888888";
const STAFF_A = "999999999999999999";
const STAFF_B = "101010101010101010";
const TICKET_CHANNEL_A = "121212121212121212";
const TICKET_CHANNEL_B = "131313131313131313";
const CONTROL_MESSAGE = "141414141414141414";
const CLOSE_LOG_MESSAGE = "171717171717171717";
const storages: BotStorage[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const storage of storages.splice(0)) {
    storage.close();
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("tenant-scoped panel and ticket persistence", () => {
  it("stores ticket configuration and stable posted-panel identities per guild", () => {
    const storage = makeMemoryStorage();
    storage.ensureGuild(GUILD_A);
    storage.ensureGuild(GUILD_B);
    const a = storage.forGuild(GUILD_A);
    const b = storage.forGuild(GUILD_B);

    expect(a.getTicketConfiguration()).toBeNull();
    expect(
      a.upsertTicketConfiguration({
        categoryId: CATEGORY,
        logChannelId: LOG_CHANNEL,
        supportRoleId: SUPPORT_ROLE,
      }),
    ).toMatchObject({
      guildId: GUILD_A,
      enabled: true,
      categoryId: CATEGORY,
      logChannelId: LOG_CHANNEL,
      supportRoleId: SUPPORT_ROLE,
    });
    expect(b.getTicketConfiguration()).toBeNull();
    expect(a.disableTicketConfiguration()).toMatchObject({ enabled: false });
    expect(a.disableTicketConfiguration()).toMatchObject({ enabled: false });

    const panelId = createOpaqueStorageId();
    expect(panelId).toMatch(/^[A-Za-z0-9_-]{8,24}$/);
    const panel = a.createPostedPanel({
      panelId,
      preset: "resources",
      channelId: PANEL_CHANNEL,
      messageId: PANEL_MESSAGE,
      configuration: {
        title: "Server resources",
        links: [{ label: "Handbook", url: "https://example.com/handbook" }],
      },
    });
    expect(panel).toMatchObject({
      guildId: GUILD_A,
      panelId,
      preset: "resources",
      channelId: PANEL_CHANNEL,
      messageId: PANEL_MESSAGE,
    });
    expect(a.findPostedPanelByToken(panelId)).toEqual(panel);
    expect(b.findPostedPanelByToken(panelId)).toBeNull();

    const replacementId = createOpaqueStorageId();
    const replacement = a.upsertPostedPanel({
      panelId: replacementId,
      preset: "resources",
      channelId: PANEL_CHANNEL,
      messageId: "151515151515151515",
      configuration: { title: "Updated" },
    });
    expect(replacement).toMatchObject({
      panelId: replacementId,
      messageId: "151515151515151515",
      configuration: { title: "Updated" },
    });
    expect(a.findPostedPanelByToken(panelId)).toBeNull();
    expect(
      a.findPostedPanelByPresetAndChannel("resources", PANEL_CHANNEL),
    ).toEqual(replacement);
    expect(a.deletePostedPanel(replacementId)).toBe(true);
    expect(a.deletePostedPanel(replacementId)).toBe(false);
  });

  it("makes reservation and claim conflicts durable across storage connections", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "superior-ticket-race-"),
    );
    roots.push(root);
    const dbFile = path.join(root, "race.db");
    const first = makeFileStorage(dbFile);
    first.ensureGuild(GUILD_A);
    const second = makeFileStorage(dbFile);
    const a = first.forGuild(GUILD_A);
    const b = second.forGuild(GUILD_A);

    const created = a.reserveTicketCreation({
      openerId: OPENER,
      subject: "  Login issue  ",
      description: "  I cannot access the protected channel.  ",
    });
    expect(created.status).toBe("created");
    expect(created.ticket).toMatchObject({
      ticketNumber: 1,
      openerId: OPENER,
      subject: "Login issue",
      description: "I cannot access the protected channel.",
      state: "creating",
    });
    expect(created.ticket.ticketId).toMatch(/^[A-Za-z0-9_-]{8,24}$/);

    const duplicate = b.reserveTicketCreation({
      openerId: OPENER,
      subject: "Repeated submission",
      description: "This must resolve to the durable reservation.",
    });
    expect(duplicate).toMatchObject({
      status: "existing",
      ticket: { ticketId: created.ticket.ticketId, ticketNumber: 1 },
    });

    expect(
      a.activateTicketCreation(created.ticket.ticketId, {
        channelId: TICKET_CHANNEL_A,
        controlMessageId: CONTROL_MESSAGE,
      }),
    ).toMatchObject({ status: "activated", ticket: { state: "open" } });
    expect(b.claimTicket(created.ticket.ticketId, STAFF_A)).toMatchObject({
      status: "claimed",
      ticket: { claimedBy: STAFF_A },
    });
    expect(a.claimTicket(created.ticket.ticketId, STAFF_A).status).toBe(
      "already-claimed",
    );
    expect(a.claimTicket(created.ticket.ticketId, STAFF_B)).toMatchObject({
      status: "conflict",
      ticket: { claimedBy: STAFF_A },
    });
  });

  it("exports one consistent SQLite snapshot while another connection writes", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "superior-ticket-export-"),
    );
    roots.push(root);
    const dbFile = path.join(root, "export.db");
    const first = makeFileStorage(dbFile);
    first.ensureGuild(GUILD_A);
    const a = first.forGuild(GUILD_A);
    a.upsertTicketConfiguration({
      categoryId: CATEGORY,
      logChannelId: LOG_CHANNEL,
      supportRoleId: SUPPORT_ROLE,
    });
    const reservation = a.reserveTicketCreation({
      openerId: OPENER,
      subject: "Snapshot",
      description: "Export must not mix this ticket with later writes.",
    });
    const second = makeFileStorage(dbFile);
    const b = second.forGuild(GUILD_A);

    const exported = first.exportGuildData(GUILD_A, () => {
      b.disableTicketConfiguration();
      b.failTicketCreation(reservation.ticket.ticketId, "concurrent failure");
    });

    expect(exported.ticketConfiguration).toMatchObject({ enabled: true });
    expect(exported.tickets).toMatchObject([
      { ticketId: reservation.ticket.ticketId, state: "creating" },
    ]);
    expect(exported.ticketEvents.map((event) => event.type)).toEqual([
      "creation_reserved",
    ]);
    expect(a.getTicketConfiguration()).toMatchObject({ enabled: false });
    expect(a.getTicketById(reservation.ticket.ticketId)).toMatchObject({
      state: "failed",
    });
  });

  it("persists restart-safe creation rollback, close rollback, and recovery events", () => {
    const storage = makeMemoryStorage();
    storage.ensureGuild(GUILD_A);
    const guild = storage.forGuild(GUILD_A);

    const first = guild.reserveTicketCreation({
      openerId: OPENER,
      subject: "First attempt",
      description: "The welcome message will fail.",
    });
    expect(
      guild.activateTicketCreation(first.ticket.ticketId, {
        channelId: TICKET_CHANNEL_A,
      }).status,
    ).toBe("activated");
    expect(
      guild.failTicketCreation(first.ticket.ticketId, "Welcome send failed"),
    ).toMatchObject({
      status: "failed",
      ticket: { state: "failed", channelId: null },
    });
    expect(
      guild.failTicketCreation(first.ticket.ticketId, "repeat").status,
    ).toBe("already-failed");

    const second = guild.reserveTicketCreation({
      openerId: OPENER,
      subject: "Second attempt",
      description: "This ticket reaches the staff workflow.",
    });
    expect(second).toMatchObject({
      status: "created",
      ticket: { ticketNumber: 2 },
    });
    guild.activateTicketCreation(second.ticket.ticketId, {
      channelId: TICKET_CHANNEL_B,
      controlMessageId: CONTROL_MESSAGE,
    });
    expect(
      guild.failTicketCreation(second.ticket.ticketId, "unsafe rollback"),
    ).toMatchObject({
      status: "unavailable",
      ticket: { state: "open" },
    });

    expect(guild.claimTicket(second.ticket.ticketId, STAFF_A).status).toBe(
      "claimed",
    );
    expect(guild.releaseTicket(second.ticket.ticketId, STAFF_B)).toMatchObject({
      status: "released",
      ticket: { claimedBy: null },
    });
    expect(guild.releaseTicket(second.ticket.ticketId, STAFF_B).status).toBe(
      "already-released",
    );
    expect(
      guild.beginTicketClose(second.ticket.ticketId, STAFF_A, "Resolved"),
    ).toMatchObject({
      status: "started",
      ticket: { state: "closing", closedBy: STAFF_A, closeReason: "Resolved" },
    });
    expect(
      guild.beginTicketClose(second.ticket.ticketId, STAFF_B, "Duplicate")
        .status,
    ).toBe("already-closing");
    expect(
      guild.reopenAfterCloseFailure(
        second.ticket.ticketId,
        "Transcript delivery failed",
      ),
    ).toMatchObject({
      status: "reopened",
      ticket: {
        state: "open",
        closedBy: null,
        closeReason: null,
        closingAt: null,
      },
    });
    expect(
      guild.rebindTicket(
        second.ticket.ticketId,
        {
          channelId: TICKET_CHANNEL_A,
          controlMessageId: "161616161616161616",
          expectedChannelId: TICKET_CHANNEL_B,
          expectedControlMessageId: CONTROL_MESSAGE,
        },
        STAFF_A,
      ),
    ).toMatchObject({
      status: "rebound",
      ticket: {
        channelId: TICKET_CHANNEL_A,
        controlMessageId: "161616161616161616",
      },
    });
    expect(
      guild.rebindTicket(second.ticket.ticketId, {
        channelId: TICKET_CHANNEL_B,
        controlMessageId: CONTROL_MESSAGE,
        expectedChannelId: TICKET_CHANNEL_B,
        expectedControlMessageId: CONTROL_MESSAGE,
      }),
    ).toMatchObject({
      status: "conflict",
      ticket: {
        channelId: TICKET_CHANNEL_A,
        controlMessageId: "161616161616161616",
      },
    });
    guild.beginTicketClose(
      second.ticket.ticketId,
      STAFF_A,
      "Resolved after retry",
    );
    expect(guild.finishTicketClose(second.ticket.ticketId).status).toBe(
      "unavailable",
    );
    expect(
      guild.markTicketLogDelivered(
        second.ticket.ticketId,
        CLOSE_LOG_MESSAGE,
        "2000-01-01T00:00:00.000Z",
      ),
    ).toMatchObject({
      status: "conflict",
      ticket: { closeLogMessageId: null },
    });
    expect(
      guild.markTicketLogDelivered(second.ticket.ticketId, CLOSE_LOG_MESSAGE),
    ).toMatchObject({
      status: "logged",
      ticket: { closeLogMessageId: CLOSE_LOG_MESSAGE },
    });
    expect(
      guild.markTicketLogDelivered(
        second.ticket.ticketId,
        "181818181818181818",
      ),
    ).toMatchObject({
      status: "already-logged",
      ticket: { closeLogMessageId: CLOSE_LOG_MESSAGE },
    });
    expect(
      guild.reopenAfterCloseFailure(
        second.ticket.ticketId,
        "must not duplicate a delivered log",
      ).status,
    ).toBe("unavailable");
    expect(guild.finishTicketClose(second.ticket.ticketId)).toMatchObject({
      status: "closed",
      ticket: {
        state: "closed",
        closeReason: "Resolved after retry",
        closeLogMessageId: CLOSE_LOG_MESSAGE,
      },
    });
    expect(guild.finishTicketClose(second.ticket.ticketId).status).toBe(
      "already-closed",
    );
    expect(guild.getTicketByChannel(TICKET_CHANNEL_A)?.ticketId).toBe(
      second.ticket.ticketId,
    );
    expect(guild.getTicketByNumber(2)?.ticketId).toBe(second.ticket.ticketId);
    expect(guild.getTicketByOpener(OPENER)).toBeNull();

    expect(
      guild.listTicketEvents(second.ticket.ticketId).map((event) => event.type),
    ).toEqual([
      "creation_reserved",
      "creation_activated",
      "claimed",
      "released",
      "close_started",
      "close_failed",
      "rebound",
      "close_started",
      "close_logged",
      "closed",
    ]);
  });

  it("rejects unsafe or unbounded JSON without mutating panel records", () => {
    const storage = makeMemoryStorage();
    storage.ensureGuild(GUILD_A);
    const guild = storage.forGuild(GUILD_A);
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(() =>
      guild.createPostedPanel({
        preset: "help",
        channelId: PANEL_CHANNEL,
        messageId: PANEL_MESSAGE,
        configuration: circular,
      }),
    ).toThrow(/JSON-safe/);
    expect(() =>
      guild.createPostedPanel({
        preset: "help",
        channelId: PANEL_CHANNEL,
        messageId: PANEL_MESSAGE,
        configuration: { body: "x".repeat(16_001) },
      }),
    ).toThrow(/16000-byte limit/);
    expect(guild.listPostedPanels()).toEqual([]);
  });

  it("rejects an unbounded portable metric collection before import", () => {
    const storage = makeMemoryStorage();
    storage.ensureGuild(GUILD_A);
    const payload = storage.exportGuildData(GUILD_A);
    const oversized = {
      ...payload,
      metrics: Array.from({ length: 50_001 }, (_, index) => ({
        key: `command_usage.utility.synthetic_${index}`,
        value: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
      })),
    };

    expect(() =>
      storage.importGuildData(
        GUILD_A,
        oversized,
        storage.getGuildSettings(GUILD_A)!,
      ),
    ).toThrow(/metrics exceeds 50000 records/);
    expect(storage.exportGuildData(GUILD_A).metrics).toEqual([]);
  });

  it("refuses an oversized export before materializing its collections", () => {
    const storage = makeMemoryStorage();
    storage.ensureGuild(GUILD_A);

    expect(() => storage.exportGuildData(GUILD_A, undefined, 1)).toThrow(
      /materialization safety limit/,
    );
  });
});

function makeMemoryStorage(): BotStorage {
  const storage = new BotStorage({ dbFile: ":memory:" });
  storage.initStorage();
  storages.push(storage);
  return storage;
}

function makeFileStorage(dbFile: string): BotStorage {
  const storage = new BotStorage({ dbFile });
  storage.initStorage();
  storages.push(storage);
  return storage;
}
