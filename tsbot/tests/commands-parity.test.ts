import { DateTime } from "luxon";
import { describe, expect, it, vi } from "vitest";
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  GuildMember,
} from "discord.js";
import {
  handleButtonInteraction,
  handleChatInputCommand,
} from "../src/discord/commands.js";
import { createDefaultGuildSettings } from "../src/guild-settings.js";
import { buildRolePanelButtonCustomId } from "../src/parity.js";
import type { BotRuntime, GuildRuntime } from "../src/runtime.js";
import type { CourtState, MetricsShape, PostRecord } from "../src/types.js";

const GUILD_ID = "123456789012345678";

function buildState(overrides: Partial<CourtState> = {}): CourtState {
  return {
    last_posted_date: "2026-04-19",
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
  getPostRecord: ReturnType<typeof vi.fn<(messageId: string) => PostRecord | null>>;
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
    getPostRecord: vi.fn(() => null),
    recordCommandMetric: vi.fn(),
    updateStateAtomic: vi.fn((mutator: (state: CourtState) => void) => {
      const next = { ...mutableState };
      mutator(next);
      mutableState = next;
      return next;
    }),
  };
}

type RuntimeMock = BotRuntime & { guildRuntime: GuildRuntime };

function createRuntimeMock(storage: StorageMock, now: DateTime): RuntimeMock {
  const processConfig = {
      discordToken: "test-token",
      botVersion: "0.2.0-test",
      dbFile: "./tests/does-not-exist.sqlite3",
      commandRegistrationMode: "global" as const,
      devGuildIds: [],
      botOperatorUserIds: [],
      schedulerConcurrency: 2,
  };
  const settings = createDefaultGuildSettings();
  settings.enabled = true;
  settings.features.court = true;
  settings.channels.court = "123456789012345679";
  settings.roles.staff = ["123456789012345777"];
  settings.courtSchedule = {
    mode: "auto",
    hour: 20,
    minute: 15,
    dryRun: false,
  };

  const guildRuntime = {
    guildId: GUILD_ID,
    botVersion: processConfig.botVersion,
    storage: storage as unknown as BotRuntime["storage"],
    settings,
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
    generation: 0,
    now: () => now,
    randomInt: () => 0,
    isCurrent: () => true,
    invalidate: vi.fn(),
    refreshSettings: vi.fn(async () => guildRuntime.settings),
    saveSettings: vi.fn(async (nextSettings) => {
      guildRuntime.settings = structuredClone(nextSettings);
      return guildRuntime.settings;
    }),
    setEnabled: vi.fn(async (enabled: boolean) => {
      guildRuntime.settings.enabled = enabled;
      return guildRuntime.settings;
    }),
  } as unknown as GuildRuntime;

  return {
    processConfig,
    storage: {
      ensureGuild: vi.fn(),
    } as unknown as BotRuntime["storage"],
    randomInt: () => 0,
    forGuild: vi.fn(async (guildId: string) =>
      guildId === GUILD_ID ? guildRuntime : null,
    ),
    invalidateGuild: vi.fn(),
    guildRuntime,
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
  showModal: ReturnType<typeof vi.fn<(payload: unknown) => Promise<void>>>;
  deferReply: ReturnType<typeof vi.fn<(payload: unknown) => Promise<void>>>;
  editReply: ReturnType<typeof vi.fn<(payload: unknown) => Promise<void>>>;
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
    id: GUILD_ID,
    name: "Test Guild",
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
  const showModal = vi.fn(async (_payload: unknown) => undefined);
  const deferReply = vi.fn(async (_payload: unknown) => undefined);
  const editReply = vi.fn(async (_payload: unknown) => undefined);

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
    guildId: GUILD_ID,
    options,
    guild,
    user: { id: userId },
    channel: null,
    reply,
    deferReply,
    editReply,
    showModal,
    followUp: vi.fn(async () => undefined),
  } as unknown as ChatInputCommandInteraction;

  return {
    interaction,
    reply,
    showModal,
    deferReply,
    editReply,
  };
}

describe("command parity dispatch", () => {
  it("does not create setup state for an unauthorized unconfigured guild", async () => {
    const { interaction, reply } = createInteractionMock({
      commandName: "setup",
      subcommand: "status",
      isAdmin: false,
      ownerId: "999999999999999999",
    });
    const ensureGuild = vi.fn();
    const runtime = {
      storage: { ensureGuild },
      forGuild: vi.fn(async () => null),
    } as unknown as BotRuntime;

    await handleChatInputCommand(interaction, runtime);

    expect(ensureGuild).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      content:
        "Only the server owner or a member with Administrator permission can use setup.",
      ephemeral: true,
    });
  });

  it("rejects a component whose message belongs to another guild", async () => {
    const reply = vi.fn(async () => undefined);
    const interaction = {
      guildId: GUILD_ID,
      guild: { id: GUILD_ID },
      message: { guildId: "999999999999999999" },
      customId: "court:anonymous_answer",
      reply,
    } as unknown as ButtonInteraction;
    const runtime = {
      forGuild: vi.fn(),
    } as unknown as BotRuntime;

    await handleButtonInteraction(interaction, runtime);

    expect(runtime.forGuild).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      content: "This component does not belong to this server.",
      ephemeral: true,
    });
  });

  it("rejects a forged encoded role-panel button before resolving its role", async () => {
    const now = DateTime.fromISO("2026-04-19T12:00:00Z");
    const storage = createStorageMock(buildState(), buildMetrics(), []);
    const runtime = createRuntimeMock(storage, now);
    const reply = vi.fn(async () => undefined);
    const fetchMember = vi.fn();
    const roleId = "777777777777777777";
    const interaction = {
      guildId: GUILD_ID,
      guild: {
        id: GUILD_ID,
        members: { fetch: fetchMember },
        roles: { cache: new Map(), fetch: vi.fn() },
      },
      client: { user: { id: "888888888888888888" } },
      message: {
        id: "999999999999999999",
        guildId: GUILD_ID,
        author: { id: "666666666666666666" },
        embeds: [],
      },
      customId: buildRolePanelButtonCustomId(roleId),
      user: { id: "555555555555555555" },
      reply,
    } as unknown as ButtonInteraction;

    await handleButtonInteraction(interaction, runtime);

    expect(reply).toHaveBeenCalledWith({
      content: "This component was not created by this bot.",
      ephemeral: true,
    });
    expect(fetchMember).not.toHaveBeenCalled();
  });

  it("rejects a bot-authored anonymous button without a scoped post record", async () => {
    const now = DateTime.fromISO("2026-04-19T12:00:00Z");
    const storage = createStorageMock(buildState(), buildMetrics(), []);
    const runtime = createRuntimeMock(storage, now);
    runtime.guildRuntime.settings.features.anonymousAnswers = true;
    const reply = vi.fn(async () => undefined);
    const showModal = vi.fn(async () => undefined);
    const botId = "888888888888888888";
    const messageId = "999999999999999999";
    const channelId = "444444444444444444";
    const interaction = {
      guildId: GUILD_ID,
      guild: { id: GUILD_ID },
      channelId,
      client: { user: { id: botId } },
      message: {
        id: messageId,
        guildId: GUILD_ID,
        channelId,
        author: { id: botId },
      },
      customId: "court:anonymous_answer",
      reply,
      showModal,
    } as unknown as ButtonInteraction;

    await handleButtonInteraction(interaction, runtime);

    expect(storage.getPostRecord).toHaveBeenCalledWith(messageId);
    expect(showModal).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      content: "This button is not attached to a current court post in this server.",
      ephemeral: true,
    });
  });

  it("sends only a greeting profile configured for the current guild", async () => {
    const now = DateTime.fromISO("2026-04-19T12:00:00Z");
    const storage = createStorageMock(buildState(), buildMetrics(), []);
    const runtime = createRuntimeMock(storage, now);
    runtime.guildRuntime.settings.features.greetings = true;
    runtime.guildRuntime.settings.greetings = [
      {
        name: "Visiting Herald",
        userId: null,
        message: "Welcome to this court, honored visitor.",
      },
    ];
    const { interaction, reply } = createInteractionMock({
      commandName: "greetings",
      subcommand: "send",
    });
    const getString = interaction.options.getString as unknown as ReturnType<
      typeof vi.fn
    >;
    getString.mockImplementation((name: string) =>
      name === "profile" ? "visiting herald" : null,
    );

    await handleChatInputCommand(interaction, runtime);

    expect(reply).toHaveBeenCalledWith({
      content: "Welcome to this court, honored visitor.",
      allowedMentions: { parse: [] },
    });
    expect(storage.recordCommandMetric).toHaveBeenCalledWith("greetings.send");
    expect(
      storage.recordCommandMetric.mock.invocationCallOrder[0],
    ).toBeLessThan(reply.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER);
  });

  it("cancels /court health when channel resolution invalidates the guild", async () => {
    const now = DateTime.fromISO("2026-04-19T12:15:00Z");
    const storage = createStorageMock(buildState(), buildMetrics(), []);
    const runtime = createRuntimeMock(storage, now);
    const { interaction, reply } = createInteractionMock({
      commandName: "court",
      subcommand: "health",
      isAdmin: true,
    });
    let current = true;
    runtime.guildRuntime.isCurrent = () => current;
    const guild = interaction.guild as NonNullable<
      ChatInputCommandInteraction["guild"]
    >;
    (guild.channels.fetch as unknown as ReturnType<typeof vi.fn>)
      .mockImplementation(async () => {
        current = false;
        return null;
      });

    await handleChatInputCommand(interaction, runtime);

    expect(storage.recordCommandMetric).not.toHaveBeenCalledWith("court.health");
    expect(reply).toHaveBeenLastCalledWith({
      content:
        "Action cancelled because this server was disabled, removed, purged, or its configuration changed.",
      ephemeral: true,
    });
  });

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
    expect(payload.content).toContain("**Auto Time:** `20:15`");
    expect(payload.content).not.toContain("UTC");
    expect(payload.content).toContain("**Recent Memory Size:** `3`");
    expect(payload.content).toContain("**Used Pool Size:** `2`");
    expect(payload.content).toContain("**Open Court Threads:** `2`");
  });

  it("handles /court health without exposing shared database size", async () => {
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
        toJSON: () => {
          description?: string;
          fields?: Array<{ name: string; value: string }>;
        };
      }>;
      ephemeral: boolean;
    };
    expect(payload.ephemeral).toBe(true);

    const embedJson = payload.embeds[0]?.toJSON();
    expect(embedJson?.description).toContain(
      `**Now:** \`${now.toFormat("yyyy-LL-dd HH:mm:ss")}\``,
    );
    expect(embedJson?.description).not.toContain("Timezone");
    expect(embedJson?.description).not.toContain("UTC");

    const schedulingField = embedJson?.fields?.find(
      (field) => field.name === "Scheduling",
    );
    expect(schedulingField?.value).toContain("**Auto Time:** `20:15`");
    expect(schedulingField?.value).not.toContain("UTC");

    const dataField = embedJson?.fields?.find((field) => field.name === "Data");
    expect(dataField?.value).toContain("**Tenant Storage:** `available`");
    expect(dataField?.value).not.toContain("KB");
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

    expect(runtime.guildRuntime.saveSettings).toHaveBeenCalledTimes(1);
    expect(storage.updateStateAtomic).toHaveBeenCalledTimes(1);
    expect(storage.recordCommandMetric).toHaveBeenCalledWith("court.dryrun");

    expect(runtime.guildRuntime.settings.courtSchedule.dryRun).toBe(true);

    const payload = reply.mock.calls[0]?.[0] as {
      content: string;
      ephemeral: boolean;
    };
    expect(payload.ephemeral).toBe(true);
    expect(payload.content).toContain("`enabled`");
  });

  it("does not mutate court state after a settings save is invalidated", async () => {
    const now = DateTime.fromISO("2026-04-19T16:05:00Z");
    const storage = createStorageMock(buildState(), buildMetrics(), []);
    const runtime = createRuntimeMock(storage, now);
    const { interaction, reply } = createInteractionMock({
      commandName: "court",
      subcommand: "dryrun",
      isAdmin: true,
      boolOptions: { enabled: true },
    });
    let current = true;
    runtime.guildRuntime.isCurrent = () => current;
    vi.mocked(runtime.guildRuntime.saveSettings).mockImplementation(
      async (settings) => {
        runtime.guildRuntime.settings = structuredClone(settings);
        current = false;
        return runtime.guildRuntime.settings;
      },
    );

    await handleChatInputCommand(interaction, runtime);

    expect(storage.updateStateAtomic).not.toHaveBeenCalled();
    expect(storage.recordCommandMetric).not.toHaveBeenCalledWith("court.dryrun");
    expect(reply).toHaveBeenLastCalledWith({
      content:
        "Action cancelled because this server was disabled, removed, purged, or its configuration changed.",
      ephemeral: true,
    });
  });

  it("does not record a manual-post command after post completion invalidates the guild", async () => {
    const now = DateTime.fromISO("2026-04-19T16:10:00Z");
    const storage = createStorageMock(buildState(), buildMetrics(), []);
    const runtime = createRuntimeMock(storage, now);
    const { interaction, editReply } = createInteractionMock({
      commandName: "court",
      subcommand: "post",
      isAdmin: true,
    });
    let current = true;
    runtime.guildRuntime.isCurrent = () => current;
    const send = vi.fn(async () => ({ id: "900000000000000001" }));
    const targetChannel = {
      id: runtime.guildRuntime.settings.channels.court,
      guildId: GUILD_ID,
      isThread: vi.fn(() => true),
      send,
      toString: vi.fn(() => "<#123456789012345679>"),
    };
    const guild = interaction.guild as NonNullable<
      ChatInputCommandInteraction["guild"]
    >;
    (guild.channels.fetch as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValue(targetChannel);
    Object.assign(storage, {
      pickQuestion: vi.fn(() => ["general", "A"]),
      upsertPostRow: vi.fn(),
      registerUsedQuestion: vi.fn(),
      recordPostMetric: vi.fn(),
    });
    storage.updateStateAtomic.mockImplementation((mutator) => {
      const state = storage.getState();
      mutator(state);
      current = false;
      return state;
    });

    await handleChatInputCommand(interaction, runtime);

    expect(send).toHaveBeenCalledTimes(1);
    expect(storage.recordCommandMetric).not.toHaveBeenCalledWith("court.post");
    expect(editReply).toHaveBeenLastCalledWith({
      content:
        "Action cancelled because this server was disabled, removed, purged, or its configuration changed.",
    });
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

  it("rechecks the guild generation after the asynchronous admin gate", async () => {
    const now = DateTime.fromISO("2026-04-19T18:55:00Z");
    const storage = createStorageMock(buildState(), buildMetrics(), []);
    const runtime = createRuntimeMock(storage, now);
    const { interaction, reply } = createInteractionMock({
      commandName: "invictus",
      subcommand: "timeout",
      isAdmin: true,
    });

    let current = true;
    runtime.guildRuntime.isCurrent = () => current;
    const actor = {
      id: "1001",
      permissions: { has: vi.fn(() => true) },
      guild: { ownerId: "9999" },
      user: { bot: false, tag: "actor#0001" },
      roles: {
        cache: { some: vi.fn(() => false) },
        highest: { comparePositionTo: vi.fn(() => 1) },
      },
    } as unknown as GuildMember;
    const members = (interaction.guild as NonNullable<
      ChatInputCommandInteraction["guild"]
    >).members;
    (members.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        current = false;
        return actor;
      },
    );

    await handleChatInputCommand(interaction, runtime);

    expect(interaction.options.getUser).not.toHaveBeenCalled();
    expect(reply).toHaveBeenLastCalledWith({
      content:
        "Action cancelled because this server was disabled, removed, purged, or its configuration changed.",
      ephemeral: true,
    });
  });

  it("does not update royal AFK state after the role lookup invalidates the guild", async () => {
    const now = DateTime.fromISO("2026-04-19T18:57:00Z");
    const storage = createStorageMock(buildState(), buildMetrics(), []);
    const runtime = createRuntimeMock(storage, now);
    runtime.guildRuntime.settings.features.royalAfk = true;
    runtime.guildRuntime.settings.roles.emperor = "777777777777777777";
    const { interaction, reply } = createInteractionMock({
      commandName: "invictus",
      subcommand: "afk",
    });
    let current = true;
    runtime.guildRuntime.isCurrent = () => current;
    const royalActor = {
      id: "1001",
      roles: { cache: { has: vi.fn(() => true) } },
      toString: vi.fn(() => "<@1001>"),
    } as unknown as GuildMember;
    const guild = interaction.guild as NonNullable<
      ChatInputCommandInteraction["guild"]
    >;
    (guild.members.fetch as unknown as ReturnType<typeof vi.fn>)
      .mockImplementation(async () => {
        current = false;
        return royalActor;
      });

    await handleChatInputCommand(interaction, runtime);

    expect(storage.updateStateAtomic).not.toHaveBeenCalled();
    expect(storage.recordCommandMetric).not.toHaveBeenCalledWith("invictus.afk");
    expect(reply).toHaveBeenLastCalledWith({
      content:
        "Action cancelled because this server was disabled, removed, purged, or its configuration changed.",
      ephemeral: true,
    });
  });

  it("does not record a public battle after member lookup invalidates the guild", async () => {
    const now = DateTime.fromISO("2026-04-19T18:58:00Z");
    const storage = createStorageMock(buildState(), buildMetrics(), []);
    const runtime = createRuntimeMock(storage, now);
    const metricsIncrement = vi.fn();
    Object.assign(storage, {
      metricsIncrement,
      buildUserMetricKey: vi.fn(
        (userId: string, metric: string) => `user:${userId}:${metric}`,
      ),
    });
    const { interaction, reply } = createInteractionMock({
      commandName: "fun",
      subcommand: "battle",
    });
    const challengerId = "1001";
    const opponentId = "300000000000000001";
    (interaction.options.getUser as unknown as ReturnType<typeof vi.fn>)
      .mockReturnValue({ id: opponentId });
    let current = true;
    runtime.guildRuntime.isCurrent = () => current;
    const makeMember = (id: string): GuildMember =>
      ({
        id,
        displayName: `member-${id}`,
        toString: vi.fn(() => `<@${id}>`),
      }) as unknown as GuildMember;
    const guild = interaction.guild as NonNullable<
      ChatInputCommandInteraction["guild"]
    >;
    (guild.members.fetch as unknown as ReturnType<typeof vi.fn>)
      .mockImplementation(async (id: string) => {
        if (id === opponentId) {
          current = false;
        }
        return makeMember(id === opponentId ? opponentId : challengerId);
      });

    await handleChatInputCommand(interaction, runtime);

    expect(metricsIncrement).not.toHaveBeenCalled();
    expect(reply).toHaveBeenLastCalledWith({
      content:
        "Action cancelled because this server was disabled, removed, purged, or its configuration changed.",
      ephemeral: true,
    });
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

  it("opens the /invictus say modal when no message_file attachment is provided", async () => {
    const now = DateTime.fromISO("2026-04-19T19:20:00Z");
    const storage = createStorageMock(buildState(), buildMetrics(), []);
    const runtime = createRuntimeMock(storage, now);
    const { interaction, showModal, deferReply } = createInteractionMock({
      commandName: "invictus",
      subcommand: "say",
      isAdmin: true,
    });

    const targetChannel = {
      id: "1234567890",
      guildId: GUILD_ID,
      isThread: vi.fn(() => true),
      toString: vi.fn(() => "<#1234567890>"),
      send: vi.fn(async () => ({ id: "msg-1" })),
    };
    const getChannel = interaction.options.getChannel as unknown as ReturnType<
      typeof vi.fn
    >;
    getChannel.mockImplementation((name: string) =>
      name === "channel" ? targetChannel : null,
    );

    await handleChatInputCommand(interaction, runtime);

    expect(showModal).toHaveBeenCalledTimes(1);
    expect(deferReply).not.toHaveBeenCalled();
    expect(storage.recordCommandMetric).not.toHaveBeenCalledWith("invictus.say");
  });

  it("supports /invictus say message_file and chunks long content", async () => {
    const now = DateTime.fromISO("2026-04-19T19:25:00Z");
    const storage = createStorageMock(buildState(), buildMetrics(), []);
    const runtime = createRuntimeMock(storage, now);
    const { interaction, showModal, deferReply, editReply } = createInteractionMock(
      {
        commandName: "invictus",
        subcommand: "say",
        isAdmin: true,
      },
    );

    const send = vi.fn(async () => ({ id: "msg-1" }));
    const targetChannel = {
      id: "1234567891",
      guildId: GUILD_ID,
      isThread: vi.fn(() => true),
      toString: vi.fn(() => "<#1234567891>"),
      send,
    };
    const getChannel = interaction.options.getChannel as unknown as ReturnType<
      typeof vi.fn
    >;
    getChannel.mockImplementation((name: string) =>
      name === "channel" ? targetChannel : null,
    );

    const longMessage = "A".repeat(4500);
    const getAttachment = interaction.options
      .getAttachment as unknown as ReturnType<typeof vi.fn>;
    getAttachment.mockImplementation((name: string) =>
      name === "message_file"
        ? {
            name: "announcement.txt",
            size: longMessage.length,
            url: "https://example.com/announcement.txt",
          }
        : null,
    );

    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => longMessage,
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await handleChatInputCommand(interaction, runtime);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(showModal).not.toHaveBeenCalled();
    expect(deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(send).toHaveBeenCalledTimes(2);
    expect(storage.recordCommandMetric).toHaveBeenCalledWith("invictus.say");

    const payload = editReply.mock.calls.at(-1)?.[0] as { content: string };
    expect(payload.content).toContain("in 2 parts");
  });

  it("rejects an /invictus say channel owned by another guild", async () => {
    const now = DateTime.fromISO("2026-04-19T19:27:00Z");
    const storage = createStorageMock(buildState(), buildMetrics(), []);
    const runtime = createRuntimeMock(storage, now);
    const { interaction, reply, showModal } = createInteractionMock({
      commandName: "invictus",
      subcommand: "say",
      isAdmin: true,
    });
    const getChannel = interaction.options.getChannel as unknown as ReturnType<
      typeof vi.fn
    >;
    getChannel.mockReturnValue({
      id: "444444444444444444",
      guildId: "999999999999999999",
      isThread: vi.fn(() => true),
      send: vi.fn(),
    });

    await handleChatInputCommand(interaction, runtime);

    expect(showModal).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      content: "Target channel must be a message channel in this server.",
      ephemeral: true,
    });
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

  it("cancels /invictus timeout when the guild generation changes during member lookup", async () => {
    const now = DateTime.fromISO("2026-04-19T19:35:00Z");
    const storage = createStorageMock(buildState(), buildMetrics(), []);
    const runtime = createRuntimeMock(storage, now);
    const { interaction, reply } = createInteractionMock({
      commandName: "invictus",
      subcommand: "timeout",
      isAdmin: true,
    });

    let current = true;
    runtime.guildRuntime.isCurrent = () => current;
    const actor = {
      id: "1001",
      user: { bot: false, tag: "actor#0001" },
      permissions: { has: vi.fn(() => true) },
      guild: { ownerId: "9999" },
      roles: {
        cache: { some: vi.fn(() => false) },
        highest: { comparePositionTo: vi.fn(() => 1) },
      },
      toString: vi.fn(() => "<@1001>"),
    } as unknown as GuildMember;
    const timeout = vi.fn(async () => undefined);
    const targetId = "300000000000000001";
    const target = {
      id: targetId,
      user: { bot: false, tag: "target#0001" },
      guild: { ownerId: "9999" },
      roles: { highest: { comparePositionTo: vi.fn(() => 0) } },
      timeout,
      toString: vi.fn(() => `<@${targetId}>`),
    } as unknown as GuildMember;
    const me = {
      id: "2000",
      roles: { highest: { comparePositionTo: vi.fn(() => 1) } },
    } as unknown as GuildMember;
    const members = (interaction.guild as NonNullable<
      ChatInputCommandInteraction["guild"]
    >).members;
    (members as unknown as { me: GuildMember | null }).me = me;
    (members.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (id: string) => {
        if (id === targetId) {
          current = false;
          return target;
        }
        return actor;
      },
    );
    (interaction.options.getUser as unknown as ReturnType<typeof vi.fn>)
      .mockReturnValue({ id: targetId });
    (interaction.options.getInteger as unknown as ReturnType<typeof vi.fn>)
      .mockReturnValue(15);

    await handleChatInputCommand(interaction, runtime);

    expect(timeout).not.toHaveBeenCalled();
    expect(reply).toHaveBeenLastCalledWith({
      content:
        "Action cancelled because this server was disabled, removed, purged, or its configuration changed.",
      ephemeral: true,
    });
    expect(storage.recordCommandMetric).not.toHaveBeenCalledWith(
      "invictus.timeout",
    );
  });

  it("stops /invictus mutemany after invalidation during the first timeout", async () => {
    const now = DateTime.fromISO("2026-04-19T19:40:00Z");
    const storage = createStorageMock(buildState(), buildMetrics(), []);
    const runtime = createRuntimeMock(storage, now);
    const { interaction, editReply } = createInteractionMock({
      commandName: "invictus",
      subcommand: "mutemany",
      isAdmin: true,
    });

    let current = true;
    runtime.guildRuntime.isCurrent = () => current;
    const actor = {
      id: "1001",
      user: { bot: false, tag: "actor#0001" },
      permissions: { has: vi.fn(() => true) },
      guild: { ownerId: "9999" },
      roles: {
        cache: { some: vi.fn(() => false) },
        highest: { comparePositionTo: vi.fn(() => 1) },
      },
      toString: vi.fn(() => "<@1001>"),
    } as unknown as GuildMember;
    const firstId = "300000000000000001";
    const secondId = "300000000000000002";
    const firstTimeout = vi.fn(async () => {
      current = false;
    });
    const secondTimeout = vi.fn(async () => undefined);
    const makeTarget = (
      id: string,
      timeout: ReturnType<typeof vi.fn>,
    ): GuildMember =>
      ({
        id,
        user: { bot: false, tag: `target-${id}` },
        guild: { ownerId: "9999" },
        roles: { highest: { comparePositionTo: vi.fn(() => 0) } },
        timeout,
        toString: vi.fn(() => `<@${id}>`),
      }) as unknown as GuildMember;
    const targets = new Map([
      [firstId, makeTarget(firstId, firstTimeout)],
      [secondId, makeTarget(secondId, secondTimeout)],
    ]);
    const me = {
      id: "2000",
      roles: { highest: { comparePositionTo: vi.fn(() => 1) } },
    } as unknown as GuildMember;
    const members = (interaction.guild as NonNullable<
      ChatInputCommandInteraction["guild"]
    >).members;
    (members as unknown as {
      me: GuildMember | null;
      cache: Map<string, GuildMember>;
    }).me = me;
    (members as unknown as { cache: Map<string, GuildMember> }).cache =
      new Map();
    (members.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (id: string) => targets.get(id) ?? actor,
    );
    (interaction.options.getString as unknown as ReturnType<typeof vi.fn>)
      .mockImplementation((name: string) =>
        name === "members" ? `${firstId} ${secondId}` : null,
      );
    (interaction.options.getInteger as unknown as ReturnType<typeof vi.fn>)
      .mockImplementation((name: string) => (name === "minutes" ? 15 : null));

    await handleChatInputCommand(interaction, runtime);

    expect(firstTimeout).toHaveBeenCalledTimes(1);
    expect(secondTimeout).not.toHaveBeenCalled();
    const cancellation = editReply.mock.calls.at(-1)?.[0] as {
      content: string;
    };
    expect(cancellation.content).toContain("Action cancelled");
    expect(cancellation.content).toContain("Applied before cancellation: `1`");
    expect(storage.recordCommandMetric).not.toHaveBeenCalledWith(
      "invictus.mutemany",
    );
  });

  it("does not toggle a role panel after the guild generation changes", async () => {
    const now = DateTime.fromISO("2026-04-19T19:45:00Z");
    const storage = createStorageMock(buildState(), buildMetrics(), []);
    const runtime = createRuntimeMock(storage, now);
    let current = true;
    runtime.guildRuntime.isCurrent = () => current;

    const roleId = "777777777777777777";
    const botId = "888888888888888888";
    const add = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    const member = {
      id: "555555555555555555",
      roles: { cache: { has: vi.fn(() => false) }, add, remove },
    } as unknown as GuildMember;
    const role = {
      id: roleId,
      managed: false,
      guild: { id: GUILD_ID },
      toString: vi.fn(() => `<@&${roleId}>`),
    };
    const me = {
      permissions: { has: vi.fn(() => true) },
      roles: { highest: { comparePositionTo: vi.fn(() => 1) } },
    } as unknown as GuildMember;
    const reply = vi.fn(async () => undefined);
    const interaction = {
      guildId: GUILD_ID,
      guild: {
        id: GUILD_ID,
        members: { fetch: vi.fn(async () => member), me },
        roles: {
          cache: new Map(),
          fetch: vi.fn(async () => {
            current = false;
            return role;
          }),
        },
      },
      client: { user: { id: botId } },
      message: {
        id: "999999999999999999",
        guildId: GUILD_ID,
        author: { id: botId },
        embeds: [],
      },
      customId: buildRolePanelButtonCustomId(roleId),
      user: { id: "555555555555555555" },
      reply,
    } as unknown as ButtonInteraction;

    await handleButtonInteraction(interaction, runtime);

    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(reply).toHaveBeenLastCalledWith({
      content:
        "Action cancelled because this server was disabled, removed, purged, or its configuration changed.",
      ephemeral: true,
    });
  });
});
