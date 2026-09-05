import { randomBytes } from "node:crypto";
import type { DatabaseConnection } from "./database.js";
import { assertDiscordSnowflake } from "../guild-settings.js";
import {
  APPLICATION_EVENT_TYPES,
  APPLICATION_STATES,
  FORM_FIELD_TYPES,
  type ApplicationDecisionInput,
  type ApplicationDeliveryInput,
  type ApplicationDeliveryResult,
  type ApplicationEvent,
  type ApplicationEventInput,
  type ApplicationEventType,
  type ApplicationForm,
  type ApplicationFormDeleteResult,
  type ApplicationFormField,
  type ApplicationFormFieldInput,
  type ApplicationFormInput,
  type ApplicationFormUpdate,
  type ApplicationRecord,
  type ApplicationReservationInput,
  type ApplicationReservationResult,
  type ApplicationResponse,
  type ApplicationState,
  type ApplicationTransitionResult,
  type DeliveryState,
  type FormFieldType,
} from "../types.js";

interface ApplicationFormRow {
  guild_id: string;
  form_id: string;
  slug: string;
  display_name: string;
  description: string;
  reviewer_role_id: string;
  review_channel_id: string;
  enabled: number;
  sort_order: number;
  definition_version: number;
  bindings_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ApplicationFormFieldRow {
  guild_id: string;
  form_id: string;
  field_id: string;
  label: string;
  description: string | null;
  placeholder: string | null;
  field_type: string;
  required: number;
  min_length: number;
  max_length: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface ApplicationRow {
  guild_id: string;
  application_id: string;
  application_number: number;
  form_id: string;
  applicant_id: string;
  state: string;
  delivery_state: string;
  review_channel_id: string | null;
  review_message_id: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  decision_by: string | null;
  decision_reason: string | null;
  decided_at: string | null;
  withdrawn_at: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface ApplicationResponseRow {
  guild_id: string;
  application_id: string;
  response_id: string;
  field_id: string;
  field_label: string;
  field_type: string;
  response_text: string;
  sort_order: number;
  created_at: string;
}

interface ApplicationEventRow {
  guild_id: string;
  application_id: string;
  event_id: string;
  event_number: number;
  event_type: string;
  actor_id: string | null;
  details_json: string;
  created_at: string;
}

export interface ApplicationListFilter {
  formId?: string;
  applicantId?: string;
  states?: readonly ApplicationState[];
}

const MAX_FORMS = 25;
const MAX_FIELDS = 5;
const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;
const MAX_EVENTS_PER_APPLICATION = 100;

/** Tenant-bound form definitions and durable application workflow state. */
export class ApplicationRepository {
  public constructor(
    private readonly db: DatabaseConnection,
    public readonly guildId: string,
  ) {}

  public createForm(input: ApplicationFormInput): ApplicationForm {
    const normalized = normalizeFormInput(input);
    if (normalized.enabled) {
      throw new RangeError(
        "Create application forms disabled, add at least one field, then enable them",
      );
    }
    let result: ApplicationForm | null = null;
    const create = this.db.transaction(() => {
      if (this.countForms() >= MAX_FORMS) {
        throw new RangeError(
          `A guild can have at most ${MAX_FORMS} application forms`,
        );
      }
      const formId = normalizeOpaqueId(input.formId) ?? this.allocateFormId();
      const sortOrder =
        input.sortOrder === undefined
          ? this.nextFormSortOrder()
          : normalizeInteger(
              input.sortOrder,
              0,
              MAX_FORMS - 1,
              "Form sort order",
            );
      const now = utcNow();
      this.db
        .prepare(
          `INSERT INTO application_forms (
             guild_id, form_id, slug, display_name, description,
             reviewer_role_id, review_channel_id, enabled, sort_order,
             definition_version, bindings_verified_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        )
        .run(
          this.guildId,
          formId,
          normalized.slug,
          normalized.displayName,
          normalized.description,
          normalized.reviewerRoleId,
          normalized.reviewChannelId,
          normalized.enabled ? 1 : 0,
          sortOrder,
          normalized.bindingsVerifiedAt,
          now,
          now,
        );
      result = this.requireForm(formId);
    });
    create.immediate();
    return requireResult<ApplicationForm>(result, "Application form creation");
  }

  public updateForm(
    formId: string,
    input: ApplicationFormUpdate,
  ): ApplicationForm | null {
    const normalizedId = requireOpaqueId(formId, "Application form ID");
    let result: ApplicationForm | null | undefined;
    const update = this.db.transaction(() => {
      const current = this.getForm(normalizedId);
      if (!current) {
        result = null;
        return;
      }
      const merged = normalizeFormInput({
        slug: input.slug ?? current.slug,
        displayName: input.displayName ?? current.displayName,
        description: input.description ?? current.description,
        reviewerRoleId: input.reviewerRoleId ?? current.reviewerRoleId,
        reviewChannelId: input.reviewChannelId ?? current.reviewChannelId,
        enabled: input.enabled ?? current.enabled,
        sortOrder: input.sortOrder ?? current.sortOrder,
        bindingsVerifiedAt:
          input.bindingsVerifiedAt === undefined
            ? current.bindingsVerifiedAt
            : input.bindingsVerifiedAt,
      });
      if (merged.enabled) this.assertFormCanBeEnabled(normalizedId);
      const sortOrder = normalizeInteger(
        input.sortOrder ?? current.sortOrder,
        0,
        MAX_FORMS - 1,
        "Form sort order",
      );
      this.db
        .prepare(
          `UPDATE application_forms
           SET slug = ?, display_name = ?, description = ?, reviewer_role_id = ?,
               review_channel_id = ?, enabled = ?, sort_order = ?,
               bindings_verified_at = ?, definition_version = definition_version + 1,
               updated_at = ?
           WHERE guild_id = ? AND form_id = ?`,
        )
        .run(
          merged.slug,
          merged.displayName,
          merged.description,
          merged.reviewerRoleId,
          merged.reviewChannelId,
          merged.enabled ? 1 : 0,
          sortOrder,
          merged.bindingsVerifiedAt,
          utcNow(),
          this.guildId,
          normalizedId,
        );
      result = this.requireForm(normalizedId);
    });
    update.immediate();
    if (result === undefined)
      throw new Error("Application form update completed without a result");
    return result;
  }

  public setFormEnabled(
    formId: string,
    enabled: boolean,
  ): ApplicationForm | null {
    if (typeof enabled !== "boolean")
      throw new TypeError("Enabled must be a boolean");
    return this.updateForm(formId, { enabled });
  }

  public deleteForm(formId: string): ApplicationFormDeleteResult {
    const normalizedId = requireOpaqueId(formId, "Application form ID");
    let result: ApplicationFormDeleteResult | null = null;
    const remove = this.db.transaction(() => {
      const current = this.getForm(normalizedId);
      if (!current) {
        result = { status: "not-found", form: null };
        return;
      }
      const used = this.db
        .prepare(
          "SELECT 1 FROM applications WHERE guild_id = ? AND form_id = ? LIMIT 1",
        )
        .get(this.guildId, normalizedId);
      if (used) {
        result = { status: "in-use", form: current };
        return;
      }
      this.db
        .prepare(
          "DELETE FROM application_forms WHERE guild_id = ? AND form_id = ?",
        )
        .run(this.guildId, normalizedId);
      result = { status: "deleted", form: current };
    });
    remove.immediate();
    return requireResult<ApplicationFormDeleteResult>(
      result,
      "Application form deletion",
    );
  }

  public getForm(formId: string): ApplicationForm | null {
    const normalizedId = requireOpaqueId(formId, "Application form ID");
    const row = this.db
      .prepare(
        "SELECT * FROM application_forms WHERE guild_id = ? AND form_id = ?",
      )
      .get(this.guildId, normalizedId) as ApplicationFormRow | undefined;
    return row ? parseForm(row) : null;
  }

  public getFormBySlug(slug: string): ApplicationForm | null {
    const normalizedSlug = normalizeSlug(slug);
    const row = this.db
      .prepare(
        "SELECT * FROM application_forms WHERE guild_id = ? AND slug = ?",
      )
      .get(this.guildId, normalizedSlug) as ApplicationFormRow | undefined;
    return row ? parseForm(row) : null;
  }

  public listForms(
    options: { enabledOnly?: boolean; limit?: number; offset?: number } = {},
  ): ApplicationForm[] {
    const enabledOnly = options.enabledOnly ?? false;
    if (typeof enabledOnly !== "boolean")
      throw new TypeError("enabledOnly must be a boolean");
    const limit = normalizeListLimit(options.limit ?? MAX_FORMS);
    const offset = normalizeOffset(options.offset ?? 0);
    const rows = this.db
      .prepare(
        `SELECT * FROM application_forms
         WHERE guild_id = ?${enabledOnly ? " AND enabled = 1" : ""}
         ORDER BY sort_order, form_id LIMIT ? OFFSET ?`,
      )
      .all(this.guildId, limit, offset) as ApplicationFormRow[];
    return rows.map(parseForm);
  }

  public upsertFormField(
    formId: string,
    input: ApplicationFormFieldInput,
  ): ApplicationFormField {
    const normalizedFormId = requireOpaqueId(formId, "Application form ID");
    const normalized = normalizeFieldInput(input);
    let result: ApplicationFormField | null = null;
    const upsert = this.db.transaction(() => {
      const form = this.getForm(normalizedFormId);
      if (!form) throw new Error("Application form not found");
      const fieldId =
        normalizeOpaqueId(input.fieldId) ??
        this.allocateFieldId(normalizedFormId);
      const existing = this.getFormField(normalizedFormId, fieldId);
      if (!existing && this.countFields(normalizedFormId) >= MAX_FIELDS) {
        throw new RangeError(
          `An application form can have at most ${MAX_FIELDS} fields`,
        );
      }
      const sortOrder =
        input.sortOrder === undefined
          ? (existing?.sortOrder ?? this.nextFieldSortOrder(normalizedFormId))
          : normalizeInteger(
              input.sortOrder,
              0,
              MAX_FIELDS - 1,
              "Field sort order",
            );
      const now = utcNow();
      this.db
        .prepare(
          `INSERT INTO application_form_fields (
             guild_id, form_id, field_id, label, description, placeholder,
             field_type, required, min_length, max_length, sort_order,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(guild_id, form_id, field_id) DO UPDATE SET
             label = excluded.label, description = excluded.description,
             placeholder = excluded.placeholder, field_type = excluded.field_type,
             required = excluded.required, min_length = excluded.min_length,
             max_length = excluded.max_length, sort_order = excluded.sort_order,
             updated_at = excluded.updated_at`,
        )
        .run(
          this.guildId,
          normalizedFormId,
          fieldId,
          normalized.label,
          normalized.description,
          normalized.placeholder,
          normalized.fieldType,
          normalized.required ? 1 : 0,
          normalized.minLength,
          normalized.maxLength,
          sortOrder,
          now,
          now,
        );
      this.bumpDefinitionVersion(normalizedFormId);
      result = this.requireFormField(normalizedFormId, fieldId);
    });
    upsert.immediate();
    return requireResult<ApplicationFormField>(
      result,
      "Application field upsert",
    );
  }

  public removeFormField(formId: string, fieldId: string): boolean {
    const normalizedFormId = requireOpaqueId(formId, "Application form ID");
    const normalizedFieldId = requireOpaqueId(fieldId, "Application field ID");
    let removed = false;
    const remove = this.db.transaction(() => {
      const form = this.getForm(normalizedFormId);
      if (!form) return;
      if (form.enabled && this.countFields(normalizedFormId) <= 1) {
        throw new RangeError(
          "An enabled application form must retain at least one field",
        );
      }
      const result = this.db
        .prepare(
          "DELETE FROM application_form_fields WHERE guild_id = ? AND form_id = ? AND field_id = ?",
        )
        .run(this.guildId, normalizedFormId, normalizedFieldId);
      removed = result.changes > 0;
      if (removed) this.bumpDefinitionVersion(normalizedFormId);
    });
    remove.immediate();
    return removed;
  }

  public reorderFormFields(
    formId: string,
    fieldIds: readonly string[],
  ): ApplicationFormField[] {
    const normalizedFormId = requireOpaqueId(formId, "Application form ID");
    const normalizedIds = normalizeFieldOrder(fieldIds);
    let result: ApplicationFormField[] | null = null;
    const reorder = this.db.transaction(() => {
      const current = this.listFormFields(normalizedFormId);
      if (
        current.length !== normalizedIds.length ||
        current.some((field) => !normalizedIds.includes(field.fieldId))
      ) {
        throw new RangeError(
          "Field order must include every form field exactly once",
        );
      }
      const byId = new Map(current.map((field) => [field.fieldId, field]));
      this.db
        .prepare(
          "DELETE FROM application_form_fields WHERE guild_id = ? AND form_id = ?",
        )
        .run(this.guildId, normalizedFormId);
      const insert = this.db.prepare(
        `INSERT INTO application_form_fields (
           guild_id, form_id, field_id, label, description, placeholder,
           field_type, required, min_length, max_length, sort_order,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const now = utcNow();
      normalizedIds.forEach((fieldId, sortOrder) => {
        const field = byId.get(fieldId)!;
        insert.run(
          this.guildId,
          normalizedFormId,
          field.fieldId,
          field.label,
          field.description,
          field.placeholder,
          field.fieldType,
          field.required ? 1 : 0,
          field.minLength,
          field.maxLength,
          sortOrder,
          field.createdAt,
          now,
        );
      });
      this.bumpDefinitionVersion(normalizedFormId);
      result = this.listFormFields(normalizedFormId);
    });
    reorder.immediate();
    return requireResult<ApplicationFormField[]>(
      result,
      "Application field reorder",
    );
  }

  public getFormField(
    formId: string,
    fieldId: string,
  ): ApplicationFormField | null {
    const row = this.db
      .prepare(
        `SELECT * FROM application_form_fields
         WHERE guild_id = ? AND form_id = ? AND field_id = ?`,
      )
      .get(
        this.guildId,
        requireOpaqueId(formId, "Application form ID"),
        requireOpaqueId(fieldId, "Application field ID"),
      ) as ApplicationFormFieldRow | undefined;
    return row ? parseFormField(row) : null;
  }

  public listFormFields(formId: string): ApplicationFormField[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM application_form_fields
         WHERE guild_id = ? AND form_id = ?
         ORDER BY sort_order, field_id LIMIT ?`,
      )
      .all(
        this.guildId,
        requireOpaqueId(formId, "Application form ID"),
        MAX_FIELDS,
      ) as ApplicationFormFieldRow[];
    return rows.map(parseFormField);
  }

  public reserveApplication(
    input: ApplicationReservationInput,
  ): ApplicationReservationResult {
    const formId = requireOpaqueId(input.formId, "Application form ID");
    const applicantId = assertDiscordSnowflake(
      input.applicantId,
      "applicant ID",
    );
    let result: ApplicationReservationResult | null = null;
    const reserve = this.db.transaction(() => {
      const form = this.getForm(formId);
      if (!form?.enabled) {
        result = { status: "disabled", application: null };
        return;
      }
      const existing = this.getActiveApplication(formId, applicantId);
      if (existing) {
        result = { status: "existing", application: existing };
        return;
      }
      const fields = this.listFormFields(formId);
      if (fields.length < 1 || fields.length > MAX_FIELDS) {
        throw new RangeError(
          "Enabled application forms must have between 1 and 5 fields",
        );
      }
      const responses = normalizeResponses(input.responses, fields);
      const applicationId = this.allocateApplicationId();
      const applicationNumber = this.nextApplicationNumber();
      const now = utcNow();
      this.db
        .prepare(
          `INSERT INTO applications (
             guild_id, application_id, application_number, form_id, applicant_id,
             state, delivery_state, review_channel_id, review_message_id,
             claimed_by, claimed_at, decision_by, decision_reason, decided_at,
             withdrawn_at, failure_reason, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'submitted', 'reserved', NULL, NULL,
             NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          this.guildId,
          applicationId,
          applicationNumber,
          formId,
          applicantId,
          now,
          now,
        );
      const insertResponse = this.db.prepare(
        `INSERT INTO application_responses (
           guild_id, application_id, response_id, field_id, field_label,
           field_type, response_text, sort_order, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const response of responses) {
        insertResponse.run(
          this.guildId,
          applicationId,
          createOpaqueId(),
          response.fieldId,
          response.fieldLabel,
          response.fieldType,
          response.responseText,
          response.sortOrder,
          now,
        );
      }
      this.appendEventWithin(applicationId, {
        type: "submission_reserved",
        actorId: applicantId,
        details: {
          applicationNumber,
          formId,
          definitionVersion: form.definitionVersion,
        },
      });
      result = {
        status: "created",
        application: this.requireApplication(applicationId),
      };
    });
    reserve.immediate();
    return requireResult<ApplicationReservationResult>(
      result,
      "Application reservation",
    );
  }

  public bindDelivery(
    applicationId: string,
    input: ApplicationDeliveryInput,
  ): ApplicationDeliveryResult {
    const normalizedId = requireOpaqueId(applicationId, "Application ID");
    const channelId = assertDiscordSnowflake(
      input.reviewChannelId,
      "review channel ID",
    );
    const messageId = assertDiscordSnowflake(
      input.reviewMessageId,
      "review message ID",
    );
    const expected = normalizeOptionalTimestamp(
      input.expectedUpdatedAt,
      "Expected update timestamp",
    );
    let result: ApplicationDeliveryResult | null = null;
    const bind = this.db.transaction(() => {
      const current = this.getApplicationById(normalizedId);
      if (!current) {
        result = { status: "not-found", application: null };
        return;
      }
      if (expected && current.updatedAt !== expected) {
        result = { status: "conflict", application: current };
        return;
      }
      if (
        current.deliveryState === "posted" &&
        current.reviewChannelId === channelId &&
        current.reviewMessageId === messageId
      ) {
        result = { status: "already-posted", application: current };
        return;
      }
      if (!["reserved", "failed", "missing"].includes(current.deliveryState)) {
        result = { status: "unavailable", application: current };
        return;
      }
      const rebound = current.deliveryState !== "reserved";
      this.db
        .prepare(
          `UPDATE applications
           SET delivery_state = 'posted', review_channel_id = ?, review_message_id = ?,
               failure_reason = NULL, updated_at = ?
           WHERE guild_id = ? AND application_id = ?`,
        )
        .run(channelId, messageId, utcNow(), this.guildId, normalizedId);
      this.appendEventWithin(normalizedId, {
        type: rebound ? "rebound" : "submission_posted",
        details: { reviewChannelId: channelId, reviewMessageId: messageId },
      });
      result = {
        status: "posted",
        application: this.requireApplication(normalizedId),
      };
    });
    bind.immediate();
    return requireResult<ApplicationDeliveryResult>(
      result,
      "Application delivery bind",
    );
  }

  public failDelivery(
    applicationId: string,
    reason: string,
  ): ApplicationDeliveryResult {
    const normalizedId = requireOpaqueId(applicationId, "Application ID");
    const normalizedReason = normalizeText(reason, 1, 1_000, "Failure reason");
    let result: ApplicationDeliveryResult | null = null;
    const fail = this.db.transaction(() => {
      const current = this.getApplicationById(normalizedId);
      if (!current) {
        result = { status: "not-found", application: null };
        return;
      }
      if (current.deliveryState === "failed") {
        result = { status: "already-failed", application: current };
        return;
      }
      if (current.deliveryState !== "reserved") {
        result = { status: "unavailable", application: current };
        return;
      }
      this.db
        .prepare(
          `UPDATE applications
           SET delivery_state = 'failed', failure_reason = ?, updated_at = ?
           WHERE guild_id = ? AND application_id = ?`,
        )
        .run(normalizedReason, utcNow(), this.guildId, normalizedId);
      this.appendEventWithin(normalizedId, {
        type: "submission_failed",
        details: { reason: normalizedReason },
      });
      result = {
        status: "failed",
        application: this.requireApplication(normalizedId),
      };
    });
    fail.immediate();
    return requireResult<ApplicationDeliveryResult>(
      result,
      "Application delivery failure",
    );
  }

  public markDeliveryMissing(
    applicationId: string,
    expectedUpdatedAt?: string,
  ): ApplicationDeliveryResult {
    const normalizedId = requireOpaqueId(applicationId, "Application ID");
    const expected = normalizeOptionalTimestamp(
      expectedUpdatedAt,
      "Expected update timestamp",
    );
    let result: ApplicationDeliveryResult | null = null;
    const mark = this.db.transaction(() => {
      const current = this.getApplicationById(normalizedId);
      if (!current) {
        result = { status: "not-found", application: null };
        return;
      }
      if (expected && current.updatedAt !== expected) {
        result = { status: "conflict", application: current };
        return;
      }
      if (current.deliveryState === "missing") {
        result = { status: "already-missing", application: current };
        return;
      }
      if (current.deliveryState !== "posted") {
        result = { status: "unavailable", application: current };
        return;
      }
      this.db
        .prepare(
          `UPDATE applications SET delivery_state = 'missing', updated_at = ?
           WHERE guild_id = ? AND application_id = ?`,
        )
        .run(utcNow(), this.guildId, normalizedId);
      this.appendEventWithin(normalizedId, {
        type: "recovery_noted",
        details: { issue: "review-message-missing" },
      });
      result = {
        status: "missing",
        application: this.requireApplication(normalizedId),
      };
    });
    mark.immediate();
    return requireResult<ApplicationDeliveryResult>(
      result,
      "Missing application delivery",
    );
  }

  public claimApplication(
    applicationId: string,
    reviewerId: string,
    expectedUpdatedAt?: string,
  ): ApplicationTransitionResult {
    const normalizedId = requireOpaqueId(applicationId, "Application ID");
    const actorId = assertDiscordSnowflake(reviewerId, "reviewer ID");
    const expected = normalizeOptionalTimestamp(
      expectedUpdatedAt,
      "Expected update timestamp",
    );
    let result: ApplicationTransitionResult | null = null;
    const claim = this.db.transaction(() => {
      const current = this.getApplicationById(normalizedId);
      if (!current) {
        result = { status: "not-found", application: null };
        return;
      }
      if (expected && current.updatedAt !== expected) {
        result = { status: "conflict", application: current };
        return;
      }
      if (current.state === "under-review") {
        result = {
          status: current.claimedBy === actorId ? "unchanged" : "conflict",
          application: current,
        };
        return;
      }
      if (current.state !== "submitted" || current.deliveryState !== "posted") {
        result = { status: "unavailable", application: current };
        return;
      }
      const now = utcNow();
      this.db
        .prepare(
          `UPDATE applications
           SET state = 'under-review', claimed_by = ?, claimed_at = ?, updated_at = ?
           WHERE guild_id = ? AND application_id = ?`,
        )
        .run(actorId, now, now, this.guildId, normalizedId);
      this.appendEventWithin(normalizedId, { type: "claimed", actorId });
      result = {
        status: "changed",
        application: this.requireApplication(normalizedId),
      };
    });
    claim.immediate();
    return requireResult<ApplicationTransitionResult>(
      result,
      "Application claim",
    );
  }

  public decideApplication(
    applicationId: string,
    input: ApplicationDecisionInput,
  ): ApplicationTransitionResult {
    const normalizedId = requireOpaqueId(applicationId, "Application ID");
    const state = normalizeDecisionState(input.state);
    const actorId = assertDiscordSnowflake(input.reviewerId, "reviewer ID");
    const reason = normalizeText(input.reason, 1, 1_000, "Decision reason");
    const expected = normalizeOptionalTimestamp(
      input.expectedUpdatedAt,
      "Expected update timestamp",
    );
    let result: ApplicationTransitionResult | null = null;
    const decide = this.db.transaction(() => {
      const current = this.getApplicationById(normalizedId);
      if (!current) {
        result = { status: "not-found", application: null };
        return;
      }
      if (expected && current.updatedAt !== expected) {
        result = { status: "conflict", application: current };
        return;
      }
      if (current.state === state) {
        result = { status: "unchanged", application: current };
        return;
      }
      if (
        current.state !== "under-review" ||
        current.claimedBy !== actorId ||
        current.deliveryState !== "posted"
      ) {
        result = {
          status:
            current.state === "under-review" && current.claimedBy !== actorId
              ? "conflict"
              : "unavailable",
          application: current,
        };
        return;
      }
      const now = utcNow();
      this.db
        .prepare(
          `UPDATE applications
           SET state = ?, decision_by = ?, decision_reason = ?, decided_at = ?,
               updated_at = ?
           WHERE guild_id = ? AND application_id = ?`,
        )
        .run(state, actorId, reason, now, now, this.guildId, normalizedId);
      this.appendEventWithin(normalizedId, {
        type: "decision_recorded",
        actorId,
        details: { state, reason },
      });
      result = {
        status: "changed",
        application: this.requireApplication(normalizedId),
      };
    });
    decide.immediate();
    return requireResult<ApplicationTransitionResult>(
      result,
      "Application decision",
    );
  }

  public withdrawApplication(
    applicationId: string,
    applicantId: string,
    expectedUpdatedAt?: string,
  ): ApplicationTransitionResult {
    const normalizedId = requireOpaqueId(applicationId, "Application ID");
    const actorId = assertDiscordSnowflake(applicantId, "applicant ID");
    const expected = normalizeOptionalTimestamp(
      expectedUpdatedAt,
      "Expected update timestamp",
    );
    let result: ApplicationTransitionResult | null = null;
    const withdraw = this.db.transaction(() => {
      const current = this.getApplicationById(normalizedId);
      if (!current) {
        result = { status: "not-found", application: null };
        return;
      }
      if (expected && current.updatedAt !== expected) {
        result = { status: "conflict", application: current };
        return;
      }
      if (current.applicantId !== actorId) {
        result = { status: "conflict", application: current };
        return;
      }
      if (current.state === "withdrawn") {
        result = { status: "unchanged", application: current };
        return;
      }
      if (!["submitted", "under-review"].includes(current.state)) {
        result = { status: "unavailable", application: current };
        return;
      }
      const now = utcNow();
      this.db
        .prepare(
          `UPDATE applications SET state = 'withdrawn', withdrawn_at = ?, updated_at = ?
           WHERE guild_id = ? AND application_id = ?`,
        )
        .run(now, now, this.guildId, normalizedId);
      this.appendEventWithin(normalizedId, { type: "withdrawn", actorId });
      result = {
        status: "changed",
        application: this.requireApplication(normalizedId),
      };
    });
    withdraw.immediate();
    return requireResult<ApplicationTransitionResult>(
      result,
      "Application withdrawal",
    );
  }

  public getApplicationById(applicationId: string): ApplicationRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM applications WHERE guild_id = ? AND application_id = ?",
      )
      .get(this.guildId, requireOpaqueId(applicationId, "Application ID")) as
      ApplicationRow | undefined;
    return row ? parseApplication(row) : null;
  }

  public hasApplicationsForForm(formId: string): boolean {
    const normalizedFormId = requireOpaqueId(formId, "Application form ID");
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM applications
           WHERE guild_id = ? AND form_id = ? LIMIT 1`,
        )
        .get(this.guildId, normalizedFormId),
    );
  }

  public getApplicationByNumber(
    applicationNumber: number,
  ): ApplicationRecord | null {
    const number = normalizeInteger(
      applicationNumber,
      1,
      2_147_483_647,
      "Application number",
    );
    const row = this.db
      .prepare(
        "SELECT * FROM applications WHERE guild_id = ? AND application_number = ?",
      )
      .get(this.guildId, number) as ApplicationRow | undefined;
    return row ? parseApplication(row) : null;
  }

  public getApplicationByReviewMessage(
    reviewChannelId: string,
    reviewMessageId: string,
  ): ApplicationRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM applications
         WHERE guild_id = ? AND review_channel_id = ? AND review_message_id = ?`,
      )
      .get(
        this.guildId,
        assertDiscordSnowflake(reviewChannelId, "review channel ID"),
        assertDiscordSnowflake(reviewMessageId, "review message ID"),
      ) as ApplicationRow | undefined;
    return row ? parseApplication(row) : null;
  }

  public listApplications(
    filter: ApplicationListFilter = {},
    limit = DEFAULT_LIST_LIMIT,
    offset = 0,
  ): ApplicationRecord[] {
    const clauses = ["guild_id = ?"];
    const parameters: Array<string | number> = [this.guildId];
    if (filter.formId !== undefined) {
      clauses.push("form_id = ?");
      parameters.push(requireOpaqueId(filter.formId, "Application form ID"));
    }
    if (filter.applicantId !== undefined) {
      clauses.push("applicant_id = ?");
      parameters.push(
        assertDiscordSnowflake(filter.applicantId, "applicant ID"),
      );
    }
    if (filter.states !== undefined) {
      if (!Array.isArray(filter.states) || filter.states.length === 0)
        return [];
      const states = [...new Set(filter.states.map(normalizeApplicationState))];
      clauses.push(`state IN (${states.map(() => "?").join(", ")})`);
      parameters.push(...states);
    }
    parameters.push(normalizeListLimit(limit), normalizeOffset(offset));
    const rows = this.db
      .prepare(
        `SELECT * FROM applications WHERE ${clauses.join(" AND ")}
         ORDER BY application_number DESC LIMIT ? OFFSET ?`,
      )
      .all(...parameters) as ApplicationRow[];
    return rows.map(parseApplication);
  }

  public listResponses(applicationId: string): ApplicationResponse[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM application_responses
         WHERE guild_id = ? AND application_id = ?
         ORDER BY sort_order, response_id LIMIT ?`,
      )
      .all(
        this.guildId,
        requireOpaqueId(applicationId, "Application ID"),
        MAX_FIELDS,
      ) as ApplicationResponseRow[];
    return rows.map(parseResponse);
  }

  public appendEvent(
    applicationId: string,
    input: ApplicationEventInput,
  ): ApplicationEvent | null {
    const normalizedId = requireOpaqueId(applicationId, "Application ID");
    let result: ApplicationEvent | null = null;
    const append = this.db.transaction(() => {
      if (!this.getApplicationById(normalizedId)) return;
      result = this.appendEventWithin(normalizedId, input);
    });
    append.immediate();
    return result;
  }

  public listEvents(
    applicationId: string,
    limit = MAX_EVENTS_PER_APPLICATION,
    offset = 0,
  ): ApplicationEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM application_events
         WHERE guild_id = ? AND application_id = ?
         ORDER BY event_number LIMIT ? OFFSET ?`,
      )
      .all(
        this.guildId,
        requireOpaqueId(applicationId, "Application ID"),
        normalizeListLimit(limit),
        normalizeOffset(offset),
      ) as ApplicationEventRow[];
    return rows.map(parseEvent);
  }

  public listAllEvents(
    limit = DEFAULT_LIST_LIMIT,
    offset = 0,
  ): ApplicationEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM application_events
         WHERE guild_id = ? ORDER BY application_id, event_number
         LIMIT ? OFFSET ?`,
      )
      .all(
        this.guildId,
        normalizeListLimit(limit),
        normalizeOffset(offset),
      ) as ApplicationEventRow[];
    return rows.map(parseEvent);
  }

  private getActiveApplication(
    formId: string,
    applicantId: string,
  ): ApplicationRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM applications
         WHERE guild_id = ? AND form_id = ? AND applicant_id = ?
           AND state IN ('submitted', 'under-review')
         ORDER BY application_number DESC LIMIT 1`,
      )
      .get(this.guildId, formId, applicantId) as ApplicationRow | undefined;
    return row ? parseApplication(row) : null;
  }

  private appendEventWithin(
    applicationId: string,
    input: ApplicationEventInput,
  ): ApplicationEvent {
    const type = normalizeEventType(input.type);
    const actorId =
      input.actorId === undefined || input.actorId === null
        ? null
        : assertDiscordSnowflake(input.actorId, "event actor ID");
    const detailsJson = serializeBoundedJson(input.details ?? {});
    const next = this.db
      .prepare(
        `SELECT COALESCE(MAX(event_number), 0) + 1 AS next
         FROM application_events WHERE guild_id = ? AND application_id = ?`,
      )
      .get(this.guildId, applicationId) as { next: number };
    const eventId = createOpaqueId();
    const now = utcNow();
    this.db
      .prepare(
        `INSERT INTO application_events (
           guild_id, application_id, event_id, event_number, event_type,
           actor_id, details_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.guildId,
        applicationId,
        eventId,
        Number(next.next),
        type,
        actorId,
        detailsJson,
        now,
      );
    this.trimEvents(applicationId);
    return parseEvent(
      this.db
        .prepare(
          `SELECT * FROM application_events
           WHERE guild_id = ? AND application_id = ? AND event_id = ?`,
        )
        .get(this.guildId, applicationId, eventId) as ApplicationEventRow,
    );
  }

  private trimEvents(applicationId: string): void {
    this.db
      .prepare(
        `DELETE FROM application_events
         WHERE guild_id = ? AND application_id = ? AND event_id IN (
           SELECT event_id FROM application_events
           WHERE guild_id = ? AND application_id = ?
           ORDER BY event_number DESC LIMIT -1 OFFSET ?
         )`,
      )
      .run(
        this.guildId,
        applicationId,
        this.guildId,
        applicationId,
        MAX_EVENTS_PER_APPLICATION,
      );
  }

  private assertFormCanBeEnabled(formId: string): void {
    const count = this.countFields(formId);
    if (count < 1 || count > MAX_FIELDS) {
      throw new RangeError(
        "Enabled application forms must have between 1 and 5 fields",
      );
    }
  }

  private countForms(): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM application_forms WHERE guild_id = ?",
      )
      .get(this.guildId) as { count: number };
    return Number(row.count);
  }

  private countFields(formId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM application_form_fields WHERE guild_id = ? AND form_id = ?",
      )
      .get(this.guildId, formId) as { count: number };
    return Number(row.count);
  }

  private nextFormSortOrder(): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM application_forms WHERE guild_id = ?",
      )
      .get(this.guildId) as { next: number };
    return Math.min(Number(row.next), MAX_FORMS - 1);
  }

  private nextFieldSortOrder(formId: string): number {
    const used = new Set(
      this.listFormFields(formId).map((field) => field.sortOrder),
    );
    for (let index = 0; index < MAX_FIELDS; index += 1) {
      if (!used.has(index)) return index;
    }
    throw new RangeError(
      `An application form can have at most ${MAX_FIELDS} fields`,
    );
  }

  private nextApplicationNumber(): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(application_number), 0) + 1 AS next
         FROM applications WHERE guild_id = ?`,
      )
      .get(this.guildId) as { next: number };
    return normalizeInteger(
      Number(row.next),
      1,
      2_147_483_647,
      "Application number",
    );
  }

  private allocateFormId(): string {
    return allocateUniqueId((id) => Boolean(this.getFormUnchecked(id)));
  }

  private allocateFieldId(formId: string): string {
    return allocateUniqueId((id) =>
      Boolean(this.getFormFieldUnchecked(formId, id)),
    );
  }

  private allocateApplicationId(): string {
    return allocateUniqueId((id) => Boolean(this.getApplicationUnchecked(id)));
  }

  private getFormUnchecked(formId: string): ApplicationFormRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM application_forms WHERE guild_id = ? AND form_id = ?",
      )
      .get(this.guildId, formId) as ApplicationFormRow | undefined;
  }

  private getFormFieldUnchecked(
    formId: string,
    fieldId: string,
  ): ApplicationFormFieldRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM application_form_fields
         WHERE guild_id = ? AND form_id = ? AND field_id = ?`,
      )
      .get(this.guildId, formId, fieldId) as
      ApplicationFormFieldRow | undefined;
  }

  private getApplicationUnchecked(
    applicationId: string,
  ): ApplicationRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM applications WHERE guild_id = ? AND application_id = ?",
      )
      .get(this.guildId, applicationId) as ApplicationRow | undefined;
  }

  private requireForm(formId: string): ApplicationForm {
    const row = this.getFormUnchecked(formId);
    if (!row) throw new Error("Application form was not persisted");
    return parseForm(row);
  }

  private requireFormField(
    formId: string,
    fieldId: string,
  ): ApplicationFormField {
    const row = this.getFormFieldUnchecked(formId, fieldId);
    if (!row) throw new Error("Application field was not persisted");
    return parseFormField(row);
  }

  private requireApplication(applicationId: string): ApplicationRecord {
    const row = this.getApplicationUnchecked(applicationId);
    if (!row) throw new Error("Application was not persisted");
    return parseApplication(row);
  }

  private bumpDefinitionVersion(formId: string): void {
    const result = this.db
      .prepare(
        `UPDATE application_forms
         SET definition_version = definition_version + 1, updated_at = ?
         WHERE guild_id = ? AND form_id = ?`,
      )
      .run(utcNow(), this.guildId, formId);
    if (result.changes !== 1) throw new Error("Application form not found");
  }
}

function normalizeFormInput(input: ApplicationFormInput): {
  slug: string;
  displayName: string;
  description: string;
  reviewerRoleId: string;
  reviewChannelId: string;
  enabled: boolean;
  bindingsVerifiedAt: string | null;
} {
  if (!input || typeof input !== "object")
    throw new TypeError("Application form input is required");
  return {
    slug: normalizeSlug(input.slug),
    displayName: normalizeText(input.displayName, 1, 100, "Form display name"),
    description: normalizeText(input.description, 1, 1_000, "Form description"),
    reviewerRoleId: assertDiscordSnowflake(
      input.reviewerRoleId,
      "reviewer role ID",
    ),
    reviewChannelId: assertDiscordSnowflake(
      input.reviewChannelId,
      "review channel ID",
    ),
    enabled: normalizeBoolean(input.enabled ?? false, "Enabled"),
    bindingsVerifiedAt: normalizeOptionalTimestamp(
      input.bindingsVerifiedAt,
      "Bindings verification timestamp",
    ),
  };
}

function normalizeFieldInput(input: ApplicationFormFieldInput): {
  label: string;
  description: string | null;
  placeholder: string | null;
  fieldType: FormFieldType;
  required: boolean;
  minLength: number;
  maxLength: number;
} {
  if (!input || typeof input !== "object")
    throw new TypeError("Application field input is required");
  const fieldType = normalizeFieldType(input.fieldType);
  const maxDefault = fieldType === "short" ? 400 : 4_000;
  const minLength = normalizeInteger(
    input.minLength ?? 0,
    0,
    4_000,
    "Field minimum length",
  );
  const maxLength = normalizeInteger(
    input.maxLength ?? maxDefault,
    1,
    4_000,
    "Field maximum length",
  );
  if (minLength > maxLength)
    throw new RangeError("Field minimum length cannot exceed maximum length");
  return {
    label: normalizeText(input.label, 1, 45, "Field label"),
    description: normalizeOptionalText(
      input.description,
      100,
      "Field description",
    ),
    placeholder: normalizeOptionalText(
      input.placeholder,
      100,
      "Field placeholder",
    ),
    fieldType,
    required: normalizeBoolean(input.required ?? true, "Field required"),
    minLength,
    maxLength,
  };
}

function normalizeResponses(
  inputs: readonly ApplicationReservationInput["responses"][number][],
  fields: readonly ApplicationFormField[],
): ApplicationReservationInput["responses"] {
  if (!Array.isArray(inputs) || inputs.length !== fields.length) {
    throw new RangeError(
      "Application responses must include every form field exactly once",
    );
  }
  const supplied = new Map<string, string>();
  for (const input of inputs) {
    const fieldId = requireOpaqueId(input.fieldId, "Response field ID");
    if (supplied.has(fieldId))
      throw new RangeError("Application responses contain a duplicate field");
    if (typeof input.responseText !== "string")
      throw new TypeError("Application response text must be a string");
    supplied.set(fieldId, input.responseText.trim());
  }
  return fields.map((field) => {
    const responseText = supplied.get(field.fieldId);
    if (responseText === undefined)
      throw new RangeError(
        "Application responses do not match the form fields",
      );
    if (
      responseText.length < field.minLength ||
      responseText.length > field.maxLength
    ) {
      throw new RangeError(
        `Response for ${field.label} must be between ${field.minLength} and ${field.maxLength} characters`,
      );
    }
    if (field.required && responseText.length === 0) {
      throw new RangeError(`Response for ${field.label} is required`);
    }
    return {
      fieldId: field.fieldId,
      fieldLabel: field.label,
      fieldType: field.fieldType,
      responseText,
      sortOrder: field.sortOrder,
    };
  });
}

function parseForm(row: ApplicationFormRow): ApplicationForm {
  return {
    guildId: row.guild_id,
    formId: row.form_id,
    slug: row.slug,
    displayName: row.display_name,
    description: row.description,
    reviewerRoleId: row.reviewer_role_id,
    reviewChannelId: row.review_channel_id,
    enabled: Boolean(row.enabled),
    sortOrder: Number(row.sort_order),
    definitionVersion: Number(row.definition_version),
    bindingsVerifiedAt: row.bindings_verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseFormField(row: ApplicationFormFieldRow): ApplicationFormField {
  return {
    guildId: row.guild_id,
    formId: row.form_id,
    fieldId: row.field_id,
    label: row.label,
    description: row.description,
    placeholder: row.placeholder,
    fieldType: normalizeFieldType(row.field_type),
    required: Boolean(row.required),
    minLength: Number(row.min_length),
    maxLength: Number(row.max_length),
    sortOrder: Number(row.sort_order),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseApplication(row: ApplicationRow): ApplicationRecord {
  return {
    guildId: row.guild_id,
    applicationId: row.application_id,
    applicationNumber: Number(row.application_number),
    formId: row.form_id,
    applicantId: row.applicant_id,
    state: normalizeApplicationState(row.state),
    deliveryState: normalizeDeliveryState(row.delivery_state),
    reviewChannelId: row.review_channel_id,
    reviewMessageId: row.review_message_id,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    decisionBy: row.decision_by,
    decisionReason: row.decision_reason,
    decidedAt: row.decided_at,
    withdrawnAt: row.withdrawn_at,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseResponse(row: ApplicationResponseRow): ApplicationResponse {
  return {
    guildId: row.guild_id,
    applicationId: row.application_id,
    responseId: row.response_id,
    fieldId: row.field_id,
    fieldLabel: row.field_label,
    fieldType: normalizeFieldType(row.field_type),
    responseText: row.response_text,
    sortOrder: Number(row.sort_order),
    createdAt: row.created_at,
  };
}

function parseEvent(row: ApplicationEventRow): ApplicationEvent {
  return {
    guildId: row.guild_id,
    applicationId: row.application_id,
    eventId: row.event_id,
    eventNumber: Number(row.event_number),
    type: normalizeEventType(row.event_type),
    actorId: row.actor_id,
    details: parseJson(row.details_json, "application event details"),
    createdAt: row.created_at,
  };
}

function normalizeApplicationState(value: unknown): ApplicationState {
  if (!(APPLICATION_STATES as readonly unknown[]).includes(value)) {
    throw new TypeError("Unsupported application state");
  }
  return value as ApplicationState;
}

function normalizeDecisionState(
  value: unknown,
): ApplicationDecisionInput["state"] {
  if (value !== "accepted" && value !== "rejected") {
    throw new TypeError("Application decision must be accepted or rejected");
  }
  return value;
}

function normalizeDeliveryState(value: unknown): DeliveryState {
  if (!["reserved", "posted", "failed", "missing"].includes(String(value))) {
    throw new TypeError("Unsupported application delivery state");
  }
  return value as DeliveryState;
}

function normalizeEventType(value: unknown): ApplicationEventType {
  if (!(APPLICATION_EVENT_TYPES as readonly unknown[]).includes(value)) {
    throw new TypeError("Unsupported application event type");
  }
  return value as ApplicationEventType;
}

function normalizeFieldType(value: unknown): FormFieldType {
  if (!(FORM_FIELD_TYPES as readonly unknown[]).includes(value)) {
    throw new TypeError("Unsupported form field type");
  }
  return value as FormFieldType;
}

function normalizeSlug(value: unknown): string {
  const slug = normalizeText(value, 1, 32, "Form slug").toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new TypeError(
      "Form slug may contain lowercase letters, numbers, and single hyphens",
    );
  }
  return slug;
}

function normalizeText(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): string {
  if (typeof value !== "string")
    throw new TypeError(`${label} must be a string`);
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new RangeError(
      `${label} must be between ${minimum} and ${maximum} characters`,
    );
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError(`${label} contains unsupported control characters`);
  }
  return normalized;
}

function normalizeOptionalText(
  value: unknown,
  maximum: number,
  label: string,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  return normalizeText(value, 1, maximum, label);
}

function normalizeBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean")
    throw new TypeError(`${label} must be a boolean`);
  return value;
}

function normalizeInteger(
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
      `${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return Number(value);
}

function normalizeOptionalTimestamp(
  value: unknown,
  label: string,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO timestamp`);
  }
  return new Date(value).toISOString();
}

function normalizeListLimit(value: number): number {
  return normalizeInteger(value, 1, MAX_LIST_LIMIT, "List limit");
}

function normalizeOffset(value: number): number {
  return normalizeInteger(value, 0, 2_147_483_647, "List offset");
}

function normalizeFieldOrder(fieldIds: readonly string[]): string[] {
  if (!Array.isArray(fieldIds) || fieldIds.length > MAX_FIELDS) {
    throw new RangeError(`Field order supports at most ${MAX_FIELDS} fields`);
  }
  const normalized = fieldIds.map((fieldId) =>
    requireOpaqueId(fieldId, "Application field ID"),
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new RangeError("Field order contains a duplicate field ID");
  }
  return normalized;
}

function requireOpaqueId(value: unknown, label: string): string {
  const normalized = normalizeOpaqueId(value);
  if (!normalized)
    throw new TypeError(
      `${label} must be an opaque ID between 8 and 24 characters`,
    );
  return normalized;
}

function normalizeOpaqueId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,24}$/.test(value)) {
    throw new TypeError("Invalid opaque storage ID");
  }
  return value;
}

function allocateUniqueId(exists: (id: string) => boolean): string {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const id = createOpaqueId();
    if (!exists(id)) return id;
  }
  throw new Error("Could not allocate a unique storage ID");
}

function createOpaqueId(): string {
  return randomBytes(12).toString("hex");
}

function serializeBoundedJson(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "{}";
  } catch (error) {
    throw new TypeError("Application event details must be JSON serializable", {
      cause: error,
    });
  }
  if (
    Buffer.byteLength(serialized, "utf8") < 2 ||
    Buffer.byteLength(serialized, "utf8") > 4_000
  ) {
    throw new RangeError(
      "Application event details must be at most 4000 bytes",
    );
  }
  return serialized;
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`Stored ${label} is invalid JSON`, { cause: error });
  }
}

function utcNow(): string {
  return new Date().toISOString();
}

function requireResult<T>(result: T | null, label: string): T {
  if (result === null) throw new Error(`${label} completed without a result`);
  return result;
}
