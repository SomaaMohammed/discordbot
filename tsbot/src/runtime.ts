import { DateTime } from "luxon";
import { getNow } from "./time.js";
import type { GuildSettings, ProcessConfig } from "./types.js";
import { BotStorage, type GuildStorage } from "./storage/db.js";

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
}

export interface BotRuntime {
  readonly processConfig: ProcessConfig;
  readonly storage: BotStorage;
  readonly randomInt: (maxExclusive: number) => number;
  forGuild: (guildId: string) => Promise<GuildRuntime | null>;
  invalidateGuild: (guildId: string) => void;
}

export function createRuntime(
  processConfig: ProcessConfig,
  _repoRoot?: string,
): BotRuntime {
  const storage = new BotStorage({ dbFile: processConfig.dbFile });
  storage.initStorage();
  const guildGenerations = new Map<string, number>();
  const randomInt = (maxExclusive: number): number =>
    Math.floor(Math.random() * Math.max(maxExclusive, 1));

  const runtime: BotRuntime = {
    processConfig,
    storage,
    randomInt,
    async forGuild(guildId: string): Promise<GuildRuntime | null> {
      const normalizedGuildId = String(guildId).trim();
      if (!/^\d{17,20}$/.test(normalizedGuildId)) return null;
      const initialExpectation =
        storage.getGuildEnableExpectation(normalizedGuildId);
      if (!initialExpectation) return null;

      let persistedSettings = structuredClone(initialExpectation.settings);
      let persistedLifecycleJoinedAt = initialExpectation.lifecycleJoinedAt;
      let settings = structuredClone(initialExpectation.settings);
      const guildStorage = storage.forGuild(normalizedGuildId);
      let generation = guildGenerations.get(normalizedGuildId) ?? 0;

      const guildRuntime: GuildRuntime = {
        guildId: normalizedGuildId,
        botVersion: processConfig.botVersion,
        storage: guildStorage,
        settings,
        get generation(): number {
          return generation;
        },
        now: () => getNow(settings.timezone),
        randomInt,
        isCurrent(): boolean {
          if ((guildGenerations.get(normalizedGuildId) ?? 0) !== generation) {
            return false;
          }
          const record = storage.getGuild(normalizedGuildId);
          const currentSettings = storage.getGuildSettings(normalizedGuildId);
          return Boolean(
            record?.enabled &&
            record.leftAt === null &&
            currentSettings?.enabled &&
            !currentSettings.reviewRequired,
          );
        },
        invalidate(): void {
          runtime.invalidateGuild(normalizedGuildId);
        },
        async refreshSettings(): Promise<GuildSettings> {
          const refreshed =
            storage.getGuildEnableExpectation(normalizedGuildId);
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
        async saveSettings(
          nextSettings: GuildSettings,
        ): Promise<GuildSettings> {
          const saved = storage.saveGuildSettings(
            normalizedGuildId,
            nextSettings,
            persistedSettings,
          );
          runtime.invalidateGuild(normalizedGuildId);
          generation = guildGenerations.get(normalizedGuildId) ?? generation;
          persistedSettings = structuredClone(saved);
          settings = structuredClone(saved);
          guildRuntime.settings = settings;
          return settings;
        },
        async setEnabled(enabled: boolean): Promise<GuildSettings> {
          const saved = storage.setGuildEnabled(
            normalizedGuildId,
            enabled,
            enabled
              ? {
                  settings: persistedSettings,
                  lifecycleJoinedAt: persistedLifecycleJoinedAt,
                }
              : undefined,
          );
          runtime.invalidateGuild(normalizedGuildId);
          generation = guildGenerations.get(normalizedGuildId) ?? generation;
          persistedSettings = structuredClone(saved);
          settings = structuredClone(saved);
          guildRuntime.settings = settings;
          return settings;
        },
      };
      return guildRuntime;
    },
    invalidateGuild(guildId: string): void {
      const normalizedGuildId = String(guildId);
      guildGenerations.set(
        normalizedGuildId,
        (guildGenerations.get(normalizedGuildId) ?? 0) + 1,
      );
    },
  };
  return runtime;
}
