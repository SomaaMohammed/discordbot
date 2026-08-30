import {
  Collection,
  MessageFlags,
  PermissionFlagsBits,
  escapeMarkdown,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
  type NewsChannel,
  type TextChannel,
} from "discord.js";
import type { GuildRuntime } from "../runtime.js";
import type {
  ModerationCase,
  ModerationCaseActionType,
  ActiveModerationCaseLookupResult,
  ModerationCaseAttemptInput,
  ModerationCaseListFilter,
  ModerationCaseTransitionResult,
  ModerationConfiguration,
  ModerationTimeoutRemovalFinalizeResult,
} from "../types.js";
import { classifyError } from "../errors.js";
import { logError } from "../logging.js";
import { logDomainOutcome } from "./domain-outcomes.js";
import { deliverModerationCaseLog } from "./moderation-log-delivery.js";
import { runModerationTargetAction } from "./moderation-action-queue.js";
import { authorizeOwnerOrAdministrator } from "./authorization.js";
import {
  fetchCurrentBotMember,
  fetchGuildMemberCoalesced,
  fetchGuildMembers,
} from "./fetch-coalescing.js";

interface CaseAwareModerationStorage {
  getModerationConfiguration(): ModerationConfiguration | null;
  reserveModerationCaseAttempt(
    input: ModerationCaseAttemptInput,
  ): ModerationCase;
  confirmModerationCase(
    caseId: string,
    input: {
      actorId: string;
      status: "active" | "completed";
      discordActionMetadata?: unknown;
      expectedUpdatedAt?: string;
    },
  ): ModerationCaseTransitionResult;
  failModerationCaseAttempt(
    caseId: string,
    input: {
      actorId: string;
      failureCode: string;
      expectedUpdatedAt?: string;
    },
  ): ModerationCaseTransitionResult;
  finalizeTimeoutRemovalCase(
    removalCaseId: string,
    input: {
      actorId: string;
      originalCaseId: string;
      discordActionMetadata?: unknown;
      removalExpectedUpdatedAt?: string;
      originalExpectedUpdatedAt?: string;
    },
  ): ModerationTimeoutRemovalFinalizeResult;
  completeModerationCase(
    caseId: string,
    input: {
      actorId: string;
      reason?: string;
      relatedCaseId?: string | null;
      expectedUpdatedAt?: string;
    },
  ): ModerationCaseTransitionResult;
  listModerationCases(options: ModerationCaseListFilter): ModerationCase[];
  findUniqueActiveModerationCase(
    targetUserId: string,
    actionTypes: readonly ModerationCaseActionType[],
  ): ActiveModerationCaseLookupResult;
  completeExpiredTimeoutCase(
    caseId: string,
    input: {
      actorId: string;
      observedAt: string;
      expectedUpdatedAt: string;
    },
  ): ModerationCaseTransitionResult;
}

const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1_000;
const MAX_PURGE_SCAN = 500;
const MAX_BULK_DELETE = 100;
const MAX_TIMEOUT_MINUTES = 40_320;
const CANCELLED =
  "Action cancelled because this server was disabled, removed, purged, or reconfigured.";
const channelLockProofs = new Map<string, { allow: string; deny: string }>();
const MAX_CHANNEL_LOCK_PROOFS = 10_000;

export function clearModerationProcessState(guildId: string): void {
  const prefix = `${guildId}:`;
  for (const key of channelLockProofs.keys()) {
    if (key.startsWith(prefix)) channelLockProofs.delete(key);
  }
}

export const MODERATION_SUBCOMMANDS = new Set([
  "purge-member",
  "purge",
  "purgeuser",
  "lock",
  "unlock",
  "slowmode",
  "timeout",
  "untimeout",
  "mutemany",
  "unmutemany",
  "muteall",
  "unmuteall",
  "set",
  "remove",
  "set-many",
  "remove-many",
  "set-all",
  "remove-all",
]);

export async function handleModerationCommand(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
): Promise<boolean> {
  await deferPrivate(interaction);
  const subcommand = interaction.options.getSubcommand();
  const caseConfiguration = legacyCaseConfiguration(runtime);
  const appliesTimeout = [
    "timeout",
    "set",
    "mutemany",
    "set-many",
    "muteall",
    "set-all",
  ].includes(subcommand);
  if (
    [
      "timeout",
      "set",
      "untimeout",
      "remove",
      "mutemany",
      "set-many",
      "unmutemany",
      "muteall",
      "set-all",
      "unmuteall",
      "remove-all",
      "remove-many",
    ].includes(subcommand) &&
    (!caseConfiguration || (!caseConfiguration.casesEnabled && appliesTimeout))
  ) {
    await replyPrivate(
      interaction,
      "New moderation cases are disabled. No member timeout action was taken; existing history remains available.",
    );
    return true;
  }
  switch (subcommand) {
    case "purge":
      await handlePurge(interaction, runtime);
      return true;
    case "purgeuser":
    case "purge-member":
      await handlePurgeUser(interaction, runtime);
      return true;
    case "lock":
      await handleLock(interaction, runtime, false);
      return true;
    case "unlock":
      await handleLock(interaction, runtime, true);
      return true;
    case "slowmode":
      await handleSlowmode(interaction, runtime);
      return true;
    case "timeout":
    case "set":
      await runModerationTargetAction(
        runtime.guildId,
        interaction.options.getUser("member", true).id,
        () => handleSingleTimeout(interaction, runtime, actor, false),
      );
      return true;
    case "untimeout":
    case "remove":
      await runModerationTargetAction(
        runtime.guildId,
        interaction.options.getUser("member", true).id,
        () => handleSingleTimeout(interaction, runtime, actor, true),
      );
      return true;
    case "mutemany":
    case "set-many":
      await handleManyTimeouts(interaction, runtime, actor, false);
      return true;
    case "unmutemany":
    case "remove-many":
      await handleManyTimeouts(interaction, runtime, actor, true);
      return true;
    case "muteall":
    case "set-all":
      await handleAllTimeouts(interaction, runtime, actor, false);
      return true;
    case "unmuteall":
    case "remove-all":
      await handleAllTimeouts(interaction, runtime, actor, true);
      return true;
    default:
      return false;
  }
}

function legacyCaseConfiguration(
  runtime: GuildRuntime,
): ModerationConfiguration | null {
  const storage: Partial<CaseAwareModerationStorage> = runtime.storage;
  if (typeof storage.getModerationConfiguration !== "function") return null;
  try {
    const configuration = storage.getModerationConfiguration();
    return configuration?.guildId === runtime.guildId ? configuration : null;
  } catch {
    return null;
  }
}

async function handlePurge(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const amount = interaction.options.getInteger("amount", true);
  const context = await getDeletionContext(interaction, runtime);
  if (!context) return;
  let messages: Collection<string, Message>;
  try {
    messages = await context.channel.messages.fetch({ limit: amount });
  } catch {
    logDomainOutcome(
      "moderation",
      "purge",
      runtime.guildId,
      "failed-history-fetch",
      { attemptedCount: amount },
    );
    await interaction.editReply(
      formatPurgeResult({
        requested: amount,
        scanned: 0,
        deleted: 0,
        old: 0,
        apiSkipped: 0,
        fetchFailed: true,
      }),
    );
    return;
  }
  if (!runtime.isCurrent()) {
    await interaction.editReply(CANCELLED);
    return;
  }
  const cutoff = Date.now() - BULK_DELETE_MAX_AGE_MS;
  const eligible = messages.filter(
    (message) => message.createdTimestamp > cutoff,
  );
  const old = messages.size - eligible.size;
  let deleted = 0;
  let apiSkipped = eligible.size;
  let deleteFailed = false;
  if (eligible.size > 0) {
    try {
      const result = await context.channel.bulkDelete(eligible, true);
      deleted = result.size;
      apiSkipped = eligible.size - result.size;
    } catch {
      deleteFailed = true;
    }
  }
  const report = formatPurgeResult({
    requested: amount,
    scanned: messages.size,
    deleted,
    old,
    apiSkipped,
    deleteFailed,
  });
  await interaction.editReply(report);
  runtime.storage.recordCommandMetric("channel.purge", !deleteFailed);
  logDomainOutcome(
    "moderation",
    "purge",
    runtime.guildId,
    deleteFailed ? "failed-discord-delete" : "completed",
    {
      channelId: context.channel.id,
      attemptedCount: eligible.size,
      succeededCount: deleted,
      failedCount: apiSkipped,
      processedCount: messages.size,
    },
  );
  await sendModerationLog(
    runtime,
    context.channel,
    interaction.user.id,
    report,
  );
}

async function handlePurgeUser(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const target = interaction.options.getUser("member", true);
  const scanLimit = Math.min(
    Math.max(interaction.options.getInteger("scan_limit", false) ?? 200, 1),
    MAX_PURGE_SCAN,
  );
  const deleteLimit = Math.min(
    Math.max(interaction.options.getInteger("delete_limit", false) ?? 100, 1),
    MAX_BULK_DELETE,
  );
  const context = await getDeletionContext(interaction, runtime);
  if (!context) return;
  const matched: Message[] = [];
  let scanned = 0;
  let before: string | undefined;
  let fetchFailed = false;
  while (scanned < scanLimit) {
    const limit = Math.min(100, scanLimit - scanned);
    let page: Collection<string, Message>;
    try {
      page = await context.channel.messages.fetch(
        before ? { limit, before } : { limit },
      );
    } catch {
      fetchFailed = true;
      break;
    }
    if (page.size === 0) break;
    scanned += page.size;
    for (const message of page.values()) {
      if (message.author.id === target.id) matched.push(message);
    }
    before = page.last()?.id;
    if (page.size < limit || !before) break;
  }
  if (!runtime.isCurrent()) {
    await interaction.editReply(CANCELLED);
    return;
  }
  const cutoff = Date.now() - BULK_DELETE_MAX_AGE_MS;
  const old = matched.filter(
    (message) => message.createdTimestamp <= cutoff,
  ).length;
  const eligible = matched
    .filter((message) => message.createdTimestamp > cutoff)
    .slice(0, deleteLimit);
  const capped = Math.max(matched.length - old - eligible.length, 0);
  let deleted = 0;
  let apiSkipped = eligible.length;
  let deleteFailed = false;
  if (eligible.length > 0) {
    try {
      const result = await context.channel.bulkDelete(eligible, true);
      deleted = result.size;
      apiSkipped = eligible.length - result.size;
    } catch {
      deleteFailed = true;
    }
  }
  const report = [
    `Purge-user result for **${escapeMarkdown(target.tag)}**`,
    `Requested delete limit: **${deleteLimit}**`,
    `Scanned: **${scanned}/${scanLimit}**`,
    `Matched: **${matched.length}**`,
    `Deleted: **${deleted}**`,
    `Skipped (older than 14 days): **${old}**`,
    `Skipped (delete cap): **${capped}**`,
    `Skipped (API): **${apiSkipped}**`,
    fetchFailed
      ? "History fetch stopped after an API error; counts above remain accurate."
      : null,
    deleteFailed
      ? "Discord rejected the delete request; no deletion was claimed."
      : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  await interaction.editReply(report);
  runtime.storage.recordCommandMetric(
    "channel.purge-member",
    !fetchFailed && !deleteFailed,
  );
  logDomainOutcome(
    "moderation",
    "purge-user",
    runtime.guildId,
    deleteFailed
      ? "failed-discord-delete"
      : fetchFailed
        ? "partial-history-fetch"
        : "completed",
    {
      channelId: context.channel.id,
      attemptedCount: eligible.length,
      succeededCount: deleted,
      failedCount: apiSkipped,
      processedCount: scanned,
    },
  );
  await sendModerationLog(
    runtime,
    context.channel,
    interaction.user.id,
    report,
  );
}

interface PurgeCounters {
  requested: number;
  scanned: number;
  deleted: number;
  old: number;
  apiSkipped: number;
  fetchFailed?: boolean;
  deleteFailed?: boolean;
}

export function formatPurgeResult(result: PurgeCounters): string {
  return [
    "Purge result",
    `Requested: **${result.requested}**`,
    `Scanned: **${result.scanned}**`,
    `Deleted: **${result.deleted}**`,
    `Skipped (older than 14 days): **${result.old}**`,
    `Skipped (API): **${result.apiSkipped}**`,
    result.fetchFailed
      ? "Discord history fetch failed; nothing was deleted."
      : null,
    result.deleteFailed
      ? "Discord rejected the delete request; no deletion was claimed."
      : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

async function getDeletionContext(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<{ channel: GuildTextBasedChannel; botMember: GuildMember } | null> {
  const channel = await getGuildTextChannel(interaction, runtime, "channel");
  if (!channel) return null;
  const botMember = await getBotMember(interaction, runtime);
  if (!botMember) return null;
  const permissions = channel.permissionsFor(botMember);
  const missing = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.ManageMessages,
  ].filter((permission) => !permissions?.has(permission));
  if (missing.length > 0) {
    await replyPrivate(
      interaction,
      "Superior needs View Channel, Read Message History, and Manage Messages in that channel before purging.",
    );
    return null;
  }
  return { channel, botMember };
}

async function handleLock(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  unlocking: boolean,
): Promise<void> {
  const channel = await getGuildTextChannel(interaction, runtime, "channel");
  if (!channel) return;
  const botMember = await getBotMember(interaction, runtime);
  if (!botMember) return;
  if (
    !channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ManageChannels)
  ) {
    await replyPrivate(
      interaction,
      "Superior needs Manage Channels in that channel.",
    );
    return;
  }
  const everyone = interaction.guild?.roles.everyone;
  if (!everyone) return;
  if (channel.isThread() || !("permissionOverwrites" in channel)) {
    await replyPrivate(
      interaction,
      "Lock and unlock require a text or announcement channel, not a thread.",
    );
    return;
  }
  const lockable = channel as TextChannel | NewsChannel;
  const overwrite = lockable.permissionOverwrites.cache.get(everyone.id);
  const priorAllow = overwrite?.allow.bitfield ?? 0n;
  const priorDeny = overwrite?.deny.bitfield ?? 0n;
  const explicitAllow =
    overwrite?.allow.has(PermissionFlagsBits.SendMessages) ?? false;
  const explicitDeny =
    overwrite?.deny.has(PermissionFlagsBits.SendMessages) ?? false;
  const proofKey = `${runtime.guildId}:${channel.id}`;
  if (unlocking) {
    const proof = channelLockProofs.get(proofKey);
    const currentAllow = (overwrite?.allow.bitfield ?? 0n).toString();
    const currentDeny = (overwrite?.deny.bitfield ?? 0n).toString();
    if (!proof || proof.allow !== currentAllow || proof.deny !== currentDeny) {
      channelLockProofs.delete(proofKey);
      await replyPrivate(
        interaction,
        "Unlock refused: this process cannot prove it created the current permission state. Review the channel override manually.",
      );
      return;
    }
    if (!explicitDeny || explicitAllow) {
      await replyPrivate(
        interaction,
        "Unlock refused: Superior only removes an explicit Send Messages deny and will not overwrite a custom baseline.",
      );
      return;
    }
  } else if (explicitAllow || explicitDeny) {
    await replyPrivate(
      interaction,
      "Lock refused because @everyone already has an explicit Send Messages override. Preserve that custom baseline manually.",
    );
    return;
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(interaction, CANCELLED);
    return;
  }
  const reason = safeReason(interaction.options.getString("reason", false));
  await lockable.permissionOverwrites.edit(
    everyone,
    { SendMessages: unlocking ? null : false },
    { reason },
  );
  if (unlocking) {
    channelLockProofs.delete(proofKey);
  } else {
    while (channelLockProofs.size >= MAX_CHANNEL_LOCK_PROOFS) {
      const oldest = channelLockProofs.keys().next().value as
        string | undefined;
      if (!oldest) break;
      channelLockProofs.delete(oldest);
    }
    channelLockProofs.set(proofKey, {
      allow: (priorAllow & ~PermissionFlagsBits.SendMessages).toString(),
      deny: (priorDeny | PermissionFlagsBits.SendMessages).toString(),
    });
  }
  const report = `${unlocking ? "Unlocked" : "Locked"} <#${channel.id}> by changing only @everyone's explicit Send Messages deny.`;
  await replyPrivate(interaction, report);
  runtime.storage.recordCommandMetric(
    `channel.${unlocking ? "unlock" : "lock"}`,
  );
  logDomainOutcome(
    "moderation",
    unlocking ? "unlock-channel" : "lock-channel",
    runtime.guildId,
    "completed",
    { channelId: channel.id },
  );
  await sendModerationLog(runtime, channel, interaction.user.id, report);
}

async function handleSlowmode(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const channel = await getGuildTextChannel(interaction, runtime, "channel");
  if (!channel || !("setRateLimitPerUser" in channel)) {
    if (channel)
      await replyPrivate(
        interaction,
        "That channel does not support slowmode.",
      );
    return;
  }
  const botMember = await getBotMember(interaction, runtime);
  if (!botMember) return;
  if (
    !channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ManageChannels)
  ) {
    await replyPrivate(
      interaction,
      "Superior needs Manage Channels in that channel.",
    );
    return;
  }
  const seconds = interaction.options.getInteger("seconds", true);
  if (!runtime.isCurrent()) {
    await replyPrivate(interaction, CANCELLED);
    return;
  }
  await channel.setRateLimitPerUser(
    seconds,
    safeReason(interaction.options.getString("reason", false)),
  );
  await replyPrivate(
    interaction,
    `Slowmode for <#${channel.id}> is now **${seconds} seconds**.`,
  );
  runtime.storage.recordCommandMetric("channel.slowmode");
  logDomainOutcome("moderation", "slowmode", runtime.guildId, "completed", {
    channelId: channel.id,
    state: seconds === 0 ? "disabled" : "enabled",
  });
}

async function handleSingleTimeout(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
  removing: boolean,
): Promise<void> {
  const targetUser = interaction.options.getUser("member", true);
  const member = await interaction.guild?.members
    .fetch({ user: targetUser.id, cache: true, force: true })
    .catch(() => null);
  const botMember = await getBotMember(interaction, runtime);
  if (!member || member.guild.id !== runtime.guildId || !botMember) {
    if (!member)
      await replyPrivate(
        interaction,
        "Could not resolve that member in this server.",
      );
    return;
  }
  const issue = getTimeoutIssue(member, actor, botMember);
  if (issue) {
    await replyPrivate(interaction, issue);
    return;
  }
  if (removing && !member.isCommunicationDisabled()) {
    const storage: Partial<CaseAwareModerationStorage> = runtime.storage;
    let hasExpiredCase = false;
    if (typeof storage.findUniqueActiveModerationCase === "function") {
      try {
        const active = storage.findUniqueActiveModerationCase(member.id, [
          "timeout",
          "automod-timeout",
        ]);
        hasExpiredCase =
          active.status === "found" &&
          (timeoutCaseExpiry(active.case) ?? Number.POSITIVE_INFINITY) <=
            Date.now();
      } catch {
        hasExpiredCase = false;
      }
    }
    if (!hasExpiredCase) {
      await replyPrivate(
        interaction,
        "That member is not currently timed out.",
      );
      return;
    }
  }
  if (!removing && member.isCommunicationDisabled()) {
    await replyPrivate(
      interaction,
      "That member is already timed out; use the explicit removal flow before applying a new timeout.",
    );
    return;
  }
  const minutes = removing
    ? 0
    : interaction.options.getInteger("minutes", true);
  if (!runtime.isCurrent()) {
    await replyPrivate(interaction, CANCELLED);
    return;
  }
  const reason = safeReason(interaction.options.getString("reason", false));
  const freshAuthority = await authorizeOwnerOrAdministrator(
    interaction.guild!,
    actor.id,
  );
  if (!freshAuthority.allowed || !runtime.isCurrent()) {
    await replyPrivate(interaction, CANCELLED);
    return;
  }
  const terminalAuthority = await authorizeOwnerOrAdministrator(
    interaction.guild!,
    actor.id,
  );
  const terminalActor = terminalAuthority.allowed
    ? terminalAuthority.member
    : null;
  const [actionMember, actionBot] = await Promise.all([
    fetchGuildMemberCoalesced(interaction.guild!, member.id, {
      cache: true,
      force: true,
    }),
    fetchCurrentBotMember(interaction.guild!, { force: true }),
  ]);
  const terminalIssue =
    terminalAuthority.allowed && actionMember && actionBot
      ? getTimeoutIssue(actionMember, terminalAuthority.member, actionBot)
      : CANCELLED;
  if (
    terminalIssue ||
    !terminalActor ||
    !actionMember ||
    !actionBot ||
    (!removing && actionMember.isCommunicationDisabled()) ||
    !runtime.isCurrent()
  ) {
    await replyPrivate(interaction, terminalIssue ?? CANCELLED);
    return;
  }
  if (removing && !actionMember.isCommunicationDisabled()) {
    const active = runtime.storage.findUniqueActiveModerationCase(
      actionMember.id,
      ["timeout", "automod-timeout"],
    );
    const observedAt = new Date().toISOString();
    const expiry =
      active.status === "found" ? timeoutCaseExpiry(active.case) : null;
    if (
      active.status === "found" &&
      expiry !== null &&
      expiry <= Date.parse(observedAt)
    ) {
      const completed = runtime.storage.completeExpiredTimeoutCase(
        active.case.caseId,
        {
          actorId: terminalActor.id,
          observedAt,
          expectedUpdatedAt: active.case.updatedAt,
        },
      );
      if (completed.status === "changed" || completed.status === "unchanged") {
        await deliverModerationCaseLog(
          interaction.guild!,
          runtime,
          completed.case,
        );
        await replyPrivate(
          interaction,
          `Case #${completed.case.caseNumber} was completed as a naturally expired timeout; no removal case was created.`,
        );
      } else {
        await replyPrivate(
          interaction,
          "The expired timeout case changed before reconciliation could be saved.",
        );
      }
    } else {
      await replyPrivate(
        interaction,
        "That member is not currently timed out, and no uniquely matched expired timeout case could be reconciled.",
      );
    }
    return;
  }
  if (removing) {
    const removalIssue = timeoutRemovalCaseIssue(
      runtime,
      actionMember.id,
      actionMember.communicationDisabledUntil?.getTime() ?? null,
    );
    if (removalIssue) {
      await replyPrivate(interaction, removalIssue);
      return;
    }
  }
  const attempt = reserveTimeoutCase(runtime, {
    actorId: terminalActor.id,
    memberId: actionMember.id,
    removing,
    reason,
    minutes,
    currentExpiry: actionMember.communicationDisabledUntil?.getTime() ?? null,
    source: "superior-command",
  });
  if (attempt.status !== "reserved") {
    await replyPrivate(
      interaction,
      "Superior could not persist a durable case attempt, so no Discord action was taken.",
    );
    return;
  }
  try {
    await actionMember.timeout(
      removing ? null : Math.min(minutes, MAX_TIMEOUT_MINUTES) * 60_000,
      reason,
    );
  } catch {
    failTimeoutCaseAttempt(
      runtime,
      attempt.record,
      terminalActor.id,
      "discord-timeout-failed",
    );
    await replyPrivate(
      interaction,
      `Discord rejected the timeout operation. Failed attempt case **#${attempt.record.caseNumber}** was retained.`,
    );
    return;
  }
  const refreshed = await fetchGuildMemberCoalesced(
    interaction.guild!,
    member.id,
    { cache: true, force: true },
  );
  const confirmedState = refreshed
    ? removing
      ? !refreshed.isCommunicationDisabled()
      : refreshed.isCommunicationDisabled()
    : false;
  if (!confirmedState) {
    failTimeoutCaseAttempt(
      runtime,
      attempt.record,
      terminalActor.id,
      "timeout-state-unconfirmed",
    );
    await replyPrivate(
      interaction,
      `Discord did not provide an unambiguous post-action state. Attempt case **#${attempt.record.caseNumber}** needs authorized recovery.`,
    );
    return;
  }
  const caseResult = confirmTimeoutCase(runtime, attempt, {
    actorId: terminalActor.id,
    removing,
    minutes,
    expiresAt: refreshed?.communicationDisabledUntil?.toISOString() ?? null,
  });
  const logResult =
    caseResult.status === "created" && interaction.guild
      ? await deliverModerationCaseLog(
          interaction.guild,
          runtime,
          caseResult.record,
        )
      : null;
  await replyPrivate(
    interaction,
    `${
      removing
        ? `Removed the timeout from **${escapeMarkdown(member.displayName)}**.`
        : `Timed out **${escapeMarkdown(member.displayName)}** for **${minutes} minutes**.`
    }${caseResult.status === "created" ? ` Case **#${caseResult.record.caseNumber}** was recorded.` : caseResult.status === "failed" ? " The Discord action succeeded, but its case record needs operator recovery." : ""}${logResult === "failed" || logResult === "unavailable" ? " Its moderation-log delivery needs authorized recovery." : ""}`,
  );
  runtime.storage.recordCommandMetric(`timeout.${removing ? "remove" : "set"}`);
  logDomainOutcome(
    "moderation",
    removing ? "remove-timeout" : "apply-timeout",
    runtime.guildId,
    "completed",
    { succeededCount: 1 },
  );
}

async function handleManyTimeouts(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
  removing: boolean,
): Promise<void> {
  const ids = parseMemberIds(interaction.options.getString("members", true));
  const cap = runtime.settings.limits.bulkModerationTargetCap;
  if (ids.length === 0 || ids.length > cap) {
    await replyPrivate(
      interaction,
      `Provide 1-${cap} unique member IDs or mentions.`,
    );
    return;
  }
  const botMember = await getBotMemberAfterDefer(interaction, runtime);
  if (!botMember) return;
  const resolved = await Promise.all(
    ids.map((id) =>
      interaction.guild?.members
        .fetch({ user: id, cache: true, force: true })
        .catch(() => null),
    ),
  );
  const eligible = resolved.filter(
    (member): member is GuildMember =>
      member != null &&
      getTimeoutIssue(member, actor, botMember) === null &&
      (removing
        ? member.isCommunicationDisabled()
        : !member.isCommunicationDisabled()),
  );
  const dryRun = interaction.options.getBoolean("dry_run", false) ?? false;
  if (dryRun) {
    await interaction.editReply(
      `Preview: **${eligible.length}** eligible, **${ids.length - eligible.length}** skipped, cap **${cap}**.`,
    );
    return;
  }
  if (!runtime.isCurrent()) {
    await interaction.editReply(CANCELLED);
    return;
  }
  const minutes = removing
    ? 0
    : interaction.options.getInteger("minutes", true);
  const reason = safeReason(interaction.options.getString("reason", false));
  let applied = 0;
  let caseFailures = 0;
  let logFailures = 0;
  const failures: string[] = [];
  let cancelled = 0;
  for (const [index, member] of eligible.entries()) {
    if (!runtime.isCurrent()) {
      cancelled = eligible.length - index;
      break;
    }
    const outcome = await applyLegacyTimeoutMember(
      interaction.guild!,
      runtime,
      actor,
      member.id,
      removing,
      minutes,
      reason,
    );
    if (outcome.applied) applied += 1;
    if (outcome.caseFailure) caseFailures += 1;
    if (outcome.logFailure) logFailures += 1;
    if (outcome.apiFailure) {
      failures.push(member.id);
    }
  }
  await interaction.editReply(
    `Bulk ${removing ? "untimeout" : "timeout"} result: **${applied} applied**, **${ids.length - eligible.length} ineligible**, **${failures.length} API failures**, **${cancelled} cancelled after reconfiguration**.${caseFailures > 0 ? ` **${caseFailures}** successful Discord actions need case-record recovery.` : ""}${logFailures > 0 ? ` **${logFailures}** case logs need delivery recovery.` : ""}`,
  );
  if (cancelled === 0) {
    runtime.storage.recordCommandMetric(
      `timeout.${removing ? "remove-many" : "set-many"}`,
      failures.length === 0,
    );
  }
  logDomainOutcome(
    "moderation",
    removing ? "bulk-remove-timeout" : "bulk-apply-timeout",
    runtime.guildId,
    cancelled > 0
      ? "cancelled-partial"
      : failures.length > 0
        ? "partial-api-failures"
        : "completed",
    {
      attemptedCount: ids.length,
      succeededCount: applied,
      failedCount: failures.length,
      processedCount: eligible.length,
    },
  );
}

async function handleAllTimeouts(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
  removing: boolean,
): Promise<void> {
  if (interaction.options.getString("confirm", true) !== "CONFIRM") {
    await replyPrivate(
      interaction,
      "Confirmation failed. Type `CONFIRM` exactly.",
    );
    return;
  }
  const botMember = await getBotMemberAfterDefer(interaction, runtime);
  if (!botMember || !interaction.guild) return;
  const members = await fetchGuildMembers(interaction.guild);
  if (!members) {
    await interaction.editReply(
      "Could not fetch the current server members, so no timeouts were changed.",
    );
    return;
  }
  const eligible = [...members.values()].filter(
    (member) =>
      getTimeoutIssue(member, actor, botMember) === null &&
      (removing
        ? member.isCommunicationDisabled()
        : !member.isCommunicationDisabled()),
  );
  const cap = runtime.settings.limits.bulkModerationTargetCap;
  if (eligible.length > cap) {
    logDomainOutcome(
      "moderation",
      removing ? "server-remove-timeout" : "server-apply-timeout",
      runtime.guildId,
      "rejected-safety-cap",
      { attemptedCount: eligible.length, totalCount: cap },
    );
    await interaction.editReply(
      `Refused: **${eligible.length}** eligible targets exceeds this server's finite cap of **${cap}**.`,
    );
    return;
  }
  const dryRun = interaction.options.getBoolean("dry_run", false) ?? false;
  if (dryRun) {
    await interaction.editReply(
      `Preview: **${eligible.length}** eligible targets; cap **${cap}**.`,
    );
    return;
  }
  if (!runtime.isCurrent()) {
    await interaction.editReply(CANCELLED);
    return;
  }
  const minutes = removing
    ? 0
    : interaction.options.getInteger("minutes", true);
  const reason = safeReason(interaction.options.getString("reason", false));
  let applied = 0;
  let failed = 0;
  let caseFailures = 0;
  let logFailures = 0;
  let cancelled = 0;
  for (const [index, member] of eligible.entries()) {
    if (!runtime.isCurrent()) {
      cancelled = eligible.length - index;
      break;
    }
    const outcome = await applyLegacyTimeoutMember(
      interaction.guild,
      runtime,
      actor,
      member.id,
      removing,
      minutes,
      reason,
    );
    if (outcome.applied) applied += 1;
    if (outcome.caseFailure) caseFailures += 1;
    if (outcome.logFailure) logFailures += 1;
    if (outcome.apiFailure) {
      failed += 1;
    }
  }
  await interaction.editReply(
    `Server-wide ${removing ? "untimeout" : "timeout"} result: **${applied} applied**, **${failed} API failures**, **${cancelled} cancelled after reconfiguration**.${caseFailures > 0 ? ` **${caseFailures}** successful Discord actions need case-record recovery.` : ""}${logFailures > 0 ? ` **${logFailures}** case logs need delivery recovery.` : ""}`,
  );
  if (cancelled === 0) {
    runtime.storage.recordCommandMetric(
      `timeout.${removing ? "remove-all" : "set-all"}`,
      failed === 0,
    );
  }
  logDomainOutcome(
    "moderation",
    removing ? "server-remove-timeout" : "server-apply-timeout",
    runtime.guildId,
    cancelled > 0
      ? "cancelled-partial"
      : failed > 0
        ? "partial-api-failures"
        : "completed",
    {
      attemptedCount: eligible.length,
      succeededCount: applied,
      failedCount: failed,
      processedCount: eligible.length - cancelled,
    },
  );
}

async function applyLegacyTimeoutMember(
  guild: Guild,
  runtime: GuildRuntime,
  actor: GuildMember,
  memberId: string,
  removing: boolean,
  minutes: number,
  reason: string,
): Promise<{
  applied: boolean;
  apiFailure: boolean;
  caseFailure: boolean;
  logFailure: boolean;
}> {
  return runModerationTargetAction(runtime.guildId, memberId, async () => {
    try {
      const authority = await authorizeOwnerOrAdministrator(guild, actor.id);
      const [freshMember, freshBot] = await Promise.all([
        fetchGuildMemberCoalesced(guild, memberId, {
          cache: true,
          force: true,
        }),
        fetchCurrentBotMember(guild, { force: true }),
      ]);
      if (
        !authority.allowed ||
        !freshMember ||
        !freshBot ||
        getTimeoutIssue(freshMember, authority.member, freshBot) ||
        (removing
          ? !freshMember.isCommunicationDisabled()
          : freshMember.isCommunicationDisabled()) ||
        !runtime.isCurrent()
      ) {
        return {
          applied: false,
          apiFailure: true,
          caseFailure: false,
          logFailure: false,
        };
      }
      const attempt = reserveTimeoutCase(runtime, {
        actorId: authority.member.id,
        memberId: freshMember.id,
        removing,
        reason,
        minutes,
        currentExpiry:
          freshMember.communicationDisabledUntil?.getTime() ?? null,
        source: "superior-command",
      });
      if (attempt.status !== "reserved") {
        return {
          applied: false,
          apiFailure: true,
          caseFailure: false,
          logFailure: false,
        };
      }
      try {
        await freshMember.timeout(removing ? null : minutes * 60_000, reason);
      } catch {
        failTimeoutCaseAttempt(
          runtime,
          attempt.record,
          authority.member.id,
          "discord-timeout-failed",
        );
        return {
          applied: false,
          apiFailure: true,
          caseFailure: false,
          logFailure: false,
        };
      }
      const refreshed = await guild.members
        .fetch({ user: freshMember.id, cache: true, force: true })
        .catch(() => null);
      if (
        !refreshed ||
        (removing
          ? refreshed.isCommunicationDisabled()
          : !refreshed.isCommunicationDisabled())
      ) {
        failTimeoutCaseAttempt(
          runtime,
          attempt.record,
          authority.member.id,
          "timeout-state-unconfirmed",
        );
        return {
          applied: true,
          apiFailure: false,
          caseFailure: true,
          logFailure: false,
        };
      }
      const caseResult = confirmTimeoutCase(runtime, attempt, {
        actorId: authority.member.id,
        removing,
        minutes,
        expiresAt: refreshed.communicationDisabledUntil?.toISOString() ?? null,
      });
      if (caseResult.status === "failed") {
        return {
          applied: true,
          apiFailure: false,
          caseFailure: true,
          logFailure: false,
        };
      }
      const delivered = await deliverModerationCaseLog(
        guild,
        runtime,
        caseResult.record,
      );
      return {
        applied: true,
        apiFailure: false,
        caseFailure: false,
        logFailure: delivered === "failed" || delivered === "unavailable",
      };
    } catch {
      return {
        applied: false,
        apiFailure: true,
        caseFailure: false,
        logFailure: false,
      };
    }
  });
}

function getTimeoutIssue(
  member: GuildMember,
  actor: GuildMember,
  botMember: GuildMember,
): string | null {
  if (member.id === member.guild.ownerId)
    return "The server owner cannot be timed out.";
  if (member.id === actor.id)
    return "You cannot target yourself with this command.";
  if (member.id === botMember.id) return "Superior cannot target itself.";
  if (!member.moderatable)
    return "Superior cannot moderate that member because of role hierarchy or permissions.";
  if (
    actor.id !== member.guild.ownerId &&
    actor.roles.highest.comparePositionTo(member.roles.highest) <= 0
  ) {
    return "Your highest role must be above the target's highest role.";
  }
  return null;
}

function parseMemberIds(raw: string): string[] {
  return Array.from(new Set(raw.match(/\d{17,20}/g) ?? [])).slice(0, 1_001);
}

async function getGuildTextChannel(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  optionName: string,
): Promise<GuildTextBasedChannel | null> {
  const selected = interaction.options.getChannel(optionName, false);
  const rawChannel: unknown = selected ?? interaction.channel;
  const channel = rawChannel as GuildTextBasedChannel | null;
  if (
    !channel ||
    typeof channel.isDMBased !== "function" ||
    typeof channel.isTextBased !== "function" ||
    channel.isDMBased() ||
    !channel.isTextBased() ||
    !("messages" in channel) ||
    channel.guild.id !== runtime.guildId ||
    interaction.guild?.id !== runtime.guildId
  ) {
    await replyPrivate(
      interaction,
      "Choose a text-based channel in this server.",
    );
    return null;
  }
  return channel;
}

async function getBotMember(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<GuildMember | null> {
  const guild = interaction.guild;
  if (!guild || guild.id !== runtime.guildId) return null;
  const member = await guild.members
    .fetchMe({ cache: true, force: true })
    .catch(() => null);
  if (!member || member.guild.id !== runtime.guildId) {
    await replyPrivate(
      interaction,
      "Could not verify Superior's server permissions.",
    );
    return null;
  }
  return member;
}

async function getBotMemberAfterDefer(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<GuildMember | null> {
  const guild = interaction.guild;
  if (!guild || guild.id !== runtime.guildId) return null;
  const member = await guild.members
    .fetchMe({ cache: true, force: true })
    .catch(() => null);
  if (!member || member.guild.id !== runtime.guildId) {
    await interaction.editReply(
      "Could not verify Superior's server permissions.",
    );
    return null;
  }
  if (!member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    await interaction.editReply(
      "Superior needs Moderate Members for timeout commands.",
    );
    return null;
  }
  return member;
}

type ReservedTimeoutCase = {
  status: "reserved";
  record: ModerationCase;
  original: ModerationCase | null;
};

function reserveTimeoutCase(
  runtime: GuildRuntime,
  input: {
    actorId: string;
    memberId: string;
    removing: boolean;
    reason: string;
    minutes: number;
    currentExpiry: number | null;
    source: "superior-command";
  },
): ReservedTimeoutCase | { status: "failed" } {
  const storage: CaseAwareModerationStorage = runtime.storage;
  if (
    typeof storage.reserveModerationCaseAttempt !== "function" ||
    typeof storage.confirmModerationCase !== "function" ||
    typeof storage.failModerationCaseAttempt !== "function" ||
    typeof storage.findUniqueActiveModerationCase !== "function"
  ) {
    return { status: "failed" };
  }
  try {
    const lookup = input.removing
      ? storage.findUniqueActiveModerationCase(input.memberId, [
          "timeout",
          "automod-timeout",
        ])
      : null;
    if (lookup?.status === "ambiguous") return { status: "failed" };
    const original =
      lookup?.status === "found" &&
      timeoutCaseMatchesExpiry(lookup.case, input.currentExpiry)
        ? lookup.case
        : null;
    const configuration = storage.getModerationConfiguration();
    if (
      input.removing &&
      ((lookup?.status === "found" && !original) ||
        (!configuration?.casesEnabled && !original))
    ) {
      return { status: "failed" };
    }
    const record = storage.reserveModerationCaseAttempt({
      targetUserId: input.memberId,
      actorId: input.actorId,
      actionType: input.removing ? "timeout-removed" : "timeout",
      source: input.source,
      publicReason: input.reason,
      privateNote: null,
      relatedCaseId: original?.caseId ?? null,
      discordActionMetadata: {
        ...(input.removing
          ? {
              originalExpiresAt:
                input.currentExpiry === null
                  ? null
                  : new Date(input.currentExpiry).toISOString(),
            }
          : {
              durationMinutes: input.minutes,
              requestedDurationSeconds: input.minutes * 60,
            }),
      },
    });
    return { status: "reserved", record, original };
  } catch (error) {
    logCasePersistenceError(
      runtime,
      input.removing,
      "case-reservation-failed",
      error,
    );
    return { status: "failed" };
  }
}

function timeoutRemovalCaseIssue(
  runtime: GuildRuntime,
  memberId: string,
  currentExpiry: number | null,
): string | null {
  const storage: Partial<CaseAwareModerationStorage> = runtime.storage;
  if (typeof storage.findUniqueActiveModerationCase !== "function") {
    return "Superior could not verify stored timeout history, so the live timeout was not removed.";
  }
  let lookup: ActiveModerationCaseLookupResult;
  try {
    lookup = storage.findUniqueActiveModerationCase(memberId, [
      "timeout",
      "automod-timeout",
    ]);
  } catch {
    return "Superior could not verify stored timeout history, so the live timeout was not removed.";
  }
  if (lookup.status === "ambiguous") {
    return "The live Discord timeout does not uniquely match active stored timeout history, so Superior will not clear or complete the wrong case.";
  }
  if (lookup.status === "found") {
    return timeoutCaseMatchesExpiry(lookup.case, currentExpiry)
      ? null
      : "The live Discord timeout does not uniquely match active stored timeout history, so Superior will not clear or complete the wrong case.";
  }
  return legacyCaseConfiguration(runtime)?.casesEnabled
    ? null
    : "New cases are disabled, so timeout recovery requires one uniquely matched active timeout case.";
}

function timeoutCaseMatchesExpiry(
  record: ModerationCase,
  currentExpiry: number | null,
): boolean {
  if (currentExpiry === null) return false;
  const expected = timeoutCaseExpiry(record);
  return expected !== null && Math.abs(expected - currentExpiry) <= 2_000;
}

function timeoutCaseExpiry(record: ModerationCase): number | null {
  const metadata = record.discordActionMetadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const raw = (metadata as { expiresAt?: unknown }).expiresAt;
  if (typeof raw !== "string") return null;
  const expected = Date.parse(raw);
  return Number.isFinite(expected) ? expected : null;
}

function confirmTimeoutCase(
  runtime: GuildRuntime,
  attempt: ReservedTimeoutCase,
  input: {
    actorId: string;
    removing: boolean;
    minutes: number;
    expiresAt: string | null;
  },
): { status: "created"; record: ModerationCase } | { status: "failed" } {
  const storage: CaseAwareModerationStorage = runtime.storage;
  try {
    const metadata = {
      durationMinutes: input.removing ? null : input.minutes,
      expiresAt: input.removing ? null : input.expiresAt,
    };
    const result =
      input.removing && attempt.original
        ? storage.finalizeTimeoutRemovalCase(attempt.record.caseId, {
            actorId: input.actorId,
            originalCaseId: attempt.original.caseId,
            discordActionMetadata: metadata,
            removalExpectedUpdatedAt: attempt.record.updatedAt,
            originalExpectedUpdatedAt: attempt.original.updatedAt,
          })
        : storage.confirmModerationCase(attempt.record.caseId, {
            actorId: input.actorId,
            status: input.removing ? "completed" : "active",
            discordActionMetadata: metadata,
            expectedUpdatedAt: attempt.record.updatedAt,
          });
    if (result.status !== "changed" && result.status !== "unchanged") {
      return { status: "failed" };
    }
    const record = "removalCase" in result ? result.removalCase : result.case;
    if (!record) return { status: "failed" };
    return { status: "created", record };
  } catch (error) {
    logCasePersistenceError(
      runtime,
      input.removing,
      "case-confirmation-failed",
      error,
    );
    return { status: "failed" };
  }
}

function failTimeoutCaseAttempt(
  runtime: GuildRuntime,
  record: ModerationCase,
  actorId: string,
  failureCode: string,
): void {
  const storage: CaseAwareModerationStorage = runtime.storage;
  try {
    storage.failModerationCaseAttempt(record.caseId, {
      actorId,
      failureCode,
      expectedUpdatedAt: record.updatedAt,
    });
  } catch (error) {
    logCasePersistenceError(
      runtime,
      record.actionType === "timeout-removed",
      "case-failure-event-failed",
      error,
    );
  }
}

function logCasePersistenceError(
  runtime: GuildRuntime,
  removing: boolean,
  outcome: string,
  error: unknown,
): void {
  const classified = classifyError(error);
  logError("moderation-case", "Moderation case attempt needs recovery", {
    guildId: runtime.guildId,
    operation: removing ? "timeout-removed" : "timeout",
    outcome,
    category: classified.category,
    ...(classified.code === null ? {} : { code: classified.code }),
    retryable: classified.retryable,
  });
}

function safeReason(value: string | null): string {
  const reason = (value ?? "Requested through Superior")
    .normalize("NFKC")
    .trim();
  return reason.slice(0, 400) || "Requested through Superior";
}

async function replyPrivate(
  interaction: ChatInputCommandInteraction,
  content: string,
): Promise<void> {
  if (interaction.deferred && !interaction.replied) {
    await interaction.editReply({ content, allowedMentions: { parse: [] } });
    return;
  }
  if (interaction.replied) {
    await interaction.followUp({
      content,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }
  await interaction.reply({
    content,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function deferPrivate(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
}

async function sendModerationLog(
  runtime: GuildRuntime,
  sourceChannel: GuildTextBasedChannel,
  actorId: string,
  report: string,
): Promise<void> {
  const logChannelId = runtime.settings.channels.log;
  if (!logChannelId || !runtime.isCurrent()) return;
  const logChannel = await sourceChannel.guild.channels
    .fetch(logChannelId)
    .catch(() => null);
  if (
    !logChannel ||
    logChannel.isDMBased() ||
    !logChannel.isTextBased() ||
    !("send" in logChannel) ||
    logChannel.guild.id !== runtime.guildId
  ) {
    return;
  }
  await logChannel
    .send({
      content: `Moderator ID: \`${actorId}\`\n${report}`.slice(0, 1_900),
      allowedMentions: { parse: [] },
    })
    .catch(() => undefined);
}
