import {
  ChannelType,
  MessageFlags,
  type ButtonInteraction,
  type Guild,
  type GuildMember,
  type InteractionReplyOptions,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type TextChannel,
} from "discord.js";
import type { GuildRuntime } from "../runtime.js";
import type {
  TicketConfiguration,
  TicketDepartment,
  TicketDepartmentField,
  TicketFormResponseInput,
  TicketRecord,
  PostedPanel,
} from "../types.js";
import {
  SAFE_PANEL_ALLOWED_MENTIONS,
  parseTicketOpenCustomId,
} from "./panel-theme.js";
import { authorizeSupportRoleOrCapability } from "./authorization.js";
import {
  TICKET_CLOSE_REASON_INPUT_ID,
  TICKET_DESCRIPTION_INPUT_ID,
  TICKET_INPUT_LIMITS,
  TICKET_SUBJECT_INPUT_ID,
  buildTicketClosureEmbed,
  buildTicketControlRow,
  buildTicketDepartmentSelect,
  buildTicketInfoPayload,
  buildTicketWelcomePayload,
  createTicketCloseModal,
  createTicketOpenModal,
  normalizeTicketInput,
  parseTicketComponentId,
  parseTicketDepartmentSelectCustomId,
  toTicketFormFieldInput,
  toTicketFormResponse,
} from "./ticket-components.js";
import {
  FORM_LIMITS,
  validateFormResponses,
  type FormResponse,
} from "./forms.js";
import { isConfiguredDepartment } from "./phase2-permissions.js";
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
import { logDomainOutcome } from "./domain-outcomes.js";

const TICKET_COMPONENT_NAMESPACE = "superior:ticket:";
const TICKET_FORM_SUMMARY_INPUT_LIMIT =
  FORM_LIMITS.fields *
    (FORM_LIMITS.label + FORM_LIMITS.response + ": ".length) +
  (FORM_LIMITS.fields - 1) * "\n".length;

type TicketInteraction = ButtonInteraction | ModalSubmitInteraction;
type TicketComponentInteraction =
  TicketInteraction | StringSelectMenuInteraction;

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
  if (!ticketRoutingConfiguration(runtime, ticket)) {
    await replyPrivate(
      interaction,
      "This ticket department is awaiting binding verification. Ask an administrator to verify its routing before using ticket controls.",
    );
    return true;
  }
  if (parsed.kind === "close") {
    const actor = await requireTicketStaff(interaction, runtime, ticket);
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
      const staff = await isTicketStaff(
        interaction.guild!,
        runtime,
        actor.id,
        ticket,
      );
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
    await replyPrivate(
      interaction,
      buildTicketInfoPayload(current, ticketDisplayContext(runtime, current)),
    );
    runtime.storage.recordCommandMetric("ticket.info");
    return true;
  }
  const actor = await requireTicketStaff(interaction, runtime, ticket);
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
    logDomainOutcome(
      "ticket",
      "claim",
      runtime.guildId,
      result.status === "conflict" ? "rejected-conflict" : result.status,
      {
        recordId: currentTicket.ticketId,
        recordNumber: currentTicket.ticketNumber,
      },
    );
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
  logDomainOutcome(
    "ticket",
    "release-claim",
    runtime.guildId,
    result.status === "released" || result.status === "already-released"
      ? result.status
      : "rejected-unavailable",
    {
      recordId: currentTicket.ticketId,
      recordNumber: currentTicket.ticketNumber,
    },
  );
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
    await handleOpenModal(
      interaction,
      runtime,
      parsed.panelId,
      parsed.departmentId,
      parsed.definitionVersion,
    );
  } else {
    await handleCloseModal(interaction, runtime, parsed.ticketId);
  }
  return true;
}

export async function handleTicketSelect(
  interaction: StringSelectMenuInteraction,
  runtime: GuildRuntime,
): Promise<boolean> {
  if (!interaction.customId.startsWith(TICKET_COMPONENT_NAMESPACE)) {
    return false;
  }
  const panelId = parseTicketDepartmentSelectCustomId(interaction.customId);
  if (!panelId) {
    await replyPrivate(
      interaction,
      "This ticket department selection is outdated. Open the launcher again.",
    );
    return true;
  }
  const panel = await verifyTicketPanelSelection(interaction, runtime, panelId);
  if (!panel) {
    await replyPrivate(
      interaction,
      "This ticket launcher is outdated or missing. Ask an administrator to refresh it.",
    );
    return true;
  }
  if (interaction.values.length !== 1) {
    await replyPrivate(
      interaction,
      "Choose exactly one current ticket department.",
    );
    return true;
  }
  const department = runtime.storage.getTicketDepartment(
    interaction.values[0]!,
  );
  if (
    !department?.enabled ||
    department.guildId !== runtime.guildId ||
    !runtime.isCurrent()
  ) {
    await replyPrivate(
      interaction,
      "That ticket department is disabled, deleted, or no longer available. Open the launcher again.",
    );
    return true;
  }
  await showDepartmentModal(interaction, runtime, panel.panelId, department);
  return true;
}

async function handleOpenButton(
  interaction: ButtonInteraction,
  runtime: GuildRuntime,
  panelId: string,
): Promise<void> {
  const panel = verifyTicketPanelInteraction(interaction, runtime, panelId);
  if (!panel) {
    await replyPrivate(
      interaction,
      "This ticket panel is outdated or tickets are unavailable. Ask an administrator to refresh it.",
    );
    return;
  }
  const departments = enabledTicketDepartments(runtime);
  if (departments.length === 0) {
    await replyPrivate(
      interaction,
      "Tickets are currently unavailable. Ask an administrator to review the enabled departments.",
    );
    return;
  }
  if (departments.length === 1) {
    await showDepartmentModal(
      interaction,
      runtime,
      panel.panelId,
      departments[0]!,
    );
    return;
  }
  await interaction.reply({
    content: "Choose the support department that best matches your request:",
    components: [buildTicketDepartmentSelect(panel.panelId, departments)],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
  runtime.storage.recordCommandMetric("panel.tickets.use");
}

function verifyTicketPanelInteraction(
  interaction: ButtonInteraction,
  runtime: GuildRuntime,
  panelId: string,
): PostedPanel | null {
  const panel = runtime.storage.findPostedPanelByToken(panelId);
  return panel &&
    panel.guildId === runtime.guildId &&
    panel.preset === "tickets" &&
    panel.channelId === interaction.channelId &&
    panel.messageId === interaction.message.id &&
    interaction.message.author.id === interaction.client.user?.id &&
    interaction.guild?.id === runtime.guildId &&
    runtime.isCurrent()
    ? panel
    : null;
}

async function verifyTicketPanelSelection(
  interaction: StringSelectMenuInteraction,
  runtime: GuildRuntime,
  panelId: string,
): Promise<PostedPanel | null> {
  const panel = runtime.storage.findPostedPanelByToken(panelId);
  const guild = interaction.guild;
  if (
    !panel ||
    panel.guildId !== runtime.guildId ||
    panel.preset !== "tickets" ||
    panel.channelId !== interaction.channelId ||
    !guild ||
    guild.id !== runtime.guildId ||
    !runtime.isCurrent()
  ) {
    return null;
  }
  const channel = await guild.channels.fetch(panel.channelId).catch(() => null);
  if (
    !channel ||
    (channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement)
  ) {
    return null;
  }
  const launcher = await channel.messages
    .fetch(panel.messageId)
    .catch(() => null);
  return launcher?.author.id === interaction.client.user?.id &&
    runtime.isCurrent()
    ? panel
    : null;
}

function enabledTicketDepartments(runtime: GuildRuntime): TicketDepartment[] {
  return runtime.storage
    .listTicketDepartments({ enabled: true, limit: 10 })
    .filter(
      (department) =>
        department.guildId === runtime.guildId && department.enabled,
    )
    .slice(0, 10);
}

async function showDepartmentModal(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  runtime: GuildRuntime,
  panelId: string,
  department: TicketDepartment,
): Promise<void> {
  if (
    department.guildId !== runtime.guildId ||
    !department.enabled ||
    !runtime.isCurrent()
  ) {
    await replyPrivate(
      interaction,
      "That ticket department is no longer available. Open the current launcher again.",
    );
    return;
  }
  try {
    const fields = ticketDepartmentFields(runtime, department);
    await interaction.showModal(
      createTicketOpenModal(panelId, {
        departmentId: department.departmentId,
        definitionVersion: department.definitionVersion,
        departmentName: department.displayName,
        fields: fields.map(toTicketFormFieldInput),
      }),
    );
    runtime.storage.recordCommandMetric("panel.tickets.use");
  } catch (error) {
    await replyPrivate(
      interaction,
      `That ticket form is invalid: ${errorMessage(error)}`,
    );
  }
}

async function handleOpenModal(
  interaction: ModalSubmitInteraction,
  runtime: GuildRuntime,
  panelId: string,
  departmentId: string | null = null,
  definitionVersion: number | null = null,
): Promise<void> {
  const panel = runtime.storage.findPostedPanelByToken(panelId);
  if (
    !panel ||
    panel.preset !== "tickets" ||
    panel.channelId !== interaction.channelId ||
    interaction.guild?.id !== runtime.guildId
  ) {
    await replyPrivate(
      interaction,
      "This ticket form is outdated or tickets are currently disabled.",
    );
    return;
  }
  const opening = resolveOpeningDepartment(runtime, departmentId);
  if (!opening) {
    await replyPrivate(
      interaction,
      "This ticket form points to a disabled, deleted, or incomplete department. Open the current launcher again.",
    );
    return;
  }
  if (
    departmentId !== null &&
    (definitionVersion === null ||
      definitionVersion !== opening.department?.definitionVersion)
  ) {
    await replyPrivate(
      interaction,
      "That ticket form changed after it was opened. Open a fresh form and submit again.",
    );
    return;
  }
  let submission: TicketSubmission;
  try {
    submission = readTicketSubmission(
      interaction,
      departmentId === null ? [] : opening.fields,
      opening.department?.displayName ?? "Support",
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
    opening.configuration,
    runtime.storage,
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
  if (
    opening.department &&
    !sameDepartmentSnapshot(
      opening.department,
      runtime.storage.getTicketDepartment(opening.department.departmentId),
    )
  ) {
    await replyPrivate(
      interaction,
      "That ticket department changed while the form was being verified. Open a fresh form and submit again.",
    );
    return;
  }
  let reservation;
  try {
    reservation = runtime.storage.reserveTicketCreation({
      openerId: opener.id,
      subject: submission.subject,
      description: submission.description,
      ...(departmentId && opening.department
        ? { departmentId: opening.department.departmentId }
        : {}),
      ...(submission.responses ? { responses: submission.responses } : {}),
    });
  } catch {
    await replyPrivate(
      interaction,
      "That ticket department or form changed before the request could be reserved. Open a fresh form and try again.",
    );
    return;
  }
  if (reservation.status === "existing") {
    logDomainOutcome(
      "ticket",
      "create",
      runtime.guildId,
      "rejected-existing-active-ticket",
      {
        recordId: reservation.ticket.ticketId,
        recordNumber: reservation.ticket.ticketNumber,
      },
    );
    await replyPrivate(interaction, existingTicketMessage(reservation.ticket));
    return;
  }
  if (reservation.status === "limit") {
    logDomainOutcome(
      "ticket",
      "create",
      runtime.guildId,
      "rejected-active-ticket-limit",
      { totalCount: reservation.activeCount },
    );
    await replyPrivate(
      interaction,
      `You already have ${reservation.activeCount} active tickets in this server. Close one before opening another.`,
    );
    return;
  }
  logDomainOutcome("ticket", "create", runtime.guildId, "reserved", {
    recordId: reservation.ticket.ticketId,
    recordNumber: reservation.ticket.ticketNumber,
  });
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
      buildTicketWelcomePayload(
        activated.ticket,
        ticketDisplayContext(runtime, activated.ticket),
      ),
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
    logDomainOutcome(
      "ticket",
      "create",
      runtime.guildId,
      durableChannel ? "completed-concurrently" : "failed-delivery",
      {
        recordId: reservation.ticket.ticketId,
        recordNumber: latest?.ticketNumber ?? reservation.ticket.ticketNumber,
        ...(channel ? { channelId: channel.id } : {}),
        state: latest?.state ?? "untracked",
      },
    );
    return;
  }
  await replyPrivate(
    interaction,
    `Ticket #${createdTicket.ticketNumber} is ready in <#${channel.id}>.`,
  );
  runtime.storage.recordCommandMetric("ticket.create");
  logDomainOutcome("ticket", "create", runtime.guildId, "completed", {
    recordId: createdTicket.ticketId,
    recordNumber: createdTicket.ticketNumber,
    channelId: channel.id,
    state: createdTicket.state,
  });
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
  if (!ticketRoutingConfiguration(runtime, ticket)) {
    await replyPrivate(
      interaction,
      "This ticket department is awaiting binding verification. Verify its routing before closing or finalizing this ticket.",
    );
    return;
  }
  const actor = await requireTicketStaff(interaction, runtime, ticket);
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
  const configuration = ticketRoutingConfiguration(runtime, ticket);
  if (!configuration) {
    await replyPrivate(
      interaction,
      "This ticket department no longer has complete routing. Restore its log channel and support role before closing this ticket.",
    );
    return;
  }
  const resources = await inspectTicketConfigurationResources(
    guild,
    configuration,
    runtime.storage,
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
  logDomainOutcome("ticket", "close", runtime.guildId, "started", {
    recordId: closingTicket.ticketId,
    recordNumber: closingTicket.ticketNumber,
    state: closingTicket.state,
  });
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
      {
        expectedGuildId: runtime.guildId,
        headerFields: ticketTranscriptHeaderFields(
          ticketDisplayContext(runtime, closingTicket),
        ),
      },
    );
    if (!runtime.isCurrent()) {
      throw new Error("Server configuration changed during ticket closure.");
    }
    const transcriptFile = {
      attachment: transcript.buffer,
      name: `superior-ticket-${closingTicket.ticketNumber}.txt`,
      description: `Plain-text transcript for ticket #${closingTicket.ticketNumber}`,
    };
    const displayContext = ticketDisplayContext(runtime, closingTicket);
    const closureEmbed = buildTicketClosureEmbed(closingTicket, displayContext);
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
    logDomainOutcome(
      "ticket",
      "closure-log-delivery",
      runtime.guildId,
      "checkpointed",
      {
        recordId: checkpoint.ticket.ticketId,
        recordNumber: checkpoint.ticket.ticketNumber,
        channelId: resources.logChannel.id,
      },
    );
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
    logDomainOutcome("ticket", "close", runtime.guildId, "completed", {
      recordId: finished.ticket.ticketId,
      recordNumber: finished.ticket.ticketNumber,
      channelId: channel.id,
      state: deleted ? "channel-removed" : "channel-recovery-required",
    });
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
    logDomainOutcome(
      "ticket",
      "close",
      runtime.guildId,
      logCheckpointed
        ? "failed-after-checkpoint"
        : logDelivered
          ? "failed-checkpoint"
          : "failed-log-delivery",
      {
        recordId: closingTicket.ticketId,
        recordNumber: closingTicket.ticketNumber,
        state: logCheckpointed
          ? "logged"
          : logDelivered
            ? "delivered-uncheckpointed"
            : "reopened",
      },
    );
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
  logDomainOutcome("ticket", "close-recovery", runtime.guildId, "completed", {
    recordId: finished.ticket.ticketId,
    recordNumber: finished.ticket.ticketNumber,
    ...(finished.ticket.channelId
      ? { channelId: finished.ticket.channelId }
      : {}),
    state: deleted ? "channel-removed" : "channel-recovery-required",
  });
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

interface OpeningDepartment {
  department: TicketDepartment | null;
  configuration: TicketConfiguration;
  fields: TicketDepartmentField[];
}

interface TicketSubmission {
  subject: string;
  description: string;
  responses?: TicketFormResponseInput[];
}

function resolveOpeningDepartment(
  runtime: GuildRuntime,
  departmentId: string | null,
): OpeningDepartment | null {
  if (departmentId) {
    const department = runtime.storage.getTicketDepartment(departmentId);
    if (
      !department ||
      department.guildId !== runtime.guildId ||
      !department.enabled ||
      department.bindingsVerifiedAt === null ||
      !isConfiguredDepartment(department)
    ) {
      return null;
    }
    try {
      return {
        department,
        configuration: departmentConfiguration(department),
        fields: ticketDepartmentFields(runtime, department),
      };
    } catch {
      return null;
    }
  }

  const compatibility = runtime.storage.getTicketConfiguration();
  if (!compatibility?.enabled || compatibility.guildId !== runtime.guildId) {
    return null;
  }
  const department = compatibility.departmentId
    ? runtime.storage.getTicketDepartment(compatibility.departmentId)
    : runtime.storage.getTicketDepartmentBySlug("general-support");
  if (
    department &&
    (department.guildId !== runtime.guildId ||
      department.bindingsVerifiedAt === null)
  ) {
    return null;
  }
  if (!department && compatibility.departmentId) return null;
  try {
    return {
      department,
      configuration:
        department && isConfiguredDepartment(department)
          ? departmentConfiguration(department)
          : compatibility,
      fields: department ? ticketDepartmentFields(runtime, department) : [],
    };
  } catch {
    return null;
  }
}

function ticketDepartmentFields(
  runtime: GuildRuntime,
  department: TicketDepartment,
): TicketDepartmentField[] {
  const fields = runtime.storage
    .listTicketDepartmentFields(department.departmentId)
    .filter(
      (field) =>
        field.guildId === runtime.guildId &&
        field.departmentId === department.departmentId,
    )
    .sort(
      (left, right) =>
        left.sortOrder - right.sortOrder ||
        left.fieldId.localeCompare(right.fieldId),
    );
  if (fields.length > 5) {
    throw new RangeError("Ticket forms support at most five fields.");
  }
  return fields;
}

function readTicketSubmission(
  interaction: ModalSubmitInteraction,
  fields: readonly TicketDepartmentField[],
  departmentName: string,
): TicketSubmission {
  if (fields.length === 0) {
    return {
      subject: normalizeTicketInput(
        interaction.fields.getTextInputValue(TICKET_SUBJECT_INPUT_ID),
        "Subject",
        TICKET_INPUT_LIMITS.subject,
      ),
      description: normalizeTicketInput(
        interaction.fields.getTextInputValue(TICKET_DESCRIPTION_INPUT_ID),
        "Description",
        TICKET_INPUT_LIMITS.description,
      ),
    };
  }
  const responses = validateFormResponses(
    fields.map(toTicketFormFieldInput),
    (fieldId) => interaction.fields.getTextInputValue(fieldId),
  );
  const responseById = new Map(
    responses.map((response) => [response.fieldId, response]),
  );
  const storedResponses = fields.map((field) => {
    const response = responseById.get(field.fieldId)!;
    return {
      fieldId: field.fieldId,
      fieldLabel: field.label,
      fieldType: field.fieldType,
      responseText: response.value,
      sortOrder: field.sortOrder,
    };
  });
  const firstAnswer = responses.find((response) => response.value)?.value;
  const rawSubject = (firstAnswer ?? `${departmentName} request`)
    .replace(/\s+/gu, " ")
    .trim();
  const rawDescription = responses
    .map((response) => `${response.label}: ${response.value || "No response"}`)
    .join("\n");
  return {
    subject: truncateNormalizedTicketText(
      rawSubject,
      "Subject",
      TICKET_INPUT_LIMITS.subject,
    ),
    description: truncateNormalizedTicketText(
      rawDescription || `Submitted the ${departmentName} ticket form.`,
      "Description",
      TICKET_INPUT_LIMITS.description,
    ),
    responses: storedResponses,
  };
}

function truncateNormalizedTicketText(
  value: string,
  label: string,
  maximum: number,
): string {
  const normalized = normalizeTicketInput(
    value,
    label,
    TICKET_FORM_SUMMARY_INPUT_LIMIT,
  );
  return normalized.length <= maximum
    ? normalized
    : normalized.slice(0, maximum).trimEnd();
}

function departmentConfiguration(
  department: TicketDepartment & {
    categoryId: string;
    logChannelId: string;
    supportRoleId: string;
  },
): TicketConfiguration {
  return {
    guildId: department.guildId,
    departmentId: department.departmentId,
    enabled: department.enabled,
    categoryId: department.categoryId,
    logChannelId: department.logChannelId,
    supportRoleId: department.supportRoleId,
    createdAt: department.createdAt,
    updatedAt: department.updatedAt,
  };
}

function ticketRoutingConfiguration(
  runtime: GuildRuntime,
  ticket: TicketRecord,
): TicketConfiguration | null {
  const department = runtime.storage.getTicketDepartment(ticket.departmentId);
  if (
    department?.guildId === runtime.guildId &&
    department.bindingsVerifiedAt !== null &&
    isConfiguredDepartment(department)
  ) {
    return departmentConfiguration(department);
  }
  if (department) return null;
  const compatibility = runtime.storage.getTicketConfiguration();
  return compatibility?.guildId === runtime.guildId &&
    !compatibility.departmentId
    ? compatibility
    : null;
}

function ticketSupportRoleId(
  runtime: GuildRuntime,
  ticket: TicketRecord,
): string | null {
  return ticketRoutingConfiguration(runtime, ticket)?.supportRoleId ?? null;
}

function sameDepartmentSnapshot(
  expected: TicketDepartment,
  current: TicketDepartment | null,
): boolean {
  return Boolean(
    current &&
    current.guildId === expected.guildId &&
    current.departmentId === expected.departmentId &&
    current.enabled === expected.enabled &&
    current.definitionVersion === expected.definitionVersion &&
    current.categoryId === expected.categoryId &&
    current.logChannelId === expected.logChannelId &&
    current.supportRoleId === expected.supportRoleId &&
    current.updatedAt === expected.updatedAt,
  );
}

function ticketDisplayContext(
  runtime: GuildRuntime,
  ticket: TicketRecord,
): {
  department: { displayName: string } | null;
  responses: FormResponse[];
} {
  const department = runtime.storage.getTicketDepartment(ticket.departmentId);
  const responses = runtime.storage
    .listTicketResponses(ticket.ticketId)
    .filter(
      (response) =>
        response.guildId === runtime.guildId &&
        response.ticketId === ticket.ticketId,
    )
    .map(toTicketFormResponse);
  return {
    department:
      department?.guildId === runtime.guildId
        ? { displayName: department.displayName }
        : null,
    responses,
  };
}

function ticketTranscriptHeaderFields(
  context: ReturnType<typeof ticketDisplayContext>,
): Array<{ label: string; value: string }> {
  return [
    ...(context.department
      ? [{ label: "Department", value: context.department.displayName }]
      : []),
    ...context.responses.map((response) => ({
      label: `Form - ${response.label}`,
      value: response.value || "No response",
    })),
  ];
}

async function requireTicketStaff(
  interaction: TicketInteraction,
  runtime: GuildRuntime,
  ticket: TicketRecord,
): Promise<GuildMember | null> {
  if (!interaction.guild || ticket.guildId !== runtime.guildId) {
    await replyPrivate(interaction, "Could not verify your server membership.");
    return null;
  }
  const decision = await authorizeSupportRoleOrCapability({
    guild: interaction.guild,
    userId: interaction.user.id,
    capability: "tickets.manage",
    grants: runtime.storage,
    configuredRoleId: ticketSupportRoleId(runtime, ticket),
  });
  if (!decision.allowed) {
    await replyPrivate(
      interaction,
      "Only this department's support role, the server owner, an Administrator, or a tickets.manage delegate can manage this ticket.",
    );
    return null;
  }
  return decision.member;
}

async function isTicketStaff(
  guild: Guild,
  runtime: GuildRuntime,
  userId: string,
  ticket: TicketRecord,
): Promise<boolean> {
  const decision = await authorizeSupportRoleOrCapability({
    guild,
    userId,
    capability: "tickets.manage",
    grants: runtime.storage,
    configuredRoleId: ticketSupportRoleId(runtime, ticket),
  });
  return decision.allowed;
}

async function fetchInteractionMember(
  interaction: TicketInteraction,
  guildId: string,
): Promise<GuildMember | null> {
  if (!interaction.guild || interaction.guild.id !== guildId) return null;
  const member = await interaction.guild.members
    .fetch({ user: interaction.user.id, cache: true, force: true })
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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
}

async function replyPrivate(
  interaction: TicketComponentInteraction,
  value: string | Pick<InteractionReplyOptions, "content" | "embeds" | "files">,
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
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }
  await interaction.reply({
    ...payload,
    flags: MessageFlags.Ephemeral,
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
