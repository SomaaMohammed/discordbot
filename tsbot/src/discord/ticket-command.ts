import {
  ChannelType,
  SlashCommandBuilder,
  type SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";

export function buildTicketCommandDefinition(): SlashCommandSubcommandsOnlyBuilder {
  return new SlashCommandBuilder()
    .setName("ticket")
    .setDescription("Configure and manage Superior's ticket service")
    .setDMPermission(false)
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
    )
    .addSubcommandGroup((group) =>
      group
        .setName("department")
        .setDescription("Configure ticket departments and routing")
        .addSubcommand((subcommand) =>
          subcommand
            .setName("list")
            .setDescription("List configured ticket departments")
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
          addDepartmentOptions(
            subcommand
              .setName("create")
              .setDescription("Create a disabled ticket department"),
            true,
          ),
        )
        .addSubcommand((subcommand) =>
          addDepartmentOptions(
            subcommand
              .setName("edit")
              .setDescription("Edit department metadata or Discord routing"),
            false,
          ),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("enable")
            .setDescription("Enable a validated ticket department")
            .addStringOption(departmentSlugOption),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("disable")
            .setDescription("Disable one ticket department")
            .addStringOption(departmentSlugOption),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("delete")
            .setDescription("Delete a department that has no tickets")
            .addStringOption(departmentSlugOption),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("health")
            .setDescription("Inspect one department's routing and permissions")
            .addStringOption(departmentSlugOption),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("field")
        .setDescription("Configure ticket intake form fields")
        .addSubcommand((subcommand) =>
          addFieldOptions(
            subcommand
              .setName("add")
              .setDescription("Add a field to one department form"),
            true,
          ),
        )
        .addSubcommand((subcommand) =>
          addFieldOptions(
            subcommand
              .setName("edit")
              .setDescription("Edit one department form field"),
            false,
          ),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("remove")
            .setDescription("Remove one department form field")
            .addStringOption(departmentSlugOption)
            .addStringOption((option) =>
              option
                .setName("field")
                .setDescription("Field key")
                .setRequired(true)
                .setMaxLength(32),
            ),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("move")
            .setDescription("Move one field to a new form position")
            .addStringOption(departmentSlugOption)
            .addStringOption((option) =>
              option
                .setName("field")
                .setDescription("Field key")
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

function departmentSlugOption(option: any) {
  return option
    .setName("department")
    .setDescription("Department slug")
    .setRequired(true)
    .setMaxLength(32);
}

function addDepartmentOptions(subcommand: any, required: boolean) {
  return subcommand
    .addStringOption(departmentSlugOption)
    .addStringOption((option: any) =>
      option
        .setName("name")
        .setDescription("Department display name")
        .setRequired(required)
        .setMaxLength(80),
    )
    .addStringOption((option: any) =>
      option
        .setName("description")
        .setDescription("Short member-facing description")
        .setRequired(required)
        .setMaxLength(1_000),
    )
    .addChannelOption((option: any) =>
      option
        .setName("category")
        .setDescription("Private ticket category")
        .setRequired(required)
        .addChannelTypes(ChannelType.GuildCategory),
    )
    .addChannelOption((option: any) =>
      option
        .setName("log_channel")
        .setDescription("Closure log and transcript channel")
        .setRequired(required)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    )
    .addRoleOption((option: any) =>
      option
        .setName("support_role")
        .setDescription("Role that manages this department's tickets")
        .setRequired(required),
    )
    .addStringOption((option: any) =>
      option
        .setName("emoji")
        .setDescription("Optional single Unicode emoji; use none to clear")
        .setRequired(false)
        .setMaxLength(32),
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
    .addStringOption(departmentSlugOption)
    .addStringOption((option: any) =>
      option
        .setName("field")
        .setDescription("Stable field key")
        .setRequired(true)
        .setMaxLength(32),
    )
    .addStringOption((option: any) =>
      option
        .setName("label")
        .setDescription("Member-facing field label")
        .setRequired(required)
        .setMaxLength(45),
    )
    .addStringOption((option: any) =>
      option
        .setName("type")
        .setDescription("Discord text-input style")
        .setRequired(required)
        .addChoices(
          { name: "short text", value: "short" },
          { name: "paragraph", value: "paragraph" },
        ),
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
        .setDescription("Optional field guidance")
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
        .setDescription("Whether a response is required")
        .setRequired(false),
    )
    .addIntegerOption((option: any) =>
      option
        .setName("min_length")
        .setDescription("Minimum response length")
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(4_000),
    )
    .addIntegerOption((option: any) =>
      option
        .setName("max_length")
        .setDescription("Maximum response length")
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(4_000),
    );
}
