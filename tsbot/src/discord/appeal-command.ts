import { SlashCommandBuilder } from "discord.js";

export function buildAppealCommandDefinition() {
  return new SlashCommandBuilder()
    .setName("appeal")
    .setDescription("Submit and track in-guild moderation case appeals")
    .setDMPermission(false)
    .addSubcommand((command) =>
      command
        .setName("submit")
        .setDescription("Appeal one of your eligible moderation cases")
        .addIntegerOption((option) =>
          option
            .setName("case_number")
            .setDescription("Moderation case number")
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(2_147_483_647),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName("status")
        .setDescription("View your recent appeal status")
        .addIntegerOption((option) =>
          option
            .setName("appeal_number")
            .setDescription("Specific appeal number")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(2_147_483_647),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName("withdraw")
        .setDescription("Withdraw one of your pending appeals")
        .addIntegerOption((option) =>
          option
            .setName("appeal_number")
            .setDescription("Appeal number")
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(2_147_483_647),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName("recover")
        .setDescription("Recover an authorized private appeal review message")
        .addIntegerOption((option) =>
          option
            .setName("appeal_number")
            .setDescription("Appeal number")
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(2_147_483_647),
        ),
    );
}
