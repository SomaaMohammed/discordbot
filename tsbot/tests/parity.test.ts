import { DateTime } from "luxon";
import {
  DEFAULT_BACKFILL_STATUS,
  backfillLookbackText,
  buildRolePanelButtonCustomId,
  buildRoyalAfkStatusReport,
  countOpenAndOverduePosts,
  ensureRoyalAfkShape,
  extractRolePanelButtonSlot,
  extractRolePanelRoleId,
  extractRolePanelRoleIdFromCustomId,
  extractRolePanelRoleIdForSlot,
  flattenMetricsForStorage,
  getFateReading,
  getRoyalAfkResponse,
  hasEmperorMention,
  hasEmpressMention,
  isEmperorLockTrigger,
  isSilenceLockTrigger,
  markBackfillFinished,
  markBackfillStarted,
  mergeImportedState,
  normalizeQuestionText,
  parseReplyMuteMessage,
  parseRoyalMentions,
} from "../src/parity.js";
import type { CourtState } from "../src/types.js";

function baseState(): CourtState {
  return {
    mode: "manual",
    hour: 20,
    minute: 0,
    channel_id: 123,
    log_channel_id: 456,
    last_posted_date: null,
    dry_run_auto_post: false,
    last_dry_run_date: null,
    last_weekly_digest_week: null,
    history: [],
    used_questions: [],
    posts: [],
    metrics: {
      command_usage: {},
      command_failures: {},
      posts_by_category: {},
      posts_total: 0,
      posts_auto: 0,
      posts_manual: 0,
      custom_posts: 0,
      answers_total: 0,
      last_successful_auto_post: null,
    },
    royal_presence: {
      last_message_at_by_title: {
        Emperor: null,
        Empress: null,
      },
      last_message_at: null,
      last_speaker: null,
    },
    royal_afk: ensureRoyalAfkShape({}),
  };
}

describe("parity helpers", () => {
  it("normalizes question text", () => {
    expect(normalizeQuestionText("  hello   world  ")).toBe("hello world");
  });

  it("extracts role panel ids from single and multi footer", () => {
    expect(extractRolePanelRoleId(["RolePanelTarget:123456789"])).toBe(123456789);
    expect(extractRolePanelRoleIdForSlot(["RolePanelTargets:1=111,2=222,3=333"], 2)).toBe(222);
    expect(extractRolePanelRoleIdForSlot(["RolePanelTargets:1=111,2=222,3=333"], 4)).toBeNull();
  });

  it("parses role panel button slot", () => {
    expect(extractRolePanelButtonSlot("court:role_panel_claim")).toBe(1);
    expect(extractRolePanelButtonSlot("court:role_panel_claim:2")).toBe(2);
    expect(extractRolePanelButtonSlot("court:role_panel_claim:5")).toBe(5);
    expect(extractRolePanelButtonSlot("court:role_panel_claim:6")).toBeNull();
    expect(extractRolePanelButtonSlot("court:other")).toBeNull();
  });

  it("builds and parses role panel custom IDs with role metadata", () => {
    const customId = buildRolePanelButtonCustomId("123456789");

    expect(customId).toBe("court:role_panel_claim:role:123456789");
    expect(buildRolePanelButtonCustomId("bad-role-id")).toBe("court:role_panel_claim");
    expect(extractRolePanelRoleIdFromCustomId(customId)).toBe("123456789");
    expect(extractRolePanelRoleIdFromCustomId("court:role_panel_claim:2")).toBeNull();
  });

  it("formats fate reading bands", () => {
    expect(getFateReading(5)[0]).toBe("Dire Omen");
    expect(getFateReading(25)[0]).toBe("Trial Ahead");
    expect(getFateReading(50)[0]).toBe("Balanced Winds");
    expect(getFateReading(80)[0]).toBe("Favorable Tide");
    expect(getFateReading(99)[0]).toBe("Imperial Blessing");
    expect(getFateReading(-10)).toEqual(getFateReading(1));
    expect(getFateReading(500)).toEqual(getFateReading(100));
  });

  it("counts open and overdue posts", () => {
    const now = DateTime.utc();
    const posts = [
      {
        message_id: "1",
        thread_id: null,
        channel_id: "1",
        category: "general",
        question: "A",
        posted_at: now.minus({ hours: 25 }).toISO() ?? now.toISO() ?? "",
        close_after_hours: 24,
        closed: false,
        closed_at: null,
        close_reason: null,
      },
      {
        message_id: "2",
        thread_id: null,
        channel_id: "1",
        category: "general",
        question: "B",
        posted_at: now.minus({ hours: 1 }).toISO() ?? now.toISO() ?? "",
        close_after_hours: 24,
        closed: false,
        closed_at: null,
        close_reason: null,
      },
      {
        message_id: "3",
        thread_id: null,
        channel_id: "1",
        category: "general",
        question: "C",
        posted_at: now.minus({ hours: 26 }).toISO() ?? now.toISO() ?? "",
        close_after_hours: 24,
        closed: true,
        closed_at: now.toISO() ?? null,
        close_reason: "manual",
      },
    ];

    const [openCount, overdueCount] = countOpenAndOverduePosts(posts, now);
    expect(openCount).toBe(2);
    expect(overdueCount).toBe(1);
  });

  it("flattens metrics and sanitizes invalid values", () => {
    const flattened = flattenMetricsForStorage({
      posts_total: "bad",
      posts_auto: "3",
      posts_manual: -2,
      custom_posts: null,
      answers_total: "bad",
      command_usage: { "court.status": "7", "": 4 },
      command_failures: { "court.post": "oops" },
      posts_by_category: { general: "x" },
    });

    expect(flattened.posts_total).toBe("0");
    expect(flattened.posts_auto).toBe("3");
    expect(flattened.posts_manual).toBe("0");
    expect(flattened.custom_posts).toBe("0");
    expect(flattened.answers_total).toBe("0");
    expect(flattened["command_usage.court.status"]).toBe("7");
    expect(flattened["command_usage."]).toBeUndefined();
    expect(flattened["command_failures.court.post"]).toBe("0");
    expect(flattened["posts_by_category.general"]).toBe("0");
  });

  it("merges imported state and sanitizes values", () => {
    const merged = mergeImportedState(
      {
        mode: "invalid",
        hour: 99,
        minute: -5,
        channel_id: "bad-channel",
        log_channel_id: "bad-log",
        dry_run_auto_post: "yes",
        history: ["", "  first  ", 42, "second"],
        used_questions: ["same", "same", "other", null],
        posts: [
          { message_id: "1", channel_id: "2", question: "ok" },
          { message_id: "bad", channel_id: "2", question: "skip" },
        ],
        metrics: {
          posts_total: "oops",
          command_usage: { "court.status": "9", "": 3 },
        },
        royal_presence: { last_message_at_by_title: { Emperor: "x" } },
        royal_afk: { by_title: { Empress: { active: 1, reason: "Away" } } },
      },
      baseState(),
      123,
    );

    expect(merged.mode).toBe("manual");
    expect(merged.hour).toBe(23);
    expect(merged.minute).toBe(0);
    expect(merged.channel_id).toBe(123);
    expect(merged.log_channel_id).toBe(456);
    expect(merged.dry_run_auto_post).toBe(true);
    expect(merged.history).toEqual(["first", "second"]);
    expect(merged.used_questions).toEqual(["same", "other"]);
    expect(merged.posts).toHaveLength(1);
    expect(merged.posts[0]?.message_id).toBe("1");
    expect(merged.metrics.command_usage["court.status"]).toBe(9);
    expect(merged.royal_presence.last_message_at_by_title.Emperor).toBe("x");
    expect(merged.royal_presence.last_message_at_by_title.Empress).toBeNull();
    expect(merged.royal_afk.by_title.Empress.active).toBe(true);
  });

  it("matches lock and mention phrases", () => {
    expect(isEmperorLockTrigger("The Emperor is here")).toBe(true);
    expect(isSilenceLockTrigger("order in the court.")).toBe(true);
    expect(hasEmperorMention("where is sammy")).toBe(true);
    expect(hasEmpressMention("Her Majesty will arrive shortly")).toBe(true);
    expect(parseRoyalMentions("The Emperor and Empress have entered")).toEqual(["Emperor", "Empress"]);
  });

  it("parses reply mute trigger", () => {
    expect(parseReplyMuteMessage("invictus mute @user being loud")).toBe("@user being loud");
    expect(parseReplyMuteMessage("hello there")).toBeNull();
  });

  it("handles AFK response and reporting", () => {
    const now = DateTime.utc();
    const afkShape = ensureRoyalAfkShape({
      by_title: {
        Emperor: {
          active: true,
          reason: "At war council",
          set_at: now.minus({ minutes: 90 }).toISO(),
          set_by_user_id: "123",
        },
      },
    });

    const response = getRoyalAfkResponse("Where is the emperor?", afkShape, now);
    expect(response).toContain("The Emperor is currently AFK");
    expect(response).toContain("At war council");

    const report = buildRoyalAfkStatusReport(afkShape, now);
    expect(report).toContain("**Emperor:** AFK for");
  });

  it("handles backfill status helpers", () => {
    const state = { ...DEFAULT_BACKFILL_STATUS };
    const startedAt = DateTime.utc().toISO() ?? "";
    markBackfillStarted(state, 123, 7, startedAt);

    expect(state.running).toBe(true);
    expect(state.initiated_by_user_id).toBe("123");
    expect(backfillLookbackText(state.lookback_days)).toBe("last 7 day(s)");

    const finishedAt = DateTime.utc().plus({ minutes: 5 }).toISO() ?? "";
    markBackfillFinished(state, "completed", finishedAt, "done", null);

    expect(state.running).toBe(false);
    expect(state.last_status).toBe("completed");
    expect(state.last_summary).toBe("done");
  });
});
