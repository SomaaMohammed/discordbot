import { SlashCommandBuilder } from "discord.js";

const CASE_NUMBER_MAX = 2_147_483_647;

export function buildModerationCommandDefinition() {
  return new SlashCommandBuilder()
    .setName("moderation")
    .setDescription(
      "Persistent moderation cases and server safety configuration",
    )
    .setDMPermission(false)
    .addSubcommand((command) =>
      command
        .setName("warn")
        .setDescription("Warn a member and create a case")
        .addUserOption((option) =>
          option
            .setName("member")
            .setDescription("Member to warn")
            .setRequired(true),
        )
        .addStringOption((option) =>
          reasonOption(option, "Member-facing warning reason"),
        )
        .addStringOption((option) => privateNoteOption(option)),
    )
    .addSubcommand((command) =>
      command
        .setName("note")
        .setDescription("Add a private moderator note to a member's history")
        .addUserOption((option) =>
          option
            .setName("member")
            .setDescription("Member whose history receives the note")
            .setRequired(true),
        )
        .addStringOption((option) => privateNoteOption(option, true)),
    )
    .addSubcommand((command) =>
      command
        .setName("timeout")
        .setDescription("Timeout a member and create a case")
        .addUserOption((option) =>
          option
            .setName("member")
            .setDescription("Member to timeout")
            .setRequired(true),
        )
        .addIntegerOption((option) =>
          option
            .setName("minutes")
            .setDescription("Duration in minutes (1-40320)")
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(40_320),
        )
        .addStringOption((option) => reasonOption(option))
        .addStringOption((option) => privateNoteOption(option)),
    )
    .addSubcommand((command) =>
      command
        .setName("untimeout")
        .setDescription("Remove a timeout and create a related case")
        .addUserOption((option) =>
          option
            .setName("member")
            .setDescription("Member whose timeout should be removed")
            .setRequired(true),
        )
        .addStringOption((option) => reasonOption(option)),
    )
    .addSubcommand((command) =>
      command
        .setName("kick")
        .setDescription("Kick a member and create a case")
        .addUserOption((option) =>
          option
            .setName("member")
            .setDescription("Member to kick")
            .setRequired(true),
        )
        .addStringOption((option) => reasonOption(option))
        .addStringOption((option) => privateNoteOption(option)),
    )
    .addSubcommand((command) =>
      command
        .setName("ban")
        .setDescription("Ban a member and create a case")
        .addUserOption((option) =>
          option
            .setName("member")
            .setDescription("Member to ban")
            .setRequired(true),
        )
        .addStringOption((option) => reasonOption(option))
        .addIntegerOption((option) =>
          option
            .setName("delete_message_seconds")
            .setDescription(
              "Recent message history to delete (0-604800 seconds)",
            )
            .setRequired(false)
            .setMinValue(0)
            .setMaxValue(604_800),
        )
        .addStringOption((option) => privateNoteOption(option)),
    )
    .addSubcommand((command) =>
      command
        .setName("unban")
        .setDescription("Unban a user by ID and create a case")
        .addStringOption((option) =>
          option
            .setName("user_id")
            .setDescription("Banned user's Discord ID")
            .setRequired(true)
            .setMinLength(17)
            .setMaxLength(20),
        )
        .addStringOption((option) => reasonOption(option)),
    )
    .addSubcommand((command) =>
      command
        .setName("history")
        .setDescription("Inspect a member's bounded moderation history")
        .addUserOption((option) =>
          option
            .setName("member")
            .setDescription("Member to inspect")
            .setRequired(true),
        )
        .addIntegerOption((option) =>
          option
            .setName("page")
            .setDescription("History page")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(10_000),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName("case")
        .setDescription("Inspect a moderation case")
        .addIntegerOption((option) => caseNumberOption(option))
        .addIntegerOption((option) =>
          option
            .setName("page")
            .setDescription("Audit-event page")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(10_000),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName("amend")
        .setDescription("Amend a case while preserving its prior values")
        .addIntegerOption((option) => caseNumberOption(option))
        .addStringOption((option) =>
          option
            .setName("public_reason")
            .setDescription("Replacement member-facing reason")
            .setRequired(false)
            .setMinLength(1)
            .setMaxLength(500),
        )
        .addStringOption((option) => privateNoteOption(option)),
    )
    .addSubcommand((command) =>
      command
        .setName("void")
        .setDescription("Void a case record without changing Discord state")
        .addIntegerOption((option) => caseNumberOption(option))
        .addStringOption((option) =>
          reasonOption(option, "Reason for voiding this record"),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName("status")
        .setDescription("Inspect moderation and safety configuration"),
    )
    .addSubcommand((command) =>
      command
        .setName("configure")
        .setDescription(
          "Configure moderation logs, reports, appeals, and anti-spam",
        )
        .addBooleanOption((option) =>
          option
            .setName("cases_enabled")
            .setDescription("Allow new moderation cases")
            .setRequired(true),
        )
        .addChannelOption((option) =>
          option
            .setName("moderation_log")
            .setDescription("Moderation case log channel")
            .setRequired(false),
        )
        .addBooleanOption((option) =>
          option
            .setName("reports_enabled")
            .setDescription("Allow new member reports")
            .setRequired(false),
        )
        .addChannelOption((option) =>
          option
            .setName("report_channel")
            .setDescription("Private report review channel")
            .setRequired(false),
        )
        .addRoleOption((option) =>
          option
            .setName("report_reviewer_role")
            .setDescription("Report reviewer role")
            .setRequired(false),
        )
        .addBooleanOption((option) =>
          option
            .setName("appeals_enabled")
            .setDescription("Allow in-guild case appeals")
            .setRequired(false),
        )
        .addChannelOption((option) =>
          option
            .setName("appeal_channel")
            .setDescription("Private appeal review channel")
            .setRequired(false),
        )
        .addRoleOption((option) =>
          option
            .setName("appeal_reviewer_role")
            .setDescription("Appeal reviewer role")
            .setRequired(false),
        )
        .addBooleanOption((option) =>
          option
            .setName("anti_spam_enabled")
            .setDescription("Enable configured anti-spam rules")
            .setRequired(false),
        )
        .addIntegerOption((option) =>
          option
            .setName("report_cooldown_limit")
            .setDescription("Reports allowed per cooldown window (1-10)")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(10),
        )
        .addIntegerOption((option) =>
          option
            .setName("report_cooldown_window_seconds")
            .setDescription(
              "Persistent report cooldown window (60-86400 seconds)",
            )
            .setRequired(false)
            .setMinValue(60)
            .setMaxValue(86_400),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName("disable")
        .setDescription(
          "Disable new moderation and safety actions without deleting history",
        ),
    )
    .addSubcommand((command) =>
      command
        .setName("recover")
        .setDescription("Recover a case attempt or retry its log delivery")
        .addIntegerOption((option) => caseNumberOption(option))
        .addStringOption((option) =>
          option
            .setName("mode")
            .setDescription("Recovery operation")
            .setRequired(true)
            .addChoices(
              { name: "Retry case log", value: "log" },
              { name: "Confirm Discord success", value: "confirm" },
              { name: "Record explicit failure", value: "fail" },
            ),
        )
        .addStringOption((option) =>
          option
            .setName("failure_code")
            .setDescription("Bounded audit code for fail mode")
            .setRequired(false)
            .setMinLength(1)
            .setMaxLength(100),
        ),
    );
}

function reasonOption(option: any, description = "Member-facing reason") {
  return option
    .setName("reason")
    .setDescription(description)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(500);
}

function privateNoteOption(option: any, required = false) {
  return option
    .setName("private_note")
    .setDescription("Private staff-only note")
    .setRequired(required)
    .setMinLength(1)
    .setMaxLength(1_000);
}

function caseNumberOption(option: any) {
  return option
    .setName("case_number")
    .setDescription("Guild-local case number")
    .setRequired(true)
    .setMinValue(1)
    .setMaxValue(CASE_NUMBER_MAX);
}
