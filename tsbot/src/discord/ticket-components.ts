import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
  type APIEmbedField,
} from "discord.js";
import type { TicketRecord } from "../types.js";
import {
  DISCORD_CUSTOM_ID_LIMIT,
  SAFE_PANEL_ALLOWED_MENTIONS,
  createSuperiorEmbed,
  isTicketPanelToken,
} from "./panel-theme.js";

export const TICKET_INPUT_LIMITS = Object.freeze({
  subject: 100,
  description: 1_000,
  closeReason: 400,
});

export const TICKET_SUBJECT_INPUT_ID = "subject";
export const TICKET_DESCRIPTION_INPUT_ID = "description";
export const TICKET_CLOSE_REASON_INPUT_ID = "reason";

const TICKET_ACTION_PREFIX = "superior:ticket:";
const TICKET_OPEN_MODAL_PREFIX = `${TICKET_ACTION_PREFIX}open-modal:`;
const TICKET_CLOSE_MODAL_PREFIX = `${TICKET_ACTION_PREFIX}close-modal:`;

export type TicketControlAction = "claim" | "release" | "close" | "info";

export type ParsedTicketComponent =
  | { kind: "open-modal"; panelId: string }
  | { kind: "close-modal"; ticketId: string }
  | { kind: TicketControlAction; ticketId: string };

export interface TicketMessagePayload {
  embeds: ReturnType<typeof createSuperiorEmbed>[];
  components: ActionRowBuilder<ButtonBuilder>[];
  allowedMentions: typeof SAFE_PANEL_ALLOWED_MENTIONS;
}

export function createTicketOpenModal(panelId: string): ModalBuilder {
  assertOpaqueId(panelId, "panel");
  return new ModalBuilder()
    .setCustomId(checkedCustomId(`${TICKET_OPEN_MODAL_PREFIX}${panelId}`))
    .setTitle("Open a Support Ticket")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(TICKET_SUBJECT_INPUT_ID)
          .setLabel("Subject")
          .setPlaceholder("A short summary of what you need")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(TICKET_INPUT_LIMITS.subject),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(TICKET_DESCRIPTION_INPUT_ID)
          .setLabel("Details")
          .setPlaceholder("Share the context staff need to assist you")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(TICKET_INPUT_LIMITS.description),
      ),
    );
}

export function createTicketCloseModal(ticketId: string): ModalBuilder {
  assertOpaqueId(ticketId, "ticket");
  return new ModalBuilder()
    .setCustomId(checkedCustomId(`${TICKET_CLOSE_MODAL_PREFIX}${ticketId}`))
    .setTitle("Close Ticket")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(TICKET_CLOSE_REASON_INPUT_ID)
          .setLabel("Closure reason")
          .setPlaceholder("Give the member and audit log a clear reason")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(TICKET_INPUT_LIMITS.closeReason),
      ),
    );
}

export function parseTicketComponentId(
  customId: string,
): ParsedTicketComponent | null {
  if (customId.startsWith(TICKET_OPEN_MODAL_PREFIX)) {
    const panelId = customId.slice(TICKET_OPEN_MODAL_PREFIX.length);
    return isOpaqueId(panelId) ? { kind: "open-modal", panelId } : null;
  }
  if (customId.startsWith(TICKET_CLOSE_MODAL_PREFIX)) {
    const ticketId = customId.slice(TICKET_CLOSE_MODAL_PREFIX.length);
    return isOpaqueId(ticketId) ? { kind: "close-modal", ticketId } : null;
  }
  for (const action of ["claim", "release", "close", "info"] as const) {
    const prefix = `${TICKET_ACTION_PREFIX}${action}:`;
    if (!customId.startsWith(prefix)) continue;
    const ticketId = customId.slice(prefix.length);
    return isOpaqueId(ticketId) ? { kind: action, ticketId } : null;
  }
  return null;
}

export function buildTicketWelcomePayload(
  ticket: TicketRecord,
): TicketMessagePayload {
  const embed = createSuperiorEmbed()
    .setTitle(`Ticket #${ticket.ticketNumber}`)
    .setDescription(
      "Thank you for contacting the support team. Keep relevant details in this channel and wait for a staff response.",
    )
    .addFields(
      { name: "Opened by", value: `<@${ticket.openerId}>`, inline: true },
      {
        name: "Created",
        value: `<t:${toUnixSeconds(ticket.createdAt)}:F>`,
        inline: true,
      },
      { name: "Subject", value: safeField(ticket.subject) },
      { name: "Details", value: safeField(ticket.description) },
    );
  return {
    embeds: [embed],
    components: [buildTicketControlRow(ticket)],
    allowedMentions: SAFE_PANEL_ALLOWED_MENTIONS,
  };
}

export function buildTicketControlRow(
  ticket: Pick<TicketRecord, "ticketId" | "state" | "claimedBy">,
): ActionRowBuilder<ButtonBuilder> {
  assertOpaqueId(ticket.ticketId, "ticket");
  const active = ticket.state === "open";
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    createControlButton(
      "claim",
      ticket.ticketId,
      "Claim",
      ButtonStyle.Primary,
    ).setDisabled(!active || ticket.claimedBy !== null),
    createControlButton(
      "release",
      ticket.ticketId,
      "Release",
      ButtonStyle.Secondary,
    ).setDisabled(!active || ticket.claimedBy === null),
    createControlButton("info", ticket.ticketId, "Info", ButtonStyle.Secondary),
    createControlButton(
      "close",
      ticket.ticketId,
      "Close",
      ButtonStyle.Danger,
    ).setDisabled(!active),
  );
}

export function buildTicketInfoPayload(
  ticket: TicketRecord,
): TicketMessagePayload {
  const fields: APIEmbedField[] = [
    { name: "Status", value: titleCase(ticket.state), inline: true },
    {
      name: "Claimed by",
      value: ticket.claimedBy ? `<@${ticket.claimedBy}>` : "Unclaimed",
      inline: true,
    },
    { name: "Opened by", value: `<@${ticket.openerId}>`, inline: true },
    { name: "Subject", value: safeField(ticket.subject) },
  ];
  if (ticket.closeReason) {
    fields.push({
      name: "Closure reason",
      value: safeField(ticket.closeReason),
    });
  }
  const embed = createSuperiorEmbed()
    .setTitle(`Ticket #${ticket.ticketNumber}`)
    .setDescription(`Created <t:${toUnixSeconds(ticket.createdAt)}:R>`)
    .addFields(fields);
  return {
    embeds: [embed],
    components: [],
    allowedMentions: SAFE_PANEL_ALLOWED_MENTIONS,
  };
}

export function buildTicketClosureEmbed(ticket: TicketRecord) {
  const closedAt = ticket.closedAt ?? new Date().toISOString();
  return createSuperiorEmbed()
    .setTitle(`Ticket #${ticket.ticketNumber} Closed`)
    .setDescription(
      "The closure record and transcript were delivered successfully.",
    )
    .addFields(
      { name: "Opened by", value: `<@${ticket.openerId}>`, inline: true },
      {
        name: "Closed by",
        value: ticket.closedBy ? `<@${ticket.closedBy}>` : "Support staff",
        inline: true,
      },
      { name: "Subject", value: safeField(ticket.subject) },
      {
        name: "Reason",
        value: safeField(ticket.closeReason ?? "No reason recorded."),
      },
      {
        name: "Closure recorded",
        value: `<t:${toUnixSeconds(closedAt)}:F>`,
      },
    );
}

export function normalizeTicketInput(
  value: string,
  label: string,
  maximum: number,
): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be text.`);
  const normalized = value
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!normalized) throw new TypeError(`${label} cannot be empty.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError(`${label} cannot contain control characters.`);
  }
  if (normalized.length > maximum) {
    throw new RangeError(`${label} cannot exceed ${maximum} characters.`);
  }
  return normalized;
}

function createControlButton(
  action: TicketControlAction,
  ticketId: string,
  label: string,
  style: ButtonStyle,
): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(
      checkedCustomId(`${TICKET_ACTION_PREFIX}${action}:${ticketId}`),
    )
    .setLabel(label)
    .setStyle(style);
}

function isOpaqueId(value: string): boolean {
  return isTicketPanelToken(value);
}

function assertOpaqueId(value: string, label: string): void {
  if (!isOpaqueId(value)) throw new TypeError(`Invalid ${label} identifier.`);
}

function checkedCustomId(value: string): string {
  if (value.length > DISCORD_CUSTOM_ID_LIMIT) {
    throw new RangeError(
      "Ticket component identifier exceeds Discord's limit.",
    );
  }
  return value;
}

function safeField(value: string): string {
  return escapeMarkdown(value).slice(0, 1_024) || "Not provided";
}

function toUnixSeconds(value: string): number {
  const timestamp = Date.parse(value);
  return Math.floor(
    (Number.isFinite(timestamp) ? timestamp : Date.now()) / 1_000,
  );
}

function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
