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
import type {
  RoleCapabilityGrant,
  TicketConfiguration,
  TicketRecord,
} from "../types.js";
import { fetchAndValidateRole } from "./authorization.js";
import { validateSupportRole } from "./ticket-authorization.js";
import {
  fetchCurrentBotMember,
  fetchGuildRoleCoalesced,
} from "./fetch-coalescing.js";

export const MAX_TICKET_MANAGER_ROLES = 25;
const TICKET_MANAGER_GRANT_PAGE_SIZE = 100;
const TICKET_MANAGER_GRANT_SCAN_LIMIT = 1_000;
const TICKET_MANAGER_ROLE_FETCH_BATCH_SIZE = 25;
const MAX_CHANNEL_PERMISSION_OVERWRITES = 100;

export interface TicketManagementGrantReader {
  listCapabilityGrantsForCapability(
    capability: "tickets.manage",
    limit?: number,
    offset?: number,
  ): readonly RoleCapabilityGrant[];
}

export interface TicketConfigurationResources {
  category: CategoryChannel | null;
  logChannel: GuildTextBasedChannel | null;
  supportRole: Role | null;
  managerRoles: Role[];
  botMember: GuildMember | null;
  issues: string[];
}

export async function inspectTicketConfigurationResources(
  guild: Guild,
  configuration: TicketConfiguration,
  grants?: TicketManagementGrantReader,
): Promise<TicketConfigurationResources> {
  const [rawCategory, rawLogChannel, supportRole, botMember, managers] =
    await Promise.all([
      guild.channels
        .fetch(configuration.categoryId, { cache: true, force: true })
        .catch(() => null),
      guild.channels
        .fetch(configuration.logChannelId, { cache: true, force: true })
        .catch(() => null),
      fetchGuildRoleCoalesced(guild, configuration.supportRoleId, {
        cache: true,
        force: true,
      }),
      fetchCurrentBotMember(guild, { force: true }),
      inspectTicketManagerRoles(guild, grants),
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
        managers.roles,
        botMember,
      ),
    );
  }
  issues.push(...managers.issues);
  return {
    category,
    logChannel,
    supportRole:
      supportValidation.valid && supportRole?.guild.id === guild.id
        ? supportRole
        : null,
    managerRoles: managers.roles,
    botMember,
    issues: [...new Set(issues)],
  };
}

export async function inspectTicketManagerRoles(
  guild: Guild,
  grants?: TicketManagementGrantReader,
): Promise<{ roles: Role[]; issues: string[] }> {
  if (!grants) return { roles: [], issues: [] };
  let scanned: TicketManagerGrantScan;
  try {
    scanned = scanTicketManagerGrantRoleIds(guild.id, grants);
  } catch {
    return {
      roles: [],
      issues: ["Superior could not read delegated ticket-management access."],
    };
  }
  if (scanned.status === "unavailable") {
    return {
      roles: [],
      issues: ["Superior could not read delegated ticket-management access."],
    };
  }
  if (scanned.status === "scan-limit") {
    return {
      roles: [],
      issues: [
        `Superior found more than ${TICKET_MANAGER_GRANT_SCAN_LIMIT} active tickets.manage grant records and cannot safely build private-channel access. Revoke stale grants before opening or recovering tickets.`,
      ],
    };
  }
  const roles: Role[] = [];
  for (
    let offset = 0;
    offset < scanned.roleIds.length;
    offset += TICKET_MANAGER_ROLE_FETCH_BATCH_SIZE
  ) {
    const batch = scanned.roleIds.slice(
      offset,
      offset + TICKET_MANAGER_ROLE_FETCH_BATCH_SIZE,
    );
    const verified = await Promise.all(
      batch.map((roleId) => fetchAndValidateRole(guild, roleId)),
    );
    for (const result of verified) {
      if (result.valid) roles.push(result.role);
    }
    if (roles.length > MAX_TICKET_MANAGER_ROLES) {
      return tooManyTicketManagerRoles();
    }
  }
  return { roles, issues: [] };
}

type TicketManagerGrantScan =
  | { status: "complete"; roleIds: string[] }
  | { status: "scan-limit" }
  | { status: "unavailable" };

function scanTicketManagerGrantRoleIds(
  guildId: string,
  grants: TicketManagementGrantReader,
): TicketManagerGrantScan {
  const roleIds = new Set<string>();
  let offset = 0;
  while (offset < TICKET_MANAGER_GRANT_SCAN_LIMIT) {
    const limit = Math.min(
      TICKET_MANAGER_GRANT_PAGE_SIZE,
      TICKET_MANAGER_GRANT_SCAN_LIMIT - offset,
    );
    const page = grants.listCapabilityGrantsForCapability(
      "tickets.manage",
      limit,
      offset,
    );
    if (!Array.isArray(page) || page.length > limit) {
      return { status: "unavailable" };
    }
    for (const grant of page) {
      if (
        grant?.active === true &&
        grant.guildId === guildId &&
        grant.principalType === "role" &&
        grant.principalId === grant.roleId &&
        grant.capability === "tickets.manage"
      ) {
        roleIds.add(grant.roleId);
      }
    }
    offset += page.length;
    if (page.length < limit) {
      return { status: "complete", roleIds: [...roleIds] };
    }
  }

  const probe = grants.listCapabilityGrantsForCapability(
    "tickets.manage",
    1,
    TICKET_MANAGER_GRANT_SCAN_LIMIT,
  );
  if (!Array.isArray(probe) || probe.length > 1) {
    return { status: "unavailable" };
  }
  return probe.length === 0
    ? { status: "complete", roleIds: [...roleIds] }
    : { status: "scan-limit" };
}

function tooManyTicketManagerRoles(): { roles: Role[]; issues: string[] } {
  return {
    roles: [],
    issues: [
      `Private ticket channels support at most ${MAX_TICKET_MANAGER_ROLES} delegated tickets.manage roles. Revoke unused grants before opening or recovering tickets.`,
    ],
  };
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
    "category" | "supportRole" | "managerRoles" | "botMember"
  >,
  ticket: TicketRecord,
  options: { includeOpener?: boolean } = {},
): OverwriteResolvable[] {
  const { supportRole, managerRoles, botMember } =
    requireTicketChannelResources(guild, resources);
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
  const configuredRoleIds = new Set([supportRole.id]);
  for (const managerRole of managerRoles) {
    if (configuredRoleIds.has(managerRole.id)) continue;
    configuredRoleIds.add(managerRole.id);
    permissionOverwrites.splice(permissionOverwrites.length - 1, 0, {
      id: managerRole.id,
      type: OverwriteType.Role,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    });
  }
  return permissionOverwrites;
}

export async function createPrivateTicketChannel(
  guild: Guild,
  resources: Pick<
    TicketConfigurationResources,
    "category" | "supportRole" | "managerRoles" | "botMember"
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
    topic: buildTicketChannelTopic(ticket, managedTicketRoleIds(resources)),
    permissionOverwrites,
    reason: `Superior ticket #${ticket.ticketNumber} opened by ${ticket.openerId}`,
  });
}

export async function reconcilePrivateTicketChannel(
  guild: Guild,
  channel: TextChannel,
  resources: Pick<
    TicketConfigurationResources,
    "category" | "supportRole" | "managerRoles" | "botMember"
  >,
  ticket: TicketRecord,
  options: { includeOpener?: boolean } = {},
): Promise<TextChannel> {
  const { category, botMember } = requireTicketChannelResources(
    guild,
    resources,
  );
  if (channel.guild.id !== guild.id || channel.type !== ChannelType.GuildText) {
    throw new Error("Ticket channel does not belong to this server.");
  }
  const desired = buildPrivateTicketPermissionOverwrites(
    guild,
    resources,
    ticket,
    options,
  );
  const permissionOverwrites = reconcileTicketPermissionOverwrites(
    channel,
    desired,
    ticket,
    botMember.id,
  );
  return channel.edit({
    parent: category.id,
    topic: buildTicketChannelTopic(ticket, managedTicketRoleIds(resources)),
    permissionOverwrites,
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
  managerRoles: readonly Role[],
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
  for (const managerRole of managerRoles) {
    if (
      managerRole.guild.id !== botMember.guild.id ||
      botMember.roles.highest.comparePositionTo(managerRole) <= 0
    ) {
      issues.push(
        `Superior's highest role must be above delegated ticket-management role ${managerRole.id}.`,
      );
    }
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

function buildTicketChannelTopic(
  ticket: TicketRecord,
  managedRoleIds: readonly string[],
): string {
  return `Superior ticket #${ticket.ticketNumber} · opener ${ticket.openerId} · ${ticketChannelRecoveryMarker(ticket.ticketId)} · ${ticketChannelAclMarker(managedRoleIds)} · ${ticket.subject}`.slice(
    0,
    1_024,
  );
}

export function ticketChannelRecoveryMarker(ticketId: string): string {
  return `superior-ref:${ticketId}`;
}

function ticketChannelAclMarker(roleIds: readonly string[]): string {
  return `superior-acl:${[...new Set(roleIds)].sort().join(",")}`;
}

function parseTicketChannelAclMarker(topic: string | null): Set<string> | null {
  if (!topic) return null;
  const match = /(?:^|\s)superior-acl:([0-9,]*)(?:\s|$)/u.exec(topic);
  if (!match) return null;
  const ids = match[1]
    ? match[1].split(",").filter((roleId) => /^\d{17,20}$/u.test(roleId))
    : [];
  return new Set(ids);
}

function managedTicketRoleIds(
  resources: Pick<TicketConfigurationResources, "supportRole" | "managerRoles">,
): string[] {
  return [
    ...new Set(
      [
        resources.supportRole?.id,
        ...resources.managerRoles.map(({ id }) => id),
      ].filter((roleId): roleId is string => Boolean(roleId)),
    ),
  ];
}

function reconcileTicketPermissionOverwrites(
  channel: TextChannel,
  desired: OverwriteResolvable[],
  ticket: TicketRecord,
  botMemberId: string,
): OverwriteResolvable[] {
  const previouslyManaged = parseTicketChannelAclMarker(channel.topic);
  if (!previouslyManaged) return desired;
  const desiredIds = new Set(desired.map((overwrite) => overwrite.id));
  const alwaysManaged = new Set([
    channel.guild.roles.everyone.id,
    ticket.openerId,
    botMemberId,
  ]);
  const preserved: OverwriteResolvable[] = [];
  for (const overwrite of channel.permissionOverwrites.cache.values()) {
    if (
      desiredIds.has(overwrite.id) ||
      alwaysManaged.has(overwrite.id) ||
      previouslyManaged.has(overwrite.id)
    ) {
      continue;
    }
    preserved.push(overwrite);
  }
  const merged = [...desired, ...preserved];
  if (merged.length > MAX_CHANNEL_PERMISSION_OVERWRITES) {
    throw new Error(
      "Ticket recovery would exceed Discord's channel permission-overwrite limit.",
    );
  }
  return merged;
}

function requireTicketChannelResources(
  guild: Guild,
  resources: Pick<
    TicketConfigurationResources,
    "category" | "supportRole" | "managerRoles" | "botMember"
  >,
): {
  category: CategoryChannel;
  supportRole: Role;
  managerRoles: Role[];
  botMember: GuildMember;
} {
  const { category, supportRole, managerRoles, botMember } = resources;
  if (!category || !supportRole || !botMember) {
    throw new Error("Ticket resources are incomplete.");
  }
  if (
    category.guild.id !== guild.id ||
    supportRole.guild.id !== guild.id ||
    botMember.guild.id !== guild.id ||
    managerRoles.some((role) => role.guild.id !== guild.id)
  ) {
    throw new Error("Ticket resources do not belong to this server.");
  }
  return { category, supportRole, managerRoles, botMember };
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
