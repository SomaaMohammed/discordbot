import { isDeepStrictEqual } from "node:util";
import type { DatabaseConnection } from "./database.js";
import { assertDiscordSnowflake } from "../guild-settings.js";
import { normalizeOnboardingTemplatePair } from "../discord/onboarding-template.js";
import {
  normalizeRulesBody,
  normalizeRulesTitle,
} from "../discord/verification-components.js";
import type {
  MemberOnboardingLifecycleState,
  MemberOnboardingState,
  MemberOnboardingStateInput,
  MemberRuleAcceptance,
  MemberRuleAcceptanceInput,
  MemberRuleAcceptanceResult,
  OnboardingAuditEvent,
  OnboardingAuditEventInput,
  OnboardingAutorole,
  OnboardingAutoroleAudience,
  OnboardingAutoroleInput,
  OnboardingConfiguration,
  OnboardingConfigurationInput,
  OnboardingDeliveryCompletionInput,
  OnboardingDeliveryKind,
  OnboardingDeliveryRecord,
  OnboardingDeliveryReservationInput,
  OnboardingDeliveryReservationResult,
  OnboardingDeliveryState,
  OnboardingRoleOperation,
  OnboardingRoleOperationCompletionInput,
  OnboardingRoleOperationKind,
  OnboardingRoleOperationReservationInput,
  OnboardingRoleOperationReservationResult,
  OnboardingRulesActivationInput,
  OnboardingRulesActivationResult,
  OnboardingRulesVersion,
  OnboardingRulesVersionInput,
  OnboardingScreeningState,
  RoleOperationState,
} from "../types.js";
import {
  MEMBER_ONBOARDING_LIFECYCLE_STATES,
  ONBOARDING_AUTOROLE_AUDIENCES,
  ONBOARDING_DELIVERY_KINDS,
  ONBOARDING_DELIVERY_STATES,
  ONBOARDING_ROLE_OPERATION_KINDS,
  ONBOARDING_SCREENING_STATES,
  ROLE_OPERATION_STATES,
} from "../types.js";
import type {
  OnboardingLifecycleDefinitionSnapshot,
  OnboardingRepository as OnboardingRepositoryContract,
  StoredOnboardingPanel,
} from "../discord/onboarding-repository.js";
import { commandMetricKey } from "./metric-keys.js";
import {
  createOpaqueStorageId,
  GuildOperationalRepository,
} from "./operational-repository.js";

export const MAX_ONBOARDING_RULE_VERSIONS = 25;
export const MAX_ONBOARDING_AUTOROLES_PER_AUDIENCE = 10;
export const MAX_ONBOARDING_MEMBER_STATES = 100_000;
export const MAX_ONBOARDING_ACCEPTANCES = 100_000;
export const MAX_ONBOARDING_DELIVERIES = 100_000;
export const MAX_ONBOARDING_ROLE_OPERATIONS = 200_000;
export const MAX_ONBOARDING_AUDIT_EVENTS = 10_000;

const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;
const MAX_SAFE_INTEGER = 9_007_199_254_740_991;

interface OnboardingConfigurationRow {
  guild_id: string;
  enabled: number;
  welcome_channel_id: string | null;
  welcome_public_enabled: number;
  welcome_dm_enabled: number;
  farewell_channel_id: string | null;
  farewell_public_enabled: number;
  lifecycle_log_channel_id: string | null;
  rules_channel_id: string | null;
  verification_enabled: number;
  current_rules_version: number | null;
  verified_role_id: string | null;
  unverified_role_id: string | null;
  human_autoroles_enabled: number;
  bot_autoroles_enabled: number;
  account_age_alert_hours: number | null;
  welcome_channel_verified_at: string | null;
  farewell_channel_verified_at: string | null;
  lifecycle_log_channel_verified_at: string | null;
  rules_channel_verified_at: string | null;
  verification_roles_verified_at: string | null;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  welcome_title: string | null;
  welcome_body: string | null;
  farewell_title: string | null;
  farewell_body: string | null;
}

interface OnboardingRulesVersionRow {
  guild_id: string;
  rules_version: number;
  title: string;
  body: string;
  reacceptance_requested: number;
  created_by: string;
  created_at: string;
}

interface OnboardingAutoroleRow {
  guild_id: string;
  audience: string;
  role_id: string;
  sort_order: number;
  enabled: number;
  bindings_verified_at: string | null;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

interface MemberOnboardingStateRow {
  guild_id: string;
  member_id: string;
  member_kind: string;
  screening_state: string;
  lifecycle_state: string;
  joined_at: string;
  account_created_at: string;
  screening_completed_at: string | null;
  departed_at: string | null;
  last_processed_at: string;
  created_at: string;
  updated_at: string;
}

interface MemberRuleAcceptanceRow {
  guild_id: string;
  member_id: string;
  rules_version: number;
  accepted_at: string;
  panel_post_id: string | null;
}

interface OnboardingDeliveryRow {
  guild_id: string;
  delivery_id: string;
  member_id: string;
  join_instance: string;
  delivery_kind: string;
  delivery_state: string;
  channel_id: string | null;
  message_id: string | null;
  attempt_count: number;
  failure_code: string | null;
  claim_id: string | null;
  claim_expires_at: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
}

interface OnboardingRoleOperationRow {
  guild_id: string;
  operation_id: string;
  member_id: string;
  role_id: string;
  operation_kind: string;
  idempotency_key: string;
  operation_state: string;
  failure_code: string | null;
  attempt_count: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  resolved_at: string | null;
  resolved_by_operation_id: string | null;
}

interface OnboardingAuditEventRow {
  guild_id: string;
  event_id: string;
  event_number: number;
  event_type: string;
  member_id: string | null;
  actor_id: string | null;
  rules_version: number | null;
  outcome: string;
  details_json: string;
  created_at: string;
}

/** Tenant-bound persistence for onboarding configuration and lifecycle work. */
export class OnboardingStorageRepository implements OnboardingRepositoryContract {
  private readonly operational: GuildOperationalRepository;

  public constructor(
    private readonly db: DatabaseConnection,
    public readonly guildId: string,
  ) {
    this.operational = new GuildOperationalRepository(db, guildId);
  }

  public getOnboardingConfiguration(): OnboardingConfiguration | null {
    const row = this.db
      .prepare(
        `SELECT c.*,
           welcome.title AS welcome_title,
           welcome.body AS welcome_body,
           farewell.title AS farewell_title,
           farewell.body AS farewell_body
         FROM onboarding_configurations AS c
         LEFT JOIN onboarding_message_templates AS welcome
           ON welcome.guild_id = c.guild_id AND welcome.template_kind = 'welcome'
         LEFT JOIN onboarding_message_templates AS farewell
           ON farewell.guild_id = c.guild_id AND farewell.template_kind = 'farewell'
         WHERE c.guild_id = ?`,
      )
      .get(this.guildId) as OnboardingConfigurationRow | undefined;
    return row ? parseOnboardingConfiguration(row) : null;
  }

  public isOnboardingLifecycleDefinitionCurrent(
    snapshot: OnboardingLifecycleDefinitionSnapshot,
  ): boolean {
    if (snapshot.configuration.guildId !== this.guildId) return false;
    if (
      !isDeepStrictEqual(
        this.getOnboardingConfiguration(),
        snapshot.configuration,
      )
    ) {
      return false;
    }
    const expectedAutoroles = snapshot.autoroles;
    if (!expectedAutoroles) return true;
    if (
      expectedAutoroles.roles.some(
        (role) =>
          role.guildId !== this.guildId ||
          role.audience !== expectedAutoroles.audience,
      )
    ) {
      return false;
    }
    return isDeepStrictEqual(
      this.listOnboardingAutoroles(expectedAutoroles.audience),
      expectedAutoroles.roles,
    );
  }

  public upsertOnboardingConfiguration(
    input: OnboardingConfigurationInput,
  ): OnboardingConfiguration {
    const normalized = normalizeOnboardingConfigurationInput(
      input,
      this.guildId,
    );
    let result: OnboardingConfiguration | null = null;
    const upsert = this.db.transaction(() => {
      if (
        normalized.currentRulesVersion !== null &&
        !this.getOnboardingRulesVersion(normalized.currentRulesVersion)
      ) {
        throw new TypeError(
          "Current rules version does not exist in this guild",
        );
      }
      const verificationRoleIds = [
        normalized.verifiedRoleId,
        normalized.unverifiedRoleId,
      ].filter((roleId): roleId is string => roleId !== null);
      if (verificationRoleIds.length > 0) {
        const placeholders = verificationRoleIds.map(() => "?").join(", ");
        const conflict = this.db
          .prepare(
            `SELECT role_id FROM onboarding_autoroles
             WHERE guild_id = ? AND role_id IN (${placeholders}) LIMIT 1`,
          )
          .get(this.guildId, ...verificationRoleIds) as
          { role_id: string } | undefined;
        if (conflict) {
          throw new TypeError(
            `Verification role ${conflict.role_id} is already configured as an automatic role`,
          );
        }
      }
      const current = this.getOnboardingConfiguration();
      const now = utcNow();
      this.db
        .prepare(
          `INSERT INTO onboarding_configurations (
             guild_id, enabled, welcome_channel_id, welcome_public_enabled,
             welcome_dm_enabled, farewell_channel_id, farewell_public_enabled,
             lifecycle_log_channel_id, rules_channel_id, verification_enabled,
             current_rules_version, verified_role_id, unverified_role_id,
             human_autoroles_enabled, bot_autoroles_enabled,
             account_age_alert_hours, welcome_channel_verified_at,
             farewell_channel_verified_at, lifecycle_log_channel_verified_at,
             rules_channel_verified_at, verification_roles_verified_at,
             created_by, updated_by, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(guild_id) DO UPDATE SET
             enabled = excluded.enabled,
             welcome_channel_id = excluded.welcome_channel_id,
             welcome_public_enabled = excluded.welcome_public_enabled,
             welcome_dm_enabled = excluded.welcome_dm_enabled,
             farewell_channel_id = excluded.farewell_channel_id,
             farewell_public_enabled = excluded.farewell_public_enabled,
             lifecycle_log_channel_id = excluded.lifecycle_log_channel_id,
             rules_channel_id = excluded.rules_channel_id,
             verification_enabled = excluded.verification_enabled,
             current_rules_version = excluded.current_rules_version,
             verified_role_id = excluded.verified_role_id,
             unverified_role_id = excluded.unverified_role_id,
             human_autoroles_enabled = excluded.human_autoroles_enabled,
             bot_autoroles_enabled = excluded.bot_autoroles_enabled,
             account_age_alert_hours = excluded.account_age_alert_hours,
             welcome_channel_verified_at = excluded.welcome_channel_verified_at,
             farewell_channel_verified_at = excluded.farewell_channel_verified_at,
             lifecycle_log_channel_verified_at = excluded.lifecycle_log_channel_verified_at,
             rules_channel_verified_at = excluded.rules_channel_verified_at,
             verification_roles_verified_at = excluded.verification_roles_verified_at,
             updated_by = excluded.updated_by,
             updated_at = excluded.updated_at`,
        )
        .run(
          this.guildId,
          toSqlBoolean(normalized.enabled),
          normalized.welcomeChannelId,
          toSqlBoolean(normalized.welcomePublicEnabled),
          toSqlBoolean(normalized.welcomeDmEnabled),
          normalized.farewellChannelId,
          toSqlBoolean(normalized.farewellPublicEnabled),
          normalized.lifecycleLogChannelId,
          normalized.rulesChannelId,
          toSqlBoolean(normalized.verificationEnabled),
          normalized.currentRulesVersion,
          normalized.verifiedRoleId,
          normalized.unverifiedRoleId,
          toSqlBoolean(normalized.humanAutorolesEnabled),
          toSqlBoolean(normalized.botAutorolesEnabled),
          normalized.accountAgeAlertHours,
          normalized.welcomeChannelVerifiedAt,
          normalized.farewellChannelVerifiedAt,
          normalized.lifecycleLogChannelVerifiedAt,
          normalized.rulesChannelVerifiedAt,
          normalized.verificationRolesVerifiedAt,
          current?.createdBy ?? normalized.actorId,
          normalized.actorId,
          current?.createdAt ?? now,
          now,
        );
      const upsertTemplate = this.db.prepare(
        `INSERT INTO onboarding_message_templates (
           guild_id, template_kind, title, body, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(guild_id, template_kind) DO UPDATE SET
           title = excluded.title, body = excluded.body,
           updated_at = excluded.updated_at`,
      );
      upsertTemplate.run(
        this.guildId,
        "welcome",
        normalized.welcomeTitle,
        normalized.welcomeBody,
        current?.createdAt ?? now,
        now,
      );
      upsertTemplate.run(
        this.guildId,
        "farewell",
        normalized.farewellTitle,
        normalized.farewellBody,
        current?.createdAt ?? now,
        now,
      );
      result = this.requireOnboardingConfiguration();
    });
    upsert.immediate();
    return requireResult<OnboardingConfiguration>(
      result,
      "Onboarding configuration update",
    );
  }

  public disableOnboardingConfiguration(
    actorId: string,
  ): OnboardingConfiguration | null {
    const actor = assertDiscordSnowflake(actorId, "actor ID");
    const current = this.getOnboardingConfiguration();
    if (!current) return null;
    if (
      !current.enabled &&
      !current.welcomePublicEnabled &&
      !current.welcomeDmEnabled &&
      !current.farewellPublicEnabled &&
      !current.verificationEnabled &&
      !current.humanAutorolesEnabled &&
      !current.botAutorolesEnabled
    ) {
      return current;
    }
    this.db
      .prepare(
        `UPDATE onboarding_configurations
         SET enabled = 0, welcome_public_enabled = 0, welcome_dm_enabled = 0,
             farewell_public_enabled = 0, verification_enabled = 0,
             human_autoroles_enabled = 0, bot_autoroles_enabled = 0,
             updated_by = ?, updated_at = ?
         WHERE guild_id = ?`,
      )
      .run(actor, utcNow(), this.guildId);
    return this.requireOnboardingConfiguration();
  }

  public createOnboardingRulesVersion(
    input: OnboardingRulesVersionInput,
  ): OnboardingRulesVersion {
    const normalized = normalizeRulesVersionInput(input);
    let result: OnboardingRulesVersion | null = null;
    const create = this.db.transaction(() => {
      const count = this.countOnboardingRulesVersions();
      if (count >= MAX_ONBOARDING_RULE_VERSIONS) {
        throw new RangeError(
          `A guild retains at most ${MAX_ONBOARDING_RULE_VERSIONS} rules versions`,
        );
      }
      const numberRow = this.db
        .prepare(
          `SELECT COALESCE(MAX(rules_version), 0) + 1 AS next_version
           FROM onboarding_rules_versions WHERE guild_id = ?`,
        )
        .get(this.guildId) as { next_version: number };
      const rulesVersion = normalizeInteger(
        Number(numberRow.next_version),
        1,
        2_147_483_647,
        "rules version",
      );
      this.db
        .prepare(
          `INSERT INTO onboarding_rules_versions (
             guild_id, rules_version, title, body, reacceptance_requested,
             created_by, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.guildId,
          rulesVersion,
          normalized.title,
          normalized.body,
          toSqlBoolean(normalized.reacceptanceRequested),
          normalized.actorId,
          utcNow(),
        );
      result = this.requireOnboardingRulesVersion(rulesVersion);
    });
    create.immediate();
    return requireResult<OnboardingRulesVersion>(
      result,
      "Rules version creation",
    );
  }

  public createAndActivateOnboardingRulesVersion(
    input: OnboardingRulesActivationInput,
  ): OnboardingRulesActivationResult {
    if (!input || typeof input !== "object") {
      throw new TypeError("Rules activation input must be an object");
    }
    const rulesActor = assertDiscordSnowflake(input.rules.actorId, "actor ID");
    const configurationActor = assertDiscordSnowflake(
      input.configuration.actorId,
      "configuration actor ID",
    );
    if (rulesActor !== configurationActor) {
      throw new TypeError("Rules and configuration actors must match");
    }
    let result: OnboardingRulesActivationResult | null = null;
    const activate = this.db.transaction(() => {
      const rules = this.createOnboardingRulesVersion(input.rules);
      const configuration = this.upsertOnboardingConfiguration({
        ...input.configuration,
        currentRulesVersion: rules.rulesVersion,
      });
      result = { rules, configuration };
    });
    activate.immediate();
    return requireResult<OnboardingRulesActivationResult>(
      result,
      "Rules version activation",
    );
  }

  public getOnboardingRulesVersion(
    rulesVersion: number,
  ): OnboardingRulesVersion | null {
    const version = normalizeInteger(
      rulesVersion,
      1,
      2_147_483_647,
      "rules version",
    );
    const row = this.db
      .prepare(
        `SELECT * FROM onboarding_rules_versions
         WHERE guild_id = ? AND rules_version = ?`,
      )
      .get(this.guildId, version) as OnboardingRulesVersionRow | undefined;
    return row ? parseOnboardingRulesVersion(row) : null;
  }

  public getCurrentOnboardingRulesVersion(): OnboardingRulesVersion | null {
    const row = this.db
      .prepare(
        `SELECT r.* FROM onboarding_rules_versions AS r
         INNER JOIN onboarding_configurations AS c
           ON c.guild_id = r.guild_id
          AND c.current_rules_version = r.rules_version
         WHERE r.guild_id = ?`,
      )
      .get(this.guildId) as OnboardingRulesVersionRow | undefined;
    return row ? parseOnboardingRulesVersion(row) : null;
  }

  public listOnboardingRulesVersions(
    limit = MAX_ONBOARDING_RULE_VERSIONS,
    offset = 0,
  ): OnboardingRulesVersion[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM onboarding_rules_versions WHERE guild_id = ?
           ORDER BY rules_version DESC LIMIT ? OFFSET ?`,
        )
        .all(
          this.guildId,
          normalizeListLimit(limit, MAX_ONBOARDING_RULE_VERSIONS),
          normalizeOffset(offset),
        ) as OnboardingRulesVersionRow[]
    ).map(parseOnboardingRulesVersion);
  }

  public countOnboardingRulesVersions(): number {
    return this.countRows("onboarding_rules_versions");
  }

  public replaceOnboardingAutoroles(
    audience: OnboardingAutoroleAudience,
    roles: readonly OnboardingAutoroleInput[],
    actorId: string,
  ): OnboardingAutorole[] {
    const normalizedAudience = normalizeAutoroleAudience(audience);
    const actor = assertDiscordSnowflake(actorId, "actor ID");
    const normalizedRoles = normalizeAutoroleInputs(roles, this.guildId);
    let result: OnboardingAutorole[] | null = null;
    const replace = this.db.transaction(() => {
      if (normalizedRoles.length > 0) {
        const roleIds = normalizedRoles.map((role) => role.roleId);
        const placeholders = roleIds.map(() => "?").join(", ");
        const conflict = this.db
          .prepare(
            `SELECT role_id FROM onboarding_autoroles
             WHERE guild_id = ? AND audience <> ?
               AND role_id IN (${placeholders}) LIMIT 1`,
          )
          .get(this.guildId, normalizedAudience, ...roleIds) as
          { role_id: string } | undefined;
        if (conflict) {
          throw new TypeError(
            `Role ${conflict.role_id} is already configured for the other audience`,
          );
        }
        const configuration = this.getOnboardingConfiguration();
        const verificationConflict = roleIds.find(
          (roleId) =>
            roleId === configuration?.verifiedRoleId ||
            roleId === configuration?.unverifiedRoleId,
        );
        if (verificationConflict) {
          throw new TypeError(
            `Automatic role ${verificationConflict} is already configured for verification`,
          );
        }
      }
      const existing = new Map(
        this.listOnboardingAutoroles(normalizedAudience).map((role) => [
          role.roleId,
          role,
        ]),
      );
      this.db
        .prepare(
          "DELETE FROM onboarding_autoroles WHERE guild_id = ? AND audience = ?",
        )
        .run(this.guildId, normalizedAudience);
      const insert = this.db.prepare(
        `INSERT INTO onboarding_autoroles (
           guild_id, audience, role_id, sort_order, enabled,
           bindings_verified_at, created_by, updated_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const now = utcNow();
      normalizedRoles.forEach((role, sortOrder) => {
        const previous = existing.get(role.roleId);
        insert.run(
          this.guildId,
          normalizedAudience,
          role.roleId,
          sortOrder,
          toSqlBoolean(role.enabled),
          role.bindingsVerifiedAt,
          previous?.createdBy ?? actor,
          actor,
          previous?.createdAt ?? now,
          now,
        );
      });
      result = this.listOnboardingAutoroles(normalizedAudience);
    });
    replace.immediate();
    return requireResult<OnboardingAutorole[]>(
      result,
      "Onboarding autorole replacement",
    );
  }

  public listOnboardingAutoroles(
    audience?: OnboardingAutoroleAudience,
    limit = audience === undefined
      ? MAX_ONBOARDING_AUTOROLES_PER_AUDIENCE * 2
      : MAX_ONBOARDING_AUTOROLES_PER_AUDIENCE,
    offset = 0,
  ): OnboardingAutorole[] {
    const boundedLimit = normalizeListLimit(
      limit,
      MAX_ONBOARDING_AUTOROLES_PER_AUDIENCE * 2,
    );
    const boundedOffset = normalizeOffset(offset);
    if (audience === undefined) {
      return (
        this.db
          .prepare(
            `SELECT * FROM onboarding_autoroles WHERE guild_id = ?
             ORDER BY audience, sort_order, role_id LIMIT ? OFFSET ?`,
          )
          .all(
            this.guildId,
            boundedLimit,
            boundedOffset,
          ) as OnboardingAutoroleRow[]
      ).map(parseOnboardingAutorole);
    }
    return (
      this.db
        .prepare(
          `SELECT * FROM onboarding_autoroles
           WHERE guild_id = ? AND audience = ?
           ORDER BY sort_order, role_id LIMIT ? OFFSET ?`,
        )
        .all(
          this.guildId,
          normalizeAutoroleAudience(audience),
          boundedLimit,
          boundedOffset,
        ) as OnboardingAutoroleRow[]
    ).map(parseOnboardingAutorole);
  }

  public getMemberOnboardingState(
    memberId: string,
  ): MemberOnboardingState | null {
    const member = assertDiscordSnowflake(memberId, "member ID");
    const row = this.db
      .prepare(
        `SELECT * FROM member_onboarding_states
         WHERE guild_id = ? AND member_id = ?`,
      )
      .get(this.guildId, member) as MemberOnboardingStateRow | undefined;
    return row ? parseMemberOnboardingState(row) : null;
  }

  public upsertMemberOnboardingState(
    input: MemberOnboardingStateInput,
  ): MemberOnboardingState {
    const normalized = normalizeMemberOnboardingStateInput(input);
    let result: MemberOnboardingState | null = null;
    const upsert = this.db.transaction(() => {
      const current = this.getMemberOnboardingState(normalized.memberId);
      if (!current) this.makeMemberStateCapacity();
      const now = utcNow();
      this.db
        .prepare(
          `INSERT INTO member_onboarding_states (
             guild_id, member_id, member_kind, screening_state,
             lifecycle_state, joined_at, account_created_at,
             screening_completed_at, departed_at, last_processed_at,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(guild_id, member_id) DO UPDATE SET
             member_kind = excluded.member_kind,
             screening_state = excluded.screening_state,
             lifecycle_state = excluded.lifecycle_state,
             joined_at = excluded.joined_at,
             account_created_at = excluded.account_created_at,
             screening_completed_at = excluded.screening_completed_at,
             departed_at = excluded.departed_at,
             last_processed_at = excluded.last_processed_at,
             updated_at = excluded.updated_at`,
        )
        .run(
          this.guildId,
          normalized.memberId,
          normalized.memberKind,
          normalized.screeningState,
          normalized.lifecycleState,
          normalized.joinedAt,
          normalized.accountCreatedAt,
          normalized.screeningCompletedAt,
          normalized.departedAt,
          normalized.lastProcessedAt,
          current?.createdAt ?? now,
          now,
        );
      result = this.requireMemberOnboardingState(normalized.memberId);
    });
    upsert.immediate();
    return requireResult<MemberOnboardingState>(
      result,
      "Member onboarding state update",
    );
  }

  public getMemberRuleAcceptance(
    memberId: string,
    rulesVersion: number,
  ): MemberRuleAcceptance | null {
    const member = assertDiscordSnowflake(memberId, "member ID");
    const version = normalizeInteger(
      rulesVersion,
      1,
      2_147_483_647,
      "rules version",
    );
    const row = this.db
      .prepare(
        `SELECT * FROM member_rule_acceptances
         WHERE guild_id = ? AND member_id = ? AND rules_version = ?`,
      )
      .get(this.guildId, member, version) as
      MemberRuleAcceptanceRow | undefined;
    return row ? parseMemberRuleAcceptance(row) : null;
  }

  public listMemberRuleAcceptances(
    memberId: string,
    limit = MAX_ONBOARDING_RULE_VERSIONS,
    offset = 0,
  ): MemberRuleAcceptance[] {
    const member = assertDiscordSnowflake(memberId, "member ID");
    return (
      this.db
        .prepare(
          `SELECT * FROM member_rule_acceptances
           WHERE guild_id = ? AND member_id = ?
           ORDER BY rules_version DESC LIMIT ? OFFSET ?`,
        )
        .all(
          this.guildId,
          member,
          normalizeListLimit(limit, MAX_ONBOARDING_RULE_VERSIONS),
          normalizeOffset(offset),
        ) as MemberRuleAcceptanceRow[]
    ).map(parseMemberRuleAcceptance);
  }

  public recordMemberRuleAcceptance(
    input: MemberRuleAcceptanceInput,
  ): MemberRuleAcceptanceResult {
    const normalized = normalizeMemberRuleAcceptanceInput(input);
    let result: MemberRuleAcceptanceResult | null = null;
    const record = this.db.transaction(() => {
      if (!this.getOnboardingRulesVersion(normalized.rulesVersion)) {
        throw new TypeError("Rules version does not exist in this guild");
      }
      const existing = this.getMemberRuleAcceptance(
        normalized.memberId,
        normalized.rulesVersion,
      );
      if (existing) {
        result = { status: "duplicate", acceptance: existing };
        return;
      }
      if (
        this.countRows("member_rule_acceptances") >= MAX_ONBOARDING_ACCEPTANCES
      ) {
        throw new RangeError("Member rule-acceptance storage is full");
      }
      this.db
        .prepare(
          `INSERT INTO member_rule_acceptances (
             guild_id, member_id, rules_version, accepted_at, panel_post_id
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          this.guildId,
          normalized.memberId,
          normalized.rulesVersion,
          normalized.acceptedAt,
          normalized.panelPostId,
        );
      result = {
        status: "recorded",
        acceptance: this.requireMemberRuleAcceptance(
          normalized.memberId,
          normalized.rulesVersion,
        ),
      };
    });
    record.immediate();
    return requireResult<MemberRuleAcceptanceResult>(
      result,
      "Rules acceptance recording",
    );
  }

  public getOnboardingDelivery(
    deliveryId: string,
  ): OnboardingDeliveryRecord | null {
    const id = normalizeOpaqueId(deliveryId);
    if (!id) return null;
    const row = this.db
      .prepare(
        `SELECT * FROM onboarding_delivery_records
         WHERE guild_id = ? AND delivery_id = ?`,
      )
      .get(this.guildId, id) as OnboardingDeliveryRow | undefined;
    return row ? parseOnboardingDelivery(row) : null;
  }

  public reserveOnboardingDelivery(
    input: OnboardingDeliveryReservationInput,
  ): OnboardingDeliveryReservationResult {
    const normalized = normalizeDeliveryReservationInput(input);
    let result: OnboardingDeliveryReservationResult | null = null;
    const reserve = this.db.transaction(() => {
      const existingRow = this.db
        .prepare(
          `SELECT * FROM onboarding_delivery_records
           WHERE guild_id = ? AND member_id = ? AND join_instance = ?
             AND delivery_kind = ?`,
        )
        .get(
          this.guildId,
          normalized.memberId,
          normalized.joinInstance,
          normalized.kind,
        ) as OnboardingDeliveryRow | undefined;
      if (existingRow) {
        const existing = parseOnboardingDelivery(existingRow);
        if (existing.state === "delivered" || existing.state === "skipped") {
          result = { status: "duplicate", delivery: existing };
          return;
        }
        if (
          existing.state === "reserved" &&
          existing.claimId === normalized.claimId
        ) {
          result = { status: "reserved", delivery: existing };
          return;
        }
        if (existing.state === "reserved") {
          result = { status: "busy", delivery: existing };
          return;
        }
        if (existing.attemptCount >= 1_000) {
          throw new RangeError("Onboarding delivery retry limit is exhausted");
        }
        const now = utcNow();
        const changed = this.db
          .prepare(
            `UPDATE onboarding_delivery_records
             SET delivery_state = 'reserved', channel_id = NULL,
                 message_id = NULL, attempt_count = attempt_count + 1,
                 failure_code = NULL, claim_id = ?, claim_expires_at = ?,
                 delivered_at = NULL, updated_at = ?
             WHERE guild_id = ? AND delivery_id = ?
               AND delivery_state IN ('failed', 'missing')`,
          )
          .run(
            normalized.claimId,
            normalized.claimExpiresAt,
            now,
            this.guildId,
            existing.deliveryId,
          ).changes;
        if (changed !== 1) {
          result = {
            status: "busy",
            delivery: this.requireOnboardingDelivery(existing.deliveryId),
          };
          return;
        }
        result = {
          status: "reserved",
          delivery: this.requireOnboardingDelivery(existing.deliveryId),
        };
        return;
      }
      this.trimTerminalRows(
        "onboarding_delivery_records",
        "delivery_id",
        "delivery_state <> 'reserved'",
        MAX_ONBOARDING_DELIVERIES - 1,
      );
      if (
        this.countRows("onboarding_delivery_records") >=
        MAX_ONBOARDING_DELIVERIES
      ) {
        throw new RangeError(
          "Onboarding delivery storage is full while reservations remain active",
        );
      }
      const deliveryId = normalized.deliveryId ?? this.allocateDeliveryId();
      if (this.getOnboardingDelivery(deliveryId)) {
        throw new TypeError("Onboarding delivery ID is already in use");
      }
      const now = utcNow();
      this.db
        .prepare(
          `INSERT INTO onboarding_delivery_records (
             guild_id, delivery_id, member_id, join_instance, delivery_kind,
             delivery_state, channel_id, message_id, attempt_count,
             failure_code, claim_id, claim_expires_at, delivered_at,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'reserved', NULL, NULL, 1, NULL, ?, ?, NULL, ?, ?)`,
        )
        .run(
          this.guildId,
          deliveryId,
          normalized.memberId,
          normalized.joinInstance,
          normalized.kind,
          normalized.claimId,
          normalized.claimExpiresAt,
          now,
          now,
        );
      result = {
        status: "reserved",
        delivery: this.requireOnboardingDelivery(deliveryId),
      };
    });
    reserve.immediate();
    return requireResult<OnboardingDeliveryReservationResult>(
      result,
      "Onboarding delivery reservation",
    );
  }

  public completeOnboardingDelivery(
    deliveryId: string,
    input: OnboardingDeliveryCompletionInput,
  ): OnboardingDeliveryRecord {
    const id = requireOpaqueId(deliveryId, "delivery ID");
    const normalized = normalizeDeliveryCompletionInput(input);
    let result: OnboardingDeliveryRecord | null = null;
    const complete = this.db.transaction(() => {
      const current = this.getOnboardingDelivery(id);
      if (!current) throw new Error("Onboarding delivery was not found");
      if (current.state !== "reserved") {
        if (sameDeliveryCompletion(current, normalized)) {
          result = current;
          return;
        }
        throw new Error("Onboarding delivery is no longer reserved");
      }
      const now = utcNow();
      const changed = this.db
        .prepare(
          `UPDATE onboarding_delivery_records
           SET delivery_state = ?, channel_id = ?, message_id = ?,
               failure_code = ?, claim_id = NULL, claim_expires_at = NULL,
               delivered_at = ?, updated_at = ?
           WHERE guild_id = ? AND delivery_id = ?
             AND delivery_state = 'reserved' AND claim_id = ?`,
        )
        .run(
          normalized.state,
          normalized.channelId,
          normalized.messageId,
          normalized.failureCode,
          normalized.state === "delivered" ? now : null,
          now,
          this.guildId,
          id,
          normalized.claimId,
        ).changes;
      if (changed !== 1) {
        const raced = this.requireOnboardingDelivery(id);
        if (sameDeliveryCompletion(raced, normalized)) {
          result = raced;
          return;
        }
        throw new Error("Onboarding delivery reservation claim is stale");
      }
      result = this.requireOnboardingDelivery(id);
    });
    complete.immediate();
    return requireResult<OnboardingDeliveryRecord>(
      result,
      "Onboarding delivery completion",
    );
  }

  public listOnboardingDeliveries(
    options: {
      memberId?: string;
      states?: readonly string[];
      kinds?: readonly string[];
      limit?: number;
      offset?: number;
    } = {},
  ): OnboardingDeliveryRecord[] {
    const clauses = ["guild_id = ?"];
    const parameters: Array<string | number> = [this.guildId];
    if (options.memberId !== undefined) {
      clauses.push("member_id = ?");
      parameters.push(assertDiscordSnowflake(options.memberId, "member ID"));
    }
    const states = normalizeStringEnumList(
      options.states,
      ONBOARDING_DELIVERY_STATES,
      "delivery state",
    );
    if (states !== undefined) {
      if (states.length === 0) return [];
      clauses.push(`delivery_state IN (${states.map(() => "?").join(", ")})`);
      parameters.push(...states);
    }
    const kinds = normalizeStringEnumList(
      options.kinds,
      ONBOARDING_DELIVERY_KINDS,
      "delivery kind",
    );
    if (kinds !== undefined) {
      if (kinds.length === 0) return [];
      clauses.push(`delivery_kind IN (${kinds.map(() => "?").join(", ")})`);
      parameters.push(...kinds);
    }
    parameters.push(
      normalizeListLimit(options.limit ?? DEFAULT_LIST_LIMIT),
      normalizeOffset(options.offset ?? 0),
    );
    return (
      this.db
        .prepare(
          `SELECT * FROM onboarding_delivery_records
           WHERE ${clauses.join(" AND ")}
           ORDER BY updated_at DESC, delivery_id
           LIMIT ? OFFSET ?`,
        )
        .all(...parameters) as OnboardingDeliveryRow[]
    ).map(parseOnboardingDelivery);
  }

  public getOnboardingRoleOperation(
    operationId: string,
  ): OnboardingRoleOperation | null {
    const id = normalizeOpaqueId(operationId);
    if (!id) return null;
    const row = this.db
      .prepare(
        `SELECT * FROM onboarding_role_operations
         WHERE guild_id = ? AND operation_id = ?`,
      )
      .get(this.guildId, id) as OnboardingRoleOperationRow | undefined;
    return row ? parseOnboardingRoleOperation(row) : null;
  }

  public reserveOnboardingRoleOperation(
    input: OnboardingRoleOperationReservationInput,
  ): OnboardingRoleOperationReservationResult {
    const normalized = normalizeRoleOperationReservationInput(
      input,
      this.guildId,
    );
    let result: OnboardingRoleOperationReservationResult | null = null;
    const reserve = this.db.transaction(() => {
      const existingRow = this.db
        .prepare(
          `SELECT * FROM onboarding_role_operations
           WHERE guild_id = ? AND member_id = ? AND role_id = ?
             AND operation_kind = ? AND idempotency_key = ?`,
        )
        .get(
          this.guildId,
          normalized.memberId,
          normalized.roleId,
          normalized.kind,
          normalized.idempotencyKey,
        ) as OnboardingRoleOperationRow | undefined;
      if (existingRow) {
        const existing = parseOnboardingRoleOperation(existingRow);
        result = {
          status: existing.state === "reserved" ? "pending" : "completed",
          operation: existing,
        };
        return;
      }
      this.trimTerminalRows(
        "onboarding_role_operations",
        "operation_id",
        "operation_state <> 'reserved' OR resolved_at IS NOT NULL",
        MAX_ONBOARDING_ROLE_OPERATIONS - 1,
      );
      if (
        this.countRows("onboarding_role_operations") >=
        MAX_ONBOARDING_ROLE_OPERATIONS
      ) {
        throw new RangeError(
          "Onboarding role-operation storage is full while work remains active",
        );
      }
      const operationId =
        normalized.operationId ?? this.allocateOnboardingRoleOperationId();
      if (this.getOnboardingRoleOperation(operationId)) {
        throw new TypeError("Onboarding role-operation ID is already in use");
      }
      const now = utcNow();
      this.db
        .prepare(
          `INSERT INTO onboarding_role_operations (
             guild_id, operation_id, member_id, role_id, operation_kind,
             idempotency_key, operation_state, failure_code, attempt_count,
             created_at, updated_at, completed_at, resolved_at,
             resolved_by_operation_id
           ) VALUES (?, ?, ?, ?, ?, ?, 'reserved', NULL, 1, ?, ?, NULL,
             NULL, NULL)`,
        )
        .run(
          this.guildId,
          operationId,
          normalized.memberId,
          normalized.roleId,
          normalized.kind,
          normalized.idempotencyKey,
          now,
          now,
        );
      result = {
        status: "reserved",
        operation: this.requireOnboardingRoleOperation(operationId),
      };
    });
    reserve.immediate();
    return requireResult<OnboardingRoleOperationReservationResult>(
      result,
      "Onboarding role-operation reservation",
    );
  }

  public completeOnboardingRoleOperation(
    operationId: string,
    input: OnboardingRoleOperationCompletionInput,
  ): OnboardingRoleOperation {
    const id = requireOpaqueId(operationId, "operation ID");
    const normalized = normalizeRoleOperationCompletionInput(input);
    let result: OnboardingRoleOperation | null = null;
    const complete = this.db.transaction(() => {
      const current = this.getOnboardingRoleOperation(id);
      if (!current) throw new Error("Onboarding role operation was not found");
      if (current.state !== "reserved") {
        if (
          current.state === normalized.state &&
          current.failureCode === normalized.failureCode
        ) {
          result = current;
          return;
        }
        throw new Error("Onboarding role operation is already complete");
      }
      const now = utcNow();
      const changed = this.db
        .prepare(
          `UPDATE onboarding_role_operations
           SET operation_state = ?, failure_code = ?, completed_at = ?,
               updated_at = ?
           WHERE guild_id = ? AND operation_id = ?
             AND operation_state = 'reserved'`,
        )
        .run(
          normalized.state,
          normalized.failureCode,
          now,
          now,
          this.guildId,
          id,
        ).changes;
      if (changed !== 1) {
        throw new Error("Onboarding role operation completion raced");
      }
      result = this.requireOnboardingRoleOperation(id);
    });
    complete.immediate();
    return requireResult<OnboardingRoleOperation>(
      result,
      "Onboarding role-operation completion",
    );
  }

  /**
   * Reconciles earlier incomplete work only after a matching successful
   * `/onboarding recover` operation has been durably recorded. Original state,
   * failure, and completion fields remain unchanged.
   */
  public resolveOnboardingRoleOperations(
    resolvedByOperationId: string,
  ): OnboardingRoleOperation[] {
    const resolverId = requireOpaqueId(
      resolvedByOperationId,
      "recovery operation ID",
    );
    let result: OnboardingRoleOperation[] | null = null;
    const resolve = this.db.transaction(() => {
      const resolver = this.getOnboardingRoleOperation(resolverId);
      if (!resolver) throw new Error("Recovery role operation was not found");
      if (
        (resolver.state !== "completed" && resolver.state !== "no-change") ||
        resolver.completedAt === null ||
        resolver.failureCode !== null ||
        resolver.resolvedAt !== null ||
        !resolver.idempotencyKey.startsWith("recover:")
      ) {
        throw new TypeError(
          "Role-operation resolution requires an unresolved successful recovery operation",
        );
      }

      const now = utcNow();
      this.db
        .prepare(
          `UPDATE onboarding_role_operations
           SET resolved_at = ?, resolved_by_operation_id = ?, updated_at = ?
           WHERE guild_id = ? AND member_id = ? AND role_id = ?
             AND operation_kind = ? AND operation_id <> ?
             AND resolved_at IS NULL
             AND operation_state IN ('reserved', 'partial', 'failed')`,
        )
        .run(
          now,
          resolver.operationId,
          now,
          this.guildId,
          resolver.memberId,
          resolver.roleId,
          resolver.kind,
          resolver.operationId,
        );
      result = this.selectResolvedOnboardingRoleOperations(
        resolver.operationId,
      );
    });
    resolve.immediate();
    return requireResult<OnboardingRoleOperation[]>(
      result,
      "Onboarding role-operation resolution",
    );
  }

  public listOnboardingRoleOperations(
    options: {
      memberId?: string;
      states?: readonly string[];
      unresolvedOnly?: boolean;
      limit?: number;
      offset?: number;
    } = {},
  ): OnboardingRoleOperation[] {
    const clauses = ["guild_id = ?"];
    const parameters: Array<string | number> = [this.guildId];
    if (options.memberId !== undefined) {
      clauses.push("member_id = ?");
      parameters.push(assertDiscordSnowflake(options.memberId, "member ID"));
    }
    const states = normalizeStringEnumList(
      options.states,
      ROLE_OPERATION_STATES,
      "role-operation state",
    );
    if (states !== undefined) {
      if (states.length === 0) return [];
      clauses.push(`operation_state IN (${states.map(() => "?").join(", ")})`);
      parameters.push(...states);
    }
    if (options.unresolvedOnly === true) {
      clauses.push("resolved_at IS NULL");
    }
    parameters.push(
      normalizeListLimit(options.limit ?? DEFAULT_LIST_LIMIT),
      normalizeOffset(options.offset ?? 0),
    );
    return (
      this.db
        .prepare(
          `SELECT * FROM onboarding_role_operations
           WHERE ${clauses.join(" AND ")}
           ORDER BY updated_at DESC, operation_id
           LIMIT ? OFFSET ?`,
        )
        .all(...parameters) as OnboardingRoleOperationRow[]
    ).map(parseOnboardingRoleOperation);
  }

  public appendOnboardingAudit(
    input: OnboardingAuditEventInput,
  ): OnboardingAuditEvent {
    const normalized = normalizeAuditEventInput(input);
    let result: OnboardingAuditEvent | null = null;
    const append = this.db.transaction(() => {
      if (
        normalized.rulesVersion !== null &&
        !this.getOnboardingRulesVersion(normalized.rulesVersion)
      ) {
        throw new TypeError("Audit rules version does not exist in this guild");
      }
      const numberRow = this.db
        .prepare(
          `SELECT COALESCE(MAX(event_number), 0) + 1 AS next_number
           FROM onboarding_audit_events WHERE guild_id = ?`,
        )
        .get(this.guildId) as { next_number: number };
      const eventNumber = normalizeInteger(
        Number(numberRow.next_number),
        1,
        2_147_483_647,
        "onboarding event number",
      );
      const eventId = this.allocateAuditEventId();
      this.db
        .prepare(
          `INSERT INTO onboarding_audit_events (
             guild_id, event_id, event_number, event_type, member_id,
             actor_id, rules_version, outcome, details_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.guildId,
          eventId,
          eventNumber,
          normalized.eventType,
          normalized.memberId,
          normalized.actorId,
          normalized.rulesVersion,
          normalized.outcome,
          normalized.detailsJson,
          utcNow(),
        );
      this.db
        .prepare(
          `DELETE FROM onboarding_audit_events
           WHERE guild_id = ? AND event_id IN (
             SELECT event_id FROM onboarding_audit_events
             WHERE guild_id = ? ORDER BY event_number DESC
             LIMIT -1 OFFSET ?
           )`,
        )
        .run(this.guildId, this.guildId, MAX_ONBOARDING_AUDIT_EVENTS);
      result = this.requireOnboardingAuditEvent(eventId);
    });
    append.immediate();
    return requireResult<OnboardingAuditEvent>(
      result,
      "Onboarding audit append",
    );
  }

  public listOnboardingAuditEvents(
    options: {
      memberId?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): OnboardingAuditEvent[] {
    const limit = normalizeListLimit(options.limit ?? DEFAULT_LIST_LIMIT);
    const offset = normalizeOffset(options.offset ?? 0);
    if (options.memberId === undefined) {
      return (
        this.db
          .prepare(
            `SELECT * FROM onboarding_audit_events WHERE guild_id = ?
             ORDER BY event_number DESC LIMIT ? OFFSET ?`,
          )
          .all(this.guildId, limit, offset) as OnboardingAuditEventRow[]
      ).map(parseOnboardingAuditEvent);
    }
    const memberId = assertDiscordSnowflake(options.memberId, "member ID");
    return (
      this.db
        .prepare(
          `SELECT * FROM onboarding_audit_events
           WHERE guild_id = ? AND member_id = ?
           ORDER BY event_number DESC LIMIT ? OFFSET ?`,
        )
        .all(this.guildId, memberId, limit, offset) as OnboardingAuditEventRow[]
    ).map(parseOnboardingAuditEvent);
  }

  public findPostedPanelByToken(panelId: string): StoredOnboardingPanel | null {
    const panel = this.operational.findPostedPanelByToken(panelId);
    return panel?.preset === "verification" ? panel : null;
  }

  public findPostedPanelByPresetAndChannel(
    preset: "verification",
    channelId: string,
  ): StoredOnboardingPanel | null {
    return this.operational.findPostedPanelByPresetAndChannel(
      normalizeVerificationPreset(preset),
      channelId,
    );
  }

  public upsertPostedPanel(input: {
    panelId?: string;
    preset: "verification";
    channelId: string;
    messageId: string;
    configuration: unknown;
  }): StoredOnboardingPanel {
    normalizeVerificationPreset(input.preset);
    return this.operational.upsertPostedPanel(input);
  }

  public countPostedPanels(preset?: "verification"): number {
    return this.operational.countPostedPanels(
      preset === undefined
        ? "verification"
        : normalizeVerificationPreset(preset),
    );
  }

  public listPostedPanels(
    preset: "verification" = "verification",
    limit = DEFAULT_LIST_LIMIT,
    offset = 0,
  ): StoredOnboardingPanel[] {
    return this.operational.listPostedPanels(
      normalizeVerificationPreset(preset),
      normalizeListLimit(limit),
      normalizeOffset(offset),
    );
  }

  public recordCommandMetric(commandName: string, success = true): void {
    if (typeof success !== "boolean") {
      throw new TypeError("Command metric success must be a boolean");
    }
    const keys = [commandMetricKey(commandName)];
    if (!success) keys.push(commandMetricKey(commandName, true));
    const record = this.db.transaction(() => {
      if (
        !this.db
          .prepare("SELECT 1 FROM guilds WHERE guild_id = ?")
          .get(this.guildId)
      ) {
        return;
      }
      const now = utcNow();
      for (const key of keys) {
        const current = this.db
          .prepare(
            `SELECT metric_value FROM metrics
             WHERE guild_id = ? AND metric_key = ?`,
          )
          .get(this.guildId, key) as { metric_value: number } | undefined;
        const next = Number(current?.metric_value ?? 0) + 1;
        if (!Number.isSafeInteger(next) || next > MAX_SAFE_INTEGER) {
          throw new RangeError("Command metric exceeds the safe-integer range");
        }
        this.db
          .prepare(
            `INSERT INTO metrics (guild_id, metric_key, metric_value, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(guild_id, metric_key) DO UPDATE SET
               metric_value = excluded.metric_value,
               updated_at = excluded.updated_at`,
          )
          .run(this.guildId, key, next, now);
      }
    });
    record.immediate();
  }

  public invalidateOnboardingRole(roleId: string): {
    configurationChanged: number;
    autorolesChanged: number;
  } {
    const role = assertDiscordSnowflake(roleId, "role ID");
    let configurationChanged = 0;
    let autorolesChanged = 0;
    const invalidate = this.db.transaction(() => {
      const timestamp = utcNow();
      configurationChanged = this.db
        .prepare(
          `UPDATE onboarding_configurations
           SET verification_enabled = 0,
               verification_roles_verified_at = NULL,
               updated_at = ?
           WHERE guild_id = ?
             AND (verified_role_id = ? OR unverified_role_id = ?)`,
        )
        .run(timestamp, this.guildId, role, role).changes;
      autorolesChanged = this.db
        .prepare(
          `UPDATE onboarding_autoroles
           SET enabled = 0, bindings_verified_at = NULL, updated_at = ?
           WHERE guild_id = ? AND role_id = ?`,
        )
        .run(timestamp, this.guildId, role).changes;
    });
    invalidate.immediate();
    return { configurationChanged, autorolesChanged };
  }

  public invalidateOnboardingChannel(channelId: string): {
    configurationChanged: number;
  } {
    const channel = assertDiscordSnowflake(channelId, "channel ID");
    const timestamp = utcNow();
    const result = this.db
      .prepare(
        `UPDATE onboarding_configurations
         SET welcome_public_enabled = CASE WHEN welcome_channel_id = ? THEN 0 ELSE welcome_public_enabled END,
             welcome_channel_verified_at = CASE WHEN welcome_channel_id = ? THEN NULL ELSE welcome_channel_verified_at END,
             farewell_public_enabled = CASE WHEN farewell_channel_id = ? THEN 0 ELSE farewell_public_enabled END,
             farewell_channel_verified_at = CASE WHEN farewell_channel_id = ? THEN NULL ELSE farewell_channel_verified_at END,
             lifecycle_log_channel_verified_at = CASE WHEN lifecycle_log_channel_id = ? THEN NULL ELSE lifecycle_log_channel_verified_at END,
             rules_channel_verified_at = CASE WHEN rules_channel_id = ? THEN NULL ELSE rules_channel_verified_at END,
             updated_at = ?
         WHERE guild_id = ? AND (
           welcome_channel_id = ? OR farewell_channel_id = ? OR
           lifecycle_log_channel_id = ? OR rules_channel_id = ?
         )`,
      )
      .run(
        channel,
        channel,
        channel,
        channel,
        channel,
        channel,
        timestamp,
        this.guildId,
        channel,
        channel,
        channel,
        channel,
      );
    return { configurationChanged: result.changes };
  }

  private makeMemberStateCapacity(): void {
    if (
      this.countRows("member_onboarding_states") < MAX_ONBOARDING_MEMBER_STATES
    ) {
      return;
    }
    this.db
      .prepare(
        `DELETE FROM member_onboarding_states
         WHERE guild_id = ? AND member_id IN (
           SELECT member_id FROM member_onboarding_states
           WHERE guild_id = ? AND lifecycle_state = 'departed'
           ORDER BY updated_at ASC LIMIT 1
         )`,
      )
      .run(this.guildId, this.guildId);
    if (
      this.countRows("member_onboarding_states") >= MAX_ONBOARDING_MEMBER_STATES
    ) {
      throw new RangeError(
        "Member onboarding storage is full while all retained members are active",
      );
    }
  }

  private trimTerminalRows(
    table: "onboarding_delivery_records" | "onboarding_role_operations",
    idColumn: "delivery_id" | "operation_id",
    terminalClause: string,
    maximum: number,
  ): void {
    const count = this.countRows(table);
    const excess = Math.max(0, count - maximum);
    if (excess === 0) return;
    this.db
      .prepare(
        `DELETE FROM ${table}
         WHERE guild_id = ? AND ${idColumn} IN (
           SELECT ${idColumn} FROM ${table}
           WHERE guild_id = ? AND (${terminalClause})
           ORDER BY ${
             table === "onboarding_role_operations"
               ? "(resolved_at IS NULL) ASC, updated_at ASC"
               : "updated_at ASC"
           } LIMIT ?
         )`,
      )
      .run(this.guildId, this.guildId, excess);
  }

  private countRows(
    table:
      | "onboarding_rules_versions"
      | "member_onboarding_states"
      | "member_rule_acceptances"
      | "onboarding_delivery_records"
      | "onboarding_role_operations",
  ): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE guild_id = ?`)
      .get(this.guildId) as { count: number };
    return Number(row.count);
  }

  private requireOnboardingConfiguration(): OnboardingConfiguration {
    const configuration = this.getOnboardingConfiguration();
    if (!configuration) {
      throw new Error("Onboarding configuration was not persisted");
    }
    return configuration;
  }

  private requireOnboardingRulesVersion(
    rulesVersion: number,
  ): OnboardingRulesVersion {
    const version = this.getOnboardingRulesVersion(rulesVersion);
    if (!version) throw new Error("Onboarding rules version was not persisted");
    return version;
  }

  private requireMemberOnboardingState(
    memberId: string,
  ): MemberOnboardingState {
    const state = this.getMemberOnboardingState(memberId);
    if (!state) throw new Error("Member onboarding state was not persisted");
    return state;
  }

  private requireMemberRuleAcceptance(
    memberId: string,
    rulesVersion: number,
  ): MemberRuleAcceptance {
    const acceptance = this.getMemberRuleAcceptance(memberId, rulesVersion);
    if (!acceptance)
      throw new Error("Member rules acceptance was not persisted");
    return acceptance;
  }

  private requireOnboardingDelivery(
    deliveryId: string,
  ): OnboardingDeliveryRecord {
    const delivery = this.getOnboardingDelivery(deliveryId);
    if (!delivery) throw new Error("Onboarding delivery was not persisted");
    return delivery;
  }

  private requireOnboardingRoleOperation(
    operationId: string,
  ): OnboardingRoleOperation {
    const operation = this.getOnboardingRoleOperation(operationId);
    if (!operation) {
      throw new Error("Onboarding role operation was not persisted");
    }
    return operation;
  }

  private selectResolvedOnboardingRoleOperations(
    resolverOperationId: string,
  ): OnboardingRoleOperation[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM onboarding_role_operations
           WHERE guild_id = ? AND resolved_by_operation_id = ?
           ORDER BY updated_at DESC, operation_id`,
        )
        .all(this.guildId, resolverOperationId) as OnboardingRoleOperationRow[]
    ).map(parseOnboardingRoleOperation);
  }

  private requireOnboardingAuditEvent(eventId: string): OnboardingAuditEvent {
    const row = this.db
      .prepare(
        `SELECT * FROM onboarding_audit_events
         WHERE guild_id = ? AND event_id = ?`,
      )
      .get(this.guildId, eventId) as OnboardingAuditEventRow | undefined;
    if (!row) throw new Error("Onboarding audit event was not persisted");
    return parseOnboardingAuditEvent(row);
  }

  private allocateDeliveryId(): string {
    return allocateOpaqueId((id) => this.getOnboardingDelivery(id) !== null);
  }

  private allocateOnboardingRoleOperationId(): string {
    return allocateOpaqueId(
      (id) => this.getOnboardingRoleOperation(id) !== null,
    );
  }

  private allocateAuditEventId(): string {
    return allocateOpaqueId((id) =>
      Boolean(
        this.db
          .prepare(
            `SELECT 1 FROM onboarding_audit_events
             WHERE guild_id = ? AND event_id = ?`,
          )
          .get(this.guildId, id),
      ),
    );
  }
}

/** Alias matching the other storage repository class names. */
export { OnboardingStorageRepository as OnboardingRepository };

function normalizeOnboardingConfigurationInput(
  input: OnboardingConfigurationInput,
  guildId: string,
): OnboardingConfigurationInput {
  if (!input || typeof input !== "object") {
    throw new TypeError("Onboarding configuration input is required");
  }
  const welcomeChannelId = normalizeNullableSnowflake(
    input.welcomeChannelId,
    "welcome channel ID",
  );
  const farewellChannelId = normalizeNullableSnowflake(
    input.farewellChannelId,
    "farewell channel ID",
  );
  const lifecycleLogChannelId = normalizeNullableSnowflake(
    input.lifecycleLogChannelId,
    "lifecycle-log channel ID",
  );
  const rulesChannelId = normalizeNullableSnowflake(
    input.rulesChannelId,
    "rules channel ID",
  );
  const verifiedRoleId = normalizeNullableSnowflake(
    input.verifiedRoleId,
    "verified role ID",
  );
  const unverifiedRoleId = normalizeNullableSnowflake(
    input.unverifiedRoleId,
    "unverified role ID",
  );
  const welcomeChannelVerifiedAt = normalizeNullableTimestamp(
    input.welcomeChannelVerifiedAt,
    "welcome channel verification time",
  );
  const farewellChannelVerifiedAt = normalizeNullableTimestamp(
    input.farewellChannelVerifiedAt,
    "farewell channel verification time",
  );
  const lifecycleLogChannelVerifiedAt = normalizeNullableTimestamp(
    input.lifecycleLogChannelVerifiedAt,
    "lifecycle-log channel verification time",
  );
  const rulesChannelVerifiedAt = normalizeNullableTimestamp(
    input.rulesChannelVerifiedAt,
    "rules channel verification time",
  );
  const verificationRolesVerifiedAt = normalizeNullableTimestamp(
    input.verificationRolesVerifiedAt,
    "verification-role verification time",
  );
  const enabled = normalizeBoolean(input.enabled, "onboarding enabled");
  const welcomePublicEnabled = normalizeBoolean(
    input.welcomePublicEnabled,
    "public welcome enabled",
  );
  const welcomeDmEnabled = normalizeBoolean(
    input.welcomeDmEnabled,
    "welcome DM enabled",
  );
  const farewellPublicEnabled = normalizeBoolean(
    input.farewellPublicEnabled,
    "public farewell enabled",
  );
  const verificationEnabled = normalizeBoolean(
    input.verificationEnabled,
    "verification enabled",
  );
  const humanAutorolesEnabled = normalizeBoolean(
    input.humanAutorolesEnabled,
    "human autoroles enabled",
  );
  const botAutorolesEnabled = normalizeBoolean(
    input.botAutorolesEnabled,
    "bot autoroles enabled",
  );
  const currentRulesVersion =
    input.currentRulesVersion === null
      ? null
      : normalizeInteger(
          input.currentRulesVersion,
          1,
          2_147_483_647,
          "current rules version",
        );
  const accountAgeAlertHours =
    input.accountAgeAlertHours === null
      ? null
      : normalizeInteger(
          input.accountAgeAlertHours,
          1,
          87_600,
          "account-age alert hours",
        );
  if (welcomeChannelVerifiedAt !== null && welcomeChannelId === null) {
    throw new TypeError("Welcome channel verification requires a channel");
  }
  if (farewellChannelVerifiedAt !== null && farewellChannelId === null) {
    throw new TypeError("Farewell channel verification requires a channel");
  }
  if (
    lifecycleLogChannelVerifiedAt !== null &&
    lifecycleLogChannelId === null
  ) {
    throw new TypeError("Lifecycle-log verification requires a channel");
  }
  if (rulesChannelVerifiedAt !== null && rulesChannelId === null) {
    throw new TypeError("Rules-channel verification requires a channel");
  }
  if (verificationRolesVerifiedAt !== null && verifiedRoleId === null) {
    throw new TypeError(
      "Verification-role verification requires a verified role",
    );
  }
  if (
    welcomePublicEnabled &&
    (welcomeChannelId === null || welcomeChannelVerifiedAt === null)
  ) {
    throw new TypeError("Public welcomes require a verified welcome channel");
  }
  if (
    farewellPublicEnabled &&
    (farewellChannelId === null || farewellChannelVerifiedAt === null)
  ) {
    throw new TypeError("Public farewells require a verified farewell channel");
  }
  if (
    verificationEnabled &&
    (currentRulesVersion === null ||
      verifiedRoleId === null ||
      verificationRolesVerifiedAt === null)
  ) {
    throw new TypeError(
      "Verification requires current rules and a verified member role",
    );
  }
  if (verifiedRoleId === guildId || unverifiedRoleId === guildId) {
    throw new TypeError("The @everyone role cannot be an onboarding role");
  }
  if (verifiedRoleId !== null && verifiedRoleId === unverifiedRoleId) {
    throw new TypeError("Verified and unverified roles must be different");
  }
  const welcome = normalizeOnboardingTemplatePair(
    input.welcomeTitle,
    input.welcomeBody,
  );
  const farewell = normalizeOnboardingTemplatePair(
    input.farewellTitle,
    input.farewellBody,
  );
  return {
    enabled,
    welcomeChannelId,
    welcomePublicEnabled,
    welcomeDmEnabled,
    farewellChannelId,
    farewellPublicEnabled,
    lifecycleLogChannelId,
    rulesChannelId,
    verificationEnabled,
    currentRulesVersion,
    verifiedRoleId,
    unverifiedRoleId,
    humanAutorolesEnabled,
    botAutorolesEnabled,
    accountAgeAlertHours,
    welcomeTitle: welcome.title,
    welcomeBody: welcome.body,
    farewellTitle: farewell.title,
    farewellBody: farewell.body,
    welcomeChannelVerifiedAt,
    farewellChannelVerifiedAt,
    lifecycleLogChannelVerifiedAt,
    rulesChannelVerifiedAt,
    verificationRolesVerifiedAt,
    actorId: assertDiscordSnowflake(input.actorId, "actor ID"),
  };
}

function normalizeRulesVersionInput(
  input: OnboardingRulesVersionInput,
): Required<OnboardingRulesVersionInput> {
  if (!input || typeof input !== "object") {
    throw new TypeError("Rules version input is required");
  }
  return {
    title: normalizeRulesTitle(input.title),
    body: normalizeRulesBody(input.body),
    reacceptanceRequested: normalizeBoolean(
      input.reacceptanceRequested ?? false,
      "rules re-acceptance request",
    ),
    actorId: assertDiscordSnowflake(input.actorId, "actor ID"),
  };
}

function normalizeAutoroleInputs(
  inputs: readonly OnboardingAutoroleInput[],
  guildId: string,
): Array<Required<OnboardingAutoroleInput>> {
  if (!Array.isArray(inputs)) {
    throw new TypeError("Onboarding autoroles must be an array");
  }
  if (inputs.length > MAX_ONBOARDING_AUTOROLES_PER_AUDIENCE) {
    throw new RangeError(
      `An audience supports at most ${MAX_ONBOARDING_AUTOROLES_PER_AUDIENCE} autoroles`,
    );
  }
  const seen = new Set<string>();
  return inputs.map((input) => {
    const roleId = assertDiscordSnowflake(input.roleId, "autorole ID");
    if (roleId === guildId) {
      throw new TypeError("The @everyone role cannot be an automatic role");
    }
    if (seen.has(roleId)) throw new TypeError("Automatic roles must be unique");
    seen.add(roleId);
    const enabled = normalizeBoolean(input.enabled, "autorole enabled");
    const bindingsVerifiedAt = normalizeNullableTimestamp(
      input.bindingsVerifiedAt ?? null,
      "autorole verification time",
    );
    if (enabled !== (bindingsVerifiedAt !== null)) {
      throw new TypeError(
        "An automatic role must have a verification time exactly when enabled",
      );
    }
    return { roleId, enabled, bindingsVerifiedAt };
  });
}

function normalizeMemberOnboardingStateInput(
  input: MemberOnboardingStateInput,
): MemberOnboardingStateInput {
  if (!input || typeof input !== "object") {
    throw new TypeError("Member onboarding state input is required");
  }
  const screeningState = normalizeStringEnum(
    input.screeningState,
    ONBOARDING_SCREENING_STATES,
    "screening state",
  );
  const lifecycleState = normalizeStringEnum(
    input.lifecycleState,
    MEMBER_ONBOARDING_LIFECYCLE_STATES,
    "onboarding lifecycle state",
  );
  const screeningCompletedAt = normalizeNullableTimestamp(
    input.screeningCompletedAt,
    "screening completion time",
  );
  const departedAt = normalizeNullableTimestamp(
    input.departedAt,
    "departure time",
  );
  if (
    (screeningState === "pending") !==
    (lifecycleState === "pending-screening")
  ) {
    throw new TypeError(
      "Pending native screening must use the pending-screening lifecycle state",
    );
  }
  if ((lifecycleState === "departed") !== (departedAt !== null)) {
    throw new TypeError(
      "Only departed member state may contain a departure time",
    );
  }
  if (screeningCompletedAt !== null && screeningState !== "complete") {
    throw new TypeError(
      "A screening completion time requires completed native screening",
    );
  }
  return {
    memberId: assertDiscordSnowflake(input.memberId, "member ID"),
    memberKind: normalizeAutoroleAudience(input.memberKind),
    screeningState,
    lifecycleState,
    joinedAt: normalizeTimestamp(input.joinedAt, "join time"),
    accountCreatedAt: normalizeTimestamp(
      input.accountCreatedAt,
      "account creation time",
    ),
    screeningCompletedAt,
    departedAt,
    lastProcessedAt: normalizeTimestamp(
      input.lastProcessedAt,
      "last processed time",
    ),
  };
}

function normalizeMemberRuleAcceptanceInput(
  input: MemberRuleAcceptanceInput,
): Required<MemberRuleAcceptanceInput> {
  if (!input || typeof input !== "object") {
    throw new TypeError("Member rules acceptance input is required");
  }
  return {
    memberId: assertDiscordSnowflake(input.memberId, "member ID"),
    rulesVersion: normalizeInteger(
      input.rulesVersion,
      1,
      2_147_483_647,
      "rules version",
    ),
    acceptedAt: normalizeTimestamp(
      input.acceptedAt ?? utcNow(),
      "acceptance time",
    ),
    panelPostId:
      input.panelPostId == null
        ? null
        : requireOpaqueId(input.panelPostId, "panel post ID"),
  };
}

function normalizeDeliveryReservationInput(
  input: OnboardingDeliveryReservationInput,
): Omit<Required<OnboardingDeliveryReservationInput>, "deliveryId"> & {
  deliveryId: string | null;
} {
  if (!input || typeof input !== "object") {
    throw new TypeError("Onboarding delivery reservation input is required");
  }
  return {
    deliveryId:
      input.deliveryId === undefined
        ? null
        : requireOpaqueId(input.deliveryId, "delivery ID"),
    memberId: assertDiscordSnowflake(input.memberId, "member ID"),
    joinInstance: normalizeTokenText(
      input.joinInstance,
      1,
      100,
      "join instance",
      /^[A-Za-z0-9_.:-]+$/u,
    ),
    kind: normalizeStringEnum(
      input.kind,
      ONBOARDING_DELIVERY_KINDS,
      "delivery kind",
    ),
    claimId: requireOpaqueId(input.claimId, "claim ID"),
    claimExpiresAt: normalizeTimestamp(
      input.claimExpiresAt,
      "claim expiry time",
    ),
  };
}

function normalizeDeliveryCompletionInput(
  input: OnboardingDeliveryCompletionInput,
): OnboardingDeliveryCompletionInput & {
  channelId: string | null;
  messageId: string | null;
  failureCode: string | null;
} {
  if (!input || typeof input !== "object") {
    throw new TypeError("Onboarding delivery completion input is required");
  }
  const state = normalizeStringEnum(
    input.state,
    ONBOARDING_DELIVERY_STATES.filter(
      (candidate): candidate is Exclude<OnboardingDeliveryState, "reserved"> =>
        candidate !== "reserved",
    ),
    "delivery completion state",
  );
  const channelId = normalizeNullableSnowflake(
    input.channelId ?? null,
    "delivery channel ID",
  );
  const messageId = normalizeNullableSnowflake(
    input.messageId ?? null,
    "delivery message ID",
  );
  const failureCode = normalizeNullableShortText(
    input.failureCode ?? null,
    "delivery failure code",
  );
  if (state === "delivered" && (channelId === null || messageId === null)) {
    throw new TypeError("A delivered message requires channel and message IDs");
  }
  if (state !== "delivered" && messageId !== null) {
    throw new TypeError("Only delivered work may contain a message ID");
  }
  if ((state === "failed" || state === "missing") && failureCode === null) {
    throw new TypeError("Failed or missing delivery requires a failure code");
  }
  if (state === "delivered" && failureCode !== null) {
    throw new TypeError("Delivered work cannot retain a failure code");
  }
  return {
    claimId: requireOpaqueId(input.claimId, "claim ID"),
    state,
    channelId,
    messageId,
    failureCode,
  };
}

function normalizeRoleOperationReservationInput(
  input: OnboardingRoleOperationReservationInput,
  guildId: string,
): Omit<Required<OnboardingRoleOperationReservationInput>, "operationId"> & {
  operationId: string | null;
} {
  if (!input || typeof input !== "object") {
    throw new TypeError("Onboarding role-operation reservation is required");
  }
  const roleId = assertDiscordSnowflake(input.roleId, "role ID");
  if (roleId === guildId) {
    throw new TypeError("The @everyone role cannot be changed by onboarding");
  }
  return {
    operationId:
      input.operationId === undefined
        ? null
        : requireOpaqueId(input.operationId, "operation ID"),
    memberId: assertDiscordSnowflake(input.memberId, "member ID"),
    roleId,
    kind: normalizeStringEnum(
      input.kind,
      ONBOARDING_ROLE_OPERATION_KINDS,
      "onboarding role-operation kind",
    ),
    idempotencyKey: normalizeTokenText(
      input.idempotencyKey,
      1,
      100,
      "role-operation idempotency key",
      /^[A-Za-z0-9_.:-]+$/u,
    ),
  };
}

function normalizeRoleOperationCompletionInput(
  input: OnboardingRoleOperationCompletionInput,
): OnboardingRoleOperationCompletionInput & { failureCode: string | null } {
  if (!input || typeof input !== "object") {
    throw new TypeError("Onboarding role-operation completion is required");
  }
  const state = normalizeStringEnum(
    input.state,
    ROLE_OPERATION_STATES.filter(
      (candidate): candidate is Exclude<RoleOperationState, "reserved"> =>
        candidate !== "reserved",
    ),
    "role-operation completion state",
  );
  const failureCode = normalizeNullableShortText(
    input.failureCode ?? null,
    "role-operation failure code",
  );
  if ((state === "failed" || state === "partial") && failureCode === null) {
    throw new TypeError(
      "Failed or partial role operation requires a failure code",
    );
  }
  if (
    (state === "completed" || state === "no-change") &&
    failureCode !== null
  ) {
    throw new TypeError(
      "Completed or unchanged role operation cannot retain a failure code",
    );
  }
  return { state, failureCode };
}

function normalizeAuditEventInput(input: OnboardingAuditEventInput): {
  eventType: string;
  memberId: string | null;
  actorId: string | null;
  rulesVersion: number | null;
  outcome: string;
  detailsJson: string;
} {
  if (!input || typeof input !== "object") {
    throw new TypeError("Onboarding audit input is required");
  }
  return {
    eventType: normalizeText(input.eventType, 1, 100, "audit event type"),
    memberId: normalizeNullableSnowflake(input.memberId ?? null, "member ID"),
    actorId: normalizeNullableSnowflake(input.actorId ?? null, "actor ID"),
    rulesVersion:
      input.rulesVersion == null
        ? null
        : normalizeInteger(
            input.rulesVersion,
            1,
            2_147_483_647,
            "audit rules version",
          ),
    outcome: normalizeText(input.outcome, 1, 100, "audit outcome"),
    detailsJson: serializeBoundedJson(
      input.details ?? {},
      4_000,
      "Onboarding audit details",
    ),
  };
}

function parseOnboardingConfiguration(
  row: OnboardingConfigurationRow,
): OnboardingConfiguration {
  if (
    row.welcome_title === null ||
    row.welcome_body === null ||
    row.farewell_title === null ||
    row.farewell_body === null
  ) {
    throw new Error(
      "Stored onboarding configuration is missing message templates",
    );
  }
  return {
    guildId: row.guild_id,
    enabled: Boolean(row.enabled),
    welcomeChannelId: row.welcome_channel_id,
    welcomePublicEnabled: Boolean(row.welcome_public_enabled),
    welcomeDmEnabled: Boolean(row.welcome_dm_enabled),
    farewellChannelId: row.farewell_channel_id,
    farewellPublicEnabled: Boolean(row.farewell_public_enabled),
    lifecycleLogChannelId: row.lifecycle_log_channel_id,
    rulesChannelId: row.rules_channel_id,
    verificationEnabled: Boolean(row.verification_enabled),
    currentRulesVersion: row.current_rules_version,
    verifiedRoleId: row.verified_role_id,
    unverifiedRoleId: row.unverified_role_id,
    humanAutorolesEnabled: Boolean(row.human_autoroles_enabled),
    botAutorolesEnabled: Boolean(row.bot_autoroles_enabled),
    accountAgeAlertHours: row.account_age_alert_hours,
    welcomeTitle: row.welcome_title,
    welcomeBody: row.welcome_body,
    farewellTitle: row.farewell_title,
    farewellBody: row.farewell_body,
    welcomeChannelVerifiedAt: row.welcome_channel_verified_at,
    farewellChannelVerifiedAt: row.farewell_channel_verified_at,
    lifecycleLogChannelVerifiedAt: row.lifecycle_log_channel_verified_at,
    rulesChannelVerifiedAt: row.rules_channel_verified_at,
    verificationRolesVerifiedAt: row.verification_roles_verified_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseOnboardingRulesVersion(
  row: OnboardingRulesVersionRow,
): OnboardingRulesVersion {
  return {
    guildId: row.guild_id,
    rulesVersion: row.rules_version,
    title: row.title,
    body: row.body,
    reacceptanceRequested: Boolean(row.reacceptance_requested),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function parseOnboardingAutorole(
  row: OnboardingAutoroleRow,
): OnboardingAutorole {
  return {
    guildId: row.guild_id,
    audience: row.audience as OnboardingAutoroleAudience,
    roleId: row.role_id,
    sortOrder: row.sort_order,
    enabled: Boolean(row.enabled),
    bindingsVerifiedAt: row.bindings_verified_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseMemberOnboardingState(
  row: MemberOnboardingStateRow,
): MemberOnboardingState {
  return {
    guildId: row.guild_id,
    memberId: row.member_id,
    memberKind: row.member_kind as OnboardingAutoroleAudience,
    screeningState: row.screening_state as OnboardingScreeningState,
    lifecycleState: row.lifecycle_state as MemberOnboardingLifecycleState,
    joinedAt: row.joined_at,
    accountCreatedAt: row.account_created_at,
    screeningCompletedAt: row.screening_completed_at,
    departedAt: row.departed_at,
    lastProcessedAt: row.last_processed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseMemberRuleAcceptance(
  row: MemberRuleAcceptanceRow,
): MemberRuleAcceptance {
  return {
    guildId: row.guild_id,
    memberId: row.member_id,
    rulesVersion: row.rules_version,
    acceptedAt: row.accepted_at,
    panelPostId: row.panel_post_id,
  };
}

function parseOnboardingDelivery(
  row: OnboardingDeliveryRow,
): OnboardingDeliveryRecord {
  return {
    guildId: row.guild_id,
    deliveryId: row.delivery_id,
    memberId: row.member_id,
    joinInstance: row.join_instance,
    kind: row.delivery_kind as OnboardingDeliveryKind,
    state: row.delivery_state as OnboardingDeliveryState,
    channelId: row.channel_id,
    messageId: row.message_id,
    attemptCount: row.attempt_count,
    failureCode: row.failure_code,
    claimId: row.claim_id,
    claimExpiresAt: row.claim_expires_at,
    deliveredAt: row.delivered_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseOnboardingRoleOperation(
  row: OnboardingRoleOperationRow,
): OnboardingRoleOperation {
  return {
    guildId: row.guild_id,
    operationId: row.operation_id,
    memberId: row.member_id,
    roleId: row.role_id,
    kind: row.operation_kind as OnboardingRoleOperationKind,
    idempotencyKey: row.idempotency_key,
    state: row.operation_state as RoleOperationState,
    failureCode: row.failure_code,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    resolvedAt: row.resolved_at,
    resolvedByOperationId: row.resolved_by_operation_id,
  };
}

function parseOnboardingAuditEvent(
  row: OnboardingAuditEventRow,
): OnboardingAuditEvent {
  return {
    guildId: row.guild_id,
    eventId: row.event_id,
    eventNumber: row.event_number,
    eventType: row.event_type,
    memberId: row.member_id,
    actorId: row.actor_id,
    rulesVersion: row.rules_version,
    outcome: row.outcome,
    details: parseJson(row.details_json, "onboarding audit details"),
    createdAt: row.created_at,
  };
}

function sameDeliveryCompletion(
  delivery: OnboardingDeliveryRecord,
  input: ReturnType<typeof normalizeDeliveryCompletionInput>,
): boolean {
  return (
    delivery.state === input.state &&
    delivery.channelId === input.channelId &&
    delivery.messageId === input.messageId &&
    delivery.failureCode === input.failureCode
  );
}

function normalizeAutoroleAudience(value: unknown): OnboardingAutoroleAudience {
  return normalizeStringEnum(
    value,
    ONBOARDING_AUTOROLE_AUDIENCES,
    "autorole audience",
  );
}

function normalizeVerificationPreset(value: unknown): "verification" {
  if (value !== "verification") {
    throw new TypeError("Expected the verification panel preset");
  }
  return value;
}

function normalizeStringEnum<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string,
): T[number] {
  if (!values.includes(value as string)) {
    throw new TypeError(`Unsupported ${label}: ${String(value)}`);
  }
  return value as T[number];
}

function normalizeStringEnumList<const T extends readonly string[]>(
  values: readonly string[] | undefined,
  allowed: T,
  label: string,
): T[number][] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values))
    throw new TypeError(`${label} filter must be an array`);
  const normalized = [...new Set(values)];
  return normalized.map((value) => normalizeStringEnum(value, allowed, label));
}

function normalizeNullableSnowflake(
  value: unknown,
  label: string,
): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a Discord snowflake`);
  }
  return assertDiscordSnowflake(value, label);
}

function normalizeBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean")
    throw new TypeError(`${label} must be a boolean`);
  return value;
}

function normalizeInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function normalizeText(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be text`);
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new RangeError(
      `${label} must contain between ${minimum} and ${maximum} characters`,
    );
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError(`${label} contains unsupported control characters`);
  }
  return normalized;
}

function normalizeTokenText(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
  pattern: RegExp,
): string {
  const normalized = normalizeText(value, minimum, maximum, label);
  if (!pattern.test(normalized)) {
    throw new TypeError(`${label} contains unsupported characters`);
  }
  return normalized;
}

function normalizeNullableShortText(
  value: unknown,
  label: string,
): string | null {
  return value === null ? null : normalizeText(value, 1, 100, label);
}

function normalizeTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError(`${label} must be a valid timestamp`);
  }
  return new Date(Date.parse(value)).toISOString();
}

function normalizeNullableTimestamp(
  value: unknown,
  label: string,
): string | null {
  return value === null ? null : normalizeTimestamp(value, label);
}

function normalizeListLimit(value: number, maximum = MAX_LIST_LIMIT): number {
  return normalizeInteger(value, 1, maximum, "list limit");
}

function normalizeOffset(value: number): number {
  return normalizeInteger(value, 0, 2_147_483_647, "list offset");
}

function serializeBoundedJson(
  value: unknown,
  maximumBytes: number,
  label: string,
): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(
      `${label} must be JSON-safe: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, "utf8") > maximumBytes
  ) {
    throw new RangeError(`${label} exceeds the ${maximumBytes}-byte limit`);
  }
  if (serialized.length < 2) {
    throw new TypeError(`${label} must contain a JSON object or collection`);
  }
  return serialized;
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(
      `Stored ${label} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 24 &&
    /^[A-Za-z0-9_-]+$/u.test(value)
  );
}

function normalizeOpaqueId(value: unknown): string | null {
  return isOpaqueId(value) ? value : null;
}

function requireOpaqueId(value: unknown, label: string): string {
  const normalized = normalizeOpaqueId(value);
  if (!normalized) {
    throw new TypeError(`${label} must be an 8-24 character opaque token`);
  }
  return normalized;
}

function allocateOpaqueId(exists: (id: string) => boolean): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = createOpaqueStorageId();
    if (!exists(id)) return id;
  }
  throw new Error("Unable to allocate a unique opaque storage ID");
}

function toSqlBoolean(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

function utcNow(): string {
  return new Date().toISOString();
}

function requireResult<T>(value: T | null, label: string): T {
  if (value === null) throw new Error(`${label} completed without a result`);
  return value;
}
