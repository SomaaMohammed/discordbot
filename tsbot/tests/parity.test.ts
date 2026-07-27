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
  parseSuperiorChatIntent,
} from "../src/parity.js";
import type { CourtState } from "../src/types.js";

function baseState(): CourtState {
  return {
    last_posted_date: null,
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
    expect(extractRolePanelRoleId(["RolePanelTarget:123456789012345678"])).toBe(
      "123456789012345678",
    );
    expect(
      extractRolePanelRoleIdForSlot(
        [
          "RolePanelTargets:1=111111111111111111,2=222222222222222222,3=333333333333333333",
        ],
        2,
      ),
    ).toBe("222222222222222222");
    expect(
      extractRolePanelRoleIdForSlot(
        [
          "RolePanelTargets:1=111111111111111111,2=222222222222222222,3=333333333333333333",
        ],
        4,
      ),
    ).toBeNull();
  });

  it("parses role panel button slot", () => {
    expect(extractRolePanelButtonSlot("court:role_panel_claim")).toBe(1);
    expect(extractRolePanelButtonSlot("court:role_panel_claim:2")).toBe(2);
    expect(extractRolePanelButtonSlot("court:role_panel_claim:5")).toBe(5);
    expect(extractRolePanelButtonSlot("court:role_panel_claim:6")).toBeNull();
    expect(extractRolePanelButtonSlot("court:other")).toBeNull();
  });

  it("builds and parses role panel custom IDs with role metadata", () => {
    const customId = buildRolePanelButtonCustomId("123456789012345678");

    expect(customId).toBe("court:role_panel_claim:role:123456789012345678");
    expect(buildRolePanelButtonCustomId("bad-role-id")).toBe(
      "court:role_panel_claim",
    );
    expect(extractRolePanelRoleIdFromCustomId(customId)).toBe(
      "123456789012345678",
    );
    expect(
      extractRolePanelRoleIdFromCustomId("court:role_panel_claim:2"),
    ).toBeNull();
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

    expect(merged).not.toHaveProperty("mode");
    expect(merged).not.toHaveProperty("channel_id");
    expect(merged).not.toHaveProperty("dry_run_auto_post");
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
    expect(isEmperorLockTrigger("The Sun King has arrived", "Sun King")).toBe(
      true,
    );
    expect(isSilenceLockTrigger("order in the court.")).toBe(true);
    expect(hasEmperorMention("where is sammy")).toBe(false);
    expect(hasEmperorMention("where is the sun king", "Sun King")).toBe(true);
    expect(hasEmpressMention("Her Majesty will arrive shortly")).toBe(true);
    expect(parseRoyalMentions("The Emperor and Empress have entered")).toEqual([
      "Emperor",
      "Empress",
    ]);
  });

  it("parses reply mute trigger", () => {
    expect(parseReplyMuteMessage("superior mute @user being loud")).toBe(
      "@user being loud",
    );
    expect(parseReplyMuteMessage("hello there")).toBeNull();
    expect(
      parseReplyMuteMessage("court oracle: mute @user too loud", [
        "court oracle",
      ]),
    ).toBe("@user too loud");
    expect(
      parseReplyMuteMessage("oracle.v2+: mute @user", ["oracle.v2+"]),
    ).toBe("@user");
  });

  it.each([
    ["hi superior", "greeting"],
    ["Superior, howdy!", "greeting"],
    ["superior what can you do", "help"],
    ["superior show me the commands", "help"],
    ["superior options", "help"],
    ["superior can you toss a coin", "coinflip"],
    ["superior tell me the time", "time"],
    ["thanks superior", "thanks"],
    ["superior, much appreciated", "thanks"],
    ["good night superior", "farewell"],
    ["superior cya", "farewell"],
    ["superior are you online", "ping"],
    ["superior response time", "ping"],
    ["superior how long have you been running", "uptime"],
    ["superior when did you start", "uptime"],
    ["superior who are you", "about"],
    ["superior what version", "about"],
  ])("parses Superior chat phrase %s", (content, type) => {
    expect(parseSuperiorChatIntent(content)).toEqual({ type });
  });

  it("parses bounded dice requests", () => {
    expect(parseSuperiorChatIntent("superior roll dice")).toEqual({
      type: "dice",
      count: 1,
      sides: 6,
    });
    expect(parseSuperiorChatIntent("superior, d20")).toEqual({
      type: "dice",
      count: 1,
      sides: 20,
    });
    expect(parseSuperiorChatIntent("superior roll 2d100")).toEqual({
      type: "dice",
      count: 2,
      sides: 100,
    });
    expect(parseSuperiorChatIntent("superior roll 21d6")).toEqual({
      type: "invalid",
      utility: "dice",
      error: "dice_count",
    });
    expect(parseSuperiorChatIntent("superior roll d1")).toEqual({
      type: "invalid",
      utility: "dice",
      error: "dice_sides",
    });
    expect(parseSuperiorChatIntent("superior roll d1001")).toEqual({
      type: "invalid",
      utility: "dice",
      error: "dice_sides",
    });
    expect(parseSuperiorChatIntent("superior roll bananas")).toEqual({
      type: "invalid",
      utility: "dice",
      error: "dice_format",
    });
  });

  it("parses bounded choices while preserving their display text", () => {
    expect(
      parseSuperiorChatIntent("superior choose Red Team or Blue Team"),
    ).toEqual({
      type: "choice",
      options: ["Red Team", "Blue Team"],
    });
    expect(
      parseSuperiorChatIntent("superior pick red, RED, green, or blue"),
    ).toEqual({
      type: "choice",
      options: ["RED", "green", "blue"],
    });
    expect(parseSuperiorChatIntent("superior choose only-one")).toEqual({
      type: "invalid",
      utility: "choice",
      error: "choice_count",
    });
    expect(
      parseSuperiorChatIntent(
        `superior choose ${Array.from({ length: 21 }, (_, index) => `option-${index}`).join(" | ")}`,
      ),
    ).toEqual({
      type: "invalid",
      utility: "choice",
      error: "choice_count",
    });
    expect(
      parseSuperiorChatIntent(
        `superior choose ${"a".repeat(101)} or something else`,
      ),
    ).toEqual({
      type: "invalid",
      utility: "choice",
      error: "choice_length",
    });
  });

  it("requires direct address and preserves configurable invocation terms", () => {
    expect(parseSuperiorChatIntent("This is a superior choice")).toBeNull();
    expect(parseSuperiorChatIntent("hello there")).toBeNull();
    expect(parseSuperiorChatIntent("superior mute @user")).toBeNull();
    expect(parseSuperiorChatIntent("superior mute for ping spam")).toBeNull();
    expect(
      parseSuperiorChatIntent("superior timeout because they need help"),
    ).toBeNull();
    expect(
      parseSuperiorChatIntent("superior mute for saying goodbye"),
    ).toBeNull();
    expect(parseReplyMuteMessage("superior mute for ping spam")).toBe(
      "for ping spam",
    );
    expect(parseSuperiorChatIntent("superior status report")).toBeNull();
    expect(parseSuperiorChatIntent("superior what should i do")).toBeNull();
    expect(parseSuperiorChatIntent("superior title me")).toBeNull();
    expect(
      parseSuperiorChatIntent("court oracle, ping", ["court oracle"]),
    ).toEqual({ type: "ping" });
    expect(
      parseSuperiorChatIntent("oracle.v2+: roll d20", ["oracle.v2+"]),
    ).toEqual({ type: "dice", count: 1, sides: 20 });
    expect(
      parseSuperiorChatIntent("<@123456789012345678> uptime", [
        "<@123456789012345678>",
      ]),
    ).toEqual({ type: "uptime" });
  });

  it("accepts an explicitly persisted Invictus invocation term", () => {
    expect(
      parseReplyMuteMessage("invictus mute @user being loud", ["invictus"]),
    ).toBe("@user being loud");
    expect(parseSuperiorChatIntent("invictus help", ["invictus"])).toEqual({
      type: "help",
    });
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

    const response = getRoyalAfkResponse(
      "Where is the emperor?",
      afkShape,
      now,
    );
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
