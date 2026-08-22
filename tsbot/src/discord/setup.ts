import {
  AttachmentBuilder,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  escapeMarkdown,
  type ChatInputCommandInteraction,
  type GuildMember,
  type SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import { DateTime } from "luxon";
import {
  isGreetingTemplateWithinDiscordLimit,
  truncateDiscordContent,
} from "../greeting-message.js";
import { logInfo } from "../logging.js";
import type { BotRuntime, GuildRuntime } from "../runtime.js";
import { GuildSettingsConflictError } from "../storage/db.js";
import type { GuildDataExport, GuildSettings } from "../types.js";
import { clearBackfillStatus } from "./activity.js";
import { clearModerationProcessState } from "./moderation.js";
import { clearPanelProcessState } from "./panels.js";
import { clearAntiSpamProcessState } from "./anti-spam-enforcement.js";
import { getInteractionLifecycle } from "./interaction-lifecycle.js";
import { evaluateGuildManagement } from "./ticket-authorization.js";

const CONFIG_ADMIN_ERROR =
  "Only the server owner or a member with Administrator permission can manage Superior configuration.";
const GUILD_TRANSFER_MAX_BYTES = 2 * 1024 * 1024;
const CONFIG_SUMMARY_ITEM_LIMIT = 5;
const CONFIG_SUMMARY_ITEM_LENGTH = 80;
const GREETING_LIST_ITEM_LIMIT = 6;
const GREETING_LIST_MESSAGE_PREVIEW_LENGTH = 180;

export interface GuildConfigurationValidationResult {
  valid: boolean;
  errors: string[];
}

export function buildConfigCommandDefinition(): SlashCommandSubcommandsOnlyBuilder {
  return new SlashCommandBuilder()
    .setName("config")
    .setDescription("Manage optional Superior server configuration")
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("status")
        .setDescription("Show the active configuration"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("bot-state")
        .setDescription("Use the explicit emergency bot-state switch")
        .addBooleanOption((option) =>
          option
            .setName("enabled")
            .setDescription("Whether Superior should respond in this server")
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("log")
        .setDescription("Set or clear the optional log channel")
        .addStringOption((option) =>
          option
            .setName("action")
            .setDescription("Set or clear the binding")
            .setRequired(true)
            .addChoices(
              { name: "set", value: "set" },
              { name: "clear", value: "clear" },
            ),
        )
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("Log channel when action is set")
            .addChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildAnnouncement,
            )
            .setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("timezone")
        .setDescription(
          "Set the timezone used for natural-language time replies",
        )
        .addStringOption((option) =>
          option
            .setName("timezone")
            .setDescription("IANA timezone, such as UTC or Asia/Amman")
            .setRequired(true)
            .setMaxLength(100),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("limits")
        .setDescription("Set the finite bulk-moderation target cap")
        .addIntegerOption((option) =>
          option
            .setName("bulk_target_cap")
            .setDescription("Maximum targets per bulk command (1-1000)")
            .setMinValue(1)
            .setMaxValue(1_000)
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("trigger")
        .setDescription("Configure direct conversational invocation words")
        .addStringOption((option) =>
          option
            .setName("keyword")
            .setDescription("Primary invocation word or phrase")
            .setRequired(true)
            .setMaxLength(50),
        )
        .addStringOption((option) =>
          option
            .setName("aliases")
            .setDescription("Optional comma-separated aliases")
            .setRequired(false)
            .setMaxLength(500),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("greeting")
        .setDescription("Manage greeting profiles for the current invoker")
        .addStringOption((option) =>
          option
            .setName("action")
            .setDescription("Profile operation")
            .setRequired(true)
            .addChoices(
              { name: "add", value: "add" },
              { name: "update", value: "update" },
              { name: "remove", value: "remove" },
              { name: "list", value: "list" },
            ),
        )
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("Profile name")
            .setRequired(false)
            .setMaxLength(50),
        )
        .addStringOption((option) =>
          option
            .setName("message")
            .setDescription("Greeting text; {user} means the person sending it")
            .setRequired(false)
            .setMaxLength(2_000),
        ),
    );
}

export function buildDataCommandDefinition(): SlashCommandSubcommandsOnlyBuilder {
  return new SlashCommandBuilder()
    .setName("data")
    .setDescription("Export, import, or permanently purge server data")
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("export")
        .setDescription("Export this server's active data as bounded JSON"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("import")
        .setDescription(
          "Owner-only replacement from a supported same-server export",
        )
        .addAttachmentOption((option) =>
          option
            .setName("file")
            .setDescription("JSON file created by /data export")
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("confirmation")
            .setDescription("Type IMPORT followed by this server ID")
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("purge")
        .setDescription("Permanently purge only this server's stored data")
        .addStringOption((option) =>
          option
            .setName("confirmation")
            .setDescription("Type PURGE followed by this server ID")
            .setRequired(true),
        ),
    );
}

export async function handleConfigCommand(
  interaction: ChatInputCommandInteraction,
  runtime: BotRuntime,
  guildRuntime: GuildRuntime,
  authorizedActor?: GuildMember,
): Promise<void> {
  const actor =
    authorizedActor ?? (await requireConfigurationAdmin(interaction));
  if (
    !actor ||
    !interaction.guild ||
    interaction.guild.id !== guildRuntime.guildId
  ) {
    return;
  }
  try {
    switch (interaction.options.getSubcommand()) {
      case "status":
        await showConfigurationStatus(interaction, guildRuntime.settings);
        return;
      case "bot-state": {
        const enabled = interaction.options.getBoolean("enabled", true);
        await guildRuntime.setEnabled(enabled);
        if (!enabled) clearAntiSpamProcessState(guildRuntime.guildId);
        await replyPrivate(
          interaction,
          enabled
            ? "Superior is active. Core features are available immediately."
            : "Superior is disabled by the explicit emergency switch. Stored data and panels were retained.",
        );
        return;
      }
      case "log":
        await updateChannel(interaction, guildRuntime);
        return;
      case "timezone":
        await updateTimezone(interaction, guildRuntime);
        return;
      case "limits":
        await updateLimits(interaction, guildRuntime);
        return;
      case "trigger":
        await updateTrigger(interaction, guildRuntime);
        return;
      case "greeting":
        await updateGreeting(interaction, guildRuntime);
        return;
      default:
        await replyPrivate(interaction, "Unknown configuration operation.");
    }
  } catch (error) {
    if (error instanceof GuildSettingsConflictError) {
      await replyPrivate(
        interaction,
        "This server's configuration changed before the update completed. Review the latest settings and try again.",
      );
      return;
    }
    if (error instanceof TypeError || error instanceof RangeError) {
      await replyPrivate(
        interaction,
        truncateDiscordContent(
          `Configuration update was refused safely: ${error.message}`,
        ),
      );
      return;
    }
    throw error;
  }
}

export async function handleDataCommand(
  interaction: ChatInputCommandInteraction,
  runtime: BotRuntime,
  guildRuntime: GuildRuntime,
  authorizedActor?: GuildMember,
): Promise<void> {
  const actor =
    authorizedActor ?? (await requireConfigurationAdmin(interaction));
  if (
    !actor ||
    !interaction.guild ||
    interaction.guild.id !== guildRuntime.guildId
  ) {
    return;
  }
  try {
    switch (interaction.options.getSubcommand()) {
      case "export":
        await exportGuild(interaction, runtime, guildRuntime.guildId);
        return;
      case "import":
        await importGuild(interaction, runtime, guildRuntime, actor);
        return;
      case "purge":
        await purgeGuild(interaction, runtime, guildRuntime, actor);
        return;
      default:
        await replyPrivate(interaction, "Unknown data operation.");
    }
  } catch (error) {
    if (error instanceof GuildSettingsConflictError) {
      await replyPrivate(
        interaction,
        "Server data changed before the operation completed. Nothing was imported or purged.",
      );
      return;
    }
    if (error instanceof TypeError || error instanceof RangeError) {
      await replyPrivate(
        interaction,
        truncateDiscordContent(
          `Data operation was refused safely: ${error.message}`,
        ),
      );
      return;
    }
    throw error;
  }
}

export async function requireConfigurationAdmin(
  interaction: ChatInputCommandInteraction,
): Promise<GuildMember | null> {
  const guild = interaction.guild;
  if (!guild || !interaction.guildId || guild.id !== interaction.guildId) {
    logConfigurationRejection(interaction, "guild-mismatch");
    await replyPrivate(
      interaction,
      "Use configuration commands inside a server.",
    );
    return null;
  }
  const member = await guild.members
    .fetch(interaction.user.id)
    .catch(() => null);
  if (!member || member.guild.id !== guild.id) {
    logConfigurationRejection(interaction, "member-unavailable");
    await replyPrivate(interaction, "Could not verify your server membership.");
    return null;
  }
  if (
    !evaluateGuildManagement({
      guildId: guild.id,
      ownerId: guild.ownerId,
      member,
    }).allowed
  ) {
    logConfigurationRejection(interaction, "permission-denied");
    await replyPrivate(interaction, CONFIG_ADMIN_ERROR);
    return null;
  }
  return member;
}

function logConfigurationRejection(
  interaction: ChatInputCommandInteraction,
  reason: string,
): void {
  const lifecycle = getInteractionLifecycle(interaction);
  if (!lifecycle) return;
  logInfo("authorization", "Configuration operation was rejected", {
    correlationId: lifecycle.correlationId,
    operation: lifecycle.operation,
    guildId: interaction.guildId ?? "dm",
    boundary: "configuration-administrator",
    reason,
    outcome: "rejected",
  });
}

async function showConfigurationStatus(
  interaction: ChatInputCommandInteraction,
  settings: GuildSettings,
): Promise<void> {
  const aliases = summarizeConfigurationValues(settings.invocation.aliases);
  const profiles = summarizeConfigurationValues(
    settings.greetings.map(({ name }) => name),
  );
  await replyPrivate(
    interaction,
    truncateDiscordContent(
      [
        `Enabled: **${settings.enabled ? "yes" : "no"}**`,
        "Core features: **available whenever bot state is enabled**",
        `Timezone: **${escapeMarkdown(settings.timezone)}**`,
        `Log channel: ${settings.channels.log ? `<#${settings.channels.log}>` : "not set"}`,
        `Invocation: **${escapeMarkdown(settings.invocation.keyword)}**; aliases (**${settings.invocation.aliases.length}**): ${aliases}`,
        `Bulk target cap: **${settings.limits.bulkModerationTargetCap}**`,
        `Greeting profiles (**${settings.greetings.length}**): ${profiles}`,
      ].join("\n"),
    ),
  );
}

async function updateChannel(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const action = interaction.options.getString("action", true);
  const next = cloneSettings(runtime.settings);
  if (action === "clear") {
    next.channels.log = null;
  } else if (action === "set") {
    const selected = interaction.options.getChannel("channel", false);
    const guild = interaction.guild;
    const channel =
      selected && guild?.id === runtime.guildId
        ? await guild.channels
            .fetch(selected.id, { force: true })
            .catch(() => null)
        : null;
    if (
      !channel ||
      !interaction.guild ||
      channel.guild?.id !== runtime.guildId ||
      ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(
        channel.type,
      )
    ) {
      await replyPrivate(
        interaction,
        "Choose a text or announcement channel in this server.",
      );
      return;
    }
    const botMember =
      interaction.guild.members.me ??
      (await interaction.guild.members.fetchMe().catch(() => null));
    const permissions = botMember ? channel.permissionsFor(botMember) : null;
    if (
      !permissions?.has(PermissionFlagsBits.ViewChannel) ||
      !permissions.has(PermissionFlagsBits.SendMessages)
    ) {
      await replyPrivate(
        interaction,
        "Superior needs View Channel and Send Messages in that log channel. No configuration was changed.",
      );
      return;
    }
    next.channels.log = channel.id;
  } else {
    await replyPrivate(interaction, "Unknown channel action.");
    return;
  }
  await runtime.saveSettings(next);
  await replyPrivate(
    interaction,
    next.channels.log
      ? "Log channel updated and verified. Other Superior behavior remains active."
      : "Optional log channel cleared. Other Superior behavior remains active.",
  );
}

async function updateTimezone(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const timezone = interaction.options.getString("timezone", true).trim();
  if (!isValidTimezone(timezone)) {
    await replyPrivate(
      interaction,
      "Use a valid IANA timezone, such as `UTC` or `Asia/Amman`.",
    );
    return;
  }
  const next = cloneSettings(runtime.settings);
  next.timezone = timezone;
  await runtime.saveSettings(next);
  await replyPrivate(
    interaction,
    `Timezone set to **${escapeMarkdown(timezone)}**. Other Superior behavior remains active.`,
  );
}

async function updateLimits(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const cap = interaction.options.getInteger("bulk_target_cap", true);
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > 1_000) {
    await replyPrivate(
      interaction,
      "Bulk target cap must be between 1 and 1000.",
    );
    return;
  }
  const next = cloneSettings(runtime.settings);
  next.limits.bulkModerationTargetCap = cap;
  await runtime.saveSettings(next);
  await replyPrivate(
    interaction,
    `Bulk moderation target cap set to **${cap}**. Other Superior behavior remains active.`,
  );
}

async function updateTrigger(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const keyword = normalizeInvocationTerm(
    interaction.options.getString("keyword", true),
  );
  const aliases = Array.from(
    new Set(
      (interaction.options.getString("aliases", false) ?? "")
        .split(",")
        .map(normalizeInvocationTerm)
        .filter(Boolean),
    ),
  ).filter((alias) => alias !== keyword);
  if (
    !isValidInvocationTerm(keyword) ||
    aliases.some((alias) => !isValidInvocationTerm(alias))
  ) {
    await replyPrivate(
      interaction,
      "Invocation terms must be 1-32 letters, numbers, spaces, underscores, or hyphens.",
    );
    return;
  }
  if (aliases.length > 10) {
    await replyPrivate(interaction, "Configure at most 10 invocation aliases.");
    return;
  }
  const next = cloneSettings(runtime.settings);
  next.invocation = { keyword, aliases };
  await runtime.saveSettings(next);
  await replyPrivate(
    interaction,
    "Conversational invocation updated. Other Superior behavior remains active.",
  );
}

async function updateGreeting(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const action = interaction.options.getString("action", true);
  if (action === "list") {
    await replyPrivate(
      interaction,
      formatGreetingProfileList(runtime.settings),
    );
    return;
  }
  const name = normalizeProfileName(
    interaction.options.getString("name", false) ?? "",
  );
  if (!name) {
    await replyPrivate(interaction, "Provide a profile name.");
    return;
  }
  const index = runtime.settings.greetings.findIndex(
    (profile) => profile.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
  );
  const next = cloneSettings(runtime.settings);
  if (action === "remove") {
    if (index < 0) {
      await replyPrivate(interaction, "That greeting profile does not exist.");
      return;
    }
    next.greetings.splice(index, 1);
  } else if (action === "add" || action === "update") {
    const message = (interaction.options.getString("message", false) ?? "")
      .normalize("NFKC")
      .trim();
    if (!message) {
      await replyPrivate(
        interaction,
        "Provide greeting text. Use `{user}` for the current invoker.",
      );
      return;
    }
    if (!isGreetingTemplateWithinDiscordLimit(message)) {
      await replyPrivate(
        interaction,
        "That greeting exceeds Discord's 2,000-character limit after Markdown escaping and `{user}` expansion. Shorten the message.",
      );
      return;
    }
    if (
      /@(?:everyone|here)\b/i.test(message) ||
      /<@(?:!|&)?\d{17,20}>/.test(message)
    ) {
      await replyPrivate(
        interaction,
        "Greeting profiles cannot store Discord or broadcast mentions. Use `{user}` for the current invoker.",
      );
      return;
    }
    if (action === "add" && index >= 0) {
      await replyPrivate(
        interaction,
        "That profile already exists; use update.",
      );
      return;
    }
    if (action === "update" && index < 0) {
      await replyPrivate(interaction, "That profile does not exist; use add.");
      return;
    }
    const profile = { name, message };
    if (index >= 0) next.greetings[index] = profile;
    else next.greetings.push(profile);
  } else {
    await replyPrivate(interaction, "Unknown greeting action.");
    return;
  }
  await runtime.saveSettings(next);
  await replyPrivate(
    interaction,
    `Greeting profile **${escapeMarkdown(name)}** updated. Other Superior behavior remains active.`,
  );
}

async function exportGuild(
  interaction: ChatInputCommandInteraction,
  runtime: BotRuntime,
  guildId: string,
): Promise<void> {
  await deferPrivate(interaction);
  const exported = runtime.storage.exportGuildData(
    guildId,
    undefined,
    GUILD_TRANSFER_MAX_BYTES,
  );
  const serialized = Buffer.from(`${JSON.stringify(exported, null, 2)}\n`);
  if (serialized.byteLength > GUILD_TRANSFER_MAX_BYTES) {
    await replyPrivate(
      interaction,
      "This server's complete export exceeds the 2 MiB safe transfer limit. No partial export was created; use an operator-managed database backup and retention plan.",
    );
    return;
  }
  const attachment = new AttachmentBuilder(serialized, {
    name: `superior-${guildId}-export.json`,
  });
  await interaction.editReply({
    content:
      "Format-7 snapshot for this server only: metadata, settings, metrics, delegated grants, panels, ticket departments/fields/tickets/responses/events, suggestion configuration/suggestions/votes/events, application forms/fields/applications/responses/events, restricted-ping roles/mappings/user cooldowns/events, moderation configuration/cases/events, private reports/events, private appeals/events, anti-spam rules/exemptions/safe enforcement events, and portable delivery identifiers. Live delivery and enforcement leases are excluded.",
    files: [attachment],
    allowedMentions: { parse: [] },
  });
}

async function importGuild(
  interaction: ChatInputCommandInteraction,
  runtime: BotRuntime,
  guildRuntime: GuildRuntime,
  actor: GuildMember,
): Promise<void> {
  if (
    !interaction.guild ||
    actor.guild.id !== guildRuntime.guildId ||
    actor.id !== interaction.guild.ownerId
  ) {
    await replyPrivate(
      interaction,
      "Only the server owner can replace stored guild data from an import.",
    );
    return;
  }
  const confirmation = interaction.options
    .getString("confirmation", true)
    .trim();
  if (confirmation !== `IMPORT ${guildRuntime.guildId}`) {
    await replyPrivate(
      interaction,
      `Confirmation must be \`IMPORT ${guildRuntime.guildId}\`.`,
    );
    return;
  }
  const attachment = interaction.options.getAttachment("file", true);
  if (attachment.size > GUILD_TRANSFER_MAX_BYTES) {
    await replyPrivate(interaction, "Import files are limited to 2 MiB.");
    return;
  }
  await deferPrivate(interaction);
  let response: Response;
  try {
    response = await fetch(attachment.url, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    await replyPrivate(interaction, "Could not download that import file.");
    return;
  }
  if (!response.ok) {
    await replyPrivate(interaction, "Could not download that import file.");
    return;
  }
  let responseText: string | null;
  try {
    responseText = await readBoundedResponseText(
      response,
      GUILD_TRANSFER_MAX_BYTES,
    );
  } catch {
    await replyPrivate(interaction, "Could not read that import file safely.");
    return;
  }
  if (responseText === null) {
    await replyPrivate(interaction, "Import files are limited to 2 MiB.");
    return;
  }
  let payload: GuildDataExport;
  try {
    payload = JSON.parse(responseText) as GuildDataExport;
  } catch {
    await replyPrivate(interaction, "The import file is not valid JSON.");
    return;
  }
  if (!(await verifyCurrentGuildOwner(interaction, guildRuntime, actor))) {
    await replyPrivate(
      interaction,
      "Superior could not confirm that you are still the server owner. No stored data was changed.",
    );
    return;
  }
  runtime.invalidateGuild(guildRuntime.guildId);
  clearAntiSpamProcessState(guildRuntime.guildId);
  runtime.storage.importGuildData(
    guildRuntime.guildId,
    payload,
    guildRuntime.settings,
  );
  await interaction.editReply({
    content:
      "Import replacement completed. Core Superior behavior remains active. Imported authority, moderation destinations, private review bindings, anti-spam rules, restricted-ping roles, and other external workflow bindings remain disabled or unverified; inspect each service and explicitly re-enable only freshly verified resources.",
    allowedMentions: { parse: [] },
  });
}

async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
): Promise<string | null> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

async function purgeGuild(
  interaction: ChatInputCommandInteraction,
  runtime: BotRuntime,
  guildRuntime: GuildRuntime,
  actor: GuildMember,
): Promise<void> {
  if (
    actor.guild.id !== guildRuntime.guildId ||
    interaction.guild?.id !== guildRuntime.guildId ||
    actor.id !== interaction.guild.ownerId
  ) {
    await replyPrivate(
      interaction,
      "Only the server owner can permanently purge this server's stored data.",
    );
    return;
  }
  const confirmation = interaction.options
    .getString("confirmation", true)
    .trim();
  if (confirmation !== `PURGE ${guildRuntime.guildId}`) {
    await replyPrivate(
      interaction,
      `Confirmation must be \`PURGE ${guildRuntime.guildId}\`.`,
    );
    return;
  }
  await deferPrivate(interaction);
  if (!(await verifyCurrentGuildOwner(interaction, guildRuntime, actor))) {
    await replyPrivate(
      interaction,
      "Superior could not confirm that you are still the server owner. No stored data was changed.",
    );
    return;
  }
  runtime.invalidateGuild(guildRuntime.guildId);
  await runtime.storage.purgeGuildData(guildRuntime.guildId);
  clearBackfillStatus(guildRuntime.guildId);
  clearModerationProcessState(guildRuntime.guildId);
  clearPanelProcessState(guildRuntime.guildId);
  clearAntiSpamProcessState(guildRuntime.guildId);
  await interaction.editReply({
    content:
      "All of this server's stored configuration, moderation and safety workflows, metrics, cooldowns, delivery records, and audit events were permanently purged.",
    allowedMentions: { parse: [] },
  });
}

async function verifyCurrentGuildOwner(
  interaction: ChatInputCommandInteraction,
  guildRuntime: GuildRuntime,
  actor: GuildMember,
): Promise<boolean> {
  if (
    !interaction.guild ||
    interaction.guildId !== guildRuntime.guildId ||
    interaction.guild.id !== guildRuntime.guildId ||
    actor.guild.id !== guildRuntime.guildId
  ) {
    return false;
  }
  try {
    const refreshedGuild = await interaction.client.guilds.fetch({
      guild: guildRuntime.guildId,
      cache: false,
      force: true,
    });
    return (
      refreshedGuild.id === guildRuntime.guildId &&
      refreshedGuild.ownerId === actor.id
    );
  } catch {
    return false;
  }
}

export async function validateGuildConfiguration(
  interaction: ChatInputCommandInteraction,
  settings: GuildSettings,
): Promise<GuildConfigurationValidationResult> {
  const errors: string[] = [];
  const guild = interaction.guild;
  if (!guild || !interaction.guildId) {
    return {
      valid: false,
      errors: ["Configuration checks must run inside a server."],
    };
  }
  if (!isValidTimezone(settings.timezone)) errors.push("Timezone is invalid.");
  if (!isValidInvocationTerm(settings.invocation.keyword)) {
    errors.push("Primary invocation is invalid.");
  }
  if (
    settings.limits.bulkModerationTargetCap < 1 ||
    settings.limits.bulkModerationTargetCap > 1_000
  ) {
    errors.push("Bulk moderation target cap must be between 1 and 1000.");
  }
  if (settings.greetings.length === 0) {
    errors.push("At least one greeting profile is required.");
  }
  if (settings.channels.log) {
    const channel = await guild.channels
      .fetch(settings.channels.log)
      .catch(() => null);
    if (!channel || channel.guild.id !== guild.id || !channel.isTextBased()) {
      errors.push("The configured log channel is unavailable.");
    } else {
      const botMember =
        guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
      const permissions = botMember ? channel.permissionsFor(botMember) : null;
      if (
        !permissions?.has(PermissionFlagsBits.ViewChannel) ||
        !permissions.has(PermissionFlagsBits.SendMessages)
      ) {
        errors.push(
          "Superior cannot view and send messages in the configured log channel.",
        );
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

function cloneSettings(settings: GuildSettings): GuildSettings {
  return structuredClone(settings);
}

function isValidTimezone(timezone: string): boolean {
  return DateTime.now().setZone(timezone).isValid;
}

function normalizeInvocationTerm(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/g, " ");
}

function isValidInvocationTerm(value: string): boolean {
  return (
    value.length >= 1 && value.length <= 32 && /^[\p{L}\p{N}_ -]+$/u.test(value)
  );
}

function normalizeProfileName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function summarizeConfigurationValues(values: string[]): string {
  if (values.length === 0) return "none";
  const visible = values
    .slice(0, CONFIG_SUMMARY_ITEM_LIMIT)
    .map((value) =>
      formatConfigurationPreview(value, CONFIG_SUMMARY_ITEM_LENGTH),
    );
  const omitted = values.length - visible.length;
  return `${visible.join(", ")}${omitted > 0 ? `, … (+${omitted} more)` : ""}`;
}

function formatGreetingProfileList(settings: GuildSettings): string {
  if (settings.greetings.length === 0) {
    return "No greeting profiles are configured.";
  }
  const visible = settings.greetings.slice(0, GREETING_LIST_ITEM_LIMIT);
  const lines = visible.map(
    ({ name, message }) =>
      `- **${formatConfigurationPreview(name, CONFIG_SUMMARY_ITEM_LENGTH)}**: ${formatConfigurationPreview(message, GREETING_LIST_MESSAGE_PREVIEW_LENGTH)}`,
  );
  const omitted = settings.greetings.length - visible.length;
  return truncateDiscordContent(
    [
      `Greeting profiles (**${settings.greetings.length}** configured):`,
      ...lines,
      omitted > 0
        ? `… **${omitted}** more omitted. Use \`/data export\` to review every complete profile.`
        : null,
    ]
      .filter((line): line is string => line !== null)
      .join("\n"),
  );
}

function formatConfigurationPreview(value: string, limit: number): string {
  return truncateDiscordContent(
    escapeMarkdown(value.replace(/\s+/g, " ").trim()),
    limit,
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
