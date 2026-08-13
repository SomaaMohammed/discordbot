import { afterEach, describe, expect, it } from "vitest";
import { BotStorage, GuildSettingsConflictError } from "../src/storage/db.js";
import { createDefaultLegacyGuildSettingsV2 } from "../src/storage/guild-settings-v2.js";
import type { UserMetrics } from "../src/types.js";

const GUILD_A = "111111111111111111";
const GUILD_B = "222222222222222222";
const USER_A = "333333333333333333";
const USER_B = "444444444444444444";
const storages: BotStorage[] = [];

afterEach(() => {
  for (const storage of storages.splice(0)) {
    storage.close();
  }
});

describe("active guild storage", () => {
  it("starts active with neutral v3 defaults and reverses the emergency switch", () => {
    const storage = makeStorage();
    const created = storage.ensureGuild(GUILD_A, "Fresh guild");

    expect(created).toMatchObject({ enabled: true, leftAt: null });
    expect(storage.getGuildSettings(GUILD_A)).toEqual({
      version: 3,
      enabled: true,
      timezone: "UTC",
      channels: { log: null },
      invocation: { keyword: "superior", aliases: [] },
      limits: { bulkModerationTargetCap: 100 },
      greetings: [{ name: "Welcome", message: "Welcome, {user}!" }],
    });

    expect(storage.setGuildEnabled(GUILD_A, false)).toMatchObject({
      enabled: false,
    });
    expect(storage.getGuild(GUILD_A)).toMatchObject({ enabled: false });
    const disabledExpectation = storage.getGuildEnableExpectation(GUILD_A)!;
    expect(
      storage.setGuildEnabled(GUILD_A, true, disabledExpectation),
    ).toMatchObject({ enabled: true });
    expect(storage.getGuild(GUILD_A)).toMatchObject({
      enabled: true,
      leftAt: null,
    });
  });

  it("isolates lifecycle and settings by exact guild ID", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD_A, "A");
    storage.ensureGuild(GUILD_B, "B");

    const a = storage.getGuildSettings(GUILD_A)!;
    a.invocation.aliases = ["helper bot"];
    storage.saveGuildSettings(GUILD_A, a);

    expect(storage.getGuildSettings(GUILD_A)?.invocation.aliases).toEqual([
      "helper bot",
    ]);
    expect(storage.getGuildSettings(GUILD_B)?.invocation.aliases).toEqual([]);

    const expectation = storage.getGuildEnableExpectation(GUILD_A)!;
    expect(storage.setGuildEnabled(GUILD_A, true, expectation).enabled).toBe(
      true,
    );
    storage.setGuildEnabled(GUILD_B, false);
    expect(storage.listEnabledGuilds().map((row) => row.guildId)).toEqual([
      GUILD_A,
    ]);

    storage.markGuildLeft(GUILD_A);
    expect(storage.getGuild(GUILD_A)).toMatchObject({
      enabled: false,
    });
    expect(storage.getGuild(GUILD_A)?.leftAt).not.toBeNull();
    const rejoined = storage.reactivateGuild(GUILD_A, "A again");
    expect(rejoined).toMatchObject({ enabled: true, leftAt: null });
    expect(storage.getGuildSettings(GUILD_A)?.invocation.aliases).toEqual([
      "helper bot",
    ]);
  });

  it("uses compare-and-swap writes without disabling unrelated behavior", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD_A);
    const original = storage.getGuildSettings(GUILD_A)!;
    const changed = structuredClone(original);
    changed.timezone = "Asia/Amman";
    storage.saveGuildSettings(GUILD_A, changed, original);

    expect(() =>
      storage.saveGuildSettings(GUILD_A, original, original),
    ).toThrow(GuildSettingsConflictError);

    const exported = storage.exportGuildData(GUILD_A);
    const imported = storage.importGuildData(
      GUILD_A,
      exported,
      storage.getGuildSettings(GUILD_A)!,
    );
    expect(imported).toMatchObject({ enabled: true });

    const reviewExpectation = storage.getGuildEnableExpectation(GUILD_A)!;
    const enabled = storage.setGuildEnabled(GUILD_A, true, reviewExpectation);
    expect(enabled).toMatchObject({ enabled: true });

    const edited = structuredClone(enabled);
    edited.timezone = "UTC";
    expect(storage.saveGuildSettings(GUILD_A, edited, enabled)).toMatchObject({
      enabled: true,
    });
    expect(storage.getGuild(GUILD_A)?.enabled).toBe(true);
  });

  it("stores command and user metrics per tenant", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD_A);
    storage.ensureGuild(GUILD_B);
    const a = storage.forGuild(GUILD_A);
    const b = storage.forGuild(GUILD_B);

    a.recordCommandMetric("superior.purge", false);
    for (const metric of [
      "access.grant",
      "application.submit",
      "suggestion.configure",
    ]) {
      expect(() => a.recordCommandMetric(metric)).not.toThrow();
    }
    a.incrementUserMetric(USER_A, "messages_sent", 4);
    a.incrementUserMetric(USER_B, "messages_sent", 2);
    b.incrementUserMetric(USER_A, "messages_sent", 9);

    expect(a.getUserMetrics(USER_A).messages_sent).toBe(4);
    expect(b.getUserMetrics(USER_A).messages_sent).toBe(9);
    expect(a.getUserLeaderboard("messages_sent", 10)).toEqual([
      { userId: USER_A, value: 4 },
      { userId: USER_B, value: 2 },
    ]);
    expect(a.metricsGet("command_usage.superior.purge", "0")).toBe("1");
    expect(a.metricsGet("command_failures.superior.purge", "0")).toBe("1");
    expect(a.metricsGet("command_usage.access.grant", "0")).toBe("1");
    expect(a.metricsGet("command_usage.application.submit", "0")).toBe("1");
    expect(a.metricsGet("command_usage.suggestion.configure", "0")).toBe("1");
    expect(b.metricsGet("command_usage.superior.purge", "0")).toBe("0");
  });

  it("transactionally replaces activity metrics without duplicating backfills", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD_A);
    const guild = storage.forGuild(GUILD_A);
    guild.recordCommandMetric("utility.ping");
    guild.setUserMetric(USER_A, "battles_won", 99);

    const replacements = [
      { userId: USER_A, metrics: userMetrics({ messages_sent: 7 }) },
      { userId: USER_B, metrics: userMetrics({ reactions_sent: 3 }) },
    ];
    guild.replaceUserActivityMetrics(replacements);
    guild.replaceUserActivityMetrics(replacements);

    expect(guild.getUserMetrics(USER_A)).toEqual(
      userMetrics({ messages_sent: 7, battles_won: 99 }),
    );
    expect(guild.getUserMetrics(USER_B)).toEqual(
      userMetrics({ reactions_sent: 3 }),
    );
    expect(guild.metricsGet("command_usage.utility.ping", "0")).toBe("1");
  });

  it("exports/imports only active same-guild data and purges atomically", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD_A);
    storage.ensureGuild(GUILD_B);
    storage
      .forGuild(GUILD_A)
      .incrementUserMetric(USER_A, "reactions_received", 5);
    const guild = storage.forGuild(GUILD_A);
    guild.upsertTicketConfiguration({
      categoryId: "555555555555555555",
      logChannelId: "666666666666666666",
      supportRoleId: "777777777777777777",
    });
    guild.createPostedPanel({
      panelId: "panel_A1",
      preset: "resources",
      channelId: "888888888888888888",
      messageId: "999999999999999999",
      configuration: { title: "Rules" },
    });
    const reservation = guild.reserveTicketCreation({
      openerId: USER_B,
      subject: "Portable ticket",
      description: "Include operational rows in the tenant export.",
    });
    const phase2A = seedPhase2Data(storage, GUILD_A, {
      managerRoleId: "101010101010101010",
      actorId: "121212121212121212",
      suggestionChannelId: "131313131313131313",
      reviewerRoleId: "141414141414141414",
      suggestionAuthorId: "151515151515151515",
      suggestionVoterId: "161616161616161616",
      suggestionMessageId: "171717171717171717",
      applicationChannelId: "181818181818181818",
      applicantId: "191919191919191919",
      applicationMessageId: "202020202020202020",
    });
    seedPhase2Data(storage, GUILD_B, {
      managerRoleId: "212121212121212121",
      actorId: "232323232323232323",
      suggestionChannelId: "242424242424242424",
      reviewerRoleId: "252525252525252525",
      suggestionAuthorId: "262626262626262626",
      suggestionVoterId: "272727272727272727",
      suggestionMessageId: "282828282828282828",
      applicationChannelId: "292929292929292929",
      applicantId: "303030303030303030",
      applicationMessageId: "313131313131313131",
    });
    const restrictedA = seedRestrictedPingData(storage, GUILD_A, {
      roleId: "323232323232323232",
      channelId: "343434343434343434",
      actorId: "353535353535353535",
      userId: "363636363636363636",
      messageId: "373737373737373737",
    });
    seedRestrictedPingData(storage, GUILD_B, {
      roleId: "383838383838383838",
      channelId: "393939393939393939",
      actorId: "404040404040404040",
      userId: "414141414141414141",
      messageId: "424242424242424242",
    });
    const guildBCountsBefore = storage.previewGuildPurge(GUILD_B);
    const payload = storage.exportGuildData(GUILD_A);

    expect(payload).toMatchObject({
      formatVersion: 6,
      guildId: GUILD_A,
      metrics: [
        {
          key: `user_stats.${USER_A}.reactions_received`,
          value: 5,
        },
      ],
      ticketDepartments: [{ guildId: GUILD_A, enabled: true }],
      postedPanels: [
        {
          guildId: GUILD_A,
          panelId: "panel_A1",
          configuration: { title: "Rules" },
        },
      ],
      tickets: [{ ticketId: reservation.ticket.ticketId, state: "creating" }],
      ticketEvents: [{ type: "creation_reserved" }],
      delegatedCapabilityGrants: [
        {
          capability: "suggestions.review",
          principalId: "101010101010101010",
          active: true,
        },
      ],
      suggestionConfiguration: {
        enabled: true,
        suggestionChannelId: "131313131313131313",
      },
      suggestions: [
        {
          suggestionId: phase2A.suggestionId,
          title: "Tenant suggestion",
        },
      ],
      suggestionVotes: [
        {
          suggestionId: phase2A.suggestionId,
          voterId: "161616161616161616",
          vote: 1,
        },
      ],
      applicationForms: [{ formId: phase2A.formId, slug: "tenant-staff" }],
      applications: [
        {
          applicationId: phase2A.applicationId,
          formId: phase2A.formId,
        },
      ],
      applicationResponses: [
        {
          applicationId: phase2A.applicationId,
          responseText: "A private tenant application answer.",
        },
      ],
      restrictedPingRoles: [
        {
          roleId: restrictedA.roleId,
          enabled: true,
          successCount: 1,
        },
      ],
      restrictedPingMappings: [
        {
          roleId: restrictedA.roleId,
          channelId: restrictedA.channelId,
        },
      ],
      restrictedPingUserCooldowns: [
        {
          roleId: restrictedA.roleId,
          userId: restrictedA.userId,
          successCount: 1,
        },
      ],
    });
    expect(payload.delegatedCapabilityGrants[0]).not.toHaveProperty("userId");
    const invalidGreetingPayload = structuredClone(payload);
    invalidGreetingPayload.settings.greetings = [
      { name: "Too long", message: "{user}".repeat(87) },
    ];
    const settingsBeforeInvalidImport = storage.getGuildSettings(GUILD_A)!;
    expect(() =>
      storage.importGuildData(
        GUILD_A,
        invalidGreetingPayload,
        settingsBeforeInvalidImport,
      ),
    ).toThrow(/render to at most 2000 Discord characters/);
    expect(storage.getGuildSettings(GUILD_A)).toEqual(
      settingsBeforeInvalidImport,
    );
    const controlCharacterPayload = structuredClone(payload);
    controlCharacterPayload.tickets[0]!.subject = "Unsafe\u0007 subject";
    expect(() =>
      storage.importGuildData(
        GUILD_A,
        controlCharacterPayload,
        storage.getGuildSettings(GUILD_A)!,
      ),
    ).toThrow(/ticket subject cannot contain control characters/);
    expect(guild.getTicketById(reservation.ticket.ticketId)).toMatchObject({
      subject: "Portable ticket",
    });
    const missingTicketDepartment = structuredClone(payload);
    missingTicketDepartment.ticketDepartments = [];
    expect(() =>
      storage.importGuildData(
        GUILD_A,
        missingTicketDepartment,
        storage.getGuildSettings(GUILD_A)!,
      ),
    ).toThrow(/unknown department/);
    expect(guild.getTicketConfiguration()).toMatchObject({ enabled: true });
    expect(() =>
      storage.importGuildData(
        GUILD_B,
        payload,
        storage.getGuildSettings(GUILD_B)!,
      ),
    ).toThrow(/current guild/);

    guild.disableTicketConfiguration();
    guild.deletePostedPanel("panel_A1");
    guild.failTicketCreation(reservation.ticket.ticketId, "temporary mutation");
    storage.importGuildData(
      GUILD_A,
      payload,
      storage.getGuildSettings(GUILD_A)!,
    );
    expect(guild.getTicketConfiguration()).toMatchObject({ enabled: false });
    expect(guild.findPostedPanelByToken("panel_A1")).toMatchObject({
      configuration: { title: "Rules" },
    });
    expect(guild.getTicketById(reservation.ticket.ticketId)).toMatchObject({
      state: "creating",
      failureReason: null,
    });
    expect(guild.listTicketEvents(reservation.ticket.ticketId)).toHaveLength(1);

    const importedPhase2 = storage.exportGuildData(GUILD_A);
    expect(importedPhase2.delegatedCapabilityGrants).toEqual([
      expect.objectContaining({
        principalId: "101010101010101010",
        active: false,
      }),
    ]);
    expect(importedPhase2.suggestionConfiguration).toMatchObject({
      enabled: false,
      bindingsVerifiedAt: null,
    });
    expect(importedPhase2.suggestions).toHaveLength(1);
    expect(importedPhase2.suggestionVotes).toHaveLength(1);
    expect(importedPhase2.suggestionEvents.length).toBeGreaterThan(0);
    expect(importedPhase2.applicationForms).toEqual([
      expect.objectContaining({
        formId: phase2A.formId,
        enabled: false,
        bindingsVerifiedAt: null,
      }),
    ]);
    expect(importedPhase2.applications).toHaveLength(1);
    expect(importedPhase2.applicationResponses).toHaveLength(1);
    expect(importedPhase2.applicationEvents.length).toBeGreaterThan(0);
    expect(importedPhase2.restrictedPingRoles).toEqual([
      expect.objectContaining({
        roleId: restrictedA.roleId,
        enabled: false,
        bindingsVerifiedAt: null,
        successCount: 1,
      }),
    ]);
    expect(importedPhase2.restrictedPingMappings).toHaveLength(1);
    expect(importedPhase2.restrictedPingUserCooldowns).toEqual([
      expect.objectContaining({ userId: restrictedA.userId, successCount: 1 }),
    ]);
    expect(importedPhase2.restrictedPingEvents).toHaveLength(2);

    const legacyV2Payload = {
      formatVersion: 2,
      guildId: payload.guildId,
      exportedAt: payload.exportedAt,
      metadata: payload.metadata,
      settings: createDefaultLegacyGuildSettingsV2(),
      metrics: payload.metrics,
    };
    storage.importGuildData(
      GUILD_A,
      legacyV2Payload,
      storage.getGuildSettings(GUILD_A)!,
    );
    expect(guild.getTicketConfiguration()).toMatchObject({ enabled: false });
    expect(guild.findPostedPanelByToken("panel_A1")).not.toBeNull();
    expect(guild.getTicketById(reservation.ticket.ticketId)).toMatchObject({
      state: "creating",
      failureReason: null,
    });
    expect(guild.listTicketEvents(reservation.ticket.ticketId)).toHaveLength(1);

    const expectedPurge = {
      guildId: GUILD_A,
      guilds: 1,
      settings: 1,
      metrics: 1,
      delegatedCapabilityGrants:
        importedPhase2.delegatedCapabilityGrants.length,
      ticketDepartments: 1,
      ticketDepartmentFields: 0,
      postedPanels: 1,
      tickets: 1,
      ticketFormResponses: 2,
      ticketEvents: 1,
      suggestionConfigurations: importedPhase2.suggestionConfiguration ? 1 : 0,
      suggestions: importedPhase2.suggestions.length,
      suggestionVotes: importedPhase2.suggestionVotes.length,
      suggestionEvents: importedPhase2.suggestionEvents.length,
      applicationForms: importedPhase2.applicationForms.length,
      applicationFormFields: importedPhase2.applicationFormFields.length,
      applications: importedPhase2.applications.length,
      applicationResponses: importedPhase2.applicationResponses.length,
      applicationEvents: importedPhase2.applicationEvents.length,
      restrictedPingRoles: importedPhase2.restrictedPingRoles.length,
      restrictedPingMappings: importedPhase2.restrictedPingMappings.length,
      restrictedPingUserCooldowns:
        importedPhase2.restrictedPingUserCooldowns.length,
      restrictedPingEvents: importedPhase2.restrictedPingEvents.length,
      mudaeWatchDeliveries: 0,
    };
    expect(storage.previewGuildPurge(GUILD_A)).toEqual(expectedPurge);
    expect(storage.purgeGuildData(GUILD_A)).toEqual(expectedPurge);
    expect(storage.getGuild(GUILD_A)).toBeNull();
    expect(storage.getGuild(GUILD_B)).not.toBeNull();
    expect(storage.previewGuildPurge(GUILD_B)).toEqual(guildBCountsBefore);
  });
});

function seedPhase2Data(
  storage: BotStorage,
  guildId: string,
  ids: {
    managerRoleId: string;
    actorId: string;
    suggestionChannelId: string;
    reviewerRoleId: string;
    suggestionAuthorId: string;
    suggestionVoterId: string;
    suggestionMessageId: string;
    applicationChannelId: string;
    applicantId: string;
    applicationMessageId: string;
  },
) {
  const guild = storage.forGuild(guildId);
  const grant = guild.grantRoleCapability(
    ids.managerRoleId,
    "suggestions.review",
    ids.actorId,
  );
  if (grant.status !== "granted") throw new Error("Expected capability grant");

  guild.upsertSuggestionConfiguration({
    enabled: true,
    suggestionChannelId: ids.suggestionChannelId,
    reviewerRoleId: ids.reviewerRoleId,
  });
  const suggestion = guild.reserveSuggestion({
    authorId: ids.suggestionAuthorId,
    title: "Tenant suggestion",
    details: "Preserve this guild-scoped suggestion and its vote.",
  });
  if (suggestion.status !== "created") throw new Error("Expected suggestion");
  guild.bindSuggestionDelivery(suggestion.suggestion.suggestionId, {
    channelId: ids.suggestionChannelId,
    messageId: ids.suggestionMessageId,
  });
  guild.toggleSuggestionVote(
    suggestion.suggestion.suggestionId,
    ids.suggestionVoterId,
    1,
  );
  guild.appendSuggestionEvent(suggestion.suggestion.suggestionId, {
    type: "recovery_noted",
    details: { source: "multitenancy-test" },
  });

  const form = guild.createApplicationForm({
    slug: "tenant-staff",
    displayName: "Tenant Staff",
    description: "Preserve this guild-scoped private application form.",
    reviewerRoleId: ids.reviewerRoleId,
    reviewChannelId: ids.applicationChannelId,
  });
  const field = guild.upsertApplicationFormField(form.formId, {
    label: "Why do you want to help?",
    fieldType: "paragraph",
    required: true,
    minLength: 1,
    maxLength: 500,
  });
  guild.setApplicationFormEnabled(form.formId, true);
  const application = guild.reserveApplication({
    formId: form.formId,
    applicantId: ids.applicantId,
    responses: [
      {
        fieldId: field.fieldId,
        fieldLabel: field.label,
        fieldType: field.fieldType,
        responseText: "A private tenant application answer.",
        sortOrder: field.sortOrder,
      },
    ],
  });
  if (application.status !== "created") throw new Error("Expected application");
  guild.bindApplicationDelivery(application.application.applicationId, {
    reviewChannelId: ids.applicationChannelId,
    reviewMessageId: ids.applicationMessageId,
  });
  guild.appendApplicationEvent(application.application.applicationId, {
    type: "recovery_noted",
    details: { source: "multitenancy-test" },
  });

  return {
    suggestionId: suggestion.suggestion.suggestionId,
    formId: form.formId,
    applicationId: application.application.applicationId,
  };
}

function seedRestrictedPingData(
  storage: BotStorage,
  guildId: string,
  ids: {
    roleId: string;
    channelId: string;
    actorId: string;
    userId: string;
    messageId: string;
  },
) {
  const guild = storage.forGuild(guildId);
  const mapping = guild.addRestrictedPingMapping({
    roleId: ids.roleId,
    channelId: ids.channelId,
    createdBy: ids.actorId,
    enabled: true,
    userCooldownSeconds: 60,
    roleCooldownSeconds: 0,
    bindingsVerifiedAt: "2026-01-01T00:00:00.000Z",
  });
  if (mapping.status !== "created") {
    throw new Error("Expected restricted ping mapping");
  }
  const reservation = guild.reserveRestrictedPing({
    roleId: ids.roleId,
    userId: ids.userId,
    channelId: ids.channelId,
    mappingChannelId: ids.channelId,
    source: "pingrole",
  });
  if (reservation.status !== "reserved") {
    throw new Error("Expected restricted ping reservation");
  }
  const completion = guild.completeRestrictedPing(
    reservation.reservationId,
    ids.messageId,
  );
  if (completion.status !== "completed") {
    throw new Error("Expected restricted ping completion");
  }
  return ids;
}

function makeStorage(): BotStorage {
  const storage = new BotStorage({ dbFile: ":memory:" });
  storage.initStorage();
  storages.push(storage);
  return storage;
}

function userMetrics(overrides: Partial<UserMetrics> = {}): UserMetrics {
  return {
    messages_sent: 0,
    reactions_sent: 0,
    reactions_received: 0,
    battles_played: 0,
    battles_won: 0,
    ...overrides,
  };
}
