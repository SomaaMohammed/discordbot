import { DateTime } from "luxon";
import { describe, expect, it, vi } from "vitest";
import type { ChatInputCommandInteraction, GuildMember } from "discord.js";
import { handleChatInputCommand } from "../src/discord/commands.js";
import type { BotRuntime } from "../src/runtime.js";
import type { CourtState, MetricsShape, PostRecord } from "../src/types.js";

function buildState(overrides: Partial<CourtState> = {}): CourtState {
  return {
    mode: "auto",
    hour: 20,
    minute: 15,
    channel_id: 123456789,
    log_channel_id: 0,
    last_posted_date: "2026-04-19",
    dry_run_auto_post: false,
    last_dry_run_date: null,
    last_weekly_digest_week: null,
    history: ["Question A", "Question B", "Question C"],
    used_questions: ["Question A", "Question B"],
    posts: [],
    metrics: buildMetrics(),
    royal_presence: {
      last_message_at_by_title: {
        Emperor: null,
        Empress: null,
      },
      last_message_at: null,
      last_speaker: null,
    },
    royal_afk: {
      by_title: {
        Emperor: {
          active: false,
          reason: "",
          set_at: null,
          set_by_user_id: null,
        },
        Empress: {
          active: false,
          reason: "",
          set_at: null,
          set_by_user_id: null,
        },
      },
    },
    ...overrides,
  };
}

function buildMetrics(overrides: Partial<MetricsShape> = {}): MetricsShape {
  return {
    command_usage: {},
    command_failures: {},
    posts_by_category: {},
    posts_total: 0,
    posts_auto: 0,
    posts_manual: 0,
    custom_posts: 0,
    answers_total: 0,
    last_successful_auto_post: null,
    ...overrides,
  };
}

type StorageMock = {
  getState: ReturnType<typeof vi.fn<() => CourtState>>;
  getQuestions: ReturnType<typeof vi.fn<() => Record<string, string[]>>>;
  listPostRecords: ReturnType<
    typeof vi.fn<(includeClosed?: boolean, limit?: number) => PostRecord[]>
  >;
  metricsSnapshot: ReturnType<typeof vi.fn<() => MetricsShape>>;
  countAllAnswerRecords: ReturnType<typeof vi.fn<() => number>>;
  recordCommandMetric: ReturnType<typeof vi.fn<(commandName: string) => void>>;
  updateStateAtomic: ReturnType<
    typeof vi.fn<(mutator: (state: CourtState) => void) => CourtState>
  >;
};

function buildPost(
  messageId: string,
  postedAt: string,
  closed = false,
): PostRecord {
  return {
    message_id: messageId,
    thread_id: null,
    channel_id: "123456789",
    category: "general",
    question: `Question ${messageId}`,
    posted_at: postedAt,
    close_after_hours: 24,
    closed,
    closed_at: null,
    close_reason: null,
  };
}

function createStorageMock(
  initialState: CourtState,
  metrics: MetricsShape,
  posts: PostRecord[],
): StorageMock {
  let mutableState = { ...initialState };

  return {
    getState: vi.fn(() => mutableState),
    getQuestions: vi.fn(() => ({ general: ["A", "B"], gaming: ["C"] })),
    listPostRecords: vi.fn(() => posts),
    metricsSnapshot: vi.fn(() => metrics),
    countAllAnswerRecords: vi.fn(() => 6),
    recordCommandMetric: vi.fn(),
    updateStateAtomic: vi.fn((mutator: (state: CourtState) => void) => {
      const next = { ...mutableState };
      mutator(next);
      mutableState = next;
      return next;
    }),
  };
}

function createRuntimeMock(storage: StorageMock, now: DateTime): BotRuntime {
  return {
    config: {
      botVersion: "0.2.0-test",
      timezoneName: "UTC",
      staffRoleIdsText: new Set<string>(["777"]),
      courtChannelIdText: "0",
      courtChannelId: 0,
      logChannelIdText: "0",
      logChannelId: 0,
      dbFile: "./tests/does-not-exist.sqlite3",
      undefeatedUserId: 1,
    } as unknown as BotRuntime["config"],
    storage: storage as unknown as BotRuntime["storage"],
    backfillStatus: {
      running: false,
      started_at: null,
      lookback_days: null,
      initiated_by_user_id: null,
      last_started_at: null,
      last_completed_at: null,
      last_status: "idle",
      last_summary: null,
      last_error: null,
    },
    now: () => now,
    randomInt: () => 0,
  };
}

type InteractionMockInput = {
  commandName: string;
  subcommand: string;
  isAdmin?: boolean;
  ownerId?: string;
  boolOptions?: Record<string, boolean | null>;
};

type InteractionMockOutput = {
  interaction: ChatInputCommandInteraction;
  reply: ReturnType<typeof vi.fn<(payload: unknown) => Promise<void>>>;
};

function createInteractionMock(
  input: InteractionMockInput,
): InteractionMockOutput {
  const isAdmin = input.isAdmin ?? true;
  const ownerId = input.ownerId ?? "9999";
  const userId = "1001";

  const member = {
    permissions: {
      has: vi.fn(() => isAdmin),
    },
    user: {
      bot: false,
      tag: "member#0001",
    },
    toString: vi.fn(() => `<@${userId}>`),
    roles: {
      cache: {
        some: vi.fn(() => false),
        has: vi.fn(() => false),
      },
      highest: {
        comparePositionTo: vi.fn(() => 1),
      },
    },
    guild: { ownerId },
    id: userId,
  } as unknown as GuildMember;

  const guild = {
    ownerId,
    members: {
      fetch: vi.fn(async () => member),
      me: null,
      fetchMe: vi.fn(async () => null),
    },
    channels: {
      cache: new Map<string, unknown>(),
      fetch: vi.fn(async () => null),
    },
  } as unknown as NonNullable<ChatInputCommandInteraction["guild"]>;

  const reply = vi.fn(async (_payload: unknown) => undefined);

  const options = {
    getSubcommand: vi.fn(() => input.subcommand),
    getBoolean: vi.fn((name: string) => input.boolOptions?.[name] ?? null),
    getString: vi.fn(() => null),
    getInteger: vi.fn(() => null),
    getChannel: vi.fn(() => null),
    getRole: vi.fn(() => null),
    getUser: vi.fn(() => null),
    getAttachment: vi.fn(() => null),
  } as unknown as ChatInputCommandInteraction["options"];

  const interaction = {
    commandName: input.commandName,
    options,
    guild,
    user: { id: userId },
    channel: null,
    reply,
    deferReply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  } as unknown as ChatInputCommandInteraction;

  return {
    interaction,
    reply,
  };
}

describe("command parity dispatch", () => {
  it("handles /court status with python parity fields and records metric", async () => {
    const now = DateTime.fromISO("2026-04-19T12:00:00Z");
    const state = buildState();
    const posts = [
      buildPost("1", now.minus({ hours: 2 }).toISO() ?? now.toISO() ?? ""),
      buildPost("2", now.minus({ hours: 4 }).toISO() ?? now.toISO() ?? ""),
    ];
    const storage = createStorageMock(state, buildMetrics(), posts);
    const runtime = createRuntimeMock(storage, now);
    const { interaction, reply } = createInteractionMock({
      commandName: "court",
      subcommand: "status",
      isAdmin: true,
    });

    await handleChatInputCommand(interaction, runtime);

    expect(storage.recordCommandMetric).toHaveBeenCalledWith("court.status");
    expect(reply).toHaveBeenCalledTimes(1);

    const payload = reply.mock.calls[0]?.[0] as {
      content: string;
      ephemeral: boolean;
    };
    expect(payload.ephemeral).toBe(true);
    expect(payload.content).toContain("**Version:** `0.2.0-test`");
    expect(payload.content).toContain("**Mode:** `auto`");
    expect(payload.content).toContain("**Recent Memory Size:** `3`");
    expect(payload.content).toContain("**Used Pool Size:** `2`");
    expect(payload.content).toContain("**Open Court Threads:** `2`");
  });

  it("handles /court health and includes DB presence information", async () => {
    const now = DateTime.fromISO("2026-04-19T13:15:00Z");
    const state = buildState();
    const posts = [
      buildPost("1", now.minus({ hours: 26 }).toISO() ?? now.toISO() ?? ""),
    ];
    const storage = createStorageMock(state, buildMetrics(), posts);
    const runtime = createRuntimeMock(storage, now);
    const { interaction, reply } = createInteractionMock({
      commandName: "court",
      subcommand: "health",
      isAdmin: true,
    });

    await handleChatInputCommand(interaction, runtime);

    expect(storage.recordCommandMetric).toHaveBeenCalledWith("court.health");
    expect(reply).toHaveBeenCalledTimes(1);

    const payload = reply.mock.calls[0]?.[0] as {
      embeds: Array<{
        toJSON: () => { fields?: Array<{ name: string; value: string }> };
      }>;
      ephemeral: boolean;
    };
    expect(payload.ephemeral).toBe(true);

    const embedJson = payload.embeds[0]?.toJSON();
    const dataField = embedJson?.fields?.find((field) => field.name === "Data");
    expect(dataField?.value).toContain("**DB:** `missing`");
  });

  it("handles /court analytics and includes top command/category lines", async () => {
    const now = DateTime.fromISO("2026-04-19T15:30:00Z");
    const todayIso = now.toISO() ?? "";
    const yesterdayIso = now.minus({ days: 1 }).toISO() ?? "";
    const state = buildState();
    const posts = [
      buildPost("1", todayIso),
      buildPost("2", yesterdayIso),
      buildPost("3", yesterdayIso, true),
    ];

    const metrics = buildMetrics({
      posts_total: 9,
      posts_auto: 5,
      posts_manual: 3,
      custom_posts: 1,
      answers_total: 12,
      posts_by_category: {
        general: 4,
        gaming: 2,
      },
      command_usage: {
        "court.status": 10,
        "court.post": 7,
      },
    });

    const storage = createStorageMock(state, metrics, posts);
    const runtime = createRuntimeMock(storage, now);
    const { interaction, reply } = createInteractionMock({
      commandName: "court",
      subcommand: "analytics",
      isAdmin: true,
    });

    await handleChatInputCommand(interaction, runtime);

    expect(storage.recordCommandMetric).toHaveBeenCalledWith("court.analytics");
    expect(reply).toHaveBeenCalledTimes(1);

    const payload = reply.mock.calls[0]?.[0] as {
      embeds: Array<{
        toJSON: () => { fields?: Array<{ name: string; value: string }> };
      }>;
      ephemeral: boolean;
    };
    expect(payload.ephemeral).toBe(true);

    const embedJson = payload.embeds[0]?.toJSON();
    const topCommands = embedJson?.fields?.find(
      (field) => field.name === "Top Commands",
    );
    const topCategories = embedJson?.fields?.find(
      (field) => field.name === "Top Categories",
    );

    expect(topCommands?.value).toContain("`court.status`: `10`");
    expect(topCategories?.value).toContain("`general`: `4`");
  });

  it("handles /court dryrun lifecycle mutation and records metric", async () => {
    const now = DateTime.fromISO("2026-04-19T16:00:00Z");
    const state = buildState({
      dry_run_auto_post: false,
      last_dry_run_date: "2026-04-18",
    });
    const storage = createStorageMock(state, buildMetrics(), []);
    const runtime = createRuntimeMock(storage, now);
    const { interaction, reply } = createInteractionMock({
      commandName: "court",
      subcommand: "dryrun",
      isAdmin: true,
      boolOptions: { enabled: true },
    });

    await handleChatInputCommand(interaction, runtime);

    expect(storage.updateStateAtomic).toHaveBeenCalledTimes(1);
    expect(storage.recordCommandMetric).toHaveBeenCalledWith("court.dryrun");

    const nextState = storage.getState();
    expect(nextState.dry_run_auto_post).toBe(true);

    const payload = reply.mock.calls[0]?.[0] as {
      content: string;
      ephemeral: boolean;
    };
    expect(payload.ephemeral).toBe(true);
    expect(payload.content).toContain("`enabled`");
  });

  it("blocks /invictus lock for non-admin members", async () => {
    const now = DateTime.fromISO("2026-04-19T18:00:00Z");
    const storage = createStorageMock(buildState(), buildMetrics(), []);
    const runtime = createRuntimeMock(storage, now);
    const { interaction, reply } = createInteractionMock({
      commandName: "invictus",
      subcommand: "lock",
      isAdmin: false,
      ownerId: "another-owner",
    });

    await handleChatInputCommand(interaction, runtime);

    expect(reply).toHaveBeenCalledTimes(1);
    const payload = reply.mock.calls[0]?.[0] as {
      content: string;
      ephemeral: boolean;
    };
    expect(payload.ephemeral).toBe(true);
    expect(payload.content).toBe(
      "You do not have permission to use this command.",
    );
    expect(storage.recordCommandMetric).not.toHaveBeenCalledWith(
      "invictus.lock",
    );
  });

  it("handles /invictus rolepanel with missing channel context", async () => {
    const now = DateTime.fromISO("2026-04-19T19:00:00Z");
    const storage = createStorageMock(buildState(), buildMetrics(), []);
    const runtime = createRuntimeMock(storage, now);
    const { interaction, reply } = createInteractionMock({
      commandName: "invictus",
      subcommand: "rolepanel",
      isAdmin: true,
    });

    await handleChatInputCommand(interaction, runtime);

    expect(reply).toHaveBeenCalledTimes(1);
    const payload = reply.mock.calls[0]?.[0] as {
      content: string;
      ephemeral: boolean;
    };
    expect(payload.ephemeral).toBe(true);
    expect(payload.content).toBe(
      "Provide a text channel, or run this command from a text channel.",
    );
  });

  it("handles /invictus dmpanel with missing channel context", async () => {
    const now = DateTime.fromISO("2026-04-19T19:10:00Z");
    const storage = createStorageMock(buildState(), buildMetrics(), []);
    const runtime = createRuntimeMock(storage, now);
    const { interaction, reply } = createInteractionMock({
      commandName: "invictus",
      subcommand: "dmpanel",
      isAdmin: true,
    });

    await handleChatInputCommand(interaction, runtime);

    expect(reply).toHaveBeenCalledTimes(1);
    const payload = reply.mock.calls[0]?.[0] as {
      content: string;
      ephemeral: boolean;
    };
    expect(payload.ephemeral).toBe(true);
    expect(payload.content).toBe(
      "Provide a text-based channel, or run this command from a text-based channel.",
    );
  });

  it("blocks /invictus timeout when target is self", async () => {
    const now = DateTime.fromISO("2026-04-19T19:30:00Z");
    const storage = createStorageMock(buildState(), buildMetrics(), []);
    const runtime = createRuntimeMock(storage, now);
    const { interaction, reply } = createInteractionMock({
      commandName: "invictus",
      subcommand: "timeout",
      isAdmin: true,
    });

    const getUser = interaction.options.getUser as unknown as ReturnType<
      typeof vi.fn
    >;
    getUser.mockImplementation((name: string) => {
      if (name === "member") {
        return { id: "1001" };
      }
      return null;
    });

    const getInteger = interaction.options.getInteger as unknown as ReturnType<
      typeof vi.fn
    >;
    getInteger.mockImplementation((name: string) => {
      if (name === "minutes") {
        return 15;
      }
      return null;
    });

    const me = {
      id: "2000",
      roles: {
        highest: {
          comparePositionTo: vi.fn(() => 1),
        },
      },
    } as unknown as GuildMember;
    (interaction.guild as { members: { me: GuildMember | null } }).members.me =
      me;

    await handleChatInputCommand(interaction, runtime);

    expect(reply).toHaveBeenCalledTimes(1);
    const payload = reply.mock.calls[0]?.[0] as {
      content: string;
      ephemeral: boolean;
    };
    expect(payload.ephemeral).toBe(true);
    expect(payload.content).toContain("target is yourself");
    expect(storage.recordCommandMetric).not.toHaveBeenCalledWith(
      "invictus.timeout",
    );
  });
});
