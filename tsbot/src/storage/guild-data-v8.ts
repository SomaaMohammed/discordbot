import type Database from "better-sqlite3";
import { z } from "zod";
import { normalizeOnboardingTemplatePair } from "../discord/onboarding-template.js";
import {
  normalizeRulesBody,
  normalizeRulesTitle,
} from "../discord/verification-components.js";
import {
  MAX_ROLE_MENU_SELECTION_KEY_LENGTH,
  ONBOARDING_RULES_BODY_MAXIMUM,
} from "../types.js";
import { normalizeOptionalUnicodeEmoji } from "../unicode-emoji.js";
import type {
  MemberOnboardingState,
  MemberRuleAcceptance,
  OnboardingAuditEvent,
  OnboardingAutorole,
  OnboardingConfiguration,
  OnboardingDeliveryRecord,
  OnboardingRoleOperation,
  OnboardingRulesVersion,
  RoleMenu,
  RoleMenuOperation,
  RoleMenuOperationItem,
  RoleMenuOption,
  RoleMenuPost,
} from "../types.js";
import { normalizeRoleMenuText } from "./role-menu-normalization.js";

export const PHASE4_GUILD_TABLES = [
  "onboarding_rules_versions",
  "onboarding_configurations",
  "onboarding_message_templates",
  "onboarding_autoroles",
  "member_onboarding_states",
  "member_rule_acceptances",
  "onboarding_delivery_records",
  "onboarding_role_operations",
  "onboarding_audit_events",
  "role_menus",
  "role_menu_options",
  "role_menu_posts",
  "role_menu_operations",
  "role_menu_operation_items",
] as const;

export const PHASE4_COLLECTION_LIMITS = Object.freeze({
  onboardingRulesVersions: 25,
  onboardingAutoroles: 20,
  memberOnboardingStates: 100_000,
  memberRuleAcceptances: 100_000,
  onboardingDeliveryRecords: 100_000,
  onboardingRoleOperations: 200_000,
  onboardingAuditEvents: 10_000,
  roleMenus: 25,
  roleMenuOptions: 625,
  roleMenuPosts: 500,
  roleMenuOperations: 100_000,
});

export interface Phase4GuildData {
  onboardingConfiguration: OnboardingConfiguration | null;
  onboardingRulesVersions: OnboardingRulesVersion[];
  onboardingAutoroles: OnboardingAutorole[];
  memberOnboardingStates: MemberOnboardingState[];
  memberRuleAcceptances: MemberRuleAcceptance[];
  onboardingDeliveryRecords: OnboardingDeliveryRecord[];
  onboardingRoleOperations: OnboardingRoleOperation[];
  onboardingAuditEvents: OnboardingAuditEvent[];
  roleMenus: RoleMenu[];
  roleMenuOptions: RoleMenuOption[];
  roleMenuPosts: RoleMenuPost[];
  roleMenuOperations: RoleMenuOperation[];
}

const snowflake = z.string().regex(/^\d{17,20}$/u);
const opaqueId = z.string().regex(/^[A-Za-z0-9_-]{8,24}$/u);
const timestamp = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)));
const nullableSnowflake = snowflake.nullable();
const nullableTimestamp = timestamp.nullable();
const positiveVersion = z.number().int().min(1).max(2_147_483_647);

const configurationSchema = z
  .object({
    guildId: snowflake,
    enabled: z.boolean(),
    welcomeChannelId: nullableSnowflake,
    welcomePublicEnabled: z.boolean(),
    welcomeDmEnabled: z.boolean(),
    farewellChannelId: nullableSnowflake,
    farewellPublicEnabled: z.boolean(),
    lifecycleLogChannelId: nullableSnowflake,
    rulesChannelId: nullableSnowflake,
    verificationEnabled: z.boolean(),
    currentRulesVersion: positiveVersion.nullable(),
    verifiedRoleId: nullableSnowflake,
    unverifiedRoleId: nullableSnowflake,
    humanAutorolesEnabled: z.boolean(),
    botAutorolesEnabled: z.boolean(),
    accountAgeAlertHours: z.number().int().min(1).max(87_600).nullable(),
    welcomeTitle: z.string().min(1).max(256),
    welcomeBody: z.string().min(1).max(4_096),
    farewellTitle: z.string().min(1).max(256),
    farewellBody: z.string().min(1).max(4_096),
    welcomeChannelVerifiedAt: nullableTimestamp,
    farewellChannelVerifiedAt: nullableTimestamp,
    lifecycleLogChannelVerifiedAt: nullableTimestamp,
    rulesChannelVerifiedAt: nullableTimestamp,
    verificationRolesVerifiedAt: nullableTimestamp,
    createdBy: snowflake,
    updatedBy: snowflake,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

const rulesSchema = z
  .object({
    guildId: snowflake,
    rulesVersion: positiveVersion,
    title: z.string().min(1).max(256),
    body: z.string().min(1).max(ONBOARDING_RULES_BODY_MAXIMUM),
    reacceptanceRequested: z.boolean(),
    createdBy: snowflake,
    createdAt: timestamp,
  })
  .strict();

const autoroleSchema = z
  .object({
    guildId: snowflake,
    audience: z.enum(["human", "bot"]),
    roleId: snowflake,
    sortOrder: z.number().int().min(0).max(9),
    enabled: z.boolean(),
    bindingsVerifiedAt: nullableTimestamp,
    createdBy: snowflake,
    updatedBy: snowflake,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

const memberStateSchema = z
  .object({
    guildId: snowflake,
    memberId: snowflake,
    memberKind: z.enum(["human", "bot"]),
    screeningState: z.enum(["pending", "complete", "unknown"]),
    lifecycleState: z.enum([
      "pending-screening",
      "pending",
      "active",
      "departed",
    ]),
    joinedAt: timestamp,
    accountCreatedAt: timestamp,
    screeningCompletedAt: nullableTimestamp,
    departedAt: nullableTimestamp,
    lastProcessedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

const acceptanceSchema = z
  .object({
    guildId: snowflake,
    memberId: snowflake,
    rulesVersion: positiveVersion,
    acceptedAt: timestamp,
    panelPostId: opaqueId.nullable(),
  })
  .strict();

const deliverySchema = z
  .object({
    guildId: snowflake,
    deliveryId: opaqueId,
    memberId: snowflake,
    joinInstance: z.string().min(1).max(100),
    kind: z.enum([
      "welcome-public",
      "welcome-dm",
      "farewell-public",
      "lifecycle-log",
    ]),
    state: z.enum(["reserved", "delivered", "failed", "missing", "skipped"]),
    channelId: nullableSnowflake,
    messageId: nullableSnowflake,
    attemptCount: z.number().int().min(0).max(1_000),
    failureCode: z.string().min(1).max(100).nullable(),
    claimId: opaqueId.nullable(),
    claimExpiresAt: nullableTimestamp,
    deliveredAt: nullableTimestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

const onboardingRoleOperationSchema = z
  .object({
    guildId: snowflake,
    operationId: opaqueId,
    memberId: snowflake,
    roleId: snowflake,
    kind: z.enum([
      "verified-add",
      "unverified-add",
      "unverified-remove",
      "human-autorole-add",
      "bot-autorole-add",
    ]),
    idempotencyKey: z.string().min(1).max(100),
    state: z.enum(["reserved", "completed", "partial", "failed", "no-change"]),
    failureCode: z.string().min(1).max(100).nullable(),
    attemptCount: z.number().int().min(1).max(1_000),
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: nullableTimestamp,
    resolvedAt: nullableTimestamp,
    resolvedByOperationId: opaqueId.nullable(),
  })
  .strict();

const auditSchema = z
  .object({
    guildId: snowflake,
    eventId: opaqueId,
    eventNumber: positiveVersion,
    eventType: z.string().min(1).max(100),
    memberId: nullableSnowflake,
    actorId: nullableSnowflake,
    rulesVersion: positiveVersion.nullable(),
    outcome: z.string().min(1).max(100),
    details: z.unknown().refine((value) => boundedJson(value, 4_000)),
    createdAt: timestamp,
  })
  .strict();

const menuSchema = z
  .object({
    guildId: snowflake,
    menuId: opaqueId,
    slug: z
      .string()
      .min(2)
      .max(32)
      .regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])$/u),
    title: z.string().min(1).max(256),
    description: z.string().min(1).max(1_000),
    sortOrder: z.number().int().min(0).max(24),
    state: z.enum(["disabled", "enabled", "archived"]),
    mode: z.enum(["toggle", "exclusive", "limited"]),
    minSelections: z.number().int().min(0).max(25),
    maxSelections: z.number().int().min(1).max(25),
    requiredRoleId: nullableSnowflake,
    definitionVersion: positiveVersion,
    bindingsVerifiedAt: nullableTimestamp,
    createdBy: snowflake,
    updatedBy: snowflake,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

const menuOptionSchema = z
  .object({
    guildId: snowflake,
    menuId: opaqueId,
    optionId: opaqueId,
    roleId: snowflake,
    label: z.string().min(1).max(100),
    description: z.string().min(1).max(100).nullable(),
    emoji: z.string().min(1).max(16).nullable(),
    sortOrder: z.number().int().min(0).max(24),
    createdBy: snowflake,
    updatedBy: snowflake,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

const menuPostSchema = z
  .object({
    guildId: snowflake,
    postId: opaqueId,
    menuId: opaqueId,
    channelId: snowflake,
    messageId: snowflake,
    definitionVersion: positiveVersion,
    bindingsVerifiedAt: nullableTimestamp,
    state: z.enum(["active", "missing", "stale"]),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

const operationItemSchema = z
  .object({
    guildId: snowflake,
    operationId: opaqueId,
    roleId: snowflake,
    action: z.enum(["add", "remove"]),
    state: z.enum(["planned", "completed", "failed", "skipped"]),
    failureCode: z.string().min(1).max(100).nullable(),
  })
  .strict();

const menuOperationSchema = z
  .object({
    guildId: snowflake,
    operationId: opaqueId,
    interactionId: snowflake,
    menuId: opaqueId,
    memberId: snowflake,
    definitionVersion: positiveVersion,
    selectionKey: z.string().min(1).max(MAX_ROLE_MENU_SELECTION_KEY_LENGTH),
    state: z.enum(["reserved", "completed", "partial", "failed", "no-change"]),
    failureCode: z.string().min(1).max(100).nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: nullableTimestamp,
    items: z.array(operationItemSchema).max(25),
  })
  .strict();

export function emptyPhase4GuildData(): Phase4GuildData {
  return {
    onboardingConfiguration: null,
    onboardingRulesVersions: [],
    onboardingAutoroles: [],
    memberOnboardingStates: [],
    memberRuleAcceptances: [],
    onboardingDeliveryRecords: [],
    onboardingRoleOperations: [],
    onboardingAuditEvents: [],
    roleMenus: [],
    roleMenuOptions: [],
    roleMenuPosts: [],
    roleMenuOperations: [],
  };
}

const phase4Schema = z
  .object({
    onboardingConfiguration: configurationSchema.nullable(),
    onboardingRulesVersions: z
      .array(rulesSchema)
      .max(PHASE4_COLLECTION_LIMITS.onboardingRulesVersions),
    onboardingAutoroles: z
      .array(autoroleSchema)
      .max(PHASE4_COLLECTION_LIMITS.onboardingAutoroles),
    memberOnboardingStates: z
      .array(memberStateSchema)
      .max(PHASE4_COLLECTION_LIMITS.memberOnboardingStates),
    memberRuleAcceptances: z
      .array(acceptanceSchema)
      .max(PHASE4_COLLECTION_LIMITS.memberRuleAcceptances),
    onboardingDeliveryRecords: z
      .array(deliverySchema)
      .max(PHASE4_COLLECTION_LIMITS.onboardingDeliveryRecords),
    onboardingRoleOperations: z
      .array(onboardingRoleOperationSchema)
      .max(PHASE4_COLLECTION_LIMITS.onboardingRoleOperations),
    onboardingAuditEvents: z
      .array(auditSchema)
      .max(PHASE4_COLLECTION_LIMITS.onboardingAuditEvents),
    roleMenus: z.array(menuSchema).max(PHASE4_COLLECTION_LIMITS.roleMenus),
    roleMenuOptions: z
      .array(menuOptionSchema)
      .max(PHASE4_COLLECTION_LIMITS.roleMenuOptions),
    roleMenuPosts: z
      .array(menuPostSchema)
      .max(PHASE4_COLLECTION_LIMITS.roleMenuPosts),
    roleMenuOperations: z
      .array(menuOperationSchema)
      .max(PHASE4_COLLECTION_LIMITS.roleMenuOperations),
  })
  .strict();

/** Parses format-8 lifecycle state without exposing imported private text in errors. */
export function parsePhase4GuildData(
  candidate: Record<string, unknown>,
  guildId: string,
): Phase4GuildData {
  const selected = {
    onboardingConfiguration: candidate.onboardingConfiguration,
    onboardingRulesVersions: candidate.onboardingRulesVersions,
    onboardingAutoroles: candidate.onboardingAutoroles,
    memberOnboardingStates: candidate.memberOnboardingStates,
    memberRuleAcceptances: candidate.memberRuleAcceptances,
    onboardingDeliveryRecords: candidate.onboardingDeliveryRecords,
    onboardingRoleOperations: candidate.onboardingRoleOperations,
    onboardingAuditEvents: candidate.onboardingAuditEvents,
    roleMenus: candidate.roleMenus,
    roleMenuOptions: candidate.roleMenuOptions,
    roleMenuPosts: candidate.roleMenuPosts,
    roleMenuOperations: candidate.roleMenuOperations,
  };
  const parsed = phase4Schema.safeParse(selected);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    throw new TypeError(
      `Guild import ${typeof field === "string" ? field : "Phase 4 data"} is invalid`,
    );
  }
  const data = parsed.data as Phase4GuildData;
  for (const [collection, rows] of Object.entries(data)) {
    if (collection === "onboardingConfiguration") {
      if (
        rows !== null &&
        (rows as OnboardingConfiguration).guildId !== guildId
      )
        tenantError("onboarding configuration");
      continue;
    }
    for (const row of rows as Array<{ guildId: string }>)
      if (row.guildId !== guildId) tenantError(collection);
  }

  const ruleVersions = uniqueSet(
    data.onboardingRulesVersions,
    ({ rulesVersion }) => String(rulesVersion),
    "rules version",
  );
  if (
    data.onboardingConfiguration?.currentRulesVersion !== null &&
    data.onboardingConfiguration?.currentRulesVersion !== undefined &&
    !ruleVersions.has(String(data.onboardingConfiguration.currentRulesVersion))
  )
    throw new TypeError(
      "Imported onboarding configuration references unknown rules",
    );
  validateConfiguration(data.onboardingConfiguration, guildId);
  for (const rules of data.onboardingRulesVersions) {
    if (
      normalizeRulesTitle(rules.title) !== rules.title ||
      normalizeRulesBody(rules.body) !== rules.body
    ) {
      throw new TypeError("Imported rules text is not safely normalized");
    }
  }

  uniqueSet(data.onboardingAutoroles, ({ roleId }) => roleId, "autorole");
  const autorolePositions = uniqueSet(
    data.onboardingAutoroles,
    ({ audience, sortOrder }) => `${audience}\u0000${sortOrder}`,
    "autorole position",
  );
  void autorolePositions;
  for (const audience of ["human", "bot"] as const) {
    if (
      data.onboardingAutoroles.filter((row) => row.audience === audience)
        .length > 10
    )
      throw new RangeError(
        "Imported onboarding autoroles exceed the per-audience limit",
      );
  }
  for (const row of data.onboardingAutoroles) {
    if (row.roleId === guildId)
      throw new TypeError("Imported onboarding role cannot be @everyone");
    if (row.enabled !== (row.bindingsVerifiedAt !== null))
      throw new TypeError(
        "Imported onboarding autorole binding is inconsistent",
      );
  }
  const verificationRoleIds = new Set(
    [
      data.onboardingConfiguration?.verifiedRoleId,
      data.onboardingConfiguration?.unverifiedRoleId,
    ].filter(
      (roleId): roleId is string => roleId !== null && roleId !== undefined,
    ),
  );
  const verificationAutoroleConflict = data.onboardingAutoroles.find((row) =>
    verificationRoleIds.has(row.roleId),
  );
  if (verificationAutoroleConflict) {
    throw new TypeError(
      "Imported verification roles cannot also be onboarding autoroles",
    );
  }

  uniqueSet(
    data.memberOnboardingStates,
    ({ memberId }) => memberId,
    "member onboarding state",
  );
  for (const row of data.memberOnboardingStates) {
    if (
      (row.screeningState === "pending") !==
      (row.lifecycleState === "pending-screening")
    )
      throw new TypeError("Imported member screening state is inconsistent");
    if ((row.lifecycleState === "departed") !== (row.departedAt !== null))
      throw new TypeError("Imported member lifecycle state is inconsistent");
    if (row.screeningCompletedAt !== null && row.screeningState !== "complete")
      throw new TypeError(
        "Imported member screening checkpoint is inconsistent",
      );
  }

  uniqueSet(
    data.memberRuleAcceptances,
    ({ memberId, rulesVersion }) => `${memberId}\u0000${rulesVersion}`,
    "member rules acceptance",
  );
  for (const row of data.memberRuleAcceptances)
    requireReference(
      ruleVersions,
      String(row.rulesVersion),
      "rules acceptance version",
    );

  uniqueSet(
    data.onboardingDeliveryRecords,
    ({ deliveryId }) => deliveryId,
    "onboarding delivery ID",
  );
  uniqueSet(
    data.onboardingDeliveryRecords,
    ({ memberId, joinInstance, kind }) =>
      `${memberId}\u0000${joinInstance}\u0000${kind}`,
    "onboarding delivery checkpoint",
  );
  for (const row of data.onboardingDeliveryRecords) validateDelivery(row);

  uniqueSet(
    data.onboardingRoleOperations,
    ({ operationId }) => operationId,
    "onboarding role operation ID",
  );
  uniqueSet(
    data.onboardingRoleOperations,
    ({ memberId, roleId, kind, idempotencyKey }) =>
      `${memberId}\u0000${roleId}\u0000${kind}\u0000${idempotencyKey}`,
    "onboarding role operation",
  );
  const onboardingOperationsById = new Map(
    data.onboardingRoleOperations.map((operation) => [
      operation.operationId,
      operation,
    ]),
  );
  for (const row of data.onboardingRoleOperations) {
    if (row.roleId === guildId)
      throw new TypeError(
        "Imported onboarding role operation targets @everyone",
      );
    validateOperationState(
      row.state,
      row.failureCode,
      row.completedAt,
      "onboarding role operation",
    );
    validateOnboardingRoleOperationResolution(row, onboardingOperationsById);
  }

  uniqueSet(
    data.onboardingAuditEvents,
    ({ eventId }) => eventId,
    "onboarding audit event ID",
  );
  uniqueSet(
    data.onboardingAuditEvents,
    ({ eventNumber }) => String(eventNumber),
    "onboarding audit event number",
  );
  for (const row of data.onboardingAuditEvents)
    if (row.rulesVersion !== null)
      requireReference(
        ruleVersions,
        String(row.rulesVersion),
        "onboarding audit rules version",
      );

  const menuIds = uniqueSet(
    data.roleMenus,
    ({ menuId }) => menuId,
    "role menu ID",
  );
  const menusById = new Map(data.roleMenus.map((menu) => [menu.menuId, menu]));
  uniqueSet(data.roleMenus, ({ slug }) => slug, "role menu slug");
  uniqueSet(
    data.roleMenus,
    ({ sortOrder }) => String(sortOrder),
    "role menu position",
  );
  const menuPositions = data.roleMenus
    .map(({ sortOrder }) => sortOrder)
    .sort((left, right) => left - right);
  if (menuPositions.some((sortOrder, index) => sortOrder !== index)) {
    throw new TypeError("Imported role menu ordering is not contiguous");
  }
  for (const menu of data.roleMenus) {
    if (
      normalizeRoleMenuText(menu.title, 1, 256, "role-menu title") !==
        menu.title ||
      normalizeRoleMenuText(
        menu.description,
        1,
        1_000,
        "role-menu description",
      ) !== menu.description
    ) {
      throw new TypeError("Imported role menu text is not safely normalized");
    }
    if (
      menu.minSelections > menu.maxSelections ||
      (menu.mode === "exclusive" && menu.maxSelections !== 1)
    )
      throw new TypeError(
        "Imported role menu selection bounds are inconsistent",
      );
    if (menu.requiredRoleId === guildId)
      throw new TypeError(
        "Imported role menu prerequisite cannot be @everyone",
      );
    if ((menu.state === "enabled") !== (menu.bindingsVerifiedAt !== null))
      throw new TypeError("Imported role menu binding is inconsistent");
  }

  uniqueSet(
    data.roleMenuOptions,
    ({ menuId, optionId }) => `${menuId}\u0000${optionId}`,
    "role menu option ID",
  );
  uniqueSet(
    data.roleMenuOptions,
    ({ menuId, roleId }) => `${menuId}\u0000${roleId}`,
    "role menu option role",
  );
  uniqueSet(
    data.roleMenuOptions,
    ({ menuId, sortOrder }) => `${menuId}\u0000${sortOrder}`,
    "role menu option position",
  );
  for (const row of data.roleMenuOptions) {
    requireReference(menuIds, row.menuId, "role menu option menu");
    if (row.roleId === guildId)
      throw new TypeError("Imported self-service role cannot be @everyone");
    if (
      normalizeRoleMenuText(row.label, 1, 100, "option label") !== row.label ||
      (row.description !== null &&
        normalizeRoleMenuText(row.description, 1, 100, "option description") !==
          row.description) ||
      normalizeOptionalUnicodeEmoji(row.emoji, "Option emoji") !== row.emoji
    ) {
      throw new TypeError(
        "Imported role menu option text is not safely normalized",
      );
    }
  }
  for (const menuId of menuIds) {
    const menu = menusById.get(menuId)!;
    const optionCount = data.roleMenuOptions.filter(
      (row) => row.menuId === menuId,
    ).length;
    if (optionCount > 25)
      throw new RangeError("Imported role menu exceeds the option limit");
    if (
      menu.state === "enabled" &&
      (optionCount < 1 ||
        menu.minSelections > optionCount ||
        menu.maxSelections > optionCount)
    ) {
      throw new TypeError(
        "Imported enabled role menu has impossible option bounds",
      );
    }
  }

  uniqueSet(data.roleMenuPosts, ({ postId }) => postId, "role menu post ID");
  uniqueSet(
    data.roleMenuPosts,
    ({ channelId, messageId }) => `${channelId}\u0000${messageId}`,
    "role menu post message",
  );
  for (const post of data.roleMenuPosts) {
    requireReference(menuIds, post.menuId, "role menu post menu");
    const menu = menusById.get(post.menuId)!;
    if (post.definitionVersion > menu.definitionVersion) {
      throw new TypeError(
        "Imported role menu post definition is newer than its menu",
      );
    }
    if ((post.state === "active") !== (post.bindingsVerifiedAt !== null))
      throw new TypeError("Imported role menu post binding is inconsistent");
    if (
      post.state === "active" &&
      (menu.state !== "enabled" ||
        menu.bindingsVerifiedAt === null ||
        post.definitionVersion !== menu.definitionVersion)
    ) {
      throw new TypeError(
        "Imported active role menu post does not match the current enabled menu",
      );
    }
  }
  for (const menuId of menuIds) {
    if (
      data.roleMenuPosts.filter((post) => post.menuId === menuId).length > 100
    )
      throw new RangeError("Imported role menu exceeds the post limit");
  }

  uniqueSet(
    data.roleMenuOperations,
    ({ operationId }) => operationId,
    "role menu operation ID",
  );
  uniqueSet(
    data.roleMenuOperations,
    ({ interactionId }) => interactionId,
    "role menu interaction ID",
  );
  for (const operation of data.roleMenuOperations) {
    requireReference(menuIds, operation.menuId, "role menu operation menu");
    if (
      operation.definitionVersion >
      menusById.get(operation.menuId)!.definitionVersion
    ) {
      throw new TypeError(
        "Imported role menu operation definition is newer than its menu",
      );
    }
    validateOperationState(
      operation.state,
      operation.failureCode,
      operation.completedAt,
      "role menu operation",
    );
    uniqueSet(
      operation.items,
      ({ roleId }) => roleId,
      "role menu operation item role",
    );
    for (const item of operation.items) {
      if (
        item.guildId !== guildId ||
        item.operationId !== operation.operationId
      )
        throw new TypeError(
          "Imported role menu operation item has the wrong parent",
        );
      if (item.roleId === guildId)
        throw new TypeError(
          "Imported role menu operation item targets @everyone",
        );
      if (item.state === "failed" && item.failureCode === null)
        throw new TypeError(
          "Imported failed role menu item has no failure code",
        );
    }
    validateRoleMenuOperationItems(operation);
  }
  return data;
}

/** Reads portable lifecycle state. Claims are retained only as recoverable checkpoints. */
export function readPhase4GuildData(
  db: Database.Database,
  guildId: string,
): Phase4GuildData {
  type CollectionKey = Exclude<
    keyof Phase4GuildData,
    "onboardingConfiguration"
  >;
  const all = (
    collection: CollectionKey,
    sql: string,
  ): Array<Record<string, unknown>> => {
    const maximum = PHASE4_COLLECTION_LIMITS[collection];
    const rows = db
      .prepare(`${sql} LIMIT ?`)
      .all(guildId, maximum + 1) as Array<Record<string, unknown>>;
    if (rows.length > maximum)
      throw new RangeError(
        `Guild export ${collection} exceeds the ${maximum}-record safety limit`,
      );
    return rows;
  };
  const configurationRow = db
    .prepare(
      `SELECT configuration.*,
         welcome.title AS welcome_title, welcome.body AS welcome_body,
         farewell.title AS farewell_title, farewell.body AS farewell_body
       FROM onboarding_configurations AS configuration
       JOIN onboarding_message_templates AS welcome
         ON welcome.guild_id = configuration.guild_id AND welcome.template_kind = 'welcome'
       JOIN onboarding_message_templates AS farewell
         ON farewell.guild_id = configuration.guild_id AND farewell.template_kind = 'farewell'
       WHERE configuration.guild_id = ?`,
    )
    .get(guildId) as Record<string, unknown> | undefined;
  const operationRows = all(
    "roleMenuOperations",
    `SELECT * FROM role_menu_operations WHERE guild_id = ?
     ORDER BY created_at, operation_id`,
  );
  const itemRows = db
    .prepare(
      `SELECT * FROM role_menu_operation_items WHERE guild_id = ?
       ORDER BY operation_id, role_action, role_id LIMIT ?`,
    )
    .all(
      guildId,
      PHASE4_COLLECTION_LIMITS.roleMenuOperations * 25 + 1,
    ) as Array<Record<string, unknown>>;
  if (itemRows.length > PHASE4_COLLECTION_LIMITS.roleMenuOperations * 25)
    throw new RangeError(
      "Guild export role menu operation items exceeds the safety limit",
    );
  const itemsByOperation = new Map<string, RoleMenuOperationItem[]>();
  for (const row of itemRows) {
    const item = mapRoleMenuOperationItem(row);
    const items = itemsByOperation.get(item.operationId) ?? [];
    items.push(item);
    itemsByOperation.set(item.operationId, items);
  }
  return {
    onboardingConfiguration: configurationRow
      ? mapConfiguration(configurationRow)
      : null,
    onboardingRulesVersions: all(
      "onboardingRulesVersions",
      "SELECT * FROM onboarding_rules_versions WHERE guild_id = ? ORDER BY rules_version",
    ).map(mapRules),
    onboardingAutoroles: all(
      "onboardingAutoroles",
      "SELECT * FROM onboarding_autoroles WHERE guild_id = ? ORDER BY audience, sort_order, role_id",
    ).map(mapAutorole),
    memberOnboardingStates: all(
      "memberOnboardingStates",
      "SELECT * FROM member_onboarding_states WHERE guild_id = ? ORDER BY member_id",
    ).map(mapMemberState),
    memberRuleAcceptances: all(
      "memberRuleAcceptances",
      "SELECT * FROM member_rule_acceptances WHERE guild_id = ? ORDER BY member_id, rules_version",
    ).map(mapAcceptance),
    onboardingDeliveryRecords: all(
      "onboardingDeliveryRecords",
      "SELECT * FROM onboarding_delivery_records WHERE guild_id = ? ORDER BY created_at, delivery_id",
    ).map(mapDelivery),
    onboardingRoleOperations: all(
      "onboardingRoleOperations",
      "SELECT * FROM onboarding_role_operations WHERE guild_id = ? ORDER BY created_at, operation_id",
    ).map(mapOnboardingRoleOperation),
    onboardingAuditEvents: all(
      "onboardingAuditEvents",
      "SELECT * FROM onboarding_audit_events WHERE guild_id = ? ORDER BY event_number, event_id",
    ).map(mapAudit),
    roleMenus: all(
      "roleMenus",
      "SELECT * FROM role_menus WHERE guild_id = ? ORDER BY sort_order, menu_id",
    ).map(mapMenu),
    roleMenuOptions: all(
      "roleMenuOptions",
      "SELECT * FROM role_menu_options WHERE guild_id = ? ORDER BY menu_id, sort_order, option_id",
    ).map(mapMenuOption),
    roleMenuPosts: all(
      "roleMenuPosts",
      "SELECT * FROM role_menu_posts WHERE guild_id = ? ORDER BY menu_id, created_at, post_id",
    ).map(mapMenuPost),
    roleMenuOperations: operationRows.map((row) => {
      const operation = mapMenuOperation(row);
      return {
        ...operation,
        items: itemsByOperation.get(operation.operationId) ?? [],
      };
    }),
  };
}

/** Inserts validated format-8 history, then makes every Discord binding dormant. */
export function insertPhase4GuildData(
  db: Database.Database,
  guildId: string,
  imported: Phase4GuildData,
): void {
  for (const row of imported.onboardingRulesVersions)
    db.prepare(
      `INSERT INTO onboarding_rules_versions
       (guild_id, rules_version, title, body, reacceptance_requested, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      guildId,
      row.rulesVersion,
      row.title,
      row.body,
      flag(row.reacceptanceRequested),
      row.createdBy,
      row.createdAt,
    );
  if (imported.onboardingConfiguration)
    insertConfiguration(db, guildId, imported.onboardingConfiguration);
  const autoroleInsert = db.prepare(
    `INSERT INTO onboarding_autoroles
     (guild_id, audience, role_id, sort_order, enabled, bindings_verified_at,
      created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of imported.onboardingAutoroles)
    autoroleInsert.run(
      guildId,
      row.audience,
      row.roleId,
      row.sortOrder,
      flag(row.enabled),
      row.bindingsVerifiedAt,
      row.createdBy,
      row.updatedBy,
      row.createdAt,
      row.updatedAt,
    );
  insertMemberStates(db, guildId, imported.memberOnboardingStates);
  insertAcceptances(db, guildId, imported.memberRuleAcceptances);
  insertDeliveries(db, guildId, imported.onboardingDeliveryRecords);
  insertOnboardingRoleOperations(
    db,
    guildId,
    imported.onboardingRoleOperations,
  );
  insertAudits(db, guildId, imported.onboardingAuditEvents);
  insertMenus(db, guildId, imported.roleMenus);
  insertMenuOptions(db, guildId, imported.roleMenuOptions);
  insertMenuPosts(db, guildId, imported.roleMenuPosts);
  insertMenuOperations(db, guildId, imported.roleMenuOperations);
  deactivatePhase4Bindings(db, guildId);
}

export function deactivatePhase4Bindings(
  db: Database.Database,
  guildId: string,
): void {
  db.prepare(
    `UPDATE onboarding_configurations SET enabled = 0,
       welcome_public_enabled = 0, welcome_dm_enabled = 0,
       farewell_public_enabled = 0, verification_enabled = 0,
       human_autoroles_enabled = 0, bot_autoroles_enabled = 0,
       welcome_channel_verified_at = NULL,
       farewell_channel_verified_at = NULL,
       lifecycle_log_channel_verified_at = NULL,
       rules_channel_verified_at = NULL,
       verification_roles_verified_at = NULL
     WHERE guild_id = ?`,
  ).run(guildId);
  db.prepare(
    "UPDATE onboarding_autoroles SET enabled = 0, bindings_verified_at = NULL WHERE guild_id = ?",
  ).run(guildId);
  db.prepare(
    `UPDATE role_menus SET menu_state = CASE WHEN menu_state = 'archived'
       THEN 'archived' ELSE 'disabled' END, bindings_verified_at = NULL
     WHERE guild_id = ?`,
  ).run(guildId);
  db.prepare(
    `UPDATE role_menu_posts SET post_state = 'stale', bindings_verified_at = NULL
     WHERE guild_id = ?`,
  ).run(guildId);
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE onboarding_delivery_records SET delivery_state = 'skipped',
       failure_code = 'import-interrupted', claim_id = NULL,
       claim_expires_at = NULL, updated_at = ?
     WHERE guild_id = ? AND delivery_state = 'reserved'`,
  ).run(now, guildId);
  db.prepare(
    `UPDATE onboarding_role_operations SET operation_state = 'failed',
       failure_code = 'import-interrupted', completed_at = ?, updated_at = ?
     WHERE guild_id = ? AND operation_state = 'reserved'
       AND resolved_at IS NULL`,
  ).run(now, now, guildId);
  const reservedMenuOperations = db
    .prepare(
      "SELECT operation_id FROM role_menu_operations WHERE guild_id = ? AND operation_state = 'reserved'",
    )
    .all(guildId) as Array<{ operation_id: string }>;
  db.prepare(
    `UPDATE role_menu_operations
     SET operation_state = CASE WHEN EXISTS (
           SELECT 1 FROM role_menu_operation_items AS item
           WHERE item.guild_id = role_menu_operations.guild_id
             AND item.operation_id = role_menu_operations.operation_id
         ) THEN 'failed' ELSE 'no-change' END,
       failure_code = CASE WHEN EXISTS (
           SELECT 1 FROM role_menu_operation_items AS item
           WHERE item.guild_id = role_menu_operations.guild_id
             AND item.operation_id = role_menu_operations.operation_id
         ) THEN 'import-interrupted' ELSE NULL END,
       completed_at = ?, updated_at = ?
     WHERE guild_id = ? AND operation_state = 'reserved'`,
  ).run(now, now, guildId);
  const skipItem = db.prepare(
    `UPDATE role_menu_operation_items SET item_state = 'skipped'
     WHERE guild_id = ? AND operation_id = ? AND item_state = 'planned'`,
  );
  for (const { operation_id: operationId } of reservedMenuOperations)
    skipItem.run(guildId, operationId);
  deactivateImportedPanelBindings(db, guildId);
}

function validateConfiguration(
  value: OnboardingConfiguration | null,
  guildId: string,
): void {
  if (!value) return;
  const welcome = normalizeOnboardingTemplatePair(
    value.welcomeTitle,
    value.welcomeBody,
  );
  const farewell = normalizeOnboardingTemplatePair(
    value.farewellTitle,
    value.farewellBody,
  );
  if (
    welcome.title !== value.welcomeTitle ||
    welcome.body !== value.welcomeBody ||
    farewell.title !== value.farewellTitle ||
    farewell.body !== value.farewellBody
  ) {
    throw new TypeError("Imported onboarding templates are not normalized");
  }
  if (value.verifiedRoleId === guildId || value.unverifiedRoleId === guildId)
    throw new TypeError("Imported verification role cannot be @everyone");
  if (
    value.verifiedRoleId !== null &&
    value.verifiedRoleId === value.unverifiedRoleId
  )
    throw new TypeError("Imported verified and unverified roles must differ");
  if (
    value.welcomeChannelVerifiedAt !== null &&
    value.welcomeChannelId === null
  )
    throw new TypeError("Imported welcome binding has no channel");
  if (
    value.farewellChannelVerifiedAt !== null &&
    value.farewellChannelId === null
  )
    throw new TypeError("Imported farewell binding has no channel");
  if (
    value.lifecycleLogChannelVerifiedAt !== null &&
    value.lifecycleLogChannelId === null
  )
    throw new TypeError("Imported lifecycle-log binding has no channel");
  if (value.rulesChannelVerifiedAt !== null && value.rulesChannelId === null)
    throw new TypeError("Imported rules binding has no channel");
  if (
    value.verificationRolesVerifiedAt !== null &&
    value.verifiedRoleId === null
  ) {
    throw new TypeError("Imported verification binding has no verified role");
  }
  if (
    value.welcomePublicEnabled &&
    (!value.welcomeChannelId || !value.welcomeChannelVerifiedAt)
  )
    throw new TypeError(
      "Imported enabled welcome delivery requires a verified channel",
    );
  if (
    value.farewellPublicEnabled &&
    (!value.farewellChannelId || !value.farewellChannelVerifiedAt)
  )
    throw new TypeError(
      "Imported enabled farewell delivery requires a verified channel",
    );
  if (
    value.verificationEnabled &&
    (!value.currentRulesVersion ||
      !value.verifiedRoleId ||
      !value.verificationRolesVerifiedAt)
  )
    throw new TypeError(
      "Imported enabled verification requires verified rules and roles",
    );
}

function validateDelivery(row: OnboardingDeliveryRecord): void {
  if ((row.claimId === null) !== (row.claimExpiresAt === null))
    throw new TypeError("Imported onboarding delivery claim is inconsistent");
  if ((row.state === "reserved") !== (row.claimId !== null))
    throw new TypeError("Imported onboarding delivery state is inconsistent");
  if ((row.messageId === null) !== (row.deliveredAt === null))
    throw new TypeError(
      "Imported onboarding delivery checkpoint is inconsistent",
    );
  if (row.messageId !== null && row.channelId === null)
    throw new TypeError("Imported onboarding delivery message has no channel");
  if ((row.state === "delivered") !== (row.messageId !== null))
    throw new TypeError(
      "Imported onboarding delivery outcome and checkpoint are inconsistent",
    );
  if (
    (row.state === "failed" || row.state === "missing") &&
    row.failureCode === null
  ) {
    throw new TypeError(
      "Imported onboarding delivery outcome and failure metadata are inconsistent",
    );
  }
  if (
    (row.state === "reserved" || row.state === "delivered") &&
    row.failureCode !== null
  ) {
    throw new TypeError(
      "Imported onboarding delivery outcome and failure metadata are inconsistent",
    );
  }
  if (row.state !== "skipped" && row.attemptCount < 1) {
    throw new TypeError(
      "Imported onboarding delivery outcome and attempt count are inconsistent",
    );
  }
}

function validateOperationState(
  state: OnboardingRoleOperation["state"],
  failureCode: string | null,
  completedAt: string | null,
  label: string,
): void {
  if ((state === "reserved") !== (completedAt === null))
    throw new TypeError(`Imported ${label} completion is inconsistent`);
  if ((state === "failed" || state === "partial") !== (failureCode !== null)) {
    throw new TypeError(`Imported ${label} failure metadata is inconsistent`);
  }
}

function validateOnboardingRoleOperationResolution(
  operation: OnboardingRoleOperation,
  operationsById: ReadonlyMap<string, OnboardingRoleOperation>,
): void {
  if (
    (operation.resolvedAt === null) !==
    (operation.resolvedByOperationId === null)
  ) {
    throw new TypeError(
      "Imported onboarding role operation resolution metadata is inconsistent",
    );
  }
  if (operation.resolvedAt === null) return;
  const resolver = operationsById.get(operation.resolvedByOperationId!);
  if (
    (operation.state !== "reserved" &&
      operation.state !== "partial" &&
      operation.state !== "failed") ||
    operation.updatedAt !== operation.resolvedAt ||
    Date.parse(operation.createdAt) > Date.parse(operation.resolvedAt) ||
    !resolver ||
    resolver.operationId === operation.operationId ||
    resolver.memberId !== operation.memberId ||
    resolver.roleId !== operation.roleId ||
    resolver.kind !== operation.kind ||
    (resolver.state !== "completed" && resolver.state !== "no-change") ||
    resolver.failureCode !== null ||
    resolver.completedAt === null ||
    resolver.resolvedAt !== null ||
    !resolver.idempotencyKey.startsWith("recover:") ||
    Date.parse(resolver.completedAt) > Date.parse(operation.resolvedAt)
  ) {
    throw new TypeError(
      "Imported onboarding role operation recovery resolution is inconsistent",
    );
  }
}

function validateRoleMenuOperationItems(operation: RoleMenuOperation): void {
  const planned = operation.items.filter(({ state }) => state === "planned");
  const completed = operation.items.filter(
    ({ state }) => state === "completed",
  );
  const incomplete = operation.items.filter(
    ({ state }) => state === "failed" || state === "skipped",
  );
  const failureMetadataIsConsistent = operation.items.every((item) =>
    item.state === "failed"
      ? operation.failureCode !== null &&
        item.failureCode === operation.failureCode
      : item.failureCode === null,
  );
  const consistent =
    failureMetadataIsConsistent &&
    (operation.state === "reserved"
      ? operation.failureCode === null &&
        completed.length === 0 &&
        incomplete.length === 0
      : operation.state === "completed"
        ? operation.failureCode === null &&
          completed.length > 0 &&
          planned.length === 0 &&
          incomplete.length === 0
        : operation.state === "no-change"
          ? operation.failureCode === null && operation.items.length === 0
          : operation.state === "failed"
            ? planned.length === 0 &&
              completed.length === 0 &&
              incomplete.length > 0
            : planned.length === 0 &&
              completed.length > 0 &&
              incomplete.length > 0);
  if (!consistent) {
    throw new TypeError(
      "Imported role menu operation item outcomes are inconsistent",
    );
  }
}

function uniqueSet<T>(
  rows: readonly T[],
  key: (row: T) => string,
  label: string,
): Set<string> {
  const seen = new Set<string>();
  for (const row of rows) {
    const value = key(row);
    if (seen.has(value))
      throw new TypeError(`Guild import contains duplicate ${label}`);
    seen.add(value);
  }
  return seen;
}

function requireReference(
  known: Set<string>,
  value: string,
  label: string,
): void {
  if (!known.has(value)) throw new TypeError(`Imported ${label} is unknown`);
}

function tenantError(label: string): never {
  throw new TypeError(`Imported ${label} belongs to another guild`);
}

function flag(value: boolean): number {
  return value ? 1 : 0;
}

function asString(row: Record<string, unknown>, key: string): string {
  return String(row[key]);
}

function nullableString(
  row: Record<string, unknown>,
  key: string,
): string | null {
  return row[key] === null ? null : String(row[key]);
}

function mapConfiguration(
  row: Record<string, unknown>,
): OnboardingConfiguration {
  return {
    guildId: asString(row, "guild_id"),
    enabled: Boolean(row.enabled),
    welcomeChannelId: nullableString(row, "welcome_channel_id"),
    welcomePublicEnabled: Boolean(row.welcome_public_enabled),
    welcomeDmEnabled: Boolean(row.welcome_dm_enabled),
    farewellChannelId: nullableString(row, "farewell_channel_id"),
    farewellPublicEnabled: Boolean(row.farewell_public_enabled),
    lifecycleLogChannelId: nullableString(row, "lifecycle_log_channel_id"),
    rulesChannelId: nullableString(row, "rules_channel_id"),
    verificationEnabled: Boolean(row.verification_enabled),
    currentRulesVersion:
      row.current_rules_version === null
        ? null
        : Number(row.current_rules_version),
    verifiedRoleId: nullableString(row, "verified_role_id"),
    unverifiedRoleId: nullableString(row, "unverified_role_id"),
    humanAutorolesEnabled: Boolean(row.human_autoroles_enabled),
    botAutorolesEnabled: Boolean(row.bot_autoroles_enabled),
    accountAgeAlertHours:
      row.account_age_alert_hours === null
        ? null
        : Number(row.account_age_alert_hours),
    welcomeTitle: asString(row, "welcome_title"),
    welcomeBody: asString(row, "welcome_body"),
    farewellTitle: asString(row, "farewell_title"),
    farewellBody: asString(row, "farewell_body"),
    welcomeChannelVerifiedAt: nullableString(
      row,
      "welcome_channel_verified_at",
    ),
    farewellChannelVerifiedAt: nullableString(
      row,
      "farewell_channel_verified_at",
    ),
    lifecycleLogChannelVerifiedAt: nullableString(
      row,
      "lifecycle_log_channel_verified_at",
    ),
    rulesChannelVerifiedAt: nullableString(row, "rules_channel_verified_at"),
    verificationRolesVerifiedAt: nullableString(
      row,
      "verification_roles_verified_at",
    ),
    createdBy: asString(row, "created_by"),
    updatedBy: asString(row, "updated_by"),
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
  };
}

function mapRules(row: Record<string, unknown>): OnboardingRulesVersion {
  return {
    guildId: asString(row, "guild_id"),
    rulesVersion: Number(row.rules_version),
    title: asString(row, "title"),
    body: asString(row, "body"),
    reacceptanceRequested: Boolean(row.reacceptance_requested),
    createdBy: asString(row, "created_by"),
    createdAt: asString(row, "created_at"),
  };
}
function mapAutorole(row: Record<string, unknown>): OnboardingAutorole {
  return {
    guildId: asString(row, "guild_id"),
    audience: asString(row, "audience") as OnboardingAutorole["audience"],
    roleId: asString(row, "role_id"),
    sortOrder: Number(row.sort_order),
    enabled: Boolean(row.enabled),
    bindingsVerifiedAt: nullableString(row, "bindings_verified_at"),
    createdBy: asString(row, "created_by"),
    updatedBy: asString(row, "updated_by"),
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
  };
}
function mapMemberState(row: Record<string, unknown>): MemberOnboardingState {
  return {
    guildId: asString(row, "guild_id"),
    memberId: asString(row, "member_id"),
    memberKind: asString(
      row,
      "member_kind",
    ) as MemberOnboardingState["memberKind"],
    screeningState: asString(
      row,
      "screening_state",
    ) as MemberOnboardingState["screeningState"],
    lifecycleState: asString(
      row,
      "lifecycle_state",
    ) as MemberOnboardingState["lifecycleState"],
    joinedAt: asString(row, "joined_at"),
    accountCreatedAt: asString(row, "account_created_at"),
    screeningCompletedAt: nullableString(row, "screening_completed_at"),
    departedAt: nullableString(row, "departed_at"),
    lastProcessedAt: asString(row, "last_processed_at"),
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
  };
}
function mapAcceptance(row: Record<string, unknown>): MemberRuleAcceptance {
  return {
    guildId: asString(row, "guild_id"),
    memberId: asString(row, "member_id"),
    rulesVersion: Number(row.rules_version),
    acceptedAt: asString(row, "accepted_at"),
    panelPostId: nullableString(row, "panel_post_id"),
  };
}
function mapDelivery(row: Record<string, unknown>): OnboardingDeliveryRecord {
  return {
    guildId: asString(row, "guild_id"),
    deliveryId: asString(row, "delivery_id"),
    memberId: asString(row, "member_id"),
    joinInstance: asString(row, "join_instance"),
    kind: asString(row, "delivery_kind") as OnboardingDeliveryRecord["kind"],
    state: asString(row, "delivery_state") as OnboardingDeliveryRecord["state"],
    channelId: nullableString(row, "channel_id"),
    messageId: nullableString(row, "message_id"),
    attemptCount: Number(row.attempt_count),
    failureCode: nullableString(row, "failure_code"),
    claimId: nullableString(row, "claim_id"),
    claimExpiresAt: nullableString(row, "claim_expires_at"),
    deliveredAt: nullableString(row, "delivered_at"),
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
  };
}
function mapOnboardingRoleOperation(
  row: Record<string, unknown>,
): OnboardingRoleOperation {
  return {
    guildId: asString(row, "guild_id"),
    operationId: asString(row, "operation_id"),
    memberId: asString(row, "member_id"),
    roleId: asString(row, "role_id"),
    kind: asString(row, "operation_kind") as OnboardingRoleOperation["kind"],
    idempotencyKey: asString(row, "idempotency_key"),
    state: asString(row, "operation_state") as OnboardingRoleOperation["state"],
    failureCode: nullableString(row, "failure_code"),
    attemptCount: Number(row.attempt_count),
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
    completedAt: nullableString(row, "completed_at"),
    resolvedAt: nullableString(row, "resolved_at"),
    resolvedByOperationId: nullableString(row, "resolved_by_operation_id"),
  };
}
function mapAudit(row: Record<string, unknown>): OnboardingAuditEvent {
  return {
    guildId: asString(row, "guild_id"),
    eventId: asString(row, "event_id"),
    eventNumber: Number(row.event_number),
    eventType: asString(row, "event_type"),
    memberId: nullableString(row, "member_id"),
    actorId: nullableString(row, "actor_id"),
    rulesVersion: row.rules_version === null ? null : Number(row.rules_version),
    outcome: asString(row, "outcome"),
    details: JSON.parse(asString(row, "details_json")) as unknown,
    createdAt: asString(row, "created_at"),
  };
}
function mapMenu(row: Record<string, unknown>): RoleMenu {
  return {
    guildId: asString(row, "guild_id"),
    menuId: asString(row, "menu_id"),
    slug: asString(row, "slug"),
    title: asString(row, "title"),
    description: asString(row, "description"),
    sortOrder: Number(row.sort_order),
    state: asString(row, "menu_state") as RoleMenu["state"],
    mode: asString(row, "selection_mode") as RoleMenu["mode"],
    minSelections: Number(row.min_selections),
    maxSelections: Number(row.max_selections),
    requiredRoleId: nullableString(row, "required_role_id"),
    definitionVersion: Number(row.definition_version),
    bindingsVerifiedAt: nullableString(row, "bindings_verified_at"),
    createdBy: asString(row, "created_by"),
    updatedBy: asString(row, "updated_by"),
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
  };
}
function mapMenuOption(row: Record<string, unknown>): RoleMenuOption {
  return {
    guildId: asString(row, "guild_id"),
    menuId: asString(row, "menu_id"),
    optionId: asString(row, "option_id"),
    roleId: asString(row, "role_id"),
    label: asString(row, "label"),
    description: nullableString(row, "description"),
    emoji: nullableString(row, "emoji"),
    sortOrder: Number(row.sort_order),
    createdBy: asString(row, "created_by"),
    updatedBy: asString(row, "updated_by"),
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
  };
}
function mapMenuPost(row: Record<string, unknown>): RoleMenuPost {
  return {
    guildId: asString(row, "guild_id"),
    postId: asString(row, "post_id"),
    menuId: asString(row, "menu_id"),
    channelId: asString(row, "channel_id"),
    messageId: asString(row, "message_id"),
    definitionVersion: Number(row.definition_version),
    bindingsVerifiedAt: nullableString(row, "bindings_verified_at"),
    state: asString(row, "post_state") as RoleMenuPost["state"],
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
  };
}
function mapMenuOperation(
  row: Record<string, unknown>,
): Omit<RoleMenuOperation, "items"> {
  return {
    guildId: asString(row, "guild_id"),
    operationId: asString(row, "operation_id"),
    interactionId: asString(row, "interaction_id"),
    menuId: asString(row, "menu_id"),
    memberId: asString(row, "member_id"),
    definitionVersion: Number(row.definition_version),
    selectionKey: asString(row, "selection_key"),
    state: asString(row, "operation_state") as RoleMenuOperation["state"],
    failureCode: nullableString(row, "failure_code"),
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
    completedAt: nullableString(row, "completed_at"),
  };
}
function mapRoleMenuOperationItem(
  row: Record<string, unknown>,
): RoleMenuOperationItem {
  return {
    guildId: asString(row, "guild_id"),
    operationId: asString(row, "operation_id"),
    roleId: asString(row, "role_id"),
    action: asString(row, "role_action") as RoleMenuOperationItem["action"],
    state: asString(row, "item_state") as RoleMenuOperationItem["state"],
    failureCode: nullableString(row, "failure_code"),
  };
}

function insertConfiguration(
  db: Database.Database,
  guildId: string,
  row: OnboardingConfiguration,
): void {
  db.prepare(
    `INSERT INTO onboarding_configurations
     (guild_id, enabled, welcome_channel_id, welcome_public_enabled,
      welcome_dm_enabled, farewell_channel_id, farewell_public_enabled,
      lifecycle_log_channel_id, rules_channel_id, verification_enabled,
      current_rules_version, verified_role_id, unverified_role_id,
      human_autoroles_enabled, bot_autoroles_enabled, account_age_alert_hours,
      welcome_channel_verified_at, farewell_channel_verified_at,
      lifecycle_log_channel_verified_at, rules_channel_verified_at,
      verification_roles_verified_at, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    guildId,
    flag(row.enabled),
    row.welcomeChannelId,
    flag(row.welcomePublicEnabled),
    flag(row.welcomeDmEnabled),
    row.farewellChannelId,
    flag(row.farewellPublicEnabled),
    row.lifecycleLogChannelId,
    row.rulesChannelId,
    flag(row.verificationEnabled),
    row.currentRulesVersion,
    row.verifiedRoleId,
    row.unverifiedRoleId,
    flag(row.humanAutorolesEnabled),
    flag(row.botAutorolesEnabled),
    row.accountAgeAlertHours,
    row.welcomeChannelVerifiedAt,
    row.farewellChannelVerifiedAt,
    row.lifecycleLogChannelVerifiedAt,
    row.rulesChannelVerifiedAt,
    row.verificationRolesVerifiedAt,
    row.createdBy,
    row.updatedBy,
    row.createdAt,
    row.updatedAt,
  );
  const insertTemplate = db.prepare(
    `INSERT INTO onboarding_message_templates
     (guild_id, template_kind, title, body, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insertTemplate.run(
    guildId,
    "welcome",
    row.welcomeTitle,
    row.welcomeBody,
    row.createdAt,
    row.updatedAt,
  );
  insertTemplate.run(
    guildId,
    "farewell",
    row.farewellTitle,
    row.farewellBody,
    row.createdAt,
    row.updatedAt,
  );
}

function insertMemberStates(
  db: Database.Database,
  guildId: string,
  rows: readonly MemberOnboardingState[],
): void {
  const insert = db.prepare(`INSERT INTO member_onboarding_states
    (guild_id, member_id, member_kind, screening_state, lifecycle_state,
     joined_at, account_created_at, screening_completed_at, departed_at,
     last_processed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of rows)
    insert.run(
      guildId,
      row.memberId,
      row.memberKind,
      row.screeningState,
      row.lifecycleState,
      row.joinedAt,
      row.accountCreatedAt,
      row.screeningCompletedAt,
      row.departedAt,
      row.lastProcessedAt,
      row.createdAt,
      row.updatedAt,
    );
}
function insertAcceptances(
  db: Database.Database,
  guildId: string,
  rows: readonly MemberRuleAcceptance[],
): void {
  const insert = db.prepare(
    "INSERT INTO member_rule_acceptances (guild_id, member_id, rules_version, accepted_at, panel_post_id) VALUES (?, ?, ?, ?, ?)",
  );
  for (const row of rows)
    insert.run(
      guildId,
      row.memberId,
      row.rulesVersion,
      row.acceptedAt,
      row.panelPostId,
    );
}
function insertDeliveries(
  db: Database.Database,
  guildId: string,
  rows: readonly OnboardingDeliveryRecord[],
): void {
  const insert = db.prepare(`INSERT INTO onboarding_delivery_records
    (guild_id, delivery_id, member_id, join_instance, delivery_kind,
     delivery_state, channel_id, message_id, attempt_count, failure_code,
     claim_id, claim_expires_at, delivered_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of rows)
    insert.run(
      guildId,
      row.deliveryId,
      row.memberId,
      row.joinInstance,
      row.kind,
      row.state,
      row.channelId,
      row.messageId,
      row.attemptCount,
      row.failureCode,
      row.claimId,
      row.claimExpiresAt,
      row.deliveredAt,
      row.createdAt,
      row.updatedAt,
    );
}
function insertOnboardingRoleOperations(
  db: Database.Database,
  guildId: string,
  rows: readonly OnboardingRoleOperation[],
): void {
  const insert = db.prepare(`INSERT INTO onboarding_role_operations
    (guild_id, operation_id, member_id, role_id, operation_kind,
     idempotency_key, operation_state, failure_code, attempt_count,
     created_at, updated_at, completed_at, resolved_at,
     resolved_by_operation_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`);
  for (const row of rows)
    insert.run(
      guildId,
      row.operationId,
      row.memberId,
      row.roleId,
      row.kind,
      row.idempotencyKey,
      row.state,
      row.failureCode,
      row.attemptCount,
      row.createdAt,
      row.updatedAt,
      row.completedAt,
    );
  const resolve = db.prepare(
    `UPDATE onboarding_role_operations
     SET resolved_at = ?, resolved_by_operation_id = ?
     WHERE guild_id = ? AND operation_id = ?`,
  );
  for (const row of rows) {
    if (row.resolvedAt !== null) {
      resolve.run(
        row.resolvedAt,
        row.resolvedByOperationId,
        guildId,
        row.operationId,
      );
    }
  }
}
function insertAudits(
  db: Database.Database,
  guildId: string,
  rows: readonly OnboardingAuditEvent[],
): void {
  const insert = db.prepare(`INSERT INTO onboarding_audit_events
    (guild_id, event_id, event_number, event_type, member_id, actor_id,
     rules_version, outcome, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of rows)
    insert.run(
      guildId,
      row.eventId,
      row.eventNumber,
      row.eventType,
      row.memberId,
      row.actorId,
      row.rulesVersion,
      row.outcome,
      serializeJson(row.details, 4_000),
      row.createdAt,
    );
}
function insertMenus(
  db: Database.Database,
  guildId: string,
  rows: readonly RoleMenu[],
): void {
  const insert = db.prepare(`INSERT INTO role_menus
    (guild_id, menu_id, slug, title, description, sort_order, menu_state, selection_mode,
     min_selections, max_selections, required_role_id, definition_version,
     bindings_verified_at, created_by, updated_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of rows)
    insert.run(
      guildId,
      row.menuId,
      row.slug,
      row.title,
      row.description,
      row.sortOrder,
      row.state,
      row.mode,
      row.minSelections,
      row.maxSelections,
      row.requiredRoleId,
      row.definitionVersion,
      row.bindingsVerifiedAt,
      row.createdBy,
      row.updatedBy,
      row.createdAt,
      row.updatedAt,
    );
}
function insertMenuOptions(
  db: Database.Database,
  guildId: string,
  rows: readonly RoleMenuOption[],
): void {
  const insert = db.prepare(`INSERT INTO role_menu_options
    (guild_id, menu_id, option_id, role_id, label, description, emoji,
     sort_order, created_by, updated_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of rows)
    insert.run(
      guildId,
      row.menuId,
      row.optionId,
      row.roleId,
      row.label,
      row.description,
      row.emoji,
      row.sortOrder,
      row.createdBy,
      row.updatedBy,
      row.createdAt,
      row.updatedAt,
    );
}
function insertMenuPosts(
  db: Database.Database,
  guildId: string,
  rows: readonly RoleMenuPost[],
): void {
  const insert = db.prepare(`INSERT INTO role_menu_posts
    (guild_id, post_id, menu_id, channel_id, message_id, definition_version,
     bindings_verified_at, post_state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of rows)
    insert.run(
      guildId,
      row.postId,
      row.menuId,
      row.channelId,
      row.messageId,
      row.definitionVersion,
      row.bindingsVerifiedAt,
      row.state,
      row.createdAt,
      row.updatedAt,
    );
}
function insertMenuOperations(
  db: Database.Database,
  guildId: string,
  rows: readonly RoleMenuOperation[],
): void {
  const insertOperation = db.prepare(`INSERT INTO role_menu_operations
    (guild_id, operation_id, interaction_id, menu_id, member_id,
     definition_version, selection_key, operation_state, failure_code,
     created_at, updated_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertItem = db.prepare(`INSERT INTO role_menu_operation_items
    (guild_id, operation_id, role_id, role_action, item_state, failure_code)
    VALUES (?, ?, ?, ?, ?, ?)`);
  for (const row of rows) {
    insertOperation.run(
      guildId,
      row.operationId,
      row.interactionId,
      row.menuId,
      row.memberId,
      row.definitionVersion,
      row.selectionKey,
      row.state,
      row.failureCode,
      row.createdAt,
      row.updatedAt,
      row.completedAt,
    );
    for (const item of row.items)
      insertItem.run(
        guildId,
        row.operationId,
        item.roleId,
        item.action,
        item.state,
        item.failureCode,
      );
  }
}

function deactivateImportedPanelBindings(
  db: Database.Database,
  guildId: string,
): void {
  const rows = db
    .prepare(
      "SELECT panel_id, configuration_json FROM posted_panels WHERE guild_id = ? AND preset IN ('verification', 'roles')",
    )
    .all(guildId) as Array<{ panel_id: string; configuration_json: string }>;
  const update = db.prepare(
    "UPDATE posted_panels SET configuration_json = ? WHERE guild_id = ? AND panel_id = ?",
  );
  for (const row of rows) {
    let configuration: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.configuration_json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        configuration = parsed as Record<string, unknown>;
    } catch {
      configuration = {};
    }
    configuration.bindingsVerifiedAt = null;
    update.run(serializeJson(configuration, 16_000), guildId, row.panel_id);
  }
}

function serializeJson(value: unknown, maximumBytes: number): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError("Imported bounded metadata must be JSON-safe");
  }
  if (
    !serialized ||
    serialized.length < 2 ||
    Buffer.byteLength(serialized, "utf8") > maximumBytes
  )
    throw new RangeError(
      `Imported bounded metadata exceeds ${maximumBytes} bytes`,
    );
  return serialized;
}

function boundedJson(value: unknown, maximumBytes: number): boolean {
  try {
    const serialized = JSON.stringify(value);
    return Boolean(
      serialized &&
      serialized.length >= 2 &&
      Buffer.byteLength(serialized, "utf8") <= maximumBytes,
    );
  } catch {
    return false;
  }
}
