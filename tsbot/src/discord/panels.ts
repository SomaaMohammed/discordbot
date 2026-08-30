import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type GuildTextBasedChannel,
  type ModalSubmitInteraction,
  type Role,
} from "discord.js";
import { classifyError } from "../errors.js";
import type { GuildRuntime } from "../runtime.js";
import { logDomainOutcome } from "./domain-outcomes.js";
import { createSuperiorEmbed } from "./panel-theme.js";

export const ROLE_BUTTON_PREFIX = "superior:role:";
export const DM_BUTTON_PREFIX = "superior:dm:";
export const DM_MODAL_PREFIX = "superior:dm-modal:";
const DM_INPUT_ID = "message";
const MAX_PANEL_ROLES = 5;
const DM_PANEL_COOLDOWN_MS = 60_000;
const MAX_DM_PANEL_COOLDOWNS = 10_000;
const dmPanelCooldowns = new Map<string, number>();

export function clearPanelProcessState(guildId: string): void {
  const prefix = `${guildId}:`;
  for (const key of dmPanelCooldowns.keys()) {
    if (key.startsWith(prefix)) dmPanelCooldowns.delete(key);
  }
}
const SAFE_ROLE_PERMISSION_MASK = [
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.ChangeNickname,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.RequestToSpeak,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.SendPolls,
  PermissionFlagsBits.SendVoiceMessages,
  PermissionFlagsBits.Speak,
  PermissionFlagsBits.Stream,
  PermissionFlagsBits.UseApplicationCommands,
  PermissionFlagsBits.UseEmbeddedActivities,
  PermissionFlagsBits.UseExternalApps,
  PermissionFlagsBits.UseExternalEmojis,
  PermissionFlagsBits.UseExternalSounds,
  PermissionFlagsBits.UseExternalStickers,
  PermissionFlagsBits.UseSoundboard,
  PermissionFlagsBits.UseVAD,
  PermissionFlagsBits.ViewChannel,
].reduce((mask, permission) => mask | permission, 0n);

export const PANEL_SUBCOMMANDS = new Set([
  "announce",
  "say",
  "dmpanel",
  "role-button",
  "role-buttons",
  "rolepanel",
  "rolepanelmulti",
]);

export async function handlePanelCommand(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
): Promise<boolean> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
  switch (interaction.options.getSubcommand()) {
    case "announce":
    case "say":
      await handleSay(interaction, runtime, actor);
      return true;
    case "dmpanel":
      await handleDmPanel(interaction, runtime, actor);
      return true;
    case "role-button":
    case "rolepanel":
      await handleRolePanel(interaction, runtime, actor, false);
      return true;
    case "role-buttons":
    case "rolepanelmulti":
      await handleRolePanel(interaction, runtime, actor, true);
      return true;
    default:
      return false;
  }
}

export async function handlePanelButton(
  interaction: ButtonInteraction,
  runtime: GuildRuntime,
): Promise<boolean> {
  const parsed = parsePersistentPanelButtonId(interaction.customId);
  if (parsed?.kind === "role") {
    await handleRoleButton(interaction, runtime);
    return true;
  }
  if (parsed?.kind === "private-message") {
    await handleDmButton(interaction, runtime);
    return true;
  }
  return false;
}

export type ParsedPersistentPanelButton =
  | { kind: "role"; roleId: string }
  | { kind: "private-message"; targetId: string };

/** Stable router contract for Discord messages posted by earlier releases. */
export function parsePersistentPanelButtonId(
  customId: string,
): ParsedPersistentPanelButton | null {
  if (customId.startsWith(ROLE_BUTTON_PREFIX)) {
    const roleId = parseId(customId, ROLE_BUTTON_PREFIX);
    return roleId ? { kind: "role", roleId } : null;
  }
  if (customId.startsWith(DM_BUTTON_PREFIX)) {
    const targetId = parseId(customId, DM_BUTTON_PREFIX);
    return targetId ? { kind: "private-message", targetId } : null;
  }
  return null;
}

export async function handlePanelModal(
  interaction: ModalSubmitInteraction,
  runtime: GuildRuntime,
): Promise<boolean> {
  if (!interaction.customId.startsWith(DM_MODAL_PREFIX)) return false;
  const modalTarget = parseDmModalId(interaction.customId);
  if (!modalTarget || interaction.guild?.id !== runtime.guildId) {
    await replyPrivate(
      interaction,
      "This panel is outdated or does not belong to this server.",
    );
    return true;
  }
  const content = interaction.fields
    .getTextInputValue(DM_INPUT_ID)
    .normalize("NFKC")
    .trim();
  if (!content) {
    await replyPrivate(interaction, "Message text cannot be empty.");
    return true;
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server was disabled or reconfigured. Please try again.",
    );
    return true;
  }
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
  const guild = interaction.guild;
  const [sender, target] = await Promise.all([
    guild.members.fetch(interaction.user.id).catch(() => null),
    guild.members.fetch(modalTarget.targetId).catch(() => null),
  ]);
  if (!sender || sender.guild.id !== runtime.guildId) {
    await replyPrivate(
      interaction,
      "Superior could not verify your current server membership. No private message was sent.",
    );
    return true;
  }
  if (!target || target.guild.id !== runtime.guildId || target.user.bot) {
    await replyPrivate(
      interaction,
      "The member configured as this panel's recipient has left or was deleted. Ask an administrator to replace the panel recipient.",
    );
    return true;
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server was disabled or reconfigured. Please try again.",
    );
    return true;
  }
  const cooldownKey = `${runtime.guildId}:${modalTarget.panelId}:${sender.id}`;
  const now = Date.now();
  const remaining = claimDmPanelCooldown(cooldownKey, now);
  if (remaining > 0) {
    logDomainOutcome(
      "panel",
      "private-message-delivery",
      runtime.guildId,
      "rejected-cooldown",
      { recordId: modalTarget.panelId },
    );
    await replyPrivate(
      interaction,
      `Please wait **${remaining} seconds** before using this private-message panel again.`,
    );
    return true;
  }
  try {
    const header = [
      `Private panel message from **${escapeMarkdown(interaction.user.tag)}**`,
      `Server: **${escapeMarkdown(interaction.guild?.name ?? "Unknown server")}**`,
      "",
    ].join("\n");
    const body = escapeMarkdown(content).slice(
      0,
      Math.max(0, 2_000 - header.length - 1),
    );
    await target.send({
      content: `${header}\n${body}`,
      allowedMentions: { parse: [] },
    });
  } catch {
    logDomainOutcome(
      "panel",
      "private-message-delivery",
      runtime.guildId,
      "failed-discord-delivery",
      { recordId: modalTarget.panelId },
    );
    await replyPrivate(
      interaction,
      "Discord blocked delivery to the configured recipient (their direct messages may be closed). No private message was sent.",
    );
    return true;
  }
  await replyPrivate(interaction, "Your private message was delivered.");
  runtime.storage.recordCommandMetric("panel.dmpanel.message");
  logDomainOutcome(
    "panel",
    "private-message-delivery",
    runtime.guildId,
    "delivered",
    { recordId: modalTarget.panelId },
  );
  return true;
}

async function handleSay(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
): Promise<void> {
  const channel = await getTargetChannel(interaction, runtime, "channel", true);
  if (!channel) return;
  const content = interaction.options
    .getString("message", true)
    .normalize("NFKC")
    .trim();
  if (!content) {
    await replyPrivate(interaction, "Announcement text cannot be empty.");
    return;
  }
  const mentionEveryone =
    interaction.options.getBoolean("mention_everyone", false) ?? false;
  const botMember = await getBotMember(interaction, runtime);
  if (!botMember) return;
  const channelPermissions = channel.permissionsFor(botMember);
  const sendPermission = getChannelSendPermission(channel);
  if (
    !channelPermissions?.has(PermissionFlagsBits.ViewChannel) ||
    !channelPermissions.has(sendPermission)
  ) {
    await replyPrivate(
      interaction,
      "Superior cannot view and send messages in that channel.",
    );
    return;
  }
  if (
    mentionEveryone &&
    !channelPermissions.has(PermissionFlagsBits.MentionEveryone)
  ) {
    await replyPrivate(
      interaction,
      "Superior lacks Mention Everyone in that channel.",
    );
    return;
  }
  if (actor.guild.id !== runtime.guildId || !runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server was disabled or reconfigured. Please try again.",
    );
    return;
  }
  await channel.send({
    content: `${mentionEveryone ? "@everyone\n" : ""}${content}`.slice(
      0,
      2_000,
    ),
    allowedMentions: mentionEveryone ? { parse: ["everyone"] } : { parse: [] },
  });
  await replyPrivate(interaction, `Announcement sent to <#${channel.id}>.`);
  runtime.storage.recordCommandMetric("channel.announce");
  logDomainOutcome(
    "panel",
    "announcement-delivery",
    runtime.guildId,
    "delivered",
    {
      channelId: channel.id,
      state: mentionEveryone
        ? "everyone-mention-authorized"
        : "mentions-suppressed",
    },
  );
}

async function handleDmPanel(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
): Promise<void> {
  const channel = await getCurrentPanelChannel(interaction, runtime);
  if (!channel) return;
  const target = interaction.options.getUser("target", false) ?? actor.user;
  if (target.bot) {
    await replyPrivate(
      interaction,
      "Choose a human recipient for the private-message panel.",
    );
    return;
  }
  const botMember = await getBotMember(interaction, runtime);
  if (!botMember || !canSendPanelToChannel(channel, botMember)) {
    await replyPrivate(
      interaction,
      "Superior cannot send a panel in that channel.",
    );
    return;
  }
  const title = safeLabel(
    interaction.options.getString("title", false),
    "Private message",
    256,
  );
  const description = safeLabel(
    interaction.options.getString("description", false),
    "Use the button below to send a private message to the panel recipient.",
    4_096,
  );
  const buttonLabel = safeLabel(
    interaction.options.getString("button_label", false),
    "Send private message",
    80,
  );
  const embed = createSuperiorEmbed("Private message")
    .setTitle(escapeMarkdown(title).slice(0, 256))
    .setDescription(escapeMarkdown(description).slice(0, 4_096))
    .setFooter({
      text: "How to use: Click the button and complete the private-message form.",
    });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${DM_BUTTON_PREFIX}${target.id}`)
      .setLabel(buttonLabel)
      .setStyle(ButtonStyle.Primary),
  );
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server was disabled or reconfigured. Please try again.",
    );
    return;
  }
  await channel.send({
    embeds: [embed],
    components: [row],
    allowedMentions: { parse: [] },
  });
  await replyPrivate(
    interaction,
    `Private-message panel posted in <#${channel.id}>.`,
  );
  runtime.storage.recordCommandMetric("panel.dmpanel");
  logDomainOutcome(
    "panel",
    "private-message-panel-post",
    runtime.guildId,
    "delivered",
    { channelId: channel.id },
  );
}

async function handleRolePanel(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
  multiple: boolean,
): Promise<void> {
  const channel = await getCurrentPanelChannel(interaction, runtime);
  if (!channel) return;
  const roles = multiple
    ? [1, 2, 3, 4, 5]
        .map(
          (slot) =>
            interaction.options.getRole(
              `role_${slot}`,
              slot <= 2,
            ) as Role | null,
        )
        .filter((role): role is Role => role !== null)
    : [interaction.options.getRole("role", true) as Role];
  const uniqueRoles = [
    ...new Map(roles.map((role) => [role.id, role])).values(),
  ].slice(0, MAX_PANEL_ROLES);
  const botMember = await getBotMember(interaction, runtime);
  if (!botMember) return;
  const errors = uniqueRoles
    .map((role) =>
      getRolePanelSafetyError(role, actor, botMember, runtime.guildId),
    )
    .filter((error): error is string => error !== null);
  if (errors.length > 0 || uniqueRoles.length !== roles.length) {
    await replyPrivate(
      interaction,
      errors[0] ?? "Each role button must refer to a unique server role.",
    );
    return;
  }
  if (!canSendPanelToChannel(channel, botMember)) {
    await replyPrivate(
      interaction,
      "Superior cannot send a role panel in that channel.",
    );
    return;
  }
  const title = safeLabel(
    interaction.options.getString("title", false),
    "Choose your roles",
    256,
  );
  const description = safeLabel(
    interaction.options.getString("description", false),
    "Use a button to add or remove a role.",
    4_096,
  );
  const singleLabel = safeLabel(
    interaction.options.getString("button_label", false),
    uniqueRoles[0]?.name ?? "Toggle role",
    80,
  );
  const components = uniqueRoles.map((role, index) =>
    new ButtonBuilder()
      .setCustomId(`${ROLE_BUTTON_PREFIX}${role.id}`)
      .setLabel(multiple ? role.name.slice(0, 80) : singleLabel)
      .setStyle(index % 2 === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary),
  );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(components);
  const embed = createSuperiorEmbed("Role")
    .setTitle(escapeMarkdown(title).slice(0, 256))
    .setDescription(escapeMarkdown(description).slice(0, 4_096))
    .setFooter({
      text: "How to use: Click a role button to add or remove that role.",
    });
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server was disabled or reconfigured. Please try again.",
    );
    return;
  }
  await channel.send({
    embeds: [embed],
    components: [row],
    allowedMentions: { parse: [] },
  });
  await replyPrivate(interaction, `Role panel posted in <#${channel.id}>.`);
  runtime.storage.recordCommandMetric(
    `panel.${multiple ? "role-buttons" : "role-button"}`,
  );
  logDomainOutcome("panel", "role-panel-post", runtime.guildId, "delivered", {
    channelId: channel.id,
    totalCount: uniqueRoles.length,
    state: multiple ? "multi-role" : "single-role",
  });
}

async function handleRoleButton(
  interaction: ButtonInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const roleId = parseId(interaction.customId, ROLE_BUTTON_PREFIX);
  const guild = interaction.guild;
  if (
    !roleId ||
    !guild ||
    guild.id !== runtime.guildId ||
    interaction.message.author?.id !== interaction.client.user?.id
  ) {
    await replyPrivate(
      interaction,
      "This role panel is outdated or unsupported. Ask an administrator to post it again.",
    );
    return;
  }
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
  const [member, botMember, role] = await Promise.all([
    guild.members.fetch(interaction.user.id).catch(() => null),
    Promise.resolve(
      guild.members.me ?? guild.members.fetchMe().catch(() => null),
    ),
    guild.roles.fetch(roleId).catch(() => null),
  ]);
  if (!member) {
    await replyPrivate(
      interaction,
      "Superior could not verify your current server membership. No role was changed.",
    );
    return;
  }
  if (!botMember) {
    await replyPrivate(
      interaction,
      "Superior could not verify its current server permissions. Ask an administrator to check the bot's membership.",
    );
    return;
  }
  if (!role) {
    await replyPrivate(
      interaction,
      "The role configured on this panel was deleted or is no longer in this server. Ask an administrator to replace it with an existing safe role.",
    );
    return;
  }
  const issue = getRolePanelSafetyError(role, null, botMember, runtime.guildId);
  if (issue) {
    await replyPrivate(interaction, issue);
    return;
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server was disabled or reconfigured. Please try again.",
    );
    return;
  }
  const removing = member.roles.cache.has(role.id);
  try {
    if (removing) await member.roles.remove(role, "Self-service role panel");
    else await member.roles.add(role, "Self-service role panel");
  } catch (error) {
    const classified = classifyError(error);
    logDomainOutcome(
      "panel",
      removing ? "role-remove" : "role-add",
      runtime.guildId,
      `failed-${classified.category}`,
      { recordId: role.id },
    );
    const recovery =
      classified.category === "discord-access"
        ? "Discord refused the role change because Superior no longer has Manage Roles or its highest role is not above this role. Restore the permission and role hierarchy, then try again."
        : classified.category === "discord-resource"
          ? "The role was deleted while Superior was applying the change. Ask an administrator to replace this panel with an existing safe role."
          : "Discord rejected that role change. Ask an administrator to verify Superior's Manage Roles permission and role hierarchy, then try again.";
    await replyPrivate(interaction, recovery);
    return;
  }
  await replyPrivate(
    interaction,
    `${removing ? "Removed" : "Added"} **${escapeMarkdown(role.name)}**.`,
  );
  runtime.storage.recordCommandMetric("panel.role-button.click");
  logDomainOutcome(
    "panel",
    removing ? "role-remove" : "role-add",
    runtime.guildId,
    "completed",
    { recordId: role.id },
  );
}

async function handleDmButton(
  interaction: ButtonInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const targetId = parseId(interaction.customId, DM_BUTTON_PREFIX);
  if (
    !targetId ||
    interaction.guild?.id !== runtime.guildId ||
    interaction.message.author?.id !== interaction.client.user?.id ||
    !runtime.isCurrent()
  ) {
    await replyPrivate(
      interaction,
      "This private-message panel is outdated or unsupported. Ask an administrator to post it again.",
    );
    return;
  }
  const modal = createPrivateMessagePanelModal(
    targetId,
    interaction.message.id,
  );
  await interaction.showModal(modal);
}

export function createPrivateMessagePanelModal(
  targetId: string,
  panelMessageId: string,
): ModalBuilder {
  if (!/^\d{17,20}$/.test(targetId) || !/^\d{17,20}$/.test(panelMessageId)) {
    throw new TypeError("Private-message panel identifiers are invalid.");
  }
  return new ModalBuilder()
    .setCustomId(`${DM_MODAL_PREFIX}${targetId}:${panelMessageId}`)
    .setTitle("Send a private message")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(DM_INPUT_ID)
          .setLabel("Message")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1_800),
      ),
    );
}

export function getRolePanelSafetyError(
  role: Role,
  actor: GuildMember | null,
  botMember: GuildMember,
  guildId: string,
): string | null {
  if (role.guild.id !== guildId)
    return "That role does not belong to this server.";
  if (role.id === guildId) return "The @everyone role cannot be self-assigned.";
  if (role.managed)
    return "Managed integration roles cannot be used in a role panel.";
  if ((role.permissions.bitfield & ~SAFE_ROLE_PERMISSION_MASK) !== 0n) {
    return "Roles with permissions outside the safe self-service allowlist cannot be self-assigned.";
  }
  for (const channel of role.guild.channels.cache.values()) {
    if (!("permissionOverwrites" in channel)) continue;
    const overwrite = channel.permissionOverwrites.cache.get(role.id);
    if (overwrite && overwrite.allow.bitfield !== 0n) {
      return "Roles with sensitive channel permission overrides cannot be self-assigned.";
    }
  }
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return "Superior needs Manage Roles to operate this panel.";
  }
  if (botMember.roles.highest.comparePositionTo(role) <= 0) {
    return "Superior's highest role must be above every panel role.";
  }
  if (
    actor &&
    actor.id !== role.guild.ownerId &&
    actor.roles.highest.comparePositionTo(role) <= 0
  ) {
    return "Your highest role must be above every panel role.";
  }
  return null;
}

async function getTargetChannel(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  optionName: string,
  required: boolean,
): Promise<GuildTextBasedChannel | null> {
  const selected = interaction.options.getChannel(optionName, required);
  const rawChannel: unknown = selected ?? interaction.channel;
  const channel = rawChannel as GuildTextBasedChannel | null;
  if (
    !channel ||
    typeof channel.isDMBased !== "function" ||
    typeof channel.isTextBased !== "function" ||
    channel.isDMBased() ||
    !channel.isTextBased() ||
    !("send" in channel) ||
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

/** Resolves a persistent panel's destination strictly from this interaction. */
async function getCurrentPanelChannel(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<GuildTextBasedChannel | null> {
  const channel = interaction.channel as GuildTextBasedChannel | null;
  if (
    !channel ||
    typeof channel.isDMBased !== "function" ||
    typeof channel.isTextBased !== "function" ||
    channel.isDMBased() ||
    !channel.isTextBased() ||
    !("send" in channel) ||
    channel.guild.id !== runtime.guildId ||
    interaction.guild?.id !== runtime.guildId
  ) {
    await replyPrivate(
      interaction,
      "Use this command in a text-based channel in this server.",
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
  const botMember =
    guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!botMember) {
    await replyPrivate(
      interaction,
      "Could not verify Superior's server permissions.",
    );
    return null;
  }
  return botMember;
}

export function canSendPanelToChannel(
  channel: GuildTextBasedChannel,
  botMember: GuildMember,
): boolean {
  const permissions = channel.permissionsFor(botMember);
  const sendPermission = getChannelSendPermission(channel);
  return Boolean(
    permissions?.has(PermissionFlagsBits.ViewChannel) &&
    permissions.has(sendPermission) &&
    permissions.has(PermissionFlagsBits.EmbedLinks),
  );
}

function getChannelSendPermission(channel: GuildTextBasedChannel): bigint {
  return channel.isThread()
    ? PermissionFlagsBits.SendMessagesInThreads
    : PermissionFlagsBits.SendMessages;
}

function safeLabel(
  value: string | null,
  fallback: string,
  maxLength: number,
): string {
  const normalized = (value ?? fallback).normalize("NFKC").trim() || fallback;
  return normalized.slice(0, maxLength);
}

function parseId(customId: string, prefix: string): string | null {
  const value = customId.slice(prefix.length);
  return /^\d{17,20}$/.test(value) ? value : null;
}

function parseDmModalId(
  customId: string,
): { targetId: string; panelId: string } | null {
  const value = customId.slice(DM_MODAL_PREFIX.length);
  const match = /^(\d{17,20}):(\d{17,20})$/.exec(value);
  return match ? { targetId: match[1]!, panelId: match[2]! } : null;
}

function claimDmPanelCooldown(key: string, now: number): number {
  const prior = dmPanelCooldowns.get(key);
  if (prior !== undefined && now - prior < DM_PANEL_COOLDOWN_MS) {
    return Math.ceil((DM_PANEL_COOLDOWN_MS - (now - prior)) / 1_000);
  }
  if (dmPanelCooldowns.size >= MAX_DM_PANEL_COOLDOWNS) {
    for (const [candidate, timestamp] of dmPanelCooldowns) {
      if (now - timestamp >= DM_PANEL_COOLDOWN_MS) {
        dmPanelCooldowns.delete(candidate);
      }
    }
  }
  while (dmPanelCooldowns.size >= MAX_DM_PANEL_COOLDOWNS) {
    const oldest = dmPanelCooldowns.keys().next().value as string | undefined;
    if (!oldest) break;
    dmPanelCooldowns.delete(oldest);
  }
  dmPanelCooldowns.set(key, now);
  return 0;
}

async function replyPrivate(
  interaction:
    ButtonInteraction | ChatInputCommandInteraction | ModalSubmitInteraction,
  content: string,
): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    if (interaction.deferred && !interaction.replied) {
      await interaction.editReply({ content, allowedMentions: { parse: [] } });
      return;
    }
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
