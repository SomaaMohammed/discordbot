import type Database from "better-sqlite3";
import {
  assertDiscordSnowflake,
  GUILD_SETTINGS_VERSION,
  sanitizeGuildSettings,
} from "../guild-settings.js";
import {
  MAX_TICKET_EVENTS_PER_TICKET,
  TICKET_EVENT_TYPES,
  TICKET_STATES,
  type GuildDataExport,
  type GuildMetricExport,
  type GuildRecord,
  type GuildSettings,
  type PanelPreset,
  type PostedPanel,
  type TicketConfiguration,
  type TicketEvent,
  type TicketRecord,
  type TicketState,
} from "../types.js";
import {
  sanitizeLegacyGuildSettingsV2,
  type LegacyGuildSettingsV2,
} from "./guild-settings-v2.js";
import { assertActiveMetricKey } from "./metric-keys.js";
import {
  emptyPhase2OperationalData,
  insertPhase2OperationalData,
  parsePhase2OperationalData,
  PHASE2_COLLECTION_LIMITS,
  upgradeLegacyV3OperationalData,
} from "./guild-data-v4.js";
import {
  emptyRestrictedPingGuildData,
  insertRestrictedPingGuildData,
  parseRestrictedPingGuildData,
  RESTRICTED_PING_COLLECTION_LIMITS,
} from "./guild-data-v5.js";
import {
  emptyPhase3GuildData,
  insertPhase3GuildData,
  parsePhase3GuildData,
  PHASE3_COLLECTION_LIMITS,
} from "./guild-data-v7.js";

const MAX_IMPORTED_METRICS = 50_000;
const LEGACY_V3_PANEL_PRESETS = [
  "help",
  "server-info",
  "resources",
  "tickets",
] as const;

export const GUILD_DATA_COLLECTION_LIMITS = Object.freeze({
  metrics: MAX_IMPORTED_METRICS,
  ...PHASE2_COLLECTION_LIMITS,
  ...RESTRICTED_PING_COLLECTION_LIMITS,
  ...PHASE3_COLLECTION_LIMITS,
});

export interface ParsedGuildDataImport extends GuildDataExport {
  sourceFormatVersion: 2 | 3 | 4 | 5 | 6 | 7;
}

type LegacyTicketRecord = Omit<TicketRecord, "departmentId">;

export function parseGuildDataExport(
  payload: unknown,
  guildId: string,
): ParsedGuildDataImport {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("Guild import must be an object");
  }
  const candidate = payload as Record<string, unknown> & {
    formatVersion?: unknown;
    guildId?: unknown;
    exportedAt?: unknown;
    metadata?: Partial<GuildRecord>;
    settings?: unknown;
    metrics?: unknown;
    ticketConfiguration?: unknown;
    postedPanels?: unknown;
    tickets?: unknown;
    ticketEvents?: unknown;
  };
  if (
    candidate.formatVersion !== 2 &&
    candidate.formatVersion !== 3 &&
    candidate.formatVersion !== 4 &&
    candidate.formatVersion !== 5 &&
    candidate.formatVersion !== 6 &&
    candidate.formatVersion !== 7
  ) {
    throw new TypeError(
      "Guild import formatVersion must be 2, 3, 4, 5, 6, or 7",
    );
  }
  if (
    candidate.guildId !== guildId ||
    candidate.metadata?.guildId !== guildId
  ) {
    throw new TypeError("Guild import must belong to the current guild");
  }
  const settings =
    candidate.formatVersion === 6 || candidate.formatVersion === 7
      ? sanitizeGuildSettings(candidate.settings)
      : upgradeLegacyExportSettings(candidate.settings);
  if (!Array.isArray(candidate.metrics)) {
    throw new TypeError("Guild import metrics must be an array");
  }
  if (candidate.metrics.length > MAX_IMPORTED_METRICS) {
    throw new RangeError(
      `Guild import metrics exceeds ${MAX_IMPORTED_METRICS} records`,
    );
  }
  const seen = new Set<string>();
  const metrics: GuildMetricExport[] = candidate.metrics.map(
    (metric: unknown) => {
      if (!metric || typeof metric !== "object") {
        throw new TypeError("Guild import contains an invalid metric");
      }
      const record = metric as Record<string, unknown>;
      const key = assertActiveMetricKey(String(record.key));
      if (seen.has(key)) {
        throw new TypeError(`Guild import contains duplicate metric ${key}`);
      }
      seen.add(key);
      const value = normalizeMetricValue(record.value as string | number);
      const updatedAt = normalizeImportedTimestamp(record.updatedAt);
      return { key, value, updatedAt };
    },
  );
  const ticketConfiguration =
    candidate.formatVersion === 3
      ? parseImportedTicketConfiguration(candidate.ticketConfiguration, guildId)
      : null;
  const postedPanels =
    candidate.formatVersion === 3
      ? parseImportedPostedPanels(candidate.postedPanels, guildId)
      : [];
  const legacyTickets =
    candidate.formatVersion === 3
      ? parseImportedTickets(candidate.tickets, guildId)
      : [];
  const ticketEvents =
    candidate.formatVersion === 3
      ? parseImportedTicketEvents(
          candidate.ticketEvents,
          guildId,
          legacyTickets,
        )
      : [];
  if (
    legacyTickets.some(({ state }) =>
      (["creating", "open", "closing"] as TicketState[]).includes(state),
    ) &&
    !ticketConfiguration
  ) {
    throw new TypeError(
      "Guild import with active tickets requires ticket configuration",
    );
  }
  const exportedAt = normalizeImportedTimestamp(candidate.exportedAt);
  const operational =
    candidate.formatVersion === 4 ||
    candidate.formatVersion === 5 ||
    candidate.formatVersion === 6 ||
    candidate.formatVersion === 7
      ? parsePhase2OperationalData(candidate, guildId)
      : candidate.formatVersion === 3
        ? upgradeLegacyV3OperationalData({
            ticketConfiguration,
            postedPanels,
            tickets: legacyTickets,
            ticketEvents,
            fallbackTimestamp: exportedAt,
          })
        : emptyPhase2OperationalData();
  const restrictedPings =
    candidate.formatVersion === 5 ||
    candidate.formatVersion === 6 ||
    candidate.formatVersion === 7
      ? parseRestrictedPingGuildData(candidate, guildId)
      : emptyRestrictedPingGuildData();
  const phase3 =
    candidate.formatVersion === 7
      ? parsePhase3GuildData(candidate, guildId)
      : emptyPhase3GuildData();
  return {
    sourceFormatVersion: candidate.formatVersion,
    formatVersion: 7,
    guildId,
    exportedAt,
    metadata: candidate.metadata as GuildRecord,
    settings,
    metrics,
    ...operational,
    ...restrictedPings,
    ...phase3,
  };
}

function upgradeLegacyExportSettings(input: unknown): GuildSettings {
  const legacy = sanitizeLegacyGuildSettingsV2(input);
  return sanitizeGuildSettings({
    version: GUILD_SETTINGS_VERSION,
    enabled: true,
    timezone: legacy.timezone,
    channels: { log: legacy.channels.log },
    invocation: {
      keyword: legacy.invocation.keyword,
      aliases: [...legacy.invocation.aliases],
    },
    limits: {
      bulkModerationTargetCap: legacy.limits.bulkModerationTargetCap,
    },
    greetings:
      legacy.greetings.length > 0
        ? legacy.greetings.map(copyLegacyGreeting)
        : [{ name: "Welcome", message: "Welcome, {user}!" }],
  });
}

function copyLegacyGreeting(
  profile: LegacyGuildSettingsV2["greetings"][number],
): { name: string; message: string } {
  return { name: profile.name, message: profile.message };
}

function parseImportedTicketConfiguration(
  value: unknown,
  guildId: string,
): TicketConfiguration | null {
  if (value === null) {
    return null;
  }
  const row = requireRecord(value, "Guild import ticketConfiguration");
  assertImportedGuildId(row.guildId, guildId, "ticket configuration");
  if (typeof row.enabled !== "boolean") {
    throw new TypeError(
      "Imported ticket configuration enabled must be boolean",
    );
  }
  return {
    guildId,
    enabled: row.enabled,
    categoryId: assertImportedSnowflake(row.categoryId, "category ID"),
    logChannelId: assertImportedSnowflake(row.logChannelId, "log channel ID"),
    supportRoleId: assertImportedSnowflake(
      row.supportRoleId,
      "support role ID",
    ),
    createdAt: normalizeImportedTimestamp(row.createdAt),
    updatedAt: normalizeImportedTimestamp(row.updatedAt),
  };
}

function parseImportedPostedPanels(
  value: unknown,
  guildId: string,
): PostedPanel[] {
  const rows = requireBoundedArray(
    value,
    GUILD_DATA_COLLECTION_LIMITS.postedPanels,
    "postedPanels",
  );
  const ids = new Set<string>();
  const placements = new Set<string>();
  const messages = new Set<string>();
  return rows.map((value): PostedPanel => {
    const row = requireRecord(value, "Imported posted panel");
    assertImportedGuildId(row.guildId, guildId, "posted panel");
    const panelId = assertOpaqueStorageId(row.panelId, "posted panel ID");
    const preset = assertPanelPreset(row.preset);
    const channelId = assertImportedSnowflake(
      row.channelId,
      "panel channel ID",
    );
    const messageId = assertImportedSnowflake(
      row.messageId,
      "panel message ID",
    );
    rejectDuplicate(ids, panelId, `posted panel ${panelId}`);
    rejectDuplicate(
      placements,
      `${preset}\u0000${channelId}`,
      `posted panel placement ${preset}/${channelId}`,
    );
    rejectDuplicate(
      messages,
      `${channelId}\u0000${messageId}`,
      `posted panel message ${channelId}/${messageId}`,
    );
    return {
      guildId,
      panelId,
      preset,
      channelId,
      messageId,
      configuration: normalizeImportedJson(
        row.configuration,
        16_000,
        "panel configuration",
      ),
      createdAt: normalizeImportedTimestamp(row.createdAt),
      updatedAt: normalizeImportedTimestamp(row.updatedAt),
    };
  });
}

function parseImportedTickets(
  value: unknown,
  guildId: string,
): LegacyTicketRecord[] {
  const rows = requireBoundedArray(
    value,
    GUILD_DATA_COLLECTION_LIMITS.tickets,
    "tickets",
  );
  const ids = new Set<string>();
  const numbers = new Set<number>();
  const channels = new Set<string>();
  const activeOpeners = new Set<string>();
  return rows.map((value): LegacyTicketRecord => {
    const row = requireRecord(value, "Imported ticket");
    assertImportedGuildId(row.guildId, guildId, "ticket");
    const ticketId = assertOpaqueStorageId(row.ticketId, "ticket ID");
    const ticketNumber = normalizeImportedTicketNumber(row.ticketNumber);
    const openerId = assertImportedSnowflake(row.openerId, "ticket opener ID");
    const channelId = normalizeNullableSnowflake(
      row.channelId,
      "ticket channel ID",
    );
    const controlMessageId = normalizeNullableSnowflake(
      row.controlMessageId,
      "ticket control message ID",
    );
    const state = assertTicketState(row.state);
    const claimedBy = normalizeNullableSnowflake(
      row.claimedBy,
      "ticket claimant ID",
    );
    const claimedAt = normalizeNullableTimestamp(row.claimedAt);
    const closedBy = normalizeNullableSnowflake(
      row.closedBy,
      "ticket closer ID",
    );
    const closeReason = normalizeNullableImportedText(
      row.closeReason,
      1,
      500,
      "ticket close reason",
    );
    const closeLogMessageId = normalizeNullableSnowflake(
      row.closeLogMessageId,
      "ticket close log message ID",
    );
    const closeLoggedAt = normalizeNullableTimestamp(row.closeLoggedAt);
    const failureReason = normalizeNullableImportedText(
      row.failureReason,
      1,
      1000,
      "ticket failure reason",
    );
    const closingAt = normalizeNullableTimestamp(row.closingAt);
    const closedAt = normalizeNullableTimestamp(row.closedAt);
    rejectDuplicate(ids, ticketId, `ticket ${ticketId}`);
    rejectDuplicate(numbers, ticketNumber, `ticket number ${ticketNumber}`);
    if (channelId !== null) {
      rejectDuplicate(channels, channelId, `ticket channel ${channelId}`);
    }
    if (["creating", "open", "closing"].includes(state)) {
      rejectDuplicate(
        activeOpeners,
        openerId,
        `active ticket opener ${openerId}`,
      );
    }
    if ((claimedBy === null) !== (claimedAt === null)) {
      throw new TypeError(
        `Imported ticket ${ticketId} has inconsistent claim data`,
      );
    }
    if (controlMessageId !== null && channelId === null) {
      throw new TypeError(
        `Imported ticket ${ticketId} has a control message without a channel`,
      );
    }
    if (!["creating", "failed"].includes(state) && channelId === null) {
      throw new TypeError(`Imported ticket ${ticketId} requires a channel`);
    }
    if ((state === "failed") !== (failureReason !== null)) {
      throw new TypeError(
        `Imported ticket ${ticketId} has inconsistent failure data`,
      );
    }
    if (["closing", "closed"].includes(state) !== (closingAt !== null)) {
      throw new TypeError(
        `Imported ticket ${ticketId} has inconsistent closing time`,
      );
    }
    if ((state === "closed") !== (closedAt !== null)) {
      throw new TypeError(
        `Imported ticket ${ticketId} has inconsistent closed time`,
      );
    }
    if (
      ["closing", "closed"].includes(state) !==
      (closedBy !== null && closeReason !== null)
    ) {
      throw new TypeError(
        `Imported ticket ${ticketId} has inconsistent closure data`,
      );
    }
    if ((closeLogMessageId === null) !== (closeLoggedAt === null)) {
      throw new TypeError(
        `Imported ticket ${ticketId} has inconsistent closure-log data`,
      );
    }
    if (closeLoggedAt !== null && !["closing", "closed"].includes(state)) {
      throw new TypeError(
        `Imported ticket ${ticketId} has a closure log outside closing state`,
      );
    }
    if (state === "closed" && closeLoggedAt === null) {
      throw new TypeError(
        `Imported closed ticket ${ticketId} has no closure-log checkpoint`,
      );
    }
    return {
      guildId,
      ticketId,
      ticketNumber,
      openerId,
      channelId,
      controlMessageId,
      subject: normalizeImportedText(row.subject, 1, 100, "ticket subject"),
      description: normalizeImportedText(
        row.description,
        1,
        2000,
        "ticket description",
      ),
      state,
      claimedBy,
      claimedAt,
      closedBy,
      closeReason,
      closeLogMessageId,
      closeLoggedAt,
      failureReason,
      createdAt: normalizeImportedTimestamp(row.createdAt),
      updatedAt: normalizeImportedTimestamp(row.updatedAt),
      closingAt,
      closedAt,
    };
  });
}

function parseImportedTicketEvents(
  value: unknown,
  guildId: string,
  tickets: LegacyTicketRecord[],
): TicketEvent[] {
  const rows = requireBoundedArray(
    value,
    GUILD_DATA_COLLECTION_LIMITS.ticketEvents,
    "ticketEvents",
  );
  const ticketIds = new Set(tickets.map((ticket) => ticket.ticketId));
  const eventIds = new Set<string>();
  const eventNumbers = new Set<string>();
  const eventCounts = new Map<string, number>();
  return rows.map((value): TicketEvent => {
    const row = requireRecord(value, "Imported ticket event");
    assertImportedGuildId(row.guildId, guildId, "ticket event");
    const ticketId = assertOpaqueStorageId(row.ticketId, "event ticket ID");
    if (!ticketIds.has(ticketId)) {
      throw new TypeError(
        `Imported ticket event references unknown ticket ${ticketId}`,
      );
    }
    const eventCount = (eventCounts.get(ticketId) ?? 0) + 1;
    if (eventCount > MAX_TICKET_EVENTS_PER_TICKET) {
      throw new RangeError(
        `An imported ticket can have at most ${MAX_TICKET_EVENTS_PER_TICKET} events`,
      );
    }
    eventCounts.set(ticketId, eventCount);
    const eventId = assertOpaqueStorageId(row.eventId, "ticket event ID");
    const eventNumber = normalizeImportedTicketNumber(row.eventNumber);
    rejectDuplicate(
      eventIds,
      `${ticketId}\u0000${eventId}`,
      `ticket event ${ticketId}/${eventId}`,
    );
    rejectDuplicate(
      eventNumbers,
      `${ticketId}\u0000${eventNumber}`,
      `ticket event number ${ticketId}/${eventNumber}`,
    );
    return {
      guildId,
      ticketId,
      eventId,
      eventNumber,
      type: assertTicketEventType(row.type),
      actorId: normalizeNullableSnowflake(row.actorId, "event actor ID"),
      details: normalizeImportedJson(
        row.details,
        4_000,
        "ticket event details",
      ),
      createdAt: normalizeImportedTimestamp(row.createdAt),
    };
  });
}

export function insertImportedOperationalData(
  db: Database.Database,
  guildId: string,
  imported: GuildDataExport,
): void {
  insertPhase2OperationalData(db, guildId, imported);
  insertRestrictedPingGuildData(db, guildId, imported);
}

export { insertPhase3GuildData };

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

function assertImportedGuildId(
  value: unknown,
  guildId: string,
  label: string,
): void {
  if (value !== guildId) {
    throw new TypeError(`Imported ${label} must belong to the current guild`);
  }
}

function assertImportedSnowflake(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a Discord snowflake`);
  }
  return assertDiscordSnowflake(value, label);
}

function normalizeNullableSnowflake(
  value: unknown,
  label: string,
): string | null {
  return value === null ? null : assertImportedSnowflake(value, label);
}

function assertOpaqueStorageId(value: unknown, label: string): string {
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

function assertPanelPreset(value: unknown): PanelPreset {
  if (!(LEGACY_V3_PANEL_PRESETS as readonly unknown[]).includes(value)) {
    throw new TypeError("Imported posted panel has an unsupported preset");
  }
  return value as PanelPreset;
}

function assertTicketState(value: unknown): TicketState {
  if (!(TICKET_STATES as readonly unknown[]).includes(value)) {
    throw new TypeError("Imported ticket has an unsupported state");
  }
  return value as TicketState;
}

function assertTicketEventType(value: unknown): TicketEvent["type"] {
  if (!(TICKET_EVENT_TYPES as readonly unknown[]).includes(value)) {
    throw new TypeError("Imported ticket event has an unsupported type");
  }
  return value as TicketEvent["type"];
}

function normalizeImportedTicketNumber(value: unknown): number {
  if (
    !Number.isInteger(value) ||
    Number(value) < 1 ||
    Number(value) > 2_147_483_647
  ) {
    throw new RangeError(
      "Imported ticket number must be a positive 32-bit integer",
    );
  }
  return Number(value);
}

function normalizeImportedText(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): string {
  if (typeof value !== "string") {
    throw new TypeError(`Imported ${label} must be text`);
  }
  const normalized = value.normalize("NFKC").trim();
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError(`Imported ${label} cannot contain control characters`);
  }
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new RangeError(
      `Imported ${label} must contain between ${minimum} and ${maximum} characters`,
    );
  }
  return normalized;
}

function normalizeNullableImportedText(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): string | null {
  return value === null
    ? null
    : normalizeImportedText(value, minimum, maximum, label);
}

function normalizeNullableTimestamp(value: unknown): string | null {
  return value === null ? null : normalizeImportedTimestamp(value);
}

function normalizeImportedJson(
  value: unknown,
  maximumBytes: number,
  label: string,
): unknown {
  return JSON.parse(
    serializeImportedJson(value, maximumBytes, label),
  ) as unknown;
}

function serializeImportedJson(
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
    serialized.length > maximumBytes ||
    Buffer.byteLength(serialized, "utf8") > maximumBytes
  ) {
    throw new RangeError(
      `Imported ${label} exceeds the ${maximumBytes}-byte limit`,
    );
  }
  return serialized;
}

function rejectDuplicate<T>(seen: Set<T>, value: T, label: string): void {
  if (seen.has(value)) {
    throw new TypeError(`Guild import contains duplicate ${label}`);
  }
  seen.add(value);
}

function normalizeMetricValue(value: unknown): number {
  const normalized = typeof value === "string" ? value.trim() : value;
  if (
    (typeof normalized === "string" && !/^(?:0|[1-9]\d*)$/.test(normalized)) ||
    (typeof normalized !== "string" && typeof normalized !== "number")
  ) {
    throw new TypeError("Metric value must be a non-negative integer");
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError("Metric value must be a non-negative safe integer");
  }
  return parsed;
}

function normalizeImportedTimestamp(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Imported timestamp must be an ISO timestamp");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError("Imported timestamp must be an ISO timestamp");
  }
  return new Date(timestamp).toISOString();
}
