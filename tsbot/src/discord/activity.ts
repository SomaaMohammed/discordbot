import {
  MessageFlags,
  PermissionFlagsBits,
  escapeMarkdown,
  type ChatInputCommandInteraction,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
} from "discord.js";
import type { GuildRuntime } from "../runtime.js";
import type { UserMetrics } from "../types.js";
import { logDomainOutcome } from "./domain-outcomes.js";

const MAX_BACKFILL_MESSAGES = 50_000;
const METRIC_LABELS: Record<keyof UserMetrics, string> = {
  messages_sent: "Messages sent",
  reactions_sent: "Reactions sent",
  reactions_received: "Reactions received",
  battles_played: "Battles played",
  battles_won: "Battles won",
};

interface BackfillStatus {
  running: boolean;
  startedAt: string | null;
  completedAt: string | null;
  channelsScanned: number;
  messagesScanned: number;
  usersUpdated: number;
  truncated: boolean;
  error: string | null;
}

const backfillStatuses = new Map<string, BackfillStatus>();

class BackfillCancelledError extends Error {}

export function clearBackfillStatus(guildId: string): void {
  backfillStatuses.delete(guildId);
}

export const ACTIVITY_SUBCOMMANDS = new Set([
  "backfill",
  "backfill-status",
  "backfillstats",
  "backfillstatus",
]);

export async function handleActivityCommand(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<boolean> {
  switch (interaction.options.getSubcommand()) {
    case "backfill":
    case "backfillstats":
      await handleBackfill(interaction, runtime);
      return true;
    case "backfill-status":
    case "backfillstatus":
      await handleBackfillStatus(interaction, runtime);
      return true;
    default:
      return false;
  }
}

export async function handleFunCommand(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  switch (interaction.options.getSubcommand()) {
    case "battle":
      await handleBattle(interaction, runtime);
      return;
    case "stats":
      await handleStats(interaction, runtime);
      return;
    case "leaderboard":
      await handleLeaderboard(interaction, runtime);
      return;
    default:
      await reply(interaction, "Unknown fun command.", true);
  }
}

async function handleBackfill(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const existing = backfillStatuses.get(runtime.guildId);
  if (existing?.running) {
    logDomainOutcome(
      "activity",
      "backfill",
      runtime.guildId,
      "rejected-already-running",
    );
    await reply(
      interaction,
      "An activity backfill is already running for this server.",
      true,
    );
    return;
  }
  const days = interaction.options.getInteger("days", false) ?? 30;
  const cutoff = days === 0 ? 0 : Date.now() - days * 86_400_000;
  const status: BackfillStatus = {
    running: true,
    startedAt: new Date().toISOString(),
    completedAt: null,
    channelsScanned: 0,
    messagesScanned: 0,
    usersUpdated: 0,
    truncated: false,
    error: null,
  };
  backfillStatuses.set(runtime.guildId, status);
  logDomainOutcome("activity", "backfill", runtime.guildId, "started", {
    totalCount: MAX_BACKFILL_MESSAGES,
  });
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
  const guild = interaction.guild;
  if (!guild || guild.id !== runtime.guildId) {
    status.running = false;
    status.error = "Guild context changed";
    logDomainOutcome(
      "activity",
      "backfill",
      runtime.guildId,
      "rejected-guild-context",
    );
    await interaction.editReply(
      "This backfill does not belong to this server.",
    );
    return;
  }
  const botMember =
    guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!botMember) {
    status.running = false;
    status.error = "Bot member unavailable";
    logDomainOutcome(
      "activity",
      "backfill",
      runtime.guildId,
      "rejected-permission-verification-unavailable",
    );
    await interaction.editReply("Could not verify Superior's permissions.");
    return;
  }
  const totals = new Map<string, UserMetrics>();
  let nextProgressLog = 5_000;
  try {
    try {
      for (const channel of guild.channels.cache.values()) {
        assertBackfillCurrent(runtime);
        if (status.messagesScanned >= MAX_BACKFILL_MESSAGES) {
          status.truncated = true;
          break;
        }
        if (!isReadableHistoryChannel(channel, botMember)) continue;
        status.channelsScanned += 1;
        let before: string | undefined;
        while (status.messagesScanned < MAX_BACKFILL_MESSAGES) {
          assertBackfillCurrent(runtime);
          const page = await channel.messages.fetch(
            before ? { limit: 100, before } : { limit: 100 },
          );
          assertBackfillCurrent(runtime);
          if (page.size === 0) break;
          let reachedCutoff = false;
          for (const message of page.values()) {
            assertBackfillCurrent(runtime);
            if (message.createdTimestamp < cutoff) {
              reachedCutoff = true;
              continue;
            }
            await tallyMessage(message, totals, runtime);
            status.messagesScanned += 1;
            if (status.messagesScanned >= nextProgressLog) {
              logDomainOutcome(
                "activity",
                "backfill",
                runtime.guildId,
                "progress",
                {
                  attemptedCount: status.channelsScanned,
                  processedCount: status.messagesScanned,
                  succeededCount: totals.size,
                  totalCount: MAX_BACKFILL_MESSAGES,
                },
              );
              nextProgressLog += 5_000;
            }
            if (status.messagesScanned >= MAX_BACKFILL_MESSAGES) break;
          }
          before = page.last()?.id;
          if (reachedCutoff || page.size < 100 || !before) break;
        }
      }
    } catch (error) {
      if (error instanceof BackfillCancelledError) {
        status.error = error.message;
        logDomainOutcome(
          "activity",
          "backfill",
          runtime.guildId,
          "cancelled-runtime-changed",
          {
            attemptedCount: status.channelsScanned,
            processedCount: status.messagesScanned,
          },
        );
        await interaction.editReply(
          "Backfill cancelled because this server was disabled, removed, purged, or reconfigured. No metrics were changed.",
        );
        return;
      }
      status.error =
        error instanceof Error ? error.message.slice(0, 200) : "Unknown error";
      logDomainOutcome("activity", "backfill", runtime.guildId, "failed-scan", {
        attemptedCount: status.channelsScanned,
        processedCount: status.messagesScanned,
      });
      await interaction.editReply(
        `Backfill stopped after scanning **${status.messagesScanned}** messages. No partial replacement was written.`,
      );
      return;
    }

    try {
      assertBackfillCurrent(runtime);
      runtime.storage.replaceUserActivityMetrics(
        [...totals.entries()].map(([userId, metrics]) => ({ userId, metrics })),
      );
    } catch (error) {
      if (error instanceof BackfillCancelledError) {
        status.error = error.message;
        logDomainOutcome(
          "activity",
          "backfill",
          runtime.guildId,
          "cancelled-before-storage-replacement",
          {
            attemptedCount: status.channelsScanned,
            processedCount: status.messagesScanned,
          },
        );
        await interaction.editReply(
          "Backfill scan finished, but no metrics were changed because the server was disabled, removed, purged, or reconfigured.",
        );
        return;
      }
      status.error =
        error instanceof Error
          ? error.message.slice(0, 200)
          : "Storage replacement failed";
      logDomainOutcome(
        "activity",
        "backfill",
        runtime.guildId,
        "failed-storage-replacement",
        {
          attemptedCount: status.channelsScanned,
          processedCount: status.messagesScanned,
        },
      );
      await interaction.editReply(
        "Backfill storage replacement failed. Its transaction was rolled back, so no partial replacement was written.",
      );
      return;
    }

    status.usersUpdated = totals.size;
    logDomainOutcome("activity", "backfill", runtime.guildId, "completed", {
      attemptedCount: status.channelsScanned,
      processedCount: status.messagesScanned,
      succeededCount: status.usersUpdated,
      totalCount: MAX_BACKFILL_MESSAGES,
      ...(status.truncated ? { state: "safety-limit-reached" } : {}),
    });
    await interaction.editReply(
      [
        "Activity backfill completed.",
        `Channels scanned: **${status.channelsScanned}**`,
        `Messages scanned: **${status.messagesScanned}**`,
        `Users updated: **${status.usersUpdated}**`,
        status.truncated
          ? `The safety ceiling of ${MAX_BACKFILL_MESSAGES.toLocaleString()} messages was reached.`
          : null,
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
    );
    try {
      runtime.storage.recordCommandMetric("activity.backfill");
    } catch {
      // The backfill transaction and user-facing acknowledgement already
      // succeeded. Command metrics are ancillary and must not reverse that.
    }
  } finally {
    status.running = false;
    status.completedAt = new Date().toISOString();
  }
}

function assertBackfillCurrent(runtime: GuildRuntime): void {
  if (!runtime.isCurrent()) {
    throw new BackfillCancelledError(
      "Server disabled, removed, purged, or reconfigured during backfill",
    );
  }
}

async function handleBackfillStatus(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const status = backfillStatuses.get(runtime.guildId);
  if (!status) {
    await reply(
      interaction,
      "No activity backfill has run since this process started.",
      true,
    );
    return;
  }
  await reply(
    interaction,
    [
      `State: **${status.running ? "running" : status.error ? "failed" : "complete"}**`,
      `Started: ${status.startedAt ? `<t:${Math.floor(Date.parse(status.startedAt) / 1_000)}:R>` : "never"}`,
      `Channels scanned: **${status.channelsScanned}**`,
      `Messages scanned: **${status.messagesScanned}**`,
      `Users updated: **${status.usersUpdated}**`,
      status.error ? `Error: ${escapeMarkdown(status.error)}` : null,
    ]
      .filter((line): line is string => line !== null)
      .join("\n"),
    true,
  );
  runtime.storage.recordCommandMetric("activity.backfill-status");
}

async function tallyMessage(
  message: Message,
  totals: Map<string, UserMetrics>,
  runtime: GuildRuntime,
): Promise<void> {
  if (!message.author.bot) {
    getMetrics(totals, message.author.id).messages_sent += 1;
  }
  for (const reaction of message.reactions.cache.values()) {
    assertBackfillCurrent(runtime);
    const users = await reaction.users.fetch().catch(() => null);
    assertBackfillCurrent(runtime);
    if (!users) continue;
    let humanReactions = 0;
    for (const user of users.values()) {
      if (user.bot) continue;
      getMetrics(totals, user.id).reactions_sent += 1;
      humanReactions += 1;
    }
    if (!message.author.bot) {
      getMetrics(totals, message.author.id).reactions_received +=
        humanReactions;
    }
  }
}

function isReadableHistoryChannel(
  channel: unknown,
  botMember: GuildMember,
): channel is GuildTextBasedChannel {
  if (!channel || typeof channel !== "object") return false;
  const candidate = channel as GuildTextBasedChannel;
  if (
    typeof candidate.isTextBased !== "function" ||
    candidate.isDMBased() ||
    !candidate.isTextBased() ||
    !("messages" in candidate)
  ) {
    return false;
  }
  const permissions = candidate.permissionsFor(botMember);
  return Boolean(
    permissions?.has(PermissionFlagsBits.ViewChannel) &&
    permissions.has(PermissionFlagsBits.ReadMessageHistory),
  );
}

async function handleBattle(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const opponent = interaction.options.getUser("opponent", true);
  if (opponent.id === interaction.user.id) {
    await reply(
      interaction,
      "You square off against yourself. It ends in a perfectly even draw.",
      false,
    );
    return;
  }
  const challengerRoll = runtime.randomInt(100) + 1;
  const opponentRoll = runtime.randomInt(100) + 1;
  const tie = challengerRoll === opponentRoll;
  const challengerWon = challengerRoll > opponentRoll;
  const challenger = escapeMarkdown(
    interaction.user.globalName ?? interaction.user.username,
  );
  const opponentName = escapeMarkdown(opponent.globalName ?? opponent.username);
  const result = tie
    ? `**${challenger}** and **${opponentName}** tie at **${challengerRoll}**.`
    : `**${challengerWon ? challenger : opponentName}** wins **${challengerRoll}–${opponentRoll}**.`;
  await reply(interaction, result, false);
  if (runtime.isCurrent()) {
    runtime.storage.incrementUserMetric(interaction.user.id, "battles_played");
    if (!opponent.bot)
      runtime.storage.incrementUserMetric(opponent.id, "battles_played");
    if (!tie && (challengerWon || !opponent.bot)) {
      runtime.storage.incrementUserMetric(
        challengerWon ? interaction.user.id : opponent.id,
        "battles_won",
      );
    }
    runtime.storage.recordCommandMetric("fun.battle");
  }
}

async function handleStats(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const user = interaction.options.getUser("member", false) ?? interaction.user;
  const metrics = runtime.storage.getUserMetrics(user.id);
  const lines = (Object.keys(METRIC_LABELS) as Array<keyof UserMetrics>).map(
    (metric) => `${METRIC_LABELS[metric]}: **${metrics[metric]}**`,
  );
  await reply(
    interaction,
    `Stats for **${escapeMarkdown(user.globalName ?? user.username)}**\n${lines.join("\n")}`,
    true,
  );
  runtime.storage.recordCommandMetric("fun.stats");
}

async function handleLeaderboard(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const metric = interaction.options.getString(
    "metric",
    true,
  ) as keyof UserMetrics;
  if (!(metric in METRIC_LABELS)) {
    await reply(interaction, "Unknown leaderboard metric.", true);
    return;
  }
  const limit = interaction.options.getInteger("limit", false) ?? 10;
  const rows = runtime.storage.getUserLeaderboard(metric, limit);
  const lines = rows.map(
    (row, index) => `${index + 1}. <@${row.userId}> — **${row.value}**`,
  );
  await reply(
    interaction,
    `**${METRIC_LABELS[metric]}**\n${lines.join("\n") || "No activity recorded yet."}`,
    true,
  );
  runtime.storage.recordCommandMetric("fun.leaderboard");
}

function getMetrics(
  totals: Map<string, UserMetrics>,
  userId: string,
): UserMetrics {
  const existing = totals.get(userId);
  if (existing) return existing;
  const metrics: UserMetrics = {
    messages_sent: 0,
    reactions_sent: 0,
    reactions_received: 0,
    battles_played: 0,
    battles_won: 0,
  };
  totals.set(userId, metrics);
  return metrics;
}

async function reply(
  interaction: ChatInputCommandInteraction,
  content: string,
  ephemeral: boolean,
): Promise<void> {
  if (interaction.deferred && !interaction.replied) {
    await interaction.editReply({ content, allowedMentions: { parse: [] } });
    return;
  }
  if (interaction.replied) {
    await interaction.followUp({
      content,
      ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
      allowedMentions: { parse: [] },
    });
    return;
  }
  await interaction.reply({
    content,
    ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
    allowedMentions: { parse: [] },
  });
}
