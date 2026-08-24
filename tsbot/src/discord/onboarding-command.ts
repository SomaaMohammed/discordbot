import {
  SlashCommandBuilder,
  type SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";

export function buildOnboardingCommandDefinition(): SlashCommandSubcommandsOnlyBuilder {
  return new SlashCommandBuilder()
    .setName("onboarding")
    .setDescription("Configure safe member lifecycle and rules acknowledgement")
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("status")
        .setDescription("Show current onboarding health"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("configure")
        .setDescription("Configure lifecycle logging and account-age alerts")
        .addBooleanOption((option) =>
          option
            .setName("enabled")
            .setDescription("Enable lifecycle processing")
            .setRequired(false),
        )
        .addChannelOption((option) =>
          option
            .setName("log_channel")
            .setDescription("Private lifecycle log channel")
            .setRequired(false),
        )
        .addBooleanOption((option) =>
          option
            .setName("clear_log_channel")
            .setDescription("Remove the lifecycle log binding")
            .setRequired(false),
        )
        .addIntegerOption((option) =>
          option
            .setName("account_age_alert_hours")
            .setDescription(
              "Informational private alert threshold (1-87600 hours)",
            )
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(87_600),
        )
        .addBooleanOption((option) =>
          option
            .setName("clear_account_age_alert")
            .setDescription("Disable account-age alerts")
            .setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("welcome")
        .setDescription("Configure public and best-effort DM welcome delivery")
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("Public welcome channel")
            .setRequired(false),
        )
        .addBooleanOption((option) =>
          option
            .setName("public_enabled")
            .setDescription("Enable public welcome messages")
            .setRequired(false),
        )
        .addBooleanOption((option) =>
          option
            .setName("dm_enabled")
            .setDescription("Enable best-effort welcome DMs")
            .setRequired(false),
        )
        .addStringOption((option) =>
          option
            .setName("title")
            .setDescription("Welcome title template")
            .setRequired(false)
            .setMaxLength(256),
        )
        .addStringOption((option) =>
          option
            .setName("body")
            .setDescription("Welcome body template")
            .setRequired(false)
            .setMaxLength(4_096),
        )
        .addBooleanOption((option) =>
          option
            .setName("clear_channel")
            .setDescription("Remove the public welcome binding")
            .setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("farewell")
        .setDescription("Configure public farewell delivery")
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("Public farewell channel")
            .setRequired(false),
        )
        .addBooleanOption((option) =>
          option
            .setName("public_enabled")
            .setDescription("Enable public farewell messages")
            .setRequired(false),
        )
        .addStringOption((option) =>
          option
            .setName("title")
            .setDescription("Farewell title template")
            .setRequired(false)
            .setMaxLength(256),
        )
        .addStringOption((option) =>
          option
            .setName("body")
            .setDescription("Farewell body template")
            .setRequired(false)
            .setMaxLength(4_096),
        )
        .addBooleanOption((option) =>
          option
            .setName("clear_channel")
            .setDescription("Remove the public farewell binding")
            .setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("rules")
        .setDescription("Create a new immutable server-rules version")
        .addStringOption((option) =>
          option
            .setName("title")
            .setDescription("Rules title")
            .setRequired(true)
            .setMaxLength(256),
        )
        .addStringOption((option) =>
          option
            .setName("body")
            .setDescription("Rules body")
            .setRequired(true)
            .setMaxLength(4_096),
        )
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("Optional public rules channel")
            .setRequired(false),
        )
        .addBooleanOption((option) =>
          option
            .setName("clear_channel")
            .setDescription("Remove the public rules-channel binding")
            .setRequired(false),
        )
        .addBooleanOption((option) =>
          option
            .setName("request_reacceptance")
            .setDescription("Ask members to acknowledge the new version")
            .setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("verification")
        .setDescription("Configure rules acknowledgement roles")
        .addBooleanOption((option) =>
          option
            .setName("enabled")
            .setDescription("Enable button verification")
            .setRequired(true),
        )
        .addRoleOption((option) =>
          option
            .setName("verified_role")
            .setDescription("Role added after acknowledgement")
            .setRequired(false),
        )
        .addRoleOption((option) =>
          option
            .setName("unverified_role")
            .setDescription(
              "Optional role removed only after verified-role success",
            )
            .setRequired(false),
        )
        .addBooleanOption((option) =>
          option
            .setName("clear_unverified_role")
            .setDescription("Remove the unverified-role setting")
            .setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("autorole")
        .setDescription(
          "Add, remove, list, enable, or disable a bounded autorole list",
        )
        .addStringOption((option) =>
          option
            .setName("audience")
            .setDescription("Member kind")
            .setRequired(true)
            .addChoices(
              { name: "Humans", value: "human" },
              { name: "Bots", value: "bot" },
            ),
        )
        .addStringOption((option) =>
          option
            .setName("action")
            .setDescription("Autorole action")
            .setRequired(true)
            .addChoices(
              { name: "List", value: "list" },
              { name: "Add", value: "add" },
              { name: "Remove", value: "remove" },
              { name: "Enable", value: "enable" },
              { name: "Disable", value: "disable" },
            ),
        )
        .addRoleOption((option) =>
          option
            .setName("role")
            .setDescription("Role for add or remove")
            .setRequired(false),
        )
        .addStringOption((option) =>
          option
            .setName("role_id")
            .setDescription("Deleted role ID to remove from the stored list")
            .setRequired(false)
            .setMinLength(17)
            .setMaxLength(20),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("panel")
        .setDescription("Post or refresh the current verification panel")
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("Target text channel")
            .setRequired(true),
        )
        .addBooleanOption((option) =>
          option
            .setName("replace_existing")
            .setDescription("Refresh the tracked panel in this channel")
            .setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("member")
        .setDescription("Show one member's bounded onboarding status")
        .addUserOption((option) =>
          option
            .setName("member")
            .setDescription("Member to inspect")
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("recover")
        .setDescription("Retry bounded safe onboarding work for one member")
        .addUserOption((option) =>
          option
            .setName("member")
            .setDescription("Member to recover")
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("disable")
        .setDescription(
          "Disable lifecycle, verification, and automatic role delivery",
        ),
    );
}
