import {
  Client,
  GatewayIntentBits,
  Partials,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type ModalSubmitInteraction,
} from "discord.js";
import {
  buildCommandDefinitions,
  handleAutocompleteInteraction,
  handleButtonInteraction,
  handleChatInputCommand,
  handleModalSubmitInteraction,
} from "./commands.js";
import { logError, logInfo } from "../logging.js";
import {
  startRuntimeBackgroundLoops,
  wireRuntimeParity,
} from "./runtime-parity.js";
import type { BotRuntime } from "../runtime.js";
import { synchronizeCommands } from "./registration.js";

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
    logInfo("discord", "Client ready", {
      userTag: me?.tag ?? "unknown",
      userId: me?.id ?? "unknown",
      version: runtime.processConfig.botVersion,
      guildCount: client.guilds.cache.size,
    });

    const availableGuildIds = new Set<string>();
    for (const guild of client.guilds.cache.values()) {
      availableGuildIds.add(guild.id);
      try {
        recordGuildAvailable(runtime, guild.id, guild.name, {
          startupDiscovery: true,
          observedJoinedAt: guild.joinedAt.toISOString(),
        });
      } catch (error) {
        logError("discord-lifecycle", "Startup guild reconciliation failed", {
          guildId: guild.id,
          error,
        });
      }
    }
    try {
      for (const record of runtime.storage.listActiveGuilds()) {
        if (availableGuildIds.has(record.guildId)) {
          continue;
        }
        try {
          recordGuildUnavailable(runtime, record.guildId);
          logInfo(
            "discord-lifecycle",
            "Offline guild departure reconciled; retained data preserved",
            { guildId: record.guildId },
          );
        } catch (error) {
          logError("discord-lifecycle", "Offline departure reconciliation failed", {
            guildId: record.guildId,
            error,
          });
        }
      }
    } catch (error) {
      logError("discord-lifecycle", "Could not enumerate active guild records", {
        error,
      });
    }

    startRuntimeBackgroundLoops(client, runtime);

    const commandDefinitions = buildCommandDefinitions().map((definition) =>
      definition.toJSON(),
    );
    await synchronizeCommands(
      client,
      runtime.processConfig,
      commandDefinitions,
    ).catch((error) => {
      logError("discord-registration", "Command synchronization failed", {
        mode: runtime.processConfig.commandRegistrationMode,
        error,
      });
    });
  });

  client.on("guildCreate", (guild) => {
    try {
      const { record, rejoined } = recordGuildAvailable(
        runtime,
        guild.id,
        guild.name,
        { observedJoinedAt: guild.joinedAt.toISOString() },
      );
      logInfo("discord-lifecycle", "Guild availability recorded", {
        guildId: guild.id,
        guildName: guild.name,
        enabled: record.enabled,
        rejoined,
      });
    } catch (error) {
      logError("discord-lifecycle", "Guild join reconciliation failed", {
        guildId: guild.id,
        error,
      });
    }
  });

  client.on("guildDelete", (guild) => {
    try {
      recordGuildUnavailable(runtime, guild.id);
      logInfo("discord-lifecycle", "Guild marked inactive; retained data preserved", {
        guildId: guild.id,
        guildName: guild.name,
      });
    } catch (error) {
      logError("discord-lifecycle", "Guild departure reconciliation failed", {
        guildId: guild.id,
        error,
      });
    }
  });

  client.on("interactionCreate", async (interaction: Interaction) => {
    if (interaction.isAutocomplete()) {
      await handleAutocompleteComponentInteraction(interaction, runtime);
      return;
    }
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

export function recordGuildAvailable(
  runtime: BotRuntime,
  guildId: string,
  guildName: string,
  options: {
    startupDiscovery?: boolean;
    observedJoinedAt?: string | null;
  } = {},
): {
  record: ReturnType<BotRuntime["storage"]["ensureGuild"]>;
  rejoined: boolean;
} {
  const existing = runtime.storage.getGuild(guildId);
  const observedJoinedAt = options.observedJoinedAt ?? null;
  const joinChanged = hasGuildJoinChanged(existing?.joinedAt ?? null, observedJoinedAt);
  const rejoined =
    existing !== null &&
    (existing.leftAt !== null || !options.startupDiscovery || joinChanged);
  const record = rejoined
    ? runtime.storage.reactivateGuild(guildId, guildName, observedJoinedAt)
    : runtime.storage.ensureGuild(guildId, guildName, observedJoinedAt);
  runtime.invalidateGuild(guildId);
  return { record, rejoined };
}

function hasGuildJoinChanged(
  storedJoinedAt: string | null,
  observedJoinedAt: string | null,
): boolean {
  if (!storedJoinedAt || !observedJoinedAt) {
    return false;
  }
  const stored = Date.parse(storedJoinedAt);
  const observed = Date.parse(observedJoinedAt);
  if (!Number.isFinite(stored) || !Number.isFinite(observed)) {
    return storedJoinedAt !== observedJoinedAt;
  }
  return stored !== observed;
}

export function recordGuildUnavailable(
  runtime: BotRuntime,
  guildId: string,
): void {
  runtime.storage.markGuildLeft(guildId);
  runtime.invalidateGuild(guildId);
}

async function handleAutocompleteComponentInteraction(
  interaction: AutocompleteInteraction,
  runtime: BotRuntime,
): Promise<void> {
  try {
    await handleAutocompleteInteraction(interaction, runtime);
  } catch (error) {
    logError("interaction", "Autocomplete interaction failed", {
      guildId: interaction.guildId ?? "dm",
      command: interaction.commandName,
      error,
    });
    if (!interaction.responded) {
      await interaction.respond([]).catch(() => undefined);
    }
  }
}

async function handleChatCommandInteraction(
  interaction: ChatInputCommandInteraction,
  runtime: BotRuntime,
): Promise<void> {
  try {
    await handleChatInputCommand(interaction, runtime);
  } catch (error) {
    logError("interaction", "Command failed", {
      guildId: interaction.guildId ?? "dm",
      command: interaction.commandName,
      subcommand: interaction.options.getSubcommand(false),
      error,
    });
    await replyWithUnexpectedError(interaction, "The command failed unexpectedly and was logged.");
  }
}

async function handleButtonComponentInteraction(
  interaction: ButtonInteraction,
  runtime: BotRuntime,
): Promise<void> {
  try {
    await handleButtonInteraction(interaction, runtime);
  } catch (error) {
    logError("interaction", "Button interaction failed", {
      guildId: interaction.guildId ?? "dm",
      customId: interaction.customId,
      error,
    });
    await replyWithUnexpectedError(
      interaction,
      "That interaction failed unexpectedly and was logged.",
    );
  }
}

async function handleModalInteraction(
  interaction: ModalSubmitInteraction,
  runtime: BotRuntime,
): Promise<void> {
  try {
    await handleModalSubmitInteraction(interaction, runtime);
  } catch (error) {
    logError("interaction", "Modal interaction failed", {
      guildId: interaction.guildId ?? "dm",
      customId: interaction.customId,
      error,
    });
    await replyWithUnexpectedError(
      interaction,
      "That interaction failed unexpectedly and was logged.",
    );
  }
}

async function replyWithUnexpectedError(
  interaction:
    | ChatInputCommandInteraction
    | ButtonInteraction
    | ModalSubmitInteraction,
  content: string,
): Promise<void> {
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp({ content, ephemeral: true }).catch(() => undefined);
    return;
  }
  await interaction.reply({ content, ephemeral: true }).catch(() => undefined);
}
