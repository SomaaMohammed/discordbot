import type { GuildMember, Message } from "discord.js";
import { DISCORD_SNOWFLAKE_PATTERN } from "./guild-settings.js";
import {
  findPrivateMudaeWatchSeries,
  isPrivateMudaeWatchLocation,
  type PrivateMudaeWatchConfig,
} from "./mudae-watch-config.js";
import {
  deliverPrivateMudaeWatchNotification,
  describeMudaeDeliveryFailure,
  type PrivateMudaeDeliveryInput,
  type PrivateMudaeDeliveryResult,
  type SafeMudaeDeliveryFailure,
} from "./mudae-watch-delivery.js";
import { parseMudaeRoll } from "./mudae-roll-parser.js";
import { fetchGuildMemberCoalesced } from "./discord/fetch-coalescing.js";

export interface PrivateMudaeWatchReservation {
  readonly guildId: string;
  readonly channelId: string;
  readonly sourceMessageId: string;
  readonly recipientUserId: string;
  readonly reservedAt: string;
}

/** Implementations must atomically distinguish a new reservation from a duplicate. */
export interface PrivateMudaeWatchDeduplicationStore {
  reserveMudaeWatchNotification(
    reservation: PrivateMudaeWatchReservation,
  ):
    | { readonly status: "reserved"; readonly reservationId: string }
    | { readonly status: "duplicate" };
  completeMudaeWatchNotification(
    guildId: string,
    reservationId: string,
    outcome: "delivered" | "failed",
  ): void;
}

export interface PrivateMudaeWatchSafeLogMetadata {
  readonly [key: string]: unknown;
  readonly outcome: string;
  readonly stage?: string;
  readonly failureName?: string;
  readonly failureCode?: number | string;
}

export interface PrivateMudaeWatchLogger {
  info?: (message: string, metadata: PrivateMudaeWatchSafeLogMetadata) => void;
  warn: (message: string, metadata: PrivateMudaeWatchSafeLogMetadata) => void;
  error: (message: string, metadata: PrivateMudaeWatchSafeLogMetadata) => void;
}

export interface PrivateMudaeWatcherDependencies {
  readonly deduplicationStore: PrivateMudaeWatchDeduplicationStore;
  readonly deliver?: (
    input: PrivateMudaeDeliveryInput,
  ) => Promise<PrivateMudaeDeliveryResult>;
  readonly logger?: PrivateMudaeWatchLogger;
  readonly now?: () => Date;
}

export type PrivateMudaeWatchProcessResult =
  | "disabled"
  | "untrusted-source"
  | "non-roll"
  | "series-not-watched"
  | "recipient-unavailable"
  | "duplicate"
  | "native-forwarded"
  | "fallback-sent"
  | "delivery-failed"
  | "storage-failed";

const NOOP_LOGGER: PrivateMudaeWatchLogger = {
  warn: () => undefined,
  error: () => undefined,
};

export class PrivateMudaeWatcher {
  private readonly deliver: NonNullable<
    PrivateMudaeWatcherDependencies["deliver"]
  >;
  private readonly logger: PrivateMudaeWatchLogger;
  private readonly now: () => Date;

  public constructor(
    private readonly configuration: PrivateMudaeWatchConfig | null,
    private readonly dependencies: PrivateMudaeWatcherDependencies,
  ) {
    this.deliver = dependencies.deliver ?? deliverPrivateMudaeWatchNotification;
    this.logger = dependencies.logger ?? NOOP_LOGGER;
    this.now = dependencies.now ?? (() => new Date());
  }

  public get enabled(): boolean {
    return this.configuration?.enabled === true;
  }

  public isConfiguredLocation(
    guildId: string | null | undefined,
    channelId: string | null | undefined,
  ): boolean {
    const configuration = this.configuration;
    return Boolean(
      configuration?.enabled &&
      guildId &&
      channelId &&
      isSnowflake(guildId) &&
      isSnowflake(channelId) &&
      isPrivateMudaeWatchLocation(configuration, guildId, channelId),
    );
  }

  public isTrustedAuthor(
    author: { readonly id: string; readonly bot: boolean } | null | undefined,
  ): boolean {
    return Boolean(
      this.configuration?.enabled &&
      author?.bot &&
      author.id === this.configuration.mudaeBotUserId,
    );
  }

  public isCandidate(message: Message): boolean {
    const configuration = this.configuration;
    if (!configuration?.enabled || message.partial) {
      return false;
    }
    const guildId = message.guildId;
    const guild = message.guild;
    if (
      !guildId ||
      !guild ||
      guild.id !== guildId ||
      guild.available === false ||
      !isSnowflake(message.id) ||
      !isSnowflake(message.channelId) ||
      !this.isTrustedAuthor(message.author) ||
      message.webhookId !== null ||
      (message.channel as { readonly guildId?: string | null }).guildId !==
        guildId
    ) {
      return false;
    }
    return this.isConfiguredLocation(guildId, message.channelId);
  }

  public async processMessage(
    message: Message,
  ): Promise<PrivateMudaeWatchProcessResult> {
    const configuration = this.configuration;
    if (!configuration?.enabled) {
      return "disabled";
    }
    if (!this.isCandidate(message)) {
      return "untrusted-source";
    }

    const roll = parseMudaeRoll(message);
    if (!roll) {
      return "non-roll";
    }
    if (!findPrivateMudaeWatchSeries(configuration, roll.seriesName)) {
      return "series-not-watched";
    }

    const recipient = await resolveCurrentRecipientMember(
      message,
      configuration.recipientUserId,
    );
    if (!recipient) {
      this.logger.warn("Private Mudae watcher recipient is unavailable", {
        outcome: "recipient-unavailable",
      });
      return "recipient-unavailable";
    }
    if (!this.isCandidate(message)) {
      return "untrusted-source";
    }

    let reservationId: string;
    try {
      const reservation =
        this.dependencies.deduplicationStore.reserveMudaeWatchNotification({
          guildId: message.guildId!,
          channelId: message.channelId,
          sourceMessageId: message.id,
          recipientUserId: configuration.recipientUserId,
          reservedAt: this.now().toISOString(),
        });
      if (reservation.status === "duplicate") {
        return "duplicate";
      }
      reservationId = reservation.reservationId;
    } catch (error) {
      this.logFailure(
        "error",
        "Private Mudae watcher could not reserve delivery",
        "storage-failed",
        "reservation",
        describeMudaeDeliveryFailure(error),
      );
      return "storage-failed";
    }

    let delivery: PrivateMudaeDeliveryResult;
    try {
      delivery = await this.deliver({
        message,
        recipient: recipient.user,
        recipientUserId: configuration.recipientUserId,
        roll,
      });
    } catch (error) {
      this.completeReservation(message.guildId!, reservationId, "failed");
      this.logFailure(
        "error",
        "Private Mudae watcher delivery failed unexpectedly",
        "delivery-failed",
        "unexpected",
        describeMudaeDeliveryFailure(error),
      );
      return "delivery-failed";
    }

    if (delivery.status === "native-forwarded") {
      this.completeReservation(message.guildId!, reservationId, "delivered");
      this.logger.info?.("Private watcher notification delivered", {
        outcome: "native-forwarded",
        stage: "native-forward",
      });
      return "native-forwarded";
    }
    if (delivery.status === "fallback-sent") {
      this.completeReservation(message.guildId!, reservationId, "delivered");
      this.logger.warn(
        "Native Discord forwarding failed, but Superior sent the safe fallback successfully.",
        {
          outcome: "fallback-sent",
          stage: "native-forward",
          failureName: delivery.nativeFailure.name,
          ...(delivery.nativeFailure.code === null
            ? {}
            : {
                code: delivery.nativeFailure.code,
                failureCode: delivery.nativeFailure.code,
              }),
        },
      );
      return "fallback-sent";
    }
    this.completeReservation(message.guildId!, reservationId, "failed");
    this.logFailure(
      "error",
      "Private Mudae watcher could not deliver a notification",
      "delivery-failed",
      delivery.stage,
      delivery.failure,
    );
    return "delivery-failed";
  }

  private completeReservation(
    guildId: string,
    reservationId: string,
    outcome: "delivered" | "failed",
  ): void {
    try {
      this.dependencies.deduplicationStore.completeMudaeWatchNotification(
        guildId,
        reservationId,
        outcome,
      );
    } catch (error) {
      this.logFailure(
        "error",
        "Private Mudae watcher could not finalize delivery state",
        "completion-failed",
        "completion",
        describeMudaeDeliveryFailure(error),
      );
    }
  }

  private logFailure(
    level: "warn" | "error",
    message: string,
    outcome: string,
    stage: string,
    failure: SafeMudaeDeliveryFailure,
  ): void {
    const metadata: PrivateMudaeWatchSafeLogMetadata = {
      outcome,
      stage,
      failureName: failure.name,
      ...(failure.code === null ? {} : { failureCode: failure.code }),
    };
    this.logger[level](message, metadata);
  }
}

export async function resolveCurrentRecipientMember(
  message: Message,
  recipientUserId: string,
): Promise<GuildMember | null> {
  const guild = message.guild;
  if (
    !guild ||
    guild.id !== message.guildId ||
    guild.available === false ||
    !isSnowflake(recipientUserId)
  ) {
    return null;
  }
  const cached = guild.members.cache.get(recipientUserId);
  const member =
    cached ??
    (await fetchGuildMemberCoalesced(guild, recipientUserId, {
      cache: true,
      force: false,
      input: "id",
    }));
  if (
    !member ||
    member.id !== recipientUserId ||
    member.guild.id !== guild.id ||
    member.user.id !== recipientUserId ||
    member.user.bot
  ) {
    return null;
  }
  return member;
}

function isSnowflake(value: string): boolean {
  return DISCORD_SNOWFLAKE_PATTERN.test(value);
}
