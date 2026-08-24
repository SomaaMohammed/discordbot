import { describe, expect, it } from "vitest";
import { createDefaultGuildSettings } from "../src/guild-settings.js";
import {
  ONBOARDING_RULES_BODY_MAXIMUM,
  type OnboardingConfiguration,
  type OnboardingDeliveryRecord,
  type OnboardingRoleOperation,
  type RoleMenuOperation,
} from "../src/types.js";
import {
  GUILD_DATA_COLLECTION_LIMITS,
  insertPhase4GuildData,
  parseGuildDataExport,
} from "../src/storage/guild-data.js";
import {
  emptyPhase2OperationalData,
  PHASE2_COLLECTION_LIMITS,
} from "../src/storage/guild-data-v4.js";
import {
  emptyRestrictedPingGuildData,
  RESTRICTED_PING_COLLECTION_LIMITS,
} from "../src/storage/guild-data-v5.js";
import {
  emptyPhase3GuildData,
  PHASE3_COLLECTION_LIMITS,
} from "../src/storage/guild-data-v7.js";
import {
  emptyPhase4GuildData,
  PHASE4_COLLECTION_LIMITS,
} from "../src/storage/guild-data-v8.js";
import { createDefaultLegacyGuildSettingsV2 } from "../src/storage/guild-settings-v2.js";

const GUILD_ID = "111111111111111111";
const MEMBER_ID = "222222222222222222";
const ACTOR_ID = "333333333333333333";
const ROLE_ID = "444444444444444444";
const SECOND_ROLE_ID = "444444444444444445";
const CHANNEL_ID = "555555555555555555";
const MESSAGE_ID = "666666666666666666";
const T0 = "2026-08-23T00:00:00.000Z";
const T1 = "2026-08-23T00:01:00.000Z";

function payload(formatVersion: 2 | 3 | 4 | 5 | 6 | 7 | 8) {
  return {
    formatVersion,
    guildId: GUILD_ID,
    exportedAt: T0,
    metadata: { guildId: GUILD_ID },
    settings:
      formatVersion >= 6
        ? createDefaultGuildSettings()
        : createDefaultLegacyGuildSettingsV2(),
    metrics: [],
    ticketConfiguration: null,
    ...emptyPhase2OperationalData(),
    ...emptyRestrictedPingGuildData(),
    ...emptyPhase3GuildData(),
    ...emptyPhase4GuildData(),
  };
}

function addRoleMenuOperation(
  current: ReturnType<typeof payload>,
  operation: RoleMenuOperation,
): void {
  current.roleMenus = [
    {
      guildId: GUILD_ID,
      menuId: operation.menuId,
      slug: "operation-check",
      title: "Operation validation",
      description: "A dormant menu used to validate imported outcomes.",
      sortOrder: 0,
      state: "disabled",
      mode: "toggle",
      minSelections: 0,
      maxSelections: 2,
      requiredRoleId: null,
      definitionVersion: 1,
      bindingsVerifiedAt: null,
      createdBy: ACTOR_ID,
      updatedBy: ACTOR_ID,
      createdAt: T0,
      updatedAt: T0,
    },
  ];
  current.roleMenuOperations = [operation];
}

function roleMenuOperation(
  state: RoleMenuOperation["state"],
  itemStates: ReadonlyArray<
    readonly [RoleMenuOperation["items"][number]["state"], string | null]
  >,
  failureCode: string | null,
): RoleMenuOperation {
  const operationId = "menuOutcome01";
  return {
    guildId: GUILD_ID,
    operationId,
    interactionId: "777777777777777777",
    menuId: "menuOutcome01",
    memberId: MEMBER_ID,
    definitionVersion: 1,
    selectionKey: "selection",
    state,
    failureCode,
    createdAt: T0,
    updatedAt: T0,
    completedAt: state === "reserved" ? null : T0,
    items: itemStates.map(([itemState, itemFailureCode], index) => ({
      guildId: GUILD_ID,
      operationId,
      roleId: index === 0 ? ROLE_ID : SECOND_ROLE_ID,
      action: index === 0 ? "add" : "remove",
      state: itemState,
      failureCode: itemFailureCode,
    })),
  };
}

function onboardingDelivery(
  overrides: Partial<OnboardingDeliveryRecord> = {},
): OnboardingDeliveryRecord {
  return {
    guildId: GUILD_ID,
    deliveryId: "deliveryMeta01",
    memberId: MEMBER_ID,
    joinInstance: "join-1",
    kind: "welcome-public",
    state: "failed",
    channelId: null,
    messageId: null,
    attemptCount: 1,
    failureCode: "discord-failed",
    claimId: null,
    claimExpiresAt: null,
    deliveredAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function onboardingRoleOperation(
  operationId: string,
  overrides: Partial<OnboardingRoleOperation> = {},
): OnboardingRoleOperation {
  return {
    guildId: GUILD_ID,
    operationId,
    memberId: MEMBER_ID,
    roleId: ROLE_ID,
    kind: "verified-add",
    idempotencyKey: `rules:1:${operationId}`,
    state: "reserved",
    failureCode: null,
    attemptCount: 1,
    createdAt: T0,
    updatedAt: T0,
    completedAt: null,
    resolvedAt: null,
    resolvedByOperationId: null,
    ...overrides,
  };
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
    welcomeTitle: "Welcome to {server}",
    welcomeBody: "Hello {user}.",
    farewellTitle: "Member left",
    farewellBody: "{user} left {server}.",
    welcomeChannelVerifiedAt: null,
    farewellChannelVerifiedAt: null,
    lifecycleLogChannelVerifiedAt: null,
    rulesChannelVerifiedAt: null,
    verificationRolesVerifiedAt: null,
    createdBy: ACTOR_ID,
    updatedBy: ACTOR_ID,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

describe("guild-data format 8 integration", () => {
  it.each([2, 3, 4, 5, 6, 7] as const)(
    "continues importing format %i and supplies empty Phase 4 data",
    (formatVersion) => {
      const legacy = payload(formatVersion);
      legacy.onboardingRulesVersions = [
        {
          guildId: GUILD_ID,
          rulesVersion: 1,
          title: "This forged legacy row must be ignored",
          body: "Legacy formats have no Phase 4 contract.",
          reacceptanceRequested: false,
          createdBy: ACTOR_ID,
          createdAt: T0,
        },
      ];

      const parsed = parseGuildDataExport(legacy, GUILD_ID);

      expect(parsed.sourceFormatVersion).toBe(formatVersion);
      expect(parsed.formatVersion).toBe(8);
      expect(parsed).toMatchObject(emptyPhase4GuildData());
    },
  );

  it("parses and preserves valid Phase 4 collections only from format 8", () => {
    const current = payload(8);
    current.postedPanels = [
      {
        guildId: GUILD_ID,
        panelId: "current_panel",
        preset: "help",
        channelId: CHANNEL_ID,
        messageId: MESSAGE_ID,
        configuration: {},
        createdAt: T0,
        updatedAt: T0,
      },
    ];
    current.restrictedPingRoles = [
      {
        guildId: GUILD_ID,
        roleId: ROLE_ID,
        enabled: false,
        userCooldownSeconds: 60,
        roleCooldownSeconds: 0,
        allowThreads: false,
        bindingsVerifiedAt: null,
        lastRoleSuccessAt: null,
        successCount: 0,
        createdBy: ACTOR_ID,
        updatedBy: ACTOR_ID,
        createdAt: T0,
        updatedAt: T0,
      },
    ];
    current.antiSpamExemptRoles = [
      {
        guildId: GUILD_ID,
        subjectId: ROLE_ID,
        createdBy: ACTOR_ID,
        createdAt: T0,
      },
    ];
    current.onboardingRulesVersions = [
      {
        guildId: GUILD_ID,
        rulesVersion: 1,
        title: "Server rules",
        body: "Be kind.",
        reacceptanceRequested: false,
        createdBy: ACTOR_ID,
        createdAt: T0,
      },
    ];
    current.memberRuleAcceptances = [
      {
        guildId: GUILD_ID,
        memberId: MEMBER_ID,
        rulesVersion: 1,
        acceptedAt: T0,
        panelPostId: null,
      },
    ];

    const parsed = parseGuildDataExport(current, GUILD_ID);

    expect(parsed.sourceFormatVersion).toBe(8);
    expect(parsed.formatVersion).toBe(8);
    expect(parsed.onboardingRulesVersions).toEqual(
      current.onboardingRulesVersions,
    );
    expect(parsed.memberRuleAcceptances).toEqual(current.memberRuleAcceptances);
    expect(parsed.postedPanels).toEqual(current.postedPanels);
    expect(parsed.restrictedPingRoles).toEqual(current.restrictedPingRoles);
    expect(parsed.antiSpamExemptRoles).toEqual(current.antiSpamExemptRoles);
  });

  it("parses verification and roles panel presets with exact Phase 4 references", () => {
    const current = payload(8);
    const menuId = "menuPanel001";
    const panelId = "rolesPanel01";
    current.onboardingRulesVersions = [
      {
        guildId: GUILD_ID,
        rulesVersion: 1,
        title: "Server rules",
        body: "Be kind.",
        reacceptanceRequested: false,
        createdBy: ACTOR_ID,
        createdAt: T0,
      },
    ];
    current.onboardingConfiguration = onboardingConfiguration({
      enabled: true,
      verificationEnabled: true,
      currentRulesVersion: 1,
      verifiedRoleId: ROLE_ID,
      verificationRolesVerifiedAt: T0,
    });
    current.roleMenus = [
      {
        guildId: GUILD_ID,
        menuId,
        slug: "colors",
        title: "Member colors",
        description: "Choose a color.",
        sortOrder: 0,
        state: "enabled",
        mode: "exclusive",
        minSelections: 0,
        maxSelections: 1,
        requiredRoleId: null,
        definitionVersion: 1,
        bindingsVerifiedAt: T0,
        createdBy: ACTOR_ID,
        updatedBy: ACTOR_ID,
        createdAt: T0,
        updatedAt: T0,
      },
    ];
    current.roleMenuOptions = [
      {
        guildId: GUILD_ID,
        menuId,
        optionId: "optionPanel01",
        roleId: ROLE_ID,
        label: "Gold",
        description: null,
        emoji: null,
        sortOrder: 0,
        createdBy: ACTOR_ID,
        updatedBy: ACTOR_ID,
        createdAt: T0,
        updatedAt: T0,
      },
    ];
    current.roleMenuPosts = [
      {
        guildId: GUILD_ID,
        postId: panelId,
        menuId,
        channelId: CHANNEL_ID,
        messageId: MESSAGE_ID,
        definitionVersion: 1,
        bindingsVerifiedAt: T0,
        state: "active",
        createdAt: T0,
        updatedAt: T0,
      },
    ];
    current.postedPanels = [
      {
        guildId: GUILD_ID,
        panelId: "verifyPanel01",
        preset: "verification",
        channelId: "777777777777777777",
        messageId: "888888888888888888",
        configuration: { rulesVersion: 1, bindingsVerifiedAt: T0 },
        createdAt: T0,
        updatedAt: T0,
      },
      {
        guildId: GUILD_ID,
        panelId,
        preset: "roles",
        channelId: CHANNEL_ID,
        messageId: MESSAGE_ID,
        configuration: {
          menuId,
          postId: panelId,
          definitionVersion: 1,
          bindingsVerifiedAt: T0,
        },
        createdAt: T0,
        updatedAt: T0,
      },
    ];

    const parsed = parseGuildDataExport(current, GUILD_ID);
    expect(parsed.postedPanels.map(({ preset }) => preset)).toEqual([
      "verification",
      "roles",
    ]);

    const orphanedVerification = structuredClone(current);
    orphanedVerification.onboardingConfiguration = null;
    expect(() => parseGuildDataExport(orphanedVerification, GUILD_ID)).toThrow(
      /verification panel has no onboarding configuration/u,
    );

    const malformed = structuredClone(current);
    malformed.postedPanels[1]!.configuration = {
      menuId: "missingMenu01",
      postId: panelId,
      definitionVersion: 1,
      bindingsVerifiedAt: T0,
    };
    expect(() => parseGuildDataExport(malformed, GUILD_ID)).toThrow(
      /inconsistent menu\/message binding/u,
    );
  });

  it("applies Phase 4 limits through the main format-8 parser", () => {
    const current = payload(8);
    current.onboardingRulesVersions = Array.from(
      { length: PHASE4_COLLECTION_LIMITS.onboardingRulesVersions + 1 },
      (_, index) => ({
        guildId: GUILD_ID,
        rulesVersion: index + 1,
        title: `Rules ${index + 1}`,
        body: "A bounded rules version.",
        reacceptanceRequested: false,
        createdBy: ACTOR_ID,
        createdAt: T0,
      }),
    );

    expect(() => parseGuildDataExport(current, GUILD_ID)).toThrow(
      /onboardingRulesVersions is invalid/,
    );
  });

  it.each([
    ["reserved", roleMenuOperation("reserved", [["planned", null]], null)],
    ["completed", roleMenuOperation("completed", [["completed", null]], null)],
    ["no-change", roleMenuOperation("no-change", [], null)],
    [
      "failed",
      roleMenuOperation(
        "failed",
        [
          ["failed", "discord-failed"],
          ["skipped", null],
        ],
        "discord-failed",
      ),
    ],
    [
      "partial",
      roleMenuOperation(
        "partial",
        [
          ["completed", null],
          ["failed", "discord-failed"],
        ],
        "discord-failed",
      ),
    ],
  ] as const)(
    "accepts repository-produced %s role-menu outcomes",
    (_label, operation) => {
      const current = payload(8);
      addRoleMenuOperation(current, structuredClone(operation));
      expect(
        parseGuildDataExport(current, GUILD_ID).roleMenuOperations,
      ).toEqual([operation]);
    },
  );

  it.each([
    [
      "a completed parent with planned work",
      roleMenuOperation("completed", [["planned", null]], null),
    ],
    [
      "a no-change parent with an item",
      roleMenuOperation("no-change", [["completed", null]], null),
    ],
    [
      "a failed parent with a successful item",
      roleMenuOperation(
        "failed",
        [
          ["completed", null],
          ["failed", "discord-failed"],
        ],
        "discord-failed",
      ),
    ],
    [
      "a partial parent without incomplete work",
      roleMenuOperation("partial", [["completed", null]], "discord-failed"),
    ],
    [
      "a failed item whose code differs from its parent",
      roleMenuOperation(
        "failed",
        [["failed", "different-failure"]],
        "discord-failed",
      ),
    ],
    [
      "failure metadata on a successful item",
      roleMenuOperation(
        "completed",
        [["completed", "unexpected-failure"]],
        null,
      ),
    ],
  ] as const)("rejects %s", (_label, operation) => {
    const current = payload(8);
    addRoleMenuOperation(current, structuredClone(operation));
    expect(() => parseGuildDataExport(current, GUILD_ID)).toThrow(
      /role menu operation item outcomes are inconsistent/u,
    );
  });

  it.each([
    [
      "a retryable failure with a delivered-message checkpoint",
      onboardingDelivery({
        channelId: CHANNEL_ID,
        messageId: MESSAGE_ID,
        deliveredAt: T0,
      }),
    ],
    [
      "a retryable failure without failure metadata",
      onboardingDelivery({ failureCode: null }),
    ],
    [
      "a delivered row with failure metadata",
      onboardingDelivery({
        state: "delivered",
        channelId: CHANNEL_ID,
        messageId: MESSAGE_ID,
        deliveredAt: T0,
      }),
    ],
    [
      "a reserved row with failure metadata",
      onboardingDelivery({
        state: "reserved",
        claimId: "claimMeta001",
        claimExpiresAt: T0,
      }),
    ],
    [
      "a non-skipped row with no delivery attempt",
      onboardingDelivery({ attemptCount: 0 }),
    ],
  ] as const)("rejects %s", (_label, delivery) => {
    const current = payload(8);
    current.onboardingDeliveryRecords = [structuredClone(delivery)];
    expect(() => parseGuildDataExport(current, GUILD_ID)).toThrow(
      /onboarding delivery .*inconsistent/u,
    );
  });

  it("preserves an imported-interrupted skipped delivery checkpoint", () => {
    const current = payload(8);
    const delivery = onboardingDelivery({
      state: "skipped",
      failureCode: "import-interrupted",
    });
    current.onboardingDeliveryRecords = [structuredClone(delivery)];
    expect(
      parseGuildDataExport(current, GUILD_ID).onboardingDeliveryRecords,
    ).toEqual([delivery]);
  });

  it("rejects success metadata on an onboarding role operation", () => {
    const current = payload(8);
    current.onboardingRoleOperations = [
      {
        guildId: GUILD_ID,
        operationId: "onboardMeta01",
        memberId: MEMBER_ID,
        roleId: ROLE_ID,
        kind: "verified-add",
        idempotencyKey: "rules:1:verified",
        state: "completed",
        failureCode: "unexpected-failure",
        attemptCount: 1,
        createdAt: T0,
        updatedAt: T0,
        completedAt: T0,
        resolvedAt: null,
        resolvedByOperationId: null,
      },
    ];
    expect(() => parseGuildDataExport(current, GUILD_ID)).toThrow(
      /onboarding role operation failure metadata is inconsistent/u,
    );
  });

  it("preserves strictly linked onboarding recovery resolution metadata", () => {
    const current = payload(8);
    const resolver = onboardingRoleOperation("onboardFix0001", {
      idempotencyKey: `recover:777777777777777777:verified-add:${ROLE_ID}`,
      state: "no-change",
      updatedAt: T1,
      completedAt: T1,
    });
    const original = onboardingRoleOperation("onboardOld0001", {
      updatedAt: T1,
      resolvedAt: T1,
      resolvedByOperationId: resolver.operationId,
    });
    current.onboardingRoleOperations = [original, resolver];

    expect(
      parseGuildDataExport(current, GUILD_ID).onboardingRoleOperations,
    ).toEqual([original, resolver]);
  });

  it.each([
    [
      "unpaired metadata",
      (original: OnboardingRoleOperation) => ({
        ...original,
        resolvedByOperationId: null,
      }),
    ],
    [
      "a non-recovery resolver",
      (
        original: OnboardingRoleOperation,
        resolver: OnboardingRoleOperation,
      ) => ({
        original,
        resolver: { ...resolver, idempotencyKey: "rules:1:verified" },
      }),
    ],
    [
      "a mismatched resolver",
      (
        original: OnboardingRoleOperation,
        resolver: OnboardingRoleOperation,
      ) => ({
        original,
        resolver: { ...resolver, roleId: SECOND_ROLE_ID },
      }),
    ],
  ] as const)("rejects onboarding resolution with %s", (_label, mutate) => {
    const current = payload(8);
    const resolver = onboardingRoleOperation("onboardFix0001", {
      idempotencyKey: `recover:777777777777777777:verified-add:${ROLE_ID}`,
      state: "completed",
      updatedAt: T1,
      completedAt: T1,
    });
    const original = onboardingRoleOperation("onboardOld0001", {
      updatedAt: T1,
      resolvedAt: T1,
      resolvedByOperationId: resolver.operationId,
    });
    const changed = mutate(original, resolver);
    current.onboardingRoleOperations =
      "resolver" in changed
        ? [changed.original, changed.resolver]
        : [changed, resolver];
    expect(() => parseGuildDataExport(current, GUILD_ID)).toThrow(
      /onboarding role operation .*resolution/u,
    );
  });

  it("rejects a verification checkpoint without a verified role", () => {
    const current = payload(8);
    current.onboardingConfiguration = onboardingConfiguration({
      verificationRolesVerifiedAt: T0,
    });
    expect(() => parseGuildDataExport(current, GUILD_ID)).toThrow(
      /verification binding has no verified role/u,
    );
  });

  it("rejects overlap between verification roles and autoroles", () => {
    const current = payload(8);
    current.onboardingConfiguration = onboardingConfiguration({
      verifiedRoleId: ROLE_ID,
    });
    current.onboardingAutoroles = [
      {
        guildId: GUILD_ID,
        audience: "human",
        roleId: ROLE_ID,
        sortOrder: 0,
        enabled: false,
        bindingsVerifiedAt: null,
        createdBy: ACTOR_ID,
        updatedBy: ACTOR_ID,
        createdAt: T0,
        updatedAt: T0,
      },
    ];

    expect(() => parseGuildDataExport(current, GUILD_ID)).toThrow(
      /verification roles cannot also be onboarding autoroles/u,
    );
  });

  it.each([
    [
      "an active post for a disabled parent menu",
      {
        definitionVersion: 1,
        bindingsVerifiedAt: T0,
        state: "active" as const,
      },
      /active role menu post does not match/u,
    ],
    [
      "a future stale post definition",
      {
        definitionVersion: 2,
        bindingsVerifiedAt: null,
        state: "stale" as const,
      },
      /post definition is newer/u,
    ],
  ] as const)("rejects %s", (_label, postState, error) => {
    const current = payload(8);
    addRoleMenuOperation(current, roleMenuOperation("no-change", [], null));
    current.roleMenuPosts = [
      {
        guildId: GUILD_ID,
        postId: "menuPostMeta01",
        menuId: "menuOutcome01",
        channelId: CHANNEL_ID,
        messageId: MESSAGE_ID,
        createdAt: T0,
        updatedAt: T0,
        ...postState,
      },
    ];
    expect(() => parseGuildDataExport(current, GUILD_ID)).toThrow(error);
  });

  it("rejects a future role-menu operation definition", () => {
    const current = payload(8);
    const operation = roleMenuOperation("no-change", [], null);
    operation.definitionVersion = 2;
    addRoleMenuOperation(current, operation);
    expect(() => parseGuildDataExport(current, GUILD_ID)).toThrow(
      /operation definition is newer/u,
    );
  });

  it("rejects contradictory add and remove items for one role", () => {
    const current = payload(8);
    const operation = roleMenuOperation(
      "completed",
      [
        ["completed", null],
        ["completed", null],
      ],
      null,
    );
    operation.items[1] = { ...operation.items[1]!, roleId: ROLE_ID };
    addRoleMenuOperation(current, operation);
    expect(() => parseGuildDataExport(current, GUILD_ID)).toThrow(
      /duplicate role menu operation item role/u,
    );
  });

  it("rejects completed role-menu work with an empty mutation plan", () => {
    const current = payload(8);
    addRoleMenuOperation(current, roleMenuOperation("completed", [], null));
    expect(() => parseGuildDataExport(current, GUILD_ID)).toThrow(
      /item outcomes are inconsistent/u,
    );
  });

  it("enforces the per-menu retained-post bound", () => {
    const current = payload(8);
    addRoleMenuOperation(current, roleMenuOperation("no-change", [], null));
    current.roleMenuPosts = Array.from({ length: 101 }, (_, index) => ({
      guildId: GUILD_ID,
      postId: `post${String(index).padStart(8, "0")}`,
      menuId: "menuOutcome01",
      channelId: String(600_000_000_000_000_000n + BigInt(index)),
      messageId: String(700_000_000_000_000_000n + BigInt(index)),
      definitionVersion: 1,
      bindingsVerifiedAt: null,
      state: "stale" as const,
      createdAt: T0,
      updatedAt: T0,
    }));
    expect(() => parseGuildDataExport(current, GUILD_ID)).toThrow(
      /exceeds the post limit/u,
    );
  });

  it.each([
    ["duplicate", 0, /duplicate role menu position/u],
    ["gapped", 2, /role menu ordering is not contiguous/u],
  ] as const)(
    "rejects %s guild-local role menu ordering",
    (_label, sortOrder, error) => {
      const current = payload(8);
      addRoleMenuOperation(current, roleMenuOperation("no-change", [], null));
      current.roleMenus.push({
        ...current.roleMenus[0]!,
        menuId: "menuSecond01",
        slug: "second-menu",
        sortOrder,
      });

      expect(() => parseGuildDataExport(current, GUILD_ID)).toThrow(error);
    },
  );

  it("rejects enabled role menus whose option bounds cannot be satisfied", () => {
    const current = payload(8);
    addRoleMenuOperation(current, roleMenuOperation("no-change", [], null));
    current.roleMenus[0] = {
      ...current.roleMenus[0]!,
      state: "enabled",
      bindingsVerifiedAt: T0,
    };

    expect(() => parseGuildDataExport(current, GUILD_ID)).toThrow(
      /impossible option bounds/u,
    );
  });

  it("reserves room for the fixed verification acknowledgement on import", () => {
    const current = payload(8);
    current.onboardingRulesVersions = [
      {
        guildId: GUILD_ID,
        rulesVersion: 1,
        title: "Server rules",
        body: "x".repeat(ONBOARDING_RULES_BODY_MAXIMUM + 1),
        reacceptanceRequested: false,
        createdBy: ACTOR_ID,
        createdAt: T0,
      },
    ];

    expect(() => parseGuildDataExport(current, GUILD_ID)).toThrow(
      /onboardingRulesVersions is invalid/u,
    );

    current.onboardingRulesVersions[0]!.body = "_".repeat(2_500);
    expect(() => parseGuildDataExport(current, GUILD_ID)).toThrow(
      /after safe Markdown escaping/u,
    );
  });

  it("publishes the merged collection limits and Phase 4 insert helper", () => {
    expect(GUILD_DATA_COLLECTION_LIMITS).toMatchObject({
      ...PHASE2_COLLECTION_LIMITS,
      ...RESTRICTED_PING_COLLECTION_LIMITS,
      ...PHASE3_COLLECTION_LIMITS,
      ...PHASE4_COLLECTION_LIMITS,
    });
    expect(insertPhase4GuildData).toBeTypeOf("function");
  });

  it("rejects unsupported versions with the updated compatibility message", () => {
    expect(() =>
      parseGuildDataExport({ ...payload(8), formatVersion: 9 }, GUILD_ID),
    ).toThrow("formatVersion must be 2, 3, 4, 5, 6, 7, or 8");
  });
});
