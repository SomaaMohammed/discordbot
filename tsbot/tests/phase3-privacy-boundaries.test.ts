import { PermissionFlagsBits, type Message } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GuildRuntime } from "../src/runtime.js";
import type { CaseAppeal, MemberReport, ModerationCase } from "../src/types.js";
import {
  clearAntiSpamProcessState,
  processAntiSpamMessage,
} from "../src/discord/anti-spam-enforcement.js";
import { buildAppealCommandDefinition } from "../src/discord/appeal-command.js";
import {
  appealVersionToken,
  buildAppealControlRow,
  buildAppealReviewPayload,
  createAppealDecisionModal,
  createAppealSubmitModal,
} from "../src/discord/appeal-components.js";
import { buildModerationCaseLogPayload } from "../src/discord/moderation-log-delivery.js";
import { buildReportCommandDefinition } from "../src/discord/report-command.js";
import {
  buildReportControlRow,
  buildReportReviewPayload,
  createReportDecisionModal,
  createReportSubmitModal,
  reportVersionToken,
} from "../src/discord/report-components.js";

const GUILD_ID = "12345678901234567890";
const MEMBER_ID = "22345678901234567890";
const TARGET_ID = "32345678901234567890";
const BOT_ID = "42345678901234567890";
const CHANNEL_ID = "52345678901234567890";
const MESSAGE_ID = "62345678901234567890";
const NOW = "2026-08-13T00:00:00.000Z";
const RAW_CONTENT = "raw-message-content-private-sentinel";
const PRIVATE_NOTE = "moderation-private-note-sentinel";
const PRIVATE_VOID_REASON = "moderation-private-void-sentinel";
const PRIVATE_OVERTURN_REASON = "moderation-private-overturn-sentinel";
const MENTION_TEXT = `@everyone <@${MEMBER_ID}>`;

const MODERATION_CASE: ModerationCase = {
  guildId: GUILD_ID,
  caseId: "case_token_123",
  caseNumber: 42,
  targetUserId: TARGET_ID,
  actorId: MEMBER_ID,
  actionType: "warning",
  source: "moderation-command",
  publicReason: `**Public** [reason](https://example.com) ${MENTION_TEXT}`,
  privateNote: PRIVATE_NOTE,
  discordActionMetadata: {},
  status: "overturned",
  relatedCaseId: null,
  voidedBy: MEMBER_ID,
  voidedAt: NOW,
  voidReason: PRIVATE_VOID_REASON,
  overturnedBy: MEMBER_ID,
  overturnedAt: NOW,
  overturnReason: PRIVATE_OVERTURN_REASON,
  createdAt: NOW,
  updatedAt: NOW,
};

const REPORT: MemberReport = {
  guildId: GUILD_ID,
  reportId: "report_token_123",
  reportNumber: 7,
  reporterId: MEMBER_ID,
  targetUserId: TARGET_ID,
  category: "safety",
  explanation: `Private report ${MENTION_TEXT}`,
  evidenceGuildId: null,
  evidenceChannelId: null,
  evidenceMessageId: null,
  state: "submitted",
  deliveryState: "posted",
  reviewChannelId: CHANNEL_ID,
  reviewMessageId: MESSAGE_ID,
  claimedBy: null,
  claimedAt: null,
  decisionBy: null,
  decisionReason: null,
  decidedAt: null,
  linkedCaseId: MODERATION_CASE.caseId,
  withdrawnAt: null,
  failureCode: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const APPEAL: CaseAppeal = {
  guildId: GUILD_ID,
  appealId: "appeal_token_123",
  appealNumber: 9,
  caseId: MODERATION_CASE.caseId,
  appellantId: TARGET_ID,
  explanation: `Private appeal ${MENTION_TEXT}`,
  state: "submitted",
  deliveryState: "posted",
  reviewChannelId: CHANNEL_ID,
  reviewMessageId: MESSAGE_ID,
  claimedBy: null,
  claimedAt: null,
  decisionBy: null,
  decisionReason: null,
  decidedAt: null,
  reversalCaseId: null,
  withdrawnAt: null,
  failureCode: null,
  createdAt: NOW,
  updatedAt: NOW,
};

afterEach(() => {
  clearAntiSpamProcessState();
  vi.restoreAllMocks();
});

describe("Phase 3 privacy boundaries", () => {
  it("keeps private case fields out of moderation logs and escapes public Markdown", () => {
    const payload = buildModerationCaseLogPayload(MODERATION_CASE);
    const serialized = JSON.stringify(payload);
    const embed = payload.embeds?.[0];
    const description = embed
      ? (("toJSON" in embed ? embed.toJSON() : embed).description ?? "")
      : "";

    expect(serialized).not.toContain(PRIVATE_NOTE);
    expect(serialized).not.toContain(PRIVATE_VOID_REASON);
    expect(serialized).not.toContain(PRIVATE_OVERTURN_REASON);
    expect(description).not.toContain("**Public**");
    expect(description).toContain("\\*\\*Public\\*\\*");
    expect(payload.allowedMentions).toEqual({ parse: [] });
  });

  it("suppresses mentions in report and appeal payloads without exposing case-private fields", () => {
    const reportPayload = buildReportReviewPayload(REPORT);
    const appealPayload = buildAppealReviewPayload(APPEAL, MODERATION_CASE);
    const serialized = JSON.stringify({ reportPayload, appealPayload });

    expect(reportPayload.allowedMentions).toEqual({ parse: [] });
    expect(appealPayload.allowedMentions).toEqual({ parse: [] });
    expect(serialized).not.toContain("@everyone");
    expect(serialized).not.toContain(`<@${MEMBER_ID}>`);
    expect(serialized).not.toContain(PRIVATE_NOTE);
    expect(serialized).not.toContain(PRIVATE_VOID_REASON);
    expect(serialized).not.toContain(PRIVATE_OVERTURN_REASON);
  });

  it("never serializes raw message content through an anti-spam failure log", async () => {
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const member = {
      id: MEMBER_ID,
      guild: null as unknown,
      permissions: { has: vi.fn(() => false) },
      roles: { cache: new Map() },
    };
    const guild = {
      id: GUILD_ID,
      ownerId: "72345678901234567890",
      members: {
        fetch: vi.fn(async () => member),
        fetchMe: vi.fn(),
      },
      channels: { fetch: vi.fn() },
      roles: { fetch: vi.fn() },
    };
    member.guild = guild;
    const storage = {
      getModerationConfiguration: vi.fn(() => ({
        casesEnabled: true,
        antiSpamEnabled: true,
      })),
      listAntiSpamRules: vi.fn(() => [
        {
          ruleType: "mention",
          enabled: true,
          threshold: 2,
          windowSeconds: null,
          action: "delete",
          timeoutSeconds: null,
          cooldownSeconds: 30,
        },
      ]),
      listAntiSpamExemptRoleIds: vi.fn(() => []),
      listAntiSpamExemptChannelIds: vi.fn(() => []),
      reserveAntiSpamEnforcement: vi.fn(() => {
        throw new Error(`persistence failed: ${RAW_CONTENT}`);
      }),
    };
    const runtime = {
      guildId: GUILD_ID,
      storage,
      isCurrent: vi.fn(() => true),
    } as unknown as GuildRuntime;
    const message = {
      id: MESSAGE_ID,
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      guild,
      author: { id: MEMBER_ID, bot: false },
      webhookId: null,
      content: `<@${MEMBER_ID}> <@&${TARGET_ID}> ${RAW_CONTENT}`,
      createdTimestamp: 1_000,
      mentions: {
        users: { size: 1, has: vi.fn((id: string) => id === MEMBER_ID) },
        roles: { size: 1, has: vi.fn((id: string) => id === TARGET_ID) },
      },
    } as unknown as Message;

    await expect(processAntiSpamMessage(message, runtime)).resolves.toBe(
      "continue",
    );

    expect(errorLog).toHaveBeenCalledOnce();
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(RAW_CONTENT);
    expect(
      JSON.stringify(storage.reserveAntiSpamEnforcement.mock.calls),
    ).not.toContain(RAW_CONTENT);
  });

  it("keeps report and appeal commands and maximal component IDs within Discord limits", () => {
    const opaqueId = "x".repeat(24);
    const panelId = "p".repeat(24);
    const reportToken = reportVersionToken(NOW);
    const appealToken = appealVersionToken(NOW);
    const definitions = [
      buildReportCommandDefinition().toJSON(),
      buildAppealCommandDefinition().toJSON(),
    ];
    const componentJson = [
      createReportSubmitModal(panelId, TARGET_ID, MESSAGE_ID).toJSON(),
      createReportDecisionModal(
        opaqueId,
        "dismiss",
        reportToken,
        MESSAGE_ID,
      ).toJSON(),
      buildReportControlRow(opaqueId, reportToken).toJSON(),
      createAppealSubmitModal(panelId, 2_147_483_647, MESSAGE_ID).toJSON(),
      createAppealDecisionModal(
        opaqueId,
        "overturn",
        appealToken,
        MESSAGE_ID,
      ).toJSON(),
      buildAppealControlRow(opaqueId, appealToken).toJSON(),
    ];

    for (const definition of definitions) assertCommandLimits(definition);
    const customIds = collectCustomIds(componentJson);
    expect(customIds.length).toBeGreaterThan(0);
    for (const customId of customIds) {
      expect(customId.length).toBeGreaterThan(0);
      expect(customId.length).toBeLessThanOrEqual(100);
    }
  });
});

function assertCommandLimits(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (typeof record.name === "string") {
    expect(record.name.length).toBeGreaterThan(0);
    expect(record.name.length).toBeLessThanOrEqual(32);
  }
  if (typeof record.description === "string") {
    expect(record.description.length).toBeGreaterThan(0);
    expect(record.description.length).toBeLessThanOrEqual(100);
  }
  if (Array.isArray(record.options)) {
    expect(record.options.length).toBeLessThanOrEqual(25);
    for (const option of record.options) assertCommandLimits(option);
  }
}

function collectCustomIds(value: unknown, result: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectCustomIds(item, result);
    return result;
  }
  if (!value || typeof value !== "object") return result;
  const record = value as Record<string, unknown>;
  if (typeof record.custom_id === "string") result.push(record.custom_id);
  for (const item of Object.values(record)) collectCustomIds(item, result);
  return result;
}
