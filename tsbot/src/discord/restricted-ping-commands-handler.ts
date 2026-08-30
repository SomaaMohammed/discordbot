import {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  escapeMarkdown,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type InteractionReplyOptions,
  type Role,
} from "discord.js";
import { assertDiscordSnowflake } from "../guild-settings.js";
import { logInfo } from "../logging.js";
import type { GuildRuntime } from "../runtime.js";
import type {
  RestrictedPingMapping,
  RestrictedPingRoleConfiguration,
} from "../types.js";
import { authorizeOwnerOrAdministrator } from "./authorization.js";
import { SUPERIOR_PANEL_COLOR } from "./panel-theme.js";
import { RESTRICTED_PING_LIST_PAGE_SIZE } from "./restricted-ping-command.js";
import {
  executeRestrictedPing,
  inspectRestrictedPingBinding,
  restrictedPingBindingIssueMessage,
  restrictedPingRoleIssueMessage,
  type RestrictedPingExecutionResult,
  type RestrictedPingParentChannel,
  type RestrictedPingRepository,
} from "./restricted-ping-service.js";

type PrivateReplyOptions = Pick<InteractionReplyOptions, "content" | "embeds">;

export async function handlePingRoleCommand(
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
    await replyPrivate(interaction, {
      content: "Use this command inside its configured server.",
    });
    return;
  }
  const selectedRole = interaction.options.getRole("role", true);
  if (!selectedRole) {
    await replyPrivate(interaction, {
      content: "Choose a role from this server.",
    });
    return;
  }

  const result = await executeRestrictedPing({
    guild,
    userId: interaction.user.id,
    roleId: selectedRole.id,
    channelId: interaction.channelId,
    repository: runtime.storage,
    isCurrent: runtime.isCurrent,
  });
  const success = result.status === "sent";
  runtime.storage.recordCommandMetric("pingrole.send", success);
  await replyPrivate(interaction, {
    content: pingResultMessage(result),
  });
}

export async function handleRestrictedPingCommand(
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
    await replyPrivate(interaction, {
      content: "Use restricted-ping administration inside this server.",
    });
    return;
  }
  const actor = await requireRestrictedPingAdministrator(interaction, runtime);
  if (!actor) return;

  const repository: RestrictedPingRepository = runtime.storage;
  switch (interaction.options.getSubcommand()) {
    case "add":
      await addMapping(interaction, runtime, repository, actor);
      return;
    case "remove":
      await removeMapping(interaction, runtime, repository, actor);
      return;
    case "cleanup-role":
      await cleanupRoleById(interaction, runtime, repository, actor);
      return;
    case "cleanup-channel":
      await cleanupChannelById(interaction, runtime, repository, actor);
      return;
    case "list":
      await listConfigurations(interaction, runtime, repository);
      return;
    case "info":
      await showConfiguration(interaction, runtime, repository);
      return;
    case "enable":
      await setRoleEnabled(interaction, runtime, repository, actor, true);
      return;
    case "disable":
      await setRoleEnabled(interaction, runtime, repository, actor, false);
      return;
    case "configure":
      await configureRole(interaction, runtime, repository, actor);
      return;
    default:
      await replyPrivate(interaction, {
        content: "Choose a supported restricted-ping operation.",
      });
  }
}

async function addMapping(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  repository: RestrictedPingRepository,
  initialActor: GuildMember,
): Promise<void> {
  const target = selectedRoleAndChannel(interaction, runtime.guildId);
  if (!target) {
    await replyPrivate(interaction, {
      content: "Choose a role and channel from this server.",
    });
    return;
  }
  const current = repository.getRestrictedPingRole(target.roleId);
  const inspection = await inspectRestrictedPingBinding(
    interaction.guild!,
    target.roleId,
    target.channelId,
    current?.allowThreads ?? false,
  );
  if (!inspection.valid) {
    await replyPrivate(interaction, {
      content: restrictedPingBindingIssueMessage(inspection.issue),
    });
    return;
  }
  const actor = await verifyMutationAuthority(
    interaction,
    runtime,
    initialActor.id,
  );
  if (!actor) return;

  const result = repository.addRestrictedPingMapping({
    roleId: inspection.role.id,
    channelId: inspection.channel.id,
    createdBy: actor.id,
    bindingsVerifiedAt: new Date().toISOString(),
  });
  if (result.status === "duplicate") {
    await replyPrivate(interaction, {
      content: `**${escapeMarkdown(inspection.role.name)}** is already configured for **#${escapeMarkdown(inspection.channel.name)}**.`,
    });
    runtime.storage.recordCommandMetric("restrictedping.add", false);
    return;
  }
  runtime.storage.recordCommandMetric("restrictedping.add");
  runtime.invalidate();
  logInfo("restricted-ping-admin", "Restricted ping mapping added", {
    guildId: runtime.guildId,
    roleId: inspection.role.id,
    channelId: inspection.channel.id,
    actorId: actor.id,
    result: "created",
  });
  await replyPrivate(interaction, {
    content: [
      `Configured **${escapeMarkdown(inspection.role.name)}** for **#${escapeMarkdown(inspection.channel.name)}**.`,
      isThreadOnlyParent(inspection.channel) &&
      !result.configuration.allowThreads
        ? "Forum/media posts remain denied until `allow_threads` is enabled with `/restrictedping configure`."
        : null,
    ]
      .filter((line): line is string => line !== null)
      .join("\n"),
  });
}

async function removeMapping(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  repository: RestrictedPingRepository,
  initialActor: GuildMember,
): Promise<void> {
  const target = selectedRoleAndChannel(interaction, runtime.guildId);
  if (!target) {
    await replyPrivate(interaction, {
      content: "Choose a role and channel from this server.",
    });
    return;
  }
  const actor = await verifyMutationAuthority(
    interaction,
    runtime,
    initialActor.id,
  );
  if (!actor) return;
  const result = repository.removeRestrictedPingMapping(
    target.roleId,
    target.channelId,
    actor.id,
  );
  if (result.status === "not-found") {
    await replyPrivate(interaction, {
      content: "That role-to-channel mapping is not configured.",
    });
    runtime.storage.recordCommandMetric("restrictedping.remove", false);
    return;
  }
  runtime.storage.recordCommandMetric("restrictedping.remove");
  runtime.invalidate();
  logInfo("restricted-ping-admin", "Restricted ping mapping removed", {
    guildId: runtime.guildId,
    roleId: target.roleId,
    channelId: target.channelId,
    actorId: actor.id,
    configurationDeleted: result.configurationDeleted,
    result: "removed",
  });
  await replyPrivate(interaction, {
    content: result.configurationDeleted
      ? "Removed the final mapping and its restricted-role configuration."
      : "Removed that restricted role-to-channel mapping.",
  });
}

async function cleanupRoleById(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  repository: RestrictedPingRepository,
  initialActor: GuildMember,
): Promise<void> {
  const roleId = selectedSnowflakeString(interaction, "role_id", "role ID");
  if (!roleId) {
    await replyPrivate(interaction, {
      content: "Enter the exact 17-20 digit Discord ID of the deleted role.",
    });
    return;
  }
  if (!repository.getRestrictedPingRole(roleId)) {
    await replyPrivate(interaction, {
      content: "No restricted-ping configuration exists for that role ID.",
    });
    runtime.storage.recordCommandMetric("restrictedping.cleanup-role", false);
    return;
  }
  const actor = await verifyMutationAuthority(
    interaction,
    runtime,
    initialActor.id,
  );
  if (!actor) return;
  const cleanup = repository.cleanupRestrictedPingRole(roleId, actor.id);
  if (cleanup.rolesDeleted === 0) {
    await replyPrivate(interaction, {
      content: "That restricted-ping configuration changed. Please try again.",
    });
    runtime.storage.recordCommandMetric("restrictedping.cleanup-role", false);
    return;
  }
  runtime.storage.recordCommandMetric("restrictedping.cleanup-role");
  runtime.invalidate();
  logInfo("restricted-ping-admin", "Restricted ping role cleaned by ID", {
    guildId: runtime.guildId,
    roleId,
    actorId: actor.id,
    mappingsDeleted: cleanup.mappingsDeleted,
    userCooldownsDeleted: cleanup.userCooldownsDeleted,
    result: "cleaned",
  });
  await replyPrivate(interaction, {
    content: `Removed the stored role configuration and **${cleanup.mappingsDeleted}** channel mapping(s).`,
  });
}

async function cleanupChannelById(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  repository: RestrictedPingRepository,
  initialActor: GuildMember,
): Promise<void> {
  const channelId = selectedSnowflakeString(
    interaction,
    "channel_id",
    "channel ID",
  );
  if (!channelId) {
    await replyPrivate(interaction, {
      content: "Enter the exact 17-20 digit Discord ID of the deleted channel.",
    });
    return;
  }
  const actor = await verifyMutationAuthority(
    interaction,
    runtime,
    initialActor.id,
  );
  if (!actor) return;
  const cleanup = repository.cleanupRestrictedPingChannel(channelId, actor.id);
  if (cleanup.mappingsDeleted === 0) {
    await replyPrivate(interaction, {
      content: "No restricted-ping mapping exists for that channel ID.",
    });
    runtime.storage.recordCommandMetric(
      "restrictedping.cleanup-channel",
      false,
    );
    return;
  }
  runtime.storage.recordCommandMetric("restrictedping.cleanup-channel");
  runtime.invalidate();
  logInfo("restricted-ping-admin", "Restricted ping channel cleaned by ID", {
    guildId: runtime.guildId,
    channelId,
    actorId: actor.id,
    roleIds: cleanup.roleIds,
    rolesDeleted: cleanup.rolesDeleted,
    mappingsDeleted: cleanup.mappingsDeleted,
    userCooldownsDeleted: cleanup.userCooldownsDeleted,
    result: "cleaned",
  });
  await replyPrivate(interaction, {
    content: `Removed **${cleanup.mappingsDeleted}** stale channel mapping(s); **${cleanup.rolesDeleted}** role configuration(s) had no mappings left and were also removed.`,
  });
}

async function listConfigurations(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  repository: RestrictedPingRepository,
): Promise<void> {
  const page = interaction.options.getInteger("page", false) ?? 1;
  const total = repository.countRestrictedPingRoles();
  const configurations = repository.listRestrictedPingRoles(
    RESTRICTED_PING_LIST_PAGE_SIZE,
    (page - 1) * RESTRICTED_PING_LIST_PAGE_SIZE,
  );
  if (configurations.length === 0) {
    await replyPrivate(interaction, {
      content:
        page === 1
          ? "No restricted role pings are configured."
          : `No restricted role pings were found on page **${page}**.`,
    });
    runtime.storage.recordCommandMetric("restrictedping.list");
    return;
  }
  const embed = new EmbedBuilder()
    .setColor(SUPERIOR_PANEL_COLOR)
    .setTitle("Restricted Role Pings")
    .setDescription(
      `Configured roles: **${total}** - page **${page}** of **${Math.max(1, Math.ceil(total / RESTRICTED_PING_LIST_PAGE_SIZE))}**`,
    );
  for (const configuration of configurations) {
    if (configuration.guildId !== runtime.guildId) continue;
    const [role, mappings] = await Promise.all([
      fetchRole(interaction.guild!, configuration.roleId),
      Promise.resolve(
        repository.listRestrictedPingMappings(configuration.roleId, 21, 0),
      ),
    ]);
    const channels = await renderMappingChannels(
      interaction.guild!,
      runtime.guildId,
      mappings,
    );
    embed.addFields({
      name: `${configuration.enabled ? "Enabled" : "Disabled"} - ${role ? `@${escapeMarkdown(role.name)}` : "Deleted role"}`.slice(
        0,
        256,
      ),
      value: [
        "Allowed:",
        channels,
        `Cooldown: ${configuration.userCooldownSeconds}s/user - ${configuration.roleCooldownSeconds > 0 ? `${configuration.roleCooldownSeconds}s/role` : "role-wide disabled"}`,
        `Threads/posts: ${configuration.allowThreads ? "allowed under configured parents" : "denied"}`,
        `Role ID: \`${configuration.roleId}\``,
      ]
        .join("\n")
        .slice(0, 1_024),
    });
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(interaction, {
      content:
        "This server changed while restricted pings were being listed. Please try again.",
    });
    return;
  }
  await replyPrivate(interaction, { embeds: [embed] });
  runtime.storage.recordCommandMetric("restrictedping.list");
}

async function showConfiguration(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  repository: RestrictedPingRepository,
): Promise<void> {
  const roleId = selectedRoleId(interaction, runtime.guildId);
  if (!roleId) {
    await replyPrivate(interaction, {
      content: "Choose a role from this server.",
    });
    return;
  }
  const configuration = repository.getRestrictedPingRole(roleId);
  if (!configuration || configuration.guildId !== runtime.guildId) {
    await replyPrivate(interaction, {
      content: "That role is not configured for restricted pings.",
    });
    runtime.storage.recordCommandMetric("restrictedping.info", false);
    return;
  }
  const role = await fetchRole(interaction.guild!, roleId);
  const channels = await renderMappingChannels(
    interaction.guild!,
    runtime.guildId,
    repository.listRestrictedPingMappings(roleId, 21, 0),
  );
  if (!runtime.isCurrent()) {
    await replyPrivate(interaction, {
      content:
        "This server changed while that configuration was being inspected. Please try again.",
    });
    return;
  }
  const embed = new EmbedBuilder()
    .setColor(SUPERIOR_PANEL_COLOR)
    .setTitle("Restricted Role Ping Information")
    .setDescription(role ? `@${escapeMarkdown(role.name)}` : "Deleted role")
    .addFields(
      { name: "Role ID", value: `\`${configuration.roleId}\``, inline: true },
      {
        name: "Status",
        value: configuration.enabled ? "Enabled" : "Disabled",
        inline: true,
      },
      {
        name: "Successful pings",
        value: String(configuration.successCount),
        inline: true,
      },
      { name: "Allowed channels", value: channels.slice(0, 1_024) },
      {
        name: "Cooldowns",
        value: `${configuration.userCooldownSeconds}s per user - ${configuration.roleCooldownSeconds > 0 ? `${configuration.roleCooldownSeconds}s role-wide` : "role-wide disabled"}`,
      },
      {
        name: "Threads and forum/media posts",
        value: configuration.allowThreads
          ? "Allowed only under an exactly configured parent channel"
          : "Denied",
      },
      {
        name: "Binding verification",
        value: configuration.bindingsVerifiedAt
          ? formatTimestamp(configuration.bindingsVerifiedAt)
          : "Not recorded",
        inline: true,
      },
      {
        name: "Updated",
        value: formatTimestamp(configuration.updatedAt),
        inline: true,
      },
    );
  await replyPrivate(interaction, { embeds: [embed] });
  runtime.storage.recordCommandMetric("restrictedping.info");
}

async function setRoleEnabled(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  repository: RestrictedPingRepository,
  initialActor: GuildMember,
  enabled: boolean,
): Promise<void> {
  const roleId = selectedRoleId(interaction, runtime.guildId);
  if (!roleId) {
    await replyPrivate(interaction, {
      content: "Choose a role from this server.",
    });
    return;
  }
  const current = repository.getRestrictedPingRole(roleId);
  if (!current || current.guildId !== runtime.guildId) {
    await replyPrivate(interaction, {
      content: "That role is not configured for restricted pings.",
    });
    runtime.storage.recordCommandMetric(
      `restrictedping.${enabled ? "enable" : "disable"}`,
      false,
    );
    return;
  }
  if (enabled) {
    const validationIssue = await inspectAllBindings(
      interaction.guild!,
      repository,
      current,
      current.allowThreads,
    );
    if (validationIssue) {
      await replyPrivate(interaction, { content: validationIssue });
      return;
    }
  }
  const actor = await verifyMutationAuthority(
    interaction,
    runtime,
    initialActor.id,
  );
  if (!actor) return;
  const updated = repository.setRestrictedPingRoleEnabled(
    roleId,
    enabled,
    actor.id,
    enabled ? new Date().toISOString() : undefined,
  );
  if (!updated) {
    await replyPrivate(interaction, {
      content: "That restricted-ping configuration changed. Please try again.",
    });
    return;
  }
  const metric = `restrictedping.${enabled ? "enable" : "disable"}`;
  runtime.storage.recordCommandMetric(metric);
  runtime.invalidate();
  logInfo(
    "restricted-ping-admin",
    `Restricted ping role ${enabled ? "enabled" : "disabled"}`,
    {
      guildId: runtime.guildId,
      roleId,
      actorId: actor.id,
      result: enabled ? "enabled" : "disabled",
    },
  );
  await replyPrivate(interaction, {
    content: `Restricted pings for that role are now **${enabled ? "enabled" : "disabled"}**.`,
  });
}

async function configureRole(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  repository: RestrictedPingRepository,
  initialActor: GuildMember,
): Promise<void> {
  const roleId = selectedRoleId(interaction, runtime.guildId);
  if (!roleId) {
    await replyPrivate(interaction, {
      content: "Choose a role from this server.",
    });
    return;
  }
  const userCooldownSeconds = interaction.options.getInteger(
    "user_cooldown_seconds",
    false,
  );
  const roleCooldownSeconds = interaction.options.getInteger(
    "role_cooldown_seconds",
    false,
  );
  const allowThreads = interaction.options.getBoolean("allow_threads", false);
  if (
    userCooldownSeconds === null &&
    roleCooldownSeconds === null &&
    allowThreads === null
  ) {
    await replyPrivate(interaction, {
      content: "Choose at least one cooldown or thread setting to change.",
    });
    return;
  }
  const current = repository.getRestrictedPingRole(roleId);
  if (!current || current.guildId !== runtime.guildId) {
    await replyPrivate(interaction, {
      content: "That role is not configured for restricted pings.",
    });
    runtime.storage.recordCommandMetric("restrictedping.configure", false);
    return;
  }
  const nextAllowThreads = allowThreads ?? current.allowThreads;
  const validationIssue = await inspectAllBindings(
    interaction.guild!,
    repository,
    current,
    nextAllowThreads,
  );
  if (validationIssue) {
    await replyPrivate(interaction, { content: validationIssue });
    return;
  }
  const actor = await verifyMutationAuthority(
    interaction,
    runtime,
    initialActor.id,
  );
  if (!actor) return;
  const update: Parameters<
    RestrictedPingRepository["configureRestrictedPingRole"]
  >[1] = {
    updatedBy: actor.id,
    bindingsVerifiedAt: new Date().toISOString(),
  };
  if (userCooldownSeconds !== null) {
    update.userCooldownSeconds = userCooldownSeconds;
  }
  if (roleCooldownSeconds !== null) {
    update.roleCooldownSeconds = roleCooldownSeconds;
  }
  if (allowThreads !== null) update.allowThreads = allowThreads;
  const updated = repository.configureRestrictedPingRole(roleId, update);
  if (!updated) {
    await replyPrivate(interaction, {
      content: "That restricted-ping configuration changed. Please try again.",
    });
    return;
  }
  runtime.storage.recordCommandMetric("restrictedping.configure");
  runtime.invalidate();
  logInfo("restricted-ping-admin", "Restricted ping role configured", {
    guildId: runtime.guildId,
    roleId,
    actorId: actor.id,
    userCooldownSeconds: updated.userCooldownSeconds,
    roleCooldownSeconds: updated.roleCooldownSeconds,
    allowThreads: updated.allowThreads,
    result: "updated",
  });
  await replyPrivate(interaction, {
    content: [
      "Restricted-ping settings updated.",
      `User cooldown: **${updated.userCooldownSeconds}s**`,
      `Role-wide cooldown: **${updated.roleCooldownSeconds > 0 ? `${updated.roleCooldownSeconds}s` : "disabled"}**`,
      `Threads/posts: **${updated.allowThreads ? "allowed under configured parents" : "denied"}**`,
    ].join("\n"),
  });
}

async function inspectAllBindings(
  guild: Guild,
  repository: RestrictedPingRepository,
  configuration: RestrictedPingRoleConfiguration,
  allowThreads: boolean,
): Promise<string | null> {
  const pageSize = 100;
  let offset = 0;
  let found = false;
  for (;;) {
    const mappings = repository.listRestrictedPingMappings(
      configuration.roleId,
      pageSize,
      offset,
    );
    for (const mapping of mappings) {
      if (
        mapping.guildId !== guild.id ||
        mapping.roleId !== configuration.roleId
      ) {
        return "A stored mapping does not belong to this server and cannot be enabled.";
      }
      found = true;
      const inspection = await inspectRestrictedPingBinding(
        guild,
        configuration.roleId,
        mapping.channelId,
        allowThreads,
      );
      if (!inspection.valid) {
        return restrictedPingBindingIssueMessage(inspection.issue);
      }
    }
    if (mappings.length < pageSize) break;
    offset += mappings.length;
  }
  return found ? null : "That role has no valid channel mappings.";
}

async function requireRestrictedPingAdministrator(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<GuildMember | null> {
  const guild = interaction.guild;
  if (!guild || guild.id !== runtime.guildId) return null;
  const decision = await authorizeOwnerOrAdministrator(
    guild,
    interaction.user.id,
  );
  if (!decision.allowed) {
    await replyPrivate(interaction, {
      content:
        decision.reason === "member-unavailable" ||
        decision.reason === "guild-mismatch"
          ? "Could not verify your current server membership."
          : "Only the server owner or a current Administrator can manage restricted role pings.",
    });
    return null;
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(interaction, {
      content: "This server was disabled or reconfigured. Please try again.",
    });
    return null;
  }
  return decision.member;
}

async function verifyMutationAuthority(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  expectedActorId: string,
): Promise<GuildMember | null> {
  const guild = interaction.guild;
  if (!guild || guild.id !== runtime.guildId) return null;
  const decision = await authorizeOwnerOrAdministrator(
    guild,
    interaction.user.id,
  );
  if (
    !decision.allowed ||
    decision.member.id !== expectedActorId ||
    !runtime.isCurrent()
  ) {
    await replyPrivate(interaction, {
      content:
        "Your Administrator access or this server's configuration changed while the request was being verified. Nothing was changed.",
    });
    return null;
  }
  return decision.member;
}

function selectedRoleAndChannel(
  interaction: ChatInputCommandInteraction,
  guildId: string,
): { roleId: string; channelId: string } | null {
  const role = interaction.options.getRole("role", true);
  const channel = interaction.options.getChannel("channel", true);
  if (!role || !channel) return null;
  if ("guild" in role && role.guild.id !== guildId) return null;
  if ("guild" in channel && channel.guild.id !== guildId) return null;
  return { roleId: role.id, channelId: channel.id };
}

function selectedSnowflakeString(
  interaction: ChatInputCommandInteraction,
  optionName: string,
  label: string,
): string | null {
  const value = interaction.options.getString(optionName, true);
  try {
    return assertDiscordSnowflake(value, label);
  } catch {
    return null;
  }
}

function selectedRoleId(
  interaction: ChatInputCommandInteraction,
  guildId: string,
): string | null {
  const role = interaction.options.getRole("role", true);
  if (!role) return null;
  if ("guild" in role && role.guild.id !== guildId) return null;
  return role.id;
}

async function renderMappingChannels(
  guild: Guild,
  guildId: string,
  mappings: readonly RestrictedPingMapping[],
): Promise<string> {
  const lines = await Promise.all(
    mappings
      .filter(
        (mapping) => mapping.guildId === guildId && mapping.roleId.length > 0,
      )
      .slice(0, 20)
      .map(async (mapping) => {
        const channel = await guild.channels
          .fetch(mapping.channelId, { cache: true, force: true })
          .catch(() => null);
        return channel?.guild.id === guildId
          ? `- #${escapeMarkdown(channel.name)}`
          : `- Deleted channel (\`${mapping.channelId}\`)`;
      }),
  );
  if (mappings.length > 20)
    lines.push("- More configured channels are not shown here.");
  return lines.join("\n") || "- None";
}

async function fetchRole(guild: Guild, roleId: string): Promise<Role | null> {
  const role = await guild.roles
    .fetch(roleId, { cache: true, force: true })
    .catch(() => null);
  return role?.guild.id === guild.id && role.id === roleId ? role : null;
}

function pingResultMessage(result: RestrictedPingExecutionResult): string {
  const roleName = result.role
    ? `**${escapeMarkdown(result.role.name)}**`
    : "that role";
  switch (result.status) {
    case "sent":
      return `Pinged ${roleName} successfully.`;
    case "not-configured":
      return "That role is not configured for restricted pings.";
    case "disabled":
      return `${roleName} is currently disabled for restricted pings.`;
    case "channel-not-allowed":
      return `${roleName} cannot be pinged in this channel.`;
    case "thread-not-allowed":
      return `${roleName} cannot be pinged in threads or forum/media posts.`;
    case "member-unavailable":
    case "bot-invoker":
      return "Could not verify a current human server member for this request.";
    case "member-missing-role":
      return `You must currently have ${roleName} to ping it.`;
    case "role-invalid":
      return restrictedPingRoleIssueMessage(result.issue);
    case "channel-unavailable":
      return "This channel no longer exists or cannot receive restricted role pings.";
    case "member-permissions":
      return "You are not currently allowed to use commands and send messages in this channel.";
    case "bot-permissions":
      return "Superior cannot safely send a non-mentionable role ping in this channel. Ask an Administrator to check its channel permissions.";
    case "cooldown": {
      const seconds = Math.max(
        1,
        Math.ceil((Date.parse(result.retryAt) - Date.now()) / 1_000),
      );
      return `Please wait **${Number.isFinite(seconds) ? seconds : 1} seconds** before pinging ${roleName} again.`;
    }
    case "cancelled":
      return "This server changed while the ping was being authorized. Please try again.";
    case "delivery-failed":
      return "Superior could not deliver and verify that role notification. No successful-ping cooldown was consumed.";
    case "delivery-unverified":
      return "Superior sent the message but could not verify the role notification. A safety cooldown remains in place to prevent duplicate notifications.";
  }
}

function formatTimestamp(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return "Unavailable";
  return `<t:${Math.floor(milliseconds / 1_000)}:F>`;
}

function isThreadOnlyParent(channel: RestrictedPingParentChannel): boolean {
  return (
    channel.type === ChannelType.GuildForum ||
    channel.type === ChannelType.GuildMedia
  );
}

async function replyPrivate(
  interaction: ChatInputCommandInteraction,
  options: PrivateReplyOptions,
): Promise<void> {
  if (interaction.deferred && !interaction.replied) {
    await interaction.editReply({ ...options, allowedMentions: { parse: [] } });
    return;
  }
  if (interaction.replied) {
    await interaction.followUp({
      ...options,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }
  await interaction.reply({
    ...options,
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
