import { describe, expect, it, vi } from "vitest";
import {
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { GuildRuntime } from "../src/runtime.js";
import type {
  ModerationCase,
  ModerationConfiguration,
  ModerationCaseInput,
} from "../src/types.js";
import { handleModerationCaseCommand } from "../src/discord/moderation-commands-handler.js";

const GUILD_ID = "123456789012345678";
const OWNER_ID = "223456789012345678";
const ACTOR_ID = "323456789012345678";
const TARGET_ID = "423456789012345678";
const BOT_ID = "523456789012345678";
const ROLE_ID = "623456789012345678";
const NOW = "2026-08-21T00:00:00.000Z";

function configuration(
  overrides: Partial<ModerationConfiguration> = {},
): ModerationConfiguration {
  return {
    guildId: GUILD_ID,
    casesEnabled: true,
    moderationLogChannelId: null,
    moderationLogVerifiedAt: null,
    reportsEnabled: false,
    reportReviewChannelId: null,
    reportReviewerRoleId: null,
    reportBindingsVerifiedAt: null,
    appealsEnabled: false,
    appealReviewChannelId: null,
    appealReviewerRoleId: null,
    appealBindingsVerifiedAt: null,
    antiSpamEnabled: false,
    reportCooldownLimit: 3,
    reportCooldownWindowSeconds: 1_800,
    createdBy: OWNER_ID,
    updatedBy: OWNER_ID,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function moderationCase(
  overrides: Partial<ModerationCase> = {},
): ModerationCase {
  return {
    guildId: GUILD_ID,
    caseId: "case_token_1",
    caseNumber: 1,
    targetUserId: TARGET_ID,
    actorId: OWNER_ID,
    actionType: "warning",
    source: "moderation-command",
    publicReason: "reason",
    privateNote: null,
    discordActionMetadata: null,
    status: "active",
    relatedCaseId: null,
    voidedBy: null,
    voidedAt: null,
    voidReason: null,
    overturnedBy: null,
    overturnedAt: null,
    overturnReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function harness(options: {
  subcommand: string;
  actor?: "owner" | "delegated";
  target?: "member" | "self" | "owner" | "bot" | "above";
  page?: number;
  timedOut?: boolean;
  banned?: boolean;
  configValues?: ModerationConfiguration[];
  cases?: ModerationCase[];
  selectedCase?: ModerationCase | null;
}) {
  let timedOut = options.timedOut ?? false;
  let expiry = timedOut ? new Date("2026-08-21T01:00:00.000Z") : null;
  let banned = options.banned ?? true;
  const actorId = options.actor === "delegated" ? ACTOR_ID : OWNER_ID;
  const delegatedRole = {
    id: ROLE_ID,
    guild: null as unknown,
    managed: false,
  };
  const actor = {
    id: actorId,
    guild: null as unknown,
    user: { id: actorId, bot: false },
    permissions: { has: vi.fn(() => false) },
    roles: {
      cache: new Map([[ROLE_ID, delegatedRole]]),
      highest: {
        comparePositionTo: vi.fn(() => (options.target === "above" ? -1 : 1)),
      },
    },
  };
  const targetId =
    options.target === "self"
      ? actorId
      : options.target === "owner"
        ? OWNER_ID
        : options.target === "bot"
          ? BOT_ID
          : TARGET_ID;
  const target = {
    id: targetId,
    guild: null as unknown,
    user: { id: targetId, bot: options.target === "bot" },
    displayName: "Target display",
    permissions: { has: vi.fn(() => false) },
    roles: {
      cache: new Map(),
      highest: {},
    },
    moderatable: true,
    kickable: true,
    bannable: true,
    isCommunicationDisabled: vi.fn(() => timedOut),
    timeout: vi.fn(async (duration: number | null) => {
      timedOut = duration !== null;
      expiry = duration === null ? null : new Date(Date.parse(NOW) + duration);
    }),
    kick: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    get communicationDisabledUntil() {
      return expiry;
    },
  };
  const bot = {
    id: BOT_ID,
    guild: null as unknown,
    user: { id: BOT_ID, bot: true },
    permissions: { has: vi.fn(() => true) },
    roles: { cache: new Map(), highest: {} },
  };
  const guild = {
    id: GUILD_ID,
    ownerId: OWNER_ID,
    name: "Guild",
    client: { user: { id: BOT_ID }, users: { fetch: vi.fn() } },
    members: {
      fetch: vi.fn(async ({ user }: { user: string }) => {
        if (user === actorId) return actor;
        if (user === BOT_ID) return options.target === "bot" ? target : bot;
        if (user === OWNER_ID && actorId !== OWNER_ID)
          return options.target === "owner" ? target : null;
        return target;
      }),
      fetchMe: vi.fn(async () => bot),
    },
    channels: { fetch: vi.fn(async () => null) },
    roles: {
      everyone: { id: GUILD_ID },
      fetch: vi.fn(async (id: string) =>
        id === ROLE_ID ? delegatedRole : null,
      ),
    },
    bans: {
      fetch: vi.fn(async () => {
        if (banned) return { user: { id: targetId } };
        throw Object.assign(new Error("Unknown Ban"), { code: 10_026 });
      }),
      remove: vi.fn(async () => {
        banned = false;
      }),
      create: vi.fn(async () => undefined),
    },
  };
  actor.guild = guild;
  target.guild = guild;
  bot.guild = guild;
  delegatedRole.guild = guild;

  const configValues = options.configValues ?? [configuration()];
  let configRead = 0;
  const getConfiguration = vi.fn(
    () => configValues[Math.min(configRead++, configValues.length - 1)] ?? null,
  );
  const cases = options.cases ?? [];
  const findUniqueActive = vi.fn(
    (_targetUserId: string, actionTypes: readonly string[]) => {
      const matches = cases.filter(
        (record) =>
          record.status === "active" && actionTypes.includes(record.actionType),
      );
      return matches.length === 0
        ? { status: "none" as const, case: null }
        : matches.length === 1
          ? { status: "found" as const, case: matches[0]! }
          : { status: "ambiguous" as const, case: null };
    },
  );
  let number = 10;
  const createCase = vi.fn((input: ModerationCaseInput) =>
    moderationCase({
      ...input,
      caseId: `case_created_${number}`,
      caseNumber: number++,
      privateNote: input.privateNote ?? null,
      relatedCaseId: input.relatedCaseId ?? null,
      discordActionMetadata: input.discordActionMetadata ?? null,
    }),
  );
  const reserve = vi.fn((input: Omit<ModerationCaseInput, "status">) =>
    moderationCase({
      ...input,
      caseId: `case_attempt_${number}`,
      caseNumber: number++,
      status: "failed",
      privateNote: input.privateNote ?? null,
      relatedCaseId: input.relatedCaseId ?? null,
      discordActionMetadata: input.discordActionMetadata ?? null,
    }),
  );
  const confirm = vi.fn(
    (caseId: string, input: { status: "active" | "completed" }) => ({
      status: "changed" as const,
      case: moderationCase({
        caseId,
        caseNumber: 10,
        actionType:
          options.subcommand === "ban"
            ? "ban"
            : options.subcommand === "kick"
              ? "kick"
              : "timeout",
        status: input.status,
      }),
    }),
  );
  const finalizeTimeout = vi.fn((caseId: string) => ({
    status: "changed" as const,
    removalCase: moderationCase({
      caseId,
      caseNumber: 10,
      actionType: "timeout-removed",
      status: "completed",
    }),
    originalCase: moderationCase({
      caseId: "original_timeout",
      actionType: "timeout",
      status: "completed",
    }),
  }));
  const finalizeBan = vi.fn((caseId: string) => ({
    status: "changed" as const,
    removalCase: moderationCase({
      caseId,
      caseNumber: 10,
      actionType: "unban",
      status: "completed",
    }),
    originalCase: moderationCase({
      caseId: "original_ban",
      actionType: "ban",
      status: "completed",
    }),
  }));
  const voidCase = vi.fn((caseId: string) => ({
    status: "changed" as const,
    case: moderationCase({ caseId, status: "voided" }),
  }));
  const amendCase = vi.fn((caseId: string) => ({
    status: "changed" as const,
    case: moderationCase({ caseId, publicReason: "amended" }),
  }));
  const completeExpired = vi.fn((caseId: string) => ({
    status: "changed" as const,
    case: moderationCase({
      ...(cases.find((record) => record.caseId === caseId) ?? {}),
      caseId,
      status: "completed",
    }),
  }));
  const storage = {
    listCapabilitiesForRoles: vi.fn(() =>
      options.actor === "delegated"
        ? [
            {
              guildId: GUILD_ID,
              principalType: "role",
              principalId: ROLE_ID,
              roleId: ROLE_ID,
              capability: "moderation.manage",
              active: true,
            },
          ]
        : [],
    ),
    getModerationConfiguration: getConfiguration,
    createModerationCase: createCase,
    reserveModerationCaseAttempt: reserve,
    confirmModerationCase: confirm,
    failModerationCaseAttempt: vi.fn(() => ({
      status: "changed",
      case: moderationCase(),
    })),
    finalizeTimeoutRemovalCase: finalizeTimeout,
    finalizeBanRemovalCase: finalizeBan,
    completeModerationCase: vi.fn(),
    listModerationCases: vi.fn(() => cases),
    findUniqueActiveModerationCase: findUniqueActive,
    completeExpiredTimeoutCase: completeExpired,
    getModerationCaseByNumber: vi.fn(() => options.selectedCase ?? null),
    listModerationCaseEvents: vi.fn(() => [
      {
        guildId: GUILD_ID,
        caseId: "case_token_1",
        eventId: "event_token_1",
        eventNumber: 1,
        type: "created",
        actorId,
        details: null,
        createdAt: NOW,
      },
    ]),
    amendModerationCase: amendCase,
    voidModerationCase: voidCase,
    getModerationLogDelivery: vi.fn(() => null),
    recordCommandMetric: vi.fn(),
  };
  const editReply = vi.fn(async () => undefined);
  const interaction = {
    guild,
    guildId: GUILD_ID,
    user: { id: actorId },
    deferred: false,
    replied: false,
    deferReply: vi.fn(async function (this: { deferred: boolean }) {
      this.deferred = true;
    }),
    editReply,
    options: {
      getSubcommand: vi.fn(() => options.subcommand),
      getUser: vi.fn(() => ({ id: targetId })),
      getString: vi.fn((name: string) =>
        name === "reason"
          ? "bounded reason"
          : name === "private_note"
            ? options.subcommand === "note"
              ? "private note"
              : null
            : name === "public_reason"
              ? "amended reason"
              : name === "user_id"
                ? TARGET_ID
                : null,
      ),
      getInteger: vi.fn((name: string) =>
        name === "minutes"
          ? 60
          : name === "delete_message_seconds"
            ? 0
            : name === "page"
              ? (options.page ?? 1)
              : name === "case_number"
                ? 1
                : null,
      ),
    },
  } as unknown as ChatInputCommandInteraction;
  const runtime = {
    guildId: GUILD_ID,
    storage,
    isCurrent: vi.fn(() => true),
    invalidate: vi.fn(),
  } as unknown as GuildRuntime;
  return {
    interaction,
    runtime,
    storage,
    target,
    guild,
    createCase,
    reserve,
    confirm,
    finalizeTimeout,
    finalizeBan,
    voidCase,
    amendCase,
    editReply,
    completeExpired,
    setTimedOut(value: boolean): void {
      timedOut = value;
      expiry = value ? new Date("2026-08-21T01:00:00.000Z") : null;
    },
  };
}

describe("Phase 3 moderation command handler", () => {
  it.each([
    ["warn", "warning", "active"],
    ["note", "note", "completed"],
  ] as const)(
    "records %s without a Discord sanction",
    async (subcommand, actionType, status) => {
      const context = harness({ subcommand });
      await handleModerationCaseCommand(context.interaction, context.runtime);
      expect(context.createCase).toHaveBeenCalledWith(
        expect.objectContaining({ actionType, status }),
      );
      expect(context.reserve).not.toHaveBeenCalled();
    },
  );

  it.each(["timeout", "kick", "ban"] as const)(
    "reserves, performs, and confirms %s",
    async (subcommand) => {
      const context = harness({ subcommand });
      await handleModerationCaseCommand(context.interaction, context.runtime);
      expect(context.reserve).toHaveBeenCalledWith(
        expect.objectContaining({ actionType: subcommand }),
      );
      expect(context.confirm).toHaveBeenCalledOnce();
      if (subcommand === "timeout")
        expect(context.target.timeout).toHaveBeenCalled();
      if (subcommand === "kick") expect(context.target.kick).toHaveBeenCalled();
      if (subcommand === "ban")
        expect(context.guild.bans.create).toHaveBeenCalled();
    },
  );

  it("lets a non-Administrator delegated moderator timeout using bot authority and hierarchy", async () => {
    const context = harness({ subcommand: "timeout", actor: "delegated" });
    await handleModerationCaseCommand(context.interaction, context.runtime);
    expect(context.target.timeout).toHaveBeenCalledOnce();
    expect(context.confirm).toHaveBeenCalledOnce();
  });

  it("atomically finalizes a matching timeout removal", async () => {
    const original = moderationCase({
      caseId: "original_timeout",
      actionType: "timeout",
      status: "active",
      discordActionMetadata: { expiresAt: "2026-08-21T01:00:00.000Z" },
    });
    const context = harness({
      subcommand: "untimeout",
      timedOut: true,
      cases: [original],
    });
    await handleModerationCaseCommand(context.interaction, context.runtime);
    expect(context.target.timeout).toHaveBeenCalledWith(null, "bounded reason");
    expect(context.finalizeTimeout).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ originalCaseId: original.caseId }),
    );
  });

  it("atomically finalizes an unban with its active ban case", async () => {
    const original = moderationCase({
      caseId: "original_ban",
      actionType: "ban",
      status: "active",
    });
    const context = harness({ subcommand: "unban", cases: [original] });
    await handleModerationCaseCommand(context.interaction, context.runtime);
    expect(context.guild.bans.remove).toHaveBeenCalledOnce();
    expect(context.finalizeBan).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ originalCaseId: original.caseId }),
    );
    expect(context.confirm).not.toHaveBeenCalled();
  });

  it("completes a naturally expired timeout without creating a removal case", async () => {
    const original = moderationCase({
      caseId: "expired_timeout",
      actionType: "timeout",
      status: "active",
      discordActionMetadata: { expiresAt: "2020-01-01T00:00:00.000Z" },
    });
    const context = harness({
      subcommand: "untimeout",
      timedOut: false,
      cases: [original],
    });

    await handleModerationCaseCommand(context.interaction, context.runtime);

    expect(context.completeExpired).toHaveBeenCalledWith(
      original.caseId,
      expect.objectContaining({ expectedUpdatedAt: original.updatedAt }),
    );
    expect(context.target.timeout).not.toHaveBeenCalled();
    expect(context.reserve).not.toHaveBeenCalled();
    expect(context.finalizeTimeout).not.toHaveBeenCalled();
  });

  it("atomically reconciles an already-absent ban with its active ban case", async () => {
    const original = moderationCase({
      caseId: "original_ban",
      actionType: "ban",
      status: "active",
    });
    const context = harness({
      subcommand: "unban",
      banned: false,
      cases: [original],
    });

    await handleModerationCaseCommand(context.interaction, context.runtime);

    expect(context.guild.bans.remove).not.toHaveBeenCalled();
    expect(context.finalizeBan).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ originalCaseId: original.caseId }),
    );
  });

  it("serializes concurrent same-target timeouts before the Discord mutation", async () => {
    const context = harness({ subcommand: "timeout" });
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let signalEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    context.target.timeout.mockImplementationOnce(async () => {
      signalEntered();
      await firstMayFinish;
      context.setTimedOut(true);
    });

    const first = handleModerationCaseCommand(
      context.interaction,
      context.runtime,
    );
    await firstEntered;
    const second = handleModerationCaseCommand(
      context.interaction,
      context.runtime,
    );
    await Promise.resolve();

    expect(context.target.timeout).toHaveBeenCalledTimes(1);
    expect(context.reserve).toHaveBeenCalledTimes(1);

    releaseFirst();
    await Promise.all([first, second]);

    expect(context.target.timeout).toHaveBeenCalledTimes(1);
    expect(context.confirm).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["self", "cannot target yourself"],
    ["owner", "server owner"],
    ["bot", "Bots cannot be targeted"],
    ["above", "highest role"],
  ] as const)("rejects %s targets", async (target, message) => {
    const context = harness({ subcommand: "warn", actor: "delegated", target });
    await handleModerationCaseCommand(context.interaction, context.runtime);
    expect(context.createCase).not.toHaveBeenCalled();
    expect(context.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining(message) }),
    );
  });

  it("applies history and case-event pagination offsets", async () => {
    const history = harness({ subcommand: "history", page: 3 });
    await handleModerationCaseCommand(history.interaction, history.runtime);
    expect(history.storage.listModerationCases).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10, offset: 20 }),
    );

    const selected = moderationCase();
    const details = harness({
      subcommand: "case",
      page: 4,
      selectedCase: selected,
    });
    await handleModerationCaseCommand(details.interaction, details.runtime);
    expect(details.storage.listModerationCaseEvents).toHaveBeenCalledWith(
      selected.caseId,
      10,
      30,
    );
  });

  it("amends warning cases but refuses to void an active continuing sanction", async () => {
    const warning = moderationCase({ actionType: "warning", status: "active" });
    const amend = harness({ subcommand: "amend", selectedCase: warning });
    await handleModerationCaseCommand(amend.interaction, amend.runtime);
    expect(amend.amendCase).toHaveBeenCalledOnce();

    const timeout = moderationCase({ actionType: "timeout", status: "active" });
    const voiding = harness({ subcommand: "void", selectedCase: timeout });
    await handleModerationCaseCommand(voiding.interaction, voiding.runtime);
    expect(voiding.voidCase).not.toHaveBeenCalled();
    expect(voiding.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("cannot be voided"),
      }),
    );
  });

  it("fails closed when moderation configuration changes at the final action boundary", async () => {
    const context = harness({
      subcommand: "warn",
      configValues: [
        configuration(),
        configuration({ updatedAt: "2026-08-21T00:00:01.000Z" }),
      ],
    });
    await handleModerationCaseCommand(context.interaction, context.runtime);
    expect(context.createCase).not.toHaveBeenCalled();
  });

  it("reports freshly unhealthy moderation-log resources instead of stale verification", async () => {
    const context = harness({
      subcommand: "status",
      configValues: [
        configuration({
          moderationLogChannelId: "723456789012345678",
          moderationLogVerifiedAt: NOW,
        }),
      ],
    });
    await handleModerationCaseCommand(context.interaction, context.runtime);
    expect(context.guild.channels.fetch).toHaveBeenCalled();
    expect(context.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("unhealthy now"),
      }),
    );
  });
});
