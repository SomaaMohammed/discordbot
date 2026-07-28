import {
  Collection,
  PermissionFlagsBits,
  escapeMarkdown,
  type ChatInputCommandInteraction,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
  type NewsChannel,
  type TextChannel,
} from "discord.js";
import type { GuildRuntime } from "../runtime.js";

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
]);

export async function handleModerationCommand(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
): Promise<boolean> {
  await deferPrivate(interaction);
  switch (interaction.options.getSubcommand()) {
    case "purge":
      await handlePurge(interaction, runtime);
      return true;
    case "purgeuser":
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
      await handleSingleTimeout(interaction, runtime, actor, false);
      return true;
    case "untimeout":
      await handleSingleTimeout(interaction, runtime, actor, true);
      return true;
    case "mutemany":
      await handleManyTimeouts(interaction, runtime, actor, false);
      return true;
    case "unmutemany":
      await handleManyTimeouts(interaction, runtime, actor, true);
      return true;
    case "muteall":
      await handleAllTimeouts(interaction, runtime, actor, false);
      return true;
    case "unmuteall":
      await handleAllTimeouts(interaction, runtime, actor, true);
      return true;
    default:
      return false;
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
  runtime.storage.recordCommandMetric("superior.purge", !deleteFailed);
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
    "superior.purgeuser",
    !fetchFailed && !deleteFailed,
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
    `superior.${unlocking ? "unlock" : "lock"}`,
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
  runtime.storage.recordCommandMetric("superior.slowmode");
}

async function handleSingleTimeout(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
  removing: boolean,
): Promise<void> {
  const targetUser = interaction.options.getUser("member", true);
  const member = await interaction.guild?.members
    .fetch(targetUser.id)
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
    await replyPrivate(interaction, "That member is not currently timed out.");
    return;
  }
  const minutes = removing
    ? 0
    : interaction.options.getInteger("minutes", true);
  if (!runtime.isCurrent()) {
    await replyPrivate(interaction, CANCELLED);
    return;
  }
  await member.timeout(
    removing ? null : Math.min(minutes, MAX_TIMEOUT_MINUTES) * 60_000,
    safeReason(interaction.options.getString("reason", false)),
  );
  await replyPrivate(
    interaction,
    removing
      ? `Removed the timeout from **${escapeMarkdown(member.displayName)}**.`
      : `Timed out **${escapeMarkdown(member.displayName)}** for **${minutes} minutes**.`,
  );
  runtime.storage.recordCommandMetric(
    `superior.${removing ? "untimeout" : "timeout"}`,
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
    ids.map((id) => interaction.guild?.members.fetch(id).catch(() => null)),
  );
  const eligible = resolved.filter(
    (member): member is GuildMember =>
      member != null &&
      getTimeoutIssue(member, actor, botMember) === null &&
      (!removing || member.isCommunicationDisabled()),
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
  const failures: string[] = [];
  let cancelled = 0;
  for (const [index, member] of eligible.entries()) {
    if (!runtime.isCurrent()) {
      cancelled = eligible.length - index;
      break;
    }
    try {
      await member.timeout(removing ? null : minutes * 60_000, reason);
      applied += 1;
    } catch {
      failures.push(member.id);
    }
  }
  await interaction.editReply(
    `Bulk ${removing ? "untimeout" : "timeout"} result: **${applied} applied**, **${ids.length - eligible.length} ineligible**, **${failures.length} API failures**, **${cancelled} cancelled after reconfiguration**.`,
  );
  if (cancelled === 0) {
    runtime.storage.recordCommandMetric(
      `superior.${removing ? "unmutemany" : "mutemany"}`,
      failures.length === 0,
    );
  }
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
  const members = await interaction.guild.members.fetch();
  const eligible = [...members.values()].filter(
    (member) =>
      getTimeoutIssue(member, actor, botMember) === null &&
      (removing ? member.isCommunicationDisabled() : true),
  );
  const cap = runtime.settings.limits.bulkModerationTargetCap;
  if (eligible.length > cap) {
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
  let cancelled = 0;
  for (const [index, member] of eligible.entries()) {
    if (!runtime.isCurrent()) {
      cancelled = eligible.length - index;
      break;
    }
    try {
      await member.timeout(removing ? null : minutes * 60_000, reason);
      applied += 1;
    } catch {
      failed += 1;
    }
  }
  await interaction.editReply(
    `Server-wide ${removing ? "untimeout" : "timeout"} result: **${applied} applied**, **${failed} API failures**, **${cancelled} cancelled after reconfiguration**.`,
  );
  if (cancelled === 0) {
    runtime.storage.recordCommandMetric(
      `superior.${removing ? "unmuteall" : "muteall"}`,
      failed === 0,
    );
  }
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
  const member =
    guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
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
  const member =
    guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
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
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }
  await interaction.reply({
    content,
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
}

async function deferPrivate(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true });
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
