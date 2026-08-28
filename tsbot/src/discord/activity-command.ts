import {
  SlashCommandBuilder,
  type SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import type { UserMetrics } from "../types.js";

const ACTIVITY_METRICS: Array<{ name: string; value: keyof UserMetrics }> = [
  { name: "Messages sent", value: "messages_sent" },
  { name: "Reactions sent", value: "reactions_sent" },
  { name: "Reactions received", value: "reactions_received" },
  { name: "Battles played", value: "battles_played" },
  { name: "Battles won", value: "battles_won" },
];

export function buildActivityCommandDefinition(): SlashCommandSubcommandsOnlyBuilder {
  return new SlashCommandBuilder()
    .setName("activity")
    .setDescription(
      "Member activity statistics and Administrator backfill tools",
    )
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("stats")
        .setDescription("Show a member's stored activity totals")
        .addUserOption((option) =>
          option
            .setName("member")
            .setDescription("Member to inspect (default: you)")
            .setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("leaderboard")
        .setDescription("Rank stored activity totals without mentions")
        .addStringOption((option) =>
          option
            .setName("metric")
            .setDescription("Activity metric to rank")
            .setRequired(true)
            .addChoices(...ACTIVITY_METRICS),
        )
        .addIntegerOption((option) =>
          option
            .setName("limit")
            .setDescription("Number of entries (1-10; default: 10)")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(10),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("backfill")
        .setDescription("Rebuild activity totals from readable message history")
        .addIntegerOption((option) =>
          option
            .setName("days")
            .setDescription("Days to scan (default: 30; 0: all history)")
            .setRequired(false)
            .setMinValue(0)
            .setMaxValue(3_650),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("backfill-status")
        .setDescription("Show this process's latest activity backfill status"),
    );
}
