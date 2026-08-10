import {
  ChannelType,
  PermissionFlagsBits,
  type ForumChannel,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type MediaChannel,
  type NewsChannel,
  type Role,
  type TextChannel,
} from "discord.js";
import { logError, logInfo, logWarn } from "../logging.js";
import type {
  RestrictedPingAddMappingInput,
  RestrictedPingAddMappingResult,
  RestrictedPingCleanupResult,
  RestrictedPingCompletionResult,
  RestrictedPingConfigureInput,
  RestrictedPingMapping,
  RestrictedPingRemoveMappingResult,
  RestrictedPingReservationInput,
  RestrictedPingReservationResult,
  RestrictedPingRoleConfiguration,
} from "../types.js";
import {
  fetchAndValidateRole,
  fetchVerifiedGuildMember,
} from "./authorization.js";

export type RestrictedPingParentChannel =
  TextChannel | NewsChannel | ForumChannel | MediaChannel;

export interface RestrictedPingRepository {
  getRestrictedPingRole(roleId: string): RestrictedPingRoleConfiguration | null;
  listRestrictedPingRoles(
    limit?: number,
    offset?: number,
  ): RestrictedPingRoleConfiguration[];
  countRestrictedPingRoles(): number;
  listRestrictedPingMappings(
    roleId: string,
    limit?: number,
    offset?: number,
  ): RestrictedPingMapping[];
  addRestrictedPingMapping(
    input: RestrictedPingAddMappingInput,
  ): RestrictedPingAddMappingResult;
  removeRestrictedPingMapping(
    roleId: string,
    channelId: string,
    removedBy: string,
  ): RestrictedPingRemoveMappingResult;
  configureRestrictedPingRole(
    roleId: string,
    update: RestrictedPingConfigureInput,
  ): RestrictedPingRoleConfiguration | null;
  setRestrictedPingRoleEnabled(
    roleId: string,
    enabled: boolean,
    updatedBy: string,
    bindingsVerifiedAt?: string | null,
  ): RestrictedPingRoleConfiguration | null;
  reserveRestrictedPing(
    input: RestrictedPingReservationInput,
  ): RestrictedPingReservationResult;
  completeRestrictedPing(
    reservationId: string,
    messageId?: string | null,
  ): RestrictedPingCompletionResult;
  releaseRestrictedPing(reservationId: string, reason?: string): boolean;
  cleanupRestrictedPingRole(
    roleId: string,
    actorId?: string,
  ): RestrictedPingCleanupResult;
  cleanupRestrictedPingChannel(
    channelId: string,
    actorId?: string,
  ): RestrictedPingCleanupResult;
}

const DANGEROUS_RESTRICTED_PING_ROLE_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.MentionEveryone,
  PermissionFlagsBits.ManageWebhooks,
].reduce((mask, permission) => mask | permission, 0n);

export type RestrictedPingRoleIssue =
  | "role-unavailable"
  | "role-mismatch"
  | "role-everyone"
  | "role-managed"
  | "role-mentionable"
  | "role-dangerous";

export type RestrictedPingBindingIssue =
  | RestrictedPingRoleIssue
  | "channel-unavailable"
  | "channel-mismatch"
  | "channel-type"
  | "bot-unavailable"
  | "bot-view"
  | "bot-send"
  | "bot-send-in-threads"
  | "bot-mention-everyone";

export type RestrictedPingBindingInspection =
  | {
      valid: true;
      role: Role;
      channel: RestrictedPingParentChannel;
      botMember: GuildMember;
    }
  | { valid: false; issue: RestrictedPingBindingIssue };

export type RestrictedPingRoleInspection =
  | { valid: true; role: Role }
  | { valid: false; issue: RestrictedPingRoleIssue };

export type RestrictedPingExecutionResult =
  | { status: "sent"; role: Role; channelId: string; messageId: string }
  | {
      status:
        | "not-configured"
        | "disabled"
        | "channel-not-allowed"
        | "thread-not-allowed";
      role: Role | null;
    }
  | {
      status: "member-unavailable" | "bot-invoker" | "member-missing-role";
      role: Role | null;
    }
  | {
      status: "role-invalid";
      role: Role | null;
      issue: RestrictedPingRoleIssue;
    }
  | {
      status: "channel-unavailable" | "member-permissions" | "bot-permissions";
      role: Role | null;
    }
  | {
      status: "cooldown";
      role: Role;
      scope: "user" | "role" | "active";
      retryAt: string;
    }
  | {
      status: "cancelled" | "delivery-failed" | "delivery-unverified";
      role: Role;
    };

export async function inspectRestrictedPingRole(
  guild: Guild,
  roleId: string,
): Promise<RestrictedPingRoleInspection> {
  const verified = await fetchAndValidateRole(guild, roleId);
  if (!verified.valid) {
    return { valid: false, issue: verified.reason };
  }
  if (verified.role.mentionable) {
    return { valid: false, issue: "role-mentionable" };
  }
  if (
    (verified.role.permissions.bitfield &
      DANGEROUS_RESTRICTED_PING_ROLE_PERMISSIONS) !==
    0n
  ) {
    return { valid: false, issue: "role-dangerous" };
  }

  // Role hierarchy controls role mutation, not role mentions. Superior never
  // edits or temporarily toggles a restricted role, so a role above the bot is
  // safe when Discord's channel mention permission checks below succeed.
  return { valid: true, role: verified.role };
}

export async function inspectRestrictedPingBinding(
  guild: Guild,
  roleId: string,
  channelId: string,
  allowThreads: boolean,
): Promise<RestrictedPingBindingInspection> {
  const [roleResult, rawChannel, botMember] = await Promise.all([
    inspectRestrictedPingRole(guild, roleId),
    guild.channels
      .fetch(channelId, { cache: true, force: true })
      .catch(() => null),
    guild.members.fetchMe({ cache: true, force: true }).catch(() => null),
  ]);
  if (!roleResult.valid) return roleResult;
  if (!rawChannel) return { valid: false, issue: "channel-unavailable" };
  if (rawChannel.guild.id !== guild.id || rawChannel.id !== channelId) {
    return { valid: false, issue: "channel-mismatch" };
  }
  if (!isRestrictedPingParentChannel(rawChannel, guild.id)) {
    return { valid: false, issue: "channel-type" };
  }
  if (!botMember || botMember.guild.id !== guild.id) {
    return { valid: false, issue: "bot-unavailable" };
  }
  const accessIssue = configuredChannelBotAccessIssue(
    rawChannel,
    botMember,
    allowThreads,
  );
  if (accessIssue) return { valid: false, issue: accessIssue };
  return {
    valid: true,
    role: roleResult.role,
    channel: rawChannel,
    botMember,
  };
}

export async function executeRestrictedPing(options: {
  guild: Guild;
  userId: string;
  roleId: string;
  channelId: string;
  repository: RestrictedPingRepository;
  isCurrent: () => boolean;
}): Promise<RestrictedPingExecutionResult> {
  const { guild, repository } = options;
  const configuration = repository.getRestrictedPingRole(options.roleId);
  if (
    !configuration ||
    configuration.guildId !== guild.id ||
    configuration.roleId !== options.roleId
  ) {
    return { status: "not-configured", role: null };
  }
  if (!configuration.enabled) {
    return { status: "disabled", role: null };
  }

  const [memberResult, roleResult, rawChannel, botMember] = await Promise.all([
    fetchVerifiedGuildMember(guild, options.userId),
    inspectRestrictedPingRole(guild, options.roleId),
    guild.channels
      .fetch(options.channelId, { cache: true, force: true })
      .catch(() => null),
    guild.members.fetchMe({ cache: true, force: true }).catch(() => null),
  ]);
  if (!memberResult.valid) {
    return { status: "member-unavailable", role: null };
  }
  if (memberResult.member.user.bot) {
    logWarn("restricted-ping", "Bot account attempted restricted role ping", {
      guildId: guild.id,
      userId: memberResult.member.id,
      roleId: options.roleId,
      channelId: options.channelId,
    });
    return { status: "bot-invoker", role: null };
  }
  if (memberResult.member.isCommunicationDisabled()) {
    return { status: "member-permissions", role: null };
  }
  if (!roleResult.valid) {
    return { status: "role-invalid", role: null, issue: roleResult.issue };
  }
  const role = roleResult.role;
  if (!memberResult.member.roles.cache.has(role.id)) {
    return { status: "member-missing-role", role };
  }
  if (
    !rawChannel ||
    rawChannel.guild.id !== guild.id ||
    rawChannel.id !== options.channelId ||
    !rawChannel.isTextBased() ||
    !rawChannel.isSendable()
  ) {
    return { status: "channel-unavailable", role };
  }
  const channel: GuildTextBasedChannel = rawChannel;
  let mappingChannelId = channel.id;
  if (channel.isThread()) {
    if (!configuration.allowThreads) {
      return { status: "thread-not-allowed", role };
    }
    if (!channel.parentId) {
      return { status: "channel-unavailable", role };
    }
    const parent = await guild.channels
      .fetch(channel.parentId, { cache: true, force: true })
      .catch(() => null);
    if (!parent || !isRestrictedPingParentChannel(parent, guild.id)) {
      return { status: "channel-unavailable", role };
    }
    mappingChannelId = parent.id;
  } else if (
    channel.type !== ChannelType.GuildText &&
    channel.type !== ChannelType.GuildAnnouncement
  ) {
    return { status: "channel-unavailable", role };
  }

  if (!botMember || botMember.guild.id !== guild.id) {
    return { status: "bot-permissions", role };
  }
  if (!hasInvokerChannelPermissions(channel, memberResult.member)) {
    return { status: "member-permissions", role };
  }
  if (!hasBotChannelPermissions(channel, botMember)) {
    return { status: "bot-permissions", role };
  }
  if (!options.isCurrent()) {
    return { status: "cancelled", role };
  }

  const reservation = repository.reserveRestrictedPing({
    roleId: role.id,
    userId: memberResult.member.id,
    channelId: channel.id,
    mappingChannelId,
    source: "command",
  });
  if (reservation.status !== "reserved") {
    switch (reservation.status) {
      case "not-configured":
        return { status: "not-configured", role };
      case "disabled":
        return { status: "disabled", role };
      case "channel-not-allowed":
        return { status: "channel-not-allowed", role };
      case "active-reservation":
      case "user-cooldown":
      case "role-cooldown":
        return {
          status: "cooldown",
          role,
          scope:
            reservation.status === "active-reservation"
              ? "active"
              : reservation.status === "user-cooldown"
                ? "user"
                : "role",
          retryAt: reservation.retryAt,
        };
    }
  }

  if (!options.isCurrent()) {
    releaseReservation(
      repository,
      reservation.reservationId,
      "Server configuration changed before delivery",
      guild.id,
      role.id,
      memberResult.member.id,
    );
    return { status: "cancelled", role };
  }

  let message;
  try {
    message = await channel.send({
      content: `<@&${role.id}>`,
      allowedMentions: {
        roles: [role.id],
        users: [],
        repliedUser: false,
      },
    });
  } catch (error) {
    releaseReservation(
      repository,
      reservation.reservationId,
      "Discord delivery failed",
      guild.id,
      role.id,
      memberResult.member.id,
    );
    logError("restricted-ping", "Restricted role ping delivery failed", {
      guildId: guild.id,
      channelId: channel.id,
      mappingChannelId,
      roleId: role.id,
      userId: memberResult.member.id,
      source: "command",
      error,
    });
    return { status: "delivery-failed", role };
  }

  if (
    message.guildId !== guild.id ||
    message.channelId !== channel.id ||
    !message.mentions.roles.has(role.id)
  ) {
    await message.delete().catch(() => undefined);
    // Discord accepted the message, so the notification may already have
    // reached members even when the returned mention metadata is incomplete.
    // Keep the durable reservation until its lease expires to prevent an
    // immediate retry from producing duplicate notifications.
    logError("restricted-ping", "Restricted role ping was not verified", {
      guildId: guild.id,
      channelId: channel.id,
      mappingChannelId,
      roleId: role.id,
      userId: memberResult.member.id,
      messageId: message.id,
      source: "command",
    });
    return { status: "delivery-unverified", role };
  }

  try {
    const completion = repository.completeRestrictedPing(
      reservation.reservationId,
      message.id,
    );
    if (completion.status !== "completed") {
      logError(
        "restricted-ping",
        "Delivered restricted role ping lost its reservation",
        {
          guildId: guild.id,
          channelId: channel.id,
          mappingChannelId,
          roleId: role.id,
          userId: memberResult.member.id,
          messageId: message.id,
          reservationId: reservation.reservationId,
        },
      );
    }
  } catch (error) {
    // The notification already occurred. Never release a delivered reservation,
    // because doing so could authorize an immediate duplicate notification.
    logError("restricted-ping", "Could not finalize delivered role ping", {
      guildId: guild.id,
      channelId: channel.id,
      mappingChannelId,
      roleId: role.id,
      userId: memberResult.member.id,
      messageId: message.id,
      reservationId: reservation.reservationId,
      error,
    });
  }

  logInfo("restricted-ping", "Restricted role ping delivered", {
    guildId: guild.id,
    channelId: channel.id,
    mappingChannelId,
    roleId: role.id,
    userId: memberResult.member.id,
    messageId: message.id,
    source: "command",
    result: "success",
  });
  return { status: "sent", role, channelId: channel.id, messageId: message.id };
}

export function restrictedPingRoleIssueMessage(
  issue: RestrictedPingRoleIssue,
): string {
  switch (issue) {
    case "role-unavailable":
      return "That role no longer exists or could not be verified.";
    case "role-mismatch":
      return "That role does not belong to this server.";
    case "role-everyone":
      return "The @everyone role can never be used for restricted pings.";
    case "role-managed":
      return "Bot, integration, booster, and other managed roles cannot be used for restricted pings.";
    case "role-mentionable":
      return "Turn off this role's 'Allow anyone to @mention this role' setting before configuring it.";
    case "role-dangerous":
      return "Roles with administrative, moderation, role-management, or broad mention permissions cannot be used for restricted pings.";
  }
}

export function restrictedPingBindingIssueMessage(
  issue: RestrictedPingBindingIssue,
): string {
  if (issue.startsWith("role-")) {
    return restrictedPingRoleIssueMessage(issue as RestrictedPingRoleIssue);
  }
  switch (issue) {
    case "channel-unavailable":
      return "That channel no longer exists or could not be verified.";
    case "channel-mismatch":
      return "That channel does not belong to this server.";
    case "channel-type":
      return "Choose a text, announcement, forum, or media channel from this server.";
    case "bot-unavailable":
      return "Superior could not verify its current server membership.";
    case "bot-view":
      return "Superior needs View Channel in that channel.";
    case "bot-send":
      return "Superior needs Send Messages in that channel.";
    case "bot-send-in-threads":
      return "Superior needs Send Messages in Threads for that channel.";
    case "bot-mention-everyone":
      return "Superior needs Mention @everyone, @here, and All Roles in that channel to notify a non-mentionable role.";
  }
  return restrictedPingRoleIssueMessage(issue as RestrictedPingRoleIssue);
}

function isRestrictedPingParentChannel(
  channel: unknown,
  guildId: string,
): channel is RestrictedPingParentChannel {
  if (!channel || typeof channel !== "object" || !("guild" in channel)) {
    return false;
  }
  const candidate = channel as RestrictedPingParentChannel;
  return (
    candidate.guild.id === guildId &&
    (candidate.type === ChannelType.GuildText ||
      candidate.type === ChannelType.GuildAnnouncement ||
      candidate.type === ChannelType.GuildForum ||
      candidate.type === ChannelType.GuildMedia)
  );
}

function configuredChannelBotAccessIssue(
  channel: RestrictedPingParentChannel,
  botMember: GuildMember,
  allowThreads: boolean,
): RestrictedPingBindingIssue | null {
  const permissions = channel.permissionsFor(botMember);
  if (!permissions?.has(PermissionFlagsBits.ViewChannel)) return "bot-view";
  if (!permissions.has(PermissionFlagsBits.MentionEveryone)) {
    return "bot-mention-everyone";
  }
  if (
    channel.type === ChannelType.GuildForum ||
    channel.type === ChannelType.GuildMedia
  ) {
    return permissions.has(PermissionFlagsBits.SendMessagesInThreads)
      ? null
      : "bot-send-in-threads";
  }
  if (!permissions.has(PermissionFlagsBits.SendMessages)) return "bot-send";
  if (
    allowThreads &&
    !permissions.has(PermissionFlagsBits.SendMessagesInThreads)
  ) {
    return "bot-send-in-threads";
  }
  return null;
}

function hasInvokerChannelPermissions(
  channel: GuildTextBasedChannel,
  member: GuildMember,
): boolean {
  const permissions = channel.permissionsFor(member);
  const sendPermission = channel.isThread()
    ? PermissionFlagsBits.SendMessagesInThreads
    : PermissionFlagsBits.SendMessages;
  return Boolean(
    permissions?.has(PermissionFlagsBits.ViewChannel) &&
    permissions.has(PermissionFlagsBits.UseApplicationCommands) &&
    permissions.has(sendPermission),
  );
}

function hasBotChannelPermissions(
  channel: GuildTextBasedChannel,
  botMember: GuildMember,
): boolean {
  const permissions = channel.permissionsFor(botMember);
  const sendPermission = channel.isThread()
    ? PermissionFlagsBits.SendMessagesInThreads
    : PermissionFlagsBits.SendMessages;
  return Boolean(
    permissions?.has(PermissionFlagsBits.ViewChannel) &&
    permissions.has(sendPermission) &&
    permissions.has(PermissionFlagsBits.MentionEveryone) &&
    (!channel.isThread() || channel.sendable),
  );
}

function releaseReservation(
  repository: RestrictedPingRepository,
  reservationId: string,
  reason: string,
  guildId: string,
  roleId: string,
  userId: string,
): void {
  try {
    repository.releaseRestrictedPing(reservationId, reason);
  } catch (error) {
    logError("restricted-ping", "Could not release ping reservation", {
      guildId,
      roleId,
      userId,
      reservationId,
      error,
    });
  }
}
