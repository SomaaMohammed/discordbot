import { describe, expect, it } from "vitest";
import {
  APPLICATION_COMPONENT_PREFIX,
  buildApplicationFormSelect,
  buildApplicationReviewPayload,
  createApplicationDecisionModal,
  createApplicationSubmitModal,
  parseApplicationComponentId,
} from "../src/discord/application-components.js";
import {
  buildSuggestionPublicPayload,
  createSuggestionReviewModal,
  parseSuggestionComponentId,
} from "../src/discord/suggestion-components.js";
import {
  buildTicketDepartmentSelect,
  buildTicketClosureEmbed,
  buildTicketInfoPayload,
  buildTicketWelcomePayload,
  createTicketOpenModal,
  parseTicketComponentId,
  TICKET_RESPONSE_ATTACHMENT_LIMIT_BYTES,
  toTicketFormFieldInput,
} from "../src/discord/ticket-components.js";
import type { TicketRecord } from "../src/types.js";

const ID = "opaque_12345";

describe("Phase 2 component contracts", () => {
  it("renders only valid Unicode department emoji", () => {
    const selector = buildTicketDepartmentSelect(ID, [
      {
        departmentId: "Dept_ABC1",
        displayName: "Billing",
        description: "Billing requests",
        emoji: "  🎫  ",
      },
      {
        departmentId: "Dept_ABC2",
        displayName: "Technical",
        description: "Technical requests",
        emoji: "not-an-emoji",
      },
    ]).toJSON();
    const menu = selector.components[0] as
      { options?: Array<{ emoji?: { name?: string } }> } | undefined;

    expect(menu?.options?.[0]?.emoji).toMatchObject({ name: "🎫" });
    expect(menu?.options?.[1]?.emoji).toBeUndefined();
  });

  it("keeps suggestion IDs compact and rejects malformed controls", () => {
    expect(
      parseSuggestionComponentId(`superior:suggestion:vote:up:${ID}`),
    ).toEqual({
      kind: "vote",
      direction: "up",
      suggestionId: ID,
    });
    expect(
      parseSuggestionComponentId(`superior:suggestion:review:accepted:${ID}`),
    ).toEqual({ kind: "review", state: "accepted", suggestionId: ID });
    expect(
      parseSuggestionComponentId("superior:suggestion:vote:sideways:x"),
    ).toBeNull();
    expect(createSuggestionReviewModal(ID, "accepted").toJSON().custom_id).toBe(
      `superior:suggestion:review-modal:accepted:${ID}`,
    );
  });

  it("renders attributed suggestions with disabled voting after a decision", () => {
    const payload = buildSuggestionPublicPayload(
      {
        suggestionId: ID,
        suggestionNumber: 7,
        authorId: "123456789012345678",
        title: "Improve onboarding",
        details: "Add a short guide for new members.",
        state: "accepted",
        reviewerId: "223456789012345678",
        reviewReason: "This is useful and within scope.",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
      { upvotes: 4, downvotes: 1 },
    );
    expect(payload.allowedMentions).toEqual({ parse: [] });
    expect(toJson(payload.embeds?.[0])).toMatchObject({
      title: "Suggestion #7: Improve onboarding",
    });
    expect(
      (toJson(payload.components?.[0]) as { components?: unknown[] })
        .components,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ disabled: true })]),
    );
  });

  it("parses application decisions and keeps answers only in the review payload", () => {
    expect(
      parseApplicationComponentId(
        `${APPLICATION_COMPONENT_PREFIX}decision-modal:reject:${ID}`,
      ),
    ).toEqual({
      kind: "decision-modal",
      decision: "reject",
      applicationId: ID,
    });
    expect(
      createApplicationDecisionModal(ID, "reject").toJSON().custom_id,
    ).toBe(`${APPLICATION_COMPONENT_PREFIX}decision-modal:reject:${ID}`);
    const payload = buildApplicationReviewPayload(
      {
        applicationId: ID,
        applicationNumber: 3,
        applicantId: "123456789012345678",
        state: "submitted",
        claimedBy: null,
        decisionBy: null,
        decisionReason: null,
        createdAt: "2026-08-01T00:00:00.000Z",
      },
      { displayName: "Moderator", description: "Help the moderation team." },
      [
        {
          fieldId: "field_reason",
          key: "reason",
          label: "Why do you want to help?",
          value: "I enjoy helping @everyone.",
          sortOrder: 0,
        },
      ],
    );
    const json = toJson(payload.embeds?.[0]);
    expect(JSON.stringify(json)).toContain("I enjoy helping @​everyone.");
    expect(payload.allowedMentions).toEqual({ parse: [] });
  });

  it("supports private command submissions and bounded form selection", () => {
    const form = {
      formId: ID,
      definitionVersion: 7,
      slug: "moderator",
      displayName: "Moderator",
      description: "Help the moderation team.",
      fields: [
        {
          fieldId: "field_reason",
          key: "field-reason",
          label: "Why do you want to help?",
          type: "paragraph" as const,
          required: true,
          minLength: 10,
          maxLength: 500,
          sortOrder: 0,
        },
      ],
    };
    const modal = createApplicationSubmitModal("command", form).toJSON();
    expect(modal.custom_id).toBe(
      `${APPLICATION_COMPONENT_PREFIX}submit-modal:command:${ID}:7`,
    );
    expect(parseApplicationComponentId(modal.custom_id)).toEqual({
      kind: "submit-modal",
      panelId: "command",
      formId: ID,
      definitionVersion: 7,
    });

    const selector = buildApplicationFormSelect(ID, [form]).toJSON();
    expect(selector.components[0]).toMatchObject({
      custom_id: `${APPLICATION_COMPONENT_PREFIX}select:${ID}`,
      options: [expect.objectContaining({ value: ID })],
    });
    expect(() =>
      buildApplicationFormSelect(
        ID,
        Array.from({ length: 26 }, (_, index) => ({
          ...form,
          formId: `opaque_${String(index).padStart(8, "0")}`,
        })),
      ),
    ).toThrow(/1-25/);
  });

  it("keeps legacy ticket modal IDs and uses safe keys for opaque field IDs", () => {
    const departmentId = "Dept_ABC1";
    const field = toTicketFormFieldInput({
      guildId: "123456789012345678",
      departmentId,
      fieldId: "Field_ABC1",
      label: "Request details",
      description: null,
      placeholder: "Describe what happened",
      fieldType: "paragraph",
      required: true,
      minLength: 3,
      maxLength: 500,
      sortOrder: 0,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });

    expect(field).toMatchObject({
      fieldId: "Field_ABC1",
      key: "field-1",
    });
    expect(parseTicketComponentId(`superior:ticket:open-modal:${ID}`)).toEqual({
      kind: "open-modal",
      panelId: ID,
      departmentId: null,
      definitionVersion: null,
    });
    const modal = createTicketOpenModal(ID, {
      departmentId,
      definitionVersion: 7,
      departmentName: "Billing Support",
      fields: [field],
    }).toJSON();
    expect(modal.custom_id).toBe(
      `superior:ticket:open-modal:${ID}:${departmentId}:7`,
    );
    expect(parseTicketComponentId(modal.custom_id)).toEqual({
      kind: "open-modal",
      panelId: ID,
      departmentId,
      definitionVersion: 7,
    });
    const firstRow = modal.components[0] as
      { components?: Array<{ custom_id?: string }> } | undefined;
    expect(firstRow?.components?.[0]).toMatchObject({
      custom_id: "Field_ABC1",
    });
  });

  it("budgets response previews and attaches all five maximum-length answers", () => {
    const ticket: TicketRecord = {
      guildId: "123456789012345678",
      ticketId: ID,
      ticketNumber: 42,
      departmentId: "department01",
      openerId: "223456789012345678",
      channelId: "323456789012345678",
      controlMessageId: "423456789012345678",
      subject: "S".repeat(100),
      description: "D".repeat(1_000),
      state: "closed",
      claimedBy: "523456789012345678",
      claimedAt: "2026-08-01T00:01:00.000Z",
      closedBy: "623456789012345678",
      closeReason: "R".repeat(400),
      closeLogMessageId: "723456789012345678",
      closeLoggedAt: "2026-08-01T00:03:00.000Z",
      failureReason: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:03:00.000Z",
      closingAt: "2026-08-01T00:02:00.000Z",
      closedAt: "2026-08-01T00:03:00.000Z",
    };
    const responseTails = Array.from(
      { length: 5 },
      (_, index) => `TAIL-${index + 1}-@everyone`,
    );
    const responseFill = ["界", "語", "漢", "字", "文"];
    const context = {
      department: { displayName: "Department ".repeat(4).slice(0, 45) },
      responses: Array.from({ length: 5 }, (_, index) => ({
        fieldId: `field000${index}`,
        key: `field-${index + 1}`,
        label: `Question ${index + 1} ${"L".repeat(34)}`.slice(0, 45),
        value: `${responseFill[index]!.repeat(4_000 - responseTails[index]!.length)}${responseTails[index]}`,
        sortOrder: index,
      })),
    };
    expect(context.responses.map(({ value }) => value.length)).toEqual(
      Array(5).fill(4_000),
    );
    const welcome = buildTicketWelcomePayload(ticket, context);
    const info = buildTicketInfoPayload(ticket, context);
    const embeds = [
      welcome.embeds[0]!,
      info.embeds[0]!,
      buildTicketClosureEmbed(ticket, context),
    ].map((embed) => embed.toJSON());

    for (const embed of embeds) {
      expect(embedCharacterCount(embed)).toBeLessThanOrEqual(6_000);
      expect(
        embed.fields?.filter(({ name }) => name.startsWith("Question")),
      ).toHaveLength(5);
    }
    for (const payload of [welcome, info]) {
      expect(payload.allowedMentions).toEqual({ parse: [] });
      expect(payload.files).toHaveLength(1);
      expect(payload.files[0]?.name).toBe("superior-ticket-42-responses.txt");
      const attachment = payload.files[0]?.attachment;
      expect(Buffer.isBuffer(attachment)).toBe(true);
      const buffer = attachment as Buffer;
      expect(buffer.byteLength).toBeGreaterThan(60_000);
      expect(buffer.byteLength).toBeLessThanOrEqual(
        TICKET_RESPONSE_ATTACHMENT_LIMIT_BYTES,
      );
      const text = buffer.toString("utf8");
      for (const response of context.responses) {
        expect(text).toContain(response.value);
      }
      expect(text).toContain(context.responses[4]!.value.slice(-64));
    }
  });
});

function toJson(value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    "toJSON" in value &&
    typeof (value as { toJSON?: unknown }).toJSON === "function"
  ) {
    return (value as { toJSON(): unknown }).toJSON();
  }
  return value;
}

function embedCharacterCount(embed: {
  title?: string;
  description?: string;
  footer?: { text?: string };
  author?: { name?: string };
  fields?: Array<{ name: string; value: string }>;
}): number {
  return (
    (embed.title?.length ?? 0) +
    (embed.description?.length ?? 0) +
    (embed.footer?.text?.length ?? 0) +
    (embed.author?.name?.length ?? 0) +
    (embed.fields?.reduce(
      (total, field) => total + field.name.length + field.value.length,
      0,
    ) ?? 0)
  );
}
