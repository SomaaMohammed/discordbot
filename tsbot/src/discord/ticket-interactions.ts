import {
  ChannelType,
  type ButtonInteraction,
  type Guild,
  type GuildMember,
  type InteractionReplyOptions,
  type ModalSubmitInteraction,
  type TextChannel,
} from "discord.js";
import type { GuildRuntime } from "../runtime.js";
import type { TicketRecord } from "../types.js";
import {
  SAFE_PANEL_ALLOWED_MENTIONS,
  parseTicketOpenCustomId,
} from "./panel-theme.js";
import { evaluateTicketStaff } from "./ticket-authorization.js";
import {
  TICKET_CLOSE_REASON_INPUT_ID,
  TICKET_DESCRIPTION_INPUT_ID,
  TICKET_INPUT_LIMITS,
  TICKET_SUBJECT_INPUT_ID,
  buildTicketClosureEmbed,
  buildTicketControlRow,
  buildTicketInfoPayload,
  buildTicketWelcomePayload,
  createTicketCloseModal,
  createTicketOpenModal,
  normalizeTicketInput,
  parseTicketComponentId,
} from "./ticket-components.js";
import {
  canDeliverTicketLog,
  createPrivateTicketChannel,
  inspectTicketConfigurationResources,
  quarantinePrivateTicketChannel,
} from "./ticket-permissions.js";
import {
  collectTicketTranscript,
  type TranscriptChannelLike,
} from "./ticket-transcript.js";

const TICKET_COMPONENT_NAMESPACE = "superior:ticket:";

type TicketInteraction = ButtonInteraction | ModalSubmitInteraction;

export async function handleTicketButton(
  interaction: ButtonInteraction,
  runtime: GuildRuntime,
): Promise<boolean> {
  if (!interaction.customId.startsWith(TICKET_COMPONENT_NAMESPACE)) {
    return false;
  }
  const panelId = parseTicketOpenCustomId(interaction.customId);
  if (panelId) {
    await handleOpenButton(interaction, runtime, panelId);
    return true;
  }
  const parsed = parseTicketComponentId(interaction.customId);
  if (
    !parsed ||
    parsed.kind === "open-modal" ||
    parsed.kind === "close-modal"
  ) {
    await replyPrivate(
      interaction,
      "This ticket control is outdated or invalid. Ask an administrator to refresh it.",
    );
    return true;
  }
  const ticket = await resolveTicketForButton(
    interaction,
    runtime,
    parsed.ticketId,
  );
  if (!ticket) return true;
  if (parsed.kind === "close") {
    const actor = await requireTicketStaff(interaction, runtime);
    if (!actor) return true;
    const current = runtime.storage.getTicketById(ticket.ticketId);
    if (
      !runtime.isCurrent() ||
      !current ||
      !isCurrentTicketControl(interaction, runtime, current)
    ) {
      await replyPrivate(
        interaction,
        "This server or ticket changed while the close control was being verified. Please try again from the current ticket message.",
      );
      return true;
    }
    await interaction.showModal(createTicketCloseModal(current.ticketId));
    return true;
  }
  await deferPrivate(interaction);
  if (parsed.kind === "info") {
    const actor = await fetchInteractionMember(interaction, runtime.guildId);
    if (!actor) {
      await replyPrivate(
        interaction,
        "Could not verify your server membership.",
      );
      return true;
    }
    if (actor.id !== ticket.openerId) {
      const staff = await isTicketStaff(interaction.guild!, runtime, actor);
      if (!staff) {
        await replyPrivate(
          interaction,
          "Only the ticket opener or authorized support staff can inspect this ticket.",
        );
        return true;
      }
    }
    const current = runtime.storage.getTicketById(ticket.ticketId);
    if (
      !runtime.isCurrent() ||
      !current ||
      !isCurrentTicketControl(interaction, runtime, current)
    ) {
      await replyPrivate(
        interaction,
        "This server or ticket changed while its status was being verified. Please try again from the current ticket message.",
      );
      return true;
    }
    await replyPrivate(interaction, buildTicketInfoPayload(current));
    runtime.storage.recordCommandMetric("ticket.info");
    return true;
  }
  const actor = await requireTicketStaff(interaction, runtime);
  if (!actor) return true;
  if (!runtime.isCurrent()) {
    await replyPrivate(interaction, "This server changed. Please try again.");
    return true;
  }
  const currentTicket = runtime.storage.getTicketById(ticket.ticketId);
  if (
    !currentTicket ||
    !isCurrentTicketControl(interaction, runtime, currentTicket)
  ) {
    await replyPrivate(
      interaction,
      "This ticket control changed while your staff access was being verified. Use the current control message and try again.",
    );
    return true;
  }
  if (parsed.kind === "claim") {
    const result = runtime.storage.claimTicket(
      currentTicket.ticketId,
      actor.id,
    );
    if (result.status === "claimed" || result.status === "already-claimed") {
      await refreshTicketControls(interaction, result.ticket);
      await replyPrivate(
        interaction,
        result.status === "claimed"
          ? `You claimed ticket #${currentTicket.ticketNumber}.`
          : `You already hold the claim on ticket #${currentTicket.ticketNumber}.`,
      );
      runtime.storage.recordCommandMetric("ticket.claim");
    } else if (result.status === "conflict") {
      await refreshTicketControls(interaction, result.ticket);
      await replyPrivate(
        interaction,
        `Ticket #${currentTicket.ticketNumber} is already claimed by another staff member.`,
      );
    } else {
      await replyPrivate(
        interaction,
        `Ticket #${currentTicket.ticketNumber} is no longer available to claim.`,
      );
    }
    return true;
  }
  const result = runtime.storage.releaseTicket(
    currentTicket.ticketId,
    actor.id,
  );
  if (result.status === "released" || result.status === "already-released") {
    await refreshTicketControls(interaction, result.ticket);
    await replyPrivate(
      interaction,
      result.status === "released"
        ? `Released the claim on ticket #${currentTicket.ticketNumber}.`
        : `Ticket #${currentTicket.ticketNumber} is already unclaimed.`,
    );
    runtime.storage.recordCommandMetric("ticket.release");
  } else {
    await replyPrivate(
      interaction,
      `Ticket #${currentTicket.ticketNumber} is no longer available to release.`,
    );
  }
  return true;
}

export async function handleTicketModal(
  interaction: ModalSubmitInteraction,
  runtime: GuildRuntime,
): Promise<boolean> {
  if (!interaction.customId.startsWith(TICKET_COMPONENT_NAMESPACE)) {
    return false;
  }
  const parsed = parseTicketComponentId(interaction.customId);
  if (
    !parsed ||
    (parsed.kind !== "open-modal" && parsed.kind !== "close-modal")
  ) {
    await replyPrivate(
      interaction,
      "This ticket form is outdated or invalid. Please open a fresh form.",
    );
    return true;
  }
  if (parsed.kind === "open-modal") {
    await handleOpenModal(interaction, runtime, parsed.panelId);
  } else {
    await handleCloseModal(interaction, runtime, parsed.ticketId);
  }
  return true;
}

async function handleOpenButton(
  interaction: ButtonInteraction,
  runtime: GuildRuntime,
  panelId: string,
): Promise<void> {
  const panel = runtime.storage.findPostedPanelByToken(panelId);
  const configuration = runtime.storage.getTicketConfiguration();
  if (
    !panel ||
    panel.preset !== "tickets" ||
    panel.channelId !== interaction.channelId ||
    panel.messageId !== interaction.message.id ||
    interaction.message.author.id !== interaction.client.user?.id ||
    !configuration?.enabled ||
    interaction.guild?.id !== runtime.guildId ||
    !runtime.isCurrent()
  ) {
    await replyPrivate(
      interaction,
      "This ticket panel is outdated or tickets are unavailable. Ask an administrator to refresh it.",
    );
    return;
  }
  await interaction.showModal(createTicketOpenModal(panel.panelId));
  runtime.storage.recordCommandMetric("panel.tickets.use");
}

async function handleOpenModal(
  interaction: ModalSubmitInteraction,
  runtime: GuildRuntime,
  panelId: string,
): Promise<void> {
  const panel = runtime.storage.findPostedPanelByToken(panelId);
  const configuration = runtime.storage.getTicketConfiguration();
  if (
    !panel ||
    panel.preset !== "tickets" ||
    panel.channelId !== interaction.channelId ||
    !configuration?.enabled ||
    interaction.guild?.id !== runtime.guildId
  ) {
    await replyPrivate(
      interaction,
      "This ticket form is outdated or tickets are currently disabled.",
    );
    return;
  }
  let subject: string;
  let description: string;
  try {
    subject = normalizeTicketInput(
      interaction.fields.getTextInputValue(TICKET_SUBJECT_INPUT_ID),
      "Subject",
      TICKET_INPUT_LIMITS.subject,
    );
    description = normalizeTicketInput(
      interaction.fields.getTextInputValue(TICKET_DESCRIPTION_INPUT_ID),
      "Description",
      TICKET_INPUT_LIMITS.description,
    );
  } catch (error) {
    await replyPrivate(interaction, errorMessage(error));
    return;
  }
  await deferPrivate(interaction);
  const guild = interaction.guild;
  if (!guild || guild.id !== runtime.guildId) {
    await replyPrivate(interaction, "Ticket creation must run in this server.");
    return;
  }
  const launcherChannel = await guild.channels
    .fetch(panel.channelId)
    .catch(() => null);
  if (
    !launcherChannel ||
    (launcherChannel.type !== ChannelType.GuildText &&
      launcherChannel.type !== ChannelType.GuildAnnouncement)
  ) {
    await replyPrivate(
      interaction,
      "The ticket launcher no longer exists. Ask an administrator to post it again.",
    );
    return;
  }
  const launcherMessage = await launcherChannel.messages
    .fetch(panel.messageId)
    .catch(() => null);
  if (launcherMessage?.author.id !== interaction.client.user?.id) {
    await replyPrivate(
      interaction,
      "The ticket launcher is outdated. Ask an administrator to post it again.",
    );
    return;
  }
  const opener = await fetchInteractionMember(interaction, runtime.guildId);
  if (!opener || opener.user.bot) {
    await replyPrivate(interaction, "Could not verify your server membership.");
    return;
  }
  const resources = await inspectTicketConfigurationResources(
    guild,
    configuration,
  );
  if (resources.issues.length > 0) {
    await replyPrivate(
      interaction,
      `Tickets need administrator attention: ${resources.issues.join(" ")}`,
    );
    runtime.storage.recordCommandMetric("ticket.create", false);
    return;
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(interaction, "This server changed. Please try again.");
    return;
  }
  const reservation = runtime.storage.reserveTicketCreation({
    openerId: opener.id,
    subject,
    description,
  });
  if (reservation.status === "existing") {
    await replyPrivate(interaction, existingTicketMessage(reservation.ticket));
    return;
  }
  let channel: TextChannel | null = null;
  let createdTicket: TicketRecord | null = null;
  let controlMessage: Awaited<ReturnType<TextChannel["send"]>> | null = null;
  try {
    channel = await createPrivateTicketChannel(
      guild,
      resources,
      reservation.ticket,
    );
    if (!runtime.isCurrent()) {
      throw new Error("Server configuration changed during ticket creation.");
    }
    const bound = runtime.storage.rebindTicket(
      reservation.ticket.ticketId,
      {
        channelId: channel.id,
        controlMessageId: null,
        expectedChannelId: null,
        expectedControlMessageId: null,
        expectedState: reservation.ticket.state,
        expectedUpdatedAt: reservation.ticket.updatedAt,
      },
      opener.id,
    );
    if (bound.status !== "rebound") {
      throw new Error("Ticket channel binding could not be persisted.");
    }
    const activated = runtime.storage.activateTicketCreation(
      reservation.ticket.ticketId,
      { channelId: channel.id },
    );
    if (
      activated.status !== "activated" &&
      activated.status !== "already-active"
    ) {
      throw new Error("Ticket reservation was no longer available.");
    }
    controlMessage = await channel.send(
      buildTicketWelcomePayload(activated.ticket),
    );
    if (!runtime.isCurrent()) {
      throw new Error("Server configuration changed while controls were sent.");
    }
    const rebound = runtime.storage.rebindTicket(activated.ticket.ticketId, {
      channelId: channel.id,
      controlMessageId: controlMessage.id,
      expectedChannelId: channel.id,
      expectedControlMessageId: null,
      expectedState: activated.ticket.state,
      expectedUpdatedAt: activated.ticket.updatedAt,
    });
    if (
      rebound.status === "conflict" &&
      rebound.ticket.channelId === channel.id &&
      rebound.ticket.controlMessageId
    ) {
      await controlMessage.delete().catch(() => undefined);
      controlMessage = null;
      createdTicket = rebound.ticket;
    } else if (rebound.status !== "rebound") {
      throw new Error("Ticket controls could not be persisted.");
    } else {
      createdTicket = rebound.ticket;
    }
  } catch (error) {
    const staleAtCleanup = !runtime.isCurrent();
    let latest = staleAtCleanup
      ? null
      : runtime.storage.getTicketById(reservation.ticket.ticketId);
    const durableChannel = Boolean(
      !staleAtCleanup &&
      channel &&
      latest?.channelId === channel.id &&
      latest.controlMessageId &&
      (latest.state === "open" ||
        latest.state === "closing" ||
        latest.state === "closed"),
    );
    let incompleteChannelRemoved = !channel;
    let incompleteChannelQuarantined = false;
    if (channel && !durableChannel) {
      incompleteChannelRemoved = await channel
        .delete("Rolling back an incomplete Superior ticket")
        .then(() => true)
        .catch(() => false);
      if (!incompleteChannelRemoved && resources.botMember) {
        incompleteChannelQuarantined = await quarantinePrivateTicketChannel(
          guild,
          channel,
          resources.botMember,
          reservation.ticket,
          { includeOpener: false },
        )
          .then(() => true)
          .catch(() => false);
      }
    }
    if (!runtime.isCurrent()) {
      await replyPrivate(
        interaction,
        !channel
          ? "This server changed while the ticket was being created. No stale database cleanup was attempted; ask an administrator to review `/ticket status` and recover the reservation if necessary."
          : incompleteChannelRemoved
            ? "This server changed while the ticket was being created. The incomplete Discord channel was removed without changing the newer stored data."
            : incompleteChannelQuarantined
              ? `This server changed while the ticket was being created. Superior could not remove <#${channel.id}>, so it was restricted to the bot without changing the newer stored data.`
              : `This server changed while the ticket was being created. Superior could not remove or restrict <#${channel.id}>; an administrator must inspect it manually. No newer stored data was changed.`,
      );
      return;
    }
    if (!channel || incompleteChannelRemoved) {
      latest = runtime.storage.failTicketCreation(
        reservation.ticket.ticketId,
        errorMessage(error).slice(0, 400),
      ).ticket;
    } else if (latest) {
      if (latest.state === "creating" && latest.channelId === null) {
        const preserved = runtime.storage.rebindTicket(
          latest.ticketId,
          {
            channelId: channel.id,
            controlMessageId: null,
            expectedChannelId: null,
            expectedControlMessageId: null,
            expectedState: latest.state,
            expectedUpdatedAt: latest.updatedAt,
          },
          opener.id,
        );
        latest = preserved.ticket;
      }
      if (latest) {
        runtime.storage.appendTicketEvent(latest.ticketId, {
          type: "recovery_noted",
          actorId: opener.id,
          details: {
            reason: "Incomplete ticket channel could not be deleted",
            channelId: channel.id,
            quarantined: incompleteChannelQuarantined,
          },
        });
      }
    }
    await replyPrivate(
      interaction,
      durableChannel
        ? `Ticket #${latest?.ticketNumber ?? reservation.ticket.ticketNumber} was completed by another recovery operation in <#${channel?.id}>.`
        : incompleteChannelRemoved
          ? "Superior could not complete the ticket safely. No ticket channel was retained; please try again or contact an administrator."
          : latest
            ? `Superior could not complete the ticket or remove <#${channel?.id}>. The active reservation remains bound to that channel${incompleteChannelQuarantined ? " in a bot-only recovery state" : ""}; ask an administrator to run \`/ticket recover\` before trying again.`
            : `Superior could not complete the ticket or remove the untracked channel <#${channel?.id}>.${incompleteChannelQuarantined ? " It was restricted to the bot." : " Its permissions could not be restricted."} Ask an administrator to remove it before trying again.`,
    );
    if (runtime.isCurrent()) {
      runtime.storage.recordCommandMetric("ticket.create", false);
    }
    return;
  }
  await replyPrivate(
    interaction,
    `Ticket #${createdTicket.ticketNumber} is ready in <#${channel.id}>.`,
  );
  runtime.storage.recordCommandMetric("ticket.create");
}

async function handleCloseModal(
  interaction: ModalSubmitInteraction,
  runtime: GuildRuntime,
  ticketId: string,
): Promise<void> {
  let reason: string;
  try {
    reason = normalizeTicketInput(
      interaction.fields.getTextInputValue(TICKET_CLOSE_REASON_INPUT_ID),
      "Closure reason",
      TICKET_INPUT_LIMITS.closeReason,
    );
  } catch (error) {
    await replyPrivate(interaction, errorMessage(error));
    return;
  }
  await deferPrivate(interaction);
  const ticket = runtime.storage.getTicketById(ticketId);
  if (!ticket || !isTicketChannelInteraction(interaction, runtime, ticket)) {
    await replyPrivate(
      interaction,
      "This closure form is outdated or does not belong to this ticket.",
    );
    return;
  }
  const actor = await requireTicketStaff(interaction, runtime);
  if (!actor) return;
  if (ticket.state === "closed") {
    await replyPrivate(
      interaction,
      `Ticket #${ticket.ticketNumber} is already closed.`,
    );
    return;
  }
  if (ticket.state === "closing") {
    if (!ticket.closeLogMessageId) {
      await replyPrivate(
        interaction,
        `Ticket #${ticket.ticketNumber} is already being closed.`,
      );
      return;
    }
    if (!runtime.isCurrent()) {
      await replyPrivate(interaction, "This server changed. Please try again.");
      return;
    }
    await finishLoggedTicketClose(interaction, runtime, ticket, actor);
    return;
  }
  if (ticket.state !== "open") {
    await replyPrivate(
      interaction,
      `Ticket #${ticket.ticketNumber} is not available to close.`,
    );
    return;
  }
  const guild = interaction.guild!;
  const configuration = runtime.storage.getTicketConfiguration();
  if (!configuration) {
    await replyPrivate(
      interaction,
      "Ticket configuration is missing. Restore it before closing this ticket.",
    );
    return;
  }
  const resources = await inspectTicketConfigurationResources(
    guild,
    configuration,
  );
  if (
    !resources.logChannel ||
    !resources.botMember ||
    !canDeliverTicketLog(resources.logChannel, resources.botMember)
  ) {
    await replyPrivate(
      interaction,
      "The ticket log channel is missing or Superior cannot deliver an embed and transcript there. The ticket remains open.",
    );
    return;
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(interaction, "This server changed. Please try again.");
    return;
  }
  const closeStart = runtime.storage.beginTicketClose(
    ticket.ticketId,
    actor.id,
    reason,
  );
  if (closeStart.status === "already-closing") {
    if (closeStart.ticket.closeLogMessageId) {
      await finishLoggedTicketClose(
        interaction,
        runtime,
        closeStart.ticket,
        actor,
      );
      return;
    }
    await replyPrivate(
      interaction,
      `Ticket #${ticket.ticketNumber} is already being closed.`,
    );
    return;
  }
  if (closeStart.status === "already-closed") {
    await replyPrivate(
      interaction,
      `Ticket #${ticket.ticketNumber} is already closed.`,
    );
    return;
  }
  if (closeStart.status !== "started") {
    await replyPrivate(
      interaction,
      `Ticket #${ticket.ticketNumber} is not available to close.`,
    );
    return;
  }
  const closingTicket = closeStart.ticket;
  let logDelivered = false;
  let logCheckpointed = false;
  try {
    const rawChannel = closingTicket.channelId
      ? await guild.channels.fetch(closingTicket.channelId).catch(() => null)
      : null;
    if (!rawChannel || rawChannel.type !== ChannelType.GuildText) {
      throw new Error("The ticket channel is missing.");
    }
    const channel = rawChannel;
    const transcript = await collectTicketTranscript(
      channel as unknown as TranscriptChannelLike,
      { expectedGuildId: runtime.guildId },
    );
    if (!runtime.isCurrent()) {
      throw new Error("Server configuration changed during ticket closure.");
    }
    const transcriptFile = {
      attachment: transcript.buffer,
      name: `superior-ticket-${closingTicket.ticketNumber}.txt`,
      description: `Plain-text transcript for ticket #${closingTicket.ticketNumber}`,
    };
    const closureEmbed = buildTicketClosureEmbed(closingTicket);
    const logMessage = await resources.logChannel.send({
      embeds: [closureEmbed],
      files: [transcriptFile],
      allowedMentions: SAFE_PANEL_ALLOWED_MENTIONS,
    });
    logDelivered = true;
    const beforeCheckpoint = runtime.storage.getTicketById(
      closingTicket.ticketId,
    );
    if (
      !runtime.isCurrent() ||
      !beforeCheckpoint ||
      !isSameClosingSnapshot(closingTicket, beforeCheckpoint)
    ) {
      throw new Error(
        "Ticket state changed before the closure log could be checkpointed.",
      );
    }
    const checkpoint = runtime.storage.markTicketLogDelivered(
      closingTicket.ticketId,
      logMessage.id,
      closingTicket.updatedAt,
    );
    if (
      checkpoint.status !== "logged" &&
      checkpoint.status !== "already-logged"
    ) {
      throw new Error("The closure log checkpoint could not be persisted.");
    }
    logCheckpointed = true;
    if (!runtime.isCurrent()) {
      throw new Error(
        "Server configuration changed after the closure log was checkpointed.",
      );
    }
    const opener = await interaction.client.users
      .fetch(closingTicket.openerId)
      .catch(() => null);
    if (opener && !opener.bot) {
      await opener
        .send({
          embeds: [closureEmbed],
          files: [transcriptFile],
          allowedMentions: SAFE_PANEL_ALLOWED_MENTIONS,
        })
        .catch(() => undefined);
    }
    const beforeFinish = runtime.storage.getTicketById(closingTicket.ticketId);
    if (
      !runtime.isCurrent() ||
      !beforeFinish ||
      !isSameLoggedClosingSnapshot(checkpoint.ticket, beforeFinish)
    ) {
      throw new Error(
        "Ticket state changed before the logged closure could be finalized.",
      );
    }
    const finished = runtime.storage.finishTicketClose(closingTicket.ticketId);
    if (finished.status !== "closed" && finished.status !== "already-closed") {
      throw new Error("The closure record could not be persisted.");
    }
    const deleted = await channel
      .delete(`Superior ticket #${ticket.ticketNumber} closed by ${actor.id}`)
      .then(() => true)
      .catch(() => false);
    await replyPrivate(
      interaction,
      deleted
        ? `Ticket #${ticket.ticketNumber} was logged and closed.`
        : `Ticket #${ticket.ticketNumber} was logged and closed, but Discord did not remove the channel. Use \`/ticket recover\` to reconcile it.`,
    );
    runtime.storage.recordCommandMetric("ticket.close");
  } catch (error) {
    if (!runtime.isCurrent()) {
      await replyPrivate(
        interaction,
        "This server changed while the ticket was closing. The channel and any saved closure checkpoint were preserved; no newer stored data was changed. Use `/ticket recover` after reviewing the current configuration.",
      );
      return;
    }
    if (!logDelivered) {
      runtime.storage.reopenAfterCloseFailure(
        closingTicket.ticketId,
        `Transcript/log failure: ${errorMessage(error)}`.slice(0, 400),
      );
    }
    await replyPrivate(
      interaction,
      logCheckpointed
        ? "The closure log was saved, but finalization did not complete. The channel was preserved; submit Close again or use `/ticket recover` to finish safely."
        : logDelivered
          ? "The closure log was delivered, but its durable checkpoint failed. The channel was preserved for administrator recovery."
          : "The transcript or closure log could not be delivered. The ticket was returned to an open, recoverable state and its channel was preserved.",
    );
    if (runtime.isCurrent()) {
      runtime.storage.recordCommandMetric("ticket.close", false);
    }
  }
}

async function finishLoggedTicketClose(
  interaction: ModalSubmitInteraction,
  runtime: GuildRuntime,
  ticket: TicketRecord,
  actor: GuildMember,
): Promise<void> {
  const channelLookup = ticket.channelId
    ? await fetchCloseTicketChannel(interaction.guild!, ticket.channelId)
    : { status: "missing" as const, channel: null };
  if (channelLookup.status === "unavailable") {
    await replyPrivate(
      interaction,
      `Superior could not verify the channel for ticket #${ticket.ticketNumber}. Its saved closure remains recoverable; try Close again or use \`/ticket recover\` when Discord is available.`,
    );
    runtime.storage.recordCommandMetric("ticket.close", false);
    return;
  }
  const beforeFinish = runtime.storage.getTicketById(ticket.ticketId);
  if (
    !runtime.isCurrent() ||
    !beforeFinish ||
    !isSameLoggedClosingSnapshot(ticket, beforeFinish)
  ) {
    await replyPrivate(
      interaction,
      `Ticket #${ticket.ticketNumber} changed while its channel was being inspected. Its saved closure was preserved; review the latest record before recovery.`,
    );
    runtime.storage.recordCommandMetric("ticket.close", false);
    return;
  }
  const finished = runtime.storage.finishTicketClose(ticket.ticketId);
  if (finished.status !== "closed" && finished.status !== "already-closed") {
    await replyPrivate(
      interaction,
      `Ticket #${ticket.ticketNumber} has a saved closure log, but its record could not be finalized. Use \`/ticket recover\` to reconcile it.`,
    );
    runtime.storage.recordCommandMetric("ticket.close", false);
    return;
  }
  const current = runtime.storage.getTicketById(ticket.ticketId);
  if (
    !runtime.isCurrent() ||
    !current ||
    current.state !== "closed" ||
    current.channelId !== finished.ticket.channelId ||
    current.closeLogMessageId !== finished.ticket.closeLogMessageId ||
    current.updatedAt !== finished.ticket.updatedAt
  ) {
    await replyPrivate(
      interaction,
      `Ticket #${ticket.ticketNumber} changed while its closed channel was being inspected. The channel was preserved; review the latest record before recovery.`,
    );
    runtime.storage.recordCommandMetric("ticket.close", false);
    return;
  }
  const deleted =
    channelLookup.status === "present"
      ? await channelLookup.channel
          .delete(
            `Superior ticket #${ticket.ticketNumber} closure resumed by ${actor.id}`,
          )
          .then(() => true)
          .catch(() => false)
      : true;
  await replyPrivate(
    interaction,
    deleted
      ? `Ticket #${ticket.ticketNumber} was already logged and is now closed.`
      : `Ticket #${ticket.ticketNumber} was already logged and is now closed, but Discord did not remove the channel. Use \`/ticket recover\` to reconcile it.`,
  );
  runtime.storage.recordCommandMetric("ticket.close");
}

async function fetchCloseTicketChannel(
  guild: Guild,
  channelId: string,
): Promise<
  | { status: "present"; channel: TextChannel }
  | { status: "missing" | "unavailable"; channel: null }
> {
  try {
    const channel = await guild.channels.fetch(channelId);
    if (!channel) return { status: "missing", channel: null };
    if (
      channel.guild.id !== guild.id ||
      channel.type !== ChannelType.GuildText
    ) {
      return { status: "unavailable", channel: null };
    }
    return { status: "present", channel };
  } catch (error) {
    return isUnknownDiscordResourceError(error, 10_003)
      ? { status: "missing", channel: null }
      : { status: "unavailable", channel: null };
  }
}

async function resolveTicketForButton(
  interaction: ButtonInteraction,
  runtime: GuildRuntime,
  ticketId: string,
): Promise<TicketRecord | null> {
  const ticket = runtime.storage.getTicketById(ticketId);
  if (
    !ticket ||
    !isTicketChannelInteraction(interaction, runtime, ticket) ||
    ticket.controlMessageId !== interaction.message.id ||
    interaction.message.author.id !== interaction.client.user?.id
  ) {
    await replyPrivate(
      interaction,
      "This ticket control is outdated or does not belong to this channel.",
    );
    return null;
  }
  return ticket;
}

function isTicketChannelInteraction(
  interaction: TicketInteraction,
  runtime: GuildRuntime,
  ticket: TicketRecord,
): boolean {
  return Boolean(
    interaction.guild &&
    interaction.guildId === runtime.guildId &&
    interaction.guild.id === runtime.guildId &&
    ticket.guildId === runtime.guildId &&
    ticket.channelId &&
    ticket.channelId === interaction.channelId,
  );
}

function isCurrentTicketControl(
  interaction: ButtonInteraction,
  runtime: GuildRuntime,
  ticket: TicketRecord,
): boolean {
  return (
    isTicketChannelInteraction(interaction, runtime, ticket) &&
    ticket.controlMessageId === interaction.message.id &&
    interaction.message.author.id === interaction.client.user?.id
  );
}

async function requireTicketStaff(
  interaction: TicketInteraction,
  runtime: GuildRuntime,
): Promise<GuildMember | null> {
  const member = await fetchInteractionMember(interaction, runtime.guildId);
  if (!member || !interaction.guild) {
    await replyPrivate(interaction, "Could not verify your server membership.");
    return null;
  }
  if (!(await isTicketStaff(interaction.guild, runtime, member))) {
    await replyPrivate(
      interaction,
      "Only the configured support role, server owner, or an Administrator can manage this ticket.",
    );
    return null;
  }
  return member;
}

async function isTicketStaff(
  guild: Guild,
  runtime: GuildRuntime,
  member: GuildMember,
): Promise<boolean> {
  const configuration = runtime.storage.getTicketConfiguration();
  const supportRole = configuration
    ? await guild.roles.fetch(configuration.supportRoleId).catch(() => null)
    : null;
  return evaluateTicketStaff({
    guildId: runtime.guildId,
    ownerId: guild.ownerId,
    member,
    supportRoleId: configuration?.supportRoleId ?? null,
    supportRole,
  }).allowed;
}

async function fetchInteractionMember(
  interaction: TicketInteraction,
  guildId: string,
): Promise<GuildMember | null> {
  if (!interaction.guild || interaction.guild.id !== guildId) return null;
  const member = await interaction.guild.members
    .fetch(interaction.user.id)
    .catch(() => null);
  return member?.guild.id === guildId ? member : null;
}

async function refreshTicketControls(
  interaction: ButtonInteraction,
  ticket: TicketRecord,
): Promise<void> {
  await interaction.message
    .edit({ components: [buildTicketControlRow(ticket)] })
    .catch(() => undefined);
}

function isSameClosingSnapshot(
  expected: TicketRecord,
  current: TicketRecord,
): boolean {
  return (
    isSameCloseIdentity(expected, current) &&
    current.state === "closing" &&
    current.closeLogMessageId === null &&
    current.closeLoggedAt === null &&
    current.updatedAt === expected.updatedAt
  );
}

function isSameLoggedClosingSnapshot(
  expected: TicketRecord,
  current: TicketRecord,
): boolean {
  return (
    isSameCloseIdentity(expected, current) &&
    current.state === "closing" &&
    current.closeLogMessageId === expected.closeLogMessageId &&
    current.closeLoggedAt === expected.closeLoggedAt &&
    current.updatedAt === expected.updatedAt
  );
}

function isSameCloseIdentity(
  expected: TicketRecord,
  current: TicketRecord,
): boolean {
  return (
    current.guildId === expected.guildId &&
    current.ticketId === expected.ticketId &&
    current.ticketNumber === expected.ticketNumber &&
    current.openerId === expected.openerId &&
    current.channelId === expected.channelId &&
    current.controlMessageId === expected.controlMessageId &&
    current.closedBy === expected.closedBy &&
    current.closeReason === expected.closeReason &&
    current.closingAt === expected.closingAt
  );
}

function existingTicketMessage(ticket: TicketRecord): string {
  if (ticket.channelId) {
    return `You already have active ticket #${ticket.ticketNumber} in <#${ticket.channelId}>.`;
  }
  return `Ticket #${ticket.ticketNumber} is already being created. If it does not appear shortly, ask an administrator to run \`/ticket recover\`.`;
}

async function deferPrivate(interaction: TicketInteraction): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true });
  }
}

async function replyPrivate(
  interaction: TicketInteraction,
  value: string | Pick<InteractionReplyOptions, "content" | "embeds">,
): Promise<void> {
  const payload = typeof value === "string" ? { content: value } : value;
  if (interaction.deferred && !interaction.replied) {
    await interaction.editReply({
      ...payload,
      allowedMentions: { parse: [] },
    });
    return;
  }
  if (interaction.replied) {
    await interaction.followUp({
      ...payload,
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }
  await interaction.reply({
    ...payload,
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Ticket operation failed.";
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
