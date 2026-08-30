import {
  Client,
  GatewayIntentBits,
  MessageFlags,
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
import { logClassifiedError, logError, logInfo, logWarn } from "../logging.js";
import { observeLatency } from "../latency.js";
import { wireMessageRuntime } from "../message-runtime.js";
import type { BotRuntime } from "../runtime.js";
import { synchronizeCommands } from "./registration.js";
import { AsyncWorkTracker } from "./work-tracker.js";
import { clearBackfillStatus } from "./activity.js";
import { clearModerationProcessState } from "./moderation.js";
import { clearPanelProcessState } from "./panels.js";
import { clearAntiSpamProcessState } from "./anti-spam-enforcement.js";
import {
  beginInteractionLifecycle,
  EventLoopDiagnostics,
  replyWithUnexpectedInteractionError,
  runBoundedAutocomplete,
  type InteractionLifecycle,
} from "./interaction-lifecycle.js";
import { startImmediateInteractionResponse } from "./immediate-interaction-response.js";
import {
  handleGuildMemberAdded,
  handleGuildMemberRemoved,
  handleGuildMemberUpdated,
} from "./member-lifecycle-discord.js";
import { createVotingPanelScheduler } from "./voting-scheduler.js";

export interface DiscordClientWorkLifecycle {
  stop: () => void;
  drain: (timeoutMs: number) => Promise<boolean>;
}

export interface DiscordClientOptions {
  onFatalGatewayInvalidation?: () => void | Promise<void>;
}

const clientWorkLifecycles = new WeakMap<Client, DiscordClientWorkLifecycle>();

export function getDiscordClientWorkLifecycle(
  client: Client,
): DiscordClientWorkLifecycle | null {
  return clientWorkLifecycles.get(client) ?? null;
}

export function createDiscordClient(
  runtime: BotRuntime,
  options: DiscordClientOptions = {},
): Client {
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
  instrumentDiscordRestLatency(client);
  const workTracker = new AsyncWorkTracker();
  const eventLoopDiagnostics = new EventLoopDiagnostics();
  const votingPanelScheduler = createVotingPanelScheduler(client, runtime);
  runtime.storage?.setNonessentialScheduler?.((task) => {
    const tracked = workTracker.run(async () => {
      await task();
    });
    void tracked.catch((error) => {
      logClassifiedError("background-work", error, {
        stage: "nonessential-task",
        outcome: "failed",
      });
    });
  });
  const workLifecycle: DiscordClientWorkLifecycle = {
    stop(): void {
      workTracker.stopAccepting();
      eventLoopDiagnostics.stop();
      votingPanelScheduler.stop();
    },
    drain(timeoutMs: number): Promise<boolean> {
      return workTracker.drain(timeoutMs);
    },
  };
  clientWorkLifecycles.set(client, workLifecycle);

  client.on("shardDisconnect", (event, shardId) => {
    logWarn("discord-gateway", "Discord gateway shard disconnected", {
      shardId,
      closeCode: event.code,
      clean: event.wasClean,
      action: "Superior will wait for discord.js to reconnect the shard.",
    });
  });
  client.on("shardReconnecting", (shardId) => {
    logInfo("discord-gateway", "Discord gateway shard is reconnecting", {
      shardId,
    });
  });
  client.on("shardResume", (shardId, replayedEvents) => {
    logInfo("discord-gateway", "Discord gateway shard resumed", {
      shardId,
      replayedEvents,
    });
  });
  let invalidationHandled = false;
  client.on("invalidated", () => {
    logWarn(
      "discord-gateway",
      "Discord invalidated the gateway session; a fresh login is required.",
      {
        action:
          "Superior is entering controlled shutdown. Restart only after the old process exits.",
      },
    );
    if (invalidationHandled) return;
    invalidationHandled = true;
    try {
      const request = options.onFatalGatewayInvalidation?.();
      if (request) {
        void Promise.resolve(request).catch((error: unknown) => {
          logClassifiedError("discord-gateway", error, {
            stage: "invalidated-shutdown",
            outcome: "controlled-shutdown-failed",
          });
        });
      }
    } catch (error) {
      logClassifiedError("discord-gateway", error, {
        stage: "invalidated-shutdown",
        outcome: "controlled-shutdown-failed",
      });
    }
  });
  client.on("error", (error) => {
    logClassifiedError("discord-client", error, {
      stage: "client-error-event",
    });
  });
  client.on("warn", () => {
    logWarn("discord-client", "discord.js emitted a client warning", {
      action: "Review adjacent gateway and interaction diagnostics.",
    });
  });

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
        votingPanelScheduler.start();
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
            "Guild departure retained tenant data for a future rejoin",
            {
              guildId: guild.id,
              guildName: guild.name,
              outcome: "inactive-retained",
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

  client.on("roleDelete", (role) => {
    return workTracker
      .run(async () => {
        if (!runtime.storage.getGuild(role.guild.id)) return;
        const storage = runtime.storage.forGuild(role.guild.id);
        const cleanup = storage.cleanupRestrictedPingRole(role.id);
        const onboarding =
          typeof storage.invalidateOnboardingRole === "function"
            ? storage.invalidateOnboardingRole(role.id)
            : { configurationChanged: 0, autorolesChanged: 0 };
        const roleMenus =
          typeof storage.invalidateRoleMenuRole === "function"
            ? storage.invalidateRoleMenuRole(role.id)
            : { menusChanged: 0, postsChanged: 0 };
        if (
          cleanup.mappingsDeleted === 0 &&
          cleanup.rolesDeleted === 0 &&
          onboarding.configurationChanged === 0 &&
          onboarding.autorolesChanged === 0 &&
          roleMenus.menusChanged === 0 &&
          roleMenus.postsChanged === 0
        )
          return;
        runtime.invalidateGuild(role.guild.id);
        logInfo(
          "discord-resource-lifecycle",
          "Deleted role bindings were made dormant",
          {
            guildId: role.guild.id,
            roleId: role.id,
            rolesDeleted: cleanup.rolesDeleted,
            mappingsDeleted: cleanup.mappingsDeleted,
            userCooldownsDeleted: cleanup.userCooldownsDeleted,
            onboardingConfigurationsChanged: onboarding.configurationChanged,
            onboardingAutorolesChanged: onboarding.autorolesChanged,
            roleMenusChanged: roleMenus.menusChanged,
            roleMenuPostsChanged: roleMenus.postsChanged,
          },
        );
      })
      .catch((error) => {
        logError("discord-resource-lifecycle", "Role deletion cleanup failed", {
          guildId: role.guild.id,
          roleId: role.id,
          error,
        });
      });
  });

  client.on("channelDelete", (channel) => {
    return workTracker
      .run(async () => {
        if (channel.isDMBased()) return;
        const guildId = channel.guild.id;
        if (!runtime.storage.getGuild(guildId)) return;
        const storage = runtime.storage.forGuild(guildId);
        const cleanup = storage.cleanupRestrictedPingChannel(channel.id);
        const onboarding =
          typeof storage.invalidateOnboardingChannel === "function"
            ? storage.invalidateOnboardingChannel(channel.id)
            : { configurationChanged: 0 };
        const roleMenuPostsChanged =
          typeof storage.markRoleMenuChannelMissing === "function"
            ? storage.markRoleMenuChannelMissing(channel.id)
            : 0;
        if (
          cleanup.mappingsDeleted === 0 &&
          cleanup.rolesDeleted === 0 &&
          onboarding.configurationChanged === 0 &&
          roleMenuPostsChanged === 0
        )
          return;
        runtime.invalidateGuild(guildId);
        logInfo(
          "discord-resource-lifecycle",
          "Deleted channel bindings were made dormant",
          {
            guildId,
            channelId: channel.id,
            roleIds: cleanup.roleIds,
            rolesDeleted: cleanup.rolesDeleted,
            mappingsDeleted: cleanup.mappingsDeleted,
            userCooldownsDeleted: cleanup.userCooldownsDeleted,
            onboardingConfigurationsChanged: onboarding.configurationChanged,
            roleMenuPostsChanged,
          },
        );
      })
      .catch((error) => {
        logError(
          "discord-resource-lifecycle",
          "Channel deletion cleanup failed",
          {
            guildId: channel.isDMBased() ? "dm" : channel.guild.id,
            channelId: channel.id,
            error,
          },
        );
      });
  });

  client.on("messageDelete", (message) => {
    return workTracker
      .run(async () => {
        if (!message.guildId || !runtime.storage.getGuild(message.guildId))
          return;
        const storage = runtime.storage.forGuild(message.guildId);
        const changed =
          typeof storage.markRoleMenuMessageMissing === "function"
            ? storage.markRoleMenuMessageMissing(message.channelId, message.id)
            : 0;
        if (changed === 0) return;
        logInfo(
          "discord-resource-lifecycle",
          "Deleted role-menu message marked missing",
          {
            guildId: message.guildId,
            channelId: message.channelId,
            messageId: message.id,
            roleMenuPostsChanged: changed,
          },
        );
      })
      .catch((error) => {
        logClassifiedError("discord-resource-lifecycle", error, {
          guildId: message.guildId ?? "dm",
          channelId: message.channelId,
          messageId: message.id,
          stage: "message-delete",
          outcome: "failed",
        });
      });
  });

  client.on("guildMemberAdd", (member) => {
    return workTracker
      .run(() =>
        handleGuildMemberAdded(runtime, member, () => workTracker.isAccepting),
      )
      .catch((error) => {
        logClassifiedError("onboarding-lifecycle", error, {
          guildId: member.guild.id,
          memberId: member.id,
          stage: "guild-member-add",
          outcome: "failed",
        });
      });
  });

  client.on("guildMemberUpdate", (oldMember, newMember) => {
    return workTracker
      .run(() =>
        handleGuildMemberUpdated(
          runtime,
          oldMember,
          newMember,
          () => workTracker.isAccepting,
        ),
      )
      .catch((error) => {
        logClassifiedError("onboarding-lifecycle", error, {
          guildId: newMember.guild.id,
          memberId: newMember.id,
          stage: "guild-member-update",
          outcome: "failed",
        });
      });
  });

  client.on("guildMemberRemove", (member) => {
    return workTracker
      .run(() =>
        handleGuildMemberRemoved(
          runtime,
          member,
          () => workTracker.isAccepting,
        ),
      )
      .catch((error) => {
        logClassifiedError("onboarding-lifecycle", error, {
          guildId: member.guild.id,
          memberId: member.id,
          stage: "guild-member-remove",
          outcome: "failed",
        });
      });
  });

  client.on("interactionCreate", (interaction: Interaction) => {
    if (!workTracker.isAccepting) {
      void acknowledgeInteractionDuringShutdown(interaction).catch((error) => {
        logClassifiedError("interaction", error, {
          stage: "shutdown-rejection-acknowledgement",
          outcome: "acknowledgement-failed",
        });
      });
      return;
    }
    const lifecycle = beginInteractionLifecycle(interaction, {
      eventLoopDelay: () => eventLoopDiagnostics.snapshot(),
    });
    const immediateResponse = startImmediateInteractionResponse(
      interaction,
      runtime,
      lifecycle,
    );
    return workTracker
      .run(async () => {
        if (!(await lifecycle.ready)) return;
        if ((await immediateResponse) === "handled") {
          lifecycle.complete("handled");
          return;
        }
        if (interaction.isAutocomplete()) {
          await handleAutocompleteComponentInteraction(
            interaction,
            runtime,
            lifecycle,
          );
          return;
        }
        if (interaction.isChatInputCommand()) {
          await handleChatCommandInteraction(interaction, runtime, lifecycle);
          return;
        }
        if (interaction.isButton()) {
          await handleButtonComponentInteraction(
            interaction,
            runtime,
            lifecycle,
          );
          return;
        }
        if (interaction.isModalSubmit()) {
          await handleModalInteraction(interaction, runtime, lifecycle);
          return;
        }
        if (interaction.isStringSelectMenu()) {
          await handleStringSelectInteraction(interaction, runtime, lifecycle);
          return;
        }
        lifecycle.complete("ignored");
      })
      .catch((error) => {
        lifecycle.fail(error, { stage: "tracked-handler" });
      });
  });

  return client;
}

async function acknowledgeInteractionDuringShutdown(
  interaction: Interaction,
): Promise<void> {
  if (interaction.isAutocomplete()) {
    if (!interaction.responded) await interaction.respond([]);
    return;
  }
  if (
    !interaction.isRepliable() ||
    interaction.deferred ||
    interaction.replied
  ) {
    return;
  }
  await interaction.reply({
    content:
      "Superior is restarting and cannot accept this operation. Please try again after it reconnects.",
    flags: MessageFlags.Ephemeral,
  });
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
    clearAntiSpamProcessState(guildId);
  }
  runtime.invalidateGuild(guildId);
  return { record, rejoined };
}

/**
 * Measures the REST calls that implement Discord replies, edits, and sends.
 * Route strings are used only for local classification; neither routes (which
 * can contain interaction tokens) nor request bodies are emitted.
 */
export function instrumentDiscordRestLatency(client: Client): void {
  const originalRequest = client.rest.request.bind(client.rest);
  type RestRequest = Parameters<typeof client.rest.request>[0];
  client.rest.request = ((request: RestRequest) => {
    const operation = classifyDiscordRestOperation(request);
    if (!operation) return originalRequest(request);
    return observeLatency(
      "discord.rest",
      operation,
      () => originalRequest(request),
      {},
    );
  }) as typeof client.rest.request;
}

function classifyDiscordRestOperation(
  request: Parameters<Client["rest"]["request"]>[0],
): "reply" | "edit" | "follow-up" | "send" | "delete" | null {
  const route = String(request.fullRoute);
  const method = request.method.toUpperCase();
  if (route.includes("/interactions/") && route.endsWith("/callback")) {
    return "reply";
  }
  if (route.includes("/webhooks/") && route.includes("/messages/@original")) {
    return method === "DELETE" ? "delete" : "edit";
  }
  if (route.includes("/webhooks/")) {
    return method === "DELETE" ? "delete" : "follow-up";
  }
  if (route.includes("/channels/") && route.includes("/messages")) {
    if (method === "POST") return "send";
    if (method === "PATCH") return "edit";
    if (method === "DELETE") return "delete";
  }
  return null;
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
  clearAntiSpamProcessState(guildId);
  runtime.invalidateGuild(guildId);
}

export function recordGuildRemoved(runtime: BotRuntime, guildId: string): void {
  // Invalidate first so work that crossed an asynchronous boundary cannot
  // persist more tenant data after departure. Tenant rows and persistent
  // panel bindings remain available if the bot later rejoins.
  runtime.invalidateGuild(guildId);
  try {
    runtime.storage.markGuildLeft(guildId);
  } finally {
    clearBackfillStatus(guildId);
    clearModerationProcessState(guildId);
    clearPanelProcessState(guildId);
    clearAntiSpamProcessState(guildId);
  }
}

async function handleAutocompleteComponentInteraction(
  interaction: AutocompleteInteraction,
  runtime: BotRuntime,
  lifecycle: InteractionLifecycle,
): Promise<void> {
  try {
    const outcome = await runBoundedAutocomplete(interaction, lifecycle, () =>
      handleAutocompleteInteraction(interaction, runtime),
    );
    lifecycle.complete(
      outcome === "fallback" ? "autocomplete-fallback" : "succeeded",
    );
  } catch (error) {
    lifecycle.fail(error, { stage: "autocomplete-handler" });
  }
}

async function handleChatCommandInteraction(
  interaction: ChatInputCommandInteraction,
  runtime: BotRuntime,
  lifecycle: InteractionLifecycle,
): Promise<void> {
  try {
    await handleChatInputCommand(interaction, runtime);
    lifecycle.complete("handled");
  } catch (error) {
    const classified = lifecycle.fail(error, { stage: "command-handler" });
    await replyWithUnexpectedInteractionError(
      interaction,
      classified,
      "The command failed unexpectedly and was logged.",
    );
  }
}

async function handleButtonComponentInteraction(
  interaction: ButtonInteraction,
  runtime: BotRuntime,
  lifecycle: InteractionLifecycle,
): Promise<void> {
  try {
    await handleButtonInteraction(interaction, runtime);
    lifecycle.complete("handled");
  } catch (error) {
    const classified = lifecycle.fail(error, { stage: "button-handler" });
    await replyWithUnexpectedInteractionError(
      interaction,
      classified,
      "That interaction failed unexpectedly and was logged.",
    );
  }
}

async function handleModalInteraction(
  interaction: ModalSubmitInteraction,
  runtime: BotRuntime,
  lifecycle: InteractionLifecycle,
): Promise<void> {
  try {
    await handleModalSubmitInteraction(interaction, runtime);
    lifecycle.complete("handled");
  } catch (error) {
    const classified = lifecycle.fail(error, { stage: "modal-handler" });
    await replyWithUnexpectedInteractionError(
      interaction,
      classified,
      "That interaction failed unexpectedly and was logged.",
    );
  }
}

async function handleStringSelectInteraction(
  interaction: StringSelectMenuInteraction,
  runtime: BotRuntime,
  lifecycle: InteractionLifecycle,
): Promise<void> {
  try {
    await handleStringSelectMenuInteraction(interaction, runtime);
    lifecycle.complete("handled");
  } catch (error) {
    const classified = lifecycle.fail(error, { stage: "select-handler" });
    await replyWithUnexpectedInteractionError(
      interaction,
      classified,
      "That interaction failed unexpectedly and was logged.",
    );
  }
}
