import { describe, expect, it } from "vitest";
import {
  CONVERSATION_MAX_CHOICES,
  REPLY_MODERATION_MAX_REASON_LENGTH,
  normalizeConversationText,
  parseConversationIntent,
  parseReplyModerationRequest,
  type SimpleConversationIntentType,
} from "../src/conversation.js";

const BOT_ID = "345678901234567890";

describe("conversation normalization", () => {
  it("uses NFKC and canonicalizes curly contractions and punctuation", () => {
    expect(normalizeConversationText("  Ｈｏｗ’ｓ… it GOING?! 👋  ")).toBe(
      "hows it going",
    );
    expect(normalizeConversationText("what's\tup")).toBe("whats up");
  });
});

describe("conversation intent recognition", () => {
  const positives: ReadonlyArray<
    readonly [SimpleConversationIntentType, string]
  > = [
    ["greeting", "hi"],
    ["greeting", "hey"],
    ["greeting", "hello"],
    ["greeting", "yo"],
    ["greeting", "sup"],
    ["greeting", "gm"],
    ["greeting", "good morning"],
    ["greeting", "good afternoon"],
    ["greeting", "good evening"],
    ["wellbeing", "wsp"],
    ["wellbeing", "wsg"],
    ["wellbeing", "wassup"],
    ["wellbeing", "what's up"],
    ["wellbeing", "whats up"],
    ["wellbeing", "how are you"],
    ["wellbeing", "how r u"],
    ["wellbeing", "how are u"],
    ["wellbeing", "hru"],
    ["wellbeing", "how you doing"],
    ["wellbeing", "how u doing"],
    ["wellbeing", "how’s it going"],
    ["activity", "what are you doing"],
    ["activity", "what r u doing"],
    ["activity", "wyd"],
    ["help", "help"],
    ["help", "commands"],
    ["help", "cmds"],
    ["help", "command list"],
    ["help", "what can you do"],
    ["help", "what can u do"],
    ["help", "how do i use you"],
    ["help", "how do i use this"],
    ["thanks", "thanks"],
    ["thanks", "thank you"],
    ["thanks", "thx"],
    ["thanks", "ty"],
    ["thanks", "tysm"],
    ["thanks", "appreciate it"],
    ["farewell", "bye"],
    ["farewell", "goodbye"],
    ["farewell", "cya"],
    ["farewell", "see ya"],
    ["farewell", "later"],
    ["farewell", "gtg"],
    ["farewell", "goodnight"],
    ["farewell", "gn"],
    ["ping", "ping"],
    ["ping", "pong"],
    ["ping", "latency"],
    ["ping", "are you online"],
    ["ping", "r u online"],
    ["ping", "are you alive"],
    ["ping", "you there"],
    ["uptime", "uptime"],
    ["uptime", "how long have you been up"],
    ["uptime", "how long u been up"],
    ["about", "who are you"],
    ["about", "who r u"],
    ["about", "what are you"],
    ["about", "version"],
    ["about", "ver"],
    ["time", "what time is it"],
    ["time", "whats the time"],
    ["time", "what time rn"],
    ["time", "time now"],
  ];

  it.each(positives)("recognizes %s from %s", (type, phrase) => {
    expect(parseConversationIntent(`superior ${phrase}`)).toEqual({ type });
  });

  it("handles case, punctuation, emoji, full-width text, and polite prefixes", () => {
    expect(parseConversationIntent("👋 HEY, SUPERIOR: WＹＤ?! 👋")).toEqual({
      type: "activity",
    });
    expect(parseConversationIntent("superior, please what time rn?")).toEqual({
      type: "time",
    });
    expect(parseConversationIntent("ＳＵＰＥＲＩＯＲ　ＨＲＵ")).toEqual({
      type: "wellbeing",
    });
    expect(parseConversationIntent("Superior!")).toEqual({
      type: "greeting",
    });
  });

  it("accepts only leading or trailing configured addresses and exact mentions", () => {
    const options = {
      invocationTerms: ["helper", "helper prime"],
      botUserId: BOT_ID,
    } as const;

    expect(parseConversationIntent("hey helper prime, wyd?", options)).toEqual({
      type: "activity",
    });
    expect(parseConversationIntent("gn, helper prime", options)).toEqual({
      type: "farewell",
    });
    expect(parseConversationIntent(`<@${BOT_ID}> cmds`, options)).toEqual({
      type: "help",
    });
    expect(
      parseConversationIntent(`what time rn <@!${BOT_ID}>`, options),
    ).toEqual({ type: "time" });
    expect(
      parseConversationIntent("oracle.v2+: hru", {
        invocationTerms: ["oracle.v2+"],
      }),
    ).toEqual({ type: "wellbeing" });

    expect(
      parseConversationIntent(
        "I think helper prime has useful commands",
        options,
      ),
    ).toBeNull();
    expect(
      parseConversationIntent(`please tell <@${BOT_ID}> to ping`, options),
    ).toBeNull();
    expect(
      parseConversationIntent("helper primes are useful", options),
    ).toBeNull();
  });

  it("accepts a caller-verified reply to the bot without an invocation", () => {
    expect(parseConversationIntent("wsp", { replyToBot: true })).toEqual({
      type: "wellbeing",
    });
    expect(parseConversationIntent("wsp", { replyToBot: false })).toBeNull();
    expect(
      parseConversationIntent("unrelated conversation", { replyToBot: true }),
    ).toBeNull();
  });

  it.each([
    "shipping update",
    "campaign status",
    "commandship",
    "helpful",
    "pingdom",
    "what should i do",
    "status report",
    "how are unicorns",
    "thanks and goodbye",
    "who are you doing",
  ])("does not use substring or broad fuzzy matching for %s", (request) => {
    expect(parseConversationIntent(`superior ${request}`)).toBeNull();
  });

  it("uses explicit precedence for exact overlapping concepts", () => {
    expect(parseConversationIntent("superior what are you doing")).toEqual({
      type: "activity",
    });
    expect(parseConversationIntent("superior what are you")).toEqual({
      type: "about",
    });
    expect(parseConversationIntent("superior are you online")).toEqual({
      type: "ping",
    });
    expect(
      parseConversationIntent("superior how long have you been online"),
    ).toEqual({ type: "uptime" });
  });

  it("recognizes coin flips without swallowing unrelated choice text", () => {
    expect(parseConversationIntent("superior flip a coin")).toEqual({
      type: "coinflip",
    });
    expect(parseConversationIntent("superior coin collector")).toBeNull();
  });
});

describe("bounded conversation arguments", () => {
  it("parses bounded dice forms and reports each invalid bound", () => {
    expect(parseConversationIntent("superior d20")).toEqual({
      type: "dice",
      count: 1,
      sides: 20,
    });
    expect(parseConversationIntent("superior roll 2d100")).toEqual({
      type: "dice",
      count: 2,
      sides: 100,
    });
    expect(parseConversationIntent("superior roll dice")).toEqual({
      type: "dice",
      count: 1,
      sides: 6,
    });
    expect(parseConversationIntent("superior roll 21d6")).toEqual({
      type: "invalid",
      utility: "dice",
      error: "dice_count",
    });
    expect(parseConversationIntent("superior roll d1")).toEqual({
      type: "invalid",
      utility: "dice",
      error: "dice_sides",
    });
    expect(parseConversationIntent("superior roll d1001")).toEqual({
      type: "invalid",
      utility: "dice",
      error: "dice_sides",
    });
    expect(parseConversationIntent("superior roll bananas")).toEqual({
      type: "invalid",
      utility: "dice",
      error: "dice_format",
    });
  });

  it("preserves display choices while deduplicating and enforcing limits", () => {
    expect(
      parseConversationIntent(
        "superior choose **Admin** or <@123456789012345678>?",
      ),
    ).toEqual({
      type: "choice",
      options: ["**Admin**", "<@123456789012345678>"],
    });
    expect(
      parseConversationIntent("superior pick red, RED, green, or blue"),
    ).toEqual({
      type: "choice",
      options: ["red", "green", "blue"],
    });
    expect(parseConversationIntent("superior choose only-one")).toEqual({
      type: "invalid",
      utility: "choice",
      error: "choice_count",
    });
    expect(
      parseConversationIntent(`superior choose ${"a".repeat(101)} or short`),
    ).toEqual({
      type: "invalid",
      utility: "choice",
      error: "choice_length",
    });
    const tooMany = Array.from(
      { length: CONVERSATION_MAX_CHOICES + 1 },
      (_, index) => `choice-${index}`,
    ).join(" or ");
    expect(parseConversationIntent(`superior choose ${tooMany}`)).toEqual({
      type: "invalid",
      utility: "choice",
      error: "choice_count",
    });
  });
});

describe("reply moderation recognition", () => {
  it("wins over casual intents and preserves a bounded raw reason", () => {
    expect(parseReplyModerationRequest("superior mute for ping spam")).toEqual({
      type: "timeout",
      reason: "for ping spam",
    });
    expect(
      parseReplyModerationRequest("hey superior, timeout: needs a break"),
    ).toEqual({ type: "timeout", reason: "needs a break" });
    expect(parseReplyModerationRequest("superior, u know what to do")).toEqual({
      type: "timeout",
      reason: "",
    });
    expect(
      parseConversationIntent("superior mute for saying goodbye"),
    ).toBeNull();
    expect(
      parseConversationIntent("superior timeout because they need help"),
    ).toBeNull();
  });

  it("requires direct address and rejects overlong reasons explicitly", () => {
    expect(parseReplyModerationRequest("mute them for ping spam")).toBeNull();
    expect(
      parseReplyModerationRequest("mute them", { replyToBot: true }),
    ).toEqual({ type: "timeout", reason: "" });
    expect(
      parseReplyModerationRequest(
        `superior mute ${"x".repeat(REPLY_MODERATION_MAX_REASON_LENGTH + 1)}`,
      ),
    ).toEqual({
      type: "invalid",
      error: "reason_length",
      maximumLength: REPLY_MODERATION_MAX_REASON_LENGTH,
    });
  });
});
