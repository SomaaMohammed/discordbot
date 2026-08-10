import {
  EmbedBuilder,
  type Message,
  type MessageMentionOptions,
  type User,
} from "discord.js";
import { DISCORD_SNOWFLAKE_PATTERN } from "./guild-settings.js";
import type { ParsedMudaeRoll } from "./mudae-roll-parser.js";

export const PRIVATE_MUDAE_SAFE_ALLOWED_MENTIONS: MessageMentionOptions =
  Object.freeze({
    parse: [],
    repliedUser: false,
  });

const CLOSED_DM_ERROR_CODES = new Set([50_007, 50_278]);

export interface SafeMudaeDeliveryFailure {
  readonly name: string;
  readonly code: number | string | null;
}

export type PrivateMudaeDeliveryResult =
  | { readonly status: "native-forwarded" }
  | {
      readonly status: "fallback-sent";
      readonly nativeFailure: SafeMudaeDeliveryFailure;
    }
  | {
      readonly status: "failed";
      readonly stage:
        | "source-validation"
        | "recipient-validation"
        | "dm-open"
        | "dm-unavailable"
        | "fallback";
      readonly failure: SafeMudaeDeliveryFailure;
      readonly nativeFailure?: SafeMudaeDeliveryFailure;
    };

export interface PrivateMudaeDeliveryInput {
  readonly message: Message;
  readonly recipient: User;
  readonly recipientUserId: string;
  readonly roll: ParsedMudaeRoll;
}

export async function deliverPrivateMudaeWatchNotification(
  input: PrivateMudaeDeliveryInput,
): Promise<PrivateMudaeDeliveryResult> {
  const { message, recipient, recipientUserId, roll } = input;
  const guildId = message.guildId;
  if (
    !guildId ||
    !isSnowflake(guildId) ||
    !isSnowflake(message.channelId) ||
    !isSnowflake(message.id)
  ) {
    return invalidDeliveryResult("source-validation", "InvalidSourceMessage");
  }
  if (
    !isSnowflake(recipientUserId) ||
    recipient.id !== recipientUserId ||
    recipient.bot
  ) {
    return invalidDeliveryResult("recipient-validation", "InvalidRecipient");
  }

  const jumpUrl = buildDiscordMessageUrl(
    guildId,
    message.channelId,
    message.id,
  );
  let dm: Awaited<ReturnType<User["createDM"]>>;
  try {
    dm = await recipient.createDM();
  } catch (error) {
    return {
      status: "failed",
      stage: "dm-open",
      failure: describeMudaeDeliveryFailure(error),
    };
  }

  try {
    await dm.send({
      content: `A watched Mudae series rolled. [Open the original roll](${jumpUrl})`,
      forward: {
        message: message.id,
        channel: message.channelId,
        guild: guildId,
      },
      allowedMentions: PRIVATE_MUDAE_SAFE_ALLOWED_MENTIONS,
    });
    return { status: "native-forwarded" };
  } catch (error) {
    const nativeFailure = describeMudaeDeliveryFailure(error);
    if (isClosedDmFailure(nativeFailure)) {
      return {
        status: "failed",
        stage: "dm-unavailable",
        failure: nativeFailure,
      };
    }

    try {
      await dm.send({
        content: `A watched Mudae series rolled. [Open the original roll](${jumpUrl})`,
        embeds: [buildSafeFallbackEmbed(roll, jumpUrl)],
        allowedMentions: PRIVATE_MUDAE_SAFE_ALLOWED_MENTIONS,
      });
      return { status: "fallback-sent", nativeFailure };
    } catch (fallbackError) {
      return {
        status: "failed",
        stage: "fallback",
        failure: describeMudaeDeliveryFailure(fallbackError),
        nativeFailure,
      };
    }
  }
}

export function buildDiscordMessageUrl(
  guildId: string,
  channelId: string,
  messageId: string,
): string {
  if (
    !isSnowflake(guildId) ||
    !isSnowflake(channelId) ||
    !isSnowflake(messageId)
  ) {
    throw new TypeError("A Discord message URL requires valid snowflakes");
  }
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

export function describeMudaeDeliveryFailure(
  error: unknown,
): SafeMudaeDeliveryFailure {
  const candidate = error as {
    readonly name?: unknown;
    readonly code?: unknown;
  } | null;
  const name = sanitizeFailureToken(candidate?.name, "DeliveryError");
  const rawCode = candidate?.code;
  const code =
    typeof rawCode === "number" && Number.isSafeInteger(rawCode)
      ? rawCode
      : typeof rawCode === "string" && /^[A-Za-z0-9_.-]{1,40}$/u.test(rawCode)
        ? rawCode
        : null;
  return { name, code };
}

function buildSafeFallbackEmbed(
  roll: ParsedMudaeRoll,
  jumpUrl: string,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(truncateCodePoints(`Mudae roll: ${roll.characterName}`, 256))
    .setDescription(`Series: ${roll.seriesName}`)
    .setURL(jumpUrl)
    .setFooter({
      text: "Open the original message to claim. Superior never claims automatically.",
    });
  const imageUrl = safeRemoteImageUrl(roll.imageUrl);
  if (imageUrl) {
    embed.setImage(imageUrl);
  }
  return embed;
}

function safeRemoteImageUrl(value: string): string | null {
  if (value.length > 2_048) return null;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      parsed.hostname &&
      !parsed.username &&
      !parsed.password
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function isClosedDmFailure(failure: SafeMudaeDeliveryFailure): boolean {
  const numericCode =
    typeof failure.code === "number"
      ? failure.code
      : /^\d+$/u.test(failure.code ?? "")
        ? Number(failure.code)
        : null;
  return numericCode !== null && CLOSED_DM_ERROR_CODES.has(numericCode);
}

function invalidDeliveryResult(
  stage: "source-validation" | "recipient-validation",
  name: string,
): PrivateMudaeDeliveryResult {
  return {
    status: "failed",
    stage,
    failure: { name, code: null },
  };
}

function sanitizeFailureToken(value: unknown, fallback: string): string {
  return typeof value === "string" &&
    /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(value)
    ? value
    : fallback;
}

function isSnowflake(value: string): boolean {
  return DISCORD_SNOWFLAKE_PATTERN.test(value);
}

function truncateCodePoints(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join("");
}
