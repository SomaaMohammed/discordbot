import { SlashCommandBuilder } from "discord.js";

export function buildReportCommandDefinition() {
  return new SlashCommandBuilder()
    .setName("report")
    .setDescription("Submit and track private member reports")
    .setDMPermission(false)
    .addSubcommand((command) =>
      command
        .setName("submit")
        .setDescription("Privately report a member to server staff")
        .addUserOption((option) =>
          option
            .setName("member")
            .setDescription("Member being reported")
            .setRequired(true),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName("status")
        .setDescription("View your recent report status")
        .addIntegerOption((option) =>
          option
            .setName("report_number")
            .setDescription("Specific report number")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(2_147_483_647),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName("withdraw")
        .setDescription("Withdraw one of your pending reports")
        .addIntegerOption((option) =>
          option
            .setName("report_number")
            .setDescription("Report number")
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(2_147_483_647),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName("recover")
        .setDescription("Recover an authorized private report review message")
        .addIntegerOption((option) =>
          option
            .setName("report_number")
            .setDescription("Report number")
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(2_147_483_647),
        ),
    );
}
