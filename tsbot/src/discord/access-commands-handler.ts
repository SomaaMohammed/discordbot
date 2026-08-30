import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  escapeMarkdown,
  type ChatInputCommandInteraction,
  type Role,
  type TextChannel,
} from "discord.js";
import type { GuildRuntime } from "../runtime.js";
import type {
  ApplicationForm,
  CapabilityGrantResult,
  CapabilityRevokeResult,
  ModerationConfiguration,
  RoleCapabilityGrant,
} from "../types.js";
import { ACCESS_GRANT_PAGE_SIZE } from "./access-command.js";
import {
  GUILD_CAPABILITIES,
  isGuildCapability,
  type GuildCapability,
} from "./capabilities.js";
import {
  authorizeOwnerOrAdministrator,
  fetchAndValidateRole,
  type CapabilityGrantReader,
  type VerifiedRoleResult,
} from "./authorization.js";
import { applicationReviewRoleAccessIssue } from "./phase2-permissions.js";
import {
  inspectTicketManagerRoles,
  MAX_TICKET_MANAGER_ROLES,
} from "./ticket-permissions.js";
import {
  fetchCurrentBotMember,
  fetchGuildRoleCoalesced,
} from "./fetch-coalescing.js";

interface AccessRepository extends CapabilityGrantReader {
  grantRoleCapability(
    roleId: string,
    capability: GuildCapability,
    grantedBy: string,
  ): CapabilityGrantResult;
  revokeRoleCapability(
    roleId: string,
    capability: GuildCapability,
  ): CapabilityRevokeResult;
  listCapabilityGrants(limit?: number, offset?: number): RoleCapabilityGrant[];
  listCapabilityGrantsForCapability(
    capability: GuildCapability,
    limit?: number,
    offset?: number,
  ): RoleCapabilityGrant[];
  listApplicationForms(options?: {
    enabledOnly?: boolean;
    limit?: number;
    offset?: number;
  }): ApplicationForm[];
  getModerationConfiguration(): ModerationConfiguration | null;
}

export async function handleAccessCommand(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  await deferPrivate(interaction);
  const guild = interaction.guild;
  if (
    !guild ||
    !interaction.guildId ||
    guild.id !== interaction.guildId ||
    guild.id !== runtime.guildId
  ) {
    await replyPrivate(
      interaction,
      "Use access management inside this server.",
    );
    return;
  }

  const authority = await authorizeOwnerOrAdministrator(
    guild,
    interaction.user.id,
  );
  if (!authority.allowed) {
    await replyPrivate(
      interaction,
      authority.reason === "member-unavailable" ||
        authority.reason === "guild-mismatch"
        ? "Could not verify your current server membership."
        : "Only the server owner or a current Administrator can manage delegated access.",
    );
    return;
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server was disabled or reconfigured. Please try again.",
    );
    return;
  }

  const repository: AccessRepository = runtime.storage;
  switch (interaction.options.getSubcommand()) {
    case "grant":
      await grantCapability(interaction, runtime, repository);
      return;
    case "revoke":
      await revokeCapability(interaction, runtime, repository);
      return;
    case "list":
      await listCapabilityGrants(interaction, runtime, repository);
      return;
    case "status":
      await showRoleStatus(interaction, runtime, repository);
      return;
    default:
      await replyPrivate(interaction, "Choose a supported access operation.");
  }
}

async function grantCapability(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  repository: AccessRepository,
): Promise<void> {
  const role = await getCurrentTargetRole(interaction, runtime);
  if (!role) return;
  const capability = await getCapabilityOption(interaction);
  if (!capability) return;
  if (
    capability === "tickets.manage" &&
    !(await preflightTicketManagerGrant(interaction, runtime, repository, role))
  ) {
    return;
  }
  if (
    capability === "applications.review" &&
    !(await preflightApplicationReviewerGrant(
      interaction,
      runtime,
      repository,
      role,
    ))
  ) {
    return;
  }
  if (
    (capability === "reports.review" || capability === "appeals.review") &&
    !(await preflightSafetyReviewerGrant(
      interaction,
      runtime,
      repository,
      role,
      capability,
    ))
  ) {
    return;
  }
  let mutation = await verifyMutationContext(
    interaction,
    runtime,
    role.id,
    "granted",
    capability === "tickets.manage",
  );
  if (!mutation) return;
  if (
    (capability === "reports.review" || capability === "appeals.review") &&
    !(await preflightSafetyReviewerGrant(
      interaction,
      runtime,
      repository,
      mutation.role,
      capability,
    ))
  ) {
    return;
  }
  if (capability === "reports.review" || capability === "appeals.review") {
    mutation = await verifyMutationContext(
      interaction,
      runtime,
      mutation.role.id,
      "granted",
      false,
    );
    if (!mutation) return;
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server changed after access was verified. No access was granted.",
    );
    return;
  }

  const result = repository.grantRoleCapability(
    mutation.role.id,
    capability,
    mutation.actorId,
  );
  if (result.status === "duplicate") {
    await replyPrivate(
      interaction,
      `**${escapeMarkdown(mutation.role.name)}** already has \`${capability}\`.`,
    );
    return;
  }
  runtime.invalidate();
  await replyPrivate(
    interaction,
    [
      `Granted \`${capability}\` to **${escapeMarkdown(mutation.role.name)}** (\`${mutation.role.id}\`).`,
      capability === "tickets.manage"
        ? "New ticket channels will include this role. Run `/ticket recover ticket_number:<number>` for each existing active ticket the role should access."
        : null,
    ]
      .filter((line): line is string => line !== null)
      .join("\n"),
  );
  runtime.storage.recordCommandMetric("access.grant");
}

async function preflightTicketManagerGrant(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  repository: AccessRepository,
  role: Role,
): Promise<boolean> {
  const guild = interaction.guild;
  if (!guild || guild.id !== runtime.guildId) return false;
  const [current, botMember] = await Promise.all([
    inspectTicketManagerRoles(guild, repository),
    fetchCurrentBotMember(guild, { force: true }),
  ]);
  if (current.issues.length > 0) {
    await replyPrivate(interaction, current.issues.join(" "));
    return false;
  }
  if (!botMember || botMember.guild.id !== guild.id) {
    await replyPrivate(
      interaction,
      "Superior could not verify its current server role before granting ticket-management access.",
    );
    return false;
  }
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    await replyPrivate(
      interaction,
      "Superior needs Manage Roles before ticket-management access can be granted.",
    );
    return false;
  }
  if (botMember.roles.highest.comparePositionTo(role) <= 0) {
    await replyPrivate(
      interaction,
      "Superior's highest role must be above a delegated ticket-management role.",
    );
    return false;
  }
  if (current.roles.some((currentRole) => currentRole.id === role.id)) {
    return true;
  }
  if (current.roles.length < MAX_TICKET_MANAGER_ROLES) return true;
  await replyPrivate(
    interaction,
    `Private ticket channels support at most ${MAX_TICKET_MANAGER_ROLES} active \`tickets.manage\` roles. Revoke an unused grant before adding another.`,
  );
  runtime.storage.recordCommandMetric("access.grant", false);
  return false;
}

async function preflightApplicationReviewerGrant(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  repository: AccessRepository,
  role: Role,
): Promise<boolean> {
  const guild = interaction.guild;
  if (!guild || guild.id !== runtime.guildId || role.guild.id !== guild.id) {
    await replyPrivate(
      interaction,
      "Could not verify the application reviewer role in this server.",
    );
    return false;
  }
  const forms = repository.listApplicationForms({
    limit: 25,
  });
  for (const form of forms) {
    if (!form.bindingsVerifiedAt) {
      continue;
    }
    if (form.guildId !== runtime.guildId) {
      await replyPrivate(
        interaction,
        "Cannot grant `applications.review` while a verified form belongs to another server.",
      );
      return false;
    }
    const channelValue = await guild.channels
      .fetch(form.reviewChannelId, { cache: true, force: true })
      .catch(() => null);
    if (
      !channelValue ||
      channelValue.type !== ChannelType.GuildText ||
      channelValue.guild.id !== guild.id
    ) {
      await replyPrivate(
        interaction,
        `Cannot grant \`applications.review\` while verified form \`${form.slug}\` has an unavailable private review channel. Repair that form first.`,
      );
      return false;
    }
    const accessIssue = applicationReviewRoleAccessIssue(
      channelValue as TextChannel,
      role,
    );
    if (accessIssue) {
      await replyPrivate(
        interaction,
        `Cannot grant \`applications.review\` for verified form \`${form.slug}\`. ${accessIssue}`,
      );
      return false;
    }
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server changed while application review access was being verified. No access was granted.",
    );
    return false;
  }
  return true;
}

async function preflightSafetyReviewerGrant(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  repository: AccessRepository,
  role: Role,
  capability: "reports.review" | "appeals.review",
): Promise<boolean> {
  const guild = interaction.guild;
  if (!guild || guild.id !== runtime.guildId || role.guild.id !== guild.id) {
    await replyPrivate(
      interaction,
      "Could not freshly verify the safety reviewer role in this server.",
    );
    return false;
  }
  const configuration = repository.getModerationConfiguration();
  if (!configuration) return runtime.isCurrent();
  if (configuration.guildId !== guild.id) {
    await replyPrivate(
      interaction,
      "The moderation configuration belongs to another server. No access was granted.",
    );
    return false;
  }
  const reports = capability === "reports.review";
  const channelId = reports
    ? configuration.reportReviewChannelId
    : configuration.appealReviewChannelId;
  const verifiedAt = reports
    ? configuration.reportBindingsVerifiedAt
    : configuration.appealBindingsVerifiedAt;
  if (!channelId || !verifiedAt) return runtime.isCurrent();
  const channelValue = await guild.channels
    .fetch(channelId, { cache: true, force: true })
    .catch(() => null);
  if (
    !channelValue ||
    channelValue.type !== ChannelType.GuildText ||
    channelValue.guild.id !== guild.id
  ) {
    await replyPrivate(
      interaction,
      `Cannot grant \`${capability}\` while its verified private review channel is unavailable. Repair or revalidate the moderation binding first.`,
    );
    return false;
  }
  const permissions = channelValue.permissionsFor(role);
  if (
    !permissions?.has(PermissionFlagsBits.ViewChannel) ||
    !permissions.has(PermissionFlagsBits.SendMessages) ||
    !permissions.has(PermissionFlagsBits.ReadMessageHistory)
  ) {
    await replyPrivate(
      interaction,
      `Cannot grant \`${capability}\`: the role needs View Channel, Send Messages, and Read Message History in the verified private review channel.`,
    );
    return false;
  }
  const latest = repository.getModerationConfiguration();
  if (latest?.updatedAt !== configuration.updatedAt || !runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "The private review binding changed while access was being verified. No access was granted.",
    );
    return false;
  }
  return true;
}

async function revokeCapability(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  repository: AccessRepository,
): Promise<void> {
  const role = await getCurrentTargetRole(interaction, runtime);
  if (!role) return;
  const capability = await getCapabilityOption(interaction);
  if (!capability) return;
  if (
    (capability === "reports.review" || capability === "appeals.review") &&
    !(await preflightSafetyReviewerRevoke(
      interaction,
      runtime,
      repository,
      role,
      capability,
    ))
  ) {
    return;
  }
  let mutation = await verifyMutationContext(
    interaction,
    runtime,
    role.id,
    "revoked",
  );
  if (!mutation) return;
  if (capability === "reports.review" || capability === "appeals.review") {
    if (
      !(await preflightSafetyReviewerRevoke(
        interaction,
        runtime,
        repository,
        mutation.role,
        capability,
      ))
    ) {
      return;
    }
    mutation = await verifyMutationContext(
      interaction,
      runtime,
      mutation.role.id,
      "revoked",
    );
    if (!mutation) return;
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server changed after access was verified. No access was revoked.",
    );
    return;
  }

  const result = repository.revokeRoleCapability(mutation.role.id, capability);
  if (result.status === "not-found") {
    await replyPrivate(
      interaction,
      `**${escapeMarkdown(mutation.role.name)}** does not have \`${capability}\`.`,
    );
    return;
  }
  runtime.invalidate();
  await replyPrivate(
    interaction,
    [
      `Revoked \`${capability}\` from **${escapeMarkdown(mutation.role.name)}** (\`${mutation.role.id}\`).`,
      capability === "applications.review"
        ? "Superior no longer authorizes review actions for this grant. Remove the role's Discord access to private application review channels separately when it is no longer appropriate."
        : capability === "tickets.manage"
          ? "Superior no longer authorizes ticket controls for this grant. Run `/ticket recover ticket_number:<number>` for each active ticket to remove its bot-managed private-channel access."
          : null,
    ]
      .filter((line): line is string => line !== null)
      .join("\n"),
  );
  runtime.storage.recordCommandMetric("access.revoke");
}

async function preflightSafetyReviewerRevoke(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  repository: AccessRepository,
  role: Role,
  capability: "reports.review" | "appeals.review",
): Promise<boolean> {
  const guild = interaction.guild;
  const configuration = repository.getModerationConfiguration();
  if (!guild || !configuration || configuration.guildId !== guild.id) {
    return runtime.isCurrent();
  }
  const reports = capability === "reports.review";
  const reviewerRoleId = reports
    ? configuration.reportReviewerRoleId
    : configuration.appealReviewerRoleId;
  if (reviewerRoleId === role.id) return runtime.isCurrent();
  const channelId = reports
    ? configuration.reportReviewChannelId
    : configuration.appealReviewChannelId;
  const verifiedAt = reports
    ? configuration.reportBindingsVerifiedAt
    : configuration.appealBindingsVerifiedAt;
  if (!channelId || !verifiedAt) return runtime.isCurrent();
  const channel = await guild.channels
    .fetch(channelId, { cache: true, force: true })
    .catch(() => null);
  if (
    !channel ||
    channel.type !== ChannelType.GuildText ||
    channel.guild.id !== guild.id
  ) {
    await replyPrivate(
      interaction,
      "The private review destination could not be freshly verified. No access was revoked.",
    );
    return false;
  }
  if (channel.permissionsFor(role)?.has(PermissionFlagsBits.ViewChannel)) {
    await replyPrivate(
      interaction,
      `Remove this role's View Channel access from the verified private ${reports ? "report" : "appeal"} destination before revoking \`${capability}\`; otherwise existing sensitive messages would remain readable.`,
    );
    return false;
  }
  const latest = repository.getModerationConfiguration();
  return latest?.updatedAt === configuration.updatedAt && runtime.isCurrent();
}

async function listCapabilityGrants(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  repository: AccessRepository,
): Promise<void> {
  const page = interaction.options.getInteger("page", false) ?? 1;
  const offset = (page - 1) * ACCESS_GRANT_PAGE_SIZE;
  const grants = repository.listCapabilityGrants(
    ACCESS_GRANT_PAGE_SIZE + 1,
    offset,
  );
  const visible = grants.slice(0, ACCESS_GRANT_PAGE_SIZE);
  if (visible.length === 0) {
    await replyPrivate(
      interaction,
      page === 1
        ? "No delegated role capabilities are configured."
        : `No delegated role capabilities were found on page **${page}**.`,
    );
    return;
  }

  const lines = await Promise.all(
    visible.map(async (grant) => {
      const role = await fetchGuildRoleCoalesced(
        interaction.guild!,
        grant.roleId,
        {
          cache: true,
          force: true,
        },
      );
      const roleLabel =
        role?.guild.id === runtime.guildId
          ? `**${escapeMarkdown(role.name)}**`
          : "**Deleted role**";
      return `- ${roleLabel} (\`${grant.roleId}\`) — \`${grant.capability}\``;
    }),
  );
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server changed while delegated access was being inspected. Please try again.",
    );
    return;
  }
  await replyPrivate(
    interaction,
    [
      `**Delegated access · page ${page}**`,
      ...lines,
      grants.length > ACCESS_GRANT_PAGE_SIZE
        ? `More grants are available on page **${page + 1}**.`
        : null,
    ]
      .filter((line): line is string => line !== null)
      .join("\n")
      .slice(0, 2_000),
  );
  runtime.storage.recordCommandMetric("access.list");
}

async function showRoleStatus(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  repository: AccessRepository,
): Promise<void> {
  const role = await getCurrentTargetRole(interaction, runtime);
  if (!role) return;
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server changed while the role was being verified. Please try again.",
    );
    return;
  }
  const grants = repository
    .listCapabilitiesForRoles([role.id])
    .filter(
      (grant) =>
        grant.guildId === runtime.guildId &&
        grant.roleId === role.id &&
        grant.principalType === "role" &&
        grant.active !== false &&
        isGuildCapability(grant.capability),
    );
  const capabilities = new Set(grants.map(({ capability }) => capability));
  await replyPrivate(
    interaction,
    [
      `**Delegated access for ${escapeMarkdown(role.name)}**`,
      `Role ID: \`${role.id}\``,
      ...GUILD_CAPABILITIES.map(
        (capability) =>
          `${capabilities.has(capability) ? "Enabled" : "Not granted"}: \`${capability}\``,
      ),
    ].join("\n"),
  );
  runtime.storage.recordCommandMetric("access.status");
}

async function getCapabilityOption(
  interaction: ChatInputCommandInteraction,
): Promise<GuildCapability | null> {
  const value = interaction.options.getString("capability", true);
  if (isGuildCapability(value)) return value;
  await replyPrivate(interaction, "Choose a supported Superior capability.");
  return null;
}

async function getCurrentTargetRole(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<Role | null> {
  const guild = interaction.guild;
  const selected = interaction.options.getRole("role", true);
  if (!guild || guild.id !== runtime.guildId || !selected) {
    await replyPrivate(interaction, "Choose a role from this server.");
    return null;
  }
  if ("guild" in selected && selected.guild.id !== runtime.guildId) {
    await replyPrivate(
      interaction,
      "That role does not belong to this server.",
    );
    return null;
  }
  const verified = await fetchAndValidateRole(guild, selected.id);
  if (!verified.valid) {
    await replyPrivate(interaction, roleValidationMessage(verified));
    return null;
  }
  return verified.role;
}

function roleValidationMessage(
  result: Exclude<VerifiedRoleResult, { valid: true }>,
): string {
  switch (result.reason) {
    case "role-everyone":
      return "The @everyone role cannot receive delegated access.";
    case "role-managed":
      return "Managed or integration roles cannot receive delegated access.";
    case "role-mismatch":
      return "That role does not belong to this server.";
    case "role-unavailable":
      return "That role no longer exists or could not be verified.";
  }
}

async function verifyMutationContext(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  expectedRoleId: string,
  operation: "granted" | "revoked",
  verifyTicketManagerHierarchy = false,
): Promise<{ actorId: string; role: Role } | null> {
  const guild = interaction.guild;
  if (!guild || guild.id !== runtime.guildId) {
    await replyPrivate(interaction, "Could not verify the current server.");
    return null;
  }
  const [verifiedRole, botMember] = await Promise.all([
    fetchAndValidateRole(guild, expectedRoleId),
    verifyTicketManagerHierarchy
      ? fetchCurrentBotMember(guild, { force: true })
      : Promise.resolve(null),
  ]);
  const authority = await authorizeOwnerOrAdministrator(
    guild,
    interaction.user.id,
  );
  if (!authority.allowed) {
    await replyPrivate(
      interaction,
      `Your owner or Administrator access changed while the request was being verified. No access was ${operation}.`,
    );
    return null;
  }
  if (!verifiedRole.valid) {
    await replyPrivate(interaction, roleValidationMessage(verifiedRole));
    return null;
  }
  if (verifyTicketManagerHierarchy) {
    if (!botMember || botMember.guild.id !== guild.id) {
      await replyPrivate(
        interaction,
        "Superior could not verify its current server role before granting ticket-management access.",
      );
      return null;
    }
    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
      await replyPrivate(
        interaction,
        "Superior needs Manage Roles before ticket-management access can be granted.",
      );
      return null;
    }
    if (botMember.roles.highest.comparePositionTo(verifiedRole.role) <= 0) {
      await replyPrivate(
        interaction,
        "Superior's highest role must be above a delegated ticket-management role.",
      );
      return null;
    }
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      `This server changed while the request was being verified. No access was ${operation}.`,
    );
    return null;
  }
  return { actorId: authority.member.id, role: verifiedRole.role };
}

async function replyPrivate(
  interaction: ChatInputCommandInteraction,
  content: string,
): Promise<void> {
  if (interaction.deferred && !interaction.replied) {
    await interaction.editReply({ content, allowedMentions: { parse: [] } });
    return;
  }
  if (interaction.replied) {
    await interaction.followUp({
      content,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }
  await interaction.reply({
    content,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function deferPrivate(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
}
