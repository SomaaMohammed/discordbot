import {
  Client,
  GatewayIntentBits,
  Partials,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type ModalSubmitInteraction,
} from "discord.js";
import {
  buildCommandDefinitions,
  handleButtonInteraction,
  handleChatInputCommand,
  handleModalSubmitInteraction,
} from "./commands.js";
import { wireRuntimeParity } from "./runtime-parity.js";
import type { BotRuntime } from "../runtime.js";

export function createDiscordClient(runtime: BotRuntime): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction],
  });

  wireRuntimeParity(client, runtime);

  client.once("clientReady", async () => {
    const me = client.user;
    console.log(
      `Logged in as ${me?.tag ?? "unknown"} | version=${runtime.config.botVersion}`,
    );

    const guild = await client.guilds
      .fetch(runtime.config.testGuildIdText)
      .catch(() => null);
    if (!guild) {
      console.warn(
        `Failed to fetch guild ${runtime.config.testGuildIdText}. Commands were not synced.`,
      );
      return;
    }

    const commandDefinitions = buildCommandDefinitions().map((definition) =>
      definition.toJSON(),
    );
    const synced = await guild.commands
      .set(commandDefinitions)
      .catch((error) => {
        console.error("Command sync failed", error);
        return null;
      });

    if (synced) {
      console.log(
        `Synced ${synced.size} command(s) to guild ${runtime.config.testGuildIdText}`,
      );
    }
  });

  client.on("interactionCreate", async (interaction: Interaction) => {
    if (interaction.isChatInputCommand()) {
      await handleChatCommandInteraction(interaction, runtime);
      return;
    }

    if (interaction.isButton()) {
      await handleButtonComponentInteraction(interaction, runtime);
      return;
    }

    if (interaction.isModalSubmit()) {
      await handleModalInteraction(interaction, runtime);
    }
  });

  return client;
}

async function handleChatCommandInteraction(
  interaction: ChatInputCommandInteraction,
  runtime: BotRuntime,
): Promise<void> {
  try {
    await handleChatInputCommand(interaction, runtime);
  } catch (error) {
    console.error("Command failed", {
      command: interaction.commandName,
      subcommand: interaction.options.getSubcommand(false),
      error,
    });

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({
        content: "The command failed unexpectedly and was logged.",
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      content: "The command failed unexpectedly and was logged.",
      ephemeral: true,
    });
  }
}

async function handleButtonComponentInteraction(
  interaction: ButtonInteraction,
  runtime: BotRuntime,
): Promise<void> {
  try {
    await handleButtonInteraction(interaction, runtime);
  } catch (error) {
    console.error("Button interaction failed", {
      customId: interaction.customId,
      error,
    });

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({
        content: "That interaction failed unexpectedly and was logged.",
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      content: "That interaction failed unexpectedly and was logged.",
      ephemeral: true,
    });
  }
}

async function handleModalInteraction(
  interaction: ModalSubmitInteraction,
  runtime: BotRuntime,
): Promise<void> {
  try {
    await handleModalSubmitInteraction(interaction, runtime);
  } catch (error) {
    console.error("Modal interaction failed", {
      customId: interaction.customId,
      error,
    });

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({
        content: "That interaction failed unexpectedly and was logged.",
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      content: "That interaction failed unexpectedly and was logged.",
      ephemeral: true,
    });
  }
}
