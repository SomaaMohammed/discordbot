import {
  ChannelType,
  SlashCommandBuilder,
  type SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";

const FIELD_TYPES = [
  { name: "short text", value: "short" },
  { name: "paragraph", value: "paragraph" },
] as const;

export function buildApplicationCommandDefinition(): SlashCommandSubcommandsOnlyBuilder {
  return new SlashCommandBuilder()
    .setName("application")
    .setDescription("Submit and manage private staff applications")
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("submit")
        .setDescription("Open one configured staff application form")
        .addStringOption((option) =>
          option
            .setName("form")
            .setDescription("Enabled application form slug")
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("status")
        .setDescription("Show one application or your recent applications")
        .addIntegerOption((option) =>
          option
            .setName("number")
            .setDescription("Server-local application number")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(2_147_483_647),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("withdraw")
        .setDescription("Withdraw one of your pending applications")
        .addIntegerOption((option) =>
          option
            .setName("number")
            .setDescription("Server-local application number")
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(2_147_483_647),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("panel")
        .setDescription("Post or refresh the staff-application launcher")
        .addBooleanOption((option) =>
          option
            .setName("replace_existing")
            .setDescription("Refresh the tracked launcher when possible")
            .setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("recover")
        .setDescription("Reconcile a missing private review message")
        .addIntegerOption((option) =>
          option
            .setName("number")
            .setDescription("Server-local application number")
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(2_147_483_647),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("form")
        .setDescription("Configure staff application forms")
        .addSubcommand((subcommand) =>
          subcommand
            .setName("list")
            .setDescription("List a bounded page of application forms")
            .addIntegerOption((option) =>
              option
                .setName("page")
                .setDescription("Result page")
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(100),
            ),
        )
        .addSubcommand((subcommand) =>
          addFormOptions(
            subcommand
              .setName("create")
              .setDescription("Create a disabled application form"),
            true,
          ),
        )
        .addSubcommand((subcommand) =>
          addFormOptions(
            subcommand
              .setName("edit")
              .setDescription(
                "Edit an application form and disable it for review",
              ),
            false,
          ),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("enable")
            .setDescription("Enable a validated application form")
            .addStringOption(formSlugOption),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("disable")
            .setDescription("Disable an application form")
            .addStringOption(formSlugOption),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("delete")
            .setDescription("Delete an unused application form")
            .addStringOption(formSlugOption),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("field")
        .setDescription("Configure application form questions")
        .addSubcommand((subcommand) =>
          addFieldOptions(
            subcommand
              .setName("add")
              .setDescription("Add one question to an application form"),
            true,
          ),
        )
        .addSubcommand((subcommand) =>
          addFieldOptions(
            subcommand
              .setName("edit")
              .setDescription("Edit one application question"),
            false,
          ),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("remove")
            .setDescription("Remove an unused application question")
            .addStringOption(formSlugOption)
            .addStringOption((option) =>
              option
                .setName("field")
                .setDescription("Question key")
                .setRequired(true)
                .setMaxLength(32),
            ),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("move")
            .setDescription("Move an application question to a new position")
            .addStringOption(formSlugOption)
            .addStringOption((option) =>
              option
                .setName("field")
                .setDescription("Question key")
                .setRequired(true)
                .setMaxLength(32),
            )
            .addIntegerOption((option) =>
              option
                .setName("position")
                .setDescription("New zero-based position (0-4)")
                .setRequired(true)
                .setMinValue(0)
                .setMaxValue(4),
            ),
        ),
    );
}

function formSlugOption(option: any) {
  return option
    .setName("form")
    .setDescription("Application form slug")
    .setRequired(true)
    .setMaxLength(32);
}

function addFormOptions(subcommand: any, required: boolean) {
  return subcommand
    .addStringOption(formSlugOption)
    .addStringOption((option: any) =>
      option
        .setName("name")
        .setDescription("Display name")
        .setRequired(required)
        .setMaxLength(80),
    )
    .addStringOption((option: any) =>
      option
        .setName("description")
        .setDescription("Short applicant-facing description")
        .setRequired(required)
        .setMaxLength(1_000),
    )
    .addRoleOption((option: any) =>
      option
        .setName("reviewer_role")
        .setDescription("Role allowed to review this form")
        .setRequired(required),
    )
    .addChannelOption((option: any) =>
      option
        .setName("review_channel")
        .setDescription("Private channel that receives applications")
        .setRequired(required)
        .addChannelTypes(ChannelType.GuildText),
    )
    .addIntegerOption((option: any) =>
      option
        .setName("sort_order")
        .setDescription("Launcher order (0-1000)")
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(1_000),
    );
}

function addFieldOptions(subcommand: any, required: boolean) {
  return subcommand
    .addStringOption(formSlugOption)
    .addStringOption((option: any) =>
      option
        .setName("field")
        .setDescription("Stable question key")
        .setRequired(true)
        .setMaxLength(32),
    )
    .addStringOption((option: any) =>
      option
        .setName("label")
        .setDescription("Question label")
        .setRequired(required)
        .setMaxLength(45),
    )
    .addStringOption((option: any) =>
      option
        .setName("type")
        .setDescription("Discord text-input style")
        .setRequired(required)
        .addChoices(...FIELD_TYPES),
    )
    .addIntegerOption((option: any) =>
      option
        .setName("position")
        .setDescription("Zero-based position (0-4)")
        .setRequired(required)
        .setMinValue(0)
        .setMaxValue(4),
    )
    .addStringOption((option: any) =>
      option
        .setName("description")
        .setDescription("Optional question guidance")
        .setRequired(false)
        .setMaxLength(100),
    )
    .addStringOption((option: any) =>
      option
        .setName("placeholder")
        .setDescription("Optional response placeholder")
        .setRequired(false)
        .setMaxLength(100),
    )
    .addBooleanOption((option: any) =>
      option
        .setName("required")
        .setDescription("Whether an answer is required")
        .setRequired(false),
    )
    .addIntegerOption((option: any) =>
      option
        .setName("min_length")
        .setDescription("Minimum answer length")
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(4_000),
    )
    .addIntegerOption((option: any) =>
      option
        .setName("max_length")
        .setDescription("Maximum answer length")
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(4_000),
    );
}
