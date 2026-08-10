import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type SlashCommandOptionsOnlyBuilder,
  type SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";

export const RESTRICTED_PING_LIST_PAGE_SIZE = 5;

export function buildPingRoleCommandDefinition(): SlashCommandOptionsOnlyBuilder {
  return new SlashCommandBuilder()
    .setName("pingrole")
    .setDescription("Ping one restricted role in its configured channel")
    .setDMPermission(false)
    .addRoleOption((option) =>
      option
        .setName("role")
        .setDescription("Configured restricted-ping role")
        .setRequired(true),
    );
}

export function buildRestrictedPingCommandDefinition(): SlashCommandSubcommandsOnlyBuilder {
  return new SlashCommandBuilder()
    .setName("restrictedping")
    .setDescription("Configure restricted role pings for this server")
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("add")
        .setDescription("Allow one restricted role in one channel")
        .addRoleOption((option) =>
          option
            .setName("role")
            .setDescription("Non-mentionable role to configure")
            .setRequired(true),
        )
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("Allowed channel or thread parent")
            .setRequired(true)
            .addChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildAnnouncement,
              ChannelType.GuildForum,
              ChannelType.GuildMedia,
            ),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("remove")
        .setDescription("Remove one role-to-channel mapping")
        .addRoleOption((option) =>
          option
            .setName("role")
            .setDescription("Configured restricted-ping role")
            .setRequired(true),
        )
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("Allowed channel to remove")
            .setRequired(true)
            .addChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildAnnouncement,
              ChannelType.GuildForum,
              ChannelType.GuildMedia,
            ),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("cleanup-role")
        .setDescription("Remove stale configuration using a deleted role ID")
        .addStringOption((option) =>
          option
            .setName("role_id")
            .setDescription("Exact Discord ID of the deleted role")
            .setRequired(true)
            .setMinLength(17)
            .setMaxLength(20),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("cleanup-channel")
        .setDescription("Remove stale mappings using a deleted channel ID")
        .addStringOption((option) =>
          option
            .setName("channel_id")
            .setDescription("Exact Discord ID of the deleted channel")
            .setRequired(true)
            .setMinLength(17)
            .setMaxLength(20),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("list")
        .setDescription("List a bounded page of restricted-ping roles")
        .addIntegerOption((option) =>
          option
            .setName("page")
            .setDescription("Result page")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(1_000),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("info")
        .setDescription("Inspect one restricted-ping role")
        .addRoleOption((option) =>
          option
            .setName("role")
            .setDescription("Configured restricted-ping role")
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("enable")
        .setDescription("Enable one restricted-ping role")
        .addRoleOption((option) =>
          option
            .setName("role")
            .setDescription("Restricted-ping role to enable")
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("disable")
        .setDescription("Disable one restricted-ping role")
        .addRoleOption((option) =>
          option
            .setName("role")
            .setDescription("Restricted-ping role to disable")
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("configure")
        .setDescription("Change cooldowns or thread behavior for one role")
        .addRoleOption((option) =>
          option
            .setName("role")
            .setDescription("Restricted-ping role to configure")
            .setRequired(true),
        )
        .addIntegerOption((option) =>
          option
            .setName("user_cooldown_seconds")
            .setDescription("Seconds between each member's successful pings")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(86_400),
        )
        .addIntegerOption((option) =>
          option
            .setName("role_cooldown_seconds")
            .setDescription("Role-wide delay in seconds; 0 disables it")
            .setRequired(false)
            .setMinValue(0)
            .setMaxValue(86_400),
        )
        .addBooleanOption((option) =>
          option
            .setName("allow_threads")
            .setDescription(
              "Allow child threads/posts under configured channels",
            )
            .setRequired(false),
        ),
    );
}
