import {
  ChannelType,
  escapeMarkdown,
  type Guild,
  type GuildBasedChannel,
  type GuildTextBasedChannel,
  type Message,
  type ThreadChannel,
} from "discord.js";
import type {
  SuggestionConfiguration,
  SuggestionDeliveryInput,
  SuggestionDeliveryResult,
  SuggestionRecord,
  SuggestionVoteCounts,
} from "../types.js";
import {
  buildSuggestionPublicPayload,
  buildSuggestionReviewRow,
} from "./suggestion-components.js";

export interface SuggestionDeliveryStorage {
  bindSuggestionDelivery(
    suggestionId: string,
    input: SuggestionDeliveryInput,
  ): SuggestionDeliveryResult;
  failSuggestionDelivery(
    suggestionId: string,
    reason: string,
  ): SuggestionDeliveryResult;
  markSuggestionDeliveryMissing(
    suggestionId: string,
    actorId?: string | null,
  ): SuggestionDeliveryResult;
  getSuggestionConfiguration?(): SuggestionConfiguration | null;
  getSuggestionById?(suggestionId: string): SuggestionRecord | null;
  getSuggestionVoteCounts(suggestionId: string): SuggestionVoteCounts;
}

export interface SuggestionPublishResult {
  suggestion: SuggestionRecord;
  message: Message;
}

export async function publishReservedSuggestion(
  guild: Guild,
  channel: GuildTextBasedChannel,
  configuration: SuggestionConfiguration,
  suggestion: SuggestionRecord,
  storage: SuggestionDeliveryStorage,
  isCurrent: () => boolean = () => true,
): Promise<SuggestionPublishResult> {
  if (
    guild.id !== suggestion.guildId ||
    channel.guild.id !== guild.id ||
    configuration.guildId !== guild.id ||
    !configuration.enabled ||
    channel.id !== configuration.suggestionChannelId
  ) {
    throw new Error(
      "Suggestion delivery resources do not belong to this server.",
    );
  }
  const counts = storage.getSuggestionVoteCounts(suggestion.suggestionId);
  let message: Message | null = null;
  let thread: ThreadChannel | null = null;
  try {
    if (!isCurrent()) {
      throw new Error(
        "Suggestion delivery was cancelled because this server changed.",
      );
    }
    message = await channel.send(
      buildSuggestionPublicPayload(suggestion, counts),
    );
    if (!isCurrent()) {
      throw new Error(
        "Suggestion delivery was cancelled because this server changed.",
      );
    }
    if (
      configuration.createThreads &&
      ["open", "under-review"].includes(suggestion.state) &&
      channel.type === ChannelType.GuildText
    ) {
      thread = await message
        .startThread({
          name: `Suggestion ${suggestion.suggestionNumber}: ${suggestion.title}`.slice(
            0,
            100,
          ),
          autoArchiveDuration: 1_440,
          reason: `Superior suggestion #${suggestion.suggestionNumber} discussion`,
        })
        .catch(() => null);
    }
    if (
      !isCurrent() ||
      !isCurrentSuggestionConfiguration(storage, configuration)
    ) {
      throw new Error("Suggestion configuration changed during delivery.");
    }
    const bound = storage.bindSuggestionDelivery(suggestion.suggestionId, {
      channelId: channel.id,
      messageId: message.id,
      threadId: thread?.id ?? null,
      expectedUpdatedAt: suggestion.updatedAt,
    });
    if (bound.status !== "posted" && bound.status !== "already-posted") {
      throw new Error(
        "Suggestion message binding changed before it could be saved.",
      );
    }
    if (
      bound.status === "already-posted" &&
      bound.suggestion.messageId !== message.id
    ) {
      const duplicate = message;
      message = null;
      await duplicate.delete().catch(() => undefined);
      throw new Error(
        "Another recovery operation already posted this suggestion.",
      );
    }
    return { suggestion: bound.suggestion, message };
  } catch (error) {
    if (thread)
      await thread
        .delete("Suggestion delivery rollback")
        .catch(() => undefined);
    if (message) await message.delete().catch(() => undefined);
    const latestFailure =
      errorMessage(error).trim().slice(0, 1_000) ||
      "Suggestion delivery failed.";
    if (isCurrent()) {
      try {
        storage.failSuggestionDelivery(suggestion.suggestionId, latestFailure);
      } catch {
        // Preserve the Discord delivery error; recovery can inspect the reservation.
      }
    }
    throw error;
  }
}

export async function refreshSuggestionPublicMessage(
  guild: Guild,
  suggestion: SuggestionRecord,
  storage: SuggestionDeliveryStorage,
  actorId?: string | null,
  configuration?: SuggestionConfiguration | null,
  isCurrent: () => boolean = () => true,
): Promise<"updated" | "missing" | "unavailable"> {
  let expected = suggestion;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!isCurrent()) return "unavailable";
    const latest = storage.getSuggestionById?.(expected.suggestionId);
    if (latest) {
      if (latest.guildId !== guild.id) return "unavailable";
      expected = latest;
    }
    const result = await refreshSuggestionOnce(
      guild,
      expected,
      storage,
      actorId,
      configuration,
      isCurrent,
    );
    if (result === "changed") continue;
    if (result !== "updated" || !isCurrent()) return result;
    const after = storage.getSuggestionById?.(expected.suggestionId);
    if (!after || sameSuggestionDeliverySnapshot(expected, after)) {
      return "updated";
    }
    expected = after;
  }
  return "unavailable";
}

async function refreshSuggestionOnce(
  guild: Guild,
  suggestion: SuggestionRecord,
  storage: SuggestionDeliveryStorage,
  actorId: string | null | undefined,
  configuration: SuggestionConfiguration | null | undefined,
  isCurrent: () => boolean,
): Promise<"updated" | "missing" | "unavailable" | "changed"> {
  if (
    suggestion.guildId !== guild.id ||
    !suggestion.channelId ||
    !suggestion.messageId
  ) {
    return "unavailable";
  }
  let channel: GuildBasedChannel | null;
  try {
    channel = await guild.channels.fetch(suggestion.channelId, {
      cache: true,
      force: true,
    });
  } catch (error) {
    if (!isUnknownDiscordResource(error, 10_003)) return "unavailable";
    channel = null;
  }
  if (!isGuildTextChannel(channel, guild.id)) {
    return markSuggestionMissing(storage, suggestion, actorId, isCurrent);
  }
  let message: Message | null;
  try {
    message = await channel.messages.fetch(suggestion.messageId);
  } catch (error) {
    if (!isUnknownDiscordResource(error, 10_008)) return "unavailable";
    message = null;
  }
  if (!message || message.author.id !== guild.client.user?.id) {
    return markSuggestionMissing(storage, suggestion, actorId, isCurrent);
  }
  if (
    configuration &&
    !isCurrentSuggestionConfiguration(storage, configuration)
  ) {
    return "unavailable";
  }
  if (!isCurrent()) return "unavailable";
  const renderedCounts = storage.getSuggestionVoteCounts(
    suggestion.suggestionId,
  );
  try {
    await message.edit(
      buildSuggestionPublicPayload(suggestion, renderedCounts),
    );
  } catch (error) {
    return isUnknownDiscordResource(error, 10_008)
      ? markSuggestionMissing(storage, suggestion, actorId, isCurrent)
      : "unavailable";
  }
  if (!isCurrent()) return "unavailable";
  const latestSuggestion = storage.getSuggestionById?.(suggestion.suggestionId);
  if (
    (latestSuggestion &&
      !sameSuggestionDeliverySnapshot(suggestion, latestSuggestion)) ||
    !sameSuggestionVoteCounts(
      renderedCounts,
      storage.getSuggestionVoteCounts(suggestion.suggestionId),
    )
  ) {
    return "changed";
  }
  if (
    configuration &&
    !isCurrentSuggestionConfiguration(storage, configuration)
  ) {
    return "unavailable";
  }
  if (
    configuration?.createThreads &&
    ["open", "under-review"].includes(suggestion.state) &&
    channel.type === ChannelType.GuildText
  ) {
    const threadResult = await ensureSuggestionThread(
      guild,
      channel,
      message,
      suggestion,
      storage,
      isCurrent,
    );
    if (threadResult !== "updated") return threadResult;
  }
  if (
    suggestion.threadId &&
    !["open", "under-review"].includes(suggestion.state)
  ) {
    const thread = await guild.channels
      .fetch(suggestion.threadId, { cache: true, force: true })
      .catch(() => null);
    if (thread?.isThread() && !thread.archived) {
      if (!isCurrent()) return "unavailable";
      await thread
        .setArchived(true, "Suggestion review completed")
        .catch(() => undefined);
    }
  }
  return "updated";
}

export async function postSuggestionReviewEntry(
  channel: GuildTextBasedChannel | null,
  suggestion: SuggestionRecord,
  counts: SuggestionVoteCounts,
  configuration: SuggestionConfiguration,
  storage: SuggestionDeliveryStorage,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  if (!channel) return;
  if (
    channel.guild.id !== suggestion.guildId ||
    configuration.guildId !== suggestion.guildId ||
    configuration.reviewChannelId !== channel.id ||
    !configuration.enabled ||
    !isCurrent() ||
    !storage.getSuggestionConfiguration ||
    !isCurrentSuggestionConfiguration(storage, configuration)
  ) {
    return;
  }
  const payload = buildSuggestionPublicPayload(suggestion, counts);
  const message = await channel
    .send({
      ...payload,
      components: [buildSuggestionReviewRow(suggestion.suggestionId)],
    })
    .catch(() => null);
  if (
    message &&
    (!isCurrent() ||
      !storage.getSuggestionConfiguration ||
      !isCurrentSuggestionConfiguration(storage, configuration))
  ) {
    await message.delete().catch(() => undefined);
  }
}

export async function notifySuggestionAuthor(
  guild: Guild,
  suggestion: SuggestionRecord,
): Promise<void> {
  const author = await guild.client.users
    .fetch(suggestion.authorId)
    .catch(() => null);
  if (!author || author.bot) return;
  const reason = suggestion.reviewReason
    ? `\nReason: ${suggestion.reviewReason}`
    : "";
  await author
    .send({
      content:
        `Your suggestion #${suggestion.suggestionNumber} (**${escapeMarkdown(suggestion.title)}**) is now **${suggestion.state}**.${reason}`.slice(
          0,
          2_000,
        ),
      allowedMentions: { parse: [] },
    })
    .catch(() => undefined);
}

function isGuildTextChannel(
  channel: unknown,
  guildId: string,
): channel is GuildTextBasedChannel {
  if (!channel || typeof channel !== "object") return false;
  const candidate = channel as GuildTextBasedChannel;
  return Boolean(
    candidate.guild?.id === guildId &&
    (candidate.type === ChannelType.GuildText ||
      candidate.type === ChannelType.GuildAnnouncement) &&
    !candidate.isDMBased(),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Suggestion delivery failed.";
}

async function ensureSuggestionThread(
  guild: Guild,
  channel: GuildTextBasedChannel,
  message: Message,
  suggestion: SuggestionRecord,
  storage: SuggestionDeliveryStorage,
  isCurrent: () => boolean,
): Promise<"updated" | "unavailable"> {
  let thread: GuildBasedChannel | null = null;
  if (suggestion.threadId) {
    try {
      thread = await guild.channels.fetch(suggestion.threadId, {
        cache: true,
        force: true,
      });
    } catch (error) {
      if (!isUnknownDiscordResource(error, 10_003)) return "unavailable";
    }
  }
  if (!thread && message.thread?.guild.id === guild.id) {
    thread = message.thread;
  }
  let created = false;
  if (!thread?.isThread() || thread.guild.id !== guild.id) {
    if (!isCurrent()) return "unavailable";
    try {
      thread = await message.startThread({
        name: `Suggestion ${suggestion.suggestionNumber}: ${suggestion.title}`.slice(
          0,
          100,
        ),
        autoArchiveDuration: 1_440,
        reason: `Superior suggestion #${suggestion.suggestionNumber} discussion recovery`,
      });
      created = true;
    } catch {
      return "unavailable";
    }
  }
  if (thread.archived) {
    if (!isCurrent()) {
      if (created)
        await thread.delete("Stale suggestion recovery").catch(() => undefined);
      return "unavailable";
    }
    try {
      await thread.setArchived(false, "Suggestion discussion recovered");
    } catch {
      return "unavailable";
    }
  }
  if (thread.id === suggestion.threadId) return "updated";
  if (!isCurrent()) {
    if (created)
      await thread.delete("Stale suggestion recovery").catch(() => undefined);
    return "unavailable";
  }
  const rebound = storage.bindSuggestionDelivery(suggestion.suggestionId, {
    channelId: channel.id,
    messageId: message.id,
    threadId: thread.id,
    expectedUpdatedAt: suggestion.updatedAt,
  });
  if (
    (rebound.status === "posted" || rebound.status === "already-posted") &&
    rebound.suggestion.threadId === thread.id
  ) {
    return "updated";
  }
  if (created)
    await thread
      .delete("Concurrent suggestion recovery")
      .catch(() => undefined);
  return "unavailable";
}

function markSuggestionMissing(
  storage: SuggestionDeliveryStorage,
  suggestion: SuggestionRecord,
  actorId?: string | null,
  isCurrent: () => boolean = () => true,
): "missing" | "unavailable" {
  const latest = storage.getSuggestionById?.(suggestion.suggestionId);
  if (
    latest &&
    (latest.updatedAt !== suggestion.updatedAt ||
      latest.channelId !== suggestion.channelId ||
      latest.messageId !== suggestion.messageId ||
      latest.deliveryState !== "posted")
  ) {
    return "unavailable";
  }
  if (!isCurrent()) return "unavailable";
  const result = storage.markSuggestionDeliveryMissing(
    suggestion.suggestionId,
    actorId,
  );
  return result.status === "missing" || result.status === "already-missing"
    ? "missing"
    : "unavailable";
}

function sameSuggestionDeliverySnapshot(
  expected: SuggestionRecord,
  current: SuggestionRecord,
): boolean {
  return (
    expected.guildId === current.guildId &&
    expected.state === current.state &&
    expected.deliveryState === current.deliveryState &&
    expected.channelId === current.channelId &&
    expected.messageId === current.messageId &&
    expected.threadId === current.threadId &&
    expected.reviewerId === current.reviewerId &&
    expected.reviewReason === current.reviewReason &&
    expected.updatedAt === current.updatedAt
  );
}

function sameSuggestionVoteCounts(
  expected: SuggestionVoteCounts,
  current: SuggestionVoteCounts,
): boolean {
  return (
    expected.upvotes === current.upvotes &&
    expected.downvotes === current.downvotes &&
    expected.score === current.score
  );
}

function isUnknownDiscordResource(
  error: unknown,
  expectedCode: number,
): boolean {
  if (!error || typeof error !== "object") return false;
  return Number((error as { code?: unknown }).code) === expectedCode;
}

function isCurrentSuggestionConfiguration(
  storage: SuggestionDeliveryStorage,
  expected: SuggestionConfiguration,
): boolean {
  if (!storage.getSuggestionConfiguration) return true;
  const current = storage.getSuggestionConfiguration();
  return Boolean(
    current &&
    current.guildId === expected.guildId &&
    current.updatedAt === expected.updatedAt &&
    current.enabled === expected.enabled &&
    current.suggestionChannelId === expected.suggestionChannelId &&
    current.reviewChannelId === expected.reviewChannelId &&
    current.reviewerRoleId === expected.reviewerRoleId &&
    current.createThreads === expected.createThreads &&
    current.bindingsVerifiedAt === expected.bindingsVerifiedAt,
  );
}
