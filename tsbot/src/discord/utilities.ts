import {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  escapeMarkdown,
  type ChatInputCommandInteraction,
  type GuildBasedChannel,
  type InteractionReplyOptions,
  type Role,
  type SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import { DateTime } from "luxon";
import type { GuildRuntime } from "../runtime.js";
import { SUPERIOR_PANEL_COLOR } from "./panel-theme.js";

const UTILITY_COMMAND_NAME = "utility";
const DISCORD_EPOCH_MS = 1_420_070_400_000n;
const MAX_SNOWFLAKE = (1n << 64n) - 1n;
const UTILITY_CANCELLED_MESSAGE =
  "Action cancelled because this server was disabled, removed, purged, or its configuration changed.";

type UtilityReplyOptions = Pick<InteractionReplyOptions, "content" | "embeds">;

export function buildUtilityCommandDefinition(): SlashCommandSubcommandsOnlyBuilder {
  return new SlashCommandBuilder()
    .setName(UTILITY_COMMAND_NAME)
    .setDescription("Private server, member, and Discord information tools")
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("ping")
        .setDescription("Check responsiveness, latency, uptime, and version"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("avatar")
        .setDescription("Show a member's server and global avatars")
        .addUserOption((option) =>
          option
            .setName("member")
            .setDescription("Member to inspect (defaults to you)")
            .setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("userinfo")
        .setDescription("Show basic information about a server member")
        .addUserOption((option) =>
          option
            .setName("member")
            .setDescription("Member to inspect (defaults to you)")
            .setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("serverinfo")
        .setDescription("Show basic information about this server"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("roleinfo")
        .setDescription("Show safe information about a server role")
        .addRoleOption((option) =>
          option
            .setName("role")
            .setDescription("Role to inspect")
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("channelinfo")
        .setDescription("Show safe information about a server channel")
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("Channel to inspect (defaults to this channel)")
            .setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("snowflake")
        .setDescription("Decode the creation time in a Discord ID")
        .addStringOption((option) =>
          option
            .setName("id")
            .setDescription("Discord snowflake ID")
            .setRequired(true)
            .setMinLength(17)
            .setMaxLength(20),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("timestamp")
        .setDescription("Convert a local or ISO time to Discord timestamp tags")
        .addStringOption((option) =>
          option
            .setName("time")
            .setDescription("ISO time, or now (uses the configured timezone)")
            .setRequired(true)
            .setMaxLength(100),
        ),
    );
}

export async function handleUtilityCommand(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  if (!(await validateUtilityContext(interaction, runtime))) {
    return;
  }
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  switch (interaction.options.getSubcommand()) {
    case "ping":
      await handlePing(interaction, runtime);
      return;
    case "avatar":
      await handleAvatar(interaction, runtime);
      return;
    case "userinfo":
      await handleUserInfo(interaction, runtime);
      return;
    case "serverinfo":
      await handleServerInfo(interaction, runtime);
      return;
    case "roleinfo":
      await handleRoleInfo(interaction, runtime);
      return;
    case "channelinfo":
      await handleChannelInfo(interaction, runtime);
      return;
    case "snowflake":
      await handleSnowflake(interaction, runtime);
      return;
    case "timestamp":
      await handleTimestamp(interaction, runtime);
      return;
    default:
      await replyPrivately(interaction, {
        content: "Unknown utility command.",
      });
  }
}

async function validateUtilityContext(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<boolean> {
  if (!interaction.guild || !interaction.guildId) {
    await replyPrivately(interaction, {
      content: "Use this command inside a server.",
    });
    return false;
  }
  if (
    interaction.guildId !== runtime.guildId ||
    interaction.guild.id !== runtime.guildId
  ) {
    await replyPrivately(interaction, {
      content: "This utility request does not belong to this server.",
    });
    return false;
  }
  if (!runtime.isCurrent()) {
    await replyCancelled(interaction);
    return false;
  }
  return true;
}

async function handlePing(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const rawGatewayLatency = interaction.client.ws.ping;
  const gatewayLatency =
    Number.isFinite(rawGatewayLatency) && rawGatewayLatency >= 0
      ? `${Math.round(rawGatewayLatency)} ms`
      : "Unavailable";
  const version = runtime.botVersion.trim() || "Unknown";
  const embed = new EmbedBuilder()
    .setColor(SUPERIOR_PANEL_COLOR)
    .setTitle("Bot Status")
    .setDescription("Superior is online and responsive.")
    .addFields(
      { name: "Gateway latency", value: gatewayLatency, inline: true },
      { name: "Uptime", value: formatUptime(process.uptime()), inline: true },
      { name: "Version", value: escapeMarkdown(version), inline: true },
    );
  await replyWithMetric(interaction, runtime, "utility.ping", {
    embeds: [embed],
  });
}

async function handleAvatar(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    return;
  }
  const targetUser =
    interaction.options.getUser("member", false) ?? interaction.user;
  const fetchedMember = await guild.members
    .fetch(targetUser.id)
    .catch(() => null);
  if (!runtime.isCurrent()) {
    await replyCancelled(interaction);
    return;
  }
  const member =
    fetchedMember?.guild.id === runtime.guildId ? fetchedMember : null;
  const serverAvatarUrl = member?.avatarURL({ extension: "png", size: 4096 });
  const globalAvatarUrl = targetUser.displayAvatarURL({
    extension: "png",
    size: 4096,
  });
  const displayName = escapeMarkdown(
    member?.displayName ?? targetUser.globalName ?? targetUser.username,
  );
  const avatarLinks = [
    serverAvatarUrl ? `[Server avatar](${serverAvatarUrl})` : null,
    `[Global avatar](${globalAvatarUrl})`,
  ].filter((link): link is string => link !== null);
  const embed = new EmbedBuilder()
    .setColor(SUPERIOR_PANEL_COLOR)
    .setTitle(`${displayName}'s Avatar`)
    .setDescription(avatarLinks.join(" | "))
    .setImage(serverAvatarUrl ?? globalAvatarUrl)
    .setFooter({ text: `User ID: ${targetUser.id}` });
  await replyWithMetric(interaction, runtime, "utility.avatar", {
    embeds: [embed],
  });
}

async function handleUserInfo(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    return;
  }
  const targetUser =
    interaction.options.getUser("member", false) ?? interaction.user;
  const member = await guild.members.fetch(targetUser.id).catch(() => null);
  if (!runtime.isCurrent()) {
    await replyCancelled(interaction);
    return;
  }
  if (!member || member.guild.id !== runtime.guildId) {
    await replyPrivately(interaction, {
      content: "Could not resolve that member in this server.",
    });
    return;
  }
  const roleCount = Math.max(member.roles.cache.size - 1, 0);
  const embed = new EmbedBuilder()
    .setColor(SUPERIOR_PANEL_COLOR)
    .setTitle("User Information")
    .setThumbnail(member.displayAvatarURL({ extension: "png", size: 512 }))
    .addFields(
      {
        name: "Display name",
        value: escapeMarkdown(member.displayName),
        inline: true,
      },
      { name: "Username", value: escapeMarkdown(targetUser.tag), inline: true },
      { name: "User ID", value: `\`${targetUser.id}\``, inline: true },
      {
        name: "Account type",
        value: targetUser.bot ? "Bot" : "User",
        inline: true,
      },
      { name: "Roles", value: `\`${roleCount}\``, inline: true },
      {
        name: "Account created",
        value: formatDiscordDate(targetUser.createdTimestamp),
      },
      {
        name: "Joined server",
        value:
          member.joinedTimestamp === null
            ? "Unavailable"
            : formatDiscordDate(member.joinedTimestamp),
      },
    );
  await replyWithMetric(interaction, runtime, "utility.userinfo", {
    embeds: [embed],
  });
}

async function handleServerInfo(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    return;
  }
  const boostCount = guild.premiumSubscriptionCount ?? 0;
  const boostTier = Number(guild.premiumTier);
  const embed = new EmbedBuilder()
    .setColor(SUPERIOR_PANEL_COLOR)
    .setTitle("Server Information")
    .setDescription(escapeMarkdown(guild.name))
    .addFields(
      { name: "Server ID", value: `\`${guild.id}\``, inline: true },
      { name: "Members", value: `\`${guild.memberCount}\``, inline: true },
      {
        name: "Channels",
        value: `\`${guild.channels.cache.size}\``,
        inline: true,
      },
      {
        name: "Roles",
        value: `\`${Math.max(guild.roles.cache.size - 1, 0)}\``,
        inline: true,
      },
      {
        name: "Boosts",
        value:
          boostTier > 0
            ? `\`${boostCount}\` (Tier ${boostTier})`
            : `\`${boostCount}\``,
        inline: true,
      },
      { name: "Created", value: formatDiscordDate(guild.createdTimestamp) },
    );
  const iconUrl = guild.iconURL({ extension: "png", size: 512 });
  if (iconUrl) {
    embed.setThumbnail(iconUrl);
  }
  await replyWithMetric(interaction, runtime, "utility.serverinfo", {
    embeds: [embed],
  });
}

async function handleRoleInfo(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const role = interaction.options.getRole("role", true) as Role;
  if (role.guild.id !== runtime.guildId || role.id === runtime.guildId) {
    await replyPrivately(interaction, {
      content:
        role.id === runtime.guildId
          ? "Select a role other than @everyone."
          : "That role does not belong to this server.",
    });
    return;
  }
  const embed = new EmbedBuilder()
    .setColor(SUPERIOR_PANEL_COLOR)
    .setTitle("Role Information")
    .addFields(
      { name: "Name", value: escapeMarkdown(role.name), inline: true },
      { name: "Role ID", value: `\`${role.id}\``, inline: true },
      { name: "Members", value: `\`${role.members.size}\``, inline: true },
      { name: "Position", value: `\`${role.position}\``, inline: true },
      {
        name: "Mentionable",
        value: role.mentionable ? "Yes" : "No",
        inline: true,
      },
      { name: "Managed", value: role.managed ? "Yes" : "No", inline: true },
      { name: "Created", value: formatDiscordDate(role.createdTimestamp) },
    );
  await replyWithMetric(interaction, runtime, "utility.roleinfo", {
    embeds: [embed],
  });
}

async function handleChannelInfo(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const selected = interaction.options.getChannel("channel", false);
  const channel = (selected ?? interaction.channel) as GuildBasedChannel | null;
  if (!channel || channel.guild.id !== runtime.guildId) {
    await replyPrivately(interaction, {
      content: "That channel does not belong to this server.",
    });
    return;
  }
  const parentName = channel.parent?.name
    ? escapeMarkdown(channel.parent.name)
    : "None";
  const embed = new EmbedBuilder()
    .setColor(SUPERIOR_PANEL_COLOR)
    .setTitle("Channel Information")
    .addFields(
      { name: "Name", value: escapeMarkdown(channel.name), inline: true },
      { name: "Channel ID", value: `\`${channel.id}\``, inline: true },
      { name: "Type", value: channelTypeLabel(channel.type), inline: true },
      { name: "Category", value: parentName, inline: true },
      {
        name: "Created",
        value:
          channel.createdTimestamp === null
            ? "Unavailable"
            : formatDiscordDate(channel.createdTimestamp),
      },
    );
  await replyWithMetric(interaction, runtime, "utility.channelinfo", {
    embeds: [embed],
  });
}

async function handleSnowflake(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const rawId = interaction.options.getString("id", true).trim();
  const timestamp = decodeSnowflakeTimestamp(rawId);
  if (timestamp === null) {
    await replyPrivately(interaction, {
      content: "That is not a valid Discord snowflake ID.",
    });
    return;
  }
  await replyWithMetric(interaction, runtime, "utility.snowflake", {
    content: `\`${rawId}\` was created ${formatDiscordDate(timestamp)}.`,
  });
}

async function handleTimestamp(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const input = interaction.options.getString("time", true).trim();
  const zone = runtime.settings.timezone;
  const parsed =
    input.toLowerCase() === "now"
      ? DateTime.now().setZone(zone)
      : DateTime.fromISO(input, {
          zone,
          setZone: /(?:z|[+-]\d\d:\d\d)$/i.test(input),
        });
  if (!parsed.isValid) {
    await replyPrivately(interaction, {
      content: `Could not parse that time. Use \`now\` or an ISO value such as \`2026-07-28T18:30\`.`,
    });
    return;
  }
  const seconds = Math.floor(parsed.toMillis() / 1_000);
  const normalized = parsed.setZone(zone).toFormat("yyyy-LL-dd HH:mm ZZZZ");
  await replyWithMetric(interaction, runtime, "utility.timestamp", {
    content: [
      `Configured timezone: **${escapeMarkdown(zone)}**`,
      `Parsed time: **${escapeMarkdown(normalized)}**`,
      `Discord tags: \`<t:${seconds}:F>\` · \`<t:${seconds}:R>\` · \`<t:${seconds}:t>\``,
      `Preview: <t:${seconds}:F> (<t:${seconds}:R>)`,
    ].join("\n"),
  });
}

export function decodeSnowflakeTimestamp(value: string): number | null {
  if (!/^\d{17,20}$/.test(value)) {
    return null;
  }
  try {
    const snowflake = BigInt(value);
    if (snowflake <= 0n || snowflake > MAX_SNOWFLAKE) {
      return null;
    }
    const timestamp = Number((snowflake >> 22n) + DISCORD_EPOCH_MS);
    const newestAllowed = Date.now() + 5 * 60_000;
    return timestamp >= Number(DISCORD_EPOCH_MS) && timestamp <= newestAllowed
      ? timestamp
      : null;
  } catch {
    return null;
  }
}

async function replyWithMetric(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  metricName: string,
  options: UtilityReplyOptions,
): Promise<void> {
  if (!runtime.isCurrent()) {
    await replyCancelled(interaction);
    return;
  }
  await replyPrivately(interaction, options);
  if (runtime.isCurrent()) {
    runtime.storage.recordCommandMetric(metricName);
  }
}

async function replyCancelled(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await replyPrivately(interaction, { content: UTILITY_CANCELLED_MESSAGE });
}

async function replyPrivately(
  interaction: ChatInputCommandInteraction,
  options: UtilityReplyOptions,
): Promise<void> {
  if (interaction.deferred && !interaction.replied) {
    await interaction.editReply({
      ...options,
      allowedMentions: { parse: [] },
    });
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

function formatDiscordDate(timestamp: number): string {
  const seconds = Math.floor(timestamp / 1_000);
  return `<t:${seconds}:F> (<t:${seconds}:R>)`;
}

function formatUptime(uptimeSeconds: number): string {
  let remainingSeconds = Math.max(0, Math.floor(uptimeSeconds));
  const days = Math.floor(remainingSeconds / 86_400);
  remainingSeconds %= 86_400;
  const hours = Math.floor(remainingSeconds / 3_600);
  remainingSeconds %= 3_600;
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

function channelTypeLabel(type: ChannelType): string {
  return ChannelType[type]?.replace(/^Guild/, "") ?? `Type ${type}`;
}
