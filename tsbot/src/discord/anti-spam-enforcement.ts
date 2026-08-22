import {
  PermissionFlagsBits,
  type GuildMember,
  type Message,
} from "discord.js";
import { classifyError } from "../errors.js";
import { logError } from "../logging.js";
import type { GuildRuntime } from "../runtime.js";
import type {
  ModerationCase,
  ModerationCaseAttemptInput,
  ModerationCaseTransitionResult,
} from "../types.js";
import {
  AntiSpamDetector,
  type AntiSpamDetectorRule,
  type AntiSpamDetectorRuleType,
} from "./anti-spam-detector.js";
import { logDomainOutcome } from "./domain-outcomes.js";
import { deliverModerationCaseLog } from "./moderation-log-delivery.js";
import { runModerationTargetAction } from "./moderation-action-queue.js";

export type AntiSpamEnforcementAction =
  "delete" | "delete-and-warn" | "delete-and-timeout";

interface RuntimeAntiSpamRule extends AntiSpamDetectorRule {
  action: AntiSpamEnforcementAction;
  timeoutSeconds: number | null;
  cooldownSeconds: number;
}

interface RuntimeModerationConfiguration {
  casesEnabled: boolean;
  antiSpamEnabled: boolean;
}

interface AntiSpamReservation {
  status: "reserved" | "duplicate" | "cooldown" | "disabled";
  reservationId?: string | null;
  enforcement?: { state?: string | null } | null;
  retryAt?: string | null;
}

interface AntiSpamRuntimeStorage {
  getModerationConfiguration(): RuntimeModerationConfiguration | null;
  listAntiSpamRules(): RuntimeAntiSpamRule[];
  listAntiSpamExemptRoleIds(): string[];
  listAntiSpamExemptChannelIds(): string[];
  reserveAntiSpamEnforcement(input: {
    ruleType: AntiSpamDetectorRuleType;
    messageId: string;
    memberId: string;
    channelId: string;
    observedCount: number;
  }): AntiSpamReservation;
  completeAntiSpamEnforcement(
    reservationId: string,
    input: {
      outcome: "deleted" | "warned" | "timed-out" | "failed" | "skipped";
      caseId?: string | null;
      failureCode?: string | null;
    },
  ): unknown;
  createModerationCase(input: {
    targetUserId: string;
    actorId: string;
    actionType: "automod-warning" | "automod-timeout";
    source: "anti-spam";
    publicReason: string;
    privateNote?: string | null;
    status: "active";
    relatedCaseId?: string | null;
    discordActionMetadata?: unknown;
  }): ModerationCase;
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
    input: {
      actorId: string;
      failureCode: string;
      expectedUpdatedAt?: string;
    },
  ): ModerationCaseTransitionResult;
}

export type AntiSpamMessageOutcome = "continue" | "deleted" | "suppressed";

const detector = new AntiSpamDetector();
const MAX_TIMEOUT_SECONDS = 28 * 24 * 60 * 60;

export async function processAntiSpamMessage(
  message: Message,
  runtime: GuildRuntime,
): Promise<AntiSpamMessageOutcome> {
  return runModerationTargetAction(runtime.guildId, message.author.id, () =>
    processAntiSpamMessageSerialized(message, runtime),
  );
}

async function processAntiSpamMessageSerialized(
  message: Message,
  runtime: GuildRuntime,
): Promise<AntiSpamMessageOutcome> {
  if (
    message.author.bot ||
    message.webhookId ||
    !message.guild ||
    message.guild.id !== runtime.guildId ||
    message.guildId !== runtime.guildId
  ) {
    return "continue";
  }

  const storage: AntiSpamRuntimeStorage = runtime.storage;
  if (
    typeof storage.getModerationConfiguration !== "function" ||
    typeof storage.listAntiSpamRules !== "function"
  ) {
    return "continue";
  }
  let configuration: RuntimeModerationConfiguration | null;
  let rules: RuntimeAntiSpamRule[];
  try {
    configuration = storage.getModerationConfiguration();
    rules = storage.listAntiSpamRules();
  } catch (error) {
    logSafeFailure(runtime.guildId, "configuration-read", error);
    return "continue";
  }
  if (!configuration?.antiSpamEnabled) {
    detector.clearGuild(runtime.guildId);
    return "continue";
  }

  const enabledRules = rules.filter(isRuntimeRule);
  if (enabledRules.length === 0) {
    detector.clearGuild(runtime.guildId);
    return "continue";
  }

  const member = await fetchCurrentMember(message);
  if (!member || !runtime.isCurrent()) return "continue";
  if (
    member.id === message.guild.ownerId ||
    member.permissions.has(PermissionFlagsBits.Administrator)
  ) {
    return "continue";
  }

  try {
    if (await isFreshlyExempt(message, member, storage)) return "continue";
  } catch (error) {
    // An ambiguous exemption lookup must fail closed for punishment.
    logSafeFailure(runtime.guildId, "exemption-verification", error);
    return "continue";
  }

  const mentionCounts = countResolvedMentionOccurrences(
    message.content,
    message.mentions.users,
    message.mentions.roles,
  );
  const detection = detector.evaluate(
    {
      guildId: runtime.guildId,
      memberId: member.id,
      content: message.content,
      userMentionCount: mentionCounts.users,
      roleMentionCount: mentionCounts.roles,
      createdTimestamp: message.createdTimestamp,
    },
    enabledRules,
  );
  if (!detection) return "continue";

  const rule = enabledRules.find(
    (candidate) => candidate.ruleType === detection.ruleType,
  );
  if (!rule) return "continue";
  if (rule.action !== "delete" && !configuration.casesEnabled) {
    logDomainOutcome(
      "anti-spam",
      detection.ruleType,
      runtime.guildId,
      "skipped-case-service-disabled",
      { channelId: message.channelId },
    );
    return "continue";
  }

  let reservation: AntiSpamReservation;
  try {
    reservation = storage.reserveAntiSpamEnforcement({
      ruleType: detection.ruleType,
      messageId: message.id,
      memberId: member.id,
      channelId: message.channelId,
      observedCount: detection.observedCount,
    });
  } catch (error) {
    logSafeFailure(runtime.guildId, "reservation", error);
    return "continue";
  }
  if (reservation.status === "duplicate") {
    const state = reservation.enforcement?.state ?? "";
    if (["deleted", "warned", "timed-out"].includes(state)) return "deleted";
    // Another delivery may be actively enforcing this exact message. Do not
    // let the duplicate trigger normal conversation/activity while its durable
    // reservation is unresolved.
    return state === "reserved" ? "suppressed" : "continue";
  }
  if (reservation.status !== "reserved" || !reservation.reservationId) {
    return "continue";
  }

  const reservationId = reservation.reservationId;
  if (!runtime.isCurrent()) {
    completeSafely(storage, reservationId, {
      outcome: "skipped",
      failureCode: "runtime-changed",
    });
    return "continue";
  }

  const botMember = await fetchCurrentBotMember(message);
  const channelPermissions =
    botMember && "permissionsFor" in message.channel
      ? message.channel.permissionsFor(botMember)
      : null;
  if (
    !botMember ||
    !channelPermissions?.has(PermissionFlagsBits.ViewChannel) ||
    !channelPermissions.has(PermissionFlagsBits.ManageMessages)
  ) {
    completeSafely(storage, reservationId, {
      outcome: "failed",
      failureCode: "delete-permission",
    });
    return "continue";
  }

  const memberBeforeDelete = await fetchCurrentMember(message);
  if (!memberBeforeDelete || !runtime.isCurrent()) {
    completeSafely(storage, reservationId, {
      outcome: "skipped",
      failureCode: "member-unavailable",
    });
    return "continue";
  }
  try {
    if (await isFreshlyExempt(message, memberBeforeDelete, storage)) {
      completeSafely(storage, reservationId, {
        outcome: "skipped",
        failureCode: "fresh-exemption",
      });
      return "continue";
    }
  } catch (error) {
    completeSafely(storage, reservationId, {
      outcome: "skipped",
      failureCode: "exemption-unverifiable",
    });
    logSafeFailure(runtime.guildId, "exemption-verification", error);
    return "continue";
  }

  const finalDeleteBot = await fetchCurrentBotMember(message);
  const finalDeletePermissions =
    finalDeleteBot && "permissionsFor" in message.channel
      ? message.channel.permissionsFor(finalDeleteBot)
      : null;
  if (
    !finalDeleteBot ||
    !finalDeletePermissions?.has(PermissionFlagsBits.ViewChannel) ||
    !finalDeletePermissions.has(PermissionFlagsBits.ManageMessages) ||
    !runtime.isCurrent()
  ) {
    completeSafely(storage, reservationId, {
      outcome: runtime.isCurrent() ? "failed" : "skipped",
      failureCode: runtime.isCurrent()
        ? "delete-permission"
        : "runtime-changed",
    });
    return "continue";
  }

  try {
    await message.delete();
  } catch (error) {
    completeSafely(storage, reservationId, {
      outcome: "failed",
      failureCode: "discord-delete",
    });
    logSafeFailure(
      runtime.guildId,
      "discord-delete",
      error,
      detection.ruleType,
    );
    return "continue";
  }

  // The deletion cannot be rolled back, but a generation change while Discord
  // handled it must cancel every follow-on sanction and notification.
  if (!runtime.isCurrent()) {
    completeSafely(storage, reservationId, {
      outcome: "deleted",
      failureCode: "runtime-changed",
    });
    recordOutcome(
      runtime,
      message,
      detection.ruleType,
      "deleted-runtime-changed",
    );
    return "deleted";
  }

  if (rule.action === "delete") {
    completeSafely(storage, reservationId, { outcome: "deleted" });
    recordOutcome(runtime, message, detection.ruleType, "deleted");
    return "deleted";
  }

  const reason = buildAutomaticReason(
    detection.ruleType,
    detection.observedCount,
    detection.threshold,
  );
  if (rule.action === "delete-and-warn") {
    const warningMember = await fetchCurrentMember(message);
    if (
      !warningMember ||
      warningMember.id === message.guild.ownerId ||
      warningMember.permissions.has(PermissionFlagsBits.Administrator) ||
      !runtime.isCurrent()
    ) {
      completeSafely(storage, reservationId, {
        outcome: "deleted",
        failureCode: "warning-authority-changed",
      });
      return "deleted";
    }
    try {
      if (await isFreshlyExempt(message, warningMember, storage)) {
        completeSafely(storage, reservationId, {
          outcome: "deleted",
          failureCode: "fresh-exemption",
        });
        return "deleted";
      }
    } catch (error) {
      completeSafely(storage, reservationId, {
        outcome: "deleted",
        failureCode: "exemption-unverifiable",
      });
      logSafeFailure(runtime.guildId, "exemption-verification", error);
      return "deleted";
    }
    const warningBot = await fetchCurrentBotMember(message);
    if (!warningBot || !runtime.isCurrent()) {
      completeSafely(storage, reservationId, {
        outcome: "deleted",
        failureCode: "warning-authority-changed",
      });
      return "deleted";
    }
    try {
      const moderationCase = storage.createModerationCase({
        targetUserId: warningMember.id,
        actorId: warningBot.id,
        actionType: "automod-warning",
        source: "anti-spam",
        publicReason: reason,
        status: "active",
        discordActionMetadata: {
          ruleType: detection.ruleType,
          messageId: message.id,
          channelId: message.channelId,
          observedCount: detection.observedCount,
        },
      });
      completeSafely(storage, reservationId, {
        outcome: "warned",
        caseId: moderationCase.caseId,
      });
      await deliverModerationCaseLog(
        message.guild,
        runtime,
        moderationCase,
      ).catch((error) => {
        logSafeFailure(
          runtime.guildId,
          "log-delivery",
          error,
          detection.ruleType,
        );
      });
      void notifyMember(warningMember, reason, moderationCase.caseNumber);
      recordOutcome(
        runtime,
        message,
        detection.ruleType,
        "deleted-warned",
        moderationCase.caseNumber,
      );
    } catch (error) {
      completeSafely(storage, reservationId, {
        outcome: "deleted",
        failureCode: "case-persistence",
      });
      logSafeFailure(
        runtime.guildId,
        "case-persistence",
        error,
        detection.ruleType,
      );
    }
    return "deleted";
  }

  const refreshedMember = await fetchCurrentMember(message);
  const refreshedBot = await fetchCurrentBotMember(message);
  const timeoutSeconds = Math.min(
    Math.max(Math.trunc(rule.timeoutSeconds ?? 0), 1),
    MAX_TIMEOUT_SECONDS,
  );
  if (
    !refreshedMember ||
    !refreshedBot ||
    !runtime.isCurrent() ||
    refreshedMember.id === message.guild.ownerId ||
    refreshedMember.permissions.has(PermissionFlagsBits.Administrator) ||
    !refreshedBot.permissions.has(PermissionFlagsBits.ModerateMembers) ||
    !refreshedMember.moderatable ||
    refreshedBot.roles.highest.comparePositionTo(
      refreshedMember.roles.highest,
    ) <= 0
  ) {
    completeSafely(storage, reservationId, {
      outcome: "deleted",
      failureCode: "timeout-authority",
    });
    return "deleted";
  }

  try {
    if (await isFreshlyExempt(message, refreshedMember, storage)) {
      completeSafely(storage, reservationId, {
        outcome: "deleted",
        failureCode: "fresh-exemption",
      });
      return "deleted";
    }
  } catch (error) {
    completeSafely(storage, reservationId, {
      outcome: "deleted",
      failureCode: "exemption-unverifiable",
    });
    logSafeFailure(runtime.guildId, "exemption-verification", error);
    return "deleted";
  }

  if (!runtime.isCurrent()) {
    completeSafely(storage, reservationId, {
      outcome: "deleted",
      failureCode: "runtime-changed",
    });
    return "deleted";
  }

  const [actionMember, actionBot] = await Promise.all([
    fetchCurrentMember(message),
    fetchCurrentBotMember(message),
  ]);
  if (
    !actionMember ||
    !actionBot ||
    !runtime.isCurrent() ||
    actionMember.id === message.guild.ownerId ||
    actionMember.permissions.has(PermissionFlagsBits.Administrator) ||
    actionMember.isCommunicationDisabled() ||
    !actionBot.permissions.has(PermissionFlagsBits.ModerateMembers) ||
    !actionMember.moderatable ||
    actionBot.roles.highest.comparePositionTo(actionMember.roles.highest) <= 0
  ) {
    completeSafely(storage, reservationId, {
      outcome: "deleted",
      failureCode: actionMember?.isCommunicationDisabled()
        ? "timeout-already-active"
        : "timeout-authority",
    });
    return "deleted";
  }

  let attempt: ModerationCase;
  try {
    attempt = storage.reserveModerationCaseAttempt({
      targetUserId: actionMember.id,
      actorId: actionBot.id,
      actionType: "automod-timeout",
      source: "anti-spam",
      publicReason: reason,
      discordActionMetadata: {
        ruleType: detection.ruleType,
        messageId: message.id,
        channelId: message.channelId,
        observedCount: detection.observedCount,
        timeoutSeconds,
      },
    });
  } catch (error) {
    completeSafely(storage, reservationId, {
      outcome: "deleted",
      failureCode: "case-reservation",
    });
    logSafeFailure(
      runtime.guildId,
      "case-reservation",
      error,
      detection.ruleType,
    );
    return "deleted";
  }

  if (!runtime.isCurrent()) {
    failCaseAttemptSafely(storage, attempt, actionBot.id, "runtime-changed");
    completeSafely(storage, reservationId, {
      outcome: "deleted",
      caseId: attempt.caseId,
      failureCode: "runtime-changed",
    });
    return "deleted";
  }

  try {
    await actionMember.timeout(timeoutSeconds * 1_000, reason.slice(0, 512));
  } catch (error) {
    failCaseAttemptSafely(storage, attempt, actionBot.id, "discord-timeout");
    completeSafely(storage, reservationId, {
      outcome: "deleted",
      failureCode: "discord-timeout",
    });
    logSafeFailure(
      runtime.guildId,
      "discord-timeout",
      error,
      detection.ruleType,
    );
    return "deleted";
  }

  const confirmedMember = await fetchCurrentMember(message);
  if (!confirmedMember?.isCommunicationDisabled()) {
    failCaseAttemptSafely(
      storage,
      attempt,
      actionBot.id,
      "timeout-state-unconfirmed",
    );
    completeSafely(storage, reservationId, {
      outcome: "deleted",
      caseId: attempt.caseId,
      failureCode: "timeout-state-unconfirmed",
    });
    return "deleted";
  }

  try {
    const confirmed = storage.confirmModerationCase(attempt.caseId, {
      actorId: actionBot.id,
      status: "active",
      discordActionMetadata: {
        ruleType: detection.ruleType,
        messageId: message.id,
        channelId: message.channelId,
        observedCount: detection.observedCount,
        timeoutSeconds,
        expiresAt:
          confirmedMember.communicationDisabledUntil?.toISOString() ?? null,
      },
      expectedUpdatedAt: attempt.updatedAt,
    });
    if (confirmed.status !== "changed" && confirmed.status !== "unchanged") {
      throw new Error("Anti-spam timeout case confirmation conflicted.");
    }
    const moderationCase = confirmed.case;
    completeSafely(storage, reservationId, {
      outcome: "timed-out",
      caseId: moderationCase.caseId,
    });
    await deliverModerationCaseLog(
      message.guild,
      runtime,
      moderationCase,
    ).catch((error) => {
      logSafeFailure(
        runtime.guildId,
        "log-delivery",
        error,
        detection.ruleType,
      );
    });
    void notifyMember(actionMember, reason, moderationCase.caseNumber);
    recordOutcome(
      runtime,
      message,
      detection.ruleType,
      "deleted-timed-out",
      moderationCase.caseNumber,
    );
  } catch (error) {
    // Discord already confirmed the timeout. Record the partial failure without
    // pretending that the sanction was undone.
    completeSafely(storage, reservationId, {
      outcome: "deleted",
      caseId: attempt.caseId,
      failureCode: "case-persistence",
    });
    logSafeFailure(
      runtime.guildId,
      "case-persistence",
      error,
      detection.ruleType,
    );
  }
  return "deleted";
}

export function countResolvedMentionOccurrences(
  content: string,
  users: { has(id: string): boolean },
  roles: { has(id: string): boolean },
): { users: number; roles: number } {
  let userCount = 0;
  let roleCount = 0;
  for (const match of content.matchAll(/<@!?(\d{17,20})>|<@&(\d{17,20})>/gu)) {
    const userId = match[1];
    const roleId = match[2];
    if (userId && users.has(userId)) userCount += 1;
    if (roleId && roles.has(roleId)) roleCount += 1;
  }
  return { users: userCount, roles: roleCount };
}

function failCaseAttemptSafely(
  storage: AntiSpamRuntimeStorage,
  attempt: ModerationCase,
  actorId: string,
  failureCode: string,
): void {
  try {
    storage.failModerationCaseAttempt(attempt.caseId, {
      actorId,
      failureCode,
      expectedUpdatedAt: attempt.updatedAt,
    });
  } catch {
    // The durable action-reserved event remains available for recovery.
  }
}

export function clearAntiSpamProcessState(guildId?: string): void {
  if (guildId) detector.clearGuild(guildId);
  else detector.clearAll();
}

async function isFreshlyExempt(
  message: Message,
  member: GuildMember,
  storage: AntiSpamRuntimeStorage,
): Promise<boolean> {
  const channelIds = storage.listAntiSpamExemptChannelIds();
  if (channelIds.includes(message.channelId)) {
    const channel = await message.guild!.channels.fetch(message.channelId, {
      cache: true,
      force: true,
    });
    if (
      channel?.guild.id === message.guildId &&
      channel.id === message.channelId
    ) {
      return true;
    }
  }

  const roleIds = storage.listAntiSpamExemptRoleIds();
  for (const roleId of roleIds) {
    if (roleId === message.guildId || !member.roles.cache.has(roleId)) continue;
    const role = await message.guild!.roles.fetch(roleId, {
      cache: true,
      force: true,
    });
    if (
      role &&
      role.id === roleId &&
      role.guild.id === message.guildId &&
      role.id !== role.guild.id &&
      !role.managed &&
      member.roles.cache.has(role.id)
    ) {
      return true;
    }
  }
  return false;
}

async function fetchCurrentMember(
  message: Message,
): Promise<GuildMember | null> {
  const guild = message.guild;
  if (!guild || guild.id !== message.guildId) return null;
  const member = await guild.members
    .fetch({ user: message.author.id, cache: true, force: true })
    .catch(() => null);
  return member?.guild.id === guild.id ? member : null;
}

async function fetchCurrentBotMember(
  message: Message,
): Promise<GuildMember | null> {
  const guild = message.guild;
  if (!guild || guild.id !== message.guildId) return null;
  const member = await guild.members
    .fetchMe({ cache: true, force: true })
    .catch(() => null);
  return member?.guild.id === guild.id ? member : null;
}

function isRuntimeRule(rule: RuntimeAntiSpamRule): boolean {
  return Boolean(
    rule?.enabled &&
    ["burst", "duplicate", "mention"].includes(rule.ruleType) &&
    ["delete", "delete-and-warn", "delete-and-timeout"].includes(rule.action),
  );
}

function completeSafely(
  storage: AntiSpamRuntimeStorage,
  reservationId: string,
  input: {
    outcome: "deleted" | "warned" | "timed-out" | "failed" | "skipped";
    caseId?: string | null;
    failureCode?: string | null;
  },
): void {
  try {
    storage.completeAntiSpamEnforcement(reservationId, input);
  } catch {
    // The reservation remains recoverable and expires through bounded startup
    // cleanup. No user content is included in terminal output.
  }
}

function buildAutomaticReason(
  ruleType: AntiSpamDetectorRuleType,
  observed: number,
  threshold: number,
): string {
  return `Superior anti-spam ${ruleType} rule triggered (${Math.max(0, observed)}/${Math.max(1, threshold)}).`;
}

async function notifyMember(
  member: GuildMember,
  reason: string,
  caseNumber: number,
): Promise<void> {
  await member
    .send({
      content: `Superior moderation case #${caseNumber}: ${reason}`,
      allowedMentions: { parse: [] },
    })
    .catch(() => undefined);
}

function recordOutcome(
  runtime: GuildRuntime,
  message: Message,
  ruleType: AntiSpamDetectorRuleType,
  outcome: string,
  caseNumber?: number,
): void {
  logDomainOutcome("anti-spam", ruleType, runtime.guildId, outcome, {
    channelId: message.channelId,
    ...(caseNumber === undefined ? {} : { recordNumber: caseNumber }),
  });
}

function logSafeFailure(
  guildId: string,
  stage: string,
  error: unknown,
  ruleType?: AntiSpamDetectorRuleType,
): void {
  const classified = classifyError(error);
  logError("anti-spam", "Anti-spam processing failed safely", {
    guildId,
    stage,
    ...(ruleType ? { ruleType } : {}),
    category: classified.category,
    ...(classified.code === null ? {} : { code: classified.code }),
    retryable: classified.retryable,
  });
}
