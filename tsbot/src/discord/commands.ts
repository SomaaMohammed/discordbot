import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ComponentType,
  EmbedBuilder,
  ModalBuilder,
  NewsChannel,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
  ThreadAutoArchiveDuration,
  type AnyThreadChannel,
  type ButtonInteraction,
  type Channel,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Message,
  type ModalSubmitInteraction,
  type SlashCommandSubcommandBuilder,
  Role,
} from "discord.js";
import { existsSync, statSync } from "node:fs";
import { DateTime, Duration } from "luxon";
import {
  CATEGORY_DESCRIPTIONS,
  IMPERIAL_OMENS,
  POST_RECORD_LIMIT,
  RIO_USER_ID,
  ROLE_PANEL_BUTTON_CUSTOM_ID,
  ROLE_PANEL_BUTTON_LABEL_MAX_LENGTH,
  ROLE_PANEL_DEFAULT_BUTTON_LABEL,
  ROLE_COLOR,
  ROLE_PANEL_FOOTER_PREFIX,
  ROLE_PANEL_MAX_BUTTONS,
  ROLE_PANEL_TARGETS_FOOTER_PREFIX,
  TAYLOR_USER_ID,
  THREAD_CLOSE_HOURS,
  USER_FUN_METRIC_FIELDS,
  URL_PATTERN,
} from "../constants.js";
import {
  backfillLookbackText,
  buildRoyalAfkStatusReport,
  buildAnnouncementMentions,
  countOpenAndOverduePosts,
  extractRolePanelButtonSlot,
  extractRolePanelRoleIdForSlot,
  getBackfillStatusSnapshot,
  getFateReading,
  markBackfillFinished,
  markBackfillStarted,
  getPostCloseDeadline,
  mergeImportedState,
  normalizeQuestionText,
  randomImperialTitle,
  randomImperialVerdict,
} from "../parity.js";
import { formatDuration, isoNow, parseIso } from "../time.js";
import type { BotMode, PostRecord, RoyalTitle } from "../types.js";
import type { BotRuntime } from "../runtime.js";

const COURT_COMMANDS = [
  "status",
  "health",
  "analytics",
  "dryrun",
  "exportstate",
  "importstate",
  "mode",
  "channel",
  "logchannel",
  "schedule",
  "listcategories",
  "addquestion",
  "deletequestion",
  "editquestion",
  "resethistory",
  "post",
  "custom",
  "close",
  "listopen",
  "extend",
  "reopen",
  "removeanswer",
] as const;

const QUESTIONS_COMMANDS = ["count", "unused", "audit"] as const;
const INVICTUS_COMMANDS = [
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
  "afk",
  "afkstatus",
  "resetroyaltimer",
  "help",
] as const;
const FUN_COMMANDS = ["battle", "stats", "leaderboard", "verdict", "title", "fate"] as const;
const GREETINGS_COMMANDS = ["rio", "taylor"] as const;

const CATEGORY_CHOICES = Object.keys(CATEGORY_DESCRIPTIONS).map((category) => ({
  name: category,
  value: category,
}));

const MSG_USE_IN_SERVER = "Use this inside the server.";
const MSG_USE_TEXT_CHANNEL = "Use this command inside a text channel.";
const MSG_VERIFY_ROLES = "Could not verify your roles.";
const MSG_BOT_CONTEXT_ERROR = "Could not verify bot permissions in this server.";
const MSG_CONFIRM_REQUIRED = "Confirmation failed. Type `CONFIRM` exactly.";
const PREVIEW_ISSUES_PREFIX = "\n\nPreview issues:\n";
const MSG_QUESTION_EMPTY = "Question cannot be empty.";
const MSG_INQUIRY_CLOSED = "This court inquiry is already closed.";
const MSG_UNKNOWN_QUESTION = "Unknown question";
const MSG_ROYAL_ONLY = "Only the Emperor or Empress can use this command.";
const ANON_ANSWER_BUTTON_ID = "court:anonymous_answer";
const ANON_MODAL_PREFIX = "court:anonymous_answer_modal:";
const ANON_MODAL_INPUT_ID = "answer";
const ADMIN_SAY_MODAL_PREFIX = "invictus:admin_say_modal:";
const ADMIN_SAY_MODAL_INPUT_ID = "message";
const INVICTUS_DM_PANEL_BUTTON_ID = "invictus:dm_panel";
const INVICTUS_DM_PANEL_MODAL_PREFIX = "invictus:dm_panel_modal:";
const INVICTUS_DM_PANEL_MODAL_INPUT_ID = "dm_message";
const INVICTUS_DM_PANEL_FOOTER_PREFIX = "InvictusDmTarget:";
const INVICTUS_DM_PANEL_DEFAULT_BUTTON_LABEL = "Message Invictus";

const BOSS_STATS = ["Strength", "Speed", "Wisdom", "Charisma", "Luck", "Endurance"];
const USER_FUN_LEADERBOARD_METRICS = new Set(USER_FUN_METRIC_FIELDS.map(([metricName]) => metricName));
const USER_FUN_METRIC_LABELS = new Map(USER_FUN_METRIC_FIELDS);

const NOT_MIGRATED_MESSAGE =
  "This command is not wired in the current TypeScript runtime build yet.";

const STAFF_REQUIRED_COMMANDS = new Set<string>(["court", "questions"]);

type RuntimeCommandHandler = (interaction: ChatInputCommandInteraction, runtime: BotRuntime) => Promise<void>;
type SubcommandOptionBuilder = (subcommand: SlashCommandSubcommandBuilder) => void;
type DmPanelTargetChannel = TextChannel | NewsChannel | AnyThreadChannel;

const COURT_SUBCOMMAND_OPTION_BUILDERS: Partial<Record<(typeof COURT_COMMANDS)[number], SubcommandOptionBuilder>> = {
  mode: (subcommand) => {
    subcommand.addStringOption((option) =>
      option
        .setName("mode")
        .setDescription("off, manual, or auto")
        .setRequired(false)
        .addChoices(
          { name: "off", value: "off" },
          { name: "manual", value: "manual" },
          { name: "auto", value: "auto" },
        ),
    );
  },
  dryrun: (subcommand) => {
    subcommand.addBooleanOption((option) =>
      option
        .setName("enabled")
        .setDescription("When enabled, scheduled auto-post logs what it would post without posting")
        .setRequired(true),
    );
  },
  channel: (subcommand) => {
    subcommand.addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("The text channel to post in")
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText),
    );
  },
  logchannel: (subcommand) => {
    subcommand.addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("Leave empty to disable logging")
        .setRequired(false)
        .addChannelTypes(ChannelType.GuildText),
    );
  },
  schedule: (subcommand) => {
    subcommand
      .addIntegerOption((option) => option.setName("hour").setDescription("Hour (0-23)").setRequired(false))
      .addIntegerOption((option) => option.setName("minute").setDescription("Minute (0-59)").setRequired(false));
  },
  post: (subcommand) => {
    subcommand
      .addStringOption((option) =>
        option
          .setName("category")
          .setDescription("Optional category")
          .setRequired(false)
          .addChoices(...CATEGORY_CHOICES),
      )
      .addBooleanOption((option) =>
        option
          .setName("randomize")
          .setDescription("Post randomly or pick the first available question")
          .setRequired(false),
      );
  },
  custom: (subcommand) => {
    subcommand.addStringOption((option) => option.setName("question").setDescription("Your custom court question").setRequired(true));
  },
  importstate: (subcommand) => {
    subcommand
      .addAttachmentOption((option) =>
        option
          .setName("file")
          .setDescription("JSON file previously exported by this bot")
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("confirm")
          .setDescription("Type CONFIRM to apply")
          .setRequired(true),
      );
  },
  addquestion: (subcommand) => {
    subcommand
      .addStringOption((option) =>
        option
          .setName("category")
          .setDescription("Question category")
          .setRequired(true)
          .addChoices(...CATEGORY_CHOICES),
      )
      .addStringOption((option) =>
        option
          .setName("question")
          .setDescription("The question text")
          .setRequired(true),
      );
  },
  deletequestion: (subcommand) => {
    subcommand
      .addStringOption((option) =>
        option
          .setName("category")
          .setDescription("Question category")
          .setRequired(true)
          .addChoices(...CATEGORY_CHOICES),
      )
      .addStringOption((option) =>
        option
          .setName("question")
          .setDescription("Paste the exact question text to remove")
          .setRequired(true),
      );
  },
  editquestion: (subcommand) => {
    subcommand
      .addStringOption((option) =>
        option
          .setName("category")
          .setDescription("Question category")
          .setRequired(true)
          .addChoices(...CATEGORY_CHOICES),
      )
      .addStringOption((option) =>
        option
          .setName("old_question")
          .setDescription("Paste the exact old question")
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("new_question")
          .setDescription("The new replacement question")
          .setRequired(true),
      );
  },
  close: (subcommand) => {
    subcommand.addStringOption((option) =>
      option.setName("message_id").setDescription("Optional inquiry message ID to close").setRequired(false),
    );
  },
  extend: (subcommand) => {
    subcommand
      .addStringOption((option) => option.setName("message_id").setDescription("Inquiry message ID").setRequired(true))
      .addIntegerOption((option) =>
        option
          .setName("additional_hours")
          .setDescription("Hours to add (1-168)")
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(168),
      );
  },
  reopen: (subcommand) => {
    subcommand
      .addStringOption((option) => option.setName("message_id").setDescription("Inquiry message ID").setRequired(true))
      .addIntegerOption((option) =>
        option
          .setName("close_after_hours")
          .setDescription("New auto-close window in hours (1-168)")
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(168),
      );
  },
  removeanswer: (subcommand) => {
    subcommand.addStringOption((option) => option.setName("message_id").setDescription("Anonymous answer message ID").setRequired(true));
  },
};

const INVICTUS_SUBCOMMAND_OPTION_BUILDERS: Partial<Record<(typeof INVICTUS_COMMANDS)[number], SubcommandOptionBuilder>> = {
  dmpanel: (subcommand) => {
    subcommand
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Target channel (defaults to current channel)")
          .setRequired(false)
          .addChannelTypes(
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
            ChannelType.PublicThread,
            ChannelType.PrivateThread,
            ChannelType.AnnouncementThread,
          ),
      )
      .addStringOption((option) => option.setName("title").setDescription("Optional embed title").setRequired(false))
      .addStringOption((option) => option.setName("description").setDescription("Optional embed description").setRequired(false))
      .addStringOption((option) =>
        option
          .setName("button_label")
          .setDescription("Optional button label (max 80 characters)")
          .setRequired(false),
      )
      .addBooleanOption((option) =>
        option
          .setName("mention_everyone")
          .setDescription("Whether to ping @everyone above the panel")
          .setRequired(false),
      );
  },
};

const COURT_SUBCOMMAND_HANDLERS: Record<string, RuntimeCommandHandler> = {
  status: handleCourtStatus,
  health: handleCourtHealth,
  analytics: handleCourtAnalytics,
  dryrun: handleCourtDryRun,
  exportstate: handleCourtExportState,
  importstate: handleCourtImportState,
  mode: handleCourtMode,
  channel: handleCourtChannel,
  logchannel: handleCourtLogChannel,
  schedule: handleCourtSchedule,
  listcategories: handleCourtListCategories,
  addquestion: handleCourtAddQuestion,
  deletequestion: handleCourtDeleteQuestion,
  editquestion: handleCourtEditQuestion,
  resethistory: handleCourtResetHistory,
  post: handleCourtPost,
  custom: handleCourtCustom,
  close: handleCourtClose,
  listopen: handleCourtListOpen,
  extend: handleCourtExtend,
  reopen: handleCourtReopen,
  removeanswer: handleCourtRemoveAnswer,
};

const QUESTIONS_SUBCOMMAND_HANDLERS: Record<string, RuntimeCommandHandler> = {
  count: handleQuestionCount,
  unused: handleQuestionUnused,
  audit: handleQuestionAudit,
};

const INVICTUS_SUBCOMMAND_HANDLERS: Record<string, RuntimeCommandHandler> = {
  dmpanel: handleInvictusDmPanel,
  rolepanel: handleInvictusRolePanel,
  purge: handleInvictusPurge,
  purgeuser: handleInvictusPurgeUser,
  lock: handleInvictusLock,
  unlock: handleInvictusUnlock,
  slowmode: handleInvictusSlowMode,
  timeout: handleInvictusTimeout,
  untimeout: handleInvictusUntimeout,
  mutemany: handleInvictusMuteMany,
  unmutemany: handleInvictusUnmuteMany,
  muteall: handleInvictusMuteAll,
  unmuteall: handleInvictusUnmuteAll,
  rolepanelmulti: handleInvictusRolePanelMulti,
  say: async (interaction) => handleInvictusSay(interaction),
  resetroyaltimer: handleInvictusResetRoyalTimer,
  afk: handleInvictusAfk,
  afkstatus: handleInvictusAfkStatus,
  backfillstats: handleInvictusBackfillStats,
  backfillstatus: handleInvictusBackfillStatus,
  help: async (interaction) => handleInvictusHelp(interaction),
};

const INVICTUS_ADMIN_SUBCOMMANDS = new Set<string>([
  "dmpanel",
  "rolepanel",
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
  "rolepanelmulti",
  "say",
  "resetroyaltimer",
  "afkstatus",
  "backfillstats",
  "backfillstatus",
  "help",
]);

const FUN_SUBCOMMAND_HANDLERS: Record<string, RuntimeCommandHandler> = {
  verdict: handleFunVerdict,
  title: handleFunTitle,
  fate: handleFate,
  battle: handleFunBattle,
  stats: handleFunStats,
  leaderboard: handleFunLeaderboard,
};

const GREETINGS_SUBCOMMAND_HANDLERS: Record<string, RuntimeCommandHandler> = {
  rio: async (interaction) => {
    await interaction.reply({ content: `Hello <@${RIO_USER_ID}>. The court sends respect.` });
  },
  taylor: async (interaction) => {
    await interaction.reply({ content: `Hello <@${TAYLOR_USER_ID}>. The court sends respect.` });
  },
};

const COMMAND_DISPATCHERS: Record<string, { handlers: Record<string, RuntimeCommandHandler>; requiresAdmin?: Set<string> }> = {
  court: { handlers: COURT_SUBCOMMAND_HANDLERS },
  questions: { handlers: QUESTIONS_SUBCOMMAND_HANDLERS },
  invictus: { handlers: INVICTUS_SUBCOMMAND_HANDLERS, requiresAdmin: INVICTUS_ADMIN_SUBCOMMANDS },
  fun: { handlers: FUN_SUBCOMMAND_HANDLERS },
  greetings: { handlers: GREETINGS_SUBCOMMAND_HANDLERS },
};

export function buildCommandDefinitions(): SlashCommandBuilder[] {
  const court = new SlashCommandBuilder().setName("court").setDescription("Imperial Court controls");
  for (const name of COURT_COMMANDS) {
    court.addSubcommand((subcommand) => {
      subcommand.setName(name).setDescription(`Court ${name} command`);
      const configureCourtSubcommand = COURT_SUBCOMMAND_OPTION_BUILDERS[name];
      if (configureCourtSubcommand) {
        configureCourtSubcommand(subcommand);
      }

      return subcommand;
    });
  }

  const questions = new SlashCommandBuilder().setName("questions").setDescription("Question utilities");
  for (const name of QUESTIONS_COMMANDS) {
    questions.addSubcommand((subcommand) => {
      subcommand.setName(name).setDescription(`Question ${name} command`);
      if (name === "count") {
        subcommand.addStringOption((option) =>
          option
            .setName("category")
            .setDescription("Optional category")
            .setRequired(false)
            .addChoices(...CATEGORY_CHOICES),
        );
      }

      if (name === "unused") {
        subcommand.addStringOption((option) =>
          option
            .setName("category")
            .setDescription("Optional category to inspect")
            .setRequired(false)
            .addChoices(...CATEGORY_CHOICES),
        );
      }
      return subcommand;
    });
  }

  const invictus = new SlashCommandBuilder().setName("invictus").setDescription("Server admin and moderation tools");
  for (const name of INVICTUS_COMMANDS) {
    invictus.addSubcommand((subcommand) => {
      subcommand.setName(name).setDescription(`Invictus ${name} command`);
      INVICTUS_SUBCOMMAND_OPTION_BUILDERS[name]?.(subcommand);

      if (name === "rolepanel") {
        subcommand
          .addRoleOption((option) => option.setName("role").setDescription("Role to toggle when the button is clicked").setRequired(true))
          .addChannelOption((option) =>
            option
              .setName("channel")
              .setDescription("Target text channel (defaults to current channel)")
              .setRequired(false)
              .addChannelTypes(ChannelType.GuildText),
          )
          .addStringOption((option) => option.setName("title").setDescription("Optional embed title").setRequired(false))
          .addStringOption((option) => option.setName("description").setDescription("Optional embed description").setRequired(false))
          .addStringOption((option) =>
            option
              .setName("button_label")
              .setDescription("Optional button label (max 80 characters)")
              .setRequired(false),
          )
          .addBooleanOption((option) =>
            option
              .setName("mention_everyone")
              .setDescription("Whether to ping @everyone above the panel")
              .setRequired(false),
          );
      }

      if (name === "say") {
        subcommand
          .addChannelOption((option) =>
            option
              .setName("channel")
              .setDescription("Target channel")
              .setRequired(true)
              .addChannelTypes(ChannelType.GuildText),
          )
          .addBooleanOption((option) =>
            option
              .setName("mention_everyone")
              .setDescription("Whether to ping @everyone (default: false)")
              .setRequired(false),
          );
      }

      if (name === "rolepanelmulti") {
        subcommand
          .addRoleOption((option) => option.setName("role_1").setDescription("First role button").setRequired(true))
          .addRoleOption((option) => option.setName("role_2").setDescription("Second role button").setRequired(true))
          .addRoleOption((option) => option.setName("role_3").setDescription("Optional third role button").setRequired(false))
          .addRoleOption((option) => option.setName("role_4").setDescription("Optional fourth role button").setRequired(false))
          .addRoleOption((option) => option.setName("role_5").setDescription("Optional fifth role button").setRequired(false))
          .addChannelOption((option) =>
            option
              .setName("channel")
              .setDescription("Target text channel (defaults to current channel)")
              .setRequired(false)
              .addChannelTypes(ChannelType.GuildText),
          )
          .addStringOption((option) => option.setName("title").setDescription("Optional embed title").setRequired(false))
          .addStringOption((option) => option.setName("description").setDescription("Optional embed description").setRequired(false))
          .addBooleanOption((option) =>
            option
              .setName("mention_everyone")
              .setDescription("Whether to ping @everyone above the panel")
              .setRequired(false),
          );
      }

      if (name === "afk") {
        subcommand.addStringOption((option) =>
          option
            .setName("reason")
            .setDescription("Reason for being AFK. Leave empty to clear your AFK status")
            .setRequired(false),
        );
      }

      if (name === "purge") {
        subcommand.addIntegerOption((option) =>
          option
            .setName("amount")
            .setDescription("How many recent messages to delete (1-100)")
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(100),
        );
      }

      if (name === "purgeuser") {
        subcommand
          .addUserOption((option) => option.setName("member").setDescription("Member whose messages to remove").setRequired(true))
          .addIntegerOption((option) =>
            option
              .setName("amount")
              .setDescription("How many recent messages to scan (1-200)")
              .setRequired(false)
              .setMinValue(1)
              .setMaxValue(200),
          );
      }

      if (name === "lock" || name === "unlock") {
        subcommand.addStringOption((option) => option.setName("reason").setDescription("Optional reason").setRequired(false));
      }

      if (name === "slowmode") {
        subcommand.addIntegerOption((option) =>
          option
            .setName("seconds")
            .setDescription("Slowmode delay in seconds (0-21600)")
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(21600),
        );
      }

      if (name === "timeout") {
        subcommand
          .addUserOption((option) => option.setName("member").setDescription("Member to timeout").setRequired(true))
          .addIntegerOption((option) =>
            option
              .setName("minutes")
              .setDescription("Timeout duration in minutes (1-40320)")
              .setRequired(true)
              .setMinValue(1)
              .setMaxValue(40320),
          )
          .addStringOption((option) => option.setName("reason").setDescription("Optional reason").setRequired(false));
      }

      if (name === "untimeout") {
        subcommand
          .addUserOption((option) => option.setName("member").setDescription("Member to untimeout").setRequired(true))
          .addStringOption((option) => option.setName("reason").setDescription("Optional reason").setRequired(false));
      }

      if (name === "mutemany") {
        subcommand
          .addStringOption((option) =>
            option
              .setName("members")
              .setDescription("Mentions or user IDs separated by spaces")
              .setRequired(true),
          )
          .addIntegerOption((option) =>
            option
              .setName("minutes")
              .setDescription("Timeout duration in minutes (1-40320)")
              .setRequired(true)
              .setMinValue(1)
              .setMaxValue(40320),
          )
          .addBooleanOption((option) =>
            option
              .setName("dry_run")
              .setDescription("Preview impacts without applying timeouts")
              .setRequired(false),
          )
          .addStringOption((option) => option.setName("reason").setDescription("Optional reason").setRequired(false));
      }

      if (name === "unmutemany") {
        subcommand
          .addStringOption((option) =>
            option
              .setName("members")
              .setDescription("Mentions or user IDs separated by spaces")
              .setRequired(true),
          )
          .addBooleanOption((option) =>
            option
              .setName("dry_run")
              .setDescription("Preview impacts without removing timeouts")
              .setRequired(false),
          )
          .addStringOption((option) => option.setName("reason").setDescription("Optional reason").setRequired(false));
      }

      if (name === "muteall") {
        subcommand
          .addIntegerOption((option) =>
            option
              .setName("minutes")
              .setDescription("Timeout duration in minutes (1-40320)")
              .setRequired(true)
              .setMinValue(1)
              .setMaxValue(40320),
          )
          .addStringOption((option) => option.setName("confirm").setDescription("Type CONFIRM to run").setRequired(true))
          .addBooleanOption((option) =>
            option
              .setName("dry_run")
              .setDescription("Preview impacts without applying timeouts")
              .setRequired(false),
          )
          .addStringOption((option) => option.setName("reason").setDescription("Optional reason").setRequired(false));
      }

      if (name === "unmuteall") {
        subcommand
          .addStringOption((option) => option.setName("confirm").setDescription("Type CONFIRM to run").setRequired(true))
          .addBooleanOption((option) =>
            option
              .setName("dry_run")
              .setDescription("Preview impacts without removing timeouts")
              .setRequired(false),
          )
          .addStringOption((option) => option.setName("reason").setDescription("Optional reason").setRequired(false));
      }

      if (name === "backfillstats") {
        subcommand.addIntegerOption((option) =>
          option
            .setName("days")
            .setDescription("How many days to scan (0 scans all available history)")
            .setRequired(false)
            .setMinValue(0)
            .setMaxValue(3650),
        );
      }

      return subcommand;
    });
  }

  const fun = new SlashCommandBuilder().setName("fun").setDescription("Fun commands for everyone");
  for (const name of FUN_COMMANDS) {
    fun.addSubcommand((subcommand) => {
      subcommand.setName(name).setDescription(`Fun ${name} command`);
      if (name === "battle") {
        subcommand.addUserOption((option) => option.setName("opponent").setDescription("Who do you want to fight?").setRequired(true));
      }

      if (name === "stats") {
        subcommand.addUserOption((option) => option.setName("member").setDescription("Optional member to inspect").setRequired(false));
      }

      if (name === "leaderboard") {
        subcommand
          .addStringOption((option) =>
            option
              .setName("metric")
              .setDescription("Metric to rank")
              .setRequired(true)
              .addChoices(
                ...USER_FUN_METRIC_FIELDS.map(([metricName, label]) => ({ name: label, value: metricName })),
              ),
          )
          .addIntegerOption((option) =>
            option
              .setName("limit")
              .setDescription("How many entries to show (1-10)")
              .setRequired(false)
              .setMinValue(1)
              .setMaxValue(10),
          );
      }

      if (name === "fate") {
        subcommand.addIntegerOption((option) => option.setName("roll").setDescription("Optional roll between 1 and 100").setRequired(false));
      }
      return subcommand;
    });
  }

  const greetings = new SlashCommandBuilder().setName("greetings").setDescription("Friendly greeting commands");
  for (const name of GREETINGS_COMMANDS) {
    greetings.addSubcommand((subcommand) => subcommand.setName(name).setDescription(`Greeting ${name} command`));
  }

  return [court, questions, invictus, fun, greetings];
}

async function dispatchMappedCommand(
  command: string,
  subcommand: string,
  interaction: ChatInputCommandInteraction,
  runtime: BotRuntime,
): Promise<boolean> {
  const dispatchConfig = COMMAND_DISPATCHERS[command];
  if (!dispatchConfig) {
    return false;
  }

  const handler = dispatchConfig.handlers[subcommand];
  if (!handler) {
    return false;
  }

  if (dispatchConfig.requiresAdmin?.has(subcommand)) {
    const isAllowed = await requireAdmin(interaction);
    if (!isAllowed) {
      return true;
    }
  }

  await handler(interaction, runtime);
  return true;
}

export async function handleChatInputCommand(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  const command = interaction.commandName;
  const subcommand = interaction.options.getSubcommand();

  if (STAFF_REQUIRED_COMMANDS.has(command)) {
    const isAllowed = await requireStaff(interaction, runtime);
    if (!isAllowed) {
      return;
    }
  }

  const handled = await dispatchMappedCommand(command, subcommand, interaction, runtime);
  if (handled) {
    return;
  }

  await interaction.reply({
    content: NOT_MIGRATED_MESSAGE,
    ephemeral: command !== "fun" && command !== "greetings",
  });
}

export async function handleButtonInteraction(interaction: ButtonInteraction, runtime: BotRuntime): Promise<void> {
  const rolePanelSlot = extractRolePanelButtonSlot(interaction.customId);
  if (rolePanelSlot !== null) {
    await handleRolePanelButtonInteraction(interaction, rolePanelSlot);
    return;
  }

  if (interaction.customId === INVICTUS_DM_PANEL_BUTTON_ID) {
    await handleInvictusDmPanelButtonInteraction(interaction);
    return;
  }

  if (interaction.customId !== ANON_ANSWER_BUTTON_ID) {
    return;
  }

  if (!interaction.guild || !interaction.message) {
    await interaction.reply({ content: MSG_USE_IN_SERVER, ephemeral: true });
    return;
  }

  const postRecord = runtime.storage.getPostRecord(interaction.message.id);
  if (postRecord?.closed) {
    await interaction.reply({ content: MSG_INQUIRY_CLOSED, ephemeral: true });
    return;
  }

  await interaction.showModal(buildAnonymousAnswerModal(interaction.message.id));
}

export async function handleModalSubmitInteraction(
  interaction: ModalSubmitInteraction,
  runtime: BotRuntime,
): Promise<void> {
  const adminSayContext = extractAdminSayContextFromModal(interaction.customId);
  if (adminSayContext) {
    await handleAdminSayModalSubmit(interaction, runtime, adminSayContext.channelId, adminSayContext.mentionEveryone);
    return;
  }

  const invictusDmPanelTargetUserId = parseInvictusDmPanelModalTargetUserId(interaction.customId);
  if (invictusDmPanelTargetUserId) {
    await handleInvictusDmPanelModalSubmit(interaction, runtime, invictusDmPanelTargetUserId);
    return;
  }

  const questionMessageId = parseAnonymousAnswerMessageId(interaction.customId);
  if (!questionMessageId) {
    return;
  }

  if (!interaction.guild) {
    await interaction.reply({ content: MSG_USE_IN_SERVER, ephemeral: true });
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) {
    await interaction.reply({ content: MSG_VERIFY_ROLES, ephemeral: true });
    return;
  }

  const postRecord = runtime.storage.getPostRecord(questionMessageId);
  if (postRecord?.closed) {
    await interaction.reply({ content: MSG_INQUIRY_CLOSED, ephemeral: true });
    return;
  }

  const sourceMessage = await resolveCourtPostMessageForModal(interaction, postRecord, questionMessageId);
  if (!sourceMessage) {
    await interaction.reply({ content: "Could not find the original court post.", ephemeral: true });
    return;
  }

  const answerText = interaction.fields.getTextInputValue(ANON_MODAL_INPUT_ID).trim();
  if (!answerText) {
    await interaction.reply({ content: "Answer cannot be empty.", ephemeral: true });
    return;
  }

  const validationError = validateAnonymousAnswerSubmission(member, answerText, runtime);
  if (validationError) {
    await interaction.reply({ content: validationError, ephemeral: true });
    return;
  }

  if (runtime.storage.hasUserAnswered(questionMessageId, member.id)) {
    await interaction.reply({ content: "You already answered this court inquiry.", ephemeral: true });
    return;
  }

  const question = extractQuestionFromMessage(sourceMessage);
  const thread = await getOrCreateAnswerThread(sourceMessage, question, runtime);
  if (!thread) {
    await interaction.reply({
      content: "Could not create or find the reply thread. Check the bot's thread permissions.",
      ephemeral: true,
    });
    return;
  }

  if (thread.locked) {
    await interaction.reply({ content: MSG_INQUIRY_CLOSED, ephemeral: true });
    return;
  }

  const answerNumber = runtime.storage.nextAnswerNumber(questionMessageId);
  const embed = new EmbedBuilder()
    .setTitle(`Anonymous Answer #${answerNumber}`)
    .setDescription(answerText)
    .setColor(ROLE_COLOR)
    .setTimestamp(runtime.now().toJSDate())
    .setFooter({ text: "Submitted anonymously" });

  const sent = await thread.send({ embeds: [embed] }).catch(() => null);
  if (!sent) {
    await interaction.reply({ content: "Failed to post your anonymous answer.", ephemeral: true });
    return;
  }

  runtime.storage.markUserAnswered(questionMessageId, member.id, sent.id);
  runtime.storage.recordAnswerMetric();

  await interaction.reply({
    content: `Your anonymous answer has been posted in ${thread.toString()}.`,
    ephemeral: true,
  });
}

async function handleCourtStatus(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  const state = runtime.storage.getState();
  const openPosts = runtime.storage.listPostRecords(false).length;
  const channelMention = state.channel_id > 0 ? `<#${state.channel_id}>` : "Not set";
  const logChannelMention = state.log_channel_id > 0 ? `<#${state.log_channel_id}>` : "Disabled";

  const statusText = [
    `**Version:** \`${runtime.config.botVersion}\``,
    `**Mode:** \`${state.mode}\``,
    `**Channel:** ${channelMention}`,
    `**Log Channel:** ${logChannelMention}`,
    `**Auto Time:** \`${String(state.hour).padStart(2, "0")}:${String(state.minute).padStart(2, "0")}\` (${runtime.config.timezoneName})`,
    `**Last Posted:** \`${state.last_posted_date ?? "Never"}\``,
    `**Recent Memory Size:** \`${state.history.length}\``,
    `**Used Pool Size:** \`${state.used_questions.length}\``,
    `**Open Court Threads:** \`${openPosts}\``,
  ].join("\n");

  runtime.storage.recordCommandMetric("court.status");
  await interaction.reply({ content: statusText, ephemeral: true });
}

function getDbHealthSummary(dbFile: string): { status: "present" | "missing"; sizeKb: string } {
  const dbExists = existsSync(dbFile);
  const dbSizeBytes = dbExists ? statSync(dbFile).size : 0;
  return {
    status: dbExists ? "present" : "missing",
    sizeKb: (dbSizeBytes / 1024).toFixed(1),
  };
}

function getLogChannelHealthText(logChannelId: number, logChannel: Channel | null): string {
  if (logChannelId === 0) {
    return "Disabled";
  }
  if (logChannel) {
    return logChannel.toString();
  }
  return "Configured but not found";
}

async function handleCourtHealth(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: MSG_USE_IN_SERVER, ephemeral: true });
    return;
  }

  const state = runtime.storage.getState();
  const questions = runtime.storage.getQuestions();
  const metrics = runtime.storage.metricsSnapshot();
  const posts = runtime.storage.listPostRecords(true, POST_RECORD_LIMIT);
  const now = runtime.now();

  const [openPosts, overduePosts] = countOpenAndOverduePosts(posts, now);
  const targetChannel = await getTargetChannel(interaction, runtime);
  const logChannel = await getLogChannel(interaction, runtime);

  const me = interaction.guild.members.me ?? (await interaction.guild.members.fetchMe().catch(() => null));
  const missingPermissions = findMissingChannelPermissions(targetChannel, me);

  const nextRunText = buildNextRunText(state.mode, state.hour, state.minute, now);
  const totalQuestions = Object.values(questions).reduce((sum, values) => sum + values.length, 0);
  const dbSummary = getDbHealthSummary(runtime.config.dbFile);
  const channelText = targetChannel ? targetChannel.toString() : "Not found";
  const logChannelText = getLogChannelHealthText(state.log_channel_id, logChannel);

  const warnings: string[] = [];
  if (!targetChannel) {
    warnings.push("Court channel is not reachable");
  }
  if (state.log_channel_id && !logChannel) {
    warnings.push("Log channel is configured but not reachable");
  }
  if (missingPermissions.length > 0) {
    warnings.push("Bot is missing permissions in court channel");
  }
  if (overduePosts > 0) {
    warnings.push(`${overduePosts} open thread(s) appear overdue for auto-close`);
  }

  const overall = warnings.length === 0 ? "Healthy" : "Attention Needed";

  const embed = new EmbedBuilder()
    .setTitle("Court Health Check")
    .setDescription(`**Overall:** \`${overall}\`\n**Timezone:** \`${runtime.config.timezoneName}\`\n**Now:** \`${now.toFormat("yyyy-LL-dd HH:mm:ss")}\``)
    .setColor(ROLE_COLOR)
    .setTimestamp(now.toJSDate())
    .addFields(
      {
        name: "Scheduling",
        value:
          `**Mode:** \`${state.mode}\`\n`
          + `**Dry Run:** \`${state.dry_run_auto_post ? "enabled" : "disabled"}\`\n`
          + `**Auto Time:** \`${String(state.hour).padStart(2, "0")}:${String(state.minute).padStart(2, "0")}\`\n`
          + `**Next Auto-Post:** ${nextRunText}\n`
          + `**Last Posted Date:** \`${state.last_posted_date ?? "Never"}\`\n`
          + `**Last Successful Auto-Post:** \`${metrics.last_successful_auto_post ?? "Never"}\``,
        inline: false,
      },
      {
        name: "Channels",
        value:
          `**Court Channel:** ${channelText}\n`
          + `**Log Channel:** ${logChannelText}`,
        inline: false,
      },
      {
        name: "Tasks",
        value:
          "**Auto Poster Loop:** `running`\n"
          + "**Thread Closer Loop:** `running`\n"
          + "**Weekly Digest Loop:** `running`\n"
          + "**Retention Loop:** `running`",
        inline: true,
      },
      {
        name: "Data",
        value:
          `**Questions:** \`${totalQuestions}\`\n`
          + `**Used Pool:** \`${state.used_questions.length}\`\n`
          + `**Open Posts:** \`${openPosts}\`\n`
          + `**DB:** \`${dbSummary.status}\` (${dbSummary.sizeKb} KB)`,
        inline: true,
      },
      {
        name: "Warnings",
        value: warnings.length > 0 ? warnings.map((warning) => `- ${warning}`).join("\n") : "None.",
        inline: false,
      },
    );

  if (missingPermissions.length > 0) {
    embed.addFields({
      name: "Missing Permissions",
      value: missingPermissions.map((permission) => `- ${permission}`).join("\n"),
      inline: false,
    });
  }

  runtime.storage.recordCommandMetric("court.health");
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleCourtAnalytics(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  const metrics = runtime.storage.metricsSnapshot();
  const posts = runtime.storage.listPostRecords(true, 100);
  const today = runtime.now().toFormat("yyyy-LL-dd");

  const postsToday = posts.filter((post) => String(post.posted_at).startsWith(today)).length;
  const openPosts = posts.filter((post) => !post.closed).length;
  const totalAnswers = runtime.storage.countAllAnswerRecords();
  const postCount = Math.max(posts.length, 1);
  const averageAnswers = totalAnswers / postCount;

  const topCategories = Object.entries(metrics.posts_by_category)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5);
  const categoryLines = topCategories.map(([category, count]) => `- \`${category}\`: \`${count}\``).join("\n") || "No data yet.";

  const topCommands = Object.entries(metrics.command_usage)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8);
  const commandLines = topCommands.map(([commandName, count]) => `- \`${commandName}\`: \`${count}\``).join("\n") || "No command usage yet.";

  const embed = new EmbedBuilder()
    .setTitle("Court Analytics")
    .setDescription("Usage and engagement snapshot.")
    .setColor(ROLE_COLOR)
    .setTimestamp(runtime.now().toJSDate())
    .addFields(
      {
        name: "Posts",
        value:
          `**Lifetime Total:** \`${metrics.posts_total}\`\n`
          + `**Auto Posts:** \`${metrics.posts_auto}\`\n`
          + `**Manual Posts:** \`${metrics.posts_manual}\`\n`
          + `**Custom Posts:** \`${metrics.custom_posts}\`\n`
          + `**Posts Today (recent window):** \`${postsToday}\`\n`
          + `**Open Posts:** \`${openPosts}\``,
        inline: false,
      },
      {
        name: "Engagement",
        value:
          `**Tracked Answers:** \`${metrics.answers_total}\`\n`
          + `**Current Answer Records:** \`${totalAnswers}\`\n`
          + `**Avg Answers per Post (recent window):** \`${averageAnswers.toFixed(2)}\``,
        inline: false,
      },
      {
        name: "Top Categories",
        value: categoryLines,
        inline: true,
      },
      {
        name: "Top Commands",
        value: commandLines,
        inline: true,
      },
    );

  runtime.storage.recordCommandMetric("court.analytics");
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleCourtDryRun(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  const enabled = interaction.options.getBoolean("enabled", true);
  runtime.storage.updateStateAtomic((state) => {
    state.dry_run_auto_post = enabled;
    if (!enabled) {
      state.last_dry_run_date = null;
    }
  });

  runtime.storage.recordCommandMetric("court.dryrun");
  await interaction.reply({
    content: `Auto-post dry run is now \`${enabled ? "enabled" : "disabled"}\`.`,
    ephemeral: true,
  });
}

async function handleCourtExportState(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  const payload = JSON.stringify(runtime.storage.getState(), null, 2);
  const attachment = new AttachmentBuilder(Buffer.from(payload, "utf-8"), { name: "court_state_export.json" });

  runtime.storage.recordCommandMetric("court.exportstate");
  await interaction.reply({ content: "State export attached.", files: [attachment], ephemeral: true });
}

async function handleCourtImportState(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  const file = interaction.options.getAttachment("file", true);
  const confirm = interaction.options.getString("confirm", true);

  if (!isConfirmed(confirm)) {
    await interaction.reply({ content: MSG_CONFIRM_REQUIRED, ephemeral: true });
    return;
  }

  let imported: unknown;
  try {
    const response = await fetch(file.url);
    if (!response.ok) {
      throw new Error("Failed to download import file");
    }
    const raw = await response.text();
    imported = JSON.parse(raw);
  } catch {
    await interaction.reply({ content: "Failed to parse state JSON file.", ephemeral: true });
    return;
  }

  if (typeof imported !== "object" || imported === null) {
    await interaction.reply({ content: "Imported state must be a JSON object.", ephemeral: true });
    return;
  }

  const merged = mergeImportedState(imported, runtime.storage.getState(), runtime.config.courtChannelId);
  runtime.storage.saveState(merged);

  runtime.storage.recordCommandMetric("court.importstate");
  await interaction.reply({ content: "State imported successfully.", ephemeral: true });
}

async function handleCourtChannel(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  const channel = interaction.options.getChannel("channel", true);
  if (!(channel instanceof TextChannel)) {
    await interaction.reply({ content: "Channel must be a text channel.", ephemeral: true });
    return;
  }

  runtime.storage.updateStateAtomic((state) => {
    state.channel_id = Number.parseInt(channel.id, 10);
  });

  runtime.storage.recordCommandMetric("court.channel");
  await interaction.reply({ content: `Court channel set to ${channel.toString()}.`, ephemeral: true });

  await sendLog(
    interaction,
    runtime,
    "Court Channel Updated",
    `**By:** ${interaction.user.toString()}\n**Channel:** ${channel.toString()}`,
  );
}

async function handleCourtLogChannel(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  const channel = interaction.options.getChannel("channel");
  if (channel && !(channel instanceof TextChannel)) {
    await interaction.reply({ content: "Log channel must be a text channel.", ephemeral: true });
    return;
  }

  runtime.storage.updateStateAtomic((state) => {
    state.log_channel_id = channel ? Number.parseInt(channel.id, 10) : 0;
  });

  runtime.storage.recordCommandMetric("court.logchannel");
  if (!channel) {
    await interaction.reply({ content: "Log channel disabled.", ephemeral: true });
    return;
  }

  await interaction.reply({ content: `Log channel set to ${channel.toString()}.`, ephemeral: true });
  await sendLog(
    interaction,
    runtime,
    "Log Channel Updated",
    `**By:** ${interaction.user.toString()}\n**Log Channel:** ${channel.toString()}`,
  );
}

async function handleCourtListCategories(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  const questions = runtime.storage.getQuestions();
  let total = 0;

  const lines = Object.entries(CATEGORY_DESCRIPTIONS).map(([category, description]) => {
    const count = questions[category]?.length ?? 0;
    total += count;
    return `- \`${category}\`: \`${count}\` question(s) - ${description}`;
  });

  runtime.storage.recordCommandMetric("court.listcategories");
  await interaction.reply({
    content: `**Question Categories**\n${lines.join("\n")}\n\n**Total Questions:** \`${total}\``,
    ephemeral: true,
  });
}

async function handleCourtAddQuestion(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  const category = interaction.options.getString("category", true);
  const cleanQuestion = normalizeQuestionText(interaction.options.getString("question", true));

  if (!cleanQuestion) {
    await interaction.reply({ content: MSG_QUESTION_EMPTY, ephemeral: true });
    return;
  }
  if (!(category in CATEGORY_DESCRIPTIONS)) {
    await interaction.reply({ content: "Unknown category.", ephemeral: true });
    return;
  }

  const questions = runtime.storage.getQuestions();
  const categoryItems = questions[category] ?? [];
  const alreadyExists = categoryItems.some((existing) => existing.trim().toLowerCase() === cleanQuestion.toLowerCase());
  if (alreadyExists) {
    await interaction.reply({ content: `That question already exists in \`${category}\`.`, ephemeral: true });
    return;
  }

  questions[category] = [...categoryItems, cleanQuestion];
  runtime.storage.setQuestions(questions);
  runtime.storage.recordCommandMetric("court.addquestion");

  await interaction.reply({ content: `Added question to \`${category}\`.`, ephemeral: true });
  await sendLog(
    interaction,
    runtime,
    "Question Added",
    `**By:** ${interaction.user.toString()}\n**Category:** \`${category}\`\n**Question:** ${cleanQuestion}`,
  );
}

async function handleCourtDeleteQuestion(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  const category = interaction.options.getString("category", true);
  const cleanQuestion = normalizeQuestionText(interaction.options.getString("question", true));

  if (!cleanQuestion) {
    await interaction.reply({ content: MSG_QUESTION_EMPTY, ephemeral: true });
    return;
  }
  if (!(category in CATEGORY_DESCRIPTIONS)) {
    await interaction.reply({ content: "Unknown category.", ephemeral: true });
    return;
  }

  const questions = runtime.storage.getQuestions();
  const items = questions[category] ?? [];
  const target = cleanQuestion.toLowerCase();
  const kept = items.filter((question) => question.trim().toLowerCase() !== target);
  if (kept.length === items.length) {
    await interaction.reply({ content: "Question not found in that category.", ephemeral: true });
    return;
  }

  questions[category] = kept;
  runtime.storage.setQuestions(questions);
  removeQuestionFromState(runtime, cleanQuestion);
  runtime.storage.recordCommandMetric("court.deletequestion");

  await interaction.reply({ content: `Removed \`${items.length - kept.length}\` matching question(s) from \`${category}\`.`, ephemeral: true });
  await sendLog(
    interaction,
    runtime,
    "Question Deleted",
    `**By:** ${interaction.user.toString()}\n**Category:** \`${category}\`\n**Question:** ${cleanQuestion}`,
  );
}

async function handleCourtEditQuestion(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  const category = interaction.options.getString("category", true);
  const oldQuestion = normalizeQuestionText(interaction.options.getString("old_question", true));
  const newQuestion = normalizeQuestionText(interaction.options.getString("new_question", true));

  if (!oldQuestion || !newQuestion) {
    await interaction.reply({ content: "Old and new question text must be non-empty.", ephemeral: true });
    return;
  }
  if (!(category in CATEGORY_DESCRIPTIONS)) {
    await interaction.reply({ content: "Unknown category.", ephemeral: true });
    return;
  }

  const questions = runtime.storage.getQuestions();
  const items = [...(questions[category] ?? [])];

  if (
    oldQuestion.toLowerCase() !== newQuestion.toLowerCase()
    && items.some((question) => question.trim().toLowerCase() === newQuestion.toLowerCase())
  ) {
    await interaction.reply({ content: "That replacement question already exists in this category.", ephemeral: true });
    return;
  }

  let replaced = false;
  for (let index = 0; index < items.length; index += 1) {
    if (items[index]?.trim().toLowerCase() === oldQuestion.toLowerCase()) {
      items[index] = newQuestion;
      replaced = true;
      break;
    }
  }

  if (!replaced) {
    await interaction.reply({ content: "Question not found in that category.", ephemeral: true });
    return;
  }

  questions[category] = items;
  runtime.storage.setQuestions(questions);
  replaceQuestionInState(runtime, oldQuestion, newQuestion);
  runtime.storage.recordCommandMetric("court.editquestion");

  await interaction.reply({ content: `Updated question in \`${category}\`.`, ephemeral: true });
  await sendLog(
    interaction,
    runtime,
    "Question Edited",
    `**By:** ${interaction.user.toString()}\n**Category:** \`${category}\`\n**Old:** ${oldQuestion}\n**New:** ${newQuestion}`,
  );
}

async function handleCourtResetHistory(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  runtime.storage.updateStateAtomic((state) => {
    state.history = [];
    state.used_questions = [];
  });

  runtime.storage.recordCommandMetric("court.resethistory");
  await interaction.reply({ content: "Question history and used pool have been reset.", ephemeral: true });
  await sendLog(
    interaction,
    runtime,
    "Question History Reset",
    `**By:** ${interaction.user.toString()}`,
  );
}

function removeQuestionFromState(runtime: BotRuntime, question: string): void {
  runtime.storage.updateStateAtomic((state) => {
    state.history = state.history.filter((item) => item !== question);
    state.used_questions = state.used_questions.filter((item) => item !== question);
  });
}

function replaceQuestionInState(runtime: BotRuntime, oldQuestion: string, newQuestion: string): void {
  runtime.storage.updateStateAtomic((state) => {
    state.history = state.history.map((item) => (item === oldQuestion ? newQuestion : item));
    state.used_questions = state.used_questions.map((item) => (item === oldQuestion ? newQuestion : item));
  });
}

function buildNextRunText(mode: BotMode, hour: number, minute: number, now: DateTime): string {
  if (mode !== "auto") {
    return `Not scheduled while mode is \`${mode}\``;
  }

  const nextRun = now.set({ hour, minute, second: 0, millisecond: 0 });
  const effectiveNextRun = nextRun <= now ? nextRun.plus({ days: 1 }) : nextRun;
  return `${effectiveNextRun.toFormat("yyyy-LL-dd HH:mm")} (in ${formatDuration(effectiveNextRun.diff(now))})`;
}

function findMissingChannelPermissions(channel: TextChannel | null, me: GuildMember | null): string[] {
  if (!channel || !me) {
    return [];
  }

  const permissions = channel.permissionsFor(me);
  const missing: string[] = [];
  if (!permissions.has(PermissionFlagsBits.ViewChannel)) {
    missing.push("View Channel");
  }
  if (!permissions.has(PermissionFlagsBits.SendMessages)) {
    missing.push("Send Messages");
  }
  if (!permissions.has(PermissionFlagsBits.EmbedLinks)) {
    missing.push("Embed Links");
  }
  if (!permissions.has(PermissionFlagsBits.CreatePublicThreads)) {
    missing.push("Create Public Threads");
  }
  if (!permissions.has(PermissionFlagsBits.SendMessagesInThreads)) {
    missing.push("Send Messages In Threads");
  }
  return missing;
}

async function handleCourtMode(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  const requestedMode = interaction.options.getString("mode");

  if (!requestedMode) {
    const state = runtime.storage.getState();
    await interaction.reply({ content: `Current mode is ${state.mode}.`, ephemeral: true });
    return;
  }

  if (!["off", "manual", "auto"].includes(requestedMode)) {
    await interaction.reply({ content: "Invalid mode. Use off, manual, or auto.", ephemeral: true });
    return;
  }

  runtime.storage.updateStateAtomic((state) => {
    state.mode = requestedMode as BotMode;
  });

  await interaction.reply({ content: `Mode updated to ${requestedMode}.`, ephemeral: true });
}

async function handleCourtSchedule(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  const hour = interaction.options.getInteger("hour");
  const minute = interaction.options.getInteger("minute");

  if (hour === null && minute === null) {
    const state = runtime.storage.getState();
    await interaction.reply({
      content: `Current schedule is ${String(state.hour).padStart(2, "0")}:${String(state.minute).padStart(2, "0")}.`,
      ephemeral: true,
    });
    return;
  }

  if (hour !== null && (hour < 0 || hour > 23)) {
    await interaction.reply({ content: "hour must be between 0 and 23", ephemeral: true });
    return;
  }

  if (minute !== null && (minute < 0 || minute > 59)) {
    await interaction.reply({ content: "minute must be between 0 and 59", ephemeral: true });
    return;
  }

  runtime.storage.updateStateAtomic((state) => {
    if (hour !== null) {
      state.hour = hour;
    }
    if (minute !== null) {
      state.minute = minute;
    }
  });

  const state = runtime.storage.getState();
  await interaction.reply({
    content: `Schedule updated to ${String(state.hour).padStart(2, "0")}:${String(state.minute).padStart(2, "0")}.`,
    ephemeral: true,
  });
}

async function handleQuestionCount(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  const category = interaction.options.getString("category");
  const questions = runtime.storage.getQuestions();

  if (category) {
    const selected = questions[category] ?? [];
    runtime.storage.recordCommandMetric("court.questions.count");
    await interaction.reply({ content: `${category}: ${selected.length} question(s).`, ephemeral: true });
    return;
  }

  const lines = Object.entries(questions)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, items]) => `${name}: ${items.length}`);

  runtime.storage.recordCommandMetric("court.questions.count");
  await interaction.reply({ content: lines.join("\n") || "No questions found.", ephemeral: true });
}

async function handleQuestionUnused(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  const category = interaction.options.getString("category");
  const questions = runtime.storage.getQuestions();
  const used = new Set(runtime.storage.getState().used_questions);

  if (category) {
    const items = questions[category] ?? [];
    const unused = items.filter((question) => !used.has(question));
    const preview = unused.slice(0, 10).map((question) => `- ${question}`).join("\n") || "None.";

    runtime.storage.recordCommandMetric("court.questions.unused");
    await interaction.reply({
      content: `**Unused in \`${category}\`:** \`${unused.length}\`\n${preview}`,
      ephemeral: true,
    });
    return;
  }

  let totalUnused = 0;
  const lines = Object.entries(questions).map(([categoryName, items]) => {
    const unusedCount = items.filter((question) => !used.has(question)).length;
    totalUnused += unusedCount;
    return `- \`${categoryName}\`: \`${unusedCount}\` unused`;
  });

  runtime.storage.recordCommandMetric("court.questions.unused");
  await interaction.reply({
    content: `**Unused Questions**\n${lines.join("\n")}\n\n**Total Unused:** \`${totalUnused}\``,
    ephemeral: true,
  });
}

async function handleQuestionAudit(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  const report = buildQuestionAuditReport(runtime.storage.getQuestions());
  runtime.storage.recordCommandMetric("court.questions.audit");
  await interaction.reply({ content: report.slice(0, 1900), ephemeral: true });
}

function buildQuestionAuditReport(questions: Record<string, string[]>): string {
  const allItems: Array<[string, string]> = [];
  const duplicates: string[] = [];
  const seen = new Map<string, [string, string]>();

  for (const [category, items] of Object.entries(questions)) {
    for (const question of items) {
      const fingerprint = questionFingerprint(question);
      allItems.push([category, question]);

      const previous = seen.get(fingerprint);
      if (!previous) {
        seen.set(fingerprint, [category, question]);
        continue;
      }

      const [previousCategory, previousQuestion] = previous;
      duplicates.push(
        question === previousQuestion
          ? `- \`${category}\` duplicate: ${question}`
          : `- \`${category}\` duplicates \`${previousCategory}\`: ${question}`,
      );
    }
  }

  const shortQuestions = allItems.filter(([, question]) => question.length < 20).slice(0, 10).map(([category, question]) => `- \`${category}\`: ${question}`);
  const longQuestions = allItems.filter(([, question]) => question.length > 160).slice(0, 10).map(([category, question]) => `- \`${category}\`: ${question}`);

  const lines = [
    "**Question Audit Report**",
    `**Total Questions:** \`${allItems.length}\``,
    `**Exact Duplicates:** \`${duplicates.length}\``,
  ];

  if (duplicates.length > 0) {
    lines.push(...duplicates.slice(0, 10));
  }

  lines.push(`**Very Short (<20 chars):** \`${shortQuestions.length}\``);
  if (shortQuestions.length > 0) {
    lines.push(...shortQuestions);
  }

  lines.push(`**Very Long (>160 chars):** \`${longQuestions.length}\``);
  if (longQuestions.length > 0) {
    lines.push(...longQuestions);
  }

  return lines.join("\n");
}

function questionFingerprint(question: string): string {
  return question
    .toLowerCase()
    .replaceAll(/[^a-z0-9'\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

async function handleFunVerdict(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  const verdict = randomImperialVerdict(runtime.randomInt);
  await interaction.reply({ content: verdict });
}

async function handleFunTitle(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  const title = randomImperialTitle(runtime.randomInt);
  await interaction.reply({ content: `Imperial title granted: ${title}` });
}

async function handleFate(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  const requestedRoll = interaction.options.getInteger("roll");
  const roll = requestedRoll ?? runtime.randomInt(100) + 1;
  const [tier, reading] = getFateReading(roll);
  const omen = IMPERIAL_OMENS[runtime.randomInt(IMPERIAL_OMENS.length)] ?? IMPERIAL_OMENS[0];

  const embed = new EmbedBuilder()
    .setTitle("Imperial Fate")
    .setColor(ROLE_COLOR)
    .setDescription(`Roll: ${roll}\nTier: ${tier}\n${reading}`)
    .addFields({ name: "Omen", value: omen })
    .setFooter({ text: `Generated in ${formatDuration(runtime.now().diff(runtime.now().minus({ seconds: 0 })))}.` });

  await interaction.reply({ embeds: [embed] });
}

async function handleInvictusSay(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: MSG_USE_IN_SERVER, ephemeral: true });
    return;
  }

  const targetChannelOption = interaction.options.getChannel("channel", true);
  if (!(targetChannelOption instanceof TextChannel)) {
    await interaction.reply({ content: "Target channel must be a text channel.", ephemeral: true });
    return;
  }

  const mentionEveryone = interaction.options.getBoolean("mention_everyone") ?? false;
  await interaction.showModal(buildAdminSayModal(targetChannelOption.id, mentionEveryone));
}

async function handleInvictusDmPanel(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: MSG_USE_IN_SERVER, ephemeral: true });
    return;
  }

  const requestedChannel = interaction.options.getChannel("channel");
  const targetChannel = (isDmPanelTargetChannel(requestedChannel) ? requestedChannel : null) ?? getDmPanelTargetChannel(interaction);
  if (!targetChannel) {
    await interaction.reply({
      content: "Provide a text-based channel, or run this command from a text-based channel.",
      ephemeral: true,
    });
    return;
  }

  const buttonLabel = (interaction.options.getString("button_label") ?? "").trim() || INVICTUS_DM_PANEL_DEFAULT_BUTTON_LABEL;
  if (buttonLabel.length > ROLE_PANEL_BUTTON_LABEL_MAX_LENGTH) {
    await interaction.reply({
      content: `Button label must be ${ROLE_PANEL_BUTTON_LABEL_MAX_LENGTH} characters or fewer.`,
      ephemeral: true,
    });
    return;
  }

  const me = interaction.guild.members.me ?? (await interaction.guild.members.fetchMe().catch(() => null));
  if (!me) {
    await interaction.reply({ content: MSG_BOT_CONTEXT_ERROR, ephemeral: true });
    return;
  }

  const channelError = getRolePanelChannelPermissionError(targetChannel, me);
  if (channelError) {
    await interaction.reply({ content: channelError, ephemeral: true });
    return;
  }

  const panelEmbed = buildInvictusDmPanelEmbed(
    interaction.user.id,
    interaction.options.getString("title"),
    interaction.options.getString("description"),
    runtime,
  );
  const panelComponents = buildInvictusDmPanelComponents(buttonLabel);
  const mentionEveryone = interaction.options.getBoolean("mention_everyone") ?? false;
  const mentionPayload = buildAnnouncementMentions(mentionEveryone);

  const sent = await targetChannel
    .send({
      ...(mentionPayload.content === null ? {} : { content: mentionPayload.content }),
      embeds: [panelEmbed],
      components: panelComponents,
      allowedMentions: mentionPayload.allowedMentions,
    })
    .catch(() => null);
  if (!sent) {
    await interaction.reply({ content: "Failed to create the DM panel.", ephemeral: true });
    return;
  }

  runtime.storage.recordCommandMetric("invictus.dmpanel");
  await interaction.reply({
    content: `DM panel posted in ${targetChannel.toString()}. Messages will be forwarded to you by DM.`,
    ephemeral: true,
  });

  await sendLog(
    interaction,
    runtime,
    "Invictus DM Panel Created",
    `**By:** ${interaction.user.toString()}\n**Channel:** ${targetChannel.toString()}\n**Recipient:** ${interaction.user.toString()} (\`${interaction.user.id}\`)\n**Button:** ${buttonLabel}\n**Mention Everyone:** \`${mentionEveryone ? "Yes" : "No"}\``,
  );
}

async function handleAdminSayModalSubmit(
  interaction: ModalSubmitInteraction,
  runtime: BotRuntime,
  channelId: string,
  mentionEveryone: boolean,
): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: MSG_USE_IN_SERVER, ephemeral: true });
    return;
  }

  const actor = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!actor) {
    await interaction.reply({ content: MSG_VERIFY_ROLES, ephemeral: true });
    return;
  }

  const channel = interaction.guild.channels.cache.get(channelId) ?? (await interaction.guild.channels.fetch(channelId).catch(() => null));
  if (!(channel instanceof TextChannel)) {
    await interaction.reply({ content: "Target channel no longer exists or is not a text channel.", ephemeral: true });
    return;
  }

  const me = interaction.guild.members.me ?? (await interaction.guild.members.fetchMe().catch(() => null));
  if (!me) {
    await interaction.reply({ content: MSG_BOT_CONTEXT_ERROR, ephemeral: true });
    return;
  }

  const permissionError = getRolePanelChannelPermissionError(channel, me);
  if (permissionError) {
    await interaction.reply({ content: "I do not have permission to send messages there.", ephemeral: true });
    return;
  }

  const messageContent = interaction.fields.getTextInputValue(ADMIN_SAY_MODAL_INPUT_ID).trim();
  if (!messageContent) {
    await interaction.reply({ content: "Message cannot be empty.", ephemeral: true });
    return;
  }

  const mentionPayload = buildAnnouncementMentions(mentionEveryone);
  const embed = new EmbedBuilder()
    .setDescription(messageContent)
    .setColor(ROLE_COLOR)
    .setTimestamp(runtime.now().toJSDate());

  const sent = await channel
    .send({
      ...(mentionPayload.content === null ? {} : { content: mentionPayload.content }),
      embeds: [embed],
      allowedMentions: mentionPayload.allowedMentions,
    })
    .catch(() => null);
  if (!sent) {
    await interaction.reply({ content: "Failed to send the message.", ephemeral: true });
    return;
  }

  runtime.storage.recordCommandMetric("invictus.say");
  await interaction.reply({ content: `Announcement sent to ${channel.toString()}.`, ephemeral: true });

  await sendLog(
    interaction,
    runtime,
    "Admin Announcement Sent",
    `**By:** ${interaction.user.toString()}\n**Channel:** ${channel.toString()}\n**Message:** ${messageContent}`,
  );
}

async function handleInvictusDmPanelModalSubmit(
  interaction: ModalSubmitInteraction,
  runtime: BotRuntime,
  targetUserId: string,
): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: MSG_USE_IN_SERVER, ephemeral: true });
    return;
  }

  const messageContent = interaction.fields.getTextInputValue(INVICTUS_DM_PANEL_MODAL_INPUT_ID).trim();
  if (!messageContent) {
    await interaction.reply({ content: "Message cannot be empty.", ephemeral: true });
    return;
  }

  const recipient = await interaction.client.users.fetch(targetUserId).catch(() => null);
  if (!recipient) {
    await interaction.reply({ content: "Could not find the configured DM recipient.", ephemeral: true });
    return;
  }

  const sourceChannel = interaction.channel?.isTextBased() ? interaction.channel.toString() : "Unknown";
  const dmEmbed = new EmbedBuilder()
    .setTitle("Invictus Panel Message")
    .setDescription(messageContent)
    .setColor(ROLE_COLOR)
    .setTimestamp(runtime.now().toJSDate())
    .addFields(
      { name: "From", value: `${interaction.user.toString()} (\`${interaction.user.id}\`)`, inline: false },
      { name: "Server", value: `${interaction.guild.name} (\`${interaction.guild.id}\`)`, inline: false },
      { name: "Channel", value: sourceChannel, inline: false },
    );

  const delivered = await recipient.send({ embeds: [dmEmbed] }).then(() => true).catch(() => false);
  if (!delivered) {
    await interaction.reply({
      content: "Failed to deliver your message. The recipient may have DMs disabled.",
      ephemeral: true,
    });
    return;
  }

  runtime.storage.recordCommandMetric("invictus.dmpanel.forward");
  await interaction.reply({ content: "Your message has been sent privately.", ephemeral: true });

  await sendLog(
    interaction,
    runtime,
    "Invictus DM Panel Message Forwarded",
    `**From:** ${interaction.user.toString()} (\`${interaction.user.id}\`)\n**To:** ${recipient.toString()} (\`${recipient.id}\`)\n**Channel:** ${sourceChannel}\n**Message:** ${messageContent}`,
  );
}

async function handleInvictusResetRoyalTimer(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  runtime.storage.updateStateAtomic((state) => {
    state.royal_presence.last_message_at_by_title.Emperor = null;
    state.royal_presence.last_message_at_by_title.Empress = null;
    state.royal_presence.last_message_at = null;
    state.royal_presence.last_speaker = null;
  });

  runtime.storage.recordCommandMetric("invictus.resetroyaltimer");
  await interaction.reply({
    content: "Royal timer reset. The next message from the Emperor or the Empress can trigger the H1 announcement immediately.",
    ephemeral: true,
  });

  await sendLog(
    interaction,
    runtime,
    "Royal Timer Reset",
    `**By:** ${interaction.user.toString()}`,
  );
}

async function handleInvictusAfk(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  const royalContext = await requireRoyal(interaction, runtime);
  if (!royalContext) {
    return;
  }

  const { actor, titles } = royalContext;
  const cleanReason = normalizeQuestionText(interaction.options.getString("reason") ?? "");

  if (cleanReason) {
    const nowIso = isoNow(runtime.config.timezoneName);
    runtime.storage.updateStateAtomic((state) => {
      for (const title of titles) {
        state.royal_afk.by_title[title] = {
          active: true,
          reason: cleanReason,
          set_at: nowIso,
          set_by_user_id: String(actor.id),
        };
      }
    });

    runtime.storage.recordCommandMetric("invictus.afk");
    const joinedTitles = titles.join(", ");
    await interaction.reply({ content: `AFK enabled for ${joinedTitles}.`, ephemeral: true });

    await sendLog(
      interaction,
      runtime,
      "Royal AFK Enabled",
      `**By:** ${actor.toString()}\n**Titles:** \`${joinedTitles}\`\n**Reason:** ${cleanReason}`,
    );
    return;
  }

  const cleared: RoyalTitle[] = [];
  runtime.storage.updateStateAtomic((state) => {
    for (const title of titles) {
      const entry = state.royal_afk.by_title[title];
      if (entry.active) {
        cleared.push(title);
      }

      state.royal_afk.by_title[title] = {
        active: false,
        reason: "",
        set_at: null,
        set_by_user_id: null,
      };
    }
  });

  runtime.storage.recordCommandMetric("invictus.afk");
  if (cleared.length > 0) {
    const joinedTitles = cleared.join(", ");
    await interaction.reply({ content: `AFK cleared for ${joinedTitles}.`, ephemeral: true });

    await sendLog(
      interaction,
      runtime,
      "Royal AFK Cleared",
      `**By:** ${actor.toString()}\n**Titles:** \`${joinedTitles}\``,
    );
    return;
  }

  await interaction.reply({ content: "No AFK status was active. Provide a reason to set AFK.", ephemeral: true });
}

async function handleInvictusAfkStatus(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  const report = buildRoyalAfkStatusReport(runtime.storage.getState().royal_afk, runtime.now());
  runtime.storage.recordCommandMetric("invictus.afkstatus");
  await interaction.reply({ content: `**Royal AFK Status**\n${report}`, ephemeral: true });
}

async function handleInvictusBackfillStats(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: MSG_USE_IN_SERVER, ephemeral: true });
    return;
  }

  if (runtime.backfillStatus.running) {
    await interaction.reply({
      content: "A user stats backfill is already running. Wait for it to finish before starting another.",
      ephemeral: true,
    });
    return;
  }

  const lookbackDays = interaction.options.getInteger("days") ?? 0;
  const lookbackText = backfillLookbackText(lookbackDays);

  markBackfillStarted(runtime.backfillStatus, interaction.user.id, lookbackDays, isoNow(runtime.config.timezoneName));
  runtime.storage.recordCommandMetric("invictus.backfillstats");

  await interaction.reply({
    content:
      `Starting user stats backfill for ${lookbackText}. This can take a while and may hit API rate limits on large servers. `
      + "A completion summary will be sent to the configured log channel.",
    ephemeral: true,
  });

  void runUserActivityBackfill(interaction, runtime, interaction.guild, lookbackDays);
}

async function runUserActivityBackfill(
  interaction: ChatInputCommandInteraction,
  runtime: BotRuntime,
  guild: NonNullable<ChatInputCommandInteraction["guild"]>,
  lookbackDays: number,
): Promise<void> {
  const startedAt = runtime.now();
  const lookbackText = backfillLookbackText(lookbackDays);

  await sendLog(
    interaction,
    runtime,
    "User Stats Backfill Started",
    `**By:** ${interaction.user.toString()}\n**Lookback:** ${lookbackText}\n**Status:** \`running\``,
  );

  try {
    const result = await backfillUserActivityMetrics(guild, runtime, lookbackDays);
    const elapsed = formatDuration(runtime.now().diff(startedAt));

    const summary =
      `channels=${result.scanned_channels}, messages=${result.scanned_messages}, reactions=${result.scanned_reactions}, `
      + `updates=${result.message_updates + result.reaction_sent_updates + result.reaction_received_updates}`;

    markBackfillFinished(runtime.backfillStatus, "completed", isoNow(runtime.config.timezoneName), summary, null);

    await sendLog(
      interaction,
      runtime,
      "User Stats Backfill Complete",
      `**By:** ${interaction.user.toString()}\n`
        + `**Lookback:** ${lookbackText}\n`
        + `**Elapsed:** \`${elapsed}\`\n`
        + `**Scanned Channels:** \`${result.scanned_channels}\`\n`
        + `**Skipped Channels:** \`${result.skipped_channels}\`\n`
        + `**Scanned Messages:** \`${result.scanned_messages}\`\n`
        + `**Scanned Reactions:** \`${result.scanned_reactions}\`\n`
        + `**Messages Users Seen:** \`${result.message_users_seen}\` (updated \`${result.message_updates}\`)\n`
        + `**Reactions Sent Users Seen:** \`${result.reaction_sent_users_seen}\` (updated \`${result.reaction_sent_updates}\`)\n`
        + `**Reactions Received Users Seen:** \`${result.reaction_received_users_seen}\` (updated \`${result.reaction_received_updates}\`)`,
    );
  } catch (error) {
    const errorText = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    markBackfillFinished(runtime.backfillStatus, "failed", isoNow(runtime.config.timezoneName), null, errorText.slice(0, 400));

    await sendLog(
      interaction,
      runtime,
      "User Stats Backfill Failed",
      `**By:** ${interaction.user.toString()}\n**Lookback:** ${lookbackText}\n**Status:** \`failed\`\n**Error:** \`${errorText.slice(0, 400)}\``,
    );
  }
}

async function backfillUserActivityMetrics(
  guild: NonNullable<ChatInputCommandInteraction["guild"]>,
  runtime: BotRuntime,
  lookbackDays: number,
): Promise<{
  scanned_channels: number;
  skipped_channels: number;
  scanned_messages: number;
  scanned_reactions: number;
  message_users_seen: number;
  reaction_sent_users_seen: number;
  reaction_received_users_seen: number;
  message_updates: number;
  reaction_sent_updates: number;
  reaction_received_updates: number;
}> {
  const afterTimestamp = lookbackDays > 0 ? runtime.now().minus({ days: lookbackDays }).toMillis() : null;

  const messageCounts: Record<number, number> = {};
  const reactionsSentCounts: Record<number, number> = {};
  const reactionsReceivedCounts: Record<number, number> = {};

  let scannedChannels = 0;
  let skippedChannels = 0;
  let scannedMessages = 0;
  let scannedReactions = 0;

  const targets = await getBackfillHistoryTargets(guild);
  for (const target of targets) {
    scannedChannels += 1;
    try {
      const [channelMessages, channelReactions] = await scanBackfillHistoryTarget(
        target,
        afterTimestamp,
        messageCounts,
        reactionsSentCounts,
        reactionsReceivedCounts,
      );
      scannedMessages += channelMessages;
      scannedReactions += channelReactions;
    } catch {
      skippedChannels += 1;
    }
  }

  const [messageUsersSeen, messageUpdates] = runtime.storage.mergeUserMetricBackfill(messageCounts, "messages_sent");
  const [reactionSentUsersSeen, reactionSentUpdates] = runtime.storage.mergeUserMetricBackfill(reactionsSentCounts, "reactions_sent");
  const [reactionReceivedUsersSeen, reactionReceivedUpdates] = runtime.storage.mergeUserMetricBackfill(
    reactionsReceivedCounts,
    "reactions_received",
  );

  return {
    scanned_channels: scannedChannels,
    skipped_channels: skippedChannels,
    scanned_messages: scannedMessages,
    scanned_reactions: scannedReactions,
    message_users_seen: messageUsersSeen,
    reaction_sent_users_seen: reactionSentUsersSeen,
    reaction_received_users_seen: reactionReceivedUsersSeen,
    message_updates: messageUpdates,
    reaction_sent_updates: reactionSentUpdates,
    reaction_received_updates: reactionReceivedUpdates,
  };
}

async function getBackfillHistoryTargets(
  guild: NonNullable<ChatInputCommandInteraction["guild"]>,
): Promise<Array<TextChannel | AnyThreadChannel>> {
  const targets: Array<TextChannel | AnyThreadChannel> = [];
  const seenIds = new Set<string>();

  for (const channel of guild.channels.cache.values()) {
    if (!(channel instanceof TextChannel)) {
      continue;
    }

    if (!seenIds.has(channel.id)) {
      seenIds.add(channel.id);
      targets.push(channel);
    }
  }

  const activeThreads = await guild.channels.fetchActiveThreads().catch(() => null);
  if (activeThreads) {
    for (const thread of activeThreads.threads.values()) {
      if (seenIds.has(thread.id)) {
        continue;
      }
      seenIds.add(thread.id);
      targets.push(thread);
    }
  }

  return targets;
}

async function scanBackfillHistoryTarget(
  target: TextChannel | AnyThreadChannel,
  afterTimestamp: number | null,
  messageCounts: Record<number, number>,
  reactionsSentCounts: Record<number, number>,
  reactionsReceivedCounts: Record<number, number>,
): Promise<[number, number]> {
  let scannedMessages = 0;
  let scannedReactions = 0;
  let before: string | undefined;

  while (true) {
    const batch = await target.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (batch.size === 0) {
      break;
    }

    const batchResult = await scanBackfillMessageBatch(
      batch.values(),
      afterTimestamp,
      messageCounts,
      reactionsSentCounts,
      reactionsReceivedCounts,
    );
    scannedMessages += batchResult.scannedMessages;
    scannedReactions += batchResult.scannedReactions;

    const oldest = batch.last();
    if (!oldest) {
      break;
    }

    before = oldest.id;
    if (batchResult.reachedLookback || (afterTimestamp !== null && oldest.createdTimestamp < afterTimestamp)) {
      break;
    }
  }

  return [scannedMessages, scannedReactions];
}

async function scanBackfillMessageBatch(
  messages: Iterable<Message>,
  afterTimestamp: number | null,
  messageCounts: Record<number, number>,
  reactionsSentCounts: Record<number, number>,
  reactionsReceivedCounts: Record<number, number>,
): Promise<{ scannedMessages: number; scannedReactions: number; reachedLookback: boolean }> {
  let scannedMessages = 0;
  let scannedReactions = 0;
  let reachedLookback = false;

  for (const message of messages) {
    if (afterTimestamp !== null && message.createdTimestamp < afterTimestamp) {
      reachedLookback = true;
      continue;
    }

    scannedMessages += 1;
    const messageAuthorId = getNonBotUserIdAsNumber(message.author);
    if (messageAuthorId !== null) {
      incrementCount(messageCounts, messageAuthorId, 1);
    }

    scannedReactions += await tallyReactionCountsForMessage(message, reactionsSentCounts, reactionsReceivedCounts);
  }

  return { scannedMessages, scannedReactions, reachedLookback };
}

async function tallyReactionCountsForMessage(
  message: Message,
  reactionsSentCounts: Record<number, number>,
  reactionsReceivedCounts: Record<number, number>,
): Promise<number> {
  let scannedReactions = 0;
  const recipientId = getNonBotUserIdAsNumber(message.author);

  for (const reaction of message.reactions.cache.values()) {
    const reactors = await reaction.users.fetch().catch(() => null);
    if (!reactors) {
      continue;
    }

    let nonBotReactors = 0;
    for (const reactor of reactors.values()) {
      const reactorId = getNonBotUserIdAsNumber(reactor);
      if (reactorId === null) {
        continue;
      }

      incrementCount(reactionsSentCounts, reactorId, 1);
      nonBotReactors += 1;
    }

    scannedReactions += nonBotReactors;
    if (recipientId !== null && nonBotReactors > 0) {
      incrementCount(reactionsReceivedCounts, recipientId, nonBotReactors);
    }
  }

  return scannedReactions;
}

function getNonBotUserIdAsNumber(user: { id: string; bot?: boolean } | null | undefined): number | null {
  if (!user || user.bot) {
    return null;
  }

  const parsedId = Number.parseInt(user.id, 10);
  if (!Number.isFinite(parsedId) || parsedId <= 0) {
    return null;
  }

  return parsedId;
}

function incrementCount(store: Record<number, number>, key: number, amount = 1): void {
  store[key] = (store[key] ?? 0) + amount;
}

async function handleInvictusBackfillStatus(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  const snapshot = getBackfillStatusSnapshot(runtime.backfillStatus);
  const embed = new EmbedBuilder()
    .setTitle("User Stats Backfill Status")
    .setColor(ROLE_COLOR)
    .setTimestamp(runtime.now().toJSDate())
    .addFields(
      { name: "Running", value: `\`${snapshot.running ? "yes" : "no"}\``, inline: true },
      { name: "Lookback", value: backfillLookbackText(snapshot.lookback_days), inline: true },
      { name: "Last Status", value: `\`${snapshot.last_status}\``, inline: true },
      { name: "Started At", value: snapshot.started_at ?? "n/a", inline: false },
      { name: "Last Started", value: snapshot.last_started_at ?? "n/a", inline: true },
      { name: "Last Completed", value: snapshot.last_completed_at ?? "n/a", inline: true },
      { name: "Last Summary", value: snapshot.last_summary ?? "n/a", inline: false },
      { name: "Last Error", value: snapshot.last_error ?? "n/a", inline: false },
    );

  runtime.storage.recordCommandMetric("invictus.backfillstatus");
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleInvictusHelp(interaction: ChatInputCommandInteraction): Promise<void> {
  const helpText = [
    "**Imperial Court Bot Commands**",
    "",
    "**Court Control**",
    "`/court status`, `/court health`, `/court analytics`, `/court dryrun`, `/court exportstate`, `/court importstate`",
    "`/court mode`, `/court channel`, `/court logchannel`, `/court schedule`",
    "",
    "**Questions**",
    "`/court listcategories`, `/court addquestion`, `/court deletequestion`, `/court editquestion`, `/court resethistory`",
    "`/questions count`, `/questions unused`, `/questions audit`",
    "",
    "**Court Posts**",
    "`/court post`, `/court custom`, `/court close`, `/court listopen`, `/court extend`, `/court reopen`, `/court removeanswer`",
    "",
    "**Invictus**",
    "`/invictus say`, `/invictus dmpanel`, `/invictus rolepanel`, `/invictus rolepanelmulti`, `/invictus purge`, `/invictus purgeuser`, `/invictus lock`, `/invictus unlock`",
    "`/invictus slowmode`, `/invictus timeout`, `/invictus untimeout`, `/invictus mutemany`, `/invictus unmutemany`, `/invictus muteall`, `/invictus unmuteall`",
    "`/invictus resetroyaltimer`, `/invictus afk`, `/invictus afkstatus`, `/invictus backfillstats`, `/invictus backfillstatus`",
    "",
    "**Fun**",
    "`/fun battle`, `/fun stats`, `/fun leaderboard`, `/fun verdict`, `/fun title`, `/fun fate`",
    "",
    "**Greetings**",
    "`/greetings rio`, `/greetings taylor`",
  ].join("\n");

  const embed = new EmbedBuilder().setTitle("Command Reference").setDescription(helpText).setColor(ROLE_COLOR).setTimestamp(new Date());
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleFunBattle(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: MSG_USE_IN_SERVER, ephemeral: true });
    return;
  }

  const challenger = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!challenger) {
    await interaction.reply({ content: MSG_VERIFY_ROLES, ephemeral: true });
    return;
  }

  const opponentUser = interaction.options.getUser("opponent", true);
  const opponent = await interaction.guild.members.fetch(opponentUser.id).catch(() => null);
  if (!opponent) {
    await interaction.reply({ content: "Could not resolve that opponent.", ephemeral: true });
    return;
  }

  if (opponent.id === challenger.id) {
    await interaction.reply({ content: "You can't battle yourself, coward!", ephemeral: true });
    return;
  }

  const unbeatable = runtime.config.undefeatedUserIdText;
  let winner: GuildMember;
  if (challenger.id === unbeatable) {
    winner = challenger;
  } else if (opponent.id === unbeatable) {
    winner = opponent;
  } else if (runtime.randomInt(2) === 0) {
    winner = challenger;
  } else {
    winner = opponent;
  }
  const loser = winner.id === challenger.id ? opponent : challenger;

  runtime.storage.metricsIncrement(runtime.storage.buildUserMetricKey(challenger.id, "battles_played"));
  runtime.storage.metricsIncrement(runtime.storage.buildUserMetricKey(opponent.id, "battles_played"));
  runtime.storage.metricsIncrement(runtime.storage.buildUserMetricKey(winner.id, "battles_won"));

  const challengerStats = Object.fromEntries(BOSS_STATS.map((statName) => [
    statName,
    challenger.id === unbeatable ? 100 : runtime.randomInt(100) + 1,
  ]));
  const opponentStats = Object.fromEntries(BOSS_STATS.map((statName) => [
    statName,
    opponent.id === unbeatable ? 100 : runtime.randomInt(100) + 1,
  ]));

  let battleText = `**${challenger.toString()} vs ${opponent.toString()}**\n\n**${challenger.displayName}'s Arsenal:**\n`;
  for (const [statName, value] of Object.entries(challengerStats)) {
    battleText += `- ${statName}: ${value}/100\n`;
  }

  battleText += `\n**${opponent.displayName}'s Arsenal:**\n`;
  for (const [statName, value] of Object.entries(opponentStats)) {
    battleText += `- ${statName}: ${value}/100\n`;
  }

  battleText += `\n---\n\n**CHAMPIONSHIP VICTORY: ${winner.toString()}!**\n**${loser.toString()} has been defeated!**`;

  const embed = new EmbedBuilder()
    .setTitle("BOSS BATTLE ARENA")
    .setDescription(battleText)
    .setColor(ROLE_COLOR)
    .setTimestamp(runtime.now().toJSDate())
    .addFields(
      { name: "Challenger", value: challenger.toString(), inline: true },
      { name: "Opponent", value: opponent.toString(), inline: true },
      { name: "Champion", value: winner.toString(), inline: false },
    );

  await interaction.reply({ content: `${challenger.toString()} ${opponent.toString()}`, embeds: [embed] });
}

async function handleFunStats(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: MSG_USE_IN_SERVER, ephemeral: true });
    return;
  }

  const memberUser = interaction.options.getUser("member");
  const target = memberUser
    ? await interaction.guild.members.fetch(memberUser.id).catch(() => null)
    : await interaction.guild.members.fetch(interaction.user.id).catch(() => null);

  if (!target) {
    await interaction.reply({ content: MSG_VERIFY_ROLES, ephemeral: true });
    return;
  }

  const stats = runtime.storage.getUserFunMetrics(target.id);
  const embed = new EmbedBuilder()
    .setTitle(`${target.displayName}'s Court Activity`)
    .setDescription("Just-for-fun community activity tracking.")
    .setColor(ROLE_COLOR)
    .setTimestamp(runtime.now().toJSDate())
    .setFooter({ text: "Stats are tracked from this bot runtime onward." });

  for (const [metricName, label] of USER_FUN_METRIC_FIELDS) {
    embed.addFields({ name: label, value: `\`${stats[metricName] ?? 0}\``, inline: true });
  }

  await interaction.reply({ embeds: [embed] });
}

async function handleFunLeaderboard(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: MSG_USE_IN_SERVER, ephemeral: true });
    return;
  }

  const metric = interaction.options.getString("metric", true);
  const limit = interaction.options.getInteger("limit") ?? 5;
  if (!USER_FUN_LEADERBOARD_METRICS.has(metric)) {
    await interaction.reply({ content: "Unknown leaderboard metric.", ephemeral: true });
    return;
  }

  const topRows = runtime.storage.listTopUsersForMetric(metric, limit);
  if (topRows.length === 0) {
    await interaction.reply({ content: "No data yet for that leaderboard. Go make some chaos first." });
    return;
  }

  const lines: string[] = [];
  for (let index = 0; index < topRows.length; index += 1) {
    const row = topRows[index];
    if (!row) {
      continue;
    }
    const [userId, value] = row;
    const member = interaction.guild.members.cache.get(String(userId))
      ?? (await interaction.guild.members.fetch(String(userId)).catch(() => null));
    const display = member ? member.toString() : `<@${userId}>`;
    lines.push(`${index + 1}. ${display} - \`${value}\``);
  }

  const metricLabel = USER_FUN_METRIC_LABELS.get(metric) ?? metric.replaceAll("_", " ");
  const embed = new EmbedBuilder()
    .setTitle(`Fun Leaderboard: ${metricLabel}`)
    .setDescription(lines.join("\n"))
    .setColor(ROLE_COLOR)
    .setTimestamp(runtime.now().toJSDate());

  await interaction.reply({ embeds: [embed] });
}

async function handleInvictusPurge(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  const channel = getManageTargetChannel(interaction);
  if (!channel) {
    await interaction.reply({ content: MSG_USE_TEXT_CHANNEL, ephemeral: true });
    return;
  }

  const amount = interaction.options.getInteger("amount", true);
  await interaction.deferReply({ ephemeral: true });

  const deleted = await channel.bulkDelete(amount, true).catch(() => null);
  if (!deleted) {
    await interaction.editReply({ content: "Failed to purge messages." });
    return;
  }

  runtime.storage.recordCommandMetric("invictus.purge");
  await interaction.editReply({ content: `Deleted \`${deleted.size}\` message(s) in ${channel.toString()}.` });

  await sendLog(
    interaction,
    runtime,
    "Admin Purge",
    `**By:** ${interaction.user.toString()}\n**Channel:** ${channel.toString()}\n**Requested:** \`${amount}\`\n**Deleted:** \`${deleted.size}\``,
  );
}

async function handleInvictusPurgeUser(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  const channel = getManageTargetChannel(interaction);
  if (!channel) {
    await interaction.reply({ content: MSG_USE_TEXT_CHANNEL, ephemeral: true });
    return;
  }

  const memberUser = interaction.options.getUser("member", true);
  const amount = interaction.options.getInteger("amount") ?? 100;
  await interaction.deferReply({ ephemeral: true });

  const member = await interaction.guild?.members.fetch(memberUser.id).catch(() => null);
  if (!member) {
    await interaction.editReply({ content: "Could not resolve that member." });
    return;
  }

  const recentMessages = await channel.messages.fetch({ limit: amount }).catch(() => null);
  if (!recentMessages) {
    await interaction.editReply({ content: "Failed to fetch messages for purge." });
    return;
  }

  const targetMessages = recentMessages.filter((message) => message.author.id === member.id);
  const deleted = targetMessages.size > 0 ? await channel.bulkDelete(targetMessages, true).catch(() => null) : null;
  const deletedCount = deleted?.size ?? 0;

  runtime.storage.recordCommandMetric("invictus.purgeuser");
  await interaction.editReply({
    content: `Deleted \`${deletedCount}\` message(s) from ${member.toString()} in ${channel.toString()}.`,
  });

  await sendLog(
    interaction,
    runtime,
    "Admin Purge User",
    `**By:** ${interaction.user.toString()}\n**Channel:** ${channel.toString()}\n**Target:** ${member.toString()}\n**Scanned:** \`${amount}\`\n**Deleted:** \`${deletedCount}\``,
  );
}

async function handleInvictusLock(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: MSG_USE_IN_SERVER, ephemeral: true });
    return;
  }

  const channel = getManageTargetChannel(interaction);
  if (!channel) {
    await interaction.reply({ content: MSG_USE_TEXT_CHANNEL, ephemeral: true });
    return;
  }

  const reason = interaction.options.getString("reason") ?? "Channel locked via /invictus lock";
  const everyone = interaction.guild.roles.everyone;
  const success = await channel.permissionOverwrites
    .edit(everyone, { SendMessages: false }, { reason })
    .then(() => true)
    .catch(() => false);
  if (!success) {
    await interaction.reply({ content: "Failed to lock this channel.", ephemeral: true });
    return;
  }

  runtime.storage.recordCommandMetric("invictus.lock");
  await interaction.reply({ content: "Channel locked for @everyone.", ephemeral: true });

  await sendLog(
    interaction,
    runtime,
    "Admin Channel Locked",
    `**By:** ${interaction.user.toString()}\n**Channel:** ${channel.toString()}\n**Reason:** ${reason}`,
  );
}

async function handleInvictusUnlock(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: MSG_USE_IN_SERVER, ephemeral: true });
    return;
  }

  const channel = getManageTargetChannel(interaction);
  if (!channel) {
    await interaction.reply({ content: MSG_USE_TEXT_CHANNEL, ephemeral: true });
    return;
  }

  const reason = interaction.options.getString("reason") ?? "Channel unlocked via /invictus unlock";
  const everyone = interaction.guild.roles.everyone;
  const success = await channel.permissionOverwrites
    .edit(everyone, { SendMessages: true }, { reason })
    .then(() => true)
    .catch(() => false);
  if (!success) {
    await interaction.reply({ content: "Failed to unlock this channel.", ephemeral: true });
    return;
  }

  runtime.storage.recordCommandMetric("invictus.unlock");
  await interaction.reply({ content: "Channel unlocked for @everyone.", ephemeral: true });

  await sendLog(
    interaction,
    runtime,
    "Admin Channel Unlocked",
    `**By:** ${interaction.user.toString()}\n**Channel:** ${channel.toString()}\n**Reason:** ${reason}`,
  );
}

async function handleInvictusSlowMode(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  const channel = getManageTargetChannel(interaction);
  if (!channel) {
    await interaction.reply({ content: MSG_USE_TEXT_CHANNEL, ephemeral: true });
    return;
  }

  const seconds = interaction.options.getInteger("seconds", true);
  const success = await channel.setRateLimitPerUser(seconds, `Updated by ${interaction.user.tag}`).then(() => true).catch(() => false);
  if (!success) {
    await interaction.reply({ content: "Failed to update slowmode.", ephemeral: true });
    return;
  }

  runtime.storage.recordCommandMetric("invictus.slowmode");
  await interaction.reply({ content: `Slowmode set to \`${seconds}\` second(s) in ${channel.toString()}.`, ephemeral: true });

  await sendLog(
    interaction,
    runtime,
    "Admin Slowmode Updated",
    `**By:** ${interaction.user.toString()}\n**Channel:** ${channel.toString()}\n**Seconds:** \`${seconds}\``,
  );
}

async function handleInvictusTimeout(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  const timeoutContext = await getTimeoutContext(interaction);
  if (!timeoutContext) {
    return;
  }

  const { actor, me } = timeoutContext;
  const memberUser = interaction.options.getUser("member", true);
  const member = await interaction.guild?.members.fetch(memberUser.id).catch(() => null);
  if (!member) {
    await interaction.reply({ content: "Could not resolve that member.", ephemeral: true });
    return;
  }

  const minutes = interaction.options.getInteger("minutes", true);
  const reason = interaction.options.getString("reason");

  const [allowed, whyNot] = canTimeoutTarget(actor, me, member);
  if (!allowed) {
    await interaction.reply({ content: `Cannot timeout ${member.toString()}: ${whyNot}.`, ephemeral: true });
    return;
  }

  const modReason = buildTimeoutReason("Muted", actor, reason);
  const durationMs = minutes * 60_000;
  const success = await member.timeout(durationMs, modReason).then(() => true).catch(() => false);
  if (!success) {
    await interaction.reply({ content: `Failed to timeout ${member.toString()}.`, ephemeral: true });
    return;
  }

  runtime.storage.recordCommandMetric("invictus.timeout");
  await interaction.reply({ content: `Timed out ${member.toString()} for \`${minutes}\` minute(s).`, ephemeral: true });

  await sendLog(
    interaction,
    runtime,
    "Admin Timeout",
    `**By:** ${actor.toString()}\n**Target:** ${member.toString()}\n**Minutes:** \`${minutes}\`\n**Reason:** ${reason ?? "No reason provided."}`,
  );
}

async function handleInvictusUntimeout(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  const timeoutContext = await getTimeoutContext(interaction);
  if (!timeoutContext) {
    return;
  }

  const { actor, me } = timeoutContext;
  const memberUser = interaction.options.getUser("member", true);
  const member = await interaction.guild?.members.fetch(memberUser.id).catch(() => null);
  if (!member) {
    await interaction.reply({ content: "Could not resolve that member.", ephemeral: true });
    return;
  }

  const reason = interaction.options.getString("reason");
  const [allowed, whyNot] = canTimeoutTarget(actor, me, member);
  if (!allowed) {
    await interaction.reply({ content: `Cannot untimeout ${member.toString()}: ${whyNot}.`, ephemeral: true });
    return;
  }

  if (!isMemberTimedOut(member)) {
    await interaction.reply({ content: `${member.toString()} is not currently timed out.`, ephemeral: true });
    return;
  }

  const modReason = buildTimeoutReason("Unmuted", actor, reason);
  const success = await member.timeout(null, modReason).then(() => true).catch(() => false);
  if (!success) {
    await interaction.reply({ content: `Failed to untimeout ${member.toString()}.`, ephemeral: true });
    return;
  }

  runtime.storage.recordCommandMetric("invictus.untimeout");
  await interaction.reply({ content: `Removed timeout from ${member.toString()}.`, ephemeral: true });

  await sendLog(
    interaction,
    runtime,
    "Admin Untimeout",
    `**By:** ${actor.toString()}\n**Target:** ${member.toString()}\n**Reason:** ${reason ?? "No reason provided."}`,
  );
}

async function handleInvictusMuteMany(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  const timeoutContext = await getTimeoutContext(interaction);
  if (!timeoutContext) {
    return;
  }

  const { actor, me } = timeoutContext;
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: MSG_USE_IN_SERVER, ephemeral: true });
    return;
  }

  const membersRaw = interaction.options.getString("members", true);
  const minutes = interaction.options.getInteger("minutes", true);
  const dryRun = interaction.options.getBoolean("dry_run") ?? false;
  const reason = interaction.options.getString("reason");

  const memberIds = parseMemberIds(membersRaw);
  if (memberIds.length === 0) {
    await interaction.reply({ content: "No valid member mentions or IDs were provided.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const [targets, missingIds] = await resolveMembers(guild, memberIds);
  const preview = previewTimeoutTargets(actor, me, targets);
  const cap = runtime.config.muteallTargetCap;
  if (cap > 0 && preview.eligible > cap) {
    await interaction.editReply({ content: buildTargetCapMessage(preview.eligible, cap) });
    return;
  }

  if (dryRun) {
    let summary =
      `Dry run only: would mute \`${preview.eligible}\` member(s) for \`${minutes}\` minute(s).\n`
      + `Skipped during preview: \`${preview.skipped}\` | Unknown IDs: \`${missingIds.length}\``;
    summary = appendPreviewIssues(summary, preview.details);

    runtime.storage.recordCommandMetric("invictus.mutemany");
    await interaction.editReply({ content: summary });
    return;
  }

  const muteUntilMs = minutes * 60_000;
  const modReason = buildTimeoutReason("Muted", actor, reason);
  const result = await applyTimeoutToTargets(actor, me, targets, muteUntilMs, modReason);

  let summary =
    `Muted \`${result.applied}\` member(s) for \`${minutes}\` minute(s).\n`
    + `Skipped: \`${result.skipped}\` | Failed: \`${result.failed}\` | Unknown IDs: \`${missingIds.length}\``;
  summary = appendIssueSummary(summary, result.details);

  runtime.storage.recordCommandMetric("invictus.mutemany");
  await interaction.editReply({ content: summary });

  await sendLog(
    interaction,
    runtime,
    "Admin Mute Many",
    `**By:** ${actor.toString()}\n**Minutes:** \`${minutes}\`\n**Applied:** \`${result.applied}\`\n**Skipped:** \`${result.skipped}\`\n**Failed:** \`${result.failed}\`\n**Unknown IDs:** \`${missingIds.length}\`\n**Reason:** ${reason ?? "No reason provided."}`,
  );
}

async function handleInvictusUnmuteMany(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  const timeoutContext = await getTimeoutContext(interaction);
  if (!timeoutContext) {
    return;
  }

  const { actor, me } = timeoutContext;
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: MSG_USE_IN_SERVER, ephemeral: true });
    return;
  }

  const membersRaw = interaction.options.getString("members", true);
  const dryRun = interaction.options.getBoolean("dry_run") ?? false;
  const reason = interaction.options.getString("reason");

  const memberIds = parseMemberIds(membersRaw);
  if (memberIds.length === 0) {
    await interaction.reply({ content: "No valid member mentions or IDs were provided.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const [targets, missingIds] = await resolveMembers(guild, memberIds);
  const preview = previewTimeoutTargets(actor, me, targets, true);
  const cap = runtime.config.muteallTargetCap;
  if (cap > 0 && preview.eligible > cap) {
    await interaction.editReply({ content: buildTargetCapMessage(preview.eligible, cap) });
    return;
  }

  if (dryRun) {
    let summary =
      `Dry run only: would unmute \`${preview.eligible}\` member(s).\n`
      + `Skipped during preview: \`${preview.skipped}\` | Unknown IDs: \`${missingIds.length}\``;
    summary = appendPreviewIssues(summary, preview.details);

    runtime.storage.recordCommandMetric("invictus.unmutemany");
    await interaction.editReply({ content: summary });
    return;
  }

  const modReason = buildTimeoutReason("Unmuted", actor, reason);
  const result = await applyTimeoutToTargets(actor, me, targets, null, modReason, true);

  let summary =
    `Unmuted \`${result.applied}\` member(s).\n`
    + `Skipped: \`${result.skipped}\` | Failed: \`${result.failed}\` | Unknown IDs: \`${missingIds.length}\``;
  summary = appendIssueSummary(summary, result.details);

  runtime.storage.recordCommandMetric("invictus.unmutemany");
  await interaction.editReply({ content: summary });

  await sendLog(
    interaction,
    runtime,
    "Admin Unmute Many",
    `**By:** ${actor.toString()}\n**Applied:** \`${result.applied}\`\n**Skipped:** \`${result.skipped}\`\n**Failed:** \`${result.failed}\`\n**Unknown IDs:** \`${missingIds.length}\`\n**Reason:** ${reason ?? "No reason provided."}`,
  );
}

async function handleInvictusMuteAll(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  const confirm = interaction.options.getString("confirm", true);
  if (!isConfirmed(confirm)) {
    await interaction.reply({ content: MSG_CONFIRM_REQUIRED, ephemeral: true });
    return;
  }

  const timeoutContext = await getTimeoutContext(interaction);
  if (!timeoutContext) {
    return;
  }

  const { actor, me } = timeoutContext;
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: MSG_USE_IN_SERVER, ephemeral: true });
    return;
  }

  const minutes = interaction.options.getInteger("minutes", true);
  const dryRun = interaction.options.getBoolean("dry_run") ?? false;
  const reason = interaction.options.getString("reason");

  await interaction.deferReply({ ephemeral: true });
  await guild.members.fetch().catch(() => null);

  const targets = [...guild.members.cache.values()];
  const preview = previewTimeoutTargets(actor, me, targets);
  const cap = runtime.config.muteallTargetCap;
  if (cap > 0 && preview.eligible > cap) {
    await interaction.editReply({ content: buildTargetCapMessage(preview.eligible, cap) });
    return;
  }

  if (dryRun) {
    let summary =
      `Dry run only: would mute \`${preview.eligible}\` member(s) for \`${minutes}\` minute(s).\n`
      + `Skipped during preview: \`${preview.skipped}\``;
    summary = appendPreviewIssues(summary, preview.details);

    runtime.storage.recordCommandMetric("invictus.muteall");
    await interaction.editReply({ content: summary });
    return;
  }

  const muteUntilMs = minutes * 60_000;
  const modReason = buildTimeoutReason("Muted", actor, reason);
  const result = await applyTimeoutToTargets(actor, me, targets, muteUntilMs, modReason);

  runtime.storage.recordCommandMetric("invictus.muteall");
  await interaction.editReply({
    content: `Mute all complete. Muted \`${result.applied}\` member(s). Skipped \`${result.skipped}\`. Failed \`${result.failed}\`.`,
  });

  await sendLog(
    interaction,
    runtime,
    "Admin Mute All",
    `**By:** ${actor.toString()}\n**Minutes:** \`${minutes}\`\n**Applied:** \`${result.applied}\`\n**Skipped:** \`${result.skipped}\`\n**Failed:** \`${result.failed}\`\n**Reason:** ${reason ?? "No reason provided."}`,
  );
}

async function handleInvictusUnmuteAll(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  const confirm = interaction.options.getString("confirm", true);
  if (!isConfirmed(confirm)) {
    await interaction.reply({ content: MSG_CONFIRM_REQUIRED, ephemeral: true });
    return;
  }

  const timeoutContext = await getTimeoutContext(interaction);
  if (!timeoutContext) {
    return;
  }

  const { actor, me } = timeoutContext;
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: MSG_USE_IN_SERVER, ephemeral: true });
    return;
  }

  const dryRun = interaction.options.getBoolean("dry_run") ?? false;
  const reason = interaction.options.getString("reason");

  await interaction.deferReply({ ephemeral: true });
  await guild.members.fetch().catch(() => null);

  const targets = [...guild.members.cache.values()];
  const preview = previewTimeoutTargets(actor, me, targets, true);
  const cap = runtime.config.muteallTargetCap;
  if (cap > 0 && preview.eligible > cap) {
    await interaction.editReply({ content: buildTargetCapMessage(preview.eligible, cap) });
    return;
  }

  if (dryRun) {
    let summary =
      `Dry run only: would unmute \`${preview.eligible}\` member(s).\n`
      + `Skipped during preview: \`${preview.skipped}\``;
    summary = appendPreviewIssues(summary, preview.details);

    runtime.storage.recordCommandMetric("invictus.unmuteall");
    await interaction.editReply({ content: summary });
    return;
  }

  const modReason = buildTimeoutReason("Unmuted", actor, reason);
  const result = await applyTimeoutToTargets(actor, me, targets, null, modReason, true);

  runtime.storage.recordCommandMetric("invictus.unmuteall");
  await interaction.editReply({
    content: `Unmute all complete. Unmuted \`${result.applied}\` member(s). Skipped \`${result.skipped}\`. Failed \`${result.failed}\`.`,
  });

  await sendLog(
    interaction,
    runtime,
    "Admin Unmute All",
    `**By:** ${actor.toString()}\n**Applied:** \`${result.applied}\`\n**Skipped:** \`${result.skipped}\`\n**Failed:** \`${result.failed}\`\n**Reason:** ${reason ?? "No reason provided."}`,
  );
}

async function getTimeoutContext(
  interaction: ChatInputCommandInteraction,
): Promise<{ actor: GuildMember; me: GuildMember } | null> {
  if (!interaction.guild) {
    await interaction.reply({ content: MSG_USE_IN_SERVER, ephemeral: true });
    return null;
  }

  const actor = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!actor) {
    await interaction.reply({ content: MSG_VERIFY_ROLES, ephemeral: true });
    return null;
  }

  const me = interaction.guild.members.me ?? (await interaction.guild.members.fetchMe().catch(() => null));
  if (!me) {
    await interaction.reply({ content: MSG_BOT_CONTEXT_ERROR, ephemeral: true });
    return null;
  }

  return { actor, me };
}

function canTimeoutTarget(actor: GuildMember, me: GuildMember, target: GuildMember): [boolean, string] {
  if (target.user.bot) {
    return [false, "target is a bot"];
  }
  if (target.id === me.id) {
    return [false, "target is the bot"];
  }
  if (target.id === actor.guild.ownerId) {
    return [false, "target is the server owner"];
  }
  if (target.id === actor.id) {
    return [false, "target is yourself"];
  }
  if (me.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
    return [false, "bot role is not high enough"];
  }

  const actorIsOwner = actor.id === actor.guild.ownerId;
  if (!actorIsOwner && actor.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
    return [false, "your role is not high enough"];
  }

  return [true, ""];
}

function buildTimeoutReason(action: string, user: GuildMember, reason: string | null): string {
  const base = `${action} by ${user.user.tag} via /admin`;
  return reason ? `${base} | ${reason}` : base;
}

function isMemberTimedOut(member: GuildMember): boolean {
  const until = member.communicationDisabledUntilTimestamp;
  return typeof until === "number" && until > Date.now();
}

function parseMemberIds(raw: string): string[] {
  const matches = raw.match(/\d{15,20}/g) ?? [];
  return [...new Set(matches)];
}

async function resolveMembers(
  guild: NonNullable<ChatInputCommandInteraction["guild"]>,
  memberIds: string[],
): Promise<[GuildMember[], string[]]> {
  const found: GuildMember[] = [];
  const missing: string[] = [];

  for (const memberId of memberIds) {
    const member = guild.members.cache.get(memberId) ?? (await guild.members.fetch(memberId).catch(() => null));
    if (!member) {
      missing.push(memberId);
      continue;
    }
    found.push(member);
  }

  return [found, missing];
}

function previewTimeoutTargets(
  actor: GuildMember,
  me: GuildMember,
  targets: GuildMember[],
  onlyIfTimedOut = false,
): { eligible: number; skipped: number; details: string[] } {
  let eligible = 0;
  let skipped = 0;
  const details: string[] = [];

  for (const target of targets) {
    const [allowed, whyNot] = canTimeoutTarget(actor, me, target);
    if (!allowed) {
      skipped += 1;
      details.push(`${target.toString()} (${whyNot})`);
      continue;
    }

    if (onlyIfTimedOut && !isMemberTimedOut(target)) {
      skipped += 1;
      continue;
    }

    eligible += 1;
  }

  return { eligible, skipped, details };
}

async function applyTimeoutToTargets(
  actor: GuildMember,
  me: GuildMember,
  targets: GuildMember[],
  untilMs: number | null,
  reason: string,
  onlyIfTimedOut = false,
): Promise<{ applied: number; skipped: number; failed: number; details: string[] }> {
  let applied = 0;
  let skipped = 0;
  let failed = 0;
  const details: string[] = [];

  for (const target of targets) {
    const [allowed, whyNot] = canTimeoutTarget(actor, me, target);
    if (!allowed) {
      skipped += 1;
      details.push(`${target.toString()} (${whyNot})`);
      continue;
    }

    if (onlyIfTimedOut && !isMemberTimedOut(target)) {
      skipped += 1;
      continue;
    }

    const success = await target.timeout(untilMs, reason).then(() => true).catch(() => false);
    if (success) {
      applied += 1;
      continue;
    }

    failed += 1;
    details.push(`${target.toString()} (discord API error)`);
  }

  return { applied, skipped, failed, details };
}

function buildTargetCapMessage(eligibleTargets: number, cap: number): string {
  return (
    `Safety cap blocked this action. Eligible targets: \`${eligibleTargets}\` exceeds cap \`${cap}\`. `
    + "Set `MUTEALL_TARGET_CAP=0` or raise the cap in config for larger actions."
  );
}

function formatIssueLines(details: string[]): string {
  return details.slice(0, 10).map((line) => `- ${line}`).join("\n");
}

function appendPreviewIssues(summary: string, details: string[]): string {
  if (details.length === 0) {
    return summary;
  }

  return `${summary}${PREVIEW_ISSUES_PREFIX}${formatIssueLines(details)}`;
}

function appendIssueSummary(summary: string, details: string[]): string {
  if (details.length === 0) {
    return summary;
  }

  return `${summary}\n\nIssues:\n${formatIssueLines(details)}`;
}

async function handleInvictusRolePanel(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: MSG_USE_IN_SERVER, ephemeral: true });
    return;
  }

  const actor = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!actor) {
    await interaction.reply({ content: MSG_VERIFY_ROLES, ephemeral: true });
    return;
  }

  const targetChannel =
    (interaction.options.getChannel("channel") instanceof TextChannel
      ? (interaction.options.getChannel("channel") as TextChannel)
      : null) ?? getManageTargetChannel(interaction);
  if (!targetChannel) {
    await interaction.reply({
      content: "Provide a text channel, or run this command from a text channel.",
      ephemeral: true,
    });
    return;
  }

  const buttonLabel = (interaction.options.getString("button_label") ?? "").trim() || ROLE_PANEL_DEFAULT_BUTTON_LABEL;
  if (buttonLabel.length > ROLE_PANEL_BUTTON_LABEL_MAX_LENGTH) {
    await interaction.reply({
      content: `Button label must be ${ROLE_PANEL_BUTTON_LABEL_MAX_LENGTH} characters or fewer.`,
      ephemeral: true,
    });
    return;
  }

  const role = await resolveRoleOption(interaction, "role", true);
  if (!role) {
    await interaction.reply({ content: "The configured role no longer exists.", ephemeral: true });
    return;
  }

  const me = interaction.guild.members.me ?? (await interaction.guild.members.fetchMe().catch(() => null));
  if (!me) {
    await interaction.reply({ content: MSG_BOT_CONTEXT_ERROR, ephemeral: true });
    return;
  }

  const roleError = getRolePanelRoleError(actor, me, role);
  if (roleError) {
    await interaction.reply({ content: roleError, ephemeral: true });
    return;
  }

  const channelError = getRolePanelChannelPermissionError(targetChannel, me);
  if (channelError) {
    await interaction.reply({ content: channelError, ephemeral: true });
    return;
  }

  const panelEmbed = buildRolePanelEmbed(
    [role],
    interaction.options.getString("title"),
    interaction.options.getString("description"),
    runtime,
  );
  const panelComponents = buildRolePanelComponents([buttonLabel]);
  const mentionEveryone = interaction.options.getBoolean("mention_everyone") ?? false;
  const mentionPayload = buildAnnouncementMentions(mentionEveryone);

  const sent = await targetChannel
    .send({
      ...(mentionPayload.content === null ? {} : { content: mentionPayload.content }),
      embeds: [panelEmbed],
      components: panelComponents,
      allowedMentions: mentionPayload.allowedMentions,
    })
    .catch(() => null);
  if (!sent) {
    await interaction.reply({ content: "Failed to create the role panel.", ephemeral: true });
    return;
  }

  runtime.storage.recordCommandMetric("invictus.rolepanel");
  await interaction.reply({
    content: `Role panel posted in ${targetChannel.toString()} for ${role.toString()}.`,
    ephemeral: true,
  });

  await sendLog(
    interaction,
    runtime,
    "Role Panel Created",
    `**By:** ${interaction.user.toString()}\n**Channel:** ${targetChannel.toString()}\n**Role:** ${role.toString()} (\`${role.id}\`)\n**Button:** ${buttonLabel}\n**Mention Everyone:** \`${mentionEveryone ? "Yes" : "No"}\``,
  );
}

async function handleInvictusRolePanelMulti(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: MSG_USE_IN_SERVER, ephemeral: true });
    return;
  }

  const actor = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!actor) {
    await interaction.reply({ content: MSG_VERIFY_ROLES, ephemeral: true });
    return;
  }

  const targetChannel =
    (interaction.options.getChannel("channel") instanceof TextChannel
      ? (interaction.options.getChannel("channel") as TextChannel)
      : null) ?? getManageTargetChannel(interaction);
  if (!targetChannel) {
    await interaction.reply({
      content: "Provide a text channel, or run this command from a text channel.",
      ephemeral: true,
    });
    return;
  }

  const role1 = await resolveRoleOption(interaction, "role_1", true);
  const role2 = await resolveRoleOption(interaction, "role_2", true);
  const role3 = await resolveRoleOption(interaction, "role_3", false);
  const role4 = await resolveRoleOption(interaction, "role_4", false);
  const role5 = await resolveRoleOption(interaction, "role_5", false);

  if (!role1 || !role2) {
    await interaction.reply({ content: "Could not resolve selected roles.", ephemeral: true });
    return;
  }

  const [selectedRoles, collectionError] = collectRolePanelRoles(role1, role2, role3, role4, role5);
  if (collectionError) {
    await interaction.reply({ content: collectionError, ephemeral: true });
    return;
  }

  const me = interaction.guild.members.me ?? (await interaction.guild.members.fetchMe().catch(() => null));
  if (!me) {
    await interaction.reply({ content: MSG_BOT_CONTEXT_ERROR, ephemeral: true });
    return;
  }

  const roleError = getMultiRolePanelError(actor, me, selectedRoles);
  if (roleError) {
    await interaction.reply({ content: roleError, ephemeral: true });
    return;
  }

  const channelError = getRolePanelChannelPermissionError(targetChannel, me);
  if (channelError) {
    await interaction.reply({ content: channelError, ephemeral: true });
    return;
  }

  const panelEmbed = buildRolePanelEmbed(
    selectedRoles,
    interaction.options.getString("title"),
    interaction.options.getString("description"),
    runtime,
  );
  const panelComponents = buildRolePanelComponents(selectedRoles.map((selectedRole) => selectedRole.name));
  const mentionEveryone = interaction.options.getBoolean("mention_everyone") ?? false;
  const mentionPayload = buildAnnouncementMentions(mentionEveryone);

  const sent = await targetChannel
    .send({
      ...(mentionPayload.content === null ? {} : { content: mentionPayload.content }),
      embeds: [panelEmbed],
      components: panelComponents,
      allowedMentions: mentionPayload.allowedMentions,
    })
    .catch(() => null);
  if (!sent) {
    await interaction.reply({ content: "Failed to create the multi-role panel.", ephemeral: true });
    return;
  }

  runtime.storage.recordCommandMetric("invictus.rolepanelmulti");
  await interaction.reply({
    content: `Multi-role panel posted in ${targetChannel.toString()} with \`${selectedRoles.length}\` role button(s).`,
    ephemeral: true,
  });

  const roleLines = selectedRoles.map((selectedRole) => `- ${selectedRole.toString()} (\`${selectedRole.id}\`)`);
  await sendLog(
    interaction,
    runtime,
    "Multi Role Panel Created",
    `**By:** ${interaction.user.toString()}\n**Channel:** ${targetChannel.toString()}\n**Roles:**\n${roleLines.join("\n")}\n**Mention Everyone:** \`${mentionEveryone ? "Yes" : "No"}\``,
  );
}

function getManageTargetChannel(interaction: ChatInputCommandInteraction): TextChannel | null {
  if (interaction.channel instanceof TextChannel) {
    return interaction.channel;
  }

  return null;
}

function getDmPanelTargetChannel(interaction: ChatInputCommandInteraction): DmPanelTargetChannel | null {
  if (isDmPanelTargetChannel(interaction.channel)) {
    return interaction.channel;
  }

  return null;
}

function isDmPanelTargetChannel(channel: unknown): channel is DmPanelTargetChannel {
  if (channel instanceof TextChannel || channel instanceof NewsChannel) {
    return true;
  }

  if (!channel || typeof channel !== "object") {
    return false;
  }

  const maybeThreadChannel = channel as { isThread?: () => boolean };
  return typeof maybeThreadChannel.isThread === "function" && maybeThreadChannel.isThread();
}

function canMemberManageRole(member: GuildMember, role: Role): boolean {
  if (member.id === member.guild.ownerId) {
    return true;
  }

  return member.roles.highest.comparePositionTo(role) > 0;
}

function getRolePanelRoleError(actor: GuildMember, me: GuildMember, role: Role): string | null {
  if (role.id === role.guild.id) {
    return "You cannot create a panel for @everyone.";
  }

  if (role.managed) {
    return "Managed/integration roles cannot be self-assigned.";
  }

  if (!canMemberManageRole(actor, role)) {
    return "You can only create panels for roles lower than your highest role.";
  }

  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return "I need Manage Roles permission to grant roles.";
  }

  if (me.roles.highest.comparePositionTo(role) <= 0) {
    return "I cannot grant that role because it is above or equal to my top role.";
  }

  return null;
}

function getRolePanelChannelPermissionError(channel: DmPanelTargetChannel, me: GuildMember): string | null {
  const channelPermissions = channel.permissionsFor(me);
  const missingPermissions: string[] = [];
  const sendPermission = channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;

  if (!channelPermissions.has(PermissionFlagsBits.ViewChannel)) {
    missingPermissions.push("View Channel");
  }
  if (!channelPermissions.has(sendPermission)) {
    missingPermissions.push(channel.isThread() ? "Send Messages in Threads" : "Send Messages");
  }
  if (!channelPermissions.has(PermissionFlagsBits.EmbedLinks)) {
    missingPermissions.push("Embed Links");
  }

  if (missingPermissions.length === 0) {
    return null;
  }

  return `I am missing required channel permissions: ${missingPermissions.join(", ")}`;
}

function collectRolePanelRoles(
  role1: Role,
  role2: Role,
  role3: Role | null,
  role4: Role | null,
  role5: Role | null,
): [Role[], string | null] {
  const selectedRoles: Role[] = [role1, role2];
  for (const optionalRole of [role3, role4, role5]) {
    if (optionalRole) {
      selectedRoles.push(optionalRole);
    }
  }

  const uniqueIds = new Set<string>();
  for (const selectedRole of selectedRoles) {
    if (uniqueIds.has(selectedRole.id)) {
      return [[], "Each role in a multi panel must be unique."];
    }
    uniqueIds.add(selectedRole.id);
  }

  return [selectedRoles, null];
}

function getMultiRolePanelError(actor: GuildMember, me: GuildMember, roles: Role[]): string | null {
  for (const selectedRole of roles) {
    const roleError = getRolePanelRoleError(actor, me, selectedRole);
    if (roleError) {
      return `${selectedRole.toString()}: ${roleError}`;
    }
  }

  return null;
}

function buildRolePanelEmbed(
  roles: Role[],
  title: string | null,
  description: string | null,
  runtime: BotRuntime,
): EmbedBuilder {
  const panelRoles = roles.slice(0, ROLE_PANEL_MAX_BUTTONS);
  const panelTitle = (title ?? "").trim() || "Imperial Role Panel";

  const defaultDescription = panelRoles.length === 1
    ? `Click the button below to add or remove the **${panelRoles[0]?.name ?? "role"}** role.`
    : "Click one of the buttons below to toggle the matching role.";
  const panelDescription = (description ?? "").trim() || defaultDescription;

  const embed = new EmbedBuilder()
    .setTitle(panelTitle)
    .setDescription(panelDescription)
    .setColor(ROLE_COLOR)
    .setTimestamp(runtime.now().toJSDate());

  if (panelRoles.length === 1) {
    const role = panelRoles[0];
    if (role) {
      embed.addFields({ name: "Role", value: `${role.toString()} (\`${role.id}\`)`, inline: false });
      embed.setFooter({ text: `${ROLE_PANEL_FOOTER_PREFIX}${role.id}` });
    }
    return embed;
  }

  const roleLines = panelRoles.map((role, index) => `${index + 1}. ${role.toString()} (\`${role.id}\`)`);
  const footerTargets = panelRoles.map((role, index) => `${index + 1}=${role.id}`);
  embed.addFields({ name: "Roles", value: roleLines.join("\n"), inline: false });
  embed.setFooter({ text: `${ROLE_PANEL_TARGETS_FOOTER_PREFIX}${footerTargets.join(",")}` });
  return embed;
}

function buildRolePanelComponents(buttonLabels: string[] = [ROLE_PANEL_DEFAULT_BUTTON_LABEL]): ActionRowBuilder<ButtonBuilder>[] {
  const labels = buttonLabels.length > 0 ? buttonLabels : [ROLE_PANEL_DEFAULT_BUTTON_LABEL];
  const trimmedLabels = labels.slice(0, ROLE_PANEL_MAX_BUTTONS);

  const row = new ActionRowBuilder<ButtonBuilder>();
  for (const [indexRaw, rawLabel] of trimmedLabels.entries()) {
    const index = indexRaw + 1;
    const fallback = index === 1 ? ROLE_PANEL_DEFAULT_BUTTON_LABEL : `Claim Role ${index}`;
    const label = (rawLabel || "").trim() || fallback;
    const customId = index === 1 ? ROLE_PANEL_BUTTON_CUSTOM_ID : `${ROLE_PANEL_BUTTON_CUSTOM_ID}:${index}`;

    row.addComponents(
      new ButtonBuilder()
        .setCustomId(customId)
        .setLabel(label.slice(0, ROLE_PANEL_BUTTON_LABEL_MAX_LENGTH))
        .setStyle(ButtonStyle.Secondary),
    );
  }

  return [row];
}

async function resolveRoleOption(
  interaction: ChatInputCommandInteraction,
  name: string,
  required: boolean,
): Promise<Role | null> {
  const raw = interaction.options.getRole(name, required);
  if (!raw || !interaction.guild) {
    return null;
  }

  if (raw instanceof Role) {
    return raw;
  }

  return interaction.guild.roles.fetch(raw.id).catch(() => null);
}

export function buildCategorySummary(): string {
  return Object.entries(CATEGORY_DESCRIPTIONS)
    .map(([category, description]) => `${category}: ${description}`)
    .join("\n");
}

async function requireStaff(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<boolean> {
  if (!interaction.guild) {
    await interaction.reply({ content: MSG_USE_IN_SERVER, ephemeral: true });
    return false;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) {
    await interaction.reply({ content: MSG_VERIFY_ROLES, ephemeral: true });
    return false;
  }

  const isAdmin =
    member.permissions.has(PermissionFlagsBits.Administrator) || interaction.guild.ownerId === interaction.user.id;
  if (isAdmin) {
    return true;
  }

  const isStaff = member.roles.cache.some((role) => runtime.config.staffRoleIdsText.has(role.id));
  if (!isStaff) {
    await interaction.reply({ content: "You do not have permission to use this command.", ephemeral: true });
    return false;
  }

  return true;
}

async function requireAdmin(interaction: ChatInputCommandInteraction): Promise<boolean> {
  if (!interaction.guild) {
    await interaction.reply({ content: MSG_USE_IN_SERVER, ephemeral: true });
    return false;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) {
    await interaction.reply({ content: MSG_VERIFY_ROLES, ephemeral: true });
    return false;
  }

  const isAdmin =
    member.permissions.has(PermissionFlagsBits.Administrator) || interaction.guild.ownerId === interaction.user.id;
  if (!isAdmin) {
    await interaction.reply({ content: "You do not have permission to use this command.", ephemeral: true });
    return false;
  }

  return true;
}

async function requireRoyal(
  interaction: ChatInputCommandInteraction,
  runtime: BotRuntime,
): Promise<{ guild: ChatInputCommandInteraction["guild"]; actor: GuildMember; titles: RoyalTitle[] } | null> {
  if (!interaction.guild) {
    await interaction.reply({ content: MSG_USE_IN_SERVER, ephemeral: true });
    return null;
  }

  const actor = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!actor) {
    await interaction.reply({ content: MSG_VERIFY_ROLES, ephemeral: true });
    return null;
  }

  const titles = getMemberRoyalTitles(actor, runtime);
  if (titles.length === 0) {
    await interaction.reply({ content: MSG_ROYAL_ONLY, ephemeral: true });
    return null;
  }

  return {
    guild: interaction.guild,
    actor,
    titles,
  };
}

function getMemberRoyalTitles(member: GuildMember, runtime: BotRuntime): RoyalTitle[] {
  const titles: RoyalTitle[] = [];

  if (runtime.config.emperorRoleIdText && member.roles.cache.has(runtime.config.emperorRoleIdText)) {
    titles.push("Emperor");
  }
  if (runtime.config.empressRoleIdText && member.roles.cache.has(runtime.config.empressRoleIdText)) {
    titles.push("Empress");
  }

  return titles;
}

function isConfirmed(value: string): boolean {
  return value.trim().toUpperCase() === "CONFIRM";
}

async function handleCourtPost(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: MSG_USE_IN_SERVER, ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const channel = await getTargetChannel(interaction, runtime);
  if (!channel) {
    await interaction.editReply({ content: "Configured channel not found." });
    return;
  }

  const category = interaction.options.getString("category");
  const randomize = interaction.options.getBoolean("randomize") ?? true;

  try {
    const [chosenCategory, question] = await postQuestion(channel, runtime, {
      category,
      randomize,
      source: "manual",
      mentionEveryone: true,
    });

    runtime.storage.recordCommandMetric("court.post");

    await interaction.editReply({
      content: `Posted in ${channel.toString()}\n**Category:** \`${chosenCategory}\`\n**Question:** ${question}`,
    });

    await sendLog(
      interaction,
      runtime,
      "Court Question Posted",
      `**By:** ${interaction.user.toString()}\n**Channel:** ${channel.toString()}\n**Category:** \`${chosenCategory}\`\n**Randomized:** \`${randomize}\`\n**Question:** ${question}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to post question.";
    await interaction.editReply({ content: message });
  }
}

async function handleCourtCustom(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: MSG_USE_IN_SERVER, ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const cleanQuestion = normalizeQuestionText(interaction.options.getString("question", true));
  if (!cleanQuestion) {
    await interaction.editReply({ content: MSG_QUESTION_EMPTY });
    return;
  }

  const channel = await getTargetChannel(interaction, runtime);
  if (!channel) {
    await interaction.editReply({ content: "Configured channel not found." });
    return;
  }

  const embed = buildCourtEmbed("custom", cleanQuestion, runtime);
  const mentionPayload = buildAnnouncementMentions(false);
  const sent = await channel.send({
    ...(mentionPayload.content === null ? {} : { content: mentionPayload.content }),
    embeds: [embed],
    components: buildAnonymousAnswerComponents(),
    allowedMentions: mentionPayload.allowedMentions,
  });

  const thread = await getOrCreateAnswerThread(sent, cleanQuestion, runtime, interaction);
  runtime.storage.upsertPostRow({
    message_id: String(sent.id),
    thread_id: thread?.id ?? null,
    channel_id: String(channel.id),
    category: "custom",
    question: cleanQuestion,
    posted_at: isoNow(runtime.config.timezoneName),
    close_after_hours: THREAD_CLOSE_HOURS,
    closed: false,
    closed_at: null,
    close_reason: null,
  });

  runtime.storage.recordPostMetric("custom", "custom");
  runtime.storage.updateStateAtomic((state) => {
    state.last_posted_date = runtime.now().toFormat("yyyy-LL-dd");
  });
  runtime.storage.recordCommandMetric("court.custom");

  await interaction.editReply({ content: `Custom question posted in ${channel.toString()}.` });

  await sendLog(
    interaction,
    runtime,
    "Custom Court Question Posted",
    `**By:** ${interaction.user.toString()}\n**Channel:** ${channel.toString()}\n**Question:** ${cleanQuestion}`,
  );
}

async function handleCourtClose(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: MSG_USE_IN_SERVER, ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const messageId = interaction.options.getString("message_id");
  const record = messageId ? runtime.storage.getPostRecord(messageId) : runtime.storage.getLatestOpenPost();
  if (!record) {
    await interaction.editReply({ content: "No matching open court inquiry found." });
    return;
  }

  const [ok, message] = await closeCourtPost(record, "manual", interaction, runtime);
  runtime.storage.recordCommandMetric("court.close");

  await interaction.editReply({ content: message });

  if (ok) {
    await sendLog(
      interaction,
      runtime,
      "Court Inquiry Closed",
      `**By:** ${interaction.user.toString()}\n**Message ID:** \`${record.message_id}\`\n**Question:** ${record.question}`,
    );
  }
}

async function handleCourtListOpen(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  const openPosts = runtime.storage.listPostRecords(false);
  if (openPosts.length === 0) {
    await interaction.reply({ content: "No open court inquiries.", ephemeral: true });
    return;
  }

  const now = runtime.now();
  const lines: string[] = [];
  for (const post of openPosts.slice(-10)) {
    const postedAt = parseIso(post.posted_at);
    const ageText = postedAt ? formatDuration(now.diff(postedAt)) : "Unknown";

    const deadline = getPostCloseDeadline(post);
    let closesText = "Unknown";
    if (deadline) {
      const remaining = deadline.diff(now);
      closesText = remaining.toMillis() <= 0 ? "Overdue" : formatDuration(remaining);
    }

    const answerCount = runtime.storage.countAnswersForQuestion(post.message_id);
    lines.push(
      `- \`${post.message_id}\` | \`${post.category || "unknown"}\` | Age \`${ageText}\` | Closes in \`${closesText}\` | Answers \`${answerCount}\``,
    );
  }

  runtime.storage.recordCommandMetric("court.listopen");
  await interaction.reply({
    content: `**Open Court Inquiries (latest 10)**\n${lines.join("\n")}`,
    ephemeral: true,
  });
}

async function handleCourtExtend(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  const messageId = interaction.options.getString("message_id", true);
  const additionalHours = interaction.options.getInteger("additional_hours", true);

  const record = runtime.storage.getPostRecord(messageId);
  if (!record) {
    await interaction.reply({ content: "Court inquiry not found.", ephemeral: true });
    return;
  }

  const currentWindow = record.close_after_hours;
  const newWindow = currentWindow + additionalHours;
  runtime.storage.setPostCloseAfterHours(messageId, newWindow);

  runtime.storage.recordCommandMetric("court.extend");
  await interaction.reply({
    content: `Extended inquiry \`${messageId}\` by \`${additionalHours}\` hour(s). New close window: \`${newWindow}\` hour(s).`,
    ephemeral: true,
  });

  await sendLog(
    interaction,
    runtime,
    "Court Inquiry Extended",
    `**By:** ${interaction.user.toString()}\n**Message ID:** \`${messageId}\`\n**Old Window:** \`${currentWindow}\`h\n**New Window:** \`${newWindow}\`h`,
  );
}

async function handleCourtReopen(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: MSG_USE_IN_SERVER, ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const messageId = interaction.options.getString("message_id", true);
  const closeAfterHours = interaction.options.getInteger("close_after_hours") ?? THREAD_CLOSE_HOURS;

  const record = runtime.storage.getPostRecord(messageId);
  if (!record) {
    await interaction.editReply({ content: "Court inquiry not found." });
    return;
  }

  const [ok, message] = await reopenCourtPost(record, closeAfterHours, interaction, runtime);
  runtime.storage.recordCommandMetric("court.reopen");

  await interaction.editReply({ content: message });

  if (ok) {
    await sendLog(
      interaction,
      runtime,
      "Court Inquiry Reopened",
      `**By:** ${interaction.user.toString()}\n**Message ID:** \`${messageId}\`\n**Close Window:** \`${closeAfterHours}\`h`,
    );
  }
}

async function handleCourtRemoveAnswer(interaction: ChatInputCommandInteraction, runtime: BotRuntime): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: MSG_USE_IN_SERVER, ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const messageId = interaction.options.getString("message_id", true);
  const recordMatch = runtime.storage.findAnswerRecord(messageId);
  if (!recordMatch) {
    await interaction.editReply({ content: "Anonymous answer record not found." });
    return;
  }

  const postRecord = runtime.storage.getPostRecord(recordMatch.question_message_id);
  if (!postRecord?.thread_id) {
    await interaction.editReply({ content: "Could not find the parent court thread." });
    return;
  }

  const thread = await fetchThreadById(interaction, postRecord.thread_id);
  if (!thread) {
    await interaction.editReply({ content: "Could not access the parent thread." });
    return;
  }

  const answerMessage = await thread.messages.fetch(messageId).catch(() => null);
  if (!answerMessage) {
    await interaction.editReply({ content: "Could not fetch that answer message." });
    return;
  }

  const deleted = await answerMessage
    .delete()
    .then(() => true)
    .catch(() => false);
  if (!deleted) {
    await interaction.editReply({ content: "Failed to delete that answer message." });
    return;
  }

  runtime.storage.removeAnswerRecord(messageId);
  await interaction.editReply({ content: "Anonymous answer removed." });

  await sendLog(
    interaction,
    runtime,
    "Anonymous Answer Removed",
    `**By:** ${interaction.user.toString()}\n**Answer Message ID:** \`${messageId}\`\n**Parent Question ID:** \`${recordMatch.question_message_id}\``,
  );
}

async function closeCourtPost(
  record: PostRecord,
  reason: string,
  interaction: ChatInputCommandInteraction,
  runtime: BotRuntime,
): Promise<[boolean, string]> {
  if (record.closed) {
    return [false, MSG_INQUIRY_CLOSED];
  }

  const thread = await fetchThreadById(interaction, record.thread_id);
  if (thread) {
    await thread.edit({ archived: true, locked: true }).catch(() => null);
  }

  const message = await getPostMessage(interaction.client, record);
  if (message) {
    await message.edit({ components: buildClosedAnswerComponents() }).catch(() => null);
  }

  runtime.storage.markPostClosed(record.message_id, reason);
  return [true, "Court inquiry closed."];
}

async function reopenCourtPost(
  record: PostRecord,
  closeAfterHours: number,
  interaction: ChatInputCommandInteraction,
  runtime: BotRuntime,
): Promise<[boolean, string]> {
  if (!record.closed) {
    return [false, "This court inquiry is already open."];
  }

  const thread = await fetchThreadById(interaction, record.thread_id);
  if (thread) {
    await thread
      .edit({
        archived: false,
        locked: false,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      })
      .catch(() => null);
  }

  const message = await getPostMessage(interaction.client, record);
  if (message) {
    await message.edit({ components: buildAnonymousAnswerComponents() }).catch(() => null);
  }

  const reopened = runtime.storage.markPostOpen(record.message_id, closeAfterHours);
  if (!reopened) {
    return [false, "Could not reopen this inquiry record."];
  }

  return [true, "Court inquiry reopened."];
}

async function postQuestion(
  channel: TextChannel,
  runtime: BotRuntime,
  options: {
    category: string | null;
    randomize: boolean;
    source: "auto" | "manual" | "custom";
    mentionEveryone: boolean;
  },
): Promise<[string, string]> {
  const [chosenCategory, question] = runtime.storage.pickQuestion(options.category, options.randomize, runtime.randomInt);
  const embed = buildCourtEmbed(chosenCategory, question, runtime);
  const mentionPayload = buildAnnouncementMentions(options.mentionEveryone);

  const sent = await channel.send({
    ...(mentionPayload.content === null ? {} : { content: mentionPayload.content }),
    embeds: [embed],
    components: buildAnonymousAnswerComponents(),
    allowedMentions: mentionPayload.allowedMentions,
  });

  const thread = await getOrCreateAnswerThread(sent, question, runtime);
  runtime.storage.upsertPostRow({
    message_id: String(sent.id),
    thread_id: thread?.id ?? null,
    channel_id: String(channel.id),
    category: chosenCategory,
    question,
    posted_at: isoNow(runtime.config.timezoneName),
    close_after_hours: THREAD_CLOSE_HOURS,
    closed: false,
    closed_at: null,
    close_reason: null,
  });

  runtime.storage.registerUsedQuestion(question);
  runtime.storage.recordPostMetric(chosenCategory, options.source);
  runtime.storage.updateStateAtomic((state) => {
    state.last_posted_date = runtime.now().toFormat("yyyy-LL-dd");
  });

  return [chosenCategory, question];
}

function buildCourtEmbed(category: string, question: string, runtime: BotRuntime): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("Imperial Court Inquiry")
    .setDescription(`*The throne demands an answer.*\n\n**Question:** ${question}`)
    .setColor(ROLE_COLOR)
    .setTimestamp(runtime.now().toJSDate())
    .setFooter({ text: `Category: ${category}` });
}

function extractQuestionFromMessage(message: Message | null | undefined): string {
  if (!message || message.embeds.length === 0) {
    return MSG_UNKNOWN_QUESTION;
  }

  const description = message.embeds[0]?.description ?? "";
  const marker = "**Question:**";
  if (!description.includes(marker)) {
    return MSG_UNKNOWN_QUESTION;
  }

  const extracted = description.split(marker, 2)[1]?.trim();
  return extracted || MSG_UNKNOWN_QUESTION;
}

function buildAnonymousAnswerComponents(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(ANON_ANSWER_BUTTON_ID)
        .setLabel("Answer Anonymously")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function buildClosedAnswerComponents(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${ANON_ANSWER_BUTTON_ID}:closed`)
        .setLabel("Court Inquiry Closed")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
    ),
  ];
}

function buildAnonymousAnswerModal(questionMessageId: string): ModalBuilder {
  const input = new TextInputBuilder()
    .setCustomId(ANON_MODAL_INPUT_ID)
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder("Write your answer here...")
    .setRequired(true)
    .setMaxLength(1000);

  return new ModalBuilder()
    .setCustomId(`${ANON_MODAL_PREFIX}${questionMessageId}`)
    .setTitle("Anonymous Court Answer")
    .setLabelComponents({
      type: ComponentType.Label,
      label: "Your answer",
      component: input.toJSON(),
    });
}

function buildAdminSayModal(channelId: string, mentionEveryone: boolean): ModalBuilder {
  const input = new TextInputBuilder()
    .setCustomId(ADMIN_SAY_MODAL_INPUT_ID)
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder("Paste your announcement here...")
    .setRequired(true)
    .setMaxLength(4000);

  return new ModalBuilder()
    .setCustomId(`${ADMIN_SAY_MODAL_PREFIX}${channelId}:${mentionEveryone ? "1" : "0"}`)
    .setTitle("Send Announcement")
    .setLabelComponents({
      type: ComponentType.Label,
      label: "Message",
      component: input.toJSON(),
    });
}

function buildInvictusDmPanelEmbed(
  targetUserId: string,
  title: string | null,
  description: string | null,
  runtime: BotRuntime,
): EmbedBuilder {
  const panelTitle = (title ?? "").trim() || "Message Invictus";
  const defaultDescription =
    `Press the button below to send a private message to <@${targetUserId}>. `
    + "Invictus will DM your message and include who sent it.";
  const panelDescription = (description ?? "").trim() || defaultDescription;

  return new EmbedBuilder()
    .setTitle(panelTitle)
    .setDescription(panelDescription)
    .setColor(ROLE_COLOR)
    .setTimestamp(runtime.now().toJSDate())
    .setFooter({ text: `${INVICTUS_DM_PANEL_FOOTER_PREFIX}${targetUserId}` });
}

function buildInvictusDmPanelComponents(buttonLabel: string): ActionRowBuilder<ButtonBuilder>[] {
  const trimmedLabel = buttonLabel.trim() || INVICTUS_DM_PANEL_DEFAULT_BUTTON_LABEL;

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(INVICTUS_DM_PANEL_BUTTON_ID)
        .setLabel(trimmedLabel.slice(0, ROLE_PANEL_BUTTON_LABEL_MAX_LENGTH))
        .setStyle(ButtonStyle.Primary),
    ),
  ];
}

function buildInvictusDmPanelModal(targetUserId: string): ModalBuilder {
  const input = new TextInputBuilder()
    .setCustomId(INVICTUS_DM_PANEL_MODAL_INPUT_ID)
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder("Write your message here...")
    .setRequired(true)
    .setMaxLength(2000);

  return new ModalBuilder()
    .setCustomId(`${INVICTUS_DM_PANEL_MODAL_PREFIX}${targetUserId}`)
    .setTitle("Message Invictus")
    .setLabelComponents({
      type: ComponentType.Label,
      label: "Your message",
      component: input.toJSON(),
    });
}

function extractAdminSayContextFromModal(customId: string): { channelId: string; mentionEveryone: boolean } | null {
  if (!customId.startsWith(ADMIN_SAY_MODAL_PREFIX)) {
    return null;
  }

  const payload = customId.slice(ADMIN_SAY_MODAL_PREFIX.length);
  const [channelId, mentionFlag] = payload.split(":", 2);
  if (!channelId || !/^\d+$/.test(channelId)) {
    return null;
  }

  return {
    channelId,
    mentionEveryone: mentionFlag === "1",
  };
}

function parseInvictusDmPanelModalTargetUserId(customId: string): string | null {
  if (!customId.startsWith(INVICTUS_DM_PANEL_MODAL_PREFIX)) {
    return null;
  }

  const targetUserId = customId.slice(INVICTUS_DM_PANEL_MODAL_PREFIX.length).trim();
  if (!/^\d+$/.test(targetUserId)) {
    return null;
  }

  return targetUserId;
}

function parseAnonymousAnswerMessageId(customId: string): string | null {
  if (!customId.startsWith(ANON_MODAL_PREFIX)) {
    return null;
  }

  const messageId = customId.slice(ANON_MODAL_PREFIX.length).trim();
  if (!/^\d+$/.test(messageId)) {
    return null;
  }

  return messageId;
}

function minimumAgeRequirementError(
  nowUtc: DateTime,
  subjectTime: Date | null,
  minimumMinutes: number,
  messagePrefix: string,
): string | null {
  if (minimumMinutes <= 0 || !subjectTime) {
    return null;
  }

  const subjectUtc = DateTime.fromJSDate(subjectTime, { zone: "utc" });
  const elapsedMs = nowUtc.diff(subjectUtc).toMillis();
  const requiredMs = Duration.fromObject({ minutes: minimumMinutes }).toMillis();
  if (elapsedMs >= requiredMs) {
    return null;
  }

  const remaining = Duration.fromMillis(Math.max(requiredMs - elapsedMs, 0));
  return `${messagePrefix}Try again in \`${formatDuration(remaining)}\`.`;
}

function remainingAnonymousCooldownSeconds(userId: string, runtime: BotRuntime): number {
  if (runtime.config.anonCooldownSeconds <= 0) {
    return 0;
  }

  const lastAnswerAt = parseIso(runtime.storage.getLastAnswerTimeForUser(userId));
  if (!lastAnswerAt) {
    return 0;
  }

  const elapsedSeconds = Math.floor(DateTime.utc().diff(lastAnswerAt.toUTC()).as("seconds"));
  return Math.max(runtime.config.anonCooldownSeconds - elapsedSeconds, 0);
}

function validateAnonymousAnswerSubmission(member: GuildMember, answerText: string, runtime: BotRuntime): string | null {
  const requiredRoleId = runtime.config.anonRequiredRoleIdText;
  if (requiredRoleId && !member.roles.cache.has(requiredRoleId)) {
    return "You are not eligible to submit anonymous court answers yet.";
  }

  const nowUtc = DateTime.utc();

  const accountAgeError = minimumAgeRequirementError(
    nowUtc,
    member.user.createdAt,
    runtime.config.anonMinAccountAgeMinutes,
    "Your account is too new to use anonymous answers. ",
  );
  if (accountAgeError) {
    return accountAgeError;
  }

  const memberAgeError = minimumAgeRequirementError(
    nowUtc,
    member.joinedAt,
    runtime.config.anonMinMemberAgeMinutes,
    "You need more time in this server before using anonymous answers. ",
  );
  if (memberAgeError) {
    return memberAgeError;
  }

  const cooldownRemainingSeconds = remainingAnonymousCooldownSeconds(member.id, runtime);
  if (cooldownRemainingSeconds > 0) {
    const remaining = Duration.fromObject({ seconds: cooldownRemainingSeconds });
    return `You are on cooldown for anonymous answers. Try again in \`${formatDuration(remaining)}\`.`;
  }

  if (!runtime.config.anonAllowLinks && URL_PATTERN.test(answerText)) {
    return "Links are currently disabled for anonymous answers.";
  }

  return null;
}

async function handleRolePanelButtonInteraction(interaction: ButtonInteraction, buttonSlot: number): Promise<void> {
  if (!interaction.guild || !interaction.message) {
    await interaction.reply({ content: MSG_USE_IN_SERVER, ephemeral: true });
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) {
    await interaction.reply({ content: MSG_VERIFY_ROLES, ephemeral: true });
    return;
  }

  const footerTexts = interaction.message.embeds.map((embed) => String(embed.footer?.text ?? ""));
  const roleId = extractRolePanelRoleIdForSlot(footerTexts, buttonSlot);
  if (!roleId) {
    await interaction.reply({ content: "This role panel is missing role metadata.", ephemeral: true });
    return;
  }

  const roleIdText = String(roleId);
  const role = interaction.guild.roles.cache.get(roleIdText) ?? (await interaction.guild.roles.fetch(roleIdText).catch(() => null));
  if (!role) {
    await interaction.reply({ content: "The configured role no longer exists.", ephemeral: true });
    return;
  }

  const me = interaction.guild.members.me ?? (await interaction.guild.members.fetchMe().catch(() => null));
  const permissionError = getRolePanelClaimPermissionError(role, me);
  if (permissionError) {
    await interaction.reply({ content: permissionError, ephemeral: true });
    return;
  }

  const [successMessage, errorMessage] = await toggleRoleForMember(member, role, interaction.message.id);
  if (errorMessage) {
    await interaction.reply({ content: errorMessage, ephemeral: true });
    return;
  }

  await interaction.reply({ content: successMessage ?? "Role updated.", ephemeral: true });
}

async function handleInvictusDmPanelButtonInteraction(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild || !interaction.message) {
    await interaction.reply({ content: MSG_USE_IN_SERVER, ephemeral: true });
    return;
  }

  const footerTexts = interaction.message.embeds.map((embed) => String(embed.footer?.text ?? ""));
  const targetUserId = extractInvictusDmPanelTargetUserId(footerTexts);
  if (!targetUserId) {
    await interaction.reply({ content: "This DM panel is missing recipient metadata.", ephemeral: true });
    return;
  }

  await interaction.showModal(buildInvictusDmPanelModal(targetUserId));
}

function extractInvictusDmPanelTargetUserId(footerTexts: string[]): string | null {
  for (const footerText of footerTexts) {
    if (!footerText.startsWith(INVICTUS_DM_PANEL_FOOTER_PREFIX)) {
      continue;
    }

    const targetUserId = footerText.slice(INVICTUS_DM_PANEL_FOOTER_PREFIX.length).trim();
    if (/^\d+$/.test(targetUserId)) {
      return targetUserId;
    }
  }

  return null;
}

function getRolePanelClaimPermissionError(role: Role, me: GuildMember | null): string | null {
  if (role.managed || role.id === role.guild.id) {
    return "This role cannot be self-assigned from this panel.";
  }

  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return "I need Manage Roles permission to manage this role.";
  }

  if (me.roles.highest.comparePositionTo(role) <= 0) {
    return "I cannot manage this role because it is above or equal to my top role.";
  }

  return null;
}

async function toggleRoleForMember(
  member: GuildMember,
  role: Role,
  messageId: string,
): Promise<[string | null, string | null]> {
  const hasRole = member.roles.cache.has(role.id);

  if (hasRole) {
    try {
      await member.roles.remove(role, `Self-removed via role panel (${messageId})`);
    } catch {
      return [null, "I do not have permission to remove this role."];
    }

    return [`Removed ${role.toString()}.`, null];
  }

  try {
    await member.roles.add(role, `Self-assigned via role panel (${messageId})`);
  } catch {
    return [null, "I do not have permission to grant this role."];
  }

  return [`You now have ${role.toString()}.`, null];
}

async function resolveCourtPostMessageForModal(
  interaction: ModalSubmitInteraction,
  postRecord: PostRecord | null,
  questionMessageId: string,
): Promise<Message | null> {
  if (interaction.message?.id === questionMessageId) {
    return interaction.message;
  }

  if (!postRecord) {
    return null;
  }

  return getPostMessage(interaction.client, postRecord);
}

function makeThreadName(question: string): string {
  const cleaned = question
    .split("")
    .filter((character) => /[a-zA-Z0-9\s\-_]/.test(character))
    .join("")
    .trim();
  const normalized = cleaned.split(/\s+/).join("-");
  const name = normalized ? `court-${normalized}` : "court-replies";
  return name.slice(0, 100);
}

async function getOrCreateAnswerThread(
  message: Message,
  question: string,
  runtime: BotRuntime,
  interaction?: ChatInputCommandInteraction,
): Promise<AnyThreadChannel | null> {
  if (!message.guild) {
    return null;
  }

  const cached = message.guild.channels.cache.get(message.id);
  if (cached?.isThread()) {
    runtime.storage.updatePostThreadId(message.id, cached.id);
    return cached;
  }

  const existingRecord = runtime.storage.getPostRecord(message.id);
  if (existingRecord?.thread_id) {
    const fetched = await fetchChannelById(message.client, existingRecord.thread_id);
    if (fetched?.isThread()) {
      runtime.storage.updatePostThreadId(message.id, fetched.id);
      return fetched;
    }
  }

  const fetchedByMessageId = await fetchChannelById(message.client, message.id);
  if (fetchedByMessageId?.isThread()) {
    runtime.storage.updatePostThreadId(message.id, fetchedByMessageId.id);
    return fetchedByMessageId;
  }

  const thread = await message
    .startThread({
      name: makeThreadName(question || MSG_UNKNOWN_QUESTION),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    })
    .catch(async () =>
      message
        .startThread({
          name: makeThreadName(question || MSG_UNKNOWN_QUESTION),
        })
        .catch(() => null),
    );

  if (!thread) {
    return null;
  }

  runtime.storage.updatePostThreadId(message.id, thread.id);

  await thread
    .send(
      "**Anonymous Court Replies**\n"
        + "- One anonymous answer per person\n"
        + "- Stay on topic\n"
        + "- Anonymous does not mean consequence-free\n"
        + `- This thread will close automatically after ${THREAD_CLOSE_HOURS} hours`,
    )
    .catch(() => null);

  if (interaction) {
    await sendLog(
      interaction,
      runtime,
      "Court Thread Created",
      `**By:** ${interaction.user.toString()}\n**Question Message ID:** \`${message.id}\`\n**Thread:** ${thread.toString()}`,
    );
  }

  return thread;
}

async function getTargetChannel(
  interaction: ChatInputCommandInteraction,
  runtime: BotRuntime,
): Promise<TextChannel | null> {
  if (!interaction.guild) {
    return null;
  }

  const state = runtime.storage.getState();
  const candidates = [
    runtime.config.courtChannelIdText,
    String(state.channel_id ?? "").trim(),
    String(runtime.config.courtChannelId ?? "").trim(),
  ];

  for (const candidate of candidates) {
    if (!/^\d+$/.test(candidate) || candidate === "0") {
      continue;
    }

    const cached = interaction.guild.channels.cache.get(candidate);
    if (cached instanceof TextChannel) {
      return cached;
    }

    const fetched = await interaction.guild.channels.fetch(candidate).catch(() => null);
    if (fetched instanceof TextChannel) {
      return fetched;
    }
  }

  return null;
}

async function getLogChannel(
  interaction: ChatInputCommandInteraction,
  runtime: BotRuntime,
): Promise<TextChannel | null> {
  if (!interaction.guild) {
    return null;
  }

  const state = runtime.storage.getState();
  const candidates = [
    runtime.config.logChannelIdText,
    String(state.log_channel_id ?? "").trim(),
    String(runtime.config.logChannelId ?? "").trim(),
  ];

  for (const candidate of candidates) {
    if (!/^\d+$/.test(candidate) || candidate === "0") {
      continue;
    }

    const cached = interaction.guild.channels.cache.get(candidate);
    if (cached instanceof TextChannel) {
      return cached;
    }

    const fetched = await interaction.guild.channels.fetch(candidate).catch(() => null);
    if (fetched instanceof TextChannel) {
      return fetched;
    }
  }

  return null;
}

async function sendLog(
  interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
  runtime: BotRuntime,
  title: string,
  description: string,
): Promise<void> {
  if (!interaction.guild) {
    return;
  }

  const state = runtime.storage.getState();
  const logChannelCandidates = [
    runtime.config.logChannelIdText,
    String(state.log_channel_id ?? "").trim(),
    String(runtime.config.logChannelId ?? "").trim(),
  ];

  let destination: TextChannel | AnyThreadChannel | null = null;
  for (const candidate of logChannelCandidates) {
    if (!/^\d+$/.test(candidate) || candidate === "0") {
      continue;
    }

    const fetched = await fetchChannelById(interaction.client, candidate);
    if (fetched instanceof TextChannel || fetched?.isThread()) {
      destination = fetched;
      break;
    }
  }

  if (!destination) {
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(ROLE_COLOR)
    .setTimestamp(runtime.now().toJSDate());

  await destination.send({ embeds: [embed] }).catch(() => null);
}

async function fetchChannelById(client: ChatInputCommandInteraction["client"], channelId: string): Promise<Channel | null> {
  if (!/^\d+$/.test(channelId)) {
    return null;
  }

  const cached = client.channels.cache.get(channelId);
  if (cached) {
    return cached;
  }

  return client.channels.fetch(channelId).catch(() => null);
}

async function fetchThreadById(
  interaction: ChatInputCommandInteraction,
  threadId: string | null | undefined,
): Promise<AnyThreadChannel | null> {
  if (!threadId) {
    return null;
  }

  const fetched = await fetchChannelById(interaction.client, threadId);
  if (fetched?.isThread()) {
    return fetched;
  }

  return null;
}

async function getPostMessage(client: ChatInputCommandInteraction["client"], record: PostRecord): Promise<Message | null> {
  const channel = await fetchChannelById(client, record.channel_id);
  if (!channel?.isTextBased()) {
    return null;
  }

  const textTarget = channel as TextChannel | AnyThreadChannel;
  return textTarget.messages.fetch(record.message_id).catch(() => null);
}

export async function __scanBackfillHistoryTargetForTests(
  target: unknown,
  afterTimestamp: number | null,
  messageCounts: Record<number, number>,
  reactionsSentCounts: Record<number, number>,
  reactionsReceivedCounts: Record<number, number>,
): Promise<[number, number]> {
  return scanBackfillHistoryTarget(
    target as TextChannel | AnyThreadChannel,
    afterTimestamp,
    messageCounts,
    reactionsSentCounts,
    reactionsReceivedCounts,
  );
}
