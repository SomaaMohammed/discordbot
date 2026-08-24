import { isDeepStrictEqual } from "node:util";
import { ChannelType } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotRuntime, GuildRuntime } from "../src/runtime.js";
import type {
  MemberOnboardingState,
  MemberOnboardingStateInput,
  OnboardingAuditEvent,
  OnboardingAuditEventInput,
  OnboardingAutorole,
  OnboardingConfiguration,
  OnboardingDeliveryCompletionInput,
  OnboardingDeliveryRecord,
  OnboardingDeliveryReservationInput,
  OnboardingDeliveryReservationResult,
  OnboardingRoleOperation,
  OnboardingRoleOperationCompletionInput,
  OnboardingRoleOperationReservationInput,
  OnboardingRoleOperationReservationResult,
} from "../src/types.js";
import {
  createMemberLifecycleService,
  type MemberLifecycleDeliveryRequest,
  type MemberLifecycleEffects,
  type MemberLifecycleRepository,
  type MemberLifecycleRoleRequest,
  type MemberLifecycleSnapshot,
} from "../src/discord/member-lifecycle-service.js";
import {
  createDiscordMemberLifecycleEffects,
  handleGuildMemberAdded,
  memberLifecycleQueueSize,
  runMemberLifecycleSerial,
} from "../src/discord/member-lifecycle-discord.js";

const logging = vi.hoisted(() => ({ logInfo: vi.fn() }));

vi.mock("../src/logging.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/logging.js")>()),
  logInfo: logging.logInfo,
}));

const GUILD_ID = "12345678901234567";
const MEMBER_ID = "22345678901234567";
const BOT_ID = "32345678901234567";
const WELCOME_CHANNEL_ID = "42345678901234567";
const FAREWELL_CHANNEL_ID = "52345678901234567";
const LOG_CHANNEL_ID = "62345678901234567";
const RULES_CHANNEL_ID = "72345678901234567";
const HUMAN_ROLE_ONE = "82345678901234567";
const HUMAN_ROLE_TWO = "92345678901234567";
const BOT_ROLE = "10345678901234567";
const NOW = new Date("2026-08-23T12:00:00.000Z");
const JOINED_AT = new Date("2026-08-23T11:00:00.000Z");
const CREATED_AT = new Date("2026-08-23T00:00:00.000Z");

afterEach(() => {
  logging.logInfo.mockReset();
});

describe("member lifecycle service", () => {
  it("processes a human join sequentially and persists idempotent reservations", async () => {
    const repository = new FakeLifecycleRepository(baseConfiguration());
    repository.autoroles.push(
      autorole(HUMAN_ROLE_TWO, "human", 1),
      autorole(HUMAN_ROLE_ONE, "human", 0),
      autorole(BOT_ROLE, "bot", 0),
    );
    const effects = new FakeEffects();
    const service = lifecycleService(repository, effects);
    const snapshot = humanSnapshot({ displayName: "@everyone **Visitor**" });

    const first = await service.handleJoin(snapshot);
    const second = await service.handleJoin(snapshot);

    expect(first.status).toBe("processed");
    expect(first.state).toMatchObject({
      memberKind: "human",
      screeningState: "complete",
      lifecycleState: "active",
    });
    expect(first.roles.map((role) => [role.roleId, role.status])).toEqual([
      [HUMAN_ROLE_ONE, "added"],
      [HUMAN_ROLE_TWO, "added"],
    ]);
    expect(effects.roleRequests.map((request) => request.roleId)).toEqual([
      HUMAN_ROLE_ONE,
      HUMAN_ROLE_TWO,
    ]);
    expect(effects.maximumConcurrentRoleAdds).toBe(1);
    expect(first.deliveries.map((delivery) => delivery.kind)).toEqual([
      "welcome-public",
      "welcome-dm",
      "lifecycle-log",
    ]);
    expect(effects.deliveryRequests.map((request) => request.kind)).toEqual([
      "welcome-public",
      "welcome-dm",
      "lifecycle-log",
    ]);
    const publicRequest = effects.deliveryRequests.find(
      (request) => request.kind === "welcome-public",
    );
    expect(JSON.stringify(publicRequest)).not.toContain("@everyone");
    const logRequest = effects.deliveryRequests.find(
      (request) => request.kind === "lifecycle-log",
    );
    expect(logRequest).toMatchObject({
      events: [
        { kind: "member-joined", memberId: MEMBER_ID },
        { kind: "account-age-alert", memberId: MEMBER_ID, thresholdHours: 24 },
      ],
    });

    expect(second.roles.every((role) => role.status === "duplicate")).toBe(
      true,
    );
    expect(
      second.deliveries.every((delivery) => delivery.status === "duplicate"),
    ).toBe(true);
    expect(effects.roleRequests).toHaveLength(2);
    expect(effects.deliveryRequests).toHaveLength(3);
    expect(repository.audits.map((audit) => audit.eventType)).toEqual([
      "member-joined",
    ]);
  });

  it("keeps bot and human automatic-role audiences separate", async () => {
    const repository = new FakeLifecycleRepository(
      baseConfiguration({
        welcomePublicEnabled: false,
        welcomeDmEnabled: false,
        lifecycleLogChannelId: null,
        lifecycleLogChannelVerifiedAt: null,
      }),
    );
    repository.autoroles.push(
      autorole(HUMAN_ROLE_ONE, "human", 0),
      autorole(BOT_ROLE, "bot", 0),
    );
    const effects = new FakeEffects();
    const service = lifecycleService(repository, effects);

    const result = await service.handleJoin(botSnapshot());

    expect(result.status).toBe("processed");
    expect(result.state).toMatchObject({
      memberKind: "bot",
      screeningState: "unknown",
      lifecycleState: "active",
    });
    expect(effects.roleRequests).toEqual([
      expect.objectContaining({
        memberId: BOT_ID,
        roleId: BOT_ROLE,
        audience: "bot",
        operationKind: "bot-autorole-add",
      }),
    ]);
    expect(repository.audits[0]?.eventType).toBe("bot-joined");
  });

  it("defers a pending human and resumes once native screening completes", async () => {
    const repository = new FakeLifecycleRepository(
      baseConfiguration({
        welcomePublicEnabled: false,
        welcomeDmEnabled: false,
        lifecycleLogChannelId: null,
        lifecycleLogChannelVerifiedAt: null,
      }),
    );
    repository.autoroles.push(autorole(HUMAN_ROLE_ONE, "human", 0));
    const effects = new FakeEffects();
    const service = lifecycleService(repository, effects);
    const pending = humanSnapshot({ pending: true });

    const joined = await service.handleJoin(pending);
    const completed = await service.handleScreeningUpdate({
      ...pending,
      pending: false,
    });
    const repeated = await service.handleScreeningUpdate({
      ...pending,
      pending: false,
    });

    expect(joined.status).toBe("deferred");
    expect(joined.state?.lifecycleState).toBe("pending-screening");
    expect(joined.roles).toEqual([]);
    expect(completed.status).toBe("processed");
    expect(completed.state).toMatchObject({
      screeningState: "complete",
      lifecycleState: "active",
      screeningCompletedAt: NOW.toISOString(),
    });
    expect(completed.roles[0]?.status).toBe("added");
    expect(repeated.status).toBe("no-change");
    expect(repeated.roles[0]?.status).toBe("duplicate");
    expect(effects.roleRequests).toHaveLength(1);
    expect(repository.audits.map((audit) => audit.eventType)).toEqual([
      "member-joined",
      "native-screening-completed",
    ]);
  });

  it("keeps public, DM, and private-log delivery failures best effort", async () => {
    const repository = new FakeLifecycleRepository(
      baseConfiguration({
        humanAutorolesEnabled: false,
        botAutorolesEnabled: false,
      }),
    );
    const effects = new FakeEffects();
    effects.failedDeliveryKinds.add("welcome-public");
    effects.failedDeliveryKinds.add("welcome-dm");
    effects.failedDeliveryKinds.add("lifecycle-log");
    const service = lifecycleService(repository, effects);

    const result = await service.handleJoin(humanSnapshot());

    expect(result.status).toBe("processed");
    expect(result.deliveries).toEqual([
      {
        kind: "welcome-public",
        status: "failed",
        failureCode: "safe-welcome-public-failure",
      },
      {
        kind: "welcome-dm",
        status: "failed",
        failureCode: "safe-welcome-dm-failure",
      },
      {
        kind: "lifecycle-log",
        status: "failed",
        failureCode: "safe-lifecycle-log-failure",
      },
    ]);
    expect(effects.deliveryRequests.map((request) => request.kind)).toEqual([
      "welcome-public",
      "welcome-dm",
      "lifecycle-log",
    ]);
    expect(
      [...repository.deliveries.values()].map((delivery) => delivery.state),
    ).toEqual(["failed", "failed", "failed"]);
  });

  it("records each automatic-role outcome and continues after a role failure", async () => {
    const repository = new FakeLifecycleRepository(
      baseConfiguration({
        welcomePublicEnabled: false,
        welcomeDmEnabled: false,
      }),
    );
    repository.autoroles.push(
      autorole(HUMAN_ROLE_ONE, "human", 0),
      autorole(HUMAN_ROLE_TWO, "human", 1),
    );
    const effects = new FakeEffects();
    effects.failedRoleIds.add(HUMAN_ROLE_ONE);
    const service = lifecycleService(repository, effects);

    const result = await service.handleJoin(humanSnapshot());

    expect(result.roles).toEqual([
      {
        roleId: HUMAN_ROLE_ONE,
        operationKind: "human-autorole-add",
        status: "failed",
        failureCode: "safe-human-autorole-add-failure",
      },
      {
        roleId: HUMAN_ROLE_TWO,
        operationKind: "human-autorole-add",
        status: "added",
        failureCode: null,
      },
    ]);
    expect(effects.roleRequests.map((request) => request.roleId)).toEqual([
      HUMAN_ROLE_ONE,
      HUMAN_ROLE_TWO,
    ]);
    expect(effects.maximumConcurrentRoleAdds).toBe(1);
    expect(effects.deliveryRequests[0]).toMatchObject({
      kind: "lifecycle-log",
      events: expect.arrayContaining([
        {
          kind: "automatic-role-failure",
          memberId: MEMBER_ID,
          roleId: HUMAN_ROLE_ONE,
          failureCode: "safe-human-autorole-add-failure",
        },
      ]),
    });
  });

  it("records leave state and delivers farewell/log only once", async () => {
    const repository = new FakeLifecycleRepository(
      baseConfiguration({
        welcomePublicEnabled: false,
        welcomeDmEnabled: false,
        humanAutorolesEnabled: false,
        botAutorolesEnabled: false,
      }),
    );
    const effects = new FakeEffects();
    const service = lifecycleService(repository, effects);
    await service.handleJoin(humanSnapshot());
    effects.deliveryRequests.length = 0;

    const first = await service.handleLeave(humanSnapshot());
    const second = await service.handleLeave(humanSnapshot());

    expect(first.status).toBe("processed");
    expect(first.state).toMatchObject({
      lifecycleState: "departed",
      departedAt: NOW.toISOString(),
    });
    expect(first.deliveries.map((delivery) => delivery.kind)).toEqual([
      "farewell-public",
      "lifecycle-log",
    ]);
    expect(second.status).toBe("no-change");
    expect(second.deliveries).toEqual([]);
    expect(effects.deliveryRequests.map((request) => request.kind)).toEqual([
      "farewell-public",
      "lifecycle-log",
    ]);
    expect(repository.audits.map((audit) => audit.eventType)).toEqual([
      "member-joined",
      "member-left",
    ]);
  });

  it("checkpoints a completed effect and stops new work after generation invalidation", async () => {
    const repository = new FakeLifecycleRepository(
      baseConfiguration({
        humanAutorolesEnabled: false,
        botAutorolesEnabled: false,
      }),
    );
    let current = true;
    const effects = new FakeEffects();
    effects.afterDelivery = () => {
      current = false;
    };
    const service = lifecycleService(repository, effects, () => current);

    const result = await service.handleJoin(humanSnapshot());

    expect(result.status).toBe("stale");
    expect(effects.deliveryRequests.map((request) => request.kind)).toEqual([
      "welcome-public",
    ]);
    expect(result.deliveries).toEqual([
      { kind: "welcome-public", status: "delivered", failureCode: null },
    ]);
    expect([...repository.deliveries.values()][0]).toMatchObject({
      state: "delivered",
      messageId: "88345678901234567",
    });
  });

  it("halts remaining role and delivery effects when onboarding is disabled mid-run", async () => {
    const repository = new FakeLifecycleRepository(baseConfiguration());
    repository.autoroles.push(
      autorole(HUMAN_ROLE_ONE, "human", 0),
      autorole(HUMAN_ROLE_TWO, "human", 1),
    );
    const effects = new FakeEffects();
    effects.afterRole = () => {
      repository.configuration = repository.configuration
        ? {
            ...repository.configuration,
            enabled: false,
            updatedAt: "2026-08-23T12:00:01.000Z",
          }
        : null;
    };
    const service = lifecycleService(repository, effects);

    const result = await service.handleJoin(humanSnapshot());

    expect(result.status).toBe("stale");
    expect(result.roles.map(({ roleId, status }) => [roleId, status])).toEqual([
      [HUMAN_ROLE_ONE, "added"],
    ]);
    expect(effects.roleRequests.map(({ roleId }) => roleId)).toEqual([
      HUMAN_ROLE_ONE,
    ]);
    expect(effects.deliveryRequests).toEqual([]);
  });

  it("halts remaining deliveries when the onboarding configuration changes", async () => {
    const repository = new FakeLifecycleRepository(
      baseConfiguration({
        humanAutorolesEnabled: false,
        botAutorolesEnabled: false,
      }),
    );
    const effects = new FakeEffects();
    effects.afterDelivery = () => {
      repository.configuration = repository.configuration
        ? {
            ...repository.configuration,
            welcomeDmEnabled: false,
            updatedAt: "2026-08-23T12:00:01.000Z",
          }
        : null;
    };
    const service = lifecycleService(repository, effects);

    const result = await service.handleJoin(humanSnapshot());

    expect(result.status).toBe("stale");
    expect(result.deliveries).toEqual([
      { kind: "welcome-public", status: "delivered", failureCode: null },
    ]);
    expect(effects.deliveryRequests.map(({ kind }) => kind)).toEqual([
      "welcome-public",
    ]);
  });

  it("halts an old role plan when its persisted autorole definition changes", async () => {
    const repository = new FakeLifecycleRepository(baseConfiguration());
    repository.autoroles.push(
      autorole(HUMAN_ROLE_ONE, "human", 0),
      autorole(HUMAN_ROLE_TWO, "human", 1),
    );
    const effects = new FakeEffects();
    effects.afterRole = () => {
      const secondRole = repository.autoroles[1];
      if (!secondRole) throw new Error("missing second test autorole");
      repository.autoroles[1] = {
        ...secondRole,
        enabled: false,
        updatedAt: "2026-08-23T12:00:01.000Z",
      };
    };
    const service = lifecycleService(repository, effects);

    const result = await service.handleJoin(humanSnapshot());

    expect(result.status).toBe("stale");
    expect(result.roles.map(({ roleId, status }) => [roleId, status])).toEqual([
      [HUMAN_ROLE_ONE, "added"],
    ]);
    expect(effects.roleRequests.map(({ roleId }) => roleId)).toEqual([
      HUMAN_ROLE_ONE,
    ]);
    expect(effects.deliveryRequests).toEqual([]);
  });

  it("does not create work after the shutdown acceptance gate closes", async () => {
    const repository = new FakeLifecycleRepository(baseConfiguration());
    const effects = new FakeEffects();
    const service = lifecycleService(
      repository,
      effects,
      () => true,
      () => false,
    );

    const result = await service.handleJoin(humanSnapshot());

    expect(result.status).toBe("not-accepting");
    expect(repository.states.size).toBe(0);
    expect(effects.roleRequests).toEqual([]);
    expect(effects.deliveryRequests).toEqual([]);
  });

  it("keeps a successful autorole effect partial when checkpoint persistence fails", async () => {
    const repository = new FakeLifecycleRepository(
      baseConfiguration({
        welcomePublicEnabled: false,
        welcomeDmEnabled: false,
        lifecycleLogChannelId: null,
        lifecycleLogChannelVerifiedAt: null,
      }),
    );
    repository.autoroles.push(autorole(HUMAN_ROLE_ONE, "human", 0));
    repository.roleCompletionFailuresRemaining = 1;
    const effects = new FakeEffects();
    const service = lifecycleService(repository, effects);

    const result = await service.handleJoin(humanSnapshot());

    expect(effects.roleRequests).toHaveLength(1);
    expect(result.roles).toEqual([
      {
        roleId: HUMAN_ROLE_ONE,
        operationKind: "human-autorole-add",
        status: "partial",
        failureCode: "role-checkpoint-persistence",
      },
    ]);
    expect(repository.roleCompletionStates).toEqual(["completed", "partial"]);
    expect([...repository.roleOperations.values()][0]).toMatchObject({
      state: "partial",
      failureCode: "role-checkpoint-persistence",
    });
  });

  it("persists an ordered transition but suppresses effects for a superseded event", async () => {
    const repository = new FakeLifecycleRepository(baseConfiguration());
    repository.autoroles.push(autorole(HUMAN_ROLE_ONE, "human", 0));
    const effects = new FakeEffects();
    const service = lifecycleService(
      repository,
      effects,
      () => true,
      () => true,
      () => false,
    );

    const joined = await service.handleJoin(humanSnapshot());
    const left = await service.handleLeave(humanSnapshot());

    expect(joined).toMatchObject({
      status: "stale",
      state: { lifecycleState: "active" },
      deliveries: [],
      roles: [],
    });
    expect(left).toMatchObject({
      status: "stale",
      state: { lifecycleState: "departed" },
      deliveries: [],
      roles: [],
    });
    expect(effects.roleRequests).toEqual([]);
    expect(effects.deliveryRequests).toEqual([]);
    expect(repository.audits.map(({ eventType }) => eventType)).toEqual([
      "member-joined",
      "member-left",
    ]);
  });

  it("serializes member events and suppresses obsolete leave/rejoin effects", async () => {
    const order: string[] = [];
    const currentChecks: boolean[] = [];
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const rejoinedAt = new Date(JOINED_AT.getTime() + 60_000);

    const firstJoin = runMemberLifecycleSerial(
      GUILD_ID,
      MEMBER_ID,
      "join",
      JOINED_AT,
      async (isCurrentEvent) => {
        order.push("first-join:start");
        markFirstStarted();
        await firstGate;
        currentChecks.push(isCurrentEvent());
        order.push("first-join:end");
      },
    );
    await firstStarted;
    const leave = runMemberLifecycleSerial(
      GUILD_ID,
      MEMBER_ID,
      "leave",
      JOINED_AT,
      async (isCurrentEvent) => {
        order.push("leave");
        currentChecks.push(isCurrentEvent());
      },
    );
    const rejoin = runMemberLifecycleSerial(
      GUILD_ID,
      MEMBER_ID,
      "join",
      rejoinedAt,
      async (isCurrentEvent) => {
        order.push("rejoin");
        currentChecks.push(isCurrentEvent());
      },
    );

    expect(memberLifecycleQueueSize()).toBe(1);
    releaseFirst();
    await Promise.all([firstJoin, leave, rejoin]);

    expect(order).toEqual([
      "first-join:start",
      "first-join:end",
      "leave",
      "rejoin",
    ]);
    expect(currentChecks).toEqual([false, false, true]);
    expect(memberLifecycleQueueSize()).toBe(0);
  });

  it("rechecks runtime generation after fetching a member for a welcome DM", async () => {
    let current = true;
    let resolveMember!: (member: unknown) => void;
    const memberResult = new Promise<unknown>((resolve) => {
      resolveMember = resolve;
    });
    const send = vi.fn();
    const fetch = vi.fn(() => memberResult);
    const runtime = {
      guildId: GUILD_ID,
      isCurrent: () => current,
    } as unknown as GuildRuntime;
    const guild = {
      id: GUILD_ID,
      members: { fetch },
    };
    const effects = createDiscordMemberLifecycleEffects(
      runtime,
      guild as never,
    );

    const delivery = effects.deliver({
      kind: "welcome-dm",
      guildId: GUILD_ID,
      memberId: MEMBER_ID,
      channelId: null,
      message: { title: "Welcome", body: "Welcome safely." },
    });
    expect(fetch).toHaveBeenCalledOnce();
    current = false;
    resolveMember({ guild: { id: GUILD_ID }, send });

    await expect(delivery).rejects.toThrow("runtime changed");
    expect(send).not.toHaveBeenCalled();
  });

  it("rechecks the persisted definition after fetching a welcome-DM member", async () => {
    let definitionCurrent = true;
    let resolveMember!: (member: unknown) => void;
    const memberResult = new Promise<unknown>((resolve) => {
      resolveMember = resolve;
    });
    const send = vi.fn();
    const fetch = vi.fn(() => memberResult);
    const runtime = {
      guildId: GUILD_ID,
      isCurrent: () => true,
    } as unknown as GuildRuntime;
    const guild = {
      id: GUILD_ID,
      members: { fetch },
    };
    const effects = createDiscordMemberLifecycleEffects(
      runtime,
      guild as never,
    );

    const delivery = effects.deliver(
      {
        kind: "welcome-dm",
        guildId: GUILD_ID,
        memberId: MEMBER_ID,
        channelId: null,
        message: { title: "Welcome", body: "Welcome safely." },
      },
      () => definitionCurrent,
    );
    expect(fetch).toHaveBeenCalledOnce();
    definitionCurrent = false;
    resolveMember({ guild: { id: GUILD_ID }, send });

    await expect(delivery).rejects.toThrow("definition changed");
    expect(send).not.toHaveBeenCalled();
  });

  it("rechecks the persisted definition after fetching automatic-role resources", async () => {
    let definitionCurrent = true;
    let resolveMember!: (member: unknown) => void;
    const memberResult = new Promise<unknown>((resolve) => {
      resolveMember = resolve;
    });
    const add = vi.fn();
    const runtime = {
      guildId: GUILD_ID,
      isCurrent: () => true,
    } as unknown as GuildRuntime;
    const guild = {
      id: GUILD_ID,
      members: {
        fetch: vi.fn(() => memberResult),
        fetchMe: vi.fn(async () => ({
          guild: { id: GUILD_ID },
          user: { bot: true },
          permissions: { has: () => true },
          roles: { highest: { comparePositionTo: () => 1 } },
        })),
      },
      roles: {
        fetch: vi.fn(async () => ({
          guild: { id: GUILD_ID },
          id: HUMAN_ROLE_ONE,
          managed: false,
          permissions: { bitfield: 0n },
        })),
      },
    };
    const effects = createDiscordMemberLifecycleEffects(
      runtime,
      guild as never,
    );

    const assignment = effects.validateAndAssignRole(
      {
        guildId: GUILD_ID,
        memberId: MEMBER_ID,
        roleId: HUMAN_ROLE_ONE,
        audience: "human",
        operationKind: "human-autorole-add",
      },
      () => definitionCurrent,
    );
    definitionCurrent = false;
    resolveMember({
      guild: { id: GUILD_ID },
      user: { bot: false },
      pending: false,
      roles: { cache: { has: () => false }, add },
    });

    await expect(assignment).rejects.toThrow("definition changed");
    expect(add).not.toHaveBeenCalled();
  });

  it("keeps lifecycle templates and Discord failure text out of terminal logs", async () => {
    const privateTemplateTitle = "PrivateTemplateTitleMarker";
    const privateTemplateBody = "PrivateTemplateBodyMarker";
    const privateDiscordFailure = "PrivateDiscordFailureMarker";
    const repository = new FakeLifecycleRepository(
      baseConfiguration({
        welcomeDmEnabled: false,
        farewellPublicEnabled: false,
        lifecycleLogChannelId: null,
        rulesChannelId: null,
        humanAutorolesEnabled: false,
        botAutorolesEnabled: false,
        accountAgeAlertHours: null,
        welcomeTitle: privateTemplateTitle,
        welcomeBody: privateTemplateBody,
        lifecycleLogChannelVerifiedAt: null,
        rulesChannelVerifiedAt: null,
      }),
    );
    const send = vi.fn(async (_payload: unknown) => {
      throw new Error(privateDiscordFailure);
    });
    const guild = {
      id: GUILD_ID,
      name: "Private test guild",
      memberCount: 42,
      channels: {
        fetch: vi.fn(async () => ({
          id: WELCOME_CHANNEL_ID,
          guild: { id: GUILD_ID },
          type: ChannelType.GuildText,
          isThread: () => false,
          permissionsFor: () => ({ has: () => true }),
          send,
        })),
      },
      members: {
        fetchMe: vi.fn(async () => ({
          guild: { id: GUILD_ID },
          user: { bot: true },
        })),
      },
    };
    const guildRuntime = {
      guildId: GUILD_ID,
      settings: { enabled: true },
      storage: repository,
      isCurrent: () => true,
    } as unknown as GuildRuntime;
    const runtime = {
      forGuild: vi.fn(async (guildId: string) =>
        guildId === GUILD_ID ? guildRuntime : null,
      ),
    } as unknown as BotRuntime;
    const member = {
      id: MEMBER_ID,
      guild,
      user: {
        bot: false,
        username: "Private member",
        createdAt: CREATED_AT,
      },
      pending: false,
      displayName: "Private member",
      joinedAt: JOINED_AT,
    };

    await handleGuildMemberAdded(runtime, member as never, () => true);

    expect(send).toHaveBeenCalledOnce();
    const deliveryPayload = JSON.stringify(send.mock.calls[0]![0]);
    expect(deliveryPayload).toContain(privateTemplateTitle);
    expect(deliveryPayload).toContain(privateTemplateBody);
    expect(logging.logInfo).toHaveBeenCalledOnce();
    expect(logging.logInfo).toHaveBeenCalledWith(
      "onboarding-lifecycle",
      "Member lifecycle operation completed",
      {
        guildId: GUILD_ID,
        memberId: MEMBER_ID,
        operation: "member-add",
        outcome: "processed",
        deliveryCount: 1,
        roleOperationCount: 0,
        failedDeliveryCount: 1,
        failedRoleCount: 0,
      },
    );
    const terminalLogArguments = JSON.stringify(logging.logInfo.mock.calls);
    expect(terminalLogArguments).not.toContain(privateTemplateTitle);
    expect(terminalLogArguments).not.toContain(privateTemplateBody);
    expect(terminalLogArguments).not.toContain(privateDiscordFailure);
  });
});

class FakeLifecycleRepository implements MemberLifecycleRepository {
  public readonly autoroles: OnboardingAutorole[] = [];
  public readonly states = new Map<string, MemberOnboardingState>();
  public readonly deliveries = new Map<string, OnboardingDeliveryRecord>();
  public readonly roleOperations = new Map<string, OnboardingRoleOperation>();
  public readonly audits: OnboardingAuditEvent[] = [];
  public readonly roleCompletionStates: string[] = [];
  public roleCompletionFailuresRemaining = 0;
  private readonly deliveryKeys = new Map<string, string>();
  private readonly roleOperationKeys = new Map<string, string>();
  private nextDelivery = 1;
  private nextRoleOperation = 1;

  public constructor(public configuration: OnboardingConfiguration | null) {}

  public getOnboardingConfiguration(): OnboardingConfiguration | null {
    return this.configuration;
  }

  public isOnboardingLifecycleDefinitionCurrent(
    snapshot: Parameters<
      MemberLifecycleRepository["isOnboardingLifecycleDefinitionCurrent"]
    >[0],
  ): boolean {
    if (!isDeepStrictEqual(this.configuration, snapshot.configuration)) {
      return false;
    }
    if (!snapshot.autoroles) return true;
    return isDeepStrictEqual(
      this.listOnboardingAutoroles(snapshot.autoroles.audience),
      snapshot.autoroles.roles,
    );
  }

  public listOnboardingAutoroles(
    audience?: "human" | "bot",
    limit = 25,
    offset = 0,
  ): OnboardingAutorole[] {
    return this.autoroles
      .filter((role) => audience === undefined || role.audience === audience)
      .slice(offset, offset + limit);
  }

  public getMemberOnboardingState(
    memberId: string,
  ): MemberOnboardingState | null {
    return this.states.get(memberId) ?? null;
  }

  public upsertMemberOnboardingState(
    input: MemberOnboardingStateInput,
  ): MemberOnboardingState {
    const previous = this.states.get(input.memberId);
    const state: MemberOnboardingState = {
      guildId: GUILD_ID,
      ...input,
      createdAt: previous?.createdAt ?? NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    this.states.set(input.memberId, state);
    return state;
  }

  public reserveOnboardingDelivery(
    input: OnboardingDeliveryReservationInput,
  ): OnboardingDeliveryReservationResult {
    const key = `${input.memberId}:${input.joinInstance}:${input.kind}`;
    const existingId = this.deliveryKeys.get(key);
    const existing = existingId ? this.deliveries.get(existingId) : undefined;
    if (existing) {
      if (existing.state === "delivered" || existing.state === "skipped") {
        return { status: "duplicate", delivery: existing };
      }
      if (existing.state === "reserved") {
        return { status: "busy", delivery: existing };
      }
      const retried: OnboardingDeliveryRecord = {
        ...existing,
        state: "reserved",
        channelId: null,
        messageId: null,
        attemptCount: existing.attemptCount + 1,
        failureCode: null,
        claimId: input.claimId,
        claimExpiresAt: input.claimExpiresAt,
        deliveredAt: null,
        updatedAt: NOW.toISOString(),
      };
      this.deliveries.set(existing.deliveryId, retried);
      return { status: "reserved", delivery: retried };
    }
    const deliveryId = `delivery_${String(this.nextDelivery++).padStart(8, "0")}`;
    const delivery: OnboardingDeliveryRecord = {
      guildId: GUILD_ID,
      deliveryId,
      memberId: input.memberId,
      joinInstance: input.joinInstance,
      kind: input.kind,
      state: "reserved",
      channelId: null,
      messageId: null,
      attemptCount: 1,
      failureCode: null,
      claimId: input.claimId,
      claimExpiresAt: input.claimExpiresAt,
      deliveredAt: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    this.deliveryKeys.set(key, deliveryId);
    this.deliveries.set(deliveryId, delivery);
    return { status: "reserved", delivery };
  }

  public completeOnboardingDelivery(
    deliveryId: string,
    input: OnboardingDeliveryCompletionInput,
  ): OnboardingDeliveryRecord {
    const current = this.deliveries.get(deliveryId);
    if (!current || current.claimId !== input.claimId) {
      throw new Error("stale delivery claim");
    }
    const completed: OnboardingDeliveryRecord = {
      ...current,
      state: input.state,
      channelId: input.channelId ?? null,
      messageId: input.messageId ?? null,
      failureCode: input.failureCode ?? null,
      claimId: null,
      claimExpiresAt: null,
      deliveredAt: input.state === "delivered" ? NOW.toISOString() : null,
      updatedAt: NOW.toISOString(),
    };
    this.deliveries.set(deliveryId, completed);
    return completed;
  }

  public reserveOnboardingRoleOperation(
    input: OnboardingRoleOperationReservationInput,
  ): OnboardingRoleOperationReservationResult {
    const key = `${input.memberId}:${input.roleId}:${input.kind}:${input.idempotencyKey}`;
    const existingId = this.roleOperationKeys.get(key);
    const existing = existingId
      ? this.roleOperations.get(existingId)
      : undefined;
    if (existing) {
      return {
        status: existing.state === "reserved" ? "pending" : "completed",
        operation: existing,
      };
    }
    const operationId = `roleop_${String(this.nextRoleOperation++).padStart(8, "0")}`;
    const operation: OnboardingRoleOperation = {
      guildId: GUILD_ID,
      operationId,
      memberId: input.memberId,
      roleId: input.roleId,
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
      state: "reserved",
      failureCode: null,
      attemptCount: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      completedAt: null,
      resolvedAt: null,
      resolvedByOperationId: null,
    };
    this.roleOperationKeys.set(key, operationId);
    this.roleOperations.set(operationId, operation);
    return { status: "reserved", operation };
  }

  public completeOnboardingRoleOperation(
    operationId: string,
    input: OnboardingRoleOperationCompletionInput,
  ): OnboardingRoleOperation {
    this.roleCompletionStates.push(input.state);
    if (this.roleCompletionFailuresRemaining > 0) {
      this.roleCompletionFailuresRemaining -= 1;
      throw new Error("role checkpoint persistence failed");
    }
    const current = this.roleOperations.get(operationId);
    if (!current) throw new Error("missing role operation");
    const completed: OnboardingRoleOperation = {
      ...current,
      state: input.state,
      failureCode: input.failureCode ?? null,
      updatedAt: NOW.toISOString(),
      completedAt: NOW.toISOString(),
    };
    this.roleOperations.set(operationId, completed);
    return completed;
  }

  public appendOnboardingAudit(
    input: OnboardingAuditEventInput,
  ): OnboardingAuditEvent {
    const event: OnboardingAuditEvent = {
      guildId: GUILD_ID,
      eventId: `audit_${String(this.audits.length + 1).padStart(8, "0")}`,
      eventNumber: this.audits.length + 1,
      eventType: input.eventType,
      memberId: input.memberId ?? null,
      actorId: input.actorId ?? null,
      rulesVersion: input.rulesVersion ?? null,
      outcome: input.outcome,
      details: input.details ?? {},
      createdAt: NOW.toISOString(),
    };
    this.audits.push(event);
    return event;
  }
}

class FakeEffects implements MemberLifecycleEffects {
  public readonly deliveryRequests: MemberLifecycleDeliveryRequest[] = [];
  public readonly roleRequests: MemberLifecycleRoleRequest[] = [];
  public readonly failedDeliveryKinds = new Set<string>();
  public readonly failedRoleIds = new Set<string>();
  public maximumConcurrentRoleAdds = 0;
  public afterDelivery: (() => void) | null = null;
  public afterRole: (() => void) | null = null;
  private concurrentRoleAdds = 0;
  private nextMessage = 0;

  public async deliver(
    request: MemberLifecycleDeliveryRequest,
  ): Promise<{ channelId: string; messageId: string }> {
    this.deliveryRequests.push(request);
    if (this.failedDeliveryKinds.has(request.kind)) {
      throw new Error(`private ${request.kind} failure text`);
    }
    this.nextMessage += 1;
    this.afterDelivery?.();
    return {
      channelId:
        request.channelId ??
        String(87_345_678_901_234_566n + BigInt(this.nextMessage)),
      messageId: String(88_345_678_901_234_566n + BigInt(this.nextMessage)),
    };
  }

  public async validateAndAssignRole(
    request: MemberLifecycleRoleRequest,
  ): Promise<"added" | "already-held"> {
    this.roleRequests.push(request);
    this.concurrentRoleAdds += 1;
    this.maximumConcurrentRoleAdds = Math.max(
      this.maximumConcurrentRoleAdds,
      this.concurrentRoleAdds,
    );
    await Promise.resolve();
    this.concurrentRoleAdds -= 1;
    if (this.failedRoleIds.has(request.roleId)) {
      throw new Error("private role failure text");
    }
    this.afterRole?.();
    return "added";
  }
}

function lifecycleService(
  repository: FakeLifecycleRepository,
  effects: FakeEffects,
  isCurrent: () => boolean = () => true,
  isAcceptingWork: () => boolean = () => true,
  isEffectCurrent: () => boolean = () => true,
) {
  let claim = 0;
  return createMemberLifecycleService({
    guildId: GUILD_ID,
    repository,
    effects,
    isCurrent,
    isEffectCurrent,
    isAcceptingWork,
    now: () => new Date(NOW),
    createClaimId: () => `claim_${String(++claim).padStart(8, "0")}`,
    classifyFailure: (_error, operation) => `safe-${operation}-failure`,
  });
}

function humanSnapshot(
  overrides: Partial<MemberLifecycleSnapshot> = {},
): MemberLifecycleSnapshot {
  return {
    guildId: GUILD_ID,
    memberId: MEMBER_ID,
    isBot: false,
    pending: false,
    displayName: "Visitor",
    guildName: "Superior Test Guild",
    approximateMemberCount: 42,
    accountCreatedAt: new Date(CREATED_AT),
    joinedAt: new Date(JOINED_AT),
    ...overrides,
  };
}

function botSnapshot(): MemberLifecycleSnapshot {
  return {
    ...humanSnapshot(),
    memberId: BOT_ID,
    isBot: true,
    displayName: "Helper Bot",
  };
}

function baseConfiguration(
  overrides: Partial<OnboardingConfiguration> = {},
): OnboardingConfiguration {
  return {
    guildId: GUILD_ID,
    enabled: true,
    welcomeChannelId: WELCOME_CHANNEL_ID,
    welcomePublicEnabled: true,
    welcomeDmEnabled: true,
    farewellChannelId: FAREWELL_CHANNEL_ID,
    farewellPublicEnabled: true,
    lifecycleLogChannelId: LOG_CHANNEL_ID,
    rulesChannelId: RULES_CHANNEL_ID,
    verificationEnabled: false,
    currentRulesVersion: null,
    verifiedRoleId: null,
    unverifiedRoleId: null,
    humanAutorolesEnabled: true,
    botAutorolesEnabled: true,
    accountAgeAlertHours: 24,
    welcomeTitle: "Welcome to {server}",
    welcomeBody: "{user} joined at {joined_at}. Read {rules}.",
    farewellTitle: "Member left {server}",
    farewellBody: "{user} has left the server.",
    welcomeChannelVerifiedAt: NOW.toISOString(),
    farewellChannelVerifiedAt: NOW.toISOString(),
    lifecycleLogChannelVerifiedAt: NOW.toISOString(),
    rulesChannelVerifiedAt: NOW.toISOString(),
    verificationRolesVerifiedAt: null,
    createdBy: GUILD_ID,
    updatedBy: GUILD_ID,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function autorole(
  roleId: string,
  audience: "human" | "bot",
  sortOrder: number,
): OnboardingAutorole {
  return {
    guildId: GUILD_ID,
    audience,
    roleId,
    sortOrder,
    enabled: true,
    bindingsVerifiedAt: NOW.toISOString(),
    createdBy: GUILD_ID,
    updatedBy: GUILD_ID,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}
