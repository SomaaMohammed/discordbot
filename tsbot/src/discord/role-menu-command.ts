import {
  SlashCommandBuilder,
  type SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";

export function buildRoleMenuCommandDefinition(): SlashCommandSubcommandsOnlyBuilder {
  return new SlashCommandBuilder()
    .setName("rolemenu")
    .setDescription("Configure persistent safe self-service role menus")
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("list")
        .setDescription("List stored role menus")
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
      subcommand
        .setName("create")
        .setDescription("Create a disabled role-menu definition")
        .addStringOption((option) =>
          option
            .setName("slug")
            .setDescription("Unique short name")
            .setRequired(true)
            .setMinLength(2)
            .setMaxLength(32),
        )
        .addStringOption((option) =>
          option
            .setName("title")
            .setDescription("Public menu title")
            .setRequired(true)
            .setMaxLength(256),
        )
        .addStringOption((option) =>
          option
            .setName("description")
            .setDescription("Public menu description")
            .setRequired(true)
            .setMaxLength(1_000),
        )
        .addStringOption((option) =>
          option
            .setName("mode")
            .setDescription("Selection behavior")
            .setRequired(true)
            .addChoices(
              { name: "Toggle", value: "toggle" },
              { name: "Exclusive", value: "exclusive" },
              { name: "Limited", value: "limited" },
            ),
        )
        .addIntegerOption((option) =>
          option
            .setName("minimum")
            .setDescription("Minimum selected roles (0-25)")
            .setRequired(false)
            .setMinValue(0)
            .setMaxValue(25),
        )
        .addIntegerOption((option) =>
          option
            .setName("maximum")
            .setDescription("Maximum selected roles (1-25)")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(25),
        )
        .addIntegerOption(menuPositionOption)
        .addRoleOption((option) =>
          option
            .setName("required_role")
            .setDescription("Optional role required to use this menu")
            .setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("edit")
        .setDescription("Edit a menu; definition changes stale controls")
        .addStringOption(menuSlugOption)
        .addStringOption((option) =>
          option
            .setName("title")
            .setDescription("Replacement public title")
            .setRequired(false)
            .setMaxLength(256),
        )
        .addStringOption((option) =>
          option
            .setName("description")
            .setDescription("Replacement public description")
            .setRequired(false)
            .setMaxLength(1_000),
        )
        .addStringOption((option) =>
          option
            .setName("mode")
            .setDescription("Replacement selection behavior")
            .setRequired(false)
            .addChoices(
              { name: "Toggle", value: "toggle" },
              { name: "Exclusive", value: "exclusive" },
              { name: "Limited", value: "limited" },
            ),
        )
        .addIntegerOption((option) =>
          option
            .setName("minimum")
            .setDescription("Replacement minimum (0-25)")
            .setRequired(false)
            .setMinValue(0)
            .setMaxValue(25),
        )
        .addIntegerOption((option) =>
          option
            .setName("maximum")
            .setDescription("Replacement maximum (1-25)")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(25),
        )
        .addRoleOption((option) =>
          option
            .setName("required_role")
            .setDescription("Replacement prerequisite role")
            .setRequired(false),
        )
        .addBooleanOption((option) =>
          option
            .setName("clear_required_role")
            .setDescription("Remove the current prerequisite role")
            .setRequired(false),
        )
        .addIntegerOption(menuPositionOption),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("option")
        .setDescription("Manage stable role-menu options")
        .addSubcommand((subcommand) =>
          subcommand
            .setName("add")
            .setDescription("Add one safe role option")
            .addStringOption(menuSlugOption)
            .addRoleOption((option) =>
              option
                .setName("role")
                .setDescription("Safe self-service role")
                .setRequired(true),
            )
            .addStringOption((option) =>
              option
                .setName("label")
                .setDescription("Visible option label")
                .setRequired(true)
                .setMaxLength(100),
            )
            .addStringOption((option) =>
              option
                .setName("description")
                .setDescription("Optional visible description")
                .setRequired(false)
                .setMaxLength(100),
            )
            .addStringOption((option) =>
              option
                .setName("emoji")
                .setDescription("Optional single Unicode emoji")
                .setRequired(false)
                .setMaxLength(16),
            )
            .addIntegerOption((option) =>
              option
                .setName("position")
                .setDescription("One-based display position")
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(25),
            ),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("edit")
            .setDescription("Edit one option; published controls become stale")
            .addStringOption(menuSlugOption)
            .addStringOption(optionIdOption)
            .addRoleOption((option) =>
              option
                .setName("role")
                .setDescription("Replacement safe role")
                .setRequired(false),
            )
            .addStringOption((option) =>
              option
                .setName("label")
                .setDescription("Replacement label")
                .setRequired(false)
                .setMaxLength(100),
            )
            .addStringOption((option) =>
              option
                .setName("description")
                .setDescription("Replacement description")
                .setRequired(false)
                .setMaxLength(100),
            )
            .addStringOption((option) =>
              option
                .setName("emoji")
                .setDescription("Replacement single Unicode emoji")
                .setRequired(false)
                .setMaxLength(16),
            )
            .addBooleanOption((option) =>
              option
                .setName("clear_description")
                .setDescription("Remove the option description")
                .setRequired(false),
            )
            .addBooleanOption((option) =>
              option
                .setName("clear_emoji")
                .setDescription("Remove the option emoji")
                .setRequired(false),
            ),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("remove")
            .setDescription("Remove one option without stripping member roles")
            .addStringOption(menuSlugOption)
            .addStringOption(optionIdOption),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("move")
            .setDescription("Move one option to a new display position")
            .addStringOption(menuSlugOption)
            .addStringOption(optionIdOption)
            .addIntegerOption((option) =>
              option
                .setName("position")
                .setDescription("One-based display position")
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(25),
            ),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("post")
        .setDescription("Publish one enabled persistent role menu")
        .addStringOption(menuSlugOption),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("status")
        .setDescription("Inspect a menu and its current bindings")
        .addStringOption(menuSlugOption),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("enable")
        .setDescription("Verify every current role and enable a menu")
        .addStringOption(menuSlugOption),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("disable")
        .setDescription("Disable changes without stripping member roles")
        .addStringOption(menuSlugOption),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("archive")
        .setDescription("Archive a menu while preserving history")
        .addStringOption(menuSlugOption),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("recover")
        .setDescription(
          "Repair bounded posts or one member's partial selection",
        )
        .addStringOption(menuSlugOption)
        .addUserOption((option) =>
          option
            .setName("member")
            .setDescription(
              "Optional member whose latest partial selection should be retried",
            )
            .setRequired(false),
        ),
    );
}

function menuSlugOption<
  T extends {
    setName(name: string): T;
    setDescription(value: string): T;
    setRequired(value: boolean): T;
    setMinLength(value: number): T;
    setMaxLength(value: number): T;
  },
>(option: T): T {
  return option
    .setName("slug")
    .setDescription("Stored menu short name")
    .setRequired(true)
    .setMinLength(2)
    .setMaxLength(32);
}

function optionIdOption<
  T extends {
    setName(name: string): T;
    setDescription(value: string): T;
    setRequired(value: boolean): T;
    setMinLength(value: number): T;
    setMaxLength(value: number): T;
  },
>(option: T): T {
  return option
    .setName("option_id")
    .setDescription("Stable option ID shown by status")
    .setRequired(true)
    .setMinLength(8)
    .setMaxLength(24);
}

function menuPositionOption<
  T extends {
    setName(name: string): T;
    setDescription(value: string): T;
    setRequired(value: boolean): T;
    setMinValue(value: number): T;
    setMaxValue(value: number): T;
  },
>(option: T): T {
  return option
    .setName("position")
    .setDescription("One-based menu display position")
    .setRequired(false)
    .setMinValue(1)
    .setMaxValue(25);
}
