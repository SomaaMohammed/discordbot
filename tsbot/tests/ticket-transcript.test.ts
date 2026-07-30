import { Collection } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
  TRANSCRIPT_BYTE_LIMIT,
  TRANSCRIPT_FETCH_BATCH_SIZE,
  TRANSCRIPT_MESSAGE_LIMIT,
  collectTicketTranscript,
  type TranscriptChannelLike,
  type TranscriptMessageLike,
} from "../src/discord/ticket-transcript.js";

const GUILD_ID = "123456789012345678";
const CHANNEL_ID = "223456789012345678";
const GENERATED_AT = Date.UTC(2026, 6, 30, 12, 0, 0);

function createMessage(
  sequence: number,
  options: {
    content?: string;
    attachments?: string[];
    displayName?: string;
    tag?: string;
  } = {},
): TranscriptMessageLike {
  const id = String(10_000 + sequence);
  return {
    id,
    createdTimestamp: Date.UTC(2026, 0, 1, 0, 0, sequence),
    content: options.content ?? `message ${sequence}`,
    author: {
      id: String(20_000 + sequence),
      tag: options.tag ?? `user${sequence}#0001`,
    },
    member: { displayName: options.displayName ?? `Member ${sequence}` },
    attachments: new Collection(
      (options.attachments ?? []).map((url, index) => [String(index), { url }]),
    ),
  };
}

function createChannel(messages: TranscriptMessageLike[]): {
  channel: TranscriptChannelLike;
  fetch: ReturnType<
    typeof vi.fn<
      (options: {
        limit: number;
        before?: string;
      }) => Promise<Collection<string, TranscriptMessageLike>>
    >
  >;
} {
  const newestFirst = [...messages].sort(
    (left, right) => right.createdTimestamp - left.createdTimestamp,
  );
  const fetch = vi.fn(async (options: { limit: number; before?: string }) => {
    const start =
      options.before === undefined
        ? 0
        : newestFirst.findIndex((message) => message.id === options.before) + 1;
    const page =
      start <= 0 && options.before !== undefined
        ? []
        : newestFirst.slice(start, start + options.limit);
    return new Collection(page.map((message) => [message.id, message]));
  });
  return {
    channel: {
      id: CHANNEL_ID,
      name: "ticket-0042",
      guild: { id: GUILD_ID },
      messages: { fetch },
    },
    fetch,
  };
}

describe("ticket transcript collection", () => {
  it("exports finite production limits", () => {
    expect(TRANSCRIPT_MESSAGE_LIMIT).toBe(1_000);
    expect(TRANSCRIPT_BYTE_LIMIT).toBeLessThanOrEqual(7.5 * 1024 * 1024);
    expect(TRANSCRIPT_FETCH_BATCH_SIZE).toBe(100);
  });

  it("paginates in bounded batches and renders messages chronologically", async () => {
    const { channel, fetch } = createChannel([
      createMessage(1),
      createMessage(2),
      createMessage(3),
      createMessage(4),
      createMessage(5),
    ]);

    const transcript = await collectTicketTranscript(channel, {
      expectedGuildId: GUILD_ID,
      maxMessages: 10,
      batchSize: 2,
      generatedAt: GENERATED_AT,
    });

    expect(fetch.mock.calls).toEqual([
      [{ limit: 2 }],
      [{ limit: 2, before: "10004" }],
      [{ limit: 2, before: "10002" }],
    ]);
    expect(transcript.metadata).toMatchObject({
      collectedMessageCount: 5,
      includedMessageCount: 5,
      messageLimitReached: false,
      byteLimitReached: false,
      truncated: false,
      truncationReasons: [],
    });
    const positions = [1, 2, 3, 4, 5].map((sequence) =>
      transcript.text.indexOf(`message ${sequence}`),
    );
    expect(positions).toEqual(
      [...positions].sort((left, right) => left - right),
    );
    expect(transcript.text).toContain(
      "Author: Member 1 | user1#0001 | ID: 20001",
    );
    expect(transcript.text).toContain("Generated: 2026-07-30T12:00:00.000Z");
    expect(transcript.bytes).toBe(Buffer.byteLength(transcript.text, "utf8"));
    expect(transcript.buffer.toString("utf8")).toBe(transcript.text);
  });

  it("includes attachment URLs and a placeholder for attachment-only messages", async () => {
    const attachmentUrl = "https://cdn.discord.test/ticket/evidence.png";
    const { channel } = createChannel([
      createMessage(1, {
        content: "",
        attachments: [attachmentUrl],
        displayName: "Evidence Keeper",
      }),
    ]);

    const transcript = await collectTicketTranscript(channel, {
      generatedAt: GENERATED_AT,
    });

    expect(transcript.text).toContain("[no text content]");
    expect(transcript.text).toContain(`Attachment: ${attachmentUrl}`);
    expect(transcript.text).toContain("Message ID: 10001");
  });

  it("uses a one-message lookahead and reports message-limit truncation", async () => {
    const { channel, fetch } = createChannel([
      createMessage(1),
      createMessage(2),
      createMessage(3),
      createMessage(4),
      createMessage(5),
    ]);

    const transcript = await collectTicketTranscript(channel, {
      maxMessages: 3,
      batchSize: 2,
      generatedAt: GENERATED_AT,
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(transcript.metadata).toMatchObject({
      collectedMessageCount: 3,
      includedMessageCount: 3,
      messageLimitReached: true,
      byteLimitReached: false,
      truncated: true,
      truncationReasons: ["message-limit"],
    });
    expect(transcript.text).not.toContain("message 1");
    expect(transcript.text).not.toContain("message 2");
    expect(transcript.text).toContain("message 3");
    expect(transcript.text).toContain("message 5");
    expect(transcript.text).toContain(
      "[TRANSCRIPT TRUNCATED: message limit reached; additional older messages omitted]",
    );
  });

  it("does not claim truncation when history ends exactly at the message cap", async () => {
    const { channel, fetch } = createChannel([
      createMessage(1),
      createMessage(2),
      createMessage(3),
    ]);
    const transcript = await collectTicketTranscript(channel, {
      maxMessages: 3,
      batchSize: 2,
      generatedAt: GENERATED_AT,
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(transcript.metadata.messageLimitReached).toBe(false);
    expect(transcript.metadata.truncated).toBe(false);
  });

  it("keeps the buffer within its UTF-8 byte cap with explicit byte metadata", async () => {
    const { channel } = createChannel([
      createMessage(1, { content: "short oldest message" }),
      createMessage(2, { content: "🙂".repeat(500) }),
      createMessage(3, { content: "newest message" }),
    ]);

    const transcript = await collectTicketTranscript(channel, {
      maxBytes: 900,
      generatedAt: GENERATED_AT,
    });

    expect(transcript.bytes).toBeLessThanOrEqual(900);
    expect(transcript.buffer.byteLength).toBe(transcript.bytes);
    expect(transcript.metadata).toMatchObject({
      messageLimitReached: false,
      byteLimitReached: true,
      truncated: true,
      truncationReasons: ["byte-limit"],
    });
    expect(transcript.metadata.includedMessageCount).toBeLessThan(3);
    expect(transcript.text).toContain("short oldest message");
    expect(transcript.text).toContain("byte limit reached");
    expect(transcript.text).toContain("[TRANSCRIPT TRUNCATED:");
  });

  it("rejects cross-guild channels and attempts to raise the hard limits", async () => {
    const { channel, fetch } = createChannel([createMessage(1)]);
    await expect(
      collectTicketTranscript(channel, {
        expectedGuildId: "999999999999999999",
      }),
    ).rejects.toThrow("expected guild");
    expect(fetch).not.toHaveBeenCalled();

    await expect(
      collectTicketTranscript(channel, {
        maxMessages: TRANSCRIPT_MESSAGE_LIMIT + 1,
      }),
    ).rejects.toThrow("maxMessages");
    await expect(
      collectTicketTranscript(channel, {
        maxBytes: TRANSCRIPT_BYTE_LIMIT + 1,
      }),
    ).rejects.toThrow("maxBytes");
  });
});
