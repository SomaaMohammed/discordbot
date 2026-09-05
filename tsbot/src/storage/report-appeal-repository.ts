import type { DatabaseConnection } from "./database.js";
import { assertDiscordSnowflake } from "../guild-settings.js";
import {
  CASE_APPEAL_STATES,
  MEMBER_REPORT_CATEGORIES,
  MEMBER_REPORT_STATES,
  type CaseAppeal,
  type CaseAppealDecisionInput,
  type CaseAppealEvent,
  type CaseAppealOverturnFinalizeResult,
  type CaseAppealReservationInput,
  type CaseAppealReservationResult,
  type CaseAppealState,
  type CaseAppealTransitionResult,
  type DeliveryAttempt,
  type DeliveryAttemptInput,
  type DeliveryAttemptTransitionResult,
  type DeliveryClaimResult,
  type MemberReport,
  type MemberReportCategory,
  type MemberReportDecisionInput,
  type MemberReportEvent,
  type MemberReportReservationInput,
  type MemberReportReservationResult,
  type MemberReportState,
  type MemberReportTransitionResult,
  type ModerationCase,
  type TimeoutAppealRemovalCheckpointInput,
  type TimeoutAppealRemovalCheckpointProof,
  type TimeoutAppealRemovalCheckpointResult,
} from "../types.js";
import { createOpaqueStorageId } from "./operational-repository.js";
import { ModerationCaseRepository } from "./moderation-case-repository.js";

const MAX_LIST_LIMIT = 100;
const MAX_RECORDS = 50_000;
const MAX_EVENTS_PER_PARENT = 100;
const DELIVERY_CLAIM_SECONDS = 120;

export interface DeliveryBindingInput {
  reviewChannelId: string;
  reviewMessageId: string;
  claimId: string;
  expectedUpdatedAt?: string;
}

export interface DeliveryFailureInput {
  failureCode: string;
  claimId?: string;
  expectedUpdatedAt?: string;
}

export interface DeliveryMissingInput {
  expectedUpdatedAt?: string;
}

export interface DeliveryOrphanCheckpointInput {
  reviewChannelId: string;
  reviewMessageId: string;
  claimId: string;
  failureCode: string;
  expectedUpdatedAt: string;
}

export interface MemberReportActorInput {
  reviewerId: string;
  expectedUpdatedAt?: string;
}

export interface MemberReportWithdrawInput {
  reporterId: string;
  expectedUpdatedAt?: string;
}

export interface CaseAppealActorInput {
  reviewerId: string;
  expectedUpdatedAt?: string;
}

export interface ReviewClaimTakeoverInput {
  reviewerId: string;
  previousReviewerId: string;
  reason: string;
  expectedUpdatedAt: string;
}

export interface ReviewClaimReleaseInput {
  actorId: string;
  previousReviewerId: string;
  reason: string;
  expectedUpdatedAt: string;
}

export interface CaseAppealWithdrawInput {
  appellantId: string;
  expectedUpdatedAt?: string;
}

export interface MemberReportListFilter {
  reporterId?: string;
  targetUserId?: string;
  states?: readonly MemberReportState[];
  limit?: number;
  offset?: number;
}

export interface CaseAppealListFilter {
  appellantId?: string;
  caseId?: string;
  states?: readonly CaseAppealState[];
  limit?: number;
  offset?: number;
}

export class MemberReportRepository {
  public constructor(
    private readonly db: DatabaseConnection,
    public readonly guildId: string,
  ) {}

  public reserveReport(
    input: MemberReportReservationInput,
  ): MemberReportReservationResult {
    const normalized = normalizeReportReservation(input, this.guildId);
    let result: MemberReportReservationResult | null = null;
    const reserve = this.db.transaction(() => {
      const configuration = this.db
        .prepare(
          `SELECT reports_enabled, report_bindings_verified_at,
                  report_cooldown_limit, report_cooldown_window_seconds
           FROM moderation_configurations WHERE guild_id = ?`,
        )
        .get(this.guildId) as
        | {
            reports_enabled: number;
            report_bindings_verified_at: string | null;
            report_cooldown_limit: number;
            report_cooldown_window_seconds: number;
          }
        | undefined;
      if (
        !configuration ||
        !configuration.reports_enabled ||
        !configuration.report_bindings_verified_at
      ) {
        result = { status: "disabled", report: null };
        return;
      }
      const cutoff = new Date(
        Date.now() - configuration.report_cooldown_window_seconds * 1_000,
      ).toISOString();
      const recentCount = Number(
        (
          this.db
            .prepare(
              `SELECT COUNT(*) AS count FROM member_reports
               WHERE guild_id = ? AND reporter_id = ? AND created_at >= ?`,
            )
            .get(this.guildId, normalized.reporterId, cutoff) as {
            count: number;
          }
        ).count,
      );
      if (recentCount >= configuration.report_cooldown_limit) {
        const oldest = this.db
          .prepare(
            `SELECT created_at FROM member_reports
             WHERE guild_id = ? AND reporter_id = ? AND created_at >= ?
             ORDER BY created_at ASC LIMIT 1`,
          )
          .get(this.guildId, normalized.reporterId, cutoff) as
          { created_at: string } | undefined;
        const retryAt = new Date(
          Date.parse(oldest?.created_at ?? utcNow()) +
            configuration.report_cooldown_window_seconds * 1_000,
        ).toISOString();
        result = { status: "cooldown", report: null, recentCount, retryAt };
        return;
      }
      assertCapacity(this.db, "member_reports", this.guildId, MAX_RECORDS);
      const now = utcNow();
      const reportId = createOpaqueStorageId();
      const reportNumber = nextNumber(
        this.db,
        "member_reports",
        "report_number",
        this.guildId,
      );
      this.db
        .prepare(
          `INSERT INTO member_reports (
             guild_id, report_id, report_number, reporter_id, target_user_id,
             category, explanation, evidence_guild_id, evidence_channel_id,
             evidence_message_id, state, delivery_state, review_channel_id,
             review_message_id, claimed_by, claimed_at, decision_by,
             decision_reason, decided_at, linked_case_id, withdrawn_at,
             failure_code, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', 'reserved',
                     NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                     NULL, ?, ?)`,
        )
        .run(
          this.guildId,
          reportId,
          reportNumber,
          normalized.reporterId,
          normalized.targetUserId,
          normalized.category,
          normalized.explanation,
          normalized.evidenceGuildId,
          normalized.evidenceChannelId,
          normalized.evidenceMessageId,
          now,
          now,
        );
      this.appendEventWithin(
        reportId,
        "submission-reserved",
        normalized.reporterId,
        {
          reportNumber,
          category: normalized.category,
        },
      );
      result = { status: "created", report: this.requireReport(reportId) };
    });
    reserve.immediate();
    if (!result) throw new Error("Report reservation returned no result");
    return result;
  }

  public claimDelivery(
    reportId: string,
    input: DeliveryMissingInput = {},
  ): DeliveryClaimResult<MemberReport> {
    const id = requireOpaqueId(reportId, "report ID");
    return claimDeliveryLease(
      this.db,
      this.guildId,
      "member_reports",
      "report_id",
      id,
      input.expectedUpdatedAt,
      () => this.getReportById(id),
    );
  }

  public getDeliveryAttempt(reportId: string): DeliveryAttempt | null {
    const id = normalizeOpaqueId(reportId);
    if (!id) return null;
    return readDeliveryAttempt(
      this.db,
      this.guildId,
      "member_reports",
      "report_id",
      id,
    );
  }

  public beginDeliveryAttempt(
    reportId: string,
    input: DeliveryAttemptInput,
  ): DeliveryAttemptTransitionResult<MemberReport> {
    const id = requireOpaqueId(reportId, "report ID");
    return beginDeliveryAttemptLease(
      this.db,
      this.guildId,
      "member_reports",
      "report_id",
      id,
      input,
      () => this.getReportById(id),
      (attempt, previousAttempt) =>
        this.appendEventWithin(id, "recovery-noted", null, {
          reason: previousAttempt
            ? "delivery-attempt-rotated"
            : "delivery-attempt-started",
          channelId: attempt.channelId,
        }),
    );
  }

  public bindDelivery(
    reportId: string,
    input: DeliveryBindingInput,
  ): MemberReportTransitionResult {
    const id = requireOpaqueId(reportId, "report ID");
    const channelId = assertDiscordSnowflake(
      input.reviewChannelId,
      "review channel ID",
    );
    const messageId = assertDiscordSnowflake(
      input.reviewMessageId,
      "review message ID",
    );
    const claimId = requireOpaqueId(input.claimId, "delivery claim ID");
    const existing = this.getReportById(id);
    if (
      existing?.deliveryState === "posted" &&
      existing.reviewChannelId === channelId &&
      existing.reviewMessageId === messageId
    ) {
      return { status: "unchanged", report: existing };
    }
    return this.mutate(id, input.expectedUpdatedAt, (current) => {
      const recovering = current.deliveryState === "missing";
      const previousChannelId = current.reviewChannelId;
      const previousMessageId = current.reviewMessageId;
      if (
        current.deliveryState === "posted" &&
        current.reviewChannelId === channelId &&
        current.reviewMessageId === messageId
      ) {
        return { status: "unchanged", report: current };
      }
      if (!["reserved", "failed", "missing"].includes(current.deliveryState)) {
        return { status: "unavailable", report: current };
      }
      const attempt = this.getDeliveryAttempt(id);
      if (attempt && attempt.channelId !== channelId) {
        return { status: "unavailable", report: current };
      }
      if (
        !hasCurrentDeliveryClaim(
          this.db,
          this.guildId,
          "member_reports",
          "report_id",
          id,
          claimId,
        )
      ) {
        return { status: "unavailable", report: current };
      }
      const now = nextTimestamp(current.updatedAt);
      this.db
        .prepare(
          `UPDATE member_reports SET delivery_state = 'posted',
             review_channel_id = ?, review_message_id = ?, failure_code = NULL,
             delivery_claim_id = NULL, delivery_claim_expires_at = NULL,
             delivery_attempt_id = NULL, delivery_attempt_channel_id = NULL,
             delivery_attempt_started_at = NULL,
             updated_at = ? WHERE guild_id = ? AND report_id = ?`,
        )
        .run(channelId, messageId, now, this.guildId, id);
      this.appendEventWithin(
        id,
        recovering ? "rebound" : "submission-posted",
        null,
        {
          previousChannelId,
          previousMessageId,
          channelId,
          messageId,
        },
      );
      return { status: "changed", report: this.requireReport(id) };
    });
  }

  public failDelivery(
    reportId: string,
    input: DeliveryFailureInput,
  ): MemberReportTransitionResult {
    const id = requireOpaqueId(reportId, "report ID");
    const failureCode = safeText(input.failureCode, 1, 100, "failure code");
    return this.mutate(id, input.expectedUpdatedAt, (current) => {
      if (current.deliveryState === "posted") {
        return { status: "unavailable", report: current };
      }
      if (
        current.deliveryState === "failed" &&
        current.failureCode === failureCode &&
        this.getDeliveryAttempt(id) === null
      ) {
        return { status: "unchanged", report: current };
      }
      if (
        !canReleaseDeliveryClaim(
          this.db,
          this.guildId,
          "member_reports",
          "report_id",
          id,
          input.claimId,
        )
      ) {
        return { status: "unavailable", report: current };
      }
      const now = nextTimestamp(current.updatedAt);
      this.db
        .prepare(
          `UPDATE member_reports SET delivery_state = 'failed',
             review_channel_id = NULL, review_message_id = NULL,
             failure_code = ?, delivery_claim_id = NULL,
             delivery_claim_expires_at = NULL, delivery_attempt_id = NULL,
             delivery_attempt_channel_id = NULL,
             delivery_attempt_started_at = NULL, updated_at = ?
           WHERE guild_id = ? AND report_id = ?`,
        )
        .run(failureCode, now, this.guildId, id);
      this.appendEventWithin(id, "submission-failed", null, { failureCode });
      return { status: "changed", report: this.requireReport(id) };
    });
  }

  public markDeliveryMissing(
    reportId: string,
    input: DeliveryMissingInput,
  ): MemberReportTransitionResult {
    const id = requireOpaqueId(reportId, "report ID");
    return this.mutate(id, input.expectedUpdatedAt, (current) => {
      if (current.deliveryState === "missing") {
        return { status: "unchanged", report: current };
      }
      if (current.deliveryState !== "posted") {
        return { status: "unavailable", report: current };
      }
      this.db
        .prepare(
          `UPDATE member_reports SET delivery_state = 'missing',
             delivery_claim_id = NULL, delivery_claim_expires_at = NULL,
             updated_at = ?
           WHERE guild_id = ? AND report_id = ?`,
        )
        .run(nextTimestamp(current.updatedAt), this.guildId, id);
      this.appendEventWithin(id, "recovery-noted", null, {
        reason: "message-missing",
        channelId: current.reviewChannelId,
        messageId: current.reviewMessageId,
      });
      return { status: "changed", report: this.requireReport(id) };
    });
  }

  public checkpointOrphanDelivery(
    reportId: string,
    input: DeliveryOrphanCheckpointInput,
  ): MemberReportTransitionResult {
    const id = requireOpaqueId(reportId, "report ID");
    const channelId = assertDiscordSnowflake(
      input.reviewChannelId,
      "review channel ID",
    );
    const messageId = assertDiscordSnowflake(
      input.reviewMessageId,
      "review message ID",
    );
    const claimId = requireOpaqueId(input.claimId, "delivery claim ID");
    const failureCode = safeText(input.failureCode, 1, 100, "failure code");
    const existing = this.getReportById(id);
    if (
      existing &&
      ((existing.deliveryState === "posted" &&
        existing.reviewChannelId === channelId &&
        existing.reviewMessageId === messageId) ||
        (existing.deliveryState === "missing" &&
          existing.reviewChannelId === channelId &&
          existing.reviewMessageId === messageId &&
          existing.failureCode === failureCode &&
          this.getDeliveryAttempt(id) === null))
    ) {
      return { status: "unchanged", report: existing };
    }
    return this.mutate(id, input.expectedUpdatedAt, (current) => {
      if (
        current.deliveryState === "posted" &&
        current.reviewChannelId === channelId &&
        current.reviewMessageId === messageId
      ) {
        return { status: "unchanged", report: current };
      }
      if (
        current.deliveryState === "missing" &&
        current.reviewChannelId === channelId &&
        current.reviewMessageId === messageId &&
        current.failureCode === failureCode &&
        this.getDeliveryAttempt(id) === null
      ) {
        return { status: "unchanged", report: current };
      }
      const attempt = this.getDeliveryAttempt(id);
      if (
        !["reserved", "failed", "missing"].includes(current.deliveryState) ||
        (attempt !== null && attempt.channelId !== channelId) ||
        (current.reviewMessageId !== null &&
          (current.reviewChannelId !== channelId ||
            current.reviewMessageId !== messageId)) ||
        !hasCurrentDeliveryClaim(
          this.db,
          this.guildId,
          "member_reports",
          "report_id",
          id,
          claimId,
        )
      ) {
        return { status: "unavailable", report: current };
      }
      const now = nextTimestamp(current.updatedAt);
      const updated = this.db
        .prepare(
          `UPDATE member_reports SET delivery_state = 'missing',
             review_channel_id = ?, review_message_id = ?, failure_code = ?,
             delivery_claim_id = NULL, delivery_claim_expires_at = NULL,
             delivery_attempt_id = NULL, delivery_attempt_channel_id = NULL,
             delivery_attempt_started_at = NULL,
             updated_at = ? WHERE guild_id = ? AND report_id = ?
             AND updated_at = ? AND delivery_claim_id = ?`,
        )
        .run(
          channelId,
          messageId,
          failureCode,
          now,
          this.guildId,
          id,
          current.updatedAt,
          claimId,
        );
      if (updated.changes !== 1) {
        return { status: "conflict", report: this.requireReport(id) };
      }
      this.appendEventWithin(id, "recovery-noted", null, {
        reason: "orphan-delete-ambiguous",
        channelId,
        messageId,
        failureCode,
      });
      return { status: "changed", report: this.requireReport(id) };
    });
  }

  public claimReport(
    reportId: string,
    input: MemberReportActorInput,
  ): MemberReportTransitionResult {
    const id = requireOpaqueId(reportId, "report ID");
    const reviewerId = assertDiscordSnowflake(input.reviewerId, "reviewer ID");
    const existing = this.getReportById(id);
    if (
      existing?.state === "under-review" &&
      existing.claimedBy === reviewerId
    ) {
      return { status: "unchanged", report: existing };
    }
    return this.mutate(id, input.expectedUpdatedAt, (current) => {
      if (
        current.state === "under-review" &&
        current.claimedBy === reviewerId
      ) {
        return { status: "unchanged", report: current };
      }
      if (current.state !== "submitted" || current.deliveryState !== "posted") {
        return { status: "unavailable", report: current };
      }
      const now = nextTimestamp(current.updatedAt);
      this.db
        .prepare(
          `UPDATE member_reports SET state = 'under-review', claimed_by = ?,
             claimed_at = ?, updated_at = ? WHERE guild_id = ? AND report_id = ?`,
        )
        .run(reviewerId, now, now, this.guildId, id);
      this.appendEventWithin(id, "claimed", reviewerId, {});
      return { status: "changed", report: this.requireReport(id) };
    });
  }

  public takeOverClaim(
    reportId: string,
    input: ReviewClaimTakeoverInput,
  ): MemberReportTransitionResult {
    const id = requireOpaqueId(reportId, "report ID");
    return this.reassignClaim(id, {
      actorId: assertDiscordSnowflake(input.reviewerId, "reviewer ID"),
      previousReviewerId: assertDiscordSnowflake(
        input.previousReviewerId,
        "previous reviewer ID",
      ),
      nextReviewerId: assertDiscordSnowflake(input.reviewerId, "reviewer ID"),
      reason: safeText(input.reason, 1, 1_000, "claim takeover reason"),
      expectedUpdatedAt: input.expectedUpdatedAt,
    });
  }

  public releaseClaim(
    reportId: string,
    input: ReviewClaimReleaseInput,
  ): MemberReportTransitionResult {
    return this.reassignClaim(requireOpaqueId(reportId, "report ID"), {
      actorId: assertDiscordSnowflake(input.actorId, "actor ID"),
      previousReviewerId: assertDiscordSnowflake(
        input.previousReviewerId,
        "previous reviewer ID",
      ),
      nextReviewerId: null,
      reason: safeText(input.reason, 1, 1_000, "claim release reason"),
      expectedUpdatedAt: input.expectedUpdatedAt,
    });
  }

  public decideReport(
    reportId: string,
    input: MemberReportDecisionInput,
  ): MemberReportTransitionResult {
    const id = requireOpaqueId(reportId, "report ID");
    const state = normalizeReportDecisionState(input.state);
    const reviewerId = assertDiscordSnowflake(input.reviewerId, "reviewer ID");
    const reason = safeText(input.reason, 1, 1_000, "decision reason");
    const linkedCaseId =
      input.linkedCaseId == null
        ? null
        : requireOpaqueId(input.linkedCaseId, "linked case ID");
    if (state !== "resolved" && linkedCaseId) {
      throw new TypeError(
        "Only a resolved report may reference a moderation case",
      );
    }
    const existing = this.getReportById(id);
    if (
      existing?.state === state &&
      existing.decisionBy === reviewerId &&
      existing.decisionReason === reason &&
      existing.linkedCaseId === linkedCaseId
    ) {
      return { status: "unchanged", report: existing };
    }
    return this.mutate(id, input.expectedUpdatedAt, (current) => {
      if (linkedCaseId) {
        const linkedCase = this.db
          .prepare(
            `SELECT target_user_id, action_type, status, created_at
             FROM moderation_cases
             WHERE guild_id = ? AND case_id = ?`,
          )
          .get(this.guildId, linkedCaseId) as
          | {
              target_user_id: string;
              action_type: string;
              status: string;
              created_at: string;
            }
          | undefined;
        if (
          !linkedCase ||
          linkedCase.target_user_id !== current.targetUserId ||
          !["active", "completed"].includes(linkedCase.status) ||
          ![
            "warning",
            "timeout",
            "kick",
            "ban",
            "automod-warning",
            "automod-timeout",
          ].includes(linkedCase.action_type) ||
          Date.parse(linkedCase.created_at) < Date.parse(current.createdAt)
        ) {
          return { status: "unavailable", report: current };
        }
      }
      if (
        current.state === state &&
        current.decisionBy === reviewerId &&
        current.decisionReason === reason &&
        current.linkedCaseId === linkedCaseId
      ) {
        return { status: "unchanged", report: current };
      }
      if (
        current.state !== "under-review" ||
        current.claimedBy !== reviewerId
      ) {
        return { status: "unavailable", report: current };
      }
      const now = nextTimestamp(current.updatedAt);
      this.db
        .prepare(
          `UPDATE member_reports SET state = ?, claimed_by = COALESCE(claimed_by, ?),
             claimed_at = COALESCE(claimed_at, ?), decision_by = ?,
             decision_reason = ?, decided_at = ?, linked_case_id = ?, updated_at = ?
           WHERE guild_id = ? AND report_id = ?`,
        )
        .run(
          state,
          reviewerId,
          now,
          reviewerId,
          reason,
          now,
          linkedCaseId,
          now,
          this.guildId,
          id,
        );
      this.appendEventWithin(id, "decision-recorded", reviewerId, {
        state,
        linkedCaseId,
      });
      return { status: "changed", report: this.requireReport(id) };
    });
  }

  public withdrawReport(
    reportId: string,
    input: MemberReportWithdrawInput,
  ): MemberReportTransitionResult {
    const id = requireOpaqueId(reportId, "report ID");
    const reporterId = assertDiscordSnowflake(input.reporterId, "reporter ID");
    const existing = this.getReportById(id);
    if (existing?.state === "withdrawn" && existing.reporterId === reporterId) {
      return { status: "unchanged", report: existing };
    }
    return this.mutate(id, input.expectedUpdatedAt, (current) => {
      if (current.reporterId !== reporterId) {
        return { status: "unavailable", report: current };
      }
      if (current.state === "withdrawn") {
        return { status: "unchanged", report: current };
      }
      if (current.state !== "submitted") {
        return { status: "unavailable", report: current };
      }
      if (this.getDeliveryAttempt(id)) {
        return { status: "unavailable", report: current };
      }
      const now = nextTimestamp(current.updatedAt);
      this.db
        .prepare(
          `UPDATE member_reports SET state = 'withdrawn', withdrawn_at = ?,
             updated_at = ? WHERE guild_id = ? AND report_id = ?`,
        )
        .run(now, now, this.guildId, id);
      this.appendEventWithin(id, "withdrawn", reporterId, {});
      return { status: "changed", report: this.requireReport(id) };
    });
  }

  public getReportById(reportId: string): MemberReport | null {
    const id = normalizeOpaqueId(reportId);
    if (!id) return null;
    const row = this.db
      .prepare(
        "SELECT * FROM member_reports WHERE guild_id = ? AND report_id = ?",
      )
      .get(this.guildId, id) as Record<string, unknown> | undefined;
    return row ? parseMemberReportRow(row) : null;
  }

  public getReportByNumber(reportNumber: number): MemberReport | null {
    const row = this.db
      .prepare(
        "SELECT * FROM member_reports WHERE guild_id = ? AND report_number = ?",
      )
      .get(this.guildId, positiveInteger(reportNumber, "report number")) as
      Record<string, unknown> | undefined;
    return row ? parseMemberReportRow(row) : null;
  }

  public listReports(filter: MemberReportListFilter = {}): MemberReport[] {
    const { sql, values } = buildListQuery(
      "member_reports",
      "report_number",
      this.guildId,
      filter,
      ["reporterId", "reporter_id", "reporter ID"],
      ["targetUserId", "target_user_id", "target user ID"],
      "states",
      "state",
      (value) => normalizeReportState(value),
    );
    return (
      this.db.prepare(sql).all(...values) as Array<Record<string, unknown>>
    ).map(parseMemberReportRow);
  }

  public listEvents(
    reportId: string,
    listLimit = 100,
    listOffset = 0,
  ): MemberReportEvent[] {
    const id = requireOpaqueId(reportId, "report ID");
    return (
      this.db
        .prepare(
          `SELECT * FROM member_report_events WHERE guild_id = ? AND report_id = ?
           ORDER BY event_number DESC LIMIT ? OFFSET ?`,
        )
        .all(this.guildId, id, limit(listLimit), offset(listOffset)) as Array<
        Record<string, unknown>
      >
    ).map(parseMemberReportEventRow);
  }

  public listRecoverable(limitValue = 100): MemberReport[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM member_reports WHERE guild_id = ?
             AND delivery_state IN ('reserved', 'failed', 'missing')
             AND state IN ('submitted', 'under-review')
           ORDER BY report_number ASC LIMIT ?`,
        )
        .all(this.guildId, limit(limitValue)) as Array<Record<string, unknown>>
    ).map(parseMemberReportRow);
  }

  private mutate(
    reportId: string,
    expectedUpdatedAt: string | undefined,
    callback: (current: MemberReport) => MemberReportTransitionResult,
  ): MemberReportTransitionResult {
    let result: MemberReportTransitionResult | null = null;
    const transaction = this.db.transaction(() => {
      const current = this.getReportById(reportId);
      if (!current) {
        result = { status: "not-found", report: null };
        return;
      }
      if (expectedUpdatedAt && expectedUpdatedAt !== current.updatedAt) {
        result = { status: "conflict", report: current };
        return;
      }
      result = callback(current);
    });
    transaction.immediate();
    if (!result) throw new Error("Report transition returned no result");
    return result;
  }

  private reassignClaim(
    reportId: string,
    input: {
      actorId: string;
      previousReviewerId: string;
      nextReviewerId: string | null;
      reason: string;
      expectedUpdatedAt: string;
    },
  ): MemberReportTransitionResult {
    if (input.nextReviewerId === input.previousReviewerId) {
      const current = this.getReportById(reportId);
      if (!current) return { status: "not-found", report: null };
      if (current.updatedAt !== input.expectedUpdatedAt)
        return { status: "conflict", report: current };
      return current.state === "under-review" &&
        current.claimedBy === input.previousReviewerId
        ? { status: "unchanged", report: current }
        : { status: "unavailable", report: current };
    }
    let result: MemberReportTransitionResult | null = null;
    const transition = this.db.transaction(() => {
      const current = this.getReportById(reportId);
      if (!current)
        return void (result = { status: "not-found", report: null });
      if (current.updatedAt !== input.expectedUpdatedAt) {
        return void (result = { status: "conflict", report: current });
      }
      if (
        current.state !== "under-review" ||
        current.claimedBy !== input.previousReviewerId
      ) {
        return void (result = { status: "unavailable", report: current });
      }
      const now = nextTimestamp(current.updatedAt);
      const nextState = input.nextReviewerId ? "under-review" : "submitted";
      const updated = this.db
        .prepare(
          `UPDATE member_reports SET state = ?, claimed_by = ?, claimed_at = ?,
             updated_at = ? WHERE guild_id = ? AND report_id = ?
             AND state = 'under-review' AND claimed_by = ? AND updated_at = ?`,
        )
        .run(
          nextState,
          input.nextReviewerId,
          input.nextReviewerId ? now : null,
          now,
          this.guildId,
          reportId,
          input.previousReviewerId,
          current.updatedAt,
        );
      if (updated.changes !== 1) {
        return void (result = {
          status: "conflict",
          report: this.requireReport(reportId),
        });
      }
      this.appendEventWithin(
        reportId,
        input.nextReviewerId ? "claim-reassigned" : "claim-released",
        input.actorId,
        {
          previousReviewerId: input.previousReviewerId,
          reviewerId: input.nextReviewerId,
          reason: input.reason,
        },
      );
      result = { status: "changed", report: this.requireReport(reportId) };
    });
    transition.immediate();
    if (!result) throw new Error("Report claim transition returned no result");
    return result;
  }

  private appendEventWithin(
    reportId: string,
    type: string,
    actorId: string | null,
    details: unknown,
  ): void {
    appendBoundedEvent(
      this.db,
      this.guildId,
      "member_report_events",
      "report_id",
      reportId,
      type,
      actorId,
      details,
    );
  }

  private requireReport(reportId: string): MemberReport {
    const report = this.getReportById(reportId);
    if (!report) throw new Error("Member report was not persisted");
    return report;
  }
}

export class CaseAppealRepository {
  public constructor(
    private readonly db: DatabaseConnection,
    public readonly guildId: string,
  ) {}

  public reserveAppeal(
    input: CaseAppealReservationInput,
  ): CaseAppealReservationResult {
    const caseId = requireOpaqueId(input.caseId, "case ID");
    const appellantId = assertDiscordSnowflake(
      input.appellantId,
      "appellant ID",
    );
    const explanation = safeText(
      input.explanation,
      10,
      2_000,
      "appeal explanation",
    );
    let result: CaseAppealReservationResult | null = null;
    const reserve = this.db.transaction(() => {
      const configuration = this.db
        .prepare(
          `SELECT appeals_enabled, appeal_bindings_verified_at
           FROM moderation_configurations WHERE guild_id = ?`,
        )
        .get(this.guildId) as
        | {
            appeals_enabled: number;
            appeal_bindings_verified_at: string | null;
          }
        | undefined;
      if (
        !configuration?.appeals_enabled ||
        !configuration.appeal_bindings_verified_at
      ) {
        result = { status: "disabled", appeal: null };
        return;
      }
      const existing = this.getAppealByCase(caseId);
      if (existing) {
        result = { status: "existing", appeal: existing };
        return;
      }
      const moderationCase = this.db
        .prepare(
          `SELECT target_user_id, status, action_type FROM moderation_cases
           WHERE guild_id = ? AND case_id = ?`,
        )
        .get(this.guildId, caseId) as
        | { target_user_id: string; status: string; action_type: string }
        | undefined;
      if (
        !moderationCase ||
        moderationCase.target_user_id !== appellantId ||
        !isCaseAppealEligible(moderationCase.action_type, moderationCase.status)
      ) {
        result = { status: "ineligible", appeal: null };
        return;
      }
      assertCapacity(this.db, "case_appeals", this.guildId, MAX_RECORDS);
      const now = utcNow();
      const appealId = createOpaqueStorageId();
      const appealNumber = nextNumber(
        this.db,
        "case_appeals",
        "appeal_number",
        this.guildId,
      );
      this.db
        .prepare(
          `INSERT INTO case_appeals (
             guild_id, appeal_id, appeal_number, case_id, appellant_id,
             explanation, state, delivery_state, review_channel_id,
             review_message_id, claimed_by, claimed_at, decision_by,
             decision_reason, decided_at, reversal_case_id, withdrawn_at,
             failure_code, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'submitted', 'reserved', NULL, NULL,
                     NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          this.guildId,
          appealId,
          appealNumber,
          caseId,
          appellantId,
          explanation,
          now,
          now,
        );
      this.appendEventWithin(appealId, "submission-reserved", appellantId, {
        appealNumber,
        caseId,
      });
      result = { status: "created", appeal: this.requireAppeal(appealId) };
    });
    reserve.immediate();
    if (!result) throw new Error("Appeal reservation returned no result");
    return result;
  }

  public claimDelivery(
    appealId: string,
    input: DeliveryMissingInput = {},
  ): DeliveryClaimResult<CaseAppeal> {
    const id = requireOpaqueId(appealId, "appeal ID");
    return claimDeliveryLease(
      this.db,
      this.guildId,
      "case_appeals",
      "appeal_id",
      id,
      input.expectedUpdatedAt,
      () => this.getAppealById(id),
    );
  }

  public getDeliveryAttempt(appealId: string): DeliveryAttempt | null {
    const id = normalizeOpaqueId(appealId);
    if (!id) return null;
    return readDeliveryAttempt(
      this.db,
      this.guildId,
      "case_appeals",
      "appeal_id",
      id,
    );
  }

  public beginDeliveryAttempt(
    appealId: string,
    input: DeliveryAttemptInput,
  ): DeliveryAttemptTransitionResult<CaseAppeal> {
    const id = requireOpaqueId(appealId, "appeal ID");
    return beginDeliveryAttemptLease(
      this.db,
      this.guildId,
      "case_appeals",
      "appeal_id",
      id,
      input,
      () => this.getAppealById(id),
      (attempt, previousAttempt) =>
        this.appendEventWithin(id, "recovery-noted", null, {
          reason: previousAttempt
            ? "delivery-attempt-rotated"
            : "delivery-attempt-started",
          channelId: attempt.channelId,
        }),
    );
  }

  public bindDelivery(
    appealId: string,
    input: DeliveryBindingInput,
  ): CaseAppealTransitionResult {
    const id = requireOpaqueId(appealId, "appeal ID");
    const channelId = assertDiscordSnowflake(
      input.reviewChannelId,
      "review channel ID",
    );
    const messageId = assertDiscordSnowflake(
      input.reviewMessageId,
      "review message ID",
    );
    const claimId = requireOpaqueId(input.claimId, "delivery claim ID");
    const existing = this.getAppealById(id);
    if (
      existing?.deliveryState === "posted" &&
      existing.reviewChannelId === channelId &&
      existing.reviewMessageId === messageId
    ) {
      return { status: "unchanged", appeal: existing };
    }
    return this.mutate(id, input.expectedUpdatedAt, (current) => {
      const recovering = current.deliveryState === "missing";
      const previousChannelId = current.reviewChannelId;
      const previousMessageId = current.reviewMessageId;
      if (
        current.deliveryState === "posted" &&
        current.reviewChannelId === channelId &&
        current.reviewMessageId === messageId
      ) {
        return { status: "unchanged", appeal: current };
      }
      if (!["reserved", "failed", "missing"].includes(current.deliveryState)) {
        return { status: "unavailable", appeal: current };
      }
      const attempt = this.getDeliveryAttempt(id);
      if (attempt && attempt.channelId !== channelId) {
        return { status: "unavailable", appeal: current };
      }
      if (
        !hasCurrentDeliveryClaim(
          this.db,
          this.guildId,
          "case_appeals",
          "appeal_id",
          id,
          claimId,
        )
      ) {
        return { status: "unavailable", appeal: current };
      }
      this.db
        .prepare(
          `UPDATE case_appeals SET delivery_state = 'posted', review_channel_id = ?,
           review_message_id = ?, failure_code = NULL, delivery_claim_id = NULL,
           delivery_claim_expires_at = NULL, delivery_attempt_id = NULL,
           delivery_attempt_channel_id = NULL,
           delivery_attempt_started_at = NULL, updated_at = ?
         WHERE guild_id = ? AND appeal_id = ?`,
        )
        .run(
          channelId,
          messageId,
          nextTimestamp(current.updatedAt),
          this.guildId,
          id,
        );
      this.appendEventWithin(
        id,
        recovering ? "rebound" : "submission-posted",
        null,
        {
          previousChannelId,
          previousMessageId,
          channelId,
          messageId,
        },
      );
      return { status: "changed", appeal: this.requireAppeal(id) };
    });
  }

  public failDelivery(
    appealId: string,
    input: DeliveryFailureInput,
  ): CaseAppealTransitionResult {
    const id = requireOpaqueId(appealId, "appeal ID");
    const failureCode = safeText(input.failureCode, 1, 100, "failure code");
    return this.mutate(id, input.expectedUpdatedAt, (current) => {
      if (current.deliveryState === "posted")
        return { status: "unavailable", appeal: current };
      if (
        current.deliveryState === "failed" &&
        current.failureCode === failureCode &&
        this.getDeliveryAttempt(id) === null
      )
        return { status: "unchanged", appeal: current };
      if (
        !canReleaseDeliveryClaim(
          this.db,
          this.guildId,
          "case_appeals",
          "appeal_id",
          id,
          input.claimId,
        )
      )
        return { status: "unavailable", appeal: current };
      this.db
        .prepare(
          `UPDATE case_appeals SET delivery_state = 'failed', review_channel_id = NULL,
           review_message_id = NULL, failure_code = ?, delivery_claim_id = NULL,
           delivery_claim_expires_at = NULL, delivery_attempt_id = NULL,
           delivery_attempt_channel_id = NULL,
           delivery_attempt_started_at = NULL, updated_at = ?
         WHERE guild_id = ? AND appeal_id = ?`,
        )
        .run(failureCode, nextTimestamp(current.updatedAt), this.guildId, id);
      this.appendEventWithin(id, "submission-failed", null, { failureCode });
      return { status: "changed", appeal: this.requireAppeal(id) };
    });
  }

  public markDeliveryMissing(
    appealId: string,
    input: DeliveryMissingInput,
  ): CaseAppealTransitionResult {
    const id = requireOpaqueId(appealId, "appeal ID");
    return this.mutate(id, input.expectedUpdatedAt, (current) => {
      if (current.deliveryState === "missing")
        return { status: "unchanged", appeal: current };
      if (current.deliveryState !== "posted")
        return { status: "unavailable", appeal: current };
      this.db
        .prepare(
          `UPDATE case_appeals SET delivery_state = 'missing',
           delivery_claim_id = NULL, delivery_claim_expires_at = NULL, updated_at = ?
         WHERE guild_id = ? AND appeal_id = ?`,
        )
        .run(nextTimestamp(current.updatedAt), this.guildId, id);
      this.appendEventWithin(id, "recovery-noted", null, {
        reason: "message-missing",
        channelId: current.reviewChannelId,
        messageId: current.reviewMessageId,
      });
      return { status: "changed", appeal: this.requireAppeal(id) };
    });
  }

  public checkpointOrphanDelivery(
    appealId: string,
    input: DeliveryOrphanCheckpointInput,
  ): CaseAppealTransitionResult {
    const id = requireOpaqueId(appealId, "appeal ID");
    const channelId = assertDiscordSnowflake(
      input.reviewChannelId,
      "review channel ID",
    );
    const messageId = assertDiscordSnowflake(
      input.reviewMessageId,
      "review message ID",
    );
    const claimId = requireOpaqueId(input.claimId, "delivery claim ID");
    const failureCode = safeText(input.failureCode, 1, 100, "failure code");
    const existing = this.getAppealById(id);
    if (
      existing &&
      ((existing.deliveryState === "posted" &&
        existing.reviewChannelId === channelId &&
        existing.reviewMessageId === messageId) ||
        (existing.deliveryState === "missing" &&
          existing.reviewChannelId === channelId &&
          existing.reviewMessageId === messageId &&
          existing.failureCode === failureCode &&
          this.getDeliveryAttempt(id) === null))
    ) {
      return { status: "unchanged", appeal: existing };
    }
    return this.mutate(id, input.expectedUpdatedAt, (current) => {
      if (
        current.deliveryState === "posted" &&
        current.reviewChannelId === channelId &&
        current.reviewMessageId === messageId
      ) {
        return { status: "unchanged", appeal: current };
      }
      if (
        current.deliveryState === "missing" &&
        current.reviewChannelId === channelId &&
        current.reviewMessageId === messageId &&
        current.failureCode === failureCode &&
        this.getDeliveryAttempt(id) === null
      ) {
        return { status: "unchanged", appeal: current };
      }
      const attempt = this.getDeliveryAttempt(id);
      if (
        !["reserved", "failed", "missing"].includes(current.deliveryState) ||
        (attempt !== null && attempt.channelId !== channelId) ||
        (current.reviewMessageId !== null &&
          (current.reviewChannelId !== channelId ||
            current.reviewMessageId !== messageId)) ||
        !hasCurrentDeliveryClaim(
          this.db,
          this.guildId,
          "case_appeals",
          "appeal_id",
          id,
          claimId,
        )
      ) {
        return { status: "unavailable", appeal: current };
      }
      const now = nextTimestamp(current.updatedAt);
      const updated = this.db
        .prepare(
          `UPDATE case_appeals SET delivery_state = 'missing',
             review_channel_id = ?, review_message_id = ?, failure_code = ?,
             delivery_claim_id = NULL, delivery_claim_expires_at = NULL,
             delivery_attempt_id = NULL, delivery_attempt_channel_id = NULL,
             delivery_attempt_started_at = NULL,
             updated_at = ? WHERE guild_id = ? AND appeal_id = ?
             AND updated_at = ? AND delivery_claim_id = ?`,
        )
        .run(
          channelId,
          messageId,
          failureCode,
          now,
          this.guildId,
          id,
          current.updatedAt,
          claimId,
        );
      if (updated.changes !== 1) {
        return { status: "conflict", appeal: this.requireAppeal(id) };
      }
      this.appendEventWithin(id, "recovery-noted", null, {
        reason: "orphan-delete-ambiguous",
        channelId,
        messageId,
        failureCode,
      });
      return { status: "changed", appeal: this.requireAppeal(id) };
    });
  }

  public claimAppeal(
    appealId: string,
    input: CaseAppealActorInput,
  ): CaseAppealTransitionResult {
    const id = requireOpaqueId(appealId, "appeal ID");
    const reviewerId = assertDiscordSnowflake(input.reviewerId, "reviewer ID");
    const existing = this.getAppealById(id);
    if (existing?.state === "under-review" && existing.claimedBy === reviewerId)
      return { status: "unchanged", appeal: existing };
    return this.mutate(id, input.expectedUpdatedAt, (current) => {
      if (current.state === "under-review" && current.claimedBy === reviewerId)
        return { status: "unchanged", appeal: current };
      if (current.state !== "submitted" || current.deliveryState !== "posted")
        return { status: "unavailable", appeal: current };
      const now = nextTimestamp(current.updatedAt);
      this.db
        .prepare(
          `UPDATE case_appeals SET state = 'under-review', claimed_by = ?,
           claimed_at = ?, updated_at = ? WHERE guild_id = ? AND appeal_id = ?`,
        )
        .run(reviewerId, now, now, this.guildId, id);
      this.appendEventWithin(id, "claimed", reviewerId, {});
      return { status: "changed", appeal: this.requireAppeal(id) };
    });
  }

  public takeOverClaim(
    appealId: string,
    input: ReviewClaimTakeoverInput,
  ): CaseAppealTransitionResult {
    const id = requireOpaqueId(appealId, "appeal ID");
    return this.reassignClaim(id, {
      actorId: assertDiscordSnowflake(input.reviewerId, "reviewer ID"),
      previousReviewerId: assertDiscordSnowflake(
        input.previousReviewerId,
        "previous reviewer ID",
      ),
      nextReviewerId: assertDiscordSnowflake(input.reviewerId, "reviewer ID"),
      reason: safeText(input.reason, 1, 1_000, "claim takeover reason"),
      expectedUpdatedAt: input.expectedUpdatedAt,
    });
  }

  public releaseClaim(
    appealId: string,
    input: ReviewClaimReleaseInput,
  ): CaseAppealTransitionResult {
    return this.reassignClaim(requireOpaqueId(appealId, "appeal ID"), {
      actorId: assertDiscordSnowflake(input.actorId, "actor ID"),
      previousReviewerId: assertDiscordSnowflake(
        input.previousReviewerId,
        "previous reviewer ID",
      ),
      nextReviewerId: null,
      reason: safeText(input.reason, 1, 1_000, "claim release reason"),
      expectedUpdatedAt: input.expectedUpdatedAt,
    });
  }

  public decideAppeal(
    appealId: string,
    input: CaseAppealDecisionInput,
  ): CaseAppealTransitionResult {
    const id = requireOpaqueId(appealId, "appeal ID");
    const state = normalizeAppealDecisionState(input.state);
    const reviewerId = assertDiscordSnowflake(input.reviewerId, "reviewer ID");
    const reason = safeText(input.reason, 1, 1_000, "decision reason");
    const reversalCaseId =
      input.reversalCaseId == null
        ? null
        : requireOpaqueId(input.reversalCaseId, "reversal case ID");
    if (state === "upheld" && reversalCaseId)
      throw new TypeError("Upheld appeals cannot reference a reversal case");
    const existing = this.getAppealById(id);
    if (
      existing?.state === state &&
      existing.decisionBy === reviewerId &&
      existing.decisionReason === reason &&
      existing.reversalCaseId === reversalCaseId
    )
      return { status: "unchanged", appeal: existing };
    return this.mutate(id, input.expectedUpdatedAt, (current) => {
      if (
        current.state === state &&
        current.decisionBy === reviewerId &&
        current.decisionReason === reason &&
        current.reversalCaseId === reversalCaseId
      )
        return { status: "unchanged", appeal: current };
      if (current.state !== "under-review" || current.claimedBy !== reviewerId)
        return { status: "unavailable", appeal: current };
      const now = nextTimestamp(current.updatedAt);
      this.db
        .prepare(
          `UPDATE case_appeals SET state = ?, claimed_by = COALESCE(claimed_by, ?),
           claimed_at = COALESCE(claimed_at, ?), decision_by = ?,
           decision_reason = ?, decided_at = ?, reversal_case_id = ?, updated_at = ?
         WHERE guild_id = ? AND appeal_id = ?`,
        )
        .run(
          state,
          reviewerId,
          now,
          reviewerId,
          reason,
          now,
          reversalCaseId,
          now,
          this.guildId,
          id,
        );
      this.appendEventWithin(id, "decision-recorded", reviewerId, {
        state,
        reversalCaseId,
      });
      return { status: "changed", appeal: this.requireAppeal(id) };
    });
  }

  public finalizeCaseOverturn(
    appealId: string,
    input: {
      reviewerId: string;
      decisionReason: string;
      caseReason: string;
      reversalCaseId?: string | null;
      appealExpectedUpdatedAt?: string;
      originalExpectedUpdatedAt?: string;
    },
  ): CaseAppealOverturnFinalizeResult {
    const id = requireOpaqueId(appealId, "appeal ID");
    const reviewerId = assertDiscordSnowflake(input.reviewerId, "reviewer ID");
    const decisionReason = safeText(
      input.decisionReason,
      1,
      1_000,
      "appeal decision reason",
    );
    const caseReason = safeText(
      input.caseReason,
      1,
      1_000,
      "case overturn reason",
    );
    const reversalCaseId =
      input.reversalCaseId == null
        ? null
        : requireOpaqueId(input.reversalCaseId, "reversal case ID");
    const cases = new ModerationCaseRepository(this.db, this.guildId);
    let result: CaseAppealOverturnFinalizeResult | null = null;
    const finalize = this.db.transaction(() => {
      const appeal = this.getAppealById(id);
      const originalCase = appeal ? cases.getCaseById(appeal.caseId) : null;
      const reversalCase = reversalCaseId
        ? cases.getCaseById(reversalCaseId)
        : null;
      if (!appeal || !originalCase || (reversalCaseId && !reversalCase)) {
        result = {
          status: "not-found",
          appeal,
          originalCase,
          reversalCase,
        };
        return;
      }
      if (
        appeal.state === "overturned" &&
        originalCase.status === "overturned" &&
        originalCase.overturnedBy === reviewerId &&
        originalCase.overturnReason === caseReason &&
        appeal.decisionBy === reviewerId &&
        appeal.decisionReason === decisionReason &&
        appeal.reversalCaseId === reversalCaseId
      ) {
        result = {
          status: "unchanged",
          appeal,
          originalCase,
          reversalCase,
        };
        return;
      }
      if (
        (input.appealExpectedUpdatedAt &&
          input.appealExpectedUpdatedAt !== appeal.updatedAt) ||
        (input.originalExpectedUpdatedAt &&
          input.originalExpectedUpdatedAt !== originalCase.updatedAt)
      ) {
        result = {
          status: "conflict",
          appeal,
          originalCase,
          reversalCase,
        };
        return;
      }
      if (
        appeal.state !== "under-review" ||
        appeal.claimedBy !== reviewerId ||
        !isNonTimeoutAppealOverturnEligible(
          originalCase.actionType,
          originalCase.status,
        )
      ) {
        result = {
          status: "unavailable",
          appeal,
          originalCase,
          reversalCase,
        };
        return;
      }
      if (
        originalCase.actionType === "ban" &&
        (!reversalCase ||
          reversalCase.actionType !== "unban" ||
          reversalCase.targetUserId !== originalCase.targetUserId ||
          reversalCase.status !== "completed" ||
          reversalCase.relatedCaseId !== originalCase.caseId)
      ) {
        result = {
          status: "unavailable",
          appeal,
          originalCase,
          reversalCase,
        };
        return;
      }
      if (originalCase.actionType !== "ban" && reversalCaseId) {
        result = {
          status: "unavailable",
          appeal,
          originalCase,
          reversalCase,
        };
        return;
      }
      const caseResult = cases.overturnCase(originalCase.caseId, {
        actorId: reviewerId,
        reason: caseReason,
        expectedUpdatedAt: originalCase.updatedAt,
      });
      if (caseResult.status !== "changed") {
        throw new Error("Original case could not be atomically overturned");
      }
      const appealResult = this.decideAppeal(id, {
        state: "overturned",
        reviewerId,
        reason: decisionReason,
        reversalCaseId,
        expectedUpdatedAt: appeal.updatedAt,
      });
      if (appealResult.status !== "changed") {
        throw new Error("Appeal could not be atomically decided");
      }
      result = {
        status: "changed",
        appeal: appealResult.appeal,
        originalCase: caseResult.case,
        reversalCase,
      };
    });
    finalize.immediate();
    if (!result)
      throw new Error("Appeal overturn finalization returned no result");
    return result;
  }

  /**
   * Durably records that Discord has confirmed a timeout removal while the
   * appeal/case transaction is still pending. The removal attempt deliberately
   * remains `failed`, so it is neither loggable nor represented as a completed
   * sanction until `finalizeTimeoutAppealOverturn` commits all three records.
   */
  public checkpointTimeoutAppealRemoval(
    appealId: string,
    removalCaseId: string,
    input: TimeoutAppealRemovalCheckpointInput,
  ): TimeoutAppealRemovalCheckpointResult {
    const id = requireOpaqueId(appealId, "appeal ID");
    const removalId = requireOpaqueId(removalCaseId, "timeout-removal case ID");
    const reviewerId = assertDiscordSnowflake(input.reviewerId, "reviewer ID");
    const originalExpiresAt = timestamp(
      input.originalExpiresAt,
      "original timeout expiry",
    );
    const cases = new ModerationCaseRepository(this.db, this.guildId);
    let result: TimeoutAppealRemovalCheckpointResult | null = null;
    const checkpoint = this.db.transaction(() => {
      const appeal = this.getAppealById(id);
      const originalCase = appeal ? cases.getCaseById(appeal.caseId) : null;
      const removalCase = cases.getCaseById(removalId);
      if (!appeal || !originalCase || !removalCase) {
        result = {
          status: "not-found",
          appeal,
          originalCase,
          removalCase,
        };
        return;
      }
      const proof: TimeoutAppealRemovalCheckpointProof = {
        kind: "timeout-appeal-removal-confirmed",
        appealId: id,
        originalCaseId: originalCase.caseId,
        originalExpiresAt,
        reviewerId,
      };
      const metadata = {
        recoveryCheckpoint: proof,
        discordAction: input.discordActionMetadata ?? {},
      };
      const encodedMetadata = serializeJson(metadata, 8_000);
      const existingProof = readTimeoutAppealRemovalCheckpoint(
        removalCase.discordActionMetadata,
      );
      const hasCheckpointEvent = Boolean(
        this.db
          .prepare(
            `SELECT 1 FROM moderation_case_events
             WHERE guild_id = ? AND case_id = ?
               AND event_type = 'action-confirmed-pending' LIMIT 1`,
          )
          .get(this.guildId, removalId),
      );
      if (
        removalCase.status === "failed" &&
        hasCheckpointEvent &&
        sameTimeoutAppealRemovalProof(existingProof, proof) &&
        serializeJson(removalCase.discordActionMetadata, 8_000) ===
          encodedMetadata
      ) {
        result = {
          status: "unchanged",
          appeal,
          originalCase,
          removalCase,
        };
        return;
      }
      if (
        input.appealExpectedUpdatedAt !== appeal.updatedAt ||
        input.removalExpectedUpdatedAt !== removalCase.updatedAt ||
        input.originalExpectedUpdatedAt !== originalCase.updatedAt
      ) {
        result = {
          status: "conflict",
          appeal,
          originalCase,
          removalCase,
        };
        return;
      }
      if (
        appeal.state !== "under-review" ||
        appeal.claimedBy !== reviewerId ||
        originalCase.actionType !== "timeout" ||
        originalCase.status !== "active" ||
        readCaseExpiry(originalCase) !== originalExpiresAt ||
        removalCase.status !== "failed" ||
        removalCase.actionType !== "timeout-removed" ||
        removalCase.source !== "appeal-review" ||
        removalCase.actorId !== reviewerId ||
        removalCase.targetUserId !== originalCase.targetUserId ||
        removalCase.relatedCaseId !== originalCase.caseId ||
        (originalCase.relatedCaseId !== null &&
          originalCase.relatedCaseId !== removalId)
      ) {
        result = {
          status: "unavailable",
          appeal,
          originalCase,
          removalCase,
        };
        return;
      }
      const now = nextTimestamp(removalCase.updatedAt);
      const updated = this.db
        .prepare(
          `UPDATE moderation_cases SET discord_action_metadata_json = ?,
             updated_at = ? WHERE guild_id = ? AND case_id = ?
             AND status = 'failed' AND updated_at = ?`,
        )
        .run(
          encodedMetadata,
          now,
          this.guildId,
          removalId,
          removalCase.updatedAt,
        );
      if (updated.changes !== 1) {
        result = {
          status: "conflict",
          appeal,
          originalCase,
          removalCase: cases.getCaseById(removalId) ?? removalCase,
        };
        return;
      }
      const event = cases.appendEvent(removalId, {
        type: "action-confirmed-pending",
        actorId: reviewerId,
        details: proof,
      });
      if (!event) {
        throw new Error("Timeout-removal checkpoint event was not persisted");
      }
      result = {
        status: "changed",
        appeal,
        originalCase,
        removalCase: cases.getCaseById(removalId)!,
      };
    });
    checkpoint.immediate();
    if (!result)
      throw new Error("Timeout appeal removal checkpoint returned no result");
    return result;
  }

  public finalizeTimeoutAppealOverturn(
    appealId: string,
    removalCaseId: string,
    input: {
      reviewerId: string;
      decisionReason: string;
      caseReason: string;
      discordActionMetadata?: unknown;
      appealExpectedUpdatedAt?: string;
      removalExpectedUpdatedAt?: string;
      originalExpectedUpdatedAt?: string;
    },
  ): CaseAppealOverturnFinalizeResult {
    const id = requireOpaqueId(appealId, "appeal ID");
    const removalId = requireOpaqueId(removalCaseId, "timeout-removal case ID");
    const reviewerId = assertDiscordSnowflake(input.reviewerId, "reviewer ID");
    const decisionReason = safeText(
      input.decisionReason,
      1,
      1_000,
      "appeal decision reason",
    );
    const caseReason = safeText(
      input.caseReason,
      1,
      1_000,
      "case overturn reason",
    );
    const cases = new ModerationCaseRepository(this.db, this.guildId);
    let result: CaseAppealOverturnFinalizeResult | null = null;
    const finalize = this.db.transaction(() => {
      const appeal = this.getAppealById(id);
      const originalCase = appeal ? cases.getCaseById(appeal.caseId) : null;
      const reversalCase = cases.getCaseById(removalId);
      if (!appeal || !originalCase || !reversalCase) {
        result = {
          status: "not-found",
          appeal,
          originalCase,
          reversalCase,
        };
        return;
      }
      if (
        appeal.state === "overturned" &&
        originalCase.status === "overturned" &&
        reversalCase.status === "completed" &&
        originalCase.overturnedBy === reviewerId &&
        originalCase.overturnReason === caseReason &&
        appeal.decisionBy === reviewerId &&
        appeal.decisionReason === decisionReason &&
        appeal.reversalCaseId === removalId &&
        originalCase.relatedCaseId === removalId &&
        reversalCase.relatedCaseId === originalCase.caseId
      ) {
        result = {
          status: "unchanged",
          appeal,
          originalCase,
          reversalCase,
        };
        return;
      }
      if (
        (input.appealExpectedUpdatedAt &&
          input.appealExpectedUpdatedAt !== appeal.updatedAt) ||
        appeal.state !== "under-review" ||
        appeal.claimedBy !== reviewerId
      ) {
        result = {
          status:
            input.appealExpectedUpdatedAt &&
            input.appealExpectedUpdatedAt !== appeal.updatedAt
              ? "conflict"
              : "unavailable",
          appeal,
          originalCase,
          reversalCase,
        };
        return;
      }
      const proof = readTimeoutAppealRemovalCheckpoint(
        reversalCase.discordActionMetadata,
      );
      const originalExpiresAt = readCaseExpiry(originalCase);
      const hasCheckpointEvent = Boolean(
        this.db
          .prepare(
            `SELECT 1 FROM moderation_case_events
             WHERE guild_id = ? AND case_id = ?
               AND event_type = 'action-confirmed-pending' LIMIT 1`,
          )
          .get(this.guildId, removalId),
      );
      if (
        !proof ||
        !hasCheckpointEvent ||
        proof.appealId !== id ||
        proof.originalCaseId !== originalCase.caseId ||
        proof.originalExpiresAt !== originalExpiresAt
      ) {
        result = {
          status: "unavailable",
          appeal,
          originalCase,
          reversalCase,
        };
        return;
      }
      const caseResult = cases.finalizeTimeoutAppealOverturn(removalId, {
        actorId: reviewerId,
        originalCaseId: originalCase.caseId,
        reason: caseReason,
        ...(input.discordActionMetadata === undefined
          ? {}
          : { discordActionMetadata: input.discordActionMetadata }),
        ...(input.removalExpectedUpdatedAt === undefined
          ? {}
          : { removalExpectedUpdatedAt: input.removalExpectedUpdatedAt }),
        ...(input.originalExpectedUpdatedAt === undefined
          ? {}
          : { originalExpectedUpdatedAt: input.originalExpectedUpdatedAt }),
      });
      if (caseResult.status !== "changed") {
        result = {
          status: caseResult.status,
          appeal,
          originalCase: caseResult.originalCase ?? originalCase,
          reversalCase: caseResult.removalCase ?? reversalCase,
        };
        return;
      }
      const appealResult = this.decideAppeal(id, {
        state: "overturned",
        reviewerId,
        reason: decisionReason,
        reversalCaseId: removalId,
        expectedUpdatedAt: appeal.updatedAt,
      });
      if (appealResult.status !== "changed") {
        throw new Error("Appeal could not be atomically decided");
      }
      result = {
        status: "changed",
        appeal: appealResult.appeal,
        originalCase: caseResult.originalCase,
        reversalCase: caseResult.removalCase,
      };
    });
    finalize.immediate();
    if (!result)
      throw new Error("Timeout appeal finalization returned no result");
    return result;
  }

  public withdrawAppeal(
    appealId: string,
    input: CaseAppealWithdrawInput,
  ): CaseAppealTransitionResult {
    const id = requireOpaqueId(appealId, "appeal ID");
    const appellantId = assertDiscordSnowflake(
      input.appellantId,
      "appellant ID",
    );
    const existing = this.getAppealById(id);
    if (existing?.state === "withdrawn" && existing.appellantId === appellantId)
      return { status: "unchanged", appeal: existing };
    return this.mutate(id, input.expectedUpdatedAt, (current) => {
      if (current.appellantId !== appellantId)
        return { status: "unavailable", appeal: current };
      if (current.state === "withdrawn")
        return { status: "unchanged", appeal: current };
      if (current.state !== "submitted")
        return { status: "unavailable", appeal: current };
      if (this.getDeliveryAttempt(id))
        return { status: "unavailable", appeal: current };
      const now = nextTimestamp(current.updatedAt);
      this.db
        .prepare(
          `UPDATE case_appeals SET state = 'withdrawn', withdrawn_at = ?, updated_at = ?
         WHERE guild_id = ? AND appeal_id = ?`,
        )
        .run(now, now, this.guildId, id);
      this.appendEventWithin(id, "withdrawn", appellantId, {});
      return { status: "changed", appeal: this.requireAppeal(id) };
    });
  }

  public getAppealById(appealId: string): CaseAppeal | null {
    const id = normalizeOpaqueId(appealId);
    if (!id) return null;
    const row = this.db
      .prepare(
        "SELECT * FROM case_appeals WHERE guild_id = ? AND appeal_id = ?",
      )
      .get(this.guildId, id) as Record<string, unknown> | undefined;
    return row ? parseCaseAppealRow(row) : null;
  }

  public getAppealByNumber(appealNumber: number): CaseAppeal | null {
    const row = this.db
      .prepare(
        "SELECT * FROM case_appeals WHERE guild_id = ? AND appeal_number = ?",
      )
      .get(this.guildId, positiveInteger(appealNumber, "appeal number")) as
      Record<string, unknown> | undefined;
    return row ? parseCaseAppealRow(row) : null;
  }

  public listAppeals(filter: CaseAppealListFilter = {}): CaseAppeal[] {
    const { sql, values } = buildListQuery(
      "case_appeals",
      "appeal_number",
      this.guildId,
      filter,
      ["appellantId", "appellant_id", "appellant ID"],
      ["caseId", "case_id", "case ID", "opaque"],
      "states",
      "state",
      (value) => normalizeAppealState(value),
    );
    return (
      this.db.prepare(sql).all(...values) as Array<Record<string, unknown>>
    ).map(parseCaseAppealRow);
  }

  public listEvents(
    appealId: string,
    listLimit = 100,
    listOffset = 0,
  ): CaseAppealEvent[] {
    const id = requireOpaqueId(appealId, "appeal ID");
    return (
      this.db
        .prepare(
          `SELECT * FROM case_appeal_events WHERE guild_id = ? AND appeal_id = ?
         ORDER BY event_number DESC LIMIT ? OFFSET ?`,
        )
        .all(this.guildId, id, limit(listLimit), offset(listOffset)) as Array<
        Record<string, unknown>
      >
    ).map(parseCaseAppealEventRow);
  }

  public listRecoverable(limitValue = 100): CaseAppeal[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM case_appeals WHERE guild_id = ?
           AND delivery_state IN ('reserved', 'failed', 'missing')
           AND state IN ('submitted', 'under-review')
         ORDER BY appeal_number ASC LIMIT ?`,
        )
        .all(this.guildId, limit(limitValue)) as Array<Record<string, unknown>>
    ).map(parseCaseAppealRow);
  }

  private getAppealByCase(caseId: string): CaseAppeal | null {
    const row = this.db
      .prepare("SELECT * FROM case_appeals WHERE guild_id = ? AND case_id = ?")
      .get(this.guildId, caseId) as Record<string, unknown> | undefined;
    return row ? parseCaseAppealRow(row) : null;
  }

  private mutate(
    appealId: string,
    expectedUpdatedAt: string | undefined,
    callback: (current: CaseAppeal) => CaseAppealTransitionResult,
  ): CaseAppealTransitionResult {
    let result: CaseAppealTransitionResult | null = null;
    const transaction = this.db.transaction(() => {
      const current = this.getAppealById(appealId);
      if (!current) {
        result = { status: "not-found", appeal: null };
        return;
      }
      if (expectedUpdatedAt && expectedUpdatedAt !== current.updatedAt) {
        result = { status: "conflict", appeal: current };
        return;
      }
      result = callback(current);
    });
    transaction.immediate();
    if (!result) throw new Error("Appeal transition returned no result");
    return result;
  }

  private reassignClaim(
    appealId: string,
    input: {
      actorId: string;
      previousReviewerId: string;
      nextReviewerId: string | null;
      reason: string;
      expectedUpdatedAt: string;
    },
  ): CaseAppealTransitionResult {
    if (input.nextReviewerId === input.previousReviewerId) {
      const current = this.getAppealById(appealId);
      if (!current) return { status: "not-found", appeal: null };
      if (current.updatedAt !== input.expectedUpdatedAt)
        return { status: "conflict", appeal: current };
      return current.state === "under-review" &&
        current.claimedBy === input.previousReviewerId
        ? { status: "unchanged", appeal: current }
        : { status: "unavailable", appeal: current };
    }
    let result: CaseAppealTransitionResult | null = null;
    const transition = this.db.transaction(() => {
      const current = this.getAppealById(appealId);
      if (!current)
        return void (result = { status: "not-found", appeal: null });
      if (current.updatedAt !== input.expectedUpdatedAt) {
        return void (result = { status: "conflict", appeal: current });
      }
      if (
        current.state !== "under-review" ||
        current.claimedBy !== input.previousReviewerId
      ) {
        return void (result = { status: "unavailable", appeal: current });
      }
      const now = nextTimestamp(current.updatedAt);
      const nextState = input.nextReviewerId ? "under-review" : "submitted";
      const updated = this.db
        .prepare(
          `UPDATE case_appeals SET state = ?, claimed_by = ?, claimed_at = ?,
             updated_at = ? WHERE guild_id = ? AND appeal_id = ?
             AND state = 'under-review' AND claimed_by = ? AND updated_at = ?`,
        )
        .run(
          nextState,
          input.nextReviewerId,
          input.nextReviewerId ? now : null,
          now,
          this.guildId,
          appealId,
          input.previousReviewerId,
          current.updatedAt,
        );
      if (updated.changes !== 1) {
        return void (result = {
          status: "conflict",
          appeal: this.requireAppeal(appealId),
        });
      }
      this.appendEventWithin(
        appealId,
        input.nextReviewerId ? "claim-reassigned" : "claim-released",
        input.actorId,
        {
          previousReviewerId: input.previousReviewerId,
          reviewerId: input.nextReviewerId,
          reason: input.reason,
        },
      );
      result = { status: "changed", appeal: this.requireAppeal(appealId) };
    });
    transition.immediate();
    if (!result) throw new Error("Appeal claim transition returned no result");
    return result;
  }

  private appendEventWithin(
    appealId: string,
    type: string,
    actorId: string | null,
    details: unknown,
  ): void {
    appendBoundedEvent(
      this.db,
      this.guildId,
      "case_appeal_events",
      "appeal_id",
      appealId,
      type,
      actorId,
      details,
    );
  }

  private requireAppeal(appealId: string): CaseAppeal {
    const appeal = this.getAppealById(appealId);
    if (!appeal) throw new Error("Case appeal was not persisted");
    return appeal;
  }
}

function normalizeReportReservation(
  input: MemberReportReservationInput,
  guildId: string,
): Required<MemberReportReservationInput> {
  const evidence = [
    input.evidenceGuildId,
    input.evidenceChannelId,
    input.evidenceMessageId,
  ];
  const present = evidence.filter((value) => value != null).length;
  if (present !== 0 && present !== 3)
    throw new TypeError(
      "Report evidence guild, channel, and message IDs must be supplied together",
    );
  const reporterId = assertDiscordSnowflake(input.reporterId, "reporter ID");
  const targetUserId = assertDiscordSnowflake(
    input.targetUserId,
    "target user ID",
  );
  if (reporterId === targetUserId)
    throw new TypeError("A member cannot report themselves");
  const evidenceGuildId =
    input.evidenceGuildId == null
      ? null
      : assertDiscordSnowflake(input.evidenceGuildId, "evidence guild ID");
  if (evidenceGuildId && evidenceGuildId !== guildId)
    throw new TypeError("Report evidence must belong to the current guild");
  return {
    reporterId,
    targetUserId,
    category: normalizeReportCategory(input.category),
    explanation: safeText(input.explanation, 10, 2_000, "report explanation"),
    evidenceGuildId,
    evidenceChannelId:
      input.evidenceChannelId == null
        ? null
        : assertDiscordSnowflake(
            input.evidenceChannelId,
            "evidence channel ID",
          ),
    evidenceMessageId:
      input.evidenceMessageId == null
        ? null
        : assertDiscordSnowflake(
            input.evidenceMessageId,
            "evidence message ID",
          ),
  };
}

function claimDeliveryLease<T>(
  db: DatabaseConnection,
  guildId: string,
  table: "member_reports" | "case_appeals",
  idColumn: "report_id" | "appeal_id",
  id: string,
  expectedUpdatedAt: string | undefined,
  read: () => T | null,
): DeliveryClaimResult<T> {
  let result: DeliveryClaimResult<T> | null = null;
  const claim = db.transaction(() => {
    const record = read();
    if (!record) {
      result = {
        status: "not-found",
        claimId: null,
        retryAt: null,
        record: null,
      };
      return;
    }
    const row = db
      .prepare(
        `SELECT delivery_state, delivery_claim_id, delivery_claim_expires_at, updated_at
       FROM ${table} WHERE guild_id = ? AND ${idColumn} = ?`,
      )
      .get(guildId, id) as {
      delivery_state: string;
      delivery_claim_id: string | null;
      delivery_claim_expires_at: string | null;
      updated_at: string;
    };
    if (expectedUpdatedAt && expectedUpdatedAt !== row.updated_at) {
      result = { status: "conflict", claimId: null, retryAt: null, record };
      return;
    }
    if (!["reserved", "failed", "missing"].includes(row.delivery_state)) {
      result = { status: "unavailable", claimId: null, retryAt: null, record };
      return;
    }
    const wallClock = utcNow();
    const version = nextTimestamp(row.updated_at);
    if (
      row.delivery_claim_id &&
      row.delivery_claim_expires_at &&
      Date.parse(row.delivery_claim_expires_at) > Date.parse(wallClock)
    ) {
      result = {
        status: "busy",
        claimId: null,
        retryAt: row.delivery_claim_expires_at,
        record,
      };
      return;
    }
    const claimId = createOpaqueStorageId();
    const retryAt = new Date(
      Date.parse(wallClock) + DELIVERY_CLAIM_SECONDS * 1_000,
    ).toISOString();
    const updated = db
      .prepare(
        `UPDATE ${table} SET delivery_claim_id = ?, delivery_claim_expires_at = ?,
         updated_at = ? WHERE guild_id = ? AND ${idColumn} = ? AND updated_at = ?
         AND (delivery_claim_id IS NULL OR delivery_claim_expires_at <= ?)`,
      )
      .run(claimId, retryAt, version, guildId, id, row.updated_at, wallClock);
    if (updated.changes !== 1) {
      result = {
        status: "conflict",
        claimId: null,
        retryAt: null,
        record: read() ?? record,
      };
      return;
    }
    const claimed = read();
    if (!claimed) throw new Error("Delivery claim lost its parent record");
    result = { status: "claimed", claimId, retryAt, record: claimed };
  });
  claim.immediate();
  if (!result) throw new Error("Delivery claim returned no result");
  return result;
}

function readDeliveryAttempt(
  db: DatabaseConnection,
  guildId: string,
  table: "member_reports" | "case_appeals",
  idColumn: "report_id" | "appeal_id",
  id: string,
): DeliveryAttempt | null {
  const row = db
    .prepare(
      `SELECT delivery_attempt_id, delivery_attempt_channel_id,
              delivery_attempt_started_at
       FROM ${table} WHERE guild_id = ? AND ${idColumn} = ?`,
    )
    .get(guildId, id) as Record<string, unknown> | undefined;
  return row ? parseDeliveryAttempt(row) : null;
}

function beginDeliveryAttemptLease<T>(
  db: DatabaseConnection,
  guildId: string,
  table: "member_reports" | "case_appeals",
  idColumn: "report_id" | "appeal_id",
  id: string,
  input: DeliveryAttemptInput,
  read: () => T | null,
  onChanged: (
    attempt: DeliveryAttempt,
    previousAttempt: DeliveryAttempt | null,
  ) => void,
): DeliveryAttemptTransitionResult<T> {
  const channelId = assertDiscordSnowflake(input.channelId, "channel ID");
  const claimId = requireOpaqueId(input.claimId, "delivery claim ID");
  const previousAttemptId =
    input.previousAttemptId === undefined
      ? null
      : requireOpaqueId(
          input.previousAttemptId,
          "previous delivery attempt ID",
        );
  let result: DeliveryAttemptTransitionResult<T> | null = null;
  const begin = db.transaction(() => {
    const record = read();
    if (!record) {
      result = { status: "not-found", record: null, attempt: null };
      return;
    }
    const row = db
      .prepare(
        `SELECT delivery_state, delivery_claim_id, delivery_claim_expires_at,
                delivery_attempt_id, delivery_attempt_channel_id,
                delivery_attempt_started_at, updated_at
         FROM ${table} WHERE guild_id = ? AND ${idColumn} = ?`,
      )
      .get(guildId, id) as Record<string, unknown>;
    const attempt = parseDeliveryAttempt(row);
    const wallClock = utcNow();
    const ownsLiveClaim =
      row.delivery_claim_id === claimId &&
      typeof row.delivery_claim_expires_at === "string" &&
      Date.parse(row.delivery_claim_expires_at) > Date.parse(wallClock);
    if (!ownsLiveClaim) {
      result = { status: "unavailable", record, attempt };
      return;
    }
    if (attempt?.channelId === channelId) {
      result = { status: "unchanged", record, attempt };
      return;
    }
    if (row.updated_at !== input.expectedUpdatedAt) {
      result = { status: "conflict", record, attempt };
      return;
    }
    if (
      !["reserved", "failed", "missing"].includes(String(row.delivery_state)) ||
      (attempt
        ? previousAttemptId !== attempt.attemptId
        : previousAttemptId !== null)
    ) {
      result = { status: "unavailable", record, attempt };
      return;
    }
    const nextAttempt: DeliveryAttempt = {
      attemptId: createOpaqueStorageId(),
      channelId,
      startedAt: wallClock,
    };
    const version = nextTimestamp(String(row.updated_at));
    const updated = db
      .prepare(
        `UPDATE ${table}
         SET delivery_attempt_id = ?, delivery_attempt_channel_id = ?,
             delivery_attempt_started_at = ?, updated_at = ?
         WHERE guild_id = ? AND ${idColumn} = ? AND updated_at = ?
           AND delivery_claim_id = ? AND delivery_claim_expires_at > ?`,
      )
      .run(
        nextAttempt.attemptId,
        nextAttempt.channelId,
        nextAttempt.startedAt,
        version,
        guildId,
        id,
        row.updated_at,
        claimId,
        wallClock,
      );
    if (updated.changes !== 1) {
      result = {
        status: "conflict",
        record: read() ?? record,
        attempt: readDeliveryAttempt(db, guildId, table, idColumn, id),
      };
      return;
    }
    onChanged(nextAttempt, attempt);
    const changedRecord = read();
    if (!changedRecord)
      throw new Error("Delivery attempt lost its parent record");
    result = {
      status: "changed",
      record: changedRecord,
      attempt: nextAttempt,
    };
  });
  begin.immediate();
  if (!result) throw new Error("Delivery attempt returned no result");
  return result;
}

function hasCurrentDeliveryClaim(
  db: DatabaseConnection,
  guildId: string,
  table: "member_reports" | "case_appeals",
  idColumn: "report_id" | "appeal_id",
  id: string,
  claimId: string,
): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM ${table} WHERE guild_id = ? AND ${idColumn} = ?
         AND delivery_claim_id = ? AND delivery_claim_expires_at > ?`,
      )
      .get(guildId, id, claimId, utcNow()),
  );
}

function canReleaseDeliveryClaim(
  db: DatabaseConnection,
  guildId: string,
  table: "member_reports" | "case_appeals",
  idColumn: "report_id" | "appeal_id",
  id: string,
  claimId: string | undefined,
): boolean {
  const row = db
    .prepare(
      `SELECT delivery_claim_id, delivery_claim_expires_at
       FROM ${table} WHERE guild_id = ? AND ${idColumn} = ?`,
    )
    .get(guildId, id) as
    | {
        delivery_claim_id: string | null;
        delivery_claim_expires_at: string | null;
      }
    | undefined;
  if (!row?.delivery_claim_id) return claimId === undefined;
  return (
    claimId !== undefined &&
    row.delivery_claim_id === requireOpaqueId(claimId, "delivery claim ID") &&
    row.delivery_claim_expires_at !== null &&
    Date.parse(row.delivery_claim_expires_at) > Date.now()
  );
}

function appendBoundedEvent(
  db: DatabaseConnection,
  guildId: string,
  table: "member_report_events" | "case_appeal_events",
  parentColumn: "report_id" | "appeal_id",
  parentId: string,
  type: string,
  actorId: string | null,
  details: unknown,
): void {
  const next = db
    .prepare(
      `SELECT COALESCE(MAX(event_number), 0) + 1 AS next FROM ${table}
     WHERE guild_id = ? AND ${parentColumn} = ?`,
    )
    .get(guildId, parentId) as { next: number };
  db.prepare(
    `INSERT INTO ${table} (
       guild_id, ${parentColumn}, event_id, event_number, event_type,
       actor_id, details_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    guildId,
    parentId,
    createOpaqueStorageId(),
    Number(next.next),
    type,
    actorId == null ? null : assertDiscordSnowflake(actorId, "event actor ID"),
    serializeJson(details, 4_000),
    utcNow(),
  );
  db.prepare(
    `DELETE FROM ${table} WHERE guild_id = ? AND ${parentColumn} = ? AND event_id IN (
       SELECT event_id FROM ${table} WHERE guild_id = ? AND ${parentColumn} = ?
       ORDER BY event_number DESC LIMIT -1 OFFSET ?
     )`,
  ).run(guildId, parentId, guildId, parentId, MAX_EVENTS_PER_PARENT);
}

function buildListQuery(
  table: "member_reports" | "case_appeals",
  orderColumn: "report_number" | "appeal_number",
  guildId: string,
  filter: object,
  first: [string, string, string, "opaque"?],
  second: [string, string, string, "opaque"?],
  statesKey: string,
  statesColumn: string,
  normalizeState: (value: unknown) => string,
): { sql: string; values: unknown[] } {
  const predicates = ["guild_id = ?"];
  const values: unknown[] = [guildId];
  const valuesByKey = filter as Record<string, unknown>;
  for (const tuple of [first, second] as const) {
    const [key, column, label, kind] = tuple;
    const value = valuesByKey[key];
    if (value !== undefined) {
      predicates.push(`${column} = ?`);
      values.push(
        kind === "opaque"
          ? requireOpaqueId(value, String(label))
          : assertDiscordSnowflake(String(value), String(label)),
      );
    }
  }
  const states = valuesByKey[statesKey];
  if (Array.isArray(states) && states.length > 0) {
    const normalized = [...new Set(states.map(normalizeState))];
    predicates.push(
      `${statesColumn} IN (${normalized.map(() => "?").join(",")})`,
    );
    values.push(...normalized);
  }
  values.push(
    limit(valuesByKey.limit === undefined ? 25 : Number(valuesByKey.limit)),
    offset(valuesByKey.offset === undefined ? 0 : Number(valuesByKey.offset)),
  );
  return {
    sql: `SELECT * FROM ${table} WHERE ${predicates.join(" AND ")} ORDER BY ${orderColumn} DESC LIMIT ? OFFSET ?`,
    values,
  };
}

export function parseMemberReportRow(
  row: Record<string, unknown>,
): MemberReport {
  return {
    guildId: String(row.guild_id),
    reportId: String(row.report_id),
    reportNumber: Number(row.report_number),
    reporterId: String(row.reporter_id),
    targetUserId: String(row.target_user_id),
    category: normalizeReportCategory(row.category),
    explanation: String(row.explanation),
    evidenceGuildId: nullable(row.evidence_guild_id),
    evidenceChannelId: nullable(row.evidence_channel_id),
    evidenceMessageId: nullable(row.evidence_message_id),
    state: normalizeReportState(row.state),
    deliveryState: String(row.delivery_state) as MemberReport["deliveryState"],
    reviewChannelId: nullable(row.review_channel_id),
    reviewMessageId: nullable(row.review_message_id),
    claimedBy: nullable(row.claimed_by),
    claimedAt: nullable(row.claimed_at),
    decisionBy: nullable(row.decision_by),
    decisionReason: nullable(row.decision_reason),
    decidedAt: nullable(row.decided_at),
    linkedCaseId: nullable(row.linked_case_id),
    withdrawnAt: nullable(row.withdrawn_at),
    failureCode: nullable(row.failure_code),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function parseCaseAppealRow(row: Record<string, unknown>): CaseAppeal {
  return {
    guildId: String(row.guild_id),
    appealId: String(row.appeal_id),
    appealNumber: Number(row.appeal_number),
    caseId: String(row.case_id),
    appellantId: String(row.appellant_id),
    explanation: String(row.explanation),
    state: normalizeAppealState(row.state),
    deliveryState: String(row.delivery_state) as CaseAppeal["deliveryState"],
    reviewChannelId: nullable(row.review_channel_id),
    reviewMessageId: nullable(row.review_message_id),
    claimedBy: nullable(row.claimed_by),
    claimedAt: nullable(row.claimed_at),
    decisionBy: nullable(row.decision_by),
    decisionReason: nullable(row.decision_reason),
    decidedAt: nullable(row.decided_at),
    reversalCaseId: nullable(row.reversal_case_id),
    withdrawnAt: nullable(row.withdrawn_at),
    failureCode: nullable(row.failure_code),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function parseMemberReportEventRow(
  row: Record<string, unknown>,
): MemberReportEvent {
  return {
    guildId: String(row.guild_id),
    reportId: String(row.report_id),
    eventId: String(row.event_id),
    eventNumber: Number(row.event_number),
    type: String(row.event_type),
    actorId: nullable(row.actor_id),
    details: parseJson(row.details_json),
    createdAt: String(row.created_at),
  };
}

export function parseCaseAppealEventRow(
  row: Record<string, unknown>,
): CaseAppealEvent {
  return {
    guildId: String(row.guild_id),
    appealId: String(row.appeal_id),
    eventId: String(row.event_id),
    eventNumber: Number(row.event_number),
    type: String(row.event_type),
    actorId: nullable(row.actor_id),
    details: parseJson(row.details_json),
    createdAt: String(row.created_at),
  };
}

function parseDeliveryAttempt(
  row: Record<string, unknown>,
): DeliveryAttempt | null {
  const attemptId = nullable(row.delivery_attempt_id);
  const channelId = nullable(row.delivery_attempt_channel_id);
  const startedAt = nullable(row.delivery_attempt_started_at);
  if (attemptId === null && channelId === null && startedAt === null) {
    return null;
  }
  if (attemptId === null || channelId === null || startedAt === null) {
    throw new Error("Delivery attempt checkpoint is incomplete");
  }
  return {
    attemptId: requireOpaqueId(attemptId, "delivery attempt ID"),
    channelId: assertDiscordSnowflake(channelId, "delivery attempt channel ID"),
    startedAt: timestamp(startedAt, "delivery attempt start time"),
  };
}

export function readTimeoutAppealRemovalCheckpoint(
  metadata: unknown,
): TimeoutAppealRemovalCheckpointProof | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    return null;
  const candidate = (metadata as Record<string, unknown>).recoveryCheckpoint;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
    return null;
  const record = candidate as Record<string, unknown>;
  const appealId = normalizeOpaqueId(record.appealId);
  const originalCaseId = normalizeOpaqueId(record.originalCaseId);
  const reviewerId =
    typeof record.reviewerId === "string" &&
    /^\d{17,20}$/.test(record.reviewerId)
      ? record.reviewerId
      : null;
  let originalExpiresAt: string | null = null;
  if (typeof record.originalExpiresAt === "string") {
    try {
      originalExpiresAt = timestamp(
        record.originalExpiresAt,
        "original timeout expiry",
      );
    } catch {
      originalExpiresAt = null;
    }
  }
  if (
    record.kind !== "timeout-appeal-removal-confirmed" ||
    !appealId ||
    !originalCaseId ||
    !reviewerId ||
    !originalExpiresAt
  ) {
    return null;
  }
  return {
    kind: "timeout-appeal-removal-confirmed",
    appealId,
    originalCaseId,
    originalExpiresAt,
    reviewerId,
  };
}

function normalizeReportCategory(value: unknown): MemberReportCategory {
  if (!(MEMBER_REPORT_CATEGORIES as readonly unknown[]).includes(value))
    throw new TypeError("Unsupported report category");
  return value as MemberReportCategory;
}
function normalizeReportState(value: unknown): MemberReportState {
  if (!(MEMBER_REPORT_STATES as readonly unknown[]).includes(value))
    throw new TypeError("Unsupported report state");
  return value as MemberReportState;
}
function normalizeAppealState(value: unknown): CaseAppealState {
  if (!(CASE_APPEAL_STATES as readonly unknown[]).includes(value))
    throw new TypeError("Unsupported appeal state");
  return value as CaseAppealState;
}
function normalizeReportDecisionState(
  value: unknown,
): "resolved" | "dismissed" {
  if (value !== "resolved" && value !== "dismissed")
    throw new TypeError("Unsupported report decision state");
  return value;
}
function normalizeAppealDecisionState(value: unknown): "upheld" | "overturned" {
  if (value !== "upheld" && value !== "overturned")
    throw new TypeError("Unsupported appeal decision state");
  return value;
}
function isCaseAppealEligible(actionType: string, status: string): boolean {
  switch (actionType) {
    case "warning":
      return status === "active";
    case "timeout":
      return status === "active";
    case "kick":
      return status === "completed";
    case "ban":
      return status === "active" || status === "completed";
    default:
      return false;
  }
}
function isNonTimeoutAppealOverturnEligible(
  actionType: ModerationCase["actionType"],
  status: ModerationCase["status"],
): boolean {
  return actionType !== "timeout" && isCaseAppealEligible(actionType, status);
}
function assertCapacity(
  db: DatabaseConnection,
  table: "member_reports" | "case_appeals",
  guildId: string,
  maximum: number,
): void {
  const count = Number(
    (
      db
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE guild_id = ?`)
        .get(guildId) as { count: number }
    ).count,
  );
  if (count >= maximum)
    throw new RangeError(`${table} reached its ${maximum}-record safety limit`);
}
function nextNumber(
  db: DatabaseConnection,
  table: "member_reports" | "case_appeals",
  column: "report_number" | "appeal_number",
  guildId: string,
): number {
  const next = Number(
    (
      db
        .prepare(
          `SELECT COALESCE(MAX(${column}), 0) + 1 AS next FROM ${table} WHERE guild_id = ?`,
        )
        .get(guildId) as { next: number }
    ).next,
  );
  if (!Number.isInteger(next) || next > 2_147_483_647)
    throw new RangeError(`${column} exhausted`);
  return next;
}
function serializeJson(value: unknown, maximumBytes: number): string {
  let encoded: string;
  try {
    encoded = JSON.stringify(value ?? {});
  } catch {
    throw new TypeError("Event details must be JSON serializable");
  }
  if (Buffer.byteLength(encoded, "utf8") > maximumBytes)
    throw new RangeError(`Event details exceed ${maximumBytes} bytes`);
  return encoded;
}
function parseJson(value: unknown): unknown {
  return JSON.parse(String(value));
}
function safeText(
  value: unknown,
  min: number,
  max: number,
  label: string,
): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be text`);
  const normalized = value.normalize("NFKC").trim();
  if (
    normalized.length < min ||
    normalized.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)
  )
    throw new RangeError(`${label} must contain ${min}-${max} safe characters`);
  return normalized;
}
function positiveInteger(value: unknown, label: string): number {
  if (
    !Number.isInteger(value) ||
    Number(value) < 1 ||
    Number(value) > 2_147_483_647
  )
    throw new RangeError(`${label} is invalid`);
  return Number(value);
}
function limit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIST_LIMIT)
    throw new RangeError(`list limit must be between 1 and ${MAX_LIST_LIMIT}`);
  return value;
}
function offset(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 2_147_483_647)
    throw new RangeError("list offset is invalid");
  return value;
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
  return value == null ? null : String(value);
}
function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new TypeError(`${label} must be a valid timestamp`);
  return new Date(Date.parse(value)).toISOString();
}
function readCaseExpiry(record: ModerationCase): string | null {
  const metadata = record.discordActionMetadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    return null;
  const value = (metadata as Record<string, unknown>).expiresAt;
  if (typeof value !== "string") return null;
  try {
    return timestamp(value, "case timeout expiry");
  } catch {
    return null;
  }
}
function sameTimeoutAppealRemovalProof(
  left: TimeoutAppealRemovalCheckpointProof | null,
  right: TimeoutAppealRemovalCheckpointProof,
): boolean {
  return (
    left !== null &&
    left.kind === right.kind &&
    left.appealId === right.appealId &&
    left.originalCaseId === right.originalCaseId &&
    left.originalExpiresAt === right.originalExpiresAt &&
    left.reviewerId === right.reviewerId
  );
}
function utcNow(): string {
  return new Date().toISOString();
}
function nextTimestamp(previous: string): string {
  const now = Date.now();
  const prior = Date.parse(previous);
  return new Date(
    Number.isFinite(prior) && now <= prior ? prior + 1 : now,
  ).toISOString();
}
