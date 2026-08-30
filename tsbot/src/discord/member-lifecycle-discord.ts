import {
  PermissionFlagsBits,
  escapeMarkdown,
  type Guild,
  type GuildMember,
  type PartialGuildMember,
} from "discord.js";
import { classifyError } from "../errors.js";
import { logInfo } from "../logging.js";
import type { BotRuntime, GuildRuntime } from "../runtime.js";
import { createOpaqueStorageId } from "../storage/operational-repository.js";
import {
  createMemberLifecycleService,
  type MemberLifecycleDeliveryReceipt,
  type MemberLifecycleDeliveryRequest,
  type MemberLifecycleEffects,
  type MemberLifecycleLogEvent,
  type MemberLifecycleResult,
  type MemberLifecycleRoleRequest,
  type MemberLifecycleSnapshot,
} from "./member-lifecycle-service.js";
import { KeyedSerialQueue } from "./keyed-serial-queue.js";
import { inspectOnboardingChannel } from "./onboarding-permissions.js";
import { createSuperiorEmbed } from "./panel-theme.js";
import { assignableRoleSafetyIssue } from "./role-policy.js";
import {
  fetchCurrentBotMember,
  fetchGuildMemberCoalesced,
  fetchGuildRoleCoalesced,
} from "./fetch-coalescing.js";

type MemberLifecycleEventKind = "join" | "update" | "leave";

interface MemberLifecyclePresence {
  readonly generation: number;
  readonly phase: "present" | "departed";
  readonly joinedAt: string | null;
}

const memberLifecycleQueue = new KeyedSerialQueue();
const memberLifecyclePresence = new Map<string, MemberLifecyclePresence>();
const memberLifecyclePending = new Map<string, number>();

export function memberLifecycleQueueSize(): number {
  return memberLifecycleQueue.size;
}

/**
 * Enters member lifecycle work in gateway-observation order. Presence is
 * updated synchronously, before the first await, so an already-observed leave
 * or rejoin can suppress obsolete external effects while the queued state
 * transitions and audits still run in order.
 */
export function runMemberLifecycleSerial<T>(
  guildId: string,
  memberId: string,
  kind: MemberLifecycleEventKind,
  joinedAt: Date | null,
  task: (isCurrentEvent: () => boolean) => Promise<T>,
): Promise<T> {
  const key = `${guildId}:${memberId}`;
  const joinedAtKey = joinedAt?.toISOString() ?? null;
  const expectedPhase = kind === "leave" ? "departed" : "present";
  const current = memberLifecyclePresence.get(key);
  let observed = current;
  if (kind !== "update" || !current) {
    const samePresence =
      current?.phase === expectedPhase &&
      (expectedPhase === "departed" || current.joinedAt === joinedAtKey);
    observed = samePresence
      ? current
      : {
          generation: (current?.generation ?? 0) + 1,
          phase: expectedPhase,
          joinedAt: joinedAtKey,
        };
    memberLifecyclePresence.set(key, observed);
  }
  const ticket = observed!;
  memberLifecyclePending.set(key, (memberLifecyclePending.get(key) ?? 0) + 1);
  const isCurrentEvent = (): boolean => {
    const latest = memberLifecyclePresence.get(key);
    return (
      latest?.generation === ticket.generation &&
      latest.phase === expectedPhase &&
      (expectedPhase === "departed" || latest.joinedAt === joinedAtKey)
    );
  };
  return memberLifecycleQueue
    .run(key, () => task(isCurrentEvent))
    .finally(() => {
      const remaining = (memberLifecyclePending.get(key) ?? 1) - 1;
      if (remaining > 0) {
        memberLifecyclePending.set(key, remaining);
      } else {
        memberLifecyclePending.delete(key);
        memberLifecyclePresence.delete(key);
      }
    });
}

export async function handleGuildMemberAdded(
  runtime: BotRuntime,
  member: GuildMember | PartialGuildMember,
  isAcceptingWork: () => boolean,
): Promise<void> {
  const event = snapshot(member);
  return runMemberLifecycleSerial(
    event.guildId,
    event.memberId,
    "join",
    event.joinedAt,
    async (isCurrentEvent) => {
      const guildRuntime = await currentGuildRuntime(runtime, event.guildId);
      if (!guildRuntime) return;
      const service = createDiscordLifecycleService(
        guildRuntime,
        member.guild,
        isAcceptingWork,
        isCurrentEvent,
      );
      const result = await service.handleJoin(event);
      logResult("member-add", guildRuntime.guildId, event.memberId, result);
    },
  );
}

export async function handleGuildMemberUpdated(
  runtime: BotRuntime,
  oldMember: GuildMember | PartialGuildMember,
  newMember: GuildMember | PartialGuildMember,
  isAcceptingWork: () => boolean,
): Promise<void> {
  const event = snapshot(newMember);
  const wasPending = Boolean(oldMember.pending);
  return runMemberLifecycleSerial(
    event.guildId,
    event.memberId,
    "update",
    event.joinedAt,
    async (isCurrentEvent) => {
      const guildRuntime = await currentGuildRuntime(runtime, event.guildId);
      if (!guildRuntime) return;
      const stored = guildRuntime.storage.getMemberOnboardingState(
        event.memberId,
      );
      const screeningCompleted =
        !event.isBot &&
        !event.pending &&
        (wasPending || stored?.screeningState === "pending");
      if (!screeningCompleted) return;
      const service = createDiscordLifecycleService(
        guildRuntime,
        newMember.guild,
        isAcceptingWork,
        isCurrentEvent,
      );
      const result = await service.handleScreeningUpdate(event);
      for (const role of result.roles.filter(
        (outcome) =>
          (outcome.status === "failed" || outcome.status === "partial") &&
          outcome.failureCode,
      )) {
        await deliverPrivateLifecycleLog(
          guildRuntime,
          newMember.guild,
          `screening-role-failure:${result.state?.joinedAt ?? "unknown"}:${role.roleId}`,
          {
            kind: "automatic-role-failure",
            memberId: event.memberId,
            roleId: role.roleId,
            failureCode: role.failureCode!,
          },
          isCurrentEvent,
        );
      }
      logResult(
        "screening-update",
        guildRuntime.guildId,
        event.memberId,
        result,
      );
    },
  );
}

export async function handleGuildMemberRemoved(
  runtime: BotRuntime,
  member: GuildMember | PartialGuildMember,
  isAcceptingWork: () => boolean,
): Promise<void> {
  const event = snapshot(member);
  return runMemberLifecycleSerial(
    event.guildId,
    event.memberId,
    "leave",
    event.joinedAt,
    async (isCurrentEvent) => {
      const guildRuntime = await currentGuildRuntime(runtime, event.guildId);
      if (!guildRuntime) return;
      const service = createDiscordLifecycleService(
        guildRuntime,
        member.guild,
        isAcceptingWork,
        isCurrentEvent,
      );
      const result = await service.handleLeave(event);
      logResult("member-remove", guildRuntime.guildId, event.memberId, result);
    },
  );
}

/** Bounded administrative retry for one currently fetched member. */
export async function retryGuildMemberLifecycle(
  runtime: GuildRuntime,
  member: GuildMember,
): Promise<MemberLifecycleResult> {
  const event = snapshot(member);
  return runMemberLifecycleSerial(
    event.guildId,
    event.memberId,
    "update",
    event.joinedAt,
    async (isCurrentEvent) => {
      if (
        member.guild.id !== runtime.guildId ||
        !runtime.isCurrent() ||
        !isCurrentEvent()
      )
        throw new Error("Member lifecycle runtime changed");
      const service = createDiscordLifecycleService(
        runtime,
        member.guild,
        () => runtime.isCurrent(),
        isCurrentEvent,
      );
      return member.user.bot || !member.pending
        ? service.handleJoin(event)
        : service.handleScreeningUpdate(event);
    },
  );
}

export async function deliverPrivateLifecycleLog(
  runtime: GuildRuntime,
  guild: Guild,
  eventKey: string,
  event: MemberLifecycleLogEvent,
  isCurrentEvent: () => boolean = () => true,
): Promise<
  "delivered" | "duplicate" | "busy" | "failed" | "disabled" | "stale"
> {
  if (guild.id !== runtime.guildId || !runtime.isCurrent() || !isCurrentEvent())
    return "stale";
  const configuration = runtime.storage.getOnboardingConfiguration();
  if (
    !configuration?.enabled ||
    !configuration.lifecycleLogChannelId ||
    !configuration.lifecycleLogChannelVerifiedAt
  ) {
    return "disabled";
  }
  const isDefinitionCurrent = (): boolean =>
    runtime.storage.isOnboardingLifecycleDefinitionCurrent({ configuration });
  const claimId = createOpaqueStorageId();
  try {
    const reservation = runtime.storage.reserveOnboardingDelivery({
      memberId: event.memberId,
      joinInstance: eventKey.slice(0, 100),
      kind: "lifecycle-log",
      claimId,
      claimExpiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    if (reservation.status !== "reserved") return reservation.status;
    const runtimeCurrent = runtime.isCurrent() && isCurrentEvent();
    const definitionCurrent = isDefinitionCurrent();
    if (!runtimeCurrent || !definitionCurrent) {
      runtime.storage.completeOnboardingDelivery(
        reservation.delivery.deliveryId,
        {
          claimId,
          state: "failed",
          failureCode: runtimeCurrent
            ? "onboarding-definition-changed"
            : "runtime-generation-changed",
        },
      );
      return "stale";
    }
    let receipt: MemberLifecycleDeliveryReceipt;
    try {
      receipt = await createDiscordMemberLifecycleEffects(
        runtime,
        guild,
        isCurrentEvent,
      ).deliver(
        {
          kind: "lifecycle-log",
          guildId: runtime.guildId,
          memberId: event.memberId,
          channelId: configuration.lifecycleLogChannelId,
          events: [event],
        },
        isDefinitionCurrent,
      );
    } catch (error) {
      const definitionChanged = !isDefinitionCurrent();
      runtime.storage.completeOnboardingDelivery(
        reservation.delivery.deliveryId,
        {
          claimId,
          state: "failed",
          failureCode: definitionChanged
            ? "onboarding-definition-changed"
            : classifyError(error).category,
        },
      );
      return definitionChanged ? "stale" : "failed";
    }
    try {
      runtime.storage.completeOnboardingDelivery(
        reservation.delivery.deliveryId,
        {
          claimId,
          state: "delivered",
          channelId: receipt.channelId,
          messageId: receipt.messageId,
        },
      );
      return "delivered";
    } catch {
      // The log message exists; retain an ambiguous claim rather than
      // converting it to a retryable failure that could duplicate the post.
      return "failed";
    }
  } catch {
    return "failed";
  }
}

function createDiscordLifecycleService(
  runtime: GuildRuntime,
  guild: Guild,
  isAcceptingWork: () => boolean,
  isCurrentEvent: () => boolean = () => true,
) {
  return createMemberLifecycleService({
    guildId: runtime.guildId,
    repository: runtime.storage,
    effects: createDiscordMemberLifecycleEffects(
      runtime,
      guild,
      isCurrentEvent,
    ),
    isCurrent: runtime.isCurrent,
    isEffectCurrent: isCurrentEvent,
    isAcceptingWork,
    classifyFailure: (error) => classifyError(error).category,
  });
}

export function createDiscordMemberLifecycleEffects(
  runtime: GuildRuntime,
  guild: Guild,
  isCurrentEvent: () => boolean = () => true,
): MemberLifecycleEffects {
  return {
    async deliver(request, isDefinitionCurrent = () => true) {
      assertCurrentRequest(runtime, guild, request.guildId, isCurrentEvent);
      assertDefinitionCurrent(isDefinitionCurrent);
      if (request.kind === "welcome-dm") {
        const member = await guild.members
          .fetch({ user: request.memberId, cache: true, force: true })
          .catch(() => null);
        if (!member || member.guild.id !== runtime.guildId)
          throw new Error("Member is unavailable for a welcome DM");
        assertCurrentRequest(runtime, guild, request.guildId, isCurrentEvent);
        assertDefinitionCurrent(isDefinitionCurrent);
        const message = await member.send({
          embeds: [
            createSuperiorEmbed()
              .setTitle(request.message.title)
              .setDescription(request.message.body),
          ],
          allowedMentions: { parse: [] },
        });
        return { channelId: message.channelId, messageId: message.id };
      }
      const inspection = await inspectOnboardingChannel(
        guild,
        request.channelId,
        request.kind === "lifecycle-log"
          ? "the lifecycle log channel"
          : "the lifecycle message channel",
      );
      if (!inspection.channel || inspection.issues.length > 0)
        throw new Error("Configured lifecycle channel is unavailable");
      if (request.kind === "lifecycle-log") {
        const everyonePermissions = inspection.channel.permissionsFor(
          guild.roles.everyone,
        );
        if (
          !everyonePermissions ||
          everyonePermissions.has(PermissionFlagsBits.ViewChannel)
        ) {
          throw new Error("Configured lifecycle log channel is not private");
        }
      }
      assertCurrentRequest(runtime, guild, request.guildId, isCurrentEvent);
      assertDefinitionCurrent(isDefinitionCurrent);
      const embed =
        request.kind === "lifecycle-log"
          ? lifecycleLogEmbed(request.events)
          : createSuperiorEmbed()
              .setTitle(request.message.title)
              .setDescription(request.message.body);
      const message = await inspection.channel.send({
        embeds: [embed],
        allowedMentions: { parse: [] },
      });
      return { channelId: message.channelId, messageId: message.id };
    },

    async validateAndAssignRole(request, isDefinitionCurrent = () => true) {
      assertCurrentRequest(runtime, guild, request.guildId, isCurrentEvent);
      assertDefinitionCurrent(isDefinitionCurrent);
      const [member, botMember, role] = await Promise.all([
        fetchGuildMemberCoalesced(guild, request.memberId, {
          cache: true,
          force: true,
        }),
        fetchCurrentBotMember(guild, { force: true }),
        fetchGuildRoleCoalesced(guild, request.roleId, {
          cache: true,
          force: true,
        }),
      ]);
      if (!member || !botMember || !role)
        throw new Error("Automatic-role resources are unavailable");
      if (
        member.guild.id !== runtime.guildId ||
        member.user.bot !== (request.audience === "bot") ||
        (!member.user.bot && member.pending)
      )
        throw new Error("Member is not eligible for this automatic role");
      const issue = assignableRoleSafetyIssue(role, {
        guildId: runtime.guildId,
        botMember,
      });
      if (issue) throw new Error(issue);
      assertDefinitionCurrent(isDefinitionCurrent);
      if (member.roles.cache.has(role.id)) return "already-held";
      assertCurrentRequest(runtime, guild, request.guildId, isCurrentEvent);
      assertDefinitionCurrent(isDefinitionCurrent);
      await member.roles.add(role, `Superior ${request.operationKind}`);
      return "added";
    },
  };
}

function lifecycleLogEmbed(events: readonly MemberLifecycleLogEvent[]) {
  const first = events[0];
  const title = first ? lifecycleEventTitle(first) : "Member lifecycle event";
  const lines = events.slice(0, 12).flatMap(lifecycleEventLines);
  return createSuperiorEmbed()
    .setTitle(title)
    .setDescription(lines.join("\n").slice(0, 4_096));
}

function lifecycleEventTitle(event: MemberLifecycleLogEvent): string {
  switch (event.kind) {
    case "member-joined":
      return "Member joined";
    case "bot-joined":
      return "Bot joined";
    case "member-left":
      return "Member left";
    case "bot-left":
      return "Bot left";
    case "account-age-alert":
      return "Account-age information";
    case "automatic-role-failure":
      return "Automatic-role delivery incomplete";
    case "verification-accepted":
      return "Rules acknowledgement recorded";
    case "verification-recovery":
      return "Verification recovery completed";
  }
}

function lifecycleEventLines(event: MemberLifecycleLogEvent): string[] {
  const member = `Member ID: \`${event.memberId}\``;
  switch (event.kind) {
    case "member-joined":
    case "bot-joined":
      return [
        member,
        `Native screening: ${event.pending ? "pending" : "not pending"}`,
      ];
    case "member-left":
    case "bot-left":
      return [member];
    case "account-age-alert":
      return [
        member,
        `Account created: <t:${Math.floor(Date.parse(event.accountCreatedAt) / 1_000)}:F>`,
        `Configured threshold: ${event.thresholdHours} hour(s)`,
        "Account age is informational and is not proof of abuse. Superior took no punitive action.",
      ];
    case "automatic-role-failure":
      return [
        member,
        `Role ID: \`${event.roleId}\``,
        `Failure: \`${escapeMarkdown(event.failureCode)}\``,
      ];
    case "verification-accepted":
      return [member, `Rules version: \`${event.rulesVersion}\``];
    case "verification-recovery":
      return [
        member,
        `Rules version: \`${event.rulesVersion}\``,
        "An authorized administrator ran bounded verification recovery.",
      ];
  }
}

function snapshot(
  member: GuildMember | PartialGuildMember,
): MemberLifecycleSnapshot {
  return {
    guildId: member.guild.id,
    memberId: member.id,
    isBot: member.user.bot,
    pending: Boolean(member.pending),
    displayName: member.displayName || member.user.username || "Member",
    guildName: member.guild.name,
    approximateMemberCount: member.guild.memberCount,
    accountCreatedAt: member.user.createdAt,
    joinedAt: member.joinedAt,
  };
}

async function currentGuildRuntime(
  runtime: BotRuntime,
  guildId: string,
): Promise<GuildRuntime | null> {
  const current = await runtime.forGuild(guildId);
  return current?.settings.enabled && current.isCurrent() ? current : null;
}

function assertCurrentRequest(
  runtime: GuildRuntime,
  guild: Guild,
  guildId: string,
  isCurrentEvent: () => boolean = () => true,
): void {
  if (
    guild.id !== guildId ||
    guildId !== runtime.guildId ||
    !runtime.isCurrent() ||
    !isCurrentEvent()
  )
    throw new Error("Guild lifecycle runtime changed");
}

function assertDefinitionCurrent(isDefinitionCurrent: () => boolean): void {
  if (!isDefinitionCurrent()) {
    throw new Error("Onboarding lifecycle definition changed");
  }
}

function logResult(
  operation: string,
  guildId: string,
  memberId: string,
  result: Awaited<
    ReturnType<ReturnType<typeof createDiscordLifecycleService>["handleJoin"]>
  >,
): void {
  logInfo("onboarding-lifecycle", "Member lifecycle operation completed", {
    guildId,
    memberId,
    operation,
    outcome: result.status,
    deliveryCount: result.deliveries.length,
    roleOperationCount: result.roles.length,
    failedDeliveryCount: result.deliveries.filter(
      (item) => item.status === "failed",
    ).length,
    failedRoleCount: result.roles.filter(
      (item) => item.status === "failed" || item.status === "partial",
    ).length,
  });
}
