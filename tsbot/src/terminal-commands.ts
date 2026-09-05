import { createInterface } from "node:readline";
import type { Client, Guild } from "discord.js";
import type { BotRuntime, GuildRuntime } from "./runtime.js";
import { assertDiscordSnowflake } from "./guild-settings.js";
import { authorizeCapability } from "./discord/authorization.js";
import {
  fetchCurrentBotMember,
  fetchGuildMemberCoalesced,
} from "./discord/fetch-coalescing.js";
import {
  targetIssue,
  timeoutExpiry,
} from "./discord/moderation-commands-handler.js";
import { deliverModerationCaseLog } from "./discord/moderation-log-delivery.js";
import { runModerationTargetAction } from "./discord/moderation-action-queue.js";

type TerminalUntimeoutCommand = {
  kind: "untimeout";
  guildId: string;
  memberId: string;
  actorId: string;
  reason: string;
};

type ParsedTerminalCommand = { kind: "help" } | TerminalUntimeoutCommand;

/**
 * Adds the operator command surface only when the bot is attached to an
 * interactive terminal. The command runs in the existing process so it shares
 * the active Discord client and SQLite connection.
 */
export function installTerminalCommandLoop(
  client: Client,
  runtime: BotRuntime,
): () => void {
  if (!process.stdin.isTTY) return () => undefined;

  const input = createInterface({
    input: process.stdin,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let closed = false;
  let pending = Promise.resolve();

  const onSignal = (): void => {
    cleanup();
  };
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    input.close();
  };

  input.on("line", (line) => {
    pending = pending
      .then(() => handleTerminalCommand(client, runtime, line))
      .catch((error: unknown) => {
        console.error(
          `[terminal] ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  });
  input.once("close", cleanup);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  console.log(
    '[terminal] Commands enabled: untimeout --guild GUILD_ID --member USER_ID --actor ACTOR_ID --reason "..."',
  );
  return cleanup;
}

export function parseTerminalCommandLine(
  line: string,
): ParsedTerminalCommand | null {
  const tokens = tokenize(line);
  if (tokens.length === 0) return null;

  const command = tokens.shift()!.toLowerCase();
  if (command === "help") {
    if (tokens.length > 0) throw new Error("help does not accept arguments");
    return { kind: "help" };
  }
  if (command !== "untimeout" && command !== "unmute") {
    throw new Error(
      "Unknown terminal command. Type help for the available command.",
    );
  }

  const values = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const equals = token.indexOf("=");
    const name = (equals >= 0 ? token.slice(2, equals) : token.slice(2))
      .trim()
      .toLowerCase();
    if (!["guild", "member", "actor", "reason"].includes(name)) {
      throw new Error(`Unknown option: --${name}`);
    }
    const value = equals >= 0 ? token.slice(equals + 1) : tokens[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`Option --${name} requires a value`);
    }
    if (values.has(name)) throw new Error(`Option --${name} was repeated`);
    values.set(name, value);
  }

  const guildId = requiredSnowflake(values, "guild", "guild ID");
  const memberId = requiredSnowflake(values, "member", "member ID");
  const actorId = requiredSnowflake(values, "actor", "actor ID");
  const reason = normalizeReason(values.get("reason"));
  return { kind: "untimeout", guildId, memberId, actorId, reason };
}

async function handleTerminalCommand(
  client: Client,
  runtime: BotRuntime,
  line: string,
): Promise<void> {
  const command = parseTerminalCommandLine(line);
  if (!command) return;
  if (command.kind === "help") {
    console.log(
      '[terminal] Usage: untimeout --guild GUILD_ID --member USER_ID --actor ACTOR_ID --reason "reason"',
    );
    console.log(
      "[terminal] Alias: unmute. The actor must have the moderation.manage capability.",
    );
    return;
  }
  if (!client.isReady()) {
    throw new Error("Discord is not ready yet; try the command again shortly.");
  }

  const guild = await client.guilds.fetch(command.guildId).catch(() => null);
  if (!guild || guild.id !== command.guildId) {
    throw new Error("The bot could not access that guild.");
  }
  const guildRuntime = await runtime.forGuild(command.guildId);
  if (!guildRuntime) {
    throw new Error("That guild is not active in the bot database.");
  }

  await runModerationTargetAction(command.guildId, command.memberId, () =>
    removeTimeoutFromTerminal(
      guild,
      guildRuntime,
      command.memberId,
      command.actorId,
      command.reason,
    ),
  );
}

async function removeTimeoutFromTerminal(
  guild: Guild,
  runtime: GuildRuntime,
  memberId: string,
  actorId: string,
  reason: string,
): Promise<void> {
  await guild.roles.fetch();
  const authorization = await authorizeCapability({
    guild,
    userId: actorId,
    capability: "moderation.manage",
    grants: runtime.storage,
  });
  if (!authorization.allowed) {
    throw new Error(
      `Actor ${actorId} does not have the moderation.manage capability.`,
    );
  }

  const [target, bot] = await Promise.all([
    fetchGuildMemberCoalesced(guild, memberId, {
      cache: true,
      force: true,
    }),
    fetchCurrentBotMember(guild, { force: true }),
  ]);
  const issue = targetIssue(authorization.member, bot, target, "untimeout");
  if (issue) throw new Error(issue);
  if (!target || !bot) throw new Error("Target or bot member is unavailable.");
  if (!runtime.isCurrent()) {
    throw new Error("The guild changed before the command could run.");
  }

  const configuration = runtime.storage.getModerationConfiguration();
  if (!configuration) {
    throw new Error("Moderation is not configured for this guild.");
  }
  const lookup = runtime.storage.findUniqueActiveModerationCase(memberId, [
    "timeout",
    "automod-timeout",
  ]);
  if (lookup.status === "ambiguous") {
    throw new Error(
      "Multiple active timeout cases exist for this member; resolve the case history first.",
    );
  }
  const original = lookup.status === "found" ? lookup.case : null;
  const liveExpiry = target.isCommunicationDisabled()
    ? (target.communicationDisabledUntil?.getTime() ?? null)
    : null;
  const originalTimeout =
    original &&
    (!target.isCommunicationDisabled() ||
      timeoutExpiry(original) === liveExpiry)
      ? original
      : null;

  if (
    originalTimeout &&
    !target.isCommunicationDisabled() &&
    (timeoutExpiry(originalTimeout) ?? Number.POSITIVE_INFINITY) <= Date.now()
  ) {
    const completed = runtime.storage.completeExpiredTimeoutCase(
      originalTimeout.caseId,
      {
        actorId: authorization.member.id,
        observedAt: new Date().toISOString(),
        expectedUpdatedAt: originalTimeout.updatedAt,
      },
    );
    if (completed.status !== "changed" && completed.status !== "unchanged") {
      throw new Error(
        "The expired timeout case changed before it could be reconciled.",
      );
    }
    const delivered = await deliverModerationCaseLog(
      guild,
      runtime,
      completed.case,
    );
    console.log(
      `[terminal] Timeout had already expired for ${memberId}; case #${completed.case.caseNumber} completed (${delivered}).`,
    );
    return;
  }
  if (!configuration.casesEnabled && !originalTimeout) {
    throw new Error(
      "New moderation cases are disabled; timeout removal requires one uniquely matched active timeout case.",
    );
  }
  if (
    target.isCommunicationDisabled() &&
    lookup.status === "found" &&
    !originalTimeout
  ) {
    throw new Error(
      "The current Discord timeout does not match the active case expiry; no change was made.",
    );
  }
  if (!target.isCommunicationDisabled() && !originalTimeout) {
    throw new Error(
      "That member is not currently timed out and has no active Superior timeout case.",
    );
  }

  const attempt = runtime.storage.reserveModerationCaseAttempt({
    targetUserId: target.id,
    actorId: authorization.member.id,
    actionType: "timeout-removed",
    source: "moderation-command",
    publicReason: reason,
    relatedCaseId: originalTimeout?.caseId ?? null,
    discordActionMetadata: {
      originalCaseId: originalTimeout?.caseId ?? null,
      originalExpiresAt:
        originalTimeout && timeoutExpiry(originalTimeout) !== null
          ? new Date(timeoutExpiry(originalTimeout)!).toISOString()
          : (target.communicationDisabledUntil?.toISOString() ?? null),
    },
  });

  if (target.isCommunicationDisabled()) {
    try {
      await target.timeout(null, reason);
    } catch {
      runtime.storage.failModerationCaseAttempt(attempt.caseId, {
        actorId: authorization.member.id,
        failureCode: "discord-untimeout-failed",
        expectedUpdatedAt: attempt.updatedAt,
      });
      throw new Error(
        `Discord rejected timeout removal; failed attempt case #${attempt.caseNumber} was retained.`,
      );
    }
    const refreshed = await guild.members
      .fetch({ user: target.id, cache: true, force: true })
      .catch(() => null);
    if (!refreshed || refreshed.isCommunicationDisabled()) {
      runtime.storage.failModerationCaseAttempt(attempt.caseId, {
        actorId: authorization.member.id,
        failureCode: "untimeout-not-confirmed",
        expectedUpdatedAt: attempt.updatedAt,
      });
      throw new Error(
        `Discord did not confirm timeout removal; failed attempt case #${attempt.caseNumber} was retained.`,
      );
    }
  }

  const finalized = originalTimeout
    ? runtime.storage.finalizeTimeoutRemovalCase(attempt.caseId, {
        actorId: authorization.member.id,
        originalCaseId: originalTimeout.caseId,
        removalExpectedUpdatedAt: attempt.updatedAt,
        originalExpectedUpdatedAt: originalTimeout.updatedAt,
      })
    : runtime.storage.confirmModerationCase(attempt.caseId, {
        actorId: authorization.member.id,
        status: "completed",
        expectedUpdatedAt: attempt.updatedAt,
      });
  if (finalized.status !== "changed" && finalized.status !== "unchanged") {
    throw new Error(
      `Discord confirmed timeout removal, but case #${attempt.caseNumber} needs recovery.`,
    );
  }

  const confirmedCase =
    "removalCase" in finalized ? finalized.removalCase : finalized.case;
  if ("originalCase" in finalized) {
    await deliverModerationCaseLog(guild, runtime, finalized.originalCase);
  }
  const delivered = await deliverModerationCaseLog(
    guild,
    runtime,
    confirmedCase,
  );
  runtime.storage.recordCommandMetric("timeout.remove");
  console.log(
    `[terminal] Removed timeout from ${memberId}; case #${confirmedCase.caseNumber} recorded (log: ${delivered}).`,
  );
}

function requiredSnowflake(
  values: Map<string, string>,
  key: string,
  label: string,
): string {
  const value = values.get(key);
  if (!value) throw new Error(`Missing required option: --${key}`);
  return assertDiscordSnowflake(value, label);
}

function normalizeReason(value: string | undefined): string {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim();
  if (!normalized)
    throw new Error("Option --reason requires a non-empty value");
  if (normalized.length > 500) {
    throw new Error("Option --reason must be 500 characters or fewer");
  }
  return normalized;
}

function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;
  for (const character of line.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
      started = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("Unterminated quote in terminal command");
  if (started) tokens.push(current);
  return tokens;
}

export type { ParsedTerminalCommand, TerminalUntimeoutCommand };
