import { SlashCommandBuilder } from "discord.js";

const RULE_CHOICES = [
  { name: "Burst spam", value: "burst" },
  { name: "Duplicate spam", value: "duplicate" },
  { name: "Mention spam", value: "mention" },
] as const;

const ACTION_CHOICES = [
  { name: "Delete triggering message", value: "delete" },
  { name: "Delete and warn", value: "delete-and-warn" },
  { name: "Delete and timeout", value: "delete-and-timeout" },
] as const;

export function buildAutomodCommandDefinition() {
  return new SlashCommandBuilder()
    .setName("automod")
    .setDescription("Configure Superior's narrow anti-spam rules")
    .setDMPermission(false)
    .addSubcommand((command) =>
      command
        .setName("status")
        .setDescription("Inspect anti-spam rules and exemptions"),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("rule")
        .setDescription("Configure one anti-spam rule")
        .addSubcommand((command) =>
          command
            .setName("configure")
            .setDescription("Set thresholds, action, and cooldown")
            .addStringOption((option) =>
              option
                .setName("type")
                .setDescription("Rule type")
                .setRequired(true)
                .addChoices(...RULE_CHOICES),
            )
            .addIntegerOption((option) =>
              option
                .setName("threshold")
                .setDescription("Count that triggers enforcement (2-100)")
                .setRequired(true)
                .setMinValue(2)
                .setMaxValue(100),
            )
            .addStringOption((option) =>
              option
                .setName("action")
                .setDescription("Enforcement action")
                .setRequired(true)
                .addChoices(...ACTION_CHOICES),
            )
            .addIntegerOption((option) =>
              option
                .setName("cooldown_seconds")
                .setDescription("Minimum time between actions (1-86400)")
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(86_400),
            )
            .addIntegerOption((option) =>
              option
                .setName("window_seconds")
                .setDescription(
                  "Rolling window for burst/duplicate rules (1-300)",
                )
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(300),
            )
            .addIntegerOption((option) =>
              option
                .setName("timeout_minutes")
                .setDescription(
                  "Timeout duration for delete-and-timeout (1-40320)",
                )
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(40_320),
            )
            .addBooleanOption((option) =>
              option
                .setName("enabled")
                .setDescription("Enable this rule after saving")
                .setRequired(false),
            ),
        )
        .addSubcommand((command) =>
          command
            .setName("enable")
            .setDescription("Enable a configured rule")
            .addStringOption((option) =>
              option
                .setName("type")
                .setDescription("Rule type")
                .setRequired(true)
                .addChoices(...RULE_CHOICES),
            ),
        )
        .addSubcommand((command) =>
          command
            .setName("disable")
            .setDescription("Disable a configured rule")
            .addStringOption((option) =>
              option
                .setName("type")
                .setDescription("Rule type")
                .setRequired(true)
                .addChoices(...RULE_CHOICES),
            ),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("exempt-role")
        .setDescription("Manage anti-spam role exemptions")
        .addSubcommand((command) =>
          command
            .setName("add")
            .setDescription("Add an exempt role")
            .addRoleOption((option) =>
              option
                .setName("role")
                .setDescription("Role to exempt")
                .setRequired(true),
            ),
        )
        .addSubcommand((command) =>
          command
            .setName("remove")
            .setDescription("Remove an exempt role")
            .addRoleOption((option) =>
              option
                .setName("role")
                .setDescription("Role to remove")
                .setRequired(true),
            ),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("exempt-channel")
        .setDescription("Manage anti-spam channel exemptions")
        .addSubcommand((command) =>
          command
            .setName("add")
            .setDescription("Add an exempt channel")
            .addChannelOption((option) =>
              option
                .setName("channel")
                .setDescription("Channel to exempt")
                .setRequired(true),
            ),
        )
        .addSubcommand((command) =>
          command
            .setName("remove")
            .setDescription("Remove an exempt channel")
            .addChannelOption((option) =>
              option
                .setName("channel")
                .setDescription("Channel to remove")
                .setRequired(true),
            ),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName("test")
        .setDescription("Evaluate synthetic counts without moderating anyone")
        .addStringOption((option) =>
          option
            .setName("type")
            .setDescription("Configured rule type")
            .setRequired(true)
            .addChoices(...RULE_CHOICES),
        )
        .addStringOption((option) =>
          option
            .setName("text")
            .setDescription(
              "Synthetic message text for duplicate normalization (max 1000)",
            )
            .setRequired(false)
            .setMaxLength(1_000),
        )
        .addIntegerOption((option) =>
          option
            .setName("message_count")
            .setDescription("Synthetic burst message count")
            .setRequired(false)
            .setMinValue(0)
            .setMaxValue(1_000),
        )
        .addIntegerOption((option) =>
          option
            .setName("repetition_count")
            .setDescription("Synthetic duplicate count")
            .setRequired(false)
            .setMinValue(0)
            .setMaxValue(1_000),
        )
        .addIntegerOption((option) =>
          option
            .setName("user_mentions")
            .setDescription("Synthetic user mention count")
            .setRequired(false)
            .setMinValue(0)
            .setMaxValue(1_000),
        )
        .addIntegerOption((option) =>
          option
            .setName("role_mentions")
            .setDescription("Synthetic role mention count")
            .setRequired(false)
            .setMinValue(0)
            .setMaxValue(1_000),
        ),
    );
}
