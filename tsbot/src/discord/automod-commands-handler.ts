import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import type { GuildRuntime } from "../runtime.js";
import type {
  AntiSpamAction,
  AntiSpamRule,
  AntiSpamRuleInput,
  AntiSpamRuleType,
  ModerationConfiguration,
} from "../types.js";
import { authorizeCapability } from "./authorization.js";
import {
  ANTI_SPAM_RULE_TYPES,
  evaluateSyntheticAntiSpam,
} from "./anti-spam-detector.js";
import { clearAntiSpamProcessState } from "./anti-spam-enforcement.js";
import { fetchGuildRoleCoalesced } from "./fetch-coalescing.js";

interface AutomodStorage {
  getModerationConfiguration(): ModerationConfiguration | null;
  getAntiSpamRule(type: AntiSpamRuleType): AntiSpamRule | null;
  listAntiSpamRules(): AntiSpamRule[];
  upsertAntiSpamRule(input: AntiSpamRuleInput): AntiSpamRule;
  setAntiSpamRuleEnabled(
    type: AntiSpamRuleType,
    enabled: boolean,
    actorId: string,
  ): AntiSpamRule | null;
  listAntiSpamExemptRoleIds(): string[];
  listAntiSpamExemptChannelIds(): string[];
  addAntiSpamExemptRole(roleId: string, actorId: string): boolean;
  removeAntiSpamExemptRole(roleId: string, actorId?: string): boolean;
  addAntiSpamExemptChannel(channelId: string, actorId: string): boolean;
  removeAntiSpamExemptChannel(channelId: string, actorId?: string): boolean;
}

const ACTIONS = new Set<AntiSpamAction>([
  "delete",
  "delete-and-warn",
  "delete-and-timeout",
]);

export async function handleAutomodCommand(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  await deferPrivate(interaction);
  const authorization = await authorizeCapability({
    guild: interaction.guild!,
    userId: interaction.user.id,
    capability: "moderation.configure",
    grants: runtime.storage,
  });
  if (!authorization.allowed) {
    await replyPrivate(
      interaction,
      "You need the `moderation.configure` capability to manage anti-spam.",
    );
    return;
  }
  const storage: AutomodStorage = runtime.storage;
  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();
  if (!group && subcommand === "status") {
    await showStatus(interaction, storage);
    return;
  }
  if (!group && subcommand === "test") {
    await testRule(interaction, storage);
    return;
  }
  if (group === "rule") {
    await mutateRule(
      interaction,
      runtime,
      storage,
      authorization.member.id,
      subcommand,
    );
    return;
  }
  if (group === "exempt-role") {
    await mutateRoleExemption(
      interaction,
      runtime,
      storage,
      authorization.member.id,
      subcommand,
    );
    return;
  }
  if (group === "exempt-channel") {
    await mutateChannelExemption(
      interaction,
      runtime,
      storage,
      authorization.member.id,
      subcommand,
    );
    return;
  }
  await replyPrivate(interaction, "Choose a supported anti-spam operation.");
}

async function mutateRule(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: AutomodStorage,
  actorId: string,
  operation: string,
): Promise<void> {
  const type = parseRuleType(interaction.options.getString("type", true));
  if (!type)
    return void (await replyPrivate(
      interaction,
      "Choose a supported anti-spam rule type.",
    ));
  if (operation === "configure") {
    const threshold = interaction.options.getInteger("threshold", true);
    const actionRaw = interaction.options.getString(
      "action",
      true,
    ) as AntiSpamAction;
    const windowSeconds = interaction.options.getInteger(
      "window_seconds",
      false,
    );
    const timeoutMinutes = interaction.options.getInteger(
      "timeout_minutes",
      false,
    );
    const cooldownSeconds = interaction.options.getInteger(
      "cooldown_seconds",
      true,
    );
    if (!ACTIONS.has(actionRaw))
      return void (await replyPrivate(
        interaction,
        "Choose a supported anti-spam action.",
      ));
    if (type !== "mention" && windowSeconds === null)
      return void (await replyPrivate(
        interaction,
        "Burst and duplicate rules require a 1-300 second rolling window.",
      ));
    if (type === "mention" && windowSeconds !== null)
      return void (await replyPrivate(
        interaction,
        "Mention rules use the triggering message and do not accept a rolling window.",
      ));
    if (actionRaw === "delete-and-timeout" && timeoutMinutes === null)
      return void (await replyPrivate(
        interaction,
        "Delete-and-timeout requires a timeout duration.",
      ));
    if (actionRaw !== "delete-and-timeout" && timeoutMinutes !== null)
      return void (await replyPrivate(
        interaction,
        "Timeout duration is only valid for delete-and-timeout.",
      ));
    if (!(await stillAuthorized(interaction, runtime, actorId))) {
      await replyPrivate(
        interaction,
        "Your anti-spam configuration authority changed before the rule could be saved.",
      );
      return;
    }
    const existing = storage.getAntiSpamRule(type);
    const rule = storage.upsertAntiSpamRule({
      ruleType: type,
      enabled:
        interaction.options.getBoolean("enabled", false) ??
        existing?.enabled ??
        false,
      threshold,
      windowSeconds: type === "mention" ? null : windowSeconds,
      action: actionRaw,
      timeoutSeconds: timeoutMinutes === null ? null : timeoutMinutes * 60,
      cooldownSeconds,
      actorId,
    });
    runtime.invalidate();
    clearAntiSpamProcessState(runtime.guildId);
    await replyPrivate(
      interaction,
      `Saved the **${rule.ruleType}** rule (${rule.enabled ? "enabled" : "disabled"}). In-flight message work from the prior generation was cancelled.`,
    );
    return;
  }
  const enabled = operation === "enable";
  if (!(await stillAuthorized(interaction, runtime, actorId))) {
    await replyPrivate(
      interaction,
      "Your anti-spam configuration authority changed before the rule state could be saved.",
    );
    return;
  }
  const rule = storage.setAntiSpamRuleEnabled(type, enabled, actorId);
  if (!rule)
    return void (await replyPrivate(
      interaction,
      "Configure that rule before changing its enabled state.",
    ));
  runtime.invalidate();
  clearAntiSpamProcessState(runtime.guildId);
  await replyPrivate(
    interaction,
    `${type} anti-spam is now **${enabled ? "enabled" : "disabled"}**.`,
  );
}

async function mutateRoleExemption(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: AutomodStorage,
  actorId: string,
  operation: string,
): Promise<void> {
  const selected = interaction.options.getRole("role", true);
  const role = await fetchGuildRoleCoalesced(interaction.guild!, selected.id, {
    cache: true,
    force: true,
  });
  if (
    !role ||
    role.guild.id !== runtime.guildId ||
    role.id === runtime.guildId ||
    role.managed
  ) {
    await replyPrivate(
      interaction,
      "Exemption roles must be current, non-managed roles in this server and cannot be @everyone.",
    );
    return;
  }
  if (!(await stillAuthorized(interaction, runtime, actorId))) {
    await replyPrivate(
      interaction,
      "Your anti-spam configuration authority changed during role verification.",
    );
    return;
  }
  const changed =
    operation === "add"
      ? storage.addAntiSpamExemptRole(role.id, actorId)
      : storage.removeAntiSpamExemptRole(role.id, actorId);
  runtime.invalidate();
  clearAntiSpamProcessState(runtime.guildId);
  await replyPrivate(
    interaction,
    `${changed ? "Updated" : "No change to"} the anti-spam exemption for role \`${role.id}\`.`,
  );
}

async function mutateChannelExemption(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: AutomodStorage,
  actorId: string,
  operation: string,
): Promise<void> {
  const selected = interaction.options.getChannel("channel", true);
  const channel = await interaction
    .guild!.channels.fetch(selected.id, { cache: true, force: true })
    .catch(() => null);
  if (
    !channel ||
    channel.guild.id !== runtime.guildId ||
    !channel.isTextBased() ||
    channel.isDMBased()
  ) {
    await replyPrivate(
      interaction,
      "Exemption channels must be current text-based channels in this server.",
    );
    return;
  }
  if (!(await stillAuthorized(interaction, runtime, actorId))) {
    await replyPrivate(
      interaction,
      "Your anti-spam configuration authority changed during channel verification.",
    );
    return;
  }
  const changed =
    operation === "add"
      ? storage.addAntiSpamExemptChannel(channel.id, actorId)
      : storage.removeAntiSpamExemptChannel(channel.id, actorId);
  runtime.invalidate();
  clearAntiSpamProcessState(runtime.guildId);
  await replyPrivate(
    interaction,
    `${changed ? "Updated" : "No change to"} the anti-spam exemption for channel \`${channel.id}\`.`,
  );
}

async function testRule(
  interaction: ChatInputCommandInteraction,
  storage: AutomodStorage,
): Promise<void> {
  const type = parseRuleType(interaction.options.getString("type", true));
  const rule = type ? storage.getAntiSpamRule(type) : null;
  if (!rule)
    return void (await replyPrivate(
      interaction,
      "Configure that rule before testing it.",
    ));
  const content = interaction.options.getString("text", false);
  const detection = evaluateSyntheticAntiSpam({
    rule: {
      ruleType: rule.ruleType,
      enabled: true,
      threshold: rule.threshold,
      windowSeconds: rule.windowSeconds,
    },
    ...(content === null ? {} : { content }),
    messageCount: interaction.options.getInteger("message_count", false) ?? 0,
    repetitionCount:
      interaction.options.getInteger("repetition_count", false) ?? 0,
    userMentionCount:
      interaction.options.getInteger("user_mentions", false) ?? 0,
    roleMentionCount:
      interaction.options.getInteger("role_mentions", false) ?? 0,
  });
  await replyPrivate(
    interaction,
    detection
      ? `Synthetic test would trigger **${detection.ruleType}** at ${detection.observedCount}/${detection.threshold}. No Discord action was performed.`
      : "Synthetic test did not reach the configured threshold. No Discord action was performed.",
  );
}

async function showStatus(
  interaction: ChatInputCommandInteraction,
  storage: AutomodStorage,
): Promise<void> {
  const configuration = storage.getModerationConfiguration();
  const rules = storage.listAntiSpamRules();
  await replyPrivate(
    interaction,
    [
      "**Superior anti-spam status**",
      `Global enforcement: **${configuration?.antiSpamEnabled ? "enabled" : "disabled"}**${configuration ? "" : " (moderation is not configured)"}`,
      ...(rules.length
        ? rules.map(
            (rule) =>
              `• **${rule.ruleType}** · ${rule.enabled ? "enabled" : "disabled"} · threshold ${rule.threshold} · ${rule.action}`,
          )
        : ["No rules configured; anti-spam remains disabled by default."]),
      `Exempt roles: **${storage.listAntiSpamExemptRoleIds().length}**`,
      `Exempt channels: **${storage.listAntiSpamExemptChannelIds().length}**`,
    ].join("\n"),
  );
}
function parseRuleType(value: string): AntiSpamRuleType | null {
  return (ANTI_SPAM_RULE_TYPES as readonly string[]).includes(value)
    ? (value as AntiSpamRuleType)
    : null;
}
async function stillAuthorized(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actorId: string,
): Promise<boolean> {
  const decision = await authorizeCapability({
    guild: interaction.guild!,
    userId: actorId,
    capability: "moderation.configure",
    grants: runtime.storage,
  });
  return decision.allowed && runtime.isCurrent();
}
async function deferPrivate(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.deferred && !interaction.replied)
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
}
async function replyPrivate(
  interaction: ChatInputCommandInteraction,
  content: string,
): Promise<void> {
  if (interaction.deferred && !interaction.replied)
    await interaction.editReply({
      content: content.slice(0, 2_000),
      allowedMentions: { parse: [] },
    });
  else if (interaction.replied)
    await interaction.followUp({
      content: content.slice(0, 2_000),
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  else
    await interaction.reply({
      content: content.slice(0, 2_000),
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
}
