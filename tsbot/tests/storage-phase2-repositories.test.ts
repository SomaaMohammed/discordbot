import { afterEach, describe, expect, it } from "vitest";
import { BotStorage } from "../src/storage/db.js";

const GUILD_A = "111111111111111111";
const GUILD_B = "222222222222222222";
const CATEGORY = "333333333333333333";
const LOG_CHANNEL = "444444444444444444";
const SUPPORT_ROLE = "555555555555555555";
const ACTOR = "666666666666666666";
const MEMBER = "777777777777777777";
const REVIEWER = "888888888888888888";
const OTHER_REVIEWER = "999999999999999999";
const MESSAGE = "101010101010101010";
const SECOND_MESSAGE = "121212121212121212";
const THIRD_MESSAGE = "131313131313131313";

const storages: BotStorage[] = [];

afterEach(() => {
  for (const storage of storages.splice(0)) storage.close();
});

function makeStorage(): BotStorage {
  const storage = new BotStorage({ dbFile: ":memory:" });
  storage.initStorage();
  storage.ensureGuild(GUILD_A);
  storage.ensureGuild(GUILD_B);
  storages.push(storage);
  return storage;
}

function createDepartment(
  storage: BotStorage,
  slug: string,
  sortOrder: number,
) {
  return storage.forGuild(GUILD_A).createTicketDepartment({
    slug,
    displayName: slug.replaceAll("-", " "),
    description: `Requests for ${slug}`,
    categoryId: CATEGORY,
    logChannelId: LOG_CHANNEL,
    supportRoleId: SUPPORT_ROLE,
    enabled: true,
    sortOrder,
  });
}

describe("Phase 2 tenant repositories", () => {
  it("persists active role grants per guild and supports idempotent revocation", () => {
    const storage = makeStorage();
    const a = storage.forGuild(GUILD_A);
    const b = storage.forGuild(GUILD_B);

    expect(
      a.grantRoleCapability(SUPPORT_ROLE, "tickets.manage", ACTOR),
    ).toMatchObject({ status: "granted" });
    expect(
      a.grantRoleCapability(SUPPORT_ROLE, "tickets.manage", ACTOR),
    ).toMatchObject({ status: "duplicate" });
    expect(
      a.grantRoleCapability(REVIEWER, "applications.review", ACTOR),
    ).toMatchObject({ status: "granted" });
    expect(a.listCapabilitiesForRoles([SUPPORT_ROLE])).toHaveLength(1);
    expect(a.listCapabilityGrantsForCapability("tickets.manage")).toEqual([
      expect.objectContaining({
        roleId: SUPPORT_ROLE,
        capability: "tickets.manage",
      }),
    ]);
    expect(
      a.listCapabilityGrantsForCapability("applications.review", 1, 0),
    ).toEqual([
      expect.objectContaining({
        roleId: REVIEWER,
        capability: "applications.review",
      }),
    ]);
    expect(b.listCapabilitiesForRoles([SUPPORT_ROLE])).toEqual([]);
    expect(
      a.revokeRoleCapability(SUPPORT_ROLE, "tickets.manage"),
    ).toMatchObject({ status: "revoked", grant: { active: false } });
    expect(a.revokeRoleCapability(SUPPORT_ROLE, "tickets.manage")).toEqual({
      status: "not-found",
      grant: null,
    });
    expect(
      a.revokeRoleCapability(REVIEWER, "applications.review"),
    ).toMatchObject({ status: "revoked" });
    expect(a.listCapabilityGrants()).toEqual([]);
  });

  it("normalizes Unicode department emoji and rejects malformed saves", () => {
    const storage = makeStorage();
    const guild = storage.forGuild(GUILD_A);
    const department = guild.createTicketDepartment({
      slug: "emoji-support",
      displayName: "Emoji support",
      description: "Validate the department emoji invariant.",
      emoji: "  ❤️  ",
      categoryId: CATEGORY,
      logChannelId: LOG_CHANNEL,
      supportRoleId: SUPPORT_ROLE,
      enabled: false,
      sortOrder: 0,
    });

    expect(department.emoji).toBe("❤️");
    expect(() =>
      guild.updateTicketDepartment(department.departmentId, {
        emoji: "custom-emoji",
      }),
    ).toThrow(/one Unicode emoji/);
    expect(guild.getTicketDepartment(department.departmentId)?.emoji).toBe(
      "❤️",
    );
    expect(() =>
      guild.createTicketDepartment({
        slug: "invalid-emoji",
        displayName: "Invalid emoji",
        description: "This record must not be saved.",
        emoji: ":ticket:",
        enabled: false,
        sortOrder: 1,
      }),
    ).toThrow(/one Unicode emoji/);
    expect(guild.countTicketDepartments()).toBe(1);
  });

  it("stores department form snapshots and enforces ticket concurrency limits", () => {
    const storage = makeStorage();
    const guild = storage.forGuild(GUILD_A);
    const departments = [
      createDepartment(storage, "billing", 0),
      createDepartment(storage, "technical", 1),
      createDepartment(storage, "appeals", 2),
      createDepartment(storage, "partnerships", 3),
    ];
    const billingField = guild.upsertTicketDepartmentField(
      departments[0]!.departmentId,
      {
        label: "Order number",
        fieldType: "short",
        required: true,
        minLength: 2,
        maxLength: 30,
      },
    );

    const first = guild.reserveTicketCreation({
      openerId: MEMBER,
      departmentId: departments[0]!.departmentId,
      subject: "Billing help",
      description: "Please inspect my order.",
      responses: [
        {
          fieldId: billingField.fieldId,
          fieldLabel: "untrusted label",
          fieldType: "paragraph",
          responseText: "AB-123",
          sortOrder: 4,
        },
      ],
    });
    expect(first.status).toBe("created");
    expect(guild.listTicketResponses(first.ticket.ticketId)).toMatchObject([
      {
        fieldId: billingField.fieldId,
        fieldLabel: "Order number",
        fieldType: "short",
        responseText: "AB-123",
        sortOrder: 0,
      },
    ]);
    expect(
      guild.reserveTicketCreation({
        openerId: MEMBER,
        departmentId: departments[0]!.departmentId,
        subject: "Duplicate",
        description: "Same department",
        responses: [
          {
            fieldId: billingField.fieldId,
            fieldLabel: "Order number",
            fieldType: "short",
            responseText: "AB-123",
            sortOrder: 0,
          },
        ],
      }).status,
    ).toBe("existing");

    for (const department of departments.slice(1, 3)) {
      expect(
        guild.reserveTicketCreation({
          openerId: MEMBER,
          departmentId: department.departmentId,
          subject: department.displayName,
          description: "Default response snapshot",
        }).status,
      ).toBe("created");
    }
    const limited = guild.reserveTicketCreation({
      openerId: MEMBER,
      departmentId: departments[3]!.departmentId,
      subject: "Fourth ticket",
      description: "Must hit the guild cap",
    });
    expect(limited).toMatchObject({ status: "limit", activeCount: 3 });
    expect(limited.ticket).toBeTruthy();
    expect(
      guild.deleteTicketDepartment(departments[0]!.departmentId),
    ).toMatchObject({ status: "in-use" });

    for (let index = 0; index < 5; index += 1) {
      guild.upsertTicketDepartmentField(departments[1]!.departmentId, {
        label: `Field ${index + 1}`,
        fieldType: "short",
        sortOrder: index,
      });
    }
    expect(() =>
      guild.upsertTicketDepartmentField(departments[1]!.departmentId, {
        label: "Sixth field",
        fieldType: "short",
      }),
    ).toThrow(/at most 5 fields/);
    for (let index = 4; index < 10; index += 1) {
      createDepartment(storage, `extra-${index}`, index);
    }
    expect(() => createDepartment(storage, "eleventh", 0)).toThrow(
      /at most 10 ticket departments/,
    );
  });

  it("disables every ticket department as one guild-wide operation", () => {
    const storage = makeStorage();
    const guild = storage.forGuild(GUILD_A);
    const first = createDepartment(storage, "billing", 0);
    const second = createDepartment(storage, "technical", 1);
    guild.updateTicketDepartment(first.departmentId, {
      bindingsVerifiedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(guild.disableAllTicketDepartments()).toBe(2);
    expect(guild.getTicketDepartment(first.departmentId)?.enabled).toBe(false);
    expect(
      guild.getTicketDepartment(first.departmentId)?.bindingsVerifiedAt,
    ).toBe("2026-01-01T00:00:00.000Z");
    expect(guild.getTicketDepartment(second.departmentId)?.enabled).toBe(false);
    expect(guild.disableAllTicketDepartments()).toBe(0);
  });

  it("persists suggestion delivery, cooldown, voting, and review transitions", () => {
    const storage = makeStorage();
    const guild = storage.forGuild(GUILD_A);
    expect(() =>
      guild.upsertSuggestionConfiguration({
        suggestionChannelId: LOG_CHANNEL,
        reviewerRoleId: SUPPORT_ROLE,
        cooldownLimit: 11,
      }),
    ).toThrow(/between 1 and 10/);
    guild.upsertSuggestionConfiguration({
      suggestionChannelId: LOG_CHANNEL,
      reviewerRoleId: SUPPORT_ROLE,
      enabled: true,
      cooldownLimit: 2,
      cooldownWindowSeconds: 3_600,
      allowSelfVotes: false,
    });

    const first = guild.reserveSuggestion({
      authorId: MEMBER,
      title: "Add a guide",
      details: "Publish a concise onboarding guide.",
    });
    expect(first.status).toBe("created");
    if (first.status !== "created") throw new Error("Expected suggestion");
    expect(
      guild.bindSuggestionDelivery(first.suggestion.suggestionId, {
        channelId: LOG_CHANNEL,
        messageId: MESSAGE,
        expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
      }).status,
    ).toBe("conflict");
    expect(
      guild.bindSuggestionDelivery(first.suggestion.suggestionId, {
        channelId: LOG_CHANNEL,
        messageId: MESSAGE,
      }).status,
    ).toBe("posted");
    expect(
      guild.toggleSuggestionVote(first.suggestion.suggestionId, MEMBER, 1)
        .status,
    ).toBe("self-vote");
    expect(
      guild.toggleSuggestionVote(first.suggestion.suggestionId, ACTOR, 1)
        .status,
    ).toBe("added");
    expect(
      guild.toggleSuggestionVote(first.suggestion.suggestionId, ACTOR, -1)
        .status,
    ).toBe("switched");
    expect(
      guild.toggleSuggestionVote(first.suggestion.suggestionId, ACTOR, -1)
        .status,
    ).toBe("removed");
    expect(
      guild.reviewSuggestion(first.suggestion.suggestionId, {
        state: "under-review",
        reviewerId: REVIEWER,
        reason: "Assessing effort",
      }).status,
    ).toBe("changed");
    expect(
      guild.reviewSuggestion(first.suggestion.suggestionId, {
        state: "accepted",
        reviewerId: REVIEWER,
        reason: "Approved",
      }).status,
    ).toBe("changed");
    expect(
      guild.reviewSuggestion(first.suggestion.suggestionId, {
        state: "accepted",
        reviewerId: REVIEWER,
        reason: "Approved",
      }).status,
    ).toBe("unchanged");
    expect(
      guild.reviewSuggestion(first.suggestion.suggestionId, {
        state: "declined",
        reviewerId: REVIEWER,
        reason: "Cannot reverse an acceptance",
      }).status,
    ).toBe("unavailable");
    expect(
      guild.reviewSuggestion(first.suggestion.suggestionId, {
        state: "implemented",
        reviewerId: REVIEWER,
        reason: "Shipped",
      }).status,
    ).toBe("changed");
    expect(
      guild.reviewSuggestion(first.suggestion.suggestionId, {
        state: "implemented",
        reviewerId: REVIEWER,
        reason: "Shipped",
      }).status,
    ).toBe("unchanged");

    const second = guild.reserveSuggestion({
      authorId: MEMBER,
      title: "Second idea",
      details: "A second bounded suggestion.",
    });
    expect(second.status).toBe("created");
    if (second.status !== "created") throw new Error("Expected suggestion");
    expect(
      guild.bindSuggestionDelivery(second.suggestion.suggestionId, {
        channelId: LOG_CHANNEL,
        messageId: SECOND_MESSAGE,
      }).status,
    ).toBe("posted");
    expect(
      guild.reviewSuggestion(second.suggestion.suggestionId, {
        state: "declined",
        reviewerId: REVIEWER,
        reason: "Not planned",
      }).status,
    ).toBe("changed");
    expect(
      guild.reviewSuggestion(second.suggestion.suggestionId, {
        state: "accepted",
        reviewerId: REVIEWER,
        reason: "Cannot reverse a decline",
      }).status,
    ).toBe("unavailable");
    expect(
      guild.reserveSuggestion({
        authorId: MEMBER,
        title: "Third idea",
        details: "This one exceeds the persisted cooldown.",
      }).status,
    ).toBe("cooldown");

    const withdrawn = guild.reserveSuggestion({
      authorId: ACTOR,
      title: "Temporary idea",
      details: "This proposal should be withdrawn safely.",
    });
    expect(withdrawn.status).toBe("created");
    if (withdrawn.status !== "created") throw new Error("Expected suggestion");
    expect(
      guild.bindSuggestionDelivery(withdrawn.suggestion.suggestionId, {
        channelId: LOG_CHANNEL,
        messageId: THIRD_MESSAGE,
      }).status,
    ).toBe("posted");
    expect(
      guild.withdrawSuggestion(withdrawn.suggestion.suggestionId, MEMBER)
        .status,
    ).toBe("unavailable");
    expect(
      guild.withdrawSuggestion(withdrawn.suggestion.suggestionId, ACTOR).status,
    ).toBe("changed");
    expect(
      guild.withdrawSuggestion(withdrawn.suggestion.suggestionId, ACTOR).status,
    ).toBe("unchanged");
    expect(
      guild.toggleSuggestionVote(withdrawn.suggestion.suggestionId, REVIEWER, 1)
        .status,
    ).toBe("unavailable");
  });

  it("retains verified suggestion bindings when submissions are disabled", () => {
    const storage = makeStorage();
    const guild = storage.forGuild(GUILD_A);
    const verifiedAt = "2026-01-01T00:00:00.000Z";
    guild.upsertSuggestionConfiguration({
      suggestionChannelId: LOG_CHANNEL,
      reviewerRoleId: SUPPORT_ROLE,
      enabled: true,
      bindingsVerifiedAt: verifiedAt,
    });

    expect(guild.disableSuggestionConfiguration()).toMatchObject({
      enabled: false,
      bindingsVerifiedAt: verifiedAt,
    });
  });

  it("rolls suggestion and application audit histories at 100 events", () => {
    const storage = makeStorage();
    const guild = storage.forGuild(GUILD_A);
    guild.upsertSuggestionConfiguration({
      suggestionChannelId: LOG_CHANNEL,
      reviewerRoleId: SUPPORT_ROLE,
      enabled: true,
    });
    const suggestion = guild.reserveSuggestion({
      authorId: MEMBER,
      title: "Bounded history",
      details: "Keep only the newest audit records.",
    });
    if (suggestion.status !== "created") throw new Error("Expected suggestion");
    for (let index = 0; index < 110; index += 1) {
      guild.appendSuggestionEvent(suggestion.suggestion.suggestionId, {
        type: "recovery_noted",
        details: { index },
      });
    }
    const suggestionEvents = guild.listSuggestionEvents(
      suggestion.suggestion.suggestionId,
      100,
    );
    expect(suggestionEvents).toHaveLength(100);
    expect(suggestionEvents[0]!.eventNumber).toBeGreaterThan(1);
    expect(() =>
      guild.listSuggestionEvents(suggestion.suggestion.suggestionId, 101),
    ).toThrow(/list limit/);

    const form = guild.createApplicationForm({
      slug: "history",
      displayName: "History",
      description: "Exercise bounded application audit history.",
      reviewerRoleId: SUPPORT_ROLE,
      reviewChannelId: LOG_CHANNEL,
    });
    const field = guild.upsertApplicationFormField(form.formId, {
      label: "Reason",
      fieldType: "paragraph",
      required: true,
      minLength: 1,
      maxLength: 100,
    });
    guild.setApplicationFormEnabled(form.formId, true);
    const application = guild.reserveApplication({
      formId: form.formId,
      applicantId: ACTOR,
      responses: [
        {
          fieldId: field.fieldId,
          fieldLabel: field.label,
          fieldType: field.fieldType,
          responseText: "Testing retention.",
          sortOrder: 0,
        },
      ],
    });
    if (application.status !== "created")
      throw new Error("Expected application");
    for (let index = 0; index < 110; index += 1) {
      guild.appendApplicationEvent(application.application.applicationId, {
        type: "recovery_noted",
        details: { index },
      });
    }
    const applicationEvents = guild.listApplicationEvents(
      application.application.applicationId,
      100,
    );
    expect(applicationEvents).toHaveLength(100);
    expect(applicationEvents[0]!.eventNumber).toBeGreaterThan(1);
    expect(guild.listAllApplicationEvents()).toHaveLength(25);
    expect(
      guild.listAllApplicationEvents(10, 90).map((event) => event.eventNumber),
    ).toHaveLength(10);
    expect(() =>
      guild.listApplicationEvents(application.application.applicationId, 101),
    ).toThrow(/List limit/);
  });

  it("keeps application answers private and enforces claim/decision CAS rules", () => {
    const storage = makeStorage();
    const guild = storage.forGuild(GUILD_A);
    expect(() =>
      guild.createApplicationForm({
        slug: "invalid-enabled",
        displayName: "Invalid",
        description: "Cannot start enabled without fields.",
        reviewerRoleId: SUPPORT_ROLE,
        reviewChannelId: LOG_CHANNEL,
        enabled: true,
      }),
    ).toThrow(/disabled/);
    const form = guild.createApplicationForm({
      slug: "moderator",
      displayName: "Moderator",
      description: "Apply to join the moderation team.",
      reviewerRoleId: SUPPORT_ROLE,
      reviewChannelId: LOG_CHANNEL,
    });
    const field = guild.upsertApplicationFormField(form.formId, {
      label: "Why should we choose you?",
      fieldType: "paragraph",
      required: true,
      minLength: 10,
      maxLength: 500,
    });
    guild.setApplicationFormEnabled(form.formId, true);

    const reserved = guild.reserveApplication({
      formId: form.formId,
      applicantId: MEMBER,
      responses: [
        {
          fieldId: field.fieldId,
          fieldLabel: "forged",
          fieldType: "short",
          responseText: "I have extensive moderation experience.",
          sortOrder: 4,
        },
      ],
    });
    expect(reserved.status).toBe("created");
    if (reserved.status !== "created") throw new Error("Expected application");
    expect(
      guild.listApplicationResponses(reserved.application.applicationId),
    ).toMatchObject([
      {
        fieldLabel: "Why should we choose you?",
        fieldType: "paragraph",
        sortOrder: 0,
      },
    ]);
    expect(
      guild.reserveApplication({
        formId: form.formId,
        applicantId: MEMBER,
        responses: [
          {
            fieldId: field.fieldId,
            fieldLabel: field.label,
            fieldType: field.fieldType,
            responseText: "Another long enough response.",
            sortOrder: 0,
          },
        ],
      }).status,
    ).toBe("existing");
    expect(
      guild.bindApplicationDelivery(reserved.application.applicationId, {
        reviewChannelId: LOG_CHANNEL,
        reviewMessageId: MESSAGE,
        expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
      }).status,
    ).toBe("conflict");
    expect(
      guild.bindApplicationDelivery(reserved.application.applicationId, {
        reviewChannelId: LOG_CHANNEL,
        reviewMessageId: MESSAGE,
      }).status,
    ).toBe("posted");
    expect(
      guild.claimApplication(reserved.application.applicationId, REVIEWER)
        .status,
    ).toBe("changed");
    expect(
      guild.decideApplication(reserved.application.applicationId, {
        state: "accepted",
        reviewerId: OTHER_REVIEWER,
        reason: "Should conflict",
      }).status,
    ).toBe("conflict");
    expect(
      guild.decideApplication(reserved.application.applicationId, {
        state: "accepted",
        reviewerId: REVIEWER,
        reason: "Strong application",
      }).status,
    ).toBe("changed");
    expect(guild.getApplicationByNumber(1)).toMatchObject({
      state: "accepted",
      decisionBy: REVIEWER,
    });
    expect(guild.deleteApplicationForm(form.formId)).toMatchObject({
      status: "in-use",
    });
    expect(() =>
      guild.removeApplicationFormField(form.formId, field.fieldId),
    ).toThrow(/retain at least one field/);
  });

  it("allows only the applicant to withdraw pending applications idempotently", () => {
    const storage = makeStorage();
    const guild = storage.forGuild(GUILD_A);
    const form = guild.createApplicationForm({
      slug: "withdrawals",
      displayName: "Withdrawals",
      description: "Exercise private application withdrawal boundaries.",
      reviewerRoleId: SUPPORT_ROLE,
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
    const reserve = () =>
      guild.reserveApplication({
        formId: form.formId,
        applicantId: MEMBER,
        responses: [
          {
            fieldId: field.fieldId,
            fieldLabel: field.label,
            fieldType: field.fieldType,
            responseText: "A private response.",
            sortOrder: 0,
          },
        ],
      });

    const pending = reserve();
    if (pending.status !== "created") throw new Error("Expected application");
    expect(
      guild.withdrawApplication(pending.application.applicationId, ACTOR),
    ).toMatchObject({
      status: "conflict",
      application: { state: "submitted" },
    });
    expect(
      guild.withdrawApplication(pending.application.applicationId, MEMBER),
    ).toMatchObject({ status: "changed", application: { state: "withdrawn" } });
    expect(
      guild.withdrawApplication(pending.application.applicationId, MEMBER),
    ).toMatchObject({
      status: "unchanged",
      application: { state: "withdrawn" },
    });
    expect(
      guild
        .listApplicationEvents(pending.application.applicationId, 100)
        .filter((event) => event.type === "withdrawn"),
    ).toHaveLength(1);

    const decided = reserve();
    if (decided.status !== "created") throw new Error("Expected application");
    expect(
      guild.bindApplicationDelivery(decided.application.applicationId, {
        reviewChannelId: LOG_CHANNEL,
        reviewMessageId: SECOND_MESSAGE,
      }).status,
    ).toBe("posted");
    expect(
      guild.claimApplication(decided.application.applicationId, REVIEWER)
        .status,
    ).toBe("changed");
    expect(
      guild.decideApplication(decided.application.applicationId, {
        state: "accepted",
        reviewerId: REVIEWER,
        reason: "Approved",
      }).status,
    ).toBe("changed");
    expect(
      guild.withdrawApplication(decided.application.applicationId, MEMBER),
    ).toMatchObject({
      status: "unavailable",
      application: { state: "accepted" },
    });
  });
});
