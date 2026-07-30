import { PermissionFlagsBits, type GuildMember, type Role } from "discord.js";

export type AuthorizationGrant =
  "owner" | "administrator" | "support-role" | "delegated";

export type AuthorizationDenial =
  | "member-unavailable"
  | "guild-mismatch"
  | "owner-mismatch"
  | "support-role-unavailable"
  | "support-role-mismatch"
  | "support-role-everyone"
  | "support-role-managed"
  | "not-authorized";

export type AuthorizationDecision =
  | { allowed: true; reason: AuthorizationGrant }
  | { allowed: false; reason: AuthorizationDenial };

export interface AuthorizationPolicyContext {
  /** The authoritative guild ID for the interaction/runtime. */
  guildId: string;
  /** The authoritative current owner ID from the same fetched guild. */
  ownerId: string;
  /** A member freshly fetched from that guild, or null when verification failed. */
  member: GuildMember | null;
}

export interface TicketStaffAuthorizationContext extends AuthorizationPolicyContext {
  /** The configured support-role ID stored for this guild. */
  supportRoleId: string | null;
  /** The role freshly fetched from this guild, or null when it disappeared. */
  supportRole: Role | null;
}

export interface VerifiedAuthorizationFacts {
  guildId: string;
  ownerId: string;
  memberId: string;
  isOwner: boolean;
  isAdministrator: boolean;
  roleIds: ReadonlySet<string>;
}

export interface SupportRoleFacts {
  guildId: string;
  roleId: string;
  managed: boolean;
}

export interface AuthorizationPolicyExtensions {
  /** Reserved seam for future configured panel/ticket managers. */
  isDelegatedManager?: (facts: VerifiedAuthorizationFacts) => boolean;
  /** Reserved seam for future ticket-specific staff policies. */
  isDelegatedTicketStaff?: (
    facts: VerifiedAuthorizationFacts,
    supportRole: SupportRoleFacts | null,
  ) => boolean;
}

type MemberFactsResult =
  | { valid: true; facts: VerifiedAuthorizationFacts }
  | { valid: false; reason: AuthorizationDenial };

export type SupportRoleValidation =
  | { valid: true; facts: SupportRoleFacts }
  | { valid: false; reason: AuthorizationDenial };

/**
 * Converts a fetched GuildMember into immutable facts after checking that its
 * guild and owner identities match the caller's authoritative context.
 */
export function getVerifiedAuthorizationFacts(
  context: AuthorizationPolicyContext,
): MemberFactsResult {
  const { guildId, ownerId, member } = context;
  if (!member) return { valid: false, reason: "member-unavailable" };
  if (!guildId || member.guild.id !== guildId) {
    return { valid: false, reason: "guild-mismatch" };
  }
  if (!ownerId || member.guild.ownerId !== ownerId) {
    return { valid: false, reason: "owner-mismatch" };
  }

  return {
    valid: true,
    facts: {
      guildId,
      ownerId,
      memberId: member.id,
      isOwner: member.id === ownerId,
      isAdministrator: member.permissions.has(
        PermissionFlagsBits.Administrator,
      ),
      roleIds: new Set(member.roles.cache.keys()),
    },
  };
}

/** Validates a configured support role without consulting cached role names. */
export function validateSupportRole(
  guildId: string,
  supportRoleId: string | null,
  supportRole: Role | null,
): SupportRoleValidation {
  if (!supportRoleId || !supportRole) {
    return { valid: false, reason: "support-role-unavailable" };
  }
  if (
    !guildId ||
    supportRole.guild.id !== guildId ||
    supportRole.id !== supportRoleId
  ) {
    return { valid: false, reason: "support-role-mismatch" };
  }
  if (supportRole.id === guildId) {
    return { valid: false, reason: "support-role-everyone" };
  }
  if (supportRole.managed) {
    return { valid: false, reason: "support-role-managed" };
  }
  return {
    valid: true,
    facts: {
      guildId,
      roleId: supportRole.id,
      managed: false,
    },
  };
}

/** Owner-or-Administrator policy shared by configuration and panel posting. */
export function evaluatePanelManagement(
  context: AuthorizationPolicyContext,
  extensions: AuthorizationPolicyExtensions = {},
): AuthorizationDecision {
  const verified = getVerifiedAuthorizationFacts(context);
  if (!verified.valid) {
    return { allowed: false, reason: verified.reason };
  }
  if (verified.facts.isOwner) return { allowed: true, reason: "owner" };
  if (verified.facts.isAdministrator) {
    return { allowed: true, reason: "administrator" };
  }
  if (extensions.isDelegatedManager?.(verified.facts) === true) {
    return { allowed: true, reason: "delegated" };
  }
  return { allowed: false, reason: "not-authorized" };
}

/** Shared owner/Administrator gate for all current guild configuration. */
export const evaluateGuildManagement = evaluatePanelManagement;

/** Ticket setup uses the same policy as all other panel configuration. */
export const evaluateTicketConfiguration = evaluatePanelManagement;

/** Support-role-or-owner-or-Administrator policy for ticket staff actions. */
export function evaluateTicketStaff(
  context: TicketStaffAuthorizationContext,
  extensions: AuthorizationPolicyExtensions = {},
): AuthorizationDecision {
  const verified = getVerifiedAuthorizationFacts(context);
  if (!verified.valid) {
    return { allowed: false, reason: verified.reason };
  }
  if (verified.facts.isOwner) return { allowed: true, reason: "owner" };
  if (verified.facts.isAdministrator) {
    return { allowed: true, reason: "administrator" };
  }

  const role = validateSupportRole(
    context.guildId,
    context.supportRoleId,
    context.supportRole,
  );
  if (role.valid && verified.facts.roleIds.has(role.facts.roleId)) {
    return { allowed: true, reason: "support-role" };
  }
  if (
    extensions.isDelegatedTicketStaff?.(
      verified.facts,
      role.valid ? role.facts : null,
    ) === true ||
    extensions.isDelegatedManager?.(verified.facts) === true
  ) {
    return { allowed: true, reason: "delegated" };
  }
  if (!role.valid) return { allowed: false, reason: role.reason };
  return { allowed: false, reason: "not-authorized" };
}

export function canManagePanels(
  context: AuthorizationPolicyContext,
  extensions: AuthorizationPolicyExtensions = {},
): boolean {
  return evaluatePanelManagement(context, extensions).allowed;
}

export const canManageTicketConfiguration = canManagePanels;

export function isTicketStaff(
  context: TicketStaffAuthorizationContext,
  extensions: AuthorizationPolicyExtensions = {},
): boolean {
  return evaluateTicketStaff(context, extensions).allowed;
}
