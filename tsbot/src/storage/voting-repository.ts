import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { assertDiscordSnowflake } from "../guild-settings.js";
import {
  VOTING_PANEL_STATUSES,
  VOTING_PANEL_TYPES,
  type VotingPanel,
  type VotingPanelInput,
  type VotingPanelOption,
  type VotingPanelOptionInput,
  type VotingPanelSelectionResult,
  type VotingPanelStatus,
  type VotingPanelTransitionResult,
  type VotingPanelType,
  type VotingPanelVoter,
} from "../types.js";

export const MAX_ACTIVE_VOTING_PANELS_PER_CHANNEL = 5;
export const MAX_VOTING_PANEL_OPTIONS = 10;

interface VotingPanelRow {
  guild_id: string;
  vote_id: string;
  channel_id: string;
  message_id: string;
  creator_id: string;
  question: string;
  title: string | null;
  description: string | null;
  poll_type: string;
  multi_select: number;
  deadline_at: string | null;
  mention_everyone_on_creation: number;
  mention_everyone_on_completion: number;
  status: string;
  completed_by: string | null;
  completed_at: string | null;
  cancelled_by: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

interface VotingPanelOptionRow {
  guild_id: string;
  vote_id: string;
  option_id: string;
  label: string;
  sort_order: number;
  vote_count: number;
}

interface VotingPanelSelectionRow {
  voter_id: string;
  option_id: string;
  updated_at: string;
}

interface NormalizedVotingPanelInput {
  voteId: string | null;
  channelId: string;
  messageId: string;
  creatorId: string;
  question: string;
  title: string | null;
  description: string | null;
  pollType: VotingPanelType;
  multiSelect: boolean;
  options: readonly NormalizedVotingPanelOptionInput[];
  deadlineAt: string | null;
  mentionEveryoneOnCreation: boolean;
  mentionEveryoneOnCompletion: boolean;
}

interface NormalizedVotingPanelOptionInput {
  optionId: string;
  label: string;
  sortOrder: number;
}

/**
 * Tenant-bound durable voting-panel state. All mutations use BEGIN IMMEDIATE
 * because button callbacks can arrive concurrently (and a second bot process
 * must not race a selection or the per-channel active-panel limit).
 */
export class GuildVotingRepository {
  public constructor(
    private readonly db: Database.Database,
    public readonly guildId: string,
  ) {}

  public createVotingPanel(input: VotingPanelInput): VotingPanel {
    const normalized = normalizeVotingPanelInput(input);
    let result: VotingPanel | null = null;
    const create = this.db.transaction(() => {
      const active = this.countActiveVotingPanels(normalized.channelId);
      if (active >= MAX_ACTIVE_VOTING_PANELS_PER_CHANNEL) {
        throw new RangeError(
          `A channel can have at most ${MAX_ACTIVE_VOTING_PANELS_PER_CHANNEL} active voting panels`,
        );
      }
      const voteId = normalized.voteId ?? this.allocateVoteId();
      if (this.getVotingPanel(voteId)) {
        throw new Error("Voting panel ID is already in use in this server");
      }
      const now = utcNow();
      this.db
        .prepare(
          `INSERT INTO voting_panels (
             guild_id, vote_id, channel_id, message_id, creator_id, question,
             title, description, poll_type, multi_select, deadline_at,
             mention_everyone_on_creation, mention_everyone_on_completion,
             status, completed_by, completed_at, cancelled_by, cancelled_at,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active',
             NULL, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          this.guildId,
          voteId,
          normalized.channelId,
          normalized.messageId,
          normalized.creatorId,
          normalized.question,
          normalized.title,
          normalized.description,
          normalized.pollType,
          normalized.multiSelect ? 1 : 0,
          normalized.deadlineAt,
          normalized.mentionEveryoneOnCreation ? 1 : 0,
          normalized.mentionEveryoneOnCompletion ? 1 : 0,
          now,
          now,
        );
      const insertOption = this.db.prepare(
        `INSERT INTO voting_panel_options (
           guild_id, vote_id, option_id, label, sort_order, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const option of normalized.options) {
        insertOption.run(
          this.guildId,
          voteId,
          option.optionId,
          option.label,
          option.sortOrder,
          now,
        );
      }
      result = this.requireVotingPanel(voteId);
    });
    create.immediate();
    return requireResult<VotingPanel>(result, "Voting panel creation");
  }

  public getVotingPanel(voteId: string): VotingPanel | null {
    const id = normalizeOpaqueId(voteId);
    if (!id) return null;
    const row = this.db
      .prepare("SELECT * FROM voting_panels WHERE guild_id = ? AND vote_id = ?")
      .get(this.guildId, id) as VotingPanelRow | undefined;
    return row ? this.hydrateVotingPanel(row) : null;
  }

  public getVotingPanelByMessage(
    channelId: string,
    messageId: string,
  ): VotingPanel | null {
    const channel = assertDiscordSnowflake(
      channelId,
      "voting panel channel ID",
    );
    const message = assertDiscordSnowflake(
      messageId,
      "voting panel message ID",
    );
    const row = this.db
      .prepare(
        `SELECT * FROM voting_panels
         WHERE guild_id = ? AND channel_id = ? AND message_id = ?`,
      )
      .get(this.guildId, channel, message) as VotingPanelRow | undefined;
    return row ? this.hydrateVotingPanel(row) : null;
  }

  public listActiveVotingPanels(): VotingPanel[] {
    return this.listVotingPanelsBySql(
      "status = 'active' ORDER BY CASE WHEN deadline_at IS NULL THEN 1 ELSE 0 END, deadline_at, created_at, vote_id",
      [],
    );
  }

  public listDueVotingPanels(now: string): VotingPanel[] {
    const timestamp = normalizeTimestamp(now, "Voting-panel due time");
    return this.listVotingPanelsBySql(
      "status = 'active' AND deadline_at IS NOT NULL AND deadline_at <= ? ORDER BY deadline_at, vote_id",
      [timestamp],
    );
  }

  public countActiveVotingPanels(channelId?: string): number {
    if (channelId === undefined) {
      return Number(
        (
          this.db
            .prepare(
              "SELECT COUNT(*) AS count FROM voting_panels WHERE guild_id = ? AND status = 'active'",
            )
            .get(this.guildId) as { count: number }
        ).count,
      );
    }
    const channel = assertDiscordSnowflake(
      channelId,
      "voting panel channel ID",
    );
    return Number(
      (
        this.db
          .prepare(
            `SELECT COUNT(*) AS count FROM voting_panels
             WHERE guild_id = ? AND channel_id = ? AND status = 'active'`,
          )
          .get(this.guildId, channel) as { count: number }
      ).count,
    );
  }

  public getVotingPanelSelection(voteId: string, userId: string): string[] {
    const id = normalizeOpaqueId(voteId);
    if (!id) return [];
    const voter = assertDiscordSnowflake(userId, "voter ID");
    return this.getVotingPanelSelectionWithin(id, voter);
  }

  public replaceVotingSelection(
    voteId: string,
    userId: string,
    optionIds: readonly string[],
  ): VotingPanelSelectionResult {
    const id = requireOpaqueId(voteId, "Voting panel ID");
    const voter = assertDiscordSnowflake(userId, "voter ID");
    const requested = normalizeOptionIds(optionIds);
    let result: VotingPanelSelectionResult | null = null;
    const replace = this.db.transaction(() => {
      const panel = this.getVotingPanel(id);
      if (!panel) {
        result = { status: "not-found", panel: null, optionIds: [] };
        return;
      }
      const current = this.getVotingPanelSelectionWithin(id, voter);
      if (panel.status !== "active" || isVotingPanelExpired(panel)) {
        result = { status: "not-active", panel, optionIds: current };
        return;
      }
      this.assertSelectionIsValid(panel, requested);
      if (sameStrings(current, requested)) {
        result = { status: "unchanged", panel, optionIds: current };
        return;
      }
      this.replaceVotingPanelSelectionWithin(id, voter, requested);
      result = {
        status: "changed",
        panel: this.requireVotingPanel(id),
        optionIds: this.getVotingPanelSelectionWithin(id, voter),
      };
    });
    replace.immediate();
    return requireResult<VotingPanelSelectionResult>(
      result,
      "Voting selection replacement",
    );
  }

  public selectVotingPanelOption(
    voteId: string,
    userId: string,
    optionId: string,
  ): VotingPanelSelectionResult {
    const id = requireOpaqueId(voteId, "Voting panel ID");
    const voter = assertDiscordSnowflake(userId, "voter ID");
    const option = requireOpaqueId(optionId, "Voting option ID");
    let result: VotingPanelSelectionResult | null = null;
    const select = this.db.transaction(() => {
      const panel = this.getVotingPanel(id);
      if (!panel) {
        result = { status: "not-found", panel: null, optionIds: [] };
        return;
      }
      const current = this.getVotingPanelSelectionWithin(id, voter);
      if (panel.status !== "active" || isVotingPanelExpired(panel)) {
        result = { status: "not-active", panel, optionIds: current };
        return;
      }
      if (panel.multiSelect) {
        result = { status: "mode-mismatch", panel, optionIds: current };
        return;
      }
      this.assertSelectionIsValid(panel, [option]);
      if (sameStrings(current, [option])) {
        result = { status: "unchanged", panel, optionIds: current };
        return;
      }
      this.replaceVotingPanelSelectionWithin(id, voter, [option]);
      result = {
        status: "changed",
        panel: this.requireVotingPanel(id),
        optionIds: [option],
      };
    });
    select.immediate();
    return requireResult<VotingPanelSelectionResult>(
      result,
      "Voting option selection",
    );
  }

  public toggleVotingPanelOption(
    voteId: string,
    userId: string,
    optionId: string,
  ): VotingPanelSelectionResult {
    const id = requireOpaqueId(voteId, "Voting panel ID");
    const voter = assertDiscordSnowflake(userId, "voter ID");
    const option = requireOpaqueId(optionId, "Voting option ID");
    let result: VotingPanelSelectionResult | null = null;
    const toggle = this.db.transaction(() => {
      const panel = this.getVotingPanel(id);
      if (!panel) {
        result = { status: "not-found", panel: null, optionIds: [] };
        return;
      }
      const current = this.getVotingPanelSelectionWithin(id, voter);
      if (panel.status !== "active" || isVotingPanelExpired(panel)) {
        result = { status: "not-active", panel, optionIds: current };
        return;
      }
      if (!panel.multiSelect) {
        result = { status: "mode-mismatch", panel, optionIds: current };
        return;
      }
      this.assertSelectionIsValid(panel, [option]);
      const requested = current.includes(option)
        ? current.filter((candidate) => candidate !== option)
        : [...current, option];
      this.replaceVotingPanelSelectionWithin(id, voter, requested);
      result = {
        status: "changed",
        panel: this.requireVotingPanel(id),
        optionIds: this.getVotingPanelSelectionWithin(id, voter),
      };
    });
    toggle.immediate();
    return requireResult<VotingPanelSelectionResult>(
      result,
      "Voting option toggle",
    );
  }

  public listVotingPanelVoters(voteId: string): VotingPanelVoter[] {
    const id = requireOpaqueId(voteId, "Voting panel ID");
    if (!this.getVotingPanel(id)) return [];
    const rows = this.db
      .prepare(
        `SELECT selection.voter_id, selection.option_id, selection.updated_at
         FROM voting_panel_selections AS selection
         JOIN voting_panel_options AS option
           ON option.guild_id = selection.guild_id
          AND option.vote_id = selection.vote_id
          AND option.option_id = selection.option_id
         WHERE selection.guild_id = ? AND selection.vote_id = ?
         ORDER BY selection.voter_id, option.sort_order, option.option_id`,
      )
      .all(this.guildId, id) as VotingPanelSelectionRow[];
    const voters = new Map<
      string,
      { optionIds: string[]; updatedAt: string }
    >();
    for (const row of rows) {
      const current = voters.get(row.voter_id);
      if (current) {
        current.optionIds.push(row.option_id);
        if (row.updated_at > current.updatedAt)
          current.updatedAt = row.updated_at;
      } else {
        voters.set(row.voter_id, {
          optionIds: [row.option_id],
          updatedAt: row.updated_at,
        });
      }
    }
    return [...voters.entries()].map(([voterId, selection]) => ({
      guildId: this.guildId,
      voteId: id,
      voterId,
      optionIds: selection.optionIds,
      updatedAt: selection.updatedAt,
    }));
  }

  public transitionVotingPanel(
    voteId: string,
    status: Exclude<VotingPanelStatus, "active">,
    actorId: string,
    timestamp: string,
  ): VotingPanelTransitionResult {
    const id = requireOpaqueId(voteId, "Voting panel ID");
    const target = normalizeTerminalStatus(status);
    const actor = assertDiscordSnowflake(actorId, "Voting transition actor ID");
    const at = normalizeTimestamp(timestamp, "Voting transition timestamp");
    let result: VotingPanelTransitionResult | null = null;
    const transition = this.db.transaction(() => {
      const panel = this.getVotingPanel(id);
      if (!panel) {
        result = { status: "not-found", panel: null };
        return;
      }
      if (panel.status === target) {
        result = { status: "already-transitioned", panel };
        return;
      }
      if (panel.status !== "active") {
        result = { status: "conflict", panel };
        return;
      }
      const update =
        target === "completed"
          ? this.db
              .prepare(
                `UPDATE voting_panels
                 SET status = 'completed', completed_by = ?, completed_at = ?,
                     cancelled_by = NULL, cancelled_at = NULL, updated_at = ?
                 WHERE guild_id = ? AND vote_id = ? AND status = 'active'`,
              )
              .run(actor, at, at, this.guildId, id)
          : this.db
              .prepare(
                `UPDATE voting_panels
                 SET status = 'cancelled', completed_by = NULL, completed_at = NULL,
                     cancelled_by = ?, cancelled_at = ?, updated_at = ?
                 WHERE guild_id = ? AND vote_id = ? AND status = 'active'`,
              )
              .run(actor, at, at, this.guildId, id);
      if (update.changes !== 1) {
        const latest = this.requireVotingPanel(id);
        result =
          latest.status === target
            ? { status: "already-transitioned", panel: latest }
            : { status: "conflict", panel: latest };
        return;
      }
      result = { status: "transitioned", panel: this.requireVotingPanel(id) };
    });
    transition.immediate();
    return requireResult<VotingPanelTransitionResult>(
      result,
      "Voting panel transition",
    );
  }

  private listVotingPanelsBySql(
    predicate: string,
    parameters: readonly unknown[],
  ): VotingPanel[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM voting_panels
         WHERE guild_id = ? AND ${predicate}`,
      )
      .all(this.guildId, ...parameters) as VotingPanelRow[];
    return rows.map((row) => this.hydrateVotingPanel(row));
  }

  private hydrateVotingPanel(row: VotingPanelRow): VotingPanel {
    const options = (
      this.db
        .prepare(
          `SELECT option.guild_id, option.vote_id, option.option_id, option.label,
                  option.sort_order,
                  COUNT(selection.voter_id) AS vote_count
           FROM voting_panel_options AS option
           LEFT JOIN voting_panel_selections AS selection
             ON selection.guild_id = option.guild_id
            AND selection.vote_id = option.vote_id
            AND selection.option_id = option.option_id
           WHERE option.guild_id = ? AND option.vote_id = ?
           GROUP BY option.guild_id, option.vote_id, option.option_id,
                    option.label, option.sort_order
           ORDER BY option.sort_order, option.option_id`,
        )
        .all(this.guildId, row.vote_id) as VotingPanelOptionRow[]
    ).map(parseVotingPanelOptionRow);
    const totalVoters = Number(
      (
        this.db
          .prepare(
            `SELECT COUNT(DISTINCT voter_id) AS count
             FROM voting_panel_selections WHERE guild_id = ? AND vote_id = ?`,
          )
          .get(this.guildId, row.vote_id) as { count: number }
      ).count,
    );
    return { ...parseVotingPanelRow(row), options, totalVoters };
  }

  private getVotingPanelSelectionWithin(
    voteId: string,
    voterId: string,
  ): string[] {
    return (
      this.db
        .prepare(
          `SELECT selection.option_id
           FROM voting_panel_selections AS selection
           JOIN voting_panel_options AS option
             ON option.guild_id = selection.guild_id
            AND option.vote_id = selection.vote_id
            AND option.option_id = selection.option_id
           WHERE selection.guild_id = ? AND selection.vote_id = ?
             AND selection.voter_id = ?
           ORDER BY option.sort_order, option.option_id`,
        )
        .all(this.guildId, voteId, voterId) as Array<{ option_id: string }>
    ).map((row) => row.option_id);
  }

  private replaceVotingPanelSelectionWithin(
    voteId: string,
    voterId: string,
    optionIds: readonly string[],
  ): void {
    this.db
      .prepare(
        `DELETE FROM voting_panel_selections
         WHERE guild_id = ? AND vote_id = ? AND voter_id = ?`,
      )
      .run(this.guildId, voteId, voterId);
    const now = utcNow();
    if (optionIds.length > 0) {
      const insert = this.db.prepare(
        `INSERT INTO voting_panel_selections (
           guild_id, vote_id, voter_id, option_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const optionId of optionIds) {
        insert.run(this.guildId, voteId, voterId, optionId, now, now);
      }
    }
    this.db
      .prepare(
        `UPDATE voting_panels SET updated_at = ?
         WHERE guild_id = ? AND vote_id = ?`,
      )
      .run(now, this.guildId, voteId);
  }

  private assertSelectionIsValid(
    panel: VotingPanel,
    optionIds: readonly string[],
  ): void {
    if (!panel.multiSelect && optionIds.length !== 1) {
      throw new RangeError(
        "Single-select voting panels require exactly one option",
      );
    }
    if (optionIds.length > panel.options.length) {
      throw new RangeError("Voting selection has too many options");
    }
    const valid = new Set(panel.options.map((option) => option.optionId));
    if (optionIds.some((optionId) => !valid.has(optionId))) {
      throw new RangeError(
        "Voting selection includes an option from another panel",
      );
    }
  }

  private allocateVoteId(): string {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const voteId = opaqueId();
      if (!this.getVotingPanel(voteId)) return voteId;
    }
    throw new Error("Unable to allocate a unique voting panel ID");
  }

  private requireVotingPanel(voteId: string): VotingPanel {
    const panel = this.getVotingPanel(voteId);
    if (!panel) throw new Error(`Voting panel ${voteId} was not persisted`);
    return panel;
  }
}

function normalizeVotingPanelInput(
  input: VotingPanelInput,
): NormalizedVotingPanelInput {
  if (!input || typeof input !== "object") {
    throw new TypeError("Voting panel input is required");
  }
  const pollType = normalizePollType(input.pollType);
  const options = normalizeVotingPanelOptions(input.options, pollType);
  const multiSelect = normalizeBoolean(
    input.multiSelect,
    "Voting multi-select",
  );
  return {
    voteId:
      input.voteId === undefined
        ? null
        : requireOpaqueId(input.voteId, "Voting panel ID"),
    channelId: assertDiscordSnowflake(
      input.channelId,
      "voting panel channel ID",
    ),
    messageId: assertDiscordSnowflake(
      input.messageId,
      "voting panel message ID",
    ),
    creatorId: assertDiscordSnowflake(
      input.creatorId,
      "voting panel creator ID",
    ),
    question: normalizeText(input.question, 1, 256, "Voting question"),
    title: normalizeNullableText(input.title, 256, "Voting title"),
    description: normalizeNullableText(
      input.description,
      4_096,
      "Voting description",
    ),
    pollType,
    multiSelect,
    options,
    deadlineAt: normalizeNullableTimestamp(input.deadlineAt, "Voting deadline"),
    mentionEveryoneOnCreation: normalizeOptionalBoolean(
      input.mentionEveryoneOnCreation,
      "Voting creation mention setting",
    ),
    mentionEveryoneOnCompletion: normalizeOptionalBoolean(
      input.mentionEveryoneOnCompletion,
      "Voting completion mention setting",
    ),
  };
}

function normalizeVotingPanelOptions(
  input: readonly VotingPanelOptionInput[],
  pollType: VotingPanelType,
): NormalizedVotingPanelOptionInput[] {
  if (
    !Array.isArray(input) ||
    input.length < 2 ||
    input.length > MAX_VOTING_PANEL_OPTIONS
  ) {
    throw new RangeError(
      `Voting panels require between 2 and ${MAX_VOTING_PANEL_OPTIONS} options`,
    );
  }
  const optionIds = new Set<string>();
  const labels = new Set<string>();
  const options = input.map((option, sortOrder) => {
    if (!option || typeof option !== "object") {
      throw new TypeError("Voting option input is invalid");
    }
    const optionId = requireOpaqueId(option.optionId, "Voting option ID");
    const label = normalizeText(option.label, 1, 80, "Voting option label");
    if (optionIds.has(optionId)) {
      throw new RangeError("Voting option IDs must be unique");
    }
    const comparable = label.toLocaleLowerCase("en-US");
    if (labels.has(comparable)) {
      throw new RangeError("Voting option labels must be unique");
    }
    optionIds.add(optionId);
    labels.add(comparable);
    return { optionId, label, sortOrder };
  });
  if (
    pollType === "yes-no" &&
    (options.length !== 2 ||
      options[0]?.label !== "Yes" ||
      options[1]?.label !== "No")
  ) {
    throw new RangeError(
      "Yes/no voting panels must use exactly Yes and No options",
    );
  }
  return options;
}

function parseVotingPanelRow(
  row: VotingPanelRow,
): Omit<VotingPanel, "options" | "totalVoters"> {
  return {
    guildId: row.guild_id,
    voteId: row.vote_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    creatorId: row.creator_id,
    question: row.question,
    title: row.title,
    description: row.description,
    pollType: normalizePollType(row.poll_type),
    multiSelect: normalizeStoredBoolean(
      row.multi_select,
      "voting multi_select",
    ),
    deadlineAt: row.deadline_at,
    mentionEveryoneOnCreation: normalizeStoredBoolean(
      row.mention_everyone_on_creation,
      "voting mention_everyone_on_creation",
    ),
    mentionEveryoneOnCompletion: normalizeStoredBoolean(
      row.mention_everyone_on_completion,
      "voting mention_everyone_on_completion",
    ),
    status: normalizeVotingPanelStatus(row.status),
    completedBy: row.completed_by,
    completedAt: row.completed_at,
    cancelledBy: row.cancelled_by,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseVotingPanelOptionRow(
  row: VotingPanelOptionRow,
): VotingPanelOption {
  return {
    guildId: row.guild_id,
    voteId: row.vote_id,
    optionId: row.option_id,
    label: row.label,
    sortOrder: Number(row.sort_order),
    voteCount: Number(row.vote_count),
  };
}

function normalizePollType(value: unknown): VotingPanelType {
  if (!(VOTING_PANEL_TYPES as readonly unknown[]).includes(value)) {
    throw new TypeError("Voting poll type is invalid");
  }
  return value as VotingPanelType;
}

function normalizeVotingPanelStatus(value: unknown): VotingPanelStatus {
  if (!(VOTING_PANEL_STATUSES as readonly unknown[]).includes(value)) {
    throw new TypeError("Voting panel status is invalid");
  }
  return value as VotingPanelStatus;
}

/**
 * The scheduler performs the terminal transition, but selection mutations must
 * also reject an elapsed deadline. That keeps a button click in the scheduler
 * interval (or immediately after a restart) from recording a late vote.
 */
function isVotingPanelExpired(panel: VotingPanel): boolean {
  return (
    panel.deadlineAt !== null &&
    Date.parse(panel.deadlineAt) <= Date.now()
  );
}

function normalizeTerminalStatus(
  value: Exclude<VotingPanelStatus, "active">,
): Exclude<VotingPanelStatus, "active"> {
  if (value !== "completed" && value !== "cancelled") {
    throw new TypeError(
      "Voting panel transition status must be completed or cancelled",
    );
  }
  return value;
}

function normalizeOptionIds(value: readonly string[]): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Voting selection must be an array");
  }
  const normalized = value.map((optionId) =>
    requireOpaqueId(optionId, "Voting option ID"),
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new RangeError("Voting selection option IDs must be unique");
  }
  return normalized;
}

function normalizeText(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be text`);
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new RangeError(
      `${label} must contain between ${minimum} and ${maximum} characters`,
    );
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError(`${label} contains control characters`);
  }
  return normalized;
}

function normalizeNullableText(
  value: unknown,
  maximum: number,
  label: string,
): string | null {
  if (value === undefined || value === null) return null;
  return normalizeText(value, 1, maximum, label);
}

function normalizeTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} is invalid`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError(`${label} is invalid`);
  return new Date(timestamp).toISOString();
}

function normalizeNullableTimestamp(
  value: unknown,
  label: string,
): string | null {
  if (value === undefined || value === null) return null;
  return normalizeTimestamp(value, label);
}

function normalizeBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean")
    throw new TypeError(`${label} must be a boolean`);
  return value;
}

function normalizeOptionalBoolean(value: unknown, label: string): boolean {
  if (value === undefined) return false;
  return normalizeBoolean(value, label);
}

function normalizeStoredBoolean(value: unknown, label: string): boolean {
  if (value !== 0 && value !== 1) throw new Error(`Stored ${label} is invalid`);
  return value === 1;
}

function opaqueId(): string {
  return randomBytes(9).toString("base64url");
}

function normalizeOpaqueId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,24}$/.test(value)
    ? value
    : null;
}

function requireOpaqueId(value: unknown, label: string): string {
  const normalized = normalizeOpaqueId(value);
  if (!normalized)
    throw new TypeError(`${label} must be an 8-24 character opaque token`);
  return normalized;
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function utcNow(): string {
  return new Date().toISOString();
}

function requireResult<T>(value: T | null, label: string): T {
  if (value === null) throw new Error(`${label} completed without a result`);
  return value;
}
