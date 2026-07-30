import {
  ChannelType,
  OverwriteType,
  PermissionFlagsBits,
  type CategoryChannel,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type OverwriteResolvable,
  type Role,
  type TextChannel,
} from "discord.js";
import type { TicketConfiguration, TicketRecord } from "../types.js";
import { validateSupportRole } from "./ticket-authorization.js";

export interface TicketConfigurationResources {
  category: CategoryChannel | null;
  logChannel: GuildTextBasedChannel | null;
  supportRole: Role | null;
  botMember: GuildMember | null;
  issues: string[];
}

export async function inspectTicketConfigurationResources(
  guild: Guild,
  configuration: TicketConfiguration,
): Promise<TicketConfigurationResources> {
  const [rawCategory, rawLogChannel, supportRole, botMember] =
    await Promise.all([
      guild.channels.fetch(configuration.categoryId).catch(() => null),
      guild.channels.fetch(configuration.logChannelId).catch(() => null),
      guild.roles.fetch(configuration.supportRoleId).catch(() => null),
      guild.members.me ?? guild.members.fetchMe().catch(() => null),
    ]);
  const category =
    rawCategory?.guild.id === guild.id &&
    rawCategory.type === ChannelType.GuildCategory
      ? rawCategory
      : null;
  const logChannel = isTicketLogChannel(rawLogChannel, guild.id)
    ? rawLogChannel
    : null;
  const issues: string[] = [];
  if (!category) issues.push("The configured ticket category is missing.");
  if (!logChannel) issues.push("The configured ticket log channel is missing.");
  const supportValidation = validateSupportRole(
    guild.id,
    configuration.supportRoleId,
    supportRole,
  );
  if (!supportValidation.valid) {
    issues.push(supportRoleIssue(supportValidation.reason));
  }
  if (!botMember || botMember.guild.id !== guild.id) {
    issues.push("Superior's current server membership could not be verified.");
  } else {
    issues.push(
      ...getTicketPermissionIssues(
        category,
        logChannel,
        supportRole,
        botMember,
      ),
    );
  }
  return {
    category,
    logChannel,
    supportRole:
      supportValidation.valid && supportRole?.guild.id === guild.id
        ? supportRole
        : null,
    botMember,
    issues: [...new Set(issues)],
  };
}

export function validateTicketSetupResources(
  guild: Guild,
  category: CategoryChannel,
  logChannel: GuildTextBasedChannel,
  supportRole: Role,
  actor: GuildMember,
  botMember: GuildMember,
): string[] {
  const issues: string[] = [];
  if (
    category.guild.id !== guild.id ||
    category.type !== ChannelType.GuildCategory
  ) {
    issues.push("Choose a category from this server.");
  }
  if (!isTicketLogChannel(logChannel, guild.id)) {
    issues.push("Choose a text or announcement log channel from this server.");
  }
  const supportValidation = validateSupportRole(
    guild.id,
    supportRole.id,
    supportRole,
  );
  if (!supportValidation.valid) {
    issues.push(supportRoleIssue(supportValidation.reason));
  }
  if (actor.guild.id !== guild.id) {
    issues.push("Your current server membership could not be verified.");
  } else if (
    actor.id !== guild.ownerId &&
    actor.roles.highest.comparePositionTo(supportRole) <= 0
  ) {
    issues.push("Your highest role must be above the selected support role.");
  }
  if (botMember.guild.id !== guild.id) {
    issues.push("Superior's current server membership could not be verified.");
  } else {
    issues.push(
      ...getTicketPermissionIssues(
        category,
        logChannel,
        supportValidation.valid ? supportRole : null,
        botMember,
      ),
    );
  }
  return [...new Set(issues)];
}

export function canPostThemedPanel(
  channel: GuildTextBasedChannel,
  botMember: GuildMember,
): boolean {
  if (channel.guild.id !== botMember.guild.id) return false;
  const permissions = channel.permissionsFor(botMember);
  return Boolean(
    permissions?.has(PermissionFlagsBits.ViewChannel) &&
    permissions.has(PermissionFlagsBits.SendMessages) &&
    permissions.has(PermissionFlagsBits.EmbedLinks) &&
    permissions.has(PermissionFlagsBits.ReadMessageHistory),
  );
}

export function canDeliverTicketLog(
  channel: GuildTextBasedChannel,
  botMember: GuildMember,
): boolean {
  if (channel.guild.id !== botMember.guild.id) return false;
  const permissions = channel.permissionsFor(botMember);
  return Boolean(
    permissions?.has(PermissionFlagsBits.ViewChannel) &&
    permissions.has(PermissionFlagsBits.SendMessages) &&
    permissions.has(PermissionFlagsBits.ReadMessageHistory) &&
    permissions.has(PermissionFlagsBits.EmbedLinks) &&
    permissions.has(PermissionFlagsBits.AttachFiles),
  );
}

export function buildPrivateTicketPermissionOverwrites(
  guild: Guild,
  resources: Pick<
    TicketConfigurationResources,
    "category" | "supportRole" | "botMember"
  >,
  ticket: TicketRecord,
  options: { includeOpener?: boolean } = {},
): OverwriteResolvable[] {
  const { supportRole, botMember } = requireTicketChannelResources(
    guild,
    resources,
  );
  const permissionOverwrites: OverwriteResolvable[] = [
    {
      id: guild.roles.everyone.id,
      type: OverwriteType.Role,
      deny: [PermissionFlagsBits.ViewChannel],
    },
  ];
  if (options.includeOpener !== false) {
    permissionOverwrites.push({
      id: ticket.openerId,
      type: OverwriteType.Member,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    });
  }
  permissionOverwrites.push(
    {
      id: supportRole.id,
      type: OverwriteType.Role,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    },
    {
      id: botMember.id,
      type: OverwriteType.Member,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ManageChannels,
      ],
    },
  );
  return permissionOverwrites;
}

export async function createPrivateTicketChannel(
  guild: Guild,
  resources: Pick<
    TicketConfigurationResources,
    "category" | "supportRole" | "botMember"
  >,
  ticket: TicketRecord,
  options: { includeOpener?: boolean } = {},
): Promise<TextChannel> {
  const { category } = requireTicketChannelResources(guild, resources);
  const permissionOverwrites = buildPrivateTicketPermissionOverwrites(
    guild,
    resources,
    ticket,
    options,
  );
  return guild.channels.create({
    name: buildTicketChannelName(ticket.ticketNumber, ticket.subject),
    type: ChannelType.GuildText,
    parent: category.id,
    topic: buildTicketChannelTopic(ticket),
    permissionOverwrites,
    reason: `Superior ticket #${ticket.ticketNumber} opened by ${ticket.openerId}`,
  });
}

export async function reconcilePrivateTicketChannel(
  guild: Guild,
  channel: TextChannel,
  resources: Pick<
    TicketConfigurationResources,
    "category" | "supportRole" | "botMember"
  >,
  ticket: TicketRecord,
  options: { includeOpener?: boolean } = {},
): Promise<TextChannel> {
  const { category } = requireTicketChannelResources(guild, resources);
  if (channel.guild.id !== guild.id || channel.type !== ChannelType.GuildText) {
    throw new Error("Ticket channel does not belong to this server.");
  }
  return channel.edit({
    parent: category.id,
    topic: buildTicketChannelTopic(ticket),
    permissionOverwrites: buildPrivateTicketPermissionOverwrites(
      guild,
      resources,
      ticket,
      options,
    ),
    reason: `Superior ticket #${ticket.ticketNumber} permission recovery`,
  });
}

export async function quarantinePrivateTicketChannel(
  guild: Guild,
  channel: TextChannel,
  botMember: GuildMember,
  ticket: TicketRecord,
  options: { includeOpener?: boolean } = {},
): Promise<TextChannel> {
  if (
    channel.guild.id !== guild.id ||
    channel.type !== ChannelType.GuildText ||
    botMember.guild.id !== guild.id
  ) {
    throw new Error(
      "Ticket quarantine resources do not belong to this server.",
    );
  }
  const permissionOverwrites: OverwriteResolvable[] = [
    {
      id: guild.roles.everyone.id,
      type: OverwriteType.Role,
      deny: [PermissionFlagsBits.ViewChannel],
    },
  ];
  if (options.includeOpener !== false) {
    permissionOverwrites.push({
      id: ticket.openerId,
      type: OverwriteType.Member,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    });
  }
  permissionOverwrites.push({
    id: botMember.id,
    type: OverwriteType.Member,
    allow: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.ManageChannels,
    ],
  });
  return channel.edit({
    permissionOverwrites,
    reason: `Superior quarantined stale ticket #${ticket.ticketNumber} permissions`,
  });
}

function getTicketPermissionIssues(
  category: CategoryChannel | null,
  logChannel: GuildTextBasedChannel | null,
  supportRole: Role | null,
  botMember: GuildMember,
): string[] {
  const issues: string[] = [];
  if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
    issues.push("Superior needs Manage Channels to create and remove tickets.");
  }
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    issues.push(
      "Superior needs Manage Roles to create and reconcile private ticket permission overwrites.",
    );
  }
  if (
    supportRole &&
    botMember.roles.highest.comparePositionTo(supportRole) <= 0
  ) {
    issues.push("Superior's highest role must be above the support role.");
  }
  if (category) {
    const permissions = category.permissionsFor(botMember);
    const required = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.ManageRoles,
    ];
    if (
      !permissions ||
      required.some((permission) => !permissions.has(permission))
    ) {
      issues.push(
        "Superior needs View Channel, Send Messages, Read Message History, Embed Links, Attach Files, Manage Channels, and Manage Roles in the ticket category.",
      );
    }
  }
  if (logChannel) {
    const permissions = logChannel.permissionsFor(botMember);
    const required = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.AttachFiles,
    ];
    if (
      !permissions ||
      required.some((permission) => !permissions.has(permission))
    ) {
      issues.push(
        "Superior needs View Channel, Send Messages, Read Message History, Embed Links, and Attach Files in the ticket log channel.",
      );
    }
  }
  return issues;
}

function isTicketLogChannel(
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

function buildTicketChannelName(ticketNumber: number, subject: string): string {
  const slug = subject
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
  return `ticket-${ticketNumber}-${slug || "support"}`.slice(0, 100);
}

function buildTicketChannelTopic(ticket: TicketRecord): string {
  return `Superior ticket #${ticket.ticketNumber} · opener ${ticket.openerId} · ${ticket.subject} · ${ticketChannelRecoveryMarker(ticket.ticketId)}`.slice(
    0,
    1_024,
  );
}

export function ticketChannelRecoveryMarker(ticketId: string): string {
  return `superior-ref:${ticketId}`;
}

function requireTicketChannelResources(
  guild: Guild,
  resources: Pick<
    TicketConfigurationResources,
    "category" | "supportRole" | "botMember"
  >,
): {
  category: CategoryChannel;
  supportRole: Role;
  botMember: GuildMember;
} {
  const { category, supportRole, botMember } = resources;
  if (!category || !supportRole || !botMember) {
    throw new Error("Ticket resources are incomplete.");
  }
  if (
    category.guild.id !== guild.id ||
    supportRole.guild.id !== guild.id ||
    botMember.guild.id !== guild.id
  ) {
    throw new Error("Ticket resources do not belong to this server.");
  }
  return { category, supportRole, botMember };
}

function supportRoleIssue(reason: string): string {
  switch (reason) {
    case "support-role-everyone":
      return "The @everyone role cannot be the ticket support role.";
    case "support-role-managed":
      return "Managed or integration roles cannot be the ticket support role.";
    case "support-role-mismatch":
      return "The configured support role does not belong to this server.";
    default:
      return "The configured ticket support role is missing.";
  }
}
