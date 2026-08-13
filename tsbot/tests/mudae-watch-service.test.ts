import type { Guild, GuildMember, Message, User } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
  parsePrivateMudaeWatchConfig,
  type PrivateMudaeWatchConfig,
} from "../src/mudae-watch-config.js";
import type { PrivateMudaeDeliveryResult } from "../src/mudae-watch-delivery.js";
import {
  PrivateMudaeWatcher,
  type PrivateMudaeWatchDeduplicationStore,
  type PrivateMudaeWatchLogger,
} from "../src/mudae-watch-service.js";

const RECIPIENT_ID = "111111111111111111";
const MUDAE_ID = "222222222222222222";
const SPOOF_ID = "333333333333333333";
const GUILD_ID = "444444444444444444";
const OTHER_GUILD_ID = "555555555555555555";
const CHANNEL_ID = "666666666666666666";
const OTHER_CHANNEL_ID = "777777777777777777";
const MESSAGE_ID = "888888888888888888";

function configuration(
  overrides: Partial<{
    enabled: boolean;
    series: string[];
  }> = {},
): PrivateMudaeWatchConfig {
  return parsePrivateMudaeWatchConfig({
    enabled: overrides.enabled ?? true,
    recipientUserId: RECIPIENT_ID,
    mudaeBotUserId: MUDAE_ID,
    locations: [{ guildId: GUILD_ID, channelIds: [CHANNEL_ID] }],
    series: overrides.series ?? ["Kage no Jitsuryokusha ni Naritakute!"],
  });
}

function messageFixture(
  options: {
    authorId?: string;
    authorBot?: boolean;
    guildId?: string;
    guildAvailable?: boolean;
    channelId?: string;
    channelGuildId?: string;
    webhookId?: string | null;
    series?: string;
    recipientBot?: boolean;
    recipientGuildId?: string;
    recipientCached?: boolean;
    recipientMissing?: boolean;
  } = {},
) {
  const guildId = options.guildId ?? GUILD_ID;
  const recipientUser = {
    id: RECIPIENT_ID,
    bot: options.recipientBot ?? false,
  } as User;
  const member = {
    id: RECIPIENT_ID,
    user: recipientUser,
    guild: { id: options.recipientGuildId ?? guildId },
  } as GuildMember;
  const cache = new Map<string, GuildMember>();
  if (options.recipientCached ?? true) {
    cache.set(RECIPIENT_ID, member);
  }
  const fetchMember = vi.fn(async () => {
    if (options.recipientMissing) throw new Error("not a member");
    return member;
  });
  const guild = {
    id: guildId,
    available: options.guildAvailable ?? true,
    members: { cache, fetch: fetchMember },
  } as unknown as Guild;
  const channelId = options.channelId ?? CHANNEL_ID;
  const message = {
    id: MESSAGE_ID,
    content: "",
    embeds: [
      {
        title: "Lily (KJN)",
        author: null,
        description: options.series ?? "Kage no Jitsuryokusha ni Naritakute!",
        image: { url: "https://cdn.discordapp.com/lily.png" },
        thumbnail: null,
        footer: null,
      },
    ],
    components: [
      {
        type: 1,
        components: [{ type: 2, customId: "synthetic-claim", disabled: false }],
      },
    ],
    interaction: null,
    partial: false,
    webhookId: options.webhookId ?? null,
    author: {
      id: options.authorId ?? MUDAE_ID,
      bot: options.authorBot ?? true,
      username: "Mudae",
    },
    guildId,
    guild,
    channelId,
    channel: {
      guildId: options.channelGuildId ?? guildId,
    },
  } as unknown as Message;
  return { message, guild, member, recipientUser, fetchMember };
}

function dependencies(
  delivery: PrivateMudaeDeliveryResult = { status: "native-forwarded" },
) {
  const reservations = new Set<string>();
  let sequence = 0;
  const reserveMudaeWatchNotification = vi.fn(
    (input: { sourceMessageId: string }) => {
      if (reservations.has(input.sourceMessageId)) {
        return { status: "duplicate" as const };
      }
      reservations.add(input.sourceMessageId);
      sequence += 1;
      return {
        status: "reserved" as const,
        reservationId: `reservation-${sequence}`,
      };
    },
  );
  const completeMudaeWatchNotification = vi.fn();
  const store: PrivateMudaeWatchDeduplicationStore = {
    reserveMudaeWatchNotification,
    completeMudaeWatchNotification,
  };
  const deliver = vi.fn(async () => delivery);
  const logger: PrivateMudaeWatchLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    store,
    reserveMudaeWatchNotification,
    completeMudaeWatchNotification,
    deliver,
    logger,
  };
}

describe("private Mudae watcher", () => {
  it("exposes narrow configured-location and trusted-author gates", () => {
    const deps = dependencies();
    const watcher = new PrivateMudaeWatcher(configuration(), {
      deduplicationStore: deps.store,
    });

    expect(watcher.isConfiguredLocation(GUILD_ID, CHANNEL_ID)).toBe(true);
    expect(watcher.isConfiguredLocation(GUILD_ID, OTHER_CHANNEL_ID)).toBe(
      false,
    );
    expect(watcher.isConfiguredLocation(OTHER_GUILD_ID, CHANNEL_ID)).toBe(
      false,
    );
    expect(watcher.isTrustedAuthor({ id: MUDAE_ID, bot: true })).toBe(true);
    expect(watcher.isTrustedAuthor({ id: MUDAE_ID, bot: false })).toBe(false);
    expect(watcher.isTrustedAuthor({ id: SPOOF_ID, bot: true })).toBe(false);
  });

  it("quietly ignores a disabled watcher", async () => {
    const deps = dependencies();
    const watcher = new PrivateMudaeWatcher(configuration({ enabled: false }), {
      deduplicationStore: deps.store,
      deliver: deps.deliver,
    });

    await expect(
      watcher.processMessage(messageFixture().message),
    ).resolves.toBe("disabled");
    expect(deps.reserveMudaeWatchNotification).not.toHaveBeenCalled();
    expect(deps.deliver).not.toHaveBeenCalled();
  });

  it.each([
    ["spoofed Mudae name", { authorId: SPOOF_ID }],
    ["human trusted ID", { authorBot: false }],
    ["unconfigured guild", { guildId: OTHER_GUILD_ID }],
    ["unconfigured channel", { channelId: OTHER_CHANNEL_ID }],
    ["cross-guild channel", { channelGuildId: OTHER_GUILD_ID }],
    ["webhook message", { webhookId: "999999999999999999" }],
    ["unavailable guild", { guildAvailable: false }],
  ])("rejects an untrusted source: %s", async (_label, options) => {
    const deps = dependencies();
    const watcher = new PrivateMudaeWatcher(configuration(), {
      deduplicationStore: deps.store,
      deliver: deps.deliver,
    });

    await expect(
      watcher.processMessage(messageFixture(options).message),
    ).resolves.toBe("untrusted-source");
    expect(deps.reserveMudaeWatchNotification).not.toHaveBeenCalled();
    expect(deps.deliver).not.toHaveBeenCalled();
  });

  it("uses case-insensitive, whitespace-normalized but otherwise exact matching", async () => {
    const deps = dependencies();
    const watcher = new PrivateMudaeWatcher(configuration(), {
      deduplicationStore: deps.store,
      deliver: deps.deliver,
      logger: deps.logger,
      now: () => new Date("2026-08-10T10:00:00.000Z"),
    });
    const matching = messageFixture({
      series: "  KAGE   NO JITSURYOKUSHA NI NARITAKUTE!  ",
    });

    await expect(watcher.processMessage(matching.message)).resolves.toBe(
      "native-forwarded",
    );
    expect(deps.reserveMudaeWatchNotification).toHaveBeenCalledWith({
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      sourceMessageId: MESSAGE_ID,
      recipientUserId: RECIPIENT_ID,
      reservedAt: "2026-08-10T10:00:00.000Z",
    });
    expect(deps.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        message: matching.message,
        recipient: matching.recipientUser,
        recipientUserId: RECIPIENT_ID,
        roll: expect.objectContaining({
          seriesName: "KAGE NO JITSURYOKUSHA NI NARITAKUTE!",
        }),
      }),
    );
    expect(deps.completeMudaeWatchNotification).toHaveBeenCalledWith(
      GUILD_ID,
      "reservation-1",
      "delivered",
    );
    expect(deps.logger.info).toHaveBeenCalledWith(
      "Private watcher notification delivered",
      {
        outcome: "native-forwarded",
        stage: "native-forward",
      },
    );
    expect(JSON.stringify(vi.mocked(deps.logger.info!).mock.calls)).not.toMatch(
      /recipient|series|messageContent|answers?/iu,
    );

    const nonmatchingDeps = dependencies();
    const nonmatching = new PrivateMudaeWatcher(configuration(), {
      deduplicationStore: nonmatchingDeps.store,
      deliver: nonmatchingDeps.deliver,
    });
    await expect(
      nonmatching.processMessage(
        messageFixture({
          series: "Kage no Jitsuryokusha ni Naritakute?",
        }).message,
      ),
    ).resolves.toBe("series-not-watched");
    expect(nonmatchingDeps.deliver).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", { recipientCached: false, recipientMissing: true }],
    ["bot", { recipientBot: true }],
    ["foreign guild", { recipientGuildId: OTHER_GUILD_ID }],
  ])(
    "requires a current non-bot recipient member: %s",
    async (_label, options) => {
      const deps = dependencies();
      const watcher = new PrivateMudaeWatcher(configuration(), {
        deduplicationStore: deps.store,
        deliver: deps.deliver,
        logger: deps.logger,
      });

      await expect(
        watcher.processMessage(messageFixture(options).message),
      ).resolves.toBe("recipient-unavailable");
      expect(deps.reserveMudaeWatchNotification).not.toHaveBeenCalled();
      expect(deps.deliver).not.toHaveBeenCalled();
    },
  );

  it("revalidates the source after asynchronous member resolution", async () => {
    const deps = dependencies();
    const harness = messageFixture({ recipientCached: false });
    harness.fetchMember.mockImplementationOnce(async () => {
      Object.assign(harness.guild as object, { available: false });
      return harness.member;
    });
    const watcher = new PrivateMudaeWatcher(configuration(), {
      deduplicationStore: deps.store,
      deliver: deps.deliver,
    });

    await expect(watcher.processMessage(harness.message)).resolves.toBe(
      "untrusted-source",
    );
    expect(deps.reserveMudaeWatchNotification).not.toHaveBeenCalled();
    expect(deps.deliver).not.toHaveBeenCalled();
  });

  it("atomically deduplicates concurrent create/update processing", async () => {
    const deps = dependencies();
    const watcher = new PrivateMudaeWatcher(configuration(), {
      deduplicationStore: deps.store,
      deliver: deps.deliver,
    });
    const message = messageFixture().message;

    await expect(
      Promise.all([
        watcher.processMessage(message),
        watcher.processMessage(message),
      ]),
    ).resolves.toEqual(["native-forwarded", "duplicate"]);
    expect(deps.deliver).toHaveBeenCalledOnce();
    expect(deps.completeMudaeWatchNotification).toHaveBeenCalledOnce();
  });

  it("records fallback as delivered and terminal failure as failed", async () => {
    const fallbackDeps = dependencies({
      status: "fallback-sent",
      nativeFailure: { name: "DiscordAPIError", code: 160_014 },
    });
    const fallback = new PrivateMudaeWatcher(configuration(), {
      deduplicationStore: fallbackDeps.store,
      deliver: fallbackDeps.deliver,
      logger: fallbackDeps.logger,
    });
    await expect(
      fallback.processMessage(messageFixture().message),
    ).resolves.toBe("fallback-sent");
    expect(fallbackDeps.completeMudaeWatchNotification).toHaveBeenCalledWith(
      GUILD_ID,
      "reservation-1",
      "delivered",
    );
    expect(fallbackDeps.logger.warn).toHaveBeenCalledWith(
      "Native Discord forwarding failed, but Superior sent the safe fallback successfully.",
      expect.objectContaining({
        code: 160_014,
        outcome: "fallback-sent",
        stage: "native-forward",
      }),
    );

    const failedDeps = dependencies({
      status: "failed",
      stage: "dm-unavailable",
      failure: { name: "DiscordAPIError", code: 50_007 },
    });
    const failed = new PrivateMudaeWatcher(configuration(), {
      deduplicationStore: failedDeps.store,
      deliver: failedDeps.deliver,
      logger: failedDeps.logger,
    });
    await expect(failed.processMessage(messageFixture().message)).resolves.toBe(
      "delivery-failed",
    );
    expect(failedDeps.completeMudaeWatchNotification).toHaveBeenCalledWith(
      GUILD_ID,
      "reservation-1",
      "failed",
    );
  });

  it("does not mask delivery when completion fails and keeps logs redacted", async () => {
    const deps = dependencies();
    deps.completeMudaeWatchNotification.mockImplementationOnce(() => {
      throw Object.assign(
        new Error(
          `secret ${GUILD_ID} ${CHANNEL_ID} ${MESSAGE_ID} Kage no Jitsuryokusha`,
        ),
        { name: "SqliteError", code: "SQLITE_BUSY" },
      );
    });
    const watcher = new PrivateMudaeWatcher(configuration(), {
      deduplicationStore: deps.store,
      deliver: deps.deliver,
      logger: deps.logger,
    });

    await expect(
      watcher.processMessage(messageFixture().message),
    ).resolves.toBe("native-forwarded");
    expect(deps.logger.error).toHaveBeenCalledWith(
      "Private Mudae watcher could not finalize delivery state",
      {
        outcome: "completion-failed",
        stage: "completion",
        failureName: "SqliteError",
        failureCode: "SQLITE_BUSY",
      },
    );
    const logs = JSON.stringify([
      ...(deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls,
      ...(deps.logger.error as ReturnType<typeof vi.fn>).mock.calls,
    ]);
    expect(logs).not.toMatch(
      new RegExp(`${GUILD_ID}|${CHANNEL_ID}|${MESSAGE_ID}|Jitsuryokusha`, "u"),
    );
  });

  it("fails closed on reservation and unexpected delivery errors", async () => {
    const storageDeps = dependencies();
    storageDeps.reserveMudaeWatchNotification.mockImplementationOnce(() => {
      throw Object.assign(new Error(`private ${MESSAGE_ID}`), {
        name: "SqliteError",
        code: "SQLITE_BUSY",
      });
    });
    const storageFailure = new PrivateMudaeWatcher(configuration(), {
      deduplicationStore: storageDeps.store,
      deliver: storageDeps.deliver,
      logger: storageDeps.logger,
    });
    await expect(
      storageFailure.processMessage(messageFixture().message),
    ).resolves.toBe("storage-failed");
    expect(storageDeps.deliver).not.toHaveBeenCalled();

    const deliveryDeps = dependencies();
    deliveryDeps.deliver.mockRejectedValueOnce(
      Object.assign(new Error(`private ${RECIPIENT_ID}`), {
        name: "DiscordAPIError",
        code: 50_007,
      }),
    );
    const deliveryFailure = new PrivateMudaeWatcher(configuration(), {
      deduplicationStore: deliveryDeps.store,
      deliver: deliveryDeps.deliver,
      logger: deliveryDeps.logger,
    });
    await expect(
      deliveryFailure.processMessage(messageFixture().message),
    ).resolves.toBe("delivery-failed");
    expect(deliveryDeps.completeMudaeWatchNotification).toHaveBeenCalledWith(
      GUILD_ID,
      "reservation-1",
      "failed",
    );
    expect(
      JSON.stringify(
        (deliveryDeps.logger.error as ReturnType<typeof vi.fn>).mock.calls,
      ),
    ).not.toContain(RECIPIENT_ID);
  });
});
