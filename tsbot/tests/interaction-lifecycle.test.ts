import {
  MessageFlags,
  type ButtonInteraction,
  type Interaction,
} from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyError } from "../src/errors.js";
import { startImmediateInteractionResponse } from "../src/discord/immediate-interaction-response.js";
import {
  AUTOCOMPLETE_FALLBACK_MS,
  beginInteractionLifecycle,
  replyWithUnexpectedInteractionError,
  runBoundedAutocomplete,
} from "../src/discord/interaction-lifecycle.js";
import type { BotRuntime } from "../src/runtime.js";

const GUILD_ID = "123456789012345678";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function commandInteraction(input: {
  now: number;
  deferReply?: (options: unknown) => Promise<unknown>;
}) {
  let deferredState = false;
  const deferReply = vi.fn(
    input.deferReply ??
      (async () => {
        deferredState = true;
      }),
  );
  return {
    createdTimestamp: input.now,
    guildId: GUILD_ID,
    commandName: "utility",
    options: { getSubcommand: vi.fn(() => "server") },
    get deferred() {
      return deferredState;
    },
    replied: false,
    responded: false,
    deferReply,
    reply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    isButton: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
  } as unknown as Interaction & {
    deferReply: ReturnType<typeof vi.fn>;
    reply: ReturnType<typeof vi.fn>;
    editReply: ReturnType<typeof vi.fn>;
    followUp: ReturnType<typeof vi.fn>;
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("interaction acknowledgement lifecycle", () => {
  it.each([
    ["report", "submit"],
    ["appeal", "submit"],
  ])(
    "preserves the initial response for /%s %s",
    async (commandName, subcommand) => {
      const interaction = commandInteraction({ now: Date.now() }) as never as {
        commandName: string;
        options: { getSubcommand: ReturnType<typeof vi.fn> };
        deferReply: ReturnType<typeof vi.fn>;
      };
      interaction.commandName = commandName;
      interaction.options.getSubcommand = vi.fn(() => subcommand);
      const lifecycle = beginInteractionLifecycle(interaction as never, {
        correlationId: () => `${commandName}-modal-first`,
      });
      await expect(lifecycle.ready).resolves.toBe(true);
      expect(interaction.deferReply).not.toHaveBeenCalled();
    },
  );

  it.each([
    "superior:report:open:abcdefgh",
    "superior:report:resolve:abcdefgh:lz6y5w00",
    "superior:report:dismiss:abcdefgh:lz6y5w00",
    "superior:appeal:open:abcdefgh",
    "superior:appeal:uphold:abcdefgh:lz6y5w00",
    "superior:appeal:overturn:abcdefgh:lz6y5w00",
  ])("preserves modal-first button route %s", async (customId) => {
    const interaction = {
      createdTimestamp: Date.now(),
      guildId: GUILD_ID,
      customId,
      deferred: false,
      replied: false,
      deferReply: vi.fn(async () => undefined),
      isAutocomplete: () => false,
      isChatInputCommand: () => false,
      isButton: () => true,
      isModalSubmit: () => false,
      isStringSelectMenu: () => false,
    } as unknown as Interaction & { deferReply: ReturnType<typeof vi.fn> };
    const lifecycle = beginInteractionLifecycle(interaction, {
      correlationId: () => "phase3-button-modal-first",
    });
    await expect(lifecycle.ready).resolves.toBe(true);
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });

  it.each([
    ["report", { getUser: () => ({ id: "223456789012345678" }) }],
    ["appeal", { getInteger: () => 42 }],
  ])(
    "opens the /%s submit modal as the first response",
    async (commandName, extraOptions) => {
      const showModal = vi.fn(async () => undefined);
      const interaction = {
        createdTimestamp: Date.now(),
        guildId: GUILD_ID,
        guild: { id: GUILD_ID },
        commandName,
        options: {
          getSubcommand: vi.fn(() => "submit"),
          ...extraOptions,
        },
        deferred: false,
        replied: false,
        showModal,
        reply: vi.fn(async () => undefined),
        deferReply: vi.fn(async () => undefined),
        isAutocomplete: () => false,
        isChatInputCommand: () => true,
        isButton: () => false,
        isModalSubmit: () => false,
        isStringSelectMenu: () => false,
      } as unknown as Interaction & {
        showModal: ReturnType<typeof vi.fn>;
        deferReply: ReturnType<typeof vi.fn>;
      };
      const runtime = {
        interactionFormsForGuild: vi.fn(() => null),
      } as unknown as BotRuntime;
      const lifecycle = beginInteractionLifecycle(interaction, {
        correlationId: () => `${commandName}-immediate-modal`,
      });
      await expect(lifecycle.ready).resolves.toBe(true);
      await expect(
        startImmediateInteractionResponse(interaction, runtime, lifecycle),
      ).resolves.toBe("handled");
      expect(showModal).toHaveBeenCalledOnce();
      expect(interaction.deferReply).not.toHaveBeenCalled();
    },
  );

  it.each([
    "superior:report:open:abcdefgh",
    "superior:report:resolve:record0001:lz6y5w00",
    "superior:report:dismiss:record0001:lz6y5w00",
    "superior:appeal:open:abcdefgh",
    "superior:appeal:uphold:record0001:lz6y5w00",
    "superior:appeal:overturn:record0001:lz6y5w00",
  ])("opens the immediate Phase 3 button modal for %s", async (customId) => {
    const botId = "923456789012345678";
    const showModal = vi.fn(async () => undefined);
    const interaction = {
      createdTimestamp: Date.now(),
      guildId: GUILD_ID,
      guild: { id: GUILD_ID },
      customId,
      message: { id: "423456789012345678", author: { id: botId } },
      client: { user: { id: botId } },
      deferred: false,
      replied: false,
      showModal,
      reply: vi.fn(async () => undefined),
      deferReply: vi.fn(async () => undefined),
      isAutocomplete: () => false,
      isChatInputCommand: () => false,
      isButton: () => true,
      isModalSubmit: () => false,
      isStringSelectMenu: () => false,
    } as unknown as Interaction & {
      showModal: ReturnType<typeof vi.fn>;
      deferReply: ReturnType<typeof vi.fn>;
    };
    const runtime = {
      interactionFormsForGuild: vi.fn(() => null),
    } as unknown as BotRuntime;
    const lifecycle = beginInteractionLifecycle(interaction, {
      correlationId: () => "phase3-immediate-button",
    });
    await expect(lifecycle.ready).resolves.toBe(true);
    await expect(
      startImmediateInteractionResponse(interaction, runtime, lifecycle),
    ).resolves.toBe("handled");
    expect(showModal).toHaveBeenCalledOnce();
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });

  it("starts the private acknowledgement before delayed storage work", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 11, 12);
    vi.setSystemTime(now);
    const acknowledgement = deferred<void>();
    const order: string[] = [];
    vi.spyOn(console, "log").mockImplementation(() => {
      order.push("terminal-log");
    });
    const interaction = commandInteraction({
      now,
      deferReply: async (options) => {
        order.push(`ack:${JSON.stringify(options)}`);
        await acknowledgement.promise;
      },
    });
    const lifecycle = beginInteractionLifecycle(interaction, {
      now: Date.now,
      correlationId: () => "receipt-order",
    });
    const storageWork = vi.fn(() => order.push("storage"));
    const run = lifecycle.ready.then((ready) => {
      if (ready) storageWork();
    });

    expect(interaction.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });
    expect(storageWork).not.toHaveBeenCalled();
    acknowledgement.resolve();
    await run;
    const acknowledgementIndex = order.findIndex((entry) =>
      entry.startsWith("ack:"),
    );
    const terminalLogIndex = order.indexOf("terminal-log");
    expect(acknowledgementIndex).toBeGreaterThanOrEqual(0);
    expect(terminalLogIndex).toBeGreaterThanOrEqual(0);
    expect(acknowledgementIndex).toBeLessThan(terminalLogIndex);
    expect(order.at(-1)).toBe("storage");
  });

  it("prevents a handler-level defer from double-acknowledging", async () => {
    const interaction = commandInteraction({ now: Date.now() });
    const lifecycle = beginInteractionLifecycle(interaction, {
      correlationId: () => "single-ack",
    });
    await expect(lifecycle.ready).resolves.toBe(true);

    const deferrable = interaction as unknown as {
      deferred: boolean;
      replied: boolean;
      deferReply: (options: unknown) => Promise<unknown>;
    };
    if (!deferrable.deferred && !deferrable.replied) {
      await deferrable.deferReply({ flags: MessageFlags.Ephemeral });
    }
    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
  });

  it("does not acknowledge or execute an interaction already stale at receipt", async () => {
    const now = Date.UTC(2026, 7, 11, 12);
    const interaction = commandInteraction({ now: now - 3_100 });
    const lifecycle = beginInteractionLifecycle(interaction, {
      now: () => now,
      correlationId: () => "stale-receipt",
      eventLoopDelay: () => ({ maxMs: 2_900, p99Ms: 2_850, meanMs: 40 }),
    });

    await expect(lifecycle.ready).resolves.toBe(false);
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });

  it("classifies 10062 and never attempts a doomed recovery response", async () => {
    const expired = Object.assign(new Error("Unknown interaction"), {
      name: "DiscordAPIError[10062]",
      code: 10062,
    });
    const interaction = commandInteraction({
      now: Date.now(),
      deferReply: async () => {
        throw expired;
      },
    });
    const lifecycle = beginInteractionLifecycle(interaction, {
      correlationId: () => "expired-ack",
    });

    await expect(lifecycle.ready).resolves.toBe(false);
    const response = await replyWithUnexpectedInteractionError(
      interaction as never,
      classifyError(expired),
      "unexpected",
    );
    expect(response).toBe(false);
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.editReply).not.toHaveBeenCalled();
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it("classifies Discord's already-acknowledged response without retrying", () => {
    const classified = classifyError(
      Object.assign(new Error("Interaction has already been acknowledged"), {
        code: 40060,
      }),
    );
    expect(classified).toMatchObject({
      category: "interaction-acknowledged",
      code: 40060,
      retryable: false,
    });
  });

  it("uses one bounded autocomplete response when slow work misses its budget", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 11, 12);
    vi.setSystemTime(now);
    const work = deferred<void>();
    let responded = false;
    const respond = vi.fn(async () => {
      responded = true;
    });
    const interaction = {
      createdTimestamp: now,
      guildId: GUILD_ID,
      commandName: "application",
      options: { getSubcommand: vi.fn(() => "submit") },
      get responded() {
        return responded;
      },
      deferred: false,
      replied: false,
      respond,
      isAutocomplete: () => true,
      isChatInputCommand: () => false,
      isButton: () => false,
      isModalSubmit: () => false,
      isStringSelectMenu: () => false,
    } as unknown as Interaction;
    const lifecycle = beginInteractionLifecycle(interaction, {
      now: Date.now,
      correlationId: () => "autocomplete-timeout",
    });
    const run = runBoundedAutocomplete(
      interaction as never,
      lifecycle,
      async () => {
        await work.promise;
        await (
          interaction as never as { respond: (choices: []) => Promise<void> }
        ).respond([]);
      },
    );

    await vi.advanceTimersByTimeAsync(AUTOCOMPLETE_FALLBACK_MS);
    expect(respond).toHaveBeenCalledTimes(1);
    work.resolve();
    await expect(run).resolves.toBe("fallback");
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it("returns an empty autocomplete result when a handler completes without responding", async () => {
    let responded = false;
    const respond = vi.fn(async () => {
      responded = true;
    });
    const interaction = {
      createdTimestamp: Date.now(),
      guildId: GUILD_ID,
      commandName: "application",
      options: { getSubcommand: vi.fn(() => "submit") },
      get responded() {
        return responded;
      },
      deferred: false,
      replied: false,
      respond,
      isAutocomplete: () => true,
      isChatInputCommand: () => false,
      isButton: () => false,
      isModalSubmit: () => false,
      isStringSelectMenu: () => false,
    } as unknown as Interaction;
    const lifecycle = beginInteractionLifecycle(interaction, {
      correlationId: () => "autocomplete-missing-response",
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      runBoundedAutocomplete(interaction as never, lifecycle, async () => {}),
    ).resolves.toBe("fallback");
    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith([]);
  });

  it("acknowledges autocomplete with an empty result before rethrowing a handler failure", async () => {
    const failure = new Error("synthetic autocomplete failure");
    let responded = false;
    const order: string[] = [];
    const respond = vi.fn(async () => {
      order.push("fallback-response");
      responded = true;
    });
    const interaction = {
      createdTimestamp: Date.now(),
      guildId: GUILD_ID,
      commandName: "application",
      options: { getSubcommand: vi.fn(() => "submit") },
      get responded() {
        return responded;
      },
      deferred: false,
      replied: false,
      respond,
      isAutocomplete: () => true,
      isChatInputCommand: () => false,
      isButton: () => false,
      isModalSubmit: () => false,
      isStringSelectMenu: () => false,
    } as unknown as Interaction;
    const lifecycle = beginInteractionLifecycle(interaction, {
      correlationId: () => "autocomplete-handler-failure",
    });
    vi.spyOn(console, "warn").mockImplementation(() => {
      order.push("terminal-warning");
    });

    await expect(
      runBoundedAutocomplete(interaction as never, lifecycle, async () => {
        order.push("handler-failed");
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(order).toEqual([
      "handler-failed",
      "fallback-response",
      "terminal-warning",
    ]);
    expect(respond).toHaveBeenCalledOnce();
  });

  it("starts an immediate modal response before writing its receipt log", async () => {
    const now = Date.now();
    const order: string[] = [];
    const botId = "923456789012345678";
    const showModal = vi.fn(async () => {
      order.push("show-modal");
    });
    const interaction = {
      createdTimestamp: now,
      guildId: GUILD_ID,
      guild: { id: GUILD_ID },
      customId: "superior:suggestion:open:abcdefgh",
      message: {
        id: "423456789012345678",
        author: { id: botId },
      },
      client: { user: { id: botId } },
      deferred: false,
      replied: false,
      responded: false,
      showModal,
      reply: vi.fn(async () => undefined),
      isAutocomplete: () => false,
      isChatInputCommand: () => false,
      isButton: () => true,
      isModalSubmit: () => false,
      isStringSelectMenu: () => false,
    } as unknown as ButtonInteraction;
    const runtime = {
      interactionFormsForGuild: vi.fn(() => ({
        guildId: GUILD_ID,
        suggestionConfiguration: {
          enabled: true,
          bindingsVerifiedAt: new Date(now).toISOString(),
        },
        applicationForms: [],
        ticketDepartments: [],
      })),
    } as unknown as BotRuntime;
    vi.spyOn(console, "log").mockImplementation(() => {
      order.push("terminal-log");
    });

    const lifecycle = beginInteractionLifecycle(interaction, {
      correlationId: () => "modal-before-log",
    });
    const response = startImmediateInteractionResponse(
      interaction,
      runtime,
      lifecycle,
    );

    expect(showModal).toHaveBeenCalledOnce();
    expect(order[0]).toBe("show-modal");
    await expect(response).resolves.toBe("handled");
    await Promise.resolve();
    expect(order).toContain("terminal-log");
  });

  it("starts one private acknowledgement when immediate snapshot building fails", async () => {
    const order: string[] = [];
    const botId = "923456789012345678";
    const reply = vi.fn(async () => {
      order.push("recovery-reply");
    });
    const interaction = {
      createdTimestamp: Date.now(),
      guildId: GUILD_ID,
      guild: { id: GUILD_ID },
      customId: "superior:suggestion:open:abcdefgh",
      message: {
        id: "423456789012345678",
        author: { id: botId },
      },
      client: { user: { id: botId } },
      deferred: false,
      replied: false,
      responded: false,
      showModal: vi.fn(async () => undefined),
      reply,
      isAutocomplete: () => false,
      isChatInputCommand: () => false,
      isButton: () => true,
      isModalSubmit: () => false,
      isStringSelectMenu: () => false,
    } as unknown as ButtonInteraction;
    const runtime = {
      interactionFormsForGuild: vi.fn(() => {
        throw new Error("synthetic snapshot failure");
      }),
    } as unknown as BotRuntime;
    vi.spyOn(console, "log").mockImplementation(() => {
      order.push("terminal-log");
    });
    vi.spyOn(console, "error").mockImplementation(() => {
      order.push("terminal-error");
    });

    const lifecycle = beginInteractionLifecycle(interaction, {
      correlationId: () => "snapshot-recovery",
    });
    const response = startImmediateInteractionResponse(
      interaction,
      runtime,
      lifecycle,
    );

    expect(reply).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledWith({
      content:
        "Superior could not prepare that control safely. Try the current command or panel again.",
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    expect(order[0]).toBe("recovery-reply");
    await expect(response).resolves.toBe("handled");
    expect(order.indexOf("recovery-reply")).toBeLessThan(
      order.indexOf("terminal-error"),
    );
  });
});
