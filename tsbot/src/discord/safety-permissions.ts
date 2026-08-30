import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type Role,
  type TextChannel,
} from "discord.js";
import type { ModerationConfiguration } from "../types.js";
import type { GuildCapability, RoleCapabilityGrant } from "../types.js";
import { fetchAndValidateRole } from "./authorization.js";
import {
  fetchCurrentBotMember,
  fetchGuildMemberCoalesced,
  fetchGuildRoleCoalesced,
} from "./fetch-coalescing.js";

export type SafetyWorkflow = "reports" | "appeals";

export interface SafetyWorkflowResources {
  reviewChannel: TextChannel | null;
  reviewerRole: Role | null;
  botMember: GuildMember | null;
  issues: string[];
}

export interface SafetyCapabilityGrantReader {
  listCapabilityGrantsForCapability(
    capability: GuildCapability,
    limit?: number,
    offset?: number,
  ): readonly RoleCapabilityGrant[];
}

export async function inspectSafetyWorkflowResources(
  guild: Guild,
  configuration: ModerationConfiguration,
  workflow: SafetyWorkflow,
  grants?: SafetyCapabilityGrantReader,
): Promise<SafetyWorkflowResources> {
  if (configuration.guildId !== guild.id) {
    return empty("Safety configuration belongs to another server.");
  }
  const channelId =
    workflow === "reports"
      ? configuration.reportReviewChannelId
      : configuration.appealReviewChannelId;
  const roleId =
    workflow === "reports"
      ? configuration.reportReviewerRoleId
      : configuration.appealReviewerRoleId;
  const label = workflow === "reports" ? "report" : "appeal";
  if (!channelId || !roleId) {
    return empty(
      `The private ${label} review channel and reviewer role are required.`,
    );
  }
  const capability: GuildCapability =
    workflow === "reports" ? "reports.review" : "appeals.review";
  const delegatedGrants =
    grants?.listCapabilityGrantsForCapability(capability, 100, 0) ?? [];
  const [channelValue, roleValidation, botMember, delegatedRoles] =
    await Promise.all([
      guild.channels
        .fetch(channelId, { cache: true, force: true })
        .catch(() => null),
      fetchAndValidateRole(guild, roleId),
      fetchCurrentBotMember(guild, { force: true }),
      Promise.all(
        delegatedGrants.map((grant) =>
          fetchGuildRoleCoalesced(guild, grant.roleId, {
            cache: true,
            force: true,
          }),
        ),
      ),
    ]);
  const reviewChannel =
    channelValue?.type === ChannelType.GuildText &&
    channelValue.guild.id === guild.id
      ? channelValue
      : null;
  const reviewerRole = roleValidation.valid ? roleValidation.role : null;
  const issues: string[] = [];
  if (!reviewChannel) {
    issues.push(
      `The configured private ${label} review channel is missing or invalid.`,
    );
  }
  if (!reviewerRole) {
    issues.push(
      `The configured ${label} reviewer role is missing, managed, @everyone, or from another server.`,
    );
  }
  if (!botMember || botMember.guild.id !== guild.id) {
    issues.push("Superior could not verify its current server membership.");
  } else if (reviewChannel) {
    requireAccess(
      reviewChannel,
      botMember,
      `${label} review channel`,
      true,
      issues,
    );
  }
  if (reviewChannel) {
    if (
      reviewChannel
        .permissionsFor(guild.roles.everyone)
        ?.has(PermissionFlagsBits.ViewChannel)
    ) {
      issues.push(
        `The ${label} review channel is visible to @everyone; choose a private staff channel.`,
      );
    }
    if (reviewerRole) {
      requireAccess(
        reviewChannel,
        reviewerRole,
        `${label} reviewer role`,
        false,
        issues,
      );
      const expectedViewAllowIds = new Set([
        reviewerRole.id,
        botMember?.id,
        guild.ownerId,
        ...delegatedRoles
          .filter(
            (role): role is Role =>
              role !== null &&
              role.guild.id === guild.id &&
              role.id !== guild.id &&
              !role.managed,
          )
          .map((role) => role.id),
      ]);
      for (const role of botMember?.roles?.cache?.values?.() ?? []) {
        if (isBotIntegrationRole(botMember, role.id)) {
          expectedViewAllowIds.add(role.id);
        }
      }
      const candidateViewAllows =
        reviewChannel.permissionOverwrites.cache.filter(
          (overwrite) =>
            overwrite.allow.has(PermissionFlagsBits.ViewChannel) &&
            !expectedViewAllowIds.has(overwrite.id),
        );
      const administratorChecks = await Promise.all(
        [...candidateViewAllows.keys()].map((id) =>
          isFreshAdministratorPrincipal(guild, id),
        ),
      );
      if (administratorChecks.some((allowed) => !allowed)) {
        issues.push(
          `The ${label} review channel grants View Channel to unrelated role or member overwrites; remove those grants to preserve confidentiality.`,
        );
      }
    }
  }
  return { reviewChannel, reviewerRole, botMember, issues };
}

function isBotIntegrationRole(
  botMember: GuildMember | null,
  roleId: string,
): boolean {
  const role = botMember?.roles.cache.get(roleId);
  return Boolean(role?.managed && role.tags?.botId === botMember?.id);
}

async function isFreshAdministratorPrincipal(
  guild: Guild,
  principalId: string,
): Promise<boolean> {
  let role: Role | null = null;
  try {
    role = await fetchGuildRoleCoalesced(guild, principalId, {
      cache: true,
      force: true,
    });
  } catch {
    // It may be a member overwrite instead of a role overwrite.
  }
  if (
    role?.guild.id === guild.id &&
    role.id !== guild.id &&
    role.permissions.has(PermissionFlagsBits.Administrator)
  ) {
    return true;
  }
  let member: GuildMember | null = null;
  try {
    member = await fetchGuildMemberCoalesced(guild, principalId, {
      cache: true,
      force: true,
    });
  } catch {
    return false;
  }
  return Boolean(
    member?.guild.id === guild.id &&
    member.permissions.has(PermissionFlagsBits.Administrator),
  );
}

export async function inspectModerationLogChannel(
  guild: Guild,
  channelId: string | null,
): Promise<{ channel: TextChannel | null; issues: string[] }> {
  if (!channelId) return { channel: null, issues: [] };
  const [channelValue, botMember] = await Promise.all([
    guild.channels
      .fetch(channelId, { cache: true, force: true })
      .catch(() => null),
    fetchCurrentBotMember(guild, { force: true }),
  ]);
  const channel =
    channelValue?.type === ChannelType.GuildText &&
    channelValue.guild.id === guild.id
      ? channelValue
      : null;
  const issues: string[] = [];
  if (!channel)
    issues.push(
      "The moderation log must be a standard text channel in this server.",
    );
  if (!botMember || botMember.guild.id !== guild.id) {
    issues.push("Superior could not verify its current server membership.");
  } else if (channel) {
    requireAccess(channel, botMember, "moderation log channel", true, issues);
  }
  return { channel, issues };
}

function requireAccess(
  channel: TextChannel,
  subject: GuildMember | Role,
  label: string,
  embedLinks: boolean,
  issues: string[],
): void {
  const permissions = channel.permissionsFor(subject);
  const required = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    ...(embedLinks
      ? [PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles]
      : []),
  ];
  if (
    !permissions ||
    required.some((permission) => !permissions.has(permission))
  ) {
    issues.push(
      `${label} needs View Channel, Send Messages, Read Message History${embedLinks ? ", Embed Links, and Attach Files" : ""}.`,
    );
  }
}

function empty(issue: string): SafetyWorkflowResources {
  return {
    reviewChannel: null,
    reviewerRole: null,
    botMember: null,
    issues: [issue],
  };
}
