import type Database from "better-sqlite3";
import { assertDiscordSnowflake } from "../guild-settings.js";
import { createOpaqueStorageId } from "./operational-repository.js";
import { MAX_MUDAE_WATCH_DELIVERIES_PER_GUILD } from "./schema.js";

export const MUDAE_WATCH_DELIVERY_RETENTION_DAYS = 30;

const RETENTION_MILLISECONDS =
  MUDAE_WATCH_DELIVERY_RETENTION_DAYS * 24 * 60 * 60 * 1_000;

export type MudaeWatchDeliveryState = "reserved" | "delivered" | "failed";
export type MudaeWatchDeliveryOutcome = Exclude<
  MudaeWatchDeliveryState,
  "reserved"
>;

export interface MudaeWatchDeliveryRecord {
  guildId: string;
  messageId: string;
  state: MudaeWatchDeliveryState;
  reservationId: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type MudaeWatchDeliveryReservationResult =
  | {
      status: "reserved";
      reservationId: string;
      delivery: MudaeWatchDeliveryRecord;
    }
  | {
      status: "duplicate";
      delivery: MudaeWatchDeliveryRecord;
    };

interface DeliveryRow {
  guild_id: string;
  message_id: string;
  delivery_state: string;
  reservation_id: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Applies age and per-guild caps even when no new matching message arrives. */
export function pruneAllMudaeWatchDeliveries(db: Database.Database): number {
  let deleted = 0;
  const prune = db.transaction(() => {
    const cutoff = retentionCutoff(utcNow());
    deleted += db
      .prepare("DELETE FROM mudae_watch_deliveries WHERE updated_at < ?")
      .run(cutoff).changes;
    deleted += db
      .prepare(
        `DELETE FROM mudae_watch_deliveries
         WHERE rowid IN (
           SELECT rowid FROM (
             SELECT rowid,
                    ROW_NUMBER() OVER (
                      PARTITION BY guild_id
                      ORDER BY updated_at DESC, rowid DESC
                    ) AS record_rank
             FROM mudae_watch_deliveries
           )
           WHERE record_rank > ?
         )`,
      )
      .run(MAX_MUDAE_WATCH_DELIVERIES_PER_GUILD).changes;
  });
  prune.immediate();
  return deleted;
}

/** Guild-bound, bounded at-most-once reservations for private roll delivery. */
export class MudaeWatchDeliveryRepository {
  public constructor(
    private readonly db: Database.Database,
    public readonly guildId: string,
  ) {}

  public getDelivery(messageId: string): MudaeWatchDeliveryRecord | null {
    const normalizedMessageId = assertDiscordSnowflake(messageId, "message ID");
    const row = this.getDeliveryRow(normalizedMessageId);
    return row ? parseDelivery(row) : null;
  }

  public countDeliveries(): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM mudae_watch_deliveries WHERE guild_id = ?",
      )
      .get(this.guildId) as { count: number };
    return Number(row.count);
  }

  /**
   * Claims a message before any Discord delivery request is issued.
   * Reservations never expire early: a persisted reservation remains a
   * duplicate until bounded retention removes it, prioritizing at-most-once
   * delivery across process crashes.
   */
  public reserveDelivery(
    messageId: string,
  ): MudaeWatchDeliveryReservationResult {
    const normalizedMessageId = assertDiscordSnowflake(messageId, "message ID");
    let result: MudaeWatchDeliveryReservationResult | null = null;
    const reserve = this.db.transaction(() => {
      const now = utcNow();
      this.pruneWithin(now);
      const existing = this.getDeliveryRow(normalizedMessageId);
      if (existing) {
        result = { status: "duplicate", delivery: parseDelivery(existing) };
        return;
      }

      this.trimToLimit(MAX_MUDAE_WATCH_DELIVERIES_PER_GUILD - 1);
      const reservationId = createOpaqueStorageId();
      const inserted = this.db
        .prepare(
          `INSERT INTO mudae_watch_deliveries (
             guild_id, message_id, delivery_state, reservation_id,
             completed_at, created_at, updated_at
           ) VALUES (?, ?, 'reserved', ?, NULL, ?, ?)
           ON CONFLICT(guild_id, message_id) DO NOTHING`,
        )
        .run(this.guildId, normalizedMessageId, reservationId, now, now);
      if (inserted.changes !== 1) {
        const raced = this.getDeliveryRow(normalizedMessageId);
        if (!raced) {
          throw new Error("Mudae watch delivery reservation was not persisted");
        }
        result = { status: "duplicate", delivery: parseDelivery(raced) };
        return;
      }

      const delivery = this.getDeliveryRow(normalizedMessageId);
      if (!delivery || delivery.reservation_id !== reservationId) {
        throw new Error(
          "Mudae watch delivery reservation was trimmed unexpectedly",
        );
      }
      result = {
        status: "reserved",
        reservationId,
        delivery: parseDelivery(delivery),
      };
    });
    reserve.immediate();
    if (!result) {
      throw new Error("Mudae watch delivery reservation returned no result");
    }
    return result;
  }

  public completeDelivery(
    reservationId: string,
    outcome: MudaeWatchDeliveryOutcome,
  ): MudaeWatchDeliveryRecord | null {
    const normalizedReservationId = normalizeReservationId(reservationId);
    const normalizedOutcome = normalizeOutcome(outcome);
    let result: MudaeWatchDeliveryRecord | null = null;
    const complete = this.db.transaction(() => {
      const now = utcNow();
      const reserved = this.db
        .prepare(
          `SELECT * FROM mudae_watch_deliveries
           WHERE guild_id = ? AND reservation_id = ?
             AND delivery_state = 'reserved'`,
        )
        .get(this.guildId, normalizedReservationId) as DeliveryRow | undefined;
      if (!reserved) return;
      const updated = this.db
        .prepare(
          `UPDATE mudae_watch_deliveries
           SET delivery_state = ?, reservation_id = NULL,
               completed_at = ?, updated_at = ?
           WHERE guild_id = ? AND reservation_id = ?
             AND delivery_state = 'reserved'`,
        )
        .run(
          normalizedOutcome,
          now,
          now,
          this.guildId,
          normalizedReservationId,
        );
      if (updated.changes === 0) return;
      if (updated.changes !== 1) {
        throw new Error(
          "Mudae watch delivery completion updated multiple rows",
        );
      }
      const row = this.getDeliveryRow(reserved.message_id);
      if (!row) {
        throw new Error("Completed Mudae watch delivery could not be read");
      }
      this.pruneWithin(now);
      result = parseDelivery(row);
    });
    complete.immediate();
    return result;
  }

  /** Delete only when no Discord delivery request could have been accepted. */
  public releaseDelivery(reservationId: string): boolean {
    const normalizedReservationId = normalizeReservationId(reservationId);
    const released = this.db
      .prepare(
        `DELETE FROM mudae_watch_deliveries
         WHERE guild_id = ? AND reservation_id = ?
           AND delivery_state = 'reserved'`,
      )
      .run(this.guildId, normalizedReservationId);
    return released.changes === 1;
  }

  public pruneDeliveries(): number {
    let deleted = 0;
    const prune = this.db.transaction(() => {
      deleted = this.pruneWithin(utcNow());
    });
    prune.immediate();
    return deleted;
  }

  private getDeliveryRow(messageId: string): DeliveryRow | null {
    return (
      (this.db
        .prepare(
          `SELECT * FROM mudae_watch_deliveries
           WHERE guild_id = ? AND message_id = ?`,
        )
        .get(this.guildId, messageId) as DeliveryRow | undefined) ?? null
    );
  }

  private pruneWithin(now: string): number {
    const cutoff = retentionCutoff(now);
    const expired = this.db
      .prepare(
        `DELETE FROM mudae_watch_deliveries
         WHERE guild_id = ? AND updated_at < ?`,
      )
      .run(this.guildId, cutoff).changes;
    return expired + this.trimToLimit(MAX_MUDAE_WATCH_DELIVERIES_PER_GUILD);
  }

  private trimToLimit(limit: number): number {
    return this.db
      .prepare(
        `DELETE FROM mudae_watch_deliveries
         WHERE rowid IN (
           SELECT rowid FROM mudae_watch_deliveries
           WHERE guild_id = ?
           ORDER BY updated_at DESC, rowid DESC
           LIMIT -1 OFFSET ?
         )`,
      )
      .run(this.guildId, limit).changes;
  }
}

function parseDelivery(row: DeliveryRow): MudaeWatchDeliveryRecord {
  const state = normalizeState(row.delivery_state);
  return {
    guildId: row.guild_id,
    messageId: row.message_id,
    state,
    reservationId: row.reservation_id,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeState(value: string): MudaeWatchDeliveryState {
  if (value !== "reserved" && value !== "delivered" && value !== "failed") {
    throw new TypeError(`Unsupported Mudae watch delivery state: ${value}`);
  }
  return value;
}

function normalizeOutcome(value: string): MudaeWatchDeliveryOutcome {
  if (value !== "delivered" && value !== "failed") {
    throw new TypeError(`Unsupported Mudae watch delivery outcome: ${value}`);
  }
  return value;
}

function normalizeReservationId(value: string): string {
  const normalized = String(value).trim();
  if (
    normalized.length < 8 ||
    normalized.length > 24 ||
    /[^A-Za-z0-9_-]/.test(normalized)
  ) {
    throw new TypeError("Reservation ID must be an 8-24 character opaque ID");
  }
  return normalized;
}

function retentionCutoff(now: string): string {
  return new Date(Date.parse(now) - RETENTION_MILLISECONDS).toISOString();
}

function utcNow(): string {
  return new Date().toISOString();
}
