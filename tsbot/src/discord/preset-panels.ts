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
  ModerationConfiguration,
  OnboardingConfiguration,
  OnboardingRulesVersion,
  PostedPanel,
  RoleMenu,
  RoleMenuOption,
  RoleMenuPost,
  RoleMenuPostInput,
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
  renderPanelHowToGuide,
  renderSuperiorPanel,
} from "./panel-theme.js";
import {
  canPostThemedPanel,
  inspectTicketConfigurationResources,
} from "./ticket-permissions.js";
import { logDomainOutcome } from "./domain-outcomes.js";
import { runPanelPostSerial } from "./panel-post-queue.js";
import {
  inspectApplicationResources,
  inspectSuggestionResources,
  isConfiguredDepartment,
} from "./phase2-permissions.js";
import { inspectSafetyWorkflowResources } from "./safety-permissions.js";
import { authorizeCapability } from "./authorization.js";
import type { GuildCapability } from "./capabilities.js";
import {
  fetchCurrentBotMember,
  fetchOnboardingRole,
  inspectAssignableOnboardingRole,
  inspectRemovableOnboardingRole,
} from "./onboarding-permissions.js";
import {
  buildRoleMenuPanelPayload,
  createRoleMenuCustomId,
  validateRenderableRoleMenu,
} from "./role-menu-components.js";
import {
  assignableRoleSafetyIssue,
  prerequisiteRoleSafetyIssue,
} from "./role-policy.js";
import {
  buildVerificationPanelPayload,
  createVerificationAcceptCustomId,
} from "./verification-components.js";

interface PostPanelOptions {
  preset: PanelPreset;
  channel: GuildTextBasedChannel;
  replaceExisting: boolean;
  resource?: NormalizedResourcePanel;
  roleMenuSlug?: string;
}

interface SafetyPanelReadiness {
  reportsEnabled: boolean;
  appealsEnabled: boolean;
  unavailableWorkflows: Array<"reports" | "appeals">;
}

interface VerificationPanelReadiness {
  readonly configuration: OnboardingConfiguration;
  readonly rules: OnboardingRulesVersion;
}

interface RoleMenuPanelReadiness {
  readonly menu: RoleMenu;
  readonly options: RoleMenuOption[];
  readonly priorPost: RoleMenuPost | null;
}

interface PanelRoleMenuStorage {
  getRoleMenuById(menuId: string): RoleMenu | null;
  getRoleMenuBySlug(slug: string): RoleMenu | null;
  listRoleMenuOptions(menuId: string): RoleMenuOption[];
  getRoleMenuPostById(postId: string): RoleMenuPost | null;
  upsertRoleMenuPost(input: RoleMenuPostInput): RoleMenuPost;
  setRoleMenuPostState(
    postId: string,
    state: "active" | "missing" | "stale",
    bindingsVerifiedAt?: string | null,
  ): RoleMenuPost | null;
}

interface PanelOnboardingStorage {
  getOnboardingConfiguration(): OnboardingConfiguration | null;
  getCurrentOnboardingRulesVersion(): OnboardingRulesVersion | null;
}

export function panelCapabilityForOperation(
  subcommand: string,
  preset: string | null,
): GuildCapability {
  if (subcommand === "post") {
    if (preset === "safety") return "moderation.configure";
    if (preset === "verification") return "onboarding.configure";
    if (preset === "roles") return "roles.configure";
  }
  return "panels.manage";
}

export async function handlePresetPanelCommand(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
): Promise<void> {
  switch (interaction.options.getSubcommand()) {
    case "help":
      await handlePanelHelpCommand(interaction, runtime);
      return;
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

/** Posts the general panel guide as a public response in the current channel. */
export async function handlePanelHelpCommand(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const channel = getCurrentPanelChannel(interaction, runtime);
  if (!channel) {
    await replyPrivate(
      interaction,
      "Use this command in a text or announcement channel in this server.",
    );
    return;
  }
  const guild = interaction.guild;
  const botMember = guild
    ? guild.members.me ?? (await guild.members.fetchMe().catch(() => null))
    : null;
  if (!botMember || !canPostThemedPanel(channel, botMember)) {
    await replyPrivate(
      interaction,
      "Superior needs View Channel, Send Messages, Read Message History, and Embed Links here.",
    );
    return;
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server was disabled or reconfigured. Please try again.",
    );
    return;
  }
  await replyPanelPayloadPublic(interaction, renderPanelHowToGuide());
  runtime.storage.recordCommandMetric("panel.help");
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
  preset: "tickets" | "suggestions" | "applications" | "safety",
): Promise<void> {
  const channel = getCurrentPanelChannel(interaction, runtime);
  if (!channel) {
    await replyPrivate(
      interaction,
      "Use this command in a text or announcement channel in this server.",
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
  const channel = getCurrentPanelChannel(interaction, runtime);
  if (!channel) {
    await replyPrivate(
      interaction,
      "Use this command in a text or announcement channel in this server.",
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
  const roleMenuSlug = interaction.options.getString("role_menu", false);
  if (rawPreset === "roles" && !roleMenuSlug) {
    await replyPrivate(
      interaction,
      "The roles preset requires the role_menu option for an enabled stored menu.",
    );
    return;
  }
  if (rawPreset !== "roles" && roleMenuSlug) {
    await replyPrivate(
      interaction,
      "The role_menu option can only be used with the roles preset.",
    );
    return;
  }
  await postSuperiorPanel(interaction, runtime, actor, {
    preset: rawPreset,
    channel,
    replaceExisting:
      interaction.options.getBoolean("replace_existing", false) ?? true,
    ...(resource ? { resource } : {}),
    ...(roleMenuSlug ? { roleMenuSlug } : {}),
  });
}

async function postSuperiorPanel(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
  options: PostPanelOptions,
): Promise<void> {
  await runPanelPostSerial(
    runtime.guildId,
    options.preset,
    options.channel.id,
    () => postSuperiorPanelSerial(interaction, runtime, actor, options),
  );
}

async function postSuperiorPanelSerial(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
  options: PostPanelOptions,
): Promise<void> {
  const requiresFreshTarget =
    options.preset === "verification" || options.preset === "roles";
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
  if (!requiresFreshTarget) {
    const botMember =
      guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
    if (!botMember || !canPostThemedPanel(options.channel, botMember)) {
      await replyPrivate(
        interaction,
        "Superior needs View Channel, Send Messages, Read Message History, and Embed Links there.",
      );
      return;
    }
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
        "Create, configure, and enable a ticket department with `/ticket department create`, then verify it with `/ticket department health` before posting this panel.",
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
  let safetyReadiness: SafetyPanelReadiness | null = null;
  if (options.preset === "safety") {
    const configuration = getModerationConfigurationSafely(runtime);
    safetyReadiness = await inspectSafetyPanelReadiness(
      guild,
      runtime,
      configuration,
    );
    if (!safetyReadiness.reportsEnabled && !safetyReadiness.appealsEnabled) {
      await replyPrivate(
        interaction,
        "Configure and verify private report or appeal review bindings before posting the safety panel.",
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
  if (existing && !options.replaceExisting) {
    await replyPrivate(
      interaction,
      `A ${options.preset} panel is already tracked in that channel. Enable replace_existing to refresh it.`,
    );
    return;
  }
  const panelId = existing?.panelId ?? createOpaqueToken();
  let verificationReadiness: VerificationPanelReadiness | null = null;
  if (options.preset === "verification") {
    const definition = readVerificationDefinition(runtime);
    if (!definition) {
      await replyPrivate(
        interaction,
        "Configure and enable current rules with verified role bindings before posting the verification panel.",
      );
      return;
    }
    const currentActor = await authorizePanelConfiguration(
      interaction,
      runtime,
      actor,
      "onboarding.configure",
      "onboarding",
    );
    if (!currentActor) return;
    const issue = await inspectVerificationRoles(
      guild,
      definition.configuration,
      currentActor,
    );
    if (issue) {
      await replyPrivate(
        interaction,
        `Verification roles need attention: ${issue}`,
      );
      return;
    }
    const current = readVerificationDefinition(runtime);
    if (
      !current ||
      !sameVerificationDefinition(definition, current) ||
      !runtime.isCurrent()
    ) {
      await replyPrivate(
        interaction,
        "The verification configuration changed while its roles were being checked. Try again with the current rules.",
      );
      return;
    }
    verificationReadiness = current;
  }

  let roleMenuReadiness: RoleMenuPanelReadiness | null = null;
  if (options.preset === "roles") {
    const roleMenuStorage = asPanelRoleMenuStorage(runtime);
    const definition = readRoleMenuDefinition(
      roleMenuStorage,
      options.roleMenuSlug ?? "",
      runtime.guildId,
      panelId,
    );
    if (!definition) {
      await replyPrivate(
        interaction,
        "Choose an enabled, verified stored role menu with one to 25 current options.",
      );
      return;
    }
    if (
      definition.priorPost &&
      definition.priorPost.menuId !== definition.menu.menuId
    ) {
      await replyPrivate(
        interaction,
        "This tracked roles panel is already bound to another menu and cannot be silently rebound. Use another channel or recover the existing menu first.",
      );
      return;
    }
    const currentActor = await authorizePanelConfiguration(
      interaction,
      runtime,
      actor,
      "roles.configure",
      "role-menu",
    );
    if (!currentActor) return;
    const issue = await inspectRoleMenuRoles(
      guild,
      definition.menu,
      definition.options,
      currentActor,
    );
    if (issue) {
      await replyPrivate(interaction, `Role menu needs attention: ${issue}`);
      return;
    }
    const current = readRoleMenuDefinition(
      roleMenuStorage,
      options.roleMenuSlug ?? "",
      runtime.guildId,
      panelId,
    );
    if (
      !current ||
      !sameRoleMenuDefinition(definition, current) ||
      !runtime.isCurrent()
    ) {
      await replyPrivate(
        interaction,
        "The stored role menu changed while its roles were being checked. Try again with the current definition.",
      );
      return;
    }
    roleMenuReadiness = current;
  }
  let payload: SuperiorPanelPayload;
  try {
    payload = buildPanelPayload(
      options,
      panelId,
      runtime,
      enabledDepartments.length > 0 || Boolean(ticketConfiguration?.enabled),
      safetyReadiness,
      verificationReadiness,
      roleMenuReadiness,
    );
  } catch {
    await replyPrivate(
      interaction,
      "The current panel definition is not safe to render. Review its configuration and try again.",
    );
    return;
  }
  if (options.preset === "safety") {
    const authorization = await authorizeCapability({
      guild,
      userId: actor.id,
      capability: "moderation.configure",
      grants: runtime.storage,
    });
    if (
      !authorization.allowed ||
      authorization.member.id !== actor.id ||
      !runtime.isCurrent()
    ) {
      await replyPrivate(
        interaction,
        "Your moderation configuration authority changed before the safety panel could be posted.",
      );
      return;
    }
    const finalReadiness = await inspectSafetyPanelReadiness(
      guild,
      runtime,
      getModerationConfigurationSafely(runtime),
    );
    if (
      !safetyReadiness ||
      finalReadiness.reportsEnabled !== safetyReadiness.reportsEnabled ||
      finalReadiness.appealsEnabled !== safetyReadiness.appealsEnabled ||
      (!finalReadiness.reportsEnabled && !finalReadiness.appealsEnabled) ||
      !runtime.isCurrent()
    ) {
      await replyPrivate(
        interaction,
        "The verified report or appeal resources changed before the safety panel could be posted.",
      );
      return;
    }
  }
  if (requiresFreshTarget) {
    const [freshChannel, freshBotMember] = await Promise.all([
      guild.channels
        .fetch(options.channel.id, { cache: true, force: true })
        .catch(() => null),
      guild.members.fetchMe({ cache: true, force: true }).catch(() => null),
    ]);
    if (
      !freshChannel ||
      freshChannel.guild.id !== runtime.guildId ||
      (freshChannel.type !== ChannelType.GuildText &&
        freshChannel.type !== ChannelType.GuildAnnouncement)
    ) {
      await replyPrivate(
        interaction,
        "That panel target is outside this server or is no longer a text or announcement channel.",
      );
      return;
    }
    if (
      !freshBotMember ||
      freshBotMember.guild.id !== runtime.guildId ||
      !freshBotMember.user.bot ||
      !canPostThemedPanel(freshChannel, freshBotMember)
    ) {
      await replyPrivate(
        interaction,
        "Superior needs View Channel, Send Messages, Read Message History, and Embed Links there.",
      );
      return;
    }
    if (!runtime.isCurrent()) {
      await replyPrivate(
        interaction,
        "This server was disabled or reconfigured. Please try again.",
      );
      return;
    }
    options = { ...options, channel: freshChannel };
  }
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
  if (
    verificationReadiness &&
    !sameVerificationDefinition(
      verificationReadiness,
      readVerificationDefinition(runtime),
    )
  ) {
    const cleanup = await cleanUpPanelMutation(postedMessage, restorePrior);
    await replyPrivate(
      interaction,
      cleanup.warning
        ? `The current verification rules changed while the panel was being posted. ${cleanup.warning}`
        : "The current verification rules changed while the panel was being posted. No panel change was retained.",
    );
    return;
  }
  if (roleMenuReadiness) {
    const current = readRoleMenuDefinition(
      asPanelRoleMenuStorage(runtime),
      options.roleMenuSlug ?? "",
      runtime.guildId,
      panelId,
    );
    if (!sameRoleMenuDefinition(roleMenuReadiness, current)) {
      const cleanup = await cleanUpPanelMutation(postedMessage, restorePrior);
      await replyPrivate(
        interaction,
        cleanup.warning
          ? `The stored role menu changed while the panel was being posted. ${cleanup.warning}`
          : "The stored role menu changed while the panel was being posted. No panel change was retained.",
      );
      return;
    }
  }
  const roleMenuPostBindingsVerifiedAt = roleMenuReadiness
    ? new Date().toISOString()
    : null;
  let roleMenuPostPersisted = false;
  try {
    if (roleMenuReadiness && roleMenuPostBindingsVerifiedAt) {
      asPanelRoleMenuStorage(runtime).upsertRoleMenuPost({
        postId: panelId,
        menuId: roleMenuReadiness.menu.menuId,
        channelId: options.channel.id,
        messageId,
        definitionVersion: roleMenuReadiness.menu.definitionVersion,
        bindingsVerifiedAt: roleMenuPostBindingsVerifiedAt,
        state: "active",
      });
      roleMenuPostPersisted = true;
    }
    runtime.storage.upsertPostedPanel({
      panelId,
      preset: options.preset,
      channelId: options.channel.id,
      messageId,
      configuration: verificationReadiness
        ? {
            rulesVersion: verificationReadiness.rules.rulesVersion,
            bindingsVerifiedAt:
              verificationReadiness.configuration.verificationRolesVerifiedAt!,
          }
        : roleMenuReadiness && roleMenuPostBindingsVerifiedAt
          ? {
              menuId: roleMenuReadiness.menu.menuId,
              postId: panelId,
              definitionVersion: roleMenuReadiness.menu.definitionVersion,
              bindingsVerifiedAt: roleMenuPostBindingsVerifiedAt,
            }
          : (options.resource ?? {}),
    });
  } catch (error) {
    const roleMenuRollbackWarning =
      roleMenuPostPersisted && roleMenuReadiness
        ? restoreRoleMenuPostBinding(
            asPanelRoleMenuStorage(runtime),
            panelId,
            roleMenuReadiness.priorPost,
          )
          ? null
          : "The role-menu binding could not be restored; recover or mark that post stale before using it."
        : null;
    const cleanup = await cleanUpPanelMutation(postedMessage, restorePrior);
    logDomainOutcome(
      "panel",
      `preset-${options.preset}-post`,
      runtime.guildId,
      "persistence-failed",
      { recordId: panelId, channelId: options.channel.id },
    );
    const rollbackWarnings = [roleMenuRollbackWarning, cleanup.warning].filter(
      (warning): warning is string => Boolean(warning),
    );
    await replyPrivate(
      interaction,
      `Superior could not persist the panel binding. ${rollbackWarnings.length > 0 ? rollbackWarnings.join(" ") : "The Discord change was rolled back safely."}`,
    );
    runtime.storage.recordCommandMetric(`panel.${options.preset}.post`, false);
    return;
  }
  await replyPrivate(
    interaction,
    `${replaced ? "Refreshed" : "Posted"} the **${escapeMarkdown(options.preset)}** panel in <#${options.channel.id}>.${safetyReadiness?.unavailableWorkflows.length ? ` Unavailable ${safetyReadiness.unavailableWorkflows.join(" and ")} controls stayed disabled.` : ""}`,
  );
  logDomainOutcome(
    "panel",
    `preset-${options.preset}-post`,
    runtime.guildId,
    replaced ? "refreshed" : "delivered",
    { recordId: panelId, channelId: options.channel.id },
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

function isUnknownChannelError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    rawError?: { code?: unknown };
  };
  return candidate.code === 10_003 || candidate.rawError?.code === 10_003;
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
  safetyReadiness: SafetyPanelReadiness | null,
  verificationReadiness: VerificationPanelReadiness | null,
  roleMenuReadiness: RoleMenuPanelReadiness | null,
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
    case "safety": {
      if (!safetyReadiness) {
        throw new Error("Safety panel readiness was not freshly verified.");
      }
      return renderSuperiorPanel({
        preset: "safety",
        panelToken: panelId,
        reportsEnabled: safetyReadiness.reportsEnabled,
        appealsEnabled: safetyReadiness.appealsEnabled,
      });
    }
    case "verification": {
      if (!verificationReadiness) {
        throw new Error(
          "Verification panel readiness was not freshly verified.",
        );
      }
      return buildVerificationPanelPayload({
        panelId,
        rulesVersion: verificationReadiness.rules.rulesVersion,
        rulesTitle: verificationReadiness.rules.title,
        rulesBody: verificationReadiness.rules.body,
        reacceptanceRequested:
          verificationReadiness.rules.reacceptanceRequested,
      });
    }
    case "roles": {
      if (!roleMenuReadiness) {
        throw new Error("Role-menu panel readiness was not freshly verified.");
      }
      const payload = buildRoleMenuPanelPayload(
        roleMenuReadiness.menu,
        roleMenuReadiness.options,
        panelId,
      );
      const embed = payload.embeds[0];
      if (!embed) throw new Error("Role-menu panel embed is missing.");
      return {
        embeds: [embed],
        components: [...payload.components],
        allowedMentions: payload.allowedMentions,
      };
    }
  }
}

async function inspectSafetyPanelReadiness(
  guild: Guild,
  runtime: GuildRuntime,
  configuration: ModerationConfiguration | null,
): Promise<SafetyPanelReadiness> {
  const candidates = {
    reports: Boolean(
      configuration?.reportsEnabled && configuration.reportBindingsVerifiedAt,
    ),
    appeals: Boolean(
      configuration?.appealsEnabled && configuration.appealBindingsVerifiedAt,
    ),
  };
  const readiness: SafetyPanelReadiness = {
    reportsEnabled: false,
    appealsEnabled: false,
    unavailableWorkflows: [],
  };
  if (!configuration) return readiness;
  const inspections = await Promise.all(
    (["reports", "appeals"] as const).map(async (workflow) => {
      if (!candidates[workflow]) return { workflow, ready: false };
      const resources = await inspectSafetyWorkflowResources(
        guild,
        configuration,
        workflow,
        runtime.storage,
      );
      return {
        workflow,
        ready: Boolean(
          resources.reviewChannel && resources.issues.length === 0,
        ),
      };
    }),
  );
  for (const inspection of inspections) {
    if (inspection.workflow === "reports") {
      readiness.reportsEnabled = inspection.ready;
    } else {
      readiness.appealsEnabled = inspection.ready;
    }
    if (candidates[inspection.workflow] && !inspection.ready) {
      readiness.unavailableWorkflows.push(inspection.workflow);
    }
  }
  return readiness;
}

function asPanelOnboardingStorage(
  runtime: GuildRuntime,
): PanelOnboardingStorage {
  return runtime.storage as unknown as PanelOnboardingStorage;
}

function asPanelRoleMenuStorage(runtime: GuildRuntime): PanelRoleMenuStorage {
  return runtime.storage as unknown as PanelRoleMenuStorage;
}

async function authorizePanelConfiguration(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
  capability: Extract<
    GuildCapability,
    "onboarding.configure" | "roles.configure"
  >,
  label: string,
): Promise<GuildMember | null> {
  const guild = interaction.guild;
  if (!guild || guild.id !== runtime.guildId || actor.guild.id !== guild.id) {
    await replyPrivate(
      interaction,
      "That configuration is outside this server.",
    );
    return null;
  }
  const authorization = await authorizeCapability({
    guild,
    userId: actor.id,
    capability,
    grants: runtime.storage,
  });
  if (
    !authorization.allowed ||
    authorization.member.id !== actor.id ||
    authorization.member.guild.id !== runtime.guildId ||
    !runtime.isCurrent()
  ) {
    await replyPrivate(
      interaction,
      `Your ${label} configuration authority changed before the panel could be posted.`,
    );
    return null;
  }
  return authorization.member;
}

function readVerificationDefinition(
  runtime: GuildRuntime,
): VerificationPanelReadiness | null {
  try {
    const storage = asPanelOnboardingStorage(runtime);
    if (
      typeof storage.getOnboardingConfiguration !== "function" ||
      typeof storage.getCurrentOnboardingRulesVersion !== "function"
    ) {
      return null;
    }
    const configuration = storage.getOnboardingConfiguration();
    if (
      !configuration ||
      configuration.guildId !== runtime.guildId ||
      !configuration.enabled ||
      !configuration.verificationEnabled ||
      !Number.isSafeInteger(configuration.currentRulesVersion) ||
      configuration.currentRulesVersion === null ||
      configuration.currentRulesVersion < 1 ||
      configuration.currentRulesVersion > 999_999_999 ||
      !configuration.verifiedRoleId ||
      !isParseableTimestamp(configuration.verificationRolesVerifiedAt) ||
      configuration.verifiedRoleId === configuration.unverifiedRoleId
    ) {
      return null;
    }
    const rules = storage.getCurrentOnboardingRulesVersion();
    if (
      !rules ||
      rules.guildId !== runtime.guildId ||
      rules.rulesVersion !== configuration.currentRulesVersion
    ) {
      return null;
    }
    return { configuration, rules };
  } catch {
    return null;
  }
}

async function inspectVerificationRoles(
  guild: Guild,
  configuration: OnboardingConfiguration,
  actor: GuildMember,
): Promise<string | null> {
  if (
    configuration.guildId !== guild.id ||
    !configuration.verifiedRoleId ||
    configuration.verifiedRoleId === configuration.unverifiedRoleId
  ) {
    return "The verified and unverified role bindings are invalid.";
  }
  const verified = await inspectAssignableOnboardingRole(
    guild,
    configuration.verifiedRoleId,
    actor,
  );
  if (verified.issues.length > 0) return verified.issues.join(" ");
  if (!configuration.unverifiedRoleId) return null;
  const unverified = await inspectRemovableOnboardingRole(
    guild,
    configuration.unverifiedRoleId,
    actor,
  );
  return unverified.issues.length > 0 ? unverified.issues.join(" ") : null;
}

function sameVerificationDefinition(
  left: VerificationPanelReadiness,
  right: VerificationPanelReadiness | null,
): boolean {
  return Boolean(
    right &&
    left.configuration.guildId === right.configuration.guildId &&
    left.configuration.enabled === right.configuration.enabled &&
    left.configuration.verificationEnabled ===
      right.configuration.verificationEnabled &&
    left.configuration.currentRulesVersion ===
      right.configuration.currentRulesVersion &&
    left.configuration.verifiedRoleId === right.configuration.verifiedRoleId &&
    left.configuration.unverifiedRoleId ===
      right.configuration.unverifiedRoleId &&
    left.configuration.verificationRolesVerifiedAt ===
      right.configuration.verificationRolesVerifiedAt &&
    left.configuration.updatedAt === right.configuration.updatedAt &&
    left.rules.guildId === right.rules.guildId &&
    left.rules.rulesVersion === right.rules.rulesVersion &&
    left.rules.title === right.rules.title &&
    left.rules.body === right.rules.body &&
    left.rules.reacceptanceRequested === right.rules.reacceptanceRequested &&
    left.rules.createdAt === right.rules.createdAt,
  );
}

function readRoleMenuDefinition(
  storage: PanelRoleMenuStorage,
  slug: string,
  guildId: string,
  postId: string,
): RoleMenuPanelReadiness | null {
  try {
    if (
      !slug ||
      typeof storage.getRoleMenuBySlug !== "function" ||
      typeof storage.getRoleMenuById !== "function" ||
      typeof storage.listRoleMenuOptions !== "function" ||
      typeof storage.getRoleMenuPostById !== "function"
    ) {
      return null;
    }
    const bySlug = storage.getRoleMenuBySlug(slug);
    if (!bySlug || bySlug.guildId !== guildId) return null;
    const menu = storage.getRoleMenuById(bySlug.menuId);
    if (
      !menu ||
      menu.guildId !== guildId ||
      menu.menuId !== bySlug.menuId ||
      menu.slug !== bySlug.slug ||
      menu.state !== "enabled" ||
      !isParseableTimestamp(menu.bindingsVerifiedAt)
    ) {
      return null;
    }
    const options = storage.listRoleMenuOptions(menu.menuId);
    validateRenderableRoleMenu(menu, options);
    const priorPost = storage.getRoleMenuPostById(postId);
    if (priorPost && priorPost.guildId !== guildId) return null;
    return { menu, options, priorPost };
  } catch {
    return null;
  }
}

async function inspectRoleMenuRoles(
  guild: Guild,
  menu: RoleMenu,
  options: readonly RoleMenuOption[],
  actor: GuildMember,
): Promise<string | null> {
  const botMember = await fetchCurrentBotMember(guild);
  if (!botMember) {
    return "Superior could not verify its current server membership.";
  }
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index]!;
    const role = await fetchOnboardingRole(guild, option.roleId);
    if (!role) return `Option ${index + 1} refers to a missing role.`;
    const issue = assignableRoleSafetyIssue(role, {
      guildId: guild.id,
      botMember,
      actor,
    });
    if (issue) return `Option ${index + 1}: ${issue}`;
  }
  if (menu.requiredRoleId) {
    const prerequisite = await fetchOnboardingRole(guild, menu.requiredRoleId);
    if (!prerequisite) return "The prerequisite role is missing.";
    const issue = prerequisiteRoleSafetyIssue(prerequisite, guild.id);
    if (issue) return issue;
  }
  return null;
}

function sameRoleMenuDefinition(
  left: RoleMenuPanelReadiness,
  right: RoleMenuPanelReadiness | null,
): boolean {
  if (!right || !sameRoleMenu(left.menu, right.menu)) return false;
  if (left.options.length !== right.options.length) return false;
  for (let index = 0; index < left.options.length; index += 1) {
    if (!sameRoleMenuOption(left.options[index]!, right.options[index]!)) {
      return false;
    }
  }
  return sameRoleMenuPost(left.priorPost, right.priorPost);
}

function sameRoleMenu(left: RoleMenu, right: RoleMenu): boolean {
  return (
    left.guildId === right.guildId &&
    left.menuId === right.menuId &&
    left.slug === right.slug &&
    left.title === right.title &&
    left.description === right.description &&
    left.state === right.state &&
    left.mode === right.mode &&
    left.minSelections === right.minSelections &&
    left.maxSelections === right.maxSelections &&
    left.requiredRoleId === right.requiredRoleId &&
    left.definitionVersion === right.definitionVersion &&
    left.bindingsVerifiedAt === right.bindingsVerifiedAt &&
    left.updatedAt === right.updatedAt
  );
}

function sameRoleMenuOption(
  left: RoleMenuOption,
  right: RoleMenuOption,
): boolean {
  return (
    left.guildId === right.guildId &&
    left.menuId === right.menuId &&
    left.optionId === right.optionId &&
    left.roleId === right.roleId &&
    left.label === right.label &&
    left.description === right.description &&
    left.emoji === right.emoji &&
    left.sortOrder === right.sortOrder &&
    left.updatedAt === right.updatedAt
  );
}

function sameRoleMenuPost(
  left: RoleMenuPost | null,
  right: RoleMenuPost | null,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.guildId === right.guildId &&
    left.postId === right.postId &&
    left.menuId === right.menuId &&
    left.channelId === right.channelId &&
    left.messageId === right.messageId &&
    left.definitionVersion === right.definitionVersion &&
    left.bindingsVerifiedAt === right.bindingsVerifiedAt &&
    left.state === right.state &&
    left.updatedAt === right.updatedAt
  );
}

function restoreRoleMenuPostBinding(
  storage: PanelRoleMenuStorage,
  postId: string,
  priorPost: RoleMenuPost | null,
): boolean {
  try {
    if (!priorPost) {
      return storage.setRoleMenuPostState(postId, "stale", null) !== null;
    }
    storage.upsertRoleMenuPost({
      postId: priorPost.postId,
      menuId: priorPost.menuId,
      channelId: priorPost.channelId,
      messageId: priorPost.messageId,
      definitionVersion: priorPost.definitionVersion,
      bindingsVerifiedAt: priorPost.bindingsVerifiedAt,
      state: priorPost.state,
    });
    return true;
  } catch {
    return false;
  }
}

function isParseableTimestamp(value: string | null): value is string {
  return (
    typeof value === "string" &&
    value.length >= 20 &&
    value.length <= 40 &&
    Number.isFinite(Date.parse(value))
  );
}

function buildFeatureState(
  runtime: GuildRuntime,
  tickets: boolean,
): PanelFeatureState {
  return {
    chat: true,
    replyModeration: true,
    greetings: true,
    activityMetrics: true,
    tickets,
    suggestions: Boolean(getSuggestionConfigurationSafely(runtime)?.enabled),
    applications:
      listApplicationFormsSafely(runtime, {
        enabledOnly: true,
        limit: 1,
      }).length > 0,
    reports: Boolean(
      getModerationConfigurationSafely(runtime)?.reportsEnabled &&
      getModerationConfigurationSafely(runtime)?.reportBindingsVerifiedAt,
    ),
    appeals: Boolean(
      getModerationConfigurationSafely(runtime)?.appealsEnabled &&
      getModerationConfigurationSafely(runtime)?.appealBindingsVerifiedAt,
    ),
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

function getModerationConfigurationSafely(
  runtime: GuildRuntime,
): ModerationConfiguration | null {
  const storage = runtime.storage as unknown as {
    getModerationConfiguration?: () => ModerationConfiguration | null;
  };
  return typeof storage.getModerationConfiguration === "function"
    ? storage.getModerationConfiguration()
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
  const moderationConfiguration = getModerationConfigurationSafely(runtime);
  const panelCount = runtime.storage.countPostedPanels();
  const panels = runtime.storage.listPostedPanels(undefined, 20, 0);
  const panelLines: string[] = [];
  for (const panel of panels) {
    panelLines.push(
      `• **${escapeMarkdown(panel.preset)}** · <#${panel.channelId}> · message \`${panel.messageId}\`${await panelStatusHealth(
        runtime,
        interaction.guild,
        interaction.client.user?.id ?? null,
        panel,
      )}`,
    );
  }
  const lines = [
    "**Superior panel status**",
    `Ticket departments: **${enabledDepartments.length} enabled** · ${departments.length} configured`,
    `Suggestions: **${suggestionConfiguration?.enabled ? "enabled" : "disabled"}**`,
    `Application forms: **${enabledApplicationForms.length} enabled** · ${applicationForms.length} configured`,
    `Private reports: **${moderationConfiguration?.reportsEnabled ? "enabled" : "disabled"}**`,
    `Case appeals: **${moderationConfiguration?.appealsEnabled ? "enabled" : "disabled"}**`,
    panels.length > 0
      ? `Tracked panels (${panels.length}${panelCount > panels.length ? "+" : ""} of ${panelCount}):`
      : "Tracked panels: none",
    ...panelLines,
  ];
  await replyPrivate(interaction, lines.join("\n").slice(0, 2_000));
  runtime.storage.recordCommandMetric("panel.status");
}

async function panelStatusHealth(
  runtime: GuildRuntime,
  guild: Guild | null,
  botUserId: string | null,
  panel: PostedPanel,
): Promise<string> {
  let bindingHealthy = false;
  let expectedCustomId: string | null = null;
  if (panel.preset === "verification") {
    const binding = parseVerificationPanelBinding(panel.configuration);
    const current = readVerificationDefinition(runtime);
    bindingHealthy = Boolean(
      binding &&
      current &&
      binding.rulesVersion === current.rules.rulesVersion &&
      binding.bindingsVerifiedAt ===
        current.configuration.verificationRolesVerifiedAt,
    );
    if (bindingHealthy && binding) {
      expectedCustomId = createVerificationAcceptCustomId(
        panel.panelId,
        binding.rulesVersion,
      );
    }
  } else if (panel.preset === "roles") {
    const binding = parseRoleMenuPanelBinding(panel.configuration);
    if (binding && binding.postId === panel.panelId) {
      try {
        const storage = asPanelRoleMenuStorage(runtime);
        const menu = storage.getRoleMenuById(binding.menuId);
        const post = storage.getRoleMenuPostById(binding.postId);
        bindingHealthy = Boolean(
          menu &&
          post &&
          menu.guildId === runtime.guildId &&
          post.guildId === runtime.guildId &&
          menu.state === "enabled" &&
          post.state === "active" &&
          isParseableTimestamp(menu.bindingsVerifiedAt) &&
          post.menuId === menu.menuId &&
          post.channelId === panel.channelId &&
          post.messageId === panel.messageId &&
          post.definitionVersion === menu.definitionVersion &&
          post.definitionVersion === binding.definitionVersion &&
          post.bindingsVerifiedAt === binding.bindingsVerifiedAt,
        );
        if (bindingHealthy) {
          expectedCustomId = createRoleMenuCustomId(
            binding.menuId,
            binding.postId,
            binding.definitionVersion,
          );
        }
      } catch {
        bindingHealthy = false;
      }
    }
  } else {
    return "";
  }
  if (!bindingHealthy || !runtime.isCurrent()) {
    return " · binding **stale**";
  }

  const liveState = await inspectPanelMessageBinding(
    runtime,
    guild,
    botUserId,
    panel,
    expectedCustomId,
  );
  return ` · binding **${liveState}**`;
}

async function inspectPanelMessageBinding(
  runtime: GuildRuntime,
  guild: Guild | null,
  botUserId: string | null,
  panel: PostedPanel,
  expectedCustomId: string | null,
): Promise<"healthy" | "missing" | "stale" | "unverified"> {
  if (!guild || guild.id !== runtime.guildId || !botUserId) return "stale";
  let channel;
  try {
    channel = await guild.channels.fetch(panel.channelId, {
      cache: true,
      force: true,
    });
  } catch (error) {
    return isUnknownChannelError(error) ? "missing" : "unverified";
  }
  if (!runtime.isCurrent()) return "stale";
  if (!channel) return "missing";
  if (
    channel.type !== ChannelType.GuildText &&
    channel.type !== ChannelType.GuildAnnouncement
  ) {
    return "stale";
  }
  try {
    const message = await channel.messages.fetch(panel.messageId);
    if (!runtime.isCurrent()) return "stale";
    if (!message) return "missing";
    const identityMatches =
      message.guildId === runtime.guildId &&
      message.channelId === panel.channelId &&
      message.author.id === botUserId &&
      message.author.bot;
    if (!identityMatches) return "stale";
    return expectedCustomId &&
      !componentTreeHasCustomId(message.components, expectedCustomId)
      ? "stale"
      : "healthy";
  } catch (error) {
    return isUnknownMessageError(error) ? "missing" : "unverified";
  }
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

function parseVerificationPanelBinding(
  value: unknown,
): { rulesVersion: number; bindingsVerifiedAt: string } | null {
  if (!isRecordWithExactKeys(value, ["bindingsVerifiedAt", "rulesVersion"])) {
    return null;
  }
  return Number.isSafeInteger(value.rulesVersion) &&
    (value.rulesVersion as number) > 0 &&
    isParseableTimestamp(
      typeof value.bindingsVerifiedAt === "string"
        ? value.bindingsVerifiedAt
        : null,
    )
    ? {
        rulesVersion: value.rulesVersion as number,
        bindingsVerifiedAt: value.bindingsVerifiedAt as string,
      }
    : null;
}

function parseRoleMenuPanelBinding(value: unknown): {
  menuId: string;
  postId: string;
  definitionVersion: number;
  bindingsVerifiedAt: string;
} | null {
  if (
    !isRecordWithExactKeys(value, [
      "bindingsVerifiedAt",
      "definitionVersion",
      "menuId",
      "postId",
    ]) ||
    typeof value.menuId !== "string" ||
    typeof value.postId !== "string" ||
    !Number.isSafeInteger(value.definitionVersion) ||
    (value.definitionVersion as number) < 1 ||
    !isParseableTimestamp(
      typeof value.bindingsVerifiedAt === "string"
        ? value.bindingsVerifiedAt
        : null,
    )
  ) {
    return null;
  }
  return {
    menuId: value.menuId,
    postId: value.postId,
    definitionVersion: value.definitionVersion as number,
    bindingsVerifiedAt: value.bindingsVerifiedAt as string,
  };
}

function isRecordWithExactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length &&
    actual.every((key, index) => key === keys[index])
  );
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

function getCurrentPanelChannel(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): GuildTextBasedChannel | null {
  const channel = interaction.channel as GuildTextBasedChannel | null;
  if (
    !channel ||
    typeof channel.isDMBased !== "function" ||
    channel.isDMBased() ||
    channel.guild.id !== runtime.guildId ||
    (channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement)
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
      allowedMentions: { parse: [] },
    });
    return;
  }
  await interaction.reply({
    content,
    allowedMentions: { parse: [] },
  });
}

async function replyPanelPayloadPublic(
  interaction: ChatInputCommandInteraction,
  payload: SuperiorPanelPayload,
): Promise<void> {
  const response = toDiscordPayload(payload);
  if (interaction.deferred && !interaction.replied) {
    await interaction.editReply(response);
    return;
  }
  if (interaction.replied) {
    await interaction.followUp(response);
    return;
  }
  await interaction.reply(response);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Panel validation failed.";
}
