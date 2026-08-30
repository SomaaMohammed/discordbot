import {
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildMember,
  type Message,
  type MessageMentionOptions,
  type MessageReaction,
  type PartialMessage,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from "discord.js";
import {
  parseConversationIntent,
  parseReplyModerationRequest,
  type ConversationAddressOptions,
  type ReplyModerationRequest,
} from "./conversation.js";
import { classifyError } from "./errors.js";
import { logError, logInfo } from "./logging.js";
import { buildConversationReply, escapeUserText } from "./reply-catalog.js";
import type { BotRuntime, GuildRuntime } from "./runtime.js";
import { AsyncWorkTracker } from "./discord/work-tracker.js";
import {
  fetchCurrentBotMember,
  fetchGuildMemberCoalesced,
} from "./discord/fetch-coalescing.js";
import { describeMudaeDeliveryFailure } from "./mudae-watch-delivery.js";
import type { PrivateMudaeWatcher } from "./mudae-watch-service.js";
import type {
  ModerationCase,
  ModerationCaseAttemptInput,
  ModerationCaseTransitionResult,
  UserActivityMetric,
} from "./types.js";
import { processAntiSpamMessage } from "./discord/anti-spam-enforcement.js";
import { deliverModerationCaseLog } from "./discord/moderation-log-delivery.js";
import { runModerationTargetAction } from "./discord/moderation-action-queue.js";

export const REPLY_MODERATION_MINUTES = 1;
const DISCORD_AUDIT_REASON_LIMIT = 512;

export const SAFE_ALLOWED_MENTIONS: MessageMentionOptions = Object.freeze({
  parse: [],
  repliedUser: false,
});

interface ActiveMessageSettings {
  enabled: boolean;
  timezone: string;
  channels: {
    log: string | null;
  };
  invocation: {
    keyword: string;
    aliases: string[];
  };
}

interface MetricStorage {
  recordCommandMetric: (commandName: string, success?: boolean) => unknown;
  incrementUserMetric: (
    userId: string,
    metricName: UserActivityMetric,
    amount?: number,
  ) => unknown;
}

interface ReplyModerationCaseStorage {
  getModerationConfiguration(): {
    guildId: string;
    casesEnabled: boolean;
    updatedAt: string;
  } | null;
  reserveModerationCaseAttempt(
    input: ModerationCaseAttemptInput,
  ): ModerationCase;
  confirmModerationCase(
    caseId: string,
    input: {
      actorId: string;
      status: "active";
      discordActionMetadata?: unknown;
      expectedUpdatedAt?: string;
    },
  ): ModerationCaseTransitionResult;
  failModerationCaseAttempt(
    caseId: string,
    input: { actorId: string; failureCode: string; expectedUpdatedAt?: string },
  ): ModerationCaseTransitionResult;
}

interface SendableGuildChannel {
  guildId: string;
  send: (payload: {
    content: string;
    allowedMentions: MessageMentionOptions;
  }) => Promise<unknown>;
  permissionsFor?: (
    member: GuildMember,
  ) => { has: (permission: bigint) => boolean } | null;
  isThread?: () => boolean;
}

export function wireMessageRuntime(
  client: Client,
  runtime: BotRuntime,
  workTracker: AsyncWorkTracker = new AsyncWorkTracker(),
): void {
  client.on("messageCreate", (message) =>
    workTracker
      .run(() => handleMessageCreate(message, runtime))
      .catch((error) => {
        logError("message-runtime", "Tracked message event failed", {
          guildId: message.guildId ?? "dm",
          error,
        });
      }),
  );

  client.on("messageUpdate", (oldMessage, newMessage) =>
    workTracker
      .run(() => handleMessageUpdate(oldMessage, newMessage, runtime))
      .catch((error) => {
        logPrivateMudaeRuntimeFailure(
          "Tracked private watcher update failed",
          error,
        );
      }),
  );

  client.on("messageReactionAdd", (reaction, user) =>
    workTracker
      .run(() => handleReactionAdd(reaction, user, runtime))
      .catch((error) => {
        logError("message-runtime", "Tracked reaction event failed", {
          guildId: reaction.message.guildId ?? "dm",
          error,
        });
      }),
  );
}

export async function handleMessageCreate(
  message: Message,
  processRuntime: BotRuntime,
): Promise<void> {
  if (message.author.bot) {
    await processPrivateMudaeMessage(
      message,
      processRuntime.privateMudaeWatcher ?? null,
    );
    return;
  }

  await processRuntime.emojiReplies?.processMessage(message).catch((error) => {
    logError("emoji-replies", "Configured emoji processing failed", {
      guildId: message.guildId ?? "dm",
      messageId: message.id,
      error,
    });
  });

  const guildId = message.guildId;
  const guild = message.guild;
  if (
    !guildId ||
    !guild ||
    guild.id !== guildId ||
    !isChannelInGuild(message.channel, guildId)
  ) {
    return;
  }

  const runtime = await processRuntime.forGuild(guildId);
  if (!isActiveGuildRuntime(runtime, guildId)) {
    return;
  }
  const settings = getActiveSettings(runtime);
  if (!settings.enabled) {
    return;
  }

  const antiSpamOutcome = await processAntiSpamMessage(message, runtime).catch(
    (error) => {
      const classified = classifyError(error);
      logError(
        "anti-spam",
        "Anti-spam processing failed without stopping chat",
        {
          guildId,
          stage: "message-create",
          category: classified.category,
          ...(classified.code === null ? {} : { code: classified.code }),
          retryable: classified.retryable,
        },
      );
      return "continue" as const;
    },
  );
  if (antiSpamOutcome !== "continue" || !runtime.isCurrent()) {
    return;
  }

  const member = await resolveMessageMember(message, guildId);
  if (!member || !runtime.isCurrent()) {
    return;
  }

  try {
    const addressOptions = buildAddressOptions(message, settings, false);
    const moderation = parseReplyModerationRequest(
      message.content,
      addressOptions,
    );
    if (moderation) {
      if (isGuildAdministrator(member, guildId)) {
        await handleReplyModeration(message, member, moderation, runtime);
      }
      return;
    }

    if (!runtime.isCurrent()) {
      return;
    }

    let intent = parseConversationIntent(message.content, addressOptions);
    if (!intent && message.reference?.messageId) {
      const referenced = await fetchReferencedMessage(message, guildId);
      const botUserId = message.client.user?.id ?? null;
      const replyToBot = Boolean(
        referenced?.author && botUserId && referenced.author.id === botUserId,
      );
      if (!runtime.isCurrent()) {
        return;
      }
      intent = parseConversationIntent(
        message.content,
        buildAddressOptions(message, settings, replyToBot),
      );
    }
    if (!intent || !runtime.isCurrent()) {
      return;
    }

    const me = await resolveBotMember(guild, guildId);
    if (!me || !canSendInMessageChannel(message, me, guildId)) {
      return;
    }

    const response = buildConversationReply(intent, {
      guildId,
      invocation: settings.invocation.keyword,
      botVersion: runtime.botVersion,
      timezone: settings.timezone,
      currentTime: runtime.now().toFormat("yyyy-LL-dd HH:mm ZZZZ"),
      gatewayPingMs: normalizeFiniteNumber(message.client.ws.ping),
      uptimeMs: normalizeFiniteNumber(message.client.uptime),
      randomInt: runtime.randomInt,
    });
    const replied = await sendPrimaryReply(message, response);
    if (replied && runtime.isCurrent()) {
      recordCommandMetricSafely(runtime, `superior.chat.${intent.type}`);
    }
  } finally {
    if (runtime.isCurrent()) {
      incrementUserMetricSafely(runtime, member.id, "messages_sent");
    }
  }
}

export async function handleMessageUpdate(
  oldMessage: Message | PartialMessage,
  newMessage: Message | PartialMessage,
  processRuntime: BotRuntime,
): Promise<void> {
  const watcher = processRuntime.privateMudaeWatcher;
  if (
    !watcher?.enabled ||
    !watcher.isConfiguredLocation(newMessage.guildId, newMessage.channelId)
  ) {
    return;
  }

  const knownAuthors = [newMessage.author, oldMessage.author].filter(
    (author) => author !== null,
  );
  if (knownAuthors.some((author) => !watcher.isTrustedAuthor(author))) {
    return;
  }

  let message: Message;
  if (newMessage.partial) {
    const fetched = await newMessage.fetch().catch((error) => {
      logPrivateMudaeRuntimeFailure(
        "Private watcher could not fetch an updated message",
        error,
      );
      return null;
    });
    if (!fetched) {
      return;
    }
    message = fetched;
  } else {
    message = newMessage;
  }

  await processPrivateMudaeMessage(message, watcher);
}

export async function handleReactionAdd(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  processRuntime: BotRuntime,
): Promise<void> {
  if (user.bot) {
    return;
  }
  const guildId = reaction.message.guildId;
  if (!guildId) {
    return;
  }

  const runtime = await processRuntime.forGuild(guildId);
  if (!isActiveGuildRuntime(runtime, guildId)) {
    return;
  }
  const settings = getActiveSettings(runtime);
  if (!settings.enabled) {
    return;
  }

  const message = reaction.message.partial
    ? await reaction.message.fetch().catch(() => null)
    : reaction.message;
  if (
    !message?.guild ||
    message.guild.id !== guildId ||
    message.guildId !== guildId ||
    !isChannelInGuild(message.channel, guildId) ||
    !runtime.isCurrent()
  ) {
    return;
  }

  incrementUserMetricSafely(runtime, user.id, "reactions_sent");
  if (message.author && !message.author.bot && runtime.isCurrent()) {
    incrementUserMetricSafely(runtime, message.author.id, "reactions_received");
  }
}

async function handleReplyModeration(
  message: Message,
  actor: GuildMember,
  request: ReplyModerationRequest,
  runtime: GuildRuntime,
): Promise<void> {
  const guild = message.guild;
  if (
    !guild ||
    message.guildId !== runtime.guildId ||
    guild.id !== runtime.guildId
  ) {
    return;
  }

  const me = await resolveBotMember(guild, runtime.guildId);
  if (!me || !canSendInMessageChannel(message, me, runtime.guildId)) {
    return;
  }

  if (request.type === "invalid") {
    const replied = await sendPrimaryReply(
      message,
      `Keep the moderation reason to ${request.maximumLength} characters or fewer. No timeout was applied.`,
    );
    if (replied && runtime.isCurrent()) {
      recordCommandMetricSafely(runtime, "superior.reply_moderation", false);
    }
    return;
  }

  const targetMessage = await fetchReferencedMessage(message, runtime.guildId);
  if (!targetMessage?.author || !runtime.isCurrent()) {
    const replied = await sendPrimaryReply(
      message,
      "Reply to a member’s message when using this moderation request. No timeout was applied.",
    );
    if (replied && runtime.isCurrent()) {
      recordCommandMetricSafely(runtime, "superior.reply_moderation", false);
    }
    return;
  }

  const target = await resolveReferencedMember(
    guild,
    targetMessage,
    runtime.guildId,
  );
  if (!target || !runtime.isCurrent()) {
    const replied = await sendPrimaryReply(
      message,
      "I could not resolve that member. No timeout was applied.",
    );
    if (replied && runtime.isCurrent()) {
      recordCommandMetricSafely(runtime, "superior.reply_moderation", false);
    }
    return;
  }

  await runModerationTargetAction(runtime.guildId, target.id, () =>
    applyReplyModerationTimeout(message, actor, target, request, runtime, me),
  );
}

async function applyReplyModerationTimeout(
  message: Message,
  actor: GuildMember,
  target: GuildMember,
  request: Extract<ReplyModerationRequest, { type: "timeout" }>,
  runtime: GuildRuntime,
  initialBot: GuildMember,
): Promise<void> {
  const guild = message.guild!;
  const eligibility = canTimeoutTarget(actor, initialBot, target);
  if (!eligibility.allowed) {
    const replied = await sendPrimaryReply(
      message,
      `I could not time out ${target.toString()}: ${eligibility.reason}. No timeout was applied.`,
    );
    if (replied && runtime.isCurrent()) {
      recordCommandMetricSafely(runtime, "superior.reply_moderation", false);
    }
    return;
  }

  const storage: ReplyModerationCaseStorage = runtime.storage;
  const configuration = storage.getModerationConfiguration();
  if (
    !configuration?.casesEnabled ||
    configuration.guildId !== runtime.guildId
  ) {
    await sendPrimaryReply(
      message,
      "Moderation cases are disabled, so no reply timeout was applied.",
    );
    return;
  }
  const freshActor = await fetchGuildMemberCoalesced(guild, actor.id, {
    cache: true,
    force: true,
  });
  const [freshTarget, freshBot] = await Promise.all([
    fetchGuildMemberCoalesced(guild, target.id, {
      cache: true,
      force: true,
    }),
    fetchCurrentBotMember(guild, { force: true }),
  ]);
  const latestConfiguration = storage.getModerationConfiguration();
  const freshEligibility =
    freshActor && freshBot && freshTarget
      ? canTimeoutTarget(freshActor, freshBot, freshTarget)
      : { allowed: false as const, reason: "current members unavailable" };
  if (
    !freshActor ||
    !freshTarget ||
    !freshBot ||
    !freshEligibility.allowed ||
    freshTarget.isCommunicationDisabled() ||
    latestConfiguration?.updatedAt !== configuration.updatedAt ||
    !runtime.isCurrent()
  ) {
    await sendPrimaryReply(
      message,
      `The final member, hierarchy, timeout, or case configuration check failed${freshEligibility.allowed ? "" : `: ${freshEligibility.reason}`}. No timeout was applied.`,
    );
    return;
  }

  const timeoutReason = buildAuditReason(freshActor, request.reason);
  let attempt: ModerationCase;
  try {
    attempt = storage.reserveModerationCaseAttempt({
      targetUserId: freshTarget.id,
      actorId: freshActor.id,
      actionType: "timeout",
      source: "superior-command",
      publicReason: request.reason || "Reply moderation timeout.",
      privateNote: null,
      discordActionMetadata: {
        requestedDurationSeconds: REPLY_MODERATION_MINUTES * 60,
        sourceMessageId: message.id,
      },
      relatedCaseId: null,
    });
  } catch (error) {
    logError("reply-moderation", "Reply timeout case reservation failed", {
      guildId: runtime.guildId,
      actorId: freshActor.id,
      targetId: freshTarget.id,
      error,
    });
    await sendPrimaryReply(
      message,
      "Superior could not reserve a durable moderation case, so no timeout was applied.",
    );
    return;
  }
  const applied = await freshTarget
    .timeout(REPLY_MODERATION_MINUTES * 60_000, timeoutReason)
    .then(() => true)
    .catch((error) => {
      safeFailReplyModerationAttempt(
        storage,
        attempt,
        freshActor.id,
        "discord-timeout-failed",
        runtime.guildId,
      );
      logError("reply-moderation", "Discord rejected a reply timeout", {
        guildId: runtime.guildId,
        actorId: freshActor.id,
        targetId: freshTarget.id,
        error,
      });
      return false;
    });
  if (!applied) {
    const replied = await sendPrimaryReply(
      message,
      `Discord did not apply the timeout to ${freshTarget.toString()}. No timeout was applied.`,
    );
    if (replied && runtime.isCurrent()) {
      recordCommandMetricSafely(runtime, "superior.reply_moderation", false);
    }
    return;
  }

  const confirmedTarget = await guild.members
    .fetch({ user: freshTarget.id, cache: true, force: true })
    .catch(() => null);
  if (!confirmedTarget?.isCommunicationDisabled()) {
    safeFailReplyModerationAttempt(
      storage,
      attempt,
      freshActor.id,
      "timeout-state-unconfirmed",
      runtime.guildId,
    );
    await sendPrimaryReply(
      message,
      `Discord did not unambiguously confirm the timeout. Attempt case #${attempt.caseNumber} needs recovery.`,
    );
    return;
  }
  let confirmed: ModerationCaseTransitionResult;
  try {
    confirmed = storage.confirmModerationCase(attempt.caseId, {
      actorId: freshActor.id,
      status: "active",
      discordActionMetadata: {
        requestedDurationSeconds: REPLY_MODERATION_MINUTES * 60,
        sourceMessageId: message.id,
        expiresAt:
          confirmedTarget.communicationDisabledUntil?.toISOString() ?? null,
      },
      expectedUpdatedAt: attempt.updatedAt,
    });
  } catch (error) {
    logError("reply-moderation", "Reply timeout confirmation failed", {
      guildId: runtime.guildId,
      actorId: freshActor.id,
      targetId: freshTarget.id,
      caseId: attempt.caseId,
      error,
    });
    await sendPrimaryReply(
      message,
      `Discord applied the timeout, but attempt case #${attempt.caseNumber} needs persistence recovery.`,
    );
    return;
  }
  if (confirmed.status !== "changed" && confirmed.status !== "unchanged") {
    await sendPrimaryReply(
      message,
      `Discord applied the timeout, but attempt case #${attempt.caseNumber} needs persistence recovery.`,
    );
    return;
  }
  const logDelivery = await deliverModerationCaseLog(
    guild,
    runtime,
    confirmed.case,
  ).catch(() => "failed" as const);

  const settingsChanged = !runtime.isCurrent();
  const reasonText = request.reason
    ? ` Reason: ${escapeUserText(request.reason)}.`
    : "";
  const confirmation =
    `${freshTarget.toString()} was timed out for ${REPLY_MODERATION_MINUTES} minute. Case #${confirmed.case.caseNumber} was recorded.` +
    reasonText +
    (settingsChanged
      ? " The action completed before server settings changed."
      : "") +
    (logDelivery === "failed" || logDelivery === "unavailable"
      ? " The case is saved, but moderation-log delivery needs recovery."
      : "");
  const replied = await sendPrimaryReply(message, confirmation);
  if (!replied) {
    logError(
      "reply-moderation",
      "Timeout was applied but the confirmation reply failed",
      {
        guildId: runtime.guildId,
        actorId: freshActor.id,
        targetId: freshTarget.id,
      },
    );
    return;
  }

  if (runtime.isCurrent()) {
    recordCommandMetricSafely(runtime, "superior.reply_moderation");
  } else {
    logInfo(
      "reply-moderation",
      "Timeout applied while guild settings were invalidated",
      {
        guildId: runtime.guildId,
        actorId: freshActor.id,
        targetId: freshTarget.id,
      },
    );
  }
}

function safeFailReplyModerationAttempt(
  storage: ReplyModerationCaseStorage,
  attempt: ModerationCase,
  actorId: string,
  failureCode: string,
  guildId: string,
): void {
  try {
    storage.failModerationCaseAttempt(attempt.caseId, {
      actorId,
      failureCode,
      expectedUpdatedAt: attempt.updatedAt,
    });
  } catch (error) {
    logError("reply-moderation", "Reply timeout failure checkpoint failed", {
      guildId,
      actorId,
      caseId: attempt.caseId,
      failureCode,
      error,
    });
  }
}

export function canTimeoutTarget(
  actor: GuildMember,
  me: GuildMember,
  target: GuildMember,
): { allowed: true; reason: "" } | { allowed: false; reason: string } {
  const guildId = actor.guild.id;
  if (me.guild.id !== guildId || target.guild.id !== guildId) {
    return { allowed: false, reason: "guild context mismatch" };
  }
  if (!isGuildAdministrator(actor, guildId)) {
    return { allowed: false, reason: "Administrator permission is required" };
  }
  if (target.user.bot) {
    return { allowed: false, reason: "the target is a bot" };
  }
  if (target.id === me.id) {
    return { allowed: false, reason: "the target is this bot" };
  }
  if (target.id === actor.guild.ownerId) {
    return { allowed: false, reason: "the server owner cannot be timed out" };
  }
  if (target.id === actor.id) {
    return { allowed: false, reason: "you cannot target yourself" };
  }
  if (!me.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    return {
      allowed: false,
      reason: "the bot lacks Moderate Members permission",
    };
  }
  if (me.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
    return { allowed: false, reason: "the bot role is not high enough" };
  }

  const actorIsOwner = actor.id === actor.guild.ownerId;
  if (
    !actorIsOwner &&
    actor.roles.highest.comparePositionTo(target.roles.highest) <= 0
  ) {
    return { allowed: false, reason: "your role is not high enough" };
  }
  if (!target.moderatable) {
    return {
      allowed: false,
      reason: "Discord reports that the target is not moderatable",
    };
  }
  return { allowed: true, reason: "" };
}

function buildAddressOptions(
  message: Message,
  settings: ActiveMessageSettings,
  replyToBot: boolean,
): ConversationAddressOptions {
  return {
    invocationTerms: [
      settings.invocation.keyword,
      ...settings.invocation.aliases,
    ],
    botUserId: message.client.user?.id ?? null,
    replyToBot,
  };
}

function isActiveGuildRuntime(
  runtime: GuildRuntime | null,
  guildId: string,
): runtime is GuildRuntime {
  return Boolean(
    runtime &&
    runtime.guildId === guildId &&
    runtime.isCurrent() &&
    /^\d{17,20}$/.test(guildId),
  );
}

function getActiveSettings(runtime: GuildRuntime): ActiveMessageSettings {
  return runtime.settings as unknown as ActiveMessageSettings;
}

function getMetricStorage(runtime: GuildRuntime): MetricStorage {
  return runtime.storage as unknown as MetricStorage;
}

function isGuildAdministrator(member: GuildMember, guildId: string): boolean {
  return (
    member.guild.id === guildId &&
    (member.id === member.guild.ownerId ||
      member.permissions.has(PermissionFlagsBits.Administrator))
  );
}

async function resolveMessageMember(
  message: Message,
  guildId: string,
): Promise<GuildMember | null> {
  const cached = message.member;
  if (
    cached &&
    cached.id === message.author.id &&
    cached.guild.id === guildId
  ) {
    return cached;
  }
  const fetched = await message.guild?.members
    .fetch(message.author.id)
    .catch(() => null);
  return fetched?.guild.id === guildId && fetched.id === message.author.id
    ? fetched
    : null;
}

async function resolveBotMember(
  guild: Guild,
  guildId: string,
): Promise<GuildMember | null> {
  if (guild.id !== guildId) {
    return null;
  }
  const member = await fetchCurrentBotMember(guild);
  return member?.guild.id === guildId ? member : null;
}

async function fetchReferencedMessage(
  message: Message,
  guildId: string,
): Promise<Message | null> {
  const messageId = message.reference?.messageId;
  if (!messageId || !message.channelId || message.guildId !== guildId) {
    return null;
  }
  const referenced = await message
    .fetchReference()
    .catch(() => message.channel.messages.fetch(messageId).catch(() => null));
  if (
    !referenced ||
    referenced.guildId !== guildId ||
    referenced.guild?.id !== guildId ||
    referenced.channelId !== message.channelId ||
    !isChannelInGuild(referenced.channel, guildId)
  ) {
    return null;
  }
  return referenced;
}

async function resolveReferencedMember(
  guild: Guild,
  message: Message,
  guildId: string,
): Promise<GuildMember | null> {
  if (guild.id !== guildId || message.guildId !== guildId || !message.author) {
    return null;
  }
  if (
    message.member?.guild.id === guildId &&
    message.member.id === message.author.id
  ) {
    return message.member;
  }
  const target = await fetchGuildMemberCoalesced(guild, message.author.id, {
    cache: true,
    force: false,
    input: "id",
  });
  return target?.guild.id === guildId && target.id === message.author.id
    ? target
    : null;
}

function canSendInMessageChannel(
  message: Message,
  me: GuildMember,
  guildId: string,
): boolean {
  if (!isChannelInGuild(message.channel, guildId)) {
    return false;
  }
  const channel = message.channel as unknown as SendableGuildChannel;
  if (typeof channel.permissionsFor !== "function") {
    return false;
  }
  const permissions = channel.permissionsFor(me);
  if (!permissions?.has(PermissionFlagsBits.ViewChannel)) {
    return false;
  }
  const sendPermission = channel.isThread?.()
    ? PermissionFlagsBits.SendMessagesInThreads
    : PermissionFlagsBits.SendMessages;
  return permissions.has(sendPermission);
}

async function sendPrimaryReply(
  message: Message,
  content: string,
): Promise<boolean> {
  return message
    .reply({
      content: content.slice(0, 2_000),
      allowedMentions: SAFE_ALLOWED_MENTIONS,
    })
    .then(() => true)
    .catch((error) => {
      logError("message-runtime", "Could not send primary reply", {
        guildId: message.guildId ?? "dm",
        messageId: message.id,
        error,
      });
      return false;
    });
}

async function sendModerationAudit(
  guild: Guild,
  runtime: GuildRuntime,
  actor: GuildMember,
  target: GuildMember,
  reason: string,
): Promise<void> {
  const settings = getActiveSettings(runtime);
  const logChannelId = settings.channels.log;
  if (!logChannelId || !runtime.isCurrent()) {
    return;
  }
  const channel =
    guild.channels.cache.get(logChannelId) ??
    (await guild.channels.fetch(logChannelId).catch(() => null));
  if (!isSendableGuildChannel(channel, guild.id) || !runtime.isCurrent()) {
    return;
  }
  const me = await resolveBotMember(guild, guild.id);
  if (!me || !canSendInGuildChannel(channel, me)) {
    return;
  }
  const reasonText = reason ? escapeUserText(reason) : "No reason provided";
  await channel
    .send({
      content:
        `Reply moderation applied by ${actor.toString()} to ${target.toString()} ` +
        `for ${REPLY_MODERATION_MINUTES} minute. Reason: ${reasonText}.`,
      allowedMentions: SAFE_ALLOWED_MENTIONS,
    })
    .catch((error) => {
      logError("reply-moderation", "Could not send moderation audit log", {
        guildId: guild.id,
        actorId: actor.id,
        targetId: target.id,
        error,
      });
    });
}

function canSendInGuildChannel(
  channel: SendableGuildChannel,
  me: GuildMember,
): boolean {
  if (typeof channel.permissionsFor !== "function") {
    return false;
  }
  const permissions = channel.permissionsFor(me);
  if (!permissions?.has(PermissionFlagsBits.ViewChannel)) {
    return false;
  }
  return permissions.has(
    channel.isThread?.()
      ? PermissionFlagsBits.SendMessagesInThreads
      : PermissionFlagsBits.SendMessages,
  );
}

function isSendableGuildChannel(
  value: unknown,
  guildId: string,
): value is SendableGuildChannel {
  const channel = value as Partial<SendableGuildChannel> | null;
  return Boolean(
    channel &&
    channel.guildId === guildId &&
    typeof channel.send === "function",
  );
}

function isChannelInGuild(channel: unknown, guildId: string): boolean {
  return (channel as { guildId?: string | null } | null)?.guildId === guildId;
}

function buildAuditReason(actor: GuildMember, reason: string): string {
  const actorTag = sanitizeAuditText(actor.user.tag);
  const suffix = reason ? ` | ${sanitizeAuditText(reason)}` : "";
  return truncateCodePoints(
    `Timed out by ${actorTag} via Superior reply moderation${suffix}`,
    DISCORD_AUDIT_REASON_LIMIT,
  );
}

function sanitizeAuditText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateCodePoints(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join("");
}

function normalizeFiniteNumber(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

async function processPrivateMudaeMessage(
  message: Message,
  watcher: PrivateMudaeWatcher | null,
): Promise<void> {
  if (!watcher) {
    return;
  }
  try {
    if (watcher.isCandidate(message)) {
      await watcher.processMessage(message);
    }
  } catch (error) {
    logPrivateMudaeRuntimeFailure(
      "Private watcher message processing failed",
      error,
    );
  }
}

function logPrivateMudaeRuntimeFailure(message: string, error: unknown): void {
  const failure = describeMudaeDeliveryFailure(error);
  logError("private-mudae-watch", message, {
    failureName: failure.name,
    ...(failure.code === null ? {} : { failureCode: failure.code }),
  });
}

function recordCommandMetricSafely(
  runtime: GuildRuntime,
  commandName: string,
  success = true,
): void {
  try {
    getMetricStorage(runtime).recordCommandMetric(commandName, success);
  } catch (error) {
    logError("message-metrics", "Could not record message command metric", {
      guildId: runtime.guildId,
      commandName,
      success,
      error,
    });
  }
}

function incrementUserMetricSafely(
  runtime: GuildRuntime,
  userId: string,
  metricName: UserActivityMetric,
): void {
  try {
    getMetricStorage(runtime).incrementUserMetric(userId, metricName);
  } catch (error) {
    logError("message-metrics", "Could not record user activity metric", {
      guildId: runtime.guildId,
      userId,
      metricName,
      error,
    });
  }
}
