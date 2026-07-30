import {
  ChannelType,
  escapeMarkdown,
  type CategoryChannel,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
  type Role,
  type TextChannel,
} from "discord.js";
import type { GuildRuntime } from "../runtime.js";
import type { TicketRecord } from "../types.js";
import { postTicketLauncher } from "./preset-panels.js";
import { buildTicketWelcomePayload } from "./ticket-components.js";
import {
  createPrivateTicketChannel,
  inspectTicketConfigurationResources,
  quarantinePrivateTicketChannel,
  reconcilePrivateTicketChannel,
  ticketChannelRecoveryMarker,
  validateTicketSetupResources,
} from "./ticket-permissions.js";

const TICKET_RECOVERY_LEASE_MS = 5 * 60 * 1_000;
const TICKET_RECOVERY_CHANNEL_SCAN_LIMIT = 500;

export async function handleTicketCommand(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
): Promise<void> {
  switch (interaction.options.getSubcommand()) {
    case "setup":
      await configureTickets(interaction, runtime, actor);
      return;
    case "status":
      await showTicketStatus(interaction, runtime);
      return;
    case "panel":
      await postTicketLauncher(interaction, runtime, actor);
      return;
    case "disable":
      await disableTickets(interaction, runtime);
      return;
    case "recover":
      await recoverTicket(interaction, runtime, actor);
      return;
    default:
      await replyPrivate(interaction, "Choose a supported ticket action.");
  }
}

async function configureTickets(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
): Promise<void> {
  const guild = interaction.guild;
  const rawCategory = interaction.options.getChannel(
    "category",
    true,
  ) as unknown as CategoryChannel;
  const rawLogChannel = interaction.options.getChannel(
    "log_channel",
    true,
  ) as unknown as GuildTextBasedChannel;
  const rawSupportRole = interaction.options.getRole(
    "support_role",
    true,
  ) as unknown as Role;
  if (!guild || guild.id !== runtime.guildId) {
    await replyPrivate(interaction, "Ticket setup must run in this server.");
    return;
  }
  if (
    !rawCategory ||
    rawCategory.guild?.id !== runtime.guildId ||
    rawCategory.type !== ChannelType.GuildCategory
  ) {
    await replyPrivate(interaction, "Choose a category from this server.");
    return;
  }
  if (
    !rawLogChannel ||
    typeof rawLogChannel.isDMBased !== "function" ||
    rawLogChannel.guild?.id !== runtime.guildId ||
    (rawLogChannel.type !== ChannelType.GuildText &&
      rawLogChannel.type !== ChannelType.GuildAnnouncement) ||
    rawLogChannel.isDMBased()
  ) {
    await replyPrivate(
      interaction,
      "Choose a text or announcement log channel from this server.",
    );
    return;
  }
  if (!rawSupportRole || rawSupportRole.guild?.id !== runtime.guildId) {
    await replyPrivate(interaction, "Choose a support role from this server.");
    return;
  }
  const category = rawCategory as CategoryChannel;
  const logChannel = rawLogChannel as GuildTextBasedChannel;
  const supportRole = rawSupportRole as Role;
  const botMember =
    guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!botMember) {
    await replyPrivate(
      interaction,
      "Could not verify Superior's current server permissions.",
    );
    return;
  }
  const issues = validateTicketSetupResources(
    guild,
    category,
    logChannel,
    supportRole,
    actor,
    botMember,
  );
  if (issues.length > 0) {
    await replyPrivate(interaction, `Ticket setup failed: ${issues.join(" ")}`);
    return;
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server was disabled or reconfigured. Please try again.",
    );
    return;
  }
  const previous = runtime.storage.getTicketConfiguration();
  const activeTickets = runtime.storage.listTickets([
    "creating",
    "open",
    "closing",
  ]);
  const rotatesActiveAccess =
    previous &&
    activeTickets.length > 0 &&
    (previous.categoryId !== category.id ||
      previous.supportRoleId !== supportRole.id);
  let replacingMissingAccessResource = false;
  if (rotatesActiveAccess && previous) {
    const replacementSafety = await inspectPreviousAccessResources(
      guild,
      previous.categoryId !== category.id ? previous.categoryId : null,
      previous.supportRoleId !== supportRole.id ? previous.supportRoleId : null,
    );
    if (replacementSafety === "unavailable") {
      await replyPrivate(
        interaction,
        "Superior could not verify the previous ticket category or support role with Discord. No configuration was changed; try again shortly.",
      );
      return;
    }
    if (replacementSafety === "present") {
      await replyPrivate(
        interaction,
        `Superior did not change the ticket category or support role because ${activeTickets.length} active ticket record${activeTickets.length === 1 ? " exists" : "s exist"}. Close those tickets first; changing only the log channel remains safe while tickets are active.`,
      );
      return;
    }
    replacingMissingAccessResource = true;
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server changed while the previous ticket resources were being checked. No configuration was changed.",
    );
    return;
  }
  runtime.storage.upsertTicketConfiguration({
    enabled: true,
    categoryId: category.id,
    logChannelId: logChannel.id,
    supportRoleId: supportRole.id,
  });
  runtime.invalidate();
  await replyPrivate(
    interaction,
    `Tickets are enabled. New channels will be created under **${escapeMarkdown(category.name)}**, support access uses <@&${supportRole.id}>, and closures will be logged in <#${logChannel.id}>.${replacingMissingAccessResource ? " The previous access resource was confirmed missing; run /ticket recover for each active ticket to reconcile its channel and controls." : ""}`,
  );
  runtime.storage.recordCommandMetric("ticket.setup");
}

async function showTicketStatus(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const configuration = runtime.storage.getTicketConfiguration();
  if (!configuration) {
    await replyPrivate(
      interaction,
      "Tickets are not configured. Run `/ticket setup` to choose a category, log channel, and support role.",
    );
    return;
  }
  const guild = interaction.guild;
  if (!guild || guild.id !== runtime.guildId) {
    await replyPrivate(interaction, "Ticket status is unavailable here.");
    return;
  }
  const resources = await inspectTicketConfigurationResources(
    guild,
    configuration,
  );
  const active = runtime.storage.listTickets(["creating", "open", "closing"]);
  const lines = [
    "**Superior ticket status**",
    `New tickets: **${configuration.enabled ? "enabled" : "disabled"}**`,
    `Category: <#${configuration.categoryId}>`,
    `Log channel: <#${configuration.logChannelId}>`,
    `Support role: <@&${configuration.supportRoleId}>`,
    `Active records: **${active.length}**`,
    resources.issues.length === 0
      ? "Permissions and configured resources are ready."
      : `Needs attention:\n${resources.issues.map((issue) => `• ${issue}`).join("\n")}`,
  ];
  await replyPrivate(interaction, lines.join("\n").slice(0, 2_000));
  runtime.storage.recordCommandMetric("ticket.status");
}

async function disableTickets(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server changed before tickets could be disabled. Review the latest status and try again.",
    );
    return;
  }
  const configuration = runtime.storage.disableTicketConfiguration();
  if (!configuration) {
    await replyPrivate(
      interaction,
      "Tickets are not configured in this server.",
    );
    return;
  }
  runtime.invalidate();
  await replyPrivate(
    interaction,
    "New tickets are disabled. Existing ticket records and channels were preserved.",
  );
  runtime.storage.recordCommandMetric("ticket.disable");
}

async function recoverTicket(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
): Promise<void> {
  const ticketNumber = interaction.options.getInteger("ticket_number", true);
  let ticket = runtime.storage.getTicketByNumber(ticketNumber);
  if (!ticket) {
    await replyPrivate(interaction, `Ticket #${ticketNumber} was not found.`);
    return;
  }
  const guild = interaction.guild;
  if (
    !guild ||
    guild.id !== runtime.guildId ||
    actor.guild.id !== runtime.guildId
  ) {
    await replyPrivate(
      interaction,
      "That ticket does not belong to this server.",
    );
    return;
  }
  const channelLookup = ticket.channelId
    ? await fetchTicketChannel(guild, ticket.channelId)
    : { status: "missing" as const, channel: null };
  if (channelLookup.status === "unavailable") {
    await replyPrivate(
      interaction,
      `Superior could not verify the channel for ticket #${ticket.ticketNumber}. No recovery changes were made; try again shortly.`,
    );
    return;
  }
  let existingChannel = channelLookup.channel;
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server changed while recovery was inspecting the ticket. No channel was changed.",
    );
    return;
  }
  const refreshedTicket = runtime.storage.getTicketById(ticket.ticketId);
  if (!refreshedTicket || !isSameRecoverySnapshot(ticket, refreshedTicket)) {
    await replyPrivate(
      interaction,
      `Ticket #${ticket.ticketNumber} changed while recovery was inspecting it. Review its latest status and try again.`,
    );
    return;
  }
  ticket = refreshedTicket;
  if (ticket.state === "creating" && !ticket.channelId) {
    const discovery = findInterruptedTicketChannel(guild, ticket);
    if (
      discovery.status === "ambiguous" ||
      discovery.status === "unavailable"
    ) {
      await replyPrivate(
        interaction,
        discovery.status === "ambiguous"
          ? `Ticket #${ticket.ticketNumber} has multiple channel candidates. No binding was changed; inspect the category and remove duplicates manually.`
          : `Superior could not safely scan the bounded channel cache for ticket #${ticket.ticketNumber}. No binding was changed.`,
      );
      return;
    }
    if (discovery.status === "found") {
      const rebound = runtime.storage.rebindTicket(
        ticket.ticketId,
        {
          channelId: discovery.channel.id,
          controlMessageId: null,
          expectedChannelId: null,
          expectedControlMessageId: null,
          expectedState: ticket.state,
          expectedUpdatedAt: ticket.updatedAt,
        },
        actor.id,
      );
      if (rebound.status !== "rebound") {
        await replyPrivate(
          interaction,
          `Ticket #${ticket.ticketNumber} changed while its interrupted channel was being recovered. Review the latest status and try again.`,
        );
        return;
      }
      ticket = rebound.ticket;
      existingChannel = discovery.channel;
    }
  }
  if (ticket.state === "creating") {
    if (existingChannel?.type === ChannelType.GuildText) {
      const activation = runtime.storage.activateTicketCreation(
        ticket.ticketId,
        { channelId: existingChannel.id },
      );
      if (
        activation.status !== "activated" &&
        activation.status !== "already-active"
      ) {
        await replyPrivate(
          interaction,
          `Ticket #${ticket.ticketNumber} could not resume its interrupted creation.`,
        );
        runtime.storage.recordCommandMetric("ticket.recover", false);
        return;
      }
      ticket = activation.ticket;
    } else {
      if (!isRecoveryLeaseExpired(ticket.updatedAt)) {
        await replyPrivate(
          interaction,
          `Ticket #${ticket.ticketNumber} is still within its creation window. Wait a few minutes before recovering an interrupted reservation.`,
        );
        return;
      }
      const result = runtime.storage.failTicketCreation(
        ticket.ticketId,
        `Reconciled by ${actor.id} after an interrupted creation without a persisted channel`,
      );
      const released =
        result.status === "failed" || result.status === "already-failed";
      await replyPrivate(
        interaction,
        released
          ? `Ticket #${ticket.ticketNumber} had no recoverable channel and was released. The member may open a new ticket.`
          : `Ticket #${ticket.ticketNumber} could not be reconciled from its current state.`,
      );
      runtime.storage.recordCommandMetric("ticket.recover", released);
      return;
    }
  }
  if (ticket.state === "failed") {
    await replyPrivate(
      interaction,
      `Ticket #${ticket.ticketNumber} is already marked failed; the member may open a new ticket.`,
    );
    return;
  }
  if (ticket.state === "closed") {
    if (existingChannel?.type === ChannelType.GuildText) {
      const deleted = await existingChannel
        .delete(`Superior closed-ticket recovery by ${actor.id}`)
        .then(() => true)
        .catch(() => false);
      await replyPrivate(
        interaction,
        deleted
          ? `Removed the lingering channel for closed ticket #${ticket.ticketNumber}.`
          : `Ticket #${ticket.ticketNumber} is closed, but Superior could not remove its lingering channel. Verify Manage Channels in that channel and try again.`,
      );
      runtime.storage.recordCommandMetric("ticket.recover", deleted);
    } else {
      await replyPrivate(
        interaction,
        `Ticket #${ticket.ticketNumber} is closed and has no live channel to reconcile.`,
      );
      runtime.storage.recordCommandMetric("ticket.recover");
    }
    return;
  }
  if (ticket.state === "closing") {
    if (ticket.closeLogMessageId) {
      const finished = runtime.storage.finishTicketClose(ticket.ticketId);
      if (
        finished.status !== "closed" &&
        finished.status !== "already-closed"
      ) {
        await replyPrivate(
          interaction,
          `Ticket #${ticket.ticketNumber} has a saved closure log, but its record could not be finalized.`,
        );
        return;
      }
      const deleted =
        !existingChannel || existingChannel.type !== ChannelType.GuildText
          ? true
          : await existingChannel
              .delete(`Superior logged-ticket recovery by ${actor.id}`)
              .then(() => true)
              .catch(() => false);
      await replyPrivate(
        interaction,
        deleted
          ? `Ticket #${ticket.ticketNumber} had already been logged and is now fully closed.`
          : `Ticket #${ticket.ticketNumber} is closed, but Discord did not remove its channel. Run recovery again after correcting Superior's channel permissions.`,
      );
      runtime.storage.recordCommandMetric("ticket.recover");
      return;
    }
    if (!isRecoveryLeaseExpired(ticket.closingAt ?? ticket.updatedAt)) {
      await replyPrivate(
        interaction,
        `Ticket #${ticket.ticketNumber} is still within its closure window. Wait a few minutes before reopening an interrupted close.`,
      );
      return;
    }
    const rollback = runtime.storage.reopenAfterCloseFailure(
      ticket.ticketId,
      `Reopened by recovery command from ${actor.id}`,
    );
    if (rollback.status !== "reopened" && rollback.status !== "already-open") {
      await replyPrivate(
        interaction,
        `Ticket #${ticket.ticketNumber} could not be returned to an open state.`,
      );
      return;
    }
    ticket = rollback.ticket;
  }
  const configuration = runtime.storage.getTicketConfiguration();
  if (!configuration) {
    await replyPrivate(
      interaction,
      "Ticket configuration is missing. Run `/ticket setup` before recovery.",
    );
    return;
  }
  const resources = await inspectTicketConfigurationResources(
    guild,
    configuration,
  );
  if (resources.issues.length > 0) {
    await replyPrivate(
      interaction,
      `Recovery needs valid ticket resources: ${resources.issues.join(" ")}`,
    );
    return;
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server changed while recovery was running. Please try again.",
    );
    return;
  }
  const expectedChannelId = ticket.channelId;
  const expectedControlMessageId = ticket.controlMessageId;
  const expectedState = ticket.state;
  const expectedUpdatedAt = ticket.updatedAt;
  let channel: TextChannel | null =
    existingChannel?.type === ChannelType.GuildText ? existingChannel : null;
  let created = false;
  let controlMessage: Message | null = null;
  let controlMessageCreated = false;
  const openerLookup = await fetchTicketOpener(guild, ticket.openerId);
  if (openerLookup.status === "unavailable") {
    await replyPrivate(
      interaction,
      `Superior could not verify whether the opener of ticket #${ticket.ticketNumber} is still a member. No channel permissions were changed; try again shortly.`,
    );
    return;
  }
  const openerMissing = openerLookup.status === "missing";
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server changed while recovery was running. Please try again.",
    );
    return;
  }
  if (channel && expectedControlMessageId) {
    const controlLookup = await fetchRecoveryControlMessage(
      channel,
      expectedControlMessageId,
      resources.botMember!.id,
    );
    if (controlLookup.status === "unavailable") {
      await replyPrivate(
        interaction,
        `Superior could not verify the tracked control message for ticket #${ticket.ticketNumber}. No recovery changes were made; try again shortly.`,
      );
      return;
    }
    controlMessage = controlLookup.message;
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server changed while recovery was checking the current controls. No channel was changed.",
    );
    return;
  }
  try {
    if (!channel) {
      channel = await createPrivateTicketChannel(guild, resources, ticket, {
        includeOpener: !openerMissing,
      });
      created = true;
    } else {
      channel = await reconcilePrivateTicketChannel(
        guild,
        channel,
        resources,
        ticket,
        { includeOpener: !openerMissing },
      );
    }
    if (!runtime.isCurrent()) {
      throw new Error("Server configuration changed during channel recovery.");
    }
    if (controlMessage) {
      controlMessage = await controlMessage.edit(
        buildTicketWelcomePayload(ticket),
      );
    } else {
      controlMessage = await channel.send(buildTicketWelcomePayload(ticket));
      controlMessageCreated = true;
    }
    if (!runtime.isCurrent()) {
      throw new Error("Server configuration changed while controls were sent.");
    }
    const rebound = runtime.storage.rebindTicket(
      ticket.ticketId,
      {
        channelId: channel.id,
        controlMessageId: controlMessage.id,
        expectedChannelId,
        expectedControlMessageId,
        expectedState,
        expectedUpdatedAt,
      },
      actor.id,
    );
    if (rebound.status !== "rebound") {
      throw new Error("Ticket state changed before recovery completed.");
    }
  } catch (error) {
    let cleanupNote = "";
    let createdChannelRemoved = false;
    if (created && channel) {
      createdChannelRemoved = await channel
        .delete(`Rolling back failed Superior recovery by ${actor.id}`)
        .then(() => true)
        .catch(() => false);
    }
    if (!runtime.isCurrent()) {
      let quarantined = false;
      if (
        channel &&
        (!created || !createdChannelRemoved) &&
        resources.botMember
      ) {
        quarantined = await quarantinePrivateTicketChannel(
          guild,
          channel,
          resources.botMember,
          ticket,
          { includeOpener: false },
        )
          .then(() => true)
          .catch(() => false);
      }
      let controlRemoved = true;
      if (
        controlMessageCreated &&
        controlMessage &&
        (!created || !createdChannelRemoved)
      ) {
        controlRemoved = await controlMessage
          .delete()
          .then(() => true)
          .catch(() => false);
      }
      await replyPrivate(
        interaction,
        `This server changed during ticket recovery. No newer stored data was changed.${createdChannelRemoved ? " The newly created channel was removed." : quarantined ? " The affected channel was restricted to the bot." : channel ? " Superior could not remove or restrict the affected channel; inspect it manually." : ""}${controlRemoved ? "" : " A newly posted control message could not be removed, but it will fail closed."}`,
      );
      return;
    }
    if (created && channel) {
      if (!createdChannelRemoved) {
        const preserved = runtime.storage.rebindTicket(
          ticket.ticketId,
          {
            channelId: channel.id,
            controlMessageId: controlMessage?.id ?? null,
            expectedChannelId,
            expectedControlMessageId,
            expectedState,
            expectedUpdatedAt,
          },
          actor.id,
        );
        if (preserved.status === "rebound") {
          cleanupNote = ` Discord did not remove <#${channel.id}>, so the ticket remains bound there for another recovery attempt.`;
        } else {
          const quarantined = resources.botMember
            ? await quarantinePrivateTicketChannel(
                guild,
                channel,
                resources.botMember,
                ticket,
                { includeOpener: false },
              )
                .then(() => true)
                .catch(() => false)
            : false;
          const controlRemoved = controlMessage
            ? await controlMessage
                .delete()
                .then(() => true)
                .catch(() => false)
            : true;
          if (runtime.isCurrent()) {
            runtime.storage.appendTicketEvent(ticket.ticketId, {
              type: "recovery_noted",
              actorId: actor.id,
              details: {
                reason: "Concurrent recovery orphan cleanup failed",
                orphanChannelId: channel.id,
                quarantined,
                controlRemoved,
              },
            });
          }
          cleanupNote = quarantined
            ? ` Discord did not remove the untracked channel <#${channel.id}>, so Superior restricted it to the bot; remove it manually.`
            : ` Discord did not remove or restrict the untracked channel <#${channel.id}>; verify its permissions and remove it manually.`;
          if (!controlRemoved) {
            cleanupNote +=
              " Its untracked control message could not be removed, but it will fail closed.";
          }
        }
      }
    } else {
      if (controlMessageCreated && controlMessage) {
        const removed = await controlMessage
          .delete()
          .then(() => true)
          .catch(() => false);
        if (!removed) {
          cleanupNote +=
            " A stale control message could not be removed, but its controls will fail closed.";
        }
      }
    }
    await replyPrivate(
      interaction,
      `Superior could not safely recreate or refresh ticket #${ticket.ticketNumber}. Its record was preserved; verify the configured resources and Superior's permissions, then try again.${cleanupNote}`,
    );
    if (runtime.isCurrent()) {
      runtime.storage.recordCommandMetric("ticket.recover", false);
    }
    return;
  }
  await replyPrivate(
    interaction,
    `${created ? "Recreated" : "Refreshed"} ticket #${ticket.ticketNumber} in <#${channel.id}>.${openerMissing ? " The opener is no longer a server member, so the recovered channel is staff-only." : ""}`,
  );
  runtime.storage.recordCommandMetric("ticket.recover");
}

async function inspectPreviousAccessResources(
  guild: Guild,
  categoryId: string | null,
  supportRoleId: string | null,
): Promise<"missing" | "present" | "unavailable"> {
  const checks = await Promise.all([
    categoryId
      ? fetchTicketChannel(guild, categoryId).then(({ status }) => status)
      : Promise.resolve("missing" as const),
    supportRoleId
      ? fetchTicketRole(guild, supportRoleId)
      : Promise.resolve("missing" as const),
  ]);
  if (checks.includes("unavailable")) return "unavailable";
  return checks.includes("present") ? "present" : "missing";
}

async function fetchTicketRole(
  guild: Guild,
  roleId: string,
): Promise<"missing" | "present" | "unavailable"> {
  try {
    const role = await guild.roles.fetch(roleId);
    if (!role) return "missing";
    return role.guild.id === guild.id ? "present" : "unavailable";
  } catch (error) {
    return isUnknownDiscordResourceError(error, 10_011)
      ? "missing"
      : "unavailable";
  }
}

function isSameRecoverySnapshot(
  expected: TicketRecord,
  current: TicketRecord,
): boolean {
  return (
    current.guildId === expected.guildId &&
    current.ticketId === expected.ticketId &&
    current.ticketNumber === expected.ticketNumber &&
    current.openerId === expected.openerId &&
    current.state === expected.state &&
    current.channelId === expected.channelId &&
    current.controlMessageId === expected.controlMessageId &&
    current.closeLogMessageId === expected.closeLogMessageId &&
    current.updatedAt === expected.updatedAt
  );
}

function findInterruptedTicketChannel(
  guild: Guild,
  ticket: TicketRecord,
):
  | { status: "none" | "ambiguous" | "unavailable"; channel: null }
  | { status: "found"; channel: TextChannel } {
  const marker = ticketChannelRecoveryMarker(ticket.ticketId);
  const matches: TextChannel[] = [];
  let inspected = 0;
  for (const candidate of guild.channels.cache.values()) {
    inspected += 1;
    if (inspected > TICKET_RECOVERY_CHANNEL_SCAN_LIMIT) {
      return { status: "unavailable", channel: null };
    }
    if (
      candidate.guild.id === guild.id &&
      candidate.type === ChannelType.GuildText &&
      candidate.topic?.includes(marker)
    ) {
      matches.push(candidate);
      if (matches.length > 1) {
        return { status: "ambiguous", channel: null };
      }
    }
  }
  return matches[0]
    ? { status: "found", channel: matches[0] }
    : { status: "none", channel: null };
}

function isRecoveryLeaseExpired(timestamp: string): boolean {
  const updatedAt = Date.parse(timestamp);
  return (
    Number.isFinite(updatedAt) &&
    Date.now() - updatedAt >= TICKET_RECOVERY_LEASE_MS
  );
}

async function fetchTicketOpener(
  guild: Guild,
  openerId: string,
): Promise<
  | { status: "present"; member: GuildMember }
  | { status: "missing" | "unavailable"; member: null }
> {
  try {
    const member = await guild.members.fetch(openerId);
    if (!member) return { status: "missing", member: null };
    return member.guild.id === guild.id
      ? { status: "present", member }
      : { status: "unavailable", member: null };
  } catch (error) {
    return isUnknownMemberError(error)
      ? { status: "missing", member: null }
      : { status: "unavailable", member: null };
  }
}

async function fetchTicketChannel(
  guild: Guild,
  channelId: string,
): Promise<
  | { status: "present"; channel: GuildBasedChannel }
  | { status: "missing" | "unavailable"; channel: null }
> {
  try {
    const channel = await guild.channels.fetch(channelId);
    if (!channel) return { status: "missing", channel: null };
    return channel.guild.id === guild.id
      ? { status: "present", channel }
      : { status: "unavailable", channel: null };
  } catch (error) {
    return isUnknownDiscordResourceError(error, 10_003)
      ? { status: "missing", channel: null }
      : { status: "unavailable", channel: null };
  }
}

async function fetchRecoveryControlMessage(
  channel: TextChannel,
  messageId: string,
  botId: string,
): Promise<
  | { status: "present"; message: Message }
  | { status: "missing" | "unavailable"; message: null }
> {
  try {
    const message = await channel.messages.fetch(messageId);
    if (!message) return { status: "missing", message: null };
    return message.author.id === botId
      ? { status: "present", message }
      : { status: "unavailable", message: null };
  } catch (error) {
    return isUnknownDiscordResourceError(error, 10_008)
      ? { status: "missing", message: null }
      : { status: "unavailable", message: null };
  }
}

function isUnknownMemberError(error: unknown): boolean {
  return isUnknownDiscordResourceError(error, 10_007);
}

function isUnknownDiscordResourceError(
  error: unknown,
  expectedCode: number,
): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    rawError?: { code?: unknown };
  };
  return (
    candidate.code === expectedCode || candidate.rawError?.code === expectedCode
  );
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
