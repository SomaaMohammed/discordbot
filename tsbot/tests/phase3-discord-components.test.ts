import { describe, expect, it } from "vitest";
import type { CaseAppeal, MemberReport, ModerationCase } from "../src/types.js";
import { buildModerationCaseLogPayload } from "../src/discord/moderation-log-delivery.js";
import {
  createReportDecisionModal,
  createReportSubmitModal,
  buildReportReviewPayload,
  parseReportComponentId,
  reportDecisionProvenanceToken,
  reportLauncherMessageToken,
  reportVersionToken,
} from "../src/discord/report-components.js";
import {
  createAppealDecisionModal,
  createAppealSubmitModal,
  buildAppealReviewPayload,
  parseAppealComponentId,
  appealDecisionProvenanceToken,
  appealLauncherMessageToken,
  appealVersionToken,
} from "../src/discord/appeal-components.js";
import { reportCaseLinkIssue } from "../src/discord/report-interactions.js";
import {
  findLinkedConfirmedUnban,
  findRecoverableTimeoutRemoval,
} from "../src/discord/appeal-interactions.js";
import { buildModerationCommandDefinition } from "../src/discord/moderation-command.js";

const NOW = "2026-08-13T12:34:56.000Z";

function moderationCase(): ModerationCase {
  return {
    guildId: "123456789012345678",
    caseId: "caseToken01",
    caseNumber: 9,
    targetUserId: "223456789012345678",
    actorId: "323456789012345678",
    actionType: "warning",
    source: "moderation-command",
    publicReason: "Safe public reason",
    privateNote: "SECRET PRIVATE NOTE",
    discordActionMetadata: null,
    status: "active",
    relatedCaseId: null,
    voidedBy: null,
    voidedAt: null,
    voidReason: null,
    overturnedBy: null,
    overturnedAt: null,
    overturnReason: "PRIVATE APPEAL REASON",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function report(): MemberReport {
  return {
    guildId: "123456789012345678",
    reportId: "reportToken01",
    reportNumber: 4,
    reporterId: "423456789012345678",
    targetUserId: "523456789012345678",
    category: "harassment",
    explanation: "Private report body",
    evidenceGuildId: null,
    evidenceChannelId: null,
    evidenceMessageId: null,
    state: "under-review",
    deliveryState: "posted",
    reviewChannelId: "623456789012345678",
    reviewMessageId: "723456789012345678",
    claimedBy: "823456789012345678",
    claimedAt: NOW,
    decisionBy: null,
    decisionReason: null,
    decidedAt: null,
    linkedCaseId: null,
    withdrawnAt: null,
    failureCode: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function appeal(): CaseAppeal {
  return {
    guildId: "123456789012345678",
    appealId: "appealToken01",
    appealNumber: 2,
    caseId: "caseToken01",
    appellantId: "223456789012345678",
    explanation: "Private appeal body",
    state: "under-review",
    deliveryState: "posted",
    reviewChannelId: "623456789012345678",
    reviewMessageId: "723456789012345678",
    claimedBy: "823456789012345678",
    claimedAt: NOW,
    decisionBy: null,
    decisionReason: null,
    decidedAt: null,
    reversalCaseId: null,
    withdrawnAt: null,
    failureCode: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("Phase 3 Discord components", () => {
  it("never includes private notes or private appeal reasons in moderation logs", () => {
    const payload = buildModerationCaseLogPayload(moderationCase());
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("Safe public reason");
    expect(serialized).not.toContain("SECRET PRIVATE NOTE");
    expect(serialized).not.toContain("PRIVATE APPEAL REASON");
    expect(payload.allowedMentions).toEqual({ parse: [] });
  });

  it("binds report decisions to the current record version", () => {
    const current = report();
    const payload = buildReportReviewPayload(current);
    const row = payload.components![0] as {
      toJSON: () => { components: Array<{ custom_id?: string }> };
    };
    const customId = row.toJSON().components[2]!.custom_id!;
    expect(parseReportComponentId(customId)).toMatchObject({
      kind: "control",
      reportId: current.reportId,
      versionToken: reportVersionToken(current.updatedAt),
    });
    expect(customId.length).toBeLessThanOrEqual(100);
  });

  it("binds appeal decisions to the current record version and omits private notes", () => {
    const current = appeal();
    const payload = buildAppealReviewPayload(current, moderationCase());
    const serialized = JSON.stringify(payload);
    const row = payload.components![0] as {
      toJSON: () => { components: Array<{ custom_id?: string }> };
    };
    const customId = row.toJSON().components[3]!.custom_id!;
    expect(parseAppealComponentId(customId)).toMatchObject({
      kind: "control",
      appealId: current.appealId,
      versionToken: appealVersionToken(current.updatedAt),
    });
    expect(serialized).toContain("Private appeal body");
    expect(serialized).not.toContain("SECRET PRIVATE NOTE");
    expect(customId.length).toBeLessThanOrEqual(100);
  });

  it("binds submit and decision modals to their exact source messages", () => {
    const sourceMessageId = "923456789012345678";
    const otherMessageId = "923456789012345679";
    const reportSubmitId = createReportSubmitModal(
      "panelToken01",
      null,
      sourceMessageId,
    ).toJSON().custom_id;
    const appealSubmitId = createAppealSubmitModal(
      "panelToken01",
      null,
      sourceMessageId,
    ).toJSON().custom_id;
    expect(parseReportComponentId(reportSubmitId)).toMatchObject({
      kind: "submit-modal",
      sourceMessageToken: reportLauncherMessageToken(sourceMessageId),
    });
    expect(parseAppealComponentId(appealSubmitId)).toMatchObject({
      kind: "submit-modal",
      sourceMessageToken: appealLauncherMessageToken(sourceMessageId),
    });

    const reportDecisionId = createReportDecisionModal(
      report().reportId,
      "resolve",
      reportVersionToken(NOW),
      sourceMessageId,
    ).toJSON().custom_id;
    const appealDecisionId = createAppealDecisionModal(
      appeal().appealId,
      "overturn",
      appealVersionToken(NOW),
      sourceMessageId,
    ).toJSON().custom_id;
    expect(parseReportComponentId(reportDecisionId)).toMatchObject({
      provenanceToken: reportDecisionProvenanceToken(NOW, sourceMessageId),
    });
    expect(parseAppealComponentId(appealDecisionId)).toMatchObject({
      provenanceToken: appealDecisionProvenanceToken(NOW, sourceMessageId),
    });
    expect(reportDecisionProvenanceToken(NOW, otherMessageId)).not.toBe(
      reportDecisionProvenanceToken(NOW, sourceMessageId),
    );
    expect(appealDecisionProvenanceToken(NOW, otherMessageId)).not.toBe(
      appealDecisionProvenanceToken(NOW, sourceMessageId),
    );
    expect(
      parseReportComponentId(
        `superior:report:decision-modal:resolve:${report().reportId}:${reportVersionToken(NOW)}`,
      ),
    ).toBeNull();
  });

  it("links reports only to confirmed enforcement cases for the reported target", () => {
    const current = report();
    const linked = moderationCase();
    linked.targetUserId = current.targetUserId;
    expect(reportCaseLinkIssue(current, "resolve", linked)).toBeNull();
    expect(reportCaseLinkIssue(current, "dismiss", linked)).toContain(
      "Dismissed",
    );
    expect(
      reportCaseLinkIssue(current, "resolve", {
        ...linked,
        targetUserId: "999456789012345678",
      }),
    ).toContain("different member");
    expect(
      reportCaseLinkIssue(current, "resolve", {
        ...linked,
        actionType: "note",
      }),
    ).toContain("not a resulting");
    expect(
      reportCaseLinkIssue(current, "resolve", {
        ...linked,
        status: "failed",
      }),
    ).toContain("confirmed");
  });

  it("requires unique timeout-removal recovery and a linked confirmed unban", () => {
    const original = {
      ...moderationCase(),
      actionType: "timeout" as const,
      status: "active" as const,
      discordActionMetadata: {
        expiresAt: "2026-08-13T13:34:56.000Z",
      },
    };
    const currentAppeal = {
      ...appeal(),
      caseId: original.caseId,
      updatedAt: NOW,
    };
    const removal = {
      ...moderationCase(),
      caseId: "removalToken01",
      actionType: "timeout-removed" as const,
      source: "appeal-review" as const,
      status: "failed" as const,
      relatedCaseId: original.caseId,
      targetUserId: original.targetUserId,
      createdAt: "2026-08-13T12:35:00.000Z",
      updatedAt: "2026-08-13T12:35:00.000Z",
      discordActionMetadata: {
        recoveryCheckpoint: {
          kind: "timeout-appeal-removal-confirmed",
          appealId: currentAppeal.appealId,
          originalCaseId: original.caseId,
          originalExpiresAt: "2026-08-13T13:34:56.000Z",
          reviewerId: moderationCase().actorId,
        },
      },
    };
    expect(
      findRecoverableTimeoutRemoval([removal], original, currentAppeal),
    ).toMatchObject({ status: "unique", attempt: removal });
    expect(
      findRecoverableTimeoutRemoval(
        [removal, { ...removal, caseId: "removalToken02" }],
        original,
        currentAppeal,
      ),
    ).toEqual({ status: "ambiguous", attempt: null });

    const ban = { ...original, actionType: "ban" as const };
    const unban = {
      ...removal,
      actionType: "unban" as const,
      source: "moderation-command" as const,
      status: "completed" as const,
      relatedCaseId: ban.caseId,
    };
    expect(findLinkedConfirmedUnban([unban], ban)).toEqual(unban);
    expect(
      findLinkedConfirmedUnban([{ ...unban, relatedCaseId: null }], ban),
    ).toBeNull();
  });

  it("exposes explicit moderation recovery modes", () => {
    const command = buildModerationCommandDefinition().toJSON();
    const recover = command.options?.find(
      (option) => option.name === "recover",
    );
    const mode =
      recover && "options" in recover
        ? recover.options?.find((option) => option.name === "mode")
        : undefined;
    expect(
      mode && "choices" in mode
        ? mode.choices?.map((choice) => choice.value)
        : [],
    ).toEqual(["log", "confirm", "fail"]);
  });

  it("exposes audited claim-release controls and paginated case events", () => {
    const reportRow = buildReportReviewPayload(report()).components![0] as {
      toJSON: () => { components: Array<{ custom_id?: string }> };
    };
    const appealRow = buildAppealReviewPayload(appeal(), moderationCase())
      .components![0] as {
      toJSON: () => { components: Array<{ custom_id?: string }> };
    };
    expect(
      parseReportComponentId(reportRow.toJSON().components[1]!.custom_id!),
    ).toMatchObject({ kind: "control", action: "release" });
    expect(
      parseAppealComponentId(appealRow.toJSON().components[1]!.custom_id!),
    ).toMatchObject({ kind: "control", action: "release" });

    const command = buildModerationCommandDefinition().toJSON();
    const inspectCase = command.options?.find(
      (option) => option.name === "case",
    );
    const page =
      inspectCase && "options" in inspectCase
        ? inspectCase.options?.find((option) => option.name === "page")
        : undefined;
    expect(page).toMatchObject({ min_value: 1, max_value: 10_000 });
  });
});
