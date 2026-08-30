import type { EventEmitter } from "node:events";
import {
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDiscordClient,
  getDiscordClientWorkLifecycle,
} from "../src/discord/bot.js";
import type { BotRuntime, GuildRuntime } from "../src/runtime.js";

const memberLifecycleHandlers = vi.hoisted(() => ({
  added: vi.fn<(...args: unknown[]) => Promise<void>>(),
  updated: vi.fn<(...args: unknown[]) => Promise<void>>(),
  removed: vi.fn<(...args: unknown[]) => Promise<void>>(),
}));

vi.mock(
  "../src/discord/member-lifecycle-discord.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../src/discord/member-lifecycle-discord.js")
    >()),
    handleGuildMemberAdded: memberLifecycleHandlers.added,
    handleGuildMemberUpdated: memberLifecycleHandlers.updated,
    handleGuildMemberRemoved: memberLifecycleHandlers.removed,
  }),
);

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
      // Message work can reach runtime loading while the interaction waits for
      // its immediately-started Discord acknowledgement to settle.
      .mockImplementationOnce(() => messageRuntime.promise)
      .mockImplementationOnce(() => commandRuntime.promise);
    const runtime = { forGuild } as unknown as BotRuntime;
    const client = createDiscordClient(runtime);
    clients.push(client);
    const emitter = client as unknown as EventEmitter;
    let interactionDeferred = false;
    const deferReply = vi.fn(async () => {
      interactionDeferred = true;
    });
    const editReply = vi.fn(async () => undefined);
    const interaction = {
      createdTimestamp: Date.now(),
      guildId: GUILD_ID,
      guild: { id: GUILD_ID, name: "Tracking Guild" },
      commandName: "utility",
      options: { getSubcommand: vi.fn(() => "ping") },
      get deferred() {
        return interactionDeferred;
      },
      replied: false,
      responded: false,
      deferReply,
      editReply,
      reply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
      isAutocomplete: () => false,
      isChatInputCommand: () => true,
      isButton: () => false,
      isModalSubmit: () => false,
      isStringSelectMenu: () => false,
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
    expect(deferReply).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(forGuild).toHaveBeenCalledTimes(2));

    const lifecycle = getDiscordClientWorkLifecycle(client);
    lifecycle?.stop();
    let completed = false;
    const drain = lifecycle?.drain(1_000).then((result) => {
      completed = true;
      return result;
    });

    commandRuntime.resolve(null);
    await vi.waitFor(() => expect(editReply).toHaveBeenCalledTimes(1));
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

  it("drains nonessential storage work before shutdown closes its lifecycle", async () => {
    const workGate = deferred<void>();
    let scheduleNonessential!: (task: () => void | Promise<void>) => void;
    const runtime = {
      forGuild: vi.fn(async () => null),
      storage: {
        setNonessentialScheduler: vi.fn(
          (scheduler: (task: () => void | Promise<void>) => void) => {
            scheduleNonessential = scheduler;
          },
        ),
      },
    } as unknown as BotRuntime;
    const client = createDiscordClient(runtime);
    clients.push(client);
    scheduleNonessential(() => workGate.promise);

    const lifecycle = getDiscordClientWorkLifecycle(client)!;
    lifecycle.stop();
    let completed = false;
    const drain = lifecycle.drain(1_000).then((result) => {
      completed = true;
      return result;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    workGate.resolve();
    await expect(drain).resolves.toBe(true);
  });

  it("tracks and drains every member lifecycle gateway event", async () => {
    const runtime = {
      forGuild: vi.fn(async () => null),
    } as unknown as BotRuntime;
    const member = {
      id: "223456789012345678",
      guild: { id: GUILD_ID },
    };
    const oldMember = { ...member, pending: true };
    const newMember = { ...member, pending: false };
    const cases = [
      {
        event: "guildMemberAdd",
        handler: memberLifecycleHandlers.added,
        emit: (emitter: EventEmitter) => emitter.emit("guildMemberAdd", member),
      },
      {
        event: "guildMemberUpdate",
        handler: memberLifecycleHandlers.updated,
        emit: (emitter: EventEmitter) =>
          emitter.emit("guildMemberUpdate", oldMember, newMember),
      },
      {
        event: "guildMemberRemove",
        handler: memberLifecycleHandlers.removed,
        emit: (emitter: EventEmitter) =>
          emitter.emit("guildMemberRemove", member),
      },
    ] as const;
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      for (const current of cases) {
        const handlerGate = deferred<void>();
        current.handler.mockReset();
        current.handler
          .mockImplementationOnce(() => handlerGate.promise)
          .mockRejectedValueOnce(
            new Error(`${current.event} rejection must be handled`),
          );
        const client = createDiscordClient(runtime);
        clients.push(client);
        const emitter = client as unknown as EventEmitter;

        current.emit(emitter);
        await vi.waitFor(() =>
          expect(current.handler).toHaveBeenCalledTimes(1),
        );
        current.emit(emitter);
        await vi.waitFor(() =>
          expect(current.handler).toHaveBeenCalledTimes(2),
        );

        const lifecycle = getDiscordClientWorkLifecycle(client);
        expect(lifecycle).not.toBeNull();
        lifecycle!.stop();
        current.emit(emitter);
        await Promise.resolve();
        expect(current.handler).toHaveBeenCalledTimes(2);

        let drainCompleted = false;
        const drain = lifecycle!.drain(1_000).then((result) => {
          drainCompleted = true;
          return result;
        });
        await Promise.resolve();
        expect(drainCompleted).toBe(false);

        handlerGate.resolve();
        await expect(drain).resolves.toBe(true);
      }

      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("requests one fatal controlled shutdown when Discord invalidates the session", async () => {
    const runtime = {
      forGuild: vi.fn(async () => null),
    } as unknown as BotRuntime;
    const onFatalGatewayInvalidation = vi.fn(async () => undefined);
    const client = createDiscordClient(runtime, {
      onFatalGatewayInvalidation,
    });
    clients.push(client);
    const emitter = client as unknown as EventEmitter;

    emitter.emit("invalidated");
    emitter.emit("invalidated");

    await vi.waitFor(() =>
      expect(onFatalGatewayInvalidation).toHaveBeenCalledTimes(1),
    );
  });

  it("acknowledges interactions that arrive during the shutdown drain", async () => {
    const runtime = {
      forGuild: vi.fn(async () => null),
    } as unknown as BotRuntime;
    const client = createDiscordClient(runtime);
    clients.push(client);
    getDiscordClientWorkLifecycle(client)?.stop();
    const reply = vi.fn(async () => undefined);
    const interaction = {
      deferred: false,
      replied: false,
      responded: false,
      reply,
      isAutocomplete: () => false,
      isRepliable: () => true,
      isChatInputCommand: () => true,
      isButton: () => false,
      isModalSubmit: () => false,
      isStringSelectMenu: () => false,
    } as unknown as ChatInputCommandInteraction;

    (client as unknown as EventEmitter).emit("interactionCreate", interaction);

    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("restarting"),
      }),
    );
    expect(runtime.forGuild).not.toHaveBeenCalled();
  });

  it("shows a modal from memory before delayed runtime or database work", async () => {
    const forGuild = vi.fn<BotRuntime["forGuild"]>(
      () => new Promise((resolve) => setTimeout(() => resolve(null), 5_000)),
    );
    const interactionFormsForGuild = vi.fn(() => ({
      guildId: GUILD_ID,
      suggestionConfiguration: {
        enabled: true,
        bindingsVerifiedAt: new Date().toISOString(),
      },
      applicationForms: [],
      ticketDepartments: [],
    }));
    const runtime = {
      forGuild,
      interactionFormsForGuild,
    } as unknown as BotRuntime;
    const client = createDiscordClient(runtime);
    clients.push(client);
    const botId = "923456789012345678";
    let replied = false;
    const showModal = vi.fn(async () => {
      replied = true;
    });
    const interaction = {
      createdTimestamp: Date.now(),
      guildId: GUILD_ID,
      guild: { id: GUILD_ID },
      customId: "superior:suggestion:open:abcdefgh",
      channelId: "323456789012345678",
      message: {
        id: "423456789012345678",
        author: { id: botId },
      },
      client: { user: { id: botId } },
      deferred: false,
      get replied() {
        return replied;
      },
      responded: false,
      showModal,
      reply: vi.fn(async () => undefined),
      isAutocomplete: () => false,
      isChatInputCommand: () => false,
      isButton: () => true,
      isModalSubmit: () => false,
      isStringSelectMenu: () => false,
    } as unknown as ButtonInteraction;

    (client as unknown as EventEmitter).emit("interactionCreate", interaction);

    expect(showModal).toHaveBeenCalledTimes(1);
    expect(interactionFormsForGuild).toHaveBeenCalledWith(GUILD_ID);
    expect(forGuild).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(replied).toBe(true));
    expect(forGuild).not.toHaveBeenCalled();
  });

  it("privately defers legacy role panels before delayed guild runtime work", async () => {
    const acknowledgementGate = deferred<void>();
    const runtimeGate = deferred<GuildRuntime | null>();
    const forGuild = vi.fn<BotRuntime["forGuild"]>(() => runtimeGate.promise);
    const runtime = {
      forGuild,
      interactionFormsForGuild: vi.fn(() => null),
    } as unknown as BotRuntime;
    const client = createDiscordClient(runtime);
    clients.push(client);
    const botId = "923456789012345678";
    let deferredState = false;
    const deferReply = vi.fn(async () => {
      await acknowledgementGate.promise;
      deferredState = true;
    });
    const editReply = vi.fn(async () => undefined);
    const interaction = {
      createdTimestamp: Date.now(),
      guildId: GUILD_ID,
      guild: { id: GUILD_ID },
      customId: "superior:role:323456789012345678",
      channelId: "423456789012345678",
      user: { id: "523456789012345678" },
      message: {
        id: "623456789012345678",
        author: { id: botId },
      },
      client: { user: { id: botId } },
      get deferred() {
        return deferredState;
      },
      replied: false,
      responded: false,
      deferReply,
      editReply,
      reply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
      isAutocomplete: () => false,
      isChatInputCommand: () => false,
      isButton: () => true,
      isModalSubmit: () => false,
      isStringSelectMenu: () => false,
    } as unknown as ButtonInteraction;

    (client as unknown as EventEmitter).emit("interactionCreate", interaction);

    expect(deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });
    expect(forGuild).not.toHaveBeenCalled();

    acknowledgementGate.resolve();
    await vi.waitFor(() => expect(forGuild).toHaveBeenCalledTimes(1));
    expect(deferReply.mock.invocationCallOrder[0]).toBeLessThan(
      forGuild.mock.invocationCallOrder[0]!,
    );

    runtimeGate.resolve(null);
    await vi.waitFor(() => expect(editReply).toHaveBeenCalledTimes(1));
  });

  it("dispatches a utility command through one central acknowledgement", async () => {
    const recordCommandMetric = vi.fn();
    const guildRuntime = {
      guildId: GUILD_ID,
      botVersion: "6.0.0",
      settings: { enabled: true },
      isCurrent: vi.fn(() => true),
      storage: { recordCommandMetric },
    } as unknown as GuildRuntime;
    const forGuild = vi.fn<BotRuntime["forGuild"]>(async () => guildRuntime);
    const runtime = {
      forGuild,
      interactionFormsForGuild: vi.fn(() => null),
    } as unknown as BotRuntime;
    const client = createDiscordClient(runtime);
    clients.push(client);
    let deferredState = false;
    const deferReply = vi.fn(async () => {
      deferredState = true;
    });
    const editReply = vi.fn(async () => undefined);
    const interaction = {
      createdTimestamp: Date.now(),
      guildId: GUILD_ID,
      guild: { id: GUILD_ID, name: "Utility Guild" },
      commandName: "utility",
      options: { getSubcommand: vi.fn(() => "ping") },
      client: { ws: { ping: 42 } },
      get deferred() {
        return deferredState;
      },
      replied: false,
      responded: false,
      deferReply,
      editReply,
      reply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
      isAutocomplete: () => false,
      isChatInputCommand: () => true,
      isButton: () => false,
      isModalSubmit: () => false,
      isStringSelectMenu: () => false,
    } as unknown as ChatInputCommandInteraction;

    (client as unknown as EventEmitter).emit("interactionCreate", interaction);

    await vi.waitFor(() => expect(editReply).toHaveBeenCalledTimes(1));
    expect(deferReply).toHaveBeenCalledOnce();
    expect(deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });
    expect(forGuild).toHaveBeenCalledWith(GUILD_ID);
    expect(recordCommandMetric).toHaveBeenCalledWith("utility.ping");
  });

  it("public-defers greeting work before a delayed guild runtime load", async () => {
    const runtimeGate = deferred<GuildRuntime | null>();
    const forGuild = vi.fn<BotRuntime["forGuild"]>(() => runtimeGate.promise);
    const runtime = {
      forGuild,
      interactionFormsForGuild: vi.fn(() => null),
    } as unknown as BotRuntime;
    const client = createDiscordClient(runtime);
    clients.push(client);
    let deferredState = false;
    const deferReply = vi.fn(async () => {
      deferredState = true;
    });
    const editReply = vi.fn(async () => undefined);
    const interaction = {
      createdTimestamp: Date.now(),
      guildId: GUILD_ID,
      guild: { id: GUILD_ID, name: "Greeting Guild" },
      commandName: "greetings",
      options: { getSubcommand: vi.fn(() => "send") },
      get deferred() {
        return deferredState;
      },
      replied: false,
      responded: false,
      deferReply,
      editReply,
      reply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
      isAutocomplete: () => false,
      isChatInputCommand: () => true,
      isButton: () => false,
      isModalSubmit: () => false,
      isStringSelectMenu: () => false,
    } as unknown as ChatInputCommandInteraction;

    (client as unknown as EventEmitter).emit("interactionCreate", interaction);
    expect(deferReply).toHaveBeenCalledWith({});
    expect(forGuild).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(forGuild).toHaveBeenCalledTimes(1));
    expect(deferReply.mock.invocationCallOrder[0]).toBeLessThan(
      forGuild.mock.invocationCallOrder[0]!,
    );

    runtimeGate.resolve(null);
    await vi.waitFor(() => expect(editReply).toHaveBeenCalledTimes(1));
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
