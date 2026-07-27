import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  NewsChannel,
  PermissionFlagsBits,
  TextChannel,
  ThreadAutoArchiveDuration,
  escapeInlineCode,
  escapeMarkdown,
  type AnyThreadChannel,
  type Channel,
  type Client,
  type Guild,
  type GuildMember,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type Role,
  type User,
} from "discord.js";
import { DateTime } from "luxon";
import {
  POST_RECORD_LIMIT,
  REPLY_MUTE_MINUTES,
  ROLE_COLOR,
  THREAD_CLOSE_HOURS,
} from "../constants.js";
import {
  buildAnnouncementMentions,
  getPostCloseDeadline,
  parseReplyMuteMessage,
  parseSuperiorChatIntent,
  type SuperiorChatIntent,
} from "../parity.js";
import { logError } from "../logging.js";
import { getWeekKey, isoNow } from "../time.js";
import type {
  BotRuntime as ProcessBotRuntime,
  GuildRuntime,
} from "../runtime.js";
import type { PostRecord } from "../types.js";
import {
  getEffectiveSilenceTargetRoleIds,
  readSilenceLeases,
  SILENCE_TARGET_DELETED,
  SilenceLeaseCoordinator,
  type SendMessagesState,
  type SilenceLease,
  type SilenceOverwriteTarget,
  type SilenceTargetResolution,
} from "./silence-leases.js";
import { AsyncWorkTracker } from "./work-tracker.js";

type BotRuntime = GuildRuntime;

const ANON_ANSWER_BUTTON_ID = "court:anonymous_answer";
const SILENCE_RECONCILE_INTERVAL_MS = 5_000;
type RuntimeTargetChannel = TextChannel | NewsChannel | AnyThreadChannel;

const defaultInFlightGuildTasks = new Set<string>();
const silenceLeaseCoordinator = new SilenceLeaseCoordinator();
const backgroundLoopControllers = new WeakMap<
  Client,
  RuntimeBackgroundLoopController
>();

export interface RuntimeBackgroundLoopController {
  readonly stopped: boolean;
  stop: () => void;
  drain: (timeoutMs: number) => Promise<boolean>;
}

export function wireRuntimeParity(
  client: Client,
  runtime: ProcessBotRuntime,
  workTracker: AsyncWorkTracker = new AsyncWorkTracker(),
): void {
  client.on("messageCreate", (message) => {
    return workTracker
      .run(async () => {
        await handleMessageCreate(message, runtime).catch((error) => {
          logError("discord-event", "Message event failed", {
            guildId: message.guildId ?? "dm",
            error,
          });
        });
      })
      .catch((error) => {
        logError("discord-event", "Tracked message event failed", {
          guildId: message.guildId ?? "dm",
          error,
        });
      });
  });

  client.on("messageReactionAdd", (reaction, user) => {
    return workTracker
      .run(async () => {
        await handleReactionAdd(reaction, user, runtime).catch((error) => {
          logError("discord-event", "Reaction event failed", {
            guildId: reaction.message.guildId ?? "dm",
            error,
          });
        });
      })
      .catch((error) => {
        logError("discord-event", "Tracked reaction event failed", {
          guildId: reaction.message.guildId ?? "dm",
          error,
        });
      });
  });
}

export function startRuntimeBackgroundLoops(
  client: Client,
  runtime: ProcessBotRuntime,
  workTracker: AsyncWorkTracker = new AsyncWorkTracker(),
): RuntimeBackgroundLoopController {
  const existing = backgroundLoopControllers.get(client);
  if (existing) {
    return existing;
  }
  const controller = startBackgroundLoops(client, runtime, workTracker);
  backgroundLoopControllers.set(client, controller);
  return controller;
}

async function handleMessageCreate(
  message: Message,
  processRuntime: ProcessBotRuntime,
): Promise<void> {
  if (message.author.bot || !message.guild) {
    return;
  }

  const runtime = await processRuntime.forGuild(message.guild.id);
  if (!runtime?.settings.enabled || !runtime.isCurrent()) {
    return;
  }

  const member = await resolveMessageMember(message);
  if (!member || !runtime.isCurrent()) {
    return;
  }

  runtime.storage.metricsIncrement(
    runtime.storage.buildUserMetricKey(member.id, "messages_sent"),
  );
  if (!runtime.isCurrent()) {
    return;
  }

  const invocationTerms = getInvocationTerms(runtime);
  if (runtime.settings.features.replyModeration) {
    const reasonText = parseReplyMuteMessage(message.content, invocationTerms);
    if (reasonText !== null) {
      if (isAdmin(member)) {
        await handleReplyMuteTrigger(message, member, reasonText, runtime);
      }
      return;
    }
  }

  if (
    runtime.settings.features.invictusChat &&
    (await maybeSendSuperiorChatResponse(message, member, runtime))
  ) {
    return;
  }
  if (!runtime.isCurrent()) {
    return;
  }
}

async function handleReactionAdd(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  processRuntime: ProcessBotRuntime,
): Promise<void> {
  if (user.bot) {
    return;
  }

  const guildId = reaction.message.guildId;
  if (!guildId) {
    return;
  }

  const runtime = await processRuntime.forGuild(guildId);
  if (!runtime?.settings.enabled || !runtime.isCurrent()) {
    return;
  }

  const message = reaction.message.partial
    ? await reaction.message.fetch().catch(() => null)
    : reaction.message;
  if (!message?.guild || message.guild.id !== guildId || !runtime.isCurrent()) {
    return;
  }

  runtime.storage.metricsIncrement(
    runtime.storage.buildUserMetricKey(user.id, "reactions_sent"),
  );

  const author = message.author;
  if (!author || author.bot) {
    return;
  }

  runtime.storage.metricsIncrement(
    runtime.storage.buildUserMetricKey(author.id, "reactions_received"),
  );
}

function startBackgroundLoops(
  client: Client,
  runtime: ProcessBotRuntime,
  workTracker: AsyncWorkTracker,
): RuntimeBackgroundLoopController {
  let stopped = false;
  const intervals: Array<ReturnType<typeof setInterval>> = [];
  const inFlightGuildTasks = new Set<string>();
  const run = (name: string, task: () => Promise<void>): void => {
    if (stopped) {
      return;
    }
    void workTracker
      .run(async () => {
        await task().catch((error) => {
          logError("runtime-loop", "Background task failed", {
            task: name,
            error,
          });
        });
      })
      .catch((error) => {
        logError("runtime-loop", "Tracked background task failed", {
          task: name,
          error,
        });
      });
  };

  run("thread_closer", () =>
    runAcrossEnabledGuilds(
      client,
      runtime,
      "thread_closer",
      runThreadCloser,
      inFlightGuildTasks,
    ),
  );
  run("retention_cleaner", () =>
    runAcrossEnabledGuilds(
      client,
      runtime,
      "retention_cleaner",
      runRetentionCleaner,
      inFlightGuildTasks,
    ),
  );
  run("silence_reconciler", () =>
    reconcileSilenceLeasesAcrossGuilds(client, runtime, inFlightGuildTasks),
  );

  intervals.push(
    setInterval(
      () =>
        run("thread_closer", () =>
          runAcrossEnabledGuilds(
            client,
            runtime,
            "thread_closer",
            runThreadCloser,
            inFlightGuildTasks,
          ),
        ),
      10 * 60_000,
    ),
  );
  intervals.push(
    setInterval(
      () =>
        run("retention_cleaner", () =>
          runAcrossEnabledGuilds(
            client,
            runtime,
            "retention_cleaner",
            runRetentionCleaner,
            inFlightGuildTasks,
          ),
        ),
      24 * 60 * 60_000,
    ),
  );
  intervals.push(
    setInterval(
      () =>
        run("silence_reconciler", () =>
          reconcileSilenceLeasesAcrossGuilds(
            client,
            runtime,
            inFlightGuildTasks,
          ),
        ),
      SILENCE_RECONCILE_INTERVAL_MS,
    ),
  );

  return {
    get stopped(): boolean {
      return stopped;
    },
    stop(): void {
      if (stopped) {
        return;
      }
      stopped = true;
      for (const interval of intervals) {
        clearInterval(interval);
      }
    },
    drain(timeoutMs: number): Promise<boolean> {
      return workTracker.drain(timeoutMs);
    },
  };
}

export async function runAcrossEnabledGuilds(
  client: Client,
  runtime: ProcessBotRuntime,
  taskName: string,
  task: (guild: Guild, guildRuntime: GuildRuntime) => Promise<void>,
  inFlightGuildTasks: Set<string> = defaultInFlightGuildTasks,
): Promise<void> {
  const records = runtime.storage.listEnabledGuilds();
  const concurrency = Math.max(
    1,
    Math.min(runtime.processConfig.schedulerConcurrency, records.length || 1),
  );
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < records.length) {
      const record = records[nextIndex];
      nextIndex += 1;
      if (!record) {
        continue;
      }
      const guildId = record.guildId;
      const inFlightKey = `${taskName}:${guildId}`;
      if (inFlightGuildTasks.has(inFlightKey)) {
        continue;
      }
      inFlightGuildTasks.add(inFlightKey);
      try {
        const guildRuntime = await runtime.forGuild(guildId);
        if (!guildRuntime?.settings.enabled || !guildRuntime.isCurrent()) {
          continue;
        }
        const guild = await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) {
          continue;
        }
        await task(guild, guildRuntime);
      } catch (error) {
        logError("runtime-loop", "Guild background task failed", {
          task: taskName,
          guildId,
          error,
        });
      } finally {
        inFlightGuildTasks.delete(inFlightKey);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

async function reconcileSilenceLeasesAcrossGuilds(
  client: Client,
  runtime: ProcessBotRuntime,
  inFlightGuildTasks: Set<string>,
): Promise<void> {
  const records = runtime.storage.listActiveGuilds();
  const concurrency = Math.max(
    1,
    Math.min(runtime.processConfig.schedulerConcurrency, records.length || 1),
  );
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < records.length) {
      const record = records[nextIndex];
      nextIndex += 1;
      if (!record) {
        continue;
      }
      const inFlightKey = `silence_reconciler:${record.guildId}`;
      if (inFlightGuildTasks.has(inFlightKey)) {
        continue;
      }
      inFlightGuildTasks.add(inFlightKey);
      try {
        const guildRuntime = await runtime.forGuild(record.guildId);
        if (
          !guildRuntime ||
          readSilenceLeases(guildRuntime.storage).length === 0
        ) {
          continue;
        }
        const guild =
          client.guilds.cache.get(record.guildId) ??
          (await client.guilds.fetch(record.guildId).catch(() => null));
        if (!guild) {
          continue;
        }
        const result = await silenceLeaseCoordinator.reconcileGuild(
          guildRuntime.storage,
          record.guildId,
          Date.now(),
          (lease) => resolveSilenceOverwriteTarget(guild, lease),
        );
        if (result.unresolved > 0) {
          logError(
            "silence-lock",
            "Could not reconcile silence overwrites; check Manage Roles permission and role hierarchy",
            {
              guildId: record.guildId,
              unresolved: result.unresolved,
            },
          );
        }
      } catch (error) {
        logError("silence-lock", "Silence lease reconciliation failed", {
          guildId: record.guildId,
          error,
        });
      } finally {
        inFlightGuildTasks.delete(inFlightKey);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

export async function restoreAllSilenceLeases(
  guild: Guild,
  runtime: GuildRuntime,
): Promise<{
  restored: number;
  unresolved: number;
}> {
  const result = await silenceLeaseCoordinator.restoreAll(
    runtime.storage,
    runtime.guildId,
    (lease) => resolveSilenceOverwriteTarget(guild, lease),
  );
  return {
    restored: result.restored,
    unresolved: result.unresolved,
  };
}

async function resolveSilenceOverwriteTarget(
  guild: Guild,
  lease: SilenceLease,
): Promise<SilenceTargetResolution> {
  let channel = guild.channels.cache.get(lease.channelId) ?? null;
  if (!channel) {
    try {
      channel = await guild.channels.fetch(lease.channelId);
    } catch (error) {
      return isDefinitivelyMissingDiscordTarget(error)
        ? SILENCE_TARGET_DELETED
        : null;
    }
    if (!channel) {
      return SILENCE_TARGET_DELETED;
    }
  }
  if (!(channel instanceof TextChannel)) {
    return null;
  }

  let role = guild.roles.cache.get(lease.roleId) ?? null;
  if (!role) {
    try {
      role = await guild.roles.fetch(lease.roleId);
    } catch (error) {
      return isDefinitivelyMissingDiscordTarget(error)
        ? SILENCE_TARGET_DELETED
        : null;
    }
    if (!role) {
      return SILENCE_TARGET_DELETED;
    }
  }
  return createSilenceOverwriteTarget(channel, role);
}

function isDefinitivelyMissingDiscordTarget(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: unknown; status?: unknown };
  return (
    candidate.status === 404 ||
    candidate.code === 10003 ||
    candidate.code === 10011 ||
    candidate.code === "10003" ||
    candidate.code === "10011"
  );
}

function getSendMessagesState(
  channel: TextChannel,
  roleId: string,
): SendMessagesState {
  const overwrite = channel.permissionOverwrites.cache.get(roleId);
  if (overwrite?.allow.has(PermissionFlagsBits.SendMessages)) {
    return true;
  }
  if (overwrite?.deny.has(PermissionFlagsBits.SendMessages)) {
    return false;
  }
  return null;
}

function createSilenceOverwriteTarget(
  channel: TextChannel,
  role: Role,
): SilenceOverwriteTarget {
  return {
    readSendMessages: () => getSendMessagesState(channel, role.id),
    async writeSendMessages(value, reason): Promise<void> {
      await channel.permissionOverwrites.edit(
        role,
        { SendMessages: value },
        { reason },
      );
    },
  };
}

async function runAutoPoster(guild: Guild, runtime: BotRuntime): Promise<void> {
  if (!runtime.settings.features.court || !runtime.isCurrent()) {
    return;
  }
  const state = runtime.storage.getState();
  const now = runtime.now();
  const metrics = runtime.storage.metricsSnapshot();

  if (
    !shouldRunAutoPosterNow(
      {
        mode: runtime.settings.courtSchedule.mode,
        hour: runtime.settings.courtSchedule.hour,
        minute: runtime.settings.courtSchedule.minute,
        dryRun: runtime.settings.courtSchedule.dryRun,
        lastDryRunDate: state.last_dry_run_date,
      },
      now,
      metrics.last_successful_auto_post,
    )
  ) {
    return;
  }

  const today = now.toFormat("yyyy-LL-dd");

  const channel = await resolveTargetChannel(guild, runtime);
  if (!channel || !runtime.isCurrent()) {
    return;
  }

  try {
    if (runtime.settings.courtSchedule.dryRun) {
      const [chosenCategory, question] = runtime.storage.pickQuestion(
        null,
        true,
        runtime.randomInt,
      );
      runtime.storage.updateStateAtomic((mutable) => {
        mutable.last_dry_run_date = today;
      });

      await sendRuntimeLog(
        guild,
        runtime,
        "Court Auto-Post Dry Run",
        `**Channel:** ${channel.toString()}\n**Category:** \`${chosenCategory}\`\n**Question:** ${question}`,
        channel.id,
      );
      return;
    }

    const [chosenCategory, question] = await postQuestionFromLoop(
      channel,
      runtime,
      {
        category: null,
        randomize: true,
        source: "auto",
        mentionEveryone: true,
      },
    );

    await sendRuntimeLog(
      guild,
      runtime,
      "Court Question Auto-Posted",
      `**Channel:** ${channel.toString()}\n**Category:** \`${chosenCategory}\`\n**Question:** ${question}`,
      channel.id,
    );
  } catch (error) {
    await sendFailureAlert(
      guild,
      runtime,
      "Court Auto-Post Failed",
      asError(error),
      "auto_poster loop",
      channel.id,
    );
  }
}

export interface AutoPosterState {
  mode: "off" | "manual" | "auto";
  hour: number;
  minute: number;
  dryRun: boolean;
  lastDryRunDate: string | null;
}

export function shouldRunAutoPosterNow(
  state: AutoPosterState,
  now: DateTime,
  lastSuccessfulAutoPostIso: string | null,
): boolean {
  if (state.mode !== "auto") {
    return false;
  }

  const today = now.toFormat("yyyy-LL-dd");
  if (state.dryRun && state.lastDryRunDate === today) {
    return false;
  }

  const scheduledAt = now.set({
    hour: state.hour,
    minute: state.minute,
    second: 0,
    millisecond: 0,
  });
  if (now < scheduledAt) {
    return false;
  }

  const runtimeZone = now.zoneName ?? "local";
  const lastAutoPostDate = getIsoDateInZone(
    lastSuccessfulAutoPostIso,
    runtimeZone,
  );
  return lastAutoPostDate !== today;
}

function getIsoDateInZone(value: string | null, zone: string): string | null {
  if (!value) {
    return null;
  }

  const parsed = DateTime.fromISO(value, { setZone: true });
  if (!parsed.isValid) {
    return null;
  }

  const zoned = parsed.setZone(zone);
  const effective = zoned.isValid ? zoned : parsed;
  return effective.toFormat("yyyy-LL-dd");
}

export async function runThreadCloser(
  guild: Guild,
  runtime: BotRuntime,
): Promise<void> {
  if (!runtime.isCurrent()) {
    return;
  }

  const now = runtime.now();
  for (const record of runtime.storage.listPostRecords(false)) {
    if (!runtime.isCurrent()) {
      return;
    }
    if (record.closed) {
      continue;
    }

    const deadline = getPostCloseDeadline(record);
    if (!deadline || deadline > now) {
      continue;
    }

    try {
      const closed = await closeCourtPostFromLoop(
        record,
        runtime,
        guild,
        "expired",
      );
      if (closed) {
        await sendRuntimeLog(
          guild,
          runtime,
          "Legacy Inquiry Auto-Closed",
          `**Message ID:** \`${record.message_id}\`\n**Question:** ${record.question}`,
          record.channel_id,
        );
      }
    } catch (error) {
      await sendFailureAlert(
        guild,
        runtime,
        "Legacy Inquiry Thread Auto-Close Failed",
        asError(error),
        "thread_closer loop",
        record.channel_id,
      );
    }
  }
}

export async function runWeeklyDigest(
  guild: Guild,
  runtime: BotRuntime,
): Promise<void> {
  if (!runtime.settings.features.weeklyDigest || !runtime.isCurrent()) {
    return;
  }

  const now = runtime.now();
  const weekday = getDiscordWeekday(now);
  if (
    weekday !== runtime.settings.weeklyDigestSchedule.weekday ||
    now.hour !== runtime.settings.weeklyDigestSchedule.hour
  ) {
    return;
  }

  const weekKey = getWeekKey(now);
  const state = runtime.storage.getState();
  if (state.last_weekly_digest_week === weekKey) {
    return;
  }

  const channel = await resolveWeeklyDigestChannel(guild, runtime);
  if (!channel || !runtime.isCurrent()) {
    return;
  }

  try {
    await channel.send({ embeds: [buildWeeklyDigestEmbed(runtime)] });
    if (runtime.isCurrent()) {
      runtime.storage.updateStateAtomic((mutable) => {
        mutable.last_weekly_digest_week = weekKey;
      });
    }
  } catch (error) {
    await sendFailureAlert(
      guild,
      runtime,
      "Weekly Digest Failed",
      asError(error),
      "weekly_digest loop",
      channel.id,
    );
  }
}

/** Convert Luxon's Monday=1..Sunday=7 numbering to Discord setup's Sunday=0. */
export function getDiscordWeekday(now: DateTime): number {
  return now.weekday % 7;
}

export async function runRetentionCleaner(
  guild: Guild,
  runtime: BotRuntime,
): Promise<void> {
  if (!runtime.isCurrent()) {
    return;
  }

  const removed = runtime.storage.purgeExpiredAnswers(
    runtime.settings.limits.answerRetentionDays,
  );

  if (removed <= 0) {
    return;
  }

  await sendRuntimeLog(
    guild,
    runtime,
    "Answer Retention Cleanup",
    `Removed \`${removed}\` answer record(s) older than \`${runtime.settings.limits.answerRetentionDays}\` day(s).`,
  );
}

function buildWeeklyDigestEmbed(runtime: BotRuntime): EmbedBuilder {
  const now = runtime.now();
  const metrics = runtime.storage.metricsSnapshot();
  const posts = runtime.storage.listPostRecords(true, POST_RECORD_LIMIT);
  const answersTotal = runtime.storage.countAllAnswerRecords();
  const openPosts = posts.filter((post) => !post.closed);
  const unansweredOpen = openPosts.filter(
    (post) => runtime.storage.countAnswersForQuestion(post.message_id) === 0,
  );
  const postCount = Math.max(posts.length, 1);

  const topCategories = Object.entries(metrics.posts_by_category)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3);
  const topCategoryText =
    topCategories
      .map(([category, count]) => `- \`${category}\`: \`${count}\``)
      .join("\n") || "No data yet.";

  const usageTotal = Object.values(metrics.command_usage).reduce(
    (sum, value) => sum + value,
    0,
  );
  const failureTotal = Object.values(metrics.command_failures).reduce(
    (sum, value) => sum + value,
    0,
  );
  const failureRate = usageTotal > 0 ? (failureTotal / usageTotal) * 100 : 0;

  return new EmbedBuilder()
    .setTitle("Weekly Court Digest")
    .setDescription(`Week \`${getWeekKey(now)}\` performance summary.`)
    .setColor(ROLE_COLOR)
    .setTimestamp(now.toJSDate())
    .addFields(
      {
        name: "Posts & Answers",
        value:
          `**Posts (recent window):** \`${posts.length}\`\n` +
          `**Open Inquiries:** \`${openPosts.length}\`\n` +
          `**Unanswered Open:** \`${unansweredOpen.length}\`\n` +
          `**Answer Records:** \`${answersTotal}\`\n` +
          `**Avg Answers/Post:** \`${(answersTotal / postCount).toFixed(2)}\``,
        inline: false,
      },
      {
        name: "Top Categories",
        value: topCategoryText,
        inline: false,
      },
      {
        name: "Command Reliability",
        value:
          `**Command Invocations:** \`${usageTotal}\`\n` +
          `**Command Failures:** \`${failureTotal}\`\n` +
          `**Failure Rate:** \`${failureRate.toFixed(2)}%\``,
        inline: false,
      },
    );
}

async function postQuestionFromLoop(
  channel: RuntimeTargetChannel,
  runtime: BotRuntime,
  options: {
    category: string | null;
    randomize: boolean;
    source: "auto" | "manual" | "custom";
    mentionEveryone: boolean;
  },
): Promise<[string, string]> {
  if (!runtime.isCurrent()) {
    throw new Error(
      "Court post cancelled because the guild configuration changed.",
    );
  }
  const [chosenCategory, question] = runtime.storage.pickQuestion(
    options.category,
    options.randomize,
    runtime.randomInt,
  );
  const embed = buildCourtEmbed(chosenCategory, question, runtime);
  const mentionPayload = buildAnnouncementMentions(options.mentionEveryone);

  const sent = await channel.send({
    ...(mentionPayload.content === null
      ? {}
      : { content: mentionPayload.content }),
    embeds: [embed],
    components: runtime.settings.features.anonymousAnswers
      ? buildAnonymousAnswerComponents()
      : [],
    allowedMentions: mentionPayload.allowedMentions,
  });

  if (!runtime.isCurrent()) {
    throw new Error(
      "Court post cancelled because the guild configuration changed.",
    );
  }

  const thread = runtime.settings.features.anonymousAnswers
    ? await getOrCreateAnswerThread(sent, question, runtime)
    : null;
  if (!runtime.isCurrent()) {
    throw new Error(
      "Court post cancelled because the guild configuration changed.",
    );
  }
  runtime.storage.upsertPostRow({
    message_id: String(sent.id),
    thread_id: thread?.id ?? null,
    channel_id: String(channel.id),
    category: chosenCategory,
    question,
    posted_at: isoNow(runtime.settings.timezone),
    close_after_hours: THREAD_CLOSE_HOURS,
    closed: false,
    closed_at: null,
    close_reason: null,
  });

  runtime.storage.registerUsedQuestion(question);
  runtime.storage.recordPostMetric(chosenCategory, options.source);
  runtime.storage.updateStateAtomic((state) => {
    state.last_posted_date = runtime.now().toFormat("yyyy-LL-dd");
  });

  return [chosenCategory, question];
}

async function closeCourtPostFromLoop(
  record: PostRecord,
  runtime: BotRuntime,
  guild: Guild,
  reason: string,
): Promise<boolean> {
  if (record.closed) {
    return false;
  }

  if (!runtime.isCurrent()) {
    return false;
  }

  const thread = await fetchThreadById(guild, record.thread_id);
  if (record.thread_id && !thread) {
    throw new Error(
      "Stored court thread does not belong to this guild or is missing",
    );
  }

  const message = await getPostMessage(guild, record);
  if (!message) {
    throw new Error(
      "Stored court message does not belong to this guild or is missing",
    );
  }

  if (thread) {
    if (!runtime.isCurrent()) {
      return false;
    }
    await thread.edit({ archived: true, locked: true });
    if (!runtime.isCurrent()) {
      return false;
    }
  }
  if (!runtime.isCurrent()) {
    return false;
  }
  await message.edit({
    components: runtime.settings.features.anonymousAnswers
      ? buildClosedAnswerComponents()
      : [],
  });

  if (!runtime.isCurrent()) {
    return false;
  }
  runtime.storage.markPostClosed(record.message_id, reason);
  return true;
}

function buildCourtEmbed(
  category: string,
  question: string,
  runtime: BotRuntime,
): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("Imperial Court Inquiry")
    .setDescription(
      `*The throne demands an answer.*\n\n**Question:** ${question}`,
    )
    .setColor(ROLE_COLOR)
    .setTimestamp(runtime.now().toJSDate())
    .setFooter({ text: `Category: ${category}` });
}

function buildAnonymousAnswerComponents(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(ANON_ANSWER_BUTTON_ID)
        .setLabel("Answer Anonymously")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function buildClosedAnswerComponents(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${ANON_ANSWER_BUTTON_ID}:closed`)
        .setLabel("Court Inquiry Closed")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
    ),
  ];
}

function makeThreadName(question: string): string {
  const cleaned = question
    .split("")
    .filter((character) => /[a-zA-Z0-9\s\-_]/.test(character))
    .join("")
    .trim();
  const normalized = cleaned.split(/\s+/).join("-");
  const name = normalized ? `court-${normalized}` : "court-replies";
  return name.slice(0, 100);
}

async function getOrCreateAnswerThread(
  message: Message,
  question: string,
  runtime: BotRuntime,
): Promise<AnyThreadChannel | null> {
  if (!message.guild || !runtime.isCurrent()) {
    return null;
  }

  const cached = message.guild.channels.cache.get(message.id);
  if (cached?.isThread()) {
    runtime.storage.updatePostThreadId(message.id, cached.id);
    return cached;
  }

  const existingRecord = runtime.storage.getPostRecord(message.id);
  if (existingRecord?.thread_id) {
    const fetched = await fetchChannelById(
      message.guild,
      existingRecord.thread_id,
    );
    if (fetched?.isThread() && runtime.isCurrent()) {
      runtime.storage.updatePostThreadId(message.id, fetched.id);
      return fetched;
    }
  }

  const fetchedByMessageId = await fetchChannelById(message.guild, message.id);
  if (fetchedByMessageId?.isThread() && runtime.isCurrent()) {
    runtime.storage.updatePostThreadId(message.id, fetchedByMessageId.id);
    return fetchedByMessageId;
  }

  if (!runtime.isCurrent()) {
    return null;
  }
  const thread = await message
    .startThread({
      name: makeThreadName(question),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    })
    .catch(async () => {
      if (!runtime.isCurrent()) {
        return null;
      }
      return message
        .startThread({ name: makeThreadName(question) })
        .catch(() => null);
    });

  if (!thread || !runtime.isCurrent()) {
    return null;
  }

  runtime.storage.updatePostThreadId(message.id, thread.id);
  if (!runtime.isCurrent()) {
    return null;
  }
  await thread
    .send(
      "**Anonymous Court Replies**\n" +
        "- One anonymous answer per person\n" +
        "- Stay on topic\n" +
        "- Anonymous does not mean consequence-free\n" +
        `- This thread will close automatically after ${THREAD_CLOSE_HOURS} hours`,
    )
    .catch(() => null);

  return thread;
}

function isAdmin(member: GuildMember): boolean {
  return (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.guild.ownerId === member.id
  );
}

function getInvocationTerms(runtime: BotRuntime): string[] {
  return [
    runtime.settings.invocation.keyword,
    ...runtime.settings.invocation.aliases,
  ];
}

function buildSuperiorChatResponse(
  intent: SuperiorChatIntent,
  member: GuildMember,
  runtime: BotRuntime,
  gatewayPingMs: number,
  clientUptimeMs: number | null,
): string {
  const memberMention = member.toString();
  const currentTimeText = runtime.now().toFormat("yyyy-LL-dd HH:mm ZZZZ");
  const invocation = escapeInlineCode(runtime.settings.invocation.keyword);

  switch (intent.type) {
    case "greeting": {
      const greetings = [
        `Hi ${memberMention}! What can I help with?`,
        `Hello ${memberMention}!`,
        `Hey ${memberMention}! How can I help?`,
      ];
      return (
        greetings[runtime.randomInt(greetings.length)] ??
        `Hi ${memberMention}! What can I help with?`
      );
    }
    case "help":
      return [
        `Try these ${invocation} phrases:`,
        `- \`hi ${invocation}\``,
        `- \`${invocation} help\``,
        `- \`${invocation} ping\` / \`${invocation} uptime\``,
        `- \`${invocation} about\``,
        `- \`${invocation} flip a coin\``,
        `- \`${invocation} roll 2d6\``,
        `- \`${invocation} choose tea or coffee\``,
        `- \`${invocation} what time is it\``,
        `- \`thanks ${invocation}\``,
        `- \`good night ${invocation}\``,
      ].join("\n");
    case "coinflip":
      return runtime.randomInt(2) === 0 ? "🪙 **Heads!**" : "🪙 **Tails!**";
    case "time":
      return `It is \`${currentTimeText}\` in this server's configured timezone (\`${runtime.settings.timezone}\`).`;
    case "thanks":
      return "You're welcome!";
    case "farewell":
      return "See you later!";
    case "ping": {
      const normalizedPing =
        Number.isFinite(gatewayPingMs) && gatewayPingMs >= 0
          ? Math.round(gatewayPingMs)
          : null;
      return normalizedPing === null
        ? "🏓 Pong! Gateway latency is not available yet."
        : `🏓 Pong! Gateway latency: \`${normalizedPing} ms\`.`;
    }
    case "uptime":
      return clientUptimeMs === null ||
        !Number.isFinite(clientUptimeMs) ||
        clientUptimeMs < 0
        ? "Uptime is not available yet."
        : `Uptime: \`${formatSuperiorUptime(clientUptimeMs)}\`.`;
    case "about":
      return `Superior \`v${runtime.botVersion}\` is a configurable multi-server Discord utility and moderation bot. Say \`${invocation} help\` to see conversational utilities.`;
    case "dice": {
      const rolls = Array.from(
        { length: intent.count },
        () => runtime.randomInt(intent.sides) + 1,
      );
      const total = rolls.reduce((sum, roll) => sum + roll, 0);
      return intent.count === 1
        ? `🎲 Rolled **d${intent.sides}**: **${total}**.`
        : `🎲 Rolled **${intent.count}d${intent.sides}**: ${rolls.join(" + ")} = **${total}**.`;
    }
    case "choice": {
      const selected =
        intent.options[runtime.randomInt(intent.options.length)] ??
        intent.options[0];
      return selected
        ? `I choose **${escapeMarkdown(selected)}**.`
        : `Give me at least two choices, such as \`${invocation} choose tea or coffee\`.`;
    }
    case "invalid":
      return buildSuperiorChatValidationResponse(intent, invocation);
  }
}

function buildSuperiorChatValidationResponse(
  intent: Extract<SuperiorChatIntent, { type: "invalid" }>,
  invocation: string,
): string {
  switch (intent.error) {
    case "dice_format":
      return `Use dice notation such as \`${invocation} roll 2d6\`.`;
    case "dice_count":
      return "Roll between 1 and 20 dice at a time.";
    case "dice_sides":
      return "Dice must have between 2 and 1,000 sides.";
    case "choice_count":
      return `Give me between 2 and 20 choices, such as \`${invocation} choose tea or coffee\`.`;
    case "choice_length":
      return "Keep each choice to 100 characters or fewer.";
  }
}

function formatSuperiorUptime(uptimeMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(uptimeMs / 1_000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [
    days > 0 ? `${days}d` : null,
    hours > 0 ? `${hours}h` : null,
    minutes > 0 ? `${minutes}m` : null,
    seconds > 0 || totalSeconds === 0 ? `${seconds}s` : null,
  ].filter((part): part is string => part !== null);
  return parts.join(" ");
}

async function maybeSendSuperiorChatResponse(
  message: Message,
  member: GuildMember,
  runtime: BotRuntime,
): Promise<boolean> {
  const botUserId = message.client.user?.id;
  const intent = parseSuperiorChatIntent(message.content, [
    ...getInvocationTerms(runtime),
    ...(botUserId ? [`<@${botUserId}>`, `<@!${botUserId}>`] : []),
  ]);
  if (!intent) {
    return false;
  }

  if (!runtime.isCurrent() || !isSendableChannel(message.channel)) {
    return false;
  }

  const response = buildSuperiorChatResponse(
    intent,
    member,
    runtime,
    message.client.ws.ping,
    message.client.uptime,
  );

  await message.channel
    .send({ content: response, allowedMentions: { parse: [] } })
    .catch(() => null);
  return true;
}

export async function lockChannelSilently(
  channel: TextChannel,
  actor: GuildMember,
  runtime: BotRuntime,
  seconds: number,
): Promise<void> {
  const targetRoleIds = getEffectiveSilenceTargetRoleIds(
    runtime.settings.roles.silenceTargets,
    runtime.settings.roles.silenceExcludes,
  );
  const targetRoles = targetRoleIds
    .map((roleId) => actor.guild.roles.cache.get(roleId) ?? null)
    .filter((role): role is Role => role !== null);
  const expiresAt = Date.now() + Math.max(0, seconds) * 1000;

  for (const role of targetRoles) {
    if (!runtime.isCurrent()) {
      break;
    }
    const applied = await silenceLeaseCoordinator.apply(
      runtime.storage,
      runtime.guildId,
      channel.id,
      role.id,
      expiresAt,
      createSilenceOverwriteTarget(channel, role),
      `Silence by ${actor.user.tag}`,
    );
    if (!applied) {
      logError(
        "silence-lock",
        "Could not apply silence overwrite; check Manage Roles permission and role hierarchy",
        {
          guildId: runtime.guildId,
          channelId: channel.id,
          roleId: role.id,
        },
      );
    }
  }
}

async function handleReplyMuteTrigger(
  message: Message,
  actor: GuildMember,
  reasonText: string,
  runtime: BotRuntime,
): Promise<void> {
  const target = await getRepliedMember(message);
  if (!target || !message.guild) {
    return;
  }

  const me =
    message.guild.members.me ??
    (await message.guild.members.fetchMe().catch(() => null));
  if (!me || !runtime.isCurrent()) {
    return;
  }

  const [allowed, whyNot] = canTimeoutTarget(actor, me, target);
  if (!allowed) {
    await sendMuteFailedEmbed(message, target, whyNot);
    return;
  }

  const timeoutDurationMs = REPLY_MUTE_MINUTES * 60_000;
  const modReason = buildTimeoutReason(
    "Muted",
    actor,
    reasonText || "reply command",
  );

  if (!runtime.isCurrent()) {
    return;
  }
  const timeoutSuccess = await target
    .timeout(timeoutDurationMs, modReason)
    .then(() => true)
    .catch(() => false);
  if (!timeoutSuccess) {
    if (runtime.isCurrent()) {
      await sendMuteFailedEmbed(message, target, "discord API error");
    }
    return;
  }

  if (!runtime.isCurrent()) {
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle("Superior Mute")
    .setDescription(
      `${target.toString()} has been muted for \`${REPLY_MUTE_MINUTES}\` minute(s).`,
    )
    .setColor(ROLE_COLOR)
    .setTimestamp(runtime.now().toJSDate())
    .addFields(
      { name: "By", value: actor.toString(), inline: true },
      {
        name: "Reason",
        value: reasonText || "No reason provided.",
        inline: true,
      },
    );

  if (isSendableChannel(message.channel)) {
    await message.channel.send({ embeds: [embed] }).catch(() => null);
  }

  await sendRuntimeLog(
    message.guild,
    runtime,
    "Reply Mute Triggered",
    `**By:** ${actor.toString()}\n**Target:** ${target.toString()}\n**Minutes:** \`${REPLY_MUTE_MINUTES}\`\n**Reason:** ${reasonText || "No reason provided."}`,
    String(message.channel.id),
  );
}

async function sendMuteFailedEmbed(
  message: Message,
  target: GuildMember,
  reason: string,
): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle("Mute Failed")
    .setDescription(`Could not mute ${target.toString()}: ${reason}.`)
    .setColor(ROLE_COLOR)
    .setTimestamp(new Date());

  await message
    .reply({ embeds: [embed], allowedMentions: { repliedUser: false } })
    .catch(() => null);
}

async function getRepliedMember(message: Message): Promise<GuildMember | null> {
  const referenceId = message.reference?.messageId;
  if (!referenceId || !message.guild || !message.channel.isTextBased()) {
    return null;
  }

  const targetMessage = await message
    .fetchReference()
    .catch(async () =>
      message.channel.isTextBased()
        ? message.channel.messages.fetch(referenceId).catch(() => null)
        : null,
    );

  if (!targetMessage?.author || targetMessage.guildId !== message.guild.id) {
    return null;
  }

  return message.guild.members.fetch(targetMessage.author.id).catch(() => null);
}

function canTimeoutTarget(
  actor: GuildMember,
  me: GuildMember,
  target: GuildMember,
): [boolean, string] {
  if (target.user.bot) {
    return [false, "target is a bot"];
  }
  if (target.id === me.id) {
    return [false, "target is the bot"];
  }
  if (target.id === actor.guild.ownerId) {
    return [false, "target is the server owner"];
  }
  if (target.id === actor.id) {
    return [false, "target is yourself"];
  }
  if (!me.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    return [false, "bot lacks Moderate Members permission"];
  }
  if (me.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
    return [false, "bot role is not high enough"];
  }

  const actorIsOwner = actor.id === actor.guild.ownerId;
  if (
    !actorIsOwner &&
    actor.roles.highest.comparePositionTo(target.roles.highest) <= 0
  ) {
    return [false, "your role is not high enough"];
  }
  if (!target.moderatable) {
    return [false, "target is not moderatable by the bot"];
  }

  return [true, ""];
}

function buildTimeoutReason(
  action: string,
  user: GuildMember,
  reason: string | null,
): string {
  const base = `${action} by ${user.user.tag} via Superior chat`;
  if (!reason) {
    return base;
  }

  return `${base} | ${reason}`;
}

export function __canTimeoutTargetForTests(
  actor: GuildMember,
  me: GuildMember,
  target: GuildMember,
): [boolean, string] {
  return canTimeoutTarget(actor, me, target);
}

async function resolveMessageMember(
  message: Message,
): Promise<GuildMember | null> {
  if (!message.guild) {
    return null;
  }

  if (message.member) {
    return message.member;
  }

  return message.guild.members.fetch(message.author.id).catch(() => null);
}

async function resolveTargetChannel(
  guild: Guild,
  runtime: BotRuntime,
): Promise<RuntimeTargetChannel | null> {
  const candidates = [runtime.settings.channels.court ?? ""];

  for (const candidate of candidates) {
    if (!/^\d+$/.test(candidate) || candidate === "0") {
      continue;
    }

    const resolved = await getOrFetchRuntimeTargetChannel(guild, candidate);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

async function resolveWeeklyDigestChannel(
  guild: Guild,
  runtime: BotRuntime,
): Promise<RuntimeTargetChannel | null> {
  if (runtime.settings.channels.weeklyDigest) {
    const channel = await getOrFetchRuntimeTargetChannel(
      guild,
      runtime.settings.channels.weeklyDigest,
    );
    if (channel) {
      return channel;
    }
  }

  const logDestination = await resolveLogDestination(guild, runtime);
  return logDestination;
}

async function sendRuntimeLog(
  guild: Guild,
  runtime: BotRuntime,
  title: string,
  description: string,
  fallbackChannelId?: string,
): Promise<boolean> {
  if (!runtime.isCurrent()) {
    return false;
  }
  const destination = await resolveLogDestination(
    guild,
    runtime,
    fallbackChannelId,
  );
  if (!destination || !runtime.isCurrent()) {
    return false;
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(ROLE_COLOR)
    .setTimestamp(runtime.now().toJSDate());

  const sent = await destination
    .send({ embeds: [embed] })
    .then(() => true)
    .catch(() => false);
  return sent;
}

async function sendFailureAlert(
  guild: Guild | null,
  runtime: BotRuntime,
  title: string,
  error: Error,
  context: string,
  fallbackChannelId?: string,
): Promise<void> {
  logError("runtime-alert", title, {
    guildId: guild?.id ?? runtime.guildId,
    context,
    error,
  });
  if (!guild) {
    return;
  }

  const description = `**Context:** ${context}\n**Error Type:** \`${error.name}\`\n**Error:** \`${error.message.slice(0, 1000)}\``;
  await sendRuntimeLog(guild, runtime, title, description, fallbackChannelId);
}

async function resolveLogDestination(
  guild: Guild,
  runtime: BotRuntime,
  fallbackChannelId?: string,
): Promise<RuntimeTargetChannel | null> {
  const candidates = [
    runtime.settings.channels.log ?? "",
    fallbackChannelId ?? "",
  ];

  for (const candidate of candidates) {
    if (!/^\d+$/.test(candidate) || candidate === "0") {
      continue;
    }

    const fetched = await fetchChannelById(guild, candidate);
    if (isRuntimeTargetChannel(fetched)) {
      return fetched;
    }
  }

  return null;
}

async function getOrFetchRuntimeTargetChannel(
  guild: Guild,
  channelId: string,
): Promise<RuntimeTargetChannel | null> {
  const cached = guild.channels.cache.get(channelId);
  if (isRuntimeTargetChannel(cached) && cached.guildId === guild.id) {
    return cached;
  }

  const fetched = await guild.channels.fetch(channelId).catch(() => null);
  return isRuntimeTargetChannel(fetched) && fetched.guildId === guild.id
    ? fetched
    : null;
}

async function fetchChannelById(
  guild: Guild,
  channelId: string,
): Promise<Channel | null> {
  if (!/^\d+$/.test(channelId)) {
    return null;
  }

  const cached = guild.channels.cache.get(channelId);
  if (cached) {
    return cached.guildId === guild.id ? cached : null;
  }

  const fetched = await guild.channels.fetch(channelId).catch(() => null);
  return fetched?.guildId === guild.id ? fetched : null;
}

async function fetchThreadById(
  guild: Guild,
  threadId: string | null | undefined,
): Promise<AnyThreadChannel | null> {
  if (!threadId) {
    return null;
  }

  const fetched = await fetchChannelById(guild, threadId);
  return fetched?.isThread() ? fetched : null;
}

async function getPostMessage(
  guild: Guild,
  record: PostRecord,
): Promise<Message | null> {
  const channel = await fetchChannelById(guild, record.channel_id);
  if (!channel?.isTextBased()) {
    return null;
  }

  const message = await channel.messages
    .fetch(record.message_id)
    .catch(() => null);
  return message?.guildId === guild.id ? message : null;
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === "string") {
    return new Error(error);
  }

  if (
    typeof error === "number" ||
    typeof error === "boolean" ||
    typeof error === "bigint"
  ) {
    return new Error(`${error}`);
  }

  if (error === null || error === undefined) {
    return new Error("Unknown error");
  }

  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error("Unknown non-serializable error");
  }
}

function isSendableChannel(
  channel: unknown,
): channel is { send: (payload: unknown) => Promise<unknown> } {
  return typeof (channel as { send?: unknown } | null)?.send === "function";
}

function isRuntimeTargetChannel(
  channel: unknown,
): channel is RuntimeTargetChannel {
  if (channel instanceof TextChannel || channel instanceof NewsChannel) {
    return true;
  }

  if (!channel || typeof channel !== "object") {
    return false;
  }

  const maybeThreadChannel = channel as { isThread?: () => boolean };
  return (
    typeof maybeThreadChannel.isThread === "function" &&
    maybeThreadChannel.isThread()
  );
}
