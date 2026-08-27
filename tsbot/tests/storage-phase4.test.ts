import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { BotStorage, type GuildStorage } from "../src/storage/db.js";
import { parseGuildDataExport } from "../src/storage/guild-data.js";
import { validateDatabaseFile } from "../src/storage/migration.js";
import {
  ONBOARDING_RULES_BODY_MAXIMUM,
  type OnboardingConfigurationInput,
} from "../src/types.js";

const GUILD_A = "111111111111111111";
const GUILD_B = "222222222222222222";
const ACTOR_ID = "333333333333333333";
const MEMBER_ID = "444444444444444444";
const ROLE_A = "555555555555555555";
const ROLE_B = "666666666666666666";
const ROLE_C = "777777777777777777";
const CHANNEL_ID = "888888888888888888";
const MESSAGE_ID = "999999999999999999";
const SECOND_MESSAGE_ID = "900000000000000001";
const INTERACTION_ID = "900000000000000002";
const SECOND_INTERACTION_ID = "900000000000000003";
const VERIFIED_AT = "2026-08-23T00:00:00.000Z";
const ACCOUNT_CREATED_AT = "2025-08-23T00:00:00.000Z";
const CLAIM_EXPIRES_AT = "2999-08-23T00:05:00.000Z";

const openStorages: BotStorage[] = [];
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const storage of openStorages.splice(0)) storage.close();
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createStorage(fileBacked = false): {
  storage: BotStorage;
  dbFile: string | null;
} {
  let dbFile = ":memory:";
  if (fileBacked) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "superior-phase4-"));
    temporaryRoots.push(root);
    dbFile = path.join(root, "phase4.db");
  }
  const storage = new BotStorage({ dbFile });
  storage.initStorage();
  storage.ensureGuild(GUILD_A);
  storage.ensureGuild(GUILD_B);
  openStorages.push(storage);
  return { storage, dbFile: fileBacked ? dbFile : null };
}

function activeOnboardingConfiguration(
  rulesVersion: number,
): OnboardingConfigurationInput {
  return {
    enabled: true,
    welcomeChannelId: CHANNEL_ID,
    welcomePublicEnabled: true,
    welcomeDmEnabled: true,
    farewellChannelId: CHANNEL_ID,
    farewellPublicEnabled: true,
    lifecycleLogChannelId: CHANNEL_ID,
    rulesChannelId: CHANNEL_ID,
    verificationEnabled: true,
    currentRulesVersion: rulesVersion,
    verifiedRoleId: ROLE_A,
    unverifiedRoleId: ROLE_B,
    humanAutorolesEnabled: true,
    botAutorolesEnabled: false,
    accountAgeAlertHours: 24,
    welcomeTitle: "Welcome to {server}",
    welcomeBody: "Hello {user}. Read {rules}.",
    farewellTitle: "Member left",
    farewellBody: "{user} left {server}.",
    welcomeChannelVerifiedAt: VERIFIED_AT,
    farewellChannelVerifiedAt: VERIFIED_AT,
    lifecycleLogChannelVerifiedAt: VERIFIED_AT,
    rulesChannelVerifiedAt: VERIFIED_AT,
    verificationRolesVerifiedAt: VERIFIED_AT,
    actorId: ACTOR_ID,
  };
}

function createEnabledMenu(
  guild: GuildStorage,
  input: {
    menuId?: string;
    slug?: string;
    roleId?: string;
    requiredRoleId?: string | null;
  } = {},
) {
  const menu = guild.createRoleMenu({
    menuId: input.menuId ?? "menuAlpha001",
    slug: input.slug ?? "member-colors",
    title: "Member colors",
    description: "Choose the color role you want to keep.",
    mode: "toggle",
    minSelections: 0,
    maxSelections: 1,
    requiredRoleId: input.requiredRoleId ?? null,
    actorId: ACTOR_ID,
  });
  const option = guild.createRoleMenuOption(menu.menuId, {
    optionId: "optionAlpha01",
    roleId: input.roleId ?? ROLE_A,
    label: "Gold",
    description: "Use the Superior gold color.",
    emoji: "🟡",
    actorId: ACTOR_ID,
  });
  const enabled = guild.setRoleMenuState(
    menu.menuId,
    "enabled",
    ACTOR_ID,
    VERIFIED_AT,
  );
  if (!enabled) throw new Error("Role-menu test fixture was not enabled");
  return { menu: enabled, option };
}

describe("Phase 4 storage repositories", () => {
  it("creates a valid schema v11 and persists the Phase 4 aggregate", () => {
    const { storage, dbFile } = createStorage(true);
    expect(validateDatabaseFile(dbFile!, { expect: 11 })).toEqual({
      schema: "current-v11",
      schemaVersion: 11,
      integrity: "ok",
      foreignKeyViolations: 0,
    });
    const guild = storage.forGuild(GUILD_A);
    expect(guild.getOnboardingConfiguration()).toBeNull();
    expect(guild.listRoleMenus()).toEqual([]);

    const rules = guild.createOnboardingRulesVersion({
      title: "Server rules",
      body: "Be kind and keep member information private.",
      reacceptanceRequested: false,
      actorId: ACTOR_ID,
    });
    const configuration = guild.upsertOnboardingConfiguration(
      activeOnboardingConfiguration(rules.rulesVersion),
    );
    const autoroles = guild.replaceOnboardingAutoroles(
      "human",
      [{ roleId: ROLE_C, enabled: true, bindingsVerifiedAt: VERIFIED_AT }],
      ACTOR_ID,
    );
    const memberState = guild.upsertMemberOnboardingState({
      memberId: MEMBER_ID,
      memberKind: "human",
      screeningState: "complete",
      lifecycleState: "active",
      joinedAt: VERIFIED_AT,
      accountCreatedAt: ACCOUNT_CREATED_AT,
      screeningCompletedAt: VERIFIED_AT,
      departedAt: null,
      lastProcessedAt: VERIFIED_AT,
    });
    const acceptance = guild.recordMemberRuleAcceptance({
      memberId: MEMBER_ID,
      rulesVersion: rules.rulesVersion,
      acceptedAt: VERIFIED_AT,
    });
    const audit = guild.appendOnboardingAudit({
      eventType: "verification-accepted",
      memberId: MEMBER_ID,
      rulesVersion: rules.rulesVersion,
      outcome: "recorded",
      details: { verifiedRoleAdded: true },
    });
    const { menu, option } = createEnabledMenu(guild);
    const post = guild.createRoleMenuPost({
      postId: "postAlpha001",
      menuId: menu.menuId,
      channelId: CHANNEL_ID,
      messageId: MESSAGE_ID,
      definitionVersion: menu.definitionVersion,
      bindingsVerifiedAt: VERIFIED_AT,
      state: "active",
    });

    expect(configuration).toMatchObject({
      guildId: GUILD_A,
      enabled: true,
      currentRulesVersion: 1,
      verificationEnabled: true,
    });
    expect(guild.getCurrentOnboardingRulesVersion()).toEqual(rules);
    expect(autoroles).toMatchObject([
      { guildId: GUILD_A, roleId: ROLE_C, sortOrder: 0, enabled: true },
    ]);
    expect(guild.getMemberOnboardingState(MEMBER_ID)).toEqual(memberState);
    expect(acceptance).toMatchObject({
      status: "recorded",
      acceptance: { guildId: GUILD_A, memberId: MEMBER_ID, rulesVersion: 1 },
    });
    expect(guild.listOnboardingAuditEvents({ memberId: MEMBER_ID })).toEqual([
      audit,
    ]);
    expect(guild.getRoleMenuBySlug("member-colors")).toEqual(menu);
    expect(guild.listRoleMenuOptions(menu.menuId)).toEqual([option]);
    expect(guild.findRoleMenuPostByMessage(CHANNEL_ID, MESSAGE_ID)).toEqual(
      post,
    );

    const exported = storage.exportGuildData(GUILD_A);
    expect(exported).toMatchObject({
      formatVersion: 8,
      guildId: GUILD_A,
      onboardingConfiguration: { enabled: true },
      onboardingRulesVersions: [{ rulesVersion: 1 }],
      memberRuleAcceptances: [{ memberId: MEMBER_ID, rulesVersion: 1 }],
      roleMenus: [{ menuId: menu.menuId, state: "enabled" }],
      roleMenuOptions: [{ optionId: option.optionId, roleId: ROLE_A }],
      roleMenuPosts: [{ postId: post.postId, state: "active" }],
    });
    expect(() => parseGuildDataExport(exported, GUILD_A)).not.toThrow();
  });

  it("keeps autorole verification bindings self-export compatible", () => {
    const { storage } = createStorage();
    const guild = storage.forGuild(GUILD_A);

    expect(() =>
      guild.replaceOnboardingAutoroles(
        "human",
        [{ roleId: ROLE_C, enabled: false, bindingsVerifiedAt: VERIFIED_AT }],
        ACTOR_ID,
      ),
    ).toThrow(/verification time exactly when enabled/u);

    guild.replaceOnboardingAutoroles(
      "human",
      [{ roleId: ROLE_C, enabled: false, bindingsVerifiedAt: null }],
      ACTOR_ID,
    );
    const exported = storage.exportGuildData(GUILD_A);
    expect(() => parseGuildDataExport(exported, GUILD_A)).not.toThrow();
  });

  it("keeps verification and automatic role semantics disjoint", () => {
    const { storage } = createStorage();
    const guild = storage.forGuild(GUILD_A);
    const rules = guild.createOnboardingRulesVersion({
      title: "Role safety rules",
      body: "Verification and automatic roles must remain distinct.",
      actorId: ACTOR_ID,
    });
    guild.upsertOnboardingConfiguration(
      activeOnboardingConfiguration(rules.rulesVersion),
    );

    expect(() =>
      guild.replaceOnboardingAutoroles(
        "human",
        [{ roleId: ROLE_A, enabled: false, bindingsVerifiedAt: null }],
        ACTOR_ID,
      ),
    ).toThrow(/configured for verification/u);

    guild.replaceOnboardingAutoroles(
      "human",
      [{ roleId: ROLE_C, enabled: false, bindingsVerifiedAt: null }],
      ACTOR_ID,
    );
    expect(() =>
      guild.upsertOnboardingConfiguration({
        ...activeOnboardingConfiguration(rules.rulesVersion),
        verifiedRoleId: ROLE_C,
      }),
    ).toThrow(/configured as an automatic role/u);
  });

  it("atomically creates and activates rules without orphaning or consuming a version on failure", () => {
    const { storage } = createStorage();
    const guild = storage.forGuild(GUILD_A);
    const { currentRulesVersion: _currentRulesVersion, ...configuration } =
      activeOnboardingConfiguration(1);
    const rules = {
      title: "Current rules",
      body: "Acknowledge this immutable rules version.",
      reacceptanceRequested: true,
      actorId: ACTOR_ID,
    };

    expect(() =>
      guild.createAndActivateOnboardingRulesVersion({
        rules,
        configuration: {
          ...configuration,
          welcomeChannelId: "not-a-snowflake",
        },
      }),
    ).toThrow(/welcome channel ID/i);
    expect(guild.countOnboardingRulesVersions()).toBe(0);
    expect(guild.getOnboardingConfiguration()).toBeNull();

    const activated = guild.createAndActivateOnboardingRulesVersion({
      rules,
      configuration,
    });
    expect(activated.rules.rulesVersion).toBe(1);
    expect(activated.configuration.currentRulesVersion).toBe(1);
    expect(guild.countOnboardingRulesVersions()).toBe(1);
    expect(guild.getCurrentOnboardingRulesVersion()).toEqual(activated.rules);
  });

  it("caps retained rules versions without evicting accepted history", () => {
    const { storage, dbFile } = createStorage(true);
    const guild = storage.forGuild(GUILD_A);
    const versions = Array.from({ length: 25 }, (_, index) =>
      guild.createOnboardingRulesVersion({
        title: `Server rules ${index + 1}`,
        body: `Immutable server rules version ${index + 1}.`,
        actorId: ACTOR_ID,
      }),
    );
    const oldest = versions[0]!;
    const acceptance = guild.recordMemberRuleAcceptance({
      memberId: MEMBER_ID,
      rulesVersion: oldest.rulesVersion,
      acceptedAt: VERIFIED_AT,
    });

    expect(guild.countOnboardingRulesVersions()).toBe(25);
    expect(
      guild
        .listOnboardingRulesVersions(25)
        .map(({ rulesVersion }) => rulesVersion),
    ).toEqual(Array.from({ length: 25 }, (_, index) => 25 - index));
    expect(() =>
      guild.createOnboardingRulesVersion({
        title: "Server rules 26",
        body: "This version exceeds the bounded retention capacity.",
        actorId: ACTOR_ID,
      }),
    ).toThrow(/at most 25 rules versions/u);
    expect(guild.countOnboardingRulesVersions()).toBe(25);
    expect(guild.getOnboardingRulesVersion(oldest.rulesVersion)).toEqual(
      oldest,
    );
    expect(
      guild.getMemberRuleAcceptance(MEMBER_ID, oldest.rulesVersion),
    ).toEqual(acceptance.acceptance);

    const raw = new Database(dbFile!);
    try {
      raw.pragma("foreign_keys = ON");
      expect(() =>
        raw
          .prepare(
            `DELETE FROM onboarding_rules_versions
             WHERE guild_id = ? AND rules_version = ?`,
          )
          .run(GUILD_A, oldest.rulesVersion),
      ).toThrow(/FOREIGN KEY constraint failed/u);
    } finally {
      raw.close();
    }
    expect(guild.getOnboardingRulesVersion(oldest.rulesVersion)).toEqual(
      oldest,
    );
  });

  it("enforces shared rules and lifecycle-template invariants on direct writes", () => {
    const { storage } = createStorage();
    const guild = storage.forGuild(GUILD_A);

    expect(() =>
      guild.createOnboardingRulesVersion({
        title: "Unsafe rules",
        body: "Notify @everyone",
        actorId: ACTOR_ID,
      }),
    ).toThrow(/Discord mentions/i);
    expect(() =>
      guild.createOnboardingRulesVersion({
        title: "Oversized rules",
        body: "a".repeat(ONBOARDING_RULES_BODY_MAXIMUM + 1),
        actorId: ACTOR_ID,
      }),
    ).toThrow(new RegExp(String(ONBOARDING_RULES_BODY_MAXIMUM)));
    expect(guild.countOnboardingRulesVersions()).toBe(0);

    const rules = guild.createOnboardingRulesVersion({
      title: "Safe rules",
      body: "Be respectful.",
      actorId: ACTOR_ID,
    });
    expect(() =>
      guild.upsertOnboardingConfiguration({
        ...activeOnboardingConfiguration(rules.rulesVersion),
        welcomeBody: "Hello {unknown_placeholder}.",
      }),
    ).toThrow(/Unknown onboarding placeholder/i);
    expect(() =>
      guild.upsertOnboardingConfiguration({
        ...activeOnboardingConfiguration(rules.rulesVersion),
        farewellBody: "Notify <@123456789012345678>.",
      }),
    ).toThrow(/Discord mentions/i);
    expect(() =>
      guild.upsertOnboardingConfiguration({
        ...activeOnboardingConfiguration(rules.rulesVersion),
        enabled: false,
        verificationEnabled: false,
        currentRulesVersion: null,
        verifiedRoleId: null,
        unverifiedRoleId: null,
        verificationRolesVerifiedAt: VERIFIED_AT,
      }),
    ).toThrow(/requires a verified role/u);
    expect(guild.getOnboardingConfiguration()).toBeNull();
  });

  it("makes imported Discord bindings dormant while preserving bounded history", () => {
    const { storage } = createStorage();
    const guild = storage.forGuild(GUILD_A);
    const rules = guild.createOnboardingRulesVersion({
      title: "Imported rules",
      body: "This immutable history remains readable after import.",
      actorId: ACTOR_ID,
    });
    guild.upsertOnboardingConfiguration(
      activeOnboardingConfiguration(rules.rulesVersion),
    );
    guild.replaceOnboardingAutoroles(
      "human",
      [{ roleId: ROLE_C, enabled: true, bindingsVerifiedAt: VERIFIED_AT }],
      ACTOR_ID,
    );
    guild.recordMemberRuleAcceptance({
      memberId: MEMBER_ID,
      rulesVersion: rules.rulesVersion,
      acceptedAt: VERIFIED_AT,
    });
    const delivery = guild.reserveOnboardingDelivery({
      deliveryId: "deliveryA001",
      memberId: MEMBER_ID,
      joinInstance: "join-1",
      kind: "welcome-public",
      claimId: "claimAlpha01",
      claimExpiresAt: CLAIM_EXPIRES_AT,
    }).delivery;
    const onboardingOperation = guild.reserveOnboardingRoleOperation({
      operationId: "onboardOp001",
      memberId: MEMBER_ID,
      roleId: ROLE_A,
      kind: "verified-add",
      idempotencyKey: "rules:1:verified",
    }).operation;
    const resolvedOriginal = guild.reserveOnboardingRoleOperation({
      operationId: "onboardOld001",
      memberId: MEMBER_ID,
      roleId: ROLE_C,
      kind: "human-autorole-add",
      idempotencyKey: "rules:1:old-pending",
    }).operation;
    const recoveryReservation = guild.reserveOnboardingRoleOperation({
      operationId: "onboardFix001",
      memberId: MEMBER_ID,
      roleId: ROLE_C,
      kind: "human-autorole-add",
      idempotencyKey: `recover:${INTERACTION_ID}:human-autorole-add:${ROLE_C}`,
    });
    const recoveryOperation = guild.completeOnboardingRoleOperation(
      recoveryReservation.operation.operationId,
      { state: "no-change" },
    );
    guild.resolveOnboardingRoleOperations(recoveryOperation.operationId);
    const { menu } = createEnabledMenu(guild);
    const post = guild.createRoleMenuPost({
      postId: "postAlpha001",
      menuId: menu.menuId,
      channelId: CHANNEL_ID,
      messageId: MESSAGE_ID,
      definitionVersion: menu.definitionVersion,
      bindingsVerifiedAt: VERIFIED_AT,
      state: "active",
    });
    const menuOperation = guild.reserveRoleMenuOperation({
      operationId: "roleMenuOp01",
      interactionId: INTERACTION_ID,
      menuId: menu.menuId,
      memberId: MEMBER_ID,
      definitionVersion: menu.definitionVersion,
      selectionKey: "optionAlpha01",
      plannedAdds: [ROLE_A],
    }).operation;
    const exported = storage.exportGuildData(GUILD_A);
    const expectedSettings = storage.getGuildSettings(GUILD_A)!;

    storage.importGuildData(GUILD_A, exported, expectedSettings);

    expect(guild.getOnboardingConfiguration()).toMatchObject({
      enabled: false,
      welcomePublicEnabled: false,
      welcomeDmEnabled: false,
      farewellPublicEnabled: false,
      verificationEnabled: false,
      currentRulesVersion: rules.rulesVersion,
      verifiedRoleId: ROLE_A,
      verificationRolesVerifiedAt: null,
      humanAutorolesEnabled: false,
      botAutorolesEnabled: false,
    });
    expect(guild.listOnboardingAutoroles("human")).toMatchObject([
      { roleId: ROLE_C, enabled: false, bindingsVerifiedAt: null },
    ]);
    expect(
      guild.getMemberRuleAcceptance(MEMBER_ID, rules.rulesVersion),
    ).not.toBeNull();
    expect(guild.getOnboardingDelivery(delivery.deliveryId)).toMatchObject({
      state: "skipped",
      failureCode: "import-interrupted",
      claimId: null,
      claimExpiresAt: null,
    });
    expect(
      guild.getOnboardingRoleOperation(onboardingOperation.operationId),
    ).toMatchObject({
      state: "failed",
      failureCode: "import-interrupted",
    });
    expect(
      guild.getOnboardingRoleOperation(resolvedOriginal.operationId),
    ).toMatchObject({
      state: "reserved",
      completedAt: null,
      failureCode: null,
      resolvedAt: expect.any(String),
      resolvedByOperationId: recoveryOperation.operationId,
    });
    expect(
      guild.getOnboardingRoleOperation(recoveryOperation.operationId),
    ).toMatchObject({ state: "no-change", resolvedAt: null });
    expect(guild.getRoleMenuById(menu.menuId)).toMatchObject({
      state: "disabled",
      bindingsVerifiedAt: null,
    });
    expect(guild.getRoleMenuPostById(post.postId)).toMatchObject({
      state: "stale",
      bindingsVerifiedAt: null,
    });
    expect(
      guild.getRoleMenuOperationById(menuOperation.operationId),
    ).toMatchObject({
      state: "failed",
      failureCode: "import-interrupted",
      items: [{ roleId: ROLE_A, state: "skipped" }],
    });
  });

  it("records onboarding work idempotently and rejects stale completion claims", () => {
    const { storage } = createStorage();
    const guild = storage.forGuild(GUILD_A);
    const rules = guild.createOnboardingRulesVersion({
      title: "Current rules",
      body: "Acknowledge this immutable version once.",
      actorId: ACTOR_ID,
    });
    const firstAcceptance = guild.recordMemberRuleAcceptance({
      memberId: MEMBER_ID,
      rulesVersion: rules.rulesVersion,
      acceptedAt: VERIFIED_AT,
    });
    const duplicateAcceptance = guild.recordMemberRuleAcceptance({
      memberId: MEMBER_ID,
      rulesVersion: rules.rulesVersion,
      acceptedAt: "2026-08-23T01:00:00.000Z",
    });
    expect(firstAcceptance.status).toBe("recorded");
    expect(duplicateAcceptance).toEqual({
      status: "duplicate",
      acceptance: firstAcceptance.acceptance,
    });

    const reservationInput = {
      deliveryId: "deliveryA001",
      memberId: MEMBER_ID,
      joinInstance: "join-1",
      kind: "welcome-public" as const,
      claimId: "claimAlpha01",
      claimExpiresAt: CLAIM_EXPIRES_AT,
    };
    const reserved = guild.reserveOnboardingDelivery(reservationInput);
    expect(guild.reserveOnboardingDelivery(reservationInput)).toEqual(reserved);
    expect(() =>
      guild.completeOnboardingDelivery(reserved.delivery.deliveryId, {
        claimId: "wrongClaim01",
        state: "delivered",
        channelId: CHANNEL_ID,
        messageId: MESSAGE_ID,
      }),
    ).toThrow(/claim is stale/);
    expect(
      guild.getOnboardingDelivery(reserved.delivery.deliveryId),
    ).toMatchObject({ state: "reserved", claimId: "claimAlpha01" });
    expect(() =>
      guild.completeOnboardingDelivery(reserved.delivery.deliveryId, {
        claimId: "claimAlpha01",
        state: "delivered",
        channelId: CHANNEL_ID,
        messageId: MESSAGE_ID,
        failureCode: "unexpected-failure",
      }),
    ).toThrow(/cannot retain a failure code/u);
    expect(
      guild.getOnboardingDelivery(reserved.delivery.deliveryId),
    ).toMatchObject({ state: "reserved", claimId: "claimAlpha01" });
    const completion = {
      claimId: "claimAlpha01",
      state: "delivered" as const,
      channelId: CHANNEL_ID,
      messageId: MESSAGE_ID,
    };
    const delivered = guild.completeOnboardingDelivery(
      reserved.delivery.deliveryId,
      completion,
    );
    expect(
      guild.completeOnboardingDelivery(
        reserved.delivery.deliveryId,
        completion,
      ),
    ).toEqual(delivered);
    expect(guild.reserveOnboardingDelivery(reservationInput)).toMatchObject({
      status: "duplicate",
      delivery: delivered,
    });

    const skippedReservation = guild.reserveOnboardingDelivery({
      ...reservationInput,
      deliveryId: "deliverySkip01",
      joinInstance: "join-skipped",
      claimId: "claimSkip001",
    });
    expect(
      guild.completeOnboardingDelivery(skippedReservation.delivery.deliveryId, {
        claimId: "claimSkip001",
        state: "skipped",
        failureCode: "import-interrupted",
      }),
    ).toMatchObject({
      state: "skipped",
      failureCode: "import-interrupted",
      messageId: null,
    });

    const operationInput = {
      operationId: "onboardOp001",
      memberId: MEMBER_ID,
      roleId: ROLE_A,
      kind: "verified-add" as const,
      idempotencyKey: "rules:1:verified",
    };
    const roleReservation =
      guild.reserveOnboardingRoleOperation(operationInput);
    expect(guild.reserveOnboardingRoleOperation(operationInput)).toMatchObject({
      status: "pending",
      operation: roleReservation.operation,
    });
    expect(() =>
      guild.completeOnboardingRoleOperation(
        roleReservation.operation.operationId,
        { state: "completed", failureCode: "unexpected-failure" },
      ),
    ).toThrow(/cannot retain a failure code/u);
    const completed = guild.completeOnboardingRoleOperation(
      roleReservation.operation.operationId,
      { state: "completed" },
    );
    expect(
      guild.completeOnboardingRoleOperation(
        roleReservation.operation.operationId,
        { state: "completed" },
      ),
    ).toEqual(completed);
    expect(guild.reserveOnboardingRoleOperation(operationInput)).toMatchObject({
      status: "completed",
      operation: completed,
    });
  });

  it("reconciles incomplete role work without rewriting its original history", () => {
    const { storage } = createStorage();
    const guild = storage.forGuild(GUILD_A);
    const reserveOriginal = (operationId: string, idempotencyKey: string) =>
      guild.reserveOnboardingRoleOperation({
        operationId,
        memberId: MEMBER_ID,
        roleId: ROLE_A,
        kind: "verified-add",
        idempotencyKey,
      }).operation;

    const reserved = reserveOriginal("rolePending001", "rules:1:pending");
    const partialReservation = reserveOriginal(
      "rolePartial001",
      "rules:1:partial",
    );
    const partial = guild.completeOnboardingRoleOperation(
      partialReservation.operationId,
      { state: "partial", failureCode: "discord-timeout" },
    );
    const failedReservation = reserveOriginal(
      "roleFailed0001",
      "rules:1:failed",
    );
    const failed = guild.completeOnboardingRoleOperation(
      failedReservation.operationId,
      { state: "failed", failureCode: "missing-permission" },
    );
    const resolverReservation = guild.reserveOnboardingRoleOperation({
      operationId: "roleRecover001",
      memberId: MEMBER_ID,
      roleId: ROLE_A,
      kind: "verified-add",
      idempotencyKey: `recover:${INTERACTION_ID}:verified-add:${ROLE_A}`,
    });
    const resolver = guild.completeOnboardingRoleOperation(
      resolverReservation.operation.operationId,
      { state: "no-change" },
    );

    const reconciled = guild.resolveOnboardingRoleOperations(
      resolver.operationId,
    );

    expect(reconciled.map(({ operationId }) => operationId).sort()).toEqual(
      [reserved.operationId, partial.operationId, failed.operationId].sort(),
    );
    for (const original of [reserved, partial, failed]) {
      expect(guild.getOnboardingRoleOperation(original.operationId)).toEqual({
        ...original,
        updatedAt: expect.any(String),
        resolvedAt: expect.any(String),
        resolvedByOperationId: resolver.operationId,
      });
    }
    expect(
      guild.getOnboardingRoleOperation(reserved.operationId),
    ).toMatchObject({
      state: "reserved",
      completedAt: null,
      failureCode: null,
    });
    expect(guild.getOnboardingRoleOperation(partial.operationId)).toMatchObject(
      {
        state: "partial",
        completedAt: partial.completedAt,
        failureCode: "discord-timeout",
      },
    );
    expect(guild.getOnboardingRoleOperation(failed.operationId)).toMatchObject({
      state: "failed",
      completedAt: failed.completedAt,
      failureCode: "missing-permission",
    });
    expect(guild.getOnboardingRoleOperation(resolver.operationId)).toEqual(
      resolver,
    );
    expect(
      guild.listOnboardingRoleOperations({
        memberId: MEMBER_ID,
        states: ["reserved", "partial", "failed"],
        unresolvedOnly: true,
        limit: 25,
      }),
    ).toEqual([]);
    expect(guild.resolveOnboardingRoleOperations(resolver.operationId)).toEqual(
      reconciled,
    );

    const nonRecovery = guild.reserveOnboardingRoleOperation({
      operationId: "roleOrdinary01",
      memberId: MEMBER_ID,
      roleId: ROLE_A,
      kind: "verified-add",
      idempotencyKey: "rules:2:verified",
    });
    guild.completeOnboardingRoleOperation(nonRecovery.operation.operationId, {
      state: "completed",
    });
    expect(() =>
      guild.resolveOnboardingRoleOperations(nonRecovery.operation.operationId),
    ).toThrow(/successful recovery operation/u);
    const pendingRecovery = guild.reserveOnboardingRoleOperation({
      operationId: "roleRecover002",
      memberId: MEMBER_ID,
      roleId: ROLE_A,
      kind: "verified-add",
      idempotencyKey: `recover:${SECOND_INTERACTION_ID}:verified-add:${ROLE_A}`,
    });
    expect(() =>
      guild.resolveOnboardingRoleOperations(
        pendingRecovery.operation.operationId,
      ),
    ).toThrow(/successful recovery operation/u);
  });

  it("treats a resolved reserved role record as terminal under capacity pressure", () => {
    const { storage, dbFile } = createStorage(true);
    const guild = storage.forGuild(GUILD_A);
    const original = guild.reserveOnboardingRoleOperation({
      operationId: "capacityOld001",
      memberId: MEMBER_ID,
      roleId: ROLE_A,
      kind: "verified-add",
      idempotencyKey: "rules:1:capacity-old",
    }).operation;
    const recovery = guild.reserveOnboardingRoleOperation({
      operationId: "capacityFix001",
      memberId: MEMBER_ID,
      roleId: ROLE_A,
      kind: "verified-add",
      idempotencyKey: `recover:${INTERACTION_ID}:verified-add:${ROLE_A}`,
    });
    guild.completeOnboardingRoleOperation(recovery.operation.operationId, {
      state: "completed",
    });
    guild.resolveOnboardingRoleOperations(recovery.operation.operationId);

    const db = new Database(dbFile!);
    try {
      db.exec(`WITH digits(value) AS (
          VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)
        ), numbers(value) AS (
          SELECT a.value * 100000 + b.value * 10000 + c.value * 1000 +
                 d.value * 100 + e.value * 10 + f.value
          FROM digits AS a CROSS JOIN digits AS b CROSS JOIN digits AS c
          CROSS JOIN digits AS d CROSS JOIN digits AS e CROSS JOIN digits AS f
        )
        INSERT INTO onboarding_role_operations (
          guild_id, operation_id, member_id, role_id, operation_kind,
          idempotency_key, operation_state, failure_code, attempt_count,
          created_at, updated_at, completed_at, resolved_at,
          resolved_by_operation_id
        )
        SELECT '${GUILD_A}', printf('bulk%020d', value), '${MEMBER_ID}',
          '${ROLE_B}', 'bot-autorole-add', printf('bulk:%d', value),
          'reserved', NULL, 1, '${VERIFIED_AT}', '${VERIFIED_AT}', NULL,
          NULL, NULL
        FROM numbers WHERE value BETWEEN 1 AND 199998`);
    } finally {
      db.close();
    }

    expect(() =>
      guild.reserveOnboardingRoleOperation({
        operationId: "capacityNew001",
        memberId: MEMBER_ID,
        roleId: ROLE_C,
        kind: "human-autorole-add",
        idempotencyKey: "capacity:new",
      }),
    ).not.toThrow();
    expect(guild.getOnboardingRoleOperation(original.operationId)).toBeNull();
    expect(
      guild.getOnboardingRoleOperation(recovery.operation.operationId),
    ).not.toBeNull();
    expect(guild.getOnboardingRoleOperation("capacityNew001")).toMatchObject({
      state: "reserved",
      resolvedAt: null,
    });
  }, 30_000);

  it("keeps guild-local role menus contiguously ordered across insert and move", () => {
    const { storage } = createStorage();
    const guild = storage.forGuild(GUILD_A);
    const createMenu = (menuId: string, slug: string, sortOrder?: number) =>
      guild.createRoleMenu({
        menuId,
        slug,
        title: `Menu ${slug}`,
        description: `Configuration for ${slug}.`,
        ...(sortOrder === undefined ? {} : { sortOrder }),
        mode: "toggle",
        minSelections: 0,
        maxSelections: 1,
        actorId: ACTOR_ID,
      });

    const first = createMenu("menuFirst001", "first-menu");
    const second = createMenu("menuSecond01", "second-menu");
    const inserted = createMenu("menuMiddle01", "middle-menu", 1);
    expect(
      guild.listRoleMenus().map(({ menuId, sortOrder }) => [menuId, sortOrder]),
    ).toEqual([
      [first.menuId, 0],
      [inserted.menuId, 1],
      [second.menuId, 2],
    ]);

    const moved = guild.updateRoleMenu(first.menuId, {
      sortOrder: 2,
      expectedDefinitionVersion: first.definitionVersion,
      actorId: ACTOR_ID,
    });
    expect(moved).toMatchObject({
      sortOrder: 2,
      state: "disabled",
      definitionVersion: first.definitionVersion,
    });
    expect(
      guild.listRoleMenus().map(({ menuId, sortOrder }) => [menuId, sortOrder]),
    ).toEqual([
      [inserted.menuId, 0],
      [second.menuId, 1],
      [first.menuId, 2],
    ]);
    const exported = storage.exportGuildData(GUILD_A);
    expect(exported.roleMenus.map(({ menuId }) => menuId)).toEqual([
      inserted.menuId,
      second.menuId,
      first.menuId,
    ]);
    storage.importGuildData(
      GUILD_A,
      exported,
      storage.getGuildSettings(GUILD_A)!,
    );
    expect(
      guild.listRoleMenus().map(({ menuId, sortOrder }) => [menuId, sortOrder]),
    ).toEqual([
      [inserted.menuId, 0],
      [second.menuId, 1],
      [first.menuId, 2],
    ]);

    expect(() =>
      guild.updateRoleMenu(first.menuId, {
        sortOrder: 3,
        actorId: ACTOR_ID,
      }),
    ).toThrow(/position must be between 0 and 2/u);
    expect(guild.listRoleMenus().map(({ sortOrder }) => sortOrder)).toEqual([
      0, 1, 2,
    ]);
  });

  it("keeps option mutations contiguous and versions the menu definition", () => {
    const { storage } = createStorage();
    const guild = storage.forGuild(GUILD_A);
    const menu = guild.createRoleMenu({
      menuId: "optionMenu001",
      slug: "option-mutations",
      title: "Option mutations",
      description: "Exercise every supported option-order mutation.",
      mode: "toggle",
      minSelections: 0,
      maxSelections: 3,
      actorId: ACTOR_ID,
    });
    const first = guild.createRoleMenuOption(menu.menuId, {
      optionId: "optionFirst01",
      roleId: ROLE_A,
      label: "First",
      actorId: ACTOR_ID,
    });
    const second = guild.createRoleMenuOption(menu.menuId, {
      optionId: "optionSecond1",
      roleId: ROLE_B,
      label: "Second",
      actorId: ACTOR_ID,
    });
    const third = guild.createRoleMenuOption(menu.menuId, {
      optionId: "optionThird01",
      roleId: ROLE_C,
      label: "Third",
      actorId: ACTOR_ID,
    });
    let definitionVersion = menu.definitionVersion + 3;
    expect(guild.getRoleMenuById(menu.menuId)?.definitionVersion).toBe(
      definitionVersion,
    );
    const enabled = guild.setRoleMenuState(
      menu.menuId,
      "enabled",
      ACTOR_ID,
      VERIFIED_AT,
    )!;
    const post = guild.createRoleMenuPost({
      postId: "optionPost001",
      menuId: menu.menuId,
      channelId: CHANNEL_ID,
      messageId: MESSAGE_ID,
      definitionVersion,
      bindingsVerifiedAt: VERIFIED_AT,
      state: "active",
    });

    const updated = guild.updateRoleMenuOption(menu.menuId, second.optionId, {
      label: "Updated second",
      description: "The option definition changed.",
      actorId: ACTOR_ID,
    });
    definitionVersion += 1;
    expect(updated).toMatchObject({
      optionId: second.optionId,
      label: "Updated second",
      sortOrder: 1,
    });
    expect(guild.getRoleMenuById(menu.menuId)).toMatchObject({
      state: "disabled",
      bindingsVerifiedAt: null,
      definitionVersion,
    });
    expect(guild.getRoleMenuPostById(post.postId)).toMatchObject({
      state: "stale",
      bindingsVerifiedAt: null,
    });

    expect(
      guild.moveRoleMenuOption(menu.menuId, third.optionId, 0, ACTOR_ID),
    ).toMatchObject({ optionId: third.optionId, sortOrder: 0 });
    definitionVersion += 1;
    expect(
      guild
        .listRoleMenuOptions(menu.menuId)
        .map(({ optionId, sortOrder }) => [optionId, sortOrder]),
    ).toEqual([
      [third.optionId, 0],
      [first.optionId, 1],
      [second.optionId, 2],
    ]);
    expect(guild.getRoleMenuById(menu.menuId)?.definitionVersion).toBe(
      definitionVersion,
    );

    expect(
      guild
        .reorderRoleMenuOptions(
          menu.menuId,
          [second.optionId, third.optionId, first.optionId],
          ACTOR_ID,
        )
        .map(({ optionId, sortOrder }) => [optionId, sortOrder]),
    ).toEqual([
      [second.optionId, 0],
      [third.optionId, 1],
      [first.optionId, 2],
    ]);
    definitionVersion += 1;
    expect(guild.getRoleMenuById(menu.menuId)?.definitionVersion).toBe(
      definitionVersion,
    );

    expect(
      guild.removeRoleMenuOption(menu.menuId, third.optionId, ACTOR_ID),
    ).toBe(true);
    definitionVersion += 1;
    const remaining = guild.listRoleMenuOptions(menu.menuId);
    expect(
      remaining.map(({ optionId, sortOrder }) => [optionId, sortOrder]),
    ).toEqual([
      [second.optionId, 0],
      [first.optionId, 1],
    ]);
    expect(guild.getRoleMenuOption(menu.menuId, third.optionId)).toBeNull();
    expect(guild.getRoleMenuById(menu.menuId)?.definitionVersion).toBe(
      definitionVersion,
    );

    expect(
      guild.reorderRoleMenuOptions(
        menu.menuId,
        remaining.map(({ optionId }) => optionId),
        ACTOR_ID,
      ),
    ).toEqual(remaining);
    expect(
      guild.removeRoleMenuOption(menu.menuId, "missingOpt01", ACTOR_ID),
    ).toBe(false);
    expect(guild.getRoleMenuById(menu.menuId)?.definitionVersion).toBe(
      definitionVersion,
    );
    expect(enabled.definitionVersion).toBe(menu.definitionVersion + 3);
  });

  it("invalidates changed role-menu definitions and every active post", () => {
    const { storage } = createStorage();
    const guild = storage.forGuild(GUILD_A);
    const { menu } = createEnabledMenu(guild, { requiredRoleId: ROLE_B });
    const firstPost = guild.createRoleMenuPost({
      postId: "postAlpha001",
      menuId: menu.menuId,
      channelId: CHANNEL_ID,
      messageId: MESSAGE_ID,
      definitionVersion: menu.definitionVersion,
      bindingsVerifiedAt: VERIFIED_AT,
      state: "active",
    });

    const changed = guild.updateRoleMenu(menu.menuId, {
      title: "Updated member colors",
      expectedDefinitionVersion: menu.definitionVersion,
      actorId: ACTOR_ID,
    })!;
    expect(changed).toMatchObject({
      state: "disabled",
      definitionVersion: menu.definitionVersion + 1,
      bindingsVerifiedAt: null,
    });
    expect(guild.getRoleMenuPostById(firstPost.postId)).toMatchObject({
      state: "stale",
      bindingsVerifiedAt: null,
    });
    expect(() =>
      guild.updateRoleMenu(menu.menuId, {
        description: "A stale writer must not overwrite the current menu.",
        expectedDefinitionVersion: menu.definitionVersion,
        actorId: ACTOR_ID,
      }),
    ).toThrow(/definition changed/);
    expect(guild.getRoleMenuById(menu.menuId)?.title).toBe(
      "Updated member colors",
    );

    const reenabled = guild.setRoleMenuState(
      menu.menuId,
      "enabled",
      ACTOR_ID,
      VERIFIED_AT,
    )!;
    const secondPost = guild.createRoleMenuPost({
      postId: "postAlpha002",
      menuId: reenabled.menuId,
      channelId: CHANNEL_ID,
      messageId: SECOND_MESSAGE_ID,
      definitionVersion: reenabled.definitionVersion,
      bindingsVerifiedAt: VERIFIED_AT,
      state: "active",
    });
    expect(guild.invalidateRoleMenuRole(ROLE_B)).toEqual({
      menusChanged: 1,
      postsChanged: 1,
    });
    expect(guild.getRoleMenuById(menu.menuId)).toMatchObject({
      state: "disabled",
      bindingsVerifiedAt: null,
    });
    expect(guild.getRoleMenuPostById(secondPost.postId)).toMatchObject({
      state: "stale",
      bindingsVerifiedAt: null,
    });
    expect(guild.invalidateRoleMenuRole(ROLE_B)).toEqual({
      menusChanged: 1,
      postsChanged: 0,
    });
  });

  it("reserves and completes role-menu mutation plans transactionally", () => {
    const { storage } = createStorage();
    const guild = storage.forGuild(GUILD_A);
    const { menu } = createEnabledMenu(guild);
    const input = {
      operationId: "roleMenuOp01",
      interactionId: INTERACTION_ID,
      menuId: menu.menuId,
      memberId: MEMBER_ID,
      definitionVersion: menu.definitionVersion,
      selectionKey: "optionAlpha01",
      plannedAdds: [ROLE_A],
      plannedRemovals: [ROLE_B],
    };
    const reserved = guild.reserveRoleMenuOperation(input);
    expect(reserved).toMatchObject({
      status: "reserved",
      operation: {
        state: "reserved",
        items: [
          { roleId: ROLE_A, action: "add", state: "planned" },
          { roleId: ROLE_B, action: "remove", state: "planned" },
        ],
      },
    });
    expect(guild.reserveRoleMenuOperation(input)).toEqual({
      status: "duplicate",
      operation: reserved.operation,
    });
    expect(() =>
      guild.reserveRoleMenuOperation({
        ...input,
        plannedAdds: [ROLE_C],
      }),
    ).toThrow(/different role-menu work/);
    expect(guild.listRoleMenuOperations()).toHaveLength(1);

    expect(() =>
      guild.completeRoleMenuOperation(reserved.operation.operationId, {
        state: "completed",
        addedRoleIds: [ROLE_A],
        removedRoleIds: [],
        failedRoleIds: [],
        skippedRoleIds: [],
      }),
    ).toThrow(/account for every planned role change/);
    expect(
      guild.getRoleMenuOperationById(reserved.operation.operationId),
    ).toMatchObject({
      state: "reserved",
      items: [
        { roleId: ROLE_A, state: "planned" },
        { roleId: ROLE_B, state: "planned" },
      ],
    });

    const partialInput = {
      state: "partial" as const,
      addedRoleIds: [ROLE_A],
      removedRoleIds: [],
      failedRoleIds: [ROLE_B],
      skippedRoleIds: [],
      failureCode: "discord-role-remove-failed",
    };
    const partial = guild.completeRoleMenuOperation(
      reserved.operation.operationId,
      partialInput,
    );
    expect(partial).toMatchObject({
      state: "partial",
      failureCode: "discord-role-remove-failed",
      items: [
        { roleId: ROLE_A, action: "add", state: "completed" },
        {
          roleId: ROLE_B,
          action: "remove",
          state: "failed",
          failureCode: "discord-role-remove-failed",
        },
      ],
    });
    expect(
      guild.completeRoleMenuOperation(
        reserved.operation.operationId,
        partialInput,
      ),
    ).toEqual(partial);
    expect(() =>
      guild.completeRoleMenuOperation(reserved.operation.operationId, {
        state: "completed",
        addedRoleIds: [ROLE_A],
        removedRoleIds: [ROLE_B],
        failedRoleIds: [],
        skippedRoleIds: [],
      }),
    ).toThrow(/already complete/);

    const skippedReservation = guild.reserveRoleMenuOperation({
      operationId: "roleMenuOp02",
      interactionId: SECOND_INTERACTION_ID,
      menuId: menu.menuId,
      memberId: MEMBER_ID,
      definitionVersion: menu.definitionVersion,
      selectionKey: "optionAlpha02",
      plannedAdds: [ROLE_A],
      plannedRemovals: [ROLE_B],
    });
    const skippedInput = {
      state: "failed" as const,
      addedRoleIds: [],
      removedRoleIds: [],
      failedRoleIds: [ROLE_A],
      skippedRoleIds: [ROLE_B],
      failureCode: "discord-role-add-failed",
    };
    const skipped = guild.completeRoleMenuOperation(
      skippedReservation.operation.operationId,
      skippedInput,
    );
    expect(skipped).toMatchObject({
      state: "failed",
      items: [
        { roleId: ROLE_A, action: "add", state: "failed" },
        { roleId: ROLE_B, action: "remove", state: "skipped" },
      ],
    });
    expect(
      guild.completeRoleMenuOperation(
        skippedReservation.operation.operationId,
        skippedInput,
      ),
    ).toEqual(skipped);
    expect(guild.listRoleMenuOperations()[0]?.operationId).toBe(
      skippedReservation.operation.operationId,
    );

    const emptyReservation = guild.reserveRoleMenuOperation({
      operationId: "roleMenuOp03",
      interactionId: "900000000000000004",
      menuId: menu.menuId,
      memberId: MEMBER_ID,
      definitionVersion: menu.definitionVersion,
      selectionKey: "no-change",
      plannedAdds: [],
      plannedRemovals: [],
    });
    expect(() =>
      guild.completeRoleMenuOperation(emptyReservation.operation.operationId, {
        state: "completed",
        addedRoleIds: [],
        removedRoleIds: [],
        failedRoleIds: [],
        skippedRoleIds: [],
      }),
    ).toThrow(/cannot be empty/u);
    expect(
      guild.completeRoleMenuOperation(emptyReservation.operation.operationId, {
        state: "no-change",
        addedRoleIds: [],
        removedRoleIds: [],
        failedRoleIds: [],
        skippedRoleIds: [],
      }),
    ).toMatchObject({ state: "no-change", items: [] });
  });

  it("enforces tenant, uniqueness, active-binding, and foreign-key boundaries", () => {
    const { storage, dbFile } = createStorage(true);
    const guildA = storage.forGuild(GUILD_A);
    const guildB = storage.forGuild(GUILD_B);
    const rulesA = guildA.createOnboardingRulesVersion({
      title: "Guild A rules",
      body: "Only Guild A owns this immutable version.",
      actorId: ACTOR_ID,
    });
    expect(() =>
      guildB.upsertOnboardingConfiguration(
        activeOnboardingConfiguration(rulesA.rulesVersion),
      ),
    ).toThrow(/does not exist in this guild/);
    expect(guildB.getOnboardingConfiguration()).toBeNull();
    expect(guildB.getOnboardingRulesVersion(rulesA.rulesVersion)).toBeNull();

    const menuA = guildA.createRoleMenu({
      menuId: "sharedMenu01",
      slug: "shared-slug",
      title: "Guild A menu",
      description: "Tenant A owns this definition.",
      mode: "toggle",
      minSelections: 0,
      maxSelections: 1,
      actorId: ACTOR_ID,
    });
    const menuB = guildB.createRoleMenu({
      menuId: "sharedMenu01",
      slug: "shared-slug",
      title: "Guild B menu",
      description: "Tenant B owns a separate definition.",
      mode: "toggle",
      minSelections: 0,
      maxSelections: 1,
      actorId: ACTOR_ID,
    });
    expect(guildA.getRoleMenuById(menuA.menuId)?.title).toBe("Guild A menu");
    expect(guildB.getRoleMenuById(menuB.menuId)?.title).toBe("Guild B menu");
    expect(() =>
      guildA.createRoleMenu({
        menuId: "anotherMenu01",
        slug: "shared-slug",
        title: "Duplicate slug",
        description: "This transaction must not create another row.",
        mode: "toggle",
        minSelections: 0,
        maxSelections: 1,
        actorId: ACTOR_ID,
      }),
    ).toThrow(/UNIQUE constraint failed/);
    expect(guildA.countRoleMenus()).toBe(1);

    const option = guildA.createRoleMenuOption(menuA.menuId, {
      optionId: "sharedOpt001",
      roleId: ROLE_A,
      label: "Gold",
      actorId: ACTOR_ID,
    });
    const versionAfterOption = guildA.getRoleMenuById(
      menuA.menuId,
    )!.definitionVersion;
    expect(() =>
      guildA.createRoleMenuOption(menuA.menuId, {
        optionId: "sharedOpt002",
        roleId: option.roleId,
        label: "Duplicate role",
        actorId: ACTOR_ID,
      }),
    ).toThrow(/only once/);
    expect(guildA.listRoleMenuOptions(menuA.menuId)).toEqual([option]);
    expect(guildA.getRoleMenuById(menuA.menuId)?.definitionVersion).toBe(
      versionAfterOption,
    );
    expect(() =>
      guildA.createRoleMenuPost({
        postId: "invalidPost01",
        menuId: menuA.menuId,
        channelId: CHANNEL_ID,
        messageId: MESSAGE_ID,
        definitionVersion: versionAfterOption,
        bindingsVerifiedAt: null,
        state: "active",
      }),
    ).toThrow(/active post requires/);
    expect(guildA.countRoleMenuPosts(menuA.menuId)).toBe(0);

    const raw = new Database(dbFile!);
    try {
      raw.pragma("foreign_keys = ON");
      expect(() =>
        raw
          .prepare(
            `INSERT INTO member_rule_acceptances
             (guild_id, member_id, rules_version, accepted_at, panel_post_id)
             VALUES (?, ?, ?, ?, NULL)`,
          )
          .run(GUILD_A, MEMBER_ID, 99, VERIFIED_AT),
      ).toThrow(/FOREIGN KEY constraint failed/);
      expect(
        raw
          .prepare(
            "SELECT COUNT(*) AS count FROM member_rule_acceptances WHERE guild_id = ?",
          )
          .get(GUILD_A),
      ).toEqual({ count: 0 });
    } finally {
      raw.close();
    }
  });
});
