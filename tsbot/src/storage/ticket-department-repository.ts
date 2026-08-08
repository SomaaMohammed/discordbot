import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { assertDiscordSnowflake } from "../guild-settings.js";
import {
  FORM_FIELD_TYPES,
  type FormFieldType,
  type TicketDepartment,
  type TicketDepartmentDeleteResult,
  type TicketDepartmentField,
  type TicketDepartmentFieldInput,
  type TicketDepartmentInput,
  type TicketDepartmentUpdate,
} from "../types.js";
import { normalizeOptionalUnicodeEmoji } from "../unicode-emoji.js";

interface DepartmentRow {
  guild_id: string;
  department_id: string;
  slug: string;
  display_name: string;
  description: string;
  emoji: string | null;
  category_id: string | null;
  log_channel_id: string | null;
  support_role_id: string | null;
  enabled: number;
  sort_order: number;
  definition_version: number;
  bindings_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DepartmentFieldRow {
  guild_id: string;
  department_id: string;
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

export const GENERAL_SUPPORT_DEPARTMENT_SLUG = "general-support";
export const MAX_TICKET_DEPARTMENTS = 10;
export const MAX_TICKET_DEPARTMENT_FIELDS = 5;

/** Tenant-bound configuration for ticket departments and modal fields. */
export class TicketDepartmentRepository {
  public constructor(
    private readonly db: Database.Database,
    public readonly guildId: string,
  ) {}

  public createDepartment(input: TicketDepartmentInput): TicketDepartment {
    const normalized = normalizeDepartmentInput(input);
    let created: TicketDepartment | null = null;
    const create = this.db.transaction(() => {
      const count = this.countDepartments();
      if (count >= MAX_TICKET_DEPARTMENTS) {
        throw new RangeError(
          `A guild supports at most ${MAX_TICKET_DEPARTMENTS} ticket departments`,
        );
      }
      const departmentId =
        normalized.departmentId ?? this.allocateDepartmentId();
      const now = utcNow();
      this.db
        .prepare(
          `INSERT INTO ticket_departments (
             guild_id, department_id, slug, display_name, description, emoji,
             category_id, log_channel_id, support_role_id, enabled, sort_order,
             definition_version, bindings_verified_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        )
        .run(
          this.guildId,
          departmentId,
          normalized.slug,
          normalized.displayName,
          normalized.description,
          normalized.emoji,
          normalized.categoryId,
          normalized.logChannelId,
          normalized.supportRoleId,
          normalized.enabled ? 1 : 0,
          normalized.sortOrder,
          normalized.bindingsVerifiedAt,
          now,
          now,
        );
      created = this.requireDepartment(departmentId);
    });
    create.immediate();
    return requireResult<TicketDepartment>(
      created,
      "Ticket department creation",
    );
  }

  public updateDepartment(
    departmentId: string,
    update: TicketDepartmentUpdate,
  ): TicketDepartment | null {
    const normalizedId = requireOpaqueId(departmentId, "department ID");
    const current = this.getDepartment(normalizedId);
    if (!current) return null;
    const merged = normalizeDepartmentInput({
      departmentId: normalizedId,
      slug: update.slug ?? current.slug,
      displayName: update.displayName ?? current.displayName,
      description: update.description ?? current.description,
      emoji: update.emoji === undefined ? current.emoji : update.emoji,
      categoryId:
        update.categoryId === undefined
          ? current.categoryId
          : update.categoryId,
      logChannelId:
        update.logChannelId === undefined
          ? current.logChannelId
          : update.logChannelId,
      supportRoleId:
        update.supportRoleId === undefined
          ? current.supportRoleId
          : update.supportRoleId,
      enabled: update.enabled ?? current.enabled,
      sortOrder: update.sortOrder ?? current.sortOrder,
      bindingsVerifiedAt:
        update.bindingsVerifiedAt === undefined
          ? current.bindingsVerifiedAt
          : update.bindingsVerifiedAt,
    });
    if (sameDepartmentConfiguration(current, merged)) return current;
    this.db
      .prepare(
        `UPDATE ticket_departments
         SET slug = ?, display_name = ?, description = ?, emoji = ?,
             category_id = ?, log_channel_id = ?, support_role_id = ?,
             enabled = ?, sort_order = ?,
             definition_version = definition_version + 1,
             bindings_verified_at = ?, updated_at = ?
         WHERE guild_id = ? AND department_id = ?`,
      )
      .run(
        merged.slug,
        merged.displayName,
        merged.description,
        merged.emoji,
        merged.categoryId,
        merged.logChannelId,
        merged.supportRoleId,
        merged.enabled ? 1 : 0,
        merged.sortOrder,
        merged.bindingsVerifiedAt,
        utcNow(),
        this.guildId,
        normalizedId,
      );
    return this.requireDepartment(normalizedId);
  }

  public setDepartmentEnabled(
    departmentId: string,
    enabled: boolean,
  ): TicketDepartment | null {
    if (typeof enabled !== "boolean") {
      throw new TypeError("Ticket department enabled must be a boolean");
    }
    return this.updateDepartment(departmentId, { enabled });
  }

  public disableAllDepartments(): number {
    const result = this.db
      .prepare(
        `UPDATE ticket_departments
         SET enabled = 0,
             definition_version = definition_version + 1,
             updated_at = ?
         WHERE guild_id = ? AND enabled = 1`,
      )
      .run(utcNow(), this.guildId);
    return result.changes;
  }

  public deleteDepartment(departmentId: string): TicketDepartmentDeleteResult {
    const normalizedId = requireOpaqueId(departmentId, "department ID");
    let result: TicketDepartmentDeleteResult | null = null;
    const remove = this.db.transaction(() => {
      const department = this.getDepartment(normalizedId);
      if (!department) {
        result = { status: "not-found", department: null };
        return;
      }
      const use = this.db
        .prepare(
          `SELECT 1 FROM tickets
           WHERE guild_id = ? AND department_id = ? LIMIT 1`,
        )
        .get(this.guildId, normalizedId);
      if (use) {
        result = { status: "in-use", department };
        return;
      }
      this.db
        .prepare(
          `DELETE FROM ticket_departments
           WHERE guild_id = ? AND department_id = ?`,
        )
        .run(this.guildId, normalizedId);
      result = { status: "deleted", department };
    });
    remove.immediate();
    return requireResult<TicketDepartmentDeleteResult>(
      result,
      "Ticket department deletion",
    );
  }

  public getDepartment(departmentId: string): TicketDepartment | null {
    const normalizedId = normalizeOpaqueId(departmentId);
    if (!normalizedId) return null;
    const row = this.db
      .prepare(
        `SELECT * FROM ticket_departments
         WHERE guild_id = ? AND department_id = ?`,
      )
      .get(this.guildId, normalizedId) as DepartmentRow | undefined;
    return row ? parseDepartment(row) : null;
  }

  public getDepartmentBySlug(slug: string): TicketDepartment | null {
    const normalizedSlug = normalizeSlug(slug);
    const row = this.db
      .prepare(
        `SELECT * FROM ticket_departments
         WHERE guild_id = ? AND slug = ?`,
      )
      .get(this.guildId, normalizedSlug) as DepartmentRow | undefined;
    return row ? parseDepartment(row) : null;
  }

  public getGeneralSupportDepartment(): TicketDepartment | null {
    return this.getDepartmentBySlug(GENERAL_SUPPORT_DEPARTMENT_SLUG);
  }

  public listDepartments(
    options: {
      enabled?: boolean;
      limit?: number;
      offset?: number;
    } = {},
  ): TicketDepartment[] {
    const limit = normalizeListLimit(options.limit ?? MAX_TICKET_DEPARTMENTS);
    const offset = normalizeOffset(options.offset ?? 0);
    if (options.enabled === undefined) {
      return (
        this.db
          .prepare(
            `SELECT * FROM ticket_departments
             WHERE guild_id = ?
             ORDER BY sort_order, department_id LIMIT ? OFFSET ?`,
          )
          .all(this.guildId, limit, offset) as DepartmentRow[]
      ).map(parseDepartment);
    }
    if (typeof options.enabled !== "boolean") {
      throw new TypeError("Ticket department enabled filter must be boolean");
    }
    return (
      this.db
        .prepare(
          `SELECT * FROM ticket_departments
           WHERE guild_id = ? AND enabled = ?
           ORDER BY sort_order, department_id LIMIT ? OFFSET ?`,
        )
        .all(
          this.guildId,
          options.enabled ? 1 : 0,
          limit,
          offset,
        ) as DepartmentRow[]
    ).map(parseDepartment);
  }

  public countDepartments(): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM ticket_departments WHERE guild_id = ?",
      )
      .get(this.guildId) as { count: number };
    return Number(row.count);
  }

  public upsertDepartmentField(
    departmentId: string,
    input: TicketDepartmentFieldInput,
  ): TicketDepartmentField {
    const normalizedDepartmentId = requireOpaqueId(
      departmentId,
      "department ID",
    );
    if (!this.getDepartment(normalizedDepartmentId)) {
      throw new Error(
        `Ticket department ${normalizedDepartmentId} was not found`,
      );
    }
    let result: TicketDepartmentField | null = null;
    const upsert = this.db.transaction(() => {
      const existing = input.fieldId
        ? this.getDepartmentField(normalizedDepartmentId, input.fieldId)
        : null;
      const fields = this.listDepartmentFields(normalizedDepartmentId);
      if (!existing && fields.length >= MAX_TICKET_DEPARTMENT_FIELDS) {
        throw new RangeError(
          `A ticket department supports at most ${MAX_TICKET_DEPARTMENT_FIELDS} fields`,
        );
      }
      const normalized = normalizeFieldInput(
        input,
        input.sortOrder ?? firstFreeSortOrder(fields, existing?.fieldId),
      );
      const fieldId =
        existing?.fieldId ?? normalized.fieldId ?? this.allocateFieldId();
      const now = utcNow();
      if (existing) {
        this.db
          .prepare(
            `UPDATE ticket_department_fields
             SET label = ?, description = ?, placeholder = ?, field_type = ?,
                 required = ?, min_length = ?, max_length = ?, sort_order = ?,
                 updated_at = ?
             WHERE guild_id = ? AND department_id = ? AND field_id = ?`,
          )
          .run(
            normalized.label,
            normalized.description,
            normalized.placeholder,
            normalized.fieldType,
            normalized.required ? 1 : 0,
            normalized.minLength,
            normalized.maxLength,
            normalized.sortOrder,
            now,
            this.guildId,
            normalizedDepartmentId,
            fieldId,
          );
      } else {
        this.db
          .prepare(
            `INSERT INTO ticket_department_fields (
               guild_id, department_id, field_id, label, description,
               placeholder, field_type, required, min_length, max_length,
               sort_order, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            this.guildId,
            normalizedDepartmentId,
            fieldId,
            normalized.label,
            normalized.description,
            normalized.placeholder,
            normalized.fieldType,
            normalized.required ? 1 : 0,
            normalized.minLength,
            normalized.maxLength,
            normalized.sortOrder,
            now,
            now,
          );
      }
      this.bumpDefinitionVersion(normalizedDepartmentId, now);
      result = this.requireDepartmentField(normalizedDepartmentId, fieldId);
    });
    upsert.immediate();
    return requireResult<TicketDepartmentField>(result, "Ticket field update");
  }

  public removeDepartmentField(departmentId: string, fieldId: string): boolean {
    const normalizedDepartmentId = requireOpaqueId(
      departmentId,
      "department ID",
    );
    const normalizedFieldId = requireOpaqueId(fieldId, "field ID");
    let removed = false;
    const remove = this.db.transaction(() => {
      removed =
        this.db
          .prepare(
            `DELETE FROM ticket_department_fields
             WHERE guild_id = ? AND department_id = ? AND field_id = ?`,
          )
          .run(this.guildId, normalizedDepartmentId, normalizedFieldId)
          .changes === 1;
      if (removed) this.bumpDefinitionVersion(normalizedDepartmentId, utcNow());
    });
    remove.immediate();
    return removed;
  }

  public reorderDepartmentFields(
    departmentId: string,
    fieldIds: readonly string[],
  ): TicketDepartmentField[] {
    const normalizedDepartmentId = requireOpaqueId(
      departmentId,
      "department ID",
    );
    const normalizedIds = normalizeFieldOrder(fieldIds);
    let result: TicketDepartmentField[] | null = null;
    const reorder = this.db.transaction(() => {
      const existing = this.listDepartmentFields(normalizedDepartmentId);
      if (
        !sameIdSet(
          existing.map((field) => field.fieldId),
          normalizedIds,
        )
      ) {
        throw new TypeError(
          "Field order must include every current ticket field exactly once",
        );
      }
      const byId = new Map(existing.map((field) => [field.fieldId, field]));
      this.db
        .prepare(
          `DELETE FROM ticket_department_fields
           WHERE guild_id = ? AND department_id = ?`,
        )
        .run(this.guildId, normalizedDepartmentId);
      const insert = this.db.prepare(
        `INSERT INTO ticket_department_fields (
           guild_id, department_id, field_id, label, description, placeholder,
           field_type, required, min_length, max_length, sort_order,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const now = utcNow();
      normalizedIds.forEach((id, index) => {
        const field = byId.get(id)!;
        insert.run(
          this.guildId,
          normalizedDepartmentId,
          field.fieldId,
          field.label,
          field.description,
          field.placeholder,
          field.fieldType,
          field.required ? 1 : 0,
          field.minLength,
          field.maxLength,
          index,
          field.createdAt,
          now,
        );
      });
      this.bumpDefinitionVersion(normalizedDepartmentId, now);
      result = this.listDepartmentFields(normalizedDepartmentId);
    });
    reorder.immediate();
    return requireResult<TicketDepartmentField[]>(
      result,
      "Ticket field reorder",
    );
  }

  public getDepartmentField(
    departmentId: string,
    fieldId: string,
  ): TicketDepartmentField | null {
    const normalizedDepartmentId = normalizeOpaqueId(departmentId);
    const normalizedFieldId = normalizeOpaqueId(fieldId);
    if (!normalizedDepartmentId || !normalizedFieldId) return null;
    const row = this.db
      .prepare(
        `SELECT * FROM ticket_department_fields
         WHERE guild_id = ? AND department_id = ? AND field_id = ?`,
      )
      .get(this.guildId, normalizedDepartmentId, normalizedFieldId) as
      DepartmentFieldRow | undefined;
    return row ? parseDepartmentField(row) : null;
  }

  public listDepartmentFields(departmentId: string): TicketDepartmentField[] {
    const normalizedId = requireOpaqueId(departmentId, "department ID");
    return (
      this.db
        .prepare(
          `SELECT * FROM ticket_department_fields
           WHERE guild_id = ? AND department_id = ?
           ORDER BY sort_order, field_id LIMIT ?`,
        )
        .all(
          this.guildId,
          normalizedId,
          MAX_TICKET_DEPARTMENT_FIELDS,
        ) as DepartmentFieldRow[]
    ).map(parseDepartmentField);
  }

  private bumpDefinitionVersion(departmentId: string, now: string): void {
    const changed = this.db
      .prepare(
        `UPDATE ticket_departments
         SET definition_version = definition_version + 1, updated_at = ?
         WHERE guild_id = ? AND department_id = ?
           AND definition_version < 2147483647`,
      )
      .run(now, this.guildId, departmentId).changes;
    if (changed !== 1) {
      throw new RangeError("Ticket department definition version is exhausted");
    }
  }

  private requireDepartment(departmentId: string): TicketDepartment {
    const department = this.getDepartment(departmentId);
    if (!department) throw new Error("Ticket department was not persisted");
    return department;
  }

  private requireDepartmentField(
    departmentId: string,
    fieldId: string,
  ): TicketDepartmentField {
    const field = this.getDepartmentField(departmentId, fieldId);
    if (!field) throw new Error("Ticket department field was not persisted");
    return field;
  }

  private allocateDepartmentId(): string {
    return allocateOpaqueId((id) => this.getDepartment(id) !== null);
  }

  private allocateFieldId(): string {
    return allocateOpaqueId((id) =>
      Boolean(
        this.db
          .prepare(
            `SELECT 1 FROM ticket_department_fields
             WHERE guild_id = ? AND field_id = ? LIMIT 1`,
          )
          .get(this.guildId, id),
      ),
    );
  }
}

function normalizeDepartmentInput(input: TicketDepartmentInput): Required<
  Omit<TicketDepartmentInput, "departmentId">
> & {
  departmentId: string | null;
} {
  const categoryId = normalizeNullableSnowflake(
    input.categoryId,
    "category ID",
  );
  const logChannelId = normalizeNullableSnowflake(
    input.logChannelId,
    "log channel ID",
  );
  const supportRoleId = normalizeNullableSnowflake(
    input.supportRoleId,
    "support role ID",
  );
  const enabled = input.enabled ?? false;
  if (typeof enabled !== "boolean") {
    throw new TypeError("Ticket department enabled must be a boolean");
  }
  if (enabled && (!categoryId || !logChannelId || !supportRoleId)) {
    throw new TypeError(
      "An enabled ticket department requires category, log channel, and support role bindings",
    );
  }
  return {
    departmentId:
      input.departmentId === undefined
        ? null
        : requireOpaqueId(input.departmentId, "department ID"),
    slug: normalizeSlug(input.slug),
    displayName: normalizeText(input.displayName, 1, 100, "display name"),
    description: normalizeText(input.description, 1, 1_000, "description"),
    emoji: normalizeOptionalUnicodeEmoji(input.emoji, "Department emoji"),
    categoryId,
    logChannelId,
    supportRoleId,
    enabled,
    sortOrder: normalizeInteger(input.sortOrder ?? 0, 0, 9, "sort order"),
    bindingsVerifiedAt: normalizeNullableTimestamp(input.bindingsVerifiedAt),
  };
}

function normalizeFieldInput(
  input: TicketDepartmentFieldInput,
  defaultSortOrder: number,
): Required<Omit<TicketDepartmentFieldInput, "fieldId">> & {
  fieldId: string | null;
} {
  const fieldType = normalizeFieldType(input.fieldType);
  const required = input.required ?? true;
  if (typeof required !== "boolean") {
    throw new TypeError("Ticket field required must be a boolean");
  }
  const minLength = normalizeInteger(
    input.minLength ?? (required ? 1 : 0),
    0,
    4_000,
    "minimum length",
  );
  const maxLength = normalizeInteger(
    input.maxLength ?? (fieldType === "short" ? 400 : 2_000),
    1,
    4_000,
    "maximum length",
  );
  if (minLength > maxLength) {
    throw new RangeError("Ticket field minimum length exceeds its maximum");
  }
  if ((required && minLength === 0) || (!required && minLength !== 0)) {
    throw new RangeError(
      required
        ? "A required ticket field needs a positive minimum length"
        : "An optional ticket field must use a zero minimum length",
    );
  }
  return {
    fieldId:
      input.fieldId === undefined
        ? null
        : requireOpaqueId(input.fieldId, "field ID"),
    label: normalizeText(input.label, 1, 45, "field label"),
    description: normalizeOptionalText(
      input.description,
      100,
      "field description",
    ),
    placeholder: normalizeOptionalText(
      input.placeholder,
      100,
      "field placeholder",
    ),
    fieldType,
    required,
    minLength,
    maxLength,
    sortOrder: normalizeInteger(
      input.sortOrder ?? defaultSortOrder,
      0,
      4,
      "field sort order",
    ),
  };
}

function parseDepartment(row: DepartmentRow): TicketDepartment {
  return {
    guildId: row.guild_id,
    departmentId: row.department_id,
    slug: row.slug,
    displayName: row.display_name,
    description: row.description,
    emoji: row.emoji,
    categoryId: row.category_id,
    logChannelId: row.log_channel_id,
    supportRoleId: row.support_role_id,
    enabled: Boolean(row.enabled),
    sortOrder: row.sort_order,
    definitionVersion: row.definition_version,
    bindingsVerifiedAt: row.bindings_verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseDepartmentField(row: DepartmentFieldRow): TicketDepartmentField {
  return {
    guildId: row.guild_id,
    departmentId: row.department_id,
    fieldId: row.field_id,
    label: row.label,
    description: row.description,
    placeholder: row.placeholder,
    fieldType: normalizeFieldType(row.field_type),
    required: Boolean(row.required),
    minLength: row.min_length,
    maxLength: row.max_length,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sameDepartmentConfiguration(
  current: TicketDepartment,
  next: ReturnType<typeof normalizeDepartmentInput>,
): boolean {
  return (
    current.slug === next.slug &&
    current.displayName === next.displayName &&
    current.description === next.description &&
    current.emoji === next.emoji &&
    current.categoryId === next.categoryId &&
    current.logChannelId === next.logChannelId &&
    current.supportRoleId === next.supportRoleId &&
    current.enabled === next.enabled &&
    current.sortOrder === next.sortOrder &&
    current.bindingsVerifiedAt === next.bindingsVerifiedAt
  );
}

function normalizeSlug(value: unknown): string {
  const slug = normalizeText(value, 1, 32, "department slug").toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new TypeError(
      "Department slug must use lowercase letters, numbers, and single hyphens",
    );
  }
  return slug;
}

function normalizeFieldType(value: unknown): FormFieldType {
  if (!(FORM_FIELD_TYPES as readonly unknown[]).includes(value)) {
    throw new TypeError("Field type must be short or paragraph");
  }
  return value as FormFieldType;
}

function normalizeNullableSnowflake(
  value: string | null | undefined,
  label: string,
): string | null {
  return value === undefined || value === null
    ? null
    : assertDiscordSnowflake(value, label);
}

function normalizeOptionalText(
  value: string | null | undefined,
  maximum: number,
  label: string,
): string | null {
  if (value === undefined || value === null) return null;
  return normalizeText(value, 1, maximum, label);
}

function normalizeNullableTimestamp(
  value: string | null | undefined,
): string | null {
  if (value === undefined || value === null) return null;
  if (!value.trim() || !Number.isFinite(Date.parse(value))) {
    throw new TypeError("Bindings verification time must be an ISO timestamp");
  }
  return new Date(value).toISOString();
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

function firstFreeSortOrder(
  fields: readonly TicketDepartmentField[],
  replacingId?: string,
): number {
  const used = new Set(
    fields
      .filter((field) => field.fieldId !== replacingId)
      .map((field) => field.sortOrder),
  );
  for (let order = 0; order < MAX_TICKET_DEPARTMENT_FIELDS; order += 1) {
    if (!used.has(order)) return order;
  }
  throw new RangeError("No ticket field position is available");
}

function normalizeFieldOrder(fieldIds: readonly string[]): string[] {
  if (
    !Array.isArray(fieldIds) ||
    fieldIds.length > MAX_TICKET_DEPARTMENT_FIELDS
  ) {
    throw new RangeError(
      `Field order supports at most ${MAX_TICKET_DEPARTMENT_FIELDS} fields`,
    );
  }
  const normalized = fieldIds.map((id) => requireOpaqueId(id, "field ID"));
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError("Field order contains duplicate IDs");
  }
  return normalized;
}

function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((value) => right.includes(value))
  );
}

function normalizeListLimit(value: number): number {
  return normalizeInteger(value, 1, MAX_TICKET_DEPARTMENTS, "list limit");
}

function normalizeOffset(value: number): number {
  return normalizeInteger(value, 0, 2_147_483_647, "list offset");
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
  const normalized = normalizeOpaqueId(value);
  if (!normalized) {
    throw new TypeError(`${label} must be an 8-24 character opaque token`);
  }
  return normalized;
}

function utcNow(): string {
  return new Date().toISOString();
}

function requireResult<T>(result: T | null, label: string): T {
  if (result === null) throw new Error(`${label} completed without a result`);
  return result;
}
