import {
  PermissionFlagsBits,
  SlashCommandBuilder,
  type SlashCommandSubcommandBuilder,
  type SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";

export function buildChannelCommandDefinition(): SlashCommandSubcommandsOnlyBuilder {
  return new SlashCommandBuilder()
    .setName("channel")
    .setDescription("Administrator tools for channel messages and access")
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("announce")
        .setDescription("Send an Administrator-authored announcement")
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("Channel that should receive the announcement")
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("message")
            .setDescription("Announcement text")
            .setRequired(true)
            .setMaxLength(2_000),
        )
        .addBooleanOption((option) =>
          option
            .setName("mention_everyone")
            .setDescription("Mention @everyone (default: false)")
            .setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("purge")
        .setDescription("Delete recent messages with explicit age accounting")
        .addIntegerOption((option) =>
          option
            .setName("amount")
            .setDescription("Recent messages to inspect (1-100)")
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(100),
        )
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("Target channel (default: current channel)")
            .setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("purge-member")
        .setDescription("Delete recent messages from one member")
        .addUserOption((option) =>
          option
            .setName("member")
            .setDescription("Member whose messages should be deleted")
            .setRequired(true),
        )
        .addIntegerOption((option) =>
          option
            .setName("scan_limit")
            .setDescription("Messages to scan (1-500; default: 200)")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(500),
        )
        .addIntegerOption((option) =>
          option
            .setName("delete_limit")
            .setDescription("Matches to delete (1-100; default: 100)")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(100),
        )
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("Target channel (default: current channel)")
            .setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      addChannelAndReason(
        subcommand
          .setName("lock")
          .setDescription("Block @everyone from sending messages"),
      ),
    )
    .addSubcommand((subcommand) =>
      addChannelAndReason(
        subcommand
          .setName("unlock")
          .setDescription("Remove a channel lock created by this process"),
      ),
    )
    .addSubcommand((subcommand) =>
      addChannelAndReason(
        subcommand
          .setName("slowmode")
          .setDescription("Set the channel slowmode delay")
          .addIntegerOption((option) =>
            option
              .setName("seconds")
              .setDescription("Delay in seconds (0-21600)")
              .setRequired(true)
              .setMinValue(0)
              .setMaxValue(21_600),
          ),
      ),
    );
}

function addChannelAndReason(
  subcommand: SlashCommandSubcommandBuilder,
): SlashCommandSubcommandBuilder {
  return subcommand
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("Target channel (default: current channel)")
        .setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Optional audit-log reason")
        .setRequired(false)
        .setMaxLength(400),
    );
}
