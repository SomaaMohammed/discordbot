import type Database from "better-sqlite3";
import { assertDiscordSnowflake } from "../guild-settings.js";
import {
  RESTRICTED_PING_EVENT_TYPES,
  type GuildDataExport,
  type RestrictedPingEvent,
  type RestrictedPingMapping,
  type RestrictedPingRoleConfiguration,
  type RestrictedPingUserCooldown,
} from "../types.js";
import { MAX_RESTRICTED_PING_SUCCESS_EVENTS_PER_GUILD } from "./restricted-ping-repository.js";

export type RestrictedPingGuildData = Pick<
  GuildDataExport,
  | "restrictedPingRoles"
  | "restrictedPingMappings"
  | "restrictedPingUserCooldowns"
  | "restrictedPingEvents"
>;

export const RESTRICTED_PING_COLLECTION_LIMITS = Object.freeze({
  restrictedPingRoles: 1_000,
  restrictedPingMappings: 250_000,
  restrictedPingUserCooldowns: 250_000,
  restrictedPingEvents: 100_000,
} as const);

export const RESTRICTED_PING_GUILD_TABLES = [
  "restricted_ping_roles",
  "restricted_ping_channels",
  "restricted_ping_user_cooldowns",
  "restricted_ping_events",
] as const;

const MAX_SAFE_STORAGE_INTEGER = 9_007_199_254_740_991;
const MAX_EVENT_NUMBER = 2_147_483_647;
const MAX_EVENT_SOURCE_LENGTH = 100;
const MAX_EVENT_DETAILS_BYTES = 4_000;

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
  guild_id: string;
  role_id: string;
  user_id: string;
  last_success_at: string;
  success_count: number;
  updated_at: string;
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

export function emptyRestrictedPingGuildData(): RestrictedPingGuildData {
  return {
    restrictedPingRoles: [],
    restrictedPingMappings: [],
    restrictedPingUserCooldowns: [],
    restrictedPingEvents: [],
  };
}

/** Reads every restricted-ping tenant row without exporting live leases. */
export function readRestrictedPingGuildData(
  db: Database.Database,
  guildId: string,
): RestrictedPingGuildData {
  const restrictedPingRoles = db
    .prepare(
      `SELECT guild_id, role_id, enabled, user_cooldown_seconds,
              role_cooldown_seconds, allow_threads, bindings_verified_at,
              last_role_success_at, success_count, created_by, updated_by,
              created_at, updated_at
       FROM restricted_ping_roles
       WHERE guild_id = ?
       ORDER BY role_id`,
    )
    .all(guildId) as RestrictedPingRoleRow[];
  const restrictedPingMappings = db
    .prepare(
      `SELECT guild_id, role_id, channel_id, created_by, created_at
       FROM restricted_ping_channels
       WHERE guild_id = ?
       ORDER BY role_id, channel_id`,
    )
    .all(guildId) as RestrictedPingMappingRow[];
  const restrictedPingUserCooldowns = db
    .prepare(
      `SELECT guild_id, role_id, user_id, last_success_at, success_count,
              updated_at
       FROM restricted_ping_user_cooldowns
       WHERE guild_id = ?
       ORDER BY role_id, user_id`,
    )
    .all(guildId) as RestrictedPingUserCooldownRow[];
  const restrictedPingEvents = db
    .prepare(
      `SELECT guild_id, event_id, event_number, event_type, actor_id, role_id,
              channel_id, user_id, source, details_json, created_at
       FROM restricted_ping_events
       WHERE guild_id = ?
       ORDER BY event_number, event_id`,
    )
    .all(guildId) as RestrictedPingEventRow[];

  return {
    restrictedPingRoles: restrictedPingRoles.map(mapRole),
    restrictedPingMappings: restrictedPingMappings.map(mapMapping),
    restrictedPingUserCooldowns:
      restrictedPingUserCooldowns.map(mapUserCooldown),
    restrictedPingEvents: restrictedPingEvents.map(mapEvent),
  };
}

export function parseRestrictedPingGuildData(
  candidate: Record<string, unknown>,
  guildId: string,
): RestrictedPingGuildData {
  const restrictedPingRoles = parseRoles(
    candidate.restrictedPingRoles,
    guildId,
  );
  const roleIds = new Set(restrictedPingRoles.map(({ roleId }) => roleId));
  const restrictedPingMappings = parseMappings(
    candidate.restrictedPingMappings,
    guildId,
    roleIds,
  );
  const restrictedPingUserCooldowns = parseUserCooldowns(
    candidate.restrictedPingUserCooldowns,
    guildId,
    roleIds,
  );
  const restrictedPingEvents = parseEvents(
    candidate.restrictedPingEvents,
    guildId,
  );
  return {
    restrictedPingRoles,
    restrictedPingMappings,
    restrictedPingUserCooldowns,
    restrictedPingEvents,
  };
}

/** Inserts parsed restricted-ping data with every live binding fail-closed. */
export function insertRestrictedPingGuildData(
  db: Database.Database,
  guildId: string,
  imported: RestrictedPingGuildData,
): void {
  const insertRole = db.prepare(
    `INSERT INTO restricted_ping_roles (
       guild_id, role_id, enabled, user_cooldown_seconds,
       role_cooldown_seconds, allow_threads, bindings_verified_at,
       last_role_success_at, success_count, reservation_id,
       reservation_user_id, reservation_channel_id, reservation_source,
       reservation_expires_at, created_by, updated_by, created_at, updated_at
     ) VALUES (?, ?, 0, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL,
               ?, ?, ?, ?)`,
  );
  for (const role of imported.restrictedPingRoles) {
    insertRole.run(
      guildId,
      role.roleId,
      role.userCooldownSeconds,
      role.roleCooldownSeconds,
      role.allowThreads ? 1 : 0,
      role.lastRoleSuccessAt,
      role.successCount,
      role.createdBy,
      role.updatedBy,
      role.createdAt,
      role.updatedAt,
    );
  }

  const insertMapping = db.prepare(
    `INSERT INTO restricted_ping_channels (
       guild_id, role_id, channel_id, created_by, created_at
     ) VALUES (?, ?, ?, ?, ?)`,
  );
  for (const mapping of imported.restrictedPingMappings) {
    insertMapping.run(
      guildId,
      mapping.roleId,
      mapping.channelId,
      mapping.createdBy,
      mapping.createdAt,
    );
  }

  const insertUserCooldown = db.prepare(
    `INSERT INTO restricted_ping_user_cooldowns (
       guild_id, role_id, user_id, last_success_at, success_count, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const cooldown of imported.restrictedPingUserCooldowns) {
    insertUserCooldown.run(
      guildId,
      cooldown.roleId,
      cooldown.userId,
      cooldown.lastSuccessAt,
      cooldown.successCount,
      cooldown.updatedAt,
    );
  }

  const insertEvent = db.prepare(
    `INSERT INTO restricted_ping_events (
       guild_id, event_id, event_number, event_type, actor_id, role_id,
       channel_id, user_id, source, details_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const event of imported.restrictedPingEvents) {
    insertEvent.run(
      guildId,
      event.eventId,
      event.eventNumber,
      event.type,
      event.actorId,
      event.roleId,
      event.channelId,
      event.userId,
      event.source,
      serializeBoundedJson(
        event.details,
        MAX_EVENT_DETAILS_BYTES,
        "restricted ping event details",
      ),
      event.createdAt,
    );
  }
}

/** Makes preserved format-2 rows safe after any guild import. */
export function deactivateRestrictedPingBindings(
  db: Database.Database,
  guildId: string,
): void {
  db.prepare(
    `UPDATE restricted_ping_roles
     SET enabled = 0,
         bindings_verified_at = NULL,
         reservation_id = NULL,
         reservation_user_id = NULL,
         reservation_channel_id = NULL,
         reservation_source = NULL,
         reservation_expires_at = NULL
     WHERE guild_id = ?`,
  ).run(guildId);
}

function parseRoles(
  value: unknown,
  guildId: string,
): RestrictedPingRoleConfiguration[] {
  const rows = requireBoundedArray(
    value,
    RESTRICTED_PING_COLLECTION_LIMITS.restrictedPingRoles,
    "restrictedPingRoles",
  );
  const roleIds = new Set<string>();
  return rows.map((value): RestrictedPingRoleConfiguration => {
    const row = requireRecord(value, "Imported restricted ping role");
    assertImportedGuild(row.guildId, guildId, "restricted ping role");
    const roleId = requireSnowflake(row.roleId, "restricted ping role ID");
    if (roleId === guildId) {
      throw new TypeError("Imported restricted ping role cannot be @everyone");
    }
    rejectDuplicate(roleIds, roleId, `restricted ping role ${roleId}`);
    const lastRoleSuccessAt = requireNullableTimestamp(row.lastRoleSuccessAt);
    const successCount = requireInteger(
      row.successCount,
      0,
      MAX_SAFE_STORAGE_INTEGER,
      "restricted ping role success count",
    );
    if ((lastRoleSuccessAt === null) !== (successCount === 0)) {
      throw new TypeError(
        "Imported restricted ping role last success timestamp must be null exactly when its success count is zero",
      );
    }
    return {
      guildId,
      roleId,
      enabled: requireBoolean(row.enabled, "restricted ping role enabled"),
      userCooldownSeconds: requireInteger(
        row.userCooldownSeconds,
        1,
        86_400,
        "restricted ping user cooldown",
      ),
      roleCooldownSeconds: requireInteger(
        row.roleCooldownSeconds,
        0,
        86_400,
        "restricted ping role cooldown",
      ),
      allowThreads: requireBoolean(
        row.allowThreads,
        "restricted ping thread setting",
      ),
      bindingsVerifiedAt: requireNullableTimestamp(row.bindingsVerifiedAt),
      lastRoleSuccessAt,
      successCount,
      createdBy: requireSnowflake(
        row.createdBy,
        "restricted ping role creator ID",
      ),
      updatedBy: requireSnowflake(
        row.updatedBy,
        "restricted ping role updater ID",
      ),
      createdAt: requireTimestamp(row.createdAt),
      updatedAt: requireTimestamp(row.updatedAt),
    };
  });
}

function parseMappings(
  value: unknown,
  guildId: string,
  roleIds: ReadonlySet<string>,
): RestrictedPingMapping[] {
  const rows = requireBoundedArray(
    value,
    RESTRICTED_PING_COLLECTION_LIMITS.restrictedPingMappings,
    "restrictedPingMappings",
  );
  const keys = new Set<string>();
  return rows.map((value): RestrictedPingMapping => {
    const row = requireRecord(value, "Imported restricted ping mapping");
    assertImportedGuild(row.guildId, guildId, "restricted ping mapping");
    const roleId = requireSnowflake(row.roleId, "restricted ping role ID");
    const channelId = requireSnowflake(
      row.channelId,
      "restricted ping channel ID",
    );
    if (!roleIds.has(roleId)) {
      throw new TypeError(
        `Imported restricted ping mapping references unknown role ${roleId}`,
      );
    }
    rejectDuplicate(
      keys,
      `${roleId}\u0000${channelId}`,
      `restricted ping mapping ${roleId}/${channelId}`,
    );
    return {
      guildId,
      roleId,
      channelId,
      createdBy: requireSnowflake(
        row.createdBy,
        "restricted ping mapping creator ID",
      ),
      createdAt: requireTimestamp(row.createdAt),
    };
  });
}

function validateEventShape(event: RestrictedPingEvent): void {
  if (
    (event.type === "mapping_added" || event.type === "mapping_removed") &&
    (event.actorId === null || event.channelId === null)
  ) {
    throw new TypeError(
      `Imported restricted ping ${event.type} event requires actor and channel IDs`,
    );
  }
  if (
    (event.type === "configuration_updated" ||
      event.type === "enabled" ||
      event.type === "disabled") &&
    event.actorId === null
  ) {
    throw new TypeError(
      `Imported restricted ping ${event.type} event requires an actor ID`,
    );
  }
  if (event.type === "channel_deleted" && event.channelId === null) {
    throw new TypeError(
      "Imported restricted ping channel_deleted event requires a channel ID",
    );
  }
  if (
    event.type === "ping_succeeded" &&
    (event.actorId === null ||
      event.userId === null ||
      event.channelId === null ||
      event.actorId !== event.userId)
  ) {
    throw new TypeError(
      "Imported restricted ping ping_succeeded event requires matching actor/user IDs and a channel ID",
    );
  }
}

function parseUserCooldowns(
  value: unknown,
  guildId: string,
  roleIds: ReadonlySet<string>,
): RestrictedPingUserCooldown[] {
  const rows = requireBoundedArray(
    value,
    RESTRICTED_PING_COLLECTION_LIMITS.restrictedPingUserCooldowns,
    "restrictedPingUserCooldowns",
  );
  const keys = new Set<string>();
  return rows.map((value): RestrictedPingUserCooldown => {
    const row = requireRecord(value, "Imported restricted ping user cooldown");
    assertImportedGuild(row.guildId, guildId, "restricted ping user cooldown");
    const roleId = requireSnowflake(row.roleId, "restricted ping role ID");
    const userId = requireSnowflake(row.userId, "restricted ping user ID");
    if (!roleIds.has(roleId)) {
      throw new TypeError(
        `Imported restricted ping user cooldown references unknown role ${roleId}`,
      );
    }
    rejectDuplicate(
      keys,
      `${roleId}\u0000${userId}`,
      `restricted ping user cooldown ${roleId}/${userId}`,
    );
    return {
      guildId,
      roleId,
      userId,
      lastSuccessAt: requireTimestamp(row.lastSuccessAt),
      successCount: requireInteger(
        row.successCount,
        1,
        MAX_SAFE_STORAGE_INTEGER,
        "restricted ping user success count",
      ),
      updatedAt: requireTimestamp(row.updatedAt),
    };
  });
}

function parseEvents(value: unknown, guildId: string): RestrictedPingEvent[] {
  const rows = requireBoundedArray(
    value,
    RESTRICTED_PING_COLLECTION_LIMITS.restrictedPingEvents,
    "restrictedPingEvents",
  );
  const ids = new Set<string>();
  const numbers = new Set<number>();
  let successfulEventCount = 0;
  return rows.map((value): RestrictedPingEvent => {
    const row = requireRecord(value, "Imported restricted ping event");
    assertImportedGuild(row.guildId, guildId, "restricted ping event");
    const eventId = requireOpaqueId(row.eventId, "restricted ping event ID");
    const eventNumber = requireInteger(
      row.eventNumber,
      1,
      MAX_EVENT_NUMBER,
      "restricted ping event number",
    );
    rejectDuplicate(ids, eventId, `restricted ping event ID ${eventId}`);
    rejectDuplicate(
      numbers,
      eventNumber,
      `restricted ping event number ${eventNumber}`,
    );
    const event: RestrictedPingEvent = {
      guildId,
      eventId,
      eventNumber,
      type: requireEnum(
        row.type,
        RESTRICTED_PING_EVENT_TYPES,
        "restricted ping event type",
      ),
      actorId: requireNullableSnowflake(
        row.actorId,
        "restricted ping event actor ID",
      ),
      roleId: requireSnowflake(row.roleId, "restricted ping event role ID"),
      channelId: requireNullableSnowflake(
        row.channelId,
        "restricted ping event channel ID",
      ),
      userId: requireNullableSnowflake(
        row.userId,
        "restricted ping event user ID",
      ),
      source: requireText(
        row.source,
        1,
        MAX_EVENT_SOURCE_LENGTH,
        "restricted ping event source",
      ),
      details: parseBoundedJson(
        row.details,
        MAX_EVENT_DETAILS_BYTES,
        "restricted ping event details",
      ),
      createdAt: requireTimestamp(row.createdAt),
    };
    validateEventShape(event);
    if (event.type === "ping_succeeded") {
      successfulEventCount += 1;
      if (successfulEventCount > MAX_RESTRICTED_PING_SUCCESS_EVENTS_PER_GUILD) {
        throw new RangeError(
          `Imported restricted ping events may contain at most ${MAX_RESTRICTED_PING_SUCCESS_EVENTS_PER_GUILD} successful pings`,
        );
      }
    }
    return event;
  });
}

function mapRole(row: RestrictedPingRoleRow): RestrictedPingRoleConfiguration {
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

function mapMapping(row: RestrictedPingMappingRow): RestrictedPingMapping {
  return {
    guildId: row.guild_id,
    roleId: row.role_id,
    channelId: row.channel_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function mapUserCooldown(
  row: RestrictedPingUserCooldownRow,
): RestrictedPingUserCooldown {
  return {
    guildId: row.guild_id,
    roleId: row.role_id,
    userId: row.user_id,
    lastSuccessAt: row.last_success_at,
    successCount: row.success_count,
    updatedAt: row.updated_at,
  };
}

function mapEvent(row: RestrictedPingEventRow): RestrictedPingEvent {
  return {
    guildId: row.guild_id,
    eventId: row.event_id,
    eventNumber: row.event_number,
    type: requireEnum(
      row.event_type,
      RESTRICTED_PING_EVENT_TYPES,
      "stored restricted ping event type",
    ),
    actorId: row.actor_id,
    roleId: row.role_id,
    channelId: row.channel_id,
    userId: row.user_id,
    source: row.source,
    details: parseStoredJson(row.details_json, "restricted ping event details"),
    createdAt: row.created_at,
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireBoundedArray(
  value: unknown,
  maximum: number,
  label: string,
): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`Guild import ${label} must be an array`);
  }
  if (value.length > maximum) {
    throw new RangeError(`Guild import ${label} exceeds ${maximum} records`);
  }
  return value;
}

function assertImportedGuild(
  value: unknown,
  guildId: string,
  label: string,
): void {
  if (value !== guildId) {
    throw new TypeError(`Imported ${label} must belong to the current guild`);
  }
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`Imported ${label} must be boolean`);
  }
  return value;
}

function requireSnowflake(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`Imported ${label} must be a Discord snowflake`);
  }
  return assertDiscordSnowflake(value, label);
}

function requireNullableSnowflake(
  value: unknown,
  label: string,
): string | null {
  return value === null ? null : requireSnowflake(value, label);
}

function requireOpaqueId(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > 24 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new TypeError(
      `Imported ${label} must be an 8-24 character opaque token`,
    );
  }
  return value;
}

function requireText(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): string {
  if (typeof value !== "string") {
    throw new TypeError(`Imported ${label} must be text`);
  }
  const normalized = value.normalize("NFKC").trim();
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError(`Imported ${label} cannot contain control characters`);
  }
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new RangeError(
      `Imported ${label} must contain between ${minimum} and ${maximum} characters`,
    );
  }
  return normalized;
}

function requireInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    !Number.isInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    throw new RangeError(
      `Imported ${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return Number(value);
}

function requireTimestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError("Imported timestamp must be an ISO timestamp");
  }
  return new Date(Date.parse(value)).toISOString();
}

function requireNullableTimestamp(value: unknown): string | null {
  return value === null ? null : requireTimestamp(value);
}

function requireEnum<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string,
): T[number] {
  if (!(values as readonly unknown[]).includes(value)) {
    throw new TypeError(`Imported ${label} is unsupported`);
  }
  return value as T[number];
}

function parseBoundedJson(
  value: unknown,
  maximumBytes: number,
  label: string,
): unknown {
  return JSON.parse(
    serializeBoundedJson(value, maximumBytes, label),
  ) as unknown;
}

function serializeBoundedJson(
  value: unknown,
  maximumBytes: number,
  label: string,
): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(
      `Imported ${label} must be JSON-safe: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    serialized === undefined ||
    serialized.length < 2 ||
    Buffer.byteLength(serialized, "utf8") > maximumBytes
  ) {
    throw new RangeError(
      `Imported ${label} exceeds the ${maximumBytes}-byte limit`,
    );
  }
  return serialized;
}

function parseStoredJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(
      `Stored ${label} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function rejectDuplicate<T>(seen: Set<T>, value: T, label: string): void {
  if (seen.has(value)) {
    throw new TypeError(`Guild import contains duplicate ${label}`);
  }
  seen.add(value);
}
