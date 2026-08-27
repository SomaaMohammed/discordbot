import {
  SlashCommandBuilder,
  type SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import {
  PANEL_PRESETS,
  PANEL_PRESET_DESCRIPTIONS,
  RESOURCE_PANEL_LIMITS,
} from "./panel-theme.js";

const PRESET_CHOICES = PANEL_PRESETS.map((preset) => ({
  name: `${preset}: ${PANEL_PRESET_DESCRIPTIONS[preset]}`.slice(0, 100),
  value: preset,
}));

const VOTE_POLL_TYPE_CHOICES = [
  { name: "Yes / No", value: "yes-no" },
  { name: "Custom options", value: "custom" },
] as const;

const VOTE_DURATION_MAXIMUM_MINUTES = 20_160;

export function buildPanelCommandDefinition(): SlashCommandSubcommandsOnlyBuilder {
  const command = new SlashCommandBuilder()
    .setName("panel")
    .setDescription("Post and inspect fixed Superior server panels")
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("list")
        .setDescription("List Superior panel presets and their purpose"),
    )
    .addSubcommand((subcommand) => {
      subcommand
        .setName("post")
        .setDescription("Post a Superior preset in this channel")
        .addStringOption((option) =>
          option
            .setName("preset")
            .setDescription("Panel preset to post")
            .setRequired(true)
            .addChoices(...PRESET_CHOICES),
        )
        .addStringOption((option) =>
          option
            .setName("resource_title")
            .setDescription("Resources preset title (required for resources)")
            .setRequired(false)
            .setMinLength(1)
            .setMaxLength(RESOURCE_PANEL_LIMITS.title),
        )
        .addStringOption((option) =>
          option
            .setName("resource_body")
            .setDescription("Resources preset body (required for resources)")
            .setRequired(false)
            .setMinLength(1)
            .setMaxLength(RESOURCE_PANEL_LIMITS.body),
        )
        .addStringOption((option) =>
          option
            .setName("role_menu")
            .setDescription("Stored role-menu slug (required for roles)")
            .setRequired(false)
            .setMinLength(1)
            .setMaxLength(32),
        );

      for (let index = 1; index <= RESOURCE_PANEL_LIMITS.links; index += 1) {
        subcommand
          .addStringOption((option) =>
            option
              .setName(`link_${index}_label`)
              .setDescription(`Optional HTTPS link ${index} button label`)
              .setRequired(false)
              .setMinLength(1)
              .setMaxLength(RESOURCE_PANEL_LIMITS.linkLabel),
          )
          .addStringOption((option) =>
            option
              .setName(`link_${index}_url`)
              .setDescription(`Optional HTTPS URL for link ${index}`)
              .setRequired(false)
              .setMinLength(1)
              .setMaxLength(RESOURCE_PANEL_LIMITS.linkUrl),
          );
      }

      return subcommand.addBooleanOption((option) =>
        option
          .setName("replace_existing")
          .setDescription(
            "Safely replace Superior's stored panel in this channel",
          )
          .setRequired(false),
      );
    })
    .addSubcommand((subcommand) =>
      subcommand
        .setName("help")
        .setDescription("Post a guide to every Superior panel type here"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("vote")
        .setDescription("Post an Administrator-managed voting panel here")
        .addStringOption((option) =>
          option
            .setName("question")
            .setDescription("Question voters will answer")
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(256),
        )
        .addStringOption((option) =>
          option
            .setName("poll_type")
            .setDescription("Use Yes / No or custom options")
            .setRequired(true)
            .addChoices(...VOTE_POLL_TYPE_CHOICES),
        )
        .addBooleanOption((option) =>
          option
            .setName("multi_select")
            .setDescription("Allow voters to select more than one option")
            .setRequired(true),
        )
        .addIntegerOption((option) =>
          option
            .setName("duration_minutes")
            .setDescription("0 closes manually; otherwise closes automatically")
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(VOTE_DURATION_MAXIMUM_MINUTES),
        )
        .addBooleanOption((option) =>
          option
            .setName("mention_everyone_on_creation")
            .setDescription("Mention @everyone when the vote is posted")
            .setRequired(true),
        )
        .addBooleanOption((option) =>
          option
            .setName("mention_everyone_on_completion")
            .setDescription("Mention @everyone when the vote completes")
            .setRequired(true),
        )
        // Discord rejects a subcommand as soon as an optional option appears
        // before a required one, so every optional voting setting stays last.
        .addStringOption((option) =>
          option
            .setName("title")
            .setDescription("Optional panel title")
            .setRequired(false)
            .setMinLength(1)
            .setMaxLength(256),
        )
        .addStringOption((option) =>
          option
            .setName("description")
            .setDescription("Optional context for voters")
            .setRequired(false)
            .setMinLength(1)
            .setMaxLength(4_096),
        )
        .addStringOption((option) =>
          option
            .setName("options")
            .setDescription("Custom poll options, one option per line")
            .setRequired(false)
            .setMaxLength(1_000),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("status")
        .setDescription(
          "Inspect stored panels and active ticket-panel configuration",
        ),
    );

  return command;
}
