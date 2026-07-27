import { describe, expect, it, vi } from "vitest";
import {
  getEffectiveSilenceTargetRoleIds,
  readSilenceLeases,
  SILENCE_LEASES_METRIC_KEY,
  SILENCE_TARGET_DELETED,
  SilenceLeaseCorruptionError,
  SilenceLeaseCoordinator,
  type SendMessagesState,
  type SilenceLeaseStorage,
  type SilenceOverwriteTarget,
} from "../src/discord/silence-leases.js";

const GUILD_ID = "123456789012345678";
const CHANNEL_ID = "234567890123456789";
const ROLE_ID = "345678901234567890";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createStorage(): SilenceLeaseStorage {
  let stored: string | undefined;
  return {
    metricsGet: vi.fn((_key, defaultValue) => stored ?? defaultValue),
    metricsSet: vi.fn((_key, value) => {
      stored = String(value);
    }),
  };
}

function createTarget(initial: SendMessagesState): {
  target: SilenceOverwriteTarget;
  getState: () => SendMessagesState;
  write: ReturnType<typeof vi.fn>;
  setState: (value: SendMessagesState) => void;
} {
  let state = initial;
  const write = vi.fn(async (value: SendMessagesState) => {
    state = value;
  });
  return {
    target: {
      readSendMessages: () => state,
      writeSendMessages: write,
    },
    getState: () => state,
    write,
    setState: (value) => {
      state = value;
    },
  };
}

describe("silence leases", () => {
  it("derives the same de-duplicated non-excluded targets used at runtime", () => {
    expect(
      getEffectiveSilenceTargetRoleIds(
        [ROLE_ID, ROLE_ID, "456789012345678901"],
        [ROLE_ID],
      ),
    ).toEqual(["456789012345678901"]);
  });

  it("shares the original baseline and extends one deadline across overlaps", async () => {
    const storage = createStorage();
    const coordinator = new SilenceLeaseCoordinator();
    let state: SendMessagesState = true;
    const writeStarted = deferred();
    const finishWrite = deferred();
    const write = vi.fn(async (value: SendMessagesState) => {
      writeStarted.resolve();
      await finishWrite.promise;
      state = value;
    });
    const target: SilenceOverwriteTarget = {
      readSendMessages: () => state,
      writeSendMessages: write,
    };

    const first = coordinator.apply(
      storage,
      GUILD_ID,
      CHANNEL_ID,
      ROLE_ID,
      1_000,
      target,
      "first silence",
    );
    await writeStarted.promise;
    const second = coordinator.apply(
      storage,
      GUILD_ID,
      CHANNEL_ID,
      ROLE_ID,
      2_000,
      target,
      "second silence",
    );
    finishWrite.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(readSilenceLeases(storage)).toEqual([
      {
        channelId: CHANNEL_ID,
        roleId: ROLE_ID,
        originalSendMessages: true,
        expiresAt: 2_000,
      },
    ]);
  });

  it.each<SendMessagesState>([null, true, false])(
    "restores the exact %s overwrite baseline on expiry",
    async (baseline) => {
      const storage = createStorage();
      const coordinator = new SilenceLeaseCoordinator();
      const fixture = createTarget(baseline);
      await expect(
        coordinator.apply(
          storage,
          GUILD_ID,
          CHANNEL_ID,
          ROLE_ID,
          100,
          fixture.target,
          "silence",
        ),
      ).resolves.toBe(true);

      const restarted = new SilenceLeaseCoordinator();
      await expect(
        restarted.reconcileGuild(
          storage,
          GUILD_ID,
          101,
          async () => fixture.target,
        ),
      ).resolves.toEqual({ restored: 1, enforced: 0, unresolved: 0 });
      expect(fixture.getState()).toBe(baseline);
      expect(fixture.write).toHaveBeenLastCalledWith(
        baseline,
        "Silence lease expired",
      );
      expect(readSilenceLeases(storage)).toEqual([]);
    },
  );

  it("re-enforces and later restores a persisted lease after restart", async () => {
    const storage = createStorage();
    const beforeRestart = new SilenceLeaseCoordinator();
    const fixture = createTarget(true);
    await beforeRestart.apply(
      storage,
      GUILD_ID,
      CHANNEL_ID,
      ROLE_ID,
      200,
      fixture.target,
      "silence",
    );

    fixture.setState(true);
    fixture.write.mockClear();
    const afterRestart = new SilenceLeaseCoordinator();
    await expect(
      afterRestart.reconcileGuild(
        storage,
        GUILD_ID,
        100,
        async () => fixture.target,
      ),
    ).resolves.toEqual({ restored: 0, enforced: 1, unresolved: 0 });
    expect(fixture.getState()).toBe(false);

    await expect(
      afterRestart.reconcileGuild(
        storage,
        GUILD_ID,
        201,
        async () => fixture.target,
      ),
    ).resolves.toEqual({ restored: 1, enforced: 0, unresolved: 0 });
    expect(fixture.getState()).toBe(true);
    expect(readSilenceLeases(storage)).toEqual([]);
  });

  it("restores every active lease immediately before destructive data work", async () => {
    const storage = createStorage();
    const coordinator = new SilenceLeaseCoordinator();
    const fixture = createTarget(null);
    await coordinator.apply(
      storage,
      GUILD_ID,
      CHANNEL_ID,
      ROLE_ID,
      9_999,
      fixture.target,
      "silence",
    );

    await expect(
      coordinator.restoreAll(storage, GUILD_ID, async () => fixture.target),
    ).resolves.toEqual({ restored: 1, enforced: 0, unresolved: 0 });
    expect(fixture.getState()).toBeNull();
    expect(readSilenceLeases(storage)).toEqual([]);
  });

  it("retains a lease when target resolution fails transiently", async () => {
    const storage = createStorage();
    const coordinator = new SilenceLeaseCoordinator();
    const fixture = createTarget(null);
    await coordinator.apply(
      storage,
      GUILD_ID,
      CHANNEL_ID,
      ROLE_ID,
      9_999,
      fixture.target,
      "silence",
    );
    const leases = readSilenceLeases(storage);

    await expect(
      coordinator.restoreAll(storage, GUILD_ID, async () => null),
    ).resolves.toEqual({ restored: 0, enforced: 0, unresolved: 1 });
    expect(readSilenceLeases(storage)).toEqual(leases);
  });

  it("discards a lease whose channel or role was definitively deleted", async () => {
    const storage = createStorage();
    const coordinator = new SilenceLeaseCoordinator();
    const fixture = createTarget(null);
    await coordinator.apply(
      storage,
      GUILD_ID,
      CHANNEL_ID,
      ROLE_ID,
      9_999,
      fixture.target,
      "silence",
    );

    await expect(
      coordinator.restoreAll(
        storage,
        GUILD_ID,
        async () => SILENCE_TARGET_DELETED,
      ),
    ).resolves.toEqual({ restored: 0, enforced: 0, unresolved: 0 });
    expect(readSilenceLeases(storage)).toEqual([]);
  });

  it("discards definitively deleted targets during background reconciliation", async () => {
    const storage = createStorage();
    const coordinator = new SilenceLeaseCoordinator();
    const fixture = createTarget(true);
    await coordinator.apply(
      storage,
      GUILD_ID,
      CHANNEL_ID,
      ROLE_ID,
      9_999,
      fixture.target,
      "silence",
    );

    await expect(
      coordinator.reconcileGuild(
        storage,
        GUILD_ID,
        100,
        async () => SILENCE_TARGET_DELETED,
      ),
    ).resolves.toEqual({ restored: 0, enforced: 0, unresolved: 0 });
    expect(readSilenceLeases(storage)).toEqual([]);
  });

  it("fails loudly when persisted lease JSON is malformed", () => {
    const storage = createStorage();
    storage.metricsSet(SILENCE_LEASES_METRIC_KEY, "{not-json");

    expect(() => readSilenceLeases(storage)).toThrow(
      SilenceLeaseCorruptionError,
    );
    expect(() => readSilenceLeases(storage)).toThrow(/invalid JSON/);
  });

  it("distinguishes an absent lease row from an invalid empty row", () => {
    const storage = createStorage();
    expect(readSilenceLeases(storage)).toEqual([]);

    storage.metricsSet(SILENCE_LEASES_METRIC_KEY, "");
    expect(() => readSilenceLeases(storage)).toThrow(
      SilenceLeaseCorruptionError,
    );
  });
});
