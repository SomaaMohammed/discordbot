import type { DatabaseConnection } from "./database.js";
import { assertDiscordSnowflake } from "../guild-settings.js";
import {
  MODERATION_CASE_ACTION_TYPES,
  MODERATION_CASE_EVENT_TYPES,
  MODERATION_CASE_SOURCES,
  MODERATION_CASE_STATUSES,
  type ActiveModerationCaseLookupResult,
  type DeliveryAttempt,
  type DeliveryAttemptInput,
  type DeliveryAttemptTransitionResult,
  type DeliveryClaimResult,
  type ExpiredTimeoutCaseCompletionInput,
  type ModerationCase,
  type ModerationCaseActionType,
  type ModerationCaseAmendInput,
  type ModerationCaseAttemptInput,
  type ModerationCaseEvent,
  type ModerationCaseEventInput,
  type ModerationCaseInput,
  type ModerationCaseListFilter,
  type ModerationCaseSource,
  type ModerationCaseStatus,
  type ModerationCaseTransitionResult,
  type ModerationTimeoutRemovalFinalizeResult,
  type ModerationConfiguration,
  type ModerationConfigurationInput,
  type ModerationLogDelivery,
  type ModerationLogDeliveryState,
  type ModerationLogDeliveryTransitionResult,
} from "../types.js";
import { createOpaqueStorageId } from "./operational-repository.js";
import { validateModerationCaseMetadata } from "./moderation-case-metadata.js";

const MAX_LIST_LIMIT = 100;
const MAX_EVENTS_PER_CASE = 100;
const MAX_CASES = 100_000;
const DELIVERY_CLAIM_SECONDS = 120;
const MAX_TIMEOUT_ABSENCE_AGE_MS = 5 * 60 * 1_000;

export class ModerationCaseRepository {
  public constructor(
    private readonly db: DatabaseConnection,
    public readonly guildId: string,
  ) {}

  public getConfiguration(): ModerationConfiguration | null {
    const row = this.db
      .prepare("SELECT * FROM moderation_configurations WHERE guild_id = ?")
      .get(this.guildId) as Record<string, unknown> | undefined;
    return row ? parseModerationConfigurationRow(row) : null;
  }

  public upsertConfiguration(
    input: ModerationConfigurationInput,
  ): ModerationConfiguration {
    const actorId = assertDiscordSnowflake(input.actorId, "actor ID");
    const current = this.getConfiguration();
    const next = normalizeConfiguration(input, current);
    const now = current ? nextTimestamp(current.updatedAt) : utcNow();
    this.db
      .prepare(
        `INSERT INTO moderation_configurations (
           guild_id, cases_enabled, moderation_log_channel_id,
           moderation_log_verified_at, reports_enabled, report_review_channel_id,
           report_reviewer_role_id, report_bindings_verified_at, appeals_enabled,
           appeal_review_channel_id, appeal_reviewer_role_id,
           appeal_bindings_verified_at, anti_spam_enabled, report_cooldown_limit,
           report_cooldown_window_seconds, created_by, updated_by, created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(guild_id) DO UPDATE SET
           cases_enabled = excluded.cases_enabled,
           moderation_log_channel_id = excluded.moderation_log_channel_id,
           moderation_log_verified_at = excluded.moderation_log_verified_at,
           reports_enabled = excluded.reports_enabled,
           report_review_channel_id = excluded.report_review_channel_id,
           report_reviewer_role_id = excluded.report_reviewer_role_id,
           report_bindings_verified_at = excluded.report_bindings_verified_at,
           appeals_enabled = excluded.appeals_enabled,
           appeal_review_channel_id = excluded.appeal_review_channel_id,
           appeal_reviewer_role_id = excluded.appeal_reviewer_role_id,
           appeal_bindings_verified_at = excluded.appeal_bindings_verified_at,
           anti_spam_enabled = excluded.anti_spam_enabled,
           report_cooldown_limit = excluded.report_cooldown_limit,
           report_cooldown_window_seconds = excluded.report_cooldown_window_seconds,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .run(
        this.guildId,
        bool(next.casesEnabled),
        next.moderationLogChannelId,
        next.moderationLogVerifiedAt,
        bool(next.reportsEnabled),
        next.reportReviewChannelId,
        next.reportReviewerRoleId,
        next.reportBindingsVerifiedAt,
        bool(next.appealsEnabled),
        next.appealReviewChannelId,
        next.appealReviewerRoleId,
        next.appealBindingsVerifiedAt,
        bool(next.antiSpamEnabled),
        next.reportCooldownLimit,
        next.reportCooldownWindowSeconds,
        current?.createdBy ?? actorId,
        actorId,
        current?.createdAt ?? now,
        now,
      );
    return this.requireConfiguration();
  }

  public disableConfiguration(
    actorId?: string,
  ): ModerationConfiguration | null {
    const current = this.getConfiguration();
    if (!current) return null;
    const actor = assertDiscordSnowflake(
      actorId ?? current.updatedBy,
      "actor ID",
    );
    this.db
      .prepare(
        `UPDATE moderation_configurations
         SET cases_enabled = 0, reports_enabled = 0, appeals_enabled = 0,
             anti_spam_enabled = 0, updated_by = ?, updated_at = ?
         WHERE guild_id = ?`,
      )
      .run(actor, nextTimestamp(current.updatedAt), this.guildId);
    return this.requireConfiguration();
  }

  public createCase(input: ModerationCaseInput): ModerationCase {
    const normalized = normalizeCaseInput(input);
    let created: ModerationCase | null = null;
    const create = this.db.transaction(() => {
      this.assertCaseCreationAllowed(normalized, false);
      this.assertCaseCapacity();
      const now = utcNow();
      const caseId = createOpaqueStorageId();
      const caseNumber = this.nextCaseNumber();
      this.db
        .prepare(
          `INSERT INTO moderation_cases (
             guild_id, case_id, case_number, target_user_id, actor_id,
             action_type, source, public_reason, private_note,
             discord_action_metadata_json, status, related_case_id,
             voided_by, voided_at, void_reason, overturned_by, overturned_at,
             overturn_reason, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL,
                     NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          this.guildId,
          caseId,
          caseNumber,
          normalized.targetUserId,
          normalized.actorId,
          normalized.actionType,
          normalized.source,
          normalized.publicReason,
          normalized.privateNote,
          serializeJson(normalized.discordActionMetadata, 8_000),
          normalized.status,
          normalized.relatedCaseId,
          now,
          now,
        );
      this.db
        .prepare(
          `INSERT INTO moderation_log_deliveries (
             guild_id, case_id, delivery_state, channel_id, message_id,
             attempt_count, last_failure_code, delivered_at, created_at, updated_at
           ) VALUES (?, ?, 'pending', NULL, NULL, 0, NULL, NULL, ?, ?)`,
        )
        .run(this.guildId, caseId, now, now);
      this.appendEventWithin(caseId, {
        type: "created",
        actorId: normalized.actorId,
        details: {
          caseNumber,
          actionType: normalized.actionType,
          status: normalized.status,
        },
      });
      created = this.requireCase(caseId);
    });
    create.immediate();
    if (!created)
      throw new Error("Moderation case creation returned no result");
    return created;
  }

  public reserveCaseAttempt(input: ModerationCaseAttemptInput): ModerationCase {
    const normalized = normalizeCaseInput({ ...input, status: "failed" });
    let created: ModerationCase | null = null;
    const reserve = this.db.transaction(() => {
      this.assertCaseCreationAllowed(normalized, true);
      this.assertCaseCapacity();
      const now = utcNow();
      const caseId = createOpaqueStorageId();
      const caseNumber = this.nextCaseNumber();
      this.db
        .prepare(
          `INSERT INTO moderation_cases (
           guild_id, case_id, case_number, target_user_id, actor_id,
           action_type, source, public_reason, private_note,
           discord_action_metadata_json, status, related_case_id,
           voided_by, voided_at, void_reason, overturned_by, overturned_at,
           overturn_reason, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?, NULL, NULL,
                   NULL, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          this.guildId,
          caseId,
          caseNumber,
          normalized.targetUserId,
          normalized.actorId,
          normalized.actionType,
          normalized.source,
          normalized.publicReason,
          normalized.privateNote,
          serializeJson(normalized.discordActionMetadata, 8_000),
          normalized.relatedCaseId,
          now,
          now,
        );
      this.appendEventWithin(caseId, {
        type: "action-reserved",
        actorId: normalized.actorId,
        details: { caseNumber, actionType: normalized.actionType },
      });
      created = this.requireCase(caseId);
    });
    reserve.immediate();
    if (!created)
      throw new Error("Moderation case reservation returned no result");
    return created;
  }

  public confirmCaseAttempt(
    caseId: string,
    input: {
      actorId: string;
      status: "active" | "completed";
      discordActionMetadata?: unknown;
      expectedUpdatedAt?: string;
    },
  ): ModerationCaseTransitionResult {
    const id = requireOpaqueId(caseId, "case ID");
    const actorId = assertDiscordSnowflake(input.actorId, "actor ID");
    if (input.status !== "active" && input.status !== "completed")
      throw new TypeError("Confirmed case status must be active or completed");
    const metadata = input.discordActionMetadata;
    let result: ModerationCaseTransitionResult | null = null;
    const confirm = this.db.transaction(() => {
      const current = this.getCaseById(id);
      if (!current) return void (result = { status: "not-found", case: null });
      if (
        input.expectedUpdatedAt &&
        input.expectedUpdatedAt !== current.updatedAt
      )
        return void (result = { status: "conflict", case: current });
      if (current.status === input.status)
        return void (result = { status: "unchanged", case: current });
      if (current.status !== "failed")
        return void (result = { status: "unavailable", case: current });
      const now = nextTimestamp(current.updatedAt);
      const encodedMetadata =
        metadata === undefined
          ? serializeJson(current.discordActionMetadata, 8_000)
          : serializeJson(
              validateModerationCaseMetadata(
                metadata,
                current.source,
                current.actionType,
              ),
              8_000,
            );
      const updated = this.db
        .prepare(
          `UPDATE moderation_cases SET status = ?, discord_action_metadata_json = ?,
           updated_at = ? WHERE guild_id = ? AND case_id = ? AND updated_at = ?
           AND status = 'failed'`,
        )
        .run(
          input.status,
          encodedMetadata,
          now,
          this.guildId,
          id,
          current.updatedAt,
        );
      if (updated.changes !== 1)
        return void (result = {
          status: "conflict",
          case: this.requireCase(id),
        });
      this.db
        .prepare(
          `INSERT INTO moderation_log_deliveries (
           guild_id, case_id, delivery_state, channel_id, message_id,
           attempt_count, last_failure_code, delivery_claim_id,
           delivery_claim_expires_at, delivered_at, created_at, updated_at
         ) VALUES (?, ?, 'pending', NULL, NULL, 0, NULL, NULL, NULL, NULL, ?, ?)
         ON CONFLICT(guild_id, case_id) DO NOTHING`,
        )
        .run(this.guildId, id, now, now);
      this.appendEventWithin(id, {
        type: "action-confirmed",
        actorId,
        details: { status: input.status },
      });
      result = { status: "changed", case: this.requireCase(id) };
    });
    confirm.immediate();
    if (!result)
      throw new Error("Moderation case confirmation returned no result");
    return result;
  }

  public failCaseAttempt(
    caseId: string,
    input: { actorId: string; failureCode: string; expectedUpdatedAt?: string },
  ): ModerationCaseTransitionResult {
    const id = requireOpaqueId(caseId, "case ID");
    const actorId = assertDiscordSnowflake(input.actorId, "actor ID");
    const failureCode = text(input.failureCode, 1, 100, "failure code");
    let result: ModerationCaseTransitionResult | null = null;
    const fail = this.db.transaction(() => {
      const current = this.getCaseById(id);
      if (!current) return void (result = { status: "not-found", case: null });
      if (
        input.expectedUpdatedAt &&
        input.expectedUpdatedAt !== current.updatedAt
      )
        return void (result = { status: "conflict", case: current });
      if (current.status !== "failed")
        return void (result = { status: "unavailable", case: current });
      this.appendEventWithin(id, {
        type: "action-failed",
        actorId,
        details: { failureCode },
      });
      result = { status: "changed", case: current };
    });
    fail.immediate();
    if (!result) throw new Error("Moderation case failure returned no result");
    return result;
  }

  public finalizeTimeoutRemoval(
    removalCaseId: string,
    input: {
      actorId: string;
      originalCaseId: string;
      discordActionMetadata?: unknown;
      originalOutcome?: "completed" | "overturned";
      originalReason?: string;
      removalExpectedUpdatedAt?: string;
      originalExpectedUpdatedAt?: string;
    },
  ): ModerationTimeoutRemovalFinalizeResult {
    const removalId = requireOpaqueId(removalCaseId, "timeout-removal case ID");
    const originalId = requireOpaqueId(
      input.originalCaseId,
      "original timeout case ID",
    );
    if (removalId === originalId)
      throw new TypeError("Timeout removal and original case must differ");
    const actorId = assertDiscordSnowflake(input.actorId, "actor ID");
    const originalOutcome = input.originalOutcome ?? "completed";
    const originalReason =
      input.originalReason === undefined
        ? null
        : text(input.originalReason, 1, 1_000, "original case outcome reason");
    if (originalOutcome === "overturned" && !originalReason) {
      throw new TypeError("Overturning the original timeout requires a reason");
    }
    let result: ModerationTimeoutRemovalFinalizeResult | null = null;
    const finalize = this.db.transaction(() => {
      const removalCase = this.getCaseById(removalId);
      const originalCase = this.getCaseById(originalId);
      if (!removalCase || !originalCase) {
        result = { status: "not-found", removalCase, originalCase };
        return;
      }
      const alreadyFinalized =
        removalCase.status === "completed" &&
        originalCase.status === originalOutcome &&
        removalCase.actionType === "timeout-removed" &&
        ["timeout", "automod-timeout"].includes(originalCase.actionType) &&
        removalCase.targetUserId === originalCase.targetUserId &&
        removalCase.relatedCaseId === originalId &&
        originalCase.relatedCaseId === removalId;
      if (alreadyFinalized) {
        result = { status: "unchanged", removalCase, originalCase };
        return;
      }
      if (
        (input.removalExpectedUpdatedAt &&
          input.removalExpectedUpdatedAt !== removalCase.updatedAt) ||
        (input.originalExpectedUpdatedAt &&
          input.originalExpectedUpdatedAt !== originalCase.updatedAt)
      ) {
        result = { status: "conflict", removalCase, originalCase };
        return;
      }
      if (
        removalCase.status !== "failed" ||
        removalCase.actionType !== "timeout-removed" ||
        originalCase.status !== "active" ||
        !["timeout", "automod-timeout"].includes(originalCase.actionType) ||
        removalCase.targetUserId !== originalCase.targetUserId ||
        (removalCase.relatedCaseId !== null &&
          removalCase.relatedCaseId !== originalId) ||
        (originalCase.relatedCaseId !== null &&
          originalCase.relatedCaseId !== removalId)
      ) {
        result = { status: "unavailable", removalCase, originalCase };
        return;
      }
      const latestTimestamp =
        Date.parse(removalCase.updatedAt) >= Date.parse(originalCase.updatedAt)
          ? removalCase.updatedAt
          : originalCase.updatedAt;
      const now = nextTimestamp(latestTimestamp);
      const encodedMetadata =
        input.discordActionMetadata === undefined
          ? serializeJson(removalCase.discordActionMetadata, 8_000)
          : serializeJson(input.discordActionMetadata, 8_000);
      const completedRemoval = this.db
        .prepare(
          `UPDATE moderation_cases SET status = 'completed', related_case_id = ?,
           discord_action_metadata_json = ?, updated_at = ?
         WHERE guild_id = ? AND case_id = ? AND status = 'failed'
           AND updated_at = ?`,
        )
        .run(
          originalId,
          encodedMetadata,
          now,
          this.guildId,
          removalId,
          removalCase.updatedAt,
        );
      if (completedRemoval.changes !== 1)
        throw new Error("Timeout-removal case changed during finalization");
      const completedOriginal =
        originalOutcome === "overturned"
          ? this.db
              .prepare(
                `UPDATE moderation_cases SET status = 'overturned', related_case_id = ?,
               overturned_by = ?, overturned_at = ?, overturn_reason = ?,
               updated_at = ? WHERE guild_id = ? AND case_id = ?
               AND status = 'active' AND updated_at = ?`,
              )
              .run(
                removalId,
                actorId,
                now,
                originalReason,
                now,
                this.guildId,
                originalId,
                originalCase.updatedAt,
              )
          : this.db
              .prepare(
                `UPDATE moderation_cases SET status = 'completed', related_case_id = ?,
               updated_at = ? WHERE guild_id = ? AND case_id = ?
               AND status = 'active' AND updated_at = ?`,
              )
              .run(
                removalId,
                now,
                this.guildId,
                originalId,
                originalCase.updatedAt,
              );
      if (completedOriginal.changes !== 1)
        throw new Error("Original timeout case changed during finalization");
      this.db
        .prepare(
          `INSERT INTO moderation_log_deliveries (
           guild_id, case_id, delivery_state, channel_id, message_id,
           attempt_count, last_failure_code, delivery_claim_id,
           delivery_claim_expires_at, delivered_at, created_at, updated_at
         ) VALUES (?, ?, 'pending', NULL, NULL, 0, NULL, NULL, NULL, NULL, ?, ?)
         ON CONFLICT(guild_id, case_id) DO NOTHING`,
        )
        .run(this.guildId, removalId, now, now);
      this.appendEventWithin(removalId, {
        type: "action-confirmed",
        actorId,
        details: { status: "completed", originalCaseId: originalId },
      });
      this.appendEventWithin(originalId, {
        type: originalOutcome,
        actorId,
        details: {
          reason: originalReason ?? "timeout-removed",
          relatedCaseId: removalId,
        },
      });
      result = {
        status: "changed",
        removalCase: this.requireCase(removalId),
        originalCase: this.requireCase(originalId),
      };
    });
    try {
      finalize.immediate();
    } catch (error) {
      const removalCase = this.getCaseById(removalId);
      const originalCase = this.getCaseById(originalId);
      if (removalCase && originalCase) {
        return { status: "conflict", removalCase, originalCase };
      }
      throw error;
    }
    if (!result)
      throw new Error("Timeout-removal finalization returned no result");
    return result;
  }

  public finalizeBanRemoval(
    removalCaseId: string,
    input: {
      actorId: string;
      originalCaseId: string;
      discordActionMetadata?: unknown;
      removalExpectedUpdatedAt?: string;
      originalExpectedUpdatedAt?: string;
    },
  ): ModerationTimeoutRemovalFinalizeResult {
    const removalId = requireOpaqueId(removalCaseId, "unban case ID");
    const originalId = requireOpaqueId(
      input.originalCaseId,
      "original ban case ID",
    );
    if (removalId === originalId)
      throw new TypeError("Unban and original ban case must differ");
    const actorId = assertDiscordSnowflake(input.actorId, "actor ID");
    let result: ModerationTimeoutRemovalFinalizeResult | null = null;
    const finalize = this.db.transaction(() => {
      const removalCase = this.getCaseById(removalId);
      const originalCase = this.getCaseById(originalId);
      if (!removalCase || !originalCase) {
        result = { status: "not-found", removalCase, originalCase };
        return;
      }
      const expectedPair =
        removalCase.actionType === "unban" &&
        originalCase.actionType === "ban" &&
        removalCase.targetUserId === originalCase.targetUserId &&
        removalCase.relatedCaseId === originalId &&
        originalCase.relatedCaseId === removalId;
      if (
        expectedPair &&
        removalCase.status === "completed" &&
        originalCase.status === "completed"
      ) {
        result = { status: "unchanged", removalCase, originalCase };
        return;
      }
      if (
        (input.removalExpectedUpdatedAt &&
          input.removalExpectedUpdatedAt !== removalCase.updatedAt) ||
        (input.originalExpectedUpdatedAt &&
          input.originalExpectedUpdatedAt !== originalCase.updatedAt)
      ) {
        result = { status: "conflict", removalCase, originalCase };
        return;
      }
      if (
        removalCase.status !== "failed" ||
        removalCase.actionType !== "unban" ||
        originalCase.status !== "active" ||
        originalCase.actionType !== "ban" ||
        removalCase.targetUserId !== originalCase.targetUserId ||
        (removalCase.relatedCaseId !== null &&
          removalCase.relatedCaseId !== originalId) ||
        (originalCase.relatedCaseId !== null &&
          originalCase.relatedCaseId !== removalId)
      ) {
        result = { status: "unavailable", removalCase, originalCase };
        return;
      }
      const latestTimestamp =
        Date.parse(removalCase.updatedAt) >= Date.parse(originalCase.updatedAt)
          ? removalCase.updatedAt
          : originalCase.updatedAt;
      const now = nextTimestamp(latestTimestamp);
      const encodedMetadata =
        input.discordActionMetadata === undefined
          ? serializeJson(removalCase.discordActionMetadata, 8_000)
          : serializeJson(input.discordActionMetadata, 8_000);
      const completedRemoval = this.db
        .prepare(
          `UPDATE moderation_cases SET status = 'completed', related_case_id = ?,
             discord_action_metadata_json = ?, updated_at = ?
           WHERE guild_id = ? AND case_id = ? AND status = 'failed'
             AND updated_at = ?`,
        )
        .run(
          originalId,
          encodedMetadata,
          now,
          this.guildId,
          removalId,
          removalCase.updatedAt,
        );
      if (completedRemoval.changes !== 1)
        throw new Error("Unban case changed during finalization");
      const completedOriginal = this.db
        .prepare(
          `UPDATE moderation_cases SET status = 'completed', related_case_id = ?,
             updated_at = ? WHERE guild_id = ? AND case_id = ?
             AND status = 'active' AND updated_at = ?`,
        )
        .run(removalId, now, this.guildId, originalId, originalCase.updatedAt);
      if (completedOriginal.changes !== 1)
        throw new Error("Original ban case changed during finalization");
      this.db
        .prepare(
          `INSERT INTO moderation_log_deliveries (
             guild_id, case_id, delivery_state, channel_id, message_id,
             attempt_count, last_failure_code, delivery_claim_id,
             delivery_claim_expires_at, delivered_at, created_at, updated_at
           ) VALUES (?, ?, 'pending', NULL, NULL, 0, NULL, NULL, NULL, NULL, ?, ?)
           ON CONFLICT(guild_id, case_id) DO NOTHING`,
        )
        .run(this.guildId, removalId, now, now);
      this.appendEventWithin(removalId, {
        type: "action-confirmed",
        actorId,
        details: { status: "completed", originalCaseId: originalId },
      });
      this.appendEventWithin(originalId, {
        type: "completed",
        actorId,
        details: { reason: "unban-confirmed", relatedCaseId: removalId },
      });
      result = {
        status: "changed",
        removalCase: this.requireCase(removalId),
        originalCase: this.requireCase(originalId),
      };
    });
    try {
      finalize.immediate();
    } catch (error) {
      const removalCase = this.getCaseById(removalId);
      const originalCase = this.getCaseById(originalId);
      if (removalCase && originalCase) {
        return { status: "conflict", removalCase, originalCase };
      }
      throw error;
    }
    if (!result) throw new Error("Ban-removal finalization returned no result");
    return result;
  }

  public finalizeTimeoutAppealOverturn(
    removalCaseId: string,
    input: {
      actorId: string;
      originalCaseId: string;
      reason: string;
      discordActionMetadata?: unknown;
      removalExpectedUpdatedAt?: string;
      originalExpectedUpdatedAt?: string;
    },
  ): ModerationTimeoutRemovalFinalizeResult {
    return this.finalizeTimeoutRemoval(removalCaseId, {
      ...input,
      originalOutcome: "overturned",
      originalReason: input.reason,
    });
  }

  public getCaseById(caseId: string): ModerationCase | null {
    const id = normalizeOpaqueId(caseId);
    if (!id) return null;
    const row = this.db
      .prepare(
        "SELECT * FROM moderation_cases WHERE guild_id = ? AND case_id = ?",
      )
      .get(this.guildId, id) as Record<string, unknown> | undefined;
    return row ? parseModerationCaseRow(row) : null;
  }

  public getCaseByNumber(caseNumber: number): ModerationCase | null {
    const row = this.db
      .prepare(
        "SELECT * FROM moderation_cases WHERE guild_id = ? AND case_number = ?",
      )
      .get(this.guildId, positiveInteger(caseNumber, "case number")) as
      Record<string, unknown> | undefined;
    return row ? parseModerationCaseRow(row) : null;
  }

  public listCases(filter: ModerationCaseListFilter = {}): ModerationCase[] {
    const predicates = ["guild_id = ?"];
    const values: unknown[] = [this.guildId];
    if (filter.targetUserId) {
      predicates.push("target_user_id = ?");
      values.push(
        assertDiscordSnowflake(filter.targetUserId, "target user ID"),
      );
    }
    if (filter.statuses?.length) {
      const statuses = [...new Set(filter.statuses.map(normalizeCaseStatus))];
      predicates.push(`status IN (${statuses.map(() => "?").join(",")})`);
      values.push(...statuses);
    }
    if (filter.actionTypes?.length) {
      const actionTypes = [
        ...new Set(filter.actionTypes.map(normalizeCaseActionType)),
      ];
      predicates.push(
        `action_type IN (${actionTypes.map(() => "?").join(",")})`,
      );
      values.push(...actionTypes);
    }
    values.push(limit(filter.limit), offset(filter.offset));
    return (
      this.db
        .prepare(
          `SELECT * FROM moderation_cases WHERE ${predicates.join(" AND ")}
           ORDER BY case_number DESC LIMIT ? OFFSET ?`,
        )
        .all(...values) as Array<Record<string, unknown>>
    ).map(parseModerationCaseRow);
  }

  public findUniqueActiveCase(
    targetUserId: string,
    actionTypes: readonly ModerationCaseActionType[],
  ): ActiveModerationCaseLookupResult {
    const target = assertDiscordSnowflake(targetUserId, "target user ID");
    const normalizedTypes = [
      ...new Set(actionTypes.map(normalizeCaseActionType)),
    ];
    if (normalizedTypes.length === 0) {
      throw new RangeError("At least one moderation action type is required");
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM moderation_cases
         WHERE guild_id = ? AND target_user_id = ? AND status = 'active'
           AND action_type IN (${normalizedTypes.map(() => "?").join(",")})
         ORDER BY case_number DESC LIMIT 2`,
      )
      .all(this.guildId, target, ...normalizedTypes) as Array<
      Record<string, unknown>
    >;
    if (rows.length === 0) return { status: "none", case: null };
    if (rows.length > 1) return { status: "ambiguous", case: null };
    return { status: "found", case: parseModerationCaseRow(rows[0]!) };
  }

  public findUniqueFailedCase(
    targetUserId: string,
    actionTypes: readonly ModerationCaseActionType[],
    filter: {
      relatedCaseId?: string;
      sources?: readonly ModerationCaseSource[];
    } = {},
  ): ActiveModerationCaseLookupResult {
    const target = assertDiscordSnowflake(targetUserId, "target user ID");
    const normalizedTypes = [
      ...new Set(actionTypes.map(normalizeCaseActionType)),
    ];
    if (normalizedTypes.length === 0) {
      throw new RangeError("At least one moderation action type is required");
    }
    const predicates = [
      "guild_id = ?",
      "target_user_id = ?",
      "status = 'failed'",
      `action_type IN (${normalizedTypes.map(() => "?").join(",")})`,
    ];
    const values: unknown[] = [this.guildId, target, ...normalizedTypes];
    if (filter.relatedCaseId !== undefined) {
      predicates.push("related_case_id = ?");
      values.push(requireOpaqueId(filter.relatedCaseId, "related case ID"));
    }
    if (filter.sources?.length) {
      const sources = [...new Set(filter.sources.map(normalizeCaseSource))];
      predicates.push(`source IN (${sources.map(() => "?").join(",")})`);
      values.push(...sources);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM moderation_cases
         WHERE ${predicates.join(" AND ")}
         ORDER BY case_number DESC LIMIT 2`,
      )
      .all(...values) as Array<Record<string, unknown>>;
    if (rows.length === 0) return { status: "none", case: null };
    if (rows.length > 1) return { status: "ambiguous", case: null };
    return { status: "found", case: parseModerationCaseRow(rows[0]!) };
  }

  public amendCase(
    caseId: string,
    input: ModerationCaseAmendInput,
  ): ModerationCaseTransitionResult {
    const id = requireOpaqueId(caseId, "case ID");
    const actorId = assertDiscordSnowflake(input.actorId, "actor ID");
    let result: ModerationCaseTransitionResult | null = null;
    const amend = this.db.transaction(() => {
      const current = this.getCaseById(id);
      if (!current) return void (result = { status: "not-found", case: null });
      if (
        input.expectedUpdatedAt &&
        input.expectedUpdatedAt !== current.updatedAt
      ) {
        return void (result = { status: "conflict", case: current });
      }
      if (["voided", "overturned"].includes(current.status)) {
        return void (result = { status: "unavailable", case: current });
      }
      const publicReason =
        input.publicReason === undefined
          ? current.publicReason
          : text(input.publicReason, 1, 500, "public reason");
      const privateNote =
        input.privateNote === undefined
          ? current.privateNote
          : input.privateNote === null
            ? null
            : text(input.privateNote, 1, 1_000, "private note");
      if (
        publicReason === current.publicReason &&
        privateNote === current.privateNote
      ) {
        return void (result = { status: "unchanged", case: current });
      }
      const now = nextTimestamp(current.updatedAt);
      const update = this.db
        .prepare(
          `UPDATE moderation_cases SET public_reason = ?, private_note = ?,
             updated_at = ? WHERE guild_id = ? AND case_id = ? AND updated_at = ?`,
        )
        .run(
          publicReason,
          privateNote,
          now,
          this.guildId,
          id,
          current.updatedAt,
        );
      if (update.changes !== 1) {
        return void (result = {
          status: "conflict",
          case: this.requireCase(id),
        });
      }
      this.appendEventWithin(id, {
        type: "amended",
        actorId,
        details: {
          previousPublicReason: current.publicReason,
          publicReason,
          previousPrivateNote: current.privateNote,
          privateNote,
        },
      });
      result = { status: "changed", case: this.requireCase(id) };
    });
    amend.immediate();
    if (!result) throw new Error("Case amendment returned no result");
    return result;
  }

  public voidCase(
    caseId: string,
    input: { actorId: string; reason: string; expectedUpdatedAt?: string },
  ): ModerationCaseTransitionResult {
    return this.finishCase(caseId, "voided", input);
  }

  public completeCase(
    caseId: string,
    input: {
      actorId: string;
      reason?: string;
      relatedCaseId?: string | null;
      expectedUpdatedAt?: string;
    },
  ): ModerationCaseTransitionResult {
    const id = requireOpaqueId(caseId, "case ID");
    const actorId = assertDiscordSnowflake(input.actorId, "actor ID");
    const reason =
      input.reason === undefined
        ? null
        : text(input.reason, 1, 1_000, "completion reason");
    const relatedCaseId =
      input.relatedCaseId === undefined
        ? undefined
        : input.relatedCaseId === null
          ? null
          : requireOpaqueId(input.relatedCaseId, "related case ID");
    if (relatedCaseId === id)
      throw new TypeError("A case cannot relate to itself");
    let result: ModerationCaseTransitionResult | null = null;
    const complete = this.db.transaction(() => {
      const current = this.getCaseById(id);
      if (!current) return void (result = { status: "not-found", case: null });
      if (
        input.expectedUpdatedAt &&
        input.expectedUpdatedAt !== current.updatedAt
      ) {
        return void (result = { status: "conflict", case: current });
      }
      const nextRelatedCaseId =
        relatedCaseId === undefined ? current.relatedCaseId : relatedCaseId;
      if (
        current.status === "completed" &&
        nextRelatedCaseId === current.relatedCaseId
      ) {
        return void (result = { status: "unchanged", case: current });
      }
      if (current.status !== "active") {
        return void (result = { status: "unavailable", case: current });
      }
      const now = nextTimestamp(current.updatedAt);
      const updated = this.db
        .prepare(
          `UPDATE moderation_cases SET status = 'completed', related_case_id = ?,
           updated_at = ? WHERE guild_id = ? AND case_id = ? AND updated_at = ?`,
        )
        .run(nextRelatedCaseId, now, this.guildId, id, current.updatedAt);
      if (updated.changes !== 1) {
        return void (result = {
          status: "conflict",
          case: this.requireCase(id),
        });
      }
      this.appendEventWithin(id, {
        type: "completed",
        actorId,
        details: { reason, relatedCaseId: nextRelatedCaseId },
      });
      result = { status: "changed", case: this.requireCase(id) };
    });
    complete.immediate();
    if (!result) throw new Error("Case completion returned no result");
    return result;
  }

  public completeExpiredTimeoutCase(
    caseId: string,
    input: ExpiredTimeoutCaseCompletionInput,
  ): ModerationCaseTransitionResult {
    const id = requireOpaqueId(caseId, "timeout case ID");
    const actorId = assertDiscordSnowflake(input.actorId, "actor ID");
    const observedAt = iso(input.observedAt);
    const observedTime = Date.parse(observedAt);
    const wallClock = Date.now();
    if (observedTime > wallClock + 5_000) {
      throw new RangeError(
        "Timeout absence observation cannot be in the future",
      );
    }
    if (observedTime < wallClock - MAX_TIMEOUT_ABSENCE_AGE_MS) {
      throw new RangeError("Timeout absence observation is no longer fresh");
    }
    let result: ModerationCaseTransitionResult | null = null;
    const complete = this.db.transaction(() => {
      const current = this.getCaseById(id);
      if (!current) return void (result = { status: "not-found", case: null });
      const hasExpiryEvent = Boolean(
        this.db
          .prepare(
            `SELECT 1 FROM moderation_case_events
             WHERE guild_id = ? AND case_id = ? AND event_type = 'timeout-expired'
             LIMIT 1`,
          )
          .get(this.guildId, id),
      );
      if (current.status === "completed" && hasExpiryEvent) {
        return void (result = { status: "unchanged", case: current });
      }
      if (current.updatedAt !== input.expectedUpdatedAt) {
        return void (result = { status: "conflict", case: current });
      }
      const expiresAt = readTimeoutExpiry(current);
      if (
        current.status !== "active" ||
        !["timeout", "automod-timeout"].includes(current.actionType) ||
        !expiresAt ||
        Date.parse(expiresAt) > Date.parse(observedAt)
      ) {
        return void (result = { status: "unavailable", case: current });
      }
      const now = nextTimestamp(current.updatedAt);
      const updated = this.db
        .prepare(
          `UPDATE moderation_cases SET status = 'completed', updated_at = ?
           WHERE guild_id = ? AND case_id = ? AND status = 'active'
             AND updated_at = ?`,
        )
        .run(now, this.guildId, id, current.updatedAt);
      if (updated.changes !== 1) {
        return void (result = {
          status: "conflict",
          case: this.requireCase(id),
        });
      }
      this.appendEventWithin(id, {
        type: "timeout-expired",
        actorId,
        details: { expiresAt, observedAt },
      });
      result = { status: "changed", case: this.requireCase(id) };
    });
    complete.immediate();
    if (!result)
      throw new Error("Expired timeout completion returned no result");
    return result;
  }

  public overturnCase(
    caseId: string,
    input: { actorId: string; reason: string; expectedUpdatedAt?: string },
  ): ModerationCaseTransitionResult {
    return this.finishCase(caseId, "overturned", input);
  }

  public appendEvent(
    caseId: string,
    input: ModerationCaseEventInput,
  ): ModerationCaseEvent | null {
    const id = requireOpaqueId(caseId, "case ID");
    let result: ModerationCaseEvent | null = null;
    const append = this.db.transaction(() => {
      if (this.getCaseById(id)) result = this.appendEventWithin(id, input);
    });
    append.immediate();
    return result;
  }

  public listEvents(
    caseId: string,
    listLimit = MAX_EVENTS_PER_CASE,
    listOffset = 0,
  ): ModerationCaseEvent[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM moderation_case_events
           WHERE guild_id = ? AND case_id = ? ORDER BY event_number
           LIMIT ? OFFSET ?`,
        )
        .all(
          this.guildId,
          requireOpaqueId(caseId, "case ID"),
          limit(listLimit),
          offset(listOffset),
        ) as Array<Record<string, unknown>>
    ).map(parseModerationCaseEventRow);
  }

  public getLogDelivery(caseId: string): ModerationLogDelivery | null {
    const id = normalizeOpaqueId(caseId);
    if (!id) return null;
    const row = this.db
      .prepare(
        "SELECT * FROM moderation_log_deliveries WHERE guild_id = ? AND case_id = ?",
      )
      .get(this.guildId, id) as Record<string, unknown> | undefined;
    return row ? parseModerationLogDeliveryRow(row) : null;
  }

  public getLogDeliveryAttempt(caseId: string): DeliveryAttempt | null {
    const id = normalizeOpaqueId(caseId);
    if (!id) return null;
    const row = this.db
      .prepare(
        `SELECT delivery_attempt_id, delivery_attempt_channel_id,
                delivery_attempt_started_at
         FROM moderation_log_deliveries WHERE guild_id = ? AND case_id = ?`,
      )
      .get(this.guildId, id) as Record<string, unknown> | undefined;
    return row ? parseDeliveryAttempt(row) : null;
  }

  public beginLogDeliveryAttempt(
    caseId: string,
    input: DeliveryAttemptInput,
  ): DeliveryAttemptTransitionResult<ModerationLogDelivery> {
    const id = requireOpaqueId(caseId, "case ID");
    const channelId = assertDiscordSnowflake(input.channelId, "channel ID");
    const claimId = requireOpaqueId(input.claimId, "delivery claim ID");
    const previousAttemptId =
      input.previousAttemptId === undefined
        ? null
        : requireOpaqueId(
            input.previousAttemptId,
            "previous delivery attempt ID",
          );
    let result: DeliveryAttemptTransitionResult<ModerationLogDelivery> | null =
      null;
    const begin = this.db.transaction(() => {
      const record = this.getLogDelivery(id);
      if (!record) {
        result = { status: "not-found", record: null, attempt: null };
        return;
      }
      const row = this.db
        .prepare(
          `SELECT delivery_state, delivery_claim_id, delivery_claim_expires_at,
                  delivery_attempt_id, delivery_attempt_channel_id,
                  delivery_attempt_started_at, updated_at
           FROM moderation_log_deliveries WHERE guild_id = ? AND case_id = ?`,
        )
        .get(this.guildId, id) as Record<string, unknown>;
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
        !["pending", "failed", "missing"].includes(
          String(row.delivery_state),
        ) ||
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
      const version = nextTimestamp(record.updatedAt);
      const updated = this.db
        .prepare(
          `UPDATE moderation_log_deliveries
           SET delivery_attempt_id = ?, delivery_attempt_channel_id = ?,
               delivery_attempt_started_at = ?, updated_at = ?
           WHERE guild_id = ? AND case_id = ? AND updated_at = ?
             AND delivery_claim_id = ? AND delivery_claim_expires_at > ?`,
        )
        .run(
          nextAttempt.attemptId,
          nextAttempt.channelId,
          nextAttempt.startedAt,
          version,
          this.guildId,
          id,
          record.updatedAt,
          claimId,
          wallClock,
        );
      if (updated.changes !== 1) {
        result = {
          status: "conflict",
          record: this.getLogDelivery(id) ?? record,
          attempt: this.getLogDeliveryAttempt(id),
        };
        return;
      }
      this.appendEventWithin(id, {
        type: "recovery-noted",
        details: {
          reason: attempt
            ? "delivery-attempt-rotated"
            : "delivery-attempt-started",
          channelId,
        },
      });
      result = {
        status: "changed",
        record: this.getLogDelivery(id)!,
        attempt: nextAttempt,
      };
    });
    begin.immediate();
    if (!result) throw new Error("Moderation log attempt returned no result");
    return result;
  }

  public claimLogDelivery(
    caseId: string,
    expectedUpdatedAt?: string,
  ): DeliveryClaimResult<ModerationLogDelivery> {
    const id = requireOpaqueId(caseId, "case ID");
    let result: DeliveryClaimResult<ModerationLogDelivery> | null = null;
    const claim = this.db.transaction(() => {
      const current = this.getLogDelivery(id);
      if (!current) {
        result = {
          status: "not-found",
          claimId: null,
          retryAt: null,
          record: null,
        };
        return;
      }
      if (expectedUpdatedAt && current.updatedAt !== expectedUpdatedAt) {
        result = {
          status: "conflict",
          claimId: null,
          retryAt: null,
          record: current,
        };
        return;
      }
      if (!["pending", "failed", "missing"].includes(current.state)) {
        result = {
          status: "unavailable",
          claimId: null,
          retryAt: null,
          record: current,
        };
        return;
      }
      const row = this.db
        .prepare(
          `SELECT delivery_claim_id, delivery_claim_expires_at
         FROM moderation_log_deliveries WHERE guild_id = ? AND case_id = ?`,
        )
        .get(this.guildId, id) as {
        delivery_claim_id: string | null;
        delivery_claim_expires_at: string | null;
      };
      const wallClock = utcNow();
      const version = nextTimestamp(current.updatedAt);
      if (
        row.delivery_claim_id &&
        row.delivery_claim_expires_at &&
        Date.parse(row.delivery_claim_expires_at) > Date.parse(wallClock)
      ) {
        result = {
          status: "busy",
          claimId: null,
          retryAt: row.delivery_claim_expires_at,
          record: current,
        };
        return;
      }
      const claimId = createOpaqueStorageId();
      const retryAt = new Date(
        Date.parse(wallClock) + DELIVERY_CLAIM_SECONDS * 1_000,
      ).toISOString();
      const changed = this.db
        .prepare(
          `UPDATE moderation_log_deliveries SET delivery_claim_id = ?,
           delivery_claim_expires_at = ?, updated_at = ?
         WHERE guild_id = ? AND case_id = ? AND updated_at = ?
           AND (delivery_claim_id IS NULL OR delivery_claim_expires_at <= ?)`,
        )
        .run(
          claimId,
          retryAt,
          version,
          this.guildId,
          id,
          current.updatedAt,
          wallClock,
        );
      if (changed.changes !== 1) {
        result = {
          status: "conflict",
          claimId: null,
          retryAt: null,
          record: this.getLogDelivery(id) ?? current,
        };
        return;
      }
      result = {
        status: "claimed",
        claimId,
        retryAt,
        record: this.getLogDelivery(id)!,
      };
    });
    claim.immediate();
    if (!result)
      throw new Error("Moderation log delivery claim returned no result");
    return result;
  }

  public completeLogDelivery(
    caseId: string,
    channelId: string,
    messageId: string,
    claimId: string,
    expectedUpdatedAt?: string,
  ): ModerationLogDelivery | null {
    const id = requireOpaqueId(caseId, "case ID");
    const current = this.getLogDelivery(id);
    if (
      !current ||
      (expectedUpdatedAt && current.updatedAt !== expectedUpdatedAt)
    )
      return current;
    if (current.state === "delivered") return current;
    const deliveryChannelId = assertDiscordSnowflake(channelId, "channel ID");
    const attempt = this.getLogDeliveryAttempt(id);
    if (attempt && attempt.channelId !== deliveryChannelId) return current;
    const token = requireOpaqueId(claimId, "delivery claim ID");
    const wallClock = utcNow();
    const version = nextTimestamp(current.updatedAt);
    const updated = this.db
      .prepare(
        `UPDATE moderation_log_deliveries SET delivery_state = 'delivered',
           channel_id = ?, message_id = ?, attempt_count = attempt_count + 1,
           last_failure_code = NULL, delivery_claim_id = NULL,
           delivery_claim_expires_at = NULL, delivery_attempt_id = NULL,
           delivery_attempt_channel_id = NULL,
           delivery_attempt_started_at = NULL, delivered_at = ?, updated_at = ?
         WHERE guild_id = ? AND case_id = ? AND updated_at = ?
           AND delivery_claim_id = ? AND delivery_claim_expires_at > ?`,
      )
      .run(
        deliveryChannelId,
        assertDiscordSnowflake(messageId, "message ID"),
        wallClock,
        version,
        this.guildId,
        id,
        current.updatedAt,
        token,
        wallClock,
      );
    if (updated.changes !== 1) return this.getLogDelivery(id);
    this.appendEvent(id, {
      type: "log-delivered",
      details: { channelId, messageId },
    });
    return this.getLogDelivery(id);
  }

  public failLogDelivery(
    caseId: string,
    failureCode: string,
    claimId?: string,
    expectedUpdatedAt?: string,
  ): ModerationLogDelivery | null {
    return this.setLogFailure(
      caseId,
      "failed",
      failureCode,
      claimId,
      expectedUpdatedAt,
    );
  }

  public markLogDeliveryMissing(
    caseId: string,
    failureCode = "message-missing",
    expectedUpdatedAt?: string,
  ): ModerationLogDelivery | null {
    return this.setLogFailure(
      caseId,
      "missing",
      failureCode,
      undefined,
      expectedUpdatedAt,
    );
  }

  public checkpointLogDeliveryOrphan(
    caseId: string,
    input: {
      channelId: string;
      messageId: string;
      claimId: string;
      failureCode: string;
      expectedUpdatedAt: string;
    },
  ): ModerationLogDeliveryTransitionResult {
    const id = requireOpaqueId(caseId, "case ID");
    const channelId = assertDiscordSnowflake(input.channelId, "channel ID");
    const messageId = assertDiscordSnowflake(input.messageId, "message ID");
    const claimId = requireOpaqueId(input.claimId, "delivery claim ID");
    const failureCode = text(input.failureCode, 1, 100, "failure code");
    let result: ModerationLogDeliveryTransitionResult | null = null;
    const checkpoint = this.db.transaction(() => {
      const current = this.getLogDelivery(id);
      if (!current) {
        result = { status: "not-found", delivery: null };
        return;
      }
      if (
        current.state === "delivered" &&
        current.channelId === channelId &&
        current.messageId === messageId
      ) {
        result = { status: "unchanged", delivery: current };
        return;
      }
      if (
        current.state === "missing" &&
        current.channelId === channelId &&
        current.messageId === messageId &&
        current.lastFailureCode === failureCode &&
        this.getLogDeliveryAttempt(id) === null
      ) {
        result = { status: "unchanged", delivery: current };
        return;
      }
      const attempt = this.getLogDeliveryAttempt(id);
      if (current.updatedAt !== input.expectedUpdatedAt) {
        result = { status: "conflict", delivery: current };
        return;
      }
      if (
        !["pending", "failed", "missing"].includes(current.state) ||
        (attempt !== null && attempt.channelId !== channelId) ||
        (current.messageId !== null &&
          (current.channelId !== channelId || current.messageId !== messageId))
      ) {
        result = { status: "unavailable", delivery: current };
        return;
      }
      const claim = this.db
        .prepare(
          `SELECT delivery_claim_id, delivery_claim_expires_at
           FROM moderation_log_deliveries
           WHERE guild_id = ? AND case_id = ?`,
        )
        .get(this.guildId, id) as {
        delivery_claim_id: string | null;
        delivery_claim_expires_at: string | null;
      };
      const wallClock = utcNow();
      if (
        claim.delivery_claim_id !== claimId ||
        !claim.delivery_claim_expires_at ||
        Date.parse(claim.delivery_claim_expires_at) <= Date.parse(wallClock)
      ) {
        result = { status: "unavailable", delivery: current };
        return;
      }
      const version = nextTimestamp(current.updatedAt);
      const updated = this.db
        .prepare(
          `UPDATE moderation_log_deliveries SET delivery_state = 'missing',
             channel_id = ?, message_id = ?, attempt_count = attempt_count + 1,
             last_failure_code = ?, delivery_claim_id = NULL,
             delivery_claim_expires_at = NULL, delivery_attempt_id = NULL,
             delivery_attempt_channel_id = NULL,
             delivery_attempt_started_at = NULL, delivered_at = ?, updated_at = ?
           WHERE guild_id = ? AND case_id = ? AND updated_at = ?
             AND delivery_claim_id = ?`,
        )
        .run(
          channelId,
          messageId,
          failureCode,
          wallClock,
          version,
          this.guildId,
          id,
          current.updatedAt,
          claimId,
        );
      if (updated.changes !== 1) {
        result = {
          status: "conflict",
          delivery: this.getLogDelivery(id) ?? current,
        };
        return;
      }
      this.appendEventWithin(id, {
        type: "recovery-noted",
        details: {
          reason: "orphan-delete-ambiguous",
          channelId,
          messageId,
          failureCode,
        },
      });
      result = { status: "changed", delivery: this.getLogDelivery(id)! };
    });
    checkpoint.immediate();
    if (!result)
      throw new Error("Moderation log orphan checkpoint returned no result");
    return result;
  }

  public listRecoverableLogDeliveries(listLimit = 25): ModerationLogDelivery[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM moderation_log_deliveries WHERE guild_id = ?
           AND delivery_state IN ('pending', 'failed', 'missing')
           ORDER BY updated_at LIMIT ?`,
        )
        .all(this.guildId, limit(listLimit)) as Array<Record<string, unknown>>
    ).map(parseModerationLogDeliveryRow);
  }

  private finishCase(
    caseId: string,
    state: "voided" | "overturned",
    input: { actorId: string; reason: string; expectedUpdatedAt?: string },
  ): ModerationCaseTransitionResult {
    const id = requireOpaqueId(caseId, "case ID");
    const actor = assertDiscordSnowflake(input.actorId, "actor ID");
    const reason = text(input.reason, 1, 1_000, `${state} reason`);
    let result: ModerationCaseTransitionResult | null = null;
    const finish = this.db.transaction(() => {
      const current = this.getCaseById(id);
      if (!current) return void (result = { status: "not-found", case: null });
      if (
        input.expectedUpdatedAt &&
        input.expectedUpdatedAt !== current.updatedAt
      ) {
        return void (result = { status: "conflict", case: current });
      }
      if (current.status === state)
        return void (result = { status: "unchanged", case: current });
      if (["voided", "overturned"].includes(current.status)) {
        return void (result = { status: "unavailable", case: current });
      }
      const now = nextTimestamp(current.updatedAt);
      const columns =
        state === "voided"
          ? "voided_by = ?, voided_at = ?, void_reason = ?"
          : "overturned_by = ?, overturned_at = ?, overturn_reason = ?";
      const update = this.db
        .prepare(
          `UPDATE moderation_cases SET status = ?, ${columns}, updated_at = ?
           WHERE guild_id = ? AND case_id = ? AND updated_at = ?`,
        )
        .run(
          state,
          actor,
          now,
          reason,
          now,
          this.guildId,
          id,
          current.updatedAt,
        );
      if (update.changes !== 1) {
        return void (result = {
          status: "conflict",
          case: this.requireCase(id),
        });
      }
      this.appendEventWithin(id, {
        type: state,
        actorId: actor,
        details: { reason },
      });
      result = { status: "changed", case: this.requireCase(id) };
    });
    finish.immediate();
    if (!result) throw new Error("Case transition returned no result");
    return result;
  }

  private setLogFailure(
    caseId: string,
    state: "failed" | "missing",
    failureCode: string,
    claimId?: string,
    expected?: string,
  ): ModerationLogDelivery | null {
    const id = requireOpaqueId(caseId, "case ID");
    const current = this.getLogDelivery(id);
    if (
      !current ||
      (state === "failed" && current.state === "delivered") ||
      (state === "missing" && current.state !== "delivered") ||
      (expected && current.updatedAt !== expected)
    )
      return current;
    const claim = this.db
      .prepare(
        `SELECT delivery_claim_id, delivery_claim_expires_at
         FROM moderation_log_deliveries
       WHERE guild_id = ? AND case_id = ?`,
      )
      .get(this.guildId, id) as {
      delivery_claim_id: string | null;
      delivery_claim_expires_at: string | null;
    };
    if (
      state === "failed" &&
      ((claim.delivery_claim_id !== null &&
        (claimId !== claim.delivery_claim_id ||
          claim.delivery_claim_expires_at === null ||
          Date.parse(claim.delivery_claim_expires_at) <= Date.now())) ||
        (claim.delivery_claim_id === null && claimId !== undefined))
    )
      return current;
    const updated = this.db
      .prepare(
        `UPDATE moderation_log_deliveries SET delivery_state = ?, message_id = NULL,
           channel_id = NULL, delivered_at = NULL, attempt_count = attempt_count + 1,
           last_failure_code = ?, delivery_claim_id = NULL,
           delivery_claim_expires_at = NULL, delivery_attempt_id = NULL,
           delivery_attempt_channel_id = NULL,
           delivery_attempt_started_at = NULL, updated_at = ?
         WHERE guild_id = ? AND case_id = ? AND updated_at = ?`,
      )
      .run(
        state,
        text(failureCode, 1, 100, "failure code"),
        nextTimestamp(current.updatedAt),
        this.guildId,
        id,
        current.updatedAt,
      );
    if (updated.changes !== 1) return this.getLogDelivery(id);
    this.appendEvent(id, {
      type: "log-failed",
      details: { state, failureCode },
    });
    return this.getLogDelivery(id);
  }

  private appendEventWithin(
    caseId: string,
    input: ModerationCaseEventInput,
  ): ModerationCaseEvent {
    if (
      !(MODERATION_CASE_EVENT_TYPES as readonly unknown[]).includes(input.type)
    ) {
      throw new TypeError("Unsupported moderation case event type");
    }
    const next = this.db
      .prepare(
        `SELECT COALESCE(MAX(event_number), 0) + 1 AS next FROM moderation_case_events
         WHERE guild_id = ? AND case_id = ?`,
      )
      .get(this.guildId, caseId) as { next: number };
    const eventId = createOpaqueStorageId();
    this.db
      .prepare(
        `INSERT INTO moderation_case_events (
           guild_id, case_id, event_id, event_number, event_type, actor_id,
           details_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.guildId,
        caseId,
        eventId,
        Number(next.next),
        input.type,
        input.actorId == null
          ? null
          : assertDiscordSnowflake(input.actorId, "actor ID"),
        serializeJson(input.details ?? {}, 4_000),
        utcNow(),
      );
    this.db
      .prepare(
        `DELETE FROM moderation_case_events WHERE guild_id = ? AND case_id = ?
         AND event_id IN (SELECT event_id FROM moderation_case_events
           WHERE guild_id = ? AND case_id = ? ORDER BY event_number DESC LIMIT -1 OFFSET ?)`,
      )
      .run(this.guildId, caseId, this.guildId, caseId, MAX_EVENTS_PER_CASE);
    const row = this.db
      .prepare(
        `SELECT * FROM moderation_case_events
         WHERE guild_id = ? AND case_id = ? AND event_id = ?`,
      )
      .get(this.guildId, caseId, eventId) as Record<string, unknown>;
    return parseModerationCaseEventRow(row);
  }

  private nextCaseNumber(): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(case_number), 0) + 1 AS next FROM moderation_cases WHERE guild_id = ?",
      )
      .get(this.guildId) as { next: number };
    return positiveInteger(Number(row.next), "case number");
  }

  private assertCaseCapacity(): void {
    const count = Number(
      (
        this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM moderation_cases WHERE guild_id = ?",
          )
          .get(this.guildId) as { count: number }
      ).count,
    );
    if (count >= MAX_CASES) {
      throw new RangeError(
        `moderation_cases reached its ${MAX_CASES}-record safety limit`,
      );
    }
  }

  private assertCaseCreationAllowed(
    input: ModerationCaseInput & { relatedCaseId: string | null },
    allowRecoveryRemoval: boolean,
  ): void {
    const configuration = this.getConfiguration();
    if (!configuration || configuration.casesEnabled) return;
    const originalActionTypes: readonly ModerationCaseActionType[] | null =
      input.actionType === "timeout-removed"
        ? ["timeout", "automod-timeout"]
        : input.actionType === "unban"
          ? ["ban"]
          : null;
    if (!allowRecoveryRemoval || !originalActionTypes || !input.relatedCaseId) {
      throw new RangeError("New moderation cases are disabled");
    }
    const original = this.getCaseById(input.relatedCaseId);
    const lookup = this.findUniqueActiveCase(
      input.targetUserId,
      originalActionTypes,
    );
    const existingRemoval = this.db
      .prepare(
        `SELECT 1 FROM moderation_cases
         WHERE guild_id = ? AND related_case_id = ? AND action_type = ?
           AND status = 'failed' LIMIT 1`,
      )
      .get(this.guildId, input.relatedCaseId, input.actionType);
    if (
      !original ||
      existingRemoval ||
      lookup.status !== "found" ||
      lookup.case.caseId !== original.caseId ||
      original.targetUserId !== input.targetUserId ||
      !originalActionTypes.includes(original.actionType) ||
      original.status !== "active" ||
      original.relatedCaseId !== null
    ) {
      throw new RangeError(
        "Disabled case recovery requires one unlinked active original case",
      );
    }
  }

  private requireConfiguration(): ModerationConfiguration {
    const configuration = this.getConfiguration();
    if (!configuration)
      throw new Error("Moderation configuration was not persisted");
    return configuration;
  }

  private requireCase(caseId: string): ModerationCase {
    const record = this.getCaseById(caseId);
    if (!record) throw new Error("Moderation case was not persisted");
    return record;
  }
}

function normalizeConfiguration(
  input: ModerationConfigurationInput,
  current: ModerationConfiguration | null,
): Omit<
  ModerationConfiguration,
  "guildId" | "createdBy" | "updatedBy" | "createdAt" | "updatedAt"
> {
  const snowflake = (
    value: string | null | undefined,
    label: string,
    fallback: string | null,
  ) =>
    value === undefined
      ? fallback
      : value === null
        ? null
        : assertDiscordSnowflake(value, label);
  const timestamp = (
    value: string | null | undefined,
    fallback: string | null,
  ) => (value === undefined ? fallback : value === null ? null : iso(value));
  const next = {
    casesEnabled: input.casesEnabled ?? current?.casesEnabled ?? false,
    moderationLogChannelId: snowflake(
      input.moderationLogChannelId,
      "moderation log channel ID",
      current?.moderationLogChannelId ?? null,
    ),
    moderationLogVerifiedAt: timestamp(
      input.moderationLogVerifiedAt,
      current?.moderationLogVerifiedAt ?? null,
    ),
    reportsEnabled: input.reportsEnabled ?? current?.reportsEnabled ?? false,
    reportReviewChannelId: snowflake(
      input.reportReviewChannelId,
      "report review channel ID",
      current?.reportReviewChannelId ?? null,
    ),
    reportReviewerRoleId: snowflake(
      input.reportReviewerRoleId,
      "report reviewer role ID",
      current?.reportReviewerRoleId ?? null,
    ),
    reportBindingsVerifiedAt: timestamp(
      input.reportBindingsVerifiedAt,
      current?.reportBindingsVerifiedAt ?? null,
    ),
    appealsEnabled: input.appealsEnabled ?? current?.appealsEnabled ?? false,
    appealReviewChannelId: snowflake(
      input.appealReviewChannelId,
      "appeal review channel ID",
      current?.appealReviewChannelId ?? null,
    ),
    appealReviewerRoleId: snowflake(
      input.appealReviewerRoleId,
      "appeal reviewer role ID",
      current?.appealReviewerRoleId ?? null,
    ),
    appealBindingsVerifiedAt: timestamp(
      input.appealBindingsVerifiedAt,
      current?.appealBindingsVerifiedAt ?? null,
    ),
    antiSpamEnabled: input.antiSpamEnabled ?? current?.antiSpamEnabled ?? false,
    reportCooldownLimit: integer(
      input.reportCooldownLimit ?? current?.reportCooldownLimit ?? 3,
      1,
      10,
      "report cooldown limit",
    ),
    reportCooldownWindowSeconds: integer(
      input.reportCooldownWindowSeconds ??
        current?.reportCooldownWindowSeconds ??
        1_800,
      60,
      86_400,
      "report cooldown window",
    ),
  };
  const moderationLogChanged =
    current !== null &&
    input.moderationLogChannelId !== undefined &&
    next.moderationLogChannelId !== current.moderationLogChannelId;
  if (moderationLogChanged && input.moderationLogVerifiedAt === undefined) {
    next.moderationLogVerifiedAt = null;
  }
  const reportBindingChanged =
    current !== null &&
    ((input.reportReviewChannelId !== undefined &&
      next.reportReviewChannelId !== current.reportReviewChannelId) ||
      (input.reportReviewerRoleId !== undefined &&
        next.reportReviewerRoleId !== current.reportReviewerRoleId));
  if (reportBindingChanged && input.reportBindingsVerifiedAt === undefined) {
    next.reportBindingsVerifiedAt = null;
    next.reportsEnabled = false;
  }
  const appealBindingChanged =
    current !== null &&
    ((input.appealReviewChannelId !== undefined &&
      next.appealReviewChannelId !== current.appealReviewChannelId) ||
      (input.appealReviewerRoleId !== undefined &&
        next.appealReviewerRoleId !== current.appealReviewerRoleId));
  if (appealBindingChanged && input.appealBindingsVerifiedAt === undefined) {
    next.appealBindingsVerifiedAt = null;
    next.appealsEnabled = false;
  }
  if (next.moderationLogVerifiedAt && !next.moderationLogChannelId)
    throw new TypeError("Verified moderation log requires a channel");
  if (
    next.reportsEnabled &&
    (!next.reportReviewChannelId ||
      !next.reportReviewerRoleId ||
      !next.reportBindingsVerifiedAt)
  )
    throw new TypeError("Enabled reports require verified review bindings");
  if (
    next.appealsEnabled &&
    (!next.appealReviewChannelId ||
      !next.appealReviewerRoleId ||
      !next.appealBindingsVerifiedAt)
  )
    throw new TypeError("Enabled appeals require verified review bindings");
  return next;
}

function normalizeCaseInput(input: ModerationCaseInput): ModerationCaseInput & {
  privateNote: string | null;
  relatedCaseId: string | null;
} {
  if (
    !(MODERATION_CASE_ACTION_TYPES as readonly unknown[]).includes(
      input.actionType,
    )
  )
    throw new TypeError("Unsupported moderation action type");
  if (!(MODERATION_CASE_SOURCES as readonly unknown[]).includes(input.source))
    throw new TypeError("Unsupported moderation case source");
  const actionType = input.actionType as ModerationCaseActionType;
  const source = input.source;
  return {
    ...input,
    targetUserId: assertDiscordSnowflake(input.targetUserId, "target user ID"),
    actorId: assertDiscordSnowflake(input.actorId, "actor ID"),
    publicReason: text(input.publicReason, 1, 500, "public reason"),
    privateNote:
      input.privateNote == null
        ? null
        : text(input.privateNote, 1, 1_000, "private note"),
    discordActionMetadata: validateModerationCaseMetadata(
      input.discordActionMetadata ?? {},
      source,
      actionType,
    ),
    status: normalizeCaseStatus(input.status),
    relatedCaseId:
      input.relatedCaseId == null
        ? null
        : requireOpaqueId(input.relatedCaseId, "related case ID"),
  };
}

export function parseModerationConfigurationRow(
  row: Record<string, unknown>,
): ModerationConfiguration {
  return {
    guildId: String(row.guild_id),
    casesEnabled: Boolean(row.cases_enabled),
    moderationLogChannelId: nullable(row.moderation_log_channel_id),
    moderationLogVerifiedAt: nullable(row.moderation_log_verified_at),
    reportsEnabled: Boolean(row.reports_enabled),
    reportReviewChannelId: nullable(row.report_review_channel_id),
    reportReviewerRoleId: nullable(row.report_reviewer_role_id),
    reportBindingsVerifiedAt: nullable(row.report_bindings_verified_at),
    appealsEnabled: Boolean(row.appeals_enabled),
    appealReviewChannelId: nullable(row.appeal_review_channel_id),
    appealReviewerRoleId: nullable(row.appeal_reviewer_role_id),
    appealBindingsVerifiedAt: nullable(row.appeal_bindings_verified_at),
    antiSpamEnabled: Boolean(row.anti_spam_enabled),
    reportCooldownLimit: Number(row.report_cooldown_limit),
    reportCooldownWindowSeconds: Number(row.report_cooldown_window_seconds),
    createdBy: String(row.created_by),
    updatedBy: String(row.updated_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function parseModerationCaseRow(
  row: Record<string, unknown>,
): ModerationCase {
  return {
    guildId: String(row.guild_id),
    caseId: String(row.case_id),
    caseNumber: Number(row.case_number),
    targetUserId: String(row.target_user_id),
    actorId: String(row.actor_id),
    actionType: row.action_type as ModerationCase["actionType"],
    source: row.source as ModerationCase["source"],
    publicReason: String(row.public_reason),
    privateNote: nullable(row.private_note),
    discordActionMetadata: parseJson(String(row.discord_action_metadata_json)),
    status: normalizeCaseStatus(row.status),
    relatedCaseId: nullable(row.related_case_id),
    voidedBy: nullable(row.voided_by),
    voidedAt: nullable(row.voided_at),
    voidReason: nullable(row.void_reason),
    overturnedBy: nullable(row.overturned_by),
    overturnedAt: nullable(row.overturned_at),
    overturnReason: nullable(row.overturn_reason),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function parseModerationCaseEventRow(
  row: Record<string, unknown>,
): ModerationCaseEvent {
  return {
    guildId: String(row.guild_id),
    caseId: String(row.case_id),
    eventId: String(row.event_id),
    eventNumber: Number(row.event_number),
    type: row.event_type as ModerationCaseEvent["type"],
    actorId: nullable(row.actor_id),
    details: parseJson(String(row.details_json)),
    createdAt: String(row.created_at),
  };
}

export function parseModerationLogDeliveryRow(
  row: Record<string, unknown>,
): ModerationLogDelivery {
  return {
    guildId: String(row.guild_id),
    caseId: String(row.case_id),
    state: row.delivery_state as ModerationLogDeliveryState,
    channelId: nullable(row.channel_id),
    messageId: nullable(row.message_id),
    attemptCount: Number(row.attempt_count),
    lastFailureCode: nullable(row.last_failure_code),
    deliveredAt: nullable(row.delivered_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
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
    startedAt: iso(startedAt),
  };
}

function normalizeCaseStatus(value: unknown): ModerationCaseStatus {
  if (!(MODERATION_CASE_STATUSES as readonly unknown[]).includes(value))
    throw new TypeError("Unsupported moderation case status");
  return value as ModerationCaseStatus;
}
function normalizeCaseActionType(value: unknown): ModerationCaseActionType {
  if (!(MODERATION_CASE_ACTION_TYPES as readonly unknown[]).includes(value)) {
    throw new TypeError("Unsupported moderation action type");
  }
  return value as ModerationCaseActionType;
}
function normalizeCaseSource(value: unknown): ModerationCaseSource {
  if (!(MODERATION_CASE_SOURCES as readonly unknown[]).includes(value)) {
    throw new TypeError("Unsupported moderation case source");
  }
  return value as ModerationCaseSource;
}
function readTimeoutExpiry(moderationCase: ModerationCase): string | null {
  const metadata = moderationCase.discordActionMetadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as { expiresAt?: unknown }).expiresAt;
  if (typeof value !== "string") return null;
  try {
    return iso(value);
  } catch {
    return null;
  }
}
function requireOpaqueId(value: unknown, label: string): string {
  const id = normalizeOpaqueId(value);
  if (!id) throw new TypeError(`${label} must be an 8-24 character opaque ID`);
  return id;
}
function normalizeOpaqueId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,24}$/.test(value)
    ? value
    : null;
}
function text(value: unknown, min: number, max: number, label: string): string {
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
function serializeJson(value: unknown, max: number): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new TypeError("Value must be JSON-safe");
  }
  if (!json || Buffer.byteLength(json, "utf8") > max)
    throw new RangeError(`JSON exceeds ${max} bytes`);
  return json;
}
function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}
function nullable(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
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
function positiveInteger(value: unknown, label: string): number {
  return integer(value, 1, 2_147_483_647, label);
}
function limit(value: number | undefined = 25): number {
  return integer(value, 1, MAX_LIST_LIMIT, "list limit");
}
function offset(value: number | undefined = 0): number {
  return integer(value, 0, 2_147_483_647, "list offset");
}
function iso(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new TypeError("Timestamp must be valid");
  return new Date(time).toISOString();
}
function bool(value: boolean): number {
  return value ? 1 : 0;
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
