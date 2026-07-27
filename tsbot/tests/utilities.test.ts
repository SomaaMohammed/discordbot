import {
  ApplicationCommandOptionType,
  type ChatInputCommandInteraction,
  type GuildMember,
  type User,
} from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GuildRuntime } from "../src/runtime.js";
import {
  buildUtilityCommandDefinition,
  handleUtilityCommand,
} from "../src/discord/utilities.js";

const GUILD_ID = "123456789012345678";
const USER_ID = "223456789012345678";
const OWNER_ID = "323456789012345678";
const CREATED_AT = Date.UTC(2020, 0, 2, 3, 4, 5);
const JOINED_AT = Date.UTC(2024, 5, 7, 8, 9, 10);
const GLOBAL_AVATAR_URL = "https://cdn.example.test/global-avatar.png";
const SERVER_AVATAR_URL = "https://cdn.example.test/server-avatar.png";
const SERVER_ICON_URL = "https://cdn.example.test/server-icon.png";

type ReplyMock = ReturnType<typeof vi.fn<(payload: unknown) => Promise<void>>>;

interface UtilityHarness {
  interaction: ChatInputCommandInteraction;
  runtime: GuildRuntime;
  reply: ReplyMock;
  recordCommandMetric: ReturnType<typeof vi.fn<(metricName: string) => void>>;
  membersFetch: ReturnType<
    typeof vi.fn<(userId: string) => Promise<GuildMember>>
  >;
  member: GuildMember;
  user: User;
  setCurrent: (current: boolean) => void;
}

function createHarness(
  subcommand: string,
  options: {
    targetUser?: User;
    runtimeGuildId?: string;
    interactionGuildId?: string;
    gatewayPing?: number;
  } = {},
): UtilityHarness {
  const runtimeGuildId = options.runtimeGuildId ?? GUILD_ID;
  const interactionGuildId = options.interactionGuildId ?? GUILD_ID;
  let current = true;

  const user = {
    id: USER_ID,
    username: "member_name",
    globalName: "Member Name",
    tag: "member_name",
    bot: false,
    createdTimestamp: CREATED_AT,
    displayAvatarURL: vi.fn(() => GLOBAL_AVATAR_URL),
  } as unknown as User;

  let member!: GuildMember;
  const membersFetch = vi.fn(async (_userId: string) => member);
  const guild = {
    id: interactionGuildId,
    name: "Example *Server*",
    ownerId: OWNER_ID,
    createdTimestamp: CREATED_AT,
    memberCount: 42,
    premiumSubscriptionCount: 7,
    premiumTier: 2,
    iconURL: vi.fn(() => SERVER_ICON_URL),
    members: { fetch: membersFetch },
    channels: {
      cache: new Map([
        ["channel-1", {}],
        ["channel-2", {}],
        ["channel-3", {}],
      ]),
    },
    roles: {
      cache: new Map([
        [interactionGuildId, { name: "@everyone" }],
        ["role-1", { name: "Visible Role One" }],
        ["role-2", { name: "Visible Role Two" }],
      ]),
    },
  } as unknown as NonNullable<ChatInputCommandInteraction["guild"]>;

  member = {
    id: USER_ID,
    user,
    guild,
    displayName: "Server Display Name",
    joinedTimestamp: JOINED_AT,
    avatarURL: vi.fn(() => SERVER_AVATAR_URL),
    displayAvatarURL: vi.fn(() => SERVER_AVATAR_URL),
    roles: {
      cache: new Map([
        [interactionGuildId, { name: "@everyone" }],
        ["role-1", { name: "Private Role One" }],
        ["role-2", { name: "Private Role Two" }],
      ]),
    },
  } as unknown as GuildMember;

  const reply = vi.fn(async (_payload: unknown) => undefined);
  const recordCommandMetric = vi.fn((_metricName: string) => undefined);
  const interaction = {
    commandName: "utility",
    guildId: interactionGuildId,
    guild,
    user,
    client: { ws: { ping: options.gatewayPing ?? 37.6 } },
    options: {
      getSubcommand: vi.fn(() => subcommand),
      getUser: vi.fn(() => options.targetUser ?? null),
    },
    reply,
  } as unknown as ChatInputCommandInteraction;
  const runtime = {
    guildId: runtimeGuildId,
    botVersion: "3.1.0-test",
    storage: { recordCommandMetric },
    isCurrent: vi.fn(() => current),
  } as unknown as GuildRuntime;

  return {
    interaction,
    runtime,
    reply,
    recordCommandMetric,
    membersFetch,
    member,
    user,
    setCurrent(value: boolean): void {
      current = value;
    },
  };
}

function getReplyPayload(reply: ReplyMock): {
  content?: string;
  ephemeral?: boolean;
  allowedMentions?: { parse?: string[] };
  embeds?: Array<{ toJSON: () => Record<string, unknown> }>;
} {
  return (reply.mock.calls.at(-1)?.[0] ?? {}) as {
    content?: string;
    ephemeral?: boolean;
    allowedMentions?: { parse?: string[] };
    embeds?: Array<{ toJSON: () => Record<string, unknown> }>;
  };
}

function getEmbedJson(reply: ReplyMock): {
  title?: string;
  description?: string;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  image?: { url?: string };
  thumbnail?: { url?: string };
  footer?: { text?: string };
} {
  const payload = getReplyPayload(reply);
  const embed = payload.embeds?.[0];
  if (!embed) {
    throw new Error("Expected an embed reply");
  }
  return embed.toJSON();
}

function expectPrivateReply(reply: ReplyMock): void {
  const payload = getReplyPayload(reply);
  expect(payload.ephemeral).toBe(true);
  expect(payload.allowedMentions).toEqual({ parse: [] });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("utility command definition", () => {
  it("registers four guild-only utility subcommands", () => {
    const definition = buildUtilityCommandDefinition().toJSON();
    const subcommands = (definition.options ?? []) as Array<{
      name: string;
      options?: unknown[];
    }>;

    expect(definition.name).toBe("utility");
    expect(definition.dm_permission).toBe(false);
    expect(subcommands.map((subcommand) => subcommand.name)).toEqual([
      "ping",
      "avatar",
      "userinfo",
      "serverinfo",
    ]);

    for (const subcommandName of ["avatar", "userinfo"]) {
      const subcommand = subcommands.find(
        (candidate) => candidate.name === subcommandName,
      );
      expect(subcommand?.options).toEqual([
        expect.objectContaining({
          name: "member",
          type: ApplicationCommandOptionType.User,
          required: false,
        }),
      ]);
    }
  });
});

describe("utility command handling", () => {
  it("reports safe bot health details privately and records an aggregate metric", async () => {
    vi.spyOn(process, "uptime").mockReturnValue(3_661);
    const harness = createHarness("ping");

    await handleUtilityCommand(harness.interaction, harness.runtime);

    expectPrivateReply(harness.reply);
    const embed = getEmbedJson(harness.reply);
    const fields = Object.fromEntries(
      (embed.fields ?? []).map((field) => [field.name, field.value]),
    );
    expect(fields).toEqual({
      "Gateway latency": "38 ms",
      Uptime: "1h 1m 1s",
      Version: "3.1.0-test",
    });
    expect(JSON.stringify(embed).toLowerCase()).not.toMatch(
      /database|db_file|memory|path|token/,
    );
    expect(harness.membersFetch).not.toHaveBeenCalled();
    expect(harness.recordCommandMetric).toHaveBeenCalledWith("utility.ping");
  });

  it("shows a member's server and global avatars without publishing the reply", async () => {
    const harness = createHarness("avatar");

    await handleUtilityCommand(harness.interaction, harness.runtime);

    expectPrivateReply(harness.reply);
    const embed = getEmbedJson(harness.reply);
    expect(embed.image?.url).toBe(SERVER_AVATAR_URL);
    expect(embed.description).toContain(
      `[Server avatar](${SERVER_AVATAR_URL})`,
    );
    expect(embed.description).toContain(
      `[Global avatar](${GLOBAL_AVATAR_URL})`,
    );
    expect(embed.footer?.text).toBe(`User ID: ${USER_ID}`);
    expect(harness.membersFetch).toHaveBeenCalledWith(USER_ID);
    expect(harness.recordCommandMetric).toHaveBeenCalledWith("utility.avatar");
  });

  it("falls back to a global avatar when the member fetch is unavailable", async () => {
    const harness = createHarness("avatar");
    harness.membersFetch.mockRejectedValueOnce(new Error("unavailable"));

    await handleUtilityCommand(harness.interaction, harness.runtime);

    expectPrivateReply(harness.reply);
    const embed = getEmbedJson(harness.reply);
    expect(embed.image?.url).toBe(GLOBAL_AVATAR_URL);
    expect(embed.description).not.toContain("Server avatar");
    expect(embed.description).toContain(
      `[Global avatar](${GLOBAL_AVATAR_URL})`,
    );
    expect(harness.recordCommandMetric).toHaveBeenCalledWith("utility.avatar");
  });

  it("shows only ordinary member metadata in a private user-info reply", async () => {
    const harness = createHarness("userinfo");

    await handleUtilityCommand(harness.interaction, harness.runtime);

    expectPrivateReply(harness.reply);
    const embed = getEmbedJson(harness.reply);
    const fields = Object.fromEntries(
      (embed.fields ?? []).map((field) => [field.name, field.value]),
    );
    expect(fields["Display name"]).toBe("Server Display Name");
    expect(fields.Username).toBe("member\\_name");
    expect(fields["User ID"]).toBe(`\`${USER_ID}\``);
    expect(fields.Roles).toBe("`2`");
    expect(fields["Account created"]).toBe(
      `<t:${Math.floor(CREATED_AT / 1_000)}:F> (<t:${Math.floor(CREATED_AT / 1_000)}:R>)`,
    );
    expect(fields["Joined server"]).toBe(
      `<t:${Math.floor(JOINED_AT / 1_000)}:F> (<t:${Math.floor(JOINED_AT / 1_000)}:R>)`,
    );
    expect(embed.thumbnail?.url).toBe(SERVER_AVATAR_URL);
    expect(JSON.stringify(embed).toLowerCase()).not.toMatch(
      /permission|timeout|presence|private role/,
    );
    expect(harness.recordCommandMetric).toHaveBeenCalledWith(
      "utility.userinfo",
    );
  });

  it("shows non-sensitive server metadata without resolving or mentioning the owner", async () => {
    const harness = createHarness("serverinfo");

    await handleUtilityCommand(harness.interaction, harness.runtime);

    expectPrivateReply(harness.reply);
    const embed = getEmbedJson(harness.reply);
    const fields = Object.fromEntries(
      (embed.fields ?? []).map((field) => [field.name, field.value]),
    );
    expect(embed.description).toBe("Example \\*Server\\*");
    expect(fields).toMatchObject({
      "Server ID": `\`${GUILD_ID}\``,
      Members: "`42`",
      Channels: "`3`",
      Roles: "`2`",
      Boosts: "`7` (Tier 2)",
    });
    expect(embed.thumbnail?.url).toBe(SERVER_ICON_URL);
    expect(JSON.stringify(embed)).not.toContain(OWNER_ID);
    expect(harness.membersFetch).not.toHaveBeenCalled();
    expect(harness.recordCommandMetric).toHaveBeenCalledWith(
      "utility.serverinfo",
    );
  });

  it("cancels after a member fetch invalidates the guild runtime", async () => {
    const harness = createHarness("userinfo");
    harness.membersFetch.mockImplementationOnce(async () => {
      harness.setCurrent(false);
      return harness.member;
    });

    await handleUtilityCommand(harness.interaction, harness.runtime);

    expectPrivateReply(harness.reply);
    expect(getReplyPayload(harness.reply).content).toContain(
      "Action cancelled",
    );
    expect(harness.recordCommandMetric).not.toHaveBeenCalled();
  });

  it("rejects a runtime from another guild without fetching member data", async () => {
    const harness = createHarness("avatar", {
      runtimeGuildId: "999999999999999999",
    });

    await handleUtilityCommand(harness.interaction, harness.runtime);

    expectPrivateReply(harness.reply);
    expect(getReplyPayload(harness.reply).content).toBe(
      "This utility request does not belong to this server.",
    );
    expect(harness.membersFetch).not.toHaveBeenCalled();
    expect(harness.recordCommandMetric).not.toHaveBeenCalled();
  });

  it("does not record a metric when the interaction reply fails", async () => {
    const harness = createHarness("ping");
    harness.reply.mockRejectedValueOnce(new Error("reply failed"));

    await expect(
      handleUtilityCommand(harness.interaction, harness.runtime),
    ).rejects.toThrow("reply failed");

    expect(harness.recordCommandMetric).not.toHaveBeenCalled();
  });
});
