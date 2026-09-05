import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  escapeMarkdown,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type TextChannel,
} from "discord.js";
import type { GuildRuntime } from "../runtime.js";
import type {
  ModerationCase,
  ModerationCaseActionType,
  ActiveModerationCaseLookupResult,
  ModerationCaseAmendInput,
  ModerationCaseEvent,
  ModerationCaseInput,
  ModerationCaseAttemptInput,
  ModerationCaseListFilter,
  ModerationCaseTransitionResult,
  ModerationTimeoutRemovalFinalizeResult,
  ModerationConfiguration,
  ModerationConfigurationInput,
} from "../types.js";
import { authorizeCapability } from "./authorization.js";
import { inspectContentDestinationBoundary } from "./content-destination-boundary.js";
import { deliverModerationCaseLog } from "./moderation-log-delivery.js";
import {
  inspectModerationLogChannel,
  inspectSafetyWorkflowResources,
} from "./safety-permissions.js";
import { clearAntiSpamProcessState } from "./anti-spam-enforcement.js";
import { runModerationTargetAction } from "./moderation-action-queue.js";
import { safeDisplayText } from "./forms.js";
import {
  fetchCurrentBotMember,
  fetchGuildMemberCoalesced,
  fetchGuildMemberCoalescedOrThrow,
  fetchGuildRoleCoalesced,
} from "./fetch-coalescing.js";

interface ModerationCommandStorage {
  getModerationConfiguration(): ModerationConfiguration | null;
  upsertModerationConfiguration(
    input: ModerationConfigurationInput,
  ): ModerationConfiguration;
  disableModerationConfiguration(
    actorId: string,
  ): ModerationConfiguration | null;
  createModerationCase(input: ModerationCaseInput): ModerationCase;
  reserveModerationCaseAttempt(
    input: ModerationCaseAttemptInput,
  ): ModerationCase;
  confirmModerationCase(
    caseId: string,
    input: {
      actorId: string;
      status: "active" | "completed";
      discordActionMetadata?: unknown;
      expectedUpdatedAt?: string;
    },
  ): ModerationCaseTransitionResult;
  failModerationCaseAttempt(
    caseId: string,
    input: { actorId: string; failureCode: string; expectedUpdatedAt?: string },
  ): ModerationCaseTransitionResult;
  completeModerationCase(
    caseId: string,
    input: {
      actorId: string;
      reason?: string;
      relatedCaseId?: string | null;
      expectedUpdatedAt?: string;
    },
  ): ModerationCaseTransitionResult;
  finalizeTimeoutRemovalCase(
    removalCaseId: string,
    input: {
      actorId: string;
      originalCaseId: string;
      discordActionMetadata?: unknown;
      removalExpectedUpdatedAt?: string;
      originalExpectedUpdatedAt?: string;
    },
  ): ModerationTimeoutRemovalFinalizeResult;
  finalizeBanRemovalCase(
    removalCaseId: string,
    input: {
      actorId: string;
      originalCaseId: string;
      discordActionMetadata?: unknown;
      removalExpectedUpdatedAt?: string;
      originalExpectedUpdatedAt?: string;
    },
  ): ModerationTimeoutRemovalFinalizeResult;
  getModerationCaseByNumber(caseNumber: number): ModerationCase | null;
  listModerationCases(filter?: ModerationCaseListFilter): ModerationCase[];
  listModerationCaseEvents(
    caseId: string,
    limit?: number,
    offset?: number,
  ): ModerationCaseEvent[];
  amendModerationCase(
    caseId: string,
    input: ModerationCaseAmendInput,
  ): ModerationCaseTransitionResult;
  voidModerationCase(
    caseId: string,
    input: { actorId: string; reason: string; expectedUpdatedAt?: string },
  ): ModerationCaseTransitionResult;
  findUniqueActiveModerationCase(
    targetUserId: string,
    actionTypes: readonly ModerationCaseActionType[],
  ): ActiveModerationCaseLookupResult;
  completeExpiredTimeoutCase(
    caseId: string,
    input: {
      actorId: string;
      observedAt: string;
      expectedUpdatedAt: string;
    },
  ): ModerationCaseTransitionResult;
}

const MANAGE_SUBCOMMANDS = new Set([
  "warn",
  "note",
  "timeout",
  "untimeout",
  "kick",
  "ban",
  "unban",
  "history",
  "case",
  "amend",
  "void",
  "recover",
]);

export async function handleModerationCaseCommand(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  await deferPrivate(interaction);
  const subcommand = interaction.options.getSubcommand();
  const capability = MANAGE_SUBCOMMANDS.has(subcommand)
    ? "moderation.manage"
    : "moderation.configure";
  const authorization = await authorizeCapability({
    guild: interaction.guild!,
    userId: interaction.user.id,
    capability,
    grants: runtime.storage,
  });
  if (!authorization.allowed) {
    await replyPrivate(
      interaction,
      `You need the \`${capability}\` capability to use that operation.`,
    );
    return;
  }
  const storage: ModerationCommandStorage = runtime.storage;
  switch (subcommand) {
    case "status":
      await showConfiguration(interaction, runtime, storage);
      return;
    case "configure":
      await configureModeration(
        interaction,
        runtime,
        authorization.member,
        storage,
      );
      return;
    case "disable":
      {
        const finalAuthorization = await authorizeCapability({
          guild: interaction.guild!,
          userId: authorization.member.id,
          capability: "moderation.configure",
          grants: runtime.storage,
        });
        if (!finalAuthorization.allowed || !runtime.isCurrent()) {
          await replyPrivate(
            interaction,
            "Your moderation configuration authority changed before disable could be saved.",
          );
          return;
        }
        storage.disableModerationConfiguration(finalAuthorization.member.id);
      }
      runtime.invalidate();
      clearAntiSpamProcessState(runtime.guildId);
      await replyPrivate(
        interaction,
        "New moderation cases, reports, appeals, and anti-spam actions are disabled. Existing history was retained.",
      );
      return;
    case "history":
      await showHistory(interaction, runtime, authorization.member, storage);
      return;
    case "case":
      await showCase(interaction, runtime, authorization.member, storage);
      return;
    case "amend":
      await amendCase(interaction, runtime, authorization.member, storage);
      return;
    case "void":
      await voidCase(interaction, runtime, authorization.member, storage);
      return;
    case "recover":
      await recoverCaseAttempt(
        interaction,
        runtime,
        authorization.member,
        storage,
      );
      return;
    default:
      await performAction(
        interaction,
        runtime,
        authorization.member,
        storage,
        subcommand,
      );
  }
}

async function configureModeration(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
  storage: ModerationCommandStorage,
): Promise<void> {
  const guild = interaction.guild!;
  const current = storage.getModerationConfiguration();
  const log = await selectedTextChannel(interaction, "moderation_log");
  const reportChannel = await selectedTextChannel(
    interaction,
    "report_channel",
  );
  const appealChannel = await selectedTextChannel(
    interaction,
    "appeal_channel",
  );
  const reportRole = await selectedRole(interaction, "report_reviewer_role");
  const appealRole = await selectedRole(interaction, "appeal_reviewer_role");
  if (hasSelected(interaction, "moderation_log") && !log) {
    await replyPrivate(
      interaction,
      "The moderation log must be a current standard text channel in this server.",
    );
    return;
  }
  if (hasSelected(interaction, "report_channel") && !reportChannel) {
    await replyPrivate(
      interaction,
      "The report destination must be a current standard text channel in this server.",
    );
    return;
  }
  if (hasSelected(interaction, "appeal_channel") && !appealChannel) {
    await replyPrivate(
      interaction,
      "The appeal destination must be a current standard text channel in this server.",
    );
    return;
  }
  if (
    (hasSelected(interaction, "report_reviewer_role") && !reportRole) ||
    (hasSelected(interaction, "appeal_reviewer_role") && !appealRole)
  ) {
    await replyPrivate(
      interaction,
      "Reviewer roles must be current, non-managed roles in this server and cannot be @everyone.",
    );
    return;
  }
  const reportsEnabled =
    interaction.options.getBoolean("reports_enabled", false) ??
    current?.reportsEnabled ??
    false;
  const appealsEnabled =
    interaction.options.getBoolean("appeals_enabled", false) ??
    current?.appealsEnabled ??
    false;
  const reportReviewChannelId =
    reportChannel?.id ?? current?.reportReviewChannelId ?? null;
  const reportReviewerRoleId =
    reportRole?.id ?? current?.reportReviewerRoleId ?? null;
  const appealReviewChannelId =
    appealChannel?.id ?? current?.appealReviewChannelId ?? null;
  const appealReviewerRoleId =
    appealRole?.id ?? current?.appealReviewerRoleId ?? null;
  const now = new Date().toISOString();
  const proposed: ModerationConfiguration = {
    guildId: runtime.guildId,
    casesEnabled: interaction.options.getBoolean("cases_enabled", true),
    moderationLogChannelId: log?.id ?? current?.moderationLogChannelId ?? null,
    moderationLogVerifiedAt: null,
    reportsEnabled,
    reportReviewChannelId,
    reportReviewerRoleId,
    reportBindingsVerifiedAt:
      current?.reportReviewChannelId === reportReviewChannelId &&
      current.reportReviewerRoleId === reportReviewerRoleId
        ? current.reportBindingsVerifiedAt
        : null,
    appealsEnabled,
    appealReviewChannelId,
    appealReviewerRoleId,
    appealBindingsVerifiedAt:
      current?.appealReviewChannelId === appealReviewChannelId &&
      current.appealReviewerRoleId === appealReviewerRoleId
        ? current.appealBindingsVerifiedAt
        : null,
    antiSpamEnabled:
      interaction.options.getBoolean("anti_spam_enabled", false) ??
      current?.antiSpamEnabled ??
      false,
    reportCooldownLimit:
      interaction.options.getInteger("report_cooldown_limit", false) ??
      current?.reportCooldownLimit ??
      3,
    reportCooldownWindowSeconds:
      interaction.options.getInteger("report_cooldown_window_seconds", false) ??
      current?.reportCooldownWindowSeconds ??
      1_800,
    createdBy: current?.createdBy ?? actor.id,
    updatedBy: actor.id,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  };
  if (proposed.appealsEnabled && !proposed.casesEnabled) {
    await replyPrivate(
      interaction,
      "Case appeals require moderation cases to remain enabled so authorized reversals can be recorded and recovered.",
    );
    return;
  }
  const logResources = await inspectModerationLogChannel(
    guild,
    proposed.moderationLogChannelId,
  );
  if (logResources.issues.length > 0) {
    await replyPrivate(
      interaction,
      `Moderation log needs attention: ${logResources.issues.join(" ")}`,
    );
    return;
  }
  proposed.moderationLogVerifiedAt = proposed.moderationLogChannelId
    ? now
    : null;
  for (const workflow of ["reports", "appeals"] as const) {
    const enabled =
      workflow === "reports"
        ? proposed.reportsEnabled
        : proposed.appealsEnabled;
    if (!enabled) continue;
    const resources = await inspectSafetyWorkflowResources(
      guild,
      proposed,
      workflow,
      runtime.storage,
    );
    if (!resources.reviewChannel || resources.issues.length > 0) {
      await replyPrivate(
        interaction,
        `${workflow === "reports" ? "Report" : "Appeal"} binding needs attention: ${resources.issues.join(" ")}`,
      );
      return;
    }
    const currentConfiguredRoleId =
      workflow === "reports"
        ? (current?.reportReviewerRoleId ?? null)
        : (current?.appealReviewerRoleId ?? null);
    const boundary = await inspectContentDestinationBoundary({
      guild,
      userId: actor.id,
      capability: workflow === "reports" ? "reports.review" : "appeals.review",
      configuredRoleId: currentConfiguredRoleId,
      grants: runtime.storage,
      channel: resources.reviewChannel,
    });
    if (
      boundary === "visible-without-authority" ||
      boundary === "unverifiable"
    ) {
      await replyPrivate(
        interaction,
        `Configuration access alone cannot route private ${workflow} into a destination you can read. Obtain the corresponding review capability or choose an isolated destination.`,
      );
      return;
    }
    const proposedRoleId =
      workflow === "reports"
        ? proposed.reportReviewerRoleId
        : proposed.appealReviewerRoleId;
    if (
      proposedRoleId &&
      actor.roles.cache.has(proposedRoleId) &&
      boundary !== "content-authorized"
    ) {
      await replyPrivate(
        interaction,
        `You cannot assign a ${workflow} reviewer role you hold without independent ${workflow === "reports" ? "reports.review" : "appeals.review"} authority.`,
      );
      return;
    }
    if (workflow === "reports") proposed.reportBindingsVerifiedAt = now;
    else proposed.appealBindingsVerifiedAt = now;
  }
  const finalAuthorization = await authorizeCapability({
    guild,
    userId: actor.id,
    capability: "moderation.configure",
    grants: runtime.storage,
  });
  const latestConfiguration = storage.getModerationConfiguration();
  const configurationUnchanged = current
    ? latestConfiguration?.updatedAt === current.updatedAt
    : latestConfiguration === null;
  if (
    !finalAuthorization.allowed ||
    !runtime.isCurrent() ||
    !configurationUnchanged
  ) {
    await replyPrivate(
      interaction,
      "Your authority or this server configuration changed before the binding could be saved.",
    );
    return;
  }
  const finalLogResources = await inspectModerationLogChannel(
    guild,
    proposed.moderationLogChannelId,
  );
  if (finalLogResources.issues.length > 0 || !runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "The moderation log binding changed during final verification.",
    );
    return;
  }
  for (const workflow of ["reports", "appeals"] as const) {
    const enabled =
      workflow === "reports"
        ? proposed.reportsEnabled
        : proposed.appealsEnabled;
    if (!enabled) continue;
    const resources = await inspectSafetyWorkflowResources(
      guild,
      proposed,
      workflow,
      runtime.storage,
    );
    const currentConfiguredRoleId =
      workflow === "reports"
        ? (current?.reportReviewerRoleId ?? null)
        : (current?.appealReviewerRoleId ?? null);
    const boundary = resources.reviewChannel
      ? await inspectContentDestinationBoundary({
          guild,
          userId: actor.id,
          capability:
            workflow === "reports" ? "reports.review" : "appeals.review",
          configuredRoleId: currentConfiguredRoleId,
          grants: runtime.storage,
          channel: resources.reviewChannel,
        })
      : "unverifiable";
    const proposedRoleId =
      workflow === "reports"
        ? proposed.reportReviewerRoleId
        : proposed.appealReviewerRoleId;
    if (
      !resources.reviewChannel ||
      resources.issues.length > 0 ||
      boundary === "visible-without-authority" ||
      boundary === "unverifiable" ||
      (proposedRoleId &&
        finalAuthorization.member.roles.cache.has(proposedRoleId) &&
        boundary !== "content-authorized") ||
      !runtime.isCurrent()
    ) {
      await replyPrivate(
        interaction,
        `The private ${workflow} binding or your independent content authority changed during final verification.`,
      );
      return;
    }
  }
  const terminalAuthorization = await authorizeCapability({
    guild,
    userId: actor.id,
    capability: "moderation.configure",
    grants: runtime.storage,
  });
  const terminalConfiguration = storage.getModerationConfiguration();
  const terminalConfigurationUnchanged = current
    ? terminalConfiguration?.updatedAt === current.updatedAt
    : terminalConfiguration === null;
  if (
    !terminalAuthorization.allowed ||
    !terminalConfigurationUnchanged ||
    !runtime.isCurrent()
  ) {
    await replyPrivate(
      interaction,
      "Your authority or moderation configuration changed at the final persistence boundary.",
    );
    return;
  }
  storage.upsertModerationConfiguration({
    casesEnabled: proposed.casesEnabled,
    moderationLogChannelId: proposed.moderationLogChannelId,
    moderationLogVerifiedAt: proposed.moderationLogVerifiedAt,
    reportsEnabled: proposed.reportsEnabled,
    reportReviewChannelId: proposed.reportReviewChannelId,
    reportReviewerRoleId: proposed.reportReviewerRoleId,
    reportBindingsVerifiedAt: proposed.reportBindingsVerifiedAt,
    appealsEnabled: proposed.appealsEnabled,
    appealReviewChannelId: proposed.appealReviewChannelId,
    appealReviewerRoleId: proposed.appealReviewerRoleId,
    appealBindingsVerifiedAt: proposed.appealBindingsVerifiedAt,
    antiSpamEnabled: proposed.antiSpamEnabled,
    reportCooldownLimit: proposed.reportCooldownLimit,
    reportCooldownWindowSeconds: proposed.reportCooldownWindowSeconds,
    actorId: terminalAuthorization.member.id,
  });
  runtime.invalidate();
  if (!proposed.antiSpamEnabled) clearAntiSpamProcessState(runtime.guildId);
  await replyPrivate(
    interaction,
    "Moderation and safety configuration was verified and saved. In-flight work from the prior generation was cancelled.",
  );
}

async function performAction(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
  storage: ModerationCommandStorage,
  action: string,
): Promise<void> {
  const targetId =
    action === "unban"
      ? interaction.options.getString("user_id", true).trim()
      : interaction.options.getUser("member", true).id;
  await runModerationTargetAction(runtime.guildId, targetId, () =>
    performSerializedAction(interaction, runtime, actor, storage, action),
  );
}

async function performSerializedAction(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
  storage: ModerationCommandStorage,
  action: string,
): Promise<void> {
  const configuration = storage.getModerationConfiguration();
  const recoveryReversal = action === "untimeout" || action === "unban";
  if (!configuration || (!configuration.casesEnabled && !recoveryReversal)) {
    await replyPrivate(
      interaction,
      "New moderation cases are disabled. Existing history remains available.",
    );
    return;
  }
  const guild = interaction.guild!;
  const reason =
    action === "note"
      ? "Private moderator note"
      : normalize(interaction.options.getString("reason", true), 1, 500);
  const privateNote = normalize(
    interaction.options.getString("private_note", false),
    1,
    1_000,
  );
  if (!reason || (action === "note" && !privateNote)) {
    await replyPrivate(
      interaction,
      "Provide the required bounded reason or private note.",
    );
    return;
  }
  if (action === "unban") {
    const userId = interaction.options.getString("user_id", true).trim();
    if (!/^\d{17,20}$/u.test(userId) || actor.guild.id !== guild.id) {
      await replyPrivate(
        interaction,
        "A valid user ID and current moderation authority are required.",
      );
      return;
    }
    const originalLookup = storage.findUniqueActiveModerationCase(userId, [
      "ban",
    ]);
    if (originalLookup.status === "ambiguous") {
      await replyPrivate(
        interaction,
        "Multiple active ban cases exist for this user. Resolve the case history before changing Discord state.",
      );
      return;
    }
    const originalBan =
      originalLookup.status === "found" ? originalLookup.case : null;
    const boundaryConfiguration = storage.getModerationConfiguration();
    const finalAuthorization = await authorizeCapability({
      guild,
      userId: actor.id,
      capability: "moderation.manage",
      grants: runtime.storage,
    });
    const [finalBot, finalBanState] = await Promise.all([
      fetchCurrentBotMember(guild, { force: true }),
      fetchBanState(guild, userId),
    ]);
    const finalConfiguration = storage.getModerationConfiguration();
    if (
      !finalAuthorization.allowed ||
      !finalBot?.permissions.has(PermissionFlagsBits.BanMembers) ||
      finalBanState === "unavailable" ||
      !finalConfiguration ||
      (!finalConfiguration.casesEnabled && !originalBan) ||
      boundaryConfiguration?.updatedAt !== configuration.updatedAt ||
      finalConfiguration.updatedAt !== configuration.updatedAt ||
      !runtime.isCurrent()
    ) {
      await replyPrivate(
        interaction,
        "Your current authority or this server configuration changed before the unban could run.",
      );
      return;
    }
    if (finalBanState === "absent" && !originalBan) {
      await replyPrivate(
        interaction,
        "That user is already absent from the ban list and no active Superior ban case requires reconciliation.",
      );
      return;
    }
    const terminalActor = finalAuthorization.member;
    const attempt = storage.reserveModerationCaseAttempt({
      targetUserId: userId,
      actorId: terminalActor.id,
      actionType: "unban",
      source: "moderation-command",
      publicReason: reason,
      privateNote,
      relatedCaseId: originalBan?.caseId ?? null,
    });
    if (finalBanState === "banned") {
      try {
        await guild.bans.remove(userId, reason);
      } catch {
        storage.failModerationCaseAttempt(attempt.caseId, {
          actorId: terminalActor.id,
          failureCode: "discord-unban-failed",
          expectedUpdatedAt: attempt.updatedAt,
        });
        await replyPrivate(
          interaction,
          `Discord rejected the unban. Failed attempt case #${attempt.caseNumber} was retained explicitly.`,
        );
        return;
      }
      const confirmed = await fetchBanState(guild, userId);
      if (confirmed !== "absent") {
        storage.failModerationCaseAttempt(attempt.caseId, {
          actorId: terminalActor.id,
          failureCode:
            confirmed === "unavailable"
              ? "discord-unban-state-ambiguous"
              : "discord-unban-not-confirmed",
          expectedUpdatedAt: attempt.updatedAt,
        });
        await replyPrivate(
          interaction,
          `Discord did not unambiguously confirm the unban. Attempt case #${attempt.caseNumber} needs recovery.`,
        );
        return;
      }
    }
    const finalized = originalBan
      ? storage.finalizeBanRemovalCase(attempt.caseId, {
          actorId: terminalActor.id,
          originalCaseId: originalBan.caseId,
          removalExpectedUpdatedAt: attempt.updatedAt,
          originalExpectedUpdatedAt: originalBan.updatedAt,
        })
      : storage.confirmModerationCase(attempt.caseId, {
          actorId: terminalActor.id,
          status: "completed",
          expectedUpdatedAt: attempt.updatedAt,
        });
    if (finalized.status !== "changed" && finalized.status !== "unchanged") {
      await replyPrivate(
        interaction,
        `Discord confirmed the unban, but attempt case #${attempt.caseNumber} needs persistence recovery.`,
      );
      return;
    }
    const confirmedCase =
      "removalCase" in finalized ? finalized.removalCase : finalized.case;
    if ("originalCase" in finalized) {
      await deliverModerationCaseLog(guild, runtime, finalized.originalCase);
    }
    await finishConfirmedCase(interaction, runtime, confirmedCase);
    return;
  }
  const selected = interaction.options.getUser("member", true);
  const target = await guild.members
    .fetch({ user: selected.id, cache: true, force: true })
    .catch(() => null);
  const bot = await guild.members
    .fetchMe({ cache: true, force: true })
    .catch(() => null);
  const issue = targetIssue(actor, bot, target, action);
  if (issue) {
    await replyPrivate(interaction, issue);
    return;
  }
  const finalAuthorization = await authorizeCapability({
    guild,
    userId: actor.id,
    capability: "moderation.manage",
    grants: runtime.storage,
  });
  if (!finalAuthorization.allowed) {
    await replyPrivate(
      interaction,
      "Your moderation authority changed before the action could run.",
    );
    return;
  }
  const terminalAuthorization = await authorizeCapability({
    guild,
    userId: actor.id,
    capability: "moderation.manage",
    grants: runtime.storage,
  });
  const [terminalTarget, terminalBot] = await Promise.all([
    fetchGuildMemberCoalesced(guild, selected.id, {
      cache: true,
      force: true,
    }),
    fetchCurrentBotMember(guild, { force: true }),
  ]);
  const terminalActor = terminalAuthorization.allowed
    ? terminalAuthorization.member
    : null;
  const finalIssue = terminalActor
    ? targetIssue(terminalActor, terminalBot, terminalTarget, action)
    : "Your moderation authority changed before the action could run.";
  const finalConfiguration = storage.getModerationConfiguration();
  if (
    finalIssue ||
    !finalConfiguration ||
    (!finalConfiguration.casesEnabled && !recoveryReversal) ||
    finalConfiguration.updatedAt !== configuration.updatedAt ||
    !runtime.isCurrent()
  ) {
    await replyPrivate(
      interaction,
      finalIssue ??
        "Moderation configuration changed before the action could run.",
    );
    return;
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "Server configuration changed before the action could run.",
    );
    return;
  }
  const confirmedTarget = terminalTarget!;
  const confirmedActor = terminalActor!;
  let actionType: ModerationCaseInput["actionType"];
  let status: ModerationCaseInput["status"] = "completed";
  let metadata: unknown = undefined;
  const destructive = ["timeout", "untimeout", "kick", "ban"].includes(action);
  const timeoutLookup =
    action === "untimeout"
      ? storage.findUniqueActiveModerationCase(confirmedTarget.id, [
          "timeout",
          "automod-timeout",
        ])
      : null;
  if (timeoutLookup?.status === "ambiguous") {
    await replyPrivate(
      interaction,
      "Multiple active timeout cases exist for this member. Resolve the case history before changing Discord state.",
    );
    return;
  }
  const liveTimeoutExpiry = confirmedTarget.isCommunicationDisabled()
    ? (confirmedTarget.communicationDisabledUntil?.getTime() ?? null)
    : null;
  const originalTimeout =
    timeoutLookup?.status === "found" &&
    (!confirmedTarget.isCommunicationDisabled() ||
      timeoutExpiry(timeoutLookup.case) === liveTimeoutExpiry)
      ? timeoutLookup.case
      : null;
  if (
    action === "untimeout" &&
    originalTimeout &&
    !confirmedTarget.isCommunicationDisabled() &&
    (timeoutExpiry(originalTimeout) ?? Number.POSITIVE_INFINITY) <= Date.now()
  ) {
    const completed = storage.completeExpiredTimeoutCase(
      originalTimeout.caseId,
      {
        actorId: confirmedActor.id,
        observedAt: new Date().toISOString(),
        expectedUpdatedAt: originalTimeout.updatedAt,
      },
    );
    if (completed.status === "changed" || completed.status === "unchanged") {
      await deliverModerationCaseLog(guild, runtime, completed.case);
      await replyPrivate(
        interaction,
        `Case #${completed.case.caseNumber} was completed as a naturally expired timeout; no timeout-removal case was created.`,
      );
    } else {
      await replyPrivate(
        interaction,
        "The expired timeout case changed before natural-expiry reconciliation could be saved.",
      );
    }
    return;
  }
  if (
    action === "untimeout" &&
    !finalConfiguration.casesEnabled &&
    !originalTimeout
  ) {
    await replyPrivate(
      interaction,
      "New cases are disabled; timeout recovery requires one uniquely matched active timeout case.",
    );
    return;
  }
  if (
    action === "untimeout" &&
    confirmedTarget.isCommunicationDisabled() &&
    timeoutLookup?.status === "found" &&
    !originalTimeout
  ) {
    await replyPrivate(
      interaction,
      "The current Discord timeout does not match an active case expiry, so Superior will not clear or complete the wrong case.",
    );
    return;
  }
  if (
    action === "untimeout" &&
    !confirmedTarget.isCommunicationDisabled() &&
    !originalTimeout
  ) {
    await replyPrivate(
      interaction,
      "That member is not currently timed out and no active Superior timeout case requires reconciliation.",
    );
    return;
  }
  const attempt = destructive
    ? storage.reserveModerationCaseAttempt({
        targetUserId: confirmedTarget.id,
        actorId: confirmedActor.id,
        actionType:
          action === "untimeout"
            ? "timeout-removed"
            : (action as "timeout" | "kick" | "ban"),
        source: "moderation-command",
        publicReason: reason,
        privateNote,
        relatedCaseId: originalTimeout?.caseId ?? null,
        discordActionMetadata:
          action === "timeout"
            ? {
                requestedDurationSeconds:
                  interaction.options.getInteger("minutes", true) * 60,
              }
            : action === "untimeout"
              ? {
                  originalCaseId: originalTimeout?.caseId ?? null,
                  originalExpiresAt:
                    originalTimeout && timeoutExpiry(originalTimeout) !== null
                      ? new Date(timeoutExpiry(originalTimeout)!).toISOString()
                      : (confirmedTarget.communicationDisabledUntil?.toISOString() ??
                        null),
                }
              : undefined,
      })
    : null;
  const failAttempt = async (failureCode: string, message: string) => {
    if (attempt) {
      storage.failModerationCaseAttempt(attempt.caseId, {
        actorId: confirmedActor.id,
        failureCode,
        expectedUpdatedAt: attempt.updatedAt,
      });
    }
    await replyPrivate(
      interaction,
      `${message}${attempt ? ` Failed attempt case #${attempt.caseNumber} was retained explicitly.` : ""}`,
    );
  };
  if (action === "warn" || action === "note") {
    actionType = action === "warn" ? "warning" : "note";
    status = action === "warn" ? "active" : "completed";
  } else if (action === "timeout") {
    if (confirmedTarget.isCommunicationDisabled()) {
      await failAttempt(
        "timeout-already-active",
        "That member is already timed out; use the matching case or authorized timeout-removal flow.",
      );
      return;
    }
    const minutes = interaction.options.getInteger("minutes", true);
    const duration = minutes * 60_000;
    try {
      await confirmedTarget.timeout(duration, reason);
    } catch {
      await failAttempt(
        "discord-timeout-failed",
        "Discord rejected the timeout.",
      );
      return;
    }
    const refreshed = await guild.members
      .fetch({ user: confirmedTarget.id, cache: true, force: true })
      .catch(() => null);
    if (!refreshed?.isCommunicationDisabled())
      return void (await failAttempt(
        "timeout-not-confirmed",
        "Discord did not confirm the timeout.",
      ));
    actionType = "timeout";
    status = "active";
    metadata = {
      durationSeconds: minutes * 60,
      expiresAt: refreshed.communicationDisabledUntil?.toISOString() ?? null,
    };
  } else if (action === "untimeout") {
    if (confirmedTarget.isCommunicationDisabled()) {
      try {
        await confirmedTarget.timeout(null, reason);
      } catch {
        await failAttempt(
          "discord-untimeout-failed",
          "Discord rejected timeout removal.",
        );
        return;
      }
      const refreshed = await guild.members
        .fetch({ user: confirmedTarget.id, cache: true, force: true })
        .catch(() => null);
      if (!refreshed || refreshed.isCommunicationDisabled())
        return void (await failAttempt(
          "untimeout-not-confirmed",
          "Discord did not confirm timeout removal.",
        ));
    } else if (!originalTimeout) {
      await failAttempt(
        "timeout-already-absent",
        "That member is not currently timed out and no active case requires reconciliation.",
      );
      return;
    }
    actionType = "timeout-removed";
  } else if (action === "kick") {
    try {
      await confirmedTarget.kick(reason);
    } catch {
      await failAttempt("discord-kick-failed", "Discord rejected the kick.");
      return;
    }
    actionType = "kick";
  } else if (action === "ban") {
    const deleteMessageSeconds =
      interaction.options.getInteger("delete_message_seconds", false) ?? 0;
    try {
      await guild.bans.create(confirmedTarget.id, {
        deleteMessageSeconds,
        reason,
      });
    } catch {
      await failAttempt("discord-ban-failed", "Discord rejected the ban.");
      return;
    }
    actionType = "ban";
    status = "active";
    metadata = { deleteMessageSeconds };
  } else {
    await replyPrivate(interaction, "Choose a supported moderation action.");
    return;
  }
  if (attempt) {
    const finalized =
      action === "untimeout" && originalTimeout
        ? storage.finalizeTimeoutRemovalCase(attempt.caseId, {
            actorId: confirmedActor.id,
            originalCaseId: originalTimeout.caseId,
            discordActionMetadata: metadata,
            removalExpectedUpdatedAt: attempt.updatedAt,
            originalExpectedUpdatedAt: originalTimeout.updatedAt,
          })
        : storage.confirmModerationCase(attempt.caseId, {
            actorId: confirmedActor.id,
            status,
            discordActionMetadata: metadata,
            expectedUpdatedAt: attempt.updatedAt,
          });
    if (finalized.status !== "changed" && finalized.status !== "unchanged") {
      await replyPrivate(
        interaction,
        `Discord confirmed the action, but attempt case #${attempt.caseNumber} needs persistence recovery.`,
      );
      return;
    }
    const confirmedCase =
      "removalCase" in finalized ? finalized.removalCase : finalized.case;
    if ("originalCase" in finalized) {
      await deliverModerationCaseLog(
        interaction.guild!,
        runtime,
        finalized.originalCase,
      );
    }
    await finishConfirmedCase(interaction, runtime, confirmedCase);
    return;
  }
  await createAndDeliver(interaction, runtime, storage, {
    targetUserId: confirmedTarget.id,
    actorId: confirmedActor.id,
    actionType,
    source: "moderation-command",
    publicReason: reason,
    privateNote,
    discordActionMetadata: metadata,
    status,
  });
}

async function finishConfirmedCase(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  record: ModerationCase,
): Promise<void> {
  const delivered = await deliverModerationCaseLog(
    interaction.guild!,
    runtime,
    record,
  );
  await replyPrivate(
    interaction,
    `Completed **${record.actionType}** and confirmed case #${record.caseNumber}.${delivered === "failed" || delivered === "unavailable" ? " The case is saved, but log delivery needs recovery." : ""}`,
  );
  runtime.storage.recordCommandMetric(`moderation.${record.actionType}`);
}

async function createAndDeliver(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: ModerationCommandStorage,
  input: ModerationCaseInput,
): Promise<void> {
  const record = storage.createModerationCase(input);
  if (record.actionType === "warning") {
    const target = await fetchGuildMemberCoalesced(
      interaction.guild!,
      record.targetUserId,
      { cache: true, force: true },
    );
    await target
      ?.send({
        content:
          `You received a warning in **${escapeMarkdown(interaction.guild!.name)}**. Reason: ${escapeMarkdown(record.publicReason)}`.slice(
            0,
            2_000,
          ),
        allowedMentions: { parse: [] },
      })
      .catch(() => undefined);
  }
  const delivered = await deliverModerationCaseLog(
    interaction.guild!,
    runtime,
    record,
  );
  await replyPrivate(
    interaction,
    `Completed **${record.actionType}** and created case #${record.caseNumber}.${delivered === "failed" || delivered === "unavailable" ? " The case is saved, but log delivery needs recovery." : ""}`,
  );
  runtime.storage.recordCommandMetric(`moderation.${record.actionType}`);
}

async function showHistory(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
  storage: ModerationCommandStorage,
): Promise<void> {
  const member = interaction.options.getUser("member", true);
  const page = interaction.options.getInteger("page", false) ?? 1;
  let records = storage.listModerationCases({
    targetUserId: member.id,
    limit: 10,
    offset: (page - 1) * 10,
  });
  records = await reconcileExpiredTimeoutCases(
    interaction.guild!,
    runtime,
    storage,
    records,
    actor.id,
  );
  await replyPrivate(
    interaction,
    records.length
      ? [
          `**Moderation history for \`${member.id}\` · page ${page}**`,
          ...records.map(caseLine),
        ].join("\n")
      : "No cases were found on that page.",
  );
}
async function showCase(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
  storage: ModerationCommandStorage,
): Promise<void> {
  let record = storage.getModerationCaseByNumber(
    interaction.options.getInteger("case_number", true),
  );
  if (record?.guildId === runtime.guildId) {
    const reconciled = await reconcileExpiredTimeoutCases(
      interaction.guild!,
      runtime,
      storage,
      [record],
      actor.id,
    );
    record = reconciled[0] ?? record;
  }
  const page = interaction.options.getInteger("page", false) ?? 1;
  await replyPrivate(
    interaction,
    record && record.guildId === runtime.guildId
      ? caseDetails(
          record,
          storage.listModerationCaseEvents(record.caseId, 10, (page - 1) * 10),
          page,
        )
      : "That case was not found in this server.",
  );
}
async function amendCase(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
  storage: ModerationCommandStorage,
): Promise<void> {
  let record = storage.getModerationCaseByNumber(
    interaction.options.getInteger("case_number", true),
  );
  const publicReason = normalize(
    interaction.options.getString("public_reason", false),
    1,
    500,
  );
  const privateNote = normalize(
    interaction.options.getString("private_note", false),
    1,
    1_000,
  );
  if (
    !record ||
    record.guildId !== runtime.guildId ||
    (!publicReason && !privateNote)
  )
    return void (await replyPrivate(
      interaction,
      "Choose a current case and at least one bounded amendment.",
    ));
  const finalAuthorization = await authorizeCapability({
    guild: interaction.guild!,
    userId: actor.id,
    capability: "moderation.manage",
    grants: runtime.storage,
  });
  const latest = storage.getModerationCaseByNumber(record.caseNumber);
  if (
    !finalAuthorization.allowed ||
    !latest ||
    latest.updatedAt !== record.updatedAt ||
    !runtime.isCurrent()
  ) {
    await replyPrivate(
      interaction,
      "Your authority or that case changed before the amendment could be saved.",
    );
    return;
  }
  const result = storage.amendModerationCase(record.caseId, {
    actorId: finalAuthorization.member.id,
    ...(publicReason ? { publicReason } : {}),
    ...(privateNote ? { privateNote } : {}),
    expectedUpdatedAt: record.updatedAt,
  });
  if (result.status !== "changed" && result.status !== "unchanged")
    return void (await replyPrivate(
      interaction,
      "That case changed concurrently. Refresh it and try again.",
    ));
  await deliverModerationCaseLog(interaction.guild!, runtime, result.case);
  await replyPrivate(
    interaction,
    `Case #${record.caseNumber} was amended with its prior values retained in audit history.`,
  );
}
async function voidCase(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
  storage: ModerationCommandStorage,
): Promise<void> {
  let record = storage.getModerationCaseByNumber(
    interaction.options.getInteger("case_number", true),
  );
  const reason = normalize(
    interaction.options.getString("reason", true),
    1,
    500,
  )!;
  if (!record || record.guildId !== runtime.guildId)
    return void (await replyPrivate(
      interaction,
      "That case was not found in this server.",
    ));
  record =
    (
      await reconcileExpiredTimeoutCases(
        interaction.guild!,
        runtime,
        storage,
        [record],
        actor.id,
      )
    )[0] ?? record;
  const finalAuthorization = await authorizeCapability({
    guild: interaction.guild!,
    userId: actor.id,
    capability: "moderation.manage",
    grants: runtime.storage,
  });
  const latest = storage.getModerationCaseByNumber(record.caseNumber);
  if (
    !finalAuthorization.allowed ||
    !latest ||
    latest.updatedAt !== record.updatedAt ||
    !runtime.isCurrent()
  ) {
    await replyPrivate(
      interaction,
      "Your authority or that case changed before it could be voided.",
    );
    return;
  }
  if (
    latest.status === "active" &&
    ["timeout", "automod-timeout", "ban"].includes(latest.actionType)
  ) {
    await replyPrivate(
      interaction,
      "Active timeout and ban cases cannot be voided while the Discord sanction remains in place. Remove the timeout or ban first, then amend or void the completed record.",
    );
    return;
  }
  const result = storage.voidModerationCase(record.caseId, {
    actorId: finalAuthorization.member.id,
    reason,
    expectedUpdatedAt: record.updatedAt,
  });
  if (result.status !== "changed" && result.status !== "unchanged")
    return void (await replyPrivate(
      interaction,
      "That case cannot be voided from its current state.",
    ));
  await deliverModerationCaseLog(interaction.guild!, runtime, result.case);
  await replyPrivate(
    interaction,
    `Case #${record.caseNumber} was voided. Discord state was not changed.`,
  );
}
async function recoverCaseAttempt(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
  storage: ModerationCommandStorage,
): Promise<void> {
  let record = storage.getModerationCaseByNumber(
    interaction.options.getInteger("case_number", true),
  );
  if (!record || record.guildId !== runtime.guildId)
    return void (await replyPrivate(
      interaction,
      "That case was not found in this server.",
    ));
  record =
    (
      await reconcileExpiredTimeoutCases(
        interaction.guild!,
        runtime,
        storage,
        [record],
        actor.id,
      )
    )[0] ?? record;
  const mode = interaction.options.getString("mode", true);
  const finalAuthorization = await authorizeCapability({
    guild: interaction.guild!,
    userId: actor.id,
    capability: "moderation.manage",
    grants: runtime.storage,
  });
  const current = storage.getModerationCaseByNumber(record.caseNumber);
  if (
    !finalAuthorization.allowed ||
    !current ||
    current.updatedAt !== record.updatedAt ||
    !runtime.isCurrent()
  ) {
    await replyPrivate(
      interaction,
      "Your authority or the case changed before recovery could begin.",
    );
    return;
  }
  if (mode === "fail") {
    const failureCode = normalize(
      interaction.options.getString("failure_code", false) ??
        "operator-confirmed-failure",
      1,
      100,
    );
    if (!failureCode || current.status !== "failed") {
      await replyPrivate(
        interaction,
        "Fail mode requires a failed reserved attempt and a bounded failure code.",
      );
      return;
    }
    const result = storage.failModerationCaseAttempt(current.caseId, {
      actorId: finalAuthorization.member.id,
      failureCode,
      expectedUpdatedAt: current.updatedAt,
    });
    await replyPrivate(
      interaction,
      result.status === "changed" || result.status === "unchanged"
        ? `Recorded explicit failure recovery for case #${current.caseNumber}.`
        : "That attempt changed before its failure checkpoint could be recorded.",
    );
    return;
  }
  if (mode === "confirm") {
    await confirmRecoveredCase(
      interaction,
      runtime,
      finalAuthorization.member,
      storage,
      current,
    );
    return;
  }
  if (mode !== "log") {
    await replyPrivate(
      interaction,
      "Choose log, confirm, or fail recovery mode.",
    );
    return;
  }
  const result = await deliverModerationCaseLog(
    interaction.guild!,
    runtime,
    record,
  );
  await replyPrivate(
    interaction,
    result === "delivered" || result === "updated"
      ? `Moderation case #${record.caseNumber} log is synchronized.`
      : "The log could not be recovered with the current verified binding.",
  );
}

async function confirmRecoveredCase(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
  storage: ModerationCommandStorage,
  record: ModerationCase,
): Promise<void> {
  if (record.status !== "failed") {
    await replyPrivate(
      interaction,
      "Only a failed reserved action attempt can be explicitly confirmed.",
    );
    return;
  }
  const guild = interaction.guild!;
  let status: "active" | "completed";
  let metadata: unknown = undefined;
  if (
    record.actionType === "timeout" ||
    record.actionType === "automod-timeout"
  ) {
    const member = await guild.members
      .fetch({ user: record.targetUserId, cache: true, force: true })
      .catch(() => null);
    if (
      !member?.isCommunicationDisabled() ||
      !member.communicationDisabledUntil
    ) {
      await replyPrivate(
        interaction,
        "Discord does not currently confirm an active timeout for this attempt.",
      );
      return;
    }
    const activeTimeout = storage.findUniqueActiveModerationCase(
      record.targetUserId,
      ["timeout", "automod-timeout"],
    );
    if (activeTimeout.status !== "none") {
      await replyPrivate(
        interaction,
        activeTimeout.status === "ambiguous"
          ? "Multiple active timeout cases exist, so this attempt cannot claim the current Discord timeout."
          : "An active timeout case already claims the current Discord timeout, so this failed attempt cannot also claim it.",
      );
      return;
    }
    const requestedDurationSeconds =
      metadataNumber(
        record.discordActionMetadata,
        "requestedDurationSeconds",
      ) ?? metadataNumber(record.discordActionMetadata, "timeoutSeconds");
    const expectedExpiry =
      requestedDurationSeconds === null
        ? null
        : Date.parse(record.createdAt) + requestedDurationSeconds * 1_000;
    if (
      expectedExpiry === null ||
      Math.abs(member.communicationDisabledUntil.getTime() - expectedExpiry) >
        120_000
    ) {
      await replyPrivate(
        interaction,
        "The current Discord timeout does not correlate with this reserved attempt's requested duration, so recovery will not claim it.",
      );
      return;
    }
    status = "active";
    metadata = {
      ...(record.discordActionMetadata &&
      typeof record.discordActionMetadata === "object"
        ? record.discordActionMetadata
        : {}),
      expiresAt: member.communicationDisabledUntil.toISOString(),
    };
  } else if (record.actionType === "ban") {
    try {
      await guild.bans.fetch(record.targetUserId);
    } catch {
      await replyPrivate(
        interaction,
        "Discord does not unambiguously confirm an active ban for this attempt.",
      );
      return;
    }
    status = "active";
  } else if (record.actionType === "unban") {
    try {
      await guild.bans.fetch(record.targetUserId);
      await replyPrivate(
        interaction,
        "Discord still reports this user as banned; unban success cannot be confirmed.",
      );
      return;
    } catch (error) {
      if ((error as { code?: unknown })?.code !== 10_026) {
        await replyPrivate(
          interaction,
          "Discord ban state is ambiguous; recovery did not confirm success.",
        );
        return;
      }
    }
    if (record.relatedCaseId) {
      const originalLookup = storage.findUniqueActiveModerationCase(
        record.targetUserId,
        ["ban"],
      );
      const original =
        originalLookup.status === "found" &&
        originalLookup.case.caseId === record.relatedCaseId
          ? originalLookup.case
          : null;
      const finalActor = await authorizeCapability({
        guild,
        userId: actor.id,
        capability: "moderation.manage",
        grants: runtime.storage,
      });
      const latestRemoval = storage.getModerationCaseByNumber(
        record.caseNumber,
      );
      const latestOriginalLookup = storage.findUniqueActiveModerationCase(
        record.targetUserId,
        ["ban"],
      );
      const latestOriginal =
        latestOriginalLookup.status === "found" &&
        latestOriginalLookup.case.caseId === original?.caseId
          ? latestOriginalLookup.case
          : null;
      if (
        !finalActor.allowed ||
        !original ||
        !latestRemoval ||
        latestRemoval.updatedAt !== record.updatedAt ||
        !latestOriginal ||
        latestOriginal.updatedAt !== original.updatedAt ||
        !runtime.isCurrent()
      ) {
        await replyPrivate(
          interaction,
          "The linked ban cases or your authority changed before atomic unban recovery could finalize.",
        );
        return;
      }
      const finalized = storage.finalizeBanRemovalCase(record.caseId, {
        actorId: finalActor.member.id,
        originalCaseId: original.caseId,
        removalExpectedUpdatedAt: record.updatedAt,
        originalExpectedUpdatedAt: original.updatedAt,
      });
      if (finalized.status !== "changed" && finalized.status !== "unchanged") {
        await replyPrivate(
          interaction,
          "The linked ban cases changed before atomic unban recovery could finalize.",
        );
        return;
      }
      await deliverModerationCaseLog(guild, runtime, finalized.originalCase);
      await finishConfirmedCase(interaction, runtime, finalized.removalCase);
      return;
    }
    status = "completed";
  } else if (record.actionType === "timeout-removed") {
    if (record.source === "appeal-review") {
      await replyPrivate(
        interaction,
        "Appeal timeout-removal attempts must be reconciled atomically by retrying the current appeal decision.",
      );
      return;
    }
    const originalLookup = storage.findUniqueActiveModerationCase(
      record.targetUserId,
      ["timeout", "automod-timeout"],
    );
    const original =
      record.relatedCaseId &&
      originalLookup.status === "found" &&
      originalLookup.case.caseId === record.relatedCaseId
        ? originalLookup.case
        : null;
    const member = await guild.members
      .fetch({ user: record.targetUserId, cache: true, force: true })
      .catch(() => null);
    const reservedOriginalExpiry = metadataTimestamp(
      record.discordActionMetadata,
      "originalExpiresAt",
    );
    const originalExpiry = original ? timeoutExpiry(original) : null;
    if (
      !member ||
      member.isCommunicationDisabled() ||
      !original ||
      reservedOriginalExpiry === null ||
      originalExpiry === null ||
      reservedOriginalExpiry !== originalExpiry ||
      Date.now() >= originalExpiry
    ) {
      await replyPrivate(
        interaction,
        "Timeout removal recovery needs an un-timed-out member plus an unexpired, exactly correlated original timeout case and reservation.",
      );
      return;
    }
    const finalActor = await authorizeCapability({
      guild,
      userId: actor.id,
      capability: "moderation.manage",
      grants: runtime.storage,
    });
    if (!finalActor.allowed || !runtime.isCurrent()) {
      await replyPrivate(
        interaction,
        "Your authority changed before timeout-removal recovery could finalize.",
      );
      return;
    }
    const latestOriginalLookup = storage.findUniqueActiveModerationCase(
      record.targetUserId,
      ["timeout", "automod-timeout"],
    );
    const latestOriginal =
      latestOriginalLookup.status === "found" &&
      latestOriginalLookup.case.caseId === original.caseId
        ? latestOriginalLookup.case
        : null;
    const latestRemoval = storage.getModerationCaseByNumber(record.caseNumber);
    if (
      !latestOriginal ||
      latestOriginal.updatedAt !== original.updatedAt ||
      !latestRemoval ||
      latestRemoval.updatedAt !== record.updatedAt
    ) {
      await replyPrivate(
        interaction,
        "The linked timeout cases changed before atomic recovery could finalize.",
      );
      return;
    }
    const finalized = storage.finalizeTimeoutRemovalCase(record.caseId, {
      actorId: finalActor.member.id,
      originalCaseId: original.caseId,
      removalExpectedUpdatedAt: record.updatedAt,
      originalExpectedUpdatedAt: original.updatedAt,
    });
    if (finalized.status !== "changed" && finalized.status !== "unchanged") {
      await replyPrivate(
        interaction,
        "The linked timeout cases changed before atomic recovery could finalize.",
      );
      return;
    }
    await deliverModerationCaseLog(guild, runtime, finalized.originalCase);
    await finishConfirmedCase(interaction, runtime, finalized.removalCase);
    return;
  } else if (record.actionType === "kick") {
    // Kick has no durable Discord state to query. Reaching this branch is an
    // explicit operator assertion through mode:confirm; absence is not proof.
    status = "completed";
  } else {
    await replyPrivate(
      interaction,
      "This case type does not use failed-attempt confirmation recovery.",
    );
    return;
  }
  const finalActor = await authorizeCapability({
    guild,
    userId: actor.id,
    capability: "moderation.manage",
    grants: runtime.storage,
  });
  const latest = storage.getModerationCaseByNumber(record.caseNumber);
  if (
    !finalActor.allowed ||
    !latest ||
    latest.updatedAt !== record.updatedAt ||
    !runtime.isCurrent()
  ) {
    await replyPrivate(
      interaction,
      "Your authority or the attempt changed at the final recovery boundary.",
    );
    return;
  }
  const result = storage.confirmModerationCase(record.caseId, {
    actorId: finalActor.member.id,
    status,
    ...(metadata === undefined ? {} : { discordActionMetadata: metadata }),
    expectedUpdatedAt: record.updatedAt,
  });
  if (result.status !== "changed" && result.status !== "unchanged") {
    await replyPrivate(
      interaction,
      "The failed attempt changed before confirmed recovery could be persisted.",
    );
    return;
  }
  await finishConfirmedCase(interaction, runtime, result.case);
}
async function showConfiguration(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: ModerationCommandStorage,
): Promise<void> {
  const config = storage.getModerationConfiguration();
  if (!config || config.guildId !== runtime.guildId) {
    await replyPrivate(
      interaction,
      "Moderation and safety services are not configured.",
    );
    return;
  }
  const [log, reports, appeals] = await Promise.all([
    inspectModerationLogChannel(
      interaction.guild!,
      config.moderationLogChannelId,
    ),
    inspectSafetyWorkflowResources(
      interaction.guild!,
      config,
      "reports",
      runtime.storage,
    ),
    inspectSafetyWorkflowResources(
      interaction.guild!,
      config,
      "appeals",
      runtime.storage,
    ),
  ]);
  const latest = storage.getModerationConfiguration();
  if (
    !latest ||
    latest.updatedAt !== config.updatedAt ||
    !runtime.isCurrent()
  ) {
    await replyPrivate(
      interaction,
      "Moderation configuration changed while its current Discord health was being checked. Try again.",
    );
    return;
  }
  await replyPrivate(
    interaction,
    [
      "**Moderation and safety status**",
      `Cases: **${on(config.casesEnabled)}**`,
      `Moderation log: ${bindingHealth(config.moderationLogChannelId, config.moderationLogVerifiedAt, log.channel?.id, log.issues)}`,
      `Reports: **${on(config.reportsEnabled)}** · ${bindingHealth(config.reportReviewChannelId, config.reportBindingsVerifiedAt, reports.reviewChannel?.id, reports.issues)}`,
      `Appeals: **${on(config.appealsEnabled)}** · ${bindingHealth(config.appealReviewChannelId, config.appealBindingsVerifiedAt, appeals.reviewChannel?.id, appeals.issues)}`,
      `Anti-spam: **${on(config.antiSpamEnabled)}**`,
    ]
      .join("\n")
      .slice(0, 2_000),
  );
}

function bindingHealth(
  configuredId: string | null,
  verifiedAt: string | null,
  currentId: string | undefined,
  issues: readonly string[],
): string {
  if (!configuredId) return "not configured";
  if (!verifiedAt) return `<#${configuredId}> (stored binding unverified)`;
  if (currentId !== configuredId || issues.length > 0) {
    const issue = issues[0]
      ? escapeMarkdown(issues[0]).slice(0, 300)
      : "configured resource could not be freshly verified";
    return `<#${configuredId}> (**unhealthy now**: ${issue})`;
  }
  return `<#${configuredId}> (verified and healthy now)`;
}

export function targetIssue(
  actor: GuildMember,
  bot: GuildMember | null,
  target: GuildMember | null,
  action: string,
): string | null {
  if (!target || !bot)
    return "Superior could not freshly verify the target and bot members.";
  if (target.id === target.guild.ownerId)
    return "The server owner cannot be targeted.";
  if (target.id === actor.id) return "You cannot target yourself.";
  if (target.id === bot.id || target.user.bot)
    return "Bots cannot be targeted through this command.";
  if (
    actor.id !== target.guild.ownerId &&
    !actor.permissions.has(PermissionFlagsBits.Administrator) &&
    actor.roles.highest.comparePositionTo(target.roles.highest) <= 0
  )
    return "Your current highest role must be above the target's highest role.";
  const permission =
    action === "kick"
      ? PermissionFlagsBits.KickMembers
      : action === "ban"
        ? PermissionFlagsBits.BanMembers
        : PermissionFlagsBits.ModerateMembers;
  if (!["warn", "note"].includes(action) && !bot.permissions.has(permission))
    return `Superior needs the Discord permission required for ${action}.`;
  if (action === "kick" && !target.kickable)
    return "Superior cannot kick that member with current hierarchy.";
  if (action === "ban" && !target.bannable)
    return "Superior cannot ban that member with current hierarchy.";
  if (["timeout", "untimeout"].includes(action) && !target.moderatable)
    return "Superior cannot moderate that member with current hierarchy.";
  return null;
}
async function selectedTextChannel(
  interaction: ChatInputCommandInteraction,
  name: string,
): Promise<TextChannel | null> {
  const selected = interaction.options.getChannel(name, false);
  if (!selected) return null;
  const channel = await interaction
    .guild!.channels.fetch(selected.id, { cache: true, force: true })
    .catch(() => null);
  return channel?.type === ChannelType.GuildText &&
    channel.guild.id === interaction.guildId
    ? channel
    : null;
}
async function selectedRole(
  interaction: ChatInputCommandInteraction,
  name: string,
) {
  const selected = interaction.options.getRole(name, false);
  if (!selected) return null;
  const role = await fetchGuildRoleCoalesced(interaction.guild!, selected.id, {
    cache: true,
    force: true,
  });
  return role &&
    role.guild.id === interaction.guildId &&
    role.id !== interaction.guildId &&
    !role.managed
    ? role
    : null;
}
function hasSelected(
  interaction: ChatInputCommandInteraction,
  name: string,
): boolean {
  return Boolean(
    interaction.options.data
      .flatMap((entry) =>
        "options" in entry && entry.options ? entry.options : [entry],
      )
      .find((entry) => entry.name === name),
  );
}
function normalize(
  value: string | null,
  min: number,
  max: number,
): string | null {
  if (value === null) return null;
  const normalized = value.normalize("NFKC").replace(/\r\n?/gu, "\n").trim();
  return normalized.length >= min &&
    normalized.length <= max &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)
    ? normalized
    : null;
}
function caseLine(record: ModerationCase): string {
  return `#${record.caseNumber} · ${escapeMarkdown(record.actionType)} · **${escapeMarkdown(record.status)}** · <t:${unix(record.createdAt)}:R>`;
}
function caseDetails(
  record: ModerationCase,
  events: readonly ModerationCaseEvent[] = [],
  eventPage = 1,
): string {
  return [
    `**Moderation Case #${record.caseNumber}**`,
    `Target: \`${record.targetUserId}\``,
    `Actor: \`${record.actorId}\``,
    `Action: **${record.actionType}**`,
    `Status: **${record.status}**`,
    `Public reason: ${escapeMarkdown(record.publicReason)}`,
    record.privateNote
      ? `Private note: ${escapeMarkdown(record.privateNote)}`
      : null,
    events.length > 0 ? `**Audit events · page ${eventPage}**` : null,
    ...events.map(
      (event) =>
        `#${event.eventNumber} · ${escapeMarkdown(event.type)} · ${event.actorId ? `actor \`${event.actorId}\`` : "system"} · <t:${unix(event.createdAt)}:R>${eventDetailSummary(event)}`,
    ),
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 2_000);
}

const INSPECTABLE_EVENT_DETAIL_KEYS = new Set([
  "actionType",
  "appealId",
  "attemptId",
  "caseNumber",
  "channelId",
  "expiresAt",
  "failureCode",
  "messageId",
  "observedAt",
  "originalCaseId",
  "originalExpiresAt",
  "previousPrivateNote",
  "previousPublicReason",
  "privateNote",
  "publicReason",
  "reason",
  "relatedCaseId",
  "reviewerId",
  "state",
  "status",
]);

function eventDetailSummary(event: ModerationCaseEvent): string {
  if (
    !event.details ||
    typeof event.details !== "object" ||
    Array.isArray(event.details)
  ) {
    return "";
  }
  const values = Object.entries(event.details as Record<string, unknown>)
    .filter(
      ([key, value]) =>
        INSPECTABLE_EVENT_DETAIL_KEYS.has(key) &&
        (value === null ||
          ["string", "number", "boolean"].includes(typeof value)),
    )
    .slice(0, 8)
    .map(([key, value]) => {
      const rendered = value === null ? "(none)" : String(value);
      return `${key}: ${escapeMarkdown(safeDisplayText(rendered, 180))}`;
    });
  return values.length > 0 ? `\n  ${values.join(" · ")}` : "";
}
function unix(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : 0;
}
export function timeoutExpiry(record: ModerationCase): number | null {
  if (
    !record.discordActionMetadata ||
    typeof record.discordActionMetadata !== "object"
  ) {
    return null;
  }
  const value = (record.discordActionMetadata as { expiresAt?: unknown })
    .expiresAt;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function reconcileExpiredTimeoutCases(
  guild: Guild,
  runtime: GuildRuntime,
  storage: ModerationCommandStorage,
  records: readonly ModerationCase[],
  actorId: string,
): Promise<ModerationCase[]> {
  const observedAt = new Date().toISOString();
  const observedMs = Date.parse(observedAt);
  const candidates = records.filter((record) => {
    const expiry = timeoutExpiry(record);
    return (
      record.status === "active" &&
      (record.actionType === "timeout" ||
        record.actionType === "automod-timeout") &&
      expiry !== null &&
      expiry <= observedMs
    );
  });
  if (candidates.length === 0) return [...records];

  const observations = new Map<
    string,
    { known: boolean; liveExpiry: number | null }
  >();
  for (const targetId of new Set(
    candidates.map((record) => record.targetUserId),
  )) {
    try {
      const member = await fetchGuildMemberCoalescedOrThrow(guild, targetId, {
        cache: true,
        force: true,
      });
      observations.set(targetId, {
        known: true,
        liveExpiry: member.isCommunicationDisabled()
          ? (member.communicationDisabledUntil?.getTime() ?? null)
          : null,
      });
    } catch (error) {
      observations.set(targetId, {
        known: isUnknownDiscordResource(error, 10_007),
        liveExpiry: null,
      });
    }
  }
  const finalAuthorization = await authorizeCapability({
    guild,
    userId: actorId,
    capability: "moderation.manage",
    grants: runtime.storage,
  });
  if (!finalAuthorization.allowed || !runtime.isCurrent()) return [...records];

  const reconciled = new Map<string, ModerationCase>();
  for (const record of candidates) {
    const observation = observations.get(record.targetUserId);
    const expiry = timeoutExpiry(record);
    if (
      !observation?.known ||
      expiry === null ||
      (observation.liveExpiry !== null &&
        Math.abs(observation.liveExpiry - expiry) <= 2_000)
    ) {
      continue;
    }
    const result = storage.completeExpiredTimeoutCase(record.caseId, {
      actorId: finalAuthorization.member.id,
      observedAt,
      expectedUpdatedAt: record.updatedAt,
    });
    if (
      (result.status === "changed" || result.status === "unchanged") &&
      result.case
    ) {
      reconciled.set(record.caseId, result.case);
    }
  }
  return records.map((record) => reconciled.get(record.caseId) ?? record);
}

function isUnknownDiscordResource(
  error: unknown,
  expectedCode: number,
): boolean {
  if (!error || typeof error !== "object") return false;
  return Number((error as { code?: unknown }).code) === expectedCode;
}

async function fetchBanState(
  guild: Guild,
  userId: string,
): Promise<"banned" | "absent" | "unavailable"> {
  try {
    await guild.bans.fetch(userId);
    return "banned";
  } catch (error) {
    return isUnknownDiscordResource(error, 10_026) ? "absent" : "unavailable";
  }
}
function metadataNumber(metadata: unknown, key: string): number | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}
function metadataTimestamp(metadata: unknown, key: string): number | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>)[key];
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function on(value: boolean): string {
  return value ? "enabled" : "disabled";
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
