import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DateTime } from "luxon";
import {
  HISTORY_LIMIT,
  POST_RECORD_LIMIT,
  STORAGE_JSON_KEYS,
  THREAD_CLOSE_HOURS,
  USER_METRIC_PREFIX,
} from "../constants.js";
import {
  coerceInt,
  ensureMetricsShape,
  ensureRoyalAfkShape,
  ensureRoyalPresenceShape,
  flattenMetricsForStorage,
} from "../parity.js";
import { isoNow } from "../time.js";
import type {
  CourtState,
  MetricsShape,
  PostRecord,
  RuntimeConfig,
} from "../types.js";
import {
  ANON_COOLDOWNS_TABLE_SQL,
  ANSWERS_MESSAGE_ID_INDEX_SQL,
  ANSWERS_QUESTION_CREATED_INDEX_SQL,
  ANSWERS_TABLE_SQL,
  KV_TABLE_SQL,
  METRICS_TABLE_SQL,
  POSTS_CLOSED_POSTED_AT_INDEX_SQL,
  POSTS_TABLE_SQL,
} from "./schema.js";

interface CountRow {
  c: number;
}

interface JsonRow {
  value: string;
}

interface MetricRow {
  metric_key: string;
  metric_value: string;
}

interface PostRow {
  message_id: string;
  thread_id: string | null;
  channel_id: string;
  category: string;
  question: string;
  posted_at: string;
  close_after_hours: number;
  closed: number;
  closed_at: string | null;
  close_reason: string | null;
}

interface AnswerRecordRow {
  question_message_id: string;
  user_id: string;
}

interface CooldownRow {
  last_answer_at: string;
}

export class CourtStorage {
  private readonly db: Database.Database;

  public constructor(
    private readonly config: RuntimeConfig,
    private readonly repoRoot: string,
  ) {
    this.db = new Database(this.config.dbFile);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
  }

  public initStorage(): void {
    this.db.exec(KV_TABLE_SQL);
    this.db.exec(POSTS_TABLE_SQL);
    this.db.exec(ANSWERS_TABLE_SQL);
    this.db.exec(METRICS_TABLE_SQL);
    this.db.exec(ANON_COOLDOWNS_TABLE_SQL);
    this.db.exec(POSTS_CLOSED_POSTED_AT_INDEX_SQL);
    this.db.exec(ANSWERS_QUESTION_CREATED_INDEX_SQL);
    this.db.exec(ANSWERS_MESSAGE_ID_INDEX_SQL);

    this.maybeMigrateJsonFiles();
    this.migrateStructuredTables();
  }

  public getState(): CourtState {
    const defaultState = this.defaultStatePayload();
    const state = this.dbGetJson("state", defaultState) as Partial<CourtState>;

    const mergedState: CourtState = {
      ...defaultState,
      ...state,
      mode: state.mode ?? defaultState.mode,
      hour: coerceInt(state.hour, defaultState.hour, 0, 23),
      minute: coerceInt(state.minute, defaultState.minute, 0, 59),
      channel_id: coerceInt(state.channel_id, defaultState.channel_id, 1),
      log_channel_id: coerceInt(
        state.log_channel_id,
        defaultState.log_channel_id,
        0,
      ),
      last_posted_date: state.last_posted_date ?? null,
      dry_run_auto_post: Boolean(state.dry_run_auto_post ?? false),
      last_dry_run_date: state.last_dry_run_date ?? null,
      last_weekly_digest_week: state.last_weekly_digest_week ?? null,
      history: Array.isArray(state.history)
        ? state.history.filter(
            (item): item is string => typeof item === "string",
          )
        : [],
      used_questions: Array.isArray(state.used_questions)
        ? state.used_questions.filter(
            (item): item is string => typeof item === "string",
          )
        : [],
      royal_presence: ensureRoyalPresenceShape(state.royal_presence),
      royal_afk: ensureRoyalAfkShape(state.royal_afk),
      posts: this.listPostRecords(true, POST_RECORD_LIMIT),
      metrics: this.metricsSnapshot(),
    };

    if (mergedState.channel_id <= 0) {
      mergedState.channel_id = this.config.courtChannelId;
    }

    const stateToPersist: CourtState = {
      ...mergedState,
      posts: [],
      metrics: ensureMetricsShape({}),
    };
    this.saveState(stateToPersist, { persistMetrics: false });

    return mergedState;
  }

  public saveState(
    state: CourtState,
    options: { persistMetrics?: boolean } = {},
  ): void {
    const persistMetrics = options.persistMetrics ?? true;

    const nextState: CourtState = {
      ...state,
      history: state.history.slice(-HISTORY_LIMIT),
      used_questions: dedupeStrings(state.used_questions),
      metrics: ensureMetricsShape(state.metrics),
      royal_presence: ensureRoyalPresenceShape(state.royal_presence),
      royal_afk: ensureRoyalAfkShape(state.royal_afk),
      posts: state.posts.slice(-POST_RECORD_LIMIT),
    };

    for (const post of nextState.posts) {
      this.upsertPostRow(post);
    }

    if (persistMetrics) {
      for (const [metricKey, metricValue] of Object.entries(
        flattenMetricsForStorage(nextState.metrics),
      )) {
        this.metricsSet(metricKey, metricValue);
      }
    }

    const persisted: CourtState = {
      ...nextState,
      posts: [],
      metrics: ensureMetricsShape({}),
    };

    this.dbSetJson("state", persisted);
  }

  public updateStateAtomic(mutator: (state: CourtState) => void): CourtState {
    const state = this.getState();
    mutator(state);
    this.saveState(state);

    return {
      ...state,
      posts: this.listPostRecords(true, POST_RECORD_LIMIT),
      metrics: this.metricsSnapshot(),
    };
  }

  public getQuestions(): Record<string, string[]> {
    const fallback: Record<string, string[]> = {
      general: [],
      gaming: [],
      music: [],
      "hot-take": [],
      chaos: [],
    };

    const data = this.dbGetJson("questions", fallback);
    if (typeof data !== "object" || data === null) {
      return fallback;
    }

    const parsed: Record<string, string[]> = {};
    for (const [category, items] of Object.entries(
      data as Record<string, unknown>,
    )) {
      if (!Array.isArray(items)) {
        continue;
      }
      parsed[category] = items.filter(
        (item): item is string => typeof item === "string",
      );
    }

    return { ...fallback, ...parsed };
  }

  public setQuestions(questions: Record<string, string[]>): void {
    const sanitized: Record<string, string[]> = {};
    for (const [category, items] of Object.entries(questions)) {
      if (!Array.isArray(items)) {
        continue;
      }

      sanitized[category] = items
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
    }

    this.dbSetJson("questions", sanitized);
  }

  public metricsSnapshot(): MetricsShape {
    return ensureMetricsShape({
      command_usage: this.metricsGetPrefixed("command_usage."),
      command_failures: this.metricsGetPrefixed("command_failures."),
      posts_by_category: this.metricsGetPrefixed("posts_by_category."),
      posts_total: this.metricsGet("posts_total", "0"),
      posts_auto: this.metricsGet("posts_auto", "0"),
      posts_manual: this.metricsGet("posts_manual", "0"),
      custom_posts: this.metricsGet("custom_posts", "0"),
      answers_total: this.metricsGet("answers_total", "0"),
      last_successful_auto_post:
        this.metricsGet("last_successful_auto_post", "") || null,
    });
  }

  public metricsSet(key: string, value: string | number): void {
    this.db
      .prepare(
        `
        INSERT INTO metrics (metric_key, metric_value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(metric_key) DO UPDATE SET
          metric_value = excluded.metric_value,
          updated_at = excluded.updated_at
      `,
      )
      .run(key, String(value), isoNow(this.config.timezoneName));
  }

  public metricsGet(key: string, defaultValue: string): string {
    const row = this.db
      .prepare("SELECT metric_value FROM metrics WHERE metric_key = ?")
      .get(key) as { metric_value: string } | undefined;

    if (!row) {
      return defaultValue;
    }

    return String(row.metric_value);
  }

  public metricsIncrement(key: string, amount = 1): number {
    const current = coerceInt(this.metricsGet(key, "0"), 0) + amount;
    this.metricsSet(key, String(current));
    return current;
  }

  public buildUserMetricKey(
    userId: number | string,
    metricName: string,
  ): string {
    return `${USER_METRIC_PREFIX}${Number.parseInt(String(userId), 10)}.${metricName}`;
  }

  public getUserFunMetrics(userId: number | string): Record<string, number> {
    const keys = [
      "messages_sent",
      "reactions_sent",
      "reactions_received",
      "anonymous_answers_sent",
      "battles_played",
      "battles_won",
    ];

    const result: Record<string, number> = {};
    for (const key of keys) {
      result[key] = coerceInt(
        this.metricsGet(this.buildUserMetricKey(userId, key), "0"),
        0,
      );
    }

    return result;
  }

  public listTopUsersForMetric(
    metricName: string,
    limit = 5,
  ): Array<[number, number]> {
    const metricSuffix = metricName.trim();
    if (!metricSuffix) {
      return [];
    }

    const safeLimit = coerceInt(limit, 5, 1, 25);
    const pattern = `${USER_METRIC_PREFIX}%.${metricSuffix}`;
    const rows = this.db
      .prepare(
        "SELECT metric_key, metric_value FROM metrics WHERE metric_key LIKE ?",
      )
      .all(pattern) as MetricRow[];

    const parsed: Array<[number, number]> = [];
    const metricPattern = new RegExp(
      String.raw`^${escapeRegex(USER_METRIC_PREFIX)}(\d+)\.${escapeRegex(metricSuffix)}$`,
    );

    for (const row of rows) {
      const match = metricPattern.exec(String(row.metric_key));
      if (!match?.[1]) {
        continue;
      }

      const userId = coerceInt(match[1], 0, 1);
      const value = coerceInt(row.metric_value, 0, 0);
      if (userId <= 0 || value <= 0) {
        continue;
      }

      parsed.push([userId, value]);
    }

    parsed.sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return left[0] - right[0];
    });

    return parsed.slice(0, safeLimit);
  }

  public mergeUserMetricBackfill(
    scannedCounts: Record<number, number>,
    metricName: string,
  ): [number, number] {
    let usersSeen = 0;
    let updated = 0;

    for (const [userIdRaw, scannedValueRaw] of Object.entries(scannedCounts)) {
      const userId = coerceInt(userIdRaw, 0);
      const scannedValue = coerceInt(scannedValueRaw, 0);
      if (userId <= 0 || scannedValue <= 0) {
        continue;
      }

      usersSeen += 1;
      const metricKey = this.buildUserMetricKey(userId, metricName);
      const existingValue = coerceInt(this.metricsGet(metricKey, "0"), 0);
      const mergedValue = Math.max(existingValue, scannedValue);
      if (mergedValue > existingValue) {
        this.metricsSet(metricKey, String(mergedValue));
        updated += 1;
      }
    }

    return [usersSeen, updated];
  }

  public listPostRecords(
    includeClosed = true,
    limit: number | null = null,
  ): PostRecord[] {
    let query = "SELECT * FROM posts";
    const params: unknown[] = [];

    if (!includeClosed) {
      query += " WHERE closed = 0";
    }

    let shouldReverse = false;
    if (limit === null) {
      query += " ORDER BY posted_at ASC";
    } else {
      query += " ORDER BY posted_at DESC LIMIT ?";
      params.push(limit);
      shouldReverse = true;
    }

    const rows = this.db.prepare(query).all(...params) as PostRow[];
    const parsed = rows.map(parsePostRow);

    if (shouldReverse) {
      parsed.reverse();
    }

    return parsed;
  }

  public getPostRecord(messageId: number | string): PostRecord | null {
    const row = this.db
      .prepare("SELECT * FROM posts WHERE message_id = ?")
      .get(String(messageId)) as PostRow | undefined;
    if (!row) {
      return null;
    }
    return parsePostRow(row);
  }

  public getLatestOpenPost(): PostRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM posts WHERE closed = 0 ORDER BY posted_at DESC LIMIT 1",
      )
      .get() as PostRow | undefined;
    if (!row) {
      return null;
    }
    return parsePostRow(row);
  }

  public updatePostThreadId(
    messageId: number | string,
    threadId: number | string,
  ): void {
    const record = this.getPostRecord(messageId);
    if (!record) {
      return;
    }

    record.thread_id = String(threadId);
    this.upsertPostRow(record);
  }

  public markPostClosed(messageId: number | string, reason: string): void {
    const record = this.getPostRecord(messageId);
    if (!record) {
      return;
    }

    record.closed = true;
    record.closed_at = isoNow(this.config.timezoneName);
    record.close_reason = reason;
    this.upsertPostRow(record);
  }

  public markPostOpen(
    messageId: number | string,
    closeAfterHours: number | null = null,
  ): PostRecord | null {
    const record = this.getPostRecord(messageId);
    if (!record) {
      return null;
    }

    record.closed = false;
    record.closed_at = null;
    record.close_reason = null;
    if (closeAfterHours !== null) {
      record.close_after_hours = coerceInt(
        closeAfterHours,
        THREAD_CLOSE_HOURS,
        1,
      );
    }

    this.upsertPostRow(record);
    return record;
  }

  public setPostCloseAfterHours(
    messageId: number | string,
    closeAfterHours: number,
  ): PostRecord | null {
    const record = this.getPostRecord(messageId);
    if (!record) {
      return null;
    }

    record.close_after_hours = coerceInt(
      closeAfterHours,
      THREAD_CLOSE_HOURS,
      1,
    );
    this.upsertPostRow(record);
    return record;
  }

  public countAnswersForQuestion(questionMessageId: number | string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS c FROM answers WHERE question_message_id = ?",
      )
      .get(String(questionMessageId)) as CountRow | undefined;

    return row?.c ?? 0;
  }

  public countAllAnswerRecords(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM answers").get() as
      | CountRow
      | undefined;
    return row?.c ?? 0;
  }

  public hasUserAnswered(
    questionMessageId: number | string,
    userId: number | string,
  ): boolean {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS c FROM answers WHERE question_message_id = ? AND user_id = ?",
      )
      .get(String(questionMessageId), String(userId)) as CountRow | undefined;

    return (row?.c ?? 0) > 0;
  }

  public nextAnswerNumber(questionMessageId: number | string): number {
    return this.countAnswersForQuestion(questionMessageId) + 1;
  }

  public markUserAnswered(
    questionMessageId: number | string,
    userId: number | string,
    answerMessageId: number | string,
  ): void {
    const nowIso = isoNow(this.config.timezoneName);

    this.db
      .prepare(
        `
        INSERT INTO answers (question_message_id, user_id, answer_message_id, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(question_message_id, user_id) DO UPDATE SET
          answer_message_id = excluded.answer_message_id,
          created_at = excluded.created_at
      `,
      )
      .run(
        String(questionMessageId),
        String(userId),
        String(answerMessageId),
        nowIso,
      );

    this.db
      .prepare(
        `
        INSERT INTO anon_cooldowns (user_id, last_answer_at)
        VALUES (?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          last_answer_at = excluded.last_answer_at
      `,
      )
      .run(String(userId), nowIso);

    this.metricsIncrement(
      this.buildUserMetricKey(userId, "anonymous_answers_sent"),
    );
  }

  public getLastAnswerTimeForUser(userId: number | string): string | null {
    const row = this.db
      .prepare("SELECT last_answer_at FROM anon_cooldowns WHERE user_id = ?")
      .get(String(userId)) as CooldownRow | undefined;

    if (!row) {
      return null;
    }

    return String(row.last_answer_at);
  }

  public recordAnswerMetric(): void {
    this.metricsIncrement("answers_total");
  }

  public purgeExpiredAnswers(retentionDays: number): number {
    const effectiveDays = Math.max(1, coerceInt(retentionDays, 90, 1));
    const cutoff = DateTime.fromISO(isoNow(this.config.timezoneName))
      .minus({ days: effectiveDays })
      .toISO();
    if (!cutoff) {
      return 0;
    }

    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM answers WHERE created_at < ?")
      .get(cutoff) as CountRow | undefined;
    const removed = row?.c ?? 0;
    if (removed > 0) {
      this.db.prepare("DELETE FROM answers WHERE created_at < ?").run(cutoff);
    }

    return removed;
  }

  public findAnswerRecord(answerMessageId: string): AnswerRecordRow | null {
    const row = this.db
      .prepare(
        "SELECT question_message_id, user_id FROM answers WHERE answer_message_id = ?",
      )
      .get(String(answerMessageId)) as AnswerRecordRow | undefined;

    if (!row) {
      return null;
    }

    return {
      question_message_id: String(row.question_message_id),
      user_id: String(row.user_id),
    };
  }

  public removeAnswerRecord(answerMessageId: string): AnswerRecordRow | null {
    const match = this.findAnswerRecord(answerMessageId);
    if (!match) {
      return null;
    }

    this.db
      .prepare("DELETE FROM answers WHERE answer_message_id = ?")
      .run(String(answerMessageId));
    return match;
  }

  public recordCommandMetric(commandName: string, success = true): void {
    this.metricsIncrement(`command_usage.${commandName}`);
    if (!success) {
      this.metricsIncrement(`command_failures.${commandName}`);
    }
  }

  public recordPostMetric(
    category: string,
    source: "auto" | "manual" | "custom",
  ): void {
    this.metricsIncrement(`posts_by_category.${category}`);
    this.metricsIncrement("posts_total");

    if (source === "auto") {
      this.metricsIncrement("posts_auto");
      this.metricsSet(
        "last_successful_auto_post",
        isoNow(this.config.timezoneName),
      );
      return;
    }

    if (source === "manual") {
      this.metricsIncrement("posts_manual");
      return;
    }

    this.metricsIncrement("custom_posts");
  }

  public registerUsedQuestion(question: string): void {
    this.updateStateAtomic((state) => {
      state.history.push(question);
      if (!state.used_questions.includes(question)) {
        state.used_questions.push(question);
      }
    });
  }

  public pickQuestion(
    category: string | null,
    randomize: boolean,
    randomInt: (maxExclusive: number) => number,
  ): [string, string] {
    const questions = this.getQuestions();
    const state = this.getState();

    const recent = new Set(state.history.slice(-HISTORY_LIMIT));
    const used = new Set(state.used_questions);
    const pool: Array<[string, string]> = [];

    if (category) {
      for (const question of questions[category] ?? []) {
        pool.push([category, question]);
      }
    } else {
      for (const [categoryName, items] of Object.entries(questions)) {
        for (const question of items) {
          pool.push([categoryName, question]);
        }
      }
    }

    if (pool.length === 0) {
      throw new Error("No questions found in questions.json");
    }

    let unused = pool.filter((entry) => !used.has(entry[1]));
    if (unused.length === 0) {
      state.used_questions = [];
      this.saveState(state);
      unused = [...pool];
    }

    const filtered = unused.filter((entry) => !recent.has(entry[1]));
    const finalPool = filtered.length > 0 ? filtered : unused;

    const selectedIndex = randomize ? randomInt(finalPool.length) : 0;
    const selected = finalPool[selectedIndex] ?? finalPool[0];
    if (!selected) {
      throw new Error("No questions found in questions.json");
    }

    return selected;
  }

  public upsertPostRow(record: Partial<PostRecord>): void {
    const messageId = String(record.message_id ?? "").trim();
    const channelId = String(record.channel_id ?? "").trim();
    if (!/^\d+$/.test(messageId) || !/^\d+$/.test(channelId)) {
      return;
    }

    const threadIdRaw = String(record.thread_id ?? "").trim();
    const threadId = /^\d+$/.test(threadIdRaw) ? threadIdRaw : null;

    const values = {
      message_id: messageId,
      thread_id: threadId,
      channel_id: channelId,
      category: String(record.category ?? "unknown").trim() || "unknown",
      question:
        String(record.question ?? "Unknown question").trim() ||
        "Unknown question",
      posted_at:
        String(record.posted_at ?? isoNow(this.config.timezoneName)).trim() ||
        isoNow(this.config.timezoneName),
      close_after_hours: coerceInt(
        record.close_after_hours,
        THREAD_CLOSE_HOURS,
        1,
      ),
      closed: record.closed ? 1 : 0,
      closed_at: record.closed_at ? String(record.closed_at) : null,
      close_reason: record.close_reason ? String(record.close_reason) : null,
    };

    this.db
      .prepare(
        `
        INSERT INTO posts (
          message_id, thread_id, channel_id, category, question, posted_at,
          close_after_hours, closed, closed_at, close_reason
        ) VALUES (@message_id, @thread_id, @channel_id, @category, @question, @posted_at,
                  @close_after_hours, @closed, @closed_at, @close_reason)
        ON CONFLICT(message_id) DO UPDATE SET
          thread_id = excluded.thread_id,
          channel_id = excluded.channel_id,
          category = excluded.category,
          question = excluded.question,
          posted_at = excluded.posted_at,
          close_after_hours = excluded.close_after_hours,
          closed = excluded.closed,
          closed_at = excluded.closed_at,
          close_reason = excluded.close_reason
      `,
      )
      .run(values);
  }

  private metricsGetPrefixed(prefix: string): Record<string, number> {
    const rows = this.db
      .prepare(
        "SELECT metric_key, metric_value FROM metrics WHERE metric_key LIKE ?",
      )
      .all(`${prefix}%`) as MetricRow[];

    const result: Record<string, number> = {};
    for (const row of rows) {
      const suffix = row.metric_key.slice(prefix.length);
      if (!suffix) {
        continue;
      }
      result[suffix] = coerceInt(row.metric_value, 0, 0);
    }
    return result;
  }

  private dbHasKey(key: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS one FROM kv WHERE key = ?")
      .get(key) as { one: number } | undefined;
    return Boolean(row);
  }

  private dbGetJson(key: string, defaultValue: unknown): unknown {
    const row = this.db
      .prepare("SELECT value FROM kv WHERE key = ?")
      .get(key) as JsonRow | undefined;
    if (!row) {
      this.dbSetJson(key, defaultValue);
      return defaultValue;
    }

    try {
      return JSON.parse(row.value);
    } catch {
      this.dbSetJson(key, defaultValue);
      return defaultValue;
    }
  }

  private dbSetJson(key: string, data: unknown): void {
    const payload = JSON.stringify(data, null, 2);

    this.db
      .prepare(
        `
        INSERT INTO kv (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
      )
      .run(key, payload, isoNow(this.config.timezoneName));
  }

  private maybeMigrateJsonFiles(): void {
    for (const [fileName, key] of Object.entries(STORAGE_JSON_KEYS)) {
      if (this.dbHasKey(key)) {
        continue;
      }

      const filePath = path.join(this.repoRoot, fileName);
      if (!fs.existsSync(filePath)) {
        continue;
      }

      try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (typeof parsed === "object" && parsed !== null) {
          this.dbSetJson(key, parsed);
        }
      } catch {
        continue;
      }
    }
  }

  private migrateStructuredTables(): void {
    const postsCount = this.readCount("SELECT COUNT(*) AS c FROM posts");
    const answersCount = this.readCount("SELECT COUNT(*) AS c FROM answers");
    const metricsCount = this.readCount("SELECT COUNT(*) AS c FROM metrics");

    const state = this.dbGetJson("state", {}) as Record<string, unknown>;

    if (postsCount === 0) {
      const posts = Array.isArray(state.posts) ? state.posts : [];
      for (const post of posts) {
        if (typeof post === "object" && post !== null) {
          this.upsertPostRow(post as Partial<PostRecord>);
        }
      }
    }

    const legacyAnswers = this.dbGetJson("answers", {});
    if (
      answersCount === 0 &&
      typeof legacyAnswers === "object" &&
      legacyAnswers !== null
    ) {
      this.migrateAnswersFromLegacyBlob(
        legacyAnswers as Record<string, unknown>,
      );
    }

    if (metricsCount === 0) {
      const flattened = flattenMetricsForStorage(state.metrics ?? {});
      for (const [metricKey, metricValue] of Object.entries(flattened)) {
        this.metricsSet(metricKey, metricValue);
      }
    }
  }

  private migrateAnswersFromLegacyBlob(
    legacyAnswers: Record<string, unknown>,
  ): void {
    const upsert = this.db.prepare(
      `
      INSERT INTO answers (question_message_id, user_id, answer_message_id, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(question_message_id, user_id) DO UPDATE SET
        answer_message_id = excluded.answer_message_id,
        created_at = excluded.created_at
    `,
    );

    for (const [questionMessageId, bucketRaw] of Object.entries(
      legacyAnswers,
    )) {
      if (typeof bucketRaw !== "object" || bucketRaw === null) {
        continue;
      }
      const usersRaw = (bucketRaw as Record<string, unknown>).users;
      if (typeof usersRaw !== "object" || usersRaw === null) {
        continue;
      }

      for (const [userId, answerRaw] of Object.entries(
        usersRaw as Record<string, unknown>,
      )) {
        if (typeof answerRaw !== "object" || answerRaw === null) {
          continue;
        }

        const answer = answerRaw as Record<string, unknown>;
        const answerMessageId =
          toOptionalScalarString(answer.answer_message_id) ?? "";
        const createdAt =
          toOptionalScalarString(answer.created_at) ??
          isoNow(this.config.timezoneName);
        upsert.run(
          String(questionMessageId),
          String(userId),
          answerMessageId,
          createdAt,
        );
      }
    }
  }

  private readCount(sql: string): number {
    const row = this.db.prepare(sql).get() as CountRow | undefined;
    return row?.c ?? 0;
  }

  private defaultStatePayload(): CourtState {
    return {
      mode: "manual",
      hour: 20,
      minute: 0,
      channel_id: this.config.courtChannelId,
      log_channel_id: this.config.logChannelId,
      last_posted_date: null,
      dry_run_auto_post: false,
      last_dry_run_date: null,
      last_weekly_digest_week: null,
      history: [],
      used_questions: [],
      royal_presence: ensureRoyalPresenceShape({}),
      royal_afk: ensureRoyalAfkShape({}),
      posts: [],
      metrics: ensureMetricsShape({}),
    };
  }
}

function parsePostRow(row: PostRow): PostRecord {
  return {
    message_id: String(row.message_id),
    thread_id: row.thread_id === null ? null : String(row.thread_id),
    channel_id: String(row.channel_id),
    category: String(row.category),
    question: String(row.question),
    posted_at: String(row.posted_at),
    close_after_hours: coerceInt(row.close_after_hours, THREAD_CLOSE_HOURS, 1),
    closed: Boolean(row.closed),
    closed_at: row.closed_at === null ? null : String(row.closed_at),
    close_reason: row.close_reason === null ? null : String(row.close_reason),
  };
}

function dedupeStrings(values: string[]): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    deduped.push(value);
  }

  return deduped;
}

function escapeRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function toOptionalScalarString(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  return null;
}
