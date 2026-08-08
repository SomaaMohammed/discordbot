import {
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type Role,
} from "discord.js";
import type { GuildCapability, RoleCapabilityGrant } from "./capabilities.js";

export type CapabilityAuthorizationGrant =
  | "owner"
  | "administrator"
  | "configured-role"
  | "support-role"
  | "reviewer-role"
  | "delegated";

export type CapabilityAuthorizationDenial =
  | "member-unavailable"
  | "guild-mismatch"
  | "delegation-unavailable"
  | "configured-role-unavailable"
  | "configured-role-mismatch"
  | "configured-role-everyone"
  | "configured-role-managed"
  | "delegated-role-unavailable"
  | "delegated-role-mismatch"
  | "delegated-role-everyone"
  | "delegated-role-managed"
  | "not-authorized";

export type CapabilityAuthorizationDecision =
  | {
      allowed: true;
      reason: CapabilityAuthorizationGrant;
      capability: GuildCapability;
      member: GuildMember;
      roleId: string | null;
    }
  | {
      allowed: false;
      reason: CapabilityAuthorizationDenial;
      capability: GuildCapability;
      member: GuildMember | null;
    };

export interface CapabilityGrantReader {
  listCapabilitiesForRoles(
    roleIds: readonly string[],
  ): readonly RoleCapabilityGrant[];
}

export interface CapabilityAuthorizationContext {
  guild: Guild;
  userId: string;
  capability: GuildCapability;
  grants: CapabilityGrantReader;
}

export interface ConfiguredRoleAuthorizationContext extends CapabilityAuthorizationContext {
  configuredRoleId: string | null;
  configuredRoleReason?: "configured-role" | "support-role" | "reviewer-role";
}

export type SpecializedRoleAuthorizationContext = Omit<
  ConfiguredRoleAuthorizationContext,
  "configuredRoleReason"
>;

type MemberVerification =
  | { valid: true; member: GuildMember }
  | {
      valid: false;
      member: GuildMember | null;
      reason: "member-unavailable" | "guild-mismatch";
    };

export type VerifiedRoleResult =
  | { valid: true; role: Role }
  | {
      valid: false;
      reason:
        "role-unavailable" | "role-mismatch" | "role-everyone" | "role-managed";
    };

/** Fetches the actor instead of trusting interaction member payloads or caches. */
export async function fetchVerifiedGuildMember(
  guild: Guild,
  userId: string,
): Promise<MemberVerification> {
  if (!guild || !userId) {
    return { valid: false, member: null, reason: "member-unavailable" };
  }
  const member = await guild.members
    .fetch({ user: userId, cache: true, force: true })
    .catch(() => null);
  if (!member) {
    return { valid: false, member: null, reason: "member-unavailable" };
  }
  if (member.guild.id !== guild.id || member.guild.ownerId !== guild.ownerId) {
    return { valid: false, member, reason: "guild-mismatch" };
  }
  return { valid: true, member };
}

export type UltimateAuthorityDecision =
  | {
      allowed: true;
      reason: "owner" | "administrator";
      member: GuildMember;
    }
  | {
      allowed: false;
      reason: "member-unavailable" | "guild-mismatch" | "not-authorized";
      member: GuildMember | null;
    };

/** Owner/Administrator-only gate used for delegation mutation itself. */
export async function authorizeOwnerOrAdministrator(
  guild: Guild,
  userId: string,
): Promise<UltimateAuthorityDecision> {
  const verified = await fetchVerifiedGuildMember(guild, userId);
  if (!verified.valid) {
    return {
      allowed: false,
      reason: verified.reason,
      member: verified.member,
    };
  }
  if (verified.member.id === guild.ownerId) {
    return { allowed: true, reason: "owner", member: verified.member };
  }
  if (verified.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return {
      allowed: true,
      reason: "administrator",
      member: verified.member,
    };
  }
  return {
    allowed: false,
    reason: "not-authorized",
    member: verified.member,
  };
}

/**
 * Authorizes one narrowly scoped capability. Owner and Administrator checks
 * intentionally happen before delegated storage is read, preserving recovery
 * access when delegated configuration is missing or malformed.
 */
export async function authorizeCapability(
  context: CapabilityAuthorizationContext,
): Promise<CapabilityAuthorizationDecision> {
  const verified = await fetchVerifiedGuildMember(
    context.guild,
    context.userId,
  );
  if (!verified.valid) {
    return denied(context.capability, verified.reason, verified.member);
  }
  const ultimate = evaluateUltimateAuthority(
    verified.member,
    context.capability,
  );
  if (ultimate) return ultimate;
  return authorizeDelegatedCapability(context, verified.member);
}

/**
 * Shared support/reviewer policy: current owner, current Administrator, a
 * freshly verified configured role, or a freshly verified delegated role.
 */
export async function authorizeConfiguredRoleOrCapability(
  context: ConfiguredRoleAuthorizationContext,
): Promise<CapabilityAuthorizationDecision> {
  const verified = await fetchVerifiedGuildMember(
    context.guild,
    context.userId,
  );
  if (!verified.valid) {
    return denied(context.capability, verified.reason, verified.member);
  }
  const ultimate = evaluateUltimateAuthority(
    verified.member,
    context.capability,
  );
  if (ultimate) return ultimate;

  let configuredRoleDenial: CapabilityAuthorizationDenial | null = null;
  if (context.configuredRoleId) {
    const configuredRole = await fetchAndValidateRole(
      context.guild,
      context.configuredRoleId,
    );
    if (configuredRole.valid) {
      if (verified.member.roles.cache.has(configuredRole.role.id)) {
        return {
          allowed: true,
          reason: context.configuredRoleReason ?? "configured-role",
          capability: context.capability,
          member: verified.member,
          roleId: configuredRole.role.id,
        };
      }
    } else {
      configuredRoleDenial = mapRoleDenial(configuredRole.reason, "configured");
    }
  } else {
    configuredRoleDenial = "configured-role-unavailable";
  }

  const delegated = await authorizeDelegatedCapability(
    context,
    verified.member,
  );
  if (delegated.allowed || delegated.reason !== "not-authorized") {
    return delegated;
  }
  return configuredRoleDenial
    ? denied(context.capability, configuredRoleDenial, verified.member)
    : delegated;
}

export function authorizeSupportRoleOrCapability(
  context: SpecializedRoleAuthorizationContext,
): Promise<CapabilityAuthorizationDecision> {
  return authorizeConfiguredRoleOrCapability({
    ...context,
    configuredRoleReason: "support-role",
  });
}

export function authorizeReviewerRoleOrCapability(
  context: SpecializedRoleAuthorizationContext,
): Promise<CapabilityAuthorizationDecision> {
  return authorizeConfiguredRoleOrCapability({
    ...context,
    configuredRoleReason: "reviewer-role",
  });
}

function evaluateUltimateAuthority(
  member: GuildMember,
  capability: GuildCapability,
): CapabilityAuthorizationDecision | null {
  if (member.id === member.guild.ownerId) {
    return {
      allowed: true,
      reason: "owner",
      capability,
      member,
      roleId: null,
    };
  }
  if (member.permissions.has(PermissionFlagsBits.Administrator)) {
    return {
      allowed: true,
      reason: "administrator",
      capability,
      member,
      roleId: null,
    };
  }
  return null;
}

async function authorizeDelegatedCapability(
  context: CapabilityAuthorizationContext,
  member: GuildMember,
): Promise<CapabilityAuthorizationDecision> {
  const memberRoleIds = [...member.roles.cache.keys()].filter(
    (roleId) => roleId !== context.guild.id,
  );
  let grants: readonly RoleCapabilityGrant[];
  try {
    grants = context.grants.listCapabilitiesForRoles(memberRoleIds);
  } catch {
    return denied(context.capability, "delegation-unavailable", member);
  }
  if (!Array.isArray(grants)) {
    return denied(context.capability, "delegation-unavailable", member);
  }

  const matchingRoleIds = new Set<string>();
  for (const grant of grants) {
    if (
      grant &&
      grant.active === true &&
      grant.guildId === context.guild.id &&
      grant.principalType === "role" &&
      grant.principalId === grant.roleId &&
      grant.capability === context.capability &&
      member.roles.cache.has(grant.roleId)
    ) {
      matchingRoleIds.add(grant.roleId);
    }
  }
  if (matchingRoleIds.size === 0) {
    return denied(context.capability, "not-authorized", member);
  }

  let invalidReason: CapabilityAuthorizationDenial | null = null;
  for (const roleId of matchingRoleIds) {
    const role = await fetchAndValidateRole(context.guild, roleId);
    if (!role.valid) {
      invalidReason ??= mapRoleDenial(role.reason, "delegated");
      continue;
    }
    if (!member.roles.cache.has(role.role.id)) continue;
    return {
      allowed: true,
      reason: "delegated",
      capability: context.capability,
      member,
      roleId: role.role.id,
    };
  }
  return denied(context.capability, invalidReason ?? "not-authorized", member);
}

export async function fetchAndValidateRole(
  guild: Guild,
  roleId: string,
): Promise<VerifiedRoleResult> {
  const role = await guild.roles
    .fetch(roleId, { cache: true, force: true })
    .catch(() => null);
  if (!role) return { valid: false, reason: "role-unavailable" };
  if (role.guild.id !== guild.id || role.id !== roleId) {
    return { valid: false, reason: "role-mismatch" };
  }
  if (role.id === guild.id) {
    return { valid: false, reason: "role-everyone" };
  }
  if (role.managed) return { valid: false, reason: "role-managed" };
  return { valid: true, role };
}

function mapRoleDenial(
  reason: Exclude<VerifiedRoleResult, { valid: true }>["reason"],
  kind: "configured" | "delegated",
): CapabilityAuthorizationDenial {
  switch (reason) {
    case "role-unavailable":
      return `${kind}-role-unavailable`;
    case "role-mismatch":
      return `${kind}-role-mismatch`;
    case "role-everyone":
      return `${kind}-role-everyone`;
    case "role-managed":
      return `${kind}-role-managed`;
  }
}

function denied(
  capability: GuildCapability,
  reason: CapabilityAuthorizationDenial,
  member: GuildMember | null,
): CapabilityAuthorizationDecision {
  return { allowed: false, reason, capability, member };
}
