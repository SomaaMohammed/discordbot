import { ChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { GuildRuntime } from "../src/runtime.js";
import type { ModerationCase } from "../src/types.js";
import {
  buildModerationCaseLogPayload,
  deliverModerationCaseLog,
} from "../src/discord/moderation-log-delivery.js";

const CASE: ModerationCase = {
  guildId: "12345678901234567",
  caseId: "case_token",
  caseNumber: 42,
  targetUserId: "22345678901234567",
  actorId: "32345678901234567",
  actionType: "warning",
  source: "moderation-command",
  publicReason: "A bounded member-facing reason.",
  privateNote: "private-note-sentinel",
  discordActionMetadata: {},
  status: "overturned",
  relatedCaseId: null,
  voidedBy: null,
  voidedAt: null,
  voidReason: "private-void-sentinel",
  overturnedBy: "32345678901234567",
  overturnedAt: "2026-08-13T00:00:00.000Z",
  overturnReason: "private-overturn-sentinel",
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-13T00:00:00.000Z",
};

describe("moderation case log delivery", () => {
  it("renders only the approved public case fields", () => {
    const payload = buildModerationCaseLogPayload(CASE);
    const serialized = JSON.stringify(payload);

    expect(serialized).toContain(CASE.publicReason);
    expect(serialized).toContain("Moderation Case #42");
    expect(serialized).not.toContain("private-note-sentinel");
    expect(serialized).not.toContain("private-void-sentinel");
    expect(serialized).not.toContain("private-overturn-sentinel");
    expect(payload.allowedMentions).toEqual({ parse: [] });
  });

  it("reposts a deleted checkpoint using the fresh missing-state version", async () => {
    const bot = { id: "42345678901234567", guild: null as unknown };
    const sent = {
      id: "52345678901234567",
      delete: vi.fn(async () => undefined),
    };
    const channel = {
      id: "62345678901234567",
      type: ChannelType.GuildText,
      guild: null as unknown,
      permissionsFor: vi.fn(() => ({ has: vi.fn(() => true) })),
      messages: {
        fetch: vi.fn(async () => {
          throw Object.assign(new Error("Unknown Message"), { code: 10_008 });
        }),
      },
      send: vi.fn(async () => sent),
    };
    const guild = {
      id: CASE.guildId,
      client: { user: { id: bot.id } },
      channels: { fetch: vi.fn(async () => channel) },
      members: { fetchMe: vi.fn(async () => bot) },
    };
    bot.guild = guild;
    channel.guild = guild;
    const delivered = {
      guildId: CASE.guildId,
      caseId: CASE.caseId,
      state: "delivered" as const,
      channelId: channel.id,
      messageId: "72345678901234567",
      attemptCount: 1,
      lastFailureCode: null,
      deliveredAt: "2026-08-13T00:00:00.000Z",
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
    };
    const missing = {
      ...delivered,
      state: "missing" as const,
      messageId: null,
      deliveredAt: null,
      updatedAt: "2026-08-13T00:01:00.000Z",
    };
    const completed = {
      ...delivered,
      messageId: sent.id,
      updatedAt: "2026-08-13T00:02:00.000Z",
    };
    const claimed = {
      ...missing,
      updatedAt: "2026-08-13T00:01:30.000Z",
    };
    const attempted = {
      ...claimed,
      updatedAt: "2026-08-13T00:01:45.000Z",
    };
    const begin = vi.fn(() => ({
      status: "changed" as const,
      record: attempted,
      attempt: {
        attemptId: "moderation_log_attempt",
        channelId: channel.id,
        startedAt: claimed.updatedAt,
      },
    }));
    const storage = {
      getModerationConfiguration: vi.fn(() => ({
        guildId: CASE.guildId,
        moderationLogChannelId: channel.id,
        moderationLogVerifiedAt: "2026-08-13T00:00:00.000Z",
      })),
      getModerationLogDelivery: vi.fn(() => delivered),
      markModerationLogDeliveryMissing: vi.fn(() => missing),
      claimModerationLogDelivery: vi.fn(() => ({
        status: "claimed" as const,
        claimId: "delivery_claim_token",
        retryAt: "2026-08-13T00:03:30.000Z",
        record: claimed,
      })),
      getModerationLogDeliveryAttempt: vi.fn(() => null),
      beginModerationLogDeliveryAttempt: begin,
      completeModerationLogDelivery: vi.fn(() => completed),
      failModerationLogDelivery: vi.fn(),
      checkpointModerationLogDeliveryOrphan: vi.fn(),
    };
    const runtime = {
      guildId: CASE.guildId,
      storage,
      isCurrent: vi.fn(() => true),
    } as unknown as GuildRuntime;

    await expect(
      deliverModerationCaseLog(guild as never, runtime, CASE),
    ).resolves.toBe("delivered");
    expect(storage.completeModerationLogDelivery).toHaveBeenCalledWith(
      CASE.caseId,
      {
        channelId: channel.id,
        messageId: sent.id,
        claimId: "delivery_claim_token",
        expectedUpdatedAt: attempted.updatedAt,
      },
    );
    expect(storage.claimModerationLogDelivery).toHaveBeenCalledWith(
      CASE.caseId,
      { expectedUpdatedAt: missing.updatedAt },
    );
    expect(begin).toHaveBeenCalledWith(CASE.caseId, {
      channelId: channel.id,
      claimId: "delivery_claim_token",
      expectedUpdatedAt: claimed.updatedAt,
    });
    expect(channel.send).toHaveBeenCalledWith(
      expect.objectContaining({
        nonce: "moderation_log_attempt",
        enforceNonce: true,
      }),
    );
  });

  it("does not send while another persistent delivery claim is active", async () => {
    const bot = { id: "42345678901234567", guild: null as unknown };
    const channel = {
      id: "62345678901234567",
      type: ChannelType.GuildText,
      guild: null as unknown,
      permissionsFor: vi.fn(() => ({ has: vi.fn(() => true) })),
      messages: { fetch: vi.fn() },
      send: vi.fn(),
    };
    const guild = {
      id: CASE.guildId,
      client: { user: { id: bot.id } },
      channels: { fetch: vi.fn(async () => channel) },
      members: { fetchMe: vi.fn(async () => bot) },
    };
    bot.guild = guild;
    channel.guild = guild;
    const pending = {
      guildId: CASE.guildId,
      caseId: CASE.caseId,
      state: "pending" as const,
      channelId: null,
      messageId: null,
      attemptCount: 0,
      lastFailureCode: null,
      deliveredAt: null,
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
    };
    const storage = {
      getModerationConfiguration: vi.fn(() => ({
        guildId: CASE.guildId,
        moderationLogChannelId: channel.id,
        moderationLogVerifiedAt: "2026-08-13T00:00:00.000Z",
      })),
      getModerationLogDelivery: vi.fn(() => pending),
      claimModerationLogDelivery: vi.fn(() => ({
        status: "busy" as const,
        claimId: null,
        retryAt: "2026-08-13T00:02:00.000Z",
        record: pending,
      })),
      completeModerationLogDelivery: vi.fn(),
      failModerationLogDelivery: vi.fn(),
      markModerationLogDeliveryMissing: vi.fn(),
    };
    const runtime = {
      guildId: CASE.guildId,
      storage,
      isCurrent: vi.fn(() => true),
    } as unknown as GuildRuntime;

    await expect(
      deliverModerationCaseLog(guild as never, runtime, CASE),
    ).resolves.toBe("unavailable");
    expect(channel.send).not.toHaveBeenCalled();
    expect(storage.completeModerationLogDelivery).not.toHaveBeenCalled();
  });

  it("does not mark or repost a tracked message after an ambiguous fetch failure", async () => {
    const bot = { id: "42345678901234567", guild: null as unknown };
    const channel = {
      id: "62345678901234567",
      type: ChannelType.GuildText,
      guild: null as unknown,
      permissionsFor: vi.fn(() => ({ has: vi.fn(() => true) })),
      messages: {
        fetch: vi.fn(async () => {
          throw Object.assign(new Error("socket reset"), {
            code: "ECONNRESET",
          });
        }),
      },
      send: vi.fn(),
    };
    const guild = {
      id: CASE.guildId,
      client: { user: { id: bot.id } },
      channels: { fetch: vi.fn(async () => channel) },
      members: { fetchMe: vi.fn(async () => bot) },
    };
    bot.guild = guild;
    channel.guild = guild;
    const delivered = {
      guildId: CASE.guildId,
      caseId: CASE.caseId,
      state: "delivered" as const,
      channelId: channel.id,
      messageId: "72345678901234567",
      attemptCount: 1,
      lastFailureCode: null,
      deliveredAt: "2026-08-13T00:00:00.000Z",
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
    };
    const storage = {
      getModerationConfiguration: vi.fn(() => ({
        guildId: CASE.guildId,
        moderationLogChannelId: channel.id,
        moderationLogVerifiedAt: "2026-08-13T00:00:00.000Z",
      })),
      getModerationLogDelivery: vi.fn(() => delivered),
      claimModerationLogDelivery: vi.fn(),
      completeModerationLogDelivery: vi.fn(),
      failModerationLogDelivery: vi.fn(),
      markModerationLogDeliveryMissing: vi.fn(),
    };
    const runtime = {
      guildId: CASE.guildId,
      storage,
      isCurrent: vi.fn(() => true),
    } as unknown as GuildRuntime;

    await expect(
      deliverModerationCaseLog(guild as never, runtime, CASE),
    ).resolves.toBe("unavailable");
    expect(storage.markModerationLogDeliveryMissing).not.toHaveBeenCalled();
    expect(storage.claimModerationLogDelivery).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
  });
});
