import { describe, expect, it } from "vitest";
import {
  createConfiguredModal,
  normalizeSlug,
  renderFormResponses,
  validateFormDefinition,
  validateFormResponses,
  type FormFieldInput,
} from "../src/discord/forms.js";

const fields: FormFieldInput[] = [
  {
    fieldId: "field_title",
    key: "title",
    label: "Title",
    type: "short",
    required: true,
    minLength: 3,
    maxLength: 80,
    sortOrder: 0,
  },
  {
    fieldId: "field_details",
    key: "details",
    label: "Details",
    description: "Give staff the context they need",
    placeholder: "Include relevant context",
    type: "paragraph",
    required: false,
    minLength: 0,
    maxLength: 2_000,
    sortOrder: 1,
  },
];

describe("reusable Discord forms", () => {
  it("normalizes a bounded definition and renders one modal row per field", () => {
    expect(validateFormDefinition(fields)).toMatchObject([
      { key: "title", required: true, type: "short" },
      { key: "details", required: false, type: "paragraph" },
    ]);
    const modal = createConfiguredModal({
      customId: "superior:form:example",
      title: "Example form",
      fields,
    }).toJSON();
    expect(modal.custom_id).toBe("superior:form:example");
    expect(modal.components).toHaveLength(2);
    const firstRow = modal.components[0] as unknown as {
      components: Array<Record<string, unknown>>;
    };
    expect(firstRow.components[0]).toMatchObject({
      custom_id: "field_title",
      min_length: 3,
      max_length: 80,
      required: true,
    });
  });

  it("rejects duplicate identities, positions, unsafe limits, and excess fields", () => {
    expect(() =>
      validateFormDefinition([...fields, { ...fields[0]!, sortOrder: 2 }]),
    ).toThrow(/Duplicate form field ID/);
    expect(() =>
      validateFormDefinition([
        fields[0]!,
        { ...fields[1]!, fieldId: "field_other", sortOrder: 0 },
      ]),
    ).toThrow(/Duplicate form field order/);
    expect(() =>
      validateFormDefinition([{ ...fields[0]!, minLength: 81, maxLength: 80 }]),
    ).toThrow(/cannot exceed/);
    expect(() =>
      validateFormDefinition(
        Array.from({ length: 6 }, (_, index) => ({
          ...fields[0]!,
          fieldId: `field_0000${index}`,
          key: `field-${index}`,
          sortOrder: index,
        })),
      ),
    ).toThrow(/1-5 fields/);
  });

  it("normalizes submitted responses and suppresses rendered mentions", () => {
    const responses = validateFormResponses(fields, (fieldId) =>
      fieldId === "field_title"
        ? "  A useful idea  "
        : "@everyone <@123456789012345678>",
    );
    expect(responses).toMatchObject([
      { key: "title", value: "A useful idea" },
      { key: "details", value: "@everyone <@123456789012345678>" },
    ]);
    const rendered = renderFormResponses(responses);
    expect(rendered[1]?.value).toContain("@\u200beveryone");
    expect(rendered[1]?.value).toContain("<@\u200b123456789012345678>");
  });

  it("supports an explicit empty-definition seam for ticket defaults", () => {
    expect(validateFormDefinition([], { allowEmpty: true })).toEqual([]);
    expect(() => validateFormDefinition([])).toThrow(/1-5 fields/);
  });

  it("uses stable lowercase slugs", () => {
    expect(normalizeSlug("General-Support")).toBe("general-support");
    expect(() => normalizeSlug("general support")).toThrow(/hyphens/);
  });
});
