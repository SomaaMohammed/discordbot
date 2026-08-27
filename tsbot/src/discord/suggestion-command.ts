import {
  ChannelType,
  SlashCommandBuilder,
  type SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";

export const SUGGESTION_COMMAND_STATES = [
  { name: "open", value: "open" },
  { name: "under review", value: "under-review" },
  { name: "accepted", value: "accepted" },
  { name: "declined", value: "declined" },
  { name: "implemented", value: "implemented" },
  { name: "withdrawn", value: "withdrawn" },
] as const;

export function buildSuggestionCommandDefinition(): SlashCommandSubcommandsOnlyBuilder {
  return new SlashCommandBuilder()
    .setName("suggestion")
    .setDescription("Submit, track, vote on, and review server suggestions")
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("submit")
        .setDescription("Open the private suggestion submission form"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("status")
        .setDescription("Show one suggestion or your recent submissions")
        .addIntegerOption((option) =>
          option
            .setName("number")
            .setDescription("Server-local suggestion number")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(2_147_483_647),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("withdraw")
        .setDescription("Withdraw one of your open suggestions")
        .addIntegerOption((option) =>
          option
            .setName("number")
            .setDescription("Server-local suggestion number")
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(2_147_483_647),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("configure")
        .setDescription("Configure suggestion routing and rate limits")
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("Channel where public suggestions are posted")
            .setRequired(true)
            .addChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildAnnouncement,
            ),
        )
        .addRoleOption((option) =>
          option
            .setName("reviewer_role")
            .setDescription("Role allowed to review suggestions")
            .setRequired(true),
        )
        .addChannelOption((option) =>
          option
            .setName("review_channel")
            .setDescription("Optional private staff review and audit channel")
            .setRequired(false)
            .addChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildAnnouncement,
            ),
        )
        .addBooleanOption((option) =>
          option
            .setName("create_threads")
            .setDescription("Create a discussion thread for each suggestion")
            .setRequired(false),
        )
        .addIntegerOption((option) =>
          option
            .setName("cooldown_limit")
            .setDescription("Submissions allowed per window (1-10; default 3)")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(10),
        )
        .addIntegerOption((option) =>
          option
            .setName("cooldown_seconds")
            .setDescription(
              "Rate-limit window in seconds (60-3600; default 600)",
            )
            .setRequired(false)
            .setMinValue(60)
            .setMaxValue(3_600),
        )
        .addBooleanOption((option) =>
          option
            .setName("allow_self_votes")
            .setDescription("Allow authors to vote on their own suggestions")
            .setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("panel")
        .setDescription("Post or refresh the Superior suggestion launcher")
        .addBooleanOption((option) =>
          option
            .setName("replace_existing")
            .setDescription("Refresh the tracked launcher when possible")
            .setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("list")
        .setDescription("List a bounded page of suggestions for review")
        .addStringOption((option) =>
          option
            .setName("state")
            .setDescription("Optional workflow state filter")
            .setRequired(false)
            .addChoices(...SUGGESTION_COMMAND_STATES),
        )
        .addIntegerOption((option) =>
          option
            .setName("page")
            .setDescription("Result page (10 suggestions per page)")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(1_000),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("review")
        .setDescription("Change a suggestion state with a review reason")
        .addIntegerOption((option) =>
          option
            .setName("number")
            .setDescription("Server-local suggestion number")
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(2_147_483_647),
        )
        .addStringOption((option) =>
          option
            .setName("state")
            .setDescription("New review state")
            .setRequired(true)
            .addChoices(...SUGGESTION_COMMAND_STATES.slice(1, 5)),
        )
        .addStringOption((option) =>
          option
            .setName("reason")
            .setDescription("Short decision or review reason")
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(500),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("disable")
        .setDescription("Stop new suggestions without deleting stored records"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("recover")
        .setDescription("Reconcile a missing public suggestion message")
        .addIntegerOption((option) =>
          option
            .setName("number")
            .setDescription("Server-local suggestion number")
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(2_147_483_647),
        ),
    );
}
