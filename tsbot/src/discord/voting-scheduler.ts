import {
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildTextBasedChannel,
} from "discord.js";
import { logInfo, logWarn } from "../logging.js";
import type { BotRuntime, GuildRuntime } from "../runtime.js";
import type { VotingPanel } from "../types.js";
import { deliverVotingPanelCompletion } from "./voting-interactions.js";

const DEFAULT_RECONCILIATION_INTERVAL_MS = 15_000;

export interface VotingPanelScheduler {
  start: () => void;
  stop: () => void;
  runDue: () => Promise<void>;
}

export interface VotingPanelSchedulerOptions {
  reconciliationIntervalMs?: number;
  now?: () => Date;
}

/**
 * Reconciles timed polls from durable SQLite state. The database transition is
 * performed before the Discord edit, so duplicate timers and process restarts
 * can never count a vote twice or reopen a completed panel.
 */
export function createVotingPanelScheduler(
  client: Client,
  runtime: BotRuntime,
  options: VotingPanelSchedulerOptions = {},
): VotingPanelScheduler {
  const intervalMs = Math.max(
    1_000,
    Math.floor(
      options.reconciliationIntervalMs ?? DEFAULT_RECONCILIATION_INTERVAL_MS,
    ),
  );
  const now = options.now ?? (() => new Date());
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let stopped = false;

  const runDue = async (): Promise<void> => {
    if (running || stopped) return;
    const botId = client.user?.id;
    if (!botId) return;
    running = true;
    try {
      const timestamp = now().toISOString();
      for (const record of runtime.storage.listEnabledGuilds()) {
        const guildRuntime = await runtime.forGuild(record.guildId);
        if (!guildRuntime?.isCurrent()) continue;
        const guild = client.guilds.cache.get(record.guildId);
        if (!guild?.available) continue;
        const duePanels = guildRuntime.storage.listDueVotingPanels(timestamp);
        for (const panel of duePanels) {
          await completeDuePanel(
            client,
            guild,
            guildRuntime,
            panel,
            botId,
            timestamp,
          );
        }
      }
    } catch (error) {
      logWarn("voting-panels", "Timed vote reconciliation failed", { error });
    } finally {
      running = false;
    }
  };

  return {
    start(): void {
      if (stopped || timer) return;
      void runDue();
      timer = setInterval(() => void runDue(), intervalMs);
    },
    stop(): void {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
    runDue,
  };
}

async function completeDuePanel(
  client: Client,
  guild: Guild,
  runtime: GuildRuntime,
  panel: VotingPanel,
  botId: string,
  timestamp: string,
): Promise<void> {
  const transition = runtime.storage.transitionVotingPanel(
    panel.voteId,
    "completed",
    botId,
    timestamp,
  );
  if (transition.status !== "transitioned" || !transition.panel) return;

  const channel = await fetchVotingChannel(guild, transition.panel.channelId);
  if (!channel) {
    logInfo(
      "voting-panels",
      "Timed vote completed after its channel disappeared",
      {
        guildId: runtime.guildId,
        voteId: transition.panel.voteId,
        channelId: transition.panel.channelId,
      },
    );
    return;
  }
  const message = await channel.messages
    .fetch(transition.panel.messageId)
    .catch(() => null);
  if (!message || message.author.id !== client.user?.id) {
    logInfo(
      "voting-panels",
      "Timed vote completed after its message disappeared",
      {
        guildId: runtime.guildId,
        voteId: transition.panel.voteId,
        messageId: transition.panel.messageId,
      },
    );
    return;
  }
  const botMember =
    guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  const allowEveryoneMention = Boolean(
    transition.panel.mentionEveryoneOnCompletion &&
    botMember &&
    channel.permissionsFor(botMember)?.has(PermissionFlagsBits.MentionEveryone),
  );
  try {
    await deliverVotingPanelCompletion(message, transition.panel, {
      allowEveryoneMention,
    });
    runtime.storage.recordCommandMetric("panel.vote.auto-complete");
  } catch (error) {
    logWarn(
      "voting-panels",
      "Timed vote completed but its message could not be updated",
      {
        guildId: runtime.guildId,
        voteId: transition.panel.voteId,
        messageId: transition.panel.messageId,
        error,
      },
    );
  }
}

async function fetchVotingChannel(
  guild: Guild,
  channelId: string,
): Promise<GuildTextBasedChannel | null> {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.isDMBased() || !channel.isTextBased()) return null;
  return channel as GuildTextBasedChannel;
}
