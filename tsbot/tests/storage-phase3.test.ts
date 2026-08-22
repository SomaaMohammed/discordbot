import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { BotStorage, type GuildStorage } from "../src/storage/db.js";
import { readPhase3GuildData } from "../src/storage/guild-data-v7.js";
import type { DeliveryClaimResult, GuildDataExport } from "../src/types.js";

const GUILD_A = "111111111111111111";
const GUILD_B = "222222222222222222";
const ACTOR = "333333333333333333";
const TARGET = "444444444444444444";
const OTHER_TARGET = "555555555555555555";
const REPORTER = "666666666666666666";
const REVIEWER = "777777777777777777";
const REVIEW_CHANNEL = "888888888888888888";
const REVIEW_ROLE = "999999999999999999";
const LOG_CHANNEL = "900000000000000001";
const EXEMPT_ROLE = "900000000000000002";
const EXEMPT_CHANNEL = "900000000000000003";
const VERIFIED_AT = "2026-08-13T00:00:00.000Z";
const roots: string[] = [];
const openStorages: BotStorage[] = [];

afterEach(() => {
  for (const storage of openStorages.splice(0)) storage.close();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Phase 3 guild storage", () => {
  it("persists two-phase cases and atomically completes timeout pairs", () => {
    const { storage } = createStorage("cases");
    const guild = storage.forGuild(GUILD_A);

    const attempt = guild.reserveModerationCaseAttempt({
      targetUserId: TARGET,
      actorId: ACTOR,
      actionType: "kick",
      source: "moderation-command",
      publicReason: "Repeated disruptive behavior.",
      privateNote: "Internal context stays private.",
    });
    expect(attempt.status).toBe("failed");
    expect(guild.getModerationLogDelivery(attempt.caseId)).toBeNull();
    expect(
      guild.confirmModerationCase(attempt.caseId, {
        actorId: ACTOR,
        status: "completed",
        expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
      }).status,
    ).toBe("conflict");
    expect(
      guild.failModerationCaseAttempt(attempt.caseId, {
        actorId: ACTOR,
        failureCode: "discord-timeout",
        expectedUpdatedAt: attempt.updatedAt,
      }).status,
    ).toBe("changed");
    const confirmed = guild.confirmModerationCase(attempt.caseId, {
      actorId: ACTOR,
      status: "completed",
      discordActionMetadata: { auditLogReasonSet: true },
      expectedUpdatedAt: attempt.updatedAt,
    });
    expect(confirmed).toMatchObject({
      status: "changed",
      case: { status: "completed" },
    });
    expect(guild.getModerationLogDelivery(attempt.caseId)?.state).toBe(
      "pending",
    );
    expect(
      guild.listModerationCaseEvents(attempt.caseId).map((event) => event.type),
    ).toEqual(["action-reserved", "action-failed", "action-confirmed"]);

    const original = guild.createModerationCase({
      targetUserId: TARGET,
      actorId: ACTOR,
      actionType: "timeout",
      source: "moderation-command",
      publicReason: "Temporary timeout while the incident is reviewed.",
      status: "active",
    });
    const removal = guild.reserveModerationCaseAttempt({
      targetUserId: TARGET,
      actorId: ACTOR,
      actionType: "timeout-removed",
      source: "moderation-command",
      publicReason: "Timeout removed after review.",
      relatedCaseId: original.caseId,
    });
    expect(
      guild.finalizeTimeoutRemovalCase(removal.caseId, {
        actorId: ACTOR,
        originalCaseId: original.caseId,
        removalExpectedUpdatedAt: removal.updatedAt,
        originalExpectedUpdatedAt: "2000-01-01T00:00:00.000Z",
      }).status,
    ).toBe("conflict");
    expect(guild.getModerationCaseById(removal.caseId)?.status).toBe("failed");
    expect(guild.getModerationCaseById(original.caseId)?.status).toBe("active");

    const finalized = guild.finalizeTimeoutRemovalCase(removal.caseId, {
      actorId: ACTOR,
      originalCaseId: original.caseId,
      discordActionMetadata: { removed: true },
      removalExpectedUpdatedAt: removal.updatedAt,
      originalExpectedUpdatedAt: original.updatedAt,
    });
    expect(finalized).toMatchObject({
      status: "changed",
      removalCase: { status: "completed", relatedCaseId: original.caseId },
      originalCase: { status: "completed", relatedCaseId: removal.caseId },
    });
    expect(
      guild.finalizeTimeoutRemovalCase(removal.caseId, {
        actorId: ACTOR,
        originalCaseId: original.caseId,
        removalExpectedUpdatedAt: removal.updatedAt,
        originalExpectedUpdatedAt: original.updatedAt,
      }).status,
    ).toBe("unchanged");

    const ban = guild.createModerationCase({
      targetUserId: OTHER_TARGET,
      actorId: ACTOR,
      actionType: "ban",
      source: "moderation-command",
      publicReason: "Ban awaiting an authorized reversal.",
      status: "active",
    });
    const unban = guild.reserveModerationCaseAttempt({
      targetUserId: OTHER_TARGET,
      actorId: ACTOR,
      actionType: "unban",
      source: "moderation-command",
      publicReason: "Authorized ban reversal.",
      relatedCaseId: ban.caseId,
    });
    expect(
      guild.finalizeBanRemovalCase(unban.caseId, {
        actorId: ACTOR,
        originalCaseId: ban.caseId,
        removalExpectedUpdatedAt: unban.updatedAt,
        originalExpectedUpdatedAt: "2000-01-01T00:00:00.000Z",
      }).status,
    ).toBe("conflict");
    expect(guild.getModerationCaseById(unban.caseId)?.status).toBe("failed");
    expect(guild.getModerationCaseById(ban.caseId)?.status).toBe("active");
    expect(
      storage.forGuild(GUILD_B).finalizeBanRemovalCase(unban.caseId, {
        actorId: ACTOR,
        originalCaseId: ban.caseId,
      }).status,
    ).toBe("not-found");
    const finalizedBan = guild.finalizeBanRemovalCase(unban.caseId, {
      actorId: ACTOR,
      originalCaseId: ban.caseId,
      discordActionMetadata: { unbanConfirmed: true },
      removalExpectedUpdatedAt: unban.updatedAt,
      originalExpectedUpdatedAt: ban.updatedAt,
    });
    expect(finalizedBan).toMatchObject({
      status: "changed",
      removalCase: { status: "completed", relatedCaseId: ban.caseId },
      originalCase: { status: "completed", relatedCaseId: unban.caseId },
    });
    expect(
      guild.finalizeBanRemovalCase(unban.caseId, {
        actorId: ACTOR,
        originalCaseId: ban.caseId,
        removalExpectedUpdatedAt: unban.updatedAt,
        originalExpectedUpdatedAt: ban.updatedAt,
      }).status,
    ).toBe("unchanged");
    storage.close();
  });

  it("finds active sanctions without client caps and completes natural timeout expiry", () => {
    const { storage } = createStorage("active-sanction-lookup");
    const guild = storage.forGuild(GUILD_A);
    configure(guild);
    const ban = guild.createModerationCase({
      targetUserId: TARGET,
      actorId: ACTOR,
      actionType: "ban",
      source: "moderation-command",
      publicReason: "An active ban older than the generic history window.",
      status: "active",
    });
    for (let index = 0; index < 100; index += 1) {
      guild.createModerationCase({
        targetUserId: TARGET,
        actorId: ACTOR,
        actionType: "warning",
        source: "moderation-command",
        publicReason: `Newer warning ${index + 1}.`,
        status: "active",
      });
    }
    expect(guild.findUniqueActiveModerationCase(TARGET, ["ban"])).toEqual({
      status: "found",
      case: ban,
    });
    expect(
      guild.listModerationCases({
        targetUserId: TARGET,
        statuses: ["active"],
        actionTypes: ["ban"],
        limit: 100,
      }),
    ).toEqual([ban]);
    expect(
      storage.forGuild(GUILD_B).findUniqueActiveModerationCase(TARGET, ["ban"]),
    ).toEqual({ status: "none", case: null });
    guild.createModerationCase({
      targetUserId: TARGET,
      actorId: ACTOR,
      actionType: "ban",
      source: "moderation-command",
      publicReason: "A second active ban makes recovery selection ambiguous.",
      status: "active",
    });
    expect(guild.findUniqueActiveModerationCase(TARGET, ["ban"])).toEqual({
      status: "ambiguous",
      case: null,
    });
    expect(() => guild.findUniqueActiveModerationCase(TARGET, [])).toThrow(
      /At least one moderation action type/,
    );
    const failedUnban = guild.reserveModerationCaseAttempt({
      targetUserId: TARGET,
      actorId: ACTOR,
      actionType: "unban",
      source: "moderation-command",
      publicReason:
        "A failed linked unban checkpoint older than later failures.",
      relatedCaseId: ban.caseId,
    });
    for (let index = 0; index < 100; index += 1) {
      guild.reserveModerationCaseAttempt({
        targetUserId: TARGET,
        actorId: ACTOR,
        actionType: "kick",
        source: "moderation-command",
        publicReason: `Newer unrelated failed action ${index + 1}.`,
      });
    }
    expect(
      guild.findUniqueFailedModerationCase(TARGET, ["unban"], {
        relatedCaseId: ban.caseId,
        sources: ["moderation-command"],
      }),
    ).toEqual({ status: "found", case: failedUnban });
    expect(
      storage
        .forGuild(GUILD_B)
        .findUniqueFailedModerationCase(TARGET, ["unban"], {
          relatedCaseId: ban.caseId,
          sources: ["moderation-command"],
        }),
    ).toEqual({ status: "none", case: null });
    guild.reserveModerationCaseAttempt({
      targetUserId: TARGET,
      actorId: ACTOR,
      actionType: "unban",
      source: "moderation-command",
      publicReason: "A second linked failed unban makes recovery ambiguous.",
      relatedCaseId: ban.caseId,
    });
    expect(
      guild.findUniqueFailedModerationCase(TARGET, ["unban"], {
        relatedCaseId: ban.caseId,
        sources: ["moderation-command"],
      }),
    ).toEqual({ status: "ambiguous", case: null });

    const expiresAt = new Date(Date.now() - 60_000).toISOString();
    const observedAt = new Date().toISOString();
    const timeout = guild.createModerationCase({
      targetUserId: OTHER_TARGET,
      actorId: ACTOR,
      actionType: "timeout",
      source: "moderation-command",
      publicReason: "A timeout that expired naturally in Discord.",
      status: "active",
      discordActionMetadata: { expiresAt },
    });
    expect(
      guild.completeExpiredTimeoutCase(timeout.caseId, {
        actorId: ACTOR,
        observedAt,
        expectedUpdatedAt: VERIFIED_AT,
      }).status,
    ).toBe("conflict");
    expect(
      guild.completeExpiredTimeoutCase(timeout.caseId, {
        actorId: ACTOR,
        observedAt: new Date(Date.parse(expiresAt) - 1).toISOString(),
        expectedUpdatedAt: timeout.updatedAt,
      }).status,
    ).toBe("unavailable");
    expect(() =>
      guild.completeExpiredTimeoutCase(timeout.caseId, {
        actorId: ACTOR,
        observedAt: new Date(Date.now() + 60_000).toISOString(),
        expectedUpdatedAt: timeout.updatedAt,
      }),
    ).toThrow(/cannot be in the future/);
    expect(() =>
      guild.completeExpiredTimeoutCase(timeout.caseId, {
        actorId: ACTOR,
        observedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        expectedUpdatedAt: timeout.updatedAt,
      }),
    ).toThrow(/no longer fresh/);
    const completed = guild.completeExpiredTimeoutCase(timeout.caseId, {
      actorId: ACTOR,
      observedAt,
      expectedUpdatedAt: timeout.updatedAt,
    });
    expect(completed).toMatchObject({
      status: "changed",
      case: { status: "completed", relatedCaseId: null },
    });
    expect(
      guild.completeExpiredTimeoutCase(timeout.caseId, {
        actorId: ACTOR,
        observedAt,
        expectedUpdatedAt: timeout.updatedAt,
      }).status,
    ).toBe("unchanged");
    expect(
      guild
        .listModerationCaseEvents(timeout.caseId)
        .filter((event) => event.type === "timeout-expired"),
    ).toMatchObject([{ actorId: ACTOR, details: { expiresAt, observedAt } }]);
    expect(
      storage.forGuild(GUILD_B).completeExpiredTimeoutCase(timeout.caseId, {
        actorId: ACTOR,
        observedAt,
        expectedUpdatedAt: timeout.updatedAt,
      }).status,
    ).toBe("not-found");

    const automodTimeout = guild.createModerationCase({
      targetUserId: OTHER_TARGET,
      actorId: ACTOR,
      actionType: "automod-timeout",
      source: "anti-spam",
      publicReason: "An automated timeout that expired naturally.",
      status: "active",
      discordActionMetadata: {
        ruleType: "burst",
        messageId: snowflake(74),
        channelId: snowflake(75),
        observedCount: 5,
        timeoutSeconds: 60,
        expiresAt,
      },
    });
    expect(
      guild.completeExpiredTimeoutCase(automodTimeout.caseId, {
        actorId: ACTOR,
        observedAt,
        expectedUpdatedAt: automodTimeout.updatedAt,
      }).status,
    ).toBe("changed");
    storage.close();
  });

  it("enforces case privacy, text limits, and disabled recovery boundaries", () => {
    const source = createStorage("case-boundaries-source");
    const guild = source.storage.forGuild(GUILD_A);
    configure(guild);
    expect(() =>
      guild.createModerationCase({
        targetUserId: TARGET,
        actorId: ACTOR,
        actionType: "automod-warning",
        source: "anti-spam",
        publicReason: "Unsafe anti-spam metadata must be rejected.",
        status: "active",
        discordActionMetadata: { content: "raw private message content" },
      }),
    ).toThrow(/Unsafe anti-spam case metadata field/);
    expect(() =>
      guild.createModerationCase({
        targetUserId: TARGET,
        actorId: ACTOR,
        actionType: "automod-warning",
        source: "anti-spam",
        publicReason: "Nested payloads cannot bypass the metadata boundary.",
        status: "active",
        discordActionMetadata: {
          ruleType: "burst",
          messageId: { body: "raw message" },
        },
      }),
    ).toThrow(/Invalid anti-spam message ID metadata/);
    const safeAutomodCase = guild.createModerationCase({
      targetUserId: TARGET,
      actorId: ACTOR,
      actionType: "automod-warning",
      source: "anti-spam",
      publicReason: "Safe anti-spam case metadata contains identifiers only.",
      status: "active",
      discordActionMetadata: {
        ruleType: "duplicate",
        messageId: snowflake(76),
        channelId: snowflake(77),
        observedCount: 3,
      },
    });
    const pendingAutomod = guild.reserveModerationCaseAttempt({
      targetUserId: OTHER_TARGET,
      actorId: ACTOR,
      actionType: "automod-timeout",
      source: "anti-spam",
      publicReason: "Pending automated timeout metadata confirmation.",
      discordActionMetadata: {
        ruleType: "burst",
        messageId: snowflake(78),
        channelId: snowflake(79),
        observedCount: 5,
        timeoutSeconds: 60,
      },
    });
    expect(() =>
      guild.confirmModerationCase(pendingAutomod.caseId, {
        actorId: ACTOR,
        status: "active",
        discordActionMetadata: { messageText: "raw message content" },
        expectedUpdatedAt: pendingAutomod.updatedAt,
      }),
    ).toThrow(/Unsafe anti-spam case metadata field/);
    expect(guild.getModerationCaseById(pendingAutomod.caseId)?.status).toBe(
      "failed",
    );

    expect(() =>
      guild.createModerationCase({
        targetUserId: TARGET,
        actorId: ACTOR,
        actionType: "note",
        source: "moderation-command",
        publicReason: "x".repeat(501),
        status: "completed",
      }),
    ).toThrow(/1-500/);
    expect(() =>
      guild.createModerationCase({
        targetUserId: TARGET,
        actorId: ACTOR,
        actionType: "note",
        source: "moderation-command",
        publicReason: "A bounded note.",
        privateNote: "x".repeat(1_001),
        status: "completed",
      }),
    ).toThrow(/1-1000/);
    expect(
      guild.createModerationCase({
        targetUserId: TARGET,
        actorId: ACTOR,
        actionType: "note",
        source: "moderation-command",
        publicReason: "x".repeat(500),
        privateNote: "y".repeat(1_000),
        status: "completed",
      }),
    ).toMatchObject({
      publicReason: "x".repeat(500),
      privateNote: "y".repeat(1_000),
    });

    const portable = source.storage.exportGuildData(GUILD_A);
    const destination = createStorage("case-boundaries-destination");
    const unsafeImport = structuredClone(portable);
    const unsafeCase = unsafeImport.moderationCases.find(
      ({ caseId }) => caseId === safeAutomodCase.caseId,
    );
    if (!unsafeCase) throw new Error("portable anti-spam case missing");
    unsafeCase.discordActionMetadata = { body: "raw private message content" };
    const beforeImport = destination.storage.exportGuildData(GUILD_A);
    expect(() =>
      destination.storage.importGuildData(
        GUILD_A,
        unsafeImport,
        destination.storage.getGuildSettings(GUILD_A)!,
      ),
    ).toThrow(/Unsafe anti-spam case metadata field/);
    expect(destination.storage.exportGuildData(GUILD_A)).toMatchObject({
      moderationCases: beforeImport.moderationCases,
      moderationCaseEvents: beforeImport.moderationCaseEvents,
    });
    const oversizedImport = structuredClone(portable);
    oversizedImport.moderationCases[0]!.publicReason = "x".repeat(501);
    expect(() =>
      destination.storage.importGuildData(
        GUILD_A,
        oversizedImport,
        destination.storage.getGuildSettings(GUILD_A)!,
      ),
    ).toThrow(/case public reason must contain 1-500/);

    const activeBan = guild.createModerationCase({
      targetUserId: TARGET,
      actorId: ACTOR,
      actionType: "ban",
      source: "moderation-command",
      publicReason: "An active ban retained when case creation is disabled.",
      status: "active",
    });
    const activeTimeout = guild.createModerationCase({
      targetUserId: OTHER_TARGET,
      actorId: ACTOR,
      actionType: "timeout",
      source: "moderation-command",
      publicReason: "An active timeout retained for disabled-mode recovery.",
      status: "active",
      discordActionMetadata: {
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    guild.upsertModerationConfiguration({
      casesEnabled: false,
      actorId: ACTOR,
    });
    expect(() =>
      guild.reserveModerationCaseAttempt({
        targetUserId: TARGET,
        actorId: ACTOR,
        actionType: "kick",
        source: "moderation-command",
        publicReason: "Disabled case creation must fail closed.",
      }),
    ).toThrow(/New moderation cases are disabled/);
    expect(() =>
      guild.createModerationCase({
        targetUserId: TARGET,
        actorId: ACTOR,
        actionType: "warning",
        source: "moderation-command",
        publicReason: "Disabled direct case creation must fail closed.",
        status: "active",
      }),
    ).toThrow(/New moderation cases are disabled/);
    expect(() =>
      guild.reserveModerationCaseAttempt({
        targetUserId: TARGET,
        actorId: ACTOR,
        actionType: "unban",
        source: "moderation-command",
        publicReason: "An unlinked recovery must fail closed.",
      }),
    ).toThrow(/New moderation cases are disabled/);
    const unban = guild.reserveModerationCaseAttempt({
      targetUserId: TARGET,
      actorId: ACTOR,
      actionType: "unban",
      source: "moderation-command",
      publicReason: "A uniquely linked ban recovery remains available.",
      relatedCaseId: activeBan.caseId,
    });
    expect(unban).toMatchObject({
      status: "failed",
      relatedCaseId: activeBan.caseId,
    });
    expect(() =>
      guild.reserveModerationCaseAttempt({
        targetUserId: TARGET,
        actorId: ACTOR,
        actionType: "unban",
        source: "moderation-command",
        publicReason: "A duplicate recovery reservation must fail closed.",
        relatedCaseId: activeBan.caseId,
      }),
    ).toThrow(/one unlinked active original case/);
    expect(
      guild.reserveModerationCaseAttempt({
        targetUserId: OTHER_TARGET,
        actorId: ACTOR,
        actionType: "timeout-removed",
        source: "appeal-review",
        publicReason: "Existing timeout lifecycle recovery remains available.",
        relatedCaseId: activeTimeout.caseId,
      }),
    ).toMatchObject({
      status: "failed",
      relatedCaseId: activeTimeout.caseId,
    });
    source.storage.close();
    destination.storage.close();
  });

  it("atomically overturns ordinary appeals with exact retries and invariants", () => {
    const { storage } = createStorage("ordinary-appeals");
    const guild = storage.forGuild(GUILD_A);
    configure(guild);
    const warning = guild.createModerationCase({
      targetUserId: TARGET,
      actorId: ACTOR,
      actionType: "warning",
      source: "moderation-command",
      publicReason: "Initial warning.",
      status: "active",
    });
    const initiallyClaimedAppeal = readyAppeal(
      guild,
      warning.caseId,
      TARGET,
      10,
    );
    const takenOverAppeal = guild.takeOverCaseAppealClaim(
      initiallyClaimedAppeal.appealId,
      {
        reviewerId: ACTOR,
        previousReviewerId: REVIEWER,
        reason: "The first reviewer is no longer authorized.",
        expectedUpdatedAt: initiallyClaimedAppeal.updatedAt,
      },
    );
    expect(takenOverAppeal).toMatchObject({
      status: "changed",
      appeal: { claimedBy: ACTOR },
    });
    if (takenOverAppeal.status === "not-found")
      throw new Error("appeal missing");
    const restoredAppeal = guild.takeOverCaseAppealClaim(
      initiallyClaimedAppeal.appealId,
      {
        reviewerId: REVIEWER,
        previousReviewerId: ACTOR,
        reason: "Assign the appeal to the current authorized reviewer.",
        expectedUpdatedAt: takenOverAppeal.appeal.updatedAt,
      },
    );
    expect(restoredAppeal).toMatchObject({
      status: "changed",
      appeal: { claimedBy: REVIEWER },
    });
    if (restoredAppeal.status === "not-found")
      throw new Error("appeal missing");
    const appeal = restoredAppeal.appeal;
    expect(
      guild
        .listCaseAppealEvents(appeal.appealId)
        .filter((event) => event.type === "claim-reassigned"),
    ).toHaveLength(2);
    const input = {
      reviewerId: REVIEWER,
      decisionReason: "The reviewer found the appeal persuasive.",
      caseReason: "Warning overturned after an accepted appeal.",
      appealExpectedUpdatedAt: appeal.updatedAt,
      originalExpectedUpdatedAt: warning.updatedAt,
    };
    const finalized = guild.finalizeCaseAppealOverturn(appeal.appealId, input);
    expect(finalized).toMatchObject({
      status: "changed",
      appeal: { state: "overturned", reversalCaseId: null },
      originalCase: {
        status: "overturned",
        overturnedBy: REVIEWER,
        overturnReason: input.caseReason,
      },
      reversalCase: null,
    });
    expect(
      guild.finalizeCaseAppealOverturn(appeal.appealId, input).status,
    ).toBe("unchanged");
    expect(
      storage
        .forGuild(GUILD_B)
        .finalizeCaseAppealOverturn(appeal.appealId, input).status,
    ).toBe("not-found");

    const secondWarning = guild.createModerationCase({
      targetUserId: TARGET,
      actorId: ACTOR,
      actionType: "warning",
      source: "moderation-command",
      publicReason: "A second warning.",
      status: "active",
    });
    const secondAppeal = readyAppeal(guild, secondWarning.caseId, TARGET, 11);
    const unrelatedUnban = guild.createModerationCase({
      targetUserId: TARGET,
      actorId: ACTOR,
      actionType: "unban",
      source: "moderation-command",
      publicReason: "Separate unban record.",
      status: "completed",
    });
    expect(
      guild.finalizeCaseAppealOverturn(secondAppeal.appealId, {
        reviewerId: REVIEWER,
        decisionReason: "Decision remains private.",
        caseReason: "Safe public case reason.",
        reversalCaseId: unrelatedUnban.caseId,
      }).status,
    ).toBe("unavailable");
    expect(
      guild.finalizeCaseAppealOverturn(secondAppeal.appealId, {
        reviewerId: REVIEWER,
        decisionReason: "Decision remains private.",
        caseReason: "Safe public case reason.",
        originalExpectedUpdatedAt: "2000-01-01T00:00:00.000Z",
      }).status,
    ).toBe("conflict");
    expect(guild.getModerationCaseById(secondWarning.caseId)?.status).toBe(
      "active",
    );
    expect(guild.getCaseAppealById(secondAppeal.appealId)?.state).toBe(
      "under-review",
    );

    const ban = guild.createModerationCase({
      targetUserId: TARGET,
      actorId: ACTOR,
      actionType: "ban",
      source: "moderation-command",
      publicReason: "Ban pending appeal.",
      status: "active",
    });
    const banAppeal = readyAppeal(guild, ban.caseId, TARGET, 12);
    const wrongTargetUnban = guild.createModerationCase({
      targetUserId: OTHER_TARGET,
      actorId: ACTOR,
      actionType: "unban",
      source: "moderation-command",
      publicReason: "Different member unban.",
      status: "completed",
    });
    expect(
      guild.finalizeCaseAppealOverturn(banAppeal.appealId, {
        reviewerId: REVIEWER,
        decisionReason: "The ban should be overturned.",
        caseReason: "Ban overturned after verified unban.",
        reversalCaseId: wrongTargetUnban.caseId,
      }).status,
    ).toBe("unavailable");
    expect(
      guild.finalizeCaseAppealOverturn(banAppeal.appealId, {
        reviewerId: REVIEWER,
        decisionReason: "The ban should be overturned.",
        caseReason: "Ban overturned after verified unban.",
        reversalCaseId: unrelatedUnban.caseId,
      }).status,
    ).toBe("unavailable");
    expect(guild.getModerationCaseById(ban.caseId)?.status).toBe("active");
    const linkedUnban = guild.createModerationCase({
      targetUserId: TARGET,
      actorId: ACTOR,
      actionType: "unban",
      source: "moderation-command",
      publicReason: "Authorized unban linked to the appealed ban.",
      status: "completed",
      relatedCaseId: ban.caseId,
    });
    expect(
      guild.finalizeCaseAppealOverturn(banAppeal.appealId, {
        reviewerId: REVIEWER,
        decisionReason: "The ban should be overturned.",
        caseReason: "Ban overturned after verified unban.",
        reversalCaseId: linkedUnban.caseId,
      }),
    ).toMatchObject({
      status: "changed",
      appeal: { state: "overturned", reversalCaseId: linkedUnban.caseId },
      originalCase: { status: "overturned" },
    });
    storage.close();
  });

  it("finalizes timeout reversal cases and their appeal in one transaction", () => {
    const { storage } = createStorage("timeout-appeal");
    const guild = storage.forGuild(GUILD_A);
    configure(guild);
    const expiresAt = "2026-08-13T00:30:00.000Z";
    const timeout = guild.createModerationCase({
      targetUserId: TARGET,
      actorId: ACTOR,
      actionType: "timeout",
      source: "moderation-command",
      publicReason: "Timeout under appeal.",
      discordActionMetadata: { expiresAt },
      status: "active",
    });
    const appeal = readyAppeal(guild, timeout.caseId, TARGET, 20);
    const removal = guild.reserveModerationCaseAttempt({
      targetUserId: TARGET,
      actorId: REVIEWER,
      actionType: "timeout-removed",
      source: "appeal-review",
      publicReason: "Timeout removed after appeal.",
      relatedCaseId: timeout.caseId,
    });
    const input = {
      reviewerId: REVIEWER,
      decisionReason: "The timeout evidence did not support the duration.",
      caseReason: "Timeout overturned after a successful appeal.",
      discordActionMetadata: { timeoutRemoved: true },
      appealExpectedUpdatedAt: appeal.updatedAt,
      removalExpectedUpdatedAt: removal.updatedAt,
      originalExpectedUpdatedAt: timeout.updatedAt,
    };
    expect(
      guild.finalizeTimeoutAppealOverturn(
        appeal.appealId,
        removal.caseId,
        input,
      ).status,
    ).toBe("unavailable");
    expect(
      guild.checkpointTimeoutAppealRemoval(appeal.appealId, removal.caseId, {
        reviewerId: REVIEWER,
        originalExpiresAt: expiresAt,
        discordActionMetadata: { timeoutRemoved: true },
        appealExpectedUpdatedAt: appeal.updatedAt,
        removalExpectedUpdatedAt: removal.updatedAt,
        originalExpectedUpdatedAt: "2000-01-01T00:00:00.000Z",
      }).status,
    ).toBe("conflict");
    const checkpoint = guild.checkpointTimeoutAppealRemoval(
      appeal.appealId,
      removal.caseId,
      {
        reviewerId: REVIEWER,
        originalExpiresAt: expiresAt,
        discordActionMetadata: { timeoutRemoved: true },
        appealExpectedUpdatedAt: appeal.updatedAt,
        removalExpectedUpdatedAt: removal.updatedAt,
        originalExpectedUpdatedAt: timeout.updatedAt,
      },
    );
    expect(checkpoint).toMatchObject({
      status: "changed",
      removalCase: {
        status: "failed",
        discordActionMetadata: {
          recoveryCheckpoint: {
            kind: "timeout-appeal-removal-confirmed",
            appealId: appeal.appealId,
            originalCaseId: timeout.caseId,
            originalExpiresAt: expiresAt,
            reviewerId: REVIEWER,
          },
        },
      },
    });
    if (checkpoint.status === "not-found") throw new Error("case missing");
    expect(guild.getModerationLogDelivery(removal.caseId)).toBeNull();
    expect(
      guild.checkpointTimeoutAppealRemoval(appeal.appealId, removal.caseId, {
        reviewerId: REVIEWER,
        originalExpiresAt: expiresAt,
        discordActionMetadata: { timeoutRemoved: true },
        appealExpectedUpdatedAt: appeal.updatedAt,
        removalExpectedUpdatedAt: removal.updatedAt,
        originalExpectedUpdatedAt: timeout.updatedAt,
      }).status,
    ).toBe("unchanged");
    input.removalExpectedUpdatedAt = checkpoint.removalCase.updatedAt;
    expect(
      guild.finalizeTimeoutAppealOverturn(appeal.appealId, removal.caseId, {
        ...input,
        originalExpectedUpdatedAt: "2000-01-01T00:00:00.000Z",
      }).status,
    ).toBe("conflict");
    expect(guild.getModerationCaseById(timeout.caseId)?.status).toBe("active");
    expect(guild.getModerationCaseById(removal.caseId)?.status).toBe("failed");
    expect(guild.getCaseAppealById(appeal.appealId)?.state).toBe(
      "under-review",
    );

    const finalized = guild.finalizeTimeoutAppealOverturn(
      appeal.appealId,
      removal.caseId,
      input,
    );
    expect(finalized).toMatchObject({
      status: "changed",
      appeal: { state: "overturned", reversalCaseId: removal.caseId },
      originalCase: { status: "overturned", relatedCaseId: removal.caseId },
      reversalCase: { status: "completed", relatedCaseId: timeout.caseId },
    });
    expect(
      guild.finalizeTimeoutAppealOverturn(
        appeal.appealId,
        removal.caseId,
        input,
      ).status,
    ).toBe("unchanged");
    storage.close();
  });

  it("rejects completed timeout and automod cases as appeal subjects", () => {
    const { storage } = createStorage("appeal-eligibility");
    const guild = storage.forGuild(GUILD_A);
    configure(guild);
    for (const moderationCase of [
      guild.createModerationCase({
        targetUserId: TARGET,
        actorId: ACTOR,
        actionType: "timeout",
        source: "moderation-command",
        publicReason: "A timeout that has already ended.",
        status: "completed",
      }),
      guild.createModerationCase({
        targetUserId: TARGET,
        actorId: ACTOR,
        actionType: "automod-warning",
        source: "anti-spam",
        publicReason: "Automated warning record.",
        status: "active",
      }),
    ]) {
      expect(
        guild.reserveCaseAppeal({
          caseId: moderationCase.caseId,
          appellantId: TARGET,
          explanation: "This case should not be eligible for this appeal flow.",
        }),
      ).toEqual({ status: "ineligible", appeal: null });
    }
    storage.close();
  });

  it("leases private deliveries, recovers missing messages, and enforces report claims", () => {
    const { storage, dbFile } = createStorage("deliveries");
    const guild = storage.forGuild(GUILD_A);
    configure(guild, { reportCooldownLimit: 1 });
    const preexistingCase = guild.createModerationCase({
      targetUserId: TARGET,
      actorId: ACTOR,
      actionType: "warning",
      source: "moderation-command",
      publicReason: "An older warning unrelated to the later report.",
      status: "active",
    });
    const reserved = guild.reserveMemberReport({
      reporterId: REPORTER,
      targetUserId: TARGET,
      category: "harassment",
      explanation: "The member repeatedly sent targeted abusive replies.",
    });
    expect(reserved.status).toBe("created");
    if (reserved.status !== "created") throw new Error("report not reserved");

    const firstClaim = requireClaimed(
      guild.claimMemberReportDelivery(reserved.report.reportId),
    );
    expect(
      guild.claimMemberReportDelivery(reserved.report.reportId).status,
    ).toBe("busy");
    expireLease(
      dbFile,
      "member_reports",
      "report_id",
      reserved.report.reportId,
    );
    const secondClaim = requireClaimed(
      guild.claimMemberReportDelivery(reserved.report.reportId),
    );
    expect(secondClaim.claimId).not.toBe(firstClaim.claimId);
    expect(
      guild.bindMemberReportDelivery(reserved.report.reportId, {
        reviewChannelId: REVIEW_CHANNEL,
        reviewMessageId: snowflake(30),
        claimId: firstClaim.claimId,
      }).status,
    ).toBe("unavailable");
    const posted = guild.bindMemberReportDelivery(reserved.report.reportId, {
      reviewChannelId: REVIEW_CHANNEL,
      reviewMessageId: snowflake(31),
      claimId: secondClaim.claimId,
    });
    expect(posted).toMatchObject({
      status: "changed",
      report: { deliveryState: "posted" },
    });
    expect(
      guild.bindMemberReportDelivery(reserved.report.reportId, {
        reviewChannelId: REVIEW_CHANNEL,
        reviewMessageId: snowflake(31),
        claimId: secondClaim.claimId,
        expectedUpdatedAt: secondClaim.record.updatedAt,
      }),
    ).toMatchObject({
      status: "unchanged",
      report: { deliveryState: "posted", reviewMessageId: snowflake(31) },
    });
    if (posted.status === "not-found") throw new Error("report disappeared");
    const missing = guild.markMemberReportDeliveryMissing(
      reserved.report.reportId,
      { expectedUpdatedAt: posted.report.updatedAt },
    );
    expect(missing).toMatchObject({
      status: "changed",
      report: { deliveryState: "missing" },
    });
    const reboundClaim = requireClaimed(
      guild.claimMemberReportDelivery(reserved.report.reportId),
    );
    expect(
      guild.bindMemberReportDelivery(reserved.report.reportId, {
        reviewChannelId: REVIEW_CHANNEL,
        reviewMessageId: snowflake(32),
        claimId: reboundClaim.claimId,
      }),
    ).toMatchObject({
      status: "changed",
      report: { deliveryState: "posted", reviewMessageId: snowflake(32) },
    });
    const reportEvents = guild.listMemberReportEvents(reserved.report.reportId);
    expect(reportEvents.map((event) => event.type)).toContain("rebound");
    expect(
      reportEvents.find((event) => event.type === "recovery-noted")?.details,
    ).toMatchObject({
      channelId: REVIEW_CHANNEL,
      messageId: snowflake(31),
    });

    const claimedReport = guild.claimMemberReport(reserved.report.reportId, {
      reviewerId: REVIEWER,
    });
    expect(claimedReport.status).toBe("changed");
    if (claimedReport.status === "not-found") throw new Error("report missing");
    expect(
      guild.takeOverMemberReportClaim(reserved.report.reportId, {
        reviewerId: ACTOR,
        previousReviewerId: REVIEWER,
        reason: "The original reviewer is no longer authorized.",
        expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
      }).status,
    ).toBe("conflict");
    const takenOver = guild.takeOverMemberReportClaim(
      reserved.report.reportId,
      {
        reviewerId: ACTOR,
        previousReviewerId: REVIEWER,
        reason: "The original reviewer is no longer authorized.",
        expectedUpdatedAt: claimedReport.report.updatedAt,
      },
    );
    expect(takenOver).toMatchObject({
      status: "changed",
      report: { state: "under-review", claimedBy: ACTOR },
    });
    if (takenOver.status === "not-found") throw new Error("report missing");
    const released = guild.releaseMemberReportClaim(reserved.report.reportId, {
      actorId: ACTOR,
      previousReviewerId: ACTOR,
      reason: "Release the claim for a freshly authorized reviewer.",
      expectedUpdatedAt: takenOver.report.updatedAt,
    });
    expect(released).toMatchObject({
      status: "changed",
      report: { state: "submitted", claimedBy: null },
    });
    const reclaimed = guild.claimMemberReport(reserved.report.reportId, {
      reviewerId: REVIEWER,
    });
    expect(reclaimed.status).toBe("changed");
    if (reclaimed.status === "not-found") throw new Error("report missing");
    expect(
      guild.decideMemberReport(reserved.report.reportId, {
        state: "resolved",
        reviewerId: ACTOR,
        reason: "Wrong reviewer must not decide this report.",
      }).status,
    ).toBe("unavailable");
    expect(
      guild.decideMemberReport(reserved.report.reportId, {
        state: "resolved",
        reviewerId: REVIEWER,
        reason: "An old unrelated case cannot be presented as this outcome.",
        linkedCaseId: preexistingCase.caseId,
        expectedUpdatedAt: reclaimed.report.updatedAt,
      }).status,
    ).toBe("unavailable");
    expect(() =>
      guild.decideMemberReport(reserved.report.reportId, {
        state: "dismissed",
        reviewerId: REVIEWER,
        reason: "Dismissal cannot imply a moderation action.",
        linkedCaseId: preexistingCase.caseId,
        expectedUpdatedAt: reclaimed.report.updatedAt,
      }),
    ).toThrow(/Only a resolved report/);
    const noteCase = guild.createModerationCase({
      targetUserId: TARGET,
      actorId: ACTOR,
      actionType: "note",
      source: "moderation-command",
      publicReason: "A note is not a resulting warning or enforcement action.",
      status: "completed",
    });
    expect(
      guild.decideMemberReport(reserved.report.reportId, {
        state: "resolved",
        reviewerId: REVIEWER,
        reason: "A note cannot be presented as enforcement.",
        linkedCaseId: noteCase.caseId,
        expectedUpdatedAt: reclaimed.report.updatedAt,
      }).status,
    ).toBe("unavailable");
    const wrongTargetCase = guild.createModerationCase({
      targetUserId: OTHER_TARGET,
      actorId: ACTOR,
      actionType: "warning",
      source: "moderation-command",
      publicReason: "A case for a different report target.",
      status: "active",
    });
    expect(
      guild.decideMemberReport(reserved.report.reportId, {
        state: "resolved",
        reviewerId: REVIEWER,
        reason: "A mismatched case must not resolve the report.",
        linkedCaseId: wrongTargetCase.caseId,
        expectedUpdatedAt: reclaimed.report.updatedAt,
      }).status,
    ).toBe("unavailable");
    const linkedCase = guild.createModerationCase({
      targetUserId: TARGET,
      actorId: ACTOR,
      actionType: "warning",
      source: "moderation-command",
      publicReason: "A real case for the reported member.",
      status: "active",
    });
    const decision = {
      state: "resolved" as const,
      reviewerId: REVIEWER,
      reason: "Reviewed and resolved with the reporter's safety in mind.",
      linkedCaseId: linkedCase.caseId,
      expectedUpdatedAt: reclaimed.report.updatedAt,
    };
    expect(
      guild.decideMemberReport(reserved.report.reportId, decision).status,
    ).toBe("changed");
    expect(
      guild.decideMemberReport(reserved.report.reportId, decision).status,
    ).toBe("unchanged");
    expect(
      guild.reserveMemberReport({
        reporterId: REPORTER,
        targetUserId: OTHER_TARGET,
        category: "safety",
        explanation: "A second report inside the configured cooldown window.",
      }).status,
    ).toBe("cooldown");

    const moderationCase = guild.createModerationCase({
      targetUserId: TARGET,
      actorId: ACTOR,
      actionType: "warning",
      source: "moderation-command",
      publicReason: "Log delivery recovery case.",
      status: "active",
    });
    const logClaim = requireClaimed(
      guild.claimModerationLogDelivery(moderationCase.caseId),
    );
    const delivered = guild.completeModerationLogDelivery(
      moderationCase.caseId,
      {
        channelId: LOG_CHANNEL,
        messageId: snowflake(40),
        claimId: logClaim.claimId,
      },
    );
    expect(delivered?.state).toBe("delivered");
    if (!delivered) throw new Error("log delivery disappeared");
    const markedMissing = guild.markModerationLogDeliveryMissing(
      moderationCase.caseId,
      { expectedUpdatedAt: delivered.updatedAt },
    );
    expect(markedMissing).toMatchObject({
      state: "missing",
      channelId: null,
      messageId: null,
    });
    const replacementClaim = requireClaimed(
      guild.claimModerationLogDelivery(moderationCase.caseId),
    );
    expect(
      guild.completeModerationLogDelivery(moderationCase.caseId, {
        channelId: LOG_CHANNEL,
        messageId: snowflake(41),
        claimId: replacementClaim.claimId,
      }),
    ).toMatchObject({ state: "delivered", messageId: snowflake(41) });
    expect(
      guild
        .listModerationCaseEvents(moderationCase.caseId)
        .filter((event) => event.type === "log-delivered"),
    ).toHaveLength(2);
    storage.close();
  });

  it("durably tracks ambiguous orphan messages under exact delivery claims", () => {
    const { storage } = createStorage("delivery-orphans");
    const guild = storage.forGuild(GUILD_A);
    configure(guild);

    const reportReservation = guild.reserveMemberReport({
      reporterId: REPORTER,
      targetUserId: TARGET,
      category: "safety",
      explanation:
        "A private report whose first delivery needs reconciliation.",
    });
    if (reportReservation.status !== "created")
      throw new Error("report not reserved");
    const reportClaim = requireClaimed(
      guild.claimMemberReportDelivery(reportReservation.report.reportId),
    );
    const reportOrphanInput = {
      reviewChannelId: REVIEW_CHANNEL,
      reviewMessageId: snowflake(60),
      claimId: reportClaim.claimId,
      failureCode: "discord-delete-ambiguous",
      expectedUpdatedAt: reportClaim.record.updatedAt,
    };
    expect(
      guild.checkpointMemberReportDeliveryOrphan(
        reportReservation.report.reportId,
        { ...reportOrphanInput, expectedUpdatedAt: VERIFIED_AT },
      ).status,
    ).toBe("conflict");
    const reportOrphan = guild.checkpointMemberReportDeliveryOrphan(
      reportReservation.report.reportId,
      reportOrphanInput,
    );
    expect(reportOrphan).toMatchObject({
      status: "changed",
      report: {
        deliveryState: "missing",
        reviewChannelId: REVIEW_CHANNEL,
        reviewMessageId: snowflake(60),
        failureCode: "discord-delete-ambiguous",
      },
    });
    expect(
      guild.checkpointMemberReportDeliveryOrphan(
        reportReservation.report.reportId,
        reportOrphanInput,
      ).status,
    ).toBe("unchanged");
    if (reportOrphan.status === "not-found") throw new Error("report missing");
    const reportAdoptionClaim = requireClaimed(
      guild.claimMemberReportDelivery(reportReservation.report.reportId, {
        expectedUpdatedAt: reportOrphan.report.updatedAt,
      }),
    );
    expect(
      guild.bindMemberReportDelivery(reportReservation.report.reportId, {
        reviewChannelId: REVIEW_CHANNEL,
        reviewMessageId: snowflake(60),
        claimId: reportAdoptionClaim.claimId,
        expectedUpdatedAt: reportAdoptionClaim.record.updatedAt,
      }),
    ).toMatchObject({ status: "changed", report: { deliveryState: "posted" } });

    const warning = guild.createModerationCase({
      targetUserId: TARGET,
      actorId: ACTOR,
      actionType: "warning",
      source: "moderation-command",
      publicReason: "Warning with an appeal delivery.",
      status: "active",
    });
    const appealReservation = guild.reserveCaseAppeal({
      caseId: warning.caseId,
      appellantId: TARGET,
      explanation: "An appeal whose first delivery needs reconciliation.",
    });
    if (appealReservation.status !== "created")
      throw new Error("appeal not reserved");
    const appealClaim = requireClaimed(
      guild.claimCaseAppealDelivery(appealReservation.appeal.appealId),
    );
    const appealOrphan = guild.checkpointCaseAppealDeliveryOrphan(
      appealReservation.appeal.appealId,
      {
        reviewChannelId: REVIEW_CHANNEL,
        reviewMessageId: snowflake(61),
        claimId: appealClaim.claimId,
        failureCode: "discord-delete-ambiguous",
        expectedUpdatedAt: appealClaim.record.updatedAt,
      },
    );
    expect(appealOrphan).toMatchObject({
      status: "changed",
      appeal: { deliveryState: "missing", reviewMessageId: snowflake(61) },
    });
    if (appealOrphan.status === "not-found") throw new Error("appeal missing");
    expect(
      storage
        .forGuild(GUILD_B)
        .checkpointCaseAppealDeliveryOrphan(appealReservation.appeal.appealId, {
          reviewChannelId: REVIEW_CHANNEL,
          reviewMessageId: snowflake(61),
          claimId: appealClaim.claimId,
          failureCode: "discord-delete-ambiguous",
          expectedUpdatedAt: appealClaim.record.updatedAt,
        }).status,
    ).toBe("not-found");

    const logCase = guild.createModerationCase({
      targetUserId: OTHER_TARGET,
      actorId: ACTOR,
      actionType: "note",
      source: "moderation-command",
      publicReason: "Moderation log orphan recovery.",
      status: "completed",
    });
    const logClaim = requireClaimed(
      guild.claimModerationLogDelivery(logCase.caseId),
    );
    const logOrphan = guild.checkpointModerationLogDeliveryOrphan(
      logCase.caseId,
      {
        channelId: LOG_CHANNEL,
        messageId: snowflake(62),
        claimId: logClaim.claimId,
        failureCode: "discord-delete-ambiguous",
        expectedUpdatedAt: logClaim.record.updatedAt,
      },
    );
    expect(logOrphan).toMatchObject({
      status: "changed",
      delivery: { state: "missing", messageId: snowflake(62) },
    });
    if (logOrphan.status === "not-found") throw new Error("log missing");
    const logAdoptionClaim = requireClaimed(
      guild.claimModerationLogDelivery(logCase.caseId, {
        expectedUpdatedAt: logOrphan.delivery.updatedAt,
      }),
    );
    expect(
      guild.completeModerationLogDelivery(logCase.caseId, {
        channelId: LOG_CHANNEL,
        messageId: snowflake(62),
        claimId: logAdoptionClaim.claimId,
        expectedUpdatedAt: logAdoptionClaim.record.updatedAt,
      }),
    ).toMatchObject({ state: "delivered", messageId: snowflake(62) });
    storage.close();
  });

  it("checkpoints pre-send delivery attempts across claim takeover and adoption", () => {
    const { storage, dbFile } = createStorage("delivery-attempts");
    const guild = storage.forGuild(GUILD_A);
    configure(guild);

    const reportReservation = guild.reserveMemberReport({
      reporterId: REPORTER,
      targetUserId: TARGET,
      category: "safety",
      explanation:
        "A private delivery must retain its pre-send idempotency checkpoint.",
    });
    if (reportReservation.status !== "created")
      throw new Error("report not reserved");
    const reportId = reportReservation.report.reportId;
    const firstClaim = requireClaimed(
      guild.claimMemberReportDelivery(reportId),
    );
    expect(
      guild.beginMemberReportDeliveryAttempt(reportId, {
        channelId: REVIEW_CHANNEL,
        claimId: firstClaim.claimId,
        expectedUpdatedAt: VERIFIED_AT,
      }).status,
    ).toBe("conflict");
    const firstAttempt = guild.beginMemberReportDeliveryAttempt(reportId, {
      channelId: REVIEW_CHANNEL,
      claimId: firstClaim.claimId,
      expectedUpdatedAt: firstClaim.record.updatedAt,
    });
    expect(firstAttempt).toMatchObject({
      status: "changed",
      attempt: { channelId: REVIEW_CHANNEL },
    });
    if (firstAttempt.status !== "changed" || !firstAttempt.attempt)
      throw new Error("delivery attempt not started");
    expect(guild.getMemberReportDeliveryAttempt(reportId)).toEqual(
      firstAttempt.attempt,
    );
    expect(
      guild.withdrawMemberReport(reportId, {
        reporterId: REPORTER,
        expectedUpdatedAt: firstAttempt.record.updatedAt,
      }).status,
    ).toBe("unavailable");
    expect(JSON.stringify(storage.exportGuildData(GUILD_A))).not.toContain(
      firstAttempt.attempt.attemptId,
    );

    expireLease(dbFile, "member_reports", "report_id", reportId);
    const takeoverClaim = requireClaimed(
      guild.claimMemberReportDelivery(reportId),
    );
    const adoptedAttempt = guild.beginMemberReportDeliveryAttempt(reportId, {
      channelId: REVIEW_CHANNEL,
      claimId: takeoverClaim.claimId,
      expectedUpdatedAt: VERIFIED_AT,
    });
    expect(adoptedAttempt).toMatchObject({
      status: "unchanged",
      attempt: { attemptId: firstAttempt.attempt.attemptId },
    });
    expect(
      guild.beginMemberReportDeliveryAttempt(reportId, {
        channelId: snowflake(70),
        claimId: takeoverClaim.claimId,
        expectedUpdatedAt: takeoverClaim.record.updatedAt,
      }).status,
    ).toBe("unavailable");
    const rotatedAttempt = guild.beginMemberReportDeliveryAttempt(reportId, {
      channelId: snowflake(70),
      claimId: takeoverClaim.claimId,
      expectedUpdatedAt: takeoverClaim.record.updatedAt,
      previousAttemptId: firstAttempt.attempt.attemptId,
    });
    expect(rotatedAttempt).toMatchObject({
      status: "changed",
      attempt: { channelId: snowflake(70) },
    });
    if (rotatedAttempt.status !== "changed" || !rotatedAttempt.attempt)
      throw new Error("delivery attempt not rotated");
    expect(rotatedAttempt.attempt.attemptId).not.toBe(
      firstAttempt.attempt.attemptId,
    );
    expect(
      guild.bindMemberReportDelivery(reportId, {
        reviewChannelId: REVIEW_CHANNEL,
        reviewMessageId: snowflake(71),
        claimId: takeoverClaim.claimId,
        expectedUpdatedAt: rotatedAttempt.record.updatedAt,
      }).status,
    ).toBe("unavailable");
    expect(
      guild.bindMemberReportDelivery(reportId, {
        reviewChannelId: snowflake(70),
        reviewMessageId: snowflake(71),
        claimId: takeoverClaim.claimId,
        expectedUpdatedAt: rotatedAttempt.record.updatedAt,
      }).status,
    ).toBe("changed");
    expect(guild.getMemberReportDeliveryAttempt(reportId)).toBeNull();
    expect(
      storage.forGuild(GUILD_B).getMemberReportDeliveryAttempt(reportId),
    ).toBeNull();

    const warning = guild.createModerationCase({
      targetUserId: TARGET,
      actorId: ACTOR,
      actionType: "warning",
      source: "moderation-command",
      publicReason: "A warning eligible for a private appeal.",
      status: "active",
    });
    const appealReservation = guild.reserveCaseAppeal({
      caseId: warning.caseId,
      appellantId: TARGET,
      explanation:
        "The appeal delivery also needs a durable pre-send checkpoint.",
    });
    if (appealReservation.status !== "created")
      throw new Error("appeal not reserved");
    const appealId = appealReservation.appeal.appealId;
    const appealClaim = requireClaimed(guild.claimCaseAppealDelivery(appealId));
    const appealAttempt = guild.beginCaseAppealDeliveryAttempt(appealId, {
      channelId: REVIEW_CHANNEL,
      claimId: appealClaim.claimId,
      expectedUpdatedAt: appealClaim.record.updatedAt,
    });
    expect(appealAttempt.status).toBe("changed");
    if (appealAttempt.status !== "changed")
      throw new Error("appeal attempt not started");
    expect(
      guild.checkpointCaseAppealDeliveryOrphan(appealId, {
        reviewChannelId: REVIEW_CHANNEL,
        reviewMessageId: snowflake(72),
        claimId: appealClaim.claimId,
        failureCode: "discord-delete-ambiguous",
        expectedUpdatedAt: appealAttempt.record.updatedAt,
      }).status,
    ).toBe("changed");
    expect(guild.getCaseAppealDeliveryAttempt(appealId)).toBeNull();

    const logClaim = requireClaimed(
      guild.claimModerationLogDelivery(warning.caseId),
    );
    const logAttempt = guild.beginModerationLogDeliveryAttempt(warning.caseId, {
      channelId: LOG_CHANNEL,
      claimId: logClaim.claimId,
      expectedUpdatedAt: logClaim.record.updatedAt,
    });
    expect(logAttempt.status).toBe("changed");
    if (logAttempt.status !== "changed")
      throw new Error("log attempt not started");
    expect(
      guild.checkpointModerationLogDeliveryOrphan(warning.caseId, {
        channelId: LOG_CHANNEL,
        messageId: snowflake(73),
        claimId: logClaim.claimId,
        failureCode: "discord-delete-ambiguous",
        expectedUpdatedAt: logAttempt.record.updatedAt,
      }).status,
    ).toBe("changed");
    expect(guild.getModerationLogDeliveryAttempt(warning.caseId)).toBeNull();

    const db = new Database(dbFile);
    try {
      expect(() =>
        db
          .prepare(
            `UPDATE member_reports SET delivery_attempt_id = ?
             WHERE guild_id = ? AND report_id = ?`,
          )
          .run("unsafeAttempt", GUILD_A, reportId),
      ).toThrow();
    } finally {
      db.close();
    }
    storage.close();
  });

  it("bounds anti-spam rules and recovers expired enforcement reservations", () => {
    const { storage, dbFile } = createStorage("anti-spam");
    const guild = storage.forGuild(GUILD_A);
    configure(guild);
    expect(() =>
      guild.upsertAntiSpamRule({
        ruleType: "mention",
        enabled: true,
        threshold: 101,
        action: "delete",
        cooldownSeconds: 60,
        actorId: ACTOR,
      }),
    ).toThrow(/between 2 and 100/);
    guild.upsertAntiSpamRule({
      ruleType: "mention",
      enabled: true,
      threshold: 5,
      action: "delete",
      cooldownSeconds: 60,
      actorId: ACTOR,
    });
    guild.upsertAntiSpamRule({
      ruleType: "burst",
      enabled: true,
      threshold: 4,
      windowSeconds: 10,
      action: "delete-and-warn",
      cooldownSeconds: 60,
      actorId: ACTOR,
    });
    guild.addAntiSpamExemptRole(EXEMPT_ROLE, ACTOR);
    guild.addAntiSpamExemptChannel(EXEMPT_CHANNEL, ACTOR);
    expect(guild.listAntiSpamExemptRoleIds()).toEqual([EXEMPT_ROLE]);
    expect(guild.listAntiSpamExemptChannelIds()).toEqual([EXEMPT_CHANNEL]);
    expect(() => guild.addAntiSpamExemptRole(GUILD_A, ACTOR)).toThrow(
      /@everyone/,
    );

    const reservation = guild.reserveAntiSpamEnforcement({
      ruleType: "mention",
      messageId: snowflake(50),
      memberId: TARGET,
      channelId: EXEMPT_CHANNEL,
      observedCount: 5,
    });
    expect(reservation.status).toBe("reserved");
    if (reservation.status !== "reserved") throw new Error("not reserved");
    expect(
      guild.reserveAntiSpamEnforcement({
        ruleType: "mention",
        messageId: snowflake(50),
        memberId: TARGET,
        channelId: EXEMPT_CHANNEL,
        observedCount: 5,
      }).status,
    ).toBe("duplicate");
    expect(
      guild.completeAntiSpamEnforcement(reservation.reservationId, {
        outcome: "deleted",
      }),
    ).toMatchObject({ state: "deleted", reservationId: null });
    expect(
      guild.reserveAntiSpamEnforcement({
        ruleType: "mention",
        messageId: snowflake(51),
        memberId: TARGET,
        channelId: EXEMPT_CHANNEL,
        observedCount: 6,
      }).status,
    ).toBe("cooldown");

    const interrupted = guild.reserveAntiSpamEnforcement({
      ruleType: "burst",
      messageId: snowflake(52),
      memberId: OTHER_TARGET,
      channelId: EXEMPT_CHANNEL,
      observedCount: 4,
    });
    expect(interrupted.status).toBe("reserved");
    if (interrupted.status !== "reserved") throw new Error("not reserved");
    expireEnforcement(dbFile, interrupted.enforcement.enforcementId);
    expect(guild.recoverExpiredAntiSpamEnforcements()).toBe(1);
    expect(
      guild.getAntiSpamEnforcement(interrupted.enforcement.enforcementId),
    ).toMatchObject({
      state: "failed",
      reservationId: null,
      failureCode: "reservation-expired",
    });
    expect(guild.listAntiSpamEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          messageId: snowflake(52),
          outcome: "failed",
          failureCode: "reservation-expired",
        }),
      ]),
    );
    storage.close();
  });

  it("round-trips format 7 as dormant data, preserves legacy imports, and purges", () => {
    const source = createStorage("export-source");
    const sourceGuild = source.storage.forGuild(GUILD_A);
    configure(sourceGuild);
    const moderationCase = sourceGuild.createModerationCase({
      targetUserId: TARGET,
      actorId: ACTOR,
      actionType: "warning",
      source: "moderation-command",
      publicReason: "Portable warning record.",
      privateNote: "Portable private note.",
      status: "active",
    });
    sourceGuild.upsertAntiSpamRule({
      ruleType: "duplicate",
      enabled: true,
      threshold: 3,
      windowSeconds: 15,
      action: "delete",
      cooldownSeconds: 30,
      actorId: ACTOR,
    });
    sourceGuild.addAntiSpamExemptRole(EXEMPT_ROLE, ACTOR);
    const portableReportReservation = sourceGuild.reserveMemberReport({
      reporterId: REPORTER,
      targetUserId: TARGET,
      category: "harassment",
      explanation: "A portable report linked to its exact moderation target.",
    });
    if (portableReportReservation.status !== "created")
      throw new Error("portable report not reserved");
    const portableDelivery = requireClaimed(
      sourceGuild.claimMemberReportDelivery(
        portableReportReservation.report.reportId,
      ),
    );
    const portablePosted = sourceGuild.bindMemberReportDelivery(
      portableReportReservation.report.reportId,
      {
        reviewChannelId: REVIEW_CHANNEL,
        reviewMessageId: snowflake(70),
        claimId: portableDelivery.claimId,
      },
    );
    if (portablePosted.status !== "changed")
      throw new Error("portable report not posted");
    const portableClaimed = sourceGuild.claimMemberReport(
      portableReportReservation.report.reportId,
      { reviewerId: REVIEWER },
    );
    if (portableClaimed.status !== "changed")
      throw new Error("portable report not claimed");
    const portableResultCase = sourceGuild.createModerationCase({
      targetUserId: TARGET,
      actorId: ACTOR,
      actionType: "warning",
      source: "moderation-command",
      publicReason: "Warning resulting from the reviewed report.",
      status: "active",
    });
    expect(
      sourceGuild.decideMemberReport(
        portableReportReservation.report.reportId,
        {
          state: "resolved",
          reviewerId: REVIEWER,
          reason: "The linked warning accurately records the staff outcome.",
          linkedCaseId: portableResultCase.caseId,
          expectedUpdatedAt: portableClaimed.report.updatedAt,
        },
      ).status,
    ).toBe("changed");
    const exportV7 = source.storage.exportGuildData(GUILD_A);
    expect(exportV7).toMatchObject({
      formatVersion: 7,
      moderationConfiguration: { casesEnabled: true, antiSpamEnabled: true },
      memberReports: [{ linkedCaseId: portableResultCase.caseId }],
      antiSpamRules: [{ ruleType: "duplicate", enabled: true }],
    });
    expect(exportV7.moderationCases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ caseId: moderationCase.caseId }),
        expect.objectContaining({ caseId: portableResultCase.caseId }),
      ]),
    );

    const destination = createStorage("export-destination");
    destination.storage.importGuildData(
      GUILD_A,
      exportV7,
      destination.storage.getGuildSettings(GUILD_A)!,
    );
    const importedGuild = destination.storage.forGuild(GUILD_A);
    expect(importedGuild.getModerationConfiguration()).toMatchObject({
      casesEnabled: false,
      moderationLogChannelId: LOG_CHANNEL,
      moderationLogVerifiedAt: null,
      reportsEnabled: false,
      reportReviewChannelId: REVIEW_CHANNEL,
      reportReviewerRoleId: REVIEW_ROLE,
      reportBindingsVerifiedAt: null,
      appealsEnabled: false,
      appealReviewChannelId: REVIEW_CHANNEL,
      appealReviewerRoleId: REVIEW_ROLE,
      appealBindingsVerifiedAt: null,
      antiSpamEnabled: false,
    });
    expect(
      importedGuild.getModerationCaseById(moderationCase.caseId),
    ).toMatchObject({
      publicReason: "Portable warning record.",
      privateNote: "Portable private note.",
    });
    expect(importedGuild.getAntiSpamRule("duplicate")?.enabled).toBe(false);
    const malformed = structuredClone(exportV7);
    const linkedIndex = malformed.moderationCases.findIndex(
      ({ caseId }) => caseId === portableResultCase.caseId,
    );
    malformed.moderationCases[linkedIndex]!.targetUserId = OTHER_TARGET;
    const beforeRejectedImport = destination.storage.exportGuildData(GUILD_A);
    expect(() =>
      destination.storage.importGuildData(
        GUILD_A,
        malformed,
        destination.storage.getGuildSettings(GUILD_A)!,
      ),
    ).toThrow(/linked case does not match its resolved target/);
    expect(destination.storage.exportGuildData(GUILD_A)).toMatchObject({
      moderationCases: beforeRejectedImport.moderationCases,
      memberReports: beforeRejectedImport.memberReports,
      antiSpamRules: beforeRejectedImport.antiSpamRules,
    });
    const importedCounts = destination.storage.previewGuildPurge(GUILD_A);
    expect(importedCounts).toMatchObject({
      moderationConfigurations: 1,
      moderationCases: 2,
      moderationCaseEvents: 2,
      moderationLogDeliveries: 2,
      antiSpamRules: 1,
      antiSpamExemptRoles: 1,
    });

    const legacyPayload = {
      ...exportV7,
      formatVersion: 6,
    } as unknown as GuildDataExport;
    destination.storage.importGuildData(
      GUILD_A,
      legacyPayload,
      destination.storage.getGuildSettings(GUILD_A)!,
    );
    expect(
      importedGuild.getModerationCaseById(moderationCase.caseId),
    ).toBeNull();
    expect(importedGuild.getModerationConfiguration()).toBeNull();
    expect(importedGuild.listAntiSpamRules()).toEqual([]);
    const legacyCounts = destination.storage.previewGuildPurge(GUILD_A);
    expect(legacyCounts).toMatchObject({
      moderationConfigurations: 0,
      moderationCases: 0,
      moderationCaseEvents: 0,
      moderationLogDeliveries: 0,
      antiSpamRules: 0,
      antiSpamExemptRoles: 0,
    });
    const purged = destination.storage.purgeGuildData(GUILD_A);
    expect(purged).toMatchObject(legacyCounts);
    expect(destination.storage.previewGuildPurge(GUILD_A)).toMatchObject({
      guilds: 0,
      moderationConfigurations: 0,
      moderationCases: 0,
      moderationCaseEvents: 0,
      moderationLogDeliveries: 0,
      antiSpamRules: 0,
      antiSpamExemptRoles: 0,
    });
    source.storage.close();
    destination.storage.close();
  });

  it("bounds Phase 3 export reads before materializing excess rows", () => {
    const { storage, dbFile } = createStorage("bounded-export-read");
    const db = new Database(dbFile);
    try {
      const insert = db.prepare(
        `INSERT INTO anti_spam_exempt_roles
           (guild_id, role_id, created_by, created_at)
         VALUES (?, ?, ?, ?)`,
      );
      const insertMany = db.transaction(() => {
        for (let index = 0; index <= 250; index += 1) {
          insert.run(GUILD_A, snowflake(1_000 + index), ACTOR, VERIFIED_AT);
        }
      });
      insertMany.immediate();
      expect(() => readPhase3GuildData(db, GUILD_A)).toThrow(
        /antiSpamExemptRoles exceeds the 250-record safety limit/,
      );
    } finally {
      db.close();
      storage.close();
    }
  });
});

function createStorage(name: string): {
  storage: BotStorage;
  dbFile: string;
} {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), `superior-phase3-${name}-`),
  );
  roots.push(root);
  const dbFile = path.join(root, "storage.db");
  const storage = new BotStorage({ dbFile });
  openStorages.push(storage);
  storage.initStorage();
  storage.ensureGuild(GUILD_A);
  storage.ensureGuild(GUILD_B);
  return { storage, dbFile };
}

function configure(
  guild: GuildStorage,
  overrides: { reportCooldownLimit?: number } = {},
): void {
  guild.upsertModerationConfiguration({
    casesEnabled: true,
    moderationLogChannelId: LOG_CHANNEL,
    moderationLogVerifiedAt: VERIFIED_AT,
    reportsEnabled: true,
    reportReviewChannelId: REVIEW_CHANNEL,
    reportReviewerRoleId: REVIEW_ROLE,
    reportBindingsVerifiedAt: VERIFIED_AT,
    appealsEnabled: true,
    appealReviewChannelId: REVIEW_CHANNEL,
    appealReviewerRoleId: REVIEW_ROLE,
    appealBindingsVerifiedAt: VERIFIED_AT,
    antiSpamEnabled: true,
    reportCooldownLimit: overrides.reportCooldownLimit ?? 3,
    reportCooldownWindowSeconds: 1_800,
    actorId: ACTOR,
  });
}

function readyAppeal(
  guild: GuildStorage,
  caseId: string,
  appellantId: string,
  messageSuffix: number,
) {
  const reserved = guild.reserveCaseAppeal({
    caseId,
    appellantId,
    explanation:
      "The case should be reviewed because important context was missed.",
  });
  if (reserved.status !== "created") throw new Error("appeal not reserved");
  const delivery = requireClaimed(
    guild.claimCaseAppealDelivery(reserved.appeal.appealId),
  );
  const posted = guild.bindCaseAppealDelivery(reserved.appeal.appealId, {
    reviewChannelId: REVIEW_CHANNEL,
    reviewMessageId: snowflake(messageSuffix),
    claimId: delivery.claimId,
  });
  if (posted.status !== "changed") throw new Error("appeal not posted");
  expect(
    guild.bindCaseAppealDelivery(reserved.appeal.appealId, {
      reviewChannelId: REVIEW_CHANNEL,
      reviewMessageId: snowflake(messageSuffix),
      claimId: delivery.claimId,
      expectedUpdatedAt: delivery.record.updatedAt,
    }),
  ).toMatchObject({
    status: "unchanged",
    appeal: {
      deliveryState: "posted",
      reviewMessageId: snowflake(messageSuffix),
    },
  });
  const claimed = guild.claimCaseAppeal(reserved.appeal.appealId, {
    reviewerId: REVIEWER,
  });
  if (claimed.status !== "changed") throw new Error("appeal not claimed");
  return claimed.appeal;
}

function requireClaimed<T>(result: DeliveryClaimResult<T>) {
  expect(result.status).toBe("claimed");
  if (result.status !== "claimed") throw new Error("delivery not claimed");
  return result;
}

function expireLease(
  dbFile: string,
  table: "member_reports" | "case_appeals",
  idColumn: "report_id" | "appeal_id",
  id: string,
): void {
  const db = new Database(dbFile);
  try {
    db.prepare(
      `UPDATE ${table} SET delivery_claim_expires_at = ? WHERE ${idColumn} = ?`,
    ).run("2000-01-01T00:00:00.000Z", id);
  } finally {
    db.close();
  }
}

function expireEnforcement(dbFile: string, enforcementId: string): void {
  const db = new Database(dbFile);
  try {
    db.prepare(
      `UPDATE anti_spam_enforcements SET reservation_expires_at = ?
       WHERE enforcement_id = ?`,
    ).run("2000-01-01T00:00:00.000Z", enforcementId);
  } finally {
    db.close();
  }
}

function snowflake(suffix: number): string {
  return `900000000000000${String(suffix).padStart(3, "0")}`;
}
