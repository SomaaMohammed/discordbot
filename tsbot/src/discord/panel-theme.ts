import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  escapeMarkdown,
  type Guild,
  type MessageMentionOptions,
} from "discord.js";
import { PANEL_PRESETS, type PanelPreset } from "../types.js";

export { PANEL_PRESETS };
export type { PanelPreset };

export const SUPERIOR_PANEL_COLOR = 0xd4af37;
export const SUPERIOR_PANEL_FOOTER_TEXT = "Superior";
export const DISCORD_CUSTOM_ID_LIMIT = 100;
export const TICKET_OPEN_CUSTOM_ID_PREFIX = "superior:ticket:open:";
export const SUGGESTION_OPEN_CUSTOM_ID_PREFIX = "superior:suggestion:open:";
export const APPLICATION_OPEN_CUSTOM_ID_PREFIX = "superior:application:open:";
export const REPORT_OPEN_CUSTOM_ID_PREFIX = "superior:report:open:";
export const APPEAL_OPEN_CUSTOM_ID_PREFIX = "superior:appeal:open:";

export const RESOURCE_PANEL_LIMITS = Object.freeze({
  title: 256,
  body: 4_096,
  links: 5,
  linkLabel: 80,
  linkUrl: 512,
});

export const TICKET_PANEL_TOKEN_LIMITS = Object.freeze({
  minimum: 8,
  maximum: 48,
});

export const SAFE_PANEL_ALLOWED_MENTIONS: Readonly<MessageMentionOptions> =
  Object.freeze({ parse: Object.freeze([]) });

export const PANEL_PRESET_DESCRIPTIONS: Readonly<Record<PanelPreset, string>> =
  Object.freeze({
    help: "Active Superior commands and common member actions",
    "server-info": "A concise snapshot of the current server",
    resources: "Administrator-curated information and HTTPS links",
    tickets: "The configured support-ticket launcher",
    suggestions: "The configured member-suggestion launcher",
    applications: "The configured private staff-application launcher",
    safety: "Private member reports and eligible case appeals",
  });

export interface PanelFeatureState {
  chat: boolean;
  replyModeration: boolean;
  greetings: boolean;
  activityMetrics: boolean;
  tickets: boolean;
  suggestions?: boolean;
  applications?: boolean;
  reports?: boolean;
  appeals?: boolean;
}

export interface ResourcePanelLinkInput {
  label: string;
  url: string;
}

export interface ResourcePanelInput {
  title: string;
  body: string;
  links?: readonly ResourcePanelLinkInput[];
}

export interface ResourcePanelLink {
  label: string;
  url: string;
}

/** Serializable content suitable for storing with a posted resources panel. */
export interface NormalizedResourcePanel {
  title: string;
  body: string;
  links: ResourcePanelLink[];
}

export type SuperiorPanelRequest =
  | { preset: "help"; features: Readonly<PanelFeatureState> }
  | { preset: "server-info"; guild: Guild }
  | { preset: "resources"; resource: ResourcePanelInput }
  | { preset: "tickets"; panelToken: string }
  | { preset: "suggestions"; panelToken: string }
  | { preset: "applications"; panelToken: string }
  | {
      preset: "safety";
      panelToken: string;
      reportsEnabled: boolean;
      appealsEnabled: boolean;
    };

export interface SuperiorPanelPayload {
  embeds: readonly [EmbedBuilder];
  components: readonly ActionRowBuilder<ButtonBuilder>[];
  allowedMentions: Readonly<MessageMentionOptions>;
}

/**
 * Starts a Superior-branded embed without exposing a caller-controlled color
 * or footer. Ticket lifecycle messages can use this as well as panel presets.
 */
export function createSuperiorEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(SUPERIOR_PANEL_COLOR)
    .setFooter({ text: SUPERIOR_PANEL_FOOTER_TEXT });
}

export function isPanelPreset(value: string): value is PanelPreset {
  return (PANEL_PRESETS as readonly string[]).includes(value);
}

export function normalizeResourcePanelInput(
  input: ResourcePanelInput,
): NormalizedResourcePanel {
  if (!input || typeof input !== "object") {
    throw new TypeError("Resource panel content is required.");
  }

  const title = normalizeSingleLine(
    input.title,
    "Resource title",
    RESOURCE_PANEL_LIMITS.title,
  );
  const body = normalizeBody(input.body);
  const rawLinks = input.links ?? [];
  if (!Array.isArray(rawLinks)) {
    throw new TypeError("Resource links must be an array.");
  }
  if (rawLinks.length > RESOURCE_PANEL_LIMITS.links) {
    throw new RangeError(
      `Resource panels support at most ${RESOURCE_PANEL_LIMITS.links} links.`,
    );
  }

  const links = rawLinks.map((link, index) => {
    if (!link || typeof link !== "object") {
      throw new TypeError(`Resource link ${index + 1} is invalid.`);
    }
    return {
      label: normalizeSingleLine(
        link.label,
        `Resource link ${index + 1} label`,
        RESOURCE_PANEL_LIMITS.linkLabel,
      ),
      url: normalizeHttpsUrl(link.url, index),
    };
  });

  if (new Set(links.map(({ url }) => url)).size !== links.length) {
    throw new TypeError("Resource link URLs must be unique.");
  }

  return { title, body, links };
}

export function isTicketPanelToken(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length >= TICKET_PANEL_TOKEN_LIMITS.minimum &&
    value.length <= TICKET_PANEL_TOKEN_LIMITS.maximum &&
    /^[A-Za-z0-9_-]+$/.test(value) &&
    TICKET_OPEN_CUSTOM_ID_PREFIX.length + value.length < DISCORD_CUSTOM_ID_LIMIT
  );
}

export function createTicketOpenCustomId(panelToken: string): string {
  if (typeof panelToken !== "string") {
    throw new TypeError("Ticket panel token must be text.");
  }
  if (!isTicketPanelToken(panelToken)) {
    throw new TypeError(
      `Ticket panel token must be ${TICKET_PANEL_TOKEN_LIMITS.minimum}-${TICKET_PANEL_TOKEN_LIMITS.maximum} URL-safe opaque characters.`,
    );
  }
  return `${TICKET_OPEN_CUSTOM_ID_PREFIX}${panelToken}`;
}

export function parseTicketOpenCustomId(customId: string): string | null {
  if (!customId.startsWith(TICKET_OPEN_CUSTOM_ID_PREFIX)) return null;
  const token = customId.slice(TICKET_OPEN_CUSTOM_ID_PREFIX.length);
  return isTicketPanelToken(token) ? token : null;
}

export function renderSuperiorPanel(
  request: SuperiorPanelRequest,
): SuperiorPanelPayload {
  switch (request.preset) {
    case "help":
      return renderHelpPanel(request.features);
    case "server-info":
      return renderServerInfoPanel(request.guild);
    case "resources":
      return renderResourcesPanel(request.resource);
    case "tickets":
      return renderTicketLauncherPanel(request.panelToken);
    case "suggestions":
      return renderSuggestionLauncherPanel(request.panelToken);
    case "applications":
      return renderApplicationLauncherPanel(request.panelToken);
    case "safety":
      return renderSafetyLauncherPanel(
        request.panelToken,
        request.reportsEnabled,
        request.appealsEnabled,
      );
  }
}

export function renderHelpPanel(
  features: Readonly<PanelFeatureState>,
): SuperiorPanelPayload {
  const memberActions = [
    "`/utility` - view server, member, role, channel, ID, and time information privately.",
    "`/fun battle` - start a lightweight member matchup.",
  ];
  if (features.activityMetrics) {
    memberActions.push(
      "`/fun stats` and `/fun leaderboard` - review stored activity totals.",
    );
  }
  if (features.greetings) {
    memberActions.push(
      "`/greetings send` - send yourself a configured server greeting.",
    );
  }

  const activeServices: string[] = [];
  if (features.chat) {
    activeServices.push(
      "Natural chat responds to the configured invocation, a Superior mention, or a direct reply.",
    );
  }
  if (features.replyModeration) {
    activeServices.push(
      "Reply moderation is active for configured server conversations.",
    );
  }
  if (features.tickets) {
    activeServices.push(
      "Support tickets are active. Use the server's ticket launcher to contact staff privately.",
    );
  }
  if (features.suggestions) {
    activeServices.push(
      "Suggestions are active. Use `/suggestion submit` or the server's suggestion panel.",
    );
  }
  if (features.applications) {
    activeServices.push(
      "Staff applications are active. Use `/application submit` or the server's application panel.",
    );
  }
  if (features.reports) {
    activeServices.push(
      "Private member reports are active. Use `/report submit` or the server's safety panel.",
    );
  }
  if (features.appeals) {
    activeServices.push(
      "Case appeals are active. Use `/appeal submit` for an eligible moderation case.",
    );
  }
  if (activeServices.length === 0) {
    activeServices.push(
      "Core member services are active; resource-bound workflows appear after their Discord bindings are verified.",
    );
  }

  const ownerAdministratorCommands = [
    "`/config` - review optional settings or use the emergency bot-state switch.",
    "`/data` - export, import, or purge this server's stored data.",
    "`/access` - grant or revoke delegated role capabilities.",
  ];
  const workflowCommands = [
    "`/superior` - use commands permitted by your current Discord permissions.",
    "`/panel` - post or inspect panels when you hold panel-management access.",
    "`/ticket` - configure departments or recover tickets when authorized.",
    "`/suggestion` - submit or withdraw suggestions; authorized reviewers can manage them.",
    "`/application` - submit, check, or withdraw applications; authorized staff can review them.",
    "`/report` and `/appeal` - privately contact the server's safety reviewers.",
  ];

  const embed = createSuperiorEmbed()
    .setTitle("Superior Help")
    .setDescription(
      "Use these active services when you need information, assistance, or a quick server action.",
    )
    .addFields(
      { name: "Member commands", value: memberActions.join("\n") },
      { name: "Active services", value: activeServices.join("\n") },
      {
        name: "Owner / Administrator commands",
        value: ownerAdministratorCommands.join("\n"),
      },
      {
        name: "Member and delegated commands",
        value: workflowCommands.join("\n"),
      },
      {
        name: "Need assistance?",
        value: features.tickets
          ? "Open a ticket from the server's ticket panel."
          : "Contact a server administrator or moderator.",
      },
    );

  return createPanelPayload(embed);
}

export function renderServerInfoPanel(guild: Guild): SuperiorPanelPayload {
  const boostCount = finiteCount(guild.premiumSubscriptionCount ?? 0);
  const boostTier = finiteCount(Number(guild.premiumTier));
  const createdTimestamp = Math.max(
    0,
    Math.floor(
      Number.isFinite(guild.createdTimestamp) ? guild.createdTimestamp : 0,
    ),
  );
  const embed = createSuperiorEmbed()
    .setTitle("Server Information")
    .setDescription(escapeMarkdown(guild.name).slice(0, 4_096))
    .addFields(
      { name: "Server ID", value: `\`${guild.id}\``, inline: true },
      { name: "Owner ID", value: `\`${guild.ownerId}\``, inline: true },
      {
        name: "Members",
        value: `\`${finiteCount(guild.memberCount)}\``,
        inline: true,
      },
      {
        name: "Channels",
        value: `\`${finiteCount(guild.channels.cache.size)}\``,
        inline: true,
      },
      {
        name: "Roles",
        value: `\`${Math.max(finiteCount(guild.roles.cache.size) - 1, 0)}\``,
        inline: true,
      },
      {
        name: "Boosts",
        value:
          boostTier > 0
            ? `\`${boostCount}\` (Tier ${boostTier})`
            : `\`${boostCount}\``,
        inline: true,
      },
      {
        name: "Created",
        value: `<t:${Math.floor(createdTimestamp / 1_000)}:F>`,
      },
    );
  const iconUrl = guild.iconURL({ extension: "png", size: 512 });
  if (iconUrl) embed.setThumbnail(iconUrl);

  return createPanelPayload(embed);
}

export function renderResourcesPanel(
  input: ResourcePanelInput,
): SuperiorPanelPayload {
  const resource = normalizeResourcePanelInput(input);
  const embed = createSuperiorEmbed()
    .setTitle(resource.title)
    .setDescription(resource.body);
  if (resource.links.length === 0) return createPanelPayload(embed);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    resource.links.map((link) =>
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel(link.label)
        .setURL(link.url),
    ),
  );
  return createPanelPayload(embed, [row]);
}

export function renderTicketLauncherPanel(
  panelToken: string,
): SuperiorPanelPayload {
  const customId = createTicketOpenCustomId(panelToken);
  const embed = createSuperiorEmbed()
    .setTitle("Support Tickets")
    .setDescription(
      "Open a private ticket to contact the server's support team. Share a clear subject and the details staff need to help.",
    )
    .addFields({
      name: "Before opening",
      value:
        "You may have one active ticket per department and up to three across this server. Keep requests focused and avoid sensitive information.",
    });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(customId)
      .setLabel("Open Ticket")
      .setStyle(ButtonStyle.Primary),
  );
  return createPanelPayload(embed, [row]);
}

export function renderSuggestionLauncherPanel(
  panelToken: string,
): SuperiorPanelPayload {
  const customId = createFeaturePanelCustomId(
    SUGGESTION_OPEN_CUSTOM_ID_PREFIX,
    panelToken,
    "Suggestion",
  );
  const embed = createSuperiorEmbed()
    .setTitle("Suggestions")
    .setDescription(
      "Share a clear proposal with the server. Suggestions are attributed to their authors and can be reviewed by staff.",
    )
    .addFields({
      name: "Before submitting",
      value:
        "Keep the title focused and explain the expected benefit. Submission cooldowns apply.",
    });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(customId)
      .setLabel("Share Suggestion")
      .setStyle(ButtonStyle.Primary),
  );
  return createPanelPayload(embed, [row]);
}

export function renderApplicationLauncherPanel(
  panelToken: string,
): SuperiorPanelPayload {
  const customId = createFeaturePanelCustomId(
    APPLICATION_OPEN_CUSTOM_ID_PREFIX,
    panelToken,
    "Application",
  );
  const embed = createSuperiorEmbed()
    .setTitle("Staff Applications")
    .setDescription(
      "Choose an available staff application. Your answers are sent only to the configured review channel.",
    )
    .addFields({
      name: "Privacy",
      value:
        "Application answers are never posted publicly. You can review your own status with `/application status`.",
    });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(customId)
      .setLabel("Apply")
      .setStyle(ButtonStyle.Primary),
  );
  return createPanelPayload(embed, [row]);
}

export function renderSafetyLauncherPanel(
  panelToken: string,
  reportsEnabled: boolean,
  appealsEnabled: boolean,
): SuperiorPanelPayload {
  const reportCustomId = createFeaturePanelCustomId(
    REPORT_OPEN_CUSTOM_ID_PREFIX,
    panelToken,
    "Report",
  );
  const appealCustomId = createFeaturePanelCustomId(
    APPEAL_OPEN_CUSTOM_ID_PREFIX,
    panelToken,
    "Appeal",
  );
  const embed = createSuperiorEmbed()
    .setTitle("Safety Center")
    .setDescription(
      "Privately report a member to the server's safety team or appeal an eligible moderation case.",
    )
    .addFields(
      {
        name: "Privacy",
        value:
          "Submissions are delivered only to the configured review channel. Do not include passwords, payment details, or other secrets.",
      },
      {
        name: "Appeal availability",
        value:
          "Banned members cannot use server commands or this panel; server staff must provide another contact path when one is required.",
      },
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(reportCustomId)
      .setLabel("Submit Report")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!reportsEnabled),
    new ButtonBuilder()
      .setCustomId(appealCustomId)
      .setLabel("Submit Appeal")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!appealsEnabled),
  );
  return createPanelPayload(embed, [row]);
}

function createPanelPayload(
  embed: EmbedBuilder,
  components: readonly ActionRowBuilder<ButtonBuilder>[] = [],
): SuperiorPanelPayload {
  return {
    embeds: [embed],
    components,
    allowedMentions: SAFE_PANEL_ALLOWED_MENTIONS,
  };
}

export function parseSuggestionOpenCustomId(customId: string): string | null {
  return parseFeaturePanelCustomId(SUGGESTION_OPEN_CUSTOM_ID_PREFIX, customId);
}

export function parseApplicationOpenCustomId(customId: string): string | null {
  return parseFeaturePanelCustomId(APPLICATION_OPEN_CUSTOM_ID_PREFIX, customId);
}

export function parseReportOpenCustomId(customId: string): string | null {
  return parseFeaturePanelCustomId(REPORT_OPEN_CUSTOM_ID_PREFIX, customId);
}

export function parseAppealOpenCustomId(customId: string): string | null {
  return parseFeaturePanelCustomId(APPEAL_OPEN_CUSTOM_ID_PREFIX, customId);
}

function createFeaturePanelCustomId(
  prefix: string,
  panelToken: string,
  label: string,
): string {
  if (!isTicketPanelToken(panelToken)) {
    throw new TypeError(
      `${label} panel token must be ${TICKET_PANEL_TOKEN_LIMITS.minimum}-${TICKET_PANEL_TOKEN_LIMITS.maximum} URL-safe opaque characters.`,
    );
  }
  const customId = `${prefix}${panelToken}`;
  if (customId.length > DISCORD_CUSTOM_ID_LIMIT) {
    throw new RangeError(
      `${label} panel control exceeds Discord's custom ID limit.`,
    );
  }
  return customId;
}

function parseFeaturePanelCustomId(
  prefix: string,
  customId: string,
): string | null {
  if (!customId.startsWith(prefix)) return null;
  const token = customId.slice(prefix.length);
  return isTicketPanelToken(token) ? token : null;
}

function normalizeSingleLine(
  value: string,
  label: string,
  maximum: number,
): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be text.`);
  }
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized) throw new TypeError(`${label} cannot be empty.`);
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError(`${label} cannot contain control characters.`);
  }
  if (normalized.length > maximum) {
    throw new RangeError(`${label} cannot exceed ${maximum} characters.`);
  }
  return normalized;
}

function normalizeBody(value: string): string {
  if (typeof value !== "string") {
    throw new TypeError("Resource body must be text.");
  }
  const normalized = value
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!normalized) throw new TypeError("Resource body cannot be empty.");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError("Resource body cannot contain control characters.");
  }
  if (normalized.length > RESOURCE_PANEL_LIMITS.body) {
    throw new RangeError(
      `Resource body cannot exceed ${RESOURCE_PANEL_LIMITS.body} characters.`,
    );
  }
  return normalized;
}

function normalizeHttpsUrl(value: string, index: number): string {
  const label = `Resource link ${index + 1} URL`;
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be text.`);
  }
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > RESOURCE_PANEL_LIMITS.linkUrl) {
    throw new RangeError(
      `${label} must be 1-${RESOURCE_PANEL_LIMITS.linkUrl} characters.`,
    );
  }
  if (/\s|[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError(`${label} cannot contain whitespace or controls.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new TypeError(`${label} must be a valid HTTPS URL.`);
  }
  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  ) {
    throw new TypeError(
      `${label} must use HTTPS and cannot contain credentials.`,
    );
  }
  if (parsed.href.length > RESOURCE_PANEL_LIMITS.linkUrl) {
    throw new RangeError(
      `${label} cannot exceed ${RESOURCE_PANEL_LIMITS.linkUrl} characters after normalization.`,
    );
  }
  return parsed.href;
}

function finiteCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}
