import { DateTime } from "luxon";
import { DEFAULT_BACKFILL_STATUS } from "./parity.js";
import { getNow } from "./time.js";
import type { BackfillStatusSnapshot, RuntimeConfig } from "./types.js";
import { CourtStorage } from "./storage/db.js";

export interface BotRuntime {
  config: RuntimeConfig;
  storage: CourtStorage;
  backfillStatus: BackfillStatusSnapshot;
  now: () => DateTime;
  randomInt: (maxExclusive: number) => number;
}

export function createRuntime(
  config: RuntimeConfig,
  repoRoot: string,
): BotRuntime {
  const storage = new CourtStorage(config, repoRoot);
  storage.initStorage();

  return {
    config,
    storage,
    backfillStatus: { ...DEFAULT_BACKFILL_STATUS },
    now: () => getNow(config.timezoneName),
    randomInt: (maxExclusive) =>
      Math.floor(Math.random() * Math.max(maxExclusive, 1)),
  };
}
