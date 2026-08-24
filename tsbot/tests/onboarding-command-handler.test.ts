import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
  type ChatInputCommandInteraction,
  type GuildMember,
} from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GuildRuntime } from "../src/runtime.js";
import type {
  MemberRuleAcceptance,
  OnboardingAutorole,
  OnboardingConfiguration,
  OnboardingDeliveryRecord,
  OnboardingRoleOperation,
  OnboardingRulesVersion,
  PostedPanel,
} from "../src/types.js";

const lifecycleMocks = vi.hoisted(() => ({
  deliverPrivateLifecycleLog: vi.fn(),
  retryGuildMemberLifecycle: vi.fn(),
}));

vi.mock("../src/discord/member-lifecycle-discord.js", () => ({
  deliverPrivateLifecycleLog: lifecycleMocks.deliverPrivateLifecycleLog,
  retryGuildMemberLifecycle: lifecycleMocks.retryGuildMemberLifecycle,
}));

import { handleOnboardingCommand } from "../src/discord/onboarding-commands-handler.js";

const GUILD_ID = "100000000000000001";
const OWNER_ID = "200000000000000001";
const ACTOR_ID = "300000000000000001";
const DELEGATE_ROLE_ID = "400000000000000001";
const TARGET_ID = "500000000000000001";
const BOT_ID = "600000000000000001";
const LOG_CHANNEL_ID = "700000000000000001";
const WELCOME_CHANNEL_ID = "710000000000000001";
const FAREWELL_CHANNEL_ID = "710000000000000002";
const PANEL_CHANNEL_ID = "720000000000000001";
const LIVE_PANEL_MESSAGE_ID = "730000000000000001";
const STALE_PANEL_MESSAGE_ID = "730000000000000002";
const VERIFIED_ROLE_ID = "800000000000000001";
const UNVERIFIED_ROLE_ID = "810000000000000001";
const AUTOROLE_ID = "820000000000000001";
const DELETED_ROLE_ID = "830000000000000001";
const REPLACEMENT_ROLE_ID = "830000000000000002";
const NOW = "2026-08-23T12:00:00.000Z";

type Capability = "onboarding.configure" | "roles.configure";

interface ChannelSpec {
  readonly botCanUse?: boolean;
  readonly everyoneCanView?: boolean;
  readonly availableMessageIds?: readonly string[];
  readonly sendHook?: () => Promise<void>;
  readonly fetchHook?: () => Promise<void>;
}

interface HarnessOptions {
  readonly subcommand: string;
  readonly actor?: "owner" | "delegate";
  readonly grantSequence?: readonly (readonly Capability[])[];
  readonly currentSequence?: readonly boolean[];
  readonly configuration?: OnboardingConfiguration | null;
  readonly sharedConfigurationState?: {
    value: OnboardingConfiguration | null;
  };
  readonly autoroles?: readonly OnboardingAutorole[];
  readonly availableRoleIds?: readonly string[];
  readonly channels?: Readonly<Record<string, ChannelSpec>>;
  readonly messageCustomIds?: Readonly<Record<string, string>>;
  readonly selectedChannels?: Readonly<Record<string, string>>;
  readonly selectedRoles?: Readonly<Record<string, string>>;
  readonly strings?: Readonly<Record<string, string>>;
  readonly booleans?: Readonly<Record<string, boolean>>;
  readonly integers?: Readonly<Record<string, number>>;
  readonly targetPending?: boolean;
  readonly targetBot?: boolean;
  readonly targetRoleIds?: readonly string[];
  readonly targetRoleAddError?: Error;
  readonly targetRoleRemoveError?: Error;
  readonly memberState?: unknown;
  readonly acceptances?: readonly MemberRuleAcceptance[];
  readonly deliveryRecords?: readonly OnboardingDeliveryRecord[];
  readonly roleOperations?: readonly OnboardingRoleOperation[];
  readonly audits?: readonly unknown[];
  readonly panels?: readonly unknown[];
  readonly postedPanel?: PostedPanel | null;
  readonly rules?: OnboardingRulesVersion | null;
  readonly lifecycleResult?: unknown;
}

function onboardingConfiguration(
  overrides: Partial<OnboardingConfiguration> = {},
): OnboardingConfiguration {
  return {
    guildId: GUILD_ID,
    enabled: false,
    welcomeChannelId: null,
    welcomePublicEnabled: false,
    welcomeDmEnabled: false,
    farewellChannelId: null,
    farewellPublicEnabled: false,
    lifecycleLogChannelId: null,
    rulesChannelId: null,
    verificationEnabled: false,
    currentRulesVersion: null,
    verifiedRoleId: null,
    unverifiedRoleId: null,
    humanAutorolesEnabled: false,
    botAutorolesEnabled: false,
    accountAgeAlertHours: null,
    welcomeTitle: "Welcome, {user}",
    welcomeBody: "Welcome to {server}.",
    farewellTitle: "Member left",
    farewellBody: "{user} left {server}.",
    welcomeChannelVerifiedAt: null,
    farewellChannelVerifiedAt: null,
    lifecycleLogChannelVerifiedAt: null,
    rulesChannelVerifiedAt: null,
    verificationRolesVerifiedAt: null,
    createdBy: OWNER_ID,
    updatedBy: OWNER_ID,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function autorole(
  roleId: string,
  overrides: Partial<OnboardingAutorole> = {},
): OnboardingAutorole {
  return {
    guildId: GUILD_ID,
    audience: "human",
    roleId,
    sortOrder: 0,
    enabled: false,
    bindingsVerifiedAt: null,
    createdBy: OWNER_ID,
    updatedBy: OWNER_ID,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function acceptance(
  overrides: Partial<MemberRuleAcceptance> = {},
): MemberRuleAcceptance {
  return {
    guildId: GUILD_ID,
    memberId: TARGET_ID,
    rulesVersion: 1,
    acceptedAt: NOW,
    panelPostId: null,
    ...overrides,
  };
}

function roleOperation(
  operationId: string,
  overrides: Partial<OnboardingRoleOperation> = {},
): OnboardingRoleOperation {
  return {
    guildId: GUILD_ID,
    operationId,
    memberId: TARGET_ID,
    roleId: VERIFIED_ROLE_ID,
    kind: "verified-add",
    idempotencyKey: `key:${operationId}`,
    state: "reserved",
    failureCode: null,
    attemptCount: 1,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    resolvedAt: null,
    resolvedByOperationId: null,
    ...overrides,
  };
}

function deliveryRecord(
  deliveryId: string,
  overrides: Partial<OnboardingDeliveryRecord> = {},
): OnboardingDeliveryRecord {
  return {
    guildId: GUILD_ID,
    deliveryId,
    memberId: TARGET_ID,
    joinInstance: "join:1",
    kind: "welcome-public",
    state: "failed",
    channelId: WELCOME_CHANNEL_ID,
    messageId: null,
    attemptCount: 1,
    failureCode: "safe-delivery-failure",
    claimId: null,
    claimExpiresAt: null,
    deliveredAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function rulesVersion(
  overrides: Partial<OnboardingRulesVersion> = {},
): OnboardingRulesVersion {
  return {
    guildId: GUILD_ID,
    rulesVersion: 1,
    title: "Server rules",
    body: "Be respectful.",
    reacceptanceRequested: false,
    createdBy: OWNER_ID,
    createdAt: NOW,
    ...overrides,
  };
}

function createHarness(options: HarnessOptions) {
  const actorId = options.actor === "delegate" ? ACTOR_ID : OWNER_ID;
  const actorRoleIds = options.actor === "delegate" ? [DELEGATE_ROLE_ID] : [];
  const actorRoles = new Map(actorRoleIds.map((id) => [id, { id }]));
  const targetRoles = new Map(
    (options.targetRoleIds ?? []).map((id) => [id, { id }]),
  );

  const actor = {
    id: actorId,
    guild: null as unknown,
    user: { id: actorId, bot: false },
    permissions: new PermissionsBitField(),
    roles: {
      cache: actorRoles,
      highest: { comparePositionTo: vi.fn(() => 1) },
    },
  };
  const bot = {
    id: BOT_ID,
    guild: null as unknown,
    user: { id: BOT_ID, bot: true },
    permissions: new PermissionsBitField([PermissionFlagsBits.ManageRoles]),
    roles: {
      cache: new Map(),
      highest: { comparePositionTo: vi.fn(() => 1) },
    },
  };
  const targetRoleAdd = vi.fn(async (_role: unknown, _reason: string) => {
    if (options.targetRoleAddError) throw options.targetRoleAddError;
  });
  const targetRoleRemove = vi.fn(async (_role: unknown, _reason: string) => {
    if (options.targetRoleRemoveError) throw options.targetRoleRemoveError;
  });
  const target = {
    id: TARGET_ID,
    guild: null as unknown,
    user: {
      id: TARGET_ID,
      bot: options.targetBot ?? false,
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
    },
    displayName: "Target member",
    pending: options.targetPending ?? false,
    joinedAt: new Date("2026-08-01T00:00:00.000Z"),
    roles: {
      cache: targetRoles,
      highest: { comparePositionTo: vi.fn(() => -1) },
      add: targetRoleAdd,
      remove: targetRoleRemove,
    },
  };

  const guild = {
    id: GUILD_ID,
    ownerId: OWNER_ID,
    name: "Test guild",
    memberCount: 42,
    roles: {
      everyone: { id: GUILD_ID },
      fetch: vi.fn(),
    },
    channels: { fetch: vi.fn() },
    members: {
      fetch: vi.fn(),
      fetchMe: vi.fn(async () => bot),
    },
  };
  actor.guild = guild;
  bot.guild = guild;
  target.guild = guild;

  const availableRoleIds = new Set(options.availableRoleIds ?? []);
  if (options.actor === "delegate") availableRoleIds.add(DELEGATE_ROLE_ID);
  const roles = new Map(
    [...availableRoleIds].map((roleId) => [
      roleId,
      {
        id: roleId,
        guild,
        managed: false,
        permissions: new PermissionsBitField(),
      },
    ]),
  );
  guild.roles.fetch.mockImplementation(
    async (roleId: string) => roles.get(roleId) ?? null,
  );

  const sentMessages: Array<{
    readonly id: string;
    readonly delete: ReturnType<typeof vi.fn>;
  }> = [];
  let sentMessageNumber = 0;
  const channels = new Map(
    Object.entries(options.channels ?? {}).map(([channelId, spec]) => {
      const send = vi.fn(async () => {
        const message = {
          id: (900000000000000000n + BigInt(++sentMessageNumber)).toString(),
          delete: vi.fn(async () => undefined),
        };
        sentMessages.push(message);
        await spec.sendHook?.();
        return message;
      });
      const channel = {
        id: channelId,
        guild,
        type: ChannelType.GuildText,
        isThread: vi.fn(() => false),
        permissionsFor: vi.fn((subject: { id?: string }) =>
          subject.id === GUILD_ID
            ? new PermissionsBitField(
                spec.everyoneCanView ? [PermissionFlagsBits.ViewChannel] : [],
              )
            : new PermissionsBitField(
                spec.botCanUse === false
                  ? [
                      PermissionFlagsBits.ViewChannel,
                      PermissionFlagsBits.SendMessages,
                      PermissionFlagsBits.ReadMessageHistory,
                    ]
                  : [
                      PermissionFlagsBits.ViewChannel,
                      PermissionFlagsBits.SendMessages,
                      PermissionFlagsBits.ReadMessageHistory,
                      PermissionFlagsBits.EmbedLinks,
                    ],
              ),
        ),
        send,
        messages: {
          fetch: vi.fn(async (messageId: string) =>
            !spec.availableMessageIds ||
            spec.availableMessageIds.includes(messageId)
              ? {
                  id: messageId,
                  channelId,
                  guildId: GUILD_ID,
                  author: { id: BOT_ID, bot: true },
                  components: options.messageCustomIds?.[messageId]
                    ? [
                        {
                          components: [
                            {
                              customId: options.messageCustomIds[messageId],
                            },
                          ],
                        },
                      ]
                    : [],
                  delete: vi.fn(async () => undefined),
                }
              : null,
          ),
        },
      };
      return [channelId, channel] as const;
    }),
  );
  guild.channels.fetch.mockImplementation(async (channelId: string) => {
    await options.channels?.[channelId]?.fetchHook?.();
    return channels.get(channelId) ?? null;
  });
  guild.members.fetch.mockImplementation(async ({ user }: { user: string }) => {
    if (user === actorId) return actor;
    if (user === TARGET_ID) return target;
    return null;
  });

  const configurationState = options.sharedConfigurationState ?? {
    value: options.configuration ?? null,
  };
  let rulesState = options.rules ?? null;
  let autoroleState = [...(options.autoroles ?? [])];
  let postedPanelState = options.postedPanel ?? null;
  let grantRead = 0;
  const grantSequence = options.grantSequence ?? [[]];
  const listCapabilitiesForRoles = vi.fn(() => {
    const capabilities =
      grantSequence[Math.min(grantRead++, grantSequence.length - 1)] ?? [];
    return capabilities.map((capability) => ({
      guildId: GUILD_ID,
      principalType: "role" as const,
      principalId: DELEGATE_ROLE_ID,
      roleId: DELEGATE_ROLE_ID,
      capability,
      active: true,
    }));
  });
  const upsertOnboardingConfiguration = vi.fn(
    (input: Record<string, unknown>) => {
      configurationState.value = onboardingConfiguration({
        ...(configurationState.value ?? {}),
        ...input,
        updatedBy: actorId,
        updatedAt: NOW,
      });
      return configurationState.value;
    },
  );
  const replaceOnboardingAutoroles = vi.fn(
    (
      audience: "human" | "bot",
      inputs: readonly {
        roleId: string;
        enabled: boolean;
        bindingsVerifiedAt?: string | null;
      }[],
    ) => {
      autoroleState = [
        ...autoroleState.filter((item) => item.audience !== audience),
        ...inputs.map((input, index) =>
          autorole(input.roleId, {
            audience,
            sortOrder: index,
            enabled: input.enabled,
            bindingsVerifiedAt: input.bindingsVerifiedAt ?? null,
          }),
        ),
      ];
      return autoroleState.filter((item) => item.audience === audience);
    },
  );
  let operationNumber = 0;
  const reserveOnboardingRoleOperation = vi.fn(
    (input: {
      memberId: string;
      roleId: string;
      kind: OnboardingRoleOperation["kind"];
      idempotencyKey: string;
    }) => ({
      status: "reserved" as const,
      operation: roleOperation(`operation_${++operationNumber}`, {
        ...input,
      }),
    }),
  );
  const appendOnboardingAudit = vi.fn((input: Record<string, unknown>) => ({
    guildId: GUILD_ID,
    eventId: "audit_1",
    eventNumber: 1,
    createdAt: NOW,
    ...input,
  }));
  const createAndActivateOnboardingRulesVersion = vi.fn(
    (input: {
      rules: {
        title: string;
        body: string;
        reacceptanceRequested?: boolean;
        actorId: string;
      };
      configuration: Record<string, unknown>;
    }) => {
      const rules = rulesVersion({
        title: input.rules.title,
        body: input.rules.body,
        reacceptanceRequested: input.rules.reacceptanceRequested ?? false,
        createdBy: input.rules.actorId,
      });
      configurationState.value = onboardingConfiguration({
        ...input.configuration,
        currentRulesVersion: rules.rulesVersion,
        updatedBy: input.rules.actorId,
      });
      return { rules, configuration: configurationState.value };
    },
  );
  const storage = {
    listCapabilitiesForRoles,
    getOnboardingConfiguration: vi.fn(() => configurationState.value),
    upsertOnboardingConfiguration,
    disableOnboardingConfiguration: vi.fn(() => null),
    createOnboardingRulesVersion: vi.fn(),
    createAndActivateOnboardingRulesVersion,
    getCurrentOnboardingRulesVersion: vi.fn(() => rulesState),
    listOnboardingAutoroles: vi.fn(
      (audience: "human" | "bot" | undefined, limit: number, offset: number) =>
        autoroleState
          .filter(
            (item) => audience === undefined || item.audience === audience,
          )
          .slice(offset, offset + limit),
    ),
    replaceOnboardingAutoroles,
    findPostedPanelByPresetAndChannel: vi.fn(
      (preset: string, channelId: string) =>
        postedPanelState?.preset === preset &&
        postedPanelState.channelId === channelId
          ? postedPanelState
          : null,
    ),
    upsertPostedPanel: vi.fn(
      (input: {
        panelId: string;
        preset: PostedPanel["preset"];
        channelId: string;
        messageId: string;
        configuration: unknown;
      }) => {
        postedPanelState = {
          guildId: GUILD_ID,
          ...input,
          createdAt: postedPanelState?.createdAt ?? NOW,
          updatedAt: new Date(Date.parse(NOW) + 1).toISOString(),
        };
        return postedPanelState;
      },
    ),
    listPostedPanels: vi.fn(() => [...(options.panels ?? [])]),
    getMemberOnboardingState: vi.fn(() => options.memberState ?? null),
    listMemberRuleAcceptances: vi.fn(
      (_memberId: string, limit: number, offset: number) =>
        [...(options.acceptances ?? [])].slice(offset, offset + limit),
    ),
    listOnboardingDeliveries: vi.fn(() => [...(options.deliveryRecords ?? [])]),
    listOnboardingRoleOperations: vi.fn(() => [
      ...(options.roleOperations ?? []),
    ]),
    listOnboardingAuditEvents: vi.fn(
      ({ limit, offset }: { limit: number; offset: number }) =>
        [...(options.audits ?? [])].slice(offset, offset + limit),
    ),
    reserveOnboardingRoleOperation,
    completeOnboardingRoleOperation: vi.fn(),
    resolveOnboardingRoleOperations: vi.fn(() => []),
    appendOnboardingAudit,
    recordCommandMetric: vi.fn(),
  };

  let currentRead = 0;
  const currentSequence = options.currentSequence ?? [true];
  const isCurrent = vi.fn(
    () =>
      currentSequence[Math.min(currentRead++, currentSequence.length - 1)] ??
      false,
  );
  const runtime = {
    guildId: GUILD_ID,
    storage,
    isCurrent,
  } as unknown as GuildRuntime;

  const reply = vi.fn(async (_payload: unknown) => undefined);
  const editReply = vi.fn(async (_payload: unknown) => undefined);
  const followUp = vi.fn(async (_payload: unknown) => undefined);
  const selectedUser = {
    id: TARGET_ID,
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
  };
  const interaction = {
    id: "interaction_1",
    guild,
    guildId: GUILD_ID,
    client: { user: { id: BOT_ID } },
    user: { id: actorId },
    deferred: false,
    replied: false,
    reply,
    editReply,
    followUp,
    options: {
      getSubcommand: vi.fn(() => options.subcommand),
      getChannel: vi.fn((name: string) => {
        const channelId = options.selectedChannels?.[name];
        return channelId ? { id: channelId } : null;
      }),
      getRole: vi.fn((name: string) => {
        const roleId = options.selectedRoles?.[name];
        return roleId ? { id: roleId } : null;
      }),
      getString: vi.fn((name: string) => options.strings?.[name] ?? null),
      getBoolean: vi.fn((name: string) => options.booleans?.[name] ?? null),
      getInteger: vi.fn((name: string) => options.integers?.[name] ?? null),
      getUser: vi.fn(() => selectedUser),
    },
  } as unknown as ChatInputCommandInteraction;

  if (options.lifecycleResult !== undefined) {
    lifecycleMocks.retryGuildMemberLifecycle.mockResolvedValue(
      options.lifecycleResult,
    );
  }

  return {
    actor: actor as unknown as GuildMember,
    target,
    targetRoleAdd,
    targetRoleRemove,
    guild,
    channels,
    sentMessages,
    interaction,
    runtime,
    storage,
    reply,
    isCurrent,
    configuration: () => configurationState.value,
    setConfiguration(value: OnboardingConfiguration | null): void {
      configurationState.value = value;
    },
    setRules(value: OnboardingRulesVersion | null): void {
      rulesState = value;
    },
    postedPanel: () => postedPanelState,
  };
}

function replyPayload(context: ReturnType<typeof createHarness>) {
  const calls = context.reply.mock.calls;
  expect(calls).toHaveLength(1);
  return calls[0]![0] as {
    content: string;
    allowedMentions: { parse: unknown[] };
    flags: MessageFlags;
  };
}

function expectPrivateReply(context: ReturnType<typeof createHarness>) {
  const payload = replyPayload(context);
  expect(payload.flags).toBe(MessageFlags.Ephemeral);
  expect(payload.allowedMentions).toEqual({ parse: [] });
  expect(payload.content.length).toBeLessThanOrEqual(2_000);
  return payload;
}

async function run(context: ReturnType<typeof createHarness>): Promise<void> {
  await handleOnboardingCommand(
    context.interaction,
    context.runtime,
    context.actor,
  );
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function concurrentInteraction(
  context: ReturnType<typeof createHarness>,
  id: string,
): {
  readonly interaction: ChatInputCommandInteraction;
  readonly reply: ReturnType<typeof vi.fn>;
} {
  const reply = vi.fn(async (_payload: unknown) => undefined);
  return {
    interaction: {
      ...(context.interaction as unknown as Record<string, unknown>),
      id,
      deferred: false,
      replied: false,
      reply,
      editReply: vi.fn(async (_payload: unknown) => undefined),
      followUp: vi.fn(async (_payload: unknown) => undefined),
    } as unknown as ChatInputCommandInteraction,
    reply,
  };
}

beforeEach(() => {
  lifecycleMocks.deliverPrivateLifecycleLog.mockReset();
  lifecycleMocks.deliverPrivateLifecycleLog.mockResolvedValue("delivered");
  lifecycleMocks.retryGuildMemberLifecycle.mockReset();
  lifecycleMocks.retryGuildMemberLifecycle.mockResolvedValue({
    status: "completed",
    deliveries: [],
    roles: [],
  });
});

describe("onboarding command handler", () => {
  it("rejects a delegate that has only roles.configure", async () => {
    const context = createHarness({
      subcommand: "status",
      actor: "delegate",
      grantSequence: [["roles.configure"]],
      configuration: onboardingConfiguration(),
    });

    await run(context);

    expect(context.storage.getOnboardingConfiguration).not.toHaveBeenCalled();
    expect(context.storage.listCapabilitiesForRoles).toHaveBeenCalledWith([
      DELEGATE_ROLE_ID,
    ]);
    expect(expectPrivateReply(context).content).toContain(
      "current onboarding authority could not be verified",
    );
  });

  it("rechecks the exact delegated capability before posting a panel", async () => {
    const context = createHarness({
      subcommand: "panel",
      actor: "delegate",
      grantSequence: [["onboarding.configure"], ["roles.configure"]],
      configuration: onboardingConfiguration({
        enabled: true,
        verificationEnabled: true,
        currentRulesVersion: 1,
        verifiedRoleId: VERIFIED_ROLE_ID,
        verificationRolesVerifiedAt: NOW,
      }),
      rules: rulesVersion(),
      availableRoleIds: [VERIFIED_ROLE_ID],
      channels: { [PANEL_CHANNEL_ID]: {} },
      selectedChannels: { channel: PANEL_CHANNEL_ID },
    });

    await run(context);

    expect(context.storage.listCapabilitiesForRoles).toHaveBeenCalledTimes(2);
    expect(context.guild.members.fetch).toHaveBeenCalledTimes(2);
    expect(context.channels.get(PANEL_CHANNEL_ID)!.send).not.toHaveBeenCalled();
    expect(context.storage.upsertPostedPanel).not.toHaveBeenCalled();
    expect(expectPrivateReply(context).content).toContain(
      "authority changed before the panel could be posted",
    );
  });

  it("deletes a just-posted panel when the runtime generation changes", async () => {
    const context = createHarness({
      subcommand: "panel",
      currentSequence: [true, true, false],
      configuration: onboardingConfiguration({
        enabled: true,
        verificationEnabled: true,
        currentRulesVersion: 1,
        verifiedRoleId: VERIFIED_ROLE_ID,
        verificationRolesVerifiedAt: NOW,
      }),
      rules: rulesVersion(),
      availableRoleIds: [VERIFIED_ROLE_ID],
      channels: { [PANEL_CHANNEL_ID]: {} },
      selectedChannels: { channel: PANEL_CHANNEL_ID },
    });

    await run(context);

    const channel = context.channels.get(PANEL_CHANNEL_ID)!;
    expect(channel.send).toHaveBeenCalledOnce();
    expect(context.sentMessages[0]!.delete).toHaveBeenCalledOnce();
    expect(context.storage.upsertPostedPanel).not.toHaveBeenCalled();
    expect(expectPrivateReply(context).content).toContain(
      "server changed while the panel was being posted",
    );
  });

  it("deletes a new panel when rules and configuration change during Discord send", async () => {
    const sendStarted = deferred();
    const releaseSend = deferred();
    const initialConfiguration = onboardingConfiguration({
      enabled: true,
      verificationEnabled: true,
      currentRulesVersion: 1,
      verifiedRoleId: VERIFIED_ROLE_ID,
      verificationRolesVerifiedAt: NOW,
    });
    const context = createHarness({
      subcommand: "panel",
      configuration: initialConfiguration,
      rules: rulesVersion(),
      availableRoleIds: [VERIFIED_ROLE_ID],
      channels: {
        [PANEL_CHANNEL_ID]: {
          sendHook: async () => {
            sendStarted.resolve();
            await releaseSend.promise;
          },
        },
      },
      selectedChannels: { channel: PANEL_CHANNEL_ID },
    });

    const posting = run(context);
    await sendStarted.promise;
    context.setConfiguration(
      onboardingConfiguration({
        ...initialConfiguration,
        currentRulesVersion: 2,
        updatedBy: ACTOR_ID,
        updatedAt: "2026-08-23T12:00:01.000Z",
      }),
    );
    context.setRules(
      rulesVersion({
        rulesVersion: 2,
        title: "Replacement rules",
        body: "Use the current replacement rules.",
        createdAt: "2026-08-23T12:00:01.000Z",
      }),
    );
    releaseSend.resolve();
    await posting;

    expect(context.channels.get(PANEL_CHANNEL_ID)!.send).toHaveBeenCalledOnce();
    expect(context.sentMessages[0]!.delete).toHaveBeenCalledOnce();
    expect(context.storage.upsertPostedPanel).not.toHaveBeenCalled();
    expect(expectPrivateReply(context).content).toContain(
      "verification configuration changed while the panel was being posted",
    );
  });

  it("deletes a new panel when binding persistence fails", async () => {
    const context = createHarness({
      subcommand: "panel",
      configuration: onboardingConfiguration({
        enabled: true,
        verificationEnabled: true,
        currentRulesVersion: 1,
        verifiedRoleId: VERIFIED_ROLE_ID,
        verificationRolesVerifiedAt: NOW,
      }),
      rules: rulesVersion(),
      availableRoleIds: [VERIFIED_ROLE_ID],
      channels: { [PANEL_CHANNEL_ID]: {} },
      selectedChannels: { channel: PANEL_CHANNEL_ID },
    });
    context.storage.upsertPostedPanel.mockImplementationOnce(() => {
      throw new Error("synthetic panel persistence failure");
    });

    await run(context);

    expect(context.channels.get(PANEL_CHANNEL_ID)!.send).toHaveBeenCalledOnce();
    expect(context.sentMessages[0]!.delete).toHaveBeenCalledOnce();
    expect(context.postedPanel()).toBeNull();
    expect(expectPrivateReply(context).content).toContain(
      "synthetic panel persistence failure",
    );
  });

  it("allows only one of two concurrent posts for the same guild channel", async () => {
    const sendStarted = deferred();
    const releaseSend = deferred();
    const context = createHarness({
      subcommand: "panel",
      configuration: onboardingConfiguration({
        enabled: true,
        verificationEnabled: true,
        currentRulesVersion: 1,
        verifiedRoleId: VERIFIED_ROLE_ID,
        verificationRolesVerifiedAt: NOW,
      }),
      rules: rulesVersion(),
      availableRoleIds: [VERIFIED_ROLE_ID],
      channels: {
        [PANEL_CHANNEL_ID]: {
          sendHook: async () => {
            sendStarted.resolve();
            await releaseSend.promise;
          },
        },
      },
      selectedChannels: { channel: PANEL_CHANNEL_ID },
      booleans: { replace_existing: true },
    });

    const first = run(context);
    await sendStarted.promise;
    const competing = concurrentInteraction(context, "interaction_2");
    const second = handleOnboardingCommand(
      competing.interaction,
      context.runtime,
      context.actor,
    );
    await vi.waitFor(() =>
      expect(
        context.guild.members.fetch.mock.calls.length,
      ).toBeGreaterThanOrEqual(3),
    );
    await Promise.resolve();
    await Promise.resolve();
    releaseSend.resolve();
    await Promise.all([first, second]);

    expect(context.channels.get(PANEL_CHANNEL_ID)!.send).toHaveBeenCalledOnce();
    expect(context.storage.upsertPostedPanel).toHaveBeenCalledOnce();
    expect(context.storage.recordCommandMetric).toHaveBeenCalledWith(
      "onboarding.panel",
    );
    expect(context.reply.mock.calls[0]![0]).toMatchObject({
      content: expect.stringContaining("Posted the current verification panel"),
      flags: MessageFlags.Ephemeral,
    });
    expect(competing.reply.mock.calls[0]![0]).toMatchObject({
      content: expect.stringContaining(
        "Another verification panel post is already in progress",
      ),
      flags: MessageFlags.Ephemeral,
    });
  });

  it("freshly fetches a lifecycle log channel and requires @everyone privacy", async () => {
    const context = createHarness({
      subcommand: "configure",
      configuration: onboardingConfiguration(),
      channels: {
        [LOG_CHANNEL_ID]: { everyoneCanView: true },
      },
      selectedChannels: { log_channel: LOG_CHANNEL_ID },
    });

    await run(context);

    expect(context.guild.channels.fetch).toHaveBeenCalledWith(LOG_CHANNEL_ID, {
      cache: true,
      force: true,
    });
    expect(
      context.storage.upsertOnboardingConfiguration,
    ).not.toHaveBeenCalled();
    expect(expectPrivateReply(context).content).toContain(
      "must be private from @everyone",
    );
  });

  it("freshly revalidates effective channel permissions before enabling", async () => {
    const context = createHarness({
      subcommand: "configure",
      configuration: onboardingConfiguration({
        welcomeChannelId: WELCOME_CHANNEL_ID,
        welcomePublicEnabled: true,
        welcomeChannelVerifiedAt: NOW,
      }),
      booleans: { enabled: true },
      channels: {
        [WELCOME_CHANNEL_ID]: { botCanUse: false },
      },
    });

    await run(context);

    expect(context.guild.channels.fetch).toHaveBeenCalledWith(
      WELCOME_CHANNEL_ID,
      { cache: true, force: true },
    );
    expect(
      context.storage.upsertOnboardingConfiguration,
    ).not.toHaveBeenCalled();
    expect(expectPrivateReply(context).content).toContain(
      "needs View Channel, Send Messages, Read Message History, and Embed Links",
    );
  });

  it("serializes disjoint configuration edits without losing either update", async () => {
    const sharedConfigurationState = {
      value: onboardingConfiguration(),
    };
    let markWelcomeFetchStarted!: () => void;
    const welcomeFetchStarted = new Promise<void>((resolve) => {
      markWelcomeFetchStarted = resolve;
    });
    let releaseWelcomeFetch!: () => void;
    const welcomeFetchGate = new Promise<void>((resolve) => {
      releaseWelcomeFetch = resolve;
    });
    const welcome = createHarness({
      subcommand: "welcome",
      sharedConfigurationState,
      selectedChannels: { channel: WELCOME_CHANNEL_ID },
      booleans: { public_enabled: true },
      channels: {
        [WELCOME_CHANNEL_ID]: {
          fetchHook: async () => {
            markWelcomeFetchStarted();
            await welcomeFetchGate;
          },
        },
      },
    });
    const farewell = createHarness({
      subcommand: "farewell",
      sharedConfigurationState,
      selectedChannels: { channel: FAREWELL_CHANNEL_ID },
      booleans: { public_enabled: true },
      channels: { [FAREWELL_CHANNEL_ID]: {} },
    });

    const welcomeRun = run(welcome);
    await welcomeFetchStarted;
    const farewellRun = run(farewell);
    await Promise.resolve();
    expect(
      farewell.storage.upsertOnboardingConfiguration,
    ).not.toHaveBeenCalled();
    releaseWelcomeFetch();
    await Promise.all([welcomeRun, farewellRun]);

    expect(sharedConfigurationState.value).toMatchObject({
      welcomeChannelId: WELCOME_CHANNEL_ID,
      welcomePublicEnabled: true,
      farewellChannelId: FAREWELL_CHANNEL_ID,
      farewellPublicEnabled: true,
    });
  });

  it("creates and activates a rules version through one atomic repository call", async () => {
    const context = createHarness({
      subcommand: "rules",
      configuration: onboardingConfiguration(),
      strings: {
        title: "Current rules",
        body: "Read and acknowledge these rules.",
      },
      booleans: { request_reacceptance: true },
    });

    await run(context);

    expect(
      context.storage.createAndActivateOnboardingRulesVersion,
    ).toHaveBeenCalledWith({
      rules: {
        title: "Current rules",
        body: "Read and acknowledge these rules.",
        reacceptanceRequested: true,
        actorId: OWNER_ID,
      },
      configuration: expect.objectContaining({
        actorId: OWNER_ID,
        rulesChannelId: null,
        rulesChannelVerifiedAt: null,
      }),
    });
    const activation =
      context.storage.createAndActivateOnboardingRulesVersion.mock.calls[0]![0];
    expect(activation.configuration).not.toHaveProperty("currentRulesVersion");
    expect(context.storage.createOnboardingRulesVersion).not.toHaveBeenCalled();
    expect(
      context.storage.upsertOnboardingConfiguration,
    ).not.toHaveBeenCalled();
    expect(expectPrivateReply(context).content).toContain(
      "Created immutable rules version **1**",
    );
  });

  it("can explicitly clear the optional rules-channel binding", async () => {
    const context = createHarness({
      subcommand: "rules",
      configuration: onboardingConfiguration({
        rulesChannelId: WELCOME_CHANNEL_ID,
        rulesChannelVerifiedAt: NOW,
      }),
      strings: {
        title: "Current rules",
        body: "Read and acknowledge these rules.",
      },
      booleans: { clear_channel: true },
    });

    await run(context);

    expect(
      context.storage.createAndActivateOnboardingRulesVersion,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        configuration: expect.objectContaining({
          rulesChannelId: null,
          rulesChannelVerifiedAt: null,
        }),
      }),
    );
    expect(context.guild.channels.fetch).not.toHaveBeenCalled();
  });

  it("validates and stores verified then unverified roles with explicit ordering", async () => {
    const context = createHarness({
      subcommand: "verification",
      configuration: onboardingConfiguration({ currentRulesVersion: 1 }),
      booleans: { enabled: true },
      selectedRoles: {
        verified_role: VERIFIED_ROLE_ID,
        unverified_role: UNVERIFIED_ROLE_ID,
      },
      availableRoleIds: [VERIFIED_ROLE_ID, UNVERIFIED_ROLE_ID],
    });

    await run(context);

    expect(
      context.guild.roles.fetch.mock.calls.map(([roleId]) => roleId),
    ).toEqual([VERIFIED_ROLE_ID, UNVERIFIED_ROLE_ID]);
    expect(context.storage.upsertOnboardingConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        verificationEnabled: true,
        verifiedRoleId: VERIFIED_ROLE_ID,
        unverifiedRoleId: UNVERIFIED_ROLE_ID,
        verificationRolesVerifiedAt: expect.any(String),
      }),
    );
    expect(expectPrivateReply(context).content).toContain(
      "always adds the verified role before attempting to remove the unverified role",
    );
  });

  it("rejects verification roles that are already configured as autoroles", async () => {
    const context = createHarness({
      subcommand: "verification",
      configuration: onboardingConfiguration({ currentRulesVersion: 1 }),
      autoroles: [autorole(UNVERIFIED_ROLE_ID)],
      booleans: { enabled: true },
      selectedRoles: {
        verified_role: VERIFIED_ROLE_ID,
        unverified_role: UNVERIFIED_ROLE_ID,
      },
      availableRoleIds: [VERIFIED_ROLE_ID, UNVERIFIED_ROLE_ID],
    });

    await run(context);

    expect(
      context.storage.upsertOnboardingConfiguration,
    ).not.toHaveBeenCalled();
    expect(expectPrivateReply(context).content).toContain(
      "Verification roles cannot also be automatic roles",
    );
  });

  it("force-fetches supplied verification roles even while disabling", async () => {
    const context = createHarness({
      subcommand: "verification",
      configuration: onboardingConfiguration({
        verifiedRoleId: VERIFIED_ROLE_ID,
      }),
      booleans: { enabled: false },
      selectedRoles: { verified_role: REPLACEMENT_ROLE_ID },
    });

    await run(context);

    expect(context.guild.roles.fetch).toHaveBeenCalledWith(
      REPLACEMENT_ROLE_ID,
      { cache: true, force: true },
    );
    expect(
      context.storage.upsertOnboardingConfiguration,
    ).not.toHaveBeenCalled();
    expect(expectPrivateReply(context).content).toContain(
      "selected role is missing or invalid",
    );
  });

  it("rejects an autorole that is configured for verification", async () => {
    const context = createHarness({
      subcommand: "autorole",
      configuration: onboardingConfiguration({
        verifiedRoleId: VERIFIED_ROLE_ID,
      }),
      strings: { audience: "human", action: "add" },
      selectedRoles: { role: VERIFIED_ROLE_ID },
      availableRoleIds: [VERIFIED_ROLE_ID],
    });

    await run(context);

    expect(context.storage.replaceOnboardingAutoroles).not.toHaveBeenCalled();
    expect(expectPrivateReply(context).content).toContain(
      "Automatic roles cannot also be verification roles",
    );
  });

  it("removes a deleted autorole by role_id without fetching the deleted role", async () => {
    const retained = autorole(AUTOROLE_ID, {
      enabled: true,
      bindingsVerifiedAt: NOW,
      sortOrder: 1,
    });
    const context = createHarness({
      subcommand: "autorole",
      configuration: onboardingConfiguration({
        enabled: true,
        humanAutorolesEnabled: true,
      }),
      autoroles: [
        autorole(DELETED_ROLE_ID, {
          enabled: true,
          bindingsVerifiedAt: NOW,
        }),
        retained,
      ],
      strings: {
        audience: "human",
        action: "remove",
        role_id: DELETED_ROLE_ID,
      },
    });

    await run(context);

    expect(context.guild.roles.fetch).not.toHaveBeenCalled();
    expect(context.storage.replaceOnboardingAutoroles).toHaveBeenCalledWith(
      "human",
      [
        {
          roleId: AUTOROLE_ID,
          enabled: true,
          bindingsVerifiedAt: NOW,
        },
      ],
      OWNER_ID,
    );
    expect(context.storage.upsertOnboardingConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({ humanAutorolesEnabled: true }),
    );
    expect(expectPrivateReply(context).content).toContain("(1/10)");
  });

  it("force-fetches a selected role before removing its stored autorole", async () => {
    const context = createHarness({
      subcommand: "autorole",
      configuration: onboardingConfiguration(),
      autoroles: [autorole(AUTOROLE_ID)],
      strings: { audience: "human", action: "remove" },
      selectedRoles: { role: AUTOROLE_ID },
      availableRoleIds: [AUTOROLE_ID],
    });

    await run(context);

    expect(context.guild.roles.fetch).toHaveBeenCalledWith(AUTOROLE_ID, {
      cache: true,
      force: true,
    });
    expect(context.storage.replaceOnboardingAutoroles).toHaveBeenCalledWith(
      "human",
      [],
      OWNER_ID,
    );
  });

  it("activates a newly added role when its audience is already enabled", async () => {
    const context = createHarness({
      subcommand: "autorole",
      configuration: onboardingConfiguration({
        enabled: true,
        humanAutorolesEnabled: true,
      }),
      autoroles: [
        autorole(AUTOROLE_ID, {
          enabled: true,
          bindingsVerifiedAt: NOW,
        }),
      ],
      strings: { audience: "human", action: "add" },
      selectedRoles: { role: REPLACEMENT_ROLE_ID },
      availableRoleIds: [REPLACEMENT_ROLE_ID],
    });

    await run(context);

    expect(context.storage.replaceOnboardingAutoroles).toHaveBeenCalledWith(
      "human",
      [
        {
          roleId: AUTOROLE_ID,
          enabled: true,
          bindingsVerifiedAt: NOW,
        },
        {
          roleId: REPLACEMENT_ROLE_ID,
          enabled: true,
          bindingsVerifiedAt: expect.any(String),
        },
      ],
      OWNER_ID,
    );
    expect(expectPrivateReply(context).content).toContain(
      "Delivery is **enabled**",
    );
  });

  it("disables an audience when its final automatic role is removed", async () => {
    const context = createHarness({
      subcommand: "autorole",
      configuration: onboardingConfiguration({
        enabled: true,
        humanAutorolesEnabled: true,
      }),
      autoroles: [
        autorole(DELETED_ROLE_ID, {
          enabled: true,
          bindingsVerifiedAt: NOW,
        }),
      ],
      strings: {
        audience: "human",
        action: "remove",
        role_id: DELETED_ROLE_ID,
      },
    });

    await run(context);

    expect(context.storage.replaceOnboardingAutoroles).toHaveBeenCalledWith(
      "human",
      [],
      OWNER_ID,
    );
    expect(context.storage.upsertOnboardingConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        humanAutorolesEnabled: false,
      }),
    );
    expect(expectPrivateReply(context).content).toContain(
      "Delivery is **disabled**",
    );
  });

  it("does not activate an imported unverified channel binding during an unrelated edit", async () => {
    const context = createHarness({
      subcommand: "welcome",
      configuration: onboardingConfiguration({
        enabled: false,
        welcomeChannelId: WELCOME_CHANNEL_ID,
        welcomePublicEnabled: false,
        welcomeChannelVerifiedAt: null,
      }),
      strings: { title: "A revised welcome" },
    });

    await run(context);

    expect(context.guild.channels.fetch).not.toHaveBeenCalled();
    expect(context.storage.upsertOnboardingConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
        welcomeChannelId: WELCOME_CHANNEL_ID,
        welcomePublicEnabled: false,
        welcomeChannelVerifiedAt: null,
      }),
    );
    expect(context.configuration()).toMatchObject({
      enabled: false,
      welcomePublicEnabled: false,
      welcomeChannelVerifiedAt: null,
    });
    expectPrivateReply(context);
  });

  it("bounds private status health reads and output", async () => {
    const manyAutoroles = Array.from({ length: 20 }, (_, index) =>
      autorole(String(840000000000000001n + BigInt(index)), {
        sortOrder: index,
        enabled: true,
        bindingsVerifiedAt: NOW,
      }),
    );
    const context = createHarness({
      subcommand: "status",
      configuration: onboardingConfiguration({
        enabled: true,
        welcomeTitle: "PRIVATE TEMPLATE MARKER",
        welcomeBody: "PRIVATE BODY MARKER",
      }),
      autoroles: manyAutoroles,
    });

    await run(context);

    expect(context.storage.listOnboardingAutoroles).toHaveBeenCalledWith(
      undefined,
      20,
      0,
    );
    expect(context.storage.listPostedPanels).toHaveBeenCalledWith(
      "verification",
      25,
      0,
    );
    const payload = expectPrivateReply(context);
    expect(payload.content.match(/^•/gmu)).toHaveLength(12);
    expect(payload.content).not.toContain("PRIVATE TEMPLATE MARKER");
    expect(payload.content).not.toContain("PRIVATE BODY MARKER");
  });

  it("reports effective channel, privacy, unverified-role, and live-panel health", async () => {
    const context = createHarness({
      subcommand: "status",
      configuration: onboardingConfiguration({
        enabled: true,
        welcomeChannelId: WELCOME_CHANNEL_ID,
        welcomePublicEnabled: true,
        welcomeChannelVerifiedAt: NOW,
        lifecycleLogChannelId: LOG_CHANNEL_ID,
        lifecycleLogChannelVerifiedAt: NOW,
        verificationEnabled: true,
        currentRulesVersion: 1,
        verifiedRoleId: VERIFIED_ROLE_ID,
        unverifiedRoleId: UNVERIFIED_ROLE_ID,
        verificationRolesVerifiedAt: NOW,
      }),
      availableRoleIds: [VERIFIED_ROLE_ID],
      channels: {
        [WELCOME_CHANNEL_ID]: { botCanUse: false },
        [LOG_CHANNEL_ID]: { everyoneCanView: true },
        [PANEL_CHANNEL_ID]: {
          availableMessageIds: [LIVE_PANEL_MESSAGE_ID],
        },
      },
      panels: [
        {
          guildId: GUILD_ID,
          panelId: "panel_live_1",
          preset: "verification",
          channelId: PANEL_CHANNEL_ID,
          messageId: LIVE_PANEL_MESSAGE_ID,
          configuration: {
            rulesVersion: 1,
            bindingsVerifiedAt: NOW,
          },
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          guildId: GUILD_ID,
          panelId: "panel_stale_1",
          preset: "verification",
          channelId: PANEL_CHANNEL_ID,
          messageId: STALE_PANEL_MESSAGE_ID,
          configuration: {
            rulesVersion: 0,
            bindingsVerifiedAt: NOW,
          },
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      messageCustomIds: {
        [LIVE_PANEL_MESSAGE_ID]: "superior:verify:panel_live_1:1",
      },
    });

    await run(context);

    const payload = expectPrivateReply(context);
    expect(payload.content).toContain("Live verification panels: 1/2 tracked");
    expect(payload.content).toContain(
      "Welcome channel: Superior needs View Channel",
    );
    expect(payload.content).toContain(
      "Lifecycle log channel must remain private from @everyone",
    );
    expect(payload.content).toContain(
      "Unverified role: The selected unverified role is missing or invalid",
    );
    expect(payload.content).toContain(
      "Verification panel panel_stale_1 is bound to stale rules",
    );
    expect(context.storage.recordCommandMetric).toHaveBeenCalledWith(
      "onboarding.status",
      false,
    );
  });

  it("keeps member lookup private and uses bounded recovery and audit queries", async () => {
    const outstanding = Array.from({ length: 25 }, (_, index) =>
      roleOperation(`outstanding_${index}`, {
        state: index % 2 === 0 ? "failed" : "partial",
      }),
    );
    const audits = Array.from({ length: 8 }, (_, index) => ({
      guildId: GUILD_ID,
      eventId: `audit_${index}`,
      eventNumber: index + 1,
      eventType: `recovery-*-${index}`,
      memberId: TARGET_ID,
      actorId: OWNER_ID,
      rulesVersion: 1,
      outcome: "partial_*",
      details: { private: "UNRELATED PRIVATE WORKFLOW CONTENT" },
      createdAt: NOW,
    }));
    const context = createHarness({
      subcommand: "member",
      configuration: onboardingConfiguration({
        currentRulesVersion: 1,
        verifiedRoleId: VERIFIED_ROLE_ID,
      }),
      autoroles: [autorole(AUTOROLE_ID)],
      targetRoleIds: [VERIFIED_ROLE_ID, AUTOROLE_ID],
      memberState: {
        screeningState: "complete",
        lifecycleState: "active",
        joinedAt: "2026-08-01T00:00:00.000Z",
        accountCreatedAt: "2025-01-01T00:00:00.000Z",
      },
      acceptances: [acceptance()],
      deliveryRecords: [
        deliveryRecord("delivery_00000001"),
        deliveryRecord("delivery_00000002", {
          kind: "lifecycle-log",
          state: "missing",
          failureCode: "safe-channel-missing",
        }),
        deliveryRecord("delivery_00000003", {
          state: "reserved",
          failureCode: null,
          claimId: "claim_00000001",
          claimExpiresAt: "2026-08-23T12:01:00.000Z",
        }),
      ],
      roleOperations: outstanding,
      audits,
    });

    await run(context);

    expect(context.storage.listMemberRuleAcceptances).toHaveBeenCalledWith(
      TARGET_ID,
      25,
      0,
    );
    expect(context.storage.listOnboardingRoleOperations).toHaveBeenCalledWith({
      memberId: TARGET_ID,
      states: ["reserved", "partial", "failed"],
      unresolvedOnly: true,
      limit: 25,
    });
    expect(context.storage.listOnboardingDeliveries).toHaveBeenCalledWith({
      memberId: TARGET_ID,
      states: ["reserved", "failed", "missing"],
      limit: 25,
      offset: 0,
    });
    expect(context.storage.listOnboardingAuditEvents).toHaveBeenCalledWith({
      memberId: TARGET_ID,
      limit: 5,
      offset: 0,
    });
    expect(context.storage.listOnboardingAutoroles).toHaveBeenCalledWith(
      undefined,
      20,
      0,
    );
    const payload = expectPrivateReply(context);
    expect(payload.content).toContain(
      "Outstanding recovery records: 28+ (25+ role; 3 delivery)",
    );
    expect(payload.content).not.toContain("delivery_00000003");
    expect(payload.content).not.toContain("safe-channel-missing");
    expect(payload.content).not.toContain("claim_00000001");
    expect(payload.content).toContain("accepted current v1");
    expect(payload.content).not.toContain("UNRELATED PRIVATE WORKFLOW CONTENT");
    expect(payload.content).not.toContain("recovery-*-");
    expect(payload.content).not.toContain("partial_*");
  });

  it("bounds delivery-only recovery status without exposing record metadata", async () => {
    const deliveries = Array.from({ length: 25 }, (_, index) =>
      deliveryRecord(`private_delivery_${index}`, {
        failureCode: `private_failure_${index}`,
      }),
    );
    const context = createHarness({
      subcommand: "member",
      deliveryRecords: deliveries,
    });

    await run(context);

    const payload = expectPrivateReply(context);
    expect(payload.content).toContain(
      "Outstanding recovery records: 25+ (0 role; 25+ delivery)",
    );
    expect(payload.content).not.toContain("private_delivery_");
    expect(payload.content).not.toContain("private_failure_");
  });

  it("refuses per-member recovery while native screening is pending", async () => {
    const context = createHarness({
      subcommand: "recover",
      targetPending: true,
      configuration: onboardingConfiguration({ enabled: true }),
    });

    await run(context);

    expect(lifecycleMocks.retryGuildMemberLifecycle).not.toHaveBeenCalled();
    expect(context.storage.getOnboardingConfiguration).not.toHaveBeenCalled();
    expect(
      context.storage.reserveOnboardingRoleOperation,
    ).not.toHaveBeenCalled();
    expect(context.storage.appendOnboardingAudit).not.toHaveBeenCalled();
    expect(expectPrivateReply(context).content).toContain(
      "will not bypass the pending state",
    );
  });

  it("re-reads configuration after lifecycle work and never mutates the old verified role", async () => {
    const context = createHarness({
      subcommand: "recover",
      configuration: onboardingConfiguration({
        enabled: true,
        verificationEnabled: true,
        currentRulesVersion: 1,
        verifiedRoleId: VERIFIED_ROLE_ID,
      }),
      acceptances: [acceptance()],
      availableRoleIds: [VERIFIED_ROLE_ID, REPLACEMENT_ROLE_ID],
      lifecycleResult: {
        status: "processed",
        deliveries: [],
        roles: [],
      },
    });
    lifecycleMocks.retryGuildMemberLifecycle.mockImplementationOnce(
      async () => {
        context.setConfiguration(
          onboardingConfiguration({
            enabled: true,
            verificationEnabled: true,
            currentRulesVersion: 1,
            verifiedRoleId: REPLACEMENT_ROLE_ID,
          }),
        );
        return {
          status: "processed",
          deliveries: [],
          roles: [],
        };
      },
    );

    await run(context);

    expect(context.targetRoleAdd).toHaveBeenCalledOnce();
    expect(context.targetRoleAdd.mock.calls[0]![0]).toMatchObject({
      id: REPLACEMENT_ROLE_ID,
    });
    expect(context.targetRoleAdd).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: VERIFIED_ROLE_ID }),
      expect.any(String),
    );
    expect(context.storage.reserveOnboardingRoleOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        roleId: REPLACEMENT_ROLE_ID,
        idempotencyKey: expect.stringContaining(REPLACEMENT_ROLE_ID),
      }),
    );
    expect(lifecycleMocks.deliverPrivateLifecycleLog).toHaveBeenCalledOnce();
    expect(expectPrivateReply(context).content).toContain(
      "Overall outcome: completed",
    );
  });

  it("rechecks recovery authority after fetching the member and before lifecycle effects", async () => {
    const context = createHarness({
      subcommand: "recover",
      actor: "delegate",
      grantSequence: [["onboarding.configure"], ["roles.configure"]],
      configuration: onboardingConfiguration({ enabled: true }),
      lifecycleResult: {
        status: "processed",
        deliveries: [],
        roles: [],
      },
    });

    await run(context);

    expect(context.storage.listCapabilitiesForRoles).toHaveBeenCalledTimes(2);
    expect(lifecycleMocks.retryGuildMemberLifecycle).not.toHaveBeenCalled();
    expect(
      context.storage.reserveOnboardingRoleOperation,
    ).not.toHaveBeenCalled();
    expect(expectPrivateReply(context).content).toContain(
      "authority or the active configuration changed before recovery could begin",
    );
  });

  it("rechecks delegated authority after role inspection and before mutation", async () => {
    const context = createHarness({
      subcommand: "recover",
      actor: "delegate",
      grantSequence: [
        ["onboarding.configure"],
        ["onboarding.configure"],
        ["onboarding.configure"],
        ["onboarding.configure"],
        ["roles.configure"],
      ],
      configuration: onboardingConfiguration({
        enabled: true,
        verificationEnabled: true,
        currentRulesVersion: 1,
        verifiedRoleId: VERIFIED_ROLE_ID,
      }),
      acceptances: [acceptance()],
      availableRoleIds: [VERIFIED_ROLE_ID],
      lifecycleResult: {
        status: "processed",
        deliveries: [],
        roles: [],
      },
    });

    await run(context);

    expect(context.storage.listCapabilitiesForRoles).toHaveBeenCalledTimes(5);
    expect(context.targetRoleAdd).not.toHaveBeenCalled();
    expect(
      context.storage.completeOnboardingRoleOperation,
    ).toHaveBeenCalledWith(expect.any(String), {
      state: "failed",
      failureCode: "configuration-or-authority-changed",
    });
    expect(lifecycleMocks.deliverPrivateLifecycleLog).not.toHaveBeenCalled();
    const payload = expectPrivateReply(context);
    expect(payload.content).toContain(
      "Authority/configuration recheck: changed",
    );
    expect(payload.content).toContain("Overall outcome: partial");
  });

  it("does not rewrite a successful Discord role effect as failed when completion persistence fails", async () => {
    const context = createHarness({
      subcommand: "recover",
      configuration: onboardingConfiguration({
        enabled: true,
        verificationEnabled: true,
        currentRulesVersion: 1,
        verifiedRoleId: VERIFIED_ROLE_ID,
      }),
      acceptances: [acceptance()],
      availableRoleIds: [VERIFIED_ROLE_ID],
      lifecycleResult: {
        status: "processed",
        deliveries: [],
        roles: [],
      },
    });
    context.storage.completeOnboardingRoleOperation.mockImplementationOnce(
      () => {
        throw new Error("database write failed");
      },
    );

    await run(context);

    expect(context.targetRoleAdd).toHaveBeenCalledOnce();
    expect(
      context.storage.completeOnboardingRoleOperation,
    ).toHaveBeenCalledOnce();
    expect(
      context.storage.completeOnboardingRoleOperation,
    ).toHaveBeenCalledWith(expect.any(String), { state: "completed" });
    expect(
      context.storage.completeOnboardingRoleOperation,
    ).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ state: "failed" }),
    );
    expect(lifecycleMocks.deliverPrivateLifecycleLog).not.toHaveBeenCalled();
    const payload = expectPrivateReply(context);
    expect(payload.content).toContain(
      "1 Discord-confirmed with incomplete records",
    );
    expect(payload.content).toContain("Overall outcome: partial");
  });

  it("resolves matching incomplete records after recovery is durably successful", async () => {
    const context = createHarness({
      subcommand: "recover",
      configuration: onboardingConfiguration({
        enabled: true,
        verificationEnabled: true,
        currentRulesVersion: 1,
        verifiedRoleId: VERIFIED_ROLE_ID,
      }),
      acceptances: [acceptance()],
      availableRoleIds: [VERIFIED_ROLE_ID],
      targetRoleIds: [VERIFIED_ROLE_ID],
      lifecycleResult: { status: "processed", deliveries: [], roles: [] },
    });

    await run(context);

    expect(
      context.storage.completeOnboardingRoleOperation,
    ).toHaveBeenCalledWith("operation_1", { state: "no-change" });
    expect(
      context.storage.resolveOnboardingRoleOperations,
    ).toHaveBeenCalledWith("operation_1");
    expect(
      context.storage.completeOnboardingRoleOperation.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      context.storage.resolveOnboardingRoleOperations.mock
        .invocationCallOrder[0]!,
    );
    expect(expectPrivateReply(context).content).toContain(
      "Overall outcome: completed",
    );
  });

  it("reports recovery as partial when reconciliation metadata cannot be persisted", async () => {
    const context = createHarness({
      subcommand: "recover",
      configuration: onboardingConfiguration({
        enabled: true,
        verificationEnabled: true,
        currentRulesVersion: 1,
        verifiedRoleId: VERIFIED_ROLE_ID,
      }),
      acceptances: [acceptance()],
      availableRoleIds: [VERIFIED_ROLE_ID],
      targetRoleIds: [VERIFIED_ROLE_ID],
      lifecycleResult: { status: "processed", deliveries: [], roles: [] },
    });
    context.storage.resolveOnboardingRoleOperations.mockImplementationOnce(
      () => {
        throw new Error("resolution write failed");
      },
    );

    await run(context);

    expect(context.targetRoleAdd).not.toHaveBeenCalled();
    expect(
      context.storage.resolveOnboardingRoleOperations,
    ).toHaveBeenCalledOnce();
    const payload = expectPrivateReply(context);
    expect(payload.content).toContain(
      "1 Discord-confirmed with incomplete records",
    );
    expect(payload.content).toContain("Overall outcome: partial");
  });

  it("reports and records exact partial per-member recovery outcomes", async () => {
    const context = createHarness({
      subcommand: "recover",
      configuration: onboardingConfiguration({
        enabled: true,
        verificationEnabled: true,
        currentRulesVersion: 1,
        verifiedRoleId: VERIFIED_ROLE_ID,
        unverifiedRoleId: UNVERIFIED_ROLE_ID,
        humanAutorolesEnabled: true,
      }),
      acceptances: [acceptance()],
      autoroles: [
        autorole(AUTOROLE_ID, {
          enabled: true,
          bindingsVerifiedAt: NOW,
        }),
      ],
      availableRoleIds: [VERIFIED_ROLE_ID, UNVERIFIED_ROLE_ID, AUTOROLE_ID],
      targetRoleIds: [UNVERIFIED_ROLE_ID, AUTOROLE_ID],
      targetRoleRemoveError: new Error("Discord role removal failed"),
      lifecycleResult: {
        status: "processed",
        deliveries: [{ status: "delivered" }, { status: "failed" }],
        roles: [{ status: "failed" }],
      },
    });

    await run(context);

    expect(lifecycleMocks.retryGuildMemberLifecycle).toHaveBeenCalledWith(
      context.runtime,
      context.target,
    );
    expect(context.targetRoleAdd).toHaveBeenCalledOnce();
    expect(context.targetRoleRemove).toHaveBeenCalledOnce();
    expect(context.targetRoleAdd.mock.invocationCallOrder[0]).toBeLessThan(
      context.targetRoleRemove.mock.invocationCallOrder[0]!,
    );
    expect(
      context.storage.reserveOnboardingRoleOperation,
    ).toHaveBeenCalledTimes(3);
    expect(
      context.storage.completeOnboardingRoleOperation,
    ).toHaveBeenCalledTimes(3);
    expect(
      context.storage.completeOnboardingRoleOperation,
    ).toHaveBeenCalledWith(expect.any(String), {
      state: "failed",
      failureCode: expect.any(String),
    });
    const payload = expectPrivateReply(context);
    expect(payload.content).toContain(
      "Lifecycle result: processed (confirmed)",
    );
    expect(payload.content).toContain(
      "Lifecycle deliveries: 1/2 confirmed, 1 incomplete",
    );
    expect(payload.content).toContain(
      "Lifecycle roles: 0/1 confirmed, 1 incomplete",
    );
    expect(payload.content).toContain(
      "Recovery roles: 2 fully recorded, 0 Discord-confirmed with incomplete records, 1 incomplete without a confirmed effect",
    );
    expect(payload.content).toContain("Overall outcome: partial");
    expect(context.storage.appendOnboardingAudit).toHaveBeenCalledWith({
      eventType: "member-recovery",
      memberId: TARGET_ID,
      actorId: OWNER_ID,
      rulesVersion: 1,
      outcome: "partial",
      details: {
        lifecycleStatus: "processed",
        lifecycleStatusIncomplete: false,
        attemptedDeliveryCount: 2,
        confirmedDeliveryCount: 1,
        failedDeliveryCount: 1,
        attemptedLifecycleRoleCount: 1,
        confirmedLifecycleRoleCount: 0,
        failedLifecycleRoleCount: 1,
        attemptedRoleCount: 3,
        confirmedRoleCount: 2,
        effectSucceededRecordIncompleteCount: 0,
        failedRoleCount: 1,
        authorityOrConfigurationChanged: false,
        verificationRecovered: false,
        verificationLogStatus: null,
      },
    });
    expect(lifecycleMocks.deliverPrivateLifecycleLog).not.toHaveBeenCalled();
    expect(context.storage.recordCommandMetric).toHaveBeenCalledWith(
      "onboarding.recover",
      false,
    );
  });

  it("does not grant the current verified role from only an older acceptance", async () => {
    const context = createHarness({
      subcommand: "recover",
      configuration: onboardingConfiguration({
        enabled: true,
        verificationEnabled: true,
        currentRulesVersion: 2,
        verifiedRoleId: VERIFIED_ROLE_ID,
      }),
      acceptances: [acceptance({ rulesVersion: 1 })],
      availableRoleIds: [VERIFIED_ROLE_ID],
      lifecycleResult: { status: "processed", deliveries: [], roles: [] },
    });

    await run(context);

    expect(context.targetRoleAdd).not.toHaveBeenCalled();
    expect(
      context.storage.reserveOnboardingRoleOperation,
    ).not.toHaveBeenCalled();
    expect(lifecycleMocks.deliverPrivateLifecycleLog).not.toHaveBeenCalled();
    expect(context.storage.appendOnboardingAudit).toHaveBeenCalledWith(
      expect.objectContaining({ rulesVersion: null }),
    );
  });

  it("never re-adds an accepted member's unverified role as an autorole", async () => {
    const context = createHarness({
      subcommand: "recover",
      configuration: onboardingConfiguration({
        enabled: true,
        verificationEnabled: true,
        currentRulesVersion: 1,
        verifiedRoleId: VERIFIED_ROLE_ID,
        unverifiedRoleId: UNVERIFIED_ROLE_ID,
        humanAutorolesEnabled: true,
      }),
      acceptances: [acceptance()],
      autoroles: [
        autorole(UNVERIFIED_ROLE_ID, {
          enabled: true,
          bindingsVerifiedAt: NOW,
        }),
      ],
      availableRoleIds: [VERIFIED_ROLE_ID, UNVERIFIED_ROLE_ID],
      targetRoleIds: [UNVERIFIED_ROLE_ID],
      lifecycleResult: { status: "processed", deliveries: [], roles: [] },
    });

    await run(context);

    expect(context.targetRoleAdd).toHaveBeenCalledOnce();
    expect(context.targetRoleAdd).toHaveBeenCalledWith(
      expect.objectContaining({ id: VERIFIED_ROLE_ID }),
      expect.any(String),
    );
    expect(context.targetRoleRemove).toHaveBeenCalledOnce();
    expect(
      context.storage.reserveOnboardingRoleOperation,
    ).toHaveBeenCalledTimes(2);
    expect(expectPrivateReply(context).content).toContain(
      "Overall outcome: completed",
    );
  });
});
