import { DateTime } from "luxon";
import {
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildMember,
  type Message,
  type MessageReaction,
  type User,
} from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultGuildSettings } from "../src/guild-settings.js";
import {
  REPLY_MODERATION_MINUTES,
  canTimeoutTarget,
  handleMessageCreate,
  handleMessageUpdate,
  handleReactionAdd,
  wireMessageRuntime,
} from "../src/message-runtime.js";
import type { BotRuntime, GuildRuntime } from "../src/runtime.js";

const GUILD_ID = "123456789012345678";
const OTHER_GUILD_ID = "223456789012345678";
const USER_ID = "323456789012345678";
const BOT_ID = "423456789012345678";
const TARGET_ID = "523456789012345678";
const CHANNEL_ID = "623456789012345678";

interface Harness {
  settings: ReturnType<typeof createDefaultGuildSettings>;
  processRuntime: BotRuntime;
  guildRuntime: GuildRuntime;
  guild: Guild;
  actor: GuildMember;
  me: GuildMember;
  target: GuildMember;
  message: Message;
  reply: ReturnType<typeof vi.fn>;
  timeout: ReturnType<typeof vi.fn>;
  recordCommandMetric: ReturnType<typeof vi.fn>;
  incrementUserMetric: ReturnType<typeof vi.fn>;
  events: string[];
  setCurrent: (current: boolean) => void;
  setReferencedMessage: (message: Message | null) => void;
  setChannelPermissions: (permissions: readonly bigint[]) => void;
}

function createHarness(
  options: {
    content?: string;
    actorAdmin?: boolean;
    botCanModerate?: boolean;
    reference?: boolean;
  } = {},
): Harness {
  const events: string[] = [];
  let current = true;
  let referencedMessage: Message | null = null;
  let channelPermissions: readonly bigint[] = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
  ];
  const settings = createDefaultGuildSettings();
  settings.enabled = true;
  settings.timezone = "Asia/Amman";

  const guild = {
    id: GUILD_ID,
    ownerId: "923456789012345678",
    members: {},
    channels: {
      cache: new Map(),
      fetch: vi.fn(async () => null),
    },
  } as unknown as Guild;
  const highest = (position: number) => ({
    position,
    comparePositionTo: vi.fn(
      (other: { position?: number }) => position - (other.position ?? 0),
    ),
  });
  const actor = {
    id: USER_ID,
    guild,
    user: { id: USER_ID, tag: "actor#0001", bot: false },
    permissions: {
      has: vi.fn(
        (permission: bigint) =>
          permission === PermissionFlagsBits.Administrator &&
          (options.actorAdmin ?? true),
      ),
    },
    roles: { highest: highest(50) },
    toString: () => `<@${USER_ID}>`,
  } as unknown as GuildMember;
  const me = {
    id: BOT_ID,
    guild,
    user: { id: BOT_ID, tag: "bot#0001", bot: true },
    permissions: {
      has: vi.fn(
        (permission: bigint) =>
          permission === PermissionFlagsBits.ModerateMembers &&
          (options.botCanModerate ?? true),
      ),
    },
    roles: { highest: highest(100) },
    toString: () => `<@${BOT_ID}>`,
  } as unknown as GuildMember;
  const timeout = vi.fn(async () => {
    events.push("timeout");
  });
  const target = {
    id: TARGET_ID,
    guild,
    user: { id: TARGET_ID, tag: "target#0001", bot: false },
    permissions: { has: vi.fn(() => false) },
    roles: { highest: highest(10) },
    moderatable: true,
    timeout,
    toString: () => `<@${TARGET_ID}>`,
  } as unknown as GuildMember;

  const members = guild.members as unknown as {
    me: GuildMember;
    fetchMe: ReturnType<typeof vi.fn>;
    fetch: ReturnType<typeof vi.fn>;
  };
  members.me = me;
  members.fetchMe = vi.fn(async () => me);
  members.fetch = vi.fn(async (id: string) => {
    if (id === USER_ID) return actor;
    if (id === TARGET_ID) return target;
    if (id === BOT_ID) return me;
    throw new Error("not found");
  });

  const channel = {
    id: CHANNEL_ID,
    guildId: GUILD_ID,
    isThread: () => false,
    permissionsFor: vi.fn(() => ({
      has: (permission: bigint) => channelPermissions.includes(permission),
    })),
    messages: {
      fetch: vi.fn(async () => referencedMessage),
    },
    send: vi.fn(async () => undefined),
  };
  const client = {
    user: { id: BOT_ID },
    ws: { ping: 42 },
    uptime: 90_061_000,
  } as unknown as Client;
  const reply = vi.fn(async () => {
    events.push("reply");
  });
  const message = {
    id: "723456789012345678",
    content: options.content ?? "superior hru",
    author: { id: USER_ID, bot: false },
    guildId: GUILD_ID,
    guild,
    member: actor,
    channelId: CHANNEL_ID,
    channel,
    client,
    reference: options.reference ? { messageId: "823456789012345678" } : null,
    fetchReference: vi.fn(async () => {
      if (!referencedMessage) throw new Error("missing reference");
      return referencedMessage;
    }),
    reply,
  } as unknown as Message;

  referencedMessage = options.reference
    ? ({
        id: "823456789012345678",
        author: { id: TARGET_ID, bot: false },
        guildId: GUILD_ID,
        guild,
        member: target,
        channelId: CHANNEL_ID,
        channel,
      } as unknown as Message)
    : null;

  const recordCommandMetric = vi.fn((name: string, success = true) => {
    events.push(`metric:${name}:${success ? "success" : "failure"}`);
  });
  const incrementUserMetric = vi.fn();
  const storage = {
    recordCommandMetric,
    incrementUserMetric,
  };
  const guildRuntime = {
    guildId: GUILD_ID,
    botVersion: "5.0.0-test",
    settings,
    storage,
    now: () => DateTime.fromISO("2026-07-28T14:30:00", { zone: "Asia/Amman" }),
    randomInt: vi.fn(() => 0),
    isCurrent: vi.fn(() => current),
  } as unknown as GuildRuntime;
  const processRuntime = {
    forGuild: vi.fn(async () => guildRuntime),
  } as unknown as BotRuntime;

  return {
    settings,
    processRuntime,
    guildRuntime,
    guild,
    actor,
    me,
    target,
    message,
    reply,
    timeout,
    recordCommandMetric,
    incrementUserMetric,
    events,
    setCurrent(value: boolean): void {
      current = value;
    },
    setReferencedMessage(value: Message | null): void {
      referencedMessage = value;
    },
    setChannelPermissions(permissions: readonly bigint[]): void {
      channelPermissions = permissions;
    },
  };
}

function replyPayload(harness: Harness): {
  content: string;
  allowedMentions: { parse: unknown[]; repliedUser: boolean };
} {
  const payload = harness.reply.mock.calls.at(-1)?.[0] as
    | {
        content: string;
        allowedMentions: { parse: unknown[]; repliedUser: boolean };
      }
    | undefined;
  if (!payload) throw new Error("Expected a reply payload");
  return payload;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("message runtime chat", () => {
  it("sends a safe reply and records its metric only afterward", async () => {
    const harness = createHarness({ content: "superior hru" });

    await handleMessageCreate(harness.message, harness.processRuntime);

    expect(replyPayload(harness).content).toContain("doing well");
    expect(replyPayload(harness).allowedMentions).toEqual({
      parse: [],
      repliedUser: false,
    });
    expect(harness.events).toEqual([
      "reply",
      "metric:superior.chat.wellbeing:success",
    ]);
  });

  it("does not record a response metric when the primary reply fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const harness = createHarness({ content: "superior ping" });
    harness.reply.mockRejectedValueOnce(new Error("send failed"));

    await handleMessageCreate(harness.message, harness.processRuntime);

    expect(harness.recordCommandMetric).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });

  it("accepts a verified same-guild reply to the bot", async () => {
    const harness = createHarness({ content: "wyd", reference: true });
    harness.setReferencedMessage({
      id: "823456789012345678",
      author: { id: BOT_ID, bot: true },
      guildId: GUILD_ID,
      guild: harness.guild,
      member: harness.me,
      channelId: CHANNEL_ID,
      channel: harness.message.channel,
    } as unknown as Message);

    await handleMessageCreate(harness.message, harness.processRuntime);

    expect(replyPayload(harness).content).toContain("watching for commands");
    expect(harness.recordCommandMetric).toHaveBeenCalledWith(
      "superior.chat.activity",
      true,
    );
  });

  it("rejects an unverified or cross-guild reply reference", async () => {
    const harness = createHarness({ content: "wyd", reference: true });
    harness.setReferencedMessage({
      id: "823456789012345678",
      author: { id: BOT_ID, bot: true },
      guildId: OTHER_GUILD_ID,
      guild: { id: OTHER_GUILD_ID },
      channelId: CHANNEL_ID,
      channel: { guildId: OTHER_GUILD_ID },
    } as unknown as Message);

    await handleMessageCreate(harness.message, harness.processRuntime);

    expect(harness.reply).not.toHaveBeenCalled();
    expect(harness.recordCommandMetric).not.toHaveBeenCalled();
  });

  it("is side-effect free when explicitly disabled", async () => {
    const harness = createHarness();
    harness.settings.enabled = false;

    await handleMessageCreate(harness.message, harness.processRuntime);

    expect(harness.reply).not.toHaveBeenCalled();
    expect(harness.recordCommandMetric).not.toHaveBeenCalled();
    expect(harness.incrementUserMetric).not.toHaveBeenCalled();
  });

  it("rejects mismatched guild, channel, runtime, and member tenants", async () => {
    const guildMismatch = createHarness();
    Object.assign(guildMismatch.message.guild as object, {
      id: OTHER_GUILD_ID,
    });
    await handleMessageCreate(
      guildMismatch.message,
      guildMismatch.processRuntime,
    );
    expect(guildMismatch.reply).not.toHaveBeenCalled();

    const channelMismatch = createHarness();
    Object.assign(channelMismatch.message.channel as object, {
      guildId: OTHER_GUILD_ID,
    });
    await handleMessageCreate(
      channelMismatch.message,
      channelMismatch.processRuntime,
    );
    expect(channelMismatch.reply).not.toHaveBeenCalled();

    const runtimeMismatch = createHarness();
    Object.assign(runtimeMismatch.guildRuntime as object, {
      guildId: OTHER_GUILD_ID,
    });
    await handleMessageCreate(
      runtimeMismatch.message,
      runtimeMismatch.processRuntime,
    );
    expect(runtimeMismatch.reply).not.toHaveBeenCalled();

    const memberMismatch = createHarness();
    Object.assign(memberMismatch.actor.guild as object, {
      id: OTHER_GUILD_ID,
    });
    await handleMessageCreate(
      memberMismatch.message,
      memberMismatch.processRuntime,
    );
    expect(memberMismatch.reply).not.toHaveBeenCalled();
  });

  it("records passive activity by default", async () => {
    const harness = createHarness({ content: "ordinary message" });

    await handleMessageCreate(harness.message, harness.processRuntime);

    expect(harness.reply).not.toHaveBeenCalled();
    expect(harness.incrementUserMetric).toHaveBeenCalledWith(
      USER_ID,
      "messages_sent",
    );
  });
});

describe("reply moderation runtime", () => {
  it("applies an authorized timeout before replying and then records it", async () => {
    const harness = createHarness({
      content: "superior mute for repeated spam",
      reference: true,
    });

    await handleMessageCreate(harness.message, harness.processRuntime);

    expect(harness.timeout).toHaveBeenCalledWith(
      REPLY_MODERATION_MINUTES * 60_000,
      expect.stringContaining("for repeated spam"),
    );
    expect(replyPayload(harness).content).toContain("was timed out");
    expect(replyPayload(harness).allowedMentions).toEqual({
      parse: [],
      repliedUser: false,
    });
    expect(harness.events).toEqual([
      "timeout",
      "reply",
      "metric:superior.reply_moderation:success",
    ]);
  });

  it("never reinterprets unauthorized moderation text as casual chat", async () => {
    const harness = createHarness({
      content: "superior mute for saying ping",
      actorAdmin: false,
      reference: true,
    });

    await handleMessageCreate(harness.message, harness.processRuntime);

    expect(harness.timeout).not.toHaveBeenCalled();
    expect(harness.reply).not.toHaveBeenCalled();
    expect(harness.recordCommandMetric).not.toHaveBeenCalled();
  });

  it("preflights send and Moderate Members permissions", async () => {
    const cannotModerate = createHarness({
      content: "superior timeout",
      botCanModerate: false,
      reference: true,
    });
    await handleMessageCreate(
      cannotModerate.message,
      cannotModerate.processRuntime,
    );
    expect(cannotModerate.timeout).not.toHaveBeenCalled();
    expect(replyPayload(cannotModerate).content).toContain(
      "lacks Moderate Members",
    );

    const cannotReply = createHarness({
      content: "superior timeout",
      reference: true,
    });
    cannotReply.setChannelPermissions([PermissionFlagsBits.ViewChannel]);
    await handleMessageCreate(cannotReply.message, cannotReply.processRuntime);
    expect(cannotReply.timeout).not.toHaveBeenCalled();
    expect(cannotReply.reply).not.toHaveBeenCalled();
  });

  it("explains missing targets and Discord failures without claiming success", async () => {
    const missing = createHarness({
      content: "superior mute",
      reference: false,
    });
    await handleMessageCreate(missing.message, missing.processRuntime);
    expect(replyPayload(missing).content).toContain("No timeout was applied");

    const failed = createHarness({
      content: "superior mute",
      reference: true,
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    failed.timeout.mockRejectedValueOnce(new Error("Discord failure"));
    await handleMessageCreate(failed.message, failed.processRuntime);
    expect(replyPayload(failed).content).toContain("did not apply");
    expect(replyPayload(failed).content).toContain("No timeout was applied");
    expect(failed.recordCommandMetric).toHaveBeenCalledWith(
      "superior.reply_moderation",
      false,
    );
  });

  it("reports an applied timeout even if settings change afterward", async () => {
    const harness = createHarness({
      content: "superior mute",
      reference: true,
    });
    harness.timeout.mockImplementationOnce(async () => {
      harness.events.push("timeout");
      harness.setCurrent(false);
    });

    await handleMessageCreate(harness.message, harness.processRuntime);

    expect(replyPayload(harness).content).toContain("was timed out");
    expect(replyPayload(harness).content).toContain(
      "completed before server settings changed",
    );
    expect(harness.recordCommandMetric).not.toHaveBeenCalled();
  });

  it("does not record success when confirmation fails after an applied timeout", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const harness = createHarness({
      content: "superior mute",
      reference: true,
    });
    harness.reply.mockRejectedValueOnce(new Error("send failed"));

    await handleMessageCreate(harness.message, harness.processRuntime);

    expect(harness.timeout).toHaveBeenCalledOnce();
    expect(harness.recordCommandMetric).not.toHaveBeenCalled();
  });
});

describe("moderation eligibility", () => {
  it("enforces tenant, actor, bot, owner, hierarchy, and Discord checks", () => {
    const base = createHarness({ reference: true });
    expect(canTimeoutTarget(base.actor, base.me, base.target)).toEqual({
      allowed: true,
      reason: "",
    });

    const notAdmin = createHarness({ actorAdmin: false });
    expect(
      canTimeoutTarget(notAdmin.actor, notAdmin.me, notAdmin.target),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("Administrator"),
    });

    const noBotPermission = createHarness({ botCanModerate: false });
    expect(
      canTimeoutTarget(
        noBotPermission.actor,
        noBotPermission.me,
        noBotPermission.target,
      ),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("Moderate Members"),
    });

    const mismatched = createHarness();
    Object.assign(mismatched.target as object, {
      guild: { id: OTHER_GUILD_ID, ownerId: OTHER_GUILD_ID },
    });
    expect(
      canTimeoutTarget(mismatched.actor, mismatched.me, mismatched.target),
    ).toEqual({ allowed: false, reason: "guild context mismatch" });

    const botTarget = createHarness();
    Object.assign(botTarget.target.user as object, { bot: true });
    expect(
      canTimeoutTarget(botTarget.actor, botTarget.me, botTarget.target),
    ).toMatchObject({ allowed: false, reason: expect.stringContaining("bot") });

    const ownerTarget = createHarness();
    Object.assign(ownerTarget.target as object, {
      id: ownerTarget.guild.ownerId,
    });
    expect(
      canTimeoutTarget(ownerTarget.actor, ownerTarget.me, ownerTarget.target),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("owner"),
    });

    const selfTarget = createHarness();
    Object.assign(selfTarget.target as object, { id: selfTarget.actor.id });
    expect(
      canTimeoutTarget(selfTarget.actor, selfTarget.me, selfTarget.target),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("yourself"),
    });

    const lowBotRole = createHarness();
    Object.assign(lowBotRole.me.roles as object, {
      highest: { comparePositionTo: () => 0 },
    });
    expect(
      canTimeoutTarget(lowBotRole.actor, lowBotRole.me, lowBotRole.target),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("bot role"),
    });

    const lowActorRole = createHarness();
    Object.assign(lowActorRole.actor.roles as object, {
      highest: { comparePositionTo: () => 0 },
    });
    expect(
      canTimeoutTarget(
        lowActorRole.actor,
        lowActorRole.me,
        lowActorRole.target,
      ),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("your role"),
    });

    const unmoderatable = createHarness();
    Object.assign(unmoderatable.target as object, { moderatable: false });
    expect(
      canTimeoutTarget(
        unmoderatable.actor,
        unmoderatable.me,
        unmoderatable.target,
      ),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("not moderatable"),
    });
  });
});

describe("private watcher routing", () => {
  it("routes a trusted bot candidate before the normal bot-message return", async () => {
    const harness = createHarness();
    const processMessage = vi.fn(async () => "native-forwarded" as const);
    const watcher = {
      isCandidate: vi.fn(() => true),
      processMessage,
    };
    Object.assign(harness.processRuntime, { privateMudaeWatcher: watcher });
    Object.assign(harness.message.author, {
      id: "723456789012345679",
      bot: true,
      username: "Mudae",
    });

    await handleMessageCreate(harness.message, harness.processRuntime);

    expect(watcher.isCandidate).toHaveBeenCalledWith(harness.message);
    expect(processMessage).toHaveBeenCalledWith(harness.message);
    expect(harness.processRuntime.forGuild).not.toHaveBeenCalled();
  });

  it("keeps untrusted bot messages out of normal conversation processing", async () => {
    const harness = createHarness();
    const processMessage = vi.fn();
    const watcher = {
      isCandidate: vi.fn(() => false),
      processMessage,
    };
    Object.assign(harness.processRuntime, { privateMudaeWatcher: watcher });
    Object.assign(harness.message.author, {
      id: "823456789012345679",
      bot: true,
      username: "Mudae",
    });

    await handleMessageCreate(harness.message, harness.processRuntime);

    expect(watcher.isCandidate).toHaveBeenCalledWith(harness.message);
    expect(processMessage).not.toHaveBeenCalled();
    expect(harness.processRuntime.forGuild).not.toHaveBeenCalled();
  });

  it("fetches configured partial updates and revalidates the full message", async () => {
    const harness = createHarness();
    const fullMessage = {
      ...harness.message,
      partial: false,
      author: { id: "723456789012345679", bot: true },
    } as unknown as Message;
    const fetch = vi.fn(async () => fullMessage);
    const updated = {
      partial: true,
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      author: { id: "723456789012345679", bot: true },
      fetch,
    } as unknown as Message;
    const processMessage = vi.fn(async () => "native-forwarded" as const);
    const watcher = {
      enabled: true,
      isConfiguredLocation: vi.fn(() => true),
      isTrustedAuthor: vi.fn(
        (author: { id: string }) => author.id === "723456789012345679",
      ),
      isCandidate: vi.fn((message: Message) => message === fullMessage),
      processMessage,
    };
    Object.assign(harness.processRuntime, { privateMudaeWatcher: watcher });

    await handleMessageUpdate(updated, updated, harness.processRuntime);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(watcher.isCandidate).toHaveBeenCalledWith(fullMessage);
    expect(processMessage).toHaveBeenCalledWith(fullMessage);
    expect(harness.processRuntime.forGuild).not.toHaveBeenCalled();
  });

  it("does not fetch partial updates outside configured locations", async () => {
    const harness = createHarness();
    const fetch = vi.fn();
    const updated = {
      partial: true,
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      author: null,
      fetch,
    } as unknown as Message;
    const watcher = {
      enabled: true,
      isConfiguredLocation: vi.fn(() => false),
    };
    Object.assign(harness.processRuntime, { privateMudaeWatcher: watcher });

    await handleMessageUpdate(updated, updated, harness.processRuntime);

    expect(fetch).not.toHaveBeenCalled();
    expect(harness.processRuntime.forGuild).not.toHaveBeenCalled();
  });
});

describe("reaction activity metrics", () => {
  it("records default same-guild reactions and rejects cross-guild messages", async () => {
    const harness = createHarness();
    const reaction = {
      message: {
        partial: false,
        guildId: GUILD_ID,
        guild: harness.guild,
        channel: harness.message.channel,
        author: { id: TARGET_ID, bot: false },
      },
    } as unknown as MessageReaction;
    await handleReactionAdd(
      reaction,
      { id: USER_ID, bot: false } as User,
      harness.processRuntime,
    );
    expect(harness.incrementUserMetric.mock.calls).toEqual([
      [USER_ID, "reactions_sent"],
      [TARGET_ID, "reactions_received"],
    ]);

    harness.incrementUserMetric.mockClear();
    Object.assign(reaction.message.channel as object, {
      guildId: OTHER_GUILD_ID,
    });
    await handleReactionAdd(
      reaction,
      { id: USER_ID, bot: false } as User,
      harness.processRuntime,
    );
    expect(harness.incrementUserMetric).not.toHaveBeenCalled();
  });
});

describe("runtime wiring", () => {
  it("registers create, update, and reaction handlers", () => {
    const harness = createHarness();
    const events: string[] = [];
    const client = {
      on: vi.fn((event: string) => {
        events.push(event);
        return client;
      }),
    } as unknown as Client;

    wireMessageRuntime(client, harness.processRuntime);

    expect(events).toEqual([
      "messageCreate",
      "messageUpdate",
      "messageReactionAdd",
    ]);
  });
});
