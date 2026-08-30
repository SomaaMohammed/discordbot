import { DateTime } from "luxon";
import { getNow } from "./time.js";
import type {
  ApplicationForm,
  ApplicationFormField,
  GuildSettings,
  ProcessConfig,
  SuggestionConfiguration,
  TicketDepartment,
  TicketDepartmentField,
} from "./types.js";
import { BotStorage, type GuildStorage } from "./storage/db.js";
import { logDebug, logError, logInfo, logWarn } from "./logging.js";
import { CURRENT_SCHEMA_VERSION } from "./storage/schema.js";
import { loadPrivateMudaeWatchConfig } from "./mudae-watch-config.js";
import {
  createEmojiReplyService,
  type EmojiReplyService,
} from "./emoji-replies-service.js";
import {
  PrivateMudaeWatcher,
  type PrivateMudaeWatchDeduplicationStore,
  type PrivateMudaeWatchLogger,
} from "./mudae-watch-service.js";
import { observeLatency, observeLatencySync } from "./latency.js";

export type BackgroundWork = () => void | Promise<void>;

export interface GuildRuntime {
  readonly guildId: string;
  readonly botVersion: string;
  readonly storage: GuildStorage;
  settings: GuildSettings;
  readonly generation: number;
  now: () => DateTime;
  randomInt: (maxExclusive: number) => number;
  isCurrent: () => boolean;
  invalidate: () => void;
  refreshSettings: () => Promise<GuildSettings>;
  saveSettings: (settings: GuildSettings) => Promise<GuildSettings>;
  setEnabled: (enabled: boolean) => Promise<GuildSettings>;
  runInBackground: (task: BackgroundWork) => void;
}

export interface BotRuntime {
  readonly processConfig: ProcessConfig;
  readonly storage: BotStorage;
  readonly privateMudaeWatcher: PrivateMudaeWatcher | null;
  readonly emojiReplies: EmojiReplyService | null;
  readonly randomInt: (maxExclusive: number) => number;
  forGuild: (guildId: string) => Promise<GuildRuntime | null>;
  interactionFormsForGuild: (guildId: string) => InteractionFormSnapshot | null;
  invalidateGuild: (guildId: string) => void;
}

export interface CachedApplicationForm {
  readonly form: ApplicationForm;
  readonly fields: readonly ApplicationFormField[];
}

export interface CachedTicketDepartment {
  readonly department: TicketDepartment;
  readonly fields: readonly TicketDepartmentField[];
}

/**
 * Memory-only form definitions used to make showModal the first Discord API
 * action at interaction receipt. Every modal submission still reloads and
 * revalidates the authoritative database records before changing state.
 */
export interface InteractionFormSnapshot {
  readonly guildId: string;
  readonly suggestionConfiguration: SuggestionConfiguration | null;
  readonly applicationForms: readonly CachedApplicationForm[];
  readonly ticketDepartments: readonly CachedTicketDepartment[];
}

export function createRuntime(
  processConfig: ProcessConfig,
  applicationRoot?: string,
): BotRuntime {
  const storage = new BotStorage({ dbFile: processConfig.dbFile });
  storage.initStorage();
  logInfo("storage", "Database opened and validated", {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    schemaClassification: `exact-v${CURRENT_SCHEMA_VERSION}`,
    databaseMode: processConfig.dbFile === ":memory:" ? "memory" : "file",
  });
  const prunedDeliveries = storage.pruneMudaeWatchDeliveries();
  if (prunedDeliveries > 0) {
    logInfo("delivery-cleanup", "Expired delivery reservations pruned", {
      rowsDeleted: prunedDeliveries,
    });
  } else {
    logDebug("delivery-cleanup", "No expired delivery reservations found", {
      rowsDeleted: 0,
    });
  }
  const privateMudaeWatcher = applicationRoot
    ? createPrivateMudaeWatcher(storage, applicationRoot)
    : null;
  const guildGenerations = new Map<string, number>();
  const guildRuntimeCache = new Map<string, GuildRuntime>();
  const guildRuntimeLoads = new Map<
    string,
    { generation: number; promise: Promise<GuildRuntime | null> }
  >();
  const interactionFormSnapshots = new Map<string, InteractionFormSnapshot>();
  const randomInt = (maxExclusive: number): number =>
    Math.floor(Math.random() * Math.max(maxExclusive, 1));
  const emojiReplies = applicationRoot
    ? createEmojiReplyService(applicationRoot, { randomInt })
    : null;

  const runtime: BotRuntime = {
    processConfig,
    storage,
    privateMudaeWatcher,
    emojiReplies,
    randomInt,
    async forGuild(guildId: string): Promise<GuildRuntime | null> {
      const normalizedGuildId = String(guildId).trim();
      if (!/^\d{17,20}$/.test(normalizedGuildId)) return null;
      const generation = guildGenerations.get(normalizedGuildId) ?? 0;
      const cached = guildRuntimeCache.get(normalizedGuildId);
      if (cached && cached.generation === generation) {
        return observeLatency(
          "runtime.forGuild",
          "forGuild",
          async () => cached,
          { guildId: normalizedGuildId, cache: "hit" },
        );
      }
      const existingLoad = guildRuntimeLoads.get(normalizedGuildId);
      if (existingLoad?.generation === generation) {
        return observeLatency(
          "runtime.forGuild",
          "forGuild",
          () => existingLoad.promise,
          { guildId: normalizedGuildId, cache: "coalesced" },
        );
      }

      const promise = observeLatency(
        "runtime.forGuild",
        "forGuild",
        async () => {
          const initialExpectation = observeLatencySync(
            "sqlite.operation",
            "getGuildEnableExpectation",
            () => storage.getGuildEnableExpectation(normalizedGuildId),
            { guildId: normalizedGuildId },
          );
          if (!initialExpectation) return null;

          let persistedSettings = structuredClone(initialExpectation.settings);
          let persistedLifecycleJoinedAt = initialExpectation.lifecycleJoinedAt;
          let settings = structuredClone(initialExpectation.settings);
          const guildStorage = storage.forGuild(normalizedGuildId);
          let runtimeGeneration = generation;

          const guildRuntime: GuildRuntime = {
            guildId: normalizedGuildId,
            botVersion: processConfig.botVersion,
            storage: guildStorage,
            settings,
            get generation(): number {
              return runtimeGeneration;
            },
            now: () => getNow(settings.timezone),
            randomInt,
            isCurrent(): boolean {
              if (
                (guildGenerations.get(normalizedGuildId) ?? 0) !==
                runtimeGeneration
              ) {
                return false;
              }
              return observeLatencySync(
                "sqlite.operation",
                "isGuildCurrent",
                () => storage.isGuildCurrent(normalizedGuildId),
                { guildId: normalizedGuildId },
              );
            },
            invalidate(): void {
              runtime.invalidateGuild(normalizedGuildId);
            },
            refreshSettings(): Promise<GuildSettings> {
              return observeLatency(
                "runtime.refreshSettings",
                "refreshSettings",
                async () => {
                  const refreshed = observeLatencySync(
                    "sqlite.operation",
                    "getGuildEnableExpectation",
                    () => storage.getGuildEnableExpectation(normalizedGuildId),
                    { guildId: normalizedGuildId },
                  );
                  if (!refreshed) {
                    throw new Error(
                      `Guild ${normalizedGuildId} is no longer registered in storage`,
                    );
                  }
                  persistedSettings = structuredClone(refreshed.settings);
                  persistedLifecycleJoinedAt = refreshed.lifecycleJoinedAt;
                  settings = structuredClone(refreshed.settings);
                  guildRuntime.settings = settings;
                  return settings;
                },
                { guildId: normalizedGuildId },
              );
            },
            async saveSettings(
              nextSettings: GuildSettings,
            ): Promise<GuildSettings> {
              const saved = observeLatencySync(
                "sqlite.operation",
                "saveGuildSettings",
                () =>
                  storage.saveGuildSettings(
                    normalizedGuildId,
                    nextSettings,
                    persistedSettings,
                  ),
                { guildId: normalizedGuildId },
              );
              runtime.invalidateGuild(normalizedGuildId);
              runtimeGeneration =
                guildGenerations.get(normalizedGuildId) ?? runtimeGeneration;
              persistedSettings = structuredClone(saved);
              settings = structuredClone(saved);
              guildRuntime.settings = settings;
              return settings;
            },
            async setEnabled(enabled: boolean): Promise<GuildSettings> {
              const saved = observeLatencySync(
                "sqlite.operation",
                "setGuildEnabled",
                () =>
                  storage.setGuildEnabled(
                    normalizedGuildId,
                    enabled,
                    enabled
                      ? {
                          settings: persistedSettings,
                          lifecycleJoinedAt: persistedLifecycleJoinedAt,
                        }
                      : undefined,
                  ),
                { guildId: normalizedGuildId },
              );
              runtime.invalidateGuild(normalizedGuildId);
              runtimeGeneration =
                guildGenerations.get(normalizedGuildId) ?? runtimeGeneration;
              persistedSettings = structuredClone(saved);
              settings = structuredClone(saved);
              guildRuntime.settings = settings;
              return settings;
            },
            runInBackground(task: BackgroundWork): void {
              storage.scheduleNonessential(task);
            },
          };
          if ((guildGenerations.get(normalizedGuildId) ?? 0) === generation) {
            guildRuntimeCache.set(normalizedGuildId, guildRuntime);
          }
          return guildRuntime;
        },
        { guildId: normalizedGuildId },
      );
      guildRuntimeLoads.set(normalizedGuildId, { generation, promise });
      void promise.then(
        () => {
          if (guildRuntimeLoads.get(normalizedGuildId)?.promise === promise) {
            guildRuntimeLoads.delete(normalizedGuildId);
          }
        },
        () => {
          if (guildRuntimeLoads.get(normalizedGuildId)?.promise === promise) {
            guildRuntimeLoads.delete(normalizedGuildId);
          }
        },
      );
      return promise;
    },
    interactionFormsForGuild(guildId: string): InteractionFormSnapshot | null {
      const normalizedGuildId = String(guildId).trim();
      if (!/^\d{17,20}$/.test(normalizedGuildId)) return null;
      return interactionFormSnapshots.get(normalizedGuildId) ?? null;
    },
    invalidateGuild(guildId: string): void {
      const normalizedGuildId = String(guildId);
      guildRuntimeCache.delete(normalizedGuildId);
      const nextGeneration = (guildGenerations.get(normalizedGuildId) ?? 0) + 1;
      guildGenerations.set(normalizedGuildId, nextGeneration);
      storage.scheduleNonessential(() =>
        refreshInteractionFormSnapshot(normalizedGuildId, nextGeneration),
      );
    },
  };

  const refreshInteractionFormSnapshot = (
    guildId: string,
    expectedGeneration?: number,
  ): void => {
    try {
      if (
        expectedGeneration !== undefined &&
        (guildGenerations.get(guildId) ?? 0) !== expectedGeneration
      ) {
        return;
      }
      const guild = storage.getGuild(guildId);
      const settings = storage.getGuildSettings(guildId);
      if (
        !guild ||
        guild.leftAt !== null ||
        !guild.enabled ||
        !settings?.enabled
      ) {
        interactionFormSnapshots.delete(guildId);
        return;
      }
      const guildStorage = storage.forGuild(guildId);
      const suggestionConfiguration = guildStorage.getSuggestionConfiguration();
      const applicationForms = guildStorage
        .listApplicationForms({ enabledOnly: true, limit: 25 })
        .filter(
          (form) =>
            form.guildId === guildId &&
            form.enabled &&
            form.bindingsVerifiedAt !== null,
        )
        .map((form) => ({
          form: structuredClone(form),
          fields: structuredClone(
            guildStorage.listApplicationFormFields(form.formId),
          ),
        }));
      const ticketDepartments = guildStorage
        .listTicketDepartments({ enabled: true, limit: 10 })
        .filter(
          (department) => department.guildId === guildId && department.enabled,
        )
        .map((department) => ({
          department: structuredClone(department),
          fields: structuredClone(
            guildStorage.listTicketDepartmentFields(department.departmentId),
          ),
        }));
      if (
        expectedGeneration !== undefined &&
        (guildGenerations.get(guildId) ?? 0) !== expectedGeneration
      ) {
        return;
      }
      interactionFormSnapshots.set(guildId, {
        guildId,
        suggestionConfiguration:
          suggestionConfiguration?.enabled === true &&
          suggestionConfiguration.bindingsVerifiedAt !== null
            ? structuredClone(suggestionConfiguration)
            : null,
        applicationForms,
        ticketDepartments,
      });
    } catch (error) {
      interactionFormSnapshots.delete(guildId);
      logWarn(
        "interaction-forms",
        "Could not refresh the in-memory interaction form snapshot",
        { guildId, error },
      );
    }
  };

  for (const guild of storage.listActiveGuilds()) {
    refreshInteractionFormSnapshot(guild.guildId);
  }
  return runtime;
}

function createPrivateMudaeWatcher(
  storage: BotStorage,
  applicationRoot: string,
): PrivateMudaeWatcher | null {
  const loaded = loadPrivateMudaeWatchConfig(applicationRoot);
  if (loaded.status === "missing") {
    return null;
  }
  if (loaded.status === "invalid") {
    logError(
      "private-mudae-watch",
      "Private watcher configuration is invalid; watcher disabled",
      { issueCount: loaded.issues.length },
    );
    return null;
  }

  const channelCount = loaded.config.locations.reduce(
    (total, location) => total + location.channelIds.length,
    0,
  );
  logInfo("private-mudae-watch", "Private watcher configuration loaded", {
    enabled: loaded.config.enabled,
    guildCount: loaded.config.locations.length,
    channelCount,
    seriesCount: loaded.config.series.length,
  });

  return new PrivateMudaeWatcher(loaded.config, {
    deduplicationStore: createPrivateMudaeDeduplicationStore(storage),
    logger: PRIVATE_MUDAE_WATCH_LOGGER,
  });
}

function createPrivateMudaeDeduplicationStore(
  storage: BotStorage,
): PrivateMudaeWatchDeduplicationStore {
  return {
    reserveMudaeWatchNotification(reservation) {
      const guild = storage.getGuild(reservation.guildId);
      if (!guild || guild.leftAt !== null) {
        throw new Error("Configured watcher guild is not currently active");
      }
      const result = storage
        .forGuild(reservation.guildId)
        .reserveMudaeWatchDelivery(reservation.sourceMessageId);
      return result.status === "duplicate"
        ? { status: "duplicate" }
        : { status: "reserved", reservationId: result.reservationId };
    },
    completeMudaeWatchNotification(guildId, reservationId, outcome) {
      if (!storage.getGuild(guildId)) {
        return;
      }
      storage
        .forGuild(guildId)
        .completeMudaeWatchDelivery(reservationId, outcome);
    },
  };
}

const PRIVATE_MUDAE_WATCH_LOGGER: PrivateMudaeWatchLogger = {
  info(message, metadata): void {
    logInfo("private-mudae-watch", message, { ...metadata });
  },
  warn(message, metadata): void {
    logWarn("private-mudae-watch", message, { ...metadata });
  },
  error(message, metadata): void {
    logError("private-mudae-watch", message, { ...metadata });
  },
};
