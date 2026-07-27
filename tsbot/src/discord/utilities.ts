import {
  EmbedBuilder,
  SlashCommandBuilder,
  escapeMarkdown,
  type ChatInputCommandInteraction,
  type InteractionReplyOptions,
  type SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import type { GuildRuntime } from "../runtime.js";

const UTILITY_COMMAND_NAME = "utility";
const UTILITY_CANCELLED_MESSAGE =
  "Action cancelled because this server was disabled, removed, purged, or its configuration changed.";

type UtilityReplyOptions = Pick<InteractionReplyOptions, "content" | "embeds">;

export function buildUtilityCommandDefinition(): SlashCommandSubcommandsOnlyBuilder {
  return new SlashCommandBuilder()
    .setName(UTILITY_COMMAND_NAME)
    .setDescription("Useful server and member information")
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("ping")
        .setDescription("Check whether the bot is responsive"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("avatar")
        .setDescription("Show a member's avatar")
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
    );
}

export async function handleUtilityCommand(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  if (!(await validateUtilityContext(interaction, runtime))) {
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  switch (subcommand) {
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
    await replyPrivately(interaction, {
      content: "Use this command inside a server.",
    });
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
  const serverAvatarUrl = member?.avatarURL({
    extension: "png",
    size: 4096,
  });
  const globalAvatarUrl = targetUser.displayAvatarURL({
    extension: "png",
    size: 4096,
  });
  const displayName =
    member?.displayName ?? targetUser.globalName ?? targetUser.username;
  const avatarLinks = [
    serverAvatarUrl ? `[Server avatar](${serverAvatarUrl})` : null,
    `[Global avatar](${globalAvatarUrl})`,
  ].filter((link): link is string => link !== null);

  const embed = new EmbedBuilder()
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
    await replyPrivately(interaction, {
      content: "Use this command inside a server.",
    });
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

  if (!fetchedMember || fetchedMember.guild.id !== runtime.guildId) {
    await replyPrivately(interaction, {
      content: "Could not resolve that member in this server.",
    });
    return;
  }

  const roleCount = Math.max(fetchedMember.roles.cache.size - 1, 0);
  const joinedAt = fetchedMember.joinedTimestamp;
  const embed = new EmbedBuilder()
    .setTitle("User Information")
    .setThumbnail(
      fetchedMember.displayAvatarURL({ extension: "png", size: 512 }),
    )
    .addFields(
      {
        name: "Display name",
        value: escapeMarkdown(fetchedMember.displayName),
        inline: true,
      },
      {
        name: "Username",
        value: escapeMarkdown(targetUser.tag),
        inline: true,
      },
      { name: "User ID", value: `\`${targetUser.id}\``, inline: true },
      {
        name: "Account type",
        value: targetUser.bot ? "Bot" : "User",
        inline: true,
      },
      {
        name: "Roles",
        value: `\`${roleCount}\``,
        inline: true,
      },
      {
        name: "Account created",
        value: formatDiscordDate(targetUser.createdTimestamp),
      },
      {
        name: "Joined server",
        value: joinedAt === null ? "Unavailable" : formatDiscordDate(joinedAt),
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
    await replyPrivately(interaction, {
      content: "Use this command inside a server.",
    });
    return;
  }

  const roleCount = Math.max(guild.roles.cache.size - 1, 0);
  const boostCount = guild.premiumSubscriptionCount ?? 0;
  const boostTier = Number(guild.premiumTier);
  const boostSummary =
    boostTier > 0
      ? `\`${boostCount}\` (Tier ${boostTier})`
      : `\`${boostCount}\``;
  const embed = new EmbedBuilder()
    .setTitle("Server Information")
    .setDescription(escapeMarkdown(guild.name))
    .addFields(
      { name: "Server ID", value: `\`${guild.id}\``, inline: true },
      {
        name: "Members",
        value: `\`${guild.memberCount}\``,
        inline: true,
      },
      {
        name: "Channels",
        value: `\`${guild.channels.cache.size}\``,
        inline: true,
      },
      { name: "Roles", value: `\`${roleCount}\``, inline: true },
      { name: "Boosts", value: boostSummary, inline: true },
      {
        name: "Created",
        value: formatDiscordDate(guild.createdTimestamp),
      },
    );

  const iconUrl = guild.iconURL({ extension: "png", size: 512 });
  if (iconUrl) {
    embed.setThumbnail(iconUrl);
  }

  await replyWithMetric(interaction, runtime, "utility.serverinfo", {
    embeds: [embed],
  });
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
  await interaction.reply({
    ...options,
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
}

function formatDiscordDate(timestamp: number): string {
  const seconds = Math.floor(timestamp / 1000);
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

  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds}s`);
  }

  return parts.join(" ");
}
