import {
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type ModalSubmitInteraction,
  type SlashCommandSubcommandBuilder,
  type SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import type { BotRuntime, GuildRuntime } from "../runtime.js";
import type { UserMetrics } from "../types.js";
import {
  ACTIVITY_SUBCOMMANDS,
  handleActivityCommand,
  handleFunCommand,
} from "./activity.js";
import {
  handleGreetingAutocomplete,
  handleGreetingCommand,
} from "./greetings.js";
import {
  MODERATION_SUBCOMMANDS,
  handleModerationCommand,
} from "./moderation.js";
import {
  PANEL_SUBCOMMANDS,
  handlePanelButton,
  handlePanelCommand,
  handlePanelModal,
} from "./panels.js";
import { buildPanelCommandDefinition } from "./panel-command.js";
import { handlePresetPanelCommand } from "./preset-panels.js";
import {
  buildSetupCommandDefinition,
  handleSetupCommand,
  requireSetupAdmin,
} from "./setup.js";
import {
  buildUtilityCommandDefinition,
  handleUtilityCommand,
} from "./utilities.js";
import { evaluateGuildManagement } from "./ticket-authorization.js";
import { buildTicketCommandDefinition } from "./ticket-command.js";
import { handleTicketCommand } from "./ticket-commands-handler.js";
import {
  handleTicketButton,
  handleTicketModal,
} from "./ticket-interactions.js";

const SUPERIOR_SUBCOMMANDS = [
  "say",
  "dmpanel",
  "rolepanel",
  "rolepanelmulti",
  "purge",
  "purgeuser",
  "lock",
  "unlock",
  "slowmode",
  "timeout",
  "untimeout",
  "mutemany",
  "unmutemany",
  "muteall",
  "unmuteall",
  "backfillstats",
  "backfillstatus",
  "help",
] as const;

const SUPERIOR_DESCRIPTIONS: Record<
  (typeof SUPERIOR_SUBCOMMANDS)[number],
  string
> = {
  say: "Send an administrator-authored announcement",
  dmpanel: "Post a safe private-message panel",
  rolepanel: "Post one self-service role button",
  rolepanelmulti: "Post up to five self-service role buttons",
  purge: "Delete recent messages with explicit age accounting",
  purgeuser: "Scan and delete recent messages from one member",
  lock: "Add and track a reversible @everyone send-message deny",
  unlock: "Remove only a deny tracked by this running process",
  slowmode: "Set a channel's slowmode delay",
  timeout: "Timeout one member",
  untimeout: "Remove one member's timeout",
  mutemany: "Preview or timeout a bounded member list",
  unmutemany: "Preview or untimeout a bounded member list",
  muteall: "Preview or timeout all eligible members within the cap",
  unmuteall: "Preview or untimeout all eligible members within the cap",
  backfillstats: "Rebuild activity metrics from readable message history",
  backfillstatus: "Show this process's latest backfill status",
  help: "Show the supported command families and safety model",
};

const FUN_METRICS: Array<{ name: string; value: keyof UserMetrics }> = [
  { name: "Messages sent", value: "messages_sent" },
  { name: "Reactions sent", value: "reactions_sent" },
  { name: "Reactions received", value: "reactions_received" },
  { name: "Battles played", value: "battles_played" },
  { name: "Battles won", value: "battles_won" },
];

export function buildCommandDefinitions(): Array<
  SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder
> {
  const superior = new SlashCommandBuilder()
    .setName("superior")
    .setDescription("Server administration, moderation, and safety tools")
    .setDMPermission(false);
  for (const name of SUPERIOR_SUBCOMMANDS) {
    superior.addSubcommand((subcommand) => {
      subcommand.setName(name).setDescription(SUPERIOR_DESCRIPTIONS[name]);
      addSuperiorOptions(name, subcommand);
      return subcommand;
    });
  }

  const fun = new SlashCommandBuilder()
    .setName("fun")
    .setDescription("Lightweight member activities and aggregate stats")
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("battle")
        .setDescription("Run a simple random matchup")
        .addUserOption((option) =>
          option
            .setName("opponent")
            .setDescription("Your opponent")
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("stats")
        .setDescription("Show a member's stored activity totals")
        .addUserOption((option) =>
          option
            .setName("member")
            .setDescription("Member to inspect (defaults to you)")
            .setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("leaderboard")
        .setDescription("Rank stored activity totals without pinging members")
        .addStringOption((option) =>
          option
            .setName("metric")
            .setDescription("Metric to rank")
            .setRequired(true)
            .addChoices(...FUN_METRICS),
        )
        .addIntegerOption((option) =>
          option
            .setName("limit")
            .setDescription("Number of entries (1-10)")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(10),
        ),
    );

  const greetings = new SlashCommandBuilder()
    .setName("greetings")
    .setDescription("Send a configured greeting to the current invoker")
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("send")
        .setDescription("Send a greeting profile to yourself")
        .addStringOption((option) =>
          option
            .setName("profile")
            .setDescription("Configured profile")
            .setRequired(true)
            .setAutocomplete(true),
        ),
    );

  return [
    buildSetupCommandDefinition(),
    superior,
    buildPanelCommandDefinition(),
    buildTicketCommandDefinition(),
    buildUtilityCommandDefinition(),
    fun,
    greetings,
  ];
}

function addSuperiorOptions(
  name: (typeof SUPERIOR_SUBCOMMANDS)[number],
  subcommand: SlashCommandSubcommandBuilder,
): void {
  switch (name) {
    case "say":
      subcommand
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("Target channel")
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("message")
            .setDescription("Announcement text")
            .setRequired(true)
            .setMaxLength(2_000),
        )
        .addBooleanOption((option) =>
          option
            .setName("mention_everyone")
            .setDescription("Explicitly ping @everyone (default: no)")
            .setRequired(false),
        );
      return;
    case "dmpanel":
      subcommand
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("Target channel (defaults to current)")
            .setRequired(false),
        )
        .addUserOption((option) =>
          option
            .setName("target")
            .setDescription("Message recipient (defaults to you)")
            .setRequired(false),
        );
      addPanelTextOptions(subcommand, true);
      return;
    case "rolepanel":
      subcommand
        .addRoleOption((option) =>
          option
            .setName("role")
            .setDescription("Safe self-service role")
            .setRequired(true),
        )
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("Target channel (defaults to current)")
            .setRequired(false),
        );
      addPanelTextOptions(subcommand, true);
      return;
    case "rolepanelmulti":
      for (let slot = 1; slot <= 5; slot += 1) {
        subcommand.addRoleOption((option) =>
          option
            .setName(`role_${slot}`)
            .setDescription(`Role button ${slot}`)
            .setRequired(slot <= 2),
        );
      }
      subcommand.addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Target channel (defaults to current)")
          .setRequired(false),
      );
      addPanelTextOptions(subcommand, false);
      return;
    case "purge":
      subcommand
        .addIntegerOption((option) =>
          option
            .setName("amount")
            .setDescription("Recent messages to inspect (1-100)")
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(100),
        )
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("Target channel (defaults to current)")
            .setRequired(false),
        );
      return;
    case "purgeuser":
      subcommand
        .addUserOption((option) =>
          option
            .setName("member")
            .setDescription("Message author")
            .setRequired(true),
        )
        .addIntegerOption((option) =>
          option
            .setName("scan_limit")
            .setDescription("History messages to scan (1-500, default 200)")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(500),
        )
        .addIntegerOption((option) =>
          option
            .setName("delete_limit")
            .setDescription("Matching messages to delete (1-100, default 100)")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(100),
        )
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("Target channel (defaults to current)")
            .setRequired(false),
        );
      return;
    case "lock":
    case "unlock":
      addChannelAndReason(subcommand);
      return;
    case "slowmode":
      subcommand.addIntegerOption((option) =>
        option
          .setName("seconds")
          .setDescription("Delay in seconds (0-21600)")
          .setRequired(true)
          .setMinValue(0)
          .setMaxValue(21_600),
      );
      addChannelAndReason(subcommand);
      return;
    case "timeout":
      subcommand
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
        );
      addReason(subcommand);
      return;
    case "untimeout":
      subcommand.addUserOption((option) =>
        option
          .setName("member")
          .setDescription("Member to untimeout")
          .setRequired(true),
      );
      addReason(subcommand);
      return;
    case "mutemany":
      addMembersOption(subcommand);
      subcommand.addIntegerOption((option) =>
        option
          .setName("minutes")
          .setDescription("Duration in minutes (1-40320)")
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(40_320),
      );
      addDryRunAndReason(subcommand);
      return;
    case "unmutemany":
      addMembersOption(subcommand);
      addDryRunAndReason(subcommand);
      return;
    case "muteall":
      subcommand
        .addIntegerOption((option) =>
          option
            .setName("minutes")
            .setDescription("Duration in minutes (1-40320)")
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(40_320),
        )
        .addStringOption((option) =>
          option
            .setName("confirm")
            .setDescription("Type CONFIRM")
            .setRequired(true),
        );
      addDryRunAndReason(subcommand);
      return;
    case "unmuteall":
      subcommand.addStringOption((option) =>
        option
          .setName("confirm")
          .setDescription("Type CONFIRM")
          .setRequired(true),
      );
      addDryRunAndReason(subcommand);
      return;
    case "backfillstats":
      subcommand.addIntegerOption((option) =>
        option
          .setName("days")
          .setDescription("Days to scan; 0 means all readable history")
          .setRequired(false)
          .setMinValue(0)
          .setMaxValue(3_650),
      );
      return;
    case "backfillstatus":
    case "help":
      return;
  }
}

function addPanelTextOptions(
  subcommand: SlashCommandSubcommandBuilder,
  includeButtonLabel: boolean,
): void {
  subcommand
    .addStringOption((option) =>
      option
        .setName("title")
        .setDescription("Optional panel title")
        .setRequired(false)
        .setMaxLength(256),
    )
    .addStringOption((option) =>
      option
        .setName("description")
        .setDescription("Optional panel description")
        .setRequired(false)
        .setMaxLength(4_096),
    );
  if (includeButtonLabel) {
    subcommand.addStringOption((option) =>
      option
        .setName("button_label")
        .setDescription("Optional button label")
        .setRequired(false)
        .setMaxLength(80),
    );
  }
}

function addChannelAndReason(subcommand: SlashCommandSubcommandBuilder): void {
  subcommand.addChannelOption((option) =>
    option
      .setName("channel")
      .setDescription("Target channel (defaults to current)")
      .setRequired(false),
  );
  addReason(subcommand);
}

function addReason(subcommand: SlashCommandSubcommandBuilder): void {
  subcommand.addStringOption((option) =>
    option
      .setName("reason")
      .setDescription("Optional audit-log reason")
      .setRequired(false)
      .setMaxLength(400),
  );
}

function addMembersOption(subcommand: SlashCommandSubcommandBuilder): void {
  subcommand.addStringOption((option) =>
    option
      .setName("members")
      .setDescription("Member mentions or IDs separated by spaces")
      .setRequired(true)
      .setMaxLength(2_000),
  );
}

function addDryRunAndReason(subcommand: SlashCommandSubcommandBuilder): void {
  subcommand.addBooleanOption((option) =>
    option
      .setName("dry_run")
      .setDescription("Preview without applying timeouts")
      .setRequired(false),
  );
  addReason(subcommand);
}

export async function handleChatInputCommand(
  interaction: ChatInputCommandInteraction,
  runtime: BotRuntime,
): Promise<void> {
  if (
    !interaction.guild ||
    !interaction.guildId ||
    interaction.guild.id !== interaction.guildId
  ) {
    await replyPrivate(interaction, "Use this command inside a server.");
    return;
  }
  const command = interaction.commandName;
  const subcommand = interaction.options.getSubcommand(false);
  if (!subcommand) {
    await replyPrivate(interaction, "Choose a supported subcommand.");
    return;
  }
  let guildRuntime = await runtime.forGuild(interaction.guildId);
  if (command === "setup") {
    await deferPrivate(interaction);
    const actor = await requireSetupAdmin(interaction);
    if (!actor) return;
    if (!guildRuntime) {
      runtime.storage.ensureGuild(interaction.guildId, interaction.guild.name);
      guildRuntime = await runtime.forGuild(interaction.guildId);
    }
    if (!guildRuntime) {
      await replyPrivate(
        interaction,
        "Could not initialize setup for this server.",
      );
      return;
    }
    await handleSetupCommand(interaction, runtime, guildRuntime, actor);
    return;
  }
  if (!guildRuntime?.settings.enabled || guildRuntime.settings.reviewRequired) {
    await replyPrivate(
      interaction,
      "Superior is disabled or awaiting administrator review. Begin with `/setup status`.",
    );
    return;
  }
  if (!guildRuntime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server was disabled or reconfigured. Please try again.",
    );
    return;
  }
  if (command === "utility") {
    await handleUtilityCommand(interaction, guildRuntime);
    return;
  }
  if (command === "greetings") {
    if (!guildRuntime.settings.features.greetings) {
      await replyPrivate(interaction, "Greetings are disabled in this server.");
      return;
    }
    await handleGreetingCommand(interaction, guildRuntime);
    return;
  }
  if (command === "fun") {
    await handleFunCommand(interaction, guildRuntime);
    return;
  }
  if (command === "panel" || command === "ticket") {
    await deferPrivate(interaction);
    const actor = await requireAdministrator(interaction, guildRuntime);
    if (!actor) return;
    if (command === "panel") {
      await handlePresetPanelCommand(interaction, guildRuntime, actor);
    } else {
      await handleTicketCommand(interaction, guildRuntime, actor);
    }
    return;
  }
  if (command !== "superior") {
    await replyPrivate(interaction, "Unknown command family.");
    return;
  }
  if (subcommand === "help") {
    await handleHelp(interaction);
    guildRuntime.storage.recordCommandMetric("superior.help");
    return;
  }
  await deferPrivate(interaction);
  const actor = await requireAdministrator(interaction, guildRuntime);
  if (!actor) return;
  if (PANEL_SUBCOMMANDS.has(subcommand)) {
    await handlePanelCommand(interaction, guildRuntime, actor);
    return;
  }
  if (MODERATION_SUBCOMMANDS.has(subcommand)) {
    await handleModerationCommand(interaction, guildRuntime, actor);
    return;
  }
  if (ACTIVITY_SUBCOMMANDS.has(subcommand)) {
    if (!guildRuntime.settings.features.activityMetrics) {
      await replyPrivate(
        interaction,
        "Activity metrics are disabled in this server.",
      );
      return;
    }
    await handleActivityCommand(interaction, guildRuntime);
    return;
  }
  await replyPrivate(interaction, "Unknown Superior subcommand.");
}

export async function handleAutocompleteInteraction(
  interaction: AutocompleteInteraction,
  runtime: BotRuntime,
): Promise<void> {
  await handleGreetingAutocomplete(interaction, runtime);
}

export async function handleButtonInteraction(
  interaction: ButtonInteraction,
  runtime: BotRuntime,
): Promise<void> {
  const guildRuntime = await getCurrentComponentRuntime(interaction, runtime);
  if (!guildRuntime) return;
  if (await handleTicketButton(interaction, guildRuntime)) return;
  if (await handlePanelButton(interaction, guildRuntime)) return;
  await replyPrivate(
    interaction,
    "This button is outdated or unsupported. Ask an administrator to post the panel again.",
  );
}

export async function handleModalSubmitInteraction(
  interaction: ModalSubmitInteraction,
  runtime: BotRuntime,
): Promise<void> {
  const guildRuntime = await getCurrentComponentRuntime(interaction, runtime);
  if (!guildRuntime) return;
  if (await handleTicketModal(interaction, guildRuntime)) return;
  if (await handlePanelModal(interaction, guildRuntime)) return;
  await replyPrivate(
    interaction,
    "This form is outdated or unsupported. Ask an administrator to post the panel again.",
  );
}

async function getCurrentComponentRuntime(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  runtime: BotRuntime,
): Promise<GuildRuntime | null> {
  if (
    !interaction.guild ||
    !interaction.guildId ||
    interaction.guild.id !== interaction.guildId
  ) {
    await replyPrivate(
      interaction,
      "Use this interaction inside its original server.",
    );
    return null;
  }
  const guildRuntime = await runtime.forGuild(interaction.guildId);
  if (
    !guildRuntime?.settings.enabled ||
    guildRuntime.settings.reviewRequired ||
    !guildRuntime.isCurrent()
  ) {
    await replyPrivate(
      interaction,
      "This server is disabled or awaiting configuration review.",
    );
    return null;
  }
  return guildRuntime;
}

async function requireAdministrator(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<GuildMember | null> {
  const guild = interaction.guild;
  if (!guild || guild.id !== runtime.guildId) return null;
  const actor = await guild.members
    .fetch(interaction.user.id)
    .catch(() => null);
  if (!actor || actor.guild.id !== runtime.guildId) {
    await replyPrivate(interaction, "Could not verify your server membership.");
    return null;
  }
  if (
    !evaluateGuildManagement({
      guildId: runtime.guildId,
      ownerId: guild.ownerId,
      member: actor,
    }).allowed
  ) {
    await replyPrivate(
      interaction,
      "Only the server owner or an Administrator can use that command.",
    );
    return null;
  }
  return actor;
}

async function handleHelp(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await replyPrivate(
    interaction,
    [
      "**Superior command guide**",
      "`/setup` — administrator configuration, validation, export, import, and purge",
      "`/panel` — fixed Superior help, server, resource, and ticket panels",
      "`/ticket` — administrator ticket setup, status, launcher, and recovery",
      "`/superior` — announcements, legacy safe panels, moderation, backfill, and this help",
      "`/utility` — private member/server/role/channel/ID/time information",
      "`/fun` — battles and aggregate activity statistics",
      "`/greetings send` — greet the person invoking the command",
      "Natural chat responds only to a leading/trailing configured invocation, a bot mention, or a direct reply to Superior.",
    ].join("\n"),
  );
}

async function replyPrivate(
  interaction:
    ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction,
  content: string,
): Promise<void> {
  if (interaction.deferred && !interaction.replied) {
    await interaction.editReply({ content, allowedMentions: { parse: [] } });
    return;
  }
  if (interaction.replied) {
    await interaction.followUp({
      content,
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }
  await interaction.reply({
    content,
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
}

async function deferPrivate(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true });
  }
}
