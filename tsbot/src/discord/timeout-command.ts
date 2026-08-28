import {
  PermissionFlagsBits,
  SlashCommandBuilder,
  type SlashCommandSubcommandBuilder,
  type SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";

export function buildTimeoutCommandDefinition(): SlashCommandSubcommandsOnlyBuilder {
  return new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Administrator timeout and bounded bulk-timeout tools")
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((subcommand) =>
      addReason(
        subcommand
          .setName("set")
          .setDescription("Timeout one member")
          .addUserOption((option) =>
            option
              .setName("member")
              .setDescription("Member to timeout")
              .setRequired(true),
          )
          .addIntegerOption((option) => durationOption(option)),
      ),
    )
    .addSubcommand((subcommand) =>
      addReason(
        subcommand
          .setName("remove")
          .setDescription("Remove one member's timeout")
          .addUserOption((option) =>
            option
              .setName("member")
              .setDescription("Member whose timeout should be removed")
              .setRequired(true),
          ),
      ),
    )
    .addSubcommand((subcommand) =>
      addDryRunAndReason(
        addMembersOption(
          subcommand
            .setName("set-many")
            .setDescription("Preview or timeout a bounded member list"),
        ).addIntegerOption((option) => durationOption(option)),
      ),
    )
    .addSubcommand((subcommand) =>
      addDryRunAndReason(
        addMembersOption(
          subcommand
            .setName("remove-many")
            .setDescription("Preview or remove timeouts from a member list"),
        ),
      ),
    )
    .addSubcommand((subcommand) =>
      addDryRunAndReason(
        subcommand
          .setName("set-all")
          .setDescription("Preview or timeout all eligible members")
          .addIntegerOption((option) => durationOption(option))
          .addStringOption((option) => confirmationOption(option)),
      ),
    )
    .addSubcommand((subcommand) =>
      addDryRunAndReason(
        subcommand
          .setName("remove-all")
          .setDescription("Preview or remove all eligible timeouts")
          .addStringOption((option) => confirmationOption(option)),
      ),
    );
}

function durationOption(option: any) {
  return option
    .setName("minutes")
    .setDescription("Duration in minutes (1-40320)")
    .setRequired(true)
    .setMinValue(1)
    .setMaxValue(40_320);
}

function confirmationOption(option: any) {
  return option
    .setName("confirm")
    .setDescription("Type CONFIRM")
    .setRequired(true);
}

function addMembersOption(
  subcommand: SlashCommandSubcommandBuilder,
): SlashCommandSubcommandBuilder {
  return subcommand.addStringOption((option) =>
    option
      .setName("members")
      .setDescription("Member mentions or IDs separated by spaces")
      .setRequired(true)
      .setMaxLength(2_000),
  );
}

function addDryRunAndReason(
  subcommand: SlashCommandSubcommandBuilder,
): SlashCommandSubcommandBuilder {
  return addReason(
    subcommand.addBooleanOption((option) =>
      option
        .setName("dry_run")
        .setDescription("Preview without applying timeout changes")
        .setRequired(false),
    ),
  );
}

function addReason(
  subcommand: SlashCommandSubcommandBuilder,
): SlashCommandSubcommandBuilder {
  return subcommand.addStringOption((option) =>
    option
      .setName("reason")
      .setDescription("Optional audit-log reason")
      .setRequired(false)
      .setMaxLength(400),
  );
}
