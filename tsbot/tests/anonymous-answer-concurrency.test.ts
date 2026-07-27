import { DateTime } from "luxon";
import { describe, expect, it, vi } from "vitest";
import type { GuildMember, Message, ModalSubmitInteraction } from "discord.js";
import { handleModalSubmitInteraction } from "../src/discord/commands.js";
import { createDefaultGuildSettings } from "../src/guild-settings.js";
import type { BotRuntime, GuildRuntime } from "../src/runtime.js";
import type { PostRecord } from "../src/types.js";

const GUILD_ID = "123456789012345678";
const CHANNEL_ID = "234567890123456789";
const MESSAGE_ID = "345678901234567890";
const SECOND_MESSAGE_ID = "345678901234567891";
const USER_ID = "456789012345678901";
const BOT_ID = "567890123456789012";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createFixture(): {
  runtime: BotRuntime;
  createInteraction: (questionMessageId?: string) => {
    interaction: ModalSubmitInteraction;
    reply: ReturnType<typeof vi.fn>;
    deferReply: ReturnType<typeof vi.fn>;
    editReply: ReturnType<typeof vi.fn>;
  };
  send: ReturnType<typeof vi.fn>;
  sendStarted: Promise<void>;
  finishSend: () => void;
  deleteSent: ReturnType<typeof vi.fn>;
  hasUserAnswered: ReturnType<typeof vi.fn>;
  markUserAnswered: ReturnType<typeof vi.fn>;
  recordAnswerMetric: ReturnType<typeof vi.fn>;
  answerRows: Set<string>;
  setCurrent: (current: boolean) => void;
  setClosed: (closed: boolean) => void;
} {
  let current = true;
  const answerRows = new Set<string>();
  let lastAnswerAt: string | null = null;
  const sendStarted = deferred<void>();
  const sentMessage = deferred<Message>();
  const deleteSent = vi.fn(async () => undefined);
  const sent = {
    id: "678901234567890123",
    delete: deleteSent,
  } as unknown as Message;
  const send = vi.fn(async () => {
    sendStarted.resolve();
    return sentMessage.promise;
  });
  const createThread = (id: string) => ({
    id,
    locked: false,
    isThread: () => true,
    send,
    toString: () => `<#${id}>`,
  });
  const threads = new Map([
    [MESSAGE_ID, createThread(MESSAGE_ID)],
    [SECOND_MESSAGE_ID, createThread(SECOND_MESSAGE_ID)],
  ]);
  const createPost = (messageId: string): PostRecord => ({
    message_id: messageId,
    thread_id: messageId,
    channel_id: CHANNEL_ID,
    category: "general",
    question: `What should the court decide for ${messageId}?`,
    posted_at: "2026-07-27T12:00:00.000Z",
    close_after_hours: 24,
    closed: false,
    closed_at: null,
    close_reason: null,
  });
  const posts = new Map([
    [MESSAGE_ID, createPost(MESSAGE_ID)],
    [SECOND_MESSAGE_ID, createPost(SECOND_MESSAGE_ID)],
  ]);
  const answerKey = (questionMessageId: string, userId: string): string =>
    `${questionMessageId}:${userId}`;
  const hasUserAnswered = vi.fn((questionMessageId: string, userId: string) =>
    answerRows.has(answerKey(questionMessageId, userId)),
  );
  const markUserAnswered = vi.fn(
    (questionMessageId: string, userId: string) => {
      answerRows.add(answerKey(questionMessageId, userId));
      lastAnswerAt = new Date().toISOString();
    },
  );
  const recordAnswerMetric = vi.fn();
  const storage = {
    getPostRecord: vi.fn((messageId: string) => posts.get(messageId) ?? null),
    getLastAnswerTimeForUser: vi.fn(() => lastAnswerAt),
    hasUserAnswered,
    nextAnswerNumber: vi.fn(
      (questionMessageId: string) =>
        [...answerRows].filter((key) => key.startsWith(`${questionMessageId}:`))
          .length + 1,
    ),
    markUserAnswered,
    recordAnswerMetric,
    updatePostThreadId: vi.fn(),
  } as unknown as GuildRuntime["storage"];

  const settings = createDefaultGuildSettings();
  settings.enabled = true;
  settings.features.court = true;
  settings.features.anonymousAnswers = true;
  settings.courtSchedule.mode = "manual";
  settings.channels.court = CHANNEL_ID;

  const guildRuntime = {
    guildId: GUILD_ID,
    botVersion: "2.0.1-test",
    storage,
    settings,
    backfillStatus: {},
    generation: 0,
    now: () => DateTime.fromISO("2026-07-27T12:00:00.000Z"),
    randomInt: () => 0,
    isCurrent: () => current,
  } as unknown as GuildRuntime;
  const runtime = {
    forGuild: vi.fn(async () => guildRuntime),
  } as unknown as BotRuntime;

  const member = {
    id: USER_ID,
    user: {
      id: USER_ID,
      bot: false,
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
    },
    joinedAt: new Date("2020-01-01T00:00:00.000Z"),
    roles: { cache: { has: vi.fn(() => false) } },
  } as unknown as GuildMember;
  const guild = {
    id: GUILD_ID,
    members: { fetch: vi.fn(async () => member) },
    channels: { cache: threads },
  };
  const createSourceMessage = (questionMessageId: string) =>
    ({
      id: questionMessageId,
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      guild,
      author: { id: BOT_ID },
      embeds: [
        {
          description: `**Question:** What should the court decide for ${questionMessageId}?`,
        },
      ],
    }) as unknown as Message;

  return {
    runtime,
    createInteraction: (questionMessageId = MESSAGE_ID) => {
      const reply = vi.fn(async () => undefined);
      const deferReply = vi.fn(async () => undefined);
      const editReply = vi.fn(async () => undefined);
      const interaction = {
        guildId: GUILD_ID,
        guild,
        channelId: CHANNEL_ID,
        client: { user: { id: BOT_ID } },
        message: createSourceMessage(questionMessageId),
        user: member.user,
        customId: `court:anonymous_answer_modal:${questionMessageId}`,
        fields: {
          getTextInputValue: vi.fn(() => "The court should proceed."),
        },
        reply,
        deferReply,
        editReply,
      } as unknown as ModalSubmitInteraction;
      return { interaction, reply, deferReply, editReply };
    },
    send,
    sendStarted: sendStarted.promise,
    finishSend: () => sentMessage.resolve(sent),
    deleteSent,
    hasUserAnswered,
    markUserAnswered,
    recordAnswerMetric,
    answerRows,
    setCurrent: (value: boolean) => {
      current = value;
    },
    setClosed: (value: boolean) => {
      const post = posts.get(MESSAGE_ID);
      if (post) {
        post.closed = value;
      }
    },
  };
}

describe("anonymous answer admission", () => {
  it("serializes duplicate concurrent submissions before the Discord send", async () => {
    const fixture = createFixture();
    const first = fixture.createInteraction();
    const second = fixture.createInteraction();

    const firstRun = handleModalSubmitInteraction(
      first.interaction,
      fixture.runtime,
    );
    await fixture.sendStarted;
    const secondRun = handleModalSubmitInteraction(
      second.interaction,
      fixture.runtime,
    );
    await vi.waitFor(() => {
      expect(fixture.hasUserAnswered).toHaveBeenCalledTimes(4);
    });

    fixture.finishSend();
    await Promise.all([firstRun, secondRun]);

    expect(fixture.send).toHaveBeenCalledTimes(1);
    expect(fixture.markUserAnswered).toHaveBeenCalledTimes(1);
    expect(fixture.recordAnswerMetric).not.toHaveBeenCalled();
    expect(fixture.answerRows).toEqual(new Set([`${MESSAGE_ID}:${USER_ID}`]));
    expect(first.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(second.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(first.reply).not.toHaveBeenCalled();
    expect(second.reply).not.toHaveBeenCalled();
    expect(first.editReply).toHaveBeenCalledWith({
      content: `Your anonymous answer has been posted in <#${MESSAGE_ID}>.`,
    });
    expect(second.editReply).toHaveBeenCalledWith({
      content: "You already answered this court inquiry.",
    });
  });

  it("serializes one user's cooldown admission across different questions", async () => {
    const fixture = createFixture();
    const guildRuntime = await fixture.runtime.forGuild(GUILD_ID);
    if (!guildRuntime) {
      throw new Error("fixture guild runtime is missing");
    }
    guildRuntime.settings.limits.anonCooldownSeconds = 3_600;
    const first = fixture.createInteraction(MESSAGE_ID);
    const second = fixture.createInteraction(SECOND_MESSAGE_ID);

    const firstRun = handleModalSubmitInteraction(
      first.interaction,
      fixture.runtime,
    );
    await fixture.sendStarted;
    const secondRun = handleModalSubmitInteraction(
      second.interaction,
      fixture.runtime,
    );
    await vi.waitFor(() => {
      expect(second.deferReply).toHaveBeenCalledWith({ ephemeral: true });
      expect(fixture.hasUserAnswered).toHaveBeenCalledTimes(4);
    });
    expect(fixture.send).toHaveBeenCalledTimes(1);

    fixture.finishSend();
    await Promise.all([firstRun, secondRun]);

    expect(fixture.send).toHaveBeenCalledTimes(1);
    expect(fixture.markUserAnswered).toHaveBeenCalledTimes(1);
    expect(second.editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("You are on cooldown"),
    });
  });

  it("cancels a waiting submission and deletes an untracked sent answer", async () => {
    const fixture = createFixture();
    const first = fixture.createInteraction();
    const second = fixture.createInteraction();

    const firstRun = handleModalSubmitInteraction(
      first.interaction,
      fixture.runtime,
    );
    await fixture.sendStarted;
    const secondRun = handleModalSubmitInteraction(
      second.interaction,
      fixture.runtime,
    );
    await vi.waitFor(() => {
      expect(fixture.hasUserAnswered).toHaveBeenCalledTimes(4);
    });

    fixture.setCurrent(false);
    fixture.finishSend();
    await Promise.all([firstRun, secondRun]);

    expect(fixture.send).toHaveBeenCalledTimes(1);
    expect(fixture.deleteSent).toHaveBeenCalledTimes(1);
    expect(fixture.markUserAnswered).not.toHaveBeenCalled();
    expect(fixture.recordAnswerMetric).not.toHaveBeenCalled();
    expect(fixture.answerRows).toHaveLength(0);
    for (const editReply of [first.editReply, second.editReply]) {
      expect(editReply).toHaveBeenCalledWith({
        content:
          "This answer was cancelled because this server's configuration changed.",
      });
    }
  });

  it("deletes an answer when the inquiry closes during the Discord send", async () => {
    const fixture = createFixture();
    const submission = fixture.createInteraction();

    const run = handleModalSubmitInteraction(
      submission.interaction,
      fixture.runtime,
    );
    await fixture.sendStarted;
    fixture.setClosed(true);
    fixture.finishSend();
    await run;

    expect(fixture.send).toHaveBeenCalledTimes(1);
    expect(fixture.deleteSent).toHaveBeenCalledTimes(1);
    expect(fixture.markUserAnswered).not.toHaveBeenCalled();
    expect(fixture.recordAnswerMetric).not.toHaveBeenCalled();
    expect(submission.editReply).toHaveBeenCalledWith({
      content: "This court inquiry is already closed.",
    });
  });

  it("deletes a sent answer when its database transaction fails", async () => {
    const fixture = createFixture();
    const submission = fixture.createInteraction();
    fixture.markUserAnswered.mockImplementationOnce(() => {
      throw new Error("database write failed");
    });

    const run = handleModalSubmitInteraction(
      submission.interaction,
      fixture.runtime,
    );
    await fixture.sendStarted;
    fixture.finishSend();
    await run;

    expect(fixture.send).toHaveBeenCalledTimes(1);
    expect(fixture.markUserAnswered).toHaveBeenCalledTimes(1);
    expect(fixture.recordAnswerMetric).not.toHaveBeenCalled();
    expect(fixture.deleteSent).toHaveBeenCalledTimes(1);
    expect(fixture.answerRows).toHaveLength(0);
    expect(submission.editReply).toHaveBeenCalledWith({
      content:
        "Failed to save your anonymous answer. The posted message was removed; please try again.",
    });
  });
});
