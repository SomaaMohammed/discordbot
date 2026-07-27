import { KeyedSerialQueue } from "./keyed-serial-queue.js";
import { SILENCE_LEASES_METRIC_KEY } from "../constants.js";

export { SILENCE_LEASES_METRIC_KEY } from "../constants.js";

export type SendMessagesState = boolean | null;

export interface SilenceLease {
  channelId: string;
  roleId: string;
  originalSendMessages: SendMessagesState;
  expiresAt: number;
}

export interface SilenceLeaseStorage {
  metricsGet: (key: string, defaultValue: string) => string;
  metricsSet: (key: string, value: string | number) => void;
}

export interface SilenceOverwriteTarget {
  readSendMessages: () => SendMessagesState;
  writeSendMessages: (
    value: SendMessagesState,
    reason: string,
  ) => Promise<void>;
}

export const SILENCE_TARGET_DELETED = Symbol("silence-target-deleted");

export type SilenceTargetResolution =
  SilenceOverwriteTarget | null | typeof SILENCE_TARGET_DELETED;

export interface SilenceReconcileResult {
  restored: number;
  enforced: number;
  unresolved: number;
}

type SilenceTargetResolver = (
  lease: SilenceLease,
) => Promise<SilenceTargetResolution>;

interface PersistedSilenceLeases {
  version: 1;
  leases: SilenceLease[];
}

const MISSING_LEASE_VALUE_A = "__imperial_court_missing_silence_lease_a__";
const MISSING_LEASE_VALUE_B = "__imperial_court_missing_silence_lease_b__";

export class SilenceLeaseCorruptionError extends Error {
  public constructor(message: string) {
    super(`Persisted silence lease metadata is malformed: ${message}`);
    this.name = "SilenceLeaseCorruptionError";
  }
}

function leaseKey(channelId: string, roleId: string): string {
  return `${channelId}:${roleId}`;
}

export function getEffectiveSilenceTargetRoleIds(
  targetRoleIds: readonly string[],
  excludedRoleIds: readonly string[],
): string[] {
  const excluded = new Set(excludedRoleIds);
  return [...new Set(targetRoleIds)].filter((roleId) => !excluded.has(roleId));
}

function isNumericId(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

function isSendMessagesState(value: unknown): value is SendMessagesState {
  return value === null || typeof value === "boolean";
}

function normalizeLease(value: unknown): SilenceLease | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Partial<SilenceLease>;
  if (
    !isNumericId(candidate.channelId) ||
    !isNumericId(candidate.roleId) ||
    !isSendMessagesState(candidate.originalSendMessages) ||
    typeof candidate.expiresAt !== "number" ||
    !Number.isFinite(candidate.expiresAt) ||
    candidate.expiresAt < 0
  ) {
    return null;
  }
  return {
    channelId: candidate.channelId,
    roleId: candidate.roleId,
    originalSendMessages: candidate.originalSendMessages,
    expiresAt: Math.floor(candidate.expiresAt),
  };
}

export function readSilenceLeases(
  storage: SilenceLeaseStorage,
): SilenceLease[] {
  let raw = storage.metricsGet(
    SILENCE_LEASES_METRIC_KEY,
    MISSING_LEASE_VALUE_A,
  );
  if (raw === MISSING_LEASE_VALUE_A) {
    const verified = storage.metricsGet(
      SILENCE_LEASES_METRIC_KEY,
      MISSING_LEASE_VALUE_B,
    );
    if (verified === MISSING_LEASE_VALUE_B) {
      return [];
    }
    raw = verified;
  }

  let parsed: Partial<PersistedSilenceLeases>;
  try {
    parsed = JSON.parse(raw) as Partial<PersistedSilenceLeases>;
  } catch {
    throw new SilenceLeaseCorruptionError("invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SilenceLeaseCorruptionError("root must be an object");
  }
  if (parsed.version !== 1 || !Array.isArray(parsed.leases)) {
    throw new SilenceLeaseCorruptionError(
      "expected version 1 with a leases array",
    );
  }
  const byTarget = new Map<string, SilenceLease>();
  for (const value of parsed.leases) {
    const lease = normalizeLease(value);
    if (!lease) {
      throw new SilenceLeaseCorruptionError("lease entry is invalid");
    }
    const key = leaseKey(lease.channelId, lease.roleId);
    if (byTarget.has(key)) {
      throw new SilenceLeaseCorruptionError(
        `duplicate channel/role target ${key}`,
      );
    }
    byTarget.set(key, lease);
  }
  return [...byTarget.values()];
}

function writeSilenceLeases(
  storage: SilenceLeaseStorage,
  leases: SilenceLease[],
): void {
  const payload: PersistedSilenceLeases = {
    version: 1,
    leases: [...leases].sort((left, right) =>
      leaseKey(left.channelId, left.roleId).localeCompare(
        leaseKey(right.channelId, right.roleId),
      ),
    ),
  };
  storage.metricsSet(SILENCE_LEASES_METRIC_KEY, JSON.stringify(payload));
}

export class SilenceLeaseCoordinator {
  private readonly guildQueue = new KeyedSerialQueue();

  public async apply(
    storage: SilenceLeaseStorage,
    guildId: string,
    channelId: string,
    roleId: string,
    expiresAt: number,
    target: SilenceOverwriteTarget,
    reason: string,
  ): Promise<boolean> {
    return this.guildQueue.run(guildId, async () => {
      const leases = readSilenceLeases(storage);
      const key = leaseKey(channelId, roleId);
      const existingIndex = leases.findIndex(
        (lease) => leaseKey(lease.channelId, lease.roleId) === key,
      );
      const existing =
        existingIndex >= 0 ? (leases[existingIndex] ?? null) : null;
      const lease: SilenceLease = {
        channelId,
        roleId,
        originalSendMessages:
          existing === null
            ? target.readSendMessages()
            : existing.originalSendMessages,
        expiresAt: Math.max(
          existing?.expiresAt ?? 0,
          Math.max(0, Math.floor(expiresAt)),
        ),
      };
      if (existingIndex >= 0) {
        leases[existingIndex] = lease;
      } else {
        leases.push(lease);
      }

      writeSilenceLeases(storage, leases);
      if (target.readSendMessages() === false) {
        return true;
      }

      try {
        await target.writeSendMessages(false, reason);
        return true;
      } catch {
        if (existing) {
          leases[existingIndex] = existing;
        } else {
          leases.splice(
            existingIndex >= 0 ? existingIndex : leases.length - 1,
            1,
          );
        }
        writeSilenceLeases(storage, leases);
        return false;
      }
    });
  }

  public async reconcileGuild(
    storage: SilenceLeaseStorage,
    guildId: string,
    now: number,
    resolveTarget: SilenceTargetResolver,
  ): Promise<SilenceReconcileResult> {
    return this.guildQueue.run(guildId, async () => {
      const leases = readSilenceLeases(storage);
      const retained: SilenceLease[] = [];
      let restored = 0;
      let enforced = 0;
      let unresolved = 0;

      for (const lease of leases) {
        const target = await resolveTarget(lease);
        if (target === SILENCE_TARGET_DELETED) {
          continue;
        }
        if (!target) {
          retained.push(lease);
          unresolved += 1;
          continue;
        }

        if (lease.expiresAt <= now) {
          try {
            await target.writeSendMessages(
              lease.originalSendMessages,
              "Silence lease expired",
            );
            restored += 1;
          } catch {
            retained.push(lease);
            unresolved += 1;
          }
          continue;
        }

        retained.push(lease);
        if (target.readSendMessages() === false) {
          continue;
        }
        try {
          await target.writeSendMessages(false, "Silence lease recovery");
          enforced += 1;
        } catch {
          unresolved += 1;
        }
      }

      if (
        retained.length !== leases.length ||
        retained.some((lease, index) => lease !== leases[index])
      ) {
        writeSilenceLeases(storage, retained);
      }
      return { restored, enforced, unresolved };
    });
  }

  public async restoreAll(
    storage: SilenceLeaseStorage,
    guildId: string,
    resolveTarget: SilenceTargetResolver,
  ): Promise<SilenceReconcileResult> {
    return this.guildQueue.run(guildId, async () => {
      const leases = readSilenceLeases(storage);
      const retained: SilenceLease[] = [];
      let restored = 0;
      let unresolved = 0;

      for (const lease of leases) {
        const target = await resolveTarget(lease);
        if (target === SILENCE_TARGET_DELETED) {
          continue;
        }
        if (!target) {
          retained.push(lease);
          unresolved += 1;
          continue;
        }
        try {
          await target.writeSendMessages(
            lease.originalSendMessages,
            "Silence lease cancelled before data removal",
          );
          restored += 1;
        } catch {
          retained.push(lease);
          unresolved += 1;
        }
      }

      if (retained.length !== leases.length) {
        writeSilenceLeases(storage, retained);
      }
      return { restored, enforced: 0, unresolved };
    });
  }
}
