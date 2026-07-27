import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { DateTime } from "luxon";
import { afterEach, describe, expect, it } from "vitest";
import { SILENCE_LEASES_METRIC_KEY } from "../src/constants.js";
import { CourtStorage } from "../src/storage/db.js";

const GUILD_A = "111111111111111111";
const GUILD_B = "222222222222222222";
const roots: string[] = [];
const storages: CourtStorage[] = [];

function makeStorage(): CourtStorage {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "court-storage-"));
  roots.push(root);
  const bootstrap = path.join(root, "data", "bootstrap");
  fs.mkdirSync(bootstrap, { recursive: true });
  fs.writeFileSync(
    path.join(bootstrap, "questions.json"),
    JSON.stringify({ general: ["Seed question?"] }),
  );
  const storage = new CourtStorage({ dbFile: ":memory:" }, root);
  storage.initStorage();
  storages.push(storage);
  return storage;
}

function makeFileStorage(): { storage: CourtStorage; dbFile: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "court-storage-file-"));
  roots.push(root);
  const bootstrap = path.join(root, "data", "bootstrap");
  fs.mkdirSync(bootstrap, { recursive: true });
  fs.writeFileSync(
    path.join(bootstrap, "questions.json"),
    JSON.stringify({ general: ["Seed question?"] }),
  );
  const dbFile = path.join(root, "court.db");
  const storage = new CourtStorage({ dbFile }, root);
  storage.initStorage();
  storages.push(storage);
  return { storage, dbFile };
}

afterEach(() => {
  for (const storage of storages.splice(0)) {
    storage.close();
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("guild-scoped storage", () => {
  it("isolates settings, state, questions, posts, answers, cooldowns, and metrics", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD_A, "Guild A");
    storage.ensureGuild(GUILD_B, "Guild B");
    const a = storage.forGuild(GUILD_A);
    const b = storage.forGuild(GUILD_B);

    const aSettings = a.getSettings();
    aSettings.timezone = "Asia/Amman";
    aSettings.channels.court = "333333333333333333";
    aSettings.courtSchedule.mode = "auto";
    aSettings.weeklyDigestSchedule = { weekday: 4, hour: 9 };
    aSettings.enabled = true;
    a.saveSettings(aSettings);
    storage.setGuildEnabled(
      GUILD_A,
      true,
      storage.getGuildEnableExpectation(GUILD_A)!,
    );

    expect(b.getSettings()).toMatchObject({
      enabled: false,
      timezone: "UTC",
      channels: { court: null },
      courtSchedule: { mode: "off" },
      weeklyDigestSchedule: { weekday: 0, hour: 19 },
    });
    expect(storage.listEnabledGuilds().map((guild) => guild.guildId)).toEqual([
      GUILD_A,
    ]);

    a.setQuestions({ general: ["A only?"] });
    b.setQuestions({ general: ["B only?"] });
    a.updateStateAtomic((state) => {
      state.history.push("A only?");
      state.royal_afk.by_title.Emperor.active = true;
      state.royal_presence.last_speaker = "Empress";
    });
    b.updateStateAtomic((state) => {
      state.history.push("B only?");
    });

    const post = {
      message_id: "900000000000000001",
      channel_id: "800000000000000001",
      category: "general",
      question: "Question?",
      posted_at: "2026-01-01T00:00:00.000Z",
      close_after_hours: 24,
      closed: false,
      thread_id: null,
      closed_at: null,
      close_reason: null,
    };
    a.upsertPostRow(post);
    b.upsertPostRow({ ...post, question: "Other question?" });
    a.markUserAnswered(
      "900000000000000001",
      "700000000000000001",
      "600000000000000001",
    );
    expect(b.getLastAnswerTimeForUser("700000000000000001")).toBeNull();
    b.markUserAnswered(
      "900000000000000001",
      "700000000000000001",
      "600000000000000002",
    );
    a.metricsSet("custom", 11);
    b.metricsSet("custom", 22);

    expect(a.getQuestions().general).toEqual(["A only?"]);
    expect(b.getQuestions().general).toEqual(["B only?"]);
    expect(a.getState().history).toEqual(["A only?"]);
    expect(b.getState().history).toEqual(["B only?"]);
    expect(a.getState().royal_afk.by_title.Emperor.active).toBe(true);
    expect(b.getState().royal_afk.by_title.Emperor.active).toBe(false);
    expect(a.getState().royal_presence.last_speaker).toBe("Empress");
    expect(b.getState().royal_presence.last_speaker).toBeNull();
    expect(a.getPostRecord("900000000000000001")?.question).toBe("Question?");
    expect(b.getPostRecord("900000000000000001")?.question).toBe(
      "Other question?",
    );
    expect(a.findAnswerRecord("600000000000000001")?.user_id).toBe(
      "700000000000000001",
    );
    expect(a.findAnswerRecord("600000000000000002")).toBeNull();
    expect(b.findAnswerRecord("600000000000000002")?.user_id).toBe(
      "700000000000000001",
    );
    expect(a.getLastAnswerTimeForUser("700000000000000001")).not.toBeNull();
    expect(b.getLastAnswerTimeForUser("700000000000000001")).not.toBeNull();
    expect(a.metricsGet("custom", "0")).toBe("11");
    expect(b.metricsGet("custom", "0")).toBe("22");
  });

  it("retains data on leave and disables a rejoined guild", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD_A);
    const a = storage.forGuild(GUILD_A);
    a.setQuestions({ general: ["Retained?"] });
    storage.setGuildEnabled(
      GUILD_A,
      true,
      storage.getGuildEnableExpectation(GUILD_A)!,
    );

    const left = storage.markGuildLeft(GUILD_A);
    expect(left).toMatchObject({ enabled: false });
    expect(left?.leftAt).not.toBeNull();
    expect(storage.listEnabledGuilds()).toEqual([]);
    expect(storage.forGuild(GUILD_A).getQuestions().general).toEqual([
      "Retained?",
    ]);

    const rejoined = storage.reactivateGuild(GUILD_A, "Rejoined");
    expect(rejoined).toMatchObject({ enabled: false, leftAt: null });
    expect(storage.forGuild(GUILD_A).getSettings().enabled).toBe(false);
    expect(storage.forGuild(GUILD_A).getQuestions().general).toEqual([
      "Retained?",
    ]);
  });

  it("purges only the selected guild and rejects cross-guild imports", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD_A);
    storage.ensureGuild(GUILD_B);
    const a = storage.forGuild(GUILD_A);
    const b = storage.forGuild(GUILD_B);
    a.setQuestions({ general: ["A"] });
    b.setQuestions({ general: ["B"] });
    a.metricsSet("only-a", 1);
    b.metricsSet("only-b", 1);
    storage.setGuildEnabled(
      GUILD_B,
      true,
      storage.getGuildEnableExpectation(GUILD_B)!,
    );

    const exportB = b.exportData();
    expect(exportB.settings.enabled).toBe(true);
    expect(exportB.guildId).toBe(GUILD_B);
    expect(exportB.questions.general).toEqual(["B"]);
    expect(exportB.metrics.map((metric) => metric.key)).toContain("only-b");
    expect(exportB.metrics.map((metric) => metric.key)).not.toContain("only-a");
    expect(() => a.importData(exportB)).toThrow("does not belong");
    b.setQuestions({ general: ["Changed"] });
    b.metricsSet("only-b", 9);
    b.importData(exportB);
    expect(b.getQuestions().general).toEqual(["B"]);
    expect(b.metricsGet("only-b", "0")).toBe("1");
    expect(b.getSettings().enabled).toBe(false);

    const result = storage.purgeGuild(GUILD_A);
    expect(result).toMatchObject({ guilds: 1, settings: 1, kv: 1, metrics: 1 });
    expect(storage.getGuild(GUILD_A)).toBeNull();
    expect(storage.getGuild(GUILD_B)).not.toBeNull();
    expect(storage.forGuild(GUILD_B).getQuestions().general).toEqual(["B"]);
    expect(storage.forGuild(GUILD_B).metricsGet("only-b", "0")).toBe("1");
  });

  it("reserves live silence leases from portable export and import replacement", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD_A);
    const guild = storage.forGuild(GUILD_A);
    const liveLease = JSON.stringify({
      version: 1,
      leases: [
        {
          channelId: "333333333333333333",
          roleId: "444444444444444444",
          originalSendMessages: null,
          expiresAt: 9_999,
        },
      ],
    });
    guild.metricsSet(SILENCE_LEASES_METRIC_KEY, liveLease);
    guild.metricsSet("portable", 7);
    const portable = guild.exportData();

    expect(portable.metrics.map((metric) => metric.key)).not.toContain(
      SILENCE_LEASES_METRIC_KEY,
    );
    const injected = structuredClone(portable);
    injected.metrics.push({
      key: SILENCE_LEASES_METRIC_KEY,
      value: "attacker-controlled",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(() => guild.importData(injected)).toThrow(/reserved silence-lock/i);
    expect(guild.metricsGet(SILENCE_LEASES_METRIC_KEY, "")).toBe(liveLease);
    expect(guild.metricsGet("portable", "0")).toBe("7");

    guild.metricsSet("portable", 99);
    guild.importData(portable);
    expect(guild.metricsGet("portable", "0")).toBe("7");
    expect(guild.metricsGet(SILENCE_LEASES_METRIC_KEY, "")).toBe(liveLease);
  });

  it("preserves malformed live silence metadata across import replacement", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD_A);
    const guild = storage.forGuild(GUILD_A);
    guild.metricsSet(SILENCE_LEASES_METRIC_KEY, "{unknown-baseline");
    const portable = guild.exportData();

    guild.importData(portable);

    expect(guild.metricsGet(SILENCE_LEASES_METRIC_KEY, "")).toBe(
      "{unknown-baseline",
    );
  });

  it("preserves an uninitialized question pool across export and import", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD_A);
    const guild = storage.forGuild(GUILD_A);

    const exported = guild.exportData();
    expect(exported.kv.map((row) => row.key)).not.toContain("questions");
    guild.importData(exported);

    expect(guild.initializeCourtQuestions()).toBe(true);
    expect(guild.getQuestions().general).toEqual(["Seed question?"]);
  });

  it("rejects numeric imported Discord IDs and rolls back every guild row", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD_A);
    const guild = storage.forGuild(GUILD_A);
    guild.setQuestions({ general: ["Original question?"] });
    guild.updateStateAtomic((state) => {
      state.history = ["Original history?"];
    });
    guild.metricsSet("original", 7);
    const payload = structuredClone(guild.exportData());
    payload.questions = { general: ["Replacement question?"] };
    payload.state.history = ["Replacement history?"];
    payload.settings.timezone = "Asia/Amman";
    payload.metrics = [
      {
        key: "replacement",
        value: "9",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    (
      payload as unknown as {
        answers: Array<Record<string, unknown>>;
      }
    ).answers = [
      {
        questionMessageId: Number("900000000000000001"),
        userId: "700000000000000001",
        answerMessageId: "600000000000000001",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    expect(() => guild.importData(payload)).toThrow("question message ID");

    expect(guild.getQuestions().general).toEqual(["Original question?"]);
    expect(guild.getState().history).toEqual(["Original history?"]);
    expect(guild.getSettings().timezone).toBe("UTC");
    expect(guild.metricsGet("original", "0")).toBe("7");
    expect(guild.metricsGet("replacement", "0")).toBe("0");
    expect(guild.countAllAnswerRecords()).toBe(0);
  });

  it("rejects duplicate imported answer message IDs without changing guild data", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD_A);
    const guild = storage.forGuild(GUILD_A);
    guild.setQuestions({ general: ["Original question?"] });
    guild.metricsSet("original", 7);
    guild.markUserAnswered(
      "900000000000000001",
      "700000000000000001",
      "600000000000000001",
    );
    const before = guild.exportData();
    const payload = structuredClone(before);
    payload.answers = [
      {
        questionMessageId: "900000000000000002",
        userId: "700000000000000002",
        answerMessageId: "600000000000000002",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        questionMessageId: "900000000000000003",
        userId: "700000000000000003",
        answerMessageId: "600000000000000002",
        createdAt: "2026-01-02T00:00:00.000Z",
      },
    ];

    expect(() => guild.importData(payload)).toThrow(
      /answer message ID must be unique/i,
    );

    const after = guild.exportData();
    expect({ ...after, exportedAt: before.exportedAt }).toEqual(before);
  });

  it("rolls back the entire anonymous-answer record when an aggregate metric write fails", () => {
    const { storage, dbFile } = makeFileStorage();
    storage.ensureGuild(GUILD_A);
    const guild = storage.forGuild(GUILD_A);
    const injector = new Database(dbFile);
    try {
      injector.exec(`
        CREATE TRIGGER fail_answer_total
        BEFORE INSERT ON metrics
        WHEN NEW.metric_key = 'answers_total'
        BEGIN
          SELECT RAISE(ABORT, 'injected aggregate metric failure');
        END
      `);
    } finally {
      injector.close();
    }

    expect(() =>
      guild.markUserAnswered(
        "900000000000000001",
        "700000000000000001",
        "600000000000000001",
      ),
    ).toThrow("injected aggregate metric failure");

    expect(guild.countAllAnswerRecords()).toBe(0);
    expect(guild.getLastAnswerTimeForUser("700000000000000001")).toBeNull();
    expect(
      guild.metricsGet(
        guild.buildUserMetricKey(
          "700000000000000001",
          "anonymous_answers_sent",
        ),
        "0",
      ),
    ).toBe("0");
    expect(guild.metricsGet("answers_total", "0")).toBe("0");
  });

  it("preserves malformed state and question bytes when reads fail", () => {
    const { storage, dbFile } = makeFileStorage();
    storage.ensureGuild(GUILD_A);
    const guild = storage.forGuild(GUILD_A);
    guild.updateStateAtomic(() => undefined);
    guild.setQuestions({ general: ["Original question?"] });
    const malformedState = "{broken-state";
    const malformedQuestions = "{broken-questions";
    const corrupt = new Database(dbFile);
    try {
      corrupt
        .prepare("UPDATE kv SET value = ? WHERE guild_id = ? AND key = 'state'")
        .run(malformedState, GUILD_A);
      corrupt
        .prepare(
          "UPDATE kv SET value = ? WHERE guild_id = ? AND key = 'questions'",
        )
        .run(malformedQuestions, GUILD_A);
    } finally {
      corrupt.close();
    }

    expect(() => guild.getState()).toThrow(/state/i);
    expect(() => guild.getQuestions()).toThrow(/questions/i);

    const verify = new Database(dbFile, { readonly: true });
    try {
      expect(
        verify
          .prepare(
            "SELECT key, value FROM kv WHERE guild_id = ? AND key IN ('state', 'questions') ORDER BY key",
          )
          .all(GUILD_A),
      ).toEqual([
        { key: "questions", value: malformedQuestions },
        { key: "state", value: malformedState },
      ]);
    } finally {
      verify.close();
    }
  });

  it("preserves unknown legacy state fields across normal state updates", () => {
    const { storage, dbFile } = makeFileStorage();
    storage.ensureGuild(GUILD_A);
    const guild = storage.forGuild(GUILD_A);
    guild.updateStateAtomic(() => undefined);

    const seed = new Database(dbFile);
    try {
      const row = seed
        .prepare("SELECT value FROM kv WHERE guild_id = ? AND key = 'state'")
        .get(GUILD_A) as { value: string };
      seed
        .prepare("UPDATE kv SET value = ? WHERE guild_id = ? AND key = 'state'")
        .run(
          JSON.stringify({
            ...(JSON.parse(row.value) as Record<string, unknown>),
            future_runtime_sentinel: {
              preserve: true,
              nested: ["exact", 7],
            },
          }),
          GUILD_A,
        );
    } finally {
      seed.close();
    }

    guild.updateStateAtomic((state) => {
      state.history.push("A normal runtime update");
    });

    const verify = new Database(dbFile, { readonly: true });
    try {
      const row = verify
        .prepare("SELECT value FROM kv WHERE guild_id = ? AND key = 'state'")
        .get(GUILD_A) as { value: string };
      expect(JSON.parse(row.value)).toMatchObject({
        history: ["A normal runtime update"],
        future_runtime_sentinel: {
          preserve: true,
          nested: ["exact", 7],
        },
      });
    } finally {
      verify.close();
    }
  });

  it("orders mixed-offset posts by chronological instant", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD_A);
    const guild = storage.forGuild(GUILD_A);
    guild.upsertPostRow({
      message_id: "900000000000000001",
      thread_id: null,
      channel_id: "800000000000000001",
      category: "general",
      question: "Chronologically older?",
      // 2026-01-01T22:00:00Z; lexicographically later than the next row.
      posted_at: "2026-01-02T01:00:00.000+03:00",
      close_after_hours: 24,
      closed: false,
      closed_at: null,
      close_reason: null,
    });
    guild.upsertPostRow({
      message_id: "900000000000000002",
      thread_id: null,
      channel_id: "800000000000000001",
      category: "general",
      question: "Chronologically newer?",
      // 2026-01-02T04:30:00Z; lexicographically earlier than the prior row.
      posted_at: "2026-01-01T23:30:00.000-05:00",
      close_after_hours: 24,
      closed: false,
      closed_at: null,
      close_reason: null,
    });

    expect(guild.listPostRecords().map((post) => post.message_id)).toEqual([
      "900000000000000001",
      "900000000000000002",
    ]);
    expect(guild.listPostRecords(true, 1)[0]?.message_id).toBe(
      "900000000000000002",
    );
    expect(guild.getLatestOpenPost()?.message_id).toBe("900000000000000002");
  });

  it("restores raw kv and built-in metrics without coercion or conflicts", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD_A);
    const guild = storage.forGuild(GUILD_A);
    guild.setQuestions({ general: ["Original question?"] });
    guild.updateStateAtomic((state) => {
      state.history = ["Original history?"];
      state.used_questions = ["Original question?"];
    });
    guild.metricsSet("posts_total", 5);
    const exported = guild.exportData();

    guild.setQuestions({ general: ["Replacement question?"] });
    guild.updateStateAtomic((state) => {
      state.history = ["Replacement history?"];
    });
    guild.metricsSet("posts_total", 99);

    guild.importData(exported);

    expect(guild.getQuestions().general).toEqual(["Original question?"]);
    expect(guild.getState().history).toEqual(["Original history?"]);
    expect(guild.metricsGet("posts_total", "0")).toBe("5");
    const restored = guild.exportData();
    expect(restored.kv).toEqual(exported.kv);
    expect(restored.metrics).toEqual(exported.metrics);
  });

  it("rejects invalid imported timestamps before deleting existing rows", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD_A);
    const guild = storage.forGuild(GUILD_A);
    guild.setQuestions({ general: ["Still here?"] });
    const payload = guild.exportData();
    payload.posts = [
      {
        message_id: "900000000000000001",
        thread_id: null,
        channel_id: "800000000000000001",
        category: "general",
        question: "Invalid timestamp?",
        posted_at: "not-a-timestamp",
        close_after_hours: 24,
        closed: false,
        closed_at: null,
        close_reason: null,
      },
    ];

    expect(() => guild.importData(payload)).toThrow(/timestamp/i);
    expect(guild.getQuestions().general).toEqual(["Still here?"]);
    expect(guild.listPostRecords()).toEqual([]);
  });

  it("rejects import fields that would be normalized or silently ignored", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD_A);
    const guild = storage.forGuild(GUILD_A);
    guild.setQuestions({ general: ["Still here?"] });
    guild.metricsSet("custom", 7);

    const transformedSettings = structuredClone(guild.exportData());
    transformedSettings.settings.invocation.keyword = "  INVICTUS  ";
    expect(() => guild.importData(transformedSettings)).toThrow(/normalized/i);

    const ignoredPostSnapshot = structuredClone(guild.exportData());
    ignoredPostSnapshot.state.posts = [
      {
        message_id: "900000000000000001",
        thread_id: null,
        channel_id: "800000000000000001",
        category: "general",
        question: "Ignored?",
        posted_at: "2026-01-01T00:00:00.000Z",
        close_after_hours: 24,
        closed: false,
        closed_at: null,
        close_reason: null,
      },
    ];
    expect(() => guild.importData(ignoredPostSnapshot)).toThrow(
      /posts snapshot/i,
    );

    const ignoredMetricSnapshot = structuredClone(guild.exportData());
    ignoredMetricSnapshot.state.metrics.posts_total = 99;
    expect(() => guild.importData(ignoredMetricSnapshot)).toThrow(
      /metrics snapshot/i,
    );

    expect(guild.getQuestions().general).toEqual(["Still here?"]);
    expect(guild.metricsGet("custom", "0")).toBe("7");
    expect(guild.listPostRecords()).toEqual([]);
  });

  it("purges mixed-offset answer timestamps by chronological instant", () => {
    const storage = makeStorage();
    storage.ensureGuild(GUILD_A);
    const guild = storage.forGuild(GUILD_A);
    const exported = guild.exportData();
    const cutoff = DateTime.utc().minus({ days: 90 });
    exported.answers = [
      {
        questionMessageId: "900000000000000001",
        userId: "700000000000000001",
        answerMessageId: "600000000000000001",
        createdAt: cutoff
          .minus({ hours: 12 })
          .setZone("Pacific/Kiritimati")
          .toISO()!,
      },
      {
        questionMessageId: "900000000000000002",
        userId: "700000000000000002",
        answerMessageId: "600000000000000002",
        createdAt: cutoff.plus({ hours: 12 }).setZone("Etc/GMT+12").toISO()!,
      },
    ];
    guild.importData(exported);

    expect(guild.purgeExpiredAnswers(90)).toBe(1);
    expect(guild.findAnswerRecord("600000000000000001")).toBeNull();
    expect(guild.findAnswerRecord("600000000000000002")).not.toBeNull();
  });
});
