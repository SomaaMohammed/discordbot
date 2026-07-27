import type {
  Client,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { logError, logInfo, logWarn } from "../logging.js";
import type { ProcessConfig } from "../types.js";

export interface CommandRegistrationPlan {
  mode: "global" | "guild";
  registerGlobal: boolean;
  developmentGuildIds: string[];
}

interface GuildCommandFailure {
  guildId: string;
  error: unknown;
}

export function buildCommandRegistrationPlan(
  mode: "global" | "guild",
  developmentGuildIds: readonly string[],
): CommandRegistrationPlan {
  const uniqueGuildIds = Array.from(
    new Set(developmentGuildIds.map((guildId) => String(guildId).trim())),
  ).filter((guildId) => /^\d+$/.test(guildId));

  return {
    mode,
    registerGlobal: mode === "global",
    developmentGuildIds: mode === "guild" ? uniqueGuildIds : [],
  };
}

export async function synchronizeCommands(
  client: Client,
  config: Pick<ProcessConfig, "commandRegistrationMode" | "devGuildIds">,
  definitions: RESTPostAPIChatInputApplicationCommandsJSONBody[],
): Promise<void> {
  const application = client.application;
  if (!application) {
    throw new Error("Discord application was unavailable during command sync");
  }

  const plan = buildCommandRegistrationPlan(
    config.commandRegistrationMode,
    config.devGuildIds,
  );
  logInfo("discord-registration", "Starting command synchronization", {
    mode: plan.mode,
    commandCount: definitions.length,
    developmentGuildCount: plan.developmentGuildIds.length,
  });

  if (plan.registerGlobal) {
    const failedGuildClears = await clearGuildCommandSets(
      client,
      new Set<string>(),
    );
    if (failedGuildClears.length > 0) {
      throw new AggregateError(
        failedGuildClears.map((failure) => failure.error),
        `Global command sync refused because ${failedGuildClears.length} guild command scope(s) could not be cleared`,
      );
    }

    // A global `set` replaces the application command set atomically. Keep the
    // last-known global definitions available until every stale guild scope is
    // cleared; otherwise one transient guild cleanup failure would delete the
    // commands for every production guild.
    const synced = await application.commands.set(definitions);
    logInfo("discord-registration", "Global command sync completed", {
      mode: plan.mode,
      commandCount: synced.size,
    });
    return;
  }

  const cleared = await application.commands.set([]);
  logInfo("discord-registration", "Global command set cleared", {
    mode: plan.mode,
    commandCount: cleared.size,
  });

  const targetGuildIds = new Set(plan.developmentGuildIds);
  const failedGuildClears = await clearGuildCommandSets(client, targetGuildIds);
  const failedGuildSyncs: GuildCommandFailure[] = [];

  for (const guildId of plan.developmentGuildIds) {
    try {
      const guild = await client.guilds.fetch(guildId);
      const synced = await guild.commands.set(definitions);
      logInfo(
        "discord-registration",
        "Development guild command sync completed",
        {
          mode: plan.mode,
          guildId,
          commandCount: synced.size,
        },
      );
    } catch (error) {
      failedGuildSyncs.push({ guildId, error });
      logError(
        "discord-registration",
        "Development guild command sync failed",
        {
          mode: plan.mode,
          guildId,
          error,
        },
      );
    }
  }

  if (failedGuildClears.length > 0 || failedGuildSyncs.length > 0) {
    throw new AggregateError(
      [
        ...failedGuildClears.map((failure) => failure.error),
        ...failedGuildSyncs.map((failure) => failure.error),
      ],
      `Development command synchronization failed: ${failedGuildClears.length} stale guild clear(s) and ${failedGuildSyncs.length} target guild sync(s) failed`,
    );
  }
}

async function clearGuildCommandSets(
  client: Client,
  retainedGuildIds: ReadonlySet<string>,
): Promise<GuildCommandFailure[]> {
  const failures: GuildCommandFailure[] = [];
  for (const guild of client.guilds.cache.values()) {
    if (retainedGuildIds.has(guild.id)) {
      continue;
    }

    try {
      const cleared = await guild.commands.set([]);
      logInfo("discord-registration", "Guild command set cleared", {
        guildId: guild.id,
        commandCount: cleared.size,
      });
    } catch (error) {
      failures.push({ guildId: guild.id, error });
      logWarn("discord-registration", "Failed to clear guild command set", {
        guildId: guild.id,
        error,
      });
    }
  }
  return failures;
}
