import {
  MessageFlags,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type MessageMentionOptions,
} from "discord.js";
import {
  renderGreetingMessage,
  truncateDiscordContent,
} from "../greeting-message.js";
import type { BotRuntime, GuildRuntime } from "../runtime.js";

export async function handleGreetingCommand(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const requested = interaction.options.getString("profile", true);
  const profile = runtime.settings.greetings.find(
    ({ name }) => name.toLocaleLowerCase() === requested.toLocaleLowerCase(),
  );
  if (!profile) {
    await respondGreeting(
      interaction,
      "That greeting profile is unavailable. Choose one from autocomplete.",
      true,
    );
    return;
  }
  if (!runtime.isCurrent()) {
    await respondGreeting(
      interaction,
      "This server was disabled or reconfigured. Please try again.",
      true,
    );
    return;
  }
  const content = truncateDiscordContent(
    renderGreetingMessage(profile.message, interaction.user.id),
  );
  await respondGreeting(interaction, content, false, interaction.user.id);
  runtime.storage.recordCommandMetric("greetings.send");
}

async function respondGreeting(
  interaction: ChatInputCommandInteraction,
  content: string,
  privateResponse: boolean,
  mentionedUserId?: string,
): Promise<void> {
  const allowedMentions: MessageMentionOptions = mentionedUserId
    ? { parse: [], users: [mentionedUserId] }
    : { parse: [] };
  if (interaction.deferred && !interaction.replied) {
    await interaction.editReply({ content, allowedMentions });
    return;
  }
  if (interaction.replied) {
    await interaction.followUp({
      content,
      ...(privateResponse ? { flags: MessageFlags.Ephemeral } : {}),
      allowedMentions,
    });
    return;
  }
  await interaction.reply({
    content,
    ...(privateResponse ? { flags: MessageFlags.Ephemeral } : {}),
    allowedMentions,
  });
}

export async function handleGreetingAutocomplete(
  interaction: AutocompleteInteraction,
  runtime: BotRuntime,
): Promise<void> {
  if (
    interaction.commandName !== "greetings" ||
    !interaction.guild ||
    !interaction.guildId ||
    interaction.guild.id !== interaction.guildId
  ) {
    await interaction.respond([]);
    return;
  }
  const guildRuntime = await runtime.forGuild(interaction.guildId);
  if (!guildRuntime?.settings.enabled || !guildRuntime.isCurrent()) {
    await interaction.respond([]);
    return;
  }
  const focused = String(interaction.options.getFocused() ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase();
  await interaction.respond(
    guildRuntime.settings.greetings
      .filter(({ name }) => name.toLocaleLowerCase().includes(focused))
      .slice(0, 25)
      .map(({ name }) => ({ name, value: name })),
  );
}
