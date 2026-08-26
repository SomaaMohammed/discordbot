import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Message } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadEmojiRepliesConfig,
  parseEmojiRepliesConfig,
} from "../src/emoji-replies-config.js";
import {
  createEmojiReplyService,
  EmojiReplyService,
} from "../src/emoji-replies-service.js";
import { handleMessageCreate } from "../src/message-runtime.js";
import type { BotRuntime } from "../src/runtime.js";

const SERVER_A = "123456789012345678";
const SERVER_B = "223456789012345678";
const MEMBER_A = "323456789012345678";
const MEMBER_B = "423456789012345678";
const MEMBER_C = "523456789012345678";
const CHANNEL_A = "623456789012345678";
const CHANNEL_B = "723456789012345678";

const temporaryRoots: string[] = [];
const services: EmojiReplyService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("emoji reply configuration", () => {
  it("supports multiple servers, members, channels, and independent modes", async () => {
    const service = track(
      new EmojiReplyService(
        parseEmojiRepliesConfig({
          reactionsEnabled: true,
          repliesEnabled: true,
          servers: {
            [SERVER_A]: {
              members: {
                [MEMBER_A]: { emojis: ["👍🏿", "💀"] },
                [MEMBER_B]: { emojis: ["🔥"] },
              },
            },
            [SERVER_B]: {
              members: {
                [MEMBER_C]: { emojis: ["✅", "🎉"] },
              },
            },
          },
        }),
      ),
    );
    const memberA = makeMessage(SERVER_A, MEMBER_A, CHANNEL_A);
    const memberB = makeMessage(SERVER_A, MEMBER_B, CHANNEL_B);
    const memberC = makeMessage(SERVER_B, MEMBER_C, CHANNEL_A);

    await service.processMessage(memberA.message);
    await service.processMessage(memberB.message);
    await service.processMessage(memberC.message);

    expect(memberA.react).toHaveBeenCalledWith("👍🏿");
    expect(memberA.react).toHaveBeenCalledWith("💀");
    expect(memberA.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "👍🏿💀" }),
    );
    expect(memberB.react).toHaveBeenCalledWith("🔥");
    expect(memberB.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "🔥" }),
    );
    expect(memberC.react).toHaveBeenCalledWith("✅");
    expect(memberC.react).toHaveBeenCalledWith("🎉");
    expect(memberC.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "✅🎉" }),
    );
    expect(memberA.reply.mock.calls[0]?.[0]).toMatchObject({
      allowedMentions: { parse: [], repliedUser: false },
    });
  });

  it("replies immediately, then skips the selected number independently per server and member", async () => {
    const randomInt = vi.fn(() => 2);
    const service = track(
      new EmojiReplyService(
        parseEmojiRepliesConfig({
          reactionsEnabled: true,
          repliesEnabled: true,
          servers: {
            [SERVER_A]: {
              members: {
                [MEMBER_A]: { emojis: ["👍🏿"] },
                [MEMBER_B]: { emojis: ["💀"] },
              },
            },
            [SERVER_B]: {
              members: {
                [MEMBER_A]: { emojis: ["🔥"] },
              },
            },
          },
        }),
        { randomInt },
      ),
    );

    const serverAMemberA = messages(SERVER_A, MEMBER_A, 5, CHANNEL_A);
    const serverAMemberB = messages(SERVER_A, MEMBER_B, 2, CHANNEL_A);
    const serverBMemberA = messages(SERVER_B, MEMBER_A, 2, CHANNEL_A);
    for (const message of [
      ...serverAMemberA,
      ...serverAMemberB,
      ...serverBMemberA,
    ]) {
      await service.processMessage(message.message);
    }

    expect(
      serverAMemberA.map((entry) => entry.reply.mock.calls.length),
    ).toEqual([1, 0, 0, 0, 1]);
    expect(
      serverAMemberB.map((entry) => entry.reply.mock.calls.length),
    ).toEqual([1, 0]);
    expect(
      serverBMemberA.map((entry) => entry.reply.mock.calls.length),
    ).toEqual([1, 0]);
    for (const entry of [
      ...serverAMemberA,
      ...serverAMemberB,
      ...serverBMemberA,
    ]) {
      expect(entry.react).toHaveBeenCalledTimes(1);
    }
    expect(randomInt).toHaveBeenCalledTimes(4);
  });

  it("keeps reaction and reply modes independently switchable", async () => {
    const reactionsOnly = track(
      new EmojiReplyService(
        parseEmojiRepliesConfig({
          reactionsEnabled: true,
          repliesEnabled: false,
          servers: {
            [SERVER_A]: { members: { [MEMBER_A]: { emojis: ["✅", "🔥"] } } },
          },
        }),
      ),
    );
    const reactionMessage = makeMessage(SERVER_A, MEMBER_A, CHANNEL_A);
    await reactionsOnly.processMessage(reactionMessage.message);
    expect(reactionMessage.react).toHaveBeenCalledTimes(2);
    expect(reactionMessage.reply).not.toHaveBeenCalled();

    const repliesOnly = track(
      new EmojiReplyService(
        parseEmojiRepliesConfig({
          reactionsEnabled: false,
          repliesEnabled: true,
          servers: {
            [SERVER_A]: { members: { [MEMBER_A]: { emojis: ["✅", "🔥"] } } },
          },
        }),
      ),
    );
    const replyMessage = makeMessage(SERVER_A, MEMBER_A, CHANNEL_A);
    await repliesOnly.processMessage(replyMessage.message);
    expect(replyMessage.react).not.toHaveBeenCalled();
    expect(replyMessage.reply).toHaveBeenCalledTimes(1);

    const disabled = track(
      new EmojiReplyService(
        parseEmojiRepliesConfig({
          reactionsEnabled: false,
          repliesEnabled: false,
          servers: {
            [SERVER_A]: { members: { [MEMBER_A]: { emojis: ["✅"] } } },
          },
        }),
      ),
    );
    const disabledMessage = makeMessage(SERVER_A, MEMBER_A, CHANNEL_A);
    await disabled.processMessage(disabledMessage.message);
    expect(disabledMessage.react).not.toHaveBeenCalled();
    expect(disabledMessage.reply).not.toHaveBeenCalled();
  });

  it("ignores bots, webhooks, and members not configured in the matching server", async () => {
    const service = track(
      new EmojiReplyService(
        parseEmojiRepliesConfig({
          reactionsEnabled: true,
          repliesEnabled: true,
          servers: {
            [SERVER_A]: { members: { [MEMBER_A]: { emojis: ["✅"] } } },
          },
        }),
      ),
    );
    const bot = makeMessage(SERVER_A, MEMBER_A, CHANNEL_A, { bot: true });
    const webhook = makeMessage(SERVER_A, MEMBER_A, CHANNEL_A, {
      webhookId: "webhook",
    });
    const otherMember = makeMessage(SERVER_A, MEMBER_B, CHANNEL_A);
    const otherServer = makeMessage(SERVER_B, MEMBER_A, CHANNEL_A);

    await Promise.all(
      [bot, webhook, otherMember, otherServer].map((entry) =>
        service.processMessage(entry.message),
      ),
    );

    for (const entry of [bot, webhook, otherMember, otherServer]) {
      expect(entry.react).not.toHaveBeenCalled();
      expect(entry.reply).not.toHaveBeenCalled();
    }
  });

  it("continues using the last valid file after invalid JSON and disables removed members after reload", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "superior-emoji-replies-"),
    );
    temporaryRoots.push(root);
    const filePath = path.join(root, "emoji-replies.json");
    const valid = {
      reactionsEnabled: true,
      repliesEnabled: true,
      servers: { [SERVER_A]: { members: { [MEMBER_A]: { emojis: ["✅"] } } } },
    };
    fs.writeFileSync(filePath, JSON.stringify(valid), "utf8");
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const service = track(
      createEmojiReplyService(root, { randomInt: () => 0 }),
    );

    const first = makeMessage(SERVER_A, MEMBER_A, CHANNEL_A);
    await service.processMessage(first.message);
    expect(first.reply).toHaveBeenCalledTimes(1);

    fs.writeFileSync(filePath, "{ invalid", "utf8");
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    expect(
      service.currentConfiguration?.servers[SERVER_A]?.members[MEMBER_A],
    ).toBeDefined();
    const afterInvalid = makeMessage(SERVER_A, MEMBER_A, CHANNEL_A);
    await service.processMessage(afterInvalid.message);
    expect(afterInvalid.react).toHaveBeenCalledTimes(1);

    fs.writeFileSync(
      filePath,
      JSON.stringify({ ...valid, servers: { [SERVER_A]: { members: {} } } }),
      "utf8",
    );
    await vi.waitFor(() =>
      expect(
        service.currentConfiguration?.servers[SERVER_A]?.members[MEMBER_A],
      ).toBeUndefined(),
    );
    const removed = makeMessage(SERVER_A, MEMBER_A, CHANNEL_A);
    await service.processMessage(removed.message);
    expect(removed.react).not.toHaveBeenCalled();
    expect(removed.reply).not.toHaveBeenCalled();
  });

  it("reports invalid IDs and Unicode values without activating the file", () => {
    const loaded = loadEmojiRepliesConfig(
      makeRootWithFile(
        JSON.stringify({
          reactionsEnabled: true,
          repliesEnabled: true,
          servers: {
            "not-a-server": { members: { [MEMBER_A]: { emojis: ["✅"] } } },
          },
        }),
      ),
    );
    expect(loaded.status).toBe("invalid");
    if (loaded.status === "invalid") {
      expect(loaded.issues.join(" ")).toContain("Discord snowflake");
    }

    expect(() =>
      parseEmojiRepliesConfig({
        reactionsEnabled: true,
        repliesEnabled: true,
        servers: {
          [SERVER_A]: { members: { [MEMBER_A]: { emojis: [":custom:"] } } },
        },
      }),
    ).toThrow(/standard Unicode emoji/);
  });

  it("handles Discord reaction and reply failures without rejecting message processing", async () => {
    const service = track(
      new EmojiReplyService(
        parseEmojiRepliesConfig({
          reactionsEnabled: true,
          repliesEnabled: true,
          servers: {
            [SERVER_A]: { members: { [MEMBER_A]: { emojis: ["✅", "🔥"] } } },
          },
        }),
      ),
    );
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const message = makeMessage(SERVER_A, MEMBER_A, CHANNEL_A);
    message.react.mockRejectedValueOnce(new Error("missing Add Reactions"));
    message.reply.mockRejectedValueOnce(new Error("missing Send Messages"));

    await expect(
      service.processMessage(message.message),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(2);
  });

  it("runs from the shared message pipeline without requiring a normal guild runtime", async () => {
    const service = track(
      new EmojiReplyService(
        parseEmojiRepliesConfig({
          reactionsEnabled: true,
          repliesEnabled: true,
          servers: {
            [SERVER_A]: { members: { [MEMBER_A]: { emojis: ["✅"] } } },
          },
        }),
      ),
    );
    const entry = makeMessage(SERVER_A, MEMBER_A, CHANNEL_A);
    const runtime = {
      emojiReplies: service,
      forGuild: vi.fn(async () => null),
    } as unknown as BotRuntime;

    await handleMessageCreate(entry.message, runtime);

    expect(entry.react).toHaveBeenCalledWith("✅");
    expect(entry.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "✅" }),
    );
    expect(runtime.forGuild).toHaveBeenCalledWith(SERVER_A);
  });
});

function track(service: EmojiReplyService): EmojiReplyService {
  services.push(service);
  return service;
}

function makeRootWithFile(contents: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "superior-emoji-config-"));
  temporaryRoots.push(root);
  fs.writeFileSync(path.join(root, "emoji-replies.json"), contents, "utf8");
  return root;
}

function messages(
  guildId: string,
  memberId: string,
  count: number,
  channelId: string,
): Array<ReturnType<typeof makeMessage>> {
  return Array.from({ length: count }, () =>
    makeMessage(guildId, memberId, channelId),
  );
}

function makeMessage(
  guildId: string,
  memberId: string,
  channelId: string,
  options: { bot?: boolean; webhookId?: string | null } = {},
): {
  message: Message;
  react: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
} {
  const react = vi.fn(async () => undefined);
  const reply = vi.fn(async () => undefined);
  return {
    message: {
      id: "823456789012345678",
      guildId,
      guild: { id: guildId },
      channel: { guildId },
      channelId,
      author: { id: memberId, bot: options.bot ?? false },
      webhookId: options.webhookId ?? null,
      react,
      reply,
    } as unknown as Message,
    react,
    reply,
  };
}
