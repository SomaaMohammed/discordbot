import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionFlagsBits, type Message } from "discord.js";
import type { GuildRuntime } from "../src/runtime.js";
import {
  clearAntiSpamProcessState,
  processAntiSpamMessage,
} from "../src/discord/anti-spam-enforcement.js";

const GUILD_ID = "12345678901234567";
const MEMBER_ID = "22345678901234567";
const BOT_ID = "32345678901234567";
const CHANNEL_ID = "42345678901234567";
const MESSAGE_ID = "52345678901234567";
const ROLE_ID = "72345678901234567";

afterEach(() => clearAntiSpamProcessState());

function harness(options: {
  action?: "delete" | "delete-and-warn" | "delete-and-timeout";
  deleteRejects?: boolean;
  caseRejects?: boolean;
  reservation?: Record<string, unknown>;
  moderatable?: boolean;
  flipGenerationOnDelete?: boolean;
  flipGenerationDuringFinalExemption?: boolean;
  alreadyTimedOut?: boolean;
}) {
  let current = true;
  let timedOut = options.alreadyTimedOut ?? false;
  const complete = vi.fn();
  const createCase = options.caseRejects
    ? vi.fn((_input: Record<string, unknown>) => {
        throw new Error("synthetic case persistence failure");
      })
    : vi.fn((_input: Record<string, unknown>) => ({
        caseId: "case_token",
        caseNumber: 7,
      }));
  const remove = options.deleteRejects
    ? vi.fn().mockRejectedValue(new Error("Discord delete failed"))
    : vi.fn(async () => {
        if (options.flipGenerationOnDelete) current = false;
      });
  const member = {
    id: MEMBER_ID,
    guild: null as unknown,
    permissions: { has: vi.fn(() => false) },
    roles: {
      cache: new Map(),
      highest: { comparePositionTo: vi.fn(() => -1) },
    },
    moderatable: options.moderatable ?? true,
    isCommunicationDisabled: vi.fn(() => timedOut),
    communicationDisabledUntil: timedOut
      ? new Date("2026-08-21T01:00:00.000Z")
      : null,
    timeout: vi.fn(async () => {
      timedOut = true;
      member.communicationDisabledUntil = new Date(Date.now() + 60_000);
    }),
    send: vi.fn().mockResolvedValue(undefined),
  };
  const botMember = {
    id: BOT_ID,
    guild: null as unknown,
    permissions: {
      has: vi.fn((permission: bigint) =>
        [PermissionFlagsBits.ModerateMembers].includes(permission),
      ),
    },
    roles: {
      highest: { comparePositionTo: vi.fn(() => 1) },
    },
  };
  const guild = {
    id: GUILD_ID,
    ownerId: "62345678901234567",
    members: {
      fetch: vi.fn().mockResolvedValue(member),
      fetchMe: vi.fn().mockResolvedValue(botMember),
    },
    channels: {
      fetch: vi.fn(async () => {
        current = false;
        return null;
      }),
    },
    roles: { fetch: vi.fn() },
  };
  member.guild = guild;
  botMember.guild = guild;

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
        action: options.action ?? "delete",
        timeoutSeconds: 60,
        cooldownSeconds: 30,
      },
    ]),
    listAntiSpamExemptRoleIds: vi.fn(() => []),
    listAntiSpamExemptChannelIds: vi
      .fn()
      .mockImplementation(() =>
        options.flipGenerationDuringFinalExemption &&
        storage.listAntiSpamExemptChannelIds.mock.calls.length === 2
          ? [CHANNEL_ID]
          : [],
      ),
    reserveAntiSpamEnforcement: vi.fn(() =>
      options.reservation
        ? options.reservation
        : { status: "reserved", reservationId: "reservation_token" },
    ),
    completeAntiSpamEnforcement: complete,
    createModerationCase: createCase,
    reserveModerationCaseAttempt: vi.fn(() => ({
      caseId: "timeout_attempt",
      caseNumber: 8,
      updatedAt: "2026-08-21T00:00:00.000Z",
    })),
    confirmModerationCase: vi.fn(() => ({
      status: "changed",
      case: {
        caseId: "timeout_attempt",
        caseNumber: 8,
        actionType: "automod-timeout",
      },
    })),
    failModerationCaseAttempt: vi.fn(),
  };
  const runtime = {
    guildId: GUILD_ID,
    storage,
    isCurrent: vi.fn(() => current),
  } as unknown as GuildRuntime;
  const message = {
    id: MESSAGE_ID,
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    guild,
    author: { id: MEMBER_ID, bot: false },
    webhookId: null,
    content: `<@${MEMBER_ID}> <@&${ROLE_ID}> private user supplied content`,
    createdTimestamp: 1_000,
    mentions: {
      users: { size: 1, has: vi.fn((id: string) => id === MEMBER_ID) },
      roles: { size: 1, has: vi.fn((id: string) => id === ROLE_ID) },
    },
    channel: {
      permissionsFor: vi.fn(() => ({ has: vi.fn(() => true) })),
    },
    delete: remove,
  } as unknown as Message;
  return {
    message,
    runtime,
    storage,
    complete,
    createCase,
    remove,
    member,
  };
}

describe("anti-spam enforcement", () => {
  it("counts repeated occurrences of the same resolved mention", async () => {
    const context = harness({ action: "delete" });
    (context.message as { content: string }).content =
      `<@${MEMBER_ID}> hello <@!${MEMBER_ID}>`;
    (
      context.message.mentions.roles as unknown as { has(id: string): boolean }
    ).has = vi.fn(() => false);

    await expect(
      processAntiSpamMessage(context.message, context.runtime),
    ).resolves.toBe("deleted");
    expect(context.storage.reserveAntiSpamEnforcement).toHaveBeenCalledWith(
      expect.objectContaining({ observedCount: 2 }),
    );
  });

  it("deletes a triggering message only after a persistent reservation", async () => {
    const context = harness({ action: "delete" });

    await expect(
      processAntiSpamMessage(context.message, context.runtime),
    ).resolves.toBe("deleted");
    expect(context.storage.reserveAntiSpamEnforcement).toHaveBeenCalledWith({
      ruleType: "mention",
      messageId: MESSAGE_ID,
      memberId: MEMBER_ID,
      channelId: CHANNEL_ID,
      observedCount: 2,
    });
    expect(context.remove).toHaveBeenCalledOnce();
    expect(context.complete).toHaveBeenCalledWith("reservation_token", {
      outcome: "deleted",
    });
  });

  it("does not claim enforcement when Discord rejects deletion", async () => {
    const context = harness({ action: "delete", deleteRejects: true });

    await expect(
      processAntiSpamMessage(context.message, context.runtime),
    ).resolves.toBe("continue");
    expect(context.complete).toHaveBeenCalledWith("reservation_token", {
      outcome: "failed",
      failureCode: "discord-delete",
    });
    expect(context.createCase).not.toHaveBeenCalled();
  });

  it("creates a real warning case without persisting raw message content", async () => {
    const context = harness({ action: "delete-and-warn" });

    await expect(
      processAntiSpamMessage(context.message, context.runtime),
    ).resolves.toBe("deleted");
    expect(context.createCase).toHaveBeenCalledOnce();
    const input = context.createCase.mock.calls[0]![0];
    expect(input).toMatchObject({
      targetUserId: MEMBER_ID,
      actorId: BOT_ID,
      actionType: "automod-warning",
      status: "active",
    });
    expect(JSON.stringify(input)).not.toContain(
      "private user supplied content",
    );
    expect(context.complete).toHaveBeenCalledWith("reservation_token", {
      outcome: "warned",
      caseId: "case_token",
    });
  });

  it("does not timeout after hierarchy becomes insufficient", async () => {
    const context = harness({
      action: "delete-and-timeout",
      moderatable: false,
    });

    await expect(
      processAntiSpamMessage(context.message, context.runtime),
    ).resolves.toBe("deleted");
    expect(context.member.timeout).not.toHaveBeenCalled();
    expect(context.createCase).not.toHaveBeenCalled();
    expect(context.complete).toHaveBeenCalledWith("reservation_token", {
      outcome: "deleted",
      failureCode: "timeout-authority",
    });
  });

  it("confirms a successful timeout through a reserved automod case", async () => {
    const context = harness({ action: "delete-and-timeout" });

    await expect(
      processAntiSpamMessage(context.message, context.runtime),
    ).resolves.toBe("deleted");
    expect(context.member.timeout).toHaveBeenCalledOnce();
    expect(context.storage.reserveModerationCaseAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: "automod-timeout" }),
    );
    expect(context.storage.confirmModerationCase).toHaveBeenCalledOnce();
    expect(context.complete).toHaveBeenCalledWith("reservation_token", {
      outcome: "timed-out",
      caseId: "timeout_attempt",
    });
  });

  it("does not overwrite an existing timeout", async () => {
    const context = harness({
      action: "delete-and-timeout",
      alreadyTimedOut: true,
    });

    await expect(
      processAntiSpamMessage(context.message, context.runtime),
    ).resolves.toBe("deleted");
    expect(context.member.timeout).not.toHaveBeenCalled();
    expect(context.storage.reserveModerationCaseAttempt).not.toHaveBeenCalled();
    expect(context.complete).toHaveBeenCalledWith("reservation_token", {
      outcome: "deleted",
      failureCode: "timeout-already-active",
    });
  });

  it("retains confirmed deletion semantics when warning persistence fails", async () => {
    const context = harness({ action: "delete-and-warn", caseRejects: true });

    await expect(
      processAntiSpamMessage(context.message, context.runtime),
    ).resolves.toBe("deleted");
    expect(context.complete).toHaveBeenCalledWith("reservation_token", {
      outcome: "deleted",
      failureCode: "case-persistence",
    });
  });

  it("treats a completed duplicate delivery as already handled", async () => {
    const context = harness({
      reservation: {
        status: "duplicate",
        enforcement: { state: "deleted" },
      },
    });

    await expect(
      processAntiSpamMessage(context.message, context.runtime),
    ).resolves.toBe("deleted");
    expect(context.remove).not.toHaveBeenCalled();
    expect(context.complete).not.toHaveBeenCalled();
  });

  it("rechecks the runtime after the final exemption fetch before deleting", async () => {
    const context = harness({
      action: "delete",
      flipGenerationDuringFinalExemption: true,
    });

    await expect(
      processAntiSpamMessage(context.message, context.runtime),
    ).resolves.toBe("continue");
    expect(context.remove).not.toHaveBeenCalled();
    expect(context.complete).toHaveBeenCalledWith("reservation_token", {
      outcome: "skipped",
      failureCode: "runtime-changed",
    });
  });

  it("does not create or notify a warning when generation changes during deletion", async () => {
    const context = harness({
      action: "delete-and-warn",
      flipGenerationOnDelete: true,
    });

    await expect(
      processAntiSpamMessage(context.message, context.runtime),
    ).resolves.toBe("deleted");
    expect(context.createCase).not.toHaveBeenCalled();
    expect(context.member.send).not.toHaveBeenCalled();
    expect(context.complete).toHaveBeenCalledWith("reservation_token", {
      outcome: "deleted",
      failureCode: "runtime-changed",
    });
  });

  it("suppresses normal processing while a duplicate reservation is active", async () => {
    const context = harness({
      reservation: {
        status: "duplicate",
        enforcement: { state: "reserved" },
      },
    });

    await expect(
      processAntiSpamMessage(context.message, context.runtime),
    ).resolves.toBe("suppressed");
    expect(context.remove).not.toHaveBeenCalled();
    expect(context.complete).not.toHaveBeenCalled();
  });
});
