import { randomBytes } from "node:crypto";
import type { DatabaseConnection } from "./database.js";
import { assertDiscordSnowflake } from "../guild-settings.js";
import {
  DELIVERY_STATES,
  SUGGESTION_EVENT_TYPES,
  SUGGESTION_STATES,
  type SuggestionConfiguration,
  type SuggestionConfigurationInput,
  type SuggestionDeliveryInput,
  type SuggestionDeliveryResult,
  type SuggestionEvent,
  type SuggestionEventInput,
  type SuggestionEventType,
  type SuggestionRecord,
  type SuggestionReservationInput,
  type SuggestionReservationResult,
  type SuggestionReviewInput,
  type SuggestionState,
  type SuggestionTransitionResult,
  type SuggestionVote,
  type SuggestionVoteCounts,
  type SuggestionVoteResult,
  type SuggestionVoteValue,
  type DeliveryState,
} from "../types.js";

interface SuggestionConfigurationRow {
  guild_id: string;
  enabled: number;
  suggestion_channel_id: string;
  review_channel_id: string | null;
  reviewer_role_id: string;
  create_threads: number;
  cooldown_limit: number;
  cooldown_window_seconds: number;
  allow_self_votes: number;
  bindings_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SuggestionRow {
  guild_id: string;
  suggestion_id: string;
  suggestion_number: number;
  author_id: string;
  title: string;
  details: string;
  state: string;
  delivery_state: string;
  channel_id: string | null;
  message_id: string | null;
  thread_id: string | null;
  reviewer_id: string | null;
  review_reason: string | null;
  reviewed_at: string | null;
  withdrawn_at: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface SuggestionVoteRow {
  guild_id: string;
  suggestion_id: string;
  voter_id: string;
  vote: number;
  created_at: string;
  updated_at: string;
}

interface SuggestionEventRow {
  guild_id: string;
  suggestion_id: string;
  event_id: string;
  event_number: number;
  event_type: string;
  actor_id: string | null;
  details_json: string;
  created_at: string;
}

const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;
const MAX_EVENTS_PER_SUGGESTION = 100;

/** Tenant-bound persistence and conditional transitions for suggestions. */
export class SuggestionRepository {
  public constructor(
    private readonly db: DatabaseConnection,
    public readonly guildId: string,
  ) {}

  public getConfiguration(): SuggestionConfiguration | null {
    const row = this.db
      .prepare("SELECT * FROM suggestion_configurations WHERE guild_id = ?")
      .get(this.guildId) as SuggestionConfigurationRow | undefined;
    return row ? parseConfiguration(row) : null;
  }

  public upsertConfiguration(
    input: SuggestionConfigurationInput,
  ): SuggestionConfiguration {
    const normalized = normalizeConfiguration(input);
    const now = utcNow();
    this.db
      .prepare(
        `INSERT INTO suggestion_configurations (
           guild_id, enabled, suggestion_channel_id, review_channel_id,
           reviewer_role_id, create_threads, cooldown_limit,
           cooldown_window_seconds, allow_self_votes, bindings_verified_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(guild_id) DO UPDATE SET
           enabled = excluded.enabled,
           suggestion_channel_id = excluded.suggestion_channel_id,
           review_channel_id = excluded.review_channel_id,
           reviewer_role_id = excluded.reviewer_role_id,
           create_threads = excluded.create_threads,
           cooldown_limit = excluded.cooldown_limit,
           cooldown_window_seconds = excluded.cooldown_window_seconds,
           allow_self_votes = excluded.allow_self_votes,
           bindings_verified_at = excluded.bindings_verified_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        this.guildId,
        normalized.enabled ? 1 : 0,
        normalized.suggestionChannelId,
        normalized.reviewChannelId,
        normalized.reviewerRoleId,
        normalized.createThreads ? 1 : 0,
        normalized.cooldownLimit,
        normalized.cooldownWindowSeconds,
        normalized.allowSelfVotes ? 1 : 0,
        normalized.bindingsVerifiedAt,
        now,
        now,
      );
    return this.requireConfiguration();
  }

  public disableConfiguration(): SuggestionConfiguration | null {
    const current = this.getConfiguration();
    if (!current || !current.enabled) return current;
    this.db
      .prepare(
        `UPDATE suggestion_configurations
         SET enabled = 0, updated_at = ?
         WHERE guild_id = ? AND enabled = 1`,
      )
      .run(utcNow(), this.guildId);
    return this.requireConfiguration();
  }

  public reserveSuggestion(
    input: SuggestionReservationInput,
  ): SuggestionReservationResult {
    const authorId = assertDiscordSnowflake(
      input.authorId,
      "suggestion author ID",
    );
    const title = normalizeText(input.title, 1, 100, "Suggestion title");
    const details = normalizeText(
      input.details,
      1,
      4_000,
      "Suggestion details",
    );
    let result: SuggestionReservationResult | null = null;
    const reserve = this.db.transaction(() => {
      const configuration = this.getConfiguration();
      if (!configuration?.enabled) {
        result = { status: "disabled", suggestion: null };
        return;
      }
      const now = utcNow();
      const cutoff = new Date(
        Date.parse(now) - configuration.cooldownWindowSeconds * 1_000,
      ).toISOString();
      const recent = this.db
        .prepare(
          `SELECT created_at FROM suggestions
           WHERE guild_id = ? AND author_id = ? AND created_at >= ?
           ORDER BY created_at ASC LIMIT ?`,
        )
        .all(
          this.guildId,
          authorId,
          cutoff,
          configuration.cooldownLimit,
        ) as Array<{ created_at: string }>;
      if (recent.length >= configuration.cooldownLimit) {
        result = {
          status: "cooldown",
          suggestion: null,
          recentCount: recent.length,
          retryAt: new Date(
            Date.parse(recent[0]!.created_at) +
              configuration.cooldownWindowSeconds * 1_000,
          ).toISOString(),
        };
        return;
      }
      const suggestionNumber = this.nextSuggestionNumber();
      const suggestionId = this.allocateSuggestionId();
      this.db
        .prepare(
          `INSERT INTO suggestions (
             guild_id, suggestion_id, suggestion_number, author_id, title,
             details, state, delivery_state, channel_id, message_id, thread_id,
             reviewer_id, review_reason, reviewed_at, withdrawn_at,
             failure_reason, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'open', 'reserved', NULL, NULL, NULL,
             NULL, NULL, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          this.guildId,
          suggestionId,
          suggestionNumber,
          authorId,
          title,
          details,
          now,
          now,
        );
      this.appendEventWithin(suggestionId, {
        type: "submission_reserved",
        actorId: authorId,
        details: { suggestionNumber },
      });
      result = {
        status: "created",
        suggestion: this.requireSuggestion(suggestionId),
      };
    });
    reserve.immediate();
    return requireResult<SuggestionReservationResult>(
      result,
      "Suggestion reservation",
    );
  }

  public bindSuggestionDelivery(
    suggestionId: string,
    input: SuggestionDeliveryInput,
  ): SuggestionDeliveryResult {
    const id = requireOpaqueId(suggestionId, "suggestion ID");
    const channelId = assertDiscordSnowflake(input.channelId, "channel ID");
    const messageId = assertDiscordSnowflake(input.messageId, "message ID");
    const threadId = normalizeNullableSnowflake(input.threadId, "thread ID");
    const expectedUpdatedAt = normalizeOptionalTimestamp(
      input.expectedUpdatedAt,
    );
    let result: SuggestionDeliveryResult | null = null;
    const bind = this.db.transaction(() => {
      const suggestion = this.getSuggestionById(id);
      if (!suggestion) {
        result = { status: "not-found", suggestion: null };
        return;
      }
      if (
        suggestion.deliveryState === "posted" &&
        suggestion.channelId === channelId &&
        suggestion.messageId === messageId &&
        suggestion.threadId === threadId
      ) {
        result = { status: "already-posted", suggestion };
        return;
      }
      if (
        expectedUpdatedAt !== null &&
        suggestion.updatedAt !== expectedUpdatedAt
      ) {
        result = { status: "conflict", suggestion };
        return;
      }
      if (
        suggestion.deliveryState === "posted" &&
        suggestion.channelId === channelId &&
        suggestion.messageId === messageId &&
        threadId !== null
      ) {
        this.db
          .prepare(
            `UPDATE suggestions SET thread_id = ?, updated_at = ?
             WHERE guild_id = ? AND suggestion_id = ? AND updated_at = ?`,
          )
          .run(threadId, utcNow(), this.guildId, id, suggestion.updatedAt);
        this.appendEventWithin(id, {
          type: "rebound",
          details: {
            channelId,
            messageId,
            previousThreadId: suggestion.threadId,
            threadId,
            threadOnly: true,
          },
        });
        result = { status: "posted", suggestion: this.requireSuggestion(id) };
        return;
      }
      if (
        suggestion.state === "withdrawn" ||
        !["reserved", "failed", "missing"].includes(suggestion.deliveryState)
      ) {
        result = { status: "unavailable", suggestion };
        return;
      }
      const previousDeliveryState = suggestion.deliveryState;
      this.db
        .prepare(
          `UPDATE suggestions
           SET delivery_state = 'posted', channel_id = ?, message_id = ?,
               thread_id = ?, failure_reason = NULL, updated_at = ?
           WHERE guild_id = ? AND suggestion_id = ? AND updated_at = ?`,
        )
        .run(
          channelId,
          messageId,
          threadId,
          utcNow(),
          this.guildId,
          id,
          suggestion.updatedAt,
        );
      const current = this.requireSuggestion(id);
      this.appendEventWithin(id, {
        type:
          previousDeliveryState === "reserved"
            ? "submission_posted"
            : "rebound",
        details: { channelId, messageId, threadId },
      });
      result = { status: "posted", suggestion: current };
    });
    bind.immediate();
    return requireResult<SuggestionDeliveryResult>(
      result,
      "Suggestion delivery binding",
    );
  }

  public failSuggestionDelivery(
    suggestionId: string,
    reason: string,
  ): SuggestionDeliveryResult {
    const id = requireOpaqueId(suggestionId, "suggestion ID");
    const failureReason = normalizeText(
      reason,
      1,
      1_000,
      "Suggestion delivery failure",
    );
    let result: SuggestionDeliveryResult | null = null;
    const fail = this.db.transaction(() => {
      const suggestion = this.getSuggestionById(id);
      if (!suggestion) {
        result = { status: "not-found", suggestion: null };
        return;
      }
      if (suggestion.deliveryState === "failed") {
        result = { status: "already-failed", suggestion };
        return;
      }
      if (suggestion.deliveryState !== "reserved") {
        result = { status: "unavailable", suggestion };
        return;
      }
      this.db
        .prepare(
          `UPDATE suggestions
           SET delivery_state = 'failed', channel_id = NULL, message_id = NULL,
               thread_id = NULL, failure_reason = ?, updated_at = ?
           WHERE guild_id = ? AND suggestion_id = ? AND delivery_state = 'reserved'`,
        )
        .run(failureReason, utcNow(), this.guildId, id);
      this.appendEventWithin(id, {
        type: "submission_failed",
        actorId: suggestion.authorId,
        details: { reason: failureReason },
      });
      result = {
        status: "failed",
        suggestion: this.requireSuggestion(id),
      };
    });
    fail.immediate();
    return requireResult<SuggestionDeliveryResult>(
      result,
      "Suggestion delivery failure",
    );
  }

  public markSuggestionDeliveryMissing(
    suggestionId: string,
    actorId?: string | null,
  ): SuggestionDeliveryResult {
    const id = requireOpaqueId(suggestionId, "suggestion ID");
    const actor = normalizeNullableSnowflake(actorId, "actor ID");
    let result: SuggestionDeliveryResult | null = null;
    const mark = this.db.transaction(() => {
      const suggestion = this.getSuggestionById(id);
      if (!suggestion) {
        result = { status: "not-found", suggestion: null };
        return;
      }
      if (suggestion.deliveryState === "missing") {
        result = { status: "already-missing", suggestion };
        return;
      }
      if (suggestion.deliveryState !== "posted") {
        result = { status: "unavailable", suggestion };
        return;
      }
      this.db
        .prepare(
          `UPDATE suggestions SET delivery_state = 'missing', updated_at = ?
           WHERE guild_id = ? AND suggestion_id = ? AND delivery_state = 'posted'`,
        )
        .run(utcNow(), this.guildId, id);
      this.appendEventWithin(id, {
        type: "recovery_noted",
        actorId: actor,
        details: { reason: "Tracked suggestion message is missing" },
      });
      result = { status: "missing", suggestion: this.requireSuggestion(id) };
    });
    mark.immediate();
    return requireResult<SuggestionDeliveryResult>(
      result,
      "Suggestion missing-delivery update",
    );
  }

  public toggleVote(
    suggestionId: string,
    voterId: string,
    vote: SuggestionVoteValue,
  ): SuggestionVoteResult {
    const id = requireOpaqueId(suggestionId, "suggestion ID");
    const voter = assertDiscordSnowflake(voterId, "voter ID");
    const normalizedVote = normalizeVote(vote);
    let result: SuggestionVoteResult | null = null;
    const update = this.db.transaction(() => {
      const suggestion = this.getSuggestionById(id);
      if (!suggestion) {
        result = unavailableVoteResult("not-found", null, zeroVoteCounts());
        return;
      }
      if (
        suggestion.deliveryState !== "posted" ||
        !["open", "under-review"].includes(suggestion.state)
      ) {
        result = unavailableVoteResult(
          "unavailable",
          suggestion,
          this.getVoteCounts(id),
        );
        return;
      }
      const configuration = this.getConfiguration();
      if (!configuration?.allowSelfVotes && suggestion.authorId === voter) {
        result = unavailableVoteResult(
          "self-vote",
          suggestion,
          this.getVoteCounts(id),
        );
        return;
      }
      const existing = this.getVote(id, voter);
      const now = utcNow();
      let status: "added" | "switched" | "removed" | "unchanged";
      let storedVote: SuggestionVote | null;
      if (existing?.vote === normalizedVote) {
        this.db
          .prepare(
            `DELETE FROM suggestion_votes
             WHERE guild_id = ? AND suggestion_id = ? AND voter_id = ?`,
          )
          .run(this.guildId, id, voter);
        status = "removed";
        storedVote = null;
      } else if (existing) {
        this.db
          .prepare(
            `UPDATE suggestion_votes SET vote = ?, updated_at = ?
             WHERE guild_id = ? AND suggestion_id = ? AND voter_id = ?`,
          )
          .run(normalizedVote, now, this.guildId, id, voter);
        status = "switched";
        storedVote = this.requireVote(id, voter);
      } else {
        this.db
          .prepare(
            `INSERT INTO suggestion_votes (
               guild_id, suggestion_id, voter_id, vote, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(this.guildId, id, voter, normalizedVote, now, now);
        status = "added";
        storedVote = this.requireVote(id, voter);
      }
      this.appendEventWithin(id, {
        type: "vote_changed",
        actorId: voter,
        details: {
          previous: existing?.vote ?? null,
          current: storedVote?.vote ?? null,
        },
      });
      result = {
        status,
        suggestion: this.requireSuggestion(id),
        vote: storedVote,
        counts: this.getVoteCounts(id),
      };
    });
    update.immediate();
    return requireResult<SuggestionVoteResult>(
      result,
      "Suggestion vote update",
    );
  }

  public reviewSuggestion(
    suggestionId: string,
    input: SuggestionReviewInput,
  ): SuggestionTransitionResult {
    const id = requireOpaqueId(suggestionId, "suggestion ID");
    const nextState = normalizeReviewState(input.state);
    const reviewerId = assertDiscordSnowflake(input.reviewerId, "reviewer ID");
    const reason = normalizeText(
      input.reason,
      1,
      1_000,
      "Suggestion review reason",
    );
    let result: SuggestionTransitionResult | null = null;
    const transition = this.db.transaction(() => {
      const suggestion = this.getSuggestionById(id);
      if (!suggestion) {
        result = { status: "not-found", suggestion: null };
        return;
      }
      if (
        suggestion.state === nextState &&
        suggestion.reviewerId === reviewerId &&
        suggestion.reviewReason === reason
      ) {
        result = { status: "unchanged", suggestion };
        return;
      }
      if (!canReviewTransition(suggestion.state, nextState)) {
        result = { status: "unavailable", suggestion };
        return;
      }
      const now = utcNow();
      this.db
        .prepare(
          `UPDATE suggestions
           SET state = ?, reviewer_id = ?, review_reason = ?, reviewed_at = ?,
               updated_at = ?
           WHERE guild_id = ? AND suggestion_id = ? AND state = ?`,
        )
        .run(
          nextState,
          reviewerId,
          reason,
          now,
          now,
          this.guildId,
          id,
          suggestion.state,
        );
      this.appendEventWithin(id, {
        type: "state_changed",
        actorId: reviewerId,
        details: { from: suggestion.state, to: nextState, reason },
      });
      result = { status: "changed", suggestion: this.requireSuggestion(id) };
    });
    transition.immediate();
    return requireResult<SuggestionTransitionResult>(
      result,
      "Suggestion review transition",
    );
  }

  public withdrawSuggestion(
    suggestionId: string,
    authorId: string,
  ): SuggestionTransitionResult {
    const id = requireOpaqueId(suggestionId, "suggestion ID");
    const author = assertDiscordSnowflake(authorId, "suggestion author ID");
    let result: SuggestionTransitionResult | null = null;
    const withdraw = this.db.transaction(() => {
      const suggestion = this.getSuggestionById(id);
      if (!suggestion) {
        result = { status: "not-found", suggestion: null };
        return;
      }
      if (suggestion.authorId !== author) {
        result = { status: "unavailable", suggestion };
        return;
      }
      if (suggestion.state === "withdrawn") {
        result = { status: "unchanged", suggestion };
        return;
      }
      if (!["open", "under-review"].includes(suggestion.state)) {
        result = { status: "unavailable", suggestion };
        return;
      }
      const now = utcNow();
      this.db
        .prepare(
          `UPDATE suggestions
           SET state = 'withdrawn', reviewer_id = NULL, review_reason = NULL,
               reviewed_at = NULL, withdrawn_at = ?, updated_at = ?
           WHERE guild_id = ? AND suggestion_id = ? AND state IN ('open', 'under-review')`,
        )
        .run(now, now, this.guildId, id);
      this.appendEventWithin(id, {
        type: "withdrawn",
        actorId: author,
        details: {},
      });
      result = { status: "changed", suggestion: this.requireSuggestion(id) };
    });
    withdraw.immediate();
    return requireResult<SuggestionTransitionResult>(
      result,
      "Suggestion withdrawal",
    );
  }

  public getSuggestionById(suggestionId: string): SuggestionRecord | null {
    const id = normalizeOpaqueId(suggestionId);
    if (!id) return null;
    const row = this.db
      .prepare(
        "SELECT * FROM suggestions WHERE guild_id = ? AND suggestion_id = ?",
      )
      .get(this.guildId, id) as SuggestionRow | undefined;
    return row ? parseSuggestion(row) : null;
  }

  public getSuggestionByNumber(
    suggestionNumber: number,
  ): SuggestionRecord | null {
    const number = normalizePositiveInteger(
      suggestionNumber,
      "suggestion number",
    );
    const row = this.db
      .prepare(
        "SELECT * FROM suggestions WHERE guild_id = ? AND suggestion_number = ?",
      )
      .get(this.guildId, number) as SuggestionRow | undefined;
    return row ? parseSuggestion(row) : null;
  }

  public getSuggestionByMessage(
    channelId: string,
    messageId: string,
  ): SuggestionRecord | null {
    const channel = assertDiscordSnowflake(channelId, "channel ID");
    const message = assertDiscordSnowflake(messageId, "message ID");
    const row = this.db
      .prepare(
        `SELECT * FROM suggestions
         WHERE guild_id = ? AND channel_id = ? AND message_id = ?`,
      )
      .get(this.guildId, channel, message) as SuggestionRow | undefined;
    return row ? parseSuggestion(row) : null;
  }

  public listSuggestions(
    options: {
      state?: SuggestionState;
      authorId?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): SuggestionRecord[] {
    const state =
      options.state === undefined
        ? null
        : normalizeSuggestionState(options.state);
    const authorId =
      options.authorId === undefined
        ? null
        : assertDiscordSnowflake(options.authorId, "author ID");
    const limit = normalizeListLimit(options.limit ?? DEFAULT_LIST_LIMIT);
    const offset = normalizeOffset(options.offset ?? 0);
    return (
      this.db
        .prepare(
          `SELECT * FROM suggestions
           WHERE guild_id = ?
             AND (? IS NULL OR state = ?)
             AND (? IS NULL OR author_id = ?)
           ORDER BY suggestion_number DESC LIMIT ? OFFSET ?`,
        )
        .all(
          this.guildId,
          state,
          state,
          authorId,
          authorId,
          limit,
          offset,
        ) as SuggestionRow[]
    ).map(parseSuggestion);
  }

  public getVote(suggestionId: string, voterId: string): SuggestionVote | null {
    const id = normalizeOpaqueId(suggestionId);
    if (!id) return null;
    const voter = assertDiscordSnowflake(voterId, "voter ID");
    const row = this.db
      .prepare(
        `SELECT * FROM suggestion_votes
         WHERE guild_id = ? AND suggestion_id = ? AND voter_id = ?`,
      )
      .get(this.guildId, id, voter) as SuggestionVoteRow | undefined;
    return row ? parseVote(row) : null;
  }

  public getVoteCounts(suggestionId: string): SuggestionVoteCounts {
    const id = requireOpaqueId(suggestionId, "suggestion ID");
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END), 0) AS upvotes,
           COALESCE(SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END), 0) AS downvotes
         FROM suggestion_votes WHERE guild_id = ? AND suggestion_id = ?`,
      )
      .get(this.guildId, id) as { upvotes: number; downvotes: number };
    const upvotes = Number(row.upvotes);
    const downvotes = Number(row.downvotes);
    return { upvotes, downvotes, score: upvotes - downvotes };
  }

  public appendEvent(
    suggestionId: string,
    input: SuggestionEventInput,
  ): SuggestionEvent | null {
    const id = normalizeOpaqueId(suggestionId);
    if (!id) return null;
    let result: SuggestionEvent | null = null;
    const append = this.db.transaction(() => {
      if (!this.getSuggestionById(id)) return;
      result = this.appendEventWithin(id, input);
    });
    append.immediate();
    return result;
  }

  public listEvents(
    suggestionId: string,
    limit = MAX_EVENTS_PER_SUGGESTION,
    offset = 0,
  ): SuggestionEvent[] {
    const id = requireOpaqueId(suggestionId, "suggestion ID");
    const boundedLimit = normalizeListLimit(limit);
    const boundedOffset = normalizeOffset(offset);
    return (
      this.db
        .prepare(
          `SELECT * FROM suggestion_events
           WHERE guild_id = ? AND suggestion_id = ?
           ORDER BY event_number LIMIT ? OFFSET ?`,
        )
        .all(
          this.guildId,
          id,
          boundedLimit,
          boundedOffset,
        ) as SuggestionEventRow[]
    ).map(parseEvent);
  }

  private appendEventWithin(
    suggestionId: string,
    input: SuggestionEventInput,
  ): SuggestionEvent {
    const type = normalizeEventType(input.type);
    const actorId = normalizeNullableSnowflake(input.actorId, "event actor ID");
    const detailsJson = serializeBoundedJson(
      input.details ?? {},
      4_000,
      "event details",
    );
    const next = this.db
      .prepare(
        `SELECT COALESCE(MAX(event_number), 0) + 1 AS event_number
         FROM suggestion_events WHERE guild_id = ? AND suggestion_id = ?`,
      )
      .get(this.guildId, suggestionId) as { event_number: number };
    const eventNumber = normalizePositiveInteger(
      next.event_number,
      "event number",
    );
    const eventId = allocateOpaqueId((id) =>
      Boolean(
        this.db
          .prepare(
            `SELECT 1 FROM suggestion_events
             WHERE guild_id = ? AND suggestion_id = ? AND event_id = ?`,
          )
          .get(this.guildId, suggestionId, id),
      ),
    );
    const now = utcNow();
    this.db
      .prepare(
        `INSERT INTO suggestion_events (
           guild_id, suggestion_id, event_id, event_number, event_type,
           actor_id, details_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.guildId,
        suggestionId,
        eventId,
        eventNumber,
        type,
        actorId,
        detailsJson,
        now,
      );
    this.trimEvents(suggestionId);
    const row = this.db
      .prepare(
        `SELECT * FROM suggestion_events
         WHERE guild_id = ? AND suggestion_id = ? AND event_id = ?`,
      )
      .get(this.guildId, suggestionId, eventId) as SuggestionEventRow;
    return parseEvent(row);
  }

  private trimEvents(suggestionId: string): void {
    this.db
      .prepare(
        `DELETE FROM suggestion_events
         WHERE guild_id = ? AND suggestion_id = ? AND event_id IN (
           SELECT event_id FROM suggestion_events
           WHERE guild_id = ? AND suggestion_id = ?
           ORDER BY event_number DESC LIMIT -1 OFFSET ?
         )`,
      )
      .run(
        this.guildId,
        suggestionId,
        this.guildId,
        suggestionId,
        MAX_EVENTS_PER_SUGGESTION,
      );
  }

  private nextSuggestionNumber(): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(suggestion_number), 0) + 1 AS value
         FROM suggestions WHERE guild_id = ?`,
      )
      .get(this.guildId) as { value: number };
    return normalizePositiveInteger(row.value, "suggestion number");
  }

  private allocateSuggestionId(): string {
    return allocateOpaqueId((id) => this.getSuggestionById(id) !== null);
  }

  private requireConfiguration(): SuggestionConfiguration {
    const value = this.getConfiguration();
    if (!value) throw new Error("Suggestion configuration was not persisted");
    return value;
  }

  private requireSuggestion(suggestionId: string): SuggestionRecord {
    const value = this.getSuggestionById(suggestionId);
    if (!value) throw new Error("Suggestion was not persisted");
    return value;
  }

  private requireVote(suggestionId: string, voterId: string): SuggestionVote {
    const value = this.getVote(suggestionId, voterId);
    if (!value) throw new Error("Suggestion vote was not persisted");
    return value;
  }
}

function normalizeConfiguration(
  input: SuggestionConfigurationInput,
): Omit<SuggestionConfiguration, "guildId" | "createdAt" | "updatedAt"> {
  const enabled = input.enabled ?? true;
  const createThreads = input.createThreads ?? false;
  const allowSelfVotes = input.allowSelfVotes ?? false;
  for (const [label, value] of [
    ["enabled", enabled],
    ["createThreads", createThreads],
    ["allowSelfVotes", allowSelfVotes],
  ] as const) {
    if (typeof value !== "boolean") {
      throw new TypeError(`Suggestion ${label} must be a boolean`);
    }
  }
  return {
    enabled,
    suggestionChannelId: assertDiscordSnowflake(
      input.suggestionChannelId,
      "suggestion channel ID",
    ),
    reviewChannelId: normalizeNullableSnowflake(
      input.reviewChannelId,
      "review channel ID",
    ),
    reviewerRoleId: assertDiscordSnowflake(
      input.reviewerRoleId,
      "reviewer role ID",
    ),
    createThreads,
    cooldownLimit: normalizeInteger(
      input.cooldownLimit ?? 3,
      1,
      10,
      "cooldown limit",
    ),
    cooldownWindowSeconds: normalizeInteger(
      input.cooldownWindowSeconds ?? 600,
      60,
      86_400,
      "cooldown window",
    ),
    allowSelfVotes,
    bindingsVerifiedAt: normalizeOptionalTimestamp(input.bindingsVerifiedAt),
  };
}

function parseConfiguration(
  row: SuggestionConfigurationRow,
): SuggestionConfiguration {
  return {
    guildId: row.guild_id,
    enabled: Boolean(row.enabled),
    suggestionChannelId: row.suggestion_channel_id,
    reviewChannelId: row.review_channel_id,
    reviewerRoleId: row.reviewer_role_id,
    createThreads: Boolean(row.create_threads),
    cooldownLimit: row.cooldown_limit,
    cooldownWindowSeconds: row.cooldown_window_seconds,
    allowSelfVotes: Boolean(row.allow_self_votes),
    bindingsVerifiedAt: row.bindings_verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseSuggestion(row: SuggestionRow): SuggestionRecord {
  return {
    guildId: row.guild_id,
    suggestionId: row.suggestion_id,
    suggestionNumber: row.suggestion_number,
    authorId: row.author_id,
    title: row.title,
    details: row.details,
    state: normalizeSuggestionState(row.state),
    deliveryState: normalizeDeliveryState(row.delivery_state),
    channelId: row.channel_id,
    messageId: row.message_id,
    threadId: row.thread_id,
    reviewerId: row.reviewer_id,
    reviewReason: row.review_reason,
    reviewedAt: row.reviewed_at,
    withdrawnAt: row.withdrawn_at,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseVote(row: SuggestionVoteRow): SuggestionVote {
  return {
    guildId: row.guild_id,
    suggestionId: row.suggestion_id,
    voterId: row.voter_id,
    vote: normalizeVote(row.vote),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseEvent(row: SuggestionEventRow): SuggestionEvent {
  return {
    guildId: row.guild_id,
    suggestionId: row.suggestion_id,
    eventId: row.event_id,
    eventNumber: row.event_number,
    type: normalizeEventType(row.event_type),
    actorId: row.actor_id,
    details: parseJson(row.details_json, "suggestion event details"),
    createdAt: row.created_at,
  };
}

function unavailableVoteResult(
  status: "not-found" | "unavailable" | "self-vote",
  suggestion: SuggestionRecord | null,
  counts: SuggestionVoteCounts,
): SuggestionVoteResult {
  return {
    status,
    suggestion,
    vote: null,
    counts,
  };
}

function zeroVoteCounts(): SuggestionVoteCounts {
  return { upvotes: 0, downvotes: 0, score: 0 };
}

function canReviewTransition(
  current: SuggestionState,
  next: SuggestionReviewInput["state"],
): boolean {
  if (current === next) return true;
  switch (current) {
    case "open":
      return ["under-review", "accepted", "declined"].includes(next);
    case "under-review":
      return ["accepted", "declined"].includes(next);
    case "accepted":
      return next === "implemented";
    case "declined":
    case "implemented":
    case "withdrawn":
      return false;
  }
}

function normalizeReviewState(value: unknown): SuggestionReviewInput["state"] {
  if (
    !["under-review", "accepted", "declined", "implemented"].includes(
      String(value),
    )
  ) {
    throw new TypeError("Unsupported suggestion review state");
  }
  return value as SuggestionReviewInput["state"];
}

function normalizeSuggestionState(value: unknown): SuggestionState {
  if (!(SUGGESTION_STATES as readonly unknown[]).includes(value)) {
    throw new TypeError("Unsupported suggestion state");
  }
  return value as SuggestionState;
}

function normalizeDeliveryState(value: unknown): DeliveryState {
  if (!(DELIVERY_STATES as readonly unknown[]).includes(value)) {
    throw new TypeError("Unsupported suggestion delivery state");
  }
  return value as DeliveryState;
}

function normalizeEventType(value: unknown): SuggestionEventType {
  if (!(SUGGESTION_EVENT_TYPES as readonly unknown[]).includes(value)) {
    throw new TypeError("Unsupported suggestion event type");
  }
  return value as SuggestionEventType;
}

function normalizeVote(value: unknown): SuggestionVoteValue {
  if (value !== -1 && value !== 1) {
    throw new TypeError("Suggestion vote must be -1 or 1");
  }
  return value;
}

function normalizeText(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be text`);
  const normalized = value.normalize("NFKC").trim();
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError(`${label} cannot contain control characters`);
  }
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new RangeError(
      `${label} must contain between ${minimum} and ${maximum} characters`,
    );
  }
  return normalized;
}

function normalizeNullableSnowflake(
  value: string | null | undefined,
  label: string,
): string | null {
  return value === undefined || value === null
    ? null
    : assertDiscordSnowflake(value, label);
}

function normalizeOptionalTimestamp(
  value: string | null | undefined,
): string | null {
  if (value === undefined || value === null) return null;
  if (!value.trim() || !Number.isFinite(Date.parse(value))) {
    throw new TypeError("Expected an ISO timestamp");
  }
  return new Date(value).toISOString();
}

function normalizeInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function normalizePositiveInteger(value: number, label: string): number {
  return normalizeInteger(value, 1, 2_147_483_647, label);
}

function normalizeListLimit(value: number): number {
  return normalizeInteger(value, 1, MAX_LIST_LIMIT, "list limit");
}

function normalizeOffset(value: number): number {
  return normalizeInteger(value, 0, 2_147_483_647, "list offset");
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
  if (
    serialized === undefined ||
    serialized.length < 2 ||
    serialized.length > maximumBytes ||
    Buffer.byteLength(serialized, "utf8") > maximumBytes
  ) {
    throw new RangeError(`${label} exceeds the ${maximumBytes}-byte limit`);
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

function allocateOpaqueId(exists: (id: string) => boolean): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = randomBytes(9).toString("base64url");
    if (!exists(id)) return id;
  }
  throw new Error("Unable to allocate a unique opaque ID");
}

function normalizeOpaqueId(value: unknown): string | null {
  return typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 24 &&
    /^[A-Za-z0-9_-]+$/.test(value)
    ? value
    : null;
}

function requireOpaqueId(value: unknown, label: string): string {
  const id = normalizeOpaqueId(value);
  if (!id)
    throw new TypeError(`${label} must be an 8-24 character opaque token`);
  return id;
}

function utcNow(): string {
  return new Date().toISOString();
}

function requireResult<T>(result: T | null, label: string): T {
  if (result === null) throw new Error(`${label} completed without a result`);
  return result;
}
