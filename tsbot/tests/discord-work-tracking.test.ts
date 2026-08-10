import type { EventEmitter } from "node:events";
import type { ChatInputCommandInteraction, Message } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDiscordClient,
  getDiscordClientWorkLifecycle,
} from "../src/discord/bot.js";
import type { BotRuntime, GuildRuntime } from "../src/runtime.js";

const GUILD_ID = "123456789012345678";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("Discord work tracking", () => {
  const clients: ReturnType<typeof createDiscordClient>[] = [];
  afterEach(() => {
    for (const client of clients) client.destroy();
    clients.length = 0;
  });

  it("drains command and message work through one shutdown lifecycle", async () => {
    const commandRuntime = deferred<GuildRuntime | null>();
    const messageRuntime = deferred<GuildRuntime | null>();
    const forGuild = vi
      .fn<BotRuntime["forGuild"]>()
      .mockImplementationOnce(() => commandRuntime.promise)
      .mockImplementationOnce(() => messageRuntime.promise);
    const runtime = { forGuild } as unknown as BotRuntime;
    const client = createDiscordClient(runtime);
    clients.push(client);
    const emitter = client as unknown as EventEmitter;
    const reply = vi.fn(async () => undefined);
    const interaction = {
      guildId: GUILD_ID,
      guild: { id: GUILD_ID, name: "Tracking Guild" },
      commandName: "utility",
      options: { getSubcommand: vi.fn(() => "ping") },
      reply,
      isAutocomplete: () => false,
      isChatInputCommand: () => true,
      isButton: () => false,
      isModalSubmit: () => false,
    } as unknown as ChatInputCommandInteraction;
    const message = {
      guildId: GUILD_ID,
      guild: { id: GUILD_ID },
      channel: { guildId: GUILD_ID },
      content: "superior ping",
      author: { id: "223456789012345678", bot: false },
      client,
    } as unknown as Message;

    emitter.emit("interactionCreate", interaction);
    emitter.emit("messageCreate", message);
    await vi.waitFor(() => expect(forGuild).toHaveBeenCalledTimes(2));

    const lifecycle = getDiscordClientWorkLifecycle(client);
    lifecycle?.stop();
    let completed = false;
    const drain = lifecycle?.drain(1_000).then((result) => {
      completed = true;
      return result;
    });

    commandRuntime.resolve(null);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
    expect(completed).toBe(false);
    messageRuntime.resolve(null);
    await expect(drain).resolves.toBe(true);
  });

  it("stops accepting new tracked work after shutdown begins", async () => {
    const runtime = {
      forGuild: vi.fn(async () => null),
    } as unknown as BotRuntime;
    const client = createDiscordClient(runtime);
    clients.push(client);
    const lifecycle = getDiscordClientWorkLifecycle(client);
    lifecycle?.stop();
    (client as unknown as EventEmitter).emit("messageCreate", {
      guildId: GUILD_ID,
      guild: { id: GUILD_ID },
      author: { bot: false },
      content: "superior ping",
    });
    await expect(lifecycle?.drain(100)).resolves.toBe(true);
    expect(runtime.forGuild).not.toHaveBeenCalled();
  });

  it("drains private watcher message-update work during shutdown", async () => {
    const watcherWork = deferred<"duplicate">();
    const processMessage = vi.fn(() => watcherWork.promise);
    const runtime = {
      forGuild: vi.fn(async () => null),
      privateMudaeWatcher: {
        enabled: true,
        isConfiguredLocation: vi.fn(() => true),
        isTrustedAuthor: vi.fn(() => true),
        isCandidate: vi.fn(() => true),
        processMessage,
      },
    } as unknown as BotRuntime;
    const client = createDiscordClient(runtime);
    clients.push(client);
    const message = {
      partial: false,
      guildId: GUILD_ID,
      guild: { id: GUILD_ID },
      channelId: "223456789012345678",
      channel: { guildId: GUILD_ID },
      author: { id: "323456789012345678", bot: true },
    } as unknown as Message;

    (client as unknown as EventEmitter).emit("messageUpdate", message, message);
    await vi.waitFor(() => expect(processMessage).toHaveBeenCalledOnce());

    const lifecycle = getDiscordClientWorkLifecycle(client);
    lifecycle?.stop();
    let completed = false;
    const drain = lifecycle?.drain(1_000).then((result) => {
      completed = true;
      return result;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    watcherWork.resolve("duplicate");
    await expect(drain).resolves.toBe(true);
  });
});
