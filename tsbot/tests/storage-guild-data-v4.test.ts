import { afterEach, describe, expect, it } from "vitest";
import { BotStorage } from "../src/storage/db.js";

const GUILD = "111111111111111111";
const ADMIN = "222222222222222222";
const ROLE = "333333333333333333";
const CHANNEL = "444444444444444444";
const LOG_CHANNEL = "555555555555555555";
const USER = "666666666666666666";
const MESSAGE = "777777777777777777";
const SECOND_MESSAGE = "888888888888888888";
const storages: BotStorage[] = [];

afterEach(() => {
  for (const storage of storages.splice(0)) storage.close();
});

describe("guild data export format 4", () => {
  it("round-trips all Phase 2 collections with authority and bindings dormant", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD);
    const guild = storage.forGuild(GUILD);

    guild.grantRoleCapability(ROLE, "suggestions.review", ADMIN);
    const department = guild.createTicketDepartment({
      departmentId: "department_a",
      slug: "support",
      displayName: "Support",
      description: "Request help from the support team.",
      categoryId: CHANNEL,
      logChannelId: LOG_CHANNEL,
      supportRoleId: ROLE,
      enabled: true,
      bindingsVerifiedAt: "2026-01-01T00:00:00.000Z",
    });
    guild.upsertTicketDepartmentField(department.departmentId, {
      fieldId: "question_a",
      label: "Question",
      fieldType: "paragraph",
      required: true,
      minLength: 1,
      maxLength: 500,
      sortOrder: 0,
    });

    guild.upsertSuggestionConfiguration({
      suggestionChannelId: CHANNEL,
      reviewChannelId: LOG_CHANNEL,
      reviewerRoleId: ROLE,
      enabled: true,
      createThreads: true,
      bindingsVerifiedAt: "2026-01-01T00:00:00.000Z",
    });
    const suggestion = guild.reserveSuggestion({
      authorId: USER,
      title: "Portable suggestion",
      details: "Preserve suggestion workflow data.",
    });
    if (suggestion.status !== "created")
      throw new Error("Suggestion was not reserved");
    guild.bindSuggestionDelivery(suggestion.suggestion.suggestionId, {
      channelId: CHANNEL,
      messageId: MESSAGE,
    });
    guild.toggleSuggestionVote(suggestion.suggestion.suggestionId, ADMIN, 1);

    const form = guild.createApplicationForm({
      formId: "staff_form",
      slug: "staff",
      displayName: "Staff",
      description: "Apply to join the staff team.",
      reviewerRoleId: ROLE,
      reviewChannelId: LOG_CHANNEL,
      enabled: false,
      bindingsVerifiedAt: "2026-01-01T00:00:00.000Z",
    });
    guild.upsertApplicationFormField(form.formId, {
      fieldId: "motivation_a",
      label: "Why do you want to help?",
      fieldType: "paragraph",
      required: true,
      minLength: 1,
      maxLength: 1_000,
      sortOrder: 0,
    });
    guild.setApplicationFormEnabled(form.formId, true);
    const application = guild.reserveApplication({
      formId: form.formId,
      applicantId: USER,
      responses: [
        {
          fieldId: "motivation_a",
          fieldLabel: "Why do you want to help?",
          fieldType: "paragraph",
          responseText: "I want to support the community.",
          sortOrder: 0,
        },
      ],
    });
    if (application.status !== "created")
      throw new Error("Application was not reserved");
    guild.bindApplicationDelivery(application.application.applicationId, {
      reviewChannelId: LOG_CHANNEL,
      reviewMessageId: SECOND_MESSAGE,
    });

    const payload = storage.exportGuildData(GUILD);
    expect(payload).toMatchObject({
      formatVersion: 4,
      delegatedCapabilityGrants: [{ active: true }],
      ticketDepartments: [{ departmentId: "department_a", enabled: true }],
      ticketDepartmentFields: [{ fieldId: "question_a" }],
      suggestions: [{ suggestionId: suggestion.suggestion.suggestionId }],
      suggestionVotes: [{ voterId: ADMIN, vote: 1 }],
      applicationForms: [{ formId: "staff_form", enabled: true }],
      applications: [{ applicationId: application.application.applicationId }],
      applicationResponses: [{ fieldId: "motivation_a" }],
    });

    storage.importGuildData(GUILD, payload, storage.getGuildSettings(GUILD)!);
    const restored = storage.exportGuildData(GUILD);
    expect(restored.delegatedCapabilityGrants).toMatchObject([
      { active: false },
    ]);
    expect(restored.ticketDepartments).toMatchObject([
      {
        departmentId: "department_a",
        enabled: false,
        bindingsVerifiedAt: null,
      },
    ]);
    expect(restored.suggestionConfiguration).toMatchObject({
      enabled: false,
      bindingsVerifiedAt: null,
    });
    expect(restored.applicationForms).toMatchObject([
      { formId: "staff_form", enabled: false, bindingsVerifiedAt: null },
    ]);
    expect(restored.suggestions).toHaveLength(1);
    expect(restored.suggestionVotes).toHaveLength(1);
    expect(restored.applications).toHaveLength(1);
    expect(restored.applicationResponses).toHaveLength(1);
    expect(storage.getGuildSettings(GUILD)).toMatchObject({
      enabled: false,
      reviewRequired: true,
    });

    const counts = storage.previewGuildPurge(GUILD);
    expect(counts).toMatchObject({
      delegatedCapabilityGrants: 1,
      ticketDepartments: 1,
      ticketDepartmentFields: 1,
      suggestions: 1,
      suggestionVotes: 1,
      applicationForms: 1,
      applicationFormFields: 1,
      applications: 1,
      applicationResponses: 1,
    });
    expect(storage.purgeGuildData(GUILD)).toEqual(counts);
    expect(storage.getGuild(GUILD)).toBeNull();
  });

  it("rejects user-principal capability grants in format 4 imports", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD);
    storage.forGuild(GUILD).grantRoleCapability(ROLE, "panels.manage", ADMIN);
    const payload = storage.exportGuildData(GUILD);
    payload.delegatedCapabilityGrants[0]!.principalType = "user";

    expect(() =>
      storage.importGuildData(GUILD, payload, storage.getGuildSettings(GUILD)!),
    ).toThrow(/capability principal type is unsupported/);
    expect(
      storage.exportGuildData(GUILD).delegatedCapabilityGrants,
    ).toMatchObject([
      { principalType: "role", principalId: ROLE, active: true },
    ]);
  });

  it("rejects a malformed Unicode department emoji in format 4", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD);
    const guild = storage.forGuild(GUILD);
    guild.createTicketDepartment({
      departmentId: "emoji_department",
      slug: "emoji",
      displayName: "Emoji",
      description: "Validate imported department emoji.",
      emoji: "🎫",
      enabled: false,
    });
    const payload = storage.exportGuildData(GUILD);
    payload.ticketDepartments[0]!.emoji = "not-an-emoji";

    expect(() =>
      storage.importGuildData(GUILD, payload, storage.getGuildSettings(GUILD)!),
    ).toThrow(/Imported ticket department emoji must be one Unicode emoji/);
    expect(guild.getTicketDepartmentBySlug("emoji")?.emoji).toBe("🎫");
  });

  it("maps format 3 to disabled General Support and clears newer collections", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD);
    const guild = storage.forGuild(GUILD);
    guild.grantRoleCapability(ROLE, "panels.manage", ADMIN);
    guild.upsertSuggestionConfiguration({
      suggestionChannelId: CHANNEL,
      reviewerRoleId: ROLE,
      enabled: true,
    });

    const current = storage.exportGuildData(GUILD);
    const legacyV3 = {
      formatVersion: 3,
      guildId: GUILD,
      exportedAt: current.exportedAt,
      metadata: current.metadata,
      settings: current.settings,
      metrics: current.metrics,
      ticketConfiguration: {
        guildId: GUILD,
        enabled: true,
        categoryId: CHANNEL,
        logChannelId: LOG_CHANNEL,
        supportRoleId: ROLE,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      postedPanels: [],
      tickets: [],
      ticketEvents: [],
    };

    storage.importGuildData(GUILD, legacyV3, storage.getGuildSettings(GUILD)!);
    const restored = storage.exportGuildData(GUILD);
    expect(restored.delegatedCapabilityGrants).toEqual([]);
    expect(restored.suggestionConfiguration).toBeNull();
    expect(restored.ticketDepartments).toMatchObject([
      {
        slug: "general-support",
        displayName: "General Support",
        enabled: false,
        bindingsVerifiedAt: null,
      },
    ]);
    expect(restored.ticketDepartmentFields).toHaveLength(2);
  });

  it("rejects more than 100 imported audit events for one format 4 ticket", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD);
    const guild = storage.forGuild(GUILD);
    guild.upsertTicketConfiguration({
      categoryId: CHANNEL,
      logChannelId: LOG_CHANNEL,
      supportRoleId: ROLE,
    });
    const reservation = guild.reserveTicketCreation({
      openerId: USER,
      subject: "Import bound",
      description: "Reject oversized per-ticket history.",
    });
    if (reservation.status !== "created") throw new Error("expected ticket");
    const payload = storage.exportGuildData(GUILD);
    const oversized = {
      ...payload,
      ticketEvents: importedTicketEvents(reservation.ticket.ticketId, 101),
    };

    expect(() =>
      storage.importGuildData(
        GUILD,
        oversized,
        storage.getGuildSettings(GUILD)!,
      ),
    ).toThrow(/at most 100 audit events/i);
    expect(storage.exportGuildData(GUILD).ticketEvents).toHaveLength(1);
  });

  it("rejects more than 100 imported audit events for one legacy format 3 ticket", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD);
    const guild = storage.forGuild(GUILD);
    const configuration = guild.upsertTicketConfiguration({
      categoryId: CHANNEL,
      logChannelId: LOG_CHANNEL,
      supportRoleId: ROLE,
    });
    const reservation = guild.reserveTicketCreation({
      openerId: USER,
      subject: "Legacy import bound",
      description: "Reject oversized legacy per-ticket history.",
    });
    if (reservation.status !== "created") throw new Error("expected ticket");
    const current = storage.exportGuildData(GUILD);
    const { departmentId: _departmentId, ...legacyTicket } = reservation.ticket;
    const legacy = {
      formatVersion: 3,
      guildId: GUILD,
      exportedAt: current.exportedAt,
      metadata: current.metadata,
      settings: current.settings,
      metrics: current.metrics,
      ticketConfiguration: configuration,
      postedPanels: [],
      tickets: [legacyTicket],
      ticketEvents: importedTicketEvents(reservation.ticket.ticketId, 101),
    };

    expect(() =>
      storage.importGuildData(GUILD, legacy, storage.getGuildSettings(GUILD)!),
    ).toThrow(/at most 100 events/i);
    expect(storage.exportGuildData(GUILD).ticketEvents).toHaveLength(1);
  });

  it("keeps legacy format 2 operational rows but makes every binding dormant", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD);
    const guild = storage.forGuild(GUILD);
    guild.grantRoleCapability(ROLE, "panels.manage", ADMIN);
    const department = guild.createTicketDepartment({
      departmentId: "legacy_v2_department",
      slug: "legacy-v2",
      displayName: "Legacy v2",
      description: "Preserve this department without reactivating it.",
      categoryId: CHANNEL,
      logChannelId: LOG_CHANNEL,
      supportRoleId: ROLE,
      enabled: true,
      bindingsVerifiedAt: "2026-01-01T00:00:00.000Z",
    });
    guild.upsertSuggestionConfiguration({
      suggestionChannelId: CHANNEL,
      reviewerRoleId: ROLE,
      enabled: true,
      bindingsVerifiedAt: "2026-01-01T00:00:00.000Z",
    });
    const form = guild.createApplicationForm({
      formId: "legacy_v2_form",
      slug: "legacy-v2",
      displayName: "Legacy v2",
      description: "Preserve this form without reactivating it.",
      reviewerRoleId: ROLE,
      reviewChannelId: LOG_CHANNEL,
      bindingsVerifiedAt: "2026-01-01T00:00:00.000Z",
    });
    guild.upsertApplicationFormField(form.formId, {
      fieldId: "legacy_v2_question",
      label: "Why are you applying?",
      fieldType: "paragraph",
      required: true,
      minLength: 1,
      maxLength: 500,
    });
    guild.setApplicationFormEnabled(form.formId, true);
    const current = storage.exportGuildData(GUILD);
    const legacyV2 = {
      formatVersion: 2,
      guildId: GUILD,
      exportedAt: current.exportedAt,
      metadata: current.metadata,
      settings: current.settings,
      metrics: current.metrics,
    };

    storage.importGuildData(GUILD, legacyV2, storage.getGuildSettings(GUILD)!);
    const restored = storage.exportGuildData(GUILD);
    expect(restored.delegatedCapabilityGrants).toMatchObject([
      { principalId: ROLE, active: false },
    ]);
    expect(restored.ticketDepartments).toContainEqual(
      expect.objectContaining({
        departmentId: department.departmentId,
        enabled: false,
        bindingsVerifiedAt: null,
      }),
    );
    expect(restored.suggestionConfiguration).toMatchObject({
      enabled: false,
      bindingsVerifiedAt: null,
    });
    expect(restored.applicationForms).toContainEqual(
      expect.objectContaining({
        formId: form.formId,
        enabled: false,
        bindingsVerifiedAt: null,
      }),
    );
  });

  it("rejects format 4 audit histories above the per-record limit", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD);
    const guild = storage.forGuild(GUILD);
    guild.upsertSuggestionConfiguration({
      suggestionChannelId: CHANNEL,
      reviewerRoleId: ROLE,
      enabled: true,
    });
    const suggestion = guild.reserveSuggestion({
      authorId: USER,
      title: "Import bounds",
      details: "Validate per-suggestion event retention.",
    });
    if (suggestion.status !== "created") throw new Error("Expected suggestion");

    const form = guild.createApplicationForm({
      slug: "import-bounds",
      displayName: "Import bounds",
      description: "Validate per-application event retention.",
      reviewerRoleId: ROLE,
      reviewChannelId: LOG_CHANNEL,
    });
    const field = guild.upsertApplicationFormField(form.formId, {
      label: "Reason",
      fieldType: "short",
      required: true,
      minLength: 1,
      maxLength: 100,
    });
    guild.setApplicationFormEnabled(form.formId, true);
    const application = guild.reserveApplication({
      formId: form.formId,
      applicantId: USER,
      responses: [
        {
          fieldId: field.fieldId,
          fieldLabel: field.label,
          fieldType: field.fieldType,
          responseText: "Validate imports.",
          sortOrder: 0,
        },
      ],
    });
    if (application.status !== "created")
      throw new Error("Expected application");

    const payload = storage.exportGuildData(GUILD);
    const suggestionTemplate = payload.suggestionEvents[0]!;
    const applicationTemplate = payload.applicationEvents[0]!;
    const settings = storage.getGuildSettings(GUILD)!;
    expect(() =>
      storage.importGuildData(
        GUILD,
        {
          ...payload,
          suggestionEvents: Array.from({ length: 101 }, (_, index) => ({
            ...suggestionTemplate,
            eventId: `sg_event_${String(index).padStart(3, "0")}`,
            eventNumber: index + 1,
          })),
        },
        settings,
      ),
    ).toThrow(/suggestion can have at most 100 audit events/);
    expect(() =>
      storage.importGuildData(
        GUILD,
        {
          ...payload,
          applicationEvents: Array.from({ length: 101 }, (_, index) => ({
            ...applicationTemplate,
            eventId: `app_evt_${String(index).padStart(3, "0")}`,
            eventNumber: index + 1,
          })),
        },
        settings,
      ),
    ).toThrow(/application can have at most 100 audit events/);
  });
});

function makeStorage(): BotStorage {
  const storage = new BotStorage({ dbFile: ":memory:" });
  storage.initStorage();
  storages.push(storage);
  return storage;
}

function importedTicketEvents(ticketId: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    guildId: GUILD,
    ticketId,
    eventId: `event_${String(index).padStart(4, "0")}`,
    eventNumber: index + 1,
    type: "recovery_noted",
    actorId: ADMIN,
    details: { index },
    createdAt: "2026-01-01T00:00:00.000Z",
  }));
}
