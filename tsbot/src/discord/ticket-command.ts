import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";

export function buildTicketCommandDefinition(): SlashCommandSubcommandsOnlyBuilder {
  return new SlashCommandBuilder()
    .setName("ticket")
    .setDescription("Configure and manage Superior's ticket service")
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("setup")
        .setDescription("Configure the ticket category, log, and support role")
        .addChannelOption((option) =>
          option
            .setName("category")
            .setDescription(
              "Category where private ticket channels are created",
            )
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildCategory),
        )
        .addChannelOption((option) =>
          option
            .setName("log_channel")
            .setDescription(
              "Channel that receives closure records and transcripts",
            )
            .setRequired(true)
            .addChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildAnnouncement,
            ),
        )
        .addRoleOption((option) =>
          option
            .setName("support_role")
            .setDescription("Role authorized to view and manage tickets")
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("status")
        .setDescription(
          "Inspect ticket configuration and required permissions",
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("panel")
        .setDescription("Post or refresh the Superior ticket launcher")
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("Channel that should contain the ticket launcher")
            .setRequired(true)
            .addChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildAnnouncement,
            ),
        )
        .addBooleanOption((option) =>
          option
            .setName("replace_existing")
            .setDescription(
              "Refresh the tracked launcher in this channel when possible",
            )
            .setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("disable")
        .setDescription("Stop new tickets without removing existing records"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("recover")
        .setDescription("Reconcile an interrupted or missing ticket channel")
        .addIntegerOption((option) =>
          option
            .setName("ticket_number")
            .setDescription("Server-local ticket number")
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(2_147_483_647),
        ),
    );
}
