import { DateTime } from "luxon";
import type { Client, GuildMember, Message } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { wireRuntimeParity } from "../src/discord/runtime-parity.js";
import { createDefaultGuildSettings } from "../src/guild-settings.js";
import type { BotRuntime, GuildRuntime } from "../src/runtime.js";

const GUILD_ID = "123456789012345678";
const USER_ID = "234567890123456789";
const BOT_ID = "345678901234567890";
const CHANNEL_ID = "456789012345678901";
const LEGACY_ROLE_ID = "567890123456789012";

type EventHandler = (...args: never[]) => unknown;

function createChatHarness(): {
  emitMessage: (content: string) => Promise<void>;
  send: ReturnType<typeof vi.fn>;
  updateStateAtomic: ReturnType<typeof vi.fn>;
  settings: ReturnType<typeof createDefaultGuildSettings>;
} {
  const callbacks = new Map<string, EventHandler>();
  const send = vi.fn(async () => undefined);
  const updateStateAtomic = vi.fn();
  const settings = createDefaultGuildSettings();
  settings.enabled = true;
  settings.features.invictusChat = true;
  settings.timezone = "Asia/Amman";

  const member = {
    id: USER_ID,
    toString: () => `<@${USER_ID}>`,
    guild: { ownerId: "999999999999999999" },
    permissions: { has: () => false },
    roles: { cache: { has: (roleId: string) => roleId === LEGACY_ROLE_ID } },
  } as unknown as GuildMember;
  const guildRuntime = {
    guildId: GUILD_ID,
    botVersion: "3.1.0-test",
    settings,
    storage: {
      metricsIncrement: vi.fn(),
      buildUserMetricKey: vi.fn(() => `user.${USER_ID}.messages_sent`),
      updateStateAtomic,
    },
    now: () => DateTime.fromISO("2026-07-28T12:34:00", { zone: "Asia/Amman" }),
    randomInt: vi.fn(() => 0),
    isCurrent: vi.fn(() => true),
  } as unknown as GuildRuntime;
  const processRuntime = {
    forGuild: vi.fn(async () => guildRuntime),
  } as unknown as BotRuntime;
  const client = {
    user: { id: BOT_ID },
    ws: { ping: 42 },
    uptime: 90_061_000,
    on: vi.fn((event: string, callback: EventHandler) => {
      callbacks.set(event, callback);
      return client;
    }),
  } as unknown as Client;

  wireRuntimeParity(client, processRuntime);

  return {
    settings,
    send,
    updateStateAtomic,
    async emitMessage(content: string): Promise<void> {
      const handler = callbacks.get("messageCreate");
      if (!handler) {
        throw new Error("messageCreate handler was not registered");
      }
      const message = {
        content,
        author: { id: USER_ID, bot: false },
        guildId: GUILD_ID,
        guild: { id: GUILD_ID },
        member,
        channel: { id: CHANNEL_ID, send },
        createdAt: new Date("2026-07-28T09:34:00Z"),
        client,
      } as unknown as Message;
      await handler(message as never);
    },
  };
}

function lastPayload(send: ReturnType<typeof vi.fn>): {
  content: string;
  allowedMentions: { parse: unknown[] };
} {
  const payload = send.mock.calls.at(-1)?.[0] as
    { content: string; allowedMentions: { parse: unknown[] } } | undefined;
  if (!payload) {
    throw new Error("Expected a sent message");
  }
  return payload;
}

describe("Superior conversational utilities", () => {
  it("returns neutral, mention-safe utility responses", async () => {
    const { emitMessage, send } = createChatHarness();

    await emitMessage("superior help");
    expect(lastPayload(send).content).toContain("superior roll 2d6");
    expect(lastPayload(send).content).not.toMatch(
      /court|imperial|throne|decree|omen/i,
    );

    await emitMessage("<@345678901234567890> ping");
    expect(lastPayload(send).content).toBe(
      "🏓 Pong! Gateway latency: `42 ms`.",
    );

    await emitMessage("superior uptime");
    expect(lastPayload(send).content).toBe("Uptime: `1d 1h 1m 1s`.");

    await emitMessage("superior about");
    expect(lastPayload(send).content).toContain("Superior `v3.1.0-test`");
    expect(lastPayload(send).content).toContain("multi-server");

    await emitMessage("superior what time is it");
    expect(lastPayload(send).content).toContain("Asia/Amman");
    expect(lastPayload(send).content).not.toContain("Court time");

    await emitMessage("superior roll 2d6");
    expect(lastPayload(send).content).toBe("🎲 Rolled **2d6**: 1 + 1 = **2**.");

    await emitMessage("superior choose **admin** or normal");
    expect(lastPayload(send).content).toBe("I choose **\\*\\*admin\\*\\***.");

    for (const [payload] of send.mock.calls) {
      expect(payload).toMatchObject({ allowedMentions: { parse: [] } });
      expect(payload.content).not.toMatch(/court|imperial|throne|decree|omen/i);
    }
  });

  it("honors each guild's keyword and aliases without broad matching", async () => {
    const { emitMessage, send, settings } = createChatHarness();
    settings.invocation.keyword = "helper";
    settings.invocation.aliases = ["oracle.v2+"];

    await emitMessage("superior ping");
    await emitMessage("This helper has good latency");
    expect(send).not.toHaveBeenCalled();

    await emitMessage("oracle.v2+: ping");
    expect(send).toHaveBeenCalledTimes(1);
    expect(lastPayload(send).content).toContain("42 ms");
  });

  it("does not answer when Superior chat is disabled", async () => {
    const { emitMessage, send, settings } = createChatHarness();
    settings.features.invictusChat = false;

    await emitMessage("superior ping");

    expect(send).not.toHaveBeenCalled();
  });

  it("never reinterprets moderation-shaped messages as casual chat", async () => {
    const { emitMessage, send, settings } = createChatHarness();
    settings.features.replyModeration = true;

    await emitMessage("superior mute for ping spam");
    await emitMessage("superior timeout because they need help");
    await emitMessage("superior mute for saying goodbye");

    expect(send).not.toHaveBeenCalled();
  });

  it("keeps persisted royal and silence flags dormant", async () => {
    const { emitMessage, send, settings, updateStateAtomic } =
      createChatHarness();
    settings.features.invictusChat = false;
    settings.features.royalAfk = true;
    settings.features.royalPresence = true;
    settings.features.silenceLock = true;
    settings.roles.emperor = LEGACY_ROLE_ID;
    settings.channels.royalAlert = CHANNEL_ID;

    await emitMessage("silence the court");
    await emitMessage("The emperor has arrived");

    expect(updateStateAtomic).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("explains rejected dice and choice bounds", async () => {
    const { emitMessage, send } = createChatHarness();

    await emitMessage("superior roll 21d6");
    expect(lastPayload(send).content).toBe(
      "Roll between 1 and 20 dice at a time.",
    );

    await emitMessage("superior choose only one");
    expect(lastPayload(send).content).toContain("between 2 and 20 choices");
  });
});
