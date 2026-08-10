import type Database from "better-sqlite3";
import { assertDiscordSnowflake } from "../guild-settings.js";
import {
  RESTRICTED_PING_EVENT_TYPES,
  type RestrictedPingAddMappingInput,
  type RestrictedPingAddMappingResult,
  type RestrictedPingCleanupResult,
  type RestrictedPingCompletionResult,
  type RestrictedPingConfigureInput,
  type RestrictedPingEvent,
  type RestrictedPingEventType,
  type RestrictedPingMapping,
  type RestrictedPingRemoveMappingResult,
  type RestrictedPingReservationInput,
  type RestrictedPingReservationResult,
  type RestrictedPingRoleConfiguration,
} from "../types.js";
import { createOpaqueStorageId } from "./operational-repository.js";

interface RestrictedPingRoleRow {
  guild_id: string;
  role_id: string;
  enabled: number;
  user_cooldown_seconds: number;
  role_cooldown_seconds: number;
  allow_threads: number;
  bindings_verified_at: string | null;
  last_role_success_at: string | null;
  success_count: number;
  reservation_id: string | null;
  reservation_user_id: string | null;
  reservation_channel_id: string | null;
  reservation_source: string | null;
  reservation_expires_at: string | null;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

interface RestrictedPingMappingRow {
  guild_id: string;
  role_id: string;
  channel_id: string;
  created_by: string;
  created_at: string;
}

interface RestrictedPingUserCooldownRow {
  last_success_at: string;
}

interface RestrictedPingEventRow {
  guild_id: string;
  event_id: string;
  event_number: number;
  event_type: string;
  actor_id: string | null;
  role_id: string;
  channel_id: string | null;
  user_id: string | null;
  source: string;
  details_json: string;
  created_at: string;
}

interface AppendEventInput {
  type: RestrictedPingEventType;
  actorId?: string | null;
  roleId: string;
  channelId?: string | null;
  userId?: string | null;
  source: string;
  details?: unknown;
}

export const DEFAULT_RESTRICTED_PING_USER_COOLDOWN_SECONDS = 60;
export const DEFAULT_RESTRICTED_PING_ROLE_COOLDOWN_SECONDS = 30;
export const DEFAULT_RESTRICTED_PING_ALLOW_THREADS = false;
export const MAX_RESTRICTED_PING_SUCCESS_EVENTS_PER_GUILD = 10_000;

const MIN_USER_COOLDOWN_SECONDS = 1;
const MAX_COOLDOWN_SECONDS = 86_400;
const MIN_RESERVATION_LEASE_SECONDS = 120;
const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;
const MAX_EVENT_SOURCE_LENGTH = 100;
const MAX_EVENT_DETAILS_BYTES = 4_000;

/** Guild-bound configuration, reservation, cooldown, and audit persistence. */
export class RestrictedPingRepository {
  public constructor(
    private readonly db: Database.Database,
    public readonly guildId: string,
  ) {}

  public getRole(roleId: string): RestrictedPingRoleConfiguration | null {
    const normalizedRoleId = assertDiscordSnowflake(roleId, "role ID");
    const row = this.getRoleRow(normalizedRoleId);
    return row ? parseRoleConfiguration(row) : null;
  }

  public listRoles(
    limit = DEFAULT_LIST_LIMIT,
    offset = 0,
  ): RestrictedPingRoleConfiguration[] {
    const boundedLimit = normalizeListLimit(limit);
    const boundedOffset = normalizeOffset(offset);
    const rows = this.db
      .prepare(
        `SELECT * FROM restricted_ping_roles
         WHERE guild_id = ? ORDER BY role_id LIMIT ? OFFSET ?`,
      )
      .all(
        this.guildId,
        boundedLimit,
        boundedOffset,
      ) as RestrictedPingRoleRow[];
    return rows.map(parseRoleConfiguration);
  }

  public countRoles(): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM restricted_ping_roles WHERE guild_id = ?",
      )
      .get(this.guildId) as { count: number };
    return Number(row.count);
  }

  public listMappings(
    roleId: string,
    limit = DEFAULT_LIST_LIMIT,
    offset = 0,
  ): RestrictedPingMapping[] {
    const normalizedRoleId = assertDiscordSnowflake(roleId, "role ID");
    const boundedLimit = normalizeListLimit(limit);
    const boundedOffset = normalizeOffset(offset);
    const rows = this.db
      .prepare(
        `SELECT * FROM restricted_ping_channels
         WHERE guild_id = ? AND role_id = ?
         ORDER BY channel_id LIMIT ? OFFSET ?`,
      )
      .all(
        this.guildId,
        normalizedRoleId,
        boundedLimit,
        boundedOffset,
      ) as RestrictedPingMappingRow[];
    return rows.map(parseMapping);
  }

  public addMapping(
    input: RestrictedPingAddMappingInput,
  ): RestrictedPingAddMappingResult {
    const roleId = assertDiscordSnowflake(input.roleId, "role ID");
    const channelId = assertDiscordSnowflake(input.channelId, "channel ID");
    const createdBy = assertDiscordSnowflake(
      input.createdBy,
      "creating user ID",
    );
    const enabled = normalizeBoolean(input.enabled ?? true, "Enabled");
    const userCooldownSeconds = normalizeUserCooldown(
      input.userCooldownSeconds ??
        DEFAULT_RESTRICTED_PING_USER_COOLDOWN_SECONDS,
    );
    const roleCooldownSeconds = normalizeRoleCooldown(
      input.roleCooldownSeconds ??
        DEFAULT_RESTRICTED_PING_ROLE_COOLDOWN_SECONDS,
    );
    const allowThreads = normalizeBoolean(
      input.allowThreads ?? DEFAULT_RESTRICTED_PING_ALLOW_THREADS,
      "Allow threads",
    );
    const bindingsVerifiedAt = normalizeNullableTimestamp(
      input.bindingsVerifiedAt ?? null,
      "Bindings verification timestamp",
    );
    let result: RestrictedPingAddMappingResult | null = null;
    const add = this.db.transaction(() => {
      let configuration = this.getRoleRow(roleId);
      const now = utcNow();
      const configurationCreated = configuration === null;
      if (!configuration) {
        this.db
          .prepare(
            `INSERT INTO restricted_ping_roles (
               guild_id, role_id, enabled, user_cooldown_seconds,
               role_cooldown_seconds, allow_threads, bindings_verified_at,
               last_role_success_at, success_count, reservation_id,
               reservation_user_id, reservation_channel_id, reservation_source,
               reservation_expires_at, created_by, updated_by, created_at,
               updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, NULL, NULL, NULL,
               NULL, ?, ?, ?, ?)`,
          )
          .run(
            this.guildId,
            roleId,
            enabled ? 1 : 0,
            userCooldownSeconds,
            roleCooldownSeconds,
            allowThreads ? 1 : 0,
            bindingsVerifiedAt,
            createdBy,
            createdBy,
            now,
            now,
          );
        configuration = this.requireRoleRow(roleId);
      }

      const existing = this.getMappingRow(roleId, channelId);
      if (existing) {
        result = {
          status: "duplicate",
          configuration: parseRoleConfiguration(configuration),
          mapping: parseMapping(existing),
        };
        return;
      }
      this.db
        .prepare(
          `INSERT INTO restricted_ping_channels (
             guild_id, role_id, channel_id, created_by, created_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(this.guildId, roleId, channelId, createdBy, now);
      this.appendEventWithin({
        type: "mapping_added",
        actorId: createdBy,
        roleId,
        channelId,
        source: "restrictedping.add",
        details: { configurationCreated },
      });
      result = {
        status: "created",
        configuration: parseRoleConfiguration(this.requireRoleRow(roleId)),
        mapping: parseMapping(this.requireMappingRow(roleId, channelId)),
      };
    });
    add.immediate();
    return requireResult<RestrictedPingAddMappingResult>(
      result,
      "Restricted ping mapping addition",
    );
  }

  public removeMapping(
    roleId: string,
    channelId: string,
    removedBy: string,
  ): RestrictedPingRemoveMappingResult {
    const normalizedRoleId = assertDiscordSnowflake(roleId, "role ID");
    const normalizedChannelId = assertDiscordSnowflake(channelId, "channel ID");
    const actorId = assertDiscordSnowflake(removedBy, "removing user ID");
    let result: RestrictedPingRemoveMappingResult | null = null;
    const remove = this.db.transaction(() => {
      const mapping = this.getMappingRow(normalizedRoleId, normalizedChannelId);
      if (!mapping) {
        result = {
          status: "not-found",
          mapping: null,
          configurationDeleted: false,
        };
        return;
      }
      this.appendEventWithin({
        type: "mapping_removed",
        actorId,
        roleId: normalizedRoleId,
        channelId: normalizedChannelId,
        source: "restrictedping.remove",
      });
      this.db
        .prepare(
          `DELETE FROM restricted_ping_channels
           WHERE guild_id = ? AND role_id = ? AND channel_id = ?`,
        )
        .run(this.guildId, normalizedRoleId, normalizedChannelId);
      const configurationDeleted = this.countMappings(normalizedRoleId) === 0;
      if (configurationDeleted) {
        this.db
          .prepare(
            "DELETE FROM restricted_ping_roles WHERE guild_id = ? AND role_id = ?",
          )
          .run(this.guildId, normalizedRoleId);
      }
      result = {
        status: "removed",
        mapping: parseMapping(mapping),
        configurationDeleted,
      };
    });
    remove.immediate();
    return requireResult<RestrictedPingRemoveMappingResult>(
      result,
      "Restricted ping mapping removal",
    );
  }

  public configureRole(
    roleId: string,
    update: RestrictedPingConfigureInput,
  ): RestrictedPingRoleConfiguration | null {
    const normalizedRoleId = assertDiscordSnowflake(roleId, "role ID");
    const updatedBy = assertDiscordSnowflake(
      update.updatedBy,
      "updating user ID",
    );
    const userCooldownSeconds =
      update.userCooldownSeconds === undefined
        ? undefined
        : normalizeUserCooldown(update.userCooldownSeconds);
    const roleCooldownSeconds =
      update.roleCooldownSeconds === undefined
        ? undefined
        : normalizeRoleCooldown(update.roleCooldownSeconds);
    const allowThreads =
      update.allowThreads === undefined
        ? undefined
        : normalizeBoolean(update.allowThreads, "Allow threads");
    const bindingsVerifiedAt =
      update.bindingsVerifiedAt === undefined
        ? undefined
        : normalizeNullableTimestamp(
            update.bindingsVerifiedAt,
            "Bindings verification timestamp",
          );
    let result: RestrictedPingRoleConfiguration | null | undefined;
    const configure = this.db.transaction(() => {
      const current = this.getRoleRow(normalizedRoleId);
      if (!current) {
        result = null;
        return;
      }
      const nextUserCooldown =
        userCooldownSeconds ?? current.user_cooldown_seconds;
      const nextRoleCooldown =
        roleCooldownSeconds ?? current.role_cooldown_seconds;
      const nextAllowThreads = allowThreads ?? Boolean(current.allow_threads);
      const nextBindingsVerifiedAt =
        bindingsVerifiedAt === undefined
          ? current.bindings_verified_at
          : bindingsVerifiedAt;
      const changed =
        nextUserCooldown !== current.user_cooldown_seconds ||
        nextRoleCooldown !== current.role_cooldown_seconds ||
        nextAllowThreads !== Boolean(current.allow_threads) ||
        nextBindingsVerifiedAt !== current.bindings_verified_at;
      if (!changed) {
        result = parseRoleConfiguration(current);
        return;
      }
      this.db
        .prepare(
          `UPDATE restricted_ping_roles
           SET user_cooldown_seconds = ?, role_cooldown_seconds = ?,
               allow_threads = ?, bindings_verified_at = ?, updated_by = ?,
               updated_at = ?
           WHERE guild_id = ? AND role_id = ?`,
        )
        .run(
          nextUserCooldown,
          nextRoleCooldown,
          nextAllowThreads ? 1 : 0,
          nextBindingsVerifiedAt,
          updatedBy,
          utcNow(),
          this.guildId,
          normalizedRoleId,
        );
      this.appendEventWithin({
        type: "configuration_updated",
        actorId: updatedBy,
        roleId: normalizedRoleId,
        source: "restrictedping.configure",
        details: {
          userCooldownSeconds: nextUserCooldown,
          roleCooldownSeconds: nextRoleCooldown,
          allowThreads: nextAllowThreads,
          bindingsVerifiedAt: nextBindingsVerifiedAt,
        },
      });
      result = parseRoleConfiguration(this.requireRoleRow(normalizedRoleId));
    });
    configure.immediate();
    if (result === undefined) {
      throw new Error(
        "Restricted ping configuration completed without a result",
      );
    }
    return result;
  }

  public setRoleEnabled(
    roleId: string,
    enabled: boolean,
    updatedBy: string,
    bindingsVerifiedAt?: string | null,
  ): RestrictedPingRoleConfiguration | null {
    const normalizedRoleId = assertDiscordSnowflake(roleId, "role ID");
    const nextEnabled = normalizeBoolean(enabled, "Enabled");
    const actorId = assertDiscordSnowflake(updatedBy, "updating user ID");
    const verifiedAt =
      bindingsVerifiedAt === undefined
        ? undefined
        : normalizeNullableTimestamp(
            bindingsVerifiedAt,
            "Bindings verification timestamp",
          );
    let result: RestrictedPingRoleConfiguration | null | undefined;
    const set = this.db.transaction(() => {
      const current = this.getRoleRow(normalizedRoleId);
      if (!current) {
        result = null;
        return;
      }
      const nextVerifiedAt =
        verifiedAt === undefined ? current.bindings_verified_at : verifiedAt;
      if (
        Boolean(current.enabled) === nextEnabled &&
        current.bindings_verified_at === nextVerifiedAt
      ) {
        result = parseRoleConfiguration(current);
        return;
      }
      this.db
        .prepare(
          `UPDATE restricted_ping_roles
           SET enabled = ?, bindings_verified_at = ?, updated_by = ?, updated_at = ?
           WHERE guild_id = ? AND role_id = ?`,
        )
        .run(
          nextEnabled ? 1 : 0,
          nextVerifiedAt,
          actorId,
          utcNow(),
          this.guildId,
          normalizedRoleId,
        );
      this.appendEventWithin({
        type: nextEnabled ? "enabled" : "disabled",
        actorId,
        roleId: normalizedRoleId,
        source: nextEnabled
          ? "restrictedping.enable"
          : "restrictedping.disable",
        details: { bindingsVerifiedAt: nextVerifiedAt },
      });
      result = parseRoleConfiguration(this.requireRoleRow(normalizedRoleId));
    });
    set.immediate();
    if (result === undefined) {
      throw new Error(
        "Restricted ping enable update completed without a result",
      );
    }
    return result;
  }

  public reservePing(
    input: RestrictedPingReservationInput,
  ): RestrictedPingReservationResult {
    const roleId = assertDiscordSnowflake(input.roleId, "role ID");
    const userId = assertDiscordSnowflake(input.userId, "user ID");
    const channelId = assertDiscordSnowflake(input.channelId, "channel ID");
    const mappingChannelId = assertDiscordSnowflake(
      input.mappingChannelId,
      "configured channel ID",
    );
    const source = normalizeSource(input.source);
    let result: RestrictedPingReservationResult | null = null;
    const reserve = this.db.transaction(() => {
      let row = this.getRoleRow(roleId);
      if (!row) {
        result = { status: "not-configured", configuration: null };
        return;
      }
      const now = utcNow();
      const nowMs = Date.parse(now);
      if (
        row.reservation_id !== null &&
        row.reservation_expires_at !== null &&
        Date.parse(row.reservation_expires_at) <= nowMs
      ) {
        this.clearReservation(roleId, row.reservation_id);
        row = this.requireRoleRow(roleId);
      }
      const configuration = parseRoleConfiguration(row);
      if (!configuration.enabled) {
        result = { status: "disabled", configuration };
        return;
      }
      if (channelId !== mappingChannelId && !configuration.allowThreads) {
        result = { status: "channel-not-allowed", configuration };
        return;
      }
      if (!this.getMappingRow(roleId, mappingChannelId)) {
        result = { status: "channel-not-allowed", configuration };
        return;
      }
      if (row.reservation_id !== null && row.reservation_expires_at !== null) {
        result = {
          status: "active-reservation",
          retryAt: row.reservation_expires_at,
          configuration,
        };
        return;
      }

      const userCooldown = this.db
        .prepare(
          `SELECT last_success_at FROM restricted_ping_user_cooldowns
           WHERE guild_id = ? AND role_id = ? AND user_id = ?`,
        )
        .get(this.guildId, roleId, userId) as
        RestrictedPingUserCooldownRow | undefined;
      const userRetryAt = cooldownRetryAt(
        userCooldown?.last_success_at ?? null,
        configuration.userCooldownSeconds,
        nowMs,
      );
      const roleRetryAt = cooldownRetryAt(
        configuration.lastRoleSuccessAt,
        configuration.roleCooldownSeconds,
        nowMs,
      );
      if (userRetryAt !== null || roleRetryAt !== null) {
        if (
          userRetryAt !== null &&
          (roleRetryAt === null ||
            Date.parse(userRetryAt) >= Date.parse(roleRetryAt))
        ) {
          result = {
            status: "user-cooldown",
            retryAt: userRetryAt,
            configuration,
          };
        } else {
          result = {
            status: "role-cooldown",
            retryAt: roleRetryAt!,
            configuration,
          };
        }
        return;
      }

      const reservationId = createOpaqueStorageId();
      const leaseSeconds = Math.max(
        MIN_RESERVATION_LEASE_SECONDS,
        configuration.userCooldownSeconds,
        configuration.roleCooldownSeconds,
      );
      const expiresAt = new Date(nowMs + leaseSeconds * 1_000).toISOString();
      const update = this.db
        .prepare(
          `UPDATE restricted_ping_roles
           SET reservation_id = ?, reservation_user_id = ?,
               reservation_channel_id = ?, reservation_source = ?,
               reservation_expires_at = ?
           WHERE guild_id = ? AND role_id = ? AND enabled = 1
             AND reservation_id IS NULL`,
        )
        .run(
          reservationId,
          userId,
          channelId,
          source,
          expiresAt,
          this.guildId,
          roleId,
        );
      if (update.changes !== 1) {
        const raced = this.requireRoleRow(roleId);
        if (raced.reservation_expires_at === null) {
          throw new Error("Restricted ping reservation was not persisted");
        }
        result = {
          status: "active-reservation",
          retryAt: raced.reservation_expires_at,
          configuration: parseRoleConfiguration(raced),
        };
        return;
      }
      result = {
        status: "reserved",
        reservationId,
        expiresAt,
        configuration: parseRoleConfiguration(this.requireRoleRow(roleId)),
      };
    });
    reserve.immediate();
    return requireResult<RestrictedPingReservationResult>(
      result,
      "Restricted ping reservation",
    );
  }

  public completePing(
    reservationId: string,
    messageId?: string | null,
  ): RestrictedPingCompletionResult {
    const normalizedReservationId = requireOpaqueId(
      reservationId,
      "reservation ID",
    );
    const normalizedMessageId = normalizeNullableSnowflake(
      messageId ?? null,
      "message ID",
    );
    let result: RestrictedPingCompletionResult | null = null;
    const complete = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT * FROM restricted_ping_roles
           WHERE guild_id = ? AND reservation_id = ?`,
        )
        .get(this.guildId, normalizedReservationId) as
        RestrictedPingRoleRow | undefined;
      if (!row) {
        result = { status: "not-found", configuration: null, event: null };
        return;
      }
      if (
        row.reservation_user_id === null ||
        row.reservation_channel_id === null ||
        row.reservation_source === null
      ) {
        throw new Error("Stored restricted ping reservation is incomplete");
      }
      const now = utcNow();
      const update = this.db
        .prepare(
          `UPDATE restricted_ping_roles
           SET last_role_success_at = ?, success_count = success_count + 1,
               reservation_id = NULL, reservation_user_id = NULL,
               reservation_channel_id = NULL, reservation_source = NULL,
               reservation_expires_at = NULL
           WHERE guild_id = ? AND role_id = ? AND reservation_id = ?
             AND success_count < 9007199254740991`,
        )
        .run(now, this.guildId, row.role_id, normalizedReservationId);
      if (update.changes !== 1) {
        throw new Error(
          "Restricted ping completion conflicted or exhausted its counter",
        );
      }
      const cooldownUpdate = this.db
        .prepare(
          `INSERT INTO restricted_ping_user_cooldowns (
             guild_id, role_id, user_id, last_success_at, success_count,
             updated_at
           ) VALUES (?, ?, ?, ?, 1, ?)
           ON CONFLICT(guild_id, role_id, user_id) DO UPDATE SET
             last_success_at = excluded.last_success_at,
             success_count = restricted_ping_user_cooldowns.success_count + 1,
             updated_at = excluded.updated_at
           WHERE restricted_ping_user_cooldowns.success_count < 9007199254740991`,
        )
        .run(this.guildId, row.role_id, row.reservation_user_id, now, now);
      if (cooldownUpdate.changes !== 1) {
        throw new Error("Restricted ping user cooldown counter is exhausted");
      }
      const event = this.appendEventWithin({
        type: "ping_succeeded",
        actorId: row.reservation_user_id,
        roleId: row.role_id,
        channelId: row.reservation_channel_id,
        userId: row.reservation_user_id,
        source: row.reservation_source,
        details: { messageId: normalizedMessageId },
      });
      this.trimSuccessfulEvents();
      result = {
        status: "completed",
        configuration: parseRoleConfiguration(this.requireRoleRow(row.role_id)),
        event,
      };
    });
    complete.immediate();
    return requireResult<RestrictedPingCompletionResult>(
      result,
      "Restricted ping completion",
    );
  }

  public releasePing(reservationId: string, reason?: string): boolean {
    const normalizedReservationId = requireOpaqueId(
      reservationId,
      "reservation ID",
    );
    if (reason !== undefined) {
      normalizeOptionalReason(reason);
    }
    const result = this.db
      .prepare(
        `UPDATE restricted_ping_roles
         SET reservation_id = NULL, reservation_user_id = NULL,
             reservation_channel_id = NULL, reservation_source = NULL,
             reservation_expires_at = NULL
         WHERE guild_id = ? AND reservation_id = ?`,
      )
      .run(this.guildId, normalizedReservationId);
    return result.changes === 1;
  }

  public cleanupDeletedRole(
    roleId: string,
    actorId?: string,
  ): RestrictedPingCleanupResult {
    const normalizedRoleId = assertDiscordSnowflake(roleId, "role ID");
    const normalizedActorId =
      actorId === undefined
        ? null
        : assertDiscordSnowflake(actorId, "cleanup actor ID");
    let result: RestrictedPingCleanupResult | null = null;
    const cleanup = this.db.transaction(() => {
      const role = this.getRoleRow(normalizedRoleId);
      if (!role) {
        result = emptyCleanupResult();
        return;
      }
      const mappingsDeleted = this.countMappings(normalizedRoleId);
      const userCooldownsDeleted = this.countUserCooldowns(normalizedRoleId);
      this.appendEventWithin({
        type: "role_deleted",
        actorId: normalizedActorId,
        roleId: normalizedRoleId,
        source:
          normalizedActorId === null
            ? "discord.roleDelete"
            : "restrictedping.cleanup-role",
        details: { mappingsDeleted, userCooldownsDeleted },
      });
      this.db
        .prepare(
          "DELETE FROM restricted_ping_roles WHERE guild_id = ? AND role_id = ?",
        )
        .run(this.guildId, normalizedRoleId);
      result = {
        rolesDeleted: 1,
        mappingsDeleted,
        userCooldownsDeleted,
        roleIds: [normalizedRoleId],
      };
    });
    cleanup.immediate();
    return requireResult<RestrictedPingCleanupResult>(
      result,
      "Restricted ping role cleanup",
    );
  }

  public cleanupDeletedChannel(
    channelId: string,
    actorId?: string,
  ): RestrictedPingCleanupResult {
    const normalizedChannelId = assertDiscordSnowflake(channelId, "channel ID");
    const normalizedActorId =
      actorId === undefined
        ? null
        : assertDiscordSnowflake(actorId, "cleanup actor ID");
    let result: RestrictedPingCleanupResult | null = null;
    const cleanup = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM restricted_ping_channels
           WHERE guild_id = ? AND channel_id = ? ORDER BY role_id`,
        )
        .all(this.guildId, normalizedChannelId) as RestrictedPingMappingRow[];
      if (rows.length === 0) {
        result = emptyCleanupResult();
        return;
      }
      const roleIds = [...new Set(rows.map((row) => row.role_id))];
      for (const roleId of roleIds) {
        this.appendEventWithin({
          type: "channel_deleted",
          actorId: normalizedActorId,
          roleId,
          channelId: normalizedChannelId,
          source:
            normalizedActorId === null
              ? "discord.channelDelete"
              : "restrictedping.cleanup-channel",
        });
      }
      const removed = this.db
        .prepare(
          `DELETE FROM restricted_ping_channels
           WHERE guild_id = ? AND channel_id = ?`,
        )
        .run(this.guildId, normalizedChannelId);
      let rolesDeleted = 0;
      let userCooldownsDeleted = 0;
      for (const roleId of roleIds) {
        if (this.countMappings(roleId) !== 0) continue;
        userCooldownsDeleted += this.countUserCooldowns(roleId);
        rolesDeleted += this.db
          .prepare(
            "DELETE FROM restricted_ping_roles WHERE guild_id = ? AND role_id = ?",
          )
          .run(this.guildId, roleId).changes;
      }
      result = {
        rolesDeleted,
        mappingsDeleted: removed.changes,
        userCooldownsDeleted,
        roleIds,
      };
    });
    cleanup.immediate();
    return requireResult<RestrictedPingCleanupResult>(
      result,
      "Restricted ping channel cleanup",
    );
  }

  public listEvents(
    limit = DEFAULT_LIST_LIMIT,
    offset = 0,
  ): RestrictedPingEvent[] {
    const boundedLimit = normalizeListLimit(limit);
    const boundedOffset = normalizeOffset(offset);
    const rows = this.db
      .prepare(
        `SELECT * FROM restricted_ping_events
         WHERE guild_id = ? ORDER BY event_number DESC LIMIT ? OFFSET ?`,
      )
      .all(
        this.guildId,
        boundedLimit,
        boundedOffset,
      ) as RestrictedPingEventRow[];
    return rows.map(parseEvent);
  }

  private getRoleRow(roleId: string): RestrictedPingRoleRow | null {
    return (
      (this.db
        .prepare(
          "SELECT * FROM restricted_ping_roles WHERE guild_id = ? AND role_id = ?",
        )
        .get(this.guildId, roleId) as RestrictedPingRoleRow | undefined) ?? null
    );
  }

  private requireRoleRow(roleId: string): RestrictedPingRoleRow {
    const row = this.getRoleRow(roleId);
    if (!row)
      throw new Error("Restricted ping role configuration was not persisted");
    return row;
  }

  private getMappingRow(
    roleId: string,
    channelId: string,
  ): RestrictedPingMappingRow | null {
    return (
      (this.db
        .prepare(
          `SELECT * FROM restricted_ping_channels
           WHERE guild_id = ? AND role_id = ? AND channel_id = ?`,
        )
        .get(this.guildId, roleId, channelId) as
        RestrictedPingMappingRow | undefined) ?? null
    );
  }

  private requireMappingRow(
    roleId: string,
    channelId: string,
  ): RestrictedPingMappingRow {
    const row = this.getMappingRow(roleId, channelId);
    if (!row)
      throw new Error("Restricted ping channel mapping was not persisted");
    return row;
  }

  private countMappings(roleId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM restricted_ping_channels
         WHERE guild_id = ? AND role_id = ?`,
      )
      .get(this.guildId, roleId) as { count: number };
    return Number(row.count);
  }

  private countUserCooldowns(roleId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM restricted_ping_user_cooldowns
         WHERE guild_id = ? AND role_id = ?`,
      )
      .get(this.guildId, roleId) as { count: number };
    return Number(row.count);
  }

  private clearReservation(roleId: string, reservationId: string): void {
    this.db
      .prepare(
        `UPDATE restricted_ping_roles
         SET reservation_id = NULL, reservation_user_id = NULL,
             reservation_channel_id = NULL, reservation_source = NULL,
             reservation_expires_at = NULL
         WHERE guild_id = ? AND role_id = ? AND reservation_id = ?`,
      )
      .run(this.guildId, roleId, reservationId);
  }

  private appendEventWithin(input: AppendEventInput): RestrictedPingEvent {
    const eventNumber = this.nextEventNumber();
    const eventId = createOpaqueStorageId();
    const actorId = normalizeNullableSnowflake(
      input.actorId ?? null,
      "actor ID",
    );
    const roleId = assertDiscordSnowflake(input.roleId, "event role ID");
    const channelId = normalizeNullableSnowflake(
      input.channelId ?? null,
      "event channel ID",
    );
    const userId = normalizeNullableSnowflake(
      input.userId ?? null,
      "event user ID",
    );
    const source = normalizeSource(input.source);
    const detailsJson = serializeDetails(input.details ?? {});
    const createdAt = utcNow();
    this.db
      .prepare(
        `INSERT INTO restricted_ping_events (
           guild_id, event_id, event_number, event_type, actor_id, role_id,
           channel_id, user_id, source, details_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.guildId,
        eventId,
        eventNumber,
        normalizeEventType(input.type),
        actorId,
        roleId,
        channelId,
        userId,
        source,
        detailsJson,
        createdAt,
      );
    return {
      guildId: this.guildId,
      eventId,
      eventNumber,
      type: input.type,
      actorId,
      roleId,
      channelId,
      userId,
      source,
      details: JSON.parse(detailsJson) as unknown,
      createdAt,
    };
  }

  private nextEventNumber(): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(event_number), 0) AS maximum
         FROM restricted_ping_events WHERE guild_id = ?`,
      )
      .get(this.guildId) as { maximum: number };
    const next = Number(row.maximum) + 1;
    if (!Number.isInteger(next) || next < 1 || next > 2_147_483_647) {
      throw new RangeError("Restricted ping event number is exhausted");
    }
    return next;
  }

  private trimSuccessfulEvents(): void {
    this.db
      .prepare(
        `DELETE FROM restricted_ping_events
         WHERE guild_id = ? AND event_type = 'ping_succeeded'
           AND event_id IN (
             SELECT event_id FROM restricted_ping_events
             WHERE guild_id = ? AND event_type = 'ping_succeeded'
             ORDER BY event_number DESC
             LIMIT -1 OFFSET ?
           )`,
      )
      .run(
        this.guildId,
        this.guildId,
        MAX_RESTRICTED_PING_SUCCESS_EVENTS_PER_GUILD,
      );
  }
}

function parseRoleConfiguration(
  row: RestrictedPingRoleRow,
): RestrictedPingRoleConfiguration {
  return {
    guildId: row.guild_id,
    roleId: row.role_id,
    enabled: Boolean(row.enabled),
    userCooldownSeconds: row.user_cooldown_seconds,
    roleCooldownSeconds: row.role_cooldown_seconds,
    allowThreads: Boolean(row.allow_threads),
    bindingsVerifiedAt: row.bindings_verified_at,
    lastRoleSuccessAt: row.last_role_success_at,
    successCount: row.success_count,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseMapping(row: RestrictedPingMappingRow): RestrictedPingMapping {
  return {
    guildId: row.guild_id,
    roleId: row.role_id,
    channelId: row.channel_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function parseEvent(row: RestrictedPingEventRow): RestrictedPingEvent {
  return {
    guildId: row.guild_id,
    eventId: row.event_id,
    eventNumber: row.event_number,
    type: normalizeEventType(row.event_type),
    actorId: row.actor_id,
    roleId: row.role_id,
    channelId: row.channel_id,
    userId: row.user_id,
    source: row.source,
    details: parseJson(row.details_json, "restricted ping event details"),
    createdAt: row.created_at,
  };
}

function normalizeUserCooldown(value: number): number {
  if (
    !Number.isInteger(value) ||
    value < MIN_USER_COOLDOWN_SECONDS ||
    value > MAX_COOLDOWN_SECONDS
  ) {
    throw new RangeError(
      `User cooldown must be between ${MIN_USER_COOLDOWN_SECONDS} and ${MAX_COOLDOWN_SECONDS} seconds`,
    );
  }
  return value;
}

function normalizeRoleCooldown(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_COOLDOWN_SECONDS) {
    throw new RangeError(
      `Role cooldown must be between 0 and ${MAX_COOLDOWN_SECONDS} seconds`,
    );
  }
  return value;
}

function normalizeBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean")
    throw new TypeError(`${label} must be a boolean`);
  return value;
}

function normalizeNullableTimestamp(
  value: unknown,
  label: string,
): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError(`${label} must be a valid timestamp or null`);
  }
  return new Date(Date.parse(value)).toISOString();
}

function normalizeNullableSnowflake(
  value: unknown,
  label: string,
): string | null {
  return value === null ? null : assertDiscordSnowflake(String(value), label);
}

function normalizeSource(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Restricted ping source must be a string");
  }
  const normalized = value.normalize("NFKC").trim();
  if (
    normalized.length < 1 ||
    normalized.length > MAX_EVENT_SOURCE_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new RangeError(
      `Restricted ping source must be 1-${MAX_EVENT_SOURCE_LENGTH} printable characters`,
    );
  }
  return normalized;
}

function normalizeOptionalReason(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Restricted ping release reason must be a string");
  }
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length < 1 || normalized.length > 1_000) {
    throw new RangeError(
      "Restricted ping release reason must be 1-1000 characters",
    );
  }
  return normalized;
}

function normalizeEventType(value: unknown): RestrictedPingEventType {
  if (!(RESTRICTED_PING_EVENT_TYPES as readonly unknown[]).includes(value)) {
    throw new TypeError("Unsupported restricted ping event type");
  }
  return value as RestrictedPingEventType;
}

function serializeDetails(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(
      "Restricted ping event details must be JSON serializable",
      {
        cause: error,
      },
    );
  }
  if (serialized === undefined) serialized = "null";
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes < 2 || bytes > MAX_EVENT_DETAILS_BYTES) {
    throw new RangeError(
      `Restricted ping event details must use 2-${MAX_EVENT_DETAILS_BYTES} UTF-8 bytes`,
    );
  }
  return serialized;
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(
      `Stored ${label} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function cooldownRetryAt(
  lastSuccessAt: string | null,
  cooldownSeconds: number,
  nowMs: number,
): string | null {
  if (lastSuccessAt === null || cooldownSeconds === 0) return null;
  const retryMs = Date.parse(lastSuccessAt) + cooldownSeconds * 1_000;
  return retryMs > nowMs ? new Date(retryMs).toISOString() : null;
}

function requireOpaqueId(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > 24 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new TypeError(`${label} must be an 8-24 character opaque token`);
  }
  return value;
}

function normalizeListLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
    throw new RangeError(`List limit must be between 1 and ${MAX_LIST_LIMIT}`);
  }
  return value;
}

function normalizeOffset(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new RangeError("List offset must be a non-negative integer");
  }
  return value;
}

function emptyCleanupResult(): RestrictedPingCleanupResult {
  return {
    rolesDeleted: 0,
    mappingsDeleted: 0,
    userCooldownsDeleted: 0,
    roleIds: [],
  };
}

function requireResult<T>(result: T | null, label: string): T {
  if (result === null) throw new Error(`${label} completed without a result`);
  return result;
}

function utcNow(): string {
  return new Date().toISOString();
}
