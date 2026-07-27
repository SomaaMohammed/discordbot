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

const SETUP_ADMIN_ERROR =
  "Only the server owner or a member with Administrator permission can use setup.";
const FEATURE_CHOICES: Array<{
  name: string;
  value: keyof GuildSettings["features"];
}> = [
  { name: "court", value: "court" },
  { name: "invictus-chat", value: "invictusChat" },
  { name: "anonymous-answers", value: "anonymousAnswers" },
  { name: "reply-moderation", value: "replyModeration" },
  { name: "silence-lock", value: "silenceLock" },
  { name: "royal-afk", value: "royalAfk" },
  { name: "royal-presence", value: "royalPresence" },
  { name: "weekly-digest", value: "weeklyDigest" },
  { name: "greetings", value: "greetings" },
];

type ChannelPurpose = keyof GuildSettings["channels"];
type ArrayRolePurpose =
  | "staff"
  | "privilegedChat"
  | "silenceTargets"
  | "silenceExcludes";
type SingleRolePurpose = "emperor" | "empress" | "anonymousRequired";
type RolePurpose = ArrayRolePurpose | SingleRolePurpose;

export interface GuildSetupValidationResult {
  valid: boolean;
  errors: string[];
}

export function buildSetupCommandDefinition(): SlashCommandSubcommandsOnlyBuilder {
  return new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Configure Imperial Court for this server")
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
            .addChoices(
              { name: "court", value: "court" },
              { name: "log", value: "log" },
              { name: "weekly-digest", value: "weeklyDigest" },
              { name: "royal-alert", value: "royalAlert" },
            ),
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
        .setName("role")
        .setDescription("Set, add, remove, or clear a role binding")
        .addStringOption((option) =>
          option
            .setName("purpose")
            .setDescription("Role purpose")
            .setRequired(true)
            .addChoices(
              { name: "staff", value: "staff" },
              { name: "privileged-chat", value: "privilegedChat" },
              { name: "emperor", value: "emperor" },
              { name: "empress", value: "empress" },
              { name: "silence-target", value: "silenceTargets" },
              { name: "silence-exclude", value: "silenceExcludes" },
              { name: "anonymous-required", value: "anonymousRequired" },
            ),
        )
        .addStringOption((option) =>
          option
            .setName("action")
            .setDescription("Mutation to apply")
            .setRequired(true)
            .addChoices(
              { name: "set", value: "set" },
              { name: "add", value: "add" },
              { name: "remove", value: "remove" },
              { name: "clear", value: "clear" },
            ),
        )
        .addRoleOption((option) =>
          option
            .setName("role")
            .setDescription("Role used by set, add, or remove")
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
        .setName("schedule")
        .setDescription("Configure timezone and posting schedules")
        .addStringOption((option) =>
          option
            .setName("target")
            .setDescription("Schedule to configure")
            .setRequired(true)
            .addChoices(
              { name: "court", value: "court" },
              { name: "weekly-digest", value: "weeklyDigest" },
            ),
        )
        .addStringOption((option) =>
          option
            .setName("timezone")
            .setDescription("IANA timezone, such as UTC or Asia/Amman")
            .setRequired(false),
        )
        .addStringOption((option) =>
          option
            .setName("mode")
            .setDescription("Court schedule mode")
            .setRequired(false)
            .addChoices(
              { name: "off", value: "off" },
              { name: "manual", value: "manual" },
              { name: "auto", value: "auto" },
            ),
        )
        .addIntegerOption((option) =>
          option
            .setName("weekday")
            .setDescription("Digest weekday, Sunday=0 through Saturday=6")
            .setMinValue(0)
            .setMaxValue(6)
            .setRequired(false),
        )
        .addIntegerOption((option) =>
          option
            .setName("hour")
            .setDescription("Hour from 0 through 23")
            .setMinValue(0)
            .setMaxValue(23)
            .setRequired(false),
        )
        .addIntegerOption((option) =>
          option
            .setName("minute")
            .setDescription("Court minute from 0 through 59")
            .setMinValue(0)
            .setMaxValue(59)
            .setRequired(false),
        )
        .addBooleanOption((option) =>
          option
            .setName("dry_run")
            .setDescription("Log scheduled court posts without posting")
            .setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("limits")
        .setDescription("Configure moderation, answer, and retention limits")
        .addIntegerOption((option) =>
          option
            .setName("account_age_minutes")
            .setDescription("Minimum account age for anonymous answers")
            .setMinValue(0)
            .setRequired(false),
        )
        .addIntegerOption((option) =>
          option
            .setName("member_age_minutes")
            .setDescription("Minimum server membership age")
            .setMinValue(0)
            .setRequired(false),
        )
        .addIntegerOption((option) =>
          option
            .setName("cooldown_seconds")
            .setDescription("Anonymous-answer cooldown")
            .setMinValue(0)
            .setRequired(false),
        )
        .addBooleanOption((option) =>
          option
            .setName("allow_links")
            .setDescription("Allow links in anonymous answers")
            .setRequired(false),
        )
        .addIntegerOption((option) =>
          option
            .setName("mute_target_cap")
            .setDescription("Maximum bulk moderation targets; 0 disables cap")
            .setMinValue(0)
            .setRequired(false),
        )
        .addIntegerOption((option) =>
          option
            .setName("retention_days")
            .setDescription("Anonymous-answer retention in days")
            .setMinValue(1)
            .setRequired(false),
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
        .setName("labels")
        .setDescription("Configure Emperor and Empress display labels")
        .addStringOption((option) =>
          option
            .setName("emperor")
            .setDescription("Emperor display label")
            .setRequired(false)
            .setMaxLength(50),
        )
        .addStringOption((option) =>
          option
            .setName("empress")
            .setDescription("Empress display label")
            .setRequired(false)
            .setMaxLength(50),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("champion")
        .setDescription("Set or clear the optional undefeated champion")
        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription("Champion user")
            .setRequired(false),
        )
        .addBooleanOption((option) =>
          option
            .setName("clear")
            .setDescription("Clear the champion binding")
            .setRequired(false),
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
            .setDescription("Greeting text; use {user} for the configured mention")
            .setRequired(false)
            .setMaxLength(1900),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("validate").setDescription("Validate this configuration"),
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
            "Imperial Court is disabled for this server. Stored data was retained.",
          ephemeral: true,
        });
        return;
      case "channel":
        await updateChannel(interaction, guildRuntime);
        return;
      case "role":
        await updateRole(interaction, guildRuntime);
        return;
      case "feature":
        await updateFeature(interaction, guildRuntime);
        return;
      case "schedule":
        await updateSchedule(interaction, guildRuntime);
        return;
      case "limits":
        await updateLimits(interaction, guildRuntime);
        return;
      case "trigger":
        await updateTrigger(interaction, guildRuntime);
        return;
      case "labels":
        await updateLabels(interaction, guildRuntime);
        return;
      case "champion":
        await updateChampion(interaction, guildRuntime);
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
    await interaction.reply({ content: "Use setup inside a server.", ephemeral: true });
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
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
  const channelLines = Object.entries(settings.channels).map(
    ([purpose, channelId]) =>
      `- ${purpose}: ${channelId ? `<#${channelId}>` : "not set"}`,
  );
  await interaction.reply({
    content: [
      `**Imperial Court Setup v${settings.version}**`,
      `Enabled: \`${settings.enabled ? "yes" : "no"}\``,
      `Timezone: \`${settings.timezone}\``,
      `Court schedule: \`${settings.courtSchedule.mode}\` at \`${formatHourMinute(settings.courtSchedule.hour, settings.courtSchedule.minute)}\``,
      `Features: ${enabledFeatures.length > 0 ? enabledFeatures.map((name) => `\`${name}\``).join(", ") : "none"}`,
      "Channels:",
      ...channelLines,
      `Staff roles: \`${settings.roles.staff.length}\``,
      `Greeting profiles: \`${settings.greetings.length}\``,
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

  if (settings.features.court) {
    runtime.storage.initializeCourtQuestions();
  }
  await runtime.setEnabled(true);
  await interaction.reply({
    content: "Setup is valid. Imperial Court is now enabled for this server.",
    ephemeral: true,
  });
}

async function updateChannel(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const purpose = interaction.options.getString("purpose", true) as ChannelPurpose;
  const action = interaction.options.getString("action", true);
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
    action === "clear" ? null : resolvedChannel?.id ?? null;
  await runtime.saveSettings(settings);
  await interaction.reply({
    content:
      action === "clear"
        ? `Cleared the ${purpose} channel binding.`
        : `Set the ${purpose} channel to ${resolvedChannel?.toString()}.`,
    ephemeral: true,
  });
}

async function updateRole(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const purpose = interaction.options.getString("purpose", true) as RolePurpose;
  const action = interaction.options.getString("action", true);
  const roleOption = interaction.options.getRole("role");
  let role: Role | null = null;
  if (action !== "clear" && (!roleOption || !interaction.guild)) {
    await interaction.reply({
      content: "Choose a role from this server for that action.",
      ephemeral: true,
    });
    return;
  }
  if (action !== "clear" && interaction.guild && roleOption) {
    role = await interaction.guild.roles.fetch(roleOption.id).catch(() => null);
    if (!role || role.guild.id !== interaction.guild.id) {
      await interaction.reply({
        content: "Choose a role from this server for that action.",
        ephemeral: true,
      });
      return;
    }
  }

  const settings = cloneSettings(runtime.settings);
  if (isArrayRolePurpose(purpose)) {
    const values = new Set(settings.roles[purpose]);
    if (action === "clear") {
      values.clear();
    } else if (action === "set") {
      values.clear();
      values.add(role!.id);
    } else if (action === "add") {
      values.add(role!.id);
    } else if (action === "remove") {
      values.delete(role!.id);
    }
    settings.roles[purpose] = Array.from(values);
  } else {
    if (!new Set(["set", "clear"]).has(action)) {
      await interaction.reply({
        content: "Single-role bindings support only set or clear.",
        ephemeral: true,
      });
      return;
    }
    settings.roles[purpose] = action === "clear" ? null : role!.id;
  }

  await runtime.saveSettings(settings);
  await interaction.reply({
    content: `Updated the ${purpose} role binding.`,
    ephemeral: true,
  });
}

async function updateFeature(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const name = interaction.options.getString("name", true) as keyof GuildSettings["features"];
  const enabled = interaction.options.getBoolean("enabled", true);
  const settings = cloneSettings(runtime.settings);
  settings.features[name] = enabled;
  if (enabled && name === "court") {
    runtime.storage.initializeCourtQuestions();
  }
  if (!enabled && name === "court") {
    settings.courtSchedule.mode = "off";
  }
  await runtime.saveSettings(settings);
  await interaction.reply({
    content: `Feature ${name} is now \`${enabled ? "enabled" : "disabled"}\`.`,
    ephemeral: true,
  });
}

async function updateSchedule(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const target = interaction.options.getString("target", true);
  const timezone = interaction.options.getString("timezone")?.trim();
  if (timezone && !isValidTimezone(timezone)) {
    await interaction.reply({
      content: "Timezone must be a valid IANA timezone, such as `UTC` or `Asia/Amman`.",
      ephemeral: true,
    });
    return;
  }

  const settings = cloneSettings(runtime.settings);
  if (timezone) {
    settings.timezone = timezone;
  }
  const hour = interaction.options.getInteger("hour");
  if (target === "court") {
    const mode = interaction.options.getString("mode") as
      | GuildSettings["courtSchedule"]["mode"]
      | null;
    const minute = interaction.options.getInteger("minute");
    const dryRun = interaction.options.getBoolean("dry_run");
    if (mode) settings.courtSchedule.mode = mode;
    if (hour !== null) settings.courtSchedule.hour = hour;
    if (minute !== null) settings.courtSchedule.minute = minute;
    if (dryRun !== null) settings.courtSchedule.dryRun = dryRun;
  } else {
    const weekday = interaction.options.getInteger("weekday");
    if (weekday !== null) settings.weeklyDigestSchedule.weekday = weekday;
    if (hour !== null) settings.weeklyDigestSchedule.hour = hour;
  }

  await runtime.saveSettings(settings);
  await interaction.reply({
    content: `Updated the ${target} schedule in \`${settings.timezone}\`.`,
    ephemeral: true,
  });
}

async function updateLimits(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const settings = cloneSettings(runtime.settings);
  type NumericLimitKey = Exclude<
    keyof GuildSettings["limits"],
    "anonAllowLinks"
  >;
  const updates: Array<[string, NumericLimitKey]> = [
    ["account_age_minutes", "anonMinAccountAgeMinutes"],
    ["member_age_minutes", "anonMinMemberAgeMinutes"],
    ["cooldown_seconds", "anonCooldownSeconds"],
    ["mute_target_cap", "muteallTargetCap"],
    ["retention_days", "answerRetentionDays"],
  ];
  let changed = false;
  for (const [optionName, key] of updates) {
    const value = interaction.options.getInteger(optionName);
    if (value !== null) {
      settings.limits[key] = value;
      changed = true;
    }
  }
  const allowLinks = interaction.options.getBoolean("allow_links");
  if (allowLinks !== null) {
    settings.limits.anonAllowLinks = allowLinks;
    changed = true;
  }
  if (!changed) {
    await interaction.reply({
      content: "Provide at least one limit to update.",
      ephemeral: true,
    });
    return;
  }
  await runtime.saveSettings(settings);
  await interaction.reply({ content: "Guild limits updated.", ephemeral: true });
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

async function updateLabels(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const emperor = interaction.options.getString("emperor")?.trim();
  const empress = interaction.options.getString("empress")?.trim();
  if (!emperor && !empress) {
    await interaction.reply({
      content: "Provide at least one non-empty display label.",
      ephemeral: true,
    });
    return;
  }
  const settings = cloneSettings(runtime.settings);
  if (emperor) settings.labels.emperor = emperor;
  if (empress) settings.labels.empress = empress;
  await runtime.saveSettings(settings);
  await interaction.reply({ content: "Royal display labels updated.", ephemeral: true });
}

async function updateChampion(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const clear = interaction.options.getBoolean("clear") ?? false;
  const user = interaction.options.getUser("user");
  if (!clear && !user) {
    await interaction.reply({
      content: "Choose a champion user or set clear to true.",
      ephemeral: true,
    });
    return;
  }
  if (
    user &&
    (!interaction.guild ||
      !(await interaction.guild.members.fetch(user.id).catch(() => null)))
  ) {
    await interaction.reply({
      content: "Champion must be a current member of this server.",
      ephemeral: true,
    });
    return;
  }
  const settings = cloneSettings(runtime.settings);
  settings.championUserId = clear ? null : user!.id;
  await runtime.saveSettings(settings);
  await interaction.reply({
    content: clear ? "Champion binding cleared." : `Champion set to ${user}.`,
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
      content: lines.length > 0 ? lines.join("\n") : "No greeting profiles configured.",
      ephemeral: true,
    });
    return;
  }

  const name = normalizeProfileName(interaction.options.getString("name") ?? "");
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
      await interaction.reply({ content: "Greeting profile not found.", ephemeral: true });
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
  await interaction.reply({ content: `Greeting profile ${action} complete.`, ephemeral: true });
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
    { name: `imperial-court-${guildId}.json` },
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
      `Exact owner confirmation accepted. Removing only this server's retained data: ` +
      `\`${formatPurgeSummary(preview)}\`.`,
    ephemeral: true,
  });
  const result = runtime.storage.purgeGuild(guildRuntime.guildId);
  await interaction.editReply({
    content:
      "Purged this server's Imperial Court configuration and retained data only. " +
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
  if (settings.features.silenceLock && settings.roles.silenceTargets.length === 0) {
    errors.push("Silence lock requires at least one silence-target role.");
  }
  if (settings.features.silenceLock && !settings.roles.emperor) {
    errors.push("Silence lock requires an Emperor role binding.");
  }
  if (settings.features.invictusChat && !settings.invocation.keyword.trim()) {
    errors.push("Invictus chat requires an invocation keyword.");
  }
  if (settings.features.greetings && settings.greetings.length === 0) {
    errors.push("Greetings feature requires at least one greeting profile.");
  }

  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
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
    const channel = await guild.channels.fetch(requirement.id).catch(() => null);
    if (!channel || channel.guildId !== guild.id) {
      errors.push(`${requirement.purpose} channel no longer exists in this server.`);
      continue;
    }
    if (!isSendableGuildChannel(channel)) {
      errors.push(`${requirement.purpose} channel cannot receive bot messages.`);
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
    ...[settings.roles.emperor, settings.roles.empress, settings.roles.anonymousRequired].filter(
      (roleId): roleId is string => Boolean(roleId),
    ),
  ]);
  const resolvedRoles = new Map<string, Role>();
  for (const roleId of roleIds) {
    const role =
      guild.roles.cache.get(roleId) ??
      (await guild.roles.fetch(roleId).catch(() => null));
    if (!role || role.guild.id !== guild.id) {
      errors.push(`Configured role \`${roleId}\` no longer exists in this server.`);
    } else {
      resolvedRoles.set(roleId, role);
    }
  }

  const configuredUserIds = new Set<string>([
    ...[settings.championUserId].filter(
      (userId): userId is string => Boolean(userId),
    ),
    ...settings.greetings
      .map((profile) => profile.userId)
      .filter((userId): userId is string => Boolean(userId)),
  ]);
  for (const userId of configuredUserIds) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) {
      errors.push(`Configured user \`${userId}\` is not a member of this server.`);
    }
  }

  if (me && settings.features.silenceLock) {
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      errors.push("Silence lock requires the bot Manage Roles permission.");
    }
    for (const roleId of settings.roles.silenceTargets) {
      const role = resolvedRoles.get(roleId);
      if (role && me.roles.highest.comparePositionTo(role) <= 0) {
        errors.push(`Bot role must be above silence-target role ${role.toString()}.`);
      }
    }
  }
  if (
    me &&
    settings.features.replyModeration &&
    !me.permissions.has(PermissionFlagsBits.ModerateMembers)
  ) {
    errors.push("Reply moderation requires the bot Moderate Members permission.");
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
): channel is GuildBasedChannel & { send: (payload: unknown) => Promise<unknown> } {
  return (
    new Set<ChannelType>([
      ChannelType.GuildText,
      ChannelType.GuildAnnouncement,
    ]).has(channel.type) &&
    typeof (channel as { send?: unknown }).send === "function"
  );
}
