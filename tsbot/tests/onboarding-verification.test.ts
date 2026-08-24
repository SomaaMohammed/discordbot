import {
  Collection,
  PermissionFlagsBits,
  PermissionsBitField,
  type ButtonInteraction,
  type Guild,
  type GuildMember,
  type Role,
} from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { GuildRuntime } from "../src/runtime.js";
import type {
  MemberRuleAcceptance,
  OnboardingConfiguration,
  OnboardingRoleOperationReservationResult,
  OnboardingRulesVersion,
} from "../src/types.js";
import {
  ONBOARDING_RULES_BODY_MAXIMUM,
  buildVerificationPanelPayload,
  createVerificationAcceptCustomId,
  normalizeRulesBody,
  normalizeRulesTitle,
} from "../src/discord/verification-components.js";
import {
  handleVerificationButton,
  verificationInteractionQueueSize,
} from "../src/discord/verification-interactions.js";

const GUILD_ID = "111111111111111111";
const OTHER_GUILD_ID = "121212121212121212";
const BOT_ID = "222222222222222222";
const MEMBER_ID = "333333333333333333";
const VERIFIED_ROLE_ID = "444444444444444444";
const UNVERIFIED_ROLE_ID = "555555555555555555";
const CHANNEL_ID = "666666666666666666";
const MESSAGE_ID = "777777777777777777";
const PANEL_ID = "verify_panel";
const RULES_VERSION = 4;
const T0 = "2026-08-23T00:00:00.000Z";
const T1 = "2026-08-23T00:01:00.000Z";

describe("verification rules rendering limits", () => {
  it("rejects rules that overflow only after safe Markdown escaping", () => {
    expect(() => normalizeRulesTitle("*".repeat(160))).toThrow(
      /after safe Markdown escaping/u,
    );
    expect(() => normalizeRulesBody("_".repeat(2_500))).toThrow(
      /after safe Markdown escaping/u,
    );
  });

  it("reserves embed space for the acknowledgement footer", () => {
    expect(() =>
      buildVerificationPanelPayload({
        panelId: PANEL_ID,
        rulesVersion: RULES_VERSION,
        rulesTitle: "Rules",
        rulesBody: "x".repeat(ONBOARDING_RULES_BODY_MAXIMUM),
        reacceptanceRequested: true,
      }),
    ).not.toThrow();
    expect(() =>
      normalizeRulesBody("x".repeat(ONBOARDING_RULES_BODY_MAXIMUM + 1)),
    ).toThrow(new RegExp(String(ONBOARDING_RULES_BODY_MAXIMUM), "u"));
  });
});

function onboardingConfiguration(
  overrides: Partial<OnboardingConfiguration> = {},
): OnboardingConfiguration {
  return {
    guildId: GUILD_ID,
    enabled: true,
    welcomeChannelId: null,
    welcomePublicEnabled: false,
    welcomeDmEnabled: false,
    farewellChannelId: null,
    farewellPublicEnabled: false,
    lifecycleLogChannelId: null,
    rulesChannelId: null,
    verificationEnabled: true,
    currentRulesVersion: RULES_VERSION,
    verifiedRoleId: VERIFIED_ROLE_ID,
    unverifiedRoleId: UNVERIFIED_ROLE_ID,
    humanAutorolesEnabled: false,
    botAutorolesEnabled: false,
    accountAgeAlertHours: null,
    welcomeTitle: "Welcome",
    welcomeBody: "Welcome to {server}.",
    farewellTitle: "Farewell",
    farewellBody: "A member left {server}.",
    welcomeChannelVerifiedAt: null,
    farewellChannelVerifiedAt: null,
    lifecycleLogChannelVerifiedAt: null,
    rulesChannelVerifiedAt: null,
    verificationRolesVerifiedAt: T0,
    createdBy: BOT_ID,
    updatedBy: BOT_ID,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function rulesVersion(
  overrides: Partial<OnboardingRulesVersion> = {},
): OnboardingRulesVersion {
  return {
    guildId: GUILD_ID,
    rulesVersion: RULES_VERSION,
    title: "Server rules",
    body: "Be kind.",
    reacceptanceRequested: false,
    createdBy: BOT_ID,
    createdAt: T0,
    ...overrides,
  };
}

interface DiscordHarnessOptions {
  readonly memberBot?: boolean;
  readonly pending?: boolean;
  readonly verifiedHeld?: boolean;
  readonly unverifiedHeld?: boolean;
  readonly verifiedPermissions?: bigint;
  readonly addFailure?: Error;
  readonly removeFailure?: Error;
}

function discordHarness(options: DiscordHarnessOptions = {}) {
  const guild = {
    id: GUILD_ID,
    ownerId: MEMBER_ID,
  } as unknown as Guild;
  const verifiedRole = {
    id: VERIFIED_ROLE_ID,
    guild,
    name: "Verified",
    managed: false,
    permissions: new PermissionsBitField(options.verifiedPermissions ?? 0n),
  } as unknown as Role;
  const unverifiedRole = {
    id: UNVERIFIED_ROLE_ID,
    guild,
    name: "Unverified",
    managed: false,
    permissions: new PermissionsBitField(),
  } as unknown as Role;
  const botMember = {
    id: BOT_ID,
    guild,
    user: { id: BOT_ID, bot: true },
    permissions: new PermissionsBitField(PermissionFlagsBits.ManageRoles),
    roles: {
      highest: { comparePositionTo: vi.fn(() => 1) },
      cache: new Collection(),
    },
  } as unknown as GuildMember;
  const roleCache = new Collection<string, Role>();
  if (options.verifiedHeld) roleCache.set(VERIFIED_ROLE_ID, verifiedRole);
  if (options.unverifiedHeld ?? true) {
    roleCache.set(UNVERIFIED_ROLE_ID, unverifiedRole);
  }
  const add = vi.fn(async (role: Role) => {
    if (options.addFailure) throw options.addFailure;
    roleCache.set(role.id, role);
    return member;
  });
  const remove = vi.fn(async (role: Role) => {
    if (options.removeFailure) throw options.removeFailure;
    roleCache.delete(role.id);
    return member;
  });
  const member = {
    id: MEMBER_ID,
    guild,
    pending: options.pending ?? false,
    user: { id: MEMBER_ID, bot: options.memberBot ?? false },
    roles: { cache: roleCache, add, remove },
  } as unknown as GuildMember;
  const membersFetch = vi.fn(async () => member);
  const roleFetch = vi.fn(async (roleId: string) => {
    if (roleId === VERIFIED_ROLE_ID) return verifiedRole;
    if (roleId === UNVERIFIED_ROLE_ID) return unverifiedRole;
    return null;
  });
  Object.assign(guild, {
    client: { user: { id: BOT_ID, bot: true } },
    members: {
      fetch: membersFetch,
      fetchMe: vi.fn(async () => botMember),
    },
    roles: { fetch: roleFetch },
  });
  return {
    guild,
    member,
    botMember,
    verifiedRole,
    unverifiedRole,
    roleCache,
    add,
    remove,
    membersFetch,
    roleFetch,
  };
}

function storageHarness(
  overrides: {
    readonly configuration?: OnboardingConfiguration;
    readonly panelConfiguration?: unknown;
    readonly panelGuildId?: string;
    readonly panelChannelId?: string;
    readonly panelMessageId?: string;
    readonly existingAcceptance?: MemberRuleAcceptance | null;
  } = {},
) {
  const state: {
    configuration: OnboardingConfiguration;
    rules: OnboardingRulesVersion;
    acceptance: MemberRuleAcceptance | null;
    operationNumber: number;
  } = {
    configuration: overrides.configuration ?? onboardingConfiguration(),
    rules: rulesVersion(),
    acceptance: overrides.existingAcceptance ?? null,
    operationNumber: 0,
  };
  const storage = {
    findPostedPanelByToken: vi.fn(() => ({
      guildId: overrides.panelGuildId ?? GUILD_ID,
      panelId: PANEL_ID,
      preset: "verification",
      channelId: overrides.panelChannelId ?? CHANNEL_ID,
      messageId: overrides.panelMessageId ?? MESSAGE_ID,
      configuration: overrides.panelConfiguration ?? {
        rulesVersion: RULES_VERSION,
        bindingsVerifiedAt: T0,
      },
      createdAt: T0,
      updatedAt: T0,
    })),
    getOnboardingConfiguration: vi.fn(() =>
      structuredClone(state.configuration),
    ),
    getCurrentOnboardingRulesVersion: vi.fn(() => structuredClone(state.rules)),
    getMemberRuleAcceptance: vi.fn(() =>
      state.acceptance ? structuredClone(state.acceptance) : null,
    ),
    recordMemberRuleAcceptance: vi.fn(
      (input: {
        memberId: string;
        rulesVersion: number;
        panelPostId: string;
      }) => {
        if (state.acceptance) {
          return {
            status: "duplicate" as const,
            acceptance: structuredClone(state.acceptance),
          };
        }
        state.acceptance = {
          guildId: GUILD_ID,
          memberId: input.memberId,
          rulesVersion: input.rulesVersion,
          acceptedAt: T1,
          panelPostId: input.panelPostId,
        };
        return {
          status: "recorded" as const,
          acceptance: structuredClone(state.acceptance),
        };
      },
    ),
    reserveOnboardingRoleOperation: vi.fn(
      (input: {
        memberId: string;
        roleId: string;
        kind: "verified-add" | "unverified-remove";
        idempotencyKey: string;
      }): OnboardingRoleOperationReservationResult => {
        state.operationNumber += 1;
        return {
          status: "reserved" as const,
          operation: {
            guildId: GUILD_ID,
            operationId: `role_op_${state.operationNumber}`,
            memberId: input.memberId,
            roleId: input.roleId,
            kind: input.kind,
            idempotencyKey: input.idempotencyKey,
            state: "reserved" as const,
            failureCode: null,
            attemptCount: 1,
            createdAt: T0,
            updatedAt: T0,
            completedAt: null,
            resolvedAt: null,
            resolvedByOperationId: null,
          },
        };
      },
    ),
    completeOnboardingRoleOperation: vi.fn(
      (
        operationId: string,
        input: { state: string; failureCode?: string },
      ) => ({
        operationId,
        ...input,
      }),
    ),
    appendOnboardingAudit: vi.fn((input) => ({ input })),
    recordCommandMetric: vi.fn(),
  };
  return { state, storage };
}

function runtime(storage: object, isCurrent = vi.fn(() => true)): GuildRuntime {
  return {
    guildId: GUILD_ID,
    storage,
    isCurrent,
  } as unknown as GuildRuntime;
}

function buttonInteraction(
  discord: ReturnType<typeof discordHarness>,
  overrides: {
    readonly customId?: string;
    readonly guildId?: string;
    readonly channelId?: string;
    readonly messageId?: string;
    readonly messageGuildId?: string;
    readonly messageAuthorId?: string;
  } = {},
) {
  const interaction = {
    customId:
      overrides.customId ??
      createVerificationAcceptCustomId(PANEL_ID, RULES_VERSION),
    guild: discord.guild,
    guildId: overrides.guildId ?? GUILD_ID,
    channelId: overrides.channelId ?? CHANNEL_ID,
    user: { id: MEMBER_ID, bot: false },
    client: discord.guild.client,
    message: {
      id: overrides.messageId ?? MESSAGE_ID,
      channelId: overrides.channelId ?? CHANNEL_ID,
      guildId: overrides.messageGuildId ?? GUILD_ID,
      author: {
        id: overrides.messageAuthorId ?? BOT_ID,
        bot: true,
      },
    },
    deferred: false,
    replied: false,
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    reply: vi.fn(async () => {
      interaction.replied = true;
    }),
  };
  return interaction as typeof interaction & ButtonInteraction;
}

function replyText(interaction: ReturnType<typeof buttonInteraction>): string {
  return JSON.stringify([
    ...interaction.editReply.mock.calls,
    ...interaction.followUp.mock.calls,
    ...interaction.reply.mock.calls,
  ]);
}

describe("onboarding verification interactions", () => {
  it("ignores unrelated component namespaces", async () => {
    const discord = discordHarness();
    const { storage } = storageHarness();
    const interaction = buttonInteraction(discord, {
      customId: "superior:ticket:open",
    });

    await expect(
      handleVerificationButton(interaction, runtime(storage)),
    ).resolves.toBe(false);

    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("adds verified, records acceptance, then removes unverified with an ephemeral result", async () => {
    const discord = discordHarness();
    const { storage } = storageHarness();
    const interaction = buttonInteraction(discord);
    const order: string[] = [];
    discord.add.mockImplementation(async (role: Role) => {
      order.push("verified-add");
      discord.roleCache.set(role.id, role);
      return discord.member;
    });
    storage.recordMemberRuleAcceptance.mockImplementation((input) => {
      order.push("acceptance");
      return {
        status: "recorded" as const,
        acceptance: {
          guildId: GUILD_ID,
          memberId: input.memberId,
          rulesVersion: input.rulesVersion,
          acceptedAt: T1,
          panelPostId: input.panelPostId,
        },
      };
    });
    discord.remove.mockImplementation(async (role: Role) => {
      order.push("unverified-remove");
      discord.roleCache.delete(role.id);
      return discord.member;
    });

    await expect(
      handleVerificationButton(interaction, runtime(storage)),
    ).resolves.toBe(true);

    expect(order).toEqual(["verified-add", "acceptance", "unverified-remove"]);
    expect(storage.recordMemberRuleAcceptance).toHaveBeenCalledWith({
      memberId: MEMBER_ID,
      rulesVersion: RULES_VERSION,
      panelPostId: PANEL_ID,
    });
    expect(storage.completeOnboardingRoleOperation).toHaveBeenCalledWith(
      "role_op_1",
      { state: "completed" },
    );
    expect(storage.completeOnboardingRoleOperation).toHaveBeenCalledWith(
      "role_op_2",
      { state: "completed" },
    );
    expect(storage.appendOnboardingAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "verification-accepted",
        memberId: MEMBER_ID,
        actorId: MEMBER_ID,
        rulesVersion: RULES_VERSION,
        outcome: "completed",
      }),
    );
    expect(interaction.deferReply).toHaveBeenCalledWith({
      flags: expect.anything(),
    });
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ allowedMentions: { parse: [] } }),
    );
    expect(replyText(interaction)).toContain("verified role is now confirmed");
    expect(verificationInteractionQueueSize()).toBe(0);
  });

  it("lets a member retry acknowledgement after a prior partial add when the current verified role is held", async () => {
    const discord = discordHarness({ verifiedHeld: true });
    const { storage } = storageHarness();
    storage.reserveOnboardingRoleOperation.mockImplementation((input) =>
      input.kind === "verified-add"
        ? {
            status: "completed" as const,
            operation: {
              guildId: GUILD_ID,
              operationId: "role_op_partial",
              memberId: MEMBER_ID,
              roleId: VERIFIED_ROLE_ID,
              kind: "verified-add" as const,
              idempotencyKey: `verification.v${RULES_VERSION}.verified-add`,
              state: "partial" as const,
              failureCode: "configuration-changed",
              attemptCount: 1,
              createdAt: T0,
              updatedAt: T1,
              completedAt: T1,
              resolvedAt: null,
              resolvedByOperationId: null,
            },
          }
        : {
            status: "reserved" as const,
            operation: {
              guildId: GUILD_ID,
              operationId: "role_op_remove",
              memberId: MEMBER_ID,
              roleId: UNVERIFIED_ROLE_ID,
              kind: "unverified-remove" as const,
              idempotencyKey: `verification.v${RULES_VERSION}.unverified-remove`,
              state: "reserved" as const,
              failureCode: null,
              attemptCount: 1,
              createdAt: T0,
              updatedAt: T0,
              completedAt: null,
              resolvedAt: null,
              resolvedByOperationId: null,
            },
          },
    );
    const interaction = buttonInteraction(discord);

    await handleVerificationButton(interaction, runtime(storage));

    expect(discord.add).not.toHaveBeenCalled();
    expect(storage.recordMemberRuleAcceptance).toHaveBeenCalledOnce();
    expect(discord.remove).toHaveBeenCalledOnce();
    expect(replyText(interaction)).toContain("acknowledged");
  });

  it("reconciles a crash-reserved verified add when Discord already holds the role", async () => {
    const discord = discordHarness({ verifiedHeld: true });
    const { storage } = storageHarness();
    storage.reserveOnboardingRoleOperation.mockImplementation((input) =>
      input.kind === "verified-add"
        ? {
            status: "pending" as const,
            operation: {
              guildId: GUILD_ID,
              operationId: "role_op_crash_reserved",
              memberId: MEMBER_ID,
              roleId: VERIFIED_ROLE_ID,
              kind: "verified-add" as const,
              idempotencyKey: `verification.v${RULES_VERSION}.verified-add`,
              state: "reserved" as const,
              failureCode: null,
              attemptCount: 1,
              createdAt: T0,
              updatedAt: T0,
              completedAt: null,
              resolvedAt: null,
              resolvedByOperationId: null,
            },
          }
        : {
            status: "reserved" as const,
            operation: {
              guildId: GUILD_ID,
              operationId: "role_op_remove_after_crash",
              memberId: MEMBER_ID,
              roleId: UNVERIFIED_ROLE_ID,
              kind: "unverified-remove" as const,
              idempotencyKey: `verification.v${RULES_VERSION}.unverified-remove`,
              state: "reserved" as const,
              failureCode: null,
              attemptCount: 1,
              createdAt: T0,
              updatedAt: T0,
              completedAt: null,
              resolvedAt: null,
              resolvedByOperationId: null,
            },
          },
    );
    const interaction = buttonInteraction(discord);

    await handleVerificationButton(interaction, runtime(storage));

    expect(discord.add).not.toHaveBeenCalled();
    expect(storage.recordMemberRuleAcceptance).toHaveBeenCalledOnce();
    expect(storage.completeOnboardingRoleOperation).toHaveBeenCalledWith(
      "role_op_crash_reserved",
      { state: "no-change" },
    );
    expect(discord.remove).toHaveBeenCalledOnce();
    expect(replyText(interaction)).toContain("acknowledged");
  });

  it("rejects copied, cross-guild, obsolete, and unverified panel bindings before fresh role work", async () => {
    const cases = [
      {
        interaction: { messageId: "787878787878787878" },
        storage: {},
      },
      {
        interaction: { guildId: OTHER_GUILD_ID },
        storage: {},
      },
      {
        interaction: {
          customId: createVerificationAcceptCustomId(
            PANEL_ID,
            RULES_VERSION - 1,
          ),
        },
        storage: {},
      },
      {
        interaction: {},
        storage: {
          panelConfiguration: {
            rulesVersion: RULES_VERSION,
            bindingsVerifiedAt: "not-a-timestamp",
          },
        },
      },
      {
        interaction: {},
        storage: {
          panelConfiguration: {
            rulesVersion: RULES_VERSION,
            bindingsVerifiedAt: T0,
            copied: true,
          },
        },
      },
    ] as const;

    for (const testCase of cases) {
      const discord = discordHarness();
      const { storage } = storageHarness(testCase.storage);
      const interaction = buttonInteraction(discord, testCase.interaction);

      await handleVerificationButton(interaction, runtime(storage));

      expect(discord.membersFetch).not.toHaveBeenCalled();
      expect(discord.roleFetch).not.toHaveBeenCalled();
      expect(storage.recordMemberRuleAcceptance).not.toHaveBeenCalled();
      expect(replyText(interaction)).toContain("current verification panel");
    }
  });

  it.each([
    [{ memberBot: true }, "Bots cannot use member verification"],
    [{ pending: true }, "Complete Discord's server Membership Screening first"],
  ] as const)(
    "rejects an ineligible member without assigning or accepting",
    async (options, expected) => {
      const discord = discordHarness(options);
      const { storage } = storageHarness();
      const interaction = buttonInteraction(discord);

      await handleVerificationButton(interaction, runtime(storage));

      expect(discord.add).not.toHaveBeenCalled();
      expect(discord.remove).not.toHaveBeenCalled();
      expect(storage.recordMemberRuleAcceptance).not.toHaveBeenCalled();
      expect(replyText(interaction)).toContain(expected);
    },
  );

  it("refuses a newly dangerous verified role after fetching it from Discord", async () => {
    const discord = discordHarness({
      verifiedPermissions: PermissionFlagsBits.Administrator,
    });
    const { storage } = storageHarness();
    const interaction = buttonInteraction(discord);

    await handleVerificationButton(interaction, runtime(storage));

    expect(discord.roleFetch).toHaveBeenCalledWith(VERIFIED_ROLE_ID, {
      cache: true,
      force: true,
    });
    expect(discord.add).not.toHaveBeenCalled();
    expect(storage.recordMemberRuleAcceptance).not.toHaveBeenCalled();
    expect(replyText(interaction)).toContain("administrator attention");
  });

  it("does not claim acceptance or remove unverified when verified-role addition fails", async () => {
    const discord = discordHarness({
      addFailure: Object.assign(new Error("private Discord failure"), {
        code: 50_013,
      }),
    });
    const { storage } = storageHarness();
    const interaction = buttonInteraction(discord);

    await handleVerificationButton(interaction, runtime(storage));

    expect(storage.recordMemberRuleAcceptance).not.toHaveBeenCalled();
    expect(discord.remove).not.toHaveBeenCalled();
    expect(storage.completeOnboardingRoleOperation).toHaveBeenCalledWith(
      "role_op_1",
      { state: "failed", failureCode: "discord-access" },
    );
    expect(storage.appendOnboardingAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "verification-role-operation",
        outcome: "verified-add-failed",
        details: expect.objectContaining({ failureCode: "discord-access" }),
      }),
    );
    expect(replyText(interaction)).toContain(
      "no rules acknowledgement was recorded",
    );
    expect(replyText(interaction)).not.toContain("private Discord failure");
  });

  it("keeps acceptance after unverified-role removal fails and records recoverable partial work", async () => {
    const discord = discordHarness({
      removeFailure: Object.assign(new Error("private removal failure"), {
        code: 50_013,
      }),
    });
    const { state, storage } = storageHarness();
    const interaction = buttonInteraction(discord);

    await handleVerificationButton(interaction, runtime(storage));

    expect(state.acceptance).toMatchObject({
      memberId: MEMBER_ID,
      rulesVersion: RULES_VERSION,
    });
    expect(discord.roleCache.has(VERIFIED_ROLE_ID)).toBe(true);
    expect(discord.roleCache.has(UNVERIFIED_ROLE_ID)).toBe(true);
    expect(storage.completeOnboardingRoleOperation).toHaveBeenCalledWith(
      "role_op_2",
      { state: "partial", failureCode: "discord-access" },
    );
    expect(storage.appendOnboardingAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "verification-accepted",
        outcome: "partial-role-delivery",
      }),
    );
    expect(replyText(interaction)).toContain("partial result was recorded");
    expect(replyText(interaction)).not.toContain("private removal failure");
  });

  it("does not record acceptance when configuration changes after Discord adds the verified role", async () => {
    const discord = discordHarness();
    const { state, storage } = storageHarness();
    const interaction = buttonInteraction(discord);
    discord.add.mockImplementation(async (role: Role) => {
      discord.roleCache.set(role.id, role);
      state.configuration = {
        ...state.configuration,
        updatedAt: T1,
        verificationRolesVerifiedAt: T1,
      };
      return discord.member;
    });

    await handleVerificationButton(interaction, runtime(storage));

    expect(discord.add).toHaveBeenCalledOnce();
    expect(storage.recordMemberRuleAcceptance).not.toHaveBeenCalled();
    expect(discord.remove).not.toHaveBeenCalled();
    expect(storage.completeOnboardingRoleOperation).toHaveBeenCalledWith(
      "role_op_1",
      { state: "partial", failureCode: "configuration-changed" },
    );
    expect(replyText(interaction)).toContain("No acknowledgement was recorded");
  });

  it("serializes concurrent clicks and records one acceptance event", async () => {
    const discord = discordHarness({ unverifiedHeld: false });
    const { storage } = storageHarness({
      configuration: onboardingConfiguration({ unverifiedRoleId: null }),
    });
    let releaseAdd!: () => void;
    let reportAddStarted!: () => void;
    const addGate = new Promise<void>((resolve) => {
      releaseAdd = resolve;
    });
    const addStarted = new Promise<void>((resolve) => {
      reportAddStarted = resolve;
    });
    discord.add.mockImplementation(async (role: Role) => {
      reportAddStarted();
      await addGate;
      discord.roleCache.set(role.id, role);
      return discord.member;
    });
    const first = buttonInteraction(discord);
    const second = buttonInteraction(discord);

    const firstResult = handleVerificationButton(first, runtime(storage));
    await addStarted;
    const secondResult = handleVerificationButton(second, runtime(storage));
    await Promise.resolve();

    expect(discord.membersFetch).toHaveBeenCalledTimes(1);
    expect(verificationInteractionQueueSize()).toBe(1);

    releaseAdd();
    await Promise.all([firstResult, secondResult]);

    expect(discord.add).toHaveBeenCalledOnce();
    expect(storage.recordMemberRuleAcceptance).toHaveBeenCalledOnce();
    expect(
      storage.appendOnboardingAudit.mock.calls.filter(
        ([input]) => input.eventType === "verification-accepted",
      ),
    ).toHaveLength(1);
    expect(replyText(second)).toContain("already acknowledged");
    expect(verificationInteractionQueueSize()).toBe(0);
  });

  it("returns concise current status without repeating role or audit mutations", async () => {
    const acceptance: MemberRuleAcceptance = {
      guildId: GUILD_ID,
      memberId: MEMBER_ID,
      rulesVersion: RULES_VERSION,
      acceptedAt: T0,
      panelPostId: PANEL_ID,
    };
    const discord = discordHarness({
      verifiedHeld: true,
      unverifiedHeld: false,
    });
    const { storage } = storageHarness({
      existingAcceptance: acceptance,
      configuration: onboardingConfiguration({ unverifiedRoleId: null }),
    });
    const interaction = buttonInteraction(discord);

    await handleVerificationButton(interaction, runtime(storage));

    expect(discord.add).not.toHaveBeenCalled();
    expect(discord.remove).not.toHaveBeenCalled();
    expect(storage.reserveOnboardingRoleOperation).not.toHaveBeenCalled();
    expect(storage.recordMemberRuleAcceptance).not.toHaveBeenCalled();
    expect(storage.appendOnboardingAudit).not.toHaveBeenCalled();
    expect(replyText(interaction)).toContain(
      "already acknowledged the current server rules",
    );
  });
});
