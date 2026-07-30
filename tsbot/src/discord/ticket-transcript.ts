export const DEFAULT_TRANSCRIPT_MAX_MESSAGES = 1_000;
export const DEFAULT_TRANSCRIPT_MAX_BYTES = Math.floor(7.5 * 1024 * 1024);
export const DEFAULT_TRANSCRIPT_FETCH_BATCH_SIZE = 100;

export const TRANSCRIPT_MESSAGE_LIMIT = DEFAULT_TRANSCRIPT_MAX_MESSAGES;
export const TRANSCRIPT_BYTE_LIMIT = DEFAULT_TRANSCRIPT_MAX_BYTES;
export const TRANSCRIPT_FETCH_BATCH_SIZE = DEFAULT_TRANSCRIPT_FETCH_BATCH_SIZE;

const MIN_TRANSCRIPT_BYTE_LIMIT = 256;
const MAX_ATTACHMENTS_PER_MESSAGE = 10;

export interface TranscriptAttachmentLike {
  url: string;
}

export interface TranscriptAuthorLike {
  id: string;
  tag?: string;
  username?: string;
}

export interface TranscriptMessageLike {
  id: string;
  createdTimestamp: number;
  content: string;
  author: TranscriptAuthorLike;
  member?: { displayName?: string } | null;
  attachments: { values(): Iterable<TranscriptAttachmentLike> };
}

export interface TranscriptMessagePageLike {
  readonly size: number;
  values(): Iterable<TranscriptMessageLike>;
}

export interface TranscriptChannelLike {
  id: string;
  name: string;
  guild: { id: string };
  messages: {
    fetch(options: {
      limit: number;
      before?: string;
    }): Promise<TranscriptMessagePageLike>;
  };
}

export interface TicketTranscriptOptions {
  /** Rejects a channel resolved from another guild when provided. */
  expectedGuildId?: string;
  /** Hard cap; cannot exceed TRANSCRIPT_MESSAGE_LIMIT. */
  maxMessages?: number;
  /** Hard cap; cannot exceed TRANSCRIPT_BYTE_LIMIT. */
  maxBytes?: number;
  /** Discord fetch page size, primarily exposed for deterministic tests. */
  batchSize?: number;
  /** Timestamp used in transcript metadata. */
  generatedAt?: Date | number;
}

export type TranscriptTruncationReason = "message-limit" | "byte-limit";

export interface TicketTranscriptMetadata {
  guildId: string;
  channelId: string;
  collectedMessageCount: number;
  includedMessageCount: number;
  messageLimit: number;
  byteLimit: number;
  messageLimitReached: boolean;
  byteLimitReached: boolean;
  truncated: boolean;
  truncationReasons: TranscriptTruncationReason[];
}

export interface TicketTranscript {
  text: string;
  buffer: Buffer;
  bytes: number;
  metadata: TicketTranscriptMetadata;
}

interface ResolvedTranscriptOptions {
  expectedGuildId: string | undefined;
  maxMessages: number;
  maxBytes: number;
  batchSize: number;
  generatedAt: Date;
}

interface CollectedMessages {
  messages: TranscriptMessageLike[];
  messageLimitReached: boolean;
}

/**
 * Fetches at most maxMessages plus a single look-ahead message, then renders a
 * bounded UTF-8 plain-text transcript entirely in memory.
 */
export async function collectTicketTranscript(
  channel: TranscriptChannelLike,
  options: TicketTranscriptOptions = {},
): Promise<TicketTranscript> {
  const resolved = resolveOptions(options);
  if (
    resolved.expectedGuildId !== undefined &&
    channel.guild.id !== resolved.expectedGuildId
  ) {
    throw new Error(
      "Transcript channel does not belong to the expected guild.",
    );
  }

  const collected = await collectMessages(
    channel,
    resolved.maxMessages,
    resolved.batchSize,
  );
  const blocks = collected.messages.map(renderMessage);
  const rendered = renderWithinByteLimit(
    channel,
    blocks,
    collected.messageLimitReached,
    resolved,
  );
  const buffer = Buffer.from(rendered.text, "utf8");
  const truncationReasons: TranscriptTruncationReason[] = [];
  if (collected.messageLimitReached) truncationReasons.push("message-limit");
  if (rendered.byteLimitReached) truncationReasons.push("byte-limit");

  return {
    text: rendered.text,
    buffer,
    bytes: buffer.byteLength,
    metadata: {
      guildId: channel.guild.id,
      channelId: channel.id,
      collectedMessageCount: collected.messages.length,
      includedMessageCount: rendered.includedMessageCount,
      messageLimit: resolved.maxMessages,
      byteLimit: resolved.maxBytes,
      messageLimitReached: collected.messageLimitReached,
      byteLimitReached: rendered.byteLimitReached,
      truncated: truncationReasons.length > 0,
      truncationReasons,
    },
  };
}

async function collectMessages(
  channel: TranscriptChannelLike,
  maxMessages: number,
  batchSize: number,
): Promise<CollectedMessages> {
  const collected: TranscriptMessageLike[] = [];
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  const scanLimit = maxMessages + 1;
  let before: string | undefined;

  while (collected.length < scanLimit) {
    const limit = Math.min(batchSize, scanLimit - collected.length);
    const page = await channel.messages.fetch(
      before === undefined ? { limit } : { limit, before },
    );
    const pageMessages = takePageMessages(page, limit).sort((left, right) =>
      compareMessages(right, left),
    );
    if (pageMessages.length === 0) break;

    for (const message of pageMessages) {
      if (!seenIds.has(message.id)) {
        seenIds.add(message.id);
        collected.push(message);
        if (collected.length === scanLimit) break;
      }
    }

    const oldest = pageMessages.reduce((candidate, message) =>
      compareMessages(message, candidate) < 0 ? message : candidate,
    );
    if (pageMessages.length < limit || seenCursors.has(oldest.id)) break;
    seenCursors.add(oldest.id);
    before = oldest.id;
  }

  const messageLimitReached = collected.length > maxMessages;
  if (messageLimitReached) collected.length = maxMessages;
  collected.sort(compareMessages);
  return { messages: collected, messageLimitReached };
}

function renderWithinByteLimit(
  channel: TranscriptChannelLike,
  blocks: string[],
  messageLimitReached: boolean,
  options: ResolvedTranscriptOptions,
): {
  text: string;
  includedMessageCount: number;
  byteLimitReached: boolean;
} {
  const allText = assembleTranscript(
    channel,
    blocks,
    blocks.length,
    blocks.length,
    messageLimitReached,
    false,
    options,
  );
  if (Buffer.byteLength(allText, "utf8") <= options.maxBytes) {
    return {
      text: allText,
      includedMessageCount: blocks.length,
      byteLimitReached: false,
    };
  }

  const blockByteLengths = blocks.map((block) =>
    Buffer.byteLength(block, "utf8"),
  );
  let bodyBytes = 0;
  let includedMessageCount = 0;
  for (let index = 0; index < blocks.length; index += 1) {
    const nextBodyBytes = bodyBytes + blockByteLengths[index]!;
    const framing = assembleTranscript(
      channel,
      [],
      index + 1,
      blocks.length,
      messageLimitReached,
      true,
      options,
      blocks.length - (index + 1),
    );
    if (Buffer.byteLength(framing, "utf8") + nextBodyBytes > options.maxBytes) {
      break;
    }
    bodyBytes = nextBodyBytes;
    includedMessageCount = index + 1;
  }

  const text = assembleTranscript(
    channel,
    blocks.slice(0, includedMessageCount),
    includedMessageCount,
    blocks.length,
    messageLimitReached,
    true,
    options,
    blocks.length - includedMessageCount,
  );
  if (Buffer.byteLength(text, "utf8") > options.maxBytes) {
    throw new RangeError(
      "Transcript byte limit is too small for truncation metadata.",
    );
  }
  return { text, includedMessageCount, byteLimitReached: true };
}

function assembleTranscript(
  channel: TranscriptChannelLike,
  blocks: string[],
  includedMessageCount: number,
  collectedMessageCount: number,
  messageLimitReached: boolean,
  byteLimitReached: boolean,
  options: ResolvedTranscriptOptions,
  byteOmittedCount = 0,
): string {
  const reasons: string[] = [];
  if (messageLimitReached) {
    reasons.push("message limit reached; additional older messages omitted");
  }
  if (byteLimitReached) {
    reasons.push(
      `byte limit reached; ${byteOmittedCount} collected message${byteOmittedCount === 1 ? "" : "s"} omitted`,
    );
  }
  const header = [
    "Superior Ticket Transcript",
    `Guild ID: ${singleLine(channel.guild.id)}`,
    `Channel: #${singleLine(channel.name)} (ID: ${singleLine(channel.id)})`,
    `Generated: ${options.generatedAt.toISOString()}`,
    `Messages collected: ${collectedMessageCount}`,
    `Messages included: ${includedMessageCount}`,
    `Limits: ${options.maxMessages} messages; ${options.maxBytes} UTF-8 bytes`,
    `Truncated: ${reasons.length > 0 ? "yes" : "no"}`,
    ...(reasons.length > 0 ? [`Truncation: ${reasons.join("; ")}`] : []),
    "",
    "=".repeat(72),
    "",
  ].join("\n");
  const marker =
    reasons.length > 0
      ? `\n[TRANSCRIPT TRUNCATED: ${reasons.join("; ")}]\n`
      : "";
  return `${header}${blocks.join("")}${marker}`;
}

function renderMessage(message: TranscriptMessageLike): string {
  const timestamp = new Date(message.createdTimestamp);
  const safeTimestamp = Number.isFinite(timestamp.getTime())
    ? timestamp.toISOString()
    : "unknown-time";
  const tag = singleLine(
    message.author.tag ?? message.author.username ?? "unknown-user",
  );
  const displayName = singleLine(message.member?.displayName ?? tag);
  const content = normalizeMessageText(message.content);
  const attachmentLines: string[] = [];
  let attachmentCount = 0;
  for (const attachment of message.attachments.values()) {
    if (attachmentCount >= MAX_ATTACHMENTS_PER_MESSAGE) break;
    attachmentLines.push(`Attachment: ${singleLine(attachment.url)}`);
    attachmentCount += 1;
  }
  return [
    `[${safeTimestamp}]`,
    `Author: ${displayName} | ${tag} | ID: ${singleLine(message.author.id)}`,
    `Message ID: ${singleLine(message.id)}`,
    content || "[no text content]",
    ...attachmentLines,
    "",
    "-".repeat(72),
    "",
  ].join("\n");
}

function takePageMessages(
  page: TranscriptMessagePageLike,
  limit: number,
): TranscriptMessageLike[] {
  const messages: TranscriptMessageLike[] = [];
  for (const message of page.values()) {
    messages.push(message);
    if (messages.length === limit) break;
  }
  return messages;
}

function normalizeMessageText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "\uFFFD");
}

function singleLine(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "\uFFFD")
    .trim();
}

function compareMessages(
  left: TranscriptMessageLike,
  right: TranscriptMessageLike,
): number {
  if (left.createdTimestamp !== right.createdTimestamp) {
    return left.createdTimestamp - right.createdTimestamp;
  }
  if (/^\d+$/.test(left.id) && /^\d+$/.test(right.id)) {
    const leftId = BigInt(left.id);
    const rightId = BigInt(right.id);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  }
  return left.id.localeCompare(right.id);
}

function resolveOptions(
  options: TicketTranscriptOptions,
): ResolvedTranscriptOptions {
  const maxMessages = options.maxMessages ?? TRANSCRIPT_MESSAGE_LIMIT;
  const maxBytes = options.maxBytes ?? TRANSCRIPT_BYTE_LIMIT;
  const batchSize = options.batchSize ?? TRANSCRIPT_FETCH_BATCH_SIZE;
  if (
    !Number.isSafeInteger(maxMessages) ||
    maxMessages < 1 ||
    maxMessages > TRANSCRIPT_MESSAGE_LIMIT
  ) {
    throw new RangeError(
      `maxMessages must be between 1 and ${TRANSCRIPT_MESSAGE_LIMIT}.`,
    );
  }
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < MIN_TRANSCRIPT_BYTE_LIMIT ||
    maxBytes > TRANSCRIPT_BYTE_LIMIT
  ) {
    throw new RangeError(
      `maxBytes must be between ${MIN_TRANSCRIPT_BYTE_LIMIT} and ${TRANSCRIPT_BYTE_LIMIT}.`,
    );
  }
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > TRANSCRIPT_FETCH_BATCH_SIZE
  ) {
    throw new RangeError(
      `batchSize must be between 1 and ${TRANSCRIPT_FETCH_BATCH_SIZE}.`,
    );
  }
  const generatedAt = new Date(options.generatedAt ?? Date.now());
  if (!Number.isFinite(generatedAt.getTime())) {
    throw new RangeError("generatedAt must be a valid timestamp.");
  }
  return {
    expectedGuildId: options.expectedGuildId,
    maxMessages,
    maxBytes,
    batchSize,
    generatedAt,
  };
}
