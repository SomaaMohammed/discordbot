import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
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
    await interaction.reply({
      content:
        "That greeting profile is unavailable. Choose one from autocomplete.",
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }
  if (!runtime.isCurrent()) {
    await interaction.reply({
      content: "This server was disabled or reconfigured. Please try again.",
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }
  const content = truncateDiscordContent(
    renderGreetingMessage(profile.message, interaction.user.id),
  );
  await interaction.reply({
    content,
    allowedMentions: { parse: [], users: [interaction.user.id] },
  });
  runtime.storage.recordCommandMetric("greetings.send");
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
  if (
    !guildRuntime?.settings.enabled ||
    guildRuntime.settings.reviewRequired ||
    !guildRuntime.settings.features.greetings ||
    !guildRuntime.isCurrent()
  ) {
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
