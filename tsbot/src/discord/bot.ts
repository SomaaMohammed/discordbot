import {
  Client,
  GatewayIntentBits,
  Partials,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import {
  buildCommandDefinitions,
  handleAutocompleteInteraction,
  handleButtonInteraction,
  handleChatInputCommand,
  handleModalSubmitInteraction,
  handleStringSelectMenuInteraction,
} from "./commands.js";
import { logError, logInfo } from "../logging.js";
import { wireMessageRuntime } from "../message-runtime.js";
import type { BotRuntime } from "../runtime.js";
import { synchronizeCommands } from "./registration.js";
import { AsyncWorkTracker } from "./work-tracker.js";
import { clearBackfillStatus } from "./activity.js";
import { clearModerationProcessState } from "./moderation.js";
import { clearPanelProcessState } from "./panels.js";

export interface DiscordClientWorkLifecycle {
  stop: () => void;
  drain: (timeoutMs: number) => Promise<boolean>;
}

const clientWorkLifecycles = new WeakMap<Client, DiscordClientWorkLifecycle>();

export function getDiscordClientWorkLifecycle(
  client: Client,
): DiscordClientWorkLifecycle | null {
  return clientWorkLifecycles.get(client) ?? null;
}

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
    allowedMentions: { parse: [], repliedUser: false },
  });
  const workTracker = new AsyncWorkTracker();
  const workLifecycle: DiscordClientWorkLifecycle = {
    stop(): void {
      workTracker.stopAccepting();
    },
    drain(timeoutMs: number): Promise<boolean> {
      return workTracker.drain(timeoutMs);
    },
  };
  clientWorkLifecycles.set(client, workLifecycle);

  wireMessageRuntime(client, runtime, workTracker);

  client.once("clientReady", () => {
    return workTracker
      .run(async () => {
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
          if (!guild.available) {
            logInfo(
              "discord-lifecycle",
              "Startup guild reconciliation deferred until availability returns",
              { guildId: guild.id },
            );
            continue;
          }
          try {
            recordGuildAvailable(runtime, guild.id, guild.name, {
              startupDiscovery: true,
              observedJoinedAt: guild.joinedAt.toISOString(),
            });
          } catch (error) {
            logError(
              "discord-lifecycle",
              "Startup guild reconciliation failed",
              {
                guildId: guild.id,
                error,
              },
            );
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
              logError(
                "discord-lifecycle",
                "Offline departure reconciliation failed",
                {
                  guildId: record.guildId,
                  error,
                },
              );
            }
          }
        } catch (error) {
          logError(
            "discord-lifecycle",
            "Could not enumerate active guild records",
            {
              error,
            },
          );
        }

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
      })
      .catch((error) => {
        logError("discord", "Tracked client-ready handler failed", { error });
      });
  });

  client.on("guildCreate", (guild) => {
    return workTracker
      .run(async () => {
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
      })
      .catch((error) => {
        logError("discord-lifecycle", "Tracked guild-create handler failed", {
          guildId: guild.id,
          error,
        });
      });
  });

  client.on("guildAvailable", (guild) => {
    return workTracker
      .run(async () => {
        try {
          const { record, rejoined } = recordGuildAvailable(
            runtime,
            guild.id,
            guild.name,
            {
              startupDiscovery: true,
              observedJoinedAt: guild.joinedAt.toISOString(),
            },
          );
          logInfo(
            "discord-lifecycle",
            "Deferred guild availability reconciled",
            {
              guildId: guild.id,
              guildName: guild.name,
              enabled: record.enabled,
              rejoined,
            },
          );
        } catch (error) {
          logError("discord-lifecycle", "Guild availability recovery failed", {
            guildId: guild.id,
            error,
          });
        }
      })
      .catch((error) => {
        logError(
          "discord-lifecycle",
          "Tracked guild-available handler failed",
          {
            guildId: guild.id,
            error,
          },
        );
      });
  });

  client.on("guildDelete", (guild) => {
    return workTracker
      .run(async () => {
        try {
          recordGuildRemoved(runtime, guild.id);
          logInfo(
            "discord-lifecycle",
            "Confirmed guild removal purged stored tenant data",
            {
              guildId: guild.id,
              guildName: guild.name,
            },
          );
        } catch (error) {
          logError(
            "discord-lifecycle",
            "Guild departure reconciliation failed",
            {
              guildId: guild.id,
              error,
            },
          );
        }
      })
      .catch((error) => {
        logError("discord-lifecycle", "Tracked guild-delete handler failed", {
          guildId: guild.id,
          error,
        });
      });
  });

  client.on("interactionCreate", (interaction: Interaction) => {
    return workTracker
      .run(async () => {
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
          return;
        }
        if (interaction.isStringSelectMenu()) {
          await handleStringSelectInteraction(interaction, runtime);
        }
      })
      .catch((error) => {
        logError("interaction", "Tracked interaction handler failed", {
          guildId: interaction.guildId ?? "dm",
          error,
        });
      });
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
  const joinChanged = hasGuildJoinChanged(
    existing?.joinedAt ?? null,
    observedJoinedAt,
  );
  const rejoined =
    existing !== null &&
    (existing.leftAt !== null || !options.startupDiscovery || joinChanged);
  const record = rejoined
    ? runtime.storage.reactivateGuild(guildId, guildName, observedJoinedAt)
    : runtime.storage.ensureGuild(guildId, guildName, observedJoinedAt);
  if (rejoined) {
    clearBackfillStatus(guildId);
    clearModerationProcessState(guildId);
    clearPanelProcessState(guildId);
  }
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
  // Reactivation stores a strictly monotonic lifecycle token that can be a
  // millisecond newer than Discord's stable joinedAt value. Only a genuinely
  // newer Discord observation proves an offline leave/rejoin; treating any
  // inequality as a rejoin would disable the guild again on every restart.
  return observed > stored;
}

export function recordGuildUnavailable(
  runtime: BotRuntime,
  guildId: string,
): void {
  runtime.storage.markGuildLeft(guildId);
  clearBackfillStatus(guildId);
  clearModerationProcessState(guildId);
  clearPanelProcessState(guildId);
  runtime.invalidateGuild(guildId);
}

export function recordGuildRemoved(
  runtime: BotRuntime,
  guildId: string,
): ReturnType<BotRuntime["storage"]["purgeGuildData"]> {
  // Invalidate first so work that crossed an asynchronous boundary cannot
  // persist more tenant data while the confirmed removal is being purged.
  runtime.invalidateGuild(guildId);
  try {
    return runtime.storage.purgeGuildData(guildId);
  } finally {
    clearBackfillStatus(guildId);
    clearModerationProcessState(guildId);
    clearPanelProcessState(guildId);
  }
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
    await replyWithUnexpectedError(
      interaction,
      "The command failed unexpectedly and was logged.",
    );
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

async function handleStringSelectInteraction(
  interaction: StringSelectMenuInteraction,
  runtime: BotRuntime,
): Promise<void> {
  try {
    await handleStringSelectMenuInteraction(interaction, runtime);
  } catch (error) {
    logError("interaction", "Select-menu interaction failed", {
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
    | ModalSubmitInteraction
    | StringSelectMenuInteraction,
  content: string,
): Promise<void> {
  if (interaction.deferred && !interaction.replied) {
    await interaction
      .editReply({ content, allowedMentions: { parse: [] } })
      .catch(() => undefined);
    return;
  }
  if (interaction.replied) {
    await interaction
      .followUp({ content, ephemeral: true, allowedMentions: { parse: [] } })
      .catch(() => undefined);
    return;
  }
  await interaction
    .reply({ content, ephemeral: true, allowedMentions: { parse: [] } })
    .catch(() => undefined);
}
