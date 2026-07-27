import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { __scanBackfillHistoryTargetForTests } from "../src/discord/commands.js";
import { CourtStorage, type GuildStorage } from "../src/storage/db.js";

type FakeUser = { id: string; bot?: boolean };

type FakeReaction = {
  users: {
    fetch: ReturnType<typeof vi.fn>;
  };
};

type FakeMessage = {
  id: string;
  createdTimestamp: number;
  author: FakeUser;
  reactions: {
    cache: Map<string, FakeReaction>;
  };
};

type FakeBatch = {
  size: number;
  values: () => IterableIterator<FakeMessage>;
  last: () => FakeMessage | undefined;
};

function createReaction(users: FakeUser[]): FakeReaction {
  const rows = new Map(users.map((user) => [user.id, user]));
  return {
    users: {
      fetch: vi.fn(async () => rows),
    },
  };
}

function createMessage(
  id: string,
  createdTimestamp: number,
  author: FakeUser,
  reactions: FakeReaction[] = [],
): FakeMessage {
  const cache = new Map<string, FakeReaction>();
  for (const [index, reaction] of reactions.entries()) {
    cache.set(`${id}-r${index + 1}`, reaction);
  }

  return {
    id,
    createdTimestamp,
    author,
    reactions: { cache },
  };
}

function createBatch(messages: FakeMessage[]): FakeBatch {
  return {
    size: messages.length,
    values: () => messages.values(),
    last: () => messages.at(-1),
  };
}

function createScanTarget(batches: FakeMessage[][]): {
  target: { messages: { fetch: ReturnType<typeof vi.fn> } };
  fetchMock: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  const fetchMock = vi.fn(
    async (_options: { limit: number; before?: string }) => {
      const batch = batches[index] ?? [];
      index += 1;
      return createBatch(batch);
    },
  );

  return {
    target: {
      messages: {
        fetch: fetchMock,
      },
    },
    fetchMock,
  };
}

function createStorageForBackfillTests(): GuildStorage {
  const repoRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "courtbot-ts-backfill-"),
  );
  const config = { dbFile: ":memory:" };

  const storage = new CourtStorage(config, repoRoot);
  storage.initStorage();
  const guildId = "123456789012345678";
  storage.ensureGuild(guildId, "Backfill Regression");
  return storage.forGuild(guildId);
}

describe("backfill scanning regression", () => {
  it("respects lookback cutoff and tallies non-bot users", async () => {
    const m1 = createMessage("m1", 1300, { id: "100000000000000010" }, [
      createReaction([
        { id: "100000000000000020" },
        { id: "100000000000000021", bot: true },
      ]),
    ]);
    const m2 = createMessage("m2", 1100, { id: "100000000000000011", bot: true }, [
      createReaction([{ id: "100000000000000022" }]),
    ]);
    const m3 = createMessage("m3", 900, { id: "100000000000000012" }, [
      createReaction([{ id: "100000000000000023" }]),
    ]);

    const { target, fetchMock } = createScanTarget([[m1, m2, m3]]);

    const messageCounts: Record<string, number> = {};
    const reactionsSentCounts: Record<string, number> = {};
    const reactionsReceivedCounts: Record<string, number> = {};

    const [scannedMessages, scannedReactions] =
      await __scanBackfillHistoryTargetForTests(
        target,
        1000,
        messageCounts,
        reactionsSentCounts,
        reactionsReceivedCounts,
      );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(scannedMessages).toBe(2);
    expect(scannedReactions).toBe(2);
    expect(messageCounts).toEqual({ "100000000000000010": 1 });
    expect(reactionsSentCounts).toEqual({
      "100000000000000020": 1,
      "100000000000000022": 1,
    });
    expect(reactionsReceivedCounts).toEqual({
      "100000000000000010": 1,
    });
  });

  it("stops reaction scans when the guild invalidates during a fetch", async () => {
    let current = true;
    const firstFetch = vi.fn(async () => {
      current = false;
      return new Map([
        ["100000000000000020", { id: "100000000000000020" }],
      ]);
    });
    const secondFetch = vi.fn(async () => new Map());
    const message = createMessage(
      "m1",
      1300,
      { id: "100000000000000010" },
      [
        { users: { fetch: firstFetch } },
        { users: { fetch: secondFetch } },
      ],
    );
    const { target, fetchMock } = createScanTarget([[message]]);

    const messageCounts: Record<string, number> = {};
    const reactionsSentCounts: Record<string, number> = {};
    const reactionsReceivedCounts: Record<string, number> = {};

    await expect(
      __scanBackfillHistoryTargetForTests(
        target,
        null,
        messageCounts,
        reactionsSentCounts,
        reactionsReceivedCounts,
        () => current,
      ),
    ).rejects.toThrow("Backfill cancelled");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(firstFetch).toHaveBeenCalledTimes(1);
    expect(secondFetch).not.toHaveBeenCalled();
    expect(reactionsSentCounts).toEqual({});
    expect(reactionsReceivedCounts).toEqual({});
  });
});

describe("backfill merge regression", () => {
  it("mergeUserMetricBackfill uses max semantics and reports seen and updated counts", () => {
    const storage = createStorageForBackfillTests();
    const key10 = storage.buildUserMetricKey(10, "messages_sent");
    const key20 = storage.buildUserMetricKey(20, "messages_sent");

    storage.metricsSet(key10, "5");
    storage.metricsSet(key20, "1");

    const scannedCounts = {
      10: 3,
      20: 7,
      0: 9,
      30: 0,
      bad: 11,
    } as unknown as Record<number, number>;

    const [usersSeen, updated] = storage.mergeUserMetricBackfill(
      scannedCounts,
      "messages_sent",
    );

    expect(usersSeen).toBe(2);
    expect(updated).toBe(1);
    expect(storage.metricsGet(key10, "0")).toBe("5");
    expect(storage.metricsGet(key20, "0")).toBe("7");
  });

  it("listTopUsersForMetric ignores invalid keys and sorts ties by user id", () => {
    const storage = createStorageForBackfillTests();

    storage.metricsSet(storage.buildUserMetricKey(30, "messages_sent"), "9");
    storage.metricsSet(storage.buildUserMetricKey(10, "messages_sent"), "9");
    storage.metricsSet(storage.buildUserMetricKey(20, "messages_sent"), "7");
    storage.metricsSet(storage.buildUserMetricKey(99, "reactions_sent"), "99");
    storage.metricsSet("user_stats.bad.messages_sent", "100");

    const top = storage.listTopUsersForMetric("messages_sent", 3);
    expect(top).toEqual([
      ["10", 9],
      ["30", 9],
      ["20", 7],
    ]);
  });
});

describe("storage state regression", () => {
  it("getState preserves auto-post metrics", () => {
    const storage = createStorageForBackfillTests();
    const lastSuccessfulAutoPost = "2026-04-20T20:05:00.000Z";

    storage.metricsSet("last_successful_auto_post", lastSuccessfulAutoPost);
    storage.metricsSet("posts_total", "42");

    const loaded = storage.getState();

    expect(loaded.metrics.last_successful_auto_post).toBe(
      lastSuccessfulAutoPost,
    );
    expect(storage.metricsGet("last_successful_auto_post", "")).toBe(
      lastSuccessfulAutoPost,
    );
    expect(storage.metricsGet("posts_total", "0")).toBe("42");
  });
});
