import {
  AttachmentBuilder,
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type Role,
  type SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import type { BotRuntime, GuildRuntime } from "../runtime.js";
import { GuildSettingsConflictError } from "../storage/db.js";
import type { GuildPurgeResult, GuildSettings } from "../types.js";
import { restoreAllSilenceLeases } from "./runtime-parity.js";
import { getEffectiveSilenceTargetRoleIds } from "./silence-leases.js";

const SETUP_ADMIN_ERROR =
  "Only the server owner or a member with Administrator permission can use setup.";
const FEATURE_CHOICES: Array<{
  name: string;
  value: keyof GuildSettings["features"];
}> = [
  { name: "superior-chat", value: "invictusChat" },
  { name: "reply-moderation", value: "replyModeration" },
  { name: "greetings", value: "greetings" },
];
const ACTIVE_FEATURES = new Set<keyof GuildSettings["features"]>(
  FEATURE_CHOICES.map(({ value }) => value),
);
const RETIRED_SETUP_MESSAGE =
  "That Imperial/Court setup option has been retired. Its stored legacy data was not changed.";

export function getFeatureDisplayName(
  feature: keyof GuildSettings["features"],
): string {
  return (
    FEATURE_CHOICES.find((choice) => choice.value === feature)?.name ?? feature
  );
}

type ChannelPurpose = keyof GuildSettings["channels"];
type ArrayRolePurpose =
  "staff" | "privilegedChat" | "silenceTargets" | "silenceExcludes";
type SingleRolePurpose = "emperor" | "empress" | "anonymousRequired";
type RolePurpose = ArrayRolePurpose | SingleRolePurpose;

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
      subcommand.setName("status").setDescription("Show current configuration"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("enable")
        .setDescription("Validate and enable this server"),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("disable").setDescription("Disable all bot behavior"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("channel")
        .setDescription("Set or clear a channel binding")
        .addStringOption((option) =>
          option
            .setName("purpose")
            .setDescription("Channel purpose")
            .setRequired(true)
            .addChoices({ name: "log", value: "log" }),
        )
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
            .setDescription("Channel to bind when action is set")
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
        .setDescription("Set the timezone used by Superior responses")
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
        .setDescription("Configure bulk moderation limits")
        .addIntegerOption((option) =>
          option
            .setName("mute_target_cap")
            .setDescription("Maximum bulk moderation targets; 0 disables cap")
            .setMinValue(0)
            .setMaxValue(10_000)
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("trigger")
        .setDescription("Configure the conversational invocation")
        .addStringOption((option) =>
          option
            .setName("keyword")
            .setDescription("Primary invocation keyword")
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
        .setDescription("Manage configurable greeting profiles")
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
        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription("Optional user mentioned by the greeting")
            .setRequired(false),
        )
        .addStringOption((option) =>
          option
            .setName("message")
            .setDescription(
              "Greeting text; use {user} for the configured mention",
            )
            .setRequired(false)
            .setMaxLength(1900),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("validate")
        .setDescription("Validate this configuration"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("export")
        .setDescription("Export only this server's configuration and data"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("purge")
        .setDescription("Permanently purge only this server's retained data")
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
  if (!actor || !interaction.guild) {
    return;
  }

  try {
    const subcommand = interaction.options.getSubcommand();
    switch (subcommand) {
      case "status":
        await showSetupStatus(interaction, guildRuntime.settings);
        return;
      case "enable":
        await enableGuild(interaction, guildRuntime);
        return;
      case "disable":
        await guildRuntime.setEnabled(false);
        await interaction.reply({
          content:
            "Superior is disabled for this server. Stored data was retained.",
          ephemeral: true,
        });
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
      case "labels":
      case "champion":
      case "schedule":
      case "role":
        await interaction.reply({
          content: RETIRED_SETUP_MESSAGE,
          ephemeral: true,
        });
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
      case "purge":
        await purgeGuild(interaction, runtime, guildRuntime, actor);
        return;
      default:
        await interaction.reply({
          content: "Unknown setup operation.",
          ephemeral: true,
        });
    }
  } catch (error) {
    if (error instanceof GuildSettingsConflictError) {
      await interaction.reply({
        content:
          "This server's configuration changed during setup. Review the latest settings and try again.",
        ephemeral: true,
      });
      return;
    }
    throw error;
  }
}

export async function requireSetupAdmin(
  interaction: ChatInputCommandInteraction,
): Promise<GuildMember | null> {
  if (!interaction.guild) {
    await interaction.reply({
      content: "Use setup inside a server.",
      ephemeral: true,
    });
    return null;
  }

  const actor = await interaction.guild.members
    .fetch(interaction.user.id)
    .catch(() => null);
  if (
    !actor ||
    (interaction.guild.ownerId !== interaction.user.id &&
      !actor.permissions.has(PermissionFlagsBits.Administrator))
  ) {
    await interaction.reply({ content: SETUP_ADMIN_ERROR, ephemeral: true });
    return null;
  }
  return actor;
}

async function showSetupStatus(
  interaction: ChatInputCommandInteraction,
  settings: GuildSettings,
): Promise<void> {
  const enabledFeatures = Object.entries(settings.features)
    .filter(
      ([name, enabled]) =>
        enabled && ACTIVE_FEATURES.has(name as keyof GuildSettings["features"]),
    )
    .map(([name]) =>
      getFeatureDisplayName(name as keyof GuildSettings["features"]),
    );
  await interaction.reply({
    content: [
      `**Superior Setup v${settings.version}**`,
      `Enabled: \`${settings.enabled ? "yes" : "no"}\``,
      `Timezone: \`${settings.timezone}\``,
      `Invocation: \`${settings.invocation.keyword}\` (${settings.invocation.aliases.length} alias(es))`,
      `Features: ${enabledFeatures.length > 0 ? enabledFeatures.map((name) => `\`${name}\``).join(", ") : "none"}`,
      `Log channel: ${settings.channels.log ? `<#${settings.channels.log}>` : "not set"}`,
      `Greeting profiles: \`${settings.greetings.length}\``,
      "Legacy court settings and data are retained but inactive.",
    ].join("\n"),
    ephemeral: true,
  });
}

async function enableGuild(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  if (!interaction.guild) {
    return;
  }
  // Validate a fresh persisted snapshot. setEnabled(true) performs a
  // compare-and-set against this snapshot after the asynchronous Discord
  // checks, so any concurrent edit causes enablement to fail closed.
  const settings = await runtime.refreshSettings();
  const validation = await validateGuildSetup(interaction.guild, settings);
  if (!validation.valid) {
    await interaction.reply({
      content: `Setup is incomplete:\n${validation.errors.map((error) => `- ${error}`).join("\n")}`,
      ephemeral: true,
    });
    return;
  }

  await runtime.setEnabled(true);
  await interaction.reply({
    content: "Setup is valid. Superior is now enabled for this server.",
    ephemeral: true,
  });
}

async function updateChannel(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const purpose = interaction.options.getString(
    "purpose",
    true,
  ) as ChannelPurpose;
  const action = interaction.options.getString("action", true);
  if (purpose !== "log") {
    await interaction.reply({
      content: RETIRED_SETUP_MESSAGE,
      ephemeral: true,
    });
    return;
  }
  if (action !== "set" && action !== "clear") {
    await interaction.reply({
      content: "Channel action must be set or clear.",
      ephemeral: true,
    });
    return;
  }
  const channel = interaction.options.getChannel("channel");
  let resolvedChannel: GuildBasedChannel | null = null;
  if (action === "set") {
    if (!channel || !interaction.guild) {
      await interaction.reply({
        content: "Choose a channel from this server when action is set.",
        ephemeral: true,
      });
      return;
    }
    resolvedChannel = await interaction.guild.channels
      .fetch(channel.id)
      .catch(() => null);
    if (
      !resolvedChannel ||
      resolvedChannel.guildId !== interaction.guild.id ||
      !isSendableGuildChannel(resolvedChannel)
    ) {
      await interaction.reply({
        content: "Choose a text or announcement channel from this server.",
        ephemeral: true,
      });
      return;
    }
  }

  const settings = cloneSettings(runtime.settings);
  settings.channels[purpose] =
    action === "clear" ? null : (resolvedChannel?.id ?? null);
  await runtime.saveSettings(settings);
  await interaction.reply({
    content:
      action === "clear"
        ? `Cleared the ${purpose} channel binding.`
        : `Set the ${purpose} channel to ${resolvedChannel?.toString()}.`,
    ephemeral: true,
  });
}

async function updateFeature(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const name = interaction.options.getString(
    "name",
    true,
  ) as keyof GuildSettings["features"];
  if (!ACTIVE_FEATURES.has(name)) {
    await interaction.reply({
      content: RETIRED_SETUP_MESSAGE,
      ephemeral: true,
    });
    return;
  }
  const enabled = interaction.options.getBoolean("enabled", true);
  const settings = cloneSettings(runtime.settings);
  settings.features[name] = enabled;
  await runtime.saveSettings(settings);
  await interaction.reply({
    content: `Feature ${getFeatureDisplayName(name)} is now \`${enabled ? "enabled" : "disabled"}\`.`,
    ephemeral: true,
  });
}

async function updateTimezone(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const timezone = interaction.options.getString("timezone", true).trim();
  if (!isValidTimezone(timezone)) {
    await interaction.reply({
      content:
        "Timezone must be a valid IANA timezone, such as `UTC` or `Asia/Amman`.",
      ephemeral: true,
    });
    return;
  }

  const settings = cloneSettings(runtime.settings);
  settings.timezone = timezone;
  await runtime.saveSettings(settings);
  await interaction.reply({
    content: `Timezone updated to \`${settings.timezone}\`.`,
    ephemeral: true,
  });
}

async function updateLimits(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const settings = cloneSettings(runtime.settings);
  const targetCap = interaction.options.getInteger("mute_target_cap");
  if (targetCap === null) {
    await interaction.reply({
      content: RETIRED_SETUP_MESSAGE,
      ephemeral: true,
    });
    return;
  }
  settings.limits.muteallTargetCap = targetCap;
  await runtime.saveSettings(settings);
  await interaction.reply({
    content: "Guild limits updated.",
    ephemeral: true,
  });
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
      (interaction.options.getString("aliases") ?? "")
        .split(",")
        .map(normalizeInvocationTerm)
        .filter(Boolean),
    ),
  ).filter((alias) => alias !== keyword);
  if (!keyword) {
    await interaction.reply({
      content: "Invocation keyword cannot be empty.",
      ephemeral: true,
    });
    return;
  }
  const settings = cloneSettings(runtime.settings);
  settings.invocation = { keyword, aliases };
  await runtime.saveSettings(settings);
  await interaction.reply({
    content: `Invocation updated to \`${keyword}\` with \`${aliases.length}\` alias(es).`,
    ephemeral: true,
  });
}

async function updateGreeting(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const action = interaction.options.getString("action", true);
  if (action === "list") {
    const lines = runtime.settings.greetings.map(
      (profile) =>
        `- \`${profile.name}\`${profile.userId ? ` -> <@${profile.userId}>` : ""}: ${profile.message}`,
    );
    await interaction.reply({
      content:
        lines.length > 0
          ? lines.join("\n")
          : "No greeting profiles configured.",
      ephemeral: true,
    });
    return;
  }

  const name = normalizeProfileName(
    interaction.options.getString("name") ?? "",
  );
  if (!name) {
    await interaction.reply({
      content: "Provide a profile name for this action.",
      ephemeral: true,
    });
    return;
  }
  const settings = cloneSettings(runtime.settings);
  const index = settings.greetings.findIndex(
    (profile) => profile.name.toLowerCase() === name.toLowerCase(),
  );
  if (action === "remove") {
    if (index < 0) {
      await interaction.reply({
        content: "Greeting profile not found.",
        ephemeral: true,
      });
      return;
    }
    settings.greetings.splice(index, 1);
  } else {
    const message = interaction.options.getString("message")?.trim();
    if (!message) {
      await interaction.reply({
        content: "Provide greeting text for add or update.",
        ephemeral: true,
      });
      return;
    }
    const selectedUser = interaction.options.getUser("user");
    if (
      selectedUser &&
      (!interaction.guild ||
        !(await interaction.guild.members
          .fetch(selectedUser.id)
          .catch(() => null)))
    ) {
      await interaction.reply({
        content: "Greeting user must be a current member of this server.",
        ephemeral: true,
      });
      return;
    }
    const profile = {
      name,
      userId: selectedUser?.id ?? null,
      message,
    };
    if (action === "add" && index >= 0) {
      await interaction.reply({
        content: "That greeting profile already exists; use update.",
        ephemeral: true,
      });
      return;
    }
    if (action === "update" && index < 0) {
      await interaction.reply({
        content: "Greeting profile not found; use add.",
        ephemeral: true,
      });
      return;
    }
    if (index >= 0) settings.greetings[index] = profile;
    else settings.greetings.push(profile);
  }
  await runtime.saveSettings(settings);
  await interaction.reply({
    content: `Greeting profile ${action} complete.`,
    ephemeral: true,
  });
}

async function replyWithValidation(
  interaction: ChatInputCommandInteraction,
  settings: GuildSettings,
): Promise<void> {
  if (!interaction.guild) return;
  const result = await validateGuildSetup(interaction.guild, settings);
  await interaction.reply({
    content: result.valid
      ? "Configuration is valid and ready to enable."
      : `Configuration issues:\n${result.errors.map((error) => `- ${error}`).join("\n")}`,
    ephemeral: true,
  });
}

async function exportGuild(
  interaction: ChatInputCommandInteraction,
  runtime: BotRuntime,
  guildId: string,
): Promise<void> {
  const payload = runtime.storage.exportGuild(guildId);
  const attachment = new AttachmentBuilder(
    Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8"),
    { name: `superior-${guildId}.json` },
  );
  await interaction.reply({
    content: "Exported configuration and data for this server only.",
    files: [attachment],
    ephemeral: true,
  });
}

async function purgeGuild(
  interaction: ChatInputCommandInteraction,
  runtime: BotRuntime,
  guildRuntime: GuildRuntime,
  actor: GuildMember,
): Promise<void> {
  if (!interaction.guild || interaction.guild.ownerId !== actor.id) {
    await interaction.reply({
      content: "Only the server owner can purge retained guild data.",
      ephemeral: true,
    });
    return;
  }
  const expected = `PURGE ${guildRuntime.guildId}`;
  const confirmation = interaction.options.getString("confirmation", true);
  const preview = runtime.storage.previewGuildPurge(guildRuntime.guildId);
  if (confirmation !== expected) {
    await interaction.reply({
      content:
        `Purge removes this server's settings, state, questions, posts, answers, cooldowns, and metrics. ` +
        `Current removal scope: \`${formatPurgeSummary(preview)}\`. ` +
        `Type \`${expected}\` exactly to continue.`,
      ephemeral: true,
    });
    return;
  }

  runtime.storage.setGuildEnabled(guildRuntime.guildId, false);
  runtime.invalidateGuild(guildRuntime.guildId, {
    forgetBackfillStatus: true,
  });
  await interaction.reply({
    content:
      `Exact owner confirmation accepted. Preparing safe removal of only this server's retained data: ` +
      `\`${formatPurgeSummary(preview)}\`.`,
    ephemeral: true,
  });
  let restoredLeases: Awaited<ReturnType<typeof restoreAllSilenceLeases>>;
  try {
    restoredLeases = await restoreAllSilenceLeases(
      interaction.guild,
      guildRuntime,
    );
  } catch {
    await interaction.editReply({
      content:
        "Purge refused because active silence-lock metadata could not be read safely. " +
        "All retained server data was preserved; the bot remains disabled here.",
    });
    return;
  }
  if (restoredLeases.unresolved > 0) {
    await interaction.editReply({
      content:
        `Purge refused because ${restoredLeases.unresolved} active silence overwrite(s) could not be restored. ` +
        "All retained server data was preserved; the bot remains disabled here. Check Manage Roles permission and role hierarchy, then retry.",
    });
    return;
  }
  const result = runtime.storage.purgeGuild(guildRuntime.guildId);
  await interaction.editReply({
    content:
      "Purged this server's Superior configuration and retained data, including legacy records. " +
      `Removal summary: \`${formatPurgeSummary(result)}\``,
  });
}

function formatPurgeSummary(result: GuildPurgeResult): string {
  return [
    `guild=${result.guilds}`,
    `settings=${result.settings}`,
    `state/questions=${result.kv}`,
    `posts=${result.posts}`,
    `answers=${result.answers}`,
    `cooldowns=${result.cooldowns}`,
    `metrics=${result.metrics}`,
  ].join(", ");
}

export async function validateGuildSetup(
  guild: Guild,
  settings: GuildSettings,
): Promise<GuildSetupValidationResult> {
  const errors: string[] = [];
  if (!isValidTimezone(settings.timezone)) {
    errors.push(`Timezone \`${settings.timezone}\` is invalid.`);
  }
  if (settings.features.invictusChat && !settings.invocation.keyword.trim()) {
    errors.push("Superior chat requires an invocation keyword.");
  }
  if (settings.features.greetings && settings.greetings.length === 0) {
    errors.push("Greetings requires at least one greeting profile.");
  }

  const me =
    guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!me) {
    errors.push("Could not resolve the bot member to validate permissions.");
  }

  if (settings.channels.log) {
    const channel = await guild.channels
      .fetch(settings.channels.log)
      .catch(() => null);
    if (!channel || channel.guildId !== guild.id) {
      errors.push("The log channel no longer exists in this server.");
    } else if (!isSendableGuildChannel(channel)) {
      errors.push("The log channel cannot receive bot messages.");
    } else if (me) {
      const permissions = channel.permissionsFor(me);
      const required = [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
      ];
      const missing = required.filter(
        (permission) => !permissions?.has(permission),
      );
      if (missing.length > 0) {
        errors.push(
          `The log channel is missing ${missing.length} required bot permission(s).`,
        );
      }
    }
  }

  const greetingUserIds = new Set(
    settings.greetings
      .map((profile) => profile.userId)
      .filter((userId): userId is string => Boolean(userId)),
  );
  for (const userId of greetingUserIds) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) {
      errors.push(
        `Configured greeting user \`${userId}\` is not a member of this server.`,
      );
    }
  }

  if (
    me &&
    settings.features.replyModeration &&
    !me.permissions.has(PermissionFlagsBits.ModerateMembers)
  ) {
    errors.push(
      "Reply moderation requires the bot Moderate Members permission.",
    );
  }

  return { valid: errors.length === 0, errors };
}

async function validateLegacyGuildSetup(
  guild: Guild,
  settings: GuildSettings,
): Promise<GuildSetupValidationResult> {
  const errors: string[] = [];
  const effectiveSilenceTargetRoleIds = getEffectiveSilenceTargetRoleIds(
    settings.roles.silenceTargets,
    settings.roles.silenceExcludes,
  );
  if (!Object.values(settings.features).some(Boolean)) {
    errors.push("Enable at least one feature.");
  }
  if (!isValidTimezone(settings.timezone)) {
    errors.push(`Timezone \`${settings.timezone}\` is invalid.`);
  }
  if (settings.features.court) {
    if (settings.courtSchedule.mode === "off") {
      errors.push("Court feature requires court schedule mode manual or auto.");
    }
    if (!settings.channels.court) {
      errors.push("Court feature requires a court channel.");
    }
  }
  if (settings.features.anonymousAnswers && !settings.features.court) {
    errors.push("Anonymous answers require the court feature.");
  }
  if (settings.features.weeklyDigest && !settings.channels.weeklyDigest) {
    errors.push("Weekly digest requires a weekly-digest channel.");
  }
  if (
    (settings.features.royalAfk || settings.features.royalPresence) &&
    !settings.channels.royalAlert
  ) {
    errors.push("Royal AFK/presence requires a royal-alert channel.");
  }
  if (
    (settings.features.royalAfk || settings.features.royalPresence) &&
    !settings.roles.emperor &&
    !settings.roles.empress
  ) {
    errors.push("Royal AFK/presence requires an Emperor or Empress role.");
  }
  if (
    settings.features.silenceLock &&
    effectiveSilenceTargetRoleIds.length === 0
  ) {
    errors.push(
      "Silence lock requires at least one non-excluded silence-target role.",
    );
  }
  if (settings.features.silenceLock && !settings.roles.emperor) {
    errors.push("Silence lock requires an Emperor role binding.");
  }
  if (settings.features.invictusChat && !settings.invocation.keyword.trim()) {
    errors.push("Superior chat requires an invocation keyword.");
  }
  if (settings.features.greetings && settings.greetings.length === 0) {
    errors.push("Greetings feature requires at least one greeting profile.");
  }

  const me =
    guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!me) {
    errors.push("Could not resolve the bot member to validate permissions.");
  }

  const courtPermissions = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory,
    ...(settings.features.anonymousAnswers
      ? [
          PermissionFlagsBits.CreatePublicThreads,
          PermissionFlagsBits.SendMessagesInThreads,
          PermissionFlagsBits.ManageThreads,
        ]
      : []),
  ];
  const channelRequirements: Array<{
    purpose: ChannelPurpose;
    id: string | null;
    requiredPermissions: bigint[];
  }> = [
    {
      purpose: "court",
      id: settings.channels.court,
      requiredPermissions: courtPermissions,
    },
    {
      purpose: "log",
      id: settings.channels.log,
      requiredPermissions: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
      ],
    },
    {
      purpose: "weeklyDigest",
      id: settings.channels.weeklyDigest,
      requiredPermissions: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
      ],
    },
    {
      purpose: "royalAlert",
      id: settings.channels.royalAlert,
      requiredPermissions: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
      ],
    },
  ];
  for (const requirement of channelRequirements) {
    if (!requirement.id) continue;
    const channel = await guild.channels
      .fetch(requirement.id)
      .catch(() => null);
    if (!channel || channel.guildId !== guild.id) {
      errors.push(
        `${requirement.purpose} channel no longer exists in this server.`,
      );
      continue;
    }
    if (!isSendableGuildChannel(channel)) {
      errors.push(
        `${requirement.purpose} channel cannot receive bot messages.`,
      );
      continue;
    }
    if (
      requirement.purpose === "court" &&
      settings.features.anonymousAnswers &&
      channel.isThread()
    ) {
      errors.push(
        "court channel must be a text or announcement channel when anonymous answers are enabled.",
      );
    }
    if (me) {
      const permissions = channel.permissionsFor(me);
      const missing = requirement.requiredPermissions.filter(
        (permission) => !permissions?.has(permission),
      );
      if (missing.length > 0) {
        errors.push(
          `${requirement.purpose} channel is missing ${missing.length} required bot permission(s).`,
        );
      }
    }
  }

  const roleIds = new Set<string>([
    ...settings.roles.staff,
    ...settings.roles.privilegedChat,
    ...settings.roles.silenceTargets,
    ...settings.roles.silenceExcludes,
    ...[
      settings.roles.emperor,
      settings.roles.empress,
      settings.roles.anonymousRequired,
    ].filter((roleId): roleId is string => Boolean(roleId)),
  ]);
  const resolvedRoles = new Map<string, Role>();
  for (const roleId of roleIds) {
    const role =
      guild.roles.cache.get(roleId) ??
      (await guild.roles.fetch(roleId).catch(() => null));
    if (!role || role.guild.id !== guild.id) {
      errors.push(
        `Configured role \`${roleId}\` no longer exists in this server.`,
      );
    } else {
      resolvedRoles.set(roleId, role);
    }
  }

  const configuredUserIds = new Set<string>([
    ...[settings.championUserId].filter((userId): userId is string =>
      Boolean(userId),
    ),
    ...settings.greetings
      .map((profile) => profile.userId)
      .filter((userId): userId is string => Boolean(userId)),
  ]);
  for (const userId of configuredUserIds) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) {
      errors.push(
        `Configured user \`${userId}\` is not a member of this server.`,
      );
    }
  }

  if (me && settings.features.silenceLock) {
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      errors.push("Silence lock requires the bot Manage Roles permission.");
    }
    for (const roleId of effectiveSilenceTargetRoleIds) {
      const role = resolvedRoles.get(roleId);
      if (role && me.roles.highest.comparePositionTo(role) <= 0) {
        errors.push(
          `Bot role must be above silence-target role ${role.toString()}.`,
        );
      }
    }
  }
  if (
    me &&
    settings.features.replyModeration &&
    !me.permissions.has(PermissionFlagsBits.ModerateMembers)
  ) {
    errors.push(
      "Reply moderation requires the bot Moderate Members permission.",
    );
  }

  return { valid: errors.length === 0, errors };
}

function isArrayRolePurpose(purpose: RolePurpose): purpose is ArrayRolePurpose {
  return new Set<RolePurpose>([
    "staff",
    "privilegedChat",
    "silenceTargets",
    "silenceExcludes",
  ]).has(purpose);
}

function cloneSettings(settings: GuildSettings): GuildSettings {
  return structuredClone(settings);
}

async function initializeCourtQuestionsWithRollback(
  runtime: GuildRuntime,
  rollback: () => Promise<unknown>,
): Promise<void> {
  try {
    runtime.storage.initializeCourtQuestions();
  } catch (error) {
    try {
      await rollback();
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Court question initialization failed and the setup change could not be rolled back",
      );
    }
    throw error;
  }
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

function normalizeInvocationTerm(value: string): string {
  return value.trim().toLowerCase().replaceAll(/\s+/g, " ");
}

function normalizeProfileName(value: string): string {
  return value.trim().replaceAll(/\s+/g, " ");
}

function formatHourMinute(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function isSendableGuildChannel(
  channel: GuildBasedChannel,
): channel is GuildBasedChannel & {
  send: (payload: unknown) => Promise<unknown>;
} {
  return (
    new Set<ChannelType>([
      ChannelType.GuildText,
      ChannelType.GuildAnnouncement,
    ]).has(channel.type) &&
    typeof (channel as { send?: unknown }).send === "function"
  );
}
