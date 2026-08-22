import type Database from "better-sqlite3";
import { assertDiscordSnowflake } from "../guild-settings.js";
import {
  ANTI_SPAM_ACTIONS,
  ANTI_SPAM_RULE_TYPES,
  type AntiSpamAction,
  type AntiSpamEnforcement,
  type AntiSpamEnforcementCompletionInput,
  type AntiSpamEnforcementOutcome,
  type AntiSpamEnforcementReservationInput,
  type AntiSpamEnforcementReservationResult,
  type AntiSpamEvent,
  type AntiSpamExemption,
  type AntiSpamRule,
  type AntiSpamRuleInput,
  type AntiSpamRuleType,
} from "../types.js";
import { createOpaqueStorageId } from "./operational-repository.js";

const RESERVATION_SECONDS = 300;
const MAX_LIST_LIMIT = 100;
const MAX_RULES = 3;
const MAX_ENFORCEMENTS = 100_000;
const MAX_EVENTS = 100_000;
const MAX_EXEMPTIONS = 250;

export class AntiSpamRepository {
  public constructor(
    private readonly db: Database.Database,
    public readonly guildId: string,
  ) {}

  public getRule(ruleType: AntiSpamRuleType): AntiSpamRule | null {
    const row = this.db
      .prepare(
        "SELECT * FROM anti_spam_rules WHERE guild_id = ? AND rule_type = ?",
      )
      .get(this.guildId, normalizeRuleType(ruleType)) as
      Record<string, unknown> | undefined;
    return row ? parseAntiSpamRuleRow(row) : null;
  }

  public listRules(): AntiSpamRule[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM anti_spam_rules WHERE guild_id = ? ORDER BY rule_type LIMIT ?",
      )
      .all(this.guildId, MAX_RULES + 1) as Array<Record<string, unknown>>;
    if (rows.length > MAX_RULES) {
      throw new RangeError("Anti-spam rule storage exceeds its safety limit");
    }
    return rows.map(parseAntiSpamRuleRow);
  }

  public upsertRule(input: AntiSpamRuleInput): AntiSpamRule {
    const normalized = normalizeRuleInput(input);
    const existing = this.getRule(normalized.ruleType);
    const now = utcNow();
    this.db
      .prepare(
        `INSERT INTO anti_spam_rules (
           guild_id, rule_type, enabled, threshold, window_seconds, action,
           timeout_seconds, cooldown_seconds, created_by, updated_by,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(guild_id, rule_type) DO UPDATE SET
           enabled = excluded.enabled, threshold = excluded.threshold,
           window_seconds = excluded.window_seconds, action = excluded.action,
           timeout_seconds = excluded.timeout_seconds,
           cooldown_seconds = excluded.cooldown_seconds,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .run(
        this.guildId,
        normalized.ruleType,
        normalized.enabled ? 1 : 0,
        normalized.threshold,
        normalized.windowSeconds,
        normalized.action,
        normalized.timeoutSeconds,
        normalized.cooldownSeconds,
        existing?.createdBy ?? normalized.actorId,
        normalized.actorId,
        existing?.createdAt ?? now,
        now,
      );
    return this.requireRule(normalized.ruleType);
  }

  public setRuleEnabled(
    ruleType: AntiSpamRuleType,
    enabled: boolean,
    actorId: string,
  ): AntiSpamRule | null {
    const type = normalizeRuleType(ruleType);
    const result = this.db
      .prepare(
        `UPDATE anti_spam_rules SET enabled = ?, updated_by = ?, updated_at = ?
         WHERE guild_id = ? AND rule_type = ?`,
      )
      .run(
        enabled ? 1 : 0,
        assertDiscordSnowflake(actorId, "actor ID"),
        utcNow(),
        this.guildId,
        type,
      );
    return result.changes === 1 ? this.requireRule(type) : null;
  }

  public listExemptRoleIds(): string[] {
    return (
      this.db
        .prepare(
          "SELECT role_id FROM anti_spam_exempt_roles WHERE guild_id = ? ORDER BY role_id LIMIT ?",
        )
        .all(this.guildId, MAX_EXEMPTIONS) as Array<{ role_id: string }>
    ).map((row) => row.role_id);
  }

  public listExemptChannelIds(): string[] {
    return (
      this.db
        .prepare(
          "SELECT channel_id FROM anti_spam_exempt_channels WHERE guild_id = ? ORDER BY channel_id LIMIT ?",
        )
        .all(this.guildId, MAX_EXEMPTIONS) as Array<{ channel_id: string }>
    ).map((row) => row.channel_id);
  }

  public addExemptRole(roleId: string, actorId: string): AntiSpamExemption {
    const subjectId = assertDiscordSnowflake(roleId, "role ID");
    if (subjectId === this.guildId)
      throw new TypeError("The @everyone role cannot be exempted");
    return this.addExemption(
      "anti_spam_exempt_roles",
      "role_id",
      subjectId,
      actorId,
    );
  }

  public removeExemptRole(roleId: string): boolean {
    return this.removeExemption("anti_spam_exempt_roles", "role_id", roleId);
  }

  public addExemptChannel(
    channelId: string,
    actorId: string,
  ): AntiSpamExemption {
    return this.addExemption(
      "anti_spam_exempt_channels",
      "channel_id",
      assertDiscordSnowflake(channelId, "channel ID"),
      actorId,
    );
  }

  public removeExemptChannel(channelId: string): boolean {
    return this.removeExemption(
      "anti_spam_exempt_channels",
      "channel_id",
      channelId,
    );
  }

  public reserveEnforcement(
    input: AntiSpamEnforcementReservationInput,
  ): AntiSpamEnforcementReservationResult {
    const normalized = normalizeReservationInput(input);
    let result: AntiSpamEnforcementReservationResult | null = null;
    const reserve = this.db.transaction(() => {
      this.recoverExpiredEnforcementsWithin(100);
      const existing = this.getByMessage(
        normalized.ruleType,
        normalized.messageId,
        normalized.memberId,
      );
      if (existing) {
        result = {
          status: "duplicate",
          reservationId: null,
          retryAt: existing.reservationExpiresAt,
          enforcement: existing,
        };
        return;
      }
      const rule = this.getRule(normalized.ruleType);
      if (!rule?.enabled) {
        throw new Error("Anti-spam rule is not enabled");
      }
      const now = utcNow();
      const latest = this.db
        .prepare(
          `SELECT updated_at FROM anti_spam_enforcements
           WHERE guild_id = ? AND rule_type = ? AND member_id = ?
             AND enforcement_state IN ('deleted', 'warned', 'timed-out')
           ORDER BY updated_at DESC LIMIT 1`,
        )
        .get(this.guildId, normalized.ruleType, normalized.memberId) as
        { updated_at: string } | undefined;
      if (latest) {
        const retryAt = new Date(
          Date.parse(latest.updated_at) + rule.cooldownSeconds * 1_000,
        ).toISOString();
        if (Date.parse(retryAt) > Date.parse(now)) {
          result = {
            status: "cooldown",
            reservationId: null,
            retryAt,
            enforcement: null,
          };
          return;
        }
      }

      this.trimEnforcements(MAX_ENFORCEMENTS - 1);
      const currentCount = Number(
        (
          this.db
            .prepare(
              "SELECT COUNT(*) AS count FROM anti_spam_enforcements WHERE guild_id = ?",
            )
            .get(this.guildId) as { count: number }
        ).count,
      );
      if (currentCount >= MAX_ENFORCEMENTS) {
        throw new RangeError(
          "Anti-spam enforcement storage is full while active reservations remain",
        );
      }
      const enforcementId = createOpaqueStorageId();
      const reservationId = createOpaqueStorageId();
      const expiresAt = new Date(
        Date.parse(now) + RESERVATION_SECONDS * 1_000,
      ).toISOString();
      const inserted = this.db
        .prepare(
          `INSERT INTO anti_spam_enforcements (
             guild_id, enforcement_id, rule_type, message_id, member_id,
             channel_id, observed_count, enforcement_state, reservation_id,
             case_id, failure_code, reservation_expires_at, completed_at,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, NULL, NULL, ?, NULL, ?, ?)
           ON CONFLICT(guild_id, rule_type, message_id, member_id) DO NOTHING`,
        )
        .run(
          this.guildId,
          enforcementId,
          normalized.ruleType,
          normalized.messageId,
          normalized.memberId,
          normalized.channelId,
          normalized.observedCount,
          reservationId,
          expiresAt,
          now,
          now,
        );
      if (inserted.changes !== 1) {
        const raced = this.getByMessage(
          normalized.ruleType,
          normalized.messageId,
          normalized.memberId,
        );
        if (!raced)
          throw new Error(
            "Anti-spam enforcement reservation was not persisted",
          );
        result = {
          status: "duplicate",
          reservationId: null,
          retryAt: raced.reservationExpiresAt,
          enforcement: raced,
        };
        return;
      }
      result = {
        status: "reserved",
        reservationId,
        retryAt: null,
        enforcement: this.requireEnforcement(enforcementId),
      };
    });
    reserve.immediate();
    if (!result) throw new Error("Anti-spam reservation returned no result");
    return result;
  }

  public completeEnforcement(
    reservationId: string,
    input: AntiSpamEnforcementCompletionInput,
  ): AntiSpamEnforcement | null {
    const token = requireOpaqueId(reservationId, "reservation ID");
    const outcome = normalizeOutcome(input.outcome);
    const caseId =
      input.caseId == null ? null : requireOpaqueId(input.caseId, "case ID");
    const failureCode =
      input.failureCode == null
        ? null
        : safeText(input.failureCode, 1, 100, "failure code");
    if (["warned", "timed-out"].includes(outcome) && !caseId) {
      throw new TypeError(
        "Warning and timeout enforcement requires a persisted case ID",
      );
    }
    let result: AntiSpamEnforcement | null = null;
    const complete = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT * FROM anti_spam_enforcements
           WHERE guild_id = ? AND reservation_id = ? AND enforcement_state = 'reserved'`,
        )
        .get(this.guildId, token) as Record<string, unknown> | undefined;
      if (!row) return;
      const now = utcNow();
      const updated = this.db
        .prepare(
          `UPDATE anti_spam_enforcements SET enforcement_state = ?,
             reservation_id = NULL, reservation_expires_at = NULL,
             case_id = ?, failure_code = ?, completed_at = ?, updated_at = ?
           WHERE guild_id = ? AND reservation_id = ? AND enforcement_state = 'reserved'`,
        )
        .run(outcome, caseId, failureCode, now, now, this.guildId, token);
      if (updated.changes !== 1) return;
      const enforcement = this.requireEnforcement(String(row.enforcement_id));
      this.appendEvent(enforcement, outcome);
      this.trimEvents();
      result = enforcement;
    });
    complete.immediate();
    return result;
  }

  public getEnforcement(enforcementId: string): AntiSpamEnforcement | null {
    const id = normalizeOpaqueId(enforcementId);
    if (!id) return null;
    const row = this.db
      .prepare(
        "SELECT * FROM anti_spam_enforcements WHERE guild_id = ? AND enforcement_id = ?",
      )
      .get(this.guildId, id) as Record<string, unknown> | undefined;
    return row ? parseAntiSpamEnforcementRow(row) : null;
  }

  public listEnforcements(
    listLimit = 25,
    listOffset = 0,
  ): AntiSpamEnforcement[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM anti_spam_enforcements WHERE guild_id = ?
           ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
        )
        .all(this.guildId, limit(listLimit), offset(listOffset)) as Array<
        Record<string, unknown>
      >
    ).map(parseAntiSpamEnforcementRow);
  }

  public listEvents(listLimit = 25, listOffset = 0): AntiSpamEvent[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM anti_spam_events WHERE guild_id = ?
           ORDER BY event_number DESC LIMIT ? OFFSET ?`,
        )
        .all(this.guildId, limit(listLimit), offset(listOffset)) as Array<
        Record<string, unknown>
      >
    ).map(parseAntiSpamEventRow);
  }

  /** Converts bounded, shutdown-interrupted reservations into durable failures. */
  public recoverExpiredEnforcements(recoveryLimit = 100): number {
    let recovered = 0;
    const recover = this.db.transaction(() => {
      recovered = this.recoverExpiredEnforcementsWithin(limit(recoveryLimit));
    });
    recover.immediate();
    return recovered;
  }

  private getByMessage(
    ruleType: AntiSpamRuleType,
    messageId: string,
    memberId: string,
  ): AntiSpamEnforcement | null {
    const row = this.db
      .prepare(
        `SELECT * FROM anti_spam_enforcements
         WHERE guild_id = ? AND rule_type = ? AND message_id = ? AND member_id = ?`,
      )
      .get(this.guildId, ruleType, messageId, memberId) as
      Record<string, unknown> | undefined;
    return row ? parseAntiSpamEnforcementRow(row) : null;
  }

  private addExemption(
    table: "anti_spam_exempt_roles" | "anti_spam_exempt_channels",
    column: "role_id" | "channel_id",
    subjectId: string,
    actorId: string,
  ): AntiSpamExemption {
    const actor = assertDiscordSnowflake(actorId, "actor ID");
    const existing = this.db
      .prepare(`SELECT 1 FROM ${table} WHERE guild_id = ? AND ${column} = ?`)
      .get(this.guildId, subjectId);
    if (!existing) {
      const count = Number(
        (
          this.db
            .prepare(
              `SELECT COUNT(*) AS count FROM ${table} WHERE guild_id = ?`,
            )
            .get(this.guildId) as { count: number }
        ).count,
      );
      if (count >= MAX_EXEMPTIONS) {
        throw new RangeError(
          `Anti-spam exemptions are limited to ${MAX_EXEMPTIONS}`,
        );
      }
    }
    const now = utcNow();
    this.db
      .prepare(
        `INSERT INTO ${table} (guild_id, ${column}, created_by, created_at)
         VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, ${column}) DO NOTHING`,
      )
      .run(this.guildId, subjectId, actor, now);
    const row = this.db
      .prepare(`SELECT * FROM ${table} WHERE guild_id = ? AND ${column} = ?`)
      .get(this.guildId, subjectId) as Record<string, unknown>;
    return {
      guildId: String(row.guild_id),
      subjectId: String(row[column]),
      createdBy: String(row.created_by),
      createdAt: String(row.created_at),
    };
  }

  private removeExemption(
    table: "anti_spam_exempt_roles" | "anti_spam_exempt_channels",
    column: "role_id" | "channel_id",
    subjectId: string,
  ): boolean {
    return (
      this.db
        .prepare(`DELETE FROM ${table} WHERE guild_id = ? AND ${column} = ?`)
        .run(this.guildId, assertDiscordSnowflake(subjectId)).changes === 1
    );
  }

  private appendEvent(
    enforcement: AntiSpamEnforcement,
    outcome: AntiSpamEnforcementOutcome,
  ): void {
    const next = this.db
      .prepare(
        "SELECT COALESCE(MAX(event_number), 0) + 1 AS next FROM anti_spam_events WHERE guild_id = ?",
      )
      .get(this.guildId) as { next: number };
    this.db
      .prepare(
        `INSERT INTO anti_spam_events (
           guild_id, event_id, event_number, rule_type, message_id, member_id,
           channel_id, observed_count, outcome, case_id, failure_code, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.guildId,
        createOpaqueStorageId(),
        Number(next.next),
        enforcement.ruleType,
        enforcement.messageId,
        enforcement.memberId,
        enforcement.channelId,
        enforcement.observedCount,
        outcome,
        enforcement.caseId,
        enforcement.failureCode,
        utcNow(),
      );
  }

  private trimEnforcements(maximum = MAX_ENFORCEMENTS): void {
    const total = Number(
      (
        this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM anti_spam_enforcements WHERE guild_id = ?",
          )
          .get(this.guildId) as { count: number }
      ).count,
    );
    const excess = Math.max(0, total - maximum);
    if (excess === 0) return;
    this.db
      .prepare(
        `DELETE FROM anti_spam_enforcements WHERE guild_id = ? AND enforcement_id IN (
           SELECT enforcement_id FROM anti_spam_enforcements WHERE guild_id = ?
             AND enforcement_state <> 'reserved'
           ORDER BY updated_at ASC LIMIT ?
         )`,
      )
      .run(this.guildId, this.guildId, excess);
  }

  private recoverExpiredEnforcementsWithin(recoveryLimit: number): number {
    const now = utcNow();
    const rows = this.db
      .prepare(
        `SELECT enforcement_id FROM anti_spam_enforcements
       WHERE guild_id = ? AND enforcement_state = 'reserved'
         AND reservation_expires_at <= ?
       ORDER BY reservation_expires_at ASC LIMIT ?`,
      )
      .all(this.guildId, now, recoveryLimit) as Array<{
      enforcement_id: string;
    }>;
    let recovered = 0;
    for (const row of rows) {
      const changed = this.db
        .prepare(
          `UPDATE anti_spam_enforcements SET enforcement_state = 'failed',
           reservation_id = NULL, reservation_expires_at = NULL,
           failure_code = 'reservation-expired', completed_at = ?, updated_at = ?
         WHERE guild_id = ? AND enforcement_id = ?
           AND enforcement_state = 'reserved' AND reservation_expires_at <= ?`,
        )
        .run(now, now, this.guildId, row.enforcement_id, now);
      if (changed.changes !== 1) continue;
      const enforcement = this.requireEnforcement(row.enforcement_id);
      this.appendEvent(enforcement, "failed");
      recovered += 1;
    }
    if (recovered > 0) this.trimEvents();
    return recovered;
  }

  private trimEvents(): void {
    this.db
      .prepare(
        `DELETE FROM anti_spam_events WHERE guild_id = ? AND event_id IN (
           SELECT event_id FROM anti_spam_events WHERE guild_id = ?
           ORDER BY event_number DESC LIMIT -1 OFFSET ?
         )`,
      )
      .run(this.guildId, this.guildId, MAX_EVENTS);
  }

  private requireRule(type: AntiSpamRuleType): AntiSpamRule {
    const rule = this.getRule(type);
    if (!rule) throw new Error("Anti-spam rule was not persisted");
    return rule;
  }

  private requireEnforcement(id: string): AntiSpamEnforcement {
    const enforcement = this.getEnforcement(id);
    if (!enforcement)
      throw new Error("Anti-spam enforcement was not persisted");
    return enforcement;
  }
}

function normalizeRuleInput(input: AntiSpamRuleInput): AntiSpamRuleInput & {
  enabled: boolean;
  windowSeconds: number | null;
  timeoutSeconds: number | null;
  actorId: string;
} {
  const ruleType = normalizeRuleType(input.ruleType);
  const action = normalizeAction(input.action);
  const windowSeconds =
    ruleType === "mention"
      ? null
      : integer(input.windowSeconds, 1, 300, "window seconds");
  const timeoutSeconds =
    action === "delete-and-timeout"
      ? integer(input.timeoutSeconds, 60, 2_419_200, "timeout seconds")
      : null;
  return {
    ...input,
    ruleType,
    action,
    enabled: input.enabled ?? false,
    threshold: integer(input.threshold, 2, 100, "threshold"),
    windowSeconds,
    timeoutSeconds,
    cooldownSeconds: integer(
      input.cooldownSeconds,
      1,
      86_400,
      "cooldown seconds",
    ),
    actorId: assertDiscordSnowflake(input.actorId, "actor ID"),
  };
}

function normalizeReservationInput(
  input: AntiSpamEnforcementReservationInput,
): AntiSpamEnforcementReservationInput {
  return {
    ruleType: normalizeRuleType(input.ruleType),
    messageId: assertDiscordSnowflake(input.messageId, "message ID"),
    memberId: assertDiscordSnowflake(input.memberId, "member ID"),
    channelId: assertDiscordSnowflake(input.channelId, "channel ID"),
    observedCount: integer(input.observedCount, 1, 1_000, "observed count"),
  };
}

export function parseAntiSpamRuleRow(
  row: Record<string, unknown>,
): AntiSpamRule {
  return {
    guildId: String(row.guild_id),
    ruleType: normalizeRuleType(row.rule_type),
    enabled: Boolean(row.enabled),
    threshold: Number(row.threshold),
    windowSeconds:
      row.window_seconds === null ? null : Number(row.window_seconds),
    action: normalizeAction(row.action),
    timeoutSeconds:
      row.timeout_seconds === null ? null : Number(row.timeout_seconds),
    cooldownSeconds: Number(row.cooldown_seconds),
    createdBy: String(row.created_by),
    updatedBy: String(row.updated_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
export function parseAntiSpamEnforcementRow(
  row: Record<string, unknown>,
): AntiSpamEnforcement {
  return {
    guildId: String(row.guild_id),
    enforcementId: String(row.enforcement_id),
    ruleType: normalizeRuleType(row.rule_type),
    messageId: String(row.message_id),
    memberId: String(row.member_id),
    channelId: String(row.channel_id),
    observedCount: Number(row.observed_count),
    state: String(row.enforcement_state) as AntiSpamEnforcement["state"],
    reservationId: nullable(row.reservation_id),
    caseId: nullable(row.case_id),
    failureCode: nullable(row.failure_code),
    reservationExpiresAt: nullable(row.reservation_expires_at),
    completedAt: nullable(row.completed_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
export function parseAntiSpamEventRow(
  row: Record<string, unknown>,
): AntiSpamEvent {
  return {
    guildId: String(row.guild_id),
    eventId: String(row.event_id),
    eventNumber: Number(row.event_number),
    ruleType: normalizeRuleType(row.rule_type),
    messageId: String(row.message_id),
    memberId: String(row.member_id),
    channelId: String(row.channel_id),
    observedCount: Number(row.observed_count),
    outcome: normalizeOutcome(row.outcome),
    caseId: nullable(row.case_id),
    failureCode: nullable(row.failure_code),
    createdAt: String(row.created_at),
  };
}
function normalizeRuleType(value: unknown): AntiSpamRuleType {
  if (!(ANTI_SPAM_RULE_TYPES as readonly unknown[]).includes(value))
    throw new TypeError("Unsupported anti-spam rule type");
  return value as AntiSpamRuleType;
}
function normalizeAction(value: unknown): AntiSpamAction {
  if (!(ANTI_SPAM_ACTIONS as readonly unknown[]).includes(value))
    throw new TypeError("Unsupported anti-spam action");
  return value as AntiSpamAction;
}
function normalizeOutcome(value: unknown): AntiSpamEnforcementOutcome {
  if (
    !["deleted", "warned", "timed-out", "failed", "skipped"].includes(
      String(value),
    )
  )
    throw new TypeError("Unsupported anti-spam enforcement outcome");
  return value as AntiSpamEnforcementOutcome;
}
function integer(
  value: unknown,
  min: number,
  max: number,
  label: string,
): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max)
    throw new RangeError(`${label} must be between ${min} and ${max}`);
  return Number(value);
}
function safeText(
  value: unknown,
  min: number,
  max: number,
  label: string,
): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be text`);
  const text = value.normalize("NFKC").trim();
  if (
    text.length < min ||
    text.length > max ||
    /[\u0000-\u001f\u007f]/u.test(text)
  )
    throw new RangeError(`${label} must contain ${min}-${max} safe characters`);
  return text;
}
function requireOpaqueId(value: unknown, label: string): string {
  const id = normalizeOpaqueId(value);
  if (!id) throw new TypeError(`${label} must be an opaque ID`);
  return id;
}
function normalizeOpaqueId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,24}$/.test(value)
    ? value
    : null;
}
function nullable(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
function limit(value: number): number {
  return integer(value, 1, MAX_LIST_LIMIT, "list limit");
}
function offset(value: number): number {
  return integer(value, 0, 2_147_483_647, "list offset");
}
function utcNow(): string {
  return new Date().toISOString();
}
