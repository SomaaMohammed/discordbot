import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type APIEmbedField,
} from "discord.js";

export const FORM_LIMITS = Object.freeze({
  fields: 5,
  key: 32,
  label: 45,
  description: 100,
  placeholder: 100,
  response: 4_000,
  modalTitle: 45,
  customId: 100,
});

export const FORM_FIELD_TYPES = ["short", "paragraph"] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

export interface FormFieldDefinition {
  fieldId: string;
  key: string;
  label: string;
  description: string | null;
  placeholder: string | null;
  type: FormFieldType;
  required: boolean;
  minLength: number;
  maxLength: number;
  sortOrder: number;
}

export interface FormFieldInput {
  fieldId: string;
  key: string;
  label: string;
  description?: string | null;
  placeholder?: string | null;
  type: FormFieldType;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  sortOrder: number;
}

export interface FormResponse {
  fieldId: string;
  key: string;
  label: string;
  value: string;
  sortOrder: number;
}

export function normalizeFormField(input: FormFieldInput): FormFieldDefinition {
  const type = normalizeFieldType(input.type);
  const required = input.required ?? true;
  if (typeof required !== "boolean") {
    throw new TypeError("Form field required must be a boolean.");
  }
  const minLength = normalizeInteger(
    input.minLength ?? (required ? 1 : 0),
    0,
    FORM_LIMITS.response,
    "Form field minimum length",
  );
  const maxLength = normalizeInteger(
    input.maxLength ?? (type === "short" ? 400 : 2_000),
    1,
    FORM_LIMITS.response,
    "Form field maximum length",
  );
  if (minLength > maxLength) {
    throw new RangeError(
      "Form field minimum length cannot exceed its maximum length.",
    );
  }
  if (required && minLength < 1) {
    throw new RangeError(
      "A required form field must accept at least one character.",
    );
  }
  if (!required && minLength !== 0) {
    throw new RangeError(
      "An optional form field must use a minimum length of zero.",
    );
  }
  return {
    fieldId: normalizeOpaqueId(input.fieldId, "Form field ID"),
    key: normalizeSlug(input.key, "Form field key", FORM_LIMITS.key),
    label: normalizeSingleLine(
      input.label,
      "Form field label",
      FORM_LIMITS.label,
    ),
    description: normalizeOptionalSingleLine(
      input.description,
      "Form field description",
      FORM_LIMITS.description,
    ),
    placeholder: normalizeOptionalSingleLine(
      input.placeholder,
      "Form field placeholder",
      FORM_LIMITS.placeholder,
    ),
    type,
    required,
    minLength,
    maxLength,
    sortOrder: normalizeInteger(
      input.sortOrder,
      0,
      2_147_483_647,
      "Form field order",
    ),
  };
}

export function validateFormDefinition(
  fields: readonly FormFieldInput[],
  options: { allowEmpty?: boolean } = {},
): FormFieldDefinition[] {
  if (!Array.isArray(fields)) {
    throw new TypeError("Form fields must be an array.");
  }
  const minimum = options.allowEmpty ? 0 : 1;
  if (fields.length < minimum || fields.length > FORM_LIMITS.fields) {
    throw new RangeError(
      `A form must contain ${minimum}-${FORM_LIMITS.fields} fields.`,
    );
  }
  const normalized = fields.map(normalizeFormField).sort(compareFormFields);
  const ids = new Set<string>();
  const keys = new Set<string>();
  const positions = new Set<number>();
  for (const field of normalized) {
    rejectDuplicate(ids, field.fieldId, `form field ID ${field.fieldId}`);
    rejectDuplicate(keys, field.key, `form field key ${field.key}`);
    rejectDuplicate(
      positions,
      field.sortOrder,
      `form field order ${field.sortOrder}`,
    );
  }
  return normalized;
}

export function createConfiguredModal(input: {
  customId: string;
  title: string;
  fields: readonly FormFieldInput[];
}): ModalBuilder {
  const customId = normalizeCustomId(input.customId);
  const title = normalizeSingleLine(
    input.title,
    "Form title",
    FORM_LIMITS.modalTitle,
  );
  const fields = validateFormDefinition(input.fields);
  const modal = new ModalBuilder().setCustomId(customId).setTitle(title);
  for (const field of fields) {
    const component = new TextInputBuilder()
      .setCustomId(field.fieldId)
      .setLabel(field.label)
      .setStyle(
        field.type === "paragraph"
          ? TextInputStyle.Paragraph
          : TextInputStyle.Short,
      )
      .setRequired(field.required)
      .setMaxLength(field.maxLength);
    if (field.minLength > 0) component.setMinLength(field.minLength);
    const guidance = field.placeholder ?? field.description;
    if (guidance) component.setPlaceholder(guidance);
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(component),
    );
  }
  return modal;
}

export function validateFormResponses(
  fields: readonly FormFieldInput[],
  readValue: (fieldId: string) => string,
): FormResponse[] {
  const definition = validateFormDefinition(fields);
  return definition.map((field) => {
    let raw: string;
    try {
      raw = readValue(field.fieldId);
    } catch {
      raw = "";
    }
    const value = normalizeResponseText(raw, field);
    return {
      fieldId: field.fieldId,
      key: field.key,
      label: field.label,
      value,
      sortOrder: field.sortOrder,
    };
  });
}

export function renderFormResponses(
  responses: readonly Pick<FormResponse, "label" | "value" | "sortOrder">[],
): APIEmbedField[] {
  return [...responses]
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((response) => ({
      name: safeDisplayText(response.label, 256),
      value: response.value
        ? safeDisplayText(response.value, 1_024)
        : "*No response provided.*",
      inline: false,
    }));
}

export function normalizeSlug(
  value: string,
  label = "Key",
  maximum = 32,
): string {
  const normalized = normalizeSingleLine(value, label, maximum).toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) {
    throw new TypeError(
      `${label} must use lowercase letters, numbers, and single hyphens.`,
    );
  }
  return normalized;
}

export function normalizeSingleLine(
  value: string,
  label: string,
  maximum: number,
): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be text.`);
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized) throw new TypeError(`${label} cannot be empty.`);
  assertNoControls(normalized, label);
  if (normalized.length > maximum) {
    throw new RangeError(`${label} cannot exceed ${maximum} characters.`);
  }
  return normalized;
}

export function normalizeMultilineText(
  value: string,
  label: string,
  minimum: number,
  maximum: number,
): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be text.`);
  const normalized = value
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/gu, ""))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  assertNoControls(normalized, label);
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new RangeError(
      `${label} must contain ${minimum}-${maximum} characters.`,
    );
  }
  return normalized;
}

export function safeDisplayText(value: string, maximum: number): string {
  const normalized = String(value)
    .normalize("NFC")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "�")
    .replace(/@(everyone|here)/giu, "@\u200b$1")
    .replace(/<(@[!&]?|#)(\d{17,20})>/gu, "<$1\u200b$2>");
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, Math.max(0, maximum - 1))}…`;
}

function normalizeResponseText(
  value: string,
  field: FormFieldDefinition,
): string {
  if (typeof value !== "string") {
    throw new TypeError(`${field.label} must be text.`);
  }
  const normalized = value.normalize("NFKC").replace(/\r\n?/gu, "\n").trim();
  assertNoControls(normalized, field.label);
  if (!normalized && !field.required) return "";
  if (
    normalized.length < field.minLength ||
    normalized.length > field.maxLength
  ) {
    throw new RangeError(
      `${field.label} must contain ${field.minLength}-${field.maxLength} characters.`,
    );
  }
  return normalized;
}

function normalizeFieldType(value: unknown): FormFieldType {
  if (!(FORM_FIELD_TYPES as readonly unknown[]).includes(value)) {
    throw new TypeError("Form field type must be short or paragraph.");
  }
  return value as FormFieldType;
}

function normalizeOptionalSingleLine(
  value: string | null | undefined,
  label: string,
  maximum: number,
): string | null {
  if (value === undefined || value === null || value.trim() === "") return null;
  return normalizeSingleLine(value, label, maximum);
}

function normalizeOpaqueId(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > 24 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new TypeError(`${label} must be an 8-24 character opaque token.`);
  }
  return value;
}

function normalizeCustomId(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > FORM_LIMITS.customId ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new RangeError(
      `Form custom ID must contain 1-${FORM_LIMITS.customId} safe characters.`,
    );
  }
  return value;
}

function normalizeInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function assertNoControls(value: string, label: string): void {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} cannot contain control characters.`);
  }
}

function rejectDuplicate<T>(seen: Set<T>, value: T, label: string): void {
  if (seen.has(value)) throw new TypeError(`Duplicate ${label}.`);
  seen.add(value);
}

function compareFormFields(
  left: FormFieldDefinition,
  right: FormFieldDefinition,
): number {
  return (
    left.sortOrder - right.sortOrder ||
    left.fieldId.localeCompare(right.fieldId)
  );
}
