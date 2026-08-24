import { PermissionFlagsBits, type GuildMember, type Role } from "discord.js";

export const DANGEROUS_ASSIGNABLE_ROLE_PERMISSIONS = Object.freeze([
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.MentionEveryone,
] as const);

export const DANGEROUS_ASSIGNABLE_ROLE_PERMISSION_MASK =
  DANGEROUS_ASSIGNABLE_ROLE_PERMISSIONS.reduce(
    (mask, permission) => mask | permission,
    0n,
  );

export interface AssignableRoleSafetyContext {
  readonly guildId: string;
  readonly botMember: GuildMember;
  readonly actor?: GuildMember | null;
}

/** Shared policy for automatic roles and persistent self-service menu roles. */
export function assignableRoleSafetyIssue(
  role: Role,
  context: AssignableRoleSafetyContext,
): string | null {
  if (role.guild.id !== context.guildId) {
    return "That role does not belong to this server.";
  }
  if (role.id === context.guildId) {
    return "The @everyone role cannot be assigned by onboarding or role menus.";
  }
  if (role.managed) {
    return "Managed, integration, bot-managed, and subscription roles cannot be assigned by onboarding or role menus.";
  }
  if (
    (role.permissions.bitfield & DANGEROUS_ASSIGNABLE_ROLE_PERMISSION_MASK) !==
    0n
  ) {
    return "Roles with dangerous server-management permissions cannot be assigned automatically or through a role menu.";
  }
  if (
    context.botMember.guild.id !== context.guildId ||
    context.botMember.user.bot !== true
  ) {
    return "Superior could not verify its current server membership.";
  }
  if (!context.botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return "Superior needs Manage Roles to assign this role.";
  }
  if (context.botMember.roles.highest.comparePositionTo(role) <= 0) {
    return "Superior's highest role must be above this role.";
  }
  const actor = context.actor;
  if (
    actor &&
    actor.guild.id === context.guildId &&
    actor.id !== actor.guild.ownerId &&
    actor.roles.highest.comparePositionTo(role) <= 0
  ) {
    return "Your highest role must be above this role.";
  }
  return null;
}

export function prerequisiteRoleSafetyIssue(
  role: Role,
  guildId: string,
): string | null {
  if (role.guild.id !== guildId) {
    return "The prerequisite role does not belong to this server.";
  }
  if (role.id === guildId) {
    return "The @everyone role cannot be a role-menu prerequisite.";
  }
  if (role.managed) {
    return "A managed role cannot be a role-menu prerequisite.";
  }
  return null;
}
