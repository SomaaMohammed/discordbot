import {
  ChannelType,
  escapeMarkdown,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
} from "discord.js";
import type { GuildRuntime } from "../runtime.js";
import { createOpaqueStorageId } from "../storage/operational-repository.js";
import type {
  ApplicationForm,
  SuggestionConfiguration,
  TicketConfiguration,
  TicketDepartment,
} from "../types.js";
import type {
  NormalizedResourcePanel,
  PanelFeatureState,
  PanelPreset,
  SuperiorPanelPayload,
} from "./panel-theme.js";
import {
  PANEL_PRESETS,
  PANEL_PRESET_DESCRIPTIONS,
  RESOURCE_PANEL_LIMITS,
  isPanelPreset,
  normalizeResourcePanelInput,
  renderSuperiorPanel,
} from "./panel-theme.js";
import {
  canPostThemedPanel,
  inspectTicketConfigurationResources,
} from "./ticket-permissions.js";
import { KeyedSerialQueue } from "./keyed-serial-queue.js";
import {
  inspectApplicationResources,
  inspectSuggestionResources,
  isConfiguredDepartment,
} from "./phase2-permissions.js";

const panelPostQueue = new KeyedSerialQueue();

interface PostPanelOptions {
  preset: PanelPreset;
  channel: GuildTextBasedChannel;
  replaceExisting: boolean;
  resource?: NormalizedResourcePanel;
}

export async function handlePresetPanelCommand(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
): Promise<void> {
  switch (interaction.options.getSubcommand()) {
    case "list":
      await replyPrivate(
        interaction,
        [
          "**Superior panel presets**",
          ...PANEL_PRESETS.map(
            (preset) => `\`${preset}\` — ${PANEL_PRESET_DESCRIPTIONS[preset]}`,
          ),
        ].join("\n"),
      );
      runtime.storage.recordCommandMetric("panel.list");
      return;
    case "status":
      await showPanelStatus(interaction, runtime);
      return;
    case "post":
      await handlePostPanel(interaction, runtime, actor);
      return;
    default:
      await replyPrivate(interaction, "Choose a supported panel action.");
  }
}

export async function postTicketLauncher(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
): Promise<void> {
  await postFeatureLauncher(interaction, runtime, actor, "tickets");
}

export async function postFeatureLauncher(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
  preset: "tickets" | "suggestions" | "applications",
): Promise<void> {
  const channel = getSelectedPanelChannel(interaction, runtime, "channel");
  if (!channel) {
    await replyPrivate(
      interaction,
      "Choose a text or announcement channel in this server.",
    );
    return;
  }
  await postSuperiorPanel(interaction, runtime, actor, {
    preset,
    channel,
    replaceExisting:
      interaction.options.getBoolean("replace_existing", false) ?? true,
  });
}

async function handlePostPanel(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
): Promise<void> {
  const rawPreset = interaction.options.getString("preset", true);
  if (!isPanelPreset(rawPreset)) {
    await replyPrivate(interaction, "Choose a supported Superior preset.");
    return;
  }
  const channel = getSelectedPanelChannel(interaction, runtime, "channel");
  if (!channel) {
    await replyPrivate(
      interaction,
      "Choose a text or announcement channel in this server.",
    );
    return;
  }
  let resource: NormalizedResourcePanel | undefined;
  if (rawPreset === "resources") {
    try {
      resource = readResourceOptions(interaction);
    } catch (error) {
      await replyPrivate(interaction, errorMessage(error));
      return;
    }
  } else if (hasResourceOptions(interaction)) {
    await replyPrivate(
      interaction,
      "Resource title, body, and links can only be used with the resources preset.",
    );
    return;
  }
  await postSuperiorPanel(interaction, runtime, actor, {
    preset: rawPreset,
    channel,
    replaceExisting:
      interaction.options.getBoolean("replace_existing", false) ?? true,
    ...(resource ? { resource } : {}),
  });
}

async function postSuperiorPanel(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
  options: PostPanelOptions,
): Promise<void> {
  await panelPostQueue.run(
    `${runtime.guildId}:${options.preset}:${options.channel.id}`,
    () => postSuperiorPanelSerial(interaction, runtime, actor, options),
  );
}

async function postSuperiorPanelSerial(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
  options: PostPanelOptions,
): Promise<void> {
  if (
    actor.guild.id !== runtime.guildId ||
    options.channel.guild.id !== runtime.guildId ||
    interaction.guild?.id !== runtime.guildId
  ) {
    await replyPrivate(
      interaction,
      "That panel target is outside this server.",
    );
    return;
  }
  const guild = interaction.guild;
  const botMember =
    guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!botMember || !canPostThemedPanel(options.channel, botMember)) {
    await replyPrivate(
      interaction,
      "Superior needs View Channel, Send Messages, Read Message History, and Embed Links there.",
    );
    return;
  }
  const enabledDepartments = listTicketDepartmentsSafely(runtime, {
    enabled: true,
    limit: 10,
  });
  const ticketConfiguration = runtime.storage.getTicketConfiguration();
  if (options.preset === "tickets") {
    if (enabledDepartments.length === 0 && !ticketConfiguration?.enabled) {
      await replyPrivate(
        interaction,
        "Configure and enable a ticket department with `/ticket setup` or `/ticket department create` before posting this panel.",
      );
      return;
    }
    const issue =
      enabledDepartments.length > 0
        ? await firstTicketDepartmentIssue(guild, enabledDepartments, runtime)
        : (
            await inspectTicketConfigurationResources(
              guild,
              ticketConfiguration!,
              runtime.storage,
            )
          ).issues.join(" ") || null;
    if (issue) {
      await replyPrivate(
        interaction,
        `Ticket configuration needs attention: ${issue}`,
      );
      return;
    }
  }
  if (options.preset === "suggestions") {
    const configuration = runtime.storage.getSuggestionConfiguration();
    if (!configuration?.enabled) {
      await replyPrivate(
        interaction,
        "Configure and enable suggestions before posting this panel.",
      );
      return;
    }
    const resources = await inspectSuggestionResources(guild, configuration);
    if (resources.issues.length > 0) {
      await replyPrivate(
        interaction,
        `Suggestion configuration needs attention: ${resources.issues.join(" ")}`,
      );
      return;
    }
  }
  if (options.preset === "applications") {
    const forms = runtime.storage.listApplicationForms({
      enabledOnly: true,
      limit: 25,
    });
    if (forms.length === 0) {
      await replyPrivate(
        interaction,
        "Enable at least one application form before posting this panel.",
      );
      return;
    }
    const issue = await firstApplicationFormIssue(guild, forms);
    if (issue) {
      await replyPrivate(
        interaction,
        `Application configuration needs attention: ${issue}`,
      );
      return;
    }
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server was disabled or reconfigured. Please try again.",
    );
    return;
  }

  const existing = runtime.storage.findPostedPanelByPresetAndChannel(
    options.preset,
    options.channel.id,
  );
  const panelId = existing?.panelId ?? createOpaqueToken();
  const payload = buildPanelPayload(
    options,
    panelId,
    runtime,
    enabledDepartments.length > 0 || Boolean(ticketConfiguration?.enabled),
  );
  let messageId: string | null = null;
  let replaced = false;
  let restorePrior: (() => Promise<boolean>) | null = null;
  if (existing && options.replaceExisting) {
    let prior: Message | null = null;
    try {
      prior = await options.channel.messages.fetch(existing.messageId);
    } catch (error) {
      if (!isUnknownMessageError(error)) {
        await replyPrivate(
          interaction,
          "Superior could not verify the tracked panel message with Discord. No new message was posted; try again when Discord is available.",
        );
        runtime.storage.recordCommandMetric(
          `panel.${options.preset}.post`,
          false,
        );
        return;
      }
    }
    if (prior?.author.id === interaction.client.user?.id) {
      const priorPayload = {
        embeds: [...(prior.embeds ?? [])],
        components: [...(prior.components ?? [])],
        allowedMentions: { parse: [] as never[] },
      };
      restorePrior = async () =>
        prior
          .edit(priorPayload)
          .then(() => true)
          .catch(() => false);
      await prior.edit(toDiscordPayload(payload));
      messageId = prior.id;
      replaced = true;
    }
  }
  let postedMessage: Awaited<ReturnType<GuildTextBasedChannel["send"]>> | null =
    null;
  if (!messageId) {
    postedMessage = await options.channel.send(toDiscordPayload(payload));
    messageId = postedMessage.id;
  }
  if (!runtime.isCurrent()) {
    const cleanup = await cleanUpPanelMutation(postedMessage, restorePrior);
    await replyPrivate(
      interaction,
      cleanup.warning
        ? `This server changed while the panel was being posted. ${cleanup.warning}`
        : "This server changed while the panel was being posted. No panel change was retained.",
    );
    return;
  }
  try {
    runtime.storage.upsertPostedPanel({
      panelId,
      preset: options.preset,
      channelId: options.channel.id,
      messageId,
      configuration: options.resource ?? {},
    });
  } catch (error) {
    const cleanup = await cleanUpPanelMutation(postedMessage, restorePrior);
    await replyPrivate(
      interaction,
      `Superior could not persist the panel binding. ${cleanup.warning ?? "The Discord change was rolled back safely."}`,
    );
    runtime.storage.recordCommandMetric(`panel.${options.preset}.post`, false);
    return;
  }
  await replyPrivate(
    interaction,
    `${replaced ? "Refreshed" : "Posted"} the **${escapeMarkdown(options.preset)}** panel in <#${options.channel.id}>.`,
  );
  runtime.storage.recordCommandMetric(`panel.${options.preset}.post`);
}

function isUnknownMessageError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    rawError?: { code?: unknown };
  };
  return candidate.code === 10_008 || candidate.rawError?.code === 10_008;
}

async function cleanUpPanelMutation(
  postedMessage: Awaited<ReturnType<GuildTextBasedChannel["send"]>> | null,
  restorePrior: (() => Promise<boolean>) | null,
): Promise<{ warning: string | null }> {
  const warnings: string[] = [];
  if (postedMessage) {
    const removed = await postedMessage
      .delete()
      .then(() => true)
      .catch(() => false);
    if (!removed) {
      warnings.push(
        `The untracked Discord message \`${postedMessage.id}\` could not be removed; delete it manually.`,
      );
    }
  }
  if (restorePrior && !(await restorePrior())) {
    warnings.push(
      "The previously tracked message could not be restored; refresh it after reviewing the current configuration.",
    );
  }
  return { warning: warnings.length > 0 ? warnings.join(" ") : null };
}

function buildPanelPayload(
  options: PostPanelOptions,
  panelId: string,
  runtime: GuildRuntime,
  ticketsEnabled: boolean,
): SuperiorPanelPayload {
  switch (options.preset) {
    case "help":
      return renderSuperiorPanel({
        preset: "help",
        features: buildFeatureState(runtime, ticketsEnabled),
      });
    case "server-info":
      return renderSuperiorPanel({
        preset: "server-info",
        guild: options.channel.guild,
      });
    case "resources":
      if (!options.resource)
        throw new Error("Resource panel content is missing.");
      return renderSuperiorPanel({
        preset: "resources",
        resource: options.resource,
      });
    case "tickets":
      return renderSuperiorPanel({ preset: "tickets", panelToken: panelId });
    case "suggestions":
      return renderSuperiorPanel({
        preset: "suggestions",
        panelToken: panelId,
      });
    case "applications":
      return renderSuperiorPanel({
        preset: "applications",
        panelToken: panelId,
      });
  }
}

function buildFeatureState(
  runtime: GuildRuntime,
  tickets: boolean,
): PanelFeatureState {
  return {
    chat: runtime.settings.features.chat,
    replyModeration: runtime.settings.features.replyModeration,
    greetings: runtime.settings.features.greetings,
    activityMetrics: runtime.settings.features.activityMetrics,
    tickets,
    suggestions: Boolean(getSuggestionConfigurationSafely(runtime)?.enabled),
    applications:
      listApplicationFormsSafely(runtime, {
        enabledOnly: true,
        limit: 1,
      }).length > 0,
  };
}

async function firstTicketDepartmentIssue(
  guild: Guild,
  departments: readonly TicketDepartment[],
  runtime: GuildRuntime,
): Promise<string | null> {
  for (const department of departments) {
    if (!isConfiguredDepartment(department)) {
      return `Department \`${department.slug}\` is missing a category, log channel, or support role.`;
    }
    if (department.bindingsVerifiedAt === null) {
      return `Department \`${department.slug}\` must be enabled again so its Discord bindings can be verified.`;
    }
    const resources = await inspectTicketConfigurationResources(
      guild,
      departmentConfiguration(department),
      runtime.storage,
    );
    if (resources.issues.length > 0) {
      return `Department \`${department.slug}\`: ${resources.issues.join(" ")}`;
    }
  }
  return null;
}

async function firstApplicationFormIssue(
  guild: Guild,
  forms: readonly ApplicationForm[],
): Promise<string | null> {
  for (const form of forms) {
    const resources = await inspectApplicationResources(guild, form);
    if (resources.issues.length > 0) {
      return `Form \`${form.slug}\`: ${resources.issues.join(" ")}`;
    }
  }
  return null;
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

function listTicketDepartmentsSafely(
  runtime: GuildRuntime,
  options: { enabled?: boolean; limit?: number },
): TicketDepartment[] {
  const storage = runtime.storage as unknown as {
    listTicketDepartments?: (input: {
      enabled?: boolean;
      limit?: number;
    }) => TicketDepartment[];
  };
  return typeof storage.listTicketDepartments === "function"
    ? storage.listTicketDepartments(options)
    : [];
}

function getSuggestionConfigurationSafely(
  runtime: GuildRuntime,
): SuggestionConfiguration | null {
  const storage = runtime.storage as unknown as {
    getSuggestionConfiguration?: () => SuggestionConfiguration | null;
  };
  return typeof storage.getSuggestionConfiguration === "function"
    ? storage.getSuggestionConfiguration()
    : null;
}

function listApplicationFormsSafely(
  runtime: GuildRuntime,
  options: { enabledOnly?: boolean; limit?: number },
): ApplicationForm[] {
  const storage = runtime.storage as unknown as {
    listApplicationForms?: (input: {
      enabledOnly?: boolean;
      limit?: number;
    }) => ApplicationForm[];
  };
  return typeof storage.listApplicationForms === "function"
    ? storage.listApplicationForms(options)
    : [];
}

async function showPanelStatus(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const departments = listTicketDepartmentsSafely(runtime, { limit: 10 });
  const enabledDepartments = departments.filter(
    (department) => department.enabled,
  );
  const suggestionConfiguration = getSuggestionConfigurationSafely(runtime);
  const applicationForms = listApplicationFormsSafely(runtime, { limit: 25 });
  const enabledApplicationForms = applicationForms.filter(
    (form) => form.enabled,
  );
  const panelCount = runtime.storage.countPostedPanels();
  const panels = runtime.storage.listPostedPanels(undefined, 20, 0);
  const lines = [
    "**Superior panel status**",
    `Ticket departments: **${enabledDepartments.length} enabled** · ${departments.length} configured`,
    `Suggestions: **${suggestionConfiguration?.enabled ? "enabled" : "disabled"}**`,
    `Application forms: **${enabledApplicationForms.length} enabled** · ${applicationForms.length} configured`,
    panels.length > 0
      ? `Tracked panels (${panels.length}${panelCount > panels.length ? "+" : ""} of ${panelCount}):`
      : "Tracked panels: none",
    ...panels.map(
      (panel) =>
        `• **${escapeMarkdown(panel.preset)}** · <#${panel.channelId}> · message \`${panel.messageId}\``,
    ),
  ];
  await replyPrivate(interaction, lines.join("\n").slice(0, 2_000));
  runtime.storage.recordCommandMetric("panel.status");
}

function readResourceOptions(
  interaction: ChatInputCommandInteraction,
): NormalizedResourcePanel {
  const title = interaction.options.getString("resource_title", false);
  const body = interaction.options.getString("resource_body", false);
  if (!title || !body) {
    throw new TypeError(
      "The resources preset requires both resource_title and resource_body.",
    );
  }
  const links: Array<{ label: string; url: string }> = [];
  for (let index = 1; index <= RESOURCE_PANEL_LIMITS.links; index += 1) {
    const label = interaction.options.getString(`link_${index}_label`, false);
    const url = interaction.options.getString(`link_${index}_url`, false);
    if (Boolean(label) !== Boolean(url)) {
      throw new TypeError(
        `Link ${index} requires both a label and an HTTPS URL.`,
      );
    }
    if (label && url) links.push({ label, url });
  }
  return normalizeResourcePanelInput({ title, body, links });
}

function hasResourceOptions(interaction: ChatInputCommandInteraction): boolean {
  if (
    interaction.options.getString("resource_title", false) ||
    interaction.options.getString("resource_body", false)
  ) {
    return true;
  }
  for (let index = 1; index <= RESOURCE_PANEL_LIMITS.links; index += 1) {
    if (
      interaction.options.getString(`link_${index}_label`, false) ||
      interaction.options.getString(`link_${index}_url`, false)
    ) {
      return true;
    }
  }
  return false;
}

function getSelectedPanelChannel(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  optionName: string,
): GuildTextBasedChannel | null {
  const selected: unknown = interaction.options.getChannel(optionName, true);
  const channel = selected as GuildTextBasedChannel | null;
  if (
    !channel ||
    typeof channel.isDMBased !== "function" ||
    channel.guild.id !== runtime.guildId ||
    (channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement) ||
    channel.isDMBased()
  ) {
    return null;
  }
  return channel;
}

function toDiscordPayload(payload: SuperiorPanelPayload) {
  return {
    embeds: [...payload.embeds],
    components: [...payload.components],
    allowedMentions: { parse: [] as never[] },
  };
}

function createOpaqueToken(): string {
  return createOpaqueStorageId();
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Panel validation failed.";
}
