import {
  SlashCommandBuilder,
  type SlashCommandSubcommandBuilder,
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
    .setDescription("Create, post, and inspect Superior server panels")
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("list")
        .setDescription("List tracked panel presets and their purpose"),
    )
    .addSubcommand((subcommand) => {
      subcommand
        .setName("post")
        .setDescription("Post a tracked preset in the current channel")
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
            "Refresh the tracked panel in this channel (default: true)",
          )
          .setRequired(false),
      );
    })
    .addSubcommand((subcommand) =>
      subcommand
        .setName("help")
        .setDescription("Post a practical panel-creation guide here"),
    )
    .addSubcommand((subcommand) => {
      addPanelTextOptions(
        subcommand
          .setName("dmpanel")
          .setDescription("Post an Administrator-managed private-message panel")
          .addUserOption((option) =>
            option
              .setName("target")
              .setDescription("Message recipient (default: you)")
              .setRequired(false),
          ),
        true,
      );
      return subcommand;
    })
    .addSubcommand((subcommand) => {
      addPanelTextOptions(
        subcommand
          .setName("role-button")
          .setDescription("Post one Administrator-managed role button")
          .addRoleOption((option) =>
            option
              .setName("role")
              .setDescription("Safe self-service role")
              .setRequired(true),
          ),
        true,
      );
      return subcommand;
    })
    .addSubcommand((subcommand) => {
      subcommand
        .setName("role-buttons")
        .setDescription("Post two to five Administrator-managed role buttons");
      for (let slot = 1; slot <= 5; slot += 1) {
        subcommand.addRoleOption((option) =>
          option
            .setName(`role_${slot}`)
            .setDescription(`Safe self-service role ${slot}`)
            .setRequired(slot <= 2),
        );
      }
      addPanelTextOptions(subcommand, false);
      return subcommand;
    })
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
        .setDescription("Inspect tracked preset panels and workflow readiness"),
    );

  return command;
}

function addPanelTextOptions(
  subcommand: SlashCommandSubcommandBuilder,
  includeButtonLabel: boolean,
): void {
  subcommand
    .addStringOption((option) =>
      option
        .setName("title")
        .setDescription("Panel title (uses a default when omitted)")
        .setRequired(false)
        .setMaxLength(256),
    )
    .addStringOption((option) =>
      option
        .setName("description")
        .setDescription("Panel description (uses a default when omitted)")
        .setRequired(false)
        .setMaxLength(4_096),
    );
  if (includeButtonLabel) {
    subcommand.addStringOption((option) =>
      option
        .setName("button_label")
        .setDescription("Button label (uses a default when omitted)")
        .setRequired(false)
        .setMaxLength(80),
    );
  }
}
