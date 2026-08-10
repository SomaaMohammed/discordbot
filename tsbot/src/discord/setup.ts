import {
  AttachmentBuilder,
  ChannelType,
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
import type { BotRuntime, GuildRuntime } from "../runtime.js";
import { GuildSettingsConflictError } from "../storage/db.js";
import type { GuildDataExport, GuildSettings } from "../types.js";
import { clearBackfillStatus } from "./activity.js";
import { clearModerationProcessState } from "./moderation.js";
import { clearPanelProcessState } from "./panels.js";
import { evaluateGuildManagement } from "./ticket-authorization.js";

const SETUP_ADMIN_ERROR =
  "Only the server owner or a member with Administrator permission can use setup.";
const GUILD_TRANSFER_MAX_BYTES = 2 * 1024 * 1024;
const SETUP_SUMMARY_ITEM_LIMIT = 5;
const SETUP_SUMMARY_ITEM_LENGTH = 80;
const GREETING_LIST_ITEM_LIMIT = 6;
const GREETING_LIST_MESSAGE_PREVIEW_LENGTH = 180;

const FEATURE_CHOICES: Array<{
  name: string;
  value: keyof GuildSettings["features"];
}> = [
  { name: "chat", value: "chat" },
  { name: "reply-moderation", value: "replyModeration" },
  { name: "greetings", value: "greetings" },
  { name: "activity-metrics", value: "activityMetrics" },
];

const DEFAULT_GREETING_PROFILE: GuildSettings["greetings"][number] = {
  name: "Welcome",
  message: "Welcome, {user}!",
};

export function getFeatureDisplayName(
  feature: keyof GuildSettings["features"],
): string {
  return (
    FEATURE_CHOICES.find(({ value }) => value === feature)?.name ?? feature
  );
}

export interface GuildSetupValidationResult {
  valid: boolean;
  errors: string[];
}

export function buildSetupCommandDefinition(): SlashCommandSubcommandsOnlyBuilder {
  return new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Configure Superior for this server")
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("status")
        .setDescription("Show the active configuration"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("enable")
        .setDescription("Validate, approve, and enable this server"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("enable-all")
        .setDescription("Enable every feature and approve this server"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("disable")
        .setDescription("Disable bot behavior safely"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("channel")
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
        .setName("feature")
        .setDescription("Enable or disable one feature")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("Feature name")
            .setRequired(true)
            .addChoices(...FEATURE_CHOICES),
        )
        .addBooleanOption((option) =>
          option
            .setName("enabled")
            .setDescription("Whether the feature is enabled")
            .setRequired(true),
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
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("validate")
        .setDescription("Validate the active configuration without enabling"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("export")
        .setDescription("Export this server's active data as bounded JSON"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("import")
        .setDescription(
          "Owner-only replacement from a same-server v2, v3, v4, or v5 export",
        )
        .addAttachmentOption((option) =>
          option
            .setName("file")
            .setDescription("JSON file created by /setup export")
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

export async function handleSetupCommand(
  interaction: ChatInputCommandInteraction,
  runtime: BotRuntime,
  guildRuntime: GuildRuntime,
  authorizedActor?: GuildMember,
): Promise<void> {
  const actor = authorizedActor ?? (await requireSetupAdmin(interaction));
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
        await showSetupStatus(interaction, guildRuntime.settings);
        return;
      case "enable":
        await enableGuild(interaction, guildRuntime);
        return;
      case "enable-all":
        await enableAllFeatures(interaction, guildRuntime);
        return;
      case "disable":
        await guildRuntime.setEnabled(false);
        await replyPrivate(
          interaction,
          "Superior is disabled. Stored active data was retained.",
        );
        return;
      case "channel":
        await updateChannel(interaction, guildRuntime);
        return;
      case "feature":
        await updateFeature(interaction, guildRuntime);
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
      case "validate":
        await replyWithValidation(interaction, guildRuntime.settings);
        return;
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
        await replyPrivate(interaction, "Unknown setup operation.");
    }
  } catch (error) {
    if (error instanceof GuildSettingsConflictError) {
      await replyPrivate(
        interaction,
        "This server's configuration changed during setup. Review the latest settings and try again.",
      );
      return;
    }
    if (error instanceof TypeError || error instanceof RangeError) {
      await replyPrivate(
        interaction,
        truncateDiscordContent(
          `Setup operation was refused safely: ${error.message}`,
        ),
      );
      return;
    }
    throw error;
  }
}

export async function requireSetupAdmin(
  interaction: ChatInputCommandInteraction,
): Promise<GuildMember | null> {
  const guild = interaction.guild;
  if (!guild || !interaction.guildId || guild.id !== interaction.guildId) {
    await replyPrivate(interaction, "Use setup inside a server.");
    return null;
  }
  const member = await guild.members
    .fetch(interaction.user.id)
    .catch(() => null);
  if (!member || member.guild.id !== guild.id) {
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
    await replyPrivate(interaction, SETUP_ADMIN_ERROR);
    return null;
  }
  return member;
}

async function showSetupStatus(
  interaction: ChatInputCommandInteraction,
  settings: GuildSettings,
): Promise<void> {
  const features = Object.entries(settings.features)
    .map(([name, enabled]) => `${name}: ${enabled ? "on" : "off"}`)
    .join(", ");
  const aliases = summarizeSetupValues(settings.invocation.aliases);
  const profiles = summarizeSetupValues(
    settings.greetings.map(({ name }) => name),
  );
  await replyPrivate(
    interaction,
    truncateDiscordContent(
      [
        `Enabled: **${settings.enabled ? "yes" : "no"}**`,
        `Review required: **${settings.reviewRequired ? "yes" : "no"}**`,
        `Timezone: **${escapeMarkdown(settings.timezone)}**`,
        `Features: ${features}`,
        `Log channel: ${settings.channels.log ? `<#${settings.channels.log}>` : "not set"}`,
        `Invocation: **${escapeMarkdown(settings.invocation.keyword)}**; aliases (**${settings.invocation.aliases.length}**): ${aliases}`,
        `Bulk target cap: **${settings.limits.bulkModerationTargetCap}**`,
        `Greeting profiles (**${settings.greetings.length}**): ${profiles}`,
      ].join("\n"),
    ),
  );
}

async function enableGuild(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  await deferPrivate(interaction);
  const result = await validateGuildSetup(interaction, runtime.settings);
  if (!result.valid) {
    await replyPrivate(
      interaction,
      `Superior remains disabled:\n${result.errors.map((error) => `- ${error}`).join("\n")}`,
    );
    return;
  }
  await runtime.setEnabled(true);
  await replyPrivate(
    interaction,
    "Configuration approved and Superior enabled for this server.",
  );
}

async function enableAllFeatures(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  await deferPrivate(interaction);
  const next = cloneSettings(runtime.settings);
  for (const { value } of FEATURE_CHOICES) {
    next.features[value] = true;
  }
  const addedDefaultGreeting = next.greetings.length === 0;
  if (addedDefaultGreeting) {
    next.greetings.push({ ...DEFAULT_GREETING_PROFILE });
  }
  const result = await validateGuildSetup(interaction, next);
  if (!result.valid) {
    await replyPrivate(
      interaction,
      `Nothing changed because enabling every feature requires:\n${result.errors.map((error) => `- ${error}`).join("\n")}`,
    );
    return;
  }
  await runtime.saveSettings(next);
  await runtime.setEnabled(true);
  await replyPrivate(
    interaction,
    addedDefaultGreeting
      ? "All features and commands are enabled for this server. Added the default **Welcome** greeting profile."
      : "All features and commands are enabled for this server. Existing greeting profiles were preserved.",
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
    const channel = selected
      ? interaction.guild?.channels.cache.get(selected.id)
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
    next.channels.log = channel.id;
  } else {
    await replyPrivate(interaction, "Unknown channel action.");
    return;
  }
  next.reviewRequired = true;
  next.enabled = false;
  await runtime.saveSettings(next);
  await replyPrivate(
    interaction,
    "Log channel updated. Review with `/setup validate`, then run `/setup enable`.",
  );
}

async function updateFeature(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const name = interaction.options.getString(
    "name",
    true,
  ) as keyof GuildSettings["features"];
  const enabled = interaction.options.getBoolean("enabled", true);
  if (!FEATURE_CHOICES.some(({ value }) => value === name)) {
    await replyPrivate(interaction, "Unknown feature.");
    return;
  }
  const next = cloneSettings(runtime.settings);
  next.features[name] = enabled;
  next.reviewRequired = true;
  next.enabled = false;
  await runtime.saveSettings(next);
  await replyPrivate(
    interaction,
    `${getFeatureDisplayName(name)} is now ${enabled ? "on" : "off"}. Revalidate before enabling.`,
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
    `Timezone set to **${escapeMarkdown(timezone)}**. Review and re-enable Superior.`,
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
    `Bulk moderation target cap set to **${cap}**. Review and re-enable Superior.`,
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
    "Conversational invocation updated. Review and re-enable Superior.",
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
    `Greeting profile **${escapeMarkdown(name)}** updated. Review and re-enable Superior.`,
  );
}

async function replyWithValidation(
  interaction: ChatInputCommandInteraction,
  settings: GuildSettings,
): Promise<void> {
  await deferPrivate(interaction);
  const result = await validateGuildSetup(interaction, settings);
  await replyPrivate(
    interaction,
    result.valid
      ? "Configuration is valid. Run `/setup enable` to approve and enable it."
      : `Configuration needs attention:\n${result.errors.map((error) => `- ${error}`).join("\n")}`,
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
      "Format-5 snapshot for this server only: metadata, settings, metrics, delegated grants, panels, ticket departments/fields/tickets/responses/events, suggestion configuration/suggestions/votes/events, application forms/fields/applications/responses/events, restricted-ping roles/mappings/user cooldowns/events, and delivery identifiers. Live restricted-ping reservations are excluded.",
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
  runtime.storage.importGuildData(
    guildRuntime.guildId,
    payload,
    guildRuntime.settings,
  );
  await interaction.editReply({
    content:
      "Import replacement completed in disabled review mode. Imported authority and workflow bindings, including restricted-ping roles, remain disabled/unverified. Review `/setup status`, run `/setup validate` and `/setup enable`, then inspect `/panel status`, `/ticket status`, `/suggestion status`, `/application status`, `/restrictedping list`, and `/restrictedping info`; explicitly re-enable only reviewed workflows and restricted roles.",
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
  await interaction.editReply({
    content:
      "All of this server's stored configuration, workflow data, metrics, restricted-ping cooldowns, and audit events were permanently purged.",
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

export async function validateGuildSetup(
  interaction: ChatInputCommandInteraction,
  settings: GuildSettings,
): Promise<GuildSetupValidationResult> {
  const errors: string[] = [];
  const guild = interaction.guild;
  if (!guild || !interaction.guildId) {
    return { valid: false, errors: ["Setup must run inside a server."] };
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
  if (settings.features.greetings && settings.greetings.length === 0) {
    errors.push("Greetings are enabled but no greeting profile exists.");
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

function summarizeSetupValues(values: string[]): string {
  if (values.length === 0) return "none";
  const visible = values
    .slice(0, SETUP_SUMMARY_ITEM_LIMIT)
    .map((value) => formatSetupPreview(value, SETUP_SUMMARY_ITEM_LENGTH));
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
      `- **${formatSetupPreview(name, SETUP_SUMMARY_ITEM_LENGTH)}**: ${formatSetupPreview(message, GREETING_LIST_MESSAGE_PREVIEW_LENGTH)}`,
  );
  const omitted = settings.greetings.length - visible.length;
  return truncateDiscordContent(
    [
      `Greeting profiles (**${settings.greetings.length}** configured):`,
      ...lines,
      omitted > 0
        ? `… **${omitted}** more omitted. Use \`/setup export\` to review every complete profile.`
        : null,
    ]
      .filter((line): line is string => line !== null)
      .join("\n"),
  );
}

function formatSetupPreview(value: string, limit: number): string {
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
