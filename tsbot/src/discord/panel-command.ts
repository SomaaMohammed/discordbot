import {
  ChannelType,
  PermissionFlagsBits,
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

export function buildPanelCommandDefinition(): SlashCommandSubcommandsOnlyBuilder {
  const command = new SlashCommandBuilder()
    .setName("panel")
    .setDescription("Post and inspect fixed Superior server panels")
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("list")
        .setDescription("List Superior panel presets and their purpose"),
    )
    .addSubcommand((subcommand) => {
      subcommand
        .setName("post")
        .setDescription(
          "Post a Superior preset in a text or announcement channel",
        )
        .addStringOption((option) =>
          option
            .setName("preset")
            .setDescription("Panel preset to post")
            .setRequired(true)
            .addChoices(...PRESET_CHOICES),
        )
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("Text or announcement channel for the panel")
            .setRequired(true)
            .addChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildAnnouncement,
            ),
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
        .setName("status")
        .setDescription(
          "Inspect stored panels and active ticket-panel configuration",
        ),
    );

  return command;
}
