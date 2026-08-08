import {
  ChannelType,
  PermissionFlagsBits,
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
import type {
  TicketConfiguration,
  TicketDepartment,
  TicketRecord,
} from "../types.js";
import {
  authorizeSupportRoleOrCapability,
  fetchAndValidateRole,
} from "./authorization.js";
import { inspectContentDestinationBoundary } from "./content-destination-boundary.js";
import { postTicketLauncher } from "./preset-panels.js";
import {
  buildTicketWelcomePayload,
  toTicketFormResponse,
} from "./ticket-components.js";
import { handleTicketDepartmentCommand } from "./ticket-department-commands-handler.js";
import { isConfiguredDepartment } from "./phase2-permissions.js";
import {
  createPrivateTicketChannel,
  inspectTicketConfigurationResources,
  inspectTicketManagerRoles,
  quarantinePrivateTicketChannel,
  reconcilePrivateTicketChannel,
  ticketChannelRecoveryMarker,
  validateTicketSetupResources,
} from "./ticket-permissions.js";

const TICKET_RECOVERY_LEASE_MS = 5 * 60 * 1_000;
const TICKET_RECOVERY_CHANNEL_SCAN_LIMIT = 500;
const TICKET_RECOVERY_UNAVAILABLE_MESSAGE =
  "That ticket was not found or you are not authorized to recover it.";

type TicketRecoveryAuthorizationFailure = "changed" | "unauthorized";

class TicketRecoveryAuthorizationError extends Error {
  public constructor(
    public readonly failure: TicketRecoveryAuthorizationFailure,
  ) {
    super("Ticket recovery authorization is no longer current.");
  }
}

export async function handleTicketCommand(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
): Promise<void> {
  const group = (
    interaction.options as typeof interaction.options & {
      getSubcommandGroup?: (required?: boolean) => string | null;
    }
  ).getSubcommandGroup?.(false);
  if (group === "department" || group === "field") {
    await handleTicketDepartmentCommand(interaction, runtime, actor);
    return;
  }
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
      await recoverTicketByNumber(interaction, runtime, actor);
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
  const [categoryValue, logChannelValue, supportRoleValue, botMember] =
    await Promise.all([
      guild.channels
        .fetch(rawCategory.id, { cache: true, force: true })
        .catch(() => null),
      guild.channels
        .fetch(rawLogChannel.id, { cache: true, force: true })
        .catch(() => null),
      fetchAndValidateRole(guild, rawSupportRole.id),
      guild.members.fetchMe({ cache: true, force: true }).catch(() => null),
    ]);
  if (
    !categoryValue ||
    categoryValue.guild.id !== guild.id ||
    categoryValue.type !== ChannelType.GuildCategory
  ) {
    await replyPrivate(
      interaction,
      "That ticket category was deleted, changed type, or could not be freshly verified.",
    );
    return;
  }
  if (
    !logChannelValue ||
    logChannelValue.guild.id !== guild.id ||
    (logChannelValue.type !== ChannelType.GuildText &&
      logChannelValue.type !== ChannelType.GuildAnnouncement) ||
    logChannelValue.isDMBased()
  ) {
    await replyPrivate(
      interaction,
      "That ticket log channel was deleted, changed type, or could not be freshly verified.",
    );
    return;
  }
  if (!supportRoleValue.valid) {
    await replyPrivate(
      interaction,
      "That ticket support role was deleted or could not be freshly verified.",
    );
    return;
  }
  if (!botMember || botMember.guild.id !== guild.id) {
    await replyPrivate(
      interaction,
      "Could not verify Superior's current server permissions.",
    );
    return;
  }
  const category = categoryValue;
  const logChannel = logChannelValue;
  const supportRole = supportRoleValue.role;
  const managers = await inspectTicketManagerRoles(guild, runtime.storage);
  const issues = validateTicketSetupResources(
    guild,
    category,
    logChannel,
    supportRole,
    actor,
    botMember,
    managers.roles,
  );
  issues.push(...managers.issues);
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
  const previousDepartment = previous?.departmentId
    ? runtime.storage.getTicketDepartment(previous.departmentId)
    : null;
  const previousBindingsVerified = previous
    ? previousDepartment
      ? previousDepartment.bindingsVerifiedAt !== null
      : true
    : false;
  if (
    cannotAssignSupportRole(
      actor,
      guild,
      supportRole.id,
      previousBindingsVerified ? previous?.supportRoleId : null,
    )
  ) {
    await replyPrivate(
      interaction,
      "A `tickets.configure` delegate cannot select a support role they currently hold because that would also grant ticket-content access. Ask the server owner or an Administrator to make this access change.",
    );
    return;
  }
  if (
    (!previousBindingsVerified || previous?.logChannelId !== logChannel.id) &&
    !(await allowCompatibilityLogDestination(
      interaction,
      runtime,
      logChannel,
      supportRole.id,
      actor.id,
    ))
  ) {
    return;
  }
  const changesAccessRouting =
    previous &&
    (previous.categoryId !== category.id ||
      previous.supportRoleId !== supportRole.id);
  const changesLogRouting =
    previous !== null && previous.logChannelId !== logChannel.id;
  const changesActiveRouting = Boolean(
    changesAccessRouting || changesLogRouting,
  );
  let replacementSafety: "present" | "missing" | "unavailable" | null = null;
  let replacingMissingAccessResource = false;
  if (changesAccessRouting && previous) {
    replacementSafety = await inspectPreviousAccessResources(
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
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server changed while the previous ticket resources were being checked. No configuration was changed.",
    );
    return;
  }
  const activeTicketCount = runtime.storage.countTickets([
    "creating",
    "open",
    "closing",
  ]);
  if (changesActiveRouting && activeTicketCount > 0) {
    if (changesLogRouting || replacementSafety === "present") {
      await replyPrivate(
        interaction,
        `Superior did not change the ticket category, log channel, or support role because ${activeTicketCount} active ticket record${activeTicketCount === 1 ? " exists" : "s exist"}. Close those tickets before changing department routing.`,
      );
      return;
    }
    replacingMissingAccessResource = replacementSafety === "missing";
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

function cannotAssignSupportRole(
  actor: GuildMember,
  guild: Guild,
  selectedRoleId: string,
  currentRoleId: string | null | undefined,
): boolean {
  if (selectedRoleId === currentRoleId) return false;
  if (actor.guild.id !== guild.id) return true;
  if (actor.id === guild.ownerId) return false;
  if (actor.permissions.has(PermissionFlagsBits.Administrator)) return false;
  return actor.roles.cache.has(selectedRoleId);
}

async function allowCompatibilityLogDestination(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  logChannel: GuildTextBasedChannel,
  supportRoleId: string,
  actorId: string,
): Promise<boolean> {
  const guild = interaction.guild;
  if (!guild || guild.id !== runtime.guildId) return false;
  const boundary = await inspectContentDestinationBoundary({
    guild,
    userId: actorId,
    capability: "tickets.manage",
    configuredRoleId: supportRoleId,
    grants: runtime.storage,
    channel: logChannel,
  });
  if (!runtime.isCurrent() || boundary === "unverifiable") {
    await replyPrivate(
      interaction,
      "Superior could not verify the current ticket-content boundary. No routing was changed; try again.",
    );
    return false;
  }
  if (boundary === "visible-without-authority") {
    await replyPrivate(
      interaction,
      "A configuration-only delegate cannot route ticket transcripts to a log channel they can read without ticket-management or support-role authority. Ask the server owner or an Administrator to choose that destination.",
    );
    return false;
  }
  return true;
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
    runtime.storage,
  );
  const activeCount = runtime.storage.countTickets([
    "creating",
    "open",
    "closing",
  ]);
  const lines = [
    "**Superior ticket status**",
    `New tickets: **${configuration.enabled ? "enabled" : "disabled"}**`,
    `Category: <#${configuration.categoryId}>`,
    `Log channel: <#${configuration.logChannelId}>`,
    `Support role: <@&${configuration.supportRoleId}>`,
    `Active records: **${activeCount}**`,
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
  const departments = runtime.storage.listTicketDepartments({
    limit: 10,
    offset: 0,
  });
  if (departments.length === 0) {
    await replyPrivate(
      interaction,
      "Tickets are not configured in this server.",
    );
    return;
  }
  const disabledCount = runtime.storage.disableAllTicketDepartments();
  if (disabledCount > 0) runtime.invalidate();
  await replyPrivate(
    interaction,
    disabledCount > 0
      ? `New tickets are disabled across ${disabledCount} department${disabledCount === 1 ? "" : "s"}. Existing ticket records and channels were preserved.`
      : "New tickets are already disabled in every department. Existing ticket records and channels were preserved.",
  );
  runtime.storage.recordCommandMetric("ticket.disable");
}

export async function handleTicketRecoveryCommand(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const ticketNumber = interaction.options.getInteger("ticket_number", true);
  const ticket = runtime.storage.getTicketByNumber(ticketNumber);
  if (!ticket) {
    await replyPrivate(interaction, TICKET_RECOVERY_UNAVAILABLE_MESSAGE);
    return;
  }
  const guild = interaction.guild;
  if (!guild || guild.id !== runtime.guildId) {
    await replyPrivate(
      interaction,
      "That ticket does not belong to this server.",
    );
    return;
  }
  const routing = ticketRoutingConfiguration(runtime, ticket);
  if (!routing) {
    await replyPrivate(interaction, TICKET_RECOVERY_UNAVAILABLE_MESSAGE);
    return;
  }
  const authorization = await authorizeSupportRoleOrCapability({
    guild,
    userId: interaction.user.id,
    capability: "tickets.manage",
    configuredRoleId: routing.supportRoleId,
    grants: runtime.storage,
  });
  if (!authorization.allowed) {
    await replyPrivate(interaction, TICKET_RECOVERY_UNAVAILABLE_MESSAGE);
    return;
  }
  const currentTicket = runtime.storage.getTicketById(ticket.ticketId);
  const currentRouting = currentTicket
    ? ticketRoutingConfiguration(runtime, currentTicket)
    : null;
  if (
    !runtime.isCurrent() ||
    !currentTicket ||
    !currentRouting ||
    !isSameRecoverySnapshot(ticket, currentTicket) ||
    !isSameRoutingSnapshot(routing, currentRouting)
  ) {
    await replyPrivate(
      interaction,
      "This ticket or its department changed while recovery access was being verified. Review its current configuration and try again.",
    );
    return;
  }
  await recoverTicket(
    interaction,
    runtime,
    authorization.member,
    currentTicket,
  );
}

async function recoverTicketByNumber(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
): Promise<void> {
  const ticketNumber = interaction.options.getInteger("ticket_number", true);
  const ticket = runtime.storage.getTicketByNumber(ticketNumber);
  if (!ticket) {
    await replyPrivate(interaction, `Ticket #${ticketNumber} was not found.`);
    return;
  }
  await recoverTicket(interaction, runtime, actor, ticket);
}

async function recoverTicket(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  initialActor: GuildMember,
  initialTicket: TicketRecord,
): Promise<void> {
  let actor = initialActor;
  let ticket = initialTicket;
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
  let configuration = ticketRoutingConfiguration(runtime, ticket);
  if (!configuration) {
    await replyPrivate(
      interaction,
      "This ticket department is awaiting binding verification. Verify its category, log channel, and support role before recovery.",
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
  const initialMutationAuthorization = await verifyTicketRecoveryAuthorization(
    guild,
    interaction.user.id,
    runtime,
    ticket,
    configuration,
  );
  if (initialMutationAuthorization.status !== "authorized") {
    await replyPrivate(
      interaction,
      ticketRecoveryAuthorizationFailureMessage(
        initialMutationAuthorization.status,
      ),
    );
    return;
  }
  actor = initialMutationAuthorization.member;
  ticket = initialMutationAuthorization.ticket;
  configuration = initialMutationAuthorization.routing;
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
  configuration = ticketRoutingConfiguration(runtime, ticket);
  if (!configuration) {
    await replyPrivate(
      interaction,
      "This ticket department is missing complete routing. Restore its category, log channel, and support role before recovery.",
    );
    return;
  }
  const resources = await inspectTicketConfigurationResources(
    guild,
    configuration,
    runtime.storage,
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
  const channelMutationAuthorization = await verifyTicketRecoveryAuthorization(
    guild,
    interaction.user.id,
    runtime,
    ticket,
    configuration,
  );
  if (channelMutationAuthorization.status !== "authorized") {
    await replyPrivate(
      interaction,
      ticketRecoveryAuthorizationFailureMessage(
        channelMutationAuthorization.status,
      ),
    );
    return;
  }
  actor = channelMutationAuthorization.member;
  ticket = channelMutationAuthorization.ticket;
  configuration = channelMutationAuthorization.routing;
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
    const controlMutationAuthorization =
      await verifyTicketRecoveryAuthorization(
        guild,
        interaction.user.id,
        runtime,
        ticket,
        configuration,
      );
    if (controlMutationAuthorization.status !== "authorized") {
      throw new TicketRecoveryAuthorizationError(
        controlMutationAuthorization.status,
      );
    }
    actor = controlMutationAuthorization.member;
    ticket = controlMutationAuthorization.ticket;
    configuration = controlMutationAuthorization.routing;
    if (controlMessage) {
      controlMessage = await controlMessage.edit(
        buildTicketWelcomePayload(
          ticket,
          ticketDisplayContext(runtime, ticket),
        ),
      );
    } else {
      controlMessage = await channel.send(
        buildTicketWelcomePayload(
          ticket,
          ticketDisplayContext(runtime, ticket),
        ),
      );
      controlMessageCreated = true;
    }
    if (!runtime.isCurrent()) {
      throw new Error("Server configuration changed while controls were sent.");
    }
    const storageMutationAuthorization =
      await verifyTicketRecoveryAuthorization(
        guild,
        interaction.user.id,
        runtime,
        ticket,
        configuration,
      );
    if (storageMutationAuthorization.status !== "authorized") {
      throw new TicketRecoveryAuthorizationError(
        storageMutationAuthorization.status,
      );
    }
    actor = storageMutationAuthorization.member;
    ticket = storageMutationAuthorization.ticket;
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
    let createdChannelAdopted = false;
    if (created && channel) {
      const currentTicket = runtime.storage.getTicketById(ticket.ticketId);
      createdChannelAdopted = currentTicket?.channelId === channel.id;
      if (!createdChannelAdopted) {
        createdChannelRemoved = await channel
          .delete(`Rolling back failed Superior recovery by ${actor.id}`)
          .then(() => true)
          .catch(() => false);
        if (createdChannelRemoved) {
          // Deletion is awaited, so another recovery can bind this channel
          // while Discord is processing the request. Repair only that exact
          // adoption through a current-record compare-and-swap.
          repairDeletedAdoptedRecoveryChannel(
            runtime,
            ticket,
            channel.id,
            expectedChannelId,
            actor.id,
          );
        }
      }
    }
    if (!runtime.isCurrent()) {
      let quarantined = false;
      if (
        channel &&
        (!created || !createdChannelRemoved) &&
        !createdChannelAdopted &&
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
        (!created || !createdChannelRemoved) &&
        !createdChannelAdopted
      ) {
        controlRemoved = await controlMessage
          .delete()
          .then(() => true)
          .catch(() => false);
      }
      await replyPrivate(
        interaction,
        `This server changed during ticket recovery. No newer stored data was changed.${createdChannelAdopted ? " The newly created channel is already bound to the current ticket record and was preserved." : createdChannelRemoved ? " The newly created channel was removed." : quarantined ? " The affected channel was restricted to the bot." : channel ? " Superior could not remove or restrict the affected channel; inspect it manually." : ""}${controlRemoved ? "" : " A newly posted control message could not be removed, but it will fail closed."}`,
      );
      return;
    }
    if (error instanceof TicketRecoveryAuthorizationError) {
      let quarantined = false;
      if (
        created &&
        channel &&
        !createdChannelRemoved &&
        !createdChannelAdopted &&
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
      if (
        controlMessageCreated &&
        controlMessage &&
        !createdChannelRemoved &&
        !createdChannelAdopted
      ) {
        await controlMessage.delete().catch(() => undefined);
      }
      await replyPrivate(
        interaction,
        `${ticketRecoveryAuthorizationFailureMessage(error.failure)}${createdChannelAdopted ? " The newly created channel is already bound to the current ticket record and was preserved." : quarantined ? " Superior restricted the newly created channel to the bot because Discord did not remove it." : created && channel && !createdChannelRemoved ? " Superior could not remove or restrict the newly created channel; inspect it manually." : ""}`,
      );
      runtime.storage.recordCommandMetric("ticket.recover", false);
      return;
    }
    if (created && channel) {
      if (createdChannelAdopted) {
        cleanupNote = ` The newly created channel <#${channel.id}> was adopted by the current ticket record and was preserved.`;
      } else if (!createdChannelRemoved) {
        const preservationAuthorization =
          await verifyTicketRecoveryAuthorization(
            guild,
            interaction.user.id,
            runtime,
            ticket,
            configuration,
          );
        const preserved =
          preservationAuthorization.status === "authorized"
            ? runtime.storage.rebindTicket(
                ticket.ticketId,
                {
                  channelId: channel.id,
                  controlMessageId: controlMessage?.id ?? null,
                  expectedChannelId,
                  expectedControlMessageId,
                  expectedState,
                  expectedUpdatedAt,
                },
                preservationAuthorization.member.id,
              )
            : null;
        if (preserved?.status === "rebound") {
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

type TicketRecoveryAuthorizationCheck =
  | {
      status: "authorized";
      member: GuildMember;
      ticket: TicketRecord;
      routing: TicketConfiguration;
    }
  | { status: TicketRecoveryAuthorizationFailure };

async function verifyTicketRecoveryAuthorization(
  guild: Guild,
  userId: string,
  runtime: GuildRuntime,
  expectedTicket: TicketRecord,
  expectedRouting: TicketConfiguration,
): Promise<TicketRecoveryAuthorizationCheck> {
  const currentTicket = runtime.storage.getTicketById(expectedTicket.ticketId);
  const currentRouting = currentTicket
    ? ticketRoutingConfiguration(runtime, currentTicket)
    : null;
  if (
    !runtime.isCurrent() ||
    guild.id !== runtime.guildId ||
    !currentTicket ||
    !currentRouting ||
    !isSameRecoverySnapshot(expectedTicket, currentTicket) ||
    !isSameRoutingSnapshot(expectedRouting, currentRouting)
  ) {
    return { status: "changed" };
  }
  const authorization = await authorizeSupportRoleOrCapability({
    guild,
    userId,
    capability: "tickets.manage",
    configuredRoleId: currentRouting.supportRoleId,
    grants: runtime.storage,
  });
  if (!authorization.allowed) return { status: "unauthorized" };

  const verifiedTicket = runtime.storage.getTicketById(expectedTicket.ticketId);
  const verifiedRouting = verifiedTicket
    ? ticketRoutingConfiguration(runtime, verifiedTicket)
    : null;
  if (
    !runtime.isCurrent() ||
    !verifiedTicket ||
    !verifiedRouting ||
    !isSameRecoverySnapshot(expectedTicket, verifiedTicket) ||
    !isSameRoutingSnapshot(expectedRouting, verifiedRouting)
  ) {
    return { status: "changed" };
  }
  return {
    status: "authorized",
    member: authorization.member,
    ticket: verifiedTicket,
    routing: verifiedRouting,
  };
}

function ticketRecoveryAuthorizationFailureMessage(
  failure: TicketRecoveryAuthorizationFailure,
): string {
  return failure === "unauthorized"
    ? TICKET_RECOVERY_UNAVAILABLE_MESSAGE
    : "This ticket or its department changed while recovery was running. Review its current configuration and try again.";
}

function repairDeletedAdoptedRecoveryChannel(
  runtime: GuildRuntime,
  originalTicket: TicketRecord,
  deletedChannelId: string,
  fallbackChannelId: string | null,
  actorId: string,
): void {
  if (!fallbackChannelId) return;
  // This is compensating for a Discord deletion already completed by this
  // invocation. It intentionally survives generation invalidation, while the
  // exact ticket identity and channel CAS prevent overwriting newer routing.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = runtime.storage.getTicketById(originalTicket.ticketId);
    if (!current || current.channelId !== deletedChannelId) return;
    if (
      current.guildId !== originalTicket.guildId ||
      current.openerId !== originalTicket.openerId ||
      current.departmentId !== originalTicket.departmentId ||
      !["creating", "open", "closing"].includes(current.state)
    ) {
      return;
    }
    const repaired = runtime.storage.rebindTicket(
      current.ticketId,
      {
        channelId: fallbackChannelId,
        controlMessageId: null,
        expectedChannelId: deletedChannelId,
        expectedControlMessageId: current.controlMessageId,
        expectedState: current.state,
        expectedUpdatedAt: current.updatedAt,
      },
      actorId,
    );
    if (repaired.status !== "conflict") return;
  }
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

function ticketDisplayContext(runtime: GuildRuntime, ticket: TicketRecord) {
  const department = runtime.storage.getTicketDepartment(ticket.departmentId);
  return {
    department:
      department?.guildId === runtime.guildId
        ? { displayName: department.displayName }
        : null,
    responses: runtime.storage
      .listTicketResponses(ticket.ticketId)
      .filter(
        (response) =>
          response.guildId === runtime.guildId &&
          response.ticketId === ticket.ticketId,
      )
      .map(toTicketFormResponse),
  };
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
    const role = await guild.roles.fetch(roleId, { cache: true, force: true });
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

function isSameRoutingSnapshot(
  expected: TicketConfiguration,
  current: TicketConfiguration,
): boolean {
  return (
    current.guildId === expected.guildId &&
    current.departmentId === expected.departmentId &&
    current.categoryId === expected.categoryId &&
    current.logChannelId === expected.logChannelId &&
    current.supportRoleId === expected.supportRoleId &&
    current.enabled === expected.enabled &&
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
    const member = await guild.members.fetch({
      user: openerId,
      cache: true,
      force: true,
    });
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
    const channel = await guild.channels.fetch(channelId, {
      cache: true,
      force: true,
    });
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
