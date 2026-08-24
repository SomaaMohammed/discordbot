import {
  MessageFlags,
  type ButtonInteraction,
  type GuildMember,
  type Role,
} from "discord.js";
import { classifyError } from "../errors.js";
import type { GuildRuntime } from "../runtime.js";
import type {
  MemberRuleAcceptanceResult,
  OnboardingConfiguration,
  OnboardingRoleOperationReservationResult,
  OnboardingRulesVersion,
} from "../types.js";
import { logDomainOutcome } from "./domain-outcomes.js";
import { KeyedSerialQueue } from "./keyed-serial-queue.js";
import { deliverPrivateLifecycleLog } from "./member-lifecycle-discord.js";
import {
  inspectAssignableOnboardingRole,
  inspectRemovableOnboardingRole,
} from "./onboarding-permissions.js";
import {
  asOnboardingRepository,
  type OnboardingRepository,
  type StoredOnboardingPanel,
} from "./onboarding-repository.js";
import {
  VERIFICATION_ACCEPT_PREFIX,
  parseVerificationAcceptCustomId,
  type ParsedVerificationAcceptId,
} from "./verification-components.js";

interface VerificationPanelBinding {
  readonly rulesVersion: number;
  readonly bindingsVerifiedAt: string;
}

interface VerificationSnapshot {
  readonly panel: StoredOnboardingPanel;
  readonly panelBinding: VerificationPanelBinding;
  readonly configuration: OnboardingConfiguration;
  readonly rules: OnboardingRulesVersion;
}

interface UnverifiedRemovalResult {
  readonly state: "completed" | "no-change" | "partial";
  readonly reason:
    | "none"
    | "configuration-changed"
    | "existing-operation"
    | "discord-failed"
    | "reservation-persistence"
    | "completion-persistence";
  readonly discordAttempted: boolean;
  readonly discordSucceeded: boolean;
}

const verificationInteractionQueue = new KeyedSerialQueue();

export function verificationInteractionQueueSize(): number {
  return verificationInteractionQueue.size;
}

/**
 * Handles only Superior verification buttons. Every accepted component is
 * serialized per guild/member so two Discord interactions cannot interleave
 * the add -> acceptance -> removal sequence.
 */
export async function handleVerificationButton(
  interaction: ButtonInteraction,
  runtime: GuildRuntime,
): Promise<boolean> {
  if (!interaction.customId.startsWith(VERIFICATION_ACCEPT_PREFIX)) {
    return false;
  }

  const parsed = parseVerificationAcceptCustomId(interaction.customId);
  if (!parsed) {
    await replyPrivate(interaction, stalePanelMessage());
    return true;
  }

  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  try {
    await verificationInteractionQueue.run(
      `${runtime.guildId}:${interaction.user.id}`,
      () => applyRulesAcceptance(interaction, runtime, parsed),
    );
  } catch (error) {
    const failureCode = classifyError(error).category;
    logVerificationOutcome(runtime, parsed.panelId, `failed-${failureCode}`);
    await replyPrivate(
      interaction,
      "Superior could not safely finish verification and did not continue with later steps. Ask an administrator to inspect your current role, acknowledgement status, and onboarding recovery records.",
    ).catch(() => undefined);
  }
  return true;
}

async function applyRulesAcceptance(
  interaction: ButtonInteraction,
  runtime: GuildRuntime,
  parsed: ParsedVerificationAcceptId,
): Promise<void> {
  const guild = interaction.guild;
  if (
    !guild ||
    !interaction.guildId ||
    guild.id !== interaction.guildId ||
    guild.id !== runtime.guildId ||
    !runtime.isCurrent()
  ) {
    await replyPrivate(interaction, stalePanelMessage());
    return;
  }

  const repository = asOnboardingRepository(runtime.storage);
  const snapshot = loadVerificationSnapshot(
    repository,
    interaction,
    runtime,
    parsed,
  );
  if (!snapshot) {
    recordMetric(repository, false);
    logVerificationOutcome(runtime, parsed.panelId, "rejected-stale");
    await replyPrivate(interaction, stalePanelMessage());
    return;
  }

  const memberPromise = guild.members
    .fetch({ user: interaction.user.id, cache: true, force: true })
    .catch(() => null);
  const verifiedInspectionPromise = inspectAssignableOnboardingRole(
    guild,
    snapshot.configuration.verifiedRoleId,
  );
  const unverifiedInspectionPromise = snapshot.configuration.unverifiedRoleId
    ? inspectRemovableOnboardingRole(
        guild,
        snapshot.configuration.unverifiedRoleId,
      )
    : Promise.resolve(null);
  const [member, verifiedInspection, unverifiedInspection] = await Promise.all([
    memberPromise,
    verifiedInspectionPromise,
    unverifiedInspectionPromise,
  ]);

  if (
    !member ||
    member.guild.id !== runtime.guildId ||
    member.id !== interaction.user.id ||
    member.user.id !== interaction.user.id
  ) {
    recordMetric(repository, false);
    await replyPrivate(
      interaction,
      "Superior could not verify your current server membership. No acknowledgement was recorded and no roles were changed.",
    );
    return;
  }
  if (member.user.bot) {
    recordMetric(repository, false);
    await replyPrivate(interaction, "Bots cannot use member verification.");
    return;
  }
  if (member.pending) {
    recordMetric(repository, false);
    await replyPrivate(
      interaction,
      "Complete Discord's server Membership Screening first. Superior will not assign verification roles while your membership is pending.",
    );
    return;
  }

  const verifiedRole = verifiedInspection.role;
  const unverifiedRole = unverifiedInspection?.role ?? null;
  if (
    !verifiedRole ||
    !verifiedInspection.botMember ||
    verifiedInspection.issues.length > 0 ||
    (snapshot.configuration.unverifiedRoleId !== null &&
      (!unverifiedInspection ||
        !unverifiedRole ||
        !unverifiedInspection.botMember ||
        unverifiedInspection.issues.length > 0)) ||
    verifiedRole.id === unverifiedRole?.id
  ) {
    recordMetric(repository, false);
    appendAuditSafely(repository, {
      eventType: "verification-resource-check",
      memberId: member.id,
      actorId: member.id,
      rulesVersion: parsed.rulesVersion,
      outcome: "rejected-invalid-resources",
      details: { panelId: parsed.panelId },
    });
    logVerificationOutcome(
      runtime,
      parsed.panelId,
      "rejected-invalid-resources",
    );
    await replyPrivate(
      interaction,
      "Verification needs administrator attention. No acknowledgement was recorded and no roles were changed.",
    );
    return;
  }

  if (
    !isSameCurrentSnapshot(snapshot, repository, interaction, runtime, parsed)
  ) {
    recordMetric(repository, false);
    await replyPrivate(interaction, stalePanelMessage());
    return;
  }

  const existingAcceptance = repository.getMemberRuleAcceptance(
    member.id,
    parsed.rulesVersion,
  );
  if (existingAcceptance) {
    const hasVerifiedRole = member.roles.cache.has(verifiedRole.id);
    const hasUnverifiedRole = Boolean(
      unverifiedRole && member.roles.cache.has(unverifiedRole.id),
    );
    recordMetric(repository, hasVerifiedRole && !hasUnverifiedRole);
    await replyPrivate(
      interaction,
      hasVerifiedRole && !hasUnverifiedRole
        ? "You already acknowledged the current server rules and your verified role is present."
        : "Your current rules acknowledgement is already recorded, but role delivery is incomplete. Ask an administrator to run onboarding recovery.",
    );
    return;
  }

  const verifiedReservation = reserveRoleOperation(
    repository,
    member,
    verifiedRole,
    "verified-add",
    parsed.rulesVersion,
  );
  const verifiedOperationIsResumable =
    verifiedReservation.status === "reserved" ||
    (verifiedReservation.status === "pending" &&
      verifiedReservation.operation.state === "reserved");
  if (
    verifiedReservation.status === "pending" &&
    !verifiedOperationIsResumable
  ) {
    recordMetric(repository, false);
    await replyPrivate(
      interaction,
      "A prior verification role operation is inconsistent. No acknowledgement was recorded; ask an administrator to inspect onboarding recovery.",
    );
    return;
  }
  if (
    verifiedReservation.status === "completed" &&
    verifiedReservation.operation.state !== "completed" &&
    verifiedReservation.operation.state !== "no-change" &&
    !member.roles.cache.has(verifiedRole.id)
  ) {
    recordMetric(repository, false);
    await replyPrivate(
      interaction,
      "A prior verification role operation needs administrator recovery. No new acknowledgement was recorded and the unverified role was not removed.",
    );
    return;
  }
  if (
    verifiedReservation.status === "completed" &&
    !member.roles.cache.has(verifiedRole.id)
  ) {
    recordMetric(repository, false);
    await replyPrivate(
      interaction,
      "Verification role delivery no longer matches the recorded operation. No new acknowledgement was recorded; ask an administrator to run onboarding recovery.",
    );
    return;
  }

  const verifiedRoleAlreadyHeld = member.roles.cache.has(verifiedRole.id);
  if (verifiedOperationIsResumable && !verifiedRoleAlreadyHeld) {
    try {
      await member.roles.add(
        verifiedRole,
        `Superior rules acknowledgement v${parsed.rulesVersion}`,
      );
    } catch (error) {
      const failureCode = classifyError(error).category;
      completeRoleOperationSafely(
        repository,
        verifiedReservation,
        "failed",
        failureCode,
      );
      appendRoleAudit(
        repository,
        member.id,
        parsed,
        "verified-add-failed",
        verifiedRole.id,
        failureCode,
      );
      recordMetric(repository, false);
      logVerificationOutcome(runtime, parsed.panelId, "failed-verified-add", {
        attemptedCount: 1,
        succeededCount: 0,
        failedCount: 1,
      });
      await replyPrivate(
        interaction,
        "Discord did not add the verified role, so no rules acknowledgement was recorded and the unverified role was not removed. An administrator can retry onboarding recovery.",
      );
      return;
    }
  }

  // Discord succeeded first. A changed runtime/configuration is deliberately
  // treated as partial work and never converted into an acceptance claim.
  if (
    !isSameCurrentSnapshot(snapshot, repository, interaction, runtime, parsed)
  ) {
    if (verifiedOperationIsResumable) {
      completeRoleOperationSafely(
        repository,
        verifiedReservation,
        "partial",
        "configuration-changed",
      );
    }
    appendRoleAudit(
      repository,
      member.id,
      parsed,
      "verified-add-partial",
      verifiedRole.id,
      "configuration-changed",
    );
    recordMetric(repository, false);
    logVerificationOutcome(
      runtime,
      parsed.panelId,
      "partial-configuration-changed",
      { attemptedCount: 1, succeededCount: 1, failedCount: 0 },
    );
    await replyPrivate(
      interaction,
      "The onboarding configuration changed after Discord added the verified role. No acknowledgement was recorded and the unverified role was not removed; administrator recovery is required.",
    );
    return;
  }

  let acceptanceResult: MemberRuleAcceptanceResult;
  try {
    acceptanceResult = repository.recordMemberRuleAcceptance({
      memberId: member.id,
      rulesVersion: parsed.rulesVersion,
      panelPostId: snapshot.panel.panelId,
    });
  } catch (error) {
    const failureCode = classifyError(error).category;
    if (verifiedOperationIsResumable) {
      completeRoleOperationSafely(
        repository,
        verifiedReservation,
        "partial",
        `acceptance-${failureCode}`,
      );
    }
    appendRoleAudit(
      repository,
      member.id,
      parsed,
      "verified-add-partial",
      verifiedRole.id,
      `acceptance-${failureCode}`,
    );
    recordMetric(repository, false);
    logVerificationOutcome(runtime, parsed.panelId, "partial-persistence", {
      attemptedCount: 1,
      succeededCount: 1,
      failedCount: 0,
    });
    await replyPrivate(
      interaction,
      "Discord added the verified role, but Superior could not persist the acknowledgement. The unverified role was not removed and administrator recovery is required.",
    );
    return;
  }

  if (verifiedOperationIsResumable) {
    try {
      repository.completeOnboardingRoleOperation(
        verifiedReservation.operation.operationId,
        { state: verifiedRoleAlreadyHeld ? "no-change" : "completed" },
      );
    } catch {
      appendAcceptanceAudit(
        repository,
        member.id,
        parsed,
        acceptanceResult,
        "partial-operation-persistence",
      );
      recordMetric(repository, false);
      await replyPrivate(
        interaction,
        "Your rules acknowledgement and verified role are confirmed, but Superior could not finish its recovery record. The unverified role was left unchanged; ask an administrator to run onboarding recovery.",
      );
      return;
    }
  }

  let removalResult: UnverifiedRemovalResult = {
    state: "no-change",
    reason: "none",
    discordAttempted: false,
    discordSucceeded: false,
  };
  if (unverifiedRole && member.roles.cache.has(unverifiedRole.id)) {
    if (
      !isSameCurrentSnapshot(snapshot, repository, interaction, runtime, parsed)
    ) {
      removalResult = persistUnverifiedPartial(
        repository,
        member,
        unverifiedRole,
        parsed,
        "configuration-changed",
      );
    } else {
      removalResult = await removeUnverifiedRole(
        repository,
        member,
        unverifiedRole,
        parsed,
      );
    }
  }

  appendAcceptanceAudit(
    repository,
    member.id,
    parsed,
    acceptanceResult,
    removalResult.state === "partial" ? "partial-role-delivery" : "completed",
  );
  if (acceptanceResult.status === "recorded") {
    await deliverPrivateLifecycleLog(
      runtime,
      guild,
      `verification:${parsed.rulesVersion}`,
      {
        kind: "verification-accepted",
        memberId: member.id,
        rulesVersion: parsed.rulesVersion,
      },
    );
  }

  const successful = removalResult.state !== "partial";
  const verifiedDiscordAttempted =
    verifiedOperationIsResumable && !verifiedRoleAlreadyHeld;
  recordMetric(repository, successful);
  logVerificationOutcome(
    runtime,
    parsed.panelId,
    successful
      ? "completed"
      : removalResult.reason === "discord-failed"
        ? "partial-unverified-remove"
        : removalResult.reason === "configuration-changed"
          ? "partial-configuration-changed"
          : "partial-operation-persistence",
    {
      attemptedCount:
        Number(verifiedDiscordAttempted) +
        Number(removalResult.discordAttempted),
      succeededCount:
        Number(verifiedDiscordAttempted) +
        Number(removalResult.discordSucceeded),
      failedCount: Number(
        removalResult.discordAttempted && !removalResult.discordSucceeded,
      ),
    },
  );
  await replyPrivate(
    interaction,
    successful
      ? acceptanceResult.status === "duplicate"
        ? "Your current rules acknowledgement was already recorded. Your verification roles are now confirmed."
        : "You acknowledged the current server rules and your verified role is now confirmed."
      : partialRemovalMessage(removalResult.reason),
  );
}

function loadVerificationSnapshot(
  repository: OnboardingRepository,
  interaction: ButtonInteraction,
  runtime: GuildRuntime,
  parsed: ParsedVerificationAcceptId,
): VerificationSnapshot | null {
  const guild = interaction.guild;
  const clientUserId = interaction.client.user?.id;
  const panel = repository.findPostedPanelByToken(parsed.panelId);
  if (
    !guild ||
    !clientUserId ||
    !panel ||
    panel.guildId !== runtime.guildId ||
    panel.preset !== "verification" ||
    panel.panelId !== parsed.panelId ||
    panel.channelId !== interaction.channelId ||
    panel.messageId !== interaction.message.id ||
    interaction.message.channelId !== interaction.channelId ||
    interaction.message.guildId !== runtime.guildId ||
    interaction.message.author?.id !== clientUserId ||
    interaction.message.author.bot !== true
  ) {
    return null;
  }

  const panelBinding = parsePanelBinding(panel.configuration);
  const configuration = repository.getOnboardingConfiguration();
  const rules = repository.getCurrentOnboardingRulesVersion();
  if (
    !panelBinding ||
    panelBinding.rulesVersion !== parsed.rulesVersion ||
    !configuration ||
    configuration.guildId !== runtime.guildId ||
    !configuration.enabled ||
    !configuration.verificationEnabled ||
    configuration.currentRulesVersion !== parsed.rulesVersion ||
    !configuration.verifiedRoleId ||
    !configuration.verificationRolesVerifiedAt ||
    configuration.verificationRolesVerifiedAt !==
      panelBinding.bindingsVerifiedAt ||
    !rules ||
    rules.guildId !== runtime.guildId ||
    rules.rulesVersion !== parsed.rulesVersion
  ) {
    return null;
  }
  return { panel, panelBinding, configuration, rules };
}

function isSameCurrentSnapshot(
  expected: VerificationSnapshot,
  repository: OnboardingRepository,
  interaction: ButtonInteraction,
  runtime: GuildRuntime,
  parsed: ParsedVerificationAcceptId,
): boolean {
  if (!runtime.isCurrent()) return false;
  const current = loadVerificationSnapshot(
    repository,
    interaction,
    runtime,
    parsed,
  );
  return Boolean(
    current &&
    current.panel.updatedAt === expected.panel.updatedAt &&
    current.panelBinding.bindingsVerifiedAt ===
      expected.panelBinding.bindingsVerifiedAt &&
    current.configuration.updatedAt === expected.configuration.updatedAt &&
    current.configuration.verifiedRoleId ===
      expected.configuration.verifiedRoleId &&
    current.configuration.unverifiedRoleId ===
      expected.configuration.unverifiedRoleId &&
    current.rules.createdAt === expected.rules.createdAt,
  );
}

function parsePanelBinding(value: unknown): VerificationPanelBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "bindingsVerifiedAt" ||
    keys[1] !== "rulesVersion" ||
    !Number.isSafeInteger(record.rulesVersion) ||
    (record.rulesVersion as number) < 1 ||
    typeof record.bindingsVerifiedAt !== "string" ||
    record.bindingsVerifiedAt.length < 20 ||
    record.bindingsVerifiedAt.length > 40 ||
    !Number.isFinite(Date.parse(record.bindingsVerifiedAt))
  ) {
    return null;
  }
  return {
    rulesVersion: record.rulesVersion as number,
    bindingsVerifiedAt: record.bindingsVerifiedAt,
  };
}

function reserveRoleOperation(
  repository: OnboardingRepository,
  member: GuildMember,
  role: Role,
  kind: "verified-add" | "unverified-remove",
  rulesVersion: number,
): OnboardingRoleOperationReservationResult {
  return repository.reserveOnboardingRoleOperation({
    memberId: member.id,
    roleId: role.id,
    kind,
    idempotencyKey: `verification.v${rulesVersion}.${kind}`,
  });
}

async function removeUnverifiedRole(
  repository: OnboardingRepository,
  member: GuildMember,
  role: Role,
  parsed: ParsedVerificationAcceptId,
): Promise<UnverifiedRemovalResult> {
  let reservation: OnboardingRoleOperationReservationResult;
  try {
    reservation = reserveRoleOperation(
      repository,
      member,
      role,
      "unverified-remove",
      parsed.rulesVersion,
    );
  } catch (error) {
    appendRoleAudit(
      repository,
      member.id,
      parsed,
      "unverified-remove-tracking-partial",
      role.id,
      `reservation-${classifyError(error).category}`,
    );
    return {
      state: "partial",
      reason: "reservation-persistence",
      discordAttempted: false,
      discordSucceeded: false,
    };
  }
  if (reservation.status !== "reserved") {
    if (
      !member.roles.cache.has(role.id) &&
      (reservation.operation.state === "completed" ||
        reservation.operation.state === "no-change")
    ) {
      return {
        state: "completed",
        reason: "none",
        discordAttempted: false,
        discordSucceeded: false,
      };
    }
    appendRoleAudit(
      repository,
      member.id,
      parsed,
      "unverified-remove-tracking-partial",
      role.id,
      `${reservation.status}-operation`,
    );
    return {
      state: "partial",
      reason: "existing-operation",
      discordAttempted: false,
      discordSucceeded: false,
    };
  }
  try {
    await member.roles.remove(
      role,
      `Superior rules acknowledgement v${parsed.rulesVersion}`,
    );
  } catch (error) {
    const failureCode = classifyError(error).category;
    completeRoleOperationSafely(
      repository,
      reservation,
      "partial",
      failureCode,
    );
    appendRoleAudit(
      repository,
      member.id,
      parsed,
      "unverified-remove-partial",
      role.id,
      failureCode,
    );
    return {
      state: "partial",
      reason: "discord-failed",
      discordAttempted: true,
      discordSucceeded: false,
    };
  }

  try {
    repository.completeOnboardingRoleOperation(
      reservation.operation.operationId,
      { state: "completed" },
    );
  } catch (error) {
    appendRoleAudit(
      repository,
      member.id,
      parsed,
      "unverified-remove-tracking-partial",
      role.id,
      `completion-${classifyError(error).category}`,
    );
    return {
      state: "partial",
      reason: "completion-persistence",
      discordAttempted: true,
      discordSucceeded: true,
    };
  }
  return {
    state: "completed",
    reason: "none",
    discordAttempted: true,
    discordSucceeded: true,
  };
}

function persistUnverifiedPartial(
  repository: OnboardingRepository,
  member: GuildMember,
  role: Role,
  parsed: ParsedVerificationAcceptId,
  failureCode: string,
): UnverifiedRemovalResult {
  try {
    const reservation = reserveRoleOperation(
      repository,
      member,
      role,
      "unverified-remove",
      parsed.rulesVersion,
    );
    if (reservation.status === "reserved") {
      completeRoleOperationSafely(
        repository,
        reservation,
        "partial",
        failureCode,
      );
    }
  } catch {
    // The audit below remains a best-effort bounded signal if reservation
    // storage is temporarily unavailable.
  }
  appendRoleAudit(
    repository,
    member.id,
    parsed,
    "unverified-remove-partial",
    role.id,
    failureCode,
  );
  return {
    state: "partial",
    reason: "configuration-changed",
    discordAttempted: false,
    discordSucceeded: false,
  };
}

function partialRemovalMessage(
  reason: UnverifiedRemovalResult["reason"],
): string {
  if (reason === "discord-failed") {
    return "Your rules acknowledgement and verified role are confirmed, but Discord did not remove the unverified role. The partial result was recorded for administrator recovery.";
  }
  if (reason === "configuration-changed") {
    return "Your rules acknowledgement and verified role are confirmed, but onboarding changed before the unverified role could be removed. The role was left unchanged and administrator recovery is required.";
  }
  if (reason === "existing-operation") {
    return "Your rules acknowledgement and verified role are confirmed, but an earlier unverified-role operation is incomplete. The role was left unchanged and administrator recovery is required.";
  }
  if (reason === "reservation-persistence") {
    return "Your rules acknowledgement and verified role are confirmed, but Superior could not reserve safe tracking for unverified-role removal. The role was left unchanged and administrator recovery is required.";
  }
  return "Your rules acknowledgement and Discord role removal are confirmed, but Superior could not finish the recovery record. Ask an administrator to run onboarding recovery.";
}

function completeRoleOperationSafely(
  repository: OnboardingRepository,
  reservation: OnboardingRoleOperationReservationResult,
  state: "failed" | "partial",
  failureCode: string,
): void {
  try {
    repository.completeOnboardingRoleOperation(
      reservation.operation.operationId,
      { state, failureCode: failureCode.slice(0, 100) },
    );
  } catch {
    // The caller still stops before any later unsafe Discord mutation. The
    // existing reserved row remains visible to explicit recovery.
  }
}

function appendAcceptanceAudit(
  repository: OnboardingRepository,
  memberId: string,
  parsed: ParsedVerificationAcceptId,
  acceptance: MemberRuleAcceptanceResult,
  outcome: string,
): void {
  if (acceptance.status !== "recorded") return;
  appendAuditSafely(repository, {
    eventType: "verification-accepted",
    memberId,
    actorId: memberId,
    rulesVersion: parsed.rulesVersion,
    outcome,
    details: { panelId: parsed.panelId },
  });
}

function appendRoleAudit(
  repository: OnboardingRepository,
  memberId: string,
  parsed: ParsedVerificationAcceptId,
  outcome: string,
  roleId: string,
  failureCode: string,
): void {
  appendAuditSafely(repository, {
    eventType: "verification-role-operation",
    memberId,
    actorId: memberId,
    rulesVersion: parsed.rulesVersion,
    outcome,
    details: {
      panelId: parsed.panelId,
      roleId,
      failureCode: failureCode.slice(0, 100),
    },
  });
}

function appendAuditSafely(
  repository: OnboardingRepository,
  input: Parameters<OnboardingRepository["appendOnboardingAudit"]>[0],
): void {
  try {
    repository.appendOnboardingAudit(input);
  } catch {
    // Role/acceptance truth remains authoritative. Logging below stays bounded
    // and contains no rules text, member content, or raw Discord error.
  }
}

function recordMetric(
  repository: OnboardingRepository,
  success: boolean,
): void {
  try {
    repository.recordCommandMetric("onboarding.verification.accept", success);
  } catch {
    // Metrics are not operational storage and never control verification.
  }
}

function logVerificationOutcome(
  runtime: GuildRuntime,
  panelId: string,
  outcome: string,
  counts: {
    attemptedCount?: number;
    succeededCount?: number;
    failedCount?: number;
  } = {},
): void {
  logDomainOutcome("panel", "verification-accept", runtime.guildId, outcome, {
    recordId: panelId,
    ...counts,
  });
}

function stalePanelMessage(): string {
  return "This verification panel is outdated, copied, disabled, or no longer bound to this message. Use this server's current verification panel.";
}

async function replyPrivate(
  interaction: ButtonInteraction,
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
