import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type Role,
} from "discord.js";
import type { GuildCapability } from "../types.js";
import {
  authorizeCapability,
  fetchVerifiedGuildMember,
  type CapabilityAuthorizationDecision,
  type CapabilityGrantReader,
} from "./authorization.js";
import { assignableRoleSafetyIssue } from "./role-policy.js";
import {
  fetchCurrentBotMember as fetchCoalescedBotMember,
  fetchGuildRoleCoalesced,
} from "./fetch-coalescing.js";

export interface OnboardingChannelInspection {
  readonly channel: GuildTextBasedChannel | null;
  readonly botMember: GuildMember | null;
  readonly issues: readonly string[];
}

export interface OnboardingRoleInspection {
  readonly role: Role | null;
  readonly botMember: GuildMember | null;
  readonly issues: readonly string[];
}

export function authorizeOnboardingCapability(
  guild: Guild,
  userId: string,
  grants: CapabilityGrantReader,
  capability: Extract<
    GuildCapability,
    "onboarding.configure" | "roles.configure"
  > = "onboarding.configure",
): Promise<CapabilityAuthorizationDecision> {
  return authorizeCapability({ guild, userId, grants, capability });
}

export async function fetchCurrentOnboardingMember(
  guild: Guild,
  userId: string,
): Promise<GuildMember | null> {
  const verified = await fetchVerifiedGuildMember(guild, userId);
  return verified.valid ? verified.member : null;
}

export async function fetchCurrentBotMember(
  guild: Guild,
  options: { readonly force?: boolean } = { force: true },
): Promise<GuildMember | null> {
  const member = await fetchCoalescedBotMember(guild, options);
  return member?.guild.id === guild.id && member.user.bot ? member : null;
}

export async function fetchOnboardingTextChannel(
  guild: Guild,
  channelId: string,
): Promise<GuildTextBasedChannel | null> {
  if (!/^\d{17,20}$/u.test(channelId)) return null;
  const channel = await guild.channels
    .fetch(channelId, { cache: true, force: true })
    .catch(() => null);
  if (
    !channel ||
    channel.guild.id !== guild.id ||
    (channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement)
  ) {
    return null;
  }
  return channel;
}

export async function inspectOnboardingChannel(
  guild: Guild,
  channelId: string | null,
  label: string,
): Promise<OnboardingChannelInspection> {
  const [channel, botMember] = await Promise.all([
    channelId
      ? fetchOnboardingTextChannel(guild, channelId)
      : Promise.resolve(null),
    fetchCurrentBotMember(guild),
  ]);
  const issues: string[] = [];
  if (!channel) {
    issues.push(`${label} is missing or is not a server text channel.`);
  }
  if (!botMember) {
    issues.push("Superior could not verify its current server membership.");
  } else if (channel) {
    const permissionIssue = onboardingChannelPermissionIssue(
      channel,
      botMember,
      label,
    );
    if (permissionIssue) issues.push(permissionIssue);
  }
  return { channel, botMember, issues };
}

export function onboardingChannelPermissionIssue(
  channel: GuildTextBasedChannel,
  botMember: GuildMember,
  label: string,
): string | null {
  if (channel.guild.id !== botMember.guild.id) {
    return `${label} does not belong to this server.`;
  }
  const permissions = channel.permissionsFor(botMember);
  const sendPermission = channel.isThread()
    ? PermissionFlagsBits.SendMessagesInThreads
    : PermissionFlagsBits.SendMessages;
  const required = [
    PermissionFlagsBits.ViewChannel,
    sendPermission,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.EmbedLinks,
  ];
  return !permissions ||
    required.some((permission) => !permissions.has(permission))
    ? `Superior needs View Channel, Send Messages, Read Message History, and Embed Links in ${label}.`
    : null;
}

export async function fetchOnboardingRole(
  guild: Guild,
  roleId: string,
): Promise<Role | null> {
  if (!/^\d{17,20}$/u.test(roleId)) return null;
  const role = await fetchGuildRoleCoalesced(guild, roleId, {
    cache: true,
    force: true,
  });
  return role?.guild.id === guild.id && role.id === roleId ? role : null;
}

export async function inspectAssignableOnboardingRole(
  guild: Guild,
  roleId: string | null,
  actor: GuildMember | null = null,
): Promise<OnboardingRoleInspection> {
  const [role, botMember] = await Promise.all([
    roleId ? fetchOnboardingRole(guild, roleId) : Promise.resolve(null),
    fetchCurrentBotMember(guild),
  ]);
  const issues: string[] = [];
  if (!role) issues.push("The selected role is missing or invalid.");
  if (!botMember) {
    issues.push("Superior could not verify its current server membership.");
  } else if (role) {
    const issue = assignableRoleSafetyIssue(role, {
      guildId: guild.id,
      botMember,
      actor,
    });
    if (issue) issues.push(issue);
  }
  return { role, botMember, issues };
}

/**
 * The unverified role is removal-only. It still must be a current, manageable
 * guild role, but its existing permissions do not turn removal into elevation.
 */
export async function inspectRemovableOnboardingRole(
  guild: Guild,
  roleId: string | null,
  actor: GuildMember | null = null,
): Promise<OnboardingRoleInspection> {
  const [role, botMember] = await Promise.all([
    roleId ? fetchOnboardingRole(guild, roleId) : Promise.resolve(null),
    fetchCurrentBotMember(guild),
  ]);
  const issues: string[] = [];
  if (!role) {
    issues.push("The selected unverified role is missing or invalid.");
  } else if (role.id === guild.id) {
    issues.push("The @everyone role cannot be the unverified role.");
  } else if (role.managed) {
    issues.push("A managed role cannot be the unverified role.");
  }
  if (!botMember) {
    issues.push("Superior could not verify its current server membership.");
  } else if (role) {
    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
      issues.push("Superior needs Manage Roles to remove the unverified role.");
    } else if (botMember.roles.highest.comparePositionTo(role) <= 0) {
      issues.push("Superior's highest role must be above the unverified role.");
    }
    if (
      actor &&
      actor.guild.id === guild.id &&
      actor.id !== guild.ownerId &&
      actor.roles.highest.comparePositionTo(role) <= 0
    ) {
      issues.push("Your highest role must be above the unverified role.");
    }
  }
  return { role, botMember, issues };
}
