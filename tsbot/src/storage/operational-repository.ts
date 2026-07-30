import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { assertDiscordSnowflake } from "../guild-settings.js";
import {
  PANEL_PRESETS,
  TICKET_EVENT_TYPES,
  TICKET_STATES,
  type PanelPreset,
  type PostedPanel,
  type PostedPanelInput,
  type TicketActivationInput,
  type TicketActivationResult,
  type TicketClaimResult,
  type TicketCloseFinishResult,
  type TicketCloseLogResult,
  type TicketCloseRollbackResult,
  type TicketCloseStartResult,
  type TicketConfiguration,
  type TicketConfigurationInput,
  type TicketCreationFailureResult,
  type TicketCreationInput,
  type TicketEvent,
  type TicketEventInput,
  type TicketEventType,
  type TicketRebindInput,
  type TicketRebindResult,
  type TicketRecord,
  type TicketReleaseResult,
  type TicketReservationResult,
  type TicketState,
} from "../types.js";

interface TicketConfigurationRow {
  guild_id: string;
  enabled: number;
  category_id: string;
  log_channel_id: string;
  support_role_id: string;
  created_at: string;
  updated_at: string;
}

interface PostedPanelRow {
  guild_id: string;
  panel_id: string;
  preset: string;
  channel_id: string;
  message_id: string;
  configuration_json: string;
  created_at: string;
  updated_at: string;
}

interface TicketRow {
  guild_id: string;
  ticket_id: string;
  ticket_number: number;
  opener_id: string;
  channel_id: string | null;
  control_message_id: string | null;
  subject: string;
  description: string;
  state: string;
  claimed_by: string | null;
  claimed_at: string | null;
  closed_by: string | null;
  close_reason: string | null;
  close_log_message_id: string | null;
  close_logged_at: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
  closing_at: string | null;
  closed_at: string | null;
}

interface TicketEventRow {
  guild_id: string;
  ticket_id: string;
  event_id: string;
  event_number: number;
  event_type: string;
  actor_id: string | null;
  details_json: string;
  created_at: string;
}

/**
 * Synchronous, tenant-bound persistence for panels and tickets. Authorization
 * remains a Discord-layer concern; every query here includes the bound guild.
 */
export class GuildOperationalRepository {
  public constructor(
    private readonly db: Database.Database,
    public readonly guildId: string,
  ) {}

  public getTicketConfiguration(): TicketConfiguration | null {
    const row = this.db
      .prepare("SELECT * FROM ticket_configurations WHERE guild_id = ?")
      .get(this.guildId) as TicketConfigurationRow | undefined;
    return row ? parseTicketConfigurationRow(row) : null;
  }

  public upsertTicketConfiguration(
    input: TicketConfigurationInput,
  ): TicketConfiguration {
    const categoryId = assertDiscordSnowflake(input.categoryId, "category ID");
    const logChannelId = assertDiscordSnowflake(
      input.logChannelId,
      "log channel ID",
    );
    const supportRoleId = assertDiscordSnowflake(
      input.supportRoleId,
      "support role ID",
    );
    const enabled = input.enabled ?? true;
    if (typeof enabled !== "boolean") {
      throw new TypeError("Ticket configuration enabled must be a boolean");
    }
    const now = utcNow();
    this.db
      .prepare(
        `INSERT INTO ticket_configurations (
           guild_id, enabled, category_id, log_channel_id, support_role_id,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(guild_id) DO UPDATE SET
           enabled = excluded.enabled,
           category_id = excluded.category_id,
           log_channel_id = excluded.log_channel_id,
           support_role_id = excluded.support_role_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        this.guildId,
        enabled ? 1 : 0,
        categoryId,
        logChannelId,
        supportRoleId,
        now,
        now,
      );
    return this.requireTicketConfiguration();
  }

  public disableTicketConfiguration(): TicketConfiguration | null {
    const current = this.getTicketConfiguration();
    if (!current || !current.enabled) {
      return current;
    }
    this.db
      .prepare(
        `UPDATE ticket_configurations
         SET enabled = 0, updated_at = ?
         WHERE guild_id = ? AND enabled = 1`,
      )
      .run(utcNow(), this.guildId);
    return this.requireTicketConfiguration();
  }

  public createPostedPanel(input: PostedPanelInput): PostedPanel {
    const normalized = normalizePostedPanelInput(input);
    if (normalized.panelId) {
      this.insertPostedPanel(normalized.panelId, normalized);
      return this.requirePostedPanel(normalized.panelId);
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const panelId = opaqueId();
      if (this.findPostedPanelByToken(panelId)) {
        continue;
      }
      this.insertPostedPanel(panelId, normalized);
      return this.requirePostedPanel(panelId);
    }
    throw new Error("Unable to allocate a unique posted-panel ID");
  }

  public upsertPostedPanel(input: PostedPanelInput): PostedPanel {
    const normalized = normalizePostedPanelInput(input);
    let result: PostedPanel | null = null;
    const upsert = this.db.transaction(() => {
      const existing = this.findPostedPanelByPresetAndChannel(
        normalized.preset,
        normalized.channelId,
      );
      if (!existing) {
        result = this.createPostedPanel(input);
        return;
      }
      this.db
        .prepare(
          `UPDATE posted_panels
           SET panel_id = ?, message_id = ?, configuration_json = ?, updated_at = ?
           WHERE guild_id = ? AND panel_id = ?`,
        )
        .run(
          normalized.panelId ?? existing.panelId,
          normalized.messageId,
          normalized.configurationJson,
          utcNow(),
          this.guildId,
          existing.panelId,
        );
      result = this.requirePostedPanel(normalized.panelId ?? existing.panelId);
    });
    upsert.immediate();
    return requireTransitionResult<PostedPanel>(result);
  }

  public listPostedPanels(preset?: PanelPreset): PostedPanel[] {
    if (preset === undefined) {
      return (
        this.db
          .prepare(
            `SELECT * FROM posted_panels
             WHERE guild_id = ? ORDER BY preset, channel_id, panel_id`,
          )
          .all(this.guildId) as PostedPanelRow[]
      ).map(parsePostedPanelRow);
    }
    const normalized = normalizePanelPreset(preset);
    return (
      this.db
        .prepare(
          `SELECT * FROM posted_panels
           WHERE guild_id = ? AND preset = ? ORDER BY channel_id, panel_id`,
        )
        .all(this.guildId, normalized) as PostedPanelRow[]
    ).map(parsePostedPanelRow);
  }

  public findPostedPanelByToken(panelId: string): PostedPanel | null {
    if (!isOpaqueId(panelId)) {
      return null;
    }
    const row = this.db
      .prepare(
        "SELECT * FROM posted_panels WHERE guild_id = ? AND panel_id = ?",
      )
      .get(this.guildId, panelId) as PostedPanelRow | undefined;
    return row ? parsePostedPanelRow(row) : null;
  }

  public findPostedPanelByPresetAndChannel(
    preset: PanelPreset,
    channelId: string,
  ): PostedPanel | null {
    const normalizedPreset = normalizePanelPreset(preset);
    const normalizedChannel = assertDiscordSnowflake(channelId, "channel ID");
    const row = this.db
      .prepare(
        `SELECT * FROM posted_panels
         WHERE guild_id = ? AND preset = ? AND channel_id = ?`,
      )
      .get(this.guildId, normalizedPreset, normalizedChannel) as
      PostedPanelRow | undefined;
    return row ? parsePostedPanelRow(row) : null;
  }

  public deletePostedPanel(panelId: string): boolean {
    if (!isOpaqueId(panelId)) {
      return false;
    }
    return (
      this.db
        .prepare(
          "DELETE FROM posted_panels WHERE guild_id = ? AND panel_id = ?",
        )
        .run(this.guildId, panelId).changes === 1
    );
  }

  public reserveTicketCreation(
    input: TicketCreationInput,
  ): TicketReservationResult {
    const openerId = assertDiscordSnowflake(input.openerId, "opener ID");
    const subject = normalizeText(input.subject, 1, 100, "Ticket subject");
    const description = normalizeText(
      input.description,
      1,
      2000,
      "Ticket description",
    );
    let result: TicketReservationResult | null = null;
    const reserve = this.db.transaction(() => {
      const existing = this.getTicketByOpener(openerId);
      if (existing) {
        result = { status: "existing", ticket: existing };
        return;
      }
      const numberRow = this.db
        .prepare(
          `SELECT COALESCE(MAX(ticket_number), 0) + 1 AS ticket_number
           FROM tickets WHERE guild_id = ?`,
        )
        .get(this.guildId) as { ticket_number: number };
      const ticketNumber = Number(numberRow.ticket_number);
      if (
        !Number.isInteger(ticketNumber) ||
        ticketNumber < 1 ||
        ticketNumber > 2_147_483_647
      ) {
        throw new RangeError("The per-guild ticket number range is exhausted");
      }
      const now = utcNow();
      const ticketId = this.allocateTicketId();
      this.db
        .prepare(
          `INSERT INTO tickets (
             guild_id, ticket_id, ticket_number, opener_id, channel_id,
             control_message_id, subject, description, state, claimed_by,
             claimed_at, closed_by, close_reason, close_log_message_id,
             close_logged_at, failure_reason, created_at, updated_at,
             closing_at, closed_at
           ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, 'creating', NULL, NULL,
             NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL)`,
        )
        .run(
          this.guildId,
          ticketId,
          ticketNumber,
          openerId,
          subject,
          description,
          now,
          now,
        );
      this.appendTicketEventWithin(ticketId, {
        type: "creation_reserved",
        actorId: openerId,
        details: { ticketNumber },
      });
      result = { status: "created", ticket: this.requireTicket(ticketId) };
    });
    reserve.immediate();
    if (!result) {
      throw new Error("Ticket reservation completed without a result");
    }
    return result;
  }

  public activateTicketCreation(
    ticketId: string,
    input: TicketActivationInput,
  ): TicketActivationResult {
    const normalizedTicketId = normalizeOpaqueId(ticketId);
    if (!normalizedTicketId) {
      return { status: "not-found", ticket: null };
    }
    const channelId = assertDiscordSnowflake(input.channelId, "channel ID");
    const controlMessageId =
      input.controlMessageId === undefined || input.controlMessageId === null
        ? null
        : assertDiscordSnowflake(input.controlMessageId, "control message ID");
    let result: TicketActivationResult | null = null;
    const activate = this.db.transaction(() => {
      const ticket = this.getTicketById(normalizedTicketId);
      if (!ticket) {
        result = { status: "not-found", ticket: null };
        return;
      }
      if (
        ticket.state === "open" &&
        ticket.channelId === channelId &&
        ticket.controlMessageId === controlMessageId
      ) {
        result = { status: "already-active", ticket };
        return;
      }
      if (ticket.state !== "creating") {
        result = { status: "unavailable", ticket };
        return;
      }
      const now = utcNow();
      this.db
        .prepare(
          `UPDATE tickets
           SET state = 'open', channel_id = ?, control_message_id = ?,
               updated_at = ?
           WHERE guild_id = ? AND ticket_id = ? AND state = 'creating'`,
        )
        .run(
          channelId,
          controlMessageId,
          now,
          this.guildId,
          normalizedTicketId,
        );
      this.appendTicketEventWithin(normalizedTicketId, {
        type: "creation_activated",
        actorId: ticket.openerId,
        details: { channelId, controlMessageId },
      });
      result = {
        status: "activated",
        ticket: this.requireTicket(normalizedTicketId),
      };
    });
    activate.immediate();
    return requireTransitionResult<TicketActivationResult>(result);
  }

  public failTicketCreation(
    ticketId: string,
    reason: string,
  ): TicketCreationFailureResult {
    const normalizedTicketId = normalizeOpaqueId(ticketId);
    if (!normalizedTicketId) {
      return { status: "not-found", ticket: null };
    }
    const failureReason = normalizeText(
      reason,
      1,
      1000,
      "Ticket creation failure reason",
    );
    let result: TicketCreationFailureResult | null = null;
    const fail = this.db.transaction(() => {
      const ticket = this.getTicketById(normalizedTicketId);
      if (!ticket) {
        result = { status: "not-found", ticket: null };
        return;
      }
      if (ticket.state === "failed") {
        result = { status: "already-failed", ticket };
        return;
      }
      const canRollbackActivation =
        ticket.state === "open" && ticket.controlMessageId === null;
      if (ticket.state !== "creating" && !canRollbackActivation) {
        result = { status: "unavailable", ticket };
        return;
      }
      this.db
        .prepare(
          `UPDATE tickets
           SET state = 'failed', channel_id = NULL, control_message_id = NULL,
               failure_reason = ?, updated_at = ?
           WHERE guild_id = ? AND ticket_id = ?
             AND (state = 'creating' OR (state = 'open' AND control_message_id IS NULL))`,
        )
        .run(failureReason, utcNow(), this.guildId, normalizedTicketId);
      this.appendTicketEventWithin(normalizedTicketId, {
        type: "creation_failed",
        actorId: ticket.openerId,
        details: { reason: failureReason },
      });
      result = {
        status: "failed",
        ticket: this.requireTicket(normalizedTicketId),
      };
    });
    fail.immediate();
    return requireTransitionResult<TicketCreationFailureResult>(result);
  }

  public getTicketById(ticketId: string): TicketRecord | null {
    if (!isOpaqueId(ticketId)) {
      return null;
    }
    const row = this.db
      .prepare("SELECT * FROM tickets WHERE guild_id = ? AND ticket_id = ?")
      .get(this.guildId, ticketId) as TicketRow | undefined;
    return row ? parseTicketRow(row) : null;
  }

  public getTicketByNumber(ticketNumber: number): TicketRecord | null {
    const normalized = normalizeTicketNumber(ticketNumber);
    const row = this.db
      .prepare("SELECT * FROM tickets WHERE guild_id = ? AND ticket_number = ?")
      .get(this.guildId, normalized) as TicketRow | undefined;
    return row ? parseTicketRow(row) : null;
  }

  public getTicketByChannel(channelId: string): TicketRecord | null {
    const normalized = assertDiscordSnowflake(channelId, "channel ID");
    const row = this.db
      .prepare("SELECT * FROM tickets WHERE guild_id = ? AND channel_id = ?")
      .get(this.guildId, normalized) as TicketRow | undefined;
    return row ? parseTicketRow(row) : null;
  }

  public getTicketByOpener(openerId: string): TicketRecord | null {
    const normalized = assertDiscordSnowflake(openerId, "opener ID");
    const row = this.db
      .prepare(
        `SELECT * FROM tickets
         WHERE guild_id = ? AND opener_id = ?
           AND state IN ('creating', 'open', 'closing')`,
      )
      .get(this.guildId, normalized) as TicketRow | undefined;
    return row ? parseTicketRow(row) : null;
  }

  public listTickets(states?: readonly TicketState[]): TicketRecord[] {
    if (states === undefined) {
      return (
        this.db
          .prepare(
            `SELECT * FROM tickets
             WHERE guild_id = ? ORDER BY ticket_number DESC`,
          )
          .all(this.guildId) as TicketRow[]
      ).map(parseTicketRow);
    }
    const normalizedStates = normalizeTicketStates(states);
    if (normalizedStates.length === 0) {
      return [];
    }
    const placeholders = normalizedStates.map(() => "?").join(", ");
    return (
      this.db
        .prepare(
          `SELECT * FROM tickets
           WHERE guild_id = ? AND state IN (${placeholders})
           ORDER BY ticket_number DESC`,
        )
        .all(this.guildId, ...normalizedStates) as TicketRow[]
    ).map(parseTicketRow);
  }

  public claimTicket(ticketId: string, staffUserId: string): TicketClaimResult {
    const normalizedTicketId = normalizeOpaqueId(ticketId);
    if (!normalizedTicketId) {
      return { status: "not-found", ticket: null };
    }
    const actorId = assertDiscordSnowflake(staffUserId, "staff user ID");
    let result: TicketClaimResult | null = null;
    const claim = this.db.transaction(() => {
      const ticket = this.getTicketById(normalizedTicketId);
      if (!ticket) {
        result = { status: "not-found", ticket: null };
        return;
      }
      if (ticket.state !== "open") {
        result = { status: "unavailable", ticket };
        return;
      }
      if (ticket.claimedBy === actorId) {
        result = { status: "already-claimed", ticket };
        return;
      }
      if (ticket.claimedBy !== null) {
        result = { status: "conflict", ticket };
        return;
      }
      const now = utcNow();
      const changed = this.db
        .prepare(
          `UPDATE tickets
           SET claimed_by = ?, claimed_at = ?, updated_at = ?
           WHERE guild_id = ? AND ticket_id = ?
             AND state = 'open' AND claimed_by IS NULL`,
        )
        .run(actorId, now, now, this.guildId, normalizedTicketId).changes;
      if (changed !== 1) {
        const latest = this.requireTicket(normalizedTicketId);
        result = {
          status: latest.claimedBy === actorId ? "already-claimed" : "conflict",
          ticket: latest,
        };
        return;
      }
      this.appendTicketEventWithin(normalizedTicketId, {
        type: "claimed",
        actorId,
      });
      result = {
        status: "claimed",
        ticket: this.requireTicket(normalizedTicketId),
      };
    });
    claim.immediate();
    return requireTransitionResult<TicketClaimResult>(result);
  }

  public releaseTicket(
    ticketId: string,
    staffUserId: string,
  ): TicketReleaseResult {
    const normalizedTicketId = normalizeOpaqueId(ticketId);
    if (!normalizedTicketId) {
      return { status: "not-found", ticket: null };
    }
    const actorId = assertDiscordSnowflake(staffUserId, "staff user ID");
    let result: TicketReleaseResult | null = null;
    const release = this.db.transaction(() => {
      const ticket = this.getTicketById(normalizedTicketId);
      if (!ticket) {
        result = { status: "not-found", ticket: null };
        return;
      }
      if (ticket.state !== "open") {
        result = { status: "unavailable", ticket };
        return;
      }
      if (ticket.claimedBy === null) {
        result = { status: "already-released", ticket };
        return;
      }
      this.db
        .prepare(
          `UPDATE tickets
           SET claimed_by = NULL, claimed_at = NULL, updated_at = ?
           WHERE guild_id = ? AND ticket_id = ? AND state = 'open'`,
        )
        .run(utcNow(), this.guildId, normalizedTicketId);
      this.appendTicketEventWithin(normalizedTicketId, {
        type: "released",
        actorId,
        details: { previousClaimedBy: ticket.claimedBy },
      });
      result = {
        status: "released",
        ticket: this.requireTicket(normalizedTicketId),
      };
    });
    release.immediate();
    return requireTransitionResult<TicketReleaseResult>(result);
  }

  public beginTicketClose(
    ticketId: string,
    staffUserId: string,
    reason: string,
  ): TicketCloseStartResult {
    const normalizedTicketId = normalizeOpaqueId(ticketId);
    if (!normalizedTicketId) {
      return { status: "not-found", ticket: null };
    }
    const actorId = assertDiscordSnowflake(staffUserId, "staff user ID");
    const closeReason = normalizeText(reason, 1, 500, "Ticket close reason");
    let result: TicketCloseStartResult | null = null;
    const begin = this.db.transaction(() => {
      const ticket = this.getTicketById(normalizedTicketId);
      if (!ticket) {
        result = { status: "not-found", ticket: null };
        return;
      }
      if (ticket.state === "closing") {
        result = { status: "already-closing", ticket };
        return;
      }
      if (ticket.state === "closed") {
        result = { status: "already-closed", ticket };
        return;
      }
      if (ticket.state !== "open") {
        result = { status: "unavailable", ticket };
        return;
      }
      const now = utcNow();
      this.db
        .prepare(
          `UPDATE tickets
           SET state = 'closing', closed_by = ?, close_reason = ?,
               close_log_message_id = NULL, close_logged_at = NULL,
               closing_at = ?, updated_at = ?
           WHERE guild_id = ? AND ticket_id = ? AND state = 'open'`,
        )
        .run(actorId, closeReason, now, now, this.guildId, normalizedTicketId);
      this.appendTicketEventWithin(normalizedTicketId, {
        type: "close_started",
        actorId,
        details: { reason: closeReason },
      });
      result = {
        status: "started",
        ticket: this.requireTicket(normalizedTicketId),
      };
    });
    begin.immediate();
    return requireTransitionResult<TicketCloseStartResult>(result);
  }

  public reopenAfterCloseFailure(
    ticketId: string,
    failureReason: string,
  ): TicketCloseRollbackResult {
    const normalizedTicketId = normalizeOpaqueId(ticketId);
    if (!normalizedTicketId) {
      return { status: "not-found", ticket: null };
    }
    const reason = normalizeText(
      failureReason,
      1,
      1000,
      "Ticket close failure reason",
    );
    let result: TicketCloseRollbackResult | null = null;
    const reopen = this.db.transaction(() => {
      const ticket = this.getTicketById(normalizedTicketId);
      if (!ticket) {
        result = { status: "not-found", ticket: null };
        return;
      }
      if (ticket.state === "open") {
        result = { status: "already-open", ticket };
        return;
      }
      if (ticket.state !== "closing") {
        result = { status: "unavailable", ticket };
        return;
      }
      if (ticket.closeLoggedAt !== null) {
        result = { status: "unavailable", ticket };
        return;
      }
      const previousClosedBy = ticket.closedBy;
      this.db
        .prepare(
          `UPDATE tickets
           SET state = 'open', closed_by = NULL, close_reason = NULL,
               close_log_message_id = NULL, close_logged_at = NULL,
               closing_at = NULL, updated_at = ?
           WHERE guild_id = ? AND ticket_id = ? AND state = 'closing'`,
        )
        .run(utcNow(), this.guildId, normalizedTicketId);
      this.appendTicketEventWithin(normalizedTicketId, {
        type: "close_failed",
        actorId: previousClosedBy,
        details: { reason },
      });
      result = {
        status: "reopened",
        ticket: this.requireTicket(normalizedTicketId),
      };
    });
    reopen.immediate();
    return requireTransitionResult<TicketCloseRollbackResult>(result);
  }

  public finishTicketClose(ticketId: string): TicketCloseFinishResult {
    const normalizedTicketId = normalizeOpaqueId(ticketId);
    if (!normalizedTicketId) {
      return { status: "not-found", ticket: null };
    }
    let result: TicketCloseFinishResult | null = null;
    const finish = this.db.transaction(() => {
      const ticket = this.getTicketById(normalizedTicketId);
      if (!ticket) {
        result = { status: "not-found", ticket: null };
        return;
      }
      if (ticket.state === "closed") {
        result = { status: "already-closed", ticket };
        return;
      }
      if (ticket.state !== "closing") {
        result = { status: "unavailable", ticket };
        return;
      }
      if (ticket.closeLoggedAt === null || ticket.closeLogMessageId === null) {
        result = { status: "unavailable", ticket };
        return;
      }
      const now = utcNow();
      this.db
        .prepare(
          `UPDATE tickets
           SET state = 'closed', closed_at = ?, updated_at = ?
           WHERE guild_id = ? AND ticket_id = ? AND state = 'closing'`,
        )
        .run(now, now, this.guildId, normalizedTicketId);
      this.appendTicketEventWithin(normalizedTicketId, {
        type: "closed",
        actorId: ticket.closedBy,
        details: { reason: ticket.closeReason },
      });
      result = {
        status: "closed",
        ticket: this.requireTicket(normalizedTicketId),
      };
    });
    finish.immediate();
    return requireTransitionResult<TicketCloseFinishResult>(result);
  }

  public markTicketLogDelivered(
    ticketId: string,
    logMessageId: string,
    expectedUpdatedAt?: string,
  ): TicketCloseLogResult {
    const normalizedTicketId = normalizeOpaqueId(ticketId);
    if (!normalizedTicketId) {
      return { status: "not-found", ticket: null };
    }
    const normalizedLogMessageId = assertDiscordSnowflake(
      logMessageId,
      "ticket log message ID",
    );
    let result: TicketCloseLogResult | null = null;
    const checkpoint = this.db.transaction(() => {
      const ticket = this.getTicketById(normalizedTicketId);
      if (!ticket) {
        result = { status: "not-found", ticket: null };
        return;
      }
      if (
        expectedUpdatedAt !== undefined &&
        ticket.updatedAt !== expectedUpdatedAt
      ) {
        result = { status: "conflict", ticket };
        return;
      }
      if (
        (ticket.state === "closing" || ticket.state === "closed") &&
        ticket.closeLogMessageId !== null
      ) {
        result = { status: "already-logged", ticket };
        return;
      }
      if (ticket.state !== "closing") {
        result = { status: "unavailable", ticket };
        return;
      }
      const now = utcNow();
      this.db
        .prepare(
          `UPDATE tickets
           SET close_log_message_id = ?, close_logged_at = ?, updated_at = ?
           WHERE guild_id = ? AND ticket_id = ? AND state = 'closing'
             AND close_log_message_id IS NULL`,
        )
        .run(
          normalizedLogMessageId,
          now,
          now,
          this.guildId,
          normalizedTicketId,
        );
      this.appendTicketEventWithin(normalizedTicketId, {
        type: "close_logged",
        actorId: ticket.closedBy,
        details: { logMessageId: normalizedLogMessageId },
      });
      result = {
        status: "logged",
        ticket: this.requireTicket(normalizedTicketId),
      };
    });
    checkpoint.immediate();
    return requireTransitionResult<TicketCloseLogResult>(result);
  }

  public rebindTicket(
    ticketId: string,
    input: TicketRebindInput,
    actorId?: string | null,
  ): TicketRebindResult {
    const normalizedTicketId = normalizeOpaqueId(ticketId);
    if (!normalizedTicketId) {
      return { status: "not-found", ticket: null };
    }
    const hasChannel = Object.hasOwn(input, "channelId");
    const hasControl = Object.hasOwn(input, "controlMessageId");
    const hasExpectedChannel = Object.hasOwn(input, "expectedChannelId");
    const hasExpectedControl = Object.hasOwn(input, "expectedControlMessageId");
    const hasExpectedState = Object.hasOwn(input, "expectedState");
    const hasExpectedUpdatedAt = Object.hasOwn(input, "expectedUpdatedAt");
    if (!hasChannel && !hasControl) {
      throw new TypeError(
        "Ticket rebind must change a channel or control message",
      );
    }
    const channelId = hasChannel
      ? assertDiscordSnowflake(input.channelId ?? "", "channel ID")
      : undefined;
    const controlMessageId = hasControl
      ? input.controlMessageId === null || input.controlMessageId === undefined
        ? null
        : assertDiscordSnowflake(input.controlMessageId, "control message ID")
      : undefined;
    const expectedChannelId = hasExpectedChannel
      ? input.expectedChannelId === null ||
        input.expectedChannelId === undefined
        ? null
        : assertDiscordSnowflake(input.expectedChannelId, "expected channel ID")
      : undefined;
    const expectedControlMessageId = hasExpectedControl
      ? input.expectedControlMessageId === null ||
        input.expectedControlMessageId === undefined
        ? null
        : assertDiscordSnowflake(
            input.expectedControlMessageId,
            "expected control message ID",
          )
      : undefined;
    const expectedState = hasExpectedState
      ? normalizeTicketState(input.expectedState)
      : undefined;
    const expectedUpdatedAt = hasExpectedUpdatedAt
      ? normalizeExpectedTimestamp(input.expectedUpdatedAt)
      : undefined;
    const normalizedActor =
      actorId === undefined || actorId === null
        ? null
        : assertDiscordSnowflake(actorId, "actor ID");
    let result: TicketRebindResult | null = null;
    const rebind = this.db.transaction(() => {
      const ticket = this.getTicketById(normalizedTicketId);
      if (!ticket) {
        result = { status: "not-found", ticket: null };
        return;
      }
      if (
        !(["creating", "open", "closing"] as TicketState[]).includes(
          ticket.state,
        )
      ) {
        result = { status: "unavailable", ticket };
        return;
      }
      if (
        (hasExpectedChannel && ticket.channelId !== expectedChannelId) ||
        (hasExpectedControl &&
          ticket.controlMessageId !== expectedControlMessageId) ||
        (hasExpectedState && ticket.state !== expectedState) ||
        (hasExpectedUpdatedAt && ticket.updatedAt !== expectedUpdatedAt)
      ) {
        result = { status: "conflict", ticket };
        return;
      }
      const nextChannelId = channelId ?? ticket.channelId;
      const nextControlMessageId = hasControl
        ? (controlMessageId ?? null)
        : ticket.controlMessageId;
      if (nextControlMessageId !== null && nextChannelId === null) {
        throw new TypeError("A ticket control message requires a channel");
      }
      this.db
        .prepare(
          `UPDATE tickets
           SET channel_id = ?, control_message_id = ?, updated_at = ?
           WHERE guild_id = ? AND ticket_id = ?`,
        )
        .run(
          nextChannelId,
          nextControlMessageId,
          utcNow(),
          this.guildId,
          normalizedTicketId,
        );
      this.appendTicketEventWithin(normalizedTicketId, {
        type: "rebound",
        actorId: normalizedActor,
        details: {
          previousChannelId: ticket.channelId,
          channelId: nextChannelId,
          previousControlMessageId: ticket.controlMessageId,
          controlMessageId: nextControlMessageId,
        },
      });
      result = {
        status: "rebound",
        ticket: this.requireTicket(normalizedTicketId),
      };
    });
    rebind.immediate();
    return requireTransitionResult<TicketRebindResult>(result);
  }

  public appendTicketEvent(
    ticketId: string,
    input: TicketEventInput,
  ): TicketEvent | null {
    const normalizedTicketId = normalizeOpaqueId(ticketId);
    if (!normalizedTicketId) {
      return null;
    }
    let event: TicketEvent | null = null;
    const append = this.db.transaction(() => {
      if (!this.getTicketById(normalizedTicketId)) {
        return;
      }
      event = this.appendTicketEventWithin(normalizedTicketId, input);
    });
    append.immediate();
    return event;
  }

  public listTicketEvents(ticketId: string): TicketEvent[] {
    const normalizedTicketId = normalizeOpaqueId(ticketId);
    if (!normalizedTicketId) {
      return [];
    }
    return (
      this.db
        .prepare(
          `SELECT * FROM ticket_events
           WHERE guild_id = ? AND ticket_id = ?
           ORDER BY event_number`,
        )
        .all(this.guildId, normalizedTicketId) as TicketEventRow[]
    ).map(parseTicketEventRow);
  }

  public listAllTicketEvents(): TicketEvent[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM ticket_events
           WHERE guild_id = ? ORDER BY ticket_id, event_number`,
        )
        .all(this.guildId) as TicketEventRow[]
    ).map(parseTicketEventRow);
  }

  private appendTicketEventWithin(
    ticketId: string,
    input: TicketEventInput,
  ): TicketEvent {
    const type = normalizeTicketEventType(input.type);
    const actorId =
      input.actorId === undefined || input.actorId === null
        ? null
        : assertDiscordSnowflake(input.actorId, "event actor ID");
    const detailsJson = serializeBoundedJson(
      input.details ?? {},
      4000,
      "Ticket event details",
    );
    const numberRow = this.db
      .prepare(
        `SELECT COALESCE(MAX(event_number), 0) + 1 AS event_number
         FROM ticket_events WHERE guild_id = ? AND ticket_id = ?`,
      )
      .get(this.guildId, ticketId) as { event_number: number };
    const eventNumber = Number(numberRow.event_number);
    if (
      !Number.isInteger(eventNumber) ||
      eventNumber < 1 ||
      eventNumber > 2_147_483_647
    ) {
      throw new RangeError("The per-ticket event number range is exhausted");
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const eventId = opaqueId();
      const exists = this.db
        .prepare(
          `SELECT 1 FROM ticket_events
           WHERE guild_id = ? AND ticket_id = ? AND event_id = ?`,
        )
        .get(this.guildId, ticketId, eventId);
      if (exists) {
        continue;
      }
      const createdAt = utcNow();
      this.db
        .prepare(
          `INSERT INTO ticket_events (
             guild_id, ticket_id, event_id, event_number, event_type, actor_id,
             details_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.guildId,
          ticketId,
          eventId,
          eventNumber,
          type,
          actorId,
          detailsJson,
          createdAt,
        );
      return {
        guildId: this.guildId,
        ticketId,
        eventId,
        eventNumber,
        type,
        actorId,
        details: parseJson(detailsJson, "ticket event details"),
        createdAt,
      };
    }
    throw new Error("Unable to allocate a unique ticket-event ID");
  }

  private allocateTicketId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const ticketId = opaqueId();
      if (!this.getTicketById(ticketId)) {
        return ticketId;
      }
    }
    throw new Error("Unable to allocate a unique ticket ID");
  }

  private insertPostedPanel(
    panelId: string,
    input: ReturnType<typeof normalizePostedPanelInput>,
  ): void {
    const now = utcNow();
    this.db
      .prepare(
        `INSERT INTO posted_panels (
           guild_id, panel_id, preset, channel_id, message_id,
           configuration_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.guildId,
        panelId,
        input.preset,
        input.channelId,
        input.messageId,
        input.configurationJson,
        now,
        now,
      );
  }

  private requireTicketConfiguration(): TicketConfiguration {
    const configuration = this.getTicketConfiguration();
    if (!configuration) {
      throw new Error(`Guild ${this.guildId} has no ticket configuration`);
    }
    return configuration;
  }

  private requirePostedPanel(panelId: string): PostedPanel {
    const panel = this.findPostedPanelByToken(panelId);
    if (!panel) {
      throw new Error(`Posted panel ${panelId} was not persisted`);
    }
    return panel;
  }

  private requireTicket(ticketId: string): TicketRecord {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) {
      throw new Error(`Ticket ${ticketId} was not persisted`);
    }
    return ticket;
  }
}

function normalizePostedPanelInput(input: PostedPanelInput): {
  panelId: string | null;
  preset: PanelPreset;
  channelId: string;
  messageId: string;
  configurationJson: string;
} {
  return {
    panelId:
      input.panelId === undefined
        ? null
        : (normalizeOpaqueId(input.panelId) ??
          invalidOpaqueId("Posted panel ID")),
    preset: normalizePanelPreset(input.preset),
    channelId: assertDiscordSnowflake(input.channelId, "panel channel ID"),
    messageId: assertDiscordSnowflake(input.messageId, "panel message ID"),
    configurationJson: serializeBoundedJson(
      input.configuration ?? {},
      16000,
      "Panel configuration",
    ),
  };
}

function normalizePanelPreset(value: PanelPreset): PanelPreset {
  if (!(PANEL_PRESETS as readonly unknown[]).includes(value)) {
    throw new TypeError("Unsupported panel preset");
  }
  return value;
}

function normalizeTicketEventType(value: TicketEventType): TicketEventType {
  if (!(TICKET_EVENT_TYPES as readonly unknown[]).includes(value)) {
    throw new TypeError("Unsupported ticket event type");
  }
  return value;
}

function normalizeTicketStates(states: readonly TicketState[]): TicketState[] {
  if (!Array.isArray(states)) {
    throw new TypeError("Ticket states must be an array");
  }
  const normalized = [...new Set(states)];
  for (const state of normalized) {
    if (!(TICKET_STATES as readonly unknown[]).includes(state)) {
      throw new TypeError(`Unsupported ticket state: ${String(state)}`);
    }
  }
  return normalized;
}

function normalizeTicketNumber(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new RangeError("Ticket number must be a positive 32-bit integer");
  }
  return value;
}

function normalizeTicketState(value: unknown): TicketState {
  if (!(TICKET_STATES as readonly unknown[]).includes(value)) {
    throw new TypeError("Expected ticket state is invalid");
  }
  return value as TicketState;
}

function normalizeExpectedTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError("Expected ticket timestamp is invalid");
  }
  return value;
}

function normalizeText(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be text`);
  }
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new RangeError(
      `${label} must contain between ${minimum} and ${maximum} characters`,
    );
  }
  return normalized;
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
      `${label} must be JSON-safe: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (serialized === undefined) {
    throw new TypeError(`${label} must be JSON-safe`);
  }
  if (
    serialized.length < 2 ||
    serialized.length > maximumBytes ||
    Buffer.byteLength(serialized, "utf8") > maximumBytes
  ) {
    throw new RangeError(`${label} exceeds the ${maximumBytes}-byte limit`);
  }
  return serialized;
}

function parseTicketConfigurationRow(
  row: TicketConfigurationRow,
): TicketConfiguration {
  return {
    guildId: row.guild_id,
    enabled: Boolean(row.enabled),
    categoryId: row.category_id,
    logChannelId: row.log_channel_id,
    supportRoleId: row.support_role_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parsePostedPanelRow(row: PostedPanelRow): PostedPanel {
  return {
    guildId: row.guild_id,
    panelId: row.panel_id,
    preset: row.preset as PanelPreset,
    channelId: row.channel_id,
    messageId: row.message_id,
    configuration: parseJson(row.configuration_json, "panel configuration"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseTicketRow(row: TicketRow): TicketRecord {
  return {
    guildId: row.guild_id,
    ticketId: row.ticket_id,
    ticketNumber: row.ticket_number,
    openerId: row.opener_id,
    channelId: row.channel_id,
    controlMessageId: row.control_message_id,
    subject: row.subject,
    description: row.description,
    state: row.state as TicketState,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    closedBy: row.closed_by,
    closeReason: row.close_reason,
    closeLogMessageId: row.close_log_message_id,
    closeLoggedAt: row.close_logged_at,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closingAt: row.closing_at,
    closedAt: row.closed_at,
  };
}

function parseTicketEventRow(row: TicketEventRow): TicketEvent {
  return {
    guildId: row.guild_id,
    ticketId: row.ticket_id,
    eventId: row.event_id,
    eventNumber: row.event_number,
    type: row.event_type as TicketEventType,
    actorId: row.actor_id,
    details: parseJson(row.details_json, "ticket event details"),
    createdAt: row.created_at,
  };
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

function opaqueId(): string {
  return randomBytes(9).toString("base64url");
}

/** Creates a custom-ID-safe storage token before a Discord message is sent. */
export function createOpaqueStorageId(): string {
  return opaqueId();
}

function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 24 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function normalizeOpaqueId(value: unknown): string | null {
  return isOpaqueId(value) ? value : null;
}

function invalidOpaqueId(label: string): never {
  throw new TypeError(`${label} must be an 8-24 character opaque token`);
}

function utcNow(): string {
  return new Date().toISOString();
}

function requireTransitionResult<T>(result: T | null): T {
  if (result === null) {
    throw new Error("Ticket transition completed without a result");
  }
  return result;
}
