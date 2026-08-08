import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type Role,
  type TextChannel,
} from "discord.js";
import type {
  ApplicationForm,
  SuggestionConfiguration,
  TicketDepartment,
} from "../types.js";
import { validateSupportRole } from "./ticket-authorization.js";

export interface SuggestionResources {
  channel: GuildTextBasedChannel | null;
  reviewChannel: GuildTextBasedChannel | null;
  reviewerRole: Role | null;
  botMember: GuildMember | null;
  issues: string[];
}

export interface ApplicationResources {
  reviewChannel: TextChannel | null;
  reviewerRole: Role | null;
  botMember: GuildMember | null;
  issues: string[];
}

const APPLICATION_REVIEW_ROLE_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
] as const;

export function applicationReviewRoleAccessIssue(
  reviewChannel: TextChannel,
  role: Role,
): string | null {
  if (reviewChannel.guild.id !== role.guild.id) {
    return "The delegated reviewer role and application review channel belong to different servers.";
  }
  const permissions = reviewChannel.permissionsFor(role);
  if (
    !permissions ||
    APPLICATION_REVIEW_ROLE_PERMISSIONS.some(
      (permission) => !permissions.has(permission),
    )
  ) {
    return "The delegated reviewer role needs View Channel, Send Messages, and Read Message History in the private application review channel.";
  }
  return null;
}

export async function inspectSuggestionResources(
  guild: Guild,
  configuration: SuggestionConfiguration,
): Promise<SuggestionResources> {
  if (configuration.guildId !== guild.id) {
    return emptySuggestionResources(
      "Suggestion configuration belongs to another server.",
    );
  }
  const [channelValue, reviewValue, role, botMember] = await Promise.all([
    guild.channels
      .fetch(configuration.suggestionChannelId, {
        cache: true,
        force: true,
      })
      .catch(() => null),
    configuration.reviewChannelId
      ? guild.channels
          .fetch(configuration.reviewChannelId, { cache: true, force: true })
          .catch(() => null)
      : Promise.resolve(null),
    guild.roles
      .fetch(configuration.reviewerRoleId, { cache: true, force: true })
      .catch(() => null),
    guild.members.fetchMe({ cache: true, force: true }).catch(() => null),
  ]);
  const channel = isPublicTextChannel(channelValue, guild.id)
    ? channelValue
    : null;
  const reviewChannel = isPublicTextChannel(reviewValue, guild.id)
    ? reviewValue
    : null;
  const roleValidation = validateSupportRole(
    guild.id,
    configuration.reviewerRoleId,
    role,
  );
  const reviewerRole = roleValidation.valid ? role : null;
  const issues: string[] = [];
  if (!channel)
    issues.push("The configured suggestion channel is missing or invalid.");
  if (configuration.reviewChannelId && !reviewChannel) {
    issues.push(
      "The configured suggestion review channel is missing or invalid.",
    );
  }
  if (!reviewerRole)
    issues.push(roleIssue("suggestion reviewer", roleValidation));
  if (!botMember || botMember.guild.id !== guild.id) {
    issues.push("Superior could not verify its current server membership.");
  } else {
    if (channel) {
      requireChannelPermissions(
        channel,
        botMember,
        issues,
        "suggestion channel",
        [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.EmbedLinks,
        ],
      );
      if (configuration.createThreads) {
        if (channel.type !== ChannelType.GuildText) {
          issues.push(
            "Suggestion discussion threads require a standard text channel.",
          );
        } else {
          requireChannelPermissions(
            channel,
            botMember,
            issues,
            "suggestion channel",
            [
              PermissionFlagsBits.CreatePublicThreads,
              PermissionFlagsBits.SendMessagesInThreads,
            ],
          );
        }
      }
    }
    if (reviewChannel) {
      requireChannelPermissions(
        reviewChannel,
        botMember,
        issues,
        "suggestion review channel",
        [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.EmbedLinks,
        ],
      );
    }
  }
  return { channel, reviewChannel, reviewerRole, botMember, issues };
}

export async function inspectApplicationResources(
  guild: Guild,
  form: ApplicationForm,
): Promise<ApplicationResources> {
  if (form.guildId !== guild.id) {
    return emptyApplicationResources(
      "Application form belongs to another server.",
    );
  }
  const [channelValue, role, botMember] = await Promise.all([
    guild.channels
      .fetch(form.reviewChannelId, { cache: true, force: true })
      .catch(() => null),
    guild.roles
      .fetch(form.reviewerRoleId, { cache: true, force: true })
      .catch(() => null),
    guild.members.fetchMe({ cache: true, force: true }).catch(() => null),
  ]);
  const reviewChannel =
    channelValue?.type === ChannelType.GuildText &&
    channelValue.guild.id === guild.id
      ? channelValue
      : null;
  const roleValidation = validateSupportRole(
    guild.id,
    form.reviewerRoleId,
    role,
  );
  const reviewerRole = roleValidation.valid ? role : null;
  const issues: string[] = [];
  if (!reviewChannel) {
    issues.push(
      "The configured private application review channel is missing or invalid.",
    );
  }
  if (!reviewerRole)
    issues.push(roleIssue("application reviewer", roleValidation));
  if (!botMember || botMember.guild.id !== guild.id) {
    issues.push("Superior could not verify its current server membership.");
  } else if (reviewChannel) {
    requireChannelPermissions(
      reviewChannel,
      botMember,
      issues,
      "application review channel",
      [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.EmbedLinks,
      ],
    );
    if (
      reviewChannel
        .permissionsFor(guild.roles.everyone)
        ?.has(PermissionFlagsBits.ViewChannel)
    ) {
      issues.push(
        "The application review channel is visible to @everyone; choose a private staff channel.",
      );
    }
    if (reviewerRole) {
      const reviewerIssue = applicationReviewRoleAccessIssue(
        reviewChannel,
        reviewerRole,
      );
      if (reviewerIssue) issues.push(reviewerIssue);
    }
  }
  return { reviewChannel, reviewerRole, botMember, issues };
}

export function isConfiguredDepartment(
  department: TicketDepartment,
): department is TicketDepartment & {
  categoryId: string;
  logChannelId: string;
  supportRoleId: string;
} {
  return Boolean(
    department.categoryId &&
    department.logChannelId &&
    department.supportRoleId,
  );
}

function isPublicTextChannel(
  channel: unknown,
  guildId: string,
): channel is GuildTextBasedChannel {
  if (!channel || typeof channel !== "object") return false;
  const candidate = channel as GuildTextBasedChannel;
  return Boolean(
    candidate.guild?.id === guildId &&
    (candidate.type === ChannelType.GuildText ||
      candidate.type === ChannelType.GuildAnnouncement) &&
    !candidate.isDMBased(),
  );
}

function requireChannelPermissions(
  channel: GuildTextBasedChannel,
  subject: GuildMember | Role,
  issues: string[],
  label: string,
  required: readonly bigint[],
): void {
  const permissions = channel.permissionsFor(subject);
  if (
    !permissions ||
    required.some((permission) => !permissions.has(permission))
  ) {
    issues.push(`Superior is missing required permissions in the ${label}.`);
  }
}

function roleIssue(
  label: string,
  validation: ReturnType<typeof validateSupportRole>,
): string {
  if (!validation.valid && validation.reason === "support-role-managed") {
    return `The ${label} role cannot be managed by an integration.`;
  }
  if (!validation.valid && validation.reason === "support-role-everyone") {
    return `The ${label} role cannot be @everyone.`;
  }
  return `The configured ${label} role is missing or belongs to another server.`;
}

function emptySuggestionResources(issue: string): SuggestionResources {
  return {
    channel: null,
    reviewChannel: null,
    reviewerRole: null,
    botMember: null,
    issues: [issue],
  };
}

function emptyApplicationResources(issue: string): ApplicationResources {
  return {
    reviewChannel: null,
    reviewerRole: null,
    botMember: null,
    issues: [issue],
  };
}
