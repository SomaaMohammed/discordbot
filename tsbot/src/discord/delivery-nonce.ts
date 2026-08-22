import type { Guild, Message, TextChannel } from "discord.js";
import type { DeliveryAttempt } from "../types.js";

const MAX_SCAN_PAGES = 10;
const PAGE_SIZE = 100;

export async function findBotMessageByNonce(
  channel: Pick<TextChannel, "messages">,
  botUserId: string | null,
  nonce: string,
  recordCreatedAt: string,
): Promise<
  | { status: "found"; message: Message }
  | { status: "missing" | "ambiguous" | "unavailable" }
> {
  if (!botUserId) return { status: "unavailable" };
  const createdAt = Date.parse(recordCreatedAt);
  if (!Number.isFinite(createdAt)) return { status: "unavailable" };
  let before: string | undefined;
  const matches: Message[] = [];
  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    let batch;
    try {
      batch = await channel.messages.fetch({
        limit: PAGE_SIZE,
        ...(before ? { before } : {}),
      });
    } catch {
      return { status: "unavailable" };
    }
    const messages = [...batch.values()];
    for (const message of messages) {
      if (
        message.author.id === botUserId &&
        String(message.nonce ?? "") === nonce
      ) {
        matches.push(message);
      }
    }
    if (matches.length > 1) return { status: "ambiguous" };
    const oldest = messages.at(-1);
    if (
      messages.length < PAGE_SIZE ||
      !oldest ||
      oldest.createdTimestamp <= createdAt
    ) {
      return matches[0]
        ? { status: "found", message: matches[0] }
        : { status: "missing" };
    }
    before = oldest.id;
  }
  return { status: "unavailable" };
}

/**
 * Reconciles a durable pre-send attempt against the exact channel recorded for
 * it. A missing Discord channel proves that the attempted message no longer
 * exists; an accessible channel whose history cannot be inspected is
 * deliberately unavailable rather than silently treated as absent.
 */
export async function findBotMessageByAttempt(
  guild: Guild,
  botUserId: string | null,
  attempt: DeliveryAttempt,
): Promise<
  | { status: "found"; message: Message }
  | { status: "missing" | "ambiguous" | "unavailable" }
> {
  let channel;
  try {
    channel = await guild.channels.fetch(attempt.channelId, {
      cache: true,
      force: true,
    });
  } catch (error) {
    return isUnknownDiscordResource(error, 10_003)
      ? { status: "missing" }
      : { status: "unavailable" };
  }
  if (!channel) return { status: "missing" };
  if (channel.guild.id !== guild.id || !("messages" in channel)) {
    return { status: "unavailable" };
  }
  return findBotMessageByNonce(
    channel as Pick<TextChannel, "messages">,
    botUserId,
    attempt.attemptId,
    attempt.startedAt,
  );
}

function isUnknownDiscordResource(
  error: unknown,
  expectedCode: number,
): boolean {
  if (!error || typeof error !== "object") return false;
  return Number((error as { code?: unknown }).code) === expectedCode;
}
