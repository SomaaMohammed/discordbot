import type Database from "better-sqlite3";
import {
  assertDiscordSnowflake,
  sanitizeGuildSettings,
} from "../guild-settings.js";
import {
  PANEL_PRESETS,
  TICKET_EVENT_TYPES,
  TICKET_STATES,
  type GuildDataExport,
  type GuildMetricExport,
  type GuildRecord,
  type PanelPreset,
  type PostedPanel,
  type TicketConfiguration,
  type TicketEvent,
  type TicketRecord,
  type TicketState,
} from "../types.js";
import { assertActiveMetricKey } from "./metric-keys.js";

const MAX_IMPORTED_METRICS = 50_000;

export const GUILD_DATA_COLLECTION_LIMITS = Object.freeze({
  metrics: MAX_IMPORTED_METRICS,
  postedPanels: 5_000,
  tickets: 10_000,
  ticketEvents: 100_000,
});

export interface ParsedGuildDataImport extends GuildDataExport {
  sourceFormatVersion: 2 | 3;
}

export function parseGuildDataExport(
  payload: unknown,
  guildId: string,
): ParsedGuildDataImport {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("Guild import must be an object");
  }
  const candidate = payload as {
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
  if (candidate.formatVersion !== 2 && candidate.formatVersion !== 3) {
    throw new TypeError("Guild import formatVersion must be 2 or 3");
  }
  if (
    candidate.guildId !== guildId ||
    candidate.metadata?.guildId !== guildId
  ) {
    throw new TypeError("Guild import must belong to the current guild");
  }
  const settings = sanitizeGuildSettings(candidate.settings);
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
  const tickets =
    candidate.formatVersion === 3
      ? parseImportedTickets(candidate.tickets, guildId)
      : [];
  const ticketEvents =
    candidate.formatVersion === 3
      ? parseImportedTicketEvents(candidate.ticketEvents, guildId, tickets)
      : [];
  if (
    tickets.some(({ state }) =>
      (["creating", "open", "closing"] as TicketState[]).includes(state),
    ) &&
    !ticketConfiguration
  ) {
    throw new TypeError(
      "Guild import with active tickets requires ticket configuration",
    );
  }
  return {
    sourceFormatVersion: candidate.formatVersion,
    formatVersion: 3,
    guildId,
    exportedAt: normalizeImportedTimestamp(candidate.exportedAt),
    metadata: candidate.metadata as GuildRecord,
    settings,
    metrics,
    ticketConfiguration,
    postedPanels,
    tickets,
    ticketEvents,
  };
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

function parseImportedTickets(value: unknown, guildId: string): TicketRecord[] {
  const rows = requireBoundedArray(
    value,
    GUILD_DATA_COLLECTION_LIMITS.tickets,
    "tickets",
  );
  const ids = new Set<string>();
  const numbers = new Set<number>();
  const channels = new Set<string>();
  const activeOpeners = new Set<string>();
  return rows.map((value): TicketRecord => {
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
  tickets: TicketRecord[],
): TicketEvent[] {
  const rows = requireBoundedArray(
    value,
    GUILD_DATA_COLLECTION_LIMITS.ticketEvents,
    "ticketEvents",
  );
  const ticketIds = new Set(tickets.map((ticket) => ticket.ticketId));
  const eventIds = new Set<string>();
  const eventNumbers = new Set<string>();
  return rows.map((value): TicketEvent => {
    const row = requireRecord(value, "Imported ticket event");
    assertImportedGuildId(row.guildId, guildId, "ticket event");
    const ticketId = assertOpaqueStorageId(row.ticketId, "event ticket ID");
    if (!ticketIds.has(ticketId)) {
      throw new TypeError(
        `Imported ticket event references unknown ticket ${ticketId}`,
      );
    }
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
  const configuration = imported.ticketConfiguration;
  if (configuration) {
    db.prepare(
      `INSERT INTO ticket_configurations (
         guild_id, enabled, category_id, log_channel_id, support_role_id,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      guildId,
      configuration.enabled ? 1 : 0,
      configuration.categoryId,
      configuration.logChannelId,
      configuration.supportRoleId,
      configuration.createdAt,
      configuration.updatedAt,
    );
  }

  const insertPanel = db.prepare(
    `INSERT INTO posted_panels (
       guild_id, panel_id, preset, channel_id, message_id, configuration_json,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const panel of imported.postedPanels) {
    insertPanel.run(
      guildId,
      panel.panelId,
      panel.preset,
      panel.channelId,
      panel.messageId,
      serializeImportedJson(panel.configuration, 16_000, "panel configuration"),
      panel.createdAt,
      panel.updatedAt,
    );
  }

  const insertTicket = db.prepare(
    `INSERT INTO tickets (
       guild_id, ticket_id, ticket_number, opener_id, channel_id,
       control_message_id, subject, description, state, claimed_by,
       claimed_at, closed_by, close_reason, close_log_message_id,
       close_logged_at, failure_reason, created_at, updated_at, closing_at,
       closed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const ticket of imported.tickets) {
    insertTicket.run(
      guildId,
      ticket.ticketId,
      ticket.ticketNumber,
      ticket.openerId,
      ticket.channelId,
      ticket.controlMessageId,
      ticket.subject,
      ticket.description,
      ticket.state,
      ticket.claimedBy,
      ticket.claimedAt,
      ticket.closedBy,
      ticket.closeReason,
      ticket.closeLogMessageId,
      ticket.closeLoggedAt,
      ticket.failureReason,
      ticket.createdAt,
      ticket.updatedAt,
      ticket.closingAt,
      ticket.closedAt,
    );
  }

  const insertEvent = db.prepare(
    `INSERT INTO ticket_events (
       guild_id, ticket_id, event_id, event_number, event_type, actor_id, details_json,
       created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const event of imported.ticketEvents) {
    insertEvent.run(
      guildId,
      event.ticketId,
      event.eventId,
      event.eventNumber,
      event.type,
      event.actorId,
      serializeImportedJson(event.details, 4_000, "ticket event details"),
      event.createdAt,
    );
  }
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
  if (!(PANEL_PRESETS as readonly unknown[]).includes(value)) {
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
