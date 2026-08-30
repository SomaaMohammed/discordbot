import {
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type SlashCommandOptionsOnlyBuilder,
  type SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import { logInfo } from "../logging.js";
import type { BotRuntime, GuildRuntime } from "../runtime.js";
import { handleActivityCommand, handleFunCommand } from "./activity.js";
import { buildActivityCommandDefinition } from "./activity-command.js";
import {
  handleGreetingAutocomplete,
  handleGreetingCommand,
} from "./greetings.js";
import { handleModerationCommand } from "./moderation.js";
import {
  handlePanelButton,
  handlePanelCommand,
  handlePanelModal,
} from "./panels.js";
import { buildPanelCommandDefinition } from "./panel-command.js";
import { buildChannelCommandDefinition } from "./channel-command.js";
import {
  handlePanelHelpCommand,
  handlePresetPanelCommand,
  panelCapabilityForOperation,
} from "./preset-panels.js";
import {
  handleVotingPanelButton,
  handleVotingPanelCommand,
} from "./voting-interactions.js";
import {
  buildConfigCommandDefinition,
  buildDataCommandDefinition,
  handleConfigCommand,
  handleDataCommand,
  requireConfigurationAdmin,
} from "./setup.js";
import {
  buildUtilityCommandDefinition,
  handleUtilityCommand,
} from "./utilities.js";
import { buildAccessCommandDefinition } from "./access-command.js";
import { handleAccessCommand } from "./access-commands-handler.js";
import { buildSuggestionCommandDefinition } from "./suggestion-command.js";
import { handleSuggestionCommand } from "./suggestion-commands-handler.js";
import {
  handleSuggestionButton,
  handleSuggestionModal,
} from "./suggestion-interactions.js";
import { buildApplicationCommandDefinition } from "./application-command.js";
import {
  handleApplicationAutocomplete,
  handleApplicationCommand,
} from "./application-commands-handler.js";
import {
  handleApplicationButton,
  handleApplicationModal,
  handleApplicationSelect,
} from "./application-interactions.js";
import {
  authorizeCapability,
  fetchVerifiedGuildMember,
} from "./authorization.js";
import type { GuildCapability } from "./capabilities.js";
import { getInteractionLifecycle } from "./interaction-lifecycle.js";
import { evaluateGuildManagement } from "./ticket-authorization.js";
import { buildTicketCommandDefinition } from "./ticket-command.js";
import {
  handleTicketCommand,
  handleTicketRecoveryCommand,
} from "./ticket-commands-handler.js";
import {
  handleTicketButton,
  handleTicketModal,
  handleTicketSelect,
} from "./ticket-interactions.js";
import {
  buildPingRoleCommandDefinition,
  buildRestrictedPingCommandDefinition,
} from "./restricted-ping-command.js";
import {
  handlePingRoleCommand,
  handleRestrictedPingCommand,
} from "./restricted-ping-commands-handler.js";
import { buildModerationCommandDefinition } from "./moderation-command.js";
import { handleModerationCaseCommand } from "./moderation-commands-handler.js";
import { buildTimeoutCommandDefinition } from "./timeout-command.js";
import { buildReportCommandDefinition } from "./report-command.js";
import { handleReportCommand } from "./report-commands-handler.js";
import {
  handleReportButton,
  handleReportModal,
} from "./report-interactions.js";
import { buildAppealCommandDefinition } from "./appeal-command.js";
import { handleAppealCommand } from "./appeal-commands-handler.js";
import {
  handleAppealButton,
  handleAppealModal,
} from "./appeal-interactions.js";
import { buildAutomodCommandDefinition } from "./automod-command.js";
import { handleAutomodCommand } from "./automod-commands-handler.js";
import { buildOnboardingCommandDefinition } from "./onboarding-command.js";
import { handleOnboardingCommand } from "./onboarding-commands-handler.js";
import { buildRoleMenuCommandDefinition } from "./role-menu-command.js";
import { handleRoleMenuCommand } from "./role-menu-commands-handler.js";
import { handleVerificationButton } from "./verification-interactions.js";
import { handleRoleMenuSelect } from "./role-menu-interactions.js";
import {
  buildOperatorCommandDefinition,
  handleOperatorCommand,
} from "./operator-command.js";
export function buildCommandDefinitions(): Array<
  | SlashCommandBuilder
  | SlashCommandOptionsOnlyBuilder
  | SlashCommandSubcommandsOnlyBuilder
> {
  const fun = new SlashCommandBuilder()
    .setName("fun")
    .setDescription("Lightweight member games")
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
    buildConfigCommandDefinition(),
    buildDataCommandDefinition(),
    buildOperatorCommandDefinition(),
    buildHelpCommandDefinition(),
    buildChannelCommandDefinition(),
    buildTimeoutCommandDefinition(),
    buildActivityCommandDefinition(),
    buildPanelCommandDefinition(),
    buildTicketCommandDefinition(),
    buildSuggestionCommandDefinition(),
    buildApplicationCommandDefinition(),
    buildModerationCommandDefinition(),
    buildReportCommandDefinition(),
    buildAppealCommandDefinition(),
    buildAutomodCommandDefinition(),
    buildOnboardingCommandDefinition(),
    buildRoleMenuCommandDefinition(),
    buildAccessCommandDefinition(),
    buildPingRoleCommandDefinition(),
    buildRestrictedPingCommandDefinition(),
    buildUtilityCommandDefinition(),
    fun,
    greetings,
  ];
}

export function buildHelpCommandDefinition(): SlashCommandOptionsOnlyBuilder {
  return new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show command groups and practical next steps")
    .setDMPermission(false);
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
  if (command !== "pingrole" && command !== "help" && !subcommand) {
    await replyPrivate(interaction, "Choose a supported subcommand.");
    return;
  }
  let guildRuntime = await runtime.forGuild(interaction.guildId);
  if (command === "operator") {
    await deferPrivate(interaction);
    await handleOperatorCommand(interaction, runtime, guildRuntime);
    return;
  }
  if (command === "config" || command === "data") {
    await deferPrivate(interaction);
    const actor = await requireConfigurationAdmin(interaction);
    if (!actor) return;
    if (!guildRuntime) {
      runtime.storage.ensureGuild(interaction.guildId, interaction.guild.name);
      guildRuntime = await runtime.forGuild(interaction.guildId);
    }
    if (!guildRuntime) {
      await replyPrivate(
        interaction,
        "Could not initialize Superior for this server.",
      );
      return;
    }
    if (command === "config") {
      await handleConfigCommand(interaction, runtime, guildRuntime, actor);
    } else {
      await handleDataCommand(interaction, runtime, guildRuntime, actor);
    }
    return;
  }
  if (!guildRuntime?.settings.enabled) {
    logInteractionRejection(interaction, "guild-state", "explicitly-disabled");
    await replyPrivate(
      interaction,
      "Superior is disabled by the server's emergency bot-state switch. An owner or Administrator can restore it with `/config bot-state enabled:true`.",
    );
    return;
  }
  if (!guildRuntime.isCurrent()) {
    logInteractionRejection(interaction, "guild-state", "stale-runtime");
    await replyPrivate(
      interaction,
      "This server was disabled or reconfigured. Please try again.",
    );
    return;
  }
  if (command === "help") {
    await handleHelp(interaction);
    guildRuntime.storage.recordCommandMetric("help.overview");
    return;
  }
  if (command === "pingrole") {
    await handlePingRoleCommand(interaction, guildRuntime);
    return;
  }
  if (!subcommand) {
    await replyPrivate(interaction, "Choose a supported subcommand.");
    return;
  }
  if (command === "restrictedping") {
    await handleRestrictedPingCommand(interaction, guildRuntime);
    return;
  }
  if (command === "access") {
    await handleAccessCommand(interaction, guildRuntime);
    return;
  }
  if (command === "suggestion") {
    await handleSuggestionCommand(interaction, guildRuntime);
    return;
  }
  if (command === "application") {
    await handleApplicationCommand(interaction, guildRuntime);
    return;
  }
  if (command === "report") {
    await handleReportCommand(interaction, guildRuntime);
    return;
  }
  if (command === "appeal") {
    await handleAppealCommand(interaction, guildRuntime);
    return;
  }
  if (command === "moderation") {
    await handleModerationCaseCommand(interaction, guildRuntime);
    return;
  }
  if (command === "automod") {
    await handleAutomodCommand(interaction, guildRuntime);
    return;
  }
  if (command === "onboarding" || command === "rolemenu") {
    const actor = await requireCapability(
      interaction,
      guildRuntime,
      command === "onboarding" ? "onboarding.configure" : "roles.configure",
    );
    if (!actor) return;
    if (
      (command === "onboarding" && subcommand === "panel") ||
      (command === "rolemenu" &&
        (subcommand === "post" || subcommand === "recover"))
    ) {
      await deferPublic(interaction);
    } else {
      await deferPrivate(interaction);
    }
    if (command === "onboarding") {
      await handleOnboardingCommand(interaction, guildRuntime, actor);
    } else {
      await handleRoleMenuCommand(interaction, guildRuntime, actor);
    }
    return;
  }
  if (command === "utility") {
    await handleUtilityCommand(interaction, guildRuntime);
    return;
  }
  if (command === "greetings") {
    await handleGreetingCommand(interaction, guildRuntime);
    return;
  }
  if (command === "fun") {
    await handleFunCommand(interaction, guildRuntime);
    return;
  }
  if (command === "activity") {
    if (subcommand === "stats" || subcommand === "leaderboard") {
      await handleFunCommand(interaction, guildRuntime);
      return;
    }
    await deferPrivate(interaction);
    const actor = await requireAdministrator(interaction, guildRuntime);
    if (!actor) return;
    await handleActivityCommand(interaction, guildRuntime);
    return;
  }
  if (command === "panel" && subcommand === "vote") {
    await handleVotingPanelCommand(interaction, guildRuntime);
    return;
  }
  if (command === "panel" && subcommand === "help") {
    await handlePanelHelpCommand(interaction, guildRuntime);
    return;
  }
  if (
    command === "panel" &&
    ["dmpanel", "role-button", "role-buttons"].includes(subcommand)
  ) {
    const actor = await requireAdministrator(interaction, guildRuntime);
    if (!actor) return;
    await deferPublic(interaction);
    await handlePanelCommand(interaction, guildRuntime, actor);
    return;
  }
  if (command === "channel") {
    const actor = await requireAdministrator(interaction, guildRuntime);
    if (!actor) return;
    await deferPrivate(interaction);
    if (subcommand === "announce") {
      await handlePanelCommand(interaction, guildRuntime, actor);
    } else {
      await handleModerationCommand(interaction, guildRuntime, actor);
    }
    return;
  }
  if (command === "timeout") {
    const actor = await requireAdministrator(interaction, guildRuntime);
    if (!actor) return;
    await deferPrivate(interaction);
    await handleModerationCommand(interaction, guildRuntime, actor);
    return;
  }
  if (command === "ticket" && subcommand === "recover") {
    await deferPrivate(interaction);
    await handleTicketRecoveryCommand(interaction, guildRuntime);
    return;
  }
  if (command === "panel" || command === "ticket") {
    const capability: GuildCapability =
      command === "panel"
        ? panelCapabilityForOperation(
            subcommand,
            subcommand === "post"
              ? interaction.options.getString("preset", false)
              : null,
          )
        : "tickets.configure";
    const actor = await requireCapability(
      interaction,
      guildRuntime,
      capability,
    );
    if (!actor) return;
    if (command === "panel" || subcommand === "panel") {
      await deferPublic(interaction);
    } else {
      await deferPrivate(interaction);
    }
    if (command === "panel") {
      await handlePresetPanelCommand(interaction, guildRuntime, actor);
    } else {
      await handleTicketCommand(interaction, guildRuntime, actor);
    }
    return;
  }
  await replyPrivate(interaction, "Unknown command family or subcommand.");
}

async function requireCapability(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  capability: GuildCapability,
): Promise<GuildMember | null> {
  const guild = interaction.guild;
  if (!guild || guild.id !== runtime.guildId) return null;
  const decision = await authorizeCapability({
    guild,
    userId: interaction.user.id,
    capability,
    grants: runtime.storage,
  });
  if (!decision.allowed) {
    logInteractionRejection(
      interaction,
      `capability:${capability}`,
      decision.reason,
    );
    await replyPrivate(
      interaction,
      decision.reason === "member-unavailable" ||
        decision.reason === "guild-mismatch"
        ? "Could not verify your current server membership."
        : `You need the \`${capability}\` capability to use that operation.`,
    );
    return null;
  }
  return decision.member;
}

export async function handleAutocompleteInteraction(
  interaction: AutocompleteInteraction,
  runtime: BotRuntime,
): Promise<void> {
  if (await handleApplicationAutocomplete(interaction, runtime)) return;
  await handleGreetingAutocomplete(interaction, runtime);
}

export async function handleButtonInteraction(
  interaction: ButtonInteraction,
  runtime: BotRuntime,
): Promise<void> {
  const guildRuntime = await getCurrentComponentRuntime(interaction, runtime);
  if (!guildRuntime) return;
  if (await handleVerificationButton(interaction, guildRuntime)) return;
  if (await handleReportButton(interaction, guildRuntime)) return;
  if (await handleAppealButton(interaction, guildRuntime)) return;
  if (await handleApplicationButton(interaction, guildRuntime)) return;
  if (await handleSuggestionButton(interaction, guildRuntime)) return;
  if (await handleTicketButton(interaction, guildRuntime)) return;
  if (await handleVotingPanelButton(interaction, guildRuntime)) return;
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
  if (await handleReportModal(interaction, guildRuntime)) return;
  if (await handleAppealModal(interaction, guildRuntime)) return;
  if (await handleApplicationModal(interaction, guildRuntime)) return;
  if (await handleSuggestionModal(interaction, guildRuntime)) return;
  if (await handleTicketModal(interaction, guildRuntime)) return;
  if (await handlePanelModal(interaction, guildRuntime)) return;
  await replyPrivate(
    interaction,
    "This form is outdated or unsupported. Ask an administrator to post the panel again.",
  );
}

export async function handleStringSelectMenuInteraction(
  interaction: StringSelectMenuInteraction,
  runtime: BotRuntime,
): Promise<void> {
  const guildRuntime = await getCurrentComponentRuntime(interaction, runtime);
  if (!guildRuntime) return;
  if (await handleRoleMenuSelect(interaction, guildRuntime)) return;
  if (await handleApplicationSelect(interaction, guildRuntime)) return;
  if (await handleTicketSelect(interaction, guildRuntime)) return;
  await replyPrivate(
    interaction,
    "This selection is outdated or unsupported. Ask an administrator to refresh its panel.",
  );
}

async function getCurrentComponentRuntime(
  interaction:
    ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction,
  runtime: BotRuntime,
): Promise<GuildRuntime | null> {
  if (
    !interaction.guild ||
    !interaction.guildId ||
    interaction.guild.id !== interaction.guildId
  ) {
    logInteractionRejection(interaction, "component-context", "guild-mismatch");
    await replyPrivate(
      interaction,
      "Use this interaction inside its original server.",
    );
    return null;
  }
  const guildRuntime = await runtime.forGuild(interaction.guildId);
  if (!guildRuntime?.settings.enabled || !guildRuntime.isCurrent()) {
    logInteractionRejection(
      interaction,
      "component-context",
      "inactive-or-disabled",
    );
    await replyPrivate(
      interaction,
      "This server is currently inactive or disabled.",
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
  const verified = await fetchVerifiedGuildMember(guild, interaction.user.id);
  const actor = verified.member;
  if (!verified.valid || !actor || actor.guild.id !== runtime.guildId) {
    logInteractionRejection(interaction, "administrator", "member-unavailable");
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
    logInteractionRejection(interaction, "administrator", "permission-denied");
    await replyPrivate(
      interaction,
      "Only the server owner or an Administrator can use that command.",
    );
    return null;
  }
  return actor;
}

function logInteractionRejection(
  interaction:
    | ButtonInteraction
    | ChatInputCommandInteraction
    | ModalSubmitInteraction
    | StringSelectMenuInteraction,
  boundary: string,
  reason: string,
): void {
  const lifecycle = getInteractionLifecycle(interaction);
  if (!lifecycle) return;
  logInfo("authorization", "Interaction was rejected by a current boundary", {
    correlationId: lifecycle.correlationId,
    operation: lifecycle.operation,
    guildId: interaction.guildId ?? "dm",
    boundary,
    reason,
    outcome: "rejected",
  });
}

async function handleHelp(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await replyPrivate(interaction, buildCommandGuide());
}

export function buildCommandGuide(): string {
  return [
    "**Superior command guide**",
    "`/pingrole role:@Role` - safely notify a configured role in its allowed channel",
    "`/restrictedping` - owner/Administrator restricted-role mapping and cooldown configuration",
    "`/config` — optional Administrator settings and explicit emergency bot-state control",
    "`/data` — owner-controlled format-8 export, formats 2-8 import, and purge",
    "`/access` — owner/Administrator grants and status for delegated role capabilities",
    "`/panel` — create and inspect preset, private-message, role, and voting panels",
    "`/ticket` — delegated department, form, routing, launcher, health, and recovery tools",
    "`/suggestion` — member submissions, status, withdrawal, configuration, review, panels, and recovery",
    "`/application` — private submissions, status, and withdrawal plus delegated forms, review, panels, and recovery",
    "`/moderation` — persistent cases, member sanctions, history, configuration, and log recovery",
    "`/report` — private member reports, status, withdrawal, and authorized recovery",
    "`/appeal` — in-guild case appeals, status, withdrawal, and authorized recovery",
    "`/automod` — narrow configurable anti-spam rules, exemptions, and safe synthetic tests",
    "`/onboarding` — delegated welcome, farewell, rules, verification, autorole, status, and recovery tools",
    "`/rolemenu` — delegated persistent safe self-service role-menu configuration and recovery",
    "`/channel` — Administrator announcements, cleanup, locks, and slowmode",
    "`/timeout` — Administrator single-member and bounded bulk timeout tools",
    "`/activity` — activity totals, leaderboards, and Administrator backfills",
    "`/help` — this command overview",
    "`/utility` — private member/server/role/channel/ID/time information",
    "`/fun` — lightweight member battles",
    "`/greetings send` — greet the person invoking the command",
    "Natural chat responds only to a leading/trailing configured invocation, a bot mention, or a direct reply to Superior.",
  ].join("\n");
}

async function replyPrivate(
  interaction:
    | ChatInputCommandInteraction
    | ButtonInteraction
    | ModalSubmitInteraction
    | StringSelectMenuInteraction,
  content: string,
): Promise<void> {
  if (interaction.deferred && !interaction.replied) {
    await interaction.editReply({ content, allowedMentions: { parse: [] } });
    return;
  }
  if (interaction.replied) {
    await interaction.followUp({
      content,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }
  await interaction.reply({
    content,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function deferPrivate(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
}

async function deferPublic(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply();
  }
}
