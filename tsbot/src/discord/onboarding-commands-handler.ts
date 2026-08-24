import {
  MessageFlags,
  PermissionFlagsBits,
  escapeMarkdown,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type Role,
} from "discord.js";
import { classifyError } from "../errors.js";
import type { GuildRuntime } from "../runtime.js";
import { createOpaqueStorageId } from "../storage/operational-repository.js";
import type {
  OnboardingAutorole,
  OnboardingAutoroleAudience,
  OnboardingConfiguration,
  OnboardingConfigurationInput,
  OnboardingRoleOperationKind,
  OnboardingRulesVersion,
  PostedPanel,
} from "../types.js";
import { authorizeCapability } from "./authorization.js";
import { KeyedSerialQueue } from "./keyed-serial-queue.js";
import { runPanelPostSerial } from "./panel-post-queue.js";
import type {
  MemberLifecycleDeliveryOutcome,
  MemberLifecycleResult,
  MemberLifecycleRoleOutcome,
} from "./member-lifecycle-service.js";
import {
  deliverPrivateLifecycleLog,
  retryGuildMemberLifecycle,
} from "./member-lifecycle-discord.js";
import {
  fetchOnboardingRole,
  inspectAssignableOnboardingRole,
  inspectOnboardingChannel,
  inspectRemovableOnboardingRole,
} from "./onboarding-permissions.js";
import {
  DEFAULT_FAREWELL_TEMPLATE,
  DEFAULT_WELCOME_TEMPLATE,
  normalizeOnboardingTemplatePair,
} from "./onboarding-template.js";
import {
  buildVerificationPanelPayload,
  createVerificationAcceptCustomId,
  normalizeRulesBody,
  normalizeRulesTitle,
} from "./verification-components.js";

type ConfigurationPatch = Partial<
  Omit<OnboardingConfigurationInput, "actorId">
>;

type RecoveryRoleStatus =
  "completed" | "no-change" | "effect-failed" | "stale" | "record-incomplete";

interface RecoveryRoleResult {
  readonly roleId: string;
  readonly kind: OnboardingRoleOperationKind;
  readonly status: RecoveryRoleStatus;
  readonly effectSucceeded: boolean;
  readonly recordCompleted: boolean;
}

type RecoveryRoleGuard = () => Promise<GuildMember | null>;

interface VerificationPanelDefinition {
  readonly configuration: OnboardingConfiguration;
  readonly rules: OnboardingRulesVersion;
}

interface PostedPanelBindingSnapshot {
  readonly guildId: string;
  readonly panelId: string;
  readonly preset: PostedPanel["preset"];
  readonly channelId: string;
  readonly messageId: string;
  readonly configurationJson: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const pendingVerificationPanelPosts = new Map<string, number>();
const onboardingConfigurationQueue = new KeyedSerialQueue();

export async function handleOnboardingCommand(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  expectedActor: GuildMember,
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  const execute = async (): Promise<void> => {
    const actor = await refreshActor(interaction, runtime, expectedActor);
    if (!actor) return;
    switch (subcommand) {
      case "status":
        await showStatus(interaction, runtime, actor);
        return;
      case "configure":
        await configureLifecycle(interaction, runtime, actor);
        return;
      case "welcome":
        await configureWelcome(interaction, runtime, actor);
        return;
      case "farewell":
        await configureFarewell(interaction, runtime, actor);
        return;
      case "rules":
        await configureRules(interaction, runtime, actor);
        return;
      case "verification":
        await configureVerification(interaction, runtime, actor);
        return;
      case "autorole":
        await configureAutorole(interaction, runtime, actor);
        return;
      case "panel":
        await postVerificationPanel(interaction, runtime, actor);
        return;
      case "member":
        await showMember(interaction, runtime);
        return;
      case "recover":
        await recoverMember(interaction, runtime, actor);
        return;
      case "disable": {
        const disabled = runtime.storage.disableOnboardingConfiguration(
          actor.id,
        );
        await replyPrivate(
          interaction,
          disabled
            ? "Disabled welcome, farewell, verification, and automatic-role delivery. Stored history and member roles were preserved."
            : "Onboarding has not been configured in this server.",
        );
        runtime.storage.recordCommandMetric("onboarding.disable");
        return;
      }
      default:
        await replyPrivate(
          interaction,
          "Choose a supported onboarding action.",
        );
    }
  };
  try {
    if (isOnboardingConfigurationMutation(subcommand))
      await onboardingConfigurationQueue.run(runtime.guildId, execute);
    else await execute();
  } catch (error) {
    runtime.storage.recordCommandMetric("onboarding.command", false);
    await replyPrivate(interaction, safeError(error));
  }
}

function isOnboardingConfigurationMutation(subcommand: string): boolean {
  return [
    "configure",
    "welcome",
    "farewell",
    "rules",
    "verification",
    "autorole",
    "disable",
  ].includes(subcommand);
}

async function configureLifecycle(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
): Promise<void> {
  const current = runtime.storage.getOnboardingConfiguration();
  const selectedLog = interaction.options.getChannel("log_channel", false);
  const clearLog =
    interaction.options.getBoolean("clear_log_channel", false) ?? false;
  if (selectedLog && clearLog)
    throw new TypeError(
      "Choose a lifecycle log channel or clear it, not both.",
    );
  let lifecycleLogChannelId = current?.lifecycleLogChannelId ?? null;
  let lifecycleLogChannelVerifiedAt =
    current?.lifecycleLogChannelVerifiedAt ?? null;
  if (selectedLog) {
    const channel = await requireOnboardingChannel(
      interaction.guild!,
      selectedLog.id,
      "the lifecycle log channel",
    );
    const everyonePermissions = channel.permissionsFor(
      interaction.guild!.roles.everyone,
    );
    if (
      !everyonePermissions ||
      everyonePermissions.has(PermissionFlagsBits.ViewChannel)
    )
      throw new TypeError(
        "The lifecycle log channel must be private from @everyone.",
      );
    lifecycleLogChannelId = channel.id;
    lifecycleLogChannelVerifiedAt = now();
  } else if (clearLog) {
    lifecycleLogChannelId = null;
    lifecycleLogChannelVerifiedAt = null;
  }
  const clearAge =
    interaction.options.getBoolean("clear_account_age_alert", false) ?? false;
  const selectedAge = interaction.options.getInteger(
    "account_age_alert_hours",
    false,
  );
  if (clearAge && selectedAge !== null)
    throw new TypeError(
      "Provide an account-age threshold or clear it, not both.",
    );
  const enabled =
    interaction.options.getBoolean("enabled", false) ??
    current?.enabled ??
    false;
  const freshness: ConfigurationPatch = {};
  if (enabled) {
    if (current?.welcomePublicEnabled) {
      await requireOnboardingChannel(
        interaction.guild!,
        current.welcomeChannelId,
        "the welcome channel",
      );
      freshness.welcomeChannelVerifiedAt = now();
    }
    if (current?.farewellPublicEnabled) {
      await requireOnboardingChannel(
        interaction.guild!,
        current.farewellChannelId,
        "the farewell channel",
      );
      freshness.farewellChannelVerifiedAt = now();
    }
    if (lifecycleLogChannelId) {
      const channel = await requireOnboardingChannel(
        interaction.guild!,
        lifecycleLogChannelId,
        "the lifecycle log channel",
      );
      const everyonePermissions = channel.permissionsFor(
        interaction.guild!.roles.everyone,
      );
      if (
        !everyonePermissions ||
        everyonePermissions.has(PermissionFlagsBits.ViewChannel)
      ) {
        throw new TypeError(
          "The lifecycle log channel must remain private from @everyone.",
        );
      }
      lifecycleLogChannelVerifiedAt = now();
    }
    if (current?.rulesChannelId) {
      await requireOnboardingChannel(
        interaction.guild!,
        current.rulesChannelId,
        "the rules channel",
      );
      freshness.rulesChannelVerifiedAt = now();
    }
  }
  const saved = upsertConfiguration(runtime, actor.id, {
    enabled,
    lifecycleLogChannelId,
    lifecycleLogChannelVerifiedAt,
    accountAgeAlertHours: clearAge
      ? null
      : (selectedAge ?? current?.accountAgeAlertHours ?? null),
    ...freshness,
  });
  await replyPrivate(
    interaction,
    `Updated onboarding lifecycle settings. Processing is **${saved.enabled ? "enabled" : "disabled"}**; account-age alerts are informational only and never trigger punishment.`,
  );
  runtime.storage.recordCommandMetric("onboarding.configure");
}

async function configureWelcome(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
): Promise<void> {
  const current = runtime.storage.getOnboardingConfiguration();
  const selected = interaction.options.getChannel("channel", false);
  const clear = interaction.options.getBoolean("clear_channel", false) ?? false;
  if (selected && clear)
    throw new TypeError("Choose a welcome channel or clear it, not both.");
  let channelId = current?.welcomeChannelId ?? null;
  let verifiedAt = current?.welcomeChannelVerifiedAt ?? null;
  if (selected) {
    channelId = (
      await requireOnboardingChannel(
        interaction.guild!,
        selected.id,
        "the welcome channel",
      )
    ).id;
    verifiedAt = now();
  } else if (clear) {
    channelId = null;
    verifiedAt = null;
  }
  const publicEnabled = clear
    ? false
    : (interaction.options.getBoolean("public_enabled", false) ??
      current?.welcomePublicEnabled ??
      false);
  if (publicEnabled) {
    const channel = await requireOnboardingChannel(
      interaction.guild!,
      channelId,
      "the welcome channel",
    );
    channelId = channel.id;
    verifiedAt = now();
  }
  const template = normalizeOnboardingTemplatePair(
    interaction.options.getString("title", false) ??
      current?.welcomeTitle ??
      DEFAULT_WELCOME_TEMPLATE.title,
    interaction.options.getString("body", false) ??
      current?.welcomeBody ??
      DEFAULT_WELCOME_TEMPLATE.body,
  );
  const saved = upsertConfiguration(runtime, actor.id, {
    welcomeChannelId: channelId,
    welcomeChannelVerifiedAt: verifiedAt,
    welcomePublicEnabled: publicEnabled,
    welcomeDmEnabled:
      interaction.options.getBoolean("dm_enabled", false) ??
      current?.welcomeDmEnabled ??
      false,
    welcomeTitle: template.title,
    welcomeBody: template.body,
  });
  await replyPrivate(
    interaction,
    `Updated welcome delivery: public **${saved.welcomePublicEnabled ? "on" : "off"}**, best-effort DM **${saved.welcomeDmEnabled ? "on" : "off"}**. DM failures are recorded as delivery outcomes and never blamed on the member.`,
  );
  runtime.storage.recordCommandMetric("onboarding.welcome");
}

async function configureFarewell(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
): Promise<void> {
  const current = runtime.storage.getOnboardingConfiguration();
  const selected = interaction.options.getChannel("channel", false);
  const clear = interaction.options.getBoolean("clear_channel", false) ?? false;
  if (selected && clear)
    throw new TypeError("Choose a farewell channel or clear it, not both.");
  let channelId = current?.farewellChannelId ?? null;
  let verifiedAt = current?.farewellChannelVerifiedAt ?? null;
  if (selected) {
    channelId = (
      await requireOnboardingChannel(
        interaction.guild!,
        selected.id,
        "the farewell channel",
      )
    ).id;
    verifiedAt = now();
  } else if (clear) {
    channelId = null;
    verifiedAt = null;
  }
  const publicEnabled = clear
    ? false
    : (interaction.options.getBoolean("public_enabled", false) ??
      current?.farewellPublicEnabled ??
      false);
  if (publicEnabled) {
    const channel = await requireOnboardingChannel(
      interaction.guild!,
      channelId,
      "the farewell channel",
    );
    channelId = channel.id;
    verifiedAt = now();
  }
  const template = normalizeOnboardingTemplatePair(
    interaction.options.getString("title", false) ??
      current?.farewellTitle ??
      DEFAULT_FAREWELL_TEMPLATE.title,
    interaction.options.getString("body", false) ??
      current?.farewellBody ??
      DEFAULT_FAREWELL_TEMPLATE.body,
  );
  const saved = upsertConfiguration(runtime, actor.id, {
    farewellChannelId: channelId,
    farewellChannelVerifiedAt: verifiedAt,
    farewellPublicEnabled: publicEnabled,
    farewellTitle: template.title,
    farewellBody: template.body,
  });
  await replyPrivate(
    interaction,
    `Updated public farewell delivery: **${saved.farewellPublicEnabled ? "on" : "off"}**. Farewells contain only the bounded public template and lifecycle facts.`,
  );
  runtime.storage.recordCommandMetric("onboarding.farewell");
}

async function configureRules(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
): Promise<void> {
  const selectedChannel = interaction.options.getChannel("channel", false);
  const clearChannel =
    interaction.options.getBoolean("clear_channel", false) ?? false;
  if (selectedChannel && clearChannel)
    throw new TypeError("Choose a rules channel or clear it, not both.");
  let selectedRulesChannelId: string | null = null;
  let selectedRulesChannelVerifiedAt: string | null = null;
  if (selectedChannel) {
    selectedRulesChannelId = (
      await requireOnboardingChannel(
        interaction.guild!,
        selectedChannel.id,
        "the rules channel",
      )
    ).id;
    selectedRulesChannelVerifiedAt = now();
  }
  const latest = runtime.storage.getOnboardingConfiguration();
  const nextConfiguration = buildConfigurationInput(runtime, actor.id, {
    rulesChannelId: clearChannel
      ? null
      : selectedChannel
        ? selectedRulesChannelId
        : (latest?.rulesChannelId ?? null),
    rulesChannelVerifiedAt: clearChannel
      ? null
      : selectedChannel
        ? selectedRulesChannelVerifiedAt
        : (latest?.rulesChannelVerifiedAt ?? null),
  });
  const {
    currentRulesVersion: _previousRulesVersion,
    ...configurationWithoutRulesVersion
  } = nextConfiguration;
  const { rules } = runtime.storage.createAndActivateOnboardingRulesVersion({
    rules: {
      title: normalizeRulesTitle(interaction.options.getString("title", true)),
      body: normalizeRulesBody(interaction.options.getString("body", true)),
      reacceptanceRequested:
        interaction.options.getBoolean("request_reacceptance", false) ?? false,
      actorId: actor.id,
    },
    configuration: configurationWithoutRulesVersion,
  });
  await replyPrivate(
    interaction,
    `Created immutable rules version **${rules.rulesVersion}**. Prior acknowledgement history and existing Discord roles were preserved; post a current verification panel before requesting acknowledgement.`,
  );
  runtime.storage.recordCommandMetric("onboarding.rules");
}

async function configureVerification(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
): Promise<void> {
  const current = runtime.storage.getOnboardingConfiguration();
  const enabled = interaction.options.getBoolean("enabled", true);
  const selectedVerified = interaction.options.getRole("verified_role", false);
  const selectedUnverified = interaction.options.getRole(
    "unverified_role",
    false,
  );
  const clearUnverified =
    interaction.options.getBoolean("clear_unverified_role", false) ?? false;
  if (selectedUnverified && clearUnverified)
    throw new TypeError("Choose an unverified role or clear it, not both.");
  let verifiedRoleId = current?.verifiedRoleId ?? null;
  let unverifiedRoleId = clearUnverified
    ? null
    : (current?.unverifiedRoleId ?? null);
  if (selectedVerified)
    verifiedRoleId = (
      await requireAssignableRole(
        interaction.guild!,
        selectedVerified.id,
        actor,
      )
    ).id;
  if (selectedUnverified)
    unverifiedRoleId = (
      await requireRemovableRole(
        interaction.guild!,
        selectedUnverified.id,
        actor,
      )
    ).id;
  let verifiedAt: string | null = null;
  if (enabled) {
    if (!current?.currentRulesVersion)
      throw new Error("Create a rules version before enabling verification.");
    if (!selectedVerified)
      verifiedRoleId = (
        await requireAssignableRole(interaction.guild!, verifiedRoleId, actor)
      ).id;
    if (unverifiedRoleId && !selectedUnverified)
      unverifiedRoleId = (
        await requireRemovableRole(interaction.guild!, unverifiedRoleId, actor)
      ).id;
    if (verifiedRoleId === unverifiedRoleId)
      throw new TypeError("Verified and unverified roles must be different.");
    verifiedAt = now();
  }
  const verificationRoleIds = new Set(
    [verifiedRoleId, unverifiedRoleId].filter(
      (roleId): roleId is string => roleId !== null,
    ),
  );
  const conflictingAutorole = runtime.storage
    .listOnboardingAutoroles(undefined, 20, 0)
    .find((role) => verificationRoleIds.has(role.roleId));
  if (conflictingAutorole) {
    throw new TypeError(
      `Verification roles cannot also be automatic roles. Remove <@&${conflictingAutorole.roleId}> from the automatic-role list first.`,
    );
  }
  const saved = upsertConfiguration(runtime, actor.id, {
    enabled: enabled ? true : (current?.enabled ?? false),
    verificationEnabled: enabled,
    verifiedRoleId,
    unverifiedRoleId,
    verificationRolesVerifiedAt: verifiedAt,
  });
  await replyPrivate(
    interaction,
    enabled
      ? `Enabled rules acknowledgement for version ${saved.currentRulesVersion}. Superior always adds the verified role before attempting to remove the unverified role.`
      : "Disabled new verification acknowledgements. Superior did not remove any member roles or acknowledgement history.",
  );
  runtime.storage.recordCommandMetric("onboarding.verification");
}

async function configureAutorole(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
): Promise<void> {
  const audience = interaction.options.getString(
    "audience",
    true,
  ) as OnboardingAutoroleAudience;
  const action = interaction.options.getString("action", true);
  const current = runtime.storage.listOnboardingAutoroles(audience, 10, 0);
  if (action === "list") {
    await replyPrivate(
      interaction,
      current.length === 0
        ? `No ${audience} automatic roles are configured.`
        : [
            `**${audience === "human" ? "Human" : "Bot"} automatic roles**`,
            ...current.map(
              (role) =>
                `• <@&${role.roleId}> — ${role.enabled ? "enabled" : "disabled"}`,
            ),
          ].join("\n"),
    );
    runtime.storage.recordCommandMetric("onboarding.autorole.list");
    return;
  }
  const selected = interaction.options.getRole("role", false);
  const selectedRoleId = interaction.options.getString("role_id", false);
  if (selected && selectedRoleId)
    throw new TypeError(
      "Choose a current role or provide a deleted role ID, not both.",
    );
  if (action !== "add" && action !== "remove" && (selected || selectedRoleId))
    throw new TypeError("A role is used only with autorole add or remove.");
  if (action === "add" && !selected)
    throw new TypeError("Choose a current role to add.");
  if (action === "remove" && !selected && !selectedRoleId)
    throw new TypeError(
      "Choose a current role or provide its deleted role ID to remove.",
    );
  if (selectedRoleId && !/^\d{17,20}$/u.test(selectedRoleId))
    throw new TypeError("The stored role ID must be a Discord snowflake.");
  const freshSelected =
    action === "remove" && selected
      ? await fetchOnboardingRole(interaction.guild!, selected.id)
      : null;
  if (action === "remove" && selected && !freshSelected)
    throw new Error("The selected automatic role is missing or invalid.");
  const configurationBefore = runtime.storage.getOnboardingConfiguration();
  const listWasEnabled = audienceEnabled(configurationBefore, audience);
  let next: Array<
    Pick<OnboardingAutorole, "roleId" | "enabled" | "bindingsVerifiedAt">
  > = current.map(({ roleId, enabled, bindingsVerifiedAt }) => ({
    roleId,
    enabled,
    bindingsVerifiedAt,
  }));
  if (action === "add") {
    const role = await requireAssignableRole(
      interaction.guild!,
      selected!.id,
      actor,
    );
    if (next.some((item) => item.roleId === role.id))
      throw new TypeError("That role is already in this automatic-role list.");
    if (next.length >= 10)
      throw new RangeError(
        "Each automatic-role audience is limited to 10 roles.",
      );
    next.push(
      asAutorole(role.id, listWasEnabled, listWasEnabled ? now() : null),
    );
  } else if (action === "remove") {
    const before = next.length;
    const roleId = freshSelected?.id ?? selectedRoleId!;
    next = next.filter((item) => item.roleId !== roleId);
    if (next.length === before)
      throw new Error("That role is not in this automatic-role list.");
  } else if (action === "enable") {
    if (next.length === 0)
      throw new Error("Add at least one safe role before enabling this list.");
    for (const item of next)
      await requireAssignableRole(interaction.guild!, item.roleId, actor);
    const verifiedAt = now();
    next = next.map((item) => asAutorole(item.roleId, true, verifiedAt));
  } else if (action === "disable") {
    next = next.map((item) => asAutorole(item.roleId, false, null));
  } else {
    throw new TypeError("Choose list, add, remove, enable, or disable.");
  }
  const configuration = runtime.storage.getOnboardingConfiguration();
  const conflictingRole = next.find(
    ({ roleId }) =>
      roleId === configuration?.verifiedRoleId ||
      roleId === configuration?.unverifiedRoleId,
  );
  if (conflictingRole) {
    throw new TypeError(
      `Automatic roles cannot also be verification roles. Change verification or remove <@&${conflictingRole.roleId}> from this list first.`,
    );
  }
  const saved = runtime.storage.replaceOnboardingAutoroles(
    audience,
    next.map(({ roleId, enabled, bindingsVerifiedAt }) => ({
      roleId,
      enabled,
      bindingsVerifiedAt,
    })),
    actor.id,
  );
  const enabled =
    action === "enable"
      ? true
      : action === "disable"
        ? false
        : action === "remove" && saved.length === 0
          ? false
          : listWasEnabled;
  upsertConfiguration(runtime, actor.id, {
    enabled: enabled
      ? true
      : (runtime.storage.getOnboardingConfiguration()?.enabled ?? false),
    ...(audience === "human"
      ? { humanAutorolesEnabled: enabled }
      : { botAutorolesEnabled: enabled }),
  });
  await replyPrivate(
    interaction,
    `Updated the ${audience} automatic-role list (${saved.length}/10). Delivery is **${enabled ? "enabled" : "disabled"}** and never runs while a human is pending Discord Membership Screening.`,
  );
  runtime.storage.recordCommandMetric(`onboarding.autorole.${action}`);
}

async function postVerificationPanel(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
): Promise<void> {
  const guild = interaction.guild!;
  const selected = interaction.options.getChannel("channel", true);
  if (
    actor.guild.id !== runtime.guildId ||
    guild.id !== runtime.guildId ||
    interaction.guildId !== runtime.guildId
  )
    throw new Error("That verification panel target is outside this server.");
  const key = `${runtime.guildId}:verification:${selected.id}`;
  const expectedBinding = snapshotPostedPanelBinding(
    runtime.storage.findPostedPanelByPresetAndChannel(
      "verification",
      selected.id,
    ),
  );
  const alreadyPending = (pendingVerificationPanelPosts.get(key) ?? 0) > 0;
  pendingVerificationPanelPosts.set(
    key,
    (pendingVerificationPanelPosts.get(key) ?? 0) + 1,
  );
  try {
    await runPanelPostSerial(
      runtime.guildId,
      "verification",
      selected.id,
      async () => {
        if (alreadyPending)
          throw new Error(
            "Another verification panel post is already in progress for that channel. Try again after it finishes.",
          );
        await postVerificationPanelSerial(
          interaction,
          runtime,
          actor.id,
          selected.id,
          interaction.options.getBoolean("replace_existing", false) === true,
          expectedBinding,
        );
      },
    );
  } finally {
    const remaining = (pendingVerificationPanelPosts.get(key) ?? 1) - 1;
    if (remaining <= 0) pendingVerificationPanelPosts.delete(key);
    else pendingVerificationPanelPosts.set(key, remaining);
  }
}

async function postVerificationPanelSerial(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actorId: string,
  channelId: string,
  replaceExisting: boolean,
  expectedBinding: PostedPanelBindingSnapshot | null,
): Promise<void> {
  const guild = interaction.guild!;
  assertUnchangedPostedPanelBinding(runtime, channelId, expectedBinding);
  if (expectedBinding && !replaceExisting)
    throw new Error(
      "A verification panel is already tracked in that channel. Enable replace_existing to refresh it.",
    );
  const definition = readVerificationPanelDefinition(runtime);
  if (!definition)
    throw new Error(
      "Enable and verify current rules and verification roles before posting a panel.",
    );
  const prepared = await prepareVerificationPanelCommit(
    guild,
    runtime,
    actorId,
    channelId,
    definition,
  );
  assertUnchangedPostedPanelBinding(runtime, channelId, expectedBinding);
  const panelId = expectedBinding?.panelId ?? createOpaqueStorageId();
  const payload = buildVerificationPanelPayload({
    panelId,
    rulesVersion: prepared.definition.rules.rulesVersion,
    rulesTitle: prepared.definition.rules.title,
    rulesBody: prepared.definition.rules.body,
    reacceptanceRequested: prepared.definition.rules.reacceptanceRequested,
  });
  const message = await prepared.channel.send(payload);
  let finalDefinition: VerificationPanelDefinition;
  try {
    const final = await prepareVerificationPanelCommit(
      guild,
      runtime,
      actorId,
      channelId,
      prepared.definition,
    );
    finalDefinition = final.definition;
    if (final.channel.id !== prepared.channel.id)
      throw new Error(
        "The verification panel channel changed while the panel was being posted.",
      );
    assertUnchangedPostedPanelBinding(runtime, channelId, expectedBinding);
    runtime.storage.upsertPostedPanel({
      panelId,
      preset: "verification",
      channelId,
      messageId: message.id,
      configuration: {
        rulesVersion: finalDefinition.rules.rulesVersion,
        bindingsVerifiedAt:
          finalDefinition.configuration.verificationRolesVerifiedAt,
      },
    });
  } catch (error) {
    await message.delete().catch(() => undefined);
    throw error;
  }
  if (expectedBinding && expectedBinding.messageId !== message.id)
    await prepared.channel.messages
      .fetch(expectedBinding.messageId)
      .then((prior) => prior?.delete())
      .catch(() => undefined);
  await replyPrivate(
    interaction,
    `Posted the current verification panel in <#${channelId}> for rules version ${finalDefinition.rules.rulesVersion}.`,
  );
  runtime.storage.recordCommandMetric("onboarding.panel");
}

async function prepareVerificationPanelCommit(
  guild: Guild,
  runtime: GuildRuntime,
  actorId: string,
  channelId: string,
  expected: VerificationPanelDefinition,
): Promise<{
  readonly channel: GuildTextBasedChannel;
  readonly definition: VerificationPanelDefinition;
}> {
  if (guild.id !== runtime.guildId)
    throw new Error("That verification panel target is outside this server.");
  const authorization = await authorizeCapability({
    guild,
    userId: actorId,
    capability: "onboarding.configure",
    grants: runtime.storage,
  });
  if (!authorization.allowed || authorization.member.id !== actorId)
    throw new Error(
      "Your onboarding authority changed before the panel could be posted.",
    );
  const [channel] = await Promise.all([
    requireOnboardingChannel(
      guild,
      channelId,
      "the verification panel channel",
    ),
    requireAssignableRole(
      guild,
      expected.configuration.verifiedRoleId,
      authorization.member,
    ),
    ...(expected.configuration.unverifiedRoleId
      ? [
          requireRemovableRole(
            guild,
            expected.configuration.unverifiedRoleId,
            authorization.member,
          ),
        ]
      : []),
  ]);
  const current = readVerificationPanelDefinition(runtime);
  if (!current || !sameVerificationPanelDefinition(expected, current))
    throw new Error(
      "The verification configuration changed while the panel was being posted. Try again with the current rules.",
    );
  if (!runtime.isCurrent())
    throw new Error("This server changed while the panel was being posted.");
  return { channel, definition: current };
}

function readVerificationPanelDefinition(
  runtime: GuildRuntime,
): VerificationPanelDefinition | null {
  const configuration = runtime.storage.getOnboardingConfiguration();
  const rules = runtime.storage.getCurrentOnboardingRulesVersion();
  if (
    !configuration?.enabled ||
    configuration.guildId !== runtime.guildId ||
    !configuration.verificationEnabled ||
    !configuration.currentRulesVersion ||
    !configuration.verifiedRoleId ||
    !configuration.verificationRolesVerifiedAt ||
    !rules ||
    rules.guildId !== runtime.guildId ||
    rules.rulesVersion !== configuration.currentRulesVersion
  )
    return null;
  return { configuration, rules };
}

function sameVerificationPanelDefinition(
  left: VerificationPanelDefinition,
  right: VerificationPanelDefinition,
): boolean {
  return (
    verificationPanelDefinitionFingerprint(left) ===
    verificationPanelDefinitionFingerprint(right)
  );
}

function verificationPanelDefinitionFingerprint(
  definition: VerificationPanelDefinition,
): string {
  const configuration = definition.configuration;
  const rules = definition.rules;
  return JSON.stringify([
    configuration.guildId,
    configuration.enabled,
    configuration.welcomeChannelId,
    configuration.welcomePublicEnabled,
    configuration.welcomeDmEnabled,
    configuration.farewellChannelId,
    configuration.farewellPublicEnabled,
    configuration.lifecycleLogChannelId,
    configuration.rulesChannelId,
    configuration.verificationEnabled,
    configuration.currentRulesVersion,
    configuration.verifiedRoleId,
    configuration.unverifiedRoleId,
    configuration.humanAutorolesEnabled,
    configuration.botAutorolesEnabled,
    configuration.accountAgeAlertHours,
    configuration.welcomeTitle,
    configuration.welcomeBody,
    configuration.farewellTitle,
    configuration.farewellBody,
    configuration.welcomeChannelVerifiedAt,
    configuration.farewellChannelVerifiedAt,
    configuration.lifecycleLogChannelVerifiedAt,
    configuration.rulesChannelVerifiedAt,
    configuration.verificationRolesVerifiedAt,
    configuration.createdBy,
    configuration.updatedBy,
    configuration.createdAt,
    configuration.updatedAt,
    rules.guildId,
    rules.rulesVersion,
    rules.title,
    rules.body,
    rules.reacceptanceRequested,
    rules.createdBy,
    rules.createdAt,
  ]);
}

function snapshotPostedPanelBinding(
  panel: PostedPanel | null,
): PostedPanelBindingSnapshot | null {
  if (!panel) return null;
  return {
    guildId: panel.guildId,
    panelId: panel.panelId,
    preset: panel.preset,
    channelId: panel.channelId,
    messageId: panel.messageId,
    configurationJson: JSON.stringify(panel.configuration),
    createdAt: panel.createdAt,
    updatedAt: panel.updatedAt,
  };
}

function assertUnchangedPostedPanelBinding(
  runtime: GuildRuntime,
  channelId: string,
  expected: PostedPanelBindingSnapshot | null,
): void {
  const current = snapshotPostedPanelBinding(
    runtime.storage.findPostedPanelByPresetAndChannel(
      "verification",
      channelId,
    ),
  );
  if (JSON.stringify(current) !== JSON.stringify(expected))
    throw new Error(
      "The tracked verification panel changed while this post was in progress. No new binding was retained; try again with the current panel state.",
    );
}

async function showStatus(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
): Promise<void> {
  const configuration = runtime.storage.getOnboardingConfiguration();
  if (!configuration) {
    await replyPrivate(
      interaction,
      "Onboarding has not been configured in this server.",
    );
    return;
  }
  const issues: string[] = [];
  for (const [id, label, verified, privateFromEveryone] of [
    [
      configuration.welcomeChannelId,
      "Welcome channel",
      configuration.welcomeChannelVerifiedAt,
      false,
    ],
    [
      configuration.farewellChannelId,
      "Farewell channel",
      configuration.farewellChannelVerifiedAt,
      false,
    ],
    [
      configuration.lifecycleLogChannelId,
      "Lifecycle log channel",
      configuration.lifecycleLogChannelVerifiedAt,
      true,
    ],
    [
      configuration.rulesChannelId,
      "Rules channel",
      configuration.rulesChannelVerifiedAt,
      false,
    ],
  ] as const) {
    if (!id) continue;
    const inspection = await inspectOnboardingChannel(
      interaction.guild!,
      id,
      label,
    );
    issues.push(...inspection.issues.map((issue) => `${label}: ${issue}`));
    if (!inspection.channel) continue;
    if (!verified) issues.push(`${label} is stored but not verified.`);
    if (privateFromEveryone) {
      const everyonePermissions = inspection.channel.permissionsFor(
        interaction.guild!.roles.everyone,
      );
      if (
        !everyonePermissions ||
        everyonePermissions.has(PermissionFlagsBits.ViewChannel)
      ) {
        issues.push(
          "Lifecycle log channel must remain private from @everyone.",
        );
      }
    }
  }
  if (configuration.verifiedRoleId) {
    const inspection = await inspectAssignableOnboardingRole(
      interaction.guild!,
      configuration.verifiedRoleId,
      actor,
    );
    issues.push(...inspection.issues.map((issue) => `Verified role: ${issue}`));
  }
  if (configuration.unverifiedRoleId) {
    const inspection = await inspectRemovableOnboardingRole(
      interaction.guild!,
      configuration.unverifiedRoleId,
      actor,
    );
    issues.push(
      ...inspection.issues.map((issue) => `Unverified role: ${issue}`),
    );
  }
  for (const autorole of runtime.storage.listOnboardingAutoroles(
    undefined,
    20,
    0,
  )) {
    const inspection = await inspectAssignableOnboardingRole(
      interaction.guild!,
      autorole.roleId,
      actor,
    );
    issues.push(
      ...inspection.issues.map(
        (issue) => `Autorole ${autorole.roleId}: ${issue}`,
      ),
    );
  }
  const panels = runtime.storage.listPostedPanels("verification", 25, 0);
  let livePanels = 0;
  for (const panel of panels) {
    const label = `Verification panel ${panel.panelId}`;
    const inspection = await inspectOnboardingChannel(
      interaction.guild!,
      panel.channelId,
      label,
    );
    if (!inspection.channel || inspection.issues.length > 0) {
      issues.push(...inspection.issues.map((issue) => `${label}: ${issue}`));
      continue;
    }
    if (
      !isCurrentVerificationPanelConfiguration(
        panel.configuration,
        configuration,
      )
    ) {
      issues.push(`${label} is bound to stale rules or role verification.`);
      continue;
    }
    const message = await inspection.channel.messages
      .fetch(panel.messageId)
      .catch(() => null);
    const expectedCustomId = createVerificationAcceptCustomId(
      panel.panelId,
      configuration.currentRulesVersion!,
    );
    if (
      !message ||
      message.id !== panel.messageId ||
      message.channelId !== panel.channelId ||
      message.guildId !== runtime.guildId ||
      message.author.id !== interaction.client.user?.id ||
      !message.author.bot
    ) {
      issues.push(`${label} message is missing or has the wrong identity.`);
      continue;
    }
    if (!componentTreeHasCustomId(message.components, expectedCustomId)) {
      issues.push(`${label} controls are stale or missing.`);
      continue;
    }
    livePanels += 1;
  }
  await replyPrivate(
    interaction,
    [
      "**Onboarding status**",
      `Lifecycle processing: **${configuration.enabled ? "enabled" : "disabled"}**`,
      `Welcome: public ${configuration.welcomePublicEnabled ? "on" : "off"}, DM ${configuration.welcomeDmEnabled ? "on" : "off"}`,
      `Farewell: public ${configuration.farewellPublicEnabled ? "on" : "off"}`,
      `Verification: ${configuration.verificationEnabled ? `on · rules v${configuration.currentRulesVersion ?? "none"}` : "off"}`,
      `Automatic roles: humans ${configuration.humanAutorolesEnabled ? "on" : "off"}, bots ${configuration.botAutorolesEnabled ? "on" : "off"}`,
      `Live verification panels: ${livePanels}/${panels.length} tracked`,
      issues.length === 0
        ? "Bindings: healthy"
        : `Bindings need attention:\n${issues
            .slice(0, 12)
            .map((issue) => `• ${issue}`)
            .join("\n")}`,
    ]
      .join("\n")
      .slice(0, 2_000),
  );
  runtime.storage.recordCommandMetric("onboarding.status", issues.length === 0);
}

function isCurrentVerificationPanelConfiguration(
  value: unknown,
  configuration: OnboardingConfiguration,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const panel = value as Record<string, unknown>;
  return (
    configuration.enabled &&
    configuration.verificationEnabled &&
    configuration.currentRulesVersion !== null &&
    configuration.verificationRolesVerifiedAt !== null &&
    panel.rulesVersion === configuration.currentRulesVersion &&
    panel.bindingsVerifiedAt === configuration.verificationRolesVerifiedAt
  );
}

function componentTreeHasCustomId(value: unknown, customId: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => componentTreeHasCustomId(item, customId));
  }
  if (!value || typeof value !== "object") return false;
  const component = value as {
    readonly customId?: unknown;
    readonly components?: unknown;
  };
  return (
    component.customId === customId ||
    componentTreeHasCustomId(component.components, customId)
  );
}

async function showMember(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const user = interaction.options.getUser("member", true);
  const member = await interaction
    .guild!.members.fetch({ user: user.id, cache: true, force: true })
    .catch(() => null);
  const state = runtime.storage.getMemberOnboardingState(user.id);
  const acceptances = runtime.storage.listMemberRuleAcceptances(user.id, 25, 0);
  const operations = runtime.storage.listOnboardingRoleOperations({
    memberId: user.id,
    states: ["reserved", "partial", "failed"],
    unresolvedOnly: true,
    limit: 25,
  });
  const deliveries = runtime.storage.listOnboardingDeliveries({
    memberId: user.id,
    states: ["reserved", "failed", "missing"],
    limit: 25,
    offset: 0,
  });
  const audits = runtime.storage.listOnboardingAuditEvents({
    memberId: user.id,
    limit: 5,
    offset: 0,
  });
  const configuration = runtime.storage.getOnboardingConfiguration();
  const configuredRoleIds = [
    configuration?.verifiedRoleId,
    configuration?.unverifiedRoleId,
    ...runtime.storage
      .listOnboardingAutoroles(undefined, 20, 0)
      .map(({ roleId }) => roleId),
  ].filter((id): id is string => Boolean(id));
  const held = member
    ? configuredRoleIds.filter((roleId) => member.roles.cache.has(roleId))
    : [];
  const currentVersion = configuration?.currentRulesVersion ?? null;
  const latest = acceptances[0] ?? null;
  const verification =
    currentVersion &&
    acceptances.some((item) => item.rulesVersion === currentVersion)
      ? `accepted current v${currentVersion}`
      : latest
        ? `accepted older v${latest.rulesVersion}`
        : "not recorded";
  const roleRecoveryBounded = operations.length === 25;
  const deliveryRecoveryBounded = deliveries.length === 25;
  const recoveryLowerBound = roleRecoveryBounded || deliveryRecoveryBounded;
  const outstandingRecoveryCount = operations.length + deliveries.length;
  await replyPrivate(
    interaction,
    [
      `**Onboarding member status — \`${user.id}\`**`,
      `Native screening: ${member ? (member.pending ? "pending" : "complete/not pending") : (state?.screeningState ?? "unavailable")}`,
      `Lifecycle state: ${state?.lifecycleState ?? "not recorded"}`,
      `Rules acknowledgement: ${verification}`,
      `Configured onboarding roles currently held: ${held.length ? held.map((id) => `<@&${id}>`).join(", ") : "none or member unavailable"}`,
      `Outstanding recovery records: ${outstandingRecoveryCount}${recoveryLowerBound ? "+" : ""} (${operations.length}${roleRecoveryBounded ? "+" : ""} role; ${deliveries.length}${deliveryRecoveryBounded ? "+" : ""} delivery)`,
      `Joined: ${state ? discordTime(state.joinedAt) : member?.joinedAt ? discordTime(member.joinedAt.toISOString()) : "unavailable"}`,
      `Account created: ${discordTime(state?.accountCreatedAt ?? user.createdAt.toISOString())}`,
      audits.length
        ? `Recent onboarding events:\n${audits.map((event) => `• ${escapeMarkdown(event.eventType)} — ${escapeMarkdown(event.outcome)}`).join("\n")}`
        : "Recent onboarding events: none",
    ]
      .join("\n")
      .slice(0, 2_000),
  );
  runtime.storage.recordCommandMetric("onboarding.member");
}

async function recoverMember(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
): Promise<void> {
  const user = interaction.options.getUser("member", true);
  const member = await interaction
    .guild!.members.fetch({ user: user.id, cache: true, force: true })
    .catch(() => null);
  if (!member)
    throw new Error("That member is no longer available in this server.");
  if (!member.user.bot && member.pending)
    throw new Error(
      "Complete Discord Membership Screening first; Superior will not bypass the pending state.",
    );
  if (
    !(await currentRecoveryActor(member.guild, runtime, actor.id, () => true))
  ) {
    throw new Error(
      "Your onboarding authority or the active configuration changed before recovery could begin.",
    );
  }
  const lifecycle = await retryGuildMemberLifecycle(runtime, member);
  const currentActor = await currentRecoveryActor(
    member.guild,
    runtime,
    actor.id,
    () => true,
  );
  const currentConfiguration = runtime.storage.getOnboardingConfiguration();
  const recoveryGuardFailed = !currentActor || !currentConfiguration?.enabled;
  const roleResults: RecoveryRoleResult[] = [];
  const verificationResults: RecoveryRoleResult[] = [];
  const acceptance =
    currentConfiguration?.currentRulesVersion === null ||
    currentConfiguration?.currentRulesVersion === undefined
      ? null
      : (runtime.storage
          .listMemberRuleAcceptances(member.id, 25, 0)
          .find(
            (item) =>
              item.rulesVersion === currentConfiguration.currentRulesVersion,
          ) ?? null);
  const verifiedRoleId = currentConfiguration?.verifiedRoleId ?? null;
  let unverifiedRoleId: string | null = null;
  let verifiedReady = verifiedRoleId === null;
  if (!recoveryGuardFailed && acceptance && verifiedRoleId) {
    const result = await recoverRole(
      runtime,
      member,
      verifiedRoleId,
      "verified-add",
      interaction.id,
      false,
      () =>
        currentRecoveryActor(member.guild, runtime, actor.id, (latest) =>
          Boolean(
            latest.verificationEnabled &&
            latest.verifiedRoleId === verifiedRoleId,
          ),
        ),
    );
    roleResults.push(result);
    verificationResults.push(result);
    verifiedReady = isFullyRecordedRoleSuccess(result);
  }
  const beforeUnverified = runtime.storage.getOnboardingConfiguration();
  if (
    !recoveryGuardFailed &&
    acceptance &&
    verifiedReady &&
    beforeUnverified?.enabled &&
    beforeUnverified.verificationEnabled &&
    beforeUnverified.verifiedRoleId === verifiedRoleId &&
    beforeUnverified.unverifiedRoleId
  ) {
    unverifiedRoleId = beforeUnverified.unverifiedRoleId;
    const result = await recoverRole(
      runtime,
      member,
      unverifiedRoleId,
      "unverified-remove",
      interaction.id,
      true,
      () =>
        currentRecoveryActor(member.guild, runtime, actor.id, (latest) =>
          Boolean(
            latest.verificationEnabled &&
            latest.verifiedRoleId === verifiedRoleId &&
            latest.unverifiedRoleId === unverifiedRoleId,
          ),
        ),
    );
    roleResults.push(result);
    verificationResults.push(result);
  }
  const audience: OnboardingAutoroleAudience = member.user.bot
    ? "bot"
    : "human";
  const beforeAutoroles = runtime.storage.getOnboardingConfiguration();
  if (!recoveryGuardFailed && audienceEnabled(beforeAutoroles, audience)) {
    for (const role of runtime.storage
      .listOnboardingAutoroles(audience, 10, 0)
      .filter(
        (item) =>
          item.enabled &&
          item.bindingsVerifiedAt &&
          item.roleId !== verifiedRoleId &&
          item.roleId !== unverifiedRoleId,
      )) {
      roleResults.push(
        await recoverRole(
          runtime,
          member,
          role.roleId,
          member.user.bot ? "bot-autorole-add" : "human-autorole-add",
          interaction.id,
          false,
          () =>
            currentRecoveryActor(member.guild, runtime, actor.id, (latest) =>
              Boolean(
                audienceEnabled(latest, audience) &&
                runtime.storage
                  .listOnboardingAutoroles(audience, 10, 0)
                  .some(
                    (current) =>
                      current.roleId === role.roleId &&
                      current.enabled &&
                      current.bindingsVerifiedAt,
                  ),
              ),
            ),
        ),
      );
    }
  }

  let verificationRecovered =
    Boolean(acceptance && verifiedRoleId) &&
    verificationResults.length > 0 &&
    verificationResults.every(isFullyRecordedRoleSuccess);
  if (verificationRecovered) {
    verificationRecovered = Boolean(
      await currentRecoveryActor(member.guild, runtime, actor.id, (latest) =>
        Boolean(
          latest.verificationEnabled &&
          latest.verifiedRoleId === verifiedRoleId &&
          latest.unverifiedRoleId === unverifiedRoleId,
        ),
      ),
    );
  }
  let verificationLogStatus: Awaited<
    ReturnType<typeof deliverPrivateLifecycleLog>
  > | null = null;
  if (verificationRecovered && acceptance) {
    verificationLogStatus = await deliverPrivateLifecycleLog(
      runtime,
      member.guild,
      `verification-recovery:${acceptance.rulesVersion}:${interaction.id}`,
      {
        kind: "verification-recovery",
        memberId: member.id,
        rulesVersion: acceptance.rulesVersion,
      },
    );
  }

  const lifecycleStatusIncomplete = !isSuccessfulLifecycleStatus(
    lifecycle.status,
  );
  const confirmedDeliveries = lifecycle.deliveries.filter(
    isConfirmedLifecycleDelivery,
  ).length;
  const failedDeliveries = lifecycle.deliveries.length - confirmedDeliveries;
  const confirmedLifecycleRoles = lifecycle.roles.filter(
    isConfirmedLifecycleRole,
  ).length;
  const failedLifecycleRoles = lifecycle.roles.length - confirmedLifecycleRoles;
  const fullyRecordedRoles = roleResults.filter(
    isFullyRecordedRoleSuccess,
  ).length;
  const effectOnlyRoles = roleResults.filter(
    (result) => result.effectSucceeded && !result.recordCompleted,
  ).length;
  const incompleteRoles = roleResults.length - fullyRecordedRoles;
  const authorityOrConfigurationChanged =
    recoveryGuardFailed ||
    roleResults.some((result) => result.status === "stale");
  const verificationLogIncomplete =
    verificationLogStatus !== null &&
    verificationLogStatus !== "delivered" &&
    verificationLogStatus !== "duplicate" &&
    verificationLogStatus !== "disabled";
  let overallPartial =
    lifecycleStatusIncomplete ||
    failedDeliveries > 0 ||
    failedLifecycleRoles > 0 ||
    incompleteRoles > 0 ||
    authorityOrConfigurationChanged ||
    verificationLogIncomplete;
  let auditRecorded = true;
  try {
    runtime.storage.appendOnboardingAudit({
      eventType: "member-recovery",
      memberId: member.id,
      actorId: actor.id,
      rulesVersion: acceptance?.rulesVersion ?? null,
      outcome: overallPartial ? "partial" : "completed",
      details: {
        lifecycleStatus: lifecycle.status,
        lifecycleStatusIncomplete,
        attemptedDeliveryCount: lifecycle.deliveries.length,
        confirmedDeliveryCount: confirmedDeliveries,
        failedDeliveryCount: failedDeliveries,
        attemptedLifecycleRoleCount: lifecycle.roles.length,
        confirmedLifecycleRoleCount: confirmedLifecycleRoles,
        failedLifecycleRoleCount: failedLifecycleRoles,
        attemptedRoleCount: roleResults.length,
        confirmedRoleCount: fullyRecordedRoles,
        effectSucceededRecordIncompleteCount: effectOnlyRoles,
        failedRoleCount: incompleteRoles,
        authorityOrConfigurationChanged,
        verificationRecovered,
        verificationLogStatus,
      },
    });
  } catch {
    auditRecorded = false;
    overallPartial = true;
  }
  await replyPrivate(
    interaction,
    [
      `Recovered bounded onboarding work for \`${member.id}\`.`,
      `Lifecycle result: ${lifecycle.status}${lifecycleStatusIncomplete ? " (incomplete)" : " (confirmed)"}.`,
      `Lifecycle deliveries: ${confirmedDeliveries}/${lifecycle.deliveries.length} confirmed, ${failedDeliveries} incomplete.`,
      `Lifecycle roles: ${confirmedLifecycleRoles}/${lifecycle.roles.length} confirmed, ${failedLifecycleRoles} incomplete.`,
      `Recovery roles: ${fullyRecordedRoles} fully recorded, ${effectOnlyRoles} Discord-confirmed with incomplete records, ${incompleteRoles - effectOnlyRoles} incomplete without a confirmed effect.`,
      `Authority/configuration recheck: ${authorityOrConfigurationChanged ? "changed" : "current"}.`,
      `Verification recovery log: ${verificationLogStatus ?? "not emitted"}.`,
      `Recovery audit: ${auditRecorded ? "recorded" : "not recorded"}.`,
      overallPartial
        ? "Overall outcome: partial. Incomplete work was not described as complete."
        : "Overall outcome: completed with every attempted effect confirmed.",
    ].join("\n"),
  );
  runtime.storage.recordCommandMetric("onboarding.recover", !overallPartial);
}

async function recoverRole(
  runtime: GuildRuntime,
  member: GuildMember,
  roleId: string,
  kind: OnboardingRoleOperationKind,
  interactionId: string,
  remove: boolean,
  guard: RecoveryRoleGuard,
): Promise<RecoveryRoleResult> {
  const actor = await guard();
  if (!actor) return recoveryRoleResult(roleId, kind, "stale", false, false);
  const inspection = remove
    ? await inspectRemovableOnboardingRole(member.guild, roleId, actor)
    : await inspectAssignableOnboardingRole(member.guild, roleId, actor);
  const role = inspection.role;
  if (!role || inspection.issues.length > 0)
    return recoveryRoleResult(roleId, kind, "effect-failed", false, false);
  let reservation;
  try {
    reservation = runtime.storage.reserveOnboardingRoleOperation({
      memberId: member.id,
      roleId,
      kind,
      idempotencyKey: `recover:${interactionId}:${kind}:${roleId}`,
    });
  } catch {
    return recoveryRoleResult(roleId, kind, "record-incomplete", false, false);
  }
  if (reservation.status !== "reserved") {
    if (
      reservation.operation.state === "completed" ||
      reservation.operation.state === "no-change"
    ) {
      const reconciled = resolveRecoveryRoleRecords(
        runtime,
        reservation.operation.operationId,
      );
      return reconciled
        ? recoveryRoleResult(roleId, kind, "no-change", true, true)
        : recoveryRoleResult(roleId, kind, "record-incomplete", true, false);
    }
    return recoveryRoleResult(roleId, kind, "stale", false, false);
  }
  const alreadyDesired = remove
    ? !member.roles.cache.has(roleId)
    : member.roles.cache.has(roleId);
  if (alreadyDesired) {
    try {
      runtime.storage.completeOnboardingRoleOperation(
        reservation.operation.operationId,
        { state: "no-change" },
      );
      const reconciled = resolveRecoveryRoleRecords(
        runtime,
        reservation.operation.operationId,
      );
      return reconciled
        ? recoveryRoleResult(roleId, kind, "no-change", true, true)
        : recoveryRoleResult(roleId, kind, "record-incomplete", true, false);
    } catch {
      return recoveryRoleResult(roleId, kind, "record-incomplete", true, false);
    }
  }
  if (!(await guard())) {
    const recorded = recordRecoveryRoleFailure(
      runtime,
      reservation.operation.operationId,
      "configuration-or-authority-changed",
    );
    return recoveryRoleResult(roleId, kind, "stale", false, recorded);
  }
  try {
    if (remove) await member.roles.remove(role, "Superior onboarding recovery");
    else await member.roles.add(role, "Superior onboarding recovery");
  } catch (error) {
    const recorded = recordRecoveryRoleFailure(
      runtime,
      reservation.operation.operationId,
      classifyError(error).category,
    );
    return recoveryRoleResult(roleId, kind, "effect-failed", false, recorded);
  }
  try {
    runtime.storage.completeOnboardingRoleOperation(
      reservation.operation.operationId,
      { state: "completed" },
    );
    const reconciled = resolveRecoveryRoleRecords(
      runtime,
      reservation.operation.operationId,
    );
    return reconciled
      ? recoveryRoleResult(roleId, kind, "completed", true, true)
      : recoveryRoleResult(roleId, kind, "record-incomplete", true, false);
  } catch {
    return recoveryRoleResult(roleId, kind, "record-incomplete", true, false);
  }
}

function resolveRecoveryRoleRecords(
  runtime: GuildRuntime,
  recoveryOperationId: string,
): boolean {
  try {
    runtime.storage.resolveOnboardingRoleOperations(recoveryOperationId);
    return true;
  } catch {
    return false;
  }
}

async function currentRecoveryActor(
  guild: Guild,
  runtime: GuildRuntime,
  actorId: string,
  configured: (configuration: OnboardingConfiguration) => boolean,
): Promise<GuildMember | null> {
  const decision = await authorizeCapability({
    guild,
    userId: actorId,
    capability: "onboarding.configure",
    grants: runtime.storage,
  });
  if (!decision.allowed || !runtime.isCurrent()) return null;
  const configuration = runtime.storage.getOnboardingConfiguration();
  return configuration?.enabled && configured(configuration)
    ? decision.member
    : null;
}

function recordRecoveryRoleFailure(
  runtime: GuildRuntime,
  operationId: string,
  failureCode: string,
): boolean {
  try {
    runtime.storage.completeOnboardingRoleOperation(operationId, {
      state: "failed",
      failureCode,
    });
    return true;
  } catch {
    return false;
  }
}

function recoveryRoleResult(
  roleId: string,
  kind: OnboardingRoleOperationKind,
  status: RecoveryRoleStatus,
  effectSucceeded: boolean,
  recordCompleted: boolean,
): RecoveryRoleResult {
  return { roleId, kind, status, effectSucceeded, recordCompleted };
}

function isFullyRecordedRoleSuccess(result: RecoveryRoleResult): boolean {
  return (
    result.recordCompleted &&
    (result.status === "completed" || result.status === "no-change")
  );
}

function isSuccessfulLifecycleStatus(
  status: MemberLifecycleResult["status"],
): boolean {
  return status === "processed" || status === "no-change";
}

function isConfirmedLifecycleDelivery(
  result: MemberLifecycleDeliveryOutcome,
): boolean {
  return result.status === "delivered" || result.status === "duplicate";
}

function isConfirmedLifecycleRole(result: MemberLifecycleRoleOutcome): boolean {
  return (
    result.status === "added" ||
    result.status === "already-held" ||
    result.status === "duplicate"
  );
}

function upsertConfiguration(
  runtime: GuildRuntime,
  actorId: string,
  patch: ConfigurationPatch,
): OnboardingConfiguration {
  return runtime.storage.upsertOnboardingConfiguration(
    buildConfigurationInput(runtime, actorId, patch),
  );
}

function buildConfigurationInput(
  runtime: GuildRuntime,
  actorId: string,
  patch: ConfigurationPatch,
): OnboardingConfigurationInput {
  const current = runtime.storage.getOnboardingConfiguration();
  const base = current ?? defaultConfiguration(runtime.guildId);
  return {
    enabled: patch.enabled ?? base.enabled,
    welcomeChannelId: value(patch, "welcomeChannelId", base.welcomeChannelId),
    welcomePublicEnabled:
      patch.welcomePublicEnabled ?? base.welcomePublicEnabled,
    welcomeDmEnabled: patch.welcomeDmEnabled ?? base.welcomeDmEnabled,
    farewellChannelId: value(
      patch,
      "farewellChannelId",
      base.farewellChannelId,
    ),
    farewellPublicEnabled:
      patch.farewellPublicEnabled ?? base.farewellPublicEnabled,
    lifecycleLogChannelId: value(
      patch,
      "lifecycleLogChannelId",
      base.lifecycleLogChannelId,
    ),
    rulesChannelId: value(patch, "rulesChannelId", base.rulesChannelId),
    verificationEnabled: patch.verificationEnabled ?? base.verificationEnabled,
    currentRulesVersion: value(
      patch,
      "currentRulesVersion",
      base.currentRulesVersion,
    ),
    verifiedRoleId: value(patch, "verifiedRoleId", base.verifiedRoleId),
    unverifiedRoleId: value(patch, "unverifiedRoleId", base.unverifiedRoleId),
    humanAutorolesEnabled:
      patch.humanAutorolesEnabled ?? base.humanAutorolesEnabled,
    botAutorolesEnabled: patch.botAutorolesEnabled ?? base.botAutorolesEnabled,
    accountAgeAlertHours: value(
      patch,
      "accountAgeAlertHours",
      base.accountAgeAlertHours,
    ),
    welcomeTitle: patch.welcomeTitle ?? base.welcomeTitle,
    welcomeBody: patch.welcomeBody ?? base.welcomeBody,
    farewellTitle: patch.farewellTitle ?? base.farewellTitle,
    farewellBody: patch.farewellBody ?? base.farewellBody,
    welcomeChannelVerifiedAt: value(
      patch,
      "welcomeChannelVerifiedAt",
      base.welcomeChannelVerifiedAt,
    ),
    farewellChannelVerifiedAt: value(
      patch,
      "farewellChannelVerifiedAt",
      base.farewellChannelVerifiedAt,
    ),
    lifecycleLogChannelVerifiedAt: value(
      patch,
      "lifecycleLogChannelVerifiedAt",
      base.lifecycleLogChannelVerifiedAt,
    ),
    rulesChannelVerifiedAt: value(
      patch,
      "rulesChannelVerifiedAt",
      base.rulesChannelVerifiedAt,
    ),
    verificationRolesVerifiedAt: value(
      patch,
      "verificationRolesVerifiedAt",
      base.verificationRolesVerifiedAt,
    ),
    actorId,
  };
}

function defaultConfiguration(guildId: string): OnboardingConfiguration {
  const timestamp = now();
  return {
    guildId,
    enabled: false,
    welcomeChannelId: null,
    welcomePublicEnabled: false,
    welcomeDmEnabled: false,
    farewellChannelId: null,
    farewellPublicEnabled: false,
    lifecycleLogChannelId: null,
    rulesChannelId: null,
    verificationEnabled: false,
    currentRulesVersion: null,
    verifiedRoleId: null,
    unverifiedRoleId: null,
    humanAutorolesEnabled: false,
    botAutorolesEnabled: false,
    accountAgeAlertHours: null,
    welcomeTitle: DEFAULT_WELCOME_TEMPLATE.title,
    welcomeBody: DEFAULT_WELCOME_TEMPLATE.body,
    farewellTitle: DEFAULT_FAREWELL_TEMPLATE.title,
    farewellBody: DEFAULT_FAREWELL_TEMPLATE.body,
    welcomeChannelVerifiedAt: null,
    farewellChannelVerifiedAt: null,
    lifecycleLogChannelVerifiedAt: null,
    rulesChannelVerifiedAt: null,
    verificationRolesVerifiedAt: null,
    createdBy: guildId,
    updatedBy: guildId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function value<K extends keyof ConfigurationPatch>(
  patch: ConfigurationPatch,
  key: K,
  fallback: OnboardingConfigurationInput[K],
): OnboardingConfigurationInput[K] {
  return (
    Object.prototype.hasOwnProperty.call(patch, key) && patch[key] !== undefined
      ? patch[key]
      : fallback
  ) as OnboardingConfigurationInput[K];
}

function asAutorole(
  roleId: string,
  enabled: boolean,
  bindingsVerifiedAt: string | null,
): Pick<OnboardingAutorole, "roleId" | "enabled" | "bindingsVerifiedAt"> {
  return { roleId, enabled, bindingsVerifiedAt };
}

function audienceEnabled(
  configuration: OnboardingConfiguration | null,
  audience: OnboardingAutoroleAudience,
): boolean {
  return audience === "human"
    ? Boolean(configuration?.humanAutorolesEnabled)
    : Boolean(configuration?.botAutorolesEnabled);
}

async function requireOnboardingChannel(
  guild: Guild,
  channelId: string | null,
  label: string,
): Promise<GuildTextBasedChannel> {
  const inspection = await inspectOnboardingChannel(guild, channelId, label);
  if (!inspection.channel || inspection.issues.length > 0)
    throw new Error(inspection.issues.join(" ") || `${label} is unavailable.`);
  return inspection.channel;
}

async function requireAssignableRole(
  guild: Guild,
  roleId: string | null,
  actor: GuildMember,
): Promise<Role> {
  const inspection = await inspectAssignableOnboardingRole(
    guild,
    roleId,
    actor,
  );
  if (!inspection.role || inspection.issues.length > 0)
    throw new Error(inspection.issues.join(" ") || "That role is unavailable.");
  return inspection.role;
}

async function requireRemovableRole(
  guild: Guild,
  roleId: string | null,
  actor: GuildMember,
): Promise<Role> {
  const inspection = await inspectRemovableOnboardingRole(guild, roleId, actor);
  if (!inspection.role || inspection.issues.length > 0)
    throw new Error(
      inspection.issues.join(" ") || "That unverified role is unavailable.",
    );
  return inspection.role;
}

async function refreshActor(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  expected: GuildMember,
): Promise<GuildMember | null> {
  const guild = interaction.guild;
  if (
    !guild ||
    expected.id !== interaction.user.id ||
    guild.id !== runtime.guildId
  )
    return null;
  const decision = await authorizeCapability({
    guild,
    userId: interaction.user.id,
    capability: "onboarding.configure",
    grants: runtime.storage,
  });
  if (!decision.allowed || !runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "Your current onboarding authority could not be verified.",
    );
    return null;
  }
  return decision.member;
}

function discordTime(timestamp: string): string {
  return `<t:${Math.max(0, Math.floor(Date.parse(timestamp) / 1_000))}:F>`;
}

function now(): string {
  return new Date().toISOString();
}

function safeError(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 1_800)
    : "Superior could not safely complete that onboarding operation.";
}

async function replyPrivate(
  interaction: ChatInputCommandInteraction,
  content: string,
): Promise<void> {
  const payload = {
    content: content.slice(0, 2_000),
    allowedMentions: { parse: [] as never[] },
  };
  if (interaction.deferred && !interaction.replied)
    await interaction.editReply(payload);
  else if (interaction.replied)
    await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
  else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}
