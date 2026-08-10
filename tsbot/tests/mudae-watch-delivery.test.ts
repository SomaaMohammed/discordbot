import { EmbedBuilder, type Message, type User } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildDiscordMessageUrl,
  deliverPrivateMudaeWatchNotification,
} from "../src/mudae-watch-delivery.js";
import type { ParsedMudaeRoll } from "../src/mudae-roll-parser.js";

const GUILD_ID = "111111111111111111";
const CHANNEL_ID = "222222222222222222";
const MESSAGE_ID = "333333333333333333";
const RECIPIENT_ID = "444444444444444444";
const IMAGE_URL = "https://cdn.discordapp.com/attachments/1/2/lily.png";

function fixture(
  options: {
    send?: ReturnType<typeof vi.fn>;
    createDmFailure?: unknown;
    recipientId?: string;
    recipientBot?: boolean;
    imageUrl?: string;
  } = {},
) {
  const send = options.send ?? vi.fn(async () => undefined);
  const createDM = options.createDmFailure
    ? vi.fn(async () => Promise.reject(options.createDmFailure))
    : vi.fn(async () => ({ send }));
  const recipient = {
    id: options.recipientId ?? RECIPIENT_ID,
    bot: options.recipientBot ?? false,
    createDM,
  } as unknown as User;
  const message = {
    id: MESSAGE_ID,
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    url: "https://attacker.invalid/not-the-source",
  } as unknown as Message;
  const roll: ParsedMudaeRoll = {
    characterName: "Lily @everyone",
    seriesName: "Kage <@&999999999999999999>",
    normalizedSeries: "kage <@&999999999999999999>",
    imageUrl: options.imageUrl ?? IMAGE_URL,
    sourceEmbedIndex: 0,
  };
  return { send, createDM, recipient, message, roll };
}

describe("private Mudae notification delivery", () => {
  it("uses one native forward with a constructed jump URL and no mentions", async () => {
    const harness = fixture();

    await expect(
      deliverPrivateMudaeWatchNotification({
        message: harness.message,
        recipient: harness.recipient,
        recipientUserId: RECIPIENT_ID,
        roll: harness.roll,
      }),
    ).resolves.toEqual({ status: "native-forwarded" });

    expect(harness.createDM).toHaveBeenCalledOnce();
    expect(harness.send).toHaveBeenCalledOnce();
    expect(harness.send).toHaveBeenCalledWith({
      content:
        "A watched Mudae series rolled. [Open the original roll](https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333)",
      forward: {
        message: MESSAGE_ID,
        channel: CHANNEL_ID,
        guild: GUILD_ID,
      },
      allowedMentions: { parse: [], repliedUser: false },
    });
    expect(JSON.stringify(harness.send.mock.calls)).not.toContain(
      "attacker.invalid",
    );
  });

  it("falls back to a safe embed without copying content or components", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("private native detail"), {
          name: "DiscordAPIError",
          code: 160_014,
        }),
      )
      .mockResolvedValueOnce(undefined);
    const harness = fixture({ send });

    const result = await deliverPrivateMudaeWatchNotification({
      message: harness.message,
      recipient: harness.recipient,
      recipientUserId: RECIPIENT_ID,
      roll: harness.roll,
    });

    expect(result).toEqual({
      status: "fallback-sent",
      nativeFailure: { name: "DiscordAPIError", code: 160_014 },
    });
    expect(send).toHaveBeenCalledTimes(2);
    const fallback = send.mock.calls[1]?.[0] as {
      content: string;
      embeds: EmbedBuilder[];
      allowedMentions: unknown;
      forward?: unknown;
      components?: unknown;
    };
    expect(fallback.content).not.toContain("@everyone");
    expect(fallback.allowedMentions).toEqual({
      parse: [],
      repliedUser: false,
    });
    expect(fallback.forward).toBeUndefined();
    expect(fallback.components).toBeUndefined();
    expect(fallback.embeds).toHaveLength(1);
    expect(fallback.embeds[0]?.toJSON()).toMatchObject({
      title: "Mudae roll: Lily @everyone",
      description: "Series: Kage <@&999999999999999999>",
      image: { url: IMAGE_URL },
      url: buildDiscordMessageUrl(GUILD_ID, CHANNEL_ID, MESSAGE_ID),
    });
    expect(JSON.stringify(result)).not.toContain("private native detail");
  });

  it("does not retry a terminal closed-DM error", async () => {
    const send = vi.fn().mockRejectedValue(
      Object.assign(new Error("closed private DM"), {
        name: "DiscordAPIError",
        code: 50_007,
      }),
    );
    const harness = fixture({ send });

    const result = await deliverPrivateMudaeWatchNotification({
      message: harness.message,
      recipient: harness.recipient,
      recipientUserId: RECIPIENT_ID,
      roll: harness.roll,
    });

    expect(send).toHaveBeenCalledOnce();
    expect(result).toEqual({
      status: "failed",
      stage: "dm-unavailable",
      failure: { name: "DiscordAPIError", code: 50_007 },
    });
    expect(JSON.stringify(result)).not.toContain("closed private DM");
  });

  it("isolates DM-open and fallback failures with redacted descriptors", async () => {
    const openFailure = fixture({
      createDmFailure: Object.assign(new Error("private user detail"), {
        name: "DiscordAPIError",
        code: 50_007,
      }),
    });
    await expect(
      deliverPrivateMudaeWatchNotification({
        message: openFailure.message,
        recipient: openFailure.recipient,
        recipientUserId: RECIPIENT_ID,
        roll: openFailure.roll,
      }),
    ).resolves.toEqual({
      status: "failed",
      stage: "dm-open",
      failure: { name: "DiscordAPIError", code: 50_007 },
    });

    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("native secret"))
      .mockRejectedValueOnce(new Error("fallback secret"));
    const fallbackFailure = fixture({ send });
    const result = await deliverPrivateMudaeWatchNotification({
      message: fallbackFailure.message,
      recipient: fallbackFailure.recipient,
      recipientUserId: RECIPIENT_ID,
      roll: fallbackFailure.roll,
    });
    expect(result).toMatchObject({
      status: "failed",
      stage: "fallback",
      failure: { name: "Error", code: null },
      nativeFailure: { name: "Error", code: null },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /native secret|fallback secret/u,
    );
  });

  it("rejects a mismatched or bot recipient before opening a DM", async () => {
    const mismatch = fixture({ recipientId: "555555555555555555" });
    await expect(
      deliverPrivateMudaeWatchNotification({
        message: mismatch.message,
        recipient: mismatch.recipient,
        recipientUserId: RECIPIENT_ID,
        roll: mismatch.roll,
      }),
    ).resolves.toMatchObject({
      status: "failed",
      stage: "recipient-validation",
    });
    expect(mismatch.createDM).not.toHaveBeenCalled();

    const bot = fixture({ recipientBot: true });
    await deliverPrivateMudaeWatchNotification({
      message: bot.message,
      recipient: bot.recipient,
      recipientUserId: RECIPIENT_ID,
      roll: bot.roll,
    });
    expect(bot.createDM).not.toHaveBeenCalled();
  });

  it("omits non-remote images from fallback without downloading them", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("forward unsupported"))
      .mockResolvedValueOnce(undefined);
    const harness = fixture({ send, imageUrl: "attachment://lily.png" });

    await deliverPrivateMudaeWatchNotification({
      message: harness.message,
      recipient: harness.recipient,
      recipientUserId: RECIPIENT_ID,
      roll: harness.roll,
    });

    const fallback = send.mock.calls[1]?.[0] as { embeds: EmbedBuilder[] };
    expect(fallback.embeds[0]?.toJSON().image).toBeUndefined();
  });
});
