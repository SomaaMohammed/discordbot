import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
  type SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import { logInfo } from "../logging.js";
import type { BotRuntime, GuildRuntime } from "../runtime.js";
import { clearAntiSpamProcessState } from "./anti-spam-enforcement.js";
import { fetchVerifiedGuildMember } from "./authorization.js";

type OperatorState = "enabled" | "disabled";

export function buildOperatorCommandDefinition(): SlashCommandSubcommandsOnlyBuilder {
  return new SlashCommandBuilder()
    .setName("operator")
    .setDescription("Deployment-owner recovery controls")
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("status")
        .setDescription("Show this guild's Superior availability state"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("state")
        .setDescription("Explicitly enable or suspend Superior in this guild")
        .addStringOption((option) =>
          option
            .setName("state")
            .setDescription("Desired Superior state")
            .setRequired(true)
            .addChoices(
              { name: "enabled", value: "enabled" },
              { name: "disabled", value: "disabled" },
            ),
        )
        .addStringOption((option) =>
          option
            .setName("confirmation")
            .setDescription("Type ACTION followed by this guild ID")
            .setRequired(true)
            .setMaxLength(80),
        ),
    );
}

export async function handleOperatorCommand(
  interaction: ChatInputCommandInteraction,
  runtime: BotRuntime,
  existingGuildRuntime: GuildRuntime | null,
): Promise<void> {
  const actor = await requireDeploymentOperator(interaction, runtime);
  if (!actor) return;

  let guildRuntime = existingGuildRuntime;
  if (!guildRuntime) {
    runtime.storage.ensureGuild(interaction.guildId!, interaction.guild!.name);
    guildRuntime = await runtime.forGuild(interaction.guildId!);
  }
  if (!guildRuntime) {
    await replyPrivate(
      interaction,
      "Could not initialize Superior for this server.",
    );
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "status") {
    guildRuntime.storage.recordCommandMetric("operator.status");
    await replyPrivate(
      interaction,
      [
        "**Superior deployment recovery**",
        `Guild state: **${guildRuntime.settings.enabled ? "enabled" : "disabled"}**.`,
        "This control only changes Superior's response in this guild; it does not grant Discord Administrator permissions or expose private guild data.",
      ].join("\n"),
    );
    logOperatorAction(interaction, actor, "status", "completed", runtime);
    return;
  }

  if (subcommand !== "state") {
    await replyPrivate(interaction, "Unknown operator recovery operation.");
    return;
  }

  const state = interaction.options.getString("state", true) as OperatorState;
  const confirmation = interaction.options
    .getString("confirmation", true)
    .trim()
    .toUpperCase();
  const action = state === "disabled" ? "SUSPEND" : "RESUME";
  const expectedConfirmation = `${action} ${guildRuntime.guildId}`;
  if (confirmation !== expectedConfirmation) {
    guildRuntime.storage.recordCommandMetric("operator.state", false);
    logOperatorAction(
      interaction,
      actor,
      state,
      "confirmation-failed",
      runtime,
    );
    await replyPrivate(
      interaction,
      `Confirmation refused. Type exactly \`${expectedConfirmation}\` to apply this change.`,
    );
    return;
  }

  const enabled = state === "enabled";
  if (guildRuntime.settings.enabled === enabled) {
    guildRuntime.storage.recordCommandMetric("operator.state");
    logOperatorAction(interaction, actor, state, "already-in-state", runtime);
    await replyPrivate(
      interaction,
      `Superior is already **${state}** in this guild; no change was made.`,
    );
    return;
  }

  await guildRuntime.setEnabled(enabled);
  if (!enabled) clearAntiSpamProcessState(guildRuntime.guildId);
  guildRuntime.storage.recordCommandMetric("operator.state");
  logOperatorAction(interaction, actor, state, "completed", runtime);
  await replyPrivate(
    interaction,
    enabled
      ? "Superior is enabled again in this guild."
      : "Superior is suspended in this guild. Stored data and panels were retained.",
  );
}

async function requireDeploymentOperator(
  interaction: ChatInputCommandInteraction,
  runtime: BotRuntime,
): Promise<GuildMember | null> {
  const guild = interaction.guild;
  if (!guild || !interaction.guildId || guild.id !== interaction.guildId) {
    await replyPrivate(interaction, "Use this command inside a server.");
    return null;
  }

  if (!runtime.processConfig.operatorIds.includes(interaction.user.id)) {
    logOperatorAction(interaction, null, "authorization", "denied", runtime);
    await replyPrivate(
      interaction,
      "You are not configured as the deployment operator for this bot.",
    );
    return null;
  }

  const verified = await fetchVerifiedGuildMember(guild, interaction.user.id);
  if (!verified.valid || !verified.member) {
    logOperatorAction(
      interaction,
      null,
      "authorization",
      "member-unavailable",
      runtime,
    );
    await replyPrivate(
      interaction,
      "Could not verify your current server membership.",
    );
    return null;
  }
  return verified.member;
}

function logOperatorAction(
  interaction: ChatInputCommandInteraction,
  actor: GuildMember | null,
  action: string,
  outcome: string,
  runtime: BotRuntime,
): void {
  logInfo("operator-recovery", "Deployment recovery command evaluated", {
    guildId: interaction.guildId ?? "dm",
    operatorId: actor?.id ?? interaction.user.id,
    action,
    outcome,
    configuredOperatorCount: runtime.processConfig.operatorIds.length,
  });
}

async function replyPrivate(
  interaction: ChatInputCommandInteraction,
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
